use crate::features::sync::availability::{DownloadMode, DownloadPolicy};

const ASSET_PDF: &str = "papers/x/x.pdf";
const ASSET_TEX: &str = "papers/x/source/main.tex";
const ASSET_ATTACHMENT: &str = "papers/x/attachments/data.csv";
const ALWAYS_LAYOUT: &str = "papers/x/source/layout.json";

fn on_demand(vault: &Path) {
    availability::set_policy(
        vault,
        DownloadPolicy {
            mode: DownloadMode::OnDemand,
            pinned_paper_ids: Vec::new(),
        },
    )
    .unwrap();
}

async fn asset_vault_pair() -> (
    MemStore,
    SyncBackendConfig,
    tempfile::TempDir,
    tempfile::TempDir,
) {
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    for (path, raw) in [
        (ASSET_PDF, b"%PDF remote bytes".as_slice()),
        (ASSET_TEX, b"\\documentclass{article}"),
        (ASSET_ATTACHMENT, b"value\n1\n"),
        ("papers/x/metadata.json", br#"{"id":"x","title":"Example"}"#),
        ("papers/x/NOTES.md", b"# Reading notes\n"),
        (ANNOTATION_PATH, b"[]"),
        (ALWAYS_LAYOUT, br#"{"pages":[]}"#),
        ("papers/x/assets/embedded.png", b"embedded evidence"),
    ] {
        write_mark(a.path(), path, raw);
    }
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    on_demand(b.path());
    let joined = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(
        joined.downloaded, 5,
        "only metadata, notes, marks, layout and embedded assets"
    );
    (store, cfg, a, b)
}

fn assert_asset_files(vault: &Path, present: bool) {
    for path in [ASSET_PDF, ASSET_TEX, ASSET_ATTACHMENT] {
        assert_eq!(vault.join(path).is_file(), present, "{path}");
    }
}

#[tokio::test]
async fn availability_two_vault_deferred_assets_survive_idle_and_remote_updates() {
    let (store, cfg, a, b) = asset_vault_pair().await;
    assert_asset_files(a.path(), true); // default preserves desktop/CLI full download behavior.
    assert_asset_files(b.path(), false);
    let inventory = availability::list_papers(b.path()).unwrap();
    assert_eq!(inventory.len(), 1);
    assert_eq!(inventory[0].assets.len(), 3);
    assert!(inventory[0].assets.iter().all(|asset| !asset.materialized));
    let base = local::read_base(b.path());
    assert_eq!(
        base.files.len(),
        8,
        "deferred entries remain in the agreed manifest"
    );
    let before = store.counts();
    let idle = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let after = store.counts();
    assert_eq!(idle.version, base.version);
    assert_eq!((after.0 - before.0, after.1 - before.1), (1, 0));

    write_mark(
        a.path(),
        ASSET_PDF,
        b"%PDF remote replacement with a different hash",
    );
    write_mark(a.path(), "papers/x/NOTES.md", b"# New reading notes\n");
    write_mark(
        a.path(),
        ANNOTATION_PATH,
        &annotations(vec![annotation("highlight", "remote edit")]),
    );
    write_mark(a.path(), ALWAYS_LAYOUT, br#"{"pages":[{"index":1}]}"#);
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let updated = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(
        updated.downloaded, 3,
        "PDF update stays deferred; small reading data updates"
    );
    assert_asset_files(b.path(), false);
    for path in ["papers/x/NOTES.md", ANNOTATION_PATH, ALWAYS_LAYOUT] {
        assert_eq!(
            fs::read(a.path().join(path)).unwrap(),
            fs::read(b.path().join(path)).unwrap()
        );
    }
    assert_eq!(
        local::read_base(a.path()).files[ASSET_PDF].hash,
        local::read_base(b.path()).files[ASSET_PDF].hash
    );
    write_mark(
        b.path(),
        "notes/tablet.md",
        b"local note while PDF is absent\n",
    );
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(
        a.path().join(ASSET_PDF).is_file(),
        "uncached absence never becomes a deletion"
    );
    assert_eq!(
        fs::read_to_string(a.path().join("notes/tablet.md")).unwrap(),
        "local note while PDF is absent\n"
    );
}

#[tokio::test]
async fn availability_fetch_pin_full_mode_and_eviction_share_verified_engine_paths() {
    let (store, cfg, a, b) = asset_vault_pair().await;
    let fetched = run_sync_requested(b.path(), &cfg, &store, noop_progress(), Some("x"))
        .await
        .unwrap();
    assert_eq!(fetched.downloaded, 3);
    assert_asset_files(b.path(), true);
    assert_eq!(
        availability::read_policy(b.path()).unwrap(),
        DownloadPolicy {
            mode: DownloadMode::OnDemand,
            pinned_paper_ids: Vec::new()
        }
    );
    assert!(availability::list_papers(b.path()).unwrap()[0]
        .assets
        .iter()
        .all(|asset| asset.materialized));
    write_mark(a.path(), ASSET_PDF, b"%PDF update to already cached asset");
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(
        fs::read(a.path().join(ASSET_PDF)).unwrap(),
        fs::read(b.path().join(ASSET_PDF)).unwrap()
    );

    assert_eq!(availability::evict_paper(b.path(), "x").unwrap(), 3);
    assert_asset_files(b.path(), false);
    for path in [
        "papers/x/metadata.json",
        "papers/x/NOTES.md",
        ANNOTATION_PATH,
        ALWAYS_LAYOUT,
        "papers/x/assets/embedded.png",
    ] {
        assert!(b.path().join(path).is_file(), "eviction must retain {path}");
    }
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_asset_files(a.path(), true);
    assert!(local::read_base(b.path()).files.contains_key(ASSET_PDF));

    availability::set_policy(
        b.path(),
        DownloadPolicy {
            mode: DownloadMode::OnDemand,
            pinned_paper_ids: vec!["x".into()],
        },
    )
    .unwrap();
    let pinned = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(
        pinned.downloaded, 3,
        "pin change must bypass otherwise idle HEAD"
    );
    assert_asset_files(b.path(), true);
    assert!(availability::evict_paper(b.path(), "x").is_err());
    on_demand(b.path());
    assert_eq!(availability::evict_paper(b.path(), "x").unwrap(), 3);
    availability::set_policy(b.path(), DownloadPolicy::default()).unwrap();
    let full = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(
        full.downloaded, 3,
        "restoring full mode materializes prior deferrals"
    );
    assert_asset_files(b.path(), true);
}

#[tokio::test]
async fn availability_eviction_rejects_unsynced_assets_without_partial_removal() {
    let (store, cfg, a, b) = asset_vault_pair().await;
    run_sync_requested(b.path(), &cfg, &store, noop_progress(), Some("x"))
        .await
        .unwrap();
    write_mark(b.path(), ASSET_PDF, b"%PDF local edit must not be evicted");
    let before = fs::read(b.path().join(".agentero/sync/availability.json")).unwrap();
    let error = availability::evict_paper(b.path(), "x").unwrap_err();
    assert!(error.to_string().contains("unsynced changes"));
    assert_asset_files(b.path(), true);
    assert_eq!(
        fs::read(b.path().join(".agentero/sync/availability.json")).unwrap(),
        before
    );
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(a.path().join(ASSET_PDF)).unwrap(),
        "%PDF local edit must not be evicted"
    );
}

#[tokio::test]
async fn availability_whole_paper_deletion_uses_positive_metadata_history_for_deferred_pdf() {
    let (store, cfg, a, b) = asset_vault_pair().await;
    assert!(!b.path().join(ASSET_PDF).exists());
    let paper = b.path().join("papers/x");
    assert!(paper.starts_with(b.path()) && paper.ends_with("papers/x"));
    fs::remove_dir_all(paper).unwrap();
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(availability::list_papers(b.path()).unwrap().is_empty());
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_asset_files(a.path(), false);
    assert!(!a.path().join(ANNOTATION_PATH).exists());
    assert!(!local::read_base(a.path())
        .files
        .keys()
        .any(|path| path.starts_with("papers/x/")));
}

#[tokio::test]
async fn availability_never_cached_paper_absence_differs_from_evicted_materialized_history() {
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write_mark(a.path(), ASSET_PDF, b"%PDF only asset with no metadata");
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    on_demand(b.path());
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(
        !b.path().join("papers/x").exists(),
        "a PDF-only paper may have no local directory yet"
    );
    write_mark(
        b.path(),
        "notes/unrelated.md",
        b"edit while PDF was never cached",
    );
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(a.path().join(ASSET_PDF).exists());

    run_sync_requested(b.path(), &cfg, &store, noop_progress(), Some("x"))
        .await
        .unwrap();
    assert_eq!(availability::evict_paper(b.path(), "x").unwrap(), 1);
    fs::remove_dir(b.path().join("papers/x")).unwrap();
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(
        !a.path().join(ASSET_PDF).exists(),
        "explicit root removal after materialization is positive deletion evidence"
    );
    assert!(availability::read_state(b.path())
        .unwrap()
        .materialized_papers
        .is_empty());

    // A later paper with the same ID must not inherit stale deletion history.
    write_mark(a.path(), ASSET_PDF, b"%PDF reintroduced later");
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    write_mark(
        b.path(),
        "notes/unrelated.md",
        b"another edit while reintroduced PDF stays deferred",
    );
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(a.path().join(ASSET_PDF).exists());
    assert!(!b.path().join(ASSET_PDF).exists());
}

#[tokio::test]
async fn availability_layout_stays_synced_when_source_category_is_disabled() {
    let store = MemStore::default();
    let mut cfg = SyncBackendConfig::default();
    cfg.scope.source = false;
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write_mark(a.path(), ASSET_TEX, b"excluded TeX source");
    write_mark(a.path(), ALWAYS_LAYOUT, br#"{"pages":[1]}"#);
    write_mark(a.path(), ANNOTATION_PATH, b"[]");
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    on_demand(b.path());
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(!b.path().join(ASSET_TEX).exists());
    assert_eq!(
        fs::read(b.path().join(ALWAYS_LAYOUT)).unwrap(),
        br#"{"pages":[1]}"#
    );
    assert!(b.path().join(ANNOTATION_PATH).exists());
    assert!(local::read_base(b.path()).files.contains_key(ALWAYS_LAYOUT));
}

#[tokio::test]
async fn availability_cas_retry_revalidates_physical_files_without_requiring_deferred_assets() {
    let (store, cfg, a, b) = asset_vault_pair().await;
    let c = tempfile::tempdir().unwrap();
    run_sync(c.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    write_mark(a.path(), ASSET_PDF, b"%PDF changed before competing HEADs");
    write_mark(a.path(), "notes/a.md", b"a");
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let (previous, _) = store.get(HEAD_KEY).await.unwrap().unwrap();
    write_mark(c.path(), "notes/c.md", b"c");
    run_sync(c.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let (winner, etag) = store.get(HEAD_KEY).await.unwrap().unwrap();
    store
        .put(HEAD_KEY, previous, PutCondition::IfMatch(etag))
        .await
        .unwrap();
    write_mark(b.path(), "notes/b.md", b"b");
    let race = MarksRaceStore::new(&store);
    *race.head_winner.lock().unwrap() = Some(winner);
    run_sync(b.path(), &cfg, &race, noop_progress())
        .await
        .unwrap();
    assert_asset_files(b.path(), false);
    for vault in [a.path(), c.path()] {
        run_sync(vault, &cfg, &store, noop_progress())
            .await
            .unwrap();
    }
    for vault in [a.path(), b.path(), c.path()] {
        for path in ["notes/a.md", "notes/b.md", "notes/c.md"] {
            assert!(vault.join(path).exists());
        }
        assert!(local::read_base(vault).files.contains_key(ASSET_PDF));
    }
}

#[tokio::test]
async fn availability_fetch_verifies_blob_and_refuses_late_local_creation() {
    let (store, cfg, _a, b) = asset_vault_pair().await;
    let hash = local::read_base(b.path()).files[ASSET_PDF].hash.clone();
    let key = blob_key(&hash);
    let original = store.objects.lock().unwrap().get(&key).cloned().unwrap();
    store.objects.lock().unwrap().insert(
        key.clone(),
        (gzip(b"corrupt remote bytes").unwrap(), "corrupt".into()),
    );
    let error = run_sync_requested(b.path(), &cfg, &store, noop_progress(), Some("x"))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("blob corrupt"));
    assert!(!b.path().join(ASSET_PDF).exists());
    store.objects.lock().unwrap().insert(key.clone(), original);
    let late = b"%PDF local file created during deferred fetch".to_vec();
    let race = MarksRaceStore::new(&store);
    *race.on_get.lock().unwrap() = Some((key, b.path().join(ASSET_PDF), late.clone()));
    let error = run_sync_requested(b.path(), &cfg, &race, noop_progress(), Some("x"))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("changed during sync"));
    assert_eq!(fs::read(b.path().join(ASSET_PDF)).unwrap(), late);
}

#[tokio::test]
async fn availability_corrupt_ledger_stops_before_remote_io() {
    let (store, cfg, a, b) = asset_vault_pair().await;
    let ledger = b.path().join(".agentero/sync/availability.json");
    let valid = fs::read(&ledger).unwrap();
    assert!(b.path().join(".agentero/sync/availability.guard").exists());
    for invalid in [
        b"{broken".as_slice(),
        b"{}",
        br#"{"version":1}"#,
        br#"{"version":1,"policy":{"mode":"onDemand","pinnedPaperIds":[]},"materialized":[],"materializedPapers":[]}"#,
        br#"{"version":1,"policy":{},"materialized":[],"materializedPapers":[],"deferred":[]}"#,
        br#"{"version":2,"policy":{"mode":"onDemand","pinnedPaperIds":[]},"materialized":[],"materializedPapers":[],"deferred":[]}"#,
    ] {
        fs::write(&ledger, invalid).unwrap();
        let before = store.counts();
        assert!(run_sync(b.path(), &cfg, &store, noop_progress()).await.is_err(), "{invalid:?}");
        assert_eq!(store.counts(), before, "partial JSON must not reach the remote store");
        assert!(a.path().join(ASSET_PDF).exists());
        assert!(local::read_base(b.path()).files.contains_key(ASSET_PDF));
    }
    // Losing an already managed ledger must not silently become legacy Full.
    fs::remove_file(&ledger).unwrap();
    let before = store.counts();
    assert!(run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .is_err());
    assert_eq!(store.counts(), before);
    fs::write(ledger, valid).unwrap();
}

#[tokio::test]
async fn availability_legacy_full_vault_without_ledger_preserves_intentional_file_deletion() {
    let (store, cfg, a, b) = asset_vault_pair().await;
    // Model the pre-availability desktop: base history, no managed-state marker.
    fs::remove_file(a.path().join(".agentero/sync/availability.json")).unwrap();
    fs::remove_file(a.path().join(".agentero/sync/availability.guard")).unwrap();
    fs::remove_file(a.path().join(ASSET_PDF)).unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(!local::read_base(a.path()).files.contains_key(ASSET_PDF));
    assert!(!local::read_base(b.path()).files.contains_key(ASSET_PDF));
}

#[tokio::test]
async fn availability_remote_edit_winning_paper_deletion_does_not_inherit_old_local_proof() {
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write_mark(a.path(), ASSET_PDF, b"%PDF original");
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    on_demand(b.path());
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync_requested(b.path(), &cfg, &store, noop_progress(), Some("x"))
        .await
        .unwrap();
    availability::evict_paper(b.path(), "x").unwrap();
    fs::remove_dir(b.path().join("papers/x")).unwrap();
    write_mark(
        a.path(),
        ASSET_PDF,
        b"%PDF concurrent remote modification wins file delete",
    );
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(local::read_base(b.path()).files.contains_key(ASSET_PDF));
    assert!(!b.path().join(ASSET_PDF).exists());
    assert!(!availability::read_state(b.path())
        .unwrap()
        .materialized_papers
        .contains("x"));
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(a.path().join(ASSET_PDF)).unwrap(),
        "%PDF concurrent remote modification wins file delete"
    );
}

#[tokio::test]
async fn availability_scoped_old_history_does_not_delete_reintroduced_deferred_paper() {
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let mut excluded = cfg.clone();
    excluded.scope.pdf = false;
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write_mark(a.path(), ASSET_PDF, b"%PDF old generation");
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    on_demand(b.path());
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync_requested(b.path(), &cfg, &store, noop_progress(), Some("x"))
        .await
        .unwrap();
    availability::evict_paper(b.path(), "x").unwrap();
    fs::remove_dir(b.path().join("papers/x")).unwrap();
    fs::remove_file(a.path().join(ASSET_PDF)).unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &excluded, &store, noop_progress())
        .await
        .unwrap();
    let state = availability::read_state(b.path()).unwrap();
    assert!(
        !state.materialized_papers.contains("x"),
        "authoritative removal ends paper-level proof even while PDF is excluded"
    );
    assert!(
        !state.deferred.contains(ASSET_PDF),
        "old excluded path history must also end"
    );

    write_mark(
        a.path(),
        ASSET_PDF,
        b"%PDF new generation, never cached on B",
    );
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(!b.path().join(ASSET_PDF).exists());
    let adopted = local::read_base(b.path()).version;
    let idle = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(idle.version, adopted);
    write_mark(
        b.path(),
        "notes/other.md",
        b"unrelated local change after reintroduction",
    );
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(a.path().join(ASSET_PDF).exists());
    assert!(local::read_base(b.path()).files.contains_key(ASSET_PDF));
}
