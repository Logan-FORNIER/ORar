mod archive;
mod orar_format;
mod tools;
mod types;

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

use crate::types::{
    AppUpdateInfo, ArchiveDiffReport, ArchiveInfo, ArchiveMutationRequest, BatchOperationReport,
    BatchOperationRequest, BenchmarkResult, ContentSearchMatch, ConvertArchiveRequest,
    CreateArchiveRequest, DirectoryListing, EntryHashes, ExtractArchiveRequest, IntegrityReport,
    LaunchAction, PreviewFileResponse, ProgressPayload, RepairReport, SfxReport, SplitReport,
    StegoCreateRequest, StegoReport, UpdateInstallReport, WindowsIntegrationStatus,
};

fn emit_progress(app: &AppHandle, operation: &str, current_file: &str, processed: usize, total: usize) {
    let percent = if total == 0 {
        100.0
    } else {
        ((processed as f64 / total as f64) * 100.0).min(100.0)
    };
    let _ = app.emit(
        "orar://progress",
        ProgressPayload {
            operation: operation.to_string(),
            current_file: current_file.to_string(),
            processed,
            total,
            percent,
        },
    );
}

#[tauri::command]
fn inspect_archive(path: String, password: Option<String>) -> Result<ArchiveInfo, String> {
    archive::inspect_archive(&PathBuf::from(path), password.as_deref())
}

#[tauri::command]
async fn create_archive(app: AppHandle, req: CreateArchiveRequest) -> Result<ArchiveInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let split_sz = req.split_size_bytes;
        let info = archive::create_archive(&req, |file, processed, total| {
            emit_progress(&app, "compress", file, processed, total);
        })?;
        if let Some(bytes) = split_sz.filter(|&b| b >= 64 * 1024) {
            let _ = tools::split_archive(&PathBuf::from(&info.archive_path), bytes)?;
        }
        Ok(info)
    })
    .await
    .map_err(|e| format!("Erreur interne lors de la compression : {e}"))?
}

#[tauri::command]
async fn extract_archive(app: AppHandle, req: ExtractArchiveRequest) -> Result<String, String> {
    let dest = req.destination_dir.clone();
    let count = tauri::async_runtime::spawn_blocking(move || {
        archive::extract_archive(&req, |file, processed, total| {
            emit_progress(&app, "extract", file, processed, total);
        })
    })
    .await
    .map_err(|e| format!("Erreur interne lors de l'extraction : {e}"))??;

    Ok(format!("{count} fichier(s) extrait(s) vers {dest}"))
}

#[tauri::command]
fn preview_archive_entry(
    archive_path: String,
    entry_path: String,
    password: Option<String>,
) -> Result<PreviewFileResponse, String> {
    archive::preview_archive_entry(&PathBuf::from(archive_path), &entry_path, password.as_deref())
}

#[tauri::command]
async fn test_archive_integrity(
    app: AppHandle,
    archive_path: String,
    password: Option<String>,
) -> Result<IntegrityReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive::test_archive_integrity(
            &PathBuf::from(archive_path),
            password.as_deref(),
            |file, processed, total| {
                emit_progress(&app, "verify", file, processed, total);
            },
        )
    })
    .await
    .map_err(|e| format!("Erreur interne lors de la vérification : {e}"))?
}

#[tauri::command]
async fn mutate_archive(req: ArchiveMutationRequest) -> Result<ArchiveInfo, String> {
    tauri::async_runtime::spawn_blocking(move || archive::mutate_archive(&req))
        .await
        .map_err(|e| format!("Erreur interne lors de l'édition : {e}"))?
}

#[tauri::command]
async fn compute_entry_hashes(
    archive_path: String,
    entry_path: String,
    password: Option<String>,
) -> Result<EntryHashes, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tools::compute_entry_hashes(&PathBuf::from(archive_path), &entry_path, password.as_deref())
    })
    .await
    .map_err(|e| format!("Erreur calcul empreintes : {e}"))?
}

#[tauri::command]
async fn search_in_archive_contents(
    app: AppHandle,
    archive_path: String,
    query: String,
    case_sensitive: bool,
    password: Option<String>,
) -> Result<Vec<ContentSearchMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tools::search_in_archive_contents(
            &PathBuf::from(archive_path),
            &query,
            case_sensitive,
            password.as_deref(),
            |file, processed, total| {
                emit_progress(&app, "search", file, processed, total);
            },
        )
    })
    .await
    .map_err(|e| format!("Erreur recherche plein texte : {e}"))?
}

#[tauri::command]
async fn open_entry_externally(
    archive_path: String,
    entry_path: String,
    password: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tools::open_entry_externally(&PathBuf::from(archive_path), &entry_path, password.as_deref())
    })
    .await
    .map_err(|e| format!("Erreur ouverture externe : {e}"))?
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    tools::reveal_in_explorer(&PathBuf::from(path))
}

#[tauri::command]
async fn convert_archive_format(
    app: AppHandle,
    req: ConvertArchiveRequest,
) -> Result<ArchiveInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tools::convert_archive_format(&req, |file, processed, total| {
            emit_progress(&app, "convert", file, processed, total);
        })
    })
    .await
    .map_err(|e| format!("Erreur conversion archive : {e}"))?
}

#[tauri::command]
async fn repair_archive(
    archive_path: String,
    password: Option<String>,
) -> Result<RepairReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive::repair_archive(&PathBuf::from(archive_path), password.as_deref())
    })
    .await
    .map_err(|e| format!("Erreur réparation archive : {e}"))?
}

#[tauri::command]
async fn split_archive(archive_path: String, volume_size_bytes: u64) -> Result<SplitReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tools::split_archive(&PathBuf::from(archive_path), volume_size_bytes)
    })
    .await
    .map_err(|e| format!("Erreur découpage archive : {e}"))?
}

#[tauri::command]
async fn join_split_archive(
    first_part_path: String,
    output_path: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out_pb = output_path.map(PathBuf::from);
        tools::join_split_archive(&PathBuf::from(first_part_path), out_pb.as_deref())
    })
    .await
    .map_err(|e| format!("Erreur assemblage volumes : {e}"))?
}

#[tauri::command]
async fn run_compression_benchmark() -> Result<Vec<BenchmarkResult>, String> {
    tauri::async_runtime::spawn_blocking(tools::run_compression_benchmark)
        .await
        .map_err(|e| format!("Erreur benchmark : {e}"))?
}

#[tauri::command]
fn get_windows_integration_status() -> WindowsIntegrationStatus {
    tools::get_windows_integration_status()
}

#[tauri::command]
fn set_windows_integration(
    associate_orar: bool,
    context_menu: bool,
) -> Result<WindowsIntegrationStatus, String> {
    tools::set_windows_integration(associate_orar, context_menu)
}

#[tauri::command]
fn get_launch_args() -> Option<String> {
    tools::get_launch_args()
}

#[tauri::command]
fn get_launch_action() -> Option<LaunchAction> {
    tools::get_launch_action()
}

#[tauri::command]
fn list_directory(dir_path: Option<String>) -> Result<DirectoryListing, String> {
    archive::list_directory(dir_path)
}

#[tauri::command]
async fn compare_archives(
    left_path: String,
    right_path: String,
    left_password: Option<String>,
    right_password: Option<String>,
) -> Result<ArchiveDiffReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tools::compare_archives(
            &PathBuf::from(left_path),
            &PathBuf::from(right_path),
            left_password.as_deref(),
            right_password.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Erreur comparaison d'archives : {e}"))?
}

#[tauri::command]
async fn run_batch_operation(
    app: AppHandle,
    req: BatchOperationRequest,
) -> Result<BatchOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tools::run_batch_operation(&req, |file, processed, total| {
            emit_progress(&app, "batch", file, processed, total);
        })
    })
    .await
    .map_err(|e| format!("Erreur opération par lots : {e}"))?
}

#[tauri::command]
async fn create_stego_archive(req: StegoCreateRequest) -> Result<StegoReport, String> {
    tauri::async_runtime::spawn_blocking(move || tools::create_stego_archive(&req))
        .await
        .map_err(|e| format!("Erreur camouflage Stego-ORar : {e}"))?
}

#[tauri::command]
async fn extract_stego_archive(
    stego_png_path: String,
    output_orar_path: Option<String>,
    password: Option<String>,
) -> Result<(StegoReport, ArchiveInfo), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out_pb = output_orar_path.map(PathBuf::from);
        tools::extract_stego_archive(
            &PathBuf::from(stego_png_path),
            out_pb.as_deref(),
            password.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Erreur extraction Stego-ORar : {e}"))?
}

#[tauri::command]
async fn create_sfx_bundle(
    archive_path: String,
    output_sfx_path: Option<String>,
    password: Option<String>,
) -> Result<SfxReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out_pb = output_sfx_path.map(PathBuf::from);
        tools::create_sfx_bundle(
            &PathBuf::from(archive_path),
            out_pb.as_deref(),
            password.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Erreur génération paquet SFX : {e}"))?
}

#[tauri::command]
async fn create_demo_archive(app: AppHandle) -> Result<ArchiveInfo, String> {
    let base_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Impossible de localiser le dossier de données ORar : {e}"))?;

    let demo_src = base_dir.join("demo_workspace").join("ORar_Starter_Pack");
    let docs_dir = demo_src.join("Documentation");
    let assets_dir = demo_src.join("Donnees");

    fs::create_dir_all(&docs_dir)
        .map_err(|e| format!("Impossible de préparer le dossier démo : {e}"))?;
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Impossible de préparer le dossier démo : {e}"))?;

    fs::write(
        demo_src.join("Bienvenue_dans_ORar.txt"),
        "Bienvenue dans ORar Édition Pro !\n\n\
         Ce fichier est stocké dans une archive signature .orar (ORar Container v1).\n\
         Points forts d'ORar :\n\
         - En-tête binaire magique ORAR\\x01\\x00 (34 octets)\n\
         - Index JSON compressé en accès direct O(1)\n\
         - Chiffrement optionnel AES-256-GCM + PBKDF2-HMAC-SHA256 (fichiers + noms)\n\
         - Édition directe (ajout, suppression, renommage, nouveaux dossiers)\n\
         - Recherche plein texte dans les fichiers, multi-hash, conversion, découpage & benchmark\n",
    )
    .map_err(|e| format!("Erreur d'écriture démo : {e}"))?;

    fs::write(
        docs_dir.join("Architecture.json"),
        serde_json::json!({
            "application": "ORar",
            "formatSignature": ".orar",
            "version": 1,
            "chiffrement": "AES-256-GCM + PBKDF2-HMAC-SHA256",
            "compression": ["store", "deflate-1..9"],
            "integrite": ["CRC32", "MD5", "SHA-1", "SHA-256"],
            "formatsSupportes": [".orar", ".zip", ".7z", ".rar", ".tar.gz", ".tar.zst", ".tar.xz", ".tar"]
        })
        .to_string(),
    )
    .map_err(|e| format!("Erreur d'écriture démo : {e}"))?;

    let bmp_bytes: Vec<u8> = vec![
        0x42, 0x4D, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00,
        0x28, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x18,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x30, 0x00, 0x00, 0x00, 0x13, 0x0B, 0x00, 0x00, 0x13, 0x0B,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x0B, 0x9E, 0xF5, 0xF1, 0x66, 0x63, 0x0B, 0x9E, 0xF5, 0xF1, 0x66, 0x63,
        0xF1, 0x66, 0x63, 0x0B, 0x9E, 0xF5, 0xF1, 0x66, 0x63, 0x0B, 0x9E, 0xF5,
        0x0B, 0x9E, 0xF5, 0xF1, 0x66, 0x63, 0x0B, 0x9E, 0xF5, 0xF1, 0x66, 0x63,
        0xF1, 0x66, 0x63, 0x0B, 0x9E, 0xF5, 0xF1, 0x66, 0x63, 0x0B, 0x9E, 0xF5,
    ];
    fs::write(assets_dir.join("apercu_icone.bmp"), &bmp_bytes)
        .map_err(|e| format!("Erreur d'écriture image démo : {e}"))?;

    let mut binary_sample = Vec::with_capacity(128);
    binary_sample.extend_from_slice(b"ORAR-SAMPLE-BIN\x00");
    for i in 0u8..112u8 {
        binary_sample.push(i.wrapping_mul(17).wrapping_add(5));
    }
    fs::write(assets_dir.join("donnees_brutes.bin"), &binary_sample)
        .map_err(|e| format!("Erreur d'écriture binaire démo : {e}"))?;

    // Include an identical copy to showcase .orar hash deduplication in action
    let copies_dir = assets_dir.join("Sauvegarde");
    fs::create_dir_all(&copies_dir)
        .map_err(|e| format!("Erreur préparation dossier copie démo : {e}"))?;
    fs::write(copies_dir.join("donnees_brutes_copie.bin"), &binary_sample)
        .map_err(|e| format!("Erreur d'écriture doublon démo : {e}"))?;

    let output_orar = base_dir.join("ORar_Demo.orar");
    let req = CreateArchiveRequest {
        source_paths: vec![demo_src.to_string_lossy().to_string()],
        output_path: output_orar.to_string_lossy().to_string(),
        format: "orar".into(),
        compression_level: 6,
        comment: Some(
            "# Pack Découverte ORar Pro\n- Format **signature `.orar`** avec accès $O(1)$, **déduplication** automatique et chiffrement **AES-256-GCM**\n- Sélectionnez `Bienvenue_dans_ORar.txt` et testez **Éditer à chaud (`Ctrl+S`)**"
                .into(),
        ),
        password: None,
        encrypt_filenames: false,
        split_size_bytes: None,
        smart_dev_ignore: false,
        exclude_patterns: vec![],
    };

    tauri::async_runtime::spawn_blocking(move || {
        archive::create_archive(&req, |file, processed, total| {
            emit_progress(&app, "compress", file, processed, total);
        })
    })
    .await
    .map_err(|e| format!("Erreur interne démo : {e}"))?
}

#[tauri::command]
async fn check_app_update() -> Result<AppUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| tools::check_app_update(None))
        .await
        .map_err(|e| format!("Erreur vérification mise à jour : {e}"))?
}

#[tauri::command]
async fn download_and_install_update(
    installer_url: String,
    installer_name: Option<String>,
) -> Result<UpdateInstallReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tools::download_and_install_update(&installer_url, installer_name.as_deref())
    })
    .await
    .map_err(|e| format!("Erreur téléchargement mise à jour : {e}"))?
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    tools::open_external_url(&url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            inspect_archive,
            create_archive,
            extract_archive,
            preview_archive_entry,
            test_archive_integrity,
            mutate_archive,
            compute_entry_hashes,
            search_in_archive_contents,
            open_entry_externally,
            reveal_in_explorer,
            convert_archive_format,
            repair_archive,
            split_archive,
            join_split_archive,
            run_compression_benchmark,
            get_windows_integration_status,
            set_windows_integration,
            get_launch_args,
            get_launch_action,
            list_directory,
            create_demo_archive,
            compare_archives,
            run_batch_operation,
            create_stego_archive,
            extract_stego_archive,
            create_sfx_bundle,
            check_app_update,
            download_and_install_update,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running ORar");
}
