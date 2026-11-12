//! The folders local runs work in: one per chat, so what a turn leaves behind
//! is there for the next. Each is made for the user alone, and one no run has
//! used for [`KEPT_FOR_SECONDS`] is removed.
//!
//! A folder's last use is written beside it rather than inside it, where the
//! harness would see it, and rather than read from the folder's own modified
//! time, which a change deeper in the folder does not move. The checkpoints the
//! sidecar saves of a folder sit beside it too ([`checkpoint_store`]) and go
//! with it, and so do what its runs' steps produced ([`step_output_store`])
//! and the chat's cache ([`chat_cache`]): the one place a run may write
//! outside its folder, so nothing a run writes is shared with another chat.

use std::{
  collections::HashSet,
  ffi::OsString,
  path::{Path, PathBuf},
  sync::{Mutex, PoisonError},
  time::{SystemTime, UNIX_EPOCH},
};

use uuid::Uuid;

use crate::harness_sidecar::{CHECKPOINT_STORE_SUFFIX, STEP_OUTPUT_STORE_SUFFIX};

const LOG_TARGET: &str = "desktop_runner::host";
const KEPT_FOR_SECONDS: u64 = 30 * 24 * 60 * 60;
/// Beside a folder, the time of its last use in seconds.
const USED_EXTENSION: &str = "used";
/// A folder being removed, out of reach of a run that starts meanwhile.
const LEAVING_EXTENSION: &str = "leaving";

/// Beside a folder, the checkpoints the sidecar saved of it: the folder's name
/// with the suffix the sidecar protocol names.
pub(super) fn checkpoint_store(dir: &Path) -> PathBuf {
  let mut name = OsString::from(dir.as_os_str());
  name.push(CHECKPOINT_STORE_SUFFIX);
  PathBuf::from(name)
}

/// Beside a folder, what its runs' steps produced (a command's output, a
/// change's diff) and each run's output key: the folder's name with the suffix
/// the sidecar protocol names. Outside the folder, so the harness never reads
/// it back.
pub(crate) fn step_output_store(dir: &Path) -> PathBuf {
  let mut name = OsString::from(dir.as_os_str());
  name.push(STEP_OUTPUT_STORE_SUFFIX);
  PathBuf::from(name)
}

/// Beside a folder, the cache its runs' tools keep (package managers, anything
/// honouring `XDG_CACHE_HOME`). Outside the folder so checkpoints and restores
/// leave it alone, and the chat's own so no other chat reads what it holds.
const CACHE_SUFFIX: &str = ".cache";

pub(super) fn chat_cache(dir: &Path) -> PathBuf {
  let mut name = OsString::from(dir.as_os_str());
  name.push(CACHE_SUFFIX);
  PathBuf::from(name)
}

/// What sits beside a folder and goes with it.
const SIBLING_SUFFIXES: [&str; 3] = [
  CHECKPOINT_STORE_SUFFIX,
  STEP_OUTPUT_STORE_SUFFIX,
  CACHE_SUFFIX,
];

fn siblings(dir: &Path) -> [PathBuf; 3] {
  [
    checkpoint_store(dir),
    step_output_store(dir),
    chat_cache(dir),
  ]
}

/// A name the sweep removes whatever an earlier pass left of it.
fn leaving_name(path: &Path) -> PathBuf {
  let mut name = OsString::from(path.as_os_str());
  name.push(".");
  name.push(LEAVING_EXTENSION);
  PathBuf::from(name)
}

/// The folder a checkpoint store or chat cache belongs to, when `name` is one
/// of ours.
fn store_owner(folders: &Path, name: &str) -> Option<PathBuf> {
  let id = SIBLING_SUFFIXES
    .iter()
    .find_map(|suffix| name.strip_suffix(suffix))?;
  Uuid::parse_str(id).ok().map(|_| folders.join(id))
}

fn seconds(time: SystemTime) -> Option<u64> {
  time
    .duration_since(UNIX_EPOCH)
    .ok()
    .map(|since| since.as_secs())
}

/// Make the folder ready for a run and record the use. Hold the lock
/// [`remove_idle`] takes, so a folder in use is never taken away.
pub(super) fn open(dir: &Path, now: SystemTime) -> std::io::Result<()> {
  if let Some(parent) = dir.parent() {
    crate::local_store::create_private_dir(parent)?;
  }
  crate::local_store::create_private_dir(dir)?;
  crate::local_store::create_private_dir(&chat_cache(dir))?;
  crate::local_store::write_private_atomic(
    &dir.with_extension(USED_EXTENSION),
    seconds(now).unwrap_or(0).to_string().as_bytes(),
  )
  .map_err(std::io::Error::other)
}

fn is_idle(dir: &Path, now: SystemTime) -> bool {
  let recorded = std::fs::read_to_string(dir.with_extension(USED_EXTENSION))
    .ok()
    .and_then(|text| text.trim().parse::<u64>().ok());
  // A folder with no record of its use is judged by its own time.
  let last_used = recorded.or_else(|| {
    std::fs::metadata(dir)
      .and_then(|metadata| metadata.modified())
      .ok()
      .and_then(seconds)
  });
  match (last_used, seconds(now)) {
    (Some(last_used), Some(now)) => now.saturating_sub(last_used) >= KEPT_FOR_SECONDS,
    _ => false,
  }
}

fn remove_folder(dir: &Path) {
  match std::fs::remove_dir_all(dir) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => {
      tracing::warn!(target: LOG_TARGET, kind = ?error.kind(), "a run folder was not removed");
    }
  }
}

/// Move a checkpoint store or chat cache out of reach and return where it
/// went; `None` when there is none. Called under the folders lock.
fn take_store(store: &Path) -> Option<PathBuf> {
  if !std::fs::symlink_metadata(store).is_ok_and(|metadata| metadata.is_dir()) {
    return None;
  }
  let leaving = leaving_name(store);
  match crate::local_store::publish_directory(store, &leaving) {
    Ok(()) => Some(leaving),
    Err(error) => {
      tracing::warn!(target: LOG_TARGET, kind = ?error.kind(), "a run folder's checkpoints were not removed");
      None
    }
  }
}

/// The folders being restored, held while a run starts in a folder or a
/// folder is removed: neither happens to a folder in the set.
pub(super) type FolderLock = Mutex<HashSet<Uuid>>;

/// Remove the folders no run has used for too long, with their checkpoints,
/// checkpoints whose folder is gone, and anything an earlier pass left half
/// removed. Only a folder named by a UUID, and its store, are ours; one being
/// restored is left for a later pass.
pub(super) fn remove_idle(folders: &Path, now: SystemTime, lock: &FolderLock) {
  let Ok(entries) = std::fs::read_dir(folders) else {
    return;
  };
  for entry in entries.flatten() {
    let path = entry.path();
    let extension = path.extension().and_then(|extension| extension.to_str());
    if extension == Some(LEAVING_EXTENSION) {
      remove_folder(&path);
      continue;
    }
    let owner = path
      .file_name()
      .and_then(|name| name.to_str())
      .and_then(|name| store_owner(folders, name));
    if let Some(owner) = owner {
      // A store or cache outlives its folder only when an earlier pass
      // stopped between them; a folder is always made before either. One
      // whose folder is being restored stays: the restore puts the folder
      // back from its checkpoints.
      let owner_id = owner
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| Uuid::parse_str(name).ok());
      let taken = {
        let held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let restoring = owner_id.is_some_and(|id| held.contains(&id));
        let taken = if restoring || std::fs::symlink_metadata(&owner).is_ok() {
          None
        } else {
          take_store(&path)
        };
        // Held until the store is taken, so no run makes the folder between.
        drop(held);
        taken
      };
      if let Some(taken) = taken {
        remove_folder(&taken);
      }
      continue;
    }
    let folder_id = if extension.is_none() {
      path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| Uuid::parse_str(name).ok())
    } else {
      None
    };
    let Some(folder_id) = folder_id else {
      continue;
    };
    if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
      continue;
    }
    let leaving = path.with_extension(LEAVING_EXTENSION);
    // The check and the move are one step against `open`: a run starting now
    // finds its folder recorded as used, or finds no folder and makes one.
    let (moved, stores) = {
      let held = lock.lock().unwrap_or_else(PoisonError::into_inner);
      let moved = !held.contains(&folder_id)
        && is_idle(&path, now)
        && crate::local_store::publish_directory(&path, &leaving).is_ok();
      if moved {
        drop(std::fs::remove_file(path.with_extension(USED_EXTENSION)));
      }
      // Its checkpoints and cache go with it, before a run can make the
      // folder again.
      let stores: Vec<PathBuf> = if moved {
        siblings(&path)
          .iter()
          .filter_map(|sibling| take_store(sibling))
          .collect()
      } else {
        Vec::new()
      };
      // Held until the folder and what sits beside it are all out of reach.
      drop(held);
      (moved, stores)
    };
    if moved {
      remove_folder(&leaving);
    }
    for store in stores {
      remove_folder(&store);
    }
  }
}

#[cfg(test)]
#[allow(
  clippy::disallowed_methods,
  reason = "tests construct local file fixtures"
)]
mod tests {
  use std::{path::PathBuf, time::Duration};

  use super::*;

  struct Place(PathBuf);

  impl Place {
    fn new() -> Self {
      let root = std::env::temp_dir().join(format!("run-folders-{}", Uuid::new_v4()));
      std::fs::create_dir_all(&root).unwrap();
      Self(root)
    }

    fn folder(&self) -> PathBuf {
      self.0.join(Uuid::new_v4().to_string())
    }
  }

  impl Drop for Place {
    fn drop(&mut self) {
      drop(std::fs::remove_dir_all(&self.0));
    }
  }

  fn at(days: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_800_000_000 + days * 24 * 60 * 60)
  }

  #[test]
  fn a_folder_gets_its_own_cache_beside_it_and_loses_it_with_it() {
    let place = Place::new();
    let lock = Mutex::new(HashSet::new());
    let idle = place.folder();
    let recent = place.folder();
    open(&idle, at(0)).unwrap();
    open(&recent, at(10)).unwrap();
    let idle_cache = chat_cache(&idle);
    assert_eq!(
      idle_cache,
      place.0.join(format!(
        "{}.cache",
        idle.file_name().unwrap().to_string_lossy()
      ))
    );
    assert!(idle_cache.is_dir());
    assert_ne!(idle_cache, chat_cache(&recent));
    std::fs::write(idle_cache.join("left-by-a-tool"), "case data").unwrap();
    remove_idle(&place.0, at(30), &lock);
    assert!(!idle_cache.exists());
    assert!(chat_cache(&recent).is_dir());
  }

  #[test]
  fn a_folder_loses_its_step_outputs_with_it() {
    let place = Place::new();
    let lock = Mutex::new(HashSet::new());
    let idle = place.folder();
    let recent = place.folder();
    open(&idle, at(0)).unwrap();
    open(&recent, at(10)).unwrap();
    let idle_outputs = step_output_store(&idle);
    assert_eq!(
      idle_outputs,
      place.0.join(format!(
        "{}.step-outputs",
        idle.file_name().unwrap().to_string_lossy()
      ))
    );
    let run = Uuid::new_v4().to_string();
    for store in [&idle_outputs, &step_output_store(&recent)] {
      std::fs::create_dir_all(store.join(&run)).unwrap();
      std::fs::write(store.join(&run).join("step"), "output").unwrap();
    }
    let gone_outputs = step_output_store(&place.folder());
    std::fs::create_dir_all(gone_outputs.join(&run)).unwrap();
    remove_idle(&place.0, at(30), &lock);
    assert!(!idle_outputs.exists());
    assert!(!gone_outputs.exists());
    assert!(step_output_store(&recent).join(&run).join("step").is_file());
  }

  #[test]
  fn a_cache_whose_folder_is_gone_is_removed() {
    let place = Place::new();
    let lock = Mutex::new(HashSet::new());
    let gone = place.folder();
    let orphan = chat_cache(&gone);
    std::fs::create_dir_all(orphan.join("xdg")).unwrap();
    let not_ours = place.0.join("notes.cache");
    std::fs::create_dir_all(&not_ours).unwrap();
    remove_idle(&place.0, at(0), &lock);
    assert!(!orphan.exists());
    assert!(not_ours.exists());
  }

  #[test]
  fn a_folder_and_what_a_turn_left_in_it_survive_the_next_use() {
    let place = Place::new();
    let folder = place.folder();
    open(&folder, at(0)).unwrap();
    std::fs::write(folder.join("script.py"), "print(1)").unwrap();
    open(&folder, at(1)).unwrap();
    assert_eq!(
      std::fs::read_to_string(folder.join("script.py")).unwrap(),
      "print(1)"
    );
  }

  #[test]
  fn only_a_folder_idle_past_the_limit_is_removed_with_its_record() {
    let place = Place::new();
    let lock = Mutex::new(HashSet::new());
    let idle = place.folder();
    let recent = place.folder();
    open(&idle, at(0)).unwrap();
    open(&recent, at(10)).unwrap();
    remove_idle(&place.0, at(30), &lock);
    assert!(!idle.exists());
    assert!(!idle.with_extension(USED_EXTENSION).exists());
    assert!(recent.exists());
  }

  /// A checkpoint store as the sidecar lays one out.
  fn store_of(folder: &Path) -> PathBuf {
    let store = checkpoint_store(folder);
    std::fs::create_dir_all(store.join("objects").join("ab")).unwrap();
    std::fs::create_dir_all(store.join("manifests")).unwrap();
    std::fs::write(store.join("objects").join("ab").join("abcd"), "saved").unwrap();
    store
  }

  #[test]
  fn a_folder_and_its_checkpoints_are_removed_together() {
    let place = Place::new();
    let lock = Mutex::new(HashSet::new());
    let idle = place.folder();
    let recent = place.folder();
    open(&idle, at(0)).unwrap();
    open(&recent, at(10)).unwrap();
    let idle_store = store_of(&idle);
    let recent_store = store_of(&recent);
    assert_eq!(
      idle_store,
      place.0.join(format!(
        "{}.checkpoints",
        idle.file_name().unwrap().to_string_lossy()
      ))
    );
    remove_idle(&place.0, at(30), &lock);
    assert!(!idle.exists());
    assert!(!idle_store.exists());
    assert!(recent.exists());
    assert!(recent_store.exists());
    let left: Vec<_> = std::fs::read_dir(&place.0)
      .unwrap()
      .flatten()
      .map(|entry| entry.file_name())
      .collect();
    // The recent folder, its use record, its checkpoints and its cache.
    assert_eq!(left.len(), 4, "{left:?}");
  }

  #[test]
  fn checkpoints_whose_folder_is_gone_are_removed_and_others_stay() {
    let place = Place::new();
    let lock = Mutex::new(HashSet::new());
    let gone = place.folder();
    let orphan = store_of(&gone);
    let half_removed = leaving_name(&checkpoint_store(&place.folder()));
    std::fs::create_dir_all(half_removed.join("objects")).unwrap();
    let not_ours = place.0.join("notes.checkpoints");
    std::fs::create_dir_all(&not_ours).unwrap();
    remove_idle(&place.0, at(0), &lock);
    assert!(!orphan.exists());
    assert!(!half_removed.exists());
    assert!(not_ours.exists());
  }

  #[test]
  fn a_folder_being_restored_is_not_removed_with_its_checkpoints() {
    let place = Place::new();
    let idle = place.folder();
    open(&idle, at(0)).unwrap();
    let store = store_of(&idle);
    let folder_id =
      Uuid::parse_str(idle.file_name().unwrap().to_str().unwrap()).unwrap();
    let lock = Mutex::new(HashSet::from([folder_id]));
    remove_idle(&place.0, at(30), &lock);
    assert!(idle.exists());
    assert!(store.exists());
    lock.lock().unwrap().clear();
    remove_idle(&place.0, at(30), &lock);
    assert!(!idle.exists());
    assert!(!store.exists());
  }

  #[test]
  fn checkpoints_of_a_gone_folder_being_restored_stay() {
    let place = Place::new();
    let gone = place.folder();
    let store = store_of(&gone);
    let folder_id =
      Uuid::parse_str(gone.file_name().unwrap().to_str().unwrap()).unwrap();
    let lock = Mutex::new(HashSet::from([folder_id]));
    remove_idle(&place.0, at(0), &lock);
    assert!(store.exists());
    lock.lock().unwrap().clear();
    remove_idle(&place.0, at(0), &lock);
    assert!(!store.exists());
  }

  #[test]
  fn a_new_use_keeps_a_folder_past_the_limit_of_its_first() {
    let place = Place::new();
    let lock = Mutex::new(HashSet::new());
    let folder = place.folder();
    open(&folder, at(0)).unwrap();
    open(&folder, at(29)).unwrap();
    remove_idle(&place.0, at(30), &lock);
    assert!(folder.exists());
  }

  #[test]
  fn a_half_removed_folder_goes_and_anything_not_ours_stays() {
    let place = Place::new();
    let lock = Mutex::new(HashSet::new());
    let leaving = place.folder().with_extension(LEAVING_EXTENSION);
    std::fs::create_dir_all(leaving.join("left")).unwrap();
    let other = place.0.join("not-a-run-folder");
    std::fs::create_dir_all(&other).unwrap();
    remove_idle(&place.0, at(1000), &lock);
    assert!(!leaving.exists());
    assert!(other.exists());
  }

  #[test]
  fn a_folder_with_no_record_is_kept_while_its_own_time_is_recent() {
    let place = Place::new();
    let lock = Mutex::new(HashSet::new());
    let folder = place.folder();
    std::fs::create_dir_all(&folder).unwrap();
    let made = std::fs::metadata(&folder).unwrap().modified().unwrap();
    remove_idle(&place.0, made, &lock);
    assert!(folder.exists());
    remove_idle(
      &place.0,
      made + Duration::from_secs(KEPT_FOR_SECONDS + 60),
      &lock,
    );
    assert!(!folder.exists());
  }
}
