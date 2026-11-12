//! Commands over the folders linked for this computer's local runs. Every
//! command first requires the server-gated local agents feature. A folder is
//! only ever linked through the native picker, so a window cannot name a path
//! itself. The change event carries no payload: windows read the list again.
//!
//! A folder can sit on a mount that hangs, so folders are only ever looked at
//! on a blocking thread, for a bounded time.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::feature_gate::{DesktopFeature, FeatureGates};
use crate::local_linked_folders::{
  LinkedFolderListError, LinkedFolderStatus, LinkedFolders,
};
use crate::logging::best_effort;

const CHANGED_EVENT: &str = "local-linked-folders-changed";
const LOOK_BUDGET: Duration = Duration::from_secs(3);

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalLinkedFolderCommandError {
  FeatureDisabled,
  #[serde(untagged)]
  List(LinkedFolderListError),
}

impl From<LinkedFolderListError> for LocalLinkedFolderCommandError {
  fn from(error: LinkedFolderListError) -> Self {
    Self::List(error)
  }
}

fn linked_folders(
  gates: &FeatureGates,
) -> Result<LinkedFolders, LocalLinkedFolderCommandError> {
  if !gates.is_enabled(DesktopFeature::LocalAgents) {
    return Err(LocalLinkedFolderCommandError::FeatureDisabled);
  }
  Ok(LinkedFolders::for_this_computer())
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

fn announce(app: &AppHandle) {
  best_effort(
    app.emit(CHANGED_EVENT, ()),
    "linked folder change was not announced",
  );
}

#[tauri::command]
pub async fn local_linked_folders_get(
  gates: State<'_, FeatureGates>,
) -> Result<Vec<LinkedFolderStatus>, LocalLinkedFolderCommandError> {
  let folders = linked_folders(&gates)?;
  let unread = folders.unread_statuses();
  Ok(
    off_the_loop(move || folders.statuses())
      .await
      .unwrap_or(unread),
  )
}

/// Asks the member for a folder and links it; closing the picker changes
/// nothing. Answers whether a folder was linked.
#[tauri::command]
pub async fn local_linked_folders_pick(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<bool, LocalLinkedFolderCommandError> {
  let probing = linked_folders(&gates)?;
  let folders = linked_folders(&gates)?;
  let (picked, answer) = tokio::sync::oneshot::channel();
  let mut dialog = app.dialog().file();
  if let Some(window) = app.get_webview_window("main") {
    dialog = dialog.set_parent(&window);
  }
  dialog.pick_folder(move |folder| {
    // Unsent only once the command stopped waiting, which needs no answer.
    if picked.send(folder).is_err() {
      tracing::debug!("linked folder pick finished after its command ended");
    }
  });
  let Ok(Some(folder)) = answer.await else {
    return Ok(false);
  };
  let path = folder
    .into_path()
    .ok()
    .ok_or(LinkedFolderListError::Unreadable)?;
  // Only the look at the folder is bounded: one that does not answer in
  // time is unreadable and never linked. Linking itself touches only the
  // stored list, so it always finishes and its outcome is the answer.
  let candidate = off_the_loop(move || probing.probe(&path))
    .await
    .unwrap_or(Err(LinkedFolderListError::Unreadable))?;
  tokio::task::spawn_blocking(move || folders.commit(candidate))
    .await
    .map_err(crate::logging::replaced_logged(
      "a linked folder could not be stored",
      LinkedFolderListError::Storage,
    ))??;
  announce(&app);
  Ok(true)
}

/// Unlinks a folder; the folder itself is not touched.
#[tauri::command(async)]
pub fn local_linked_folders_remove(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  id: String,
) -> Result<(), LocalLinkedFolderCommandError> {
  linked_folders(&gates)?.remove(&id)?;
  announce(&app);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn command_errors_serialize_as_flat_codes() {
    for (error, code) in [
      (
        LocalLinkedFolderCommandError::FeatureDisabled,
        "feature_disabled",
      ),
      (LinkedFolderListError::TooMany.into(), "too_many"),
      (LinkedFolderListError::Protected.into(), "protected"),
    ] {
      assert_eq!(serde_json::to_value(&error).unwrap(), code);
    }
  }
}
