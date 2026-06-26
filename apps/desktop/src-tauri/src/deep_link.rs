use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::config;
use crate::session_manager::{SessionManager, download_docx_standalone};
use crate::types::{ErrorResponse, OpenDocxRequest, is_safe_session_id};
use crate::updater;

const REDEEM_TIMEOUT: Duration = Duration::from_secs(20);
const ACKNOWLEDGE_TIMEOUT: Duration = Duration::from_secs(10);
const SELF_HOST_CONNECT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
const HANDOFF_TOKEN_LENGTH: usize = 64;

static SELF_HOST_CONNECT_SENDER: std::sync::Mutex<
  Option<tokio::sync::oneshot::Sender<bool>>,
> = std::sync::Mutex::new(None);

#[derive(Debug, PartialEq, Eq)]
enum DeepLinkAction {
  ConnectSelfHost {
    api_base_url: String,
    web_origin: String,
  },
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
  config::normalize_self_host_api_base_url(value)
    .map_err(|_| "Invalid desktop edit API URL.".to_string())
}

/// Reserves the approval channel for a single in-flight prompt. Returns the
/// sender back to the caller when a prompt is already pending so concurrent
/// `self-host/connect` deep links cannot cancel each other's approval.
fn try_reserve_self_host_connect_sender(
  sender: tokio::sync::oneshot::Sender<bool>,
) -> Result<(), tokio::sync::oneshot::Sender<bool>> {
  let mut guard = SELF_HOST_CONNECT_SENDER
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  if guard.is_some() {
    return Err(sender);
  }
  *guard = Some(sender);
  Ok(())
}

pub fn set_self_host_connect_response(approved: bool) {
  let mut guard = SELF_HOST_CONNECT_SENDER
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  if let Some(sender) = guard.take() {
    let _ = sender.send(approved);
  }
}

fn parse_deep_link(raw_url: &str) -> Option<DeepLinkAction> {
  let url = reqwest::Url::parse(raw_url).ok()?;
  if url.scheme() != "stella" {
    return None;
  }

  if url.host_str() == Some("ping") {
    return Some(DeepLinkAction::Ping);
  }

  if url.host_str() == Some("self-host") && url.path() == "/connect" {
    let mut web_origin = None;
    let mut api_base_url = None;

    for (key, value) in url.query_pairs() {
      match key.as_ref() {
        "webOrigin" => web_origin = Some(value.into_owned()),
        "apiBaseUrl" => api_base_url = Some(value.into_owned()),
        _ => {}
      }
    }

    let web_origin = config::normalize_self_host_web_origin(&web_origin?).ok()?;
    let api_base_url = config::normalize_self_host_api_base_url(&api_base_url?).ok()?;

    return Some(DeepLinkAction::ConnectSelfHost {
      api_base_url,
      web_origin,
    });
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

pub fn handle_url(
  raw_url: &str,
  manager: Arc<Mutex<SessionManager>>,
  app_handle: AppHandle,
) {
  match parse_deep_link(raw_url) {
    Some(DeepLinkAction::ConnectSelfHost {
      api_base_url,
      web_origin,
    }) => {
      tracing::info!("self-host desktop connection deep link received");
      tauri::async_runtime::spawn(async move {
        if let Err(error) =
          confirm_and_trust_self_host(manager, app_handle, web_origin, api_base_url)
            .await
        {
          tracing::warn!(error = %error, "self-host desktop connection failed");
        }
      });
    }
    Some(DeepLinkAction::Ping) => {
      tracing::info!("deep link ping received");
      tauri::async_runtime::spawn(async move {
        if cfg!(debug_assertions) {
          tracing::debug!("deep link updater check skipped in debug build");
          return;
        }

        let active_edit_sessions = {
          let mgr = manager.lock().await;
          mgr.has_active_edit_sessions()
        };

        match updater::run_check(&app_handle, active_edit_sessions).await {
          updater::CheckOutcome::Deferred { version } => {
            tracing::debug!(
                version = %version,
                "deep link updater check deferred while desktop edits are active"
            );
          }
          updater::CheckOutcome::UpToDate => {
            tracing::debug!("deep link updater check: up to date");
          }
          updater::CheckOutcome::Failed(error) => {
            tracing::warn!(error = %error, "deep link updater check failed");
          }
        }
      });
    }
    Some(DeepLinkAction::OpenDesktopEdit {
      api_base_url,
      handoff_token,
    }) => {
      tracing::info!("desktop edit handoff deep link received");
      tauri::async_runtime::spawn(async move {
        let trusted = {
          let mgr = manager.lock().await;
          config::resolve_trusted_api_base_urls().contains(&api_base_url)
            || mgr.is_trusted_self_host_api_base_url(&api_base_url)
        };
        if !trusted {
          tracing::warn!(
            api_base_url = %api_base_url,
            "desktop edit handoff rejected because API URL is not trusted"
          );
          return;
        }

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

async fn confirm_and_trust_self_host(
  manager: Arc<Mutex<SessionManager>>,
  app_handle: AppHandle,
  web_origin: String,
  api_base_url: String,
) -> Result<(), String> {
  {
    let mgr = manager.lock().await;
    if mgr.is_trusted_self_host_connection(&web_origin, &api_base_url) {
      return Ok(());
    }
  }

  let approved =
    show_self_host_connect_dialog(&app_handle, &web_origin, &api_base_url).await?;
  if !approved {
    return Err("Self-host desktop connection was not approved.".to_string());
  }

  let mut mgr = manager.lock().await;
  mgr
    .trust_self_host_connection(web_origin, api_base_url)
    .await;
  Ok(())
}

async fn show_self_host_connect_dialog(
  app_handle: &AppHandle,
  web_origin: &str,
  api_base_url: &str,
) -> Result<bool, String> {
  use tauri::Manager;

  let (sender, receiver) = tokio::sync::oneshot::channel();
  if try_reserve_self_host_connect_sender(sender).is_err() {
    return Err("A self-host connection dialog is already open.".to_string());
  }

  // Defensive: a stale dialog window without a reserved sender should never
  // happen (we close it on every exit path), but bail rather than stack a
  // second window over it.
  if app_handle
    .get_webview_window("selfhost-connect-dialog")
    .is_some()
  {
    set_self_host_connect_response(false);
    return Err("A self-host connection dialog is already open.".to_string());
  }

  let hash = format!(
    "webOrigin={}&apiBaseUrl={}",
    percent_encode(web_origin),
    percent_encode(api_base_url)
  );

  let builder = tauri::WebviewWindowBuilder::new(
    app_handle,
    "selfhost-connect-dialog",
    tauri::WebviewUrl::App(format!("selfhost-connect-dialog.html#{hash}").into()),
  )
  .title("Connect self-hosted Stella")
  .inner_size(420.0, 320.0)
  .resizable(false)
  .center();

  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);

  match builder.build() {
    Ok(window) => {
      let _ = window.set_focus();
      let outcome = match tokio::time::timeout(
        SELF_HOST_CONNECT_APPROVAL_TIMEOUT,
        receiver,
      )
      .await
      {
        Ok(Ok(approved)) => approved,
        Ok(Err(_)) => false,
        Err(_) => {
          set_self_host_connect_response(false);
          false
        }
      };
      // The dialog closes itself once the user responds; close it explicitly so
      // a timeout or dropped sender does not leave a ghost window behind.
      let _ = window.close();
      Ok(outcome)
    }
    Err(error) => {
      set_self_host_connect_response(false);
      Err(format!(
        "failed to open self-host connection dialog: {error}"
      ))
    }
  }
}

fn percent_encode(value: &str) -> String {
  use std::fmt::Write;

  let mut encoded = String::with_capacity(value.len());
  for byte in value.bytes() {
    match byte {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
        encoded.push(byte as char);
      }
      _ => {
        let _ = write!(encoded, "%{byte:02X}");
      }
    }
  }
  encoded
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

  if let Some(handoff_id) = handoff_id
    && let Err(error) = acknowledge_desktop_edit_handoff_opened(
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
  fn parses_https_api_url_before_runtime_trust_check() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=https%3A%2F%2Fexample.com",
    );

    assert_eq!(
      action,
      Some(DeepLinkAction::OpenDesktopEdit {
        api_base_url: "https://example.com".to_string(),
        handoff_token: TOKEN.to_string(),
      })
    );
  }

  #[test]
  fn rejects_malformed_handoff_token() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=../bad&apiBaseUrl=https%3A%2F%2Fapi.stll.app",
    );

    assert_eq!(action, None);
  }

  #[test]
  fn parses_self_host_connect_link() {
    let action = parse_deep_link(
      "stella://self-host/connect?webOrigin=https%3A%2F%2Fweb-production.example&apiBaseUrl=https%3A%2F%2Fapi-production.example",
    );

    assert_eq!(
      action,
      Some(DeepLinkAction::ConnectSelfHost {
        api_base_url: "https://api-production.example".to_string(),
        web_origin: "https://web-production.example".to_string(),
      })
    );
  }

  #[test]
  fn rejects_self_host_connect_origin_with_path() {
    let action = parse_deep_link(
      "stella://self-host/connect?webOrigin=https%3A%2F%2Fweb-production.example%2Fapp&apiBaseUrl=https%3A%2F%2Fapi-production.example",
    );

    assert_eq!(action, None);
  }
}
