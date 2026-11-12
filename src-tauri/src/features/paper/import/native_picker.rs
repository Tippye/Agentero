//! OS-selected PDF import. Selection and staging never accept renderer paths.
//! The single native operation owns its permit and temporary copies through commit.
use super::{ImportLocalPdfArgs, ImportLocalPdfResult, LocalPdfImportEntry};
use crate::core::error::AppError;
use crate::features::paper::catalog::CapsCache;
use std::{
    fs,
    future::Future,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FileAccessMode, FilePath, PickerMode};
#[cfg(not(target_os = "android"))]
use tauri_plugin_fs::{FsExt, OpenOptions};
use tempfile::TempDir;
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

const CHUNK: usize = 64 * 1024;
const HEADER: usize = 1024;
#[derive(Clone, Copy)]
struct Limits {
    files: usize,
    file_bytes: u64,
    total_bytes: u64,
}
const LIMITS: Limits = Limits {
    files: 32,
    file_bytes: 256 * 1024 * 1024,
    total_bytes: 1024 * 1024 * 1024,
};
fn failure(code: &'static str, message: &str) -> AppError {
    AppError::domain(code, message)
}
fn empty_result() -> ImportLocalPdfResult {
    ImportLocalPdfResult {
        papers: Vec::new(),
        errors: Vec::new(),
    }
}
fn admission(gate: &Arc<Semaphore>) -> Result<OwnedSemaphorePermit, AppError> {
    gate.clone().try_acquire_owned().map_err(|_| {
        failure(
            "paper_picker_busy",
            "A PDF picker or import is already active",
        )
    })
}
fn picker_gate() -> &'static Arc<Semaphore> {
    static GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(Semaphore::new(1)))
}

#[derive(Clone, PartialEq, Eq)]
struct VaultIdentity {
    path: PathBuf,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(unix))]
    created: Option<std::time::SystemTime>,
}
impl VaultIdentity {
    fn capture(path: &Path) -> Result<Self, AppError> {
        let path = fs::canonicalize(path)?;
        let metadata = fs::metadata(&path)?;
        if !path.is_absolute() || !metadata.is_dir() {
            return Err(failure(
                "paper_picker_vault_required",
                "A local Vault directory is required",
            ));
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            path,
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(not(unix))]
            created: metadata.created().ok(),
        })
    }
    fn check(&self, current: &Path) -> Result<(), AppError> {
        if Self::capture(current)? != *self {
            return Err(failure(
                "paper_picker_vault_changed",
                "The Vault changed while selecting PDFs; select again",
            ));
        }
        Ok(())
    }
    fn check_app(&self, app: &tauri::AppHandle, raw: &str) -> Result<(), AppError> {
        self.check(&crate::features::paper::mobile::vault(app, raw)?)
    }
}

/// Callback ownership survives a dropped invoke receiver. No operation starts
/// after an already-abandoned selection; an operation that started finishes owned.
fn selection_callback<F, Fut>(
    permit: OwnedSemaphorePermit,
    reply: oneshot::Sender<Result<ImportLocalPdfResult, AppError>>,
    operation: F,
) -> impl FnOnce(Option<Vec<FilePath>>) + Send + 'static
where
    F: FnOnce(Vec<FilePath>, OwnedSemaphorePermit) -> Fut + Send + 'static,
    Fut: Future<Output = Result<ImportLocalPdfResult, AppError>> + Send + 'static,
{
    move |selection| {
        if reply.is_closed() {
            return;
        }
        let files = selection.unwrap_or_default();
        if files.is_empty() {
            let _ = reply.send(Ok(empty_result()));
            return;
        }
        // Exactly one owned operation, not detached per-file work. Dropping the
        // invoke receiver cannot remove a source still used by a copy worker.
        drop(tauri::async_runtime::spawn(async move {
            let result = operation(files, permit).await;
            let _ = reply.send(result);
        }));
    }
}

pub(crate) async fn import_selected(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    vault_path: String,
) -> Result<ImportLocalPdfResult, AppError> {
    if crate::core::remote::parse_remote_handle(&vault_path).is_some() {
        return Err(failure(
            "paper_picker_vault_required",
            "Native PDF import requires a local Vault",
        ));
    }
    let identity =
        VaultIdentity::capture(&crate::features::paper::mobile::vault(&app, &vault_path)?)?;
    let permit = admission(picker_gate())?;
    let (reply, received) = oneshot::channel();
    let worker_app = app.clone();
    let callback = selection_callback(permit, reply, move |files, permit| {
        import_owned(worker_app, vault_path, identity, files, permit)
    });
    // iOS Copy may download a provider's source before this callback. The byte
    // limits below bound our staging reads, not the OS/provider's prior copy.
    let dialog = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_picker_mode(PickerMode::Document)
        .set_file_access_mode(FileAccessMode::Copy);
    #[cfg(desktop)]
    let dialog = dialog.set_parent(&window);
    #[cfg(mobile)]
    let _ = window;
    dialog.pick_files(callback);
    received.await.map_err(|_| {
        failure(
            "paper_picker_interrupted",
            "The native PDF operation ended before returning a result",
        )
    })?
}

struct StagedFile {
    entry: LocalPdfImportEntry,
    _directory: TempDir,
}
struct StagedBatch {
    files: Vec<StagedFile>,
    errors: Vec<String>,
    _directory: TempDir,
    _permit: OwnedSemaphorePermit,
}
async fn import_owned(
    app: tauri::AppHandle,
    raw_vault: String,
    identity: VaultIdentity,
    files: Vec<FilePath>,
    permit: OwnedSemaphorePermit,
) -> Result<ImportLocalPdfResult, AppError> {
    if files.len() > LIMITS.files {
        return Err(failure(
            "paper_picker_file_limit",
            "Select at most 32 PDF files",
        ));
    }
    #[cfg(mobile)]
    let _work =
        match app.try_state::<Arc<crate::features::mobile_background::MobileBackgroundService>>() {
            Some(service) => Some(
                service
                    .track(crate::features::mobile_background::BackgroundReason::Transfer)
                    .await?,
            ),
            None => None,
        };
    // This owned operation keeps all resources until real completion, including
    // if the OS suspends it. We do not report cancellation/rollback after selection.
    let stage_app = app.clone();
    let stage_identity = identity.clone();
    let stage_vault = raw_vault.clone();
    let staged = tauri::async_runtime::spawn_blocking(move || {
        stage_identity.check_app(&stage_app, &stage_vault)?;
        stage_selected(&stage_app, files, permit)
    })
    .await
    .map_err(|_| {
        failure(
            "paper_picker_stage_failed",
            "Unable to stage the selected PDFs",
        )
    })??;
    if staged.files.is_empty() {
        return Err(AppError::message(staged.errors.join("; ")));
    }
    identity.check_app(&app, &raw_vault)?;
    let args = ImportLocalPdfArgs {
        vault_path: identity.path.to_string_lossy().into_owned(),
        parent_dir: "papers".into(),
        file_paths: Vec::new(),
        entries: staged.files.iter().map(|file| file.entry.clone()).collect(),
        task_id: None,
        recognize_sync: false,
        translator_base_url: None,
    };
    let host = crate::features::host_hooks::wrap(&app);
    let cache = app.state::<CapsCache>();
    let result = super::import_local_pdfs(
        args,
        Some(&host),
        Some(&cache),
        super::note_mode_from_app(&app),
    )
    .await;
    if let Ok(imported) = &result {
        for paper in &imported.papers {
            crate::features::host_hooks::enqueue_preparation_plan(
                &app,
                &identity.path,
                &paper.preparation,
            );
        }
    }
    merge_errors(&staged.errors, result)
}
fn merge_errors(
    errors: &[String],
    result: Result<ImportLocalPdfResult, AppError>,
) -> Result<ImportLocalPdfResult, AppError> {
    match result {
        Ok(mut imported) => {
            drop(imported.errors.splice(0..0, errors.iter().cloned()));
            Ok(imported)
        }
        Err(error) if errors.is_empty() => Err(error),
        Err(error) => Err(AppError::message(format!("{}; {error}", errors.join("; ")))),
    }
}

fn stage_selected(
    app: &tauri::AppHandle,
    files: Vec<FilePath>,
    permit: OwnedSemaphorePermit,
) -> Result<StagedBatch, AppError> {
    let cache = app.path().app_cache_dir().map_err(|_| {
        failure(
            "paper_picker_cache_unavailable",
            "Private PDF staging is unavailable",
        )
    })?;
    if !cache.is_absolute()
        || fs::symlink_metadata(&cache).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(failure(
            "paper_picker_cache_unavailable",
            "Private PDF staging is unavailable",
        ));
    }
    fs::create_dir_all(&cache).map_err(|_| {
        failure(
            "paper_picker_cache_unavailable",
            "Private PDF staging is unavailable",
        )
    })?;
    let cache = fs::canonicalize(&cache).map_err(|_| {
        failure(
            "paper_picker_cache_unavailable",
            "Private PDF staging is unavailable",
        )
    })?;
    let directory = tempfile::Builder::new()
        .prefix("paper-picker-")
        .tempdir_in(cache)
        .map_err(|_| {
            failure(
                "paper_picker_cache_unavailable",
                "Private PDF staging is unavailable",
            )
        })?;
    let mut batch = StagedBatch {
        files: Vec::new(),
        errors: Vec::new(),
        _directory: directory,
        _permit: permit,
    };
    let mut budget = Budget {
        read: 0,
        limits: LIMITS,
    };
    for (index, picked) in files.into_iter().enumerate() {
        let name = selected_name(&picked, index);
        let staged = if budget.read >= budget.limits.total_bytes {
            Err("PDF batch read limit reached")
        } else {
            stage_one(
                app,
                &picked,
                &name,
                index,
                batch._directory.path(),
                &mut budget,
            )
        };
        match staged {
            Ok(file) => batch.files.push(file),
            Err(reason) => batch.errors.push(format!("{name}: {reason}")),
        }
    }
    Ok(batch)
}
fn selected_name(picked: &FilePath, index: usize) -> String {
    let path = match picked {
        FilePath::Path(path) => Some(path.clone()),
        FilePath::Url(url) if url.scheme() == "file" => url.to_file_path().ok(),
        // An Android document ID is not a display name. Do not persist its URI.
        FilePath::Url(_) => None,
    };
    let original = path
        .as_deref()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str());
    sanitized_name(original, index)
}
fn sanitized_name(original: Option<&str>, index: usize) -> String {
    let Some(original) = original else {
        return format!("paper-{}.pdf", index + 1);
    };
    let stem = original
        .rsplit_once('.')
        .filter(|(_, extension)| extension.eq_ignore_ascii_case("pdf"))
        .map_or(original, |(stem, _)| stem);
    let mut safe = String::new();
    for character in stem.chars() {
        let character = if character.is_control()
            || matches!(
                character,
                '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
            ) {
            '_'
        } else {
            character
        };
        if safe.len() + character.len_utf8() > 180 {
            break;
        }
        safe.push(character);
    }
    let safe = safe.trim().trim_matches('.').trim();
    // Windows reserves the first dot-separated component, even with extensions.
    let device = safe
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    let serial = device
        .strip_prefix("COM")
        .or_else(|| device.strip_prefix("LPT"));
    let reserved = matches!(device.as_str(), "CON" | "NUL" | "PRN" | "AUX")
        || serial.is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    if safe.is_empty() || reserved {
        format!("paper-{}.pdf", index + 1)
    } else {
        format!("{safe}.pdf")
    }
}

#[cfg(target_os = "ios")]
struct SecurityAccess<'a> {
    app: &'a tauri::AppHandle,
    file: Option<FilePath>,
}
#[cfg(target_os = "ios")]
impl Drop for SecurityAccess<'_> {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            let _ = self.app.fs().stop_accessing_security_scoped_resource(file);
        }
    }
}
fn stage_one(
    app: &tauri::AppHandle,
    picked: &FilePath,
    name: &str,
    index: usize,
    root: &Path,
    budget: &mut Budget,
) -> Result<StagedFile, &'static str> {
    // fs 2.5.1 starts iOS security scope before std::open, which may fail.
    // Install the guard first; Rust drops the subsequently opened File first.
    #[cfg(target_os = "ios")]
    let _access = SecurityAccess {
        app,
        file: matches!(picked, FilePath::Url(url) if url.scheme() == "file")
            .then(|| picked.clone()),
    };
    #[cfg(target_os = "android")]
    let (mut source, display_name) = open_android_selection(app, picked)?;
    #[cfg(not(target_os = "android"))]
    let (mut source, display_name) = {
        let mut options = OpenOptions::new();
        options.read(true);
        let file = app
            .fs()
            .open(picked.clone(), options)
            .map_err(|_| "Unable to read this document provider")?;
        (file, None::<String>)
    };
    let name = display_name.as_deref().map_or_else(
        || name.to_string(),
        |display| sanitized_name(Some(display), index),
    );
    stage_reader(&mut source, &name, index, root, budget)
}

// SDK fs 2.5.1 detaches an AssetFileDescriptor without its slice offsets.
// Use the private whole-file/pipe opener instead; partial assets fail closed.
#[cfg(target_os = "android")]
fn open_android_selection(
    app: &tauri::AppHandle,
    picked: &FilePath,
) -> Result<(std::fs::File, Option<String>), &'static str> {
    match picked {
        FilePath::Url(url) if url.scheme() == "content" => app
            .try_state::<tauri_plugin_agentero_mobile::MobileBackground<tauri::Wry>>()
            .ok_or("Native document access is unavailable")?
            .open_import_file(url.to_string())
            .map(|opened| (opened.file, opened.display_name))
            .map_err(|_| "This document provider cannot provide a whole PDF file"),
        FilePath::Url(url) if url.scheme() == "file" => {
            let path = url.to_file_path().map_err(|_| "Invalid selected file")?;
            std::fs::File::open(path)
                .map(|file| (file, None))
                .map_err(|_| "Unable to read the selected PDF")
        }
        FilePath::Path(path) => std::fs::File::open(path)
            .map(|file| (file, None))
            .map_err(|_| "Unable to read the selected PDF"),
        FilePath::Url(_) => Err("This document provider is unsupported"),
    }
}

fn stage_reader(
    reader: &mut impl Read,
    name: &str,
    index: usize,
    root: &Path,
    budget: &mut Budget,
) -> Result<StagedFile, &'static str> {
    let directory = tempfile::Builder::new()
        .prefix(&format!("{index}-"))
        .tempdir_in(root)
        .map_err(|_| "Unable to create a private PDF copy")?;
    let destination = directory.path().join(name);
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|_| "Unable to create a private PDF copy")?;
    copy_pdf(reader, &mut output, budget)?;
    drop(output);
    Ok(StagedFile {
        entry: LocalPdfImportEntry {
            file_path: destination.to_string_lossy().into_owned(),
            title: None,
            authors: None,
            year: None,
            doi: None,
            arxiv_id: None,
            extra: None,
        },
        _directory: directory,
    })
}
struct Budget {
    read: u64,
    limits: Limits,
}
fn read_bounded(
    reader: &mut impl Read,
    buffer: &mut [u8],
    budget: &mut Budget,
    file_read: &mut u64,
) -> Result<usize, &'static str> {
    let file_remaining = budget.limits.file_bytes.saturating_sub(*file_read);
    let batch_remaining = budget.limits.total_bytes.saturating_sub(budget.read);
    if batch_remaining == 0 {
        return Err("PDF batch read limit reached");
    }
    // Without Seek/known length, proving EOF at the exact cap needs another
    // byte. Reject conservatively instead of reading beyond either hard cap.
    if file_remaining == 0 {
        return Err("PDF file read limit reached");
    }
    let count = (buffer.len() as u64)
        .min(file_remaining)
        .min(batch_remaining) as usize;
    let read = loop {
        match reader.read(&mut buffer[..count]) {
            Ok(read) => break read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Unable to read the selected PDF"),
        }
    };
    budget.read += read as u64;
    *file_read += read as u64;
    Ok(read)
}
fn copy_pdf(
    reader: &mut impl Read,
    output: &mut impl Write,
    budget: &mut Budget,
) -> Result<(), &'static str> {
    let mut file_read = 0;
    let mut header = [0u8; HEADER];
    let mut length = 0;
    while length < header.len() {
        let read = read_bounded(reader, &mut header[length..], budget, &mut file_read)?;
        if read == 0 {
            break;
        }
        length += read;
    }
    if !header[..length].windows(5).any(|bytes| bytes == b"%PDF-") {
        return Err("The selected document has no PDF header");
    }
    output
        .write_all(&header[..length])
        .map_err(|_| "Unable to write a private PDF copy")?;
    if length < HEADER {
        return Ok(());
    }
    let mut buffer = [0u8; CHUNK];
    loop {
        let read = read_bounded(reader, &mut buffer, budget, &mut file_read)?;
        if read == 0 {
            return Ok(());
        }
        output
            .write_all(&buffer[..read])
            .map_err(|_| "Unable to write a private PDF copy")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    struct Chunks {
        bytes: io::Cursor<Vec<u8>>,
        chunk: usize,
        largest: usize,
    }
    impl Read for Chunks {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            self.largest = self.largest.max(output.len());
            let count = output.len().min(self.chunk);
            self.bytes.read(&mut output[..count])
        }
    }
    fn budget(file_bytes: u64, total_bytes: u64) -> Budget {
        Budget {
            read: 0,
            limits: Limits {
                files: 32,
                file_bytes,
                total_bytes,
            },
        }
    }
    #[test]
    fn streamed_short_reads_accept_pdf_header_within_window_without_seek_or_full_buffer() {
        let mut bytes = vec![b' '; HEADER - 5];
        bytes.extend_from_slice(b"%PDF-");
        bytes.extend(vec![b'p'; CHUNK * 2 + 17]);
        let mut input = Chunks {
            bytes: io::Cursor::new(bytes.clone()),
            chunk: 7,
            largest: 0,
        };
        let mut copied = Vec::new();
        let mut limits = budget(1_000_000, 1_000_000);
        copy_pdf(&mut input, &mut copied, &mut limits).unwrap();
        assert_eq!(copied, bytes);
        assert_eq!(limits.read, bytes.len() as u64);
        assert!(input.largest <= CHUNK);
        let mut outside = vec![b' '; HEADER];
        outside.extend_from_slice(b"%PDF-");
        assert!(copy_pdf(
            &mut io::Cursor::new(outside),
            &mut Vec::new(),
            &mut budget(2000, 2000)
        )
        .is_err());
    }
    #[test]
    fn actual_read_caps_include_failed_files_and_exact_cap_is_conservatively_rejected() {
        let mut limits = budget(16, 24);
        let mut invalid = io::Cursor::new(b"invalid".to_vec());
        assert!(copy_pdf(&mut invalid, &mut Vec::new(), &mut limits).is_err());
        assert_eq!(limits.read, 7);
        let mut exact = io::Cursor::new(b"%PDF-12345678901".to_vec());
        assert_eq!(exact.get_ref().len(), 16);
        assert_eq!(
            copy_pdf(&mut exact, &mut Vec::new(), &mut limits),
            Err("PDF file read limit reached")
        );
        assert_eq!(exact.position(), 16);
        assert_eq!(limits.read, 23);
        let mut next = io::Cursor::new(b"%PDF-1.7".to_vec());
        assert_eq!(
            copy_pdf(&mut next, &mut Vec::new(), &mut limits),
            Err("PDF batch read limit reached")
        );
        assert_eq!(next.position(), 1);
        assert_eq!(limits.read, 24);
        let position = next.position();
        assert!(copy_pdf(&mut next, &mut Vec::new(), &mut limits).is_err());
        assert_eq!(
            next.position(),
            position,
            "exhaustion must not read an extra probe byte"
        );
    }
    #[test]
    fn failed_copy_cleans_only_its_owned_directory_and_preserves_selected_source() {
        struct Failing {
            file: fs::File,
            left: usize,
        }
        impl Read for Failing {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                if self.left == 0 {
                    return Err(io::Error::other("provider failed"));
                }
                let count = bytes.len().min(self.left);
                let read = self.file.read(&mut bytes[..count])?;
                self.left -= read;
                Ok(read)
            }
        }
        let fixture = tempfile::tempdir().unwrap();
        let selected = fixture.path().join("selected.pdf");
        let bytes = b"%PDF-1.7\nprovider source must survive";
        fs::write(&selected, bytes).unwrap();
        let private = tempfile::tempdir().unwrap();
        let mut source = Failing {
            file: fs::File::open(&selected).unwrap(),
            left: 12,
        };
        let mut limits = budget(1000, 1000);
        assert!(stage_reader(&mut source, "selected.pdf", 0, private.path(), &mut limits).is_err());
        assert_eq!(limits.read, 12);
        assert_eq!(fs::read_dir(private.path()).unwrap().count(), 0);
        assert_eq!(fs::read(&selected).unwrap(), bytes);
    }
    #[test]
    fn original_filename_and_absent_overrides_preserve_core_deferred_recognition() {
        let private = tempfile::tempdir().unwrap();
        let picked = FilePath::Path(PathBuf::from("2401.12345.PdF"));
        let name = selected_name(&picked, 0);
        assert_eq!(name, "2401.12345.pdf");
        let staged = stage_reader(
            &mut io::Cursor::new(b"%PDF-1.7\n"),
            &name,
            0,
            private.path(),
            &mut budget(1000, 1000),
        )
        .unwrap();
        assert_eq!(
            Path::new(&staged.entry.file_path).file_name().unwrap(),
            "2401.12345.pdf"
        );
        assert!(
            staged.entry.title.is_none()
                && staged.entry.doi.is_none()
                && staged.entry.arxiv_id.is_none()
                && staged.entry.extra.is_none()
        );
        let opaque =
            FilePath::Url(url::Url::parse("content://documents/private-document-id-1234").unwrap());
        assert_eq!(selected_name(&opaque, 1), "paper-2.pdf");
        let unsafe_name = sanitized_name(Some("../../bad\\name:\n.pdf"), 0);
        assert!(!unsafe_name.contains(['/', '\\', ':', '\n']));
        assert!(sanitized_name(Some(&"中".repeat(1000)), 0).len() <= 184);
        for reserved in [
            "CON",
            "NUL.pdf",
            "prn.archive.PDF",
            " AUX .notes.pdf",
            "con.pdf  ",
            "COM¹.pdf",
            "lPt².extra.pdf",
            "LPT³.pdf",
        ] {
            assert_eq!(
                sanitized_name(Some(reserved), 2),
                "paper-3.pdf",
                "{reserved}"
            );
        }
        for prefix in ["COM", "LPT"] {
            for digit in 1..=9 {
                assert_eq!(
                    sanitized_name(Some(&format!("{prefix}{digit}.extra.pdf")), 2),
                    "paper-3.pdf"
                );
            }
        }
        for ordinary in ["COM0", "LPT10", "CONference", "AUXiliary"] {
            assert_eq!(sanitized_name(Some(ordinary), 0), format!("{ordinary}.pdf"));
        }
    }
    #[test]
    fn staging_errors_survive_partial_success_and_all_core_failures() {
        let errors = vec!["first.pdf: provider unavailable".to_string()];
        let merged = merge_errors(
            &errors,
            Ok(ImportLocalPdfResult {
                papers: Vec::new(),
                errors: vec!["second.pdf: invalid".into()],
            }),
        )
        .unwrap();
        assert_eq!(
            merged.errors,
            vec![errors[0].clone(), "second.pdf: invalid".into()]
        );
        let error = merge_errors(&errors, Err(AppError::message("third.pdf: catalog failed")))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("first.pdf")
                && error.contains("third.pdf")
                && error.contains("catalog failed")
        );
    }
    #[cfg(unix)]
    #[test]
    fn same_path_vault_replacement_is_rejected_before_commit() {
        let fixture = tempfile::tempdir().unwrap();
        let vault = fixture.path().join("Vault");
        fs::create_dir(&vault).unwrap();
        let before = VaultIdentity::capture(&vault).unwrap();
        fs::rename(&vault, fixture.path().join("old-vault")).unwrap();
        fs::create_dir(&vault).unwrap();
        assert_eq!(before.path, vault.canonicalize().unwrap());
        assert_eq!(
            before.check(&vault).unwrap_err().code(),
            "paper_picker_vault_changed"
        );
    }
    #[tokio::test]
    async fn pending_picker_holds_admission_after_receiver_drop_and_cancel_creates_no_work() {
        let gate = Arc::new(Semaphore::new(1));
        let permit = admission(&gate).unwrap();
        let (reply, received) = oneshot::channel();
        let called = Arc::new(AtomicBool::new(false));
        let did_call = called.clone();
        let callback = selection_callback(permit, reply, move |_, _| {
            did_call.store(true, Ordering::SeqCst);
            async { Ok(empty_result()) }
        });
        drop(received);
        assert!(
            admission(&gate).is_err(),
            "dropping invoke must not reopen the OS picker"
        );
        callback(Some(vec![FilePath::Path("picker-owned.pdf".into())]));
        assert!(!called.load(Ordering::SeqCst));
        let permit = admission(&gate).unwrap();
        let (reply, received) = oneshot::channel();
        selection_callback(permit, reply, |_, _| async {
            panic!("cancelled picker started work")
        })(None);
        let cancelled = received.await.unwrap().unwrap();
        assert!(cancelled.papers.is_empty() && cancelled.errors.is_empty());
        assert_eq!(gate.available_permits(), 1);
    }
    #[tokio::test]
    async fn receiver_drop_cannot_remove_staging_or_release_admission_while_copy_or_import_owns_it()
    {
        let gate = Arc::new(Semaphore::new(1));
        let permit = admission(&gate).unwrap();
        let private = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir_in(private.path()).unwrap();
        let owned_path = staging.path().to_path_buf();
        let (reply, received) = oneshot::channel();
        let (copy_started, copy_ready) = oneshot::channel();
        let (copy_finish, copy_wait) = std::sync::mpsc::channel();
        let (import_started, import_ready) = oneshot::channel();
        let (import_finish, import_wait) = oneshot::channel();
        let operations = Arc::new(AtomicUsize::new(0));
        let started = operations.clone();
        let callback = selection_callback(permit, reply, move |_, permit| async move {
            started.fetch_add(1, Ordering::SeqCst);
            let owned = tauri::async_runtime::spawn_blocking(move || {
                fs::write(staging.path().join("owned.pdf"), b"%PDF-1.7\n").unwrap();
                copy_started.send(()).unwrap();
                copy_wait.recv().unwrap();
                (staging, permit)
            })
            .await
            .unwrap();
            import_started.send(()).unwrap();
            import_wait.await.unwrap();
            drop(owned);
            Ok(empty_result())
        });
        callback(Some(vec![FilePath::Path("picker-owned.pdf".into())]));
        tokio::time::timeout(Duration::from_secs(2), copy_ready)
            .await
            .unwrap()
            .unwrap();
        drop(received);
        assert!(owned_path.join("owned.pdf").exists());
        assert!(admission(&gate).is_err());
        copy_finish.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), import_ready)
            .await
            .unwrap()
            .unwrap();
        assert!(owned_path.join("owned.pdf").exists());
        assert!(admission(&gate).is_err());
        import_finish.send(()).unwrap();
        let _next = tokio::time::timeout(Duration::from_secs(2), gate.clone().acquire_owned())
            .await
            .unwrap()
            .unwrap();
        assert!(!owned_path.exists());
        assert_eq!(operations.load(Ordering::SeqCst), 1);
    }
}
