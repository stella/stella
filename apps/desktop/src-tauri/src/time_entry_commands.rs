//! The activity window's explicit confirmation boundary. Block references stay local.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::{
  account::{self, AccountState, LinkedAccount},
  activity::{self, ActivityAppState, ActivityDraftedEntry},
  feature_gate::{DesktopFeature, FeatureGates},
  local_window::ActivityCaller,
  time_entry_submit::{self, ConfirmedTimeEntry, Matter},
};

const REFUSAL: &str = "draft time entry is unavailable";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedBlock {
  date: String,
  start: String,
  end: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
  id: String,
  marker_saved: bool,
}

fn require_account(
  caller: &ActivityCaller,
  gates: &FeatureGates,
  account: &LinkedAccount,
) -> Result<(), String> {
  let binding = gates.account_binding(DesktopFeature::ActivityTimeline);
  if !gates.is_enabled(DesktopFeature::TimeBilling)
    || binding.as_ref() != caller.account_binding()
    || binding
      .as_ref()
      .is_none_or(|(_, namespace)| namespace != &account.local_data_namespace())
  {
    return Err(REFUSAL.to_string());
  }
  Ok(())
}

async fn linked_account(
  caller: &ActivityCaller,
  gates: &FeatureGates,
  state: &AccountState,
) -> Result<LinkedAccount, String> {
  let linked = account::current(state)
    .await
    .map_err(|_| REFUSAL.to_string())?
    .ok_or_else(|| REFUSAL.to_string())?;
  require_account(caller, gates, &linked)?;
  Ok(linked)
}

#[tauri::command]
pub async fn time_entry_search_matters(
  caller: ActivityCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  query: String,
) -> Result<Vec<Matter>, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  let matters = time_entry_submit::search_matters(&account, &query).await?;
  require_account(&caller, &gates, &account)?;
  Ok(matters)
}

#[tauri::command]
pub async fn time_entry_submit_confirmed(
  caller: ActivityCaller,
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  state: State<'_, ActivityAppState>,
  entry: ConfirmedTimeEntry,
  block: ConfirmedBlock,
) -> Result<SubmitResult, String> {
  let date = activity::parse_date(&block.date)?;
  let start = chrono::DateTime::parse_from_rfc3339(&block.start)
    .map_err(|_| REFUSAL.to_string())?;
  let end = chrono::DateTime::parse_from_rfc3339(&block.end)
    .map_err(|_| REFUSAL.to_string())?;
  if start >= end {
    return Err(REFUSAL.to_string());
  }
  let account = linked_account(&caller, &gates, &accounts).await?;
  {
    let manager = state.lock().map_err(|_| REFUSAL.to_string())?;
    manager.require_caller(&caller)?;
    manager.require_draftable(date, &block.start)?;
  }
  let created = time_entry_submit::submit(&account, &entry).await?;
  require_account(&caller, &gates, &account)?;
  let marker_saved = state.lock().ok().is_some_and(|mut manager| {
    manager.require_caller(&caller).is_ok()
      && manager
        .record_drafted(
          date,
          ActivityDraftedEntry {
            start: block.start,
            end: block.end,
            entry_id: created.id.clone(),
          },
        )
        .is_ok()
  });
  let _ = app.emit(activity::CHANGED_EVENT, ());
  Ok(SubmitResult {
    id: created.id,
    marker_saved,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashSet;

  #[test]
  fn confirmation_requires_both_features_and_the_original_account_generation() {
    let account: LinkedAccount = serde_json::from_value(serde_json::json!({
      "apiBaseUrl": "https://api.example.test", "webOrigin": "https://example.test",
      "account": {"email": "fixture@example.test", "name": null, "verifiedAt": "2026-01-01T00:00:00Z"},
      "identity": {"userId": "user_fixture", "organizationId": "org_fixture"},
      "credential": {"key": "fixture_key", "expiresAt": "2099-01-01T00:00:00Z"}
    })).unwrap();
    let gates = FeatureGates::default();
    let namespace = account.local_data_namespace();
    let generation = gates.generation().unwrap();
    let caller = ActivityCaller::for_account_test(generation, &namespace);
    for features in [
      HashSet::new(),
      HashSet::from([DesktopFeature::ActivityTimeline]),
      HashSet::from([DesktopFeature::TimeBilling]),
      HashSet::from([
        DesktopFeature::ActivityTimeline,
        DesktopFeature::TimeBilling,
      ]),
    ] {
      let both = features.len() == 2;
      gates
        .install(
          generation,
          Some(namespace.clone()),
          Some(chrono::Utc::now() + chrono::Duration::hours(1)),
          features,
        )
        .unwrap();
      assert_eq!(require_account(&caller, &gates, &account).is_ok(), both);
    }
    let mut other = account.clone();
    other.identity.user_id = "other_user".into();
    assert!(require_account(&caller, &gates, &other).is_err());
    gates.invalidate();
    assert!(require_account(&caller, &gates, &account).is_err());
    gates.finish_account_change();
    gates
      .install(
        gates.generation().unwrap(),
        Some(namespace),
        Some(chrono::Utc::now() + chrono::Duration::hours(1)),
        HashSet::from([
          DesktopFeature::ActivityTimeline,
          DesktopFeature::TimeBilling,
        ]),
      )
      .unwrap();
    assert!(require_account(&caller, &gates, &account).is_err());
  }
}
