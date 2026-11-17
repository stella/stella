//! The folders of this computer a member linked for local runs: a chat can
//! then have its agent work in one of them instead of a folder stella makes.
//! The list is a device preference, kept here: a link is known elsewhere only
//! by its id and the folder's name, never by its path.
//!
//! A folder is only ever added through the native picker, and is looked at
//! again each time the list is read or a run starts in it: a folder on a
//! volume that is not mounted is `offline`, one that is gone from a mounted
//! volume (or whose path now leads elsewhere) is `moved`. A folder that holds
//! stella's own data (its run folders, the harnesses' homes and caches) or a
//! skill folder, or sits inside one, is `protected`: a run there could change
//! what runs rely on.

use std::{
  fs,
  path::{Path, PathBuf},
  sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::device_preference::DevicePreference;
use crate::runner_protocol::{FolderId, LinkedFolderReport};

/// The list is read and replaced whole, so changes to it are made one at a time.
static LIST_CHANGE: Mutex<()> = Mutex::new(());

const PREFERENCE_FILE: &str = "local-linked-folders.json";
/// As many as `hello` and `linked_folders.status` list.
const MAX_LINKS: usize = 64;
/// Characters of a folder's name a report carries; the contract takes 255
/// UTF-16 units.
const MAX_REPORTED_NAME_CHARS: usize = 120;
const LOG_TARGET: &str = "stella::local_linked_folders";

/// How a linked folder stands now, in the words the settings window, runs
/// and the runner protocol share: `offline` when its volume is not mounted,
/// `moved` when it is gone from its volume or its path leads elsewhere,
/// `protected` when it holds stella's data or a skill folder or sits inside
/// one, `unreadable` when it is there but cannot be read.
pub(crate) use crate::runner_protocol::LinkedFolderState;

/// Why a run cannot work in a linked folder: no link with the id is on this
/// computer, or its folder is not available now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkedFolderRefusal {
  Unlinked,
  Offline,
  Moved,
  Protected,
  Unreadable,
}

/// Why a folder could not be linked or the list could not be changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkedFolderListError {
  TooMany,
  NotAFolder,
  NetworkFolder,
  Protected,
  Unreadable,
  Storage,
}

/// One linked folder as the settings window shows it. The path stays in this
/// window; what leaves the computer is [`LinkedFolderReport`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFolderStatus {
  pub id: String,
  pub name: String,
  pub path: String,
  pub state: LinkedFolderState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct StoredLink {
  id: String,
  /// The real path, as [`plain_path`] writes it.
  path: String,
  name: String,
  /// The root of the volume the folder was on when it was linked: whether it
  /// is still mounted tells an offline folder from a moved one.
  volume: String,
}

/// A folder [`LinkedFolders::probe`] found fit to link, not yet linked.
pub struct LinkCandidate(StoredLink);

#[derive(Serialize, Deserialize, Default)]
struct StoredLinks {
  links: Vec<StoredLink>,
}

/// The form a path is stored and handed to the sidecar in: Windows' verbatim
/// prefix is dropped.
fn plain_path(path: &Path) -> Option<String> {
  let text = path.to_str()?;
  Some(
    text
      .strip_prefix("\\\\?\\")
      .filter(|rest| !rest.starts_with("UNC\\"))
      .unwrap_or(text)
      .to_owned(),
  )
}

/// A share by its UNC name, which a mapped drive also resolves to.
fn is_network_path(folder: &Path) -> bool {
  folder.to_str().is_some_and(|text| text.starts_with("\\\\"))
}

/// The highest folder on the way to `folder` on the same volume.
#[cfg(unix)]
fn volume_root(folder: &Path) -> PathBuf {
  use std::os::unix::fs::MetadataExt;
  let Ok(device) = fs::metadata(folder).map(|metadata| metadata.dev()) else {
    return folder.to_path_buf();
  };
  let mut root = folder.to_path_buf();
  for ancestor in folder.ancestors().skip(1) {
    match fs::metadata(ancestor) {
      Ok(metadata) if metadata.dev() == device => root = ancestor.to_path_buf(),
      _ => break,
    }
  }
  root
}

/// The drive the folder is on.
#[cfg(not(unix))]
fn volume_root(folder: &Path) -> PathBuf {
  folder
    .ancestors()
    .last()
    .map_or_else(|| folder.to_path_buf(), Path::to_path_buf)
}

/// Whether the volume whose root this was is mounted now: its root is there
/// and, short of the file system's own root, on another device than the
/// folder holding it (an unmounted volume can leave its empty mount point).
#[cfg(unix)]
fn is_mounted(root: &Path) -> bool {
  use std::os::unix::fs::MetadataExt;
  let Ok(metadata) = fs::metadata(root) else {
    return false;
  };
  let Some(parent) = root.parent() else {
    return true;
  };
  fs::metadata(parent).is_ok_and(|outer| outer.dev() != metadata.dev())
}

#[cfg(not(unix))]
fn is_mounted(root: &Path) -> bool {
  fs::metadata(root).is_ok()
}

/// What a folder is named in a chat: its own name, or a drive's root as is.
fn display_name(folder: &Path, path: &str) -> String {
  folder
    .file_name()
    .and_then(|name| name.to_str())
    .map_or_else(|| path.to_owned(), str::to_owned)
}

/// Where stella keeps what its runs rely on: each place under the app's
/// name, as named and as resolved.
fn stella_folders() -> Vec<PathBuf> {
  [
    dirs::data_dir(),
    dirs::data_local_dir(),
    dirs::config_dir(),
    dirs::cache_dir(),
  ]
  .into_iter()
  .flatten()
  .map(|base| base.join(crate::config::APP_DATA_DIR_NAME))
  .flat_map(|folder| {
    let resolved = fs::canonicalize(&folder)
      .ok()
      .as_deref()
      .and_then(plain_path)
      .map(PathBuf::from);
    std::iter::once(folder).chain(resolved)
  })
  .collect()
}

pub struct LinkedFolders {
  preference: DevicePreference,
  /// Folders no link may hold or sit in, apart from the listed skill folders.
  protected: Vec<PathBuf>,
  /// The skill folders as listed now, read when they are needed.
  skill_folders: Box<dyn Fn() -> Vec<String> + Send + Sync>,
}

impl LinkedFolders {
  /// The list as this computer keeps it, read anew on every use.
  pub fn for_this_computer() -> Self {
    Self::new(
      DevicePreference::in_app_data(PREFERENCE_FILE),
      stella_folders(),
      Box::new(|| {
        crate::local_skill_folders::SkillFolders::for_this_computer().listed()
      }),
    )
  }

  fn new(
    preference: DevicePreference,
    protected: Vec<PathBuf>,
    skill_folders: Box<dyn Fn() -> Vec<String> + Send + Sync>,
  ) -> Self {
    Self {
      preference,
      protected,
      skill_folders,
    }
  }

  /// The stored list. Nothing stored is an empty list; a list that cannot
  /// be read or parsed is a storage error, so no change ever replaces the
  /// links it holds.
  fn stored(&self) -> Result<Vec<StoredLink>, LinkedFolderListError> {
    let raw = self.preference.read_stored().map_err(|error| {
      tracing::warn!(target: LOG_TARGET, %error, "the linked folder list could not be read");
      LinkedFolderListError::Storage
    })?;
    let Some(raw) = raw else {
      return Ok(Vec::new());
    };
    serde_json::from_str::<StoredLinks>(&raw)
      .map(|stored| stored.links)
      .map_err(crate::logging::replaced_logged(
        "the linked folder list could not be parsed",
        LinkedFolderListError::Storage,
      ))
  }

  /// For reading only: a list that cannot be read lists no folder, so no
  /// run can name one in it.
  fn stored_or_none(&self) -> Vec<StoredLink> {
    self.stored().unwrap_or_default()
  }

  fn store(&self, links: Vec<StoredLink>) -> Result<(), LinkedFolderListError> {
    let raw = serde_json::to_string(&StoredLinks { links }).map_err(
      crate::logging::replaced_logged(
        "the linked folder list could not be encoded",
        LinkedFolderListError::Storage,
      ),
    )?;
    self.preference.write(&raw).map_err(|error| {
      tracing::warn!(target: LOG_TARGET, %error, "the linked folder list could not be saved");
      LinkedFolderListError::Storage
    })
  }

  /// The real paths of the linked folders, read without touching any: what a
  /// skill folder must stay out of, since runs write there.
  pub(crate) fn listed(&self) -> Vec<String> {
    self
      .stored_or_none()
      .into_iter()
      .map(|link| link.path)
      .collect()
  }

  fn is_protected(&self, folder: &Path) -> bool {
    let overlaps =
      |other: &Path| folder.starts_with(other) || other.starts_with(folder);
    self.protected.iter().any(|root| overlaps(root.as_path()))
      || (self.skill_folders)()
        .iter()
        .any(|skill| overlaps(Path::new(skill)))
  }

  fn state_of(&self, link: &StoredLink) -> LinkedFolderState {
    let folder = Path::new(&link.path);
    match fs::symlink_metadata(folder) {
      // A volume's root can leave its mount point behind when it goes:
      // a folder there is offline whatever the empty directory says.
      Ok(metadata) if metadata.file_type().is_dir() => {
        if !is_mounted(Path::new(&link.volume)) {
          return LinkedFolderState::Offline;
        }
      }
      // A link or a file where the folder was: it is somewhere else now.
      Ok(_) => return LinkedFolderState::Moved,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        return if is_mounted(Path::new(&link.volume)) {
          LinkedFolderState::Moved
        } else {
          LinkedFolderState::Offline
        };
      }
      Err(_) => return LinkedFolderState::Unreadable,
    }
    // The stored path is resolved, so a link anywhere on the way now shows.
    match fs::canonicalize(folder) {
      Ok(real) if plain_path(&real).as_deref() == Some(link.path.as_str()) => {}
      Ok(_) => return LinkedFolderState::Moved,
      Err(_) => return LinkedFolderState::Unreadable,
    }
    if self.is_protected(folder) {
      return LinkedFolderState::Protected;
    }
    if fs::read_dir(folder).is_err() {
      return LinkedFolderState::Unreadable;
    }
    LinkedFolderState::Available
  }

  /// Every link without touching its folder: what the settings window shows
  /// when a folder's mount does not answer, so that it can still be unlinked.
  pub fn unread_statuses(&self) -> Vec<LinkedFolderStatus> {
    self
      .stored_or_none()
      .into_iter()
      .map(|link| LinkedFolderStatus {
        id: link.id,
        name: link.name,
        path: link.path,
        state: LinkedFolderState::Unreadable,
      })
      .collect()
  }

  /// Every link and how its folder stands now.
  pub fn statuses(&self) -> Vec<LinkedFolderStatus> {
    self
      .stored_or_none()
      .into_iter()
      .map(|link| {
        let state = self.state_of(&link);
        LinkedFolderStatus {
          id: link.id,
          name: link.name,
          path: link.path,
          state,
        }
      })
      .collect()
  }

  /// Every link as the API knows it: id, name and state, never the path.
  pub fn reports(&self) -> Vec<LinkedFolderReport> {
    self
      .statuses()
      .into_iter()
      .filter_map(|status| {
        let id = FolderId::try_from(status.id).ok()?;
        Some(LinkedFolderReport {
          id,
          name: status.name.chars().take(MAX_REPORTED_NAME_CHARS).collect(),
          state: status.state,
        })
      })
      .collect()
  }

  /// The folder a run with the link works in, when it can work there now.
  pub fn resolve(&self, id: Uuid) -> Result<PathBuf, LinkedFolderRefusal> {
    // A list that cannot be read names no folder a run could trust.
    let link = self
      .stored()
      .map_err(|_unread| LinkedFolderRefusal::Unreadable)?
      .into_iter()
      .find(|link| Uuid::parse_str(&link.id).ok() == Some(id))
      .ok_or(LinkedFolderRefusal::Unlinked)?;
    match self.state_of(&link) {
      LinkedFolderState::Available => Ok(PathBuf::from(link.path)),
      LinkedFolderState::Offline => Err(LinkedFolderRefusal::Offline),
      LinkedFolderState::Moved => Err(LinkedFolderRefusal::Moved),
      LinkedFolderState::Protected => Err(LinkedFolderRefusal::Protected),
      LinkedFolderState::Unreadable => Err(LinkedFolderRefusal::Unreadable),
    }
  }

  /// Links a folder by its real path and answers the link's id; a folder
  /// already linked keeps its link. A link is followed only here, where the
  /// member chose it; the list then names the real folder. The app links in
  /// two steps ([`Self::probe`], then [`Self::commit`]) so that only the
  /// look is bounded; tests link in one.
  #[cfg(test)]
  pub fn add(&self, chosen: &Path) -> Result<Uuid, LinkedFolderListError> {
    let candidate = self.probe(chosen)?;
    self.commit(candidate)
  }

  /// Looks at a chosen folder (the slow part: its mount may not answer) and
  /// answers what linking it would store, changing nothing. A caller that
  /// gives up on the look never links the folder: only [`Self::commit`]
  /// does.
  pub fn probe(&self, chosen: &Path) -> Result<LinkCandidate, LinkedFolderListError> {
    if !chosen.is_absolute() {
      return Err(LinkedFolderListError::NotAFolder);
    }
    let real = fs::canonicalize(chosen)
      .ok()
      .ok_or(LinkedFolderListError::Unreadable)?;
    let path = plain_path(&real).ok_or(LinkedFolderListError::Unreadable)?;
    let folder = Path::new(&path);
    if is_network_path(folder) {
      return Err(LinkedFolderListError::NetworkFolder);
    }
    if !fs::metadata(folder).is_ok_and(|metadata| metadata.is_dir()) {
      return Err(LinkedFolderListError::NotAFolder);
    }
    if self.is_protected(folder) {
      return Err(LinkedFolderListError::Protected);
    }
    if fs::read_dir(folder).is_err() {
      return Err(LinkedFolderListError::Unreadable);
    }
    Ok(LinkCandidate(StoredLink {
      id: Uuid::new_v4().to_string(),
      name: display_name(folder, &path),
      volume: plain_path(&volume_root(folder)).unwrap_or_else(|| path.clone()),
      path,
    }))
  }

  /// Links a probed folder: only the stored list is touched, never the
  /// folder. The list is read again under the lock, so two adds never each
  /// replace it with their own copy.
  pub fn commit(
    &self,
    candidate: LinkCandidate,
  ) -> Result<Uuid, LinkedFolderListError> {
    let LinkCandidate(link) = candidate;
    let _held = LIST_CHANGE.lock().unwrap_or_else(PoisonError::into_inner);
    let mut links = self.stored()?;
    if let Some(existing) = links.iter().find(|listed| listed.path == link.path) {
      return Uuid::parse_str(&existing.id)
        .map_err(|_invalid| LinkedFolderListError::Storage);
    }
    if links.len() >= MAX_LINKS {
      return Err(LinkedFolderListError::TooMany);
    }
    let id =
      Uuid::parse_str(&link.id).map_err(|_invalid| LinkedFolderListError::Storage)?;
    links.push(link);
    self.store(links)?;
    Ok(id)
  }

  /// Unlinks a folder; the folder itself is not touched.
  pub fn remove(&self, id: &str) -> Result<(), LinkedFolderListError> {
    let _held = LIST_CHANGE.lock().unwrap_or_else(PoisonError::into_inner);
    let mut links = self.stored()?;
    links.retain(|link| link.id != id);
    self.store(links)
  }
}

#[cfg(test)]
#[allow(
  clippy::disallowed_methods,
  reason = "tests construct local file fixtures"
)]
mod tests {
  use super::*;

  struct Place {
    root: PathBuf,
  }

  impl Place {
    fn new() -> Self {
      let root =
        std::env::temp_dir().join(format!("stella-linked-folders-{}", Uuid::new_v4()));
      crate::local_store::create_private_dir(&root).unwrap();
      Self { root }
    }

    fn folders(&self) -> LinkedFolders {
      self.folders_protecting(Vec::new())
    }

    fn folders_protecting(&self, protected: Vec<PathBuf>) -> LinkedFolders {
      LinkedFolders::new(
        DevicePreference::at(self.root.join("links.json")),
        protected,
        Box::new(Vec::new),
      )
    }

    fn folder(&self, name: &str) -> PathBuf {
      let folder = self.root.join(name);
      crate::local_store::create_private_dir(&folder).unwrap();
      folder
    }

    /// A path as the list stores it.
    fn real(path: &Path) -> String {
      plain_path(&fs::canonicalize(path).unwrap()).unwrap()
    }
  }

  impl Drop for Place {
    fn drop(&mut self) {
      crate::logging::best_effort(
        fs::remove_dir_all(&self.root),
        "linked folder test directory was not removed",
      );
    }
  }

  #[test]
  fn a_linked_folder_is_named_by_its_own_name_and_a_run_resolves_it() {
    let place = Place::new();
    let folder = place.folder("Smith v Jones");
    let folders = place.folders();

    let id = folders.add(&folder).unwrap();

    let fresh = place.folders();
    assert_eq!(
      fresh.statuses(),
      vec![LinkedFolderStatus {
        id: id.to_string(),
        name: "Smith v Jones".to_owned(),
        path: Place::real(&folder),
        state: LinkedFolderState::Available,
      }]
    );
    assert_eq!(fresh.resolve(id), Ok(PathBuf::from(Place::real(&folder))));
    assert_eq!(fresh.listed(), vec![Place::real(&folder)]);
  }

  #[test]
  fn a_report_names_the_folder_and_never_its_path() {
    let place = Place::new();
    let folder = place.folder("Smith v Jones");
    let folders = place.folders();
    let id = folders.add(&folder).unwrap();

    let reports = folders.reports();

    assert_eq!(
      serde_json::to_value(&reports).unwrap(),
      serde_json::json!([{
        "id": id.to_string(),
        "name": "Smith v Jones",
        "state": "available",
      }])
    );
  }

  #[test]
  fn a_list_that_cannot_be_read_is_never_replaced_by_a_change() {
    let place = Place::new();
    let folder = place.folder("matter");
    let stored = place.root.join("links.json");
    fs::write(&stored, "{ not a list").unwrap();
    let folders = place.folders();

    assert_eq!(folders.add(&folder), Err(LinkedFolderListError::Storage));
    assert_eq!(
      folders.remove(&Uuid::new_v4().to_string()),
      Err(LinkedFolderListError::Storage)
    );
    // Reading it lists nothing, a run naming a folder in it is refused as
    // unreadable, and the stored text stays as it was.
    assert_eq!(folders.listed(), Vec::<String>::new());
    assert_eq!(
      folders.resolve(Uuid::new_v4()),
      Err(LinkedFolderRefusal::Unreadable)
    );
    assert_eq!(fs::read_to_string(&stored).unwrap(), "{ not a list");
  }

  #[test]
  fn a_probe_alone_links_nothing() {
    let place = Place::new();
    let folder = place.folder("matter");
    let folders = place.folders();

    let candidate = folders.probe(&folder).unwrap();
    assert_eq!(folders.statuses(), Vec::new());

    let id = folders.commit(candidate).unwrap();
    assert_eq!(folders.resolve(id), Ok(PathBuf::from(Place::real(&folder))));
  }

  #[test]
  fn linking_a_folder_again_keeps_its_link() {
    let place = Place::new();
    let folder = place.folder("matter");
    let folders = place.folders();

    let first = folders.add(&folder).unwrap();

    assert_eq!(folders.add(&folder), Ok(first));
    assert_eq!(folders.statuses().len(), 1);
  }

  #[test]
  fn an_unknown_link_is_refused_as_unlinked() {
    let place = Place::new();
    assert_eq!(
      place.folders().resolve(Uuid::new_v4()),
      Err(LinkedFolderRefusal::Unlinked)
    );
  }

  #[test]
  fn unlinking_leaves_the_folder_and_what_is_in_it() {
    let place = Place::new();
    let folder = place.folder("matter");
    fs::write(folder.join("brief.docx"), "draft").unwrap();
    let folders = place.folders();
    let id = folders.add(&folder).unwrap();

    folders.remove(&id.to_string()).unwrap();

    assert!(folders.statuses().is_empty());
    assert_eq!(folders.resolve(id), Err(LinkedFolderRefusal::Unlinked));
    assert_eq!(
      fs::read_to_string(folder.join("brief.docx")).unwrap(),
      "draft"
    );
  }

  #[test]
  fn a_folder_gone_from_a_mounted_volume_is_moved() {
    let place = Place::new();
    let folder = place.folder("matter");
    let folders = place.folders();
    let id = folders.add(&folder).unwrap();

    fs::rename(&folder, place.root.join("matter, closed")).unwrap();

    assert_eq!(folders.resolve(id), Err(LinkedFolderRefusal::Moved));
  }

  #[test]
  fn a_folder_whose_volume_is_gone_is_offline() {
    let place = Place::new();
    let gone = place.root.join("unmounted-volume");
    let link = StoredLink {
      id: Uuid::new_v4().to_string(),
      path: gone.join("matter").to_str().unwrap().to_owned(),
      name: "matter".to_owned(),
      volume: gone.to_str().unwrap().to_owned(),
    };
    let folders = place.folders();
    folders.store(vec![link.clone()]).unwrap();

    assert_eq!(folders.statuses()[0].state, LinkedFolderState::Offline);
    assert_eq!(
      folders.resolve(Uuid::parse_str(&link.id).unwrap()),
      Err(LinkedFolderRefusal::Offline)
    );
  }

  #[test]
  fn a_mount_point_left_behind_by_an_unmounted_volume_is_offline() {
    let place = Place::new();
    // The volume's root is there, as an empty folder on the outer volume.
    let mount_point = place.folder("Volume");
    let link = StoredLink {
      id: Uuid::new_v4().to_string(),
      path: mount_point.join("matter").to_str().unwrap().to_owned(),
      name: "matter".to_owned(),
      volume: mount_point.to_str().unwrap().to_owned(),
    };
    let folders = place.folders();
    folders.store(vec![link]).unwrap();

    assert_eq!(folders.statuses()[0].state, LinkedFolderState::Offline);
  }

  #[test]
  fn stella_data_and_what_holds_it_cannot_be_linked() {
    let place = Place::new();
    let data = place.folder("app-data");
    let runs = data.join("agent-runs");
    crate::local_store::create_private_dir(&runs).unwrap();
    let folders = place.folders_protecting(vec![PathBuf::from(Place::real(&data))]);

    assert_eq!(folders.add(&runs), Err(LinkedFolderListError::Protected));
    assert_eq!(folders.add(&data), Err(LinkedFolderListError::Protected));
    assert_eq!(
      folders.add(&place.root),
      Err(LinkedFolderListError::Protected)
    );
    assert!(folders.statuses().is_empty());
  }

  #[test]
  fn a_skill_folder_inside_a_linked_one_protects_it_at_run_start() {
    let place = Place::new();
    let folder = place.folder("matter");
    let id = place.folders().add(&folder).unwrap();
    let skill = Path::new(&Place::real(&folder))
      .join("skills")
      .join("fixture-skill")
      .to_str()
      .unwrap()
      .to_owned();
    let folders = LinkedFolders::new(
      DevicePreference::at(place.root.join("links.json")),
      Vec::new(),
      Box::new(move || vec![skill.clone()]),
    );

    assert_eq!(folders.resolve(id), Err(LinkedFolderRefusal::Protected));
  }

  #[cfg(unix)]
  #[test]
  fn a_folder_replaced_by_a_link_is_moved() {
    let place = Place::new();
    let folder = place.folder("matter");
    let elsewhere = place.folder("elsewhere");
    let folders = place.folders();
    let id = folders.add(&folder).unwrap();

    fs::remove_dir(&folder).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &folder).unwrap();

    assert_eq!(folders.resolve(id), Err(LinkedFolderRefusal::Moved));
  }

  #[test]
  fn a_file_cannot_be_linked() {
    let place = Place::new();
    let file = place.root.join("notes.txt");
    fs::write(&file, "notes").unwrap();
    assert_eq!(
      place.folders().add(&file),
      Err(LinkedFolderListError::NotAFolder)
    );
  }
}
