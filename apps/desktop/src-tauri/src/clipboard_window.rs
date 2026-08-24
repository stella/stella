use tauri::{
  AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow,
  webview::PageLoadEvent,
  window::{Effect, EffectState, EffectsBuilder},
};

use crate::{
  clipboard_focus::ClipboardFocusState,
  desktop_telemetry::{
    DesktopErrorReport, DesktopTelemetry, DesktopTelemetryErrorCode,
    DesktopTelemetryOperation, DesktopTelemetryWindow,
  },
};

const CLIPBOARD_WINDOW_LABEL: &str = "clipboard";
const CLIPBOARD_EDITOR_WINDOW_LABEL: &str = "clipboard-editor";
const CLIPBOARD_WINDOW_HEIGHT: f64 = 326.0;
const CLIPBOARD_WINDOW_INSET: f64 = 18.0;
const CLIPBOARD_WINDOW_RADIUS: f64 = 28.0;

fn capture_window_error(app: &AppHandle, window: DesktopTelemetryWindow) {
  if let Some(telemetry) = app.try_state::<DesktopTelemetry>() {
    telemetry.capture(DesktopErrorReport {
      window,
      operation: DesktopTelemetryOperation::ClipboardWindowOpen,
      code: DesktopTelemetryErrorCode::WindowUnavailable,
    });
  }
}

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

pub fn show(app: &AppHandle) {
  if let Some(focus_state) = app.try_state::<ClipboardFocusState>() {
    focus_state.remember_frontmost_application();
  }

  #[cfg(target_os = "macos")]
  let _ = app.show();

  if let Some(window) = app.get_webview_window(CLIPBOARD_WINDOW_LABEL) {
    position_window(app, &window);
    if window.show().and_then(|()| window.set_focus()).is_err() {
      capture_window_error(app, DesktopTelemetryWindow::Clipboard);
    }
    return;
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
    position_window(window.app_handle(), &window);
    if window.show().and_then(|()| window.set_focus()).is_err() {
      capture_window_error(window.app_handle(), DesktopTelemetryWindow::Clipboard);
    }
  });

  match builder.build() {
    Ok(window) => {
      position_window(app, &window);
      let window_to_hide = window.clone();
      window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
          let _ = window_to_hide.hide();
        }
      });
      let _ = window.set_focus();
    }
    Err(error) => {
      tracing::error!(error = %error, "clipboard window could not be created");
      capture_window_error(app, DesktopTelemetryWindow::Clipboard);
    }
  }
}

pub fn toggle(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(CLIPBOARD_WINDOW_LABEL)
    && window.is_visible().unwrap_or(false)
  {
    hide(&window);
    return;
  }
  show(app);
}

pub fn hide(window: &WebviewWindow) {
  let _ = window.hide();
}

pub fn show_editor(app: &AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window(CLIPBOARD_EDITOR_WINDOW_LABEL) {
    if window.show().and_then(|()| window.set_focus()).is_err() {
      capture_window_error(app, DesktopTelemetryWindow::ClipboardEditor);
    }
    let _ = app.emit_to(
      CLIPBOARD_EDITOR_WINDOW_LABEL,
      "clipboard-editor-changed",
      (),
    );
    return Ok(());
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
        DesktopTelemetryWindow::ClipboardEditor,
      );
    }
  });

  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);

  builder.build().map(|_| ()).map_err(|error| {
    capture_window_error(app, DesktopTelemetryWindow::ClipboardEditor);
    format!("clipboard editor could not be opened: {error}")
  })
}
