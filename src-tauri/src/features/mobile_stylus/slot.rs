use crate::core::error::AppError;
use std::sync::Mutex;
use tauri_plugin_agentero_mobile::{StylusState, StylusTarget};

#[derive(Default)]
pub(super) struct TargetSlot {
    desired: Option<StylusTarget>,
    confirmed: bool,
}

impl TargetSlot {
    pub fn prepare(
        &mut self,
        window: &str,
        token: &str,
        active: bool,
        generation: impl FnOnce() -> Result<u64, AppError>,
    ) -> Result<Option<StylusTarget>, AppError> {
        if !active
            && !self
                .desired
                .as_ref()
                .is_some_and(|value| value.window_label == window && value.target_token == token)
        {
            return Ok(None);
        }
        let payload = StylusTarget {
            generation: generation()?.to_string(),
            window_label: window.into(),
            target_token: token.into(),
            active,
        };
        self.desired = Some(payload.clone());
        self.confirmed = false;
        Ok(Some(payload))
    }

    /// Termination revokes routing synchronously, even if generation allocation
    /// fails. Keep the token for cleanup; repeated termination is coalesced.
    #[cfg(any(target_os = "ios", test))]
    pub fn invalidate_window(
        &mut self,
        window: &str,
        generation: impl FnOnce() -> Result<u64, AppError>,
    ) -> Result<Option<StylusTarget>, AppError> {
        let Some(desired) = self
            .desired
            .as_mut()
            .filter(|desired| desired.active && desired.window_label == window)
        else {
            return Ok(None);
        };
        desired.active = false;
        self.confirmed = false;
        let token = desired.target_token.clone();
        self.prepare(window, &token, false, generation)
    }

    fn finish_update(&mut self, payload: &StylusTarget, success: bool) {
        // Invalidation may have revoked this active update before generation
        // allocation failed. Its old ACK must not clear cleanup authority.
        if self
            .desired
            .as_ref()
            .is_some_and(|desired| desired.active == payload.active)
        {
            self.finish(&payload.generation, success);
        }
    }

    fn finish(&mut self, generation: &str, success: bool) {
        let Some(desired) = self
            .desired
            .as_ref()
            .filter(|value| value.generation == generation)
        else {
            return;
        };
        if success && !desired.active {
            self.desired = None;
            self.confirmed = false;
        } else {
            // A failed or lost ACK may follow a successful native installation.
            // Retain cleanup authority, while denying all uncertain dispatch.
            self.confirmed = success;
        }
    }

    #[cfg(any(mobile, test))]
    pub fn routes(&self, window: &str, token: &str) -> bool {
        self.confirmed
            && self.desired.as_ref().is_some_and(|value| {
                value.active && value.window_label == window && value.target_token == token
            })
    }
}

pub(super) async fn complete_update(
    slot: &Mutex<TargetSlot>,
    payload: StylusTarget,
    operation: impl std::future::Future<Output = Result<StylusState, AppError>>,
    budget: std::time::Duration,
) -> Result<StylusState, AppError> {
    let result = tokio::time::timeout(budget, operation)
        .await
        .map_err(|_| AppError::domain("stylus_unavailable", "Stylus target update timed out"))
        .and_then(|result| result);
    if let Ok(mut target) = slot.lock() {
        target.finish_update(&payload, result.is_ok());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;

    #[tokio::test]
    async fn installed_native_error_retains_cleanup_and_never_dispatches_uncertain_target() {
        let slot = Arc::new(Mutex::new(TargetSlot::default()));
        let payload = slot
            .lock()
            .unwrap()
            .prepare("main", "old", true, || Ok(1))
            .unwrap()
            .unwrap();
        let installed = Arc::new(AtomicBool::new(false));
        let (ack, response) = tokio::sync::oneshot::channel::<Result<StylusState, AppError>>();
        let (entered, installed_ack) = tokio::sync::oneshot::channel();
        let task_slot = slot.clone();
        let native_installed = installed.clone();
        let task = tokio::spawn(async move {
            complete_update(
                &task_slot,
                payload,
                async {
                    native_installed.store(true, Ordering::SeqCst);
                    let _ = entered.send(());
                    response.await.unwrap()
                },
                Duration::from_secs(5),
            )
            .await
        });
        installed_ack.await.unwrap();
        assert!(installed.load(Ordering::SeqCst));
        assert!(!slot.lock().unwrap().routes("main", "old"));
        ack.send(Err(AppError::message("lost ACK after installation")))
            .unwrap();
        assert!(task.await.unwrap().is_err());
        let cleanup = slot
            .lock()
            .unwrap()
            .prepare("main", "old", false, || Ok(2))
            .unwrap()
            .unwrap();
        assert!(!cleanup.active);
        assert_eq!(cleanup.generation, "2");
        complete_update(
            &slot,
            cleanup,
            async {
                installed.store(false, Ordering::SeqCst);
                Ok(StylusState::default())
            },
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert!(!installed.load(Ordering::SeqCst));
        assert!(slot.lock().unwrap().desired.is_none());
    }

    #[tokio::test]
    async fn timed_out_native_update_and_failed_cleanup_keep_a_retryable_fence() {
        let slot = Mutex::new(TargetSlot::default());
        let payload = slot
            .lock()
            .unwrap()
            .prepare("main", "old", true, || Ok(1))
            .unwrap()
            .unwrap();
        assert!(complete_update(
            &slot,
            payload,
            std::future::pending(),
            Duration::from_millis(1)
        )
        .await
        .is_err());
        assert!(!slot.lock().unwrap().routes("main", "old"));
        let cleanup = slot
            .lock()
            .unwrap()
            .prepare("main", "old", false, || Ok(2))
            .unwrap()
            .unwrap();
        assert!(complete_update(
            &slot,
            cleanup,
            async { Err(AppError::message("cleanup ACK lost")) },
            Duration::from_secs(5)
        )
        .await
        .is_err());
        assert!(slot
            .lock()
            .unwrap()
            .prepare("main", "old", false, || Ok(3))
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn termination_revokes_confirmed_and_pending_routes_before_native_cleanup_await() {
        for confirmed in [false, true] {
            let slot = Arc::new(Mutex::new(TargetSlot::default()));
            let active = slot
                .lock()
                .unwrap()
                .prepare("main", "old", true, || Ok(1))
                .unwrap()
                .unwrap();
            let (ack, response) = tokio::sync::oneshot::channel();
            let pending = if confirmed {
                complete_update(
                    &slot,
                    active.clone(),
                    async { Ok(StylusState::default()) },
                    Duration::from_secs(5),
                )
                .await
                .unwrap();
                assert!(slot.lock().unwrap().routes("main", "old"));
                None
            } else {
                let task_slot = slot.clone();
                let payload = active.clone();
                Some(tokio::spawn(async move {
                    complete_update(
                        &task_slot,
                        payload,
                        async { response.await.unwrap() },
                        Duration::from_secs(5),
                    )
                    .await
                }))
            };
            let cleanup = slot
                .lock()
                .unwrap()
                .invalidate_window("main", || Ok(2))
                .unwrap()
                .unwrap();
            assert!(!slot.lock().unwrap().routes("main", "old"));
            assert!(!cleanup.active);
            assert_eq!(cleanup.target_token, "old");
            let installed = Arc::new(AtomicBool::new(false));
            let native_installed = installed.clone();
            let (entered, ready) = tokio::sync::oneshot::channel();
            let (finish, completed) = tokio::sync::oneshot::channel();
            let task_slot = slot.clone();
            let cleanup_task = tokio::spawn(async move {
                complete_update(
                    &task_slot,
                    cleanup,
                    async {
                        native_installed.store(true, Ordering::SeqCst);
                        entered.send(()).unwrap();
                        completed.await.unwrap()
                    },
                    Duration::from_secs(5),
                )
                .await
            });
            ready.await.unwrap();
            assert!(installed.load(Ordering::SeqCst));
            assert!(!slot.lock().unwrap().routes("main", "old"));
            if let Some(pending) = pending {
                ack.send(Ok(StylusState::default())).unwrap();
                pending.await.unwrap().unwrap();
                assert!(!slot.lock().unwrap().routes("main", "old"));
                assert_eq!(
                    slot.lock().unwrap().desired.as_ref().unwrap().generation,
                    "2"
                );
            }
            finish
                .send(Err(AppError::message("native cleanup unavailable")))
                .unwrap();
            assert!(cleanup_task.await.unwrap().is_err());
            let mut target = slot.lock().unwrap();
            assert!(!target.routes("main", "old"));
            assert!(
                target.desired.is_some(),
                "failed cleanup must retain authority"
            );
            assert!(target
                .invalidate_window("main", || panic!(
                    "repeated termination allocated another generation"
                ))
                .unwrap()
                .is_none());
        }
    }

    #[test]
    fn unrelated_or_repeated_termination_does_not_allocate_generation_or_revoke_other_window() {
        let mut slot = TargetSlot::default();
        assert!(slot
            .invalidate_window("main", || panic!("empty slot allocated a generation"))
            .unwrap()
            .is_none());
        slot.prepare("comparison", "new", true, || Ok(1)).unwrap();
        slot.finish("1", true);
        assert!(slot
            .invalidate_window("main", || panic!(
                "unrelated termination allocated a generation"
            ))
            .unwrap()
            .is_none());
        assert!(slot.routes("comparison", "new"));
        let cleanup = slot
            .invalidate_window("comparison", || Ok(2))
            .unwrap()
            .unwrap();
        assert_eq!(cleanup.generation, "2");
        assert!(!cleanup.active);
        assert!(!slot.routes("comparison", "new"));
        assert!(slot
            .invalidate_window("comparison", || panic!(
                "inactive target allocated another generation"
            ))
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn generation_exhaustion_fails_closed_and_old_active_ack_cannot_clear_cleanup_authority()
    {
        let slot = Mutex::new(TargetSlot::default());
        let active = slot
            .lock()
            .unwrap()
            .prepare("main", "old", true, || Ok(u64::MAX))
            .unwrap()
            .unwrap();
        slot.lock().unwrap().finish(&active.generation, true);
        assert!(slot.lock().unwrap().routes("main", "old"));
        let error = slot
            .lock()
            .unwrap()
            .invalidate_window("main", || {
                Err(AppError::domain(
                    "stylus_unavailable",
                    "Stylus generation exhausted",
                ))
            })
            .unwrap_err();
        assert_eq!(error.code(), "stylus_unavailable");
        assert!(!slot.lock().unwrap().routes("main", "old"));
        complete_update(
            &slot,
            active,
            async { Ok(StylusState::default()) },
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        let target = slot.lock().unwrap();
        assert!(!target.routes("main", "old"));
        let desired = target.desired.as_ref().unwrap();
        assert!(!desired.active);
        assert_eq!(desired.target_token, "old");
        assert!(!target.confirmed);
    }

    #[tokio::test]
    async fn late_termination_cleanup_and_old_active_ack_cannot_remove_new_window_target() {
        let slot = Mutex::new(TargetSlot::default());
        let old = slot
            .lock()
            .unwrap()
            .prepare("main", "old", true, || Ok(1))
            .unwrap()
            .unwrap();
        let cleanup = slot
            .lock()
            .unwrap()
            .invalidate_window("main", || Ok(2))
            .unwrap()
            .unwrap();
        let fresh = slot
            .lock()
            .unwrap()
            .prepare("comparison", "fresh", true, || Ok(3))
            .unwrap()
            .unwrap();
        complete_update(
            &slot,
            fresh,
            async { Ok(StylusState::default()) },
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert!(slot.lock().unwrap().routes("comparison", "fresh"));
        complete_update(
            &slot,
            old,
            async { Ok(StylusState::default()) },
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        complete_update(
            &slot,
            cleanup,
            async { Ok(StylusState::default()) },
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert!(slot.lock().unwrap().routes("comparison", "fresh"));
        assert!(!slot.lock().unwrap().routes("main", "old"));
    }

    #[test]
    fn old_ack_and_old_cleanup_cannot_admit_or_remove_new_target() {
        let mut slot = TargetSlot::default();
        slot.prepare("main", "old", true, || Ok(1)).unwrap();
        slot.prepare("comparison", "new", true, || Ok(2)).unwrap();
        slot.finish("1", true);
        assert!(!slot.routes("comparison", "new"));
        slot.finish("2", true);
        assert!(slot.routes("comparison", "new"));
        assert!(slot
            .prepare("main", "old", false, || panic!(
                "stale cleanup must not allocate a native generation"
            ))
            .unwrap()
            .is_none());
        slot.finish("1", false);
        assert!(slot.routes("comparison", "new"));
    }
}
