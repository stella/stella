use std::{
  sync::Mutex,
  time::{Duration, Instant},
};
#[cfg(target_os = "macos")]
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{
  AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow,
  webview::PageLoadEvent,
};

use crate::clipboard::ClipboardAppState;
use crate::clipboard_screen_capture::ClipboardScreenCapture;
use crate::desktop_telemetry::{
  ClipboardOpenKind, DesktopErrorReport, DesktopTelemetry, DesktopTelemetryErrorCode,
  DesktopTelemetryOperation, DesktopTelemetrySpan, DesktopTelemetryWindow,
  DesktopTimingReport,
};
use crate::window_placement::{self, WorkArea};

pub(crate) const CLIPBOARD_WINDOW_LABEL: &str = "clipboard";
pub(crate) const CLIPBOARD_EDITOR_WINDOW_LABEL: &str = "clipboard-editor";
const CLIPBOARD_WINDOW_HEIGHT: f64 = 326.0;
const CLIPBOARD_WINDOW_INSET: f64 = 18.0;
#[cfg(target_os = "macos")]
const CLIPBOARD_WINDOW_RADIUS: f64 = 28.0;
const CLIPBOARD_EDITOR_WIDTH: f64 = 700.0;
const CLIPBOARD_EDITOR_HEIGHT: f64 = 520.0;

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
    self
      .0
      .lock()
      .ok()?
      .as_ref()
      .map(|trace| (trace.started.elapsed(), trace.open_kind))
  }

  pub fn open_kind(&self) -> Option<ClipboardOpenKind> {
    self.0.lock().ok()?.as_ref().map(|trace| trace.open_kind)
  }

  /// Open kind for the first snapshot read after the window was created;
  /// `None` for every later read.
  pub fn claim_snapshot(&self) -> Option<ClipboardOpenKind> {
    self
      .0
      .lock()
      .ok()?
      .as_mut()
      .filter(|trace| !trace.snapshot_claimed)
      .map(|trace| {
        trace.snapshot_claimed = true;
        trace.open_kind
      })
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
    stella_desktop_macos::present_key_panel(window)
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
  on_main_thread(window, false, stella_desktop_macos::park_window)
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
  // Every way in (tray, shortcut, links, launch) ends here.
  if crate::managed_policy::current().clipboard_disabled {
    return;
  }
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

  // Created at its docked frame: resizing the webview while the window is
  // hidden leaves WebKit's scrolling layers at the old size until a later
  // layout, which clips the rail on the first open.
  let initial_frame = window_placement::target_work_area(app).map(docked_frame);
  let builder = crate::app_window::builder(app, CLIPBOARD_WINDOW_LABEL, "index.html")
    .title("stella clipboard")
    .inner_size(
      initial_frame.map_or(1440.0, |frame| frame.width),
      initial_frame.map_or(CLIPBOARD_WINDOW_HEIGHT, |frame| frame.height),
    );
  let builder = match initial_frame {
    Some(frame) => builder.position(frame.x, frame.y),
    None => builder,
  };
  let builder = builder
    .always_on_top(true)
    .content_protected(content_protected(app))
    .decorations(false)
    // Tauri's native drag-drop handler consumes every drop on macOS and
    // Windows, so HTML5 drops (a card onto a group chip) never reach the
    // webview. The window accepts no OS file drops.
    .disable_drag_drop_handler()
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
      prewarm_editor(app);
    });

  // Menu is the most translucent appearance-adaptive material: the desktop and
  // windows underneath read through it in light mode too, where Popover is
  // nearly opaque and UnderWindowBackground is flat. Windows is left without a
  // material because acrylic paints the whole rectangular HWND, so the corners
  // stay square; there the page paints its own rounded surface instead.
  #[cfg(target_os = "macos")]
  let builder = builder.effects(
    EffectsBuilder::new()
      .effect(Effect::Menu)
      .state(EffectState::Active)
      .radius(CLIPBOARD_WINDOW_RADIUS)
      .build(),
  );

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
  let Some(window) = app.get_webview_window(CLIPBOARD_WINDOW_LABEL) else {
    show(app);
    return;
  };
  #[cfg(target_os = "macos")]
  let presented = on_main_thread(&window, false, |window| {
    stella_desktop_macos::is_panel_presented(window)
  });
  #[cfg(not(target_os = "macos"))]
  let presented = window.is_visible().unwrap_or(false);
  if presented {
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

/// The clip the editor window shows. Each open starts a new session; the
/// webview keys its editor by the session, so a reused window never carries
/// the previous clip's draft.
#[derive(Default)]
pub struct ClipboardEditorSessions(Mutex<EditorSessions>);

#[derive(Default)]
struct EditorSessions {
  last: u64,
  open: Option<OpenEditor>,
}

struct OpenEditor {
  item_id: String,
  requested: Instant,
  open_kind: ClipboardOpenKind,
  read: bool,
}

/// The open editor's clip, with the open latency on the first read of each
/// session only.
pub struct EditorRead {
  pub item_id: String,
  pub first_read: Option<(Duration, ClipboardOpenKind)>,
}

/// What the editor webview shows; sent on every open and close.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum EditorSessionEvent {
  Open { session: u64 },
  Idle,
}

pub const EDITOR_SESSION_EVENT: &str = "clipboard-editor-session";
const EDITOR_SESSIONS_UNAVAILABLE: &str = "clipboard editor state is unavailable";

impl ClipboardEditorSessions {
  /// Starts a session timed from now: the open latency runs from here until
  /// the editor first reads its clip.
  fn begin(
    &self,
    item_id: String,
    open_kind: ClipboardOpenKind,
  ) -> Result<u64, String> {
    let mut sessions = self.0.lock().map_err(crate::logging::with_cause_logged(
      EDITOR_SESSIONS_UNAVAILABLE,
    ))?;
    sessions.last += 1;
    let session = sessions.last;
    sessions.open = Some(OpenEditor {
      item_id,
      requested: Instant::now(),
      open_kind,
      read: false,
    });
    drop(sessions);
    Ok(session)
  }

  fn end(&self) -> Result<(), String> {
    self
      .0
      .lock()
      .map_err(crate::logging::with_cause_logged(
        EDITOR_SESSIONS_UNAVAILABLE,
      ))?
      .open = None;
    Ok(())
  }

  fn is_open(&self) -> bool {
    self.0.lock().is_ok_and(|sessions| sessions.open.is_some())
  }

  /// `None` while no clip is open: a prewarmed window reads before any open.
  pub fn read(&self) -> Result<Option<EditorRead>, String> {
    let mut sessions = self.0.lock().map_err(crate::logging::with_cause_logged(
      EDITOR_SESSIONS_UNAVAILABLE,
    ))?;
    let read = sessions.open.as_mut().map(|open| {
      let first_read = (!open.read).then(|| (open.requested.elapsed(), open.open_kind));
      open.read = true;
      EditorRead {
        item_id: open.item_id.clone(),
        first_read,
      }
    });
    drop(sessions);
    Ok(read)
  }
}

/// Opens the editor on `item_id`, reusing the window when it exists. A new
/// window shows itself once its page has loaded.
pub fn open_editor(app: &AppHandle, item_id: String) -> Result<(), String> {
  let sessions = app.state::<ClipboardEditorSessions>();
  let Some(window) = app.get_webview_window(CLIPBOARD_EDITOR_WINDOW_LABEL) else {
    sessions.begin(item_id, ClipboardOpenKind::FirstOpen)?;
    return build_editor(app);
  };
  let session = sessions.begin(item_id, ClipboardOpenKind::Reopen)?;
  announce_session(app, &EditorSessionEvent::Open { session });
  place_editor(app, &window);
  window
    .show()
    .and_then(|()| window.set_focus())
    .map_err(|error| {
      capture_window_error(
        app,
        DesktopTelemetryOperation::ClipboardWindowOpen,
        DesktopTelemetryWindow::ClipboardEditor,
      );
      format!("clipboard editor could not be shown: {error}")
    })
}

/// Ends the session and hides the window for the next open; the webview drops
/// the closed clip before it is shown again.
pub fn close_editor(window: &WebviewWindow) -> Result<(), String> {
  window.state::<ClipboardEditorSessions>().end()?;
  announce_session(window.app_handle(), &EditorSessionEvent::Idle);
  window.hide().map_err(|error| {
    tracing::warn!(error = %error, "clipboard editor could not be hidden");
    format!("clipboard editor could not be closed: {error}")
  })
}

fn announce_session(app: &AppHandle, event: &EditorSessionEvent) {
  if app
    .emit_to(CLIPBOARD_EDITOR_WINDOW_LABEL, EDITOR_SESSION_EVENT, event)
    .is_err()
  {
    tracing::warn!("clipboard editor session could not be announced");
  }
}

/// Loads the editor hidden after the panel is ready, so the first edit skips
/// creating a WebView. Deferred so it does not compete with the panel's own
/// first paint.
fn prewarm_editor(app: &AppHandle) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(EDITOR_PREWARM_DELAY).await;
    if app
      .get_webview_window(CLIPBOARD_EDITOR_WINDOW_LABEL)
      .is_some()
    {
      return;
    }
    if build_editor(&app).is_err() {
      tracing::warn!("clipboard editor could not be prewarmed");
    }
  });
}

const EDITOR_PREWARM_DELAY: Duration = Duration::from_secs(2);

fn build_editor(app: &AppHandle) -> Result<(), String> {
  let builder =
    crate::app_window::builder(app, CLIPBOARD_EDITOR_WINDOW_LABEL, "index.html")
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
  // A prewarmed window stays hidden until an open request arrives.
  let builder = builder.on_page_load(|window, payload| {
    if payload.event() != PageLoadEvent::Finished
      || !window.state::<ClipboardEditorSessions>().is_open()
    {
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

  let window = builder.build().map_err(|error| {
    capture_window_error(
      app,
      DesktopTelemetryOperation::ClipboardWindowOpen,
      DesktopTelemetryWindow::ClipboardEditor,
    );
    format!("clipboard editor could not be opened: {error}")
  })?;
  // The close button hides the window like Escape does, keeping the WebView
  // for the next open.
  let window_to_close = window.clone();
  window.on_window_event(move |event| {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
      return;
    };
    api.prevent_close();
    if close_editor(&window_to_close).is_err() {
      capture_window_error(
        window_to_close.app_handle(),
        DesktopTelemetryOperation::ClipboardWindowHide,
        DesktopTelemetryWindow::ClipboardEditor,
      );
    }
  });
  Ok(())
}

/// Default size, centred on the target screen: where a new window opens.
fn place_editor(app: &AppHandle, window: &WebviewWindow) {
  let size = LogicalSize::new(CLIPBOARD_EDITOR_WIDTH, CLIPBOARD_EDITOR_HEIGHT);
  let _ = window.set_size(size);
  if let Some(work_area) = window_placement::target_work_area(app) {
    let _ = window.set_position(window_placement::centered_origin(work_area, size));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn frontend_event_contract_matches_native_names() {
    let contract: serde_json::Value =
      serde_json::from_str(include_str!("../../fixtures/clipboard-contract.json"))
        .unwrap();
    assert_eq!(contract["editorSessionEvent"], EDITOR_SESSION_EVENT);
    assert_eq!(
      contract["historyChangedEvent"],
      crate::clipboard::HISTORY_EVENT
    );
  }

  #[test]
  fn each_editor_session_reports_its_open_latency_once() {
    let sessions = ClipboardEditorSessions::default();
    assert!(sessions.read().unwrap().is_none());

    let first = sessions
      .begin("a".to_string(), ClipboardOpenKind::FirstOpen)
      .unwrap();
    let read = sessions.read().unwrap().unwrap();
    assert_eq!(read.item_id, "a");
    assert!(matches!(
      read.first_read,
      Some((_, ClipboardOpenKind::FirstOpen))
    ));
    assert!(sessions.read().unwrap().unwrap().first_read.is_none());

    let second = sessions
      .begin("b".to_string(), ClipboardOpenKind::Reopen)
      .unwrap();
    assert!(second > first);
    let read = sessions.read().unwrap().unwrap();
    assert_eq!(read.item_id, "b");
    assert!(matches!(
      read.first_read,
      Some((_, ClipboardOpenKind::Reopen))
    ));

    sessions.end().unwrap();
    assert!(!sessions.is_open());
    assert!(sessions.read().unwrap().is_none());
  }

  #[test]
  fn editor_session_events_match_the_frontend_union() {
    assert_eq!(
      serde_json::to_value(EditorSessionEvent::Open { session: 3 }).unwrap(),
      serde_json::json!({ "type": "open", "session": 3 })
    );
    assert_eq!(
      serde_json::to_value(EditorSessionEvent::Idle).unwrap(),
      serde_json::json!({ "type": "idle" })
    );
  }

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
