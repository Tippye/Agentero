//! Local dictionary: no network, provider credentials, or Vault dependency.
use crate::core::error::{map_err, ApiResult, AppError};
use agentero_core::features::translate::lexicon::{self, DictionaryEntry};
use tauri::{AppHandle, Manager};

/// Android bundle assets resolve to `asset://localhost/` and live inside the
/// APK, so SQLite cannot open them directly. Ask the native adapter for a
/// versioned private copy and reuse it for the process lifetime.
#[cfg(target_os = "android")]
fn android_lexicon_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    static CACHE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    if let Some(path) = CACHE.get() {
        return Some(path.clone());
    }
    let background =
        app.try_state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>()?;
    let path = background.ensure_dictionary().ok()?;
    if !path.is_file() {
        return None;
    }
    let _ = CACHE.set(path.clone());
    Some(path)
}

#[tauri::command]
#[specta::specta]
pub async fn dictionary_lookup(
    app: AppHandle,
    text: String,
    target_lang: String,
) -> ApiResult<Vec<DictionaryEntry>> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "android")]
    if let Some(path) = android_lexicon_path(&app) {
        candidates.push(path);
    }
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
            // A missing asset or failed extraction is a lookup miss; the
            // caller then falls back to a provider instead of failing.
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
