//! Calendar events for the activity window's day review. The window asks
//! for the day it shows; nothing is read while the user's choice is off,
//! and nothing read is kept.
use tauri::{AppHandle, State};

use crate::{
  account::AccountState,
  activity::{self, ActivityAppState, ActivityCalendarSource},
  activity_commands::lock_error,
  calendar_read::{self, CalendarDay},
  feature_gate::FeatureGates,
  local_window::ActivityCaller,
  time_entry_commands::{linked_account, require_account},
};

#[tauri::command]
pub async fn calendar_day_events(
  caller: ActivityCaller,
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  state: State<'_, ActivityAppState>,
  date: String,
  time_zone: String,
) -> Result<CalendarDay, String> {
  activity::parse_date(&date)?;
  let source = {
    let manager = state.lock().map_err(lock_error)?;
    caller.require_current(&app)?;
    manager.require_caller(&caller)?;
    manager.calendar_source()
  };
  match source {
    ActivityCalendarSource::Off => Ok(CalendarDay::Off),
    ActivityCalendarSource::Microsoft365 => {
      let account = linked_account(&caller, &gates, &accounts).await?;
      let day = calendar_read::day_events(&account, &date, &time_zone).await?;
      require_account(&caller, &gates, &account)?;
      drop(account);
      Ok(day)
    }
  }
}
