use super::*;
use std::sync::{Arc, Barrier};

fn setup() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("papers/paper")).unwrap();
    dir
}

fn draft(id: u128) -> InkStrokeDraft {
    InkStrokeDraft {
        id: Uuid::from_u128(id),
        tool: InkTool::Pen,
        color: [20, 30, 40, 255],
        base_width: 1.5,
        points: vec![InkDraftPoint {
            x: 20.5,
            y: 40.0,
            pressure: Some(0.5),
            elapsed_ms: Some(0),
            tilt: None,
        }],
        created_at_ms: None,
        updated_at_ms: None,
    }
}

fn put(id: u128) -> Vec<InkEdit> {
    vec![InkEdit::Put { stroke: draft(id) }]
}
fn actor() -> Uuid {
    Uuid::from_u128(99)
}
fn apply(
    vault: &Path,
    revision: Option<&str>,
    operations: &[InkEdit],
) -> Result<InkPageSnapshot, AppError> {
    apply_drafts(vault, "papers/paper", 2, revision, actor(), 200, operations)
}

#[test]
fn read_and_restart_keep_exact_baselines_and_raw_files() {
    let dir = setup();
    let empty = read_page(dir.path(), "papers/paper", 2).unwrap();
    assert!(empty.revision.is_none());
    let saved = apply(dir.path(), None, &put(1)).unwrap();
    let path = page_path(dir.path(), "papers/paper", 2).unwrap();
    let original = fs::read(&path).unwrap();
    let restarted = read_page(dir.path(), "papers/paper", 2).unwrap();
    assert_eq!(restarted.document, saved.document);
    assert_eq!(
        restarted.creation_times[&Uuid::from_u128(1).to_string()],
        "200"
    );
    assert_eq!(
        restarted.revision,
        Some(hex::encode(Sha256::digest(&original)))
    );
    // Formatting is part of the CAS version, not part of model normalization.
    let pretty = serde_json::to_vec_pretty(&saved.document).unwrap();
    fs::write(&path, &pretty).unwrap();
    let reread = read_page(dir.path(), "papers/paper", 2).unwrap();
    assert_ne!(reread.revision, saved.revision);
    assert_eq!(reread.document, saved.document);
    assert_eq!(fs::read(&path).unwrap(), pretty);
    assert_eq!(
        apply(dir.path(), saved.revision.as_deref(), &put(2))
            .unwrap_err()
            .code(),
        "ink_conflict"
    );
    assert_eq!(fs::read(&path).unwrap(), pretty);
}

#[test]
fn deletion_is_persisted_and_undo_restores_metadata_above_large_native_counters() {
    let dir = setup();
    let saved = apply(dir.path(), None, &put(1)).unwrap();
    let path = page_path(dir.path(), "papers/paper", 2).unwrap();
    let mut imported = saved.document;
    imported.strokes[0].revision.counter = (1u64 << 53) + 17;
    imported.strokes[0].created_at_ms = u64::MAX - 2;
    imported.strokes[0].updated_at_ms = u64::MAX - 1;
    fs::write(&path, imported.to_json().unwrap()).unwrap();
    let read = read_page(dir.path(), "papers/paper", 2).unwrap();
    let deleted = apply(
        dir.path(),
        read.revision.as_deref(),
        &[InkEdit::Delete {
            id: Uuid::from_u128(1),
        }],
    )
    .unwrap();
    assert!(deleted.document.strokes.is_empty());
    assert_eq!(deleted.document.tombstones.len(), 1);
    assert_eq!(
        deleted.document.tombstones[0].revision.counter,
        (1u64 << 53) + 18
    );
    assert!(path.is_file()); // Empty live pages still retain their tombstones.
    let mut restore = draft(1);
    restore.created_at_ms = Some(read.creation_times[&restore.id.to_string()].clone());
    restore.updated_at_ms = Some(read.update_times[&restore.id.to_string()].clone());
    let restored = apply(
        dir.path(),
        deleted.revision.as_deref(),
        &[InkEdit::Put { stroke: restore }],
    )
    .unwrap();
    assert!(restored.document.tombstones.is_empty());
    assert_eq!(
        restored.document.strokes[0].revision.counter,
        (1u64 << 53) + 19
    );
    assert_eq!(restored.document.strokes[0].created_at_ms, u64::MAX - 2);
    assert_eq!(restored.document.strokes[0].updated_at_ms, u64::MAX - 1);
    assert_eq!(
        read_page(dir.path(), "papers/paper", 2).unwrap().document,
        restored.document
    );
}

#[test]
fn two_writers_and_sync_replacements_cannot_bypass_the_baseline() {
    let dir = setup();
    let saved = apply(dir.path(), None, &put(1)).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = (2..=3)
        .map(|id| {
            let root = dir.path().to_path_buf();
            let baseline = saved.revision.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                apply(&root, baseline.as_deref(), &put(id))
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| result.as_ref().is_err_and(|e| e.code() == "ink_conflict"))
            .count(),
        1
    );
    let after = read_page(dir.path(), "papers/paper", 2).unwrap();
    let path = page_path(dir.path(), "papers/paper", 2).unwrap();
    let mut synced = after.document.clone();
    synced.strokes[0].color = [0, 0, 0, 255];
    let sync_bytes = synced.to_json().unwrap().into_bytes();
    with_file_mutation(|| {
        crate::fs::atomic_write(&path, &sync_bytes)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        apply(dir.path(), after.revision.as_deref(), &put(4))
            .unwrap_err()
            .code(),
        "ink_conflict"
    );
    assert_eq!(fs::read(path).unwrap(), sync_bytes);
}

#[test]
fn concurrent_reads_return_document_and_hash_from_one_snapshot() {
    let dir = setup();
    let saved = apply(dir.path(), None, &put(1)).unwrap();
    let path = page_path(dir.path(), "papers/paper", 2).unwrap();
    let mut alternate = saved.document.clone();
    alternate.strokes[0].color = [100, 0, 0, 255];
    let variants = [
        saved.document.to_json().unwrap().into_bytes(),
        alternate.to_json().unwrap().into_bytes(),
    ];
    let barrier = Arc::new(Barrier::new(2));
    let writer_barrier = Arc::clone(&barrier);
    let writer = std::thread::spawn(move || {
        writer_barrier.wait();
        for index in 0..50 {
            with_file_mutation(|| {
                crate::fs::atomic_write(&path, &variants[index % 2])?;
                Ok(())
            })
            .unwrap();
        }
    });
    barrier.wait();
    for _ in 0..50 {
        let snapshot = read_page(dir.path(), "papers/paper", 2).unwrap();
        let bytes = snapshot.document.to_json().unwrap();
        assert_eq!(
            snapshot.revision,
            Some(hex::encode(Sha256::digest(bytes.as_bytes())))
        );
    }
    writer.join().unwrap();
}

#[test]
fn malformed_unknown_and_excessive_files_are_retained_without_empty_fallback() {
    let dir = setup();
    let saved = apply(dir.path(), None, &put(1)).unwrap();
    let path = page_path(dir.path(), "papers/paper", 2).unwrap();
    let mut unknown = serde_json::to_value(&saved.document).unwrap();
    unknown["strokes"][0]["futurePressure"] = serde_json::json!({ "samples": [1, 2] });
    for bytes in [b"{broken".to_vec(), serde_json::to_vec(&unknown).unwrap()] {
        fs::write(&path, &bytes).unwrap();
        assert!(read_page(dir.path(), "papers/paper", 2).is_err());
        assert!(apply(dir.path(), saved.revision.as_deref(), &put(2)).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    fs::File::create(&path)
        .unwrap()
        .set_len(MAX_INK_BYTES as u64 + 1)
        .unwrap();
    assert_eq!(
        read_page(dir.path(), "papers/paper", 2).unwrap_err().code(),
        "ink_invalid"
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), MAX_INK_BYTES as u64 + 1);
}

#[test]
fn invalid_drafts_and_revision_exhaustion_leave_the_existing_page_unchanged() {
    let dir = setup();
    let saved = apply(dir.path(), None, &put(1)).unwrap();
    let path = page_path(dir.path(), "papers/paper", 2).unwrap();
    let bytes = fs::read(&path).unwrap();
    let mut nonfinite = draft(2);
    nonfinite.points[0].x = f64::NAN;
    let mut oversized = draft(2);
    oversized.points = vec![oversized.points[0].clone(); MAX_STROKE_POINTS + 1];
    for edits in [
        vec![],
        vec![InkEdit::Put { stroke: nonfinite }],
        vec![InkEdit::Put { stroke: oversized }],
        vec![InkEdit::Delete { id: Uuid::nil() }],
        vec![
            InkEdit::Delete {
                id: Uuid::from_u128(2)
            };
            MAX_INK_OPERATIONS + 1
        ],
    ] {
        assert!(apply(dir.path(), saved.revision.as_deref(), &edits).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    let mut exhausted = saved.document;
    exhausted.strokes[0].revision.counter = u64::MAX;
    fs::write(&path, exhausted.to_json().unwrap()).unwrap();
    let before = fs::read(&path).unwrap();
    let revision = read_page(dir.path(), "papers/paper", 2).unwrap().revision;
    assert!(apply(dir.path(), revision.as_deref(), &put(2)).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn cancelled_or_protected_writes_leave_original_bytes() {
    let dir = setup();
    let saved = apply(dir.path(), None, &put(1)).unwrap();
    let path = page_path(dir.path(), "papers/paper", 2).unwrap();
    let before = fs::read(&path).unwrap();
    let result = apply_drafts_checked(
        dir.path(),
        "papers/paper",
        2,
        saved.revision.as_deref(),
        actor(),
        300,
        &put(2),
        || Err(AppError::domain("ink_cancelled", "cancelled")),
    );
    assert_eq!(result.unwrap_err().code(), "ink_cancelled");
    assert_eq!(fs::read(&path).unwrap(), before);
    let permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let result = apply(dir.path(), saved.revision.as_deref(), &put(2));
    fs::set_permissions(&path, permissions).unwrap();
    assert_eq!(result.unwrap_err().code(), "ink_protected");
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(fs::read_dir(path.parent().unwrap())
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
}

#[test]
fn io_failure_before_publication_preserves_original_but_after_rename_is_uncertain() {
    let dir = setup();
    let saved = apply(dir.path(), None, &put(1)).unwrap();
    let path = page_path(dir.path(), "papers/paper", 2).unwrap();
    let original = fs::read(&path).unwrap();
    let precommit = apply_drafts_checked(
        dir.path(),
        "papers/paper",
        2,
        saved.revision.as_deref(),
        actor(),
        300,
        &put(2),
        || Err(std::io::Error::other("injected failure before publication").into()),
    );
    assert_eq!(precommit.unwrap_err().code(), "io");
    assert_eq!(fs::read(&path).unwrap(), original);

    let mut published = saved.document;
    published.strokes[0].revision.counter += 1;
    published.strokes[0].points[0].x = 21.5;
    let replacement = published.to_json().unwrap().into_bytes();
    let postcommit = with_file_mutation(|| {
        publish_ink_file(&path, &replacement, |_| {
            Err(std::io::Error::other(
                "injected directory fsync failure after rename",
            ))
        })
    });
    let error = postcommit.unwrap_err();
    assert_eq!(error.code(), "ink_unavailable");
    assert!(error.to_string().contains("may already be visible"));
    assert_eq!(fs::read(&path).unwrap(), replacement);
    let actual = read_page(dir.path(), "papers/paper", 2).unwrap();
    assert_eq!(actual.document, published); // Same ID is visible; never recreate it.
    assert_ne!(actual.revision, saved.revision);
    assert_eq!(
        apply(dir.path(), saved.revision.as_deref(), &put(1))
            .unwrap_err()
            .code(),
        "ink_conflict"
    );
}

#[test]
fn paths_are_canonical_and_bounded() {
    let dir = setup();
    for folder in [
        "paper",
        "papers/../paper",
        "papers/paper/..",
        "papers\\paper",
        "/papers/paper",
        "papers/paper/extra",
        "papers/paper.",
        "remote:papers/paper",
    ] {
        assert!(page_path(dir.path(), folder, 2).is_err());
    }
    for page in [0, 100_001, u32::MAX] {
        assert!(page_path(dir.path(), "papers/paper", page).is_err());
    }
    assert!(page_path(dir.path(), &format!("papers/{}", "a".repeat(181)), 2).is_err());
}

#[cfg(unix)]
#[test]
fn linked_parents_and_leaf_files_cannot_escape_or_modify_another_file() {
    use std::os::unix::fs::symlink;
    let outside = tempfile::tempdir().unwrap();
    let source = outside.path().join("original.pdf");
    fs::write(&source, b"%PDF original").unwrap();
    for linked_parent in [false, true] {
        let dir = setup();
        let paper = dir.path().join("papers/paper");
        if linked_parent {
            symlink(outside.path(), paper.join("marks")).unwrap();
        } else {
            fs::create_dir_all(paper.join("marks/ink")).unwrap();
            symlink(&source, paper.join("marks/ink/p2.json")).unwrap();
        }
        assert!(read_page(dir.path(), "papers/paper", 2).is_err());
        assert!(apply(dir.path(), None, &put(1)).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"%PDF original");
    }
}
