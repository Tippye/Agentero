use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use tauri_plugin_agentero_mobile::{BackgroundPlatform, NotificationPermission};
use tokio::sync::Notify;

#[derive(Default)]
struct Gate {
    entered: Notify,
    released: Notify,
}
struct Native {
    generation: u64,
    counts: BackgroundCounts,
    state: BackgroundState,
    finite_latch: bool,
    finite_window: bool,
    finite_starts: usize,
}
struct Driver {
    native: Mutex<Native>,
    calls: Mutex<Vec<BackgroundCounts>>,
    acknowledgements: Mutex<Vec<BackgroundCounts>>,
    changes: watch::Sender<usize>,
    admission: Mutex<Option<Arc<Gate>>>,
    finite_zero: Mutex<Option<Arc<Gate>>>,
    effect_before_ack: AtomicBool,
    permission: Mutex<Option<Arc<Gate>>>,
    fail_next: AtomicBool,
    dropped_apply: AtomicBool,
    pending_applies: AtomicUsize,
    max_applies: AtomicUsize,
}
impl Driver {
    fn new(platform: BackgroundPlatform) -> Arc<Self> {
        let mut state = BackgroundState::unsupported(platform);
        state.persistent_connection = platform == BackgroundPlatform::Android;
        state.finite_tasks = platform != BackgroundPlatform::Desktop;
        state.enabled = true;
        state.notification_permission = NotificationPermission::Granted;
        state.notifications_enabled = true;
        let (changes, _) = watch::channel(0);
        Arc::new(Self {
            native: Mutex::new(Native {
                generation: 0,
                counts: BackgroundCounts::default(),
                state,
                finite_latch: false,
                finite_window: false,
                finite_starts: 0,
            }),
            calls: Mutex::new(Vec::new()),
            acknowledgements: Mutex::new(Vec::new()),
            changes,
            admission: Mutex::new(None),
            finite_zero: Mutex::new(None),
            effect_before_ack: AtomicBool::new(false),
            permission: Mutex::new(None),
            fail_next: AtomicBool::new(false),
            dropped_apply: AtomicBool::new(false),
            pending_applies: AtomicUsize::new(0),
            max_applies: AtomicUsize::new(0),
        })
    }
    fn reconcile(native: &mut Native) {
        let allowed = native.state.enabled && native.state.notifications_enabled;
        native.state.agent_active =
            allowed && native.state.persistent_connection && native.counts.agent_count > 0;
        let finite_allowed =
            allowed && native.state.finite_tasks && (!native.finite_latch || native.finite_window);
        native.state.sync_active = finite_allowed && native.counts.sync_count > 0;
        native.state.finite_task_active =
            finite_allowed && (native.counts.sync_count > 0 || native.counts.transfer_count > 0);
    }
    fn effect(&self, counts: BackgroundCounts) -> BackgroundState {
        let mut native = self.native.lock().unwrap();
        let generation = counts.generation.parse::<u64>().unwrap();
        // Model the native contract: a delayed effect cannot resurrect an older generation.
        if generation > native.generation {
            if native.finite_latch {
                let previous_finite =
                    native.counts.sync_count > 0 || native.counts.transfer_count > 0;
                let next_finite = counts.sync_count > 0 || counts.transfer_count > 0;
                if !next_finite {
                    native.finite_window = false;
                    native.state.finite_task_expired = false;
                } else if !previous_finite {
                    native.finite_window = true;
                    native.state.finite_task_expired = false;
                    native.finite_starts += 1;
                }
            }
            native.generation = generation;
            native.counts = counts;
            Self::reconcile(&mut native);
        }
        native.state.clone()
    }
    async fn ack(&self, matches: impl Fn(&BackgroundCounts) -> bool) -> BackgroundCounts {
        let mut changes = self.changes.subscribe();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if let Some(counts) = self
                    .acknowledgements
                    .lock()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|counts| matches(counts))
                    .cloned()
                {
                    return counts;
                }
                changes.changed().await.unwrap();
            }
        })
        .await
        .expect("background apply did not settle")
    }
}
struct Applying<'a> {
    driver: &'a Driver,
    completed: bool,
}
impl Drop for Applying<'_> {
    fn drop(&mut self) {
        self.driver.pending_applies.fetch_sub(1, Ordering::SeqCst);
        if !self.completed {
            self.driver.dropped_apply.store(true, Ordering::SeqCst);
        }
    }
}
#[async_trait]
impl BackgroundDriver for Driver {
    async fn state(&self) -> Result<BackgroundState, AppError> {
        Ok(self.native.lock().unwrap().state.clone())
    }
    async fn apply(&self, counts: BackgroundCounts) -> Result<BackgroundState, AppError> {
        let active = self.pending_applies.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_applies.fetch_max(active, Ordering::SeqCst);
        let mut applying = Applying {
            driver: self,
            completed: false,
        };
        self.calls.lock().unwrap().push(counts.clone());
        let failed = self.fail_next.swap(false, Ordering::SeqCst);
        if self.effect_before_ack.load(Ordering::SeqCst) && !failed {
            self.effect(counts.clone());
        }
        let finite_zero = if counts.sync_count == 0 && counts.transfer_count == 0 {
            self.finite_zero.lock().unwrap().take()
        } else {
            None
        };
        let gate = if finite_zero.is_some() {
            finite_zero
        } else if !counts.is_empty() {
            self.admission.lock().unwrap().take()
        } else {
            None
        };
        if let Some(gate) = gate {
            gate.entered.notify_one();
            gate.released.notified().await;
        }
        let result = if failed {
            Err(unavailable())
        } else {
            Ok(self.effect(counts.clone()))
        };
        self.acknowledgements.lock().unwrap().push(counts);
        self.changes.send_modify(|serial| *serial += 1);
        applying.completed = true;
        result
    }
    async fn configure(&self, enabled: bool) -> Result<BackgroundState, AppError> {
        let mut native = self.native.lock().unwrap();
        native.state.enabled = enabled;
        Self::reconcile(&mut native);
        Ok(native.state.clone())
    }
    async fn request_notifications(&self) -> Result<BackgroundState, AppError> {
        let gate = self.permission.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.entered.notify_one();
            gate.released.notified().await;
        }
        self.state().await
    }
    async fn open_settings(
        &self,
        _target: BackgroundSettingsTarget,
    ) -> Result<BackgroundState, AppError> {
        self.state().await
    }
}

#[tokio::test]
async fn overlapping_reason_counts_release_only_their_owner_and_remain_serial() {
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    let first = service.track(BackgroundReason::AgentSession).await.unwrap();
    let second = service.track(BackgroundReason::AgentSession).await.unwrap();
    let sync = service.track(BackgroundReason::Sync).await.unwrap();
    let transfer = service.track(BackgroundReason::Transfer).await.unwrap();
    driver
        .ack(|c| c.agent_count == 2 && c.sync_count == 1 && c.transfer_count == 1)
        .await;
    drop(first);
    driver
        .ack(|c| c.agent_count == 1 && c.sync_count == 1 && c.transfer_count == 1)
        .await;
    drop(sync);
    driver
        .ack(|c| c.agent_count == 1 && c.sync_count == 0 && c.transfer_count == 1)
        .await;
    drop(second);
    drop(transfer);
    service.shutdown().await.unwrap();
    assert!(driver.ack(|c| c.is_empty()).await.is_empty());
    assert_eq!(driver.max_applies.load(Ordering::SeqCst), 1);
    let calls = driver.calls.lock().unwrap();
    assert!(calls
        .windows(2)
        .all(|pair| pair[0].generation.parse::<u64>().unwrap()
            < pair[1].generation.parse::<u64>().unwrap()));
}

#[tokio::test]
async fn expiry_cancels_only_finite_work_and_new_admission_uses_a_fresh_token() {
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    let agent = service.track(BackgroundReason::AgentSession).await.unwrap();
    let sync = service.track(BackgroundReason::Sync).await.unwrap();
    let transfer = service.track(BackgroundReason::Transfer).await.unwrap();
    let sync_token = sync.cancellation_token();
    let transfer_token = transfer.cancellation_token();
    service.expire_finite();
    assert!(sync_token.is_cancelled());
    assert!(transfer_token.is_cancelled());
    assert!(!agent.cancellation_token().is_cancelled());
    driver
        .ack(|c| c.agent_count == 1 && c.sync_count == 0 && c.transfer_count == 0)
        .await;
    let next = service.track(BackgroundReason::Sync).await.unwrap();
    assert!(!next.cancellation_token().is_cancelled());
    drop(sync);
    drop(transfer);
    driver
        .ack(|c| c.agent_count == 1 && c.sync_count == 1)
        .await;
    assert_eq!(service.shared.lock().works.len(), 2);
    drop(next);
    drop(agent);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn ios_suspend_releases_only_local_agent_monitor_and_keeps_finite_window_work() {
    let driver = Driver::new(BackgroundPlatform::Ios);
    let service = MobileBackgroundService::new(driver.clone());
    let agent = service.track(BackgroundReason::AgentSession).await.unwrap();
    let sync = service.track(BackgroundReason::Sync).await.unwrap();
    let transfer = service.track(BackgroundReason::Transfer).await.unwrap();
    service.suspend();
    assert!(agent.cancellation_token().is_cancelled());
    assert!(!sync.cancellation_token().is_cancelled());
    assert!(!transfer.cancellation_token().is_cancelled());
    driver
        .ack(|c| c.agent_count == 0 && c.sync_count == 1 && c.transfer_count == 1)
        .await;
    let state = service.state().await.unwrap();
    assert!(!state.persistent_connection);
    assert!(!state.agent_active);
    assert!(state.finite_task_active);
    drop(agent);
    drop(sync);
    drop(transfer);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn unsupported_disabled_and_native_fault_leave_foreground_work_usable_without_fake_activity()
{
    for platform in [BackgroundPlatform::Desktop, BackgroundPlatform::Android] {
        let driver = Driver::new(platform);
        let service = MobileBackgroundService::new(driver.clone());
        service.configure(false).await.unwrap();
        let work = service.track(BackgroundReason::AgentSession).await.unwrap();
        assert!(!work.cancellation_token().is_cancelled());
        let observed = service.state().await.unwrap();
        assert!(!observed.agent_active);
        assert!(!observed.enabled);
        drop(work);
        service.shutdown().await.unwrap();
    }
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    // Ensure the deliberate failure belongs to the nonzero admission, not initial zero.
    let initial = service.shared.lock().desired.generation.parse().unwrap();
    service.wait_attempt(initial).await.unwrap();
    driver.fail_next.store(true, Ordering::SeqCst);
    let work = service.track(BackgroundReason::Sync).await.unwrap();
    assert!(!work.cancellation_token().is_cancelled());
    assert!(!service.state().await.unwrap().sync_active);
    drop(work);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn aborted_admission_keeps_native_apply_owned_and_releases_late_admission_with_newer_zero() {
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    let gate = Arc::new(Gate::default());
    *driver.admission.lock().unwrap() = Some(gate.clone());
    let acquiring = service.clone();
    let task = tokio::spawn(async move { acquiring.track(BackgroundReason::AgentSession).await });
    gate.entered.notified().await;
    let admitted = driver.calls.lock().unwrap().last().unwrap().clone();
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    let release_generation = {
        let book = service.shared.lock();
        assert!(book.works.is_empty());
        assert!(book.desired.is_empty());
        book.desired.generation.parse::<u64>().unwrap()
    };
    assert!(release_generation > admitted.generation.parse::<u64>().unwrap());
    assert!(!driver.dropped_apply.load(Ordering::SeqCst));
    gate.released.notify_one();
    service.wait_attempt(release_generation).await.unwrap();
    assert!(!service.state().await.unwrap().agent_active);
    // Even a platform-side late effect after a timed-out call is fenced by zero.
    assert!(!driver.effect(admitted).agent_active);
    assert!(!driver.dropped_apply.load(Ordering::SeqCst));
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn pending_apply_coalesces_latest_counts_and_never_dispatches_overlapping_native_control() {
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    let gate = Arc::new(Gate::default());
    *driver.admission.lock().unwrap() = Some(gate.clone());
    let first_owner = service.clone();
    let first =
        tokio::spawn(async move { first_owner.track(BackgroundReason::AgentSession).await });
    gate.entered.notified().await;
    let owners: Vec<_> = (0..4)
        .map(|_| {
            let owner = service.clone();
            tokio::spawn(async move { owner.track(BackgroundReason::Sync).await })
        })
        .collect();
    // Synchronize on actual Rust-owned admission, not scheduler sleeps.
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let admitted = { service.shared.lock().works.len() == 5 };
            if admitted {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let before = driver.calls.lock().unwrap().len();
    gate.released.notify_one();
    let first = first.await.unwrap().unwrap();
    let mut works = Vec::new();
    for owner in owners {
        works.push(owner.await.unwrap().unwrap());
    }
    assert_eq!(driver.calls.lock().unwrap().len(), before + 1);
    assert_eq!(driver.max_applies.load(Ordering::SeqCst), 1);
    driver
        .ack(|c| c.agent_count == 1 && c.sync_count == 4)
        .await;
    drop(first);
    drop(works);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn slow_permission_dialog_cannot_hold_up_work_release_or_shutdown() {
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    let work = service.track(BackgroundReason::Sync).await.unwrap();
    let gate = Arc::new(Gate::default());
    *driver.permission.lock().unwrap() = Some(gate.clone());
    let requesting = service.clone();
    let permission = tokio::spawn(async move { requesting.request_notifications().await });
    gate.entered.notified().await;
    drop(work);
    service.shutdown().await.unwrap();
    assert!(driver.native.lock().unwrap().counts.is_empty());
    assert!(!permission.is_finished());
    gate.released.notify_one();
    permission.await.unwrap().unwrap();
}

#[tokio::test]
async fn capacity_is_bounded_cancel_is_idempotent_and_shutdown_releases_every_reason() {
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    let mut works = Vec::new();
    for _ in 0..MAX_WORK {
        works.push(service.track(BackgroundReason::Transfer).await.unwrap());
    }
    let rejected = service.track(BackgroundReason::Sync).await;
    assert!(matches!(rejected, Err(error) if error.code() == "mobile_background_capacity"));
    works[0].cancel();
    works[0].cancel();
    let replacement = service.track(BackgroundReason::Sync).await.unwrap();
    assert_eq!(service.shared.lock().works.len(), MAX_WORK);
    service.shutdown().await.unwrap();
    assert!(replacement.cancellation_token().is_cancelled());
    assert!(works
        .iter()
        .all(|work| work.cancellation_token().is_cancelled()));
    assert!(
        matches!(service.track(BackgroundReason::Sync).await, Err(error) if error.code() == "mobile_background_closed")
    );
    assert!(driver.native.lock().unwrap().counts.is_empty());
    drop(works);
    drop(replacement);
}

#[tokio::test]
async fn dropping_the_service_cancels_work_flushes_zero_and_terminates_without_an_owner_cycle() {
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    let work = service.track(BackgroundReason::AgentSession).await.unwrap();
    let token = work.cancellation_token();
    let weak_service = Arc::downgrade(&service);
    let weak_shared = Arc::downgrade(&service.shared);
    let mut progress = service.progress.clone();
    drop(service);
    assert!(weak_service.upgrade().is_none());
    assert!(token.is_cancelled());
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while progress.changed().await.is_ok() {}
    })
    .await
    .unwrap();
    assert!(weak_shared.upgrade().is_none());
    assert!(driver.native.lock().unwrap().counts.is_empty());
    assert_eq!(Arc::strong_count(&driver), 1);
    drop(work);
}

#[tokio::test]
async fn poisoned_book_does_not_panic_in_work_drop_or_strand_native_count() {
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    let work = service.track(BackgroundReason::Sync).await.unwrap();
    let shared = service.shared.clone();
    assert!(std::thread::spawn(move || {
        let _guard = shared.book.lock().unwrap();
        panic!("injected owner poison");
    })
    .join()
    .is_err());
    drop(work);
    service.shutdown().await.unwrap();
    assert!(driver.native.lock().unwrap().counts.is_empty());
}

#[tokio::test]
async fn expiry_during_admission_prevents_finite_dispatch_without_cancelling_new_agent_work() {
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    let gate = Arc::new(Gate::default());
    *driver.admission.lock().unwrap() = Some(gate.clone());
    let acquiring = service.clone();
    let finite = tokio::spawn(async move { acquiring.track(BackgroundReason::Sync).await });
    gate.entered.notified().await;
    service.expire_finite();
    assert!(service.shared.lock().works.is_empty());
    let acquiring = service.clone();
    let agent = tokio::spawn(async move { acquiring.track(BackgroundReason::AgentSession).await });
    gate.released.notify_one();
    assert!(
        matches!(finite.await.unwrap(), Err(error) if error.code() == "mobile_background_cancelled")
    );
    let agent = agent.await.unwrap().unwrap();
    assert!(!agent.cancellation_token().is_cancelled());
    let applied = driver
        .ack(|counts| counts.agent_count == 1 && counts.sync_count == 0)
        .await;
    assert_eq!(applied.transfer_count, 0);
    drop(agent);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_shutdown_zero_is_reported_and_never_fabricates_an_inactive_native_state() {
    let driver = Driver::new(BackgroundPlatform::Android);
    let service = MobileBackgroundService::new(driver.clone());
    let work = service.track(BackgroundReason::AgentSession).await.unwrap();
    assert!(service.state().await.unwrap().agent_active);
    driver.fail_next.store(true, Ordering::SeqCst);
    assert_eq!(
        service.shutdown().await.unwrap_err().code(),
        "mobile_background_unavailable"
    );
    assert!(work.cancellation_token().is_cancelled());
    assert!(service.shared.lock().works.is_empty());
    assert!(service.state().await.unwrap().agent_active);
    assert!(service.progress.borrow().stopped);
    drop(work);
}

#[tokio::test]
async fn expired_native_latch_crosses_finite_zero_without_admitting_new_work_from_barrier_ack() {
    for barrier_fails in [false, true] {
        let driver = Driver::new(BackgroundPlatform::Android);
        driver.native.lock().unwrap().finite_latch = true;
        driver.effect_before_ack.store(true, Ordering::SeqCst);
        let service = MobileBackgroundService::new(driver.clone());
        let agent = service.track(BackgroundReason::AgentSession).await.unwrap();
        let old_ack = Arc::new(Gate::default());
        *driver.admission.lock().unwrap() = Some(old_ack.clone());
        let acquiring = service.clone();
        let old = tokio::spawn(async move { acquiring.track(BackgroundReason::Sync).await });
        old_ack.entered.notified().await;
        let old_generation = {
            let mut native = driver.native.lock().unwrap();
            assert_eq!(native.finite_starts, 1);
            // UIKit retains its positive count on expiration. Positive -> positive
            // does not authorize another window until Rust actually publishes zero.
            native.finite_window = false;
            native.state.finite_task_expired = true;
            Driver::reconcile(&mut native);
            native.generation
        };
        let barrier_ack = Arc::new(Gate::default());
        let fresh_ack = Arc::new(Gate::default());
        *driver.finite_zero.lock().unwrap() = Some(barrier_ack.clone());
        *driver.admission.lock().unwrap() = Some(fresh_ack.clone());
        driver.fail_next.store(barrier_fails, Ordering::SeqCst);
        service.expire_finite();
        let mut fresh = Box::pin(service.track(BackgroundReason::Sync));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(fresh.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        old_ack.released.notify_one();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            barrier_ack.entered.notified(),
        )
        .await
        .unwrap();
        assert!(
            matches!(old.await.unwrap(), Err(error) if error.code() == "mobile_background_cancelled")
        );
        let barrier = driver.calls.lock().unwrap().last().unwrap().clone();
        assert_eq!(
            (
                barrier.agent_count,
                barrier.sync_count,
                barrier.transfer_count
            ),
            (1, 0, 0)
        );
        assert!(barrier.generation.parse::<u64>().unwrap() > old_generation);
        assert!(driver.native.lock().unwrap().state.agent_active);
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(fresh.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        barrier_ack.released.notify_one();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            fresh_ack.entered.notified(),
        )
        .await
        .unwrap();
        let positive = driver.calls.lock().unwrap().last().unwrap().clone();
        assert_eq!(
            (
                positive.agent_count,
                positive.sync_count,
                positive.transfer_count
            ),
            (1, 1, 0)
        );
        assert!(
            positive.generation.parse::<u64>().unwrap()
                > barrier.generation.parse::<u64>().unwrap()
        );
        // The barrier had a newer generation than this work ID, but it did not
        // contain its positive finite count and must not satisfy admission.
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(fresh.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        fresh_ack.released.notify_one();
        let fresh = fresh.await.unwrap();
        assert!(!fresh.cancellation_token().is_cancelled());
        let state = service.state().await.unwrap();
        assert!(state.agent_active);
        assert_eq!(state.finite_task_active, !barrier_fails);
        assert_eq!(
            driver.native.lock().unwrap().finite_starts,
            if barrier_fails { 1 } else { 2 }
        );
        drop(fresh);
        drop(agent);
        service.shutdown().await.unwrap();
    }
}

#[test]
fn generation_boundary_reserves_a_nonwrapping_terminal_zero_and_is_process_wide() {
    let counter = AtomicU64::new(u64::MAX - 2);
    assert_eq!(advance_generation(&counter).unwrap(), u64::MAX - 1);
    assert_eq!(
        advance_generation(&counter).unwrap_err().code(),
        "mobile_background_exhausted"
    );
    assert_eq!(counter.load(Ordering::SeqCst), u64::MAX - 1);
    let first = next_generation().unwrap();
    let second = next_generation().unwrap();
    assert!(second > first);
}
