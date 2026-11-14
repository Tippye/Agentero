//! Device-private receipts for paid asynchronous extraction. Unknown submissions
//! survive failures and restarts; only an existing receipt may resume HTTP work.
use crate::core::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    key: String,
    stage: String,
    receipt: Value,
    result_sha256: Option<String>,
}

// Explicit unlock is required: closing our descriptor alone can leave a flock
// held by a duplicated descriptor (including one inherited during process spawn).
// Release it before publishing the in-process lane to the next waiter.
struct AdvisoryLock(std::fs::File);

impl Drop for AdvisoryLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub(super) struct Journal {
    dir: PathBuf,
    record: Record,
    _file_lock: AdvisoryLock,
    _guard: OwnedMutexGuard<()>,
}

fn failure(message: impl std::fmt::Display) -> AppError {
    AppError::message(format!("Hosted extraction recovery: {message}"))
}

pub(super) fn redact_error(error: AppError, auth: &str) -> AppError {
    let code = error.code();
    let mut message = error.to_string();
    let token = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .unwrap_or(auth);
    if !token.is_empty() {
        message = message.replace(token, "[credential]");
    }
    // Remote errors can echo signed result/upload URLs in JSON or HTML bodies.
    let message = message
        .split_whitespace()
        .map(|word| {
            if word.contains("http://") || word.contains("https://") {
                "[private URL]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    AppError::domain(code, message)
}

pub(super) fn normalized_endpoint(endpoint: &str) -> Result<String, AppError> {
    let url = reqwest::Url::parse(endpoint).map_err(failure)?;
    Ok(url.as_str().trim_end_matches('/').to_string())
}

pub(super) fn identity(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    hex::encode(hash.finalize())
}

fn private_dir(path: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(path).map_err(failure)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(failure)?;
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| failure("invalid private path"))?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(failure)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(failure)?;
    }
    file.write_all(bytes).map_err(failure)?;
    file.as_file().sync_all().map_err(failure)?;
    file.persist(path).map_err(failure)?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(failure)?;
    Ok(())
}

impl Journal {
    pub async fn open(key: String) -> Result<Self, AppError> {
        Self::open_in(
            crate::core::paths::agentero_data_dir().join("hosted-extractions"),
            key,
        )
        .await
    }

    pub(super) async fn open_in(root: PathBuf, key: String) -> Result<Self, AppError> {
        if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(failure("invalid extraction identity"));
        }
        static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> = OnceLock::new();
        let dir = root.join(&key);
        let lock = LOCKS
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(dir.clone())
            .or_default()
            .clone();
        let guard = lock.lock_owned().await;
        private_dir(&root)?;
        private_dir(&dir)?;
        let mut lock_options = std::fs::OpenOptions::new();
        lock_options
            .read(true)
            .write(true)
            .create(true)
            .truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            lock_options.mode(0o600);
        }
        let file_lock = lock_options.open(dir.join("lock")).map_err(failure)?;
        file_lock
            .try_lock()
            .map_err(|_| failure("extraction is owned by another process"))?;
        let file_lock = AdvisoryLock(file_lock);
        let marker_path = root.join(format!("{key}.managed"));
        let managed = match std::fs::read(&marker_path) {
            Ok(bytes) if bytes == b"hosted-extraction-v1" => true,
            Ok(_) => return Err(failure("invalid managed receipt marker")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(failure(error)),
        };
        let record_path = dir.join("receipt.json");
        let record = match std::fs::read(&record_path) {
            Ok(bytes) => {
                let record: Record = serde_json::from_slice(&bytes)
                    .map_err(|_| failure("unreadable receipt; refusing a new submission"))?;
                if record.version != 1 || record.key != key {
                    return Err(failure(
                        "receipt identity/version mismatch; refusing a new submission",
                    ));
                }
                record
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !managed => Record {
                version: 1,
                key,
                stage: "prepared".into(),
                receipt: Value::Null,
                result_sha256: None,
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(failure(
                    "managed receipt is missing; refusing a new submission",
                ));
            }
            Err(error) => return Err(failure(error)),
        };
        if !managed {
            atomic_write(&record_path, &serde_json::to_vec(&record).map_err(failure)?)?;
            atomic_write(&marker_path, b"hosted-extraction-v1")?;
            // Persist creation of the private journal root before any dispatch.
            #[cfg(unix)]
            if let Some(parent) = root.parent() {
                std::fs::File::open(parent)
                    .and_then(|file| file.sync_all())
                    .map_err(failure)?;
            }
        }
        Ok(Self {
            dir,
            record,
            _guard: guard,
            _file_lock: file_lock,
        })
    }

    pub fn stage(&self) -> &str {
        &self.record.stage
    }
    pub fn receipt(&self) -> &Value {
        &self.record.receipt
    }

    pub fn save(&mut self, stage: &str, receipt: Value) -> Result<(), AppError> {
        // Publish in memory only after the durable write succeeds.
        let next = Record {
            version: 1,
            key: self.record.key.clone(),
            stage: stage.into(),
            receipt,
            result_sha256: self.record.result_sha256.clone(),
        };
        atomic_write(
            &self.dir.join("receipt.json"),
            &serde_json::to_vec(&next).map_err(failure)?,
        )?;
        self.record = next;
        Ok(())
    }

    pub fn begin(&mut self, known_stage: &str, unknown_stage: &str) -> Result<bool, AppError> {
        if self.stage() == unknown_stage {
            return Err(failure(
                "submission outcome unknown; automatic resubmission is disabled",
            ));
        }
        if self.stage() == known_stage {
            self.save(unknown_stage, self.receipt().clone())?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn cached(&self) -> Result<Option<Vec<u8>>, AppError> {
        let Some(expected) = &self.record.result_sha256 else {
            return Ok(None);
        };
        let bytes = std::fs::read(self.dir.join("result.bin")).map_err(failure)?;
        if identity(&[&bytes]) != *expected {
            return Err(failure(
                "completed result is corrupt; refusing a new submission",
            ));
        }
        Ok(Some(bytes))
    }

    pub fn complete(&mut self, bytes: &[u8]) -> Result<(), AppError> {
        atomic_write(&self.dir.join("result.bin"), bytes)?;
        let next = Record {
            version: 1,
            key: self.record.key.clone(),
            stage: "completed".into(),
            receipt: self.record.receipt.clone(),
            result_sha256: Some(identity(&[bytes])),
        };
        atomic_write(
            &self.dir.join("receipt.json"),
            &serde_json::to_vec(&next).map_err(failure)?,
        )?;
        self.record = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropping_owner_unlocks_even_when_another_descriptor_remains_open() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(&[b"duplicated-descriptor"]);
        let mut first = Journal::open_in(root.path().into(), key.clone())
            .await
            .unwrap();
        first.begin("prepared", "submitting").unwrap();
        let inherited_descriptor = first._file_lock.0.try_clone().unwrap();
        drop(first);
        let mut restored = Journal::open_in(root.path().into(), key).await.unwrap();
        assert!(restored.begin("prepared", "submitting").is_err());
        // The old descriptor is deliberately still alive during reacquisition.
        drop(inherited_descriptor);
    }

    #[tokio::test]
    async fn restart_preserves_unknown_and_known_receipts_and_raw_results() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(&[b"pdf", b"provider", b"account"]);
        let mut first = Journal::open_in(root.path().into(), key.clone())
            .await
            .unwrap();
        assert!(first.begin("prepared", "submitting").unwrap());
        drop(first);
        let mut restored = Journal::open_in(root.path().into(), key.clone())
            .await
            .unwrap();
        assert!(restored.begin("prepared", "submitting").is_err());
        restored
            .save("submitted", serde_json::json!({"id":"paid-job"}))
            .unwrap();
        drop(restored);
        let mut restored = Journal::open_in(root.path().into(), key.clone())
            .await
            .unwrap();
        assert!(!restored.begin("prepared", "submitting").unwrap());
        assert_eq!(restored.receipt()["id"], "paid-job");
        restored.complete(b"raw output").unwrap();
        drop(restored);
        let restored = Journal::open_in(root.path().into(), key.clone())
            .await
            .unwrap();
        assert_eq!(restored.cached().unwrap().unwrap(), b"raw output");
        std::fs::write(root.path().join(&key).join("result.bin"), b"corrupt").unwrap();
        assert!(restored.cached().is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.path().join(key).join("receipt.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn missing_or_corrupt_managed_receipt_cannot_become_a_fresh_submission() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(&[b"managed"]);
        let mut journal = Journal::open_in(root.path().into(), key.clone())
            .await
            .unwrap();
        journal.begin("prepared", "submitting").unwrap();
        drop(journal);
        let receipt = root.path().join(&key).join("receipt.json");
        std::fs::write(&receipt, b"corrupt").unwrap();
        assert!(Journal::open_in(root.path().into(), key.clone())
            .await
            .is_err());
        std::fs::remove_file(receipt).unwrap();
        assert!(Journal::open_in(root.path().into(), key).await.is_err());
    }

    #[test]
    fn errors_hide_provider_tokens_and_private_links() {
        let error = AppError::domain(
            "fixture",
            "upload failed https://private/upload?signature=signed-value api-key",
        );
        let error = redact_error(error, "Bearer api-key");
        assert_eq!(error.code(), "fixture");
        assert!(!error.to_string().contains("signed-value"));
        assert!(!error.to_string().contains("api-key"));
        assert_eq!(
            normalized_endpoint("https://EXAMPLE.com:443/api/").unwrap(),
            "https://example.com/api"
        );
    }

    #[test]
    fn identity_separates_accounts_options_and_ambiguous_concatenation() {
        assert_ne!(identity(&[b"ab", b"c"]), identity(&[b"a", b"bc"]));
        assert_ne!(
            identity(&[b"pdf", b"account-a"]),
            identity(&[b"pdf", b"account-b"])
        );
        assert_ne!(identity(&[b"pdf", b"ocr"]), identity(&[b"pdf", b"auto"]));
    }
}
