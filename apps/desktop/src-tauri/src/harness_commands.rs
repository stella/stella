//! Commands over the managed agent CLIs. Every command first requires the
//! server-gated local agents feature. The settings window may read the
//! status, start an install and cancel it; no window may remove a release.
//! The change event carries no payload: windows read the status again.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::feature_gate::{DesktopFeature, FeatureGates};
use crate::harness_auto_install::HarnessAutoInstall;
use crate::harness_installation::{
  HarnessError, HarnessInstallState, HarnessInstallation,
};
use crate::harness_release::ManagedHarness;

pub const CHANGED_EVENT: &str = "harness-install-changed";

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessCommandError {
  FeatureDisabled,
  /// This computer has no data directory to install into.
  Unavailable,
  #[serde(untagged)]
  Installation(HarnessError),
}

impl From<HarnessError> for HarnessCommandError {
  fn from(error: HarnessError) -> Self {
    Self::Installation(error)
  }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
  harness: ManagedHarness,
  state: HarnessInstallState,
}

fn installation(
  app: &AppHandle,
  gates: &FeatureGates,
) -> Result<HarnessInstallation, HarnessCommandError> {
  if !gates.is_enabled(DesktopFeature::LocalAgents) {
    return Err(HarnessCommandError::FeatureDisabled);
  }
  app
    .try_state::<HarnessInstallation>()
    .map(|installation| installation.inner().clone())
    .ok_or(HarnessCommandError::Unavailable)
}

#[tauri::command]
pub fn harness_get_status(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<Vec<HarnessStatus>, HarnessCommandError> {
  let installation = installation(&app, &gates)?;
  Ok(
    ManagedHarness::ALL
      .into_iter()
      .map(|harness| HarnessStatus {
        harness,
        state: installation.state(harness),
      })
      .collect(),
  )
}

#[tauri::command]
pub fn harness_install(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  harness: ManagedHarness,
) -> Result<HarnessInstallState, HarnessCommandError> {
  Ok(installation(&app, &gates)?.start(harness)?)
}

#[tauri::command]
pub fn harness_cancel_install(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  harness: ManagedHarness,
  operation_id: String,
) -> Result<HarnessInstallState, HarnessCommandError> {
  Ok(installation(&app, &gates)?.cancel(harness, &operation_id)?)
}

#[tauri::command]
pub async fn harness_remove(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  harness: ManagedHarness,
) -> Result<(), HarnessCommandError> {
  let installation = installation(&app, &gates)?;
  Ok(installation.remove(harness).await?)
}

/// Builds the automatic installer and tells windows about every install
/// state change. Nothing installs until the feature turns on.
pub fn manage(app: &AppHandle) {
  let Some(installation) = app
    .try_state::<HarnessInstallation>()
    .map(|installation| installation.inner().clone())
  else {
    return;
  };
  app.manage(HarnessAutoInstall::new(installation.clone()));
  for harness in ManagedHarness::ALL {
    let mut changes = installation.subscribe(harness);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
      while changes.changed().await.is_ok() {
        crate::logging::best_effort(
          app.emit(CHANGED_EVENT, ()),
          "harness change was not announced",
        );
      }
    });
  }
}

/// Turning the feature on installs every harness not on its pinned release;
/// turning it off stops any install in progress. Installed releases stay
/// until removed.
pub fn apply_feature_gate(app: &AppHandle, enabled: bool) {
  if let Some(auto) = app.try_state::<HarnessAutoInstall>() {
    auto.set_enabled(enabled);
  }
  crate::logging::best_effort(
    app.emit(CHANGED_EVENT, ()),
    "harness change was not announced",
  );
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn command_errors_serialize_as_flat_codes() {
    for (error, code) in [
      (HarnessCommandError::FeatureDisabled, "feature_disabled"),
      (HarnessCommandError::Unavailable, "unavailable"),
      (HarnessError::InUse.into(), "in_use"),
      (
        HarnessError::UnsupportedPlatform.into(),
        "unsupported_platform",
      ),
    ] {
      assert_eq!(serde_json::to_value(&error).unwrap(), code);
    }
  }
}
