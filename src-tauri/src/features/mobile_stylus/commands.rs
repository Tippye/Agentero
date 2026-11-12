use super::{MobileStylusService, StylusState};
use crate::core::error::{ApiResult, AppError};
use std::sync::Arc;
use tauri::{State, WebviewWindow};

fn envelope(result: Result<StylusState, AppError>) -> ApiResult<StylusState> {
    match result {
        Ok(state) => ApiResult::ok(state),
        Err(error) => ApiResult::err(error),
    }
}

/// Read native adapter capabilities and provenance-tagged observations.
#[tauri::command]
#[specta::specta]
pub async fn mobile_stylus_get_state(
    window: WebviewWindow,
    service: State<'_, Arc<MobileStylusService>>,
) -> Result<ApiResult<StylusState>, String> {
    let _ = window;
    Ok(envelope(service.state().await))
}

/// Admit one current visible PDF target; stale token cleanup cannot replace another target.
#[tauri::command]
#[specta::specta]
pub async fn mobile_stylus_set_target(
    window: WebviewWindow,
    service: State<'_, Arc<MobileStylusService>>,
    token: String,
    active: bool,
) -> Result<ApiResult<StylusState>, String> {
    Ok(envelope(
        service.inner().set_target(&window, token, active).await,
    ))
}
