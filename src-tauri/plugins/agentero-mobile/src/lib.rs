mod models;
pub use models::*;
#[cfg(mobile)]
use tauri::plugin::PluginHandle;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_agentero_mobile);

/// Rust-owned adapter; no raw native command handler is exposed to a WebView.
pub struct MobileBackground<R: Runtime> {
    #[cfg(mobile)]
    handle: PluginHandle<R>,
    #[cfg(desktop)]
    runtime: std::marker::PhantomData<fn() -> R>,
}
impl<R: Runtime> MobileBackground<R> {
    async fn call(
        &self,
        name: &str,
        payload: impl serde::Serialize,
    ) -> Result<BackgroundState, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin_async(name, payload)
                .await
                .map_err(|error| error.to_string())
        }
        #[cfg(desktop)]
        {
            let _ = (name, payload);
            Ok(BackgroundState::unsupported(BackgroundPlatform::Desktop))
        }
    }
    pub async fn read_state(&self) -> Result<BackgroundState, String> {
        self.call("readState", serde_json::json!({})).await
    }
    pub async fn configure(&self, enabled: bool) -> Result<BackgroundState, String> {
        #[cfg(desktop)]
        if enabled {
            return Err("Persistent mobile background execution is unsupported".into());
        }
        self.call("configure", serde_json::json!({"enabled": enabled}))
            .await
    }
    pub async fn request_notifications(&self) -> Result<BackgroundState, String> {
        #[cfg(desktop)]
        {
            Err("Mobile notification permission is unsupported".into())
        }
        #[cfg(mobile)]
        self.call("requestNotifications", serde_json::json!({}))
            .await
    }
    pub async fn open_settings(
        &self,
        target: BackgroundSettingsTarget,
    ) -> Result<BackgroundState, String> {
        #[cfg(desktop)]
        {
            let _ = target;
            Err("Mobile system settings are unsupported".into())
        }
        #[cfg(mobile)]
        self.call("openSettings", serde_json::json!({"target":target}))
            .await
    }
    pub async fn apply(&self, counts: BackgroundCounts) -> Result<BackgroundState, String> {
        #[cfg(desktop)]
        if !counts.is_empty() {
            return Err("Mobile background leases are unsupported".into());
        }
        self.call("apply", counts).await
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("agentero-mobile")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let background = MobileBackground {
                handle: api
                    .register_android_plugin("app.agentero.mobile", "AgenteroMobilePlugin")?,
            };
            #[cfg(target_os = "ios")]
            let background = MobileBackground {
                handle: api.register_ios_plugin(init_plugin_agentero_mobile)?,
            };
            #[cfg(desktop)]
            let background = {
                let _ = api;
                MobileBackground::<R> {
                    runtime: std::marker::PhantomData,
                }
            };
            app.manage(background);
            Ok(())
        })
        .build()
}
