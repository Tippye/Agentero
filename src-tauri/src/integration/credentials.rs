//! Rust-only system credentials. No generic secret read/write command is exposed to JavaScript.
use serde::{de::DeserializeOwned, Serialize};
use std::sync::Arc;

const MAX_RECORD_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    #[error("The system credential store is locked")]
    Locked,
    #[error("The system credential store is unavailable")]
    Unavailable,
    #[error("The saved credential record is invalid")]
    InvalidRecord,
    #[error("The credential record key is invalid")]
    InvalidKey,
}

pub(crate) trait CredentialBackend: Send + Sync {
    fn read(&self, key: &str) -> Result<Option<String>, CredentialError>;
    fn write(&self, key: &str, value: &str) -> Result<(), CredentialError>;
    fn remove(&self, key: &str) -> Result<(), CredentialError>;
}

#[derive(Clone)]
pub struct CredentialStore(Arc<BackendState>);

struct BackendState {
    backend: Arc<dyn CredentialBackend>,
    // Android SharedPreferences changes its cache before commit reports failure.
    // Serialize complete operations and quarantine reads until a durable retry.
    mutation_failed: std::sync::Mutex<bool>,
}
impl BackendState {
    fn mutate(
        &self,
        operation: impl FnOnce(&dyn CredentialBackend) -> Result<(), CredentialError>,
    ) -> Result<(), CredentialError> {
        let mut failed = self
            .mutation_failed
            .lock()
            .map_err(|_| CredentialError::Unavailable)?;
        let result = operation(self.backend.as_ref());
        match result {
            Ok(()) => *failed = false,
            Err(CredentialError::Locked) => {}
            Err(_) => *failed = true,
        }
        result
    }
}

fn validate_key(key: &str) -> Result<(), CredentialError> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err(CredentialError::InvalidKey);
    }
    Ok(())
}

impl CredentialStore {
    #[cfg(any(test, target_os = "android", target_os = "ios"))]
    fn new(backend: Arc<dyn CredentialBackend>) -> Self {
        Self(Arc::new(BackendState {
            backend,
            mutation_failed: std::sync::Mutex::new(false),
        }))
    }

    /// Desktop keeps the existing launch-only mobile-preview behavior. Native
    /// tablet builds use system storage without adding a desktop D-Bus dependency.
    pub fn system(service: String) -> Option<Self> {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            Some(Self::new(Arc::new(SystemBackend { service })))
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let _ = service;
            None
        }
    }

    pub async fn read<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, CredentialError> {
        validate_key(key)?;
        let backend = Arc::clone(&self.0);
        let key = key.to_owned();
        let raw = tokio::task::spawn_blocking(move || {
            let failed = backend
                .mutation_failed
                .lock()
                .map_err(|_| CredentialError::Unavailable)?;
            if *failed {
                return Err(CredentialError::Unavailable);
            }
            backend.backend.read(&key)
        })
        .await
        .map_err(|_| CredentialError::Unavailable)??;
        raw.map(|raw| {
            if raw.len() > MAX_RECORD_BYTES {
                return Err(CredentialError::InvalidRecord);
            }
            serde_json::from_str(&raw).map_err(|_| CredentialError::InvalidRecord)
        })
        .transpose()
    }

    pub async fn write<T: Serialize>(&self, key: &str, value: &T) -> Result<(), CredentialError> {
        validate_key(key)?;
        let raw = serde_json::to_string(value).map_err(|_| CredentialError::InvalidRecord)?;
        if raw.len() > MAX_RECORD_BYTES {
            return Err(CredentialError::InvalidRecord);
        }
        let backend = Arc::clone(&self.0);
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || backend.mutate(|store| store.write(&key, &raw)))
            .await
            .map_err(|_| CredentialError::Unavailable)?
    }

    pub async fn remove(&self, key: &str) -> Result<(), CredentialError> {
        validate_key(key)?;
        let backend = Arc::clone(&self.0);
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || backend.mutate(|store| store.remove(&key)))
            .await
            .map_err(|_| CredentialError::Unavailable)?
    }

    #[cfg(test)]
    pub(crate) fn from_backend(backend: Arc<dyn CredentialBackend>) -> Self {
        Self::new(backend)
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
struct SystemBackend {
    service: String,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn native_error(error: tauri_plugin_keyring_store::Error) -> CredentialError {
    match error {
        tauri_plugin_keyring_store::Error::KeychainLocked => CredentialError::Locked,
        // Do not forward native error details: they may contain credential data.
        _ => CredentialError::Unavailable,
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
impl SystemBackend {
    fn store(&self) -> Result<tauri_plugin_keyring_store::KeyringStore, CredentialError> {
        let store = tauri_plugin_keyring_store::KeyringStore::new(self.service.clone());
        #[cfg(target_os = "ios")]
        let store = store.with_write_accessibility(
            tauri_plugin_keyring_store::WriteAccessibility::AfterFirstUnlockThisDeviceOnly,
        );
        #[cfg(target_os = "android")]
        let store = {
            let config = std::collections::HashMap::from([
                ("name", "agentero-mobile-v2"),
                ("filename", "keyring-agentero-mobile-v2"),
            ]);
            let native = android_native_keyring_store::Store::new_with_configuration(&config)
                .map_err(|_| CredentialError::Unavailable)?;
            store.with_store(native)
        };
        Ok(store)
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
impl CredentialBackend for SystemBackend {
    fn read(&self, key: &str) -> Result<Option<String>, CredentialError> {
        // Regular reads distinguish locked storage from a genuinely missing entry.
        self.store()?.get_password(key).map_err(native_error)
    }
    fn write(&self, key: &str, value: &str) -> Result<(), CredentialError> {
        self.store()?.set_password(key, value).map_err(native_error)
    }
    fn remove(&self, key: &str) -> Result<(), CredentialError> {
        self.store()?.delete(key).map_err(native_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct Memory {
        values: Mutex<HashMap<String, String>>,
        fault: Mutex<Option<CredentialError>>,
        mutate_before_failure: bool,
        remove_calls: std::sync::atomic::AtomicUsize,
    }
    impl CredentialBackend for Memory {
        fn read(&self, key: &str) -> Result<Option<String>, CredentialError> {
            if let Some(error) = *self.fault.lock().unwrap() {
                return Err(error);
            }
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        fn write(&self, key: &str, value: &str) -> Result<(), CredentialError> {
            if let Some(error) = *self.fault.lock().unwrap() {
                if self.mutate_before_failure && error == CredentialError::Unavailable {
                    self.values.lock().unwrap().insert(key.into(), value.into());
                }
                return Err(error);
            }
            self.values.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn remove(&self, key: &str) -> Result<(), CredentialError> {
            self.remove_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some(error) = *self.fault.lock().unwrap() {
                if self.mutate_before_failure && error == CredentialError::Unavailable {
                    self.values.lock().unwrap().remove(key);
                }
                return Err(error);
            }
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[tokio::test]
    async fn native_failures_remain_distinct_from_missing_and_preserve_old_record() {
        let backend = Arc::new(Memory::default());
        let store = CredentialStore::from_backend(backend.clone());
        assert_eq!(store.read::<Value>("account.v1").await.unwrap(), None);
        store
            .write("account.v1", &json!({"token":"old"}))
            .await
            .unwrap();
        *backend.fault.lock().unwrap() = Some(CredentialError::Locked);
        assert_eq!(
            store.read::<Value>("account.v1").await.unwrap_err(),
            CredentialError::Locked
        );
        assert!(store
            .write("account.v1", &json!({"token":"new"}))
            .await
            .is_err());
        assert!(store.remove("account.v1").await.is_err());
        *backend.fault.lock().unwrap() = None;
        assert_eq!(
            store.read::<Value>("account.v1").await.unwrap(),
            Some(json!({"token":"old"}))
        );
        store.remove("account.v1").await.unwrap();
        assert_eq!(store.read::<Value>("account.v1").await.unwrap(), None);
    }

    #[tokio::test]
    async fn failed_native_cache_mutations_require_successful_explicit_retry() {
        let backend = Arc::new(Memory {
            mutate_before_failure: true,
            ..Memory::default()
        });
        let store = CredentialStore::from_backend(backend.clone());
        store.write("account.v1", &json!("old")).await.unwrap();
        *backend.fault.lock().unwrap() = Some(CredentialError::Unavailable);
        assert!(store
            .write("account.v1", &json!("undurable"))
            .await
            .is_err());
        *backend.fault.lock().unwrap() = None;
        assert_eq!(
            store.read::<Value>("account.v1").await.unwrap_err(),
            CredentialError::Unavailable
        );
        *backend.fault.lock().unwrap() = Some(CredentialError::Locked);
        assert!(store.write("account.v1", &json!("locked")).await.is_err());
        *backend.fault.lock().unwrap() = None;
        assert_eq!(
            store.read::<Value>("account.v1").await.unwrap_err(),
            CredentialError::Unavailable
        );
        store.write("account.v1", &json!("durable")).await.unwrap();
        assert_eq!(
            store.read::<Value>("account.v1").await.unwrap(),
            Some(json!("durable"))
        );
        *backend.fault.lock().unwrap() = Some(CredentialError::Unavailable);
        assert!(store.remove("account.v1").await.is_err());
        assert!(!backend.values.lock().unwrap().contains_key("account.v1"));
        *backend.fault.lock().unwrap() = None;
        assert_eq!(
            store.read::<Value>("account.v1").await.unwrap_err(),
            CredentialError::Unavailable
        );
        store.remove("account.v1").await.unwrap();
        assert_eq!(
            backend
                .remove_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            2
        );
        assert_eq!(store.read::<Value>("account.v1").await.unwrap(), None);
    }

    #[tokio::test]
    async fn corrupt_records_are_not_treated_as_new_accounts() {
        let backend = Arc::new(Memory::default());
        backend
            .values
            .lock()
            .unwrap()
            .insert("account.v1".into(), "invalid-json".into());
        let store = CredentialStore::from_backend(backend);
        assert_eq!(
            store.read::<Value>("account.v1").await.unwrap_err(),
            CredentialError::InvalidRecord
        );
        assert_eq!(
            store.write("../account", &json!(null)).await.unwrap_err(),
            CredentialError::InvalidKey
        );
        assert_eq!(
            store
                .write("account.v1", &"x".repeat(MAX_RECORD_BYTES))
                .await
                .unwrap_err(),
            CredentialError::InvalidRecord
        );
    }
}
