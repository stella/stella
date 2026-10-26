//! Sends only the fields of entries the user selected for AI drafting; no local history is accessible here.
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::{
  account::AccountRequest,
  http_client::{DesktopHttpClient, HttpClientOptions},
  logging::{json_cause_logged, request_cause_logged},
};

const FAILURE: &str = "billing draft request failed";
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_ENTRIES: usize = 20;
const MAX_STEER_CHARS: usize = 2000;
// The server bounds one generation at 60 seconds; waiting longer lets its own
// bounded failure arrive instead of a client timeout.
const DRAFT_TIMEOUT: Duration = Duration::from_secs(75);
const SETTINGS_TIMEOUT: Duration = Duration::from_secs(15);

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

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Consent {
  Granted,
  Revoked,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum SettingsUpdate<'a> {
  Consent(Consent),
  Preference(Option<&'a str>),
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
) -> Result<serde_json::Value, String> {
  let mut response = request
    .send()
    .await
    .map_err(request_cause_logged(FAILURE))?;
  if !response.status().is_success() {
    return Err(FAILURE.to_string());
  }
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(request_cause_logged(FAILURE))?
  {
    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err(FAILURE.to_string());
    }
    body.extend_from_slice(&chunk);
  }
  serde_json::from_slice(&body).map_err(json_cause_logged(FAILURE))
}

fn settings_url(account: &AccountRequest) -> String {
  format!(
    "{}/v1/desktop/billing-drafts/settings",
    account.api_base_url
  )
}

pub async fn settings(account: &AccountRequest) -> Result<serde_json::Value, String> {
  json_response(crate::http_client::device_proof_request(
    client(SETTINGS_TIMEOUT)?.get(settings_url(account)),
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?)
  .await
}

pub async fn set_consent(
  account: &AccountRequest,
  consent: Consent,
) -> Result<serde_json::Value, String> {
  update_settings(account, &SettingsUpdate::Consent(consent)).await
}

pub async fn set_preference(
  account: &AccountRequest,
  preference: Option<&str>,
) -> Result<serde_json::Value, String> {
  if preference
    .is_some_and(|text| text.is_empty() || text.chars().count() > MAX_STEER_CHARS)
  {
    return Err(FAILURE.to_string());
  }
  update_settings(account, &SettingsUpdate::Preference(preference)).await
}

async fn update_settings(
  account: &AccountRequest,
  update: &SettingsUpdate<'_>,
) -> Result<serde_json::Value, String> {
  json_response(crate::http_client::device_proof_request(
    client(SETTINGS_TIMEOUT)?
      .put(settings_url(account))
      .json(update),
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?)
  .await
}

pub async fn draft(
  account: &AccountRequest,
  request: &DraftRequest,
) -> Result<serde_json::Value, String> {
  request.validate()?;
  json_response(crate::http_client::device_proof_request(
    client(DRAFT_TIMEOUT)?
      .post(format!(
        "{}/v1/desktop/billing-drafts",
        account.api_base_url
      ))
      .json(request),
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?)
  .await
}

#[cfg(test)]
mod tests {
  use super::*;

  fn entry() -> serde_json::Value {
    serde_json::json!({
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
  fn settings_updates_send_one_field() {
    assert_eq!(
      serde_json::to_value(SettingsUpdate::Consent(Consent::Granted)).unwrap(),
      serde_json::json!({ "consent": "granted" })
    );
    assert_eq!(
      serde_json::to_value(SettingsUpdate::Preference(None)).unwrap(),
      serde_json::json!({ "preference": null })
    );
    assert_eq!(
      serde_json::to_value(SettingsUpdate::Preference(Some("Shorter"))).unwrap(),
      serde_json::json!({ "preference": "Shorter" })
    );
  }
}
