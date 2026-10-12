use serde::Serialize;

use crate::marker_file::MarkerFile;

const WELCOME_MARKER_FILE_NAME: &str = "clipboard-welcome-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardWelcomeStatus {
  Completed,
  Pending,
}

pub struct ClipboardWelcome {
  marker: MarkerFile,
  status: ClipboardWelcomeStatus,
}

impl ClipboardWelcome {
  pub fn new() -> Self {
    Self::from_marker(MarkerFile::in_app_data(WELCOME_MARKER_FILE_NAME))
  }

  fn from_marker(marker: MarkerFile) -> Self {
    let status = if marker.is_set() {
      ClipboardWelcomeStatus::Completed
    } else {
      ClipboardWelcomeStatus::Pending
    };
    Self { marker, status }
  }

  pub fn complete(&mut self) -> Result<(), String> {
    if self.status == ClipboardWelcomeStatus::Completed {
      return Ok(());
    }
    self.marker.set()?;
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
  use std::{fs, path::PathBuf};

  fn welcome_at(path: PathBuf) -> ClipboardWelcome {
    ClipboardWelcome::from_marker(MarkerFile::at(path))
  }

  #[test]
  fn completing_welcome_is_persistent_and_idempotent() {
    let path = std::env::temp_dir()
      .join(format!("stella-clipboard-welcome-{}", uuid::Uuid::new_v4()));
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
}
