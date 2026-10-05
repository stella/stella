//! Authenticated handoff redemption and user recovery for both document flows.

use crate::http_client::{DesktopHttpClient, HttpClientOptions};
use crate::session_manager::SessionManager;
use crate::types::ErrorResponse;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

const PROTOCOL_HEADER: &str = "X-Stella-Desktop-Protocol";
const PROTOCOL_VERSION: u32 = 1;
const REDEEM_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target {
  DesktopEdit,
  PdfSigning,
}
impl Target {
  fn path(self) -> &'static str {
    match self {
      Self::DesktopEdit => "/v1/desktop-edit-handoffs/redeem",
      Self::PdfSigning => "/v1/pdf-signing-handoffs/redeem",
    }
  }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Failure {
  UpdateRequired,
  AccountRequired,
  Other(String),
}
impl Failure {
  fn from_response(body: Option<ErrorResponse>, status: reqwest::StatusCode) -> Self {
    match body.as_ref().and_then(|body| body.code.as_deref()) {
      Some("desktop_update_required") => Self::UpdateRequired,
      Some("desktop_account_required") => Self::AccountRequired,
      _ => Self::Other(
        body
          .and_then(|body| body.message)
          .filter(|m| !m.is_empty())
          .unwrap_or_else(|| format!("{status}")),
      ),
    }
  }
  pub(crate) fn message_key(&self) -> &'static str {
    match self {
      Self::UpdateRequired => "dialog.handoffUpdateRequired",
      Self::AccountRequired => "dialog.handoffAccountRequired",
      Self::Other(_) => "dialog.handoffFailed",
    }
  }
  pub(crate) fn action_key(&self) -> &'static str {
    match self {
      Self::UpdateRequired => "dialog.handoffUpdateNow",
      Self::AccountRequired => "dialog.handoffConnectAccount",
      Self::Other(_) => "dialog.handoffRetry",
    }
  }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RedeemRequest<'a> {
  handoff_token: &'a str,
}

struct RequestOptions<'a> {
  client: &'a DesktopHttpClient,
  target: Target,
  api_base_url: &'a str,
  token: &'a str,
  credential: &'a str,
}

fn request(
  RequestOptions {
    client,
    target,
    api_base_url,
    token,
    credential,
  }: RequestOptions<'_>,
) -> reqwest::RequestBuilder {
  client
    .post(format!("{api_base_url}{}", target.path()))
    .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string())
    .bearer_auth(credential)
    .json(&RedeemRequest {
      handoff_token: token,
    })
    .timeout(REDEEM_TIMEOUT)
}

async fn attempt<T: serde::de::DeserializeOwned>(
  options: RequestOptions<'_>,
) -> Result<T, Failure> {
  let response = request(options)
    .send()
    .await
    .map_err(|e| Failure::Other(e.to_string()))?;
  let status = response.status();
  if !status.is_success() {
    return Err(Failure::from_response(
      response.json::<ErrorResponse>().await.ok(),
      status,
    ));
  }
  response
    .json()
    .await
    .map_err(|e| Failure::Other(e.to_string()))
}

trait RecoveryHost: Sync {
  fn check_update(
    &self,
  ) -> impl std::future::Future<Output = crate::updater::CheckOutcome> + Send;
  fn confirm(
    &self,
    failure: &Failure,
  ) -> impl std::future::Future<Output = Result<bool, String>> + Send;
  fn connect_account(
    &self,
  ) -> impl std::future::Future<Output = Result<(), String>> + Send;
}

struct DesktopRecovery<'a> {
  app: &'a AppHandle,
  manager: &'a Mutex<SessionManager>,
}
impl RecoveryHost for DesktopRecovery<'_> {
  async fn check_update(&self) -> crate::updater::CheckOutcome {
    let active = self.manager.lock().await.has_active_edit_sessions();
    crate::updater::run_check(self.app, active).await
  }
  async fn confirm(&self, failure: &Failure) -> Result<bool, String> {
    crate::deep_link::show_connection_confirmation(
      self.app,
      crate::deep_link::ConnectionConfirmation::HandoffError(failure),
    )
    .await
  }
  async fn connect_account(&self) -> Result<(), String> {
    crate::commands::open_stella_account(
      self.app.clone(),
      self.app.state(),
      self.app.state(),
    )
    .await
  }
}

#[derive(Debug, PartialEq, Eq)]
enum Recovery {
  Retry,
  Stop,
}

async fn recover(
  failure: Failure,
  host: &impl RecoveryHost,
) -> Result<Recovery, String> {
  if matches!(failure, Failure::UpdateRequired) {
    match host.check_update().await {
      crate::updater::CheckOutcome::Installed { .. } => return Ok(Recovery::Stop),
      crate::updater::CheckOutcome::Failed(error) => {
        tracing::warn!(%error, "required handoff update check failed")
      }
      crate::updater::CheckOutcome::Deferred { .. }
      | crate::updater::CheckOutcome::UpToDate => {}
    }
  }
  if !host.confirm(&failure).await? {
    return Ok(Recovery::Stop);
  }
  match failure {
    Failure::UpdateRequired => {
      match host.check_update().await {
        crate::updater::CheckOutcome::Failed(message) => {
          if host.confirm(&Failure::Other(message)).await? {
            return Ok(Recovery::Retry);
          }
        }
        crate::updater::CheckOutcome::Installed { .. }
        | crate::updater::CheckOutcome::Deferred { .. }
        | crate::updater::CheckOutcome::UpToDate => {}
      }
      Ok(Recovery::Stop)
    }
    Failure::AccountRequired => {
      if let Err(message) = host.connect_account().await {
        if host.confirm(&Failure::Other(message)).await? {
          return Ok(Recovery::Retry);
        }
      }
      Ok(Recovery::Stop)
    }
    Failure::Other(_) => Ok(Recovery::Retry),
  }
}

pub(crate) struct RedeemOptions<'a> {
  pub manager: &'a Arc<Mutex<SessionManager>>,
  pub app: &'a AppHandle,
  pub target: Target,
  pub api_base_url: &'a str,
  pub token: &'a str,
}

pub(crate) async fn redeem<T: serde::de::DeserializeOwned>(
  options: RedeemOptions<'_>,
) -> Result<(T, crate::account::LinkedAccount), String> {
  let RedeemOptions {
    manager,
    app,
    target,
    api_base_url,
    token,
  } = options;
  if crate::updater::check_on_handoff(app, manager).await {
    return Err("Desktop update installed; reopen the document after relaunch.".into());
  }
  let client = DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: None,
  })
  .map_err(|e| e.to_string())?;
  loop {
    let account_state = app.state::<crate::account::AccountState>();
    let account = match crate::account::current(&account_state).await {
      Ok(Some(account)) if account.api_base_url == api_base_url => Ok(account),
      Ok(_) => Err(Failure::AccountRequired),
      Err(message) => Err(Failure::Other(message)),
    };
    let result = match account {
      Ok(account) => attempt(RequestOptions {
        client: &client,
        target,
        api_base_url,
        token,
        credential: &account.credential.key,
      })
      .await
      .map(|redeemed| (redeemed, account)),
      Err(failure) => Err(failure),
    };
    let failure = match result {
      Ok(redeemed) => return Ok(redeemed),
      Err(failure) => failure,
    };
    let message_key = failure.message_key();
    match recover(failure, &DesktopRecovery { app, manager }).await? {
      Recovery::Retry => continue,
      Recovery::Stop => return Err(crate::i18n::t(message_key).into()),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn both_redeems_send_protocol_bearer_and_token_in_body() {
    let client = DesktopHttpClient::new(HttpClientOptions::default()).unwrap();
    for target in [Target::DesktopEdit, Target::PdfSigning] {
      let req = request(RequestOptions {
        client: &client,
        target,
        api_base_url: "https://api.example.test",
        token: "secret-token",
        credential: "account-key",
      })
      .build()
      .unwrap();
      assert_eq!(req.method(), reqwest::Method::POST);
      assert_eq!(req.url().path(), target.path());
      assert_eq!(req.headers()[PROTOCOL_HEADER], "1");
      assert_eq!(req.headers()["authorization"], "Bearer account-key");
      assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
          req.body().unwrap().as_bytes().unwrap()
        )
        .unwrap(),
        serde_json::json!({ "handoffToken": "secret-token" })
      );
      assert!(req.url().query().is_none());
    }
  }
  #[test]
  fn typed_responses_select_localized_recovery() {
    for (code, expected, message, action) in [
      (
        "desktop_update_required",
        Failure::UpdateRequired,
        "dialog.handoffUpdateRequired",
        "dialog.handoffUpdateNow",
      ),
      (
        "desktop_account_required",
        Failure::AccountRequired,
        "dialog.handoffAccountRequired",
        "dialog.handoffConnectAccount",
      ),
      (
        "unknown",
        Failure::Other("detail".into()),
        "dialog.handoffFailed",
        "dialog.handoffRetry",
      ),
    ] {
      let failure = Failure::from_response(
        Some(ErrorResponse {
          code: Some(code.into()),
          message: Some("detail".into()),
        }),
        reqwest::StatusCode::BAD_REQUEST,
      );
      assert_eq!(failure, expected);
      assert_eq!(failure.message_key(), message);
      assert_eq!(failure.action_key(), action);
      assert!(crate::i18n::locales_missing(message).is_empty());
      assert!(crate::i18n::locales_missing(action).is_empty());
    }
    assert_eq!(
      Failure::from_response(None, reqwest::StatusCode::BAD_GATEWAY),
      Failure::Other("502 Bad Gateway".into())
    );
  }
  #[tokio::test]
  async fn both_redeems_parse_the_wire_error_and_preserve_success_payloads() {
    use axum::{Router, http::StatusCode, routing::post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let endpoint = post(
      |headers: axum::http::HeaderMap,
       axum::Json(body): axum::Json<serde_json::Value>| async move {
        assert_eq!(headers[PROTOCOL_HEADER], "1");
        assert_eq!(headers["authorization"], "Bearer account-key");
        match body["handoffToken"].as_str().unwrap() {
          "update" => (
            StatusCode::UPGRADE_REQUIRED,
            axum::Json(
              serde_json::json!({"code":"desktop_update_required","message":"Update"}),
            ),
          ),
          "account" => (
            StatusCode::UNAUTHORIZED,
            axum::Json(
              serde_json::json!({"code":"desktop_account_required","message":"Connect"}),
            ),
          ),
          _ => (
            StatusCode::OK,
            axum::Json(serde_json::json!({"id":"redeemed"})),
          ),
        }
      },
    );
    let router = Router::new()
      .route(Target::DesktopEdit.path(), endpoint.clone())
      .route(Target::PdfSigning.path(), endpoint);
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let client = DesktopHttpClient::new(HttpClientOptions {
      redirect: reqwest::redirect::Policy::none(),
      timeout: None,
    })
    .unwrap();
    for target in [Target::DesktopEdit, Target::PdfSigning] {
      for (token, expected) in [
        ("update", Failure::UpdateRequired),
        ("account", Failure::AccountRequired),
      ] {
        let result = attempt::<serde_json::Value>(RequestOptions {
          client: &client,
          target,
          api_base_url: &origin,
          token,
          credential: "account-key",
        })
        .await;
        assert_eq!(result, Err(expected));
      }
      let result = attempt::<serde_json::Value>(RequestOptions {
        client: &client,
        target,
        api_base_url: &origin,
        token: "valid",
        credential: "account-key",
      })
      .await
      .unwrap();
      assert_eq!(result, serde_json::json!({"id":"redeemed"}));
    }
    server.abort();
  }

  struct FakeRecovery {
    events: std::sync::Mutex<Vec<String>>,
    accepted: bool,
    installed: bool,
  }
  impl RecoveryHost for FakeRecovery {
    async fn check_update(&self) -> crate::updater::CheckOutcome {
      self.events.lock().unwrap().push("check".into());
      if self.installed {
        crate::updater::CheckOutcome::Installed {
          version: "test".into(),
        }
      } else {
        crate::updater::CheckOutcome::UpToDate
      }
    }
    async fn confirm(&self, failure: &Failure) -> Result<bool, String> {
      self
        .events
        .lock()
        .unwrap()
        .push(failure.action_key().into());
      Ok(self.accepted)
    }
    async fn connect_account(&self) -> Result<(), String> {
      self.events.lock().unwrap().push("connect".into());
      Ok(())
    }
  }
  #[tokio::test]
  async fn recovery_drives_update_connect_retry_and_cancel_actions() {
    for accepted in [false, true] {
      for (failure, expected) in [
        (
          Failure::UpdateRequired,
          if accepted {
            vec!["check", "dialog.handoffUpdateNow", "check"]
          } else {
            vec!["check", "dialog.handoffUpdateNow"]
          },
        ),
        (
          Failure::AccountRequired,
          if accepted {
            vec!["dialog.handoffConnectAccount", "connect"]
          } else {
            vec!["dialog.handoffConnectAccount"]
          },
        ),
        (Failure::Other("detail".into()), vec!["dialog.handoffRetry"]),
      ] {
        let retry = accepted && matches!(failure, Failure::Other(_));
        let host = FakeRecovery {
          events: Default::default(),
          accepted,
          installed: false,
        };
        assert_eq!(
          recover(failure, &host).await.unwrap(),
          if retry {
            Recovery::Retry
          } else {
            Recovery::Stop
          }
        );
        assert_eq!(*host.events.lock().unwrap(), expected);
      }
    }
    let host = FakeRecovery {
      events: Default::default(),
      accepted: true,
      installed: true,
    };
    assert_eq!(
      recover(Failure::UpdateRequired, &host).await.unwrap(),
      Recovery::Stop
    );
    assert_eq!(*host.events.lock().unwrap(), vec!["check"]);
  }
  #[test]
  fn protocol_matches_api_contract() {
    let source = std::fs::read_to_string(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/../../../packages/api-contract/src/desktop-handoff.ts"
    ))
    .expect("desktop handoff API contract");
    let declaration = |name: &str| {
      source
        .lines()
        .find_map(|line| {
          let prefix = format!("export const {name} = ");
          line
            .trim()
            .strip_prefix(&prefix)
            .map(|value| value.trim_end_matches(';').trim().to_owned())
        })
        .expect("exported desktop protocol constant")
    };
    assert_eq!(
      declaration("DESKTOP_HANDOFF_PROTOCOL_VERSION")
        .parse::<u32>()
        .unwrap(),
      PROTOCOL_VERSION
    );
    assert_eq!(
      declaration("DESKTOP_HANDOFF_PROTOCOL_HEADER"),
      format!("\"{PROTOCOL_HEADER}\"")
    );
  }
}
