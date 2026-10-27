//! Encrypted at-rest storage shared by the local-only features.
//!
//! Every local-only store follows the same rules (see
//! `apps/desktop/docs/local-only-data.md`): its own keychain key, AES-256-GCM
//! JSON envelopes written atomically with owner-only permissions, and a key
//! that is never re-minted while encrypted data still depends on it.

#![allow(
  clippy::disallowed_methods,
  reason = "local_store owns local file creation"
)]

use aes_gcm::{
  Aes256Gcm, Nonce,
  aead::{Aead, Generate, KeyInit, Payload},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
  fs,
  io::Write,
  path::{Path, PathBuf},
};

use crate::keychain::{self, LocalDataKey, LocalDataKeyLookup};
use crate::logging::log_json_error;

const ENVELOPE_VERSION: u8 = 1;
const NONCE_BYTES: usize = 12;

/// On-disk shape of an encrypted JSON file. Field names and hex encoding are
/// part of the format existing stores were written in.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedEnvelope {
  ciphertext: String,
  nonce: String,
  version: u8,
}

fn read_envelope(
  path: &Path,
  label: &str,
) -> Result<Option<EncryptedEnvelope>, EncryptedReadError> {
  let raw = match fs::read(path) {
    Ok(raw) => raw,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => {
      return Err(EncryptedReadError::Unavailable(format!(
        "{label} store read failed: {error}"
      )));
    }
  };
  let metadata: serde_json::Value = serde_json::from_slice(&raw).map_err(|error| {
    log_json_error(&error, "encrypted store envelope is invalid");
    EncryptedReadError::Unreadable(format!("{label} envelope is invalid"))
  })?;
  let object = metadata.as_object().ok_or_else(|| {
    EncryptedReadError::Unreadable(format!("{label} envelope is not an object"))
  })?;
  if object.get("version").and_then(serde_json::Value::as_u64)
    != Some(u64::from(ENVELOPE_VERSION))
  {
    return Err(EncryptedReadError::Incompatible(format!(
      "{label} store version is unsupported"
    )));
  }
  serde_json::from_slice(&raw).map(Some).map_err(|error| {
    log_json_error(&error, "encrypted store envelope is invalid");
    EncryptedReadError::Unreadable(format!("{label} envelope is invalid"))
  })
}

pub(crate) fn check_envelope_compatibility(
  path: &Path,
  label: &str,
) -> Result<(), EncryptedReadError> {
  read_envelope(path, label).map(|_| ())
}

#[derive(Debug, PartialEq, Eq)]
pub enum EncryptedReadError {
  Unavailable(String),
  Unreadable(String),
  Incompatible(String),
}

impl std::fmt::Display for EncryptedReadError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Unavailable(message)
      | Self::Unreadable(message)
      | Self::Incompatible(message) => formatter.write_str(message),
    }
  }
}

/// One JSON value encrypted under a store key. `associated_data` binds the
/// ciphertext to its purpose (for example the day a file holds), so a file
/// moved to another name fails to decrypt instead of reading as that name.
#[derive(Clone)]
pub struct EncryptedJsonFile {
  key: [u8; 32],
  path: PathBuf,
  associated_data: Vec<u8>,
  label: &'static str,
}

impl EncryptedJsonFile {
  /// `label` names the store in error messages; it must not carry user data.
  pub fn new(key: [u8; 32], path: PathBuf, label: &'static str) -> Self {
    Self {
      key,
      path,
      associated_data: Vec::new(),
      label,
    }
  }

  pub fn with_associated_data(mut self, associated_data: impl Into<Vec<u8>>) -> Self {
    self.associated_data = associated_data.into();
    self
  }

  pub fn path(&self) -> &Path {
    &self.path
  }

  fn cipher(&self) -> Result<Aes256Gcm, String> {
    Aes256Gcm::new_from_slice(&self.key)
      .map_err(|error| format!("{} encryption key is invalid: {error}", self.label))
  }

  pub fn load<T: DeserializeOwned>(&self) -> Result<Option<T>, String> {
    self.load_checked().map_err(|error| error.to_string())
  }

  pub fn load_checked<T: DeserializeOwned>(
    &self,
  ) -> Result<Option<T>, EncryptedReadError> {
    let label = self.label;
    let Some(envelope) = read_envelope(&self.path, label)? else {
      return Ok(None);
    };
    let nonce = hex::decode(envelope.nonce).map_err(|error| {
      EncryptedReadError::Unreadable(format!("{label} nonce is invalid: {error}"))
    })?;
    if nonce.len() != NONCE_BYTES {
      return Err(EncryptedReadError::Unreadable(format!(
        "{label} nonce has an invalid length"
      )));
    }
    let nonce = Nonce::try_from(nonce.as_slice()).map_err(|error| {
      EncryptedReadError::Unreadable(format!("{label} nonce is invalid: {error}"))
    })?;
    let ciphertext = hex::decode(envelope.ciphertext).map_err(|error| {
      EncryptedReadError::Unreadable(format!("{label} ciphertext is invalid: {error}"))
    })?;
    let plaintext = self
      .cipher()
      .map_err(EncryptedReadError::Unavailable)?
      .decrypt(
        &nonce,
        Payload {
          msg: &ciphertext,
          aad: &self.associated_data,
        },
      )
      .map_err(|error| {
        EncryptedReadError::Unreadable(format!(
          "{label} store could not be decrypted: {error}"
        ))
      })?;
    serde_json::from_slice(&plaintext)
      .map(Some)
      .map_err(|error| {
        // serde would quote the decrypted contents it failed on.
        log_json_error(&error, "encrypted store contents are invalid");
        EncryptedReadError::Incompatible(format!("{label} store is invalid"))
      })
  }

  pub fn persist<T: Serialize>(&self, value: &T) -> Result<(), String> {
    let label = self.label;
    if let Some(parent) = self.path.parent() {
      create_private_dir(parent)
        .map_err(|error| format!("{label} store directory failed: {error}"))?;
    }
    let plaintext = serde_json::to_vec(value)
      .map_err(|error| format!("{label} serialization failed: {error}"))?;
    let nonce = Nonce::generate();
    let ciphertext = self
      .cipher()?
      .encrypt(
        &nonce,
        Payload {
          msg: &plaintext,
          aad: &self.associated_data,
        },
      )
      .map_err(|error| format!("{label} encryption failed: {error}"))?;
    let envelope = EncryptedEnvelope {
      ciphertext: hex::encode(ciphertext),
      nonce: hex::encode(nonce),
      version: ENVELOPE_VERSION,
    };
    let json = serde_json::to_vec(&envelope)
      .map_err(|error| format!("{label} envelope serialization failed: {error}"))?;
    write_private_atomic(&self.path, &json)
      .map_err(|error| format!("{label} store write failed: {error}"))
  }
}

#[cfg(unix)]
#[path = "local_store/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "local_store/windows.rs"]
mod platform;

#[derive(Clone, Copy)]
pub enum OpenMode {
  Read,
  #[cfg(windows)]
  ExclusiveRead,
  CreateNew,
  Append,
  #[cfg(test)]
  AppendExisting,
  Lock,
}

pub fn create_private_dir(directory: &Path) -> std::io::Result<()> {
  platform::create_directory(directory)
}

pub fn open_private(mode: OpenMode, path: &Path) -> std::io::Result<fs::File> {
  #[cfg(unix)]
  {
    open_private_with(mode, path, restrict_private_file)
  }
  #[cfg(windows)]
  {
    platform::Parent::at(path)?.open(mode)
  }
}

#[cfg(unix)]
fn open_private_with(
  mode: OpenMode,
  path: &Path,
  restrict: impl FnOnce(&fs::File) -> std::io::Result<()>,
) -> std::io::Result<fs::File> {
  let file = platform::Parent::at(path)?.open(mode)?;
  restrict(&file)?;
  Ok(file)
}

#[cfg(unix)]
fn restrict_private_file(file: &fs::File) -> std::io::Result<()> {
  rustix::fs::fchmod(file, rustix::fs::Mode::from_raw_mode(0o600)).map_err(Into::into)
}

pub fn rename_private(source: &Path, destination: &Path) -> std::io::Result<()> {
  platform::Parent::at(source)?.rename_to(&platform::Parent::at(destination)?)
}

pub fn remove_private(path: &Path) -> std::io::Result<()> {
  platform::Parent::at(path)?.remove()
}

pub fn move_private(source: &Path, destination: &Path) -> std::io::Result<()> {
  platform::Parent::at(source)?.move_to(&platform::Parent::at(destination)?)
}

pub fn link_private(source: &Path, destination: &Path) -> std::io::Result<()> {
  platform::Parent::at(source)?.link_to(&platform::Parent::at(destination)?)
}

// Dependency-managed writes are enumerated in docs/local-file-creation.md.
pub fn enable_autostart(app: &tauri::AppHandle) -> Result<(), String> {
  use tauri_plugin_autostart::ManagerExt;
  app
    .autolaunch()
    .enable()
    .map_err(|error| format!("autostart enable failed: {error}"))
}

pub fn disable_autostart(app: &tauri::AppHandle) -> Result<(), String> {
  use tauri_plugin_autostart::ManagerExt;
  app
    .autolaunch()
    .disable()
    .map_err(|error| format!("autostart disable failed: {error}"))
}

pub fn install_update(
  update: &tauri_plugin_updater::Update,
  package: &[u8],
) -> Result<(), String> {
  update.install(package).map_err(|error| error.to_string())
}

// Repository code generation writes a fixed source artifact, outside application data.
#[cfg(test)]
pub(crate) fn write_generated_rpc_bindings(bindings: &str) -> std::io::Result<()> {
  fs::write(
    Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../../../packages/api-contract/src/desktop-rpc.gen.ts"),
    bindings,
  )
}

#[cfg(all(test, unix))]
pub(crate) fn local_file_creation_child(test_name: &str) -> bool {
  if std::env::var_os("STELLA_LOCAL_FILE_CHILD").is_some() {
    return false;
  }
  let result = std::process::Command::new("python3")
    .args([
      "-c",
      "import os, subprocess, sys
old = os.umask(0)
try:
 sys.exit(subprocess.call(sys.argv[1:]))
finally:
 os.umask(old)",
    ])
    .arg(std::env::current_exe().unwrap())
    .args(["--exact", test_name, "--nocapture"])
    .env("STELLA_LOCAL_FILE_CHILD", "1")
    .status()
    .unwrap();
  assert!(result.success(), "local file child failed: {result}");
  true
}

/// Replaces `path` with `bytes` through a uniquely named sibling, so a reader
/// sees the old or the new file and never a partial one. The file is
/// readable by the owner only; a failed write leaves no temporary behind.
pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
  let destination = platform::Parent::at(path).map_err(|error| error.to_string())?;
  let temporary_name = path.with_extension(format!(
    "{}.{}.tmp",
    std::process::id(),
    uuid::Uuid::new_v4()
  ));
  let temporary = destination
    .sibling(
      temporary_name
        .file_name()
        .ok_or("invalid temporary file name")?
        .to_os_string(),
    )
    .map_err(|error| error.to_string())?;
  let mut file = temporary
    .open(OpenMode::CreateNew)
    .map_err(|error| error.to_string())?;
  let written = file.write_all(bytes).and_then(|()| file.sync_all());
  drop(file);
  let replaced = written.and_then(|()| temporary.rename_to(&destination));
  if let Err(error) = replaced {
    return match temporary.remove() {
      Ok(()) => Err(format!("replace failed: {error}")),
      Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => {
        Err(format!("replace failed: {error}"))
      }
      Err(cleanup) => Err(format!(
        "replace failed: {error}; temporary file cleanup failed: {cleanup}"
      )),
    };
  }
  Ok(())
}

/// How a local store may persist, decided before it loads anything.
pub enum StoreKey {
  Key([u8; 32]),
  /// Nothing is written: no data directory, or no key and no data to lose.
  MemoryOnly,
  /// Encrypted data exists but cannot be opened; the user may only delete it.
  DeletionOnly,
}

/// Resolves the key for a store whose encrypted data does (or does not) exist.
///
/// A store whose key is missing must never be re-keyed: the miss may be
/// transient (a locked or migrating keychain) and minting a new key would make
/// the data undecryptable for good. Deletion-only lets the user reset it,
/// after which a new key is created.
pub fn resolve_key(key: LocalDataKey<'_>, data_exists: bool) -> StoreKey {
  resolve_key_with(
    || keychain::get_local_data_key(key),
    || keychain::create_local_data_key(key),
    data_exists,
  )
}

fn resolve_key_with(
  lookup: impl FnOnce() -> Result<LocalDataKeyLookup, String>,
  create: impl FnOnce() -> Result<[u8; 32], String>,
  data_exists: bool,
) -> StoreKey {
  let resolved = lookup().and_then(|lookup| match lookup {
    LocalDataKeyLookup::Found(key) => Ok(key),
    LocalDataKeyLookup::Missing if data_exists => {
      Err("encrypted data exists but its key is missing from the keychain".to_string())
    }
    LocalDataKeyLookup::Missing => create(),
  });
  match resolved {
    Ok(key) => StoreKey::Key(key),
    Err(error) => {
      tracing::warn!(error = %error, "local store key is unavailable");
      if data_exists {
        StoreKey::DeletionOnly
      } else {
        StoreKey::MemoryOnly
      }
    }
  }
}

/// Debug builds keep local stores in memory so development never touches the
/// production keychain item or data, unless `env` opts in.
#[cfg(debug_assertions)]
pub fn debug_build_is_memory_only(env: &str) -> bool {
  if std::env::var_os(env).is_some() {
    return false;
  }
  tracing::info!(
    env,
    "local store is memory-only in debug builds; set the variable to 1 to test encrypted persistence"
  );
  true
}

#[cfg(not(debug_assertions))]
pub fn debug_build_is_memory_only(_env: &str) -> bool {
  false
}

#[cfg(test)]
mod tests {
  use super::*;

  #[cfg(unix)]
  fn assert_link_error(error: std::io::Error) {
    assert!(
      matches!(error.raw_os_error(), Some(code) if
      code == rustix::io::Errno::LOOP.raw_os_error()
      || code == rustix::io::Errno::NOTDIR.raw_os_error()),
      "unexpected local file error: {error}"
    );
  }

  #[cfg(unix)]
  #[test]
  fn local_file_creation_rejects_linked_entries() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = unique_path().parent().unwrap().to_path_buf();
    create_private_dir(&root).unwrap();
    let outside = root.join("outside");
    create_private_dir(&outside).unwrap();
    let sentinel = outside.join("sentinel");
    fs::write(&sentinel, b"original").unwrap();
    fs::set_permissions(&sentinel, fs::Permissions::from_mode(0o666)).unwrap();
    let leaf = root.join("leaf");
    symlink(&sentinel, &leaf).unwrap();
    assert_link_error(open_private(OpenMode::Append, &leaf).unwrap_err());
    assert!(write_private_atomic(&leaf, b"replacement").is_err());
    let source = root.join("source");
    write_private_atomic(&source, b"value").unwrap();
    assert_link_error(rename_private(&source, &leaf).unwrap_err());
    assert_link_error(link_private(&source, &leaf).unwrap_err());
    let directory_link = root.join("directory");
    symlink(&outside, &directory_link).unwrap();
    assert_link_error(create_private_dir(&directory_link).unwrap_err());
    assert!(write_private_atomic(&directory_link.join("file"), b"value").is_err());
    let middle = root.join("middle");
    create_private_dir(&middle).unwrap();
    symlink(&outside, middle.join("link")).unwrap();
    assert_link_error(create_private_dir(&middle.join("link/nested")).unwrap_err());
    assert_link_error(
      open_private(OpenMode::Append, &middle.join("link/sentinel")).unwrap_err(),
    );
    assert_eq!(fs::read(&sentinel).unwrap(), b"original");
    assert_eq!(
      fs::metadata(&sentinel).unwrap().permissions().mode() & 0o777,
      0o666
    );
    assert!(!outside.join("nested").exists());
    assert!(!outside.join("file").exists());
    fs::remove_dir_all(root).unwrap();
  }

  #[cfg(unix)]
  #[test]
  fn local_file_creation_keeps_the_open_directory() {
    use std::os::unix::fs::symlink;
    let root = unique_path().parent().unwrap().to_path_buf();
    let original = root.join("original");
    let moved = root.join("moved");
    let outside = root.join("outside");
    create_private_dir(&original).unwrap();
    create_private_dir(&outside).unwrap();
    let parent = platform::Parent::at(&original.join("file")).unwrap();
    fs::rename(&original, &moved).unwrap();
    symlink(&outside, &original).unwrap();
    parent
      .open(OpenMode::CreateNew)
      .unwrap()
      .write_all(b"value")
      .unwrap();
    assert_eq!(fs::read(moved.join("file")).unwrap(), b"value");
    assert!(!outside.join("file").exists());
    fs::remove_dir_all(root).unwrap();
  }

  #[cfg(unix)]
  #[test]
  fn local_file_creation_uses_one_contract() {
    use std::os::unix::fs::PermissionsExt;
    if local_file_creation_child(
      "local_store::tests::local_file_creation_uses_one_contract",
    ) {
      return;
    }
    let path = unique_path();
    create_private_dir(path.parent().unwrap()).unwrap();
    let file = open_private_with(OpenMode::CreateNew, &path, |file| {
      assert_eq!(file.metadata()?.permissions().mode() & 0o777, 0o600);
      restrict_private_file(file)
    })
    .unwrap();
    drop(file);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
    let reopened = open_private(OpenMode::Read, &path).unwrap();
    assert_eq!(
      reopened.metadata().unwrap().permissions().mode() & 0o777,
      0o600
    );
    let error = open_private_with(OpenMode::Read, &path, |_| {
      Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    })
    .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o777))
      .unwrap();
    create_private_dir(path.parent().unwrap()).unwrap();
    assert_eq!(
      fs::metadata(path.parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777,
      0o700
    );
    write_private_atomic(&path, b"first").unwrap();
    write_private_atomic(&path, b"second").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"second");
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    let directory_target = path.parent().unwrap().join("directory");
    create_private_dir(&directory_target).unwrap();
    assert!(
      write_private_atomic(&directory_target, b"value")
        .unwrap_err()
        .contains("replace failed")
    );
    assert!(directory_target.is_dir());
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 2);
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  #[cfg(windows)]
  #[test]
  fn local_file_creation_observes_shared_handles() {
    let path = unique_path();
    create_private_dir(path.parent().unwrap()).unwrap();
    write_private_atomic(&path, b"document").unwrap();
    drop(open_private(OpenMode::ExclusiveRead, &path).unwrap());
    let reader = open_private(OpenMode::Read, &path).unwrap();
    assert!(open_private(OpenMode::ExclusiveRead, &path).is_err());
    drop(reader);
    drop(open_private(OpenMode::ExclusiveRead, &path).unwrap());
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn local_file_creation_moves_without_replacing_a_copy() {
    let source = unique_path();
    let destination = source.with_file_name("recovery.docx");
    create_private_dir(source.parent().unwrap()).unwrap();
    write_private_atomic(&source, b"first").unwrap();
    move_private(&source, &destination).unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(&destination).unwrap(), b"first");
    write_private_atomic(&source, b"second").unwrap();
    assert_eq!(
      move_private(&source, &destination).unwrap_err().kind(),
      std::io::ErrorKind::AlreadyExists
    );
    assert_eq!(fs::read(&source).unwrap(), b"second");
    assert_eq!(fs::read(&destination).unwrap(), b"first");
    fs::remove_dir_all(source.parent().unwrap()).unwrap();
  }

  /// A store path in its own fresh directory, so `persist` restricts that
  /// directory rather than the shared temp directory.
  fn unique_path() -> PathBuf {
    std::env::temp_dir()
      .join(format!("stella-local-store-{}", uuid::Uuid::new_v4()))
      .join("store.json")
  }

  #[test]
  fn checked_reads_distinguish_unreadable_envelopes_from_unavailable_storage() {
    let path = unique_path();
    let file = EncryptedJsonFile::new([9; 32], path.clone(), "fixture");
    file.persist(&serde_json::json!({ "saved": true })).unwrap();
    let wrong_key = EncryptedJsonFile::new([8; 32], path.clone(), "fixture");
    assert!(matches!(
      wrong_key.load_checked::<serde_json::Value>(),
      Err(EncryptedReadError::Unreadable(_))
    ));
    fs::write(&path, b"malformed envelope").unwrap();
    assert!(matches!(
      file.load_checked::<serde_json::Value>(),
      Err(EncryptedReadError::Unreadable(_))
    ));
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(matches!(
      file.load_checked::<serde_json::Value>(),
      Err(EncryptedReadError::Unavailable(_))
    ));
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  fn remove_store(path: &Path) {
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn newer_envelopes_and_decryptable_unknown_variants_are_incompatible() {
    #[derive(Debug, Deserialize)]
    enum SavedState {
      Ready,
    }
    let _ = SavedState::Ready;
    let path = unique_path();
    let file = EncryptedJsonFile::new([9; 32], path.clone(), "fixture");
    file.persist(&"FutureState").unwrap();
    let original = fs::read(&path).unwrap();
    assert!(matches!(
      file.load_checked::<SavedState>(),
      Err(EncryptedReadError::Incompatible(_))
    ));
    assert_eq!(fs::read(&path).unwrap(), original);
    let mut envelope: serde_json::Value = serde_json::from_slice(&original).unwrap();
    envelope["version"] = serde_json::json!(ENVELOPE_VERSION + 1);
    fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert!(matches!(
      file.load_checked::<serde_json::Value>(),
      Err(EncryptedReadError::Incompatible(_))
    ));
    remove_store(&path);
  }

  #[test]
  fn envelope_version_999_is_incompatible_before_decoding_changed_fields() {
    let path = unique_path();
    let file = EncryptedJsonFile::new([9; 32], path.clone(), "fixture");
    file.persist(&true).unwrap();
    let original = br#"{"version":999,"futureCiphertext":{"data":"saved"}}"#;
    fs::write(&path, original).unwrap();
    assert!(matches!(
      file.load_checked::<serde_json::Value>(),
      Err(EncryptedReadError::Incompatible(_))
    ));
    assert!(matches!(
      check_envelope_compatibility(&path, "fixture"),
      Err(EncryptedReadError::Incompatible(_))
    ));
    assert_eq!(fs::read(&path).unwrap(), original);
    remove_store(&path);
  }

  #[test]
  fn object_envelopes_without_a_supported_integer_version_are_incompatible() {
    let path = unique_path();
    let file = EncryptedJsonFile::new([7; 32], path.clone(), "fixture");
    file.persist(&true).unwrap();
    for raw in [
      "{}",
      r#"{"futureCiphertext":"saved"}"#,
      r#"{"version":null}"#,
      r#"{"version":"1"}"#,
      r#"{"version":1.5}"#,
      r#"{"version":-1}"#,
      r#"{"version":999}"#,
    ] {
      fs::write(&path, raw).unwrap();
      assert!(
        matches!(
          file.load_checked::<serde_json::Value>(),
          Err(EncryptedReadError::Incompatible(_))
        ),
        "{raw}"
      );
      assert!(
        matches!(
          check_envelope_compatibility(&path, "fixture"),
          Err(EncryptedReadError::Incompatible(_))
        ),
        "{raw}"
      );
      assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }
    for raw in ["invalid json", "null", "1", "[]", r#""text""#] {
      fs::write(&path, raw).unwrap();
      assert!(
        matches!(
          file.load_checked::<serde_json::Value>(),
          Err(EncryptedReadError::Unreadable(_))
        ),
        "{raw}"
      );
    }
    remove_store(&path);
  }

  #[test]
  fn round_trips_without_plaintext_on_disk() {
    let path = unique_path();
    let file = EncryptedJsonFile::new([7; 32], path.clone(), "test");
    file.persist(&vec!["private value"]).unwrap();

    let raw = fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("private value"));
    let envelope: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let mut fields = envelope
      .as_object()
      .unwrap()
      .keys()
      .cloned()
      .collect::<Vec<_>>();
    fields.sort();
    assert_eq!(fields, ["ciphertext", "nonce", "version"]);
    assert_eq!(
      file.load::<Vec<String>>().unwrap(),
      Some(vec!["private value".to_string()])
    );
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
      );
      assert_eq!(
        fs::metadata(path.parent().unwrap())
          .unwrap()
          .permissions()
          .mode()
          & 0o777,
        0o700
      );
    }
    remove_store(&path);
  }

  #[cfg(unix)]
  #[test]
  fn new_nested_directories_and_atomic_files_have_private_modes() {
    use std::os::unix::fs::PermissionsExt;
    let root = unique_path().with_extension("directory");
    let nested = root.join("nested");
    create_private_dir(&nested).unwrap();
    for directory in [&root, &nested] {
      assert_eq!(
        fs::metadata(directory).unwrap().permissions().mode() & 0o777,
        0o700
      );
    }
    let path = nested.join("data.json.enc");
    write_private_atomic(&path, b"encrypted").unwrap();
    assert_eq!(
      fs::metadata(&path).unwrap().permissions().mode() & 0o777,
      0o600
    );
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn a_missing_file_loads_as_nothing() {
    let file = EncryptedJsonFile::new([7; 32], unique_path(), "test");
    assert_eq!(file.load::<Vec<String>>().unwrap(), None);
  }

  #[test]
  fn wrong_key_or_associated_data_cannot_decrypt() {
    let path = unique_path();
    EncryptedJsonFile::new([7; 32], path.clone(), "test")
      .with_associated_data("day:2026-01-01")
      .persist(&1)
      .unwrap();

    assert!(
      EncryptedJsonFile::new([8; 32], path.clone(), "test")
        .with_associated_data("day:2026-01-01")
        .load::<i32>()
        .is_err()
    );
    assert!(
      EncryptedJsonFile::new([7; 32], path.clone(), "test")
        .with_associated_data("day:2026-01-02")
        .load::<i32>()
        .is_err()
    );
    assert_eq!(
      EncryptedJsonFile::new([7; 32], path.clone(), "test")
        .with_associated_data("day:2026-01-01")
        .load::<i32>()
        .unwrap(),
      Some(1)
    );
    remove_store(&path);
  }

  #[test]
  fn empty_associated_data_reads_envelopes_written_without_it() {
    // Envelopes written before associated data existed were encrypted with
    // the plain AEAD call; an empty AAD must stay byte-compatible with it.
    let path = unique_path();
    let parent = path.parent().unwrap();
    assert!(!parent.exists());
    create_private_dir(parent).unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(
        fs::metadata(parent).unwrap().permissions().mode() & 0o777,
        0o700
      );
    }
    let nonce = Nonce::generate();
    let ciphertext = Aes256Gcm::new_from_slice(&[7; 32])
      .unwrap()
      .encrypt(&nonce, b"42".as_ref())
      .unwrap();
    fs::write(
      &path,
      serde_json::to_vec(&EncryptedEnvelope {
        ciphertext: hex::encode(ciphertext),
        nonce: hex::encode(nonce),
        version: ENVELOPE_VERSION,
      })
      .unwrap(),
    )
    .unwrap();

    assert_eq!(
      EncryptedJsonFile::new([7; 32], path.clone(), "test")
        .load::<i32>()
        .unwrap(),
      Some(42)
    );
    remove_store(&path);
  }

  #[test]
  fn a_missing_key_is_minted_only_when_no_data_depends_on_it() {
    for data_exists in [false, true] {
      let mut minted = false;
      let resolved = resolve_key_with(
        || Ok(LocalDataKeyLookup::Missing),
        || {
          minted = true;
          Ok([1; 32])
        },
        data_exists,
      );
      assert_eq!(minted, !data_exists);
      match resolved {
        StoreKey::Key(key) => {
          assert!(!data_exists);
          assert_eq!(key, [1; 32]);
        }
        StoreKey::DeletionOnly => assert!(data_exists),
        StoreKey::MemoryOnly => panic!("a missing key must not fall back to memory"),
      }
    }
  }

  #[test]
  fn an_unreadable_keychain_never_mints_a_key() {
    for data_exists in [false, true] {
      let resolved = resolve_key_with(
        || Err("locked".to_string()),
        || panic!("must not mint"),
        data_exists,
      );
      assert!(matches!(
        (resolved, data_exists),
        (StoreKey::DeletionOnly, true) | (StoreKey::MemoryOnly, false)
      ));
    }
  }

  #[test]
  fn a_found_key_is_used_as_is() {
    let resolved = resolve_key_with(
      || Ok(LocalDataKeyLookup::Found([3; 32])),
      || panic!("must not mint"),
      true,
    );
    assert!(matches!(resolved, StoreKey::Key(key) if key == [3; 32]));
  }
}
