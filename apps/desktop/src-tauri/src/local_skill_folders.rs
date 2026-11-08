//! The skill folders a member lists for this computer's local runs. Skills can
//! be far larger than an uploaded skill may be and hold licensed texts, so they
//! stay where they are: the list is a device preference, and neither the paths
//! nor anything in the folders is ever sent to the API. Every local run on this
//! computer gets the list, handed to the harness holder when the run starts.
//!
//! A folder is looked at again each time the list is read, because it can
//! change at any moment: what no longer qualifies stays listed with the reason,
//! and is left out of runs. A folder any run may write to by default (the temp
//! directories a sandbox allows, stella's own run folders) does not qualify, and
//! neither does a network share, whose path the sidecar protocol does not take.

use std::{
  fs,
  io::Read,
  path::{Path, PathBuf},
  sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};

use crate::device_preference::DevicePreference;
use crate::harness_sidecar::SkillFolderRef;

/// The list is read and replaced whole, so changes to it are made one at a time.
static LIST_CHANGE: Mutex<()> = Mutex::new(());

const PREFERENCE_FILE: &str = "local-skill-folders.json";
const SKILL_FILE: &str = "SKILL.md";
/// As many as one run takes; see `MAX_RUN_SKILL_FOLDERS` in the sidecar protocol.
const MAX_FOLDERS: usize = 32;
const MAX_NAME_LENGTH: usize = 64;
/// Only the header is read, and a skill's body is meant to be short.
const MAX_SKILL_FILE_BYTES: u64 = 1024 * 1024;

/// Why a folder does not qualify; the settings window words each one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillFolderProblem {
  Missing,
  NotAFolder,
  NoSkillFile,
  SkillFileNotRegular,
  SkillFileTooLarge,
  Unreadable,
  NoName,
  InvalidName,
  DuplicateName,
  RunsCanWrite,
  NetworkFolder,
  /// A folder on the way to it became a link: this is another place now.
  PathChanged,
}

/// One listed folder as the settings window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFolderStatus {
  path: String,
  skill_name: Option<String>,
  problem: Option<SkillFolderProblem>,
}

/// Why a folder could not be added or the list could not be changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillFolderListError {
  TooMany,
  AlreadyListed,
  Storage,
  #[serde(untagged)]
  Folder(SkillFolderProblem),
}

#[derive(Serialize, Deserialize)]
struct StoredFolders {
  folders: Vec<String>,
}

/// The plain value of a `name:` line, without its quotes.
fn name_value(line: &str) -> Option<&str> {
  let value = line.strip_prefix("name:")?.trim();
  let unquoted = value
    .strip_prefix('"')
    .and_then(|rest| rest.strip_suffix('"'))
    .or_else(|| {
      value
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
    })
    .unwrap_or(value);
  Some(unquoted.trim())
}

/// A name Windows keeps for itself, with or without an extension.
fn is_windows_reserved(name: &str) -> bool {
  let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
  matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
    || stem
      .strip_prefix("com")
      .or_else(|| stem.strip_prefix("lpt"))
      .is_some_and(|number| {
        number.len() == 1 && number.bytes().all(|b| b.is_ascii_digit())
      })
}

/// The name a harness would know the skill by: a `name` in the header between
/// `---` lines at the top of the file. It also becomes a directory entry and
/// part of a tool name, so it stays to plain characters that mean one entry on
/// every file system a desktop runs on.
fn skill_name(contents: &str) -> Result<String, SkillFolderProblem> {
  let mut lines = contents.trim_start_matches('\u{feff}').lines();
  if lines.next().map(str::trim_end) != Some("---") {
    return Err(SkillFolderProblem::NoName);
  }
  // The header ends at its closing `---`; one that never closes is no header,
  // which the harnesses refuse to load.
  let mut header = Vec::new();
  let mut closed = false;
  for line in lines {
    if line.trim_end() == "---" {
      closed = true;
      break;
    }
    header.push(line);
  }
  if !closed {
    return Err(SkillFolderProblem::NoName);
  }
  let name = header
    .into_iter()
    .find_map(name_value)
    .ok_or(SkillFolderProblem::NoName)?;
  let plain = name.chars().enumerate().all(|(index, character)| {
    character.is_ascii_alphanumeric()
      || (index > 0 && matches!(character, '.' | '_' | '-'))
  });
  if name.is_empty() {
    return Err(SkillFolderProblem::NoName);
  }
  if name.len() > MAX_NAME_LENGTH
    || !plain
    || name.ends_with('.')
    || is_windows_reserved(name)
  {
    return Err(SkillFolderProblem::InvalidName);
  }
  Ok(name.to_owned())
}

/// The skill's name when `folder` qualifies. Nothing here follows a link: the
/// list names a real folder, and its `SKILL.md` is a real file inside it.
fn inspect_folder(folder: &Path) -> Result<String, SkillFolderProblem> {
  let meta = fs::symlink_metadata(folder)
    .ok()
    .ok_or(SkillFolderProblem::Missing)?;
  if !meta.file_type().is_dir() {
    return Err(SkillFolderProblem::NotAFolder);
  }
  // The stored path is resolved, so a link anywhere on the way now shows.
  let resolved = fs::canonicalize(folder).ok();
  if resolved.as_deref().and_then(plain_path).as_deref() != folder.to_str() {
    return Err(SkillFolderProblem::PathChanged);
  }
  let skill_file = folder.join(SKILL_FILE);
  let file_meta = fs::symlink_metadata(&skill_file)
    .ok()
    .ok_or(SkillFolderProblem::NoSkillFile)?;
  if !file_meta.file_type().is_file() {
    return Err(SkillFolderProblem::SkillFileNotRegular);
  }
  if file_meta.len() > MAX_SKILL_FILE_BYTES {
    return Err(SkillFolderProblem::SkillFileTooLarge);
  }
  // The file can grow after the size check, so the read itself is bounded.
  let mut contents = String::new();
  fs::File::open(&skill_file)
    .and_then(|file| {
      file
        .take(MAX_SKILL_FILE_BYTES + 1)
        .read_to_string(&mut contents)
    })
    .ok()
    .ok_or(SkillFolderProblem::Unreadable)?;
  if contents.len() as u64 > MAX_SKILL_FILE_BYTES {
    return Err(SkillFolderProblem::SkillFileTooLarge);
  }
  skill_name(&contents)
}

/// The form the sidecar protocol takes: Windows' verbatim prefix is dropped.
fn plain_path(path: &Path) -> Option<String> {
  let text = path.to_str()?;
  Some(
    text
      .strip_prefix(r"\\?\")
      .filter(|rest| !rest.starts_with("UNC\\"))
      .unwrap_or(text)
      .to_owned(),
  )
}

/// The folders a run can write to: stella's own and the temp directories every
/// harness sandbox leaves writable. Each is listed as named and as resolved, in
/// the form a stored folder's path takes.
fn run_writable_folders() -> Vec<PathBuf> {
  crate::desktop_runner::run_folders_on_this_computer()
    .into_iter()
    .chain([std::env::temp_dir(), PathBuf::from("/tmp")])
    .flat_map(|root| {
      let resolved = fs::canonicalize(&root)
        .ok()
        .as_deref()
        .and_then(plain_path)
        .map(PathBuf::from);
      std::iter::once(root).chain(resolved)
    })
    .collect()
}

/// A share by its UNC name, which a mapped drive also resolves to.
fn is_network_path(folder: &Path) -> bool {
  folder.to_str().is_some_and(|text| text.starts_with(r"\\"))
}

pub struct SkillFolders {
  preference: DevicePreference,
  /// Folders a run can write to, which therefore cannot hold a skill.
  run_writable: Vec<PathBuf>,
}

impl SkillFolders {
  /// The list as this computer keeps it, read anew on every use.
  pub fn for_this_computer() -> Self {
    Self::new(
      DevicePreference::in_app_data(PREFERENCE_FILE),
      run_writable_folders(),
    )
  }

  fn new(preference: DevicePreference, run_writable: Vec<PathBuf>) -> Self {
    Self {
      preference,
      run_writable,
    }
  }

  /// A stored list that cannot be read counts as empty: no folder loads, and
  /// the next change writes a good one.
  fn stored(&self) -> Vec<String> {
    self
      .preference
      .read()
      .and_then(|raw| serde_json::from_str::<StoredFolders>(&raw).ok())
      .map(|stored| stored.folders)
      .unwrap_or_default()
  }

  fn store(&self, folders: Vec<String>) -> Result<(), SkillFolderListError> {
    let raw = serde_json::to_string(&StoredFolders { folders }).map_err(
      crate::logging::replaced_logged(
        "the skill folder list could not be encoded",
        SkillFolderListError::Storage,
      ),
    )?;
    self.preference.write(&raw).map_err(|error| {
      tracing::warn!(target: "stella::local_skills", %error, "the skill folder list could not be saved");
      SkillFolderListError::Storage
    })
  }

  fn run_can_write(&self, folder: &Path) -> bool {
    self
      .run_writable
      .iter()
      .any(|root| folder.starts_with(root) || root.starts_with(folder))
  }

  fn inspect(&self, folder: &Path) -> Result<String, SkillFolderProblem> {
    if is_network_path(folder) {
      return Err(SkillFolderProblem::NetworkFolder);
    }
    if self.run_can_write(folder) {
      return Err(SkillFolderProblem::RunsCanWrite);
    }
    inspect_folder(folder)
  }

  /// Every listed folder as unreadable, without touching any: what the settings
  /// window shows when a folder's mount does not answer, so that it can still
  /// be removed.
  pub fn unread_statuses(&self) -> Vec<SkillFolderStatus> {
    self
      .stored()
      .into_iter()
      .map(|path| SkillFolderStatus {
        path,
        skill_name: None,
        problem: Some(SkillFolderProblem::Unreadable),
      })
      .collect()
  }

  /// Every listed folder and how it stands now. Of folders naming the same
  /// skill, whatever their case, the first one stays usable.
  pub fn statuses(&self) -> Vec<SkillFolderStatus> {
    let mut names = Vec::<String>::new();
    self
      .stored()
      .into_iter()
      .map(|path| {
        let inspected = self.inspect(Path::new(&path)).and_then(|name| {
          let key = name.to_ascii_lowercase();
          if names.contains(&key) {
            Err(SkillFolderProblem::DuplicateName)
          } else {
            names.push(key);
            Ok(name)
          }
        });
        match inspected {
          Ok(name) => SkillFolderStatus {
            path,
            skill_name: Some(name),
            problem: None,
          },
          Err(problem) => SkillFolderStatus {
            path,
            skill_name: None,
            problem: Some(problem),
          },
        }
      })
      .collect()
  }

  /// What a run on this computer loads: the folders that qualify right now.
  pub(crate) fn for_run(&self) -> Vec<SkillFolderRef> {
    self
      .statuses()
      .into_iter()
      .filter_map(|status| {
        Some(SkillFolderRef {
          name: status.skill_name?,
          path: status.path,
        })
      })
      .collect()
  }

  /// Lists a folder by its real path, once it qualifies. A link is followed
  /// only here, where the member chose it; the list then names the real folder.
  pub fn add(&self, chosen: &Path) -> Result<(), SkillFolderListError> {
    if !chosen.is_absolute() {
      return Err(SkillFolderListError::Folder(SkillFolderProblem::Missing));
    }
    let real = fs::canonicalize(chosen)
      .ok()
      .ok_or(SkillFolderListError::Folder(SkillFolderProblem::Missing))?;
    let path = plain_path(&real)
      .ok_or(SkillFolderListError::Folder(SkillFolderProblem::Unreadable))?;
    let name = self
      .inspect(Path::new(&path))
      .map_err(SkillFolderListError::Folder)?;
    let current = self.statuses();
    if current.len() >= MAX_FOLDERS {
      return Err(SkillFolderListError::TooMany);
    }
    if current.iter().any(|status| status.path == path) {
      return Err(SkillFolderListError::AlreadyListed);
    }
    if current.iter().any(|status| {
      status
        .skill_name
        .as_deref()
        .is_some_and(|listed| listed.eq_ignore_ascii_case(&name))
    }) {
      return Err(SkillFolderListError::Folder(
        SkillFolderProblem::DuplicateName,
      ));
    }
    // Checked again under the lock: the looks above take time, and two adds
    // must not each replace the list with their own copy.
    let _held = LIST_CHANGE.lock().unwrap_or_else(PoisonError::into_inner);
    let mut folders = self.stored();
    if folders.contains(&path) {
      return Err(SkillFolderListError::AlreadyListed);
    }
    if folders.len() >= MAX_FOLDERS {
      return Err(SkillFolderListError::TooMany);
    }
    folders.push(path);
    self.store(folders)
  }

  /// Unlists a folder; the folder itself is not touched.
  pub fn remove(&self, path: &str) -> Result<(), SkillFolderListError> {
    let _held = LIST_CHANGE.lock().unwrap_or_else(PoisonError::into_inner);
    let mut folders = self.stored();
    folders.retain(|listed| listed != path);
    self.store(folders)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  struct Place {
    root: PathBuf,
  }

  impl Place {
    fn new() -> Self {
      let root = std::env::temp_dir()
        .join(format!("stella-skill-folders-{}", uuid::Uuid::new_v4()));
      crate::local_store::create_private_dir(&root).unwrap();
      Self { root }
    }

    /// A path as the list stores it: `local_store` needs the temp directory as
    /// the system names it, and a stored folder is resolved.
    fn real(path: &Path) -> String {
      fs::canonicalize(path)
        .unwrap()
        .to_str()
        .unwrap()
        .trim_start_matches(r"\\?\")
        .to_owned()
    }

    /// The one path a list holds.
    fn real_of_listed(folders: &SkillFolders) -> String {
      folders.stored().remove(0)
    }

    fn folders(&self) -> SkillFolders {
      self.folders_with(Vec::new())
    }

    fn folders_with(&self, run_writable: Vec<PathBuf>) -> SkillFolders {
      SkillFolders::new(
        DevicePreference::at(self.root.join("list.json")),
        run_writable,
      )
    }

    /// A folder holding a `SKILL.md` with `contents`.
    fn folder_with(&self, directory: &str, contents: &str) -> PathBuf {
      let folder = self.root.join(directory);
      crate::local_store::create_private_dir(&folder).unwrap();
      crate::local_store::write_private_atomic(
        &folder.join(SKILL_FILE),
        contents.as_bytes(),
      )
      .unwrap();
      folder
    }

    fn skill(&self, name: &str) -> PathBuf {
      self.folder_with(
        name,
        &format!("---\nname: {name}\ndescription: An invented skill.\n---\nBody.\n"),
      )
    }
  }

  impl Drop for Place {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.root);
    }
  }

  fn only_problem(folders: &SkillFolders) -> Option<SkillFolderProblem> {
    folders.statuses().first().and_then(|status| status.problem)
  }

  #[test]
  fn a_listed_folder_shows_its_skill_and_reaches_runs_after_a_new_handle() {
    let place = Place::new();
    let skill = place.skill("fixture-skill");

    place.folders().add(&skill).unwrap();

    let fresh = place.folders();
    assert_eq!(
      fresh.statuses(),
      vec![SkillFolderStatus {
        path: Place::real(&skill),
        skill_name: Some("fixture-skill".to_owned()),
        problem: None,
      }]
    );
    assert_eq!(
      fresh.for_run(),
      vec![SkillFolderRef {
        name: "fixture-skill".to_owned(),
        path: Place::real(&skill),
      }]
    );
  }

  #[test]
  fn removing_a_folder_unlists_it_and_leaves_it_in_place() {
    let place = Place::new();
    let skill = place.skill("fixture-skill");
    let folders = place.folders();
    folders.add(&skill).unwrap();

    folders.remove(&Place::real(&skill)).unwrap();

    assert!(folders.statuses().is_empty());
    assert!(folders.for_run().is_empty());
    assert!(skill.join(SKILL_FILE).is_file());
  }

  #[test]
  fn a_folder_that_vanished_stays_listed_with_the_reason_and_is_left_out_of_runs() {
    let place = Place::new();
    let skill = place.skill("fixture-skill");
    let folders = place.folders();
    folders.add(&skill).unwrap();

    fs::remove_dir_all(&skill).unwrap();

    assert_eq!(only_problem(&folders), Some(SkillFolderProblem::Missing));
    assert!(folders.for_run().is_empty());
  }

  #[test]
  fn a_folder_without_a_skill_file_is_refused_with_the_reason() {
    let place = Place::new();
    let folder = place.root.join("empty");
    crate::local_store::create_private_dir(&folder).unwrap();

    assert_eq!(
      place.folders().add(&folder),
      Err(SkillFolderListError::Folder(
        SkillFolderProblem::NoSkillFile
      ))
    );
    assert!(place.folders().statuses().is_empty());
  }

  #[test]
  fn a_missing_path_or_a_relative_one_is_refused() {
    let place = Place::new();
    for chosen in [place.root.join("nothing-here"), PathBuf::from("relative")] {
      assert_eq!(
        place.folders().add(&chosen),
        Err(SkillFolderListError::Folder(SkillFolderProblem::Missing))
      );
    }
  }

  #[test]
  fn a_header_without_a_usable_name_is_refused() {
    let place = Place::new();
    for (directory, contents, problem) in [
      ("no-header", "# Just a title\n", SkillFolderProblem::NoName),
      (
        "no-name",
        "---\ndescription: x\n---\n",
        SkillFolderProblem::NoName,
      ),
      (
        "name-in-body",
        "---\ndescription: x\n---\nname: later\n",
        SkillFolderProblem::NoName,
      ),
      (
        "blank-name",
        "---\nname:\n---\n",
        SkillFolderProblem::NoName,
      ),
      (
        "traversal",
        "---\nname: ../up\n---\n",
        SkillFolderProblem::InvalidName,
      ),
      (
        "separator",
        "---\nname: a/b\n---\n",
        SkillFolderProblem::InvalidName,
      ),
      (
        "hidden",
        "---\nname: .hidden\n---\n",
        SkillFolderProblem::InvalidName,
      ),
    ] {
      let folder = place.folder_with(directory, contents);
      assert_eq!(
        place.folders().add(&folder),
        Err(SkillFolderListError::Folder(problem)),
        "{directory}"
      );
    }
  }

  #[test]
  fn a_quoted_name_and_a_leading_byte_order_mark_are_read() {
    assert_eq!(
      skill_name("\u{feff}---\r\nname: \"Quoted_1.2\"\r\n---\r\n").unwrap(),
      "Quoted_1.2"
    );
    assert_eq!(skill_name("---\nname: 'single'\n---\n").unwrap(), "single");
    assert_eq!(
      skill_name("---\nname: unclosed\n"),
      Err(SkillFolderProblem::NoName)
    );
  }

  #[test]
  fn an_oversized_skill_file_is_not_read() {
    let place = Place::new();
    let filler = "x".repeat(usize::try_from(MAX_SKILL_FILE_BYTES).unwrap() + 1);
    let folder = place.folder_with("huge", &format!("---\nname: huge\n---\n{filler}"));
    assert_eq!(
      place.folders().add(&folder),
      Err(SkillFolderListError::Folder(
        SkillFolderProblem::SkillFileTooLarge
      ))
    );
  }

  #[cfg(unix)]
  #[test]
  fn a_chosen_link_is_listed_by_its_real_folder() {
    let place = Place::new();
    let skill = place.skill("fixture-skill");
    let link = place.root.join("link-to-skill");
    std::os::unix::fs::symlink(&skill, &link).unwrap();
    let folders = place.folders();

    folders.add(&link).unwrap();

    assert_eq!(folders.for_run()[0].path, Place::real(&skill));
    assert_eq!(
      folders.add(&skill),
      Err(SkillFolderListError::AlreadyListed)
    );
  }

  #[cfg(unix)]
  #[test]
  fn a_listed_folder_replaced_by_a_link_is_left_out_of_runs() {
    let place = Place::new();
    let skill = place.skill("fixture-skill");
    let elsewhere = place.skill("elsewhere");
    let folders = place.folders();
    folders.add(&skill).unwrap();

    fs::remove_dir_all(&skill).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &skill).unwrap();

    assert_eq!(only_problem(&folders), Some(SkillFolderProblem::NotAFolder));
    assert!(folders.for_run().is_empty());
  }

  #[cfg(unix)]
  #[test]
  fn a_skill_file_that_is_a_link_is_refused() {
    let place = Place::new();
    let elsewhere = place.skill("elsewhere");
    let folder = place.root.join("linked-file");
    crate::local_store::create_private_dir(&folder).unwrap();
    std::os::unix::fs::symlink(elsewhere.join(SKILL_FILE), folder.join(SKILL_FILE))
      .unwrap();

    assert_eq!(
      place.folders().add(&folder),
      Err(SkillFolderListError::Folder(
        SkillFolderProblem::SkillFileNotRegular
      ))
    );
  }

  #[test]
  fn a_folder_runs_can_write_to_or_that_contains_one_is_refused() {
    let place = Place::new();
    let inside = place.skill("in-the-runs-folder");
    let outer = place.skill("outer");
    let runs = outer.join("runs");
    crate::local_store::create_private_dir(&runs).unwrap();
    let folders = place.folders_with(vec![
      PathBuf::from(Place::real(&inside)),
      PathBuf::from(Place::real(&runs)),
    ]);

    for chosen in [inside, outer] {
      assert_eq!(
        folders.add(&chosen),
        Err(SkillFolderListError::Folder(
          SkillFolderProblem::RunsCanWrite
        ))
      );
    }
  }

  #[test]
  fn a_network_share_is_refused_with_the_reason_and_left_out_of_runs() {
    let place = Place::new();
    crate::local_store::write_private_atomic(
      &place.root.join("list.json"),
      br#"{"folders":["\\\\?\\UNC\\server\\share\\skill","\\\\server\\share\\skill"]}"#,
    )
    .unwrap();
    let folders = place.folders();

    assert_eq!(
      folders
        .statuses()
        .iter()
        .map(|status| status.problem)
        .collect::<Vec<_>>(),
      vec![Some(SkillFolderProblem::NetworkFolder); 2]
    );
    assert!(folders.for_run().is_empty());
  }

  #[test]
  fn a_windows_verbatim_path_compares_as_the_stored_form() {
    assert_eq!(
      plain_path(Path::new(r"\\?\C:\Users\member\AppData\Local\Temp")).as_deref(),
      Some(r"C:\Users\member\AppData\Local\Temp")
    );
    assert_eq!(
      plain_path(Path::new(r"\\?\UNC\server\share")).as_deref(),
      Some(r"\\?\UNC\server\share")
    );
  }

  #[test]
  fn a_name_windows_keeps_or_would_change_is_refused_everywhere() {
    for name in ["NUL", "con", "Aux.txt", "com1", "LPT9", "foo.", "foo..."] {
      assert_eq!(
        skill_name(&format!("---\nname: {name}\n---\n")),
        Err(SkillFolderProblem::InvalidName),
        "{name}"
      );
    }
    for name in ["console", "nullable", "com-review", "lpt12", "v1.2"] {
      assert_eq!(
        skill_name(&format!("---\nname: {name}\n---\n")).as_deref(),
        Ok(name),
      );
    }
  }

  #[cfg(unix)]
  #[test]
  fn a_parent_swapped_for_a_link_is_refused_at_run_time() {
    let place = Place::new();
    let holder = place.root.join("holder");
    crate::local_store::create_private_dir(&holder).unwrap();
    let skill = holder.join("fixture-skill");
    crate::local_store::create_private_dir(&skill).unwrap();
    crate::local_store::write_private_atomic(
      &skill.join(SKILL_FILE),
      b"---\nname: fixture-skill\n---\n",
    )
    .unwrap();
    let folders = place.folders();
    folders.add(&skill).unwrap();

    let elsewhere = place.root.join("elsewhere");
    crate::local_store::create_private_dir(&elsewhere.join("fixture-skill")).unwrap();
    crate::local_store::write_private_atomic(
      &elsewhere.join("fixture-skill").join(SKILL_FILE),
      b"---\nname: fixture-skill\n---\n",
    )
    .unwrap();
    fs::remove_dir_all(&holder).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &holder).unwrap();

    assert_eq!(
      only_problem(&folders),
      Some(SkillFolderProblem::PathChanged)
    );
    assert!(folders.for_run().is_empty());
  }

  #[test]
  fn unread_statuses_list_every_folder_without_looking_at_any() {
    let place = Place::new();
    let skill = place.skill("fixture-skill");
    let folders = place.folders();
    folders.add(&skill).unwrap();
    fs::remove_dir_all(&skill).unwrap();

    assert_eq!(
      folders.unread_statuses(),
      vec![SkillFolderStatus {
        path: Place::real_of_listed(&folders),
        skill_name: None,
        problem: Some(SkillFolderProblem::Unreadable),
      }]
    );
  }

  #[test]
  fn a_name_that_differs_only_by_case_is_the_same_name() {
    let place = Place::new();
    let first = place.folder_with("one", "---\nname: Contract-Review\n---\n");
    let second = place.folder_with("two", "---\nname: contract-review\n---\n");
    let folders = place.folders();
    folders.add(&first).unwrap();

    assert_eq!(
      folders.add(&second),
      Err(SkillFolderListError::Folder(
        SkillFolderProblem::DuplicateName
      ))
    );
  }

  #[test]
  fn the_second_folder_with_a_skills_name_is_refused() {
    let place = Place::new();
    let first = place.skill("fixture-skill");
    let second = place.folder_with("copy", "---\nname: fixture-skill\n---\n");
    let folders = place.folders();
    folders.add(&first).unwrap();

    assert_eq!(
      folders.add(&second),
      Err(SkillFolderListError::Folder(
        SkillFolderProblem::DuplicateName
      ))
    );
  }

  #[test]
  fn a_list_at_its_limit_takes_no_more() {
    let place = Place::new();
    let folders = place.folders();
    for index in 0..MAX_FOLDERS {
      folders
        .add(&place.skill(&format!("skill-{index}")))
        .unwrap();
    }
    assert_eq!(
      folders.add(&place.skill("one-too-many")),
      Err(SkillFolderListError::TooMany)
    );
  }

  #[test]
  fn an_unreadable_list_counts_as_empty_and_the_next_change_replaces_it() {
    let place = Place::new();
    crate::local_store::write_private_atomic(
      &place.root.join("list.json"),
      b"not json",
    )
    .unwrap();
    let folders = place.folders();
    assert!(folders.for_run().is_empty());

    folders.add(&place.skill("fixture-skill")).unwrap();
    assert_eq!(folders.for_run().len(), 1);
  }

  #[test]
  fn problems_and_errors_serialize_as_flat_codes() {
    for (error, code) in [
      (SkillFolderListError::TooMany, "too_many"),
      (SkillFolderListError::AlreadyListed, "already_listed"),
      (SkillFolderListError::Storage, "storage"),
      (
        SkillFolderListError::Folder(SkillFolderProblem::NoSkillFile),
        "no_skill_file",
      ),
    ] {
      assert_eq!(serde_json::to_value(error).unwrap(), code);
    }
  }
}
