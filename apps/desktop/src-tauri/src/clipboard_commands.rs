use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
  clipboard::{
    ClipboardAppState, ClipboardCaptureStatus, ClipboardGroup, ClipboardGroupColor,
    ClipboardItem, ClipboardRetention, ClipboardSnapshot, write_item,
  },
  clipboard_window,
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
}

fn lock_error() -> String {
  "clipboard manager is unavailable".to_string()
}

#[tauri::command]
pub fn clipboard_get_snapshot(
  state: State<'_, ClipboardAppState>,
) -> Result<ClipboardSnapshot, String> {
  let mut manager = state.lock().map_err(|_| lock_error())?;
  manager.prune_expired(chrono::Utc::now())?;
  Ok(manager.snapshot())
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
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    if !manager.delete_group(&id)? {
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
    .item(&id)
    .ok_or_else(|| ITEM_NOT_FOUND_ERROR.to_string())?;
  Ok(ClipboardEditorContext {
    groups: manager.snapshot().groups,
    item,
  })
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

fn write_history_item(state: &ClipboardAppState, id: &str) -> Result<(), String> {
  let item = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    let item = manager
      .item(id)
      .ok_or_else(|| "clipboard item no longer exists".to_string())?;
    manager.suppress_next(&item, false);
    item
  };
  if let Err(error) = write_item(&item, false) {
    if let Ok(mut manager) = state.lock() {
      manager.clear_suppression();
    }
    return Err(error);
  }
  Ok(())
}

#[tauri::command]
pub fn clipboard_copy_item(
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<(), String> {
  write_history_item(state.inner(), &id)?;
  clipboard_window::hide(&window)
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
