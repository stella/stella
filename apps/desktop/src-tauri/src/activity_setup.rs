//! What setup offers for Activity, for the setup window as well as the
//! activity window and Settings: starting to record, window details and
//! calls. Every command takes an [`ActivitySetupCaller`]; the one read
//! returns setup's own choices, never a day, an app or the timeline. Every
//! change announces itself through `activity::emit_changed`, so each window
//! and the tray read again.

use chrono::Utc;
use tauri::{AppHandle, State};

use crate::{
  activity::{ActivityAppState, ActivityRecordingStatus, ActivitySetupSnapshot},
  activity_commands::{lock_error, update},
  activity_details,
  local_window::ActivitySetupCaller,
};

#[tauri::command]
pub fn activity_get_setup(
  caller: ActivitySetupCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
) -> Result<ActivitySetupSnapshot, String> {
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
  Ok(manager.setup_snapshot(&caller, details_access))
}

#[tauri::command]
pub fn activity_set_recording_status(
  caller: ActivitySetupCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  status: ActivityRecordingStatus,
) -> Result<(), String> {
  if status == ActivityRecordingStatus::Off {
    return Err("activity recording can only be paused".to_string());
  }
  let mut prompt = false;
  update(&app, &state, &caller, |manager| {
    // Details chosen before the first start ask for the permission that
    // records them once recording starts.
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
pub fn activity_set_capture_details(
  caller: ActivitySetupCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  enabled: bool,
) -> Result<(), String> {
  // Managed policy only turns details off; turning them off stays possible.
  if enabled && crate::managed_policy::current().activity_details_disabled {
    return Err("activity details are turned off by managed policy".to_string());
  }
  let should_prompt = {
    let mut manager = state.lock().map_err(lock_error)?;
    caller.require_writable(&app)?;
    manager.require_caller(&caller)?;
    manager.set_capture_details(enabled, Utc::now())?
  };
  if should_prompt {
    caller.require_current(&app)?;
    activity_details::request_permission();
  }
  crate::activity::emit_changed(&app);
  Ok(())
}

#[tauri::command]
pub fn activity_set_detect_calls(
  caller: ActivitySetupCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  enabled: bool,
) -> Result<(), String> {
  update(&app, &state, &caller, |manager| {
    manager.set_detect_calls(enabled, Utc::now())
  })
}
