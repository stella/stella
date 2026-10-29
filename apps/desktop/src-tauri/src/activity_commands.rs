//! Commands of the activity window. Every command takes an
//! [`ActivityCaller`], which only the activity window on the app origin can
//! produce, and only while the feature is enabled. Changes are announced
//! with a payload-free event; the window reads the data back through
//! `activity_get_day`.

use crate::logging::best_effort;
use chrono::Utc;
use tauri::{AppHandle, Emitter, State};

use crate::{
  activity::{
    self, ActivityAppDetailCapture, ActivityAppState, ActivityDaySnapshot,
    ActivityDeletionError, ActivityDeletionRecovery, ActivityHistoryDisposition,
    ActivityManager, ActivityOtherHistoryRecovery, ActivityRecordingStatus,
    ActivityRetention,
  },
  activity_details,
  local_window::ActivityCaller,
};

const MAX_COPY_BYTES: usize = 16 * 1024;

fn lock_error<T>(poisoned: std::sync::PoisonError<T>) -> String {
  crate::logging::with_cause_logged("activity timeline is unavailable")(poisoned)
}

fn update<E: From<String>>(
  app: &AppHandle,
  state: &ActivityAppState,
  caller: &ActivityCaller,
  change: impl FnOnce(&mut ActivityManager) -> Result<(), E>,
) -> Result<(), E> {
  let mut manager = state
    .lock()
    .map_err(|poisoned| E::from(lock_error(poisoned)))?;
  caller.require_current(app).map_err(E::from)?;
  manager.require_caller(caller).map_err(E::from)?;
  change(&mut manager)?;
  drop(manager);
  best_effort(
    app.emit(activity::CHANGED_EVENT, ()),
    "activity change was not announced",
  );
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
    let manager = state.lock().map_err(lock_error)?;
    caller.require_current(&app)?;
    manager.require_caller(&caller)?;
    manager.capture_details()
  };
  let details_access = activity_details::access_status(capture_details);
  let manager = state.lock().map_err(lock_error)?;
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
  drop(manager);
  snapshot.resolve_app_visuals();
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
) -> Result<(), ActivityDeletionError> {
  let date = activity::parse_date(&date)?;
  update(&app, &state, &caller, |manager| manager.delete_day(date))
}

#[tauri::command]
pub async fn activity_delete_all(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  recovery: ActivityDeletionRecovery,
) -> Result<(), ActivityDeletionError> {
  let _confirmation = crate::time_entry_commands::BATCH_CONFIRMATION.lock().await;
  update(&app, &state, &caller, |manager| {
    manager.delete_all(recovery)
  })
}

#[tauri::command]
pub fn activity_delete_other_account_history(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  recovery: ActivityOtherHistoryRecovery,
) -> Result<(), ActivityDeletionError> {
  update(&app, &state, &caller, |manager| {
    manager.delete_other_account_history(recovery)
  })
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
  let manager = state.lock().map_err(lock_error)?;
  caller.require_current(&app)?;
  manager.require_caller(&caller)?;
  // The lock is held through the write: an account switch takes it, so the
  // account check stays true until the text is on the clipboard.
  let written = crate::clipboard::write_plain_text(text);
  drop(manager);
  written
}

#[tauri::command]
pub fn activity_set_capture_details(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  enabled: bool,
) -> Result<(), String> {
  let should_prompt = {
    let mut manager = state.lock().map_err(lock_error)?;
    caller.require_current(&app)?;
    manager.require_caller(&caller)?;
    manager.set_capture_details(enabled, Utc::now())?
  };
  if should_prompt {
    caller.require_current(&app)?;
    activity_details::request_permission();
  }
  best_effort(
    app.emit(activity::CHANGED_EVENT, ()),
    "activity change was not announced",
  );
  Ok(())
}

#[tauri::command]
pub fn activity_set_detect_calls(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  enabled: bool,
) -> Result<(), String> {
  {
    let mut manager = state.lock().map_err(lock_error)?;
    caller.require_current(&app)?;
    manager.require_caller(&caller)?;
    manager.set_detect_calls(enabled, Utc::now())?;
  }
  crate::logging::best_effort(
    app.emit(activity::CHANGED_EVENT, ()),
    "emit activity change",
  );
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
  let manager = state.lock().map_err(lock_error)?;
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

#[tauri::command]
pub fn activity_assign_ranges(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  date: String,
  ranges: Vec<activity::ActivityManualAssignment>,
) -> Result<(), String> {
  let date = activity::parse_date(&date)?;
  update(&app, &state, &caller, |manager| {
    manager.assign_ranges(date, ranges)
  })
}
