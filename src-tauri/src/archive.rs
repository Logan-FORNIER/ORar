use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use base64::Engine;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::orar_format::{
    create_orar_archive, extract_orar_archive, inspect_orar_archive, mutate_orar_archive,
    read_orar_entry_bytes, repair_orar_archive, verify_orar_archive,
};
use crate::types::{
    atomic_replace_file, collect_input_items_with_filtering, collect_input_items_with_prefix,
    entry_basename, entry_matches_selection, finalize_entries, format_system_time,
    normalize_archive_path, safe_join, ArchiveEntry, ArchiveInfo, ArchiveMutationRequest,
    CreateArchiveRequest, DirectoryListing, ExtractArchiveRequest, FsNode, IntegrityReport,
    PreviewFileResponse, QuickPlace, RepairReport,
};

const MAX_TEXT_PREVIEW_BYTES: usize = 256 * 1024;
const MAX_IMAGE_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_HEX_DUMP_BYTES: usize = 256;

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Supported archive container formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Orar,
    Zip,
    SevenZip,
    Rar,
    TarGz,
    TarZst,
    TarXz,
    Tar,
}

impl ArchiveFormat {
    /// Detect format from a file path extension.
    pub fn from_path(path: &Path) -> Result<Self, String> {
        let lower = path.to_string_lossy().to_lowercase();
        if lower.ends_with(".orar") {
            Ok(Self::Orar)
        } else if lower.ends_with(".zip") {
            Ok(Self::Zip)
        } else if lower.ends_with(".7z") {
            Ok(Self::SevenZip)
        } else if lower.ends_with(".rar") {
            Ok(Self::Rar)
        } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
            Ok(Self::TarGz)
        } else if lower.ends_with(".tar.zst") || lower.ends_with(".tzst") || lower.ends_with(".zst") {
            Ok(Self::TarZst)
        } else if lower.ends_with(".tar.xz") || lower.ends_with(".txz") || lower.ends_with(".xz") {
            Ok(Self::TarXz)
        } else if lower.ends_with(".tar") {
            Ok(Self::Tar)
        } else {
            Err(format!("Format d'archive non reconnu : {}", path.display()))
        }
    }

    /// Parse a user-requested format identifier from the UI.
    pub fn from_format_id(format: &str) -> Result<Self, String> {
        match format.trim().to_lowercase().trim_start_matches('.') {
            "orar" => Ok(Self::Orar),
            "zip" => Ok(Self::Zip),
            "7z" => Ok(Self::SevenZip),
            "rar" => Ok(Self::Rar),
            "tar.gz" | "tgz" => Ok(Self::TarGz),
            "tar.zst" | "tzst" | "zst" => Ok(Self::TarZst),
            "tar.xz" | "txz" | "xz" => Ok(Self::TarXz),
            "tar" => Ok(Self::Tar),
            other => Err(format!("Format cible non supporté : {other}")),
        }
    }

    /// Uppercase badge label displayed in the UI.
    pub fn label(self) -> &'static str {
        match self {
            Self::Orar => "ORAR",
            Self::Zip => "ZIP",
            Self::SevenZip => "7Z",
            Self::Rar => "RAR",
            Self::TarGz => "TAR.GZ",
            Self::TarZst => "TAR.ZST",
            Self::TarXz => "TAR.XZ",
            Self::Tar => "TAR",
        }
    }

    /// Whether ORar supports creating archives in this format.
    pub fn can_create(self) -> bool {
        !matches!(self, Self::Rar)
    }
}

fn bsdtar_command() -> Command {
    let sys_tar = PathBuf::from(r"C:\Windows\System32\tar.exe");
    let mut cmd = if sys_tar.exists() {
        Command::new(sys_tar)
    } else {
        Command::new("tar.exe")
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn decode_command_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

fn format_zip_datetime(dt: zip::DateTime) -> Option<String> {
    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        dt.year(),
        dt.month(),
        dt.day(),
        dt.hour(),
        dt.minute()
    ))
}

fn format_unix_mtime(mtime: u64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp(mtime as i64, 0)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
}

/// Inspect any supported archive and return its summary and full entry list.
pub fn inspect_archive(path: &Path, password: Option<&str>) -> Result<ArchiveInfo, String> {
    if !path.exists() {
        return Err(format!("Archive introuvable : {}", path.display()));
    }
    let format = ArchiveFormat::from_path(path)?;
    match format {
        ArchiveFormat::Orar => inspect_orar_archive(path, password),
        ArchiveFormat::Zip => inspect_zip_archive(path),
        ArchiveFormat::TarGz | ArchiveFormat::Tar => inspect_tar_archive(path, format),
        ArchiveFormat::SevenZip | ArchiveFormat::Rar | ArchiveFormat::TarZst | ArchiveFormat::TarXz => {
            inspect_bsdtar_archive(path, format)
        }
    }
}

/// Create a new archive in any supported creation format.
pub fn create_archive<F>(req: &CreateArchiveRequest, mut progress_cb: F) -> Result<ArchiveInfo, String>
where
    F: FnMut(&str, usize, usize),
{
    let format = ArchiveFormat::from_format_id(&req.format)?;
    if !format.can_create() {
        return Err(
            "La création de fichiers .rar propriétaires n'est pas autorisée ; choisissez .orar, .zip, .7z, .tar.gz ou .tar.zst."
                .into(),
        );
    }

    let output_path = PathBuf::from(&req.output_path);
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer le dossier de sortie : {e}"))?;
        }
    }

    match format {
        ArchiveFormat::Orar => create_orar_archive(
            &req.source_paths,
            &output_path,
            req.compression_level,
            req.comment.clone(),
            req.password.as_deref(),
            req.encrypt_filenames,
            req.smart_dev_ignore,
            &req.exclude_patterns,
            progress_cb,
        ),
        ArchiveFormat::Zip => create_zip_archive(
            &req.source_paths,
            &output_path,
            req.compression_level,
            &req.comment,
            req.smart_dev_ignore,
            &req.exclude_patterns,
            &mut progress_cb,
        ),
        ArchiveFormat::Tar | ArchiveFormat::TarGz => create_tar_archive(
            &req.source_paths,
            &output_path,
            format,
            req.compression_level,
            req.smart_dev_ignore,
            &req.exclude_patterns,
            &mut progress_cb,
        ),
        ArchiveFormat::SevenZip | ArchiveFormat::TarZst | ArchiveFormat::TarXz => {
            create_bsdtar_archive(
                &req.source_paths,
                &output_path,
                format,
                req.smart_dev_ignore,
                &req.exclude_patterns,
                &mut progress_cb,
            )
        }
        ArchiveFormat::Rar => unreachable!(),
    }
}

/// Extract all or selected entries from an archive to `destination_dir`.
pub fn extract_archive<F>(req: &ExtractArchiveRequest, mut progress_cb: F) -> Result<usize, String>
where
    F: FnMut(&str, usize, usize),
{
    let archive_path = PathBuf::from(&req.archive_path);
    if !archive_path.exists() {
        return Err(format!("Archive introuvable : {}", req.archive_path));
    }
    let dest_dir = PathBuf::from(&req.destination_dir);
    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Impossible de créer le dossier de destination : {e}"))?;

    let format = ArchiveFormat::from_path(&archive_path)?;
    match format {
        ArchiveFormat::Orar => extract_orar_archive(
            &archive_path,
            &dest_dir,
            &req.selected_entries,
            req.password.as_deref(),
            progress_cb,
        ),
        ArchiveFormat::Zip => {
            extract_zip_archive(&archive_path, &dest_dir, &req.selected_entries, &mut progress_cb)
        }
        ArchiveFormat::TarGz | ArchiveFormat::Tar => {
            extract_tar_archive(&archive_path, &dest_dir, format, &req.selected_entries, &mut progress_cb)
        }
        ArchiveFormat::SevenZip | ArchiveFormat::Rar | ArchiveFormat::TarZst | ArchiveFormat::TarXz => {
            extract_bsdtar_archive(&archive_path, &dest_dir, &req.selected_entries, &mut progress_cb)
        }
    }
}

/// Read up to `max_bytes` of a single entry from any supported archive format.
pub fn read_archive_entry_bytes(
    archive_path: &Path,
    entry_path: &str,
    max_bytes: usize,
    password: Option<&str>,
) -> Result<(Vec<u8>, u64), String> {
    if !archive_path.exists() {
        return Err(format!("Archive introuvable : {}", archive_path.display()));
    }
    let format = ArchiveFormat::from_path(archive_path)?;
    let norm = normalize_archive_path(entry_path);

    match format {
        ArchiveFormat::Orar => read_orar_entry_bytes(archive_path, &norm, max_bytes, password),
        ArchiveFormat::Zip => read_zip_entry_bytes(archive_path, &norm, max_bytes),
        ArchiveFormat::TarGz | ArchiveFormat::Tar => {
            read_tar_entry_bytes(archive_path, format, &norm, max_bytes)
        }
        ArchiveFormat::SevenZip | ArchiveFormat::Rar | ArchiveFormat::TarZst | ArchiveFormat::TarXz => {
            read_bsdtar_entry_bytes(archive_path, &norm, max_bytes)
        }
    }
}

/// Preview an entry inside an archive as text, base64 image, or 256-byte hex dump.
pub fn preview_archive_entry(
    archive_path: &Path,
    entry_path: &str,
    password: Option<&str>,
) -> Result<PreviewFileResponse, String> {
    let norm = normalize_archive_path(entry_path);
    let name = entry_basename(&norm);
    let image_mime = detect_image_mime(&name);
    let max_bytes = if image_mime.is_some() {
        MAX_IMAGE_PREVIEW_BYTES
    } else {
        MAX_TEXT_PREVIEW_BYTES
    };

    let (bytes, total_size) = read_archive_entry_bytes(archive_path, &norm, max_bytes, password)?;
    let truncated = (total_size as usize) > bytes.len();

    if let Some(mime) = image_mime {
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(PreviewFileResponse {
            path: norm,
            name,
            kind: "image".into(),
            mime_type: Some(mime.into()),
            text_content: None,
            base64_content: Some(encoded),
            hex_dump: None,
            size: total_size,
            truncated,
        });
    }

    if let Some(text) = try_decode_utf8_preview(&bytes, truncated) {
        return Ok(PreviewFileResponse {
            path: norm,
            name,
            kind: "text".into(),
            mime_type: Some("text/plain; charset=utf-8".into()),
            text_content: Some(text),
            base64_content: None,
            hex_dump: None,
            size: total_size,
            truncated,
        });
    }

    let hex_slice = &bytes[..bytes.len().min(MAX_HEX_DUMP_BYTES)];
    Ok(PreviewFileResponse {
        path: norm,
        name,
        kind: "binary".into(),
        mime_type: Some("application/octet-stream".into()),
        text_content: None,
        base64_content: None,
        hex_dump: Some(format_hex_dump(hex_slice)),
        size: total_size,
        truncated: total_size as usize > hex_slice.len(),
    })
}

/// Verify archive integrity across all entries without writing extracted files to disk.
pub fn test_archive_integrity<F>(
    archive_path: &Path,
    password: Option<&str>,
    mut progress_cb: F,
) -> Result<IntegrityReport, String>
where
    F: FnMut(&str, usize, usize),
{
    if !archive_path.exists() {
        return Err(format!("Archive introuvable : {}", archive_path.display()));
    }
    let format = ArchiveFormat::from_path(archive_path)?;
    match format {
        ArchiveFormat::Orar => verify_orar_archive(archive_path, password, progress_cb),
        ArchiveFormat::Zip => verify_zip_archive(archive_path, &mut progress_cb),
        ArchiveFormat::TarGz | ArchiveFormat::Tar => {
            verify_tar_archive(archive_path, format, &mut progress_cb)
        }
        ArchiveFormat::SevenZip | ArchiveFormat::Rar | ArchiveFormat::TarZst | ArchiveFormat::TarXz => {
            verify_bsdtar_archive(archive_path, format, &mut progress_cb)
        }
    }
}

/// Mutate an open `.orar` or `.zip` archive in place (add, delete, rename, mkdir).
pub fn mutate_archive(req: &ArchiveMutationRequest) -> Result<ArchiveInfo, String> {
    let path = PathBuf::from(&req.archive_path);
    if !path.exists() {
        return Err(format!("Archive introuvable : {}", req.archive_path));
    }
    match ArchiveFormat::from_path(&path)? {
        ArchiveFormat::Orar => mutate_orar_archive(&path, req),
        ArchiveFormat::Zip => mutate_zip_archive(&path, req),
        other => Err(format!(
            "L'édition directe est prise en charge pour .orar et .zip (format actuel : {}). Convertissez d'abord l'archive en .orar !",
            other.label()
        )),
    }
}

/// Repair a damaged `.orar` or `.zip` archive by salvaging all valid entries into `<stem>_repaired.<ext>`.
pub fn repair_archive(archive_path: &Path, password: Option<&str>) -> Result<RepairReport, String> {
    if !archive_path.exists() {
        return Err(format!("Archive introuvable : {}", archive_path.display()));
    }
    let format = ArchiveFormat::from_path(archive_path)?;
    let stem = archive_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "archive".to_string());
    let ext = archive_path
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "orar".to_string());
    let parent = archive_path.parent().unwrap_or_else(|| Path::new("."));
    let out_path = parent.join(format!("{stem}_repaired.{ext}"));

    match format {
        ArchiveFormat::Orar => repair_orar_archive(archive_path, &out_path, password),
        ArchiveFormat::Zip => repair_zip_archive(archive_path, &out_path),
        other => Err(format!(
            "La réparation automatique est disponible pour .orar et .zip (format actuel : {}).",
            other.label()
        )),
    }
}

/// List directory contents and Windows quick-access places for the built-in PC explorer.
pub fn list_directory(dir_path: Option<String>) -> Result<DirectoryListing, String> {
    let quick_places = build_quick_places();

    let target = match dir_path {
        Some(raw) if !raw.trim().is_empty() => PathBuf::from(raw.trim()),
        _ => quick_places
            .first()
            .map(|q| PathBuf::from(&q.path))
            .unwrap_or_else(|| PathBuf::from(r"E:\")),
    };

    if !target.exists() || !target.is_dir() {
        return Err(format!("Dossier invalide ou inaccessible : {}", target.display()));
    }

    let read_dir = fs::read_dir(&target)
        .map_err(|e| format!("Impossible de lire le dossier {} : {e}", target.display()))?;

    let mut items = Vec::new();
    for entry_res in read_dir {
        let Ok(entry) = entry_res else {
            continue;
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let modified = meta.modified().ok().map(format_system_time);
        let extension = if is_dir {
            None
        } else {
            path.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
        };

        items.push(FsNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            size,
            modified,
            extension,
        });
    }

    items.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    let parent_path = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().to_string());

    Ok(DirectoryListing {
        current_path: target.to_string_lossy().to_string(),
        parent_path,
        quick_places,
        items,
    })
}

fn build_quick_places() -> Vec<QuickPlace> {
    let mut places = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        let home_path = PathBuf::from(&home);
        for (label, sub) in [
            ("Bureau", "Desktop"),
            ("Téléchargements", "Downloads"),
            ("Documents", "Documents"),
        ] {
            let p = home_path.join(sub);
            if p.exists() {
                places.push(QuickPlace {
                    label: label.into(),
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }
    for drive in [r"E:\", r"C:\"] {
        let p = PathBuf::from(drive);
        if p.exists() {
            places.push(QuickPlace {
                label: format!("Disque {}", drive.trim_end_matches('\\')),
                path: drive.into(),
            });
        }
    }
    places
}

fn detect_image_mime(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if lower.ends_with(".png") {
        Some("image/png")
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if lower.ends_with(".gif") {
        Some("image/gif")
    } else if lower.ends_with(".webp") {
        Some("image/webp")
    } else if lower.ends_with(".bmp") {
        Some("image/bmp")
    } else if lower.ends_with(".ico") {
        Some("image/x-icon")
    } else {
        None
    }
}

fn try_decode_utf8_preview(bytes: &[u8], truncated: bool) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Some(text.to_string());
    }
    if truncated {
        for drop in 1..=3.min(bytes.len()) {
            if let Ok(text) = std::str::from_utf8(&bytes[..bytes.len() - drop]) {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn format_hex_dump(bytes: &[u8]) -> String {
    let mut lines = Vec::new();
    for (row_idx, chunk) in bytes.chunks(16).enumerate() {
        let offset = row_idx * 16;
        let mut hex_part = String::with_capacity(48);
        let mut ascii_part = String::with_capacity(16);

        for i in 0..16 {
            if i < chunk.len() {
                let b = chunk[i];
                hex_part.push_str(&format!("{b:02x} "));
                ascii_part.push(if b.is_ascii_graphic() || b == b' ' {
                    b as char
                } else {
                    '.'
                });
            } else {
                hex_part.push_str("   ");
            }
            if i == 7 {
                hex_part.push(' ');
            }
        }
        lines.push(format!("{offset:08x}:  {hex_part} |{ascii_part}|"));
    }
    lines.join("\n")
}

// ============================================================================
// ZIP implementation (pure Rust via `zip`)
// ============================================================================

fn inspect_zip_archive(path: &Path) -> Result<ArchiveInfo, String> {
    let file = File::open(path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", path.display()))?;
    let archive_file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Archive ZIP invalide ({}) : {e}", path.display()))?;

    let comment = {
        let c = String::from_utf8_lossy(archive.comment()).trim().to_string();
        if c.is_empty() { None } else { Some(c) }
    };

    let mut raw_entries = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Erreur lecture entrée ZIP #{i} : {e}"))?;
        let norm = normalize_archive_path(entry.name());
        if norm.is_empty() {
            continue;
        }
        let is_dir = entry.is_dir();
        raw_entries.push(ArchiveEntry {
            name: entry_basename(&norm),
            path: norm,
            is_dir,
            size: if is_dir { 0 } else { entry.size() },
            compressed_size: if is_dir { 0 } else { entry.compressed_size() },
            compression_method: if is_dir {
                "dir".into()
            } else {
                format!("{:?}", entry.compression()).to_lowercase()
            },
            crc32: if is_dir { None } else { Some(entry.crc32()) },
            modified: entry.last_modified().and_then(format_zip_datetime),
            encrypted: entry.encrypted(),
            deduplicated: false,
        });
    }

    let (entries, total_uncompressed_size, total_compressed_size, file_count, dir_count) =
        finalize_entries(raw_entries);
    let is_encrypted = entries.iter().any(|e| e.encrypted);

    Ok(ArchiveInfo {
        archive_path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        format: "ZIP".into(),
        archive_file_size,
        total_uncompressed_size,
        total_compressed_size,
        file_count,
        dir_count,
        comment,
        sha256_manifest: None,
        can_extract: true,
        can_create_format: true,
        is_encrypted,
        can_mutate: !is_encrypted,
        deduplicated_files: 0,
        deduplicated_saved_bytes: 0,
        entries,
    })
}

fn create_zip_archive<F>(
    source_paths: &[String],
    output_path: &Path,
    level: u8,
    comment: &Option<String>,
    smart_dev_ignore: bool,
    exclude_patterns: &[String],
    progress_cb: &mut F,
) -> Result<ArchiveInfo, String>
where
    F: FnMut(&str, usize, usize),
{
    let items =
        collect_input_items_with_filtering(source_paths, "", smart_dev_ignore, exclude_patterns)?;
    let file = File::create(output_path)
        .map_err(|e| format!("Impossible de créer {} : {e}", output_path.display()))?;
    let mut writer = ZipWriter::new(file);

    if let Some(c) = comment.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        writer.set_comment(c);
    }

    let clamped = level.min(9);
    let options = if clamped == 0 {
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored)
    } else {
        SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(clamped as i64))
    };

    let total = items.len();
    for (idx, item) in items.iter().enumerate() {
        progress_cb(&item.archive_path, idx + 1, total);
        if item.is_dir {
            writer
                .add_directory(format!("{}/", item.archive_path), options)
                .map_err(|e| format!("Erreur création dossier ZIP {} : {e}", item.archive_path))?;
            continue;
        }
        writer
            .start_file(&item.archive_path, options)
            .map_err(|e| format!("Erreur ajout fichier ZIP {} : {e}", item.archive_path))?;
        let mut src = File::open(&item.fs_path)
            .map_err(|e| format!("Impossible de lire {} : {e}", item.fs_path.display()))?;
        io::copy(&mut src, &mut writer)
            .map_err(|e| format!("Erreur écriture ZIP sur {} : {e}", item.archive_path))?;
    }

    writer
        .finish()
        .map_err(|e| format!("Erreur de finalisation ZIP : {e}"))?;

    inspect_zip_archive(output_path)
}

fn mutate_zip_archive(archive_path: &Path, req: &ArchiveMutationRequest) -> Result<ArchiveInfo, String> {
    let src_file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let mut src_zip = ZipArchive::new(src_file)
        .map_err(|e| format!("Archive ZIP invalide : {e}"))?;

    let temp_path = archive_path.with_extension("zip.mut.tmp");
    let out_file = File::create(&temp_path)
        .map_err(|e| format!("Impossible de créer le ZIP temporaire : {e}"))?;
    let mut writer = ZipWriter::new(out_file);

    if req.action == "set_comment" {
        if let Some(c) = req.comment.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            writer.set_comment(c);
        }
    } else {
        let existing_comment = String::from_utf8_lossy(src_zip.comment()).to_string();
        if !existing_comment.trim().is_empty() {
            writer.set_comment(existing_comment);
        }
    }

    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));

    let mut additions = Vec::new();
    let mut overwrite_paths = HashSet::new();
    if req.action == "add" {
        let sources = req
            .source_paths
            .as_ref()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| "Aucun fichier ou dossier à ajouter.".to_string())?;
        let prefix = req.target_dir.as_deref().unwrap_or("");
        additions = collect_input_items_with_prefix(sources, prefix)?;
        for item in &additions {
            overwrite_paths.insert(item.archive_path.clone());
        }
    }

    let write_text_target = if req.action == "write_text" {
        let new_n = normalize_archive_path(
            req.new_path
                .as_deref()
                .ok_or_else(|| "Chemin cible manquant pour l'écriture texte.".to_string())?,
        );
        if new_n.is_empty() || new_n.contains("..") {
            return Err("Chemin cible invalide pour l'écriture texte.".into());
        }
        overwrite_paths.insert(new_n.clone());
        Some((new_n, req.text_content.clone().unwrap_or_default()))
    } else {
        None
    };

    let delete_selection = if req.action == "delete" {
        Some(
            req.paths
                .clone()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "Aucune entrée sélectionnée pour la suppression.".to_string())?,
        )
    } else {
        None
    };

    let (old_norm, new_norm) = if req.action == "rename" {
        let old_n = normalize_archive_path(
            req.old_path
                .as_deref()
                .ok_or_else(|| "Chemin source manquant.".to_string())?,
        );
        let new_n = normalize_archive_path(
            req.new_path
                .as_deref()
                .ok_or_else(|| "Nouveau chemin manquant.".to_string())?,
        );
        if old_n.is_empty() || new_n.is_empty() || new_n.contains("..") {
            return Err("Nom cible invalide pour le renommage.".into());
        }
        (old_n, new_n)
    } else {
        (String::new(), String::new())
    };

    for i in 0..src_zip.len() {
        let entry = src_zip
            .by_index(i)
            .map_err(|e| format!("Erreur lecture entrée ZIP #{i} : {e}"))?;
        let norm = normalize_archive_path(entry.name());
        if norm.is_empty() {
            continue;
        }

        if (req.action == "add" || req.action == "write_text") && overwrite_paths.contains(&norm) {
            continue;
        }
        if let Some(ref sel) = delete_selection {
            if entry_matches_selection(&norm, &Some(sel.clone())) {
                continue;
            }
        }

        if req.action == "rename" && !old_norm.is_empty() {
            let prefix = format!("{old_norm}/");
            let renamed = if norm == old_norm {
                Some(new_norm.clone())
            } else if norm.starts_with(&prefix) {
                Some(format!("{new_norm}/{}", &norm[prefix.len()..]))
            } else {
                None
            };

            if let Some(target_name) = renamed {
                let final_name = if entry.is_dir() {
                    format!("{target_name}/")
                } else {
                    target_name
                };
                writer
                    .raw_copy_file_rename(entry, final_name)
                    .map_err(|e| format!("Erreur renommage ZIP : {e}"))?;
                continue;
            }
        }

        writer
            .raw_copy_file(entry)
            .map_err(|e| format!("Erreur copie entrée ZIP : {e}"))?;
    }

    match req.action.as_str() {
        "add" => {
            for item in additions {
                if item.is_dir {
                    writer
                        .add_directory(format!("{}/", item.archive_path), options)
                        .map_err(|e| format!("Erreur ajout dossier ZIP : {e}"))?;
                } else {
                    writer
                        .start_file(&item.archive_path, options)
                        .map_err(|e| format!("Erreur ajout fichier ZIP : {e}"))?;
                    let mut src = File::open(&item.fs_path)
                        .map_err(|e| format!("Impossible de lire {} : {e}", item.fs_path.display()))?;
                    io::copy(&mut src, &mut writer)
                        .map_err(|e| format!("Erreur écriture ZIP : {e}"))?;
                }
            }
        }
        "mkdir" => {
            let dir_norm = normalize_archive_path(
                req.dir_path
                    .as_deref()
                    .ok_or_else(|| "Nom de dossier manquant.".to_string())?,
            );
            if dir_norm.is_empty() || dir_norm.contains("..") {
                return Err("Nom de dossier invalide.".into());
            }
            writer
                .add_directory(format!("{dir_norm}/"), options)
                .map_err(|e| format!("Erreur création dossier ZIP : {e}"))?;
        }
        "write_text" => {
            if let Some((target_name, content)) = write_text_target {
                writer
                    .start_file(&target_name, options)
                    .map_err(|e| format!("Erreur écriture texte ZIP : {e}"))?;
                io::Write::write_all(&mut writer, content.as_bytes())
                    .map_err(|e| format!("Erreur écriture octets ZIP : {e}"))?;
            }
        }
        "delete" | "rename" | "set_comment" => {}
        other => return Err(format!("Action d'édition non reconnue : {other}")),
    }

    writer
        .finish()
        .map_err(|e| format!("Erreur finalisation ZIP : {e}"))?;
    drop(src_zip);
    atomic_replace_file(&temp_path, archive_path)?;
    inspect_zip_archive(archive_path)
}

fn repair_zip_archive(archive_path: &Path, output_path: &Path) -> Result<RepairReport, String> {
    let src_file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let mut src_zip = ZipArchive::new(src_file)
        .map_err(|e| format!("Impossible d'ouvrir la table centrale ZIP : {e}"))?;

    let out_file = File::create(output_path)
        .map_err(|e| format!("Impossible de créer {} : {e}", output_path.display()))?;
    let mut writer = ZipWriter::new(out_file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));

    let mut recovered_files = 0usize;
    let mut damaged_files = Vec::new();

    for i in 0..src_zip.len() {
        let Ok(mut entry) = src_zip.by_index(i) else {
            damaged_files.push(format!("Entrée ZIP #{i} illisible"));
            continue;
        };
        let norm = normalize_archive_path(entry.name());
        if norm.is_empty() {
            continue;
        }
        if entry.is_dir() {
            let _ = writer.add_directory(format!("{norm}/"), options);
            continue;
        }
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_ok() {
            if writer.start_file(&norm, options).is_ok() && io::Write::write_all(&mut writer, &buf).is_ok() {
                recovered_files += 1;
            } else {
                damaged_files.push(norm);
            }
        } else {
            damaged_files.push(norm);
        }
    }

    writer
        .finish()
        .map_err(|e| format!("Erreur finalisation du ZIP réparé : {e}"))?;

    let message = if damaged_files.is_empty() {
        format!("Réparation ZIP terminée : {recovered_files} fichier(s) récupéré(s) sans erreur.")
    } else {
        format!(
            "{recovered_files} fichier(s) récupéré(s), {} entrée(s) corrompue(s) ignorée(s).",
            damaged_files.len()
        )
    };

    Ok(RepairReport {
        source_path: archive_path.to_string_lossy().to_string(),
        output_path: output_path.to_string_lossy().to_string(),
        format: "ZIP".into(),
        recovered_files,
        damaged_files,
        message,
    })
}

fn extract_zip_archive<F>(
    archive_path: &Path,
    dest_dir: &Path,
    selected: &Option<Vec<String>>,
    progress_cb: &mut F,
) -> Result<usize, String>
where
    F: FnMut(&str, usize, usize),
{
    let file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Archive ZIP invalide : {e}"))?;

    let mut matching_indices = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Erreur lecture entrée ZIP #{i} : {e}"))?;
        let norm = normalize_archive_path(entry.name());
        if !norm.is_empty() && entry_matches_selection(&norm, selected) {
            matching_indices.push(i);
        }
    }

    let total = matching_indices.len();
    let mut extracted = 0usize;

    for (pos, idx) in matching_indices.into_iter().enumerate() {
        let mut entry = archive
            .by_index(idx)
            .map_err(|e| format!("Erreur lecture entrée ZIP #{idx} : {e}"))?;
        let norm = normalize_archive_path(entry.name());
        progress_cb(&norm, pos + 1, total);

        let out_path = safe_join(dest_dir, &norm)?;
        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Impossible de créer {} : {e}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer {} : {e}", parent.display()))?;
        }
        let mut out_file = File::create(&out_path)
            .map_err(|e| format!("Impossible de créer {} : {e}", out_path.display()))?;
        io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("Erreur d'extraction ZIP sur {norm} : {e}"))?;
        extracted += 1;
    }

    Ok(extracted)
}

fn read_zip_entry_bytes(
    archive_path: &Path,
    target_path: &str,
    max_bytes: usize,
) -> Result<(Vec<u8>, u64), String> {
    let file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Archive ZIP invalide : {e}"))?;

    let target = normalize_archive_path(target_path);
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Erreur lecture entrée ZIP #{i} : {e}"))?;
        if !entry.is_dir() && normalize_archive_path(entry.name()) == target {
            let size = entry.size();
            let mut buf = Vec::with_capacity((size as usize).min(max_bytes));
            entry
                .take(max_bytes as u64)
                .read_to_end(&mut buf)
                .map_err(|e| format!("Erreur de lecture de {target} : {e}"))?;
            return Ok((buf, size));
        }
    }

    Err(format!("Fichier introuvable dans l'archive ZIP : {target}"))
}

fn verify_zip_archive<F>(archive_path: &Path, progress_cb: &mut F) -> Result<IntegrityReport, String>
where
    F: FnMut(&str, usize, usize),
{
    let start = Instant::now();
    let file = File::open(archive_path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", archive_path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Archive ZIP invalide : {e}"))?;

    let total = archive.len();
    let mut checked_files = 0usize;
    let mut failed_files = Vec::new();

    for i in 0..total {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Erreur entrée ZIP #{i} : {e}"))?;
        let norm = normalize_archive_path(entry.name());
        progress_cb(&norm, i + 1, total);
        if entry.is_dir() {
            continue;
        }
        checked_files += 1;
        if let Err(err) = io::copy(&mut entry, &mut io::sink()) {
            failed_files.push(format!("{norm} ({err})"));
        }
    }

    let valid = failed_files.is_empty();
    let message = if valid {
        format!("Archive ZIP intacte : {checked_files} fichier(s) vérifié(s) avec succès (CRC32).")
    } else {
        format!("{} fichier(s) corrompu(s) détecté(s) dans le ZIP.", failed_files.len())
    };

    Ok(IntegrityReport {
        archive_path: archive_path.to_string_lossy().to_string(),
        format: "ZIP".into(),
        valid,
        checked_files,
        failed_files,
        manifest_verified: None,
        sha256_manifest: None,
        duration_ms: start.elapsed().as_millis() as u64,
        message,
    })
}

// ============================================================================
// TAR / TAR.GZ implementation (pure Rust via `tar` + `flate2`)
// ============================================================================

fn open_tar_reader(path: &Path, format: ArchiveFormat) -> Result<Box<dyn Read>, String> {
    let file = File::open(path)
        .map_err(|e| format!("Impossible d'ouvrir {} : {e}", path.display()))?;
    match format {
        ArchiveFormat::TarGz => Ok(Box::new(GzDecoder::new(file))),
        ArchiveFormat::Tar => Ok(Box::new(file)),
        _ => Err("Format TAR interne inattendu.".into()),
    }
}

fn inspect_tar_archive(path: &Path, format: ArchiveFormat) -> Result<ArchiveInfo, String> {
    let archive_file_size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let reader = open_tar_reader(path, format)?;
    let mut archive = tar::Archive::new(reader);

    let mut raw_entries = Vec::new();
    let entries_iter = archive
        .entries()
        .map_err(|e| format!("Impossible de lire l'archive {} : {e}", format.label()))?;

    for item in entries_iter {
        let entry = item.map_err(|e| format!("Entrée TAR corrompue : {e}"))?;
        let raw_path = entry
            .path()
            .map_err(|e| format!("Chemin TAR invalide : {e}"))?
            .to_string_lossy()
            .to_string();
        let norm = normalize_archive_path(&raw_path);
        if norm.is_empty() {
            continue;
        }
        let is_dir = entry.header().entry_type().is_dir();
        let size = if is_dir { 0 } else { entry.header().size().unwrap_or(0) };
        let modified = entry.header().mtime().ok().and_then(format_unix_mtime);

        raw_entries.push(ArchiveEntry {
            name: entry_basename(&norm),
            path: norm,
            is_dir,
            size,
            compressed_size: size,
            compression_method: format.label().to_lowercase(),
            crc32: None,
            modified,
            encrypted: false,
            deduplicated: false,
        });
    }

    let (entries, total_uncompressed_size, _, file_count, dir_count) =
        finalize_entries(raw_entries);

    Ok(ArchiveInfo {
        archive_path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        format: format.label().into(),
        archive_file_size,
        total_uncompressed_size,
        total_compressed_size: archive_file_size,
        file_count,
        dir_count,
        comment: None,
        sha256_manifest: None,
        can_extract: true,
        can_create_format: true,
        is_encrypted: false,
        can_mutate: false,
        deduplicated_files: 0,
        deduplicated_saved_bytes: 0,
        entries,
    })
}

fn create_tar_archive<F>(
    source_paths: &[String],
    output_path: &Path,
    format: ArchiveFormat,
    level: u8,
    smart_dev_ignore: bool,
    exclude_patterns: &[String],
    progress_cb: &mut F,
) -> Result<ArchiveInfo, String>
where
    F: FnMut(&str, usize, usize),
{
    let items =
        collect_input_items_with_filtering(source_paths, "", smart_dev_ignore, exclude_patterns)?;
    let file = File::create(output_path)
        .map_err(|e| format!("Impossible de créer {} : {e}", output_path.display()))?;

    let writer: Box<dyn io::Write> = match format {
        ArchiveFormat::TarGz => {
            Box::new(GzEncoder::new(file, Compression::new(level.min(9) as u32)))
        }
        ArchiveFormat::Tar => Box::new(file),
        _ => return Err("Format TAR non géré pour la création.".into()),
    };

    let mut builder = tar::Builder::new(writer);
    let total = items.len();

    for (idx, item) in items.iter().enumerate() {
        progress_cb(&item.archive_path, idx + 1, total);
        if item.is_dir {
            builder
                .append_dir(&item.archive_path, &item.fs_path)
                .map_err(|e| format!("Erreur ajout dossier TAR {} : {e}", item.archive_path))?;
        } else {
            builder
                .append_path_with_name(&item.fs_path, &item.archive_path)
                .map_err(|e| format!("Erreur ajout fichier TAR {} : {e}", item.archive_path))?;
        }
    }

    let inner = builder
        .into_inner()
        .map_err(|e| format!("Erreur finalisation TAR : {e}"))?;
    drop(inner);

    inspect_tar_archive(output_path, format)
}

fn extract_tar_archive<F>(
    archive_path: &Path,
    dest_dir: &Path,
    format: ArchiveFormat,
    selected: &Option<Vec<String>>,
    progress_cb: &mut F,
) -> Result<usize, String>
where
    F: FnMut(&str, usize, usize),
{
    let reader = open_tar_reader(archive_path, format)?;
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|e| format!("Erreur lecture archive TAR : {e}"))?;

    let mut extracted = 0usize;
    let mut seen = 0usize;

    for item in entries {
        let mut entry = item.map_err(|e| format!("Entrée TAR invalide : {e}"))?;
        let raw_path = entry
            .path()
            .map_err(|e| format!("Chemin TAR invalide : {e}"))?
            .to_string_lossy()
            .to_string();
        let norm = normalize_archive_path(&raw_path);
        if norm.is_empty() || !entry_matches_selection(&norm, selected) {
            continue;
        }

        seen += 1;
        progress_cb(&norm, seen, seen);

        let out_path = safe_join(dest_dir, &norm)?;
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Impossible de créer {} : {e}", out_path.display()))?;
            continue;
        }
        if entry.header().entry_type().is_file() {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Impossible de créer {} : {e}", parent.display()))?;
            }
            let mut out_file = File::create(&out_path)
                .map_err(|e| format!("Impossible de créer {} : {e}", out_path.display()))?;
            io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("Erreur extraction TAR sur {norm} : {e}"))?;
            extracted += 1;
        }
    }

    Ok(extracted)
}

fn read_tar_entry_bytes(
    archive_path: &Path,
    format: ArchiveFormat,
    target_path: &str,
    max_bytes: usize,
) -> Result<(Vec<u8>, u64), String> {
    let reader = open_tar_reader(archive_path, format)?;
    let mut archive = tar::Archive::new(reader);
    let target = normalize_archive_path(target_path);

    let entries = archive
        .entries()
        .map_err(|e| format!("Erreur lecture archive TAR : {e}"))?;
    for item in entries {
        let entry = item.map_err(|e| format!("Entrée TAR corrompue : {e}"))?;
        let raw_path = entry
            .path()
            .map_err(|e| format!("Chemin TAR invalide : {e}"))?
            .to_string_lossy()
            .to_string();
        if !entry.header().entry_type().is_dir() && normalize_archive_path(&raw_path) == target {
            let size = entry.header().size().unwrap_or(0);
            let mut buf = Vec::with_capacity((size as usize).min(max_bytes));
            entry
                .take(max_bytes as u64)
                .read_to_end(&mut buf)
                .map_err(|e| format!("Erreur lecture aperçu {target} : {e}"))?;
            return Ok((buf, size));
        }
    }

    Err(format!("Fichier introuvable dans l'archive : {target}"))
}

fn verify_tar_archive<F>(
    archive_path: &Path,
    format: ArchiveFormat,
    progress_cb: &mut F,
) -> Result<IntegrityReport, String>
where
    F: FnMut(&str, usize, usize),
{
    let start = Instant::now();
    let reader = open_tar_reader(archive_path, format)?;
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|e| format!("Archive {} corrompue : {e}", format.label()))?;

    let mut checked_files = 0usize;
    let mut failed_files = Vec::new();

    for item in entries {
        match item {
            Ok(mut entry) => {
                let norm = entry
                    .path()
                    .map(|p| normalize_archive_path(&p.to_string_lossy()))
                    .unwrap_or_default();
                if entry.header().entry_type().is_file() {
                    checked_files += 1;
                    progress_cb(&norm, checked_files, checked_files);
                    if let Err(err) = io::copy(&mut entry, &mut io::sink()) {
                        failed_files.push(format!("{norm} ({err})"));
                    }
                }
            }
            Err(err) => {
                failed_files.push(format!("Flux TAR corrompu ({err})"));
                break;
            }
        }
    }

    let valid = failed_files.is_empty();
    let message = if valid {
        format!(
            "Archive {} saine : {} fichier(s) lu(s) et vérifié(s).",
            format.label(),
            checked_files
        )
    } else {
        "Des erreurs de lecture ou de décompression ont été détectées.".into()
    };

    Ok(IntegrityReport {
        archive_path: archive_path.to_string_lossy().to_string(),
        format: format.label().into(),
        valid,
        checked_files,
        failed_files,
        manifest_verified: None,
        sha256_manifest: None,
        duration_ms: start.elapsed().as_millis() as u64,
        message,
    })
}

// ============================================================================
// libarchive / bsdtar driver for .rar, .7z, .tar.zst, .tar.xz
// ============================================================================

/// Parse one verbose `tar.exe -tvf` output line into an `ArchiveEntry`.
pub fn parse_bsdtar_line(line: &str, format_label: &str) -> Option<ArchiveEntry> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    if trimmed.trim().is_empty() {
        return None;
    }

    let bytes = trimmed.as_bytes();
    let mut idx = 0usize;
    let mut tokens: Vec<&str> = Vec::with_capacity(8);

    while tokens.len() < 8 {
        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= bytes.len() {
            break;
        }
        let start = idx;
        while idx < bytes.len() && !bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        tokens.push(&trimmed[start..idx]);
    }

    if tokens.len() < 8 || idx >= trimmed.len() {
        return None;
    }

    let raw_name = trimmed[idx..].strip_prefix(' ').unwrap_or(trimmed[idx..].trim_start());
    let perms = tokens[0];
    let size = tokens[4].parse::<u64>().unwrap_or(0);
    let modified = Some(format!("{} {} {}", tokens[5], tokens[6], tokens[7]));

    let clean_target = if perms.starts_with('l') {
        raw_name.split(" -> ").next().unwrap_or(raw_name)
    } else {
        raw_name
    };

    let is_dir = perms.starts_with('d') || clean_target.ends_with('/');
    let norm = normalize_archive_path(clean_target);
    if norm.is_empty() {
        return None;
    }

    Some(ArchiveEntry {
        name: entry_basename(&norm),
        path: norm,
        is_dir,
        size: if is_dir { 0 } else { size },
        compressed_size: if is_dir { 0 } else { size },
        compression_method: if is_dir {
            "dir".into()
        } else {
            format_label.to_lowercase()
        },
        crc32: None,
        modified,
        encrypted: false,
        deduplicated: false,
    })
}

fn inspect_bsdtar_archive(path: &Path, format: ArchiveFormat) -> Result<ArchiveInfo, String> {
    let archive_file_size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let output = bsdtar_command()
        .arg("-tvf")
        .arg(path)
        .output()
        .map_err(|e| format!("Impossible d'exécuter tar.exe pour lire {} : {e}", format.label()))?;

    if !output.status.success() {
        let err = decode_command_output(&output.stderr);
        return Err(format!(
            "Impossible de lire l'archive {} : {}",
            format.label(),
            err.trim()
        ));
    }

    let stdout = decode_command_output(&output.stdout);
    let raw_entries: Vec<ArchiveEntry> = stdout
        .lines()
        .filter_map(|line| parse_bsdtar_line(line, format.label()))
        .collect();

    let (entries, total_uncompressed_size, _, file_count, dir_count) =
        finalize_entries(raw_entries);

    Ok(ArchiveInfo {
        archive_path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        format: format.label().into(),
        archive_file_size,
        total_uncompressed_size,
        total_compressed_size: archive_file_size,
        file_count,
        dir_count,
        comment: None,
        sha256_manifest: None,
        can_extract: true,
        can_create_format: format.can_create(),
        is_encrypted: false,
        can_mutate: false,
        deduplicated_files: 0,
        deduplicated_saved_bytes: 0,
        entries,
    })
}

fn create_bsdtar_archive<F>(
    source_paths: &[String],
    output_path: &Path,
    format: ArchiveFormat,
    smart_dev_ignore: bool,
    exclude_patterns: &[String],
    progress_cb: &mut F,
) -> Result<ArchiveInfo, String>
where
    F: FnMut(&str, usize, usize),
{
    if source_paths.is_empty() {
        return Err("Aucun fichier ou dossier sélectionné pour la compression.".into());
    }

    let mut cmd = bsdtar_command();
    match format {
        ArchiveFormat::SevenZip => {
            cmd.arg("-a").arg("-cf").arg(output_path);
        }
        ArchiveFormat::TarZst => {
            cmd.arg("--zstd").arg("-cf").arg(output_path);
        }
        ArchiveFormat::TarXz => {
            cmd.arg("-J").arg("-cf").arg(output_path);
        }
        _ => return Err("Format non supporté par le pilote libarchive.".into()),
    }

    let mut _staging_guard: Option<tempfile::TempDir> = None;

    if smart_dev_ignore || !exclude_patterns.is_empty() {
        let items = collect_input_items_with_filtering(
            source_paths,
            "",
            smart_dev_ignore,
            exclude_patterns,
        )?;
        let staging = tempfile::TempDir::new()
            .map_err(|e| format!("Impossible de préparer le dossier de filtrage : {e}"))?;

        let total = items.len();
        for (idx, item) in items.iter().enumerate() {
            progress_cb(&item.archive_path, idx + 1, total);
            let target = safe_join(staging.path(), &item.archive_path)?;
            if item.is_dir {
                fs::create_dir_all(&target)
                    .map_err(|e| format!("Erreur préparation dossier {} : {e}", target.display()))?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Erreur préparation dossier {} : {e}", parent.display()))?;
                }
                if fs::hard_link(&item.fs_path, &target).is_err() {
                    fs::copy(&item.fs_path, &target)
                        .map_err(|e| format!("Erreur copie fichier {} : {e}", item.fs_path.display()))?;
                }
            }
        }

        let top_entries = fs::read_dir(staging.path())
            .map_err(|e| format!("Erreur lecture staging : {e}"))?;
        for top_res in top_entries {
            if let Ok(top) = top_res {
                cmd.arg("-C").arg(staging.path()).arg(top.file_name());
            }
        }
        _staging_guard = Some(staging);
    } else {
        let total = source_paths.len();
        for (idx, raw) in source_paths.iter().enumerate() {
            let src = PathBuf::from(raw);
            if !src.exists() {
                return Err(format!("Chemin introuvable : {raw}"));
            }
            let item_name = src
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .ok_or_else(|| format!("Nom de fichier invalide : {raw}"))?;
            let parent = src.parent().filter(|p| !p.as_os_str().is_empty());

            progress_cb(&item_name, idx + 1, total);

            if let Some(parent_dir) = parent {
                cmd.arg("-C").arg(parent_dir).arg(&item_name);
            } else {
                cmd.arg(&src);
            }
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Échec du lancement de tar.exe : {e}"))?;
    if !output.status.success() {
        let err = decode_command_output(&output.stderr);
        return Err(format!(
            "Erreur lors de la création de l'archive {} : {}",
            format.label(),
            err.trim()
        ));
    }

    inspect_bsdtar_archive(output_path, format)
}

fn extract_bsdtar_archive<F>(
    archive_path: &Path,
    dest_dir: &Path,
    selected: &Option<Vec<String>>,
    progress_cb: &mut F,
) -> Result<usize, String>
where
    F: FnMut(&str, usize, usize),
{
    let info = inspect_bsdtar_archive(archive_path, ArchiveFormat::from_path(archive_path)?)?;
    for entry in &info.entries {
        let _ = safe_join(dest_dir, &entry.path)?;
    }

    progress_cb(&info.file_name, 1, 2);

    let mut cmd = bsdtar_command();
    cmd.arg("-xf").arg(archive_path).arg("-C").arg(dest_dir);

    if let Some(sel) = selected.as_ref().filter(|v| !v.is_empty()) {
        cmd.arg("--");
        for item in sel {
            let norm = normalize_archive_path(item);
            let _ = safe_join(dest_dir, &norm)?;
            cmd.arg(norm);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Échec d'extraction via tar.exe : {e}"))?;
    if !output.status.success() {
        let err = decode_command_output(&output.stderr);
        return Err(format!("Erreur d'extraction : {}", err.trim()));
    }

    progress_cb(&info.file_name, 2, 2);
    Ok(info.file_count)
}

fn read_bsdtar_entry_bytes(
    archive_path: &Path,
    entry_path: &str,
    max_bytes: usize,
) -> Result<(Vec<u8>, u64), String> {
    let info = inspect_archive(archive_path, None)?;
    let norm = normalize_archive_path(entry_path);
    let total_size = info
        .entries
        .iter()
        .find(|e| !e.is_dir && e.path == norm)
        .map(|e| e.size)
        .ok_or_else(|| format!("Entrée introuvable dans l'archive : {norm}"))?;

    let mut child = bsdtar_command()
        .arg("-xOf")
        .arg(archive_path)
        .arg("--")
        .arg(&norm)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Impossible d'extraire l'aperçu via tar.exe : {e}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Flux de sortie indisponible pour l'aperçu.".to_string())?;
    let mut buf = Vec::with_capacity((total_size as usize).min(max_bytes));
    stdout
        .by_ref()
        .take(max_bytes as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Erreur de lecture de l'aperçu : {e}"))?;

    let _ = child.kill();
    let _ = child.wait();
    Ok((buf, total_size))
}

fn verify_bsdtar_archive<F>(
    archive_path: &Path,
    format: ArchiveFormat,
    progress_cb: &mut F,
) -> Result<IntegrityReport, String>
where
    F: FnMut(&str, usize, usize),
{
    let start = Instant::now();
    let info = inspect_bsdtar_archive(archive_path, format)?;
    progress_cb(&info.file_name, 1, 2);

    let mut child = bsdtar_command()
        .arg("-xOf")
        .arg(archive_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Impossible de vérifier l'archive via tar.exe : {e}"))?;

    if let Some(mut stdout) = child.stdout.take() {
        let _ = io::copy(&mut stdout, &mut io::sink());
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Erreur lors de la vérification : {e}"))?;
    progress_cb(&info.file_name, 2, 2);

    let valid = output.status.success();
    let failed_files = if valid {
        Vec::new()
    } else {
        vec![decode_command_output(&output.stderr).trim().to_string()]
    };

    let message = if valid {
        format!(
            "Archive {} vérifiée : {} fichier(s) décompressé(s) sans erreur.",
            format.label(),
            info.file_count
        )
    } else {
        "Le flux compressé de l'archive a renvoyé une erreur d'intégrité.".into()
    };

    Ok(IntegrityReport {
        archive_path: archive_path.to_string_lossy().to_string(),
        format: format.label().into(),
        valid,
        checked_files: info.file_count,
        failed_files,
        manifest_verified: None,
        sha256_manifest: None,
        duration_ms: start.elapsed().as_millis() as u64,
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn create_sample_workspace() -> TempDir {
        let dir = TempDir::new().expect("create temp dir");
        let sub = dir.path().join("projet_demo").join("src");
        fs::create_dir_all(&sub).expect("create sub dir");

        fs::write(
            dir.path().join("projet_demo").join("README.md"),
            "# ORar Demo\n\nCeci est un test d'archive avec caractères accentués éàù.\n".repeat(20),
        )
        .expect("write readme");

        fs::write(
            sub.join("main.rs"),
            "fn main() {\n    println!(\"Bonjour ORar!\");\n}\n",
        )
        .expect("write main.rs");

        let mut raw = vec![0u8; 128];
        for (i, b) in raw.iter_mut().enumerate() {
            *b = ((i * 73 + 19) % 251) as u8;
        }
        let mut f = File::create(sub.join("binary.bin")).expect("create bin");
        f.write_all(&raw).expect("write bin");

        dir
    }

    #[test]
    fn orar_roundtrip_inspect_preview_verify_extract() {
        let ws = create_sample_workspace();
        let src_dir = ws.path().join("projet_demo").to_string_lossy().to_string();
        let archive_path = ws.path().join("test.orar");

        let created = create_archive(
            &CreateArchiveRequest {
                source_paths: vec![src_dir],
                output_path: archive_path.to_string_lossy().to_string(),
                format: "orar".into(),
                compression_level: 6,
                comment: Some("Archive signature ORar".into()),
                password: None,
                encrypt_filenames: false,
                split_size_bytes: None,
                smart_dev_ignore: false,
                exclude_patterns: vec![],
            },
            |_, _, _| {},
        )
        .expect("create .orar");

        assert_eq!(created.format, "ORAR");
        assert_eq!(created.file_count, 3);
        assert!(created.sha256_manifest.is_some());

        let text_prev = preview_archive_entry(&archive_path, "projet_demo/README.md", None)
            .expect("preview readme");
        assert_eq!(text_prev.kind, "text");
        assert!(text_prev.text_content.unwrap().contains("ORar Demo"));

        let bin_prev = preview_archive_entry(&archive_path, "projet_demo/src/binary.bin", None)
            .expect("preview binary");
        assert_eq!(bin_prev.kind, "binary");
        assert!(bin_prev.hex_dump.unwrap().contains("00000000:"));

        let report =
            test_archive_integrity(&archive_path, None, |_, _, _| {}).expect("verify .orar");
        assert!(report.valid);
        assert_eq!(report.manifest_verified, Some(true));

        let out_dir = ws.path().join("extracted_orar");
        let extracted = extract_archive(
            &ExtractArchiveRequest {
                archive_path: archive_path.to_string_lossy().to_string(),
                destination_dir: out_dir.to_string_lossy().to_string(),
                selected_entries: None,
                password: None,
            },
            |_, _, _| {},
        )
        .expect("extract .orar");
        assert_eq!(extracted, 3);
        assert!(out_dir.join("projet_demo/src/main.rs").exists());
    }

    #[test]
    fn zip_and_targz_roundtrip() {
        let ws = create_sample_workspace();
        let src_dir = ws.path().join("projet_demo").to_string_lossy().to_string();

        for (ext, fmt, expected_label) in [("zip", "zip", "ZIP"), ("tar.gz", "tar.gz", "TAR.GZ")] {
            let archive_path = ws.path().join(format!("bundle.{ext}"));
            let info = create_archive(
                &CreateArchiveRequest {
                    source_paths: vec![src_dir.clone()],
                    output_path: archive_path.to_string_lossy().to_string(),
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
            .expect("create archive");

            assert_eq!(info.format, expected_label);
            assert_eq!(info.file_count, 3);

            let report =
                test_archive_integrity(&archive_path, None, |_, _, _| {}).expect("verify");
            assert!(report.valid);

            let out_dir = ws.path().join(format!("out_{fmt}"));
            extract_archive(
                &ExtractArchiveRequest {
                    archive_path: archive_path.to_string_lossy().to_string(),
                    destination_dir: out_dir.to_string_lossy().to_string(),
                    selected_entries: Some(vec!["projet_demo/src".into()]),
                    password: None,
                },
                |_, _, _| {},
            )
            .expect("selective extract");

            assert!(out_dir.join("projet_demo/src/main.rs").exists());
            assert!(!out_dir.join("projet_demo/README.md").exists());
        }
    }

    #[test]
    fn parse_bsdtar_preserves_spaces_and_dirs() {
        let file_line = "-rw-rw-rw-  0 0      0          13 nov. 15 02:25 sub dir/my file.txt";
        let file_entry = parse_bsdtar_line(file_line, "7Z").expect("parse file line");
        assert!(!file_entry.is_dir);
        assert_eq!(file_entry.path, "sub dir/my file.txt");

        let dir_line = "drwxrwxrwx  0 0      0           0 nov. 15 02:25 sub dir/";
        let dir_entry = parse_bsdtar_line(dir_line, "RAR").expect("parse dir line");
        assert!(dir_entry.is_dir);
        assert_eq!(dir_entry.path, "sub dir");
    }

    #[test]
    fn safe_join_blocks_zip_slip() {
        let base = Path::new(r"C:\Temp\out");
        assert!(safe_join(base, "../evil.txt").is_err());
        assert!(safe_join(base, "folder/../../evil.txt").is_err());
        assert!(safe_join(base, "folder/good.txt").is_ok());
    }
}
