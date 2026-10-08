//! The Keychain record is the account link: profile and usable credential are
//! committed together. A remembered document-edit profile is not a login.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, State, WebviewWindow};
use tokio::sync::Mutex;

use crate::types::{
  DesktopAccountCredential, DesktopAccountIdentity, DesktopAccountSnapshot,
  LinkAccountRequest, LinkedAccountSnapshot, is_valid_linked_account,
};

pub const CHANGED_EVENT: &str = "desktop-account-changed";
pub type AccountState = Arc<Mutex<AccountStore>>;

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
  /// Length-delimited identity fields prevent ambiguous concatenations. Only
  /// the digest is used in local paths and keychain account names.
  pub(crate) fn local_data_namespace(&self) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for field in [
      self.api_base_url.as_str(),
      self.identity.organization_id.as_str(),
      self.identity.user_id.as_str(),
    ] {
      hash.update((field.len() as u64).to_be_bytes());
      hash.update(field.as_bytes());
    }
    hex::encode(hash.finalize())
  }

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

  pub(crate) fn request_auth(&self) -> crate::registry::RegistryRequestAuth<'_> {
    crate::registry::RegistryRequestAuth {
      api_base_url: &self.api_base_url,
      credential_key: &self.credential.key,
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
        crate::keychain::store_account_connection(value).await
      }
      #[cfg(test)]
      Self::Memory(saved) => {
        *saved = Some(account);
        Ok(())
      }
      #[cfg(test)]
      Self::ReadOnly(_) => Err("Could not save desktop account".into()),
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
    store.clear().await?;
    return Ok(None);
  }
  Ok(saved)
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
  crate::feature_access::account_changed(app);
  crate::activity::unload_account(app);
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
  Ok(current(&state).await?.map_or(
    DesktopAccountSnapshot::Disconnected,
    LinkedAccount::snapshot,
  ))
}

#[tauri::command]
pub async fn account_disconnect(
  app: tauri::AppHandle,
  window: WebviewWindow,
  state: State<'_, AccountState>,
) -> Result<(), String> {
  require_account_window(&window)?;
  let mut store = state.lock().await;
  if let Some(saved) = store.load().await? {
    match crate::registry::request(
      saved.request_auth(),
      serde_json::json!({"type":"revoke"}),
    )
    .await
    {
      Ok(_) => {}
      Err(error) if error == crate::registry::not_connected() => {}
      Err(error) => return Err(error),
    }
  }
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
  let params = reqwest::Url::parse_with_params(
    "https://localhost",
    [
      ("correlationId", correlation_id.as_str()),
      ("verifierHash", verifier_hash.as_str()),
      ("portSecret", port_secret.as_str()),
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
  let saved = current(&state).await?;
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
    assert_eq!(fields.len(), 3);
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

  #[test]
  fn local_data_namespaces_bind_origin_organization_and_user_only() {
    let a = fixture("stella_dr_a", 3600);
    let namespace = a.local_data_namespace();
    assert_eq!(namespace.len(), 64);
    assert!(namespace.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let mut refreshed = a.clone();
    refreshed.credential.key = "stella_dr_rotated".into();
    refreshed.account.email = "changed@example.test".into();
    assert_eq!(namespace, refreshed.local_data_namespace());
    for field in ["origin", "organization", "user"] {
      let mut b = a.clone();
      match field {
        "origin" => b.api_base_url = "https://another.example.test".into(),
        "organization" => b.identity.organization_id.push_str("-other"),
        "user" => b.identity.user_id.push_str("-other"),
        _ => unreachable!(),
      }
      assert_ne!(namespace, b.local_data_namespace());
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
}
