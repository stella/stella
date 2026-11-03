//! Where runs execute. The runner owns the socket, the journal and every
//! position in a run's stream; a harness host only runs what it accepted and
//! reports what it produces through the run's [`RunSink`].

use std::num::NonZeroU32;
use std::sync::Arc;

use tokio::sync::watch;

use super::journal::{Recorded, SharedJournal};
use crate::runner_protocol::{
  ApprovalKind, Harness, HarnessReport, JsonObject, MissingHarness, RejectReason,
  RunAnswer, RunApproval, RunInput, RunOutcome, RunStart, RunTokenRefresh,
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
  /// Answers to a blocking question the run asked.
  fn answer(&self, answer: RunAnswer);
  fn interrupt(&self, run_id: &str);
  fn cancel(&self, run_id: &str);
  /// A newer MCP token for the run; an older one never follows it.
  fn token(&self, refresh: RunTokenRefresh);
  /// The runner is about to connect for the account whose API is at
  /// `api_base_url`; called before every connection attempt.
  fn connecting(&self, _api_base_url: &str) {}
  /// Every run the runner's journal holds as accepted and not finished, each
  /// with a sink into that journal, after [`Self::connecting`]. A host picks
  /// up the runs it does not run yet (after an app restart, say) from each
  /// one's journaled position on.
  fn reattach(&self, _runs: Vec<JournaledRun>) {}
}

/// A run the journal holds, for [`HarnessHost::reattach`].
pub(crate) struct JournaledRun {
  pub(crate) run_id: String,
  /// The last position of the host's own source the journal holds an
  /// output for (see [`RunSink::relay_all`]); 0 before the first.
  pub(crate) source_seq: u32,
  pub(crate) sink: RunSink,
}

/// What each harness can do on this computer, for `hello`.
pub(crate) trait HarnessReports: Send + Sync + 'static {
  fn reports(&self) -> Vec<HarnessReport>;
  /// Changes whenever a report may have changed; the runner then sends the
  /// changed ones as `harness.status`. `None` when reports never change.
  fn changes(&self) -> Option<watch::Receiver<u64>> {
    None
  }
}

/// One thing a run produced, in the order it produced them.
#[derive(Debug, Clone, PartialEq)]
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
  /// The run reached the API's per-run storage limit; only its final
  /// message is still taken.
  Full,
}

/// A run's way back to the API. Each output gets the next position in the
/// run's stream once the journal holds it, whether or not a runner socket is
/// up: the socket sends what the journal holds.
#[derive(Clone)]
pub(crate) struct RunSink {
  run_id: String,
  journal: Arc<SharedJournal>,
}

impl RunSink {
  pub(crate) fn new(run_id: String, journal: Arc<SharedJournal>) -> Self {
    Self { run_id, journal }
  }

  /// Journal an output the host made up itself.
  pub(crate) fn emit(&self, output: RunOutput) -> Result<NonZeroU32, EmitError> {
    self.journal.record_output(&self.run_id, output, None)
  }

  /// Journal outputs in order in one write, each with the position its
  /// source numbered it (the harness holder's own `seq`), if any. The
  /// journal keeps the last such position with the outputs, so a host that
  /// comes back after a restart resumes its source after exactly what the
  /// journal holds. `Err` only when the write failed and nothing was
  /// journaled.
  pub(crate) fn relay_all(
    &self,
    outputs: Vec<(RunOutput, Option<NonZeroU32>)>,
  ) -> Result<Recorded, EmitError> {
    self.journal.record_outputs(&self.run_id, outputs)
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
  fn answer(&self, _answer: RunAnswer) {}
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
