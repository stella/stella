//! Sends only independently confirmed billing fields; no local history is accessible here.
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::{
  account::AccountRequest,
  http_client::{DesktopHttpClient, HttpClientOptions},
  logging::{
    json_cause_logged, log_json_error, log_request_error, replaced_logged,
    request_cause_logged,
  },
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedEntry {
  pub id: String,
  pub matter_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CreatedBatch {
  pub entries: Vec<CreatedEntry>,
}

fn client() -> Result<DesktopHttpClient, String> {
  DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(Duration::from_secs(15)),
  })
  .map_err(request_cause_logged(FAILURE))
}

async fn response_body(
  request: crate::http_client::DeviceProofRequest,
) -> Result<Vec<u8>, String> {
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
  Ok(body)
}

pub async fn search_matters(
  account: &AccountRequest,
  query: &str,
) -> Result<Vec<Matter>, String> {
  if query.len() > 200 {
    return Err(FAILURE.to_string());
  }
  let body = response_body(crate::http_client::device_proof_request(
    client()?
      .get(format!("{}/v1/desktop/matters", account.api_base_url))
      .query(&[("query", query)]),
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?)
  .await?;
  let response: MattersResponse =
    serde_json::from_slice(&body).map_err(json_cause_logged(FAILURE))?;
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
  account: &AccountRequest,
) -> Result<Vec<MatterCandidate>, String> {
  let body = response_body(crate::http_client::device_proof_request(
    client()?.get(format!(
      "{}/v1/desktop/matter-candidates",
      account.api_base_url
    )),
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?)
  .await?;
  let result: CandidatesResponse =
    serde_json::from_slice(&body).map_err(json_cause_logged(FAILURE))?;
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

// The API contract's narrative limits (`desktop-time-entries.ts`). Its
// lengths count UTF-16 code units, as JavaScript strings do.
const NARRATIVE_MAX_TITLES: usize = 40;
const NARRATIVE_MAX_TITLE_UNITS: usize = 300;
const NARRATIVE_MAX_LOCALE_BYTES: usize = 35;
const NARRATIVE_MAX_MATTER_NAME_UNITS: usize = 200;
const NARRATIVE_MAX_UNITS: usize = 10_000;

/// The longest prefix of `text` that fits `limit` UTF-16 code units, cut on a
/// character boundary.
fn utf16_prefix(text: &str, limit: usize) -> String {
  let mut units = 0;
  text
    .chars()
    .take_while(|character| {
      units += character.len_utf16();
      units <= limit
    })
    .collect()
}

/// A BCP 47 shape: a letter-only language subtag, then 1 to 8 character
/// alphanumeric subtags, all ASCII.
fn well_formed_locale(locale: &str) -> bool {
  !locale.is_empty()
    && locale.len() <= NARRATIVE_MAX_LOCALE_BYTES
    && locale.split('-').all(|subtag| {
      (1..=8).contains(&subtag.len())
        && subtag
          .chars()
          .all(|character| character.is_ascii_alphanumeric())
    })
    && locale.split('-').next().is_some_and(|language| {
      language
        .chars()
        .all(|character| character.is_ascii_alphabetic())
    })
}

/// The titles of one suggestion the user approved for a stella AI
/// description; the server writes the narrative and stores nothing.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeRequest {
  titles: Vec<String>,
  locale: String,
  matter_name: Option<String>,
}

impl NarrativeRequest {
  /// At most 40 non-blank titles cut to the contract's length, a BCP 47
  /// locale (`cs_CZ` becomes `cs-CZ`) and the matter name cut to its
  /// length; no titles or a malformed locale is refused.
  pub fn bounded(
    titles: Vec<String>,
    locale: String,
    matter_name: Option<String>,
  ) -> Result<Self, String> {
    let titles: Vec<String> = titles
      .iter()
      .map(|title| utf16_prefix(title.trim(), NARRATIVE_MAX_TITLE_UNITS))
      .filter(|title| !title.trim().is_empty())
      .take(NARRATIVE_MAX_TITLES)
      .collect();
    let locale = locale.trim().replace('_', "-");
    if titles.is_empty() || !well_formed_locale(&locale) {
      return Err(FAILURE.to_string());
    }
    Ok(Self {
      titles,
      locale,
      matter_name: matter_name
        .map(|name| utf16_prefix(name.trim(), NARRATIVE_MAX_MATTER_NAME_UNITS))
        .filter(|name| !name.is_empty()),
    })
  }
}

#[derive(Deserialize)]
struct NarrativeResponse {
  narrative: String,
}

pub async fn narrative(
  account: &AccountRequest,
  request: &NarrativeRequest,
) -> Result<String, String> {
  let body = response_body(crate::http_client::device_proof_request(
    client()?
      .post(format!(
        "{}/v1/desktop/time-entries/narrative",
        account.api_base_url
      ))
      .json(request),
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?)
  .await?;
  let NarrativeResponse { narrative } =
    serde_json::from_slice(&body).map_err(json_cause_logged(FAILURE))?;
  let narrative = narrative.trim();
  if narrative.is_empty() || narrative.encode_utf16().count() > NARRATIVE_MAX_UNITS {
    return Err(FAILURE.to_string());
  }
  Ok(narrative.to_string())
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
enum AttemptFailure {
  Rejected,
  Uncertain,
}

async fn submit_batch(
  account: &AccountRequest,
  batch: &ConfirmedBatch,
) -> Result<CreatedBatch, AttemptFailure> {
  batch
    .validate()
    .map_err(replaced_logged(FAILURE, AttemptFailure::Rejected))?;
  let request = client()
    .map_err(replaced_logged(FAILURE, AttemptFailure::Rejected))?
    .put(format!(
      "{}/v1/desktop/time-entries/batch",
      account.api_base_url
    ))
    .json(batch);
  let mut response = crate::http_client::device_proof_request(
    request,
    &account.device_key,
    Some(&account.credential.key),
    None,
  )
  .map_err(replaced_logged(FAILURE, AttemptFailure::Rejected))?
  .send()
  .await
  .map_err(|error| {
    log_request_error(&error, FAILURE);
    AttemptFailure::Uncertain
  })?;
  if !response.status().is_success() {
    // Client rejection still needs ledger recovery: an earlier attempt may
    // have committed even when this retry cannot be accepted.
    return Err(
      if response.status().is_client_error() && response.status().as_u16() != 408 {
        AttemptFailure::Rejected
      } else {
        AttemptFailure::Uncertain
      },
    );
  }
  let mut body = Vec::new();
  while let Some(chunk) = response.chunk().await.map_err(|error| {
    log_request_error(&error, FAILURE);
    AttemptFailure::Uncertain
  })? {
    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err(AttemptFailure::Uncertain);
    }
    body.extend_from_slice(&chunk);
  }
  let created: CreatedBatch = serde_json::from_slice(&body).map_err(|error| {
    log_json_error(&error, FAILURE);
    AttemptFailure::Uncertain
  })?;
  validate_created_batch(created, batch)
}

fn validate_created_batch(
  created: CreatedBatch,
  batch: &ConfirmedBatch,
) -> Result<CreatedBatch, AttemptFailure> {
  if created.entries.len() != batch.entries.len()
    || created
      .entries
      .iter()
      .zip(&batch.entries)
      .any(|(created, confirmed)| {
        created.id.is_empty()
          || created.id.len() > 200
          || !created.matter_id.eq_ignore_ascii_case(&confirmed.matter_id)
      })
  {
    return Err(AttemptFailure::Uncertain);
  }
  Ok(created)
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum BatchStatus {
  Committed { entries: Vec<CreatedEntry> },
  Cancelled,
}

#[derive(Debug)]
pub enum SubmitFailure {
  Cancelled,
  Uncertain,
}

pub async fn submit_batch_with_recovery(
  account: &AccountRequest,
  batch: &ConfirmedBatch,
) -> Result<CreatedBatch, SubmitFailure> {
  match submit_batch(account, batch).await {
    Err(AttemptFailure::Rejected) => {
      let body = response_body(
        crate::http_client::device_proof_request(
          client()
            .map_err(replaced_logged(FAILURE, SubmitFailure::Uncertain))?
            .put(format!(
              "{}/v1/desktop/time-entries/batch/status",
              account.api_base_url
            ))
            .json(&serde_json::json!({ "idempotencyKey": batch.idempotency_key })),
          &account.device_key,
          Some(&account.credential.key),
          None,
        )
        .map_err(replaced_logged(FAILURE, SubmitFailure::Uncertain))?,
      )
      .await
      .map_err(replaced_logged(FAILURE, SubmitFailure::Uncertain))?;
      let status: BatchStatus = serde_json::from_slice(&body).map_err(|error| {
        log_json_error(&error, FAILURE);
        SubmitFailure::Uncertain
      })?;
      match status {
        BatchStatus::Committed { entries } => {
          validate_created_batch(CreatedBatch { entries }, batch).map_err(|failure| {
            tracing::warn!(?failure, "recovered time entry batch does not match");
            SubmitFailure::Uncertain
          })
        }
        BatchStatus::Cancelled => Err(SubmitFailure::Cancelled),
      }
    }
    Ok(created) => Ok(created),
    Err(AttemptFailure::Uncertain) => Err(SubmitFailure::Uncertain),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use axum::{Json, Router, http::HeaderMap, routing::put};

  async fn fixture(api_base_url: String) -> AccountRequest {
    let account = serde_json::from_value(serde_json::json!({
      "apiBaseUrl": api_base_url,
      "webOrigin": "https://example.test",
      "account": {"email": "fixture@example.test", "name": null, "verifiedAt": "2026-01-01T00:00:00Z"},
      "identity": {"userId": "user_fixture", "organizationId": "org_fixture"},
      "credential": {"key": "fixture_key", "expiresAt": "2099-01-01T00:00:00Z"}
    })).unwrap();
    AccountRequest::fixture(account).await
  }

  #[tokio::test]
  async fn matter_lookups_sign_the_final_request_with_the_account_device() {
    use axum::{extract::OriginalUri, routing::get};
    use std::sync::{
      Arc,
      atomic::{AtomicUsize, Ordering},
    };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let account = fixture(format!("http://{}", listener.local_addr().unwrap())).await;
    let thumbprint = account.device_key.thumbprint().unwrap();
    let base = account.api_base_url.clone();
    let requests = Arc::new(AtomicUsize::new(0));
    let received = Arc::clone(&requests);
    let router = Router::new().route(
      "/v1/desktop/{*path}",
      get(move |OriginalUri(uri): OriginalUri, headers: HeaderMap| {
        let mut request = reqwest::Request::new(
          reqwest::Method::GET,
          format!("{base}{uri}").parse().unwrap(),
        );
        *request.headers_mut() = headers;
        crate::device_proof::tests::verify_request(
          &request,
          &thumbprint,
          Some("fixture_key"),
          None,
        );
        match uri.path() {
          "/v1/desktop/matters" => assert_eq!(uri.query(), Some("query=A%2F101")),
          "/v1/desktop/matter-candidates" => assert_eq!(uri.query(), None),
          _ => panic!("Unexpected matter lookup route"),
        }
        received.fetch_add(1, Ordering::SeqCst);
        async { Json(serde_json::json!({"matters": []})) }
      }),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    assert!(search_matters(&account, "A/101").await.unwrap().is_empty());
    assert!(candidates(&account).await.unwrap().is_empty());
    drop(account);
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    server.abort();
  }

  #[test]
  fn narrative_requests_bound_titles_and_refuse_malformed_fields() {
    let long = "\u{1F600}".repeat(NARRATIVE_MAX_TITLE_UNITS);
    let titles = std::iter::once("  ".to_string())
      .chain(std::iter::once(long))
      .chain((0..60).map(|index| format!("Draft {index}")))
      .collect();
    let request = NarrativeRequest::bounded(
      titles,
      "cs_CZ".into(),
      Some("m".repeat(NARRATIVE_MAX_MATTER_NAME_UNITS + 50)),
    )
    .unwrap();
    assert_eq!(request.titles.len(), NARRATIVE_MAX_TITLES);
    assert!(request.titles.iter().all(|title| {
      !title.trim().is_empty()
        && title.encode_utf16().count() <= NARRATIVE_MAX_TITLE_UNITS
    }));
    // A surrogate pair is never split: 150 emoji fill 300 code units.
    assert_eq!(
      request.titles.first().map(|title| title.chars().count()),
      Some(NARRATIVE_MAX_TITLE_UNITS / 2)
    );
    assert_eq!(request.locale, "cs-CZ");
    assert_eq!(
      request.matter_name.as_ref().map(String::len),
      Some(NARRATIVE_MAX_MATTER_NAME_UNITS)
    );
    for (titles, locale) in [
      (vec![], "en"),
      (vec![" ".to_string()], "en"),
      (vec!["Draft".to_string()], ""),
      (vec!["Draft".to_string()], "en US"),
      (vec!["Draft".to_string()], "en--US"),
      (vec!["Draft".to_string()], "12-US"),
      (vec!["Draft".to_string()], "toolongsubtag-x"),
      (
        vec!["Draft".to_string()],
        "en-a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q",
      ),
    ] {
      assert!(NarrativeRequest::bounded(titles, locale.to_string(), None).is_err());
    }
  }

  #[tokio::test]
  async fn narrative_request_sends_only_titles_locale_and_matter_name() {
    use axum::routing::post;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let account = fixture(format!("http://{}", listener.local_addr().unwrap())).await;
    let router = Router::new().route(
      "/v1/desktop/time-entries/narrative",
      post(
        |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
          assert_eq!(headers.get("authorization").unwrap(), "Bearer fixture_key");
          assert_eq!(
            body,
            serde_json::json!({
              "titles": ["Lease draft.docx"], "locale": "en", "matterName": null
            })
          );
          Json(serde_json::json!({"narrative": "  Revised the lease draft.  "}))
        },
      ),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let request =
      NarrativeRequest::bounded(vec!["Lease draft.docx".into()], "en".into(), None)
        .unwrap();
    assert_eq!(
      narrative(&account, &request).await.unwrap(),
      "Revised the lease draft."
    );
    server.abort();
  }

  #[tokio::test]
  async fn narrative_refusals_and_empty_answers_keep_the_template() {
    use axum::{http::StatusCode, routing::post};

    for (status, body) in [
      (
        StatusCode::BAD_GATEWAY,
        serde_json::json!({"error": "Narrative generation failed", "code": "ai_unavailable"}),
      ),
      (StatusCode::TOO_MANY_REQUESTS, serde_json::json!({})),
      (StatusCode::FORBIDDEN, serde_json::json!({})),
      (StatusCode::OK, serde_json::json!({"narrative": "  "})),
    ] {
      let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
      let account = fixture(format!("http://{}", listener.local_addr().unwrap())).await;
      let router = Router::new().route(
        "/v1/desktop/time-entries/narrative",
        post(move || {
          let body = body.clone();
          async move { (status, Json(body)) }
        }),
      );
      let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
      });
      let request =
        NarrativeRequest::bounded(vec!["Lease draft.docx".into()], "en".into(), None)
          .unwrap();
      assert!(narrative(&account, &request).await.is_err(), "{status}");
      server.abort();
    }
  }

  #[tokio::test]
  async fn outbound_request_contains_only_confirmed_fields_and_credential() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let account = fixture(format!("http://{}", listener.local_addr().unwrap())).await;
    let thumbprint = account.device_key.thumbprint().unwrap();
    let url = format!("{}/v1/desktop/time-entries/batch", account.api_base_url);
    let router = Router::new().route(
      "/v1/desktop/time-entries/batch",
      put(
        move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
          let thumbprint = thumbprint.clone();
          let url = url.clone();
          async move {
          let mut request = reqwest::Request::new(reqwest::Method::PUT, url.parse().unwrap());
          *request.headers_mut() = headers.clone();
          crate::device_proof::tests::verify_request(
            &request,
            &thumbprint,
            Some("fixture_key"),
            None,
          );
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
          }
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
    drop(account);
    server.abort();
  }

  #[tokio::test]
  async fn uncertain_attempt_then_rejection_recovers_only_an_authoritative_outcome() {
    use axum::http::StatusCode;
    use std::{
      collections::HashSet,
      sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
      },
    };
    for status in ["cancelled", "committed", "unavailable"] {
      let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
      let account = fixture(format!("http://{}", listener.local_addr().unwrap())).await;
      let attempts = Arc::new(AtomicUsize::new(0));
      let submissions = Arc::clone(&attempts);
      let recoveries = Arc::new(AtomicUsize::new(0));
      let status_requests = Arc::clone(&recoveries);
      let proofs = Arc::new(Mutex::new(HashSet::new()));
      let submission_proofs = Arc::clone(&proofs);
      let recovery_proofs = Arc::clone(&proofs);
      let submission_thumbprint = account.device_key.thumbprint().unwrap();
      let recovery_thumbprint = submission_thumbprint.clone();
      let submission_url =
        format!("{}/v1/desktop/time-entries/batch", account.api_base_url);
      let recovery_url = format!(
        "{}/v1/desktop/time-entries/batch/status",
        account.api_base_url
      );
      let router = Router::new()
        .route("/v1/desktop/time-entries/batch", put(move |headers: HeaderMap| {
          let mut request = reqwest::Request::new(reqwest::Method::PUT, submission_url.parse().unwrap());
          *request.headers_mut() = headers;
          let claims = crate::device_proof::tests::verify_request(
            &request, &submission_thumbprint, Some("fixture_key"), None,
          );
          assert!(submission_proofs.lock().unwrap().insert(claims["jti"].as_str().unwrap().to_string()));
          let attempt = submissions.fetch_add(1, Ordering::SeqCst);
          async move { if attempt == 0 { StatusCode::SERVICE_UNAVAILABLE } else { StatusCode::UNPROCESSABLE_ENTITY } }
        }))
        .route("/v1/desktop/time-entries/batch/status", put(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
          let mut request = reqwest::Request::new(reqwest::Method::PUT, recovery_url.parse().unwrap());
          *request.headers_mut() = headers.clone();
          let claims = crate::device_proof::tests::verify_request(
            &request, &recovery_thumbprint, Some("fixture_key"), None,
          );
          assert!(recovery_proofs.lock().unwrap().insert(claims["jti"].as_str().unwrap().to_string()));
          status_requests.fetch_add(1, Ordering::SeqCst);
          async move {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer fixture_key");
            assert_eq!(body, serde_json::json!({"idempotencyKey": "retry_fixture"}));
            match status {
              "cancelled" => (StatusCode::OK, Json(serde_json::json!({"type": "cancelled"}))),
              "committed" => (StatusCode::OK, Json(serde_json::json!({"type": "committed", "entries": [{"id": "original_entry", "matterId": "workspace_fixture"}]}))),
              _ => (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({}))),
            }
          }
        }));
      let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
      });
      let batch: ConfirmedBatch = serde_json::from_value(serde_json::json!({
        "idempotencyKey": "retry_fixture", "entries": [{"matterId": "workspace_fixture", "dateWorked": "2026-10-07", "timezoneId": "UTC", "durationMinutes": 6, "narrative": "Confirmed work", "billable": false}]
      })).unwrap();
      assert!(matches!(
        submit_batch_with_recovery(&account, &batch).await,
        Err(SubmitFailure::Uncertain)
      ));
      assert_eq!(recoveries.load(Ordering::SeqCst), 0);
      let outcome = submit_batch_with_recovery(&account, &batch).await;
      drop(account);
      match status {
        "cancelled" => assert!(matches!(outcome, Err(SubmitFailure::Cancelled))),
        "committed" => assert_eq!(outcome.unwrap().entries[0].id, "original_entry"),
        _ => assert!(matches!(outcome, Err(SubmitFailure::Uncertain))),
      }
      assert_eq!(attempts.load(Ordering::SeqCst), 2);
      assert_eq!(recoveries.load(Ordering::SeqCst), 1);
      assert_eq!(proofs.lock().unwrap().len(), 3);
      server.abort();
    }
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
