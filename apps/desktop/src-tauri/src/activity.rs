//! A private day timeline of which app was in the foreground.
//!
//! Every five seconds, while the user has opted in and the feature is
//! enabled, the sampler reads the foreground app's identifier and name (no
//! icons, window titles or document names) and the system idle time.
//! Consecutive samples of one app merge into a segment; five idle minutes end
//! it, and idle time is never recorded. Excluded apps are recorded as nothing.
//! Segments are written to encrypted per-day files at most once a minute and
//! whenever recording stops. Nothing here reaches the network: the data is
//! read only by the activity window, through `ActivityCaller`.

use chrono::{DateTime, Days, Local, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::{
  collections::{BTreeMap, BTreeSet},
  path::PathBuf,
  sync::{Arc, Mutex},
  time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{
  activity_store::ActivityStore,
  config::APP_DATA_DIR_NAME,
  feature_gate::{DesktopFeature, FeatureGates},
  foreground_app::{self, AppExclusion},
  keychain::LocalDataKey,
  local_store::{self, StoreKey},
  local_window::ActivityCaller,
};

pub const CHANGED_EVENT: &str = "activity-timeline-changed";
const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
/// A sample later than this after the previous one means the machine slept
/// or the sampler stalled; the open segment ends at the last sample.
const MAX_SAMPLE_GAP: chrono::Duration = chrono::Duration::seconds(15);
const IDLE_THRESHOLD: Duration = Duration::from_secs(5 * 60);
const FLUSH_INTERVAL: chrono::Duration = chrono::Duration::seconds(60);
const RETENTION_SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);
const MAX_EXCLUSIONS: usize = 128;
const DEBUG_PERSISTENCE_ENV: &str = "STELLA_ENABLE_DEBUG_ACTIVITY_PERSISTENCE";
const STORE_DIR_NAME: &str = "activity-timeline";
const DATE_FORMAT: &str = "%Y-%m-%d";

macro_rules! define_activity_retention {
  ($($(#[$attr:meta])* $variant:ident => $days:literal),+ $(,)?) => {
    /// How long recorded days stay before the hourly sweep deletes them.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum ActivityRetention {
      $($(#[$attr])* $variant),+
    }

    impl ActivityRetention {
      #[cfg(test)]
      const ALL: &'static [Self] = &[$(Self::$variant),+];

      fn days(self) -> u64 {
        match self {
          $(Self::$variant => $days),+
        }
      }
    }
  };
}

define_activity_retention! {
  Week => 7,
  #[default]
  Month => 30,
  Quarter => 90,
}

/// Recording starts `Off` and only the user turns it on, from the activity
/// window's welcome.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityRecordingStatus {
  #[default]
  Off,
  Recording,
  Paused,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySettings {
  pub recording_status: ActivityRecordingStatus,
  pub retention: ActivityRetention,
  #[serde(default)]
  pub excluded_apps: Vec<AppExclusion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySegment {
  pub app_identifier: String,
  pub app_name: String,
  pub start: DateTime<Utc>,
  pub end: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityPersistenceStatus {
  Initializing,
  Encrypted,
  MemoryOnly,
  DeletionOnly,
}

enum ActivityPersistence {
  Initializing,
  Encrypted(ActivityStore),
  MemoryOnly,
  DeletionOnly(PathBuf),
}

/// What one sample saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observation {
  Active {
    identifier: String,
    name: String,
  },
  /// No input for at least the idle threshold, for `idle` in total.
  Idle {
    idle: Duration,
  },
  /// No attributable app, or one the user excluded.
  Unattributed,
}

struct OpenSegment {
  segment: ActivitySegment,
  last_seen: DateTime<Utc>,
}

/// The day a view asks for, with what the window needs to render it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDaySnapshot {
  date: String,
  today: String,
  earliest_date: String,
  persistence: ActivityPersistenceStatus,
  recording_status: ActivityRecordingStatus,
  retention: ActivityRetention,
  excluded_apps: Vec<AppExclusion>,
  segments: Vec<ActivitySegment>,
  /// A day whose file exists but cannot be read.
  unreadable: bool,
}

pub struct ActivityManager {
  settings: ActivitySettings,
  persistence: ActivityPersistence,
  open: Option<OpenSegment>,
  /// Days written in this process, loaded from disk before the first write
  /// so a flush never drops what an earlier run stored.
  days: BTreeMap<NaiveDate, Vec<ActivitySegment>>,
  dirty: BTreeSet<NaiveDate>,
  last_flush: Option<DateTime<Utc>>,
}

pub type ActivityAppState = Arc<Mutex<ActivityManager>>;

pub fn is_supported() -> bool {
  cfg!(any(target_os = "macos", target_os = "windows"))
}

/// The feature exists only on a supported platform and while the server
/// decision for the linked account is `enabled`.
pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
  is_supported()
    && app
      .try_state::<FeatureGates>()
      .is_some_and(|gates| gates.is_enabled(DesktopFeature::ActivityTimeline))
}

fn store_root() -> Option<PathBuf> {
  dirs::data_dir().map(|dir| dir.join(APP_DATA_DIR_NAME).join(STORE_DIR_NAME))
}

pub fn parse_date(raw: &str) -> Result<NaiveDate, String> {
  NaiveDate::parse_from_str(raw, DATE_FORMAT)
    .map_err(|_| "activity date is invalid".to_string())
}

pub fn format_date(date: NaiveDate) -> String {
  date.format(DATE_FORMAT).to_string()
}

fn local_date(instant: DateTime<Utc>) -> NaiveDate {
  instant.with_timezone(&Local).date_naive()
}

/// The UTC instant local `date` starts at; DST gaps resolve to the earliest
/// valid instant.
fn local_midnight(date: NaiveDate) -> DateTime<Utc> {
  let naive = date.and_hms_opt(0, 0, 0).unwrap_or_default();
  Local
    .from_local_datetime(&naive)
    .earliest()
    .unwrap_or_else(|| Local.from_utc_datetime(&naive))
    .with_timezone(&Utc)
}

/// Splits a segment at local midnights so each piece belongs to one day.
fn split_by_local_day(segment: ActivitySegment) -> Vec<(NaiveDate, ActivitySegment)> {
  let mut pieces = Vec::new();
  let mut start = segment.start;
  while start < segment.end {
    let date = local_date(start);
    let next_midnight = date
      .checked_add_days(Days::new(1))
      .map_or(segment.end, local_midnight);
    let end = segment.end.min(next_midnight.max(start));
    let end = if end <= start { segment.end } else { end };
    pieces.push((
      date,
      ActivitySegment {
        app_identifier: segment.app_identifier.clone(),
        app_name: segment.app_name.clone(),
        start,
        end,
      },
    ));
    start = end;
  }
  pieces
}

fn is_excluded(exclusions: &[AppExclusion], identifier: &str) -> bool {
  exclusions
    .iter()
    .any(|exclusion| exclusion.matches_identifier(identifier))
}

fn push_merged(segments: &mut Vec<ActivitySegment>, segment: ActivitySegment) {
  if let Some(last) = segments.last_mut()
    && last.app_identifier == segment.app_identifier
    && last.end == segment.start
  {
    last.end = segment.end;
    return;
  }
  segments.push(segment);
}

impl ActivityManager {
  pub fn new() -> Self {
    Self {
      settings: ActivitySettings::default(),
      persistence: ActivityPersistence::Initializing,
      open: None,
      days: BTreeMap::new(),
      dirty: BTreeSet::new(),
      last_flush: None,
    }
  }

  fn is_initialized(&self) -> bool {
    !matches!(self.persistence, ActivityPersistence::Initializing)
  }

  fn persistence_status(&self) -> ActivityPersistenceStatus {
    match self.persistence {
      ActivityPersistence::Initializing => ActivityPersistenceStatus::Initializing,
      ActivityPersistence::Encrypted(_) => ActivityPersistenceStatus::Encrypted,
      ActivityPersistence::MemoryOnly => ActivityPersistenceStatus::MemoryOnly,
      ActivityPersistence::DeletionOnly(_) => ActivityPersistenceStatus::DeletionOnly,
    }
  }

  fn install(&mut self, persistence: ActivityPersistence, settings: ActivitySettings) {
    self.persistence = persistence;
    self.settings = settings;
    self.open = None;
    self.days.clear();
    self.dirty.clear();
    self.last_flush = None;
  }

  fn require_writable(&self) -> Result<(), String> {
    match self.persistence {
      ActivityPersistence::Encrypted(_) | ActivityPersistence::MemoryOnly => Ok(()),
      ActivityPersistence::Initializing => {
        Err("activity timeline is still loading".to_string())
      }
      ActivityPersistence::DeletionOnly(_) => {
        Err("activity timeline can only be deleted".to_string())
      }
    }
  }

  pub fn is_recording(&self) -> bool {
    self.settings.recording_status == ActivityRecordingStatus::Recording
      && self.require_writable().is_ok()
  }

  pub fn is_excluded(&self, identifier: &str) -> bool {
    is_excluded(&self.settings.excluded_apps, identifier)
  }

  fn persist_settings(&self) -> Result<(), String> {
    match &self.persistence {
      ActivityPersistence::Encrypted(store) => store.save_settings(&self.settings),
      _ => Ok(()),
    }
  }

  fn update_settings(
    &mut self,
    update: impl FnOnce(&mut ActivitySettings),
  ) -> Result<(), String> {
    self.require_writable()?;
    let previous = self.settings.clone();
    update(&mut self.settings);
    if let Err(error) = self.persist_settings() {
      self.settings = previous;
      return Err(error);
    }
    Ok(())
  }

  pub fn set_recording_status(
    &mut self,
    status: ActivityRecordingStatus,
    now: DateTime<Utc>,
  ) -> Result<(), String> {
    if status != ActivityRecordingStatus::Recording {
      self.stop(now)?;
    }
    self.update_settings(|settings| settings.recording_status = status)
  }

  pub fn set_retention(
    &mut self,
    retention: ActivityRetention,
    now: DateTime<Utc>,
  ) -> Result<(), String> {
    self.update_settings(|settings| settings.retention = retention)?;
    self.prune_expired(now).map(|_| ())
  }

  pub fn exclude_app(&mut self, identifier: &str, name: &str) -> Result<(), String> {
    let exclusion = AppExclusion::new(identifier, name)
      .ok_or_else(|| "activity application is invalid".to_string())?;
    if self.is_excluded(&exclusion.identifier) {
      return Ok(());
    }
    if self.settings.excluded_apps.len() >= MAX_EXCLUSIONS {
      return Err("activity exclusion limit reached".to_string());
    }
    if self
      .open
      .as_ref()
      .is_some_and(|open| exclusion.matches_identifier(&open.segment.app_identifier))
    {
      self.close_open_at_last_sample();
    }
    self.update_settings(|settings| {
      settings.excluded_apps.push(exclusion);
      foreground_app::normalize_exclusions(&mut settings.excluded_apps, MAX_EXCLUSIONS);
    })
  }

  pub fn remove_exclusion(&mut self, identifier: &str) -> Result<(), String> {
    let identifier = foreground_app::normalized_identifier(identifier)?;
    self.update_settings(|settings| {
      settings
        .excluded_apps
        .retain(|exclusion| !exclusion.matches_identifier(&identifier));
    })
  }

  /// Applies one sample. Returns whether a segment was closed.
  pub fn observe(&mut self, now: DateTime<Utc>, observation: Observation) -> bool {
    let mut closed = false;
    if self
      .open
      .as_ref()
      .is_some_and(|open| now - open.last_seen > MAX_SAMPLE_GAP)
    {
      closed |= self.close_open_at_last_sample();
    }
    match observation {
      Observation::Idle { idle } => {
        let idle_since = chrono::Duration::from_std(idle)
          .ok()
          .and_then(|idle| now.checked_sub_signed(idle))
          .unwrap_or(now);
        let last_seen = self.open.as_ref().map_or(now, |open| open.last_seen);
        closed |= self.close_open(idle_since.min(last_seen));
      }
      // The time since the last sample belongs to the app that was open.
      Observation::Unattributed => closed |= self.close_open(now),
      Observation::Active { identifier, name } => {
        if let Some(open) = self.open.as_mut()
          && open.segment.app_identifier == identifier
        {
          open.segment.end = now;
          open.last_seen = now;
          return closed;
        }
        closed |= self.close_open(now);
        self.open = Some(OpenSegment {
          segment: ActivitySegment {
            app_identifier: identifier,
            app_name: name,
            start: now,
            end: now,
          },
          last_seen: now,
        });
      }
    }
    closed
  }

  fn close_open_at_last_sample(&mut self) -> bool {
    match self.open.as_ref().map(|open| open.last_seen) {
      Some(last_seen) => self.close_open(last_seen),
      None => false,
    }
  }

  /// Closes the open segment at `end`, keeping it only when it lasted.
  /// Returns whether anything was recorded.
  fn close_open(&mut self, end: DateTime<Utc>) -> bool {
    let Some(open) = self.open.take() else {
      return false;
    };
    let mut segment = open.segment;
    segment.end = end.max(segment.start);
    if segment.end <= segment.start {
      return false;
    }
    let mut recorded = false;
    for (date, piece) in split_by_local_day(segment) {
      let Some(day) = self.day_mut(date) else {
        continue;
      };
      push_merged(day, piece);
      self.dirty.insert(date);
      recorded = true;
    }
    recorded
  }

  /// The cached segments of `date`, loading the file first. `None` when the
  /// file exists but cannot be read: writing would overwrite it.
  fn day_mut(&mut self, date: NaiveDate) -> Option<&mut Vec<ActivitySegment>> {
    if !self.days.contains_key(&date) {
      let loaded = match &self.persistence {
        ActivityPersistence::Encrypted(store) => match store.load_day(date) {
          Ok(segments) => segments,
          Err(error) => {
            tracing::warn!(error = %error, "activity day is unreadable; new activity is not added to it");
            return None;
          }
        },
        _ => Vec::new(),
      };
      self.days.insert(date, loaded);
    }
    self.days.get_mut(&date)
  }

  /// The open segment's pieces, as they would be stored if it ended now.
  fn open_pieces(&self) -> Vec<(NaiveDate, ActivitySegment)> {
    self
      .open
      .as_ref()
      .filter(|open| open.segment.end > open.segment.start)
      .map(|open| split_by_local_day(open.segment.clone()))
      .unwrap_or_default()
  }

  /// Writes every changed day, including the open segment so far, so a
  /// crash loses at most one flush interval.
  ///
  /// The cache never holds the open segment; it is merged in at write time.
  /// A day the open segment reaches is cached before its first write, so the
  /// file it is loaded from cannot already hold that segment.
  pub fn flush(&mut self, now: DateTime<Utc>) -> Result<(), String> {
    self.last_flush = Some(now);
    let open_pieces = self.open_pieces();
    for (date, _) in &open_pieces {
      let _ = self.day_mut(*date);
    }
    let ActivityPersistence::Encrypted(store) = &self.persistence else {
      self.dirty.clear();
      return Ok(());
    };
    let mut dates = self.dirty.clone();
    dates.extend(open_pieces.iter().map(|(date, _)| *date));
    let mut written = Vec::new();
    let mut failure = None;
    for date in dates {
      let Some(cached) = self.days.get(&date) else {
        continue;
      };
      let mut segments = cached.clone();
      for (_, piece) in open_pieces
        .iter()
        .filter(|(piece_date, _)| *piece_date == date)
      {
        push_merged(&mut segments, piece.clone());
      }
      match store.save_day(date, &segments) {
        Ok(()) => written.push(date),
        Err(error) => {
          failure.get_or_insert(error);
        }
      }
    }
    for date in written {
      self.dirty.remove(&date);
    }
    failure.map_or(Ok(()), Err)
  }

  pub fn flush_due(&self, now: DateTime<Utc>) -> bool {
    self
      .last_flush
      .is_none_or(|last_flush| now - last_flush >= FLUSH_INTERVAL)
  }

  /// Ends recording for now: closes the open segment and writes it.
  pub fn stop(&mut self, now: DateTime<Utc>) -> Result<(), String> {
    self.close_open_at_last_sample();
    self.flush(now)
  }

  fn earliest_date(&self, today: NaiveDate) -> NaiveDate {
    today
      .checked_sub_days(Days::new(self.settings.retention.days() - 1))
      .unwrap_or(today)
  }

  /// Deletes days older than the retention window. Returns whether any
  /// cached day was dropped.
  pub fn prune_expired(&mut self, now: DateTime<Utc>) -> Result<bool, String> {
    let earliest = self.earliest_date(local_date(now));
    let before = self.days.len();
    self.days.retain(|date, _| *date >= earliest);
    self.dirty.retain(|date| *date >= earliest);
    let dropped = self.days.len() != before;
    match &self.persistence {
      ActivityPersistence::Encrypted(store) => {
        Ok(store.delete_days_before(earliest)? > 0 || dropped)
      }
      _ => Ok(dropped),
    }
  }

  pub fn delete_day(&mut self, date: NaiveDate) -> Result<(), String> {
    self.require_writable()?;
    if self
      .open_pieces()
      .iter()
      .any(|(piece_date, _)| *piece_date == date)
    {
      self.open = None;
    }
    if let ActivityPersistence::Encrypted(store) = &self.persistence {
      store.delete_day(date)?;
    }
    self.days.remove(&date);
    self.dirty.remove(&date);
    Ok(())
  }

  /// Deletes every recorded day. Settings stay; in deletion-only mode the
  /// unreadable store goes as a whole and a fresh one is opened.
  pub fn delete_all(&mut self) -> Result<(), String> {
    match &self.persistence {
      ActivityPersistence::Initializing => {
        return Err("activity timeline is still loading".to_string());
      }
      ActivityPersistence::Encrypted(store) => store.delete_all_days()?,
      ActivityPersistence::MemoryOnly => {}
      ActivityPersistence::DeletionOnly(root) => {
        ActivityStore::remove(root)?;
        let (persistence, settings) = open_persistence();
        self.install(persistence, settings);
        return Ok(());
      }
    }
    self.open = None;
    self.days.clear();
    self.dirty.clear();
    Ok(())
  }

  pub fn day_snapshot(
    &self,
    date: NaiveDate,
    now: DateTime<Utc>,
    _caller: &ActivityCaller,
  ) -> ActivityDaySnapshot {
    let today = local_date(now);
    let (mut segments, unreadable) = match self.days.get(&date) {
      Some(segments) => (segments.clone(), false),
      None => match &self.persistence {
        ActivityPersistence::Encrypted(store) => match store.load_day(date) {
          Ok(segments) => (segments, false),
          Err(_) => (Vec::new(), true),
        },
        ActivityPersistence::DeletionOnly(_) => (Vec::new(), true),
        _ => (Vec::new(), false),
      },
    };
    for (_, piece) in self
      .open_pieces()
      .into_iter()
      .filter(|(piece_date, _)| *piece_date == date)
    {
      push_merged(&mut segments, piece);
    }
    ActivityDaySnapshot {
      date: format_date(date),
      today: format_date(today),
      earliest_date: format_date(self.earliest_date(today)),
      persistence: self.persistence_status(),
      recording_status: self.settings.recording_status,
      retention: self.settings.retention,
      excluded_apps: self.settings.excluded_apps.clone(),
      segments,
      unreadable,
    }
  }
}

/// Blocking keychain and file work; runs off the main thread.
fn open_persistence() -> (ActivityPersistence, ActivitySettings) {
  if local_store::debug_build_is_memory_only(DEBUG_PERSISTENCE_ENV) {
    return (ActivityPersistence::MemoryOnly, ActivitySettings::default());
  }
  let Some(root) = store_root() else {
    tracing::warn!(
      "activity timeline is memory-only because no data directory is available"
    );
    return (ActivityPersistence::MemoryOnly, ActivitySettings::default());
  };
  let key = match local_store::resolve_key(
    LocalDataKey::ActivityTimeline,
    ActivityStore::has_data(&root),
  ) {
    StoreKey::Key(key) => key,
    StoreKey::MemoryOnly => {
      return (ActivityPersistence::MemoryOnly, ActivitySettings::default());
    }
    StoreKey::DeletionOnly => {
      return (
        ActivityPersistence::DeletionOnly(root),
        ActivitySettings::default(),
      );
    }
  };
  let store = ActivityStore::new(key, root.clone());
  match store.load_settings() {
    Ok(settings) => {
      let mut settings = settings.unwrap_or_default();
      foreground_app::normalize_exclusions(&mut settings.excluded_apps, MAX_EXCLUSIONS);
      (ActivityPersistence::Encrypted(store), settings)
    }
    Err(error) => {
      tracing::warn!(error = %error, "activity timeline settings are unreadable");
      (
        ActivityPersistence::DeletionOnly(root),
        ActivitySettings::default(),
      )
    }
  }
}

fn emit_changed(app: &AppHandle) {
  let _ = app.emit(CHANGED_EVENT, ());
}

/// Opens the store once, then sweeps expired days. Runs when the feature is
/// enabled, and at startup when an earlier run left data (retention applies
/// whether or not the feature is enabled now).
pub fn initialize(app: &AppHandle) {
  let Some(state) = app.try_state::<ActivityAppState>() else {
    return;
  };
  if state.lock().is_ok_and(|manager| manager.is_initialized()) {
    return;
  }
  let state = Arc::clone(&state);
  let app = app.clone();
  let spawned = std::thread::Builder::new()
    .name("stella-activity-init".to_string())
    .spawn(move || {
      let (persistence, settings) = open_persistence();
      let Ok(mut manager) = state.lock() else {
        return;
      };
      if manager.is_initialized() {
        return;
      }
      manager.install(persistence, settings);
      if let Err(error) = manager.prune_expired(Utc::now()) {
        tracing::warn!(error = %error, "expired activity days could not be removed");
      }
      drop(manager);
      emit_changed(&app);
    });
  if let Err(error) = spawned {
    tracing::error!(error = %error, "activity timeline could not initialize");
  }
}

/// Whether an earlier run left activity data on disk.
pub fn has_stored_data() -> bool {
  store_root().is_some_and(|root| ActivityStore::has_data(&root))
}

/// Starts or stops the feature after the server decision changed. Turning
/// it off stops sampling and closes the window; stored days are untouched.
pub fn apply_feature_gate(app: &AppHandle, enabled: bool) {
  if enabled {
    initialize(app);
    return;
  }
  if let Some(state) = app.try_state::<ActivityAppState>()
    && let Ok(mut manager) = state.lock()
    && let Err(error) = manager.stop(Utc::now())
  {
    tracing::warn!(error = %error, "activity timeline could not be written");
  }
  crate::activity_window::close(app);
}

/// Writes pending activity before the process exits.
pub fn flush_on_exit(app: &AppHandle) {
  if let Some(state) = app.try_state::<ActivityAppState>()
    && let Ok(mut manager) = state.lock()
    && let Err(error) = manager.stop(Utc::now())
  {
    tracing::warn!(error = %error, "activity timeline could not be written on exit");
  }
}

fn observe_now(app: &AppHandle, exclusions: &[AppExclusion]) -> Observation {
  if let Some(idle) = crate::idle_time::since_last_input()
    && idle >= IDLE_THRESHOLD
  {
    return Observation::Idle { idle };
  }
  let Some(foreground) = foreground_app::current(app) else {
    return Observation::Unattributed;
  };
  let identifier = foreground
    .identifier
    .unwrap_or_else(|| foreground.name.clone());
  if is_excluded(exclusions, &identifier) {
    return Observation::Unattributed;
  }
  Observation::Active {
    identifier,
    name: foreground.name,
  }
}

fn sample(app: &AppHandle, state: &ActivityAppState) {
  let enabled = is_enabled(app);
  let exclusions = {
    let Ok(mut manager) = state.lock() else {
      return;
    };
    if !enabled || !manager.is_recording() {
      if manager.open.is_some()
        && let Err(error) = manager.stop(Utc::now())
      {
        tracing::warn!(error = %error, "activity timeline could not be written");
      }
      return;
    }
    manager.settings.excluded_apps.clone()
  };
  // The foreground lookup hops to the main thread, so it runs without the
  // lock and commands never wait on it.
  let observation = observe_now(app, &exclusions);
  let Ok(mut manager) = state.lock() else {
    return;
  };
  if !manager.is_recording() {
    return;
  }
  let now = Utc::now();
  let closed = manager.observe(now, observation);
  let flushed = manager.flush_due(now);
  if flushed && let Err(error) = manager.flush(now) {
    tracing::warn!(error = %error, "activity timeline could not be written");
  }
  drop(manager);
  if closed || flushed {
    emit_changed(app);
  }
}

/// Starts the sampler and the hourly retention sweep. Both are cheap while
/// the feature is off: the sampler only checks the gate.
pub fn start(app: AppHandle, state: ActivityAppState) {
  if !is_supported() {
    return;
  }
  if has_stored_data() {
    initialize(&app);
  }
  let sweep_app = app.clone();
  let sweep_state = Arc::clone(&state);
  tauri::async_runtime::spawn(async move {
    let mut interval = tokio::time::interval(RETENTION_SWEEP_INTERVAL);
    interval.tick().await;
    loop {
      interval.tick().await;
      let changed = match sweep_state.lock() {
        Ok(mut manager) if manager.is_initialized() => {
          manager.prune_expired(Utc::now()).unwrap_or_else(|error| {
            tracing::warn!(error = %error, "expired activity days could not be removed");
            false
          })
        }
        _ => false,
      };
      if changed {
        emit_changed(&sweep_app);
      }
    }
  });
  let spawned = std::thread::Builder::new()
    .name("stella-activity-sampler".to_string())
    .spawn(move || {
      loop {
        std::thread::sleep(SAMPLE_INTERVAL);
        sample(&app, &state);
      }
    });
  if let Err(error) = spawned {
    tracing::error!(error = %error, "activity sampler could not start");
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn at(seconds: i64) -> DateTime<Utc> {
    // Local noon keeps every test segment inside one local day.
    local_midnight(NaiveDate::from_ymd_opt(2026, 3, 10).unwrap())
      + chrono::Duration::hours(12)
      + chrono::Duration::seconds(seconds)
  }

  fn active(identifier: &str) -> Observation {
    Observation::Active {
      identifier: identifier.to_string(),
      name: identifier.to_uppercase(),
    }
  }

  fn recording_manager() -> ActivityManager {
    let mut manager = ActivityManager::new();
    manager.install(
      ActivityPersistence::MemoryOnly,
      ActivitySettings {
        recording_status: ActivityRecordingStatus::Recording,
        ..ActivitySettings::default()
      },
    );
    manager
  }

  fn segments(manager: &ActivityManager) -> Vec<(String, i64, i64)> {
    manager
      .days
      .values()
      .flatten()
      .map(|segment| {
        (
          segment.app_identifier.clone(),
          (segment.start - at(0)).num_seconds(),
          (segment.end - at(0)).num_seconds(),
        )
      })
      .collect()
  }

  #[test]
  fn consecutive_samples_merge_and_a_switch_starts_a_segment() {
    let mut manager = recording_manager();
    for second in [0, 5, 10] {
      manager.observe(at(second), active("word"));
    }
    manager.observe(at(15), active("mail"));
    manager.observe(at(20), active("mail"));
    manager.observe(at(25), Observation::Unattributed);

    assert_eq!(
      segments(&manager),
      [("word".into(), 0, 15), ("mail".into(), 15, 25)]
    );
    assert!(manager.open.is_none());
  }

  #[test]
  fn idle_time_is_not_recorded() {
    let mut manager = recording_manager();
    for second in (0..=400).step_by(5) {
      manager.observe(at(second), active("word"));
    }
    // Five idle minutes reported at 400 s: input stopped at 100 s.
    manager.observe(
      at(405),
      Observation::Idle {
        idle: Duration::from_secs(305),
      },
    );

    assert_eq!(segments(&manager), [("word".into(), 0, 100)]);
  }

  #[test]
  fn a_sampling_gap_ends_the_segment_at_the_last_sample() {
    let mut manager = recording_manager();
    manager.observe(at(0), active("word"));
    manager.observe(at(5), active("word"));
    // The machine slept for an hour.
    manager.observe(at(3605), active("word"));
    manager.observe(at(3610), Observation::Unattributed);

    assert_eq!(
      segments(&manager),
      [("word".into(), 0, 5), ("word".into(), 3605, 3610)]
    );
  }

  #[test]
  fn a_single_sample_records_nothing() {
    let mut manager = recording_manager();
    manager.observe(at(0), active("word"));
    manager.observe(
      at(1),
      Observation::Idle {
        idle: Duration::from_secs(600),
      },
    );
    assert!(segments(&manager).is_empty());
  }

  #[test]
  fn segments_split_at_local_midnight() {
    let date = NaiveDate::from_ymd_opt(2026, 3, 10).unwrap();
    let midnight = local_midnight(date.succ_opt().unwrap());
    let pieces = split_by_local_day(ActivitySegment {
      app_identifier: "word".into(),
      app_name: "Word".into(),
      start: midnight - chrono::Duration::minutes(10),
      end: midnight + chrono::Duration::minutes(5),
    });

    assert_eq!(pieces.len(), 2);
    assert_eq!(pieces[0].0, date);
    assert_eq!(pieces[0].1.end, midnight);
    assert_eq!(pieces[1].0, date.succ_opt().unwrap());
    assert_eq!(pieces[1].1.start, midnight);
    for (piece_date, piece) in &pieces {
      assert_eq!(local_date(piece.start), *piece_date);
    }
  }

  #[test]
  fn excluding_the_open_app_closes_it_and_stops_recording_it() {
    let mut manager = recording_manager();
    manager.observe(at(0), active("word"));
    manager.observe(at(5), active("word"));
    manager.exclude_app("WORD", "Word").unwrap();

    assert!(manager.is_excluded("word"));
    assert_eq!(segments(&manager), [("word".into(), 0, 5)]);
    assert!(manager.open.is_none());
    manager.remove_exclusion("word").unwrap();
    assert!(!manager.is_excluded("word"));
  }

  #[test]
  fn pausing_closes_the_open_segment() {
    let mut manager = recording_manager();
    manager.observe(at(0), active("word"));
    manager.observe(at(5), active("word"));
    manager
      .set_recording_status(ActivityRecordingStatus::Paused, at(6))
      .unwrap();

    assert!(!manager.is_recording());
    assert_eq!(segments(&manager), [("word".into(), 0, 5)]);
  }

  #[test]
  fn deletion_only_refuses_everything_but_deleting() {
    let mut manager = ActivityManager::new();
    manager.install(
      ActivityPersistence::DeletionOnly(
        std::env::temp_dir()
          .join(format!("stella-activity-missing-{}", uuid::Uuid::new_v4())),
      ),
      ActivitySettings::default(),
    );
    assert!(!manager.is_recording());
    assert!(
      manager
        .set_recording_status(ActivityRecordingStatus::Recording, at(0))
        .is_err()
    );
    assert!(manager.delete_day(local_date(at(0))).is_err());
  }

  #[test]
  fn persisted_days_survive_a_restart_and_expire_with_retention() {
    let root =
      std::env::temp_dir().join(format!("stella-activity-{}", uuid::Uuid::new_v4()));
    let store = ActivityStore::new([5; 32], root.clone());
    let mut manager = ActivityManager::new();
    manager.install(
      ActivityPersistence::Encrypted(store.clone()),
      ActivitySettings {
        recording_status: ActivityRecordingStatus::Recording,
        ..ActivitySettings::default()
      },
    );
    manager.observe(at(0), active("word"));
    manager.observe(at(5), active("word"));
    manager.flush(at(5)).unwrap();

    let mut restarted = ActivityManager::new();
    restarted.install(
      ActivityPersistence::Encrypted(store.clone()),
      ActivitySettings::default(),
    );
    let day = local_date(at(0));
    assert_eq!(store.load_day(day).unwrap().len(), 1);
    restarted.observe(at(60), active("mail"));
    restarted.observe(at(65), active("mail"));
    restarted.stop(at(66)).unwrap();
    assert_eq!(store.load_day(day).unwrap().len(), 2);

    let much_later = at(0) + chrono::Duration::days(40);
    assert!(restarted.prune_expired(much_later).unwrap());
    assert!(store.load_day(day).unwrap().is_empty());
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn frontend_retention_contract_matches_native_values() {
    let contract: serde_json::Value =
      serde_json::from_str(include_str!("../../fixtures/activity-contract.json"))
        .unwrap();
    let native = ActivityRetention::ALL
      .iter()
      .map(|retention| serde_json::to_value(retention).unwrap())
      .collect::<Vec<_>>();
    assert_eq!(contract["retentions"], serde_json::Value::Array(native));
    let days = ActivityRetention::ALL
      .iter()
      .map(|retention| serde_json::json!(retention.days()))
      .collect::<Vec<_>>();
    assert_eq!(contract["retentionDays"], serde_json::Value::Array(days));
    let statuses = [
      ActivityRecordingStatus::Off,
      ActivityRecordingStatus::Recording,
      ActivityRecordingStatus::Paused,
    ]
    .iter()
    .map(|status| serde_json::to_value(status).unwrap())
    .collect::<Vec<_>>();
    assert_eq!(
      contract["recordingStatuses"],
      serde_json::Value::Array(statuses)
    );
    assert_eq!(contract["changedEvent"], CHANGED_EVENT);
  }
}
