//! Day timeline commands of the activity window. Every command takes an
//! [`ActivityCaller`], which only the activity window on the app origin can
//! produce, and only while the feature is enabled. Settings commands live in
//! `activity_settings`. Changes are announced with a payload-free event; the
//! window reads the data back through `activity_get_day`.

use chrono::Utc;
use tauri::{AppHandle, State};

use crate::{
  activity::{self, ActivityAppState, ActivityDaySnapshot, ActivityManager},
  activity_details,
  local_window::{ActivityAccountFeature, ActivityCaller, LocalCaller},
};

const MAX_COPY_BYTES: usize = 16 * 1024;

pub(crate) fn lock_error<T>(poisoned: std::sync::PoisonError<T>) -> String {
  crate::logging::with_cause_logged("activity timeline is unavailable")(poisoned)
}

/// Applies one change for the caller's account, then tells every activity
/// view and the tray to read again.
pub(crate) fn update<F: ActivityAccountFeature, E: From<String>>(
  app: &AppHandle,
  state: &ActivityAppState,
  caller: &LocalCaller<F>,
  change: impl FnOnce(&mut ActivityManager) -> Result<(), E>,
) -> Result<(), E> {
  let mut manager = state
    .lock()
    .map_err(|poisoned| E::from(lock_error(poisoned)))?;
  caller.require_current(app).map_err(E::from)?;
  manager.require_caller(caller).map_err(E::from)?;
  change(&mut manager)?;
  drop(manager);
  activity::emit_changed(app);
  Ok(())
}

#[tauri::command]
pub fn activity_get_day(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
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
  Ok(snapshot)
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

/// Opens the Settings window on its Activity tab, where the activity
/// settings live.
#[tauri::command]
pub async fn activity_open_settings(
  caller: ActivityCaller,
  app: AppHandle,
) -> Result<(), String> {
  caller.require_current(&app)?;
  crate::ensure_main_window(&app, crate::PreferencesTab::Activity);
  Ok(())
}
