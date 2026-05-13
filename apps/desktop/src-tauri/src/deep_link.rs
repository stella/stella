use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::session_manager::{
  download_docx_standalone, normalize_api_base_url, SessionManager,
};
use crate::types::{is_safe_session_id, ErrorResponse, OpenDocxRequest};

const REDEEM_TIMEOUT: Duration = Duration::from_secs(20);
const ACKNOWLEDGE_TIMEOUT: Duration = Duration::from_secs(10);
const HANDOFF_TOKEN_LENGTH: usize = 64;

#[derive(Debug, PartialEq, Eq)]
enum DeepLinkAction {
  Ping,
  OpenDesktopEdit {
    api_base_url: String,
    handoff_token: String,
  },
}

fn is_safe_handoff_token(value: &str) -> bool {
  value.len() == HANDOFF_TOKEN_LENGTH && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn normalize_and_validate_api_base_url(value: &str) -> Result<String, String> {
  let normalized = normalize_api_base_url(value);
  let parsed = reqwest::Url::parse(&normalized)
    .map_err(|_| "Invalid desktop edit API URL.".to_string())?;

  let is_loopback = parsed.host_str().is_some_and(|host| {
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
  });

  if parsed.scheme() == "https" || (parsed.scheme() == "http" && is_loopback) {
    return Ok(normalized);
  }

  Err("Desktop edit API URL must use HTTPS.".to_string())
}

fn parse_deep_link(raw_url: &str) -> Option<DeepLinkAction> {
  let url = reqwest::Url::parse(raw_url).ok()?;
  if url.scheme() != "stella" {
    return None;
  }

  if url.host_str() == Some("ping") {
    return Some(DeepLinkAction::Ping);
  }

  if url.host_str() != Some("desktop-edit") || url.path() != "/open" {
    return None;
  }

  let mut handoff_token = None;
  let mut api_base_url = None;

  for (key, value) in url.query_pairs() {
    match key.as_ref() {
      "handoff" => handoff_token = Some(value.into_owned()),
      "apiBaseUrl" => api_base_url = Some(value.into_owned()),
      _ => {}
    }
  }

  let handoff_token = handoff_token?;
  if !is_safe_handoff_token(&handoff_token) {
    return None;
  }

  let api_base_url = normalize_and_validate_api_base_url(&api_base_url?).ok()?;

  Some(DeepLinkAction::OpenDesktopEdit {
    api_base_url,
    handoff_token,
  })
}

pub fn handle_url(raw_url: &str, manager: Arc<Mutex<SessionManager>>) {
  match parse_deep_link(raw_url) {
    Some(DeepLinkAction::Ping) => {
      tracing::info!("deep link ping received");
    }
    Some(DeepLinkAction::OpenDesktopEdit {
      api_base_url,
      handoff_token,
    }) => {
      tracing::info!("desktop edit handoff deep link received");
      tauri::async_runtime::spawn(async move {
        if let Err(error) =
          redeem_and_open_desktop_edit(manager, api_base_url, handoff_token).await
        {
          tracing::error!(error = %error, "desktop edit handoff failed");
        }
      });
    }
    None => {
      tracing::warn!("unsupported deep link received");
    }
  }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RedeemDesktopEditHandoffRequest<'a> {
  handoff_token: &'a str,
}

async fn redeem_desktop_edit_handoff(
  client: &reqwest::Client,
  api_base_url: &str,
  handoff_token: &str,
) -> Result<OpenDocxRequest, String> {
  let url = format!("{api_base_url}/v1/desktop-edit-handoffs/redeem");
  let response = client
    .post(url)
    .json(&RedeemDesktopEditHandoffRequest { handoff_token })
    .timeout(REDEEM_TIMEOUT)
    .send()
    .await
    .map_err(|e| format!("stella desktop could not redeem the edit handoff: {e}"))?;

  if !response.status().is_success() {
    let status = response.status();
    let message = response
      .json::<ErrorResponse>()
      .await
      .ok()
      .and_then(|body| body.message)
      .unwrap_or_else(|| format!("Desktop edit handoff was rejected ({status})."));
    return Err(message);
  }

  response
    .json::<OpenDocxRequest>()
    .await
    .map_err(|e| format!("stella desktop could not read the edit handoff: {e}"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AcknowledgeDesktopEditHandoffOpenedRequest<'a> {
  handoff_token: &'a str,
  session_id: &'a str,
}

async fn acknowledge_desktop_edit_handoff_opened(
  client: &reqwest::Client,
  api_base_url: &str,
  handoff_id: &str,
  handoff_token: &str,
  session_id: &str,
) -> Result<(), String> {
  if !is_safe_session_id(handoff_id) {
    return Err("Invalid desktop edit handoff payload.".to_string());
  }

  let url = format!("{api_base_url}/v1/desktop-edit-handoffs/{handoff_id}/opened");
  let response = client
    .post(url)
    .json(&AcknowledgeDesktopEditHandoffOpenedRequest {
      handoff_token,
      session_id,
    })
    .timeout(ACKNOWLEDGE_TIMEOUT)
    .send()
    .await
    .map_err(|e| {
      format!("stella desktop could not acknowledge the edit handoff: {e}")
    })?;

  if response.status().is_success() {
    return Ok(());
  }

  let status = response.status();
  let message = response
    .json::<ErrorResponse>()
    .await
    .ok()
    .and_then(|body| body.message)
    .unwrap_or_else(|| {
      format!("Desktop edit handoff acknowledgement was rejected ({status}).")
    });

  Err(message)
}

async fn redeem_and_open_desktop_edit(
  manager: Arc<Mutex<SessionManager>>,
  api_base_url: String,
  handoff_token: String,
) -> Result<(), String> {
  let http_client = {
    let mgr = manager.lock().await;
    mgr.http_client().clone()
  };

  let request =
    redeem_desktop_edit_handoff(&http_client, &api_base_url, &handoff_token).await?;
  let handoff_id = request.handoff_id.clone();

  if !is_safe_session_id(&request.remote_session.session_id) {
    return Err("Invalid desktop edit session payload.".to_string());
  }

  let download_url = request.remote_session.download_url.clone();
  let prefetched_buffer = download_docx_standalone(&http_client, &download_url).await?;

  let result = {
    let mut mgr = manager.lock().await;
    mgr.open_docx(request, Some(prefetched_buffer)).await
  }?;

  SessionManager::attach_watcher(&manager, &result.session_id).await;

  if let Some(handoff_id) = handoff_id {
    if let Err(error) = acknowledge_desktop_edit_handoff_opened(
      &http_client,
      &api_base_url,
      &handoff_id,
      &handoff_token,
      &result.session_id,
    )
    .await
    {
      tracing::warn!(
        error = %error,
        session_id = %result.session_id,
        "desktop edit handoff acknowledgement failed",
      );
    }
  }

  {
    let mut mgr = manager.lock().await;
    mgr.ensure_sse_listener(&manager, &result.session_id);
  }

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  const TOKEN: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  #[test]
  fn parses_desktop_edit_handoff_link() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=https%3A%2F%2Fapi.stll.app",
    );

    assert_eq!(
      action,
      Some(DeepLinkAction::OpenDesktopEdit {
        api_base_url: "https://api.stll.app".to_string(),
        handoff_token: TOKEN.to_string(),
      })
    );
  }

  #[test]
  fn maps_app_origin_to_api_origin() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=https%3A%2F%2Fmy.stll.app",
    );

    assert_eq!(
      action,
      Some(DeepLinkAction::OpenDesktopEdit {
        api_base_url: "https://api.stll.app".to_string(),
        handoff_token: TOKEN.to_string(),
      })
    );
  }

  #[test]
  fn rejects_plain_http_non_loopback_api_url() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=http%3A%2F%2Fexample.com",
    );

    assert_eq!(action, None);
  }

  #[test]
  fn rejects_malformed_handoff_token() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=../bad&apiBaseUrl=https%3A%2F%2Fapi.stll.app",
    );

    assert_eq!(action, None);
  }
}
