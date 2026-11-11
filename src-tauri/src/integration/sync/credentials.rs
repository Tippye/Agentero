//! Host-owned sync secrets. Public configuration holds an opaque generation only.
use super::{
    config::{self, SyncBackendConfig, SyncBackendKind},
    engine,
};
use crate::{
    core::error::AppError,
    integration::credentials::{CredentialError, CredentialStore},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use tauri::{AppHandle, Manager};

static MUTATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

trait ConfigStorage: Send + Sync {
    fn get(&self, vault: &str) -> Result<Option<SyncBackendConfig>, AppError>;
    fn set(&self, vault: &str, config: SyncBackendConfig) -> Result<(), AppError>;
    fn remove(&self, vault: &str) -> Result<(), AppError>;
}
struct CoreConfig;
impl ConfigStorage for CoreConfig {
    fn get(&self, vault: &str) -> Result<Option<SyncBackendConfig>, AppError> {
        config::try_get(vault)
    }
    fn set(&self, vault: &str, value: SyncBackendConfig) -> Result<(), AppError> {
        config::set(vault, value)
    }
    fn remove(&self, vault: &str) -> Result<(), AppError> {
        config::remove(vault)
    }
}
#[derive(Default)]
pub struct SyncCredentialService(
    Arc<std::sync::Mutex<std::collections::HashMap<String, SecretVersions>>>,
);
struct Repository {
    store: Option<CredentialStore>,
    metadata: Arc<dyn ConfigStorage>,
    recovery: Arc<std::sync::Mutex<std::collections::HashMap<String, SecretVersions>>>,
}

// Neither Debug nor specta::Type. These values must never become IPC responses.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretVersions {
    version: u32,
    vault_digest: String,
    generations: Vec<SecretGeneration>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretGeneration {
    id: String,
    target_digest: String,
    secret_key: String,
    webdav_password: String,
}

fn digest(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}
fn vault_digest(vault: &str) -> String {
    digest(vault.as_bytes())
}
fn record_key(vault: &str) -> String {
    format!("sync.credentials.v1.{}", vault_digest(vault))
}
fn invalid() -> AppError {
    AppError::domain(
        "sync_credentials_invalid",
        "Saved sync credentials are invalid or do not belong to this connection",
    )
}
fn missing() -> AppError {
    AppError::domain(
        "sync_credentials_missing",
        "Saved sync credentials are missing; enter the connection password again",
    )
}
fn storage_error(error: CredentialError) -> AppError {
    match error {
        CredentialError::Locked => AppError::domain(
            "sync_credentials_locked",
            "Unlock the system credential store and try again",
        ),
        CredentialError::Unavailable => AppError::domain(
            "sync_credentials_unavailable",
            "The system credential store is unavailable",
        ),
        _ => invalid(),
    }
}
fn supported(config: &SyncBackendConfig) -> Result<(), AppError> {
    if !matches!(
        config.backend,
        SyncBackendKind::S3 | SyncBackendKind::Webdav
    ) {
        return Err(AppError::domain(
            "sync_backend_unavailable_mobile",
            "Tablet sync supports S3 and WebDAV connections",
        ));
    }
    Ok(())
}
fn target_digest(config: &SyncBackendConfig) -> Result<String, AppError> {
    let normalized = config.clone().normalized();
    // Serialize structured fields: delimiter-based identities can collide when
    // a bucket, prefix or username itself contains the delimiter.
    let target = match normalized.backend {
        SyncBackendKind::S3 => serde_json::json!([
            "s3",
            normalized.endpoint,
            normalized.region,
            normalized.bucket,
            normalized.prefix,
            normalized.access_key,
            normalized.force_path_style
        ]),
        SyncBackendKind::Webdav => {
            serde_json::json!(["webdav", normalized.webdav_url, normalized.webdav_username])
        }
        _ => return Err(invalid()),
    };
    Ok(digest(&serde_json::to_vec(&target)?))
}
fn masked(value: &str) -> bool {
    !value.trim().is_empty() && value.trim().chars().all(|c| c == '*')
}
fn public_config(config: &SyncBackendConfig) -> SyncBackendConfig {
    let mut public = config.clone();
    public.secret_key.clear();
    public.webdav_password.clear();
    public.agentero_token.clear();
    public
}
impl SecretVersions {
    fn empty(vault: &str) -> Self {
        Self {
            version: 1,
            vault_digest: vault_digest(vault),
            generations: Vec::new(),
        }
    }
    fn validate(&self, vault: &str) -> Result<(), AppError> {
        if self.version != 1
            || self.vault_digest != vault_digest(vault)
            || self.generations.len() > 2
        {
            return Err(invalid());
        }
        for item in &self.generations {
            if uuid::Uuid::parse_str(&item.id).is_err()
                || item.target_digest.len() != 64
                || !item.target_digest.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err(invalid());
            }
        }
        if self.generations.len() == 2 && self.generations[0].id == self.generations[1].id {
            return Err(invalid());
        }
        Ok(())
    }
    fn resolve(&self, config: &SyncBackendConfig) -> Result<SyncBackendConfig, AppError> {
        let reference = config.credential_ref.as_ref().ok_or_else(missing)?;
        let generation = self
            .generations
            .iter()
            .find(|item| &item.id == reference)
            .ok_or_else(missing)?;
        if generation.target_digest != target_digest(config)? {
            return Err(invalid());
        }
        let mut resolved = config.clone();
        resolved.secret_key = generation.secret_key.clone();
        resolved.webdav_password = generation.webdav_password.clone();
        resolved.validate()?;
        Ok(resolved)
    }
}
impl Repository {
    fn app(app: &AppHandle) -> Self {
        Self {
            store: app.state::<Option<CredentialStore>>().inner().clone(),
            metadata: Arc::new(CoreConfig),
            recovery: app.state::<SyncCredentialService>().inner().0.clone(),
        }
    }
    async fn versions(&self, vault: &str) -> Result<SecretVersions, AppError> {
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| storage_error(CredentialError::Unavailable))?;
        let pending = self
            .recovery
            .lock()
            .map_err(|_| invalid())?
            .get(vault)
            .cloned();
        if let Some(pending) = pending {
            // Retry only the exact known native write. Canonical metadata still
            // selects the old generation; this never activates a failed edit.
            store
                .write(&record_key(vault), &pending)
                .await
                .map_err(storage_error)?;
            self.recovery.lock().map_err(|_| invalid())?.remove(vault);
        }
        let versions = store
            .read::<SecretVersions>(&record_key(vault))
            .await
            .map_err(storage_error)?
            .unwrap_or_else(|| SecretVersions::empty(vault));
        versions.validate(vault)?;
        Ok(versions)
    }
    async fn load(&self, vault: &str) -> Result<Option<SyncBackendConfig>, AppError> {
        let Some(config) = self.metadata.get(vault)? else {
            return Ok(None);
        };
        if self.store.is_none() {
            if config.credential_ref.is_some() {
                return Err(storage_error(CredentialError::Unavailable));
            }
            return Ok(Some(config));
        }
        supported(&config)?;
        if config.credential_ref.is_some() {
            let resolved = self.versions(vault).await?.resolve(&config)?;
            return Ok(Some(resolved));
        }
        // A legacy plaintext file is retired only after a protected generation
        // has been acknowledged. Storage failure retains the original file.
        config.validate()?;
        self.save(vault, config).await.map(Some)
    }
    async fn save(
        &self,
        vault: &str,
        mut config: SyncBackendConfig,
    ) -> Result<SyncBackendConfig, AppError> {
        let Some(store) = self.store.as_ref() else {
            config.credential_ref = None;
            self.metadata.set(vault, config.clone())?;
            return Ok(config);
        };
        supported(&config)?;
        config.validate()?;
        let prior = self.metadata.get(vault)?;
        let mut versions = self.versions(vault).await?;
        // Keep only the generation still referenced by canonical metadata and
        // the proposed replacement. A failed metadata write can safely leave
        // either reference on disk; neither points to a discarded password.
        let previous = prior.as_ref().and_then(|cfg| cfg.credential_ref.as_ref());
        if let Some(prior) = prior.as_ref().filter(|cfg| cfg.credential_ref.is_some()) {
            // A prior rename may be visible after its directory fsync failed.
            // Confirm that reference durably before retiring any older slot.
            // Failure preserves both possible generations without native IO.
            self.metadata.set(vault, public_config(prior))?;
        }
        versions
            .generations
            .retain(|item| Some(&item.id) == previous);
        let id = uuid::Uuid::new_v4().to_string();
        versions.generations.push(SecretGeneration {
            id: id.clone(),
            target_digest: target_digest(&config)?,
            secret_key: config.secret_key.clone(),
            webdav_password: config.webdav_password.clone(),
        });
        if let Err(error) = store.write(&record_key(vault), &versions).await {
            if matches!(
                error,
                CredentialError::Locked | CredentialError::Unavailable
            ) {
                self.recovery
                    .lock()
                    .map_err(|_| invalid())?
                    .insert(vault.into(), versions);
            }
            return Err(storage_error(error));
        }
        config.credential_ref = Some(id);
        self.metadata.set(vault, public_config(&config))?;
        Ok(config)
    }
    async fn clear(&self, vault: &str) -> Result<(), AppError> {
        if let Some(store) = &self.store {
            store
                .remove(&record_key(vault))
                .await
                .map_err(storage_error)?;
        } else if self
            .metadata
            .get(vault)?
            .is_some_and(|cfg| cfg.credential_ref.is_some())
        {
            return Err(storage_error(CredentialError::Unavailable));
        }
        self.recovery.lock().map_err(|_| invalid())?.remove(vault);
        self.metadata.remove(vault)
    }
}

pub async fn load(app: &AppHandle, vault: &str) -> Result<Option<SyncBackendConfig>, AppError> {
    let _guard = MUTATIONS.lock().await;
    Repository::app(app).load(vault).await
}

#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncCredentialState {
    NotConfigured,
    Inline,
    Ready,
    Locked,
    Unavailable,
    Missing,
    Invalid,
}
pub struct CredentialStatus {
    pub config: Option<SyncBackendConfig>,
    pub state: SyncCredentialState,
}
fn masked_status_config(config: &SyncBackendConfig) -> SyncBackendConfig {
    let mut public = config.masked();
    if config.credential_ref.is_some() {
        match config.backend {
            SyncBackendKind::S3 => public.secret_key = "********".into(),
            SyncBackendKind::Webdav => public.webdav_password = "********".into(),
            _ => {}
        }
    }
    for field in [
        &mut public.endpoint,
        &mut public.webdav_url,
        &mut public.agentero_api,
        &mut public.git_remote,
    ] {
        if let Ok(mut url) = url::Url::parse(field) {
            if !url.username().is_empty() || url.password().is_some() {
                let _ = url.set_password(None);
                let _ = url.set_username("");
                *field = url.to_string();
            }
        }
    }
    public
}
pub async fn status(app: &AppHandle, vault: &str) -> Result<CredentialStatus, AppError> {
    let _guard = MUTATIONS.lock().await;
    let repository = Repository::app(app);
    let Some(public) = repository.metadata.get(vault)? else {
        return Ok(CredentialStatus {
            config: None,
            state: SyncCredentialState::NotConfigured,
        });
    };
    match repository.load(vault).await {
        Ok(Some(config)) => Ok(CredentialStatus {
            config: Some(config.masked()),
            state: if repository.store.is_some() {
                SyncCredentialState::Ready
            } else {
                SyncCredentialState::Inline
            },
        }),
        Ok(None) => Ok(CredentialStatus {
            config: None,
            state: SyncCredentialState::NotConfigured,
        }),
        Err(error) => {
            let state = match error.code() {
                "sync_credentials_locked" => SyncCredentialState::Locked,
                "sync_credentials_unavailable" => SyncCredentialState::Unavailable,
                "sync_credentials_missing" => SyncCredentialState::Missing,
                _ => SyncCredentialState::Invalid,
            };
            Ok(CredentialStatus {
                config: Some(masked_status_config(&public)),
                state,
            })
        }
    }
}

fn supplied_password(config: &SyncBackendConfig) -> bool {
    let value = match config.backend {
        SyncBackendKind::S3 => &config.secret_key,
        SyncBackendKind::Webdav => &config.webdav_password,
        _ => return false,
    };
    !value.trim().is_empty() && !masked(value)
}
fn uses_mask(config: &SyncBackendConfig) -> bool {
    match config.backend {
        SyncBackendKind::S3 => masked(&config.secret_key),
        SyncBackendKind::Webdav => masked(&config.webdav_password),
        _ => false,
    }
}

pub struct Configured {
    pub config: SyncBackendConfig,
}
/// Caller owns the vault's sync lease and cross-process SyncLock.
pub async fn configure(
    app: &AppHandle,
    vault: &str,
    dir: &Path,
    mut candidate: SyncBackendConfig,
) -> Result<Configured, AppError> {
    let _guard = MUTATIONS.lock().await;
    let repository = Repository::app(app);
    if repository.store.is_some() {
        supported(&candidate)?;
    }
    let previous_public = repository.metadata.get(vault)?;
    let previous = match repository.load(vault).await {
        Ok(previous) => previous,
        Err(error)
            if repository.store.is_some()
                && supplied_password(&candidate)
                && !matches!(
                    error.code(),
                    "sync_credentials_locked" | "sync_credentials_unavailable"
                ) =>
        {
            // Restore of public metadata without device-only secrets is recoverable
            // only with newly supplied credentials and a readable, valid vault.
            repository.versions(vault).await?;
            None
        }
        Err(error) => return Err(error),
    };
    if repository.store.is_some() && uses_mask(&candidate) {
        if let Some(previous) = &previous {
            if target_digest(previous)? != target_digest(&candidate)? {
                return Err(AppError::domain(
                    "sync_credentials_target_changed",
                    "Enter the password again when changing the sync destination or account",
                ));
            }
        }
    }
    candidate.credential_ref = None;
    candidate.merge_mask(previous.as_ref());
    candidate = candidate.normalized();
    candidate.validate()?;
    candidate.conditional_writes = engine::test_connection(dir, &candidate).await?;
    if let Some(previous) = previous_public.as_ref() {
        // For legacy bases, bind their old owner before the new configuration
        // can become visible. The engine resets a mismatch before any sync IO.
        super::local::bind_configured_store(dir, previous)?;
    }
    let config = repository.save(vault, candidate).await?;
    Ok(Configured { config })
}

pub async fn clear(app: &AppHandle, vault: &str) -> Result<(), AppError> {
    let _guard = MUTATIONS.lock().await;
    Repository::app(app).clear(vault).await
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
