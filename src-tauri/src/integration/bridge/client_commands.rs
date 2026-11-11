use super::{BridgeClientController, BridgeClientStatus};
use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::json::JsonValue;
use serde::Deserialize;
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConnectArgs {
    pub offer_url: String,
    pub device_name: String,
}

#[tauri::command]
#[specta::specta]
pub fn bridge_client_connect(
    app: AppHandle,
    controller: State<'_, BridgeClientController>,
    args: BridgeConnectArgs,
) -> ApiResult<BridgeClientStatus> {
    match controller.connect(app, args.offer_url, args.device_name) {
        Ok(status) => ApiResult::ok(status),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
#[specta::specta]
pub fn bridge_client_resume(
    app: AppHandle,
    controller: State<'_, BridgeClientController>,
) -> ApiResult<BridgeClientStatus> {
    match controller.resume(app) {
        Ok(status) => ApiResult::ok(status),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
#[specta::specta]
pub fn bridge_client_disconnect(controller: State<'_, BridgeClientController>) -> ApiResult<()> {
    match controller.disconnect() {
        Ok(()) => ApiResult::ok(()),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
#[specta::specta]
pub fn bridge_client_status(
    controller: State<'_, BridgeClientController>,
) -> ApiResult<BridgeClientStatus> {
    match controller.status() {
        Ok(status) => ApiResult::ok(status),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn bridge_client_rpc(
    controller: State<'_, BridgeClientController>,
    method: String,
    params: JsonValue,
) -> Result<ApiResult<JsonValue>, String> {
    if method.trim().is_empty() {
        return Ok(map_err(AppError::message("Bridge RPC method is required")));
    }
    match controller.rpc(method, params.0).await {
        Ok(data) => Ok(ApiResult::ok(JsonValue(data))),
        Err(error) => Ok(map_err(error)),
    }
}
