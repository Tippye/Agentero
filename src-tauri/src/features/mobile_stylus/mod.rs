//! Native stylus observations are routed only to an admitted, focused PDF target.
pub mod commands;
mod slot;
use crate::core::error::AppError;
#[cfg(mobile)]
use futures_util::{
    future::{BoxFuture, Shared},
    FutureExt,
};
use slot::{complete_update, TargetSlot};
#[cfg(mobile)]
use std::sync::OnceLock;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
#[cfg(mobile)]
use tauri::Emitter;
use tauri::Manager;
#[cfg(mobile)]
use tauri_plugin_agentero_mobile::NativeStylusEvent;
pub use tauri_plugin_agentero_mobile::{
    StylusAction, StylusActionEvent, StylusAdapterCapability, StylusPresence, StylusPresenceEvent,
    StylusSource, StylusState,
};

static GENERATION: AtomicU64 = AtomicU64::new(0);

pub struct MobileStylusService {
    app: tauri::AppHandle,
    target: Mutex<TargetSlot>,
    #[cfg(mobile)]
    listener: OnceLock<Shared<BoxFuture<'static, Result<(), String>>>>,
}

fn unavailable(message: impl Into<String>) -> AppError {
    AppError::domain("stylus_unavailable", message)
}

fn missing_native_state() -> Result<StylusState, AppError> {
    #[cfg(desktop)]
    {
        Ok(StylusState::default())
    }
    #[cfg(mobile)]
    {
        Err(unavailable("Native stylus plugin is unavailable"))
    }
}

async fn optional_native_call(
    operation: Option<impl std::future::Future<Output = Result<StylusState, String>>>,
) -> Result<StylusState, AppError> {
    match operation {
        Some(operation) => operation.await.map_err(unavailable),
        None => missing_native_state(),
    }
}

fn window_eligible(window: &tauri::WebviewWindow) -> bool {
    #[cfg(desktop)]
    {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    }
    #[cfg(mobile)]
    {
        // Pinned Tao mobile focus getters are not portable. The native ACK and
        // callbacks validate attached focused WebView / key WKWebView directly.
        let _ = window;
        true
    }
}

impl MobileStylusService {
    #[cfg(mobile)]
    async fn ensure_listener(self: &Arc<Self>) -> Result<(), AppError> {
        let pending = self.listener.get_or_init(|| {
            let app = self.app.clone();
            let owner = Arc::downgrade(self);
            let task = tauri::async_runtime::spawn(async move {
                app.try_state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>()
                    .ok_or_else(|| "Native stylus plugin is unavailable".to_string())?
                    .on_stylus_event(move |event| {
                        if let Some(service) = owner.upgrade() {
                            service.route(event);
                        }
                    })
                    .await
            });
            async move { task.await.map_err(|e| e.to_string())? }
                .boxed()
                .shared()
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), pending.clone())
            .await
            .map_err(|_| unavailable("Stylus listener registration timed out"))?
            .map_err(unavailable)
    }

    pub async fn state(&self) -> Result<StylusState, AppError> {
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            optional_native_call(
                self.app
                    .try_state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>()
                    .map(|native| async move { native.stylus_state().await }),
            ),
        )
        .await
        .map_err(|_| unavailable("Stylus state timed out"))?
    }

    pub async fn set_target(
        self: &Arc<Self>,
        window: &tauri::WebviewWindow,
        token: String,
        active: bool,
    ) -> Result<StylusState, AppError> {
        if self
            .app
            .try_state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>()
            .is_none()
        {
            return missing_native_state();
        }
        if uuid::Uuid::parse_str(&token).is_err() || token.len() != 36 {
            return Err(AppError::domain(
                "stylus_invalid",
                "Invalid stylus target token",
            ));
        }
        if active && !window_eligible(window) {
            return Err(AppError::domain(
                "stylus_not_active",
                "Stylus target must be the visible focused window",
            ));
        }
        #[cfg(mobile)]
        self.ensure_listener().await?;
        let payload = self
            .target
            .lock()
            .map_err(|_| unavailable("Stylus target unavailable"))?
            .prepare(window.label(), &token, active, || {
                GENERATION
                    .try_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                        value.checked_add(1)
                    })
                    .map(|value| value + 1)
                    .map_err(|_| unavailable("Stylus generation exhausted"))
            })?;
        let Some(payload) = payload else {
            return self.state().await;
        };
        let native_payload = payload.clone();
        complete_update(
            &self.target,
            payload,
            optional_native_call(
                self.app
                    .try_state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>()
                    .map(|native| async move { native.stylus_set_target(native_payload).await }),
            ),
            std::time::Duration::from_secs(5),
        )
        .await
    }

    /// Fence a terminated renderer before its reload is attempted. Native cleanup
    /// is owned independently of the SDK callback and cannot restore old routes.
    #[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
    pub(crate) fn invalidate_window(self: &Arc<Self>, window: &str) -> Result<(), AppError> {
        let payload = self
            .target
            .lock()
            .map_err(|_| unavailable("Stylus target unavailable"))?
            .invalidate_window(window, || {
                GENERATION
                    .try_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                        value.checked_add(1)
                    })
                    .map(|value| value + 1)
                    .map_err(|_| unavailable("Stylus generation exhausted"))
            })?;
        let Some(payload) = payload else {
            return Ok(());
        };
        let service = self.clone();
        let native_payload = payload.clone();
        drop(tauri::async_runtime::spawn(async move {
            let _ = complete_update(
                &service.target,
                payload,
                async {
                    // A missing driver is not an ACK, including host test builds.
                    let native = service
                        .app
                        .try_state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>()
                        .ok_or_else(|| unavailable("Native stylus plugin is unavailable"))?;
                    native
                        .stylus_set_target(native_payload)
                        .await
                        .map_err(unavailable)
                },
                std::time::Duration::from_secs(5),
            )
            .await;
        }));
        Ok(())
    }

    #[cfg(mobile)]
    fn route(&self, event: NativeStylusEvent) {
        let (label, token) = match &event {
            NativeStylusEvent::Action {
                window_label,
                event,
            } => (window_label.clone(), event.target_token.clone()),
            NativeStylusEvent::Presence {
                window_label,
                target_token,
                ..
            } => (window_label.clone(), target_token.clone()),
        };
        let accepted = self
            .target
            .lock()
            .ok()
            .is_some_and(|target| target.routes(&label, &token));
        if !accepted {
            return;
        }
        let Some(window) = self.app.get_webview_window(&label) else {
            return;
        };
        if !window_eligible(&window) {
            return;
        }
        match event {
            NativeStylusEvent::Action { event, .. } => {
                let _ = self
                    .app
                    .emit_to(label.as_str(), "mobile:stylus-action", event);
            }
            NativeStylusEvent::Presence { presence, .. } => {
                let _ = self.app.emit_to(
                    label.as_str(),
                    "mobile:stylus-presence",
                    StylusPresenceEvent {
                        target_token: token,
                        presence,
                    },
                );
            }
        }
    }
}

#[cfg(all(test, desktop))]
mod desktop_tests {
    use super::*;

    #[tokio::test]
    async fn absent_native_plugin_resolves_empty_capabilities_without_native_work() {
        // A None managed-state lookup must not poll any native operation or wait
        // for the five-second transport deadline on desktop preview builds.
        let state = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            optional_native_call(None::<std::future::Pending<Result<StylusState, String>>>),
        )
        .await
        .expect("missing native state must resolve promptly")
        .unwrap();
        assert_eq!(state, StylusState::default());
        assert!(state.adapters.is_empty() && state.presence.is_empty());
        assert_eq!(missing_native_state().unwrap(), state);
    }
}

pub fn install(app: &tauri::AppHandle) {
    app.manage(Arc::new(MobileStylusService {
        app: app.clone(),
        target: Mutex::new(TargetSlot::default()),
        #[cfg(mobile)]
        listener: OnceLock::new(),
    }));
}
