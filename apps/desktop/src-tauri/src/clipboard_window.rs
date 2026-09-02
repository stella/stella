use std::{
  sync::Mutex,
  time::{Duration, Instant},
};
use tauri::{
  AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow,
  webview::PageLoadEvent,
  window::{Effect, EffectState, EffectsBuilder},
};

use crate::desktop_telemetry::{
  ClipboardOpenKind, DesktopErrorReport, DesktopTelemetry, DesktopTelemetryErrorCode,
  DesktopTelemetryOperation, DesktopTelemetrySpan, DesktopTelemetryWindow,
  DesktopTimingReport,
};

const CLIPBOARD_WINDOW_LABEL: &str = "clipboard";
const CLIPBOARD_EDITOR_WINDOW_LABEL: &str = "clipboard-editor";
const CLIPBOARD_WINDOW_HEIGHT: f64 = 326.0;
const CLIPBOARD_WINDOW_INSET: f64 = 18.0;
const CLIPBOARD_WINDOW_RADIUS: f64 = 28.0;

/// Whether the clipboard window is parked and which app held focus before the
/// window last took it. Parking keeps the window on screen fully transparent
/// and click-through instead of ordering it out: WebKit reclaims a hidden
/// page's graphics caches within seconds and its compiled JS within minutes,
/// which made the next open after an idle spell paint its content 200-600ms
/// late. A parked page stays warm, so reopening paints immediately.
#[derive(Default)]
pub struct ClipboardWindowPark(Mutex<ParkState>);

#[derive(Default)]
struct ParkState {
  parked: bool,
  #[cfg(target_os = "macos")]
  previous_app_pid: Option<i32>,
}

impl ClipboardWindowPark {
  fn is_parked(&self) -> bool {
    self.0.lock().map(|state| state.parked).unwrap_or(false)
  }

  #[cfg(target_os = "macos")]
  fn set_parked(&self, parked: bool) {
    if let Ok(mut state) = self.0.lock() {
      state.parked = parked;
    }
  }

  #[cfg(target_os = "macos")]
  fn remember_previous_app(&self, pid: i32) {
    if let Ok(mut state) = self.0.lock() {
      state.previous_app_pid = Some(pid);
    }
  }

  #[cfg(target_os = "macos")]
  fn previous_app_pid(&self) -> Option<i32> {
    self.0.lock().ok().and_then(|state| state.previous_app_pid)
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

/// Docked frame in Tauri logical coordinates (origin top-left of the primary
/// screen, y down) from a Cocoa work area (origin bottom-left, y up).
#[cfg(target_os = "macos")]
fn docked_frame(primary_height: f64, work_area: DockedRect) -> DockedRect {
  let width = (work_area.width - (CLIPBOARD_WINDOW_INSET * 2.0)).max(1.0);
  let available_height = (work_area.height - (CLIPBOARD_WINDOW_INSET * 2.0)).max(1.0);
  let height = CLIPBOARD_WINDOW_HEIGHT.min(available_height);
  let bottom = work_area.y + CLIPBOARD_WINDOW_INSET;
  DockedRect {
    x: work_area.x + CLIPBOARD_WINDOW_INSET,
    y: primary_height - (bottom + height),
    width,
    height,
  }
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq)]
struct DockedRect {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
}

#[cfg(target_os = "macos")]
impl From<objc2_foundation::NSRect> for DockedRect {
  fn from(rect: objc2_foundation::NSRect) -> Self {
    Self {
      x: rect.origin.x,
      y: rect.origin.y,
      width: rect.size.width,
      height: rect.size.height,
    }
  }
}

// AppKit is queried directly: tao's `cursor_position` returns primary-scaled
// physical pixels while its `monitor_from_point` compares against display
// bounds in points, so on mixed-DPI setups the lookup misses and falls back
// to the primary display. Screen frames and the mouse location share one
// coordinate space here, so containment is exact.
#[cfg(target_os = "macos")]
fn position_window(_app: &AppHandle, window: &WebviewWindow) {
  use objc2::MainThreadMarker;
  use objc2_app_kit::{NSEvent, NSScreen};

  let Some(main_thread) = MainThreadMarker::new() else {
    let handle = window.app_handle().clone();
    let window = window.clone();
    let _ = handle.run_on_main_thread(move || {
      position_window(window.app_handle(), &window);
    });
    return;
  };

  let screens = NSScreen::screens(main_thread);
  let Some(primary) = screens.iter().next() else {
    let _ = window.center();
    return;
  };
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

  let frame = docked_frame(primary_height, screen.visibleFrame().into());
  let _ = window.set_size(LogicalSize::new(frame.width, frame.height));
  let _ = window.set_position(LogicalPosition::new(frame.x, frame.y));
}

#[cfg(not(target_os = "macos"))]
fn position_window(app: &AppHandle, window: &WebviewWindow) {
  let monitor = app
    .cursor_position()
    .ok()
    .and_then(|position| {
      app
        .monitor_from_point(position.x, position.y)
        .ok()
        .flatten()
    })
    .or_else(|| app.primary_monitor().ok().flatten());
  let Some(monitor) = monitor else {
    let _ = window.center();
    return;
  };

  let scale_factor = monitor.scale_factor();
  let work_area = monitor.work_area();
  let work_position = work_area.position.to_logical::<f64>(scale_factor);
  let work_size = work_area.size.to_logical::<f64>(scale_factor);
  let available_width = (work_size.width - (CLIPBOARD_WINDOW_INSET * 2.0)).max(1.0);
  let available_height = (work_size.height - (CLIPBOARD_WINDOW_INSET * 2.0)).max(1.0);
  let height = CLIPBOARD_WINDOW_HEIGHT.min(available_height);
  let x = work_position.x + CLIPBOARD_WINDOW_INSET;
  let y = work_position.y + work_size.height - height - CLIPBOARD_WINDOW_INSET;

  let _ = window.set_size(LogicalSize::new(available_width, height));
  let _ = window.set_position(LogicalPosition::new(x, y));
}

#[cfg(target_os = "macos")]
fn remember_previous_app(app: &AppHandle) {
  use objc2::MainThreadMarker;
  use objc2_app_kit::NSWorkspace;

  if MainThreadMarker::new().is_none() {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || remember_previous_app(&handle));
    return;
  }
  let Some(park) = app.try_state::<ClipboardWindowPark>() else {
    return;
  };
  let Some(frontmost) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
    return;
  };
  let pid = frontmost.processIdentifier();
  // Reopening while the window already holds focus keeps the earlier target.
  if pid != std::process::id() as i32 {
    park.remember_previous_app(pid);
  }
}

#[cfg(target_os = "macos")]
enum ParkFocusHandoff {
  /// The window holds focus (Escape, copy): hand it back to the app that had
  /// it before the window opened, or fall back to a real hide.
  PreviousApp,
  /// Focus already moved elsewhere (hide on blur): leave activation alone.
  None,
}

/// Parks the window instead of hiding it. Returns false when parking is not
/// possible (no main thread, no window handle, no app to hand focus to); the
/// caller then falls back to ordering the window out.
#[cfg(target_os = "macos")]
fn park_window(window: &WebviewWindow, handoff: ParkFocusHandoff) -> bool {
  use objc2::MainThreadMarker;

  if MainThreadMarker::new().is_some() {
    return park_window_on_main(window, handoff);
  }
  let (sender, receiver) = std::sync::mpsc::sync_channel(1);
  let cloned = window.clone();
  if window
    .app_handle()
    .run_on_main_thread(move || {
      let _ = sender.send(park_window_on_main(&cloned, handoff));
    })
    .is_err()
  {
    return false;
  }
  receiver
    .recv_timeout(Duration::from_secs(1))
    .unwrap_or(false)
}

// `ActivateIgnoringOtherApps` is a no-op on macOS 14+ (activation from the
// active app is already cooperative there) but required before it.
#[allow(deprecated)]
#[cfg(target_os = "macos")]
fn park_window_on_main(window: &WebviewWindow, handoff: ParkFocusHandoff) -> bool {
  use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

  let app = window.app_handle();
  let Some(park) = app.try_state::<ClipboardWindowPark>() else {
    return false;
  };
  if park.is_parked() {
    return true;
  }
  if let ParkFocusHandoff::PreviousApp = handoff {
    let activated = park
      .previous_app_pid()
      .and_then(NSRunningApplication::runningApplicationWithProcessIdentifier)
      .is_some_and(|previous| {
        previous.activateWithOptions(
          NSApplicationActivationOptions::ActivateIgnoringOtherApps,
        )
      });
    if !activated {
      return false;
    }
  }
  if !stella_desktop_macos::set_window_parked(window, true) {
    return false;
  }
  park.set_parked(true);
  true
}

#[cfg(target_os = "macos")]
fn unpark_window(window: &WebviewWindow) {
  use objc2::MainThreadMarker;

  if MainThreadMarker::new().is_none() {
    let cloned = window.clone();
    let _ = window
      .app_handle()
      .run_on_main_thread(move || unpark_window(&cloned));
    return;
  }
  if !stella_desktop_macos::set_window_parked(window, false) {
    return;
  }
  if let Some(park) = window.app_handle().try_state::<ClipboardWindowPark>() {
    park.set_parked(false);
  }
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
  #[cfg(target_os = "macos")]
  {
    let _ = app.show();
    remember_previous_app(app);
  }

  if let Some(window) = app.get_webview_window(CLIPBOARD_WINDOW_LABEL) {
    position_window(app, &window);
    #[cfg(target_os = "macos")]
    unpark_window(&window);
    if window.show().and_then(|()| window.set_focus()).is_err() {
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

  #[cfg(debug_assertions)]
  let content_protected =
    std::env::var_os("STELLA_ALLOW_CLIPBOARD_SCREEN_CAPTURE").is_none();
  #[cfg(not(debug_assertions))]
  let content_protected = true;

  let builder = tauri::WebviewWindowBuilder::new(
    app,
    CLIPBOARD_WINDOW_LABEL,
    tauri::WebviewUrl::App("index.html".into()),
  )
  .title("stella clipboard")
  .inner_size(1440.0, CLIPBOARD_WINDOW_HEIGHT)
  .always_on_top(true)
  .content_protected(content_protected)
  .decorations(false)
  // Tauri's native drag-drop handler consumes every drop on macOS and
  // Windows, so HTML5 drops (a card onto a group chip) never reach the
  // webview. The window accepts no OS file drops.
  .disable_drag_drop_handler()
  .effects(
    EffectsBuilder::new()
      .effect(Effect::UnderWindowBackground)
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
    if window.show().and_then(|()| window.set_focus()).is_err() {
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
          && hide_on_blur(&window_to_hide).is_err()
        {
          capture_window_error(
            window_to_hide.app_handle(),
            DesktopTelemetryOperation::ClipboardWindowHide,
            DesktopTelemetryWindow::Clipboard,
          );
        }
      });
      let _ = window.set_focus();
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

/// Dismissal while the window holds focus: park it and hand focus back to the
/// previously focused app, or order it out when that is not possible.
pub fn hide(window: &WebviewWindow) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  if park_window(window, ParkFocusHandoff::PreviousApp) {
    return Ok(());
  }
  order_out(window)
}

/// Hide after the window lost focus on its own: whatever the user focused
/// keeps it, so parking must not re-activate the previously focused app.
fn hide_on_blur(window: &WebviewWindow) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  if park_window(window, ParkFocusHandoff::None) {
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

  #[cfg(debug_assertions)]
  let content_protected =
    std::env::var_os("STELLA_ALLOW_CLIPBOARD_SCREEN_CAPTURE").is_none();
  #[cfg(not(debug_assertions))]
  let content_protected = true;

  let builder = tauri::WebviewWindowBuilder::new(
    app,
    CLIPBOARD_EDITOR_WINDOW_LABEL,
    tauri::WebviewUrl::App("index.html".into()),
  )
  .title("Stella")
  .inner_size(700.0, 520.0)
  .min_inner_size(560.0, 420.0)
  .always_on_top(true)
  .content_protected(content_protected)
  .resizable(true)
  .center()
  .visible(false)
  .on_page_load(|window, payload| {
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
  use super::*;

  #[test]
  fn docks_to_the_bottom_of_a_secondary_screen_above_the_primary() {
    // External 2560x1440 display arranged above a 1728x1117 laptop screen,
    // with a 25pt menu bar and no dock.
    let frame = docked_frame(
      1117.0,
      DockedRect {
        x: -416.0,
        y: 1117.0,
        width: 2560.0,
        height: 1415.0,
      },
    );

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
    let frame = docked_frame(
      1117.0,
      DockedRect {
        x: 0.0,
        y: 70.0,
        width: 1728.0,
        height: 1022.0,
      },
    );

    assert_eq!(frame.x, 18.0);
    assert_eq!(frame.height, CLIPBOARD_WINDOW_HEIGHT);
    assert_eq!(frame.y + frame.height, 1117.0 - 70.0 - 18.0);
  }

  #[test]
  fn shrinks_on_a_short_work_area() {
    let frame = docked_frame(
      200.0,
      DockedRect {
        x: 0.0,
        y: 0.0,
        width: 400.0,
        height: 200.0,
      },
    );

    assert_eq!(frame.height, 200.0 - 36.0);
    assert_eq!(frame.y, 18.0);
  }
}
