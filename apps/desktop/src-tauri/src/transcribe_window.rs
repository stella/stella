//! The "Transcribe a recording" window: a regular app window that takes a
//! dropped file or one chosen in the native picker.

use tauri::{
  AppHandle, DragDropEvent, LogicalSize, Manager, WindowEvent, webview::PageLoadEvent,
};

use crate::{
  transcribe_recording, transcribe_recording::TRANSCRIBE_WINDOW_LABEL, window_placement,
};

const WINDOW_WIDTH: f64 = 760.0;
const WINDOW_HEIGHT: f64 = 600.0;

pub fn show(app: &AppHandle) {
  if !transcribe_recording::available(app) {
    tracing::info!("transcribe window refused: dictation is not available");
    return;
  }
  #[cfg(target_os = "macos")]
  crate::logging::best_effort(app.show(), "app could not be shown");
  if let Some(window) = app.get_webview_window(TRANSCRIBE_WINDOW_LABEL) {
    if window.show().and_then(|()| window.set_focus()).is_err() {
      tracing::warn!("transcribe window could not be focused");
    }
    return;
  }
  let builder = crate::app_window::builder(app, TRANSCRIBE_WINDOW_LABEL, "index.html")
    .title("stella")
    .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
    .min_inner_size(560.0, 460.0)
    .resizable(true)
    .visible(false);
  let builder = window_placement::centered_on_target_screen(
    app,
    builder,
    LogicalSize::new(WINDOW_WIDTH, WINDOW_HEIGHT),
  );
  let builder = builder.on_page_load(|window, payload| {
    if payload.event() != PageLoadEvent::Finished {
      return;
    }
    if window.show().and_then(|()| window.set_focus()).is_err() {
      tracing::warn!("transcribe window could not be shown");
    }
  });
  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);
  let Ok(window) = builder.build() else {
    tracing::error!("transcribe window could not be created");
    return;
  };
  // The dropped path is read here, natively; the page only learns the
  // file's name.
  let handle = app.clone();
  window.on_window_event(move |event| match event {
    WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
      transcribe_recording::dropped(&handle, paths);
    }
    WindowEvent::Destroyed => transcribe_recording::window_closed(&handle),
    _ => {}
  });
}
