use std::{
  fs,
  io::ErrorKind,
  path::{Path, PathBuf},
};

use crate::config::APP_DATA_DIR_NAME;

fn is_regular_marker(path: &Path) -> bool {
  fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

#[cfg(unix)]
fn restrict_marker_permissions(file: &fs::File) -> Result<(), String> {
  use std::os::unix::fs::PermissionsExt;

  file
    .set_permissions(fs::Permissions::from_mode(0o600))
    .map_err(|error| format!("marker file permissions failed: {error}"))
}

/// A preference stored as the presence of an empty file in the app data dir.
/// Only a regular file counts: a directory or symlink at the path is never
/// read as set and is never removed.
pub struct MarkerFile {
  path: Option<PathBuf>,
}

impl MarkerFile {
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

  pub fn is_set(&self) -> bool {
    self
      .path
      .as_ref()
      .is_some_and(|path| is_regular_marker(path))
  }

  pub fn set(&self) -> Result<(), String> {
    let path = self.path()?;
    let parent = path
      .parent()
      .ok_or_else(|| "marker file path is invalid".to_string())?;
    fs::create_dir_all(parent)
      .map_err(|error| format!("marker file directory failed: {error}"))?;

    match fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(path)
    {
      #[cfg(unix)]
      Ok(file) => restrict_marker_permissions(&file),
      #[cfg(not(unix))]
      Ok(_) => Ok(()),
      Err(error)
        if error.kind() == ErrorKind::AlreadyExists && is_regular_marker(path) =>
      {
        Ok(())
      }
      Err(error) => Err(format!("marker file write failed: {error}")),
    }
  }

  pub fn clear(&self) -> Result<(), String> {
    let path = self.path()?;
    match fs::symlink_metadata(path) {
      Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(path)
        .map_err(|error| format!("marker file removal failed: {error}")),
      Ok(_) => Err("marker file path is not a regular file".to_string()),
      Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
      Err(error) => Err(format!("marker file removal failed: {error}")),
    }
  }

  fn path(&self) -> Result<&PathBuf, String> {
    self
      .path
      .as_ref()
      .ok_or_else(|| "marker file directory is unavailable".to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn unique_path() -> PathBuf {
    std::env::temp_dir().join(format!("stella-marker-{}", uuid::Uuid::new_v4()))
  }

  #[test]
  fn setting_a_marker_is_persistent_and_idempotent() {
    let path = unique_path();
    let marker = MarkerFile::at(path.clone());
    assert!(!marker.is_set());

    marker.set().unwrap();
    marker.set().unwrap();

    assert!(marker.is_set());
    assert!(MarkerFile::at(path.clone()).is_set());

    marker.clear().unwrap();
    marker.clear().unwrap();
    assert!(!marker.is_set());
    assert!(!path.exists());
  }

  #[test]
  fn a_directory_at_the_path_is_never_a_marker() {
    let path = unique_path();
    fs::create_dir(&path).unwrap();
    let marker = MarkerFile::at(path.clone());

    assert!(!marker.is_set());
    assert!(marker.set().is_err());
    assert!(marker.clear().is_err());
    assert!(path.is_dir());

    fs::remove_dir(path).unwrap();
  }
}
