//! Bounded, guarded ink sidecar IO. Cooperating editors and sync share the file
//! mutation lane; external processes are not an OS-level compare-and-swap.

use super::ink::{InkPage, InkPoint, InkRevision, InkStroke, InkTombstone, InkTool};
use crate::error::AppError;
use crate::fs::{atomic_write_with, with_file_mutation, AtomicOpts};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const MAX_INK_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_INK_POINTS: usize = 100_000;
pub const MAX_STROKE_POINTS: usize = 20_000;
pub const MAX_INK_RECORDS: usize = 10_000;
pub const MAX_INK_OPERATIONS: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkPageSnapshot {
    pub document: InkPage,
    /// SHA-256 of the exact bytes read, or null only when the file is absent.
    pub revision: Option<String>,
    /// Opaque decimal creation metadata for undo, avoiding JS u64 roundtrips.
    pub creation_times: BTreeMap<String, String>,
    pub update_times: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkDraftPoint {
    pub x: f64,
    pub y: f64,
    pub pressure: Option<f64>,
    pub elapsed_ms: Option<u32>,
    pub tilt: Option<[f64; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkStrokeDraft {
    pub id: Uuid,
    pub tool: InkTool,
    pub color: [u8; 4],
    pub base_width: f64,
    pub points: Vec<InkDraftPoint>,
    #[serde(default)]
    pub created_at_ms: Option<String>,
    #[serde(default)]
    pub updated_at_ms: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum InkEdit {
    Put { stroke: InkStrokeDraft },
    Delete { id: Uuid },
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::domain("ink_invalid", message)
}

fn conflict() -> AppError {
    AppError::domain(
        "ink_conflict",
        "Ink changed on disk; reload before applying this draft",
    )
}

fn ink_error(error: super::ink::InkError) -> AppError {
    invalid(error.to_string())
}

fn draft_time(value: Option<&str>) -> Result<Option<u64>, AppError> {
    value
        .map(|value| {
            value
                .parse::<u64>()
                .ok()
                .filter(|v| v.to_string() == value)
                .ok_or_else(|| invalid("invalid ink timestamp metadata"))
        })
        .transpose()
}

/// Only canonical `papers/<single-folder>` relative paths are accepted. The
/// canonical root may be reached through an alias, but no child symlink is used.
pub fn page_path(vault: &Path, paper_folder: &str, page: u32) -> Result<PathBuf, AppError> {
    let folder = paper_folder
        .strip_prefix("papers/")
        .ok_or_else(|| invalid("invalid paper folder"))?;
    if folder.is_empty()
        || folder.len() > 180
        || folder == "."
        || folder == ".."
        || folder.ends_with(['.', ' '])
        || folder
            .chars()
            .any(|c| c.is_control() || "/\\:<>\"|?*".contains(c))
        || !(1..=100_000).contains(&page)
    {
        return Err(invalid("invalid paper folder or page"));
    }
    let root = fs::canonicalize(vault)?;
    if !root.is_dir() {
        return Err(invalid("invalid Vault directory"));
    }
    let paper = root.join("papers").join(folder);
    for directory in [root.join("papers"), paper.clone()] {
        let metadata = fs::symlink_metadata(&directory)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid("ink requires an unlinked paper directory"));
        }
    }
    let target = paper
        .join("marks")
        .join("ink")
        .join(format!("p{page}.json"));
    check_children(&paper, &target)?;
    Ok(target)
}

fn check_children(paper: &Path, target: &Path) -> Result<(), AppError> {
    let mut path = paper.to_path_buf();
    for component in target
        .strip_prefix(paper)
        .map_err(|_| invalid("ink path escapes paper"))?
        .components()
    {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(invalid("linked ink path")),
            Ok(meta) if path != target && !meta.is_dir() => {
                return Err(invalid("invalid ink directory"))
            }
            Ok(meta) if path == target && !meta.is_file() => {
                return Err(invalid("invalid ink file"))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if file.metadata()?.len() > MAX_INK_BYTES as u64 {
        return Err(invalid("ink file too large"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_INK_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_INK_BYTES {
        return Err(invalid("ink file too large"));
    }
    Ok(Some(bytes))
}

fn bounded(document: &InkPage) -> Result<(), AppError> {
    let mut points = 0usize;
    if document
        .strokes
        .len()
        .saturating_add(document.tombstones.len())
        > MAX_INK_RECORDS
    {
        return Err(invalid("too many ink records"));
    }
    for stroke in &document.strokes {
        points = points.saturating_add(stroke.points.len());
        if stroke.points.len() > MAX_STROKE_POINTS
            || points > MAX_INK_POINTS
            || stroke.base_width > 1000.0
            || stroke
                .points
                .iter()
                .any(|p| p.x.abs() > 10_000_000.0 || p.y.abs() > 10_000_000.0)
        {
            return Err(invalid("ink geometry exceeds limits"));
        }
    }
    document.validate().map_err(ink_error)
}

fn snapshot(document: InkPage, bytes: Option<&[u8]>) -> InkPageSnapshot {
    InkPageSnapshot {
        creation_times: document
            .strokes
            .iter()
            .map(|s| (s.id.to_string(), s.created_at_ms.to_string()))
            .collect(),
        update_times: document
            .strokes
            .iter()
            .map(|s| (s.id.to_string(), s.updated_at_ms.to_string()))
            .collect(),
        document,
        revision: bytes.map(|raw| hex::encode(Sha256::digest(raw))),
    }
}

fn read_locked(path: &Path, page: u32) -> Result<InkPageSnapshot, AppError> {
    let bytes = read_bytes(path)?;
    let document = match bytes.as_deref() {
        Some(raw) => {
            let parsed: InkPage =
                serde_json::from_slice(raw).map_err(|e| invalid(e.to_string()))?;
            bounded(&parsed)?;
            if parsed.page != page {
                return Err(invalid("ink page mismatch"));
            }
            parsed.merge(&parsed).map_err(ink_error)?
        }
        None => InkPage::new(page).map_err(ink_error)?,
    };
    Ok(snapshot(document, bytes.as_deref()))
}

pub fn read_page(vault: &Path, paper_folder: &str, page: u32) -> Result<InkPageSnapshot, AppError> {
    with_file_mutation(|| {
        let path = page_path(vault, paper_folder, page)?;
        let result = read_locked(&path, page)?;
        page_path(vault, paper_folder, page)?;
        Ok(result)
    })
}

/// Assign revisions strictly above every counter observed in this page. Never
/// accepts renderer revisions. The exact baseline is mandatory, including null.
pub fn apply_drafts(
    vault: &Path,
    paper_folder: &str,
    page: u32,
    expected_revision: Option<&str>,
    actor: Uuid,
    now_ms: u64,
    operations: &[InkEdit],
) -> Result<InkPageSnapshot, AppError> {
    apply_drafts_checked(
        vault,
        paper_folder,
        page,
        expected_revision,
        actor,
        now_ms,
        operations,
        || Ok(()),
    )
}

/// The short admission callback can reject a cancelled operation immediately
/// before atomic publication. Once admitted, the synchronous atomic write runs
/// to completion; a lost IPC response must be reconciled by rereading.
#[allow(clippy::too_many_arguments)]
pub fn apply_drafts_checked(
    vault: &Path,
    paper_folder: &str,
    page: u32,
    expected_revision: Option<&str>,
    actor: Uuid,
    now_ms: u64,
    operations: &[InkEdit],
    admit: impl FnOnce() -> Result<(), AppError>,
) -> Result<InkPageSnapshot, AppError> {
    if actor.is_nil()
        || operations.is_empty()
        || operations.len() > MAX_INK_OPERATIONS
        || expected_revision.is_some_and(|v| {
            v.len() != 64
                || !v
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
    {
        return Err(invalid("invalid ink edit batch"));
    }
    let mut draft_points = 0usize;
    for operation in operations {
        if let InkEdit::Put { stroke } = operation {
            draft_points = draft_points.saturating_add(stroke.points.len());
            if stroke.points.len() > MAX_STROKE_POINTS || draft_points > MAX_INK_POINTS {
                return Err(invalid("ink draft exceeds point limits"));
            }
        }
    }
    with_file_mutation(|| {
        let path = page_path(vault, paper_folder, page)?;
        let current = read_locked(&path, page)?;
        if current.revision.as_deref() != expected_revision {
            return Err(conflict());
        }
        let mut document = current.document;
        let mut creation_times: BTreeMap<Uuid, u64> = document
            .strokes
            .iter()
            .map(|s| (s.id, s.created_at_ms))
            .collect();
        let mut counter = document
            .strokes
            .iter()
            .map(|s| s.revision.counter)
            .chain(document.tombstones.iter().map(|s| s.revision.counter))
            .max()
            .unwrap_or(0);
        for operation in operations {
            counter = counter
                .checked_add(1)
                .ok_or_else(|| invalid("ink revision exhausted"))?;
            let revision = InkRevision { counter, actor };
            match operation {
                InkEdit::Put { stroke } => {
                    let requested_creation = draft_time(stroke.created_at_ms.as_deref())?;
                    let requested_update = draft_time(stroke.updated_at_ms.as_deref())?;
                    let creation = creation_times
                        .get(&stroke.id)
                        .copied()
                        .or(requested_creation)
                        .unwrap_or(now_ms);
                    let previous_update = document
                        .strokes
                        .iter()
                        .find(|s| s.id == stroke.id)
                        .map_or(creation, |s| s.updated_at_ms)
                        .max(requested_update.unwrap_or(0));
                    let next = InkStroke {
                        id: stroke.id,
                        page,
                        revision,
                        tool: stroke.tool,
                        color: stroke.color,
                        base_width: stroke.base_width,
                        points: stroke
                            .points
                            .iter()
                            .map(|p| InkPoint {
                                x: p.x,
                                y: p.y,
                                pressure: p.pressure,
                                elapsed_ms: p.elapsed_ms.map(u64::from),
                                tilt: p.tilt,
                            })
                            .collect(),
                        created_at_ms: creation,
                        updated_at_ms: now_ms.max(creation).max(previous_update),
                    };
                    next.validate().map_err(ink_error)?;
                    creation_times.insert(stroke.id, creation);
                    document.strokes.retain(|s| s.id != stroke.id);
                    document.tombstones.retain(|s| s.id != stroke.id);
                    document.strokes.push(next);
                }
                InkEdit::Delete { id } => {
                    if id.is_nil() {
                        return Err(invalid("invalid ink ID"));
                    }
                    document.strokes.retain(|s| s.id != *id);
                    document.tombstones.retain(|s| s.id != *id);
                    document.tombstones.push(InkTombstone {
                        id: *id,
                        revision,
                        deleted_at_ms: now_ms,
                    });
                }
            }
        }
        bounded(&document)?;
        let document = document.merge(&document).map_err(ink_error)?;
        let bytes = document.to_json().map_err(ink_error)?.into_bytes();
        if bytes.len() > MAX_INK_BYTES {
            return Err(invalid("ink file too large"));
        }
        for directory in [path.parent().and_then(Path::parent), path.parent()]
            .into_iter()
            .flatten()
        {
            match fs::create_dir(directory) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
            page_path(vault, paper_folder, page)?;
        }
        // Revalidate immediately before publication; in-process sync cannot pass
        // the mutation lane, and external changes observed here cause conflict.
        page_path(vault, paper_folder, page)?;
        if read_bytes(&path)?
            .as_deref()
            .map(|b| hex::encode(Sha256::digest(b)))
            .as_deref()
            != expected_revision
        {
            return Err(conflict());
        }
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.permissions().readonly() => {
                return Err(AppError::domain("ink_protected", "Ink file is read-only"));
            }
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
                return Err(invalid("invalid ink file"));
            }
            Ok(_) => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound && expected_revision.is_none() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(conflict()),
            Err(error) => return Err(error.into()),
        }
        admit()?;
        publish_ink_file(&path, &bytes, sync_ink_directories)?;
        Ok(snapshot(document, Some(&bytes)))
    })
}

// Sync only the bounded ink hierarchy: file entry in ink/, ink/ in marks/,
// and marks/ in the already-existing paper directory. No ancestor walk to root.
fn sync_ink_directories(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    for directory in path.ancestors().skip(1).take(3) {
        fs::File::open(directory)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn publish_ink_file(
    path: &Path,
    bytes: &[u8],
    sync_directories: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), AppError> {
    atomic_write_with(
        path,
        bytes,
        &AtomicOpts {
            sync_file: true,
            ..Default::default()
        },
    )?;
    // Rename has already succeeded. Never roll back or describe this error as
    // an unchanged original: the same IDs/payload must be reread and reconciled.
    sync_directories(path).map_err(|_| AppError::domain(
        "ink_unavailable",
        "Ink save may already be visible; retain the draft IDs and reload to reconcile before retrying",
    ))
}

#[cfg(test)]
#[path = "ink_store_tests.rs"]
mod tests;
