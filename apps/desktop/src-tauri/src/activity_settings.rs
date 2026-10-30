//! Activity settings commands, for the activity window and the Settings
//! window. Every command takes an [`ActivitySettingsCaller`]: these change
//! settings or delete history, and the one read returns settings and the
//! names of one day's apps, never the timeline. Every change announces
//! itself through `activity::emit_changed`, so both windows and the tray
//! read again.

use chrono::Utc;
use tauri::{AppHandle, State};

use crate::{
  activity::{
    self, ActivityAppDetailCapture, ActivityAppState, ActivityDeletionError,
    ActivityDeletionRecovery, ActivityHistoryDisposition, ActivityNarrativeAssist,
    ActivityOtherHistoryRecovery, ActivityRecordingStatus, ActivityRetention, ActivitySettingsSnapshot,
  },
  activity_commands::{lock_error, update},
  activity_details,
  local_window::ActivitySettingsCaller,
};

#[tauri::command]
pub fn activity_get_settings(
  caller: ActivitySettingsCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  date: Option<String>,
) -> Result<ActivitySettingsSnapshot, String> {
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
  let mut snapshot = manager.settings_snapshot(
    date,
    now,
    &caller,
    other_account_history_days,
    details_access,
  );
  drop(manager);
  snapshot.resolve_app_visuals();
  Ok(snapshot)
}

#[tauri::command]
pub fn activity_set_recording_status(
  caller: ActivitySettingsCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  status: ActivityRecordingStatus,
) -> Result<(), String> {
  if status == ActivityRecordingStatus::Off {
    return Err("activity recording can only be paused".to_string());
  }
  let mut prompt = false;
  update(&app, &state, &caller, |manager| {
    // Details are on by default, so the first start asks for the
    // permission that records them.
    prompt = manager.recording_status() == ActivityRecordingStatus::Off
      && manager.capture_details();
    manager.set_recording_status(status, Utc::now())
  })?;
  // Recording has started either way; the prompt only follows a caller that
  // is still current.
  if prompt && caller.require_current(&app).is_ok() {
    activity_details::request_permission();
  }
  Ok(())
}

#[tauri::command]
pub fn activity_set_retention(
  caller: ActivitySettingsCaller,
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
  caller: ActivitySettingsCaller,
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
  caller: ActivitySettingsCaller,
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
  caller: ActivitySettingsCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  date: String,
) -> Result<(), ActivityDeletionError> {
  let date = activity::parse_date(&date)?;
  update(&app, &state, &caller, |manager| manager.delete_day(date))
}

#[tauri::command]
pub async fn activity_delete_all(
  caller: ActivitySettingsCaller,
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
  caller: ActivitySettingsCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  recovery: ActivityOtherHistoryRecovery,
) -> Result<(), ActivityDeletionError> {
  update(&app, &state, &caller, |manager| {
    manager.delete_other_account_history(recovery)
  })
}

#[tauri::command]
pub fn activity_set_capture_details(
  caller: ActivitySettingsCaller,
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
  activity::emit_changed(&app);
  Ok(())
}

#[tauri::command]
pub fn activity_set_detect_calls(
  caller: ActivitySettingsCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  enabled: bool,
) -> Result<(), String> {
  update(&app, &state, &caller, |manager| {
    manager.set_detect_calls(enabled, Utc::now())
  })
}

#[tauri::command]
pub fn activity_set_app_detail_capture(
  caller: ActivitySettingsCaller,
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
  caller: ActivitySettingsCaller,
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
pub fn activity_set_narrative_assist(
  caller: ActivitySettingsCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  assist: ActivityNarrativeAssist,
) -> Result<(), String> {
  update(&app, &state, &caller, |manager| {
    manager.set_narrative_assist(assist)
  })
}

#[tauri::command]
pub fn activity_set_browser_title_capture(
  caller: ActivitySettingsCaller,
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
