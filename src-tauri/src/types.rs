use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

/// Metadata for a single file or directory inside an archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub compressed_size: u64,
    pub compression_method: String,
    pub crc32: Option<u32>,
    pub modified: Option<String>,
    #[serde(default)]
    pub encrypted: bool,
    #[serde(default)]
    pub deduplicated: bool,
}

/// High-level summary and full entry listing of an opened or created archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub archive_path: String,
    pub file_name: String,
    pub format: String,
    pub archive_file_size: u64,
    pub total_uncompressed_size: u64,
    pub total_compressed_size: u64,
    pub file_count: usize,
    pub dir_count: usize,
    pub comment: Option<String>,
    pub sha256_manifest: Option<String>,
    pub can_extract: bool,
    pub can_create_format: bool,
    pub is_encrypted: bool,
    pub can_mutate: bool,
    #[serde(default)]
    pub deduplicated_files: usize,
    #[serde(default)]
    pub deduplicated_saved_bytes: u64,
    pub entries: Vec<ArchiveEntry>,
}

/// Parameters required to create a new archive.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArchiveRequest {
    pub source_paths: Vec<String>,
    pub output_path: String,
    pub format: String,
    pub compression_level: u8,
    pub comment: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub encrypt_filenames: bool,
    #[serde(default)]
    pub split_size_bytes: Option<u64>,
    #[serde(default)]
    pub smart_dev_ignore: bool,
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
}

/// Parameters required to extract all or selected entries from an archive.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractArchiveRequest {
    pub archive_path: String,
    pub destination_dir: String,
    pub selected_entries: Option<Vec<String>>,
    #[serde(default)]
    pub password: Option<String>,
}

/// Mutation request to add, delete, rename, create folders, edit text, or update comment inside an open archive.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMutationRequest {
    pub archive_path: String,
    pub action: String,
    pub target_dir: Option<String>,
    pub source_paths: Option<Vec<String>>,
    pub paths: Option<Vec<String>>,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub dir_path: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub text_content: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

/// Instant preview payload returned for a file inside an archive.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFileResponse {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub mime_type: Option<String>,
    pub text_content: Option<String>,
    pub base64_content: Option<String>,
    pub hex_dump: Option<String>,
    pub size: u64,
    pub truncated: bool,
}

/// Integrity verification result produced by testing an archive.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub archive_path: String,
    pub format: String,
    pub valid: bool,
    pub checked_files: usize,
    pub failed_files: Vec<String>,
    pub manifest_verified: Option<bool>,
    pub sha256_manifest: Option<String>,
    pub duration_ms: u64,
    pub message: String,
}

/// Complete cryptographic hash set for a single archive entry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryHashes {
    pub path: String,
    pub size: u64,
    pub crc32_hex: String,
    pub md5_hex: String,
    pub sha1_hex: String,
    pub sha256_hex: String,
}

/// Single full-text search hit inside an archive file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchMatch {
    pub path: String,
    pub line_number: usize,
    pub line_preview: String,
    pub match_count: usize,
}

/// Result of converting an archive from one format to another.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertArchiveRequest {
    pub source_archive_path: String,
    pub output_path: String,
    pub target_format: String,
    pub compression_level: u8,
    pub source_password: Option<String>,
    pub target_password: Option<String>,
    #[serde(default)]
    pub encrypt_filenames: bool,
    pub comment: Option<String>,
}

/// Report produced when repairing a damaged `.orar` or `.zip` archive.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReport {
    pub source_path: String,
    pub output_path: String,
    pub format: String,
    pub recovered_files: usize,
    pub damaged_files: Vec<String>,
    pub message: String,
}

/// Report produced when splitting an archive into fixed-size volumes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitReport {
    pub source_path: String,
    pub parts: Vec<String>,
    pub total_size: u64,
    pub part_size: u64,
    pub sha256: String,
}

/// Single engine result from the built-in CPU compression benchmark.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResult {
    pub engine: String,
    pub level_label: String,
    pub input_size: u64,
    pub compressed_size: u64,
    pub ratio_percent: f64,
    pub compress_mb_s: f64,
    pub decompress_mb_s: f64,
    pub compress_ms: u64,
    pub decompress_ms: u64,
}

/// Status of HKCU Windows Explorer registry integration.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsIntegrationStatus {
    pub orar_associated: bool,
    pub context_menu_enabled: bool,
    pub exe_path: String,
}

/// Single entry comparison row in an archive diff report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDiffItem {
    pub path: String,
    pub status: String,
    pub left_size: Option<u64>,
    pub right_size: Option<u64>,
    pub size_delta: i64,
    pub left_crc32: Option<u32>,
    pub right_crc32: Option<u32>,
}

/// Complete comparison report between two archives.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDiffReport {
    pub left_path: String,
    pub right_path: String,
    pub added_count: usize,
    pub removed_count: usize,
    pub modified_count: usize,
    pub unchanged_count: usize,
    pub total_size_delta: i64,
    pub items: Vec<ArchiveDiffItem>,
}

/// Batch operation request to extract multiple archives or compress multiple targets individually.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOperationRequest {
    pub mode: String,
    pub source_paths: Vec<String>,
    pub destination_dir: String,
    #[serde(default = "default_orar_format")]
    pub format: String,
    #[serde(default = "default_compression_level")]
    pub compression_level: u8,
    #[serde(default)]
    pub smart_dev_ignore: bool,
    #[serde(default)]
    pub password: Option<String>,
}

fn default_orar_format() -> String {
    "orar".to_string()
}

fn default_compression_level() -> u8 {
    6
}

/// Result summary for a batch compression or extraction run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOperationReport {
    pub mode: String,
    pub processed_count: usize,
    pub succeeded: Vec<String>,
    pub failed: Vec<String>,
    pub message: String,
}

/// Request to conceal an archive inside a carrier PNG image (Stego-ORar).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StegoCreateRequest {
    pub source_archive_path: String,
    #[serde(default)]
    pub cover_png_path: Option<String>,
    pub output_png_path: String,
}

/// Report returned after creating or extracting a Stego-ORar PNG container.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StegoReport {
    pub stego_png_path: String,
    pub extracted_archive_path: Option<String>,
    pub cover_size: u64,
    pub payload_size: u64,
    pub total_size: u64,
    pub message: String,
}

/// Report returned after generating a standalone Windows `.cmd` SFX bundle.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SfxReport {
    pub source_archive_path: String,
    pub sfx_output_path: String,
    pub sfx_size: u64,
    pub message: String,
}

/// Information returned when checking GitHub Releases for application updates.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub tag_name: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_notes: String,
    pub published_at: Option<String>,
    pub html_url: String,
    pub installer_url: Option<String>,
    pub installer_name: Option<String>,
    pub installer_size: Option<u64>,
}

/// Report returned after downloading and launching a new installer from GitHub Releases.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallReport {
    pub downloaded_path: String,
    pub launched: bool,
    pub message: String,
}

/// Single filesystem entry used by the built-in PC explorer sidebar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    pub extension: Option<String>,
}

/// Shortcut folder displayed in the PC explorer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickPlace {
    pub label: String,
    pub path: String,
}

/// Directory contents returned to the frontend PC explorer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub quick_places: Vec<QuickPlace>,
    pub items: Vec<FsNode>,
}

/// Real-time progress payload emitted on `orar://progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub operation: String,
    pub current_file: String,
    pub processed: usize,
    pub total: usize,
    pub percent: f64,
}

/// Normalized input item collected from disk before archiving.
#[derive(Debug, Clone)]
pub struct CollectedInput {
    pub archive_path: String,
    pub fs_path: PathBuf,
    pub is_dir: bool,
    pub modified: Option<String>,
}

/// Encode bytes into lowercase hexadecimal.
pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decode a hexadecimal string into raw bytes.
pub fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("Chaîne hexadécimale de longueur invalide.".into());
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for i in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[i..i + 2], 16)
            .map_err(|_| "Caractère hexadécimal invalide.".to_string())?;
        out.push(byte);
    }
    Ok(out)
}

/// Atomically replace `dest_path` with `temp_path` on Windows and Unix.
pub fn atomic_replace_file(temp_path: &Path, dest_path: &Path) -> Result<(), String> {
    if dest_path.exists() {
        fs::remove_file(dest_path)
            .map_err(|e| format!("Impossible de remplacer {} : {e}", dest_path.display()))?;
    }
    fs::rename(temp_path, dest_path)
        .map_err(|e| format!("Impossible de finaliser {} : {e}", dest_path.display()))
}

/// Normalize an archive-internal path with `/` separators and without leading or trailing slashes.
pub fn normalize_archive_path(raw: &str) -> String {
    raw.replace('\\', "/")
        .trim_matches('/')
        .split('/')
        .filter(|seg| !seg.is_empty() && *seg != ".")
        .collect::<Vec<_>>()
        .join("/")
}

/// Extract the final file or directory name from a normalized archive path.
pub fn entry_basename(normalized_path: &str) -> String {
    normalized_path
        .rsplit('/')
        .next()
        .unwrap_or(normalized_path)
        .to_string()
}

/// Join a relative archive path onto a destination directory while preventing path traversal.
pub fn safe_join(destination_dir: &Path, archive_entry_path: &str) -> Result<PathBuf, String> {
    let normalized = archive_entry_path.replace('\\', "/");
    let mut target = destination_dir.to_path_buf();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(part) => target.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "Chemin dangereux détecté dans l'archive (traversée bloquée) : {archive_entry_path}"
                ));
            }
        }
    }
    Ok(target)
}

/// Check whether an archive entry matches any user-selected path (exact file or folder subtree).
pub fn entry_matches_selection(entry_path: &str, selected: &Option<Vec<String>>) -> bool {
    let Some(list) = selected else {
        return true;
    };
    if list.is_empty() {
        return true;
    }
    let norm_entry = normalize_archive_path(entry_path);
    list.iter().any(|raw_sel| {
        let sel = normalize_archive_path(raw_sel);
        !sel.is_empty()
            && (norm_entry == sel || norm_entry.starts_with(&format!("{sel}/")))
    })
}

/// Format a `std::time::SystemTime` as `"YYYY-MM-DD HH:MM"`.
pub fn format_system_time(time: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = time.into();
    dt.format("%Y-%m-%d %H:%M").to_string()
}

const SMART_DEV_IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    "build",
    ".next",
    ".turbo",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    "coverage",
];

const SMART_DEV_IGNORED_FILES: &[&str] = &[".ds_store", "thumbs.db"];
const SMART_DEV_IGNORED_EXTS: &[&str] = &[".tmp", ".bak", ".swp", ".log"];

fn matches_custom_exclude(name_lower: &str, norm_rel_lower: &str, patterns: &[String]) -> bool {
    for raw in patterns {
        let pat = raw.trim().replace('\\', "/").to_lowercase();
        if pat.is_empty() {
            continue;
        }
        if let Some(suffix) = pat.strip_prefix('*') {
            if name_lower.ends_with(suffix) || norm_rel_lower.ends_with(suffix) {
                return true;
            }
        } else if let Some(prefix) = pat.strip_suffix('*') {
            if name_lower.starts_with(prefix) || norm_rel_lower.starts_with(prefix) {
                return true;
            }
        } else if name_lower == pat || norm_rel_lower.contains(&pat) {
            return true;
        }
    }
    false
}

fn should_exclude_entry(
    name: &str,
    rel_path: &str,
    is_dir: bool,
    smart_dev_ignore: bool,
    exclude_patterns: &[String],
) -> bool {
    let name_lower = name.to_lowercase();
    let rel_lower = rel_path.replace('\\', "/").to_lowercase();

    if smart_dev_ignore {
        if is_dir && SMART_DEV_IGNORED_DIRS.contains(&name_lower.as_str()) {
            return true;
        }
        if !is_dir {
            if SMART_DEV_IGNORED_FILES.contains(&name_lower.as_str()) {
                return true;
            }
            if SMART_DEV_IGNORED_EXTS
                .iter()
                .any(|ext| name_lower.ends_with(ext))
            {
                return true;
            }
        }
    }

    if !exclude_patterns.is_empty() && matches_custom_exclude(&name_lower, &rel_lower, exclude_patterns) {
        return true;
    }

    false
}

/// Walk all source paths under an optional `target_prefix` without Smart Dev or custom exclusions.
pub fn collect_input_items_with_prefix(
    source_paths: &[String],
    target_prefix: &str,
) -> Result<Vec<CollectedInput>, String> {
    collect_input_items_with_filtering(source_paths, target_prefix, false, &[])
}

/// Walk all source paths under an optional `target_prefix` while applying Smart Dev and custom exclusion filters.
pub fn collect_input_items_with_filtering(
    source_paths: &[String],
    target_prefix: &str,
    smart_dev_ignore: bool,
    exclude_patterns: &[String],
) -> Result<Vec<CollectedInput>, String> {
    if source_paths.is_empty() {
        return Err("Aucun fichier ou dossier sélectionné pour la compression.".into());
    }

    let clean_prefix = normalize_archive_path(target_prefix);
    let mut items = Vec::new();
    let mut seen = HashSet::new();

    for raw in source_paths {
        let src = PathBuf::from(raw);
        if !src.exists() {
            return Err(format!("Chemin introuvable : {raw}"));
        }

        let base_name = src
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "archive_root".to_string());

        let prefixed_base = if clean_prefix.is_empty() {
            base_name.clone()
        } else {
            format!("{clean_prefix}/{base_name}")
        };

        if src.is_file() {
            let norm = normalize_archive_path(&prefixed_base);
            if should_exclude_entry(&base_name, &norm, false, smart_dev_ignore, exclude_patterns) {
                continue;
            }
            if seen.insert(norm.clone()) {
                let modified = fs::metadata(&src)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(format_system_time);
                items.push(CollectedInput {
                    archive_path: norm,
                    fs_path: src,
                    is_dir: false,
                    modified,
                });
            }
            continue;
        }

        let walker = WalkDir::new(&src).follow_links(false).into_iter().filter_entry(|e| {
            let Ok(rel) = e.path().strip_prefix(&src) else {
                return true;
            };
            if rel.as_os_str().is_empty() {
                return true;
            }
            let entry_name = e.file_name().to_string_lossy();
            let rel_str = rel.to_string_lossy();
            !should_exclude_entry(
                &entry_name,
                &rel_str,
                e.file_type().is_dir(),
                smart_dev_ignore,
                exclude_patterns,
            )
        });

        for entry in walker {
            let entry = entry.map_err(|e| format!("Erreur lors du parcours de {raw} : {e}"))?;
            let path = entry.path();
            let rel = path
                .strip_prefix(&src)
                .map_err(|e| format!("Chemin relatif invalide : {e}"))?;

            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let combined = if rel_str.is_empty() {
                prefixed_base.clone()
            } else {
                format!("{prefixed_base}/{rel_str}")
            };
            let norm = normalize_archive_path(&combined);
            if norm.is_empty() || !seen.insert(norm.clone()) {
                continue;
            }

            let is_dir = entry.file_type().is_dir();
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(format_system_time);

            items.push(CollectedInput {
                archive_path: norm,
                fs_path: path.to_path_buf(),
                is_dir,
                modified,
            });
        }
    }

    if items.is_empty() {
        return Err("Aucun fichier exploitable trouvé dans la sélection (après filtres d'exclusion).".into());
    }

    Ok(items)
}

/// Ensure every ancestor directory exists as an explicit `ArchiveEntry` and compute summary totals.
pub fn finalize_entries(mut entries: Vec<ArchiveEntry>) -> (Vec<ArchiveEntry>, u64, u64, usize, usize) {
    let mut existing_dirs = HashSet::new();
    let mut seen_paths = HashSet::new();

    for entry in &mut entries {
        entry.path = normalize_archive_path(&entry.path);
        entry.name = entry_basename(&entry.path);
        if entry.is_dir {
            existing_dirs.insert(entry.path.clone());
        }
    }

    entries.retain(|e| !e.path.is_empty() && seen_paths.insert(e.path.clone()));

    let mut missing_dirs = BTreeSet::new();
    for entry in &entries {
        let mut current = entry.path.as_str();
        while let Some((parent, _)) = current.rsplit_once('/') {
            if !existing_dirs.contains(parent) {
                missing_dirs.insert(parent.to_string());
            }
            current = parent;
        }
    }

    for dir_path in missing_dirs {
        let name = entry_basename(&dir_path);
        entries.push(ArchiveEntry {
            path: dir_path,
            name,
            is_dir: true,
            size: 0,
            compressed_size: 0,
            compression_method: "dir".into(),
            crc32: None,
            modified: None,
            encrypted: false,
            deduplicated: false,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.path.to_lowercase().cmp(&b.path.to_lowercase()),
    });

    let mut total_uncompressed = 0u64;
    let mut total_compressed = 0u64;
    let mut file_count = 0usize;
    let mut dir_count = 0usize;

    for entry in &entries {
        if entry.is_dir {
            dir_count += 1;
        } else {
            file_count += 1;
            total_uncompressed = total_uncompressed.saturating_add(entry.size);
            total_compressed = total_compressed.saturating_add(entry.compressed_size);
        }
    }

    (entries, total_uncompressed, total_compressed, file_count, dir_count)
}
