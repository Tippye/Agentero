//! Tauri FS plugin scope grants for the active local Vault.

use crate::app::command_util::vault_path_arg;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::log_util::{trunc, OpTimer};
use tauri::{AppHandle, Runtime};
use tauri_plugin_fs::FsExt;

/// Keep API receipts and signed upload credentials out of renderer file access.
/// Exact ancestor denies also stop moving/removing an allowed parent to bypass
/// the recursive journal deny. `forbid_file` intentionally adds only the exact
/// path pattern; `forbid_directory(false)` would deny its children as well.
pub(crate) fn protect_hosted_storage<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let root = crate::core::paths::agentero_data_dir().join("hosted-extractions");
    let scope = app.fs_scope();
    scope.forbid_directory(&root, true)?;
    for ancestor in root.ancestors().skip(1) {
        scope.forbid_file(ancestor)?;
    }
    Ok(())
}

/// Extend the fs-plugin scope so the renderer can read/write this vault dir.
///
/// The dialog plugin grants runtime scope for a picked folder, but that grant
/// is not persisted. On startup restore a vault located outside the static
/// scope (`$HOME/**`, `$DOCUMENT/**`, …) would otherwise fail every fs-plugin
/// call with "forbidden path" until the user re-picks it. Called whenever a
/// local vault becomes active, before the file tree loads. Idempotent.
#[tauri::command]
#[specta::specta]
pub fn vault_allow_fs_scope<R: Runtime>(app: AppHandle<R>, path: String) -> ApiResult<()> {
    let op = OpTimer::start_with(
        "vault_allow_fs_scope",
        format!("path={}", trunc(&path, 200)),
    );
    let p = match vault_path_arg(&path) {
        Ok(p) => p,
        Err(err) => {
            op.finish_err(&err);
            return map_err(err);
        }
    };
    #[cfg(mobile)]
    {
        use tauri::Manager;
        let private_path = (|| -> Result<bool, Box<dyn std::error::Error>> {
            let private = app.path().app_data_dir()?.join("Vault");
            Ok(crate::features::paper::mobile::checked_vault(&path, Some(&private)).is_ok())
        })();
        if !matches!(private_path, Ok(true)) {
            let err =
                AppError::message("Mobile Vault access must stay in application-private storage");
            op.finish_err(&err);
            return map_err(err);
        }
    }
    match app.fs_scope().allow_directory(&p, true) {
        Ok(()) => op.finish_result(Ok(())),
        Err(e) => {
            let err = AppError::message(format!("allow fs scope failed: {e}"));
            op.finish_err(&err);
            map_err(err)
        }
    }
}
