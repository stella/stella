//! Whether Activity may record, and what it keeps and shows when it cannot.
//!
//! The encrypted store opens only for an account Activity may record for, so
//! a small plain record per account namespace keeps what the app needs while
//! that store is closed: the member's recording choice and the server's last
//! answer about Activity (a confirmed grant's times, or the refusal's
//! reason). It holds nothing recorded. The stretches the member wanted
//! recorded but Activity could not record (`CaptureOutage`: start, end,
//! reason) say when the computer was in use, so they are written into the
//! account's encrypted store under its key, and deleted and expired with its
//! days.
//!
//! Server actions follow the live decision only. Until the server is reached
//! after a start, local recording follows the last answer: a confirmed grant
//! stands until its credential expires, and a refusal stands as a stop. Any
//! new answer replaces it.
//!
//! Activity also cannot record while the account's encrypted store cannot
//! open on this computer: its key cannot be read, the Keychain does not
//! answer, or its files cannot be read. These stops come from the store, not
//! the server, and take the same path.
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
const MAX_RECORD_BYTES: u64 = 4 * 1024;
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
/// While the Keychain does not answer, the store is opened again at most
/// this often.
const KEYCHAIN_RETRY: Duration = Duration::from_secs(30);

/// Why Activity cannot record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
  /// The server refused the desktop credential or the renewal of the link.
  ReconnectNeeded,
  NotAvailable,
  BlockedByPolicy,
  SignedOut,
  /// The server has not been reached since the app started and no grant was
  /// confirmed before.
  NotConfirmed,
  /// The key of the account's encrypted store could not be read from the
  /// Keychain, or it is missing while recorded history depends on it.
  StoreKeyUnavailable,
  /// The Keychain did not answer within its time; the store is opened again
  /// until it does.
  KeychainNotAnswering,
  /// The store's key was read, but its files cannot be read or were written
  /// by a newer version.
  StoreUnreadable,
}

impl StopReason {
  #[cfg(test)]
  pub const ALL: &'static [Self] = &[
    Self::ReconnectNeeded,
    Self::NotAvailable,
    Self::BlockedByPolicy,
    Self::SignedOut,
    Self::NotConfirmed,
    Self::StoreKeyUnavailable,
    Self::KeychainNotAnswering,
    Self::StoreUnreadable,
  ];

  pub const fn tray_key(self) -> &'static str {
    match self {
      Self::ReconnectNeeded => "tray.activityStoppedReconnect",
      Self::NotAvailable => "tray.activityStoppedNotAvailable",
      Self::BlockedByPolicy => "tray.activityStoppedPolicy",
      Self::SignedOut => "tray.activityStoppedSignedOut",
      Self::NotConfirmed => "tray.activityStoppedNotConfirmed",
      Self::StoreKeyUnavailable => "tray.activityStoppedStoreKey",
      Self::KeychainNotAnswering => "tray.activityStoppedKeychain",
      Self::StoreUnreadable => "tray.activityStoppedStoreUnreadable",
    }
  }

  const fn notification_key(self) -> &'static str {
    match self {
      Self::ReconnectNeeded => "notification.activityStoppedReconnectBody",
      Self::NotAvailable => "notification.activityStoppedNotAvailableBody",
      Self::BlockedByPolicy => "notification.activityStoppedPolicyBody",
      Self::SignedOut => "notification.activityStoppedSignedOutBody",
      Self::NotConfirmed => "notification.activityStoppedNotConfirmedBody",
      Self::StoreKeyUnavailable => "notification.activityStoppedStoreKeyBody",
      Self::KeychainNotAnswering => "notification.activityStoppedKeychainBody",
      Self::StoreUnreadable => "notification.activityStoppedStoreUnreadableBody",
    }
  }

  /// Whether linking the account again lets Activity record.
  pub const fn reconnect_helps(self) -> bool {
    match self {
      Self::ReconnectNeeded | Self::SignedOut => true,
      Self::NotAvailable
      | Self::BlockedByPolicy
      | Self::NotConfirmed
      | Self::StoreKeyUnavailable
      | Self::KeychainNotAnswering
      | Self::StoreUnreadable => false,
    }
  }

  /// Whether the Activity window stays open for the account while the stop
  /// lasts. A refused credential (which also answers for a member who left
  /// the organization), a sign-out and managed policy close it; it stays
  /// open, read-only, while Activity is only not enabled for the account or
  /// the server has not been reached, and while the store cannot open, so the
  /// window can say why and offer what the store still allows.
  pub const fn history_readable(self) -> bool {
    match self {
      Self::NotAvailable
      | Self::NotConfirmed
      | Self::StoreKeyUnavailable
      | Self::KeychainNotAnswering
      | Self::StoreUnreadable => true,
      Self::ReconnectNeeded | Self::SignedOut | Self::BlockedByPolicy => false,
    }
  }
}

/// Why the loaded account's encrypted store cannot be opened to record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StoreFailure {
  KeyUnavailable,
  KeychainNotAnswering,
  Unreadable,
}

impl StoreFailure {
  const fn stop_reason(self) -> StopReason {
    match self {
      Self::KeyUnavailable => StopReason::StoreKeyUnavailable,
      Self::KeychainNotAnswering => StopReason::KeychainNotAnswering,
      Self::Unreadable => StopReason::StoreUnreadable,
    }
  }
}

/// The account whose store could not be opened, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FailedStore {
  pub namespace: String,
  pub failure: StoreFailure,
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
  store: Option<StoreFailure>,
  intent: Option<ActivityRecordingStatus>,
  waited_for_confirmation: bool,
) -> CaptureView {
  // The server's reason comes first: it decides whether the store is opened
  // at all.
  let reason = match (permission, store) {
    (Permission::Live | Permission::Remembered { .. }, None) => {
      return CaptureView::Live;
    }
    (Permission::Live | Permission::Remembered { .. }, Some(failure)) => {
      failure.stop_reason()
    }
    (Permission::Pending, _) if waited_for_confirmation => StopReason::NotConfirmed,
    (Permission::Pending, _) => return CaptureView::Hidden,
    (Permission::Stopped(reason), _) => reason,
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

/// Where each account's outages are written.
enum OutageStores {
  /// The account's own encrypted store, with its key from the keychain.
  Accounts,
  /// One folder of stores under one key.
  #[cfg(test)]
  Fixed(PathBuf),
}

/// The plain per-namespace files, and where outages go.
pub struct CaptureRecords {
  dir: PathBuf,
  outage_stores: OutageStores,
}

impl CaptureRecords {
  pub fn in_app_data() -> Option<Self> {
    dirs::data_dir().map(|dir| Self {
      dir: dir.join(APP_DATA_DIR_NAME).join(RECORDS_DIR_NAME),
      outage_stores: OutageStores::Accounts,
    })
  }

  #[cfg(test)]
  pub(crate) fn at(dir: PathBuf) -> Self {
    Self {
      outage_stores: OutageStores::Fixed(dir.join("stores")),
      dir,
    }
  }

  /// The encrypted store `namespace`'s outages are written to; `None` while
  /// it has no key, and then none are kept.
  pub(crate) fn outage_store(
    &self,
    namespace: &str,
  ) -> Option<crate::activity_store::ActivityStore> {
    if !crate::activity_store::ActivityStore::is_account_namespace(namespace) {
      return None;
    }
    match &self.outage_stores {
      OutageStores::Accounts => crate::activity::keyed_store(namespace),
      #[cfg(test)]
      OutageStores::Fixed(root) => Some(crate::activity_store::ActivityStore::new(
        [5; 32],
        root.join(namespace),
      )),
    }
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

  #[cfg(test)]
  pub(crate) fn load_outages(
    &self,
    namespace: &str,
  ) -> Result<Vec<CaptureOutage>, String> {
    self
      .outage_store(namespace)
      .map_or_else(|| Ok(Vec::new()), |store| store.load_outages())
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
  /// The loaded account's store, when it could not be opened.
  pub store: Option<FailedStore>,
}

/// What a check asks its caller to do.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct CheckEffects {
  pub view_changed: bool,
  /// An outage reached its file, so an open day view reads again.
  pub outages_saved: bool,
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
  /// The store's deletion count when the outage opened; a deletion since
  /// may have taken what it holds.
  deletions: u64,
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
  /// Where the first outage of a wait for an answer starts: the wait's own
  /// start, while the computer stayed in use since.
  backdate_from: Option<DateTime<Utc>>,
  last_check: Option<Duration>,
  outages_saved: bool,
  /// The namespaces whose record or outage file could not be read at the
  /// last try. Neither is cached; both are read again, and the failure is
  /// logged once while it lasts.
  unreadable_record: Option<String>,
  unreadable_outages: Option<String>,
  open: Option<OpenOutage>,
  episode: Episode,
  view: CaptureView,
  published: Option<Published>,
  /// When the store was last opened again while the Keychain did not answer.
  keychain_retried: Option<Duration>,
}

impl CaptureMonitor {
  pub(crate) fn new(records: Option<CaptureRecords>) -> Self {
    Self {
      records,
      written: None,
      record: None,
      pending_since: None,
      backdate_from: None,
      last_check: None,
      outages_saved: false,
      unreadable_record: None,
      unreadable_outages: None,
      open: None,
      episode: Episode::Clear,
      view: CaptureView::Hidden,
      published: None,
      keychain_retried: None,
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

  /// Writes the open outage into its namespace's list, read from its store
  /// for each write so a deletion in between is never undone. A deletion of
  /// outage time since the outage opened ends it unwritten: it goes on from
  /// the next check.
  fn flush_open(&mut self, monotonic: Duration, now: DateTime<Utc>) {
    let Some(open) = self.open.as_mut() else {
      return;
    };
    open.flushed_at = monotonic;
    let open = open.clone();
    let Some(store) = self
      .records
      .as_ref()
      .and_then(|records| records.outage_store(&open.namespace))
    else {
      return;
    };
    let written = store.update_outages(open.deletions, |list| {
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
    });
    match written {
      Ok(true) => {
        self.unreadable_outages = None;
        self.outages_saved = true;
      }
      Ok(false) => self.open = None,
      // A list that cannot be read is left as it is.
      Err(_) => {
        if self.unreadable_outages.as_deref() != Some(open.namespace.as_str()) {
          tracing::warn!("activity outage was not recorded");
          self.unreadable_outages = Some(open.namespace);
        }
      }
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
        let deletions = self
          .records
          .as_ref()
          .and_then(|records| records.outage_store(&namespace))
          .map_or(0, |store| store.outage_deletions());
        self.open = Some(OpenOutage {
          namespace,
          outage: CaptureOutage {
            start: start.min(input.now),
            end: input.now,
            reason,
          },
          last_monotonic: input.monotonic,
          flushed_at: input.monotonic,
          deletions,
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
          self.backdate_from = Some(input.now);
        }
      }
      Permission::Live | Permission::Remembered { .. } | Permission::Stopped(_) => {
        self.pending_since = None;
        self.backdate_from = None;
      }
    }
    // Idle time or a sleep since the wait began is not an outage.
    let continuous = input.active
      && self.last_check.is_none_or(|last| {
        input.monotonic.saturating_sub(last) <= crate::activity::MAX_SAMPLE_GAP
      });
    if !continuous {
      self.backdate_from = None;
    }
    self.last_check = Some(input.monotonic);
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
    let store = input
      .store
      .as_ref()
      .filter(|store| namespace.as_ref() == Some(&store.namespace))
      .map(|store| store.failure);
    let view = capture_view(permission, store, intent, waited);
    let outage = match (view, &namespace) {
      (
        CaptureView::Stopped(ActivityStopped {
          reason,
          intent: ActivityRecordingStatus::Recording,
        }),
        Some(namespace),
      ) if input.active => {
        // The first stop found after the wait for an answer began with it.
        let start = match reason {
          StopReason::NotConfirmed => self.backdate_from.take().unwrap_or(input.now),
          StopReason::ReconnectNeeded
          | StopReason::NotAvailable
          | StopReason::BlockedByPolicy
          | StopReason::SignedOut
          | StopReason::StoreKeyUnavailable
          | StopReason::KeychainNotAnswering
          | StopReason::StoreUnreadable => input.now,
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
    // A stop comes first: a grant remembered for an account whose store
    // cannot open records nothing.
    self.published = match (permission, view, &input.binding) {
      (_, CaptureView::Stopped(stopped), binding) => Some(Published::Stopped {
        binding: binding
          .clone()
          .filter(|_| stopped.reason.history_readable()),
        stopped,
      }),
      (Permission::Remembered { until }, _, Some(binding)) => {
        Some(Published::Remembered {
          binding: binding.clone(),
          until,
        })
      }
      _ => None,
    };
    // A Keychain that did not answer may answer now.
    let retry_keychain = store == Some(StoreFailure::KeychainNotAnswering)
      && self
        .keychain_retried
        .is_none_or(|last| input.monotonic.saturating_sub(last) >= KEYCHAIN_RETRY);
    if retry_keychain {
      self.keychain_retried = Some(input.monotonic);
    }
    let initialize = retry_keychain
      || (matches!(permission, Permission::Remembered { .. })
        && input.loaded.as_ref().map(|loaded| &loaded.namespace)
          != input.binding.as_ref().map(|binding| &binding.1));
    CheckEffects {
      view_changed,
      outages_saved: std::mem::take(&mut self.outages_saved),
      notify: match (notify, view) {
        (true, CaptureView::Stopped(stopped)) => Some(stopped.reason),
        _ => None,
      },
      initialize,
    }
  }

  /// Whether the open outage or one written for `namespace` covers `at`.
  /// The written list is read only when the open outage does not.
  #[cfg(test)]
  pub(crate) fn outage_covers(&self, namespace: &str, at: DateTime<Utc>) -> bool {
    let covers = |outage: &CaptureOutage| outage.start <= at && at <= outage.end;
    self.open.as_ref().is_some_and(|open| covers(&open.outage))
      || self
        .records
        .as_ref()
        .and_then(|records| records.load_outages(namespace).ok())
        .is_some_and(|written| written.iter().any(covers))
  }

  #[cfg(test)]
  pub(crate) fn is_stopped(&self) -> bool {
    matches!(self.view, CaptureView::Stopped(_))
  }

  pub(crate) fn tick(&mut self, app: &AppHandle, state: &ActivityAppState) {
    let Some(gates) = app.try_state::<FeatureGates>() else {
      return;
    };
    let (loaded, store) = state.lock().map_or((None, None), |manager| {
      (manager.loaded_choice(), manager.failed_store())
    });
    let input = CheckInput {
      now: Utc::now(),
      monotonic: crate::activity::monotonic_now(),
      active: crate::idle_time::since_last_input()
        .is_some_and(|idle| idle < crate::activity::IDLE_THRESHOLD),
      access: gates.access(DesktopFeature::ActivityTimeline),
      binding: gates.local_binding(),
      credential_expiry: gates.credential_expiry(),
      loaded,
      store,
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
    } else if effects.outages_saved {
      crate::activity::emit_changed(app);
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
      store: None,
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
          capture_view(permission, None, Some(intent), false),
          CaptureView::Stopped(ActivityStopped { reason, intent })
        );
      }
      assert_eq!(
        capture_view(permission, None, Some(ActivityRecordingStatus::Off), false),
        CaptureView::Hidden
      );
      assert_eq!(
        capture_view(permission, None, None, false),
        CaptureView::Hidden
      );
    }
    let recording = Some(ActivityRecordingStatus::Recording);
    let pending = permission(off(OffReason::Undecided), None, None, now);
    assert_eq!(pending, Permission::Pending);
    assert_eq!(
      capture_view(pending, None, recording, false),
      CaptureView::Hidden
    );
    assert_eq!(
      capture_view(pending, None, recording, true),
      CaptureView::Stopped(ActivityStopped {
        reason: StopReason::NotConfirmed,
        intent: ActivityRecordingStatus::Recording,
      })
    );
    assert_eq!(
      capture_view(
        permission(FeatureAccess::Enabled, None, None, now),
        None,
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
        // A refused credential also answers for a member who left: the
        // history closes with it.
        binding: None,
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
      store: None,
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
      store: None,
    });
    assert_eq!(
      capture_binding_in(&restarted, denied.published(), now),
      None
    );
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_sleep_or_a_clock_step_ends_the_open_outage_at_the_last_check() {
    let records = records();
    let dir = records.dir.clone();
    let mut monitor = CaptureMonitor::new(Some(records));
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
    let outages = CaptureRecords::at(dir.clone())
      .load_outages(NAMESPACE)
      .unwrap();
    let spans = outages
      .iter()
      .map(|outage| (outage.end - outage.start).num_seconds())
      .collect::<Vec<_>>();
    assert_eq!(spans, [5, 0, 0]);
    assert!(monitor.open.is_none());
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_file_that_could_not_be_read_is_read_again_and_never_replaced() {
    let records = records();
    let dir = records.dir.clone();
    let outages = records.outage_store(NAMESPACE).unwrap().outages_path();
    std::fs::create_dir_all(outages.parent().unwrap()).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(records.path(NAMESPACE, RECORD_SUFFIX).unwrap(), "partial").unwrap();
    std::fs::write(&outages, "partial").unwrap();
    let mut monitor = CaptureMonitor::new(Some(records));
    let refused = |seconds| CheckInput {
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
      ..input(off(OffReason::ReconnectNeeded), seconds)
    };
    // The open store still names the choice.
    monitor.check(&refused(0));
    assert!(monitor.is_stopped());
    // The unreadable outage file is left as it is.
    assert_eq!(std::fs::read_to_string(&outages).unwrap(), "partial");
    std::fs::remove_file(&outages).unwrap();
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
  fn history_stays_readable_unless_the_account_itself_is_refused() {
    for reason in StopReason::ALL {
      let expected = match reason {
        StopReason::NotAvailable
        | StopReason::NotConfirmed
        | StopReason::StoreKeyUnavailable
        | StopReason::KeychainNotAnswering
        | StopReason::StoreUnreadable => true,
        StopReason::ReconnectNeeded
        | StopReason::SignedOut
        | StopReason::BlockedByPolicy => false,
      };
      assert_eq!(reason.history_readable(), expected, "{reason:?}");
    }
    let mut monitor = CaptureMonitor::new(None);
    let effects = monitor.check(&CheckInput {
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
      ..input(off(OffReason::NotAvailable), 0)
    });
    assert!(effects.view_changed);
    assert!(matches!(
      monitor.published(),
      Some(Published::Stopped {
        binding: Some(_),
        ..
      })
    ));
  }

  #[test]
  fn only_a_wait_spent_in_use_is_backdated_into_its_first_outage() {
    let waiting = |seconds, active| CheckInput {
      active,
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
      ..input(off(OffReason::Undecided), seconds)
    };
    let start = |monitor: &CaptureMonitor| {
      monitor.open.as_ref().map(|open| {
        (open.outage.start - input(FeatureAccess::Enabled, 0).now).num_seconds()
      })
    };
    let mut in_use = CaptureMonitor::new(None);
    for seconds in (0..=120).step_by(5) {
      in_use.check(&waiting(seconds, true));
    }
    assert_eq!(start(&in_use), Some(0));

    let mut idle_between = CaptureMonitor::new(None);
    for seconds in (0..=125).step_by(5) {
      idle_between.check(&waiting(seconds, seconds != 60));
    }
    assert_eq!(start(&idle_between), Some(120));
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
    // Outages say when the computer was in use: they are kept encrypted in
    // the account's store, never beside the plain record.
    let at = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
      .unwrap()
      .with_timezone(&Utc);
    let outage = CaptureOutage {
      start: at,
      end: at + chrono::Duration::minutes(5),
      reason: StopReason::ReconnectNeeded,
    };
    let store = records.outage_store(NAMESPACE).unwrap();
    assert!(
      store
        .update_outages(store.outage_deletions(), |list| list.push(outage))
        .unwrap()
    );
    assert_eq!(records.load_outages(NAMESPACE).unwrap(), [outage]);
    let written = std::fs::read_to_string(store.outages_path()).unwrap();
    assert!(
      !written.contains("2026-03-10"),
      "outage times are not encrypted"
    );
    assert!(
      !written.contains("reconnectNeeded"),
      "outage reasons are not encrypted"
    );
    assert_eq!(
      std::fs::read_dir(&records.dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name != "stores")
        .collect::<Vec<_>>(),
      [format!("{NAMESPACE}.{RECORD_SUFFIX}")]
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
  fn deleted_history_takes_its_outages_and_a_later_write_cannot_restore_them() {
    let records = records();
    let dir = records.dir.clone();
    let store = records.outage_store(NAMESPACE).unwrap();
    let mut monitor = CaptureMonitor::new(Some(records));
    let refused = |seconds| CheckInput {
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
      ..input(off(OffReason::ReconnectNeeded), seconds)
    };
    for seconds in (0..=90).step_by(5) {
      monitor.check(&refused(seconds));
    }
    let date = refused(0).now.with_timezone(&chrono::Local).date_naive();
    assert_eq!(store.load_outages().unwrap().len(), 1);
    store.delete_day(date).unwrap();
    assert!(store.load_outages().unwrap().is_empty());
    // The stop goes on: the next writes keep only time after the deletion.
    for seconds in (95..=240).step_by(5) {
      monitor.check(&refused(seconds));
    }
    let outages = store.load_outages().unwrap();
    assert!(!outages.is_empty());
    for outage in &outages {
      assert!(
        outage.start > refused(90).now,
        "deleted outage time was written back"
      );
    }

    // Deleting all history takes every outage, and the open one with it.
    store.delete_all_days().unwrap();
    assert!(!store.outages_path().exists());
    for seconds in (245..=400).step_by(5) {
      monitor.check(&refused(seconds));
    }
    for outage in store.load_outages().unwrap() {
      assert!(outage.start > refused(240).now);
    }
    std::fs::remove_dir_all(dir).unwrap();
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

  #[test]
  fn all_lists_every_stop_reason_once() {
    // A new reason fails to compile here until it has a place in `ALL`.
    let place = |reason: StopReason| match reason {
      StopReason::ReconnectNeeded => 0,
      StopReason::NotAvailable => 1,
      StopReason::BlockedByPolicy => 2,
      StopReason::SignedOut => 3,
      StopReason::NotConfirmed => 4,
      StopReason::StoreKeyUnavailable => 5,
      StopReason::KeychainNotAnswering => 6,
      StopReason::StoreUnreadable => 7,
    };
    assert_eq!(StopReason::ALL.len(), 8);
    for (index, reason) in StopReason::ALL.iter().enumerate() {
      assert_eq!(place(*reason), index, "{reason:?}");
    }
  }

  fn failed(failure: StoreFailure) -> FailedStore {
    FailedStore {
      namespace: NAMESPACE.into(),
      failure,
    }
  }

  /// The checks that bring a member who records into `reason`, after one
  /// where Activity recorded and kept the member's choice.
  fn checks_into(reason: StopReason) -> Vec<CheckInput> {
    let recording = |access, seconds| CheckInput {
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
      ..input(access, seconds)
    };
    // The store cannot open, so no choice is loaded; the record keeps it.
    let store = |failure| CheckInput {
      store: Some(failed(failure)),
      ..input(FeatureAccess::Enabled, 5)
    };
    match reason {
      StopReason::ReconnectNeeded => {
        vec![recording(off(OffReason::ReconnectNeeded), 5)]
      }
      StopReason::NotAvailable => vec![recording(off(OffReason::NotAvailable), 5)],
      StopReason::BlockedByPolicy => {
        vec![recording(off(OffReason::BlockedByPolicy), 5)]
      }
      StopReason::SignedOut => vec![recording(off(OffReason::SignedOut), 5)],
      StopReason::NotConfirmed => vec![
        recording(off(OffReason::Undecided), 5),
        recording(off(OffReason::Undecided), 5 + CONFIRMATION_WAIT.as_secs()),
      ],
      StopReason::StoreKeyUnavailable => vec![store(StoreFailure::KeyUnavailable)],
      StopReason::KeychainNotAnswering => {
        vec![store(StoreFailure::KeychainNotAnswering)]
      }
      StopReason::StoreUnreadable => vec![store(StoreFailure::Unreadable)],
    }
  }

  #[test]
  fn every_stop_reason_shows_in_the_tray_and_notifies_once() {
    crate::i18n::init_en();
    for reason in StopReason::ALL {
      let records = records();
      let dir = records.dir.clone();
      let mut monitor = CaptureMonitor::new(Some(records));
      let effects = monitor.check(&CheckInput {
        loaded: Some(loaded(ActivityRecordingStatus::Recording)),
        ..input(FeatureAccess::Enabled, 0)
      });
      assert_eq!(effects.notify, None, "{reason:?}");
      let mut notified = Vec::new();
      for check in checks_into(*reason) {
        notified.extend(monitor.check(&check).notify);
      }
      assert_eq!(notified, vec![*reason], "{reason:?} notifies once");
      let Some(Published::Stopped { stopped, binding }) = monitor.published() else {
        panic!("{reason:?} is not published as a stop");
      };
      assert_eq!(stopped.reason, *reason);
      assert_eq!(stopped.intent, ActivityRecordingStatus::Recording);
      assert_eq!(binding.is_some(), reason.history_readable(), "{reason:?}");
      // What the tray and the notification show.
      for key in [reason.tray_key(), reason.notification_key()] {
        assert_ne!(crate::i18n::t(key), key, "{reason:?} has no text for {key}");
      }
      std::fs::remove_dir_all(dir).unwrap();
    }
  }

  #[test]
  fn a_store_that_cannot_open_stops_only_its_own_account_after_the_server() {
    let records = records();
    let dir = records.dir.clone();
    let mut monitor = CaptureMonitor::new(Some(records));
    monitor.check(&CheckInput {
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
      ..input(FeatureAccess::Enabled, 0)
    });
    // Another account's store says nothing about this one.
    let effects = monitor.check(&CheckInput {
      store: Some(FailedStore {
        namespace: "other".into(),
        failure: StoreFailure::KeyUnavailable,
      }),
      ..input(FeatureAccess::Enabled, 5)
    });
    assert_eq!(effects.notify, None);
    assert!(!monitor.is_stopped());
    // The server's reason comes first.
    let effects = monitor.check(&CheckInput {
      store: Some(failed(StoreFailure::KeyUnavailable)),
      ..input(off(OffReason::ReconnectNeeded), 10)
    });
    assert_eq!(effects.notify, Some(StopReason::ReconnectNeeded));
    // A remembered grant records nothing while the store cannot open.
    let remembered = Permission::Remembered {
      until: input(FeatureAccess::Enabled, 0).now + chrono::Duration::days(1),
    };
    assert_eq!(
      capture_view(
        remembered,
        Some(StoreFailure::Unreadable),
        Some(ActivityRecordingStatus::Paused),
        false
      ),
      CaptureView::Stopped(ActivityStopped {
        reason: StopReason::StoreUnreadable,
        intent: ActivityRecordingStatus::Paused,
      })
    );
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_keychain_that_does_not_answer_is_asked_again_at_its_pace() {
    let mut monitor = CaptureMonitor::new(None);
    let waiting = |seconds| CheckInput {
      store: Some(failed(StoreFailure::KeychainNotAnswering)),
      ..input(FeatureAccess::Enabled, seconds)
    };
    let mut retries = Vec::new();
    for seconds in [0, 5, 25, 30, 35, 60] {
      if monitor.check(&waiting(seconds)).initialize {
        retries.push(seconds);
      }
    }
    assert_eq!(retries, vec![0, 30, 60]);
    // Once the store opens, nothing is retried.
    let opened = monitor.check(&CheckInput {
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
      ..input(FeatureAccess::Enabled, 95)
    });
    assert!(!opened.initialize);
  }
}
