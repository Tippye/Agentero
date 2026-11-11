use super::provider::unsupported;
use super::*;
use crate::core::error::AppError;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use tokio::sync::Mutex;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::domain("remote_agent_invalid", message)
}

fn boundary() -> AppError {
    AppError::domain(
        "remote_agent_namespace",
        "Remote Agent reference crossed its namespace",
    )
}

fn identifier(value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err(invalid("Invalid opaque Remote Agent identifier"));
    }
    Ok(())
}

fn connection_ref(connection: &ConnectionRef) -> Result<(), AppError> {
    identifier(&connection.provider_id.0)?;
    identifier(&connection.connection_id.0)
}

fn host_ref(host: &HostRef) -> Result<(), AppError> {
    connection_ref(&host.connection)?;
    identifier(&host.host_id.0)
}

fn workspace_ref(workspace: &WorkspaceRef) -> Result<(), AppError> {
    host_ref(&workspace.host)?;
    identifier(&workspace.backend_id.0)?;
    identifier(&workspace.workspace_id.0)
}

fn session_ref(session: &SessionRef) -> Result<(), AppError> {
    workspace_ref(&session.workspace)?;
    identifier(&session.session_id.0)
}

fn operation_id(id: &OperationId) -> Result<(), AppError> {
    if !(16..=128).contains(&id.0.len())
        || !id
            .0
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(invalid(
            "Operation ID must contain 16–128 ASCII letters, digits, '_' or '-'",
        ));
    }
    Ok(())
}

fn require(info: &ConnectionInfo, capability: Capability) -> Result<(), AppError> {
    if !info.capabilities.supports(capability) {
        return Err(unsupported(capability));
    }
    Ok(())
}

fn backend(info: &ConnectionInfo, workspace: &WorkspaceRef) -> Result<(), AppError> {
    if workspace.host.connection != info.connection {
        return Err(boundary());
    }
    if !info.capabilities.backends.contains(&workspace.backend_id) {
        return Err(AppError::domain(
            "remote_agent_backend_unsupported",
            "Remote Agent backend is unavailable",
        ));
    }
    Ok(())
}

fn connection_info(info: &ConnectionInfo, expected: &ConnectionRef) -> Result<(), AppError> {
    if &info.connection != expected {
        return Err(boundary());
    }
    for backend in &info.capabilities.backends {
        identifier(&backend.0)?;
    }
    if info.capabilities.supports(Capability::UploadAttachment)
        && info.capabilities.attachments.is_none()
    {
        return Err(invalid(
            "Upload capability requires effective attachment limits",
        ));
    }
    Ok(())
}

fn event(event: &RemoteEvent, expected: &SessionRef) -> Result<(), AppError> {
    if &event.session != expected {
        return Err(boundary());
    }
    identifier(&event.source_stream_id)?;
    identifier(&event.source_id)?;
    if let Some(cursor) = &event.cursor {
        identifier(&cursor.stream_id)?;
        identifier(&cursor.value)?;
    }
    Ok(())
}

fn snapshot(snapshot: &mut SessionSnapshot, expected: &SessionRef) -> Result<(), AppError> {
    if &snapshot.info.session != expected {
        return Err(boundary());
    }
    if let Some(cursor) = &snapshot.cursor {
        identifier(&cursor.stream_id)?;
        identifier(&cursor.value)?;
    }
    let mut seen = HashSet::new();
    for item in &snapshot.events {
        event(item, expected)?;
    }
    snapshot
        .events
        .retain(|item| seen.insert((item.source_stream_id.clone(), item.source_id.clone())));
    Ok(())
}

#[derive(Clone)]
struct RegisteredProvider {
    descriptor: ProviderDescriptor,
    adapter: Arc<dyn RemoteAgentProvider>,
}

struct Registry {
    default_provider: ProviderId,
    providers: HashMap<ProviderId, RegisteredProvider>,
}

struct OperationRecord {
    request: Option<OperationRequest>,
    outcome: OperationOutcome,
}

#[derive(Default)]
struct ConnectionState {
    info: Option<ConnectionInfo>,
    active: bool,
    operations: HashMap<OperationId, OperationRecord>,
}

impl ConnectionState {
    fn connected(&self) -> Result<&ConnectionInfo, AppError> {
        self.info.as_ref().filter(|_| self.active).ok_or_else(|| {
            AppError::domain(
                "remote_agent_disconnected",
                "Remote Agent connection is not active",
            )
        })
    }
}

/// One process-owned service for all windows and background tasks. Connection
/// calls are serialized per configured instance, never under the registry lock.
/// The operation journal lives for this service's lifetime, including disconnects.
/// Applications must retain operation IDs across restart and inspect official
/// receipts/history before deciding what a user should do next.
pub struct RemoteAgentService {
    registry: RwLock<Registry>,
    connections: Mutex<HashMap<ConnectionRef, Arc<Mutex<ConnectionState>>>>,
}

impl Default for RemoteAgentService {
    fn default() -> Self {
        Self {
            registry: RwLock::new(Registry {
                default_provider: ProviderId::from(DEFAULT_PROVIDER_ID),
                providers: HashMap::new(),
            }),
            connections: Mutex::new(HashMap::new()),
        }
    }
}

impl RemoteAgentService {
    pub fn register(&self, adapter: Arc<dyn RemoteAgentProvider>) -> Result<(), AppError> {
        let descriptor = adapter.descriptor();
        identifier(&descriptor.provider_id.0)?;
        if descriptor.contract_version != CONTRACT_VERSION || descriptor.config_version == 0 {
            return Err(invalid(
                "Unsupported Remote Agent contract or configuration version",
            ));
        }
        let mut registry = self
            .registry
            .write()
            .map_err(|_| invalid("Provider registry is unavailable"))?;
        if registry.providers.contains_key(&descriptor.provider_id) {
            return Err(AppError::domain(
                "remote_agent_duplicate_provider",
                "Provider ID is already registered",
            ));
        }
        registry.providers.insert(
            descriptor.provider_id.clone(),
            RegisteredProvider {
                descriptor,
                adapter,
            },
        );
        Ok(())
    }

    pub fn providers(&self) -> Result<Vec<ProviderDescriptor>, AppError> {
        let registry = self
            .registry
            .read()
            .map_err(|_| invalid("Provider registry is unavailable"))?;
        let mut providers: Vec<_> = registry
            .providers
            .values()
            .map(|p| p.descriptor.clone())
            .collect();
        providers.sort_by(|a, b| a.provider_id.0.cmp(&b.provider_id.0));
        Ok(providers)
    }

    pub fn default_provider(&self) -> Result<ProviderId, AppError> {
        Ok(self
            .registry
            .read()
            .map_err(|_| invalid("Provider registry is unavailable"))?
            .default_provider
            .clone())
    }

    pub fn set_default_provider(&self, id: &ProviderId) -> Result<(), AppError> {
        let mut registry = self
            .registry
            .write()
            .map_err(|_| invalid("Provider registry is unavailable"))?;
        if !registry.providers.contains_key(id) {
            return Err(AppError::domain(
                "remote_agent_provider_not_found",
                "Remote Agent provider is not registered",
            ));
        }
        registry.default_provider = id.clone();
        Ok(())
    }

    fn provider(&self, connection: &ConnectionRef) -> Result<RegisteredProvider, AppError> {
        connection_ref(connection)?;
        self.registry
            .read()
            .map_err(|_| invalid("Provider registry is unavailable"))?
            .providers
            .get(&connection.provider_id)
            .cloned()
            .ok_or_else(|| {
                AppError::domain(
                    "remote_agent_provider_not_found",
                    "Remote Agent provider is not registered",
                )
            })
    }

    async fn state(&self, connection: &ConnectionRef) -> Arc<Mutex<ConnectionState>> {
        self.connections
            .lock()
            .await
            .entry(connection.clone())
            .or_default()
            .clone()
    }

    pub async fn connect(&self, request: &ConnectRequest) -> Result<ConnectionInfo, AppError> {
        let provider = self.provider(&request.connection)?;
        if provider.descriptor.config_version != request.config_version {
            return Err(invalid("Remote Agent configuration version mismatch"));
        }
        let state = self.state(&request.connection).await;
        let mut state = state.lock().await;
        if state.active {
            return Ok(state.connected()?.clone());
        }
        let info = provider.adapter.connect(request).await?;
        connection_info(&info, &request.connection)?;
        state.info = Some(info.clone());
        state.active = true;
        Ok(info)
    }

    pub async fn disconnect(&self, connection: &ConnectionRef) -> Result<(), AppError> {
        let provider = self.provider(connection)?;
        let state = self.state(connection).await;
        let mut state = state.lock().await;
        if !state.active {
            return Ok(());
        }
        // Fail closed even if cleanup errors or its future is cancelled.
        state.active = false;
        provider.adapter.disconnect(connection).await
    }

    pub async fn resume(&self, connection: &ConnectionRef) -> Result<ConnectionInfo, AppError> {
        let provider = self.provider(connection)?;
        let state = self.state(connection).await;
        let mut state = state.lock().await;
        let previous = state
            .info
            .as_ref()
            .ok_or_else(|| invalid("Connect before resuming"))?;
        require(previous, Capability::Resume)?;
        state.active = false;
        let info = provider.adapter.resume(connection).await?;
        connection_info(&info, connection)?;
        state.info = Some(info.clone());
        state.active = true;
        Ok(info)
    }

    pub async fn list_hosts(&self, connection: &ConnectionRef) -> Result<Vec<HostInfo>, AppError> {
        let provider = self.provider(connection)?;
        let state = self.state(connection).await;
        let state = state.lock().await;
        require(state.connected()?, Capability::ListHosts)?;
        let hosts = provider.adapter.list_hosts(connection).await?;
        for item in &hosts {
            host_ref(&item.host)?;
            if &item.host.connection != connection {
                return Err(boundary());
            }
        }
        Ok(hosts)
    }

    pub async fn list_workspaces(&self, host: &HostRef) -> Result<Vec<WorkspaceInfo>, AppError> {
        host_ref(host)?;
        let provider = self.provider(&host.connection)?;
        let state = self.state(&host.connection).await;
        let state = state.lock().await;
        let info = state.connected()?;
        require(info, Capability::ListWorkspaces)?;
        let workspaces = provider.adapter.list_workspaces(host).await?;
        for item in &workspaces {
            workspace_ref(&item.workspace)?;
            if &item.workspace.host != host {
                return Err(boundary());
            }
            backend(info, &item.workspace)?;
        }
        Ok(workspaces)
    }

    pub async fn list_sessions(
        &self,
        workspace: &WorkspaceRef,
    ) -> Result<Vec<SessionInfo>, AppError> {
        workspace_ref(workspace)?;
        let provider = self.provider(&workspace.host.connection)?;
        let state = self.state(&workspace.host.connection).await;
        let state = state.lock().await;
        let info = state.connected()?;
        require(info, Capability::ListSessions)?;
        backend(info, workspace)?;
        let sessions = provider.adapter.list_sessions(workspace).await?;
        for item in &sessions {
            session_ref(&item.session)?;
            if &item.session.workspace != workspace {
                return Err(boundary());
            }
        }
        Ok(sessions)
    }

    pub async fn read_session(&self, session: &SessionRef) -> Result<SessionSnapshot, AppError> {
        session_ref(session)?;
        let provider = self.provider(&session.workspace.host.connection)?;
        let state = self.state(&session.workspace.host.connection).await;
        let state = state.lock().await;
        let info = state.connected()?;
        require(info, Capability::ReadSession)?;
        backend(info, &session.workspace)?;
        let mut result = provider.adapter.read_session(session).await?;
        snapshot(&mut result, session)?;
        Ok(result)
    }

    /// Explicit reconnect recovery: return a complete official baseline and a
    /// subscriber seeded with its source IDs. Each window gets its own baseline
    /// and de-duplication set. No mutations are dispatched during recovery.
    pub async fn recover_session(
        &self,
        session: &SessionRef,
    ) -> Result<RecoveredSession, AppError> {
        session_ref(session)?;
        let provider = self.provider(&session.workspace.host.connection)?;
        let state = self.state(&session.workspace.host.connection).await;
        let state = state.lock().await;
        let info = state.connected()?;
        require(info, Capability::ReadSession)?;
        require(info, Capability::Subscribe)?;
        backend(info, &session.workspace)?;
        let mut baseline = provider.adapter.read_session(session).await?;
        snapshot(&mut baseline, session)?;
        let inner = provider
            .adapter
            .subscribe(session, baseline.cursor.as_ref())
            .await?;
        let seen = baseline
            .events
            .iter()
            .map(|e| (e.source_stream_id.clone(), e.source_id.clone()))
            .collect();
        Ok(RecoveredSession {
            subscription: SessionSubscription {
                inner,
                session: session.clone(),
                seen,
                closed: false,
            },
            snapshot: baseline,
        })
    }

    pub async fn execute(&self, request: &OperationRequest) -> Result<OperationOutcome, AppError> {
        operation_id(&request.operation_id)?;
        let workspace = request.mutation.workspace();
        workspace_ref(workspace)?;
        let connection = &workspace.host.connection;
        let provider = self.provider(connection)?;
        let state = self.state(connection).await;
        let mut state = state.lock().await;
        // Check the journal before connectivity/capabilities: an uncertain write
        // remains uncertain after disconnect or capability renegotiation.
        if let Some(previous) = state.operations.get(&request.operation_id) {
            if previous
                .request
                .as_ref()
                .is_some_and(|original| original != request)
            {
                return Err(AppError::domain(
                    "remote_agent_operation_conflict",
                    "Operation ID was already used for a different request",
                ));
            }
            // A receipt imported after restart may have no original request.
            // Still reject any result that does not belong to this target.
            validate_outcome(&previous.outcome, Some(&request.mutation), connection)?;
            return Ok(previous.outcome.clone());
        }
        let info = state.connected()?;
        require(info, request.mutation.capability())?;
        backend(info, workspace)?;
        validate_mutation(&request.mutation, info)?;
        state.operations.insert(
            request.operation_id.clone(),
            OperationRecord {
                request: Some(request.clone()),
                outcome: OperationOutcome::Unknown {
                    reason: "Dispatch started; no definitive receipt was recorded".into(),
                },
            },
        );
        // The entry is inserted before awaiting, so a dropped future cannot make
        // the same ID eligible for blind redispatch.
        let outcome = match provider.adapter.execute(request).await {
            Ok(outcome) => match validate_outcome(&outcome, Some(&request.mutation), connection) {
                Ok(()) => outcome,
                Err(error) => OperationOutcome::Unknown {
                    reason: error.to_string(),
                },
            },
            Err(error) => OperationOutcome::Unknown {
                reason: error.to_string(),
            },
        };
        state.operations.insert(
            request.operation_id.clone(),
            OperationRecord {
                request: Some(request.clone()),
                outcome: outcome.clone(),
            },
        );
        Ok(outcome)
    }

    pub async fn local_outcome(
        &self,
        connection: &ConnectionRef,
        id: &OperationId,
    ) -> Result<Option<OperationOutcome>, AppError> {
        self.provider(connection)?;
        operation_id(id)?;
        let state = self.state(connection).await;
        let state = state.lock().await;
        Ok(state
            .operations
            .get(id)
            .map(|record| record.outcome.clone()))
    }

    /// Receipt lookup only; NotFound never clears the journal. Also works for a
    /// retained operation ID after application restart, without redispatching it.
    pub async fn lookup_receipt(
        &self,
        connection: &ConnectionRef,
        id: &OperationId,
    ) -> Result<ReceiptLookup, AppError> {
        let provider = self.provider(connection)?;
        operation_id(id)?;
        let state = self.state(connection).await;
        let mut state = state.lock().await;
        // A retained ID represents a potentially submitted write even when the
        // connection is down, receipts are unsupported, or the query fails.
        state
            .operations
            .entry(id.clone())
            .or_insert_with(|| OperationRecord {
                request: None,
                outcome: OperationOutcome::Unknown {
                    reason: "Receipt lookup pending; operation may already have executed".into(),
                },
            });
        require(state.connected()?, Capability::OperationReceipts)?;
        let receipt = provider.adapter.lookup_receipt(connection, id).await?;
        if let ReceiptLookup::Found(outcome) = &receipt {
            let mutation = state
                .operations
                .get(id)
                .and_then(|record| record.request.as_ref())
                .map(|request| &request.mutation);
            validate_outcome(outcome, mutation, connection)?;
            if let Some(record) = state.operations.get_mut(id) {
                record.outcome = outcome.clone();
            }
        }
        Ok(receipt)
    }
}

fn validate_mutation(mutation: &Mutation, info: &ConnectionInfo) -> Result<(), AppError> {
    match mutation {
        Mutation::CreateSession { .. } => (),
        Mutation::SendMessage {
            session,
            attachments,
            ..
        } => {
            session_ref(session)?;
            for attachment in attachments {
                if &attachment.session != session {
                    return Err(boundary());
                }
            }
        }
        Mutation::Cancel { session }
        | Mutation::RespondPermission { session, .. }
        | Mutation::RespondQuestion { session, .. } => session_ref(session)?,
        Mutation::UploadAttachment { upload } => {
            session_ref(&upload.session)?;
            let limits = info
                .capabilities
                .attachments
                .as_ref()
                .ok_or_else(|| unsupported(Capability::UploadAttachment))?;
            if upload.size_bytes > limits.max_bytes {
                return Err(AppError::domain(
                    "remote_agent_attachment_too_large",
                    "Attachment exceeds the negotiated route limit",
                ));
            }
            if !limits.mime_types.is_empty() && !limits.mime_types.contains(&upload.mime_type) {
                return Err(AppError::domain(
                    "remote_agent_attachment_type",
                    "Attachment MIME type is not supported",
                ));
            }
            if upload.local_path.is_empty() || upload.file_name.is_empty() {
                return Err(invalid("Attachment path and name are required"));
            }
        }
    }
    Ok(())
}

fn validate_outcome(
    outcome: &OperationOutcome,
    mutation: Option<&Mutation>,
    connection: &ConnectionRef,
) -> Result<(), AppError> {
    if let OperationOutcome::Succeeded { result } = outcome {
        match result {
            OperationResult::SessionCreated { session } => {
                session_ref(session)?;
                if &session.workspace.host.connection != connection {
                    return Err(boundary());
                }
                if let Some(mutation) = mutation {
                    match mutation {
                        Mutation::CreateSession { workspace, .. }
                            if workspace == &session.workspace => {}
                        _ => return Err(boundary()),
                    }
                }
            }
            OperationResult::AttachmentUploaded { attachment } => {
                session_ref(&attachment.session)?;
                if &attachment.session.workspace.host.connection != connection {
                    return Err(boundary());
                }
                if let Some(mutation) = mutation {
                    match mutation {
                        Mutation::UploadAttachment { upload }
                            if upload.session == attachment.session => {}
                        _ => return Err(boundary()),
                    }
                }
            }
            OperationResult::Acknowledged => {
                if matches!(
                    mutation,
                    Some(Mutation::CreateSession { .. } | Mutation::UploadAttachment { .. })
                ) {
                    return Err(invalid("Completed operation is missing its result"));
                }
            }
        }
    }
    Ok(())
}

pub struct RecoveredSession {
    pub snapshot: SessionSnapshot,
    pub subscription: SessionSubscription,
}

/// De-duplication is per subscriber and source epoch. Keys, not event bodies,
/// are retained until cancellation/drop so history overlaps cannot lose messages.
/// Stream failure/EOF closes this subscriber; callers explicitly recover again.
pub struct SessionSubscription {
    inner: Box<dyn RemoteAgentSubscription>,
    session: SessionRef,
    seen: HashSet<(String, String)>,
    closed: bool,
}

impl SessionSubscription {
    pub async fn next(&mut self) -> Result<Option<RemoteEvent>, AppError> {
        if self.closed {
            return Ok(None);
        }
        loop {
            let next = self.inner.next().await;
            match next {
                Ok(Some(item)) => {
                    if let Err(error) = event(&item, &self.session) {
                        self.closed = true;
                        let _ = self.inner.cancel().await;
                        return Err(error);
                    }
                    if self
                        .seen
                        .insert((item.source_stream_id.clone(), item.source_id.clone()))
                    {
                        return Ok(Some(item));
                    }
                }
                Ok(None) => {
                    self.closed = true;
                    return Ok(None);
                }
                Err(error) => {
                    self.closed = true;
                    return Err(error);
                }
            }
        }
    }

    pub async fn cancel(&mut self) -> Result<(), AppError> {
        self.closed = true;
        self.inner.cancel().await
    }
}
