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

#[cfg(any(mobile, test))]
fn native_channel<T: serde::de::DeserializeOwned + 'static>(
    callback: impl Fn(T) + Send + Sync + 'static,
) -> tauri::ipc::Channel<tauri::ipc::InvokeResponseBody> {
    tauri::ipc::Channel::new(move |body| {
        let event: Result<T, _> = match body {
            tauri::ipc::InvokeResponseBody::Json(json) => serde_json::from_str(&json),
            tauri::ipc::InvokeResponseBody::Raw(bytes) => serde_json::from_slice(&bytes),
        };
        if let Ok(event) = event {
            callback(event);
        }
        Ok(())
    })
}

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
    /// Subscribe directly into Rust; expiration cannot depend on a live WebView.
    #[cfg(mobile)]
    pub async fn on_expired(
        &self,
        expired: impl Fn() + Send + Sync + 'static,
    ) -> Result<(), String> {
        let handler = tauri::ipc::Channel::<serde_json::Value>::new(move |_| {
            expired();
            Ok(())
        });
        self.handle
            .run_mobile_plugin_async::<serde_json::Value>(
                "registerListener",
                serde_json::json!({"event":"background-expired", "handler": handler}),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(mobile)]
    pub async fn on_stylus_event(
        &self,
        callback: impl Fn(NativeStylusEvent) + Send + Sync + 'static,
    ) -> Result<(), String> {
        let handler = native_channel::<NativeStylusEvent>(callback);
        self.handle
            .run_mobile_plugin_async::<serde_json::Value>(
                "registerListener",
                serde_json::json!({"event":"stylus-event", "handler":handler}),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Register before reading the snapshot so no native path change is lost.
    #[cfg(mobile)]
    pub async fn on_connectivity_changed(
        &self,
        callback: impl Fn(ConnectivityHint) + Send + Sync + 'static,
    ) -> Result<(), String> {
        let handler = native_channel::<ConnectivityHint>(callback);
        self.handle
            .run_mobile_plugin_async::<serde_json::Value>(
                "registerListener",
                serde_json::json!({"event":"connectivity-changed", "handler":handler}),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub async fn connectivity_state(&self) -> Result<ConnectivityHint, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin_async("connectivityState", serde_json::json!({}))
                .await
                .map_err(|error| error.to_string())
        }
        #[cfg(desktop)]
        {
            Ok(ConnectivityHint {
                generation: "0".into(),
            })
        }
    }

    pub async fn stylus_state(&self) -> Result<StylusState, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin_async("stylusState", serde_json::json!({}))
                .await
                .map_err(|error| error.to_string())
        }
        #[cfg(desktop)]
        {
            Ok(StylusState::default())
        }
    }

    pub async fn stylus_set_target(&self, target: StylusTarget) -> Result<StylusState, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin_async("stylusSetTarget", target)
                .await
                .map_err(|error| error.to_string())
        }
        #[cfg(desktop)]
        {
            let _ = target;
            Ok(StylusState::default())
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

#[cfg(test)]
mod stylus_channel_tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::ipc::InvokeResponseBody;

    const ACTION: &str = r#"{"kind":"action","windowLabel":"main","event":{"action":"toggleEraser","source":"nativePencilInteraction","adapterId":"apple-pencil-interaction","targetToken":"fcb7385a-e017-49d8-99dd-80f1c4426a71"}}"#;
    const PRESENCE: &str = r#"{"kind":"presence","windowLabel":"main","targetToken":"fcb7385a-e017-49d8-99dd-80f1c4426a71","presence":{"available":true,"proximity":null,"source":"nativeInputDevice","adapterId":"android-input-device"}}"#;

    #[test]
    fn connectivity_channel_preserves_decimal_generation_and_survives_bad_payloads() {
        let received = Arc::new(Mutex::new(Vec::<ConnectivityHint>::new()));
        let output = received.clone();
        let channel =
            native_channel::<ConnectivityHint>(move |hint| output.lock().unwrap().push(hint));
        for invalid in [
            "null",
            "{}",
            "not-json",
            r#"{"generation":1}"#,
            r#"{"generation":"1","status":"online"}"#,
        ] {
            channel
                .send(InvokeResponseBody::Json(invalid.into()))
                .unwrap();
            channel
                .send(InvokeResponseBody::Raw(invalid.as_bytes().to_vec()))
                .unwrap();
        }
        channel.send(InvokeResponseBody::Raw(vec![0xff])).unwrap();
        assert!(received.lock().unwrap().is_empty());
        let payload = r#"{"generation":"9007199254740993"}"#;
        channel
            .send(InvokeResponseBody::Json(payload.into()))
            .unwrap();
        channel
            .send(InvokeResponseBody::Raw(payload.as_bytes().to_vec()))
            .unwrap();
        assert_eq!(
            received.lock().unwrap().as_slice(),
            &[
                ConnectivityHint {
                    generation: "9007199254740993".into()
                },
                ConnectivityHint {
                    generation: "9007199254740993".into()
                },
            ]
        );
    }

    #[test]
    fn native_channel_decodes_json_and_raw_action_and_presence() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let channel =
            native_channel::<NativeStylusEvent>(move |event| received.lock().unwrap().push(event));
        for wire in [ACTION, PRESENCE] {
            channel.send(InvokeResponseBody::Json(wire.into())).unwrap();
            channel
                .send(InvokeResponseBody::Raw(wire.as_bytes().to_vec()))
                .unwrap();
        }
        let received = events.lock().unwrap();
        assert_eq!(received.len(), 4);
        for event in &received[..2] {
            assert!(
                matches!(event, NativeStylusEvent::Action { window_label, event }
                if window_label == "main" && event.action == StylusAction::ToggleEraser
                    && event.source == StylusSource::NativePencilInteraction
                    && event.adapter_id == "apple-pencil-interaction"
                    && event.target_token == "fcb7385a-e017-49d8-99dd-80f1c4426a71")
            );
        }
        for event in &received[2..] {
            assert!(
                matches!(event, NativeStylusEvent::Presence { window_label, target_token, presence }
                if window_label == "main" && target_token == "fcb7385a-e017-49d8-99dd-80f1c4426a71"
                    && presence.available && presence.proximity.is_none()
                    && presence.source == StylusSource::NativeInputDevice
                    && presence.adapter_id == "android-input-device")
            );
        }
    }

    #[test]
    fn malformed_and_unknown_native_payloads_do_not_dispatch_or_close_channel() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let channel =
            native_channel::<NativeStylusEvent>(move |event| received.lock().unwrap().push(event));
        for wire in [
            "not-json".to_string(),
            "null".to_string(),
            "{}".to_string(),
            r#"{"kind":"oemDoubleTap"}"#.to_string(),
            ACTION.replace("toggleEraser", "unsupportedGesture"),
            ACTION.replace("nativePencilInteraction", "unknownSource"),
            ACTION.replace("\"action\":\"toggleEraser\",", ""),
            PRESENCE.replace("\"available\":true", "\"available\":\"connected\""),
            PRESENCE.replace("\"available\":true", "\"unknown\":true,\"available\":true"),
        ] {
            channel
                .send(InvokeResponseBody::Json(wire.clone()))
                .unwrap();
            channel
                .send(InvokeResponseBody::Raw(wire.as_bytes().to_vec()))
                .unwrap();
        }
        channel.send(InvokeResponseBody::Raw(vec![0xff])).unwrap();
        assert!(events.lock().unwrap().is_empty());
        channel
            .send(InvokeResponseBody::Json(ACTION.into()))
            .unwrap();
        assert_eq!(events.lock().unwrap().len(), 1);
    }
}
