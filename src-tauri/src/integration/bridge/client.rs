use super::identity::ClientIdentityRepository;
use super::{
    connect_relay, next_frame, send_binary, send_text, BridgeClientIdentity, BridgeClientProfile,
    BridgeClientProfileStore, BridgeMessage, BridgeOffer, E2eeHandshake, RelayEndpoint, RelayFrame,
    SessionCipher,
};
use crate::core::error::AppError;
use crate::integration::credentials::CredentialStore;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use crypto_box::{PublicKey, SecretKey};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, watch};

const RECONNECT_DELAY: Duration = Duration::from_secs(2);
const FRAME_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BridgeClientStatus {
    pub connected: bool,
    pub paired: bool,
    pub server_id: Option<String>,
    pub host_name: Option<String>,
    pub relay_endpoint: Option<String>,
    pub vault_name: Option<String>,
    pub last_error: Option<String>,
}

impl BridgeClientStatus {
    fn disconnected() -> Self {
        Self {
            connected: false,
            paired: false,
            server_id: None,
            host_name: None,
            relay_endpoint: None,
            vault_name: None,
            last_error: None,
        }
    }
}

pub struct BridgeClientController {
    state: Arc<Mutex<ClientState>>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    identities: Arc<ClientIdentityRepository>,
    profiles: BridgeClientProfileStore,
}
#[derive(Default)]
struct ClientState {
    generation: u64,
    cancelled: u64,
    runtime: Option<ClientRuntime>,
}
struct ClientRuntime {
    profile: BridgeClientProfile,
    status: Arc<Mutex<BridgeClientStatus>>,
    commands: mpsc::Sender<ClientCommand>,
    stop: watch::Sender<bool>,
}
enum ClientCommand {
    Rpc {
        id: String,
        method: String,
        params: Value,
        response: oneshot::Sender<Result<Value, AppError>>,
    },
}
#[derive(Clone)]
struct ClientOwner {
    state: Arc<Mutex<ClientState>>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    generation: u64,
    profiles: BridgeClientProfileStore,
    profile: BridgeClientProfile,
    expected_profile: Option<Vec<u8>>,
    status: Arc<Mutex<BridgeClientStatus>>,
}
struct ClientLaunch {
    offer: BridgeOffer,
    identity: BridgeClientIdentity,
    owner: ClientOwner,
    commands: mpsc::Receiver<ClientCommand>,
    stop: watch::Receiver<bool>,
}
impl ClientOwner {
    fn is_current(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.generation == self.generation && state.runtime.is_some())
    }
    fn ensure_current(&self, stop: &watch::Receiver<bool>) -> Result<(), AppError> {
        if *stop.borrow() || !self.is_current() {
            return Err(transport_interrupted());
        }
        Ok(())
    }
    async fn while_current<T>(
        &self,
        stop: &mut watch::Receiver<bool>,
        transport: impl std::future::Future<Output = T>,
    ) -> Result<T, AppError> {
        self.ensure_current(stop)?;
        tokio::select! {
            biased;
            _ = stop.changed() => Err(transport_interrupted()),
            result = transport => { self.ensure_current(stop)?; Ok(result) }
        }
    }
    fn emit(&self, app: &AppHandle, event: &str, payload: impl Serialize + Clone) {
        // Keep this short state guard through the synchronous event publication.
        // A superseded transport must not publish status for its replacement.
        if let Ok(state) = self.state.lock() {
            if state.generation == self.generation && state.runtime.is_some() {
                let _ = app.emit(event, payload);
            }
        }
    }
    async fn mark_paired(&self) -> Result<bool, AppError> {
        let _owner = self.lifecycle.lock().await;
        let state = self.state.lock().map_err(|_| client_lock())?;
        if state.generation != self.generation || state.runtime.is_none() {
            return Ok(false);
        }
        let mut current = self.status.lock().map_err(|_| client_lock())?;
        if current.paired {
            return Ok(true);
        }
        let mut profile = self.profile.clone();
        profile.paired = true;
        if !self
            .profiles
            .save_if_snapshot(&self.expected_profile, &profile)?
        {
            return Err(AppError::domain(
                "bridge_profile_changed",
                "Bridge profile changed while pairing; reconnect explicitly",
            ));
        }
        current.paired = true;
        current.last_error = None;
        Ok(true)
    }
}
fn client_lock() -> AppError {
    AppError::message("Bridge client lock poisoned")
}
fn stale_client() -> AppError {
    AppError::domain(
        "bridge_client_stale",
        "Bridge connection was superseded or disconnected",
    )
}
const UNCERTAIN_TRANSPORT: &str =
    "Bridge transport closed; an admitted RPC may already have executed";
fn transport_interrupted() -> AppError {
    AppError::domain("bridge_client_stale", UNCERTAIN_TRANSPORT)
}
fn fail_queued(commands: &mut mpsc::Receiver<ClientCommand>) {
    while let Ok(ClientCommand::Rpc { response, .. }) = commands.try_recv() {
        let _ = response.send(Err(transport_interrupted()));
    }
}
fn profile_status(profile: &BridgeClientProfile, offer: &BridgeOffer) -> BridgeClientStatus {
    BridgeClientStatus {
        connected: false,
        paired: profile.paired,
        server_id: Some(offer.server_id.clone()),
        host_name: Some(offer.host_name.clone()),
        relay_endpoint: Some(offer.relay.endpoint.clone()),
        vault_name: None,
        last_error: None,
    }
}
impl BridgeClientController {
    pub fn new() -> Self {
        Self::with_credentials(None)
    }
    pub fn with_credentials(store: Option<CredentialStore>) -> Self {
        Self::with_repository(
            Arc::new(ClientIdentityRepository::new(store)),
            BridgeClientProfileStore::at_default_path(),
        )
    }
    fn with_repository(
        identities: Arc<ClientIdentityRepository>,
        profiles: BridgeClientProfileStore,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(ClientState::default())),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            identities,
            profiles,
        }
    }
    fn cancellation(&self) -> Result<u64, AppError> {
        Ok(self.state.lock().map_err(|_| client_lock())?.cancelled)
    }
    fn generation_after(&self, cancellation: u64) -> Result<u64, AppError> {
        let state = self.state.lock().map_err(|_| client_lock())?;
        if state.cancelled != cancellation {
            return Err(stale_client());
        }
        Ok(state.generation)
    }

    pub async fn connect(
        &self,
        app: AppHandle,
        offer_url: String,
        device_name: String,
    ) -> Result<BridgeClientStatus, AppError> {
        self.connect_owned(offer_url, device_name, move |launch| {
            tauri::async_runtime::spawn(run_client_loop(app, launch));
        })
        .await
    }
    async fn connect_owned(
        &self,
        offer_url: String,
        device_name: String,
        launch: impl FnOnce(ClientLaunch),
    ) -> Result<BridgeClientStatus, AppError> {
        let cancellation = self.cancellation()?;
        let _owner = self.lifecycle.lock().await;
        let generation = self.generation_after(cancellation)?;
        let device_name = device_name.trim().to_owned();
        if device_name.is_empty() {
            return Err(AppError::message("device name is required"));
        }
        let offer = BridgeOffer::from_pair_url(&offer_url)?;
        let expected_profile = self.profiles.snapshot()?;
        let identity = self.identities.acquire(true).await?;
        let profile = BridgeClientProfile {
            offer_url,
            device_name,
            paired: false,
        };
        let prepared = self.install(profile, offer, identity, expected_profile, generation)?;
        let status = status_snapshot(&prepared.owner.status)?;
        launch(prepared);
        Ok(status)
    }
    pub async fn resume(&self, app: AppHandle) -> Result<BridgeClientStatus, AppError> {
        self.resume_owned(move |launch| {
            tauri::async_runtime::spawn(run_client_loop(app, launch));
        })
        .await
    }
    async fn resume_owned(
        &self,
        launch: impl FnOnce(ClientLaunch),
    ) -> Result<BridgeClientStatus, AppError> {
        let cancellation = self.cancellation()?;
        let _owner = self.lifecycle.lock().await;
        let generation = self.generation_after(cancellation)?;
        let expected_profile = self.profiles.snapshot()?;
        let Some(raw) = &expected_profile else {
            return self.status();
        };
        let profile: BridgeClientProfile = serde_json::from_slice(raw)?;
        if !profile.paired {
            return self.status();
        }
        let offer = BridgeOffer::from_pair_url(&profile.offer_url)?;
        // Resume is never an identity-creation path, including after reset.
        {
            let state = self.state.lock().map_err(|_| client_lock())?;
            if let Some(runtime) = &state.runtime {
                let current = status_snapshot(&runtime.status)?;
                if current.paired
                    && runtime.profile.offer_url == profile.offer_url
                    && runtime.profile.device_name == profile.device_name
                {
                    return Ok(current);
                }
                // Visibility resume must not interrupt a newer explicit Pair.
                if !current.paired {
                    return Ok(current);
                }
            }
        }
        let identity = self.identities.acquire(false).await?;
        let prepared = self.install(profile, offer, identity, expected_profile, generation)?;
        let status = status_snapshot(&prepared.owner.status)?;
        launch(prepared);
        Ok(status)
    }
    fn install(
        &self,
        profile: BridgeClientProfile,
        offer: BridgeOffer,
        identity: BridgeClientIdentity,
        expected_profile: Option<Vec<u8>>,
        expected_generation: u64,
    ) -> Result<ClientLaunch, AppError> {
        let mut state = self.state.lock().map_err(|_| client_lock())?;
        if state.generation != expected_generation {
            return Err(stale_client());
        }
        let generation = state.generation.checked_add(1).ok_or_else(stale_client)?;
        let status = Arc::new(Mutex::new(profile_status(&profile, &offer)));
        let (commands, command_rx) = mpsc::channel(64);
        let (stop, stop_rx) = watch::channel(false);
        if let Some(old) = state.runtime.take() {
            let _ = old.stop.send(true);
        }
        state.generation = generation;
        state.runtime = Some(ClientRuntime {
            profile: profile.clone(),
            status: status.clone(),
            commands,
            stop,
        });
        Ok(ClientLaunch {
            offer,
            identity,
            owner: ClientOwner {
                state: self.state.clone(),
                lifecycle: self.lifecycle.clone(),
                generation,
                profiles: self.profiles.clone(),
                profile,
                expected_profile,
                status,
            },
            commands: command_rx,
            stop: stop_rx,
        })
    }
    /// Stop only the live transport. Durable identity and pairing are preserved.
    pub fn disconnect(&self) -> Result<(), AppError> {
        let mut state = self.state.lock().map_err(|_| client_lock())?;
        state.generation = state.generation.checked_add(1).ok_or_else(stale_client)?;
        state.cancelled = state.cancelled.checked_add(1).ok_or_else(stale_client)?;
        if let Some(runtime) = state.runtime.take() {
            let _ = runtime.stop.send(true);
        }
        Ok(())
    }
    pub fn status(&self) -> Result<BridgeClientStatus, AppError> {
        {
            let state = self.state.lock().map_err(|_| client_lock())?;
            if let Some(runtime) = &state.runtime {
                return status_snapshot(&runtime.status);
            }
        }
        // Public metadata only: default DSH launch/status never reads Bridge keys.
        match self.profiles.load()? {
            Some(profile) => {
                let offer = BridgeOffer::from_pair_url(&profile.offer_url)?;
                Ok(profile_status(&profile, &offer))
            }
            None => Ok(BridgeClientStatus::disconnected()),
        }
    }
    pub async fn reset_identity(&self) -> Result<BridgeClientStatus, AppError> {
        let _owner = self.lifecycle.lock().await;
        self.identities.begin_reset().await?;
        // Tombstone is durable before transport stop, source deletion or profile purge.
        self.disconnect()?;
        self.identities.finish_reset(&self.profiles).await?;
        self.status()
    }
    pub async fn rpc(&self, method: String, params: Value) -> Result<Value, AppError> {
        let commands = self
            .state
            .lock()
            .map_err(|_| client_lock())?
            .runtime
            .as_ref()
            .map(|runtime| runtime.commands.clone())
            .ok_or_else(|| AppError::message("No desktop connection"))?;
        let (sender, receiver) = oneshot::channel();
        commands
            .send(ClientCommand::Rpc {
                id: format!("req_{}", uuid::Uuid::new_v4().simple()),
                method,
                params,
                response: sender,
            })
            .await
            .map_err(|_| AppError::message("Bridge connection is offline"))?;
        receiver
            .await
            .map_err(|_| AppError::message("Bridge request was cancelled"))?
    }
}

impl Default for BridgeClientController {
    fn default() -> Self {
        Self::new()
    }
}

async fn run_client_loop(app: AppHandle, launch: ClientLaunch) {
    let ClientLaunch {
        offer,
        identity,
        owner,
        mut commands,
        mut stop,
    } = launch;
    let status = owner.status.clone();
    let device_name = owner.profile.device_name.clone();
    let endpoint = match RelayEndpoint::parse(&offer.relay.endpoint) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            set_error(&app, &status, error.to_string(), &owner);
            return;
        }
    };
    loop {
        if *stop.borrow() || !owner.is_current() {
            return;
        }
        let url = match endpoint.connection_url(&offer.server_id, "client", None) {
            Ok(url) => url,
            Err(error) => {
                set_error(&app, &status, error.to_string(), &owner);
                return;
            }
        };
        emit_progress(&app, "relayConnecting", &owner);
        let connection = match owner.while_current(&mut stop, connect_relay(url)).await {
            Ok(result) => result,
            Err(_) => {
                fail_queued(&mut commands);
                return;
            }
        };
        match connection {
            Ok(mut socket) => {
                emit_progress(&app, "e2eeHandshake", &owner);
                if let Err(error) = run_client_session(
                    &app,
                    &mut socket,
                    &offer,
                    &identity,
                    &device_name,
                    &status,
                    &owner,
                    &mut commands,
                    &mut stop,
                )
                .await
                {
                    set_error(&app, &status, error.to_string(), &owner);
                }
            }
            Err(error) => set_error(&app, &status, error.to_string(), &owner),
        }
        if owner.ensure_current(&stop).is_err() {
            fail_queued(&mut commands);
            return;
        }
        set_connected(&app, &status, false, &owner);
        tokio::select! {
            _ = tokio::time::sleep(RECONNECT_DELAY) => {}
            changed = stop.changed() => if changed.is_err() || *stop.borrow() { return; },
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_client_session(
    app: &AppHandle,
    socket: &mut super::RelaySocket,
    offer: &BridgeOffer,
    identity: &BridgeClientIdentity,
    device_name: &str,
    status: &Arc<Mutex<BridgeClientStatus>>,
    owner: &ClientOwner,
    commands: &mut mpsc::Receiver<ClientCommand>,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), AppError> {
    owner.ensure_current(stop)?;
    let host_public = decode_public_key(&offer.host_public_key_b64)?;
    let ephemeral = SecretKey::generate(&mut crypto_box::aead::OsRng);
    owner
        .while_current(
            stop,
            send_text(
                socket,
                serde_json::to_string(&E2eeHandshake::hello(ephemeral.public_key().as_bytes()))?,
            ),
        )
        .await??;
    let RelayFrame::Text(payload) = owner.while_current(stop, next_frame(socket)).await?? else {
        return Err(AppError::message("Relay closed during E2EE handshake"));
    };
    if serde_json::from_str::<E2eeHandshake>(&payload)? != E2eeHandshake::E2eeReady {
        return Err(AppError::message("Desktop rejected E2EE handshake"));
    }
    let cipher = SessionCipher::from_keys(&ephemeral, &host_public);
    let pair_request_id = format!("pair_{}", uuid::Uuid::new_v4().simple());
    let initial = if status_snapshot(status)?.paired {
        emit_progress(app, "authenticating", owner);
        BridgeMessage::Hello {
            device_id: identity.device_id.clone(),
            protocol_version: 1,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    } else {
        emit_progress(app, "pairing", owner);
        BridgeMessage::PairRequest {
            request_id: pair_request_id.clone(),
            device_id: identity.device_id.clone(),
            device_name: device_name.to_string(),
            device_public_key_b64: identity.public_key_b64.clone(),
        }
    };
    owner
        .while_current(stop, send_encrypted(socket, &cipher, &initial))
        .await??;
    set_connected(app, status, true, owner);
    emit_progress(app, "connected", owner);
    let mut pending = HashMap::new();

    loop {
        if *stop.borrow() || !owner.is_current() {
            fail_pending(&mut pending, UNCERTAIN_TRANSPORT);
            fail_queued(commands);
            return Ok(());
        }
        while let Ok(command) = commands.try_recv() {
            let ClientCommand::Rpc {
                id,
                method,
                params,
                response,
            } = command;
            if let Err(error) = owner.ensure_current(stop) {
                let _ = response.send(Err(error));
                fail_pending(&mut pending, UNCERTAIN_TRANSPORT);
                fail_queued(commands);
                return Ok(());
            }
            if !status_snapshot(status)?.paired {
                let _ = response.send(Err(AppError::message(
                    "Pair this device before using remote access",
                )));
                continue;
            }
            if let Err(error) = owner
                .while_current(
                    stop,
                    send_encrypted(
                        socket,
                        &cipher,
                        &BridgeMessage::Rpc {
                            id: id.clone(),
                            method,
                            params,
                        },
                    ),
                )
                .await
                .and_then(|result| result)
            {
                let _ = response.send(Err(error));
                if owner.ensure_current(stop).is_err() {
                    fail_pending(&mut pending, UNCERTAIN_TRANSPORT);
                    fail_queued(commands);
                    return Ok(());
                }
                continue;
            }
            pending.insert(id, response);
        }
        let frame = match owner
            .while_current(
                stop,
                tokio::time::timeout(FRAME_POLL_INTERVAL, next_frame(socket)),
            )
            .await
        {
            Ok(frame) => frame,
            Err(error) => {
                fail_pending(&mut pending, UNCERTAIN_TRANSPORT);
                fail_queued(commands);
                return Err(error);
            }
        };
        match frame {
            Err(_) => continue,
            Ok(Err(error)) => {
                fail_pending(&mut pending, &error.to_string());
                return Err(error);
            }
            Ok(Ok(RelayFrame::Close)) => {
                fail_pending(&mut pending, "Desktop connection was closed");
                return Ok(());
            }
            Ok(Ok(RelayFrame::Text(_))) => continue,
            Ok(Ok(RelayFrame::Binary(frame))) => {
                let message = serde_json::from_slice(&cipher.decrypt(&frame)?)?;
                if let BridgeMessage::DeviceChallenge { nonce_b64 } = message {
                    let nonce = URL_SAFE_NO_PAD.decode(nonce_b64).map_err(|_| {
                        AppError::message("Bridge challenge is not valid base64url")
                    })?;
                    if let Err(error) = owner.ensure_current(stop) {
                        fail_pending(&mut pending, UNCERTAIN_TRANSPORT);
                        fail_queued(commands);
                        return Err(error);
                    }
                    let proof = BridgeMessage::DeviceProof {
                        signature_b64: identity.sign_challenge(&nonce)?,
                    };
                    if let Err(error) = owner
                        .while_current(stop, send_encrypted(socket, &cipher, &proof))
                        .await
                        .and_then(|result| result)
                    {
                        fail_pending(&mut pending, UNCERTAIN_TRANSPORT);
                        fail_queued(commands);
                        return Err(error);
                    }
                } else {
                    handle_message(app, status, &mut pending, owner, &pair_request_id, message)
                        .await?;
                }
            }
        }
    }
}

async fn handle_message(
    app: &AppHandle,
    status: &Arc<Mutex<BridgeClientStatus>>,
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, AppError>>>,
    owner: &ClientOwner,
    pair_request_id: &str,
    message: BridgeMessage,
) -> Result<(), AppError> {
    if !owner.is_current() {
        return Ok(());
    }
    match message {
        BridgeMessage::PairPending {
            request_id,
            verification_code,
        } => {
            if request_id != pair_request_id {
                return Ok(());
            }
            owner.emit(
                app,
                "bridge:pair-pending",
                serde_json::json!({"requestId": request_id, "verificationCode": verification_code}),
            );
        }
        BridgeMessage::PairOk { request_id } => {
            if !status_snapshot(status)?.paired && request_id != pair_request_id {
                return Ok(());
            }
            if owner.mark_paired().await? {
                owner.emit(app, "bridge:status", status_snapshot(status)?);
            }
        }
        BridgeMessage::PairDenied { reason, .. } => set_error(app, status, reason, owner),
        BridgeMessage::ServerInfo { vault_name, .. } => {
            let mut current = status
                .lock()
                .map_err(|_| AppError::message("Bridge client status lock poisoned"))?;
            current.vault_name = vault_name;
            let snapshot = current.clone();
            drop(current);
            owner.emit(app, "bridge:status", snapshot);
        }
        BridgeMessage::RpcResult {
            id,
            ok,
            data,
            error,
        } => {
            if let Some(sender) = pending.remove(&id) {
                let result = if ok {
                    Ok(data.unwrap_or(Value::Null))
                } else {
                    Err(AppError::message(
                        error
                            .map(|error| error.message)
                            .unwrap_or_else(|| "Bridge RPC failed".to_string()),
                    ))
                };
                let _ = sender.send(result);
            }
        }
        BridgeMessage::Event { name, payload } => {
            let event = format!("bridge:event:{name}");
            owner.emit(app, &event, payload);
        }
        _ => {}
    }
    Ok(())
}

async fn send_encrypted(
    socket: &mut super::RelaySocket,
    cipher: &SessionCipher,
    message: &BridgeMessage,
) -> Result<(), AppError> {
    send_binary(socket, cipher.encrypt(&serde_json::to_vec(message)?)?).await
}

fn decode_public_key(value: &str) -> Result<PublicKey, AppError> {
    let bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::message("E2EE public key is not valid base64url"))?
        .try_into()
        .map_err(|_| AppError::message("E2EE public key must contain 32 bytes"))?;
    Ok(PublicKey::from(bytes))
}

fn status_snapshot(
    status: &Arc<Mutex<BridgeClientStatus>>,
) -> Result<BridgeClientStatus, AppError> {
    status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| AppError::message("Bridge client status lock poisoned"))
}

fn set_connected(
    app: &AppHandle,
    status: &Arc<Mutex<BridgeClientStatus>>,
    connected: bool,
    owner: &ClientOwner,
) {
    let snapshot = status.lock().ok().map(|mut current| {
        current.connected = connected;
        if connected {
            current.last_error = None;
        }
        current.clone()
    });
    if let Some(snapshot) = snapshot {
        owner.emit(app, "bridge:status", snapshot);
    }
}
fn emit_progress(app: &AppHandle, phase: &str, owner: &ClientOwner) {
    owner.emit(app, "bridge:progress", phase);
}
fn set_error(
    app: &AppHandle,
    status: &Arc<Mutex<BridgeClientStatus>>,
    error: String,
    owner: &ClientOwner,
) {
    let snapshot = status.lock().ok().map(|mut current| {
        current.connected = false;
        current.last_error = Some(error);
        current.clone()
    });
    if let Some(snapshot) = snapshot {
        owner.emit(app, "bridge:status", snapshot);
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;

fn fail_pending(
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, AppError>>>,
    message: &str,
) {
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err(AppError::message(message)));
    }
}
