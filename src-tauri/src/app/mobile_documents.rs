//! The OS event is the only source of iOS document URLs. Work stays native.
use crate::features::paper::import::ios_inbox::{open_inbox_document, IosInbox};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

pub(super) fn receive_opened(app: &AppHandle, urls: &[url::Url]) {
    // Reserve before scheduling local filesystem I/O: one opening or ready file,
    // even while the frontend has not mounted or a Vault has not been selected.
    if urls.len() != 1 || urls[0].scheme() != "file" || urls[0].as_str().len() > 32768 {
        return;
    }
    let Some(inbox) = app.try_state::<Arc<IosInbox>>() else {
        return;
    };
    let Some(reservation) = inbox.reserve() else {
        return;
    };
    let app = app.clone();
    let urls = urls.to_vec();
    drop(tauri::async_runtime::spawn_blocking(move || {
        let result = match app.path().document_dir() {
            Ok(documents) => open_inbox_document(&documents, &urls),
            Err(_) => Some(Err(())),
        };
        if reservation.finish(result) {
            let _ = app.emit_to("main", "mobile:external-pdf-pending", ());
        }
    }));
}
