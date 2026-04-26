//! OS keychain storage for desktop edit session tokens.
//!
//! Each session token is stored as a separate keychain entry keyed by
//! `stella-desktop:session:<sessionId>`. This keeps tokens out of the
//! JSON session store on disk.

const SERVICE_NAME: &str = "stella-desktop";

fn entry_key(session_id: &str) -> String {
  format!("session:{session_id}")
}

fn entry(session_id: &str) -> Result<keyring::Entry, String> {
  keyring::Entry::new(SERVICE_NAME, &entry_key(session_id))
    .map_err(|e| format!("keychain entry error: {e}"))
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
      Err(keyring::Error::NoEntry) => None,
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

/// Delete a session token from the OS keychain.
/// Silently succeeds if the entry does not exist.
pub fn delete_token(session_id: &str) {
  if let Ok(e) = entry(session_id) {
    match e.delete_credential() {
      Ok(()) => {}
      Err(keyring::Error::NoEntry) => {}
      Err(e) => {
        tracing::warn!(session_id, error = %e, "keychain delete failed");
      }
    }
  }
}
