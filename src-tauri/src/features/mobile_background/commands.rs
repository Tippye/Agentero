use super::{BackgroundSettingsTarget, BackgroundState, MobileBackgroundService};
use crate::core::error::{map_err, ApiResult, AppError};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use tauri_plugin_agentero_mobile::BackgroundPlatform;

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

/// Lease handed to a WebView-owned run. `hidden_allowed` reports whether the OS
/// carries this process while the page is hidden (Android + user-enabled
/// dataSync service); the JS gate only pauses when it does not.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MobileBackgroundTransferLease {
    pub lease_id: Option<u64>,
    pub hidden_allowed: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn mobile_background_begin_transfer(
    service: State<'_, Arc<MobileBackgroundService>>,
) -> Result<ApiResult<MobileBackgroundTransferLease>, String> {
    let hidden_allowed = match service.state().await {
        Ok(state) => {
            state.platform == BackgroundPlatform::Android
                && state.enabled
                && state.notifications_enabled
        }
        // The run still works in the foreground; only the hidden continuation
        // needs a confirmed native carrier.
        Err(_) => false,
    };
    match service.begin_transfer().await {
        Ok(lease_id) => Ok(ApiResult::ok(MobileBackgroundTransferLease {
            lease_id: Some(lease_id),
            hidden_allowed,
        })),
        Err(error) => Ok(map_err(error)),
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MobileBackgroundTransferEndArgs {
    pub lease_id: u64,
}

#[tauri::command]
#[specta::specta]
pub async fn mobile_background_end_transfer(
    service: State<'_, Arc<MobileBackgroundService>>,
    args: MobileBackgroundTransferEndArgs,
) -> Result<ApiResult<()>, String> {
    service.end_transfer(args.lease_id);
    Ok(ApiResult::ok(()))
}
