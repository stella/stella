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

pub fn is_live_expiry(value: &str) -> bool {
  chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|expires| {
    let remaining = expires
      .signed_duration_since(chrono::Utc::now())
      .num_seconds();
    remaining > 0 && remaining <= policy().credential_lifetime_seconds
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

#[cfg(test)]
mod tests {
  use super::*;

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
    let max_lifetime = policy().credential_lifetime_seconds;
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
