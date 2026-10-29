use crate::logging::best_effort;
use serde::{Deserialize, Serialize};
use std::{sync::PoisonError, time::Instant};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
  clipboard::{
    ClipboardAppState, ClipboardCaptureStatus, ClipboardCaptureUpdate,
    ClipboardCopyFormat, ClipboardEditorNameUpdate, ClipboardGroup,
    ClipboardGroupColor, ClipboardGroupDeletionMode, ClipboardItem, ClipboardRetention,
    ClipboardSnapshot, HISTORY_EVENT,
  },
  clipboard_screen_capture::ClipboardScreenCapture,
  clipboard_window::{
    self, ClipboardEditorSessions, ClipboardStartupTrace, EditorRead,
  },
  desktop_telemetry::{
    DesktopTelemetry, DesktopTelemetrySpan, DesktopTelemetryWindow, DesktopTimingReport,
  },
  foreground_app_visual::ClipboardSourceAppVisual,
  local_window::ClipboardCaller,
};

const STELLA_WEB_APP_URL: &str = "https://my.stll.app";
const ITEM_NOT_FOUND_ERROR: &str = "clipboard item no longer exists";
const GROUP_NOT_FOUND_ERROR: &str = "clipboard group no longer exists";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEditorContext {
  group_limit: usize,
  groups: Vec<ClipboardGroup>,
  item: ClipboardItem,
  source_app_visual: Option<ClipboardSourceAppVisual>,
}

/// The edited content of a text clip; an image clip saves without one.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEditorText {
  plain_text: String,
  html: Option<String>,
}

fn lock_error<T>(poisoned: PoisonError<T>) -> String {
  crate::logging::with_cause_logged("clipboard manager is unavailable")(poisoned)
}

#[tauri::command]
pub fn clipboard_get_snapshot(
  caller: ClipboardCaller,
  state: State<'_, ClipboardAppState>,
  telemetry: State<'_, DesktopTelemetry>,
  startup: State<'_, ClipboardStartupTrace>,
) -> Result<ClipboardSnapshot, String> {
  let lock_requested = Instant::now();
  let mut manager = state.lock().map_err(lock_error)?;
  let lock_wait = lock_requested.elapsed();
  let build_started = Instant::now();
  manager.prune_expired(chrono::Utc::now())?;
  let snapshot = manager.snapshot(&caller);
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
pub fn clipboard_get_capture_update(
  caller: ClipboardCaller,
  revision: u32,
  state: State<'_, ClipboardAppState>,
) -> Result<Option<ClipboardCaptureUpdate>, String> {
  let mut manager = state.lock().map_err(lock_error)?;
  manager.prune_expired(chrono::Utc::now())?;
  Ok(manager.capture_update_for_revision(&caller, revision))
}

#[tauri::command]
pub fn clipboard_complete_welcome(
  caller: ClipboardCaller,
  state: State<'_, ClipboardAppState>,
) -> Result<ClipboardSnapshot, String> {
  let mut manager = state.lock().map_err(lock_error)?;
  manager.complete_welcome()?;
  Ok(manager.snapshot(&caller))
}

#[tauri::command]
pub fn clipboard_set_capture_status(
  caller: ClipboardCaller,
  status: ClipboardCaptureStatus,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    manager.set_capture_status(status)?;
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_exclude_item_source_app(
  caller: ClipboardCaller,
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    manager.exclude_source_app(&id)?;
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_remove_source_app_exclusion(
  caller: ClipboardCaller,
  identifier: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    manager.remove_source_app_exclusion(&identifier)?;
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_set_retention(
  caller: ClipboardCaller,
  retention: ClipboardRetention,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    manager.set_retention(retention)?;
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
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
) -> Result<ClipboardSnapshot, String> {
  let previous = state.lock().map_err(lock_error)?.screen_capture();
  let rollback = || {
    best_effort(
      clipboard_window::apply_screen_capture(&app, previous),
      "screen capture setting was not rolled back",
    );
  };
  if let Err(error) = clipboard_window::apply_screen_capture(&app, capture) {
    rollback();
    return Err(error);
  }
  let stored = {
    let mut manager = state.lock().map_err(lock_error)?;
    manager
      .set_screen_capture(capture)
      .map(|()| manager.snapshot(&caller))
  };
  stored.inspect_err(|_| rollback())
}

#[tauri::command]
pub fn clipboard_delete_item(
  caller: ClipboardCaller,
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    if !manager.delete_item(&id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_duplicate_item(
  caller: ClipboardCaller,
  id: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    if !manager.duplicate_item(&id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_clear_history(
  caller: ClipboardCaller,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    manager.clear()?;
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_create_group(
  caller: ClipboardCaller,
  color: ClipboardGroupColor,
  item_id: Option<String>,
  name: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    manager.create_group(&name, color, item_id.as_deref())?;
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_delete_group(
  caller: ClipboardCaller,
  id: String,
  mode: ClipboardGroupDeletionMode,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    if !manager.delete_group(&id, mode)? {
      return Err(GROUP_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_update_group(
  caller: ClipboardCaller,
  color: ClipboardGroupColor,
  id: String,
  name: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    if !manager.update_group(&id, &name, color)? {
      return Err(GROUP_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_move_group(
  caller: ClipboardCaller,
  id: String,
  index: usize,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    if !manager.move_group(&id, index)? {
      return Err(GROUP_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
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
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    if !manager.update_item(&id, &plain_text, html.as_deref(), group_id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_set_item_group(
  caller: ClipboardCaller,
  id: String,
  group_id: Option<String>,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    if !manager.set_item_group(&id, group_id)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_set_item_name(
  caller: ClipboardCaller,
  id: String,
  name: String,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<ClipboardSnapshot, String> {
  let snapshot = {
    let mut manager = state.lock().map_err(lock_error)?;
    if !manager.set_item_name(&id, &name)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
    manager.snapshot(&caller)
  };
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(snapshot)
}

#[tauri::command]
pub fn clipboard_open_editor(
  _caller: ClipboardCaller,
  id: String,
  app: AppHandle,
  state: State<'_, ClipboardAppState>,
) -> Result<(), String> {
  if state.lock().map_err(lock_error)?.item(&id).is_none() {
    return Err(ITEM_NOT_FOUND_ERROR.to_string());
  }
  clipboard_window::open_editor(&app, id)
}

/// The open clip, or `None` while the editor window is idle (prewarmed or
/// closed).
#[tauri::command]
pub fn clipboard_get_editor_context(
  caller: ClipboardCaller,
  sessions: State<'_, ClipboardEditorSessions>,
  state: State<'_, ClipboardAppState>,
  telemetry: State<'_, DesktopTelemetry>,
) -> Result<Option<ClipboardEditorContext>, String> {
  let Some(EditorRead {
    item_id,
    first_read,
  }) = sessions.read()?
  else {
    return Ok(None);
  };
  if let Some((duration, open_kind)) = first_read {
    telemetry.capture_timing(DesktopTimingReport {
      window: DesktopTelemetryWindow::ClipboardEditor,
      span: DesktopTelemetrySpan::ClipboardEditorOpen,
      duration,
      open_kind: Some(open_kind),
      item_count: None,
      payload_bytes: None,
    });
  }
  let mut manager = state.lock().map_err(lock_error)?;
  manager.prune_expired(chrono::Utc::now())?;
  let item = manager
    .item_for_webview(&item_id, &caller)
    .ok_or_else(|| ITEM_NOT_FOUND_ERROR.to_string())?;
  let source_app_visual = manager.source_app_visual(&item);
  Ok(Some(ClipboardEditorContext {
    group_limit: crate::clipboard::ClipboardManager::group_limit(),
    groups: manager.groups().to_vec(),
    item,
    source_app_visual,
  }))
}

#[tauri::command]
pub fn clipboard_get_image_preview(
  caller: ClipboardCaller,
  id: String,
  state: State<'_, ClipboardAppState>,
) -> Result<String, String> {
  let (preview, cache) = {
    let manager = state.lock().map_err(lock_error)?;
    (
      manager.image_preview(&id, &caller)?,
      std::sync::Arc::clone(&manager.preview_cache),
    )
  };
  let mut cache = cache.lock().map_err(crate::logging::with_cause_logged(
    "clipboard preview cache lock is poisoned",
  ))?;
  cache.load_preview(&id, preview)
}

#[tauri::command]
pub fn clipboard_save_editor_item(
  _caller: ClipboardCaller,
  id: String,
  name: ClipboardEditorNameUpdate,
  text: Option<ClipboardEditorText>,
  group_id: Option<String>,
  app: AppHandle,
  state: State<'_, ClipboardAppState>,
) -> Result<(), String> {
  let text = text
    .as_ref()
    .map(|text| (text.plain_text.as_str(), text.html.as_deref()));
  {
    let mut manager = state.lock().map_err(lock_error)?;
    if !manager.save_editor_item(&id, name, group_id, text)? {
      return Err(ITEM_NOT_FOUND_ERROR.to_string());
    }
  }
  best_effort(
    app.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  Ok(())
}

#[tauri::command]
pub fn clipboard_close_editor(
  _caller: ClipboardCaller,
  window: WebviewWindow,
) -> Result<(), String> {
  clipboard_window::close_editor(&window)
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
  let (image, item) = {
    let manager = state
      .lock()
      .map_err(|poisoned| copy_error(lock_error(poisoned)))?;
    let item = manager
      .item(id)
      .ok_or_else(|| copy_error(ITEM_NOT_FOUND_ERROR.to_string()))?;
    let image = matches!(&item, ClipboardItem::Image { .. })
      .then(|| manager.image(id))
      .transpose()
      .map_err(copy_error)?;
    drop(manager);
    (image, item)
  };
  let image = image
    .map(|image| image.load())
    .transpose()
    .map_err(copy_error)?;
  // Serialize clipboard publication and export lifetime with watcher cleanup.
  let mut manager = state
    .lock()
    .map_err(|poisoned| copy_error(lock_error(poisoned)))?;
  if let Err(error) = manager.write_item(&item, image.as_deref(), format) {
    manager.clear_suppression();
    return Err(copy_error(error));
  }
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
  best_effort(
    window.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
  clipboard_window::hide(&window)
    .map_err(|message| ClipboardCopyError::Hide { message })?;
  history
}

#[tauri::command]
pub fn clipboard_copy_items(
  caller: ClipboardCaller,
  format: ClipboardCopyFormat,
  ids: Vec<String>,
  state: State<'_, ClipboardAppState>,
  window: WebviewWindow,
) -> Result<(), ClipboardCopyError> {
  if let [id] = ids.as_slice() {
    return clipboard_copy_item(caller, format, id.clone(), state, window);
  }
  let copy_error = |message| ClipboardCopyError::Copy { message };
  {
    let mut manager = state
      .lock()
      .map_err(|poisoned| copy_error(lock_error(poisoned)))?;
    let combined = manager.compose_items(&ids, format).map_err(copy_error)?;
    if let Err(message) = manager.write_item(&combined, None, format) {
      manager.clear_suppression();
      drop(manager);
      return Err(copy_error(message));
    }
  }
  clipboard_window::hide(&window)
    .map_err(|message| ClipboardCopyError::Hide { message })
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
