//! Commands over the skill folders of this computer's local runs. Every command
//! first requires the server-gated local agents feature. A folder is only ever
//! added through the native picker, so a window cannot name a path itself. The
//! change event carries no payload: windows read the list again.
//!
//! A folder can sit on a mount that hangs, so folders are only ever looked at
//! on a blocking thread, for a bounded time.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::feature_gate::{DesktopFeature, FeatureGates};
use crate::local_skill_folders::{
  SkillFolderListError, SkillFolderProblem, SkillFolderStatus, SkillFolders,
};

const CHANGED_EVENT: &str = "local-skill-folders-changed";
const LOOK_BUDGET: Duration = Duration::from_secs(3);

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalSkillCommandError {
  FeatureDisabled,
  #[serde(untagged)]
  List(SkillFolderListError),
}

impl From<SkillFolderListError> for LocalSkillCommandError {
  fn from(error: SkillFolderListError) -> Self {
    Self::List(error)
  }
}

fn skill_folders(gates: &FeatureGates) -> Result<SkillFolders, LocalSkillCommandError> {
  if !gates.is_enabled(DesktopFeature::LocalAgents) {
    return Err(LocalSkillCommandError::FeatureDisabled);
  }
  Ok(SkillFolders::for_this_computer())
}

/// The work's answer, or `None` when it did not finish in time. A stuck read
/// holds its own blocking thread until the mount answers, and nothing else.
async fn off_the_loop<T: Send + 'static>(
  work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
  tokio::time::timeout(LOOK_BUDGET, tokio::task::spawn_blocking(work))
    .await
    .ok()?
    .ok()
}

#[tauri::command]
pub async fn local_skill_folders_get(
  gates: State<'_, FeatureGates>,
) -> Result<Vec<SkillFolderStatus>, LocalSkillCommandError> {
  let folders = skill_folders(&gates)?;
  let unread = folders.unread_statuses();
  Ok(
    off_the_loop(move || folders.statuses())
      .await
      .unwrap_or(unread),
  )
}

/// Asks the member for a folder and lists it; closing the picker changes
/// nothing. Answers whether a folder was listed.
#[tauri::command]
pub async fn local_skill_folders_pick(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<bool, LocalSkillCommandError> {
  let folders = skill_folders(&gates)?;
  let (picked, answer) = tokio::sync::oneshot::channel();
  let mut dialog = app.dialog().file();
  if let Some(window) = app.get_webview_window("main") {
    dialog = dialog.set_parent(&window);
  }
  dialog.pick_folder(move |folder| {
    let _ = picked.send(folder);
  });
  let Ok(Some(folder)) = answer.await else {
    return Ok(false);
  };
  let path = folder
    .into_path()
    .ok()
    .ok_or(SkillFolderListError::Folder(SkillFolderProblem::Unreadable))?;
  off_the_loop(move || folders.add(&path))
    .await
    .unwrap_or(Err(SkillFolderListError::Folder(
      SkillFolderProblem::Unreadable,
    )))?;
  let _ = app.emit(CHANGED_EVENT, ());
  Ok(true)
}

/// Unlists a folder; the folder itself is not touched.
#[tauri::command(async)]
pub fn local_skill_folders_remove(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  path: String,
) -> Result<(), LocalSkillCommandError> {
  skill_folders(&gates)?.remove(&path)?;
  let _ = app.emit(CHANGED_EVENT, ());
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn command_errors_serialize_as_flat_codes() {
    for (error, code) in [
      (LocalSkillCommandError::FeatureDisabled, "feature_disabled"),
      (SkillFolderListError::TooMany.into(), "too_many"),
      (
        SkillFolderListError::Folder(SkillFolderProblem::NoSkillFile).into(),
        "no_skill_file",
      ),
    ] {
      assert_eq!(serde_json::to_value(&error).unwrap(), code);
    }
  }
}
