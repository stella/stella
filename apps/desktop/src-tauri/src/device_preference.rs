//! A small device-level preference kept as one text file in the app data
//! directory. These values describe this computer, not an account, and hold
//! no recorded data, so they are plain text rather than encrypted stores.

use std::{
  fs,
  path::{Path, PathBuf},
};

use crate::config::APP_DATA_DIR_NAME;

pub struct DevicePreference {
  path: Option<PathBuf>,
}

impl DevicePreference {
  pub fn in_app_data(file_name: &str) -> Self {
    Self {
      path: dirs::data_dir()
        .map(|data_dir| data_dir.join(APP_DATA_DIR_NAME).join(file_name)),
    }
  }

  #[cfg(test)]
  pub fn at(path: PathBuf) -> Self {
    Self { path: Some(path) }
  }

  /// The trimmed contents, or `None` when nothing usable is stored. Only a
  /// regular file counts: a directory or a symlink at the path is never read.
  pub fn read(&self) -> Option<String> {
    let path = self.path.as_deref()?;
    if !fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file()) {
      return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    let value = raw.trim();
    (!value.is_empty()).then(|| value.to_string())
  }

  /// Writes only on a change, so start-up reconciliation never touches the
  /// disk when nothing changed.
  pub fn write(&self, value: &str) -> Result<(), String> {
    let path = self
      .path
      .as_deref()
      .ok_or_else(|| "app data directory is unavailable".to_string())?;
    if self.read().as_deref() == Some(value) {
      return Ok(());
    }
    write_atomically(path, value)
  }
}

fn write_atomically(path: &Path, value: &str) -> Result<(), String> {
  match fs::symlink_metadata(path) {
    Ok(meta) if !meta.file_type().is_file() => {
      return Err("preference path is not a regular file".to_string());
    }
    _ => {}
  }

  let parent = path
    .parent()
    .ok_or_else(|| "preference path is invalid".to_string())?;
  crate::local_store::create_private_dir(parent)
    .map_err(|error| format!("preference directory failed: {error}"))?;
  crate::local_store::write_private_atomic(path, value.as_bytes())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_path(name: &str) -> PathBuf {
    std::env::temp_dir()
      .join(format!("stella-preference-{}", uuid::Uuid::new_v4()))
      .join(name)
  }

  #[test]
  fn a_written_value_reads_back_trimmed_and_survives_a_new_handle() {
    let path = temp_path("value");
    let preference = DevicePreference::at(path.clone());
    assert_eq!(preference.read(), None);

    preference.write("shift+super+KeyV").unwrap();

    assert_eq!(
      DevicePreference::at(path.clone()).read().as_deref(),
      Some("shift+super+KeyV")
    );
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn a_directory_at_the_path_is_neither_read_nor_replaced() {
    let path = temp_path("value");
    crate::local_store::create_private_dir(&path).unwrap();
    let preference = DevicePreference::at(path.clone());

    assert_eq!(preference.read(), None);
    assert!(preference.write("x").is_err());
    assert!(path.is_dir());
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }
}
