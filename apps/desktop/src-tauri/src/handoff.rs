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
  Retryable(String),
  Terminal(String),
}
impl Failure {
  fn from_response(body: Option<ErrorResponse>, status: reqwest::StatusCode) -> Self {
    let code = body.as_ref().and_then(|body| body.code.as_deref());
    if status.is_client_error() {
      match code {
        Some("desktop_update_required") => return Self::UpdateRequired,
        Some("desktop_account_required") => return Self::AccountRequired,
        _ => {}
      }
      if status == reqwest::StatusCode::UNAUTHORIZED {
        return Self::AccountRequired;
      }
      if status == reqwest::StatusCode::UPGRADE_REQUIRED {
        return Self::UpdateRequired;
      }
    }
    let message = body
      .and_then(|body| body.message)
      .filter(|message| !message.is_empty())
      .unwrap_or_else(|| format!("{status}"));
    if status.is_server_error() {
      Self::Retryable(message)
    } else {
      Self::Terminal(message)
    }
  }
  fn from_request_error(error: reqwest::Error) -> Self {
    if error.is_timeout() || error.is_connect() || error.is_body() || error.is_request()
    {
      Self::Retryable(error.to_string())
    } else {
      Self::Terminal(error.to_string())
    }
  }
  pub(crate) fn message_key(&self) -> &'static str {
    match self {
      Self::UpdateRequired => "dialog.handoffUpdateRequired",
      Self::AccountRequired => "dialog.handoffAccountRequired",
      Self::Retryable(_) => "dialog.handoffFailed",
      Self::Terminal(_) => "dialog.handoffUnavailable",
    }
  }
  pub(crate) fn action_key(&self) -> Option<&'static str> {
    match self {
      Self::Retryable(_) => Some("dialog.handoffRetry"),
      Self::UpdateRequired | Self::AccountRequired | Self::Terminal(_) => None,
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
  credential: Option<&'a str>,
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
  let builder = client
    .post(format!("{api_base_url}{}", target.path()))
    .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string())
    .json(&RedeemRequest {
      handoff_token: token,
    })
    .timeout(REDEEM_TIMEOUT);
  match credential {
    Some(credential) => builder.bearer_auth(credential),
    None => builder,
  }
}

async fn attempt<T: serde::de::DeserializeOwned>(
  options: RequestOptions<'_>,
) -> Result<T, Failure> {
  let response = request(options)
    .send()
    .await
    .map_err(Failure::from_request_error)?;
  let status = response.status();
  if !status.is_success() {
    return Err(Failure::from_response(
      response.json::<ErrorResponse>().await.ok(),
      status,
    ));
  }
  response.json().await.map_err(Failure::from_request_error)
}

struct LinkedRequestOptions<'a> {
  client: &'a DesktopHttpClient,
  target: Target,
  api_base_url: &'a str,
  token: &'a str,
  account: Option<crate::account::LinkedAccount>,
}

async fn attempt_linked<T: serde::de::DeserializeOwned>(
  options: LinkedRequestOptions<'_>,
) -> Result<(T, crate::account::LinkedAccount), Failure> {
  let LinkedRequestOptions {
    client,
    target,
    api_base_url,
    token,
    account,
  } = options;
  let account = account.filter(|account| account.api_base_url == api_base_url);
  let redeemed = attempt(RequestOptions {
    client,
    target,
    api_base_url,
    token,
    credential: account
      .as_ref()
      .map(|account| account.credential.key.as_str()),
  })
  .await?;
  match account {
    Some(account) => Ok((redeemed, account)),
    None => Err(Failure::AccountRequired),
  }
}

trait RecoveryHost: Sync {
  fn check_update(
    &self,
  ) -> impl std::future::Future<Output = crate::updater::CheckOutcome> + Send;
  fn confirm(
    &self,
    failure: &Failure,
  ) -> impl std::future::Future<Output = Result<bool, String>> + Send;
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
  let accepted = host.confirm(&failure).await?;
  match failure {
    Failure::Retryable(_) if accepted => Ok(Recovery::Retry),
    Failure::Retryable(_)
    | Failure::UpdateRequired
    | Failure::AccountRequired
    | Failure::Terminal(_) => Ok(Recovery::Stop),
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
    let result = match crate::account::current(&account_state).await {
      Ok(account) => {
        attempt_linked(LinkedRequestOptions {
          client: &client,
          target,
          api_base_url,
          token,
          account,
        })
        .await
      }
      Err(message) => Err(Failure::Terminal(message)),
    };
    let failure = match result {
      Ok(redeemed) => return Ok(redeemed),
      Err(failure) => failure,
    };
    let message_key = failure.message_key();
    match recover(failure, &DesktopRecovery { app, manager }).await? {
      Recovery::Retry => {}
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
        credential: Some("account-key"),
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
        None,
      ),
      (
        "desktop_account_required",
        Failure::AccountRequired,
        "dialog.handoffAccountRequired",
        None,
      ),
      (
        "unknown",
        Failure::Terminal("detail".into()),
        "dialog.handoffUnavailable",
        None,
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
      if let Some(action) = action {
        assert!(crate::i18n::locales_missing(action).is_empty());
      }
    }
    let retryable = Failure::from_response(None, reqwest::StatusCode::BAD_GATEWAY);
    assert_eq!(retryable, Failure::Retryable("502 Bad Gateway".into()));
    assert_eq!(retryable.message_key(), "dialog.handoffFailed");
    assert_eq!(retryable.action_key(), Some("dialog.handoffRetry"));
    assert!(crate::i18n::locales_missing(retryable.message_key()).is_empty());
    assert!(crate::i18n::locales_missing("dialog.handoffRetry").is_empty());
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
          credential: Some("account-key"),
        })
        .await;
        assert_eq!(result, Err(expected));
      }
      let result = attempt::<serde_json::Value>(RequestOptions {
        client: &client,
        target,
        api_base_url: &origin,
        token: "valid",
        credential: Some("account-key"),
      })
      .await
      .unwrap();
      assert_eq!(result, serde_json::json!({"id":"redeemed"}));
      let account = crate::account::LinkedAccount {
        api_base_url: origin.clone(),
        web_origin: "https://web.example.test".into(),
        account: crate::types::LinkedAccountSnapshot {
          email: "desktop@example.test".into(),
          name: None,
          verified_at: "2026-10-01T00:00:00Z".into(),
        },
        identity: crate::types::DesktopAccountIdentity {
          user_id: "user_fixture".into(),
          organization_id: "org_fixture".into(),
        },
        credential: crate::types::DesktopAccountCredential {
          key: "account-key".into(),
          expires_at: "2027-01-01T00:00:00Z".into(),
        },
      };
      let (redeemed, linked) =
        attempt_linked::<serde_json::Value>(LinkedRequestOptions {
          client: &client,
          target,
          api_base_url: &origin,
          token: "valid",
          account: Some(account),
        })
        .await
        .unwrap();
      assert_eq!(redeemed, serde_json::json!({"id":"redeemed"}));
      assert_eq!(linked.credential.key, "account-key");
      assert_eq!(linked.api_base_url, origin);
    }
    server.abort();
  }

  struct FakeRecovery {
    events: std::sync::Mutex<Vec<String>>,
    accepted: bool,
    update_outcome: std::sync::Mutex<Option<crate::updater::CheckOutcome>>,
  }
  impl RecoveryHost for FakeRecovery {
    async fn check_update(&self) -> crate::updater::CheckOutcome {
      self.events.lock().unwrap().push("check".into());
      self
        .update_outcome
        .lock()
        .unwrap()
        .take()
        .expect("one update check per recovery")
    }
    async fn confirm(&self, failure: &Failure) -> Result<bool, String> {
      self
        .events
        .lock()
        .unwrap()
        .push(failure.action_key().unwrap_or("close").into());
      Ok(self.accepted)
    }
  }
  #[tokio::test]
  async fn recovery_drives_update_retry_and_close_actions() {
    for accepted in [false, true] {
      for (failure, expected) in [
        (Failure::UpdateRequired, vec!["check", "close"]),
        (Failure::AccountRequired, vec!["close"]),
        (Failure::Terminal("detail".into()), vec!["close"]),
        (
          Failure::Retryable("detail".into()),
          vec!["dialog.handoffRetry"],
        ),
      ] {
        let retry = accepted && matches!(failure, Failure::Retryable(_));
        let host = FakeRecovery {
          events: Default::default(),
          accepted,
          update_outcome: std::sync::Mutex::new(Some(
            crate::updater::CheckOutcome::UpToDate,
          )),
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
    for outcome in [
      crate::updater::CheckOutcome::Failed("detail".into()),
      crate::updater::CheckOutcome::Deferred {
        version: "test".into(),
      },
    ] {
      let host = FakeRecovery {
        events: Default::default(),
        accepted: true,
        update_outcome: std::sync::Mutex::new(Some(outcome)),
      };
      assert_eq!(
        recover(Failure::UpdateRequired, &host).await.unwrap(),
        Recovery::Stop
      );
      assert_eq!(*host.events.lock().unwrap(), vec!["check", "close"]);
    }
    let host = FakeRecovery {
      events: Default::default(),
      accepted: true,
      update_outcome: std::sync::Mutex::new(Some(
        crate::updater::CheckOutcome::Installed {
          version: "test".into(),
        },
      )),
    };
    assert_eq!(
      recover(Failure::UpdateRequired, &host).await.unwrap(),
      Recovery::Stop
    );
    assert_eq!(*host.events.lock().unwrap(), vec!["check"]);
  }
  #[tokio::test]
  async fn every_terminal_status_is_close_only() {
    for code in 400..500 {
      for typed_code in [
        None,
        Some("desktop_account_required"),
        Some("desktop_update_required"),
      ] {
        let failure = Failure::from_response(
          Some(ErrorResponse {
            code: typed_code.map(str::to_owned),
            message: Some("detail".into()),
          }),
          reqwest::StatusCode::from_u16(code).unwrap(),
        );
        assert_eq!(
          failure.action_key(),
          None,
          "status {code}, code {typed_code:?}"
        );
        let host = FakeRecovery {
          events: Default::default(),
          accepted: true,
          update_outcome: std::sync::Mutex::new(Some(
            crate::updater::CheckOutcome::UpToDate,
          )),
        };
        assert_eq!(
          recover(failure, &host).await.unwrap(),
          Recovery::Stop,
          "status {code}"
        );
        assert!(
          !host
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event == "connect")
        );
      }
    }
  }

  #[tokio::test]
  async fn every_server_status_can_retry() {
    for code in 500..600 {
      for typed_code in [
        None,
        Some("desktop_account_required"),
        Some("desktop_update_required"),
      ] {
        let failure = Failure::from_response(
          Some(ErrorResponse {
            code: typed_code.map(str::to_owned),
            message: Some("detail".into()),
          }),
          reqwest::StatusCode::from_u16(code).unwrap(),
        );
        assert_eq!(
          failure.action_key(),
          Some("dialog.handoffRetry"),
          "status {code}, code {typed_code:?}"
        );
        let host = FakeRecovery {
          events: Default::default(),
          accepted: true,
          update_outcome: std::sync::Mutex::new(Some(
            crate::updater::CheckOutcome::UpToDate,
          )),
        };
        assert_eq!(recover(failure, &host).await.unwrap(), Recovery::Retry);
      }
    }
  }

  #[tokio::test]
  async fn transport_failure_offers_retry() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let client = DesktopHttpClient::new(HttpClientOptions::default()).unwrap();
    let failure = attempt::<serde_json::Value>(RequestOptions {
      client: &client,
      target: Target::DesktopEdit,
      api_base_url: &origin,
      token: "token",
      credential: Some("key"),
    })
    .await
    .unwrap_err();
    assert_eq!(failure.action_key(), Some("dialog.handoffRetry"));
    let host = FakeRecovery {
      events: Default::default(),
      accepted: true,
      update_outcome: std::sync::Mutex::new(Some(
        crate::updater::CheckOutcome::UpToDate,
      )),
    };
    assert_eq!(recover(failure, &host).await.unwrap(), Recovery::Retry);
  }

  #[tokio::test]
  async fn absent_or_other_server_account_redeems_without_authorization() {
    use axum::{Router, http::StatusCode, routing::post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = calls.clone();
    let endpoint = post(
      move |headers: axum::http::HeaderMap,
            axum::Json(body): axum::Json<serde_json::Value>| {
        let observed = observed.clone();
        async move {
          assert_eq!(headers[PROTOCOL_HEADER], "1");
          assert!(!headers.contains_key("authorization"));
          assert_eq!(body, serde_json::json!({"handoffToken":"token"}));
          observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
          (
            StatusCode::UNAUTHORIZED,
            axum::Json(
              serde_json::json!({"code":"desktop_account_required","message":"Connect"}),
            ),
          )
        }
      },
    );
    let router = Router::new()
      .route(Target::DesktopEdit.path(), endpoint.clone())
      .route(Target::PdfSigning.path(), endpoint);
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let client = DesktopHttpClient::new(HttpClientOptions::default()).unwrap();
    for target in [Target::DesktopEdit, Target::PdfSigning] {
      for account in [
        None,
        Some(crate::account::LinkedAccount {
          api_base_url: "https://other.example.test".into(),
          web_origin: "https://web.example.test".into(),
          account: crate::types::LinkedAccountSnapshot {
            email: "desktop@example.test".into(),
            name: None,
            verified_at: "2026-10-01T00:00:00Z".into(),
          },
          identity: crate::types::DesktopAccountIdentity {
            user_id: "user_fixture".into(),
            organization_id: "org_fixture".into(),
          },
          credential: crate::types::DesktopAccountCredential {
            key: "other-server-key".into(),
            expires_at: "2027-01-01T00:00:00Z".into(),
          },
        }),
      ] {
        let result = attempt_linked::<serde_json::Value>(LinkedRequestOptions {
          client: &client,
          target,
          api_base_url: &origin,
          token: "token",
          account,
        })
        .await;
        assert!(matches!(result, Err(Failure::AccountRequired)));
      }
    }
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 4);
    server.abort();
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
