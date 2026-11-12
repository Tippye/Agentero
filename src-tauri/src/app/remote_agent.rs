//! Application coordinator: typed provider operations and native DSH credentials.
pub(crate) mod background;
mod lifecycle;
mod stored_account;
use crate::{
    core::error::{map_err, ApiResult, AppError},
    features::remote_agent::*,
    integration::dsh_remote::{
        api::{ServerApi, TokenPair},
        crypto::DeviceIdentity,
        protocol::key,
        provider::{DshConnectionConfig, DshRemoteProvider},
        RemoteError,
    },
};
pub use lifecycle::{RemoteAgentAccounts, RemoteCredentialPersistence, RemoteCredentialState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::File, path::PathBuf, sync::Arc, time::Duration};
use tauri::{Manager, State};

// Deliberately neither Debug nor Serialize: credentials never enter IPC or logs.
struct LaunchAccount {
    api: ServerApi,
    identity: DeviceIdentity,
    credentials: TokenPair,
    refresh_pending: bool,
    pins: HashMap<String, String>,
    view: RemoteAgentAccount,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentAccount {
    pub account: String,
    pub server: String,
    pub expires_at: u64,
    pub info: ConnectionInfo,
    pub persistence: RemoteCredentialPersistence,
}
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentCatalog {
    pub providers: Vec<ProviderDescriptor>,
    pub default_provider: ProviderId,
    pub account: Option<RemoteAgentAccount>,
    pub persistence: RemoteCredentialPersistence,
    pub credential_state: RemoteCredentialState,
    pub can_clear_saved_sign_in: bool,
}
// No Debug, and never returned. Password exists only for the explicit login call.
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentLogin {
    pub server: String,
    pub email: String,
    pub password: String,
}
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentHostIdentity {
    pub host: HostRef,
    pub name: String,
    pub fingerprint: String,
    pub pinned: bool,
}
fn remote(error: RemoteError) -> AppError {
    // Integration errors contain protocol codes and fixed messages, never credentials.
    AppError::domain("dsh_remote", error.to_string())
}
fn envelope<T: Serialize>(result: Result<T, AppError>) -> Result<ApiResult<T>, String> {
    Ok(match result {
        Ok(value) => ApiResult::ok(value),
        Err(error) => map_err(error),
    })
}
fn missing() -> AppError {
    AppError::domain(
        "remote_agent_auth_required",
        "Sign in for this application launch",
    )
}
fn account_for<'a>(
    account: &'a mut Option<LaunchAccount>,
    connection: &ConnectionRef,
) -> Result<&'a mut LaunchAccount, AppError> {
    account
        .as_mut()
        .filter(|a| &a.view.info.connection == connection)
        .ok_or_else(missing)
}
fn fingerprint(public_key: &str) -> Result<String, AppError> {
    Ok(format!(
        "SHA256:{}",
        hex::encode(Sha256::digest(key(public_key).map_err(remote)?))
    ))
}
fn verified_identity(
    public_key: &str,
    pinned: Option<&String>,
    expected: Option<&str>,
) -> Result<String, AppError> {
    let digest = fingerprint(public_key)?;
    if pinned.is_some_and(|pin| pin != public_key)
        || expected.is_some_and(|expected| expected != digest)
    {
        return Err(AppError::domain(
            "remote_agent_identity_changed",
            "Host identity differs from its pin or confirmed fingerprint",
        ));
    }
    Ok(digest)
}
fn validate_upload_limits(
    capabilities: &Capabilities,
    size: u64,
    mime: &str,
) -> Result<(), AppError> {
    let limits = capabilities
        .attachments
        .as_ref()
        .filter(|_| capabilities.supports(Capability::UploadAttachment))
        .ok_or_else(|| {
            AppError::domain(
                "remote_agent_unsupported",
                "This Host does not support file uploads",
            )
        })?;
    if size > limits.max_bytes || limits.max_bytes == 0 {
        return Err(AppError::domain(
            "remote_agent_attachment_too_large",
            "Attachment exceeds the negotiated route limit",
        ));
    }
    if !limits.mime_types.is_empty() && !limits.mime_types.iter().any(|allowed| allowed == mime) {
        return Err(AppError::domain(
            "remote_agent_attachment_type",
            "Attachment MIME type is not supported",
        ));
    }
    Ok(())
}
fn configuration(account: &LaunchAccount) -> DshConnectionConfig {
    DshConnectionConfig {
        api: account.api.clone(),
        identity: account.identity.clone(),
        access_token: account.credentials.access_token.clone(),
        pinned_hosts: account.pins.clone(),
    }
}

fn refresh_due(expires_at: u64, now: u64) -> bool {
    expires_at <= now.saturating_add(60_000)
}
async fn preflight(
    connection: &ConnectionRef,
    accounts: &RemoteAgentAccounts,
    provider: &DshRemoteProvider,
) -> Result<(), AppError> {
    if connection.provider_id.0 != DEFAULT_PROVIDER_ID {
        return Ok(());
    }
    let mut current = accounts.current.lock().await;
    current
        .refresh(connection, provider, accounts.store.as_ref())
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_agent_catalog(
    service: State<'_, RemoteAgentService>,
    accounts: State<'_, RemoteAgentAccounts>,
    provider: State<'_, Arc<DshRemoteProvider>>,
) -> Result<ApiResult<RemoteAgentCatalog>, String> {
    accounts.ensure_restored(&service, &provider).await;
    envelope(
        async {
            let current = accounts.current.lock().await;
            Ok(RemoteAgentCatalog {
                providers: service.providers()?,
                default_provider: service.default_provider()?,
                account: current.account.as_ref().map(|a| a.view.clone()),
                persistence: accounts.persistence(),
                credential_state: current.credential_state,
                can_clear_saved_sign_in: accounts.store.is_some()
                    && current.credential_state != RemoteCredentialState::Missing,
            })
        }
        .await,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn remote_agent_login(
    request: RemoteAgentLogin,
    service: State<'_, RemoteAgentService>,
    provider: State<'_, Arc<DshRemoteProvider>>,
    accounts: State<'_, RemoteAgentAccounts>,
    monitors: State<'_, Arc<background::RemoteBackgroundMonitors>>,
) -> Result<ApiResult<RemoteAgentAccount>, String> {
    envelope(
        async {
            accounts.ensure_restored(&service, &provider).await;
            let mut current = accounts.current.lock().await;
            if !current.can_sign_in(accounts.persistence()) {
                return Err(AppError::domain(
                    "remote_agent_account_active",
                    "Clear the saved sign-in before changing accounts",
                ));
            }
            let api = ServerApi::new(&request.server, Duration::from_secs(20)).map_err(remote)?;
            let login = api
                .login(&request.email, &request.password)
                .await
                .map_err(remote)?;
            let identity =
                DeviceIdentity::generate(uuid::Uuid::new_v4().to_string()).map_err(remote)?;
            let credentials = api
                .register(
                    &identity,
                    "Agentero",
                    std::env::consts::OS,
                    env!("CARGO_PKG_VERSION"),
                    &login.token,
                )
                .await
                .map_err(remote)?;
            let connection = ConnectionRef {
                provider_id: DEFAULT_PROVIDER_ID.into(),
                connection_id: ConnectionId(uuid::Uuid::new_v4().to_string()),
            };
            let account = LaunchAccount {
                api,
                identity,
                credentials: credentials.clone(),
                refresh_pending: false,
                pins: HashMap::new(),
                view: RemoteAgentAccount {
                    account: login.account,
                    server: request.server,
                    expires_at: credentials.access_token_expires_at,
                    persistence: accounts.persistence(),
                    info: ConnectionInfo {
                        connection,
                        capabilities: Capabilities {
                            operations: vec![],
                            authentication: vec![],
                            backends: vec![],
                            attachments: None,
                        },
                    },
                },
            };
            let result = current
                .activate(account, accounts.store.as_ref(), &service, &provider)
                .await;
            if result.is_ok() {
                monitors.resume();
            }
            result
        }
        .await,
    )
}
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_logout(
    service: State<'_, RemoteAgentService>,
    provider: State<'_, Arc<DshRemoteProvider>>,
    accounts: State<'_, RemoteAgentAccounts>,
    monitors: State<'_, Arc<background::RemoteBackgroundMonitors>>,
) -> Result<ApiResult<()>, String> {
    monitors.suspend();
    envelope(
        async {
            let mut current = accounts.current.lock().await;
            if let Some(account) = &current.account {
                monitors.stop_connection(&account.view.info.connection);
            }
            current
                .clear(accounts.store.as_ref(), &service, &provider)
                .await
        }
        .await,
    )
}
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_hosts(
    connection: ConnectionRef,
    service: State<'_, RemoteAgentService>,
    provider: State<'_, Arc<DshRemoteProvider>>,
    accounts: State<'_, RemoteAgentAccounts>,
) -> Result<ApiResult<Vec<HostInfo>>, String> {
    if let Err(error) = preflight(&connection, &accounts, &provider).await {
        return Ok(map_err(error));
    }
    envelope(service.list_hosts(&connection).await)
}
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_host_identity(
    host: HostRef,
    accounts: State<'_, RemoteAgentAccounts>,
    provider: State<'_, Arc<DshRemoteProvider>>,
) -> Result<ApiResult<RemoteAgentHostIdentity>, String> {
    envelope(
        async {
            let mut current = accounts.current.lock().await;
            current
                .refresh(&host.connection, &provider, accounts.store.as_ref())
                .await?;
            let account = account_for(&mut current.account, &host.connection)?;
            let identity = account
                .api
                .host(&account.credentials.access_token, &host.host_id.0)
                .await
                .map_err(remote)?;
            let digest = verified_identity(
                &identity.identity_key,
                account.pins.get(&host.host_id.0),
                None,
            )?;
            Ok(RemoteAgentHostIdentity {
                fingerprint: digest,
                pinned: account.pins.contains_key(&host.host_id.0),
                name: identity.device.name,
                host,
            })
        }
        .await,
    )
}
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_trust_host(
    host: HostRef,
    expected_fingerprint: String,
    service: State<'_, RemoteAgentService>,
    provider: State<'_, Arc<DshRemoteProvider>>,
    accounts: State<'_, RemoteAgentAccounts>,
    monitors: State<'_, Arc<background::RemoteBackgroundMonitors>>,
) -> Result<ApiResult<ConnectionInfo>, String> {
    envelope(
        async {
            let mut current = accounts.current.lock().await;
            current
                .refresh(&host.connection, &provider, accounts.store.as_ref())
                .await?;
            let account = account_for(&mut current.account, &host.connection)?;
            let identity = account
                .api
                .host(&account.credentials.access_token, &host.host_id.0)
                .await
                .map_err(remote)?;
            verified_identity(
                &identity.identity_key,
                account.pins.get(&host.host_id.0),
                Some(&expected_fingerprint),
            )?;
            // A captured observer must not reconnect the previously selected Host.
            monitors.select_host(&host);
            current
                .pin(
                    &host.connection,
                    host.host_id.0.clone(),
                    identity.identity_key,
                    accounts.store.as_ref(),
                )
                .await?;
            let account = account_for(&mut current.account, &host.connection)?;
            service.disconnect(&host.connection).await?;
            provider
                .configure(
                    host.connection.connection_id.0.clone(),
                    configuration(account),
                )
                .await
                .map_err(remote)?;
            service
                .connect(&ConnectRequest {
                    connection: host.connection.clone(),
                    config_version: 1,
                })
                .await?;
            provider.select_host(&host).await.map_err(remote)?;
            let info = service.resume(&host.connection).await?;
            account.view.info = info.clone();
            Ok(info)
        }
        .await,
    )
}
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_workspaces(
    host: HostRef,
    service: State<'_, RemoteAgentService>,
    provider: State<'_, Arc<DshRemoteProvider>>,
    accounts: State<'_, RemoteAgentAccounts>,
) -> Result<ApiResult<Vec<WorkspaceInfo>>, String> {
    if let Err(error) = preflight(&host.connection, &accounts, &provider).await {
        return Ok(map_err(error));
    }
    envelope(service.list_workspaces(&host).await)
}
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_sessions(
    workspace: WorkspaceRef,
    service: State<'_, RemoteAgentService>,
    provider: State<'_, Arc<DshRemoteProvider>>,
    accounts: State<'_, RemoteAgentAccounts>,
) -> Result<ApiResult<Vec<SessionInfo>>, String> {
    if let Err(error) = preflight(&workspace.host.connection, &accounts, &provider).await {
        return Ok(map_err(error));
    }
    envelope(service.list_sessions(&workspace).await)
}
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_read_session(
    session: SessionRef,
    service: State<'_, RemoteAgentService>,
    provider: State<'_, Arc<DshRemoteProvider>>,
    accounts: State<'_, RemoteAgentAccounts>,
) -> Result<ApiResult<SessionSnapshot>, String> {
    if let Err(error) = preflight(&session.workspace.host.connection, &accounts, &provider).await {
        return Ok(map_err(error));
    }
    envelope(service.read_session(&session).await)
}
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_execute(
    request: OperationRequest,
    service: State<'_, RemoteAgentService>,
    provider: State<'_, Arc<DshRemoteProvider>>,
    accounts: State<'_, RemoteAgentAccounts>,
    background: State<'_, Arc<crate::features::mobile_background::MobileBackgroundService>>,
    monitors: State<'_, Arc<background::RemoteBackgroundMonitors>>,
) -> Result<ApiResult<OperationOutcome>, String> {
    if let Err(error) = preflight(
        &request.mutation.workspace().host.connection,
        &accounts,
        &provider,
    )
    .await
    {
        return Ok(map_err(error));
    }
    if matches!(request.mutation, Mutation::UploadAttachment { .. }) {
        return Ok(map_err(AppError::domain(
            "remote_agent_upload_grant",
            "Use the private-file upload command",
        )));
    }
    let ticket = if matches!(&request.mutation, Mutation::SendMessage { .. }) {
        match background.state().await {
            Ok(state) if state.persistent_connection && state.enabled => {
                match monitors.prepare(&request).await {
                    Ok(ticket) => ticket,
                    Err(error) => {
                        log::warn!(
                            "Native session observation was not admitted: {}",
                            error.code()
                        );
                        None
                    }
                }
            }
            _ => None,
        }
    } else {
        None
    };
    let result = service.execute(&request).await;
    if let Some(ticket) = ticket {
        if let Ok(outcome) = &result {
            ticket.finish(outcome);
        }
    }
    envelope(result)
}
/// Read this device's journal without refreshing credentials or contacting a Host.
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_local_operations(
    connection: ConnectionRef,
    service: State<'_, RemoteAgentService>,
) -> Result<ApiResult<Vec<JournalEntry>>, String> {
    envelope(service.local_operations(&connection).await)
}

#[tauri::command]
#[specta::specta]
pub async fn remote_agent_receipt(
    connection: ConnectionRef,
    operation_id: OperationId,
    service: State<'_, RemoteAgentService>,
    provider: State<'_, Arc<DshRemoteProvider>>,
    accounts: State<'_, RemoteAgentAccounts>,
) -> Result<ApiResult<ReceiptLookup>, String> {
    if let Err(error) = preflight(&connection, &accounts, &provider).await {
        return Ok(map_err(error));
    }
    envelope(service.lookup_receipt(&connection, &operation_id).await)
}
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_upload(
    app: tauri::AppHandle,
    session: SessionRef,
    path: String,
    operation_id: OperationId,
    service: State<'_, RemoteAgentService>,
    provider: State<'_, Arc<DshRemoteProvider>>,
    accounts: State<'_, RemoteAgentAccounts>,
) -> Result<ApiResult<OperationOutcome>, String> {
    envelope(
        async {
            if let Some(previous) = service
                .local_outcome(&session.workspace.host.connection, &operation_id)
                .await?
            {
                return Ok(previous);
            }
            preflight(&session.workspace.host.connection, &accounts, &provider).await?;
            let capabilities = {
                let mut current = accounts.current.lock().await;
                account_for(&mut current.account, &session.workspace.host.connection)?
                    .view
                    .info
                    .capabilities
                    .clone()
            };
            validate_upload_limits(&capabilities, 0, "application/octet-stream")?;
            let denied = || {
                AppError::domain(
                    "remote_agent_upload_grant",
                    "Choose a regular file in application-private storage",
                )
            };
            let selected = PathBuf::from(path).canonicalize().map_err(|_| denied())?;
            let roots = [
                app.path().app_data_dir(),
                app.path().app_local_data_dir(),
                app.path().app_cache_dir(),
            ];
            if !roots
                .into_iter()
                .filter_map(Result::ok)
                .filter_map(|root| root.canonicalize().ok())
                .any(|root| selected.starts_with(root))
            {
                return Err(denied());
            }
            let file = File::open(&selected).map_err(|_| denied())?;
            let metadata = file.metadata().map_err(|_| denied())?;
            if !metadata.is_file() {
                return Err(denied());
            }
            validate_upload_limits(&capabilities, metadata.len(), "application/octet-stream")?;
            let file_name = selected
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(denied)?
                .to_owned();
            // Opaque one-use authority key; no local filesystem path enters the provider mutation.
            let grant = uuid::Uuid::new_v4().to_string();
            crate::features::mobile_background::with_work(
                &app,
                crate::features::mobile_background::BackgroundReason::Transfer,
                async {
                    provider
                        .grant_upload_file(&session.workspace.host.connection, grant.clone(), file)
                        .await
                        .map_err(remote)?;
                    service
                        .execute(&OperationRequest {
                            operation_id,
                            mutation: Mutation::UploadAttachment {
                                upload: AttachmentUpload {
                                    session,
                                    local_path: grant,
                                    file_name,
                                    mime_type: "application/octet-stream".into(),
                                    size_bytes: metadata.len(),
                                },
                            },
                        })
                        .await
                },
            )
            .await
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pin_and_confirmation_both_reject_changed_host_identity() {
        let old = crate::integration::dsh_remote::protocol::encode_base64(&[0; 32]);
        let changed = crate::integration::dsh_remote::protocol::encode_base64(&[1; 32]);
        let confirmed = fingerprint(&old).unwrap();
        assert!(verified_identity(&old, None, Some(&confirmed)).is_ok());
        assert!(verified_identity(&old, Some(&old), Some(&confirmed)).is_ok());
        assert!(
            verified_identity(&changed, Some(&old), Some(&fingerprint(&changed).unwrap())).is_err()
        );
        assert!(verified_identity(&changed, None, Some(&confirmed)).is_err());
        assert!(verified_identity("malformed", None, None).is_err());
    }
    #[test]
    fn upload_requires_negotiated_capability_size_and_mime_before_grant() {
        let mut capabilities = Capabilities {
            operations: vec![],
            authentication: vec![],
            backends: vec![],
            attachments: Some(AttachmentLimits {
                max_bytes: 10,
                mime_types: vec![],
            }),
        };
        assert!(validate_upload_limits(&capabilities, 1, "application/octet-stream").is_err());
        capabilities.operations.push(Capability::UploadAttachment);
        assert!(validate_upload_limits(&capabilities, 10, "application/octet-stream").is_ok());
        assert!(validate_upload_limits(&capabilities, 11, "application/octet-stream").is_err());
        capabilities.attachments.as_mut().unwrap().mime_types = vec!["application/pdf".into()];
        assert!(validate_upload_limits(&capabilities, 1, "application/octet-stream").is_err());
        capabilities.attachments = None;
        assert!(validate_upload_limits(&capabilities, 1, "application/octet-stream").is_err());
    }
    #[test]
    fn refresh_uses_epoch_milliseconds_and_one_minute_margin() {
        assert!(refresh_due(1_000_000, 940_000));
        assert!(!refresh_due(1_000_001, 940_000));
        assert!(refresh_due(1, 940_000));
    }
    #[test]
    fn fingerprint_validates_key_and_has_stable_digest() {
        assert!(fingerprint("not a key").is_err());
        let public = crate::integration::dsh_remote::protocol::encode_base64(&[0; 32]);
        assert_eq!(
            fingerprint(&public).unwrap(),
            format!("SHA256:{}", hex::encode(Sha256::digest([0; 32])))
        );
    }
}
