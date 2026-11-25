//! Whether Activity may record, and what it keeps and shows when it cannot.
//!
//! The encrypted store opens only for an account Activity may record for, so
//! a small plain record per account namespace keeps what the app needs while
//! that store is closed: the member's recording choice and the server's last
//! answer about Activity (a confirmed grant's times, or the refusal's
//! reason). A second plain file per namespace keeps the stretches the member
//! wanted recorded but Activity could not record (`CaptureOutage`: start,
//! end, reason). Neither holds anything recorded.
//!
//! Server actions follow the live decision only. Until the server is reached
//! after a start, local recording follows the last answer: a confirmed grant
//! stands until its credential expires, and a refusal stands as a stop. Any
//! new answer replaces it.
//!
//! The sampler checks the state every few seconds. The tray reads the last
//! result; the first check of each stop shows one system notification while
//! the member's choice is Recording, and leaving the stop ends it.

use std::{
  path::{Path, PathBuf},
  sync::Mutex,
  time::Duration,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::{
  activity::{ActivityAppState, ActivityRecordingStatus},
  config::APP_DATA_DIR_NAME,
  feature_gate::{DesktopFeature, FeatureAccess, FeatureGates, OffReason},
};

const RECORDS_DIR_NAME: &str = "activity-capture";
const RECORD_SUFFIX: &str = "json";
const OUTAGES_SUFFIX: &str = "outages.json";
const MAX_RECORD_BYTES: u64 = 4 * 1024;
const MAX_OUTAGES_BYTES: u64 = 512 * 1024;
/// Enough for a stop every working minute of a long day, for weeks.
const MAX_OUTAGES: usize = 2048;
/// The longest Activity keeps a day (`ActivityRetention::Quarter`).
const OUTAGE_RETENTION: chrono::Duration = chrono::Duration::days(90);
/// How long Activity waits for a first answer from the server, with no
/// confirmed grant to record on, before it reports the stop.
pub(crate) const CONFIRMATION_WAIT: Duration = Duration::from_secs(2 * 60);
/// A confirmed grant is written again at most this often while it stands.
const GRANT_REFRESH: chrono::Duration = chrono::Duration::hours(1);
/// An open outage reaches its file at least this often.
const OUTAGE_FLUSH: Duration = Duration::from_secs(60);
/// The wall clock may drift this far from the monotonic clock between two
/// checks before an open outage is ended at the earlier check.
const WALL_CLOCK_TOLERANCE: Duration = Duration::from_secs(1);

/// Why Activity cannot record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
  ReconnectNeeded,
  NotAvailable,
  BlockedByPolicy,
  SignedOut,
  /// The server has not been reached since the app started and no grant was
  /// confirmed before.
  NotConfirmed,
}

impl StopReason {
  #[cfg(test)]
  pub const ALL: &'static [Self] = &[
    Self::ReconnectNeeded,
    Self::NotAvailable,
    Self::BlockedByPolicy,
    Self::SignedOut,
    Self::NotConfirmed,
  ];

  pub const fn tray_key(self) -> &'static str {
    match self {
      Self::ReconnectNeeded => "tray.activityStoppedReconnect",
      Self::NotAvailable => "tray.activityStoppedNotAvailable",
      Self::BlockedByPolicy => "tray.activityStoppedPolicy",
      Self::SignedOut => "tray.activityStoppedSignedOut",
      Self::NotConfirmed => "tray.activityStoppedNotConfirmed",
    }
  }

  const fn notification_key(self) -> &'static str {
    match self {
      Self::ReconnectNeeded => "notification.activityStoppedReconnectBody",
      Self::NotAvailable => "notification.activityStoppedNotAvailableBody",
      Self::BlockedByPolicy => "notification.activityStoppedPolicyBody",
      Self::SignedOut => "notification.activityStoppedSignedOutBody",
      Self::NotConfirmed => "notification.activityStoppedNotConfirmedBody",
    }
  }

  /// Whether linking the account again lets Activity record.
  pub const fn reconnect_helps(self) -> bool {
    match self {
      Self::ReconnectNeeded | Self::SignedOut => true,
      Self::NotAvailable | Self::BlockedByPolicy | Self::NotConfirmed => false,
    }
  }
}

/// Activity cannot record for an account whose member turned it on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivityStopped {
  pub reason: StopReason,
  pub intent: ActivityRecordingStatus,
}

/// A grant the server confirmed, and the expiry of the credential it was
/// confirmed with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmedGrant {
  confirmed_at: DateTime<Utc>,
  expires_at: DateTime<Utc>,
}

/// The server's last answer about Activity for one account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum LastAnswer {
  Granted(ConfirmedGrant),
  Refused { reason: StopReason },
}

/// What Activity may do for the decided account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Permission {
  Live,
  /// No answer since the app started; the confirmed grant stands until
  /// `until`, the earlier of its credential's and the current credential's
  /// expiry.
  Remembered {
    until: DateTime<Utc>,
  },
  /// No answer yet and no grant to record on.
  Pending,
  Stopped(StopReason),
}

fn permission(
  access: FeatureAccess,
  last_answer: Option<LastAnswer>,
  credential_expiry: Option<DateTime<Utc>>,
  now: DateTime<Utc>,
) -> Permission {
  let reason = match access {
    FeatureAccess::Enabled => return Permission::Live,
    FeatureAccess::Off(reason) => reason,
  };
  match reason {
    OffReason::Undecided => match (last_answer, credential_expiry) {
      (Some(LastAnswer::Granted(grant)), Some(expiry))
        if now < grant.expires_at.min(expiry) =>
      {
        Permission::Remembered {
          until: grant.expires_at.min(expiry),
        }
      }
      (Some(LastAnswer::Refused { reason }), _) => Permission::Stopped(reason),
      (Some(LastAnswer::Granted(_)) | None, _) => Permission::Pending,
    },
    OffReason::BlockedByPolicy => Permission::Stopped(StopReason::BlockedByPolicy),
    OffReason::SignedOut => Permission::Stopped(StopReason::SignedOut),
    OffReason::ReconnectNeeded => Permission::Stopped(StopReason::ReconnectNeeded),
    OffReason::NotAvailable => Permission::Stopped(StopReason::NotAvailable),
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureView {
  /// Nothing to show: Activity is off for an account whose member never
  /// turned it on, or the first answer is still being waited for.
  Hidden,
  /// Activity may record.
  Live,
  Stopped(ActivityStopped),
}

fn capture_view(
  permission: Permission,
  intent: Option<ActivityRecordingStatus>,
  waited_for_confirmation: bool,
) -> CaptureView {
  let reason = match permission {
    Permission::Live | Permission::Remembered { .. } => return CaptureView::Live,
    Permission::Pending if waited_for_confirmation => StopReason::NotConfirmed,
    Permission::Pending => return CaptureView::Hidden,
    Permission::Stopped(reason) => reason,
  };
  match intent {
    Some(
      intent @ (ActivityRecordingStatus::Recording | ActivityRecordingStatus::Paused),
    ) => CaptureView::Stopped(ActivityStopped { reason, intent }),
    None | Some(ActivityRecordingStatus::Off) => CaptureView::Hidden,
  }
}

/// One stop, from the first check that sees it to the first that does not.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Episode {
  #[default]
  Clear,
  Notified,
}

impl Episode {
  /// The next episode, and whether this check notifies the member.
  fn next(self, view: CaptureView) -> (Self, bool) {
    match view {
      CaptureView::Stopped(ActivityStopped {
        intent: ActivityRecordingStatus::Recording,
        ..
      }) => (Self::Notified, self == Self::Clear),
      // A paused member is told nothing, and the episode stands.
      CaptureView::Stopped(_) => (self, false),
      CaptureView::Live | CaptureView::Hidden => (Self::Clear, false),
    }
  }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRecord {
  #[serde(default)]
  intent: ActivityRecordingStatus,
  #[serde(default)]
  answer: Option<LastAnswer>,
}

/// A stretch the member wanted recorded and Activity could not record. It
/// holds times and the reason only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOutage {
  pub start: DateTime<Utc>,
  pub end: DateTime<Utc>,
  pub reason: StopReason,
}

/// Record files are read, changed and written whole; one writer at a time.
static RECORD_WRITES: Mutex<()> = Mutex::new(());

/// The plain per-namespace files.
pub struct CaptureRecords {
  dir: PathBuf,
}

impl CaptureRecords {
  pub fn in_app_data() -> Option<Self> {
    dirs::data_dir().map(|dir| Self {
      dir: dir.join(APP_DATA_DIR_NAME).join(RECORDS_DIR_NAME),
    })
  }

  #[cfg(test)]
  pub(crate) fn at(dir: PathBuf) -> Self {
    Self { dir }
  }

  fn path(&self, namespace: &str, suffix: &str) -> Result<PathBuf, String> {
    if !crate::activity_store::ActivityStore::is_account_namespace(namespace) {
      return Err("activity capture namespace is invalid".to_string());
    }
    Ok(self.dir.join(format!("{namespace}.{suffix}")))
  }

  fn load(&self, namespace: &str) -> Result<Option<CaptureRecord>, String> {
    read_json(&self.path(namespace, RECORD_SUFFIX)?, MAX_RECORD_BYTES)
  }

  fn write<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), String> {
    crate::local_store::create_private_dir(&self.dir).map_err(
      crate::logging::with_cause_logged("activity capture folder failed"),
    )?;
    let bytes = serde_json::to_vec(value).map_err(
      crate::logging::with_cause_logged("activity capture file failed"),
    )?;
    crate::local_store::write_private_atomic(path, &bytes)
  }

  /// Changes one namespace's record and writes it when it changed.
  fn update(
    &self,
    namespace: &str,
    change: impl FnOnce(&mut CaptureRecord),
  ) -> Result<CaptureRecord, String> {
    let _writing = RECORD_WRITES
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous = self.load(namespace)?.unwrap_or_default();
    let mut record = previous.clone();
    change(&mut record);
    // A missing record reads as the default, so none is created for it.
    if record != previous {
      self.write(&self.path(namespace, RECORD_SUFFIX)?, &record)?;
    }
    Ok(record)
  }

  pub(crate) fn load_outages(
    &self,
    namespace: &str,
  ) -> Result<Vec<CaptureOutage>, String> {
    Ok(
      read_json(&self.path(namespace, OUTAGES_SUFFIX)?, MAX_OUTAGES_BYTES)?
        .unwrap_or_default(),
    )
  }

  fn save_outages(
    &self,
    namespace: &str,
    outages: &[CaptureOutage],
  ) -> Result<(), String> {
    self.write(&self.path(namespace, OUTAGES_SUFFIX)?, &outages)
  }
}

fn read_json<T: serde::de::DeserializeOwned>(
  path: &Path,
  max_bytes: u64,
) -> Result<Option<T>, String> {
  match std::fs::symlink_metadata(path) {
    Ok(metadata) if metadata.file_type().is_file() => {
      if metadata.len() > max_bytes {
        return Err("activity capture file is too large".to_string());
      }
    }
    Ok(_) => return Err("activity capture file is not a file".to_string()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => {
      return Err(crate::logging::with_cause_logged(
        "activity capture file could not be inspected",
      )(error));
    }
  }
  let bytes = std::fs::read(path).map_err(crate::logging::with_cause_logged(
    "activity capture file could not be read",
  ))?;
  serde_json::from_slice(&bytes)
    .map(Some)
    .map_err(crate::logging::with_cause_logged(
      "activity capture file is unreadable",
    ))
}

/// Keeps the last answer in step with a new decision: one that enables
/// Activity confirms the grant, a refusal replaces it with its reason, and a
/// decision that says nothing about the account (no answer yet, or managed
/// policy) leaves it.
pub(crate) fn record_decision(
  gates: &FeatureGates,
  records: &CaptureRecords,
  now: DateTime<Utc>,
) -> Result<(), String> {
  let Some(namespace) = gates.namespace() else {
    return Ok(());
  };
  let refused = |reason| {
    records
      .update(&namespace, |record| {
        record.answer = Some(LastAnswer::Refused { reason });
      })
      .map(|_record| ())
  };
  match gates.access_at(DesktopFeature::ActivityTimeline, now) {
    FeatureAccess::Enabled => {
      let Some(expires_at) = gates.credential_expiry() else {
        return Ok(());
      };
      records
        .update(&namespace, |record| {
          let current = match record.answer {
            Some(LastAnswer::Granted(grant))
              if grant.expires_at == expires_at
                && grant.confirmed_at <= now
                && now - grant.confirmed_at < GRANT_REFRESH =>
            {
              grant
            }
            Some(LastAnswer::Granted(_) | LastAnswer::Refused { .. }) | None => {
              ConfirmedGrant {
                confirmed_at: now,
                expires_at,
              }
            }
          };
          record.answer = Some(LastAnswer::Granted(current));
        })
        .map(|_record| ())
    }
    FeatureAccess::Off(OffReason::NotAvailable) => refused(StopReason::NotAvailable),
    FeatureAccess::Off(OffReason::ReconnectNeeded) => {
      refused(StopReason::ReconnectNeeded)
    }
    FeatureAccess::Off(OffReason::SignedOut) => refused(StopReason::SignedOut),
    FeatureAccess::Off(OffReason::Undecided | OffReason::BlockedByPolicy) => Ok(()),
  }
}

/// Keeps the last answer after every installed decision, before any toggle
/// is applied, so a refusal is kept even when the app quits right after it.
pub(crate) fn decision_installed(_app: &AppHandle, gates: &FeatureGates) {
  let Some(records) = CaptureRecords::in_app_data() else {
    return;
  };
  if record_decision(gates, &records, Utc::now()).is_err() {
    // The cause is logged where the write failed.
    tracing::warn!("activity answer was not recorded");
  }
}

/// The account whose Activity store is open and its member's choice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoadedChoice {
  pub namespace: String,
  pub intent: ActivityRecordingStatus,
  /// Whether the store is on disk, so the choice outlives this process.
  pub persisted: bool,
}

/// What other threads read from the last check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Published {
  /// Activity records on a confirmed grant for this binding until `until`.
  Remembered {
    binding: (u64, String),
    until: DateTime<Utc>,
  },
  /// Activity is stopped; the binding names the account whose history stays
  /// readable, when one is linked.
  Stopped {
    binding: Option<(u64, String)>,
    stopped: ActivityStopped,
  },
}

/// The account Activity may record for: the server enabled it, or it
/// records on a confirmed grant while the server has not been reached.
pub(crate) fn capture_binding_in(
  gates: &FeatureGates,
  published: Option<&Published>,
  now: DateTime<Utc>,
) -> Option<(u64, String)> {
  if gates.access_at(DesktopFeature::ActivityTimeline, now) == FeatureAccess::Enabled {
    return gates.account_binding(DesktopFeature::ActivityTimeline);
  }
  match published? {
    Published::Remembered { binding, until }
      if now < *until
        && gates.access_at(DesktopFeature::ActivityTimeline, now)
          == FeatureAccess::Off(OffReason::Undecided)
        && gates.local_binding().as_ref() == Some(binding) =>
    {
      Some(binding.clone())
    }
    Published::Remembered { .. } | Published::Stopped { .. } => None,
  }
}

/// The account whose history the member may read while Activity is stopped.
pub(crate) fn stopped_binding_in(
  gates: &FeatureGates,
  published: Option<&Published>,
) -> Option<(u64, String)> {
  match published? {
    Published::Stopped {
      binding: Some(binding),
      ..
    } if gates.local_binding().as_ref() == Some(binding) => Some(binding.clone()),
    Published::Stopped { .. } | Published::Remembered { .. } => None,
  }
}

/// Writes the loaded account's choice right after the member changed it, so
/// quitting before the next check cannot leave an older choice recorded.
pub(crate) fn record_loaded_choice(loaded: Option<LoadedChoice>) {
  let Some(loaded) = loaded.filter(|loaded| loaded.persisted) else {
    return;
  };
  let Some(records) = CaptureRecords::in_app_data() else {
    return;
  };
  if records
    .update(&loaded.namespace, |record| record.intent = loaded.intent)
    .is_err()
  {
    // The cause is logged where the write failed.
    tracing::warn!("activity recording choice was not recorded");
  }
}

static PUBLISHED: Mutex<Option<Published>> = Mutex::new(None);

fn published() -> Option<Published> {
  PUBLISHED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
    .clone()
}

pub(crate) fn capture_binding<R: Runtime>(app: &AppHandle<R>) -> Option<(u64, String)> {
  let gates = app.try_state::<FeatureGates>()?;
  capture_binding_in(&gates, published().as_ref(), Utc::now())
}

pub(crate) fn stopped_binding<R: Runtime>(app: &AppHandle<R>) -> Option<(u64, String)> {
  let gates = app.try_state::<FeatureGates>()?;
  stopped_binding_in(&gates, published().as_ref())
}

/// The stop the last check saw, for the tray.
pub(crate) fn stopped() -> Option<ActivityStopped> {
  match published()? {
    Published::Stopped { stopped, .. } => Some(stopped),
    Published::Remembered { .. } => None,
  }
}

/// What one check sees. Times come from the caller.
pub(crate) struct CheckInput {
  pub now: DateTime<Utc>,
  pub monotonic: Duration,
  /// Whether the member used the computer within the idle threshold.
  pub active: bool,
  pub access: FeatureAccess,
  /// The gate's generation and the account the last decision was read for.
  pub binding: Option<(u64, String)>,
  pub credential_expiry: Option<DateTime<Utc>>,
  pub loaded: Option<LoadedChoice>,
}

/// What a check asks its caller to do.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct CheckEffects {
  pub view_changed: bool,
  pub notify: Option<StopReason>,
  /// Open the store of the account Activity now records for on a grant.
  pub initialize: bool,
}

#[derive(Debug, Clone)]
struct OpenOutage {
  namespace: String,
  outage: CaptureOutage,
  last_monotonic: Duration,
  flushed_at: Duration,
}

/// Checks Activity's state; owned by the sampler thread.
pub(crate) struct CaptureMonitor {
  records: Option<CaptureRecords>,
  /// The choice last written to a record, so an unchanged one is not
  /// written again.
  written: Option<(String, ActivityRecordingStatus)>,
  /// The record read for the current generation and account.
  record: Option<((u64, String), Option<CaptureRecord>)>,
  /// When the current wait for a first answer began (monotonic, wall).
  pending_since: Option<(Duration, DateTime<Utc>)>,
  outages: Option<(String, Vec<CaptureOutage>)>,
  /// The namespaces whose record or outage file could not be read at the
  /// last try. Neither is cached; both are read again, and the failure is
  /// logged once while it lasts.
  unreadable_record: Option<String>,
  unreadable_outages: Option<String>,
  open: Option<OpenOutage>,
  episode: Episode,
  view: CaptureView,
  published: Option<Published>,
}

impl CaptureMonitor {
  pub(crate) fn new(records: Option<CaptureRecords>) -> Self {
    Self {
      records,
      written: None,
      record: None,
      pending_since: None,
      outages: None,
      unreadable_record: None,
      unreadable_outages: None,
      open: None,
      episode: Episode::Clear,
      view: CaptureView::Hidden,
      published: None,
    }
  }

  pub(crate) fn published(&self) -> Option<&Published> {
    self.published.as_ref()
  }

  fn record_choice(&mut self, loaded: &LoadedChoice) {
    let choice = (loaded.namespace.clone(), loaded.intent);
    if !loaded.persisted || self.written.as_ref() == Some(&choice) {
      return;
    }
    let Some(records) = &self.records else {
      return;
    };
    match records.update(&loaded.namespace, |record| record.intent = loaded.intent) {
      Ok(record) => {
        if let Some((binding, cached)) = &mut self.record
          && binding.1 == loaded.namespace
        {
          *cached = Some(record);
        }
        self.written = Some(choice);
      }
      // The cause is logged where the write failed.
      Err(_) => {
        tracing::warn!("activity recording choice was not recorded");
      }
    }
  }

  fn current_record(&mut self, binding: &(u64, String)) -> Option<CaptureRecord> {
    if let Some((read_binding, record)) = &self.record
      && read_binding == binding
    {
      return record.clone();
    }
    let record = match self
      .records
      .as_ref()
      .map(|records| records.load(&binding.1))
    {
      Some(Ok(record)) => record,
      // Not cached: a record that could not be read is not a missing one.
      Some(Err(_)) => {
        if self.unreadable_record.as_ref() != Some(&binding.1) {
          tracing::warn!("activity capture record could not be read");
          self.unreadable_record = Some(binding.1.clone());
        }
        return None;
      }
      None => None,
    };
    self.unreadable_record = None;
    self.record = Some((binding.clone(), record.clone()));
    record
  }

  /// The namespace's outages; `None` while their file cannot be read, so it
  /// is never replaced by a list that lost them.
  fn outage_list(&mut self, namespace: &str) -> Option<&mut Vec<CaptureOutage>> {
    if self
      .outages
      .as_ref()
      .is_none_or(|(cached, _)| cached != namespace)
    {
      let outages = match self
        .records
        .as_ref()
        .map(|records| records.load_outages(namespace))
      {
        Some(Ok(outages)) => outages,
        Some(Err(_)) => {
          if self.unreadable_outages.as_deref() != Some(namespace) {
            tracing::warn!("activity outages could not be read");
            self.unreadable_outages = Some(namespace.to_string());
          }
          return None;
        }
        None => Vec::new(),
      };
      self.unreadable_outages = None;
      self.outages = Some((namespace.to_string(), outages));
    }
    self.outages.as_mut().map(|(_, list)| list)
  }

  /// Writes the open outage into its namespace's list.
  fn flush_open(&mut self, monotonic: Duration, now: DateTime<Utc>) {
    let Some(open) = self.open.clone() else {
      return;
    };
    let Some(list) = self.outage_list(&open.namespace) else {
      return;
    };
    match list.iter().position(|outage| {
      outage.start == open.outage.start && outage.reason == open.outage.reason
    }) {
      Some(index) => list[index].end = open.outage.end,
      None => list.push(open.outage),
    }
    list.retain(|outage| outage.end >= now - OUTAGE_RETENTION);
    if list.len() > MAX_OUTAGES {
      let excess = list.len() - MAX_OUTAGES;
      list.drain(..excess);
    }
    let list = list.clone();
    if let Some(records) = &self.records
      && records.save_outages(&open.namespace, &list).is_err()
    {
      tracing::warn!("activity outage was not recorded");
    }
    if let Some(open) = self.open.as_mut() {
      open.flushed_at = monotonic;
    }
  }

  fn close_open(&mut self, monotonic: Duration, now: DateTime<Utc>) {
    self.flush_open(monotonic, now);
    self.open = None;
  }

  /// Extends or starts the outage for this check, or ends the open one.
  fn track_outage(
    &mut self,
    input: &CheckInput,
    outage: Option<(String, StopReason, DateTime<Utc>)>,
  ) {
    let continues = |open: &OpenOutage, namespace: &str, reason: StopReason| {
      let elapsed = input.monotonic.saturating_sub(open.last_monotonic);
      let wall = (input.now - open.outage.end).to_std();
      open.namespace == namespace
        && open.outage.reason == reason
        && elapsed <= crate::activity::MAX_SAMPLE_GAP
        && wall.is_ok_and(|wall| wall.abs_diff(elapsed) <= WALL_CLOCK_TOLERANCE)
    };
    match outage {
      Some((namespace, reason, start)) => {
        if let Some(open) = self.open.as_mut()
          && continues(&*open, &namespace, reason)
        {
          open.outage.end = input.now;
          open.last_monotonic = input.monotonic;
          if input.monotonic.saturating_sub(open.flushed_at) >= OUTAGE_FLUSH {
            self.flush_open(input.monotonic, input.now);
          }
          return;
        }
        self.close_open(input.monotonic, input.now);
        self.open = Some(OpenOutage {
          namespace,
          outage: CaptureOutage {
            start: start.min(input.now),
            end: input.now,
            reason,
          },
          last_monotonic: input.monotonic,
          flushed_at: input.monotonic,
        });
        self.flush_open(input.monotonic, input.now);
      }
      None => self.close_open(input.monotonic, input.now),
    }
  }

  pub(crate) fn check(&mut self, input: &CheckInput) -> CheckEffects {
    if let Some(loaded) = &input.loaded {
      self.record_choice(loaded);
    }
    let record = input
      .binding
      .clone()
      .and_then(|binding| self.current_record(&binding));
    let permission = permission(
      input.access,
      record.as_ref().and_then(|record| record.answer),
      input.credential_expiry,
      input.now,
    );
    match permission {
      Permission::Pending => {
        if self.pending_since.is_none() {
          self.pending_since = Some((input.monotonic, input.now));
        }
      }
      Permission::Live | Permission::Remembered { .. } | Permission::Stopped(_) => {
        self.pending_since = None;
      }
    }
    let waited = self.pending_since.is_some_and(|(since, _)| {
      input.monotonic.saturating_sub(since) >= CONFIRMATION_WAIT
    });
    let namespace = input
      .binding
      .as_ref()
      .map(|binding| binding.1.clone())
      .or_else(|| input.loaded.as_ref().map(|loaded| loaded.namespace.clone()));
    let intent = match (&namespace, &input.loaded) {
      (Some(namespace), Some(loaded)) if *namespace == loaded.namespace => {
        Some(loaded.intent)
      }
      (Some(_), _) => record.as_ref().map(|record| record.intent),
      (None, _) => None,
    };
    let view = capture_view(permission, intent, waited);
    let outage = match (view, &namespace) {
      (
        CaptureView::Stopped(ActivityStopped {
          reason,
          intent: ActivityRecordingStatus::Recording,
        }),
        Some(namespace),
      ) if input.active => {
        // A stop found after the wait for a first answer began with it.
        let start = match (reason, self.pending_since) {
          (StopReason::NotConfirmed, Some((_, since))) => since,
          _ => input.now,
        };
        Some((namespace.clone(), reason, start))
      }
      _ => None,
    };
    self.track_outage(input, outage);
    let (episode, notify) = self.episode.next(view);
    self.episode = episode;
    let view_changed = view != self.view;
    self.view = view;
    self.published = match (permission, view, &input.binding) {
      (Permission::Remembered { until }, _, Some(binding)) => {
        Some(Published::Remembered {
          binding: binding.clone(),
          until,
        })
      }
      (_, CaptureView::Stopped(stopped), binding) => Some(Published::Stopped {
        binding: binding.clone(),
        stopped,
      }),
      _ => None,
    };
    let initialize = matches!(permission, Permission::Remembered { .. })
      && input.loaded.as_ref().map(|loaded| &loaded.namespace)
        != input.binding.as_ref().map(|binding| &binding.1);
    CheckEffects {
      view_changed,
      notify: match (notify, view) {
        (true, CaptureView::Stopped(stopped)) => Some(stopped.reason),
        _ => None,
      },
      initialize,
    }
  }

  /// Whether the open outage or a written one covers `at`.
  #[cfg(test)]
  pub(crate) fn outage_covers(&self, at: DateTime<Utc>) -> bool {
    self
      .open
      .iter()
      .map(|open| &open.outage)
      .chain(self.outages.iter().flat_map(|(_, list)| list.iter()))
      .any(|outage| outage.start <= at && at <= outage.end)
  }

  #[cfg(test)]
  pub(crate) fn is_stopped(&self) -> bool {
    matches!(self.view, CaptureView::Stopped(_))
  }

  pub(crate) fn tick(&mut self, app: &AppHandle, state: &ActivityAppState) {
    let Some(gates) = app.try_state::<FeatureGates>() else {
      return;
    };
    let input = CheckInput {
      now: Utc::now(),
      monotonic: crate::activity::monotonic_now(),
      active: crate::idle_time::since_last_input()
        .is_some_and(|idle| idle < crate::activity::IDLE_THRESHOLD),
      access: gates.access(DesktopFeature::ActivityTimeline),
      binding: gates.local_binding(),
      credential_expiry: gates.credential_expiry(),
      loaded: state
        .lock()
        .ok()
        .and_then(|manager| manager.loaded_choice()),
    };
    let effects = self.check(&input);
    *PUBLISHED
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner) = self.published().cloned();
    if effects.initialize {
      crate::activity::initialize(app);
    }
    if effects.view_changed {
      crate::activity::capture_changed(app);
    }
    if let Some(reason) = effects.notify {
      notify_stopped(app, reason);
    }
  }
}

fn notify_stopped(app: &AppHandle, reason: StopReason) {
  use tauri_plugin_notification::NotificationExt;

  crate::logging::best_effort(
    app
      .notification()
      .builder()
      .title(crate::i18n::t("notification.activityStoppedTitle"))
      .body(crate::i18n::t(reason.notification_key()))
      .show(),
    "activity stop was not notified",
  );
}

/// The outages of one account that overlap `[start, end)`.
pub(crate) fn outages_between(
  namespace: &str,
  start: DateTime<Utc>,
  end: DateTime<Utc>,
) -> Result<Vec<CaptureOutage>, String> {
  let Some(records) = CaptureRecords::in_app_data() else {
    return Ok(Vec::new());
  };
  Ok(
    records
      .load_outages(namespace)?
      .into_iter()
      .filter(|outage| outage.start < end && outage.end > start)
      .collect(),
  )
}

#[cfg(test)]
#[allow(
  clippy::disallowed_methods,
  reason = "tests construct local file fixtures"
)]
mod tests {
  use super::*;

  const NAMESPACE: &str =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

  fn records() -> CaptureRecords {
    CaptureRecords::at(
      std::env::temp_dir()
        .join(format!("stella-activity-capture-{}", uuid::Uuid::new_v4())),
    )
  }

  fn loaded(intent: ActivityRecordingStatus) -> LoadedChoice {
    LoadedChoice {
      namespace: NAMESPACE.to_string(),
      intent,
      persisted: true,
    }
  }

  fn off(reason: OffReason) -> FeatureAccess {
    FeatureAccess::Off(reason)
  }

  fn input(access: FeatureAccess, seconds: u64) -> CheckInput {
    let start = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
      .unwrap()
      .with_timezone(&Utc);
    CheckInput {
      now: start + chrono::Duration::seconds(i64::try_from(seconds).unwrap()),
      monotonic: Duration::from_secs(seconds),
      active: true,
      access,
      binding: Some((1, NAMESPACE.into())),
      credential_expiry: Some(start + chrono::Duration::days(30)),
      loaded: None,
    }
  }

  #[test]
  fn only_a_member_who_turned_activity_on_sees_a_stop_and_its_reason() {
    let reasons = [
      (OffReason::ReconnectNeeded, StopReason::ReconnectNeeded),
      (OffReason::NotAvailable, StopReason::NotAvailable),
      (OffReason::BlockedByPolicy, StopReason::BlockedByPolicy),
      (OffReason::SignedOut, StopReason::SignedOut),
    ];
    let now = Utc::now();
    for (off_reason, reason) in reasons {
      let permission = permission(off(off_reason), None, None, now);
      for intent in [
        ActivityRecordingStatus::Recording,
        ActivityRecordingStatus::Paused,
      ] {
        assert_eq!(
          capture_view(permission, Some(intent), false),
          CaptureView::Stopped(ActivityStopped { reason, intent })
        );
      }
      assert_eq!(
        capture_view(permission, Some(ActivityRecordingStatus::Off), false),
        CaptureView::Hidden
      );
      assert_eq!(capture_view(permission, None, false), CaptureView::Hidden);
    }
    let recording = Some(ActivityRecordingStatus::Recording);
    let pending = permission(off(OffReason::Undecided), None, None, now);
    assert_eq!(pending, Permission::Pending);
    assert_eq!(capture_view(pending, recording, false), CaptureView::Hidden);
    assert_eq!(
      capture_view(pending, recording, true),
      CaptureView::Stopped(ActivityStopped {
        reason: StopReason::NotConfirmed,
        intent: ActivityRecordingStatus::Recording,
      })
    );
    assert_eq!(
      capture_view(
        permission(FeatureAccess::Enabled, None, None, now),
        None,
        false
      ),
      CaptureView::Live
    );
  }

  #[test]
  fn a_confirmed_grant_records_only_until_the_answer_and_its_credential_expire() {
    let now = Utc::now();
    let grant = ConfirmedGrant {
      confirmed_at: now - chrono::Duration::hours(1),
      expires_at: now + chrono::Duration::hours(2),
    };
    let granted = LastAnswer::Granted(grant);
    let undecided = off(OffReason::Undecided);
    assert_eq!(
      permission(
        undecided,
        Some(granted),
        Some(now + chrono::Duration::hours(1)),
        now
      ),
      Permission::Remembered {
        until: now + chrono::Duration::hours(1)
      }
    );
    assert_eq!(
      permission(
        undecided,
        Some(granted),
        Some(now + chrono::Duration::days(9)),
        now
      ),
      Permission::Remembered {
        until: grant.expires_at
      }
    );
    // The boundary itself is past.
    assert_eq!(
      permission(undecided, Some(granted), Some(now), now),
      Permission::Pending
    );
    assert_eq!(
      permission(undecided, Some(granted), None, now),
      Permission::Pending
    );
    // A refusal stands as a stop until the server answers again.
    assert_eq!(
      permission(
        undecided,
        Some(LastAnswer::Refused {
          reason: StopReason::NotAvailable
        }),
        Some(grant.expires_at),
        now
      ),
      Permission::Stopped(StopReason::NotAvailable)
    );
    // Any answer replaces the grant.
    for (access, expected) in [
      (FeatureAccess::Enabled, Permission::Live),
      (
        off(OffReason::NotAvailable),
        Permission::Stopped(StopReason::NotAvailable),
      ),
      (
        off(OffReason::ReconnectNeeded),
        Permission::Stopped(StopReason::ReconnectNeeded),
      ),
      (
        off(OffReason::BlockedByPolicy),
        Permission::Stopped(StopReason::BlockedByPolicy),
      ),
    ] {
      assert_eq!(
        permission(access, Some(granted), Some(grant.expires_at), now),
        expected
      );
    }
  }

  #[test]
  fn a_stop_notifies_once_per_episode_and_only_while_recording() {
    let stopped =
      |reason, intent| CaptureView::Stopped(ActivityStopped { reason, intent });
    let recording = ActivityRecordingStatus::Recording;
    let paused = ActivityRecordingStatus::Paused;
    let sequence = [
      (CaptureView::Live, false),
      (stopped(StopReason::ReconnectNeeded, recording), true),
      (stopped(StopReason::ReconnectNeeded, recording), false),
      // Another reason inside the same stop is the same episode.
      (stopped(StopReason::NotAvailable, recording), false),
      (CaptureView::Live, false),
      (stopped(StopReason::NotAvailable, recording), true),
      (CaptureView::Hidden, false),
      (stopped(StopReason::SignedOut, paused), false),
      (stopped(StopReason::SignedOut, recording), true),
      (stopped(StopReason::SignedOut, paused), false),
      (stopped(StopReason::SignedOut, recording), false),
    ];
    let mut episode = Episode::Clear;
    for (step, (view, expected)) in sequence.into_iter().enumerate() {
      let (next, notified) = episode.next(view);
      assert_eq!(notified, expected, "step {step}");
      episode = next;
    }
  }

  #[test]
  fn a_restarted_app_reads_the_recorded_choice_of_a_refused_account() {
    let records = records();
    let dir = records.dir.clone();
    let mut monitor = CaptureMonitor::new(Some(records));
    let effects = monitor.check(&CheckInput {
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
      ..input(FeatureAccess::Enabled, 0)
    });
    assert!(effects.view_changed);
    assert_eq!(effects.notify, None);

    let mut restarted = CaptureMonitor::new(Some(CaptureRecords::at(dir.clone())));
    let effects = restarted.check(&input(off(OffReason::ReconnectNeeded), 5));
    assert!(effects.view_changed);
    assert_eq!(effects.notify, Some(StopReason::ReconnectNeeded));
    assert_eq!(
      restarted.published(),
      Some(&Published::Stopped {
        binding: Some((1, NAMESPACE.into())),
        stopped: ActivityStopped {
          reason: StopReason::ReconnectNeeded,
          intent: ActivityRecordingStatus::Recording,
        },
      })
    );
    let effects = restarted.check(&input(off(OffReason::ReconnectNeeded), 10));
    assert_eq!(effects, CheckEffects::default());
    // The stop is written as an outage from the first check that saw it.
    let outages = CaptureRecords::at(dir.clone())
      .load_outages(NAMESPACE)
      .unwrap();
    assert_eq!(outages.len(), 1);
    assert_eq!(outages[0].reason, StopReason::ReconnectNeeded);
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_restart_records_on_the_confirmed_grant_and_a_denial_forgets_it() {
    let records = records();
    let dir = records.dir.clone();
    let gates = FeatureGates::default();
    let now = Utc::now();
    gates
      .install(
        gates.generation().unwrap(),
        crate::feature_gate::AccountDecision::Answered {
          namespace: NAMESPACE.into(),
          expires_at: now + chrono::Duration::days(30),
          enabled: std::collections::HashSet::from([DesktopFeature::ActivityTimeline]),
        },
      )
      .unwrap();
    record_decision(&gates, &records, now).unwrap();
    let Some(LastAnswer::Granted(grant)) =
      records.load(NAMESPACE).unwrap().unwrap().answer
    else {
      panic!("an enabling answer confirms the grant");
    };
    assert_eq!(grant.confirmed_at, now);

    // After a restart the server is not reached: the grant stands.
    let restarted = FeatureGates::default();
    restarted
      .install(
        restarted.generation().unwrap(),
        crate::feature_gate::AccountDecision::Unconfirmed {
          namespace: NAMESPACE.into(),
          expires_at: now + chrono::Duration::days(30),
        },
      )
      .unwrap();
    let mut monitor = CaptureMonitor::new(Some(CaptureRecords::at(dir.clone())));
    let effects = monitor.check(&CheckInput {
      now,
      monotonic: Duration::ZERO,
      active: true,
      access: restarted.access_at(DesktopFeature::ActivityTimeline, now),
      binding: restarted.local_binding(),
      credential_expiry: restarted.credential_expiry(),
      loaded: None,
    });
    assert!(effects.initialize);
    assert_eq!(
      capture_binding_in(&restarted, monitor.published(), now),
      restarted.local_binding()
    );
    // Server actions stay closed.
    assert!(!restarted.is_enabled(DesktopFeature::ActivityTimeline));

    // A denial replaces the grant, so the next restart stays stopped until
    // the server answers again.
    gates
      .install(
        gates.generation().unwrap(),
        crate::feature_gate::answered(NAMESPACE, std::collections::HashSet::new()),
      )
      .unwrap();
    record_decision(&gates, &records, now).unwrap();
    assert_eq!(
      records.load(NAMESPACE).unwrap().unwrap().answer,
      Some(LastAnswer::Refused {
        reason: StopReason::NotAvailable
      })
    );
    let mut denied = CaptureMonitor::new(Some(CaptureRecords::at(dir.clone())));
    denied.check(&CheckInput {
      now,
      monotonic: Duration::ZERO,
      active: true,
      access: restarted.access_at(DesktopFeature::ActivityTimeline, now),
      binding: restarted.local_binding(),
      credential_expiry: restarted.credential_expiry(),
      loaded: None,
    });
    assert_eq!(
      capture_binding_in(&restarted, denied.published(), now),
      None
    );
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_sleep_or_a_clock_step_ends_the_open_outage_at_the_last_check() {
    let mut monitor = CaptureMonitor::new(None);
    let stopped = off(OffReason::NotAvailable);
    let with_choice = |input: CheckInput| CheckInput {
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
      ..input
    };
    monitor.check(&with_choice(input(stopped, 0)));
    monitor.check(&with_choice(input(stopped, 5)));
    // The computer slept for an hour.
    monitor.check(&with_choice(input(stopped, 3605)));
    // The wall clock jumps an hour ahead between two checks.
    let mut stepped = with_choice(input(stopped, 3610));
    stepped.now += chrono::Duration::hours(1);
    monitor.check(&stepped);
    // Idle time is not an outage.
    monitor.check(&CheckInput {
      active: false,
      ..with_choice(input(stopped, 3615))
    });
    let outages = monitor
      .outages
      .as_ref()
      .map(|(_, list)| list.clone())
      .unwrap();
    let spans = outages
      .iter()
      .map(|outage| (outage.end - outage.start).num_seconds())
      .collect::<Vec<_>>();
    assert_eq!(spans, [5, 0, 0]);
    assert!(monitor.open.is_none());
  }

  #[test]
  fn a_file_that_could_not_be_read_is_read_again_and_never_replaced() {
    let records = records();
    let dir = records.dir.clone();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(records.path(NAMESPACE, RECORD_SUFFIX).unwrap(), "partial").unwrap();
    std::fs::write(records.path(NAMESPACE, OUTAGES_SUFFIX).unwrap(), "partial")
      .unwrap();
    let mut monitor = CaptureMonitor::new(Some(records));
    let refused = |seconds| CheckInput {
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
      ..input(off(OffReason::ReconnectNeeded), seconds)
    };
    // The open store still names the choice.
    monitor.check(&refused(0));
    assert!(monitor.is_stopped());
    // The unreadable outage file is left as it is.
    assert_eq!(
      std::fs::read_to_string(
        CaptureRecords::at(dir.clone())
          .path(NAMESPACE, OUTAGES_SUFFIX)
          .unwrap()
      )
      .unwrap(),
      "partial"
    );
    std::fs::write(
      CaptureRecords::at(dir.clone())
        .path(NAMESPACE, OUTAGES_SUFFIX)
        .unwrap(),
      "[]",
    )
    .unwrap();
    for seconds in (5..=60).step_by(5) {
      monitor.check(&refused(seconds));
    }
    assert_eq!(
      CaptureRecords::at(dir.clone())
        .load_outages(NAMESPACE)
        .unwrap()
        .len(),
      1
    );
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_signed_out_account_keeps_the_choice_the_open_store_holds() {
    let mut monitor = CaptureMonitor::new(None);
    let effects = monitor.check(&CheckInput {
      binding: None,
      loaded: Some(loaded(ActivityRecordingStatus::Paused)),
      ..input(off(OffReason::SignedOut), 0)
    });
    assert!(effects.view_changed);
    assert_eq!(effects.notify, None);
    assert_eq!(
      monitor.published(),
      Some(&Published::Stopped {
        binding: None,
        stopped: ActivityStopped {
          reason: StopReason::SignedOut,
          intent: ActivityRecordingStatus::Paused,
        },
      })
    );
    let mut unlinked = CaptureMonitor::new(None);
    unlinked.check(&CheckInput {
      binding: None,
      ..input(off(OffReason::SignedOut), 0)
    });
    assert_eq!(unlinked.view, CaptureView::Hidden);
  }

  #[test]
  fn records_hold_only_times_choices_and_reasons_and_refuse_foreign_paths() {
    let records = records();
    assert_eq!(records.load(NAMESPACE).unwrap(), None);
    records
      .update(NAMESPACE, |record| {
        record.intent = ActivityRecordingStatus::Recording;
      })
      .unwrap();
    let written =
      std::fs::read_to_string(records.path(NAMESPACE, RECORD_SUFFIX).unwrap()).unwrap();
    assert_eq!(written, r#"{"intent":"recording","answer":null}"#);
    // A record written before answers were kept still reads.
    std::fs::write(
      records.path(NAMESPACE, RECORD_SUFFIX).unwrap(),
      r#"{"intent":"paused"}"#,
    )
    .unwrap();
    assert_eq!(
      records.load(NAMESPACE).unwrap(),
      Some(CaptureRecord {
        intent: ActivityRecordingStatus::Paused,
        answer: None,
      })
    );
    let at = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
      .unwrap()
      .with_timezone(&Utc);
    records
      .save_outages(
        NAMESPACE,
        &[CaptureOutage {
          start: at,
          end: at + chrono::Duration::minutes(5),
          reason: StopReason::ReconnectNeeded,
        }],
      )
      .unwrap();
    assert_eq!(
      std::fs::read_to_string(records.path(NAMESPACE, OUTAGES_SUFFIX).unwrap())
        .unwrap(),
      r#"[{"start":"2026-03-10T12:00:00Z","end":"2026-03-10T12:05:00Z","reason":"reconnectNeeded"}]"#
    );
    for namespace in ["../outside", "", "A"] {
      assert!(
        records.path(namespace, RECORD_SUFFIX).is_err(),
        "{namespace}"
      );
    }
    std::fs::write(records.path(NAMESPACE, RECORD_SUFFIX).unwrap(), "not json")
      .unwrap();
    assert!(records.load(NAMESPACE).is_err());
    std::fs::remove_dir_all(&records.dir).unwrap();
  }

  #[test]
  fn every_stop_has_tray_and_notification_text_in_every_locale() {
    crate::i18n::init_en();
    let mut keys = vec!["notification.activityStoppedTitle"];
    for reason in StopReason::ALL {
      keys.push(reason.tray_key());
      keys.push(reason.notification_key());
    }
    for key in keys {
      assert!(
        crate::i18n::locales_missing(key).is_empty(),
        "missing {key}"
      );
    }
  }
}
