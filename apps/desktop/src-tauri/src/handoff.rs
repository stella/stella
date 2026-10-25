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
pub(crate) const HANDOFF_LIFETIME: Duration = Duration::from_secs(120);

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
  credential: Option<crate::registry::RegistryRequestAuth<'a>>,
}

fn request(
  RequestOptions {
    client,
    target,
    api_base_url,
    token,
    credential,
  }: RequestOptions<'_>,
) -> Result<crate::http_client::DeviceProofRequest, String> {
  let builder = client
    .post(format!("{api_base_url}{}", target.path()))
    .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string())
    .json(&RedeemRequest {
      handoff_token: token,
    })
    .timeout(REDEEM_TIMEOUT);
  match credential {
    Some(auth) => crate::http_client::device_proof_request(
      builder,
      auth.device_key,
      Some(auth.credential_key),
      None,
    ),
    None => crate::http_client::unsigned_request(builder),
  }
}

async fn attempt<T: serde::de::DeserializeOwned>(
  options: RequestOptions<'_>,
) -> Result<T, Failure> {
  let response = request(options)
    .map_err(Failure::Terminal)?
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
  account: Option<&'a crate::account::AccountRequest>,
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
    credential: account.map(|account| account.request_auth()),
  })
  .await?;
  match account {
    Some(account) => Ok((redeemed, (**account).clone())),
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
      | crate::updater::CheckOutcome::UpToDate
      | crate::updater::CheckOutcome::Disabled => {}
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
  /// A live account must be explicitly disconnected before linking this server.
  AccountMismatch(AccountMismatch),
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

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AccountMismatch {
  pub linked_server: String,
  pub requested_server: String,
}

impl AccountMismatch {
  pub(crate) fn message(&self) -> String {
    crate::i18n::t_fmt(
      "dialog.handoffServerMismatch",
      &[
        ("linkedServer", &self.linked_server),
        ("requestedServer", &self.requested_server),
      ],
    )
  }
}

pub(crate) async fn account_mismatch(
  state: &crate::account::AccountState,
  api_base_url: &str,
) -> Result<Option<AccountMismatch>, String> {
  Ok(crate::account::current(state).await?.and_then(|account| {
    (account.api_base_url != api_base_url).then(|| AccountMismatch {
      linked_server: account.api_base_url,
      requested_server: api_base_url.into(),
    })
  }))
}

/// The account a redemption may present. An unlinked desktop, or one whose
/// saved credential the API rejects, must not redeem: an unauthenticated
/// redeem ends the handoff on the server, and the user is about to link.
/// An account on another server requires an explicit disconnect first; it
/// must never send an unauthenticated redemption for the new handoff.
async fn admitted_account(
  state: &crate::account::AccountState,
  api_base_url: &str,
) -> Result<crate::account::AccountRequest, Stop> {
  let account = match crate::account::foreground_account(state).await {
    Ok(account) => account,
    Err(error) if error == crate::registry::not_connected() => {
      return Err(Stop::AccountRequired);
    }
    Err(error) => return Err(error.into()),
  };
  let Some(account) = account else {
    return Err(Stop::AccountRequired);
  };
  if account.api_base_url != api_base_url {
    return Err(Stop::AccountMismatch(AccountMismatch {
      linked_server: account.api_base_url.clone(),
      requested_server: api_base_url.into(),
    }));
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
    Ok(_) | Err(_) => Ok(account),
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
      account: Some(&account),
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
    drop(account);
    account = admitted_account(state, api_base_url).await?;
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
#[derive(Clone)]
pub(crate) struct ParkedHandoff {
  pub target: Target,
  pub api_base_url: String,
  pub token: zeroize::Zeroizing<String>,
  pub expires: std::time::Instant,
  recovery: AccountRecovery,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AccountRecovery {
  OfferRequired,
  AwaitingAccount,
}

static PARKED: std::sync::Mutex<Option<ParkedHandoff>> = std::sync::Mutex::new(None);
static ACCOUNT_OFFER: Mutex<()> = Mutex::const_new(());
static CONNECTION_START: Mutex<()> = Mutex::const_new(());

pub(crate) trait ConnectionHost: Sync {
  type Prepared: Send;
  fn web_origin(
    &self,
    api_base_url: &str,
  ) -> impl std::future::Future<Output = Option<String>> + Send;
  fn prepare(
    &self,
    api_base_url: &str,
    web_origin: &str,
  ) -> impl std::future::Future<Output = Result<Self::Prepared, String>> + Send;
  fn open(
    &self,
    prepared: Self::Prepared,
  ) -> Result<crate::account::ConnectionStart, String>;
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OfferConnection {
  NotCurrent,
  Expired,
  Started(crate::account::ConnectionStart),
  AccountMismatch(AccountMismatch),
}

/// Replacements queue behind the active offer instead of losing their dialog.
/// The lease checks token and API ownership again after the user's response.
pub(crate) struct AccountOffer {
  token: zeroize::Zeroizing<String>,
  api_base_url: String,
  _lease: tokio::sync::MutexGuard<'static, ()>,
}

pub(crate) async fn account_offer(token: &str, api_base_url: &str) -> AccountOffer {
  AccountOffer {
    token: zeroize::Zeroizing::new(token.into()),
    api_base_url: api_base_url.into(),
    _lease: ACCOUNT_OFFER.lock().await,
  }
}

impl AccountOffer {
  pub(crate) async fn connect(
    &self,
    host: &impl ConnectionHost,
    state: &crate::account::AccountState,
  ) -> Result<OfferConnection, Failure> {
    let original = match self.pending() {
      Resumable::Nothing => return Ok(OfferConnection::NotCurrent),
      Resumable::Expired => return Ok(OfferConnection::Expired),
      Resumable::Ready(parked) => parked,
    };
    let web_origin = host
      .web_origin(&original.api_base_url)
      .await
      .ok_or(Failure::UntrustedServer)?;
    let prepared = host
      .prepare(&original.api_base_url, &web_origin)
      .await
      .map_err(Failure::Terminal)?;
    // Preparation has no reservation or browser side effect. Revalidate only
    // after every await, then reserve and open under the same lease as parking.
    let _start = CONNECTION_START.lock().await;
    let _account = crate::account::lock_requests().await;
    let mismatch = account_mismatch(state, &original.api_base_url)
      .await
      .map_err(Failure::Terminal)?;
    let mut parked = PARKED
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(current) = parked.as_mut() else {
      return Ok(OfferConnection::NotCurrent);
    };
    if current.token != original.token
      || current.api_base_url != original.api_base_url
      || current.recovery != AccountRecovery::OfferRequired
    {
      return Ok(OfferConnection::NotCurrent);
    }
    if std::time::Instant::now() >= current.expires {
      parked.take();
      return Ok(OfferConnection::Expired);
    }
    if let Some(mismatch) = mismatch {
      return Ok(OfferConnection::AccountMismatch(mismatch));
    }
    let outcome = host.open(prepared).map_err(Failure::Terminal)?;
    current.recovery = AccountRecovery::AwaitingAccount;
    drop(parked);
    Ok(OfferConnection::Started(outcome))
  }

  pub(crate) fn pending(&self) -> Resumable {
    self.pending_at(std::time::Instant::now())
  }

  fn pending_at(&self, now: std::time::Instant) -> Resumable {
    let mut parked = PARKED
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner);
    let resumable = match parked.as_ref() {
      Some(current)
        if current.token.as_str() == self.token.as_str()
          && current.api_base_url == self.api_base_url =>
      {
        if now >= current.expires {
          Resumable::Expired
        } else if current.recovery == AccountRecovery::AwaitingAccount {
          Resumable::Nothing
        } else {
          Resumable::Ready(current.clone())
        }
      }
      _ => Resumable::Nothing,
    };
    if matches!(resumable, Resumable::Expired) {
      parked.take();
    }
    drop(parked);
    resumable
  }
}

/// A parked token gets an expiry notice even if the browser never completes.
pub(crate) async fn expire_parked(token: &str, api_base_url: &str) -> Resumable {
  let expires = PARKED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
    .as_ref()
    .filter(|current| {
      current.token.as_str() == token && current.api_base_url == api_base_url
    })
    .map(|current| current.expires);
  let Some(expires) = expires else {
    return Resumable::Nothing;
  };
  tokio::time::sleep_until(tokio::time::Instant::from_std(expires)).await;
  account_offer(token, api_base_url).await.pending()
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AccountWait {
  Parked,
  AccountAvailable,
  Expired,
}

pub(crate) async fn park_if_unlinked(
  state: &crate::account::AccountState,
  target: Target,
  api_base_url: &str,
  token: &str,
  expires: std::time::Instant,
) -> Result<AccountWait, String> {
  if std::time::Instant::now() >= expires {
    return Ok(AccountWait::Expired);
  }
  // Linking shares this lease: it either publishes before this check, or
  // publishes after the handoff is parked and its completion can resume it.
  let _start = CONNECTION_START.lock().await;
  let _lease = crate::account::lock_requests().await;
  let account = crate::account::current(state).await?;
  if std::time::Instant::now() >= expires {
    return Ok(AccountWait::Expired);
  }
  if account.is_some_and(|account| account.api_base_url == api_base_url) {
    return Ok(AccountWait::AccountAvailable);
  }
  park_until(target, api_base_url, token, expires);
  Ok(AccountWait::Parked)
}

fn park_until(
  target: Target,
  api_base_url: &str,
  token: &str,
  expires: std::time::Instant,
) {
  *PARKED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ParkedHandoff {
    target,
    api_base_url: api_base_url.into(),
    token: zeroize::Zeroizing::new(token.into()),
    expires,
    recovery: AccountRecovery::OfferRequired,
  });
}

/// Drops the parked handoff only for the same token and API origin.
pub(crate) fn unpark(token: &str, api_base_url: &str) -> bool {
  PARKED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
    .take_if(|parked| {
      parked.token.as_str() == token && parked.api_base_url == api_base_url
    })
    .is_some()
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Resumable {
  Nothing,
  Expired,
  Ready(ParkedHandoff),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ResumeAfterLink {
  Nothing,
  Expired,
  Ready(ParkedHandoff),
  NeedsOffer(ParkedHandoff),
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

#[cfg(test)]
fn take_parked() -> Resumable {
  take_parked_at(std::time::Instant::now())
}

#[cfg(test)]
fn take_parked_at(now: std::time::Instant) -> Resumable {
  let parked = PARKED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
    .take();
  match parked {
    None => Resumable::Nothing,
    Some(parked) if now >= parked.expires => Resumable::Expired,
    Some(parked) => Resumable::Ready(parked),
  }
}

pub(crate) async fn take_parked_for_account(api_base_url: &str) -> ResumeAfterLink {
  let _start = CONNECTION_START.lock().await;
  let mut parked = PARKED
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner);
  let Some(current) = parked.as_mut() else {
    return ResumeAfterLink::Nothing;
  };
  if std::time::Instant::now() >= current.expires {
    parked.take();
    return ResumeAfterLink::Expired;
  }
  if current.api_base_url == api_base_url {
    return ResumeAfterLink::Ready(
      parked.take().expect("the parked handoff was checked above"),
    );
  }
  let outcome = match current.recovery {
    AccountRecovery::OfferRequired => ResumeAfterLink::Nothing,
    AccountRecovery::AwaitingAccount => {
      current.recovery = AccountRecovery::OfferRequired;
      ResumeAfterLink::NeedsOffer(current.clone())
    }
  };
  drop(parked);
  outcome
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::future::Future;
  #[test]
  fn both_redeems_send_protocol_bearer_and_token_in_body() {
    let device_key = crate::device_proof::DeviceKey::fixture();
    let client = DesktopHttpClient::new(HttpClientOptions::default()).unwrap();
    for target in [Target::DesktopEdit, Target::PdfSigning] {
      let req = request(RequestOptions {
        client: &client,
        target,
        api_base_url: "https://api.example.test",
        token: "secret-token",
        credential: Some(crate::registry::RegistryRequestAuth {
          api_base_url: "",
          credential_key: "account-key",
          device_key: &device_key,
        }),
      })
      .unwrap()
      .build();
      assert_eq!(req.method(), reqwest::Method::POST);
      assert_eq!(req.url().path(), target.path());
      assert_eq!(req.headers()[PROTOCOL_HEADER], "1");
      assert_eq!(req.headers()["authorization"], "Bearer account-key");
      crate::device_proof::tests::verify_request(
        &req,
        &device_key.thumbprint().unwrap(),
        Some("account-key"),
        None,
      );
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
          credential: Some(crate::registry::RegistryRequestAuth {
            api_base_url: "",
            credential_key: "account-key",
            device_key: &crate::device_proof::DeviceKey::fixture(),
          }),
        })
        .await;
        assert_eq!(result, Err(expected));
      }
      let result = attempt::<serde_json::Value>(RequestOptions {
        client: &client,
        target,
        api_base_url: &origin,
        token: "valid",
        credential: Some(crate::registry::RegistryRequestAuth {
          api_base_url: "",
          credential_key: "account-key",
          device_key: &crate::device_proof::DeviceKey::fixture(),
        }),
      })
      .await
      .unwrap();
      assert_eq!(result, serde_json::json!({"id":"redeemed"}));
      let account = crate::account::LinkedAccount {
        device_key: crate::device_proof::DeviceKey::fixture(),
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
      let account = crate::account::AccountRequest::fixture(account).await;
      let (redeemed, linked) =
        attempt_linked::<serde_json::Value>(LinkedRequestOptions {
          client: &client,
          target,
          api_base_url: &origin,
          token: "valid",
          account: Some(&account),
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
      credential: Some(crate::registry::RegistryRequestAuth {
        api_base_url: "",
        credential_key: "key",
        device_key: &crate::device_proof::DeviceKey::fixture(),
      }),
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
          device_key: crate::device_proof::DeviceKey::fixture(),
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
        let account = match account {
          Some(account) => Some(crate::account::AccountRequest::fixture(account).await),
          None => None,
        };
        let result = attempt_linked::<serde_json::Value>(LinkedRequestOptions {
          client: &client,
          target,
          api_base_url: &origin,
          token: "token",
          account: account.as_ref(),
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
      device_key: crate::device_proof::DeviceKey::fixture(),
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
        "/v1/desktop-registry/renew",
        post(|| async { StatusCode::TOO_MANY_REQUESTS }),
      )
      .route(
        "/v1/desktop-registry/request",
        post(move |headers: axum::http::HeaderMap| async move {
          if accepted(&headers) || headers.get("authorization").is_some_and(|value| value == "Bearer stella_dr_account_a") {
            (StatusCode::OK, axum::Json(serde_json::json!({
              "account": {
                "email": "desktop@example.test",
                "name": null,
                "verifiedAt": "2026-10-01T00:00:00Z"
              },
              "identity": { "userId": "user_fixture", "organizationId": "org_fixture" }
            })))
          } else {
            (
              StatusCode::UNAUTHORIZED,
              axum::Json(
                serde_json::json!({"message":"Reconnect desktop to your account"}),
              ),
            )
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

  #[derive(Clone, Copy, PartialEq, Eq)]
  enum ConnectionAwait {
    OriginLookup,
    BrowserPreparation,
  }

  struct FakeConnectionHost {
    paused_at: Option<ConnectionAwait>,
    gate: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    opened: std::sync::Mutex<Vec<String>>,
    outcome: crate::account::ConnectionStart,
  }

  impl FakeConnectionHost {
    async fn pause(&self, stage: ConnectionAwait) {
      if self.paused_at != Some(stage) {
        return;
      }
      let receiver = self.gate.lock().unwrap().take().unwrap();
      receiver.await.unwrap();
    }
  }

  impl ConnectionHost for FakeConnectionHost {
    type Prepared = String;

    async fn web_origin(&self, _: &str) -> Option<String> {
      self.pause(ConnectionAwait::OriginLookup).await;
      Some("https://web.example.test".into())
    }

    async fn prepare(&self, api_base_url: &str, _: &str) -> Result<String, String> {
      self.pause(ConnectionAwait::BrowserPreparation).await;
      Ok(api_base_url.into())
    }

    fn open(
      &self,
      api_base_url: String,
    ) -> Result<crate::account::ConnectionStart, String> {
      self.opened.lock().unwrap().push(api_base_url);
      Ok(self.outcome)
    }
  }

  fn immediate_connection(
    outcome: crate::account::ConnectionStart,
  ) -> FakeConnectionHost {
    FakeConnectionHost {
      paused_at: None,
      gate: std::sync::Mutex::new(None),
      opened: Default::default(),
      outcome,
    }
  }

  // Every assertion on the single parked slot lives in this one test, so
  // parallel tests cannot race on it.
  #[tokio::test]
  async fn a_handoff_arriving_unlinked_waits_for_the_link_and_then_completes() {
    crate::i18n::init_en();
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
      assert_eq!(
        park_if_unlinked(
          &state,
          target,
          &origin,
          &token,
          std::time::Instant::now() + HANDOFF_LIFETIME
        )
        .await
        .unwrap(),
        AccountWait::Parked
      );

      // The account link completes; the parked handoff resumes with it.
      *state.lock().await = crate::account::AccountStore::fixture(linked_fixture(
        &origin,
        "stella_dr_live",
      ));
      let ResumeAfterLink::Ready(parked) = take_parked_for_account(&origin).await
      else {
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

    // Complete exactly after admission fails and before parking. The
    // completion callback sees no parked token; parking must notice the account.
    for target in [Target::PdfSigning, Target::DesktopEdit] {
      assert!(matches!(
        admitted_account(&state, &origin).await,
        Err(Stop::AccountRequired)
      ));
      {
        let _lease = crate::account::lock_requests().await;
        *state.lock().await = crate::account::AccountStore::fixture(linked_fixture(
          &origin,
          "stella_dr_live",
        ));
      }
      assert_eq!(take_parked(), Resumable::Nothing);
      assert_eq!(
        park_if_unlinked(
          &state,
          target,
          &origin,
          &token,
          std::time::Instant::now() + HANDOFF_LIFETIME
        )
        .await
        .unwrap(),
        AccountWait::AccountAvailable,
        "a completed link must resume immediately without another connection offer"
      );
      let (redeemed, account) = redeem_with::<serde_json::Value>(
        RedeemCore {
          state: &state,
          client: &client,
          target,
          api_base_url: &origin,
          token: &token,
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

    // A replacement owns the next offer; cancelling the old dialog cannot
    // strand it. Poll the queued lease once to deterministically hold the dialog.
    let now = std::time::Instant::now();
    park_until(
      Target::DesktopEdit,
      &origin,
      "first",
      now + HANDOFF_LIFETIME,
    );
    let first_offer = account_offer("first", &origin).await;
    assert!(matches!(first_offer.pending(), Resumable::Ready(_)));
    park_until(
      Target::PdfSigning,
      &origin,
      "second",
      now + HANDOFF_LIFETIME,
    );
    let mut second_offer = std::pin::pin!(account_offer("second", &origin));
    assert!(
      std::future::poll_fn(|cx| std::task::Poll::Ready(
        second_offer.as_mut().poll(cx).is_pending()
      ))
      .await,
      "a replacement must queue behind the active offer"
    );
    assert_eq!(first_offer.pending(), Resumable::Nothing);
    assert!(!unpark("first", &origin));
    drop(first_offer);
    let second_offer = second_offer.await;
    let Resumable::Ready(offered) = second_offer.pending() else {
      panic!("cancelling a superseded offer must offer the current token");
    };
    assert_eq!(offered.token.as_str(), "second");
    assert_eq!(offered.target, Target::PdfSigning);
    assert!(unpark("second", &origin));
    assert_eq!(second_offer.pending(), Resumable::Nothing);
    drop(second_offer);

    // Completion during the old dialog resumes the replacement exactly once;
    // neither the old response nor its queued offer may act on the resumed token.
    park_until(
      Target::DesktopEdit,
      &origin,
      "first",
      now + HANDOFF_LIFETIME,
    );
    let first_offer = account_offer("first", &origin).await;
    park_until(Target::PdfSigning, &origin, &token, now + HANDOFF_LIFETIME);
    let mut second_offer = std::pin::pin!(account_offer(&token, &origin));
    assert!(
      std::future::poll_fn(|cx| std::task::Poll::Ready(
        second_offer.as_mut().poll(cx).is_pending()
      ))
      .await,
      "a replacement must queue behind the active offer"
    );
    {
      let _lease = crate::account::lock_requests().await;
      *state.lock().await = crate::account::AccountStore::fixture(linked_fixture(
        &origin,
        "stella_dr_live",
      ));
    }
    let ResumeAfterLink::Ready(resumed) = take_parked_for_account(&origin).await else {
      panic!("a link completed during the old offer must resume the replacement");
    };
    assert_eq!(resumed.token.as_str(), token);
    assert_eq!(resumed.target, Target::PdfSigning);
    let (_, account) = redeem_with::<serde_json::Value>(
      RedeemCore {
        state: &state,
        client: &client,
        target: resumed.target,
        api_base_url: &resumed.api_base_url,
        token: &resumed.token,
      },
      &no_recovery(),
    )
    .await
    .unwrap();
    assert_eq!(account.credential.key, "stella_dr_live");
    assert_eq!(redeems.swap(0, std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(first_offer.pending(), Resumable::Nothing);
    drop(first_offer);
    let second_offer = second_offer.await;
    assert_eq!(second_offer.pending(), Resumable::Nothing);
    drop(second_offer);
    assert_eq!(take_parked(), Resumable::Nothing);
    *state.lock().await = crate::account::AccountStore::Memory(None);

    // A queued replacement that has expired gets one notice instead of an offer.
    park_until(
      Target::DesktopEdit,
      &origin,
      "first",
      now + HANDOFF_LIFETIME,
    );
    let first_offer = account_offer("first", &origin).await;
    park_until(
      Target::PdfSigning,
      &origin,
      "second",
      now + HANDOFF_LIFETIME,
    );
    drop(first_offer);
    let second_offer = account_offer("second", &origin).await;
    assert_eq!(
      second_offer.pending_at(now + HANDOFF_LIFETIME),
      Resumable::Expired
    );
    assert_eq!(
      second_offer.pending_at(now + HANDOFF_LIFETIME),
      Resumable::Nothing
    );
    drop(second_offer);

    // Both asynchronous preparations can be superseded. Reservation and launch
    // must revalidate the token AND origin after the last await.
    for stage in [
      ConnectionAwait::OriginLookup,
      ConnectionAwait::BrowserPreparation,
    ] {
      for (replacement_api, replacement_token) in [
        (origin.as_str(), "second"),
        ("https://other.example.test", "second"),
        ("https://other.example.test", "first"),
      ] {
        let expires = std::time::Instant::now() + HANDOFF_LIFETIME;
        assert_eq!(
          park_if_unlinked(&state, Target::DesktopEdit, &origin, "first", expires)
            .await
            .unwrap(),
          AccountWait::Parked
        );
        let first_offer = account_offer("first", &origin).await;
        let (release, receiver) = tokio::sync::oneshot::channel();
        let host = FakeConnectionHost {
          paused_at: Some(stage),
          gate: std::sync::Mutex::new(Some(receiver)),
          opened: Default::default(),
          outcome: crate::account::ConnectionStart::Started,
        };
        {
          let mut connection = std::pin::pin!(first_offer.connect(&host, &state));
          assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(
              connection.as_mut().poll(cx).is_pending()
            ))
            .await,
            "the regression must reach the selected await"
          );
          assert_eq!(
            park_if_unlinked(
              &state,
              Target::PdfSigning,
              replacement_api,
              replacement_token,
              expires
            )
            .await
            .unwrap(),
            AccountWait::Parked
          );
          release.send(()).unwrap();
          assert_eq!(
            connection.await.unwrap(),
            OfferConnection::NotCurrent,
            "a replaced token cannot reserve or open a browser connection after an await"
          );
          assert!(host.opened.lock().unwrap().is_empty());
        }
        drop(first_offer);

        let second_offer = account_offer(replacement_token, replacement_api).await;
        let Resumable::Ready(current) = second_offer.pending() else {
          panic!("the replacement must get its own offer");
        };
        assert_eq!(current.api_base_url, replacement_api);
        let second_host =
          immediate_connection(crate::account::ConnectionStart::Started);
        assert_eq!(
          second_offer.connect(&second_host, &state).await.unwrap(),
          OfferConnection::Started(crate::account::ConnectionStart::Started)
        );
        assert_eq!(*second_host.opened.lock().unwrap(), [replacement_api]);
        drop(second_offer);
        if replacement_api != origin {
          let ResumeAfterLink::NeedsOffer(reoffered) =
            take_parked_for_account(&origin).await
          else {
            panic!("a different-server completion must re-offer instead of resuming");
          };
          assert_eq!(reoffered.api_base_url, replacement_api);
          let second_offer = account_offer(replacement_token, replacement_api).await;
          assert!(matches!(second_offer.pending(), Resumable::Ready(_)));
          drop(second_offer);
        }
        let ResumeAfterLink::Ready(resumed) =
          take_parked_for_account(replacement_api).await
        else {
          panic!("only a matching-server completion may resume the replacement");
        };
        assert_eq!(resumed.token.as_str(), replacement_token);
        assert_eq!(resumed.api_base_url, replacement_api);
        assert_eq!(
          take_parked_for_account(replacement_api).await,
          ResumeAfterLink::Nothing
        );
      }
    }

    // Admission and the browser offer must agree with real persistence:
    // a live account cannot be replaced until the user disconnects it.
    let (server_a, server_a_task) = handoff_server(Arc::new(Default::default())).await;
    for target in [Target::DesktopEdit, Target::PdfSigning] {
      let live_a = linked_fixture(&server_a, "stella_dr_account_a");
      let live_b = linked_fixture(&origin, "stella_dr_live");
      {
        let mut store = state.lock().await;
        assert_eq!(
          store.link_fixture(live_a.clone()).await.unwrap(),
          crate::account::LinkOutcome::Linked
        );
        assert_eq!(
          store.link_fixture(live_b.clone()).await.unwrap_err(),
          "Disconnect the current desktop account before connecting another"
        );
        drop(store);
      }
      let mismatch = AccountMismatch {
        linked_server: server_a.clone(),
        requested_server: origin.clone(),
      };
      assert_eq!(
        account_mismatch(&state, &origin).await.unwrap(),
        Some(AccountMismatch {
          linked_server: server_a.clone(),
          requested_server: origin.clone()
        })
      );
      assert_eq!(
        admitted_account(&state, &origin).await.err().unwrap(),
        Stop::AccountMismatch(mismatch)
      );
      assert!(crate::i18n::locales_missing("dialog.handoffServerMismatch").is_empty());
      let notice = account_mismatch(&state, &origin)
        .await
        .unwrap()
        .unwrap()
        .message();
      assert!(notice.contains(&server_a));
      assert!(notice.contains(&origin));
      let before = redeems.load(std::sync::atomic::Ordering::SeqCst);
      let expires = std::time::Instant::now() + HANDOFF_LIFETIME;
      assert_eq!(
        park_if_unlinked(&state, target, &origin, "mismatch", expires)
          .await
          .unwrap(),
        AccountWait::Parked
      );
      let offer = account_offer("mismatch", &origin).await;
      let host = immediate_connection(crate::account::ConnectionStart::Started);
      assert!(matches!(
        offer.connect(&host, &state).await.unwrap(),
        OfferConnection::AccountMismatch(_)
      ));
      assert!(host.opened.lock().unwrap().is_empty());
      assert!(matches!(offer.pending(), Resumable::Ready(_)));
      assert_eq!(
        crate::account::current(&state)
          .await
          .unwrap()
          .unwrap()
          .api_base_url,
        server_a
      );
      drop(offer);
      {
        let mut store = state.lock().await;
        store.disconnect_fixture().await.unwrap();
        assert_eq!(
          store.link_fixture(live_b).await.unwrap(),
          crate::account::LinkOutcome::Linked
        );
        drop(store);
      }
      let resumed = match take_parked_for_account(&origin).await {
        ResumeAfterLink::Ready(parked) => parked,
        outcome => {
          panic!("explicit disconnect and connection must resume: {outcome:?}")
        }
      };
      assert_eq!(resumed.target, target);
      assert_eq!(resumed.token.as_str(), "mismatch");
      assert_eq!(
        take_parked_for_account(&origin).await,
        ResumeAfterLink::Nothing
      );
      let (redeemed, account) = redeem_with::<serde_json::Value>(
        RedeemCore {
          state: &state,
          client: &client,
          target,
          api_base_url: &origin,
          token: &resumed.token,
        },
        &no_recovery(),
      )
      .await
      .unwrap();
      assert_eq!(redeemed, serde_json::json!({"id":"redeemed"}));
      assert_eq!(account.api_base_url, origin);
      assert_eq!(
        redeems.load(std::sync::atomic::Ordering::SeqCst),
        before + 1
      );
      state.lock().await.disconnect_fixture().await.unwrap();
    }

    server_a_task.abort();
    redeems.store(0, std::sync::atomic::Ordering::SeqCst);

    // A different-origin pending connection has its own state and re-offer,
    // rather than pretending the replacement can use the pending account.
    let other_api = "https://other.example.test";
    let expires = std::time::Instant::now() + HANDOFF_LIFETIME;
    *state.lock().await =
      crate::account::AccountStore::fixture(linked_fixture(&origin, "stella_dr_live"));
    assert!(matches!(
      admitted_account(&state, other_api).await,
      Err(Stop::AccountMismatch(_))
    ));
    assert_eq!(
      park_if_unlinked(&state, Target::PdfSigning, other_api, "other", expires)
        .await
        .unwrap(),
      AccountWait::Parked
    );
    *state.lock().await = crate::account::AccountStore::Memory(None);
    let other_offer = account_offer("other", other_api).await;
    let other_host =
      immediate_connection(crate::account::ConnectionStart::DifferentOriginPending);
    assert_eq!(
      other_offer.connect(&other_host, &state).await.unwrap(),
      OfferConnection::Started(crate::account::ConnectionStart::DifferentOriginPending)
    );
    drop(other_offer);
    assert!(matches!(
      take_parked_for_account(&origin).await,
      ResumeAfterLink::NeedsOffer(_)
    ));
    let other_offer = account_offer("other", other_api).await;
    assert!(matches!(other_offer.pending(), Resumable::Ready(_)));
    assert!(unpark("other", other_api));
    drop(other_offer);
    *state.lock().await = crate::account::AccountStore::Memory(None);

    // Parking an aged link preserves its arrival deadline, including across
    // a resumed handoff; no new account offer may renew the server token.
    for target in [Target::DesktopEdit, Target::PdfSigning] {
      let arrived = std::time::Instant::now() - Duration::from_secs(115);
      let original_expiry = arrived + HANDOFF_LIFETIME;
      assert_eq!(
        park_if_unlinked(&state, target, &origin, &token, original_expiry)
          .await
          .unwrap(),
        AccountWait::Parked
      );
      let offer = account_offer(&token, &origin).await;
      let Resumable::Ready(aged) =
        offer.pending_at(original_expiry - Duration::from_nanos(1))
      else {
        panic!("an aged handoff keeps only its remaining lifetime");
      };
      assert_eq!(
        aged.expires, original_expiry,
        "parking must preserve the original deadline"
      );
      assert_eq!(offer.pending_at(original_expiry), Resumable::Expired);
      drop(offer);
      assert_eq!(take_parked(), Resumable::Nothing);
      assert_eq!(
        park_if_unlinked(
          &state,
          target,
          &origin,
          &token,
          std::time::Instant::now() - Duration::from_nanos(1)
        )
        .await
        .unwrap(),
        AccountWait::Expired,
        "an already-expired handoff must go to its notice without an account offer"
      );
      assert_eq!(take_parked(), Resumable::Nothing);
    }

    // A saved credential the API rejects is dropped before any redeem.
    *state.lock().await = crate::account::AccountStore::fixture(linked_fixture(
      &origin,
      "stella_dr_rejected_before_handoff",
    ));
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
    park_until(
      Target::DesktopEdit,
      &origin,
      "first",
      now + HANDOFF_LIFETIME,
    );
    park_until(
      Target::PdfSigning,
      &origin,
      "second",
      now + HANDOFF_LIFETIME,
    );
    assert!(!unpark("first", &origin));
    assert!(unpark("second", &origin));
    assert_eq!(take_parked_at(now), Resumable::Nothing);
    park_until(Target::PdfSigning, &origin, "late", now + HANDOFF_LIFETIME);
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
