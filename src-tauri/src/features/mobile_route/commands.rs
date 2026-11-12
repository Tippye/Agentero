use super::{MobileRouteSnapshot, MobileRouteStore, MobileWindowRoute};
use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use tauri::{State, WebviewWindow};

fn envelope(result: Result<MobileRouteSnapshot, AppError>) -> ApiResult<MobileRouteSnapshot> {
    match result {
        Ok(snapshot) => ApiResult::ok(snapshot),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn mobile_route_read(
    window: WebviewWindow,
    store: State<'_, MobileRouteStore>,
    vault_path: String,
) -> Result<ApiResult<MobileRouteSnapshot>, String> {
    let label = window.label().to_owned();
    let store = store.inner().clone();
    Ok(run_blocking(move || envelope(store.read(&label, &vault_path))).await)
}

#[tauri::command]
#[specta::specta]
pub async fn mobile_route_save(
    window: WebviewWindow,
    store: State<'_, MobileRouteStore>,
    vault_path: String,
    expected_revision: String,
    route: MobileWindowRoute,
) -> Result<ApiResult<MobileRouteSnapshot>, String> {
    let label = window.label().to_owned();
    let store = store.inner().clone();
    Ok(
        run_blocking(move || envelope(store.save(&label, &vault_path, &expected_revision, route)))
            .await,
    )
}
