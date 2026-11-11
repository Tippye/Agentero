//! Native ink commands: private replica identity and Rust-owned edit revisions.
use crate::core::blocking::run_blocking;
use crate::core::error::{ApiResult, AppError};
use agentero_core::features::pdf::ink_store::{self, InkEdit, InkPageSnapshot};
use serde::Deserialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkReadArgs {
    pub vault_path: String,
    pub paper_folder: String,
    pub page: u32,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkApplyArgs {
    pub vault_path: String,
    pub paper_folder: String,
    pub page: u32,
    pub expected_revision: Option<String>,
    pub operations: Vec<InkEdit>,
}

fn checked_vault(vault_path: &str, private_vault: Option<&Path>) -> Result<PathBuf, AppError> {
    let path = Path::new(vault_path);
    if vault_path.len() > 4096 || !path.is_absolute() {
        return Err(AppError::domain(
            "ink_invalid",
            "Ink requires a local absolute Vault path",
        ));
    }
    let root = fs::canonicalize(path)?;
    if !root.is_dir() {
        return Err(AppError::domain("ink_invalid", "Invalid Vault directory"));
    }
    if let Some(private) = private_vault {
        if root != fs::canonicalize(private)? {
            return Err(AppError::domain(
                "ink_private_vault_required",
                "Tablet ink requires the app private Vault",
            ));
        }
    }
    Ok(root)
}

fn vault_root(app: &AppHandle, path: &str) -> Result<PathBuf, AppError> {
    #[cfg(mobile)]
    let private = Some(
        app.path()
            .app_data_dir()
            .map_err(|e| AppError::message(e.to_string()))?
            .join("Vault"),
    );
    #[cfg(not(mobile))]
    let private: Option<PathBuf> = {
        let _ = app;
        None
    };
    checked_vault(path, private.as_deref())
}

fn read_actor(path: &Path) -> Result<Option<Uuid>, AppError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err(AppError::domain(
                "ink_actor_invalid",
                "Invalid ink replica identity file",
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let mut raw = String::new();
    fs::File::open(path)?.take(128).read_to_string(&mut raw)?;
    let actor = raw
        .strip_suffix('\n')
        .and_then(|s| Uuid::parse_str(s).ok())
        .filter(|id| !id.is_nil() && raw == format!("{id}\n"))
        .ok_or_else(|| {
            AppError::domain(
                "ink_actor_invalid",
                "Invalid ink replica identity; repair explicitly before editing",
            )
        })?;
    Ok(Some(actor))
}

/// Atomic no-clobber publication resolves first-launch races across processes,
/// without rotating invalid identities or treating storage errors as absence.
fn load_or_create_actor(directory: &Path) -> Result<Uuid, AppError> {
    load_or_create_actor_with(directory, sync_actor_directories)
}

fn actor_sync_error(_: std::io::Error) -> AppError {
    AppError::domain(
        "ink_unavailable",
        "Ink replica identity may already be stored; retry loading it before editing",
    )
}

fn sync_actor_directories(directory: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    for parent in directory.ancestors().take(3) {
        fs::File::open(parent)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

fn load_or_create_actor_with(
    directory: &Path,
    sync_directories: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<Uuid, AppError> {
    match fs::symlink_metadata(directory) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(AppError::domain(
                "ink_actor_invalid",
                "Invalid ink identity directory",
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::create_dir_all(directory)?,
        Err(e) => return Err(e.into()),
    }
    let path = directory.join("replica-id");
    if let Some(actor) = read_actor(&path)? {
        // Also finish a prior publication whose directory fsync was uncertain.
        sync_directories(directory).map_err(actor_sync_error)?;
        return Ok(actor);
    }
    let actor = Uuid::new_v4();
    let mut staged = tempfile::Builder::new()
        .prefix(".ink-actor-")
        .suffix(".tmp")
        .tempfile_in(directory)?;
    staged.write_all(format!("{actor}\n").as_bytes())?;
    staged.as_file().sync_all()?;
    let published = match staged.persist_noclobber(&path) {
        Ok(_) => Ok(actor),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => read_actor(&path)?
            .ok_or_else(|| {
                AppError::domain(
                    "ink_actor_invalid",
                    "Ink identity disappeared during initialization",
                )
            }),
        Err(error) => Err(error.error.into()),
    }?;
    // The no-clobber link already exists; a sync failure must retain it and
    // surface uncertainty, never remove it or generate a replacement actor.
    sync_directories(directory).map_err(actor_sync_error)?;
    Ok(published)
}

fn actor_for_vault(app: &AppHandle, vault: &Path) -> Result<Uuid, AppError> {
    let config = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::message(e.to_string()))?;
    actor_at_config(&config, vault)
}

fn actor_at_config(config: &Path, vault: &Path) -> Result<Uuid, AppError> {
    let vault = fs::canonicalize(vault)?;
    fs::create_dir_all(config)?;
    let config = fs::canonicalize(config)?;
    let directory = config.join("ink");
    // Resolve existing final components, and reject links before initialization.
    // A missing component is joined only beneath its canonical existing parent.
    let mut resolved = config.clone();
    for name in ["ink", "replica-id"] {
        resolved.push(name);
        match fs::symlink_metadata(&resolved) {
            Ok(meta)
                if meta.file_type().is_symlink()
                    || (name == "ink" && !meta.is_dir())
                    || (name == "replica-id" && !meta.is_file()) =>
            {
                return Err(AppError::domain(
                    "ink_actor_invalid",
                    "Invalid ink identity path",
                ));
            }
            Ok(_) => resolved = fs::canonicalize(&resolved)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if resolved.starts_with(&vault) {
            return Err(AppError::domain(
                "ink_actor_invalid",
                "Ink identity must be stored outside the Vault",
            ));
        }
    }
    if config.starts_with(&vault) {
        return Err(AppError::domain(
            "ink_actor_invalid",
            "Ink identity must be stored outside the Vault",
        ));
    }
    load_or_create_actor(&directory)
}

struct CancelBeforeAdmission(Arc<AtomicBool>);
impl Drop for CancelBeforeAdmission {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Read a validated page and the hash of the same exact on-disk bytes.
#[tauri::command]
#[specta::specta]
pub async fn pdf_read_ink(
    app: AppHandle,
    args: InkReadArgs,
) -> Result<ApiResult<InkPageSnapshot>, String> {
    Ok(run_blocking(move || {
        let result = vault_root(&app, &args.vault_path)
            .and_then(|vault| ink_store::read_page(&vault, &args.paper_folder, args.page));
        match result {
            Ok(snapshot) => ApiResult::ok(snapshot),
            Err(error) => ApiResult::err(error),
        }
    })
    .await)
}

/// Apply drafts to the exact page baseline; native code assigns all revisions.
#[tauri::command]
#[specta::specta]
pub async fn pdf_apply_ink(
    app: AppHandle,
    args: InkApplyArgs,
) -> Result<ApiResult<InkPageSnapshot>, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = CancelBeforeAdmission(Arc::clone(&cancelled));
    Ok(run_blocking(move || {
        let result = (|| {
            let vault = vault_root(&app, &args.vault_path)?;
            let actor = actor_for_vault(&app, &vault)?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| {
                    AppError::domain("ink_invalid", "System clock is before the Unix epoch")
                })?;
            let now_ms = u64::try_from(now.as_millis())
                .map_err(|_| AppError::domain("ink_invalid", "System clock overflow"))?;
            let saved = ink_store::apply_drafts_checked(
                &vault,
                &args.paper_folder,
                args.page,
                args.expected_revision.as_deref(),
                actor,
                now_ms,
                &args.operations,
                || {
                    if cancelled.load(Ordering::Acquire) {
                        Err(AppError::domain(
                            "ink_cancelled",
                            "Ink save cancelled before publication",
                        ))
                    } else {
                        Ok(())
                    }
                },
            )?;
            // The store has released the shared file mutation lane here.
            let path = vault
                .join(&args.paper_folder)
                .join("marks")
                .join("ink")
                .join(format!("p{}.json", args.page));
            app.state::<crate::integration::sync::SyncService>()
                .notify_path_changed(&app, &path);
            Ok::<_, AppError>(saved)
        })();
        match result {
            Ok(snapshot) => ApiResult::ok(snapshot),
            Err(error) => ApiResult::err(error),
        }
    })
    .await)
}

#[cfg(test)]
#[path = "ink_tests.rs"]
mod tests;
