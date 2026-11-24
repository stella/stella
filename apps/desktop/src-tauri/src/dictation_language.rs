//! Which language a dictation is in. "Automatic" means the languages this
//! user works in on this computer (preferred languages and keyboard input
//! languages), narrowed to the ones the speech model lists; or the user picks
//! one. A chosen language, or the only inferred one, becomes the language
//! hint, which the worker passes only when the loaded model lists it. With
//! several inferred languages there is no hint: one language forced on a
//! dictation that mixes them (Czech with English terms) makes the model spell
//! the other language's words the forced language's way, while without a hint
//! it recognizes each as spoken. Cleanup always learns every language the
//! speaker uses.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine use these")
)]

use serde::Serialize;
use tauri::AppHandle;

/// The languages the pinned speech model lists in its `general.languages`
/// metadata. The model file is pinned by digest, so this list cannot drift
/// from it; the worker still checks each hint against the loaded model.
pub const MODEL_LANGUAGES: &[&str] = &[
  "en", "de", "fr", "es", "it", "pt", "ru", "uk", "hr", "sl", "lv", "lt", "et", "fi",
  "sv", "da", "nl", "pl", "cs", "sk", "hu", "ro", "bg", "el", "mt",
];

const AUTOMATIC: &str = "auto";
const ENGLISH: &str = "en";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
  Automatic,
  Language(&'static str),
}

impl Choice {
  /// The stored preference; anything unknown reads as automatic.
  pub fn parse(stored: Option<&str>) -> Self {
    stored
      .and_then(|value| {
        MODEL_LANGUAGES
          .iter()
          .copied()
          .find(|language| *language == value)
      })
      .map_or(Self::Automatic, Self::Language)
  }

  pub const fn stored(&self) -> &'static str {
    match *self {
      Self::Automatic => AUTOMATIC,
      Self::Language(language) => language,
    }
  }
}

/// The primary language of each tag the model lists, once each: languages
/// other than English first, in the order found, then English. English is
/// the default display language of many computers whose user speaks
/// something else, so it never outranks a language chosen on purpose.
pub fn infer(tags: impl IntoIterator<Item = String>) -> Vec<&'static str> {
  let mut found = Vec::new();
  for tag in tags {
    let primary = tag
      .split(['-', '_'])
      .next()
      .unwrap_or_default()
      .to_ascii_lowercase();
    if let Some(language) = MODEL_LANGUAGES
      .iter()
      .find(|language| **language == primary)
      && !found.contains(language)
    {
      found.push(*language);
    }
  }
  found.sort_by_key(|language| *language == ENGLISH);
  found
}

/// The language hint for one run: the chosen language, or with automatic
/// the only inferred language. Several inferred languages give none, so the
/// model recognizes each word in the language it was spoken in; the pinned
/// local model has no language prompt and always does. Never a language
/// outside the inferred set.
pub fn hint(choice: &Choice, inferred: &[&'static str]) -> Option<&'static str> {
  match choice {
    Choice::Language(language) => Some(*language),
    Choice::Automatic => match inferred {
      [only] => Some(*only),
      [] | [_, _, ..] => None,
    },
  }
}

/// The languages the speaker uses, for cleanup.
pub fn speaker_languages(
  choice: &Choice,
  inferred: &[&'static str],
) -> Vec<&'static str> {
  match choice {
    Choice::Language(language) => vec![*language],
    Choice::Automatic => inferred.to_vec(),
  }
}

/// Each model language in its own name, the way a language menu lists it
/// whatever the interface language.
pub const fn autonym(language: &str) -> Option<&'static str> {
  Some(match language.as_bytes() {
    b"en" => "English",
    b"de" => "Deutsch",
    b"fr" => "Français",
    b"es" => "Español",
    b"it" => "Italiano",
    b"pt" => "Português",
    b"ru" => "Русский",
    b"uk" => "Українська",
    b"hr" => "Hrvatski",
    b"sl" => "Slovenščina",
    b"lv" => "Latviešu",
    b"lt" => "Lietuvių",
    b"et" => "Eesti",
    b"fi" => "Suomi",
    b"sv" => "Svenska",
    b"da" => "Dansk",
    b"nl" => "Nederlands",
    b"pl" => "Polski",
    b"cs" => "Čeština",
    b"sk" => "Slovenčina",
    b"hu" => "Magyar",
    b"ro" => "Română",
    b"bg" => "Български",
    b"el" => "Ελληνικά",
    b"mt" => "Malti",
    _ => return None,
  })
}

/// The choices a quick switch offers: automatic, this computer's languages,
/// and the chosen language when it is none of them, once each.
pub fn quick_choices(choice: &Choice, inferred: &[&'static str]) -> Vec<Choice> {
  let mut choices = vec![Choice::Automatic];
  choices.extend(inferred.iter().copied().map(Choice::Language));
  if !choices.contains(choice) {
    choices.push(choice.clone());
  }
  choices
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSnapshot {
  choice: &'static str,
  inferred: Vec<&'static str>,
  supported: &'static [&'static str],
}

impl LanguageSnapshot {
  pub fn new(choice: &Choice, inferred: Vec<&'static str>) -> Self {
    Self {
      choice: choice.stored(),
      inferred,
      supported: MODEL_LANGUAGES,
    }
  }
}

/// The language tags this user works in on this computer.
#[cfg(target_os = "macos")]
pub fn device_tags(app: &AppHandle) -> Vec<String> {
  let mut tags = stella_desktop_macos::preferred_languages();
  // Input sources answer on the main thread only; a command already runs
  // there, the dictation thread hops over and waits at most a second.
  if let Some(main_thread) = objc2::MainThreadMarker::new() {
    tags.extend(stella_desktop_macos::keyboard_languages(main_thread));
    return tags;
  }
  let (sender, receiver) = std::sync::mpsc::sync_channel(1);
  let asked = app.run_on_main_thread(move || {
    if let Some(main_thread) = objc2::MainThreadMarker::new() {
      crate::logging::best_effort(
        sender.send(stella_desktop_macos::keyboard_languages(main_thread)),
        "keyboard language lookup had no waiter",
      );
    }
  });
  if asked.is_ok()
    && let Ok(keyboards) = receiver.recv_timeout(std::time::Duration::from_secs(1))
  {
    tags.extend(keyboards);
  }
  tags
}

#[cfg(target_os = "windows")]
pub fn device_tags(_app: &AppHandle) -> Vec<String> {
  let mut tags = stella_desktop_macos::preferred_languages();
  tags.extend(stella_desktop_macos::keyboard_languages());
  tags
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn device_tags(_app: &AppHandle) -> Vec<String> {
  Vec::new()
}

/// The inferred languages of this computer.
pub fn inferred(app: &AppHandle) -> Vec<&'static str> {
  infer(device_tags(app))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn every_model_language_has_its_own_name() {
    for language in MODEL_LANGUAGES {
      assert!(
        autonym(language).is_some_and(|name| !name.is_empty()),
        "{language}"
      );
    }
    assert_eq!(autonym("cs"), Some("Čeština"));
    assert_eq!(autonym("xx"), None);
  }

  #[test]
  fn the_quick_switch_offers_automatic_the_inferred_languages_and_the_choice() {
    assert_eq!(
      quick_choices(&Choice::Automatic, &["cs", "en"]),
      vec![
        Choice::Automatic,
        Choice::Language("cs"),
        Choice::Language("en")
      ]
    );
    assert_eq!(
      quick_choices(&Choice::Language("de"), &["cs", "en"]),
      vec![
        Choice::Automatic,
        Choice::Language("cs"),
        Choice::Language("en"),
        Choice::Language("de"),
      ]
    );
    assert_eq!(
      quick_choices(&Choice::Language("cs"), &["cs"]),
      vec![Choice::Automatic, Choice::Language("cs")]
    );
  }

  fn tags(values: &[&str]) -> Vec<String> {
    values.iter().map(ToString::to_string).collect()
  }

  #[test]
  fn an_english_display_with_a_czech_keyboard_infers_czech_then_english() {
    assert_eq!(infer(tags(&["en-CZ", "cs-CZ", "cs"])), vec!["cs", "en"]);
  }

  #[test]
  fn inference_keeps_only_model_languages_once_each() {
    assert_eq!(
      infer(tags(&["ja-JP", "sk_SK", "SK", "de-AT", "zh-Hans"])),
      vec!["sk", "de"]
    );
    assert!(infer(tags(&["ja", "", "-"])).is_empty());
  }

  #[test]
  fn automatic_hints_only_the_one_language_it_inferred() {
    assert_eq!(hint(&Choice::Automatic, &["en"]), Some("en"));
    assert_eq!(hint(&Choice::Automatic, &["cs"]), Some("cs"));
    assert_eq!(hint(&Choice::Automatic, &[]), None);
  }

  #[test]
  fn automatic_with_several_languages_hints_none_and_cleanup_gets_them_all() {
    // Czech speech with English terms: a forced Czech hint spells the
    // English words the Czech way.
    for inferred in [vec!["cs", "en"], vec!["cs", "sk"], vec!["pl", "de", "en"]] {
      assert_eq!(hint(&Choice::Automatic, &inferred), None, "{inferred:?}");
      assert_eq!(speaker_languages(&Choice::Automatic, &inferred), inferred);
    }
  }

  #[test]
  fn automatic_never_hints_a_language_outside_the_inferred_set() {
    for inferred in [vec![], vec!["en"], vec!["pl", "en"], vec!["cs", "sk"]] {
      if let Some(language) = hint(&Choice::Automatic, &inferred) {
        assert!(inferred.contains(&language), "{inferred:?}");
      }
    }
  }

  #[test]
  fn a_chosen_language_is_the_hint_and_the_speaker_language() {
    let choice = Choice::parse(Some("sk"));
    assert_eq!(choice, Choice::Language("sk"));
    assert_eq!(hint(&choice, &["cs", "en"]), Some("sk"));
    assert_eq!(speaker_languages(&choice, &["cs", "en"]), vec!["sk"]);
    assert_eq!(
      speaker_languages(&Choice::Automatic, &["cs", "en"]),
      vec!["cs", "en"]
    );
  }

  #[test]
  fn an_unknown_stored_choice_reads_as_automatic() {
    for stored in [None, Some("auto"), Some("ja"), Some(""), Some("CS")] {
      assert_eq!(Choice::parse(stored), Choice::Automatic, "{stored:?}");
    }
    assert_eq!(Choice::parse(Some("cs")).stored(), "cs");
    assert_eq!(Choice::Automatic.stored(), "auto");
  }

  #[test]
  fn model_languages_are_unique_lowercase_codes() {
    for language in MODEL_LANGUAGES {
      assert_eq!(language.len(), 2);
      assert_eq!(*language, language.to_ascii_lowercase());
      assert_eq!(
        MODEL_LANGUAGES
          .iter()
          .filter(|other| *other == language)
          .count(),
        1
      );
    }
  }
}
