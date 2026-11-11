use super::*;
use crate::integration::credentials::CredentialBackend;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Condvar, Mutex,
};

#[derive(Default)]
pub(crate) struct Gate {
    pub(crate) entered: tokio::sync::Notify,
    open: Mutex<bool>,
    changed: Condvar,
}
impl Gate {
    fn wait(&self) {
        self.entered.notify_one();
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.changed.wait(open).unwrap();
        }
    }
    pub(crate) fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.changed.notify_all();
    }
}
#[derive(Default)]
pub(crate) struct Memory {
    pub(crate) values: Mutex<HashMap<String, String>>,
    pub(crate) reads: AtomicUsize,
    pub(crate) writes: Mutex<Vec<String>>,
    pub(crate) read_fault: Mutex<Option<CredentialError>>,
    pub(crate) write_fault: Mutex<Option<CredentialError>>,
    pub(crate) unknown_write: AtomicBool,
    pub(crate) read_gate: Mutex<Option<Arc<Gate>>>,
    pub(crate) write_gate: Mutex<Option<Arc<Gate>>>,
    pub(crate) after_write: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl CredentialBackend for Memory {
    fn read(&self, key: &str) -> Result<Option<String>, CredentialError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let gate = self.read_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.wait();
        }
        if let Some(error) = *self.read_fault.lock().unwrap() {
            return Err(error);
        }
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn write(&self, key: &str, value: &str) -> Result<(), CredentialError> {
        self.writes.lock().unwrap().push(value.into());
        let gate = self.write_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.wait();
        }
        let fault = *self.write_fault.lock().unwrap();
        if fault.is_none() || self.unknown_write.load(Ordering::SeqCst) {
            self.values.lock().unwrap().insert(key.into(), value.into());
        }
        if let Some(hook) = self.after_write.lock().unwrap().take() {
            hook();
        }
        if let Some(error) = fault {
            Err(error)
        } else {
            Ok(())
        }
    }
    fn remove(&self, key: &str) -> Result<(), CredentialError> {
        self.values.lock().unwrap().remove(key);
        Ok(())
    }
}
#[derive(Default)]
pub(crate) struct Legacy {
    pub(crate) values: Mutex<HashMap<LegacySource, Vec<u8>>>,
    pub(crate) reads: AtomicUsize,
    pub(crate) json_reads: AtomicUsize,
    pub(crate) keychain_fault: Mutex<Option<IdentityFailure>>,
    pub(crate) remove_fails: AtomicBool,
    pub(crate) replacement_on_remove: Mutex<Option<Vec<u8>>>,
}
impl LegacyIdentityStorage for Legacy {
    fn read(&self, source: LegacySource) -> Result<Option<Vec<u8>>, IdentityFailure> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if source == LegacySource::IosKeychain {
            if let Some(error) = *self.keychain_fault.lock().unwrap() {
                return Err(error);
            }
        } else {
            self.json_reads.fetch_add(1, Ordering::SeqCst);
        }
        Ok(self.values.lock().unwrap().get(&source).cloned())
    }
    fn remove_matching(
        &self,
        source: LegacySource,
        expected: &[u8],
    ) -> Result<bool, IdentityFailure> {
        if self.remove_fails.load(Ordering::SeqCst) {
            return Err(IdentityFailure::Unavailable);
        }
        let mut values = self.values.lock().unwrap();
        if let Some(changed) = self.replacement_on_remove.lock().unwrap().take() {
            values.insert(source, changed);
        }
        if values.get(&source).map(Vec::as_slice) != Some(expected) {
            return Ok(false);
        }
        values.remove(&source);
        Ok(true)
    }
}
pub(crate) struct Fixture {
    pub(crate) dir: PathBuf,
    pub(crate) backend: Arc<Memory>,
    pub(crate) legacy: Arc<Legacy>,
    pub(crate) repository: Arc<ClientIdentityRepository>,
}
impl Fixture {
    pub(crate) fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("agentero-bridge-mobile-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let backend = Arc::new(Memory::default());
        let legacy = Arc::new(Legacy::default());
        let repository = Self::repository_at(&dir, backend.clone(), legacy.clone());
        Self {
            dir,
            backend,
            legacy,
            repository,
        }
    }
    fn repository_at(
        dir: &Path,
        backend: Arc<Memory>,
        legacy: Arc<Legacy>,
    ) -> Arc<ClientIdentityRepository> {
        Arc::new(ClientIdentityRepository {
            strict: true,
            store: Some(CredentialStore::from_backend(backend)),
            files: BridgeClientIdentityStore::at_path(dir.to_owned()),
            legacy,
            pending: tokio::sync::Mutex::new(None),
        })
    }
    pub(crate) fn restart(&self) -> Arc<ClientIdentityRepository> {
        Self::repository_at(&self.dir, self.backend.clone(), self.legacy.clone())
    }
    pub(crate) fn seed_native(&self, identity: &BridgeClientIdentity) {
        let record = SecureClientIdentity::active(serde_json::to_string(identity).unwrap());
        self.backend.values.lock().unwrap().insert(
            CLIENT_RECORD_KEY.into(),
            serde_json::to_string(&record).unwrap(),
        );
    }
    pub(crate) fn native_identity(&self) -> BridgeClientIdentity {
        let raw = self
            .backend
            .values
            .lock()
            .unwrap()
            .get(CLIENT_RECORD_KEY)
            .unwrap()
            .clone();
        serde_json::from_str::<SecureClientIdentity>(&raw)
            .unwrap()
            .parse()
            .unwrap()
    }
    pub(crate) fn put_legacy(
        &self,
        source: LegacySource,
        identity: &BridgeClientIdentity,
    ) -> Vec<u8> {
        let raw = serde_json::to_string_pretty(identity)
            .unwrap()
            .replace('\n', "\r\n")
            .into_bytes();
        self.legacy
            .values
            .lock()
            .unwrap()
            .insert(source, raw.clone());
        raw
    }
    pub(crate) fn profiles(&self) -> BridgeClientProfileStore {
        BridgeClientProfileStore::at_path(self.dir.clone())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn strict_v2_requires_both_successful_keys_and_exact_supported_fields() {
    let valid = BridgeClientIdentity::create();
    let mut invalid = valid.clone();
    invalid.public_key_b64 = "bad".into();
    invalid.secret_key_b64 = "bad".into();
    assert!(matches!(
        validate_client_identity(invalid),
        Err(IdentityFailure::Invalid)
    ));
    for version in [1, 3] {
        let mut invalid = valid.clone();
        invalid.v = version;
        assert!(matches!(
            parse_mobile_identity(&serde_json::to_vec(&invalid).unwrap()),
            Err(IdentityFailure::Invalid)
        ));
    }
    let mut invalid = valid.clone();
    invalid.public_key_b64 = BridgeClientIdentity::create().public_key_b64;
    assert!(validate_client_identity(invalid).is_err());
    let mut value = serde_json::to_value(valid).unwrap();
    value["futureSecret"] = true.into();
    assert!(matches!(
        parse_mobile_identity(&serde_json::to_vec(&value).unwrap()),
        Err(IdentityFailure::Invalid)
    ));
}

#[tokio::test]
async fn json_migration_preserves_exact_identity_bytes_signature_and_restart() {
    let fixture = Fixture::new();
    let identity = BridgeClientIdentity::create();
    let raw = fixture.put_legacy(LegacySource::Json, &identity);
    let before = identity.sign_challenge(b"challenge").unwrap();
    let migrated = fixture.repository.acquire(false).await.unwrap();
    assert_eq!(migrated, identity);
    assert_eq!(migrated.sign_challenge(b"challenge").unwrap(), before);
    let encoded = fixture
        .backend
        .values
        .lock()
        .unwrap()
        .get(CLIENT_RECORD_KEY)
        .unwrap()
        .clone();
    let record: SecureClientIdentity = serde_json::from_str(&encoded).unwrap();
    assert_eq!(record.identity_json.unwrap().as_bytes(), raw);
    assert!(fixture.legacy.values.lock().unwrap().is_empty());
    assert_eq!(fixture.restart().acquire(false).await.unwrap(), identity);
    assert_eq!(fixture.backend.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn ios_keychain_precedes_json_and_native_record_precedes_conflicting_legacy() {
    let fixture = Fixture::new();
    let ios = BridgeClientIdentity::create();
    let json = BridgeClientIdentity::create();
    fixture.put_legacy(LegacySource::IosKeychain, &ios);
    let json_raw = fixture.put_legacy(LegacySource::Json, &json);
    assert_eq!(fixture.repository.acquire(false).await.unwrap(), ios);
    assert_eq!(
        fixture
            .legacy
            .values
            .lock()
            .unwrap()
            .get(&LegacySource::Json),
        Some(&json_raw)
    );
    assert_eq!(fixture.restart().acquire(false).await.unwrap(), ios);
    assert_eq!(fixture.backend.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn native_errors_and_invalid_envelopes_never_fall_back_or_rotate() {
    for error in [
        CredentialError::Locked,
        CredentialError::Unavailable,
        CredentialError::InvalidRecord,
    ] {
        let fixture = Fixture::new();
        fixture.put_legacy(LegacySource::Json, &BridgeClientIdentity::create());
        *fixture.backend.read_fault.lock().unwrap() = Some(error);
        let expected = IdentityFailure::from(error).app_error();
        assert_eq!(
            fixture.repository.acquire(true).await.unwrap_err().code(),
            expected.code()
        );
        assert_eq!(fixture.legacy.reads.load(Ordering::SeqCst), 0);
        assert!(fixture.backend.writes.lock().unwrap().is_empty());
    }
    let fixture = Fixture::new();
    fixture.put_legacy(LegacySource::Json, &BridgeClientIdentity::create());
    for malformed in [
        "{}",
        "{\"v\":3}",
        "{\"v\":2,\"identityJson\":null,\"cleared\":false,\"cleanupComplete\":true}",
    ] {
        fixture
            .backend
            .values
            .lock()
            .unwrap()
            .insert(CLIENT_RECORD_KEY.into(), malformed.into());
        assert_eq!(
            fixture.repository.acquire(true).await.unwrap_err().code(),
            "bridge_identity_invalid"
        );
    }
    assert_eq!(fixture.legacy.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalid_or_locked_ios_legacy_is_not_missing_and_never_falls_back_to_json() {
    for failure in [
        IdentityFailure::Invalid,
        IdentityFailure::Locked,
        IdentityFailure::Unavailable,
    ] {
        let fixture = Fixture::new();
        fixture.put_legacy(LegacySource::Json, &BridgeClientIdentity::create());
        if failure == IdentityFailure::Invalid {
            fixture
                .legacy
                .values
                .lock()
                .unwrap()
                .insert(LegacySource::IosKeychain, b"invalid".to_vec());
        } else {
            *fixture.legacy.keychain_fault.lock().unwrap() = Some(failure);
        }
        assert_eq!(
            fixture.repository.acquire(true).await.unwrap_err().code(),
            failure.app_error().code()
        );
        assert_eq!(fixture.legacy.json_reads.load(Ordering::SeqCst), 0);
        assert!(fixture.backend.writes.lock().unwrap().is_empty());
    }
    let fixture = Fixture::new();
    assert_eq!(
        fixture.repository.acquire(false).await.unwrap_err().code(),
        "bridge_identity_missing"
    );
    assert!(fixture.backend.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_and_unknown_writes_retry_identical_candidate_without_deleting_legacy() {
    for unknown in [false, true] {
        let fixture = Fixture::new();
        let identity = BridgeClientIdentity::create();
        let raw = fixture.put_legacy(LegacySource::Json, &identity);
        *fixture.backend.write_fault.lock().unwrap() = Some(CredentialError::Unavailable);
        fixture
            .backend
            .unknown_write
            .store(unknown, Ordering::SeqCst);
        assert_eq!(
            fixture.repository.acquire(true).await.unwrap_err().code(),
            "bridge_identity_unavailable"
        );
        assert_eq!(
            fixture
                .legacy
                .values
                .lock()
                .unwrap()
                .get(&LegacySource::Json),
            Some(&raw)
        );
        *fixture.backend.write_fault.lock().unwrap() = None;
        assert_eq!(fixture.repository.acquire(true).await.unwrap(), identity);
        let writes = fixture.backend.writes.lock().unwrap();
        assert_eq!(writes[0], writes[1]);
    }
}

#[tokio::test]
async fn unknown_native_commit_survives_restart_without_replacing_signer() {
    let fixture = Fixture::new();
    *fixture.backend.write_fault.lock().unwrap() = Some(CredentialError::Unavailable);
    fixture.backend.unknown_write.store(true, Ordering::SeqCst);
    assert!(fixture.repository.acquire(true).await.is_err());
    let committed = fixture.native_identity();
    *fixture.backend.write_fault.lock().unwrap() = None;
    assert_eq!(fixture.restart().acquire(false).await.unwrap(), committed);
    assert_eq!(fixture.backend.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn verification_failure_and_cleanup_failure_keep_sources_and_never_rotate() {
    let fixture = Fixture::new();
    let identity = BridgeClientIdentity::create();
    let raw = fixture.put_legacy(LegacySource::Json, &identity);
    let backend = fixture.backend.clone();
    *fixture.backend.after_write.lock().unwrap() = Some(Box::new(move || {
        *backend.read_fault.lock().unwrap() = Some(CredentialError::Locked);
    }));
    assert_eq!(
        fixture.repository.acquire(false).await.unwrap_err().code(),
        "bridge_identity_locked"
    );
    assert_eq!(
        fixture
            .legacy
            .values
            .lock()
            .unwrap()
            .get(&LegacySource::Json),
        Some(&raw)
    );
    *fixture.backend.read_fault.lock().unwrap() = None;
    fixture.legacy.remove_fails.store(true, Ordering::SeqCst);
    assert_eq!(
        fixture.repository.acquire(false).await.unwrap_err().code(),
        "bridge_identity_cleanup_pending"
    );
    assert_eq!(fixture.native_identity(), identity);
    fixture.legacy.remove_fails.store(false, Ordering::SeqCst);
    let before = fixture.backend.writes.lock().unwrap().len();
    assert_eq!(fixture.repository.acquire(false).await.unwrap(), identity);
    assert_eq!(fixture.backend.writes.lock().unwrap().len(), before);
}

#[tokio::test]
async fn changed_source_is_retained_after_verified_commit_and_never_overrides_native() {
    let fixture = Fixture::new();
    let first = BridgeClientIdentity::create();
    let second = BridgeClientIdentity::create();
    fixture.put_legacy(LegacySource::Json, &first);
    let changed = serde_json::to_vec(&second).unwrap();
    *fixture.legacy.replacement_on_remove.lock().unwrap() = Some(changed.clone());
    assert_eq!(
        fixture.repository.acquire(false).await.unwrap_err().code(),
        "bridge_identity_cleanup_pending"
    );
    assert_eq!(fixture.native_identity(), first);
    assert_eq!(
        fixture
            .legacy
            .values
            .lock()
            .unwrap()
            .get(&LegacySource::Json),
        Some(&changed)
    );
    assert_eq!(fixture.restart().acquire(false).await.unwrap(), first);
}

#[tokio::test]
async fn actual_json_cleanup_compares_bytes_inside_shared_file_lane() {
    let fixture = Fixture::new();
    let first = serde_json::to_vec(&BridgeClientIdentity::create()).unwrap();
    let changed = serde_json::to_vec(&BridgeClientIdentity::create()).unwrap();
    let files = LegacyFiles {
        dir: fixture.dir.clone(),
    };
    fs::write(fixture.dir.join(CLIENT_IDENTITY_FILE), &first).unwrap();
    let accepted = files.read(LegacySource::Json).unwrap().unwrap();
    with_file_mutation(|| {
        fs::write(fixture.dir.join(CLIENT_IDENTITY_FILE), &changed)?;
        Ok(())
    })
    .unwrap();
    assert!(!files
        .remove_matching(LegacySource::Json, &accepted)
        .unwrap());
    assert_eq!(
        fs::read(fixture.dir.join(CLIENT_IDENTITY_FILE)).unwrap(),
        changed
    );
}

#[tokio::test]
async fn reset_tombstone_blocks_resurrection_through_partial_cleanup_and_restart() {
    let fixture = Fixture::new();
    let old = BridgeClientIdentity::create();
    fixture.seed_native(&old);
    fixture.put_legacy(LegacySource::IosKeychain, &old);
    fixture.put_legacy(LegacySource::Json, &old);
    fixture.repository.begin_reset().await.unwrap();
    fixture.legacy.remove_fails.store(true, Ordering::SeqCst);
    assert_eq!(
        fixture
            .repository
            .finish_reset(&fixture.profiles())
            .await
            .unwrap_err()
            .code(),
        "bridge_identity_cleanup_pending"
    );
    let restart = fixture.restart();
    for create in [false, true] {
        assert_eq!(
            restart.acquire(create).await.unwrap_err().code(),
            "bridge_identity_cleanup_pending"
        );
    }
    fixture.legacy.remove_fails.store(false, Ordering::SeqCst);
    restart.begin_reset().await.unwrap();
    restart.finish_reset(&fixture.profiles()).await.unwrap();
    assert_eq!(
        restart.acquire(false).await.unwrap_err().code(),
        "bridge_identity_missing"
    );
    let new = restart.acquire(true).await.unwrap();
    assert_ne!(new.device_id, old.device_id);
    assert!(fixture.legacy.values.lock().unwrap().is_empty());
}

#[tokio::test]
async fn explicit_reset_overwrites_invalid_native_only_after_verified_tombstone_and_blocks_stale_sources(
) {
    let fixture = Fixture::new();
    fixture
        .backend
        .values
        .lock()
        .unwrap()
        .insert(CLIENT_RECORD_KEY.into(), "bad-json".into());
    *fixture.backend.write_fault.lock().unwrap() = Some(CredentialError::Unavailable);
    fixture.backend.unknown_write.store(true, Ordering::SeqCst);
    assert_eq!(
        fixture.repository.begin_reset().await.unwrap_err().code(),
        "bridge_identity_unavailable"
    );
    *fixture.backend.write_fault.lock().unwrap() = None;
    fixture.repository.begin_reset().await.unwrap();
    fixture
        .repository
        .finish_reset(&fixture.profiles())
        .await
        .unwrap();
    {
        let writes = fixture.backend.writes.lock().unwrap();
        assert_eq!(writes[0], writes[1]);
    }
    fixture.put_legacy(LegacySource::Json, &BridgeClientIdentity::create());
    assert_eq!(
        fixture.restart().acquire(true).await.unwrap_err().code(),
        "bridge_identity_cleanup_pending"
    );
    assert_eq!(
        fixture.restart().acquire(false).await.unwrap_err().code(),
        "bridge_identity_missing"
    );
}
