//! Clipboard settings commands, for the Clips windows and the Settings
//! window. Every command takes a [`ClipboardSettingsCaller`]: these change
//! how history is kept (capture, retention, excluded applications, screen
//! recordings) and how its groups are named and ordered, and every answer is
//! a [`ClipboardSettingsSnapshot`], never a clip. Every change announces
//! itself through [`HISTORY_EVENT`], so each open window reads again.

use tauri::{AppHandle, Emitter, State};

use crate::{
  clipboard::{
    ClipboardAppState, ClipboardCaptureStatus, ClipboardGroupColor,
    ClipboardGroupDeletionMode, ClipboardManager, ClipboardRetention,
    ClipboardSettingsSnapshot, HISTORY_EVENT,
  },
  clipboard_commands::lock_error,
  clipboard_screen_capture::ClipboardScreenCapture,
  clipboard_window,
  local_window::ClipboardSettingsCaller,
  logging::best_effort,
};

const GROUP_NOT_FOUND_ERROR: &str = "clipboard group no longer exists";

/// Applies one change and answers with the settings after it.
fn update(
  caller: &ClipboardSettingsCaller,
  state: &State<'_, ClipboardAppState>,
  app: &AppHandle,
  change: impl FnOnce(&mut ClipboardManager) -> Result<(), String>,
) -> Result<ClipboardSettingsSnapshot, String> {
  let settings = {
    let mut manager = state.lock().map_err(lock_error)?;
    change(&mut manager)?;
    manager.settings_snapshot(caller)
  };
  announce(app);
  Ok(settings)
}

fn announce(app: &AppHandle) {
  best_effort(
    app.emit(HISTORY_EVENT, ()),
    "clipboard history change was not announced",
  );
}

/// A change to a group that may have been deleted in another window.
fn found(changed: bool) -> Result<(), String> {
  if changed {
    Ok(())
  } else {
    Err(GROUP_NOT_FOUND_ERROR.to_string())
  }
}

#[tauri::command]
pub fn clipboard_get_settings(
  caller: ClipboardSettingsCaller,
  state: State<'_, ClipboardAppState>,
) -> Result<ClipboardSettingsSnapshot, String> {
  let manager = state.lock().map_err(lock_error)?;
  Ok(manager.settings_snapshot(&caller))
}

#[tauri::command]
pub fn clipboard_set_capture_status(
  caller: ClipboardSettingsCaller,
  status: ClipboardCaptureStatus,
  state: State<'_, ClipboardAppState>,
  app: AppHandle,
) -> Result<ClipboardSettingsSnapshot, String> {
  update(&caller, &state, &app, |manager| {
    manager.set_capture_status(status)
  })
}

#[tauri::command]
pub fn clipboard_remove_source_app_exclusion(
  caller: ClipboardSettingsCaller,
  identifier: String,
  state: State<'_, ClipboardAppState>,
  app: AppHandle,
) -> Result<ClipboardSettingsSnapshot, String> {
  update(&caller, &state, &app, |manager| {
    manager.remove_source_app_exclusion(&identifier).map(|_| ())
  })
}

#[tauri::command]
pub fn clipboard_set_retention(
  caller: ClipboardSettingsCaller,
  retention: ClipboardRetention,
  state: State<'_, ClipboardAppState>,
  app: AppHandle,
) -> Result<ClipboardSettingsSnapshot, String> {
  update(&caller, &state, &app, |manager| {
    manager.set_retention(retention)
  })
}

/// The open windows change first, and the preference is recorded only once they
/// all hold the new protection. A failed transition rolls the windows back, so
/// the settings never report a visibility that a window does not have and a
/// window created later never disagrees with the ones already open.
#[tauri::command]
pub fn clipboard_set_screen_capture(
  caller: ClipboardSettingsCaller,
  capture: ClipboardScreenCapture,
  state: State<'_, ClipboardAppState>,
  app: AppHandle,
) -> Result<ClipboardSettingsSnapshot, String> {
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
  update(&caller, &state, &app, |manager| {
    manager.set_screen_capture(capture)
  })
  .inspect_err(|_| rollback())
}

/// Creates a group; a Clips window may name the clip that moves into it.
#[tauri::command]
pub fn clipboard_create_group(
  caller: ClipboardSettingsCaller,
  color: ClipboardGroupColor,
  item_id: Option<String>,
  name: String,
  state: State<'_, ClipboardAppState>,
  app: AppHandle,
) -> Result<ClipboardSettingsSnapshot, String> {
  update(&caller, &state, &app, |manager| {
    manager
      .create_group(&name, color, item_id.as_deref())
      .map(|_| ())
  })
}

#[tauri::command]
pub fn clipboard_delete_group(
  caller: ClipboardSettingsCaller,
  id: String,
  mode: ClipboardGroupDeletionMode,
  state: State<'_, ClipboardAppState>,
  app: AppHandle,
) -> Result<ClipboardSettingsSnapshot, String> {
  update(&caller, &state, &app, |manager| {
    found(manager.delete_group(&id, mode)?)
  })
}

#[tauri::command]
pub fn clipboard_update_group(
  caller: ClipboardSettingsCaller,
  color: ClipboardGroupColor,
  id: String,
  name: String,
  state: State<'_, ClipboardAppState>,
  app: AppHandle,
) -> Result<ClipboardSettingsSnapshot, String> {
  update(&caller, &state, &app, |manager| {
    found(manager.update_group(&id, &name, color)?)
  })
}

#[tauri::command]
pub fn clipboard_move_group(
  caller: ClipboardSettingsCaller,
  id: String,
  index: usize,
  state: State<'_, ClipboardAppState>,
  app: AppHandle,
) -> Result<ClipboardSettingsSnapshot, String> {
  update(&caller, &state, &app, |manager| {
    found(manager.move_group(&id, index)?)
  })
}
