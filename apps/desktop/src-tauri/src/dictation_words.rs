//! The speaker's custom words: names and terms stella should spell the way
//! the speaker does, such as a client's name or an English term in Czech
//! speech. They stay on this computer, one list for each linked account, and
//! go only where dictation already sends text: with each chunk stella AI
//! transcribes, for a model that reads vocabulary, and to AI cleanup as the
//! spellings to use. The speech model on this computer takes none; without
//! cleanup, its text is spelled with them on this computer instead. Like the
//! other dictation preferences they are the speaker's data: never logged, and
//! never sent anywhere else.
//!
//! A new account's list starts with its organization's name and the
//! member's own name, each once: a speaker who removes one never gets it
//! back, because each seeding is remembered for the account apart from the
//! list.

use tauri::{AppHandle, Manager};

use crate::{
  device_preference::DevicePreference,
  feature_gate::{DesktopFeature, FeatureGates},
};

/// One file for each account, named by its local data namespace.
const FILE_PREFIX: &str = "dictation-custom-words-";
/// The only seeding there is: the organization's name.
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

/// A name an account's list starts with, each seeded once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Seed {
  OrganizationName,
  MemberName,
}

impl Seed {
  /// The file recording whether this seeding happened, one for each account.
  const fn file_prefix(self) -> &'static str {
    match self {
      Self::OrganizationName => "dictation-custom-words-seeded-",
      Self::MemberName => "dictation-custom-words-member-seeded-",
    }
  }

  fn preference(self, namespace: &str) -> DevicePreference {
    DevicePreference::in_app_data(&format!("{}{namespace}", self.file_prefix()))
  }

  /// What the seeding file holds once the seeding happened.
  const fn marker(self) -> &'static str {
    match self {
      Self::OrganizationName => "organization-name",
      Self::MemberName => "member-name",
    }
  }
}

/// The list with the name first, or none when the list already has it, has
/// no room, or the name is not a word the list takes.
fn with_seeded_name(
  words: &[String],
  name: &str,
  limits: Limits,
) -> Option<Vec<String>> {
  let Ok(Some(name)) = accepted(name, limits) else {
    return None;
  };
  if words.len() >= limits.words {
    return None;
  }
  let mut seeded = vec![name.to_string()];
  for word in words {
    push_once(&mut seeded, word);
  }
  (seeded.len() > words.len()).then_some(seeded)
}

/// Where one account's list and one of its seedings are kept.
struct SeedFiles {
  seed: Seed,
  words: DevicePreference,
  seeded: DevicePreference,
}

impl SeedFiles {
  fn for_account(seed: Seed, namespace: &str) -> Self {
    Self {
      seed,
      words: preference(namespace),
      seeded: seed.preference(namespace),
    }
  }
}

/// Puts a name into an account's list unless that seeding happened before;
/// a name the list does not take still counts as seeded. The list is written
/// before the seeding is remembered, so a failure never marks a list seeded
/// that lacks the name. Says whether the list changed.
fn seed_once(files: &SeedFiles, name: &str, limits: Limits) -> Result<bool, String> {
  if files.seeded.read_stored()?.is_some() {
    return Ok(false);
  }
  let words = match files.words.read_stored()? {
    Some(stored) => read_back(&stored, limits),
    None => Vec::new(),
  };
  let seeded = with_seeded_name(&words, name, limits);
  if let Some(seeded) = &seeded {
    let stored =
      serde_json::to_string(seeded).map_err(|_error| TOO_MANY.to_string())?;
    files.words.write(&stored)?;
  }
  files.seeded.write(files.seed.marker())?;
  Ok(seeded.is_some())
}

/// Seeds one name into the account's list; the error names a limit or a
/// file, never a word. Says whether the list changed.
fn seed_logged(files: &SeedFiles, name: &str) -> bool {
  match seed_once(files, name, crate::dictation_cloud::vocabulary_limits()) {
    Ok(changed) => changed,
    Err(error) => {
      tracing::warn!(error = %error, seed = ?files.seed, "dictation words were not seeded");
      false
    }
  }
}

/// Seeds the custom words of the linked account with the member's own name
/// and its organization's name, each once per account. The member's name is
/// the one the account was linked with; the organization's comes from the
/// registry configuration, and an API that does not send it leaves that
/// seeding for the next start.
pub fn seed_account_names(app: &AppHandle) {
  let Some(state) = app.try_state::<crate::account::AccountState>() else {
    return;
  };
  let state = std::sync::Arc::clone(&state);
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    let Ok(Some(request)) = crate::account::request_account(&state).await else {
      return;
    };
    let namespace = request.local_data_namespace();
    let member = SeedFiles::for_account(Seed::MemberName, &namespace);
    let mut changed = request
      .account
      .name
      .as_deref()
      .is_some_and(|name| seed_logged(&member, name));
    let organization = SeedFiles::for_account(Seed::OrganizationName, &namespace);
    if organization.seeded.read().is_none() {
      let config = crate::registry::request(
        request.request_auth(),
        serde_json::json!({"type":"config"}),
      )
      .await;
      drop(request);
      match config {
        Ok(config) => {
          if let Some(name) = config
            .get("organizationName")
            .and_then(serde_json::Value::as_str)
          {
            changed |= seed_logged(&organization, name);
          }
        }
        Err(error) => {
          tracing::warn!(error = %error, "dictation words were not seeded: configuration unavailable");
        }
      }
    }
    // An open settings or onboarding screen reads the list again.
    if changed {
      crate::dictation::publish(&app);
    }
  });
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

  fn seed_files() -> (std::path::PathBuf, SeedFiles) {
    let root = std::env::temp_dir()
      .join(format!("stella-dictation-seed-{}", uuid::Uuid::new_v4()));
    let files = SeedFiles {
      seed: Seed::OrganizationName,
      words: DevicePreference::at(root.join("words")),
      seeded: DevicePreference::at(root.join("seeded")),
    };
    (root, files)
  }

  /// The member seeding of the same list `files` seeds.
  fn member_files(root: &std::path::Path) -> SeedFiles {
    SeedFiles {
      seed: Seed::MemberName,
      words: DevicePreference::at(root.join("words")),
      seeded: DevicePreference::at(root.join("member-seeded")),
    }
  }

  #[test]
  fn the_member_name_is_seeded_once_even_into_a_list_seeded_before() {
    let (root, organization) = seed_files();
    assert!(seed_once(&organization, "Acme Law", LIMITS).unwrap());
    let member = member_files(&root);
    assert!(seed_once(&member, " Jan Novák ", LIMITS).unwrap());
    assert_eq!(stored(&member), list(&["Jan Novák", "Acme Law"]));
    assert_eq!(
      member.seeded.read().as_deref(),
      Some(Seed::MemberName.marker())
    );

    // The speaker removes it; neither seeding brings it back.
    member
      .words
      .write(&serde_json::to_string(&list(&["Acme Law"])).unwrap())
      .unwrap();
    assert!(!seed_once(&member, "Jan Novák", LIMITS).unwrap());
    assert!(!seed_once(&organization, "Acme Law", LIMITS).unwrap());
    assert_eq!(stored(&member), list(&["Acme Law"]));
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn each_seed_remembers_itself_in_its_own_file() {
    assert_ne!(
      Seed::OrganizationName.file_prefix(),
      Seed::MemberName.file_prefix()
    );
    assert_ne!(Seed::OrganizationName.marker(), Seed::MemberName.marker());
  }

  fn stored(files: &SeedFiles) -> Vec<String> {
    read_back(&files.words.read().unwrap_or_default(), LIMITS)
  }

  #[test]
  fn the_organization_name_is_seeded_once_and_stays_removed() {
    let (root, files) = seed_files();
    assert!(seed_once(&files, " Acme Law ", LIMITS).unwrap());
    assert_eq!(stored(&files), list(&["Acme Law"]));

    // The speaker removes it; seeding again leaves it out.
    files
      .words
      .write(&serde_json::to_string(&list(&["NDA"])).unwrap())
      .unwrap();
    assert!(!seed_once(&files, "Acme Law", LIMITS).unwrap());
    assert_eq!(stored(&files), list(&["NDA"]));
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn the_name_goes_first_counts_toward_the_limit_and_is_never_doubled() {
    let (root, files) = seed_files();
    files
      .words
      .write(&serde_json::to_string(&list(&["NDA", "acme law"])).unwrap())
      .unwrap();
    assert!(!seed_once(&files, "Acme Law", LIMITS).unwrap());
    assert_eq!(stored(&files), list(&["NDA", "acme law"]));
    std::fs::remove_dir_all(root).unwrap();

    assert_eq!(
      with_seeded_name(&list(&["a", "b"]), "Org", LIMITS),
      Some(list(&["Org", "a", "b"]))
    );
    // A full list keeps the speaker's words; the name does not push one out.
    assert_eq!(
      with_seeded_name(&list(&["a", "b", "c"]), "Org", LIMITS),
      None
    );
    // A name the list would refuse is not seeded.
    assert_eq!(with_seeded_name(&[], &"x".repeat(11), LIMITS), None);
    assert_eq!(with_seeded_name(&[], "  ", LIMITS), None);
  }

  #[test]
  fn a_name_that_cannot_be_seeded_still_counts_as_seeded() {
    let (root, files) = seed_files();
    assert!(!seed_once(&files, &"x".repeat(11), LIMITS).unwrap());
    assert_eq!(
      files.seeded.read().as_deref(),
      Some(Seed::OrganizationName.marker())
    );
    assert!(files.words.read().is_none());
    std::fs::remove_dir_all(root).unwrap();
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
