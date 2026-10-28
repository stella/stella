//! The harness sidecar: the compiled `packages/agent-engine` program that runs
//! a local coding-agent CLI behind its adapter, spoken to over stdio.
//!
//! One supervisor task owns the child process. It writes host messages to
//! the child's stdin, reads protocol lines from its stdout and records every
//! stderr line through `tracing`, so sidecar logs land in the desktop log.
//! When the child exits or breaks the protocol, every run it held finishes
//! as `failed`, and the child restarts after an exponential backoff that
//! resets once a session stayed up long enough. The child is killed when the
//! supervisor drops it, and it exits by itself when its stdin closes, so it
//! never outlives the app.
//!
//! The methods mirror the desktop runner's harness host: they return at once,
//! and each accepted run reports through its own channel, ending with
//! [`SidecarRunOutput::Finished`].

// The desktop runner's harness host is the caller; until it lands only the
// tests drive the supervisor.
#![allow(dead_code, reason = "the desktop runner's harness host calls this")]

mod protocol;
#[cfg(all(test, unix))]
mod tests;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

pub(crate) use protocol::{HarnessProbe, ProbeOutcome, SidecarRunStart};
use protocol::{
  HostHello, HostMessage, MAX_LINE_BYTES, SIDECAR_PROTOCOL, SidecarMessage,
};

use crate::runner_protocol::{
  ApprovalKind, Harness, HarnessModel, HarnessReport, JsonObject, ReadyHarness,
  RunApproval, RunOutcome, RunRef, RunTokenRefresh, SignedOutHarness,
  UnsupportedHarness,
};

const LOG_TARGET: &str = "harness_sidecar";
/// Bound on queued commands; beyond it a command is refused as busy.
const COMMAND_QUEUE: usize = 256;
/// Bound on a run's undelivered outputs before the sidecar's stdout waits.
const RUN_OUTPUT_QUEUE: usize = 256;
const MAX_LOG_LINE_CHARS: usize = 2000;
/// What the sidecar is named next to the app executable in a bundle.
const BUNDLED_NAME: &str = "stella-agent-sidecar";

/// How the sidecar process is started.
#[derive(Debug, Clone)]
pub(crate) struct SidecarLaunch {
  program: PathBuf,
  args: Vec<OsString>,
  env: Vec<(OsString, OsString)>,
}

impl SidecarLaunch {
  /// The compiled sidecar Tauri places beside the app executable.
  pub(crate) fn bundled(app_executable: &Path) -> Option<Self> {
    let program = app_executable
      .parent()?
      .join(format!("{BUNDLED_NAME}{}", std::env::consts::EXE_SUFFIX));
    Some(Self::program(program, Vec::new()))
  }

  /// A debug build runs the TypeScript entry with `bun` from the checkout.
  pub(crate) fn from_source(bun: PathBuf) -> Self {
    let entry = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../../../packages/agent-engine/src/sidecar/main.ts");
    Self::program(bun, vec![entry.into_os_string()])
  }

  pub(crate) fn program(program: PathBuf, args: Vec<OsString>) -> Self {
    Self {
      program,
      args,
      env: Vec::new(),
    }
  }

  #[must_use]
  pub(crate) fn env(
    mut self,
    name: impl Into<OsString>,
    value: impl Into<OsString>,
  ) -> Self {
    self.env.push((name.into(), value.into()));
    self
  }
}

/// Restart delays: `initial`, doubling up to `max`. A session that stayed up
/// for `stable_after` starts the sequence over.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RestartBackoff {
  pub(crate) initial: Duration,
  pub(crate) max: Duration,
  pub(crate) stable_after: Duration,
}

impl RestartBackoff {
  pub(crate) const DEFAULT: Self = Self {
    initial: Duration::from_millis(500),
    max: Duration::from_secs(60),
    stable_after: Duration::from_secs(120),
  };

  fn delay(self, failures: u32) -> Duration {
    self
      .initial
      .saturating_mul(2u32.saturating_pow(failures.min(16)))
      .min(self.max)
  }
}

#[derive(Debug, Clone)]
pub(crate) struct SidecarSettings {
  pub(crate) launch: SidecarLaunch,
  pub(crate) app_version: String,
  /// The stella API origin; the sidecar's MCP proxy forwards nowhere else.
  pub(crate) api_origin: String,
  pub(crate) hello_timeout: Duration,
  /// How long `shutdown` waits for the sidecar to stop its runs.
  pub(crate) shutdown_grace: Duration,
  pub(crate) backoff: RestartBackoff,
}

/// One thing a run produced, in order; the runner's `RunOutput`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SidecarRunOutput {
  /// A TanStack `StreamChunk`.
  Event(JsonObject),
  ApprovalRequest {
    request_id: String,
    kind: ApprovalKind,
    summary: String,
  },
  Finished {
    outcome: RunOutcome,
    harness_session_id: Option<String>,
  },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SidecarUnavailable {
  /// The command queue is full.
  Busy,
  /// The supervisor stopped.
  Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeError {
  /// The sidecar was not running, or exited before it answered.
  SidecarDown,
  Unavailable(SidecarUnavailable),
}

enum Control {
  StartRun {
    start: Box<SidecarRunStart>,
    outputs: mpsc::Sender<SidecarRunOutput>,
  },
  Probe {
    probe: HarnessProbe,
    reply: oneshot::Sender<Result<ProbeOutcome, ProbeError>>,
  },
  Forward(HostMessage),
  Shutdown(oneshot::Sender<()>),
}

/// A handle to the supervised sidecar; clones share it.
#[derive(Clone)]
pub(crate) struct HarnessSidecar {
  controls: mpsc::Sender<Control>,
}

impl HarnessSidecar {
  /// Start supervising on the current Tokio runtime.
  pub(crate) fn spawn(settings: SidecarSettings) -> Self {
    let (controls, receiver) = mpsc::channel(COMMAND_QUEUE);
    tokio::spawn(
      Supervisor {
        settings,
        controls: receiver,
        runs: HashMap::new(),
        probes: HashMap::new(),
      }
      .run(),
    );
    Self { controls }
  }

  fn control(&self, control: Control) -> Result<(), SidecarUnavailable> {
    self
      .controls
      .try_send(control)
      .map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => SidecarUnavailable::Busy,
        mpsc::error::TrySendError::Closed(_) => SidecarUnavailable::Stopped,
      })
  }

  /// Hand a run to the sidecar. Everything it produces arrives on the
  /// returned channel, ending with [`SidecarRunOutput::Finished`].
  pub(crate) fn start_run(
    &self,
    start: SidecarRunStart,
  ) -> Result<mpsc::Receiver<SidecarRunOutput>, SidecarUnavailable> {
    let (outputs, receiver) = mpsc::channel(RUN_OUTPUT_QUEUE);
    self.control(Control::StartRun {
      start: Box::new(start),
      outputs,
    })?;
    Ok(receiver)
  }

  pub(crate) fn approval(
    &self,
    approval: RunApproval,
  ) -> Result<(), SidecarUnavailable> {
    self.control(Control::Forward(HostMessage::RunApproval(approval)))
  }

  pub(crate) fn interrupt(&self, run_id: &str) -> Result<(), SidecarUnavailable> {
    self.control(Control::Forward(HostMessage::RunInterrupt(RunRef {
      run_id: run_id.to_owned(),
    })))
  }

  pub(crate) fn cancel(&self, run_id: &str) -> Result<(), SidecarUnavailable> {
    self.control(Control::Forward(HostMessage::RunCancel(RunRef {
      run_id: run_id.to_owned(),
    })))
  }

  /// A newer MCP token for the run; the sidecar's proxy uses it next.
  pub(crate) fn token(
    &self,
    refresh: RunTokenRefresh,
  ) -> Result<(), SidecarUnavailable> {
    self.control(Control::Forward(HostMessage::RunToken(refresh)))
  }

  /// The harness's version, account state and models, without a prompt.
  pub(crate) async fn probe(
    &self,
    probe: HarnessProbe,
  ) -> Result<ProbeOutcome, ProbeError> {
    let (reply, answer) = oneshot::channel();
    self
      .control(Control::Probe { probe, reply })
      .map_err(ProbeError::Unavailable)?;
    answer.await.map_err(|_supervisor_gone| {
      ProbeError::Unavailable(SidecarUnavailable::Stopped)
    })?
  }

  /// Stop every run, let the sidecar exit, and stop supervising.
  pub(crate) async fn shutdown(&self) {
    let (done, stopped) = oneshot::channel();
    if self.controls.send(Control::Shutdown(done)).await.is_ok() {
      // An error means the supervisor already stopped.
      let _stopped = stopped.await;
    }
  }
}

/// The runner's report for a probed harness. A ready harness with no model
/// it can offer is reported as unsupported at that version.
pub(crate) fn harness_report(
  harness: Harness,
  outcome: &ProbeOutcome,
) -> HarnessReport {
  match outcome {
    ProbeOutcome::Ready {
      version,
      capabilities,
      models,
    } => {
      let mut seen = std::collections::HashSet::new();
      let models: Vec<HarnessModel> = models
        .iter()
        .filter(|model| seen.insert(model.id.clone()))
        .map(|model| HarnessModel {
          id: model.id.clone(),
          label: model.label.clone(),
        })
        .collect();
      if models.is_empty() {
        return HarnessReport::Unsupported(UnsupportedHarness {
          id: harness,
          version: Some(version.clone()),
        });
      }
      let mut listed = std::collections::HashSet::new();
      let capabilities = capabilities
        .iter()
        .copied()
        .filter(|capability| listed.insert(capability.wire_name()))
        .collect();
      HarnessReport::Ready(ReadyHarness {
        id: harness,
        version: version.clone(),
        capabilities,
        models,
      })
    }
    ProbeOutcome::NeedsLogin { version } => {
      HarnessReport::NeedsLogin(SignedOutHarness {
        id: harness,
        version: version.clone(),
      })
    }
    ProbeOutcome::Failed { .. } => HarnessReport::Unsupported(UnsupportedHarness {
      id: harness,
      version: None,
    }),
  }
}

enum SessionEnd {
  Shutdown,
  Ended,
}

#[derive(Debug)]
enum LineError {
  TooLarge,
  Invalid(serde_json::error::Category),
}

struct Supervisor {
  settings: SidecarSettings,
  controls: mpsc::Receiver<Control>,
  runs: HashMap<String, mpsc::Sender<SidecarRunOutput>>,
  probes: HashMap<String, oneshot::Sender<Result<ProbeOutcome, ProbeError>>>,
}

impl Supervisor {
  async fn run(mut self) {
    let mut failures = 0;
    loop {
      let started = Instant::now();
      let end = self.session().await;
      self.fail_held();
      if matches!(end, SessionEnd::Shutdown) {
        return;
      }
      if started.elapsed() >= self.settings.backoff.stable_after {
        failures = 0;
      }
      let delay = self.settings.backoff.delay(failures);
      failures = failures.saturating_add(1);
      tracing::warn!(
        target: LOG_TARGET,
        delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
        "harness sidecar stopped; restarting"
      );
      if matches!(self.wait(delay).await, SessionEnd::Shutdown) {
        return;
      }
    }
  }

  /// Every run and probe the ended session held finishes as failed.
  fn fail_held(&mut self) {
    for (_run_id, outputs) in self.runs.drain() {
      tokio::spawn(async move {
        // A dropped receiver means nobody waits for the run any more.
        let _delivered = outputs
          .send(SidecarRunOutput::Finished {
            outcome: RunOutcome::Failed,
            harness_session_id: None,
          })
          .await;
      });
    }
    for (_request_id, reply) in self.probes.drain() {
      let _delivered = reply.send(Err(ProbeError::SidecarDown));
    }
  }

  /// The restart delay; commands meanwhile are answered as failed.
  async fn wait(&mut self, delay: Duration) -> SessionEnd {
    let sleep = tokio::time::sleep(delay);
    tokio::pin!(sleep);
    loop {
      tokio::select! {
        () = &mut sleep => return SessionEnd::Ended,
        control = self.controls.recv() => match control {
          None => return SessionEnd::Shutdown,
          Some(Control::Shutdown(done)) => {
            self.controls.close();
            let _delivered = done.send(());
            return SessionEnd::Shutdown;
          }
          Some(Control::StartRun { start, outputs }) => {
            self.runs.insert(start.run_id.clone(), outputs);
            self.fail_held();
          }
          Some(Control::Probe { reply, .. }) => {
            let _delivered = reply.send(Err(ProbeError::SidecarDown));
          }
          Some(Control::Forward(_message)) => {}
        },
      }
    }
  }

  async fn session(&mut self) -> SessionEnd {
    let launch = &self.settings.launch;
    let spawned = Command::new(&launch.program)
      .args(&launch.args)
      .envs(launch.env.iter().map(|(name, value)| (name, value)))
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .kill_on_drop(true)
      .spawn();
    let mut child = match spawned {
      Ok(child) => child,
      Err(error) => {
        tracing::error!(target: LOG_TARGET, kind = ?error.kind(), "harness sidecar did not start");
        return SessionEnd::Ended;
      }
    };
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
      (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
      return SessionEnd::Ended;
    };
    tokio::spawn(log_stderr(stderr));
    let (lines, mut messages) = mpsc::channel(RUN_OUTPUT_QUEUE);
    tokio::spawn(read_messages(stdout, lines));

    let hello = HostMessage::Hello(HostHello {
      protocol: SIDECAR_PROTOCOL,
      app_version: self.settings.app_version.clone(),
      api_origin: self.settings.api_origin.clone(),
    });
    if write_message(&mut stdin, &hello).await.is_err() {
      return SessionEnd::Ended;
    }
    match tokio::time::timeout(self.settings.hello_timeout, messages.recv()).await {
      Ok(Some(Ok(SidecarMessage::Hello(hello))))
        if hello.protocol == SIDECAR_PROTOCOL =>
      {
        tracing::info!(
          target: LOG_TARGET,
          sidecar_version = %hello.sidecar_version,
          "harness sidecar started"
        );
      }
      _ => {
        tracing::error!(target: LOG_TARGET, "harness sidecar did not complete its hello");
        return SessionEnd::Ended;
      }
    }

    loop {
      tokio::select! {
        control = self.controls.recv() => match control {
          None => {
            self.stop(child, stdin).await;
            return SessionEnd::Shutdown;
          }
          Some(Control::Shutdown(done)) => {
            // Later commands are refused as stopped, not queued.
            self.controls.close();
            self.stop(child, stdin).await;
            self.fail_held();
            let _delivered = done.send(());
            return SessionEnd::Shutdown;
          }
          Some(Control::StartRun { start, outputs }) => {
            let run_id = start.run_id.clone();
            if self.runs.contains_key(&run_id) {
              tracing::warn!(target: LOG_TARGET, "a run was started twice");
              continue;
            }
            self.runs.insert(run_id, outputs);
            if write_message(&mut stdin, &HostMessage::RunStart(start)).await.is_err() {
              break;
            }
          }
          Some(Control::Probe { probe, reply }) => {
            self.probes.insert(probe.request_id.clone(), reply);
            if write_message(&mut stdin, &HostMessage::HarnessProbe(probe)).await.is_err() {
              break;
            }
          }
          Some(Control::Forward(message)) => {
            if write_message(&mut stdin, &message).await.is_err() {
              break;
            }
          }
        },
        message = messages.recv() => match message {
          Some(Ok(message)) => self.dispatch(message).await,
          Some(Err(error)) => {
            tracing::error!(target: LOG_TARGET, ?error, "harness sidecar broke the protocol");
            break;
          }
          None => break,
        },
      }
    }
    kill(child).await;
    SessionEnd::Ended
  }

  async fn dispatch(&mut self, message: SidecarMessage) {
    match message {
      SidecarMessage::Hello(_) => {
        tracing::warn!(target: LOG_TARGET, "harness sidecar repeated its hello");
      }
      SidecarMessage::HarnessProbed(probed) => {
        if let Some(reply) = self.probes.remove(&probed.request_id) {
          let _delivered = reply.send(Ok(probed.outcome));
        }
      }
      SidecarMessage::RunEvent(event) => {
        self
          .deliver(&event.run_id, SidecarRunOutput::Event(event.chunk.0))
          .await;
      }
      SidecarMessage::RunApprovalRequest(request) => {
        self
          .deliver(
            &request.run_id,
            SidecarRunOutput::ApprovalRequest {
              request_id: request.request_id,
              kind: request.kind,
              summary: request.summary,
            },
          )
          .await;
      }
      SidecarMessage::RunFinished(finished) => {
        if let Some(outputs) = self.runs.remove(&finished.run_id) {
          let _delivered = outputs
            .send(SidecarRunOutput::Finished {
              outcome: finished.outcome,
              harness_session_id: finished.harness_session_id,
            })
            .await;
        }
      }
      SidecarMessage::Rejected(rejected) => {
        tracing::warn!(
          target: LOG_TARGET,
          reason = rejected.reason.wire_name(),
          message_type = rejected.message_type.as_deref().unwrap_or(""),
          "harness sidecar rejected a message"
        );
      }
    }
  }

  async fn deliver(&self, run_id: &str, output: SidecarRunOutput) {
    if let Some(outputs) = self.runs.get(run_id) {
      let _delivered = outputs.send(output).await;
    }
  }

  /// Ask the sidecar to stop its runs and exit; kill it after the grace.
  async fn stop(&self, mut child: Child, mut stdin: ChildStdin) {
    let _written = write_message(&mut stdin, &HostMessage::Shutdown).await;
    drop(stdin);
    if tokio::time::timeout(self.settings.shutdown_grace, child.wait())
      .await
      .is_err()
    {
      kill(child).await;
    }
  }
}

async fn kill(mut child: Child) {
  if let Err(error) = child.kill().await {
    tracing::warn!(target: LOG_TARGET, kind = ?error.kind(), "harness sidecar was not killed");
  }
}

async fn write_message(
  stdin: &mut ChildStdin,
  message: &HostMessage,
) -> Result<(), ()> {
  let mut line = serde_json::to_vec(message).map_err(|_unserializable| ())?;
  if line.len() > MAX_LINE_BYTES {
    tracing::error!(target: LOG_TARGET, "a host message exceeded the line limit");
    return Err(());
  }
  line.push(b'\n');
  let written = stdin.write_all(&line).await;
  let flushed = stdin.flush().await;
  written.and(flushed).map_err(|error| {
    tracing::warn!(target: LOG_TARGET, kind = ?error.kind(), "harness sidecar stdin closed");
  })
}

/// One line at most `limit` bytes long, without its newline; `None` at EOF.
async fn read_line<R: AsyncRead + Unpin>(
  reader: &mut BufReader<R>,
  limit: usize,
) -> Option<Result<Vec<u8>, LineError>> {
  let mut line = Vec::new();
  let cap = u64::try_from(limit.saturating_add(1)).unwrap_or(u64::MAX);
  match (&mut *reader).take(cap).read_until(b'\n', &mut line).await {
    Ok(0) | Err(_) => None,
    Ok(_) if line.last() == Some(&b'\n') => {
      line.pop();
      if line.last() == Some(&b'\r') {
        line.pop();
      }
      Some(Ok(line))
    }
    Ok(_) if line.len() > limit => Some(Err(LineError::TooLarge)),
    // The last line before EOF, without a newline.
    Ok(_) => Some(Ok(line)),
  }
}

async fn read_messages<R: AsyncRead + Unpin>(
  stdout: R,
  messages: mpsc::Sender<Result<SidecarMessage, LineError>>,
) {
  let mut reader = BufReader::new(stdout);
  while let Some(line) = read_line(&mut reader, MAX_LINE_BYTES).await {
    let parsed = line.and_then(|line| {
      serde_json::from_slice::<SidecarMessage>(&line)
        .map_err(|error| LineError::Invalid(error.classify()))
    });
    let stop = parsed.is_err();
    if messages.send(parsed).await.is_err() || stop {
      return;
    }
  }
}

async fn log_stderr<R: AsyncRead + Unpin>(stderr: R) {
  let mut reader = BufReader::new(stderr);
  while let Some(line) = read_line(&mut reader, MAX_LINE_BYTES).await {
    match line {
      Ok(line) => {
        let text = String::from_utf8_lossy(&line);
        let text: String = text.chars().take(MAX_LOG_LINE_CHARS).collect();
        if !text.trim().is_empty() {
          tracing::info!(target: LOG_TARGET, "{text}");
        }
      }
      Err(_too_large) => {
        tracing::warn!(target: LOG_TARGET, "harness sidecar wrote an oversized log line");
        return;
      }
    }
  }
}
