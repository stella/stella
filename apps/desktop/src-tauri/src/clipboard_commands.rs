use enigo::{Direction, Enigo, Key, Keyboard, Settings};
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

use crate::{
  clipboard::{
    ClipboardAppState, ClipboardCaptureStatus, ClipboardGroup, ClipboardGroupColor,
    ClipboardItem, ClipboardSnapshot, write_item,
  },
  clipboard_focus::ClipboardFocusState,
  clipboard_window, i18n,
};

const HISTORY_EVENT: &str = "clipboard-history-changed";
const STELLA_WEB_APP_URL: &str = "https://my.stll.app";

pub type ClipboardEditorState = Arc<Mutex<Option<String>>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEditorContext {
  groups: Vec<ClipboardGroup>,
  item: ClipboardItem,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ClipboardPasteOutcome {
  Pasted,
  CopiedOnly,
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
pub fn clipboard_delete_item(
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    manager.delete_item(&id)?;
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
      return Err("clipboard item no longer exists".to_string());
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
    manager.delete_group(&id)?;
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
    manager.update_item(&id, &plain_text, html.as_deref(), group_id)?;
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
    manager.set_item_group(&id, group_id)?;
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
  if state.lock().map_err(|_| lock_error())?.item(&id).is_none() {
    return Err("clipboard item no longer exists".to_string());
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
    .ok_or_else(|| "clipboard item no longer exists".to_string())?;
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
      return Err("clipboard item no longer exists".to_string());
    }
  }
  let _ = app.emit(HISTORY_EVENT, ());
  Ok(())
}

#[tauri::command]
pub fn clipboard_close_editor(window: WebviewWindow) {
  let _ = window.destroy();
}

#[cfg(target_os = "macos")]
fn simulate_paste_on_main_thread(
  _main_thread_marker: MainThreadMarker,
) -> Result<(), String> {
  let mut enigo = Enigo::new(&Settings::default())
    .map_err(|error| format!("input automation is unavailable: {error}"))?;
  let modifier = Key::Meta;

  enigo
    .key(modifier, Direction::Press)
    .map_err(|error| format!("paste modifier failed: {error}"))?;
  let paste_result = enigo.key(Key::Unicode('v'), Direction::Click);
  let release_result = enigo.key(modifier, Direction::Release);
  paste_result
    .and(release_result)
    .map_err(|error| format!("paste shortcut failed: {error}"))
}

#[cfg(target_os = "macos")]
async fn simulate_paste(app: &AppHandle) -> Result<(), String> {
  let (result_sender, result_receiver) = tokio::sync::oneshot::channel();
  app
    .run_on_main_thread(move || {
      let result = MainThreadMarker::new()
        .ok_or_else(|| "paste simulation did not run on the main thread".to_string())
        .and_then(simulate_paste_on_main_thread);
      let _ = result_sender.send(result);
    })
    .map_err(|error| format!("paste simulation could not be scheduled: {error}"))?;
  result_receiver
    .await
    .map_err(|_| "paste simulation ended before reporting its result".to_string())?
}

#[cfg(not(target_os = "macos"))]
fn simulate_paste_on_worker() -> Result<(), String> {
  let mut enigo = Enigo::new(&Settings::default())
    .map_err(|error| format!("input automation is unavailable: {error}"))?;
  let modifier = Key::Control;

  enigo
    .key(modifier, Direction::Press)
    .map_err(|error| format!("paste modifier failed: {error}"))?;
  let paste_result = enigo.key(Key::Unicode('v'), Direction::Click);
  let release_result = enigo.key(modifier, Direction::Release);
  paste_result
    .and(release_result)
    .map_err(|error| format!("paste shortcut failed: {error}"))
}

#[cfg(not(target_os = "macos"))]
async fn simulate_paste(_app: &AppHandle) -> Result<(), String> {
  tokio::task::spawn_blocking(simulate_paste_on_worker)
    .await
    .map_err(|error| format!("direct paste task failed: {error}"))?
}

fn notify_copied_only(app: &AppHandle) {
  if let Err(error) = app
    .notification()
    .builder()
    .title(i18n::t("clipboard.title"))
    .body(i18n::t("clipboard.copiedOnly"))
    .show()
  {
    tracing::warn!(error = %error, "clipboard fallback notification failed");
  }
}

struct ClipboardWriteRequest<'a> {
  id: &'a str,
  plain_text_only: bool,
}

fn write_history_item(
  state: &ClipboardAppState,
  request: ClipboardWriteRequest<'_>,
) -> Result<(), String> {
  let item = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    let item = manager
      .item(request.id)
      .ok_or_else(|| "clipboard item no longer exists".to_string())?;
    manager.suppress_next(&item, request.plain_text_only);
    item
  };
  if let Err(error) = write_item(&item, request.plain_text_only) {
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
  write_history_item(
    state.inner(),
    ClipboardWriteRequest {
      id: &id,
      plain_text_only: false,
    },
  )?;
  clipboard_window::hide(&window);
  Ok(())
}

#[tauri::command]
pub async fn clipboard_paste_item(
  id: String,
  plain_text_only: bool,
  app: AppHandle,
  focus_state: State<'_, ClipboardFocusState>,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardPasteOutcome, String> {
  write_history_item(
    state.inner(),
    ClipboardWriteRequest {
      id: &id,
      plain_text_only,
    },
  )?;

  clipboard_window::hide(&window);
  focus_state.restore_frontmost_application(&app).await;
  if let Err(error) = simulate_paste(&app).await {
    tracing::warn!(error = %error, "clipboard item was copied but direct paste failed");
    notify_copied_only(&app);
    return Ok(ClipboardPasteOutcome::CopiedOnly);
  }
  Ok(ClipboardPasteOutcome::Pasted)
}

#[tauri::command]
pub fn clipboard_hide(window: WebviewWindow) {
  clipboard_window::hide(&window);
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
  clipboard_window::hide(&window);
  Ok(())
}
