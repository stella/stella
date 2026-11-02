//! Sends only the fields of entries the user selected for AI drafting; no local history is accessible here.
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::{
  account::AccountRequest,
  http_client::{DesktopHttpClient, HttpClientOptions},
  logging::{json_cause_logged, request_cause_logged},
};

const FAILURE: &str = "billing draft request failed";
// Contract limits, kept equal to the shared contract by the fixture test.
const MAX_ENTRIES: usize = 20;
const MAX_STEER_CHARS: usize = 2000;
const MAX_MATCHED_EARLIER_ENTRIES: usize = 20;
const MAX_EARLIER_NARRATIVE_UNITS: usize = 10_000;
// The cited earlier entries dominate a review: up to MAX_ENTRIES times
// MAX_MATCHED_EARLIER_ENTRIES of them, each with a narrative of up to
// MAX_EARLIER_NARRATIVE_UNITS UTF-16 units. JSON spends at most 6 bytes on a
// unit (a `\u` escape), plus a bounded id, date and duration per entry. The
// model's own result, a few short narratives per entry, gets a fixed 1 MiB.
const EARLIER_ENTRY_OVERHEAD_BYTES: usize = 512;
const RESULT_ALLOWANCE_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = MAX_ENTRIES
  * MAX_MATCHED_EARLIER_ENTRIES
  * (MAX_EARLIER_NARRATIVE_UNITS * 6 + EARLIER_ENTRY_OVERHEAD_BYTES)
  + RESULT_ALLOWANCE_BYTES;
// The server bounds one generation at 60 seconds; waiting longer lets its own
// bounded failure arrive instead of a client timeout.
const DRAFT_TIMEOUT: Duration = Duration::from_secs(75);
const SETTINGS_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
struct ErrorBody {
  code: Option<String>,
}

/// Names the user already sees as evidence; present only when titles are recorded.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftEvidence {
  document_names: Vec<String>,
  window_titles: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftEntry {
  /// Positional identifier the review uses to match the server's drafts back
  /// to the entries it sent.
  entry_id: String,
  matter_id: String,
  date: String,
  timezone: String,
  duration_minutes: u32,
  app_names: Vec<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  evidence: Option<DraftEvidence>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftRequest {
  entries: Vec<DraftEntry>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  steer: Option<String>,
  /// The server's earlier result, sent back for steering; the server keeps no
  /// session and revalidates it against current access.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  previous_result: Option<serde_json::Value>,
}

impl DraftRequest {
  fn validate(&self) -> Result<(), String> {
    if self.entries.is_empty()
      || self.entries.len() > MAX_ENTRIES
      || self.steer.as_ref().is_some_and(|steer| {
        steer.is_empty() || steer.chars().count() > MAX_STEER_CHARS
      })
      || (self.previous_result.is_some() && self.steer.is_none())
    {
      return Err(FAILURE.to_string());
    }
    Ok(())
  }
}

/// Why a drafting request failed, as the window shows it. The server's
/// refusals the user can act on keep their meaning; anything else is one
/// failure whose cause stays in the local log.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DraftError {
  /// The organization switched AI drafting off.
  Off,
  /// The user has not consented, or withdrew consent, on the server.
  ConsentRequired,
  /// Time entry creation or a selected matter is no longer available.
  Refused,
  /// The firm's guideline files changed between drafting and refining.
  ModeChanged,
  /// The selected entries bring more context than one request may carry.
  TooLarge,
  Failed,
}

/// The server's refusal codes (`DESKTOP_BILLING_DRAFT_REFUSAL_CODE`).
const CODE_OFF: &str = "billing_drafts_off";
const CODE_CONSENT_REQUIRED: &str = "billing_draft_consent_required";

impl DraftError {
  fn from_status(status: u16, code: Option<&str>) -> Self {
    match (status, code) {
      (403, Some(CODE_OFF)) => Self::Off,
      (403, Some(CODE_CONSENT_REQUIRED)) => Self::ConsentRequired,
      (403, _) => Self::Refused,
      (409, _) => Self::ModeChanged,
      (413, _) => Self::TooLarge,
      _ => Self::Failed,
    }
  }
}

impl From<ResponseFailure> for DraftError {
  fn from(failure: ResponseFailure) -> Self {
    match failure {
      ResponseFailure::Status { status, code } => {
        Self::from_status(status, code.as_deref())
      }
      ResponseFailure::Failed => Self::Failed,
    }
  }
}

/// A non-success status with the refusal code its body named, or a failure
/// whose cause is already logged.
enum ResponseFailure {
  Status { status: u16, code: Option<String> },
  Failed,
}

impl From<ResponseFailure> for String {
  fn from(_: ResponseFailure) -> Self {
    FAILURE.to_string()
  }
}

/// One settings change, as the server's settings request union names it.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SettingsUpdate<'a> {
  /// Always accepted, even where drafting is switched off.
  WithdrawConsent,
  GrantConsent {
    revision: Option<&'a str>,
  },
}

fn client(timeout: Duration) -> Result<DesktopHttpClient, String> {
  DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(timeout),
  })
  .map_err(request_cause_logged(FAILURE))
}

/// The webview validates the result against the shared contract; this side
/// only bounds its size and requires JSON.
async fn json_response(
  request: crate::http_client::DeviceProofRequest,
) -> Result<serde_json::Value, ResponseFailure> {
  let failed = |_: String| ResponseFailure::Failed;
  let mut response = request
    .send()
    .await
    .map_err(request_cause_logged(FAILURE))
    .map_err(failed)?;
  if !response.status().is_success() {
    let status = response.status().as_u16();
    // Only the refusal code is read from an error body, and only from a
    // small one; anything else about the failure stays on the server.
    let code = response
      .bytes()
      .await
      .ok()
      .filter(|body| body.len() <= MAX_ERROR_BODY_BYTES)
      .and_then(|body| serde_json::from_slice::<ErrorBody>(&body).ok())
      .and_then(|body| body.code);
    return Err(ResponseFailure::Status { status, code });
  }
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(request_cause_logged(FAILURE))
    .map_err(failed)?
  {
    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err(ResponseFailure::Failed);
    }
    body.extend_from_slice(&chunk);
  }
  serde_json::from_slice(&body)
    .map_err(json_cause_logged(FAILURE))
    .map_err(failed)
}

fn settings_url(account: &AccountRequest) -> String {
  format!(
    "{}/v1/desktop/billing-drafts/settings",
    account.api_base_url
  )
}

pub async fn settings(account: &AccountRequest) -> Result<serde_json::Value, String> {
  Ok(
    json_response(crate::http_client::device_proof_request(
      client(SETTINGS_TIMEOUT)?.get(settings_url(account)),
      &account.device_key,
      Some(&account.credential.key),
      None,
    )?)
    .await?,
  )
}

pub async fn withdraw_consent(
  account: &AccountRequest,
) -> Result<serde_json::Value, String> {
  update_settings(account, &SettingsUpdate::WithdrawConsent).await
}

pub async fn grant_consent(
  account: &AccountRequest,
  revision: Option<&str>,
) -> Result<serde_json::Value, String> {
  update_settings(account, &SettingsUpdate::GrantConsent { revision }).await
}

async fn update_settings(
  account: &AccountRequest,
  update: &SettingsUpdate<'_>,
) -> Result<serde_json::Value, String> {
  Ok(
    json_response(crate::http_client::device_proof_request(
      client(SETTINGS_TIMEOUT)?
        .put(settings_url(account))
        .json(update),
      &account.device_key,
      Some(&account.credential.key),
      None,
    )?)
    .await?,
  )
}

pub async fn draft(
  account: &AccountRequest,
  request: &DraftRequest,
) -> Result<serde_json::Value, DraftError> {
  let failed = |_: String| DraftError::Failed;
  request.validate().map_err(failed)?;
  Ok(
    json_response(
      crate::http_client::device_proof_request(
        client(DRAFT_TIMEOUT)
          .map_err(failed)?
          .post(format!(
            "{}/v1/desktop/billing-drafts",
            account.api_base_url
          ))
          .json(request),
        &account.device_key,
        Some(&account.credential.key),
        None,
      )
      .map_err(failed)?,
    )
    .await?,
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn entry() -> serde_json::Value {
    serde_json::json!({
      "entryId": "entry_1",
      "matterId": "00000000-0000-4000-8000-000000000001",
      "date": "2026-10-24",
      "timezone": "Europe/Prague",
      "durationMinutes": 30,
      "appNames": ["Word"],
    })
  }

  #[test]
  fn draft_request_admits_only_selected_entry_fields() {
    let request: DraftRequest =
      serde_json::from_value(serde_json::json!({ "entries": [entry()] })).unwrap();
    assert!(request.validate().is_ok());
    assert_eq!(
      serde_json::to_value(&request).unwrap(),
      serde_json::json!({ "entries": [entry()] })
    );
    for extra in [
      serde_json::json!({ "windowTitle": "private" }),
      serde_json::json!({ "segments": [] }),
      serde_json::json!({ "clipboard": "private" }),
    ] {
      let mut with_extra = entry();
      with_extra
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
      assert!(
        serde_json::from_value::<DraftRequest>(
          serde_json::json!({ "entries": [with_extra] })
        )
        .is_err()
      );
      let mut top_level = serde_json::json!({ "entries": [entry()] });
      top_level
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
      assert!(serde_json::from_value::<DraftRequest>(top_level).is_err());
    }
  }

  /// The webview builds these requests; the shared fixture keeps both sides
  /// of the invoke boundary on the same field names.
  #[test]
  fn draft_request_fixture_round_trips() {
    let fixture: serde_json::Value =
      serde_json::from_str(include_str!("../../fixtures/billing-draft-request.json"))
        .unwrap();
    let requests = fixture["requests"].as_array().unwrap();
    assert!(!requests.is_empty());
    for expected in requests {
      let request: DraftRequest = serde_json::from_value(expected.clone()).unwrap();
      assert!(request.validate().is_ok());
      assert_eq!(&serde_json::to_value(&request).unwrap(), expected);
    }
  }

  #[test]
  fn draft_request_bounds_entries_and_steering() {
    let request =
      |value: serde_json::Value| serde_json::from_value::<DraftRequest>(value).unwrap();
    assert!(
      request(serde_json::json!({ "entries": [] }))
        .validate()
        .is_err()
    );
    assert!(
      request(serde_json::json!({ "entries": vec![entry(); MAX_ENTRIES + 1] }))
        .validate()
        .is_err()
    );
    assert!(
      request(serde_json::json!({ "entries": [entry()], "steer": "" }))
        .validate()
        .is_err()
    );
    assert!(
      request(serde_json::json!({
        "entries": [entry()],
        "steer": "x".repeat(MAX_STEER_CHARS + 1),
      }))
      .validate()
      .is_err()
    );
    assert!(
      request(serde_json::json!({ "entries": [entry()], "previousResult": {} }))
        .validate()
        .is_err()
    );
    assert!(
      request(serde_json::json!({
        "entries": [entry()],
        "steer": "Shorter",
        "previousResult": {},
      }))
      .validate()
      .is_ok()
    );
  }

  #[test]
  fn limits_match_the_contract() {
    let fixture: serde_json::Value =
      serde_json::from_str(include_str!("../../fixtures/billing-draft-request.json"))
        .unwrap();
    assert_eq!(
      fixture["limits"],
      serde_json::json!({
        "entries": MAX_ENTRIES,
        "steerLength": MAX_STEER_CHARS,
        "matchedEarlierEntries": MAX_MATCHED_EARLIER_ENTRIES,
        "earlierEntryNarrativeLength": MAX_EARLIER_NARRATIVE_UNITS,
      })
    );
  }

  /// The window maps these to its messages; the shared fixture keeps both
  /// sides on the same names.
  #[test]
  fn draft_errors_match_the_fixture() {
    let fixture: serde_json::Value =
      serde_json::from_str(include_str!("../../fixtures/billing-draft-request.json"))
        .unwrap();
    let errors = [
      DraftError::from_status(403, Some(CODE_OFF)),
      DraftError::from_status(403, Some(CODE_CONSENT_REQUIRED)),
      DraftError::from_status(403, None),
      DraftError::from_status(409, None),
      DraftError::from_status(413, None),
      DraftError::from_status(500, Some(CODE_OFF)),
      DraftError::from(ResponseFailure::Failed),
    ];
    assert_eq!(
      serde_json::to_value(&errors[..6]).unwrap(),
      fixture["failures"]
    );
    assert_eq!(errors[6], DraftError::Failed);
  }

  #[test]
  fn settings_updates_send_the_servers_request_union() {
    assert_eq!(
      serde_json::to_value(SettingsUpdate::WithdrawConsent).unwrap(),
      serde_json::json!({ "type": "withdraw_consent" })
    );
    assert_eq!(
      serde_json::to_value(SettingsUpdate::GrantConsent {
        revision: Some("revision")
      })
      .unwrap(),
      serde_json::json!({ "type": "grant_consent", "revision": "revision" })
    );
    assert_eq!(
      serde_json::to_value(SettingsUpdate::GrantConsent { revision: None }).unwrap(),
      serde_json::json!({ "type": "grant_consent", "revision": null })
    );
  }
}
