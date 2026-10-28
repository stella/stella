//! Where the ChatGPT connection is kept.
//!
//! The host identifier lives in the OS credential store (macOS Keychain,
//! Windows Credential Manager, Secret Service on Linux) through
//! [`crate::keychain`]. The registration and the tokens are one record in an
//! AES-256-GCM file written atomically with owner-only permissions through
//! [`crate::local_store::EncryptedJsonFile`]; its key is in the credential
//! store too, because a token set is larger than a Windows credential holds.
//! Nothing here is logged, and no record field leaves this computer.

use std::{fmt, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};

use crate::local_store::EncryptedJsonFile;

/// The account registration an issued client ID belongs to. It outlives a
/// sign-out: a later sign-in to the same account reuses the client ID.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatGptRegistration {
  /// The issued `oaiapp_…` client ID; never `dynamic_agent_client`.
  pub client_id: String,
  /// The verified ID-token subject, once a sign-in completed.
  pub subject: Option<String>,
  pub email: Option<String>,
  /// The last sign-in did not grant ChatGPT plan usage, so the next one asks
  /// for consent again.
  pub plan_usage_granted: bool,
  /// The tokens stopped working; the user has to sign in again.
  pub reconnect_required: bool,
}

/// One signed-in token set.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatGptSession {
  pub client_id: String,
  pub issuer: String,
  pub subject: String,
  pub email: Option<String>,
  pub plan: Option<String>,
  /// Kept for `id_token_hint` on the next sign-in to this account.
  pub id_token: String,
  pub access_token: String,
  pub refresh_token: Option<String>,
  /// Unix milliseconds.
  pub expires_at: i64,
  /// Unix milliseconds; renewal before this time is refused.
  pub earliest_refresh_at: Option<i64>,
  pub scopes: Vec<String>,
  /// Unix milliseconds of the token response this set came from.
  pub saved_at: i64,
}

impl ChatGptSession {
  pub(crate) fn grants(&self, scope: &str) -> bool {
    self.scopes.iter().any(|granted| granted == scope)
  }
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatGptRecord {
  pub registration: Option<ChatGptRegistration>,
  pub session: Option<ChatGptSession>,
}

// Tokens and identities never reach a log through `{:?}`.
impl fmt::Debug for ChatGptRecord {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("ChatGptRecord")
      .field("registered", &self.registration.is_some())
      .field("signed_in", &self.session.is_some())
      .finish()
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct VaultUnavailable;

/// Storage for the host identifier and the connection record. Calls block on
/// the credential store, so the service runs them on a blocking thread.
pub(crate) trait ChatGptVault: Send + Sync + 'static {
  /// This installation's `ext_agent_host_id`, generated on first use.
  fn host_id(&self) -> Result<String, VaultUnavailable>;
  fn load(&self) -> Result<ChatGptRecord, VaultUnavailable>;
  /// Replaces the whole record, so tokens, expiry and scopes change together.
  fn save(&self, record: &ChatGptRecord) -> Result<(), VaultUnavailable>;
}

pub(crate) fn new_host_id() -> String {
  format!("urn:uuid:{}", uuid::Uuid::new_v4().hyphenated())
}

/// The secrets the credential store holds for [`FileVault`].
pub(crate) trait VaultSecrets: Send + Sync + 'static {
  fn host_id(&self) -> Result<Option<String>, String>;
  fn store_host_id(&self, value: &str) -> Result<(), String>;
  fn file_key(&self) -> Result<Option<[u8; 32]>, String>;
  fn create_file_key(&self) -> Result<[u8; 32], String>;
}

/// The credential store this build runs with.
pub(crate) struct KeychainSecrets;

impl VaultSecrets for KeychainSecrets {
  fn host_id(&self) -> Result<Option<String>, String> {
    crate::keychain::chatgpt_host_id()
  }
  fn store_host_id(&self, value: &str) -> Result<(), String> {
    crate::keychain::store_chatgpt_host_id(value)
  }
  fn file_key(&self) -> Result<Option<[u8; 32]>, String> {
    crate::keychain::chatgpt_connection_key()
  }
  fn create_file_key(&self) -> Result<[u8; 32], String> {
    crate::keychain::create_chatgpt_connection_key()
  }
}

const FILE_LABEL: &str = "ChatGPT connection";
const FILE_PURPOSE: &[u8] = b"stella:chatgpt-connection:v1";

/// The production vault: secrets in the credential store, the record in an
/// encrypted file.
pub(crate) struct FileVault<S> {
  path: PathBuf,
  secrets: S,
  /// Serializes host-ID creation within this process.
  host: Mutex<()>,
}

impl<S: VaultSecrets> FileVault<S> {
  pub(crate) fn new(path: PathBuf, secrets: S) -> Self {
    Self {
      path,
      secrets,
      host: Mutex::new(()),
    }
  }

  fn file(&self, key: [u8; 32]) -> EncryptedJsonFile {
    EncryptedJsonFile::new(key, self.path.clone(), FILE_LABEL)
      .with_associated_data(FILE_PURPOSE)
  }

  fn remove_file(&self) -> Result<(), VaultUnavailable> {
    match std::fs::remove_file(&self.path) {
      Ok(()) => Ok(()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(error) => {
        tracing::warn!(kind = ?error.kind(), "ChatGPT connection file was not removed");
        Err(VaultUnavailable)
      }
    }
  }
}

impl<S: VaultSecrets> ChatGptVault for FileVault<S> {
  fn host_id(&self) -> Result<String, VaultUnavailable> {
    let _guard = self.host.lock().map_err(|_poisoned| VaultUnavailable)?;
    if let Some(existing) = self.secrets.host_id().map_err(unavailable)? {
      return Ok(existing);
    }
    let created = new_host_id();
    self.secrets.store_host_id(&created).map_err(unavailable)?;
    Ok(created)
  }

  fn load(&self) -> Result<ChatGptRecord, VaultUnavailable> {
    let Some(key) = self.secrets.file_key().map_err(unavailable)? else {
      // Without its key the file cannot be read again; signing in again
      // writes a new one.
      return Ok(ChatGptRecord::default());
    };
    match self.file(key).load::<ChatGptRecord>() {
      Ok(record) => Ok(record.unwrap_or_default()),
      Err(error) => {
        tracing::warn!(error = %error, "ChatGPT connection file is unreadable");
        Ok(ChatGptRecord::default())
      }
    }
  }

  fn save(&self, record: &ChatGptRecord) -> Result<(), VaultUnavailable> {
    if *record == ChatGptRecord::default() {
      return self.remove_file();
    }
    let key = match self.secrets.file_key().map_err(unavailable)? {
      Some(key) => key,
      None => self.secrets.create_file_key().map_err(unavailable)?,
    };
    self.file(key).persist(record).map_err(unavailable)
  }
}

fn unavailable(error: String) -> VaultUnavailable {
  tracing::warn!(error = %error, "ChatGPT connection storage is unavailable");
  VaultUnavailable
}

/// An in-memory vault for tests.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryVault {
  pub host: Mutex<Option<String>>,
  pub record: Mutex<ChatGptRecord>,
}

#[cfg(test)]
impl ChatGptVault for MemoryVault {
  fn host_id(&self) -> Result<String, VaultUnavailable> {
    let mut host = self.host.lock().unwrap();
    Ok(host.get_or_insert_with(new_host_id).clone())
  }
  fn load(&self) -> Result<ChatGptRecord, VaultUnavailable> {
    Ok(self.record.lock().unwrap().clone())
  }
  fn save(&self, record: &ChatGptRecord) -> Result<(), VaultUnavailable> {
    *self.record.lock().unwrap() = record.clone();
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[derive(Default)]
  struct FakeSecrets {
    host: Mutex<Option<String>>,
    key: Mutex<Option<[u8; 32]>>,
  }

  impl VaultSecrets for std::sync::Arc<FakeSecrets> {
    fn host_id(&self) -> Result<Option<String>, String> {
      Ok(self.host.lock().unwrap().clone())
    }
    fn store_host_id(&self, value: &str) -> Result<(), String> {
      *self.host.lock().unwrap() = Some(value.to_owned());
      Ok(())
    }
    fn file_key(&self) -> Result<Option<[u8; 32]>, String> {
      Ok(*self.key.lock().unwrap())
    }
    fn create_file_key(&self) -> Result<[u8; 32], String> {
      let key = [7; 32];
      *self.key.lock().unwrap() = Some(key);
      Ok(key)
    }
  }

  fn session(access_token: &str, refresh_token: &str) -> ChatGptSession {
    ChatGptSession {
      client_id: "oaiapp_fixture".into(),
      issuer: "https://issuer.invalid".into(),
      subject: "subject-1".into(),
      email: Some("person@example.com".into()),
      plan: None,
      id_token: "id-token-fixture".into(),
      access_token: access_token.into(),
      refresh_token: Some(refresh_token.into()),
      expires_at: 1,
      earliest_refresh_at: None,
      scopes: vec!["chatgpt.tokens.use.direct".into()],
      saved_at: 0,
    }
  }

  fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir()
      .join(format!("stella-chatgpt-vault-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn the_host_id_is_a_uuid_urn_generated_once() {
    let secrets = std::sync::Arc::new(FakeSecrets::default());
    let dir = temp_dir();
    let vault =
      FileVault::new(dir.join("chatgpt.json"), std::sync::Arc::clone(&secrets));
    let first = vault.host_id().unwrap();
    let uuid = first.strip_prefix("urn:uuid:").unwrap();
    assert_eq!(uuid::Uuid::parse_str(uuid).unwrap().get_version_num(), 4);
    assert_eq!(vault.host_id().unwrap(), first);
    // A new vault over the same credential store reads the same host.
    let reopened = FileVault::new(dir.join("chatgpt.json"), secrets);
    assert_eq!(reopened.host_id().unwrap(), first);
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn the_record_is_encrypted_private_and_removed_when_empty() {
    let secrets = std::sync::Arc::new(FakeSecrets::default());
    let dir = temp_dir();
    let path = dir.join("chatgpt.json");
    let vault = FileVault::new(path.clone(), std::sync::Arc::clone(&secrets));
    assert_eq!(vault.load().unwrap(), ChatGptRecord::default());

    let record = ChatGptRecord {
      registration: None,
      session: Some(session("access-secret", "refresh-secret")),
    };
    vault.save(&record).unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    for secret in ["access-secret", "refresh-secret", "person@example.com"] {
      assert!(!raw.contains(secret));
    }
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let mode = std::fs::metadata(&path).unwrap().permissions().mode();
      assert_eq!(mode & 0o777, 0o600);
    }
    assert_eq!(
      FileVault::new(path.clone(), std::sync::Arc::clone(&secrets))
        .load()
        .unwrap(),
      record
    );

    vault.save(&ChatGptRecord::default()).unwrap();
    assert!(!path.exists());
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn debug_output_names_no_token_or_identity() {
    let record = ChatGptRecord {
      registration: Some(ChatGptRegistration {
        client_id: "oaiapp_fixture".into(),
        subject: Some("subject-1".into()),
        email: Some("person@example.com".into()),
        plan_usage_granted: true,
        reconnect_required: false,
      }),
      session: Some(session("access-secret", "refresh-secret")),
    };
    let debug = format!("{record:?}");
    for secret in [
      "access-secret",
      "refresh-secret",
      "id-token-fixture",
      "person@example.com",
      "subject-1",
      "oaiapp_fixture",
    ] {
      assert!(!debug.contains(secret), "{debug}");
    }
  }
}
