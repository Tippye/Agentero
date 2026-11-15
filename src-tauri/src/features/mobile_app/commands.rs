use crate::core::error::{map_err, ApiResult, AppError};

/// Save-and-restart helper for temporary tuning settings.
///
/// The Web layer persists settings first, then calls this command. Android
/// queues a fresh launch intent and kills the current process; the new
/// activity boots with the updated file. Desktop never registers this command.
#[tauri::command]
pub async fn mobile_restart_app(
    app: tauri::AppHandle,
) -> Result<ApiResult<()>, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let native = app
            .try_state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>()
            .ok_or_else(|| "Native restart bridge is unavailable".to_string())?;
        return match native.restart_app() {
            Ok(()) => Ok(ApiResult::ok(())),
            Err(message) => Ok(map_err(AppError::domain("restart_unavailable", message))),
        };
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(map_err(AppError::domain(
            "restart_unavailable",
            "Native restart is only implemented on Android",
        )))
    }
}
