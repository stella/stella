//! Drafts for time entries the user selected in the activity window. Recorded
//! activity never reaches this module; consent lives in
//! `billing_draft_settings`.
use tauri::State;

use crate::{
  account::AccountState,
  billing_draft_submit::{self, DraftError, DraftRequest},
  feature_gate::FeatureGates,
  local_window::ActivityCaller,
  time_entry_commands::{linked_account, require_account},
};

#[tauri::command]
pub async fn billing_draft_create_confirmed(
  caller: ActivityCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  request: DraftRequest,
) -> Result<serde_json::Value, DraftError> {
  let account = linked_account(&caller, &gates, &accounts)
    .await
    .map_err(|_account_error| DraftError::Failed)?;
  let review = billing_draft_submit::draft(&account, &request).await?;
  require_account(&caller, &gates, &account)
    .map_err(|_account_error| DraftError::Failed)?;
  drop(account);
  Ok(review)
}
