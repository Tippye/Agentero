//! Per-window reading routes. Vault strings are opaque namespace inputs, never
//! filesystem authority. Cooperating saves use the shared file-mutation mutex;
//! external processes do not participate in this in-process CAS contract.
pub mod commands;

use crate::core::error::AppError;
use crate::core::fs::{atomic_write_with, with_file_mutation, AtomicOpts};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_FILE: usize = 16 * 1024;
const MAX_VAULT: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MobileRouteTab {
    Library,
    Agent,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MobileReaderMode {
    Pdf,
    Notes,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MobileRoutePreset {
    Read,
    Compare,
    Discuss,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobilePdfPosition {
    pub page: u32,
    pub zoom: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileWindowRoute {
    pub paper_id: Option<String>,
    pub tab: MobileRouteTab,
    pub reader_mode: MobileReaderMode,
    pub preset: MobileRoutePreset,
    pub pdf: Option<MobilePdfPosition>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileRouteSnapshot {
    pub revision: String,
    pub route: Option<MobileWindowRoute>,
}

fn invalid() -> AppError {
    AppError::domain("mobile_route_invalid", "Invalid reading route or revision")
}
fn corrupt() -> AppError {
    AppError::domain(
        "mobile_route_corrupt",
        "Stored reading route is invalid and was not overwritten",
    )
}
fn unavailable() -> AppError {
    AppError::domain(
        "mobile_route_unavailable",
        "Reading route storage could not be confirmed; reload before saving",
    )
}
fn revision(value: &str) -> Result<u64, AppError> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let parsed: u64 = value.parse().map_err(|_| invalid())?;
    if parsed.to_string() != value {
        return Err(invalid());
    }
    Ok(parsed)
}
fn valid_route(route: &MobileWindowRoute) -> Result<(), AppError> {
    if route.paper_id.as_ref().is_some_and(|id| {
        id.is_empty() || id.len() > 1024 || id.trim().is_empty() || id.chars().any(char::is_control)
    }) {
        return Err(invalid());
    }
    if let Some(pdf) = &route.pdf {
        if route.paper_id.is_none()
            || !(1..=1_000_000).contains(&pdf.page)
            || !pdf.zoom.is_finite()
            || !(0.1..=10.0).contains(&pdf.zoom)
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn valid_label(label: &str) -> bool {
    fn hex_suffix(label: &str, prefix: &str, length: usize) -> bool {
        label.strip_prefix(prefix).is_some_and(|tail| {
            tail.len() == length
                && tail
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    }
    label == "main" || hex_suffix(label, "doc-", 16) || hex_suffix(label, "agentero-", 32)
}

#[derive(Clone)]
pub struct MobileRouteStore {
    root: PathBuf,
}
impl MobileRouteStore {
    /// `root` is the native app-data mobile-routes directory, never an IPC path.
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    fn path(&self, label: &str, vault: &str) -> Result<PathBuf, AppError> {
        if !valid_label(label)
            || vault.is_empty()
            || vault.len() > MAX_VAULT
            || vault.trim().is_empty()
            || vault.contains('\0')
        {
            return Err(AppError::domain(
                "mobile_route_scope",
                "This window or vault scope cannot persist reading routes",
            ));
        }
        let mut hash = Sha256::new();
        hash.update(b"agentero-mobile-route\0");
        for value in [label, vault] {
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value.as_bytes());
        }
        Ok(self
            .root
            .join(format!("{}.json", hex::encode(hash.finalize()))))
    }
    fn check_root(&self) -> Result<(), AppError> {
        match fs::symlink_metadata(&self.root) {
            Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(unavailable()),
        }
    }
    fn load(&self, path: &Path) -> Result<MobileRouteSnapshot, AppError> {
        self.check_root()?;
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(MobileRouteSnapshot {
                    revision: "0".into(),
                    route: None,
                })
            }
            Ok(metadata) if metadata.file_type().is_file() && metadata.len() <= MAX_FILE as u64 => {
            }
            Ok(_) => return Err(corrupt()),
            Err(_) => return Err(unavailable()),
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|_| unavailable())?
            .take((MAX_FILE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| unavailable())?;
        if bytes.len() > MAX_FILE {
            return Err(corrupt());
        }
        let snapshot: MobileRouteSnapshot =
            serde_json::from_slice(&bytes).map_err(|_| corrupt())?;
        if revision(&snapshot.revision).map_err(|_| corrupt())? == 0 {
            return Err(corrupt());
        }
        valid_route(snapshot.route.as_ref().ok_or_else(corrupt)?).map_err(|_| corrupt())?;
        Ok(snapshot)
    }
    pub fn read(&self, label: &str, vault: &str) -> Result<MobileRouteSnapshot, AppError> {
        self.load(&self.path(label, vault)?)
    }
    pub fn save(
        &self,
        label: &str,
        vault: &str,
        expected_revision: &str,
        route: MobileWindowRoute,
    ) -> Result<MobileRouteSnapshot, AppError> {
        let expected = revision(expected_revision)?;
        valid_route(&route)?;
        let path = self.path(label, vault)?;
        with_file_mutation(|| {
            let current = self.load(&path)?;
            if current.revision != expected_revision {
                return Err(AppError::domain(
                    "mobile_route_conflict",
                    "Reading route changed; reload before saving",
                ));
            }
            let next = expected.checked_add(1).ok_or_else(|| {
                AppError::domain(
                    "mobile_route_exhausted",
                    "Reading route revision is exhausted",
                )
            })?;
            let snapshot = MobileRouteSnapshot {
                revision: next.to_string(),
                route: Some(route),
            };
            let bytes = serde_json::to_vec(&snapshot).map_err(|_| invalid())?;
            if bytes.len() > MAX_FILE {
                return Err(invalid());
            }
            fs::create_dir_all(&self.root).map_err(|_| unavailable())?;
            self.check_root()?;
            atomic_write_with(
                &path,
                &bytes,
                &AtomicOpts {
                    unix_mode: Some(0o600),
                    sync_file: true,
                    ..Default::default()
                },
            )
            .map_err(|_| unavailable())?;
            // The shared helper syncs contents; sync the rename and the freshly
            // created directory entry on Unix, as existing native stores do.
            #[cfg(unix)]
            for directory in self.root.ancestors().take(2) {
                fs::File::open(directory)
                    .and_then(|file| file.sync_all())
                    .map_err(|_| unavailable())?;
            }
            Ok(snapshot)
        })
    }
}

#[cfg(test)]
mod tests;
