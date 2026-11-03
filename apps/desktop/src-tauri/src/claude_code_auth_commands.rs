//! Commands behind the Claude Code row of the AI subscriptions settings:
//! its sign-in status, sign-in, cancel, opening the sign-in page again, and
//! sign-out. Every command first requires the server-gated local agents
//! feature. None returns a credential or a sign-in link: the change event
//! carries no payload, and windows pull the status again.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::claude_code_auth::{
  ClaudeCodeAuth, ClaudeCodeAuthConfig, ClaudeCodeAuthHooks, ClaudeCodeLaunch,
  ClaudeCodeStatus, LaunchError, OpenPageError, SignOutError,
};
use crate::feature_gate::{DesktopFeature, FeatureGates};
use crate::harness_installation::{HarnessError, HarnessInstallation};
use crate::harness_release::ManagedHarness;

pub const CHANGED_EVENT: &str = "claude-code-auth-changed";

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeCodeCommandError {
  FeatureDisabled,
  /// This computer has no data directory for the managed CLI.
  Unavailable,
  /// A sign-in is in progress.
  SigningIn,
  NotInstalled,
  SignOutFailed,
  /// No sign-in page to open.
  NoSignInPage,
  BrowserUnavailable,
}

fn auth(
  app: &AppHandle,
  gates: &FeatureGates,
) -> Result<ClaudeCodeAuth, ClaudeCodeCommandError> {
  if !gates.is_enabled(DesktopFeature::LocalAgents) {
    return Err(ClaudeCodeCommandError::FeatureDisabled);
  }
  app
    .try_state::<ClaudeCodeAuth>()
    .map(|auth| auth.inner().clone())
    .ok_or(ClaudeCodeCommandError::Unavailable)
}

#[tauri::command]
pub async fn claude_code_auth_get_status(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<ClaudeCodeStatus, ClaudeCodeCommandError> {
  Ok(auth(&app, &gates)?.status().await)
}

#[tauri::command]
pub async fn claude_code_auth_start(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<ClaudeCodeStatus, ClaudeCodeCommandError> {
  let auth = auth(&app, &gates)?;
  auth.start();
  Ok(auth.status().await)
}

#[tauri::command]
pub fn claude_code_auth_cancel(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<(), ClaudeCodeCommandError> {
  auth(&app, &gates)?.cancel();
  Ok(())
}

#[tauri::command]
pub fn claude_code_auth_open_sign_in_page(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<(), ClaudeCodeCommandError> {
  auth(&app, &gates)?
    .open_sign_in_page()
    .map_err(|error| match error {
      OpenPageError::NoPage => ClaudeCodeCommandError::NoSignInPage,
      OpenPageError::BrowserUnavailable => ClaudeCodeCommandError::BrowserUnavailable,
    })
}

#[tauri::command]
pub async fn claude_code_auth_sign_out(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<(), ClaudeCodeCommandError> {
  auth(&app, &gates)?
    .sign_out()
    .await
    .map_err(|error| match error {
      SignOutError::SigningIn => ClaudeCodeCommandError::SigningIn,
      SignOutError::NotInstalled => ClaudeCodeCommandError::NotInstalled,
      SignOutError::Failed => ClaudeCodeCommandError::SignOutFailed,
    })
}

/// The managed CLI, leased so it stays installed while it runs.
fn launch(installation: &HarnessInstallation) -> Result<ClaudeCodeLaunch, LaunchError> {
  let lease = installation
    .acquire(ManagedHarness::ClaudeCode)
    .map_err(|error| match error {
      HarnessError::NotInstalled
      | HarnessError::UnsupportedPlatform
      | HarnessError::Busy => LaunchError::NotInstalled,
      HarnessError::CorruptInstall
      | HarnessError::InUse
      | HarnessError::NotCurrent
      | HarnessError::Storage => LaunchError::Unavailable,
    })?;
  let (_, config_dir) = lease.config_env();
  Ok(ClaudeCodeLaunch {
    executable: lease.executable().to_path_buf(),
    config_dir: config_dir.to_path_buf(),
    environment: std::env::vars_os().collect(),
    _hold: Box::new(lease),
  })
}

/// Builds the sign-in owner at startup. Nothing runs until a window asks for
/// the status; an install or removal of the CLI tells windows to ask again.
pub fn manage(app: &AppHandle) {
  let Some(installation) = app
    .try_state::<HarnessInstallation>()
    .map(|installation| installation.inner().clone())
  else {
    tracing::warn!("Claude Code sign-in has no managed installation");
    return;
  };
  let mut installs = installation.subscribe(ManagedHarness::ClaudeCode);
  let opener = app.clone();
  let changed = app.clone();
  let auth = ClaudeCodeAuth::new(
    ClaudeCodeAuthConfig::standard(),
    ClaudeCodeAuthHooks {
      launch: Box::new(move || launch(&installation)),
      open_browser: Box::new(move |url| {
        use tauri_plugin_opener::OpenerExt;
        opener.opener().open_url(url, None::<&str>).is_ok()
      }),
      changed: Box::new(move || {
        let _ = changed.emit(CHANGED_EVENT, ());
      }),
    },
  );
  app.manage(auth);
  let installed = app.clone();
  tauri::async_runtime::spawn(async move {
    while installs.changed().await.is_ok() {
      let _ = installed.emit(CHANGED_EVENT, ());
    }
  });
}

/// Turning the feature off stops a sign-in in progress; the sign-in itself
/// stays until the user signs out.
pub fn apply_feature_gate(app: &AppHandle, enabled: bool) {
  if !enabled && let Some(auth) = app.try_state::<ClaudeCodeAuth>() {
    auth.cancel();
  }
  let _ = app.emit(CHANGED_EVENT, ());
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn command_errors_serialize_as_flat_codes() {
    for (error, code) in [
      (ClaudeCodeCommandError::FeatureDisabled, "feature_disabled"),
      (ClaudeCodeCommandError::SigningIn, "signing_in"),
      (ClaudeCodeCommandError::NoSignInPage, "no_sign_in_page"),
      (ClaudeCodeCommandError::SignOutFailed, "sign_out_failed"),
    ] {
      assert_eq!(serde_json::to_value(&error).unwrap(), code);
    }
  }
}
