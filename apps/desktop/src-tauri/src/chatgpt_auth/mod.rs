//! Sign in with ChatGPT for the local agents: the open-source direct flow
//! that lets the user's own Codex run on their ChatGPT plan.
//!
//! First sign-in registers a client with `client_id=dynamic_agent_client`,
//! `agent_name_hint=Stella` and this installation's `ext_agent_host_id`; the
//! issued `oaiapp_…` client ID is kept and reused for every later sign-in and
//! renewal. Each attempt uses fresh `state`, `nonce` and an S256 PKCE
//! verifier, a single-use loopback listener on `127.0.0.1`, and a time limit.
//! The ID token is verified against the issuer's JWKS, and the connection is
//! usable only when the token response grants `chatgpt.tokens.use.direct`.
//!
//! Tokens stay on this computer: they are stored through [`store`], handed
//! only to the local Codex process through the token broker, and never
//! logged, emitted to a window or sent to Stella's servers.
//!
//! The design follows t3code's `CodexChatGptAuth` (MIT): registration
//! profiles keyed by issued client ID, subject checks on reauthorization,
//! serialized refresh with rotated refresh tokens saved together, and
//! best-effort revocation on sign-out.

mod id_token;
mod oauth;
mod store;
#[cfg(test)]
mod tests;

use std::{
  sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
  },
  time::Duration,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::http_client::DesktopHttpClient;
pub(crate) use oauth::{AGENT_NAME, RESOURCE};
use oauth::{
  AuthorizationRequest, CallbackListener, CallbackPage, CallbackRejection,
  CallbackResult, CallbackSlot, ClientSelection, DeliveredCallback, PLAN_USAGE_SCOPE,
  Pkce,
};
use store::{
  ChatGptRecord, ChatGptRegistration, ChatGptSession, ChatGptVault, VaultUnavailable,
};
pub(crate) use store::{FileVault, KeychainSecrets};

/// Renew when the access token has less than this left.
const RENEW_BEFORE_EXPIRY_MS: i64 = 60_000;
const REFRESH_TIMEOUT: Duration = Duration::from_secs(20);
const REVOKE_ATTEMPTS: usize = 3;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

/// Refresh errors after which the stored tokens can never work again.
const UNUSABLE_REFRESH_ERRORS: &[&str] = &[
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
];

pub(crate) struct ChatGptAuthConfig {
  pub discovery_url: String,
  /// The issuer discovery must report; every endpoint shares its origin.
  pub issuer: String,
  pub resource: String,
  pub sign_in_timeout: Duration,
  /// How long the browser's callback page waits for the outcome.
  pub page_wait: Duration,
}

impl ChatGptAuthConfig {
  pub(crate) fn openai() -> Self {
    Self {
      discovery_url: "https://auth.openai.com/.well-known/openid-configuration".into(),
      issuer: "https://auth.openai.com".into(),
      resource: oauth::RESOURCE.into(),
      sign_in_timeout: Duration::from_secs(10 * 60),
      page_wait: Duration::from_secs(30),
    }
  }
}

/// What a window may know about the connection. It carries no token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ChatGptStatus {
  SignedOut,
  SigningIn,
  Connected {
    email: Option<String>,
    plan: Option<String>,
  },
  NeedsReconnect {
    email: Option<String>,
  },
  Failed {
    reason: ChatGptFailure,
  },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatGptFailure {
  /// The user declined in the browser.
  Declined,
  /// Signed in, but ChatGPT plan usage was not allowed.
  PlanUsageNotGranted,
  /// A returning sign-in came back with another account.
  DifferentAccount,
  /// The callback belonged to another attempt.
  StateMismatch,
  TimedOut,
  BrowserUnavailable,
  CallbackUnavailable,
  /// The callback lacked what registration returns.
  RegistrationIncomplete,
  /// The code was used or expired before the exchange.
  CodeExpired,
  /// The ID token or token response did not verify.
  Verification,
  /// OpenAI rejected this app's client registration.
  ClientRejected,
  /// The sign-in service could not be reached.
  Unreachable,
  Storage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInIntent {
  /// Reuse the saved registration when there is one.
  SameAccount,
  /// Register a new client for another account.
  NewAccount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CallbackUrlError {
  NoSignIn,
  NotThisSignIn,
}

/// Why no access token was handed out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessError {
  NotConnected,
  /// A run started with another sign-in.
  ProfileChanged,
  PlanUsageNotGranted,
  NeedsReconnect,
  /// The token expired and renewal is not allowed yet.
  TryLater,
  ClientRejected,
  Unavailable,
}

pub(crate) struct ChatGptAuthHooks {
  /// Opens the system browser. The URL can carry an ID token hint.
  pub open_browser: Box<dyn Fn(&str) -> bool + Send + Sync>,
  /// The status changed; windows pull it again.
  pub changed: Box<dyn Fn() + Send + Sync>,
  /// Removes the harness's own sign-in state from its Stella-owned home.
  pub clear_harness_sign_in: Box<dyn Fn() + Send + Sync>,
}

#[derive(Clone)]
pub struct ChatGptAuth(Arc<Inner>);

struct Inner {
  config: ChatGptAuthConfig,
  vault: Arc<dyn ChatGptVault>,
  http: DesktopHttpClient,
  hooks: ChatGptAuthHooks,
  status: Mutex<Option<ChatGptStatus>>,
  attempt: Mutex<Option<Attempt>>,
  next_attempt: AtomicU64,
  /// Serializes every read-modify-write of the stored tokens.
  session: tokio::sync::Mutex<()>,
  discovery: tokio::sync::Mutex<Option<Discovery>>,
  jwks: tokio::sync::Mutex<Option<id_token::Jwks>>,
}

struct Attempt {
  id: u64,
  slot: CallbackSlot,
  /// Set once the listener is bound.
  callback: Option<(String, String)>,
  _cancel: oneshot::Sender<()>,
}

#[derive(Debug, Clone, Deserialize)]
struct Discovery {
  issuer: String,
  authorization_endpoint: String,
  token_endpoint: String,
  jwks_uri: String,
  #[serde(default)]
  revocation_endpoint: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
  access_token: String,
  #[serde(default)]
  refresh_token: Option<String>,
  #[serde(default)]
  id_token: Option<String>,
  token_type: String,
  expires_in: i64,
  #[serde(default)]
  scope: Option<String>,
  #[serde(default)]
  earliest_refresh_at: Option<serde_json::Value>,
}

impl TokenResponse {
  fn scopes(&self) -> Vec<String> {
    self
      .scope
      .as_deref()
      .unwrap_or_default()
      .split_whitespace()
      .map(str::to_owned)
      .collect()
  }

  fn earliest_refresh_at_ms(&self) -> Option<i64> {
    match self.earliest_refresh_at.as_ref()? {
      serde_json::Value::Number(seconds) => {
        seconds.as_f64().map(|value| (value * 1000.0) as i64)
      }
      serde_json::Value::String(text) => chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.timestamp_millis()),
      _ => None,
    }
  }
}

#[derive(Deserialize)]
struct OAuthError {
  error: String,
}

#[derive(Debug)]
enum ExchangeError {
  Rejected(String),
  Unreachable,
  Invalid,
}

enum AttemptEnd {
  Settled(Result<ChatGptStatus, ChatGptFailure>),
  Cancelled,
}

fn now_ms() -> i64 {
  chrono::Utc::now().timestamp_millis()
}

/// Binds a broker request to the sign-in a run started with, without
/// putting a token or identity on a command line.
fn profile_key(session: &ChatGptSession) -> String {
  let material =
    serde_json::json!([session.client_id, session.subject, session.id_token]);
  hex::encode(Sha256::digest(material.to_string().as_bytes()))
}

fn stored_status(record: &ChatGptRecord) -> ChatGptStatus {
  if let Some(session) = record
    .session
    .as_ref()
    .filter(|session| session.grants(PLAN_USAGE_SCOPE))
  {
    return ChatGptStatus::Connected {
      email: session.email.clone(),
      plan: session.plan.clone(),
    };
  }
  match &record.registration {
    Some(registration) if registration.reconnect_required => {
      ChatGptStatus::NeedsReconnect {
        email: registration.email.clone(),
      }
    }
    _ => ChatGptStatus::SignedOut,
  }
}

fn same_origin(url: &str, origin: &reqwest::Url) -> bool {
  reqwest::Url::parse(url).is_ok_and(|url| url.origin() == origin.origin())
}

impl ChatGptAuth {
  pub(crate) fn new(
    config: ChatGptAuthConfig,
    vault: Arc<dyn ChatGptVault>,
    http: DesktopHttpClient,
    hooks: ChatGptAuthHooks,
  ) -> Self {
    Self(Arc::new(Inner {
      config,
      vault,
      http,
      hooks,
      status: Mutex::new(None),
      attempt: Mutex::new(None),
      next_attempt: AtomicU64::new(1),
      session: tokio::sync::Mutex::new(()),
      discovery: tokio::sync::Mutex::new(None),
      jwks: tokio::sync::Mutex::new(None),
    }))
  }

  pub(crate) async fn status(&self) -> ChatGptStatus {
    if let Some(status) = self.0.status.lock().ok().and_then(|status| status.clone()) {
      return status;
    }
    let status = match self.with_vault(|vault| vault.load()).await {
      Ok(record) => stored_status(&record),
      Err(VaultUnavailable) => ChatGptStatus::Failed {
        reason: ChatGptFailure::Storage,
      },
    };
    if let Ok(mut cached) = self.0.status.lock()
      && cached.is_none()
    {
      *cached = Some(status.clone());
    }
    status
  }

  fn set_status(&self, status: ChatGptStatus) {
    let changed = self.0.status.lock().is_ok_and(|mut current| {
      let changed = current.as_ref() != Some(&status);
      *current = Some(status);
      changed
    });
    if changed {
      (self.0.hooks.changed)();
    }
  }

  async fn refresh_stored_status(&self) {
    // After any sign-out or renewal in progress has saved its outcome.
    let _guard = self.0.session.lock().await;
    let status = match self.with_vault(|vault| vault.load()).await {
      Ok(record) => stored_status(&record),
      Err(VaultUnavailable) => ChatGptStatus::Failed {
        reason: ChatGptFailure::Storage,
      },
    };
    self.set_status(status);
  }

  async fn with_vault<T: Send + 'static>(
    &self,
    task: impl FnOnce(&dyn ChatGptVault) -> Result<T, VaultUnavailable> + Send + 'static,
  ) -> Result<T, VaultUnavailable> {
    let vault = Arc::clone(&self.0.vault);
    tokio::task::spawn_blocking(move || task(vault.as_ref()))
      .await
      .map_err(|_join| VaultUnavailable)?
  }

  /// Starts a browser sign-in, replacing any attempt in progress.
  pub(crate) fn start(&self, intent: SignInIntent) -> ChatGptStatus {
    let id = self.0.next_attempt.fetch_add(1, Ordering::Relaxed);
    let (deliver, delivered) = oneshot::channel();
    let (cancel, cancelled) = oneshot::channel();
    let slot: CallbackSlot = Arc::new(Mutex::new(Some(deliver)));
    if let Ok(mut attempt) = self.0.attempt.lock() {
      // Dropping the previous attempt's sender cancels it.
      *attempt = Some(Attempt {
        id,
        slot: Arc::clone(&slot),
        callback: None,
        _cancel: cancel,
      });
    }
    self.set_status(ChatGptStatus::SigningIn);
    let auth = self.clone();
    tokio::spawn(async move {
      let end = tokio::select! {
        result = auth.run_attempt(id, intent, slot, delivered) => AttemptEnd::Settled(result),
        _ = cancelled => AttemptEnd::Cancelled,
      };
      auth.finish_attempt(id, end).await;
    });
    ChatGptStatus::SigningIn
  }

  /// Stops the attempt in progress, if any.
  pub(crate) fn cancel(&self) {
    if let Ok(mut attempt) = self.0.attempt.lock() {
      attempt.take();
    }
  }

  async fn finish_attempt(&self, id: u64, end: AttemptEnd) {
    let superseded = self.0.attempt.lock().map_or(true, |mut attempt| {
      match attempt.as_ref().map(|current| current.id) {
        Some(current) if current == id => {
          attempt.take();
          false
        }
        Some(_) => true,
        None => false,
      }
    });
    if superseded {
      return;
    }
    match end {
      AttemptEnd::Settled(Ok(status)) => self.set_status(status),
      AttemptEnd::Settled(Err(reason)) => {
        self.set_status(ChatGptStatus::Failed { reason })
      }
      AttemptEnd::Cancelled => self.refresh_stored_status().await,
    }
  }

  fn record_callback(&self, id: u64, redirect_uri: &str, state: &str) -> bool {
    self
      .0
      .attempt
      .lock()
      .is_ok_and(|mut attempt| match attempt.as_mut() {
        Some(current) if current.id == id => {
          current.callback = Some((redirect_uri.to_owned(), state.to_owned()));
          true
        }
        _ => false,
      })
  }

  /// Finishes the attempt from the URL the browser ended on, for when the
  /// browser could not reach the loopback listener. A URL for another
  /// attempt is refused and the attempt keeps waiting.
  pub(crate) fn complete_from_url(&self, url: &str) -> Result<(), CallbackUrlError> {
    let (redirect_uri, state, slot) = self
      .0
      .attempt
      .lock()
      .ok()
      .and_then(|attempt| {
        let current = attempt.as_ref()?;
        let (redirect_uri, state) = current.callback.clone()?;
        Some((redirect_uri, state, Arc::clone(&current.slot)))
      })
      .ok_or(CallbackUrlError::NoSignIn)?;
    oauth::parse_callback(url, &redirect_uri, &state)
      .map_err(|_rejected| CallbackUrlError::NotThisSignIn)?;
    let deliver = slot
      .lock()
      .ok()
      .and_then(|mut slot| slot.take())
      .ok_or(CallbackUrlError::NoSignIn)?;
    deliver
      .send(DeliveredCallback {
        url: url.trim().to_owned(),
        page: None,
      })
      .map_err(|_closed| CallbackUrlError::NoSignIn)
  }

  async fn run_attempt(
    &self,
    id: u64,
    intent: SignInIntent,
    slot: CallbackSlot,
    delivered: oneshot::Receiver<DeliveredCallback>,
  ) -> Result<ChatGptStatus, ChatGptFailure> {
    let discovery = self.discover().await?;
    let (host_id, record) = self
      .with_vault(|vault| Ok((vault.host_id()?, vault.load()?)))
      .await
      .map_err(|VaultUnavailable| ChatGptFailure::Storage)?;
    let client = select_client(&record, intent);
    let listener = CallbackListener::bind(slot, self.0.config.page_wait)
      .await
      .map_err(|_bind| ChatGptFailure::CallbackUnavailable)?;
    let redirect_uri = oauth::redirect_uri(listener.port());
    let state = oauth::random_token(32);
    let nonce = oauth::random_token(32);
    let pkce = Pkce::generate();
    let url = oauth::authorization_url(&AuthorizationRequest {
      endpoint: &discovery.authorization_endpoint,
      client: &client,
      host_id: &host_id,
      redirect_uri: &redirect_uri,
      resource: &self.0.config.resource,
      state: &state,
      nonce: &nonce,
      code_challenge: &pkce.challenge,
    })
    .ok_or(ChatGptFailure::Unreachable)?;
    if !self.record_callback(id, &redirect_uri, &state) {
      return Err(ChatGptFailure::TimedOut);
    }
    if !(self.0.hooks.open_browser)(url.as_str()) {
      return Err(ChatGptFailure::BrowserUnavailable);
    }
    let Ok(Ok(DeliveredCallback { url, page })) =
      tokio::time::timeout(self.0.config.sign_in_timeout, delivered).await
    else {
      return Err(ChatGptFailure::TimedOut);
    };
    // The listener has served its one callback.
    drop(listener);
    let pending = PendingSignIn {
      discovery: &discovery,
      client: &client,
      record: &record,
      redirect_uri: &redirect_uri,
      state: &state,
      nonce: &nonce,
      verifier: &pkce.verifier,
    };
    let result = self.complete(&pending, &url).await;
    if let Some(page) = page {
      let _ = page.send(match result {
        Ok(ChatGptStatus::Connected { .. }) => CallbackPage::Connected,
        _ => CallbackPage::NotConnected,
      });
    }
    result
  }

  async fn complete(
    &self,
    pending: &PendingSignIn<'_>,
    url: &str,
  ) -> Result<ChatGptStatus, ChatGptFailure> {
    let (code, returned_client) =
      match oauth::parse_callback(url, pending.redirect_uri, pending.state) {
        Err(CallbackRejection::StateMismatch) => {
          return Err(ChatGptFailure::StateMismatch);
        }
        Err(CallbackRejection::NotThisSignIn) => {
          return Err(ChatGptFailure::RegistrationIncomplete);
        }
        Ok(CallbackResult::Denied) => return Err(ChatGptFailure::Declined),
        Ok(CallbackResult::Error) => return Err(ChatGptFailure::Verification),
        Ok(CallbackResult::Code { code, client_id }) => (code, client_id),
      };
    let (client_id, expected_subject) = match pending.client {
      ClientSelection::Register => (
        returned_client.ok_or(ChatGptFailure::RegistrationIncomplete)?,
        None,
      ),
      ClientSelection::Returning { client_id, .. } => {
        if returned_client
          .as_deref()
          .is_some_and(|returned| returned != client_id)
        {
          return Err(ChatGptFailure::RegistrationIncomplete);
        }
        let subject = pending
          .record
          .registration
          .as_ref()
          .and_then(|registration| registration.subject.clone());
        (client_id.clone(), subject)
      }
    };

    let body = oauth::form_body(&[
      ("grant_type", "authorization_code"),
      ("client_id", &client_id),
      ("code", &code),
      ("code_verifier", pending.verifier),
      ("redirect_uri", pending.redirect_uri),
      ("resource", &self.0.config.resource),
    ]);
    let tokens = match self
      .post_token(&pending.discovery.token_endpoint, body)
      .await
    {
      Ok(tokens) => tokens,
      Err(ExchangeError::Rejected(error)) => {
        return Err(match error.as_str() {
          "invalid_grant" => {
            // A fresh attempt must reuse the client this one registered.
            if matches!(pending.client, ClientSelection::Register) {
              self.keep_registration(&client_id).await?;
            }
            ChatGptFailure::CodeExpired
          }
          "invalid_client" => ChatGptFailure::ClientRejected,
          "access_denied" => ChatGptFailure::Declined,
          _ => ChatGptFailure::Verification,
        });
      }
      Err(ExchangeError::Unreachable) => return Err(ChatGptFailure::Unreachable),
      Err(ExchangeError::Invalid) => return Err(ChatGptFailure::Verification),
    };
    let id_token = tokens
      .id_token
      .clone()
      .ok_or(ChatGptFailure::Verification)?;
    let identity = self
      .verify_id_token(
        &id_token,
        &pending.discovery.issuer,
        &client_id,
        pending.nonce,
      )
      .await?;
    if expected_subject
      .as_deref()
      .is_some_and(|expected| expected != identity.subject)
    {
      return Err(ChatGptFailure::DifferentAccount);
    }
    if !tokens.token_type.eq_ignore_ascii_case("bearer") {
      return Err(ChatGptFailure::Verification);
    }
    let scopes = tokens.scopes();
    let plan_usage_granted = scopes.iter().any(|scope| scope == PLAN_USAGE_SCOPE);
    let saved_at = now_ms();
    let record = ChatGptRecord {
      registration: Some(ChatGptRegistration {
        client_id: client_id.clone(),
        subject: Some(identity.subject.clone()),
        email: identity.email.clone(),
        plan_usage_granted,
        reconnect_required: false,
      }),
      // Without plan usage the tokens cannot run a request; keep only the
      // registration, so the next sign-in asks for consent again.
      session: plan_usage_granted.then(|| ChatGptSession {
        client_id,
        issuer: pending.discovery.issuer.clone(),
        subject: identity.subject,
        email: identity.email.clone(),
        plan: identity.plan.clone(),
        id_token,
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token.clone(),
        expires_at: saved_at + tokens.expires_in.saturating_mul(1000),
        earliest_refresh_at: tokens.earliest_refresh_at_ms(),
        scopes,
        saved_at,
      }),
    };
    let _guard = self.0.session.lock().await;
    self
      .with_vault(move |vault| vault.save(&record))
      .await
      .map_err(|VaultUnavailable| ChatGptFailure::Storage)?;
    if plan_usage_granted {
      Ok(ChatGptStatus::Connected {
        email: identity.email,
        plan: identity.plan,
      })
    } else {
      Err(ChatGptFailure::PlanUsageNotGranted)
    }
  }

  async fn keep_registration(&self, client_id: &str) -> Result<(), ChatGptFailure> {
    let client_id = client_id.to_owned();
    let _guard = self.0.session.lock().await;
    self
      .with_vault(move |vault| {
        let record = vault.load()?;
        vault.save(&ChatGptRecord {
          registration: Some(ChatGptRegistration {
            client_id,
            subject: None,
            email: None,
            plan_usage_granted: true,
            reconnect_required: false,
          }),
          session: record.session,
        })
      })
      .await
      .map_err(|VaultUnavailable| ChatGptFailure::Storage)
  }

  async fn verify_id_token(
    &self,
    token: &str,
    issuer: &str,
    client_id: &str,
    nonce: &str,
  ) -> Result<id_token::VerifiedIdentity, ChatGptFailure> {
    let expect = id_token::Expectations {
      issuer,
      client_id,
      nonce,
      now: chrono::Utc::now().timestamp(),
    };
    let jwks = self.jwks(false).await?;
    match id_token::verify(token, &jwks, &expect) {
      Err(id_token::IdTokenError::UnknownKey) => {
        // The issuer may have rotated its keys since they were cached.
        let jwks = self.jwks(true).await?;
        id_token::verify(token, &jwks, &expect)
      }
      result => result,
    }
    .map_err(|error| {
      tracing::warn!(?error, "ChatGPT ID token was not accepted");
      ChatGptFailure::Verification
    })
  }

  // The cache stays locked through the fetch, so concurrent callers share it.
  #[allow(
    clippy::significant_drop_tightening,
    reason = "single-flight cache fill"
  )]
  async fn discover(&self) -> Result<Discovery, ChatGptFailure> {
    let mut cached = self.0.discovery.lock().await;
    if let Some(discovery) = cached.as_ref() {
      return Ok(discovery.clone());
    }
    let response = self
      .0
      .http
      .get(&self.0.config.discovery_url)
      .header(reqwest::header::ACCEPT, "application/json")
      .send()
      .await
      .map_err(|_unreachable| ChatGptFailure::Unreachable)?;
    if !response.status().is_success() {
      return Err(ChatGptFailure::Unreachable);
    }
    let discovery: Discovery = response
      .json()
      .await
      .map_err(|_invalid| ChatGptFailure::Unreachable)?;
    let issuer = reqwest::Url::parse(&self.0.config.issuer)
      .map_err(|_invalid| ChatGptFailure::Verification)?;
    let endpoints_trusted = discovery.issuer == self.0.config.issuer
      && [
        Some(&discovery.authorization_endpoint),
        Some(&discovery.token_endpoint),
        Some(&discovery.jwks_uri),
        discovery.revocation_endpoint.as_ref(),
      ]
      .into_iter()
      .flatten()
      .all(|endpoint| same_origin(endpoint, &issuer));
    if !endpoints_trusted {
      tracing::warn!(
        "ChatGPT sign-in configuration names an unexpected issuer or endpoint"
      );
      return Err(ChatGptFailure::Verification);
    }
    *cached = Some(discovery.clone());
    Ok(discovery)
  }

  #[allow(
    clippy::significant_drop_tightening,
    reason = "single-flight cache fill"
  )]
  async fn jwks(&self, reload: bool) -> Result<id_token::Jwks, ChatGptFailure> {
    let mut cached = self.0.jwks.lock().await;
    if !reload && let Some(jwks) = cached.as_ref() {
      return Ok(jwks.clone());
    }
    let discovery = self.discover().await?;
    let response = self
      .0
      .http
      .get(&discovery.jwks_uri)
      .header(reqwest::header::ACCEPT, "application/json")
      .send()
      .await
      .map_err(|_unreachable| ChatGptFailure::Unreachable)?;
    if !response.status().is_success() {
      return Err(ChatGptFailure::Unreachable);
    }
    let jwks: id_token::Jwks = response
      .json()
      .await
      .map_err(|_invalid| ChatGptFailure::Verification)?;
    *cached = Some(jwks.clone());
    Ok(jwks)
  }

  async fn post_form(
    &self,
    endpoint: &str,
    body: String,
  ) -> Result<(reqwest::StatusCode, Vec<u8>), ExchangeError> {
    let response = self
      .0
      .http
      .post(endpoint)
      .header(
        reqwest::header::CONTENT_TYPE,
        "application/x-www-form-urlencoded",
      )
      .header(reqwest::header::ACCEPT, "application/json")
      .body(body)
      .send()
      .await
      .map_err(|_unreachable| ExchangeError::Unreachable)?;
    let status = response.status();
    let bytes = response
      .bytes()
      .await
      .map_err(|_unreachable| ExchangeError::Unreachable)?;
    if bytes.len() > MAX_RESPONSE_BYTES {
      return Err(ExchangeError::Invalid);
    }
    Ok((status, bytes.to_vec()))
  }

  async fn post_token(
    &self,
    endpoint: &str,
    body: String,
  ) -> Result<TokenResponse, ExchangeError> {
    let (status, bytes) = self.post_form(endpoint, body).await?;
    if status.is_success() {
      // A parse error could quote the body, so it is dropped unread.
      return serde_json::from_slice(&bytes).map_err(|_invalid| ExchangeError::Invalid);
    }
    if status.is_server_error() {
      return Err(ExchangeError::Unreachable);
    }
    Err(ExchangeError::Rejected(
      serde_json::from_slice::<OAuthError>(&bytes)
        .map(|error| error.error)
        .unwrap_or_default(),
    ))
  }

  /// A current access token for the signed-in account, renewed first when
  /// it is about to expire. With `profile_key`, only for that sign-in.
  pub(crate) async fn access(
    &self,
    profile: Option<&str>,
  ) -> Result<String, AccessError> {
    let _guard = self.0.session.lock().await;
    let record = self
      .with_vault(|vault| vault.load())
      .await
      .map_err(|VaultUnavailable| AccessError::Unavailable)?;
    let Some(session) = record.session.clone() else {
      return Err(AccessError::NotConnected);
    };
    if profile.is_some_and(|expected| expected != profile_key(&session)) {
      return Err(AccessError::ProfileChanged);
    }
    if !session.grants(PLAN_USAGE_SCOPE) {
      return Err(AccessError::PlanUsageNotGranted);
    }
    let now = now_ms();
    if session.expires_at - now > RENEW_BEFORE_EXPIRY_MS {
      return Ok(session.access_token);
    }
    if session
      .earliest_refresh_at
      .is_some_and(|earliest| earliest > now)
    {
      return if session.expires_at > now {
        Ok(session.access_token)
      } else {
        Err(AccessError::TryLater)
      };
    }
    let Some(refresh_token) = session.refresh_token.clone() else {
      self.require_reconnect(record).await;
      return Err(AccessError::NeedsReconnect);
    };
    let discovery = self
      .discover()
      .await
      .map_err(|_failure| AccessError::Unavailable)?;
    let body = oauth::form_body(&[
      ("grant_type", "refresh_token"),
      ("client_id", &session.client_id),
      ("refresh_token", &refresh_token),
      ("resource", &self.0.config.resource),
    ]);
    let renewed = match tokio::time::timeout(
      REFRESH_TIMEOUT,
      self.post_token(&discovery.token_endpoint, body),
    )
    .await
    {
      Ok(Ok(tokens)) => tokens,
      Ok(Err(ExchangeError::Rejected(error)))
        if UNUSABLE_REFRESH_ERRORS.contains(&error.as_str()) =>
      {
        self.require_reconnect(record).await;
        return Err(AccessError::NeedsReconnect);
      }
      Ok(Err(ExchangeError::Rejected(error))) if error == "invalid_client" => {
        self.set_status(ChatGptStatus::Failed {
          reason: ChatGptFailure::ClientRejected,
        });
        return Err(AccessError::ClientRejected);
      }
      // Keep the tokens through a temporary failure.
      Ok(Err(_)) | Err(_) => return Err(AccessError::Unavailable),
    };
    let Some(rotated) = renewed.refresh_token.clone() else {
      return Err(AccessError::Unavailable);
    };
    if !renewed.token_type.eq_ignore_ascii_case("bearer") {
      return Err(AccessError::Unavailable);
    }
    let saved_at = now_ms();
    let session = ChatGptSession {
      access_token: renewed.access_token.clone(),
      refresh_token: Some(rotated),
      expires_at: saved_at + renewed.expires_in.saturating_mul(1000),
      earliest_refresh_at: renewed.earliest_refresh_at_ms(),
      scopes: renewed.scopes(),
      saved_at,
      ..session
    };
    let granted = session.grants(PLAN_USAGE_SCOPE);
    let token = session.access_token.clone();
    let next = ChatGptRecord {
      registration: record.registration.map(|registration| ChatGptRegistration {
        plan_usage_granted: granted,
        ..registration
      }),
      session: Some(session),
    };
    // Access token, expiry, scopes and the rotated refresh token change
    // together, or not at all.
    self
      .with_vault(move |vault| vault.save(&next))
      .await
      .map_err(|VaultUnavailable| AccessError::Unavailable)?;
    if !granted {
      self.set_status(ChatGptStatus::Failed {
        reason: ChatGptFailure::PlanUsageNotGranted,
      });
      return Err(AccessError::PlanUsageNotGranted);
    }
    Ok(token)
  }

  async fn require_reconnect(&self, record: ChatGptRecord) {
    let email = record
      .session
      .as_ref()
      .and_then(|session| session.email.clone());
    let next = ChatGptRecord {
      registration: record.registration.map(|registration| ChatGptRegistration {
        reconnect_required: true,
        ..registration
      }),
      session: None,
    };
    if self
      .with_vault(move |vault| vault.save(&next))
      .await
      .is_err()
    {
      tracing::warn!("expired ChatGPT tokens were not cleared");
    }
    self.set_status(ChatGptStatus::NeedsReconnect { email });
  }

  /// The key a run's token requests must present: it changes with every
  /// sign-in, so a run never receives another sign-in's token.
  pub(crate) async fn profile_key(&self) -> Result<String, AccessError> {
    let record = self
      .with_vault(|vault| vault.load())
      .await
      .map_err(|VaultUnavailable| AccessError::Unavailable)?;
    record
      .session
      .as_ref()
      .map(profile_key)
      .ok_or(AccessError::NotConnected)
  }

  /// Signs out: revokes the renewable session where possible, deletes the
  /// tokens and the harness's own sign-in state, and keeps the client
  /// registration and host ID for a later sign-in. Returns whether the
  /// revocation was confirmed.
  pub(crate) async fn disconnect(&self) -> Result<bool, VaultUnavailable> {
    self.cancel();
    let _guard = self.0.session.lock().await;
    let record = self.with_vault(|vault| vault.load()).await?;
    let confirmed = match record.session.as_ref() {
      Some(session) => match session.refresh_token.as_deref() {
        Some(refresh_token) => self.revoke(&session.client_id, refresh_token).await,
        None => true,
      },
      None => true,
    };
    let next = ChatGptRecord {
      registration: record.registration.map(|registration| ChatGptRegistration {
        reconnect_required: false,
        ..registration
      }),
      session: None,
    };
    self.with_vault(move |vault| vault.save(&next)).await?;
    (self.0.hooks.clear_harness_sign_in)();
    self.set_status(ChatGptStatus::SignedOut);
    Ok(confirmed)
  }

  async fn revoke(&self, client_id: &str, refresh_token: &str) -> bool {
    let Ok(discovery) = self.discover().await else {
      return false;
    };
    let Some(endpoint) = discovery.revocation_endpoint else {
      return false;
    };
    let body = oauth::form_body(&[
      ("token", refresh_token),
      ("token_type_hint", "refresh_token"),
      ("client_id", client_id),
    ]);
    for attempt in 0..REVOKE_ATTEMPTS {
      if attempt > 0 {
        tokio::time::sleep(Duration::from_millis(if attempt == 1 {
          250
        } else {
          1000
        }))
        .await;
      }
      match tokio::time::timeout(
        Duration::from_secs(10),
        self.post_form(&endpoint, body.clone()),
      )
      .await
      {
        Ok(Ok((status, _))) if status == reqwest::StatusCode::OK => return true,
        Ok(Ok((status, _))) if !status.is_server_error() => return false,
        _ => {}
      }
    }
    false
  }
}

struct PendingSignIn<'a> {
  discovery: &'a Discovery,
  client: &'a ClientSelection,
  record: &'a ChatGptRecord,
  redirect_uri: &'a str,
  state: &'a str,
  nonce: &'a str,
  verifier: &'a str,
}

fn select_client(record: &ChatGptRecord, intent: SignInIntent) -> ClientSelection {
  let (SignInIntent::SameAccount, Some(registration)) =
    (intent, record.registration.as_ref())
  else {
    return ClientSelection::Register;
  };
  ClientSelection::Returning {
    client_id: registration.client_id.clone(),
    login_hint: registration.email.clone(),
    id_token_hint: record
      .session
      .as_ref()
      .filter(|session| session.client_id == registration.client_id)
      .map(|session| session.id_token.clone()),
    request_consent: !registration.plan_usage_granted,
  }
}
