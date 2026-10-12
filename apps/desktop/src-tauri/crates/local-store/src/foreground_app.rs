//! App exclusions shared by local desktop stores.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

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
