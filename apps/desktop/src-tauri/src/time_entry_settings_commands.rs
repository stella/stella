//! What Settings reads from the server for activity settings: the matters
//! the member's rules name, resolved under the member's current access so a
//! rule never shows a matter the member can no longer open. Only matter ids
//! leave the machine, never a rule's text.
use tauri::State;

use crate::{
  account::AccountState,
  feature_gate::FeatureGates,
  local_window::ActivitySettingsCaller,
  time_entry_commands::{linked_account, require_account},
  time_entry_submit::{self, MatterResolution},
};

#[tauri::command]
pub async fn time_entry_resolve_rule_matters(
  caller: ActivitySettingsCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  ids: Vec<String>,
) -> Result<Vec<MatterResolution>, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  let resolved = time_entry_submit::resolve_matters(&account, &ids).await?;
  require_account(&caller, &gates, &account)?;
  drop(account);
  Ok(resolved)
}
