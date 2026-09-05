use aes_gcm::{
  Aes256Gcm, Nonce,
  aead::{Aead, Generate, KeyInit},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
  collections::{BTreeSet, HashSet},
  fmt, fs,
  path::{Path, PathBuf},
};

use crate::clipboard::PersistedClipboardState;

const STORE_VERSION: u8 = 1;
const IMAGE_BLOB_VERSION: u8 = 1;
const IMAGE_BLOB_NONCE_BYTES: usize = 12;
const IMAGE_BLOB_HEADER_BYTES: usize = 1 + IMAGE_BLOB_NONCE_BYTES;
const IMAGE_BLOB_SUFFIX: &str = ".image.enc";
const IMAGE_PREVIEW_SUFFIX: &str = ".preview.enc";

#[derive(Clone, Copy)]
pub struct ClipboardImagePayload<'a> {
  pub image: &'a [u8],
  pub preview: &'a [u8],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardImagePersistStatus {
  Created,
  Existing,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct ClipboardImageValidation {
  pub byte_size: usize,
  pub checksum: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ClipboardImageValidationError {
  Invalid(String),
  Unavailable(String),
}

impl fmt::Display for ClipboardImageValidationError {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Invalid(message) | Self::Unavailable(message) => {
        formatter.write_str(message)
      }
    }
  }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedClipboardEnvelope {
  ciphertext: String,
  nonce: String,
  version: u8,
}

#[derive(Clone)]
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
    let nonce = Nonce::try_from(nonce.as_slice())
      .map_err(|_| "clipboard nonce has an invalid length".to_string())?;
    let ciphertext = hex::decode(envelope.ciphertext)
      .map_err(|error| format!("clipboard ciphertext is invalid: {error}"))?;
    let cipher = Aes256Gcm::new_from_slice(&self.key)
      .map_err(|_| "clipboard encryption key is invalid".to_string())?;
    let plaintext = cipher
      .decrypt(&nonce, ciphertext.as_ref())
      .map_err(|_| "clipboard history could not be decrypted".to_string())?;
    serde_json::from_slice(&plaintext)
      .map(Some)
      .map_err(|error| format!("clipboard history is invalid: {error}"))
  }

  fn image_directory(&self) -> PathBuf {
    self.path.with_extension("images")
  }

  fn image_path(&self, blob_id: &str, suffix: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(blob_id)
      .map_err(|_| "clipboard image identifier is invalid".to_string())?;
    Ok(self.image_directory().join(format!("{blob_id}{suffix}")))
  }

  fn encrypt_blob(
    &self,
    plaintext: &[u8],
    associated_data: &[u8],
  ) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(&self.key)
      .map_err(|_| "clipboard encryption key is invalid".to_string())?;
    let nonce = Nonce::generate();
    let ciphertext = cipher
      .encrypt(
        &nonce,
        aes_gcm::aead::Payload {
          msg: plaintext,
          aad: associated_data,
        },
      )
      .map_err(|_| "clipboard image encryption failed".to_string())?;
    let mut blob = Vec::with_capacity(IMAGE_BLOB_HEADER_BYTES + ciphertext.len());
    blob.push(IMAGE_BLOB_VERSION);
    blob.extend_from_slice(nonce.as_slice());
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
  }

  fn decrypt_blob(
    &self,
    blob: &[u8],
    associated_data: &[u8],
  ) -> Result<Vec<u8>, String> {
    if blob.len() <= IMAGE_BLOB_HEADER_BYTES || blob[0] != IMAGE_BLOB_VERSION {
      return Err("clipboard image blob is invalid".to_string());
    }
    let nonce = Nonce::try_from(&blob[1..IMAGE_BLOB_HEADER_BYTES])
      .map_err(|_| "clipboard image nonce is invalid".to_string())?;
    let cipher = Aes256Gcm::new_from_slice(&self.key)
      .map_err(|_| "clipboard encryption key is invalid".to_string())?;
    cipher
      .decrypt(
        &nonce,
        aes_gcm::aead::Payload {
          msg: &blob[IMAGE_BLOB_HEADER_BYTES..],
          aad: associated_data,
        },
      )
      .map_err(|_| "clipboard image could not be decrypted".to_string())
  }

  fn write_encrypted_blob(
    &self,
    path: &Path,
    plaintext: &[u8],
    associated_data: &[u8],
  ) -> Result<(), String> {
    let encrypted = self.encrypt_blob(plaintext, associated_data)?;
    let temp_path = path.with_extension(format!(
      "{}.{}.tmp",
      std::process::id(),
      uuid::Uuid::new_v4()
    ));
    if let Err(error) = fs::write(&temp_path, encrypted) {
      let cleanup_error = match fs::remove_file(&temp_path) {
        Ok(()) => None,
        Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {
          None
        }
        Err(cleanup_error) => Some(cleanup_error),
      };
      return match cleanup_error {
        Some(cleanup_error) => Err(format!(
          "clipboard image write failed: {error}; temporary image cleanup failed: {cleanup_error}"
        )),
        None => Err(format!("clipboard image write failed: {error}")),
      };
    }
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600));
    }
    if let Err(error) = fs::rename(&temp_path, path) {
      let _ = fs::remove_file(&temp_path);
      return Err(format!("clipboard image replace failed: {error}"));
    }
    Ok(())
  }

  pub fn persist_image(
    &self,
    blob_id: &str,
    payload: ClipboardImagePayload<'_>,
  ) -> Result<ClipboardImagePersistStatus, String> {
    let directory = self.image_directory();
    fs::create_dir_all(&directory)
      .map_err(|error| format!("clipboard image directory failed: {error}"))?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
    }
    let image_path = self.image_path(blob_id, IMAGE_BLOB_SUFFIX)?;
    let preview_path = self.image_path(blob_id, IMAGE_PREVIEW_SUFFIX)?;
    match (image_path.is_file(), preview_path.is_file()) {
      (true, true) => {
        let existing_payload_matches = self
          .load_image_blob(blob_id, IMAGE_BLOB_SUFFIX, "image", payload.image.len())
          .is_ok_and(|image| image.as_slice() == payload.image)
          && self
            .load_image_blob(
              blob_id,
              IMAGE_PREVIEW_SUFFIX,
              "preview",
              payload.preview.len(),
            )
            .is_ok_and(|preview| preview.as_slice() == payload.preview);
        if existing_payload_matches {
          return Ok(ClipboardImagePersistStatus::Existing);
        }
        return Err(
          "clipboard image identifier conflicts with existing data".to_string(),
        );
      }
      (false, false) => {}
      (true, false) | (false, true) => {
        return Err("clipboard image payload is incomplete".to_string());
      }
    }
    self.write_encrypted_blob(
      &image_path,
      payload.image,
      format!("{blob_id}:image").as_bytes(),
    )?;
    if let Err(error) = self.write_encrypted_blob(
      &preview_path,
      payload.preview,
      format!("{blob_id}:preview").as_bytes(),
    ) {
      return match self.remove_image(blob_id) {
        Ok(()) => Err(error),
        Err(cleanup_error) => Err(format!("{error}; {cleanup_error}")),
      };
    }
    Ok(ClipboardImagePersistStatus::Created)
  }

  fn load_image_blob(
    &self,
    blob_id: &str,
    suffix: &str,
    kind: &str,
    max_plaintext_bytes: usize,
  ) -> Result<Vec<u8>, String> {
    self
      .load_image_blob_for_validation(blob_id, suffix, kind, max_plaintext_bytes)
      .map_err(|error| error.to_string())
  }

  fn load_image_blob_for_validation(
    &self,
    blob_id: &str,
    suffix: &str,
    kind: &str,
    max_plaintext_bytes: usize,
  ) -> Result<Vec<u8>, ClipboardImageValidationError> {
    let path = self
      .image_path(blob_id, suffix)
      .map_err(ClipboardImageValidationError::Invalid)?;
    let max_encrypted_bytes = max_plaintext_bytes
      .checked_add(IMAGE_BLOB_HEADER_BYTES + 16)
      .ok_or_else(|| {
        ClipboardImageValidationError::Invalid(
          "clipboard image size limit is invalid".to_string(),
        )
      })?;
    let metadata = fs::metadata(&path).map_err(|error| {
      let message = format!("clipboard image metadata read failed: {error}");
      if error.kind() == std::io::ErrorKind::NotFound {
        ClipboardImageValidationError::Invalid(message)
      } else {
        ClipboardImageValidationError::Unavailable(message)
      }
    })?;
    if !metadata.is_file() {
      return Err(ClipboardImageValidationError::Unavailable(
        "clipboard image blob is not a readable file".to_string(),
      ));
    }
    if metadata.len() > max_encrypted_bytes as u64 {
      return Err(ClipboardImageValidationError::Invalid(
        "clipboard image blob is too large".to_string(),
      ));
    }
    let blob = fs::read(path).map_err(|error| {
      let message = format!("clipboard image read failed: {error}");
      if error.kind() == std::io::ErrorKind::NotFound {
        ClipboardImageValidationError::Invalid(message)
      } else {
        ClipboardImageValidationError::Unavailable(message)
      }
    })?;
    let plaintext = self
      .decrypt_blob(&blob, format!("{blob_id}:{kind}").as_bytes())
      .map_err(ClipboardImageValidationError::Invalid)?;
    if plaintext.len() > max_plaintext_bytes {
      return Err(ClipboardImageValidationError::Invalid(
        "clipboard image blob is too large".to_string(),
      ));
    }
    Ok(plaintext)
  }

  pub fn load_image(&self, blob_id: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    self.load_image_blob(blob_id, IMAGE_BLOB_SUFFIX, "image", max_bytes)
  }

  pub fn load_image_preview(
    &self,
    blob_id: &str,
    max_bytes: usize,
  ) -> Result<Vec<u8>, String> {
    self.load_image_blob(blob_id, IMAGE_PREVIEW_SUFFIX, "preview", max_bytes)
  }

  pub fn remove_image(&self, blob_id: &str) -> Result<(), String> {
    for suffix in [IMAGE_BLOB_SUFFIX, IMAGE_PREVIEW_SUFFIX] {
      let path = self.image_path(blob_id, suffix)?;
      match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("clipboard image rollback failed: {error}")),
      }
    }
    let directory = self.image_directory();
    let entries = match fs::read_dir(&directory) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
      Err(error) => {
        return Err(format!("clipboard image directory read failed: {error}"));
      }
    };
    let temporary_prefixes =
      [format!("{blob_id}.image."), format!("{blob_id}.preview.")];
    for entry in entries {
      let entry =
        entry.map_err(|error| format!("clipboard image entry read failed: {error}"))?;
      let name = entry.file_name();
      let name = name.to_string_lossy();
      if name.ends_with(".tmp")
        && temporary_prefixes
          .iter()
          .any(|prefix| name.starts_with(prefix))
      {
        fs::remove_file(entry.path())
          .map_err(|error| format!("clipboard image rollback failed: {error}"))?;
      }
    }
    Ok(())
  }

  pub fn discover_orphaned_image_blob_ids(
    &self,
    live_blob_ids: &HashSet<String>,
  ) -> Result<BTreeSet<String>, String> {
    let directory = self.image_directory();
    let entries = match fs::read_dir(&directory) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        return Ok(BTreeSet::new());
      }
      Err(error) => {
        return Err(format!("clipboard image directory read failed: {error}"));
      }
    };
    let mut orphaned_blob_ids = BTreeSet::new();
    for entry in entries {
      let entry =
        entry.map_err(|error| format!("clipboard image entry read failed: {error}"))?;
      let name = entry.file_name();
      let name = name.to_string_lossy();
      let blob_id = name
        .strip_suffix(IMAGE_BLOB_SUFFIX)
        .or_else(|| name.strip_suffix(IMAGE_PREVIEW_SUFFIX))
        .or_else(|| {
          if !name.ends_with(".tmp") {
            return None;
          }
          name
            .split_once(".image.")
            .or_else(|| name.split_once(".preview."))
            .map(|(blob_id, _)| blob_id)
        });
      let Some(blob_id) = blob_id else {
        continue;
      };
      if uuid::Uuid::parse_str(blob_id).is_ok() && !live_blob_ids.contains(blob_id) {
        orphaned_blob_ids.insert(blob_id.to_string());
      }
    }
    Ok(orphaned_blob_ids)
  }

  pub(crate) fn validate_image(
    &self,
    blob_id: &str,
    validation: &ClipboardImageValidation,
    max_preview_bytes: usize,
  ) -> Result<(), ClipboardImageValidationError> {
    let image = self.load_image_blob_for_validation(
      blob_id,
      IMAGE_BLOB_SUFFIX,
      "image",
      validation.byte_size,
    )?;
    if image.len() != validation.byte_size
      || hex::encode(Sha256::digest(&image)) != validation.checksum
    {
      return Err(ClipboardImageValidationError::Invalid(
        "clipboard image blob does not match its metadata".to_string(),
      ));
    }
    let preview = self.load_image_blob_for_validation(
      blob_id,
      IMAGE_PREVIEW_SUFFIX,
      "preview",
      max_preview_bytes,
    )?;
    if preview.is_empty() {
      return Err(ClipboardImageValidationError::Invalid(
        "clipboard image preview is empty".to_string(),
      ));
    }
    Ok(())
  }

  pub fn remove(path: &Path) -> Result<(), String> {
    let image_directory = path.with_extension("images");
    match fs::remove_dir_all(image_directory) {
      Ok(()) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => {
        return Err(format!("clipboard image store removal failed: {error}"));
      }
    }
    match fs::remove_file(path) {
      Ok(()) => Ok(()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(error) => Err(format!("clipboard store removal failed: {error}")),
    }
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
    let nonce = Nonce::generate();
    let ciphertext = cipher
      .encrypt(&nonce, plaintext.as_ref())
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
  use crate::clipboard::{
    ClipboardCaptureStatus, ClipboardItem, ClipboardItemRetentionClass,
    ClipboardRetention,
  };
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
        grouped_at: None,
        id: "item-1".to_string(),
        name: Some("Privileged draft".to_string()),
        plain_text: "privileged draft text".to_string(),
        retention_class: ClipboardItemRetentionClass::Kept,
        source_app: None,
      }],
      pending_image_blob_ids: Default::default(),
      retention: ClipboardRetention::Month,
      source_app_visuals: Vec::new(),
    };

    store.persist(&state).unwrap();
    let raw = fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("privileged draft text"));
    let loaded = store.load().unwrap().unwrap();
    assert_eq!(loaded.items, state.items);

    fs::remove_file(path).unwrap();
  }

  #[test]
  fn legacy_state_without_an_image_cleanup_journal_defaults_empty() {
    let state = serde_json::from_value::<PersistedClipboardState>(serde_json::json!({
      "captureStatus": "active",
      "groups": [],
      "items": [],
      "retention": "month",
      "sourceAppVisuals": []
    }))
    .unwrap();

    assert!(state.pending_image_blob_ids.is_empty());
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
        pending_image_blob_ids: Default::default(),
        retention: ClipboardRetention::Month,
        source_app_visuals: Vec::new(),
      })
      .unwrap();

    let wrong_store = ClipboardStore::new([8; 32], path.clone());
    assert!(wrong_store.load().is_err());

    fs::remove_file(path).unwrap();
  }

  #[test]
  fn encrypted_image_blobs_round_trip_without_plaintext_on_disk() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    let blob_id = uuid::Uuid::new_v4().to_string();
    let image = b"private full image";
    let preview = b"private preview";

    assert_eq!(
      store
        .persist_image(&blob_id, ClipboardImagePayload { image, preview })
        .unwrap(),
      ClipboardImagePersistStatus::Created
    );
    let raw_image =
      fs::read(store.image_path(&blob_id, IMAGE_BLOB_SUFFIX).unwrap()).unwrap();
    let raw_preview =
      fs::read(store.image_path(&blob_id, IMAGE_PREVIEW_SUFFIX).unwrap()).unwrap();
    assert!(
      !raw_image
        .windows(image.len())
        .any(|window| window == &image[..])
    );
    assert!(
      !raw_preview
        .windows(preview.len())
        .any(|window| window == &preview[..])
    );
    assert_eq!(
      store.load_image(&blob_id, image.len()).unwrap(),
      image.to_vec()
    );
    assert_eq!(
      store.load_image_preview(&blob_id, preview.len()).unwrap(),
      preview.to_vec()
    );
    assert_eq!(
      store
        .persist_image(&blob_id, ClipboardImagePayload { image, preview })
        .unwrap(),
      ClipboardImagePersistStatus::Existing
    );
    assert!(
      store
        .persist_image(
          &blob_id,
          ClipboardImagePayload {
            image: b"different image",
            preview: b"different preview",
          },
        )
        .is_err()
    );
    assert_eq!(store.load_image(&blob_id, image.len()).unwrap(), image);
    assert_eq!(
      store.load_image_preview(&blob_id, preview.len()).unwrap(),
      preview
    );

    fs::remove_file(store.image_path(&blob_id, IMAGE_PREVIEW_SUFFIX).unwrap()).unwrap();
    assert!(
      store
        .persist_image(&blob_id, ClipboardImagePayload { image, preview })
        .is_err()
    );
    assert_eq!(store.load_image(&blob_id, image.len()).unwrap(), image);

    let wrong_store = ClipboardStore::new([8; 32], path.clone());
    assert!(wrong_store.load_image(&blob_id, image.len()).is_err());
    ClipboardStore::remove(&path).unwrap();
  }

  #[test]
  fn image_blob_ids_cannot_escape_the_store_directory() {
    let store = ClipboardStore::new([7; 32], unique_path());

    assert!(
      store
        .persist_image(
          "../outside",
          ClipboardImagePayload {
            image: b"image",
            preview: b"preview",
          },
        )
        .is_err()
    );
  }

  #[test]
  fn orphan_discovery_finds_only_unreferenced_blobs() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    let live_blob_id = uuid::Uuid::new_v4().to_string();
    let orphaned_blob_id = uuid::Uuid::new_v4().to_string();
    let payload = ClipboardImagePayload {
      image: b"image",
      preview: b"preview",
    };
    store.persist_image(&live_blob_id, payload).unwrap();
    store.persist_image(&orphaned_blob_id, payload).unwrap();

    assert_eq!(
      store
        .discover_orphaned_image_blob_ids(&HashSet::from([live_blob_id.clone()]))
        .unwrap(),
      BTreeSet::from([orphaned_blob_id.clone()])
    );

    assert!(
      store
        .image_path(&live_blob_id, IMAGE_BLOB_SUFFIX)
        .unwrap()
        .is_file()
    );
    assert!(
      store
        .image_path(&orphaned_blob_id, IMAGE_BLOB_SUFFIX)
        .unwrap()
        .exists()
    );
    assert!(
      store
        .image_path(&orphaned_blob_id, IMAGE_PREVIEW_SUFFIX)
        .unwrap()
        .exists()
    );
    ClipboardStore::remove(&path).unwrap();
  }

  #[test]
  fn orphan_discovery_finds_interrupted_write_files_by_blob_id() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    let image_directory = store.image_directory();
    fs::create_dir_all(&image_directory).unwrap();
    let blob_id = uuid::Uuid::new_v4().to_string();
    let temporary_path =
      image_directory.join(format!("{blob_id}.image.123.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary_path, b"encrypted temporary data").unwrap();

    assert_eq!(
      store
        .discover_orphaned_image_blob_ids(&HashSet::new())
        .unwrap(),
      BTreeSet::from([blob_id.clone()])
    );
    store.remove_image(&blob_id).unwrap();
    assert!(!temporary_path.exists());
    ClipboardStore::remove(&path).unwrap();
  }

  #[test]
  fn image_validation_authenticates_payloads_and_metadata() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    let blob_id = uuid::Uuid::new_v4().to_string();
    let image = b"private full image";
    store
      .persist_image(
        &blob_id,
        ClipboardImagePayload {
          image,
          preview: b"private preview",
        },
      )
      .unwrap();
    let valid = ClipboardImageValidation {
      byte_size: image.len(),
      checksum: hex::encode(Sha256::digest(image)),
    };

    assert!(store.validate_image(&blob_id, &valid, 1024).is_ok());
    let invalid = ClipboardImageValidation {
      byte_size: image.len(),
      checksum: "wrong-checksum".to_string(),
    };
    assert!(matches!(
      store.validate_image(&blob_id, &invalid, 1024),
      Err(ClipboardImageValidationError::Invalid(_))
    ));
    ClipboardStore::remove(&path).unwrap();
  }

  #[test]
  fn image_validation_preserves_payloads_when_storage_is_unavailable() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    let blob_id = uuid::Uuid::new_v4().to_string();
    let image = b"private full image";
    store
      .persist_image(
        &blob_id,
        ClipboardImagePayload {
          image,
          preview: b"private preview",
        },
      )
      .unwrap();
    let image_path = store.image_path(&blob_id, IMAGE_BLOB_SUFFIX).unwrap();
    fs::remove_file(&image_path).unwrap();
    fs::create_dir(&image_path).unwrap();
    let validation = ClipboardImageValidation {
      byte_size: image.len(),
      checksum: hex::encode(Sha256::digest(image)),
    };

    assert!(matches!(
      store.validate_image(&blob_id, &validation, 1024),
      Err(ClipboardImageValidationError::Unavailable(_))
    ));
    ClipboardStore::remove(&path).unwrap();
  }

  #[test]
  fn removing_a_store_is_idempotent() {
    let path = unique_path();
    fs::write(&path, b"encrypted history").unwrap();

    ClipboardStore::remove(&path).unwrap();
    ClipboardStore::remove(&path).unwrap();

    assert!(!path.exists());
  }

  #[test]
  fn partial_store_removal_keeps_metadata_for_a_later_retry() {
    let path = unique_path();
    fs::write(&path, b"encrypted history").unwrap();
    let image_directory = path.with_extension("images");
    fs::write(&image_directory, b"temporarily undeletable image storage").unwrap();

    assert!(ClipboardStore::remove(&path).is_err());
    assert!(path.is_file());

    fs::remove_file(&image_directory).unwrap();
    ClipboardStore::remove(&path).unwrap();
    assert!(!path.exists());
  }
}
