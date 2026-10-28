//! Commands behind the AI subscriptions settings: the ChatGPT connection's
//! status, sign-in, cancel, completing from a pasted URL, and disconnect.
//! Every command first requires the server-gated local agents feature, and
//! none returns or emits a token: the change event carries no payload, and
//! windows pull the status again.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::chatgpt_auth::{
  CallbackUrlError, ChatGptAuth, ChatGptAuthConfig, ChatGptAuthHooks, ChatGptStatus,
  FileVault, KeychainSecrets, SignInIntent,
};
use crate::codex_managed_token_broker::{
  CodexChatGptLaunch, CodexLaunchError, CodexManagedTokenBroker,
};
use crate::feature_gate::{DesktopFeature, FeatureGates};
use crate::harness_installation::HarnessInstallation;
use crate::harness_release::ManagedHarness;
use crate::http_client::{DesktopHttpClient, HttpClientOptions};

pub const CHANGED_EVENT: &str = "chatgpt-auth-changed";
const USAGE_URL: &str = "https://chatgpt.com/settings/usage";
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatGptCommandError {
  FeatureDisabled,
  /// This computer has no data directory to keep the connection in.
  Unavailable,
  /// No sign-in is waiting for a URL.
  NoSignIn,
  /// The pasted URL belongs to another sign-in or address.
  NotThisSignIn,
  Storage,
  BrowserUnavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptDisconnected {
  /// Whether OpenAI confirmed the renewable session was revoked.
  revocation_confirmed: bool,
}

/// The token broker, started by the first Codex run that needs it.
#[derive(Default)]
pub struct ChatGptTokenBroker(tokio::sync::OnceCell<CodexManagedTokenBroker>);

fn auth(
  app: &AppHandle,
  gates: &FeatureGates,
) -> Result<ChatGptAuth, ChatGptCommandError> {
  if !gates.is_enabled(DesktopFeature::LocalAgents) {
    return Err(ChatGptCommandError::FeatureDisabled);
  }
  app
    .try_state::<ChatGptAuth>()
    .map(|auth| auth.inner().clone())
    .ok_or(ChatGptCommandError::Unavailable)
}

#[tauri::command]
pub async fn chatgpt_auth_get_status(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<ChatGptStatus, ChatGptCommandError> {
  Ok(auth(&app, &gates)?.status().await)
}

#[tauri::command]
pub async fn chatgpt_auth_start(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  new_account: bool,
  account: Option<String>,
) -> Result<ChatGptStatus, ChatGptCommandError> {
  let intent = match account {
    Some(client_id) => SignInIntent::Account(client_id),
    None if new_account => SignInIntent::NewAccount,
    None => SignInIntent::SameAccount,
  };
  let auth = auth(&app, &gates)?;
  auth.start(intent);
  Ok(auth.status().await)
}

#[tauri::command]
pub fn chatgpt_auth_cancel(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<(), ChatGptCommandError> {
  auth(&app, &gates)?.cancel();
  Ok(())
}

#[tauri::command]
pub fn chatgpt_auth_complete(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
  url: String,
) -> Result<(), ChatGptCommandError> {
  auth(&app, &gates)?
    .complete_from_url(&url)
    .map_err(|error| match error {
      CallbackUrlError::NoSignIn => ChatGptCommandError::NoSignIn,
      CallbackUrlError::NotThisSignIn => ChatGptCommandError::NotThisSignIn,
    })
}

#[tauri::command]
pub async fn chatgpt_auth_disconnect(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<ChatGptDisconnected, ChatGptCommandError> {
  let revocation_confirmed = auth(&app, &gates)?
    .disconnect()
    .await
    .map_err(|_unavailable| ChatGptCommandError::Storage)?;
  Ok(ChatGptDisconnected {
    revocation_confirmed,
  })
}

#[tauri::command]
pub fn chatgpt_auth_open_usage(
  app: AppHandle,
  gates: State<'_, FeatureGates>,
) -> Result<(), ChatGptCommandError> {
  use tauri_plugin_opener::OpenerExt;

  auth(&app, &gates)?;
  app
    .opener()
    .open_url(USAGE_URL, None::<&str>)
    .map_err(|_unavailable| ChatGptCommandError::BrowserUnavailable)
}

/// Builds the connection owner at startup. Nothing is read until a window
/// asks for the status.
pub fn manage(app: &AppHandle) {
  let Some(data) = dirs::data_dir() else {
    tracing::warn!("ChatGPT connection has no data directory");
    return;
  };
  let path = data
    .join(crate::config::APP_DATA_DIR_NAME)
    .join("agent-subscriptions")
    .join("chatgpt.json");
  let http = match DesktopHttpClient::new(HttpClientOptions {
    timeout: Some(REQUEST_TIMEOUT),
    redirect: reqwest::redirect::Policy::none(),
  }) {
    Ok(http) => http,
    Err(error) => {
      crate::logging::log_request_error(
        &error,
        "ChatGPT sign-in client is unavailable",
      );
      return;
    }
  };
  let opener = app.clone();
  let changed = app.clone();
  let harness = app.clone();
  let auth = ChatGptAuth::new(
    ChatGptAuthConfig::openai(),
    Arc::new(FileVault::new(path, KeychainSecrets)),
    http,
    ChatGptAuthHooks {
      open_browser: Box::new(move |url| {
        use tauri_plugin_opener::OpenerExt;
        // The URL can carry an ID token hint; it is never logged.
        opener.opener().open_url(url, None::<&str>).is_ok()
      }),
      changed: Box::new(move || {
        let _ = changed.emit(CHANGED_EVENT, ());
      }),
      clear_harness_sign_in: Box::new(move || {
        if let Some(installation) = harness.try_state::<HarnessInstallation>()
          && let Err(error) = installation.remove_sign_in(ManagedHarness::Codex)
        {
          tracing::warn!(kind = ?error.kind(), "managed Codex sign-in state was not removed");
        }
      }),
    },
  );
  app.manage(auth);
  app.manage(ChatGptTokenBroker::default());
}

/// Turning the feature off stops a sign-in in progress; the connection
/// stays until the user disconnects it.
pub fn apply_feature_gate(app: &AppHandle, enabled: bool) {
  if !enabled && let Some(auth) = app.try_state::<ChatGptAuth>() {
    auth.cancel();
  }
  let _ = app.emit(CHANGED_EVENT, ());
}

/// What the desktop runner adds to a managed Codex app-server launch to run
/// it on the user's ChatGPT plan.
#[allow(dead_code, reason = "the desktop runner's harness host calls this")]
pub async fn codex_chatgpt_launch(
  app: &AppHandle,
) -> Result<CodexChatGptLaunch, CodexLaunchError> {
  let gates = app.state::<FeatureGates>();
  if !gates.is_enabled(DesktopFeature::LocalAgents) {
    return Err(CodexLaunchError::Access(
      crate::chatgpt_auth::AccessError::NotConnected,
    ));
  }
  let (Some(auth), Some(broker)) = (
    app.try_state::<ChatGptAuth>(),
    app.try_state::<ChatGptTokenBroker>(),
  ) else {
    return Err(CodexLaunchError::Broker);
  };
  crate::codex_managed_token_broker::codex_chatgpt_launch(&auth, &broker.0).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn command_errors_serialize_as_flat_codes() {
    for (error, code) in [
      (ChatGptCommandError::FeatureDisabled, "feature_disabled"),
      (ChatGptCommandError::NoSignIn, "no_sign_in"),
      (ChatGptCommandError::NotThisSignIn, "not_this_sign_in"),
    ] {
      assert_eq!(serde_json::to_value(&error).unwrap(), code);
    }
    assert_eq!(
      serde_json::to_value(ChatGptDisconnected {
        revocation_confirmed: false
      })
      .unwrap(),
      serde_json::json!({ "revocationConfirmed": false })
    );
  }
}
