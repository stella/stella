//! What Activity shows while it cannot record for a member who turned it on.
//!
//! The encrypted store opens only while the server enables Activity, so the
//! member's recording choice is also kept in a small plain record per account
//! namespace: the choice, nothing recorded. The sampler checks the state every
//! few seconds. The tray reads the last result; the first check of each stop
//! shows one system notification while the member's choice is Recording, and
//! leaving the stop ends it.

use std::{
  path::{Path, PathBuf},
  sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
  activity::{ActivityAppState, ActivityRecordingStatus},
  config::APP_DATA_DIR_NAME,
  feature_gate::{DesktopFeature, FeatureAccess, FeatureGates, OffReason},
};

const RECORDS_DIR_NAME: &str = "activity-capture";
const MAX_RECORD_BYTES: u64 = 4 * 1024;

/// Why Activity cannot record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
  ReconnectNeeded,
  NotAvailable,
  BlockedByPolicy,
  SignedOut,
}

impl StopReason {
  #[cfg(test)]
  pub const ALL: &'static [Self] = &[
    Self::ReconnectNeeded,
    Self::NotAvailable,
    Self::BlockedByPolicy,
    Self::SignedOut,
  ];

  /// `None` while nothing has been read for the account yet: that is not a
  /// stop the member can act on.
  fn from_off(reason: OffReason) -> Option<Self> {
    match reason {
      OffReason::Undecided => None,
      OffReason::BlockedByPolicy => Some(Self::BlockedByPolicy),
      OffReason::SignedOut => Some(Self::SignedOut),
      OffReason::ReconnectNeeded => Some(Self::ReconnectNeeded),
      OffReason::NotAvailable => Some(Self::NotAvailable),
    }
  }

  pub const fn tray_key(self) -> &'static str {
    match self {
      Self::ReconnectNeeded => "tray.activityStoppedReconnect",
      Self::NotAvailable => "tray.activityStoppedNotAvailable",
      Self::BlockedByPolicy => "tray.activityStoppedPolicy",
      Self::SignedOut => "tray.activityStoppedSignedOut",
    }
  }

  const fn notification_key(self) -> &'static str {
    match self {
      Self::ReconnectNeeded => "notification.activityStoppedReconnectBody",
      Self::NotAvailable => "notification.activityStoppedNotAvailableBody",
      Self::BlockedByPolicy => "notification.activityStoppedPolicyBody",
      Self::SignedOut => "notification.activityStoppedSignedOutBody",
    }
  }

  /// Whether linking the account again lets Activity record.
  pub const fn reconnect_helps(self) -> bool {
    match self {
      Self::ReconnectNeeded | Self::SignedOut => true,
      Self::NotAvailable | Self::BlockedByPolicy => false,
    }
  }
}

/// Activity cannot record for an account whose member turned it on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivityStopped {
  pub reason: StopReason,
  pub intent: ActivityRecordingStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureView {
  /// Activity is off for an account whose member never turned it on, or
  /// nothing has been decided yet.
  Hidden,
  Live,
  Stopped(ActivityStopped),
}

fn capture_view(
  access: FeatureAccess,
  intent: Option<ActivityRecordingStatus>,
) -> CaptureView {
  let reason = match access {
    FeatureAccess::Enabled => return CaptureView::Live,
    FeatureAccess::Off(reason) => reason,
  };
  match (StopReason::from_off(reason), intent) {
    (
      Some(reason),
      Some(
        intent @ (ActivityRecordingStatus::Recording | ActivityRecordingStatus::Paused),
      ),
    ) => CaptureView::Stopped(ActivityStopped { reason, intent }),
    (None, _) | (_, None | Some(ActivityRecordingStatus::Off)) => CaptureView::Hidden,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRecord {
  intent: ActivityRecordingStatus,
}

/// The plain per-namespace records. They hold the recording choice only.
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
  fn at(dir: PathBuf) -> Self {
    Self { dir }
  }

  fn path(&self, namespace: &str) -> Result<PathBuf, String> {
    if !crate::activity_store::ActivityStore::is_account_namespace(namespace) {
      return Err("activity capture namespace is invalid".to_string());
    }
    Ok(self.dir.join(format!("{namespace}.json")))
  }

  fn load(&self, namespace: &str) -> Result<Option<CaptureRecord>, String> {
    read_record(&self.path(namespace)?)
  }

  fn save(&self, namespace: &str, record: &CaptureRecord) -> Result<(), String> {
    let path = self.path(namespace)?;
    crate::local_store::create_private_dir(&self.dir).map_err(
      crate::logging::with_cause_logged("activity capture folder failed"),
    )?;
    let bytes = serde_json::to_vec(record).map_err(
      crate::logging::with_cause_logged("activity capture record failed"),
    )?;
    crate::local_store::write_private_atomic(&path, &bytes)
  }
}

fn read_record(path: &Path) -> Result<Option<CaptureRecord>, String> {
  match std::fs::symlink_metadata(path) {
    Ok(metadata) if metadata.file_type().is_file() => {
      if metadata.len() > MAX_RECORD_BYTES {
        return Err("activity capture record is too large".to_string());
      }
    }
    Ok(_) => return Err("activity capture record is not a file".to_string()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => {
      return Err(crate::logging::with_cause_logged(
        "activity capture record could not be inspected",
      )(error));
    }
  }
  let bytes = std::fs::read(path).map_err(crate::logging::with_cause_logged(
    "activity capture record could not be read",
  ))?;
  serde_json::from_slice(&bytes)
    .map(Some)
    .map_err(crate::logging::with_cause_logged(
      "activity capture record is unreadable",
    ))
}

/// The account whose Activity store is open and its member's choice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoadedChoice {
  pub namespace: String,
  pub intent: ActivityRecordingStatus,
  /// Whether the store is on disk, so the choice outlives this process.
  pub persisted: bool,
}

/// What one check sees.
struct CheckInput {
  access: FeatureAccess,
  /// The account the last feature decision was read for.
  decided_namespace: Option<String>,
  loaded: Option<LoadedChoice>,
}

/// Checks Activity's state; owned by the sampler thread.
pub(crate) struct CaptureMonitor {
  records: Option<CaptureRecords>,
  /// The choice last written to a record, so an unchanged one is not
  /// written again.
  written: Option<(String, ActivityRecordingStatus)>,
  /// The choice read from the record of an account whose store is closed.
  read: Option<(String, Option<ActivityRecordingStatus>)>,
  episode: Episode,
  view: CaptureView,
}

impl CaptureMonitor {
  pub(crate) fn new(records: Option<CaptureRecords>) -> Self {
    Self {
      records,
      written: None,
      read: None,
      episode: Episode::Clear,
      view: CaptureView::Hidden,
    }
  }

  fn record_choice(&mut self, loaded: &LoadedChoice) {
    let choice = (loaded.namespace.clone(), loaded.intent);
    if !loaded.persisted || self.written.as_ref() == Some(&choice) {
      return;
    }
    let Some(records) = &self.records else {
      return;
    };
    match records.save(
      &loaded.namespace,
      &CaptureRecord {
        intent: loaded.intent,
      },
    ) {
      Ok(()) => {
        self.read = Some((loaded.namespace.clone(), Some(loaded.intent)));
        self.written = Some(choice);
      }
      // The cause is logged where the write failed.
      Err(_) => tracing::warn!("activity recording choice was not recorded"),
    }
  }

  fn recorded_choice(&mut self, namespace: &str) -> Option<ActivityRecordingStatus> {
    if let Some((read_namespace, intent)) = &self.read
      && read_namespace == namespace
    {
      return *intent;
    }
    let intent = match self.records.as_ref().map(|records| records.load(namespace)) {
      Some(Ok(record)) => record.map(|record| record.intent),
      Some(Err(_)) => {
        tracing::warn!("activity recording choice could not be read");
        None
      }
      None => None,
    };
    self.read = Some((namespace.to_string(), intent));
    intent
  }

  /// Returns whether the view changed and the stop to notify, if any.
  fn check(&mut self, input: CheckInput) -> (bool, Option<StopReason>) {
    if let Some(loaded) = &input.loaded {
      self.record_choice(loaded);
    }
    let namespace = input
      .decided_namespace
      .or_else(|| input.loaded.as_ref().map(|loaded| loaded.namespace.clone()));
    let intent = match (&namespace, &input.loaded) {
      (Some(namespace), Some(loaded)) if *namespace == loaded.namespace => {
        Some(loaded.intent)
      }
      (Some(namespace), _) => self.recorded_choice(namespace),
      (None, _) => None,
    };
    let view = capture_view(input.access, intent);
    let (episode, notify) = self.episode.next(view);
    self.episode = episode;
    let changed = view != self.view;
    self.view = view;
    let notify = match (notify, view) {
      (true, CaptureView::Stopped(stopped)) => Some(stopped.reason),
      _ => None,
    };
    (changed, notify)
  }

  pub(crate) fn tick(&mut self, app: &AppHandle, state: &ActivityAppState) {
    let Some(gates) = app.try_state::<FeatureGates>() else {
      return;
    };
    let input = CheckInput {
      access: gates.access(DesktopFeature::ActivityTimeline),
      decided_namespace: gates.namespace(),
      loaded: state
        .lock()
        .ok()
        .and_then(|manager| manager.loaded_choice()),
    };
    let (changed, notify) = self.check(input);
    if changed {
      publish(match self.view {
        CaptureView::Stopped(stopped) => Some(stopped),
        CaptureView::Hidden | CaptureView::Live => None,
      });
      crate::activity::refresh_tray(app);
    }
    if let Some(reason) = notify {
      notify_stopped(app, reason);
    }
  }
}

static STOPPED: Mutex<Option<ActivityStopped>> = Mutex::new(None);

fn publish(stopped: Option<ActivityStopped>) {
  *STOPPED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner) = stopped;
}

/// The stop the last check saw, for the tray.
pub(crate) fn stopped() -> Option<ActivityStopped> {
  *STOPPED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
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

  #[test]
  fn only_a_member_who_turned_activity_on_sees_a_stop_and_its_reason() {
    let reasons = [
      (OffReason::ReconnectNeeded, StopReason::ReconnectNeeded),
      (OffReason::NotAvailable, StopReason::NotAvailable),
      (OffReason::BlockedByPolicy, StopReason::BlockedByPolicy),
      (OffReason::SignedOut, StopReason::SignedOut),
    ];
    for (off_reason, reason) in reasons {
      for intent in [
        ActivityRecordingStatus::Recording,
        ActivityRecordingStatus::Paused,
      ] {
        assert_eq!(
          capture_view(off(off_reason), Some(intent)),
          CaptureView::Stopped(ActivityStopped { reason, intent })
        );
      }
      assert_eq!(
        capture_view(off(off_reason), Some(ActivityRecordingStatus::Off)),
        CaptureView::Hidden
      );
      assert_eq!(capture_view(off(off_reason), None), CaptureView::Hidden);
    }
    assert_eq!(
      capture_view(
        off(OffReason::Undecided),
        Some(ActivityRecordingStatus::Recording)
      ),
      CaptureView::Hidden
    );
    assert_eq!(
      capture_view(FeatureAccess::Enabled, None),
      CaptureView::Live
    );
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
    let (changed, notify) = monitor.check(CheckInput {
      access: FeatureAccess::Enabled,
      decided_namespace: Some(NAMESPACE.into()),
      loaded: Some(loaded(ActivityRecordingStatus::Recording)),
    });
    assert_eq!((changed, notify), (true, None));

    let mut restarted = CaptureMonitor::new(Some(CaptureRecords::at(dir.clone())));
    let input = || CheckInput {
      access: off(OffReason::ReconnectNeeded),
      decided_namespace: Some(NAMESPACE.into()),
      loaded: None,
    };
    assert_eq!(
      restarted.check(input()),
      (true, Some(StopReason::ReconnectNeeded))
    );
    assert_eq!(
      restarted.view,
      CaptureView::Stopped(ActivityStopped {
        reason: StopReason::ReconnectNeeded,
        intent: ActivityRecordingStatus::Recording,
      })
    );
    assert_eq!(restarted.check(input()), (false, None));
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_signed_out_account_keeps_the_choice_the_open_store_holds() {
    let mut monitor = CaptureMonitor::new(None);
    let (changed, notify) = monitor.check(CheckInput {
      access: off(OffReason::SignedOut),
      decided_namespace: None,
      loaded: Some(loaded(ActivityRecordingStatus::Paused)),
    });
    assert!(changed);
    assert_eq!(notify, None);
    assert_eq!(
      monitor.view,
      CaptureView::Stopped(ActivityStopped {
        reason: StopReason::SignedOut,
        intent: ActivityRecordingStatus::Paused,
      })
    );
    // Without any account the tray has nothing to show.
    let mut unlinked = CaptureMonitor::new(None);
    unlinked.check(CheckInput {
      access: off(OffReason::SignedOut),
      decided_namespace: None,
      loaded: None,
    });
    assert_eq!(unlinked.view, CaptureView::Hidden);
  }

  #[test]
  fn records_hold_only_the_choice_and_refuse_foreign_paths() {
    let records = records();
    assert_eq!(records.load(NAMESPACE).unwrap(), None);
    records
      .save(
        NAMESPACE,
        &CaptureRecord {
          intent: ActivityRecordingStatus::Recording,
        },
      )
      .unwrap();
    let written = std::fs::read_to_string(records.path(NAMESPACE).unwrap()).unwrap();
    assert_eq!(written, r#"{"intent":"recording"}"#);
    assert_eq!(
      records.load(NAMESPACE).unwrap(),
      Some(CaptureRecord {
        intent: ActivityRecordingStatus::Recording
      })
    );
    for namespace in ["../outside", "", "A"] {
      assert!(records.path(namespace).is_err(), "{namespace}");
    }
    std::fs::write(records.path(NAMESPACE).unwrap(), "not json").unwrap();
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
