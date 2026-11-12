use super::*;
use crate::integration::bridge::identity::{
    mobile_tests::{Fixture, Gate},
    LegacySource,
};
use crate::integration::credentials::CredentialError;
use std::sync::atomic::{AtomicUsize, Ordering};

fn profile(host: &str) -> BridgeClientProfile {
    let offer = BridgeOffer {
        v: 1,
        server_id: format!("agt_{host}_abcdefghijk"),
        host_public_key_b64: URL_SAFE_NO_PAD.encode([4u8; 32]),
        relay: super::super::RelayOffer {
            endpoint: "wss://relay.example.invalid".into(),
        },
        host_name: host.into(),
        pin: false,
    };
    BridgeClientProfile {
        offer_url: offer.to_pair_url().unwrap().to_string(),
        device_name: "Tablet".into(),
        paired: true,
    }
}
fn controller(fixture: &Fixture) -> Arc<BridgeClientController> {
    Arc::new(BridgeClientController::with_repository(
        fixture.repository.clone(),
        fixture.profiles(),
    ))
}

#[tokio::test]
async fn rejected_preconditions_preserve_old_runtime_profile_and_signer() {
    let fixture = Fixture::new();
    let identity = BridgeClientIdentity::create();
    fixture.seed_native(&identity);
    let old = profile("Old");
    fixture.profiles().save(&old).unwrap();
    let raw = fixture.profiles().snapshot().unwrap();
    let controller = controller(&fixture);
    let mut old_launch = None;
    controller
        .resume_owned(|launch| old_launch = Some(launch))
        .await
        .unwrap();
    let old_launch = old_launch.unwrap();
    let reads = fixture.backend.reads.load(Ordering::SeqCst);
    assert!(controller
        .connect_owned("bad-offer".into(), "Tablet".into(), |_| panic!(
            "invalid offer launched transport"
        ))
        .await
        .is_err());
    assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), reads);
    *fixture.backend.read_fault.lock().unwrap() = Some(CredentialError::Locked);
    let candidate = profile("New");
    assert_eq!(
        controller
            .connect_owned(candidate.offer_url, candidate.device_name, |_| panic!(
                "locked signer launched transport"
            ))
            .await
            .unwrap_err()
            .code(),
        "bridge_identity_locked"
    );
    assert!(!*old_launch.stop.borrow());
    assert!(old_launch.owner.is_current());
    assert_eq!(fixture.profiles().snapshot().unwrap(), raw);
    assert_eq!(fixture.native_identity(), identity);
}

#[tokio::test]
async fn paired_resume_missing_identity_never_generates_or_starts_network_and_status_keeps_metadata(
) {
    let fixture = Fixture::new();
    let paired = profile("Research");
    fixture.profiles().save(&paired).unwrap();
    let controller = controller(&fixture);
    assert_eq!(
        controller
            .resume_owned(|_| panic!("missing signer launched transport"))
            .await
            .unwrap_err()
            .code(),
        "bridge_identity_missing"
    );
    assert!(fixture.backend.writes.lock().unwrap().is_empty());
    let reads = fixture.backend.reads.load(Ordering::SeqCst);
    let status = controller.status().unwrap();
    assert!(!status.connected);
    assert!(status.paired);
    assert_eq!(status.host_name.as_deref(), Some("Research"));
    assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), reads);
}

#[tokio::test]
async fn pairing_candidate_waits_for_matching_generation_and_ignores_stale_pair_ok() {
    let fixture = Fixture::new();
    fixture.seed_native(&BridgeClientIdentity::create());
    let old = profile("Old");
    fixture.profiles().save(&old).unwrap();
    let raw = fixture.profiles().snapshot().unwrap();
    let controller = controller(&fixture);
    let mut first = None;
    let candidate = profile("First");
    controller
        .connect_owned(candidate.offer_url, candidate.device_name, |launch| {
            first = Some(launch)
        })
        .await
        .unwrap();
    let first = first.unwrap();
    assert_eq!(fixture.profiles().snapshot().unwrap(), raw);
    let mut second = None;
    let candidate = profile("Second");
    controller
        .connect_owned(
            candidate.offer_url.clone(),
            candidate.device_name.clone(),
            |launch| second = Some(launch),
        )
        .await
        .unwrap();
    let second = second.unwrap();
    assert!(*first.stop.borrow());
    assert!(!first.owner.mark_paired().await.unwrap());
    assert_eq!(fixture.profiles().snapshot().unwrap(), raw);
    assert!(second.owner.mark_paired().await.unwrap());
    assert_eq!(fixture.profiles().load().unwrap(), Some(candidate));
    assert!(controller.status().unwrap().paired);
}

#[tokio::test]
async fn profile_changed_during_pairing_is_not_overwritten_by_pair_ok() {
    let fixture = Fixture::new();
    fixture.seed_native(&BridgeClientIdentity::create());
    fixture.profiles().save(&profile("Old")).unwrap();
    let controller = controller(&fixture);
    let mut pending = None;
    let candidate = profile("Candidate");
    controller
        .connect_owned(candidate.offer_url, candidate.device_name, |launch| {
            pending = Some(launch)
        })
        .await
        .unwrap();
    let mut changed = profile("Changed");
    changed.paired = false;
    fixture.profiles().save(&changed).unwrap();
    let raw = fixture.profiles().snapshot().unwrap();
    assert_eq!(
        pending
            .unwrap()
            .owner
            .mark_paired()
            .await
            .unwrap_err()
            .code(),
        "bridge_profile_changed"
    );
    assert_eq!(fixture.profiles().snapshot().unwrap(), raw);
    assert!(!controller.status().unwrap().paired);
}

#[tokio::test]
async fn resume_and_disconnect_are_idempotent_transport_operations_without_secret_io() {
    let fixture = Fixture::new();
    fixture.seed_native(&BridgeClientIdentity::create());
    fixture.profiles().save(&profile("Research")).unwrap();
    let raw = fixture.profiles().snapshot().unwrap();
    let secret = fixture.backend.values.lock().unwrap().clone();
    let controller = controller(&fixture);
    let mut active = None;
    controller
        .resume_owned(|launch| active = Some(launch))
        .await
        .unwrap();
    let active = active.unwrap();
    let reads = fixture.backend.reads.load(Ordering::SeqCst);
    *fixture.backend.read_fault.lock().unwrap() = Some(CredentialError::Locked);
    assert!(
        controller
            .resume_owned(|_| panic!("idempotent resume restarted transport"))
            .await
            .unwrap()
            .paired
    );
    assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), reads);
    assert!(!*active.stop.borrow());
    controller.disconnect().unwrap();
    controller.disconnect().unwrap();
    assert!(*active.stop.borrow());
    let status = controller.status().unwrap();
    assert!(status.paired);
    assert!(!status.connected);
    assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), reads);
    assert_eq!(fixture.backend.values.lock().unwrap().clone(), secret);
    assert_eq!(fixture.profiles().snapshot().unwrap(), raw);
}

#[tokio::test]
async fn disconnect_during_native_preparation_prevents_late_runtime_install() {
    let fixture = Fixture::new();
    fixture.seed_native(&BridgeClientIdentity::create());
    fixture.profiles().save(&profile("Research")).unwrap();
    let controller = controller(&fixture);
    let gate = Arc::new(Gate::default());
    *fixture.backend.read_gate.lock().unwrap() = Some(gate.clone());
    let pending = controller.clone();
    let task = tokio::spawn(async move {
        pending
            .resume_owned(|_| panic!("late runtime installed after disconnect"))
            .await
    });
    gate.entered.notified().await;
    controller.disconnect().unwrap();
    gate.release();
    assert_eq!(
        task.await.unwrap().unwrap_err().code(),
        "bridge_client_stale"
    );
    assert!(controller.state.lock().unwrap().runtime.is_none());
    assert!(controller.status().unwrap().paired);
}

#[tokio::test]
async fn disconnect_also_invalidates_resume_queued_before_lifecycle_lock() {
    let fixture = Fixture::new();
    fixture.seed_native(&BridgeClientIdentity::create());
    fixture.profiles().save(&profile("Research")).unwrap();
    let controller = controller(&fixture);
    let guard = controller.lifecycle.lock().await;
    let queued = Arc::new(tokio::sync::Notify::new());
    let entering = queued.clone();
    let pending = controller.clone();
    let task = tokio::spawn(async move {
        entering.notify_one();
        pending
            .resume_owned(|_| panic!("queued resume survived disconnect"))
            .await
    });
    queued.notified().await;
    controller.disconnect().unwrap();
    drop(guard);
    assert_eq!(
        task.await.unwrap().unwrap_err().code(),
        "bridge_client_stale"
    );
    assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn concurrent_connect_and_resume_share_whole_lifecycle_without_duplicate_identity_or_runtime()
{
    let fixture = Fixture::new();
    fixture.profiles().save(&profile("Old")).unwrap();
    let old = fixture.profiles().snapshot().unwrap();
    let controller = controller(&fixture);
    let gate = Arc::new(Gate::default());
    *fixture.backend.write_gate.lock().unwrap() = Some(gate.clone());
    let starts = Arc::new(AtomicUsize::new(0));
    let count = starts.clone();
    let pairing = controller.clone();
    let candidate = profile("New");
    let task = tokio::spawn(async move {
        pairing
            .connect_owned(candidate.offer_url, candidate.device_name, move |_| {
                count.fetch_add(1, Ordering::SeqCst);
            })
            .await
    });
    gate.entered.notified().await;
    let pending = controller.clone();
    let count = starts.clone();
    let resume = tokio::spawn(async move {
        pending
            .resume_owned(move |_| {
                count.fetch_add(1, Ordering::SeqCst);
            })
            .await
    });
    assert!(controller.lifecycle.try_lock().is_err());
    gate.release();
    task.await.unwrap().unwrap();
    resume.await.unwrap().unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.backend.writes.lock().unwrap().len(), 1);
    assert_eq!(fixture.profiles().snapshot().unwrap(), old);
}

#[tokio::test]
async fn reset_waits_for_verified_tombstone_then_retains_marker_on_cleanup_failure_and_retries() {
    let fixture = Fixture::new();
    let identity = BridgeClientIdentity::create();
    fixture.seed_native(&identity);
    fixture.profiles().save(&profile("Old")).unwrap();
    let old = fixture.profiles().snapshot().unwrap();
    let controller = controller(&fixture);
    let mut active = None;
    controller
        .resume_owned(|launch| active = Some(launch))
        .await
        .unwrap();
    let active = active.unwrap();
    fixture.put_legacy(LegacySource::Json, &identity);
    *fixture.backend.write_fault.lock().unwrap() = Some(CredentialError::Unavailable);
    assert_eq!(
        controller.reset_identity().await.unwrap_err().code(),
        "bridge_identity_unavailable"
    );
    assert!(!*active.stop.borrow());
    assert_eq!(fixture.profiles().snapshot().unwrap(), old);
    assert!(fixture
        .legacy
        .values
        .lock()
        .unwrap()
        .contains_key(&LegacySource::Json));
    *fixture.backend.write_fault.lock().unwrap() = None;
    fixture.legacy.remove_fails.store(true, Ordering::SeqCst);
    assert_eq!(
        controller.reset_identity().await.unwrap_err().code(),
        "bridge_identity_cleanup_pending"
    );
    assert!(*active.stop.borrow());
    assert!(!active.owner.mark_paired().await.unwrap());
    let restart = BridgeClientController::with_repository(fixture.restart(), fixture.profiles());
    assert_eq!(
        restart
            .resume_owned(|_| panic!("partial reset resumed transport"))
            .await
            .unwrap_err()
            .code(),
        "bridge_identity_cleanup_pending"
    );
    fixture.legacy.remove_fails.store(false, Ordering::SeqCst);
    let status = restart.reset_identity().await.unwrap();
    assert!(!status.paired);
    assert!(!status.connected);
    assert!(fixture.profiles().load().unwrap().is_none());
    assert!(fixture.legacy.values.lock().unwrap().is_empty());
    let mut next = None;
    let candidate = profile("New");
    restart
        .connect_owned(candidate.offer_url, candidate.device_name, |launch| {
            next = Some(launch)
        })
        .await
        .unwrap();
    assert_ne!(next.unwrap().identity.device_id, identity.device_id);
}

#[tokio::test]
async fn unknown_completion_write_reports_failure_and_retries_identical_cleared_marker() {
    let fixture = Fixture::new();
    fixture.seed_native(&BridgeClientIdentity::create());
    fixture.profiles().save(&profile("Old")).unwrap();
    let backend = fixture.backend.clone();
    *fixture.backend.after_write.lock().unwrap() = Some(Box::new(move || {
        *backend.write_fault.lock().unwrap() = Some(CredentialError::Unavailable);
        backend.unknown_write.store(true, Ordering::SeqCst);
    }));
    let controller = controller(&fixture);
    assert_eq!(
        controller.reset_identity().await.unwrap_err().code(),
        "bridge_identity_unavailable"
    );
    assert!(fixture.profiles().load().unwrap().is_none());
    *fixture.backend.write_fault.lock().unwrap() = None;
    assert!(!controller.reset_identity().await.unwrap().paired);
    let writes = fixture.backend.writes.lock().unwrap();
    assert_eq!(writes[1], writes[2]);
}

#[tokio::test]
async fn stopped_transport_drops_admitted_send_and_never_polls_next_rpc_or_proof() {
    for reset in [false, true] {
        let fixture = Fixture::new();
        fixture.seed_native(&BridgeClientIdentity::create());
        fixture.profiles().save(&profile("Old")).unwrap();
        let controller = controller(&fixture);
        let mut active = None;
        controller
            .resume_owned(|launch| active = Some(launch))
            .await
            .unwrap();
        let ClientLaunch {
            owner, mut stop, ..
        } = active.unwrap();
        let entered = Arc::new(tokio::sync::Notify::new());
        let sending = entered.clone();
        let emitted = Arc::new(AtomicUsize::new(0));
        let sent = emitted.clone();
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let did_drop = dropped.clone();
        struct PendingWrite(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for PendingWrite {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let task = tokio::spawn(async move {
            let interrupted = owner
                .while_current(&mut stop, async {
                    let _pending = PendingWrite(did_drop);
                    // The first write was admitted; cancellation cannot promise undo.
                    sent.fetch_add(1, Ordering::SeqCst);
                    sending.notify_one();
                    std::future::pending::<()>().await;
                })
                .await
                .unwrap_err();
            for _ in ["next RPC", "DeviceProof"] {
                assert!(owner
                    .while_current(&mut stop, async {
                        sent.fetch_add(1, Ordering::SeqCst);
                    })
                    .await
                    .is_err());
            }
            interrupted
        });
        entered.notified().await;
        if reset {
            controller.reset_identity().await.unwrap();
        } else {
            controller.disconnect().unwrap();
        }
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(error.to_string().contains("may already have executed"));
        assert_eq!(emitted.load(Ordering::SeqCst), 1);
        assert!(dropped.load(Ordering::SeqCst));
    }
}

#[tokio::test]
async fn generation_changed_during_read_is_rejected_before_challenge_proof_or_next_command() {
    let fixture = Fixture::new();
    fixture.seed_native(&BridgeClientIdentity::create());
    fixture.profiles().save(&profile("Old")).unwrap();
    let controller = controller(&fixture);
    let mut active = None;
    controller
        .resume_owned(|launch| active = Some(launch))
        .await
        .unwrap();
    let ClientLaunch {
        owner,
        mut stop,
        mut commands,
        ..
    } = active.unwrap();
    let (pending_sender, pending_reply) = oneshot::channel();
    let mut pending = HashMap::from([("already-admitted".into(), pending_sender)]);
    let (queued_sender, queued_reply) = oneshot::channel();
    let sender = controller
        .state
        .lock()
        .unwrap()
        .runtime
        .as_ref()
        .unwrap()
        .commands
        .clone();
    assert!(sender
        .send(ClientCommand::Rpc {
            transport_epoch: 1,
            id: "queued".into(),
            method: "test".into(),
            params: Value::Null,
            response: queued_sender
        })
        .await
        .is_ok());
    let read = owner
        .while_current(&mut stop, async {
            // Isolate the post-await generation fence independently of watch delivery.
            controller.state.lock().unwrap().generation += 1;
            BridgeMessage::DeviceChallenge {
                nonce_b64: URL_SAFE_NO_PAD.encode(b"challenge"),
            }
        })
        .await;
    assert!(!*stop.borrow());
    assert!(read.is_err());
    let proof_sent = AtomicUsize::new(0);
    assert!(owner
        .while_current(&mut stop, async {
            proof_sent.fetch_add(1, Ordering::SeqCst);
        })
        .await
        .is_err());
    assert_eq!(proof_sent.load(Ordering::SeqCst), 0);
    fail_pending(&mut pending, UNCERTAIN_TRANSPORT);
    fail_queued(&mut commands);
    assert!(pending_reply
        .await
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("may already have executed"));
    assert!(queued_reply
        .await
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("may already have executed"));
}

async fn paired_runtime(fixture: &Fixture) -> (Arc<BridgeClientController>, ClientLaunch) {
    fixture.seed_native(&BridgeClientIdentity::create());
    fixture.profiles().save(&profile("Research")).unwrap();
    let controller = controller(fixture);
    let mut launch = None;
    controller
        .resume_owned(|value| launch = Some(value))
        .await
        .unwrap();
    (controller, launch.unwrap())
}

#[tokio::test]
async fn network_hint_never_restores_disconnected_profiles_or_reads_identity() {
    let fixture = Fixture::new();
    fixture.profiles().save(&profile("SavedOnly")).unwrap();
    let raw = fixture.profiles().snapshot().unwrap();
    *fixture.backend.read_fault.lock().unwrap() = Some(CredentialError::Locked);
    let controller = controller(&fixture);
    for _ in 0..32 {
        controller.network_changed().unwrap();
    }
    assert!(controller.state.lock().unwrap().runtime.is_none());
    assert_eq!(controller.state.lock().unwrap().generation, 0);
    assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), 0);
    assert!(fixture.backend.writes.lock().unwrap().is_empty());
    assert_eq!(fixture.profiles().snapshot().unwrap(), raw);

    *fixture.backend.read_fault.lock().unwrap() = None;
    fixture.seed_native(&BridgeClientIdentity::create());
    let mut launch = None;
    controller
        .resume_owned(|value| launch = Some(value))
        .await
        .unwrap();
    let launch = launch.unwrap();
    controller.disconnect().unwrap();
    let reads = fixture.backend.reads.load(Ordering::SeqCst);
    controller.network_changed().unwrap();
    assert!(*launch.stop.borrow());
    assert!(!launch.owner.is_current());
    assert!(controller.state.lock().unwrap().runtime.is_none());
    assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), reads);
    assert_eq!(fixture.profiles().snapshot().unwrap(), raw);
    controller.reset_identity().await.unwrap();
    let reads = fixture.backend.reads.load(Ordering::SeqCst);
    controller.network_changed().unwrap();
    assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), reads);
    assert!(controller.state.lock().unwrap().runtime.is_none());
    assert!(fixture.profiles().snapshot().unwrap().is_none());
}

#[tokio::test]
async fn network_hint_cancels_connect_handshake_read_and_write_without_reusing_old_proof() {
    for phase in ["connect", "handshake", "session read", "session write"] {
        let fixture = Fixture::new();
        let (controller, launch) = paired_runtime(&fixture).await;
        let raw = fixture.profiles().snapshot().unwrap();
        let reads = fixture.backend.reads.load(Ordering::SeqCst);
        let mut network = launch.owner.network.clone();
        let attempt = launch.owner.begin_transport(&mut network).unwrap();
        let old = attempt.clone();
        let mut stop = launch.stop.clone();
        let (entered, ready) = oneshot::channel();
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct PendingIo(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for PendingIo {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let did_drop = dropped.clone();
        let task = tokio::spawn(async move {
            attempt
                .while_current(&mut stop, async {
                    let _io = PendingIo(did_drop);
                    let _ = entered.send(());
                    std::future::pending::<()>().await;
                })
                .await
        });
        ready.await.unwrap();
        controller.network_changed().unwrap();
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect(phase)
            .unwrap()
            .unwrap_err();
        assert!(
            error.to_string().contains("may already have executed"),
            "{phase}"
        );
        assert!(dropped.load(Ordering::SeqCst), "{phase}");
        assert!(!old.is_current());
        assert!(old
            .sign_challenge(&launch.identity, b"late challenge")
            .is_err());
        assert!(!old.mark_paired().await.unwrap());
        assert!(old.ready().is_err());
        assert!(controller
            .rpc("agent_run_once".into(), Value::Null)
            .await
            .is_err());
        let next = launch.owner.begin_transport(&mut network).unwrap();
        let mut stop = launch.stop.clone();
        assert_eq!(next.while_current(&mut stop, async { 7 }).await.unwrap(), 7);
        assert!(next
            .sign_challenge(&launch.identity, b"new challenge")
            .is_ok());
        assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), reads);
        assert_eq!(fixture.profiles().snapshot().unwrap(), raw);
    }
}

#[tokio::test]
async fn blocked_old_rpc_keeps_admission_epoch_after_drain_and_new_session_readiness() {
    let fixture = Fixture::new();
    let (controller, mut launch) = paired_runtime(&fixture).await;
    let mut network = launch.owner.network.clone();
    let old = launch.owner.begin_transport(&mut network).unwrap();
    old.ready().unwrap();
    let (sender, epoch) = {
        let state = controller.state.lock().unwrap();
        let runtime = state.runtime.as_ref().unwrap();
        (runtime.commands.clone(), runtime.transport_epoch)
    };
    let mut queued = Vec::new();
    for index in 0..64 {
        let (response, reply) = oneshot::channel();
        sender
            .send(ClientCommand::Rpc {
                transport_epoch: epoch,
                id: format!("old-{index}"),
                method: "agent_run_once".into(),
                params: Value::Null,
                response,
            })
            .await
            .unwrap();
        queued.push(reply);
    }
    assert_eq!(sender.capacity(), 0);
    let mut blocked = Box::pin(controller.rpc("old blocked mutation".into(), Value::Null));
    assert!(futures_util::poll!(blocked.as_mut()).is_pending());
    controller.network_changed().unwrap();
    fail_queued(&mut launch.commands);
    for reply in queued {
        assert!(reply.await.unwrap().is_err());
    }
    let next = launch.owner.begin_transport(&mut network).unwrap();
    assert!(controller
        .rpc("too early".into(), Value::Null)
        .await
        .is_err());
    next.ready().unwrap();
    // The pre-hint producer resumes only after the one-time drain and after the
    // next session is ready. It still carries the old epoch, never a fresh one.
    assert!(futures_util::poll!(blocked.as_mut()).is_pending());
    let ClientCommand::Rpc {
        transport_epoch,
        method,
        response,
        ..
    } = launch.commands.recv().await.unwrap();
    assert_eq!(method, "old blocked mutation");
    assert_eq!(transport_epoch, epoch);
    assert!(!next.accepts_command(transport_epoch));
    response.send(Err(transport_interrupted())).unwrap();
    assert!(blocked
        .await
        .unwrap_err()
        .to_string()
        .contains("may already have executed"));

    let mut fresh = Box::pin(controller.rpc("fresh user read".into(), Value::Null));
    assert!(futures_util::poll!(fresh.as_mut()).is_pending());
    let ClientCommand::Rpc {
        transport_epoch,
        method,
        response,
        ..
    } = launch.commands.recv().await.unwrap();
    assert_eq!(method, "fresh user read");
    assert!(next.accepts_command(transport_epoch));
    response
        .send(Ok(serde_json::json!({"fresh": true})))
        .unwrap();
    assert_eq!(fresh.await.unwrap(), serde_json::json!({"fresh": true}));
}

#[tokio::test]
async fn network_bursts_wake_existing_backoff_once_without_new_runtime_or_secret_access() {
    let fixture = Fixture::new();
    let (controller, launch) = paired_runtime(&fixture).await;
    let reads = fixture.backend.reads.load(Ordering::SeqCst);
    let raw = fixture.profiles().snapshot().unwrap();
    let generation = controller.state.lock().unwrap().generation;
    let sender = controller
        .state
        .lock()
        .unwrap()
        .runtime
        .as_ref()
        .unwrap()
        .commands
        .clone();
    let mut network = launch.owner.network.clone();
    let mut stop = launch.stop.clone();
    let mut backoff = Box::pin(wait_for_retry(&launch.owner, &mut stop, &mut network));
    assert!(futures_util::poll!(backoff.as_mut()).is_pending());
    for _ in 0..64 {
        controller.network_changed().unwrap();
    }
    tokio::time::timeout(Duration::from_secs(1), backoff)
        .await
        .unwrap()
        .unwrap();
    assert!(!network.has_changed().unwrap());
    let next = launch.owner.begin_transport(&mut network).unwrap();
    let state = controller.state.lock().unwrap();
    let runtime = state.runtime.as_ref().unwrap();
    assert_eq!(state.generation, generation);
    assert!(runtime.commands.same_channel(&sender));
    assert_eq!(next.transport_epoch, Some(runtime.transport_epoch));
    assert_eq!(runtime.transport_epoch, 65);
    assert!(!runtime.accepting);
    drop(state);
    assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), reads);
    assert_eq!(fixture.profiles().snapshot().unwrap(), raw);
}

#[tokio::test]
async fn network_hint_parks_unpaired_candidate_and_rejects_pair_ack_waiting_for_lifecycle() {
    let fixture = Fixture::new();
    fixture.seed_native(&BridgeClientIdentity::create());
    fixture.profiles().save(&profile("OldSaved")).unwrap();
    let raw = fixture.profiles().snapshot().unwrap();
    let controller = controller(&fixture);
    let candidate = profile("ExplicitCandidate");
    let mut launch = None;
    controller
        .connect_owned(candidate.offer_url, candidate.device_name, |value| {
            launch = Some(value)
        })
        .await
        .unwrap();
    let launch = launch.unwrap();
    let mut network = launch.owner.network.clone();
    let attempt = launch.owner.begin_transport(&mut network).unwrap();
    let guard = controller.lifecycle.lock().await;
    let (entered, ready) = oneshot::channel();
    let ack = tokio::spawn(async move {
        let _ = entered.send(());
        attempt.mark_paired().await
    });
    ready.await.unwrap();
    let reads = fixture.backend.reads.load(Ordering::SeqCst);
    controller.network_changed().unwrap();
    drop(guard);
    assert!(!ack.await.unwrap().unwrap());
    assert!(*launch.stop.borrow());
    assert!(!launch.owner.is_current());
    assert!(launch.owner.begin_transport(&mut network).is_err());
    let status = controller.status().unwrap();
    assert!(!status.connected && !status.paired);
    assert!(status
        .last_error
        .unwrap()
        .contains("retry pairing explicitly"));
    let epoch = controller
        .state
        .lock()
        .unwrap()
        .runtime
        .as_ref()
        .unwrap()
        .transport_epoch;
    controller.network_changed().unwrap();
    assert_eq!(
        controller
            .state
            .lock()
            .unwrap()
            .runtime
            .as_ref()
            .unwrap()
            .transport_epoch,
        epoch
    );
    assert!(
        !controller
            .resume_owned(|_| panic!("visibility resumed parked PairRequest"))
            .await
            .unwrap()
            .paired
    );
    assert_eq!(fixture.backend.reads.load(Ordering::SeqCst), reads);
    assert_eq!(fixture.profiles().snapshot().unwrap(), raw);
}

#[tokio::test]
async fn normal_socket_retirement_also_fences_old_queue_without_bypassing_backoff() {
    let fixture = Fixture::new();
    let (controller, launch) = paired_runtime(&fixture).await;
    let mut network = launch.owner.network.clone();
    let old = launch.owner.begin_transport(&mut network).unwrap();
    old.ready().unwrap();
    let epoch = old.transport_epoch.unwrap();
    old.retire_transport().unwrap();
    assert!(!old.is_current());
    assert!(!network.has_changed().unwrap());
    assert!(controller
        .rpc("offline mutation".into(), Value::Null)
        .await
        .is_err());
    let next = launch.owner.begin_transport(&mut network).unwrap();
    next.ready().unwrap();
    assert!(!next.accepts_command(epoch));
    assert!(next.accepts_command(next.transport_epoch.unwrap()));
}
