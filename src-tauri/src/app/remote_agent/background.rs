//! Rust-owned session observation, never mutation replay or a completion receipt.
//! Queue ACKs are not terminal. DSH's session-bound sequence plus a fresh whole
//! turn supplies completion evidence; an initial Idle never does. Unproven idle
//! or failed recovery eventually stops only this observer, leaving the Host and
//! durable operation journal untouched. No prompts or history bodies are kept.
use super::{preflight, RemoteAgentAccounts};
use crate::core::error::AppError;
use crate::features::mobile_background::{
    BackgroundReason, BackgroundWork, MobileBackgroundService,
};
use crate::features::remote_agent::{
    ConnectionRef, EventCursor, EventPayload, HostRef, Mutation, OperationId, OperationOutcome,
    OperationRequest, RemoteAgentService, SessionRef, SessionSnapshot, TaskStatus,
    DEFAULT_PROVIDER_ID,
};
use crate::integration::dsh_remote::provider::DshRemoteProvider;
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;
use tauri::Manager;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const MAX_MONITORS: usize = 8;
fn interrupted() -> AppError {
    AppError::domain(
        "remote_agent_background_stopped",
        "Local session observation was stopped; the remote Host was not cancelled",
    )
}
fn locked<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    // Cleanup must release leases even when a previous owner panicked.
    value
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
#[derive(Clone, Copy)]
struct Policy {
    interval: Duration,
    baseline: Duration,
    read: Duration,
    failures: usize,
    settling: usize,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(25),
            baseline: Duration::from_secs(3),
            read: Duration::from_secs(15),
            failures: 3,
            settling: 6,
        }
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Point {
    stream: String,
    sequence: i64,
}
impl Point {
    fn parse(session: &SessionRef, cursor: &EventCursor) -> Option<Self> {
        // Opaque provider cursors have no general ordering. Only the inspected
        // DSH Harness adapter promises canonical session-bound sequence numbers.
        if session.workspace.host.connection.provider_id.0 != DEFAULT_PROVIDER_ID
            || session.workspace.backend_id.0 != "harness"
        {
            return None;
        }
        let sequence: i64 = cursor.value.parse().ok()?;
        if !(-1..=9_007_199_254_740_991).contains(&sequence) || sequence.to_string() != cursor.value
        {
            return None;
        }
        Some(Self {
            stream: cursor.stream_id.clone(),
            sequence,
        })
    }
}
#[derive(Clone)]
struct Observation {
    status: TaskStatus,
    through: Option<Point>,
    transitions: Vec<(Point, TaskStatus)>,
}
impl Observation {
    fn snapshot(session: &SessionRef, snapshot: SessionSnapshot) -> Result<Self, ReadFailure> {
        if snapshot.info.session != *session {
            return Err(ReadFailure::Namespace);
        }
        let through = snapshot
            .cursor
            .as_ref()
            .and_then(|cursor| Point::parse(session, cursor));
        let mut transitions = Vec::new();
        for event in snapshot.events {
            if event.session != *session {
                return Err(ReadFailure::Namespace);
            }
            if let EventPayload::TaskStatus { status } = event.payload {
                if let Some(point) = event
                    .cursor
                    .as_ref()
                    .and_then(|cursor| Point::parse(session, cursor))
                {
                    if through.as_ref().is_some_and(|end| {
                        point.stream == end.stream && point.sequence <= end.sequence
                    }) {
                        transitions.push((point, status));
                    }
                }
            }
        }
        transitions.sort_by_key(|(point, _)| point.sequence);
        Ok(Self {
            status: snapshot.info.status,
            through,
            transitions,
        })
    }
}
#[derive(Clone, Copy)]
enum ReadFailure {
    Namespace,
    Unavailable,
}
#[async_trait]
trait ObservationSource: Send + Sync {
    async fn read(&self, session: &SessionRef) -> Result<Observation, ReadFailure>;
}
struct NativeSource {
    app: tauri::AppHandle,
}
impl NativeSource {
    async fn check_account(&self, session: &SessionRef) -> Result<(), ReadFailure> {
        let connection = &session.workspace.host.connection;
        if connection.provider_id.0 != DEFAULT_PROVIDER_ID {
            return Ok(());
        }
        let accounts = self.app.state::<RemoteAgentAccounts>();
        let current = accounts.current.lock().await;
        if current
            .account
            .as_ref()
            .is_some_and(|account| account.view.info.connection == *connection)
        {
            Ok(())
        } else {
            Err(ReadFailure::Namespace)
        }
    }
}
#[async_trait]
impl ObservationSource for NativeSource {
    async fn read(&self, session: &SessionRef) -> Result<Observation, ReadFailure> {
        self.check_account(session).await?;
        let accounts = self.app.state::<RemoteAgentAccounts>();
        let provider = self.app.state::<Arc<DshRemoteProvider>>();
        let service = self.app.state::<RemoteAgentService>();
        preflight(&session.workspace.host.connection, &accounts, &provider)
            .await
            .map_err(|_| ReadFailure::Unavailable)?;
        // Native read_session reconnects this exact approved Host when needed.
        // resume/connect may choose a different sorted Host; never call them here.
        let snapshot = service
            .read_session(session)
            .await
            .map_err(|_| ReadFailure::Unavailable)?;
        self.check_account(session).await?;
        Observation::snapshot(session, snapshot)
    }
}

struct MonitorState {
    lease: Option<BackgroundWork>,
    baseline: Option<Point>,
    revision: u64,
    pending: usize,
    operations: HashSet<OperationId>,
    running: bool,
}
struct Monitor {
    session: SessionRef,
    selection_epoch: u64,
    state: Mutex<MonitorState>,
    admission: tokio::sync::Mutex<()>,
    cancelled: CancellationToken,
    wake: Notify,
}
impl Monitor {
    fn stop(&self) {
        self.cancelled.cancel();
        if let Some(lease) = locked(&self.state).lease.as_ref() {
            lease.cancel();
        }
    }
}
struct Registry {
    monitors: HashMap<SessionRef, Arc<Monitor>>,
    selected_host: Option<HostRef>,
    selection_epoch: u64,
    paused: bool,
    closed: bool,
}
impl Registry {
    fn current(&self, monitor: &Arc<Monitor>) -> bool {
        !self.closed
            && !self.paused
            && !monitor.cancelled.is_cancelled()
            && self.selection_epoch == monitor.selection_epoch
            && self.selected_host.as_ref() == Some(&monitor.session.workspace.host)
            && self
                .monitors
                .get(&monitor.session)
                .is_some_and(|current| Arc::ptr_eq(current, monitor))
    }
}
struct Inner {
    registry: Mutex<Registry>,
    common: Arc<MobileBackgroundService>,
    source: Arc<dyn ObservationSource>,
    policy: Policy,
}
impl Inner {
    fn current(&self, monitor: &Arc<Monitor>) -> bool {
        locked(&self.registry).current(monitor)
    }
    fn retire(&self, monitor: &Arc<Monitor>, revision: Option<u64>, force: bool) -> bool {
        let mut registry = locked(&self.registry);
        if !registry
            .monitors
            .get(&monitor.session)
            .is_some_and(|current| Arc::ptr_eq(current, monitor))
        {
            return true;
        }
        let state = locked(&monitor.state);
        if (!force && state.pending > 0)
            || revision.is_some_and(|revision| revision != state.revision)
        {
            return false;
        }
        monitor.cancelled.cancel();
        if let Some(lease) = state.lease.as_ref() {
            lease.cancel();
        }
        registry.monitors.remove(&monitor.session);
        true
    }
    fn stop_matching(&self, connection: Option<&ConnectionRef>) {
        let mut registry = locked(&self.registry);
        if connection.is_some_and(|connection| {
            registry
                .selected_host
                .as_ref()
                .is_some_and(|host| &host.connection == connection)
        }) {
            registry.selected_host = None;
            match registry.selection_epoch.checked_add(1) {
                Some(epoch) => registry.selection_epoch = epoch,
                None => registry.closed = true,
            }
        }
        registry.monitors.retain(|session, monitor| {
            let remove = connection
                .is_none_or(|connection| &session.workspace.host.connection == connection);
            if remove {
                monitor.stop();
            }
            !remove
        });
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        for monitor in locked(&self.registry)
            .monitors
            .drain()
            .map(|(_, monitor)| monitor)
        {
            monitor.stop();
        }
    }
}

pub struct RemoteBackgroundMonitors {
    inner: Arc<Inner>,
}
impl RemoteBackgroundMonitors {
    pub fn new(app: tauri::AppHandle, common: Arc<MobileBackgroundService>) -> Self {
        Self::with_source(common, Arc::new(NativeSource { app }), Policy::default())
    }
    fn with_source(
        common: Arc<MobileBackgroundService>,
        source: Arc<dyn ObservationSource>,
        policy: Policy,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                registry: Mutex::new(Registry {
                    monitors: HashMap::new(),
                    selected_host: None,
                    selection_epoch: 0,
                    paused: false,
                    closed: false,
                }),
                common,
                source,
                policy,
            }),
        }
    }
    /// Foreground admission before execute(SendMessage). Does not own or clone
    /// the prompt; a cancelled/preflight-failed command drops its pending guard.
    pub async fn prepare(
        self: &Arc<Self>,
        request: &OperationRequest,
    ) -> Result<Option<BackgroundTicket>, AppError> {
        let Mutation::SendMessage { session, .. } = &request.mutation else {
            return Ok(None);
        };
        let monitor = {
            let mut registry = locked(&self.inner.registry);
            if registry.closed
                || registry.paused
                || registry.selected_host.as_ref() != Some(&session.workspace.host)
            {
                return Err(interrupted());
            }
            registry.monitors.retain(|_, monitor| {
                let state = locked(&monitor.state);
                !monitor.cancelled.is_cancelled()
                    && !state
                        .lease
                        .as_ref()
                        .is_some_and(|lease| lease.cancellation_token().is_cancelled())
            });
            if !registry.monitors.contains_key(session) && registry.monitors.len() >= MAX_MONITORS {
                return Err(AppError::domain(
                    "remote_agent_background_capacity",
                    "Too many locally observed sessions",
                ));
            }
            let selection_epoch = registry.selection_epoch;
            let monitor = registry
                .monitors
                .entry(session.clone())
                .or_insert_with(|| {
                    Arc::new(Monitor {
                        session: session.clone(),
                        selection_epoch,
                        state: Mutex::new(MonitorState {
                            lease: None,
                            baseline: None,
                            revision: 0,
                            pending: 0,
                            operations: HashSet::new(),
                            running: false,
                        }),
                        admission: tokio::sync::Mutex::new(()),
                        cancelled: CancellationToken::new(),
                        wake: Notify::new(),
                    })
                })
                .clone();
            let mut state = locked(&monitor.state);
            state.pending = state.pending.checked_add(1).ok_or_else(interrupted)?;
            drop(state);
            monitor
        };
        let mut ticket = BackgroundTicket {
            manager: Arc::downgrade(&self.inner),
            monitor: monitor.clone(),
            operation: request.operation_id.clone(),
            baseline: None,
            released: false,
        };
        let _admission = tokio::select! { biased; _ = monitor.cancelled.cancelled() => return Err(interrupted()), owner = monitor.admission.lock() => owner };
        if !self.inner.current(&monitor) {
            return Err(interrupted());
        }
        let needs_lease = locked(&monitor.state).lease.is_none();
        if needs_lease {
            let lease = tokio::select! { biased;
                _ = monitor.cancelled.cancelled() => return Err(interrupted()),
                lease = self.inner.common.track(BackgroundReason::AgentSession) => lease?,
            };
            let registry = locked(&self.inner.registry);
            if !registry.current(&monitor) || lease.cancellation_token().is_cancelled() {
                return Err(interrupted());
            }
            locked(&monitor.state).lease = Some(lease);
        }
        let cancellation = locked(&monitor.state)
            .lease
            .as_ref()
            .ok_or_else(interrupted)?
            .cancellation_token();
        let baseline = tokio::select! { biased;
            _ = monitor.cancelled.cancelled() => return Err(interrupted()),
            _ = cancellation.cancelled() => return Err(interrupted()),
            result = tokio::time::timeout(self.inner.policy.baseline, self.inner.source.read(session)) => result,
        };
        match baseline {
            Ok(Ok(sample)) => ticket.baseline = sample.through,
            Ok(Err(ReadFailure::Namespace)) => {
                monitor.stop();
                return Err(interrupted());
            }
            _ => {} // A bounded failed baseline cannot authorize completion.
        }
        if !self.inner.current(&monitor) || cancellation.is_cancelled() {
            return Err(interrupted());
        }
        Ok(Some(ticket))
    }
    /// Called only after explicit Host fingerprint validation, before changing
    /// pins or transport. Selection and old-ticket invalidation are one fence.
    pub fn select_host(&self, host: &HostRef) {
        let mut registry = locked(&self.inner.registry);
        if registry.closed {
            return;
        }
        match registry.selection_epoch.checked_add(1) {
            Some(epoch) => {
                registry.selection_epoch = epoch;
                registry.selected_host = Some(host.clone());
            }
            None => {
                registry.closed = true;
                registry.selected_host = None;
            }
        }
        for (_, monitor) in registry.monitors.drain() {
            monitor.stop();
        }
    }
    pub fn stop_connection(&self, connection: &ConnectionRef) {
        self.inner.stop_matching(Some(connection));
    }
    /// iOS suspension stops observation, not the Host. Foreground resume only
    /// reopens admission; it never restores old tasks or dispatches a mutation.
    pub fn suspend(&self) {
        locked(&self.inner.registry).paused = true;
        self.inner.stop_matching(None);
    }
    pub fn resume(&self) {
        locked(&self.inner.registry).paused = false;
    }
    pub fn shutdown(&self) {
        locked(&self.inner.registry).closed = true;
        self.inner.stop_matching(None);
    }
}

pub struct BackgroundTicket {
    manager: Weak<Inner>,
    monitor: Arc<Monitor>,
    operation: OperationId,
    baseline: Option<Point>,
    released: bool,
}
impl BackgroundTicket {
    /// No fallible work is exposed after provider admission: accepted/succeeded/
    /// Unknown start local reads; a known rejection simply releases this ticket.
    pub fn finish(mut self, outcome: &OperationOutcome) {
        if matches!(outcome, OperationOutcome::Rejected { .. }) {
            return;
        }
        let Some(manager) = self.manager.upgrade() else {
            return;
        };
        let start = {
            let registry = locked(&manager.registry);
            if !registry.current(&self.monitor) {
                return;
            }
            let mut state = locked(&self.monitor.state);
            if state.operations.insert(self.operation.clone()) {
                let Some(next) = state.revision.checked_add(1) else {
                    self.monitor.cancelled.cancel();
                    return;
                };
                state.revision = next;
                state.baseline = self.baseline.clone();
            }
            let start = !state.running;
            state.running = true;
            start
        };
        self.release_pending();
        if !start {
            self.monitor.wake.notify_one();
        }
        if start {
            let owner = Arc::downgrade(&manager);
            let monitor = self.monitor.clone();
            let source = manager.source.clone();
            let policy = manager.policy;
            tauri::async_runtime::spawn(observe(
                ObserverOwner {
                    manager: owner,
                    monitor,
                },
                source,
                policy,
            ));
        }
    }
    fn release_pending(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let should_retire = {
            let mut state = locked(&self.monitor.state);
            state.pending = state.pending.saturating_sub(1);
            !state.running && state.pending == 0
        };
        if should_retire {
            if let Some(manager) = self.manager.upgrade() {
                manager.retire(&self.monitor, None, false);
            }
        }
    }
}
impl Drop for BackgroundTicket {
    fn drop(&mut self) {
        self.release_pending();
    }
}

fn active(status: &TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Running | TaskStatus::WaitingForPermission | TaskStatus::WaitingForAnswer
    )
}
fn terminal(status: &TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Idle | TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
    )
}
#[derive(PartialEq, Eq, Debug)]
enum ObservationResult {
    Continue,
    FreshTerminal,
    UnprovenSettled,
}
struct Progress {
    floor: Option<Point>,
    started: Option<Point>,
    active_through: Option<Point>,
    first: bool,
    unsettled: usize,
}
impl Progress {
    fn new(floor: Option<Point>) -> Self {
        Self {
            floor,
            started: None,
            active_through: None,
            first: true,
            unsettled: 0,
        }
    }
    fn observe(&mut self, sample: &Observation, settling: usize) -> ObservationResult {
        if active(&sample.status) {
            self.unsettled = 0;
            self.active_through = sample.through.clone();
        } else {
            self.unsettled = self.unsettled.saturating_add(1);
        }
        if self.first && !active(&sample.status) {
            // Even fresh-looking historical turn/end can belong to another queued
            // request completed before this ACK. First Idle never proves ours.
            self.floor = sample.through.clone().or_else(|| self.floor.clone());
            self.first = false;
            return ObservationResult::Continue;
        }
        self.first = false;
        if let (Some(floor), Some(through)) = (&self.floor, &sample.through) {
            if floor.stream != through.stream || through.sequence < floor.sequence {
                self.floor = sample.through.clone();
                self.started = None;
                self.active_through = None;
                return ObservationResult::Continue;
            }
            let mut ended = None;
            for (point, status) in &sample.transitions {
                if point.stream != floor.stream || point.sequence <= floor.sequence {
                    continue;
                }
                if matches!(status, TaskStatus::Running) {
                    self.started = Some(point.clone());
                    ended = None;
                } else if terminal(status)
                    && self
                        .started
                        .as_ref()
                        .is_some_and(|start| point.sequence > start.sequence)
                {
                    ended = Some(point.sequence);
                }
            }
            if terminal(&sample.status)
                && ended.is_some_and(|end| {
                    end <= through.sequence
                        && self.active_through.as_ref().is_none_or(|active| {
                            active.stream == through.stream && end > active.sequence
                        })
                })
            {
                return ObservationResult::FreshTerminal;
            }
        } else {
            self.floor = sample.through.clone();
        }
        if !active(&sample.status) && self.unsettled >= settling {
            ObservationResult::UnprovenSettled
        } else {
            ObservationResult::Continue
        }
    }
}

struct ObserverOwner {
    manager: Weak<Inner>,
    monitor: Arc<Monitor>,
}
impl Drop for ObserverOwner {
    fn drop(&mut self) {
        // Constructed before spawning: even a never-polled, aborted or panicking
        // observer cannot strand a foreground lease in the registry.
        self.monitor.stop();
        if let Some(owner) = self.manager.upgrade() {
            let mut registry = locked(&owner.registry);
            if registry
                .monitors
                .get(&self.monitor.session)
                .is_some_and(|current| Arc::ptr_eq(current, &self.monitor))
            {
                registry.monitors.remove(&self.monitor.session);
            }
        }
    }
}
async fn observe(scope: ObserverOwner, source: Arc<dyn ObservationSource>, policy: Policy) {
    let manager = &scope.manager;
    let monitor = &scope.monitor;
    let cancellation = match locked(&monitor.state).lease.as_ref() {
        Some(lease) => lease.cancellation_token(),
        None => return,
    };
    let mut revision = 0;
    let mut progress = Progress::new(None);
    let mut failures = 0usize;
    loop {
        let (current, baseline) = {
            let state = locked(&monitor.state);
            (state.revision, state.baseline.clone())
        };
        if current != revision {
            revision = current;
            progress = Progress::new(baseline);
            failures = 0;
        }
        if !manager
            .upgrade()
            .is_some_and(|owner| owner.current(monitor))
        {
            break;
        }
        let sample = tokio::select! { biased;
            _ = monitor.cancelled.cancelled() => break,
            _ = cancellation.cancelled() => break,
            value = tokio::time::timeout(policy.read, source.read(&monitor.session)) => value,
        };
        if !manager
            .upgrade()
            .is_some_and(|owner| owner.current(monitor))
        {
            break;
        }
        let (stop, force) = match sample {
            Ok(Ok(sample)) => {
                failures = 0;
                (
                    progress.observe(&sample, policy.settling) != ObservationResult::Continue,
                    false,
                )
            }
            Ok(Err(ReadFailure::Namespace)) => (true, true),
            _ => {
                failures += 1;
                (failures >= policy.failures, true)
            }
        };
        if stop {
            let Some(owner) = manager.upgrade() else {
                break;
            };
            if owner.retire(monitor, Some(revision), force) {
                break;
            }
        }
        tokio::select! { biased;
            _ = monitor.cancelled.cancelled() => break,
            _ = cancellation.cancelled() => break,
            _ = tokio::time::sleep(policy.interval) => {},
            _ = monitor.wake.notified() => {},
        }
    }
    // ObserverOwner releases local work on every exit. Never call execute/cancel,
    // change durable receipts or clear operation IDs.
}

#[cfg(test)]
#[path = "background_tests.rs"]
mod tests;
