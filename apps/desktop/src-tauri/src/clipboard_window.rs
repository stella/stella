use std::{
  sync::Mutex,
  time::{Duration, Instant},
};
use tauri::{
  AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow,
  webview::PageLoadEvent,
  window::{Effect, EffectState, EffectsBuilder},
};

use crate::clipboard::ClipboardAppState;
use crate::clipboard_screen_capture::ClipboardScreenCapture;
use crate::desktop_telemetry::{
  ClipboardOpenKind, DesktopErrorReport, DesktopTelemetry, DesktopTelemetryErrorCode,
  DesktopTelemetryOperation, DesktopTelemetrySpan, DesktopTelemetryWindow,
  DesktopTimingReport,
};
use crate::window_placement::{self, WorkArea};

const CLIPBOARD_WINDOW_LABEL: &str = "clipboard";
const CLIPBOARD_EDITOR_WINDOW_LABEL: &str = "clipboard-editor";
const CLIPBOARD_WINDOW_HEIGHT: f64 = 326.0;
const CLIPBOARD_WINDOW_INSET: f64 = 18.0;
const CLIPBOARD_WINDOW_RADIUS: f64 = 28.0;
const CLIPBOARD_EDITOR_WIDTH: f64 = 700.0;
const CLIPBOARD_EDITOR_HEIGHT: f64 = 520.0;

/// Whether the clipboard window is parked. Parking keeps the window on screen
/// fully transparent and click-through instead of ordering it out: WebKit
/// reclaims a hidden page's graphics caches within seconds and its compiled JS
/// within minutes, which made the next open after an idle spell paint its
/// content 200-600ms late. A parked page stays warm, so reopening paints
/// immediately.
#[derive(Default)]
pub struct ClipboardWindowPark(Mutex<bool>);

impl ClipboardWindowPark {
  fn is_parked(&self) -> bool {
    self.0.lock().map(|parked| *parked).unwrap_or(false)
  }

  #[cfg(target_os = "macos")]
  fn set_parked(&self, parked: bool) {
    if let Ok(mut state) = self.0.lock() {
      *state = parked;
    }
  }
}

/// Timing anchor for the clipboard window's creation. Page load and frontend
/// spans are measured against it, and the first snapshot read after creation
/// claims its spans once so steady-state history reads stay unmeasured.
#[derive(Default)]
pub struct ClipboardStartupTrace(Mutex<Option<StartupTrace>>);

struct StartupTrace {
  started: Instant,
  open_kind: ClipboardOpenKind,
  snapshot_claimed: bool,
}

impl ClipboardStartupTrace {
  fn begin(&self, started: Instant, open_kind: ClipboardOpenKind) {
    if let Ok(mut trace) = self.0.lock() {
      *trace = Some(StartupTrace {
        started,
        open_kind,
        snapshot_claimed: false,
      });
    }
  }

  fn elapsed(&self) -> Option<(Duration, ClipboardOpenKind)> {
    let trace = self.0.lock().ok()?;
    let trace = trace.as_ref()?;
    Some((trace.started.elapsed(), trace.open_kind))
  }

  pub fn open_kind(&self) -> Option<ClipboardOpenKind> {
    self.0.lock().ok()?.as_ref().map(|trace| trace.open_kind)
  }

  /// Open kind for the first snapshot read after the window was created;
  /// `None` for every later read.
  pub fn claim_snapshot(&self) -> Option<ClipboardOpenKind> {
    let mut trace = self.0.lock().ok()?;
    let trace = trace.as_mut()?;
    if trace.snapshot_claimed {
      return None;
    }
    trace.snapshot_claimed = true;
    Some(trace.open_kind)
  }
}

fn capture_window_timing(
  app: &AppHandle,
  span: DesktopTelemetrySpan,
  duration: Duration,
  open_kind: ClipboardOpenKind,
) {
  if let Some(telemetry) = app.try_state::<DesktopTelemetry>() {
    telemetry.capture_timing(DesktopTimingReport {
      window: DesktopTelemetryWindow::Clipboard,
      span,
      duration,
      open_kind: Some(open_kind),
      item_count: None,
      payload_bytes: None,
    });
  }
}

fn capture_window_error(
  app: &AppHandle,
  operation: DesktopTelemetryOperation,
  window: DesktopTelemetryWindow,
) {
  if let Some(telemetry) = app.try_state::<DesktopTelemetry>() {
    telemetry.capture(DesktopErrorReport {
      window,
      operation,
      code: DesktopTelemetryErrorCode::WindowUnavailable,
    });
  }
}

/// The rail's frame docked to the bottom of a work area, inset on all sides
/// and shortened when the area is too low for the full height.
fn docked_frame(work_area: WorkArea) -> DockedRect {
  let width = (work_area.width - (CLIPBOARD_WINDOW_INSET * 2.0)).max(1.0);
  let available_height = (work_area.height - (CLIPBOARD_WINDOW_INSET * 2.0)).max(1.0);
  let height = CLIPBOARD_WINDOW_HEIGHT.min(available_height);
  DockedRect {
    x: work_area.x + CLIPBOARD_WINDOW_INSET,
    y: work_area.y + work_area.height - height - CLIPBOARD_WINDOW_INSET,
    width,
    height,
  }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct DockedRect {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
}

/// Docks the rail to the bottom of the target screen. With no screen known the
/// window keeps its last frame.
fn position_window(app: &AppHandle, window: &WebviewWindow) {
  let Some(work_area) = window_placement::target_work_area(app) else {
    return;
  };
  let frame = docked_frame(work_area);
  let _ = window.set_size(LogicalSize::new(frame.width, frame.height));
  let _ = window.set_position(LogicalPosition::new(frame.x, frame.y));
}

/// Runs `f` on the main thread and waits for its result; `default` when the
/// event loop is gone or does not answer in time.
#[cfg(target_os = "macos")]
fn on_main_thread<T: Send + 'static>(
  window: &WebviewWindow,
  default: T,
  f: impl FnOnce(&WebviewWindow) -> T + Send + 'static,
) -> T {
  let cloned = window.clone();
  window_placement::on_main_thread(window.app_handle(), default, move || f(&cloned))
}

/// Shows the window as the key window without activating the app: the app the
/// user was working in stays frontmost and gets its caret back on dismissal.
/// Falls back to an activating show when the panel cannot be presented.
#[cfg(target_os = "macos")]
fn present(window: &WebviewWindow) -> tauri::Result<()> {
  let presented = on_main_thread(window, false, |window| {
    let presented = stella_desktop_macos::present_key_panel(window);
    if presented
      && let Some(park) = window.app_handle().try_state::<ClipboardWindowPark>()
    {
      park.set_parked(false);
    }
    presented
  });
  if presented {
    return Ok(());
  }
  window.show().and_then(|()| window.set_focus())
}

#[cfg(not(target_os = "macos"))]
fn present(window: &WebviewWindow) -> tauri::Result<()> {
  window.show().and_then(|()| window.set_focus())
}

/// Parks the window instead of hiding it. Returns false when parking is not
/// possible (no main thread, no window handle); the caller then falls back to
/// ordering the window out.
#[cfg(target_os = "macos")]
fn park(window: &WebviewWindow) -> bool {
  on_main_thread(window, false, |window| {
    let Some(park) = window.app_handle().try_state::<ClipboardWindowPark>() else {
      return false;
    };
    if park.is_parked() {
      return true;
    }
    if !stella_desktop_macos::park_window(window) {
      return false;
    }
    park.set_parked(true);
    true
  })
}

/// Whether the clipboard windows are kept out of screenshots and screen
/// recordings. Hidden is the safe default whenever the preference cannot be
/// read.
fn content_protected(app: &AppHandle) -> bool {
  let Some(state) = app.try_state::<ClipboardAppState>() else {
    return true;
  };
  let Ok(manager) = state.lock() else {
    return true;
  };
  manager.screen_capture() == ClipboardScreenCapture::Hidden
}

/// Applies the preference to the windows that already exist; a window created
/// later reads it from `content_protected`.
pub fn apply_screen_capture(
  app: &AppHandle,
  capture: ClipboardScreenCapture,
) -> Result<(), String> {
  let protected = capture == ClipboardScreenCapture::Hidden;
  let mut failure = None;
  for label in [CLIPBOARD_WINDOW_LABEL, CLIPBOARD_EDITOR_WINDOW_LABEL] {
    let Some(window) = app.get_webview_window(label) else {
      continue;
    };
    if let Err(error) = window.set_content_protected(protected)
      && failure.is_none()
    {
      failure = Some(format!(
        "clipboard window screen recording setting failed: {error}"
      ));
    }
  }
  failure.map_or(Ok(()), Err)
}

pub fn show(app: &AppHandle) {
  show_as(app, ClipboardOpenKind::FirstOpen);
}

pub fn show_on_launch(app: &AppHandle) {
  show_as(app, ClipboardOpenKind::Launch);
}

/// `created_kind` labels the trace when the window has to be created; an
/// existing window is always a reopen.
fn show_as(app: &AppHandle, created_kind: ClipboardOpenKind) {
  let requested = Instant::now();

  if let Some(window) = app.get_webview_window(CLIPBOARD_WINDOW_LABEL) {
    position_window(app, &window);
    if present(&window).is_err() {
      capture_window_error(
        app,
        DesktopTelemetryOperation::ClipboardWindowOpen,
        DesktopTelemetryWindow::Clipboard,
      );
      return;
    }
    capture_window_timing(
      app,
      DesktopTelemetrySpan::ClipboardWindowShow,
      requested.elapsed(),
      ClipboardOpenKind::Reopen,
    );
    return;
  }

  if let Some(trace) = app.try_state::<ClipboardStartupTrace>() {
    trace.begin(requested, created_kind);
  }

  let builder = tauri::WebviewWindowBuilder::new(
    app,
    CLIPBOARD_WINDOW_LABEL,
    tauri::WebviewUrl::App("index.html".into()),
  )
  .title("stella clipboard")
  .inner_size(1440.0, CLIPBOARD_WINDOW_HEIGHT)
  .always_on_top(true)
  .content_protected(content_protected(app))
  .decorations(false)
  // Tauri's native drag-drop handler consumes every drop on macOS and
  // Windows, so HTML5 drops (a card onto a group chip) never reach the
  // webview. The window accepts no OS file drops.
  .disable_drag_drop_handler()
  // Menu is the most translucent appearance-adaptive material: the desktop and
  // windows underneath read through it in light mode too, where Popover is
  // nearly opaque and UnderWindowBackground is flat.
  .effects(
    EffectsBuilder::new()
      .effect(Effect::Menu)
      .effect(Effect::Acrylic)
      .state(EffectState::Active)
      .radius(CLIPBOARD_WINDOW_RADIUS)
      .build(),
  )
  .resizable(false)
  .shadow(false)
  .skip_taskbar(true)
  .transparent(true)
  .visible(false)
  .visible_on_all_workspaces(true)
  .on_page_load(|window, payload| {
    if payload.event() != PageLoadEvent::Finished {
      return;
    }
    let app = window.app_handle();
    position_window(app, &window);
    if present(&window).is_err() {
      capture_window_error(
        app,
        DesktopTelemetryOperation::ClipboardWindowOpen,
        DesktopTelemetryWindow::Clipboard,
      );
      return;
    }
    if let Some((elapsed, open_kind)) = app
      .try_state::<ClipboardStartupTrace>()
      .and_then(|trace| trace.elapsed())
    {
      capture_window_timing(
        app,
        DesktopTelemetrySpan::ClipboardPageLoad,
        elapsed,
        open_kind,
      );
    }
  });

  match builder.build() {
    Ok(window) => {
      capture_window_timing(
        app,
        DesktopTelemetrySpan::ClipboardWindowCreate,
        requested.elapsed(),
        created_kind,
      );
      position_window(app, &window);
      // A parked window (alpha 0) may be reported occluded, which would put
      // WebKit back to sleep and defeat the parking.
      #[cfg(target_os = "macos")]
      stella_desktop_macos::disable_occlusion_detection(&window);
      let window_to_hide = window.clone();
      window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false))
          && hide(&window_to_hide).is_err()
        {
          capture_window_error(
            window_to_hide.app_handle(),
            DesktopTelemetryOperation::ClipboardWindowHide,
            DesktopTelemetryWindow::Clipboard,
          );
        }
      });
    }
    Err(error) => {
      tracing::error!(error = %error, "clipboard window could not be created");
      capture_window_error(
        app,
        DesktopTelemetryOperation::ClipboardWindowOpen,
        DesktopTelemetryWindow::Clipboard,
      );
    }
  }
}

pub fn toggle(app: &AppHandle) {
  let parked = app
    .try_state::<ClipboardWindowPark>()
    .is_some_and(|park| park.is_parked());
  if !parked
    && let Some(window) = app.get_webview_window(CLIPBOARD_WINDOW_LABEL)
    && window.is_visible().unwrap_or(false)
  {
    if hide(&window).is_err() {
      capture_window_error(
        app,
        DesktopTelemetryOperation::ClipboardWindowHide,
        DesktopTelemetryWindow::Clipboard,
      );
    }
    return;
  }
  show(app);
}

/// Parks the window, which also gives key status back to the app underneath,
/// or orders it out when parking is not possible. Serves both an explicit
/// dismissal (Escape, copy) and the hide on blur: whatever the user focused
/// instead keeps it either way.
pub fn hide(window: &WebviewWindow) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  if park(window) {
    return Ok(());
  }
  order_out(window)
}

fn order_out(window: &WebviewWindow) -> Result<(), String> {
  window.hide().map_err(|error| {
    tracing::warn!(error = %error, "clipboard window could not be hidden");
    "clipboard window could not be hidden".to_string()
  })
}

pub fn editor_is_open(app: &AppHandle) -> bool {
  app
    .get_webview_window(CLIPBOARD_EDITOR_WINDOW_LABEL)
    .is_some()
}

pub fn show_editor(app: &AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window(CLIPBOARD_EDITOR_WINDOW_LABEL) {
    return window
      .show()
      .and_then(|()| window.set_focus())
      .map_err(|error| {
        capture_window_error(
          app,
          DesktopTelemetryOperation::ClipboardWindowOpen,
          DesktopTelemetryWindow::ClipboardEditor,
        );
        format!("clipboard editor could not be focused: {error}")
      });
  }

  let builder = tauri::WebviewWindowBuilder::new(
    app,
    CLIPBOARD_EDITOR_WINDOW_LABEL,
    tauri::WebviewUrl::App("index.html".into()),
  )
  .title("Stella")
  .inner_size(CLIPBOARD_EDITOR_WIDTH, CLIPBOARD_EDITOR_HEIGHT)
  .min_inner_size(560.0, 420.0)
  .always_on_top(true)
  .content_protected(content_protected(app))
  .resizable(true)
  .visible(false);
  let builder = window_placement::centered_on_target_screen(
    app,
    builder,
    LogicalSize::new(CLIPBOARD_EDITOR_WIDTH, CLIPBOARD_EDITOR_HEIGHT),
  );
  let builder = builder.on_page_load(|window, payload| {
    if payload.event() != PageLoadEvent::Finished {
      return;
    }
    if window.show().and_then(|()| window.set_focus()).is_err() {
      capture_window_error(
        window.app_handle(),
        DesktopTelemetryOperation::ClipboardWindowOpen,
        DesktopTelemetryWindow::ClipboardEditor,
      );
    }
  });

  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);

  builder.build().map(|_| ()).map_err(|error| {
    capture_window_error(
      app,
      DesktopTelemetryOperation::ClipboardWindowOpen,
      DesktopTelemetryWindow::ClipboardEditor,
    );
    format!("clipboard editor could not be opened: {error}")
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn docks_to_the_bottom_of_a_secondary_screen_above_the_primary() {
    // External 2560x1440 display arranged above a 1728x1117 laptop screen,
    // with a 25pt menu bar and no dock: its work area sits entirely above the
    // primary origin in logical coordinates.
    let frame = docked_frame(WorkArea {
      x: -416.0,
      y: -1415.0,
      width: 2560.0,
      height: 1415.0,
    });

    assert_eq!(
      frame,
      DockedRect {
        x: -398.0,
        y: -18.0 - CLIPBOARD_WINDOW_HEIGHT,
        width: 2524.0,
        height: CLIPBOARD_WINDOW_HEIGHT,
      }
    );
  }

  #[test]
  fn docks_to_the_bottom_of_the_primary_screen_above_the_dock() {
    // 1117pt screen, 25pt menu bar, 70pt dock.
    let frame = docked_frame(WorkArea {
      x: 0.0,
      y: 25.0,
      width: 1728.0,
      height: 1022.0,
    });

    assert_eq!(frame.x, 18.0);
    assert_eq!(frame.height, CLIPBOARD_WINDOW_HEIGHT);
    assert_eq!(frame.y + frame.height, 1117.0 - 70.0 - 18.0);
  }

  #[test]
  fn shrinks_on_a_short_work_area() {
    let frame = docked_frame(WorkArea {
      x: 0.0,
      y: 0.0,
      width: 400.0,
      height: 200.0,
    });

    assert_eq!(frame.height, 200.0 - 36.0);
    assert_eq!(frame.y, 18.0);
  }
}
