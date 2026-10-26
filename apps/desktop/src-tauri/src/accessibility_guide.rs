//! A small panel docked under System Settings while the user turns on
//! Accessibility for stella desktop. Asking for the permission already adds
//! the app to the list, switched off; the panel says what to do there, shows
//! when it worked, and goes away on its own.

use serde::Serialize;
use tauri::AppHandle;

use crate::permissions::{Permission, PermissionStatus};

pub const GUIDE_WINDOW_LABEL: &str = "accessibility-guide";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GuideStatus {
  Waiting,
  Allowed,
}

#[tauri::command]
pub async fn accessibility_guide_get_state(
  app: AppHandle,
) -> Result<GuideStatus, String> {
  Ok(current_status(&app))
}

fn current_status(app: &AppHandle) -> GuideStatus {
  match crate::permissions::status(app, Permission::Accessibility) {
    PermissionStatus::Granted => GuideStatus::Allowed,
    PermissionStatus::NotDetermined
    | PermissionStatus::Denied
    | PermissionStatus::Managed
    | PermissionStatus::NotApplicable => GuideStatus::Waiting,
  }
}

#[cfg(not(target_os = "macos"))]
pub fn show(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
pub fn show(app: &AppHandle) {
  macos::show(app);
}

#[cfg(target_os = "macos")]
mod macos {
  use std::time::{Duration, Instant};

  use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

  use super::{GUIDE_WINDOW_LABEL, GuideStatus, current_status};

  /// Payload-free: the panel re-reads its state.
  const CHANGED_EVENT: &str = "accessibility-guide-changed";

  const WIDTH: f64 = 440.0;
  const HEIGHT: f64 = 92.0;
  const GAP: f64 = 12.0;
  const POLL: Duration = Duration::from_millis(250);
  /// How long Settings may take to appear before the guide gives up.
  const SETTINGS_APPEAR_TIMEOUT: Duration = Duration::from_secs(6);
  /// Settings briefly has no window while it switches panes.
  const SETTINGS_GONE_GRACE: Duration = Duration::from_millis(600);
  const ALLOWED_LINGER: Duration = Duration::from_millis(900);
  const GUIDE_TIMEOUT: Duration = Duration::from_secs(600);
  const SETTINGS_BUNDLE_ID: &str = "com.apple.systempreferences";

  pub fn show(app: &AppHandle) {
    if app.get_webview_window(GUIDE_WINDOW_LABEL).is_some() {
      return;
    }
    let builder = crate::app_window::builder(app, GUIDE_WINDOW_LABEL, "index.html")
      .title("stella desktop")
      .inner_size(WIDTH, HEIGHT)
      .resizable(false)
      .decorations(false)
      .transparent(true)
      .shadow(true)
      .always_on_top(true)
      .focused(false)
      .skip_taskbar(true)
      .visible(false);
    if builder.build().is_err() {
      tracing::warn!("accessibility guide could not be created");
      return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { follow_settings(app).await });
  }

  fn settings_bounds() -> Option<stella_desktop_macos::WindowBounds> {
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;
    let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(
      &NSString::from_str(SETTINGS_BUNDLE_ID),
    );
    running.iter().find_map(|settings| {
      stella_desktop_macos::largest_window_bounds(settings.processIdentifier())
    })
  }

  /// Below the Settings window, centred on it; inside its lower edge when
  /// there is no room underneath.
  fn docked_position(
    settings: stella_desktop_macos::WindowBounds,
    screen_bottom: Option<f64>,
  ) -> LogicalPosition<f64> {
    let x = settings.x + (settings.width - WIDTH) / 2.0;
    let below = settings.y + settings.height + GAP;
    let fits_below = screen_bottom.is_none_or(|bottom| below + HEIGHT <= bottom);
    let y = if fits_below {
      below
    } else {
      settings.y + settings.height - HEIGHT - GAP
    };
    LogicalPosition::new(x, y)
  }

  fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(GUIDE_WINDOW_LABEL)
      && window.close().is_err()
    {
      tracing::warn!("accessibility guide could not be closed");
    }
  }

  async fn follow_settings(app: AppHandle) {
    let started = Instant::now();
    let mut last_seen: Option<Instant> = None;
    loop {
      tokio::time::sleep(POLL).await;
      let Some(window) = app.get_webview_window(GUIDE_WINDOW_LABEL) else {
        return;
      };
      if current_status(&app) == GuideStatus::Allowed {
        crate::logging::best_effort(
          app.emit_to(GUIDE_WINDOW_LABEL, CHANGED_EVENT, ()),
          "emit accessibility guide change",
        );
        tokio::time::sleep(ALLOWED_LINGER).await;
        close(&app);
        return;
      }
      if started.elapsed() > GUIDE_TIMEOUT {
        close(&app);
        return;
      }
      let lookup = tauri::async_runtime::spawn_blocking(settings_bounds)
        .await
        .ok()
        .flatten();
      let Some(settings) = lookup else {
        let gone_too_long = last_seen.map_or_else(
          || started.elapsed() > SETTINGS_APPEAR_TIMEOUT,
          |seen| seen.elapsed() > SETTINGS_GONE_GRACE,
        );
        if gone_too_long {
          close(&app);
          return;
        }
        continue;
      };
      last_seen = Some(Instant::now());
      let settings_centre = LogicalPosition::new(
        settings.x + settings.width / 2.0,
        settings.y + settings.height / 2.0,
      );
      let placement_app = app.clone();
      let screen_bottom = tauri::async_runtime::spawn_blocking(move || {
        crate::window_placement::work_area_at(&placement_app, settings_centre)
      })
      .await
      .ok()
      .flatten()
      .map(|area| area.y + area.height);
      crate::logging::best_effort(
        window.set_size(LogicalSize::new(WIDTH, HEIGHT)),
        "resize accessibility guide",
      );
      crate::logging::best_effort(
        window.set_position(docked_position(settings, screen_bottom)),
        "position accessibility guide",
      );
      if !window.is_visible().unwrap_or(false) {
        crate::logging::best_effort(window.show(), "show accessibility guide");
      }
    }
  }

  #[cfg(test)]
  mod tests {
    use super::*;

    #[test]
    fn the_guide_docks_below_settings_when_it_fits_and_inside_otherwise() {
      let settings = stella_desktop_macos::WindowBounds {
        x: 100.0,
        y: 100.0,
        width: 800.0,
        height: 600.0,
      };
      let below = docked_position(settings, Some(2000.0));
      assert_eq!(below.y, 100.0 + 600.0 + GAP);
      assert_eq!(below.x, 100.0 + (800.0 - WIDTH) / 2.0);
      let inside = docked_position(settings, Some(750.0));
      assert_eq!(inside.y, 100.0 + 600.0 - HEIGHT - GAP);
    }
  }
}
