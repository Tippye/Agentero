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
        target.finish(&payload.generation, result.is_ok());
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
