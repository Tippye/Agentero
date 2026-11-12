use super::*;
use std::sync::{Arc, Barrier};

fn route(paper: &str) -> MobileWindowRoute {
    MobileWindowRoute {
        paper_id: Some(paper.into()),
        tab: MobileRouteTab::Agent,
        reader_mode: MobileReaderMode::Notes,
        preset: MobileRoutePreset::Compare,
        pdf: Some(MobilePdfPosition {
            page: 37,
            zoom: 1.25,
        }),
    }
}
fn fixture() -> (tempfile::TempDir, MobileRouteStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = MobileRouteStore::new(directory.path().join("routes"));
    (directory, store)
}

#[test]
fn roundtrip_restart_and_scopes_preserve_reading_context_without_opening_vault_paths() {
    let (_directory, store) = fixture();
    let vault = "../../opaque/not-a-real-vault";
    assert_eq!(
        store.read("main", vault).unwrap(),
        MobileRouteSnapshot {
            revision: "0".into(),
            route: None
        }
    );
    assert!(
        !store.root.exists(),
        "reading absent state must not create files"
    );
    let saved = store.save("main", vault, "0", route("paper-a")).unwrap();
    let restarted = MobileRouteStore::new(store.root.clone());
    assert_eq!(restarted.read("main", vault).unwrap(), saved);
    let doc = "doc-0123456789abcdef";
    assert!(restarted.read(doc, vault).unwrap().route.is_none());
    assert!(restarted
        .read("main", "another-vault")
        .unwrap()
        .route
        .is_none());
    restarted
        .save(doc, vault, "0", route("document-paper"))
        .unwrap();
    restarted
        .save("main", "another-vault", "0", route("other-vault-paper"))
        .unwrap();
    assert_eq!(restarted.read("main", vault).unwrap(), saved);
    let paths: Vec<_> = fs::read_dir(&store.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(paths.len(), 3);
    assert!(paths.iter().all(|name| {
        let name = name.to_str().unwrap();
        name.len() == 69
            && name.ends_with(".json")
            && name[..64].bytes().all(|byte| byte.is_ascii_hexdigit())
    }));
    let json = serde_json::to_value(saved.route.unwrap()).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "paperId":"paper-a", "tab":"agent", "readerMode":"notes", "preset":"compare", "pdf":{"page":37,"zoom":1.25} })
    );
}

#[test]
fn concurrent_cas_has_one_winner_and_never_overwrites_a_newer_route() {
    let (_directory, store) = fixture();
    store.save("main", "vault", "0", route("initial")).unwrap();
    let ready = Arc::new(Barrier::new(3));
    let workers: Vec<_> = ["paper-a", "paper-b"]
        .into_iter()
        .map(|paper| {
            let store = MobileRouteStore::new(store.root.clone());
            let ready = ready.clone();
            std::thread::spawn(move || {
                ready.wait();
                store.save("main", "vault", "1", route(paper))
            })
        })
        .collect();
    ready.wait();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(results
        .iter()
        .filter_map(|result| result.as_ref().err())
        .all(|error| error.code() == "mobile_route_conflict"));
    let winner = results.into_iter().find_map(Result::ok).unwrap();
    assert_eq!(winner.revision, "2");
    assert_eq!(store.read("main", "vault").unwrap(), winner);
    assert_eq!(
        store
            .save("main", "vault", "1", route("stale"))
            .unwrap_err()
            .code(),
        "mobile_route_conflict"
    );
    assert_eq!(store.read("main", "vault").unwrap(), winner);
}

#[test]
fn corrupt_or_oversized_storage_is_reported_and_preserved_on_save() {
    let (_directory, store) = fixture();
    store.save("main", "vault", "0", route("saved")).unwrap();
    let path = store.path("main", "vault").unwrap();
    let mut bad_revision = serde_json::to_value(MobileRouteSnapshot {
        revision: "01".into(),
        route: Some(route("saved")),
    })
    .unwrap();
    let mut bad_zoom = bad_revision.clone();
    bad_zoom["revision"] = "1".into();
    bad_zoom["route"]["pdf"]["zoom"] = 1000.into();
    bad_revision["extra"] = true.into();
    for bytes in [
        b"{\"revision\":".to_vec(),
        serde_json::to_vec(&bad_revision).unwrap(),
        serde_json::to_vec(&bad_zoom).unwrap(),
        vec![b'x'; MAX_FILE + 1],
    ] {
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            store.read("main", "vault").unwrap_err().code(),
            "mobile_route_corrupt"
        );
        assert_eq!(
            store
                .save("main", "vault", "1", route("replacement"))
                .unwrap_err()
                .code(),
            "mobile_route_corrupt"
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn invalid_scope_position_and_revision_never_create_or_replace_state() {
    let (_directory, store) = fixture();
    for label in [
        "settings",
        "doc-../../escape",
        "main/other",
        "doc-0123456789abcdeF",
    ] {
        assert_eq!(
            store
                .save(label, "vault", "0", route("paper"))
                .unwrap_err()
                .code(),
            "mobile_route_scope"
        );
    }
    for value in ["", "01", "+1", "-1", "18446744073709551616"] {
        assert_eq!(
            store
                .save("main", "vault", value, route("paper"))
                .unwrap_err()
                .code(),
            "mobile_route_invalid"
        );
    }
    for zoom in [f64::NAN, f64::INFINITY, 0.0, 10.01] {
        let mut invalid = route("paper");
        invalid.pdf.as_mut().unwrap().zoom = zoom;
        assert_eq!(
            store
                .save("main", "vault", "0", invalid)
                .unwrap_err()
                .code(),
            "mobile_route_invalid"
        );
    }
    for page in [0, 1_000_001] {
        let mut invalid = route("paper");
        invalid.pdf.as_mut().unwrap().page = page;
        assert!(store.save("main", "vault", "0", invalid).is_err());
    }
    let mut orphan = route("paper");
    orphan.paper_id = None;
    assert!(store.save("main", "vault", "0", orphan).is_err());
    assert!(store.save("main", "\0", "0", route("paper")).is_err());
    assert!(store
        .save("main", &"v".repeat(MAX_VAULT + 1), "0", route("paper"))
        .is_err());
    assert!(!store.root.exists());
    store.save("main", "vault", "0", route("saved")).unwrap();
    let path = store.path("main", "vault").unwrap();
    let last = MobileRouteSnapshot {
        revision: u64::MAX.to_string(),
        route: Some(route("saved")),
    };
    fs::write(&path, serde_json::to_vec(&last).unwrap()).unwrap();
    assert_eq!(
        store
            .save("main", "vault", &u64::MAX.to_string(), route("no-wrap"))
            .unwrap_err()
            .code(),
        "mobile_route_exhausted"
    );
    assert_eq!(store.read("main", "vault").unwrap(), last);
}

#[cfg(unix)]
#[test]
fn symlink_target_cannot_read_or_overwrite_an_unrelated_file() {
    let (directory, store) = fixture();
    fs::create_dir_all(&store.root).unwrap();
    let outside = directory.path().join("unrelated.json");
    fs::write(&outside, b"unrelated content").unwrap();
    std::os::unix::fs::symlink(&outside, store.path("main", "vault").unwrap()).unwrap();
    assert_eq!(
        store.read("main", "vault").unwrap_err().code(),
        "mobile_route_corrupt"
    );
    assert_eq!(
        store
            .save("main", "vault", "0", route("paper"))
            .unwrap_err()
            .code(),
        "mobile_route_corrupt"
    );
    assert_eq!(fs::read(outside).unwrap(), b"unrelated content");
}
