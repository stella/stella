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
//! - The holder numbers a run's outputs itself. The host relays each one
//!   with that number ([`RunSink::relay`]), so the runner journals the
//!   holder position with the output, and acks the holder only after the
//!   journal holds it. A restarted app resumes the holder after the
//!   journaled position ([`HarnessHost::reattach`]): nothing is lost or
//!   sent twice.
//! - A harness process whose launch needs the desktop's authorization (Codex
//!   on the user's ChatGPT plan) is granted when the holder reports it, and
//!   again when a restarted app resumes the run.
//! - `run.input` is not supported: each chat turn is its own run that
//!   resumes the harness's session. Input is answered with a `RUN_ERROR`
//!   chunk (`input_unsupported`) on the run's stream; the run goes on.
//! - Each run works in its own folder under the app's data, created for the
//!   user alone and removed once the run finished.

use std::{
  collections::HashMap,
  num::NonZeroU32,
  path::{Path, PathBuf},
  sync::{Arc, Mutex, MutexGuard, PoisonError},
  time::Duration,
};

use futures_util::future::BoxFuture;
use serde_json::json;
use tokio::sync::{Notify, mpsc, watch};
use uuid::Uuid;

use super::harness::{
  EmitError, HarnessHost, HarnessReports, JournaledRun, RunOutput, RunSink,
};
use crate::harness_sidecar::{
  self, HarnessLaunchSettings, HarnessProbe, HarnessProcess, HarnessSidecar,
  ResumeError, SidecarDelivery, SidecarRunOutput, SidecarRunStart, SidecarSettings,
};
use crate::runner_protocol::{
  Harness, HarnessReport, JsonObject, MissingHarness, RejectReason, RunApproval,
  RunInput, RunOutcome, RunStart, RunTokenRefresh,
};

const LOG_TARGET: &str = "desktop_runner::host";
/// How often reports are probed again without a reason to.
pub(crate) const PROBE_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// Retries of an output the journal could not record, doubling up to this.
const STORAGE_RETRY_CAP: Duration = Duration::from_secs(30);
const STORAGE_RETRY_FIRST: Duration = Duration::from_millis(250);
const INPUT_UNSUPPORTED: &str = "input_unsupported";
const OUTPUT_TOO_LARGE: &str = "output_too_large";

/// An installed harness CLI, kept in place while `lease` lives.
pub(crate) struct InstalledHarness {
  pub(crate) version: String,
  pub(crate) executable: PathBuf,
  pub(crate) config_dir: PathBuf,
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

/// The managed CLIs on this computer and what their launches add.
pub(crate) trait LocalHarnesses: Send + Sync + 'static {
  /// The installed CLI, held in place until the lease drops; `None` when
  /// the harness is not installed here.
  fn installed(&self, harness: Harness) -> Option<InstalledHarness>;
  /// What the harness's launch adds right now; `None` adds nothing.
  fn credentials(&self, harness: Harness) -> BoxFuture<'_, Option<HarnessCredentials>>;
}

pub(crate) struct HostSettings {
  /// The supervisor's settings; `api_origin` is the connecting account's.
  pub(crate) sidecar: SidecarSettings,
  /// Where each run's own folder is made.
  pub(crate) workspaces: PathBuf,
  pub(crate) probe_interval: Duration,
}

#[derive(Clone)]
struct Cached {
  report: HarnessReport,
  credentials: Option<HarnessCredentials>,
}

/// A run this host relays.
struct HostRun {
  /// The sink the runner handed over last; a restarted runner replaces it.
  sink: watch::Sender<RunSink>,
  /// Authorizes the run's harness process, when its launch needs that.
  grant: Option<ProcessGrant>,
  /// For the chunks the host makes up itself; unknown for a run picked up
  /// after a restart.
  model: Option<String>,
  thread_id: Option<String>,
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
  pub(crate) fn new(
    settings: HostSettings,
    harnesses: Arc<dyn LocalHarnesses>,
  ) -> Self {
    Self {
      shared: Arc::new(Shared {
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

  fn workspace(&self, run_id: Uuid) -> PathBuf {
    self.settings.workspaces.join(run_id.to_string())
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
    Some(HarnessReport::Ready(ready)) => {
      if ready.version != start.harness_version {
        Some(RejectReason::HarnessVersionUnavailable)
      } else if !ready.models.iter().any(|model| model.id == start.model) {
        Some(RejectReason::ModelUnavailable)
      } else {
        None
      }
    }
  }
}

/// A folder for the user alone; the parent is made the same way.
fn private_folder(dir: &Path) -> std::io::Result<()> {
  if let Some(parent) = dir.parent() {
    crate::local_store::create_private_dir(parent)?;
  }
  crate::local_store::create_private_dir(dir)
}

fn remove_workspace(dir: PathBuf) {
  tokio::task::spawn_blocking(move || match std::fs::remove_dir_all(&dir) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => {
      tracing::warn!(target: LOG_TARGET, kind = ?error.kind(), "a run's folder was not removed");
    }
  });
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

enum Relayed {
  /// The journal holds it.
  Recorded,
  /// Over the frame limit; nothing was recorded.
  TooLarge,
  /// The runner no longer holds the run.
  Closed,
  /// The host no longer holds the run.
  Gone,
}

/// Hand one output to the run's current sink until the journal holds it,
/// the runner gives the run up, or the host does. A runner that stopped is
/// waited out: the next one hands over a new sink.
async fn relay(
  sinks: &mut watch::Receiver<RunSink>,
  output: &RunOutput,
  source_seq: Option<NonZeroU32>,
) -> Relayed {
  let mut retry = STORAGE_RETRY_FIRST;
  loop {
    let sink = sinks.borrow_and_update().clone();
    let emitted = match source_seq {
      Some(seq) => sink.relay(output.clone(), seq).await,
      None => sink.emit(output.clone()).await,
    };
    match emitted {
      Ok(_seq) => return Relayed::Recorded,
      Err(EmitError::TooLarge) => return Relayed::TooLarge,
      Err(EmitError::RunClosed) => return Relayed::Closed,
      Err(EmitError::Storage) => {
        tracing::warn!(target: LOG_TARGET, "the runner journal refused a run output; retrying");
        tokio::time::sleep(retry).await;
        retry = retry.saturating_mul(2).min(STORAGE_RETRY_CAP);
      }
      Err(EmitError::Stopped) => {
        if sinks.changed().await.is_err() {
          return Relayed::Gone;
        }
      }
    }
  }
}

/// Relay a run's outputs until it finished; ack the holder after each one
/// the journal holds.
async fn pump(
  shared: Arc<Shared>,
  sidecar: HarnessSidecar,
  run_id: String,
  mut outputs: mpsc::Receiver<SidecarDelivery>,
  mut sinks: watch::Receiver<RunSink>,
  lease: Option<Box<dyn Send + Sync>>,
) {
  let outcome = loop {
    let delivery = outputs.recv().await.unwrap_or_else(|| {
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
    let outcome = match &delivery.output {
      SidecarRunOutput::Finished { outcome, .. } => Some(*outcome),
      _ => None,
    };
    let output = sidecar_output(delivery.output);
    let relayed = match relay(&mut sinks, &output, delivery.holder_seq).await {
      Relayed::TooLarge => {
        tracing::warn!(target: LOG_TARGET, "a run output exceeded the frame limit; sent an error instead");
        let (model, thread_id) = locked(&shared.runs)
          .get(&run_id)
          .map(|run| (run.model.clone(), run.thread_id.clone()))
          .unwrap_or_default();
        let error = run_error(
          &run_id,
          model.as_deref(),
          thread_id.as_deref(),
          OUTPUT_TOO_LARGE,
          "The harness produced an output larger than the runner can send.",
        );
        relay(&mut sinks, &error, delivery.holder_seq).await
      }
      other => other,
    };
    if matches!(relayed, Relayed::Gone) {
      // The host let the run go; the holder keeps it for the next app.
      return;
    }
    // Recorded, or the runner gave the run up: either way the holder need
    // not keep it any longer.
    if let Some(seq) = delivery.holder_seq
      && sidecar.ack(&run_id, seq).is_err()
    {
      tracing::warn!(target: LOG_TARGET, "the harness holder could not be acked");
    }
    if let Some(outcome) = outcome {
      break outcome;
    }
  };
  locked(&shared.runs).remove(&run_id);
  locked(&shared.grants).remove(&run_id);
  drop(lease);
  if let Ok(uuid) = Uuid::parse_str(&run_id) {
    remove_workspace(shared.workspace(uuid));
  }
  if matches!(outcome, RunOutcome::NeedsLogin | RunOutcome::LimitReached) {
    shared.refresh.notify_one();
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

/// Probe every harness now, then on the interval or when asked to.
async fn refresh_reports(shared: Arc<Shared>, sidecar: HarnessSidecar) {
  loop {
    for &harness in Harness::ALL {
      probe(&shared, &sidecar, harness).await;
    }
    tokio::select! {
      () = tokio::time::sleep(shared.settings.probe_interval) => {}
      () = shared.refresh.notified() => {}
    }
  }
}

async fn probe(shared: &Shared, sidecar: &HarnessSidecar, harness: Harness) {
  let Some(installed) = shared.harnesses.installed(harness) else {
    shared.store(
      harness,
      Cached {
        report: HarnessReport::NotInstalled(MissingHarness { id: harness }),
        credentials: None,
      },
    );
    return;
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
    Ok(outcome) => shared.store(
      harness,
      Cached {
        report: harness_sidecar::harness_report(harness, &outcome),
        credentials,
      },
    ),
    // The last report stands until a probe answers again.
    Err(error) => {
      tracing::warn!(target: LOG_TARGET, ?error, "a harness could not be probed");
    }
  }
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
    outputs: mpsc::Receiver<SidecarDelivery>,
    sinks: watch::Receiver<RunSink>,
    lease: Option<Box<dyn Send + Sync>>,
  ) {
    tokio::spawn(pump(
      Arc::clone(&self.shared),
      sidecar,
      run_id,
      outputs,
      sinks,
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
      let sinks = locked(&self.shared.runs).get_mut(&run.run_id).map(|entry| {
        entry.grant = grant;
        entry.sink.subscribe()
      });
      let Some(sinks) = sinks else {
        continue;
      };
      match sidecar.resume_run(&run.run_id, run.source_seq).await {
        Ok(outputs) => {
          tracing::info!(target: LOG_TARGET, "picked up a run the harness holder kept");
          self.spawn_pump(sidecar.clone(), run.run_id, outputs, sinks, None);
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
    let mut sinks = entry.sink.subscribe();
    let workspace = Uuid::parse_str(&run.run_id)
      .ok()
      .map(|uuid| self.shared.workspace(uuid));
    tokio::spawn(async move {
      let failed = RunOutput::Finished {
        outcome: RunOutcome::Failed,
        harness_session_id: None,
      };
      // Keeps the sender alive while the end is relayed.
      let _entry = entry;
      relay(&mut sinks, &failed, None).await;
      if let Some(workspace) = workspace {
        remove_workspace(workspace);
      }
    });
  }

  fn forward(what: &str, sent: Result<(), harness_sidecar::SidecarUnavailable>) {
    if let Err(error) = sent {
      tracing::warn!(target: LOG_TARGET, ?error, command = what, "a run command did not reach the harness holder");
    }
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
    *slot = Some((origin, sidecar));
  }

  fn reattach(&self, runs: Vec<JournaledRun>) {
    let Some(sidecar) = self.shared.sidecar() else {
      return;
    };
    let mut fresh = Vec::new();
    let mut held = locked(&self.shared.runs);
    for run in runs {
      if let Some(known) = held.get(&run.run_id) {
        // Relayed already: report through the new runner from now on.
        known.sink.send_replace(run.sink);
        continue;
      }
      held.insert(
        run.run_id.clone(),
        HostRun {
          sink: watch::channel(run.sink.clone()).0,
          grant: None,
          model: None,
          thread_id: None,
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
    let run_uuid =
      Uuid::parse_str(&start.run_id).map_err(|_not_uuid| RejectReason::UnknownRun)?;
    let cached = self.shared.cached(start.harness);
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
    let workspace = self.shared.workspace(run_uuid);
    if let Err(error) = private_folder(&workspace) {
      tracing::warn!(target: LOG_TARGET, kind = ?error.kind(), "a run's folder could not be made");
      return Err(RejectReason::AtCapacity);
    }
    let credentials = cached.and_then(|cached| cached.credentials);
    let thread_id = start
      .harness_session_id
      .clone()
      .unwrap_or_else(|| start.run_id.clone());
    let (sink, sinks) = watch::channel(sink);
    locked(&self.shared.runs).insert(
      start.run_id.clone(),
      HostRun {
        sink,
        grant: credentials.as_ref().and_then(|held| held.grant.clone()),
        model: Some(start.model.clone()),
        thread_id: Some(thread_id.clone()),
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
      model: start.model,
      instructions: start.instructions,
      messages: start.messages,
      harness_session_id: start.harness_session_id,
      policy: start.policy,
      mcp: start.mcp,
    });
    let outputs = match outputs {
      Ok(outputs) => outputs,
      Err(error) => {
        tracing::warn!(target: LOG_TARGET, ?error, "the harness holder took no run");
        locked(&self.shared.runs).remove(&run_id);
        remove_workspace(workspace);
        return Err(RejectReason::AtCapacity);
      }
    };
    self.spawn_pump(sidecar, run_id, outputs, sinks, Some(installed.lease));
    Ok(())
  }

  /// Local harnesses take no follow-up input: each chat turn is its own run.
  /// The input is answered on the run's stream instead of dropped.
  fn input(&self, input: RunInput) {
    tracing::warn!(target: LOG_TARGET, "a run received input local harnesses do not take");
    let held = locked(&self.shared.runs).get(&input.run_id).map(|run| {
      (
        run.sink.subscribe(),
        run.model.clone(),
        run.thread_id.clone(),
      )
    });
    let Some((mut sinks, model, thread_id)) = held else {
      return;
    };
    let error = run_error(
      &input.run_id,
      model.as_deref(),
      thread_id.as_deref(),
      INPUT_UNSUPPORTED,
      "Local harnesses take no input while a run is going; send it as the next turn.",
    );
    tokio::spawn(async move {
      relay(&mut sinks, &error, None).await;
    });
  }

  fn approval(&self, approval: RunApproval) {
    let sent = self
      .shared
      .sidecar()
      .map_or(Ok(()), |sidecar| sidecar.approval(approval));
    Self::forward("approval", sent);
  }

  fn interrupt(&self, run_id: &str) {
    let sent = self
      .shared
      .sidecar()
      .map_or(Ok(()), |sidecar| sidecar.interrupt(run_id));
    Self::forward("interrupt", sent);
  }

  fn cancel(&self, run_id: &str) {
    let sent = self
      .shared
      .sidecar()
      .map_or(Ok(()), |sidecar| sidecar.cancel(run_id));
    Self::forward("cancel", sent);
  }

  fn token(&self, refresh: RunTokenRefresh) {
    let sent = self
      .shared
      .sidecar()
      .map_or(Ok(()), |sidecar| sidecar.token(refresh));
    Self::forward("token", sent);
  }
}

impl HarnessReports for SidecarHarnessHost {
  fn reports(&self) -> Vec<HarnessReport> {
    Harness::ALL
      .iter()
      .map(|&harness| {
        self.shared.cached(harness).map_or(
          HarnessReport::NotInstalled(MissingHarness { id: harness }),
          |cached| cached.report,
        )
      })
      .collect()
  }

  fn changes(&self) -> Option<watch::Receiver<u64>> {
    Some(self.shared.changes.subscribe())
  }
}
