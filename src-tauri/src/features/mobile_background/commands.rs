use super::{BackgroundSettingsTarget, BackgroundState, MobileBackgroundService};
use crate::core::error::{map_err, ApiResult, AppError};
use std::sync::Arc;
use tauri::State;

fn envelope(value: Result<BackgroundState, AppError>) -> ApiResult<BackgroundState> {
    match value {
        Ok(state) => ApiResult::ok(state),
        Err(error) => map_err(error),
    }
}

/// Read OS background capabilities and observations without requesting permission.
#[tauri::command]
#[specta::specta]
pub async fn mobile_background_get_state(
    service: State<'_, Arc<MobileBackgroundService>>,
) -> Result<ApiResult<BackgroundState>, String> {
    Ok(envelope(service.state().await))
}

/// Change the user's Android background preference; unsupported platforms refuse enabling.
#[tauri::command]
#[specta::specta]
pub async fn mobile_background_configure(
    service: State<'_, Arc<MobileBackgroundService>>,
    enabled: bool,
) -> Result<ApiResult<BackgroundState>, String> {
    Ok(envelope(service.configure(enabled).await))
}

/// Explicit foreground notification request; never called during application load.
#[tauri::command]
#[specta::specta]
pub async fn mobile_background_request_notifications(
    service: State<'_, Arc<MobileBackgroundService>>,
) -> Result<ApiResult<BackgroundState>, String> {
    Ok(envelope(service.request_notifications().await))
}

/// Open a system settings page after an explicit user action.
#[tauri::command]
#[specta::specta]
pub async fn mobile_background_open_settings(
    service: State<'_, Arc<MobileBackgroundService>>,
    target: BackgroundSettingsTarget,
) -> Result<ApiResult<BackgroundState>, String> {
    Ok(envelope(service.open_settings(target).await))
}
