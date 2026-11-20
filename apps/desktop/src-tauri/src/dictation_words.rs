//! The speaker's custom words: names and terms stella should spell the way
//! the speaker does, such as a client's name or an English term in Czech
//! speech. They stay on this computer, one list for each linked account, and
//! go only where dictation already sends text: with each chunk stella AI
//! transcribes, for a model that reads vocabulary, and to AI cleanup as the
//! spellings to use. The speech model on this computer takes none; without
//! cleanup, its text is spelled with them on this computer instead. Like the
//! other dictation preferences they are the speaker's data: never logged, and
//! never sent anywhere else.

use tauri::{AppHandle, Manager};

use crate::{
  device_preference::DevicePreference,
  feature_gate::{DesktopFeature, FeatureGates},
};

/// One file for each account, named by its local data namespace.
const FILE_PREFIX: &str = "dictation-custom-words-";
const CONTROL: &str = "a custom word cannot hold a line break or a control character";
const TOO_LONG: &str = "a custom word is longer than stella AI accepts";
const TOO_MANY: &str = "there are more custom words than stella AI accepts";
const NO_ACCOUNT: &str = "custom words need a linked account";

/// How many words the list holds, and how long each may be in UTF-16 code
/// units, the way the API measures them.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
  pub words: usize,
  pub length: usize,
}

/// A word as stored: trimmed, or none for a blank one. An error names the
/// limit the word breaks, never the word.
fn accepted(word: &str, limits: Limits) -> Result<Option<&str>, &'static str> {
  let word = word.trim();
  if word.is_empty() {
    return Ok(None);
  }
  if word.chars().any(char::is_control) {
    return Err(CONTROL);
  }
  if word.encode_utf16().count() > limits.length {
    return Err(TOO_LONG);
  }
  Ok(Some(word))
}

/// Keeps `word` unless the list has it already, whatever its case; the first
/// spelling stays.
fn push_once(kept: &mut Vec<String>, word: &str) {
  let key = word.to_lowercase();
  if !kept.iter().any(|known| known.to_lowercase() == key) {
    kept.push(word.to_string());
  }
}

/// The list the speaker asked for, as stored: each word trimmed and once, in
/// order, blank ones left out. A word or a list beyond the limits is refused
/// whole, so nothing the speaker typed is dropped without a word.
pub fn normalize(
  words: &[String],
  limits: Limits,
) -> Result<Vec<String>, &'static str> {
  let mut kept = Vec::new();
  for word in words {
    if let Some(word) = accepted(word, limits)? {
      push_once(&mut kept, word);
    }
  }
  if kept.len() > limits.words {
    return Err(TOO_MANY);
  }
  Ok(kept)
}

/// A stored list read back. Whatever no longer fits the limits, or a file
/// that is not a list, is left out, so a stored list never stops a
/// dictation.
fn read_back(stored: &str, limits: Limits) -> Vec<String> {
  // A serde error is never logged: it can quote a word.
  let words: Vec<String> = serde_json::from_str(stored).unwrap_or_default();
  let mut kept = Vec::new();
  for word in &words {
    if let Ok(Some(word)) = accepted(word, limits) {
      push_once(&mut kept, word);
    }
  }
  kept.truncate(limits.words);
  kept
}

fn preference(namespace: &str) -> DevicePreference {
  DevicePreference::in_app_data(&format!("{FILE_PREFIX}{namespace}"))
}

/// The account dictation runs for, by its local data namespace.
pub(crate) fn dictation_namespace(app: &AppHandle) -> Option<String> {
  app
    .try_state::<FeatureGates>()?
    .account_binding(DesktopFeature::Dictation)
    .map(|(_, namespace)| namespace)
}

/// The custom words of the account a namespace names.
pub fn stored_for(namespace: &str) -> Vec<String> {
  preference(namespace)
    .read()
    .map(|stored| read_back(&stored, crate::dictation_cloud::vocabulary_limits()))
    .unwrap_or_default()
}

/// The custom words of the account dictation runs for; none without one.
pub fn words(app: &AppHandle) -> Vec<String> {
  dictation_namespace(app)
    .map(|namespace| stored_for(&namespace))
    .unwrap_or_default()
}

/// Stores the list for the account dictation runs for, and returns it as
/// stored.
pub fn store(app: &AppHandle, words: &[String]) -> Result<Vec<String>, String> {
  let namespace = dictation_namespace(app).ok_or(NO_ACCOUNT)?;
  let kept = normalize(words, crate::dictation_cloud::vocabulary_limits())?;
  let stored = serde_json::to_string(&kept).map_err(|_error| TOO_MANY.to_string())?;
  preference(&namespace).write(&stored)?;
  Ok(kept)
}

#[cfg(test)]
mod tests {
  use super::*;

  const LIMITS: Limits = Limits {
    words: 3,
    length: 10,
  };

  fn list(values: &[&str]) -> Vec<String> {
    values.iter().map(ToString::to_string).collect()
  }

  #[test]
  fn a_list_is_stored_trimmed_once_each_in_order() {
    assert_eq!(
      normalize(&list(&[" Libeňská ", "", "NDA", "nda", "  "]), LIMITS),
      Ok(list(&["Libeňská", "NDA"]))
    );
    assert_eq!(normalize(&[], LIMITS), Ok(Vec::new()));
  }

  #[test]
  fn a_list_beyond_the_limits_is_refused_whole() {
    assert_eq!(
      normalize(&list(&["a", "b", "c", "d"]), LIMITS),
      Err(TOO_MANY)
    );
    // The same word twice counts once.
    assert_eq!(
      normalize(&list(&["a", "b", "c", "C"]), LIMITS),
      Ok(list(&["a", "b", "c"]))
    );
    assert_eq!(
      normalize(&list(&["x".repeat(11).as_str()]), LIMITS),
      Err(TOO_LONG)
    );
    assert_eq!(normalize(&list(&["line\nbreak"]), LIMITS), Err(CONTROL));
    assert_eq!(normalize(&list(&["tab\there"]), LIMITS), Err(CONTROL));
  }

  #[test]
  fn length_is_measured_in_utf16_code_units_as_the_api_measures_it() {
    // Five emoji are five characters but ten code units.
    assert!(normalize(&list(&["😀😀😀😀😀"]), LIMITS).is_ok());
    assert_eq!(normalize(&list(&["😀😀😀😀😀😀"]), LIMITS), Err(TOO_LONG));
    assert!(normalize(&list(&["čřžýáíéůúě"]), LIMITS).is_ok());
  }

  #[test]
  fn a_stored_list_reads_back_within_the_limits_whatever_the_file_holds() {
    assert_eq!(
      read_back(
        r#"["Novák", "novák", "", "line\nbreak", "a", "b", "c"]"#,
        LIMITS
      ),
      list(&["Novák", "a", "b"])
    );
    assert!(read_back("not a list", LIMITS).is_empty());
    assert!(read_back(r#"{"words": ["Novák"]}"#, LIMITS).is_empty());
    assert!(read_back("[1, 2]", LIMITS).is_empty());
  }
}
