//! Portable paper IPC policy. Mobile authority is the canonical private Vault,
//! never a caller-selected directory or SSH handle. Desktop behavior is retained.
use crate::core::error::AppError;
use std::path::{Path, PathBuf};

pub(crate) fn checked_vault(raw: &str, private: Option<&Path>) -> Result<PathBuf, AppError> {
    let Some(private) = private else {
        return crate::core::fs::resolve_vault(raw);
    };
    let candidate = Path::new(raw);
    if raw.len() > 4096 || !candidate.is_absolute() {
        return Err(AppError::domain(
            "paper_private_vault_required",
            "Mobile paper operations require the app private Vault",
        ));
    }
    let root = std::fs::canonicalize(candidate)?;
    if !root.is_dir() || root != std::fs::canonicalize(private)? {
        return Err(AppError::domain(
            "paper_private_vault_required",
            "Mobile paper operations require the app private Vault",
        ));
    }
    Ok(root)
}

pub(crate) fn vault(app: &tauri::AppHandle, raw: &str) -> Result<PathBuf, AppError> {
    #[cfg(mobile)]
    {
        use tauri::Manager;
        let private = app
            .path()
            .app_data_dir()
            .map_err(|error| AppError::message(error.to_string()))?
            .join("Vault");
        checked_vault(raw, Some(&private))
    }
    #[cfg(desktop)]
    {
        let _ = app;
        checked_vault(raw, None)
    }
}

#[cfg(mobile)]
pub(crate) fn private_vault(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    use tauri::Manager;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::message(error.to_string()))?
        .join("Vault");
    checked_vault(&path.to_string_lossy(), Some(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mobile_vault_authority_is_exact_and_canonical_not_a_prefix_or_remote_handle() {
        let dir = tempfile::tempdir().unwrap();
        let private = dir.path().join("Vault");
        let sibling = dir.path().join("Vault-other");
        std::fs::create_dir(&private).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        assert_eq!(
            checked_vault(private.to_str().unwrap(), Some(&private)).unwrap(),
            private.canonicalize().unwrap()
        );
        for candidate in [
            sibling.to_str().unwrap(),
            "remote://host/session",
            "Vault",
            "/",
        ] {
            assert_eq!(
                checked_vault(candidate, Some(&private)).unwrap_err().code(),
                "paper_private_vault_required"
            );
        }
        assert!(
            checked_vault(sibling.to_str().unwrap(), None).is_ok(),
            "desktop explicit Vault behavior stays available"
        );
    }
    #[cfg(unix)]
    #[test]
    fn canonical_alias_is_allowed_but_symlink_to_another_vault_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let private = dir.path().join("Vault");
        let other = dir.path().join("Other");
        std::fs::create_dir(&private).unwrap();
        std::fs::create_dir(&other).unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&private, &alias).unwrap();
        assert!(checked_vault(alias.to_str().unwrap(), Some(&private)).is_ok());
        assert!(checked_vault(other.to_str().unwrap(), Some(&private)).is_err());
    }
}
