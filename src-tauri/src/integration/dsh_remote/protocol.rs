//! DSH Remote v1 envelope and secure fragment codec, ported from upstream MIT.
use super::{RemoteError, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_CONTROL_BYTES: usize = 64 * 1024;
pub const MAX_RELAY_BYTES: usize = 1024 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 48 * 1024;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub fn decode_base64(value: &str) -> Result<Vec<u8>> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| RemoteError::invalid("Invalid Base64URL data"))?;
    if URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(RemoteError::invalid("Noncanonical Base64URL data"));
    }
    Ok(bytes)
}
pub fn encode_base64(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(value)
}
pub fn key(value: &str) -> Result<[u8; 32]> {
    decode_base64(value)?
        .try_into()
        .map_err(|_| RemoteError::invalid("Expected a 32-byte X25519 key"))
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(MAX_SAFE_INTEGER as u128) as u64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub v: u32,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub timestamp: u64,
    pub payload: Value,
}
impl Envelope {
    pub fn new(kind: &str, payload: Value) -> Self {
        Self {
            v: 1,
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            timestamp: now_ms(),
            payload,
        }
    }
    pub fn encode(&self, limit: usize) -> Result<Vec<u8>> {
        let bytes = serde_json::to_vec(self)
            .map_err(|_| RemoteError::invalid("Cannot encode Remote message"))?;
        if bytes.len() > limit {
            return Err(RemoteError::new(
                "FRAME_TOO_LARGE",
                "Remote frame exceeds the negotiated limit",
            ));
        }
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8], limit: usize) -> Result<Self> {
        if bytes.len() > limit {
            return Err(RemoteError::new(
                "FRAME_TOO_LARGE",
                "Remote frame exceeds the negotiated limit",
            ));
        }
        let value = strict_json(bytes)?;
        let envelope: Self = serde_json::from_value(value)
            .map_err(|_| RemoteError::invalid("Invalid Remote envelope"))?;
        if envelope.v != 1 {
            return Err(RemoteError::new(
                "UNSUPPORTED_VERSION",
                "Unsupported Remote protocol version",
            ));
        }
        if envelope.id.is_empty()
            || envelope.id.len() > 256
            || envelope.timestamp > MAX_SAFE_INTEGER
            || !envelope.payload.is_object()
        {
            return Err(RemoteError::invalid("Invalid Remote envelope fields"));
        }
        if !matches!(
            envelope.kind.as_str(),
            "hello"
                | "hello.ack"
                | "connect.request"
                | "connect.incoming"
                | "connect.accepted"
                | "connect.rejected"
                | "secure.handshake"
                | "relay"
                | "signal.offer"
                | "signal.answer"
                | "signal.ice"
                | "transport.selected"
                | "connection.lease.request"
                | "connection.lease.ack"
                | "connection.lease.close"
                | "ping"
                | "pong"
                | "error"
                | "rpc.request"
                | "rpc.response"
                | "rpc.error"
                | "event"
        ) {
            return Err(RemoteError::invalid("Unknown Remote frame type"));
        }
        if envelope.kind == "relay" || envelope.kind == "secure.handshake" {
            envelope.string("connectionId")?;
            envelope.string("targetDeviceId")?;
            if envelope.kind == "relay" {
                envelope.integer("counter")?;
                decode_base64(envelope.string("ciphertext")?)?;
            } else {
                if !matches!(envelope.integer("step")?, 1 | 2) {
                    return Err(RemoteError::invalid("Invalid handshake step"));
                }
                decode_base64(envelope.string("data")?)?;
            }
        }
        Ok(envelope)
    }
    pub fn string(&self, field: &str) -> Result<&str> {
        self.payload
            .get(field)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| RemoteError::invalid(format!("Missing or invalid {field}")))
    }
    pub fn integer(&self, field: &str) -> Result<u64> {
        self.payload
            .get(field)
            .and_then(Value::as_u64)
            .filter(|n| *n <= MAX_SAFE_INTEGER)
            .ok_or_else(|| RemoteError::invalid(format!("Missing or invalid {field}")))
    }
}

/// Reject duplicate object keys (including escaped aliases) at every nesting level.
pub fn strict_json(bytes: &[u8]) -> Result<Value> {
    struct Unique(Value);
    impl<'de> Deserialize<'de> for Unique {
        fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Unique;
                fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                    f.write_str("JSON without duplicate keys")
                }
                fn visit_map<M: MapAccess<'de>>(
                    self,
                    mut m: M,
                ) -> std::result::Result<Unique, M::Error> {
                    let mut out = Map::new();
                    while let Some(k) = m.next_key::<String>()? {
                        if out.contains_key(&k) {
                            return Err(de::Error::custom("duplicate JSON key"));
                        }
                        out.insert(k, m.next_value::<Unique>()?.0);
                    }
                    Ok(Unique(Value::Object(out)))
                }
                fn visit_seq<S: SeqAccess<'de>>(
                    self,
                    mut s: S,
                ) -> std::result::Result<Unique, S::Error> {
                    let mut out = Vec::new();
                    while let Some(v) = s.next_element::<Unique>()? {
                        out.push(v.0);
                    }
                    Ok(Unique(Value::Array(out)))
                }
                fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::Bool(v)))
                }
                fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::String(v.into())))
                }
                fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::String(v)))
                }
                fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::Number(v.into())))
                }
                fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::Number(v.into())))
                }
                fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Unique, E> {
                    serde_json::Number::from_f64(v)
                        .map(|n| Unique(Value::Number(n)))
                        .ok_or_else(|| E::custom("invalid number"))
                }
                fn visit_unit<E: de::Error>(self) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::Null))
                }
            }
            d.deserialize_any(V)
        }
    }
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let result = Unique::deserialize(&mut d)
        .map_err(|_| RemoteError::invalid("Invalid or ambiguous JSON"))?;
    d.end()
        .map_err(|_| RemoteError::invalid("Trailing JSON data"))?;
    Ok(result.0)
}

#[derive(Default)]
pub struct SecureCodec {
    next_id: u32,
    assemblies: HashMap<u32, Assembly>,
}
struct Assembly {
    total: usize,
    bytes: usize,
    next: usize,
    data: Vec<u8>,
}
impl SecureCodec {
    pub fn encode(&mut self, message: &[u8]) -> Result<Vec<Vec<u8>>> {
        if message.len() > MAX_MESSAGE_BYTES {
            return Err(RemoteError::new(
                "FRAME_TOO_LARGE",
                "Secure message exceeds 4 MiB",
            ));
        }
        if message.len() <= CHUNK_BYTES {
            return Ok(vec![message.to_vec()]);
        }
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let total = message.len().div_ceil(CHUNK_BYTES);
        Ok(message
            .chunks(CHUNK_BYTES)
            .enumerate()
            .map(|(index, chunk)| {
                let mut frame = Vec::with_capacity(17 + chunk.len());
                frame.extend_from_slice(b"DSHF\x01");
                frame.extend_from_slice(&self.next_id.to_be_bytes());
                frame.extend_from_slice(&(index as u16).to_be_bytes());
                frame.extend_from_slice(&(total as u16).to_be_bytes());
                frame.extend_from_slice(&(message.len() as u32).to_be_bytes());
                frame.extend_from_slice(chunk);
                frame
            })
            .collect())
    }
    pub fn decode(&mut self, frame: &[u8]) -> Result<Option<Vec<u8>>> {
        if !frame.starts_with(b"DSHF") {
            if frame.len() > CHUNK_BYTES {
                return Err(RemoteError::invalid("Oversized unfragmented plaintext"));
            }
            return Ok(Some(frame.to_vec()));
        }
        if frame.len() < 17 || frame[4] != 1 {
            return Err(RemoteError::invalid("Invalid secure fragment header"));
        }
        let id = u32::from_be_bytes(frame[5..9].try_into().unwrap());
        let index = u16::from_be_bytes(frame[9..11].try_into().unwrap()) as usize;
        let total = u16::from_be_bytes(frame[11..13].try_into().unwrap()) as usize;
        let bytes = u32::from_be_bytes(frame[13..17].try_into().unwrap()) as usize;
        if id == 0
            || total < 2
            || index >= total
            || bytes <= CHUNK_BYTES
            || bytes > MAX_MESSAGE_BYTES
            || total != bytes.div_ceil(CHUNK_BYTES)
        {
            return Err(RemoteError::invalid("Invalid secure fragment metadata"));
        }
        if frame.len() - 17 != CHUNK_BYTES.min(bytes - index * CHUNK_BYTES) {
            return Err(RemoteError::invalid("Invalid secure fragment length"));
        }
        if !self.assemblies.contains_key(&id) {
            if index != 0 || self.assemblies.len() >= 8 {
                return Err(RemoteError::invalid("Invalid secure fragment sequence"));
            }
            self.assemblies.insert(
                id,
                Assembly {
                    total,
                    bytes,
                    next: 0,
                    data: Vec::new(),
                },
            );
        }
        let assembly = self.assemblies.get_mut(&id).unwrap();
        if assembly.total != total || assembly.bytes != bytes || assembly.next != index {
            return Err(RemoteError::invalid("Duplicate or out-of-order fragment"));
        }
        assembly.data.extend_from_slice(&frame[17..]);
        assembly.next += 1;
        if assembly.next == total {
            return Ok(Some(self.assemblies.remove(&id).unwrap().data));
        }
        Ok(None)
    }
}
