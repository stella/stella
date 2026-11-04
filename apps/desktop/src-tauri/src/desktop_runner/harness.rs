//! Where runs execute. The runner owns the socket, the journal and every
//! position in a run's stream; a harness host only runs what it accepted and
//! reports what it produces through the run's [`RunSink`].

use std::num::NonZeroU32;

use tokio::sync::{mpsc, oneshot};

use crate::runner_protocol::{
  ApprovalKind, Harness, HarnessReport, JsonObject, MissingHarness, RejectReason,
  RunApproval, RunInput, RunOutcome, RunStart, RunTokenRefresh,
};

/// Runs the commands the API sends. Every call returns promptly; a host does
/// its work on its own tasks and reports through the sink it was handed.
///
/// The runner calls each method at most once per command: duplicates are
/// dropped before they reach the host, also across restarts.
pub(crate) trait HarnessHost: Send + Sync + 'static {
  /// The version `hello` reports for the process that runs harnesses.
  fn sidecar_version(&self) -> String;
  /// Take the run or refuse it. After `Ok`, everything the run produces goes
  /// through `sink`, ending with [`RunOutput::Finished`].
  fn start(&self, start: RunStart, sink: RunSink) -> Result<(), RejectReason>;
  fn input(&self, input: RunInput);
  fn approval(&self, approval: RunApproval);
  fn interrupt(&self, run_id: &str);
  fn cancel(&self, run_id: &str);
  /// A newer MCP token for the run; an older one never follows it.
  fn token(&self, refresh: RunTokenRefresh);
}

/// What each harness can do on this computer, for `hello`.
pub(crate) trait HarnessReports: Send + Sync + 'static {
  fn reports(&self) -> Vec<HarnessReport>;
}

/// One thing a run produced, in the order it produced them.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
  not(test),
  allow(
    dead_code,
    reason = "a harness host emits these; the only host so far accepts no run"
  )
)]
pub(crate) enum RunOutput {
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
pub(crate) enum EmitError {
  /// The message would exceed the frame limit; nothing was recorded.
  TooLarge,
  /// The run finished or is not one the runner holds.
  RunClosed,
  /// The journal could not record it.
  Storage,
  /// The runner stopped.
  Stopped,
}

pub(crate) struct SinkRequest {
  pub(crate) run_id: String,
  pub(crate) output: RunOutput,
  pub(crate) reply: oneshot::Sender<Result<NonZeroU32, EmitError>>,
}

/// A run's way back to the API. Each output gets the next position in the
/// run's stream once the journal holds it.
#[derive(Clone)]
pub(crate) struct RunSink {
  run_id: String,
  requests: mpsc::Sender<SinkRequest>,
}

impl RunSink {
  pub(crate) fn new(run_id: String, requests: mpsc::Sender<SinkRequest>) -> Self {
    Self { run_id, requests }
  }

  #[cfg_attr(
    not(test),
    allow(
      dead_code,
      reason = "a harness host emits through this; the only host so far accepts no run"
    )
  )]
  pub(crate) async fn emit(&self, output: RunOutput) -> Result<NonZeroU32, EmitError> {
    let (reply, recorded) = oneshot::channel();
    self
      .requests
      .send(SinkRequest {
        run_id: self.run_id.clone(),
        output,
        reply,
      })
      .await
      .map_err(|_runner_gone| EmitError::Stopped)?;
    recorded.await.map_err(|_runner_gone| EmitError::Stopped)?
  }
}

/// The host until a harness sidecar is installed: every run is refused as
/// having no harness.
pub(crate) struct UnavailableHarnessHost {
  app_version: String,
}

impl UnavailableHarnessHost {
  pub(crate) fn new(app_version: String) -> Self {
    Self { app_version }
  }
}

impl HarnessHost for UnavailableHarnessHost {
  fn sidecar_version(&self) -> String {
    self.app_version.clone()
  }

  fn start(&self, _start: RunStart, _sink: RunSink) -> Result<(), RejectReason> {
    Err(RejectReason::HarnessNotInstalled)
  }

  // Nothing is ever accepted, so the runner never forwards these.
  fn input(&self, _input: RunInput) {}
  fn approval(&self, _approval: RunApproval) {}
  fn interrupt(&self, _run_id: &str) {}
  fn cancel(&self, _run_id: &str) {}
  fn token(&self, _refresh: RunTokenRefresh) {}
}

/// Reports every harness as not installed until the installer reports them.
pub(crate) struct NoHarnessReports;

impl HarnessReports for NoHarnessReports {
  fn reports(&self) -> Vec<HarnessReport> {
    Harness::ALL
      .iter()
      .map(|&id| HarnessReport::NotInstalled(MissingHarness { id }))
      .collect()
  }
}
