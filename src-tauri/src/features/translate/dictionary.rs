//! Local dictionary: no network, provider credentials, or Vault dependency.
use crate::core::error::{map_err, ApiResult, AppError};
use agentero_core::features::translate::lexicon::{self, DictionaryEntry};
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn dictionary_lookup(
    app: AppHandle,
    text: String,
    target_lang: String,
) -> ApiResult<Vec<DictionaryEntry>> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("dictionary/lexicon.sqlite"));
    }
    if let Ok(dir) = app.path().app_data_dir() {
        candidates.push(dir.join("dictionary/lexicon.sqlite"));
    }
    let path = if cfg!(debug_assertions) && !candidates.iter().any(|p| p.exists()) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dictionary/lexicon.sqlite")
    } else {
        match candidates.into_iter().find(|path| path.is_file()) {
            Some(path) => path,
            // Android APK assets resolve to an asset:// URI, not a file SQLite
            // can open. Until the Host materializes them into app data, the
            // lookup is a miss and the caller falls back to a provider.
            None => {
                return map_err(AppError::domain(
                    "dictionary_unavailable",
                    "The bundled dictionary is not available on this platform",
                ))
            }
        }
    };
    match tauri::async_runtime::spawn_blocking(move || lexicon::lookup(&path, &text, &target_lang))
        .await
    {
        Ok(Ok(entries)) => ApiResult::ok(entries),
        Ok(Err(e)) => map_err(e),
        Err(e) => map_err(AppError::message(e.to_string())),
    }
}
