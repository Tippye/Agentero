//! Own-container iOS document copies only. No provider URLs, security-scope
//! reconstruction, source deletion, or renderer-supplied paths are accepted here.
//! Call the filesystem opener on a blocking worker after reserving the one slot.
use std::{
    ffi::{CString, OsStr},
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    },
    path::{Component, Path},
    sync::{Arc, Mutex, MutexGuard},
};
use url::Url;

/// An owned descriptor; source locations never become renderer payloads.
pub(crate) struct OpenedPdf {
    pub(crate) file: File,
    pub(crate) display_name: Option<String>,
}

#[derive(Default)]
enum Slot {
    #[default]
    Empty,
    Opening(Arc<()>),
    Ready(Result<OpenedPdf, ()>),
}

/// A reservation also occupies the slot while the blocking open is running.
#[derive(Default)]
pub(crate) struct IosInbox {
    slot: Mutex<Slot>,
}

impl IosInbox {
    fn lock(&self) -> MutexGuard<'_, Slot> {
        self.slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn reserve(self: &Arc<Self>) -> Option<Reservation> {
        let mut slot = self.lock();
        if !matches!(*slot, Slot::Empty) {
            return None;
        }
        // The marker remains alive in the reservation, so a later reservation
        // cannot reuse its allocation while an old owner can still complete.
        let marker = Arc::new(());
        *slot = Slot::Opening(marker.clone());
        Some(Reservation {
            owner: self.clone(),
            marker,
            finished: false,
        })
    }

    pub(crate) fn take(&self) -> Option<Result<OpenedPdf, ()>> {
        let mut slot = self.lock();
        if !matches!(*slot, Slot::Ready(_)) {
            return None;
        }
        match std::mem::replace(&mut *slot, Slot::Empty) {
            Slot::Ready(result) => Some(result),
            _ => unreachable!("the ready slot was checked under the same lock"),
        }
    }
}

pub(crate) struct Reservation {
    owner: Arc<IosInbox>,
    marker: Arc<()>,
    finished: bool,
}

impl Reservation {
    /// True means a document or generic failure is ready and needs a wake hint.
    /// Unrecognized URLs produce None and release the reservation silently.
    pub(crate) fn finish(mut self, result: Option<Result<OpenedPdf, ()>>) -> bool {
        let ready = {
            let mut slot = self.owner.lock();
            if matches!(&*slot, Slot::Opening(current) if Arc::ptr_eq(current, &self.marker)) {
                let ready = result.is_some();
                *slot = result.map_or(Slot::Empty, Slot::Ready);
                ready
            } else {
                false
            }
        };
        self.finished = true;
        ready
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.finished {
            let mut slot = self.owner.lock();
            if matches!(&*slot, Slot::Opening(current) if Arc::ptr_eq(current, &self.marker)) {
                *slot = Slot::Empty;
            }
        }
    }
}

/// `documents` must come from the native app directory API, never the open URL.
/// Only one direct child of its Inbox is eligible. Raw and canonical native
/// directory prefixes accommodate iOS's /var versus /private/var aliases.
/// None means unrelated input; Some(Err(())) means an eligible copy was unreadable.
pub(crate) fn open_inbox_document(documents: &Path, urls: &[Url]) -> Option<Result<OpenedPdf, ()>> {
    if urls.len() != 1 || !documents.is_absolute() {
        return None;
    }
    let url = &urls[0];
    if url.as_str().len() > 32768
        || url.scheme() != "file"
        || url.host_str().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().ends_with('/')
    {
        return None;
    }
    let path = url.to_file_path().ok()?;
    // URI decoding may introduce separators or parent components. Restrict the
    // decoded path as well; the actual open uses only the final single component.
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return None;
    }
    let name = path.file_name()?;
    if !path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        return None;
    }
    let raw_match = path.parent() == Some(documents.join("Inbox").as_path());
    let canonical = match fs::canonicalize(documents) {
        Ok(path) => path,
        Err(_) => return raw_match.then_some(Err(())),
    };
    if !raw_match && path.parent() != Some(canonical.join("Inbox").as_path()) {
        return None;
    }
    Some(open_anchored(&canonical, name).map_err(|_| ()))
}

fn open_anchored(documents: &Path, name: &OsStr) -> io::Result<OpenedPdf> {
    let directory_flags = libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    let documents = OpenOptions::new()
        .read(true)
        .custom_flags(directory_flags)
        .open(documents)?;
    let inbox = open_component(
        &documents,
        OsStr::new("Inbox"),
        libc::O_RDONLY | directory_flags,
    )?;
    let file = open_component(
        &inbox,
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
    )?;
    // Inspect the opened descriptor rather than a separately resolved path;
    // reject non-regular objects and multiple links to the same private inode.
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Inbox copy is not a single-link regular file",
        ));
    }
    Ok(OpenedPdf {
        file,
        display_name: name.to_str().map(str::to_owned),
    })
}

fn open_component(parent: &File, name: &OsStr, flags: libc::c_int) -> io::Result<File> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.contains(&b'/') || bytes == b"." || bytes == b".." {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected one Inbox component",
        ));
    }
    let name = CString::new(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid Inbox component"))?;
    // SAFETY: parent owns a live directory descriptor, the name is exactly one
    // NUL-terminated component, and no create flag requires a variadic mode.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned one newly owned descriptor; File closes it on all
    // subsequent error paths and owns it through the eventual staging reader.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        os::unix::fs::symlink,
        time::{Duration, Instant},
    };
    use tempfile::TempDir;

    fn fixture() -> (TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let documents = directory.path().join("Documents");
        fs::create_dir_all(documents.join("Inbox")).unwrap();
        (directory, documents)
    }

    fn file_url(path: &Path) -> Url {
        Url::from_file_path(path).unwrap()
    }
    fn open(documents: &Path, path: &Path) -> Option<Result<OpenedPdf, ()>> {
        open_inbox_document(documents, &[file_url(path)])
    }

    #[test]
    fn opens_owned_regular_pdf_without_pre_reading_or_requiring_a_header() {
        let (_directory, documents) = fixture();
        let path = documents.join("Inbox/研究.PDF");
        fs::write(
            &path,
            b"not a PDF: the bounded staging reader checks the header",
        )
        .unwrap();
        let mut opened = open(&documents, &path).unwrap().unwrap();
        assert_eq!(opened.display_name.as_deref(), Some("研究.PDF"));
        assert!(opened.file.metadata().unwrap().is_file());
        let mut bytes = Vec::new();
        opened.file.read_to_end(&mut bytes).unwrap();
        assert_eq!(
            bytes,
            b"not a PDF: the bounded staging reader checks the header"
        );
        assert!(path.exists()); // The system-owned source copy is never deleted.
    }

    #[test]
    fn supports_native_directory_alias_and_its_canonical_prefix() {
        let (directory, documents) = fixture();
        let alias = directory.path().join("NativeDocumentsAlias");
        symlink(&documents, &alias).unwrap();
        fs::write(documents.join("Inbox/paper.pdf"), b"%PDF-copy").unwrap();
        assert!(open(&alias, &alias.join("Inbox/paper.pdf"))
            .unwrap()
            .is_ok());
        let canonical = fs::canonicalize(&documents).unwrap();
        assert!(open(&alias, &canonical.join("Inbox/paper.pdf"))
            .unwrap()
            .is_ok());
    }

    #[test]
    fn rejects_unrelated_schemes_authorities_queries_fragments_and_batches() {
        let (_directory, documents) = fixture();
        let path = documents.join("Inbox/paper.pdf");
        fs::write(&path, b"%PDF-copy").unwrap();
        let valid = file_url(&path);
        assert!(open_inbox_document(&documents, &[]).is_none());
        assert!(open_inbox_document(&documents, &[valid.clone(), valid.clone()]).is_none());
        for value in [
            "https://example.org/paper.pdf",
            "file://example.org/Inbox/paper.pdf",
            "agentero://pair",
        ] {
            assert!(open_inbox_document(&documents, &[Url::parse(value).unwrap()]).is_none());
        }
        let mut query = valid.clone();
        query.set_query(Some("access=other"));
        let mut fragment = valid;
        fragment.set_fragment(Some("other"));
        assert!(open_inbox_document(&documents, &[query]).is_none());
        assert!(open_inbox_document(&documents, &[fragment]).is_none());
    }

    #[test]
    fn rejects_siblings_nested_paths_non_pdf_and_decoded_traversal() {
        let (directory, documents) = fixture();
        for path in [
            directory.path().join("DocumentsSibling/Inbox/private.pdf"),
            documents.join("private.pdf"),
            documents.join("Inbox/nested/paper.pdf"),
            documents.join("Inbox/paper.txt"),
        ] {
            assert!(open(&documents, &path).is_none());
        }
        let prefix = Url::from_directory_path(documents.join("Inbox")).unwrap();
        for suffix in [
            "%2e%2e/private.pdf",
            "nested%2fpaper.pdf",
            "nested%2f..%2fpaper.pdf",
            "..%2fprivate.pdf",
        ] {
            assert!(open_inbox_document(&documents, &[prefix.join(suffix).unwrap()]).is_none());
        }
        let overlong = prefix.join(&("a".repeat(32768) + ".pdf")).unwrap();
        assert!(open_inbox_document(&documents, &[overlong]).is_none());
    }

    #[test]
    fn refuses_symbolic_inbox_directory_or_document_and_hard_linked_private_files() {
        let (directory, documents) = fixture();
        let outside = directory.path().join("private.pdf");
        fs::write(&outside, b"private app data").unwrap();
        let linked = documents.join("Inbox/link.pdf");
        symlink(&outside, &linked).unwrap();
        assert!(matches!(open(&documents, &linked), Some(Err(()))));
        let hard_link = documents.join("Inbox/hard.pdf");
        fs::hard_link(&outside, &hard_link).unwrap();
        assert!(matches!(open(&documents, &hard_link), Some(Err(()))));

        let other_documents = directory.path().join("OtherDocuments");
        fs::create_dir(&other_documents).unwrap();
        fs::write(documents.join("Inbox/regular.pdf"), b"%PDF-copy").unwrap();
        symlink(documents.join("Inbox"), other_documents.join("Inbox")).unwrap();
        assert!(matches!(
            open(&other_documents, &other_documents.join("Inbox/regular.pdf")),
            Some(Err(()))
        ));
    }

    #[test]
    fn fifo_and_directory_candidates_fail_without_waiting_for_a_writer() {
        let (_directory, documents) = fixture();
        let fifo = documents.join("Inbox/pipe.pdf");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a valid NUL-terminated path in this test's owned directory.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let before = Instant::now();
        assert!(matches!(open(&documents, &fifo), Some(Err(()))));
        assert!(before.elapsed() < Duration::from_secs(2));
        let subdirectory = documents.join("Inbox/directory.pdf");
        fs::create_dir(&subdirectory).unwrap();
        assert!(matches!(open(&documents, &subdirectory), Some(Err(()))));
    }

    #[test]
    fn descriptor_remains_owned_after_the_original_copy_is_unlinked() {
        let (_directory, documents) = fixture();
        let path = documents.join("Inbox/paper.pdf");
        fs::write(&path, b"%PDF-owned").unwrap();
        let mut opened = open(&documents, &path).unwrap().unwrap();
        fs::remove_file(path).unwrap();
        let mut contents = String::new();
        opened.file.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "%PDF-owned");
    }

    #[test]
    fn eligible_missing_file_is_generic_error_and_other_input_occupies_no_slot() {
        let (_directory, documents) = fixture();
        assert!(matches!(
            open(&documents, &documents.join("Inbox/missing.pdf")),
            Some(Err(()))
        ));
        let missing_documents = documents.join("MissingDocuments");
        assert!(matches!(
            open(
                &missing_documents,
                &missing_documents.join("Inbox/missing.pdf")
            ),
            Some(Err(()))
        ));
        let owner = Arc::new(IosInbox::default());
        assert!(!owner.reserve().unwrap().finish(None));
        assert!(owner.take().is_none());
        assert!(owner.reserve().is_some());
    }

    #[test]
    fn reservation_is_first_wins_while_opening_and_ready_and_take_is_once() {
        let (_directory, documents) = fixture();
        let path = documents.join("Inbox/paper.pdf");
        fs::write(&path, b"%PDF-copy").unwrap();
        let owner = Arc::new(IosInbox::default());
        let reservation = owner.reserve().unwrap();
        assert!(owner.reserve().is_none());
        assert!(owner.take().is_none());
        assert!(reservation.finish(open(&documents, &path)));
        assert!(owner.reserve().is_none());
        assert!(owner.take().unwrap().is_ok());
        assert!(owner.take().is_none());
        let failed = owner.reserve().unwrap();
        assert!(failed.finish(Some(Err(()))));
        assert!(matches!(owner.take(), Some(Err(()))));
        assert!(owner.take().is_none());
    }

    #[test]
    fn abandoned_or_panicked_reservation_releases_only_its_own_opening_slot() {
        let owner = Arc::new(IosInbox::default());
        let reservation = owner.reserve().unwrap();
        drop(reservation);
        assert!(owner.reserve().unwrap().finish(Some(Err(()))));
        assert!(matches!(owner.take(), Some(Err(()))));
        let worker_owner = owner.clone();
        let panic = std::panic::catch_unwind(move || {
            let _reservation = worker_owner.reserve().unwrap();
            panic!("abandoned native opener");
        });
        assert!(panic.is_err());
        assert!(owner.reserve().is_some());
    }
}
