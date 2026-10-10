//! The activity window: a regular app window that exists only while the
//! feature is enabled.

use tauri::{AppHandle, LogicalSize, Manager, webview::PageLoadEvent};

use crate::window_placement;

pub(crate) const ACTIVITY_WINDOW_LABEL: &str = "activity";
const ACTIVITY_WINDOW_WIDTH: f64 = 760.0;
const ACTIVITY_WINDOW_HEIGHT: f64 = 640.0;

pub fn show(app: &AppHandle) {
  if !crate::activity::is_enabled(app) {
    tracing::info!("activity window refused: the feature is not enabled");
    return;
  }
  crate::activity::initialize(app);
  #[cfg(target_os = "macos")]
  let _ = app.show();
  if let Some(window) = app.get_webview_window(ACTIVITY_WINDOW_LABEL) {
    if window.show().and_then(|()| window.set_focus()).is_err() {
      tracing::warn!("activity window could not be focused");
    }
    return;
  }
  let builder = crate::app_window::builder(app, ACTIVITY_WINDOW_LABEL, "index.html")
    .title("Stella")
    .inner_size(ACTIVITY_WINDOW_WIDTH, ACTIVITY_WINDOW_HEIGHT)
    .min_inner_size(560.0, 460.0)
    .resizable(true)
    .visible(false);
  let builder = window_placement::centered_on_target_screen(
    app,
    builder,
    LogicalSize::new(ACTIVITY_WINDOW_WIDTH, ACTIVITY_WINDOW_HEIGHT),
  );
  let builder = builder.on_page_load(|window, payload| {
    if payload.event() != PageLoadEvent::Finished {
      return;
    }
    if window.show().and_then(|()| window.set_focus()).is_err() {
      tracing::warn!("activity window could not be shown");
    }
  });
  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);
  if builder.build().is_err() {
    tracing::error!("activity window could not be created");
  }
}

/// Closes the window when the feature is switched off.
pub fn close(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(ACTIVITY_WINDOW_LABEL)
    && window.destroy().is_err()
  {
    tracing::warn!("activity window could not be closed");
  }
}
