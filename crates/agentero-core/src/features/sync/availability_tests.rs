use super::*;

#[test]
fn device_default_is_initialized_once_without_overwriting_choice_or_corrupt_history() {
    let vault = tempfile::tempdir().unwrap();
    let lazy = DownloadPolicy {
        mode: DownloadMode::OnDemand,
        pinned_paper_ids: Vec::new(),
    };
    assert_eq!(read_policy(vault.path()).unwrap().mode, DownloadMode::Full);
    assert_eq!(initialize_policy(vault.path(), lazy.clone()).unwrap(), lazy);
    set_policy(vault.path(), DownloadPolicy::default()).unwrap();
    assert_eq!(
        initialize_policy(vault.path(), lazy.clone()).unwrap().mode,
        DownloadMode::Full
    );
    let path = vault.path().join(".agentero/sync/availability.json");
    fs::write(&path, b"{}").unwrap();
    assert!(initialize_policy(vault.path(), lazy).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"{}");
}

#[test]
fn policy_defaults_full_roundtrips_and_rejects_unsafe_ids_and_corrupt_history() {
    let vault = tempfile::tempdir().unwrap();
    assert_eq!(
        read_policy(vault.path()).unwrap(),
        DownloadPolicy::default()
    );
    let policy = set_policy(
        vault.path(),
        DownloadPolicy {
            mode: DownloadMode::OnDemand,
            pinned_paper_ids: vec!["b".into(), "a".into(), "a".into()],
        },
    )
    .unwrap();
    assert_eq!(policy.pinned_paper_ids, vec!["a", "b"]);
    assert_eq!(read_policy(vault.path()).unwrap(), policy);
    for id in ["", "..", "../escape", "x/y", "x\\y", "C:escape"] {
        assert!(set_policy(
            vault.path(),
            DownloadPolicy {
                mode: DownloadMode::OnDemand,
                pinned_paper_ids: vec![id.into()],
            }
        )
        .is_err());
    }
    fs::write(
        vault.path().join(".agentero/sync/availability.json"),
        b"{broken",
    )
    .unwrap();
    assert!(
        read_policy(vault.path()).is_err(),
        "corrupt state must not erase deferral history"
    );
}

#[test]
fn policy_and_eviction_share_the_vault_sync_lock() {
    let vault = tempfile::tempdir().unwrap();
    let lock = acquire(vault.path()).unwrap();
    assert!(set_policy(vault.path(), DownloadPolicy::default()).is_err());
    assert!(evict_paper(vault.path(), "x").is_err());
    drop(lock);
    assert!(set_policy(vault.path(), DownloadPolicy::default()).is_ok());
}

#[cfg(unix)]
#[test]
fn ledger_accepts_existing_unix_filenames_without_weakening_policy_id_validation() {
    let vault = tempfile::tempdir().unwrap();
    let mut state = AvailabilityState::default();
    state.materialized.insert("notes/review: draft.md".into());
    state.materialized_papers.insert("legacy:paper".into());
    write_state(vault.path(), &state).unwrap();
    assert_eq!(
        read_state(vault.path()).unwrap().materialized,
        state.materialized
    );
    assert!(validate_paper_id("legacy:paper").is_err());
}

#[test]
fn classification_keeps_layout_and_embedded_assets_always_available() {
    assert_eq!(asset("papers/x/source/layout.json"), None);
    assert_eq!(asset("papers/x/marks/annotations.json"), None);
    assert_eq!(asset("papers/x/assets/embedded.png"), None);
    assert_eq!(asset("papers/x/x.pdf"), Some(("x", PaperAssetKind::Pdf)));
    assert_eq!(
        asset("papers/x/source/main.tex"),
        Some(("x", PaperAssetKind::Source))
    );
    assert_eq!(
        asset("papers/x/attachments/data.csv"),
        Some(("x", PaperAssetKind::Attachment))
    );
}
