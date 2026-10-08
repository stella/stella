//! Authenticated handoff redemption and user recovery for both document flows.

use crate::http_client::{DesktopHttpClient, HttpClientOptions};
use crate::session_manager::SessionManager;
use crate::types::ErrorResponse;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

const PROTOCOL_HEADER: &str = "X-Stella-Desktop-Protocol";
pub(crate) const PROTOCOL_VERSION: u32 = 1;
const REDEEM_TIMEOUT: Duration = Duration::from_secs(20);
/// `DESKTOP_HANDOFF_LIFETIME_SECONDS` in the API contract. Counted from when
/// the deep link arrives, so a parked handoff never outlives its token.
const HANDOFF_LIFETIME: Duration = Duration::from_secs(120);

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
  /// The link names an API this desktop does not trust.
  UntrustedServer,
  /// The document belongs to another account or server than the linked one.
  AccountMismatch,
  /// The linked account changed or disconnected while the document opened.
  AccountChanged,
  /// Another signing dialog holds the only slot.
  AlreadyOpen,
  /// A parked handoff outlived its token before the account was linked.
  Expired,
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
      Self::UntrustedServer => "dialog.handoffUntrustedServer",
      Self::AccountMismatch => "dialog.handoffAccountMismatch",
      Self::AccountChanged => "dialog.handoffAccountChanged",
      Self::AlreadyOpen => "dialog.handoffAlreadyOpen",
      Self::Expired => "dialog.handoffExpired",
      Self::Retryable(_) => "dialog.handoffFailed",
      Self::Terminal(_) => "dialog.handoffUnavailable",
    }
  }
  pub(crate) fn action_key(&self) -> Option<&'static str> {
    match self {
      Self::Retryable(_) => Some("dialog.handoffRetry"),
      Self::UpdateRequired
      | Self::AccountRequired
      | Self::UntrustedServer
      | Self::AccountMismatch
      | Self::AccountChanged
      | Self::AlreadyOpen
      | Self::Expired
      | Self::Terminal(_) => None,
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
    | Failure::UntrustedServer
    | Failure::AccountMismatch
    | Failure::AccountChanged
    | Failure::AlreadyOpen
    | Failure::Expired
    | Failure::Terminal(_) => Ok(Recovery::Stop),
  }
}

/// Why a document handoff ended before a window of its own could say so.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Stop {
  /// Already in front of the user: a recovery dialog or the signing dialog.
  Presented(String),
  /// No usable account for the link's server. The handoff has not been
  /// redeemed, so it can wait for the account to be linked.
  AccountRequired,
  /// Not yet shown to the user.
  Failed(Failure),
}
impl From<Failure> for Stop {
  fn from(failure: Failure) -> Self {
    Self::Failed(failure)
  }
}
impl From<String> for Stop {
  fn from(detail: String) -> Self {
    Self::Failed(Failure::Terminal(detail))
  }
}

/// The account a redemption may present. An unlinked desktop, or one whose
/// saved credential the API rejects, must not redeem: an unauthenticated
/// redeem ends the handoff on the server, and the user is about to link.
/// An account on another server keeps the unauthenticated redeem, which
/// tells the web the desktop needs a different account.
async fn admitted_account(
  state: &crate::account::AccountState,
  api_base_url: &str,
) -> Result<Option<crate::account::LinkedAccount>, Stop> {
  let Some(account) = crate::account::current(state).await? else {
    return Err(Stop::AccountRequired);
  };
  if account.api_base_url != api_base_url {
    return Ok(None);
  }
  match crate::registry::request(
    account.request_auth(),
    serde_json::json!({"type":"config"}),
  )
  .await
  {
    Err(error) if error == crate::registry::not_connected() => {
      tracing::warn!(
        target: crate::logging::TRAIL_TARGET,
        event = "handoff.account_rejected",
        status = 401_u16
      );
      if let Err(error) = crate::account::invalidate(state, &account).await {
        tracing::warn!(error = %error, "rejected desktop account was not removed");
      }
      Err(Stop::AccountRequired)
    }
    // Anything else is the redeem's to report, with its own recovery.
    Ok(_) | Err(_) => Ok(Some(account)),
  }
}

struct RedeemCore<'a> {
  state: &'a crate::account::AccountState,
  client: &'a DesktopHttpClient,
  target: Target,
  api_base_url: &'a str,
  token: &'a str,
}

async fn redeem_with<T: serde::de::DeserializeOwned>(
  core: RedeemCore<'_>,
  host: &impl RecoveryHost,
) -> Result<(T, crate::account::LinkedAccount), Stop> {
  let RedeemCore {
    state,
    client,
    target,
    api_base_url,
    token,
  } = core;
  let mut account = admitted_account(state, api_base_url).await?;
  loop {
    let result = attempt_linked(LinkedRequestOptions {
      client,
      target,
      api_base_url,
      token,
      account,
    })
    .await;
    let failure = match result {
      Ok(redeemed) => return Ok(redeemed),
      Err(failure) => failure,
    };
    let message_key = failure.message_key();
    match recover(failure, host).await? {
      Recovery::Retry => {}
      Recovery::Stop => {
        return Err(Stop::Presented(crate::i18n::t(message_key).into()));
      }
    }
    account = crate::account::current(state)
      .await?
      .filter(|account| account.api_base_url == api_base_url);
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
) -> Result<(T, crate::account::LinkedAccount), Stop> {
  let RedeemOptions {
    manager,
    app,
    target,
    api_base_url,
    token,
  } = options;
  if crate::updater::check_on_handoff(app, manager).await {
    return Err(Stop::Presented(
      "Desktop update installed; reopen the document after relaunch.".into(),
    ));
  }
  let client = DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: None,
  })
  .map_err(|e| e.to_string())?;
  let state = app.state::<crate::account::AccountState>();
  redeem_with(
    RedeemCore {
      state: state.inner(),
      client: &client,
      target,
      api_base_url,
      token,
    },
    &DesktopRecovery { app, manager },
  )
  .await
}

/// Tells the API the desktop has no account for this handoff, so the web
/// stops waiting. Used once the user declines to link.
pub(crate) async fn decline(target: Target, api_base_url: &str, token: &str) {
  let Ok(client) = DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: None,
  }) else {
    return;
  };
  let result = attempt::<serde_json::Value>(RequestOptions {
    client: &client,
    target,
    api_base_url,
    token,
    credential: None,
  })
  .await;
  if !matches!(result, Err(Failure::AccountRequired)) {
    tracing::warn!("declined document handoff was not recorded");
  }
}

/// One handoff waits for the account link at a time; a newer deep link
/// replaces it. The token stays in native memory only.
pub(crate) struct ParkedHandoff {
  pub target: Target,
  pub api_base_url: String,
  pub token: zeroize::Zeroizing<String>,
  expires: std::time::Instant,
}

static PARKED: std::sync::Mutex<Option<ParkedHandoff>> = std::sync::Mutex::new(None);

pub(crate) fn park(target: Target, api_base_url: &str, token: &str) {
  park_at(target, api_base_url, token, std::time::Instant::now());
}

fn park_at(target: Target, api_base_url: &str, token: &str, now: std::time::Instant) {
  *PARKED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ParkedHandoff {
    target,
    api_base_url: api_base_url.into(),
    token: zeroize::Zeroizing::new(token.into()),
    expires: now + HANDOFF_LIFETIME,
  });
}

/// Drops the parked handoff if it is still `token`'s. Returns whether it was.
pub(crate) fn unpark(token: &str) -> bool {
  let mut parked = PARKED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner);
  if parked
    .as_ref()
    .is_some_and(|parked| parked.token.as_str() == token)
  {
    *parked = None;
    return true;
  }
  false
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Resumable {
  Nothing,
  Expired,
  Ready(ParkedHandoff),
}

impl std::fmt::Debug for ParkedHandoff {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter
      .debug_struct("ParkedHandoff")
      .field("target", &self.target)
      .field("api_base_url", &self.api_base_url)
      .finish_non_exhaustive()
  }
}
impl PartialEq for ParkedHandoff {
  fn eq(&self, other: &Self) -> bool {
    self.target == other.target
      && self.api_base_url == other.api_base_url
      && self.token == other.token
  }
}
impl Eq for ParkedHandoff {}

pub(crate) fn take_parked() -> Resumable {
  take_parked_at(std::time::Instant::now())
}

fn take_parked_at(now: std::time::Instant) -> Resumable {
  match PARKED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
    .take()
  {
    None => Resumable::Nothing,
    Some(parked) if now >= parked.expires => Resumable::Expired,
    Some(parked) => Resumable::Ready(parked),
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
  fn every_failure_shown_before_a_dialog_has_a_fixed_localized_message() {
    for failure in [
      Failure::UpdateRequired,
      Failure::AccountRequired,
      Failure::UntrustedServer,
      Failure::AccountMismatch,
      Failure::AccountChanged,
      Failure::AlreadyOpen,
      Failure::Expired,
      Failure::Retryable("detail".into()),
      Failure::Terminal("detail".into()),
    ] {
      assert!(
        crate::i18n::locales_missing(failure.message_key()).is_empty(),
        "{failure:?}"
      );
    }
  }

  fn linked_fixture(api_base_url: &str, key: &str) -> crate::account::LinkedAccount {
    crate::account::LinkedAccount {
      api_base_url: api_base_url.into(),
      web_origin: "https://web.example.test".into(),
      account: crate::types::LinkedAccountSnapshot {
        email: "desktop@example.test".into(),
        name: None,
        verified_at: chrono::Utc::now().to_rfc3339(),
      },
      identity: crate::types::DesktopAccountIdentity {
        user_id: "user_fixture".into(),
        organization_id: "org_fixture".into(),
      },
      credential: crate::types::DesktopAccountCredential {
        key: key.into(),
        expires_at: (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
      },
    }
  }

  /// A desktop API that accepts only `stella_dr_live` and counts redeems.
  async fn handoff_server(
    redeems: Arc<std::sync::atomic::AtomicUsize>,
  ) -> (String, tokio::task::JoinHandle<()>) {
    use axum::{Router, http::StatusCode, routing::post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let accepted = |headers: &axum::http::HeaderMap| {
      headers
        .get("authorization")
        .is_some_and(|value| value == "Bearer stella_dr_live")
    };
    let redeem = post(move |headers: axum::http::HeaderMap| {
      let redeems = redeems.clone();
      async move {
        redeems.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if accepted(&headers) {
          (
            StatusCode::OK,
            axum::Json(serde_json::json!({"id":"redeemed"})),
          )
        } else {
          (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"code":"desktop_account_required"})),
          )
        }
      }
    });
    let router = Router::new()
      .route(
        "/v1/desktop-registry/request",
        post(move |headers: axum::http::HeaderMap| async move {
          if accepted(&headers) {
            (StatusCode::OK, axum::Json(serde_json::json!({})))
          } else {
            (StatusCode::UNAUTHORIZED, axum::Json(serde_json::json!({})))
          }
        }),
      )
      .route(Target::DesktopEdit.path(), redeem.clone())
      .route(Target::PdfSigning.path(), redeem);
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    (origin, server)
  }

  fn no_recovery() -> FakeRecovery {
    FakeRecovery {
      events: Default::default(),
      accepted: false,
      update_outcome: std::sync::Mutex::new(None),
    }
  }

  // Every assertion on the single parked slot lives in this one test, so
  // parallel tests cannot race on it.
  #[tokio::test]
  async fn a_handoff_arriving_unlinked_waits_for_the_link_and_then_completes() {
    let redeems = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (origin, server) = handoff_server(redeems.clone()).await;
    let client = DesktopHttpClient::new(HttpClientOptions::default()).unwrap();
    let token = "a".repeat(64);
    let state: crate::account::AccountState =
      Arc::new(Mutex::new(crate::account::AccountStore::Memory(None)));

    for target in [Target::PdfSigning, Target::DesktopEdit] {
      // Unlinked: nothing is redeemed, so the server keeps the handoff open.
      let arrived = redeem_with::<serde_json::Value>(
        RedeemCore {
          state: &state,
          client: &client,
          target,
          api_base_url: &origin,
          token: &token,
        },
        &no_recovery(),
      )
      .await;
      assert!(matches!(arrived, Err(Stop::AccountRequired)));
      assert_eq!(redeems.load(std::sync::atomic::Ordering::SeqCst), 0);
      park(target, &origin, &token);

      // The account link completes; the parked handoff resumes with it.
      *state.lock().await = crate::account::AccountStore::Memory(Some(linked_fixture(
        &origin,
        "stella_dr_live",
      )));
      let Resumable::Ready(parked) = take_parked() else {
        panic!("the parked handoff must resume after linking");
      };
      assert_eq!(parked.target, target);
      let (redeemed, account) = redeem_with::<serde_json::Value>(
        RedeemCore {
          state: &state,
          client: &client,
          target: parked.target,
          api_base_url: &parked.api_base_url,
          token: &parked.token,
        },
        &no_recovery(),
      )
      .await
      .unwrap();
      assert_eq!(redeemed, serde_json::json!({"id":"redeemed"}));
      assert_eq!(account.credential.key, "stella_dr_live");
      assert_eq!(redeems.swap(0, std::sync::atomic::Ordering::SeqCst), 1);
      assert_eq!(take_parked(), Resumable::Nothing);
      *state.lock().await = crate::account::AccountStore::Memory(None);
    }

    // A saved credential the API rejects is dropped before any redeem.
    *state.lock().await = crate::account::AccountStore::Memory(Some(linked_fixture(
      &origin,
      "stella_dr_rejected_before_handoff",
    )));
    let rejected = redeem_with::<serde_json::Value>(
      RedeemCore {
        state: &state,
        client: &client,
        target: Target::PdfSigning,
        api_base_url: &origin,
        token: &token,
      },
      &no_recovery(),
    )
    .await;
    assert!(matches!(rejected, Err(Stop::AccountRequired)));
    assert_eq!(redeems.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(crate::account::current(&state).await.unwrap().is_none());

    // One slot, newest wins, and it lapses with the handoff's lifetime.
    let now = std::time::Instant::now();
    park_at(Target::DesktopEdit, &origin, "first", now);
    park_at(Target::PdfSigning, &origin, "second", now);
    assert!(!unpark("first"));
    assert!(unpark("second"));
    assert_eq!(take_parked_at(now), Resumable::Nothing);
    park_at(Target::PdfSigning, &origin, "late", now);
    assert_eq!(take_parked_at(now + HANDOFF_LIFETIME), Resumable::Expired);
    assert_eq!(take_parked_at(now), Resumable::Nothing);
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
    assert_eq!(
      declaration("DESKTOP_HANDOFF_LIFETIME_SECONDS")
        .parse::<u64>()
        .unwrap(),
      HANDOFF_LIFETIME.as_secs()
    );
  }
}
