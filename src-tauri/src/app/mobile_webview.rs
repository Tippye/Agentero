//! Bound iOS renderer recovery; a successful dispatch is not a restored React app.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Url;
#[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
use {std::sync::Arc, tauri::Manager};

const RECOVERY_WINDOW: Duration = Duration::from_secs(60);
const RECOVERY_ATTEMPTS: u8 = 2;

#[derive(Default)]
struct RecoveryBudget {
    start: Option<Instant>,
    attempts: u8,
}
impl RecoveryBudget {
    fn admit(&mut self, now: Instant) -> bool {
        match self.start {
            Some(start) => match now.checked_duration_since(start) {
                Some(elapsed) if elapsed >= RECOVERY_WINDOW => {
                    self.start = Some(now);
                    self.attempts = 0;
                }
                None => return false,
                _ => {}
            },
            None => self.start = Some(now),
        }
        if self.attempts >= RECOVERY_ATTEMPTS {
            return false;
        }
        self.attempts += 1;
        true
    }
}

fn entry_path(path: &str, base: &str) -> bool {
    path == base || (base == "/" && matches!(path, "" | "/index.html"))
}
fn app_entry(url: &Url, dev_url: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && url.port().is_none()
        && entry_path(url.path(), "/")
    {
        return true;
    }
    dev_url.is_some_and(|dev| {
        dev.username().is_empty()
            && dev.password().is_none()
            && url.scheme() == dev.scheme()
            && url.host_str() == dev.host_str()
            && url.host_str().is_some()
            && url.port_or_known_default() == dev.port_or_known_default()
            && entry_path(url.path(), dev.path())
    })
}

#[derive(Debug, PartialEq, Eq)]
enum RecoveryOutcome {
    Ignored,
    Refused,
    Limited,
    Requested,
    Failed,
}

fn recover(
    label: &str,
    url: Option<&Url>,
    dev_url: Option<&Url>,
    budget: &Mutex<RecoveryBudget>,
    now: Instant,
    invalidate: impl FnOnce(),
    reload: impl FnOnce() -> bool,
) -> RecoveryOutcome {
    // Mobile currently owns one application WebView. Do not introduce recovery
    // for popups, external navigation, or future scenes without explicit ownership.
    if label != "main" {
        return RecoveryOutcome::Ignored;
    }
    invalidate();
    if !url.is_some_and(|url| app_entry(url, dev_url)) {
        return RecoveryOutcome::Refused;
    }
    let admitted = budget.lock().is_ok_and(|mut budget| budget.admit(now));
    if !admitted {
        return RecoveryOutcome::Limited;
    }
    // No policy lock across a native dispatcher call, which may execute inline.
    if reload() {
        RecoveryOutcome::Requested
    } else {
        RecoveryOutcome::Failed
    }
}

#[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
pub(super) fn attach(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    // Retain the budget across navigations, page-load completion, and main-label
    // recreation. A quick successful navigation is not proof of a stable renderer.
    let budget = Arc::new(Mutex::new(RecoveryBudget::default()));
    builder.on_web_content_process_terminate(move |webview| {
        let app = webview.app_handle();
        let url = webview.url().ok();
        let dev_url = if tauri::is_dev() {
            app.config().build.dev_url.as_ref()
        } else {
            None
        };
        let outcome = recover(
            webview.label(),
            url.as_ref(),
            dev_url,
            &budget,
            Instant::now(),
            || {
                if let Some(stylus) =
                    app.try_state::<Arc<crate::features::mobile_stylus::MobileStylusService>>()
                {
                    if stylus.invalidate_window(webview.label()).is_err() {
                        log::warn!("iOS renderer stylus invalidation failed");
                    }
                }
            },
            // Use this exact runtime handle; never look up a replacement by label.
            || webview.reload().is_ok(),
        );
        match outcome {
            RecoveryOutcome::Requested => log::info!("iOS renderer reload requested"),
            RecoveryOutcome::Limited => log::warn!("iOS renderer recovery budget exhausted"),
            RecoveryOutcome::Failed => log::warn!("iOS renderer reload dispatch failed"),
            RecoveryOutcome::Refused => {
                log::warn!("iOS renderer recovery requires the local app entry")
            }
            RecoveryOutcome::Ignored => {}
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        sync::atomic::{AtomicUsize, Ordering},
    };

    #[cfg(target_os = "macos")]
    #[test]
    fn hook_uses_the_public_sdk_without_creating_a_runtime_or_window() {
        let _builder = attach(tauri::Builder::default());
    }

    #[test]
    fn only_exact_app_entry_and_configured_dev_entry_are_owned() {
        let dev = Url::parse("http://localhost:1420/").unwrap();
        for value in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html?mobilePreview=1#paper",
            "http://localhost:1420/",
            "http://localhost:1420/index.html",
        ] {
            assert!(
                app_entry(&Url::parse(value).unwrap(), Some(&dev)),
                "{value}"
            );
        }
        for value in [
            "tauri://other/",
            "tauri://localhost:7/",
            "tauri://user@localhost/",
            "tauri://localhost/elsewhere",
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://localhost:1420/elsewhere",
            "http://127.0.0.1:1420/",
            "https://example.com/",
            "file:///index.html",
            "about:blank",
        ] {
            assert!(
                !app_entry(&Url::parse(value).unwrap(), Some(&dev)),
                "{value}"
            );
        }
        assert!(!app_entry(&dev, None));
        let path_dev = Url::parse("https://dev.example/preview.html").unwrap();
        assert!(app_entry(
            &Url::parse("https://dev.example/preview.html?x=1").unwrap(),
            Some(&path_dev)
        ));
        assert!(!app_entry(
            &Url::parse("https://dev.example/").unwrap(),
            Some(&path_dev)
        ));
    }

    #[test]
    fn rapid_terminations_cannot_reset_the_two_attempt_budget() {
        let start = Instant::now();
        let mut budget = RecoveryBudget::default();
        assert!(budget.admit(start));
        assert!(budget.admit(start));
        assert!(!budget.admit(start));
        assert!(!budget.admit(start + RECOVERY_WINDOW - Duration::from_nanos(1)));
        assert!(!budget.admit(start.checked_sub(Duration::from_secs(1)).unwrap()));
        assert!(budget.admit(start + RECOVERY_WINDOW));
        assert!(budget.admit(start + RECOVERY_WINDOW));
        assert!(!budget.admit(start + RECOVERY_WINDOW));
    }

    #[test]
    fn invalidation_precedes_reload_and_still_runs_after_budget_exhaustion() {
        let budget = Mutex::new(RecoveryBudget::default());
        let url = Url::parse("tauri://localhost/").unwrap();
        let order = RefCell::new(Vec::new());
        let now = Instant::now();
        for expected in [
            RecoveryOutcome::Requested,
            RecoveryOutcome::Failed,
            RecoveryOutcome::Limited,
        ] {
            let succeed = expected != RecoveryOutcome::Failed;
            let outcome = recover(
                "main",
                Some(&url),
                None,
                &budget,
                now,
                || order.borrow_mut().push("invalidate"),
                || {
                    assert!(budget.try_lock().is_ok());
                    order.borrow_mut().push("reload");
                    succeed
                },
            );
            assert_eq!(outcome, expected);
        }
        assert_eq!(
            *order.borrow(),
            ["invalidate", "reload", "invalidate", "reload", "invalidate"]
        );
    }

    #[test]
    fn missing_or_external_navigation_never_reload_and_other_views_are_untouched() {
        let budget = Mutex::new(RecoveryBudget::default());
        let invalidated = AtomicUsize::new(0);
        let reloaded = AtomicUsize::new(0);
        let foreign = Url::parse("https://example.com/").unwrap();
        let local = Url::parse("tauri://localhost/").unwrap();
        for (label, url, expected) in [
            ("main", None, RecoveryOutcome::Refused),
            ("main", Some(&foreign), RecoveryOutcome::Refused),
            ("popup", Some(&local), RecoveryOutcome::Ignored),
        ] {
            assert_eq!(
                recover(
                    label,
                    url,
                    None,
                    &budget,
                    Instant::now(),
                    || {
                        invalidated.fetch_add(1, Ordering::SeqCst);
                    },
                    || {
                        reloaded.fetch_add(1, Ordering::SeqCst);
                        true
                    }
                ),
                expected
            );
        }
        assert_eq!(invalidated.load(Ordering::SeqCst), 2);
        assert_eq!(reloaded.load(Ordering::SeqCst), 0);
        assert_eq!(budget.lock().unwrap().attempts, 0);
    }
}
