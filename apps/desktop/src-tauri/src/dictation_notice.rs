//! Says at once, where the speaker is working, that a dictation heard
//! nothing: the microphone could not be heard at all, or it delivered sound
//! that held no speech. A system notification names the input device;
//! clicking it opens Settings → Dictation, whose failure line carries the one
//! action that helps: asking for the microphone while the OS has not asked
//! yet, otherwise its privacy page, or the sound input settings when sound
//! arrived but no words. Where notifications are off, a small panel near the
//! bottom of the screen says the same and offers that action itself.

#![cfg_attr(
  not(dictation),
  allow(
    dead_code,
    reason = "only builds with the speech engine fail dictations"
  )
)]

use std::{
  sync::Mutex,
  time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager};

use crate::{
  dictation::Failure,
  permissions::{self, Permission, PermissionStatus},
};

pub const NOTICE_WINDOW_LABEL: &str = "dictation-notice";
/// Tells this notice's notification apart from the app's others when it is
/// clicked.
const NOTIFICATION_ID: i32 = 0x5d1c_7a7e;
/// Payload-free: the panel re-reads its state.
const CHANGED_EVENT: &str = "dictation-notice-changed";

const WIDTH: f64 = 420.0;
const HEIGHT: f64 = 156.0;
/// Room left above the bottom of the work area, clear of the Dock or taskbar.
const BOTTOM_GAP: f64 = 48.0;
/// Another failure of the same kind this soon after its notice shows
/// nothing new: holding the key again and again with the microphone still
/// off does not stack panels.
const REPEAT_WINDOW: Duration = Duration::from_secs(30);
/// An untouched panel goes away on its own.
const LINGER: Duration = Duration::from_secs(12);
// A panel closing on its own can never close the next one of its kind.
const _: () = assert!(LINGER.as_secs() < REPEAT_WINDOW.as_secs());

/// Whether this OS has settings pages the panel can open.
const HAS_SETTINGS_PAGE: bool = cfg!(any(target_os = "macos", target_os = "windows"));

/// The Sound pane on its Input tab, and the same pane by its older name for
/// releases that do not know the newer one.
#[cfg(target_os = "macos")]
const SOUND_INPUT_URLS: [&str; 2] = [
  "x-apple.systempreferences:com.apple.Sound-Settings.extension?input",
  "x-apple.systempreferences:com.apple.preference.sound?input",
];
#[cfg(target_os = "windows")]
const SOUND_INPUT_URLS: [&str; 1] = ["ms-settings:sound"];

/// What a notice says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeKind {
  /// The microphone could not be opened, or delivered nothing at all.
  Microphone,
  /// Sound arrived, but no words came of it.
  NothingHeard,
}

impl NoticeKind {
  /// The notice a failed dictation gets, if any.
  pub const fn of(failure: Failure) -> Option<Self> {
    match failure {
      Failure::Microphone => Some(Self::Microphone),
      Failure::NothingHeard => Some(Self::NothingHeard),
      Failure::Accessibility
      | Failure::ModelMissing
      | Failure::Transcription
      | Failure::FocusChanged
      | Failure::FocusUnconfirmed
      | Failure::ShortcutHeld
      | Failure::CloudTranscription
      | Failure::PasswordField => None,
    }
  }

  const fn index(self) -> usize {
    match self {
      Self::Microphone => 0,
      Self::NothingHeard => 1,
    }
  }
}

/// Decides which failed dictations get a notice. Time is a monotonic offset
/// handed in by the caller, so the rule is tested without a clock.
#[derive(Debug, Default)]
pub struct NoticeGate {
  last_shown: [Option<Duration>; 2],
}

impl NoticeGate {
  /// The notice a dictation that failed with `failure` at `now` shows: one
  /// per failed attempt, at most once per `REPEAT_WINDOW` for each kind.
  pub fn admit(&mut self, failure: Failure, now: Duration) -> Option<NoticeKind> {
    let kind = NoticeKind::of(failure)?;
    let last = &mut self.last_shown[kind.index()];
    let due = last.is_none_or(|last| now.saturating_sub(last) >= REPEAT_WINDOW);
    if due {
      *last = Some(now);
    }
    due.then_some(kind)
  }
}

/// What the panel is showing.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Shown {
  kind: NoticeKind,
  input_device: Option<String>,
}

/// The gate, the start of its clock, and the notice on screen, kept for the
/// life of the app.
pub struct DictationNotice {
  epoch: Instant,
  gate: Mutex<NoticeGate>,
  shown: Mutex<Option<Shown>>,
}

impl Default for DictationNotice {
  fn default() -> Self {
    Self {
      epoch: Instant::now(),
      gate: Mutex::default(),
      shown: Mutex::default(),
    }
  }
}

impl DictationNotice {
  fn admit(&self, failure: Failure) -> Option<NoticeKind> {
    let now = self.epoch.elapsed();
    self
      .gate
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .admit(failure, now)
  }

  fn set_shown(&self, shown: Shown) {
    *self.shown.lock().unwrap_or_else(|error| error.into_inner()) = Some(shown);
  }

  fn shown(&self) -> Option<Shown> {
    self
      .shown
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .clone()
  }
}

/// The one action the panel offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeFix {
  /// The OS has not asked for the microphone yet: ask now.
  Request,
  /// Open the OS page where the microphone is allowed.
  OpenSettings,
  /// Open the sound input settings, where the input device is chosen.
  OpenSound,
}

/// What the panel offers: `None` where this OS has nowhere to send the user.
pub const fn fix_for(
  kind: NoticeKind,
  status: PermissionStatus,
  has_settings_page: bool,
) -> Option<NoticeFix> {
  match (kind, status) {
    (NoticeKind::Microphone, PermissionStatus::NotDetermined) => {
      Some(NoticeFix::Request)
    }
    (NoticeKind::Microphone, _) if has_settings_page => Some(NoticeFix::OpenSettings),
    (NoticeKind::NothingHeard, _) if has_settings_page => Some(NoticeFix::OpenSound),
    _ => None,
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeSnapshot {
  kind: NoticeKind,
  fix: Option<NoticeFix>,
  /// The input device the dictation listened to, as the OS names it.
  input_device: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeAction {
  Fix,
  Dismiss,
}

/// The catalogue keys of a notice's title and body.
pub const fn notice_text(
  kind: NoticeKind,
  microphone: PermissionStatus,
  mac: bool,
) -> (&'static str, &'static str) {
  match (kind, microphone) {
    (NoticeKind::NothingHeard, _) => (
      "dictation.notice.nothingTitle",
      "dictation.notice.nothingBody",
    ),
    (NoticeKind::Microphone, PermissionStatus::NotDetermined) => {
      ("dictation.notice.title", "dictation.notice.allowBody")
    }
    (NoticeKind::Microphone, _) if mac => {
      ("dictation.notice.title", "dictation.notice.checkBodyMac")
    }
    (NoticeKind::Microphone, _) => {
      ("dictation.notice.title", "dictation.notice.checkBodyPc")
    }
  }
}

/// Opens Settings → Dictation when this notice's notification is clicked.
pub fn listen_for_clicks(app: &AppHandle) {
  use tauri_plugin_notification::NotificationExt;

  let handle = app.clone();
  crate::logging::best_effort(
    app.notification().on_action(move |performed| {
      if performed.notification().map(|shown| shown.id()) == Some(NOTIFICATION_ID) {
        crate::ensure_main_window(&handle, crate::PreferencesTab::Dictation);
      }
    }),
    "dictation notice clicks are not heard",
  );
}

/// Shows the notice as a system notification; false where notifications
/// are off or could not be shown.
fn notify(app: &AppHandle, kind: NoticeKind, input_device: Option<&str>) -> bool {
  use tauri_plugin_notification::NotificationExt;

  if permissions::status(app, Permission::Notifications) != PermissionStatus::Granted {
    return false;
  }
  let (title, body) = notice_text(
    kind,
    permissions::status(app, Permission::Microphone),
    cfg!(target_os = "macos"),
  );
  let mut text = crate::i18n::t(body).to_string();
  if let Some(device) = input_device {
    text.push('\n');
    text.push_str(&crate::i18n::t_fmt(
      "dictation.notice.inputDevice",
      &[("device", device)],
    ));
  }
  app
    .notification()
    .builder()
    .id(NOTIFICATION_ID)
    .title(crate::i18n::t(title))
    .body(text)
    .show()
    .inspect_err(|error| tracing::warn!(%error, "dictation notice was not notified"))
    .is_ok()
}

/// Called with every failed dictation; tells the speaker when the gate
/// admits it: a notification, else the panel, or an open panel brought up to
/// date.
pub fn on_failure(app: &AppHandle, failure: Failure, input_device: Option<String>) {
  let notice = app.state::<DictationNotice>();
  let Some(kind) = notice.admit(failure) else {
    return;
  };
  let notified = notify(app, kind, input_device.as_deref());
  notice.set_shown(Shown { kind, input_device });
  if notified {
    return;
  }
  if app.get_webview_window(NOTICE_WINDOW_LABEL).is_some() {
    crate::logging::best_effort(
      app.emit_to(NOTICE_WINDOW_LABEL, CHANGED_EVENT, ()),
      "emit dictation notice change",
    );
    return;
  }
  show(app);
}

fn show(app: &AppHandle) {
  let size = LogicalSize::new(WIDTH, HEIGHT);
  let mut builder = crate::app_window::builder(app, NOTICE_WINDOW_LABEL, "index.html")
    .title("stella desktop")
    .inner_size(size.width, size.height)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .always_on_top(true)
    .focused(false)
    .skip_taskbar(true);
  if let Some(area) = crate::window_placement::target_work_area(app) {
    let origin = crate::window_placement::centered_origin(area, size);
    let y = (area.y + area.height - HEIGHT - BOTTOM_GAP).max(area.y);
    builder = builder.position(origin.x, y);
  }
  if builder.build().is_err() {
    tracing::warn!("dictation notice could not be created");
    return;
  }
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(LINGER).await;
    close(&app);
  });
}

fn close(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(NOTICE_WINDOW_LABEL)
    && window.close().is_err()
  {
    tracing::warn!("dictation notice could not be closed");
  }
}

#[tauri::command]
pub async fn dictation_notice_get_state(
  app: AppHandle,
) -> Result<NoticeSnapshot, String> {
  let Shown { kind, input_device } =
    app.state::<DictationNotice>().shown().unwrap_or(Shown {
      kind: NoticeKind::Microphone,
      input_device: None,
    });
  Ok(NoticeSnapshot {
    kind,
    fix: fix_for(
      kind,
      permissions::status(&app, Permission::Microphone),
      HAS_SETTINGS_PAGE,
    ),
    input_device,
  })
}

#[tauri::command]
pub async fn dictation_notice_respond(
  app: AppHandle,
  action: NoticeAction,
) -> Result<(), String> {
  close(&app);
  if action == NoticeAction::Dismiss {
    return Ok(());
  }
  let kind = app
    .state::<DictationNotice>()
    .shown()
    .map_or(NoticeKind::Microphone, |shown| shown.kind);
  let fix_app = app.clone();
  tauri::async_runtime::spawn_blocking(move || match kind {
    NoticeKind::Microphone => permissions::request(&fix_app, Permission::Microphone),
    NoticeKind::NothingHeard => open_sound_input_settings(),
  })
  .await
  .map_err(crate::logging::with_cause_logged(
    "dictation notice action could not run",
  ))?
}

/// The sound input settings, trying each address this OS may know.
fn open_sound_input_settings() -> Result<(), String> {
  #[cfg(any(target_os = "macos", target_os = "windows"))]
  {
    let mut last = Err("no sound settings address".to_string());
    for url in SOUND_INPUT_URLS {
      last = opener::open(url).map_err(crate::logging::with_cause_logged(
        "sound settings could not be opened",
      ));
      if last.is_ok() {
        break;
      }
    }
    last
  }
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  {
    Err("this computer has no sound settings page to open".to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const fn at(seconds: u64) -> Duration {
    Duration::from_secs(seconds)
  }

  #[test]
  fn a_microphone_failure_shows_one_notice() {
    let mut gate = NoticeGate::default();

    assert_eq!(
      gate.admit(Failure::Microphone, at(100)),
      Some(NoticeKind::Microphone)
    );
    // Holding the key again with the microphone still off adds nothing.
    assert_eq!(gate.admit(Failure::Microphone, at(101)), None);
    assert_eq!(gate.admit(Failure::Microphone, at(129)), None);
  }

  #[test]
  fn a_failure_after_the_repeat_window_shows_the_notice_again() {
    let mut gate = NoticeGate::default();
    assert!(gate.admit(Failure::Microphone, at(100)).is_some());

    assert!(gate.admit(Failure::Microphone, at(130)).is_some());
    // The window restarts from the notice just shown.
    assert!(gate.admit(Failure::Microphone, at(140)).is_none());
  }

  #[test]
  fn a_dictation_that_heard_no_speech_shows_its_own_notice_once() {
    let mut gate = NoticeGate::default();
    assert!(gate.admit(Failure::Microphone, at(100)).is_some());

    // A different outcome is news even inside the microphone's window.
    assert_eq!(
      gate.admit(Failure::NothingHeard, at(105)),
      Some(NoticeKind::NothingHeard)
    );
    assert_eq!(gate.admit(Failure::NothingHeard, at(110)), None);
    assert_eq!(
      gate.admit(Failure::NothingHeard, at(135)),
      Some(NoticeKind::NothingHeard)
    );
  }

  #[test]
  fn other_failures_show_no_notice_and_leave_the_next_one_due() {
    let mut gate = NoticeGate::default();
    for failure in [
      Failure::Accessibility,
      Failure::ModelMissing,
      Failure::Transcription,
      Failure::FocusChanged,
      Failure::FocusUnconfirmed,
      Failure::ShortcutHeld,
      Failure::CloudTranscription,
      Failure::PasswordField,
    ] {
      assert_eq!(gate.admit(failure, at(100)), None, "{failure:?}");
    }

    assert!(gate.admit(Failure::Microphone, at(100)).is_some());
    assert!(gate.admit(Failure::NothingHeard, at(100)).is_some());
  }

  #[test]
  fn an_unasked_microphone_is_asked_for_and_any_other_is_sent_to_settings() {
    assert_eq!(
      fix_for(
        NoticeKind::Microphone,
        PermissionStatus::NotDetermined,
        true
      ),
      Some(NoticeFix::Request)
    );
    for status in [
      PermissionStatus::Denied,
      PermissionStatus::Granted,
      PermissionStatus::NotApplicable,
    ] {
      assert_eq!(
        fix_for(NoticeKind::Microphone, status, true),
        Some(NoticeFix::OpenSettings)
      );
      assert_eq!(fix_for(NoticeKind::Microphone, status, false), None);
    }
  }

  #[test]
  fn no_speech_sends_the_speaker_to_the_sound_input_settings() {
    for status in [PermissionStatus::Granted, PermissionStatus::NotDetermined] {
      assert_eq!(
        fix_for(NoticeKind::NothingHeard, status, true),
        Some(NoticeFix::OpenSound)
      );
      assert_eq!(fix_for(NoticeKind::NothingHeard, status, false), None);
    }
  }

  #[test]
  fn each_notice_says_what_happened_and_what_to_check() {
    assert_eq!(
      notice_text(
        NoticeKind::Microphone,
        PermissionStatus::NotDetermined,
        true
      ),
      ("dictation.notice.title", "dictation.notice.allowBody")
    );
    assert_eq!(
      notice_text(NoticeKind::Microphone, PermissionStatus::Denied, true),
      ("dictation.notice.title", "dictation.notice.checkBodyMac")
    );
    assert_eq!(
      notice_text(NoticeKind::Microphone, PermissionStatus::Granted, false),
      ("dictation.notice.title", "dictation.notice.checkBodyPc")
    );
    assert_eq!(
      notice_text(NoticeKind::NothingHeard, PermissionStatus::Granted, true),
      (
        "dictation.notice.nothingTitle",
        "dictation.notice.nothingBody"
      )
    );
  }

  #[test]
  fn every_notice_text_is_in_every_locale() {
    for key in [
      "dictation.notice.title",
      "dictation.notice.allowBody",
      "dictation.notice.checkBodyMac",
      "dictation.notice.checkBodyPc",
      "dictation.notice.nothingTitle",
      "dictation.notice.nothingBody",
      "dictation.notice.inputDevice",
    ] {
      assert!(
        crate::i18n::locales_missing(key).is_empty(),
        "missing {key}"
      );
    }
  }

  #[test]
  fn the_panel_reads_its_state_by_string_name() {
    assert_eq!(
      serde_json::to_value(NoticeSnapshot {
        kind: NoticeKind::NothingHeard,
        fix: Some(NoticeFix::OpenSound),
        input_device: Some("AirPods Pro 3".to_string()),
      })
      .unwrap(),
      serde_json::json!({
        "kind": "nothingHeard",
        "fix": "openSound",
        "inputDevice": "AirPods Pro 3",
      })
    );
    assert_eq!(
      serde_json::from_value::<NoticeAction>(serde_json::json!("fix")).unwrap(),
      NoticeAction::Fix
    );
  }
}
