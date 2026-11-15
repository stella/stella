//! The PKCS #11 module the user chose for a smart card no known driver
//! covers.
//!
//! The desktop looks for the modules of the drivers it knows on its own
//! (`stella_desktop_pkcs11::drivers`). A card whose vendor is not in that
//! list still signs once the user points the settings at its module. The
//! path is chosen only through the native file picker, so a window cannot
//! name one itself, and the module is loaded only by the PKCS #11 helper
//! process, never by the app.

use std::path::{Path, PathBuf};

use serde::Serialize;
use stella_desktop_pkcs11::drivers::check_module_file;
use stella_desktop_pkcs11::macho::ModuleCheck;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::device_preference::DevicePreference;
use crate::logging::best_effort;

const PREFERENCE_FILE: &str = "pkcs11-module";
const CHANGED_EVENT: &str = "signing-driver-changed";
/// What the file picker offers: a macOS module is a `.dylib`, or a `.so`
/// bundle as OpenSC and DNIe ship theirs.
const MODULE_EXTENSIONS: &[&str] = &["dylib", "so"];

fn preference() -> DevicePreference {
  DevicePreference::in_app_data(PREFERENCE_FILE)
}

/// The module the user chose, if any; only macOS signs through PKCS #11.
pub fn chosen_module() -> Option<PathBuf> {
  if !cfg!(target_os = "macos") {
    return None;
  }
  preference().read().map(PathBuf::from)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningDriverStatus {
  path: Option<String>,
  problem: Option<SigningDriverProblem>,
}

/// Why the chosen module cannot sign as it is.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SigningDriverProblem {
  Missing,
  NeedsUpdate,
  NotALibrary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SigningDriverError {
  /// Only macOS signs through PKCS #11 modules; the settings show nothing.
  UnsupportedPlatform,
  /// The choice could not be saved.
  NotSaved,
}

fn problem(check: Option<ModuleCheck>) -> Option<SigningDriverProblem> {
  match check {
    None => Some(SigningDriverProblem::Missing),
    Some(ModuleCheck::Loadable) => None,
    Some(ModuleCheck::MissingArchitecture { .. }) => {
      Some(SigningDriverProblem::NeedsUpdate)
    }
    Some(ModuleCheck::NotALibrary) => Some(SigningDriverProblem::NotALibrary),
  }
}

fn status_of(path: Option<&Path>) -> SigningDriverStatus {
  SigningDriverStatus {
    path: path.map(|path| path.display().to_string()),
    problem: path.and_then(|path| problem(check_module_file(path))),
  }
}

fn supported() -> Result<(), SigningDriverError> {
  if cfg!(target_os = "macos") {
    Ok(())
  } else {
    Err(SigningDriverError::UnsupportedPlatform)
  }
}

#[tauri::command(async)]
pub fn signing_driver_get() -> Result<SigningDriverStatus, SigningDriverError> {
  supported()?;
  Ok(status_of(chosen_module().as_deref()))
}

/// Asks for a module file and keeps it; closing the picker changes nothing.
/// A file with a problem is kept too, and its status says what is wrong.
#[tauri::command]
pub async fn signing_driver_pick(app: AppHandle) -> Result<bool, SigningDriverError> {
  supported()?;
  let (picked, answer) = tokio::sync::oneshot::channel();
  let mut dialog = app
    .dialog()
    .file()
    .add_filter("PKCS #11", MODULE_EXTENSIONS);
  if let Some(window) = app.get_webview_window("main") {
    dialog = dialog.set_parent(&window);
  }
  dialog.pick_file(move |file| {
    if picked.send(file).is_err() {
      tracing::debug!("module pick finished after its command ended");
    }
  });
  let Ok(Some(file)) = answer.await else {
    return Ok(false);
  };
  let path = file
    .into_path()
    .map_err(|_unreadable| SigningDriverError::NotSaved)?;
  let text = path.to_str().ok_or(SigningDriverError::NotSaved)?;
  preference()
    .write(text)
    .map_err(crate::logging::with_cause_logged(
      "the chosen module could not be saved",
    ))
    .map_err(|_logged| SigningDriverError::NotSaved)?;
  best_effort(
    app.emit(CHANGED_EVENT, ()),
    "signing driver change was not announced",
  );
  Ok(true)
}

#[tauri::command(async)]
pub fn signing_driver_remove(app: AppHandle) -> Result<(), SigningDriverError> {
  supported()?;
  preference()
    .write("")
    .map_err(crate::logging::with_cause_logged(
      "the chosen module could not be removed",
    ))
    .map_err(|_logged| SigningDriverError::NotSaved)?;
  best_effort(
    app.emit(CHANGED_EVENT, ()),
    "signing driver change was not announced",
  );
  Ok(())
}

#[cfg(test)]
mod tests {
  use stella_desktop_pkcs11::macho::Architecture;

  use super::*;

  #[test]
  fn names_what_keeps_a_chosen_module_from_signing() {
    assert_eq!(problem(None), Some(SigningDriverProblem::Missing));
    assert_eq!(problem(Some(ModuleCheck::Loadable)), None);
    assert_eq!(
      problem(Some(ModuleCheck::MissingArchitecture {
        found: vec![Architecture::X86_64]
      })),
      Some(SigningDriverProblem::NeedsUpdate)
    );
    assert_eq!(
      problem(Some(ModuleCheck::NotALibrary)),
      Some(SigningDriverProblem::NotALibrary)
    );
  }

  #[test]
  fn serializes_as_the_settings_read_it() {
    assert_eq!(
      serde_json::to_string(&status_of(Some(Path::new(
        "/nonexistent/stella/module.dylib"
      ))))
      .unwrap(),
      r#"{"path":"/nonexistent/stella/module.dylib","problem":"missing"}"#
    );
    assert_eq!(
      serde_json::to_string(&status_of(None)).unwrap(),
      r#"{"path":null,"problem":null}"#
    );
    assert_eq!(
      serde_json::to_value(SigningDriverError::UnsupportedPlatform).unwrap(),
      "unsupported_platform"
    );
  }
}
