//! The application in the foreground, as an identifier and a display name.
//!
//! One lookup serves every local feature that attributes data to an app. It
//! never reads window titles or document names: only the app's own metadata
//! (bundle identifier and name on macOS, executable and product name on
//! Windows). Callers that also want the app icon get the handle needed for
//! it, and nothing else.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::AppHandle;

pub const MAX_APP_NAME_BYTES: usize = 128;
pub const MAX_APP_IDENTIFIER_BYTES: usize = 255;

/// An app the user chose to leave out of a local feature. Identifiers are
/// compared case-insensitively and stored lowercased.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppExclusion {
  pub identifier: String,
  pub name: String,
}

impl AppExclusion {
  pub fn new(identifier: &str, name: &str) -> Option<Self> {
    let identifier = normalized_identifier(identifier).ok()?;
    let exclusion = Self {
      identifier,
      name: name.trim().to_string(),
    };
    exclusion.is_valid().then_some(exclusion)
  }

  fn is_valid(&self) -> bool {
    !self.identifier.is_empty()
      && self.identifier.len() <= MAX_APP_IDENTIFIER_BYTES
      && self.identifier.trim() == self.identifier
      && !self.identifier.chars().any(char::is_control)
      && !self.name.trim().is_empty()
      && self.name.len() <= MAX_APP_NAME_BYTES
  }

  pub fn matches_identifier(&self, identifier: &str) -> bool {
    self.identifier == identifier.trim().to_lowercase()
  }
}

/// The comparable form of an app identifier: trimmed, bounded, free of
/// control characters and lowercased.
pub fn normalized_identifier(identifier: &str) -> Result<String, String> {
  let identifier = identifier.trim();
  if identifier.is_empty()
    || identifier.len() > MAX_APP_IDENTIFIER_BYTES
    || identifier.chars().any(char::is_control)
  {
    return Err("application identifier is invalid".to_string());
  }
  Ok(identifier.to_lowercase())
}

/// Drops invalid and duplicate exclusions, lowercases identifiers, sorts and
/// caps the list. Returns whether anything changed.
pub fn normalize_exclusions(exclusions: &mut Vec<AppExclusion>, max: usize) -> bool {
  let original = exclusions.clone();
  let mut identifiers = HashSet::new();
  exclusions.retain_mut(|exclusion| {
    if !exclusion.is_valid() {
      return false;
    }
    exclusion.identifier = exclusion.identifier.to_lowercase();
    identifiers.insert(exclusion.identifier.clone())
  });
  exclusions.sort_by(|left, right| left.identifier.cmp(&right.identifier));
  exclusions.truncate(max);
  *exclusions != original
}

pub struct ForegroundApp {
  /// Bundle identifier on macOS, executable file name on Windows.
  pub identifier: Option<String>,
  pub name: String,
  /// Where the bundle lives, for an icon lookup.
  #[cfg(target_os = "macos")]
  pub bundle_path: Option<String>,
  /// The owning process, for an icon lookup.
  #[cfg(target_os = "windows")]
  pub process_id: u32,
}

/// Trims `value` and cuts it to at most `max_bytes` on a character boundary;
/// `None` when nothing is left.
pub fn bounded_metadata(value: &str, max_bytes: usize) -> Option<String> {
  let value = value.trim();
  if value.is_empty() {
    return None;
  }
  if value.len() <= max_bytes {
    return Some(value.to_string());
  }
  let mut boundary = 0;
  for (index, character) in value.char_indices() {
    let next_boundary = index + character.len_utf8();
    if next_boundary > max_bytes {
      break;
    }
    boundary = next_boundary;
  }
  Some(value[..boundary].to_string())
}

#[cfg(target_os = "macos")]
fn current_on_main_thread() -> Option<ForegroundApp> {
  use objc2_app_kit::NSWorkspace;
  use std::path::Path;

  let application = NSWorkspace::sharedWorkspace().frontmostApplication()?;
  let bundle_path = application
    .bundleURL()
    .and_then(|url| url.path())
    .map(|path| path.to_string());
  let name = bundle_path
    .as_deref()
    .and_then(|path| {
      Path::new(path)
        .file_stem()
        .and_then(|name| name.to_str())
        .and_then(|name| bounded_metadata(name, MAX_APP_NAME_BYTES))
    })
    .or_else(|| {
      application
        .localizedName()
        .and_then(|name| bounded_metadata(&name.to_string(), MAX_APP_NAME_BYTES))
    })?;
  let identifier = application.bundleIdentifier().and_then(|bundle_id| {
    bounded_metadata(&bundle_id.to_string(), MAX_APP_IDENTIFIER_BYTES)
  });
  Some(ForegroundApp {
    identifier,
    name,
    bundle_path,
  })
}

/// AppKit answers only on the main thread, so the lookup hops there and waits
/// at most a second; `None` when the event loop is gone or busy.
#[cfg(target_os = "macos")]
pub fn current(app: &AppHandle) -> Option<ForegroundApp> {
  let (sender, receiver) = std::sync::mpsc::sync_channel(1);
  app
    .run_on_main_thread(move || {
      let _ = sender.send(current_on_main_thread());
    })
    .ok()?;
  receiver
    .recv_timeout(std::time::Duration::from_secs(1))
    .ok()?
}

#[cfg(target_os = "windows")]
fn windows_product_name(executable_path: &str) -> Option<String> {
  use winsafe::HVERSIONINFO;

  let version = HVERSIONINFO::GetFileVersionInfo(executable_path).ok()?;
  let language_and_code_page = version.langs_and_cps().ok()?.first().copied()?;
  version
    .str_val(language_and_code_page, "ProductName")
    .ok()
    .and_then(|name| bounded_metadata(&name, MAX_APP_NAME_BYTES))
}

#[cfg(target_os = "windows")]
pub fn current(_app: &AppHandle) -> Option<ForegroundApp> {
  use std::path::Path;
  use winsafe::{HPROCESS, HWND, co};

  let window = HWND::GetForegroundWindow()?;
  let (_, process_id) = window.GetWindowThreadProcessId();
  let process =
    HPROCESS::OpenProcess(co::PROCESS::QUERY_LIMITED_INFORMATION, false, process_id)
      .ok()?;
  let executable_path = process
    .QueryFullProcessImageName(co::PROCESS_NAME::WIN32)
    .ok()?;
  let executable_name = Path::new(&executable_path)
    .file_name()
    .and_then(|name| name.to_str())
    .and_then(|name| bounded_metadata(name, MAX_APP_IDENTIFIER_BYTES));
  let name = windows_product_name(&executable_path)
    .or_else(|| {
      Path::new(&executable_path)
        .file_stem()
        .and_then(|name| name.to_str())
        .and_then(|name| bounded_metadata(name, MAX_APP_NAME_BYTES))
    })
    .or_else(|| executable_name.clone())?;
  Some(ForegroundApp {
    identifier: executable_name,
    name,
    process_id,
  })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn current(_app: &AppHandle) -> Option<ForegroundApp> {
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bounded_metadata_trims_and_cuts_on_a_character_boundary() {
    assert_eq!(bounded_metadata("  ", 8), None);
    assert_eq!(bounded_metadata(" Word ", 8).as_deref(), Some("Word"));
    let value = format!("{}x", "ž".repeat(MAX_APP_NAME_BYTES));
    let bounded = bounded_metadata(&value, MAX_APP_NAME_BYTES).unwrap();
    assert!(bounded.len() <= MAX_APP_NAME_BYTES);
    assert!(bounded.chars().all(|character| character == 'ž'));
  }
}
