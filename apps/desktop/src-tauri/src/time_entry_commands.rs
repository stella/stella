//! The activity window's explicit confirmation boundary. Block references stay local.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::{
  account::{self, AccountState, LinkedAccount},
  activity::{
    self, ActivityAppState, ActivityDraftedEntry, ActivityPendingBatch, ActivityRange,
  },
  feature_gate::{DesktopFeature, FeatureGates},
  local_window::ActivityCaller,
  time_entry_submit::{
    self, ConfirmedBatch, ConfirmedTimeEntry, CreatedEntry, Matter, MatterCandidate,
  },
};

const REFUSAL: &str = "draft time entry is unavailable";
// Serialize confirmation through receipt persistence. A concurrent retry must
// not race the first request's definitive rejection or successful receipt.
static BATCH_CONFIRMATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedBatchItem {
  entry: ConfirmedTimeEntry,
  ranges: Vec<ActivityRange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
  entries: Vec<CreatedEntry>,
  marker_saved: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SubmitError {
  Rejected,
  Uncertain,
}
impl From<String> for SubmitError {
  fn from(_: String) -> Self {
    Self::Uncertain
  }
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
pub async fn time_entry_candidates(
  caller: ActivityCaller,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
) -> Result<Vec<MatterCandidate>, String> {
  let account = linked_account(&caller, &gates, &accounts).await?;
  let candidates = time_entry_submit::candidates(&account).await?;
  require_account(&caller, &gates, &account)?;
  Ok(candidates)
}

#[tauri::command]
pub async fn time_entry_submit_batch_confirmed(
  caller: ActivityCaller,
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  state: State<'_, ActivityAppState>,
  date: String,
  idempotency_key: String,
  items: Vec<ConfirmedBatchItem>,
) -> Result<SubmitResult, SubmitError> {
  let _confirmation = BATCH_CONFIRMATION.lock().await;
  let day = activity::parse_date(&date)?;
  let account = linked_account(&caller, &gates, &accounts).await?;
  let (entries, ranges): (Vec<_>, Vec<_>) = items
    .into_iter()
    .map(|item| (item.entry, item.ranges))
    .unzip();
  let batch = ConfirmedBatch {
    idempotency_key,
    entries,
  };
  batch.validate()?;
  if batch.entries.iter().any(|entry| entry.date_worked != date) {
    return Err(SubmitError::Rejected);
  }
  let pending = ActivityPendingBatch {
    idempotency_key: batch.idempotency_key.clone(),
    entries: serde_json::to_value(&batch.entries).map_err(|_| REFUSAL.to_string())?,
    ranges: ranges.clone(),
  };
  {
    let mut manager = state.lock().map_err(|_| REFUSAL.to_string())?;
    caller.require_current(&app)?;
    manager.require_caller(&caller)?;
    // Persist the exact confirmed request before any outbound I/O. A changed
    // request cannot replace a batch whose response may have been lost.
    manager.reserve_batch(day, pending)?;
  };
  let created =
    match time_entry_submit::submit_batch_with_recovery(&account, &batch).await {
      Ok(created) => created,
      Err(time_entry_submit::SubmitFailure::Rejected) => {
        require_account(&caller, &gates, &account)?;
        caller.require_current(&app)?;
        let mut manager = state.lock().map_err(|_| REFUSAL.to_string())?;
        manager.require_caller(&caller)?;
        manager.cancel_pending_batch(day, &batch.idempotency_key)?;
        return Err(SubmitError::Rejected);
      }
      Err(_) => return Err(SubmitError::Uncertain),
    };
  require_account(&caller, &gates, &account)?;
  caller.require_current(&app)?;
  let markers = created
    .entries
    .iter()
    .zip(ranges)
    .flat_map(|(entry, ranges)| {
      ranges.into_iter().map(|range| ActivityDraftedEntry {
        start: range.start,
        end: range.end,
        entry_id: entry.id.clone(),
      })
    })
    .collect();
  let marker_saved = {
    let mut manager = state.lock().map_err(|_| REFUSAL.to_string())?;
    manager.require_caller(&caller)?;
    manager.finish_batch(day, markers).is_ok()
  };
  let _ = app.emit(activity::CHANGED_EVENT, ());
  Ok(SubmitResult {
    entries: created.entries,
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
