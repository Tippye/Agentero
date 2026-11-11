const ANNOTATION_PATH: &str = "papers/x/marks/annotations.json";
const INK_PATH: &str = "papers/x/marks/ink/p1.json";

fn annotation(id: &str, contents: &str) -> serde_json::Value {
    serde_json::json!({"annotation": {
        "id": id, "type": 9, "pageIndex": 0,
        "rect": {"origin": {"x": 10, "y": 20}, "size": {"width": 30, "height": 4}},
        "contents": contents, "custom": {"quote": "original quote"}
    }, "ctx": {"data": {"opaque": [1, 2, 3]}}})
}

fn annotations(items: Vec<serde_json::Value>) -> Vec<u8> {
    serde_json::to_vec_pretty(&items).unwrap()
}

fn write_mark(vault: &Path, path: &str, raw: &[u8]) {
    static CLOCK: AtomicUsize = AtomicUsize::new(1_700_000_000);
    let path = vault.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, raw).unwrap();
    // Avoid the scan's size+millisecond mtime cache masking a rapid same-size
    // test edit. These timestamps are not used to select semantic winners.
    let time = std::time::UNIX_EPOCH
        + std::time::Duration::from_secs(CLOCK.fetch_add(1, Ordering::Relaxed) as u64);
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(time))
        .unwrap();
}

async fn mark_vault_pair(
    store: &MemStore,
    path: &str,
    base: &[u8],
) -> (tempfile::TempDir, tempfile::TempDir) {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write_mark(a.path(), path, base);
    let cfg = SyncBackendConfig::default();
    run_sync(a.path(), &cfg, store, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &cfg, store, noop_progress())
        .await
        .unwrap();
    (a, b)
}

fn mark_hashes(vault: &Path) -> BTreeMap<String, String> {
    snapshot::scan_vault(vault, &Manifest::default(), &snapshot::SyncScope::all())
        .unwrap()
        .into_iter()
        .map(|(path, entry)| (path, entry.hash))
        .collect()
}

#[tokio::test]
async fn marks_two_vault_annotations_merge_additions_edit_and_unchanged_delete() {
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let base = annotations(vec![
        annotation("keep", "old"),
        annotation("edit", "old"),
        annotation("delete", "old"),
    ]);
    let (a, b) = mark_vault_pair(&store, ANNOTATION_PATH, &base).await;
    write_mark(
        a.path(),
        ANNOTATION_PATH,
        &annotations(vec![
            annotation("keep", "old"),
            annotation("edit", "edited on a"),
            annotation("a", "added on a"),
        ]),
    );
    write_mark(
        b.path(),
        ANNOTATION_PATH,
        &annotations(vec![
            annotation("keep", "old"),
            annotation("edit", "old"),
            annotation("delete", "old"),
            annotation("b", "added on b"),
        ]),
    );
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let merged = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(merged.conflict_copies.is_empty());
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let expected = vec![
        annotation("a", "added on a"),
        annotation("b", "added on b"),
        annotation("edit", "edited on a"),
        annotation("keep", "old"),
    ];
    for vault in [a.path(), b.path()] {
        let actual: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(vault.join(ANNOTATION_PATH)).unwrap()).unwrap();
        assert_eq!(actual, expected);
    }
    assert_eq!(mark_hashes(a.path()), mark_hashes(b.path()));
    let before = store.counts();
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(
        store.counts().1,
        before.1,
        "converged marks must not republish"
    );
}

#[tokio::test]
async fn marks_two_vault_edit_delete_preserves_exact_sources_and_does_not_resurrect() {
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let base = annotations(vec![annotation("x", "original")]);
    let (a, b) = mark_vault_pair(&store, ANNOTATION_PATH, &base).await;
    let edited = annotations(vec![annotation("x", "edited"), annotation("a", "a")]);
    let deleted = annotations(vec![annotation("b", "b")]);
    write_mark(a.path(), ANNOTATION_PATH, &edited);
    write_mark(b.path(), ANNOTATION_PATH, &deleted);
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let result = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(result.conflict_copies.len(), 2);
    for raw in [&edited, &deleted] {
        let copy = mark_conflict_name(ANNOTATION_PATH, &snapshot::hash_bytes(raw));
        assert_eq!(fs::read(b.path().join(copy)).unwrap(), *raw);
    }
    for vault in [a.path(), b.path(), a.path()] {
        let result = run_sync(vault, &cfg, &store, noop_progress())
            .await
            .unwrap();
        assert!(
            result.conflict_copies.is_empty(),
            "copies must converge without repeating conflicts"
        );
        let items: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(vault.join(ANNOTATION_PATH)).unwrap()).unwrap();
        assert_eq!(items, vec![annotation("a", "a"), annotation("b", "b")]);
    }
    assert_eq!(mark_hashes(a.path()), mark_hashes(b.path()));
}

#[tokio::test]
async fn marks_two_vault_unknown_malformed_and_duplicate_data_preserve_both_versions() {
    let duplicate_ids = annotations(vec![annotation("x", "first"), annotation("x", "second")]);
    let unknown_ink =
        br#"{"version":2,"page":1,"strokes":[],"tombstones":[],"future":"do not discard"}"#
            .to_vec();
    for (path, base, invalid) in [
        (ANNOTATION_PATH, b"[]".to_vec(), b"{ broken JSON\n".to_vec()),
        (
            ANNOTATION_PATH,
            b"[]".to_vec(),
            br#"{"annotations":[],"future":"preserve me"}"#.to_vec(),
        ),
        (ANNOTATION_PATH, b"[]".to_vec(), duplicate_ids),
        (
            ANNOTATION_PATH,
            b"[]".to_vec(),
            br#"{"same":1,"same":2}"#.to_vec(),
        ),
        (INK_PATH, ink_bytes(vec![], vec![]), unknown_ink),
        (
            "papers/x/marks/question.json",
            b"{\"base\":true}".to_vec(),
            b"{\"opaque\":\"b\"}".to_vec(),
        ),
    ] {
        let store = MemStore::default();
        let cfg = SyncBackendConfig::default();
        let (a, b) = mark_vault_pair(&store, path, &base).await;
        let valid = if path == INK_PATH {
            ink_bytes(vec![ink_stroke(1, 1, 10)], vec![])
        } else {
            annotations(vec![annotation("a", "added")])
        };
        write_mark(a.path(), path, &valid);
        write_mark(b.path(), path, &invalid);
        run_sync(a.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        let result = run_sync(b.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        assert_eq!(result.conflict_copies.len(), 2, "{path}");
        run_sync(a.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        for vault in [a.path(), b.path()] {
            for raw in [&valid, &invalid] {
                let copy = mark_conflict_name(path, &snapshot::hash_bytes(raw));
                assert_eq!(
                    fs::read(vault.join(copy)).unwrap(),
                    *raw,
                    "exact source bytes"
                );
            }
        }
        assert_eq!(mark_hashes(a.path()), mark_hashes(b.path()));
    }
}

#[tokio::test]
async fn marks_missing_base_blob_is_not_treated_as_empty() {
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let base = annotations(vec![annotation("x", "original")]);
    let (a, b) = mark_vault_pair(&store, ANNOTATION_PATH, &base).await;
    let local = annotations(vec![annotation("b", "b")]);
    let remote = annotations(vec![annotation("x", "original"), annotation("a", "a")]);
    write_mark(a.path(), ANNOTATION_PATH, &remote);
    write_mark(b.path(), ANNOTATION_PATH, &local);
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    store
        .objects
        .lock()
        .unwrap()
        .remove(&blob_key(&snapshot::hash_bytes(&base)));
    let result = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(result.conflict_copies.len(), 2);
    for raw in [&local, &remote] {
        let copy = mark_conflict_name(ANNOTATION_PATH, &snapshot::hash_bytes(raw));
        assert_eq!(fs::read(b.path().join(copy)).unwrap(), *raw);
    }
}

fn ink_stroke(id: u128, counter: u64, actor: u128) -> crate::features::pdf::ink::InkStroke {
    use crate::features::pdf::ink::*;
    InkStroke {
        id: uuid::Uuid::from_u128(id),
        page: 1,
        revision: InkRevision {
            counter,
            actor: uuid::Uuid::from_u128(actor),
        },
        tool: InkTool::Pen,
        color: [10, 20, 30, 255],
        base_width: 1.5,
        points: vec![InkPoint {
            x: 10.,
            y: 20.,
            pressure: Some(0.7),
            elapsed_ms: Some(0),
            tilt: None,
        }],
        created_at_ms: 100,
        updated_at_ms: 101,
    }
}

fn ink_deleted(id: u128, counter: u64, actor: u128) -> crate::features::pdf::ink::InkTombstone {
    use crate::features::pdf::ink::*;
    InkTombstone {
        id: uuid::Uuid::from_u128(id),
        revision: InkRevision {
            counter,
            actor: uuid::Uuid::from_u128(actor),
        },
        deleted_at_ms: 102,
    }
}

fn ink_bytes(
    strokes: Vec<crate::features::pdf::ink::InkStroke>,
    tombstones: Vec<crate::features::pdf::ink::InkTombstone>,
) -> Vec<u8> {
    use crate::features::pdf::ink::*;
    InkPage {
        version: INK_VERSION,
        page: 1,
        strokes,
        tombstones,
    }
    .to_json()
    .unwrap()
    .into_bytes()
}

#[tokio::test]
async fn marks_two_vault_ink_unions_additions_and_retains_tombstones_against_stale_replica() {
    use crate::features::pdf::ink::InkPage;
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let base = ink_bytes(vec![ink_stroke(1, 1, 10)], vec![ink_deleted(99, 1, 10)]);
    let (a, b) = mark_vault_pair(&store, INK_PATH, &base).await;
    let a_bytes = ink_bytes(
        vec![ink_stroke(2, 1, 10)],
        vec![ink_deleted(1, 2, 10), ink_deleted(99, 1, 10)],
    );
    // Stale B still has deleted stroke 1 and omits an old tombstone. Its new
    // stroke must survive without reviving 1 or erasing tombstone 99.
    let b_bytes = ink_bytes(vec![ink_stroke(1, 1, 10), ink_stroke(3, 1, 20)], vec![]);
    write_mark(a.path(), INK_PATH, &a_bytes);
    write_mark(b.path(), INK_PATH, &b_bytes);
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let result = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(result.conflict_copies.is_empty());
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let read = |vault: &Path| {
        InkPage::from_json(&fs::read_to_string(vault.join(INK_PATH)).unwrap()).unwrap()
    };
    let page = read(a.path());
    assert_eq!(
        page.strokes,
        vec![ink_stroke(2, 1, 10), ink_stroke(3, 1, 20)]
    );
    assert_eq!(
        page.tombstones,
        vec![ink_deleted(1, 2, 10), ink_deleted(99, 1, 10)]
    );
    assert_eq!(page, read(b.path()));

    // A one-sided stale write must also retain base tombstones.
    write_mark(b.path(), INK_PATH, &ink_bytes(page.strokes.clone(), vec![]));
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(read(b.path()), page);

    let edited = ink_bytes(
        vec![ink_stroke(2, 2, 10), ink_stroke(3, 1, 20)],
        page.tombstones.clone(),
    );
    let mut deleted = page.tombstones.clone();
    deleted.push(ink_deleted(2, 2, 1)); // deletion wins an equal counter, even lower actor.
    let deleted = ink_bytes(vec![ink_stroke(3, 1, 20)], deleted);
    write_mark(a.path(), INK_PATH, &edited);
    write_mark(b.path(), INK_PATH, &deleted);
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let result = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(result.conflict_copies.len(), 2);
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(read(a.path()), read(b.path()));
    assert_eq!(read(a.path()).strokes, vec![ink_stroke(3, 1, 20)]);
    for raw in [&edited, &deleted] {
        let copy = mark_conflict_name(INK_PATH, &snapshot::hash_bytes(raw));
        assert_eq!(fs::read(b.path().join(copy)).unwrap(), *raw);
    }
}

#[tokio::test]
async fn marks_ink_reused_revision_preserves_rejected_single_side_edit() {
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let mut original = ink_stroke(1, 2, 10);
    original.base_width = 9.;
    let base = ink_bytes(vec![original.clone()], vec![]);
    let (a, b) = mark_vault_pair(&store, INK_PATH, &base).await;
    original.base_width = 1.; // Invalid writer behavior: payload changed without revision bump.
    let changed = ink_bytes(vec![original], vec![]);
    write_mark(b.path(), INK_PATH, &changed);
    let result = run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(result.conflict_copies.len(), 2);
    assert_eq!(fs::read(b.path().join(INK_PATH)).unwrap(), base);
    let copy = mark_conflict_name(INK_PATH, &snapshot::hash_bytes(&changed));
    assert_eq!(fs::read(b.path().join(&copy)).unwrap(), changed);
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert_eq!(fs::read(a.path().join(copy)).unwrap(), changed);
}

/// Model an older/external publisher that can omit retained ink without the
/// new engine repairing it first. Normal vault synchronization remains real.
async fn publish_legacy_ink(store: &MemStore, raw: Option<&[u8]>) {
    let (head, etag) = store.get(HEAD_KEY).await.unwrap().unwrap();
    let mut head: HeadPointer = serde_json::from_slice(&head).unwrap();
    let (manifest, _) = store.get(&head.manifest_key).await.unwrap().unwrap();
    let mut manifest: Manifest =
        serde_json::from_slice(&gunzip_limited(&manifest, MAX_MANIFEST_BYTES).unwrap()).unwrap();
    if let Some(raw) = raw {
        let hash = snapshot::hash_bytes(raw);
        store
            .put(
                &blob_key(&hash),
                gzip(raw).unwrap(),
                PutCondition::IfNoneMatch,
            )
            .await
            .unwrap();
        manifest.files.insert(
            INK_PATH.into(),
            FileEntry {
                hash,
                size: raw.len() as u64,
                mtime_ms: 99,
            },
        );
    } else {
        manifest.files.remove(INK_PATH);
    }
    manifest.version += 1;
    head.version = manifest.version;
    head.manifest_key = format!("manifests/legacy-{}.json.gz", uuid::Uuid::new_v4());
    store
        .put(
            &head.manifest_key,
            gzip(&serde_json::to_vec(&manifest).unwrap()).unwrap(),
            PutCondition::IfNoneMatch,
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .put(
                HEAD_KEY,
                serde_json::to_vec(&head).unwrap(),
                PutCondition::IfMatch(etag)
            )
            .await
            .unwrap(),
        PutOutcome::Ok
    );
}

#[tokio::test]
async fn marks_missing_and_equal_ink_sidecars_retain_tombstones_against_stale_third_vault() {
    use crate::features::pdf::ink::InkPage;
    for omission in 0..3 {
        let store = MemStore::default();
        let cfg = SyncBackendConfig::default();
        let original = ink_bytes(vec![ink_stroke(1, 1, 10)], vec![]);
        let (a, b) = mark_vault_pair(&store, INK_PATH, &original).await;
        // A surviving paper file distinguishes missing ink from paper deletion.
        write_mark(
            a.path(),
            "papers/x/NOTES.md",
            b"# Paper survives ink omission\n",
        );
        run_sync(a.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        run_sync(b.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        let c = tempfile::tempdir().unwrap();
        run_sync(c.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        let deleted = ink_bytes(vec![ink_stroke(2, 1, 10)], vec![ink_deleted(1, 2, 10)]);
        write_mark(a.path(), INK_PATH, &deleted);
        run_sync(a.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        run_sync(b.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        match omission {
            0 => fs::remove_file(b.path().join(INK_PATH)).unwrap(),
            1 => {
                fs::remove_file(b.path().join(INK_PATH)).unwrap();
                publish_legacy_ink(&store, None).await;
            }
            _ => {
                let omitted = ink_bytes(vec![ink_stroke(2, 1, 10)], vec![]);
                write_mark(b.path(), INK_PATH, &omitted);
                publish_legacy_ink(&store, Some(&omitted)).await;
            }
        }
        run_sync(b.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        let repaired =
            InkPage::from_json(&fs::read_to_string(b.path().join(INK_PATH)).unwrap()).unwrap();
        assert_eq!(
            repaired.tombstones,
            vec![ink_deleted(1, 2, 10)],
            "omission {omission}"
        );
        // C never observed the deletion. Its unrelated addition must survive
        // without bringing old live stroke 1 back into the repaired manifest.
        write_mark(
            c.path(),
            INK_PATH,
            &ink_bytes(vec![ink_stroke(1, 1, 10), ink_stroke(3, 1, 20)], vec![]),
        );
        run_sync(c.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        for vault in [a.path(), b.path()] {
            run_sync(vault, &cfg, &store, noop_progress())
                .await
                .unwrap();
        }
        for vault in [a.path(), b.path(), c.path()] {
            let page =
                InkPage::from_json(&fs::read_to_string(vault.join(INK_PATH)).unwrap()).unwrap();
            assert_eq!(
                page.strokes,
                vec![ink_stroke(2, 1, 10), ink_stroke(3, 1, 20)],
                "omission {omission}"
            );
            assert_eq!(
                page.tombstones,
                vec![ink_deleted(1, 2, 10)],
                "omission {omission}"
            );
        }
    }
}

#[tokio::test]
async fn marks_scoped_out_last_surviving_pdf_does_not_turn_ink_omission_into_paper_deletion() {
    use crate::features::pdf::ink::InkPage;
    for remote_omitted in [false, true] {
        let store = MemStore::default();
        let all = SyncBackendConfig::default();
        let mut scoped = all.clone();
        scoped.scope.pdf = false;
        let base = ink_bytes(vec![ink_stroke(1, 1, 10)], vec![]);
        let (a, b) = mark_vault_pair(&store, INK_PATH, &base).await;
        // Exactly PDF + ink: scope filtering hides the only other file.
        write_mark(a.path(), "papers/x/x.pdf", b"%PDF offline local asset\n");
        run_sync(a.path(), &all, &store, noop_progress())
            .await
            .unwrap();
        run_sync(b.path(), &all, &store, noop_progress())
            .await
            .unwrap();
        let c = tempfile::tempdir().unwrap();
        run_sync(c.path(), &all, &store, noop_progress())
            .await
            .unwrap();
        let deleted = ink_bytes(vec![ink_stroke(2, 1, 10)], vec![ink_deleted(1, 2, 10)]);
        write_mark(a.path(), INK_PATH, &deleted);
        run_sync(a.path(), &all, &store, noop_progress())
            .await
            .unwrap();
        run_sync(b.path(), &all, &store, noop_progress())
            .await
            .unwrap();
        // Establish a scoped publisher whose unfiltered manifest also lacks
        // the PDF. Remote absence now cannot prove a whole-paper deletion.
        run_sync(a.path(), &scoped, &store, noop_progress())
            .await
            .unwrap();
        run_sync(b.path(), &scoped, &store, noop_progress())
            .await
            .unwrap();
        fs::remove_file(b.path().join(INK_PATH)).unwrap();
        if remote_omitted {
            publish_legacy_ink(&store, None).await;
        }
        run_sync(b.path(), &scoped, &store, noop_progress())
            .await
            .unwrap();
        write_mark(
            c.path(),
            INK_PATH,
            &ink_bytes(vec![ink_stroke(1, 1, 10), ink_stroke(3, 1, 20)], vec![]),
        );
        run_sync(c.path(), &scoped, &store, noop_progress())
            .await
            .unwrap();
        for vault in [a.path(), b.path()] {
            run_sync(vault, &scoped, &store, noop_progress())
                .await
                .unwrap();
        }
        for vault in [a.path(), b.path(), c.path()] {
            let page =
                InkPage::from_json(&fs::read_to_string(vault.join(INK_PATH)).unwrap()).unwrap();
            assert_eq!(
                page.strokes,
                vec![ink_stroke(2, 1, 10), ink_stroke(3, 1, 20)]
            );
            assert_eq!(page.tombstones, vec![ink_deleted(1, 2, 10)]);
            assert!(vault.join("papers/x/x.pdf").exists());
            assert!(!local::read_base(vault).files.contains_key("papers/x/x.pdf"));
        }
    }
}

#[tokio::test]
async fn marks_whole_paper_deletion_removes_unchanged_ink() {
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let base = ink_bytes(vec![], vec![ink_deleted(1, 2, 10)]);
    let (a, b) = mark_vault_pair(&store, INK_PATH, &base).await;
    write_mark(a.path(), "papers/x/NOTES.md", b"# Paper\n");
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    fs::remove_file(b.path().join(INK_PATH)).unwrap();
    fs::remove_file(b.path().join("papers/x/NOTES.md")).unwrap();
    fs::remove_dir(b.path().join("papers/x/marks/ink")).unwrap();
    fs::remove_dir(b.path().join("papers/x/marks")).unwrap();
    fs::remove_dir(b.path().join("papers/x")).unwrap();
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    assert!(!a.path().join(INK_PATH).exists());
    assert!(!b.path().join(INK_PATH).exists());
    assert!(local::read_base(a.path())
        .files
        .keys()
        .all(|path| !path.starts_with("papers/x/")));
}

#[test]
fn marks_apply_waits_for_cooperating_editor_then_rechecks_under_mutation_lane() {
    let vault = tempfile::tempdir().unwrap();
    let before = annotations(vec![annotation("x", "before")]);
    let late = annotations(vec![annotation("x", "cooperating editor saved")]);
    write_mark(vault.path(), ANNOTATION_PATH, &before);
    let scanned = snapshot::scan_vault(
        vault.path(),
        &Manifest::default(),
        &snapshot::SyncScope::all(),
    )
    .unwrap();
    let mut plan = merge(
        &scanned,
        &scanned,
        &scanned,
        &snapshot::SyncScope::all(),
        &snapshot::SyncScope::all(),
    );
    plan.writes.insert(
        ANNOTATION_PATH.into(),
        annotations(vec![annotation("x", "sync replacement")]),
    );
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let editor_path = vault.path().join(ANNOTATION_PATH);
    let edited = late.clone();
    let editor = std::thread::spawn(move || {
        crate::fs::with_file_mutation(|| {
            held_tx.send(()).unwrap();
            release_rx
                .recv()
                .map_err(|e| AppError::message(e.to_string()))?;
            crate::fs::atomic_write(&editor_path, &edited)?;
            Ok(())
        })
    });
    held_rx.recv().unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let sync_vault = vault.path().to_path_buf();
    let sync = std::thread::spawn(move || {
        let progress = |phase: &str, _: usize, _: usize| {
            if phase == "download" {
                started_tx.send(()).unwrap();
            }
        };
        let result = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(apply_local(
                &sync_vault,
                &MemStore::default(),
                &plan,
                &scanned,
                &mut SyncOutcome::default(),
                &progress,
            ));
        done_tx.send(result.map_err(|e| e.to_string())).unwrap();
    });
    started_rx.recv().unwrap();
    let premature = done_rx.recv_timeout(std::time::Duration::from_millis(100));
    release_tx.send(()).unwrap();
    editor.join().unwrap().unwrap();
    assert!(
        matches!(premature, Err(std::sync::mpsc::RecvTimeoutError::Timeout)),
        "sync must wait for the editor's mutation lane"
    );
    assert!(done_rx
        .recv()
        .unwrap()
        .unwrap_err()
        .contains("changed during sync"));
    sync.join().unwrap();
    assert_eq!(fs::read(vault.path().join(ANNOTATION_PATH)).unwrap(), late);
}

/// Deterministic fault injection around real RemoteStore calls: mutate a file
/// during GET, or let a prepared third-device HEAD win the next CAS.
struct MarksRaceStore<'a> {
    store: &'a MemStore,
    on_get: Mutex<Option<(String, PathBuf, Vec<u8>)>>,
    head_winner: Mutex<Option<Vec<u8>>>,
    on_lost_cas: Mutex<Option<(PathBuf, Vec<u8>)>>,
}

impl<'a> MarksRaceStore<'a> {
    fn new(store: &'a MemStore) -> Self {
        Self {
            store,
            on_get: Mutex::new(None),
            head_winner: Mutex::new(None),
            on_lost_cas: Mutex::new(None),
        }
    }
}

impl RemoteStore for MarksRaceStore<'_> {
    async fn ensure_root(&self) -> Result<(), AppError> {
        self.store.ensure_root().await
    }
    async fn probe_conditional_writes(&self) -> Result<bool, AppError> {
        self.store.probe_conditional_writes().await
    }
    async fn get(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, AppError> {
        let edit = {
            let mut hook = self.on_get.lock().unwrap();
            if hook.as_ref().is_some_and(|(want, _, _)| want == key) {
                hook.take()
            } else {
                None
            }
        };
        if let Some((_, path, bytes)) = edit {
            fs::write(path, bytes)?;
        }
        self.store.get(key).await
    }
    async fn put(
        &self,
        key: &str,
        body: Vec<u8>,
        condition: PutCondition,
    ) -> Result<PutOutcome, AppError> {
        let winner = if key == HEAD_KEY {
            self.head_winner.lock().unwrap().take()
        } else {
            None
        };
        if let Some(winner) = winner {
            assert_eq!(
                self.store.put(key, winner, condition).await?,
                PutOutcome::Ok
            );
            if let Some((path, bytes)) = self.on_lost_cas.lock().unwrap().take() {
                fs::write(path, bytes)?;
            }
            return Ok(PutOutcome::PreconditionFailed);
        }
        self.store.put(key, body, condition).await
    }
}

#[tokio::test]
async fn marks_semantic_merge_refuses_local_edits_during_remote_fetch() {
    let store = MemStore::default();
    let cfg = SyncBackendConfig::default();
    let (a, b) = mark_vault_pair(&store, ANNOTATION_PATH, b"[]").await;
    let remote = annotations(vec![annotation("a", "a")]);
    write_mark(a.path(), ANNOTATION_PATH, &remote);
    write_mark(
        b.path(),
        ANNOTATION_PATH,
        &annotations(vec![annotation("b", "b")]),
    );
    run_sync(a.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let late = annotations(vec![
        annotation("b", "unsaved until after scan"),
        annotation("late", "must survive"),
    ]);
    let race = MarksRaceStore::new(&store);
    *race.on_get.lock().unwrap() = Some((
        blob_key(&snapshot::hash_bytes(&remote)),
        b.path().join(ANNOTATION_PATH),
        late.clone(),
    ));
    let error = run_sync(b.path(), &cfg, &race, noop_progress())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("changed during sync"));
    assert_eq!(fs::read(b.path().join(ANNOTATION_PATH)).unwrap(), late);
    run_sync(b.path(), &cfg, &store, noop_progress())
        .await
        .unwrap();
    let merged: Vec<serde_json::Value> =
        serde_json::from_slice(&fs::read(b.path().join(ANNOTATION_PATH)).unwrap()).unwrap();
    assert_eq!(merged.len(), 3, "a retry can merge the late edit safely");
}

#[tokio::test]
async fn marks_cas_retry_preserves_third_device_addition_and_checks_local_bytes() {
    for local_edit in [false, true] {
        let store = MemStore::default();
        let cfg = SyncBackendConfig::default();
        let (a, b) = mark_vault_pair(&store, ANNOTATION_PATH, b"[]").await;
        let c = tempfile::tempdir().unwrap();
        run_sync(c.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        write_mark(
            a.path(),
            ANNOTATION_PATH,
            &annotations(vec![annotation("a", "a")]),
        );
        run_sync(a.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        let (previous_head, _) = store.get(HEAD_KEY).await.unwrap().unwrap();
        write_mark(
            c.path(),
            ANNOTATION_PATH,
            &annotations(vec![annotation("c", "c")]),
        );
        run_sync(c.path(), &cfg, &store, noop_progress())
            .await
            .unwrap();
        let (third_head, third_etag) = store.get(HEAD_KEY).await.unwrap().unwrap();
        // All third-device blobs/manifests exist, but B initially sees the
        // preceding HEAD. Its first CAS will lose to the prepared third HEAD.
        store
            .put(HEAD_KEY, previous_head, PutCondition::IfMatch(third_etag))
            .await
            .unwrap();
        write_mark(
            b.path(),
            ANNOTATION_PATH,
            &annotations(vec![annotation("b", "b")]),
        );
        let race = MarksRaceStore::new(&store);
        *race.head_winner.lock().unwrap() = Some(third_head);
        let late = annotations(vec![annotation("late", "editor changed after apply")]);
        if local_edit {
            *race.on_lost_cas.lock().unwrap() =
                Some((b.path().join(ANNOTATION_PATH), late.clone()));
        }
        let result = run_sync(b.path(), &cfg, &race, noop_progress()).await;
        if local_edit {
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("changed during sync"));
            assert_eq!(fs::read(b.path().join(ANNOTATION_PATH)).unwrap(), late);
        } else {
            assert!(result.unwrap().conflict_copies.is_empty());
            for vault in [a.path(), c.path()] {
                run_sync(vault, &cfg, &store, noop_progress())
                    .await
                    .unwrap();
            }
            let expected = vec![
                annotation("a", "a"),
                annotation("b", "b"),
                annotation("c", "c"),
            ];
            for vault in [a.path(), b.path(), c.path()] {
                let items: Vec<serde_json::Value> =
                    serde_json::from_slice(&fs::read(vault.join(ANNOTATION_PATH)).unwrap())
                        .unwrap();
                assert_eq!(
                    items, expected,
                    "CAS retry must use the winner's immutable base"
                );
            }
        }
    }
}
