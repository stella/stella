//! OS keychain storage for desktop edit session tokens.
//!
//! Each session token is stored as a separate keychain entry under the
//! build profile's service name, keyed by `session:<sessionId>`. This keeps
//! tokens out of the JSON session store on disk without letting development
//! builds claim production entries.

use std::{
  collections::HashMap,
  error::Error as StdError,
  fmt,
  sync::{Mutex, OnceLock},
};

use crate::config::KEYCHAIN_SERVICE_NAME;
use keyring_core::{Entry, Error};

const CLIPBOARD_HISTORY_KEY: &str = "clipboard:history:v1";
const ACCOUNT_CONNECTION_KEY: &str = "account:connection:v1";
const LEGACY_REGISTRY_ACCOUNT_KEY: &str = "registry:account:v1";
const ACCOUNT_EXPIRED_KEY: &str = "account:expired:v1";
const ACCOUNT_DEVICE_KEY: &str = "account:device-key:pkcs8:v1";
const ACCOUNT_ROTATION_KEY: &str = "account:rotation:v1";
const ACCOUNT_KEYS_TO_DELETE: [&str; 4] = [
  ACCOUNT_CONNECTION_KEY,
  LEGACY_REGISTRY_ACCOUNT_KEY,
  ACCOUNT_EXPIRED_KEY,
  ACCOUNT_ROTATION_KEY,
];

fn delete_named_credential(key: &str) -> Result<(), String> {
  match named_entry(key)?.delete_credential() {
    Ok(()) | Err(Error::NoEntry) => Ok(()),
    Err(_) => Err("Could not remove desktop account from Keychain".to_string()),
  }
}

fn delete_account_keys(
  mut delete: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
  let mut failure = None;
  for key in ACCOUNT_KEYS_TO_DELETE {
    if let Err(error) = delete(key)
      && failure.is_none()
    {
      failure = Some(error);
    }
  }
  failure.map_or(Ok(()), Err)
}

// Migration cleanup only: a failure here must never block the current
// account record from being read or written.
fn delete_legacy_registry_account() {
  if let Err(error) = delete_named_credential(LEGACY_REGISTRY_ACCOUNT_KEY) {
    tracing::warn!(error = %error, "legacy registry account cleanup failed");
  }
}

pub async fn delete_account_connection() -> Result<(), String> {
  tokio::task::spawn_blocking(|| delete_account_keys(delete_named_credential))
    .await
    .map_err(|_| "Account Keychain task failed".to_string())?
}

pub async fn store_account_connection(value: String) -> Result<(), String> {
  tokio::task::spawn_blocking(move || {
    delete_legacy_registry_account();
    named_entry(ACCOUNT_CONNECTION_KEY)?
      .set_password(&value)
      .map_err(|_| "Could not save desktop account in Keychain".to_string())
  })
  .await
  .map_err(|_| "Account Keychain task failed".to_string())?
}

pub async fn get_account_connection() -> Result<Option<String>, String> {
  let read = tokio::task::spawn_blocking(|| {
    delete_legacy_registry_account();
    match named_entry(ACCOUNT_CONNECTION_KEY)?.get_password() {
      Ok(value) => Ok(Some(value)),
      Err(Error::NoEntry) => Ok(None),
      Err(_) => Err("Account Keychain read failed".to_string()),
    }
  });
  tokio::time::timeout(std::time::Duration::from_secs(5), read)
    .await
    .map_err(|_| "Account Keychain read timed out".to_string())?
    .map_err(|_| "Account Keychain task failed".to_string())?
}

#[derive(Debug)]
pub struct KeychainReadUnavailable;

impl fmt::Display for KeychainReadUnavailable {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("keychain read unavailable")
  }
}

impl StdError for KeychainReadUnavailable {}

static KEYRING_INIT: OnceLock<()> = OnceLock::new();
static KEYRING_INIT_LOCK: Mutex<()> = Mutex::new(());

fn entry_key(session_id: &str) -> String {
  format!("session:{session_id}")
}

fn entry(session_id: &str) -> Result<Entry, String> {
  ensure_default_store()?;
  Entry::new(KEYCHAIN_SERVICE_NAME, &entry_key(session_id))
    .map_err(|e| format!("keychain entry error: {e}"))
}

fn named_entry(key: &str) -> Result<Entry, String> {
  ensure_default_store()?;
  Entry::new(KEYCHAIN_SERVICE_NAME, key)
    .map_err(|e| format!("keychain entry error: {e}"))
}

fn ensure_default_store() -> Result<(), String> {
  if KEYRING_INIT.get().is_some() {
    return Ok(());
  }

  let _guard = KEYRING_INIT_LOCK
    .lock()
    .map_err(|_| "keychain init lock poisoned".to_string())?;
  if KEYRING_INIT.get().is_some() {
    return Ok(());
  }

  set_default_store()?;
  let _ = KEYRING_INIT.set(());
  Ok(())
}

fn set_default_store() -> Result<(), String> {
  let config = HashMap::new();
  set_platform_default_store(&config).map_err(|e| format!("keychain store error: {e}"))
}

#[cfg(target_os = "macos")]
fn set_platform_default_store(
  config: &HashMap<&str, &str>,
) -> keyring_core::Result<()> {
  keyring_core::set_default_store(
    apple_native_keyring_store::keychain::Store::new_with_configuration(config)?,
  );
  Ok(())
}

#[cfg(target_os = "windows")]
fn set_platform_default_store(
  config: &HashMap<&str, &str>,
) -> keyring_core::Result<()> {
  keyring_core::set_default_store(
    windows_native_keyring_store::Store::new_with_configuration(config)?,
  );
  Ok(())
}

#[cfg(target_os = "linux")]
fn set_platform_default_store(
  config: &HashMap<&str, &str>,
) -> keyring_core::Result<()> {
  keyring_core::set_default_store(
    zbus_secret_service_keyring_store::Store::new_with_configuration(config)?,
  );
  Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn set_platform_default_store(
  _config: &HashMap<&str, &str>,
) -> keyring_core::Result<()> {
  Err(Error::NotSupportedByStore(
    "stella desktop keychain is only supported on Linux, macOS, and Windows"
      .to_string(),
  ))
}

/// Store a session token in the OS keychain.
pub fn store_token(session_id: &str, token: &str) -> Result<(), String> {
  entry(session_id)?
    .set_password(token)
    .map_err(|e| format!("keychain store error: {e}"))
}

/// Retrieve a session token without letting a blocked keychain call wedge the
/// caller. Platform keychain reads can stall on user authorization (e.g. when
/// the binary changed and the OS re-prompts); the read runs on a blocking
/// thread and is abandoned after `timeout` so callers holding the session
/// manager lock stay responsive.
pub async fn get_token_with_timeout(
  session_id: &str,
  timeout: std::time::Duration,
) -> Result<Option<String>, KeychainReadUnavailable> {
  let id = session_id.to_string();
  let read = tokio::task::spawn_blocking(move || match entry(&id) {
    Ok(e) => match e.get_password() {
      Ok(token) => Ok(Some(token)),
      Err(Error::NoEntry) => Ok(None),
      Err(e) => {
        tracing::warn!(session_id = %id, error = %e, "keychain read failed");
        Err(KeychainReadUnavailable)
      }
    },
    Err(e) => {
      tracing::warn!(session_id = %id, error = %e, "keychain entry creation failed");
      Err(KeychainReadUnavailable)
    }
  });
  match tokio::time::timeout(timeout, read).await {
    Ok(Ok(result)) => result,
    Ok(Err(e)) => {
      tracing::warn!(session_id, error = %e, "keychain read task failed");
      Err(KeychainReadUnavailable)
    }
    Err(_) => {
      tracing::warn!(session_id, "keychain read timed out");
      Err(KeychainReadUnavailable)
    }
  }
}

/// Delete a session token from the OS keychain.
/// Silently succeeds if the entry does not exist.
pub fn delete_token(session_id: &str) {
  if let Ok(e) = entry(session_id) {
    match e.delete_credential() {
      Ok(()) => {}
      Err(Error::NoEntry) => {}
      Err(e) => {
        tracing::warn!(session_id, error = %e, "keychain delete failed");
      }
    }
  }
}

pub enum ClipboardKeyLookup {
  Found([u8; 32]),
  Missing,
}

/// Look up the clipboard history encryption key. The caller decides
/// whether a missing key may be created: it must not be while an
/// encrypted history file still depends on the old one.
pub fn get_clipboard_key() -> Result<ClipboardKeyLookup, String> {
  let key_entry = named_entry(CLIPBOARD_HISTORY_KEY)?;
  match key_entry.get_secret() {
    Ok(secret) => secret
      .try_into()
      .map(ClipboardKeyLookup::Found)
      .map_err(|_| "clipboard key has an invalid length".to_string()),
    Err(Error::NoEntry) => Ok(ClipboardKeyLookup::Missing),
    Err(e) => Err(format!("keychain read error: {e}")),
  }
}

/// Mint and store a fresh clipboard history key.
pub fn create_clipboard_key() -> Result<[u8; 32], String> {
  use aes_gcm::{Aes256Gcm, Key, aead::Generate};

  let key = Key::<Aes256Gcm>::generate();
  named_entry(CLIPBOARD_HISTORY_KEY)?
    .set_secret(&key)
    .map_err(|e| format!("keychain store error: {e}"))?;
  Ok(key.into())
}

pub async fn get_account_rotation() -> Result<Option<String>, String> {
  let read = tokio::task::spawn_blocking(|| {
    match named_entry(ACCOUNT_ROTATION_KEY)?.get_password() {
      Ok(value) => Ok(Some(value)),
      Err(Error::NoEntry) => Ok(None),
      Err(_) => Err("Account rotation Keychain read failed".into()),
    }
  });
  tokio::time::timeout(std::time::Duration::from_secs(5), read)
    .await
    .map_err(|_| "Account Keychain read timed out".to_string())?
    .map_err(|_| "Account Keychain task failed".to_string())?
}

pub async fn set_account_rotation(value: Option<String>) -> Result<(), String> {
  tokio::task::spawn_blocking(move || match value {
    Some(value) => named_entry(ACCOUNT_ROTATION_KEY)?
      .set_password(&value)
      .map_err(|_| "Could not stage account rotation in Keychain".to_string()),
    None => delete_named_credential(ACCOUNT_ROTATION_KEY),
  })
  .await
  .map_err(|_| "Account Keychain task failed".to_string())?
}

pub async fn account_expired() -> Result<bool, String> {
  tokio::task::spawn_blocking(|| {
    match named_entry(ACCOUNT_EXPIRED_KEY)?.get_password() {
      Ok(_) => Ok(true),
      Err(Error::NoEntry) => Ok(false),
      Err(_) => Err("Account expiry Keychain read failed".into()),
    }
  })
  .await
  .map_err(|_| "Account Keychain task failed".to_string())?
}

fn mark_account_expired_with(
  write_marker: impl FnOnce() -> Result<(), String>,
  mut delete: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
  write_marker()?;
  let mut failure = None;
  for key in ACCOUNT_KEYS_TO_DELETE
    .into_iter()
    .filter(|key| *key != ACCOUNT_EXPIRED_KEY)
  {
    if let Err(error) = delete(key)
      && failure.is_none()
    {
      failure = Some(error);
    }
  }
  failure.map_or(Ok(()), Err)
}

pub async fn mark_account_expired() -> Result<(), String> {
  tokio::task::spawn_blocking(|| {
    mark_account_expired_with(
      || {
        named_entry(ACCOUNT_EXPIRED_KEY)?
          .set_password("expired")
          .map_err(|_| "Could not save account expiry in Keychain".to_string())
      },
      delete_named_credential,
    )
  })
  .await
  .map_err(|_| "Account Keychain task failed".to_string())?
}

pub async fn clear_account_expired() -> Result<(), String> {
  tokio::task::spawn_blocking(|| delete_named_credential(ACCOUNT_EXPIRED_KEY))
    .await
    .map_err(|_| "Account Keychain task failed".to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn account_cleanup_owns_current_and_released_key_names() {
    let mut deleted = Vec::new();
    delete_account_keys(|key| {
      deleted.push(key.to_string());
      Ok(())
    })
    .unwrap();

    assert_eq!(deleted, ACCOUNT_KEYS_TO_DELETE);
  }

  #[test]
  fn account_cleanup_attempts_the_legacy_key_after_a_current_key_failure() {
    let mut deleted = Vec::new();
    let error = delete_account_keys(|key| {
      deleted.push(key.to_string());
      if key == ACCOUNT_CONNECTION_KEY {
        return Err("current key failure".into());
      }
      Ok(())
    })
    .unwrap_err();

    assert_eq!(error, "current key failure");
    assert_eq!(deleted, ACCOUNT_KEYS_TO_DELETE);
  }
  #[test]
  fn expiry_marker_is_durable_before_secret_cleanup_and_survives_its_failure() {
    let marked = std::cell::Cell::new(false);
    let mut deleted = Vec::new();
    assert!(
      mark_account_expired_with(
        || {
          marked.set(true);
          Ok(())
        },
        |key| {
          assert!(marked.get());
          assert_ne!(key, ACCOUNT_EXPIRED_KEY);
          deleted.push(key.to_string());
          Err("cleanup unavailable".into())
        },
      )
      .is_err()
    );
    assert!(marked.get());
    assert_eq!(deleted.len(), ACCOUNT_KEYS_TO_DELETE.len() - 1);
    assert!(
      mark_account_expired_with(
        || Err("marker unavailable".into()),
        |_| panic!("credential must remain until its expiry reason is durable"),
      )
      .is_err()
    );
  }
}

pub(crate) async fn get_account_device_key() -> Result<Option<String>, String> {
  let read = tokio::task::spawn_blocking(|| {
    match named_entry(ACCOUNT_DEVICE_KEY)?.get_password() {
      Ok(value) => Ok(Some(value)),
      Err(Error::NoEntry) => Ok(None),
      Err(_) => Err("Desktop device Keychain read failed".into()),
    }
  });
  tokio::time::timeout(std::time::Duration::from_secs(5), read)
    .await
    .map_err(|_| "Desktop device Keychain read timed out")?
    .map_err(|_| "Desktop device Keychain task failed")?
}

pub(crate) async fn store_account_device_key(
  value: zeroize::Zeroizing<String>,
) -> Result<(), String> {
  tokio::task::spawn_blocking(move || {
    named_entry(ACCOUNT_DEVICE_KEY)?
      .set_password(&value)
      .map_err(|_| "Could not save desktop device key in Keychain".into())
  })
  .await
  .map_err(|_| "Desktop device Keychain task failed")?
}

pub(crate) async fn delete_account_device_key() -> Result<(), String> {
  tokio::task::spawn_blocking(|| delete_named_credential(ACCOUNT_DEVICE_KEY))
    .await
    .map_err(|_| "Desktop device Keychain task failed")?
}
