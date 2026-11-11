//! Rust-owned DSH Remote v1 client (relay transport only).
//!
//! Protocol port from liguobao/ds-harness-remote at 11064af (MIT), see
//! THIRD_PARTY_LICENSES.md. Credentials and pinned keys must be persisted by the
//! caller using the platform credential store; this module never writes secrets.

pub mod api;
pub mod crypto;
mod gateway;
mod native;
mod native_model;
pub mod protocol;
pub mod provider;
pub mod relay;
pub mod rpc;

use std::fmt;

/// A transport error never implies permission to replay a mutation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteError {
    pub code: String,
    pub message: String,
    /// The request may have reached the peer. Inspect authoritative state.
    pub outcome_unknown: bool,
}

impl RemoteError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            outcome_unknown: false,
        }
    }
    pub(crate) fn unknown(mut self) -> Self {
        self.outcome_unknown = true;
        self
    }
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_MESSAGE", message)
    }
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for RemoteError {}
pub type Result<T> = std::result::Result<T, RemoteError>;

#[cfg(test)]
mod tests;
