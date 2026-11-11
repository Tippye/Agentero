use super::*;
use crate::features::remote_agent::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Notify;

struct TestDirectory {
    _root: tempfile::TempDir,
    journal: PathBuf,
}
impl TestDirectory {
    fn path(&self) -> &Path {
        &self.journal
    }
}
fn test_directory() -> TestDirectory {
    let root = tempfile::tempdir().unwrap();
    let journal = root.path().join("remote-agent");
    fs::create_dir(&journal).unwrap();
    TestDirectory {
        _root: root,
        journal,
    }
}

fn target() -> SessionRef {
    SessionRef {
        workspace: WorkspaceRef {
            host: HostRef {
                connection: ConnectionRef {
                    provider_id: "journal-test".into(),
                    connection_id: "private-account-one".into(),
                },
                host_id: "host-one".into(),
            },
            backend_id: "harness".into(),
            workspace_id: "workspace-one".into(),
        },
        session_id: "session-one".into(),
    }
}
fn request() -> OperationRequest {
    OperationRequest {
        operation_id: "journal-operation-0001".into(),
        mutation: Mutation::SendMessage {
            session: target(),
            text: "sensitive prompt must not reach SQLite".into(),
            attachments: vec![],
        },
    }
}
fn scope() -> ConnectionRef {
    target().workspace.host.connection
}
fn success() -> OperationOutcome {
    OperationOutcome::Succeeded {
        result: OperationResult::Acknowledged,
    }
}

struct Provider {
    dispatches: AtomicUsize,
    pending: AtomicBool,
    entered: Notify,
    outcome: Mutex<OperationOutcome>,
    receipt: Mutex<ReceiptLookup>,
}
impl Default for Provider {
    fn default() -> Self {
        Self {
            dispatches: AtomicUsize::new(0),
            pending: AtomicBool::new(false),
            entered: Notify::new(),
            outcome: Mutex::new(success()),
            receipt: Mutex::new(ReceiptLookup::NotFound),
        }
    }
}
#[async_trait]
impl RemoteAgentProvider for Provider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            provider_id: "journal-test".into(),
            display_name: "Unit test only".into(),
            contract_version: CONTRACT_VERSION,
            config_version: 1,
        }
    }
    async fn connect(&self, request: &ConnectRequest) -> Result<ConnectionInfo, AppError> {
        Ok(ConnectionInfo {
            connection: request.connection.clone(),
            capabilities: Capabilities {
                operations: vec![
                    Capability::ListHosts,
                    Capability::SendMessage,
                    Capability::OperationReceipts,
                ],
                authentication: vec![],
                backends: vec!["harness".into()],
                attachments: None,
            },
        })
    }
    async fn disconnect(&self, _: &ConnectionRef) -> Result<(), AppError> {
        Ok(())
    }
    async fn list_hosts(&self, _: &ConnectionRef) -> Result<Vec<HostInfo>, AppError> {
        Ok(vec![])
    }
    async fn execute(&self, _: &OperationRequest) -> Result<OperationOutcome, AppError> {
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if self.pending.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        Ok(self.outcome.lock().unwrap().clone())
    }
    async fn lookup_receipt(
        &self,
        _: &ConnectionRef,
        _: &OperationId,
    ) -> Result<ReceiptLookup, AppError> {
        Ok(self.receipt.lock().unwrap().clone())
    }
}
async fn connected(
    journal: Arc<dyn OperationJournal>,
    provider: &Arc<Provider>,
) -> Arc<RemoteAgentService> {
    let service = Arc::new(RemoteAgentService::with_journal(journal));
    service.register(provider.clone()).unwrap();
    service
        .connect(&ConnectRequest {
            connection: scope(),
            config_version: 1,
        })
        .await
        .unwrap();
    service
}
fn sqlite(directory: &Path) -> Arc<SqliteOperationJournal> {
    Arc::new(SqliteOperationJournal::new(directory.to_owned()))
}
fn assert_code<T>(result: Result<T, AppError>, expected: &str) {
    match result {
        Err(error) => assert_eq!(error.code(), expected),
        Ok(_) => panic!("expected {expected}"),
    }
}

#[tokio::test]
async fn restart_restores_locally_without_provider_and_rejects_changed_request_digest() {
    let directory = test_directory();
    let provider = Arc::new(Provider::default());
    let first = connected(sqlite(directory.path()), &provider).await;
    assert_eq!(first.execute(&request()).await.unwrap(), success());
    drop(first);
    let restored = RemoteAgentService::with_journal(sqlite(directory.path()));
    assert_eq!(
        restored
            .local_outcome(&scope(), &request().operation_id)
            .await
            .unwrap(),
        Some(success())
    );
    let entries = restored.local_operations(&scope()).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].request_digest.is_some());
    let mut other = scope();
    other.connection_id = "another-account".into();
    assert!(restored.local_operations(&other).await.unwrap().is_empty());
    restored.register(provider.clone()).unwrap();
    assert_eq!(
        restored.execute(&request()).await.unwrap(),
        success(),
        "recorded result needs no live connection"
    );
    let mut changed = request();
    if let Mutation::SendMessage { text, .. } = &mut changed.mutation {
        *text = "different prompt".into();
    }
    assert_code(
        restored.execute(&changed).await,
        "remote_agent_operation_conflict",
    );
    assert_eq!(provider.dispatches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dropped_provider_future_is_durable_unknown_after_actual_sqlite_reopen() {
    let directory = test_directory();
    let provider = Arc::new(Provider::default());
    provider.pending.store(true, Ordering::SeqCst);
    let service = connected(sqlite(directory.path()), &provider).await;
    let running = service.clone();
    let task = tokio::spawn(async move { running.execute(&request()).await });
    provider.entered.notified().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    drop(service);
    provider.pending.store(false, Ordering::SeqCst);
    let restored = connected(sqlite(directory.path()), &provider).await;
    assert!(matches!(
        restored.execute(&request()).await.unwrap(),
        OperationOutcome::Unknown { .. }
    ));
    assert_eq!(
        restored
            .lookup_receipt(&scope(), &request().operation_id)
            .await
            .unwrap(),
        ReceiptLookup::NotFound
    );
    assert!(matches!(
        restored.local_operations(&scope()).await.unwrap()[0].outcome,
        OperationOutcome::Unknown { .. }
    ));
    assert_eq!(provider.dispatches.load(Ordering::SeqCst), 1);
}

struct FaultJournal {
    inner: Arc<SqliteOperationJournal>,
    fail_reserve: bool,
    fail_update: bool,
    hold_update: bool,
    entered: Notify,
}
#[async_trait]
impl OperationJournal for FaultJournal {
    async fn get(
        &self,
        connection: &ConnectionRef,
        id: &OperationId,
    ) -> Result<Option<JournalEntry>, AppError> {
        self.inner.get(connection, id).await
    }
    async fn list(&self, connection: &ConnectionRef) -> Result<Vec<JournalEntry>, AppError> {
        self.inner.list(connection).await
    }
    async fn reserve(&self, entry: &JournalEntry) -> Result<JournalReservation, AppError> {
        if self.fail_reserve {
            return Err(journal_unavailable());
        }
        self.inner.reserve(entry).await
    }
    async fn update(&self, entry: &JournalEntry) -> Result<JournalEntry, AppError> {
        self.entered.notify_one();
        if self.hold_update {
            std::future::pending::<()>().await;
        }
        if self.fail_update {
            return Err(journal_unavailable());
        }
        self.inner.update(entry).await
    }
}

#[tokio::test]
async fn failed_final_write_returns_ok_unknown_and_restart_cannot_redispatch() {
    let directory = test_directory();
    let provider = Arc::new(Provider::default());
    let fault = Arc::new(FaultJournal {
        inner: sqlite(directory.path()),
        fail_reserve: false,
        fail_update: true,
        hold_update: false,
        entered: Notify::new(),
    });
    let first = connected(fault, &provider).await;
    assert!(
        matches!(
            first.execute(&request()).await.unwrap(),
            OperationOutcome::Unknown { .. }
        ),
        "post-provider failure must never be ApiResultErr/preflight Rejected"
    );
    drop(first);
    let restored = connected(sqlite(directory.path()), &provider).await;
    assert!(matches!(
        restored.execute(&request()).await.unwrap(),
        OperationOutcome::Unknown { .. }
    ));
    assert_eq!(provider.dispatches.load(Ordering::SeqCst), 1);
    *provider.receipt.lock().unwrap() = ReceiptLookup::Found(success());
    assert_eq!(
        restored
            .lookup_receipt(&scope(), &request().operation_id)
            .await
            .unwrap(),
        ReceiptLookup::Found(success())
    );
    drop(restored);
    let offline = RemoteAgentService::with_journal(sqlite(directory.path()));
    assert_eq!(
        offline
            .local_outcome(&scope(), &request().operation_id)
            .await
            .unwrap(),
        Some(success())
    );
}

#[tokio::test]
async fn cancelled_final_write_leaves_the_pre_dispatch_intent_durable() {
    let directory = test_directory();
    let provider = Arc::new(Provider::default());
    let fault = Arc::new(FaultJournal {
        inner: sqlite(directory.path()),
        fail_reserve: false,
        fail_update: false,
        hold_update: true,
        entered: Notify::new(),
    });
    let first = connected(fault.clone(), &provider).await;
    let running = first.clone();
    let task = tokio::spawn(async move { running.execute(&request()).await });
    fault.entered.notified().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    drop(first);
    drop(fault);
    let restored = connected(sqlite(directory.path()), &provider).await;
    assert!(matches!(
        restored.execute(&request()).await.unwrap(),
        OperationOutcome::Unknown { .. }
    ));
    assert_eq!(provider.dispatches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failed_intent_commit_aborts_provider_and_quarantines_the_process_id() {
    let directory = test_directory();
    let provider = Arc::new(Provider::default());
    let fault = Arc::new(FaultJournal {
        inner: sqlite(directory.path()),
        fail_reserve: true,
        fail_update: false,
        hold_update: false,
        entered: Notify::new(),
    });
    let service = connected(fault, &provider).await;
    assert_code(
        service.execute(&request()).await,
        "remote_agent_journal_unavailable",
    );
    assert!(matches!(
        service.execute(&request()).await.unwrap(),
        OperationOutcome::Unknown { .. }
    ));
    assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn concurrent_services_use_one_atomic_durable_reservation() {
    let directory = test_directory();
    drop(SqliteOperationJournal::open(directory.path()).unwrap());
    let provider = Arc::new(Provider::default());
    let (a, b) = (
        connected(sqlite(directory.path()), &provider).await,
        connected(sqlite(directory.path()), &provider).await,
    );
    let operation = request();
    let (a, b) = tokio::join!(a.execute(&operation), b.execute(&operation));
    assert!(a.is_ok());
    assert!(b.is_ok());
    assert_eq!(provider.dispatches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn imported_missing_receipt_survives_restart_and_never_confirms_unknown_arguments() {
    let directory = test_directory();
    let provider = Arc::new(Provider::default());
    let first = connected(sqlite(directory.path()), &provider).await;
    assert_eq!(
        first
            .lookup_receipt(&scope(), &request().operation_id)
            .await
            .unwrap(),
        ReceiptLookup::NotFound
    );
    drop(first);
    let restored = connected(sqlite(directory.path()), &provider).await;
    assert!(matches!(
        restored.execute(&request()).await.unwrap(),
        OperationOutcome::Unknown { .. }
    ));
    *provider.receipt.lock().unwrap() = ReceiptLookup::Found(success());
    restored
        .lookup_receipt(&scope(), &request().operation_id)
        .await
        .unwrap();
    drop(restored);
    let restored = connected(sqlite(directory.path()), &provider).await;
    assert_eq!(
        restored
            .local_outcome(&scope(), &request().operation_id)
            .await
            .unwrap(),
        Some(success())
    );
    assert!(
        matches!(
            restored.execute(&request()).await.unwrap(),
            OperationOutcome::Unknown { .. }
        ),
        "receipt without digest cannot confirm these arguments"
    );
    assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn foreign_receipt_cannot_replace_durable_uncertainty() {
    let directory = test_directory();
    let provider = Arc::new(Provider::default());
    let journal = sqlite(directory.path());
    journal
        .reserve(&JournalEntry::intent(&request()).unwrap())
        .await
        .unwrap();
    let service = connected(journal, &provider).await;
    let mut foreign = target();
    foreign.workspace.host.connection.connection_id = "foreign-account".into();
    *provider.receipt.lock().unwrap() = ReceiptLookup::Found(OperationOutcome::Succeeded {
        result: OperationResult::SessionCreated { session: foreign },
    });
    assert_code(
        service
            .lookup_receipt(&scope(), &request().operation_id)
            .await,
        "remote_agent_namespace",
    );
    drop(service);
    let restored = RemoteAgentService::with_journal(sqlite(directory.path()));
    assert!(matches!(
        restored
            .local_outcome(&scope(), &request().operation_id)
            .await
            .unwrap(),
        Some(OperationOutcome::Unknown { .. })
    ));
    assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn lazy_journal_failure_does_not_disable_read_only_provider_operations() {
    let directory = test_directory();
    let unavailable = directory.path().join("not-a-directory");
    fs::write(&unavailable, b"existing private file").unwrap();
    let provider = Arc::new(Provider::default());
    let service = connected(sqlite(&unavailable), &provider).await;
    assert!(service.list_hosts(&scope()).await.unwrap().is_empty());
    assert!(service.execute(&request()).await.is_err());
    assert!(service.local_operations(&scope()).await.is_err());
    assert!(service.list_hosts(&scope()).await.unwrap().is_empty());
    assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read(unavailable).unwrap(), b"existing private file");
}

#[tokio::test]
async fn managed_database_or_marker_loss_never_creates_empty_history() {
    for name in [DATABASE, GUARD] {
        let directory = test_directory();
        let journal = sqlite(directory.path());
        journal
            .reserve(&JournalEntry::intent(&request()).unwrap())
            .await
            .unwrap();
        drop(journal);
        let removed = if name == GUARD {
            guard_path(directory.path()).unwrap()
        } else {
            directory.path().join(name)
        };
        assert!(removed.is_absolute());
        fs::remove_file(&removed).unwrap();
        let restored = sqlite(directory.path());
        assert!(restored
            .get(&scope(), &request().operation_id)
            .await
            .is_err());
        assert!(
            !removed.exists(),
            "missing managed storage must not be recreated"
        );
    }
}

#[tokio::test]
async fn loss_of_the_entire_managed_directory_cannot_enable_replayed_operations() {
    let directory = test_directory();
    let journal = sqlite(directory.path());
    journal
        .reserve(&JournalEntry::intent(&request()).unwrap())
        .await
        .unwrap();
    drop(journal);
    assert!(directory.path().is_absolute() && directory.path().ends_with("remote-agent"));
    fs::remove_dir_all(directory.path()).unwrap();
    let provider = Arc::new(Provider::default());
    let restored = connected(sqlite(directory.path()), &provider).await;
    assert!(restored.execute(&request()).await.is_err());
    assert!(!directory.path().exists());
    assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn future_schema_corrupt_rows_and_namespace_tampering_fail_closed() {
    for damage in [
        "future-schema",
        "future-record",
        "foreign-namespace",
        "extra-field",
        "bad-digest",
        "corrupt-file",
    ] {
        let directory = test_directory();
        let journal = sqlite(directory.path());
        journal
            .reserve(&JournalEntry::intent(&request()).unwrap())
            .await
            .unwrap();
        drop(journal);
        let path = directory.path().join(DATABASE);
        if damage == "corrupt-file" {
            fs::write(&path, b"corrupt SQLite bytes").unwrap();
        } else {
            let database = Connection::open(&path).unwrap();
            if damage == "future-schema" {
                database.pragma_update(None, "user_version", 2).unwrap();
            } else {
                let raw: String = database
                    .query_row("SELECT record FROM operations", [], |row| row.get(0))
                    .unwrap();
                let mut value: serde_json::Value = serde_json::from_str(&raw).unwrap();
                match damage {
                    "future-record" => value["version"] = 2.into(),
                    "foreign-namespace" => {
                        value["connection"]["connectionId"] = "other-account".into()
                    }
                    "extra-field" => value["unexpectedPrompt"] = "not allowed".into(),
                    "bad-digest" => value["requestDigest"] = "bad".into(),
                    _ => unreachable!(),
                }
                database
                    .execute("UPDATE operations SET record=?1", [value.to_string()])
                    .unwrap();
            }
        }
        let provider = Arc::new(Provider::default());
        let service = connected(sqlite(directory.path()), &provider).await;
        assert!(service.execute(&request()).await.is_err(), "{damage}");
        assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn journal_stores_only_digest_typed_references_and_sanitized_outcomes() {
    let directory = test_directory();
    let journal = sqlite(directory.path());
    let mut operations = vec![request()];
    for mutation in [
        Mutation::CreateSession {
            workspace: target().workspace,
            title: Some("private title sentinel".into()),
        },
        Mutation::RespondQuestion {
            session: target(),
            request_id: "question-reference".into(),
            answers: vec![QuestionAnswer {
                question_id: "q1".into(),
                selected: vec!["private selection sentinel".into()],
                custom: Some("private answer sentinel".into()),
            }],
        },
        Mutation::UploadAttachment {
            upload: AttachmentUpload {
                session: target(),
                local_path: "/private/attachment-secret-sentinel.pdf".into(),
                file_name: "private-filename-sentinel.pdf".into(),
                mime_type: "application/pdf".into(),
                size_bytes: 123,
            },
        },
    ] {
        operations.push(OperationRequest {
            operation_id: format!("privacy-operation-{:04}", operations.len())
                .as_str()
                .into(),
            mutation,
        });
    }
    for operation in &operations {
        journal
            .reserve(&JournalEntry::intent(operation).unwrap())
            .await
            .unwrap();
    }
    let provider = Arc::new(Provider::default());
    *provider.outcome.lock().unwrap() = OperationOutcome::Rejected {
        code: "sensitive-provider-error-sentinel".into(),
        message: "sensitive-provider-error-sentinel".into(),
    };
    let service = connected(journal.clone(), &provider).await;
    let mut rejected = request();
    rejected.operation_id = "rejected-operation-0001".into();
    assert!(matches!(
        service.execute(&rejected).await.unwrap(),
        OperationOutcome::Rejected { .. }
    ));
    let bytes = fs::read(directory.path().join(DATABASE)).unwrap();
    let text = String::from_utf8_lossy(&bytes);
    for forbidden in [
        "sensitive prompt must not reach SQLite",
        "private title sentinel",
        "private selection sentinel",
        "private answer sentinel",
        "attachment-secret-sentinel",
        "private-filename-sentinel",
        "sensitive-provider-error-sentinel",
    ] {
        assert!(!text.contains(forbidden), "journal leaked {forbidden}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in [
            directory.path().join(DATABASE),
            guard_path(directory.path()).unwrap(),
        ] {
            assert_eq!(
                fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(
            fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[tokio::test]
async fn definitive_outcomes_are_not_downgraded_by_later_uncertain_receipts() {
    let directory = test_directory();
    let provider = Arc::new(Provider::default());
    let service = connected(sqlite(directory.path()), &provider).await;
    assert_eq!(service.execute(&request()).await.unwrap(), success());
    *provider.receipt.lock().unwrap() = ReceiptLookup::Found(unknown_outcome());
    assert_eq!(
        service
            .lookup_receipt(&scope(), &request().operation_id)
            .await
            .unwrap(),
        ReceiptLookup::Found(success())
    );
    drop(service);
    assert_eq!(
        sqlite(directory.path())
            .get(&scope(), &request().operation_id)
            .await
            .unwrap()
            .unwrap()
            .outcome,
        success()
    );
}
