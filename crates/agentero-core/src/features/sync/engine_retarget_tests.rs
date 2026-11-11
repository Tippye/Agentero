fn retarget_config() -> SyncBackendConfig {
    SyncBackendConfig {
        endpoint: "https://different-store.example".into(),
        ..SyncBackendConfig::default()
    }
}

fn stored_binding(vault: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(vault.join(".agentero/sync/state.json")).unwrap()).unwrap()
}

#[tokio::test]
async fn retarget_empty_store_uploads_physical_files_without_old_virtual_assets() {
    let (old_store, old_config, _a, b) = asset_vault_pair().await;
    let old_head = old_store.get(HEAD_KEY).await.unwrap().unwrap().0;
    let policy = availability::read_policy(b.path()).unwrap();
    let note = fs::read(b.path().join("papers/x/NOTES.md")).unwrap();
    let new_store = MemStore::default();
    let new_config = retarget_config();
    let result = run_sync(b.path(), &new_config, &new_store, noop_progress())
        .await
        .unwrap();
    assert_eq!(result.uploaded, 5);
    assert_eq!(result.deleted_local, 0);
    assert_eq!(fs::read(b.path().join("papers/x/NOTES.md")).unwrap(), note);
    assert_asset_files(b.path(), false);
    assert!(!local::read_base(b.path()).files.contains_key(ASSET_PDF));
    assert!(availability::read_state(b.path())
        .unwrap()
        .deferred
        .is_empty());
    assert_eq!(availability::read_policy(b.path()).unwrap(), policy);
    assert_eq!(
        stored_binding(b.path())["storeIdentity"],
        local::store_identity(&new_config)
    );
    assert_ne!(
        local::store_identity(&old_config),
        local::store_identity(&new_config)
    );
    assert_eq!(old_store.get(HEAD_KEY).await.unwrap().unwrap().0, old_head);
}

#[tokio::test]
async fn retarget_equal_version_foreign_store_performs_handshake_and_merges() {
    let (old_store, new_store) = (MemStore::default(), MemStore::default());
    let (local_vault, peer) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let old_config = SyncBackendConfig::default();
    let new_config = retarget_config();
    write_mark(
        local_vault.path(),
        "notes/local.md",
        b"keep this local note",
    );
    write_mark(peer.path(), "notes/remote.md", b"foreign store note");
    run_sync(local_vault.path(), &old_config, &old_store, noop_progress())
        .await
        .unwrap();
    run_sync(peer.path(), &new_config, &new_store, noop_progress())
        .await
        .unwrap();
    assert_eq!(local::read_meta(local_vault.path()).last_version, 1);
    assert_eq!(local::read_meta(peer.path()).last_version, 1);
    let peer_id = local::ensure_vault_id(peer.path()).unwrap();
    assert_ne!(local::ensure_vault_id(local_vault.path()).unwrap(), peer_id);
    let before = new_store.counts();
    let result = run_sync(local_vault.path(), &new_config, &new_store, noop_progress())
        .await
        .unwrap();
    assert!(
        new_store.counts().0 - before.0 > 1,
        "a matching version is not an idle proof for another store"
    );
    assert_eq!(local::ensure_vault_id(local_vault.path()).unwrap(), peer_id);
    assert_eq!(result.version, 2);
    assert_eq!(
        fs::read(local_vault.path().join("notes/local.md")).unwrap(),
        b"keep this local note"
    );
    assert_eq!(
        fs::read(local_vault.path().join("notes/remote.md")).unwrap(),
        b"foreign store note"
    );
}

#[tokio::test]
async fn retarget_interrupted_reset_retries_old_binding_after_each_durable_cut() {
    for after_availability in [false, true] {
        let (_old_store, old_config, _a, b) = asset_vault_pair().await;
        let old_identity = local::store_identity(&old_config);
        let policy = availability::read_policy(b.path()).unwrap();
        // Simulate a process stopping after reset step 1 or step 2. The final
        // new-store marker has deliberately not been committed at either cut.
        local::write_base(b.path(), &Manifest::default()).unwrap();
        if after_availability {
            availability::reset_history(b.path(), policy.clone()).unwrap();
        }
        assert_eq!(stored_binding(b.path())["storeIdentity"], old_identity);
        let new_store = MemStore::default();
        let new_config = retarget_config();
        run_sync(b.path(), &new_config, &new_store, noop_progress())
            .await
            .unwrap();
        assert_eq!(availability::read_policy(b.path()).unwrap(), policy);
        assert!(availability::read_state(b.path())
            .unwrap()
            .deferred
            .is_empty());
        assert!(!local::read_base(b.path()).files.contains_key(ASSET_PDF));
        assert!(b.path().join("papers/x/NOTES.md").is_file());
        assert_eq!(
            stored_binding(b.path())["storeIdentity"],
            local::store_identity(&new_config)
        );
    }
}

#[tokio::test]
async fn retarget_legacy_binding_is_stamped_only_from_old_config_or_reset_if_unknown() {
    for stamp_old in [false, true] {
        let (old_store, new_store) = (MemStore::default(), MemStore::default());
        let vault = tempfile::tempdir().unwrap();
        let old_config = SyncBackendConfig::default();
        let new_config = retarget_config();
        write_mark(vault.path(), "notes/local.md", b"legacy local bytes");
        run_sync(vault.path(), &old_config, &old_store, noop_progress())
            .await
            .unwrap();
        let mut legacy = stored_binding(vault.path());
        legacy.as_object_mut().unwrap().remove("storeIdentity");
        fs::write(
            vault.path().join(".agentero/sync/state.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        if stamp_old {
            local::bind_configured_store(vault.path(), &old_config).unwrap();
            local::bind_configured_store(vault.path(), &new_config).unwrap();
            assert_eq!(
                stored_binding(vault.path())["storeIdentity"],
                local::store_identity(&old_config),
                "a later config cannot relabel an existing base"
            );
        }
        let result = run_sync(vault.path(), &new_config, &new_store, noop_progress())
            .await
            .unwrap();
        assert_eq!(result.uploaded, 1);
        assert_eq!(result.deleted_local, 0);
        assert_eq!(
            fs::read(vault.path().join("notes/local.md")).unwrap(),
            b"legacy local bytes"
        );
    }
}

#[tokio::test]
async fn retarget_corrupt_binding_metadata_stops_io_and_error_recording_preserves_evidence() {
    let store = MemStore::default();
    let vault = tempfile::tempdir().unwrap();
    let config = SyncBackendConfig::default();
    write_mark(vault.path(), "notes/local.md", b"keep");
    run_sync(vault.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    let valid = stored_binding(vault.path());
    let mut null_identity = valid.clone();
    null_identity["storeIdentity"] = serde_json::Value::Null;
    let mut bad_identity = valid.clone();
    bad_identity["storeIdentity"] = "not-a-digest".into();
    for raw in [
        b"{broken".to_vec(),
        b"{}".to_vec(),
        serde_json::to_vec(&null_identity).unwrap(),
        serde_json::to_vec(&bad_identity).unwrap(),
    ] {
        let path = vault.path().join(".agentero/sync/state.json");
        fs::write(&path, &raw).unwrap();
        let before = store.counts();
        assert!(run_sync(vault.path(), &config, &store, noop_progress())
            .await
            .is_err());
        assert_eq!(store.counts(), before);
        assert!(local::bind_configured_store(vault.path(), &config).is_err());
        local::record_error(vault.path(), "do not erase binding corruption");
        assert_eq!(fs::read(&path).unwrap(), raw);
        assert_eq!(
            fs::read(vault.path().join("notes/local.md")).unwrap(),
            b"keep"
        );
    }
}

#[tokio::test]
async fn bound_store_losing_head_is_not_a_remote_file_deletion() {
    let store = MemStore::default();
    let vault = tempfile::tempdir().unwrap();
    let config = SyncBackendConfig::default();
    write_mark(
        vault.path(),
        "notes/local.md",
        b"keep even when server HEAD is lost",
    );
    run_sync(vault.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    store.objects.lock().unwrap().remove(HEAD_KEY);
    let before = store.counts();
    let error = run_sync(vault.path(), &config, &store, noop_progress())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "sync_remote_history_missing");
    assert_eq!(store.counts().1, before.1);
    assert_eq!(
        fs::read(vault.path().join("notes/local.md")).unwrap(),
        b"keep even when server HEAD is lost"
    );
    assert!(local::read_base(vault.path())
        .files
        .contains_key("notes/local.md"));
}

#[tokio::test]
async fn empty_agreed_store_losing_head_cannot_restart_versions_and_strand_a_lagging_peer() {
    let store = MemStore::default();
    let config = SyncBackendConfig::default();
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write_mark(a.path(), "notes/last.md", b"last shared note");
    run_sync(a.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    fs::remove_file(a.path().join("notes/last.md")).unwrap();
    run_sync(a.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    assert!(local::read_base(a.path()).files.is_empty());
    assert_eq!(local::read_meta(a.path()).last_version, 2);
    assert_eq!(local::read_meta(b.path()).last_version, 1);
    let deleted_head = store.objects.lock().unwrap().remove(HEAD_KEY).unwrap().0;
    let before = store.counts();
    let error = run_sync(a.path(), &config, &store, noop_progress())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "sync_remote_history_missing");
    assert_eq!(store.counts().1, before.1);
    assert!(!store.objects.lock().unwrap().contains_key(HEAD_KEY));
    // Restoring the original immutable-manifest pointer lets the lagging peer
    // observe the intended deletion, rather than falsely idling at recycled v1.
    store
        .put(HEAD_KEY, deleted_head, PutCondition::IfNoneMatch)
        .await
        .unwrap();
    run_sync(b.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    assert!(!b.path().join("notes/last.md").exists());
}

#[tokio::test]
async fn bound_base_loss_or_corruption_cannot_become_an_idle_empty_snapshot() {
    let store = MemStore::default();
    let vault = tempfile::tempdir().unwrap();
    let config = SyncBackendConfig::default();
    write_mark(vault.path(), "notes/local.md", b"keep known local bytes");
    run_sync(vault.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    let path = vault.path().join(".agentero/sync/base.json");
    fs::remove_file(&path).unwrap();
    for raw in [None, Some(b"{broken".as_slice()), Some(b"{}".as_slice())] {
        if let Some(raw) = raw {
            fs::write(&path, raw).unwrap();
        }
        let before = store.counts();
        assert!(run_sync(vault.path(), &config, &store, noop_progress())
            .await
            .is_err());
        assert_eq!(store.counts(), before);
        assert_eq!(
            fs::read(vault.path().join("notes/local.md")).unwrap(),
            b"keep known local bytes"
        );
    }
}

#[tokio::test]
async fn idle_requires_the_base_and_metadata_to_describe_the_same_snapshot() {
    let store = MemStore::default();
    let config = SyncBackendConfig::default();
    let (vault, peer) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write_mark(vault.path(), "notes/local.md", b"original snapshot");
    run_sync(vault.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    run_sync(peer.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    write_mark(peer.path(), "notes/local.md", b"a newer remote snapshot");
    run_sync(peer.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    // Another metadata writer (e.g. Git) must not make an older blob-store
    // base appear current just because its status version equals remote HEAD.
    let mut meta = local::read_meta(vault.path());
    meta.last_version = local::read_meta(peer.path()).last_version;
    local::write_meta(vault.path(), &meta).unwrap();
    assert_ne!(local::read_base(vault.path()).version, meta.last_version);
    let outcome = run_sync(vault.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(outcome.downloaded, 1);
    assert_eq!(
        fs::read(vault.path().join("notes/local.md")).unwrap(),
        b"a newer remote snapshot"
    );
}

#[tokio::test]
async fn same_version_different_manifest_is_a_fork_not_an_idle_or_deletion_proof() {
    let (store, branch) = (MemStore::default(), MemStore::default());
    let config = SyncBackendConfig::default();
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write_mark(a.path(), "notes/seed.md", b"shared seed");
    run_sync(a.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    *branch.objects.lock().unwrap() = store.objects.lock().unwrap().clone();
    run_sync(b.path(), &config, &branch, noop_progress())
        .await
        .unwrap();
    write_mark(a.path(), "notes/a.md", b"A concurrent addition");
    write_mark(b.path(), "notes/b.md", b"B concurrent addition");
    run_sync(a.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &config, &branch, noop_progress())
        .await
        .unwrap();
    assert_eq!(local::read_meta(a.path()).last_version, 2);
    assert_eq!(local::read_meta(b.path()).last_version, 2);
    assert_ne!(
        stored_binding(a.path())["manifestKey"],
        stored_binding(b.path())["manifestKey"]
    );
    // Model two non-conditional HEAD PUTs: both published v2 from v1, and B's
    // pointer won last. Immutable blobs/manifests from both writers still exist.
    store
        .objects
        .lock()
        .unwrap()
        .extend(branch.objects.lock().unwrap().clone());
    run_sync(a.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    assert!(a.path().join("notes/a.md").is_file());
    assert!(a.path().join("notes/b.md").is_file());
    assert_eq!(local::read_meta(a.path()).last_version, 3);
    run_sync(b.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    assert!(b.path().join("notes/a.md").is_file());
    assert!(b.path().join("notes/b.md").is_file());
}

#[tokio::test]
async fn cas_retry_compares_forks_against_its_current_merge_ancestor() {
    let (store, fork) = (MemStore::default(), MemStore::default());
    let config = SyncBackendConfig::default();
    let (a, remote, other) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    write_mark(a.path(), "notes/seed.md", b"seed");
    run_sync(a.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    *fork.objects.lock().unwrap() = store.objects.lock().unwrap().clone();
    run_sync(remote.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    run_sync(other.path(), &config, &fork, noop_progress())
        .await
        .unwrap();
    write_mark(remote.path(), "notes/r.md", b"first observed remote branch");
    write_mark(other.path(), "notes/f.md", b"same-version fork winning CAS");
    run_sync(remote.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    run_sync(other.path(), &config, &fork, noop_progress())
        .await
        .unwrap();
    let winning_head = fork.get(HEAD_KEY).await.unwrap().unwrap().0;
    store.objects.lock().unwrap().extend(
        fork.objects
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.as_str() != HEAD_KEY)
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    write_mark(a.path(), "notes/a.md", b"local concurrent addition");
    let race = MarksRaceStore::new(&store);
    *race.head_winner.lock().unwrap() = Some(winning_head);
    run_sync(a.path(), &config, &race, noop_progress())
        .await
        .unwrap();
    for path in ["notes/a.md", "notes/r.md", "notes/f.md", "notes/seed.md"] {
        assert!(
            a.path().join(path).is_file(),
            "CAS retry must preserve {path}"
        );
        assert!(local::read_base(a.path()).files.contains_key(path));
    }
    run_sync(remote.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    assert!(remote.path().join("notes/r.md").is_file());
    assert!(remote.path().join("notes/f.md").is_file());
}

struct RetargetNamespaceStore<'a> {
    store: &'a MemStore,
    namespace: &'a str,
    registrations: &'a AtomicUsize,
}
impl RemoteStore for RetargetNamespaceStore<'_> {
    async fn namespace_identity(&self) -> Result<Option<String>, AppError> {
        self.registrations.fetch_add(1, Ordering::Relaxed);
        Ok(Some(self.namespace.to_owned()))
    }
    async fn ensure_root(&self) -> Result<(), AppError> {
        self.store.ensure_root().await
    }
    async fn get(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, AppError> {
        self.store.get(key).await
    }
    async fn put(
        &self,
        key: &str,
        body: Vec<u8>,
        condition: PutCondition,
    ) -> Result<PutOutcome, AppError> {
        self.store.put(key, body, condition).await
    }
    async fn probe_conditional_writes(&self) -> Result<bool, AppError> {
        self.store.probe_conditional_writes().await
    }
}

#[tokio::test]
async fn cloud_namespace_survives_token_refresh_and_rebases_on_same_config_tenant_switch() {
    let (store_a, store_b) = (MemStore::default(), MemStore::default());
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let registrations = AtomicUsize::new(0);
    let tenant_a = RetargetNamespaceStore {
        store: &store_a,
        namespace: "cloud-vault-tenant-a",
        registrations: &registrations,
    };
    let tenant_b = RetargetNamespaceStore {
        store: &store_b,
        namespace: "cloud-vault-tenant-b",
        registrations: &registrations,
    };
    let mut config = SyncBackendConfig {
        backend: SyncBackendKind::Agentero,
        agentero_api: "https://cloud.example".into(),
        agentero_token: "first-session-token".into(),
        ..Default::default()
    };
    write_mark(a.path(), "notes/a.md", b"tenant A local bytes");
    write_mark(b.path(), "notes/b.md", b"tenant B remote bytes");
    run_sync(a.path(), &config, &tenant_a, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &config, &tenant_b, noop_progress())
        .await
        .unwrap();
    let binding_a = stored_binding(a.path())["storeIdentity"].clone();
    let before = store_a.counts();
    config.agentero_token = "refreshed-session-token".into();
    run_sync(a.path(), &config, &tenant_a, noop_progress())
        .await
        .unwrap();
    assert_eq!(stored_binding(a.path())["storeIdentity"], binding_a);
    assert_eq!(
        store_a.counts().0 - before.0,
        1,
        "same namespace still permits idle after token refresh"
    );
    let result = run_sync(a.path(), &config, &tenant_b, noop_progress())
        .await
        .unwrap();
    assert_eq!(result.version, 2);
    assert_ne!(stored_binding(a.path())["storeIdentity"], binding_a);
    assert_eq!(
        local::ensure_vault_id(a.path()).unwrap(),
        local::ensure_vault_id(b.path()).unwrap()
    );
    assert!(a.path().join("notes/a.md").is_file());
    assert!(a.path().join("notes/b.md").is_file());
}

#[tokio::test]
async fn corrupt_local_binding_blocks_cloud_namespace_registration_before_network_io() {
    let store = MemStore::default();
    let vault = tempfile::tempdir().unwrap();
    let registrations = AtomicUsize::new(0);
    let tenant = RetargetNamespaceStore {
        store: &store,
        namespace: "cloud-vault-a",
        registrations: &registrations,
    };
    fs::create_dir_all(vault.path().join(".agentero/sync")).unwrap();
    fs::write(vault.path().join(".agentero/sync/state.json"), b"{}").unwrap();
    assert!(run_sync(
        vault.path(),
        &SyncBackendConfig::default(),
        &tenant,
        noop_progress()
    )
    .await
    .is_err());
    assert_eq!(registrations.load(Ordering::Relaxed), 0);
    assert_eq!(store.counts(), (0, 0));
}

#[tokio::test]
async fn normal_base_meta_and_error_updates_preserve_store_binding() {
    let store = MemStore::default();
    let vault = tempfile::tempdir().unwrap();
    let config = SyncBackendConfig::default();
    write_mark(vault.path(), "notes/local.md", b"one");
    run_sync(vault.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    let identity = stored_binding(vault.path())["storeIdentity"].clone();
    local::record_error(vault.path(), "temporary failure");
    assert_eq!(stored_binding(vault.path())["storeIdentity"], identity);
    run_sync(vault.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    assert!(local::read_meta(vault.path()).last_error.is_none());
    write_mark(vault.path(), "notes/local.md", b"two");
    run_sync(vault.path(), &config, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(stored_binding(vault.path())["storeIdentity"], identity);
}
