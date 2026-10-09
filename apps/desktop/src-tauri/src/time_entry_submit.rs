//! Sends only independently confirmed billing fields; no local history is accessible here.
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::{
  account::LinkedAccount,
  http_client::{DesktopHttpClient, HttpClientOptions},
};

const FAILURE: &str = "draft time entry request failed";
const MAX_RESPONSE_BYTES: usize = 32 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedTimeEntry {
  pub workspace_id: String,
  pub date_worked: String,
  pub timezone_id: String,
  pub duration_minutes: u32,
  pub narrative: String,
  pub billable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryBody<'a> {
  date_worked: &'a str,
  timezone_id: &'a str,
  duration_minutes: u32,
  narrative: &'a str,
  billable: bool,
}

#[derive(Deserialize, Serialize)]
pub struct Matter {
  id: String,
  name: String,
  reference: Option<String>,
  color: Option<String>,
}

#[derive(Deserialize)]
struct MattersResponse {
  matters: Vec<Matter>,
}

#[derive(Deserialize)]
pub struct CreatedEntry {
  pub id: String,
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

pub async fn submit(
  account: &LinkedAccount,
  entry: &ConfirmedTimeEntry,
) -> Result<CreatedEntry, String> {
  // A path identifier must never become a route or query fragment.
  if entry.workspace_id.is_empty()
    || !entry
      .workspace_id
      .bytes()
      .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
  {
    return Err(FAILURE.to_string());
  }
  let body = EntryBody {
    date_worked: &entry.date_worked,
    timezone_id: &entry.timezone_id,
    duration_minutes: entry.duration_minutes,
    narrative: &entry.narrative,
    billable: entry.billable,
  };
  let response = response_body(
    client()?
      .put(format!(
        "{}/v1/desktop/time-entries/{}",
        account.api_base_url, entry.workspace_id
      ))
      .bearer_auth(&account.credential.key)
      .json(&body),
  )
  .await?;
  let created: CreatedEntry =
    serde_json::from_slice(&response).map_err(|_| FAILURE.to_string())?;
  if created.id.is_empty() || created.id.len() > 200 {
    return Err(FAILURE.to_string());
  }
  Ok(created)
}

#[cfg(test)]
mod tests {
  use super::*;
  use axum::{Json, Router, http::HeaderMap, routing::put};

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
      "/v1/desktop/time-entries/workspace_fixture",
      put(
        |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
          assert_eq!(headers.get("authorization").unwrap(), "Bearer fixture_key");
          assert_eq!(headers.get("user-agent").unwrap(), "stella-desktop");
          assert_eq!(
            body,
            serde_json::json!({
              "dateWorked": "2026-10-07", "timezoneId": "Europe/Prague",
              "durationMinutes": 12, "narrative": "Confirmed work", "billable": true
            })
          );
          Json(serde_json::json!({"id": "entry_fixture"}))
        },
      ),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let entry: ConfirmedTimeEntry = serde_json::from_value(serde_json::json!({
      "workspaceId": "workspace_fixture", "dateWorked": "2026-10-07", "timezoneId": "Europe/Prague",
      "durationMinutes": 12, "narrative": "Confirmed work", "billable": true
    })).unwrap();
    assert_eq!(submit(&account, &entry).await.unwrap().id, "entry_fixture");
    server.abort();
  }

  #[test]
  fn matter_display_colors_survive_the_native_boundary() {
    for color in [Some("--option-emerald"), Some("#A1B2C3"), None] {
      let input = serde_json::json!({
        "matters": [{"id": "workspace_fixture", "name": "Matter", "reference": null, "color": color}]
      });
      let response: MattersResponse = serde_json::from_value(input.clone()).unwrap();
      assert_eq!(serde_json::to_value(response.matters).unwrap(), input["matters"]);
    }
  }

  #[test]
  fn unknown_confirmation_fields_are_refused() {
    let valid = serde_json::json!({"workspaceId":"w", "dateWorked":"2026-10-07", "timezoneId":"UTC",
      "durationMinutes":6, "narrative":"", "billable":true});
    for forbidden in ["segments", "apps", "summary", "block", "source"] {
      let mut input = valid.clone();
      input[forbidden] = serde_json::json!("unexpected");
      assert!(serde_json::from_value::<ConfirmedTimeEntry>(input).is_err());
    }
  }
}
