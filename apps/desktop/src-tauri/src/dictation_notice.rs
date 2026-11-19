//! Says at once, where the speaker is working, that dictation could not hear
//! the microphone: a small panel near the bottom of the screen with the one
//! action that fixes it, asking for the microphone while the OS has not asked
//! yet and otherwise opening its settings page. Settings → Dictation keeps the
//! same failure on its own line; the panel is what the speaker sees while
//! holding the key away from that window.

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
use tauri::{AppHandle, LogicalSize, Manager};

use crate::{
  dictation::Failure,
  permissions::{self, Permission, PermissionStatus},
};

pub const NOTICE_WINDOW_LABEL: &str = "dictation-notice";

const WIDTH: f64 = 420.0;
const HEIGHT: f64 = 140.0;
/// Room left above the bottom of the work area, clear of the Dock or taskbar.
const BOTTOM_GAP: f64 = 48.0;
/// Another failure this soon after a notice shows nothing new: holding the
/// key again and again with the microphone still off does not stack panels.
const REPEAT_WINDOW: Duration = Duration::from_secs(30);
/// An untouched panel goes away on its own.
const LINGER: Duration = Duration::from_secs(12);
// A panel closing on its own can never close the next one.
const _: () = assert!(LINGER.as_secs() < REPEAT_WINDOW.as_secs());

/// Whether this OS has a microphone page the panel can open.
const HAS_SETTINGS_PAGE: bool = cfg!(any(target_os = "macos", target_os = "windows"));

/// Decides which failed dictations get a notice. Time is a monotonic offset
/// handed in by the caller, so the rule is tested without a clock.
#[derive(Debug, Default)]
pub struct NoticeGate {
  last_shown: Option<Duration>,
}

impl NoticeGate {
  /// Whether a dictation that failed with `failure` at `now` shows the
  /// panel: microphone failures only, at most once per `REPEAT_WINDOW`.
  pub fn admit(&mut self, failure: Failure, now: Duration) -> bool {
    if failure != Failure::Microphone {
      return false;
    }
    let due = self
      .last_shown
      .is_none_or(|last| now.saturating_sub(last) >= REPEAT_WINDOW);
    if due {
      self.last_shown = Some(now);
    }
    due
  }
}

/// The gate and the start of its clock, kept for the life of the app.
pub struct DictationNotice {
  epoch: Instant,
  gate: Mutex<NoticeGate>,
}

impl Default for DictationNotice {
  fn default() -> Self {
    Self {
      epoch: Instant::now(),
      gate: Mutex::default(),
    }
  }
}

impl DictationNotice {
  fn admit(&self, failure: Failure) -> bool {
    let now = self.epoch.elapsed();
    self
      .gate
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .admit(failure, now)
  }
}

/// The one action the panel offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MicrophoneFix {
  /// The OS has not asked yet: ask now.
  Request,
  /// Open the OS page where the microphone is allowed.
  OpenSettings,
}

/// What the panel shows: `None` where this OS has nowhere to send the user.
pub const fn fix_for(
  status: PermissionStatus,
  has_settings_page: bool,
) -> Option<MicrophoneFix> {
  match status {
    PermissionStatus::NotDetermined => Some(MicrophoneFix::Request),
    PermissionStatus::Granted
    | PermissionStatus::Denied
    | PermissionStatus::Managed
    | PermissionStatus::NotApplicable => {
      if has_settings_page {
        Some(MicrophoneFix::OpenSettings)
      } else {
        None
      }
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeSnapshot {
  fix: Option<MicrophoneFix>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeAction {
  Fix,
  Dismiss,
}

/// Called with every failed dictation; shows the panel when the gate admits
/// it.
pub fn on_failure(app: &AppHandle, failure: Failure) {
  if app.state::<DictationNotice>().admit(failure) {
    show(app);
  }
}

fn show(app: &AppHandle) {
  if app.get_webview_window(NOTICE_WINDOW_LABEL).is_some() {
    return;
  }
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
  Ok(NoticeSnapshot {
    fix: fix_for(
      permissions::status(&app, Permission::Microphone),
      HAS_SETTINGS_PAGE,
    ),
  })
}

#[tauri::command]
pub async fn dictation_notice_respond(
  app: AppHandle,
  action: NoticeAction,
) -> Result<(), String> {
  close(&app);
  match action {
    NoticeAction::Dismiss => Ok(()),
    NoticeAction::Fix => {
      let request_app = app.clone();
      tauri::async_runtime::spawn_blocking(move || {
        permissions::request(&request_app, Permission::Microphone)
      })
      .await
      .map_err(crate::logging::with_cause_logged(
        "microphone request could not run",
      ))?
    }
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

    assert!(gate.admit(Failure::Microphone, at(100)));
    // Holding the key again with the microphone still off adds nothing.
    assert!(!gate.admit(Failure::Microphone, at(101)));
    assert!(!gate.admit(Failure::Microphone, at(129)));
  }

  #[test]
  fn a_failure_after_the_repeat_window_shows_the_notice_again() {
    let mut gate = NoticeGate::default();
    assert!(gate.admit(Failure::Microphone, at(100)));

    assert!(gate.admit(Failure::Microphone, at(130)));
    // The window restarts from the notice just shown.
    assert!(!gate.admit(Failure::Microphone, at(140)));
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
      assert!(!gate.admit(failure, at(100)), "{failure:?}");
    }

    assert!(gate.admit(Failure::Microphone, at(100)));
  }

  #[test]
  fn an_unasked_microphone_is_asked_for_and_any_other_is_sent_to_settings() {
    assert_eq!(
      fix_for(PermissionStatus::NotDetermined, true),
      Some(MicrophoneFix::Request)
    );
    for status in [
      PermissionStatus::Denied,
      PermissionStatus::Granted,
      PermissionStatus::NotApplicable,
    ] {
      assert_eq!(fix_for(status, true), Some(MicrophoneFix::OpenSettings));
      assert_eq!(fix_for(status, false), None);
    }
  }

  #[test]
  fn the_panel_reads_its_action_by_string_name() {
    assert_eq!(
      serde_json::to_value(NoticeSnapshot {
        fix: Some(MicrophoneFix::OpenSettings)
      })
      .unwrap(),
      serde_json::json!({ "fix": "openSettings" })
    );
    assert_eq!(
      serde_json::from_value::<NoticeAction>(serde_json::json!("fix")).unwrap(),
      NoticeAction::Fix
    );
  }
}
