//! Rust-owned work lifetimes. Native state remains an observation, never a
//! promise manufactured from work counts. Only the actor owns apply futures.
use crate::core::error::AppError;
use async_trait::async_trait;
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, MutexGuard, Weak,
};
use tauri_plugin_agentero_mobile::{BackgroundCounts, BackgroundSettingsTarget, BackgroundState};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

const MAX_WORK: usize = 128;
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackgroundReason {
    AgentSession,
    Sync,
    Transfer,
}

#[async_trait]
pub trait BackgroundDriver: Send + Sync {
    async fn state(&self) -> Result<BackgroundState, AppError>;
    async fn apply(&self, counts: BackgroundCounts) -> Result<BackgroundState, AppError>;
    async fn configure(&self, enabled: bool) -> Result<BackgroundState, AppError>;
    async fn request_notifications(&self) -> Result<BackgroundState, AppError>;
    async fn open_settings(
        &self,
        target: BackgroundSettingsTarget,
    ) -> Result<BackgroundState, AppError>;
}

fn closed() -> AppError {
    AppError::domain(
        "mobile_background_closed",
        "Background work tracking is closed",
    )
}
fn unavailable() -> AppError {
    AppError::domain(
        "mobile_background_unavailable",
        "Native background control could not be confirmed",
    )
}
fn exhausted() -> AppError {
    AppError::domain(
        "mobile_background_exhausted",
        "Background work generation is exhausted",
    )
}
fn advance_generation(counter: &AtomicU64) -> Result<u64, AppError> {
    // Reserve u64::MAX for a final zero snapshot; never wrap or publish nonzero
    // work at the last generation, which could no longer be released.
    counter
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
            if current < u64::MAX - 1 {
                Some(current + 1)
            } else {
                None
            }
        })
        .map(|previous| previous + 1)
        .map_err(|_| exhausted())
}
fn next_generation() -> Result<u64, AppError> {
    advance_generation(&GENERATION)
}
fn terminal_generation() -> u64 {
    GENERATION.fetch_max(u64::MAX, Ordering::SeqCst);
    u64::MAX
}

struct WorkEntry {
    reason: BackgroundReason,
    cancellation: CancellationToken,
}
struct Book {
    works: BTreeMap<u64, WorkEntry>,
    desired: BackgroundCounts,
    pending_finite_reset: Option<u64>,
    closed: bool,
}
impl Book {
    fn counts(&self, generation: u64) -> Result<BackgroundCounts, AppError> {
        let mut counts = BackgroundCounts {
            generation: generation.to_string(),
            ..Default::default()
        };
        for work in self.works.values() {
            let count = match work.reason {
                BackgroundReason::AgentSession => &mut counts.agent_count,
                BackgroundReason::Sync => &mut counts.sync_count,
                BackgroundReason::Transfer => &mut counts.transfer_count,
            };
            *count = count.checked_add(1).ok_or_else(exhausted)?;
        }
        Ok(counts)
    }
    fn publish(&mut self) -> u64 {
        match next_generation()
            .and_then(|generation| self.counts(generation).map(|counts| (generation, counts)))
        {
            Ok((generation, counts)) => {
                self.desired = counts;
                generation
            }
            Err(_) => self.fail_closed(),
        }
    }
    fn fail_closed(&mut self) -> u64 {
        self.closed = true;
        self.pending_finite_reset = None;
        for (_, work) in std::mem::take(&mut self.works) {
            work.cancellation.cancel();
        }
        let generation = terminal_generation();
        self.desired = BackgroundCounts {
            generation: generation.to_string(),
            ..Default::default()
        };
        generation
    }
}
struct Shared {
    book: Mutex<Book>,
}
impl Shared {
    fn lock(&self) -> MutexGuard<'_, Book> {
        // Drop cannot panic or strand a native lease after a poisoned lock.
        self.book
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn release(&self, id: u64, updates: &watch::Sender<u64>) {
        let mut book = self.lock();
        if book.works.remove(&id).is_none() || book.closed {
            return;
        }
        let generation = book.publish();
        updates.send_replace(generation);
    }
    fn cancel(&self, finite_only: bool, updates: &watch::Sender<u64>) {
        let mut book = self.lock();
        if book.closed {
            return;
        }
        let ids: Vec<_> = book
            .works
            .iter()
            .filter_map(|(id, work)| {
                (if finite_only {
                    work.reason != BackgroundReason::AgentSession
                } else {
                    work.reason == BackgroundReason::AgentSession
                })
                .then_some(*id)
            })
            .collect();
        if ids.is_empty() && !finite_only {
            return;
        }
        for id in ids {
            if let Some(work) = book.works.remove(&id) {
                work.cancellation.cancel();
            }
        }
        let generation = book.publish();
        if finite_only && !book.closed {
            book.pending_finite_reset = Some(generation);
        }
        updates.send_replace(generation);
    }
    fn close(&self, updates: &watch::Sender<u64>) -> u64 {
        let mut book = self.lock();
        if book.closed {
            return book.desired.generation.parse().unwrap_or(u64::MAX);
        }
        book.closed = true;
        book.pending_finite_reset = None;
        for (_, work) in std::mem::take(&mut book.works) {
            work.cancellation.cancel();
        }
        let generation = book.publish();
        updates.send_replace(generation);
        generation
    }
}
#[derive(Clone, Copy, Default)]
struct Progress {
    generation: u64,
    failed: bool,
    stopped: bool,
}

pub struct MobileBackgroundService {
    driver: Arc<dyn BackgroundDriver>,
    shared: Arc<Shared>,
    updates: watch::Sender<u64>,
    progress: watch::Receiver<Progress>,
}
impl MobileBackgroundService {
    pub fn new(driver: Arc<dyn BackgroundDriver>) -> Arc<Self> {
        let mut book = Book {
            works: BTreeMap::new(),
            desired: BackgroundCounts::default(),
            pending_finite_reset: None,
            closed: false,
        };
        let generation = book.publish();
        let shared = Arc::new(Shared {
            book: Mutex::new(book),
        });
        let (updates, receiver) = watch::channel(generation);
        let (progress, observed) = watch::channel(Progress::default());
        // No Arc<Service> or Sender is captured: dropping the owner closes the
        // book, and the one bounded actor exits after its final zero attempt.
        tauri::async_runtime::spawn(apply_actor(
            driver.clone(),
            shared.clone(),
            receiver,
            progress,
        ));
        Arc::new(Self {
            driver,
            shared,
            updates,
            progress: observed,
        })
    }
    fn ensure_open(&self) -> Result<(), AppError> {
        if self.shared.lock().closed {
            Err(closed())
        } else {
            Ok(())
        }
    }
    pub async fn state(&self) -> Result<BackgroundState, AppError> {
        // Never cache an apply acknowledgement: an older acknowledgement may
        // finish after desired work changed. Ask the native owner for its state.
        self.driver.state().await
    }
    pub async fn configure(&self, enabled: bool) -> Result<BackgroundState, AppError> {
        self.ensure_open()?;
        self.driver.configure(enabled).await
    }
    pub async fn request_notifications(&self) -> Result<BackgroundState, AppError> {
        self.ensure_open()?;
        self.driver.request_notifications().await
    }
    pub async fn open_settings(
        &self,
        target: BackgroundSettingsTarget,
    ) -> Result<BackgroundState, AppError> {
        self.ensure_open()?;
        self.driver.open_settings(target).await
    }
    pub async fn track(
        self: &Arc<Self>,
        reason: BackgroundReason,
    ) -> Result<BackgroundWork, AppError> {
        let (work, generation) = {
            let mut book = self.shared.lock();
            if book.closed {
                return Err(closed());
            }
            if book.works.len() >= MAX_WORK {
                return Err(AppError::domain(
                    "mobile_background_capacity",
                    "Too many active background work items",
                ));
            }
            let generation = match next_generation() {
                Ok(generation) => generation,
                Err(error) => {
                    book.closed = true;
                    let final_generation = book.publish();
                    self.updates.send_replace(final_generation);
                    return Err(error);
                }
            };
            let cancellation = CancellationToken::new();
            book.works.insert(
                generation,
                WorkEntry {
                    reason,
                    cancellation: cancellation.clone(),
                },
            );
            book.desired = book.counts(generation)?;
            self.updates.send_replace(generation);
            (
                BackgroundWork {
                    shared: Arc::downgrade(&self.shared),
                    updates: self.updates.clone(),
                    id: generation,
                    cancellation,
                },
                generation,
            )
        };
        // The guard already exists here. Aborting this admission future drops it
        // and queues a higher-generation release while the actor finishes apply.
        self.wait_attempt(generation).await?;
        if self.shared.lock().closed {
            return Err(closed());
        }
        if work.cancellation.is_cancelled() {
            return Err(AppError::domain(
                "mobile_background_cancelled",
                "Background work expired before admission completed",
            ));
        }
        // Unsupported/off/native-error acknowledgements do not prevent ordinary
        // foreground work. OS availability is reported only by native state().
        Ok(work)
    }
    async fn wait_attempt(&self, generation: u64) -> Result<Progress, AppError> {
        let mut progress = self.progress.clone();
        loop {
            let current = *progress.borrow_and_update();
            if current.generation >= generation {
                return Ok(current);
            }
            if current.stopped || progress.changed().await.is_err() {
                return Err(closed());
            }
        }
    }
    pub fn expire_finite(&self) {
        self.shared.cancel(true, &self.updates);
    }
    /// The lifecycle caller invokes this only for platforms that suspend local
    /// Agent monitoring (iOS). It never requests cancellation of a remote Host.
    pub fn suspend(&self) {
        self.shared.cancel(false, &self.updates);
    }
    pub async fn shutdown(&self) -> Result<(), AppError> {
        let generation = self.shared.close(&self.updates);
        let mut progress = self.progress.clone();
        loop {
            let current = *progress.borrow_and_update();
            if current.stopped {
                return if current.generation >= generation && !current.failed {
                    Ok(())
                } else {
                    Err(unavailable())
                };
            }
            progress.changed().await.map_err(|_| unavailable())?;
        }
    }
}
impl Drop for MobileBackgroundService {
    fn drop(&mut self) {
        self.shared.close(&self.updates);
    }
}

pub struct BackgroundWork {
    shared: Weak<Shared>,
    updates: watch::Sender<u64>,
    id: u64,
    cancellation: CancellationToken,
}
impl BackgroundWork {
    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    pub fn cancel(&self) {
        self.cancellation.cancel();
        if let Some(shared) = self.shared.upgrade() {
            shared.release(self.id, &self.updates);
        }
    }
}
impl Drop for BackgroundWork {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(shared) = self.shared.upgrade() {
            shared.release(self.id, &self.updates);
        }
    }
}

async fn apply_actor(
    driver: Arc<dyn BackgroundDriver>,
    shared: Arc<Shared>,
    mut updates: watch::Receiver<u64>,
    progress: watch::Sender<Progress>,
) {
    let mut attempted = 0;
    loop {
        let (counts, finite_reset) = {
            let mut book = shared.lock();
            if let Some(epoch) = book.pending_finite_reset.filter(|_| !book.closed) {
                match next_generation().and_then(|generation| book.counts(generation)) {
                    Ok(mut counts) => {
                        // Expired UIKit counts must cross zero before any fresh
                        // finite work. Ordinary watch coalescing cannot skip it.
                        counts.sync_count = 0;
                        counts.transfer_count = 0;
                        (counts, Some(epoch))
                    }
                    Err(_) => {
                        book.fail_closed();
                        (book.desired.clone(), None)
                    }
                }
            } else {
                (book.desired.clone(), None)
            }
        };
        let generation = counts.generation.parse::<u64>().unwrap_or(u64::MAX);
        if generation > attempted {
            // Driver bounds native calls. Do not select on caller cancellation:
            // even unknown native completion is followed by the newer snapshot.
            let failed = driver.apply(counts).await.is_err();
            attempted = generation;
            if let Some(epoch) = finite_reset {
                {
                    let mut book = shared.lock();
                    if book.pending_finite_reset == Some(epoch) {
                        book.pending_finite_reset = None;
                    }
                    // Never admit waiting work from the zero-barrier acknowledgement,
                    // even though its generation is newer than that work's ID.
                    // Rebase ordinary counts so native cannot reject them as stale.
                    if book.desired.generation.parse::<u64>().unwrap_or(0) <= generation {
                        book.publish();
                    }
                }
                continue;
            }
            let stopped = {
                let book = shared.lock();
                book.closed && book.desired.generation == generation.to_string()
            };
            progress.send_replace(Progress {
                generation,
                failed,
                stopped,
            });
            if stopped {
                return;
            }
            continue;
        }
        if shared.lock().closed {
            return;
        }
        if updates.changed().await.is_err() {
            // Normally Service::drop already queued zero. This defensive path
            // also closes a sender-less actor without keeping itself alive.
            let mut book = shared.lock();
            book.closed = true;
            for (_, work) in std::mem::take(&mut book.works) {
                work.cancellation.cancel();
            }
            book.publish();
        }
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
