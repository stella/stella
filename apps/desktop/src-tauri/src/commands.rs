use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

use crate::session_manager::SessionManager;
use crate::types::{AppSnapshot, DesktopNotificationPreferences};

pub type AppState = Arc<Mutex<SessionManager>>;

#[tauri::command]
pub async fn get_state(state: State<'_, AppState>) -> Result<AppSnapshot, String> {
  let mgr = state.lock().await;
  Ok(mgr.get_snapshot())
}

#[tauri::command]
pub async fn update_notification_preferences(
  prefs: DesktopNotificationPreferences,
  state: State<'_, AppState>,
) -> Result<AppSnapshot, String> {
  let mut mgr = state.lock().await;
  Ok(mgr.update_notification_preferences(prefs).await)
}

#[tauri::command]
pub async fn open_session_file(
  session_id: String,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.open_session_file(&session_id))
}

#[tauri::command]
pub async fn reveal_session(
  session_id: String,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.reveal_session(&session_id))
}

#[tauri::command]
pub async fn finish_session(
  session_id: String,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  let mut mgr = state.lock().await;
  let result = mgr.finish_session(&session_id);
  if result {
    mgr.persist_sessions_public().await;
    mgr.retry_session(&session_id).await;
  }
  Ok(result)
}

#[tauri::command]
pub async fn retry_session(
  session_id: String,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  let mut mgr = state.lock().await;
  let result = mgr.retry_session_now(&session_id);
  if result {
    mgr.persist_sessions_public().await;
    mgr.retry_session(&session_id).await;
  }
  Ok(result)
}

#[tauri::command]
pub async fn takeover_dialog_respond(
  approved: bool,
  window: tauri::WebviewWindow,
) -> Result<(), String> {
  let label = window.label().to_string();
  crate::session_manager::set_takeover_response(&label, approved);
  let _ = window.close();
  Ok(())
}

#[tauri::command]
pub async fn respond_to_takeover(
  session_id: String,
  approved: bool,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.respond_to_takeover(&session_id, approved).await)
}

#[tauri::command]
pub async fn copy_diagnostics(state: State<'_, AppState>) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.copy_diagnostics())
}

#[tauri::command]
pub async fn email_support(state: State<'_, AppState>) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.email_support())
}

#[tauri::command]
pub async fn reveal_support_root(state: State<'_, AppState>) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.reveal_support_root())
}

#[tauri::command]
pub async fn open_edit_root(state: State<'_, AppState>) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.open_edit_root().await)
}

#[tauri::command]
pub async fn is_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
  use tauri_plugin_autostart::ManagerExt;
  app
    .autolaunch()
    .is_enabled()
    .map_err(|e| format!("autostart check failed: {e}"))
}

#[tauri::command]
pub async fn set_autostart(
  enabled: bool,
  app: tauri::AppHandle,
) -> Result<bool, String> {
  use tauri_plugin_autostart::ManagerExt;
  let autostart = app.autolaunch();
  if enabled {
    autostart
      .enable()
      .map_err(|e| format!("autostart enable failed: {e}"))?;
  } else {
    autostart
      .disable()
      .map_err(|e| format!("autostart disable failed: {e}"))?;
  }
  Ok(enabled)
}
