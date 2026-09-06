use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
  sync::{Arc, Mutex},
  time::Instant,
};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
  clipboard::{
    ClipboardAppState, ClipboardCaptureStatus, ClipboardGroup, ClipboardGroupColor,
    ClipboardGroupDeletionMode, ClipboardItem, ClipboardRetention, ClipboardSnapshot,
    ClipboardSourceAppVisual, write_item,
  },
  clipboard_screen_capture::ClipboardScreenCapture,
  clipboard_window::{self, ClipboardStartupTrace},
  desktop_telemetry::{
    DesktopTelemetry, DesktopTelemetrySpan, DesktopTelemetryWindow, DesktopTimingReport,
  },
};

const HISTORY_EVENT: &str = "clipboard-history-changed";
const STELLA_WEB_APP_URL: &str = "https://my.stll.app";
const ITEM_NOT_FOUND_ERROR: &str = "clipboard item no longer exists";
const GROUP_NOT_FOUND_ERROR: &str = "clipboard group no longer exists";

pub type ClipboardEditorState = Arc<Mutex<Option<String>>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEditorContext {
  groups: Vec<ClipboardGroup>,
  item: ClipboardItem,
  source_app_visual: Option<ClipboardSourceAppVisual>,
}

fn lock_error() -> String {
  "clipboard manager is unavailable".to_string()
}

#[tauri::command]
pub fn clipboard_get_snapshot(
  state: State<'_, ClipboardAppState>,
  telemetry: State<'_, DesktopTelemetry>,
  startup: State<'_, ClipboardStartupTrace>,
) -> Result<ClipboardSnapshot, String> {
  let lock_requested = Instant::now();
  let mut manager = state.lock().map_err(|_| lock_error())?;
  let lock_wait = lock_requested.elapsed();
  let build_started = Instant::now();
  manager.prune_expired(chrono::Utc::now())?;
  let snapshot = manager.snapshot();
  let build = build_started.elapsed();
  drop(manager);

  if let Some(open_kind) = startup.claim_snapshot() {
    let item_count = Some(snapshot.items.len());
    let payload_bytes = Some(snapshot.history_bytes());
    for (span, duration) in [
      (DesktopTelemetrySpan::ClipboardSnapshotLockWait, lock_wait),
      (DesktopTelemetrySpan::ClipboardSnapshotBuild, build),
    ] {
      telemetry.capture_timing(DesktopTimingReport {
        window: DesktopTelemetryWindow::Clipboard,
        span,
        duration,
        open_kind: Some(open_kind),
        item_count,
        payload_bytes,
      });
    }
  }
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_complete_welcome(
  state: State<'_, ClipboardAppState>,
) -> Result<ClipboardSnapshot, String> {
  let mut manager = state.lock().map_err(|_| lock_error())?;
  manager.complete_welcome()?;
  Ok(manager.snapshot())
}

#[tauri::command]
pub fn clipboard_set_capture_status(
  status: ClipboardCaptureStatus,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.set_capture_status(status)?;
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_set_retention(
  retention: ClipboardRetention,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.set_retention(retention)?;
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

/// The open windows change first, and the preference is recorded only once they
/// all hold the new protection. A failed transition rolls the windows back, so
/// the snapshot never reports a visibility that a window does not have and a
/// window created later never disagrees with the ones already open.
#[tauri::command]
pub fn clipboard_set_screen_capture(
  capture: ClipboardScreenCapture,
  state: State<'_, ClipboardAppState>,
  app: AppHandle,
) -> Result<ClipboardSnapshot, String> {
  let previous = state.lock().map_err(|_| lock_error())?.screen_capture();
  let rollback = || {
    let _ = clipboard_window::apply_screen_capture(&app, previous);
  };
  if let Err(error) = clipboard_window::apply_screen_capture(&app, capture) {
    rollback();
    return Err(error);
  }
  let stored = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager
      .set_screen_capture(capture)
      .map(|()| manager.snapshot())
  };
  stored.inspect_err(|_| rollback())
}

#[tauri::command]
pub fn clipboard_delete_item(
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.delete_item(&id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_duplicate_item(
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.duplicate_item(&id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_clear_history(
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.clear()?;
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_create_group(
  color: ClipboardGroupColor,
  name: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.create_group(&name, color)?;
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_delete_group(
  id: String,
  mode: ClipboardGroupDeletionMode,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.delete_group(&id, mode)? {
      return Err(GROUP_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_update_group(
  color: ClipboardGroupColor,
  id: String,
  name: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.update_group(&id, &name, color)? {
      return Err(GROUP_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_update_item(
  id: String,
  plain_text: String,
  html: Option<String>,
  group_id: Option<String>,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.update_item(&id, &plain_text, html.as_deref(), group_id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_set_item_group(
  id: String,
  group_id: Option<String>,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.set_item_group(&id, group_id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_set_item_name(
  id: String,
  name: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.set_item_name(&id, &name)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot()
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_open_editor(
  id: String,
  app: AppHandle,
  editor_state: State<'_, ClipboardEditorState>,
  state: State<'_, ClipboardAppState>,
) -> Result<(), String> {
  if clipboard_window::editor_is_open(&app) {
    return clipboard_window::show_editor(&app);
  }
  if state.lock().map_err(|_| lock_error())?.item(&id).is_none() {
    return Err(ITEM_NOT_FOUND_ERROR.to_string());
  }
  *editor_state.lock().map_err(|_| lock_error())? = Some(id);
  clipboard_window::show_editor(&app)
}

#[tauri::command]
pub fn clipboard_get_editor_context(
  editor_state: State<'_, ClipboardEditorState>,
  state: State<'_, ClipboardAppState>,
) -> Result<ClipboardEditorContext, String> {
  let id = editor_state
    .lock()
    .map_err(|_| lock_error())?
    .clone()
    .ok_or_else(|| "no clipboard item is open for editing".to_string())?;
  let mut manager = state.lock().map_err(|_| lock_error())?;
  manager.prune_expired(chrono::Utc::now())?;
  let item = manager
    .item_for_webview(&id)
    .ok_or_else(|| ITEM_NOT_FOUND_ERROR.to_string())?;
  let source_app_visual = manager.source_app_visual(&item);
  Ok(ClipboardEditorContext {
    groups: manager.groups().to_vec(),
    item,
    source_app_visual,
  })
}

#[tauri::command]
pub fn clipboard_get_image_preview(
  id: String,
  state: State<'_, ClipboardAppState>,
) -> Result<String, String> {
  let preview = {
    let manager = state.lock().map_err(|_| lock_error())?;
    manager.image_preview(&id)?
  }
  .load()?;
  Ok(format!(
    "data:image/png;base64,{}",
    STANDARD.encode(preview)
  ))
}

#[tauri::command]
pub fn clipboard_save_editor_item(
  id: String,
  plain_text: String,
  html: Option<String>,
  group_id: Option<String>,
  app: AppHandle,
  state: State<'_, ClipboardAppState>,
) -> Result<(), String> {
  {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.update_item(&id, &plain_text, html.as_deref(), group_id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
  }
  let _ = app.emit(HISTORY_EVENT, ());
  Ok(())
}

#[tauri::command]
pub fn clipboard_close_editor(window: WebviewWindow) -> Result<(), String> {
  window.destroy().map_err(|error| {
    tracing::warn!(error = %error, "clipboard editor could not be closed");
    format!("clipboard editor could not be closed: {error}")
  })
}

/// Copying a clip is two steps the user perceives separately: the write to
/// the system clipboard, then moving the clip to the front of history. The
/// tag tells the window which one failed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ClipboardCopyError {
  /// Nothing reached the system clipboard.
  Copy { message: String },
  /// The window could not hide after a successful copy.
  Hide { message: String },
  /// The system clipboard holds the clip, but history could not record it.
  History { message: String },
}

fn write_history_item(
  state: &ClipboardAppState,
  id: &str,
) -> Result<(), ClipboardCopyError> {
  let copy_error = |message: String| ClipboardCopyError::Copy { message };
  let (image, item) = {
    let manager = state.lock().map_err(|_| copy_error(lock_error()))?;
    let item = manager
      .item(id)
      .ok_or_else(|| copy_error(ITEM_NOT_FOUND_ERROR.to_string()))?;
    let image = matches!(&item, ClipboardItem::Image { .. })
      .then(|| manager.image(id))
      .transpose()
      .map_err(copy_error)?;
    (image, item)
  };
  let image = image
    .map(|image| image.load())
    .transpose()
    .map_err(copy_error)?;
  state
    .lock()
    .map_err(|_| copy_error(lock_error()))?
    .suppress_next(&item, false);
  if let Err(error) = write_item(&item, image.as_deref(), false) {
    if let Ok(mut manager) = state.lock() {
      manager.clear_suppression();
    }
    return Err(copy_error(error));
  }
  state
    .lock()
    .map_err(|_| lock_error())
    .and_then(|mut manager| manager.touch_item(id, chrono::Utc::now()))
    .map(|_| ())
    .map_err(|message| ClipboardCopyError::History { message })
}

#[tauri::command]
pub fn clipboard_copy_item(
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<(), ClipboardCopyError> {
  let history = match write_history_item(state.inner(), &id) {
    Err(error @ ClipboardCopyError::Copy { .. }) => return Err(error),
    outcome => outcome,
  };
  // The clip is on the system clipboard either way, so the hand-off proceeds
  // and a history failure is reported after it.
  let _ = window.emit(HISTORY_EVENT, ());
  clipboard_window::hide(&window)
    .map_err(|message| ClipboardCopyError::Hide { message })?;
  history
}

#[tauri::command]
pub fn clipboard_hide(window: WebviewWindow) -> Result<(), String> {
  clipboard_window::hide(&window)
}

#[tauri::command]
pub fn clipboard_show(app: tauri::AppHandle) {
  clipboard_window::show(&app);
}

#[tauri::command]
pub fn clipboard_open_stella(window: WebviewWindow) -> Result<(), String> {
  opener::open(STELLA_WEB_APP_URL).map_err(|error| {
    tracing::warn!(error = %error, "stella web app could not be opened");
    "stella web app could not be opened".to_string()
  })?;
  clipboard_window::hide(&window)
}
