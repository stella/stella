//! Consent to AI drafts and the remembered drafting instruction, read and
//! changed from the activity window, Settings or setup. Nothing here reaches
//! recorded activity. Where managed policy turns drafts off, every answer
//! says drafting is off on this computer and no consent can be granted;
//! withdrawing stays possible.
use serde::Serialize;
use tauri::State;

use crate::{
  account::AccountState,
  billing_draft_submit,
  feature_gate::FeatureGates,
  local_window::ActivitySetupCaller,
  managed_policy::{self, ManagedPolicy},
  time_entry_commands::{linked_account, require_account},
  types::DesktopAccountIdentity,
};

const SETTINGS_UNAVAILABLE: &str = "draft time entry is unavailable";
const DRAFTS_MANAGED_OFF: &str = "stella AI drafts are turned off by managed policy";

/// The server settings' field and value (`desktopBillingDraftSettingsResponseSchema`)
/// that say drafting is off.
const EFFECTIVE_MODE: &str = "effectiveMode";
const MODE_OFF: &str = "off";

/// Who decides drafting on this computer: the account's own settings, or
/// managed policy, which turned it off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum DraftPolicy {
  Account,
  ManagedOff,
}

/// The account a settings answer belongs to, as the window keys its consent
/// state: `["<organization id>","<user id>"]`.
fn settings_scope(identity: &DesktopAccountIdentity) -> String {
  serde_json::json!([identity.organization_id, identity.user_id]).to_string()
}

/// A settings answer with the account it belongs to; the server's answer
/// names no account, so the window could not tell an answer for the account
/// it asked about from one for an account switched in meanwhile. Under
/// managed policy the answer's mode is off, as it is on this computer.
fn scoped(
  identity: &DesktopAccountIdentity,
  settings: serde_json::Value,
  policy: &ManagedPolicy,
) -> Result<serde_json::Value, String> {
  let (settings, policy) = under_policy(settings, policy)?;
  Ok(serde_json::json!({
    "scopeKey": settings_scope(identity),
    "settings": settings,
    "policy": policy,
  }))
}

fn under_policy(
  mut settings: serde_json::Value,
  policy: &ManagedPolicy,
) -> Result<(serde_json::Value, DraftPolicy), String> {
  if !policy.activity_ai_drafts_disabled {
    return Ok((settings, DraftPolicy::Account));
  }
  let Some(fields) = settings.as_object_mut() else {
    return Err(SETTINGS_UNAVAILABLE.to_string());
  };
  fields.insert(EFFECTIVE_MODE.to_string(), MODE_OFF.into());
  Ok((settings, DraftPolicy::ManagedOff))
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
  caller: ActivitySetupCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
) -> Result<serde_json::Value, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  let settings = billing_draft_submit::settings(&account).await?;
  require_account(&caller, &gates, &account)?;
  let answer = scoped(&account.identity, settings, managed_policy::current())?;
  drop(account);
  Ok(answer)
}

/// Withdrawing needs no revision and works even where drafting is off, so a
/// user can always take consent back.
#[tauri::command]
pub async fn billing_draft_withdraw_consent(
  caller: ActivitySetupCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  scope_key: String,
) -> Result<serde_json::Value, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  require_settings_scope(&account.identity, &scope_key)?;
  let settings = billing_draft_submit::withdraw_consent(&account).await?;
  require_account(&caller, &gates, &account)?;
  let answer = scoped(&account.identity, settings, managed_policy::current())?;
  drop(account);
  Ok(answer)
}

#[tauri::command]
pub async fn billing_draft_grant_consent(
  caller: ActivitySetupCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  scope_key: String,
  revision: Option<String>,
) -> Result<serde_json::Value, String> {
  if managed_policy::current().activity_ai_drafts_disabled {
    return Err(DRAFTS_MANAGED_OFF.to_string());
  }
  let account = linked_account(&caller, &gates, &accounts).await?;
  require_settings_scope(&account.identity, &scope_key)?;
  let settings =
    billing_draft_submit::grant_consent(&account, revision.as_deref()).await?;
  require_account(&caller, &gates, &account)?;
  let answer = scoped(&account.identity, settings, managed_policy::current())?;
  drop(account);
  Ok(answer)
}

/// The instruction future drafts follow, or `None` to forget it.
#[tauri::command]
pub async fn billing_draft_set_preference(
  caller: ActivitySetupCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  scope_key: String,
  revision: Option<String>,
  preference: Option<String>,
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
  let answer = scoped(&account.identity, settings, managed_policy::current())?;
  drop(account);
  Ok(answer)
}

#[cfg(test)]
mod tests {
  use super::{DraftPolicy, require_settings_scope, settings_scope, under_policy};
  use crate::{managed_policy::ManagedPolicy, types::DesktopAccountIdentity};

  fn server_settings() -> serde_json::Value {
    serde_json::json!({
      "revision": "revision-1",
      "effectiveMode": "guided",
      "consent": "granted",
      "preference": null,
    })
  }

  #[test]
  fn without_the_drafts_policy_the_account_decides() {
    assert_eq!(
      under_policy(server_settings(), &ManagedPolicy::default()).unwrap(),
      (server_settings(), DraftPolicy::Account)
    );
  }

  // Consent stays as the server holds it, so it can still be withdrawn.
  #[test]
  fn the_drafts_policy_turns_drafting_off_and_keeps_consent() {
    let policy = ManagedPolicy {
      activity_ai_drafts_disabled: true,
      ..ManagedPolicy::default()
    };
    let (settings, decided_by) = under_policy(server_settings(), &policy).unwrap();
    assert_eq!(decided_by, DraftPolicy::ManagedOff);
    assert_eq!(settings["effectiveMode"], "off");
    assert_eq!(settings["consent"], "granted");
    assert_eq!(settings["revision"], "revision-1");
    assert!(under_policy(serde_json::Value::Null, &policy).is_err());
  }

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
