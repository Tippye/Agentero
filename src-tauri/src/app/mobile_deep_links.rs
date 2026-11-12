//! Keep iOS document URLs out of the upstream deep-link JS event and cache.
//!
//! The original `RunEvent` remains owned by the application event loop. Private
//! document intake belongs there; this adapter only limits what the SDK sees.
use tauri::{
    ipc::Invoke, plugin::Plugin, webview::PageLoadPayload, AppHandle, RunEvent, Runtime, Url,
    Webview, Window,
};
use tauri_runtime::webview::InitializationScript;

/// Retain the upstream plugin name, configuration, commands, managed state,
/// lifecycle hooks and drop behavior. Only its iOS `Opened` input is filtered.
pub(super) fn plugin<R: Runtime>() -> impl Plugin<R> {
    FilteredDeepLinks {
        inner: tauri_plugin_deep_link::init::<R>(),
    }
}

struct FilteredDeepLinks<P> {
    inner: P,
}

impl<R: Runtime, P: Plugin<R>> Plugin<R> for FilteredDeepLinks<P> {
    fn name(&self) -> &'static str {
        self.inner.name()
    }

    fn initialize(
        &mut self,
        app: &AppHandle<R>,
        config: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.inner.initialize(app, config)
    }

    fn initialization_script(&self) -> Option<String> {
        self.inner.initialization_script()
    }

    fn initialization_script_2(&self) -> Option<InitializationScript> {
        self.inner.initialization_script_2()
    }

    fn window_created(&mut self, window: Window<R>) {
        self.inner.window_created(window);
    }

    fn webview_created(&mut self, webview: Webview<R>) {
        self.inner.webview_created(webview);
    }

    fn on_navigation(&mut self, webview: &Webview<R>, url: &Url) -> bool {
        self.inner.on_navigation(webview, url)
    }

    fn on_page_load(&mut self, webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
        self.inner.on_page_load(webview, payload);
    }

    fn on_event(&mut self, app: &AppHandle<R>, event: &RunEvent) {
        with_event(event, |filtered| self.inner.on_event(app, filtered));
    }

    fn extend_api(&mut self, invoke: Invoke<R>) -> bool {
        self.inner.extend_api(invoke)
    }
}

fn with_event(event: &RunEvent, consume: impl FnOnce(&RunEvent)) {
    // The application installs this wrapper only on iOS. macOS unit tests
    // exercise the same branch without constructing an AppHandle or runtime.
    // Linux has no Opened variant, even though it is also a Unix test target.
    #[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
    if let RunEvent::Opened { urls } = event {
        let filtered = RunEvent::Opened {
            urls: urls
                .iter()
                .filter(|url| url.scheme() == "agentero")
                .cloned()
                .collect(),
        };
        // Always forward an empty result as well. SDK 2.4.9 emits that list
        // and replaces its current cache, clearing a previous pair link.
        consume(&filtered);
        return;
    }
    consume(event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "ios", target_os = "macos"))]
    fn urls(values: &[&str]) -> Vec<Url> {
        values
            .iter()
            .map(|value| Url::parse(value).unwrap())
            .collect()
    }

    #[cfg(any(target_os = "ios", target_os = "macos"))]
    #[test]
    fn mixed_opened_filters_sdk_input_without_changing_the_original_intake() {
        let original = urls(&[
            "file:///private/Inbox/private-paper.pdf",
            "agentero://pair#offer=pair-data",
            "https://example.com/private-paper.pdf?token=private",
            "agentero://future/command?value=1#fragment",
            "http://localhost/private",
            "other-app://private/document",
        ]);
        let expected = vec![original[1].clone(), original[3].clone()];
        let event = RunEvent::Opened {
            urls: original.clone(),
        };
        let mut deliveries = 0;
        with_event(&event, |received| {
            deliveries += 1;
            let RunEvent::Opened { urls } = received else {
                panic!("expected the filtered Opened event");
            };
            assert_eq!(urls, &expected);
            assert!(!std::ptr::eq(received, &event));
        });
        assert_eq!(deliveries, 1);
        let RunEvent::Opened { urls } = &event else {
            unreachable!();
        };
        assert_eq!(urls, &original);
    }

    #[cfg(any(target_os = "ios", target_os = "macos"))]
    #[test]
    fn non_agentero_opened_is_delivered_as_empty_to_clear_the_upstream_cache() {
        for values in [
            vec!["file:///private/Inbox/private.pdf"],
            vec!["https://example.com/paper.pdf", "http://localhost/private"],
            vec![],
        ] {
            let event = RunEvent::Opened {
                urls: urls(&values),
            };
            let mut deliveries = 0;
            with_event(&event, |received| {
                deliveries += 1;
                assert!(matches!(received, RunEvent::Opened { urls } if urls.is_empty()));
            });
            assert_eq!(deliveries, 1, "empty filtering must still invoke the SDK");
        }
    }

    #[cfg(any(target_os = "ios", target_os = "macos"))]
    #[test]
    fn all_agentero_urls_preserve_order_duplicates_and_future_commands() {
        let original = urls(&[
            "agentero://pair#offer=data",
            "agentero:future-opaque-command",
            "agentero://pair#offer=data",
        ]);
        let event = RunEvent::Opened {
            urls: original.clone(),
        };
        with_event(&event, |received| {
            assert!(matches!(received, RunEvent::Opened { urls } if urls == &original));
        });
    }

    #[test]
    fn other_events_are_forwarded_once_as_the_original_reference() {
        let event = RunEvent::Ready;
        let mut deliveries = 0;
        with_event(&event, |received| {
            deliveries += 1;
            assert!(std::ptr::eq(received, &event));
            assert!(matches!(received, RunEvent::Ready));
        });
        assert_eq!(deliveries, 1);
    }

    struct ScriptPlugin;

    impl Plugin<tauri::Wry> for ScriptPlugin {
        fn name(&self) -> &'static str {
            "script-owner"
        }

        fn initialization_script(&self) -> Option<String> {
            Some("legacy-script".into())
        }

        fn initialization_script_2(&self) -> Option<InitializationScript> {
            Some(InitializationScript {
                script: "all-frames-script".into(),
                for_main_frame_only: false,
            })
        }
    }

    #[test]
    fn wrapper_preserves_the_inner_name_and_both_script_contracts() {
        let wrapped = FilteredDeepLinks {
            inner: ScriptPlugin,
        };
        assert_eq!(Plugin::<tauri::Wry>::name(&wrapped), "script-owner");
        assert_eq!(
            Plugin::<tauri::Wry>::initialization_script(&wrapped).as_deref(),
            Some("legacy-script")
        );
        let script = Plugin::<tauri::Wry>::initialization_script_2(&wrapped).unwrap();
        assert_eq!(script.script, "all-frames-script");
        assert!(!script.for_main_frame_only);
    }

    #[test]
    fn factory_keeps_the_actual_sdk_plugin_identity_without_starting_a_runtime() {
        assert_eq!(plugin::<tauri::Wry>().name(), "deep-link");
    }
}
