use std::time::Duration;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::account::{self, AccountState, LinkedAccount};
use crate::http_client::{DesktopHttpClient, HttpClientOptions};

const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
fn company_format_url(
  web_origin: &str,
  registry: &str,
  id: &str,
) -> Result<String, String> {
  if registry.is_empty() || registry.len() > 64 || id.is_empty() || id.len() > 64 {
    return Err("Invalid company format request".into());
  }
  let mut url =
    reqwest::Url::parse(web_origin).map_err(|_| "Invalid stella web origin")?;
  url
    .path_segments_mut()
    .map_err(|_| "Invalid stella web origin")?
    .extend(["knowledge", "company-formats", registry, id]);
  Ok(url.into())
}

fn require_registry(window: &WebviewWindow) -> Result<(), String> {
  if window.label() != crate::clipboard_window::CLIPBOARD_WINDOW_LABEL {
    return Err("registry command is not available in this window".into());
  }
  Ok(())
}

#[tauri::command]
pub fn registry_copy(
  app: AppHandle,
  window: WebviewWindow,
  text: String,
) -> Result<(), String> {
  require_registry(&window)?;
  if text.is_empty() || text.len() > 32_768 {
    return Err("Registry result is too large to copy".into());
  }
  app
    .clipboard()
    .write_text(text)
    .map_err(|_| "Could not copy registry result")?;
  crate::clipboard_window::hide(&window)
}

pub fn not_connected() -> String {
  "Desktop account is not connected".into()
}

// No caller-supplied URL, method, headers, or generic HTTP command is exposed.
pub(crate) struct RegistryRequestAuth<'a> {
  pub api_base_url: &'a str,
  pub credential_key: &'a str,
}

pub async fn request(
  auth: RegistryRequestAuth<'_>,
  body: serde_json::Value,
) -> Result<serde_json::Value, String> {
  let client = DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(REQUEST_TIMEOUT),
  })
  .map_err(|_| "Registry search is unavailable")?;
  let mut response = client
    .post(format!("{}/v1/desktop-registry/request", auth.api_base_url))
    .bearer_auth(auth.credential_key)
    .json(&body)
    .send()
    .await
    .map_err(|_| "Registry search is unavailable")?;
  if response.status() == reqwest::StatusCode::UNAUTHORIZED {
    return Err(not_connected());
  }
  if !response.status().is_success() {
    return Err("Registry request failed".into());
  }
  let mut bytes = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|_| "Registry response failed")?
  {
    if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err("Registry response is too large".into());
    }
    bytes.extend_from_slice(&chunk);
  }
  serde_json::from_slice(&bytes).map_err(|_| "Registry response is invalid".into())
}

#[tauri::command]
pub async fn registry_open_company_format(
  app: tauri::AppHandle,
  window: WebviewWindow,
  account: State<'_, AccountState>,
  registry: String,
  id: String,
) -> Result<(), String> {
  require_registry(&window)?;
  let web_origin = account::current(&account)
    .await?
    .ok_or_else(not_connected)?
    .web_origin;
  let url = company_format_url(&web_origin, &registry, &id)?;
  app
    .opener()
    .open_url(url, None::<&str>)
    .map_err(|_| "Could not open company specification formats")?;
  crate::clipboard_window::hide(&window)
}

#[tauri::command]
pub async fn registry_get_state(
  app: tauri::AppHandle,
  state: State<'_, AccountState>,
  window: WebviewWindow,
) -> Result<serde_json::Value, String> {
  require_registry(&window)?;
  let Some(saved) = account::current(&state).await? else {
    return Ok(serde_json::json!({"status":"disconnected"}));
  };
  let config =
    match request(saved.request_auth(), serde_json::json!({"type":"config"})).await {
      Ok(config) => config,
      Err(error) if error == not_connected() => {
        account::invalidate(&state, &saved).await?;
        account::notify(&app);
        return Ok(serde_json::json!({"status":"disconnected"}));
      }
      Err(error) => return Err(error),
    };
  let registries = config
    .get("registries")
    .and_then(serde_json::Value::as_array)
    .ok_or("Invalid registry configuration")?;
  let default_registry_id = config
    .get("defaultRegistryId")
    .filter(|value| value.is_null() || value.is_string())
    .ok_or("Invalid registry configuration")?;
  Ok(
    serde_json::json!({"status":"connected", "accountLabel":saved.account.email, "expiresAt":saved.credential.expires_at, "registries":registries, "defaultRegistryId":default_registry_id}),
  )
}

async fn request_current(
  app: &tauri::AppHandle,
  state: &AccountState,
  saved: &LinkedAccount,
  body: serde_json::Value,
) -> Result<serde_json::Value, String> {
  let result = request(saved.request_auth(), body).await;
  if result
    .as_ref()
    .is_err_and(|error| *error == not_connected())
  {
    account::invalidate(state, saved).await?;
    account::notify(app);
  }
  result
}

#[tauri::command]
pub async fn registry_search(
  app: tauri::AppHandle,
  state: State<'_, AccountState>,
  window: WebviewWindow,
  registry: String,
  query: String,
) -> Result<serde_json::Value, String> {
  require_registry(&window)?;
  if registry.len() > 64 || query.trim().is_empty() || query.chars().count() > 256 {
    return Err("Invalid registry search".into());
  }
  let saved = account::current(&state).await?.ok_or_else(not_connected)?;
  request_current(
    &app,
    &state,
    &saved,
    serde_json::json!({"type":"search", "registry":registry, "query":query}),
  )
  .await
}

#[tauri::command]
pub async fn registry_format(
  app: tauri::AppHandle,
  state: State<'_, AccountState>,
  window: WebviewWindow,
  registry: String,
  id: String,
  format_id: Option<String>,
) -> Result<serde_json::Value, String> {
  require_registry(&window)?;
  if registry.len() > 64
    || id.is_empty()
    || id.len() > 64
    || format_id.as_ref().is_some_and(|id| id.len() > 64)
  {
    return Err("Invalid registry format request".into());
  }
  let saved = account::current(&state).await?.ok_or_else(not_connected)?;
  request_current(&app, &state, &saved, serde_json::json!({"type":"format", "registry":registry, "id":id, "formatId":format_id})).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  #[ignore = "requires STELLA_DESKTOP_SMOKE_API_URL; runs in hosted desktop CI"]
  async fn hosted_api_accepts_native_desktop_requests() {
    let saved = LinkedAccount {
      api_base_url: std::env::var("STELLA_DESKTOP_SMOKE_API_URL")
        .expect("set the hosted API origin for the native transport smoke"),
      web_origin: "https://my.stll.app".into(),
      identity: crate::types::DesktopAccountIdentity {
        user_id: "user_fixture".into(),
        organization_id: "org_fixture".into(),
      },
      account: crate::types::LinkedAccountSnapshot {
        email: "desktop-smoke@example.test".into(),
        name: None,
        verified_at: chrono::Utc::now().to_rfc3339(),
      },
      credential: crate::types::DesktopAccountCredential {
        // Intentionally invalid: reaching API authentication is the success
        // signal. This smoke needs no account or credential and changes no data.
        key: "stella_dr_transport_smoke".into(),
        expires_at: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
      },
    };
    assert_eq!(
      request(saved.request_auth(), serde_json::json!({"type":"config"}))
        .await
        .unwrap_err(),
      not_connected(),
      "the native request must reach API authentication rather than fail in transit"
    );
  }

  #[tokio::test]
  async fn registry_requests_identify_the_desktop_at_the_http_boundary() {
    use axum::{Json, Router, http::HeaderMap, routing::post};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new().route(
      "/v1/desktop-registry/request",
      post(
        |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
          assert_eq!(headers.get("user-agent").unwrap(), "stella-desktop");
          assert_eq!(
            headers.get("authorization").unwrap(),
            "Bearer stella_dr_fixture"
          );
          Json(body)
        },
      ),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let saved = LinkedAccount {
      api_base_url: format!("http://{address}"),
      web_origin: "http://localhost:3000".into(),
      identity: crate::types::DesktopAccountIdentity {
        user_id: "user_fixture".into(),
        organization_id: "org_fixture".into(),
      },
      account: crate::types::LinkedAccountSnapshot {
        email: "desktop@example.test".into(),
        name: None,
        verified_at: chrono::Utc::now().to_rfc3339(),
      },
      credential: crate::types::DesktopAccountCredential {
        key: "stella_dr_fixture".into(),
        expires_at: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
      },
    };
    for body in [
      serde_json::json!({"type":"config"}),
      serde_json::json!({"type":"search", "registry":"ares", "query":"fixture"}),
      serde_json::json!({"type":"format", "registry":"ares", "id":"fixture"}),
      serde_json::json!({"type":"revoke"}),
    ] {
      assert_eq!(
        request(saved.request_auth(), body.clone()).await.unwrap(),
        body
      );
    }
    server.abort();
  }

  #[test]
  fn company_format_links_stay_on_the_connected_web_origin() {
    assert_eq!(
      company_format_url("http://localhost:3000", "companies-house", "company / 1")
        .unwrap(),
      "http://localhost:3000/knowledge/company-formats/companies-house/company%20%2F%201"
    );
    for (registry, id) in [("", "company"), ("ares", "")] {
      assert!(company_format_url("https://my.stll.app", registry, id).is_err());
    }
  }
}
