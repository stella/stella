//! The activity window's AI drafting boundary: personal settings, and drafts
//! for entries the user selected. Recorded activity never reaches this module.
use tauri::State;

use crate::{
  account::AccountState,
  billing_draft_submit::{self, Consent, DraftError, DraftRequest},
  feature_gate::FeatureGates,
  local_window::ActivityCaller,
  time_entry_commands::{linked_account, require_account},
  types::DesktopAccountIdentity,
};

const SETTINGS_UNAVAILABLE: &str = "draft time entry is unavailable";

// AccountRequest holds the account-switch lease through the subsequent HTTP write.
fn require_settings_scope(
  identity: &DesktopAccountIdentity,
  scope_key: &str,
) -> Result<(), String> {
  let expected = serde_json::from_str::<[String; 2]>(scope_key)
    .map_err(|_| SETTINGS_UNAVAILABLE.to_string())?;
  if expected[0] != identity.organization_id || expected[1] != identity.user_id {
    return Err(SETTINGS_UNAVAILABLE.to_string());
  }
  Ok(())
}

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
  scope_key: String,
  revision: Option<String>,
) -> Result<serde_json::Value, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  require_settings_scope(&account.identity, &scope_key)?;
  let settings =
    billing_draft_submit::set_consent(&account, consent, revision.as_deref()).await?;
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
  scope_key: String,
  revision: Option<String>,
) -> Result<serde_json::Value, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  require_settings_scope(&account.identity, &scope_key)?;
  let settings = billing_draft_submit::set_preference(
    &account,
    preference.as_deref(),
    revision.as_deref(),
  )
  .await?;
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

#[cfg(test)]
mod tests {
  use super::require_settings_scope;
  use crate::types::DesktopAccountIdentity;

  #[test]
  fn settings_writes_require_the_initiating_organization_and_user() {
    let identity = DesktopAccountIdentity {
      organization_id: "firm-a".into(),
      user_id: "user-a".into(),
    };
    assert!(require_settings_scope(&identity, r#"["firm-a","user-a"]"#).is_ok());
    for scope in [
      r#"["firm-b","user-a"]"#,
      r#"["firm-a","user-b"]"#,
      "null",
      "[]",
    ] {
      assert!(require_settings_scope(&identity, scope).is_err());
    }
  }
}
