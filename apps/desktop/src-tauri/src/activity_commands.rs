//! Commands of the activity window. Every command takes an
//! [`ActivityCaller`], which only the activity window on the app origin can
//! produce, and only while the feature is enabled. Changes are announced
//! with a payload-free event; the window reads the data back through
//! `activity_get_day`.

use chrono::Utc;
use tauri::{AppHandle, Emitter, State};

use crate::{
  activity::{
    self, ActivityAppState, ActivityDaySnapshot, ActivityManager,
    ActivityRecordingStatus, ActivityRetention,
  },
  local_window::ActivityCaller,
};

const MAX_COPY_BYTES: usize = 16 * 1024;

fn lock_error() -> String {
  "activity timeline is unavailable".to_string()
}

fn update(
  app: &AppHandle,
  state: &ActivityAppState,
  change: impl FnOnce(&mut ActivityManager) -> Result<(), String>,
) -> Result<(), String> {
  let mut manager = state.lock().map_err(|_| lock_error())?;
  change(&mut manager)?;
  drop(manager);
  let _ = app.emit(activity::CHANGED_EVENT, ());
  Ok(())
}

#[tauri::command]
pub fn activity_get_day(
  caller: ActivityCaller,
  state: State<'_, ActivityAppState>,
  date: Option<String>,
) -> Result<ActivityDaySnapshot, String> {
  let now = Utc::now();
  let date = match date {
    Some(date) => activity::parse_date(&date)?,
    None => now.with_timezone(&chrono::Local).date_naive(),
  };
  let manager = state.lock().map_err(|_| lock_error())?;
  Ok(manager.day_snapshot(date, now, &caller))
}

#[tauri::command]
pub fn activity_set_recording_status(
  _caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  status: ActivityRecordingStatus,
) -> Result<(), String> {
  if status == ActivityRecordingStatus::Off {
    return Err("activity recording can only be paused".to_string());
  }
  update(&app, &state, |manager| {
    manager.set_recording_status(status, Utc::now())
  })
}

#[tauri::command]
pub fn activity_set_retention(
  _caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  retention: ActivityRetention,
) -> Result<(), String> {
  update(&app, &state, |manager| {
    manager.set_retention(retention, Utc::now())
  })
}

#[tauri::command]
pub fn activity_exclude_app(
  _caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  identifier: String,
  name: String,
) -> Result<(), String> {
  update(&app, &state, |manager| {
    manager.exclude_app(&identifier, &name)
  })
}

#[tauri::command]
pub fn activity_remove_app_exclusion(
  _caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  identifier: String,
) -> Result<(), String> {
  update(&app, &state, |manager| {
    manager.remove_exclusion(&identifier)
  })
}

#[tauri::command]
pub fn activity_delete_day(
  _caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  date: String,
) -> Result<(), String> {
  let date = activity::parse_date(&date)?;
  update(&app, &state, |manager| manager.delete_day(date))
}

#[tauri::command]
pub fn activity_delete_all(
  _caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
) -> Result<(), String> {
  update(&app, &state, ActivityManager::delete_all)
}

/// Copies a block summary the window composed. The text goes to the system
/// clipboard only, at the user's request.
#[tauri::command]
pub fn activity_copy_text(_caller: ActivityCaller, text: String) -> Result<(), String> {
  if text.trim().is_empty() || text.len() > MAX_COPY_BYTES {
    return Err("activity summary is empty or too large to copy".to_string());
  }
  crate::clipboard::write_plain_text(text)
}
