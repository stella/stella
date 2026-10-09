//! Sends only independently confirmed billing fields; no local history is accessible here.
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::{
  account::LinkedAccount,
  http_client::{DesktopHttpClient, HttpClientOptions},
};

const FAILURE: &str = "draft time entry request failed";
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedTimeEntry {
  pub matter_id: String,
  pub date_worked: String,
  pub timezone_id: String,
  pub duration_minutes: u32,
  pub narrative: String,
  pub billable: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedBatch {
  pub idempotency_key: String,
  pub entries: Vec<ConfirmedTimeEntry>,
}

#[derive(Deserialize, Serialize)]
pub struct Matter {
  pub id: String,
  name: String,
  reference: Option<String>,
  color: Option<String>,
}

#[derive(Deserialize)]
struct MattersResponse {
  matters: Vec<Matter>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSignals {
  last_worked_at: Option<String>,
  newly_assigned_at: Option<String>,
  upcoming_deadline: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatterCandidate {
  #[serde(flatten)]
  matter: Matter,
  client_name: Option<String>,
  signals: CandidateSignals,
}

#[derive(Deserialize)]
struct CandidatesResponse {
  matters: Vec<MatterCandidate>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedEntry {
  pub id: String,
  pub matter_id: String,
}

#[derive(Deserialize, Serialize)]
pub struct CreatedBatch {
  pub entries: Vec<CreatedEntry>,
}

fn client() -> Result<DesktopHttpClient, String> {
  DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(Duration::from_secs(15)),
  })
  .map_err(|_| FAILURE.to_string())
}

async fn response_body(request: reqwest::RequestBuilder) -> Result<Vec<u8>, String> {
  let mut response = request.send().await.map_err(|_| FAILURE.to_string())?;
  if !response.status().is_success() {
    return Err(FAILURE.to_string());
  }
  let mut body = Vec::new();
  while let Some(chunk) = response.chunk().await.map_err(|_| FAILURE.to_string())? {
    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err(FAILURE.to_string());
    }
    body.extend_from_slice(&chunk);
  }
  Ok(body)
}

pub async fn search_matters(
  account: &LinkedAccount,
  query: &str,
) -> Result<Vec<Matter>, String> {
  if query.len() > 200 {
    return Err(FAILURE.to_string());
  }
  let body = response_body(
    client()?
      .get(format!("{}/v1/desktop/matters", account.api_base_url))
      .bearer_auth(&account.credential.key)
      .query(&[("query", query)]),
  )
  .await?;
  let response: MattersResponse =
    serde_json::from_slice(&body).map_err(|_| FAILURE.to_string())?;
  if response.matters.len() > 20
    || response.matters.iter().any(|matter| {
      matter.id.is_empty()
        || matter.id.len() > 200
        || matter.name.len() > 1024
        || matter
          .reference
          .as_ref()
          .is_some_and(|reference| reference.len() > 256)
    })
  {
    return Err(FAILURE.to_string());
  }
  Ok(response.matters)
}

pub async fn candidates(
  account: &LinkedAccount,
) -> Result<Vec<MatterCandidate>, String> {
  let body = response_body(
    client()?
      .get(format!(
        "{}/v1/desktop/matter-candidates",
        account.api_base_url
      ))
      .bearer_auth(&account.credential.key),
  )
  .await?;
  let result: CandidatesResponse =
    serde_json::from_slice(&body).map_err(|_| FAILURE.to_string())?;
  if result.matters.len() > 100
    || result.matters.iter().any(|candidate| {
      candidate.matter.id.is_empty()
        || candidate.matter.id.len() > 200
        || candidate.matter.name.len() > 1024
        || candidate
          .client_name
          .as_ref()
          .is_some_and(|name| name.len() > 1024)
    })
  {
    return Err(FAILURE.to_string());
  }
  Ok(result.matters)
}

impl ConfirmedBatch {
  pub fn validate(&self) -> Result<(), String> {
    if self.idempotency_key.is_empty()
      || self.idempotency_key.len() > 128
      || self.entries.is_empty()
      || self.entries.len() > 100
      || self.entries.iter().any(|entry| {
        entry.matter_id.is_empty()
          || entry.matter_id.len() > 128
          || entry.date_worked.len() != 10
          || entry.timezone_id.is_empty()
          || entry.timezone_id.len() > 64
          || entry.duration_minutes == 0
          || entry.duration_minutes > 1440
          || entry.narrative.len() > 40000
      })
    {
      return Err(FAILURE.to_string());
    }
    Ok(())
  }
}

#[derive(Debug)]
pub enum SubmitFailure {
  Rejected,
  Uncertain,
}

pub async fn submit_batch(
  account: &LinkedAccount,
  batch: &ConfirmedBatch,
) -> Result<CreatedBatch, SubmitFailure> {
  batch.validate().map_err(|_| SubmitFailure::Rejected)?;
  let mut response = client()
    .map_err(|_| SubmitFailure::Rejected)?
    .put(format!(
      "{}/v1/desktop/time-entries/batch",
      account.api_base_url
    ))
    .bearer_auth(&account.credential.key)
    .json(batch)
    .send()
    .await
    .map_err(|_| SubmitFailure::Uncertain)?;
  if !response.status().is_success() {
    // A conflict or timeout can follow a committed earlier request; retain its
    // durable key. Other client errors are definitive only on the first attempt.
    return Err(
      if response.status().is_client_error()
        && response.status().as_u16() != 409
        && response.status().as_u16() != 408
      {
        SubmitFailure::Rejected
      } else {
        SubmitFailure::Uncertain
      },
    );
  }
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|_| SubmitFailure::Uncertain)?
  {
    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err(SubmitFailure::Uncertain);
    }
    body.extend_from_slice(&chunk);
  }
  let created: CreatedBatch =
    serde_json::from_slice(&body).map_err(|_| SubmitFailure::Uncertain)?;
  if created.entries.len() != batch.entries.len()
    || created
      .entries
      .iter()
      .zip(&batch.entries)
      .any(|(created, confirmed)| {
        created.id.is_empty()
          || created.id.len() > 200
          || created.matter_id != confirmed.matter_id
      })
  {
    return Err(SubmitFailure::Uncertain);
  }
  Ok(created)
}

#[cfg(test)]
mod tests {
  use super::*;
  use axum::{http::HeaderMap, routing::put, Json, Router};

  fn fixture(api_base_url: String) -> LinkedAccount {
    serde_json::from_value(serde_json::json!({
      "apiBaseUrl": api_base_url,
      "webOrigin": "https://example.test",
      "account": {"email": "fixture@example.test", "name": null, "verifiedAt": "2026-01-01T00:00:00Z"},
      "identity": {"userId": "user_fixture", "organizationId": "org_fixture"},
      "credential": {"key": "fixture_key", "expiresAt": "2099-01-01T00:00:00Z"}
    })).unwrap()
  }

  #[tokio::test]
  async fn outbound_request_contains_only_confirmed_fields_and_credential() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let account = fixture(format!("http://{}", listener.local_addr().unwrap()));
    let router = Router::new().route(
      "/v1/desktop/time-entries/batch",
      put(
        |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
          assert_eq!(headers.get("authorization").unwrap(), "Bearer fixture_key");
          assert_eq!(headers.get("user-agent").unwrap(), "stella-desktop");
          assert_eq!(
            body,
            serde_json::json!({
              "idempotencyKey": "batch_fixture", "entries": [{"matterId": "workspace_fixture", "dateWorked": "2026-10-07", "timezoneId": "Europe/Prague",
              "durationMinutes": 12, "narrative": "Confirmed work", "billable": true}]
            })
          );
          Json(serde_json::json!({"entries": [{"id": "entry_fixture", "matterId": "workspace_fixture"}]}))
        },
      ),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let entry: ConfirmedTimeEntry = serde_json::from_value(serde_json::json!({
      "matterId": "workspace_fixture", "dateWorked": "2026-10-07", "timezoneId": "Europe/Prague",
      "durationMinutes": 12, "narrative": "Confirmed work", "billable": true
    })).unwrap();
    let batch = ConfirmedBatch {
      idempotency_key: "batch_fixture".into(),
      entries: vec![entry],
    };
    assert_eq!(
      submit_batch(&account, &batch).await.unwrap().entries[0].id,
      "entry_fixture"
    );
    server.abort();
  }

  #[test]
  fn matter_display_colors_survive_the_native_boundary() {
    for color in [Some("--option-emerald"), Some("#A1B2C3"), None] {
      let input = serde_json::json!({
        "matters": [{"id": "workspace_fixture", "name": "Matter", "reference": null, "color": color}]
      });
      let response: MattersResponse = serde_json::from_value(input.clone()).unwrap();
      assert_eq!(
        serde_json::to_value(response.matters).unwrap(),
        input["matters"]
      );
    }
  }

  #[test]
  fn unknown_confirmation_fields_are_refused() {
    let valid = serde_json::json!({"matterId":"w", "dateWorked":"2026-10-07", "timezoneId":"UTC",
      "durationMinutes":6, "narrative":"", "billable":true});
    for forbidden in ["segments", "apps", "summary", "block", "source"] {
      let mut input = valid.clone();
      input[forbidden] = serde_json::json!("unexpected");
      assert!(serde_json::from_value::<ConfirmedTimeEntry>(input).is_err());
    }
  }
}
