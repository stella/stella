use serde::Serialize;
use std::{fs, path::PathBuf};

use crate::config::APP_DATA_DIR_NAME;

const WELCOME_MARKER_FILE_NAME: &str = "clipboard-welcome-v1";

fn is_regular_marker(path: &std::path::Path) -> bool {
  fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

#[cfg(unix)]
fn restrict_marker_permissions(file: &fs::File) -> Result<(), String> {
  use std::os::unix::fs::PermissionsExt;

  file
    .set_permissions(fs::Permissions::from_mode(0o600))
    .map_err(|error| format!("clipboard welcome state permissions failed: {error}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardWelcomeStatus {
  Completed,
  Pending,
}

pub struct ClipboardWelcome {
  path: Option<PathBuf>,
  status: ClipboardWelcomeStatus,
}

impl ClipboardWelcome {
  pub fn new() -> Self {
    let path = dirs::data_dir().map(|data_dir| {
      data_dir
        .join(APP_DATA_DIR_NAME)
        .join(WELCOME_MARKER_FILE_NAME)
    });
    let status = if path.as_ref().is_some_and(|path| is_regular_marker(path)) {
      ClipboardWelcomeStatus::Completed
    } else {
      ClipboardWelcomeStatus::Pending
    };
    Self { path, status }
  }

  pub fn complete(&mut self) -> Result<(), String> {
    if self.status == ClipboardWelcomeStatus::Completed {
      return Ok(());
    }
    let path = self
      .path
      .as_ref()
      .ok_or_else(|| "clipboard welcome state directory is unavailable".to_string())?;
    let parent = path
      .parent()
      .ok_or_else(|| "clipboard welcome state path is invalid".to_string())?;
    fs::create_dir_all(parent)
      .map_err(|error| format!("clipboard welcome state directory failed: {error}"))?;

    match fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(path)
    {
      #[cfg(unix)]
      Ok(file) => restrict_marker_permissions(&file)?,
      #[cfg(not(unix))]
      Ok(_) => {}
      Err(error)
        if error.kind() == std::io::ErrorKind::AlreadyExists
          && is_regular_marker(path) => {}
      Err(error) => {
        return Err(format!("clipboard welcome state write failed: {error}"));
      }
    }

    self.status = ClipboardWelcomeStatus::Completed;
    Ok(())
  }

  pub fn status(&self) -> ClipboardWelcomeStatus {
    self.status
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn unique_path() -> PathBuf {
    std::env::temp_dir()
      .join(format!("stella-clipboard-welcome-{}", uuid::Uuid::new_v4()))
  }

  fn welcome_at(path: PathBuf) -> ClipboardWelcome {
    let status = if is_regular_marker(&path) {
      ClipboardWelcomeStatus::Completed
    } else {
      ClipboardWelcomeStatus::Pending
    };
    ClipboardWelcome {
      path: Some(path),
      status,
    }
  }

  #[test]
  fn completing_welcome_is_persistent_and_idempotent() {
    let path = unique_path();
    let mut welcome = welcome_at(path.clone());
    assert_eq!(welcome.status(), ClipboardWelcomeStatus::Pending);

    welcome.complete().unwrap();
    welcome.complete().unwrap();

    assert_eq!(welcome.status(), ClipboardWelcomeStatus::Completed);
    assert_eq!(
      welcome_at(path.clone()).status(),
      ClipboardWelcomeStatus::Completed
    );
    fs::remove_file(path).unwrap();
  }

  #[test]
  fn a_non_file_marker_never_silently_completes_welcome() {
    let path = unique_path();
    fs::create_dir(&path).unwrap();
    let mut welcome = welcome_at(path.clone());

    assert!(welcome.complete().is_err());
    assert_eq!(welcome.status(), ClipboardWelcomeStatus::Pending);

    fs::remove_dir(path).unwrap();
  }
}
