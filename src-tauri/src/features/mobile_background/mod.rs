//! Rust-owned work lifetimes and the mobile OS bridge. No WebView owns an OS lease.
pub mod commands;
pub mod scene;
mod service;
pub use service::{BackgroundDriver, BackgroundReason, BackgroundWork, MobileBackgroundService};
pub use tauri_plugin_agentero_mobile::{
    BackgroundCounts, BackgroundPlatform, BackgroundSettingsTarget, BackgroundState,
    NotificationPermission,
};

use crate::core::error::AppError;
use async_trait::async_trait;
#[cfg(mobile)]
use futures_util::{
    future::{BoxFuture, Shared},
    FutureExt,
};
use std::sync::{Arc, OnceLock, Weak};
use tauri::Manager;

pub struct NativeBackgroundDriver {
    app: tauri::AppHandle,
    owner: Arc<OnceLock<Weak<MobileBackgroundService>>>,
    #[cfg(mobile)]
    listener: OnceLock<Shared<BoxFuture<'static, Result<(), String>>>>,
}
impl NativeBackgroundDriver {
    pub fn new(app: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            owner: Arc::new(OnceLock::new()),
            #[cfg(mobile)]
            listener: OnceLock::new(),
        })
    }
    pub fn attach(&self, owner: &Arc<MobileBackgroundService>) {
        let _ = self.owner.set(Arc::downgrade(owner));
    }
    #[cfg(mobile)]
    async fn ensure_expiration_listener(&self) -> Result<(), String> {
        let pending = self.listener.get_or_init(|| {
            let app = self.app.clone();
            let owner = self.owner.clone();
            // Registration continues if a command or admission stops waiting.
            let registration = tauri::async_runtime::spawn(async move {
                let native =
                    app.state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>();
                native
                    .on_expired(move || {
                        if let Some(service) = owner.get().and_then(Weak::upgrade) {
                            service.expire_finite();
                        }
                    })
                    .await
            });
            async move { registration.await.map_err(|error| error.to_string())? }
                .boxed()
                .shared()
        });
        pending.clone().await
    }
    async fn run(&self, call: NativeCall) -> Result<BackgroundState, AppError> {
        #[cfg(desktop)]
        {
            let _ = &self.app;
            match call {
                NativeCall::Configure(true) | NativeCall::Notifications => Err(AppError::domain(
                    "background_unsupported",
                    "This platform does not support Android background permission controls",
                )),
                NativeCall::Settings(target) => {
                    let _ = target;
                    Err(AppError::domain(
                        "background_unsupported",
                        "Mobile system settings are unsupported",
                    ))
                }
                NativeCall::Apply(counts) => {
                    let _ = counts;
                    Ok(BackgroundState::unsupported(BackgroundPlatform::Desktop))
                }
                NativeCall::State | NativeCall::Configure(false) => {
                    Ok(BackgroundState::unsupported(BackgroundPlatform::Desktop))
                }
            }
        }
        #[cfg(mobile)]
        {
            // Android settings reply after the user returns from the system page.
            let budget = if matches!(&call, NativeCall::Notifications | NativeCall::Settings(_)) {
                120
            } else {
                5
            };
            let future = async {
                let native = self
                    .app
                    .state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>();
                match call {
                    NativeCall::State => native.read_state().await,
                    NativeCall::Configure(enabled) => native.configure(enabled).await,
                    NativeCall::Notifications => native.request_notifications().await,
                    NativeCall::Settings(target) => native.open_settings(target).await,
                    NativeCall::Apply(counts) => {
                        // An expired UIKit window must cancel Rust work without JS.
                        self.ensure_expiration_listener().await?;
                        native.apply(counts).await
                    }
                }
            };
            tokio::time::timeout(std::time::Duration::from_secs(budget), future)
                .await
                .map_err(|_| {
                    AppError::domain(
                        "background_unavailable",
                        "The native background adapter did not respond",
                    )
                })?
                .map_err(|error| AppError::domain("background_unavailable", error))
        }
    }
}

enum NativeCall {
    State,
    Configure(bool),
    Notifications,
    Settings(BackgroundSettingsTarget),
    Apply(BackgroundCounts),
}
#[async_trait]
impl BackgroundDriver for NativeBackgroundDriver {
    async fn state(&self) -> Result<BackgroundState, AppError> {
        self.run(NativeCall::State).await
    }
    async fn configure(&self, enabled: bool) -> Result<BackgroundState, AppError> {
        self.run(NativeCall::Configure(enabled)).await
    }
    async fn request_notifications(&self) -> Result<BackgroundState, AppError> {
        self.run(NativeCall::Notifications).await
    }
    async fn open_settings(
        &self,
        target: BackgroundSettingsTarget,
    ) -> Result<BackgroundState, AppError> {
        self.run(NativeCall::Settings(target)).await
    }
    async fn apply(&self, counts: BackgroundCounts) -> Result<BackgroundState, AppError> {
        self.run(NativeCall::Apply(counts)).await
    }
}

/// Run actual native work under a Rust-owned count and an OS-expiration fence.
/// Dropping the operation future keeps the existing durable sync / upload journal
/// authoritative; this helper never retries an interrupted network mutation.
pub async fn with_work<T>(
    app: &tauri::AppHandle,
    reason: BackgroundReason,
    operation: impl std::future::Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    #[cfg(desktop)]
    {
        let _ = (app, reason);
        operation.await
    }
    #[cfg(mobile)]
    {
        let Some(service) = app.try_state::<Arc<MobileBackgroundService>>() else {
            return operation.await;
        };
        let work = service.track(reason).await?;
        let cancellation = work.cancellation_token();
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(AppError::domain("background_window_expired", "The system background window ended; recover the existing operation when foregrounded")),
            result = operation => result,
        }
    }
}

/// Set up once per Rust application, independent of scene / activity WebViews.
pub fn install(app: &tauri::AppHandle) {
    let driver = NativeBackgroundDriver::new(app.clone());
    let service = MobileBackgroundService::new(driver.clone());
    driver.attach(&service);
    app.manage(service);
}
