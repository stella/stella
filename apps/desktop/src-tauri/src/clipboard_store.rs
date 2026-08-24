use aes_gcm::{
  Aes256Gcm, Nonce,
  aead::{Aead, KeyInit, OsRng, rand_core::RngCore},
};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

use crate::clipboard::PersistedClipboardState;

const STORE_VERSION: u8 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedClipboardEnvelope {
  ciphertext: String,
  nonce: String,
  version: u8,
}

pub struct ClipboardStore {
  key: [u8; 32],
  path: PathBuf,
}

impl ClipboardStore {
  pub fn new(key: [u8; 32], path: PathBuf) -> Self {
    Self { key, path }
  }

  pub fn load(&self) -> Result<Option<PersistedClipboardState>, String> {
    let raw = match fs::read_to_string(&self.path) {
      Ok(raw) => raw,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
      Err(error) => return Err(format!("clipboard store read failed: {error}")),
    };
    let envelope: EncryptedClipboardEnvelope = serde_json::from_str(&raw)
      .map_err(|error| format!("clipboard envelope is invalid: {error}"))?;
    if envelope.version != STORE_VERSION {
      return Err("clipboard store version is unsupported".to_string());
    }

    let nonce = hex::decode(envelope.nonce)
      .map_err(|error| format!("clipboard nonce is invalid: {error}"))?;
    if nonce.len() != 12 {
      return Err("clipboard nonce has an invalid length".to_string());
    }
    let ciphertext = hex::decode(envelope.ciphertext)
      .map_err(|error| format!("clipboard ciphertext is invalid: {error}"))?;
    let cipher = Aes256Gcm::new_from_slice(&self.key)
      .map_err(|_| "clipboard encryption key is invalid".to_string())?;
    let plaintext = cipher
      .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
      .map_err(|_| "clipboard history could not be decrypted".to_string())?;
    serde_json::from_slice(&plaintext)
      .map(Some)
      .map_err(|error| format!("clipboard history is invalid: {error}"))
  }

  pub fn persist(&self, state: &PersistedClipboardState) -> Result<(), String> {
    if let Some(parent) = self.path.parent() {
      fs::create_dir_all(parent)
        .map_err(|error| format!("clipboard store directory failed: {error}"))?;
    }

    let plaintext = serde_json::to_vec(state)
      .map_err(|error| format!("clipboard serialization failed: {error}"))?;
    let cipher = Aes256Gcm::new_from_slice(&self.key)
      .map_err(|_| "clipboard encryption key is invalid".to_string())?;
    let mut nonce = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
      .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
      .map_err(|_| "clipboard encryption failed".to_string())?;
    let envelope = EncryptedClipboardEnvelope {
      ciphertext: hex::encode(ciphertext),
      nonce: hex::encode(nonce),
      version: STORE_VERSION,
    };
    let json = serde_json::to_vec(&envelope)
      .map_err(|error| format!("clipboard envelope serialization failed: {error}"))?;
    let temp_path = self.path.with_extension(format!(
      "{}.{}.tmp",
      std::process::id(),
      uuid::Uuid::new_v4()
    ));
    fs::write(&temp_path, json)
      .map_err(|error| format!("clipboard store write failed: {error}"))?;

    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600));
    }

    if let Err(error) = fs::rename(&temp_path, &self.path) {
      let _ = fs::remove_file(&temp_path);
      return Err(format!("clipboard store replace failed: {error}"));
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::clipboard::{ClipboardCaptureStatus, ClipboardItem};
  use chrono::Utc;

  fn unique_path() -> PathBuf {
    std::env::temp_dir().join(format!(
      "stella-clipboard-store-{}.json",
      uuid::Uuid::new_v4()
    ))
  }

  #[test]
  fn encrypted_store_round_trips_without_plaintext_on_disk() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    let state = PersistedClipboardState {
      capture_status: ClipboardCaptureStatus::Active,
      groups: Vec::new(),
      items: vec![ClipboardItem::Text {
        copied_at: Utc::now(),
        group_id: None,
        id: "item-1".to_string(),
        plain_text: "privileged draft text".to_string(),
        source_app: None,
      }],
    };

    store.persist(&state).unwrap();
    let raw = fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("privileged draft text"));
    let loaded = store.load().unwrap().unwrap();
    assert_eq!(loaded.items, state.items);

    fs::remove_file(path).unwrap();
  }

  #[test]
  fn wrong_key_cannot_decrypt_history() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    store
      .persist(&PersistedClipboardState {
        capture_status: ClipboardCaptureStatus::Active,
        groups: Vec::new(),
        items: Vec::new(),
      })
      .unwrap();

    let wrong_store = ClipboardStore::new([8; 32], path.clone());
    assert!(wrong_store.load().is_err());

    fs::remove_file(path).unwrap();
  }
}
