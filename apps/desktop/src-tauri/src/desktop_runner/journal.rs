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
  path::PathBuf,
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::local_store::EncryptedJsonFile;
use crate::runner_protocol::{DesktopMessage, RejectReason};

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
  pub(crate) interrupted: bool,
  pub(crate) cancelled: bool,
  /// The last position this desktop produced; 0 before the first.
  pub(crate) last_seq: u32,
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
      interrupted: false,
      cancelled: false,
      last_seq: 0,
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
    fs::rename(record_path(&directory, RUN), record_path(&directory, other)).unwrap();
    assert_eq!(Journal::open(encrypted(&directory), 0).records().count(), 0);
    fs::rename(record_path(&directory, other), record_path(&directory, RUN)).unwrap();
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
