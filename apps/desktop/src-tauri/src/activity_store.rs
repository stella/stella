//! Encrypted activity storage: one file per local day plus the settings.
//!
//! Each day is its own envelope, bound to its date through the associated
//! data, so a flush rewrites one small file and retention deletes whole
//! files. Layout under the store root:
//!
//! - `settings.json.enc`
//! - `days/YYYY-MM-DD.json.enc`

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::{
  fs,
  path::{Path, PathBuf},
};

use crate::activity::{
  ActivityDraftedEntry, ActivityManualAssignment, ActivityPendingBatch,
  ActivitySegment, ActivitySettings, format_date, parse_date,
};
use crate::local_store::{EncryptedJsonFile, create_private_dir};

const LABEL: &str = "activity";
const SETTINGS_FILE_NAME: &str = "settings.json.enc";
const DAYS_DIR_NAME: &str = "days";
const DAY_FILE_SUFFIX: &str = ".json.enc";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityDayFile {
  segments: Vec<ActivitySegment>,
  #[serde(default)]
  drafted_entries: Vec<ActivityDraftedEntry>,
  #[serde(default)]
  manual_assignments: Vec<ActivityManualAssignment>,
  #[serde(default)]
  pending_batch: Option<ActivityPendingBatch>,
}

#[derive(Clone)]
pub struct ActivityStore {
  key: [u8; 32],
  root: PathBuf,
}

struct OtherAccountHistoryFiles {
  day_count: usize,
  paths: Vec<PathBuf>,
}

impl ActivityStore {
  pub fn new(key: [u8; 32], root: PathBuf) -> Self {
    Self { key, root }
  }

  pub fn root(&self) -> &Path {
    &self.root
  }

  /// Local dates can change between sessions; the recording boundary belongs
  /// to the account's entire retained history, not its current local day.
  pub fn recorded_until(&self) -> Result<Option<DateTime<Utc>>, String> {
    let mut latest = None;
    for date in self.day_dates()? {
      for segment in self.load_day(date)? {
        latest =
          Some(latest.map_or(segment.end, |end: DateTime<Utc>| end.max(segment.end)));
      }
    }
    Ok(latest)
  }

  /// Whether anything encrypted under the store key exists. Leftover
  /// temporary files count: they were written under that key too.
  pub fn has_data(root: &Path) -> bool {
    fs::read_dir(root).is_ok_and(|mut entries| entries.next().is_some())
  }

  fn days_dir(&self) -> PathBuf {
    self.root.join(DAYS_DIR_NAME)
  }

  fn settings_file(&self) -> EncryptedJsonFile {
    EncryptedJsonFile::new(self.key, self.root.join(SETTINGS_FILE_NAME), LABEL)
      .with_associated_data("activity:settings")
  }

  fn day_file(&self, date: NaiveDate) -> EncryptedJsonFile {
    let date = format_date(date);
    EncryptedJsonFile::new(
      self.key,
      self.days_dir().join(format!("{date}{DAY_FILE_SUFFIX}")),
      LABEL,
    )
    .with_associated_data(format!("activity:day:{date}"))
  }

  fn ensure_dirs(&self) -> Result<(), String> {
    create_private_dir(&self.days_dir())
      .and_then(|()| create_private_dir(&self.root))
      .map_err(|error| format!("activity store directory failed: {error}"))
  }

  pub fn load_settings(&self) -> Result<Option<ActivitySettings>, String> {
    self.settings_file().load()
  }

  pub fn save_settings(&self, settings: &ActivitySettings) -> Result<(), String> {
    self.ensure_dirs()?;
    self.settings_file().persist(settings)
  }

  pub fn load_day(&self, date: NaiveDate) -> Result<Vec<ActivitySegment>, String> {
    Ok(
      self
        .day_file(date)
        .load::<ActivityDayFile>()?
        .map(|day| day.segments)
        .unwrap_or_default(),
    )
  }

  /// Writes a day; an empty day removes its file.
  pub fn save_day(
    &self,
    date: NaiveDate,
    segments: &[ActivitySegment],
  ) -> Result<(), String> {
    let drafted_entries = self.load_drafted(date)?;
    let manual_assignments = self.load_assignments(date)?;
    let pending_batch = self.load_pending(date)?;
    if segments.is_empty()
      && drafted_entries.is_empty()
      && manual_assignments.is_empty()
      && pending_batch.is_none()
    {
      return self.delete_day(date);
    }
    self.ensure_dirs()?;
    self.day_file(date).persist(&ActivityDayFile {
      segments: segments.to_vec(),
      drafted_entries,
      manual_assignments,
      pending_batch,
    })
  }

  pub fn load_pending(
    &self,
    date: NaiveDate,
  ) -> Result<Option<ActivityPendingBatch>, String> {
    Ok(
      self
        .day_file(date)
        .load::<ActivityDayFile>()?
        .and_then(|day| day.pending_batch),
    )
  }

  pub fn save_pending(
    &self,
    date: NaiveDate,
    pending: Option<&ActivityPendingBatch>,
  ) -> Result<(), String> {
    let mut day =
      self
        .day_file(date)
        .load::<ActivityDayFile>()?
        .unwrap_or(ActivityDayFile {
          segments: Vec::new(),
          drafted_entries: Vec::new(),
          manual_assignments: Vec::new(),
          pending_batch: None,
        });
    day.pending_batch = pending.cloned();
    self.ensure_dirs()?;
    self.day_file(date).persist(&day)
  }

  pub fn finish_batch(
    &self,
    date: NaiveDate,
    entries: &[ActivityDraftedEntry],
  ) -> Result<(), String> {
    let mut day = self
      .day_file(date)
      .load::<ActivityDayFile>()?
      .ok_or("activity day is unavailable")?;
    day.drafted_entries = entries.to_vec();
    day.pending_batch = None;
    self.ensure_dirs()?;
    self.day_file(date).persist(&day)
  }

  pub fn load_assignments(
    &self,
    date: NaiveDate,
  ) -> Result<Vec<ActivityManualAssignment>, String> {
    Ok(
      self
        .day_file(date)
        .load::<ActivityDayFile>()?
        .map(|day| day.manual_assignments)
        .unwrap_or_default(),
    )
  }

  pub fn save_assignments(
    &self,
    date: NaiveDate,
    assignments: &[ActivityManualAssignment],
  ) -> Result<(), String> {
    let mut day =
      self
        .day_file(date)
        .load::<ActivityDayFile>()?
        .unwrap_or(ActivityDayFile {
          segments: Vec::new(),
          drafted_entries: Vec::new(),
          manual_assignments: Vec::new(),
          pending_batch: None,
        });
    day.manual_assignments = assignments.to_vec();
    self.ensure_dirs()?;
    self.day_file(date).persist(&day)
  }

  pub fn load_drafted(
    &self,
    date: NaiveDate,
  ) -> Result<Vec<ActivityDraftedEntry>, String> {
    Ok(
      self
        .day_file(date)
        .load::<ActivityDayFile>()?
        .map(|day| day.drafted_entries)
        .unwrap_or_default(),
    )
  }

  #[cfg(test)]
  pub fn record_drafted(
    &self,
    date: NaiveDate,
    marker: ActivityDraftedEntry,
  ) -> Result<(), String> {
    let mut day =
      self
        .day_file(date)
        .load::<ActivityDayFile>()?
        .unwrap_or(ActivityDayFile {
          segments: Vec::new(),
          drafted_entries: Vec::new(),
          manual_assignments: Vec::new(),
          pending_batch: None,
        });
    if day
      .drafted_entries
      .iter()
      .any(|saved| saved.start == marker.start)
    {
      return Err("activity range already drafted".to_string());
    }
    day.drafted_entries.push(marker);
    self.ensure_dirs()?;
    self.day_file(date).persist(&day)
  }

  pub fn delete_day(&self, date: NaiveDate) -> Result<(), String> {
    remove_file_if_present(self.day_file(date).path())
  }

  /// Every file in the days directory with the date it belongs to; files
  /// that are not day files (interrupted writes) have no date.
  fn day_entries_root(
    root: &Path,
  ) -> Result<Vec<(PathBuf, Option<NaiveDate>)>, String> {
    let entries = match fs::read_dir(root.join(DAYS_DIR_NAME)) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        return Ok(Vec::new());
      }
      Err(error) => return Err(format!("activity days could not be listed: {error}")),
    };
    let mut days = Vec::new();
    for entry in entries {
      let entry =
        entry.map_err(|error| format!("activity days could not be listed: {error}"))?;
      let name = entry.file_name();
      let date = name
        .to_str()
        .and_then(|name| name.strip_suffix(DAY_FILE_SUFFIX))
        .and_then(|date| parse_date(date).ok());
      days.push((entry.path(), date));
    }
    Ok(days)
  }

  /// Deletes the day files before `earliest`, and temporary files left by an
  /// interrupted write. Returns how many day files went.
  pub fn delete_days_before(&self, earliest: NaiveDate) -> Result<usize, String> {
    Self::delete_days_before_root(&self.root, earliest)
  }

  /// Retention never needs the key or readable settings. Unavailable account
  /// settings use the default retention chosen by the caller.
  pub fn delete_days_before_root(
    root: &Path,
    earliest: NaiveDate,
  ) -> Result<usize, String> {
    let mut deleted = 0;
    for (path, date) in Self::day_entries_root(root)? {
      match date {
        Some(date) if date >= earliest => {}
        Some(_) => {
          remove_file_if_present(&path)?;
          deleted += 1;
        }
        None if path.extension().is_some_and(|extension| extension == "tmp") => {
          remove_file_if_present(&path)?;
        }
        None => {}
      }
    }
    Ok(deleted)
  }

  pub fn day_dates(&self) -> Result<Vec<NaiveDate>, String> {
    Ok(
      Self::day_entries_root(&self.root)?
        .into_iter()
        .filter_map(|(_, date)| date)
        .collect(),
    )
  }

  /// Aggregate only: no inactive account's dates, identity, settings, key or
  /// decrypted content are exposed. Reading this count never expires data.
  pub fn other_account_history_days(
    root: &Path,
    current_namespace: &str,
  ) -> Result<usize, String> {
    if !Self::is_account_namespace(current_namespace) {
      return Err("activity account namespace is invalid".to_string());
    }
    Ok(Self::other_account_history_files(root, current_namespace)?.day_count)
  }

  /// Explicitly removes inactive accounts' dated history and interrupted-write
  /// files. Their settings remain; the current account is never included.
  pub fn delete_other_account_history(
    root: &Path,
    current_namespace: &str,
  ) -> Result<(), String> {
    if !Self::is_account_namespace(current_namespace) {
      return Err("activity account namespace is invalid".to_string());
    }
    for path in Self::other_account_history_files(root, current_namespace)?.paths {
      remove_file_if_present(&path)?;
    }
    Ok(())
  }

  fn is_account_namespace(namespace: &str) -> bool {
    namespace.len() == 64 && namespace.bytes().all(|byte| byte.is_ascii_hexdigit())
  }

  fn other_account_history_files(
    root: &Path,
    current_namespace: &str,
  ) -> Result<OtherAccountHistoryFiles, String> {
    let mut history = OtherAccountHistoryFiles {
      day_count: 0,
      paths: Vec::new(),
    };
    let root_type = match fs::symlink_metadata(root) {
      Ok(metadata) => metadata.file_type(),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(history),
      Err(error) => {
        return Err(format!("activity root could not be inspected: {error}"));
      }
    };
    if !root_type.is_dir() {
      return Ok(history);
    }
    let entries = match fs::read_dir(root) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(history),
      Err(error) => {
        return Err(format!("activity namespaces could not be listed: {error}"));
      }
    };
    for entry in entries {
      let entry = entry
        .map_err(|error| format!("activity namespace could not be listed: {error}"))?;
      let name = entry.file_name();
      let Some(namespace) = name.to_str() else {
        continue;
      };
      if namespace == current_namespace || !Self::is_account_namespace(namespace) {
        continue;
      }
      if !entry
        .file_type()
        .map_err(|error| format!("activity namespace type could not be read: {error}"))?
        .is_dir()
      {
        continue;
      }
      let days = entry.path().join(DAYS_DIR_NAME);
      let days_type = match fs::symlink_metadata(&days) {
        Ok(metadata) => metadata.file_type(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
        Err(error) => {
          return Err(format!("activity days could not be inspected: {error}"));
        }
      };
      if !days_type.is_dir() {
        continue;
      }
      let entries = fs::read_dir(days)
        .map_err(|error| format!("activity days could not be listed: {error}"))?;
      for entry in entries {
        let entry = entry
          .map_err(|error| format!("activity day could not be listed: {error}"))?;
        if !entry
          .file_type()
          .map_err(|error| format!("activity day type could not be read: {error}"))?
          .is_file()
        {
          continue;
        }
        let name = entry.file_name();
        if entry
          .path()
          .extension()
          .is_some_and(|extension| extension == "tmp")
        {
          history.paths.push(entry.path());
          continue;
        }
        let Some(date) = name
          .to_str()
          .and_then(|name| name.strip_suffix(DAY_FILE_SUFFIX))
        else {
          continue;
        };
        if parse_date(date).is_ok_and(|parsed| format_date(parsed) == date) {
          history.day_count += 1;
          history.paths.push(entry.path());
        }
      }
    }
    Ok(history)
  }

  pub fn delete_all_days(&self) -> Result<(), String> {
    match fs::remove_dir_all(self.days_dir()) {
      Ok(()) => Ok(()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(error) => Err(format!("activity days could not be deleted: {error}")),
    }
  }

  /// Removes the whole store, settings included.
  pub fn remove(root: &Path) -> Result<(), String> {
    match fs::remove_dir_all(root) {
      Ok(()) => Ok(()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(error) => Err(format!("activity store could not be deleted: {error}")),
    }
  }
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
  match fs::remove_file(path) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(format!("activity file could not be deleted: {error}")),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::{TimeZone, Utc};

  fn store() -> (ActivityStore, PathBuf) {
    let root = std::env::temp_dir()
      .join(format!("stella-activity-store-{}", uuid::Uuid::new_v4()));
    (ActivityStore::new([9; 32], root.clone()), root)
  }

  fn date(day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 3, day).unwrap()
  }

  fn segment(identifier: &str) -> ActivitySegment {
    ActivitySegment {
      app_identifier: identifier.to_string(),
      app_name: "Private App".to_string(),
      window_title: Some("Confidential draft".to_string()),
      document: Some("/private/draft.docx".to_string()),
      matter_id: None,
      start: Utc.with_ymd_and_hms(2026, 3, 1, 9, 0, 0).unwrap(),
      end: Utc.with_ymd_and_hms(2026, 3, 1, 9, 30, 0).unwrap(),
    }
  }

  #[test]
  fn review_state_survives_flush_and_receipts_atomically_clear_pending() {
    let (store, root) = store();
    let day = date(1);
    let range = crate::activity::ActivityRange {
      start: "2026-03-01T09:00:00Z".into(),
      end: "2026-03-01T09:30:00Z".into(),
    };
    let pending = ActivityPendingBatch {
      idempotency_key: "private-retry-key".into(),
      entries: serde_json::json!([{"matterId":"matter"}]),
      ranges: vec![vec![range.clone()]],
    };
    let assignment = ActivityManualAssignment {
      start: range.start.clone(),
      end: range.end.clone(),
      matter_id: "matter".into(),
      matter: Some(crate::activity::ActivityAssignedMatter {
        id: "matter".into(),
        name: "Private matter".into(),
        reference: None,
        color: None,
        client_name: None,
      }),
    };
    store.save_assignments(day, &[assignment.clone()]).unwrap();
    store.save_pending(day, Some(&pending)).unwrap();
    store.save_day(day, &[segment("word")]).unwrap();
    assert_eq!(store.load_pending(day).unwrap(), Some(pending));
    assert_eq!(
      store.load_assignments(day).unwrap(),
      vec![assignment.clone()]
    );
    let ciphertext = fs::read(store.day_file(day).path()).unwrap();
    assert!(
      !ciphertext
        .windows(b"Private matter".len())
        .any(|window| window == b"Private matter")
    );
    let marker = ActivityDraftedEntry {
      start: range.start,
      end: range.end,
      entry_id: "entry".into(),
    };
    store.finish_batch(day, &[marker.clone()]).unwrap();
    assert!(store.load_pending(day).unwrap().is_none());
    assert_eq!(store.load_drafted(day).unwrap(), vec![marker]);
    assert_eq!(store.load_assignments(day).unwrap(), vec![assignment]);
    assert_eq!(store.load_day(day).unwrap(), vec![segment("word")]);
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn draft_markers_survive_segment_flushes_and_stay_in_their_day_and_account() {
    let (store_a, root_a) = store();
    let (store_b, root_b) = store();
    let day = date(7);
    store_a.save_day(day, &[segment("app")]).unwrap();
    store_a
      .record_drafted(
        day,
        ActivityDraftedEntry {
          start: "2026-10-07T08:00:00Z".into(),
          end: "2026-10-07T08:12:00Z".into(),
          entry_id: "entry_a".into(),
        },
      )
      .unwrap();
    store_a.save_day(day, &[segment("app_updated")]).unwrap();
    assert_eq!(store_a.load_drafted(day).unwrap()[0].entry_id, "entry_a");
    assert!(store_a.load_drafted(date(8)).unwrap().is_empty());
    assert!(store_b.load_drafted(day).unwrap().is_empty());
    let restored = ActivityStore::new(store_a.key, root_a.clone());
    assert_eq!(restored.load_drafted(day).unwrap()[0].entry_id, "entry_a");
    store_a.delete_day(day).unwrap();
    assert!(store_a.load_drafted(day).unwrap().is_empty());
    let _ = fs::remove_dir_all(root_a);
    let _ = fs::remove_dir_all(root_b);
  }

  #[test]
  fn days_round_trip_encrypted_and_bound_to_their_date() {
    let (store, root) = store();
    store
      .save_day(date(1), &[segment("com.example.private")])
      .unwrap();

    let path = store.day_file(date(1)).path().to_path_buf();
    let raw = fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("com.example.private"));
    assert!(!raw.contains("Private App"));
    assert!(!raw.contains("Confidential draft"));
    assert!(!raw.contains("/private/draft.docx"));
    assert_eq!(
      store.load_day(date(1)).unwrap(),
      [segment("com.example.private")]
    );

    // A day file moved to another date does not read as that date.
    fs::rename(&path, store.day_file(date(2)).path()).unwrap();
    assert!(store.load_day(date(2)).is_err());
    assert!(store.load_day(date(1)).unwrap().is_empty());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn encrypted_files_without_detail_fields_keep_default_off_consent_and_load_days() {
    let (store, root) = store();
    store.ensure_dirs().unwrap();
    store
      .settings_file()
      .persist(&serde_json::json!({
        "recordingStatus": "recording",
        "retention": "month",
        "excludedApps": [],
      }))
      .unwrap();
    let original = segment("word");
    store
      .day_file(date(1))
      .persist(&serde_json::json!({ "segments": [{
        "appIdentifier": original.app_identifier,
        "appName": original.app_name,
        "start": original.start,
        "end": original.end,
      }]}))
      .unwrap();
    let settings = store.load_settings().unwrap().unwrap();
    assert!(!settings.capture_details);
    assert!(settings.app_name_only_apps.is_empty());
    assert!(settings.browser_title_apps.is_empty());
    let recorded = store.load_day(date(1)).unwrap();
    assert_eq!(recorded.len(), 1);
    assert!(recorded[0].window_title.is_none());
    assert!(recorded[0].document.is_none());
    assert_eq!(recorded[0].start, original.start);
    assert_eq!(recorded[0].end, original.end);
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn retention_deletes_only_older_days_and_stray_temporaries() {
    let (store, root) = store();
    for day in [1, 2, 3] {
      store.save_day(date(day), &[segment("app")]).unwrap();
    }
    let temporary = store.days_dir().join("2026-03-03.json.123.abc.tmp");
    fs::write(&temporary, b"partial").unwrap();

    assert_eq!(store.delete_days_before(date(2)).unwrap(), 1);
    assert!(store.load_day(date(1)).unwrap().is_empty());
    assert_eq!(store.load_day(date(2)).unwrap().len(), 1);
    assert!(!temporary.exists());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn invalid_current_namespaces_cannot_count_or_delete_any_account_history() {
    let (_, root) = store();
    let current = "a".repeat(64);
    let inactive = "b".repeat(64);
    for namespace in [&current, &inactive] {
      let days = root.join(namespace).join(DAYS_DIR_NAME);
      fs::create_dir_all(&days).unwrap();
      fs::write(days.join("2020-01-01.json.enc"), b"preserved ciphertext").unwrap();
      fs::write(
        days.join("interrupted.tmp"),
        b"preserved partial ciphertext",
      )
      .unwrap();
    }
    for invalid in [
      String::new(),
      "not-a-hash".to_string(),
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      format!("../{}", "a".repeat(61)),
    ] {
      assert_eq!(
        ActivityStore::other_account_history_days(&root, &invalid).unwrap_err(),
        "activity account namespace is invalid"
      );
      assert_eq!(
        ActivityStore::delete_other_account_history(&root, &invalid).unwrap_err(),
        "activity account namespace is invalid"
      );
      for namespace in [&current, &inactive] {
        let days = root.join(namespace).join(DAYS_DIR_NAME);
        assert_eq!(
          fs::read(days.join("2020-01-01.json.enc")).unwrap(),
          b"preserved ciphertext"
        );
        assert_eq!(
          fs::read(days.join("interrupted.tmp")).unwrap(),
          b"preserved partial ciphertext"
        );
      }
    }
    assert_eq!(
      ActivityStore::other_account_history_days(&root, &current).unwrap(),
      1
    );
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn inactive_history_count_and_explicit_deletion_need_no_keys_or_settings() {
    let (_, root) = store();
    let current = "a".repeat(64);
    let inactive = "b".repeat(64);
    // An older origin-derived namespace is still an inactive account's data.
    let old_origin_namespace = "c".repeat(64);
    let non_hex = "g".repeat(64);
    let short = "d".repeat(63);
    let long = "e".repeat(65);
    assert_eq!(
      ActivityStore::other_account_history_days(&root, &current).unwrap(),
      0
    );
    ActivityStore::delete_other_account_history(&root, &current).unwrap();
    for namespace in [
      &current,
      &inactive,
      &old_origin_namespace,
      &non_hex,
      &short,
      &long,
      &"unrelated".to_string(),
      &DAYS_DIR_NAME.to_string(),
    ] {
      let days = root.join(namespace).join(DAYS_DIR_NAME);
      fs::create_dir_all(&days).unwrap();
      fs::write(
        root.join(namespace).join(SETTINGS_FILE_NAME),
        b"unreadable settings",
      )
      .unwrap();
      fs::write(days.join("2020-01-01.json.enc"), b"unreadable ciphertext").unwrap();
      fs::write(days.join("2026-03-03.json.enc"), b"unreadable ciphertext").unwrap();
      fs::write(days.join("2026-03-03.json.123.tmp"), b"partial").unwrap();
      fs::write(days.join("2026-99-99.json.enc"), b"not a day").unwrap();
      fs::write(days.join("2026-3-1.json.enc"), b"not canonical").unwrap();
      fs::create_dir(days.join("2026-03-04.json.enc")).unwrap();
    }
    for _ in 0..2 {
      assert_eq!(
        ActivityStore::other_account_history_days(&root, &current).unwrap(),
        4
      );
      // Merely inspecting history never applies retention to inactive accounts.
      assert!(
        root
          .join(&inactive)
          .join("days/2020-01-01.json.enc")
          .exists()
      );
      assert!(
        root
          .join(&old_origin_namespace)
          .join("days/2020-01-01.json.enc")
          .exists()
      );
      assert!(
        root
          .join(&inactive)
          .join("days/2026-03-03.json.123.tmp")
          .exists()
      );
    }
    ActivityStore::delete_other_account_history(&root, &current).unwrap();
    assert_eq!(
      ActivityStore::other_account_history_days(&root, &current).unwrap(),
      0
    );
    ActivityStore::delete_other_account_history(&root, &current).unwrap();
    for namespace in [&inactive, &old_origin_namespace] {
      assert!(
        !root
          .join(namespace)
          .join("days/2020-01-01.json.enc")
          .exists()
      );
      assert!(
        !root
          .join(namespace)
          .join("days/2026-03-03.json.enc")
          .exists()
      );
      assert_eq!(
        fs::read(root.join(namespace).join(SETTINGS_FILE_NAME)).unwrap(),
        b"unreadable settings"
      );
      assert!(
        !root
          .join(namespace)
          .join("days/2026-03-03.json.123.tmp")
          .exists()
      );
      for retained in [
        "2026-99-99.json.enc",
        "2026-3-1.json.enc",
        "2026-03-04.json.enc",
      ] {
        assert!(
          root
            .join(namespace)
            .join(DAYS_DIR_NAME)
            .join(retained)
            .exists()
        );
      }
    }
    for namespace in [
      &current,
      &non_hex,
      &short,
      &long,
      &"unrelated".to_string(),
      &DAYS_DIR_NAME.to_string(),
    ] {
      assert_eq!(
        fs::read(root.join(namespace).join("days/2020-01-01.json.enc")).unwrap(),
        b"unreadable ciphertext"
      );
      assert_eq!(
        fs::read(root.join(namespace).join("days/2026-03-03.json.enc")).unwrap(),
        b"unreadable ciphertext"
      );
    }
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  #[cfg(unix)]
  fn inactive_history_operations_ignore_symlinks_at_every_directory_level() {
    use std::os::unix::fs::symlink;
    let (_, root) = store();
    let (_, outside) = store();
    let outside_days = outside.join(DAYS_DIR_NAME);
    fs::create_dir_all(&outside_days).unwrap();
    let outside_file = outside_days.join("2020-01-01.json.enc");
    fs::write(&outside_file, b"preserved").unwrap();
    fs::create_dir_all(&root).unwrap();
    symlink(&outside, root.join("a".repeat(64))).unwrap();
    let days_link_namespace = root.join("b".repeat(64));
    fs::create_dir(&days_link_namespace).unwrap();
    symlink(&outside_days, days_link_namespace.join(DAYS_DIR_NAME)).unwrap();
    let days = root.join("c".repeat(64)).join(DAYS_DIR_NAME);
    fs::create_dir_all(&days).unwrap();
    let linked_file = days.join("2020-01-01.json.enc");
    symlink(&outside_file, &linked_file).unwrap();
    let linked_temp = days.join("interrupted.tmp");
    symlink(&outside_file, &linked_temp).unwrap();
    fs::write(days.join("2026-03-03.json.enc"), b"inactive").unwrap();
    let current = "f".repeat(64);
    assert_eq!(
      ActivityStore::other_account_history_days(&root, &current).unwrap(),
      1
    );
    ActivityStore::delete_other_account_history(&root, &current).unwrap();
    assert_eq!(
      ActivityStore::other_account_history_days(&root, &current).unwrap(),
      0
    );
    assert_eq!(fs::read(&outside_file).unwrap(), b"preserved");
    assert!(
      fs::symlink_metadata(&linked_file)
        .unwrap()
        .file_type()
        .is_symlink()
    );
    assert!(
      fs::symlink_metadata(&linked_temp)
        .unwrap()
        .file_type()
        .is_symlink()
    );
    let root_link = root.with_extension("link");
    symlink(&root, &root_link).unwrap();
    assert_eq!(
      ActivityStore::other_account_history_days(&root_link, &current).unwrap(),
      0
    );
    ActivityStore::delete_other_account_history(&root_link, &current).unwrap();
    fs::remove_file(root_link).unwrap();
    ActivityStore::remove(&root).unwrap();
    ActivityStore::remove(&outside).unwrap();
  }

  #[test]
  fn saving_an_empty_day_removes_it() {
    let (store, root) = store();
    store.save_day(date(1), &[segment("app")]).unwrap();
    store.save_day(date(1), &[]).unwrap();
    assert!(!store.day_file(date(1)).path().exists());
    assert!(ActivityStore::has_data(&root));
    store.delete_all_days().unwrap();
    ActivityStore::remove(&root).unwrap();
    assert!(!ActivityStore::has_data(&root));
  }
}
