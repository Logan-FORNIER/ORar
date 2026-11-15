use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Instant;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use pbkdf2::pbkdf2_hmac;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::{
    atomic_replace_file, collect_input_items_with_filtering, entry_basename,
    entry_matches_selection, finalize_entries, hex_decode, hex_encode, normalize_archive_path,
    safe_join, ArchiveEntry, ArchiveInfo, ArchiveMutationRequest, IntegrityReport, RepairReport,
};

const ORAR_MAGIC: &[u8; 4] = b"ORAR";
const ORAR_VERSION: u16 = 1;
const ORAR_HEADER_LEN: usize = 34;
const MAX_INDEX_SIZE: u64 = 128 * 1024 * 1024;
const ENC_INDEX_PREFIX: &[u8] = b"ORAR-ENC-IDX:";
const PBKDF2_ITERATIONS: u32 = 100_000;

/// Binary file table entry serialized inside the `.orar` compressed index.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrarIndexEntry {
    pub path: String,
    pub is_dir: bool,
    pub offset: u64,
    pub size: u64,
    pub compressed_size: u64,
    pub method: String,
    pub crc32: u32,
    pub modified: Option<String>,
    #[serde(default)]
    pub encrypted: bool,
    #[serde(default)]
    pub nonce_hex: Option<String>,
    #[serde(default)]
    pub deduplicated: bool,
}

/// JSON index structure stored at `index_offset` in `.orar` archives.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrarArchiveHeader {
    pub format_version: u16,
    pub created_at: String,
    pub comment: Option<String>,
    pub sha256_manifest: String,
    #[serde(default)]
    pub encrypted: bool,
    #[serde(default)]
    pub salt_hex: Option<String>,
    pub entries: Vec<OrarIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedIndexEnvelope {
    encrypted_index: bool,
    salt_hex: String,
    nonce_hex: String,
    ciphertext_base64: String,
}

struct BinaryHeader {
    index_offset: u64,
    index_compressed_size: u64,
    index_uncompressed_size: u64,
    index_crc32: u32,
}

fn generate_random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    OsRng.fill_bytes(&mut buf);
    buf
}

fn derive_aes_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
    key
}

fn encrypt_with_key(key: &[u8; 32], plaintext: &[u8]) -> Result<(Vec<u8>, String), String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("Erreur d'initialisation AES-256-GCM : {e}"))?;
    let nonce_bytes = generate_random_bytes::<12>();
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|e| format!("Erreur de chiffrement AES-256 : {e}"))?;
    Ok((ciphertext, hex_encode(&nonce_bytes)))
}

fn decrypt_with_key(key: &[u8; 32], nonce_hex: &str, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let nonce_bytes = hex_decode(nonce_hex)?;
    if nonce_bytes.len() != 12 {
        return Err("Nonce AES-256 invalide dans l'archive .orar.".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("Erreur d'initialisation AES-256-GCM : {e}"))?;
    cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext)
        .map_err(|_| "PASSWORD_REQUIRED:Mot de passe incorrect ou données chiffrées altérées.".into())
}

fn clean_password(password: Option<&str>) -> Option<&str> {
    password.map(|p| p.trim()).filter(|p| !p.is_empty())
}

fn read_binary_header(file: &mut File) -> Result<BinaryHeader, String> {
    let file_len = file
        .metadata()
        .map_err(|e| format!("Impossible de lire les métadonnées de l'archive : {e}"))?
        .len();
    if file_len < ORAR_HEADER_LEN as u64 {
        return Err("Fichier .orar invalide ou tronqué (en-tête incomplet).".into());
    }

    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("Erreur de lecture de l'en-tête : {e}"))?;
    let mut buf = [0u8; ORAR_HEADER_LEN];
    file.read_exact(&mut buf)
        .map_err(|e| format!("Impossible de lire l'en-tête .orar : {e}"))?;

    if &buf[0..4] != ORAR_MAGIC {
        return Err("Signature invalide : ce fichier n'est pas une archive .orar valide.".into());
    }

    let version = u16::from_le_bytes([buf[4], buf[5]]);
    if version != ORAR_VERSION {
        return Err(format!("Version .orar non prise en charge : v{version}."));
    }

    let index_offset = u64::from_le_bytes(buf[6..14].try_into().unwrap());
    let index_compressed_size = u64::from_le_bytes(buf[14..22].try_into().unwrap());
    let index_uncompressed_size = u64::from_le_bytes(buf[22..30].try_into().unwrap());
    let index_crc32 = u32::from_le_bytes(buf[30..34].try_into().unwrap());

    if index_offset < ORAR_HEADER_LEN as u64
        || index_compressed_size > MAX_INDEX_SIZE
        || index_uncompressed_size > MAX_INDEX_SIZE
        || index_offset.saturating_add(index_compressed_size) > file_len
    {
        return Err("Table d'index .orar corrompue ou hors limites.".into());
    }

    Ok(BinaryHeader {
        index_offset,
        index_compressed_size,
        index_uncompressed_size,
        index_crc32,
    })
}

fn read_orar_header(file: &mut File, password: Option<&str>) -> Result<(OrarArchiveHeader, bool), String> {
    let bin = read_binary_header(file)?;
    file.seek(SeekFrom::Start(bin.index_offset))
        .map_err(|e| format!("Impossible d'atteindre l'index .orar : {e}"))?;

    let mut index_blob = vec![0u8; bin.index_compressed_size as usize];
    file.read_exact(&mut index_blob)
        .map_err(|e| format!("Impossible de lire l'index .orar : {e}"))?;

    let (compressed_json, index_was_encrypted) = if index_blob.starts_with(ENC_INDEX_PREFIX) {
        if crc32fast::hash(&index_blob) != bin.index_crc32 {
            return Err("Erreur d'intégrité (CRC32) sur l'enveloppe d'index .orar.".into());
        }
        let env: EncryptedIndexEnvelope = serde_json::from_slice(&index_blob[ENC_INDEX_PREFIX.len()..])
            .map_err(|e| format!("Enveloppe d'index chiffrée invalide : {e}"))?;
        let pw = clean_password(password).ok_or_else(|| {
            "PASSWORD_REQUIRED:Cette archive .orar a ses noms de fichiers chiffrés (AES-256).".to_string()
        })?;
        let salt = hex_decode(&env.salt_hex)?;
        let key = derive_aes_key(pw, &salt);
        let ciphertext = base64::engine::general_purpose::STANDARD
            .decode(&env.ciphertext_base64)
            .map_err(|e| format!("Base64 d'index chiffré invalide : {e}"))?;
        let decrypted = decrypt_with_key(&key, &env.nonce_hex, &ciphertext)?;
        (decrypted, env.encrypted_index)
    } else {
        (index_blob, false)
    };

    let mut decoder = ZlibDecoder::new(&compressed_json[..]);
    let mut json_bytes = Vec::with_capacity(bin.index_uncompressed_size as usize);
    decoder
        .read_to_end(&mut json_bytes)
        .map_err(|e| format!("Échec de décompression de l'index .orar : {e}"))?;

    if !index_was_encrypted && crc32fast::hash(&json_bytes) != bin.index_crc32 {
        return Err("Erreur d'intégrité (CRC32) dans la table d'index .orar.".into());
    }

    let header = serde_json::from_slice::<OrarArchiveHeader>(&json_bytes)
        .map_err(|e| format!("Index .orar corrompu (JSON invalide) : {e}"))?;

    Ok((header, index_was_encrypted))
}

fn compute_sha256_manifest(entries: &[OrarIndexEntry]) -> String {
    let mut hasher = Sha256::new();
    for entry in entries {
        let line = format!("{}:{:08x}:{}\n", entry.path, entry.crc32, entry.size);
        hasher.update(line.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

fn write_orar_index_and_header(
    file: &mut File,
    index_offset: u64,
    header: &OrarArchiveHeader,
    key_and_salt: Option<(&[u8; 32], &str)>,
    encrypt_filenames: bool,
) -> Result<(), String> {
    let json_bytes = serde_json::to_vec(header)
        .map_err(|e| format!("Erreur de sérialisation de l'index .orar : {e}"))?;
    let json_uncompressed_size = json_bytes.len() as u64;
    let json_crc32 = crc32fast::hash(&json_bytes);

    let mut idx_encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    idx_encoder
        .write_all(&json_bytes)
        .map_err(|e| format!("Erreur de compression de l'index .orar : {e}"))?;
    let compressed_index = idx_encoder
        .finish()
        .map_err(|e| format!("Erreur de finalisation de l'index .orar : {e}"))?;

    let (final_index_blob, header_uncompressed_size, header_crc32) =
        if encrypt_filenames {
            if let Some((key, salt_hex)) = key_and_salt {
                let (ciphertext, nonce_hex) = encrypt_with_key(key, &compressed_index)?;
                let envelope = EncryptedIndexEnvelope {
                    encrypted_index: true,
                    salt_hex: salt_hex.to_string(),
                    nonce_hex,
                    ciphertext_base64: base64::engine::general_purpose::STANDARD.encode(&ciphertext),
                };
                let mut blob = ENC_INDEX_PREFIX.to_vec();
                let env_json = serde_json::to_vec(&envelope)
                    .map_err(|e| format!("Erreur sérialisation enveloppe index : {e}"))?;
                blob.extend_from_slice(&env_json);
                let blob_len = blob.len() as u64;
                let blob_crc = crc32fast::hash(&blob);
                (blob, blob_len, blob_crc)
            } else {
                (compressed_index, json_uncompressed_size, json_crc32)
            }
        } else {
            (compressed_index, json_uncompressed_size, json_crc32)
        };

    let index_compressed_size = final_index_blob.len() as u64;
    file.seek(SeekFrom::Start(index_offset))
        .map_err(|e| format!("Impossible d'écrire l'index .orar : {e}"))?;
    file.write_all(&final_index_blob)
        .map_err(|e| format!("Impossible d'écrire la table d'index .orar : {e}"))?;

    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("Impossible de revenir à l'en-tête .orar : {e}"))?;
    let mut bin_header = [0u8; ORAR_HEADER_LEN];
    bin_header[0..4].copy_from_slice(ORAR_MAGIC);
    bin_header[4..6].copy_from_slice(&ORAR_VERSION.to_le_bytes());
    bin_header[6..14].copy_from_slice(&index_offset.to_le_bytes());
    bin_header[14..22].copy_from_slice(&index_compressed_size.to_le_bytes());
    bin_header[22..30].copy_from_slice(&header_uncompressed_size.to_le_bytes());
    bin_header[30..34].copy_from_slice(&header_crc32.to_le_bytes());

    file.write_all(&bin_header)
        .map_err(|e| format!("Erreur d'écriture de l'en-tête final .orar : {e}"))?;
    file.flush()
        .map_err(|e| format!("Erreur de synchronisation disque : {e}"))?;
    Ok(())
}

fn prepare_entry_key(header: &OrarArchiveHeader, password: Option<&str>) -> Result<Option<[u8; 32]>, String> {
    if !header.encrypted {
        return Ok(None);
    }
    let pw = clean_password(password).ok_or_else(|| {
        "PASSWORD_REQUIRED:Cette archive .orar est protégée par mot de passe (AES-256).".to_string()
    })?;
    let salt_hex = header
        .salt_hex
        .as_deref()
        .ok_or_else(|| "Sel cryptographique manquant dans l'archive .orar.".to_string())?;
    let salt = hex_decode(salt_hex)?;
    Ok(Some(derive_aes_key(pw, &salt)))
}

fn decode_orar_entry_payload(
    file: &mut File,
    entry: &OrarIndexEntry,
    derived_key: Option<&[u8; 32]>,
) -> Result<Vec<u8>, String> {
    if entry.is_dir {
        return Ok(Vec::new());
    }

    file.seek(SeekFrom::Start(entry.offset))
        .map_err(|e| format!("Impossible d'accéder aux données de {} : {e}", entry.path))?;
    let mut raw_payload = vec![0u8; entry.compressed_size as usize];
    file.read_exact(&mut raw_payload)
        .map_err(|e| format!("Erreur de lecture des données de {} : {e}", entry.path))?;

    let compressed_payload = if entry.encrypted {
        let key = derived_key.ok_or_else(|| {
            "PASSWORD_REQUIRED:Ce fichier est protégé par mot de passe (AES-256).".to_string()
        })?;
        let nonce_hex = entry
            .nonce_hex
            .as_deref()
            .ok_or_else(|| format!("Nonce AES-256 manquant pour {}", entry.path))?;
        decrypt_with_key(key, nonce_hex, &raw_payload)?
    } else {
        raw_payload
    };

    let data = if entry.method == "store" {
        compressed_payload
    } else if entry.method.starts_with("deflate") {
        let mut decoder = ZlibDecoder::new(&compressed_payload[..]);
        let mut out = Vec::with_capacity(entry.size as usize);
        decoder
            .read_to_end(&mut out)
            .map_err(|e| format!("Erreur de décompression sur {} : {e}", entry.path))?;
        out
    } else {
        return Err(format!(
            "Méthode de compression inconnue ({}) pour {}",
            entry.method, entry.path
        ));
    };

    if crc32fast::hash(&data) != entry.crc32 {
        return Err(format!(
            "Échec CRC32 sur {} : fichier corrompu dans l'archive.",
            entry.path
        ));
    }

    Ok(data)
}

fn encode_and_write_bytes(
    out_file: &mut File,
    archive_path: &str,
    raw: &[u8],
    modified: Option<String>,
    level: u8,
    current_offset: &mut u64,
    derived_key: Option<&[u8; 32]>,
) -> Result<OrarIndexEntry, String> {
    let orig_size = raw.len() as u64;
    let crc32 = crc32fast::hash(raw);

    let (compressed_bytes, method) = if level == 0 || raw.is_empty() {
        (raw.to_vec(), "store".to_string())
    } else {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(level as u32));
        encoder
            .write_all(raw)
            .map_err(|e| format!("Erreur de compression sur {archive_path} : {e}"))?;
        let compressed = encoder
            .finish()
            .map_err(|e| format!("Erreur de finalisation deflate sur {archive_path} : {e}"))?;

        if compressed.len() < raw.len() {
            (compressed, format!("deflate-{level}"))
        } else {
            (raw.to_vec(), "store".to_string())
        }
    };

    let (stored_bytes, encrypted, nonce_hex) = if let Some(key) = derived_key {
        let (cipher, nonce) = encrypt_with_key(key, &compressed_bytes)?;
        (cipher, true, Some(nonce))
    } else {
        (compressed_bytes, false, None)
    };

    let compressed_size = stored_bytes.len() as u64;
    out_file
        .write_all(&stored_bytes)
        .map_err(|e| format!("Erreur d'écriture des données de {archive_path} : {e}"))?;

    let entry = OrarIndexEntry {
        path: archive_path.to_string(),
        is_dir: false,
        offset: *current_offset,
        size: orig_size,
        compressed_size,
        method,
        crc32,
        modified,
        encrypted,
        nonce_hex,
        deduplicated: false,
    };

    *current_offset = current_offset.saturating_add(compressed_size);
    Ok(entry)
}

fn encode_and_write_file(
    out_file: &mut File,
    archive_path: &str,
    fs_path: &Path,
    modified: Option<String>,
    level: u8,
    current_offset: &mut u64,
    derived_key: Option<&[u8; 32]>,
) -> Result<OrarIndexEntry, String> {
    let raw = fs::read(fs_path)
        .map_err(|e| format!("Impossible de lire {} : {e}", fs_path.display()))?;
    encode_and_write_bytes(
        out_file,
        archive_path,
        &raw,
        modified,
        level,
        current_offset,
        derived_key,
    )
}

fn build_archive_info(archive_path: &Path, archive_file_size: u64, header: &OrarArchiveHeader) -> ArchiveInfo {
    let raw_entries: Vec<ArchiveEntry> = header
        .entries
        .iter()
        .map(|e| ArchiveEntry {
            path: e.path.clone(),
            name: entry_basename(&e.path),
            is_dir: e.is_dir,
            size: e.size,
            compressed_size: e.compressed_size,
            compression_method: e.method.clone(),
            crc32: if e.is_dir { None } else { Some(e.crc32) },
            modified: e.modified.clone(),
            encrypted: e.encrypted,
            deduplicated: e.deduplicated,
        })
        .collect();

    let (entries, total_uncompressed_size, _, file_count, dir_count) =
        finalize_entries(raw_entries);

    let mut seen_offsets = HashSet::new();
    let mut physical_compressed_size = 0u64;
    let mut deduplicated_files = 0usize;
    let mut deduplicated_saved_bytes = 0u64;
    for e in &header.entries {
        if e.is_dir {
            continue;
        }
        if e.deduplicated {
            deduplicated_files += 1;
            deduplicated_saved_bytes = deduplicated_saved_bytes.saturating_add(e.size);
        }
        if seen_offsets.insert(e.offset) {
            physical_compressed_size = physical_compressed_size.saturating_add(e.compressed_size);
        }
    }

    let file_name = archive_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "archive.orar".to_string());

    ArchiveInfo {
        archive_path: archive_path.to_string_lossy().to_string(),
        file_name,
        format: "ORAR".into(),
        archive_file_size,
        total_uncompressed_size,
        total_compressed_size: physical_compressed_size,
        file_count,
        dir_count,
        comment: header.comment.clone(),
        sha256_manifest: Some(header.sha256_manifest.clone()),
        can_extract: true,
        can_create_format: true,
        is_encrypted: header.encrypted || header.entries.iter().any(|e| e.encrypted),
        can_mutate: true,
        deduplicated_files,
        deduplicated_saved_bytes,
        entries,
    }
}

/// Create a `.orar` binary archive with deduplication, Smart Dev exclusions, optional AES-256-GCM encryption, and SHA-256 manifest.
pub fn create_orar_archive<F>(
    source_paths: &[String],
    output_path: &Path,
    level: u8,
    comment: Option<String>,
    password: Option<&str>,
    encrypt_filenames: bool,
    smart_dev_ignore: bool,
    exclude_patterns: &[String],
    mut progress_cb: F,
) -> Result<ArchiveInfo, String>
where
    F: FnMut(&str, usize, usize),
{
    let items = collect_input_items_with_filtering(
        source_paths,
        "",
        smart_dev_ignore,
        exclude_patterns,
    )?;
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer le dossier de destination : {e}"))?;
        }
    }

    let mut file = File::create(output_path)
        .map_err(|e| format!("Impossible de créer le fichier {} : {e}", output_path.display()))?;

    file.write_all(&[0u8; ORAR_HEADER_LEN])
        .map_err(|e| format!("Erreur d'initialisation de l'en-tête .orar : {e}"))?;

    let encryption_setup = clean_password(password).map(|pw| {
        let salt = generate_random_bytes::<16>();
        let key = derive_aes_key(pw, &salt);
        (key, hex_encode(&salt))
    });

    let clamped_level = level.min(9);
    let total = items.len();
    let mut current_offset = ORAR_HEADER_LEN as u64;
    let mut index_entries = Vec::with_capacity(total);
    let mut dedup_map: HashMap<(u64, u32, [u8; 32]), (u64, u64, String, bool, Option<String>)> =
        HashMap::new();

    for (idx, item) in items.iter().enumerate() {
        progress_cb(&item.archive_path, idx + 1, total);

        if item.is_dir {
            index_entries.push(OrarIndexEntry {
                path: item.archive_path.clone(),
                is_dir: true,
                offset: 0,
                size: 0,
                compressed_size: 0,
                method: "dir".into(),
                crc32: 0,
                modified: item.modified.clone(),
                encrypted: false,
                nonce_hex: None,
                deduplicated: false,
            });
            continue;
        }

        let raw = fs::read(&item.fs_path)
            .map_err(|e| format!("Impossible de lire {} : {e}", item.fs_path.display()))?;
        let key_ref = encryption_setup.as_ref().map(|(k, _)| k);

        if !raw.is_empty() {
            let orig_size = raw.len() as u64;
            let crc32 = crc32fast::hash(&raw);
            let sha: [u8; 32] = Sha256::digest(&raw).into();
            let dedup_key = (orig_size, crc32, sha);

            if let Some((offset, compressed_size, method, encrypted, nonce_hex)) =
                dedup_map.get(&dedup_key)
            {
                index_entries.push(OrarIndexEntry {
                    path: item.archive_path.clone(),
                    is_dir: false,
                    offset: *offset,
                    size: orig_size,
                    compressed_size: *compressed_size,
                    method: method.clone(),
                    crc32,
                    modified: item.modified.clone(),
                    encrypted: *encrypted,
                    nonce_hex: nonce_hex.clone(),
                    deduplicated: true,
                });
                continue;
            }

            let entry = encode_and_write_bytes(
                &mut file,
                &item.archive_path,
                &raw,
                item.modified.clone(),
                clamped_level,
                &mut current_offset,
                key_ref,
            )?;
            dedup_map.insert(
                dedup_key,
                (
                    entry.offset,
                    entry.compressed_size,
                    entry.method.clone(),
                    entry.encrypted,
                    entry.nonce_hex.clone(),
                ),
            );
            index_entries.push(entry);
        } else {
            let entry = encode_and_write_bytes(
                &mut file,
                &item.archive_path,
                &raw,
                item.modified.clone(),
                clamped_level,
                &mut current_offset,
                key_ref,
            )?;
            index_entries.push(entry);
        }
    }

    let clean_comment = comment
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());

    let sha256_manifest = compute_sha256_manifest(&index_entries);
    let header = OrarArchiveHeader {
        format_version: ORAR_VERSION,
        created_at: chrono::Local::now().to_rfc3339(),
        comment: clean_comment,
        sha256_manifest,
        encrypted: encryption_setup.is_some(),
        salt_hex: encryption_setup.as_ref().map(|(_, s)| s.clone()),
        entries: index_entries,
    };

    let key_and_salt = encryption_setup
        .as_ref()
        .map(|(k, s)| (k, s.as_str()));
    write_orar_index_and_header(&mut file, current_offset, &header, key_and_salt, encrypt_filenames)?;

    let archive_file_size = fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);
    Ok(build_archive_info(output_path, archive_file_size, &header))
}

/// Inspect a `.orar` archive in O(1) seek time by reading only its header and compressed index.
pub fn inspect_orar_archive(archive_path: &Path, password: Option<&str>) -> Result<ArchiveInfo, String> {
    let mut file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let archive_file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let (header, _) = read_orar_header(&mut file, password)?;
    Ok(build_archive_info(archive_path, archive_file_size, &header))
}

/// Extract all or selected entries from a `.orar` archive while verifying CRC32 checksums and decrypting if required.
pub fn extract_orar_archive<F>(
    archive_path: &Path,
    dest_dir: &Path,
    selected_entries: &Option<Vec<String>>,
    password: Option<&str>,
    mut progress_cb: F,
) -> Result<usize, String>
where
    F: FnMut(&str, usize, usize),
{
    let mut file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let (header, _) = read_orar_header(&mut file, password)?;
    let needs_key = header.entries.iter().any(|e| e.encrypted && entry_matches_selection(&e.path, selected_entries));
    let derived_key = if needs_key {
        prepare_entry_key(&header, password)?
    } else {
        None
    };

    fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Impossible de créer le dossier d'extraction : {e}"))?;

    let targets: Vec<&OrarIndexEntry> = header
        .entries
        .iter()
        .filter(|e| entry_matches_selection(&e.path, selected_entries))
        .collect();

    let total = targets.len();
    let mut extracted_files = 0usize;

    for (idx, entry) in targets.iter().enumerate() {
        progress_cb(&entry.path, idx + 1, total);
        let out_path = safe_join(dest_dir, &entry.path)?;

        if entry.is_dir {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Impossible de créer le dossier {} : {e}", out_path.display()))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer le dossier parent {} : {e}", parent.display()))?;
        }

        let data = decode_orar_entry_payload(&mut file, entry, derived_key.as_ref())?;
        fs::write(&out_path, &data)
            .map_err(|e| format!("Impossible d'écrire {} : {e}", out_path.display()))?;
        extracted_files += 1;
    }

    Ok(extracted_files)
}

/// Read up to `max_bytes` of a single `.orar` entry for live preview without full extraction.
pub fn read_orar_entry_bytes(
    archive_path: &Path,
    entry_path: &str,
    max_bytes: usize,
    password: Option<&str>,
) -> Result<(Vec<u8>, u64), String> {
    let mut file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let (header, _) = read_orar_header(&mut file, password)?;

    let target = normalize_archive_path(entry_path);
    let entry = header
        .entries
        .iter()
        .find(|e| !e.is_dir && normalize_archive_path(&e.path) == target)
        .ok_or_else(|| format!("Entrée introuvable dans l'archive .orar : {entry_path}"))?;

    let derived_key = if entry.encrypted {
        prepare_entry_key(&header, password)?
    } else {
        None
    };

    let mut data = decode_orar_entry_payload(&mut file, entry, derived_key.as_ref())?;
    let original_size = entry.size;
    if data.len() > max_bytes {
        data.truncate(max_bytes);
    }
    Ok((data, original_size))
}

/// Verify index CRC32, SHA-256 manifest, and every stored payload CRC32 in a `.orar` archive.
pub fn verify_orar_archive<F>(
    archive_path: &Path,
    password: Option<&str>,
    mut progress_cb: F,
) -> Result<IntegrityReport, String>
where
    F: FnMut(&str, usize, usize),
{
    let start = Instant::now();
    let mut file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let (header, _) = read_orar_header(&mut file, password)?;

    let derived_key = if header.encrypted {
        prepare_entry_key(&header, password)?
    } else {
        None
    };

    let expected_manifest = compute_sha256_manifest(&header.entries);
    let manifest_ok = expected_manifest == header.sha256_manifest;

    let file_entries: Vec<&OrarIndexEntry> = header.entries.iter().filter(|e| !e.is_dir).collect();
    let total = file_entries.len();
    let mut failed_files = Vec::new();

    for (idx, entry) in file_entries.iter().enumerate() {
        progress_cb(&entry.path, idx + 1, total);
        if let Err(err) = decode_orar_entry_payload(&mut file, entry, derived_key.as_ref()) {
            if err.starts_with("PASSWORD_REQUIRED:") {
                return Err(err);
            }
            failed_files.push(format!("{} ({err})", entry.path));
        }
    }

    let valid = manifest_ok && failed_files.is_empty();
    let duration_ms = start.elapsed().as_millis() as u64;
    let message = if valid {
        format!(
            "Archive .orar saine : {} fichier(s) vérifié(s) (CRC32 + manifeste SHA-256 validés).",
            file_entries.len()
        )
    } else if !manifest_ok {
        "Le manifeste SHA-256 global ne correspond pas au contenu de l'archive.".into()
    } else {
        format!("{} fichier(s) ont échoué au contrôle CRC32.", failed_files.len())
    };

    Ok(IntegrityReport {
        archive_path: archive_path.to_string_lossy().to_string(),
        format: "ORAR".into(),
        valid,
        checked_files: file_entries.len(),
        failed_files,
        manifest_verified: Some(manifest_ok),
        sha256_manifest: Some(header.sha256_manifest),
        duration_ms,
        message,
    })
}

/// Mutate an existing `.orar` archive in place (`add`, `delete`, `rename`, `mkdir`, `write_text`, `set_comment`) while preserving unmodified payloads directly.
pub fn mutate_orar_archive(
    archive_path: &Path,
    req: &ArchiveMutationRequest,
) -> Result<ArchiveInfo, String> {
    let pw_opt = req.password.as_deref();
    let mut src_file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let (mut header, index_was_encrypted) = read_orar_header(&mut src_file, pw_opt)?;

    let derived_key = if header.encrypted {
        prepare_entry_key(&header, pw_opt)?
    } else {
        None
    };

    let mut new_entries: Vec<OrarIndexEntry> = Vec::new();
    let mut additions: Vec<crate::types::CollectedInput> = Vec::new();
    let mut text_writes: Vec<(String, Vec<u8>)> = Vec::new();
    let mut overwrite_paths: HashSet<String> = HashSet::new();

    match req.action.as_str() {
        "add" => {
            let sources = req
                .source_paths
                .as_ref()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "Aucun fichier ou dossier à ajouter.".to_string())?;
            let prefix = req.target_dir.as_deref().unwrap_or("");
            additions = collect_input_items_with_filtering(sources, prefix, false, &[])?;
            for item in &additions {
                overwrite_paths.insert(item.archive_path.clone());
            }
            for entry in header.entries.drain(..) {
                if !overwrite_paths.contains(&entry.path) {
                    new_entries.push(entry);
                }
            }
        }
        "delete" => {
            let paths = req
                .paths
                .as_ref()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "Aucune entrée sélectionnée pour la suppression.".to_string())?;
            let selection = Some(paths.clone());
            for entry in header.entries.drain(..) {
                if !entry_matches_selection(&entry.path, &selection) {
                    new_entries.push(entry);
                }
            }
        }
        "rename" => {
            let old_norm = normalize_archive_path(
                req.old_path
                    .as_deref()
                    .ok_or_else(|| "Chemin source manquant pour le renommage.".to_string())?,
            );
            let new_norm = normalize_archive_path(
                req.new_path
                    .as_deref()
                    .ok_or_else(|| "Nouveau chemin manquant pour le renommage.".to_string())?,
            );
            if old_norm.is_empty() || new_norm.is_empty() || new_norm.contains("..") {
                return Err("Nom cible invalide pour le renommage.".into());
            }
            if old_norm == new_norm {
                return inspect_orar_archive(archive_path, pw_opt);
            }
            let prefix = format!("{old_norm}/");
            for mut entry in header.entries.drain(..) {
                if entry.path == old_norm {
                    entry.path = new_norm.clone();
                } else if entry.path.starts_with(&prefix) {
                    entry.path = format!("{new_norm}/{}", &entry.path[prefix.len()..]);
                }
                new_entries.push(entry);
            }
        }
        "mkdir" => {
            let dir_norm = normalize_archive_path(
                req.dir_path
                    .as_deref()
                    .ok_or_else(|| "Nom du dossier manquant.".to_string())?,
            );
            if dir_norm.is_empty() || dir_norm.contains("..") {
                return Err("Nom de dossier invalide.".into());
            }
            let exists = header.entries.iter().any(|e| e.path == dir_norm);
            new_entries.extend(header.entries.drain(..));
            if !exists {
                new_entries.push(OrarIndexEntry {
                    path: dir_norm,
                    is_dir: true,
                    offset: 0,
                    size: 0,
                    compressed_size: 0,
                    method: "dir".into(),
                    crc32: 0,
                    modified: Some(chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()),
                    encrypted: false,
                    nonce_hex: None,
                    deduplicated: false,
                });
            }
        }
        "write_text" => {
            let new_norm = normalize_archive_path(
                req.new_path
                    .as_deref()
                    .ok_or_else(|| "Chemin cible manquant pour l'écriture texte.".to_string())?,
            );
            if new_norm.is_empty() || new_norm.contains("..") {
                return Err("Chemin cible invalide pour l'écriture texte.".into());
            }
            let text = req.text_content.as_deref().unwrap_or("");
            overwrite_paths.insert(new_norm.clone());
            for entry in header.entries.drain(..) {
                if !overwrite_paths.contains(&entry.path) {
                    new_entries.push(entry);
                }
            }
            text_writes.push((new_norm, text.as_bytes().to_vec()));
        }
        "set_comment" => {
            header.comment = req
                .comment
                .as_deref()
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty());
            new_entries.extend(header.entries.drain(..));
        }
        other => return Err(format!("Action d'édition non reconnue : {other}")),
    }

    let temp_path = archive_path.with_extension("orar.mut.tmp");
    let mut out_file = File::create(&temp_path)
        .map_err(|e| format!("Impossible de créer le fichier temporaire : {e}"))?;
    out_file
        .write_all(&[0u8; ORAR_HEADER_LEN])
        .map_err(|e| format!("Erreur initialisation temporaire : {e}"))?;

    let mut current_offset = ORAR_HEADER_LEN as u64;
    let mut copied_offsets: HashMap<u64, u64> = HashMap::new();

    // Copy preserved physical blocks directly once, updating offsets (preserving deduplication).
    for entry in &mut new_entries {
        if entry.is_dir {
            continue;
        }
        let old_offset = entry.offset;
        if let Some(&mapped_offset) = copied_offsets.get(&old_offset) {
            entry.offset = mapped_offset;
            entry.deduplicated = true;
            continue;
        }
        src_file
            .seek(SeekFrom::Start(old_offset))
            .map_err(|e| format!("Erreur accès bloc {} : {e}", entry.path))?;
        let mut buf = vec![0u8; entry.compressed_size as usize];
        src_file
            .read_exact(&mut buf)
            .map_err(|e| format!("Erreur copie bloc {} : {e}", entry.path))?;
        out_file
            .write_all(&buf)
            .map_err(|e| format!("Erreur écriture bloc {} : {e}", entry.path))?;
        copied_offsets.insert(old_offset, current_offset);
        entry.offset = current_offset;
        entry.deduplicated = false;
        current_offset = current_offset.saturating_add(entry.compressed_size);
    }

    // Encode and append newly added items.
    for item in additions {
        if item.is_dir {
            new_entries.push(OrarIndexEntry {
                path: item.archive_path,
                is_dir: true,
                offset: 0,
                size: 0,
                compressed_size: 0,
                method: "dir".into(),
                crc32: 0,
                modified: item.modified,
                encrypted: false,
                nonce_hex: None,
                deduplicated: false,
            });
            continue;
        }
        let added = encode_and_write_file(
            &mut out_file,
            &item.archive_path,
            &item.fs_path,
            item.modified,
            6,
            &mut current_offset,
            derived_key.as_ref(),
        )?;
        new_entries.push(added);
    }

    // Encode and append in-place edited text files.
    let now_str = Some(chrono::Local::now().format("%Y-%m-%d %H:%M").to_string());
    for (target_path, raw_bytes) in text_writes {
        let written = encode_and_write_bytes(
            &mut out_file,
            &target_path,
            &raw_bytes,
            now_str.clone(),
            6,
            &mut current_offset,
            derived_key.as_ref(),
        )?;
        new_entries.push(written);
    }

    header.sha256_manifest = compute_sha256_manifest(&new_entries);
    header.entries = new_entries;

    let key_and_salt = match (derived_key.as_ref(), header.salt_hex.as_deref()) {
        (Some(k), Some(s)) => Some((k, s)),
        _ => None,
    };
    write_orar_index_and_header(
        &mut out_file,
        current_offset,
        &header,
        key_and_salt,
        index_was_encrypted,
    )?;

    drop(out_file);
    drop(src_file);
    atomic_replace_file(&temp_path, archive_path)?;
    inspect_orar_archive(archive_path, pw_opt)
}

/// Recover all healthy entries from a damaged `.orar` archive into a clean repaired file.
pub fn repair_orar_archive(
    archive_path: &Path,
    output_path: &Path,
    password: Option<&str>,
) -> Result<RepairReport, String> {
    let mut src_file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let (header, index_was_encrypted) = read_orar_header(&mut src_file, password)?;
    let derived_key = if header.encrypted {
        prepare_entry_key(&header, password)?
    } else {
        None
    };

    let mut out_file = File::create(output_path)
        .map_err(|e| format!("Impossible de créer {} : {e}", output_path.display()))?;
    out_file
        .write_all(&[0u8; ORAR_HEADER_LEN])
        .map_err(|e| format!("Erreur d'initialisation du fichier réparé : {e}"))?;

    let mut current_offset = ORAR_HEADER_LEN as u64;
    let mut recovered_entries = Vec::new();
    let mut recovered_files = 0usize;
    let mut damaged_files = Vec::new();
    let mut copied_offsets: HashMap<u64, u64> = HashMap::new();

    for entry in &header.entries {
        if entry.is_dir {
            recovered_entries.push(entry.clone());
            continue;
        }
        if let Some(&mapped_offset) = copied_offsets.get(&entry.offset) {
            let mut fixed = entry.clone();
            fixed.offset = mapped_offset;
            fixed.deduplicated = true;
            recovered_entries.push(fixed);
            recovered_files += 1;
            continue;
        }
        match decode_orar_entry_payload(&mut src_file, entry, derived_key.as_ref()) {
            Ok(_) => {
                // Re-copy intact raw compressed/encrypted payload at updated offset.
                if src_file.seek(SeekFrom::Start(entry.offset)).is_ok() {
                    let mut buf = vec![0u8; entry.compressed_size as usize];
                    if src_file.read_exact(&mut buf).is_ok() && out_file.write_all(&buf).is_ok() {
                        let mut fixed = entry.clone();
                        copied_offsets.insert(entry.offset, current_offset);
                        fixed.offset = current_offset;
                        fixed.deduplicated = false;
                        current_offset = current_offset.saturating_add(fixed.compressed_size);
                        recovered_entries.push(fixed);
                        recovered_files += 1;
                        continue;
                    }
                }
                damaged_files.push(entry.path.clone());
            }
            Err(err) => {
                if err.starts_with("PASSWORD_REQUIRED:") {
                    return Err(err);
                }
                damaged_files.push(entry.path.clone());
            }
        }
    }

    let repaired_header = OrarArchiveHeader {
        format_version: ORAR_VERSION,
        created_at: chrono::Local::now().to_rfc3339(),
        comment: header.comment.clone(),
        sha256_manifest: compute_sha256_manifest(&recovered_entries),
        encrypted: header.encrypted,
        salt_hex: header.salt_hex.clone(),
        entries: recovered_entries,
    };

    let key_and_salt = match (derived_key.as_ref(), repaired_header.salt_hex.as_deref()) {
        (Some(k), Some(s)) => Some((k, s)),
        _ => None,
    };
    write_orar_index_and_header(
        &mut out_file,
        current_offset,
        &repaired_header,
        key_and_salt,
        index_was_encrypted,
    )?;

    let message = if damaged_files.is_empty() {
        format!("Réparation réussie : tous les {recovered_files} fichier(s) sont intacts et reconstruits.")
    } else {
        format!(
            "{recovered_files} fichier(s) récupéré(s), {} bloc(s) endommagé(s) ignoré(s).",
            damaged_files.len()
        )
    };

    Ok(RepairReport {
        source_path: archive_path.to_string_lossy().to_string(),
        output_path: output_path.to_string_lossy().to_string(),
        format: "ORAR".into(),
        recovered_files,
        damaged_files,
        message,
    })
}
