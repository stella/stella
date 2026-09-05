//! The one place that decides which screen a window opens on.
//!
//! Every window the app creates resolves its screen through
//! [`target_work_area`]; the raw Tauri and AppKit screen APIs are disallowed
//! everywhere else (`clippy.toml`), so a second rule cannot creep in. The rule:
//! the screen under the cursor, else the focused screen, else the primary.

use tauri::{
  AppHandle, LogicalPosition, LogicalSize, Wry, webview::WebviewWindowBuilder,
};

/// A screen's work area in Tauri logical coordinates: origin at the top-left
/// of the primary screen, y down, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WorkArea {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

/// Top-left corner that centres a window of `size` in `work_area`, pinned to
/// the area's origin when the area is smaller than the window.
pub fn centered_origin(
  work_area: WorkArea,
  size: LogicalSize<f64>,
) -> LogicalPosition<f64> {
  LogicalPosition::new(
    work_area.x + ((work_area.width - size.width) / 2.0).max(0.0),
    work_area.y + ((work_area.height - size.height) / 2.0).max(0.0),
  )
}

/// Centres a window being built on the target screen. Tauri's own centring
/// (primary screen) is the fallback only when no screen is known at all.
pub fn centered_on_target_screen<'a>(
  app: &AppHandle,
  builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
  size: LogicalSize<f64>,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
  match target_work_area(app) {
    Some(work_area) => {
      let origin = centered_origin(work_area, size);
      builder.position(origin.x, origin.y)
    }
    #[allow(
      clippy::disallowed_methods,
      reason = "the fallback when no screen is known; every other caller goes through this owner"
    )]
    None => builder.center(),
  }
}

/// Runs `f` on the main thread and waits for its result; `default` when the
/// event loop is gone or does not answer in time.
#[cfg(target_os = "macos")]
pub(crate) fn on_main_thread<T: Send + 'static>(
  app: &AppHandle,
  default: T,
  f: impl FnOnce() -> T + Send + 'static,
) -> T {
  use objc2::MainThreadMarker;

  if MainThreadMarker::new().is_some() {
    return f();
  }
  let (sender, receiver) = std::sync::mpsc::sync_channel(1);
  if app
    .run_on_main_thread(move || {
      let _ = sender.send(f());
    })
    .is_err()
  {
    return default;
  }
  receiver
    .recv_timeout(std::time::Duration::from_secs(1))
    .unwrap_or(default)
}

// AppKit is queried directly: tao's `cursor_position` returns primary-scaled
// physical pixels while its `monitor_from_point` compares against display
// bounds in points, so on mixed-DPI setups the lookup misses and falls back
// to the primary display. Screen frames and the mouse location share one
// coordinate space here, so containment is exact.
#[cfg(target_os = "macos")]
#[allow(
  clippy::disallowed_methods,
  reason = "this is the owner of screen selection; the ban keeps a second rule from appearing elsewhere"
)]
pub fn target_work_area(app: &AppHandle) -> Option<WorkArea> {
  use objc2::MainThreadMarker;
  use objc2_app_kit::{NSEvent, NSScreen};

  on_main_thread(app, None, || {
    let main_thread = MainThreadMarker::new()?;
    let screens = NSScreen::screens(main_thread);
    let primary = screens.iter().next()?;
    let primary_height = primary.frame().size.height;
    let cursor = NSEvent::mouseLocation();
    let under_cursor = screens.iter().find(|screen| {
      let frame = screen.frame();
      cursor.x >= frame.origin.x
        && cursor.x < frame.origin.x + frame.size.width
        && cursor.y >= frame.origin.y
        && cursor.y < frame.origin.y + frame.size.height
    });
    let focused = NSScreen::mainScreen(main_thread);
    let screen = under_cursor.or(focused).unwrap_or(primary);
    Some(logical_work_area(primary_height, screen.visibleFrame()))
  })
}

/// Cocoa work area (origin bottom-left of the primary screen, y up) as a Tauri
/// logical work area (origin top-left, y down).
#[cfg(target_os = "macos")]
pub(crate) fn logical_work_area(
  primary_height: f64,
  visible_frame: objc2_foundation::NSRect,
) -> WorkArea {
  WorkArea {
    x: visible_frame.origin.x,
    y: primary_height - (visible_frame.origin.y + visible_frame.size.height),
    width: visible_frame.size.width,
    height: visible_frame.size.height,
  }
}

#[cfg(not(target_os = "macos"))]
#[allow(
  clippy::disallowed_methods,
  reason = "this is the owner of screen selection; the ban keeps a second rule from appearing elsewhere"
)]
pub fn target_work_area(app: &AppHandle) -> Option<WorkArea> {
  use tauri::Manager;

  let monitor = app
    .cursor_position()
    .ok()
    .and_then(|position| {
      app
        .monitor_from_point(position.x, position.y)
        .ok()
        .flatten()
    })
    // The focused screen: the one holding the window the user is working in.
    .or_else(|| {
      app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .and_then(|window| window.current_monitor().ok().flatten())
    })
    .or_else(|| app.primary_monitor().ok().flatten())?;
  let scale_factor = monitor.scale_factor();
  let work_area = monitor.work_area();
  let position = work_area.position.to_logical::<f64>(scale_factor);
  let size = work_area.size.to_logical::<f64>(scale_factor);
  Some(WorkArea {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn centres_on_the_given_screen_not_the_primary() {
    // Secondary 2560x1440 display left of the primary, 25pt menu bar.
    let work_area = WorkArea {
      x: -2560.0,
      y: 25.0,
      width: 2560.0,
      height: 1415.0,
    };

    let origin = centered_origin(work_area, LogicalSize::new(700.0, 520.0));

    assert_eq!(origin.x, -2560.0 + (2560.0 - 700.0) / 2.0);
    assert_eq!(origin.y, 25.0 + (1415.0 - 520.0) / 2.0);
  }

  #[test]
  fn pins_to_the_work_area_origin_when_the_window_does_not_fit() {
    let work_area = WorkArea {
      x: 100.0,
      y: 40.0,
      width: 600.0,
      height: 400.0,
    };

    let origin = centered_origin(work_area, LogicalSize::new(700.0, 520.0));

    assert_eq!((origin.x, origin.y), (100.0, 40.0));
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn cocoa_work_areas_flip_into_top_left_logical_coordinates() {
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    // External display above a 1117pt laptop screen, 25pt menu bar.
    let area = logical_work_area(
      1117.0,
      NSRect::new(NSPoint::new(-416.0, 1117.0), NSSize::new(2560.0, 1415.0)),
    );

    assert_eq!(
      area,
      WorkArea {
        x: -416.0,
        y: -1415.0,
        width: 2560.0,
        height: 1415.0,
      }
    );
  }
}
