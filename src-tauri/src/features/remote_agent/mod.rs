//! Provider-neutral remote Agent contracts and process-owned service.
//!
//! Integration adapters implement [`RemoteAgentProvider`] and are registered by
//! the application. The default provider ID is a preference, not an installed
//! transport: a new service has no providers or connections.

mod journal;
mod provider;
mod service;
mod types;

pub use journal::{
    journal_outcome, journal_unavailable, merge_journal_update, unknown_outcome, JournalEntry,
    JournalReservation, MemoryOperationJournal, OperationContext, OperationJournal,
    JOURNAL_VERSION,
};
pub use provider::{RemoteAgentProvider, RemoteAgentSubscription};
pub use service::{RecoveredSession, RemoteAgentService, SessionSubscription};
pub use types::*;

#[cfg(test)]
mod tests;
