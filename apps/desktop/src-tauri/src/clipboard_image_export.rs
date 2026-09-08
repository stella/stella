use std::{
  fs,
  io::{ErrorKind, Write},
  os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
  path::{Path, PathBuf},
};

use reqwest::Url;

use crate::config::APP_DATA_DIR_NAME;

const EXPORT_SLOTS: [&str; 2] = ["0", "1"];
const EXPORT_FILENAME: &str = "image.png";

/// Only explicit copies materialize an image. Two fixed slots let a failed
/// replacement preserve the current clipboard file without growing a cache.
/// This state is never included in encrypted history or its checkpoints.
pub(crate) struct ClipboardImageExports {
  directory: Option<PathBuf>,
  active: Option<usize>,
}

impl ClipboardImageExports {
  pub(crate) fn new() -> Self {
    Self {
      directory: dirs::cache_dir()
        .map(|root| root.join(APP_DATA_DIR_NAME).join("clipboard-export")),
      active: None,
    }
  }

  pub(crate) fn publish(
    &mut self,
    png: &[u8],
    publish: impl FnOnce(&Url) -> Result<(), String>,
  ) -> Result<(), String> {
    let root = self
      .directory
      .as_ref()
      .ok_or_else(|| "clipboard export directory is unavailable".to_string())?;
    ensure_private_directory(root)?;
    let slot = self.active.map_or(0, |active| 1 - active);
    let directory = root.join(EXPORT_SLOTS[slot]);
    ensure_private_directory(&directory)?;
    let path = directory.join(EXPORT_FILENAME);
    remove_export_file(&path)?;
    let url = Url::from_file_path(&path)
      .map_err(|()| "clipboard export path is invalid".to_string())?;
    let write = (|| {
      let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|error| {
          format!("clipboard image export could not be created: {error}")
        })?;
      file
        .write_all(png)
        .map_err(|error| format!("clipboard image export failed: {error}"))?;
      publish(&url)
    })();
    if let Err(error) = write {
      if let Err(cleanup) = remove_export_file(&path) {
        tracing::warn!(error = %cleanup, "failed clipboard export cleanup will be retried");
      }
      return Err(error);
    }
    self.active = Some(slot);
    // Publishing already succeeded. Cleanup must not report the copy as failed;
    // a failed removal is retried before that fixed slot can be reused.
    let previous = root.join(EXPORT_SLOTS[1 - slot]);
    let cleanup = private_directory_exists(&previous).and_then(|exists| {
      if exists {
        remove_export_file(&previous.join(EXPORT_FILENAME))?;
      }
      Ok(())
    });
    if let Err(error) = cleanup {
      tracing::warn!(error = %error, "previous clipboard export cleanup will be retried");
    }
    Ok(())
  }

  /// The pasteboard outlives this process. Keep only its referenced fixed slot,
  /// including across restarts; never adopt or remove a path outside our slots.
  pub(crate) fn reconcile(
    &mut self,
    clipboard_file: Option<&Path>,
  ) -> Result<(), String> {
    let Some(root) = &self.directory else {
      return Ok(());
    };
    if !private_directory_exists(root)? {
      return Ok(());
    }
    self.active = EXPORT_SLOTS.iter().position(|slot| {
      clipboard_file == Some(root.join(slot).join(EXPORT_FILENAME).as_path())
    });
    let mut result = Ok(());
    for (index, slot) in EXPORT_SLOTS.iter().enumerate() {
      if self.active == Some(index) {
        continue;
      }
      let directory = root.join(slot);
      let cleanup = private_directory_exists(&directory).and_then(|exists| {
        if exists {
          remove_export_file(&directory.join(EXPORT_FILENAME))?;
        }
        Ok(())
      });
      if let Err(error) = cleanup {
        result = Err(error);
      }
    }
    result
  }
}

fn private_directory_exists(path: &Path) -> Result<bool, String> {
  match fs::symlink_metadata(path) {
    Ok(metadata) => {
      if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("clipboard export directory is not private".to_string());
      }
      Ok(true)
    }
    Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
    Err(error) => Err(format!(
      "clipboard export directory is unavailable: {error}"
    )),
  }
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
  if private_directory_exists(path)? {
    return Ok(());
  }
  fs::DirBuilder::new()
    .recursive(true)
    .mode(0o700)
    .create(path)
    .map_err(|error| {
      format!("clipboard export directory could not be created: {error}")
    })?;
  private_directory_exists(path)?;
  Ok(())
}

fn remove_export_file(path: &Path) -> Result<(), String> {
  match fs::symlink_metadata(path) {
    Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(path)
      .map_err(|error| format!("clipboard image export could not be removed: {error}")),
    Ok(_) => Err("clipboard image export is not a regular file".to_string()),
    Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
    Err(error) => Err(format!(
      "clipboard image export could not be inspected: {error}"
    )),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{os::unix::fs::symlink, process::Command};

  const CONSTRUCTOR_CHILD_ENV: &str = "STELLA_CLIPBOARD_EXPORT_CONSTRUCTOR_CHILD";

  struct TestDirectory {
    path: PathBuf,
  }

  impl TestDirectory {
    fn new() -> Self {
      let path = std::env::temp_dir().join(format!(
        "stella-clipboard-export-test-{}",
        uuid::Uuid::new_v4()
      ));
      create_private_directory(&path);
      Self { path }
    }

    fn export_root(&self) -> PathBuf {
      self.path.join("export")
    }
  }

  impl Drop for TestDirectory {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.path);
    }
  }

  fn create_private_directory(path: &Path) {
    fs::DirBuilder::new()
      .recursive(true)
      .mode(0o700)
      .create(path)
      .unwrap();
  }

  fn create_private_file(path: &Path, bytes: &[u8]) {
    let mut file = fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .mode(0o600)
      .open(path)
      .unwrap();
    file.write_all(bytes).unwrap();
  }

  fn exports_at(root: &Path) -> ClipboardImageExports {
    ClipboardImageExports {
      directory: Some(root.to_path_buf()),
      active: None,
    }
  }

  fn export_path(root: &Path, slot: usize) -> PathBuf {
    root.join(EXPORT_SLOTS[slot]).join(EXPORT_FILENAME)
  }

  fn existing_export_paths(root: &Path) -> Vec<PathBuf> {
    EXPORT_SLOTS
      .iter()
      .map(|slot| root.join(slot).join(EXPORT_FILENAME))
      .filter(|path| path.is_file())
      .collect()
  }

  #[test]
  fn constructing_exports_creates_no_files() {
    if std::env::var_os(CONSTRUCTOR_CHILD_ENV).is_some() {
      let expected = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap()
        .join("Library/Caches")
        .join(APP_DATA_DIR_NAME)
        .join("clipboard-export");

      let exports = ClipboardImageExports::new();

      assert_eq!(exports.directory.as_deref(), Some(expected.as_path()));
      assert!(!expected.exists());
      return;
    }

    let sandbox = TestDirectory::new();
    let output = Command::new(std::env::current_exe().unwrap())
      .args([
        "--exact",
        "clipboard_image_export::tests::constructing_exports_creates_no_files",
      ])
      .env(CONSTRUCTOR_CHILD_ENV, "1")
      .env("HOME", &sandbox.path)
      .output()
      .unwrap();

    assert!(
      output.status.success(),
      "constructor child failed: {}",
      String::from_utf8_lossy(&output.stderr)
    );
  }

  #[test]
  fn publishing_exposes_the_complete_file_to_the_callback() {
    let sandbox = TestDirectory::new();
    let root = sandbox.export_root();
    let mut exports = exports_at(&root);
    let png = b"complete png payload";
    let mut published_url = None;

    exports
      .publish(png, |url| {
        let path = url
          .to_file_path()
          .map_err(|()| "published URL was not a file".to_string())?;
        assert_eq!(path, export_path(&root, 0));
        assert_eq!(fs::read(path).unwrap(), png);
        published_url = Some(url.clone());
        Ok(())
      })
      .unwrap();

    assert_eq!(exports.active, Some(0));
    assert_eq!(
      published_url.unwrap().to_file_path().unwrap(),
      export_path(&root, 0)
    );
  }

  #[test]
  fn published_directories_and_files_are_private() {
    let sandbox = TestDirectory::new();
    let root = sandbox.export_root();
    let mut exports = exports_at(&root);

    exports.publish(b"png", |_| Ok(())).unwrap();

    assert_eq!(
      fs::metadata(&root).unwrap().permissions().mode() & 0o777,
      0o700
    );
    assert_eq!(
      fs::metadata(root.join(EXPORT_SLOTS[0]))
        .unwrap()
        .permissions()
        .mode()
        & 0o777,
      0o700
    );
    assert_eq!(
      fs::metadata(export_path(&root, 0))
        .unwrap()
        .permissions()
        .mode()
        & 0o777,
      0o600
    );
  }

  #[test]
  fn successful_replacement_keeps_the_previous_file_until_publication() {
    let sandbox = TestDirectory::new();
    let root = sandbox.export_root();
    let mut exports = exports_at(&root);
    let previous_path = export_path(&root, 0);
    let replacement_path = export_path(&root, 1);
    exports.publish(b"previous", |_| Ok(())).unwrap();

    exports
      .publish(b"replacement", |url| {
        assert_eq!(fs::read(&previous_path).unwrap(), b"previous");
        assert_eq!(url.to_file_path().unwrap(), replacement_path);
        assert_eq!(fs::read(&replacement_path).unwrap(), b"replacement");
        Ok(())
      })
      .unwrap();

    assert!(!previous_path.exists());
    assert_eq!(fs::read(replacement_path).unwrap(), b"replacement");
    assert_eq!(exports.active, Some(1));
  }

  #[test]
  fn failed_replacement_retains_the_previous_file_and_removes_the_candidate() {
    let sandbox = TestDirectory::new();
    let root = sandbox.export_root();
    let mut exports = exports_at(&root);
    let previous_path = export_path(&root, 0);
    let candidate_path = export_path(&root, 1);
    exports.publish(b"previous", |_| Ok(())).unwrap();

    assert_eq!(
      exports.publish(b"candidate", |url| {
        assert_eq!(fs::read(&previous_path).unwrap(), b"previous");
        assert_eq!(url.to_file_path().unwrap(), candidate_path);
        assert_eq!(fs::read(&candidate_path).unwrap(), b"candidate");
        Err("publication rejected".to_string())
      }),
      Err("publication rejected".to_string())
    );

    assert_eq!(fs::read(previous_path).unwrap(), b"previous");
    assert!(!candidate_path.exists());
    assert_eq!(exports.active, Some(0));
  }

  #[test]
  fn startup_cleanup_removes_both_fixed_slots_without_active_state() {
    let sandbox = TestDirectory::new();
    let root = sandbox.export_root();
    create_private_directory(&root);
    for (slot_index, slot) in EXPORT_SLOTS.iter().enumerate() {
      create_private_directory(&root.join(slot));
      create_private_file(&export_path(&root, slot_index), b"stale");
    }
    let mut exports = exports_at(&root);

    exports.reconcile(None).unwrap();

    assert!(existing_export_paths(&root).is_empty());
    assert_eq!(exports.active, None);
  }

  #[test]
  fn repeated_publication_never_exceeds_the_two_fixed_files() {
    let sandbox = TestDirectory::new();
    let root = sandbox.export_root();
    let mut exports = exports_at(&root);

    for index in 0..64 {
      let payload = format!("png-{index}");
      exports
        .publish(payload.as_bytes(), |_| {
          assert!(existing_export_paths(&root).len() <= EXPORT_SLOTS.len());
          Ok(())
        })
        .unwrap();
      let paths = existing_export_paths(&root);
      assert_eq!(paths.len(), 1);
      assert_eq!(fs::read(&paths[0]).unwrap(), payload.as_bytes());
    }
  }

  #[test]
  fn live_clipboard_file_survives_restarts_until_replacement() {
    for live_slot in 0..EXPORT_SLOTS.len() {
      let sandbox = TestDirectory::new();
      let root = sandbox.export_root();
      for (index, slot) in EXPORT_SLOTS.iter().enumerate() {
        create_private_directory(&root.join(slot));
        create_private_file(&export_path(&root, index), b"live");
      }
      let live_path = export_path(&root, live_slot);

      for _ in 0..3 {
        let mut restarted = exports_at(&root);
        restarted.reconcile(Some(&live_path)).unwrap();
        assert_eq!(restarted.active, Some(live_slot));
        assert_eq!(existing_export_paths(&root), vec![live_path.clone()]);
        assert_eq!(fs::read(&live_path).unwrap(), b"live");
      }

      let mut restarted = exports_at(&root);
      restarted.reconcile(Some(&live_path)).unwrap();
      assert_eq!(
        restarted.publish(b"failed replacement", |_| Err("rejected".into())),
        Err("rejected".to_string())
      );
      assert_eq!(fs::read(&live_path).unwrap(), b"live");
      restarted
        .publish(b"replacement", |url| {
          assert_ne!(url.to_file_path().unwrap(), live_path);
          assert_eq!(fs::read(&live_path).unwrap(), b"live");
          Ok(())
        })
        .unwrap();
      assert!(!live_path.exists());
      restarted.reconcile(None).unwrap();
      assert!(existing_export_paths(&root).is_empty());
    }
  }

  #[test]
  fn reconciliation_never_adopts_or_removes_an_external_clipboard_file() {
    let sandbox = TestDirectory::new();
    let root = sandbox.export_root();
    let external = sandbox.path.join("external.png");
    create_private_file(&external, b"external");
    let mut exports = exports_at(&root);
    exports.publish(b"previous", |_| Ok(())).unwrap();

    exports.reconcile(Some(&external)).unwrap();

    assert_eq!(exports.active, None);
    assert!(existing_export_paths(&root).is_empty());
    assert_eq!(fs::read(&external).unwrap(), b"external");
  }

  #[test]
  fn root_slot_and_file_symlinks_are_rejected_without_touching_their_targets() {
    for boundary in ["root", "slot", "file"] {
      let sandbox = TestDirectory::new();
      let root = sandbox.export_root();
      let external = sandbox.path.join("external");
      create_private_directory(&external);
      let sentinel = external.join("sentinel");
      create_private_file(&sentinel, b"external");

      match boundary {
        "root" => symlink(&external, &root).unwrap(),
        "slot" => {
          create_private_directory(&root);
          symlink(&external, root.join(EXPORT_SLOTS[0])).unwrap();
        }
        "file" => {
          create_private_directory(&root.join(EXPORT_SLOTS[0]));
          symlink(&sentinel, export_path(&root, 0)).unwrap();
        }
        _ => unreachable!(),
      }
      let mut exports = exports_at(&root);

      assert!(exports.publish(b"replacement", |_| Ok(())).is_err());
      assert_eq!(fs::read(&sentinel).unwrap(), b"external");
      assert_eq!(exports.active, None);
    }
  }

  #[test]
  fn an_inactive_slot_symlink_cannot_replace_an_external_file() {
    let sandbox = TestDirectory::new();
    let root = sandbox.export_root();
    let external = sandbox.path.join("external");
    create_private_directory(&external);
    let sentinel = external.join("sentinel");
    create_private_file(&sentinel, b"external");
    let mut exports = exports_at(&root);
    exports.publish(b"active", |_| Ok(())).unwrap();
    symlink(&external, root.join(EXPORT_SLOTS[1])).unwrap();

    assert!(exports.publish(b"replacement", |_| Ok(())).is_err());

    assert_eq!(fs::read(export_path(&root, 0)).unwrap(), b"active");
    assert_eq!(fs::read(sentinel).unwrap(), b"external");
    assert_eq!(exports.active, Some(0));
  }

  #[test]
  fn cleanup_continues_to_the_active_slot_after_an_invalid_slot() {
    let sandbox = TestDirectory::new();
    let root = sandbox.export_root();
    let external = sandbox.path.join("external");
    create_private_directory(&root);
    create_private_directory(&external);
    let sentinel = external.join("sentinel");
    create_private_file(&sentinel, b"external");
    symlink(&external, root.join(EXPORT_SLOTS[0])).unwrap();
    create_private_directory(&root.join(EXPORT_SLOTS[1]));
    let active_path = export_path(&root, 1);
    create_private_file(&active_path, b"active");
    let mut exports = ClipboardImageExports {
      directory: Some(root),
      active: Some(1),
    };

    assert_eq!(
      exports.reconcile(None),
      Err("clipboard export directory is not private".to_string())
    );

    assert!(!active_path.exists());
    assert_eq!(fs::read(sentinel).unwrap(), b"external");
    assert_eq!(exports.active, None);
  }
}
