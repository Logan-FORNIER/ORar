use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[cfg(windows)]
use crate::archive::CREATE_NO_WINDOW;
use crate::archive::{
    create_archive, extract_archive, inspect_archive, read_archive_entry_bytes,
};
use crate::types::{
    entry_basename, hex_encode, normalize_archive_path, ArchiveDiffItem, ArchiveDiffReport,
    ArchiveEntry, ArchiveInfo, BatchOperationReport, BatchOperationRequest, BenchmarkResult,
    ContentSearchMatch, ConvertArchiveRequest, CreateArchiveRequest, EntryHashes,
    ExtractArchiveRequest, SfxReport, SplitReport, StegoCreateRequest, StegoReport,
    WindowsIntegrationStatus,
};

const MAX_HASH_BYTES: usize = 512 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEARCH_HITS: usize = 500;
const MIN_SPLIT_VOLUME_BYTES: u64 = 64 * 1024;

fn is_likely_binary_extension(path: &str) -> bool {
    let lower = path.to_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".mp3", ".mp4", ".mkv", ".avi",
        ".mov", ".wav", ".flac", ".pdf", ".exe", ".dll", ".so", ".bin", ".zip", ".7z", ".rar",
        ".orar", ".gz", ".zst", ".xz", ".woff", ".woff2", ".ttf", ".otf",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
}

/// Compute CRC32, MD5, SHA-1, and SHA-256 digests for a single archive entry.
pub fn compute_entry_hashes(
    archive_path: &Path,
    entry_path: &str,
    password: Option<&str>,
) -> Result<EntryHashes, String> {
    let norm = normalize_archive_path(entry_path);
    let (bytes, total_size) =
        read_archive_entry_bytes(archive_path, &norm, MAX_HASH_BYTES, password)?;
    if total_size as usize > MAX_HASH_BYTES {
        return Err("Fichier trop volumineux (> 512 Mo) pour le calcul d'empreintes en mémoire.".into());
    }

    let crc32_val = crc32fast::hash(&bytes);
    let md5_hex = hex_encode(&Md5::digest(&bytes));
    let sha1_hex = hex_encode(&Sha1::digest(&bytes));
    let sha256_hex = hex_encode(&Sha256::digest(&bytes));

    Ok(EntryHashes {
        path: norm,
        size: total_size,
        crc32_hex: format!("{crc32_val:08X}"),
        md5_hex,
        sha1_hex,
        sha256_hex,
    })
}

/// Search for text matches inside all UTF-8 files of an archive without extracting to disk.
pub fn search_in_archive_contents<F>(
    archive_path: &Path,
    query: &str,
    case_sensitive: bool,
    password: Option<&str>,
    mut progress_cb: F,
) -> Result<Vec<ContentSearchMatch>, String>
where
    F: FnMut(&str, usize, usize),
{
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let info = inspect_archive(archive_path, password)?;
    let candidates: Vec<_> = info
        .entries
        .iter()
        .filter(|e| !e.is_dir && e.size > 0 && e.size <= MAX_SEARCH_FILE_BYTES && !is_likely_binary_extension(&e.path))
        .collect();

    let needle = if case_sensitive {
        trimmed.to_string()
    } else {
        trimmed.to_lowercase()
    };

    let total = candidates.len();
    let mut matches = Vec::new();

    for (idx, entry) in candidates.iter().enumerate() {
        progress_cb(&entry.path, idx + 1, total);
        let Ok((bytes, _)) =
            read_archive_entry_bytes(archive_path, &entry.path, MAX_SEARCH_FILE_BYTES as usize, password)
        else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };

        let mut file_hits = 0usize;
        for (line_idx, line) in text.lines().enumerate() {
            let found = if case_sensitive {
                line.contains(&needle)
            } else {
                line.to_lowercase().contains(&needle)
            };
            if found {
                file_hits += 1;
                let preview: String = line.trim().chars().take(180).collect();
                matches.push(ContentSearchMatch {
                    path: entry.path.clone(),
                    line_number: line_idx + 1,
                    line_preview: preview,
                    match_count: file_hits,
                });
                if matches.len() >= MAX_SEARCH_HITS {
                    return Ok(matches);
                }
            }
        }
    }

    Ok(matches)
}

/// Extract one archive file into a temporary directory and open it with the default Windows app.
pub fn open_entry_externally(
    archive_path: &Path,
    entry_path: &str,
    password: Option<&str>,
) -> Result<String, String> {
    let norm = normalize_archive_path(entry_path);
    let safe_name = entry_basename(&norm)
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .collect::<String>();
    if safe_name.is_empty() {
        return Err("Nom de fichier invalide pour l'ouverture externe.".into());
    }

    let (bytes, _) = read_archive_entry_bytes(archive_path, &norm, MAX_HASH_BYTES, password)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let temp_dir = std::env::temp_dir().join(format!("orar_open_{stamp}"));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Impossible de créer le dossier temporaire : {e}"))?;

    let target_file = temp_dir.join(&safe_name);
    fs::write(&target_file, &bytes)
        .map_err(|e| format!("Impossible d'écrire le fichier temporaire : {e}"))?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .args(["/C", "start", "", &target_file.to_string_lossy()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Impossible d'ouvrir le fichier dans Windows : {e}"))?;
    }

    #[cfg(not(windows))]
    {
        let _ = &target_file;
    }

    Ok(target_file.to_string_lossy().to_string())
}

/// Highlight an archive or extracted file inside Windows Explorer.
pub fn reveal_in_explorer(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Chemin introuvable : {}", path.display()));
    }
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| format!("Impossible d'ouvrir l'Explorateur Windows : {e}"))?;
    }
    Ok(())
}

/// Convert any readable archive into another supported format cleanly via a temporary staging folder.
pub fn convert_archive_format<F>(
    req: &ConvertArchiveRequest,
    mut progress_cb: F,
) -> Result<ArchiveInfo, String>
where
    F: FnMut(&str, usize, usize),
{
    let temp = TempDir::new()
        .map_err(|e| format!("Impossible de créer l'espace de conversion temporaire : {e}"))?;

    extract_archive(
        &ExtractArchiveRequest {
            archive_path: req.source_archive_path.clone(),
            destination_dir: temp.path().to_string_lossy().to_string(),
            selected_entries: None,
            password: req.source_password.clone(),
        },
        |file, processed, total| progress_cb(file, processed, total.max(1) * 2),
    )?;

    let mut staged_sources = Vec::new();
    let entries = fs::read_dir(temp.path())
        .map_err(|e| format!("Erreur lecture dossier temporaire : {e}"))?;
    for entry_res in entries {
        if let Ok(entry) = entry_res {
            staged_sources.push(entry.path().to_string_lossy().to_string());
        }
    }
    if staged_sources.is_empty() {
        return Err("L'archive source est vide, impossible de convertir.".into());
    }

    create_archive(
        &CreateArchiveRequest {
            source_paths: staged_sources,
            output_path: req.output_path.clone(),
            format: req.target_format.clone(),
            compression_level: req.compression_level,
            comment: req.comment.clone(),
            password: req.target_password.clone(),
            encrypt_filenames: req.encrypt_filenames,
            split_size_bytes: None,
            smart_dev_ignore: false,
            exclude_patterns: vec![],
        },
        |file, processed, total| {
            let t = total.max(1);
            progress_cb(file, t + processed, t * 2);
        },
    )
}

/// Split any file/archive into sequential `.part001`, `.part002`, ... volume files.
pub fn split_archive(archive_path: &Path, volume_size_bytes: u64) -> Result<SplitReport, String> {
    if !archive_path.exists() {
        return Err(format!("Fichier introuvable : {}", archive_path.display()));
    }
    if volume_size_bytes < MIN_SPLIT_VOLUME_BYTES {
        return Err("La taille minimale d'un volume est de 64 Ko.".into());
    }

    let mut file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let total_size = file.metadata().map(|m| m.len()).unwrap_or(0);
    if total_size == 0 {
        return Err("Le fichier source est vide.".into());
    }

    let mut hasher = Sha256::new();
    let mut parts = Vec::new();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut part_index = 1usize;

    loop {
        let part_path = PathBuf::from(format!("{}.part{:03}", archive_path.display(), part_index));
        let mut written_in_part = 0u64;
        let mut part_file: Option<File> = None;

        while written_in_part < volume_size_bytes {
            let to_read = ((volume_size_bytes - written_in_part) as usize).min(buffer.len());
            let n = file
                .read(&mut buffer[..to_read])
                .map_err(|e| format!("Erreur lecture lors du découpage : {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
            let pf = match part_file {
                Some(ref mut f) => f,
                None => {
                    let f = File::create(&part_path)
                        .map_err(|e| format!("Impossible de créer {} : {e}", part_path.display()))?;
                    part_file = Some(f);
                    part_file.as_mut().unwrap()
                }
            };
            pf.write_all(&buffer[..n])
                .map_err(|e| format!("Erreur écriture volume {} : {e}", part_path.display()))?;
            written_in_part += n as u64;
        }

        if part_file.is_some() {
            parts.push(part_path.to_string_lossy().to_string());
            part_index += 1;
        } else {
            break;
        }
    }

    let sha256 = hex_encode(&hasher.finalize());
    Ok(SplitReport {
        source_path: archive_path.to_string_lossy().to_string(),
        parts,
        total_size,
        part_size: volume_size_bytes,
        sha256,
    })
}

/// Reassemble sequential `.part001`, `.part002`, ... volumes back into a single archive file.
pub fn join_split_archive(first_part_path: &Path, output_path: Option<&Path>) -> Result<String, String> {
    let raw = first_part_path.to_string_lossy();
    let base = strip_part_suffix(&raw).ok_or_else(|| {
        "Sélectionnez un fichier se terminant par .part001 (ou .partNNN).".to_string()
    })?;

    let target_path = match output_path {
        Some(p) => p.to_path_buf(),
        None => PathBuf::from(base),
    };

    let mut out_file = File::create(&target_path)
        .map_err(|e| format!("Impossible de créer {} : {e}", target_path.display()))?;

    let mut idx = 1usize;
    let mut found_any = false;
    loop {
        let part_path = PathBuf::from(format!("{base}.part{idx:03}"));
        if !part_path.exists() {
            break;
        }
        found_any = true;
        let mut part_file = File::open(&part_path)
            .map_err(|e| format!("Impossible d'ouvrir le volume {} : {e}", part_path.display()))?;
        io::copy(&mut part_file, &mut out_file)
            .map_err(|e| format!("Erreur d'assemblage sur {} : {e}", part_path.display()))?;
        idx += 1;
    }

    if !found_any {
        return Err(format!("Aucun volume séquentiel .part001 trouvé pour {base}."));
    }

    out_file
        .flush()
        .map_err(|e| format!("Erreur de synchronisation disque : {e}"))?;
    Ok(target_path.to_string_lossy().to_string())
}

fn strip_part_suffix(path_str: &str) -> Option<&str> {
    let idx = path_str.rfind(".part")?;
    let digits = &path_str[idx + 5..];
    if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
        Some(&path_str[..idx])
    } else {
        None
    }
}

/// Measure compression/decompression throughput (MB/s) and ratio across ORar and ZIP engines.
pub fn run_compression_benchmark() -> Result<Vec<BenchmarkResult>, String> {
    // Build a deterministic 4 MiB realistic mixed corpus (source/JSON + binary patterns).
    let mut corpus = Vec::with_capacity(4 * 1024 * 1024);
    let sample_text = b"{\"app\":\"ORar\",\"engine\":\"deflate\",\"status\":\"ok\",\"features\":[\"AES-256-GCM\",\"O(1)-index\",\"CRC32\",\"SHA-256\"]}\n";
    while corpus.len() < 3 * 1024 * 1024 {
        corpus.extend_from_slice(sample_text);
    }
    let mut x = 0x1234_5678u32;
    while corpus.len() < 4 * 1024 * 1024 {
        x = x.wrapping_mul(1664525).wrapping_add(1013904223);
        corpus.push((x >> 24) as u8);
    }

    let input_size = corpus.len() as u64;
    let mut results = Vec::with_capacity(5);

    for (label, level) in [
        ("ORAR Store (0)", 0u32),
        ("ORAR Rapide (1)", 1u32),
        ("ORAR Normale (6)", 6u32),
        ("ORAR Ultra (9)", 9u32),
    ] {
        let comp_start = Instant::now();
        let compressed = if level == 0 {
            corpus.clone()
        } else {
            let mut enc = ZlibEncoder::new(Vec::new(), Compression::new(level));
            enc.write_all(&corpus)
                .map_err(|e| format!("Erreur benchmark compression : {e}"))?;
            enc.finish()
                .map_err(|e| format!("Erreur benchmark finalisation : {e}"))?
        };
        let comp_secs = comp_start.elapsed().as_secs_f64().max(0.0001);

        let dec_start = Instant::now();
        let mut decompressed = Vec::with_capacity(corpus.len());
        if level == 0 {
            decompressed.extend_from_slice(&compressed);
        } else {
            let mut dec = ZlibDecoder::new(&compressed[..]);
            dec.read_to_end(&mut decompressed)
                .map_err(|e| format!("Erreur benchmark décompression : {e}"))?;
        }
        let dec_secs = dec_start.elapsed().as_secs_f64().max(0.0001);

        let comp_size = compressed.len() as u64;
        let mb = input_size as f64 / (1024.0 * 1024.0);
        results.push(BenchmarkResult {
            engine: "ORAR".into(),
            level_label: label.into(),
            input_size,
            compressed_size: comp_size,
            ratio_percent: ((1.0 - (comp_size as f64 / input_size as f64)) * 100.0),
            compress_mb_s: mb / comp_secs,
            decompress_mb_s: mb / dec_secs,
            compress_ms: (comp_secs * 1000.0) as u64,
            decompress_ms: (dec_secs * 1000.0) as u64,
        });
    }

    // ZIP Deflate (6) comparison in memory
    let zip_comp_start = Instant::now();
    let mut zip_buf = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut zip_buf);
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(6));
        writer
            .start_file("corpus.dat", opts)
            .map_err(|e| format!("Erreur benchmark ZIP : {e}"))?;
        writer
            .write_all(&corpus)
            .map_err(|e| format!("Erreur benchmark écriture ZIP : {e}"))?;
        writer
            .finish()
            .map_err(|e| format!("Erreur benchmark finalisation ZIP : {e}"))?;
    }
    let zip_bytes = zip_buf.into_inner();
    let zip_comp_secs = zip_comp_start.elapsed().as_secs_f64().max(0.0001);

    let zip_dec_start = Instant::now();
    {
        let mut reader = ZipArchive::new(Cursor::new(&zip_bytes))
            .map_err(|e| format!("Erreur benchmark lecture ZIP : {e}"))?;
        let mut entry = reader
            .by_index(0)
            .map_err(|e| format!("Erreur benchmark entrée ZIP : {e}"))?;
        let mut out = Vec::with_capacity(corpus.len());
        entry
            .read_to_end(&mut out)
            .map_err(|e| format!("Erreur benchmark extraction ZIP : {e}"))?;
    }
    let zip_dec_secs = zip_dec_start.elapsed().as_secs_f64().max(0.0001);

    let zip_size = zip_bytes.len() as u64;
    let mb = input_size as f64 / (1024.0 * 1024.0);
    results.push(BenchmarkResult {
        engine: "ZIP".into(),
        level_label: "ZIP Deflate (6)".into(),
        input_size,
        compressed_size: zip_size,
        ratio_percent: ((1.0 - (zip_size as f64 / input_size as f64)) * 100.0),
        compress_mb_s: mb / zip_comp_secs,
        decompress_mb_s: mb / zip_dec_secs,
        compress_ms: (zip_comp_secs * 1000.0) as u64,
        decompress_ms: (zip_dec_secs * 1000.0) as u64,
    });

    Ok(results)
}

#[cfg(windows)]
fn run_reg_command(args: &[&str]) -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    let output = Command::new("reg.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Impossible d'exécuter reg.exe : {e}"))?;
    Ok(output.status.success())
}

/// Inspect current per-user Windows registry integration (HKCU, no admin needed).
pub fn get_windows_integration_status() -> WindowsIntegrationStatus {
    let exe_path = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    #[cfg(windows)]
    {
        let orar_associated =
            run_reg_command(&["query", r"HKCU\Software\Classes\.orar"]).unwrap_or(false);
        let context_menu_enabled =
            run_reg_command(&["query", r"HKCU\Software\Classes\*\shell\ORarOpen"]).unwrap_or(false);
        WindowsIntegrationStatus {
            orar_associated,
            context_menu_enabled,
            exe_path,
        }
    }

    #[cfg(not(windows))]
    WindowsIntegrationStatus {
        orar_associated: false,
        context_menu_enabled: false,
        exe_path,
    }
}

/// Enable or remove `.orar` file association and Windows right-click "Ouvrir avec ORar" in HKCU.
pub fn set_windows_integration(
    associate_orar: bool,
    context_menu: bool,
) -> Result<WindowsIntegrationStatus, String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Impossible de localiser l'exécutable ORar : {e}"))?;
        let exe_str = exe.to_string_lossy().to_string();
        let open_cmd = format!("\"{exe_str}\" \"%1\"");

        if associate_orar {
            run_reg_command(&["add", r"HKCU\Software\Classes\.orar", "/ve", "/d", "ORar.Archive", "/f"])?;
            run_reg_command(&["add", r"HKCU\Software\Classes\ORar.Archive", "/ve", "/d", "Archive ORar", "/f"])?;
            run_reg_command(&[
                "add",
                r"HKCU\Software\Classes\ORar.Archive\DefaultIcon",
                "/ve",
                "/d",
                &format!("\"{exe_str}\",0"),
                "/f",
            ])?;
            run_reg_command(&[
                "add",
                r"HKCU\Software\Classes\ORar.Archive\shell\open\command",
                "/ve",
                "/d",
                &open_cmd,
                "/f",
            ])?;
        } else {
            let _ = run_reg_command(&["delete", r"HKCU\Software\Classes\.orar", "/f"]);
            let _ = run_reg_command(&["delete", r"HKCU\Software\Classes\ORar.Archive", "/f"]);
        }

        if context_menu {
            run_reg_command(&[
                "add",
                r"HKCU\Software\Classes\*\shell\ORarOpen",
                "/ve",
                "/d",
                "Ouvrir avec ORar",
                "/f",
            ])?;
            run_reg_command(&[
                "add",
                r"HKCU\Software\Classes\*\shell\ORarOpen",
                "/v",
                "Icon",
                "/d",
                &format!("\"{exe_str}\",0"),
                "/f",
            ])?;
            run_reg_command(&[
                "add",
                r"HKCU\Software\Classes\*\shell\ORarOpen\command",
                "/ve",
                "/d",
                &open_cmd,
                "/f",
            ])?;
        } else {
            let _ = run_reg_command(&["delete", r"HKCU\Software\Classes\*\shell\ORarOpen", "/f"]);
        }
    }

    Ok(get_windows_integration_status())
}

/// Return the first existing file path passed via CLI arguments (e.g. from Windows Explorer double-click).
pub fn get_launch_args() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && Path::new(arg).is_file())
}

// ============================================================================
// Archive Diff, Batch Studio, Stego-ORar & Self-Extracting Bundle (SFX)
// ============================================================================

const STEGO_MAGIC: &[u8; 8] = b"ORARSTEG";
const STEGO_TRAILER_LEN: usize = 28;
const MAX_DIFF_FALLBACK_HASH_BYTES: u64 = 16 * 1024 * 1024;

fn resolve_entry_crc(
    archive_path: &Path,
    entry: &ArchiveEntry,
    password: Option<&str>,
) -> Option<u32> {
    if entry.crc32.is_some() {
        return entry.crc32;
    }
    if entry.size > MAX_DIFF_FALLBACK_HASH_BYTES {
        return None;
    }
    read_archive_entry_bytes(archive_path, &entry.path, MAX_DIFF_FALLBACK_HASH_BYTES as usize, password)
        .ok()
        .map(|(bytes, _)| crc32fast::hash(&bytes))
}

fn diff_rank(status: &str) -> u8 {
    match status {
        "modified" => 0,
        "added" => 1,
        "removed" => 2,
        _ => 3,
    }
}

/// Compare two archives by normalized file path, size, and CRC32 without extracting to disk.
pub fn compare_archives(
    left_path: &Path,
    right_path: &Path,
    left_password: Option<&str>,
    right_password: Option<&str>,
) -> Result<ArchiveDiffReport, String> {
    let left = inspect_archive(left_path, left_password)?;
    let right = inspect_archive(right_path, right_password)?;

    let left_map: HashMap<String, ArchiveEntry> = left
        .entries
        .into_iter()
        .filter(|e| !e.is_dir)
        .map(|e| (normalize_archive_path(&e.path), e))
        .collect();

    let right_map: HashMap<String, ArchiveEntry> = right
        .entries
        .into_iter()
        .filter(|e| !e.is_dir)
        .map(|e| (normalize_archive_path(&e.path), e))
        .collect();

    let mut all_paths = BTreeSet::new();
    for p in left_map.keys() {
        all_paths.insert(p.clone());
    }
    for p in right_map.keys() {
        all_paths.insert(p.clone());
    }

    let mut added_count = 0usize;
    let mut removed_count = 0usize;
    let mut modified_count = 0usize;
    let mut unchanged_count = 0usize;
    let mut total_size_delta = 0i64;
    let mut items = Vec::with_capacity(all_paths.len());

    for path in all_paths {
        match (left_map.get(&path), right_map.get(&path)) {
            (None, Some(r)) => {
                added_count += 1;
                let delta = r.size as i64;
                total_size_delta = total_size_delta.saturating_add(delta);
                items.push(ArchiveDiffItem {
                    path,
                    status: "added".into(),
                    left_size: None,
                    right_size: Some(r.size),
                    size_delta: delta,
                    left_crc32: None,
                    right_crc32: r.crc32,
                });
            }
            (Some(l), None) => {
                removed_count += 1;
                let delta = -(l.size as i64);
                total_size_delta = total_size_delta.saturating_add(delta);
                items.push(ArchiveDiffItem {
                    path,
                    status: "removed".into(),
                    left_size: Some(l.size),
                    right_size: None,
                    size_delta: delta,
                    left_crc32: l.crc32,
                    right_crc32: None,
                });
            }
            (Some(l), Some(r)) => {
                let delta = (r.size as i128 - l.size as i128).clamp(i64::MIN as i128, i64::MAX as i128) as i64;
                total_size_delta = total_size_delta.saturating_add(delta);

                let (l_crc, r_crc, is_modified) = if l.size != r.size {
                    (l.crc32, r.crc32, true)
                } else {
                    let lc = resolve_entry_crc(left_path, l, left_password);
                    let rc = resolve_entry_crc(right_path, r, right_password);
                    let changed = match (lc, rc) {
                        (Some(a), Some(b)) => a != b,
                        _ => false,
                    };
                    (lc, rc, changed)
                };

                let status = if is_modified {
                    modified_count += 1;
                    "modified"
                } else {
                    unchanged_count += 1;
                    "unchanged"
                };

                items.push(ArchiveDiffItem {
                    path,
                    status: status.into(),
                    left_size: Some(l.size),
                    right_size: Some(r.size),
                    size_delta: delta,
                    left_crc32: l_crc,
                    right_crc32: r_crc,
                });
            }
            (None, None) => {}
        }
    }

    items.sort_by(|a, b| {
        diff_rank(&a.status)
            .cmp(&diff_rank(&b.status))
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });

    Ok(ArchiveDiffReport {
        left_path: left_path.to_string_lossy().to_string(),
        right_path: right_path.to_string_lossy().to_string(),
        added_count,
        removed_count,
        modified_count,
        unchanged_count,
        total_size_delta,
        items,
    })
}

fn archive_stem_for_folder(path: &Path) -> String {
    let raw_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "archive".into());
    let lower = raw_name.to_lowercase();
    for compound in [".tar.gz", ".tar.zst", ".tar.xz"] {
        if lower.ends_with(compound) {
            return raw_name[..raw_name.len() - compound.len()].to_string();
        }
    }
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(raw_name)
}

/// Extract multiple archives or compress multiple items independently in a single batch run.
pub fn run_batch_operation<F>(
    req: &BatchOperationRequest,
    mut progress_cb: F,
) -> Result<BatchOperationReport, String>
where
    F: FnMut(&str, usize, usize),
{
    if req.source_paths.is_empty() {
        return Err("Aucune source sélectionnée pour l'opération par lots.".into());
    }
    if req.destination_dir.trim().is_empty() {
        return Err("Veuillez choisir un dossier de destination.".into());
    }

    let dest_root = PathBuf::from(req.destination_dir.trim());
    fs::create_dir_all(&dest_root)
        .map_err(|e| format!("Impossible de créer le dossier de destination : {e}"))?;

    let total = req.source_paths.len();
    let mut succeeded = Vec::new();
    let mut failed = Vec::new();
    let clean_ext = req.format.trim().trim_start_matches('.').to_lowercase();
    let ext = if clean_ext.is_empty() { "orar" } else { clean_ext.as_str() };

    for (idx, raw_src) in req.source_paths.iter().enumerate() {
        let src_path = PathBuf::from(raw_src);
        let label = src_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| raw_src.clone());
        progress_cb(&label, idx + 1, total);

        match req.mode.as_str() {
            "extract_each" => {
                let stem = archive_stem_for_folder(&src_path);
                let target_dir = dest_root.join(&stem);
                match extract_archive(
                    &ExtractArchiveRequest {
                        archive_path: raw_src.clone(),
                        destination_dir: target_dir.to_string_lossy().to_string(),
                        selected_entries: None,
                        password: req.password.clone(),
                    },
                    |_, _, _| {},
                ) {
                    Ok(_) => succeeded.push(target_dir.to_string_lossy().to_string()),
                    Err(err) => failed.push(format!("{label} : {err}")),
                }
            }
            "compress_each" => {
                let stem = if src_path.is_dir() {
                    label.clone()
                } else {
                    src_path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| label.clone())
                };
                let mut out_path = dest_root.join(format!("{stem}.{ext}"));
                if out_path.exists() && succeeded.iter().any(|s| Path::new(s) == out_path) {
                    out_path = dest_root.join(format!("{stem}_{}.{ext}", idx + 1));
                }
                match create_archive(
                    &CreateArchiveRequest {
                        source_paths: vec![raw_src.clone()],
                        output_path: out_path.to_string_lossy().to_string(),
                        format: ext.to_string(),
                        compression_level: req.compression_level,
                        comment: Some(format!("Lot ORar — {stem}")),
                        password: req.password.clone(),
                        encrypt_filenames: false,
                        split_size_bytes: None,
                        smart_dev_ignore: req.smart_dev_ignore,
                        exclude_patterns: vec![],
                    },
                    |_, _, _| {},
                ) {
                    Ok(info) => succeeded.push(info.archive_path),
                    Err(err) => failed.push(format!("{label} : {err}")),
                }
            }
            other => {
                return Err(format!("Mode batch non reconnu : {other}"));
            }
        }
    }

    let message = format!(
        "Lot terminé : {}/{} réussi(s){}.",
        succeeded.len(),
        total,
        if failed.is_empty() {
            String::new()
        } else {
            format!(", {} échec(s)", failed.len())
        }
    );

    Ok(BatchOperationReport {
        mode: req.mode.clone(),
        processed_count: total,
        succeeded,
        failed,
        message,
    })
}

fn write_png_chunk(out: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(chunk_type);
    out.extend_from_slice(data);
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(chunk_type);
    hasher.update(data);
    out.extend_from_slice(&hasher.finalize().to_be_bytes());
}

fn build_default_cover_png() -> Result<Vec<u8>, String> {
    const W: usize = 256;
    const H: usize = 256;

    let mut raw_scanlines = Vec::with_capacity(H * (1 + W * 4));
    let cx = 128.0f32;
    let cy = 128.0f32;

    for y in 0..H {
        raw_scanlines.push(0u8); // Filter type 0 (None)
        for x in 0..W {
            let fx = x as f32;
            let fy = y as f32;
            let dx = fx - cx;
            let dy = fy - cy;
            let dist = (dx * dx + dy * dy).sqrt();

            // Subtle slate-indigo radial backdrop with amber ORar border and central emblem
            let border = x < 8 || x >= W - 8 || y < 8 || y >= H - 8;
            let inner_frame = (x == 16 || x == W - 17 || y == 16 || y == H - 17)
                && (16..=(W - 17)).contains(&x)
                && (16..=(H - 17)).contains(&y);

            let (r, g, b) = if border {
                (245u8, 158u8, 11u8)
            } else if inner_frame {
                (99u8, 102u8, 241u8)
            } else if (44.0..=64.0).contains(&dist) {
                (251u8, 191u8, 36u8)
            } else if (64.0..=72.0).contains(&dist) || (38.0..=44.0).contains(&dist) {
                (15u8, 23u8, 42u8)
            } else {
                let t = (fx + fy) / ((W + H) as f32);
                let rr = (15.0 + t * 22.0) as u8;
                let gg = (23.0 + t * 14.0) as u8;
                let bb = (42.0 + t * 44.0) as u8;
                (rr, gg, bb)
            };

            raw_scanlines.push(r);
            raw_scanlines.push(g);
            raw_scanlines.push(b);
            raw_scanlines.push(255u8);
        }
    }

    let mut zlib = ZlibEncoder::new(Vec::new(), Compression::default());
    zlib.write_all(&raw_scanlines)
        .map_err(|e| format!("Erreur compression image PNG porteuse : {e}"))?;
    let idat = zlib
        .finish()
        .map_err(|e| format!("Erreur finalisation image PNG porteuse : {e}"))?;

    let mut png = Vec::with_capacity(idat.len() + 128);
    png.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(W as u32).to_be_bytes());
    ihdr.extend_from_slice(&(H as u32).to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // RGBA
    ihdr.push(0); // compression
    ihdr.push(0); // filter
    ihdr.push(0); // interlace
    write_png_chunk(&mut png, b"IHDR", &ihdr);
    write_png_chunk(&mut png, b"IDAT", &idat);
    write_png_chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

/// Conceal a `.orar` or standard archive inside a valid PNG container with a 28-byte `ORARSTEG` footer.
pub fn create_stego_archive(req: &StegoCreateRequest) -> Result<StegoReport, String> {
    let src_path = Path::new(&req.source_archive_path);
    if !src_path.exists() {
        return Err(format!("Archive source introuvable : {}", src_path.display()));
    }
    let payload = fs::read(src_path)
        .map_err(|e| format!("Impossible de lire l'archive source : {e}"))?;
    if payload.is_empty() {
        return Err("L'archive source est vide.".into());
    }

    let mut cover_bytes = match req.cover_png_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(cover_str) => {
            let p = Path::new(cover_str);
            if !p.exists() {
                return Err(format!("Image PNG porteuse introuvable : {cover_str}"));
            }
            let mut raw = fs::read(p)
                .map_err(|e| format!("Impossible de lire l'image PNG porteuse : {e}"))?;
            if raw.len() < 8 || &raw[..8] != b"\x89PNG\r\n\x1a\n" {
                return Err("Le fichier porteur sélectionné n'est pas une image PNG valide.".into());
            }
            // Strip prior ORARSTEG trailer if re-wrapping an existing stego PNG.
            if raw.len() >= STEGO_TRAILER_LEN && &raw[raw.len() - 8..] == STEGO_MAGIC {
                let tstart = raw.len() - STEGO_TRAILER_LEN;
                let prev_offset = u64::from_le_bytes(raw[tstart..tstart + 8].try_into().unwrap());
                if prev_offset <= raw.len() as u64 {
                    raw.truncate(prev_offset as usize);
                }
            }
            raw
        }
        None => build_default_cover_png()?,
    };

    let cover_size = cover_bytes.len() as u64;
    let payload_size = payload.len() as u64;
    let payload_crc = crc32fast::hash(&payload);

    cover_bytes.extend_from_slice(&payload);
    cover_bytes.extend_from_slice(&cover_size.to_le_bytes());
    cover_bytes.extend_from_slice(&payload_size.to_le_bytes());
    cover_bytes.extend_from_slice(&payload_crc.to_le_bytes());
    cover_bytes.extend_from_slice(STEGO_MAGIC);

    let out_path = Path::new(&req.output_png_path);
    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer le dossier de sortie : {e}"))?;
        }
    }
    fs::write(out_path, &cover_bytes)
        .map_err(|e| format!("Impossible d'écrire l'image Stego-ORar : {e}"))?;

    let total_size = cover_bytes.len() as u64;
    Ok(StegoReport {
        stego_png_path: out_path.to_string_lossy().to_string(),
        extracted_archive_path: None,
        cover_size,
        payload_size,
        total_size,
        message: format!(
            "Archive dissimulée dans l'image PNG ({} octets cachés sur {}).",
            payload_size, total_size
        ),
    })
}

/// Extract a concealed archive from a `ORARSTEG` PNG container and inspect it.
pub fn extract_stego_archive(
    stego_png_path: &Path,
    output_orar_path: Option<&Path>,
    password: Option<&str>,
) -> Result<(StegoReport, ArchiveInfo), String> {
    if !stego_png_path.exists() {
        return Err(format!("Image PNG introuvable : {}", stego_png_path.display()));
    }
    let bytes = fs::read(stego_png_path)
        .map_err(|e| format!("Impossible de lire l'image PNG : {e}"))?;
    if bytes.len() < STEGO_TRAILER_LEN || &bytes[bytes.len() - 8..] != STEGO_MAGIC {
        return Err("Aucune archive ORar cachée (signature ORARSTEG) détectée dans cette image.".into());
    }

    let tstart = bytes.len() - STEGO_TRAILER_LEN;
    let payload_offset = u64::from_le_bytes(bytes[tstart..tstart + 8].try_into().unwrap());
    let payload_size = u64::from_le_bytes(bytes[tstart + 8..tstart + 16].try_into().unwrap());
    let expected_crc = u32::from_le_bytes(bytes[tstart + 16..tstart + 20].try_into().unwrap());

    if payload_offset.checked_add(payload_size) != Some(tstart as u64) || payload_size == 0 {
        return Err("Métadonnées stéganographiques ORARSTEG corrompues ou hors limites.".into());
    }

    let payload = &bytes[payload_offset as usize..tstart];
    if crc32fast::hash(payload) != expected_crc {
        return Err("Contrôle CRC32 échoué sur les données cachées ORARSTEG.".into());
    }

    let detected_ext = if payload.starts_with(b"ORAR") {
        "orar"
    } else if payload.starts_with(b"PK\x03\x04") {
        "zip"
    } else if payload.starts_with(b"7z\xBC\xAF\x27\x1C") {
        "7z"
    } else {
        "orar"
    };

    let out_path = match output_orar_path {
        Some(p) => p.to_path_buf(),
        None => {
            let stem = stego_png_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "archive".into());
            let parent = stego_png_path.parent().unwrap_or_else(|| Path::new("."));
            parent.join(format!("{stem}_secret.{detected_ext}"))
        }
    };

    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer le dossier de sortie : {e}"))?;
        }
    }
    fs::write(&out_path, payload)
        .map_err(|e| format!("Impossible d'écrire l'archive extraite : {e}"))?;

    let info = inspect_archive(&out_path, password)?;
    let report = StegoReport {
        stego_png_path: stego_png_path.to_string_lossy().to_string(),
        extracted_archive_path: Some(out_path.to_string_lossy().to_string()),
        cover_size: payload_offset,
        payload_size,
        total_size: bytes.len() as u64,
        message: format!(
            "Archive cachée récupérée ({} fichier(s)) vers {}",
            info.file_count,
            out_path.display()
        ),
    };
    Ok((report, info))
}

/// Generate a standalone Windows `.cmd` self-extracting bundle usable on any Windows 10/11 PC without ORar installed.
pub fn create_sfx_bundle(
    archive_path: &Path,
    output_sfx_path: Option<&Path>,
    password: Option<&str>,
) -> Result<SfxReport, String> {
    if !archive_path.exists() {
        return Err(format!("Archive introuvable : {}", archive_path.display()));
    }

    let stem = archive_stem_for_folder(archive_path);
    let safe_folder_stem: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ' ' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string();
    let folder_label = if safe_folder_stem.is_empty() {
        "ORar_Archive".to_string()
    } else {
        safe_folder_stem
    };

    let zip_bytes = if archive_path
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
    {
        fs::read(archive_path)
            .map_err(|e| format!("Impossible de lire l'archive ZIP : {e}"))?
    } else {
        let temp = TempDir::new()
            .map_err(|e| format!("Impossible de créer l'espace SFX temporaire : {e}"))?;
        let stage_extract = temp.path().join("extracted");
        extract_archive(
            &ExtractArchiveRequest {
                archive_path: archive_path.to_string_lossy().to_string(),
                destination_dir: stage_extract.to_string_lossy().to_string(),
                selected_entries: None,
                password: password.map(|s| s.to_string()),
            },
            |_, _, _| {},
        )?;

        let mut sources = Vec::new();
        for entry_res in fs::read_dir(&stage_extract)
            .map_err(|e| format!("Erreur lecture extraction SFX : {e}"))?
        {
            if let Ok(entry) = entry_res {
                sources.push(entry.path().to_string_lossy().to_string());
            }
        }
        if sources.is_empty() {
            return Err("L'archive est vide, impossible de créer un paquet SFX.".into());
        }

        let temp_zip = temp.path().join("payload.zip");
        create_archive(
            &CreateArchiveRequest {
                source_paths: sources,
                output_path: temp_zip.to_string_lossy().to_string(),
                format: "zip".into(),
                compression_level: 9,
                comment: Some(format!("ORar Auto-Extractible SFX ({stem})")),
                password: None,
                encrypt_filenames: false,
                split_size_bytes: None,
                smart_dev_ignore: false,
                exclude_patterns: vec![],
            },
            |_, _, _| {},
        )?;

        fs::read(&temp_zip)
            .map_err(|e| format!("Impossible de lire le flux ZIP SFX : {e}"))?
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&zip_bytes);

    let out_path = match output_sfx_path {
        Some(p) => p.to_path_buf(),
        None => {
            let parent = archive_path.parent().unwrap_or_else(|| Path::new("."));
            parent.join(format!("{stem}_SFX.cmd"))
        }
    };
    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer le dossier de sortie SFX : {e}"))?;
        }
    }

    let mut script = String::with_capacity(b64.len() + b64.len() / 60 + 1024);
    script.push_str("@echo off\r\n");
    script.push_str("setlocal\r\n");
    script.push_str("set \"ORAR_SFX_SELF=%~f0\"\r\n");
    script.push_str(&format!("set \"ORAR_SFX_OUT=%~dp0{folder_label}_Extrait\"\r\n"));
    script.push_str("echo [ORar SFX] Extraction en cours vers \"%ORAR_SFX_OUT%\"...\r\n");
    script.push_str(
        "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$lines = [IO.File]::ReadAllLines($env:ORAR_SFX_SELF); $idx = [Array]::IndexOf($lines, '::ORAR-SFX-PAYLOAD-BEGIN::'); if ($idx -lt 0) { throw 'Bloc SFX introuvable.' }; $sb = New-Object System.Text.StringBuilder; for ($i = $idx + 1; $i -lt $lines.Length; $i++) { if ($lines[$i].Length -ge 2) { [void]$sb.Append($lines[$i].Substring(2)) } }; $bytes = [Convert]::FromBase64String($sb.ToString()); $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'orar_sfx_' + [Guid]::NewGuid().ToString('N') + '.zip'); [IO.File]::WriteAllBytes($tmp, $bytes); New-Item -ItemType Directory -Force -Path $env:ORAR_SFX_OUT | Out-Null; Expand-Archive -LiteralPath $tmp -DestinationPath $env:ORAR_SFX_OUT -Force; Remove-Item -LiteralPath $tmp -Force\"\r\n",
    );
    script.push_str("if errorlevel 1 (\r\n");
    script.push_str("  echo [ORar SFX] Echec de l'extraction.\r\n");
    script.push_str("  pause\r\n");
    script.push_str("  exit /b 1\r\n");
    script.push_str(")\r\n");
    script.push_str("echo [ORar SFX] Extraction terminee avec succes dans \"%ORAR_SFX_OUT%\" !\r\n");
    script.push_str("pause\r\n");
    script.push_str("exit /b 0\r\n");
    script.push_str("::ORAR-SFX-PAYLOAD-BEGIN::\r\n");

    for chunk in b64.as_bytes().chunks(120) {
        script.push_str("::");
        script.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        script.push_str("\r\n");
    }

    fs::write(&out_path, script.as_bytes())
        .map_err(|e| format!("Impossible d'écrire le fichier SFX : {e}"))?;

    let sfx_size = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    Ok(SfxReport {
        source_archive_path: archive_path.to_string_lossy().to_string(),
        sfx_output_path: out_path.to_string_lossy().to_string(),
        sfx_size,
        message: format!(
            "Paquet auto-extractible Windows créé : {}",
            out_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::{mutate_archive, repair_archive, test_archive_integrity};
    use crate::types::ArchiveMutationRequest;

    fn make_sample_dir() -> TempDir {
        let dir = TempDir::new().expect("temp dir");
        let root = dir.path().join("demo");
        fs::create_dir_all(root.join("code")).expect("mkdir");
        fs::write(
            root.join("notes.txt"),
            "ORar supporte la recherche plein texte et le chiffrement AES-256-GCM.\nLigne 2 confidentielle.\n",
        )
        .expect("write notes");
        fs::write(
            root.join("code").join("app.rs"),
            "fn main() {\n    let secret_token = \"ORAR_OK\";\n}\n",
        )
        .expect("write rs");
        dir
    }

    #[test]
    fn aes256_orar_encrypted_filenames_and_payload() {
        let ws = make_sample_dir();
        let src = ws.path().join("demo").to_string_lossy().to_string();
        let archive_path = ws.path().join("secret.orar");

        let info = create_archive(
            &CreateArchiveRequest {
                source_paths: vec![src],
                output_path: archive_path.to_string_lossy().to_string(),
                format: "orar".into(),
                compression_level: 6,
                comment: Some("Coffre fort".into()),
                password: Some("MonMotDePasseSuper2026!".into()),
                encrypt_filenames: true,
                split_size_bytes: None,
                smart_dev_ignore: false,
                exclude_patterns: vec![],
            },
            |_, _, _| {},
        )
        .expect("create encrypted .orar");
        assert!(info.is_encrypted);

        // Opening without password must request password explicitly
        let no_pw = inspect_archive(&archive_path, None).unwrap_err();
        assert!(no_pw.starts_with("PASSWORD_REQUIRED:"));

        // Wrong password must be rejected
        let wrong_pw = inspect_archive(&archive_path, Some("wrong")).unwrap_err();
        assert!(wrong_pw.starts_with("PASSWORD_REQUIRED:"));

        // Correct password inspects, verifies, searches, and extracts cleanly
        let ok_info = inspect_archive(&archive_path, Some("MonMotDePasseSuper2026!")).expect("inspect");
        assert_eq!(ok_info.file_count, 2);

        let report =
            test_archive_integrity(&archive_path, Some("MonMotDePasseSuper2026!"), |_, _, _| {})
                .expect("verify encrypted");
        assert!(report.valid);

        let hits = search_in_archive_contents(
            &archive_path,
            "secret_token",
            true,
            Some("MonMotDePasseSuper2026!"),
            |_, _, _| {},
        )
        .expect("search encrypted");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "demo/code/app.rs");
    }

    #[test]
    fn mutate_orar_and_zip_add_rename_mkdir_delete() {
        let ws = make_sample_dir();
        let src = ws.path().join("demo").to_string_lossy().to_string();
        let extra_file = ws.path().join("extra.txt");
        fs::write(&extra_file, "Fichier ajouté à chaud!").expect("write extra");

        for (name, fmt) in [("edit.orar", "orar"), ("edit.zip", "zip")] {
            let arch = ws.path().join(name);
            create_archive(
                &CreateArchiveRequest {
                    source_paths: vec![src.clone()],
                    output_path: arch.to_string_lossy().to_string(),
                    format: fmt.into(),
                    compression_level: 6,
                    comment: None,
                    password: None,
                    encrypt_filenames: false,
                    split_size_bytes: None,
                    smart_dev_ignore: false,
                    exclude_patterns: vec![],
                },
                |_, _, _| {},
            )
            .expect("create");

            // mkdir
            let after_mkdir = mutate_archive(&ArchiveMutationRequest {
                archive_path: arch.to_string_lossy().to_string(),
                action: "mkdir".into(),
                target_dir: None,
                source_paths: None,
                paths: None,
                old_path: None,
                new_path: None,
                dir_path: Some("demo/nouveau_dossier".into()),
                password: None,
                text_content: None,
                comment: None,
            })
            .expect("mkdir");
            assert!(after_mkdir.entries.iter().any(|e| e.path == "demo/nouveau_dossier" && e.is_dir));

            // add
            let after_add = mutate_archive(&ArchiveMutationRequest {
                archive_path: arch.to_string_lossy().to_string(),
                action: "add".into(),
                target_dir: Some("demo/nouveau_dossier".into()),
                source_paths: Some(vec![extra_file.to_string_lossy().to_string()]),
                paths: None,
                old_path: None,
                new_path: None,
                dir_path: None,
                password: None,
                text_content: None,
                comment: None,
            })
            .expect("add");
            assert!(after_add
                .entries
                .iter()
                .any(|e| e.path == "demo/nouveau_dossier/extra.txt"));

            // rename
            let after_rename = mutate_archive(&ArchiveMutationRequest {
                archive_path: arch.to_string_lossy().to_string(),
                action: "rename".into(),
                target_dir: None,
                source_paths: None,
                paths: None,
                old_path: Some("demo/nouveau_dossier/extra.txt".into()),
                new_path: Some("demo/nouveau_dossier/renomme.txt".into()),
                dir_path: None,
                password: None,
                text_content: None,
                comment: None,
            })
            .expect("rename");
            assert!(after_rename
                .entries
                .iter()
                .any(|e| e.path == "demo/nouveau_dossier/renomme.txt"));

            // delete
            let after_del = mutate_archive(&ArchiveMutationRequest {
                archive_path: arch.to_string_lossy().to_string(),
                action: "delete".into(),
                target_dir: None,
                source_paths: None,
                paths: Some(vec!["demo/nouveau_dossier/renomme.txt".into()]),
                old_path: None,
                new_path: None,
                dir_path: None,
                password: None,
                text_content: None,
                comment: None,
            })
            .expect("delete");
            assert!(!after_del
                .entries
                .iter()
                .any(|e| e.path == "demo/nouveau_dossier/renomme.txt"));
        }
    }

    #[test]
    fn split_join_hashes_convert_repair_and_benchmark() {
        let ws = make_sample_dir();
        let src = ws.path().join("demo").to_string_lossy().to_string();
        let zip_path = ws.path().join("source.zip");

        create_archive(
            &CreateArchiveRequest {
                source_paths: vec![src],
                output_path: zip_path.to_string_lossy().to_string(),
                format: "zip".into(),
                compression_level: 6,
                comment: None,
                password: None,
                encrypt_filenames: false,
                split_size_bytes: None,
                smart_dev_ignore: false,
                exclude_patterns: vec![],
            },
            |_, _, _| {},
        )
        .expect("create zip");

        let hashes = compute_entry_hashes(&zip_path, "demo/notes.txt", None).expect("hashes");
        assert_eq!(hashes.sha256_hex.len(), 64);
        assert_eq!(hashes.md5_hex.len(), 32);
        assert_eq!(hashes.sha1_hex.len(), 40);

        let orar_path = ws.path().join("converted.orar");
        let converted = convert_archive_format(
            &ConvertArchiveRequest {
                source_archive_path: zip_path.to_string_lossy().to_string(),
                output_path: orar_path.to_string_lossy().to_string(),
                target_format: "orar".into(),
                compression_level: 6,
                source_password: None,
                target_password: None,
                encrypt_filenames: false,
                comment: Some("Converti".into()),
            },
            |_, _, _| {},
        )
        .expect("convert zip -> orar");
        assert_eq!(converted.format, "ORAR");
        assert_eq!(converted.file_count, 2);

        let repair = repair_archive(&orar_path, None).expect("repair");
        assert_eq!(repair.recovered_files, 2);
        assert!(Path::new(&repair.output_path).exists());

        // Split & join test with a 150 KiB payload across 64 KiB volumes
        let big_file = ws.path().join("big.bin");
        let big_bytes: Vec<u8> = (0..150_000).map(|i| (i % 251) as u8).collect();
        fs::write(&big_file, &big_bytes).expect("write big");

        let split = split_archive(&big_file, 64 * 1024).expect("split");
        assert_eq!(split.parts.len(), 3);

        let joined_out = ws.path().join("rebuilt.bin");
        join_split_archive(Path::new(&split.parts[0]), Some(&joined_out)).expect("join");
        assert_eq!(fs::read(&joined_out).expect("read rebuilt"), big_bytes);

        let bench = run_compression_benchmark().expect("benchmark");
        assert_eq!(bench.len(), 5);
    }

    #[test]
    fn dedup_smart_ignore_live_edit_diff_batch_stego_and_sfx() {
        let ws = TempDir::new().expect("temp dir");
        let proj = ws.path().join("my_app");
        fs::create_dir_all(proj.join("src")).expect("mkdir src");
        fs::create_dir_all(proj.join("assets_a")).expect("mkdir assets_a");
        fs::create_dir_all(proj.join("assets_b")).expect("mkdir assets_b");
        fs::create_dir_all(proj.join("node_modules").join("pkg")).expect("mkdir node_modules");
        fs::create_dir_all(proj.join("target").join("debug")).expect("mkdir target");

        let duplicated_payload = b"ORAR_DEDUP_BLOCK_DATA_1234567890".repeat(30);
        fs::write(proj.join("src").join("config.json"), "{\"v\":1}\n").expect("write config");
        fs::write(proj.join("assets_a").join("logo.dat"), &duplicated_payload).expect("write logo a");
        fs::write(proj.join("assets_b").join("logo_copy.dat"), &duplicated_payload).expect("write logo b");
        fs::write(proj.join("node_modules").join("pkg").join("index.js"), "ignored").expect("write nm");
        fs::write(proj.join("target").join("debug").join("app.exe"), "ignored").expect("write target");
        fs::write(proj.join("debug.log"), "ignored log").expect("write log");

        let arch_v1 = ws.path().join("v1.orar");
        let info_v1 = create_archive(
            &CreateArchiveRequest {
                source_paths: vec![proj.to_string_lossy().to_string()],
                output_path: arch_v1.to_string_lossy().to_string(),
                format: "orar".into(),
                compression_level: 6,
                comment: Some("# Note initiale\nVersion 1".into()),
                password: None,
                encrypt_filenames: false,
                split_size_bytes: None,
                smart_dev_ignore: true,
                exclude_patterns: vec![],
            },
            |_, _, _| {},
        )
        .expect("create dedup smart orar");

        // Smart Dev Ignore skipped node_modules, target, debug.log -> only 3 files kept
        assert_eq!(info_v1.file_count, 3);
        assert_eq!(info_v1.deduplicated_files, 1);
        assert_eq!(info_v1.deduplicated_saved_bytes, duplicated_payload.len() as u64);

        // Live Edit (`write_text`) + Markdown Comment (`set_comment`) into v2.orar
        let arch_v2 = ws.path().join("v2.orar");
        fs::copy(&arch_v1, &arch_v2).expect("copy v1 to v2");
        let info_v2_edit = mutate_archive(&ArchiveMutationRequest {
            archive_path: arch_v2.to_string_lossy().to_string(),
            action: "write_text".into(),
            target_dir: None,
            source_paths: None,
            paths: None,
            old_path: None,
            new_path: Some("my_app/src/config.json".into()),
            dir_path: None,
            password: None,
            text_content: Some("{\"v\":2,\"liveEdited\":true}\n".into()),
            comment: None,
        })
        .expect("live edit text");
        assert_eq!(info_v2_edit.file_count, 3);

        let info_v2_comment = mutate_archive(&ArchiveMutationRequest {
            archive_path: arch_v2.to_string_lossy().to_string(),
            action: "set_comment".into(),
            target_dir: None,
            source_paths: None,
            paths: None,
            old_path: None,
            new_path: None,
            dir_path: None,
            password: None,
            text_content: None,
            comment: Some("## Release v2\n- Live edit OK".into()),
        })
        .expect("set comment");
        assert_eq!(info_v2_comment.comment.as_deref(), Some("## Release v2\n- Live edit OK"));

        // Archive Diff v1 vs v2
        let diff = compare_archives(&arch_v1, &arch_v2, None, None).expect("diff archives");
        assert_eq!(diff.modified_count, 1);
        assert_eq!(diff.unchanged_count, 2);

        // Stego-ORar PNG roundtrip
        let stego_png = ws.path().join("camouflaged.png");
        let stego_create = create_stego_archive(&StegoCreateRequest {
            source_archive_path: arch_v2.to_string_lossy().to_string(),
            cover_png_path: None,
            output_png_path: stego_png.to_string_lossy().to_string(),
        })
        .expect("create stego png");
        assert!(stego_png.exists());
        assert!(stego_create.total_size > stego_create.payload_size);

        let unhidden = ws.path().join("revealed.orar");
        let (stego_report, revealed_info) =
            extract_stego_archive(&stego_png, Some(&unhidden), None).expect("extract stego");
        assert_eq!(stego_report.payload_size, stego_create.payload_size);
        assert_eq!(revealed_info.file_count, 3);

        // Batch compress + extract
        let batch_out = ws.path().join("batch_archives");
        let batch_comp = run_batch_operation(
            &BatchOperationRequest {
                mode: "compress_each".into(),
                source_paths: vec![proj.to_string_lossy().to_string()],
                destination_dir: batch_out.to_string_lossy().to_string(),
                format: "orar".into(),
                compression_level: 6,
                smart_dev_ignore: true,
                password: None,
            },
            |_, _, _| {},
        )
        .expect("batch compress");
        assert_eq!(batch_comp.succeeded.len(), 1);

        let batch_extract_out = ws.path().join("batch_extracted");
        let batch_ext = run_batch_operation(
            &BatchOperationRequest {
                mode: "extract_each".into(),
                source_paths: batch_comp.succeeded.clone(),
                destination_dir: batch_extract_out.to_string_lossy().to_string(),
                format: "orar".into(),
                compression_level: 6,
                smart_dev_ignore: false,
                password: None,
            },
            |_, _, _| {},
        )
        .expect("batch extract");
        assert_eq!(batch_ext.succeeded.len(), 1);
        assert!(batch_extract_out
            .join("my_app")
            .join("my_app")
            .join("src")
            .join("config.json")
            .exists());

        // Standalone SFX bundle (.cmd)
        let sfx = create_sfx_bundle(&arch_v2, None, None).expect("create sfx");
        let sfx_text = fs::read_to_string(&sfx.sfx_output_path).expect("read sfx cmd");
        assert!(sfx_text.contains("::ORAR-SFX-PAYLOAD-BEGIN::"));
        assert!(sfx.sfx_size > 200);
    }
}
