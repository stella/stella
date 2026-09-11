use serde::{Deserialize, Serialize};
use std::{
  sync::Arc,
  time::{Duration, Instant},
};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

use crate::commands::AppState;

/// Emitted app-wide once a browser handoff has stored a registry credential.
/// The clipboard panel never activates on a handoff, so it cannot rely on a
/// focus event to notice the new connection.
pub const CONNECTION_CHANGED_EVENT: &str = "registry-connection-changed";

const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(300);

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

pub type RegistryState = Arc<Mutex<RegistryConnection>>;

#[derive(Default)]
pub struct RegistryConnection {
  pending: Option<PendingConnection>,
}

impl RegistryConnection {
  fn claim(&mut self, origin: &str, nonce: &str) -> Result<(), String> {
    let Some(pending) = self.pending.as_ref() else {
      return Err("No registry connection is pending".into());
    };
    if pending.nonce != nonce
      || pending.web_origin != origin
      || pending.started.elapsed() > CONNECTION_TIMEOUT
    {
      return Err("Registry connection has expired".into());
    }
    self.pending = None;
    Ok(())
  }
}

struct PendingConnection {
  nonce: String,
  web_origin: String,
  started: Instant,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credential {
  api_base_url: String,
  key: String,
  expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryHandoff {
  pub api_base_url: String,
  nonce: String,
  key: String,
  expires_at: String,
}

fn not_connected() -> String {
  "Registry search is not connected".into()
}

#[tauri::command]
pub async fn registry_disconnect(window: WebviewWindow) -> Result<(), String> {
  require_registry(&window)?;
  if let Some(saved) = credential().await? {
    match request(&saved, serde_json::json!({"type":"revoke"})).await {
      Ok(_) => {}
      Err(error) if error == not_connected() => {}
      Err(error) => return Err(error),
    }
  }
  crate::keychain::delete_registry_credential().await
}

fn is_live_expiry(value: &str) -> bool {
  chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|expires| {
    let remaining = expires
      .signed_duration_since(chrono::Utc::now())
      .num_seconds();
    remaining > 0 && remaining <= 3600
  })
}

async fn credential() -> Result<Option<Credential>, String> {
  let serialized = crate::keychain::get_registry_credential().await?;
  let Some(serialized) = serialized else {
    return Ok(None);
  };
  let saved: Credential =
    serde_json::from_str(&serialized).map_err(|_| not_connected())?;
  if !is_live_expiry(&saved.expires_at) {
    return Ok(None);
  }
  crate::config::normalize_self_host_api_base_url(&saved.api_base_url)?;
  Ok(Some(saved))
}

// No caller-supplied URL, method, headers, or generic HTTP command is exposed.
async fn request(
  saved: &Credential,
  body: serde_json::Value,
) -> Result<serde_json::Value, String> {
  let client = reqwest::Client::builder()
    .redirect(reqwest::redirect::Policy::none())
    .timeout(REQUEST_TIMEOUT)
    .build()
    .map_err(|_| "Registry search is unavailable")?;
  let mut response = client
    .post(format!(
      "{}/v1/desktop-registry/request",
      saved.api_base_url
    ))
    .bearer_auth(&saved.key)
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

pub async fn accept_handoff(
  state: &RegistryState,
  origin: &str,
  handoff: RegistryHandoff,
) -> Result<(), String> {
  let api_base_url =
    crate::config::normalize_self_host_api_base_url(&handoff.api_base_url)?;
  if !handoff.key.starts_with("stella_dr_")
    || handoff.key.len() > 256
    || !is_live_expiry(&handoff.expires_at)
  {
    return Err("Invalid registry connection".into());
  }
  let mut connection = state.lock().await;
  // Claim once before I/O: concurrent browser replies cannot overwrite a grant.
  connection.claim(origin, &handoff.nonce)?;
  let saved = Credential {
    api_base_url,
    key: handoff.key,
    expires_at: handoff.expires_at,
  };
  request(&saved, serde_json::json!({"type": "config"})).await?;
  let serialized =
    serde_json::to_string(&saved).map_err(|_| "Could not save registry connection")?;
  crate::keychain::store_registry_credential(serialized).await
}

#[tauri::command]
pub async fn registry_connect(
  app: tauri::AppHandle,
  window: WebviewWindow,
  state: State<'_, RegistryState>,
  account: State<'_, AppState>,
) -> Result<(), String> {
  require_registry(&window)?;
  let web_origin = {
    let manager = account.lock().await;
    manager
      .linked_self_host_origin()
      .unwrap_or_else(|| {
        if cfg!(debug_assertions) {
          option_env!("STELLA_DESKTOP_REGISTRY_WEB_ORIGIN")
            .unwrap_or("https://my.stll.app")
        } else {
          "https://my.stll.app"
        }
      })
      .to_string()
  };
  let web_origin = crate::config::normalize_self_host_web_origin(&web_origin)?;
  let nonce = uuid::Uuid::new_v4().to_string();
  state.lock().await.pending = Some(PendingConnection {
    nonce: nonce.clone(),
    web_origin: web_origin.clone(),
    started: Instant::now(),
  });
  app
    .opener()
    .open_url(
      format!("{web_origin}/settings/account/desktop#desktop-registry={nonce}"),
      None::<&str>,
    )
    .map_err(|_| "Could not open account connection".into())
}

#[tauri::command]
pub async fn registry_get_state(
  window: WebviewWindow,
) -> Result<serde_json::Value, String> {
  require_registry(&window)?;
  let Some(saved) = credential().await? else {
    return Ok(serde_json::json!({"status":"disconnected"}));
  };
  let config = request(&saved, serde_json::json!({"type":"config"})).await?;
  let registries = config
    .get("registries")
    .and_then(serde_json::Value::as_array)
    .ok_or("Invalid registry configuration")?;
  let default_registry_id = config
    .get("defaultRegistryId")
    .filter(|value| value.is_null() || value.is_string())
    .ok_or("Invalid registry configuration")?;
  Ok(
    serde_json::json!({"status":"connected", "accountLabel":saved.api_base_url, "registries":registries, "defaultRegistryId":default_registry_id}),
  )
}

#[tauri::command]
pub async fn registry_search(
  window: WebviewWindow,
  registry: String,
  query: String,
) -> Result<serde_json::Value, String> {
  require_registry(&window)?;
  if registry.len() > 64 || query.trim().is_empty() || query.chars().count() > 256 {
    return Err("Invalid registry search".into());
  }
  let saved = credential().await?.ok_or_else(not_connected)?;
  request(
    &saved,
    serde_json::json!({"type":"search", "registry":registry, "query":query}),
  )
  .await
}

#[tauri::command]
pub async fn registry_format(
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
  let saved = credential().await?.ok_or_else(not_connected)?;
  request(&saved, serde_json::json!({"type":"format", "registry":registry, "id":id, "formatId":format_id})).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn registry_handoffs_are_origin_bound_expiring_and_single_use() {
    for origin in ["https://my.stll.app", "https://other.example"] {
      for nonce in ["expected", "wrong", ""] {
        for age in [Duration::ZERO, CONNECTION_TIMEOUT + Duration::from_secs(1)] {
          let mut connection = RegistryConnection {
            pending: Some(PendingConnection {
              nonce: "expected".into(),
              web_origin: "https://my.stll.app".into(),
              started: Instant::now() - age,
            }),
          };
          let expected = origin == "https://my.stll.app"
            && nonce == "expected"
            && age == Duration::ZERO;
          assert_eq!(connection.claim(origin, nonce).is_ok(), expected);
          if expected {
            assert!(connection.claim(origin, nonce).is_err());
          }
        }
      }
    }
    assert!(
      RegistryConnection::default()
        .claim("https://my.stll.app", "expected")
        .is_err()
    );
  }

  #[test]
  fn registry_handoffs_reject_extra_payloads_and_unbounded_lifetimes() {
    let now = chrono::Utc::now();
    for seconds in [-60, 0, 30, 3600, 7200] {
      let expiry = (now + chrono::Duration::seconds(seconds)).to_rfc3339();
      assert_eq!(is_live_expiry(&expiry), seconds > 0 && seconds <= 3600);
    }
    assert!(!is_live_expiry("invalid"));
    let mut payload = serde_json::json!({ "apiBaseUrl":"https://api.stll.app", "nonce":"expected", "key":"stella_dr_fixture", "expiresAt":now.to_rfc3339() });
    assert!(serde_json::from_value::<RegistryHandoff>(payload.clone()).is_ok());
    payload["clipboard"] = serde_json::json!("must stay local");
    assert!(serde_json::from_value::<RegistryHandoff>(payload).is_err());
  }
}
