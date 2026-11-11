//! Serialized channel owner with concurrent RPC correlation and bounded events.
use super::{protocol::Envelope, relay::RelayChannel, RemoteError, Result};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::{broadcast, mpsc, oneshot, watch},
    time::{timeout, timeout_at, Instant},
};

const MAX_PENDING: usize = 128;
const MAX_REQUEST_IDS_PER_CONNECTION: usize = 16384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallSemantics {
    ReadOnly,
    Mutation,
}
#[derive(Clone)]
pub struct RpcClient {
    commands: mpsc::Sender<Command>,
    events: broadcast::Sender<Envelope>,
    closed: Arc<AtomicBool>,
    shutdown: watch::Sender<bool>,
    stopped: watch::Receiver<bool>,
}
struct Command {
    id: String,
    method: String,
    params: Value,
    mutation: bool,
    deadline: Instant,
    response: oneshot::Sender<Result<Value>>,
}
struct Pending {
    response: oneshot::Sender<Result<Value>>,
    mutation: bool,
    deadline: Instant,
}
impl RpcClient {
    pub fn start(channel: RelayChannel) -> Self {
        let (commands, receiver) = mpsc::channel(MAX_PENDING);
        let (events, _) = broadcast::channel(256);
        let closed = Arc::new(AtomicBool::new(false));
        let (shutdown, shutdown_receiver) = watch::channel(false);
        let (stopped_sender, stopped) = watch::channel(false);
        tokio::spawn(run(
            channel,
            receiver,
            events.clone(),
            closed.clone(),
            shutdown_receiver,
            stopped_sender,
        ));
        Self {
            commands,
            events,
            closed,
            shutdown,
            stopped,
        }
    }
    pub async fn close(&self) {
        let _ = self.shutdown.send(true);
        self.wait_closed().await;
    }
    /// Select this alongside event reception: the broadcast sender is retained
    /// by client clones so transport closure is observed through this signal.
    pub async fn wait_closed(&self) {
        let mut stopped = self.stopped.clone();
        let _ = stopped.wait_for(|stopped| *stopped).await;
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    /// A lagged receiver must load the official snapshot/history. The broadcast
    /// error is deliberate: dropped events must never look like a complete feed.
    pub fn subscribe(&self) -> broadcast::Receiver<Envelope> {
        self.events.subscribe()
    }
    /// Convenience for reads only. Mutation callers must supply an operation ID
    /// and explicit semantics through `call_with_id`.
    pub async fn call(&self, method: &str, params: Value, budget: Duration) -> Result<Value> {
        self.call_with_id(
            &uuid::Uuid::new_v4().to_string(),
            method,
            params,
            CallSemantics::ReadOnly,
            budget,
        )
        .await
    }
    /// Use a stable operation ID for mutations. A duplicate is refused, including
    /// after timeout. No wire-level idempotency guarantee is inferred from the ID.
    pub async fn call_with_id(
        &self,
        request_id: &str,
        method: &str,
        params: Value,
        semantics: CallSemantics,
        budget: Duration,
    ) -> Result<Value> {
        if budget.is_zero()
            || budget > Duration::from_secs(24 * 60 * 60)
            || request_id.is_empty()
            || request_id.len() > 256
            || method.is_empty()
            || method.len() > 256
            || !params.is_object()
        {
            return Err(RemoteError::invalid("Invalid RPC request or timeout"));
        }
        let deadline = Instant::now() + budget;
        let mutation = semantics == CallSemantics::Mutation;
        let (response, receiver) = oneshot::channel();
        let command = Command {
            id: request_id.into(),
            method: method.into(),
            params,
            mutation,
            deadline,
            response,
        };
        timeout_at(deadline, self.commands.send(command))
            .await
            .map_err(|_| {
                RemoteError::new("RPC_TIMEOUT", "RPC queue deadline exceeded before dispatch")
            })?
            .map_err(|_| {
                RemoteError::new(
                    "TRANSPORT_CLOSED",
                    "Remote RPC channel closed before dispatch",
                )
            })?;
        match timeout_at(deadline, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(uncertain(
                RemoteError::new("TRANSPORT_CLOSED", "RPC connection closed"),
                mutation,
            )),
            Err(_) => Err(uncertain(
                RemoteError::new(
                    "RPC_TIMEOUT",
                    "RPC response timed out; late responses are discarded",
                ),
                mutation,
            )),
        }
    }
    /// Checks negotiated capabilities; old ApiProxy-only Hosts are rejected.
    pub async fn describe(&self, budget: Duration) -> Result<Vec<String>> {
        let value = self
            .call("harness.transport.describe", json!({}), budget)
            .await?;
        let values = value
            .get("capabilities")
            .and_then(Value::as_array)
            .filter(|v| v.len() <= 256)
            .ok_or_else(|| RemoteError::invalid("Invalid Host capability response"))?;
        let mut seen = HashSet::new();
        let mut caps = Vec::new();
        for value in values {
            let cap = value
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or_else(|| RemoteError::invalid("Invalid Host capability"))?;
            if !seen.insert(cap) {
                return Err(RemoteError::invalid("Duplicate Host capability"));
            }
            caps.push(cap.to_owned());
        }
        let v1 = seen.contains("harness.remote.v1");
        let v3 = seen.contains("harness.remote.v3");
        if v1 && v3 {
            return Err(RemoteError::invalid(
                "Host advertises conflicting Harness session formats",
            ));
        }
        if !v1 && !v3 {
            return Err(RemoteError::new(
                "FEATURE_NOT_SUPPORTED",
                "Host has no supported Harness Remote carrier",
            ));
        }
        Ok(caps)
    }
    /// Preserve the official Typert {ok,value|error} result semantics.
    /// Mutations always require an explicit caller operation ID.
    pub async fn harness_call(
        &self,
        request_id: &str,
        endpoint: &str,
        payload: Value,
        semantics: CallSemantics,
        budget: Duration,
    ) -> Result<Value> {
        let value = self
            .call_with_id(
                request_id,
                "harness.remote.call",
                json!({"endpoint":endpoint,"payload":payload}),
                semantics,
                budget,
            )
            .await?;
        match value.get("ok").and_then(Value::as_bool) {
            Some(true) => Ok(value.get("value").cloned().unwrap_or(Value::Null)),
            Some(false) => Err(RemoteError::new(
                value
                    .pointer("/error/code")
                    .and_then(Value::as_str)
                    .unwrap_or("REMOTE_FAILURE"),
                "The remote Harness operation failed",
            )),
            None => Err(uncertain(
                RemoteError::invalid("Invalid Harness Gateway result"),
                semantics == CallSemantics::Mutation,
            )),
        }
    }
}
fn uncertain(error: RemoteError, unknown: bool) -> RemoteError {
    if unknown {
        error.unknown()
    } else {
        error
    }
}
async fn run(
    mut channel: RelayChannel,
    mut commands: mpsc::Receiver<Command>,
    events: broadcast::Sender<Envelope>,
    closed: Arc<AtomicBool>,
    mut shutdown: watch::Receiver<bool>,
    stopped: watch::Sender<bool>,
) {
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut request_ids = HashSet::new();
    let mut heartbeat =
        tokio::time::interval_at(Instant::now() + channel.heartbeat, channel.heartbeat);
    let mut expiry = tokio::time::interval(Duration::from_millis(50));
    let terminal = loop {
        tokio::select! {
            _ = shutdown.changed() => break RemoteError::new("TRANSPORT_CLOSED", "RPC connection disconnected"),
            command = commands.recv() => {
                let Some(command) = command else { break RemoteError::new("TRANSPORT_CLOSED", "RPC client released"); };
                if command.response.is_closed() || command.deadline <= Instant::now() { continue; }
                let rejection = if pending.len() >= MAX_PENDING { Some(RemoteError::new("RATE_LIMITED", "Too many pending Remote RPC requests")) }
                    else if pending.contains_key(&command.id) || request_ids.contains(&command.id) { Some(RemoteError::new("REQUEST_CONFLICT", "Request ID has already been dispatched; inspect authoritative state")) }
                    else if request_ids.len() >= MAX_REQUEST_IDS_PER_CONNECTION { Some(RemoteError::new("RATE_LIMITED", "RPC request ID ledger is full; establish a fresh connection")) }
                    else { None };
                if let Some(error) = rejection { let _ = command.response.send(Err(error)); continue; }
                let mut message = Envelope::new("rpc.request", json!({"method":command.method,"params":command.params}));
                message.id = command.id.clone();
                // Validate locally before marking dispatch uncertainty.
                if let Err(error) = message.encode(super::protocol::MAX_MESSAGE_BYTES) { let _ = command.response.send(Err(error)); continue; }
                request_ids.insert(command.id.clone());
                let sent = tokio::select! {
                    result = timeout_at(command.deadline, channel.send(&message)) => result,
                    _ = shutdown.changed() => Ok(Err(RemoteError::new("TRANSPORT_CLOSED", "Disconnected while sending RPC"))),
                };
                match sent {
                    Ok(Ok(())) => { pending.insert(command.id, Pending { response: command.response, mutation: command.mutation, deadline: command.deadline }); },
                    failure => {
                        let error = match failure { Ok(Err(error)) => error, _ => RemoteError::new("RPC_TIMEOUT", "RPC transport write timed out") };
                        let _ = command.response.send(Err(uncertain(error.clone(), command.mutation)));
                        break error;
                    }
                }
            }
            message = channel.receive() => {
                match message {
                    Err(error) => break error,
                    Ok(message) => match message.kind.as_str() {
                        "rpc.response" | "rpc.error" => {
                            let request = match message.string("requestId") { Ok(value) => value, Err(error) => break error };
                            let Some(call) = pending.remove(request) else { continue; };
                            if call.deadline <= Instant::now() || call.response.is_closed() { continue; }
                            let result = if message.kind == "rpc.error" {
                                message.string("code").map(|code| Err(RemoteError::new(code, "Remote RPC rejected the request")))
                            } else {
                                message.payload.get("result").cloned().map(Ok).ok_or_else(|| RemoteError::invalid("Missing RPC result"))
                            };
                            match result {
                                Ok(result) => { let _ = call.response.send(result); },
                                Err(error) => { let _ = call.response.send(Err(uncertain(error.clone(), call.mutation))); break error; }
                            }
                        }
                        "event" => { let _ = events.send(message); },
                        _ => break RemoteError::invalid("Unexpected inbound RPC request"),
                    }
                }
            }
            _ = heartbeat.tick() => {
                match timeout(Duration::from_secs(10), channel.heartbeat()).await {
                    Ok(Ok(())) => {},
                    Ok(Err(error)) => break error,
                    Err(_) => break RemoteError::new("CONNECTION_FAILED", "Heartbeat write timed out"),
                }
            }
            _ = expiry.tick() => {
                let now = Instant::now();
                let expired: Vec<_> = pending.iter().filter(|(_, call)| call.deadline <= now || call.response.is_closed()).map(|(id, _)| id.clone()).collect();
                for id in expired { if let Some(call) = pending.remove(&id) { let _ = call.response.send(Err(uncertain(RemoteError::new("RPC_TIMEOUT", "RPC response deadline exceeded"), call.mutation))); } }
            }
        }
    };
    closed.store(true, Ordering::Release);
    for (_, call) in pending {
        let _ = call
            .response
            .send(Err(uncertain(terminal.clone(), call.mutation)));
    }
    // Dropping the receiver fails queued requests before dispatch. Bound close so
    // a stalled socket never retains the Rust owner after all windows leave.
    let _ = timeout(Duration::from_secs(2), channel.close()).await;
    let _ = stopped.send(true);
}
