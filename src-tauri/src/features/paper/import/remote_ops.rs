//! Dependency inversion for the remote import bridge.
//!
//! Import commands branch on `remote:<sessionId>` vault handles but must not
//! import `integration::remote` (features may only depend on core). The remote
//! side (`integration::remote::import_bridge`) implements [`RemoteImportOps`]
//! for `RemoteRegistry`, and the desktop app registers it as Tauri state
//! (`Arc<dyn RemoteImportOps>`).

use crate::core::error::AppError;
use crate::features::paper::import::{
    ImportLocalPdfArgs, ImportLocalPdfResult, LookupImportBatchArgs, LookupImportBatchResult,
    NoteShellMode, PaperImportArgs, PaperImportResult,
};
use async_trait::async_trait;

/// Remote-vault import operations. `session_id` is the parsed `remote:<id>`
/// handle; the implementation resolves the active session, stages work in its
/// local work root, and pushes files + catalog over the remote filesystem.
#[async_trait]
pub trait RemoteImportOps: Send + Sync {
    /// Batch resolve identifiers and write papers into the remote vault.
    async fn import_by_identifier_batch_remote(
        &self,
        session_id: &str,
        args: LookupImportBatchArgs,
        note_mode: NoteShellMode,
    ) -> Result<LookupImportBatchResult, AppError>;
    /// Import local PDF file(s) into the remote vault.
    async fn import_local_pdfs_remote(
        &self,
        session_id: &str,
        args: ImportLocalPdfArgs,
        note_mode: NoteShellMode,
    ) -> Result<ImportLocalPdfResult, AppError>;
    /// Import BibTeX/RIS/… catalog entries into the remote vault.
    async fn import_catalog_remote(
        &self,
        session_id: &str,
        args: PaperImportArgs,
        note_mode: NoteShellMode,
    ) -> Result<PaperImportResult, AppError>;
}

/// Mobile imports are local. Satisfy the command's dependency without creating
/// an SSH registry or permitting a remote Vault handle to fall through locally.
#[cfg(mobile)]
pub struct LocalOnlyImports;

#[cfg(mobile)]
#[async_trait]
impl RemoteImportOps for LocalOnlyImports {
    async fn import_by_identifier_batch_remote(
        &self,
        _session_id: &str,
        _args: LookupImportBatchArgs,
        _note_mode: NoteShellMode,
    ) -> Result<LookupImportBatchResult, AppError> {
        Err(AppError::message(
            "SSH Vault imports are unavailable on mobile",
        ))
    }

    async fn import_local_pdfs_remote(
        &self,
        _session_id: &str,
        _args: ImportLocalPdfArgs,
        _note_mode: NoteShellMode,
    ) -> Result<ImportLocalPdfResult, AppError> {
        Err(AppError::message(
            "SSH Vault imports are unavailable on mobile",
        ))
    }

    async fn import_catalog_remote(
        &self,
        _session_id: &str,
        _args: PaperImportArgs,
        _note_mode: NoteShellMode,
    ) -> Result<PaperImportResult, AppError> {
        Err(AppError::message(
            "SSH Vault imports are unavailable on mobile",
        ))
    }
}
