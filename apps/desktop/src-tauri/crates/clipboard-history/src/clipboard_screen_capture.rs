use serde::{Deserialize, Serialize};

use crate::marker_file::MarkerFile;

const SCREEN_CAPTURE_MARKER_FILE_NAME: &str = "clipboard-screen-capture-visible-v1";

/// Whether the clipboard windows appear in screenshots and screen recordings.
/// Hidden is the default; the preference lives in a marker file, so it holds
/// even when clipboard history cannot be persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardScreenCapture {
  Hidden,
  Visible,
}

pub struct ClipboardScreenCapturePreference {
  marker: MarkerFile,
  capture: ClipboardScreenCapture,
}

impl ClipboardScreenCapturePreference {
  pub fn new() -> Self {
    Self::from_marker(MarkerFile::in_app_data(SCREEN_CAPTURE_MARKER_FILE_NAME))
  }

  fn from_marker(marker: MarkerFile) -> Self {
    let capture = if marker.is_set() {
      ClipboardScreenCapture::Visible
    } else {
      ClipboardScreenCapture::Hidden
    };
    Self { marker, capture }
  }

  pub fn capture(&self) -> ClipboardScreenCapture {
    self.capture
  }

  pub fn set(&mut self, capture: ClipboardScreenCapture) -> Result<(), String> {
    match capture {
      ClipboardScreenCapture::Visible => self.marker.set()?,
      ClipboardScreenCapture::Hidden => self.marker.clear()?,
    }
    self.capture = capture;
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn preference_at(path: PathBuf) -> ClipboardScreenCapturePreference {
    ClipboardScreenCapturePreference::from_marker(MarkerFile::at(path))
  }

  #[test]
  fn screen_capture_visibility_survives_a_restart() {
    let path = std::env::temp_dir().join(format!(
      "stella-clipboard-screen-capture-{}",
      uuid::Uuid::new_v4()
    ));
    let mut preference = preference_at(path.clone());
    assert_eq!(preference.capture(), ClipboardScreenCapture::Hidden);

    preference.set(ClipboardScreenCapture::Visible).unwrap();
    assert_eq!(preference.capture(), ClipboardScreenCapture::Visible);
    assert_eq!(
      preference_at(path.clone()).capture(),
      ClipboardScreenCapture::Visible
    );

    preference.set(ClipboardScreenCapture::Hidden).unwrap();
    assert_eq!(
      preference_at(path.clone()).capture(),
      ClipboardScreenCapture::Hidden
    );
    assert!(!path.exists());
  }
}
