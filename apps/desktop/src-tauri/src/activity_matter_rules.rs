//! The member's matter rules for Settings: read and replaced alone, never
//! with the weights learned from window titles, which stay with the activity
//! window (`activity_matter_learning`).

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
  activity::ActivityAppState,
  activity_matter_learning::{
    MatterLearningSave, MatterRule, read, save, validate_rules,
  },
  local_window::ActivitySettingsCaller,
};

/// The rules alone, for Settings: never the learned weights, which come from
/// window titles.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MatterRulesRead {
  Stored {
    revision: u64,
    rules: Vec<MatterRule>,
  },
  Unavailable,
}

#[tauri::command]
pub fn activity_get_matter_rules(
  caller: ActivitySettingsCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
) -> Result<MatterRulesRead, String> {
  Ok(match read(&app, &state, &caller)? {
    Some(stored) => MatterRulesRead::Stored {
      revision: stored.revision,
      rules: stored.learning.rules,
    },
    None => MatterRulesRead::Unavailable,
  })
}

/// Replaces the rules only; what was learned stays.
#[tauri::command]
pub fn activity_save_matter_rules(
  caller: ActivitySettingsCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  revision: u64,
  rules: Vec<MatterRule>,
) -> Result<MatterLearningSave, String> {
  validate_rules(&rules)?;
  save(&app, &state, &caller, revision, |stored| {
    stored.rules = rules;
  })
}
