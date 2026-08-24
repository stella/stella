use std::time::Duration;
use tauri::AppHandle;

#[cfg(target_os = "macos")]
use std::sync::Mutex;

const FALLBACK_FOCUS_DELAY: Duration = Duration::from_millis(100);
#[cfg(target_os = "macos")]
const FOCUS_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(target_os = "macos")]
const FOCUS_RESTORE_TIMEOUT: Duration = Duration::from_millis(500);

#[cfg(target_os = "macos")]
use objc2::{MainThreadMarker, rc::Retained};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
  NSApplication, NSApplicationActivationOptions, NSRunningApplication, NSWorkspace,
};

#[derive(Default)]
#[cfg(target_os = "macos")]
pub struct ClipboardFocusState {
  previous_application: Mutex<Option<Retained<NSRunningApplication>>>,
}

#[cfg(not(target_os = "macos"))]
pub struct ClipboardFocusState {
  fallback_delay: Duration,
}

#[cfg(not(target_os = "macos"))]
impl Default for ClipboardFocusState {
  fn default() -> Self {
    Self {
      fallback_delay: FALLBACK_FOCUS_DELAY,
    }
  }
}

impl ClipboardFocusState {
  #[cfg(target_os = "macos")]
  pub fn remember_frontmost_application(&self) {
    let Some(frontmost) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
      return;
    };
    let current = NSRunningApplication::currentApplication();
    if frontmost.processIdentifier() == current.processIdentifier() {
      return;
    }
    if let Ok(mut previous_application) = self.previous_application.lock() {
      *previous_application = Some(frontmost);
    }
  }

  #[cfg(not(target_os = "macos"))]
  pub fn remember_frontmost_application(&self) {
    let _ = self.fallback_delay;
  }

  #[cfg(target_os = "macos")]
  pub async fn restore_frontmost_application(&self, app: &AppHandle) {
    let target = self
      .previous_application
      .lock()
      .ok()
      .and_then(|mut previous_application| previous_application.take());
    let Some(target) = target else {
      tokio::time::sleep(FALLBACK_FOCUS_DELAY).await;
      return;
    };

    let target_to_activate = target.clone();
    if let Err(error) = app.run_on_main_thread(move || {
      let Some(main_thread_marker) = MainThreadMarker::new() else {
        tracing::warn!("clipboard focus handoff was not run on the main thread");
        return;
      };
      let current = NSApplication::sharedApplication(main_thread_marker);
      current.yieldActivationToApplication(&target_to_activate);
      if !target_to_activate
        .activateWithOptions(NSApplicationActivationOptions::empty())
      {
        tracing::warn!("previous application rejected clipboard focus restoration");
      }
    }) {
      tracing::warn!(error = %error, "clipboard focus restoration could not be scheduled");
      tokio::time::sleep(FALLBACK_FOCUS_DELAY).await;
      return;
    }

    let deadline = tokio::time::Instant::now() + FOCUS_RESTORE_TIMEOUT;
    while !target.isActive() && !target.isTerminated() {
      if tokio::time::Instant::now() >= deadline {
        tracing::warn!("timed out while restoring focus before clipboard paste");
        return;
      }
      tokio::time::sleep(FOCUS_POLL_INTERVAL).await;
    }
  }

  #[cfg(not(target_os = "macos"))]
  pub async fn restore_frontmost_application(&self, _app: &AppHandle) {
    tokio::time::sleep(self.fallback_delay).await;
  }
}
