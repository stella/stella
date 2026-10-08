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

use crate::activity::{ActivitySegment, ActivitySettings, format_date, parse_date};
use crate::local_store::{EncryptedJsonFile, create_private_dir};

const LABEL: &str = "activity";
const SETTINGS_FILE_NAME: &str = "settings.json.enc";
const DAYS_DIR_NAME: &str = "days";
const DAY_FILE_SUFFIX: &str = ".json.enc";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityDayFile {
  segments: Vec<ActivitySegment>,
}

#[derive(Clone)]
pub struct ActivityStore {
  key: [u8; 32],
  root: PathBuf,
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
    if segments.is_empty() {
      return self.delete_day(date);
    }
    self.ensure_dirs()?;
    self.day_file(date).persist(&ActivityDayFile {
      segments: segments.to_vec(),
    })
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

  /// Sweep every account namespace without loading another account's key or
  /// plaintext. Legacy unnamespaced day files are also eligible for deletion.
  pub fn sweep_namespaces(root: &Path, earliest: NaiveDate) -> Result<usize, String> {
    let mut deleted = Self::delete_days_before_root(root, earliest)?;
    let entries = match fs::read_dir(root) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(deleted),
      Err(error) => {
        return Err(format!("activity namespaces could not be listed: {error}"));
      }
    };
    for entry in entries {
      let entry = entry
        .map_err(|error| format!("activity namespace could not be listed: {error}"))?;
      if entry
        .file_type()
        .map_err(|error| format!("activity namespace type could not be read: {error}"))?
        .is_dir()
      {
        deleted += Self::delete_days_before_root(&entry.path(), earliest)?;
      }
    }
    Ok(deleted)
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
      start: Utc.with_ymd_and_hms(2026, 3, 1, 9, 0, 0).unwrap(),
      end: Utc.with_ymd_and_hms(2026, 3, 1, 9, 30, 0).unwrap(),
    }
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
  fn namespace_sweep_needs_no_keys_or_settings() {
    let (_, root) = store();
    for namespace in ["a", "b"] {
      let days = root.join(namespace).join(DAYS_DIR_NAME);
      fs::create_dir_all(&days).unwrap();
      fs::write(days.join("2026-03-01.json.enc"), b"unreadable ciphertext").unwrap();
      fs::write(days.join("2026-03-03.json.enc"), b"unreadable ciphertext").unwrap();
    }
    assert_eq!(ActivityStore::sweep_namespaces(&root, date(2)).unwrap(), 2);
    for namespace in ["a", "b"] {
      assert!(
        !root
          .join(namespace)
          .join("days/2026-03-01.json.enc")
          .exists()
      );
      assert!(
        root
          .join(namespace)
          .join("days/2026-03-03.json.enc")
          .exists()
      );
    }
    ActivityStore::remove(&root).unwrap();
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
