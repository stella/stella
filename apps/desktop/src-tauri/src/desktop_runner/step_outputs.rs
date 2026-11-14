//! What a run's steps produced on this computer (a command's output, a
//! change's diff), kept beside the chat's own folder in its step output store
//! ([`run_folders::step_output_store`]), also for a run in a folder the member
//! linked: one directory per run, holding the run's output key, written here
//! when the run starts, and one file per step, written by the sidecar where
//! `run.start` names. The bridge reads them for a page on this computer;
//! nothing here leaves it, and it goes with the chat's folder.

use std::path::{Path, PathBuf};

use uuid::Uuid;

use super::run_folders::{self, STEP_OUTPUT_STORE_SUFFIX};

const KEY_FILE: &str = "key";
const KEY_HEX_LENGTH: usize = 64;

/// A run's output key or a step's key: 64 lowercase hex characters.
pub(crate) fn is_hex_key(value: &str) -> bool {
  value.len() == KEY_HEX_LENGTH
    && value
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Keep `run_id`'s output key in the step output store of `chat_folder`, the
/// chat's own folder (never a linked one), so the bridge can check a page's
/// grant for the run after the run has ended.
pub(super) fn keep_key(
  chat_folder: &Path,
  run_id: &str,
  key: &str,
) -> Result<(), String> {
  let run = Uuid::parse_str(run_id).map_err(|_not_uuid| "a run id names no run")?;
  if !is_hex_key(key) {
    return Err("a run's output key is not one".into());
  }
  let dir = run_folders::step_output_store(chat_folder).join(run.to_string());
  crate::local_store::create_private_dir(&dir).map_err(|error| error.to_string())?;
  crate::local_store::write_private_atomic(&dir.join(KEY_FILE), key.as_bytes())
}

/// Where a run's steps are kept, found by its id among the stores beside the
/// folders in `folders`; `None` when this computer holds no key for the run.
pub(crate) fn run_dir(folders: &Path, run_id: Uuid) -> Option<PathBuf> {
  let run = run_id.to_string();
  std::fs::read_dir(folders)
    .ok()?
    .flatten()
    .filter(|entry| {
      entry
        .file_name()
        .to_str()
        .and_then(|name| name.strip_suffix(STEP_OUTPUT_STORE_SUFFIX))
        .is_some_and(|folder| Uuid::parse_str(folder).is_ok())
    })
    .map(|entry| entry.path().join(&run))
    .find(|dir| {
      std::fs::symlink_metadata(dir.join(KEY_FILE)).is_ok_and(|meta| meta.is_file())
    })
}

/// The run's output key, as kept when it started.
pub(crate) fn read_key(run_dir: &Path) -> Option<zeroize::Zeroizing<String>> {
  let key =
    zeroize::Zeroizing::new(std::fs::read_to_string(run_dir.join(KEY_FILE)).ok()?);
  is_hex_key(&key).then_some(key)
}

/// The file one step is kept in; `step_key` is checked to be one first.
pub(crate) fn step_file(run_dir: &Path, step_key: &str) -> Option<PathBuf> {
  is_hex_key(step_key).then(|| run_dir.join(step_key))
}

#[cfg(test)]
#[allow(
  clippy::disallowed_methods,
  reason = "tests construct local file fixtures"
)]
mod tests {
  use super::*;

  #[test]
  fn a_kept_key_is_found_by_its_run_among_the_folders() {
    let folders = std::env::temp_dir().join(format!("step-outputs-{}", Uuid::new_v4()));
    let folder = folders.join(Uuid::new_v4().to_string());
    let run = Uuid::new_v4();
    let key = "ab".repeat(32);
    keep_key(&folder, &run.to_string(), &key).unwrap();
    let dir = run_dir(&folders, run).unwrap();
    assert_eq!(
      read_key(&dir).as_deref().map(String::as_str),
      Some(key.as_str())
    );
    assert!(run_dir(&folders, Uuid::new_v4()).is_none());
    assert!(keep_key(&folder, "not-a-run", &key).is_err());
    assert!(keep_key(&folder, &run.to_string(), "AB").is_err());
    assert!(step_file(&dir, "../key").is_none());
    assert_eq!(step_file(&dir, &key), Some(dir.join(&key)));
    drop(std::fs::remove_dir_all(&folders));
  }
}
