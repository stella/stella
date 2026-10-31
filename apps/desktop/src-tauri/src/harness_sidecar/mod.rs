//! The harness sidecar: the compiled `packages/agent-engine` program that runs
//! a local coding-agent CLI behind its adapter. It runs detached from the app
//! as the *holder* of its runs, so quitting, crashing or updating the app
//! never stops a run; the app reconnects and picks up where it stopped.
//!
//! Each sidecar version has its own folder, `<holder_root>/<version>/`
//! (0700): the holder's socket (a named pipe on Windows), the secret a
//! connection presents first, its log and, for a bundled build, the copy of
//! the binary it runs from, so an update never replaces a running binary.
//!
//! One supervisor task owns every connection. It connects to the holder of
//! the bundled version, or starts it detached and connects; it reconnects
//! after a dropped connection and resumes each run after the last message it
//! delivered. A holder that is gone fails its runs as `failed`. Holders of
//! other versions are asked to drain: they finish their runs, take no new
//! ones and exit; their folders are removed once nothing listens there.
//!
//! The holder numbers each run's messages (`seq`, from 1). A run's channel
//! carries them in order, without gaps or repeats, so the n-th output on a
//! channel opened after `after_seq` has `seq` `after_seq + n` (`start_run`
//! opens after 0). The runner relays that number as its own sequence and
//! calls [`HarnessSidecar::ack`] once the API stored a message; only then
//! does the holder drop it.
//!
//! Dropping every handle closes the connections and leaves the runs to the
//! holder: that is what quitting the app does. Only an explicit
//! [`HarnessSidecar::shutdown`] stops the runs and the holder.

// The desktop runner's harness host is the caller; until it lands only the
// tests drive the supervisor.
#![allow(dead_code, reason = "the desktop runner's harness host calls this")]

mod protocol;
#[cfg(all(test, unix))]
mod tests;

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{
  AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
  ReadHalf, WriteHalf,
};
use tokio::sync::{mpsc, oneshot};

pub(crate) use protocol::{HarnessProbe, HeldRun, ProbeOutcome, SidecarRunStart};
use protocol::{
  HolderSecret, HostHello, HostMessage, MAX_HELD_RUNS, MAX_LINE_BYTES, Rejection,
  ResumePoint, SIDECAR_PROTOCOL, SidecarHello, SidecarMessage,
};

use crate::runner_protocol::{
  Ack, ApprovalKind, Harness, HarnessModel, HarnessReport, JsonObject, ReadyHarness,
  RunApproval, RunOutcome, RunRef, RunTokenRefresh, SignedOutHarness,
  UnsupportedHarness,
};

const LOG_TARGET: &str = "harness_sidecar";
/// Bound on queued commands; beyond it a command is refused as busy.
const COMMAND_QUEUE: usize = 256;
/// Bound on a run's undelivered outputs before the holder's lines wait.
const RUN_OUTPUT_QUEUE: usize = 256;
const LINK_EVENT_QUEUE: usize = 256;
/// What the sidecar is named next to the app executable in a bundle.
const BUNDLED_NAME: &str = "stella-agent-sidecar";
const SOCKET_FILE: &str = "holder.sock";
const SECRET_FILE: &str = "holder.secret";
/// The variable a source build reads its version from (`env.ts`).
const VERSION_VARIABLE: &str = "STELLA_SIDECAR_VERSION";
/// How often a holder that is starting is tried until `start_timeout`.
const START_POLL: Duration = Duration::from_millis(25);
/// Connection attempts after a drop before a holder that answers but does
/// not let the desktop in counts as gone.
const RECONNECT_ATTEMPTS: u32 = 5;

/// How the holder binary is started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Install {
  /// Run the program where it is: a source build or a test stand-in.
  InPlace,
  /// Copy the program into the version's folder and run the copy.
  PerVersionCopy,
}

/// How the sidecar process is started.
#[derive(Debug, Clone)]
pub(crate) struct SidecarLaunch {
  program: PathBuf,
  args: Vec<OsString>,
  env: Vec<(OsString, OsString)>,
  install: Install,
}

impl SidecarLaunch {
  /// The compiled sidecar Tauri places beside the app executable, run from
  /// a copy in the version's folder.
  pub(crate) fn bundled(app_executable: &Path) -> Option<Self> {
    let program = app_executable
      .parent()?
      .join(format!("{BUNDLED_NAME}{}", std::env::consts::EXE_SUFFIX));
    Some(Self::program(program, Vec::new()).per_version_copy())
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
      install: Install::InPlace,
    }
  }

  /// Run from a copy in the version's folder instead of in place.
  #[must_use]
  pub(crate) fn per_version_copy(mut self) -> Self {
    self.install = Install::PerVersionCopy;
    self
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

/// Delays between connection attempts: `initial`, doubling up to `max`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ReconnectBackoff {
  pub(crate) initial: Duration,
  pub(crate) max: Duration,
}

impl ReconnectBackoff {
  pub(crate) const DEFAULT: Self = Self {
    initial: Duration::from_millis(100),
    max: Duration::from_secs(2),
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
  /// `<app data>/agent-holder`; each sidecar version has a folder below it.
  pub(crate) holder_root: PathBuf,
  /// The bundled sidecar's version, which names its folder.
  pub(crate) sidecar_version: String,
  pub(crate) app_version: String,
  /// The stella API origin; the sidecar's MCP proxy forwards nowhere else.
  pub(crate) api_origin: String,
  pub(crate) hello_timeout: Duration,
  /// How long a holder this supervisor started may take to listen.
  pub(crate) start_timeout: Duration,
  /// How long `shutdown` waits for the holders to stop their runs.
  pub(crate) shutdown_grace: Duration,
  pub(crate) backoff: ReconnectBackoff,
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
  /// No holder was reachable, or it went away before it answered.
  SidecarDown,
  Unavailable(SidecarUnavailable),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResumeError {
  /// No reachable holder holds the run.
  UnknownRun,
  /// The run already reports through another channel.
  AlreadyClaimed,
  Unavailable(SidecarUnavailable),
}

type ProbeReply = oneshot::Sender<Result<ProbeOutcome, ProbeError>>;

enum Control {
  StartRun {
    start: Box<SidecarRunStart>,
    outputs: mpsc::Sender<SidecarRunOutput>,
  },
  ResumeRun {
    point: ResumePoint,
    outputs: mpsc::Sender<SidecarRunOutput>,
    reply: oneshot::Sender<Result<(), ResumeError>>,
  },
  HeldRuns(oneshot::Sender<Vec<HeldRun>>),
  Probe {
    probe: HarnessProbe,
    reply: ProbeReply,
  },
  Forward {
    run_id: String,
    message: HostMessage,
  },
  Ack(Ack),
  Shutdown(oneshot::Sender<()>),
}

/// A handle to the supervised holder; clones share it.
#[derive(Clone)]
pub(crate) struct HarnessSidecar {
  controls: mpsc::Sender<Control>,
}

impl HarnessSidecar {
  /// Start supervising on the current Tokio runtime. The supervisor first
  /// connects to holders that are already running, so their runs are listed
  /// by [`Self::held_runs`] before any other command is handled.
  pub(crate) fn spawn(settings: SidecarSettings) -> Self {
    let (controls, receiver) = mpsc::channel(COMMAND_QUEUE);
    let (link_events, events) = mpsc::channel(LINK_EVENT_QUEUE);
    tokio::spawn(
      Supervisor {
        settings,
        controls: receiver,
        link_events,
        events,
        links: HashMap::new(),
        next_link: 0,
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

  /// Hand a run to the holder. Everything it produces arrives on the
  /// returned channel, `seq` 1 first, ending with
  /// [`SidecarRunOutput::Finished`].
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

  /// Every run the reachable holders hold, running or finished and not yet
  /// acked, with the latest `seq` known for each.
  pub(crate) async fn held_runs(&self) -> Result<Vec<HeldRun>, SidecarUnavailable> {
    let (reply, answer) = oneshot::channel();
    self.control(Control::HeldRuns(reply))?;
    answer
      .await
      .map_err(|_supervisor_gone| SidecarUnavailable::Stopped)
  }

  /// Report a held run on a new channel, from the message after `after_seq`
  /// on: what a runner does for each run the API resumes after a restart.
  pub(crate) async fn resume_run(
    &self,
    run_id: &str,
    after_seq: u32,
  ) -> Result<mpsc::Receiver<SidecarRunOutput>, ResumeError> {
    let (outputs, receiver) = mpsc::channel(RUN_OUTPUT_QUEUE);
    let (reply, answer) = oneshot::channel();
    self
      .control(Control::ResumeRun {
        point: ResumePoint {
          run_id: run_id.to_owned(),
          after_seq,
        },
        outputs,
        reply,
      })
      .map_err(ResumeError::Unavailable)?;
    answer.await.map_err(|_supervisor_gone| {
      ResumeError::Unavailable(SidecarUnavailable::Stopped)
    })??;
    Ok(receiver)
  }

  /// The API stored the run's messages up to `seq`; the holder drops them.
  pub(crate) fn ack(
    &self,
    run_id: &str,
    seq: NonZeroU32,
  ) -> Result<(), SidecarUnavailable> {
    self.control(Control::Ack(Ack {
      run_id: run_id.to_owned(),
      seq,
    }))
  }

  pub(crate) fn approval(
    &self,
    approval: RunApproval,
  ) -> Result<(), SidecarUnavailable> {
    self.forward(approval.run_id.clone(), HostMessage::RunApproval(approval))
  }

  pub(crate) fn interrupt(&self, run_id: &str) -> Result<(), SidecarUnavailable> {
    self.forward(
      run_id.to_owned(),
      HostMessage::RunInterrupt(RunRef {
        run_id: run_id.to_owned(),
      }),
    )
  }

  pub(crate) fn cancel(&self, run_id: &str) -> Result<(), SidecarUnavailable> {
    self.forward(
      run_id.to_owned(),
      HostMessage::RunCancel(RunRef {
        run_id: run_id.to_owned(),
      }),
    )
  }

  /// A newer MCP token for the run; the sidecar's proxy uses it next.
  pub(crate) fn token(
    &self,
    refresh: RunTokenRefresh,
  ) -> Result<(), SidecarUnavailable> {
    self.forward(refresh.run_id.clone(), HostMessage::RunToken(refresh))
  }

  fn forward(
    &self,
    run_id: String,
    message: HostMessage,
  ) -> Result<(), SidecarUnavailable> {
    self.control(Control::Forward { run_id, message })
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

  /// Stop every run, let every holder exit, and stop supervising. Quitting
  /// the app does not call this: runs keep going in the holder.
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
    // The runner report carries the refused version only.
    ProbeOutcome::Unsupported { version, .. } => {
      HarnessReport::Unsupported(UnsupportedHarness {
        id: harness,
        version: Some(version.clone()),
      })
    }
    ProbeOutcome::Failed { .. } => HarnessReport::Unsupported(UnsupportedHarness {
      id: harness,
      version: None,
    }),
  }
}

/// The holder's endpoint in its folder.
#[cfg(unix)]
fn endpoint(dir: &Path) -> OsString {
  dir.join(SOCKET_FILE).into_os_string()
}

/// A named pipe per folder: the folder is per user and per version.
#[cfg(windows)]
fn endpoint(dir: &Path) -> OsString {
  use sha2::{Digest, Sha256};
  let digest = Sha256::digest(dir.as_os_str().as_encoded_bytes());
  let name = hex::encode(&digest[..16]);
  OsString::from(format!(r"\\.\pipe\stella-agent-holder-{name}"))
}

trait HolderStream: AsyncRead + AsyncWrite + Send + Sync + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Sync + Unpin> HolderStream for T {}
type Stream = Box<dyn HolderStream>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenError {
  /// Nothing listens: no holder runs for the folder.
  Gone,
  /// A holder answers but the connection failed or was refused.
  Failed,
  /// The holder speaks another protocol.
  Incompatible,
}

#[cfg(unix)]
async fn connect(endpoint: &OsStr) -> Result<Stream, OpenError> {
  match tokio::net::UnixStream::connect(Path::new(endpoint)).await {
    Ok(stream) => Ok(Box::new(stream)),
    Err(error)
      if matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
      ) =>
    {
      Err(OpenError::Gone)
    }
    Err(_other) => Err(OpenError::Failed),
  }
}

#[cfg(windows)]
fn connect(endpoint: &OsStr) -> std::future::Ready<Result<Stream, OpenError>> {
  use tokio::net::windows::named_pipe::ClientOptions;
  let opened: Result<Stream, OpenError> = match ClientOptions::new().open(endpoint) {
    Ok(pipe) => Ok(Box::new(pipe)),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(OpenError::Gone),
    // Busy (ERROR_PIPE_BUSY) and the like: a holder is there.
    Err(_other) => Err(OpenError::Failed),
  };
  std::future::ready(opened)
}

fn read_secret(dir: &Path) -> Option<HolderSecret> {
  std::fs::read_to_string(dir.join(SECRET_FILE))
    .ok()
    .and_then(|text| HolderSecret::parse(&text))
}

/// Create the folder for the user alone, or refuse one others can reach.
fn private_dir(dir: &Path) -> std::io::Result<()> {
  #[cfg(unix)]
  {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
      .recursive(true)
      .mode(0o700)
      .create(dir)?;
    let mode = std::fs::metadata(dir)?.permissions().mode();
    if mode & 0o077 != 0 {
      return Err(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "the holder folder is open to other users",
      ));
    }
    Ok(())
  }
  #[cfg(not(unix))]
  {
    std::fs::create_dir_all(dir)
  }
}

/// The program to start: in place, or a byte copy in the version's folder.
/// The copy is written beside the target and renamed over it, so a holder
/// never starts from a half-written file.
fn installed_program(launch: &SidecarLaunch, dir: &Path) -> std::io::Result<PathBuf> {
  if launch.install == Install::InPlace {
    return Ok(launch.program.clone());
  }
  let target = dir.join(format!("{BUNDLED_NAME}{}", std::env::consts::EXE_SUFFIX));
  let size = std::fs::metadata(&launch.program)?.len();
  if std::fs::metadata(&target).is_ok_and(|existing| existing.len() == size) {
    return Ok(target);
  }
  let temporary = dir.join(format!(".{BUNDLED_NAME}.{}.tmp", uuid::Uuid::new_v4()));
  let copied = copy_bytes(&launch.program, &temporary)
    .and_then(|()| std::fs::rename(&temporary, &target));
  if copied.is_err() {
    let _removed = std::fs::remove_file(&temporary);
  }
  copied.map(|()| target)
}

/// A plain byte copy, executable by the user alone; a signature embedded in
/// the binary travels with it.
fn copy_bytes(source: &Path, target: &Path) -> std::io::Result<()> {
  let mut source = std::fs::File::open(source)?;
  let mut options = std::fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o700);
  let mut copy = options.open(target)?;
  std::io::copy(&mut source, &mut copy)?;
  copy.sync_all()
}

/// Start the holder detached: its own process group (Unix) or a detached
/// process outside the app's job (Windows), stdio closed, never killed when
/// the supervisor or the app goes away. Tokio reaps it if it exits first.
fn spawn_holder(
  launch: &SidecarLaunch,
  program: &Path,
  dir: &Path,
  version: &str,
) -> std::io::Result<()> {
  let mut command = tokio::process::Command::new(program);
  command
    .args(&launch.args)
    .arg("--dir")
    .arg(dir)
    .arg("--endpoint")
    .arg(endpoint(dir))
    .envs(launch.env.iter().map(|(name, value)| (name, value)))
    .env(VERSION_VARIABLE, version)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(unix)]
  command.process_group(0);
  #[cfg(windows)]
  {
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const ERROR_ACCESS_DENIED: i32 = 5;
    command.creation_flags(
      DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
    );
    match command.spawn() {
      Ok(_holder) => return Ok(()),
      // The app's job forbids breaking away; the holder then stays in it.
      Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
      }
      Err(error) => return Err(error),
    }
  }
  command.spawn().map(drop)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkRole {
  /// The bundled version's holder: new runs and probes go here.
  Current,
  /// An older version's holder, asked to drain.
  Draining,
}

/// A connection to one holder; dropping it closes the connection.
struct Link {
  id: u64,
  role: LinkRole,
  writer: WriteHalf<Stream>,
  reader: tokio::task::AbortHandle,
}

impl Drop for Link {
  fn drop(&mut self) {
    self.reader.abort();
  }
}

struct Opened {
  hello: SidecarHello,
  reader: BufReader<ReadHalf<Stream>>,
  writer: WriteHalf<Stream>,
}

#[derive(Debug)]
enum LineError {
  TooLarge,
  Invalid(serde_json::error::Category),
}

enum LinkEvent {
  Message(SidecarMessage),
  Broken(LineError),
  Closed,
}

struct Event {
  dir: PathBuf,
  link: u64,
  event: LinkEvent,
}

/// Who receives a run's outputs.
struct Claim {
  /// `None` once the run's last output was delivered.
  outputs: Option<mpsc::Sender<SidecarRunOutput>>,
  /// The last `seq` delivered on the channel.
  delivered: u32,
}

struct Run {
  /// The folder of the holder that holds the run.
  holder: PathBuf,
  harness: Harness,
  /// The latest `seq` this supervisor knows of.
  last_seq: u32,
  /// The `seq` of the run's last message, once it arrived.
  finished: Option<NonZeroU32>,
  /// `None` for a run a holder listed that no caller resumed yet.
  claim: Option<Claim>,
}

struct Supervisor {
  settings: SidecarSettings,
  controls: mpsc::Receiver<Control>,
  link_events: mpsc::Sender<Event>,
  events: mpsc::Receiver<Event>,
  links: HashMap<PathBuf, Link>,
  next_link: u64,
  runs: HashMap<String, Run>,
  probes: HashMap<String, (PathBuf, ProbeReply)>,
}

impl Supervisor {
  async fn run(mut self) {
    self.discover().await;
    loop {
      tokio::select! {
        control = self.controls.recv() => match control {
          // Every handle is gone: the app is quitting. The connections
          // close with the supervisor and the holders keep the runs.
          None => return,
          Some(Control::Shutdown(done)) => {
            self.stop_holders().await;
            let _delivered = done.send(());
            return;
          }
          Some(Control::StartRun { start, outputs }) => {
            self.start_run(start, outputs).await;
          }
          Some(Control::ResumeRun { point, outputs, reply }) => {
            self.resume_run(point, outputs, reply).await;
          }
          Some(Control::HeldRuns(reply)) => {
            let _delivered = reply.send(self.held_runs());
          }
          Some(Control::Probe { probe, reply }) => self.probe(probe, reply).await,
          Some(Control::Forward { run_id, message }) => {
            self.forward(&run_id, &message).await;
          }
          Some(Control::Ack(ack)) => self.ack(ack).await,
        },
        Some(event) = self.events.recv() => self.event(event).await,
      }
    }
  }

  fn current_dir(&self) -> PathBuf {
    self
      .settings
      .holder_root
      .join(&self.settings.sidecar_version)
  }

  /// Connect to the holders already running: the bundled version's, whose
  /// runs this app may resume, and older ones, which are asked to drain.
  /// A folder nothing listens in is an old holder's leftover and removed.
  async fn discover(&mut self) {
    let current = self.current_dir();
    if let Ok(opened) = self.open(&current).await {
      self.attach(current.clone(), opened, LinkRole::Current);
    }
    let Ok(entries) = std::fs::read_dir(&self.settings.holder_root) else {
      return;
    };
    for entry in entries.flatten() {
      let dir = entry.path();
      if dir == current || !dir.is_dir() {
        continue;
      }
      match self.open(&dir).await {
        Ok(opened) => {
          tracing::info!(
            target: LOG_TARGET,
            sidecar_version = %opened.hello.sidecar_version,
            "draining an older harness holder"
          );
          self.attach(dir.clone(), opened, LinkRole::Draining);
          self.write(&dir, &HostMessage::Drain).await;
        }
        Err(OpenError::Gone) => remove_holder_dir(&dir),
        // A holder this app cannot speak to exits once it is idle.
        Err(OpenError::Failed | OpenError::Incompatible) => {}
      }
    }
  }

  /// Where each run this supervisor delivers on `dir` stopped.
  fn resume_points(&self, dir: &Path) -> Vec<ResumePoint> {
    self
      .runs
      .iter()
      .filter_map(|(run_id, run)| {
        let claim = run.claim.as_ref()?;
        (run.holder == dir && claim.outputs.is_some()).then(|| ResumePoint {
          run_id: run_id.clone(),
          after_seq: claim.delivered,
        })
      })
      .take(MAX_HELD_RUNS)
      .collect()
  }

  /// Connect and complete the handshake, resuming this supervisor's runs.
  async fn open(&self, dir: &Path) -> Result<Opened, OpenError> {
    let stream = connect(&endpoint(dir)).await?;
    let secret = read_secret(dir).ok_or(OpenError::Failed)?;
    let (read, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(read);
    let hello = HostMessage::Hello(HostHello {
      protocol: SIDECAR_PROTOCOL,
      secret,
      app_version: self.settings.app_version.clone(),
      api_origin: self.settings.api_origin.clone(),
      resume: self.resume_points(dir),
    });
    write_message(&mut writer, &hello)
      .await
      .map_err(|()| OpenError::Failed)?;
    let answer = tokio::time::timeout(
      self.settings.hello_timeout,
      read_line(&mut reader, MAX_LINE_BYTES),
    )
    .await;
    let Ok(Some(Ok(line))) = answer else {
      return Err(OpenError::Failed);
    };
    match serde_json::from_slice::<SidecarMessage>(&line) {
      Ok(SidecarMessage::Hello(hello)) if hello.protocol == SIDECAR_PROTOCOL => {
        Ok(Opened {
          hello,
          reader,
          writer,
        })
      }
      Ok(SidecarMessage::Rejected(rejected))
        if rejected.reason == Rejection::ProtocolMismatch =>
      {
        Err(OpenError::Incompatible)
      }
      _ => Err(OpenError::Failed),
    }
  }

  /// Keep an open connection and settle the runs its holder lists: runs this
  /// supervisor had there and the holder no longer holds have failed.
  fn attach(&mut self, dir: PathBuf, opened: Opened, role: LinkRole) {
    let id = self.next_link;
    self.next_link = self.next_link.wrapping_add(1);
    let reader = tokio::spawn(read_messages(
      opened.reader,
      dir.clone(),
      id,
      self.link_events.clone(),
    ));
    self.links.insert(
      dir.clone(),
      Link {
        id,
        role,
        writer: opened.writer,
        reader: reader.abort_handle(),
      },
    );
    let listed: HashSet<&str> = opened
      .hello
      .runs
      .iter()
      .map(|held| held.run_id.as_str())
      .collect();
    let lost: Vec<String> = self
      .runs
      .iter()
      .filter(|(run_id, run)| run.holder == dir && !listed.contains(run_id.as_str()))
      .map(|(run_id, _run)| run_id.clone())
      .collect();
    for run_id in lost {
      self.fail_run(&run_id);
    }
    for held in opened.hello.runs {
      let run = self.runs.entry(held.run_id).or_insert_with(|| Run {
        holder: dir.clone(),
        harness: held.harness,
        last_seq: 0,
        finished: None,
        claim: None,
      });
      run.last_seq = run.last_seq.max(held.last_seq);
    }
  }

  /// The bundled version's holder, started if none runs.
  async fn current(&mut self) -> Option<PathBuf> {
    let dir = self.current_dir();
    if self.links.contains_key(&dir) {
      return Some(dir);
    }
    match self.open(&dir).await {
      Ok(opened) => {
        self.attach(dir.clone(), opened, LinkRole::Current);
        return Some(dir);
      }
      Err(OpenError::Incompatible) => {
        tracing::error!(target: LOG_TARGET, "the harness holder speaks another protocol");
        return None;
      }
      Err(OpenError::Gone | OpenError::Failed) => {}
    }
    if let Err(error) = self.start_holder(&dir) {
      tracing::error!(target: LOG_TARGET, kind = ?error.kind(), "harness holder did not start");
      return None;
    }
    let deadline = Instant::now() + self.settings.start_timeout;
    loop {
      match self.open(&dir).await {
        Ok(opened) => {
          tracing::info!(
            target: LOG_TARGET,
            sidecar_version = %opened.hello.sidecar_version,
            "harness holder started"
          );
          self.attach(dir.clone(), opened, LinkRole::Current);
          return Some(dir);
        }
        Err(OpenError::Incompatible) => return None,
        Err(OpenError::Gone | OpenError::Failed) if Instant::now() < deadline => {
          tokio::time::sleep(START_POLL).await;
        }
        Err(OpenError::Gone | OpenError::Failed) => {
          tracing::error!(target: LOG_TARGET, "harness holder did not answer after it started");
          return None;
        }
      }
    }
  }

  fn start_holder(&self, dir: &Path) -> std::io::Result<()> {
    private_dir(dir)?;
    let program = installed_program(&self.settings.launch, dir)?;
    spawn_holder(
      &self.settings.launch,
      &program,
      dir,
      &self.settings.sidecar_version,
    )
  }

  async fn start_run(
    &mut self,
    start: Box<SidecarRunStart>,
    outputs: mpsc::Sender<SidecarRunOutput>,
  ) {
    if self.runs.contains_key(&start.run_id) {
      tracing::warn!(target: LOG_TARGET, "a run was started twice");
      return;
    }
    let Some(dir) = self.current().await else {
      finish_failed(outputs);
      return;
    };
    self.runs.insert(
      start.run_id.clone(),
      Run {
        holder: dir.clone(),
        harness: start.harness,
        last_seq: 0,
        finished: None,
        claim: Some(Claim {
          outputs: Some(outputs),
          delivered: 0,
        }),
      },
    );
    self.write(&dir, &HostMessage::RunStart(start)).await;
  }

  async fn resume_run(
    &mut self,
    point: ResumePoint,
    outputs: mpsc::Sender<SidecarRunOutput>,
    reply: oneshot::Sender<Result<(), ResumeError>>,
  ) {
    let claimed = match self.runs.get_mut(&point.run_id) {
      None => Err(ResumeError::UnknownRun),
      Some(run) if run.claim.is_some() => Err(ResumeError::AlreadyClaimed),
      Some(run) => {
        run.claim = Some(Claim {
          outputs: Some(outputs),
          delivered: point.after_seq,
        });
        Ok(run.holder.clone())
      }
    };
    match claimed {
      Ok(dir) => {
        let _delivered = reply.send(Ok(()));
        self.write(&dir, &HostMessage::Resume(point)).await;
      }
      Err(error) => {
        let _delivered = reply.send(Err(error));
      }
    }
  }

  fn held_runs(&self) -> Vec<HeldRun> {
    self
      .runs
      .iter()
      .map(|(run_id, run)| HeldRun {
        run_id: run_id.clone(),
        harness: run.harness,
        last_seq: run.last_seq,
      })
      .collect()
  }

  async fn probe(&mut self, probe: HarnessProbe, reply: ProbeReply) {
    let Some(dir) = self.current().await else {
      let _delivered = reply.send(Err(ProbeError::SidecarDown));
      return;
    };
    self
      .probes
      .insert(probe.request_id.clone(), (dir.clone(), reply));
    self.write(&dir, &HostMessage::HarnessProbe(probe)).await;
  }

  async fn forward(&mut self, run_id: &str, message: &HostMessage) {
    let Some(run) = self.runs.get(run_id) else {
      tracing::warn!(target: LOG_TARGET, "a command named a run no holder holds");
      return;
    };
    let dir = run.holder.clone();
    self.write(&dir, message).await;
  }

  async fn ack(&mut self, ack: Ack) {
    let Some(run) = self.runs.get(&ack.run_id) else {
      return;
    };
    let dir = run.holder.clone();
    if run.finished.is_some_and(|last| ack.seq >= last) {
      self.runs.remove(&ack.run_id);
    }
    self.write(&dir, &HostMessage::Ack(ack)).await;
  }

  /// Write to a holder. A failed write needs no handling here: the reader
  /// sees the same connection close and reports it as an event.
  async fn write(&mut self, dir: &Path, message: &HostMessage) {
    if let Some(link) = self.links.get_mut(dir) {
      let _written = write_message(&mut link.writer, message).await;
    }
  }

  async fn event(&mut self, Event { dir, link, event }: Event) {
    if self.links.get(&dir).map(|current| current.id) != Some(link) {
      // From a connection this supervisor already replaced.
      return;
    }
    match event {
      LinkEvent::Message(message) => self.dispatch(message).await,
      LinkEvent::Broken(error) => {
        tracing::error!(target: LOG_TARGET, ?error, "harness holder broke the protocol");
        self.links.remove(&dir);
        self.fail_holder(&dir);
      }
      LinkEvent::Closed => self.lost(&dir, link).await,
    }
  }

  /// The connection dropped: reconnect and resume, or fail the holder's
  /// runs when nothing listens any more.
  async fn lost(&mut self, dir: &Path, link: u64) {
    if self.links.get(dir).map(|held| held.id) != Some(link) {
      return;
    }
    let Some(previous) = self.links.remove(dir) else {
      return;
    };
    let role = previous.role;
    drop(previous);
    self.fail_probes(dir);
    for attempt in 0..RECONNECT_ATTEMPTS {
      match self.open(dir).await {
        Ok(opened) => {
          tracing::info!(target: LOG_TARGET, "reconnected to the harness holder");
          self.attach(dir.to_path_buf(), opened, role);
          if role == LinkRole::Draining {
            self.write(dir, &HostMessage::Drain).await;
          }
          return;
        }
        Err(OpenError::Gone | OpenError::Incompatible) => break,
        Err(OpenError::Failed) => {
          tokio::time::sleep(self.settings.backoff.delay(attempt)).await;
        }
      }
    }
    tracing::warn!(target: LOG_TARGET, "harness holder is gone; its runs failed");
    self.fail_holder(dir);
    if role == LinkRole::Draining {
      remove_holder_dir(dir);
    }
  }

  async fn dispatch(&mut self, message: SidecarMessage) {
    match message {
      SidecarMessage::Hello(_) => {
        tracing::warn!(target: LOG_TARGET, "harness holder repeated its hello");
      }
      SidecarMessage::HarnessProbed(probed) => {
        if let Some((_dir, reply)) = self.probes.remove(&probed.request_id) {
          let _delivered = reply.send(Ok(probed.outcome));
        }
      }
      SidecarMessage::RunEvent(event) => {
        self
          .deliver(
            &event.run_id,
            event.seq,
            SidecarRunOutput::Event(event.chunk.0),
          )
          .await;
      }
      SidecarMessage::RunApprovalRequest(request) => {
        self
          .deliver(
            &request.run_id,
            request.seq,
            SidecarRunOutput::ApprovalRequest {
              request_id: request.request_id,
              kind: request.kind,
              summary: request.summary,
            },
          )
          .await;
      }
      SidecarMessage::RunFinished(finished) => {
        self
          .deliver(
            &finished.run_id,
            finished.seq,
            SidecarRunOutput::Finished {
              outcome: finished.outcome,
              harness_session_id: finished.harness_session_id,
            },
          )
          .await;
      }
      SidecarMessage::Rejected(rejected) => {
        tracing::warn!(
          target: LOG_TARGET,
          reason = rejected.reason.wire_name(),
          message_type = rejected.message_type.as_deref().unwrap_or(""),
          "harness holder rejected a message"
        );
        // A run the holder would not take, or no longer holds.
        let refused_run = matches!(
          rejected.message_type.as_deref(),
          Some("run.start" | "resume" | "hello")
        ) && matches!(
          rejected.reason,
          Rejection::Draining
            | Rejection::AtCapacity
            | Rejection::DuplicateRun
            | Rejection::UnknownRun
        );
        if let (true, Some(run_id)) = (refused_run, rejected.run_id) {
          self.fail_run(&run_id);
        }
      }
    }
  }

  /// Hand one numbered output to the run's channel, exactly once and in
  /// order. A gap means the holder lost messages: the run fails here.
  async fn deliver(&mut self, run_id: &str, seq: NonZeroU32, output: SidecarRunOutput) {
    let Some(run) = self.runs.get_mut(run_id) else {
      return;
    };
    run.last_seq = run.last_seq.max(seq.get());
    let last = matches!(output, SidecarRunOutput::Finished { .. });
    if last {
      run.finished = Some(seq);
    }
    let Some(claim) = run.claim.as_mut() else {
      return;
    };
    if claim.outputs.is_none() || seq.get() <= claim.delivered {
      return;
    }
    if seq.get() != claim.delivered.saturating_add(1) {
      tracing::error!(target: LOG_TARGET, "harness holder skipped messages of a run");
      if let Some(outputs) = claim.outputs.take() {
        finish_failed(outputs);
      }
      return;
    }
    claim.delivered = seq.get();
    let outputs = if last {
      claim.outputs.take()
    } else {
      claim.outputs.clone()
    };
    if let Some(outputs) = outputs {
      // A dropped receiver means nobody waits for the run any more.
      let _delivered = outputs.send(output).await;
    }
  }

  fn fail_run(&mut self, run_id: &str) {
    let Some(run) = self.runs.remove(run_id) else {
      return;
    };
    if let Some(outputs) = run.claim.and_then(|claim| claim.outputs) {
      finish_failed(outputs);
    }
  }

  /// Every run and probe a gone holder held finishes as failed.
  fn fail_holder(&mut self, dir: &Path) {
    let held: Vec<String> = self
      .runs
      .iter()
      .filter(|(_run_id, run)| run.holder == dir)
      .map(|(run_id, _run)| run_id.clone())
      .collect();
    for run_id in held {
      self.fail_run(&run_id);
    }
    self.fail_probes(dir);
  }

  fn fail_probes(&mut self, dir: &Path) {
    let waiting: Vec<String> = self
      .probes
      .iter()
      .filter(|(_request_id, (holder, _reply))| holder == dir)
      .map(|(request_id, _probe)| request_id.clone())
      .collect();
    for request_id in waiting {
      if let Some((_dir, reply)) = self.probes.remove(&request_id) {
        let _delivered = reply.send(Err(ProbeError::SidecarDown));
      }
    }
  }

  /// Ask every holder to stop its runs and exit, relay what they send until
  /// each connection closes or the grace runs out, then fail the rest.
  async fn stop_holders(&mut self) {
    // Later commands are refused as stopped, not queued.
    self.controls.close();
    let dirs: Vec<PathBuf> = self.links.keys().cloned().collect();
    for dir in &dirs {
      self.write(dir, &HostMessage::Shutdown).await;
    }
    let deadline = tokio::time::Instant::now() + self.settings.shutdown_grace;
    while !self.links.is_empty() {
      let Ok(Some(Event { dir, link, event })) =
        tokio::time::timeout_at(deadline, self.events.recv()).await
      else {
        break;
      };
      if self.links.get(&dir).map(|current| current.id) != Some(link) {
        continue;
      }
      match event {
        LinkEvent::Message(message) => self.dispatch(message).await,
        LinkEvent::Broken(_) | LinkEvent::Closed => {
          self.links.remove(&dir);
        }
      }
    }
    self.links.clear();
    for dir in dirs {
      self.fail_holder(&dir);
    }
  }
}

/// A run's channel ends with `failed`; the send waits for room on its own.
fn finish_failed(outputs: mpsc::Sender<SidecarRunOutput>) {
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

fn remove_holder_dir(dir: &Path) {
  if let Err(error) = std::fs::remove_dir_all(dir) {
    tracing::warn!(target: LOG_TARGET, kind = ?error.kind(), "an old harness holder folder was not removed");
  }
}

async fn write_message<W: AsyncWrite + Unpin>(
  writer: &mut W,
  message: &HostMessage,
) -> Result<(), ()> {
  let mut line = serde_json::to_vec(message).map_err(|_unserializable| ())?;
  if line.len() > MAX_LINE_BYTES {
    tracing::error!(target: LOG_TARGET, "a host message exceeded the line limit");
    return Err(());
  }
  line.push(b'\n');
  let written = writer.write_all(&line).await;
  let flushed = writer.flush().await;
  written.and(flushed).map_err(|error| {
    tracing::warn!(target: LOG_TARGET, kind = ?error.kind(), "harness holder connection closed");
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
  mut reader: BufReader<R>,
  dir: PathBuf,
  link: u64,
  events: mpsc::Sender<Event>,
) {
  let send = |event| {
    events.send(Event {
      dir: dir.clone(),
      link,
      event,
    })
  };
  while let Some(line) = read_line(&mut reader, MAX_LINE_BYTES).await {
    let parsed = line.and_then(|line| {
      serde_json::from_slice::<SidecarMessage>(&line)
        .map_err(|error| LineError::Invalid(error.classify()))
    });
    let event = match parsed {
      Ok(message) => LinkEvent::Message(message),
      Err(error) => {
        let _delivered = send(LinkEvent::Broken(error)).await;
        return;
      }
    };
    if send(event).await.is_err() {
      return;
    }
  }
  let _delivered = send(LinkEvent::Closed).await;
}
