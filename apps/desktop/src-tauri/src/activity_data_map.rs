//! What Activity keeps, where, whether it leaves the computer, and how long
//! it stays: one typed row per stored field, rendered into
//! `apps/desktop/docs/activity-data-map.gen.md`.
//!
//! The rows are checked against what the store writes: every record kind
//! serializes a sample with every field set, and the field paths of the
//! samples must equal the rows' paths. A stored field added without a row,
//! or a row whose field is gone, fails the check; so does a committed page
//! that no longer matches the rows.
//!
//! Regenerate the page from the repository root with
//! `bun --filter @stll/desktop activity-data-map:generate`.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::activity::{
  ActivityAssignedMatter, ActivityCalendarSource, ActivityDraftedEntry, ActivityGap,
  ActivityManualAssignment, ActivityRecordingStatus, ActivityRetention,
  ActivitySegment, ActivitySettings, GapDisplay, GapEnd,
};
use crate::activity_capture::{CaptureOutage, StopReason};
use crate::activity_matter_learning::StoredMatterLearning;
use crate::foreground_app::AppExclusion;

const COMMITTED_PAGE: &str = include_str!("../../docs/activity-data-map.gen.md");
const GENERATED_HEADER: &str = "<!-- Generated from apps/desktop/src-tauri/src/activity_data_map.rs. Do not edit. -->\n<!-- Regenerate from the repository root with `bun --filter @stll/desktop activity-data-map:generate`. -->\n";

/// Where a record is kept on the computer.
#[derive(Clone, Copy)]
enum Storage {
  /// A file in the account's encrypted Activity store, sealed with the
  /// account's own key from the system keychain.
  EncryptedStore { file: &'static str },
  /// The small plain file kept per account so the app knows the member's
  /// recording choice while the encrypted store is closed.
  PlainAccountRecord,
}

/// Whether, and when, a field's value leaves the computer.
#[derive(Clone, Copy)]
enum Leaves {
  Never,
  /// In a stella AI draft request the member asks for, once they allowed
  /// stella AI drafts.
  InAiDraftRequest,
  /// As the time entries the member confirms, sent to their stella server.
  AsConfirmedTimeEntries,
  /// It came from the member's stella server and already lives there; the
  /// copy here is never sent back.
  CopiedFromServer,
}

/// The record kinds Activity stores.
#[derive(Clone, Copy)]
enum RecordKind {
  Settings,
  Day,
  Segment,
  Gap,
  DraftedEntry,
  ManualAssignment,
  Outage,
  MatterLearning,
  CaptureRecord,
}

impl RecordKind {
  const ALL: [Self; 9] = [
    Self::Settings,
    Self::Day,
    Self::Segment,
    Self::Gap,
    Self::DraftedEntry,
    Self::ManualAssignment,
    Self::Outage,
    Self::MatterLearning,
    Self::CaptureRecord,
  ];
}

struct Field {
  /// The field's JSON path in the stored record; nested objects are joined
  /// with `.`, lists are one field.
  path: &'static str,
  holds: &'static str,
  leaves: Leaves,
}

struct Record {
  kind: RecordKind,
  title: &'static str,
  storage: Storage,
  retention: &'static str,
  fields: &'static [Field],
}

const DAY_RETENTION: &str = "Deleted with its day: by the hourly sweep once the day is older than the retention setting (7, 30 or 90 days), with Delete day, or with Delete all history. A day holding time entries not yet confirmed by the server, or one that cannot be read, is kept until that is resolved.";

const fn field(path: &'static str, holds: &'static str, leaves: Leaves) -> Field {
  Field {
    path,
    holds,
    leaves,
  }
}

/// Every record Activity stores, in the order the page lists them.
const RECORDS: [Record; 9] = [
  Record {
    kind: RecordKind::Settings,
    title: "Settings",
    storage: Storage::EncryptedStore {
      file: "settings.json.enc",
    },
    retention: "Kept until the member changes them. Delete all history keeps them; deleting another account's history removes that account's whole store.",
    fields: &[
      field(
        "recordingStatus",
        "Whether recording is off, on or paused.",
        Leaves::Never,
      ),
      field(
        "retention",
        "How long recorded days are kept: a week, a month or a quarter.",
        Leaves::Never,
      ),
      field(
        "excludedApps",
        "Apps never recorded: identifier and name.",
        Leaves::Never,
      ),
      field(
        "captureDetails",
        "The member's choice to record window titles and documents.",
        Leaves::Never,
      ),
      field(
        "appNameOnlyApps",
        "Apps recorded by name only: identifier and name.",
        Leaves::Never,
      ),
      field(
        "browserTitleApps",
        "Browsers the member allowed to record tab titles: identifier and name.",
        Leaves::Never,
      ),
      field(
        "ignoreCalls",
        "The member's choice not to detect calls.",
        Leaves::Never,
      ),
      field(
        "calendarSource",
        "Where the day review reads calendar events from. Events are shown, never recorded.",
        Leaves::Never,
      ),
    ],
  },
  Record {
    kind: RecordKind::Day,
    title: "Day",
    storage: Storage::EncryptedStore {
      file: "days/YYYY-MM-DD.json.enc",
    },
    retention: DAY_RETENTION,
    fields: &[
      field(
        "segments",
        "The day's recorded stretches; see Segment.",
        Leaves::Never,
      ),
      field(
        "gaps",
        "Stretches with no input between recorded activity; see Gap.",
        Leaves::Never,
      ),
      field(
        "manualAssignments",
        "Stretches the member assigned to a matter; see Manual assignment.",
        Leaves::Never,
      ),
      field(
        "draftedEntries",
        "Stretches already turned into time entries; see Drafted entry.",
        Leaves::Never,
      ),
      field(
        "pendingBatch.idempotencyKey",
        "The key that keeps a confirmed batch from being created twice.",
        Leaves::AsConfirmedTimeEntries,
      ),
      field(
        "pendingBatch.entries",
        "The time entries the member confirmed and the server has not acknowledged yet: matter, date, duration, description, billable status and any billing codes.",
        Leaves::AsConfirmedTimeEntries,
      ),
      field(
        "pendingBatch.ranges",
        "The stretches each pending entry covers.",
        Leaves::Never,
      ),
    ],
  },
  Record {
    kind: RecordKind::Segment,
    title: "Segment",
    storage: Storage::EncryptedStore {
      file: "days/YYYY-MM-DD.json.enc",
    },
    retention: DAY_RETENTION,
    fields: &[
      field(
        "appIdentifier",
        "The app in front: its bundle identifier or executable.",
        Leaves::Never,
      ),
      field(
        "appName",
        "The app's display name.",
        Leaves::InAiDraftRequest,
      ),
      field(
        "windowTitle",
        "The window or browser tab title, only with details on and, for a browser, only in browsers the member allowed.",
        Leaves::InAiDraftRequest,
      ),
      field(
        "document",
        "The open document's path, with details on. A draft request carries the document's name only, never its path.",
        Leaves::InAiDraftRequest,
      ),
      field(
        "matterId",
        "The matter the stretch was assigned to, if any.",
        Leaves::InAiDraftRequest,
      ),
      field(
        "call",
        "Whether the stretch was time on a call.",
        Leaves::Never,
      ),
      field(
        "start",
        "When the stretch started. A draft request carries the date and duration only.",
        Leaves::InAiDraftRequest,
      ),
      field(
        "end",
        "When the stretch ended. A draft request carries the date and duration only.",
        Leaves::InAiDraftRequest,
      ),
    ],
  },
  Record {
    kind: RecordKind::Gap,
    title: "Gap",
    storage: Storage::EncryptedStore {
      file: "days/YYYY-MM-DD.json.enc",
    },
    retention: DAY_RETENTION,
    fields: &[
      field(
        "start",
        "When the stretch with no input started.",
        Leaves::Never,
      ),
      field("end", "When it ended.", Leaves::Never),
      field(
        "endedBy",
        "What ended it: input, a stop, or the end of the day.",
        Leaves::Never,
      ),
      field(
        "display",
        "What the screen did meanwhile: stayed on, locked or slept.",
        Leaves::Never,
      ),
    ],
  },
  Record {
    kind: RecordKind::DraftedEntry,
    title: "Drafted entry",
    storage: Storage::EncryptedStore {
      file: "days/YYYY-MM-DD.json.enc",
    },
    retention: DAY_RETENTION,
    fields: &[
      field(
        "start",
        "Where the stretch turned into an entry starts.",
        Leaves::Never,
      ),
      field("end", "Where it ends.", Leaves::Never),
      field(
        "entryId",
        "The time entry the server created for it.",
        Leaves::CopiedFromServer,
      ),
    ],
  },
  Record {
    kind: RecordKind::ManualAssignment,
    title: "Manual assignment",
    storage: Storage::EncryptedStore {
      file: "days/YYYY-MM-DD.json.enc",
    },
    retention: DAY_RETENTION,
    fields: &[
      field("start", "Where the assigned stretch starts.", Leaves::Never),
      field("end", "Where it ends.", Leaves::Never),
      field(
        "matterId",
        "The matter the member assigned it to.",
        Leaves::CopiedFromServer,
      ),
      field(
        "matter.id",
        "The matter's id, kept to show the assignment.",
        Leaves::CopiedFromServer,
      ),
      field(
        "matter.name",
        "The matter's name.",
        Leaves::CopiedFromServer,
      ),
      field(
        "matter.reference",
        "The matter's reference, if any.",
        Leaves::CopiedFromServer,
      ),
      field(
        "matter.color",
        "The matter's color, if any.",
        Leaves::CopiedFromServer,
      ),
      field(
        "matter.clientName",
        "The matter's client, if any.",
        Leaves::CopiedFromServer,
      ),
    ],
  },
  Record {
    kind: RecordKind::Outage,
    title: "Outage",
    storage: Storage::EncryptedStore {
      file: "outages.json.enc",
    },
    retention: "Kept and deleted with the days it falls on, and never longer than 90 days.",
    fields: &[
      field(
        "start",
        "When a stretch the member wanted recorded, and Activity could not record, started.",
        Leaves::Never,
      ),
      field("end", "When it ended.", Leaves::Never),
      field("reason", "Why Activity could not record.", Leaves::Never),
    ],
  },
  Record {
    kind: RecordKind::MatterLearning,
    title: "Matter learning",
    storage: Storage::EncryptedStore {
      file: "matter-learning.json.enc",
    },
    retention: "Deleted with Delete all history, with the history it was learned from.",
    fields: &[
      field(
        "revision",
        "Advances with every save, so two windows never overwrite each other.",
        Leaves::Never,
      ),
      field(
        "learning.rules",
        "Rules the member made: a title, document path or app that names a matter.",
        Leaves::Never,
      ),
      field(
        "learning.learned",
        "Words from titles and documents weighted towards the matters the member confirmed.",
        Leaves::Never,
      ),
      field(
        "learning.tallies",
        "How often a candidate rule was confirmed or declined.",
        Leaves::Never,
      ),
    ],
  },
  Record {
    kind: RecordKind::CaptureRecord,
    title: "Recording state",
    storage: Storage::PlainAccountRecord,
    retention: "Replaced with each recording choice and server answer. It holds nothing recorded.",
    fields: &[
      field(
        "intent",
        "Whether the member turned recording on, paused it or left it off.",
        Leaves::Never,
      ),
      field(
        "answer.type",
        "The server's last answer about Activity for the account: granted or refused.",
        Leaves::CopiedFromServer,
      ),
      field(
        "answer.confirmedAt",
        "When a grant was confirmed.",
        Leaves::CopiedFromServer,
      ),
      field(
        "answer.expiresAt",
        "When the credential a grant was confirmed with expires.",
        Leaves::CopiedFromServer,
      ),
      field(
        "answer.reason",
        "Why the server refused.",
        Leaves::CopiedFromServer,
      ),
    ],
  },
];

fn instant(seconds: i64) -> DateTime<Utc> {
  DateTime::from_timestamp(seconds, 0).expect("fixture instants are in range")
}

fn app(identifier: &str, name: &str) -> Vec<AppExclusion> {
  vec![AppExclusion::new(identifier, name).expect("fixture apps are valid")]
}

/// A segment with every field set, `call` included: it is left out of the
/// stored record while false.
fn segment_sample() -> ActivitySegment {
  ActivitySegment {
    app_identifier: "com.example.editor".into(),
    app_name: "Example Editor".into(),
    window_title: Some("Draft".into()),
    document: Some("/Matters/Draft.docx".into()),
    matter_id: Some("matter".into()),
    call: true,
    start: instant(0),
    end: instant(60),
  }
}

fn gap_sample() -> ActivityGap {
  ActivityGap {
    start: instant(60),
    end: instant(600),
    ended_by: GapEnd::Input,
    display: GapDisplay::Locked,
  }
}

fn drafted_entry_sample() -> ActivityDraftedEntry {
  ActivityDraftedEntry {
    start: "2026-01-01T00:00:00Z".into(),
    end: "2026-01-01T00:01:00Z".into(),
    entry_id: "entry".into(),
  }
}

fn manual_assignment_sample() -> ActivityManualAssignment {
  ActivityManualAssignment {
    start: "2026-01-01T00:00:00Z".into(),
    end: "2026-01-01T00:01:00Z".into(),
    matter_id: "matter".into(),
    matter: Some(ActivityAssignedMatter {
      id: "matter".into(),
      name: "Matter".into(),
      reference: Some("2026-001".into()),
      color: Some("blue".into()),
      client_name: Some("Client".into()),
    }),
  }
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
  serde_json::to_value(value).expect("activity samples serialize")
}

/// Every shape `kind` is stored in.
fn samples(kind: RecordKind) -> Vec<Value> {
  match kind {
    RecordKind::Settings => vec![to_value(&ActivitySettings {
      recording_status: ActivityRecordingStatus::Recording,
      retention: ActivityRetention::Month,
      excluded_apps: app("com.example.music", "Music"),
      capture_details: true,
      app_name_only_apps: app("com.example.terminal", "Terminal"),
      browser_title_apps: app("com.google.chrome", "Chrome"),
      ignore_calls: true,
      calendar_source: ActivityCalendarSource::Microsoft365,
      extra: std::collections::BTreeMap::new(),
    })],
    RecordKind::Day => crate::activity_store::day_file_data_map_samples(
      vec![segment_sample()],
      vec![gap_sample()],
      vec![manual_assignment_sample()],
      vec![drafted_entry_sample()],
    ),
    RecordKind::Segment => vec![to_value(&segment_sample())],
    RecordKind::Gap => vec![to_value(&gap_sample())],
    RecordKind::DraftedEntry => vec![to_value(&drafted_entry_sample())],
    RecordKind::ManualAssignment => vec![to_value(&manual_assignment_sample())],
    RecordKind::Outage => vec![to_value(&CaptureOutage {
      start: instant(0),
      end: instant(60),
      reason: StopReason::SignedOut,
    })],
    RecordKind::MatterLearning => vec![to_value(&StoredMatterLearning::fixture())],
    RecordKind::CaptureRecord => {
      crate::activity_capture::capture_record_data_map_samples()
    }
  }
}

/// The paths of `value`'s fields: nested objects joined with `.`, every
/// other value (lists included) one field.
fn field_paths(value: &Value, prefix: &str, paths: &mut BTreeSet<String>) {
  let Value::Object(fields) = value else {
    return;
  };
  for (key, child) in fields {
    let path = if prefix.is_empty() {
      key.clone()
    } else {
      format!("{prefix}.{key}")
    };
    if child.is_object() {
      field_paths(child, &path, paths);
    } else {
      paths.insert(path);
    }
  }
}

fn storage_text(storage: Storage) -> String {
  match storage {
    Storage::EncryptedStore { file } => format!(
      "This computer, encrypted: `{file}` in the account's Activity store, sealed with the account's own key from the system keychain."
    ),
    Storage::PlainAccountRecord => {
      "This computer, in a small plain file per account that only the account's user can read.".to_string()
    }
  }
}

fn leaves_text(leaves: Leaves) -> &'static str {
  match leaves {
    Leaves::Never => "Never",
    Leaves::InAiDraftRequest => {
      "Only in a stella AI draft request the member asks for, once allowed"
    }
    Leaves::AsConfirmedTimeEntries => {
      "When the member confirms time entries, as those entries"
    }
    Leaves::CopiedFromServer => "Never: a copy of what the stella server sent",
  }
}

/// What the page says before the records, one paragraph each.
const INTRO: [&str; 3] = [
  "Every field Activity stores, where it is kept, whether and when it leaves the computer, and how long it stays. Nothing else is recorded: no keystrokes or typed text, no screen contents, no microphone sound and no website addresses.",
  "Two things leave the computer, both only on the member's action: the time entries they confirm, which carry the matter, date, duration, description, billable status and any billing codes, and the stella AI draft requests they ask for once they allowed drafts. Neither carries an app identifier or a document path. Activity sends no recorded data in telemetry or logs.",
  "Deleting: Delete day and Delete all history in Settings remove recorded days; excluding an app can delete its past stretches; the history of another account on the computer is deleted from Settings as a whole.",
];

fn render_page() -> String {
  let mut page = String::from(GENERATED_HEADER);
  page.push_str("\n# Activity data map\n");
  for paragraph in INTRO {
    page.push('\n');
    page.push_str(paragraph);
    page.push('\n');
  }
  for record in &RECORDS {
    page.push_str(&format!("\n## {}\n\n", record.title));
    page.push_str(&format!("- Kept: {}\n", storage_text(record.storage)));
    page.push_str(&format!("- Retention: {}\n\n", record.retention));
    page.push_str("| Field | What it holds | Leaves this computer |\n");
    page.push_str("| --- | --- | --- |\n");
    for field in record.fields {
      page.push_str(&format!(
        "| `{}` | {} | {} |\n",
        field.path,
        field.holds,
        leaves_text(field.leaves),
      ));
    }
  }
  page
}

#[test]
fn every_record_kind_has_one_record() {
  for kind in RecordKind::ALL {
    let count = RECORDS.iter().filter(|record| record.kind == kind).count();
    assert_eq!(count, 1, "{kind:?}");
  }
}

#[test]
fn every_stored_field_has_exactly_one_row() {
  for record in &RECORDS {
    let mut stored = BTreeSet::new();
    for sample in samples(record.kind) {
      field_paths(&sample, "", &mut stored);
    }
    let rows = record
      .fields
      .iter()
      .map(|field| field.path.to_string())
      .collect::<Vec<_>>();
    let mapped = rows.iter().cloned().collect::<BTreeSet<_>>();
    assert_eq!(
      rows.len(),
      mapped.len(),
      "{}: a field has two rows",
      record.title
    );
    assert_eq!(
      stored, mapped,
      "{}: every stored field needs one row in activity_data_map.rs, and every row a stored field",
      record.title
    );
  }
}

#[test]
fn rows_are_single_table_cells() {
  for record in &RECORDS {
    for field in record.fields {
      for text in [field.path, field.holds] {
        assert!(
          !text.contains(['|', '\n', '`']),
          "{}: {text} must fit one table cell",
          record.title
        );
      }
    }
  }
}

#[test]
fn generated_activity_data_map_is_current() {
  assert_eq!(
    COMMITTED_PAGE,
    render_page(),
    "the Activity data map is stale; run `bun --filter @stll/desktop activity-data-map:generate`",
  );
}

#[test]
#[ignore = "writes the committed Activity data map"]
fn generate_activity_data_map() {
  crate::local_store::write_generated_activity_data_map(&render_page())
    .expect("the generated Activity data map is writable");
}
