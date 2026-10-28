//! The activity window's AI drafting boundary: personal settings, and drafts
//! for entries the user selected. Recorded activity never reaches this module.
use tauri::State;

use crate::{
  account::AccountState,
  billing_draft_submit::{self, Consent, DraftError, DraftRequest},
  feature_gate::FeatureGates,
  local_window::ActivityCaller,
  time_entry_commands::{linked_account, require_account},
};

#[tauri::command]
pub async fn billing_draft_get_settings(
  caller: ActivityCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
) -> Result<serde_json::Value, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  let settings = billing_draft_submit::settings(&account).await?;
  require_account(&caller, &gates, &account)?;
  drop(account);
  Ok(settings)
}

#[tauri::command]
pub async fn billing_draft_set_consent(
  caller: ActivityCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  consent: Consent,
) -> Result<serde_json::Value, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  let settings = billing_draft_submit::set_consent(&account, consent).await?;
  require_account(&caller, &gates, &account)?;
  drop(account);
  Ok(settings)
}

#[tauri::command]
pub async fn billing_draft_set_preference(
  caller: ActivityCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  preference: Option<String>,
) -> Result<serde_json::Value, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  let settings =
    billing_draft_submit::set_preference(&account, preference.as_deref()).await?;
  require_account(&caller, &gates, &account)?;
  drop(account);
  Ok(settings)
}

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
