//! The activity window's explicit confirmation boundary. Block references stay local.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::{
  account::{self, AccountRequest, AccountState, LinkedAccount},
  activity::{
    self, ActivityAppState, ActivityDraftedEntry, ActivityPendingBatch, ActivityRange,
    BatchReservationError,
  },
  feature_gate::{DesktopFeature, FeatureGates},
  local_window::ActivityCaller,
  time_entry_submit::{
    self, ConfirmedBatch, ConfirmedTimeEntry, CreatedEntry, Matter, MatterCandidate,
  },
};

const REFUSAL: &str = "draft time entry is unavailable";

/// The window learns only that the batch was refused; the cause is logged.
fn rejected<E: std::fmt::Display>(cause: E) -> SubmitError {
  crate::logging::log_cause(&cause, "time entry batch was refused");
  SubmitError::Rejected
}

/// The batch may have reached the server; the cause is logged.
fn uncertain<E: std::fmt::Display>(cause: E) -> SubmitError {
  crate::logging::log_cause(&cause, "time entry batch outcome is uncertain");
  SubmitError::Uncertain
}
// Serialize confirmation through receipt persistence. A concurrent retry must
// not race the first request's definitive rejection or successful receipt.
pub(crate) static BATCH_CONFIRMATION: tokio::sync::Mutex<()> =
  tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedBatchItem {
  entry: ConfirmedTimeEntry,
  ranges: Vec<ActivityRange>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedBatchRequest {
  date: String,
  idempotency_key: String,
  items: Vec<ConfirmedBatchItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
  entries: Vec<CreatedEntry>,
  marker_saved: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SubmitError {
  Rejected,
  Uncertain,
}
impl From<BatchReservationError> for SubmitError {
  fn from(error: BatchReservationError) -> Self {
    match error {
      BatchReservationError::NotWritable(_)
      | BatchReservationError::InvalidEntries
      | BatchReservationError::InvalidKey
      | BatchReservationError::InvalidRangeCount
      | BatchReservationError::InvalidRange
      | BatchReservationError::OverlappingRanges => Self::Rejected,
      BatchReservationError::PendingStateUnavailable(_)
      | BatchReservationError::PendingConflict
      | BatchReservationError::PersistenceFailed(_) => Self::Uncertain,
    }
  }
}

fn validate_confirmation(
  batch: &ConfirmedBatch,
  date: &str,
) -> Result<(), SubmitError> {
  batch.validate().map_err(rejected)?;
  if batch.entries.iter().any(|entry| entry.date_worked != date) {
    return Err(SubmitError::Rejected);
  }
  Ok(())
}

pub(crate) fn require_account(
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

fn require_local_discard(
  caller: &ActivityCaller,
  gates: &FeatureGates,
) -> Result<(), String> {
  let binding = gates
    .account_binding(DesktopFeature::ActivityTimeline)
    .ok_or(REFUSAL)?;
  if gates.is_enabled(DesktopFeature::TimeBilling)
    || Some(&binding) != caller.account_binding()
  {
    return Err(REFUSAL.into());
  }
  Ok(())
}

pub(crate) async fn linked_account(
  caller: &ActivityCaller,
  gates: &FeatureGates,
  state: &AccountState,
) -> Result<AccountRequest, String> {
  let linked = account::request_account(state)
    .await
    .map_err(crate::logging::with_cause_logged(REFUSAL))?
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
  drop(account);
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
  drop(account);
  Ok(candidates)
}

#[tauri::command]
pub async fn time_entry_submit_batch_confirmed(
  caller: ActivityCaller,
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  accounts: State<'_, AccountState>,
  state: State<'_, ActivityAppState>,
  request: ConfirmedBatchRequest,
) -> Result<SubmitResult, SubmitError> {
  let ConfirmedBatchRequest {
    date,
    idempotency_key,
    items,
  } = request;
  let _confirmation = BATCH_CONFIRMATION.lock().await;
  let day = activity::parse_date(&date).map_err(rejected)?;
  let account = linked_account(&caller, &gates, &accounts)
    .await
    .map_err(rejected)?;
  let (entries, ranges): (Vec<_>, Vec<_>) = items
    .into_iter()
    .map(|item| (item.entry, item.ranges))
    .unzip();
  let batch = ConfirmedBatch {
    idempotency_key,
    entries,
  };
  validate_confirmation(&batch, &date)?;
  let pending = ActivityPendingBatch {
    idempotency_key: batch.idempotency_key.clone(),
    entries: serde_json::to_value(&batch.entries).map_err(rejected)?,
    ranges: ranges.clone(),
  };
  {
    let mut manager = state.lock().map_err(rejected)?;
    caller.require_current(&app).map_err(rejected)?;
    manager.require_caller(&caller).map_err(rejected)?;
    // Persist the exact confirmed request before any outbound I/O. A changed
    // request cannot replace a batch whose response may have been lost.
    manager.reserve_batch(day, pending)?;
  };
  let created =
    match time_entry_submit::submit_batch_with_recovery(&account, &batch).await {
      Ok(created) => created,
      Err(time_entry_submit::SubmitFailure::Cancelled) => {
        require_account(&caller, &gates, &account).map_err(uncertain)?;
        caller.require_current(&app).map_err(uncertain)?;
        let mut manager = state.lock().map_err(uncertain)?;
        manager.require_caller(&caller).map_err(uncertain)?;
        manager
          .cancel_pending_batch(day, &batch.idempotency_key)
          .map_err(uncertain)?;
        drop(manager);
        let _ = app.emit(activity::CHANGED_EVENT, ());
        return Err(SubmitError::Rejected);
      }
      Err(_) => return Err(SubmitError::Uncertain),
    };
  require_account(&caller, &gates, &account).map_err(uncertain)?;
  caller.require_current(&app).map_err(uncertain)?;
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
    let mut manager = state.lock().map_err(uncertain)?;
    manager.require_caller(&caller).map_err(uncertain)?;
    manager.finish_batch(day, markers).is_ok()
  };
  // The account request lease covers the submission and its marker.
  drop(account);
  let _ = app.emit(activity::CHANGED_EVENT, ());
  Ok(SubmitResult {
    entries: created.entries,
    marker_saved,
  })
}

#[tauri::command]
pub async fn time_entry_discard_pending_batch_confirmed(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  gates: State<'_, FeatureGates>,
  date: String,
  idempotency_key: String,
) -> Result<(), String> {
  let _confirmation = BATCH_CONFIRMATION.lock().await;
  caller.require_current(&app)?;
  require_local_discard(&caller, &gates)?;
  let date = activity::parse_date(&date)?;
  let mut manager = state
    .lock()
    .map_err(crate::logging::with_cause_logged(REFUSAL))?;
  manager.require_caller(&caller)?;
  manager.cancel_pending_batch(date, &idempotency_key)?;
  drop(manager);
  let _ = app.emit(activity::CHANGED_EVENT, ());
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashSet;

  #[test]
  fn reservation_validation_errors_are_rejected() {
    for error in [
      BatchReservationError::NotWritable("not writable".into()),
      BatchReservationError::InvalidEntries,
      BatchReservationError::InvalidKey,
      BatchReservationError::InvalidRangeCount,
      BatchReservationError::InvalidRange,
      BatchReservationError::OverlappingRanges,
    ] {
      assert_eq!(SubmitError::from(error), SubmitError::Rejected);
    }
  }

  #[test]
  fn reservation_state_and_persistence_errors_remain_uncertain() {
    for error in [
      BatchReservationError::PendingStateUnavailable("state unavailable".into()),
      BatchReservationError::PendingConflict,
      BatchReservationError::PersistenceFailed("persistence failed".into()),
    ] {
      assert_eq!(SubmitError::from(error), SubmitError::Uncertain);
    }
  }

  #[test]
  fn oversized_confirmation_is_rejected_before_reservation() {
    let date = "2026-10-09";
    let batch = ConfirmedBatch {
      idempotency_key: "confirmed-batch".into(),
      entries: (0..101)
        .map(|index| ConfirmedTimeEntry {
          matter_id: format!("matter_{index}"),
          date_worked: date.into(),
          timezone_id: "UTC".into(),
          duration_minutes: 6,
          narrative: "Reviewed agreement".into(),
          billable: false,
          classification: None,
        })
        .collect(),
    };
    assert_eq!(
      validate_confirmation(&batch, date),
      Err(SubmitError::Rejected)
    );
    let accepted = ConfirmedBatch {
      idempotency_key: batch.idempotency_key,
      entries: batch.entries.into_iter().take(100).collect(),
    };
    assert_eq!(validate_confirmation(&accepted, date), Ok(()));
  }

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
      let discard = features == HashSet::from([DesktopFeature::ActivityTimeline]);
      gates
        .install(
          generation,
          Some(namespace.clone()),
          Some(chrono::Utc::now() + chrono::Duration::hours(1)),
          features,
        )
        .unwrap();
      assert_eq!(require_account(&caller, &gates, &account).is_ok(), both);
      assert_eq!(require_local_discard(&caller, &gates).is_ok(), discard);
    }
    let mut other = account.clone();
    other.identity.user_id = "other_user".into();
    assert!(require_account(&caller, &gates, &other).is_err());
    gates.invalidate();
    assert!(require_account(&caller, &gates, &account).is_err());
    assert!(require_local_discard(&caller, &gates).is_err());
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
    assert!(require_local_discard(&caller, &gates).is_err());
  }
}
