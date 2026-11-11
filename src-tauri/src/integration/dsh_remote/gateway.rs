//! Official Typert unary/stream carrier, traced to remote-gateway.ts at 11064af.
use super::{
    protocol::Envelope,
    rpc::{CallSemantics, RpcClient},
    RemoteError, Result,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::{sync::broadcast, time::timeout};

pub(crate) const RPC_BUDGET: Duration = Duration::from_secs(30);

#[async_trait]
pub(crate) trait WireRpc: Send + Sync {
    async fn request(
        &self,
        id: &str,
        method: &str,
        params: Value,
        semantics: CallSemantics,
        budget: Duration,
    ) -> Result<Value>;
    fn events(&self) -> broadcast::Receiver<Envelope>;
    async fn closed(&self);
    fn is_closed(&self) -> bool;
}
#[async_trait]
impl WireRpc for RpcClient {
    async fn request(
        &self,
        id: &str,
        method: &str,
        params: Value,
        semantics: CallSemantics,
        budget: Duration,
    ) -> Result<Value> {
        self.call_with_id(id, method, params, semantics, budget)
            .await
    }
    fn events(&self) -> broadcast::Receiver<Envelope> {
        self.subscribe()
    }
    async fn closed(&self) {
        self.wait_closed().await
    }
    fn is_closed(&self) -> bool {
        self.is_closed()
    }
}

pub(crate) fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub(crate) fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| RemoteError::invalid(format!("Invalid native {field}")))
}
pub(crate) fn integer(value: &Value, field: &str) -> Result<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .filter(|v| *v <= super::protocol::MAX_SAFE_INTEGER)
        .ok_or_else(|| RemoteError::invalid(format!("Invalid native {field}")))
}
pub(crate) fn unwrap_result(value: Value, mutation: bool) -> Result<Value> {
    match value.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(value.get("value").cloned().unwrap_or(Value::Null)),
        Some(false)
            if value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .is_some() =>
        {
            Err(RemoteError::new(
                value["error"]["code"].as_str().unwrap(),
                "The native Harness operation was rejected",
            ))
        }
        _ => Err(if mutation {
            RemoteError::invalid("Malformed native Gateway result").unknown()
        } else {
            RemoteError::invalid("Malformed native Gateway result")
        }),
    }
}
pub(crate) async fn call(
    wire: &Arc<dyn WireRpc>,
    request_id: &str,
    endpoint: &str,
    args: Value,
    semantics: CallSemantics,
) -> Result<Value> {
    let mutation = semantics == CallSemantics::Mutation;
    let result = wire
        .request(
            request_id,
            "harness.remote.call",
            json!({"endpoint":endpoint,"payload":{"args":args}}),
            semantics,
            RPC_BUDGET,
        )
        .await?;
    let value = unwrap_result(result, mutation)?;
    // Official namespace methods may themselves return a business RpcResult.
    if value.get("ok").and_then(Value::as_bool).is_some() {
        unwrap_result(value, mutation)
    } else {
        Ok(value)
    }
}

pub(crate) struct GatewayStream {
    wire: Arc<dyn WireRpc>,
    pub id: String,
    events: broadcast::Receiver<Envelope>,
    closed: bool,
}
impl GatewayStream {
    pub async fn open(wire: Arc<dyn WireRpc>, endpoint: &str, args: Value) -> Result<Self> {
        let stream_id = id();
        let events = wire.events(); // Subscribe before open: first frame may precede its response.
        let mut stream = Self {
            wire,
            id: stream_id,
            events,
            closed: false,
        };
        let opened = stream
            .wire
            .request(
                &id(),
                "harness.remote.stream.open",
                json!({"streamId":stream.id,"endpoint":endpoint,"payload":{"args":args}}),
                CallSemantics::ReadOnly,
                RPC_BUDGET,
            )
            .await;
        if let Err(error) = opened {
            let _ = stream.close().await;
            return Err(error);
        }
        Ok(stream)
    }
    pub async fn first(&mut self) -> Result<Value> {
        timeout(Duration::from_secs(60), self.next())
            .await
            .map_err(|_| RemoteError::new("RPC_TIMEOUT", "Native stream baseline timed out"))??
            .ok_or_else(|| {
                RemoteError::new(
                    "TRANSPORT_CLOSED",
                    "Native stream ended before its baseline",
                )
            })
    }
    pub async fn next(&mut self) -> Result<Option<Value>> {
        if self.closed {
            return Ok(None);
        }
        loop {
            let frame = tokio::select! {
                _ = self.wire.closed() => return Err(RemoteError::new("TRANSPORT_CLOSED", "Native stream transport closed")),
                event = self.events.recv() => event.map_err(|_| RemoteError::new("FULL_RESYNC_REQUIRED", "Native stream events were lost; load an official snapshot"))?,
            };
            let payload = &frame.payload;
            if payload.pointer("/data/streamId").and_then(Value::as_str) != Some(self.id.as_str()) {
                continue;
            }
            match payload.get("event").and_then(Value::as_str) {
                Some("harness.remote.frame") => {
                    if payload.pointer("/data/hasValue").and_then(Value::as_bool) != Some(true) {
                        return Err(RemoteError::invalid("Malformed native stream frame"));
                    }
                    return payload
                        .pointer("/data/value")
                        .cloned()
                        .map(Some)
                        .ok_or_else(|| RemoteError::invalid("Missing native stream value"));
                }
                Some("harness.remote.stream.closed") => {
                    self.closed = true;
                    if payload.pointer("/data/reason").and_then(Value::as_str) == Some("failed") {
                        return Err(RemoteError::new(
                            payload
                                .pointer("/data/failure/code")
                                .and_then(Value::as_str)
                                .unwrap_or("REMOTE_FAILURE"),
                            "Native stream failed",
                        ));
                    }
                    return Ok(None);
                }
                _ => return Err(RemoteError::invalid("Unexpected native stream event")),
            }
        }
    }
    pub async fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.wire
            .request(
                &id(),
                "harness.remote.stream.close",
                json!({"streamId":self.id}),
                CallSemantics::ReadOnly,
                Duration::from_secs(5),
            )
            .await
            .map(|_| ())
    }
}
impl Drop for GatewayStream {
    fn drop(&mut self) {
        if self.closed || self.wire.is_closed() {
            return;
        }
        self.closed = true;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let wire = self.wire.clone();
            let stream_id = self.id.clone();
            runtime.spawn(async move {
                let _ = wire
                    .request(
                        &id(),
                        "harness.remote.stream.close",
                        json!({"streamId":stream_id}),
                        CallSemantics::ReadOnly,
                        Duration::from_secs(5),
                    )
                    .await;
            });
        }
    }
}
