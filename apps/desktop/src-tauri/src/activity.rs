//! A private day timeline of which app was in the foreground.
//!
//! Every five seconds, while the user has opted in and the feature is
//! enabled, the sampler reads the foreground app identifier/name and idle
//! time. Window titles and documents require a separate, default-off opt-in.
//! Consecutive samples of one app merge into a segment; five idle minutes end
//! it, and idle time is never recorded. Excluded apps are recorded as nothing.
//! Segments are written to encrypted per-day files at most once a minute and
//! whenever recording stops. Nothing here reaches the network: the data is
//! read only by the activity window, through `ActivityCaller`.

use chrono::{DateTime, Days, FixedOffset, Local, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::{
  collections::{BTreeMap, BTreeSet},
  path::PathBuf,
  sync::{Arc, Mutex},
  time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{
  activity_details::{CapturedWindowPrivacy, WindowDetails},
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
const MAX_SAMPLE_GAP: Duration = Duration::from_secs(15);
const IDLE_THRESHOLD: Duration = Duration::from_secs(5 * 60);
const INPUT_TIMESTAMP_TOLERANCE: chrono::Duration = chrono::Duration::milliseconds(10);
// Allow clock-read jitter, but end the mapping before a wall correction can
// introduce synthetic activity into the current segment.
const WALL_CLOCK_TOLERANCE: Duration = Duration::from_millis(100);
const FLUSH_INTERVAL: Duration = Duration::from_secs(60);
const TRAY_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const RETENTION_SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);
const MAX_EXCLUSIONS: usize = 128;
pub(crate) const MAX_DETAIL_BYTES: usize = 512;
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
  #[serde(default)]
  pub capture_details: bool,
  #[serde(default)]
  pub app_name_only_apps: Vec<AppExclusion>,
  #[serde(default)]
  pub browser_title_apps: Vec<AppExclusion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySegment {
  pub app_identifier: String,
  pub app_name: String,
  #[serde(default)]
  pub window_title: Option<String>,
  #[serde(default)]
  pub document: Option<String>,
  #[serde(default)]
  pub matter_id: Option<String>,
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
    window_title: Option<String>,
    document: Option<String>,
    privacy: CapturedWindowPrivacy,
  },
  /// No input for at least the idle threshold, for `idle` in total.
  Idle { idle: Duration },
  /// No attributable app, or one the user excluded.
  Unattributed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityHistoryDisposition {
  Keep,
  Delete,
}

macro_rules! define_activity_details_access {
  ($($(#[$meta:meta])* $variant:ident),+ $(,)?) => {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub enum ActivityDetailsAccess { $($(#[$meta])* $variant),+ }

    impl ActivityDetailsAccess {
      #[cfg(test)]
      const ALL: &'static [Self] = &[$(Self::$variant),+];
    }
  };
}

// The contract carries every state; each target constructs only the states
// its platform can reach.
define_activity_details_access! {
  Disabled,
  Ready,
  #[cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, reason = "only the macOS accessibility permission gates details")
  )]
  AccessibilityRequired,
  #[cfg_attr(
    any(target_os = "macos", target_os = "windows"),
    allow(dead_code, reason = "only platforms without window details report it")
  )]
  Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityAppDetailCapture {
  AppNameOnly,
  IncludeDetails,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DayPartition {
  date: NaiveDate,
  next_start: DateTime<Utc>,
  offset: FixedOffset,
}

struct OpenSegment {
  segment: ActivitySegment,
  last_seen: DateTime<Utc>,
  last_input: DateTime<Utc>,
  /// A full sample interval confirmed no input; sub-sample pauses cannot be
  /// reconstructed from the OS's latest-input timestamp.
  idle_since: Option<DateTime<Utc>>,
  partition: DayPartition,
  privacy: CapturedWindowPrivacy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDraftedEntry {
  pub start: String,
  pub end: String,
  pub entry_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAssignedMatter {
  pub id: String,
  pub name: String,
  pub reference: Option<String>,
  pub color: Option<String>,
  pub client_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityManualAssignment {
  pub start: String,
  pub end: String,
  pub matter_id: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub matter: Option<ActivityAssignedMatter>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRange {
  pub start: String,
  pub end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPendingBatch {
  pub idempotency_key: String,
  pub entries: serde_json::Value,
  pub ranges: Vec<Vec<ActivityRange>>,
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
  other_account_history_days: usize,
  capture_details: bool,
  app_name_only_apps: Vec<AppExclusion>,
  details_access: ActivityDetailsAccess,
  browser_title_apps: Vec<AppExclusion>,
  browser_apps: Vec<AppExclusion>,
  segments: Vec<ActivitySegment>,
  source_app_visuals: Vec<crate::foreground_app_visual::ClipboardSourceAppVisual>,
  /// A day whose file exists but cannot be read.
  unreadable: bool,
  drafted_entries: Vec<ActivityDraftedEntry>,
  manual_assignments: Vec<ActivityManualAssignment>,
  pending_batch: Option<ActivityPendingBatch>,
  pub(crate) time_billing_enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewApp {
  app_identifier: String,
}

static PREVIEW_APPS: std::sync::LazyLock<Vec<PreviewApp>> =
  std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/activity/preview-apps.json"))
      .expect("The shared activity preview app catalogue must be valid")
  });

impl ActivityDaySnapshot {
  pub(crate) fn resolve_app_visuals(&mut self) {
    self.source_app_visuals = crate::foreground_app_visual::cached_app_visuals(
      self
        .segments
        .iter()
        .map(|segment| segment.app_identifier.as_str())
        .chain(self.excluded_apps.iter().map(|app| app.identifier.as_str()))
        .chain(
          self
            .app_name_only_apps
            .iter()
            .map(|app| app.identifier.as_str()),
        )
        .chain(self.browser_apps.iter().map(|app| app.identifier.as_str()))
        .chain(PREVIEW_APPS.iter().map(|app| app.app_identifier.as_str())),
    );
  }
}

/// The tray receives only status, a day total and an approved short label.
/// Raw segments, window captions and document paths never cross this boundary.
pub struct TrayActivitySnapshot {
  pub status: ActivityRecordingStatus,
  pub total_ms: u64,
  pub now: Option<String>,
}

struct DetailCaptureApp<'a> {
  identifier: &'a str,
  name: &'a str,
}

fn details_enabled(settings: &ActivitySettings, app: DetailCaptureApp<'_>) -> bool {
  settings.capture_details
    && !is_excluded(&settings.app_name_only_apps, app.identifier)
    && (!crate::activity_details::is_browser(app.identifier, app.name)
      || is_excluded(&settings.browser_title_apps, app.identifier))
}

struct ObservationCommit {
  generation: u64,
  enabled: bool,
  now: DateTime<Utc>,
  monotonic: Instant,
  idle: Duration,
  observation: Observation,
  partition: DayPartition,
}

pub struct ActivityManager {
  initialization: Arc<Mutex<()>>,
  settings: ActivitySettings,
  persistence: ActivityPersistence,
  open: Option<OpenSegment>,
  /// Days written in this process, loaded from disk before the first write
  /// so a flush never drops what an earlier run stored.
  days: BTreeMap<NaiveDate, Vec<ActivitySegment>>,
  dirty: BTreeSet<NaiveDate>,
  drafted_entries: BTreeMap<NaiveDate, Vec<ActivityDraftedEntry>>,
  manual_assignments: BTreeMap<NaiveDate, Vec<ActivityManualAssignment>>,
  pending_batches: BTreeMap<NaiveDate, ActivityPendingBatch>,
  last_flush: Option<Instant>,
  last_sample: Option<(DateTime<Utc>, Instant)>,
  wall_floor: Option<DateTime<Utc>>,
  observation_generation: u64,
  namespace: Option<String>,
  account_generation: Option<u64>,
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

/// The first valid local instant, including midnight gaps, folds and skipped
/// whole dates. Never interpret a missing local midnight as UTC.
/// The partition policy assumes a single initial gap followed by a continuous
/// valid remainder (or a fully skipped date), as in supported Local zone data.
/// Injected zones must preserve that rule; arbitrary sub-minute alternating
/// transitions require a different resolver. The last-second probe covers
/// exceptionally short days.
fn day_start<T: TimeZone>(zone: &T, mut date: NaiveDate) -> DateTime<Utc> {
  loop {
    let midnight = date.and_hms_opt(0, 0, 0).expect("valid midnight");
    // Resolve the initial midnight gap by minutes, then refine its last
    // minute by seconds. Include the day's last second so a very short
    // initial day is preserved; a skipped date costs 1,441 coarse lookups.
    for minute in 0..=1440 {
      let last_second = (minute * 60).min(86399);
      let naive = midnight + chrono::Duration::seconds(last_second);
      let Some(candidate) = zone.from_local_datetime(&naive).earliest() else {
        continue;
      };
      if minute == 0 {
        return candidate.with_timezone(&Utc);
      }
      let first_second = (minute - 1).max(0) * 60;
      for second in first_second..=last_second {
        let naive = midnight + chrono::Duration::seconds(second);
        if let Some(instant) = zone.from_local_datetime(&naive).earliest() {
          return instant.with_timezone(&Utc);
        }
      }
    }
    date = date.succ_opt().expect("local day is representable");
  }
}

#[cfg(test)]
fn local_midnight(date: NaiveDate) -> DateTime<Utc> {
  day_start(&Local, date)
}

fn partition_in<T: TimeZone>(zone: &T, now: DateTime<Utc>) -> DayPartition {
  use chrono::Offset;
  let local = now.with_timezone(zone);
  let date = local.date_naive();
  DayPartition {
    date,
    next_start: day_start(zone, date.succ_opt().expect("local day is representable")),
    offset: local.offset().fix(),
  }
}

/// Injectable zone resolver used for day-boundary regression coverage.
#[cfg(test)]
fn split_by_day_in<T: TimeZone>(
  zone: &T,
  segment: ActivitySegment,
) -> Vec<(NaiveDate, ActivitySegment)> {
  let mut pieces = Vec::new();
  let mut start = segment.start;
  while start < segment.end {
    let partition = partition_in(zone, start);
    let end = segment.end.min(partition.next_start);
    pieces.push((
      partition.date,
      ActivitySegment {
        app_identifier: segment.app_identifier.clone(),
        app_name: segment.app_name.clone(),
        window_title: segment.window_title.clone(),
        document: segment.document.clone(),
        matter_id: segment.matter_id.clone(),
        start,
        end,
      },
    ));
    start = end;
  }
  pieces
}

#[cfg(test)]
fn split_by_local_day(segment: ActivitySegment) -> Vec<(NaiveDate, ActivitySegment)> {
  split_by_day_in(&Local, segment)
}

fn is_excluded(exclusions: &[AppExclusion], identifier: &str) -> bool {
  exclusions
    .iter()
    .any(|exclusion| exclusion.matches_identifier(identifier))
}

fn push_merged(segments: &mut Vec<ActivitySegment>, mut segment: ActivitySegment) {
  // A corrected clock must not double-count an already persisted interval.
  if let Some(last) = segments.last() {
    segment.start = segment.start.max(last.end);
  }
  if segment.end <= segment.start {
    return;
  }
  if let Some(last) = segments.last_mut()
    && last.app_identifier == segment.app_identifier
    && last.window_title == segment.window_title
    && last.document == segment.document
    && last.matter_id == segment.matter_id
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
      initialization: Arc::new(Mutex::new(())),
      settings: ActivitySettings::default(),
      persistence: ActivityPersistence::Initializing,
      open: None,
      days: BTreeMap::new(),
      dirty: BTreeSet::new(),
      drafted_entries: BTreeMap::new(),
      manual_assignments: BTreeMap::new(),
      pending_batches: BTreeMap::new(),
      last_flush: None,
      last_sample: None,
      wall_floor: None,
      observation_generation: 0,
      namespace: None,
      account_generation: None,
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

  fn install(
    &mut self,
    persistence: ActivityPersistence,
    settings: ActivitySettings,
    now: DateTime<Utc>,
  ) {
    let (persistence, settings, wall_floor) = match persistence {
      ActivityPersistence::Encrypted(store) => match store
        .delete_days_before(
          local_date(now)
            .checked_sub_days(Days::new(settings.retention.days() - 1))
            .unwrap_or(local_date(now)),
        )
        .and_then(|_| store.recorded_until())
      {
        Ok(floor) => (ActivityPersistence::Encrypted(store), settings, floor),
        Err(_) => {
          tracing::warn!("activity recording boundary could not be loaded");
          (
            ActivityPersistence::DeletionOnly(store.root().to_path_buf()),
            ActivitySettings::default(),
            None,
          )
        }
      },
      persistence => (persistence, settings, None),
    };
    self.persistence = persistence;
    self.settings = settings;
    self.open = None;
    self.days.clear();
    self.drafted_entries.clear();
    self.manual_assignments.clear();
    self.pending_batches.clear();
    self.dirty.clear();
    self.last_flush = None;
    self.last_sample = None;
    self.wall_floor = wall_floor;
    self.observation_generation = self.observation_generation.wrapping_add(1);
  }

  fn install_account(
    &mut self,
    binding: (u64, String),
    persistence: ActivityPersistence,
    settings: ActivitySettings,
    now: DateTime<Utc>,
  ) {
    self.install(persistence, settings, now);
    self.account_generation = Some(binding.0);
    self.namespace = Some(binding.1);
  }

  fn unload_account(&mut self, now: DateTime<Utc>) -> Result<(), String> {
    let result = self.stop(now);
    self.install(
      ActivityPersistence::Initializing,
      ActivitySettings::default(),
      now,
    );
    self.namespace = None;
    self.account_generation = None;
    result
  }

  pub(crate) fn require_caller(&self, caller: &ActivityCaller) -> Result<(), String> {
    if caller
      .account_binding()
      .is_some_and(|(generation, namespace)| {
        Some(*generation) == self.account_generation
          && self.namespace.as_ref() == Some(namespace)
      })
    {
      return Ok(());
    }
    Err("activity account is unavailable".into())
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
    self.observation_generation = self.observation_generation.wrapping_add(1);
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

  pub fn capture_details(&self) -> bool {
    self.settings.capture_details
  }

  /// The caller prompts for permission only after a persisted false→true
  /// transition, outside this manager's lock.
  pub fn set_capture_details(
    &mut self,
    enabled: bool,
    now: DateTime<Utc>,
  ) -> Result<bool, String> {
    self.require_writable()?;
    if self.settings.capture_details == enabled {
      return Ok(false);
    }
    self.stop(now)?;
    self.update_settings(|settings| settings.capture_details = enabled)?;
    Ok(enabled)
  }

  pub fn set_app_detail_capture(
    &mut self,
    identifier: &str,
    name: &str,
    mode: ActivityAppDetailCapture,
    now: DateTime<Utc>,
  ) -> Result<(), String> {
    let preference = AppExclusion::new(identifier, name)
      .ok_or_else(|| "activity application is invalid".to_string())?;
    self.require_writable()?;
    let app_name_only =
      is_excluded(&self.settings.app_name_only_apps, &preference.identifier);
    if app_name_only == (mode == ActivityAppDetailCapture::AppNameOnly) {
      return Ok(());
    }
    if mode == ActivityAppDetailCapture::AppNameOnly
      && self.settings.app_name_only_apps.len() >= MAX_EXCLUSIONS
    {
      return Err("activity detail preference limit reached".to_string());
    }
    self.stop(now)?;
    self.update_settings(|settings| {
      match mode {
        ActivityAppDetailCapture::AppNameOnly => {
          settings.app_name_only_apps.push(preference)
        }
        ActivityAppDetailCapture::IncludeDetails => settings
          .app_name_only_apps
          .retain(|app| !app.matches_identifier(&preference.identifier)),
      }
      foreground_app::normalize_exclusions(
        &mut settings.app_name_only_apps,
        MAX_EXCLUSIONS,
      );
    })
  }

  pub fn set_browser_title_capture(
    &mut self,
    identifier: &str,
    name: &str,
    enabled: bool,
    now: DateTime<Utc>,
  ) -> Result<(), String> {
    let preference = AppExclusion::new(identifier, name)
      .ok_or_else(|| "activity application is invalid".to_string())?;
    self.require_writable()?;
    if !crate::activity_details::is_browser(&preference.identifier, &preference.name) {
      return Err("activity application is not a browser".to_string());
    }
    if is_excluded(&self.settings.browser_title_apps, &preference.identifier) == enabled
    {
      return Ok(());
    }
    if enabled && self.settings.browser_title_apps.len() >= MAX_EXCLUSIONS {
      return Err("activity browser preference limit reached".to_string());
    }
    self.stop(now)?;
    self.update_settings(|settings| {
      if enabled {
        settings.browser_title_apps.push(preference);
      } else {
        settings
          .browser_title_apps
          .retain(|app| !app.matches_identifier(&preference.identifier));
      }
      foreground_app::normalize_exclusions(
        &mut settings.browser_title_apps,
        MAX_EXCLUSIONS,
      );
    })
  }

  pub fn set_retention(
    &mut self,
    retention: ActivityRetention,
    now: DateTime<Utc>,
  ) -> Result<(), String> {
    self.update_settings(|settings| settings.retention = retention)?;
    self.prune_expired(now).map(|_| ())
  }

  pub fn exclude_app(
    &mut self,
    identifier: &str,
    name: &str,
    history: ActivityHistoryDisposition,
  ) -> Result<(), String> {
    let exclusion = AppExclusion::new(identifier, name)
      .ok_or_else(|| "activity application is invalid".to_string())?;
    if self.is_excluded(&exclusion.identifier) {
      return match history {
        ActivityHistoryDisposition::Keep => Ok(()),
        ActivityHistoryDisposition::Delete => self.delete_app_history(&exclusion),
      };
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
      settings.excluded_apps.push(exclusion.clone());
      foreground_app::normalize_exclusions(&mut settings.excluded_apps, MAX_EXCLUSIONS);
    })?;
    match history {
      ActivityHistoryDisposition::Keep => Ok(()),
      ActivityHistoryDisposition::Delete => self.delete_app_history(&exclusion),
    }
  }

  fn delete_app_history(&mut self, exclusion: &AppExclusion) -> Result<(), String> {
    if let ActivityPersistence::Encrypted(store) = &self.persistence {
      for date in store.day_dates()? {
        if !self.days.contains_key(&date) {
          self.days.insert(date, store.load_day(date)?);
        }
      }
    }
    for (date, segments) in &mut self.days {
      let before = segments.len();
      segments.retain(|segment| !exclusion.matches_identifier(&segment.app_identifier));
      if segments.len() != before {
        self.dirty.insert(*date);
      }
    }
    self.flush(Utc::now())
  }

  pub fn remove_exclusion(&mut self, identifier: &str) -> Result<(), String> {
    let identifier = foreground_app::normalized_identifier(identifier)?;
    self.update_settings(|settings| {
      settings
        .excluded_apps
        .retain(|exclusion| !exclusion.matches_identifier(&identifier));
    })
  }

  /// Production supplies both clocks and idle evidence; tests can inject them.
  #[cfg(test)]
  pub fn observe(&mut self, now: DateTime<Utc>, observation: Observation) -> bool {
    let monotonic = self.last_sample.map_or_else(Instant::now, |(wall, clock)| {
      clock + (now - wall).to_std().unwrap_or_default()
    });
    self.observe_at(
      now,
      monotonic,
      Duration::ZERO,
      observation,
      partition_in(&Local, now),
    )
  }

  fn accepts_observation(&self, generation: u64, enabled: bool) -> bool {
    enabled && self.is_recording() && generation == self.observation_generation
  }

  fn commit_observation(&mut self, sample: ObservationCommit) -> Option<bool> {
    if !self.accepts_observation(sample.generation, sample.enabled) {
      return None;
    }
    Some(self.observe_at(
      sample.now,
      sample.monotonic,
      sample.idle,
      sample.observation,
      sample.partition,
    ))
  }

  fn observe_at(
    &mut self,
    now: DateTime<Utc>,
    monotonic: Instant,
    idle: Duration,
    observation: Observation,
    partition: DayPartition,
  ) -> bool {
    let mut closed = false;
    if let Some((wall, previous)) = self.last_sample {
      let elapsed = monotonic.saturating_duration_since(previous);
      let wall_elapsed = (now - wall).to_std();
      if elapsed > MAX_SAMPLE_GAP
        || wall_elapsed.is_err()
        || wall_elapsed.is_ok_and(|wall_elapsed| {
          wall_elapsed.abs_diff(elapsed) > WALL_CLOCK_TOLERANCE
        })
      {
        closed |= self.close_open_at_last_sample();
      }
    }
    self.last_sample = Some((now, monotonic));
    if self.wall_floor.is_some_and(|floor| now < floor) {
      return closed;
    }
    self.wall_floor = Some(now);
    let last_input = chrono::Duration::from_std(idle)
      .ok()
      .and_then(|idle| now.checked_sub_signed(idle))
      .unwrap_or(now);
    let resumed_input = self.open.as_ref().and_then(|open| {
      (open.idle_since.is_some()
        && last_input - open.last_input > INPUT_TIMESTAMP_TOLERANCE)
        .then_some(open.segment.end)
    });
    if let Some(confirmed_end) = resumed_input {
      // Renewed input cannot turn an already observed idle interval into
      // activity. Keep its confirmed prefix and begin at the new input.
      closed |= self.close_open(confirmed_end);
    }
    if let Some(open) = self.open.as_mut() {
      if last_input <= open.last_seen + INPUT_TIMESTAMP_TOLERANCE {
        open.idle_since.get_or_insert(open.last_input);
      }
      open.last_input = open.last_input.max(last_input);
    }
    // Day boundaries are pinned when opening; a changed zone cannot move an
    // already flushed prefix into another file.
    // Foreground attribution starts at this observation; input may precede
    // it in another day or zone and cannot establish earlier app ownership.
    let mut segment_start = now;
    if let Some(open) = self.open.as_ref()
      && open.partition != partition
    {
      let boundary = open.partition.next_start;
      // Crossing the pinned calendar boundary preserves the whole interval;
      // an unrelated zone change ends the old partition at this sample.
      if now >= boundary {
        segment_start = boundary;
      }
      closed |= self.close_open(now.min(boundary));
    }
    match observation {
      Observation::Idle { idle } => {
        let idle_since = chrono::Duration::from_std(idle)
          .ok()
          .and_then(|idle| now.checked_sub_signed(idle))
          .unwrap_or(now);
        closed |= self.close_open(idle_since);
      }
      Observation::Unattributed => closed |= self.close_open(now),
      Observation::Active {
        identifier,
        name,
        window_title,
        document,
        privacy,
      } => {
        let include_details = details_enabled(
          &self.settings,
          DetailCaptureApp {
            identifier: &identifier,
            name: &name,
          },
        );
        let details = if include_details {
          crate::activity_details::sanitized_details(window_title, document)
        } else {
          WindowDetails::default()
        };
        let privacy = if privacy == CapturedWindowPrivacy::Private
          || details.privacy == CapturedWindowPrivacy::Private
        {
          CapturedWindowPrivacy::Private
        } else {
          CapturedWindowPrivacy::Ordinary
        };
        let (window_title, document) = if privacy == CapturedWindowPrivacy::Ordinary {
          (details.window_title, details.document)
        } else {
          (None, None)
        };
        if self.is_excluded(&identifier) {
          return closed | self.close_open(now);
        }
        if let Some(open) = self.open.as_mut()
          && open.segment.app_identifier == identifier
          && open.segment.window_title == window_title
          && open.segment.document == document
          && open.privacy == privacy
        {
          open.segment.end = now.min(open.last_input);
          open.last_seen = now;
          return closed;
        }
        closed |= self.close_open(now);
        self.open = Some(OpenSegment {
          segment: ActivitySegment {
            app_identifier: identifier,
            app_name: name,
            window_title,
            document,
            matter_id: None,
            start: segment_start,
            end: now.min(last_input),
          },
          last_seen: now,
          last_input,
          idle_since: (resumed_input.is_none() && last_input < segment_start)
            .then_some(last_input),
          partition,
          privacy,
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
    segment.end = end
      .min(open.last_input)
      .min(open.partition.next_start)
      .max(segment.start);
    if segment.end <= segment.start {
      return false;
    }
    let date = open.partition.date;
    let Some(day) = self.day_mut(date) else {
      return false;
    };
    // A backwards clock correction or restart must never overlap persisted
    // activity. The overlapping prefix is discarded until UTC catches up.
    if let Some(last) = day.last() {
      segment.start = segment.start.max(last.end);
    }
    if segment.end <= segment.start {
      return false;
    }
    push_merged(day, segment);
    self.dirty.insert(date);
    true
  }

  /// The cached segments of `date`, loading the file first. `None` when the
  /// file exists but cannot be read: writing would overwrite it.
  fn day_mut(&mut self, date: NaiveDate) -> Option<&mut Vec<ActivitySegment>> {
    if !self.days.contains_key(&date) {
      let loaded = match &self.persistence {
        ActivityPersistence::Encrypted(store) => match store.load_day(date) {
          Ok(segments) => segments,
          Err(_) => {
            tracing::warn!(
              "activity day is unreadable; new activity is not added to it"
            );
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
      .map(|open| {
        let mut segment = open.segment.clone();
        segment.end = segment
          .end
          .min(open.last_input)
          .min(open.partition.next_start);
        if let Some(last) = self
          .days
          .get(&open.partition.date)
          .and_then(|day| day.last())
        {
          segment.start = segment.start.max(last.end);
        }
        if segment.end <= segment.start {
          return Vec::new();
        }
        vec![(open.partition.date, segment)]
      })
      .unwrap_or_default()
  }

  /// Writes every changed day, including the open segment so far, so a
  /// crash loses at most one flush interval.
  ///
  /// The cache never holds the open segment; it is merged in at write time.
  /// A day the open segment reaches is cached before its first write, so the
  /// file it is loaded from cannot already hold that segment.
  pub fn flush(&mut self, now: DateTime<Utc>) -> Result<(), String> {
    let _ = now;
    self.last_flush = Some(Instant::now());
    let open_pieces = self.open_pieces();
    for (date, _) in &open_pieces {
      let _ = self.day_mut(*date);
    }
    let open_pieces = self.open_pieces();
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

  pub fn flush_due(&self, now: Instant) -> bool {
    self.last_flush.is_none_or(|last_flush| {
      now.saturating_duration_since(last_flush) >= FLUSH_INTERVAL
    })
  }

  /// Ends recording for now: closes the open segment and writes it.
  pub fn stop(&mut self, now: DateTime<Utc>) -> Result<(), String> {
    self.observation_generation = self.observation_generation.wrapping_add(1);
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
    self.drafted_entries.retain(|date, _| *date >= earliest);
    self.manual_assignments.retain(|date, _| *date >= earliest);
    self.pending_batches.retain(|date, _| *date >= earliest);
    let dropped = self.days.len() != before;
    match &self.persistence {
      ActivityPersistence::Encrypted(store) => {
        Ok(store.delete_days_before(earliest)? > 0 || dropped)
      }
      ActivityPersistence::DeletionOnly(root) => {
        Ok(ActivityStore::delete_days_before_root(root, earliest)? > 0 || dropped)
      }
      _ => Ok(dropped),
    }
  }

  pub fn delete_day(&mut self, date: NaiveDate) -> Result<(), String> {
    self.require_writable()?;
    self.observation_generation = self.observation_generation.wrapping_add(1);
    if self
      .open
      .as_ref()
      .is_some_and(|open| open.partition.date == date)
      || self
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
    self.drafted_entries.remove(&date);
    self.manual_assignments.remove(&date);
    self.pending_batches.remove(&date);
    self.dirty.remove(&date);
    Ok(())
  }

  /// Deletes every recorded day. Settings stay; in deletion-only mode the
  /// unreadable store goes as a whole and a fresh one is opened.
  pub fn delete_all(&mut self) -> Result<(), String> {
    self.observation_generation = self.observation_generation.wrapping_add(1);
    match &self.persistence {
      ActivityPersistence::Initializing => {
        return Err("activity timeline is still loading".to_string());
      }
      ActivityPersistence::Encrypted(store) => store.delete_all_days()?,
      ActivityPersistence::MemoryOnly => {}
      ActivityPersistence::DeletionOnly(root) => {
        ActivityStore::remove(root)?;
        let namespace = self
          .namespace
          .as_deref()
          .ok_or_else(|| "activity account is unavailable".to_string())?;
        let (persistence, settings) = open_persistence(namespace);
        self.install(persistence, settings, Utc::now());
        return Ok(());
      }
    }
    self.open = None;
    self.days.clear();
    self.drafted_entries.clear();
    self.manual_assignments.clear();
    self.pending_batches.clear();
    self.dirty.clear();
    Ok(())
  }

  fn drafted_for_day(
    &self,
    date: NaiveDate,
  ) -> Result<Vec<ActivityDraftedEntry>, String> {
    if let ActivityPersistence::Encrypted(store) = &self.persistence {
      return store.load_drafted(date);
    }
    Ok(self.drafted_entries.get(&date).cloned().unwrap_or_default())
  }

  fn assignments_for_day(
    &self,
    date: NaiveDate,
  ) -> Result<Vec<ActivityManualAssignment>, String> {
    if let ActivityPersistence::Encrypted(store) = &self.persistence {
      return store.load_assignments(date);
    }
    Ok(
      self
        .manual_assignments
        .get(&date)
        .cloned()
        .unwrap_or_default(),
    )
  }

  pub(crate) fn pending_for_day(
    &self,
    date: NaiveDate,
  ) -> Result<Option<ActivityPendingBatch>, String> {
    if let ActivityPersistence::Encrypted(store) = &self.persistence {
      return store.load_pending(date);
    }
    Ok(self.pending_batches.get(&date).cloned())
  }

  pub(crate) fn reserve_batch(
    &mut self,
    date: NaiveDate,
    pending: ActivityPendingBatch,
  ) -> Result<(), String> {
    self.require_writable()?;
    if let Some(saved) = self.pending_for_day(date)? {
      return if saved == pending {
        Ok(())
      } else {
        Err("another activity batch is pending".to_string())
      };
    }
    let entries = pending.entries.as_array().ok_or("invalid activity batch")?;
    if entries.is_empty()
      || entries.len() > 100
      || entries.len() != pending.ranges.len()
      || pending.idempotency_key.is_empty()
      || pending.idempotency_key.len() > 128
    {
      return Err("invalid activity batch".to_string());
    }
    let mut intervals = Vec::new();
    for ranges in &pending.ranges {
      if ranges.is_empty() || intervals.len() + ranges.len() > 10000 {
        return Err("invalid activity batch ranges".to_string());
      }
      for range in ranges {
        self.require_draftable_range(date, &range.start, &range.end)?;
        let start = DateTime::parse_from_rfc3339(&range.start)
          .map_err(|_| "invalid activity range")?;
        let end = DateTime::parse_from_rfc3339(&range.end)
          .map_err(|_| "invalid activity range")?;
        intervals.push((start, end));
      }
    }
    intervals.sort_by_key(|(start, _)| *start);
    if intervals.windows(2).any(|pair| pair[0].1 > pair[1].0) {
      return Err("overlapping activity ranges".to_string());
    }
    if let ActivityPersistence::Encrypted(store) = &self.persistence {
      store.save_pending(date, Some(&pending))?;
    } else {
      self.pending_batches.insert(date, pending);
    }
    Ok(())
  }

  pub(crate) fn cancel_pending_batch(
    &mut self,
    date: NaiveDate,
    idempotency_key: &str,
  ) -> Result<(), String> {
    self.require_writable()?;
    let pending = self
      .pending_for_day(date)?
      .ok_or("activity batch is not pending")?;
    if pending.idempotency_key != idempotency_key {
      return Err("activity batch key does not match".to_string());
    }
    if let ActivityPersistence::Encrypted(store) = &self.persistence {
      store.save_pending(date, None)?;
    } else {
      self.pending_batches.remove(&date);
    }
    Ok(())
  }

  pub(crate) fn finish_batch(
    &mut self,
    date: NaiveDate,
    markers: Vec<ActivityDraftedEntry>,
  ) -> Result<(), String> {
    self.require_writable()?;
    let pending = self
      .pending_for_day(date)?
      .ok_or("activity batch is not pending")?;
    let expected: Vec<_> = pending
      .ranges
      .iter()
      .flatten()
      .map(|range| (&range.start, &range.end))
      .collect();
    let actual: Vec<_> = markers
      .iter()
      .map(|marker| (&marker.start, &marker.end))
      .collect();
    if expected != actual {
      return Err("activity batch receipts do not match".to_string());
    }
    for marker in &markers {
      self.require_draftable_range(date, &marker.start, &marker.end)?;
    }
    let mut entries = self.drafted_for_day(date)?;
    entries.extend(markers);
    if let ActivityPersistence::Encrypted(store) = &self.persistence {
      store.finish_batch(date, &entries)?;
    } else {
      self.drafted_entries.insert(date, entries);
      self.pending_batches.remove(&date);
    }
    Ok(())
  }

  pub(crate) fn assign_ranges(
    &mut self,
    date: NaiveDate,
    ranges: Vec<ActivityManualAssignment>,
  ) -> Result<(), String> {
    self.require_writable()?;
    if self.pending_for_day(date)?.is_some() {
      return Err("activity batch is pending".to_string());
    }
    if ranges.is_empty() || ranges.len() > 1000 {
      return Err("invalid activity assignment count".to_string());
    }
    let mut assignments = self.assignments_for_day(date)?;
    if assignments.len() + ranges.len() > 1000 {
      return Err("too many activity assignments".to_string());
    }
    for assignment in &ranges {
      self.require_draftable_range(date, &assignment.start, &assignment.end)?;
      if let Some(matter) = &assignment.matter {
        if matter.id != assignment.matter_id
          || matter.name.is_empty()
          || [
            &matter.name,
            matter.reference.as_ref().unwrap_or(&matter.name),
            matter.client_name.as_ref().unwrap_or(&matter.name),
          ]
          .iter()
          .any(|value| {
            value.len() > MAX_DETAIL_BYTES || value.chars().any(char::is_control)
          })
          || matter.color.as_ref().is_some_and(|color| color.len() > 64)
        {
          return Err("invalid activity matter".to_string());
        }
      }
      if assignment.matter_id.is_empty()
        || assignment.matter_id.len() > 128
        || assignment.matter_id.chars().any(char::is_control)
      {
        return Err("invalid activity matter".to_string());
      }
    }
    assignments.extend(ranges);
    if let ActivityPersistence::Encrypted(store) = &self.persistence {
      store.save_assignments(date, &assignments)?;
    } else {
      self.manual_assignments.insert(date, assignments);
    }
    Ok(())
  }

  pub(crate) fn require_draftable_range(
    &self,
    date: NaiveDate,
    start: &str,
    end: &str,
  ) -> Result<(), String> {
    self.require_writable()?;
    let start = DateTime::parse_from_rfc3339(start)
      .map_err(|_| "invalid activity range")?
      .with_timezone(&Utc);
    let end = DateTime::parse_from_rfc3339(end)
      .map_err(|_| "invalid activity range")?
      .with_timezone(&Utc);
    if start >= end
      || local_date(start) != date
      || local_date(end - chrono::Duration::nanoseconds(1)) != date
    {
      return Err("invalid activity range".to_string());
    }
    for marker in self.drafted_for_day(date)? {
      let saved_start = DateTime::parse_from_rfc3339(&marker.start)
        .map_err(|_| "invalid drafted activity range")?
        .with_timezone(&Utc);
      let saved_end = DateTime::parse_from_rfc3339(&marker.end)
        .map_err(|_| "invalid drafted activity range")?
        .with_timezone(&Utc);
      if start < saved_end && end > saved_start {
        return Err("activity range already drafted".to_string());
      }
    }
    Ok(())
  }

  #[cfg(test)]
  pub(crate) fn require_draftable(
    &self,
    date: NaiveDate,
    start: &str,
  ) -> Result<(), String> {
    self.require_writable()?;
    if self
      .drafted_for_day(date)?
      .iter()
      .any(|marker| marker.start == start)
    {
      return Err("activity range already drafted".to_string());
    }
    Ok(())
  }

  #[cfg(test)]
  pub(crate) fn record_drafted(
    &mut self,
    date: NaiveDate,
    marker: ActivityDraftedEntry,
  ) -> Result<(), String> {
    self.require_draftable(date, &marker.start)?;
    if let ActivityPersistence::Encrypted(store) = &self.persistence {
      store.record_drafted(date, marker)?;
    } else {
      self.drafted_entries.entry(date).or_default().push(marker);
    }
    Ok(())
  }

  fn other_account_store_root(&self) -> Result<PathBuf, String> {
    let root = match &self.persistence {
      ActivityPersistence::Encrypted(store) => store.root().parent().map(PathBuf::from),
      ActivityPersistence::DeletionOnly(root) => root.parent().map(PathBuf::from),
      ActivityPersistence::Initializing | ActivityPersistence::MemoryOnly => {
        store_root()
      }
    };
    root.ok_or_else(|| "activity history is unavailable".to_string())
  }

  pub fn other_account_history_days(&self) -> Result<usize, String> {
    let namespace = self
      .namespace
      .as_deref()
      .ok_or_else(|| "activity account is unavailable".to_string())?;
    ActivityStore::other_account_history_days(
      &self.other_account_store_root()?,
      namespace,
    )
    .map_err(|_| "activity history could not be listed".to_string())
  }

  pub fn delete_other_account_history(&mut self) -> Result<(), String> {
    let namespace = self
      .namespace
      .as_deref()
      .ok_or_else(|| "activity account is unavailable".to_string())?;
    ActivityStore::delete_other_account_history(
      &self.other_account_store_root()?,
      namespace,
    )
    .map_err(|_| "activity history could not be deleted".to_string())
  }

  fn day_segments(&self, date: NaiveDate) -> (Vec<ActivitySegment>, bool) {
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
    (segments, unreadable)
  }

  pub fn tray_snapshot(&self, now: DateTime<Utc>) -> Option<TrayActivitySnapshot> {
    let (segments, unreadable) = self.day_segments(local_date(now));
    if unreadable {
      return None;
    }
    let total_ms = segments
      .iter()
      .map(|segment| {
        u64::try_from((segment.end - segment.start).num_milliseconds().max(0))
          .expect("nonnegative activity duration fits")
      })
      .sum();
    let current = self.open.as_ref().filter(|open| {
      self.is_recording()
        && !is_excluded(
          &self.settings.app_name_only_apps,
          &open.segment.app_identifier,
        )
        && (!crate::activity_details::is_browser(
          &open.segment.app_identifier,
          &open.segment.app_name,
        ) || (self.settings.capture_details
          && is_excluded(
            &self.settings.browser_title_apps,
            &open.segment.app_identifier,
          )))
        && open.privacy == CapturedWindowPrivacy::Ordinary
    });
    let now = current.map(|open| {
      open
        .segment
        .document
        .as_deref()
        .and_then(|path| path.rsplit(['/', '\\']).next())
        .and_then(|name| foreground_app::bounded_metadata(name, MAX_DETAIL_BYTES))
        .unwrap_or_else(|| open.segment.app_name.clone())
    });
    Some(TrayActivitySnapshot {
      status: self.settings.recording_status,
      total_ms,
      now,
    })
  }

  pub(crate) fn require_account_binding(
    &self,
    binding: &(u64, String),
  ) -> Result<(), String> {
    if self.account_generation == Some(binding.0)
      && self.namespace.as_ref() == Some(&binding.1)
    {
      return Ok(());
    }
    Err("activity account is unavailable".to_string())
  }

  fn set_recording_from_tray(
    &mut self,
    status: ActivityRecordingStatus,
    now: DateTime<Utc>,
  ) -> Result<(), String> {
    match (self.settings.recording_status, status) {
      (ActivityRecordingStatus::Recording, ActivityRecordingStatus::Paused)
      | (ActivityRecordingStatus::Paused, ActivityRecordingStatus::Recording) => {
        self.set_recording_status(status, now)
      }
      (ActivityRecordingStatus::Recording, ActivityRecordingStatus::Recording)
      | (ActivityRecordingStatus::Paused, ActivityRecordingStatus::Paused) => Ok(()),
      (ActivityRecordingStatus::Off, _) => {
        Err("activity recording has not started".to_string())
      }
      (_, ActivityRecordingStatus::Off) => {
        Err("activity tray action is invalid".to_string())
      }
    }
  }

  pub fn day_snapshot(
    &self,
    date: NaiveDate,
    now: DateTime<Utc>,
    _caller: &ActivityCaller,
    other_account_history_days: usize,
    details_access: ActivityDetailsAccess,
  ) -> ActivityDaySnapshot {
    let today = local_date(now);
    let (mut segments, unreadable) = self.day_segments(date);
    for segment in &mut segments {
      if !details_enabled(
        &self.settings,
        DetailCaptureApp {
          identifier: &segment.app_identifier,
          name: &segment.app_name,
        },
      ) {
        segment.document = None;
        segment.window_title = None;
      }
    }
    let mut browser_apps = self.settings.browser_title_apps.clone();
    for segment in &segments {
      if crate::activity_details::is_browser(&segment.app_identifier, &segment.app_name)
        && let Some(app) = AppExclusion::new(&segment.app_identifier, &segment.app_name)
      {
        browser_apps.push(app);
      }
    }
    foreground_app::normalize_exclusions(&mut browser_apps, MAX_EXCLUSIONS);
    let (drafted_entries, draft_unreadable) = match self.drafted_for_day(date) {
      Ok(entries) => (entries, false),
      Err(_) => (Vec::new(), true),
    };
    let (pending_batch, pending_unreadable) = match self.pending_for_day(date) {
      Ok(pending) => (pending, false),
      Err(_) => (None, true),
    };
    let (manual_assignments, assignments_unreadable) =
      match self.assignments_for_day(date) {
        Ok(entries) => (entries, false),
        Err(_) => (Vec::new(), true),
      };
    ActivityDaySnapshot {
      date: format_date(date),
      today: format_date(today),
      earliest_date: format_date(self.earliest_date(today)),
      persistence: self.persistence_status(),
      recording_status: self.settings.recording_status,
      retention: self.settings.retention,
      excluded_apps: self.settings.excluded_apps.clone(),
      other_account_history_days,
      capture_details: self.settings.capture_details,
      app_name_only_apps: self.settings.app_name_only_apps.clone(),
      details_access,
      browser_title_apps: self.settings.browser_title_apps.clone(),
      browser_apps,
      source_app_visuals: Vec::new(),
      segments,
      unreadable: unreadable
        || draft_unreadable
        || assignments_unreadable
        || pending_unreadable,
      manual_assignments,
      pending_batch,
      drafted_entries,
      time_billing_enabled: false,
    }
  }
}

/// Blocking keychain and file work; runs off the main thread.
fn open_persistence(namespace: &str) -> (ActivityPersistence, ActivitySettings) {
  if local_store::debug_build_is_memory_only(DEBUG_PERSISTENCE_ENV) {
    return (ActivityPersistence::MemoryOnly, ActivitySettings::default());
  }
  let Some(root) = store_root().map(|root| root.join(namespace)) else {
    tracing::warn!(
      "activity timeline is memory-only because no data directory is available"
    );
    return (ActivityPersistence::MemoryOnly, ActivitySettings::default());
  };
  let key = match local_store::resolve_key(
    LocalDataKey::ActivityTimeline(namespace),
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
      foreground_app::normalize_exclusions(
        &mut settings.app_name_only_apps,
        MAX_EXCLUSIONS,
      );
      foreground_app::normalize_exclusions(
        &mut settings.browser_title_apps,
        MAX_EXCLUSIONS,
      );
      (ActivityPersistence::Encrypted(store), settings)
    }
    Err(_) => {
      tracing::warn!("activity timeline settings are unreadable");
      (
        ActivityPersistence::DeletionOnly(root),
        ActivitySettings::default(),
      )
    }
  }
}

fn emit_changed(app: &AppHandle) {
  let _ = app.emit(CHANGED_EVENT, ());
  refresh_tray(app);
}

fn refresh_tray(app: &AppHandle) {
  let Some(state) = app.try_state::<crate::commands::AppState>() else {
    return;
  };
  let state = Arc::clone(&state);
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    let snapshot = state.lock().await.get_snapshot();
    crate::tray::refresh(&app, &snapshot);
  });
}

pub fn tray_snapshot(app: &AppHandle) -> Option<TrayActivitySnapshot> {
  if !is_enabled(app) {
    return None;
  }
  let gates = app.try_state::<FeatureGates>()?;
  let binding = gates.account_binding(DesktopFeature::ActivityTimeline)?;
  let state = app.try_state::<ActivityAppState>()?;
  let manager = state.lock().ok()?;
  manager.require_account_binding(&binding).ok()?;
  let snapshot = manager.tray_snapshot(Utc::now())?;
  if gates
    .account_binding(DesktopFeature::ActivityTimeline)
    .as_ref()
    != Some(&binding)
  {
    return None;
  }
  Some(snapshot)
}

pub fn set_recording_from_tray(
  app: &AppHandle,
  status: ActivityRecordingStatus,
) -> Result<(), String> {
  if !is_enabled(app) {
    return Err("activity timeline is unavailable".to_string());
  }
  if status == ActivityRecordingStatus::Off {
    return Err("activity tray action is invalid".to_string());
  }
  let gates = app
    .try_state::<FeatureGates>()
    .ok_or_else(|| "activity account is unavailable".to_string())?;
  let binding = gates
    .account_binding(DesktopFeature::ActivityTimeline)
    .ok_or_else(|| "activity account is unavailable".to_string())?;
  let state = app
    .try_state::<ActivityAppState>()
    .ok_or_else(|| "activity timeline is unavailable".to_string())?;
  let mut manager = state
    .lock()
    .map_err(|_| "activity timeline is unavailable".to_string())?;
  manager.require_account_binding(&binding)?;
  if gates
    .account_binding(DesktopFeature::ActivityTimeline)
    .as_ref()
    != Some(&binding)
  {
    return Err("activity account is unavailable".to_string());
  }
  manager.set_recording_from_tray(status, Utc::now())?;
  drop(manager);
  emit_changed(app);
  Ok(())
}

fn initialize_account_with(
  state: &ActivityAppState,
  binding: (u64, String),
  open: impl FnOnce(&str) -> (ActivityPersistence, ActivitySettings),
  is_current: impl Fn(&(u64, String)) -> bool,
) -> bool {
  let initialization = match state.lock() {
    Ok(manager) => Arc::clone(&manager.initialization),
    Err(_) => return false,
  };
  // Wait outside the manager lock. The first initializer owns key lookup,
  // creation and installation; a waiter reuses the installed namespace.
  let Ok(_flight) = initialization.lock() else {
    return false;
  };
  {
    let Ok(manager) = state.lock() else {
      return false;
    };
    if !is_current(&binding)
      || (manager.is_initialized() && manager.namespace.as_ref() == Some(&binding.1))
    {
      return false;
    }
  }
  let (persistence, settings) = open(&binding.1);
  let Ok(mut manager) = state.lock() else {
    return false;
  };
  if !is_current(&binding) {
    return false;
  }
  manager.install_account(binding, persistence, settings, Utc::now());
  true
}

/// Installs only the current account's namespace. A slow keychain lookup
/// cannot publish a store after its account generation has been superseded.
pub fn initialize(app: &AppHandle) {
  let Some(gates) = app.try_state::<FeatureGates>() else {
    return;
  };
  let Some(binding) = gates.account_binding(DesktopFeature::ActivityTimeline) else {
    return;
  };
  let Some(state) = app.try_state::<ActivityAppState>() else {
    return;
  };
  if state.lock().is_ok_and(|manager| {
    manager.is_initialized() && manager.namespace.as_ref() == Some(&binding.1)
  }) {
    return;
  }
  let state = Arc::clone(&state);
  let app = app.clone();
  let spawned = std::thread::Builder::new()
    .name("stella-activity-init".to_string())
    .spawn(move || {
      if initialize_account_with(&state, binding, open_persistence, |binding| {
        app.try_state::<FeatureGates>().is_some_and(|gates| {
          gates
            .account_binding(DesktopFeature::ActivityTimeline)
            .as_ref()
            == Some(binding)
        })
      }) {
        emit_changed(&app);
      }
    });
  if spawned.is_err() {
    tracing::error!("activity timeline could not initialize");
  }
}

/// Unlink removes all readable state immediately; encrypted account stores
/// remain on disk until that account returns or the user explicitly deletes them.
pub fn unload_account(app: &AppHandle) {
  if let Some(state) = app.try_state::<ActivityAppState>()
    && let Ok(mut manager) = state.lock()
  {
    if manager.unload_account(Utc::now()).is_err() {
      tracing::warn!("activity timeline could not be written on unlink");
    }
  }
  crate::activity_window::close(app);
  emit_changed(app);
}

fn disable_feature(state: &ActivityAppState, now: DateTime<Utc>) -> Result<(), String> {
  state
    .lock()
    .map_err(|_| "activity timeline is unavailable".to_string())?
    .stop(now)
}

/// Starts or stops the feature after the server decision changed. Turning
/// it off stops sampling and closes the window; linked history still expires.
pub fn apply_feature_gate(app: &AppHandle, enabled: bool) {
  if enabled {
    initialize(app);
    return;
  }
  if let Some(state) = app.try_state::<ActivityAppState>()
    && disable_feature(&state, Utc::now()).is_err()
  {
    tracing::warn!("activity timeline could not be written when disabled");
  }
  crate::activity_window::close(app);
  emit_changed(app);
}

/// Writes pending activity before the process exits.
pub fn flush_on_exit(app: &AppHandle) {
  if let Some(state) = app.try_state::<ActivityAppState>()
    && let Ok(mut manager) = state.lock()
    && manager.stop(Utc::now()).is_err()
  {
    tracing::warn!("activity timeline could not be written on exit");
  }
}

fn observe_now(
  app: &AppHandle,
  idle: Duration,
  settings: &ActivitySettings,
) -> Observation {
  if idle >= IDLE_THRESHOLD {
    return Observation::Idle { idle };
  }
  let Some(foreground) = foreground_app::current(app) else {
    return Observation::Unattributed;
  };
  let identifier = foreground
    .identifier
    .clone()
    .unwrap_or_else(|| foreground.name.clone());
  if !is_excluded(&settings.excluded_apps, &identifier) {
    crate::foreground_app_visual::foreground_app_visual(&foreground);
  }
  let include_details = !is_excluded(&settings.excluded_apps, &identifier)
    && details_enabled(
      settings,
      DetailCaptureApp {
        identifier: &identifier,
        name: &foreground.name,
      },
    );
  let details = if include_details {
    let details = crate::activity_details::capture(
      &foreground,
      is_excluded(&settings.browser_title_apps, &identifier),
    );
    // The capture module verifies focused-window identity internally. Recheck
    // the owning app/process after the bounded OS call before attributing it.
    let Some(current) = foreground_app::current(app) else {
      return Observation::Unattributed;
    };
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if current.process_id != foreground.process_id {
      return Observation::Unattributed;
    }
    if current.identifier != foreground.identifier || current.name != foreground.name {
      return Observation::Unattributed;
    }
    Some(details)
  } else {
    None
  };
  let details = details.unwrap_or_default();
  Observation::Active {
    identifier,
    name: foreground.name,
    window_title: details.window_title,
    document: details.document,
    privacy: details.privacy,
  }
}

fn sample(app: &AppHandle, state: &ActivityAppState) {
  let enabled = is_enabled(app);
  let (generation, settings) = {
    let Ok(mut manager) = state.lock() else {
      return;
    };
    if !enabled || !manager.is_recording() {
      if manager.open.is_some() && manager.stop(Utc::now()).is_err() {
        tracing::warn!("activity timeline could not be written");
      }
      return;
    }
    (manager.observation_generation, manager.settings.clone())
  };
  // The foreground lookup hops to the main thread, so it runs without the
  // lock and commands never wait on it.
  let now = Utc::now();
  let monotonic = Instant::now();
  let idle = crate::idle_time::since_last_input();
  let observation = idle.map_or(Observation::Unattributed, |idle| {
    observe_now(app, idle, &settings)
  });
  let matter_id = match &observation {
    Observation::Active {
      document: Some(document),
      ..
    } => app
      .try_state::<crate::commands::AppState>()
      .and_then(|sessions| {
        sessions
          .try_lock()
          .ok()
          .and_then(|sessions| sessions.activity_matter_for_document(document))
      }),
    _ => None,
  };
  let Ok(mut manager) = state.lock() else {
    return;
  };
  if !manager.accepts_observation(generation, is_enabled(app)) {
    return;
  }
  let Some(idle) = idle else {
    if manager.stop(now).is_err() {
      tracing::warn!("activity timeline could not be written");
    }
    drop(manager);
    emit_changed(app);
    return;
  };
  let Some(closed) = manager.commit_observation(ObservationCommit {
    generation,
    enabled: is_enabled(app),
    now,
    monotonic,
    idle,
    observation,
    partition: partition_in(&Local, now),
  }) else {
    return;
  };
  if let Some(open) = manager.open.as_mut()
    && open.segment.document.is_some()
    && let Some(matter_id) = matter_id
  {
    open.segment.matter_id = Some(matter_id);
  }
  let flushed = manager.flush_due(monotonic);
  if flushed && manager.flush(now).is_err() {
    tracing::warn!("activity timeline could not be written");
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
  let sweep_app = app.clone();
  let sweep_state = Arc::clone(&state);
  tauri::async_runtime::spawn(async move {
    let mut interval = tokio::time::interval(RETENTION_SWEEP_INTERVAL);
    interval.tick().await;
    loop {
      interval.tick().await;
      let changed = match sweep_state.lock() {
        Ok(mut manager) if manager.is_initialized() => {
          manager.prune_expired(Utc::now()).unwrap_or_else(|_| {
            tracing::warn!("expired activity days could not be removed");
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
      let mut last_tray_refresh = Instant::now();
      loop {
        std::thread::sleep(SAMPLE_INTERVAL);
        sample(&app, &state);
        if last_tray_refresh.elapsed() >= TRAY_REFRESH_INTERVAL {
          refresh_tray(&app);
          last_tray_refresh = Instant::now();
        }
      }
    });
  if spawned.is_err() {
    tracing::error!("activity sampler could not start");
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
      window_title: None,
      document: None,
      privacy: CapturedWindowPrivacy::Ordinary,
    }
  }

  fn active_details(identifier: &str) -> Observation {
    Observation::Active {
      identifier: identifier.to_string(),
      name: identifier.to_uppercase(),
      window_title: Some("Draft title".to_string()),
      document: Some("/private/draft.docx".to_string()),
      privacy: CapturedWindowPrivacy::Ordinary,
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
      at(0),
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
  fn cancelled_batch_recovery_releases_the_day_for_editing_and_a_new_key() {
    let mut manager = recording_manager();
    let date = local_date(at(0));
    let range = ActivityRange {
      start: at(0).to_rfc3339(),
      end: at(60).to_rfc3339(),
    };
    let pending = ActivityPendingBatch {
      idempotency_key: "uncertain-key".into(),
      entries: serde_json::json!([{"matterId": "matter"}]),
      ranges: vec![vec![range.clone()]],
    };
    manager.reserve_batch(date, pending.clone()).unwrap();
    let assignment = ActivityManualAssignment {
      start: range.start.clone(),
      end: range.end.clone(),
      matter_id: "matter".into(),
      matter: None,
    };
    assert!(
      manager
        .assign_ranges(date, vec![assignment.clone()])
        .is_err()
    );
    assert!(manager.cancel_pending_batch(date, "different-key").is_err());
    assert_eq!(
      manager.pending_for_day(date).unwrap(),
      Some(pending.clone())
    );
    // Only the transport's authoritative cancelled outcome reaches this transition.
    manager
      .cancel_pending_batch(date, &pending.idempotency_key)
      .unwrap();
    assert!(manager.pending_for_day(date).unwrap().is_none());
    assert!(manager.drafted_for_day(date).unwrap().is_empty());
    manager.assign_ranges(date, vec![assignment]).unwrap();
    let replacement = ActivityPendingBatch {
      idempotency_key: "new-key".into(),
      entries: pending.entries,
      ranges: pending.ranges,
    };
    manager.reserve_batch(date, replacement.clone()).unwrap();
    assert_eq!(manager.pending_for_day(date).unwrap(), Some(replacement));
  }

  #[test]
  fn pending_review_has_one_payload_until_exact_receipts_complete_it() {
    let mut manager = recording_manager();
    let date = local_date(at(0));
    let range = ActivityRange {
      start: at(0).to_rfc3339(),
      end: at(60).to_rfc3339(),
    };
    let pending = ActivityPendingBatch {
      idempotency_key: "retry-key".into(),
      entries: serde_json::json!([{"matterId":"matter"}]),
      ranges: vec![vec![range.clone()]],
    };
    manager.reserve_batch(date, pending.clone()).unwrap();
    manager.reserve_batch(date, pending.clone()).unwrap();
    let mut changed = pending.clone();
    changed.idempotency_key = "other-key".into();
    assert!(manager.reserve_batch(date, changed).is_err());
    assert!(
      manager
        .assign_ranges(
          date,
          vec![ActivityManualAssignment {
            start: range.start.clone(),
            end: range.end.clone(),
            matter_id: "matter".into(),
            matter: None
          }]
        )
        .is_err()
    );
    assert!(
      manager
        .finish_batch(
          date,
          vec![ActivityDraftedEntry {
            start: range.start.clone(),
            end: at(30).to_rfc3339(),
            entry_id: "entry".into()
          }]
        )
        .is_err()
    );
    assert_eq!(manager.pending_for_day(date).unwrap(), Some(pending));
    manager
      .finish_batch(
        date,
        vec![ActivityDraftedEntry {
          start: range.start.clone(),
          end: range.end.clone(),
          entry_id: "entry".into(),
        }],
      )
      .unwrap();
    assert!(manager.pending_for_day(date).unwrap().is_none());
    for second in 0..60 {
      assert!(
        manager
          .require_draftable_range(
            date,
            &at(second).to_rfc3339(),
            &at(second + 1).to_rfc3339()
          )
          .is_err()
      );
    }
    assert!(
      manager
        .require_draftable_range(date, &at(60).to_rfc3339(), &at(90).to_rfc3339())
        .is_ok()
    );
  }

  #[test]
  fn details_are_filtered_at_ingestion_without_opt_in_or_for_name_only_apps() {
    for capture in [false, true] {
      for app_name_only in [false, true] {
        let mut manager = recording_manager();
        manager.set_capture_details(capture, at(0)).unwrap();
        if app_name_only {
          manager
            .set_app_detail_capture(
              "word",
              "Word",
              ActivityAppDetailCapture::AppNameOnly,
              at(0),
            )
            .unwrap();
        }
        manager.observe(at(0), active_details("word"));
        manager.observe(at(5), active_details("word"));
        manager.stop(at(5)).unwrap();
        let recorded = manager.days.values().flatten().collect::<Vec<_>>();
        assert_eq!(recorded.len(), 1);
        assert_eq!(
          recorded[0].window_title.is_some(),
          capture && !app_name_only
        );
        assert_eq!(recorded[0].document.is_some(), capture && !app_name_only);
      }
    }
  }

  #[test]
  fn titles_and_documents_split_same_app_segments_in_memory_and_encrypted_files() {
    let root = std::env::temp_dir()
      .join(format!("stella-detail-splits-{}", uuid::Uuid::new_v4()));
    let store = ActivityStore::new([3; 32], root.clone());
    let mut manager = recording_manager();
    manager.persistence = ActivityPersistence::Encrypted(store.clone());
    manager.set_capture_details(true, at(0)).unwrap();
    for (index, (title, document)) in [
      ("Draft", "/private/a.docx"),
      ("Updated", "/private/a.docx"),
      ("Updated", "/private/b.docx"),
    ]
    .into_iter()
    .enumerate()
    {
      for offset in [0, 5] {
        let second = i64::try_from(index).unwrap() * 10 + offset;
        manager.observe(
          at(second),
          Observation::Active {
            identifier: "word".into(),
            name: "Word".into(),
            window_title: Some(title.into()),
            document: Some(document.into()),
            privacy: CapturedWindowPrivacy::Ordinary,
          },
        );
        manager.flush(at(second)).unwrap();
      }
    }
    manager.stop(at(25)).unwrap();
    let recorded = store.load_day(local_date(at(0))).unwrap();
    assert_eq!(recorded.len(), 3);
    assert_eq!(recorded[0].window_title.as_deref(), Some("Draft"));
    assert_eq!(recorded[1].window_title.as_deref(), Some("Updated"));
    assert_eq!(recorded[1].document.as_deref(), Some("/private/a.docx"));
    assert_eq!(recorded[2].document.as_deref(), Some("/private/b.docx"));
    for pair in recorded.windows(2) {
      assert_eq!(pair[0].end, pair[1].start);
    }
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn detail_preferences_close_segments_invalidate_pending_captures_and_keep_past_details()
   {
    let mut manager = recording_manager();
    assert!(manager.set_capture_details(true, at(0)).unwrap());
    assert!(!manager.set_capture_details(true, at(0)).unwrap());
    manager.observe(at(0), active_details("word"));
    manager.observe(at(5), active_details("word"));
    let generation = manager.observation_generation;
    assert!(!manager.set_capture_details(false, at(5)).unwrap());
    assert!(!manager.accepts_observation(generation, true));
    assert!(manager.open.is_none());
    manager.observe(at(10), active_details("word"));
    manager.observe(at(15), active_details("word"));
    manager.stop(at(15)).unwrap();
    let recorded = manager.days.values().flatten().collect::<Vec<_>>();
    assert_eq!(recorded.len(), 2);
    assert!(recorded[0].window_title.is_some());
    assert!(recorded[1].window_title.is_none());
    assert!(manager.set_capture_details(true, at(20)).unwrap());
    let generation = manager.observation_generation;
    manager
      .set_app_detail_capture(
        "WORD",
        "Word",
        ActivityAppDetailCapture::AppNameOnly,
        at(20),
      )
      .unwrap();
    assert!(!manager.accepts_observation(generation, true));
    assert_eq!(manager.settings.app_name_only_apps.len(), 1);
    manager
      .set_app_detail_capture(
        "word",
        "Word",
        ActivityAppDetailCapture::IncludeDetails,
        at(20),
      )
      .unwrap();
    assert!(manager.settings.app_name_only_apps.is_empty());
  }

  #[test]
  fn browser_details_default_to_app_only_and_recognized_apps_are_disclosed() {
    let mut manager = recording_manager();
    manager.set_capture_details(true, at(0)).unwrap();
    let identifier = "com.google.chrome";
    assert!(crate::activity_details::is_browser(
      identifier,
      "Google Chrome"
    ));
    manager.observe(at(0), active_details(identifier));
    manager.observe(at(5), active_details(identifier));
    manager.stop(at(5)).unwrap();
    let recorded = manager.days.values().flatten().collect::<Vec<_>>();
    assert_eq!(recorded.len(), 1);
    assert!(recorded[0].window_title.is_none());
    assert!(recorded[0].document.is_none());
    let caller = ActivityCaller::for_account_test(1, "fixture");
    let snapshot = manager.day_snapshot(
      local_date(at(0)),
      at(5),
      &caller,
      0,
      ActivityDetailsAccess::Ready,
    );
    assert_eq!(snapshot.browser_apps.len(), 1);
    assert_eq!(snapshot.browser_apps[0].identifier, identifier);
    assert!(snapshot.browser_title_apps.is_empty());
  }

  #[test]
  fn consented_browsers_remain_disclosed_on_days_without_observations() {
    let mut manager = recording_manager();
    manager
      .set_browser_title_capture("com.google.chrome", "Google Chrome", true, at(0))
      .unwrap();
    let caller = ActivityCaller::for_account_test(1, "fixture");
    let snapshot = manager.day_snapshot(
      local_date(at(0)),
      at(5),
      &caller,
      0,
      ActivityDetailsAccess::Ready,
    );
    assert!(snapshot.segments.is_empty());
    assert_eq!(snapshot.browser_apps.len(), 1);
    assert_eq!(
      snapshot.browser_apps[0].identifier,
      snapshot.browser_title_apps[0].identifier
    );
  }

  #[test]
  fn browser_details_and_tray_labels_require_separate_consent_and_never_include_private_windows()
   {
    let identifier = "com.google.chrome";
    for capture in [false, true] {
      for browser_consent in [false, true] {
        for app_name_only in [false, true] {
          for private in [false, true] {
            let mut manager = recording_manager();
            manager.set_capture_details(capture, at(0)).unwrap();
            manager
              .set_browser_title_capture(
                identifier,
                "Google Chrome",
                browser_consent,
                at(0),
              )
              .unwrap();
            if app_name_only {
              manager
                .set_app_detail_capture(
                  identifier,
                  "Google Chrome",
                  ActivityAppDetailCapture::AppNameOnly,
                  at(0),
                )
                .unwrap();
            }
            for second in [0, 5] {
              manager.observe(
                at(second),
                Observation::Active {
                  identifier: identifier.into(),
                  name: "Google Chrome".into(),
                  window_title: Some(
                    if private {
                      "Example — Incognito"
                    } else {
                      "Public title"
                    }
                    .into(),
                  ),
                  document: Some("/private/draft.docx".into()),
                  // Ingestion must independently reject a recognized marker,
                  // even when a producer incorrectly reports ordinary privacy.
                  privacy: CapturedWindowPrivacy::Ordinary,
                },
              );
            }
            let details = capture && browser_consent && !app_name_only && !private;
            let open = manager.open.as_ref().unwrap();
            assert_eq!(open.segment.window_title.is_some(), details);
            assert_eq!(open.segment.document.is_some(), details);
            let tray = manager.tray_snapshot(at(5)).unwrap();
            assert_eq!(tray.now.as_deref(), details.then_some("draft.docx"));
            assert_eq!(tray.total_ms, 5000);
          }
        }
      }
    }
  }

  #[test]
  fn browser_preferences_stop_pending_captures_and_reject_non_browser_accounts() {
    let mut manager = recording_manager();
    assert_eq!(
      manager
        .set_browser_title_capture("word", "Word", true, at(0))
        .unwrap_err(),
      "activity application is not a browser"
    );
    manager.set_capture_details(true, at(0)).unwrap();
    let generation = manager.observation_generation;
    manager
      .set_browser_title_capture("com.google.Chrome", "Chrome", true, at(0))
      .unwrap();
    assert!(!manager.accepts_observation(generation, true));
    assert_eq!(
      manager.settings.browser_title_apps[0].identifier,
      "com.google.chrome"
    );
    manager.observe(at(0), active_details("com.google.chrome"));
    manager.observe(at(5), active_details("com.google.chrome"));
    let generation = manager.observation_generation;
    manager
      .set_browser_title_capture("com.google.chrome", "Chrome", false, at(5))
      .unwrap();
    assert!(!manager.accepts_observation(generation, true));
    assert!(manager.open.is_none());
    assert!(manager.settings.browser_title_apps.is_empty());
    assert!(
      manager
        .days
        .values()
        .flatten()
        .next()
        .unwrap()
        .window_title
        .is_some()
    );
  }

  #[test]
  fn tray_projection_uses_only_a_document_basename_or_approved_app_name() {
    let mut manager = recording_manager();
    manager.observe(at(0), active("word"));
    manager.observe(at(5), active("word"));
    let tray = manager.tray_snapshot(at(5)).unwrap();
    assert_eq!(tray.now.as_deref(), Some("WORD"));
    assert_eq!(tray.total_ms, 5000);
    manager.set_capture_details(true, at(5)).unwrap();
    for path in [
      "/private/folder/draft.docx",
      "C:\\private\\folder\\draft.docx",
    ] {
      let mut path_manager = recording_manager();
      path_manager.set_capture_details(true, at(0)).unwrap();
      for second in [0, 5] {
        path_manager.observe(
          at(second),
          Observation::Active {
            identifier: "word".into(),
            name: "Word".into(),
            window_title: Some("A full sensitive caption".into()),
            document: Some(path.into()),
            privacy: CapturedWindowPrivacy::Ordinary,
          },
        );
      }
      let tray = path_manager.tray_snapshot(at(5)).unwrap();
      assert_eq!(tray.now.as_deref(), Some("draft.docx"));
    }
    manager
      .set_app_detail_capture(
        "word",
        "Word",
        ActivityAppDetailCapture::AppNameOnly,
        at(20),
      )
      .unwrap();
    manager.observe(at(20), active_details("word"));
    assert!(manager.tray_snapshot(at(20)).unwrap().now.is_none());
    manager
      .set_recording_status(ActivityRecordingStatus::Paused, at(20))
      .unwrap();
    let tray = manager.tray_snapshot(at(20)).unwrap();
    assert_eq!(tray.status, ActivityRecordingStatus::Paused);
    assert!(tray.now.is_none());
  }

  #[test]
  fn private_marker_transitions_split_live_state_and_hide_tray_now() {
    let mut manager = recording_manager();
    manager.set_capture_details(true, at(0)).unwrap();
    manager
      .set_browser_title_capture("com.google.chrome", "Chrome", true, at(0))
      .unwrap();
    for second in [0, 5] {
      manager.observe(at(second), active("com.google.chrome"));
    }
    assert!(manager.tray_snapshot(at(5)).unwrap().now.is_some());
    manager.observe(
      at(10),
      Observation::Active {
        identifier: "com.google.chrome".into(),
        name: "Chrome".into(),
        window_title: None,
        document: None,
        privacy: CapturedWindowPrivacy::Private,
      },
    );
    assert_eq!(manager.open.as_ref().unwrap().segment.start, at(10));
    assert_eq!(
      manager.open.as_ref().unwrap().privacy,
      CapturedWindowPrivacy::Private
    );
    assert!(manager.tray_snapshot(at(10)).unwrap().now.is_none());
    manager.observe(at(15), active("com.google.chrome"));
    assert_eq!(manager.open.as_ref().unwrap().segment.start, at(15));
    assert!(manager.tray_snapshot(at(15)).unwrap().now.is_some());
  }

  #[test]
  fn tray_actions_preserve_off_consent_and_require_current_account_binding() {
    let mut manager = ActivityManager::new();
    let namespace = "a".repeat(64);
    manager.install_account(
      (1, namespace.clone()),
      ActivityPersistence::MemoryOnly,
      ActivitySettings::default(),
      at(0),
    );
    assert!(
      manager
        .require_account_binding(&(1, namespace.clone()))
        .is_ok()
    );
    assert!(
      manager
        .require_account_binding(&(2, namespace.clone()))
        .is_err()
    );
    assert!(
      manager
        .require_account_binding(&(1, "b".repeat(64)))
        .is_err()
    );
    for target in [
      ActivityRecordingStatus::Recording,
      ActivityRecordingStatus::Paused,
    ] {
      assert_eq!(
        manager.set_recording_from_tray(target, at(0)).unwrap_err(),
        "activity recording has not started"
      );
      assert_eq!(
        manager.settings.recording_status,
        ActivityRecordingStatus::Off
      );
    }
    manager
      .set_recording_status(ActivityRecordingStatus::Recording, at(0))
      .unwrap();
    manager
      .set_recording_from_tray(ActivityRecordingStatus::Paused, at(0))
      .unwrap();
    assert_eq!(
      manager.settings.recording_status,
      ActivityRecordingStatus::Paused
    );
    manager
      .set_recording_from_tray(ActivityRecordingStatus::Recording, at(0))
      .unwrap();
    assert_eq!(
      manager.settings.recording_status,
      ActivityRecordingStatus::Recording
    );
    let generation = manager.observation_generation;
    manager
      .set_recording_from_tray(ActivityRecordingStatus::Recording, at(0))
      .unwrap();
    assert_eq!(manager.observation_generation, generation);
  }

  #[test]
  fn unreadable_day_has_no_tray_projection() {
    let mut manager = ActivityManager::new();
    manager.install(
      ActivityPersistence::DeletionOnly(
        std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
      ),
      ActivitySettings::default(),
      at(0),
    );
    assert!(manager.tray_snapshot(at(0)).is_none());
  }

  #[test]
  fn detail_metadata_is_bounded_and_sanitized_before_storage() {
    let mut manager = recording_manager();
    manager.set_capture_details(true, at(0)).unwrap();
    let raw = format!("\n{}\u{0000}\r", "é".repeat(400));
    for second in [0, 5] {
      manager.observe(
        at(second),
        Observation::Active {
          identifier: "word".into(),
          name: "Word".into(),
          window_title: Some(raw.clone()),
          document: Some(raw.clone()),
          privacy: CapturedWindowPrivacy::Ordinary,
        },
      );
    }
    manager.stop(at(5)).unwrap();
    let recorded = manager.days.values().flatten().next().unwrap();
    for value in [&recorded.window_title, &recorded.document] {
      let value = value.as_deref().unwrap();
      assert_eq!(value.len(), MAX_DETAIL_BYTES);
      assert!(value.chars().all(|character| !character.is_control()));
      assert_eq!(value, "é".repeat(MAX_DETAIL_BYTES / 2));
    }
  }

  #[test]
  fn accounts_isolate_history_and_consent_after_unlink_and_restart() {
    for restart in [false, true] {
      for enabled_b in [false, true] {
        let root = std::env::temp_dir()
          .join(format!("stella-activity-accounts-{}", uuid::Uuid::new_v4()));
        let store_a = ActivityStore::new([1; 32], root.join("a"));
        let store_b = ActivityStore::new([2; 32], root.join("b"));
        let mut manager = ActivityManager::new();
        manager.install_account(
          (1, "a".into()),
          ActivityPersistence::Encrypted(store_a.clone()),
          ActivitySettings::default(),
          at(0),
        );
        manager
          .set_recording_status(ActivityRecordingStatus::Recording, at(0))
          .unwrap();
        manager.observe(at(0), active("private-a"));
        manager.observe(at(5), active("private-a"));
        let caller_a = ActivityCaller::for_account_test(1, "a");
        assert!(manager.require_caller(&caller_a).is_ok());
        let marker = ActivityDraftedEntry {
          start: at(0).to_rfc3339(),
          end: at(5).to_rfc3339(),
          entry_id: "entry-a".into(),
        };
        manager
          .record_drafted(local_date(at(0)), marker.clone())
          .unwrap();
        manager.unload_account(at(5)).unwrap();
        assert!(!manager.is_initialized());
        assert!(!manager.is_recording());
        assert!(manager.days.is_empty());
        assert!(manager.require_caller(&caller_a).is_err());
        assert_eq!(store_a.load_day(local_date(at(0))).unwrap().len(), 1);
        if restart {
          manager = ActivityManager::new();
        }
        if enabled_b {
          let settings_b = store_b.load_settings().unwrap().unwrap_or_default();
          manager.install_account(
            (2, "b".into()),
            ActivityPersistence::Encrypted(store_b),
            settings_b,
            at(0),
          );
          let caller_b = ActivityCaller::for_account_test(2, "b");
          assert!(manager.require_caller(&caller_b).is_ok());
          assert!(!manager.is_recording());
          assert_eq!(
            manager.settings.recording_status,
            ActivityRecordingStatus::Off
          );
          assert!(
            manager
              .day_snapshot(
                local_date(at(0)),
                at(5),
                &caller_b,
                0,
                ActivityDetailsAccess::Disabled
              )
              .segments
              .is_empty()
          );
          assert!(
            manager
              .drafted_for_day(local_date(at(0)))
              .unwrap()
              .is_empty()
          );
          assert!(manager.require_caller(&caller_a).is_err());
        } else {
          assert!(manager.namespace.is_none());
          assert!(manager.days.is_empty());
          assert!(!manager.is_recording());
        }
        // A's history and consent persist only in A's encrypted namespace.
        let settings_a = store_a.load_settings().unwrap().unwrap();
        assert_eq!(
          settings_a.recording_status,
          ActivityRecordingStatus::Recording
        );
        manager.install_account(
          (3, "a".into()),
          ActivityPersistence::Encrypted(store_a),
          settings_a,
          at(0),
        );
        assert!(manager.is_recording());
        assert!(manager.require_caller(&caller_a).is_err());
        let new_caller_a = ActivityCaller::for_account_test(3, "a");
        assert_eq!(
          manager
            .day_snapshot(
              local_date(at(0)),
              at(5),
              &new_caller_a,
              0,
              ActivityDetailsAccess::Disabled
            )
            .segments
            .len(),
          1
        );
        assert_eq!(
          manager.drafted_for_day(local_date(at(0))).unwrap(),
          vec![marker]
        );
        std::fs::remove_dir_all(root).unwrap();
      }
    }
  }

  #[test]
  fn memory_only_draft_markers_are_unloaded_with_the_linked_account() {
    let mut manager = ActivityManager::new();
    manager.install_account(
      (1, "a".into()),
      ActivityPersistence::MemoryOnly,
      ActivitySettings::default(),
      at(0),
    );
    let day = local_date(at(0));
    manager
      .record_drafted(
        day,
        ActivityDraftedEntry {
          start: at(0).to_rfc3339(),
          end: at(5).to_rfc3339(),
          entry_id: "entry-a".into(),
        },
      )
      .unwrap();
    assert_eq!(manager.drafted_for_day(day).unwrap().len(), 1);
    manager.unload_account(at(5)).unwrap();
    manager.install_account(
      (2, "b".into()),
      ActivityPersistence::MemoryOnly,
      ActivitySettings::default(),
      at(0),
    );
    assert!(manager.drafted_for_day(day).unwrap().is_empty());
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
      window_title: None,
      document: None,
      matter_id: None,
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
    manager
      .exclude_app("WORD", "Word", ActivityHistoryDisposition::Keep)
      .unwrap();

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
      at(0),
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
  fn concurrent_initializers_share_one_key_and_leave_a_decryptable_store() {
    use std::sync::{
      Condvar,
      atomic::{AtomicUsize, Ordering},
      mpsc,
    };
    let root = std::env::temp_dir()
      .join(format!("stella-single-flight-{}", uuid::Uuid::new_v4()));
    let state = Arc::new(Mutex::new(ActivityManager::new()));
    let creations = Arc::new(AtomicUsize::new(0));
    let stored_key = Arc::new(Mutex::new(None));
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let (opened, opening) = mpsc::channel();
    let launch = || {
      let state = Arc::clone(&state);
      let root = root.clone();
      let creations = Arc::clone(&creations);
      let stored_key = Arc::clone(&stored_key);
      let release = Arc::clone(&release);
      let opened = opened.clone();
      std::thread::spawn(move || {
        initialize_account_with(
          &state,
          (1, "account".into()),
          |_| {
            let existing = *stored_key.lock().unwrap();
            opened.send(()).unwrap();
            let (lock, ready) = &*release;
            let mut released = lock.lock().unwrap();
            while !*released {
              released = ready.wait(released).unwrap();
            }
            let key = existing.unwrap_or_else(|| {
              let generation = creations.fetch_add(1, Ordering::SeqCst) + 1;
              let key = [u8::try_from(generation).unwrap(); 32];
              *stored_key.lock().unwrap() = Some(key);
              key
            });
            (
              ActivityPersistence::Encrypted(ActivityStore::new(key, root)),
              ActivitySettings {
                recording_status: ActivityRecordingStatus::Recording,
                ..ActivitySettings::default()
              },
            )
          },
          |_| true,
        )
      })
    };
    let first = launch();
    opening.recv_timeout(Duration::from_secs(5)).unwrap();
    let second = launch();
    let second_opened = opening.recv_timeout(Duration::from_millis(50));
    let (lock, ready) = &*release;
    *lock.lock().unwrap() = true;
    ready.notify_all();
    assert!(first.join().unwrap());
    assert!(!second.join().unwrap());
    assert!(matches!(
      second_opened,
      Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert_eq!(creations.load(Ordering::SeqCst), 1);
    let mut manager = state.lock().unwrap();
    manager.observe(at(0), active("word"));
    manager.observe(at(5), active("word"));
    manager.stop(at(5)).unwrap();
    let key = stored_key.lock().unwrap().unwrap();
    let reopened = ActivityStore::new(key, root.clone());
    let segments = reopened.load_day(local_date(at(0))).unwrap();
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].start, at(0));
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn deleting_a_day_discards_a_zero_duration_open_segment() {
    let mut manager = recording_manager();
    manager.observe(at(0), active("word"));
    assert!(manager.open.is_some());
    assert!(manager.open_pieces().is_empty());
    manager.delete_day(local_date(at(0))).unwrap();
    assert!(manager.open.is_none());
    manager.observe(at(5), active("word"));
    manager.observe(at(10), active("word"));
    manager.stop(at(10)).unwrap();
    assert_eq!(segments(&manager), vec![("word".into(), 5, 10)]);
  }

  #[test]
  fn disabling_the_feature_preserves_linked_retention_processing() {
    for retention in ActivityRetention::ALL {
      let root = std::env::temp_dir()
        .join(format!("stella-gated-retention-{}", uuid::Uuid::new_v4()));
      let store = ActivityStore::new([5; 32], root.clone());
      let mut manager = ActivityManager::new();
      manager.install_account(
        (1, "account".into()),
        ActivityPersistence::Encrypted(store.clone()),
        ActivitySettings {
          recording_status: ActivityRecordingStatus::Recording,
          retention: *retention,
          ..ActivitySettings::default()
        },
        at(0),
      );
      manager.observe(at(0), active("word"));
      manager.observe(at(5), active("word"));
      let generation = manager.observation_generation;
      let state = Arc::new(Mutex::new(manager));
      disable_feature(&state, at(5)).unwrap();
      let mut manager = state.lock().unwrap();
      assert!(manager.is_initialized());
      assert_eq!(manager.namespace.as_deref(), Some("account"));
      assert!(!manager.accepts_observation(generation, false));
      assert!(manager.open.is_none());
      assert_eq!(store.load_day(local_date(at(0))).unwrap().len(), 1);
      assert!(
        manager
          .prune_expired(
            at(0) + chrono::Duration::days(retention.days().try_into().unwrap())
          )
          .unwrap()
      );
      assert!(store.load_day(local_date(at(0))).unwrap().is_empty());
      ActivityStore::remove(&root).unwrap();
    }
  }

  #[test]
  fn initialization_prunes_unreadable_expired_days_before_loading_the_boundary() {
    let root = std::env::temp_dir().join(format!(
      "stella-expired-unreadable-{}",
      uuid::Uuid::new_v4()
    ));
    let store = ActivityStore::new([5; 32], root.clone());
    let mut original = recording_manager();
    original.observe(at(0), active("word"));
    original.observe(at(5), active("word"));
    original.stop(at(5)).unwrap();
    let retained_date = local_date(at(0));
    store
      .save_day(retained_date, original.days.get(&retained_date).unwrap())
      .unwrap();
    let expired_date = retained_date.checked_sub_days(Days::new(40)).unwrap();
    let expired_path = root
      .join("days")
      .join(format!("{}.json.enc", format_date(expired_date)));
    std::fs::write(&expired_path, b"unreadable envelope").unwrap();
    assert!(store.recorded_until().is_err());
    let mut manager = ActivityManager::new();
    manager.install(
      ActivityPersistence::Encrypted(store.clone()),
      original.settings.clone(),
      at(10),
    );
    assert!(!expired_path.exists());
    assert_eq!(
      manager.persistence_status(),
      ActivityPersistenceStatus::Encrypted
    );
    assert!(manager.is_recording());
    assert_eq!(manager.wall_floor, Some(at(5)));
    assert_eq!(store.load_day(retained_date).unwrap().len(), 1);
    manager.observe(at(10), active("outlook"));
    manager.observe(at(15), active("outlook"));
    manager.stop(at(15)).unwrap();
    assert_eq!(store.load_day(retained_date).unwrap().len(), 2);
    ActivityStore::remove(&root).unwrap();
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
      at(0),
    );
    manager.observe(at(0), active("word"));
    manager.observe(at(5), active("word"));
    manager.flush(at(5)).unwrap();

    let mut restarted = ActivityManager::new();
    restarted.install(
      ActivityPersistence::Encrypted(store.clone()),
      ActivitySettings::default(),
      at(0),
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
  fn in_flight_foreground_lookup_cannot_commit_after_gate_or_settings_change() {
    use std::sync::{
      atomic::{AtomicBool, Ordering},
      mpsc,
    };
    for transition in [
      "disable",
      "exclude",
      "pause-resume",
      "delete",
      "unlink",
      "details-off",
      "app-name-only",
      "browser-titles-off",
    ] {
      let mut initial = recording_manager();
      initial.set_capture_details(true, at(0)).unwrap();
      initial
        .set_browser_title_capture("com.google.chrome", "Chrome", true, at(0))
        .unwrap();
      let manager = Arc::new(Mutex::new(initial));
      let enabled = Arc::new(AtomicBool::new(true));
      let (started, lookup_started) = mpsc::channel();
      let (resume, lookup_resumed) = mpsc::channel();
      let sampler_manager = Arc::clone(&manager);
      let sampler_enabled = Arc::clone(&enabled);
      let sampler = std::thread::spawn(move || {
        let generation = sampler_manager.lock().unwrap().observation_generation;
        // The OS lookup holds no manager lock and can finish after a command.
        started.send(()).unwrap();
        lookup_resumed.recv().unwrap();
        sampler_manager
          .lock()
          .unwrap()
          .commit_observation(ObservationCommit {
            generation,
            enabled: sampler_enabled.load(Ordering::SeqCst),
            now: at(5),
            monotonic: Instant::now(),
            idle: Duration::ZERO,
            observation: active_details(if transition == "browser-titles-off" {
              "com.google.chrome"
            } else {
              "word"
            }),
            partition: partition_in(&Local, at(5)),
          })
      });
      lookup_started.recv().unwrap();
      {
        let mut manager = manager.lock().unwrap();
        match transition {
          "disable" => enabled.store(false, Ordering::SeqCst),
          "exclude" => manager
            .exclude_app("word", "Word", ActivityHistoryDisposition::Keep)
            .unwrap(),
          "pause-resume" => {
            manager
              .set_recording_status(ActivityRecordingStatus::Paused, at(0))
              .unwrap();
            manager
              .set_recording_status(ActivityRecordingStatus::Recording, at(0))
              .unwrap();
          }
          "delete" => manager.delete_all().unwrap(),
          "unlink" => manager.unload_account(at(0)).unwrap(),
          "details-off" => {
            manager.set_capture_details(false, at(0)).unwrap();
          }
          "app-name-only" => manager
            .set_app_detail_capture(
              "word",
              "Word",
              ActivityAppDetailCapture::AppNameOnly,
              at(0),
            )
            .unwrap(),
          "browser-titles-off" => manager
            .set_browser_title_capture("com.google.chrome", "Chrome", false, at(0))
            .unwrap(),
          _ => unreachable!(),
        }
      }
      resume.send(()).unwrap();
      assert!(sampler.join().unwrap().is_none(), "{transition}");
      let manager = manager.lock().unwrap();
      assert!(manager.open.is_none(), "{transition}");
      assert!(manager.days.is_empty(), "{transition}");
    }
  }

  #[test]
  fn pending_observations_are_discarded_after_every_recording_boundary() {
    for transition in 0..5 {
      let mut manager = recording_manager();
      let generation = manager.observation_generation;
      match transition {
        0 => {
          manager.stop(at(0)).unwrap();
        }
        1 => {
          manager
            .set_recording_status(ActivityRecordingStatus::Paused, at(0))
            .unwrap();
          manager
            .set_recording_status(ActivityRecordingStatus::Recording, at(0))
            .unwrap();
        }
        2 => {
          manager
            .exclude_app("word", "Word", ActivityHistoryDisposition::Keep)
            .unwrap();
        }
        3 => {
          manager.delete_day(local_date(at(0))).unwrap();
        }
        _ => {
          manager.delete_all().unwrap();
        }
      }
      assert!(!manager.accepts_observation(generation, true));
      assert!(!manager.accepts_observation(manager.observation_generation, false));
      assert!(manager.open.is_none());
    }
  }

  #[test]
  fn exclusions_revalidate_at_observation_commit_and_history_choice_is_respected() {
    for disposition in [
      ActivityHistoryDisposition::Keep,
      ActivityHistoryDisposition::Delete,
    ] {
      let mut manager = recording_manager();
      manager.observe(at(0), active("word"));
      manager.observe(at(5), active("word"));
      manager.exclude_app("word", "Word", disposition).unwrap();
      manager.observe(at(10), active("word"));
      assert!(manager.open.is_none());
      match disposition {
        ActivityHistoryDisposition::Keep => {
          assert_eq!(segments(&manager), [("word".into(), 0, 5)])
        }
        ActivityHistoryDisposition::Delete => assert!(segments(&manager).is_empty()),
      }
    }
  }

  #[test]
  fn every_stop_and_flush_before_idle_threshold_persists_only_input_confirmed_time() {
    for stop_second in [10, 60, 120, 240, 299] {
      let root = std::env::temp_dir()
        .join(format!("stella-idle-prefix-{}", uuid::Uuid::new_v4()));
      let store = ActivityStore::new([3; 32], root.clone());
      let mut manager = recording_manager();
      manager.persistence = ActivityPersistence::Encrypted(store.clone());
      let clock = Instant::now();
      manager.observe_at(
        at(0),
        clock,
        Duration::ZERO,
        active("word"),
        partition_in(&Local, at(0)),
      );
      manager.observe_at(
        at(5),
        clock + Duration::from_secs(5),
        Duration::ZERO,
        active("word"),
        partition_in(&Local, at(5)),
      );
      for second in (10..=stop_second).step_by(5) {
        manager.observe_at(
          at(second),
          clock + Duration::from_secs(second as u64),
          Duration::from_secs((second - 5) as u64),
          active("word"),
          partition_in(&Local, at(second)),
        );
      }
      manager.flush(at(stop_second)).unwrap();
      let persisted = store.load_day(local_date(at(0))).unwrap();
      assert_eq!(persisted[0].end, at(5));
      manager.stop(at(stop_second)).unwrap();
      assert_eq!(store.load_day(local_date(at(0))).unwrap()[0].end, at(5));
      ActivityStore::remove(&root).unwrap();
    }
  }

  #[test]
  fn resumed_input_never_reintroduces_observed_idle_across_apps_or_days() {
    let zone = FixedOffset::east_opt(0).unwrap();
    let start = Utc.with_ymd_and_hms(2026, 3, 10, 23, 59, 40).unwrap();
    for switch_app in [false, true] {
      let root = std::env::temp_dir()
        .join(format!("stella-idle-resume-{}", uuid::Uuid::new_v4()));
      let store = ActivityStore::new([3; 32], root.clone());
      let mut manager = recording_manager();
      manager.persistence = ActivityPersistence::Encrypted(store.clone());
      let clock = Instant::now();
      for (second, idle) in [
        (0, 0),
        (5, 0),
        (10, 5),
        (15, 10),
        (20, 0),
        (25, 0),
        (30, 5),
        (35, 10),
        (40, 0),
        (45, 0),
      ] {
        let now = start + chrono::Duration::seconds(second);
        let app = if switch_app && (15..35).contains(&second) {
          "mail"
        } else {
          "word"
        };
        manager.observe_at(
          now,
          clock + Duration::from_secs(second as u64),
          Duration::from_secs(idle),
          active(app),
          partition_in(&zone, now),
        );
        manager.flush(now).unwrap();
      }
      manager.stop(start + chrono::Duration::seconds(45)).unwrap();
      let mut intervals = store
        .day_dates()
        .unwrap()
        .into_iter()
        .flat_map(|date| store.load_day(date).unwrap())
        .collect::<Vec<_>>();
      intervals.sort_by_key(|segment| segment.start);
      assert_eq!(
        intervals
          .iter()
          .map(|segment| (segment.end - segment.start).num_seconds())
          .sum::<i64>(),
        15
      );
      for segment in &intervals {
        for (idle_start, idle_end) in [(5, 20), (25, 40)] {
          let idle_start = start + chrono::Duration::seconds(idle_start);
          let idle_end = start + chrono::Duration::seconds(idle_end);
          assert!(segment.end <= idle_start || segment.start >= idle_end);
        }
      }
      for pair in intervals.windows(2) {
        assert!(pair[0].end <= pair[1].start);
      }
      ActivityStore::remove(&root).unwrap();
    }
  }

  #[test]
  fn continuously_advancing_input_evidence_keeps_sustained_activity() {
    let mut manager = recording_manager();
    let clock = Instant::now();
    for second in [0, 5, 10, 15] {
      let idle = if second == 0 {
        Duration::ZERO
      } else {
        Duration::from_millis(200)
      };
      manager.observe_at(
        at(second),
        clock + Duration::from_secs(second as u64),
        idle,
        active("word"),
        partition_in(&Local, at(second)),
      );
    }
    manager.stop(at(15)).unwrap();
    let recorded = manager.days.values().flatten().collect::<Vec<_>>();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].start, at(0));
    assert_eq!(
      recorded[0].end,
      at(15) - chrono::Duration::milliseconds(200)
    );
  }

  #[test]
  fn resumed_input_before_midnight_is_attributed_from_the_next_foreground_sample() {
    let zone = FixedOffset::east_opt(0).unwrap();
    let start = Utc.with_ymd_and_hms(2026, 3, 10, 23, 59, 45).unwrap();
    let root = std::env::temp_dir()
      .join(format!("stella-midnight-resume-{}", uuid::Uuid::new_v4()));
    let store = ActivityStore::new([3; 32], root.clone());
    let mut manager = recording_manager();
    manager.persistence = ActivityPersistence::Encrypted(store.clone());
    let clock = Instant::now();
    for (second, idle) in [(0, 0), (5, 0), (10, 5), (15, 1), (20, 0)] {
      let now = start + chrono::Duration::seconds(second);
      manager.observe_at(
        now,
        clock + Duration::from_secs(second as u64),
        Duration::from_secs(idle),
        active("word"),
        partition_in(&zone, now),
      );
      manager.flush(now).unwrap();
    }
    manager.stop(start + chrono::Duration::seconds(20)).unwrap();
    let mut recorded = Vec::new();
    for date in store.day_dates().unwrap() {
      for segment in store.load_day(date).unwrap() {
        assert_eq!(segment.start.with_timezone(&zone).date_naive(), date);
        assert_eq!(
          (segment.end - chrono::Duration::nanoseconds(1))
            .with_timezone(&zone)
            .date_naive(),
          date
        );
        recorded.push(segment);
      }
    }
    recorded.sort_by_key(|segment| segment.start);
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[0].start, start);
    assert_eq!(recorded[0].end, start + chrono::Duration::seconds(5));
    assert_eq!(recorded[1].start, start + chrono::Duration::seconds(15));
    assert_eq!(recorded[1].end, start + chrono::Duration::seconds(20));
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn fractional_idle_at_the_initial_sample_keeps_advancing_input_activity() {
    let mut manager = recording_manager();
    let clock = Instant::now();
    for second in [0, 5, 10] {
      manager.observe_at(
        at(second),
        clock + Duration::from_secs(second as u64),
        Duration::from_millis(200),
        active("word"),
        partition_in(&Local, at(second)),
      );
    }
    manager.stop(at(10)).unwrap();
    let recorded = manager.days.values().flatten().collect::<Vec<_>>();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].start, at(5));
    assert_eq!(
      recorded[0].end,
      at(10) - chrono::Duration::milliseconds(200)
    );
  }

  #[test]
  fn persisted_overlap_is_discarded_before_flush_or_close() {
    let root = std::env::temp_dir()
      .join(format!("stella-clock-restart-{}", uuid::Uuid::new_v4()));
    let store = ActivityStore::new([3; 32], root.clone());
    let day = local_date(at(0));
    store
      .save_day(
        day,
        &[ActivitySegment {
          app_identifier: "word".into(),
          app_name: "Word".into(),
          window_title: None,
          document: None,
          matter_id: None,
          start: at(0),
          end: at(10),
        }],
      )
      .unwrap();
    let mut manager = recording_manager();
    manager.persistence = ActivityPersistence::Encrypted(store.clone());
    manager.observe(at(5), active("mail"));
    manager.observe(at(10), active("mail"));
    manager.flush(at(10)).unwrap();
    assert_eq!(store.load_day(day).unwrap().len(), 1);
    manager.observe(at(15), active("mail"));
    manager.stop(at(15)).unwrap();
    let persisted = store.load_day(day).unwrap();
    assert_eq!(persisted.len(), 2);
    assert_eq!(persisted[0].end, persisted[1].start);
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn excluding_with_delete_removes_cold_encrypted_history_and_preserves_other_apps() {
    let root = std::env::temp_dir()
      .join(format!("stella-excluded-history-{}", uuid::Uuid::new_v4()));
    let store = ActivityStore::new([3; 32], root.clone());
    let day = local_date(at(0));
    let segment = |app: &str, start, end| ActivitySegment {
      app_identifier: app.into(),
      app_name: app.into(),
      window_title: Some(format!("{app} title")),
      document: Some(format!("/private/{app}.docx")),
      matter_id: None,
      start: at(start),
      end: at(end),
    };
    store
      .save_day(day, &[segment("word", 0, 5), segment("mail", 5, 10)])
      .unwrap();
    let mut manager = recording_manager();
    manager.persistence = ActivityPersistence::Encrypted(store.clone());
    manager
      .exclude_app("word", "Word", ActivityHistoryDisposition::Delete)
      .unwrap();
    assert_eq!(store.load_day(day).unwrap(), [segment("mail", 5, 10)]);
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn clock_corrections_never_overlap_intervals_or_delay_monotonic_flush() {
    for correction in [-120, -10, 10, 120, 3600] {
      let mut manager = recording_manager();
      let clock = Instant::now();
      for (tick, wall, app) in [
        (0, 0, "a"),
        (5, 5, "a"),
        (10, 10, "b"),
        (15, 15 + correction, "b"),
        (20, 20 + correction, "c"),
        (25, 25 + correction, "c"),
      ] {
        manager.observe_at(
          at(wall),
          clock + Duration::from_secs(tick),
          Duration::ZERO,
          active(app),
          partition_in(&Local, at(wall)),
        );
      }
      manager.stop(at(30 + correction)).unwrap();
      let all = manager.days.values().flatten().collect::<Vec<_>>();
      for pair in all.windows(2) {
        assert!(pair[0].end <= pair[1].start);
      }
      assert!(all.iter().all(|segment| segment.start < segment.end));
      assert!(
        all
          .iter()
          .map(|segment| (segment.end - segment.start).num_seconds())
          .sum::<i64>()
          <= 25
      );
      manager.last_flush = Some(clock);
      assert!(!manager.flush_due(clock + Duration::from_secs(59)));
      assert!(manager.flush_due(clock + Duration::from_secs(60)));
    }
  }

  // A pinned timezone with one transition supplies gap, fold and whole-date
  // cases without depending on the host zone or adding a timezone database.
  #[derive(Clone)]
  struct TransitionZone {
    before: FixedOffset,
    after: FixedOffset,
    transition: chrono::NaiveDateTime,
    local_lookups: std::cell::Cell<usize>,
  }

  impl TimeZone for TransitionZone {
    type Offset = FixedOffset;
    fn from_offset(offset: &FixedOffset) -> Self {
      Self {
        before: *offset,
        after: *offset,
        transition: chrono::NaiveDateTime::MIN,
        local_lookups: std::cell::Cell::new(0),
      }
    }
    fn offset_from_local_date(
      &self,
      date: &NaiveDate,
    ) -> chrono::MappedLocalTime<FixedOffset> {
      self.offset_from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
    }
    fn offset_from_local_datetime(
      &self,
      local: &chrono::NaiveDateTime,
    ) -> chrono::MappedLocalTime<FixedOffset> {
      self.local_lookups.set(self.local_lookups.get() + 1);
      let valid = |offset: FixedOffset| {
        let utc =
          *local - chrono::Duration::seconds(i64::from(offset.local_minus_utc()));
        self.offset_from_utc_datetime(&utc) == offset
      };
      match (valid(self.before), valid(self.after)) {
        (true, true) if self.before != self.after => {
          if self.before.local_minus_utc() > self.after.local_minus_utc() {
            chrono::MappedLocalTime::Ambiguous(self.before, self.after)
          } else {
            chrono::MappedLocalTime::Ambiguous(self.after, self.before)
          }
        }
        (true, _) => chrono::MappedLocalTime::Single(self.before),
        (_, true) => chrono::MappedLocalTime::Single(self.after),
        _ => chrono::MappedLocalTime::None,
      }
    }
    fn offset_from_utc_date(&self, date: &NaiveDate) -> FixedOffset {
      self.offset_from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
    }
    fn offset_from_utc_datetime(&self, utc: &chrono::NaiveDateTime) -> FixedOffset {
      if *utc < self.transition {
        self.before
      } else {
        self.after
      }
    }
  }

  #[test]
  fn day_boundaries_resolve_midnight_gaps_folds_and_skipped_dates() {
    for (before, after, transition) in [
      (0, 64, Utc.with_ymd_and_hms(2026, 3, 10, 0, 0, 0).unwrap()),
      (
        0,
        86399,
        Utc.with_ymd_and_hms(2026, 3, 10, 0, 0, 0).unwrap(),
      ),
      (
        -3 * 3600,
        -2 * 3600,
        Utc.with_ymd_and_hms(2018, 11, 4, 3, 0, 0).unwrap(),
      ),
      (
        -2 * 3600,
        -3 * 3600,
        Utc.with_ymd_and_hms(2018, 2, 18, 3, 0, 0).unwrap(),
      ),
      (
        -10 * 3600,
        14 * 3600,
        Utc.with_ymd_and_hms(2011, 12, 30, 10, 0, 0).unwrap(),
      ),
    ] {
      let zone = TransitionZone {
        before: FixedOffset::east_opt(before).unwrap(),
        after: FixedOffset::east_opt(after).unwrap(),
        transition: transition.naive_utc(),
        local_lookups: std::cell::Cell::new(0),
      };
      if before > after {
        let fold_date = NaiveDate::from_ymd_opt(2018, 2, 18).unwrap();
        assert!(matches!(
          zone.from_local_datetime(&fold_date.and_hms_opt(0, 0, 0).unwrap()),
          chrono::MappedLocalTime::Ambiguous(_, _)
        ));
        assert_eq!(
          day_start(&zone, fold_date),
          Utc.with_ymd_and_hms(2018, 2, 18, 2, 0, 0).unwrap()
        );
      }
      let original = ActivitySegment {
        app_identifier: "word".into(),
        app_name: "Word".into(),
        window_title: None,
        document: None,
        matter_id: None,
        start: transition - chrono::Duration::seconds(5),
        end: transition + chrono::Duration::seconds(5),
      };
      let boundary_date = original
        .start
        .with_timezone(&zone)
        .date_naive()
        .succ_opt()
        .unwrap();
      zone.local_lookups.set(0);
      let boundary = day_start(&zone, boundary_date);
      assert!(zone.local_lookups.get() < 1600);
      assert!(boundary > original.start);
      if after > before {
        assert_eq!(boundary, transition);
      }
      let pieces = split_by_day_in(&zone, original.clone());
      assert_eq!(
        pieces
          .iter()
          .map(|(_, piece)| (piece.end - piece.start).num_seconds())
          .sum::<i64>(),
        10
      );
      assert_eq!(pieces.first().unwrap().1.start, original.start);
      assert_eq!(pieces.last().unwrap().1.end, original.end);
      for (date, piece) in pieces {
        assert_eq!(piece.start.with_timezone(&zone).date_naive(), date);
        assert_eq!(
          (piece.end - chrono::Duration::nanoseconds(1))
            .with_timezone(&zone)
            .date_naive(),
          date
        );
      }
    }
  }

  #[test]
  fn restart_in_a_different_zone_cannot_overlap_retained_account_history() {
    let root = std::env::temp_dir().join(format!(
      "stella-zone-clock-restart-{}",
      uuid::Uuid::new_v4()
    ));
    let store = ActivityStore::new([3; 32], root.clone());
    let utc = FixedOffset::east_opt(0).unwrap();
    let west = FixedOffset::west_opt(3600).unwrap();
    let start = Utc.with_ymd_and_hms(2026, 3, 10, 0, 30, 0).unwrap();
    let settings = ActivitySettings {
      recording_status: ActivityRecordingStatus::Recording,
      ..ActivitySettings::default()
    };
    let mut first = ActivityManager::new();
    first.install_account(
      (1, "same-account".into()),
      ActivityPersistence::Encrypted(store.clone()),
      settings.clone(),
      at(0),
    );
    let clock = Instant::now();
    for second in [0, 5, 10, 15] {
      let now = start + chrono::Duration::seconds(second);
      first.observe_at(
        now,
        clock + Duration::from_secs(second as u64),
        Duration::ZERO,
        active("word"),
        partition_in(&utc, now),
      );
    }
    first.stop(start + chrono::Duration::seconds(15)).unwrap();
    let mut restarted = ActivityManager::new();
    restarted.install_account(
      (2, "same-account".into()),
      ActivityPersistence::Encrypted(store.clone()),
      settings,
      at(0),
    );
    assert_eq!(restarted.namespace.as_deref(), Some("same-account"));
    assert_eq!(
      restarted.wall_floor,
      Some(start + chrono::Duration::seconds(15))
    );
    for second in [5, 10, 15, 20] {
      let now = start + chrono::Duration::seconds(second);
      restarted.observe_at(
        now,
        clock + Duration::from_secs((second - 5) as u64),
        Duration::ZERO,
        active("mail"),
        partition_in(&west, now),
      );
      restarted.flush(now).unwrap();
    }
    restarted
      .stop(start + chrono::Duration::seconds(20))
      .unwrap();
    let mut intervals = store
      .day_dates()
      .unwrap()
      .into_iter()
      .flat_map(|date| store.load_day(date).unwrap())
      .collect::<Vec<_>>();
    intervals.sort_by_key(|segment| segment.start);
    assert_eq!(intervals.len(), 2);
    assert_eq!(intervals[0].start, start);
    assert_eq!(intervals[0].end, intervals[1].start);
    assert_eq!(intervals[1].end, start + chrono::Duration::seconds(20));
    assert_eq!(store.day_dates().unwrap().len(), 2);
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn an_unreadable_retained_day_prevents_recording_after_installation() {
    let root = std::env::temp_dir().join(format!(
      "stella-unreadable-boundary-{}",
      uuid::Uuid::new_v4()
    ));
    let store = ActivityStore::new([3; 32], root.clone());
    let path = root.join("days/2026-03-10.json.enc");
    local_store::create_private_dir(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"unreadable ciphertext").unwrap();
    let mut manager = ActivityManager::new();
    manager.install_account(
      (1, "same-account".into()),
      ActivityPersistence::Encrypted(store),
      ActivitySettings {
        recording_status: ActivityRecordingStatus::Recording,
        ..ActivitySettings::default()
      },
      at(0),
    );
    assert_eq!(
      manager.persistence_status(),
      ActivityPersistenceStatus::DeletionOnly
    );
    assert!(!manager.is_recording());
    assert!(!manager.accepts_observation(manager.observation_generation, true));
    assert_eq!(
      manager.settings.recording_status,
      ActivityRecordingStatus::Off
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"unreadable ciphertext");
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn timezone_changes_keep_flushed_prefixes_in_their_opening_partition_once() {
    let root =
      std::env::temp_dir().join(format!("stella-zone-prefix-{}", uuid::Uuid::new_v4()));
    let store = ActivityStore::new([3; 32], root.clone());
    let mut manager = recording_manager();
    manager.persistence = ActivityPersistence::Encrypted(store.clone());
    let utc = FixedOffset::east_opt(0).unwrap();
    let west = FixedOffset::west_opt(3600).unwrap();
    let start = Utc.with_ymd_and_hms(2026, 3, 10, 0, 30, 0).unwrap();
    let clock = Instant::now();
    for second in [0, 5] {
      let now = start + chrono::Duration::seconds(second);
      manager.observe_at(
        now,
        clock + Duration::from_secs(second as u64),
        Duration::ZERO,
        active("word"),
        partition_in(&utc, now),
      );
    }
    manager.flush(start).unwrap();
    for second in [10, 15] {
      let now = start + chrono::Duration::seconds(second);
      manager.observe_at(
        now,
        clock + Duration::from_secs(second as u64),
        Duration::ZERO,
        active("word"),
        partition_in(&west, now),
      );
    }
    manager.stop(start).unwrap();
    let mut intervals = store
      .day_dates()
      .unwrap()
      .into_iter()
      .flat_map(|date| store.load_day(date).unwrap())
      .collect::<Vec<_>>();
    intervals.sort_by_key(|segment| segment.start);
    assert_eq!(
      intervals
        .iter()
        .map(|segment| (segment.end - segment.start).num_seconds())
        .sum::<i64>(),
      15
    );
    for pair in intervals.windows(2) {
      assert_eq!(pair[0].end, pair[1].start);
    }
    ActivityStore::remove(&root).unwrap();
  }

  #[test]
  fn deletion_only_still_expires_day_files_without_reading_their_contents() {
    let root =
      std::env::temp_dir().join(format!("stella-retention-{}", uuid::Uuid::new_v4()));
    let store = ActivityStore::new([3; 32], root.clone());
    let date = local_date(at(0));
    store
      .save_day(
        date,
        &[ActivitySegment {
          app_identifier: "word".into(),
          app_name: "Word".into(),
          window_title: None,
          document: None,
          matter_id: None,
          start: at(0),
          end: at(5),
        }],
      )
      .unwrap();
    let mut manager = ActivityManager::new();
    manager.install(
      ActivityPersistence::DeletionOnly(root.clone()),
      ActivitySettings::default(),
      at(0),
    );
    assert!(
      manager
        .prune_expired(at(0) + chrono::Duration::days(40))
        .unwrap()
    );
    assert!(store.load_day(date).unwrap().is_empty());
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
    assert_eq!(contract["maxMetadataBytes"], MAX_DETAIL_BYTES);
    let details_access = ActivityDetailsAccess::ALL
      .iter()
      .map(|access| serde_json::to_value(access).unwrap())
      .collect::<Vec<_>>();
    assert_eq!(
      contract["detailsAccess"],
      serde_json::Value::Array(details_access)
    );
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
