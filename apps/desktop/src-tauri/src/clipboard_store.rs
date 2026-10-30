use aes_gcm::{
  Aes256Gcm, Nonce,
  aead::{Aead, Generate, KeyInit},
};
use sha2::{Digest, Sha256};
use std::{
  collections::{BTreeMap, BTreeSet, HashSet},
  fmt, fs,
  path::{Path, PathBuf},
  sync::{Arc, Mutex},
};

use crate::clipboard::{ClipboardItem, PersistedClipboardState};
use crate::foreground_app_visual::ClipboardSourceAppVisual;
use crate::local_store::{EncryptedJsonFile, create_private_dir, write_private_atomic};
use serde::{Deserialize, Serialize};

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

// The manifest is a write-ahead transaction: after its atomic commit, replay
// installs changed records and deletes retired records before exposing history.
// It never contains unchanged items, including when count pruning evicts a clip.
#[derive(Default, Serialize, Deserialize)]
struct ClipboardRecordManifest {
  settings: Option<PersistedClipboardState>,
  updated_visuals: Vec<ClipboardSourceAppVisual>,
  removed_visuals: Vec<String>,
  updated: Vec<ClipboardItemRecord>,
  head: Option<ClipboardRecordHead>,
  removed: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct ClipboardItemRecord {
  item: ClipboardItem,
  next_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ClipboardRecordHead {
  item_id: Option<String>,
}

fn plan_record_transaction(
  state: &PersistedClipboardState,
  previous: Option<&PersistedClipboardState>,
) -> ClipboardRecordManifest {
  let previous_items: BTreeMap<_, _> = previous
    .into_iter()
    .flat_map(|state| &state.items)
    .map(|item| (item.id(), item))
    .collect();
  let previous_next: BTreeMap<_, _> = previous
    .into_iter()
    .flat_map(|state| {
      state.items.iter().enumerate().map(move |(index, item)| {
        (item.id(), state.items.get(index + 1).map(ClipboardItem::id))
      })
    })
    .collect();
  let current_ids: HashSet<_> = state.items.iter().map(ClipboardItem::id).collect();
  let mut settings = state.clone();
  settings.items.clear();
  settings.source_app_visuals.clear();
  let previous_settings = previous.map(|state| {
    let mut settings = state.clone();
    settings.items.clear();
    settings.source_app_visuals.clear();
    settings
  });
  let previous_visuals: BTreeMap<_, _> = previous
    .into_iter()
    .flat_map(|state| &state.source_app_visuals)
    .map(|visual| (visual.key.as_str(), visual))
    .collect();
  let visual_keys: HashSet<_> = state
    .source_app_visuals
    .iter()
    .map(|visual| visual.key.as_str())
    .collect();
  ClipboardRecordManifest {
    settings: (previous_settings.as_ref() != Some(&settings)).then_some(settings),
    updated_visuals: state
      .source_app_visuals
      .iter()
      .filter(|visual| {
        previous_visuals.get(visual.key.as_str()).copied() != Some(*visual)
      })
      .cloned()
      .collect(),
    removed_visuals: previous_visuals
      .keys()
      .filter(|key| !visual_keys.contains(**key))
      .map(|key| (*key).to_string())
      .collect(),
    head: Some(ClipboardRecordHead {
      item_id: state.items.first().map(|item| item.id().to_string()),
    }),
    updated: state
      .items
      .iter()
      .enumerate()
      .filter(|(index, item)| {
        previous_items.get(item.id()).copied() != Some(*item)
          || previous_next.get(item.id()).copied().flatten()
            != state.items.get(index + 1).map(ClipboardItem::id)
      })
      .map(|(index, item)| ClipboardItemRecord {
        item: item.clone(),
        next_id: state.items.get(index + 1).map(|item| item.id().to_string()),
      })
      .collect(),
    removed: previous_items
      .keys()
      .filter(|id| !current_ids.contains(**id))
      .map(|id| (*id).to_string())
      .collect(),
  }
}

#[derive(Clone)]
pub struct ClipboardStore {
  key: [u8; 32],
  path: PathBuf,
  checkpoint: Arc<Mutex<Option<PersistedClipboardState>>>,
  #[cfg(test)]
  written_bytes: Arc<std::sync::atomic::AtomicUsize>,
}

impl ClipboardStore {
  pub fn new(key: [u8; 32], path: PathBuf) -> Self {
    Self {
      key,
      path,
      checkpoint: Arc::new(Mutex::new(None)),
      #[cfg(test)]
      written_bytes: Arc::default(),
    }
  }

  fn history_file(&self) -> EncryptedJsonFile {
    EncryptedJsonFile::new(self.key, self.path.clone(), "clipboard")
  }

  pub fn load(&self) -> Result<Option<PersistedClipboardState>, String> {
    let Some(value) = self.history_file().load::<serde_json::Value>()? else {
      Self::remove_records(&self.path)?;
      *self
        .checkpoint
        .lock()
        .map_err(crate::logging::with_cause_logged(
          "clipboard checkpoint lock is poisoned",
        ))? = None;
      return Ok(None);
    };
    // Convert the encrypted snapshot once at startup. The replacement manifest
    // contains the entire transaction before any record is materialized, so a
    // crash after this atomic write resumes through ordinary journal recovery.
    let manifest = if value.get("items").is_some() {
      let state = serde_json::from_value::<PersistedClipboardState>(value)
        .map_err(|error| format!("clipboard snapshot migration failed: {error}"))?;
      let manifest = plan_record_transaction(&state, None);
      self.write_record(&self.history_file(), &manifest)?;
      manifest
    } else {
      serde_json::from_value::<ClipboardRecordManifest>(value)
        .map_err(|error| format!("clipboard record manifest is invalid: {error}"))?
    };
    self.apply_pending(&manifest)?;
    let mut state = self
      .settings_file()
      .load::<PersistedClipboardState>()?
      .ok_or_else(|| "clipboard settings record is missing".to_string())?;
    if self.visual_directory().exists() {
      for entry in fs::read_dir(self.visual_directory())
        .map_err(|error| format!("clipboard visuals read failed: {error}"))?
      {
        let path = entry
          .map_err(|error| format!("clipboard visual read failed: {error}"))?
          .path();
        if path.extension().and_then(|value| value.to_str()) != Some("enc") {
          continue;
        }
        let visual = self
          .visual_file_at(path.clone())
          .load::<ClipboardSourceAppVisual>()?
          .ok_or_else(|| "clipboard visual disappeared during load".to_string())?;
        if self.visual_path(&visual.key) != path {
          return Err("clipboard visual identity does not match its path".to_string());
        }
        state.source_app_visuals.push(visual);
      }
      state
        .source_app_visuals
        .sort_by(|left, right| left.key.cmp(&right.key));
    }
    let mut records = BTreeMap::new();
    if self.record_directory().exists() {
      for entry in fs::read_dir(self.record_directory())
        .map_err(|error| format!("clipboard records read failed: {error}"))?
      {
        let path = entry
          .map_err(|error| format!("clipboard record read failed: {error}"))?
          .path();
        if path.extension().and_then(|value| value.to_str()) != Some("enc") {
          continue;
        }
        let item = self
          .record_file_at(path.clone())
          .load::<ClipboardItemRecord>()?
          .ok_or_else(|| "clipboard record disappeared during load".to_string())?;
        if self.record_path(item.item.id()) != path {
          return Err("clipboard record identity does not match its path".to_string());
        }
        records.insert(item.item.id().to_string(), item);
      }
    }
    let mut head = self
      .head_file()
      .load::<ClipboardRecordHead>()?
      .ok_or_else(|| "clipboard history head is missing".to_string())?
      .item_id;
    while let Some(id) = head {
      let record = records
        .remove(&id)
        .ok_or_else(|| "clipboard history order is invalid".to_string())?;
      state.items.push(record.item);
      head = record.next_id;
    }
    if !records.is_empty() {
      return Err("clipboard history contains unreachable records".to_string());
    }
    *self
      .checkpoint
      .lock()
      .map_err(crate::logging::with_cause_logged(
        "clipboard checkpoint lock is poisoned",
      ))? = Some(state.clone());
    Ok(Some(state))
  }

  fn head_file(&self) -> EncryptedJsonFile {
    EncryptedJsonFile::new(
      self.key,
      self.path.with_extension("head.enc"),
      "clipboard history head",
    )
  }

  fn settings_file(&self) -> EncryptedJsonFile {
    EncryptedJsonFile::new(
      self.key,
      self.path.with_extension("settings.enc"),
      "clipboard settings",
    )
  }
  fn visual_directory(&self) -> PathBuf {
    self.path.with_extension("visuals")
  }
  fn visual_path(&self, key: &str) -> PathBuf {
    self.visual_directory().join(format!(
      "{}.enc",
      hex::encode(Sha256::digest(key.as_bytes()))
    ))
  }
  fn visual_file_at(&self, path: PathBuf) -> EncryptedJsonFile {
    let binding = path.file_stem().unwrap().to_string_lossy().into_owned();
    EncryptedJsonFile::new(self.key, path, "clipboard visual")
      .with_associated_data(format!("clipboard-visual:{binding}").into_bytes())
  }

  fn record_directory(&self) -> PathBuf {
    self.path.with_extension("records")
  }

  fn record_file(&self, id: &str) -> EncryptedJsonFile {
    self.record_file_at(self.record_path(id))
  }

  fn record_file_at(&self, path: PathBuf) -> EncryptedJsonFile {
    let binding = path.file_stem().unwrap().to_string_lossy().into_owned();
    EncryptedJsonFile::new(self.key, path, "clipboard record")
      .with_associated_data(format!("clipboard-record:{binding}").into_bytes())
  }

  fn record_path(&self, id: &str) -> PathBuf {
    // A digest keeps even malformed imported IDs inside the private directory.
    self.record_directory().join(format!(
      "{}.enc",
      hex::encode(Sha256::digest(id.as_bytes()))
    ))
  }

  #[cfg_attr(
    not(test),
    expect(
      clippy::unused_self,
      reason = "the receiver owns test-only encrypted-write accounting"
    )
  )]
  fn write_record<T: Serialize>(
    &self,
    file: &EncryptedJsonFile,
    value: &T,
  ) -> Result<(), String> {
    file.persist(value)?;
    #[cfg(test)]
    self.written_bytes.fetch_add(
      fs::metadata(file.path()).unwrap().len() as usize,
      std::sync::atomic::Ordering::Relaxed,
    );
    Ok(())
  }

  fn apply_pending(&self, manifest: &ClipboardRecordManifest) -> Result<(), String> {
    if let Some(settings) = &manifest.settings {
      self.write_record(&self.settings_file(), settings)?;
    }
    for visual in &manifest.updated_visuals {
      self.write_record(&self.visual_file_at(self.visual_path(&visual.key)), visual)?;
    }
    for key in &manifest.removed_visuals {
      match fs::remove_file(self.visual_path(key)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("clipboard visual removal failed: {error}")),
      }
    }
    for record in &manifest.updated {
      self.write_record(&self.record_file(record.item.id()), record)?;
    }
    if let Some(head) = &manifest.head {
      self.write_record(&self.head_file(), head)?;
    }
    for id in &manifest.removed {
      match fs::remove_file(self.record_path(id)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("clipboard record removal failed: {error}")),
      }
    }
    if manifest.head.is_some()
      || manifest.settings.is_some()
      || !manifest.updated.is_empty()
      || !manifest.removed.is_empty()
      || !manifest.updated_visuals.is_empty()
      || !manifest.removed_visuals.is_empty()
    {
      self.write_record(&self.history_file(), &ClipboardRecordManifest::default())?;
    }
    Ok(())
  }

  fn image_directory(&self) -> PathBuf {
    self.path.with_extension("images")
  }

  fn image_path(&self, blob_id: &str, suffix: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(blob_id)
      .map_err(|error| format!("clipboard image identifier is invalid: {error}"))?;
    Ok(self.image_directory().join(format!("{blob_id}{suffix}")))
  }

  fn encrypt_blob(
    &self,
    plaintext: &[u8],
    associated_data: &[u8],
  ) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(&self.key)
      .map_err(|error| format!("clipboard encryption key is invalid: {error}"))?;
    let nonce = Nonce::generate();
    let ciphertext = cipher
      .encrypt(
        &nonce,
        aes_gcm::aead::Payload {
          msg: plaintext,
          aad: associated_data,
        },
      )
      .map_err(|error| format!("clipboard image encryption failed: {error}"))?;
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
      .map_err(|error| format!("clipboard image nonce is invalid: {error}"))?;
    let cipher = Aes256Gcm::new_from_slice(&self.key)
      .map_err(|error| format!("clipboard encryption key is invalid: {error}"))?;
    cipher
      .decrypt(
        &nonce,
        aes_gcm::aead::Payload {
          msg: &blob[IMAGE_BLOB_HEADER_BYTES..],
          aad: associated_data,
        },
      )
      .map_err(|error| format!("clipboard image could not be decrypted: {error}"))
  }

  fn write_encrypted_blob(
    &self,
    path: &Path,
    plaintext: &[u8],
    associated_data: &[u8],
  ) -> Result<(), String> {
    let encrypted = self.encrypt_blob(plaintext, associated_data)?;
    write_private_atomic(path, &encrypted)
      .map_err(|error| format!("clipboard image write failed: {error}"))
  }

  pub fn persist_image(
    &self,
    blob_id: &str,
    payload: ClipboardImagePayload<'_>,
  ) -> Result<ClipboardImagePersistStatus, String> {
    create_private_dir(&self.image_directory())
      .map_err(|error| format!("clipboard image directory failed: {error}"))?;
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

  fn remove_records(path: &Path) -> Result<(), String> {
    for directory in [
      path.with_extension("records"),
      path.with_extension("visuals"),
    ] {
      match fs::remove_dir_all(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
          return Err(format!("clipboard record store removal failed: {error}"));
        }
      }
    }
    for metadata_path in [
      path.with_extension("settings.enc"),
      path.with_extension("head.enc"),
    ] {
      match fs::remove_file(metadata_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
          return Err(format!("clipboard settings removal failed: {error}"));
        }
      }
    }
    Ok(())
  }

  pub fn remove(path: &Path) -> Result<(), String> {
    Self::remove_records(path)?;
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
    let mut checkpoint = state.clone();
    for item in &mut checkpoint.items {
      item.clear_image_payload();
    }
    let state = &checkpoint;
    // Finish an acknowledged transaction before replacing its recovery record.
    if let Some(manifest) = self.history_file().load::<ClipboardRecordManifest>()? {
      self.apply_pending(&manifest)?;
    }
    if self
      .checkpoint
      .lock()
      .map_err(crate::logging::with_cause_logged(
        "clipboard checkpoint lock is poisoned",
      ))?
      .is_none()
    {
      self.load()?;
    }
    let previous = self
      .checkpoint
      .lock()
      .map_err(crate::logging::with_cause_logged(
        "clipboard checkpoint lock is poisoned",
      ))?
      .clone();
    let manifest = plan_record_transaction(state, previous.as_ref());
    self.write_record(&self.history_file(), &manifest)?;
    // The atomic manifest write is the commit point. A failed materialization
    // remains durable and is retried on load or before the next transaction.
    if let Err(error) = self.apply_pending(&manifest) {
      tracing::warn!(error = %error, "clipboard record transaction awaits recovery");
    }
    *self
      .checkpoint
      .lock()
      .map_err(crate::logging::with_cause_logged(
        "clipboard checkpoint lock is poisoned",
      ))? = Some(state.clone());
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::clipboard::{
    ClipboardCaptureStatus, ClipboardItem, ClipboardItemRetentionClass,
    ClipboardRetention, ClipboardSourceApp, ClipboardSourceAppExclusion,
  };
  use chrono::{DateTime, Utc};

  fn unique_path() -> PathBuf {
    std::env::temp_dir().join(format!(
      "stella-clipboard-store-{}.json",
      uuid::Uuid::new_v4()
    ))
  }

  fn stored_snapshot_fixture() -> PersistedClipboardState {
    PersistedClipboardState {
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
      source_app_exclusions: vec![ClipboardSourceAppExclusion {
        identifier: "com.example.private".to_string(),
        name: "Private App".to_string(),
      }],
      source_app_visuals: Vec::new(),
    }
  }

  #[test]
  fn clipboard_capture_writes_are_bounded_by_the_changed_record() {
    use std::sync::atomic::Ordering;
    let mut measured = Vec::new();
    for count in [5, 500] {
      let path = unique_path();
      let store = ClipboardStore::new([7; 32], path.clone());
      let now = DateTime::parse_from_rfc3339("2026-10-21T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
      let mut state = PersistedClipboardState {
        capture_status: ClipboardCaptureStatus::Active,
        groups: Vec::new(),
        items: (0..count)
          .map(|index| ClipboardItem::Text {
            copied_at: now - chrono::Duration::seconds(index),
            group_id: None,
            grouped_at: None,
            id: format!("00000000-0000-0000-0000-{index:012}"),
            name: None,
            plain_text: format!("{index:04}{}", "x".repeat(1020)),
            retention_class: ClipboardItemRetentionClass::History,
            source_app: Some(ClipboardSourceApp {
              identifier: Some(format!("com.example.app{:03}", index % 128)),
              name: "Editor".to_string(),
              page: None,
              visual_key: None,
            }),
          })
          .collect(),
        pending_image_blob_ids: Default::default(),
        retention: ClipboardRetention::Month,
        source_app_exclusions: Vec::new(),
        source_app_visuals: (0..count.min(128))
          .map(|index| ClipboardSourceAppVisual {
            color: None,
            icon_data_url: Some(format!("data:image/png;base64,{}", "A".repeat(49120))),
            key: format!("com.example.app{index:03}"),
          })
          .collect(),
      };
      store.persist(&state).unwrap();
      store.written_bytes.store(0, Ordering::Relaxed);
      let mut item = state.items[0].clone();
      if let ClipboardItem::Text {
        copied_at,
        id,
        plain_text,
        ..
      } = &mut item
      {
        *copied_at = now + chrono::Duration::seconds(1);
        *id = "00000000-0000-0000-0000-999999999999".to_string();
        *plain_text = "n".repeat(1024);
      }
      state.items.pop();
      state.items.insert(0, item);
      let baseline = unique_path();
      EncryptedJsonFile::new([7; 32], baseline.clone(), "clipboard")
        .persist(&state)
        .unwrap();
      let before = fs::metadata(&baseline).unwrap().len();
      store.persist(&state).unwrap();
      let after = store.written_bytes.load(Ordering::Relaxed);
      tracing::debug!(
        "clipboard capture at {count} items: before={before} after={after} encrypted bytes"
      );
      measured.push(after);
      assert!(
        after < 13000,
        "capture rewrote unchanged history: {after} bytes"
      );
      let restarted = ClipboardStore::new([7; 32], path.clone())
        .load()
        .unwrap()
        .unwrap();
      assert_eq!(restarted, state);
      for entry in fs::read_dir(store.record_directory()).unwrap() {
        let raw = fs::read(entry.unwrap().path()).unwrap();
        assert!(!raw.windows(64).any(|part| part == [b'n'; 64]));
      }
      state.source_app_visuals[0].icon_data_url =
        Some(format!("data:image/png;base64,{}", "B".repeat(49120)));
      store.written_bytes.store(0, Ordering::Relaxed);
      store.persist(&state).unwrap();
      let visual_bytes = store.written_bytes.load(Ordering::Relaxed);
      tracing::debug!(count, visual_bytes, "clipboard icon change encrypted bytes");
      assert!(
        visual_bytes < 200000,
        "capture rewrote unchanged app icons: {visual_bytes} bytes"
      );
      assert_eq!(
        ClipboardStore::new([7; 32], path.clone())
          .load()
          .unwrap()
          .unwrap(),
        state
      );
      ClipboardStore::remove(&path).unwrap();
      fs::remove_file(baseline).unwrap();
    }
    assert_eq!(
      measured[0], measured[1],
      "capture writes must be independent of history length"
    );
  }

  #[test]
  fn clipboard_committed_capture_recovers_after_record_write_interruption() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    let mut state = PersistedClipboardState {
      capture_status: ClipboardCaptureStatus::Active,
      groups: Vec::new(),
      items: vec![ClipboardItem::Text {
        copied_at: Utc::now(),
        group_id: None,
        grouped_at: None,
        id: "record".to_string(),
        name: None,
        plain_text: "capture".to_string(),
        retention_class: ClipboardItemRetentionClass::History,
        source_app: None,
      }],
      pending_image_blob_ids: Default::default(),
      retention: ClipboardRetention::Month,
      source_app_exclusions: Vec::new(),
      source_app_visuals: Vec::new(),
    };
    let mut initial = state.clone();
    initial.items.clear();
    store.persist(&initial).unwrap();
    fs::write(store.record_directory(), b"blocked directory").unwrap();
    store.persist(&state).unwrap();
    assert!(store.load().unwrap_err().contains("directory"));
    fs::remove_file(store.record_directory()).unwrap();
    let recovered = ClipboardStore::new([7; 32], path.clone());
    assert_eq!(recovered.load().unwrap().unwrap(), state);
    assert!(
      recovered
        .history_file()
        .load::<ClipboardRecordManifest>()
        .unwrap()
        .unwrap()
        .updated
        .is_empty()
    );
    let record_path = recovered.record_path("record");
    fs::remove_file(&record_path).unwrap();
    fs::create_dir(&record_path).unwrap();
    state.items.clear();
    recovered.persist(&state).unwrap();
    assert_eq!(
      recovered
        .history_file()
        .load::<ClipboardRecordManifest>()
        .unwrap()
        .unwrap()
        .removed,
      vec!["record"]
    );
    assert!(recovered.load().unwrap_err().contains("removal failed"));
    fs::remove_dir(&record_path).unwrap();
    assert_eq!(
      ClipboardStore::new([7; 32], path.clone())
        .load()
        .unwrap()
        .unwrap(),
      state
    );
    assert!(!record_path.exists());
    ClipboardStore::remove(&path).unwrap();
  }

  #[test]
  fn clipboard_record_order_survives_equal_and_reversed_capture_times() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    let now = DateTime::parse_from_rfc3339("2026-10-21T12:00:00Z")
      .unwrap()
      .with_timezone(&Utc);
    let mut state = PersistedClipboardState {
      capture_status: ClipboardCaptureStatus::Active,
      groups: Vec::new(),
      items: [0, 0, 5, -5]
        .into_iter()
        .enumerate()
        .map(|(index, seconds)| ClipboardItem::Text {
          copied_at: now + chrono::Duration::seconds(seconds),
          id: format!("item-{index}"),
          group_id: None,
          grouped_at: None,
          name: None,
          plain_text: index.to_string(),
          retention_class: ClipboardItemRetentionClass::History,
          source_app: None,
        })
        .collect(),
      pending_image_blob_ids: Default::default(),
      retention: ClipboardRetention::Month,
      source_app_exclusions: Vec::new(),
      source_app_visuals: Vec::new(),
    };
    store.persist(&state).unwrap();
    assert_eq!(
      ClipboardStore::new([7; 32], path.clone())
        .load()
        .unwrap()
        .unwrap(),
      state
    );
    state.items.swap(1, 3);
    store.persist(&state).unwrap();
    assert_eq!(
      ClipboardStore::new([7; 32], path.clone())
        .load()
        .unwrap()
        .unwrap(),
      state
    );
    state.items.remove(1);
    store.persist(&state).unwrap();
    assert_eq!(
      ClipboardStore::new([7; 32], path.clone())
        .load()
        .unwrap()
        .unwrap(),
      state
    );
    ClipboardStore::remove(&path).unwrap();
  }

  #[test]
  fn clipboard_startup_migration_preserves_encrypted_history_and_recovers_interruption()
  {
    for interrupted in [false, true] {
      let path = unique_path();
      let store = ClipboardStore::new([7; 32], path.clone());
      let mut state = stored_snapshot_fixture();
      let mut second = state.items[0].clone();
      if let ClipboardItem::Text { id, plain_text, .. } = &mut second {
        *id = "item-2".to_string();
        *plain_text = "another captured item".to_string();
      }
      state.items.push(second);
      let copied_at = state.items[0].copied_at();
      let blob_id = uuid::Uuid::new_v4().to_string();
      store
        .persist_image(
          &blob_id,
          ClipboardImagePayload {
            image: b"image",
            preview: b"preview",
          },
        )
        .unwrap();
      state.items.push(ClipboardItem::FormattedText {
        copied_at,
        group_id: Some("group".to_string()),
        grouped_at: Some(copied_at),
        id: "formatted".to_string(),
        name: None,
        html: "<b>formatted</b>".to_string(),
        plain_text: "formatted".to_string(),
        rtf: Some("{\\rtf1 formatted}".to_string()),
        retention_class: ClipboardItemRetentionClass::Kept,
        source_app: Some(ClipboardSourceApp {
          identifier: Some("com.example.private".to_string()),
          name: "Private App".to_string(),
          page: None,
          visual_key: None,
        }),
      });
      state.items.push(ClipboardItem::Image {
        blob_id: blob_id.clone(),
        byte_size: 5,
        checksum: hex::encode(Sha256::digest(b"image")),
        copied_at,
        group_id: None,
        grouped_at: None,
        height: 2,
        width: 2,
        id: "image".to_string(),
        name: None,
        image: None,
        preview: None,
        retention_class: ClipboardItemRetentionClass::History,
        source_app: None,
      });
      state.groups.push(crate::clipboard::ClipboardGroup {
        id: "group".to_string(),
        name: "Saved group".to_string(),
        color: crate::clipboard::ClipboardGroupColor::parse("#aabbcc").unwrap(),
      });
      state.capture_status = ClipboardCaptureStatus::Paused;
      state.retention = ClipboardRetention::Year;
      state.source_app_visuals = vec![ClipboardSourceAppVisual {
        key: "com.example.private".to_string(),
        color: Some("#aabbcc".to_string()),
        icon_data_url: Some("data:image/png;base64,QUJD".to_string()),
      }];
      state
        .pending_image_blob_ids
        .insert(uuid::Uuid::new_v4().to_string());
      store.history_file().persist(&state).unwrap();
      if interrupted {
        fs::write(store.record_directory(), b"blocked directory").unwrap();
        assert!(store.load().unwrap_err().contains("directory"));
        let committed = store
          .history_file()
          .load::<ClipboardRecordManifest>()
          .unwrap()
          .unwrap();
        assert_eq!(committed.updated.len(), state.items.len());
        assert_eq!(committed.updated_visuals, state.source_app_visuals);
        fs::remove_file(store.record_directory()).unwrap();
      }
      let restarted = ClipboardStore::new([7; 32], path.clone());
      assert_eq!(restarted.load().unwrap().unwrap(), state);
      assert_eq!(restarted.load_image(&blob_id, 5).unwrap(), b"image");
      assert_eq!(
        restarted.load_image_preview(&blob_id, 7).unwrap(),
        b"preview"
      );
      let manifest = restarted
        .history_file()
        .load::<ClipboardRecordManifest>()
        .unwrap()
        .unwrap();
      assert!(manifest.settings.is_none());
      assert!(manifest.updated.is_empty());
      // A repeated startup reads only the converted records and does not rewrite them.
      restarted
        .written_bytes
        .store(0, std::sync::atomic::Ordering::Relaxed);
      assert_eq!(restarted.load().unwrap().unwrap(), state);
      assert_eq!(
        restarted
          .written_bytes
          .load(std::sync::atomic::Ordering::Relaxed),
        0
      );
      ClipboardStore::remove(&path).unwrap();
    }
  }

  #[test]
  fn missing_history_retires_unreachable_records_before_a_new_capture() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    let previous = stored_snapshot_fixture();
    store.persist(&previous).unwrap();
    fs::remove_file(&path).unwrap();
    let staged_image_directory = path.with_extension("images");
    fs::create_dir_all(&staged_image_directory).unwrap();
    let staged_image = staged_image_directory.join("new-capture.image.enc");
    fs::write(&staged_image, b"staged capture").unwrap();

    assert!(store.load().unwrap().is_none());
    // Capturing an image writes its blob before the first history commit.
    assert!(staged_image.exists());
    assert!(!store.record_directory().exists());
    assert!(!store.visual_directory().exists());
    assert!(!store.settings_file().path().exists());
    assert!(!store.head_file().path().exists());

    let mut next = previous;
    next.items.clear();
    next.source_app_visuals.clear();
    store.persist(&next).unwrap();
    let loaded = ClipboardStore::new([7; 32], path.clone())
      .load()
      .unwrap()
      .unwrap();
    assert_eq!(loaded, next);
    ClipboardStore::remove(&path).unwrap();
  }

  #[test]
  fn missing_history_refuses_obstructed_record_directories() {
    for extension in ["records", "visuals"] {
      let path = unique_path();
      let store = ClipboardStore::new([7; 32], path.clone());
      let obstruction = path.with_extension(extension);
      fs::write(&obstruction, b"blocked directory").unwrap();

      assert!(
        store
          .load()
          .unwrap_err()
          .contains("clipboard record store removal failed")
      );
      assert!(!path.exists());
      assert_eq!(fs::read(&obstruction).unwrap(), b"blocked directory");

      fs::remove_file(obstruction).unwrap();
      ClipboardStore::remove(&path).unwrap();
    }
  }

  #[test]
  fn encrypted_store_round_trips_without_plaintext_on_disk() {
    let path = unique_path();
    let store = ClipboardStore::new([7; 32], path.clone());
    let state = stored_snapshot_fixture();

    store.persist(&state).unwrap();
    let raw = fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("privileged draft text"));
    assert!(!raw.contains("com.example.private"));
    assert!(!raw.contains("Private App"));
    let loaded = store.load().unwrap().unwrap();
    assert_eq!(loaded.items, state.items);
    assert_eq!(loaded.source_app_exclusions, state.source_app_exclusions);

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
    assert!(state.source_app_exclusions.is_empty());
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
        source_app_exclusions: Vec::new(),
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
