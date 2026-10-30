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
  collections::BTreeMap,
  fs,
  path::{Path, PathBuf},
};

use crate::activity::{
  ActivityDeletionError, ActivityDeletionRecovery, ActivityDraftedEntry,
  ActivityManualAssignment, ActivityOtherHistoryRecovery, ActivityPendingBatch,
  ActivitySegment, ActivitySettings, format_date, parse_date,
};
use crate::keychain::{self, LocalDataKey, LocalDataKeyLookup};
use crate::local_store::{EncryptedJsonFile, EncryptedReadError, create_private_dir};

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
  #[serde(flatten)]
  extra: BTreeMap<String, serde_json::Value>,
}

enum PendingMutation<'a> {
  Preserve,
  Reserve(&'a ActivityPendingBatch),
  Cancel(&'a str),
  Finish(&'a [ActivityDraftedEntry]),
}

#[derive(Clone)]
pub struct ActivityStore {
  key: [u8; 32],
  root: PathBuf,
}

enum InactiveAccountKey {
  Found(ActivityStore),
  Missing(PathBuf),
}

struct OtherAccountHistoryFiles {
  day_count: usize,
  paths: Vec<PathBuf>,
}

#[derive(Clone, Copy)]
enum ActivityRecoveryFile {
  Settings,
  Day(NaiveDate),
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
  pub fn recorded_until(
    &self,
    earliest: NaiveDate,
  ) -> Result<Option<DateTime<Utc>>, EncryptedReadError> {
    let mut latest = None;
    let mut failure = None;
    for date in self.day_dates().map_err(EncryptedReadError::Unavailable)? {
      let day = match self.day_file(date).load_checked::<ActivityDayFile>() {
        Ok(Some(day)) => day,
        Ok(None) => continue,
        Err(EncryptedReadError::Unreadable(_)) if date < earliest => continue,
        Err(error) => {
          let priority = |error: &EncryptedReadError| match error {
            EncryptedReadError::Incompatible(_) => 3,
            EncryptedReadError::Unavailable(_) => 2,
            EncryptedReadError::Unreadable(_) => 1,
          };
          if failure
            .as_ref()
            .is_none_or(|previous| priority(&error) > priority(previous))
          {
            failure = Some(error);
          }
          continue;
        }
      };
      for segment in day.segments {
        latest =
          Some(latest.map_or(segment.end, |end: DateTime<Utc>| end.max(segment.end)));
      }
    }
    match failure {
      Some(error) => Err(error),
      None => Ok(latest),
    }
  }

  pub(crate) fn check_root_envelope_compatibility(
    root: &Path,
  ) -> Result<(), EncryptedReadError> {
    let mut paths = Vec::new();
    match fs::read_dir(root) {
      Ok(entries) => {
        for entry in entries {
          let entry = entry.map_err(|error| {
            EncryptedReadError::Unavailable(format!(
              "activity files could not be listed: {error}"
            ))
          })?;
          if !entry
            .file_type()
            .map_err(|error| {
              EncryptedReadError::Unavailable(format!(
                "activity file type could not be read: {error}"
              ))
            })?
            .is_file()
          {
            continue;
          }
          if entry.file_name() != DAYS_DIR_NAME
            && entry
              .path()
              .extension()
              .is_none_or(|extension| extension != "tmp")
          {
            paths.push(entry.path());
          }
        }
      }
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => {
        return Err(EncryptedReadError::Unavailable(format!(
          "activity files could not be listed: {error}"
        )));
      }
    }
    paths.extend(
      Self::day_entries_root(root)
        .map_err(EncryptedReadError::Unavailable)?
        .into_iter()
        .map(|(path, _)| path)
        .filter(|path| path.extension().is_none_or(|extension| extension != "tmp")),
    );
    let mut unavailable = None;
    for path in paths {
      match crate::local_store::check_envelope_compatibility(&path, LABEL) {
        Ok(()) | Err(EncryptedReadError::Unreadable(_)) => {}
        Err(error @ EncryptedReadError::Incompatible(_)) => return Err(error),
        Err(EncryptedReadError::Unavailable(message)) => unavailable = Some(message),
      }
    }
    match unavailable {
      Some(message) => Err(EncryptedReadError::Unavailable(message)),
      None => Ok(()),
    }
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

  pub fn load_settings_checked(
    &self,
  ) -> Result<Option<ActivitySettings>, EncryptedReadError> {
    match fs::symlink_metadata(self.settings_file().path()) {
      Ok(metadata) if metadata.file_type().is_symlink() => {
        return Err(EncryptedReadError::Unavailable(
          "activity settings path is a symbolic link".into(),
        ));
      }
      Ok(_) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
      Err(error) => {
        return Err(EncryptedReadError::Unavailable(format!(
          "activity settings could not be inspected: {error}"
        )));
      }
    }
    self.settings_file().load_checked()
  }

  pub fn save_settings(&self, settings: &ActivitySettings) -> Result<(), String> {
    let saved = self
      .load_settings_checked()
      .map_err(|error| error.to_string())?;
    let mut settings = settings.clone();
    if let Some(saved) = saved {
      for (key, value) in saved.extra {
        settings.extra.entry(key).or_insert(value);
      }
    }
    self.ensure_dirs()?;
    self.settings_file().persist(&settings)
  }

  fn load_inactive_settings_checked(
    &self,
  ) -> Result<Option<ActivitySettings>, EncryptedReadError> {
    match fs::symlink_metadata(self.settings_file().path()) {
      Ok(metadata) if metadata.file_type().is_symlink() => Ok(None),
      Ok(_) => self.load_settings_checked(),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
      Err(error) => Err(EncryptedReadError::Unavailable(format!(
        "activity settings could not be inspected: {error}"
      ))),
    }
  }

  pub fn load_day(&self, date: NaiveDate) -> Result<Vec<ActivitySegment>, String> {
    self
      .load_day_checked(date)
      .map_err(|error| error.to_string())
  }

  pub fn load_day_checked(
    &self,
    date: NaiveDate,
  ) -> Result<Vec<ActivitySegment>, EncryptedReadError> {
    Ok(
      self
        .day_file(date)
        .load_checked::<ActivityDayFile>()?
        .map(|day| day.segments)
        .unwrap_or_default(),
    )
  }

  fn mutate_day(
    &self,
    date: NaiveDate,
    pending: PendingMutation<'_>,
    update: impl FnOnce(&mut ActivityDayFile),
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
          extra: BTreeMap::new(),
        });
    let saved_pending = day.pending_batch.clone();
    update(&mut day);
    day.pending_batch = match pending {
      PendingMutation::Preserve => saved_pending,
      PendingMutation::Reserve(pending) => {
        if saved_pending.as_ref().is_some_and(|saved| saved != pending) {
          return Err("another activity batch is pending".into());
        }
        Some(pending.clone())
      }
      PendingMutation::Cancel(key) => {
        if saved_pending
          .as_ref()
          .is_none_or(|saved| saved.idempotency_key != key)
        {
          return Err("activity batch key does not match".into());
        }
        None
      }
      PendingMutation::Finish(entries) => {
        let saved = saved_pending
          .as_ref()
          .ok_or("activity batch is not pending")?;
        let ranges: Vec<_> = saved.ranges.iter().flatten().collect();
        if !entries.starts_with(&day.drafted_entries) {
          return Err("activity batch receipts do not match".into());
        }
        let markers = &entries[day.drafted_entries.len()..];
        if markers.len() != ranges.len()
          || markers.iter().zip(ranges).any(|(marker, range)| {
            marker.start != range.start || marker.end != range.end
          })
        {
          return Err("activity batch receipts do not match".into());
        }
        day.drafted_entries = entries.to_vec();
        None
      }
    };
    if day.segments.is_empty()
      && day.drafted_entries.is_empty()
      && day.manual_assignments.is_empty()
      && day.pending_batch.is_none()
      && day.extra.is_empty()
    {
      return remove_file_if_present(self.day_file(date).path());
    }
    self.ensure_dirs()?;
    self.day_file(date).persist(&day)
  }

  /// Ordinary day rewrites preserve the exact pending batch.
  pub fn save_day(
    &self,
    date: NaiveDate,
    segments: &[ActivitySegment],
  ) -> Result<(), String> {
    self.mutate_day(date, PendingMutation::Preserve, |day| {
      day.segments = segments.to_vec();
    })
  }

  pub fn load_pending(
    &self,
    date: NaiveDate,
  ) -> Result<Option<ActivityPendingBatch>, String> {
    self
      .load_pending_checked(date)
      .map_err(|error| error.to_string())
  }

  pub fn load_pending_checked(
    &self,
    date: NaiveDate,
  ) -> Result<Option<ActivityPendingBatch>, EncryptedReadError> {
    Ok(
      self
        .day_file(date)
        .load_checked::<ActivityDayFile>()?
        .and_then(|day| day.pending_batch),
    )
  }

  pub fn save_pending(
    &self,
    date: NaiveDate,
    pending: &ActivityPendingBatch,
  ) -> Result<(), String> {
    self.mutate_day(date, PendingMutation::Reserve(pending), |_| {})
  }

  pub fn cancel_pending(&self, date: NaiveDate, key: &str) -> Result<(), String> {
    self.mutate_day(date, PendingMutation::Cancel(key), |_| {})
  }

  pub fn finish_batch(
    &self,
    date: NaiveDate,
    entries: &[ActivityDraftedEntry],
  ) -> Result<(), String> {
    self.mutate_day(date, PendingMutation::Finish(entries), |_| {})
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
    self.mutate_day(date, PendingMutation::Preserve, |day| {
      day.manual_assignments = assignments.to_vec();
    })
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
    if self
      .load_drafted(date)?
      .iter()
      .any(|saved| saved.start == marker.start)
    {
      return Err("activity range already drafted".into());
    }
    self.mutate_day(date, PendingMutation::Preserve, |day| {
      day.drafted_entries.push(marker);
    })
  }

  pub fn delete_day(&self, date: NaiveDate) -> Result<(), ActivityDeletionError> {
    if self
      .load_pending_checked(date)
      .map_err(ActivityDeletionError::from)?
      .is_some()
    {
      return Err(ActivityDeletionError::PendingBatch);
    }
    remove_file_if_present(self.day_file(date).path())
      .map_err(ActivityDeletionError::Unavailable)
  }

  pub fn pending_dates(
    &self,
    earliest: NaiveDate,
  ) -> Result<Vec<NaiveDate>, EncryptedReadError> {
    let mut pending = Vec::new();
    for date in self.day_dates().map_err(EncryptedReadError::Unavailable)? {
      match self.day_file(date).load_checked::<ActivityDayFile>() {
        Ok(Some(day)) if day.pending_batch.is_some() => pending.push(date),
        Ok(_) => {}
        Err(EncryptedReadError::Unreadable(_)) if date < earliest => {}
        Err(error) => return Err(error),
      }
    }
    Ok(pending)
  }

  /// Every file in the days directory with the date it belongs to; files
  /// with unrecognized names have no date; only temporary writes may be removed.
  fn day_entries_root(
    root: &Path,
  ) -> Result<Vec<(PathBuf, Option<NaiveDate>)>, String> {
    match fs::symlink_metadata(root.join(DAYS_DIR_NAME)) {
      Ok(metadata) if metadata.file_type().is_symlink() => return Ok(Vec::new()),
      Ok(_) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        return Ok(Vec::new());
      }
      Err(error) => {
        return Err(format!("activity days could not be inspected: {error}"));
      }
    }
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
      if entry
        .file_type()
        .map_err(|error| format!("activity day type could not be read: {error}"))?
        .is_symlink()
      {
        continue;
      }
      let name = entry.file_name();
      let date = name
        .to_str()
        .and_then(|name| name.strip_suffix(DAY_FILE_SUFFIX))
        .and_then(|date| parse_date(date).ok());
      days.push((entry.path(), date));
    }
    Ok(days)
  }

  /// Retention preserves unresolved batches; only settled days expire.
  pub fn delete_days_before(&self, earliest: NaiveDate) -> Result<usize, String> {
    let mut deleted = 0;
    let mut unreadable_days = 0;
    for (path, date) in Self::day_entries_root(&self.root)? {
      match date {
        Some(date) if date < earliest => match self.load_pending_checked(date) {
          Ok(None) => {
            self.delete_day(date).map_err(|error| error.to_string())?;
            deleted += 1;
          }
          Ok(Some(_)) => {}
          Err(
            EncryptedReadError::Unreadable(_) | EncryptedReadError::Incompatible(_),
          ) => unreadable_days += 1,
          Err(EncryptedReadError::Unavailable(message)) => return Err(message),
        },
        None if path.extension().is_some_and(|extension| extension == "tmp") => {
          remove_file_if_present(&path)?;
        }
        _ => {}
      }
    }
    if unreadable_days > 0 {
      tracing::warn!("activity retention preserved unreadable day files");
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

  /// Preflight and recheck all inactive history before removing any files.
  pub fn delete_other_account_history(
    root: &Path,
    current_namespace: &str,
    recovery: ActivityOtherHistoryRecovery,
  ) -> Result<(), ActivityDeletionError> {
    Self::delete_other_account_history_with_key_lookup(
      root,
      current_namespace,
      recovery,
      |namespace| {
        keychain::get_local_data_key(LocalDataKey::ActivityTimeline(namespace))
      },
    )
  }

  fn delete_other_account_history_with_key_lookup(
    root: &Path,
    current_namespace: &str,
    recovery: ActivityOtherHistoryRecovery,
    mut lookup: impl FnMut(&str) -> Result<LocalDataKeyLookup, String>,
  ) -> Result<(), ActivityDeletionError> {
    if !Self::is_account_namespace(current_namespace) {
      return Err(ActivityDeletionError::Unavailable(
        "activity account namespace is invalid".into(),
      ));
    }
    match fs::symlink_metadata(root) {
      Ok(metadata) if metadata.file_type().is_symlink() => return Ok(()),
      Ok(_) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
      Err(error) => {
        return Err(ActivityDeletionError::Unavailable(format!(
          "activity history could not be inspected: {error}"
        )));
      }
    }
    let history = Self::other_account_history_files(root, current_namespace)
      .map_err(ActivityDeletionError::Unavailable)?;
    let mut stores = BTreeMap::new();
    let entries = match fs::read_dir(root) {
      Ok(entries) => Some(entries),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
      Err(error) => {
        return Err(ActivityDeletionError::Unavailable(format!(
          "activity accounts could not be listed: {error}"
        )));
      }
    };
    if let Some(entries) = entries {
      for entry in entries {
        let entry = entry.map_err(|error| {
          ActivityDeletionError::Unavailable(format!(
            "activity account could not be listed: {error}"
          ))
        })?;
        let name = entry.file_name();
        let Some(namespace) = name.to_str() else {
          continue;
        };
        if namespace == current_namespace
          || !Self::is_account_namespace(namespace)
          || !entry
            .file_type()
            .map_err(|error| {
              ActivityDeletionError::Unavailable(format!(
                "activity account type could not be read: {error}"
              ))
            })?
            .is_dir()
        {
          continue;
        }
        let settings = entry.path().join(SETTINGS_FILE_NAME);
        let has_settings = match fs::symlink_metadata(&settings) {
          Ok(metadata) => !metadata.file_type().is_symlink(),
          Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
          Err(error) => {
            return Err(ActivityDeletionError::Unavailable(format!(
              "activity settings could not be inspected: {error}"
            )));
          }
        };
        if !has_settings {
          continue;
        }
        let account =
          match lookup(namespace).map_err(ActivityDeletionError::Unavailable)? {
            LocalDataKeyLookup::Found(key) => {
              InactiveAccountKey::Found(Self::new(key, entry.path()))
            }
            LocalDataKeyLookup::Missing => {
              Self::check_root_envelope_compatibility(&entry.path())
                .map_err(ActivityDeletionError::from)?;
              if recovery != ActivityOtherHistoryRecovery::DiscardUnrecoverable {
                return Err(ActivityDeletionError::KeyMissing);
              }
              InactiveAccountKey::Missing(entry.path())
            }
          };
        stores.insert(namespace.to_owned(), account);
      }
    }
    for path in &history.paths {
      if path.extension().is_some_and(|extension| extension == "tmp") {
        continue;
      }
      let account_root = path.parent().and_then(Path::parent).ok_or_else(|| {
        ActivityDeletionError::Unavailable("activity history path is invalid".into())
      })?;
      let namespace = account_root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
          ActivityDeletionError::Unavailable(
            "activity account namespace is invalid".into(),
          )
        })?;
      if !stores.contains_key(namespace) {
        let account =
          match lookup(namespace).map_err(ActivityDeletionError::Unavailable)? {
            LocalDataKeyLookup::Found(key) => {
              InactiveAccountKey::Found(Self::new(key, account_root.to_path_buf()))
            }
            LocalDataKeyLookup::Missing => {
              Self::check_root_envelope_compatibility(account_root)
                .map_err(ActivityDeletionError::from)?;
              if recovery != ActivityOtherHistoryRecovery::DiscardUnrecoverable {
                return Err(ActivityDeletionError::KeyMissing);
              }
              InactiveAccountKey::Missing(account_root.to_path_buf())
            }
          };
        stores.insert(namespace.to_string(), account);
      }
    }
    let check_read =
      |result: Result<bool, EncryptedReadError>| -> Result<(), ActivityDeletionError> {
        match result {
          Ok(true) => Err(ActivityDeletionError::PendingBatch),
          Ok(false) => Ok(()),
          Err(EncryptedReadError::Unreadable(_))
            if recovery == ActivityOtherHistoryRecovery::DiscardUnrecoverable =>
          {
            Ok(())
          }
          Err(error) => Err(ActivityDeletionError::from(error)),
        }
      };
    // Two complete read passes ensure key recovery and newly readable pending
    // state are considered before the first removal.
    for _ in 0..2 {
      for (namespace, account) in &stores {
        match (
          account,
          lookup(namespace).map_err(ActivityDeletionError::Unavailable)?,
        ) {
          (InactiveAccountKey::Found(store), LocalDataKeyLookup::Found(key))
            if key == store.key =>
          {
            Self::check_root_envelope_compatibility(store.root())
              .map_err(ActivityDeletionError::from)?;
            check_read(store.load_inactive_settings_checked().map(|_| false))?;
            for date in store
              .day_dates()
              .map_err(ActivityDeletionError::Unavailable)?
            {
              check_read(
                store
                  .load_pending_checked(date)
                  .map(|pending| pending.is_some()),
              )?;
            }
          }
          (InactiveAccountKey::Missing(account_root), LocalDataKeyLookup::Missing) => {
            Self::check_root_envelope_compatibility(account_root)
              .map_err(ActivityDeletionError::from)?;
          }
          _ => {
            return Err(ActivityDeletionError::Unavailable(
              "activity history key changed; review the deletion again".into(),
            ));
          }
        }
      }
    }
    for (namespace, account) in &stores {
      match account {
        InactiveAccountKey::Missing(account_root) => {
          Self::remove_missing_key_with_lookup(
            account_root,
            ActivityDeletionRecovery::DiscardMissingKey,
            || lookup(namespace),
          )?
        }
        InactiveAccountKey::Found(store) => {
          match store.load_inactive_settings_checked() {
            Err(EncryptedReadError::Unreadable(_)) => {
              remove_file_if_present(&store.root.join(SETTINGS_FILE_NAME))
                .map_err(ActivityDeletionError::Unavailable)?;
            }
            Err(error) => return Err(ActivityDeletionError::from(error)),
            Ok(_) => {}
          }
        }
      }
    }
    for path in history.paths {
      remove_file_if_present(&path).map_err(ActivityDeletionError::Unavailable)?;
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

  pub fn delete_all_days(&self) -> Result<(), ActivityDeletionError> {
    Self::check_root_envelope_compatibility(&self.root)
      .map_err(ActivityDeletionError::from)?;
    if !self
      .pending_dates(NaiveDate::MIN)
      .map_err(ActivityDeletionError::from)?
      .is_empty()
    {
      return Err(ActivityDeletionError::PendingBatch);
    }
    match fs::remove_dir_all(self.days_dir()) {
      Ok(()) => Ok(()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(error) => Err(ActivityDeletionError::Unavailable(format!(
        "activity days could not be deleted: {error}"
      ))),
    }
  }

  pub fn remove_missing_key(
    root: &Path,
    namespace: &str,
    recovery: ActivityDeletionRecovery,
  ) -> Result<(), ActivityDeletionError> {
    if !Self::is_account_namespace(namespace) {
      return Err(ActivityDeletionError::Unavailable(
        "activity account namespace is invalid".into(),
      ));
    }
    Self::remove_missing_key_with_lookup(root, recovery, || {
      keychain::get_local_data_key(LocalDataKey::ActivityTimeline(namespace))
    })
  }

  pub(crate) fn remove_unreadable_with_lookup(
    root: &Path,
    recovery: ActivityDeletionRecovery,
    mut lookup: impl FnMut() -> Result<LocalDataKeyLookup, String>,
  ) -> Result<ActivityStore, ActivityDeletionError> {
    if recovery != ActivityDeletionRecovery::DiscardUnreadable {
      return Err(ActivityDeletionError::Unreadable);
    }
    let read_store = |key| ActivityStore::new(key, root.to_path_buf());
    let key = match lookup().map_err(ActivityDeletionError::Unavailable)? {
      LocalDataKeyLookup::Found(key) => key,
      LocalDataKeyLookup::Missing => return Err(ActivityDeletionError::KeyMissing),
    };
    let store = read_store(key);
    let mut unreadable = Vec::new();
    match store.load_settings_checked() {
      Err(EncryptedReadError::Unreadable(_)) => {
        unreadable.push(ActivityRecoveryFile::Settings)
      }
      Err(EncryptedReadError::Incompatible(_)) => {}
      Err(error) => return Err(ActivityDeletionError::from(error)),
      Ok(_) => {}
    }
    for date in store
      .day_dates()
      .map_err(ActivityDeletionError::Unavailable)?
    {
      match store.day_file(date).load_checked::<ActivityDayFile>() {
        Err(EncryptedReadError::Unreadable(_)) => {
          unreadable.push(ActivityRecoveryFile::Day(date))
        }
        Err(EncryptedReadError::Incompatible(_)) => {}
        Err(error) => return Err(ActivityDeletionError::from(error)),
        Ok(_) => {}
      }
    }
    // A key can be restored while the confirmation is open or during preflight.
    let key = match lookup().map_err(ActivityDeletionError::Unavailable)? {
      LocalDataKeyLookup::Found(key) => key,
      LocalDataKeyLookup::Missing => return Err(ActivityDeletionError::KeyMissing),
    };
    let store = read_store(key);
    for file in unreadable {
      let result = match file {
        ActivityRecoveryFile::Settings => store.load_settings_checked().map(|_| ()),
        ActivityRecoveryFile::Day(date) => store
          .day_file(date)
          .load_checked::<ActivityDayFile>()
          .map(|_| ()),
      };
      match result {
        Ok(()) => continue,
        Err(EncryptedReadError::Incompatible(_)) => continue,
        Err(EncryptedReadError::Unavailable(message)) => {
          return Err(ActivityDeletionError::Unavailable(message));
        }
        Err(EncryptedReadError::Unreadable(_)) => {}
      }
      let path = match file {
        ActivityRecoveryFile::Settings => store.settings_file().path().to_path_buf(),
        ActivityRecoveryFile::Day(date) => store.day_file(date).path().to_path_buf(),
      };
      remove_file_if_present(&path).map_err(ActivityDeletionError::Unavailable)?;
    }
    Ok(store)
  }

  fn remove_missing_key_with_lookup(
    root: &Path,
    recovery: ActivityDeletionRecovery,
    lookup: impl FnOnce() -> Result<LocalDataKeyLookup, String>,
  ) -> Result<(), ActivityDeletionError> {
    match lookup().map_err(ActivityDeletionError::Unavailable)? {
      LocalDataKeyLookup::Found(_) => {
        return Err(ActivityDeletionError::Unavailable(
          "activity history key is available; reconnect to recover pending drafts"
            .into(),
        ));
      }
      LocalDataKeyLookup::Missing => {
        Self::check_root_envelope_compatibility(root)
          .map_err(ActivityDeletionError::from)?;
        if recovery != ActivityDeletionRecovery::DiscardMissingKey {
          return Err(ActivityDeletionError::KeyMissing);
        }
      }
    }
    match fs::remove_dir_all(root) {
      Ok(()) => Ok(()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(error) => Err(ActivityDeletionError::Unavailable(format!(
        "activity history could not be deleted: {error}"
      ))),
    }
  }

  /// Test teardown only; product erasure checks pending state or a missing key.
  #[cfg(test)]
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
      call: false,
      start: Utc.with_ymd_and_hms(2026, 3, 1, 9, 0, 0).unwrap(),
      end: Utc.with_ymd_and_hms(2026, 3, 1, 9, 30, 0).unwrap(),
    }
  }

  fn delete_inactive_history(
    root: &Path,
    current: &str,
  ) -> Result<(), ActivityDeletionError> {
    ActivityStore::delete_other_account_history_with_key_lookup(
      root,
      current,
      ActivityOtherHistoryRecovery::Preserve,
      |_| Ok(LocalDataKeyLookup::Found([9; 32])),
    )
  }

  fn pending() -> ActivityPendingBatch {
    let recorded = segment("app");
    ActivityPendingBatch {
      idempotency_key: "review-key".into(),
      entries: serde_json::json!([{"matterId":"matter"}]),
      ranges: vec![vec![crate::activity::ActivityRange {
        start: recorded.start.to_rfc3339(),
        end: recorded.end.to_rfc3339(),
      }]],
    }
  }

  #[test]
  fn empty_segment_rewrites_preserve_exact_pending_recovery() {
    let (store, root) = store();
    let pending = pending();
    store.save_pending(date(1), &pending).unwrap();
    store.save_day(date(1), &[]).unwrap();
    assert_eq!(store.load_pending(date(1)).unwrap(), Some(pending));
    assert!(store.load_day(date(1)).unwrap().is_empty());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn assignment_rewrites_preserve_exact_pending_recovery() {
    let (store, root) = store();
    let pending = pending();
    store.save_pending(date(1), &pending).unwrap();
    store.save_assignments(date(1), &[]).unwrap();
    assert_eq!(store.load_pending(date(1)).unwrap(), Some(pending));
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn pending_day_deletion_is_refused_without_changing_ciphertext() {
    let (store, root) = store();
    store.save_pending(date(1), &pending()).unwrap();
    let before = fs::read(store.day_file(date(1)).path()).unwrap();
    assert_eq!(
      store.delete_day(date(1)),
      Err(ActivityDeletionError::PendingBatch)
    );
    assert_eq!(fs::read(store.day_file(date(1)).path()).unwrap(), before);
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn all_day_deletion_preflights_pending_before_erasing_any_day() {
    let (store, root) = store();
    store.save_day(date(1), &[segment("app")]).unwrap();
    store.save_pending(date(2), &pending()).unwrap();
    assert_eq!(
      store.delete_all_days(),
      Err(ActivityDeletionError::PendingBatch)
    );
    assert_eq!(store.load_day(date(1)).unwrap().len(), 1);
    assert!(store.load_pending(date(2)).unwrap().is_some());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn retention_preserves_pending_days_and_expires_settled_days() {
    let (store, root) = store();
    let pending = pending();
    store.save_pending(date(1), &pending).unwrap();
    store.save_day(date(2), &[segment("app")]).unwrap();
    assert_eq!(store.delete_days_before(date(3)).unwrap(), 1);
    assert_eq!(store.load_pending(date(1)).unwrap(), Some(pending));
    assert!(store.load_day(date(2)).unwrap().is_empty());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn only_matching_cancellation_or_receipts_can_clear_pending_recovery() {
    let (store, root) = store();
    let pending = pending();
    store.save_pending(date(1), &pending).unwrap();
    let mut changed = pending.clone();
    changed.idempotency_key = "different-key".into();
    assert_eq!(
      store.save_pending(date(1), &changed).unwrap_err(),
      "another activity batch is pending"
    );
    assert_eq!(
      store.cancel_pending(date(1), "different-key").unwrap_err(),
      "activity batch key does not match"
    );
    assert_eq!(
      store.finish_batch(date(1), &[]).unwrap_err(),
      "activity batch receipts do not match"
    );
    assert_eq!(store.load_pending(date(1)).unwrap(), Some(pending.clone()));
    store
      .cancel_pending(date(1), &pending.idempotency_key)
      .unwrap();
    assert!(store.load_pending(date(1)).unwrap().is_none());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn inactive_history_preflight_preserves_every_file_when_recovery_is_pending() {
    let (_, root) = store();
    let current = "a".repeat(64);
    let inactive = "b".repeat(64);
    let account = ActivityStore::new([9; 32], root.join(&inactive));
    account.save_day(date(1), &[segment("app")]).unwrap();
    account.save_pending(date(2), &pending()).unwrap();
    let result = ActivityStore::delete_other_account_history_with_key_lookup(
      &root,
      &current,
      ActivityOtherHistoryRecovery::Preserve,
      |_| Ok(LocalDataKeyLookup::Found([9; 32])),
    );
    assert_eq!(result, Err(ActivityDeletionError::PendingBatch));
    assert_eq!(
      ActivityStore::delete_other_account_history_with_key_lookup(
        &root,
        &current,
        ActivityOtherHistoryRecovery::DiscardUnrecoverable,
        |_| Ok(LocalDataKeyLookup::Found([9; 32])),
      ),
      Err(ActivityDeletionError::PendingBatch),
    );
    assert_eq!(account.load_day(date(1)).unwrap().len(), 1);
    assert!(account.load_pending(date(2)).unwrap().is_some());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn inactive_history_preserves_ciphertext_when_its_key_is_unavailable() {
    let (_, root) = store();
    let current = "a".repeat(64);
    let account = ActivityStore::new([9; 32], root.join("b".repeat(64)));
    account.save_pending(date(1), &pending()).unwrap();
    assert_eq!(
      ActivityStore::delete_other_account_history_with_key_lookup(
        &root,
        &current,
        ActivityOtherHistoryRecovery::Preserve,
        |_| Ok(LocalDataKeyLookup::Missing)
      ),
      Err(ActivityDeletionError::KeyMissing)
    );
    assert!(matches!(
      ActivityStore::delete_other_account_history_with_key_lookup(
        &root,
        &current,
        ActivityOtherHistoryRecovery::DiscardUnrecoverable,
        |_| Err("keychain unavailable".into())
      ),
      Err(ActivityDeletionError::Unavailable(_))
    ));
    assert!(account.load_pending(date(1)).unwrap().is_some());
    assert!(matches!(
      ActivityStore::delete_other_account_history_with_key_lookup(
        &root,
        &current,
        ActivityOtherHistoryRecovery::Preserve,
        |_| Ok(LocalDataKeyLookup::Found([8; 32]))
      ),
      Err(ActivityDeletionError::Unreadable)
    ));
    assert!(account.load_pending(date(1)).unwrap().is_some());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn confirmed_missing_key_erasure_removes_unrecoverable_history() {
    let (store, root) = store();
    store.save_pending(date(1), &pending()).unwrap();
    assert_eq!(
      ActivityStore::remove_missing_key_with_lookup(
        &root,
        ActivityDeletionRecovery::Preserve,
        || Ok(LocalDataKeyLookup::Missing),
      ),
      Err(ActivityDeletionError::KeyMissing),
    );
    assert!(store.load_pending(date(1)).unwrap().is_some());
    assert_eq!(
      ActivityStore::remove_missing_key_with_lookup(
        &root,
        ActivityDeletionRecovery::DiscardUnreadable,
        || Ok(LocalDataKeyLookup::Missing)
      ),
      Err(ActivityDeletionError::KeyMissing),
    );
    assert!(store.load_pending(date(1)).unwrap().is_some());
    ActivityStore::remove_missing_key_with_lookup(
      &root,
      ActivityDeletionRecovery::DiscardMissingKey,
      || Ok(LocalDataKeyLookup::Missing),
    )
    .unwrap();
    assert!(!root.exists());
  }

  #[test]
  fn confirmed_erasure_still_refuses_transient_or_recovered_keys() {
    let (store, root) = store();
    store.save_pending(date(1), &pending()).unwrap();
    for lookup in [
      Err("keychain unavailable".into()),
      Ok(LocalDataKeyLookup::Found([9; 32])),
    ] {
      assert!(matches!(
        ActivityStore::remove_missing_key_with_lookup(
          &root,
          ActivityDeletionRecovery::DiscardMissingKey,
          || lookup,
        ),
        Err(ActivityDeletionError::Unavailable(_)),
      ));
      assert!(store.load_pending(date(1)).unwrap().is_some());
    }
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn confirmed_inactive_erasure_removes_only_definitely_missing_key_history() {
    let (_, root) = store();
    let current = "a".repeat(64);
    let inactive_root = root.join("b".repeat(64));
    let account = ActivityStore::new([9; 32], inactive_root.clone());
    account.save_settings(&ActivitySettings::default()).unwrap();
    account.save_pending(date(1), &pending()).unwrap();
    ActivityStore::delete_other_account_history_with_key_lookup(
      &root,
      &current,
      ActivityOtherHistoryRecovery::DiscardUnrecoverable,
      |_| Ok(LocalDataKeyLookup::Missing),
    )
    .unwrap();
    assert!(account.load_pending(date(1)).unwrap().is_none());
    assert!(!inactive_root.exists());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn envelope_version_999_survives_confirmed_missing_key_erasure() {
    let (store, root) = store();
    store.save_pending(date(1), &pending()).unwrap();
    let path = store.day_file(date(1)).path().to_path_buf();
    let original = br#"{"version":999,"futureCiphertext":{"data":"saved"}}"#;
    fs::write(&path, original).unwrap();
    assert!(matches!(
      ActivityStore::remove_missing_key_with_lookup(
        &root,
        ActivityDeletionRecovery::DiscardMissingKey,
        || Ok(LocalDataKeyLookup::Missing)
      ),
      Err(ActivityDeletionError::Incompatible)
    ));
    assert_eq!(fs::read(&path).unwrap(), original);
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn noncanonical_version_999_survives_retention_and_keyed_all_days_erasure() {
    let (store, root) = store();
    store.save_day(date(1), &[segment("app")]).unwrap();
    let path = root.join(DAYS_DIR_NAME).join("future-history.encrypted");
    let original = br#"{"version":999,"futureCiphertext":{"data":"saved"}}"#;
    fs::write(&path, original).unwrap();
    assert_eq!(store.delete_days_before(date(2)).unwrap(), 1);
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(matches!(
      store.delete_all_days(),
      Err(ActivityDeletionError::Incompatible)
    ));
    assert_eq!(fs::read(&path).unwrap(), original);
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn future_root_envelope_survives_confirmed_missing_key_erasure() {
    let (store, root) = store();
    store.save_pending(date(1), &pending()).unwrap();
    let path = root.join("future-store.encrypted");
    let original = br#"{"version":999,"futureCiphertext":{"data":"saved"}}"#;
    fs::write(&path, original).unwrap();
    assert!(matches!(
      ActivityStore::remove_missing_key_with_lookup(
        &root,
        ActivityDeletionRecovery::DiscardMissingKey,
        || Ok(LocalDataKeyLookup::Missing)
      ),
      Err(ActivityDeletionError::Incompatible)
    ));
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(store.day_file(date(1)).path().exists());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn missing_and_noninteger_root_versions_refuse_missing_key_erasure() {
    for envelope in [
      serde_json::json!({"futureCiphertext":"saved"}),
      serde_json::json!({"version":"1"}),
      serde_json::json!({"version":1.5}),
      serde_json::json!({"version":null}),
    ] {
      let (store, root) = store();
      store.save_pending(date(1), &pending()).unwrap();
      let path = root.join("future-store.encrypted");
      let original = serde_json::to_vec(&envelope).unwrap();
      fs::write(&path, &original).unwrap();
      assert!(matches!(
        ActivityStore::remove_missing_key_with_lookup(
          &root,
          ActivityDeletionRecovery::DiscardMissingKey,
          || Ok(LocalDataKeyLookup::Missing)
        ),
        Err(ActivityDeletionError::Incompatible)
      ));
      assert_eq!(fs::read(&path).unwrap(), original);
      assert!(store.day_file(date(1)).path().exists());
      ActivityStore::remove(&root).unwrap();
    }
  }

  #[test]
  fn root_header_scan_ignores_unrelated_directories() {
    let (store, root) = store();
    store.save_pending(date(1), &pending()).unwrap();
    fs::create_dir(root.join("unrelated")).unwrap();
    assert_eq!(
      ActivityStore::check_root_envelope_compatibility(&root),
      Ok(())
    );
    assert_eq!(store.load_pending(date(1)).unwrap(), Some(pending()));
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  #[cfg(unix)]
  fn missing_key_erasure_preserves_linked_file_and_day_directory_targets() {
    use std::os::unix::fs::symlink;
    let (_, root) = store();
    let (outside_store, outside) = store();
    outside_store.save_pending(date(1), &pending()).unwrap();
    let outside_file = outside.join("future-store.encrypted");
    let original = br#"{"version":999,"futureCiphertext":{"data":"saved"}}"#;
    fs::write(&outside_file, original).unwrap();
    let day_path = outside_store.day_file(date(1)).path().to_path_buf();
    let saved_day = fs::read(&day_path).unwrap();
    fs::create_dir(&root).unwrap();
    symlink(&outside_file, root.join("linked.encrypted")).unwrap();
    symlink(outside.join(DAYS_DIR_NAME), root.join(DAYS_DIR_NAME)).unwrap();
    ActivityStore::remove_missing_key_with_lookup(
      &root,
      ActivityDeletionRecovery::DiscardMissingKey,
      || Ok(LocalDataKeyLookup::Missing),
    )
    .unwrap();
    assert!(!root.exists());
    assert_eq!(fs::read(&outside_file).unwrap(), original);
    assert_eq!(fs::read(&day_path).unwrap(), saved_day);
    ActivityStore::remove(&outside).unwrap();
  }

  #[test]
  fn incompatible_missing_key_history_blocks_every_inactive_root_erasure() {
    let (_, root) = store();
    let current = "a".repeat(64);
    let settled = ActivityStore::new([9; 32], root.join("b".repeat(64)));
    settled.save_day(date(1), &[segment("app")]).unwrap();
    let future = ActivityStore::new([9; 32], root.join("c".repeat(64)));
    future.save_pending(date(1), &pending()).unwrap();
    let path = future.day_file(date(1)).path().to_path_buf();
    let original = br#"{"version":999,"futureCiphertext":{"data":"saved"}}"#;
    fs::write(&path, original).unwrap();
    assert!(matches!(
      ActivityStore::delete_other_account_history_with_key_lookup(
        &root,
        &current,
        ActivityOtherHistoryRecovery::DiscardUnrecoverable,
        |_| Ok(LocalDataKeyLookup::Missing)
      ),
      Err(ActivityDeletionError::Incompatible)
    ));
    assert!(settled.day_file(date(1)).path().exists());
    assert_eq!(fs::read(&path).unwrap(), original);
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn recording_boundary_prioritizes_incompatible_over_corrupt_in_either_order() {
    for incompatible_date in [date(1), date(2)] {
      let (store, root) = store();
      for day in [date(1), date(2)] {
        store.save_day(day, &[segment("app")]).unwrap();
        let content = if day == incompatible_date {
          br#"{"version":999}"#.as_slice()
        } else {
          b"invalid envelope".as_slice()
        };
        fs::write(store.day_file(day).path(), content).unwrap();
      }
      assert!(matches!(
        store.recorded_until(date(1)),
        Err(EncryptedReadError::Incompatible(_))
      ));
      ActivityStore::remove(&root).unwrap();
    }
  }

  #[test]
  fn confirmed_inactive_cleanup_handles_missing_and_unreadable_history_together() {
    let (_, root) = store();
    let current = "a".repeat(64);
    let missing = "b".repeat(64);
    let unreadable = "c".repeat(64);
    let current_store = ActivityStore::new([9; 32], root.join(&current));
    current_store.save_pending(date(1), &pending()).unwrap();
    let missing_store = ActivityStore::new([9; 32], root.join(&missing));
    missing_store
      .save_settings(&ActivitySettings::default())
      .unwrap();
    missing_store.save_pending(date(1), &pending()).unwrap();
    let unreadable_store = ActivityStore::new([8; 32], root.join(&unreadable));
    unreadable_store
      .save_settings(&ActivitySettings::default())
      .unwrap();
    unreadable_store.save_pending(date(1), &pending()).unwrap();
    ActivityStore::delete_other_account_history_with_key_lookup(
      &root,
      &current,
      ActivityOtherHistoryRecovery::DiscardUnrecoverable,
      |namespace| {
        Ok(if namespace == missing {
          LocalDataKeyLookup::Missing
        } else {
          LocalDataKeyLookup::Found([9; 32])
        })
      },
    )
    .unwrap();
    assert!(!missing_store.root.exists());
    assert!(unreadable_store.day_dates().unwrap().is_empty());
    assert!(!unreadable_store.root.join(SETTINGS_FILE_NAME).exists());
    assert!(current_store.load_pending(date(1)).unwrap().is_some());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn inactive_cleanup_rechecks_keys_before_removing_any_file() {
    let (_, root) = store();
    let current = "a".repeat(64);
    let account = ActivityStore::new([9; 32], root.join("b".repeat(64)));
    account.save_day(date(1), &[segment("app")]).unwrap();
    let mut reads = 0;
    let result = ActivityStore::delete_other_account_history_with_key_lookup(
      &root,
      &current,
      ActivityOtherHistoryRecovery::DiscardUnrecoverable,
      |_| {
        reads += 1;
        Ok(LocalDataKeyLookup::Found(if reads < 3 {
          [9; 32]
        } else {
          [8; 32]
        }))
      },
    );
    assert!(matches!(result, Err(ActivityDeletionError::Unavailable(_))));
    assert_eq!(account.load_day(date(1)).unwrap().len(), 1);
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn inactive_cleanup_preserves_all_roots_when_settings_require_a_newer_app() {
    let (_, root) = store();
    let current = "a".repeat(64);
    let missing = "b".repeat(64);
    let incompatible = "c".repeat(64);
    let missing_store = ActivityStore::new([9; 32], root.join(&missing));
    missing_store.save_day(date(1), &[segment("app")]).unwrap();
    let future_store = ActivityStore::new([9; 32], root.join(&incompatible));
    let mut settings = serde_json::to_value(ActivitySettings::default()).unwrap();
    settings["recordingStatus"] = serde_json::json!("futureMode");
    future_store.settings_file().persist(&settings).unwrap();
    let original = fs::read(future_store.settings_file().path()).unwrap();
    assert!(matches!(
      ActivityStore::delete_other_account_history_with_key_lookup(
        &root,
        &current,
        ActivityOtherHistoryRecovery::DiscardUnrecoverable,
        |namespace| Ok(if namespace == missing {
          LocalDataKeyLookup::Missing
        } else {
          LocalDataKeyLookup::Found([9; 32])
        })
      ),
      Err(ActivityDeletionError::Incompatible)
    ));
    assert!(missing_store.day_file(date(1)).path().exists());
    assert_eq!(
      fs::read(future_store.settings_file().path()).unwrap(),
      original
    );
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn confirmed_unreadable_recovery_preserves_every_readable_pending_and_history_file() {
    let (store, root) = store();
    store.save_settings(&ActivitySettings::default()).unwrap();
    fs::write(store.settings_file().path(), b"unreadable settings").unwrap();
    store.save_day(date(1), &[segment("app")]).unwrap();
    let pending = pending();
    store.save_pending(date(2), &pending).unwrap();
    store.save_day(date(3), &[segment("app")]).unwrap();
    fs::write(store.day_file(date(3)).path(), b"unreadable day").unwrap();
    ActivityStore::remove_unreadable_with_lookup(
      &root,
      ActivityDeletionRecovery::DiscardUnreadable,
      || Ok(LocalDataKeyLookup::Found([9; 32])),
    )
    .unwrap();
    assert!(store.load_settings_checked().unwrap().is_none());
    assert_eq!(store.load_day(date(1)).unwrap().len(), 1);
    assert_eq!(store.load_pending(date(2)).unwrap(), Some(pending));
    assert!(store.load_day(date(3)).unwrap().is_empty());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn unreadable_recovery_rechecks_restored_keys_and_preserves_now_readable_pending() {
    let (store, root) = store();
    store.save_settings(&ActivitySettings::default()).unwrap();
    let pending = pending();
    store.save_pending(date(1), &pending).unwrap();
    let before = fs::read(store.day_file(date(1)).path()).unwrap();
    let mut keys = [[8; 32], [9; 32]].into_iter();
    ActivityStore::remove_unreadable_with_lookup(
      &root,
      ActivityDeletionRecovery::DiscardUnreadable,
      || Ok(LocalDataKeyLookup::Found(keys.next().unwrap())),
    )
    .unwrap();
    assert_eq!(fs::read(store.day_file(date(1)).path()).unwrap(), before);
    assert_eq!(store.load_pending(date(1)).unwrap(), Some(pending));
    assert!(store.load_settings_checked().unwrap().is_some());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn unreadable_recovery_refuses_transient_key_or_file_reads() {
    let (store, root) = store();
    let pending = pending();
    store.save_pending(date(1), &pending).unwrap();
    assert!(matches!(
      ActivityStore::remove_unreadable_with_lookup(
        &root,
        ActivityDeletionRecovery::DiscardUnreadable,
        || Err("keychain unavailable".into())
      ),
      Err(ActivityDeletionError::Unavailable(_))
    ));
    fs::create_dir(store.settings_file().path()).unwrap();
    assert!(matches!(
      ActivityStore::remove_unreadable_with_lookup(
        &root,
        ActivityDeletionRecovery::DiscardUnreadable,
        || Ok(LocalDataKeyLookup::Found([9; 32]))
      ),
      Err(ActivityDeletionError::Unavailable(_))
    ));
    assert_eq!(store.load_pending(date(1)).unwrap(), Some(pending));
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn expired_unreadable_files_are_skipped_by_both_startup_scans() {
    let (store, root) = store();
    store.save_day(date(1), &[segment("app")]).unwrap();
    fs::write(store.day_file(date(1)).path(), b"unreadable ciphertext").unwrap();
    let pending = pending();
    store.save_pending(date(3), &pending).unwrap();
    assert_eq!(store.recorded_until(date(2)).unwrap(), None);
    assert_eq!(store.pending_dates(date(2)).unwrap(), vec![date(3)]);
    assert!(matches!(
      store.recorded_until(date(1)),
      Err(EncryptedReadError::Unreadable(_))
    ));
    assert!(matches!(
      store.pending_dates(date(1)),
      Err(EncryptedReadError::Unreadable(_))
    ));
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn incompatible_settings_survive_writes_and_independent_unreadable_recovery() {
    let (store, root) = store();
    let mut settings = serde_json::to_value(ActivitySettings::default()).unwrap();
    settings["recordingStatus"] = serde_json::json!("futureMode");
    store.settings_file().persist(&settings).unwrap();
    let original = fs::read(store.settings_file().path()).unwrap();
    assert!(matches!(
      store.load_settings_checked(),
      Err(EncryptedReadError::Incompatible(_))
    ));
    assert!(store.save_settings(&ActivitySettings::default()).is_err());
    store.save_pending(date(1), &pending()).unwrap();
    store.save_day(date(2), &[segment("app")]).unwrap();
    fs::write(store.day_file(date(2)).path(), b"invalid envelope").unwrap();
    ActivityStore::remove_unreadable_with_lookup(
      &root,
      ActivityDeletionRecovery::DiscardUnreadable,
      || Ok(LocalDataKeyLookup::Found([9; 32])),
    )
    .unwrap();
    assert_eq!(fs::read(store.settings_file().path()).unwrap(), original);
    assert_eq!(store.load_pending(date(1)).unwrap(), Some(pending()));
    assert!(!store.day_file(date(2)).path().exists());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn optional_settings_fields_survive_known_setting_changes() {
    let (store, root) = store();
    let extra = serde_json::json!({"mode": "future", "options": [1, 2]});
    let mut saved = serde_json::to_value(ActivitySettings::default()).unwrap();
    saved["optionalSettings"] = extra.clone();
    store.settings_file().persist(&saved).unwrap();
    store
      .save_settings(&ActivitySettings {
        recording_status: crate::activity::ActivityRecordingStatus::Paused,
        ..ActivitySettings::default()
      })
      .unwrap();
    let rewritten = store
      .settings_file()
      .load::<serde_json::Value>()
      .unwrap()
      .unwrap();
    assert_eq!(rewritten["optionalSettings"], extra);
    assert_eq!(rewritten["recordingStatus"], "paused");
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn optional_day_fields_survive_rewrites_and_empty_known_content() {
    let (store, root) = store();
    let pending = pending();
    let extra = serde_json::json!({"items": [{"mode": "future"}]});
    let saved = serde_json::json!({
      "segments": [segment("app")],
      "draftedEntries": [],
      "manualAssignments": [],
      "pendingBatch": pending,
      "optionalDay": extra,
    });
    store.day_file(date(1)).persist(&saved).unwrap();
    store.save_day(date(1), &[]).unwrap();
    assert_eq!(store.load_pending(date(1)).unwrap(), Some(pending.clone()));
    store
      .cancel_pending(date(1), &pending.idempotency_key)
      .unwrap();
    let rewritten = store
      .day_file(date(1))
      .load::<serde_json::Value>()
      .unwrap()
      .unwrap();
    assert_eq!(rewritten["optionalDay"], saved["optionalDay"]);
    assert_eq!(rewritten["segments"], serde_json::json!([]));
    assert_eq!(rewritten["pendingBatch"], serde_json::Value::Null);
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn newer_day_envelope_survives_deletion_and_unreadable_recovery() {
    let (store, root) = store();
    store.save_day(date(1), &[segment("app")]).unwrap();
    let path = store.day_file(date(1)).path().to_path_buf();
    let mut envelope: serde_json::Value =
      serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    envelope["version"] = serde_json::json!(999);
    let original = serde_json::to_vec(&envelope).unwrap();
    fs::write(&path, &original).unwrap();
    assert!(matches!(
      store.delete_day(date(1)),
      Err(ActivityDeletionError::Incompatible)
    ));
    store.save_day(date(2), &[segment("app")]).unwrap();
    fs::write(store.day_file(date(2)).path(), b"invalid envelope").unwrap();
    ActivityStore::remove_unreadable_with_lookup(
      &root,
      ActivityDeletionRecovery::DiscardUnreadable,
      || Ok(LocalDataKeyLookup::Found([9; 32])),
    )
    .unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(!store.day_file(date(2)).path().exists());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn retention_skips_unreadable_expired_days_and_continues_sweeping() {
    let (store, root) = store();
    store.save_day(date(1), &[segment("app")]).unwrap();
    fs::write(store.day_file(date(1)).path(), b"unreadable ciphertext").unwrap();
    store.save_day(date(2), &[segment("app")]).unwrap();
    let pending = pending();
    store.save_pending(date(3), &pending).unwrap();
    assert_eq!(store.delete_days_before(date(4)).unwrap(), 1);
    assert!(store.day_file(date(1)).path().exists());
    assert!(store.load_day(date(1)).is_err());
    assert!(store.load_day(date(2)).unwrap().is_empty());
    assert_eq!(store.load_pending(date(3)).unwrap(), Some(pending));
    ActivityStore::remove(&root).unwrap();
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
    store
      .save_assignments(day, std::slice::from_ref(&assignment))
      .unwrap();
    store.save_pending(day, &pending).unwrap();
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
    store
      .finish_batch(day, std::slice::from_ref(&marker))
      .unwrap();
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
    let settings = store.load_settings_checked().unwrap().unwrap();
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
        ActivityStore::delete_other_account_history(
          &root,
          &invalid,
          ActivityOtherHistoryRecovery::Preserve
        )
        .unwrap_err(),
        ActivityDeletionError::Unavailable(
          "activity account namespace is invalid".into()
        )
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
  fn inactive_history_refuses_unavailable_metadata_before_any_erasure() {
    let (_, root) = store();
    let current = "a".repeat(64);
    let account = ActivityStore::new([9; 32], root.join("b".repeat(64)));
    account.save_day(date(1), &[segment("app")]).unwrap();
    fs::create_dir(account.settings_file().path()).unwrap();
    let day_path = account.day_file(date(1)).path().to_path_buf();
    let original = fs::read(&day_path).unwrap();
    let temporary = account.days_dir().join("interrupted.tmp");
    fs::write(&temporary, b"partial").unwrap();
    assert!(matches!(
      delete_inactive_history(&root, &current),
      Err(ActivityDeletionError::Unavailable(_))
    ));
    assert_eq!(fs::read(&day_path).unwrap(), original);
    assert!(account.settings_file().path().is_dir());
    assert_eq!(fs::read(&temporary).unwrap(), b"partial");
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
    ActivityStore::new([9; 32], root.join("c".repeat(64)))
      .save_day(date(3), &[segment("app")])
      .unwrap();
    let current = "f".repeat(64);
    assert_eq!(
      ActivityStore::other_account_history_days(&root, &current).unwrap(),
      1
    );
    delete_inactive_history(&root, &current).unwrap();
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
    delete_inactive_history(&root_link, &current).unwrap();
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
