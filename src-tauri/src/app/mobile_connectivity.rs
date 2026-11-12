//! Native connectivity changes are hints for existing owners, never admission.
#[cfg(any(mobile, test))]
use tauri_plugin_agentero_mobile::ConnectivityHint;
#[cfg(any(mobile, test))]
use tokio::sync::watch;
#[cfg(any(mobile, test))]
use tokio_util::sync::CancellationToken;

#[cfg(any(mobile, test))]
#[derive(Clone)]
struct HintInbox {
    sender: watch::Sender<u64>,
    cancelled: CancellationToken,
}
#[cfg(any(mobile, test))]
impl HintInbox {
    fn new(cancelled: CancellationToken) -> (Self, watch::Receiver<u64>) {
        let (sender, receiver) = watch::channel(0);
        (Self { sender, cancelled }, receiver)
    }
    fn publish(&self, hint: ConnectivityHint) -> bool {
        let value = hint.generation;
        if self.cancelled.is_cancelled()
            || value.is_empty()
            || value.len() > 20
            || !value.bytes().all(|byte| byte.is_ascii_digit())
            || (value.len() > 1 && value.starts_with('0'))
        {
            return false;
        }
        let Ok(generation) = value.parse::<u64>() else {
            return false;
        };
        self.sender.send_if_modified(|highest| {
            if generation <= *highest {
                return false;
            }
            *highest = generation;
            true
        })
    }
}

/// A watch receiver coalesces flaps while one recovery is in progress. Separate
/// receivers keep a slow provider close from delaying the Bridge admission fence.
#[cfg(any(mobile, test))]
async fn observe<F, Fut>(
    mut receiver: watch::Receiver<u64>,
    cancelled: CancellationToken,
    mut recover: F,
) where
    F: FnMut(u64) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    loop {
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => return,
            changed = receiver.changed() => if changed.is_err() { return; },
        }
        let generation = *receiver.borrow_and_update();
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => return,
            _ = recover(generation) => {},
        }
    }
}

#[cfg(mobile)]
struct ConnectivityRuntime {
    inbox: HintInbox,
}
#[cfg(mobile)]
impl ConnectivityRuntime {
    fn shutdown(&self) {
        self.inbox.cancelled.cancel();
    }
}
#[cfg(mobile)]
impl Drop for ConnectivityRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(super) fn install(app: &tauri::AppHandle) {
    #[cfg(desktop)]
    let _ = app;
    #[cfg(mobile)]
    {
        use super::remote_agent::background::RemoteBackgroundMonitors;
        use crate::features::remote_agent::RemoteAgentService;
        use crate::integration::bridge::BridgeClientController;
        use std::sync::Arc;
        use tauri::Manager;

        if app.try_state::<Arc<ConnectivityRuntime>>().is_some() {
            return;
        }
        let cancelled = CancellationToken::new();
        let (inbox, bridge_receiver) = HintInbox::new(cancelled.clone());
        let provider_receiver = bridge_receiver.clone();
        let runtime = Arc::new(ConnectivityRuntime { inbox });
        if !app.manage(runtime.clone()) {
            return;
        }

        let bridge_app = app.clone();
        tauri::async_runtime::spawn(observe(bridge_receiver, cancelled.clone(), move |_| {
            let app = bridge_app.clone();
            async move {
                if let Err(error) = app.state::<BridgeClientController>().network_changed() {
                    log::warn!("Mobile Bridge connectivity hint failed: {error}");
                }
            }
        }));
        let provider_app = app.clone();
        tauri::async_runtime::spawn(observe(provider_receiver, cancelled.clone(), move |_| {
            let app = provider_app.clone();
            async move {
                app.state::<RemoteAgentService>().network_changed().await;
                app.state::<Arc<RemoteBackgroundMonitors>>()
                    .network_changed();
            }
        }));

        let app = app.clone();
        let owner = Arc::downgrade(&runtime);
        tauri::async_runtime::spawn(async move {
            let Some(native) =
                app.try_state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>()
            else {
                runtime.shutdown();
                log::warn!("Native connectivity adapter is unavailable");
                return;
            };
            let setup = async {
                native
                    .on_connectivity_changed(move |hint| {
                        if let Some(runtime) = owner.upgrade() {
                            runtime.inbox.publish(hint);
                        }
                    })
                    .await?;
                // A callback may beat this reply. Both paths share the same high-water mark.
                let initial = native.connectivity_state().await?;
                runtime.inbox.publish(initial);
                Ok::<(), String>(())
            };
            let result = tokio::select! {
                biased;
                _ = cancelled.cancelled() => return,
                result = tokio::time::timeout(std::time::Duration::from_secs(5), setup) => result,
            };
            if !matches!(result, Ok(Ok(()))) {
                runtime.shutdown();
                log::warn!("Native connectivity hint setup failed or timed out");
            }
        });
    }
}

pub(super) fn shutdown(app: &tauri::AppHandle) {
    #[cfg(desktop)]
    let _ = app;
    #[cfg(mobile)]
    {
        use std::sync::Arc;
        use tauri::Manager;
        if let Some(runtime) = app.try_state::<Arc<ConnectivityRuntime>>() {
            runtime.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn hint(generation: impl ToString) -> ConnectivityHint {
        ConnectivityHint {
            generation: generation.to_string(),
        }
    }
    #[test]
    fn callbacks_and_late_initial_snapshot_share_a_strict_high_water_mark() {
        let token = CancellationToken::new();
        let (inbox, receiver) = HintInbox::new(token.clone());
        assert!(!inbox.publish(hint(0)));
        assert!(inbox.publish(hint(5)));
        for stale in [0, 1, 4, 5] {
            assert!(!inbox.publish(hint(stale)));
        }
        assert_eq!(*receiver.borrow(), 5);
        for invalid in ["", "-1", "+1", " 6", "06", "6.0", "18446744073709551616"] {
            assert!(!inbox.publish(hint(invalid)));
        }
        assert!(inbox.publish(hint("9007199254740993")));
        assert_eq!(*receiver.borrow(), 9_007_199_254_740_993);
        token.cancel();
        assert!(!inbox.publish(hint(u64::MAX)));
    }
    #[tokio::test]
    async fn burst_while_recovering_has_only_one_current_and_one_latest_followup() {
        let token = CancellationToken::new();
        let (inbox, receiver) = HintInbox::new(token.clone());
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let (output, mut calls) = tokio::sync::mpsc::channel(4);
        let blocked = gate.clone();
        let task = tokio::spawn(observe(receiver, token.clone(), move |generation| {
            let output = output.clone();
            let gate = blocked.clone();
            async move {
                output.send(generation).await.unwrap();
                if generation == 1 {
                    let _permit = gate.acquire().await.unwrap();
                }
            }
        }));
        assert!(inbox.publish(hint(1)));
        assert_eq!(calls.recv().await, Some(1));
        for generation in 2..=100 {
            assert!(inbox.publish(hint(generation)));
        }
        assert!(calls.try_recv().is_err());
        gate.add_permits(1);
        assert_eq!(calls.recv().await, Some(100));
        assert!(!inbox.publish(hint(100)));
        token.cancel();
        task.await.unwrap();
        assert!(calls.try_recv().is_err());
    }
    #[tokio::test]
    async fn slow_provider_recovery_does_not_delay_the_bridge_hint_receiver() {
        let token = CancellationToken::new();
        let (inbox, provider_receiver) = HintInbox::new(token.clone());
        let bridge_receiver = provider_receiver.clone();
        let (started, mut provider_calls) = tokio::sync::mpsc::channel(1);
        let provider = tokio::spawn(observe(
            provider_receiver,
            token.clone(),
            move |generation| {
                let started = started.clone();
                async move {
                    started.send(generation).await.unwrap();
                    std::future::pending::<()>().await;
                }
            },
        ));
        let (sent, mut bridge_calls) = tokio::sync::mpsc::channel(4);
        let bridge = tokio::spawn(observe(bridge_receiver, token.clone(), move |generation| {
            let sent = sent.clone();
            async move {
                sent.send(generation).await.unwrap();
            }
        }));
        inbox.publish(hint(1));
        assert_eq!(provider_calls.recv().await, Some(1));
        assert_eq!(bridge_calls.recv().await, Some(1));
        inbox.publish(hint(2));
        assert_eq!(bridge_calls.recv().await, Some(2));
        assert!(provider_calls.try_recv().is_err());
        token.cancel();
        provider.await.unwrap();
        bridge.await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_cancels_a_blocked_recovery_and_rejects_late_native_callbacks() {
        let token = CancellationToken::new();
        let (inbox, receiver) = HintInbox::new(token.clone());
        let (started, mut signal) = tokio::sync::mpsc::channel(1);
        let task = tokio::spawn(observe(receiver, token.clone(), move |_| {
            let started = started.clone();
            async move {
                started.send(()).await.unwrap();
                std::future::pending::<()>().await;
            }
        }));
        inbox.publish(hint(1));
        signal.recv().await.unwrap();
        token.cancel();
        task.await.unwrap();
        assert!(!inbox.publish(hint(2)));
    }
}
