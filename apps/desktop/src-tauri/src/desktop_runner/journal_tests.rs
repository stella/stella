use super::*;
use crate::runner_protocol::JsonObject;

const RUN: &str = "0192f3a0-6b1c-7d2e-8f30-000000000001";
const KEY: [u8; 32] = [7; 32];

fn chunk(delta: &str) -> JsonObject {
  serde_json::from_value(serde_json::json!({
    "type": "TEXT_MESSAGE_CONTENT",
    "messageId": "message-1",
    "delta": delta,
  }))
  .unwrap()
}

fn event(seq: u32, delta: &str) -> DesktopMessage {
  DesktopMessage::RunEvent(RunEvent {
    run_id: RUN.to_owned(),
    seq: NonZeroU32::new(seq).unwrap(),
    chunk: chunk(delta),
  })
}

fn encrypted(directory: &Path) -> JournalBacking {
  JournalBacking::Encrypted {
    directory: directory.to_path_buf(),
    key: KEY,
  }
}

fn temp_dir() -> PathBuf {
  std::env::temp_dir().join(format!("stella-runner-journal-{}", Uuid::new_v4()))
}

/// Journal one event per delta in one write; the positions they took.
fn take_outputs(journal: &mut Journal, deltas: &[&str]) -> Vec<u32> {
  let outputs = deltas
    .iter()
    .map(|delta| (RunOutput::Event(chunk(delta)), None))
    .collect();
  let appended = journal.record_outputs(RUN, outputs).unwrap().unwrap();
  appended
    .outcomes
    .into_iter()
    .map(|outcome| outcome.unwrap().get())
    .collect()
}

fn acknowledge(journal: &mut Journal, seq: u32) {
  journal
    .update(RUN, |record| {
      record.acknowledge(seq);
      (Change::Store, ())
    })
    .unwrap()
    .unwrap();
}

fn outbox_seqs(journal: &Journal) -> Vec<u32> {
  journal
    .get(RUN)
    .unwrap()
    .outbox()
    .filter_map(seq_of)
    .collect()
}

fn files(directory: &Path) -> Vec<String> {
  let mut names: Vec<String> = fs::read_dir(run_directory(directory, RUN))
    .unwrap()
    .map(|entry| entry.unwrap().file_name().into_string().unwrap())
    .collect();
  names.sort();
  names
}

/// Bytes the run's files hold together.
fn run_bytes(directory: &Path) -> u64 {
  fs::read_dir(run_directory(directory, RUN))
    .unwrap()
    .map(|entry| entry.unwrap().metadata().unwrap().len())
    .sum()
}

fn generation(journal: &Journal) -> u64 {
  journal.runs.get(RUN).unwrap().log.generation
}

#[test]
fn a_record_survives_a_reopen_and_acknowledging_trims_its_outbox() {
  let directory = temp_dir();
  let mut journal = Journal::open(encrypted(&directory), 0);
  journal
    .insert(RUN.to_owned(), Decision::Accepted, 0)
    .unwrap();
  journal
    .update(RUN, |record| {
      record.inputs.insert("input-1".to_owned());
      (Change::Store, ())
    })
    .unwrap();
  // A change the caller does not store is not held either.
  journal
    .update(RUN, |record| {
      record.inputs.insert("input-2".to_owned());
      (Change::Unchanged, ())
    })
    .unwrap();
  assert_eq!(take_outputs(&mut journal, &["a"]), [1]);
  assert_eq!(take_outputs(&mut journal, &["b", "c"]), [2, 3]);
  let written = journal.get(RUN).unwrap().clone();
  assert_eq!(written.inputs, BTreeSet::from(["input-1".to_owned()]));

  let mut reopened = Journal::open(encrypted(&directory), 0);
  assert_eq!(reopened.get(RUN), Some(&written));
  acknowledge(&mut reopened, 2);
  assert_eq!(
    reopened
      .get(RUN)
      .unwrap()
      .outbox()
      .cloned()
      .collect::<Vec<_>>(),
    vec![event(3, "c")]
  );
  // An ack beyond what was produced never claims more than was sent.
  acknowledge(&mut reopened, 9);
  assert_eq!(reopened.get(RUN).unwrap().ack_seq, 3);
  assert!(outbox_seqs(&reopened).is_empty());
  // A reopen reads exactly the acknowledged state.
  let acknowledged = reopened.get(RUN).unwrap().clone();
  assert_eq!(
    Journal::open(encrypted(&directory), 0).get(RUN),
    Some(&acknowledged)
  );
  reopened.remove(RUN).unwrap();
  assert!(Journal::open(encrypted(&directory), 0).get(RUN).is_none());
  assert!(!run_directory(&directory, RUN).exists());
  fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_record_under_another_name_or_key_is_not_read() {
  let directory = temp_dir();
  let mut journal = Journal::open(encrypted(&directory), 0);
  journal
    .insert(RUN.to_owned(), Decision::Accepted, 0)
    .unwrap();
  take_outputs(&mut journal, &["a"]);
  let other = "0192f3a0-6b1c-7d2e-8f30-000000000002";
  crate::local_store::publish_directory(
    &run_directory(&directory, RUN),
    &run_directory(&directory, other),
  )
  .unwrap();
  assert_eq!(Journal::open(encrypted(&directory), 0).records().count(), 0);
  crate::local_store::publish_directory(
    &run_directory(&directory, other),
    &run_directory(&directory, RUN),
  )
  .unwrap();
  let wrong_key = JournalBacking::Encrypted {
    directory: directory.clone(),
    key: [8; 32],
  };
  assert_eq!(Journal::open(wrong_key, 0).records().count(), 0);
  // Unreadable records are left in place, not deleted.
  assert_eq!(files(&directory), ["head.json", "log-0.jsonl"]);
  assert_eq!(Journal::open(encrypted(&directory), 0).records().count(), 1);
  fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_run_id_that_is_not_a_uuid_never_reaches_a_path() {
  let directory = temp_dir();
  let mut journal = Journal::open(encrypted(&directory), 0);
  assert!(
    journal
      .insert("../escape".to_owned(), Decision::Accepted, 0)
      .is_err()
  );
  assert!(journal.get("../escape").is_none());
  assert!(!directory.join("../escape").exists());
  let _cleanup = fs::remove_dir_all(directory);
}

#[test]
fn refused_runs_expire_and_accepted_runs_stay() {
  let directory = temp_dir();
  let mut journal = Journal::open(encrypted(&directory), 0);
  let refused = "0192f3a0-6b1c-7d2e-8f30-000000000003";
  journal
    .insert(
      refused.to_owned(),
      Decision::Rejected {
        reason: RejectReason::HarnessNotInstalled,
      },
      0,
    )
    .unwrap();
  journal
    .insert(RUN.to_owned(), Decision::Accepted, 0)
    .unwrap();
  let kept = Journal::open(encrypted(&directory), REFUSED_RETENTION_MS);
  assert!(kept.get(refused).is_some());
  let expired = Journal::open(encrypted(&directory), REFUSED_RETENTION_MS + 1);
  assert!(expired.get(refused).is_none());
  assert!(expired.get(RUN).is_some());
  assert!(!run_directory(&directory, refused).exists());
  fs::remove_dir_all(directory).unwrap();
}

#[test]
fn appending_an_output_writes_that_output_and_not_what_the_run_holds() {
  let directory = temp_dir();
  let mut journal = Journal::open(encrypted(&directory), 0);
  journal
    .insert(RUN.to_owned(), Decision::Accepted, 0)
    .unwrap();
  let head_path = run_directory(&directory, RUN).join(HEAD_FILE);
  let head = fs::read(&head_path).unwrap();
  let appends: u32 = 300;
  let mut written = Vec::new();
  let mut size = run_bytes(&directory);
  for _ in 0..appends {
    take_outputs(&mut journal, &["private delta"]);
    let grown = run_bytes(&directory);
    written.push(grown - size);
    size = grown;
  }
  let first = written[0];
  let last = written[written.len() - 1];
  // The 300th append writes what the first did, give or take the digits of
  // its position: its cost does not grow with what the run holds.
  assert!(last <= first + first / 10, "first {first}, last {last}");
  let total: u64 = written.iter().sum();
  assert!(
    total <= u64::from(appends) * (first + first / 10),
    "{total} bytes for {appends} appends"
  );
  // The head is not rewritten by an append.
  assert_eq!(fs::read(&head_path).unwrap(), head);
  for name in files(&directory) {
    let raw = fs::read(run_directory(&directory, RUN).join(name)).unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("private delta"));
  }
  let reopened = Journal::open(encrypted(&directory), 0);
  assert_eq!(outbox_seqs(&reopened), (1..=appends).collect::<Vec<_>>());
  fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_torn_last_entry_is_left_out_and_its_position_taken_once() {
  let directory = temp_dir();
  let mut journal = Journal::open(encrypted(&directory), 0);
  journal
    .insert(RUN.to_owned(), Decision::Accepted, 0)
    .unwrap();
  for delta in ["a", "b", "c", "d"] {
    take_outputs(&mut journal, &[delta]);
  }
  drop(journal);
  // The app stopped while the fourth entry was on its way to the disk.
  let log = log_path(&directory, RUN, 0);
  let whole = fs::read(&log).unwrap();
  crate::local_store::write_test_fixture(&log, &whole[..whole.len() - 7]).unwrap();

  let mut reopened = Journal::open(encrypted(&directory), 0);
  assert_eq!(reopened.get(RUN).unwrap().last_seq(), 3);
  assert_eq!(outbox_seqs(&reopened), [1, 2, 3]);
  // The torn log moved to the next generation without the cut entry.
  assert_eq!(generation(&reopened), 1);
  assert_eq!(files(&directory), ["head.json", "log-1.jsonl"]);
  // The next output takes the position the cut one never got.
  assert_eq!(take_outputs(&mut reopened, &["d again"]), [4]);
  let again = Journal::open(encrypted(&directory), 0);
  assert_eq!(outbox_seqs(&again), [1, 2, 3, 4]);
  assert_eq!(
    again.get(RUN).unwrap().outbox().last(),
    Some(&event(4, "d again"))
  );
  fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_compaction_cut_short_leaves_one_whole_generation() {
  let directory = temp_dir();
  let mut journal = Journal::open(encrypted(&directory), 0);
  journal
    .insert(RUN.to_owned(), Decision::Accepted, 0)
    .unwrap();
  take_outputs(&mut journal, &["a", "b", "c"]);
  // The next generation was written, but the head never named it; an
  // atomic write left its temporary.
  crate::local_store::write_test_fixture(
    log_path(&directory, RUN, 1),
    b"not named by the head\n",
  )
  .unwrap();
  crate::local_store::write_test_fixture(
    run_directory(&directory, RUN).join("head.json.1.tmp"),
    b"partial",
  )
  .unwrap();
  let mut reopened = Journal::open(encrypted(&directory), 0);
  assert_eq!(outbox_seqs(&reopened), [1, 2, 3]);
  assert_eq!(files(&directory), ["head.json", "log-0.jsonl"]);

  // The head named the next generation, but the previous one was not
  // removed yet.
  let held = reopened.runs.get_mut(RUN).unwrap();
  compact(&directory, KEY, held).unwrap();
  crate::local_store::write_test_fixture(log_path(&directory, RUN, 0), b"previous\n")
    .unwrap();
  let reopened = Journal::open(encrypted(&directory), 0);
  assert_eq!(generation(&reopened), 1);
  assert_eq!(outbox_seqs(&reopened), [1, 2, 3]);
  assert_eq!(files(&directory), ["head.json", "log-1.jsonl"]);
  fs::remove_dir_all(directory).unwrap();
}

#[test]
fn acknowledgements_survive_a_reopen_and_compaction_keeps_the_unacknowledged() {
  let directory = temp_dir();
  let mut journal = Journal::open(encrypted(&directory), 0);
  journal
    .insert(RUN.to_owned(), Decision::Accepted, 0)
    .unwrap();
  let large = "x".repeat(16 * 1024);
  for _ in 0..40 {
    take_outputs(&mut journal, &[&large]);
  }
  let log = log_path(&directory, RUN, 0);
  let before = fs::metadata(&log).unwrap().len();
  // A small acknowledgement appends its position and nothing else.
  acknowledge(&mut journal, 2);
  assert_eq!(generation(&journal), 0);
  assert!(fs::metadata(&log).unwrap().len() - before < 1024);
  let reopened = Journal::open(encrypted(&directory), 0);
  assert_eq!(reopened.get(RUN).unwrap().ack_seq, 2);
  assert_eq!(outbox_seqs(&reopened), (3..=40).collect::<Vec<_>>());

  // Once the log holds more acknowledged bytes than unacknowledged ones,
  // only the unacknowledged move on to the next generation.
  acknowledge(&mut journal, 30);
  assert_eq!(generation(&journal), 1);
  assert_eq!(files(&directory), ["head.json", "log-1.jsonl"]);
  assert!(fs::metadata(log_path(&directory, RUN, 1)).unwrap().len() < before / 3);
  let reopened = Journal::open(encrypted(&directory), 0);
  assert_eq!(reopened.get(RUN), journal.get(RUN));
  assert_eq!(reopened.get(RUN).unwrap().ack_seq, 30);
  assert_eq!(outbox_seqs(&reopened), (31..=40).collect::<Vec<_>>());

  assert_eq!(take_outputs(&mut journal, &["after"]), [41]);
  acknowledge(&mut journal, 35);
  let reopened = Journal::open(encrypted(&directory), 0);
  assert_eq!(reopened.get(RUN), journal.get(RUN));
  assert_eq!(outbox_seqs(&reopened), (36..=41).collect::<Vec<_>>());
  fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_log_damaged_before_its_last_entry_is_unreadable_and_kept() {
  let directory = temp_dir();
  let mut journal = Journal::open(encrypted(&directory), 0);
  journal
    .insert(RUN.to_owned(), Decision::Accepted, 0)
    .unwrap();
  for delta in ["a", "b", "c"] {
    take_outputs(&mut journal, &[delta]);
  }
  let log = log_path(&directory, RUN, 0);
  let whole = fs::read(&log).unwrap();
  let lines: Vec<&[u8]> = whole.split_inclusive(|byte| *byte == b'\n').collect();
  assert_eq!(lines.len(), 3);
  // A damaged entry, or a dropped one, before the last.
  for damaged in [
    [lines[0], b"damaged\n".as_slice(), lines[2]].concat(),
    [lines[0], lines[2]].concat(),
  ] {
    crate::local_store::write_test_fixture(&log, &damaged).unwrap();
    assert_eq!(Journal::open(encrypted(&directory), 0).records().count(), 0);
    assert_eq!(fs::read(&log).unwrap(), damaged);
  }
  fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_removal_cut_short_is_finished_at_the_next_open() {
  let directory = temp_dir();
  let mut journal = Journal::open(encrypted(&directory), 0);
  journal
    .insert(RUN.to_owned(), Decision::Accepted, 0)
    .unwrap();
  take_outputs(&mut journal, &["a"]);
  crate::local_store::remove_private(&run_directory(&directory, RUN).join(HEAD_FILE))
    .unwrap();
  assert_eq!(Journal::open(encrypted(&directory), 0).records().count(), 0);
  assert!(!run_directory(&directory, RUN).exists());
  fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_memory_journal_numbers_and_acknowledges_alike() {
  let mut journal = Journal::open(JournalBacking::Memory, 0);
  journal
    .insert(RUN.to_owned(), Decision::Accepted, 0)
    .unwrap();
  assert_eq!(take_outputs(&mut journal, &["a", "b"]), [1, 2]);
  acknowledge(&mut journal, 1);
  assert_eq!(outbox_seqs(&journal), [2]);
  assert_eq!(
    journal.get(RUN).unwrap().outbox_bytes,
    encoded_bytes(&event(2, "b")).unwrap()
  );
}
