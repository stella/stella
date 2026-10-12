use serde::Serialize;
use std::{
  sync::{Arc, Mutex},
  time::Instant,
};
use stella_desktop_clipboard_history::boundary::WebviewPayload;
use tauri::{AppHandle, Emitter, State, WebviewWindow, ipc::Response};

use crate::{
  clipboard::{
    ClipboardAppState, ClipboardCaptureStatus, ClipboardCopyFormat,
    ClipboardGroupColor, ClipboardGroupDeletionMode, ClipboardRetention,
  },
  clipboard_screen_capture::ClipboardScreenCapture,
  clipboard_window::{self, ClipboardStartupTrace},
  desktop_telemetry::{
    DesktopTelemetry, DesktopTelemetrySpan, DesktopTelemetryWindow, DesktopTimingReport,
  },
  local_window::ClipboardCaller,
};

const HISTORY_EVENT: &str = "clipboard-history-changed";
const STELLA_WEB_APP_URL: &str = "https://my.stll.app";
const ITEM_NOT_FOUND_ERROR: &str = "clipboard item no longer exists";
const GROUP_NOT_FOUND_ERROR: &str = "clipboard group no longer exists";

pub type ClipboardEditorState = Arc<Mutex<Option<String>>>;

#[allow(
  clippy::disallowed_methods,
  reason = "clipboard commands alone consume verified webview payloads into IPC responses"
)]
fn ipc_response(payload: WebviewPayload) -> Response {
  // Vec<u8> selects Tauri's binary transport; JSON text preserves invoke results.
  let json = String::from_utf8(payload.into_ipc_body())
    .unwrap_or_else(|_| panic!("serialized clipboard payload must be UTF-8 JSON"));
  Response::new(json)
}

fn lock_error() -> String {
  "clipboard manager is unavailable".to_string()
}

#[tauri::command]
pub fn clipboard_get_snapshot(
  caller: ClipboardCaller,
  state: State<'_, ClipboardAppState>,
  telemetry: State<'_, DesktopTelemetry>,
  startup: State<'_, ClipboardStartupTrace>,
) -> Result<Response, String> {
  let lock_requested = Instant::now();
  let mut manager = state.lock().map_err(|_| lock_error())?;
  let lock_wait = lock_requested.elapsed();
  let build_started = Instant::now();
  manager.prune_expired(chrono::Utc::now())?;
  let snapshot = manager.webview_snapshot(&caller.history_proof())?;
  let build = build_started.elapsed();
  let (item_count, payload_bytes) = manager.snapshot_counts();
  drop(manager);

  if let Some(open_kind) = startup.claim_snapshot() {
    let item_count = Some(item_count);
    let payload_bytes = Some(payload_bytes);
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
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_complete_welcome(
  caller: ClipboardCaller,
  state: State<'_, ClipboardAppState>,
) -> Result<Response, String> {
  let mut manager = state.lock().map_err(|_| lock_error())?;
  manager.complete_welcome()?;
  manager
    .webview_snapshot(&caller.history_proof())
    .map(ipc_response)
}

#[tauri::command]
pub fn clipboard_set_capture_status(
  caller: ClipboardCaller,
  status: ClipboardCaptureStatus,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.set_capture_status(status)?;
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_exclude_item_source_app(
  caller: ClipboardCaller,
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.exclude_source_app(&id)?;
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_remove_source_app_exclusion(
  caller: ClipboardCaller,
  identifier: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.remove_source_app_exclusion(&identifier)?;
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_set_retention(
  caller: ClipboardCaller,
  retention: ClipboardRetention,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.set_retention(retention)?;
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

/// The open windows change first, and the preference is recorded only once they
/// all hold the new protection. A failed transition rolls the windows back, so
/// the snapshot never reports a visibility that a window does not have and a
/// window created later never disagrees with the ones already open.
#[tauri::command]
pub fn clipboard_set_screen_capture(
  caller: ClipboardCaller,
  capture: ClipboardScreenCapture,
  state: State<'_, ClipboardAppState>,
  app: AppHandle,
) -> Result<Response, String> {
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
      .and_then(|()| manager.webview_snapshot(&caller.history_proof()))
  };
  stored.inspect_err(|_| rollback()).map(ipc_response)
}

#[tauri::command]
pub fn clipboard_delete_item(
  caller: ClipboardCaller,
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.delete_item(&id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_duplicate_item(
  caller: ClipboardCaller,
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.duplicate_item(&id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_clear_history(
  caller: ClipboardCaller,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.clear()?;
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_create_group(
  caller: ClipboardCaller,
  color: ClipboardGroupColor,
  item_id: Option<String>,
  name: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.create_group(&name, color, item_id.as_deref())?;
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_delete_group(
  caller: ClipboardCaller,
  id: String,
  mode: ClipboardGroupDeletionMode,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.delete_group(&id, mode)? {
      return Err(GROUP_NOT_FOUND_ERROR.to_string());
    }
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_update_group(
  caller: ClipboardCaller,
  color: ClipboardGroupColor,
  id: String,
  name: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.update_group(&id, &name, color)? {
      return Err(GROUP_NOT_FOUND_ERROR.to_string());
    }
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_move_group(
  caller: ClipboardCaller,
  id: String,
  index: usize,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.move_group(&id, index)? {
      return Err(GROUP_NOT_FOUND_ERROR.to_string());
    }
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_update_item(
  caller: ClipboardCaller,
  id: String,
  plain_text: String,
  html: Option<String>,
  group_id: Option<String>,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.update_item(&id, &plain_text, html.as_deref(), group_id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_set_item_group(
  caller: ClipboardCaller,
  id: String,
  group_id: Option<String>,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.set_item_group(&id, group_id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_set_item_name(
  caller: ClipboardCaller,
  id: String,
  name: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<Response, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.set_item_name(&id, &name)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.webview_snapshot(&caller.history_proof())?
  };
  let _ = window.emit(HISTORY_EVENT, ());
  Ok(ipc_response(snapshot))
}

#[tauri::command]
pub fn clipboard_open_editor(
  _caller: ClipboardCaller,
  id: String,
  app: AppHandle,
  editor_state: State<'_, ClipboardEditorState>,
  state: State<'_, ClipboardAppState>,
) -> Result<(), String> {
  if clipboard_window::editor_is_open(&app) {
    return clipboard_window::show_editor(&app);
  }
  if !state.lock().map_err(|_| lock_error())?.contains_item(&id) {
    return Err(ITEM_NOT_FOUND_ERROR.to_string());
  }
  *editor_state.lock().map_err(|_| lock_error())? = Some(id);
  clipboard_window::show_editor(&app)
}

#[tauri::command]
pub fn clipboard_get_editor_context(
  caller: ClipboardCaller,
  editor_state: State<'_, ClipboardEditorState>,
  state: State<'_, ClipboardAppState>,
) -> Result<Response, String> {
  let id = editor_state
    .lock()
    .map_err(|_| lock_error())?
    .clone()
    .ok_or_else(|| "no clipboard item is open for editing".to_string())?;
  let mut manager = state.lock().map_err(|_| lock_error())?;
  manager.prune_expired(chrono::Utc::now())?;
  manager
    .webview_item_context(&id, &caller.history_proof())
    .map(ipc_response)
}

#[tauri::command]
pub fn clipboard_get_image_preview(
  caller: ClipboardCaller,
  id: String,
  state: State<'_, ClipboardAppState>,
) -> Result<Response, String> {
  let preview = {
    let manager = state.lock().map_err(|_| lock_error())?;
    manager.prepare_webview_image_preview(&id, &caller.history_proof())?
  };
  preview.load().map(ipc_response)
}

#[tauri::command]
pub fn clipboard_save_editor_item(
  _caller: ClipboardCaller,
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
pub fn clipboard_close_editor(
  _caller: ClipboardCaller,
  window: WebviewWindow,
) -> Result<(), String> {
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
  format: ClipboardCopyFormat,
) -> Result<(), ClipboardCopyError> {
  let copy_error = |message: String| ClipboardCopyError::Copy { message };
  let prepared = {
    let manager = state.lock().map_err(|_| copy_error(lock_error()))?;
    manager.prepare_copy(id).map_err(copy_error)?
  };
  let loaded = prepared.load().map_err(copy_error)?;
  // Serialize clipboard publication and export lifetime with watcher cleanup.
  let mut manager = state.lock().map_err(|_| copy_error(lock_error()))?;
  manager.publish_copy(loaded, format).map_err(copy_error)?;
  manager
    .touch_item(id, chrono::Utc::now())
    .map(|_| ())
    .map_err(|message| ClipboardCopyError::History { message })
}

#[tauri::command]
pub fn clipboard_copy_item(
  _caller: ClipboardCaller,
  format: ClipboardCopyFormat,
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<(), ClipboardCopyError> {
  let history = match write_history_item(state.inner(), &id, format) {
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
pub fn clipboard_hide(
  _caller: ClipboardCaller,
  window: WebviewWindow,
) -> Result<(), String> {
  clipboard_window::hide(&window)
}

#[tauri::command]
pub fn clipboard_open_stella(
  _caller: ClipboardCaller,
  window: WebviewWindow,
) -> Result<(), String> {
  opener::open(STELLA_WEB_APP_URL).map_err(|error| {
    tracing::warn!(error = %error, "stella web app could not be opened");
    "stella web app could not be opened".to_string()
  })?;
  clipboard_window::hide(&window)
}
