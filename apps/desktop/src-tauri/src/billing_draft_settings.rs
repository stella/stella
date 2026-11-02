//! Consent to AI drafts, read and changed from the activity window or
//! Settings. Nothing here reaches recorded activity.
use tauri::State;

use crate::{
  account::AccountState,
  billing_draft_submit,
  feature_gate::FeatureGates,
  local_window::ActivitySettingsCaller,
  time_entry_commands::{linked_account, require_account},
  types::DesktopAccountIdentity,
};

const SETTINGS_UNAVAILABLE: &str = "draft time entry is unavailable";

/// The account a settings answer belongs to, as the window keys its consent
/// state: `["<organization id>","<user id>"]`.
fn settings_scope(identity: &DesktopAccountIdentity) -> String {
  serde_json::json!([identity.organization_id, identity.user_id]).to_string()
}

/// A settings answer with the account it belongs to; the server's answer
/// names no account, so the window could not tell an answer for the account
/// it asked about from one for an account switched in meanwhile.
fn scoped(
  identity: &DesktopAccountIdentity,
  settings: serde_json::Value,
) -> serde_json::Value {
  serde_json::json!({ "scopeKey": settings_scope(identity), "settings": settings })
}

// AccountRequest holds the account-switch lease through the subsequent HTTP write.
fn require_settings_scope(
  identity: &DesktopAccountIdentity,
  scope_key: &str,
) -> Result<(), String> {
  let expected = serde_json::from_str::<[String; 2]>(scope_key)
    .map_err(|_malformed_scope| SETTINGS_UNAVAILABLE.to_string())?;
  if expected[0] != identity.organization_id || expected[1] != identity.user_id {
    return Err(SETTINGS_UNAVAILABLE.to_string());
  }
  Ok(())
}

#[tauri::command]
pub async fn billing_draft_get_settings(
  caller: ActivitySettingsCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
) -> Result<serde_json::Value, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  let settings = billing_draft_submit::settings(&account).await?;
  require_account(&caller, &gates, &account)?;
  let answer = scoped(&account.identity, settings);
  drop(account);
  Ok(answer)
}

/// Withdrawing needs no revision and works even where drafting is off, so a
/// user can always take consent back.
#[tauri::command]
pub async fn billing_draft_withdraw_consent(
  caller: ActivitySettingsCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  scope_key: String,
) -> Result<serde_json::Value, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  require_settings_scope(&account.identity, &scope_key)?;
  let settings = billing_draft_submit::withdraw_consent(&account).await?;
  require_account(&caller, &gates, &account)?;
  let answer = scoped(&account.identity, settings);
  drop(account);
  Ok(answer)
}

#[tauri::command]
pub async fn billing_draft_grant_consent(
  caller: ActivitySettingsCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  scope_key: String,
  revision: Option<String>,
) -> Result<serde_json::Value, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  require_settings_scope(&account.identity, &scope_key)?;
  let settings =
    billing_draft_submit::grant_consent(&account, revision.as_deref()).await?;
  require_account(&caller, &gates, &account)?;
  let answer = scoped(&account.identity, settings);
  drop(account);
  Ok(answer)
}

#[cfg(test)]
mod tests {
  use super::{require_settings_scope, settings_scope};
  use crate::types::DesktopAccountIdentity;

  #[test]
  fn settings_writes_require_the_initiating_organization_and_user() {
    let identity = DesktopAccountIdentity {
      organization_id: "firm-a".into(),
      user_id: "user-a".into(),
    };
    assert_eq!(settings_scope(&identity), r#"["firm-a","user-a"]"#);
    assert!(require_settings_scope(&identity, &settings_scope(&identity)).is_ok());
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
