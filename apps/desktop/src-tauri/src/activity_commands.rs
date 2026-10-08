//! Commands of the activity window. Every command takes an
//! [`ActivityCaller`], which only the activity window on the app origin can
//! produce, and only while the feature is enabled. Changes are announced
//! with a payload-free event; the window reads the data back through
//! `activity_get_day`.

use chrono::Utc;
use tauri::{AppHandle, Emitter, State};

use crate::{
  activity::{
    self, ActivityAppDetailCapture, ActivityAppState, ActivityDaySnapshot,
    ActivityHistoryDisposition, ActivityManager, ActivityRecordingStatus,
    ActivityRetention,
  },
  activity_details,
  local_window::ActivityCaller,
};

const MAX_COPY_BYTES: usize = 16 * 1024;

fn lock_error() -> String {
  "activity timeline is unavailable".to_string()
}

fn update(
  app: &AppHandle,
  state: &ActivityAppState,
  caller: &ActivityCaller,
  change: impl FnOnce(&mut ActivityManager) -> Result<(), String>,
) -> Result<(), String> {
  let mut manager = state.lock().map_err(|_| lock_error())?;
  caller.require_current(app)?;
  manager.require_caller(caller)?;
  change(&mut manager)?;
  drop(manager);
  let _ = app.emit(activity::CHANGED_EVENT, ());
  Ok(())
}

#[tauri::command]
pub fn activity_get_day(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  gates: State<'_, crate::feature_gate::FeatureGates>,
  date: Option<String>,
) -> Result<ActivityDaySnapshot, String> {
  let now = Utc::now();
  let date = match date {
    Some(date) => activity::parse_date(&date)?,
    None => now.with_timezone(&chrono::Local).date_naive(),
  };
  let capture_details = {
    let manager = state.lock().map_err(|_| lock_error())?;
    caller.require_current(&app)?;
    manager.require_caller(&caller)?;
    manager.capture_details()
  };
  let details_access = activity_details::access_status(capture_details);
  let manager = state.lock().map_err(|_| lock_error())?;
  caller.require_current(&app)?;
  manager.require_caller(&caller)?;
  let other_account_history_days = manager.other_account_history_days()?;
  let mut snapshot = manager.day_snapshot(
    date,
    now,
    &caller,
    other_account_history_days,
    details_access,
  );
  snapshot.time_billing_enabled =
    gates.is_enabled(crate::feature_gate::DesktopFeature::TimeBilling);
  Ok(snapshot)
}

#[tauri::command]
pub fn activity_set_recording_status(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  status: ActivityRecordingStatus,
) -> Result<(), String> {
  if status == ActivityRecordingStatus::Off {
    return Err("activity recording can only be paused".to_string());
  }
  update(&app, &state, &caller, |manager| {
    manager.set_recording_status(status, Utc::now())
  })
}

#[tauri::command]
pub fn activity_set_retention(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  retention: ActivityRetention,
) -> Result<(), String> {
  update(&app, &state, &caller, |manager| {
    manager.set_retention(retention, Utc::now())
  })
}

#[tauri::command]
pub fn activity_exclude_app(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  identifier: String,
  name: String,
  history: ActivityHistoryDisposition,
) -> Result<(), String> {
  update(&app, &state, &caller, |manager| {
    manager.exclude_app(&identifier, &name, history)
  })
}

#[tauri::command]
pub fn activity_remove_app_exclusion(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  identifier: String,
) -> Result<(), String> {
  update(&app, &state, &caller, |manager| {
    manager.remove_exclusion(&identifier)
  })
}

#[tauri::command]
pub fn activity_delete_day(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  date: String,
) -> Result<(), String> {
  let date = activity::parse_date(&date)?;
  update(&app, &state, &caller, |manager| manager.delete_day(date))
}

#[tauri::command]
pub fn activity_delete_all(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
) -> Result<(), String> {
  update(&app, &state, &caller, ActivityManager::delete_all)
}

#[tauri::command]
pub fn activity_delete_other_account_history(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
) -> Result<(), String> {
  update(
    &app,
    &state,
    &caller,
    ActivityManager::delete_other_account_history,
  )
}

/// Copies a block summary the window composed. The text goes to the system
/// clipboard only, at the user's request.
#[tauri::command]
pub fn activity_copy_text(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  text: String,
) -> Result<(), String> {
  if text.trim().is_empty() || text.len() > MAX_COPY_BYTES {
    return Err("activity summary is empty or too large to copy".to_string());
  }
  let manager = state.lock().map_err(|_| lock_error())?;
  caller.require_current(&app)?;
  manager.require_caller(&caller)?;
  crate::clipboard::write_plain_text(text)
}

#[tauri::command]
pub fn activity_set_capture_details(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  enabled: bool,
) -> Result<(), String> {
  let should_prompt = {
    let mut manager = state.lock().map_err(|_| lock_error())?;
    caller.require_current(&app)?;
    manager.require_caller(&caller)?;
    manager.set_capture_details(enabled, Utc::now())?
  };
  if should_prompt {
    caller.require_current(&app)?;
    activity_details::request_permission();
  }
  let _ = app.emit(activity::CHANGED_EVENT, ());
  Ok(())
}

#[tauri::command]
pub fn activity_set_app_detail_capture(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  identifier: String,
  name: String,
  mode: ActivityAppDetailCapture,
) -> Result<(), String> {
  update(&app, &state, &caller, |manager| {
    manager.set_app_detail_capture(&identifier, &name, mode, Utc::now())
  })
}

#[tauri::command]
pub fn activity_open_accessibility_settings(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
) -> Result<(), String> {
  let manager = state.lock().map_err(|_| lock_error())?;
  caller.require_current(&app)?;
  manager.require_caller(&caller)?;
  drop(manager);
  activity_details::open_accessibility_settings()
}

#[tauri::command]
pub fn activity_set_browser_title_capture(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  identifier: String,
  name: String,
  enabled: bool,
) -> Result<(), String> {
  update(&app, &state, &caller, |manager| {
    manager.set_browser_title_capture(&identifier, &name, enabled, Utc::now())
  })
}
