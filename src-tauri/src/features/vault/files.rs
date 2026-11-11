//! Renderer text mutations share sync's short in-process mutation lane.
//! External editors do not participate; this is not an OS compare-and-swap.

use crate::core::blocking::run_blocking;
use crate::core::error::{ApiResult, AppError};
use crate::core::fs::{atomic_write, with_file_mutation};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::ipc::ScopeObject;
use tauri::utils::{acl::Value, config::FsScope};
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_fs::FsExt;

// The plugin's Entry is private. Deserialize its public ACL shape using the
// same path-variable expansion and unknown-directory behavior as plugin-fs.
#[derive(Debug)]
struct FsEntry(Option<PathBuf>);

impl ScopeObject for FsEntry {
    type Error = tauri::Error;

    fn deserialize<R: Runtime>(app: &AppHandle<R>, raw: Value) -> Result<Self, Self::Error> {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Entry {
            Path(String),
            Object { path: String },
        }
        let path = match serde_json::from_value::<Entry>(raw.into())? {
            Entry::Path(path) | Entry::Object { path } => path,
        };
        match app.path().parse(path) {
            Ok(path) => Ok(Self(Some(path))),
            #[cfg(not(target_os = "android"))]
            Err(tauri::Error::UnknownPath) => Ok(Self(None)),
            Err(error) => Err(error),
        }
    }
}

struct FileScope {
    runtime: tauri::fs::Scope,
    capability: tauri::fs::Scope,
}

impl FileScope {
    fn resolve(webview: &Webview, command: &str) -> Result<Self, AppError> {
        let resolved = webview
            .resolve_command_scope::<FsEntry>("fs", command)
            .map_err(|error| AppError::message(error.to_string()))?
            .ok_or_else(|| AppError::message(format!("fs {command} permission denied")))?;
        let global = resolved.global_scope();
        let command = resolved.command_scope();
        let require_literal_leading_dot = webview
            .config()
            .plugins
            .0
            .get("fs")
            .and_then(|config| config.get("requireLiteralLeadingDot"))
            .and_then(serde_json::Value::as_bool);
        let capability = tauri::fs::Scope::new(
            webview,
            &FsScope::Scope {
                allow: global
                    .allows()
                    .iter()
                    .chain(command.allows())
                    .filter_map(|entry| entry.0.clone())
                    .collect(),
                deny: global
                    .denies()
                    .iter()
                    .chain(command.denies())
                    .filter_map(|entry| entry.0.clone())
                    .collect(),
                require_literal_leading_dot,
            },
        )
        .map_err(|error| AppError::message(error.to_string()))?;
        Ok(Self {
            runtime: webview.fs_scope(),
            capability,
        })
    }

    fn check(&self, path: &Path) -> Result<(), AppError> {
        if self.runtime.is_forbidden(path)
            || self.capability.is_forbidden(path)
            || !(self.runtime.is_allowed(path) || self.capability.is_allowed(path))
        {
            return Err(AppError::message(format!(
                "forbidden path: {}",
                path.display()
            )));
        }
        Ok(())
    }

    fn target(&self, path: &Path) -> Result<PathBuf, AppError> {
        let canonical = canonical_target(path)?;
        self.check(path)?;
        self.check(&canonical)?;
        Ok(canonical)
    }
}

/// Resolve the nearest existing ancestor before appending missing components.
/// Canonicalizing only an existing target misses escapes through symlinked
/// parents when the target (or several parents) has not been created yet.
fn canonical_target(path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute()
        || path.file_name().is_none()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(AppError::message(
            "an absolute file path without traversal is required",
        ));
    }
    let mut ancestor = path;
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .ok_or_else(|| AppError::message("invalid file path"))?,
                );
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| AppError::message("invalid file path"))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    // Broken symlinks fail here rather than becoming writable lexical paths.
    let mut canonical = fs::canonicalize(ancestor)?;
    for component in missing.into_iter().rev() {
        canonical.push(component);
    }
    Ok(canonical)
}

fn read_existing(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn preserve_proposal(
    path: &Path,
    bytes: &[u8],
    resolve_conflict: impl FnOnce(&Path) -> Result<PathBuf, AppError>,
) -> Result<PathBuf, AppError> {
    let hash = hex::encode(Sha256::digest(bytes));
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::message("invalid file name"))?;
    let extension = path
        .extension()
        .and_then(|name| name.to_str())
        .unwrap_or("json");
    let conflict = path.with_file_name(format!("{stem} (conflict {hash}).{extension}"));
    let conflict = resolve_conflict(&conflict)?;
    match read_existing(&conflict)? {
        Some(existing) if existing == bytes => {}
        Some(_) => {
            return Err(AppError::message(
                "conflict preservation path already contains different bytes",
            ))
        }
        None => atomic_write(&conflict, bytes)?,
    }
    Ok(conflict)
}

// Caller holds the mutation lane across this check and publication.
fn write_text(
    path: &Path,
    bytes: &[u8],
    guard_current: bool,
    expected_content: Option<&[u8]>,
    resolve_conflict: impl FnOnce(&Path) -> Result<PathBuf, AppError>,
) -> Result<(), AppError> {
    if guard_current && read_existing(path)?.as_deref() != expected_content {
        let conflict = preserve_proposal(path, bytes, resolve_conflict)?;
        return Err(AppError::domain(
            "file_write_conflict",
            format!(
                "File changed on disk; saved this edit to {}",
                conflict.display()
            ),
        ));
    }
    atomic_write(path, bytes)?;
    Ok(())
}

/// Write text using the calling webview's existing plugin-fs permissions.
#[tauri::command]
#[specta::specta]
pub async fn vault_write_text_file(
    webview: Webview,
    path: String,
    content: String,
    guard_current: bool,
    expected_content: Option<String>,
) -> Result<ApiResult<()>, String> {
    let write_scope = match FileScope::resolve(&webview, "write_text_file") {
        Ok(scope) => scope,
        Err(error) => return Ok(ApiResult::err(error)),
    };
    let mkdir_scope = FileScope::resolve(&webview, "mkdir");
    #[cfg(mobile)]
    let app = webview.app_handle().clone();
    Ok(run_blocking(move || {
        let result = with_file_mutation(|| {
            let path = write_scope.target(Path::new(&path))?;
            let parent = path
                .parent()
                .ok_or_else(|| AppError::message("invalid file parent"))?;
            if !parent.exists() {
                mkdir_scope?.target(parent)?;
                fs::create_dir_all(parent)?;
            }
            // Recheck after mkdir and operate on the resolved target. This does
            // not claim protection against external processes changing symlinks.
            let path = write_scope.target(&path)?;
            write_text(
                &path,
                content.as_bytes(),
                guard_current,
                expected_content.as_deref().map(str::as_bytes),
                |conflict| write_scope.target(conflict),
            )
        });
        #[cfg(mobile)]
        if result.is_ok()
            || result
                .as_ref()
                .is_err_and(|error| error.code() == "file_write_conflict")
        {
            app.state::<crate::integration::sync::SyncService>()
                .notify_path_changed(&app, Path::new(&path));
        }
        match result {
            Ok(()) => ApiResult::ok(()),
            Err(error) if error.code() == "file_write_conflict" => {
                ApiResult::err_with_details(error, serde_json::json!({ "conflictPreserved": true }))
            }
            Err(error) => ApiResult::err(error),
        }
    })
    .await)
}

fn remove_scoped_file(
    path: &Path,
    authorize: impl FnOnce(&Path) -> Result<(), AppError>,
) -> Result<(), AppError> {
    authorize(path)?;
    // Authorize the resolved target, but preserve plugin-fs remove semantics:
    // a symlink leaf is removed itself, rather than deleting the file it names.
    let parent = path
        .parent()
        .ok_or_else(|| AppError::message("invalid file parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| AppError::message("invalid file name"))?;
    fs::remove_file(fs::canonicalize(parent)?.join(name))?;
    Ok(())
}

/// Remove one file with the same permissions and mutation lane as text saves.
#[tauri::command]
#[specta::specta]
pub async fn vault_remove_file(webview: Webview, path: String) -> Result<ApiResult<()>, String> {
    let scope = match FileScope::resolve(&webview, "remove") {
        Ok(scope) => scope,
        Err(error) => return Ok(ApiResult::err(error)),
    };
    #[cfg(mobile)]
    let app = webview.app_handle().clone();
    Ok(run_blocking(move || {
        match with_file_mutation(|| {
            remove_scoped_file(Path::new(&path), |path| scope.target(path).map(|_| ()))
        }) {
            Ok(()) => {
                #[cfg(mobile)]
                app.state::<crate::integration::sync::SyncService>()
                    .notify_path_changed(&app, Path::new(&path));
                ApiResult::ok(())
            }
            Err(error) => ApiResult::err(error),
        }
    })
    .await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_editor_proposal_is_preserved_exactly_without_replacing_remote_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("annotations.json");
        let remote = b"[ {\"id\": \"remote\"} ]\r\n";
        let proposal = b"[\n  {\"id\":\"local\"}\n]\n";
        fs::write(&path, remote).unwrap();
        let save = || {
            with_file_mutation(|| write_text(&path, proposal, true, Some(b"[]"), canonical_target))
        };
        assert_eq!(save().unwrap_err().code(), "file_write_conflict");
        let conflict = path.with_file_name(format!(
            "annotations (conflict {}).json",
            hex::encode(Sha256::digest(proposal))
        ));
        assert_eq!(fs::read(&path).unwrap(), remote);
        assert_eq!(fs::read(&conflict).unwrap(), proposal);
        // Replaying an identical failed save reuses the same exact version.
        assert_eq!(save().unwrap_err().code(), "file_write_conflict");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
        // Occupied differing bytes are never replaced, even at the hash path.
        fs::write(&conflict, b"occupied").unwrap();
        assert!(save().unwrap_err().to_string().contains("different bytes"));
        assert_eq!(fs::read(&conflict).unwrap(), b"occupied");
        assert_eq!(fs::read(&path).unwrap(), remote);
    }

    #[test]
    fn staged_sync_then_markdown_editor_preserves_remote_and_exact_md_proposal() {
        use std::sync::mpsc;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("NOTES.md");
        let staged = dir.path().join("remote.tmp");
        let base = b"# Base\n";
        let remote = b"---\r\ntitle: Remote\r\n---\r\n\r\n# Synced\r\n";
        let proposal = "---\r\ntitle: Local  \r\n---\r\n\r\n*exact draft*\u{200b}  \n".as_bytes();
        fs::write(&path, base).unwrap();
        // This is the frontend's accepted early read, before the sync rename.
        let accepted = fs::read(&path).unwrap();
        let (staged_tx, staged_rx) = mpsc::channel();
        let (publish_tx, publish_rx) = mpsc::channel();
        let (attempt_tx, attempt_rx) = mpsc::channel();
        std::thread::scope(|threads| {
            let sync_path = &path;
            let staged_path = &staged;
            let sync = threads.spawn(move || {
                with_file_mutation(|| {
                    assert_eq!(fs::read(sync_path)?, base);
                    fs::write(staged_path, remote)?;
                    staged_tx.send(()).unwrap();
                    publish_rx.recv().unwrap();
                    fs::rename(staged_path, sync_path)?;
                    Ok(())
                })
                .unwrap();
            });
            staged_rx.recv().unwrap();
            let editor_path = &path;
            let editor = threads.spawn(move || {
                attempt_tx.send(()).unwrap();
                with_file_mutation(|| {
                    write_text(
                        editor_path,
                        proposal,
                        true,
                        Some(&accepted),
                        canonical_target,
                    )
                })
            });
            attempt_rx.recv().unwrap();
            assert_eq!(fs::read(&path).unwrap(), base);
            publish_tx.send(()).unwrap();
            sync.join().unwrap();
            assert_eq!(
                editor.join().unwrap().unwrap_err().code(),
                "file_write_conflict"
            );
        });
        let conflict = path.with_file_name(format!(
            "NOTES (conflict {}).md",
            hex::encode(Sha256::digest(proposal))
        ));
        assert_eq!(fs::read(&path).unwrap(), remote);
        assert_eq!(fs::read(&conflict).unwrap(), proposal);
        assert_eq!(conflict.extension().unwrap(), "md");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn denied_conflict_target_leaves_canonical_and_directory_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("annotations.json");
        fs::write(&path, b"remote").unwrap();
        let result = with_file_mutation(|| {
            write_text(&path, b"local", true, Some(b"base"), |_| {
                Err(AppError::message("forbidden conflict path"))
            })
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("forbidden conflict"));
        assert_eq!(fs::read(&path).unwrap(), b"remote");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn canonical_target_resolves_missing_parents_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("new/marks/annotations.json");
        assert_eq!(
            canonical_target(&target).unwrap(),
            dir.path()
                .canonicalize()
                .unwrap()
                .join("new/marks/annotations.json")
        );
        assert!(canonical_target(Path::new("relative/notes.md")).is_err());
        assert!(canonical_target(&dir.path().join("../outside.json")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn removing_a_symlink_leaf_preserves_its_authorized_target() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.json");
        let link = dir.path().join("link.json");
        fs::write(&target, b"keep").unwrap();
        symlink(&target, &link).unwrap();
        with_file_mutation(|| remove_scoped_file(&link, |path| canonical_target(path).map(|_| ())))
            .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert!(fs::symlink_metadata(link).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn missing_targets_resolve_symlinked_ancestors_and_reject_broken_links() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), dir.path().join("escape")).unwrap();
        let path = dir.path().join("escape/new/annotations.json");
        assert_eq!(
            canonical_target(&path).unwrap(),
            outside
                .path()
                .canonicalize()
                .unwrap()
                .join("new/annotations.json")
        );
        symlink(dir.path().join("missing"), dir.path().join("broken")).unwrap();
        assert!(canonical_target(&dir.path().join("broken/new.json")).is_err());
    }
}
