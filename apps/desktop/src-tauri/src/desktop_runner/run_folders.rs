//! The folders local runs work in: one per chat, so what a turn leaves behind
//! is there for the next. Each is made for the user alone, and one no run has
//! used for [`KEPT_FOR_SECONDS`] is removed.
//!
//! A folder's last use is written beside it rather than inside it, where the
//! harness would see it, and rather than read from the folder's own modified
//! time, which a change deeper in the folder does not move.

use std::{
  path::Path,
  sync::{Mutex, PoisonError},
  time::{SystemTime, UNIX_EPOCH},
};

use uuid::Uuid;

const LOG_TARGET: &str = "desktop_runner::host";
const KEPT_FOR_SECONDS: u64 = 30 * 24 * 60 * 60;
/// Beside a folder, the time of its last use in seconds.
const USED_EXTENSION: &str = "used";
/// A folder being removed, out of reach of a run that starts meanwhile.
const LEAVING_EXTENSION: &str = "leaving";

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
  std::fs::write(
    dir.with_extension(USED_EXTENSION),
    seconds(now).unwrap_or(0).to_string(),
  )
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

/// Remove the folders no run has used for too long, and any an earlier pass
/// left half removed. Only a folder named by a UUID is one of ours.
pub(super) fn remove_idle(folders: &Path, now: SystemTime, lock: &Mutex<()>) {
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
    let names_a_folder = extension.is_none()
      && path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| Uuid::parse_str(name).is_ok());
    if !names_a_folder || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
      continue;
    }
    let leaving = path.with_extension(LEAVING_EXTENSION);
    // The check and the move are one step against `open`: a run starting now
    // finds its folder recorded as used, or finds no folder and makes one.
    let moved = {
      let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
      let moved = is_idle(&path, now) && std::fs::rename(&path, &leaving).is_ok();
      if moved {
        drop(std::fs::remove_file(path.with_extension(USED_EXTENSION)));
      }
      moved
    };
    if moved {
      remove_folder(&leaving);
    }
  }
}

#[cfg(test)]
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
    let lock = Mutex::new(());
    let idle = place.folder();
    let recent = place.folder();
    open(&idle, at(0)).unwrap();
    open(&recent, at(10)).unwrap();
    remove_idle(&place.0, at(30), &lock);
    assert!(!idle.exists());
    assert!(!idle.with_extension(USED_EXTENSION).exists());
    assert!(recent.exists());
  }

  #[test]
  fn a_new_use_keeps_a_folder_past_the_limit_of_its_first() {
    let place = Place::new();
    let lock = Mutex::new(());
    let folder = place.folder();
    open(&folder, at(0)).unwrap();
    open(&folder, at(29)).unwrap();
    remove_idle(&place.0, at(30), &lock);
    assert!(folder.exists());
  }

  #[test]
  fn a_half_removed_folder_goes_and_anything_not_ours_stays() {
    let place = Place::new();
    let lock = Mutex::new(());
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
    let lock = Mutex::new(());
    let folder = place.folder();
    std::fs::create_dir_all(&folder).unwrap();
    remove_idle(&place.0, SystemTime::now(), &lock);
    assert!(folder.exists());
    remove_idle(
      &place.0,
      SystemTime::now() + Duration::from_secs(KEPT_FOR_SECONDS + 60),
      &lock,
    );
    assert!(!folder.exists());
  }
}
