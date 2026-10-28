//! Commands over the managed agent CLIs. Every command first requires the
//! server-gated local agents feature, and no window capability grants them
//! yet, so no page can reach them.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::feature_gate::{DesktopFeature, FeatureGates};
use crate::harness_installation::{
  HarnessError, HarnessInstallState, HarnessInstallation,
};
use crate::harness_release::ManagedHarness;

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

/// Turning the feature off stops any install in progress; installed
/// releases stay until removed.
pub fn apply_feature_gate(app: &AppHandle, enabled: bool) {
  if enabled {
    return;
  }
  if let Some(installation) = app.try_state::<HarnessInstallation>() {
    installation.cancel_all();
  }
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
