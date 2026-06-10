//! OS keychain storage for desktop edit session tokens.
//!
//! Each session token is stored as a separate keychain entry keyed by
//! `stella-desktop:session:<sessionId>`. This keeps tokens out of the
//! JSON session store on disk.

use std::{
  collections::HashMap,
  sync::{Mutex, OnceLock},
};

use keyring_core::{Entry, Error};

const SERVICE_NAME: &str = "stella-desktop";
static KEYRING_INIT: OnceLock<()> = OnceLock::new();
static KEYRING_INIT_LOCK: Mutex<()> = Mutex::new(());

fn entry_key(session_id: &str) -> String {
  format!("session:{session_id}")
}

fn entry(session_id: &str) -> Result<Entry, String> {
  ensure_default_store()?;
  Entry::new(SERVICE_NAME, &entry_key(session_id))
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

/// Retrieve a session token from the OS keychain.
/// Returns `None` if the entry does not exist.
pub fn get_token(session_id: &str) -> Option<String> {
  match entry(session_id) {
    Ok(e) => match e.get_password() {
      Ok(token) => Some(token),
      Err(Error::NoEntry) => None,
      Err(e) => {
        tracing::warn!(session_id, error = %e, "keychain read failed, falling back");
        None
      }
    },
    Err(e) => {
      tracing::warn!(session_id, error = %e, "keychain entry creation failed");
      None
    }
  }
}

/// Retrieve a session token without letting a blocked keychain call wedge the
/// caller. Platform keychain reads can stall on user authorization (e.g. when
/// the binary changed and the OS re-prompts); the read runs on a blocking
/// thread and is abandoned after `timeout` so callers holding the session
/// manager lock stay responsive.
pub async fn get_token_with_timeout(
  session_id: &str,
  timeout: std::time::Duration,
) -> Option<String> {
  let id = session_id.to_string();
  let read = tokio::task::spawn_blocking(move || get_token(&id));
  match tokio::time::timeout(timeout, read).await {
    Ok(Ok(token)) => token,
    Ok(Err(e)) => {
      tracing::warn!(session_id, error = %e, "keychain read task failed");
      None
    }
    Err(_) => {
      tracing::warn!(session_id, "keychain read timed out");
      None
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
