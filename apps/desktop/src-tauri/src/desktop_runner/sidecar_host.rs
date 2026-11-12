//! The harness host that runs local agent CLIs: it hands the runner's runs
//! to the harness sidecar's holder (`crate::harness_sidecar`) and relays what
//! they produce back through each run's [`RunSink`].
//!
//! - Reports come from a cache of probes, refreshed when the runner first
//!   connects, on an interval, and after a run ends needing a login or out
//!   of its plan's limit. `reports()` reads the cache; a change is announced
//!   on [`HarnessReports::changes`] and the runner sends it as
//!   `harness.status`.
//! - `start` decides synchronously from the cache and the installed CLI,
//!   then hands the run to the holder.
//! - The holder numbers a run's outputs itself. The host drains each run's
//!   channel as it fills and journals the outputs with those numbers
//!   ([`RunSink::relay_all`]), several per write, whether or not a runner
//!   socket is up or a runner runs; it acks the holder only after the
//!   journal holds them. The journal's per-run storage limits bound what a
//!   run may hold; a run past them is cancelled and ends `failed`. A
//!   restarted app resumes the holder after the journaled position
//!   ([`HarnessHost::reattach`]): nothing is lost or sent twice.
//! - A harness process whose launch needs the desktop's authorization (Codex
//!   on the user's ChatGPT plan) is granted when the holder reports it, and
//!   again when a restarted app resumes the run.
//! - `run.input` is not supported: each chat turn is its own run that
//!   resumes the harness's session. Input is answered with a `RUN_ERROR`
//!   chunk (`input_unsupported`) on the run's stream; the run goes on.
//! - A run works in its chat's folder under the app's data, so the next turn
//!   finds what this one left (`run_folders`).

use std::{
  collections::{HashMap, HashSet},
  num::NonZeroU32,
  path::PathBuf,
  sync::{Arc, Mutex, MutexGuard, PoisonError},
  time::{Duration, SystemTime},
};

use futures_util::future::BoxFuture;
use serde_json::json;
use tokio::sync::{Notify, mpsc, watch};
use uuid::Uuid;

use super::harness::{
  EmitError, FolderAnswer, Forwarded, HarnessHost, HarnessReports, JournaledRun,
  NotForwarded, RunOutput, RunSink,
};
use super::run_folders;
use crate::harness_sidecar::{
  self, HarnessLaunchSettings, HarnessProbe, HarnessProcess, HarnessSidecar,
  RestoreOutcome, ResumeError, SidecarDelivery, SidecarFolderRestore, SidecarRunOutput,
  SidecarRunStart, SidecarSettings, SkillFolderRef,
};
use crate::runner_protocol::{
  FolderRestore, FolderRestoreOutcome, Harness, HarnessReport,
  HarnessUnavailableReason, JsonObject, MAX_FRAME_BYTES, MissingHarness, RejectReason,
  RunAnswer, RunApproval, RunInput, RunOutcome, RunStart, RunTokenRefresh,
  UnavailableHarness,
};

const LOG_TARGET: &str = "desktop_runner::host";
/// How often reports are probed again without a reason to.
pub(crate) const PROBE_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// How soon a ready harness whose probe failed once is probed again. One
/// failed probe (a busy or just-woken computer) keeps it ready until then.
pub(crate) const FAILED_PROBE_RECHECK: Duration = Duration::from_secs(30);
/// Retries of an output the journal could not record, doubling up to this.
const STORAGE_RETRY_CAP: Duration = Duration::from_secs(30);
const STORAGE_RETRY_FIRST: Duration = Duration::from_millis(250);
const INPUT_UNSUPPORTED: &str = "input_unsupported";
/// How long a run's start waits for its skill folders. A folder can sit on a
/// mount that hangs, and a start runs on the runner's loop.
const SKILL_FOLDER_BUDGET: Duration = Duration::from_secs(2);
const OUTPUT_TOO_LARGE: &str = "output_too_large";
/// Outputs journaled in one write at most.
const JOURNAL_BATCH: usize = 256;
/// Room a run message needs in a frame beyond its chunk.
const FRAME_ENVELOPE_BYTES: usize = 1024;

/// An installed harness CLI, kept in place while `lease` lives. So are the
/// managed tools in `tool_path`, the directories its commands find them in.
pub(crate) struct InstalledHarness {
  pub(crate) version: String,
  pub(crate) executable: PathBuf,
  pub(crate) config_dir: PathBuf,
  pub(crate) tool_path: Vec<PathBuf>,
  pub(crate) lease: Box<dyn Send + Sync>,
}

/// Lets one harness process and its descendants use a credential while the
/// returned guard lives.
pub(crate) type ProcessGrant = Arc<dyn Fn(u32) -> Box<dyn Send + Sync> + Send + Sync>;

/// What a harness's launch adds, and who authorizes its processes.
#[derive(Clone)]
pub(crate) struct HarnessCredentials {
  pub(crate) settings: HarnessLaunchSettings,
  /// Present exactly when `settings.process_grant` is set.
  pub(crate) grant: Option<ProcessGrant>,
}

/// Called when a CLI's install has ended; see `LocalHarnesses::on_install_settled`.
pub(crate) type InstallSettled = Arc<dyn Fn() + Send + Sync>;

/// The managed CLIs on this computer and what their launches add.
pub(crate) trait LocalHarnesses: Send + Sync + 'static {
  /// The installed CLI, held in place until the lease drops; `None` when
  /// the harness is not installed here.
  fn installed(&self, harness: Harness) -> Option<InstalledHarness>;
  /// What the harness's launch adds right now; `None` adds nothing.
  fn credentials(&self, harness: Harness) -> BoxFuture<'_, Option<HarnessCredentials>>;
  /// Calls `settled` each time a CLI's install or removal ends, from then
  /// on: what `installed` returns may have changed, so the reports do too.
  fn on_install_settled(&self, settled: InstallSettled);
  /// The skill folders the member listed for this computer, as they stand.
  fn skill_folders(&self) -> Vec<SkillFolderRef>;
}

pub(crate) struct HostSettings {
  /// The supervisor's settings; `api_origin` is the connecting account's.
  pub(crate) sidecar: SidecarSettings,
  /// Where each chat's folder is made, with its checkpoints and cache beside
  /// it.
  pub(crate) workspaces: PathBuf,
  pub(crate) probe_interval: Duration,
}

#[derive(Clone)]
struct Cached {
  report: HarnessReport,
  credentials: Option<HarnessCredentials>,
  /// A ready report kept through one probe that found the harness
  /// unavailable; the next failed probe replaces it.
  kept_through_failure: bool,
}

impl Cached {
  const fn new(report: HarnessReport, credentials: Option<HarnessCredentials>) -> Self {
    Self {
      report,
      credentials,
      kept_through_failure: false,
    }
  }
}

/// A run this host relays.
struct HostRun {
  /// Journals the run's outputs, whether or not a runner runs.
  sink: RunSink,
  /// Authorizes the run's harness process, when its launch needs that.
  grant: Option<ProcessGrant>,
  /// For the chunks the host makes up itself; unknown for a run picked up
  /// after a restart.
  model: Option<String>,
  thread_id: Option<String>,
  /// The chat folder the run works in; unknown for a run picked up after a
  /// restart, whose holder still refuses a restore of the folder it uses.
  folder_id: Option<Uuid>,
}

struct Shared {
  settings: HostSettings,
  harnesses: Arc<dyn LocalHarnesses>,
  /// The supervisor, with the API origin its holder's proxy forwards to.
  sidecar: Mutex<Option<(String, HarnessSidecar)>>,
  cache: Mutex<Vec<(Harness, Cached)>>,
  changes: watch::Sender<u64>,
  refresh: Notify,
  runs: Mutex<HashMap<String, HostRun>>,
  /// Probes whose harness process may need a grant, by request id.
  probes: Mutex<HashMap<String, ProcessGrant>>,
  /// Held grants, by run id or probe request id.
  grants: Mutex<HashMap<String, Box<dyn Send + Sync>>>,
  /// The folders being restored. Held while a run starts in a folder, a
  /// folder is removed, or a restore begins: none of them overlaps another.
  folders: run_folders::FolderLock,
  /// The restores going on, by the API's restore id. The API sends one again
  /// on each new socket until it is answered; a copy that arrives while it
  /// runs gets no answer of its own, since the one answer goes out on the
  /// socket that is up when it ends.
  restores: Mutex<HashSet<String>>,
  /// Every restore request the host was handed, repeats included, so a test
  /// knows a resend arrived before it moves on.
  #[cfg(all(test, unix))]
  restores_asked: std::sync::atomic::AtomicUsize,
}

/// One per app: the supervisor and its holder connection outlive runner
/// sockets, which come and go with the network and the feature gate.
#[derive(Clone)]
pub(crate) struct SidecarHarnessHost {
  shared: Arc<Shared>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl SidecarHarnessHost {
  /// Whether the harness's ready report was kept through a failed probe.
  #[cfg(all(test, unix))]
  pub(crate) fn kept_through_failure(&self, harness: Harness) -> bool {
    self
      .shared
      .cached(harness)
      .is_some_and(|cached| cached.kept_through_failure)
  }

  /// How many restore requests the host was handed, repeats included.
  #[cfg(all(test, unix))]
  pub(crate) fn restores_asked(&self) -> usize {
    self
      .shared
      .restores_asked
      .load(std::sync::atomic::Ordering::SeqCst)
  }

  pub(crate) fn new(
    settings: HostSettings,
    harnesses: Arc<dyn LocalHarnesses>,
  ) -> Self {
    Self {
      shared: Arc::new(Shared {
        folders: Mutex::new(HashSet::new()),
        restores: Mutex::new(HashSet::new()),
        #[cfg(all(test, unix))]
        restores_asked: std::sync::atomic::AtomicUsize::new(0),
        settings,
        harnesses,
        sidecar: Mutex::new(None),
        cache: Mutex::new(Vec::new()),
        changes: watch::channel(0).0,
        refresh: Notify::new(),
        runs: Mutex::new(HashMap::new()),
        probes: Mutex::new(HashMap::new()),
        grants: Mutex::new(HashMap::new()),
      }),
    }
  }
}

impl Shared {
  fn sidecar(&self) -> Option<HarnessSidecar> {
    locked(&self.sidecar)
      .as_ref()
      .map(|(_origin, sidecar)| sidecar.clone())
  }

  fn cached(&self, harness: Harness) -> Option<Cached> {
    locked(&self.cache)
      .iter()
      .find(|(id, _)| *id == harness)
      .map(|(_, cached)| cached.clone())
  }

  /// Keep a ready report through the first probe that finds the harness
  /// unavailable. `true` when it was kept: the caller probes again soon.
  fn keep_ready_once(&self, harness: Harness) -> bool {
    let mut cache = locked(&self.cache);
    let Some((_, held)) = cache.iter_mut().find(|(id, _)| *id == harness) else {
      return false;
    };
    if !matches!(held.report, HarnessReport::Ready(_)) || held.kept_through_failure {
      return false;
    }
    held.kept_through_failure = true;
    true
  }

  /// Every installed harness has a report from a probe.
  fn settled(&self) -> bool {
    Harness::ALL.iter().all(|&harness| {
      self.cached(harness).is_some() || self.harnesses.installed(harness).is_none()
    })
  }

  /// Store a probe's result; announce it when the report changed.
  fn store(&self, harness: Harness, cached: Cached) {
    let mut cache = locked(&self.cache);
    let changed = match cache.iter_mut().find(|(id, _)| *id == harness) {
      Some((_, held)) => {
        let changed = held.report != cached.report;
        *held = cached;
        changed
      }
      None => {
        cache.push((harness, cached));
        true
      }
    };
    drop(cache);
    if changed {
      self
        .changes
        .send_modify(|version| *version = version.wrapping_add(1));
    }
  }

  fn workspace(&self, folder_id: Uuid) -> PathBuf {
    self.settings.workspaces.join(folder_id.to_string())
  }
}

/// Why a run cannot start here, read from its harness's cached report.
fn refusal(report: Option<&HarnessReport>, start: &RunStart) -> Option<RejectReason> {
  match report {
    None | Some(HarnessReport::NotInstalled(_)) => {
      Some(RejectReason::HarnessNotInstalled)
    }
    Some(HarnessReport::NeedsLogin(_)) => Some(RejectReason::HarnessNeedsLogin),
    Some(HarnessReport::LimitUntil(_)) => Some(RejectReason::HarnessLimited),
    Some(HarnessReport::Unsupported(_)) => Some(RejectReason::HarnessUnsupported),
    Some(HarnessReport::Unavailable(_)) => Some(RejectReason::HarnessUnavailable),
    Some(HarnessReport::Ready(ready)) => {
      if ready.version != start.harness_version {
        Some(RejectReason::HarnessVersionUnavailable)
      } else if !ready.models.iter().any(|model| model.id == start.model) {
        Some(RejectReason::ModelUnavailable)
      } else if !ready.approval_modes.contains(&start.policy.approvals) {
        Some(RejectReason::PolicyUnsupported)
      } else {
        None
      }
    }
  }
}

fn sidecar_output(output: SidecarRunOutput) -> RunOutput {
  match output {
    SidecarRunOutput::Event(chunk) => RunOutput::Event(chunk),
    SidecarRunOutput::ApprovalRequest {
      request_id,
      kind,
      summary,
    } => RunOutput::ApprovalRequest {
      request_id,
      kind,
      summary,
    },
    SidecarRunOutput::Finished {
      outcome,
      harness_session_id,
    } => RunOutput::Finished {
      outcome,
      harness_session_id,
    },
  }
}

/// A `RUN_ERROR` chunk the host makes up for a run.
fn run_error(
  run_id: &str,
  model: Option<&str>,
  thread_id: Option<&str>,
  code: &str,
  message: &str,
) -> RunOutput {
  let mut chunk = JsonObject::new();
  chunk.insert("type".to_owned(), json!("RUN_ERROR"));
  chunk.insert("runId".to_owned(), json!(run_id));
  if let Some(thread_id) = thread_id {
    chunk.insert("threadId".to_owned(), json!(thread_id));
  }
  if let Some(model) = model {
    chunk.insert("model".to_owned(), json!(model));
  }
  chunk.insert("timestamp".to_owned(), json!(super::client::now_ms()));
  chunk.insert("message".to_owned(), json!(message));
  chunk.insert("code".to_owned(), json!(code));
  chunk.insert(
    "error".to_owned(),
    json!({ "message": message, "code": code }),
  );
  RunOutput::Event(chunk)
}

/// Journal one output the host made up, retrying a write that failed. An
/// output the journal will never take (the run ended, or is past its limit)
/// is dropped.
async fn emit(sink: &RunSink, output: &RunOutput) {
  let mut retry = STORAGE_RETRY_FIRST;
  loop {
    match sink.emit(output.clone()) {
      Err(EmitError::Storage) => {
        tracing::warn!(target: LOG_TARGET, "the runner journal refused a run output; retrying");
        tokio::time::sleep(retry).await;
        retry = retry.saturating_mul(2).min(STORAGE_RETRY_CAP);
      }
      Ok(_) | Err(EmitError::TooLarge | EmitError::Full | EmitError::RunClosed) => {
        return;
      }
    }
  }
}

/// What a batch of holder outputs did to the run.
struct Batch {
  outputs: Vec<(RunOutput, Option<NonZeroU32>)>,
  /// The last holder position in the batch.
  holder_seq: Option<NonZeroU32>,
  outcome: Option<RunOutcome>,
}

/// Journal a run's outputs as the holder delivers them, connected or not,
/// several per journal write, and ack the holder after each write. A run
/// that reached the API's per-run storage limit is cancelled and ends
/// `failed`.
async fn pump(
  shared: Arc<Shared>,
  sidecar: HarnessSidecar,
  run_id: String,
  mut outputs: mpsc::UnboundedReceiver<SidecarDelivery>,
  sink: RunSink,
  lease: Option<Box<dyn Send + Sync>>,
) {
  let (model, thread_id) = locked(&shared.runs)
    .get(&run_id)
    .map(|run| (run.model.clone(), run.thread_id.clone()))
    .unwrap_or_default();
  let mut limited = false;
  let outcome = loop {
    let first = outputs.recv().await.unwrap_or_else(|| {
      // The supervisor always ends a run's channel with its end; a channel
      // closed without one is a run nobody can finish any more.
      tracing::warn!(target: LOG_TARGET, "a run's channel closed before its end");
      SidecarDelivery {
        holder_seq: None,
        output: SidecarRunOutput::Finished {
          outcome: RunOutcome::Failed,
          harness_session_id: None,
        },
      }
    });
    let mut deliveries = vec![first];
    while deliveries.len() < JOURNAL_BATCH
      && !matches!(
        deliveries.last().map(|delivery| &delivery.output),
        Some(SidecarRunOutput::Finished { .. })
      )
    {
      match outputs.try_recv() {
        Ok(delivery) => deliveries.push(delivery),
        Err(_empty) => break,
      }
    }
    let batch = batch(
      deliveries,
      limited,
      &run_id,
      model.as_deref(),
      thread_id.as_deref(),
    );
    let recorded = journal(&sink, batch.outputs).await;
    if recorded.contains(&Err(EmitError::Full)) && !limited {
      tracing::warn!(target: LOG_TARGET, "a run reached the per-run storage limit; cancelling it");
      limited = true;
      if sidecar.cancel(&run_id).is_err() {
        tracing::warn!(target: LOG_TARGET, "a run past its storage limit was not cancelled");
      }
    }
    // Journaled, past the limit, or given up by the runner: either way the
    // holder need not keep any of it longer.
    if let Some(seq) = batch.holder_seq
      && sidecar.ack(&run_id, seq).is_err()
    {
      tracing::warn!(target: LOG_TARGET, "the harness holder could not be acked");
    }
    if let Some(outcome) = batch.outcome {
      break outcome;
    }
  };
  locked(&shared.runs).remove(&run_id);
  locked(&shared.grants).remove(&run_id);
  drop(lease);
  if matches!(outcome, RunOutcome::NeedsLogin | RunOutcome::LimitReached) {
    shared.refresh.notify_one();
  }
}

/// The runner outputs for some holder deliveries: an output too large for
/// a frame becomes an error chunk, and a run cut short at the storage limit
/// ends `failed` whatever it says.
fn batch(
  deliveries: Vec<SidecarDelivery>,
  limited: bool,
  run_id: &str,
  model: Option<&str>,
  thread_id: Option<&str>,
) -> Batch {
  let mut batch = Batch {
    outputs: Vec::with_capacity(deliveries.len()),
    holder_seq: None,
    outcome: None,
  };
  for delivery in deliveries {
    let output = match delivery.output {
      SidecarRunOutput::Finished {
        harness_session_id, ..
      } if limited => SidecarRunOutput::Finished {
        outcome: RunOutcome::Failed,
        harness_session_id,
      },
      output => output,
    };
    if let SidecarRunOutput::Finished { outcome, .. } = &output {
      batch.outcome = Some(*outcome);
    }
    let output = match sidecar_output(output) {
      RunOutput::Event(chunk) if !fits_a_frame(&chunk) => {
        tracing::warn!(target: LOG_TARGET, "a run output exceeded the frame limit; sent an error instead");
        run_error(
          run_id,
          model,
          thread_id,
          OUTPUT_TOO_LARGE,
          "The harness produced an output larger than the runner can send.",
        )
      }
      output => output,
    };
    batch.holder_seq = delivery.holder_seq.or(batch.holder_seq);
    batch.outputs.push((output, delivery.holder_seq));
  }
  batch
}

/// Whether a chunk leaves room in a frame for the message around it.
fn fits_a_frame(chunk: &JsonObject) -> bool {
  serde_json::to_vec(chunk).is_ok_and(|bytes| {
    bytes.len() <= MAX_FRAME_BYTES.saturating_sub(FRAME_ENVELOPE_BYTES)
  })
}

/// Journal outputs in one write, retrying a write that failed: nothing was
/// journaled then. What happened to each output, in order.
async fn journal(
  sink: &RunSink,
  outputs: Vec<(RunOutput, Option<NonZeroU32>)>,
) -> Vec<Result<NonZeroU32, EmitError>> {
  let mut retry = STORAGE_RETRY_FIRST;
  loop {
    match sink.relay_all(outputs.clone()) {
      Ok(recorded) => return recorded.outcomes,
      Err(_storage) => {
        tracing::warn!(target: LOG_TARGET, "the runner journal refused run outputs; retrying");
        tokio::time::sleep(retry).await;
        retry = retry.saturating_mul(2).min(STORAGE_RETRY_CAP);
      }
    }
  }
}

/// Grant every harness process a holder reports for a run or probe whose
/// launch has a credential.
async fn grant_processes(
  shared: Arc<Shared>,
  sidecar: HarnessSidecar,
  mut reports: mpsc::Receiver<HarnessProcess>,
) {
  while let Some(HarnessProcess { id, pid }) = reports.recv().await {
    let grant = locked(&shared.runs)
      .get(&id)
      .and_then(|run| run.grant.clone())
      .or_else(|| locked(&shared.probes).get(&id).cloned());
    let Some(grant) = grant else {
      // The holder's wait times out and the run or probe fails.
      tracing::warn!(target: LOG_TARGET, "a harness process had no credential to grant");
      continue;
    };
    // The new guard is held before the one it replaces drops.
    let previous = locked(&shared.grants).insert(id.clone(), grant(pid.get()));
    drop(previous);
    if sidecar.grant_process(&id).is_err() {
      tracing::warn!(target: LOG_TARGET, "a harness process grant was not delivered");
    }
  }
}

/// The listed skill folders, read on a thread of their own. A list that does
/// not come in time leaves the run without skills, not the runner waiting; the
/// stuck thread ends when the mount answers.
pub(crate) fn skill_folders_within(
  budget: Duration,
  harnesses: Arc<dyn LocalHarnesses>,
) -> Vec<SkillFolderRef> {
  let (sender, receiver) = std::sync::mpsc::channel();
  let reader = std::thread::Builder::new()
    .name("skill-folders".to_owned())
    .spawn(move || {
      let _gone = sender.send(harnesses.skill_folders());
    });
  if let Err(error) = reader {
    tracing::warn!(target: LOG_TARGET, ?error, "the skill folders could not be read");
    return Vec::new();
  }
  receiver.recv_timeout(budget).unwrap_or_else(|_late| {
    tracing::warn!(target: LOG_TARGET, "the skill folders did not answer in time");
    Vec::new()
  })
}

/// Probe every harness now, then on the interval or when asked to, and
/// soon after a probe that a ready harness was kept through. Folders no run
/// has used for too long are removed on the same beat.
async fn refresh_reports(shared: Arc<Shared>, sidecar: HarnessSidecar) {
  loop {
    let mut recheck = false;
    for &harness in Harness::ALL {
      recheck |= probe(&shared, &sidecar, harness).await == Probed::KeptReady;
    }
    let held = Arc::clone(&shared);
    let removal = tokio::task::spawn_blocking(move || {
      run_folders::remove_idle(
        &held.settings.workspaces,
        SystemTime::now(),
        &held.folders,
      );
    });
    if removal.await.is_err() {
      tracing::warn!(target: LOG_TARGET, "removing idle run folders stopped early");
    }
    let wait = if recheck {
      FAILED_PROBE_RECHECK.min(shared.settings.probe_interval)
    } else {
      shared.settings.probe_interval
    };
    tokio::select! {
      () = tokio::time::sleep(wait) => {}
      () = shared.refresh.notified() => {}
    }
  }
}

/// What a probe did to the harness's report.
#[derive(Debug, PartialEq, Eq)]
enum Probed {
  Stored,
  /// The probe found a ready harness unavailable once; the ready report
  /// stands until the recheck.
  KeptReady,
}

async fn probe(shared: &Shared, sidecar: &HarnessSidecar, harness: Harness) -> Probed {
  let Some(installed) = shared.harnesses.installed(harness) else {
    shared.store(
      harness,
      Cached::new(
        HarnessReport::NotInstalled(MissingHarness { id: harness }),
        None,
      ),
    );
    return Probed::Stored;
  };
  let credentials = shared.harnesses.credentials(harness).await;
  let request_id = Uuid::new_v4().to_string();
  if let Some(grant) = credentials.as_ref().and_then(|held| held.grant.clone()) {
    locked(&shared.probes).insert(request_id.clone(), grant);
  }
  let outcome = sidecar
    .probe(HarnessProbe {
      request_id: request_id.clone(),
      harness,
      executable: installed.executable.to_string_lossy().into_owned(),
      config_dir: installed.config_dir.to_string_lossy().into_owned(),
      launch: credentials
        .as_ref()
        .map(|held| held.settings.clone())
        .unwrap_or_default(),
    })
    .await;
  locked(&shared.probes).remove(&request_id);
  locked(&shared.grants).remove(&request_id);
  drop(installed);
  match outcome {
    Ok(outcome) => {
      let report = harness_sidecar::harness_report(harness, &outcome);
      if matches!(report, HarnessReport::Unavailable(_))
        && shared.keep_ready_once(harness)
      {
        tracing::info!(target: LOG_TARGET, "a ready harness failed one probe; checking again soon");
        return Probed::KeptReady;
      }
      shared.store(harness, Cached::new(report, credentials));
      Probed::Stored
    }
    // The last report stands until a probe answers again. An installed
    // harness that has none yet is unavailable, never missing.
    Err(error) => {
      tracing::warn!(target: LOG_TARGET, ?error, "a harness could not be probed");
      if shared.cached(harness).is_none() {
        shared.store(harness, Cached::new(probe_pending(harness), credentials));
      }
      Probed::Stored
    }
  }
}

/// The report of an installed harness no probe has answered for yet: not
/// available for now, never missing.
const fn probe_pending(harness: Harness) -> HarnessReport {
  HarnessReport::Unavailable(UnavailableHarness {
    id: harness,
    reason: HarnessUnavailableReason::ProbeFailed,
  })
}

/// The origin an API base URL serves from: what the holder's MCP proxy may
/// forward to.
fn api_origin(api_base_url: &str) -> Option<String> {
  let url = reqwest::Url::parse(api_base_url).ok()?;
  matches!(url.scheme(), "https" | "http").then(|| url.origin().ascii_serialization())
}

impl SidecarHarnessHost {
  /// The relaying of a run the holder took or gave back.
  fn spawn_pump(
    &self,
    sidecar: HarnessSidecar,
    run_id: String,
    outputs: mpsc::UnboundedReceiver<SidecarDelivery>,
    sink: RunSink,
    lease: Option<Box<dyn Send + Sync>>,
  ) {
    tokio::spawn(pump(
      Arc::clone(&self.shared),
      sidecar,
      run_id,
      outputs,
      sink,
      lease,
    ));
  }

  /// Pick up journaled runs this host does not relay yet.
  async fn reclaim(self, sidecar: HarnessSidecar, runs: Vec<JournaledRun>) {
    let held = match sidecar.held_runs().await {
      Ok(held) => held,
      Err(error) => {
        // Tried again on the runner's next connection.
        tracing::warn!(target: LOG_TARGET, ?error, "the harness holder's runs could not be listed");
        locked(&self.shared.runs).retain(|run_id, _run| {
          !runs.iter().any(|journaled| journaled.run_id == *run_id)
        });
        return;
      }
    };
    for run in runs {
      let Some(holder_run) = held.iter().find(|held| held.run_id == run.run_id) else {
        self.lost(run);
        continue;
      };
      // Read now: the first probe after a restart may not have answered yet.
      let grant = self
        .shared
        .harnesses
        .credentials(holder_run.harness)
        .await
        .and_then(|credentials| credentials.grant);
      let sink = locked(&self.shared.runs).get_mut(&run.run_id).map(|entry| {
        entry.grant = grant;
        entry.sink.clone()
      });
      let Some(sink) = sink else {
        continue;
      };
      match sidecar.resume_run(&run.run_id, run.source_seq).await {
        Ok(outputs) => {
          tracing::info!(target: LOG_TARGET, "picked up a run the harness holder kept");
          self.spawn_pump(sidecar.clone(), run.run_id, outputs, sink, None);
        }
        Err(ResumeError::UnknownRun) => self.lost(run),
        Err(error) => {
          // Tried again on the runner's next connection.
          tracing::warn!(target: LOG_TARGET, ?error, "a held run could not be resumed");
          locked(&self.shared.runs).remove(&run.run_id);
        }
      }
    }
  }

  /// A journaled run no holder has any more ends `failed`.
  fn lost(&self, run: JournaledRun) {
    tracing::warn!(target: LOG_TARGET, "a journaled run is gone from the harness holder");
    let Some(entry) = locked(&self.shared.runs).remove(&run.run_id) else {
      return;
    };
    let sink = entry.sink.clone();
    tokio::spawn(async move {
      let failed = RunOutput::Finished {
        outcome: RunOutcome::Failed,
        harness_session_id: None,
      };
      // Keeps the sender alive while the end is relayed.
      let _entry = entry;
      emit(&sink, &failed).await;
    });
  }

  /// Hand a run command to the holder; without one, or when the holder
  /// cannot queue it, the command is not taken and the runner leaves it
  /// unrecorded for the API's next resend.
  fn forward(
    &self,
    what: &str,
    send: impl FnOnce(&HarnessSidecar) -> Result<(), harness_sidecar::SidecarUnavailable>,
  ) -> Forwarded {
    let Some(sidecar) = self.shared.sidecar() else {
      tracing::warn!(target: LOG_TARGET, command = what, "a run command found no harness holder");
      return Err(NotForwarded);
    };
    send(&sidecar).map_err(|error| {
      tracing::warn!(target: LOG_TARGET, ?error, command = what, "a run command did not reach the harness holder");
      NotForwarded
    })
  }
}

impl HarnessHost for SidecarHarnessHost {
  fn sidecar_version(&self) -> String {
    self.shared.settings.sidecar.sidecar_version.clone()
  }

  fn connecting(&self, api_base_url: &str) {
    let Some(origin) = api_origin(api_base_url) else {
      tracing::warn!(target: LOG_TARGET, "the API base URL has no http(s) origin");
      return;
    };
    let mut slot = locked(&self.shared.sidecar);
    if let Some((serving, _sidecar)) = slot.as_ref() {
      if *serving != origin {
        // The holder's MCP proxy forwards to one origin; runs for another
        // API would be refused there, so the app keeps the first.
        tracing::warn!(target: LOG_TARGET, "the runner connects to another API than the harness holder serves");
      }
      return;
    }
    let mut settings = self.shared.settings.sidecar.clone();
    settings.api_origin.clone_from(&origin);
    let sidecar = HarnessSidecar::spawn(settings);
    match sidecar.watch_processes() {
      Ok(reports) => {
        tokio::spawn(grant_processes(
          Arc::clone(&self.shared),
          sidecar.clone(),
          reports,
        ));
      }
      Err(error) => {
        tracing::warn!(target: LOG_TARGET, ?error, "harness processes cannot be granted");
      }
    }
    tokio::spawn(refresh_reports(Arc::clone(&self.shared), sidecar.clone()));
    // A CLI installed or updated after the app started, or a sign-in or
    // sign-out, is reported without waiting for the next periodic probe.
    let shared = Arc::clone(&self.shared);
    self
      .shared
      .harnesses
      .on_install_settled(Arc::new(move || shared.refresh.notify_one()));
    *slot = Some((origin, sidecar));
  }

  fn reattach(&self, runs: Vec<JournaledRun>) {
    let Some(sidecar) = self.shared.sidecar() else {
      return;
    };
    let mut fresh = Vec::new();
    let mut held = locked(&self.shared.runs);
    for run in runs {
      if held.contains_key(&run.run_id) {
        // Relayed already: its sink journals for any runner.
        continue;
      }
      held.insert(
        run.run_id.clone(),
        HostRun {
          sink: run.sink.clone(),
          grant: None,
          model: None,
          thread_id: None,
          folder_id: None,
        },
      );
      fresh.push(run);
    }
    drop(held);
    if !fresh.is_empty() {
      tokio::spawn(self.clone().reclaim(sidecar, fresh));
    }
  }

  fn start(&self, start: RunStart, sink: RunSink) -> Result<(), RejectReason> {
    // Only a UUID names a folder.
    let folder_id = Uuid::parse_str(&start.folder_id)
      .map_err(|_not_uuid| RejectReason::UnknownRun)?;
    let cached = self.shared.cached(start.harness);
    if cached.is_none() && self.shared.harnesses.installed(start.harness).is_some() {
      // Installed, but its first probe has not answered: not missing.
      return Err(RejectReason::HarnessUnavailable);
    }
    if let Some(reason) = refusal(cached.as_ref().map(|cached| &cached.report), &start)
    {
      return Err(reason);
    }
    let sidecar = self.shared.sidecar().ok_or(RejectReason::AtCapacity)?;
    let installed = self
      .shared
      .harnesses
      .installed(start.harness)
      .ok_or(RejectReason::HarnessNotInstalled)?;
    if installed.version != start.harness_version {
      return Err(RejectReason::HarnessVersionUnavailable);
    }
    let workspace = self.shared.workspace(folder_id);
    let opened = {
      let restoring = locked(&self.shared.folders);
      if restoring.contains(&folder_id) {
        return Err(RejectReason::FolderBusy);
      }
      let opened = run_folders::open(&workspace, SystemTime::now());
      // Held until the folder is recorded as used, so no restore begins in
      // between.
      drop(restoring);
      opened
    };
    if let Err(error) = opened {
      tracing::warn!(target: LOG_TARGET, kind = ?error.kind(), "a run's folder could not be made");
      return Err(RejectReason::AtCapacity);
    }
    // Made with the folder; the one place outside it the run may write.
    let cache = run_folders::chat_cache(&workspace);
    let credentials = cached.and_then(|cached| cached.credentials);
    let thread_id = start
      .harness_session_id
      .clone()
      .unwrap_or_else(|| start.run_id.clone());
    locked(&self.shared.runs).insert(
      start.run_id.clone(),
      HostRun {
        sink: sink.clone(),
        grant: credentials.as_ref().and_then(|held| held.grant.clone()),
        model: Some(start.model.clone()),
        thread_id: Some(thread_id.clone()),
        folder_id: Some(folder_id),
      },
    );
    let run_id = start.run_id.clone();
    let outputs = sidecar.start_run(SidecarRunStart {
      run_id: start.run_id,
      thread_id,
      harness: start.harness,
      executable: installed.executable.to_string_lossy().into_owned(),
      config_dir: installed.config_dir.to_string_lossy().into_owned(),
      launch: credentials.map(|held| held.settings).unwrap_or_default(),
      workspace_dir: workspace.to_string_lossy().into_owned(),
      cache_dir: cache.to_string_lossy().into_owned(),
      skill_folders: skill_folders_within(
        SKILL_FOLDER_BUDGET,
        Arc::clone(&self.shared.harnesses),
      ),
      tool_path: installed
        .tool_path
        .iter()
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect(),
      model: start.model,
      instructions: start.instructions,
      messages: start.messages,
      attachments: start.attachments,
      harness_session_id: start.harness_session_id,
      policy: start.policy,
      mcp: start.mcp,
    });
    let outputs = match outputs {
      Ok(outputs) => outputs,
      Err(error) => {
        tracing::warn!(target: LOG_TARGET, ?error, "the harness holder took no run");
        locked(&self.shared.runs).remove(&run_id);
        return Err(error.reject_reason());
      }
    };
    self.spawn_pump(sidecar, run_id, outputs, sink, Some(installed.lease));
    Ok(())
  }

  /// Local harnesses take no follow-up input: each chat turn is its own run.
  /// The input is answered on the run's stream instead of dropped.
  fn input(&self, input: RunInput) -> Forwarded {
    tracing::warn!(target: LOG_TARGET, "a run received input local harnesses do not take");
    let held = locked(&self.shared.runs)
      .get(&input.run_id)
      .map(|run| (run.sink.clone(), run.model.clone(), run.thread_id.clone()));
    let Some((sink, model, thread_id)) = held else {
      return Ok(());
    };
    let error = run_error(
      &input.run_id,
      model.as_deref(),
      thread_id.as_deref(),
      INPUT_UNSUPPORTED,
      "Local harnesses take no input while a run is going; send it as the next turn.",
    );
    tokio::spawn(async move {
      emit(&sink, &error).await;
    });
    Ok(())
  }

  fn approval(&self, approval: RunApproval) -> Forwarded {
    self.forward("approval", |sidecar| sidecar.approval(approval))
  }

  fn answer(&self, answer: RunAnswer) -> Forwarded {
    self.forward("answer", |sidecar| sidecar.answer(answer))
  }

  fn interrupt(&self, run_id: &str) -> Forwarded {
    self.forward("interrupt", |sidecar| sidecar.interrupt(run_id))
  }

  fn cancel(&self, run_id: &str) -> Forwarded {
    self.forward("cancel", |sidecar| sidecar.cancel(run_id))
  }

  fn token(&self, refresh: RunTokenRefresh) -> Forwarded {
    self.forward("token", |sidecar| sidecar.token(refresh))
  }

  fn restore_folder(&self, restore: FolderRestore, answer: FolderAnswer) {
    let folder_id = restore.folder_id.uuid();
    // The same restore asked again while it runs: its answer comes when it
    // ends, on whichever socket is up then.
    let fresh = locked(&self.shared.restores).insert(restore.restore_id.clone());
    #[cfg(all(test, unix))]
    self
      .shared
      .restores_asked
      .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if !fresh {
      return;
    }
    // The holder makes the final call: it refuses a restore of a folder one
    // of its runs uses, and a run in a folder it restores. Another restore
    // of the folder is another operation, and refused the same way.
    let in_use = locked(&self.shared.runs)
      .values()
      .any(|run| run.folder_id == Some(folder_id));
    if in_use || !locked(&self.shared.folders).insert(folder_id) {
      locked(&self.shared.restores).remove(&restore.restore_id);
      answer.send(FolderRestoreOutcome::FolderBusy);
      return;
    }
    let Some(sidecar) = self.shared.sidecar() else {
      locked(&self.shared.folders).remove(&folder_id);
      locked(&self.shared.restores).remove(&restore.restore_id);
      answer.send(FolderRestoreOutcome::Failed);
      return;
    };
    let shared = Arc::clone(&self.shared);
    let workspace = shared.workspace(folder_id);
    tokio::spawn(async move {
      let restored = sidecar
        .restore_folder(SidecarFolderRestore {
          request_id: Uuid::new_v4().to_string(),
          workspace_dir: workspace.to_string_lossy().into_owned(),
          run_id: restore.run_id,
        })
        .await;
      locked(&shared.folders).remove(&folder_id);
      locked(&shared.restores).remove(&restore.restore_id);
      let outcome = match restored {
        Ok(outcome) => folder_outcome(outcome),
        Err(error) => {
          tracing::warn!(target: LOG_TARGET, ?error, "a folder restore got no answer");
          FolderRestoreOutcome::Failed
        }
      };
      tracing::info!(target: LOG_TARGET, outcome = outcome.wire_name(), "a folder restore ended");
      answer.send(outcome);
    });
  }
}

/// The holder's answer in the runner protocol's words.
const fn folder_outcome(outcome: RestoreOutcome) -> FolderRestoreOutcome {
  match outcome {
    RestoreOutcome::Restored => FolderRestoreOutcome::Restored,
    RestoreOutcome::NoCheckpoint => FolderRestoreOutcome::NoCheckpoint,
    RestoreOutcome::NotNewest => FolderRestoreOutcome::NotNewest,
    RestoreOutcome::FolderBusy => FolderRestoreOutcome::FolderBusy,
    RestoreOutcome::Failed => FolderRestoreOutcome::Failed,
  }
}

impl HarnessReports for SidecarHarnessHost {
  fn reports(&self) -> Vec<HarnessReport> {
    Harness::ALL
      .iter()
      .map(|&harness| match self.shared.cached(harness) {
        Some(cached) => cached.report,
        // Installed and not probed yet: being checked, never missing.
        None if self.shared.harnesses.installed(harness).is_some() => {
          probe_pending(harness)
        }
        None => HarnessReport::NotInstalled(MissingHarness { id: harness }),
      })
      .collect()
  }

  fn settled(&self) -> bool {
    self.shared.settled()
  }

  fn changes(&self) -> Option<watch::Receiver<u64>> {
    Some(self.shared.changes.subscribe())
  }
}
