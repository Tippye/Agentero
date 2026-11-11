//! App-private SQLite operation identity. No Vault files or request bodies.
use crate::core::error::AppError;
use crate::features::remote_agent::{
    journal_unavailable, merge_journal_update, ConnectionRef, JournalEntry, JournalReservation,
    OperationId, OperationJournal, OperationOutcome,
};
use async_trait::async_trait;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const DATABASE: &str = "operations.sqlite";
const GUARD: &str = "operations.guard";
const GUARD_VALUE: &[u8] = b"remote-agent-journal-v1\n";
const APPLICATION_ID: i64 = 0x41524f4a;
const SCHEMA: &str = "CREATE TABLE operations (
    provider TEXT NOT NULL,
    connection TEXT NOT NULL,
    operation TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY(provider, connection, operation)
) STRICT, WITHOUT ROWID";

fn invalid() -> AppError {
    AppError::domain(
        "remote_agent_journal_invalid",
        "The local operation journal requires repair; no new operation was dispatched",
    )
}

#[derive(Default)]
struct Health {
    quarantined: bool,
    validated: bool,
}
struct State {
    directory: PathBuf,
    health: Mutex<Health>,
}
#[derive(Clone)]
pub struct SqliteOperationJournal {
    state: Arc<State>,
}

impl SqliteOperationJournal {
    /// No filesystem IO at startup: unavailable/corrupt journals fail closed on
    /// operation APIs without disabling read-only Hosts, history or the app.
    pub fn new(private_directory: PathBuf) -> Self {
        Self {
            state: Arc::new(State {
                directory: private_directory,
                health: Mutex::new(Health::default()),
            }),
        }
    }
    /// Optional eager validation for tests/tooling. Production can use `new`.
    pub fn open(private_directory: &Path) -> Result<Self, AppError> {
        let journal = Self::new(private_directory.to_owned());
        let _database = open_database(private_directory, true)?;
        journal
            .state
            .health
            .lock()
            .map_err(|_| journal_unavailable())?
            .validated = true;
        Ok(journal)
    }
    async fn run<T: Send + 'static>(
        &self,
        mutation: bool,
        operation: impl FnOnce(&mut Connection) -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || {
            let mut health = state.health.lock().map_err(|_| journal_unavailable())?;
            if health.quarantined {
                return Err(journal_unavailable());
            }
            let result = (|| {
                let mut database = open_database(&state.directory, !health.validated)?;
                health.validated = true;
                let result = operation(&mut database)?;
                if mutation {
                    sync_database(&state.directory)?;
                }
                Ok(result)
            })();
            // A failed COMMIT/fsync can leave an uncertain cached SQLite state.
            // Do not read it as durable within this adapter's lifetime.
            if mutation && result.is_err() {
                health.quarantined = true;
            }
            result
        })
        .await
        .map_err(|_| journal_unavailable())?
    }
}

fn sync_directory(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| journal_unavailable())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn ensure_directory(path: &Path) -> Result<(), AppError> {
    if !path.is_absolute() {
        return Err(journal_unavailable());
    }
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        match current.symlink_metadata() {
            Ok(meta) => {
                if !meta.is_dir() || meta.file_type().is_symlink() {
                    return Err(invalid());
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(current.to_owned());
                current = current.parent().ok_or_else(journal_unavailable)?;
            }
            Err(_) => return Err(journal_unavailable()),
        }
    }
    fs::create_dir_all(path).map_err(|_| journal_unavailable())?;
    if path
        .symlink_metadata()
        .map_err(|_| journal_unavailable())?
        .file_type()
        .is_symlink()
    {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| journal_unavailable())?;
    }
    for directory in missing.iter().rev() {
        sync_directory(directory)?;
        if let Some(parent) = directory.parent() {
            sync_directory(parent)?;
        }
    }
    sync_directory(path)
}
fn regular(path: &Path) -> Result<bool, AppError> {
    match path.symlink_metadata() {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(invalid()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(journal_unavailable()),
    }
}
fn connection(path: &Path) -> Result<Connection, AppError> {
    let database = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| journal_unavailable())?;
    database
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| journal_unavailable())?;
    database
        .execute_batch(
            "PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;",
        )
        .map_err(|_| journal_unavailable())?;
    Ok(database)
}
fn guard_path(directory: &Path) -> Result<PathBuf, AppError> {
    let parent = directory.parent().ok_or_else(journal_unavailable)?;
    let name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(journal_unavailable)?;
    Ok(parent.join(format!(".{name}.{GUARD}")))
}
fn open_database(directory: &Path, check_integrity: bool) -> Result<Connection, AppError> {
    if !directory.is_absolute() {
        return Err(journal_unavailable());
    }
    let guard = guard_path(directory)?;
    let has_guard = regular(&guard)?;
    // The marker is outside the operation directory so loss of that entire
    // managed directory cannot silently create a new dispatchable history.
    if has_guard && !directory.try_exists().map_err(|_| journal_unavailable())? {
        return Err(journal_unavailable());
    }
    ensure_directory(directory)?;
    let path = directory.join(DATABASE);
    let has_database = regular(&path)?;
    match (has_guard, has_database) {
        (true, false) => return Err(journal_unavailable()),
        (false, true) => return Err(invalid()),
        (false, false) => {
            // Durable managed marker precedes DB creation. Interrupted creation
            // can fail closed, but never silently manufacture an empty history.
            agentero_core::fs::atomic_write_with(
                &guard,
                GUARD_VALUE,
                &agentero_core::fs::AtomicOpts {
                    unix_mode: Some(0o600),
                    sync_file: true,
                    ..Default::default()
                },
            )
            .map_err(|_| journal_unavailable())?;
            sync_directory(guard.parent().ok_or_else(journal_unavailable)?)?;
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(&path)
                .and_then(|file| file.sync_all())
                .map_err(|_| journal_unavailable())?;
            sync_directory(directory)?;
            let mut database = connection(&path)?;
            let transaction = database
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| journal_unavailable())?;
            transaction
                .execute_batch(SCHEMA)
                .map_err(|_| journal_unavailable())?;
            transaction
                .pragma_update(None, "application_id", APPLICATION_ID)
                .map_err(|_| journal_unavailable())?;
            transaction
                .pragma_update(None, "user_version", 1)
                .map_err(|_| journal_unavailable())?;
            transaction.commit().map_err(|_| journal_unavailable())?;
            sync_database(directory)?;
        }
        (true, true) => {}
    }
    if fs::metadata(&guard)
        .map_err(|_| journal_unavailable())?
        .len()
        != GUARD_VALUE.len() as u64
        || fs::read(&guard).map_err(|_| journal_unavailable())? != GUARD_VALUE
    {
        return Err(invalid());
    }
    let mut header = [0u8; 16];
    fs::File::open(&path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|_| invalid())?;
    if &header != b"SQLite format 3\0" {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in [&path, &guard] {
            fs::set_permissions(file, fs::Permissions::from_mode(0o600))
                .map_err(|_| journal_unavailable())?;
        }
    }
    let database = connection(&path)?;
    let version: i64 = database
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| invalid())?;
    let application: i64 = database
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|_| invalid())?;
    if version != 1 || application != APPLICATION_ID {
        return Err(invalid());
    }
    let mode: String = database
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|_| invalid())?;
    if mode != "delete" {
        return Err(invalid());
    }
    let tables: Vec<(String, String)> = database
        .prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
        .map_err(|_| invalid())?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|_| invalid())?
        .collect::<Result<_, _>>()
        .map_err(|_| invalid())?;
    if tables != vec![("operations".into(), "table".into())] {
        return Err(invalid());
    }
    let definition: String = database
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='operations'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| invalid())?;
    if definition != SCHEMA {
        return Err(invalid());
    }
    if check_integrity {
        let check: String = database
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|_| invalid())?;
        if check != "ok" {
            return Err(invalid());
        }
    }
    Ok(database)
}
fn sync_database(directory: &Path) -> Result<(), AppError> {
    fs::File::open(directory.join(DATABASE))
        .and_then(|file| file.sync_all())
        .map_err(|_| journal_unavailable())?;
    sync_directory(directory)
}
fn decode(
    raw: String,
    connection: &ConnectionRef,
    id: &OperationId,
) -> Result<JournalEntry, AppError> {
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let entry: JournalEntry = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    // Nested contract refs predate this store and permit unknown fields. Require
    // an exact typed round-trip so partial/future nested records cannot downgrade.
    if serde_json::to_value(&entry).map_err(|_| invalid())? != value {
        return Err(invalid());
    }
    entry.validate().map_err(|_| invalid())?;
    if &entry.connection != connection || &entry.operation_id != id {
        return Err(invalid());
    }
    Ok(entry)
}
fn get(
    database: &Connection,
    connection: &ConnectionRef,
    id: &OperationId,
) -> Result<Option<JournalEntry>, AppError> {
    let raw: Option<String> = database
        .query_row(
            "SELECT record FROM operations WHERE provider=?1 AND connection=?2 AND operation=?3",
            params![connection.provider_id.0, connection.connection_id.0, id.0],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| journal_unavailable())?;
    raw.map(|raw| decode(raw, connection, id)).transpose()
}

#[async_trait]
impl OperationJournal for SqliteOperationJournal {
    async fn get(
        &self,
        connection: &ConnectionRef,
        id: &OperationId,
    ) -> Result<Option<JournalEntry>, AppError> {
        let (connection, id) = (connection.clone(), id.clone());
        self.run(false, move |database| get(database, &connection, &id))
            .await
    }
    async fn list(&self, connection: &ConnectionRef) -> Result<Vec<JournalEntry>, AppError> {
        let connection = connection.clone();
        self.run(false, move |database| {
            let rows: Vec<(String, String)> = database.prepare("SELECT operation,record FROM operations WHERE provider=?1 AND connection=?2 ORDER BY operation").map_err(|_| journal_unavailable())?
                .query_map(params![connection.provider_id.0, connection.connection_id.0], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|_| journal_unavailable())?
                .collect::<Result<_, _>>().map_err(|_| journal_unavailable())?;
            rows.into_iter().map(|(id, raw)| decode(raw, &connection, &OperationId(id))).collect()
        }).await
    }
    async fn reserve(&self, entry: &JournalEntry) -> Result<JournalReservation, AppError> {
        entry.validate()?;
        if !matches!(entry.outcome, OperationOutcome::Unknown { .. }) {
            return Err(invalid());
        }
        let entry = entry.clone();
        self.run(true, move |database| {
            let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| journal_unavailable())?;
            if let Some(previous) = get(&transaction, &entry.connection, &entry.operation_id)? {
                transaction.commit().map_err(|_| journal_unavailable())?;
                return Ok(JournalReservation { inserted: false, entry: previous });
            }
            transaction.execute("INSERT INTO operations(provider,connection,operation,record) VALUES (?1,?2,?3,?4)",
                params![entry.connection.provider_id.0, entry.connection.connection_id.0, entry.operation_id.0, serde_json::to_string(&entry).map_err(|_| invalid())?]).map_err(|_| journal_unavailable())?;
            transaction.commit().map_err(|_| journal_unavailable())?;
            Ok(JournalReservation { inserted: true, entry })
        }).await
    }
    async fn update(&self, entry: &JournalEntry) -> Result<JournalEntry, AppError> {
        entry.validate()?;
        let entry = entry.clone();
        self.run(true, move |database| {
            let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| journal_unavailable())?;
            let previous = get(&transaction, &entry.connection, &entry.operation_id)?.ok_or_else(invalid)?;
            let updated = merge_journal_update(&previous, &entry)?;
            transaction.execute("UPDATE operations SET record=?4 WHERE provider=?1 AND connection=?2 AND operation=?3",
                params![updated.connection.provider_id.0, updated.connection.connection_id.0, updated.operation_id.0, serde_json::to_string(&updated).map_err(|_| invalid())?]).map_err(|_| journal_unavailable())?;
            transaction.commit().map_err(|_| journal_unavailable())?;
            Ok(updated)
        }).await
    }
}

#[cfg(test)]
#[path = "remote_agent_journal_tests.rs"]
mod tests;
