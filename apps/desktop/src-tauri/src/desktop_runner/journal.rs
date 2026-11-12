//! What the runner must remember across sockets and restarts: each run's
//! answer to `run.start`, the commands already handed to the harness host,
//! and the run messages the API has not acknowledged yet.
//!
//! Each run is a directory named by its run id that holds two encrypted
//! files, both bound to the run id:
//!
//! - `head.json` (`local_store::EncryptedJsonFile`): the decision, the
//!   commands handed to the host, the acknowledged position and the log
//!   generation in use. It is replaced whole, and only when a command, the
//!   decision or the generation changes.
//! - `log-<generation>.jsonl` (`local_store::EncryptedJsonLog`): one entry
//!   per write, bound to its generation and position. An entry holds the
//!   messages one write took with the run's counters after it, or a position
//!   the API acknowledged. A write appends only its own entry, so it costs
//!   what is new, not what the run still holds.
//!
//! Once the log holds at least as many acknowledged message bytes as
//! unacknowledged ones, the unacknowledged messages move to the next
//! generation, written whole before the head names it. An entry a crash cut
//! short is left out, and the log moves to the next generation before
//! anything is appended. Every write reaches the disk before the runner acts
//! on what it records. A run is forgotten once it finished and the API
//! acknowledged its last message, or when the API no longer holds it.

use std::{
  collections::{BTreeMap, BTreeSet, VecDeque},
  fs,
  num::NonZeroU32,
  path::{Path, PathBuf},
  sync::{Mutex, MutexGuard, PoisonError},
};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use super::client::encode;
use super::harness::{EmitError, RunOutput};
use crate::local_store::{self, EncryptedJsonFile, EncryptedJsonLog, LogContents};
use crate::runner_protocol::{
  DesktopMessage, MAX_MESSAGE_BYTES_PER_RUN, MAX_MESSAGES_PER_RUN, RejectReason,
  RunApprovalRequest, RunBackground, RunEvent, RunFinished,
};

const RECORD_LABEL: &str = "desktop runner journal";
const HEAD_FILE: &str = "head.json";
const LOG_PREFIX: &str = "log-";
const LOG_EXTENSION: &str = "jsonl";
/// Acknowledged message bytes a log may keep however few are unacknowledged,
/// so a run the API keeps up with is not compacted on every acknowledgement.
const COMPACT_MIN_BYTES: u64 = 256 * 1024;
/// A refused run is remembered this long, so a `run.start` the API resends
/// after a lost `run.rejected` gets the same answer.
const REFUSED_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Decision {
  Accepted,
  Rejected { reason: RejectReason },
}

/// Where a run's stream stands.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tail {
  /// The last position this desktop produced; 0 before the first.
  last_seq: u32,
  /// The last position of the harness host's own source (the holder's
  /// `seq`) whose output the journal holds; 0 before the first. It is not
  /// `last_seq`: the host also emits outputs no source numbered.
  source_seq: u32,
  /// UTF-8 bytes of every message this desktop produced for the run, the
  /// measure of the API's per-run storage limit.
  produced_bytes: u64,
  finished: bool,
}

/// A message the API has not acknowledged, with its encoded size.
#[derive(Debug, Clone, PartialEq)]
struct Outgoing {
  seq: u32,
  bytes: u64,
  message: DesktopMessage,
}

/// One run as the journal holds it. Its stream changes only through
/// [`SharedJournal::record_outputs`] and [`Self::acknowledge`]; the
/// decision and the commands through [`SharedJournal::update`].
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RunRecord {
  run_id: String,
  pub(crate) decision: Decision,
  decided_at_ms: i64,
  /// `run.input` ids already handed to the host.
  pub(crate) inputs: BTreeSet<String>,
  /// `run.approval` request ids already handed to the host.
  pub(crate) approvals: BTreeSet<String>,
  /// `run.answer` request ids already handed to the host; never the answers.
  pub(crate) answers: BTreeSet<String>,
  pub(crate) interrupted: bool,
  pub(crate) cancelled: bool,
  /// The last position the API acknowledged.
  ack_seq: u32,
  tail: Tail,
  /// Every message after `ack_seq`, in position order. Acknowledged ones
  /// leave once the journal recorded the acknowledgement.
  outbox: VecDeque<Outgoing>,
  /// Encoded bytes of the messages in `outbox`.
  outbox_bytes: u64,
}

impl RunRecord {
  fn new(run_id: String, decision: Decision, now_ms: i64) -> Self {
    Self {
      run_id,
      decision,
      decided_at_ms: now_ms,
      inputs: BTreeSet::new(),
      approvals: BTreeSet::new(),
      answers: BTreeSet::new(),
      interrupted: false,
      cancelled: false,
      ack_seq: 0,
      tail: Tail::default(),
      outbox: VecDeque::new(),
      outbox_bytes: 0,
    }
  }

  pub(crate) fn run_id(&self) -> &str {
    &self.run_id
  }

  /// The last position this desktop produced; 0 before the first.
  pub(crate) fn last_seq(&self) -> u32 {
    self.tail.last_seq
  }

  /// The last position of the host's own source the journal holds.
  pub(crate) fn source_seq(&self) -> u32 {
    self.tail.source_seq
  }

  /// The run produced its final message.
  pub(crate) fn finished(&self) -> bool {
    self.tail.finished
  }

  /// Every message after the acknowledged position, in position order.
  pub(crate) fn outbox(&self) -> impl Iterator<Item = &DesktopMessage> {
    self.unacknowledged().map(|outgoing| &outgoing.message)
  }

  fn unacknowledged(&self) -> impl Iterator<Item = &Outgoing> {
    let acked = self.ack_seq;
    self
      .outbox
      .iter()
      .skip_while(move |outgoing| outgoing.seq <= acked)
  }

  /// A run whose messages the API still has to receive, or that is still
  /// producing them: `hello` lists it.
  pub(crate) fn is_held(&self) -> bool {
    self.decision == Decision::Accepted && !self.is_done()
  }

  /// Finished, and the API stored every message.
  pub(crate) fn is_done(&self) -> bool {
    self.tail.finished && self.ack_seq >= self.tail.last_seq
  }

  /// The API stored every message through `seq`. The journal drops them
  /// once it recorded that.
  pub(crate) fn acknowledge(&mut self, seq: u32) {
    self.ack_seq = self.ack_seq.max(seq.min(self.tail.last_seq));
  }

  fn push(&mut self, outgoing: Outgoing) {
    self.outbox_bytes = self.outbox_bytes.saturating_add(outgoing.bytes);
    self.outbox.push_back(outgoing);
  }

  /// Encoded bytes of the messages acknowledged but still in the outbox.
  fn acknowledged_bytes(&self) -> u64 {
    self
      .outbox
      .iter()
      .take_while(|outgoing| outgoing.seq <= self.ack_seq)
      .map(|outgoing| outgoing.bytes)
      .sum()
  }

  /// Drop the acknowledged messages.
  fn trim(&mut self) {
    let acked = self.ack_seq;
    while let Some(outgoing) =
      self.outbox.pop_front_if(|outgoing| outgoing.seq <= acked)
    {
      self.outbox_bytes = self.outbox_bytes.saturating_sub(outgoing.bytes);
    }
  }

  fn head(&self, generation: u64) -> Head {
    Head {
      run_id: self.run_id.clone(),
      decision: self.decision,
      decided_at_ms: self.decided_at_ms,
      inputs: self.inputs.clone(),
      approvals: self.approvals.clone(),
      answers: self.answers.clone(),
      interrupted: self.interrupted,
      cancelled: self.cancelled,
      ack_seq: self.ack_seq,
      generation,
    }
  }

  /// Undo what an update changed: everything it may change is in the head.
  fn restore(&mut self, head: Head) {
    self.decision = head.decision;
    self.inputs = head.inputs;
    self.approvals = head.approvals;
    self.answers = head.answers;
    self.interrupted = head.interrupted;
    self.cancelled = head.cancelled;
    self.ack_seq = head.ack_seq;
  }
}

/// A run's `head.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Head {
  run_id: String,
  decision: Decision,
  decided_at_ms: i64,
  inputs: BTreeSet<String>,
  approvals: BTreeSet<String>,
  /// Heads written before answers existed have none.
  #[serde(default)]
  answers: BTreeSet<String>,
  interrupted: bool,
  cancelled: bool,
  /// The acknowledged position when the head was written; the log may
  /// record a later one.
  ack_seq: u32,
  /// The log generation that holds the run's messages.
  generation: u64,
}

impl Head {
  /// Whether `other` differs only in the acknowledged position.
  fn same_commands(&self, other: &Self) -> bool {
    self.decision == other.decision
      && self.inputs == other.inputs
      && self.approvals == other.approvals
      && self.answers == other.answers
      && self.interrupted == other.interrupted
      && self.cancelled == other.cancelled
  }
}

/// One line of a run's log; written with borrowed messages, read with owned
/// ones.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Entry<M> {
  /// The messages one write took, positioned right after the log's
  /// previous ones (the first entry of a generation starts at or before
  /// the first unacknowledged position), and the counters after them.
  Taken { tail: Tail, messages: M },
  /// The API acknowledged every message through `seq`.
  Acknowledged { seq: u32 },
}

/// Where a run's log stands on disk.
#[derive(Debug, Clone, Copy, Default)]
struct LogState {
  generation: u64,
  /// Whole entries in the log: the position of the next one.
  entries: u64,
  /// Encoded bytes of every message the log holds, acknowledged or not.
  message_bytes: u64,
  /// The log may end in a partial entry, or a failed compaction may have
  /// left the head naming the next generation: the log moves to the next
  /// generation before anything is appended.
  torn: bool,
}

struct Held {
  record: RunRecord,
  log: LogState,
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
    | DesktopMessage::RunRejected(_)
    | DesktopMessage::FolderRestored(_)
    | DesktopMessage::RunBackground(_) => None,
  }
}

/// The run a sequenced message belongs to.
pub(crate) fn run_of(message: &DesktopMessage) -> Option<&str> {
  match message {
    DesktopMessage::RunEvent(event) => Some(&event.run_id),
    DesktopMessage::RunApprovalRequest(request) => Some(&request.run_id),
    DesktopMessage::RunFinished(finished) => Some(&finished.run_id),
    DesktopMessage::Hello(_)
    | DesktopMessage::HarnessStatus(_)
    | DesktopMessage::RunAccepted(_)
    | DesktopMessage::RunRejected(_)
    | DesktopMessage::FolderRestored(_)
    | DesktopMessage::RunBackground(_) => None,
  }
}

/// The bytes `message` takes on the wire; `None` over the frame limit.
fn encoded_bytes(message: &DesktopMessage) -> Option<u64> {
  encode(message).map(|text| u64::try_from(text.len()).unwrap_or(u64::MAX))
}

/// Where records live: encrypted files, or memory only when no key can be
/// used (debug builds, an unavailable keychain).
pub(crate) enum JournalBacking {
  Memory,
  Encrypted { directory: PathBuf, key: [u8; 32] },
}

pub(crate) struct Journal {
  backing: JournalBacking,
  runs: BTreeMap<String, Held>,
}

/// What [`Journal::record_outputs`] did with each output, in order, and the
/// messages it took.
struct Appended {
  outcomes: Vec<Result<NonZeroU32, EmitError>>,
  messages: Vec<DesktopMessage>,
}

impl Journal {
  /// Load every record. A record that cannot be read stays on disk untouched
  /// and is left out, so its run is dropped by the API rather than lost here.
  pub(crate) fn open(backing: JournalBacking, now_ms: i64) -> Self {
    let mut journal = Self {
      backing,
      runs: BTreeMap::new(),
    };
    for held in journal.load_all() {
      journal.runs.insert(held.record.run_id.clone(), held);
    }
    if let JournalBacking::Encrypted { directory, key } = &journal.backing {
      for held in journal.runs.values_mut().filter(|held| held.log.torn) {
        // Until it succeeds, the next append compacts first.
        if let Err(error) = compact(directory, *key, held) {
          tracing::warn!(error = %error, "desktop runner journal repair failed");
        }
      }
    }
    let stale: Vec<String> = journal
      .records()
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

  fn load_all(&self) -> Vec<Held> {
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
      .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
      .filter_map(|entry| {
        let run_id = entry.file_name().to_str()?.to_owned();
        Uuid::parse_str(&run_id).ok()?;
        match load_run(directory, *key, &run_id) {
          Ok(Some(held)) => Some(held),
          Ok(None) => {
            // No head: what a removal or a creation stopped part way left.
            clear_run_directory(&entry.path());
            None
          }
          Err(error) => {
            tracing::warn!(error = %error, "desktop runner journal record is unreadable");
            None
          }
        }
      })
      .collect()
  }

  pub(crate) fn get(&self, run_id: &str) -> Option<&RunRecord> {
    self.runs.get(run_id).map(|held| &held.record)
  }

  pub(crate) fn records(&self) -> impl Iterator<Item = &RunRecord> {
    self.runs.values().map(|held| &held.record)
  }

  /// Write a new run's record, then hold it, in place of any record the
  /// journal had under its id. On failure no record is held for the run.
  pub(crate) fn insert(
    &mut self,
    run_id: String,
    decision: Decision,
    now_ms: i64,
  ) -> Result<(), String> {
    let record = RunRecord::new(run_id, decision, now_ms);
    let log = LogState::default();
    if let JournalBacking::Encrypted { directory, key } = &self.backing {
      checked_run_id(&record.run_id)?;
      self.runs.remove(&record.run_id);
      remove_run_files(directory, &record.run_id)?;
      // The log exists before the head that names it.
      log_file(directory, *key, &record.run_id, log.generation)
        .replace::<Entry<&[DesktopMessage]>>(&[])?;
      head_file(directory, *key, &record.run_id)
        .persist(&record.head(log.generation))?;
    }
    self
      .runs
      .insert(record.run_id.clone(), Held { record, log });
    Ok(())
  }

  pub(crate) fn remove(&mut self, run_id: &str) -> Result<(), String> {
    if let JournalBacking::Encrypted { directory, .. } = &self.backing {
      checked_run_id(run_id)?;
      remove_run_files(directory, run_id)?;
    }
    self.runs.remove(run_id);
    Ok(())
  }

  /// Change one record's decision, commands or acknowledged position in
  /// place; `Ok(None)` when the journal holds no such record. On failure
  /// nothing changes.
  pub(crate) fn update<R>(
    &mut self,
    run_id: &str,
    change: impl FnOnce(&mut RunRecord) -> (Change, R),
  ) -> Result<Option<R>, String> {
    let Some(held) = self.runs.get_mut(run_id) else {
      return Ok(None);
    };
    let before = held.record.head(held.log.generation);
    let (write, result) = change(&mut held.record);
    match write {
      Change::Store => {
        if let Err(error) = store(&self.backing, held, &before) {
          held.record.restore(before);
          return Err(error);
        }
      }
      Change::Forget => {
        if let Err(error) = self.remove(run_id) {
          if let Some(held) = self.runs.get_mut(run_id) {
            held.record.restore(before);
          }
          return Err(error);
        }
      }
    }
    Ok(Some(result))
  }

  /// Number and journal outputs of a running run in one append; `None` when
  /// the journal holds no such running run. Nothing changes when the write
  /// fails.
  fn record_outputs(
    &mut self,
    run_id: &str,
    outputs: Vec<(RunOutput, Option<NonZeroU32>)>,
  ) -> Result<Option<Appended>, EmitError> {
    let Some(held) = self.runs.get_mut(run_id).filter(|held| {
      held.record.decision == Decision::Accepted && !held.record.tail.finished
    }) else {
      return Ok(None);
    };
    let mut tail = held.record.tail;
    let mut outcomes = Vec::with_capacity(outputs.len());
    let mut messages = Vec::new();
    let mut sizes = Vec::new();
    for (output, source_seq) in outputs {
      if let Some(source_seq) = source_seq {
        tail.source_seq = tail.source_seq.max(source_seq.get());
      }
      outcomes.push(
        take(&mut tail, run_id, output).map(|(seq, bytes, message)| {
          messages.push(message);
          sizes.push((seq.get(), bytes));
          seq
        }),
      );
    }
    if tail != held.record.tail {
      if let JournalBacking::Encrypted { directory, key } = &self.backing {
        let entry = Entry::Taken {
          tail,
          messages: messages.as_slice(),
        };
        append_entry(directory, *key, held, &entry).map_err(|error| {
          tracing::warn!(error = %error, "desktop runner journal write failed");
          EmitError::Storage
        })?;
      }
      held.record.tail = tail;
      for ((seq, bytes), message) in sizes.into_iter().zip(&messages) {
        held.log.message_bytes = held.log.message_bytes.saturating_add(bytes);
        held.record.push(Outgoing {
          seq,
          bytes,
          message: message.clone(),
        });
      }
    }
    Ok(Some(Appended { outcomes, messages }))
  }
}

/// Journal what an update changed: a changed decision or command rewrites
/// the head; an acknowledgement alone appends one entry, or compacts the
/// log once enough of it is acknowledged. Then the acknowledged messages
/// leave the outbox.
fn store(
  backing: &JournalBacking,
  held: &mut Held,
  before: &Head,
) -> Result<(), String> {
  if let JournalBacking::Encrypted { directory, key } = backing {
    let after = held.record.head(held.log.generation);
    if !before.same_commands(&after) {
      head_file(directory, *key, &held.record.run_id).persist(&after)?;
    } else if after.ack_seq != before.ack_seq {
      record_acknowledgement(directory, *key, held)?;
    }
  }
  held.record.trim();
  Ok(())
}

fn record_acknowledgement(
  directory: &Path,
  key: [u8; 32],
  held: &mut Held,
) -> Result<(), String> {
  let live = held
    .record
    .outbox_bytes
    .saturating_sub(held.record.acknowledged_bytes());
  let acknowledged = held.log.message_bytes.saturating_sub(live);
  if held.log.torn || (acknowledged >= live && acknowledged >= COMPACT_MIN_BYTES) {
    match compact(directory, key, held) {
      Ok(()) => return Ok(()),
      Err(error) if held.log.torn => return Err(error),
      Err(error) => {
        // The log still holds every message; record the position in it.
        tracing::warn!(error = %error, "desktop runner journal compaction failed");
      }
    }
  }
  let seq = held.record.ack_seq;
  append_entry(
    directory,
    key,
    held,
    &Entry::<&[DesktopMessage]>::Acknowledged { seq },
  )
}

/// Append one entry to a run's log, compacting a torn log first.
fn append_entry(
  directory: &Path,
  key: [u8; 32],
  held: &mut Held,
  entry: &Entry<&[DesktopMessage]>,
) -> Result<(), String> {
  if held.log.torn {
    compact(directory, key, held)?;
  }
  let log = log_file(directory, key, &held.record.run_id, held.log.generation);
  match log.append(held.log.entries, entry) {
    Ok(_written) => {
      held.log.entries = held.log.entries.saturating_add(1);
      Ok(())
    }
    Err(error) => {
      // The entry may be in the file in part.
      held.log.torn = true;
      Err(error)
    }
  }
}

/// Move a run's unacknowledged messages, with its counters, to the next log
/// generation. The new log is written whole before the head names it, and
/// the old one is removed after: a crash in between leaves one of the two
/// generations whole and named. A failed head write may still have replaced
/// the head, so nothing is appended to either generation until a compaction
/// succeeds and both agree again.
fn compact(directory: &Path, key: [u8; 32], held: &mut Held) -> Result<(), String> {
  let record = &held.record;
  let generation = held
    .log
    .generation
    .checked_add(1)
    .ok_or_else(|| format!("{RECORD_LABEL} ran out of log generations"))?;
  let mut message_bytes: u64 = 0;
  let mut messages = Vec::new();
  for outgoing in record.unacknowledged() {
    message_bytes = message_bytes.saturating_add(outgoing.bytes);
    messages.push(&outgoing.message);
  }
  log_file(directory, key, &record.run_id, generation).replace(&[Entry::Taken {
    tail: record.tail,
    messages,
  }])?;
  if let Err(error) =
    head_file(directory, key, &record.run_id).persist(&record.head(generation))
  {
    held.log.torn = true;
    return Err(error);
  }
  let previous = log_path(directory, &record.run_id, held.log.generation);
  held.log = LogState {
    generation,
    entries: 1,
    message_bytes,
    torn: false,
  };
  remove_quietly(&previous);
  Ok(())
}

/// One output appended to `tail`, or why it is not taken.
fn take(
  tail: &mut Tail,
  run_id: &str,
  output: RunOutput,
) -> Result<(NonZeroU32, u64, DesktopMessage), EmitError> {
  if tail.finished {
    return Err(EmitError::RunClosed);
  }
  let seq = tail
    .last_seq
    .checked_add(1)
    .and_then(NonZeroU32::new)
    .ok_or(EmitError::RunClosed)?;
  let finished = matches!(output, RunOutput::Finished { .. });
  let message = numbered(run_id.to_owned(), seq, output);
  let bytes = encoded_bytes(&message).ok_or(EmitError::TooLarge)?;
  let produced = tail.produced_bytes.saturating_add(bytes);
  if !finished
    && (seq.get() > MAX_MESSAGES_PER_RUN || produced > MAX_MESSAGE_BYTES_PER_RUN)
  {
    return Err(EmitError::Full);
  }
  tail.last_seq = seq.get();
  tail.produced_bytes = produced;
  tail.finished = finished;
  Ok((seq, bytes, message))
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

/// Read one run's directory: `Ok(None)` when it has no head.
fn load_run(
  directory: &Path,
  key: [u8; 32],
  run_id: &str,
) -> Result<Option<Held>, String> {
  let Some(head) = head_file(directory, key, run_id).load::<Head>()? else {
    return Ok(None);
  };
  if head.run_id != run_id {
    return Err(format!("{RECORD_LABEL} head names another run"));
  }
  let generation = head.generation;
  let contents = log_file(directory, key, run_id, generation)
    .load::<Entry<Vec<DesktopMessage>>>()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("{RECORD_LABEL} log is missing"))?;
  let held = replay(head, contents)?;
  remove_other_generations(directory, run_id, generation);
  Ok(Some(held))
}

/// Rebuild a run from its head and log, refusing a log that skips, repeats
/// or loses a position.
fn replay(
  head: Head,
  contents: LogContents<Entry<Vec<DesktopMessage>>>,
) -> Result<Held, String> {
  let invalid = |what: &str| format!("{RECORD_LABEL} log {what}");
  let generation = head.generation;
  let mut record =
    RunRecord::new(head.run_id.clone(), head.decision, head.decided_at_ms);
  record.restore(head);
  let mut log = LogState {
    generation,
    entries: 0,
    message_bytes: 0,
    torn: contents.torn,
  };
  for entry in contents.values {
    match entry {
      Entry::Taken { tail, messages } => {
        let before = record.tail;
        if tail.last_seq < before.last_seq
          || tail.source_seq < before.source_seq
          || tail.produced_bytes < before.produced_bytes
          || (before.finished && (!tail.finished || !messages.is_empty()))
        {
          return Err(invalid("goes back"));
        }
        // The first entry starts the generation anywhere; the final check
        // below finds a gap before it.
        let mut next =
          (log.entries > 0).then_some(u64::from(before.last_seq).saturating_add(1));
        for message in messages {
          let seq = seq_of(&message).ok_or_else(|| invalid("holds a bare message"))?;
          if run_of(&message) != Some(record.run_id.as_str()) {
            return Err(invalid("holds another run's message"));
          }
          if next.is_some_and(|next| next != u64::from(seq)) {
            return Err(invalid("skips or repeats a position"));
          }
          next = Some(u64::from(seq).saturating_add(1));
          let bytes = encoded_bytes(&message)
            .ok_or_else(|| invalid("holds an oversized message"))?;
          log.message_bytes = log.message_bytes.saturating_add(bytes);
          record.push(Outgoing {
            seq,
            bytes,
            message,
          });
        }
        if next.is_some_and(|next| next != u64::from(tail.last_seq).saturating_add(1)) {
          return Err(invalid("disagrees with its counters"));
        }
        record.tail = tail;
      }
      Entry::Acknowledged { seq } => {
        if seq > record.tail.last_seq {
          return Err(invalid("acknowledges a position never produced"));
        }
        record.ack_seq = record.ack_seq.max(seq);
      }
    }
    log.entries = log.entries.saturating_add(1);
  }
  if record.ack_seq > record.tail.last_seq {
    return Err(invalid("is behind its head"));
  }
  record.trim();
  // Exactly the positions after the acknowledged one are left.
  let first = record.outbox.front().map_or_else(
    || u64::from(record.tail.last_seq).saturating_add(1),
    |outgoing| u64::from(outgoing.seq),
  );
  if first != u64::from(record.ack_seq).saturating_add(1) {
    return Err(invalid("lost a message"));
  }
  Ok(Held { record, log })
}

/// Run ids name directories, so only a UUID may reach a path.
fn checked_run_id(run_id: &str) -> Result<(), String> {
  Uuid::parse_str(run_id)
    .map(|_uuid| ())
    .map_err(|_not_uuid| format!("{RECORD_LABEL} refused a run id that is not a UUID"))
}

fn run_directory(directory: &Path, run_id: &str) -> PathBuf {
  directory.join(run_id)
}

fn head_file(directory: &Path, key: [u8; 32], run_id: &str) -> EncryptedJsonFile {
  EncryptedJsonFile::new(
    key,
    run_directory(directory, run_id).join(HEAD_FILE),
    RECORD_LABEL,
  )
  .with_associated_data(format!("desktop-runner-run:{run_id}:head"))
}

fn log_name(generation: u64) -> String {
  format!("{LOG_PREFIX}{generation}.{LOG_EXTENSION}")
}

fn log_path(directory: &Path, run_id: &str, generation: u64) -> PathBuf {
  run_directory(directory, run_id).join(log_name(generation))
}

fn log_file(
  directory: &Path,
  key: [u8; 32],
  run_id: &str,
  generation: u64,
) -> EncryptedJsonLog {
  EncryptedJsonLog::new(key, log_path(directory, run_id, generation), RECORD_LABEL)
    .with_associated_data(format!("desktop-runner-run:{run_id}:log:{generation}"))
}

/// Remove a run's files, its head first: a run whose removal stopped part
/// way has no head, and the next open clears what is left.
fn remove_run_files(directory: &Path, run_id: &str) -> Result<(), String> {
  let folder = run_directory(directory, run_id);
  match local_store::remove_private(&folder.join(HEAD_FILE)) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => return Err(format!("{RECORD_LABEL} removal failed: {error}")),
  }
  clear_run_directory(&folder);
  Ok(())
}

/// Remove a run directory that has no head, and everything in it.
fn clear_run_directory(folder: &Path) {
  let entries = match fs::read_dir(folder) {
    Ok(entries) => entries,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
    Err(error) => {
      tracing::warn!(kind = ?error.kind(), "desktop runner journal cleanup failed");
      return;
    }
  };
  for entry in entries.filter_map(Result::ok) {
    remove_quietly(&entry.path());
  }
  match fs::remove_dir(folder) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => {
      tracing::warn!(kind = ?error.kind(), "desktop runner journal cleanup failed");
    }
  }
}

/// Remove every file of a run but its head and the log it names: logs a
/// compaction left behind, and temporaries an interrupted write left.
fn remove_other_generations(directory: &Path, run_id: &str, generation: u64) {
  let current = log_name(generation);
  let Ok(entries) = fs::read_dir(run_directory(directory, run_id)) else {
    return;
  };
  for entry in entries.filter_map(Result::ok) {
    let name = entry.file_name();
    if name != HEAD_FILE && name != current.as_str() {
      remove_quietly(&entry.path());
    }
  }
}

fn remove_quietly(path: &Path) {
  match fs::remove_file(path) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => {
      tracing::warn!(kind = ?error.kind(), "desktop runner journal cleanup failed");
    }
  }
}

/// What [`SharedJournal::update`] does with the changed record.
pub(crate) enum Change {
  Store,
  Forget,
}

struct SharedState {
  journal: Option<(String, Journal)>,
  /// Where newly journaled messages go to be sent while a socket is up.
  live: Option<mpsc::UnboundedSender<DesktopMessage>>,
  /// What each finished run's kept harness process runs in the background,
  /// as the holder last reported; only counts above 0.
  background: BTreeMap<String, u32>,
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
      background: BTreeMap::new(),
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

  /// What a run's kept harness process runs in the background now: held
  /// for the next socket and sent to the current one, if one is up.
  pub(crate) fn report_background(&self, run_id: String, count: u32) {
    let mut state = self.state();
    if count == 0 {
      state.background.remove(&run_id);
    } else {
      state.background.insert(run_id.clone(), count);
    }
    if let Some(live) = state.live.as_ref() {
      let _sent = live.send(DesktopMessage::RunBackground(RunBackground {
        run_id,
        count,
      }));
    }
  }

  /// Every count above 0, for a socket that just connected.
  pub(crate) fn background_reports(&self) -> Vec<DesktopMessage> {
    self
      .state()
      .background
      .iter()
      .map(|(run_id, &count)| {
        DesktopMessage::RunBackground(RunBackground {
          run_id: run_id.clone(),
          count,
        })
      })
      .collect()
  }

  /// Send a message that is not journaled (it belongs to no run) to the
  /// socket, if one is up; without one it is dropped.
  pub(crate) fn send_unsequenced(&self, message: DesktopMessage) {
    if let Some(live) = self.state().live.as_ref() {
      let _sent = live.send(message);
    }
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

  /// Write a new run's record, then hold it.
  pub(crate) fn insert(
    &self,
    run_id: String,
    decision: Decision,
    now_ms: i64,
  ) -> Result<(), String> {
    match self.state().journal.as_mut() {
      Some((_, journal)) => journal.insert(run_id, decision, now_ms),
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
    match self.state().journal.as_mut() {
      Some((_, journal)) => journal.update(run_id, change),
      None => Ok(None),
    }
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
    let count = outputs.len();
    let mut state = self.state();
    let Some((_, journal)) = state.journal.as_mut() else {
      return Ok(Recorded::closed(count));
    };
    let Some(appended) = journal.record_outputs(run_id, outputs)? else {
      return Ok(Recorded::closed(count));
    };
    if let Some(live) = state.live.as_ref() {
      for message in appended.messages {
        // A runner that is gone resends from the journal once it is back.
        let _unsent = live.send(message);
      }
    }
    // Held to here: the live channel sees positions in journal order.
    drop(state);
    Ok(Recorded {
      outcomes: appended.outcomes,
    })
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

#[cfg(test)]
#[path = "journal_tests.rs"]
mod tests;
