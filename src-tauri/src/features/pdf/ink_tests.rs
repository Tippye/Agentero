use super::*;
use std::sync::Barrier;

#[test]
fn replica_identity_survives_restart_and_concurrent_initialization() {
    let dir = tempfile::tempdir().unwrap();
    let directory = dir.path().join("ink");
    let barrier = Arc::new(Barrier::new(9));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let directory = directory.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                load_or_create_actor(&directory).unwrap()
            })
        })
        .collect();
    barrier.wait();
    let identities: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert!(!identities[0].is_nil());
    assert!(identities.iter().all(|id| *id == identities[0]));
    assert_eq!(load_or_create_actor(&directory).unwrap(), identities[0]);
    assert_eq!(
        fs::read_to_string(directory.join("replica-id")).unwrap(),
        format!("{}\n", identities[0])
    );
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
}

#[test]
fn invalid_or_inaccessible_actor_storage_never_rotates_existing_identity() {
    let dir = tempfile::tempdir().unwrap();
    let directory = dir.path().join("ink");
    fs::create_dir(&directory).unwrap();
    let path = directory.join("replica-id");
    for bytes in [
        b"".as_slice(),
        b"broken",
        b"00000000-0000-0000-0000-000000000000\n",
        b"{\"futureIdentity\":1}",
    ] {
        fs::write(&path, bytes).unwrap();
        assert_eq!(
            load_or_create_actor(&directory).unwrap_err().code(),
            "ink_actor_invalid"
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    // A non-directory parent fails creation rather than minting a transient ID.
    let blocked_parent = dir.path().join("blocked");
    fs::write(&blocked_parent, b"keep").unwrap();
    assert!(load_or_create_actor(&blocked_parent.join("ink")).is_err());
    assert_eq!(fs::read(&blocked_parent).unwrap(), b"keep");
}

#[test]
fn private_vault_guard_and_actor_location_use_canonical_roots() {
    let private = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let private_path = private.path().to_string_lossy();
    assert_eq!(
        checked_vault(&private_path, Some(private.path())).unwrap(),
        fs::canonicalize(private.path()).unwrap()
    );
    assert_eq!(
        checked_vault(&other.path().to_string_lossy(), Some(private.path()))
            .unwrap_err()
            .code(),
        "ink_private_vault_required"
    );
    for path in ["relative/Vault", "bridge:Vault", "remote:Vault"] {
        assert!(checked_vault(path, None).is_err());
    }
    let root = fs::canonicalize(private.path()).unwrap();
    assert_eq!(
        actor_at_config(&private.path().join("config"), &root)
            .unwrap_err()
            .code(),
        "ink_actor_invalid"
    );
    assert!(!private.path().join("config/ink/replica-id").exists());
    let actor = actor_at_config(other.path(), &root).unwrap();
    assert_eq!(actor_at_config(other.path(), &root).unwrap(), actor);
}

#[test]
fn actor_directory_cannot_be_the_vault_even_when_config_is_its_parent() {
    let config = tempfile::tempdir().unwrap();
    let directory = config.path().join("ink");
    fs::create_dir(&directory).unwrap();
    let vault = fs::canonicalize(&directory).unwrap();
    assert_eq!(
        actor_at_config(config.path(), &vault).unwrap_err().code(),
        "ink_actor_invalid"
    );
    let identity = directory.join("replica-id");
    assert!(!identity.exists());
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
    let original = format!("{}\n", Uuid::from_u128(7));
    fs::write(&identity, &original).unwrap();
    assert_eq!(
        actor_at_config(config.path(), &vault).unwrap_err().code(),
        "ink_actor_invalid"
    );
    assert_eq!(fs::read(&identity).unwrap(), original.as_bytes());
}

#[cfg(unix)]
#[test]
fn linked_actor_files_are_not_followed_or_overwritten() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let identity = outside.path().join("source.pdf");
    fs::write(&identity, b"%PDF source").unwrap();
    let directory = dir.path().join("ink");
    fs::create_dir(&directory).unwrap();
    symlink(&identity, directory.join("replica-id")).unwrap();
    assert!(load_or_create_actor(&directory).is_err());
    assert!(actor_at_config(dir.path(), &fs::canonicalize(outside.path()).unwrap()).is_err());
    assert_eq!(fs::read(&identity).unwrap(), b"%PDF source");
    let linked = dir.path().join("linked");
    symlink(outside.path(), &linked).unwrap();
    assert!(load_or_create_actor(&linked).is_err());
    let linked_config = dir.path().join("config");
    fs::create_dir(&linked_config).unwrap();
    symlink(outside.path(), linked_config.join("ink")).unwrap();
    assert!(actor_at_config(&linked_config, &fs::canonicalize(outside.path()).unwrap()).is_err());
    assert!(!outside.path().join("replica-id").exists());
}

#[cfg(unix)]
#[test]
fn actor_sync_stays_within_the_app_config_root_on_creation_and_reload() {
    let sandbox = tempfile::tempdir().unwrap();
    let config = sandbox.path().join("app.agentero");
    fs::create_dir(&config).unwrap();
    let directory = config.join("ink");
    let mut synced = Vec::new();
    let mut sync = |directory: &Path| {
        sync_actor_directories_with(directory, |path| {
            // Model Android's /data/user/0 boundary, and perform actual fsync
            // for every admitted directory. The old third ancestor fails here.
            if !path.starts_with(&config) {
                return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
            }
            fs::File::open(path)?.sync_all()?;
            synced.push(path.to_path_buf());
            Ok(())
        })
    };
    let actor = load_or_create_actor_with(&directory, &mut sync).unwrap();
    assert_eq!(
        load_or_create_actor_with(&directory, &mut sync).unwrap(),
        actor
    );
    assert_eq!(
        synced,
        [directory.clone(), config.clone(), directory.clone(), config]
    );
    assert_eq!(
        read_actor(&directory.join("replica-id")).unwrap(),
        Some(actor)
    );
}

#[test]
fn actor_postpublication_sync_failure_retains_identity_for_exact_retry() {
    let dir = tempfile::tempdir().unwrap();
    let directory = dir.path().join("ink");
    let result = load_or_create_actor_with(&directory, |_| {
        Err(std::io::Error::other(
            "injected actor directory fsync failure",
        ))
    });
    assert_eq!(result.unwrap_err().code(), "ink_unavailable");
    let path = directory.join("replica-id");
    let original = fs::read(&path).unwrap();
    let published = read_actor(&path).unwrap().unwrap();
    let result = load_or_create_actor_with(&directory, |_| {
        Err(std::io::Error::other("still unavailable"))
    });
    assert_eq!(result.unwrap_err().code(), "ink_unavailable");
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(load_or_create_actor(&directory).unwrap(), published);
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn dropping_an_unadmitted_request_signals_cancellation() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let guard = CancelBeforeAdmission(Arc::clone(&cancelled));
    assert!(!cancelled.load(Ordering::Acquire));
    drop(guard);
    assert!(cancelled.load(Ordering::Acquire));
}
