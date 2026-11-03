//! What the runner must remember across sockets and restarts: each run's
//! answer to `run.start`, the commands already handed to the harness host,
//! and the run messages the API has not acknowledged yet.
//!
//! Each run is one encrypted file (`local_store::EncryptedJsonFile`, bound to
//! its run id), written before the runner acts on what it records. A run is
//! forgotten once it finished and the API acknowledged its last message, or
//! when the API no longer holds it.

use std::{
  collections::{BTreeMap, BTreeSet},
  fs,
  num::NonZeroU32,
  path::PathBuf,
  sync::{Mutex, MutexGuard, PoisonError},
};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use super::client::encode;
use super::harness::{EmitError, RunOutput};
use crate::local_store::EncryptedJsonFile;
use crate::runner_protocol::{
  DesktopMessage, MAX_MESSAGE_BYTES_PER_RUN, MAX_MESSAGES_PER_RUN, RejectReason,
  RunApprovalRequest, RunEvent, RunFinished,
};

const RECORD_LABEL: &str = "desktop runner journal";
const RECORD_EXTENSION: &str = "json";
/// A refused run is remembered this long, so a `run.start` the API resends
/// after a lost `run.rejected` gets the same answer.
const REFUSED_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Decision {
  Accepted,
  Rejected { reason: RejectReason },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunRecord {
  pub(crate) run_id: String,
  pub(crate) decision: Decision,
  pub(crate) decided_at_ms: i64,
  /// `run.input` ids already handed to the host.
  pub(crate) inputs: BTreeSet<String>,
  /// `run.approval` request ids already handed to the host.
  pub(crate) approvals: BTreeSet<String>,
  /// `run.answer` request ids already handed to the host; never the answers.
  pub(crate) answers: BTreeSet<String>,
  pub(crate) interrupted: bool,
  pub(crate) cancelled: bool,
  /// The last position this desktop produced; 0 before the first.
  pub(crate) last_seq: u32,
  /// The last position of the harness host's own source (the holder's
  /// `seq`) whose output this record holds; 0 before the first. It is not
  /// `last_seq`: the host also emits outputs no source numbered.
  pub(crate) source_seq: u32,
  /// UTF-8 bytes of every message this desktop produced for the run, the
  /// measure of the API's per-run storage limit.
  pub(crate) produced_bytes: u64,
  /// The last position the API acknowledged.
  pub(crate) ack_seq: u32,
  pub(crate) finished: bool,
  /// Every message after `ack_seq`, in position order.
  pub(crate) outbox: Vec<DesktopMessage>,
}

impl RunRecord {
  pub(crate) fn new(run_id: String, decision: Decision, now_ms: i64) -> Self {
    Self {
      run_id,
      decision,
      decided_at_ms: now_ms,
      inputs: BTreeSet::new(),
      approvals: BTreeSet::new(),
      answers: BTreeSet::new(),
      interrupted: false,
      cancelled: false,
      last_seq: 0,
      source_seq: 0,
      produced_bytes: 0,
      ack_seq: 0,
      finished: false,
      outbox: Vec::new(),
    }
  }

  /// A run whose messages the API still has to receive, or that is still
  /// producing them: `hello` lists it.
  pub(crate) fn is_held(&self) -> bool {
    self.decision == Decision::Accepted && !self.is_done()
  }

  /// Finished, and the API stored every message.
  pub(crate) fn is_done(&self) -> bool {
    self.finished && self.ack_seq >= self.last_seq
  }

  /// Drop every message the API has stored through `seq`.
  pub(crate) fn acknowledge(&mut self, seq: u32) {
    self.ack_seq = self.ack_seq.max(seq.min(self.last_seq));
    let acked = self.ack_seq;
    self
      .outbox
      .retain(|message| seq_of(message).is_none_or(|seq| seq > acked));
  }
}

/// The position a sequenced run message carries.
pub(crate) fn seq_of(message: &DesktopMessage) -> Option<u32> {
  match message {
    DesktopMessage::RunEvent(event) => Some(event.seq.get()),
    DesktopMessage::RunApprovalRequest(request) => Some(request.seq.get()),
    DesktopMessage::RunFinished(finished) => Some(finished.seq.get()),
    DesktopMessage::Hello(_)
    | DesktopMessage::HarnessStatus(_)
    | DesktopMessage::RunAccepted(_)
    | DesktopMessage::RunRejected(_) => None,
  }
}

/// Where records live: encrypted files, or memory only when no key can be
/// used (debug builds, an unavailable keychain).
pub(crate) enum JournalBacking {
  Memory,
  Encrypted { directory: PathBuf, key: [u8; 32] },
}

pub(crate) struct Journal {
  backing: JournalBacking,
  runs: BTreeMap<String, RunRecord>,
}

impl Journal {
  /// Load every record. A record that cannot be read stays on disk untouched
  /// and is left out, so its run is dropped by the API rather than lost here.
  pub(crate) fn open(backing: JournalBacking, now_ms: i64) -> Self {
    let mut journal = Self {
      backing,
      runs: BTreeMap::new(),
    };
    for record in journal.load_all() {
      journal.runs.insert(record.run_id.clone(), record);
    }
    let stale: Vec<String> = journal
      .runs
      .values()
      .filter(|record| {
        matches!(record.decision, Decision::Rejected { .. })
          && now_ms.saturating_sub(record.decided_at_ms) > REFUSED_RETENTION_MS
      })
      .map(|record| record.run_id.clone())
      .collect();
    for run_id in stale {
      if let Err(error) = journal.remove(&run_id) {
        tracing::warn!(error = %error, "desktop runner journal cleanup failed");
      }
    }
    journal
  }

  fn load_all(&self) -> Vec<RunRecord> {
    let JournalBacking::Encrypted { directory, key } = &self.backing else {
      return Vec::new();
    };
    let entries = match fs::read_dir(directory) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
      Err(error) => {
        tracing::warn!(kind = ?error.kind(), "desktop runner journal is unavailable");
        return Vec::new();
      }
    };
    entries
      .filter_map(Result::ok)
      .filter_map(|entry| {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str())
          != Some(RECORD_EXTENSION)
        {
          return None;
        }
        let run_id = path.file_stem()?.to_str()?.to_owned();
        Uuid::parse_str(&run_id).ok()?;
        match record_file(directory, *key, &run_id).load::<RunRecord>() {
          Ok(Some(record)) if record.run_id == run_id => Some(record),
          Ok(_) => None,
          Err(error) => {
            tracing::warn!(error = %error, "desktop runner journal record is unreadable");
            None
          }
        }
      })
      .collect()
  }

  pub(crate) fn get(&self, run_id: &str) -> Option<&RunRecord> {
    self.runs.get(run_id)
  }

  pub(crate) fn records(&self) -> impl Iterator<Item = &RunRecord> {
    self.runs.values()
  }

  /// Write `record`, then hold it. On failure nothing changes.
  pub(crate) fn put(&mut self, record: RunRecord) -> Result<(), String> {
    if let JournalBacking::Encrypted { directory, key } = &self.backing {
      checked_run_id(&record.run_id)?;
      record_file(directory, *key, &record.run_id).persist(&record)?;
    }
    self.runs.insert(record.run_id.clone(), record);
    Ok(())
  }

  pub(crate) fn remove(&mut self, run_id: &str) -> Result<(), String> {
    if let JournalBacking::Encrypted { directory, .. } = &self.backing {
      checked_run_id(run_id)?;
      match fs::remove_file(record_path(directory, run_id)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("{RECORD_LABEL} removal failed: {error}")),
      }
    }
    self.runs.remove(run_id);
    Ok(())
  }
}

/// Run ids name files, so only a UUID may reach a path.
fn checked_run_id(run_id: &str) -> Result<(), String> {
  Uuid::parse_str(run_id)
    .map(|_uuid| ())
    .map_err(|_not_uuid| format!("{RECORD_LABEL} refused a run id that is not a UUID"))
}

fn record_path(directory: &std::path::Path, run_id: &str) -> PathBuf {
  directory.join(format!("{run_id}.{RECORD_EXTENSION}"))
}

fn record_file(
  directory: &std::path::Path,
  key: [u8; 32],
  run_id: &str,
) -> EncryptedJsonFile {
  EncryptedJsonFile::new(key, record_path(directory, run_id), RECORD_LABEL)
    .with_associated_data(format!("desktop-runner-run:{run_id}"))
}

/// What [`SharedJournal::update`] does with the changed record.
pub(crate) enum Change {
  Unchanged,
  Store,
  Forget,
}

struct SharedState {
  journal: Option<(String, Journal)>,
  /// Where newly journaled messages go to be sent while a socket is up.
  live: Option<mpsc::UnboundedSender<DesktopMessage>>,
}

/// The journal of the account the runner connects for, shared by the runner
/// and every [`RunSink`](super::harness::RunSink). A run's outputs are journaled the moment the host
/// relays them, whether or not a runner socket is up or a runner runs at
/// all; a socket only sends what the journal holds. It lives as long as the
/// app, so a runner that stops and starts again finds every output.
pub(crate) struct SharedJournal(Mutex<SharedState>);

impl Default for SharedJournal {
  fn default() -> Self {
    Self(Mutex::new(SharedState {
      journal: None,
      live: None,
    }))
  }
}

impl SharedJournal {
  fn state(&self) -> MutexGuard<'_, SharedState> {
    self.0.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// Whether the open journal is the account's.
  pub(crate) fn holds_namespace(&self, namespace: &str) -> bool {
    self
      .state()
      .journal
      .as_ref()
      .is_some_and(|(current, _)| current == namespace)
  }

  pub(crate) fn replace(&self, namespace: String, journal: Journal) {
    self.state().journal = Some((namespace, journal));
  }

  /// The channel newly journaled messages are sent on, until replaced.
  pub(crate) fn set_live(&self, live: mpsc::UnboundedSender<DesktopMessage>) {
    self.state().live = Some(live);
  }

  pub(crate) fn get(&self, run_id: &str) -> Option<RunRecord> {
    self
      .state()
      .journal
      .as_ref()
      .and_then(|(_, journal)| journal.get(run_id).cloned())
  }

  pub(crate) fn records(&self) -> Vec<RunRecord> {
    self
      .state()
      .journal
      .as_ref()
      .map(|(_, journal)| journal.records().cloned().collect())
      .unwrap_or_default()
  }

  /// Write `record`, then hold it.
  pub(crate) fn put(&self, record: RunRecord) -> Result<(), String> {
    match self.state().journal.as_mut() {
      Some((_, journal)) => journal.put(record),
      None => Err(format!("{RECORD_LABEL} is not open")),
    }
  }

  pub(crate) fn remove(&self, run_id: &str) -> Result<(), String> {
    match self.state().journal.as_mut() {
      Some((_, journal)) => journal.remove(run_id),
      None => Ok(()),
    }
  }

  /// Change one record in place, so no output a host journals meanwhile is
  /// lost; `Ok(None)` when the journal holds no such record.
  pub(crate) fn update<R>(
    &self,
    run_id: &str,
    change: impl FnOnce(&mut RunRecord) -> (Change, R),
  ) -> Result<Option<R>, String> {
    let mut state = self.state();
    let Some((_, journal)) = state.journal.as_mut() else {
      return Ok(None);
    };
    let Some(mut record) = journal.get(run_id).cloned() else {
      return Ok(None);
    };
    let (write, result) = change(&mut record);
    match write {
      Change::Unchanged => {}
      Change::Store => journal.put(record)?,
      Change::Forget => journal.remove(run_id)?,
    }
    drop(state);
    Ok(Some(result))
  }

  /// Number and journal one output of a running run, then hand it to the
  /// live socket, if any; see [`Self::record_outputs`].
  pub(crate) fn record_output(
    &self,
    run_id: &str,
    output: RunOutput,
    source_seq: Option<NonZeroU32>,
  ) -> Result<NonZeroU32, EmitError> {
    let recorded = self.record_outputs(run_id, vec![(output, source_seq)])?;
    match recorded.outcomes.first() {
      Some(Ok(seq)) => Ok(*seq),
      Some(Err(error)) => Err(*error),
      None => Err(EmitError::RunClosed),
    }
  }

  /// Number and journal outputs of a running run in one write, then hand
  /// them to the live socket, if any. Each output's `source_seq` is
  /// journaled with it, also for one that is not taken, so a resumed source
  /// never sends it again. Once the run reached the API's per-run storage
  /// limit only its final message is taken; an output over the frame limit
  /// is not taken. Nothing is journaled when the write fails.
  pub(crate) fn record_outputs(
    &self,
    run_id: &str,
    outputs: Vec<(RunOutput, Option<NonZeroU32>)>,
  ) -> Result<Recorded, EmitError> {
    let mut state = self.state();
    let Some((_, journal)) = state.journal.as_mut() else {
      return Ok(Recorded::closed(outputs.len()));
    };
    let Some(mut record) = journal
      .get(run_id)
      .filter(|record| record.decision == Decision::Accepted && !record.finished)
      .cloned()
    else {
      return Ok(Recorded::closed(outputs.len()));
    };
    let mut outcomes = Vec::with_capacity(outputs.len());
    let mut taken = Vec::new();
    for (output, source_seq) in outputs {
      if let Some(source_seq) = source_seq {
        record.source_seq = record.source_seq.max(source_seq.get());
      }
      outcomes.push(take(&mut record, run_id, output).map(|(seq, message)| {
        taken.push(message);
        seq
      }));
    }
    journal.put(record).map_err(|error| {
      tracing::warn!(error = %error, "desktop runner journal write failed");
      EmitError::Storage
    })?;
    if let Some(live) = state.live.as_ref() {
      for message in taken {
        // A runner that is gone resends from the journal once it is back.
        let _unsent = live.send(message);
      }
    }
    // Held to here: the live channel sees positions in journal order.
    drop(state);
    Ok(Recorded { outcomes })
  }
}

/// What [`SharedJournal::record_outputs`] did with each output, in order.
pub(crate) struct Recorded {
  pub(crate) outcomes: Vec<Result<NonZeroU32, EmitError>>,
}

impl Recorded {
  fn closed(count: usize) -> Self {
    Self {
      outcomes: vec![Err(EmitError::RunClosed); count],
    }
  }
}

/// Append one output to `record`'s outbox, or say why it is not taken.
fn take(
  record: &mut RunRecord,
  run_id: &str,
  output: RunOutput,
) -> Result<(NonZeroU32, DesktopMessage), EmitError> {
  if record.finished {
    return Err(EmitError::RunClosed);
  }
  let seq = record
    .last_seq
    .checked_add(1)
    .and_then(NonZeroU32::new)
    .ok_or(EmitError::RunClosed)?;
  let finished = matches!(output, RunOutput::Finished { .. });
  let message = numbered(run_id.to_owned(), seq, output);
  let bytes = encode(&message).ok_or(EmitError::TooLarge)?.len();
  let bytes = u64::try_from(bytes).unwrap_or(u64::MAX);
  let produced = record.produced_bytes.saturating_add(bytes);
  if !finished
    && (seq.get() > MAX_MESSAGES_PER_RUN || produced > MAX_MESSAGE_BYTES_PER_RUN)
  {
    return Err(EmitError::Full);
  }
  record.outbox.push(message.clone());
  record.last_seq = seq.get();
  record.produced_bytes = produced;
  record.finished = finished;
  Ok((seq, message))
}

fn numbered(run_id: String, seq: NonZeroU32, output: RunOutput) -> DesktopMessage {
  match output {
    RunOutput::Event(chunk) => {
      DesktopMessage::RunEvent(RunEvent { run_id, seq, chunk })
    }
    RunOutput::ApprovalRequest {
      request_id,
      kind,
      summary,
    } => DesktopMessage::RunApprovalRequest(RunApprovalRequest {
      run_id,
      seq,
      request_id,
      kind,
      summary,
    }),
    RunOutput::Finished {
      outcome,
      harness_session_id,
    } => DesktopMessage::RunFinished(RunFinished {
      run_id,
      seq,
      outcome,
      harness_session_id,
    }),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::runner_protocol::RunEvent;
  use std::num::NonZeroU32;

  const RUN: &str = "0192f3a0-6b1c-7d2e-8f30-000000000001";

  fn event(seq: u32) -> DesktopMessage {
    DesktopMessage::RunEvent(RunEvent {
      run_id: RUN.to_owned(),
      seq: NonZeroU32::new(seq).unwrap(),
      chunk: serde_json::from_value(serde_json::json!({"type": "RUN_STARTED"}))
        .unwrap(),
    })
  }

  fn encrypted(directory: &std::path::Path) -> JournalBacking {
    JournalBacking::Encrypted {
      directory: directory.to_path_buf(),
      key: [7; 32],
    }
  }

  fn temp_dir() -> PathBuf {
    std::env::temp_dir().join(format!("stella-runner-journal-{}", Uuid::new_v4()))
  }

  #[test]
  fn a_record_survives_a_reopen_and_acknowledging_trims_its_outbox() {
    let directory = temp_dir();
    let mut journal = Journal::open(encrypted(&directory), 0);
    let mut record = RunRecord::new(RUN.to_owned(), Decision::Accepted, 0);
    record.inputs.insert("input-1".to_owned());
    for seq in 1..=3 {
      record.outbox.push(event(seq));
      record.last_seq = seq;
    }
    journal.put(record.clone()).unwrap();

    let mut reopened = Journal::open(encrypted(&directory), 0);
    assert_eq!(reopened.get(RUN), Some(&record));
    let mut held = reopened.get(RUN).unwrap().clone();
    held.acknowledge(2);
    assert_eq!(held.outbox, vec![event(3)]);
    // An ack beyond what was produced never claims more than was sent.
    held.acknowledge(9);
    assert_eq!(held.ack_seq, 3);
    assert!(held.outbox.is_empty());
    reopened.put(held).unwrap();
    reopened.remove(RUN).unwrap();
    assert!(Journal::open(encrypted(&directory), 0).get(RUN).is_none());
    fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn a_record_under_another_name_or_key_is_not_read() {
    let directory = temp_dir();
    let mut journal = Journal::open(encrypted(&directory), 0);
    journal
      .put(RunRecord::new(RUN.to_owned(), Decision::Accepted, 0))
      .unwrap();
    let other = "0192f3a0-6b1c-7d2e-8f30-000000000002";
    crate::local_store::rename_private(
      &record_path(&directory, RUN),
      &record_path(&directory, other),
    )
    .unwrap();
    assert_eq!(Journal::open(encrypted(&directory), 0).records().count(), 0);
    crate::local_store::rename_private(
      &record_path(&directory, other),
      &record_path(&directory, RUN),
    )
    .unwrap();
    let wrong_key = JournalBacking::Encrypted {
      directory: directory.clone(),
      key: [8; 32],
    };
    assert_eq!(Journal::open(wrong_key, 0).records().count(), 0);
    // Unreadable records are left in place, not deleted.
    assert!(record_path(&directory, RUN).exists());
    fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn a_run_id_that_is_not_a_uuid_never_reaches_a_path() {
    let directory = temp_dir();
    let mut journal = Journal::open(encrypted(&directory), 0);
    let escape = RunRecord::new("../escape".to_owned(), Decision::Accepted, 0);
    assert!(journal.put(escape).is_err());
    assert!(journal.get("../escape").is_none());
    assert!(!directory.join("../escape.json").exists());
    let _cleanup = fs::remove_dir_all(directory);
  }

  #[test]
  fn refused_runs_expire_and_accepted_runs_stay() {
    let directory = temp_dir();
    let mut journal = Journal::open(encrypted(&directory), 0);
    let refused = "0192f3a0-6b1c-7d2e-8f30-000000000003";
    journal
      .put(RunRecord::new(
        refused.to_owned(),
        Decision::Rejected {
          reason: RejectReason::HarnessNotInstalled,
        },
        0,
      ))
      .unwrap();
    journal
      .put(RunRecord::new(RUN.to_owned(), Decision::Accepted, 0))
      .unwrap();
    let kept = Journal::open(encrypted(&directory), REFUSED_RETENTION_MS);
    assert!(kept.get(refused).is_some());
    let expired = Journal::open(encrypted(&directory), REFUSED_RETENTION_MS + 1);
    assert!(expired.get(refused).is_none());
    assert!(expired.get(RUN).is_some());
    assert!(!record_path(&directory, refused).exists());
    fs::remove_dir_all(directory).unwrap();
  }
}
