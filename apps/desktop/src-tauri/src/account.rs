//! The Keychain record is the account link: profile and usable credential are
//! committed together. A remembered document-edit profile is not a login.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, State, WebviewWindow};
use tokio::sync::Mutex;

use crate::types::{
  DesktopAccountCredential, DesktopAccountIdentity, DesktopAccountSnapshot,
  LinkAccountRequest, LinkedAccountSnapshot, is_valid_linked_account,
};

pub const CHANGED_EVENT: &str = "desktop-account-changed";
const ACCOUNT_PROTOCOL_HEADER: &str = "X-Stella-Desktop-Account-Protocol";
pub type AccountState = Arc<Mutex<AccountStore>>;

// All bearer requests and rotations share one lease, across every desktop window.
pub async fn lock_requests() -> tokio::sync::MutexGuard<'static, ()> {
  static REQUESTS: OnceLock<Mutex<()>> = OnceLock::new();
  REQUESTS.get_or_init(|| Mutex::new(())).lock().await
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingRotation {
  successor_key: String,
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum StorageFault {
  Save,
  ClearRotation,
}

#[cfg(test)]
#[derive(Default)]
pub struct AccountFixture {
  saved: Option<LinkedAccount>,
  pending: Option<PendingRotation>,
  expired: bool,
  fault: Option<StorageFault>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkOutcome {
  Linked,
  Unchanged,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedAccount {
  pub api_base_url: String,
  pub web_origin: String,
  pub account: LinkedAccountSnapshot,
  pub identity: DesktopAccountIdentity,
  pub credential: DesktopAccountCredential,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountPolicy {
  key_prefix: String,
  credential_lifetime_seconds: i64,
  rotation_interval_seconds: u64,
  link_protocol: u32,
}

fn policy() -> AccountPolicy {
  serde_json::from_str(include_str!(
    "../../../../packages/api-contract/src/desktop-account-policy.json"
  ))
  .expect("the committed desktop account policy must be valid")
}

/// The API stamps `expiresAt` from its own clock. A desktop clock behind the
/// API sees a fresh credential as longer-lived than the policy allows, so the
/// upper bound tolerates this much skew. The lower bound stays strict: a
/// credential past its own timestamp is not live, whatever the local clock.
const CLOCK_SKEW_SECONDS: i64 = 5 * 60;

pub fn is_live_expiry(value: &str) -> bool {
  is_live_expiry_at(value, chrono::Utc::now())
}

fn is_live_expiry_at(value: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
  chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|expires| {
    let remaining = expires.signed_duration_since(now).num_seconds();
    remaining > 0
      && remaining <= policy().credential_lifetime_seconds + CLOCK_SKEW_SECONDS
  })
}

impl LinkedAccount {
  fn from_request(
    request: LinkAccountRequest,
    web_origin: &str,
  ) -> Result<PendingLinkedAccount, String> {
    if !request.credential.key.starts_with(&policy().key_prefix)
      || request.credential.key.len() > 256
      || !is_live_expiry(&request.credential.expires_at)
    {
      return Err("Invalid desktop account connection".into());
    }
    Ok(PendingLinkedAccount {
      api_base_url: crate::config::normalize_self_host_api_base_url(
        &request.api_base_url,
      )?,
      web_origin: crate::config::normalize_self_host_web_origin(web_origin)?,
      credential: request.credential,
    })
  }

  pub(crate) fn snapshot(self) -> DesktopAccountSnapshot {
    DesktopAccountSnapshot::Connected {
      account: self.account,
      identity: self.identity,
      expires_at: self.credential.expires_at,
    }
  }
}

struct PendingLinkedAccount {
  api_base_url: String,
  web_origin: String,
  credential: DesktopAccountCredential,
}

impl PendingLinkedAccount {
  fn with_server_account(
    self,
    config: &serde_json::Value,
  ) -> Result<LinkedAccount, String> {
    let account = config
      .get("account")
      .cloned()
      .ok_or_else(|| "Invalid registry account".to_string())
      .and_then(|account| {
        serde_json::from_value(account)
          .map_err(|_| "Invalid registry account".to_string())
      })?;
    if !is_valid_linked_account(&account) {
      return Err("Invalid registry account".into());
    }
    let identity: DesktopAccountIdentity = config
      .get("identity")
      .cloned()
      .ok_or_else(|| "Invalid registry identity".to_string())
      .and_then(|identity| {
        serde_json::from_value(identity)
          .map_err(|_| "Invalid registry identity".to_string())
      })?;
    if identity.user_id.trim().is_empty() || identity.organization_id.trim().is_empty()
    {
      return Err("Invalid registry identity".into());
    }
    Ok(LinkedAccount {
      api_base_url: self.api_base_url,
      web_origin: self.web_origin,
      account,
      identity,
      credential: self.credential,
    })
  }
}

// The real external persistence boundary is supplied per state in tests;
// no global Keychain mocks or production credentials are used by the harness.
#[derive(Default)]
pub enum AccountStore {
  #[default]
  Keychain,
  #[cfg(test)]
  Memory(Option<LinkedAccount>),
  #[cfg(test)]
  ReadOnly(Option<LinkedAccount>),
  #[cfg(test)]
  Fixture(AccountFixture),
}

impl AccountStore {
  async fn load(&self) -> Result<Option<LinkedAccount>, String> {
    match self {
      Self::Keychain => crate::keychain::get_account_connection()
        .await?
        .map(|value| {
          serde_json::from_str(&value)
            .map_err(|_| "Desktop account connection is unreadable".into())
        })
        .transpose(),
      #[cfg(test)]
      Self::Memory(account) | Self::ReadOnly(account) => Ok(account.clone()),
      #[cfg(test)]
      Self::Fixture(fixture) => Ok(fixture.saved.clone()),
    }
  }

  #[allow(
    clippy::needless_pass_by_ref_mut,
    reason = "exclusive persistence operations also mutate the in-memory test store"
  )]
  async fn save(&mut self, account: LinkedAccount) -> Result<(), String> {
    match self {
      Self::Keychain => {
        let value = serde_json::to_string(&account)
          .map_err(|_| "Could not save desktop account")?;
        crate::keychain::store_account_connection(value).await?;
        crate::keychain::clear_account_expired().await
      }
      #[cfg(test)]
      Self::Memory(saved) => {
        *saved = Some(account);
        Ok(())
      }
      #[cfg(test)]
      Self::ReadOnly(_) => Err("Could not save desktop account".into()),
      #[cfg(test)]
      Self::Fixture(fixture) => {
        if matches!(fixture.fault, Some(StorageFault::Save)) {
          return Err("Account save unavailable".into());
        }
        fixture.saved = Some(account);
        fixture.expired = false;
        Ok(())
      }
    }
  }

  #[allow(
    clippy::needless_pass_by_ref_mut,
    reason = "exclusive persistence operations also mutate the in-memory test store"
  )]
  async fn clear(&mut self) -> Result<(), String> {
    match self {
      Self::Keychain => crate::keychain::delete_account_connection().await,
      #[cfg(test)]
      Self::Memory(saved) => {
        *saved = None;
        Ok(())
      }
      #[cfg(test)]
      Self::ReadOnly(_) => Err("Could not remove desktop account".into()),
      #[cfg(test)]
      Self::Fixture(fixture) => {
        *fixture = AccountFixture::default();
        Ok(())
      }
    }
  }

  async fn pending(&self) -> Result<Option<PendingRotation>, String> {
    match self {
      Self::Keychain => crate::keychain::get_account_rotation()
        .await?
        .map(|value| {
          serde_json::from_str(&value)
            .map_err(|_| "Account rotation is unreadable".to_string())
        })
        .transpose(),
      #[cfg(test)]
      Self::Fixture(fixture) => Ok(fixture.pending.clone()),
      #[cfg(test)]
      Self::Memory(_) | Self::ReadOnly(_) => Ok(None),
    }
  }

  async fn stage(&mut self, pending: Option<PendingRotation>) -> Result<(), String> {
    match self {
      Self::Keychain => {
        crate::keychain::set_account_rotation(
          pending
            .map(|value| {
              serde_json::to_string(&value)
                .map_err(|_| "Could not stage account rotation".to_string())
            })
            .transpose()?,
        )
        .await
      }
      #[cfg(test)]
      Self::Fixture(fixture) => {
        if pending.is_none()
          && matches!(fixture.fault, Some(StorageFault::ClearRotation))
        {
          return Err("Rotation cleanup unavailable".into());
        }
        fixture.pending = pending;
        Ok(())
      }
      #[cfg(test)]
      Self::Memory(_) => {
        if pending.is_none() {
          Ok(())
        } else {
          Err("Account rotation storage unavailable".into())
        }
      }
      #[cfg(test)]
      Self::ReadOnly(_) => Err("Account rotation storage unavailable".into()),
    }
  }

  async fn expired(&self) -> Result<bool, String> {
    match self {
      Self::Keychain => crate::keychain::account_expired().await,
      #[cfg(test)]
      Self::Fixture(fixture) => Ok(fixture.expired),
      #[cfg(test)]
      Self::Memory(_) | Self::ReadOnly(_) => Ok(false),
    }
  }

  async fn expire(&mut self) -> Result<(), String> {
    match self {
      Self::Keychain => crate::keychain::mark_account_expired().await,
      #[cfg(test)]
      Self::Fixture(fixture) => {
        *fixture = AccountFixture {
          expired: true,
          ..AccountFixture::default()
        };
        Ok(())
      }
      #[cfg(test)]
      Self::Memory(_) | Self::ReadOnly(_) => self.clear().await,
    }
  }
}

pub async fn current(state: &AccountState) -> Result<Option<LinkedAccount>, String> {
  let mut store = state.lock().await;
  let saved = store.load().await?;
  if saved
    .as_ref()
    .is_some_and(|saved| !is_live_expiry(&saved.credential.expires_at))
  {
    if store.pending().await?.is_some() {
      return Err("Account renewal requires recovery".into());
    }
    store.expire().await?;
    return Ok(None);
  }
  Ok(saved)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenewalReply {
  expires_at: String,
  identity: DesktopAccountIdentity,
}

enum RenewalFailure {
  Rejected,
  Throttled,
  Unavailable(String),
}

#[derive(Clone, Copy)]
enum RecoveryMode {
  ProbeOnly,
  Foreground,
  Disconnect,
}

trait RenewalTransport {
  async fn send(
    &self,
    account: &LinkedAccount,
    successor: Option<&str>,
  ) -> Result<RenewalReply, RenewalFailure>;
}

struct HttpRenewal;
impl RenewalTransport for HttpRenewal {
  async fn send(
    &self,
    account: &LinkedAccount,
    successor: Option<&str>,
  ) -> Result<RenewalReply, RenewalFailure> {
    let body = match successor {
      Some(key) => serde_json::json!({"type":"rotate", "successorKey":key}),
      None => serde_json::json!({"type":"probe"}),
    };
    match crate::registry::renewal_request(
      crate::registry::RegistryRequestAuth {
        api_base_url: &account.api_base_url,
        credential_key: &account.credential.key,
      },
      body,
    )
    .await
    {
      Ok(value) => serde_json::from_value(value).map_err(|_| {
        RenewalFailure::Unavailable("Account renewal response is invalid".into())
      }),
      Err(message) if message == crate::registry::not_connected() => {
        Err(RenewalFailure::Rejected)
      }
      Err(message) if message == crate::registry::rate_limited() => {
        Err(RenewalFailure::Throttled)
      }
      Err(message) => Err(RenewalFailure::Unavailable(message)),
    }
  }
}

fn validate_renewal_reply(
  account: &LinkedAccount,
  reply: &RenewalReply,
) -> Result<(), String> {
  if reply.identity.user_id != account.identity.user_id
    || reply.identity.organization_id != account.identity.organization_id
  {
    return Err("Account renewal identity changed".into());
  }
  if !is_live_expiry(&reply.expires_at) {
    return Err("Account renewal expiry is invalid".into());
  }
  Ok(())
}

async fn commit_rotation(
  store: &mut AccountStore,
  mut account: LinkedAccount,
  pending: PendingRotation,
  reply: RenewalReply,
) -> Result<LinkedAccount, String> {
  validate_renewal_reply(&account, &reply)?;
  account.credential = DesktopAccountCredential {
    key: pending.successor_key,
    expires_at: reply.expires_at,
  };
  store.save(account.clone()).await?;
  store.stage(None).await?;
  Ok(account)
}

// A successor is durable before CAS. On an unknown result, probe it first;
// a timeout never authorizes a retry with an invalidated predecessor.
async fn recover_rotation(
  store: &mut AccountStore,
  account: LinkedAccount,
  transport: &impl RenewalTransport,
  mode: RecoveryMode,
) -> Result<LinkedAccount, String> {
  let Some(pending) = store.pending().await? else {
    return Ok(account);
  };
  let candidate = LinkedAccount {
    api_base_url: account.api_base_url.clone(),
    web_origin: account.web_origin.clone(),
    account: account.account.clone(),
    identity: account.identity.clone(),
    credential: DesktopAccountCredential {
      key: pending.successor_key.clone(),
      expires_at: account.credential.expires_at.clone(),
    },
  };
  match transport.send(&candidate, None).await {
    Ok(reply) => commit_rotation(store, account, pending, reply).await,
    Err(RenewalFailure::Unavailable(message)) => Err(message),
    Err(RenewalFailure::Throttled) => Err(crate::registry::rate_limited()),
    Err(RenewalFailure::Rejected) => {
      if matches!(mode, RecoveryMode::ProbeOnly) {
        return Err("Account renewal needs foreground recovery".into());
      }
      if matches!(mode, RecoveryMode::Disconnect) {
        return match transport.send(&account, None).await {
          Ok(reply) => {
            validate_renewal_reply(&account, &reply)?;
            store.stage(None).await?;
            Ok(account)
          }
          Err(RenewalFailure::Unavailable(message)) => Err(message),
          Err(RenewalFailure::Throttled) => Err(crate::registry::rate_limited()),
          // A timed-out rotation can commit between the two probes; adopt a
          // live successor so disconnect revokes it instead of orphaning it.
          Err(RenewalFailure::Rejected) => match transport.send(&candidate, None).await
          {
            Ok(reply) => commit_rotation(store, account, pending, reply).await,
            Err(RenewalFailure::Unavailable(message)) => Err(message),
            Err(RenewalFailure::Throttled) => Err(crate::registry::rate_limited()),
            Err(RenewalFailure::Rejected) => {
              store.clear().await?;
              Err(crate::registry::not_connected())
            }
          },
        };
      }
      match transport.send(&account, Some(&pending.successor_key)).await {
        Ok(reply) => commit_rotation(store, account, pending, reply).await,
        Err(RenewalFailure::Unavailable(message)) => Err(message),
        Err(RenewalFailure::Throttled) => Err(crate::registry::rate_limited()),
        // A timed-out rotation can commit between the first probe and this
        // retry; only both generations being rejected ends the link.
        Err(RenewalFailure::Rejected) => match transport.send(&candidate, None).await {
          Ok(reply) => commit_rotation(store, account, pending, reply).await,
          Err(RenewalFailure::Unavailable(message)) => Err(message),
          Err(RenewalFailure::Throttled) => Err(crate::registry::rate_limited()),
          Err(RenewalFailure::Rejected) => {
            if is_live_expiry(&account.credential.expires_at) {
              store.clear().await?;
            } else {
              store.expire().await?;
            }
            Err(crate::registry::not_connected())
          }
        },
      }
    }
  }
}

async fn rotate_account(
  store: &mut AccountStore,
  account: LinkedAccount,
  successor_key: String,
  transport: &impl RenewalTransport,
) -> Result<LinkedAccount, String> {
  let pending = PendingRotation { successor_key };
  store.stage(Some(pending.clone())).await?;
  match transport.send(&account, Some(&pending.successor_key)).await {
    Ok(reply) => commit_rotation(store, account, pending, reply).await,
    Err(RenewalFailure::Unavailable(message)) => Err(message),
    // The API refused before rotating, so the current key stays live.
    Err(RenewalFailure::Throttled) => {
      store.stage(None).await?;
      Ok(account)
    }
    Err(RenewalFailure::Rejected) => {
      store.clear().await?;
      Err(crate::registry::not_connected())
    }
  }
}

pub struct AccountRequest {
  account: LinkedAccount,
  _lease: tokio::sync::MutexGuard<'static, ()>,
}
impl AccountRequest {
  pub(crate) fn request_auth(&self) -> crate::registry::RegistryRequestAuth<'_> {
    crate::registry::RegistryRequestAuth {
      api_base_url: &self.api_base_url,
      credential_key: &self.credential.key,
    }
  }
  #[cfg(test)]
  pub(crate) async fn fixture(account: LinkedAccount) -> Self {
    Self {
      account,
      _lease: lock_requests().await,
    }
  }
}

impl std::ops::Deref for AccountRequest {
  type Target = LinkedAccount;
  fn deref(&self) -> &LinkedAccount {
    &self.account
  }
}

async fn load_account_for_request(
  state: &AccountState,
  mode: RecoveryMode,
) -> Result<Option<LinkedAccount>, String> {
  let mut store = state.lock().await;
  let Some(saved) = store.load().await? else {
    return Ok(None);
  };
  let saved = recover_rotation(&mut store, saved, &HttpRenewal, mode).await?;
  if !is_live_expiry(&saved.credential.expires_at) {
    store.expire().await?;
    return Ok(None);
  }
  Ok(Some(saved))
}

async fn load_request_account(
  state: &AccountState,
  mode: RecoveryMode,
) -> Result<Option<AccountRequest>, String> {
  let lease = lock_requests().await;
  Ok(
    load_account_for_request(state, mode)
      .await?
      .map(|account| AccountRequest {
        account,
        _lease: lease,
      }),
  )
}

pub async fn request_account(
  state: &AccountState,
) -> Result<Option<AccountRequest>, String> {
  load_request_account(state, RecoveryMode::ProbeOnly).await
}

pub async fn foreground_account(
  state: &AccountState,
) -> Result<Option<AccountRequest>, String> {
  let Some(mut request) = load_request_account(state, RecoveryMode::Foreground).await?
  else {
    return Ok(None);
  };
  // Presence never calls this owner. Pace interactive bursts without an idle timer.
  static LAST_USE: OnceLock<Mutex<Option<std::time::Instant>>> = OnceLock::new();
  let mut last_use = LAST_USE.get_or_init(|| Mutex::new(None)).lock().await;
  let interval = std::time::Duration::from_secs(policy().rotation_interval_seconds);
  if last_use.is_some_and(|last| last.elapsed() < interval) {
    return Ok(Some(request));
  }
  let mut store = state.lock().await;
  let successor = format!(
    "{}{}{}",
    policy().key_prefix,
    random_secret()?,
    random_secret()?
  );
  request.account =
    rotate_account(&mut store, request.account.clone(), successor, &HttpRenewal)
      .await?;
  *last_use = Some(std::time::Instant::now());
  Ok(Some(request))
}

pub async fn expired(state: &AccountState) -> Result<bool, String> {
  state.lock().await.expired().await
}

#[tauri::command]
pub async fn account_record_use(
  app: tauri::AppHandle,
  window: WebviewWindow,
  state: State<'_, AccountState>,
) -> Result<(), String> {
  if !matches!(window.label(), "main" | "clipboard" | "clipboard-editor") {
    return Err("account activity is not available in this window".into());
  }
  let _account = foreground_account(&state).await?;
  notify(&app);
  Ok(())
}

async fn prepare_replacement(
  store: &mut AccountStore,
  pending: &PendingLinkedAccount,
) -> Result<LinkOutcome, String> {
  let Some(existing) = store.load().await? else {
    return Ok(LinkOutcome::Linked);
  };
  if is_live_expiry(&existing.credential.expires_at) {
    if existing.credential.key != pending.credential.key {
      return Err(
        "Disconnect the current desktop account before connecting another".into(),
      );
    }
    if existing.api_base_url != pending.api_base_url
      || existing.web_origin != pending.web_origin
    {
      return Err("The current desktop account belongs to a different server".into());
    }
    return Ok(LinkOutcome::Unchanged);
  }
  store.clear().await?;
  Ok(LinkOutcome::Linked)
}

pub async fn link(
  state: &AccountState,
  request: LinkAccountRequest,
  web_origin: &str,
  expected_identity: &DesktopAccountIdentity,
) -> Result<LinkOutcome, String> {
  let pending = LinkedAccount::from_request(request, web_origin)?;
  let _lease = lock_requests().await;
  // Do not publish a profile for a credential the API has not accepted.
  let mut store = state.lock().await;
  let outcome = prepare_replacement(&mut store, &pending).await?;
  if outcome == LinkOutcome::Unchanged {
    return Ok(outcome);
  }
  let config = crate::registry::request(
    crate::registry::RegistryRequestAuth {
      api_base_url: &pending.api_base_url,
      credential_key: &pending.credential.key,
    },
    serde_json::json!({"type":"config"}),
  )
  .await?;
  let account = pending.with_server_account(&config)?;
  if account.identity.user_id != expected_identity.user_id
    || account.identity.organization_id != expected_identity.organization_id
  {
    return Err("Desktop account connection does not match".into());
  }
  store.stage(None).await?;
  store.save(account).await?;
  Ok(LinkOutcome::Linked)
}

pub async fn invalidate(
  state: &AccountState,
  account: &LinkedAccount,
) -> Result<(), String> {
  let mut store = state.lock().await;
  if store
    .load()
    .await?
    .is_some_and(|current| current.credential.key == account.credential.key)
  {
    store.clear().await?;
  }
  Ok(())
}

pub fn notify(app: &tauri::AppHandle) {
  if let Err(error) = app.emit(CHANGED_EVENT, ()) {
    tracing::warn!(error = %error, "desktop account change was not delivered");
  }
}

fn require_account_window(window: &WebviewWindow) -> Result<(), String> {
  match window.label() {
    "main" | crate::clipboard_window::CLIPBOARD_WINDOW_LABEL => Ok(()),
    _ => Err("account command is not available in this window".into()),
  }
}

#[tauri::command]
pub async fn account_get_state(
  window: WebviewWindow,
  state: State<'_, AccountState>,
) -> Result<DesktopAccountSnapshot, String> {
  require_account_window(&window)?;
  if let Some(saved) = current(&state).await? {
    return Ok(saved.snapshot());
  }
  if state.lock().await.expired().await? {
    return Ok(DesktopAccountSnapshot::Expired);
  }
  Ok(DesktopAccountSnapshot::Disconnected)
}

#[tauri::command]
pub async fn account_disconnect(
  app: tauri::AppHandle,
  window: WebviewWindow,
  state: State<'_, AccountState>,
) -> Result<(), String> {
  require_account_window(&window)?;
  let _lease = lock_requests().await;
  let account = match load_account_for_request(&state, RecoveryMode::Disconnect).await {
    Ok(account) => account,
    Err(error) if error == crate::registry::not_connected() => None,
    Err(error) => return Err(error),
  };
  if let Some(saved) = &account {
    match crate::registry::request(
      crate::registry::RegistryRequestAuth {
        api_base_url: &saved.api_base_url,
        credential_key: &saved.credential.key,
      },
      serde_json::json!({"type":"revoke"}),
    )
    .await
    {
      Ok(_) => {}
      Err(error) if error == crate::registry::not_connected() => {}
      Err(error) => return Err(error),
    }
  }
  let mut store = state.lock().await;
  store.clear().await?;
  drop(store);
  notify(&app);
  Ok(())
}

const LINK_APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
const BRIDGE_PROOF_WINDOW_SECONDS: i64 = 30;

struct BrowserConnection {
  correlation_id: String,
  api_base_url: String,
  web_origin: String,
  port_secret: String,
  expires_at: std::time::Instant,
  redemption: LinkRedemption,
}

enum LinkRedemption {
  Waiting {
    verifier: zeroize::Zeroizing<String>,
  },
  Redeeming,
  Connected {
    identity: DesktopAccountIdentity,
  },
  Failed,
}

static BROWSER_CONNECTION: std::sync::Mutex<Option<BrowserConnection>> =
  std::sync::Mutex::new(None);

fn random_secret() -> Result<String, String> {
  use ring::rand::SecureRandom;
  let mut bytes = [0_u8; 32];
  ring::rand::SystemRandom::new()
    .fill(&mut bytes)
    .map_err(|_| "Could not start desktop connection".to_string())?;
  Ok(hex::encode(bytes))
}

fn new_browser_connection(
  api_base_url: &str,
  web_origin: &str,
) -> Result<(BrowserConnection, String), String> {
  use sha2::{Digest, Sha256};
  let api_base_url = crate::config::normalize_self_host_api_base_url(api_base_url)?;
  let web_origin = crate::config::normalize_self_host_web_origin(web_origin)?;
  let verifier = zeroize::Zeroizing::new(random_secret()?);
  let port_secret = random_secret()?;
  let correlation_id = uuid::Uuid::new_v4().to_string();
  let verifier_hash = hex::encode(Sha256::digest(verifier.as_bytes()));
  let mut url = reqwest::Url::parse(&format!("{web_origin}/settings/account/desktop"))
    .map_err(|_| "Could not start desktop connection".to_string())?;
  let protocol = policy().link_protocol.to_string();
  let params = reqwest::Url::parse_with_params(
    "https://localhost",
    [
      ("correlationId", correlation_id.as_str()),
      ("verifierHash", verifier_hash.as_str()),
      ("portSecret", port_secret.as_str()),
      ("protocol", protocol.as_str()),
    ],
  )
  .map_err(|_| "Could not start desktop connection".to_string())?;
  url.set_fragment(Some(&format!(
    "desktop-account?{}",
    params.query().unwrap_or_default()
  )));
  Ok((
    BrowserConnection {
      correlation_id,
      api_base_url,
      web_origin,
      port_secret,
      expires_at: std::time::Instant::now() + LINK_APPROVAL_TIMEOUT,
      redemption: LinkRedemption::Waiting { verifier },
    },
    url.to_string(),
  ))
}

fn begin_browser_connection(
  api_base_url: &str,
  web_origin: &str,
) -> Result<String, String> {
  let (connection, url) = new_browser_connection(api_base_url, web_origin)?;
  let mut pending = BROWSER_CONNECTION
    .lock()
    .map_err(|_| "Desktop connection is unavailable")?;
  reserve_browser_connection(&mut pending, connection, std::time::Instant::now())?;
  Ok(url)
}

fn reserve_browser_connection(
  pending: &mut Option<BrowserConnection>,
  connection: BrowserConnection,
  now: std::time::Instant,
) -> Result<(), String> {
  if pending.as_ref().is_some_and(|current| {
    now < current.expires_at
      && matches!(
        current.redemption,
        LinkRedemption::Waiting { .. } | LinkRedemption::Redeeming
      )
  }) {
    return Err("A desktop account connection is already pending".into());
  }
  *pending = Some(connection);
  Ok(())
}

pub fn open_browser_connection(
  app: &tauri::AppHandle,
  api_base_url: &str,
  web_origin: &str,
) -> Result<(), String> {
  use tauri_plugin_opener::OpenerExt;
  let url = begin_browser_connection(api_base_url, web_origin)?;
  app
    .opener()
    .open_url(url, None::<&str>)
    .map_err(|_| "Could not open desktop connection".into())
}

fn valid_bridge_proof(
  connection: &BrowserConnection,
  timestamp: &str,
  proof: &str,
  method: &str,
  uri: &str,
  now: i64,
) -> bool {
  let Ok(seconds) = timestamp.parse::<i64>() else {
    return false;
  };
  if now.abs_diff(seconds) > BRIDGE_PROOF_WINDOW_SECONDS.unsigned_abs() {
    return false;
  }
  let Ok(signature) = hex::decode(proof) else {
    return false;
  };
  let key =
    ring::hmac::Key::new(ring::hmac::HMAC_SHA256, connection.port_secret.as_bytes());
  ring::hmac::verify(
    &key,
    format!("{timestamp}\n{method}\n{uri}").as_bytes(),
    &signature,
  )
  .is_ok()
}

pub fn authorize_bridge_request(
  origin: Option<&str>,
  timestamp: Option<&str>,
  proof: Option<&str>,
  method: &str,
  uri: &str,
) -> bool {
  let (Some(origin), Some(timestamp), Some(proof)) = (origin, timestamp, proof) else {
    return false;
  };
  let Ok(pending) = BROWSER_CONNECTION.lock() else {
    return false;
  };
  let Some(connection) = pending.as_ref() else {
    return false;
  };
  connection.web_origin == origin
    && std::time::Instant::now() < connection.expires_at
    && method == "GET"
    && valid_bridge_proof(
      connection,
      timestamp,
      proof,
      method,
      uri,
      chrono::Utc::now().timestamp(),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RedeemLinkRequest<'a> {
  correlation_id: &'a str,
  verifier: &'a str,
  expected_user_id: &'a str,
  expected_organization_id: &'a str,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
enum RedeemedLink {
  Connected {
    identity: DesktopAccountIdentity,
  },
  Credential {
    account: LinkedAccountSnapshot,
    #[serde(rename = "organizationName")]
    organization_name: String,
    key: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
  },
}

pub async fn browser_connection_status(
  state: &AccountState,
  correlation_id: &str,
) -> &'static str {
  let expected = {
    let Ok(pending) = BROWSER_CONNECTION.lock() else {
      return "failed";
    };
    let Some(connection) = pending.as_ref() else {
      return "failed";
    };
    if connection.correlation_id != correlation_id
      || std::time::Instant::now() >= connection.expires_at
    {
      return "failed";
    }
    match &connection.redemption {
      LinkRedemption::Waiting { .. } | LinkRedemption::Redeeming => return "pending",
      LinkRedemption::Failed => return "failed",
      LinkRedemption::Connected { identity } => {
        (connection.api_base_url.clone(), identity.clone())
      }
    }
  };
  match current(state).await {
    Ok(Some(account))
      if account.api_base_url == expected.0
        && account.identity.user_id == expected.1.user_id
        && account.identity.organization_id == expected.1.organization_id =>
    {
      "connected"
    }
    Ok(_) | Err(_) => "failed",
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedConnectionStatus {
  correlation_id: String,
  status: &'static str,
  timestamp: String,
  proof: String,
}

pub async fn signed_browser_connection_status(
  state: &AccountState,
  correlation_id: &str,
) -> Result<SignedConnectionStatus, String> {
  let status = browser_connection_status(state, correlation_id).await;
  let pending = BROWSER_CONNECTION
    .lock()
    .map_err(|_| "Desktop connection is unavailable")?;
  let connection = pending
    .as_ref()
    .ok_or("Desktop connection is unavailable")?;
  if connection.correlation_id != correlation_id
    || std::time::Instant::now() >= connection.expires_at
  {
    return Err("Desktop connection is unavailable".into());
  }
  let timestamp = chrono::Utc::now().timestamp().to_string();
  let key =
    ring::hmac::Key::new(ring::hmac::HMAC_SHA256, connection.port_secret.as_bytes());
  let proof = hex::encode(
    ring::hmac::sign(
      &key,
      format!("{correlation_id}\n{status}\n{timestamp}").as_bytes(),
    )
    .as_ref(),
  );
  Ok(SignedConnectionStatus {
    correlation_id: correlation_id.to_string(),
    status,
    timestamp,
    proof,
  })
}

#[cfg(test)]
pub(crate) struct BridgeProofFixture {
  pub correlation_id: String,
  pub port_secret: String,
  previous: Option<BrowserConnection>,
}

#[cfg(test)]
pub(crate) fn bridge_proof_fixture() -> BridgeProofFixture {
  let (connection, _) =
    new_browser_connection("https://api.stll.app", "http://localhost:3000").unwrap();
  let correlation_id = connection.correlation_id.clone();
  let port_secret = connection.port_secret.clone();
  let previous = BROWSER_CONNECTION.lock().unwrap().replace(connection);
  BridgeProofFixture {
    correlation_id,
    port_secret,
    previous,
  }
}

#[cfg(test)]
impl Drop for BridgeProofFixture {
  fn drop(&mut self) {
    *BROWSER_CONNECTION.lock().unwrap() = self.previous.take();
  }
}

struct PendingRedemption {
  correlation_id: String,
  api_base_url: String,
  web_origin: String,
  verifier: zeroize::Zeroizing<String>,
}

impl BrowserConnection {
  fn claim(
    &mut self,
    correlation_id: &str,
    now: std::time::Instant,
  ) -> Result<PendingRedemption, String> {
    if self.correlation_id != correlation_id
      || now >= self.expires_at
      || !matches!(self.redemption, LinkRedemption::Waiting { .. })
    {
      return Err("Desktop connection is unavailable".into());
    }
    let LinkRedemption::Waiting { verifier } =
      std::mem::replace(&mut self.redemption, LinkRedemption::Redeeming)
    else {
      unreachable!("only a waiting connection can be claimed");
    };
    Ok(PendingRedemption {
      correlation_id: self.correlation_id.clone(),
      api_base_url: self.api_base_url.clone(),
      web_origin: self.web_origin.clone(),
      verifier,
    })
  }
}

pub async fn complete_browser_connection(
  app: &tauri::AppHandle,
  correlation_id: &str,
  expected_identity: DesktopAccountIdentity,
) -> Result<(), String> {
  let pending = {
    let mut connection = BROWSER_CONNECTION
      .lock()
      .map_err(|_| "Desktop connection is unavailable")?;
    connection
      .as_mut()
      .ok_or("Desktop connection is unavailable")?
      .claim(correlation_id, std::time::Instant::now())?
  };
  let result = redeem_browser_connection(app, pending, expected_identity.clone()).await;
  if let Ok(mut pending) = BROWSER_CONNECTION.lock()
    && let Some(connection) = pending.as_mut()
    && connection.correlation_id == correlation_id
  {
    connection.redemption = if result.is_ok() {
      LinkRedemption::Connected {
        identity: expected_identity,
      }
    } else {
      LinkRedemption::Failed
    };
  }
  result
}

async fn redeem_browser_connection(
  app: &tauri::AppHandle,
  pending: PendingRedemption,
  expected_identity: DesktopAccountIdentity,
) -> Result<(), String> {
  use tauri::Manager;
  let PendingRedemption {
    api_base_url,
    web_origin,
    verifier,
    correlation_id,
  } = pending;
  let state = app.state::<AccountState>();
  let saved = foreground_account(&state).await?;
  if let Some(saved) = &saved
    && (saved.api_base_url != api_base_url
      || saved.identity.user_id != expected_identity.user_id
      || saved.identity.organization_id != expected_identity.organization_id)
  {
    return Err(
      "Disconnect the current desktop account before connecting another".into(),
    );
  }
  let client =
    crate::http_client::DesktopHttpClient::new(crate::http_client::HttpClientOptions {
      redirect: reqwest::redirect::Policy::none(),
      timeout: None,
    })
    .map_err(|_| "Desktop connection is unavailable")?;
  let mut redeem_request = client
    .post(format!("{api_base_url}/v1/desktop-registry/redeem-link"))
    .header(ACCOUNT_PROTOCOL_HEADER, policy().link_protocol.to_string())
    .json(&RedeemLinkRequest {
      correlation_id: &correlation_id,
      verifier: &verifier,
      expected_user_id: &expected_identity.user_id,
      expected_organization_id: &expected_identity.organization_id,
    })
    .timeout(std::time::Duration::from_secs(20));
  if let Some(saved) = &saved {
    redeem_request = redeem_request.bearer_auth(&saved.credential.key);
  }
  let response = redeem_request
    .send()
    .await
    .map_err(|_| "Desktop connection is unavailable")?;
  drop(verifier);
  if response.status() == reqwest::StatusCode::UPGRADE_REQUIRED {
    return Err("Update stella desktop".into());
  }
  if !response.status().is_success() {
    return Err("Desktop connection was not accepted".into());
  }
  let redeemed = response
    .json::<RedeemedLink>()
    .await
    .map_err(|_| "Desktop connection is unavailable")?;
  let request = match redeemed {
    RedeemedLink::Connected { identity } => {
      let Some(current) = current(&state).await? else {
        return Err("Desktop connection is unavailable".into());
      };
      if identity.user_id != expected_identity.user_id
        || identity.organization_id != expected_identity.organization_id
        || current.identity.user_id != identity.user_id
        || current.identity.organization_id != identity.organization_id
        || current.api_base_url != api_base_url
        || saved
          .as_ref()
          .is_none_or(|saved| saved.credential.key != current.credential.key)
      {
        return Err("Desktop connection does not match".into());
      }
      notify(app);
      return Ok(());
    }
    RedeemedLink::Credential {
      account,
      organization_name,
      key,
      expires_at,
    } => {
      if !is_valid_linked_account(&account) {
        return Err("Desktop connection is unavailable".into());
      }
      let approved = crate::deep_link::show_connection_confirmation(
        app,
        crate::deep_link::ConnectionConfirmation::Account {
          email: &account.email,
          organization_name: &organization_name,
        },
      )
      .await;
      if !matches!(approved, Ok(true)) {
        crate::registry::request(
          crate::registry::RegistryRequestAuth {
            api_base_url: &api_base_url,
            credential_key: &key,
          },
          serde_json::json!({"type":"revoke"}),
        )
        .await?;
        return Err(
          approved
            .err()
            .unwrap_or_else(|| "Desktop account connection was not approved".into()),
        );
      }
      LinkAccountRequest {
        api_base_url: api_base_url.clone(),
        credential: DesktopAccountCredential { key, expires_at },
      }
    }
  };
  let credential_key = request.credential.key.clone();
  drop(saved);
  if let Err(error) = link(&state, request, &web_origin, &expected_identity).await {
    crate::registry::request(
      crate::registry::RegistryRequestAuth {
        api_base_url: &api_base_url,
        credential_key: &credential_key,
      },
      serde_json::json!({"type":"revoke"}),
    )
    .await?;
    return Err(error);
  }
  notify(app);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_unexpired_connection_cannot_be_replaced() {
    let (connection, _) =
      new_browser_connection("https://api.stll.app", "https://my.stll.app").unwrap();
    let original_id = connection.correlation_id.clone();
    let expires_at = connection.expires_at;
    let mut pending = Some(connection);
    let (replacement, _) =
      new_browser_connection("https://api.stll.app", "https://my.stll.app").unwrap();
    assert_eq!(
      reserve_browser_connection(&mut pending, replacement, std::time::Instant::now()),
      Err("A desktop account connection is already pending".into())
    );
    assert_eq!(pending.as_ref().unwrap().correlation_id, original_id);
    let (replacement, _) =
      new_browser_connection("https://api.stll.app", "https://my.stll.app").unwrap();
    let replacement_id = replacement.correlation_id.clone();
    assert!(reserve_browser_connection(&mut pending, replacement, expires_at).is_ok());
    assert_eq!(pending.unwrap().correlation_id, replacement_id);
  }

  #[test]
  fn a_finished_connection_allows_a_fresh_grant() {
    for status in [
      LinkRedemption::Failed,
      LinkRedemption::Connected {
        identity: fixture("stella_dr_fixture", 60).identity,
      },
    ] {
      let (mut connection, _) =
        new_browser_connection("https://api.stll.app", "https://my.stll.app").unwrap();
      connection.redemption = status;
      let mut pending = Some(connection);
      let (replacement, _) =
        new_browser_connection("https://api.stll.app", "https://my.stll.app").unwrap();
      let replacement_id = replacement.correlation_id.clone();
      assert!(
        reserve_browser_connection(
          &mut pending,
          replacement,
          std::time::Instant::now()
        )
        .is_ok()
      );
      assert_eq!(pending.unwrap().correlation_id, replacement_id);
    }
  }

  #[test]
  fn browser_connection_keeps_the_verifier_in_native_memory() {
    use sha2::{Digest, Sha256};
    let (connection, url) =
      new_browser_connection("https://api.stll.app", "https://my.stll.app").unwrap();
    let LinkRedemption::Waiting { verifier } = &connection.redemption else {
      panic!("new connection must wait");
    };
    let parsed = reqwest::Url::parse(&url).unwrap();
    let fragment = parsed
      .fragment()
      .unwrap()
      .strip_prefix("desktop-account?")
      .unwrap();
    let fields: std::collections::HashMap<_, _> =
      reqwest::Url::parse(&format!("https://localhost?{fragment}"))
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    assert_eq!(fields.len(), 4);
    assert_eq!(
      fields.get("protocol"),
      Some(&policy().link_protocol.to_string())
    );
    assert_eq!(
      fields.get("correlationId"),
      Some(&connection.correlation_id)
    );
    assert_eq!(
      fields.get("verifierHash"),
      Some(&hex::encode(Sha256::digest(verifier.as_bytes())))
    );
    assert_eq!(fields.get("portSecret"), Some(&connection.port_secret));
    assert!(!url.contains(verifier.as_str()));
    assert_ne!(verifier.as_str(), connection.port_secret.as_str());
  }

  #[test]
  fn browser_connection_claims_require_a_current_matching_request() {
    let (mut connection, _) =
      new_browser_connection("https://api.stll.app", "https://my.stll.app").unwrap();
    let correlation_id = connection.correlation_id.clone();
    let now = std::time::Instant::now();
    assert!(connection.claim("another", now).is_err());
    assert!(
      connection
        .claim(&correlation_id, connection.expires_at)
        .is_err()
    );
    assert!(connection.claim(&correlation_id, now).is_ok());
    assert!(connection.claim(&correlation_id, now).is_err());
    assert!(matches!(connection.redemption, LinkRedemption::Redeeming));
    connection.redemption = LinkRedemption::Connected {
      identity: fixture("stella_dr_fixture", 60).identity,
    };
    assert!(connection.claim(&correlation_id, now).is_err());
    assert!(matches!(
      connection.redemption,
      LinkRedemption::Connected { .. }
    ));
  }

  #[test]
  fn bridge_proofs_match_the_connection_and_request_window() {
    let (connection, _) =
      new_browser_connection("https://api.stll.app", "https://my.stll.app").unwrap();
    let timestamp = "1790851200";
    let now = timestamp.parse::<i64>().unwrap();
    let path = "/v1/account?apiBaseUrl=https%3A%2F%2Fapi.stll.app";
    let key =
      ring::hmac::Key::new(ring::hmac::HMAC_SHA256, connection.port_secret.as_bytes());
    let proof = hex::encode(
      ring::hmac::sign(&key, format!("{timestamp}\nGET\n{path}").as_bytes()).as_ref(),
    );
    assert!(valid_bridge_proof(
      &connection,
      timestamp,
      &proof,
      "GET",
      path,
      now
    ));
    assert!(valid_bridge_proof(
      &connection,
      timestamp,
      &proof,
      "GET",
      path,
      now + 30
    ));
    for (time, signature, method, uri, at) in [
      (timestamp, "", "GET", path, now),
      (timestamp, "invalid", "GET", path, now),
      (timestamp, proof.as_str(), "POST", path, now),
      (timestamp, proof.as_str(), "GET", "/health", now),
      (timestamp, proof.as_str(), "GET", path, now + 31),
      (timestamp, proof.as_str(), "GET", path, now - 31),
      ("invalid", proof.as_str(), "GET", path, now),
    ] {
      assert!(!valid_bridge_proof(
        &connection,
        time,
        signature,
        method,
        uri,
        at
      ));
    }
    let (another, _) =
      new_browser_connection("https://api.stll.app", "https://my.stll.app").unwrap();
    assert!(!valid_bridge_proof(
      &another, timestamp, &proof, "GET", path, now
    ));
  }

  fn fixture(key: &str, expires_in: i64) -> LinkedAccount {
    LinkedAccount {
      api_base_url: "https://api.stll.app".into(),
      web_origin: "https://my.stll.app".into(),
      identity: DesktopAccountIdentity {
        user_id: "user_fixture".into(),
        organization_id: "org_fixture".into(),
      },
      account: LinkedAccountSnapshot {
        email: "desktop@example.test".into(),
        name: None,
        verified_at: chrono::Utc::now().to_rfc3339(),
      },
      credential: DesktopAccountCredential {
        key: key.into(),
        expires_at: (chrono::Utc::now() + chrono::Duration::seconds(expires_in))
          .to_rfc3339(),
      },
    }
  }

  fn pending(key: &str) -> PendingLinkedAccount {
    PendingLinkedAccount {
      api_base_url: "https://api.stll.app".into(),
      web_origin: "https://my.stll.app".into(),
      credential: fixture(key, 60).credential,
    }
  }

  #[tokio::test]
  async fn a_profile_is_connected_only_while_its_shared_credential_is_live() {
    let max_lifetime = policy().credential_lifetime_seconds + CLOCK_SKEW_SECONDS;
    for lifetime in [-60, 0, 60, max_lifetime, max_lifetime + 60] {
      let state = Arc::new(Mutex::new(AccountStore::Memory(Some(fixture(
        "stella_dr_fixture",
        lifetime,
      )))));
      assert_eq!(
        current(&state).await.unwrap().is_some(),
        lifetime > 0 && lifetime <= max_lifetime
      );
      if lifetime <= 0 || lifetime > max_lifetime {
        assert!(matches!(&*state.lock().await, AccountStore::Memory(None)));
      }
    }
    assert!(!is_live_expiry("not-a-date"));
  }

  #[test]
  fn a_fresh_credential_survives_bounded_clock_skew_in_either_direction() {
    let api_now = chrono::Utc::now();
    let expires_at = (api_now
      + chrono::Duration::seconds(policy().credential_lifetime_seconds))
    .to_rfc3339();
    let local = |offset: i64| api_now + chrono::Duration::seconds(offset);

    assert!(is_live_expiry_at(&expires_at, local(0)));
    assert!(is_live_expiry_at(&expires_at, local(-1)));
    assert!(is_live_expiry_at(&expires_at, local(-CLOCK_SKEW_SECONDS)));
    assert!(!is_live_expiry_at(
      &expires_at,
      local(-CLOCK_SKEW_SECONDS - 1)
    ));
    assert!(is_live_expiry_at(&expires_at, local(CLOCK_SKEW_SECONDS)));
    assert!(is_live_expiry_at(
      &expires_at,
      local(policy().credential_lifetime_seconds - 1)
    ));
    assert!(!is_live_expiry_at(
      &expires_at,
      local(policy().credential_lifetime_seconds)
    ));
  }

  #[tokio::test]
  async fn replacement_requires_disconnect_while_the_saved_credential_is_live() {
    let existing = fixture("stella_dr_existing", 60);
    let mut store = AccountStore::Memory(Some(existing));
    assert_eq!(
      prepare_replacement(&mut store, &pending("stella_dr_existing"))
        .await
        .unwrap(),
      LinkOutcome::Unchanged
    );
    assert_eq!(
      prepare_replacement(&mut store, &pending("stella_dr_other"))
        .await
        .unwrap_err(),
      "Disconnect the current desktop account before connecting another"
    );

    let mut other_server = pending("stella_dr_existing");
    other_server.api_base_url = "https://other.example".into();
    assert_eq!(
      prepare_replacement(&mut store, &other_server)
        .await
        .unwrap_err(),
      "The current desktop account belongs to a different server"
    );

    let mut expired = AccountStore::Memory(Some(fixture("stella_dr_expired", -60)));
    assert_eq!(
      prepare_replacement(&mut expired, &pending("stella_dr_new"))
        .await
        .unwrap(),
      LinkOutcome::Linked
    );
    assert!(matches!(expired, AccountStore::Memory(None)));
  }

  #[tokio::test]
  async fn an_expired_credential_that_cannot_be_removed_blocks_the_link() {
    let mut store = AccountStore::ReadOnly(Some(fixture("stella_dr_expired", -60)));
    assert_eq!(
      prepare_replacement(&mut store, &pending("stella_dr_new"))
        .await
        .unwrap_err(),
      "Could not remove desktop account"
    );

    let state = Arc::new(Mutex::new(AccountStore::ReadOnly(Some(fixture(
      "stella_dr_expired",
      -60,
    )))));
    let Err(error) = current(&state).await else {
      panic!("a credential that cannot be removed must not read as signed out");
    };
    assert_eq!(error, "Could not remove desktop account");
  }

  #[tokio::test]
  async fn an_idempotent_retry_cannot_overwrite_the_saved_profile() {
    let mut existing = fixture("stella_dr_existing", 60);
    existing.account.email = "authenticated@example.test".into();
    let mut store = AccountStore::Memory(Some(existing));

    assert_eq!(
      prepare_replacement(&mut store, &pending("stella_dr_existing"))
        .await
        .unwrap(),
      LinkOutcome::Unchanged
    );
    let AccountStore::Memory(Some(saved)) = store else {
      panic!("idempotent retry must preserve the saved account")
    };
    assert_eq!(saved.account.email, "authenticated@example.test");
  }

  #[test]
  fn authenticated_config_is_the_only_saved_profile_source() {
    let account = pending("stella_dr_fixture")
      .with_server_account(&serde_json::json!({
        "identity": {"userId": "user_server", "organizationId": "org_server"},
        "account": {
          "email": "server@example.test",
          "name": "Server Profile",
          "verifiedAt": "2026-09-12T20:00:00Z"
        }
      }))
      .unwrap();
    assert_eq!(account.account.email, "server@example.test");
    assert_eq!(account.identity.user_id, "user_server");
    assert_eq!(account.identity.organization_id, "org_server");

    for config in [
      serde_json::json!({}),
      serde_json::json!({"account": null}),
      serde_json::json!({"account": {"email":"invalid"}}),
    ] {
      assert!(
        pending("stella_dr_fixture")
          .with_server_account(&config)
          .is_err()
      );
    }
  }

  #[test]
  fn a_profile_without_complete_server_identity_cannot_be_linked() {
    for identity in [
      serde_json::Value::Null,
      serde_json::json!({"userId":"user_server"}),
      serde_json::json!({"organizationId":"org_server"}),
      serde_json::json!({"userId":"", "organizationId":"org_server"}),
      serde_json::json!({"userId":"user_server", "organizationId":"  "}),
    ] {
      let config = serde_json::json!({
        "account": {
          "email":"server@example.test",
          "name":null,
          "verifiedAt":"2026-09-12T20:00:00Z"
        },
        "identity": identity
      });
      assert!(
        pending("stella_dr_fixture")
          .with_server_account(&config)
          .is_err()
      );
    }
  }

  #[tokio::test]
  async fn invalidation_is_idempotent_and_cannot_disconnect_a_newer_account() {
    let old = fixture("stella_dr_old", 60);
    let new = fixture("stella_dr_new", 60);
    let state = Arc::new(Mutex::new(AccountStore::Memory(Some(new.clone()))));
    invalidate(&state, &old).await.unwrap();
    assert_eq!(
      current(&state).await.unwrap().unwrap().credential.key,
      new.credential.key
    );
    invalidate(&state, &new).await.unwrap();
    invalidate(&state, &new).await.unwrap();
    assert!(current(&state).await.unwrap().is_none());
  }

  #[test]
  fn account_persistence_and_link_requests_cannot_omit_the_credential() {
    let saved = fixture("stella_dr_fixture", 60);
    let serialized = serde_json::to_value(&saved).unwrap();
    let restored: LinkedAccount = serde_json::from_value(serialized.clone()).unwrap();
    assert_eq!(restored.account.email, saved.account.email);
    assert_eq!(restored.credential.key, saved.credential.key);
    let mut profile_only = serialized;
    profile_only.as_object_mut().unwrap().remove("credential");
    assert!(serde_json::from_value::<LinkedAccount>(profile_only).is_err());
    assert!(
      serde_json::from_value::<LinkAccountRequest>(serde_json::json!({
        "apiBaseUrl": saved.api_base_url,
      }))
      .is_err()
    );
  }

  struct QueuedRenewal {
    replies: std::sync::Mutex<
      std::collections::VecDeque<Result<RenewalReply, RenewalFailure>>,
    >,
    requests: std::sync::Mutex<Vec<(String, Option<String>)>>,
  }

  impl QueuedRenewal {
    fn new(replies: Vec<Result<RenewalReply, RenewalFailure>>) -> Self {
      Self {
        replies: std::sync::Mutex::new(replies.into()),
        requests: std::sync::Mutex::new(Vec::new()),
      }
    }

    fn requests(&self) -> Vec<(String, Option<String>)> {
      self.requests.lock().unwrap().clone()
    }
  }

  impl RenewalTransport for QueuedRenewal {
    async fn send(
      &self,
      account: &LinkedAccount,
      successor: Option<&str>,
    ) -> Result<RenewalReply, RenewalFailure> {
      self
        .requests
        .lock()
        .unwrap()
        .push((account.credential.key.clone(), successor.map(str::to_owned)));
      self
        .replies
        .lock()
        .unwrap()
        .pop_front()
        .expect("unexpected renewal request")
    }
  }

  fn renewal_reply(account: &LinkedAccount) -> RenewalReply {
    RenewalReply {
      expires_at: (chrono::Utc::now()
        + chrono::Duration::seconds(policy().credential_lifetime_seconds))
      .to_rfc3339(),
      identity: account.identity.clone(),
    }
  }

  fn rotation_fixture(account: LinkedAccount) -> AccountStore {
    AccountStore::Fixture(AccountFixture {
      saved: Some(account),
      pending: Some(PendingRotation {
        successor_key: "stella_dr_successor".into(),
      }),
      expired: false,
      fault: None,
    })
  }

  async fn assert_rotation_pending(store: &AccountStore, original: &LinkedAccount) {
    assert_eq!(
      serde_json::to_value(store.load().await.unwrap().unwrap()).unwrap(),
      serde_json::to_value(original).unwrap()
    );
    assert_eq!(
      store.pending().await.unwrap().unwrap().successor_key,
      "stella_dr_successor"
    );
    assert!(!store.expired().await.unwrap());
  }

  #[tokio::test]
  async fn lost_rotation_response_survives_restart_and_only_probes_the_successor() {
    let original = fixture("stella_dr_original", 60);
    let mut store = AccountStore::Fixture(AccountFixture {
      saved: Some(original.clone()),
      ..AccountFixture::default()
    });
    let transport = QueuedRenewal::new(vec![Err(RenewalFailure::Unavailable(
      "lost response".into(),
    ))]);
    assert!(
      rotate_account(
        &mut store,
        original.clone(),
        "stella_dr_successor".into(),
        &transport
      )
      .await
      .is_err()
    );
    assert_eq!(
      transport.requests(),
      vec![(
        "stella_dr_original".into(),
        Some("stella_dr_successor".into())
      )]
    );
    assert_rotation_pending(&store, &original).await;
    let mut restarted = AccountStore::Fixture(AccountFixture {
      saved: store.load().await.unwrap(),
      pending: store.pending().await.unwrap(),
      expired: store.expired().await.unwrap(),
      fault: None,
    });
    let recovery = QueuedRenewal::new(vec![Ok(renewal_reply(&original))]);
    let recovered = recover_rotation(
      &mut restarted,
      original.clone(),
      &recovery,
      RecoveryMode::ProbeOnly,
    )
    .await
    .unwrap();
    assert_eq!(
      recovery.requests(),
      vec![("stella_dr_successor".into(), None)]
    );
    assert_eq!(recovered.credential.key, "stella_dr_successor");
    assert_eq!(
      restarted.load().await.unwrap().unwrap().credential.key,
      "stella_dr_successor"
    );
    assert!(restarted.pending().await.unwrap().is_none());
    assert_eq!(recovered.account.email, original.account.email);
    assert!(is_live_expiry(&recovered.credential.expires_at));
  }

  #[tokio::test]
  async fn unknown_successor_probe_never_retries_the_original_in_any_recovery_mode() {
    for mode in [
      RecoveryMode::ProbeOnly,
      RecoveryMode::Foreground,
      RecoveryMode::Disconnect,
    ] {
      let original = fixture("stella_dr_original", 60);
      let mut store = rotation_fixture(original.clone());
      let transport = QueuedRenewal::new(vec![Err(RenewalFailure::Unavailable(
        "probe unavailable".into(),
      ))]);
      assert_eq!(
        recover_rotation(&mut store, original.clone(), &transport, mode)
          .await
          .err()
          .as_deref(),
        Some("probe unavailable")
      );
      assert_eq!(
        transport.requests(),
        vec![("stella_dr_successor".into(), None)]
      );
      assert_rotation_pending(&store, &original).await;
    }
  }

  #[tokio::test]
  async fn definite_successor_rejection_permits_the_foreground_original_transition() {
    let original = fixture("stella_dr_original", 60);
    let mut store = rotation_fixture(original.clone());
    let transport = QueuedRenewal::new(vec![
      Err(RenewalFailure::Rejected),
      Ok(renewal_reply(&original)),
    ]);
    let recovered =
      recover_rotation(&mut store, original, &transport, RecoveryMode::Foreground)
        .await
        .unwrap();
    assert_eq!(
      transport.requests(),
      vec![
        ("stella_dr_successor".into(), None),
        (
          "stella_dr_original".into(),
          Some("stella_dr_successor".into())
        ),
      ]
    );
    assert_eq!(recovered.credential.key, "stella_dr_successor");
    assert!(store.pending().await.unwrap().is_none());
  }

  #[tokio::test]
  async fn throttled_rotation_keeps_the_current_key_and_drops_the_successor() {
    let original = fixture("stella_dr_original", 60);
    let mut store = AccountStore::Fixture(AccountFixture {
      saved: Some(original.clone()),
      ..AccountFixture::default()
    });
    let transport = QueuedRenewal::new(vec![Err(RenewalFailure::Throttled)]);
    let kept = rotate_account(
      &mut store,
      original.clone(),
      "stella_dr_successor".into(),
      &transport,
    )
    .await
    .unwrap();
    assert_eq!(
      transport.requests(),
      vec![(
        "stella_dr_original".into(),
        Some("stella_dr_successor".into())
      )]
    );
    assert_eq!(kept.credential.key, original.credential.key);
    assert_eq!(
      store.load().await.unwrap().unwrap().credential.key,
      original.credential.key
    );
    assert!(store.pending().await.unwrap().is_none());
    assert!(!store.expired().await.unwrap());
    assert!(policy().rotation_interval_seconds > 0);
  }

  #[tokio::test]
  async fn throttled_recovery_keeps_the_pending_successor() {
    let original = fixture("stella_dr_original", 60);
    let mut store = rotation_fixture(original.clone());
    let transport = QueuedRenewal::new(vec![
      Err(RenewalFailure::Rejected),
      Err(RenewalFailure::Throttled),
    ]);
    assert_eq!(
      recover_rotation(
        &mut store,
        original.clone(),
        &transport,
        RecoveryMode::Foreground
      )
      .await
      .err(),
      Some(crate::registry::rate_limited())
    );
    assert_rotation_pending(&store, &original).await;
  }

  #[tokio::test]
  async fn foreground_recovery_adopts_a_successor_committed_during_the_retry() {
    let original = fixture("stella_dr_original", 60);
    let mut store = rotation_fixture(original.clone());
    let transport = QueuedRenewal::new(vec![
      Err(RenewalFailure::Rejected),
      Err(RenewalFailure::Rejected),
      Ok(renewal_reply(&original)),
    ]);
    let recovered =
      recover_rotation(&mut store, original, &transport, RecoveryMode::Foreground)
        .await
        .unwrap();
    assert_eq!(
      transport.requests(),
      vec![
        ("stella_dr_successor".into(), None),
        (
          "stella_dr_original".into(),
          Some("stella_dr_successor".into())
        ),
        ("stella_dr_successor".into(), None),
      ]
    );
    assert_eq!(recovered.credential.key, "stella_dr_successor");
    assert_eq!(
      store.load().await.unwrap().unwrap().credential.key,
      "stella_dr_successor"
    );
    assert!(store.pending().await.unwrap().is_none());
    assert!(!store.expired().await.unwrap());
  }

  #[tokio::test]
  async fn foreground_recovery_clears_only_after_both_generations_are_rejected() {
    let original = fixture("stella_dr_original", 60);
    let mut store = rotation_fixture(original.clone());
    let transport = QueuedRenewal::new(vec![
      Err(RenewalFailure::Rejected),
      Err(RenewalFailure::Rejected),
      Err(RenewalFailure::Rejected),
    ]);
    assert_eq!(
      recover_rotation(&mut store, original, &transport, RecoveryMode::Foreground)
        .await
        .err(),
      Some(crate::registry::not_connected())
    );
    assert_eq!(transport.requests().len(), 3);
    assert!(store.load().await.unwrap().is_none());
    assert!(store.pending().await.unwrap().is_none());
  }

  #[tokio::test]
  async fn background_recovery_cannot_rotate_or_revive_a_rejected_successor() {
    for seconds in [60, -60] {
      let original = fixture("stella_dr_original", seconds);
      let mut store = rotation_fixture(original.clone());
      let transport = QueuedRenewal::new(vec![Err(RenewalFailure::Rejected)]);
      assert!(
        recover_rotation(
          &mut store,
          original.clone(),
          &transport,
          RecoveryMode::ProbeOnly
        )
        .await
        .is_err()
      );
      assert_eq!(
        transport.requests(),
        vec![("stella_dr_successor".into(), None)]
      );
      assert_rotation_pending(&store, &original).await;
    }
  }

  #[tokio::test]
  async fn disconnect_recovers_the_original_by_probe_without_rotating_it() {
    let original = fixture("stella_dr_original", 60);
    let mut store = rotation_fixture(original.clone());
    let transport = QueuedRenewal::new(vec![
      Err(RenewalFailure::Rejected),
      Ok(renewal_reply(&original)),
    ]);
    let recovered = recover_rotation(
      &mut store,
      original.clone(),
      &transport,
      RecoveryMode::Disconnect,
    )
    .await
    .unwrap();
    assert_eq!(
      transport.requests(),
      vec![
        ("stella_dr_successor".into(), None),
        ("stella_dr_original".into(), None)
      ]
    );
    assert_eq!(recovered.credential.key, original.credential.key);
    assert_eq!(
      store.load().await.unwrap().unwrap().credential.key,
      original.credential.key
    );
    assert!(store.pending().await.unwrap().is_none());
  }

  #[tokio::test]
  async fn disconnect_adopts_a_successor_committed_between_the_probes() {
    let original = fixture("stella_dr_original", 60);
    let mut store = rotation_fixture(original.clone());
    let transport = QueuedRenewal::new(vec![
      Err(RenewalFailure::Rejected),
      Err(RenewalFailure::Rejected),
      Ok(renewal_reply(&original)),
    ]);
    let recovered =
      recover_rotation(&mut store, original, &transport, RecoveryMode::Disconnect)
        .await
        .unwrap();
    assert_eq!(
      transport.requests(),
      vec![
        ("stella_dr_successor".into(), None),
        ("stella_dr_original".into(), None),
        ("stella_dr_successor".into(), None),
      ]
    );
    assert_eq!(recovered.credential.key, "stella_dr_successor");
    assert_eq!(
      store.load().await.unwrap().unwrap().credential.key,
      "stella_dr_successor"
    );
    assert!(store.pending().await.unwrap().is_none());
  }

  #[tokio::test]
  async fn disconnect_clears_only_after_both_generations_are_rejected() {
    let original = fixture("stella_dr_original", 60);
    let mut store = rotation_fixture(original.clone());
    let transport = QueuedRenewal::new(vec![
      Err(RenewalFailure::Rejected),
      Err(RenewalFailure::Rejected),
      Err(RenewalFailure::Rejected),
    ]);
    assert_eq!(
      recover_rotation(&mut store, original, &transport, RecoveryMode::Disconnect)
        .await
        .err(),
      Some(crate::registry::not_connected())
    );
    assert_eq!(transport.requests().len(), 3);
    assert!(store.load().await.unwrap().is_none());
    assert!(store.pending().await.unwrap().is_none());
  }

  #[tokio::test]
  async fn invalid_renewal_identity_or_expiry_preserves_the_original_and_journal() {
    for (invalid, mode) in [
      "user",
      "organization",
      "malformed-expiry",
      "expired",
      "unbounded-expiry",
    ]
    .into_iter()
    .flat_map(|invalid| {
      [
        (invalid, RecoveryMode::Foreground),
        (invalid, RecoveryMode::Disconnect),
      ]
    }) {
      let original = fixture("stella_dr_original", 60);
      let mut reply = renewal_reply(&original);
      match invalid {
        "user" => reply.identity.user_id = "other-user".into(),
        "organization" => reply.identity.organization_id = "other-organization".into(),
        "malformed-expiry" => reply.expires_at = "not-a-date".into(),
        "expired" => {
          reply.expires_at =
            (chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339()
        }
        "unbounded-expiry" => {
          reply.expires_at = (chrono::Utc::now()
            + chrono::Duration::seconds(
              policy().credential_lifetime_seconds + CLOCK_SKEW_SECONDS + 60,
            ))
          .to_rfc3339()
        }
        _ => unreachable!(),
      }
      let mut store = rotation_fixture(original.clone());
      let replies = if matches!(mode, RecoveryMode::Disconnect) {
        vec![Err(RenewalFailure::Rejected), Ok(reply)]
      } else {
        vec![Ok(reply)]
      };
      let transport = QueuedRenewal::new(replies);
      assert!(
        recover_rotation(&mut store, original.clone(), &transport, mode)
          .await
          .is_err()
      );
      let expected = if matches!(mode, RecoveryMode::Disconnect) {
        vec![
          ("stella_dr_successor".into(), None),
          ("stella_dr_original".into(), None),
        ]
      } else {
        vec![("stella_dr_successor".into(), None)]
      };
      assert_eq!(transport.requests(), expected);
      assert_rotation_pending(&store, &original).await;
    }
  }

  #[tokio::test]
  async fn staging_failure_prevents_any_rotation_network_request() {
    let original = fixture("stella_dr_original", 60);
    let mut store = AccountStore::ReadOnly(Some(original.clone()));
    let transport = QueuedRenewal::new(vec![]);
    assert!(
      rotate_account(
        &mut store,
        original.clone(),
        "stella_dr_successor".into(),
        &transport
      )
      .await
      .is_err()
    );
    assert!(transport.requests().is_empty());
    assert_eq!(
      store.load().await.unwrap().unwrap().credential.key,
      original.credential.key
    );
  }

  #[tokio::test]
  async fn expiration_keeps_only_a_marker_and_explicit_disconnect_resets_it() {
    let original = fixture("stella_dr_original", -60);
    let state = Arc::new(Mutex::new(AccountStore::Fixture(AccountFixture {
      saved: Some(original),
      ..AccountFixture::default()
    })));
    assert!(current(&state).await.unwrap().is_none());
    assert!(expired(&state).await.unwrap());
    let mut store = state.lock().await;
    assert!(store.load().await.unwrap().is_none());
    assert!(store.pending().await.unwrap().is_none());
    let AccountStore::Fixture(fixture) = &*store else {
      panic!("fixture store required")
    };
    assert!(fixture.saved.is_none());
    assert!(fixture.pending.is_none());
    store.clear().await.unwrap();
    assert!(!store.expired().await.unwrap());
    assert!(store.load().await.unwrap().is_none());
  }

  #[tokio::test]
  async fn storage_failure_after_server_rotation_preserves_restart_recovery() {
    for fault in [StorageFault::Save, StorageFault::ClearRotation] {
      let original = fixture("stella_dr_original", 60);
      let mut store = AccountStore::Fixture(AccountFixture {
        saved: Some(original.clone()),
        fault: Some(fault),
        ..AccountFixture::default()
      });
      let transport = QueuedRenewal::new(vec![Ok(renewal_reply(&original))]);
      assert!(
        rotate_account(
          &mut store,
          original.clone(),
          "stella_dr_successor".into(),
          &transport
        )
        .await
        .is_err()
      );
      assert_eq!(
        store.pending().await.unwrap().unwrap().successor_key,
        "stella_dr_successor"
      );
      let saved = store.load().await.unwrap().unwrap();
      assert_eq!(
        saved.credential.key,
        if matches!(fault, StorageFault::Save) {
          "stella_dr_original"
        } else {
          "stella_dr_successor"
        }
      );
      let mut restarted = AccountStore::Fixture(AccountFixture {
        saved: Some(saved.clone()),
        pending: store.pending().await.unwrap(),
        ..AccountFixture::default()
      });
      let probe = QueuedRenewal::new(vec![Ok(renewal_reply(&original))]);
      let recovered =
        recover_rotation(&mut restarted, saved, &probe, RecoveryMode::ProbeOnly)
          .await
          .unwrap();
      assert_eq!(recovered.credential.key, "stella_dr_successor");
      assert_eq!(probe.requests(), vec![("stella_dr_successor".into(), None)]);
      assert!(restarted.pending().await.unwrap().is_none());
    }
  }
  #[test]
  fn account_link_protocol_matches_the_api_policy_and_advertised_capability() {
    assert!(
      crate::types::BRIDGE_CAPABILITIES
        .contains(&format!("account-link.v{}", policy().link_protocol).as_str())
    );
    let source =
      include_str!("../../../../packages/api-contract/src/desktop-registry.ts");
    assert!(source.contains(&format!("\"{ACCOUNT_PROTOCOL_HEADER}\"")));
  }
}
