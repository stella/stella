//! Fetches which server-gated features exist for the linked account.
//!
//! The request carries only the desktop account key and receives only
//! per-feature decisions; this module never reads or sends feature data. The
//! decision is refreshed at startup, on every account link or unlink, and
//! every 15 minutes. Anything but an explicit `enabled` (no account, a
//! network or server error, an unknown status) turns a feature off.

use serde::Deserialize;
use std::{
  collections::{HashMap, HashSet},
  sync::{Arc, OnceLock},
  time::Duration,
};
use tauri::{AppHandle, Manager};

use crate::account::{self, AccountState, LinkedAccount};
use crate::feature_gate::{DesktopFeature, FeatureGates};
use crate::http_client::{DesktopHttpClient, HttpClientOptions};

const REFRESH_INTERVAL: Duration = Duration::from_secs(15 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const ENABLED_STATUS: &str = "enabled";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
  path: String,
}

const CONTRACT: &str =
  include_str!("../../../../packages/api-contract/src/desktop-feature-access.json");

fn contract() -> Contract {
  serde_json::from_str(CONTRACT)
    .expect("the committed desktop feature-access contract must be valid")
}

#[derive(Deserialize)]
struct Response {
  features: HashMap<String, Decision>,
}

#[derive(Deserialize)]
struct Decision {
  status: String,
}

/// The features the response enables. Unknown features and statuses are
/// ignored, so they stay off.
fn enabled_features(body: &[u8]) -> Result<HashSet<DesktopFeature>, String> {
  let response: Response = serde_json::from_slice(body)
    .map_err(|_| "feature access response is invalid".to_string())?;
  Ok(
    response
      .features
      .into_iter()
      .filter(|(_, decision)| decision.status == ENABLED_STATUS)
      .filter_map(|(id, _)| DesktopFeature::from_id(&id))
      .collect(),
  )
}

fn client() -> Result<&'static DesktopHttpClient, String> {
  static CLIENT: OnceLock<DesktopHttpClient> = OnceLock::new();
  if let Some(client) = CLIENT.get() {
    return Ok(client);
  }
  let client = DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(REQUEST_TIMEOUT),
  })
  .map_err(|_| "feature access client is unavailable".to_string())?;
  Ok(CLIENT.get_or_init(|| client))
}

async fn fetch(account: &LinkedAccount) -> Result<HashSet<DesktopFeature>, String> {
  let url = format!("{}{}", account.api_base_url, contract().path);
  let mut response = client()?
    .get(url)
    .bearer_auth(&account.credential.key)
    .send()
    .await
    .map_err(|_| "feature access request failed".to_string())?;
  if !response.status().is_success() {
    return Err(format!(
      "feature access request was refused: {}",
      response.status()
    ));
  }
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|_| "feature access response failed".to_string())?
  {
    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err("feature access response is too large".to_string());
    }
    body.extend_from_slice(&chunk);
  }
  enabled_features(&body)
}

struct AccountDecision {
  namespace: Option<String>,
  expires_at: Option<chrono::DateTime<chrono::Utc>>,
  enabled: HashSet<DesktopFeature>,
}

async fn current_decision(app: &AppHandle) -> AccountDecision {
  let closed = || AccountDecision {
    namespace: None,
    expires_at: None,
    enabled: HashSet::new(),
  };
  let Some(state) = app.try_state::<AccountState>() else {
    return closed();
  };
  let account = match account::current(&state).await {
    Ok(Some(account)) => account,
    Ok(None) => return closed(),
    Err(error) => {
      tracing::warn!(error = %error, "feature access skipped: account is unreadable");
      return closed();
    }
  };
  let namespace = Some(account.local_data_namespace());
  let expires_at = chrono::DateTime::parse_from_rfc3339(&account.credential.expires_at)
    .ok()
    .map(|expiry| expiry.with_timezone(&chrono::Utc));
  let enabled = fetch(&account).await.unwrap_or_else(|error| {
    tracing::warn!(error = %error, "feature access is unavailable; gated features stay off");
    HashSet::new()
  });
  AccountDecision {
    namespace,
    expires_at,
    enabled,
  }
}

fn refresh_signal() -> &'static tokio::sync::Notify {
  static SIGNAL: OnceLock<tokio::sync::Notify> = OnceLock::new();
  SIGNAL.get_or_init(tokio::sync::Notify::new)
}

/// Asks the refresh loop to fetch now (after an account link or unlink).
pub fn account_changed(app: &AppHandle, unload: impl FnOnce(&AppHandle)) {
  if let Some(gates) = app.try_state::<FeatureGates>() {
    gates.invalidate();
  }
  unload(app);
  if let Some(gates) = app.try_state::<FeatureGates>() {
    gates.finish_account_change();
  }
  refresh_signal().notify_one();
}

pub type FeatureChangeHandler =
  Arc<dyn Fn(&AppHandle, DesktopFeature, bool) + Send + Sync>;

/// Runs the refresh loop. `on_change` is called with every feature whose
/// state changed, after the new decision is visible through [`FeatureGates`].
pub fn start(app: AppHandle, on_change: FeatureChangeHandler) {
  tauri::async_runtime::spawn(async move {
    let mut interval = tokio::time::interval(REFRESH_INTERVAL);
    loop {
      tokio::select! {
        _ = interval.tick() => {}
        () = refresh_signal().notified() => {}
      }
      let Some(gates) = app.try_state::<FeatureGates>() else {
        return;
      };
      let Some(generation) = gates.generation() else {
        return;
      };
      let decision = current_decision(&app).await;
      let Some(changed) = gates.install(
        generation,
        decision.namespace,
        decision.expires_at,
        decision.enabled,
      ) else {
        continue;
      };
      for feature in changed {
        on_change(&app, feature, gates.is_enabled(feature));
      }
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_contract_lists_exactly_the_known_features() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FeatureIds {
      feature_ids: Vec<String>,
    }
    assert!(contract().path.starts_with("/v1/"));
    let mut ids = serde_json::from_str::<FeatureIds>(CONTRACT)
      .unwrap()
      .feature_ids;
    ids.sort();
    let mut known = DesktopFeature::ALL
      .iter()
      .map(|feature| feature.id().to_string())
      .collect::<Vec<_>>();
    known.sort();
    assert_eq!(ids, known);
  }

  #[test]
  fn only_an_explicit_enabled_status_turns_a_feature_on() {
    let enabled = enabled_features(
      br#"{"features":{"activity-timeline":{"status":"enabled"},"other":{"status":"enabled"}}}"#,
    )
    .unwrap();
    assert_eq!(enabled, HashSet::from([DesktopFeature::ActivityTimeline]));

    for body in [
      r#"{"features":{"activity-timeline":{"status":"hidden"}}}"#,
      r#"{"features":{"activity-timeline":{"status":"Enabled"}}}"#,
      r#"{"features":{}}"#,
    ] {
      assert!(
        enabled_features(body.as_bytes()).unwrap().is_empty(),
        "{body}"
      );
    }
    assert!(enabled_features(b"{}").is_err());
    assert!(enabled_features(b"not json").is_err());
  }

  #[tokio::test]
  async fn fetch_sends_the_account_key_and_fails_closed_on_refusal() {
    use axum::{Router, http::HeaderMap, http::StatusCode, routing::get};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().route(
      &contract().path,
      get(|headers: HeaderMap| async move {
        match headers
          .get("authorization")
          .and_then(|value| value.to_str().ok())
        {
          Some("Bearer stella_dr_good") => (
            StatusCode::OK,
            r#"{"features":{"activity-timeline":{"status":"enabled"}}}"#,
          ),
          _ => (
            StatusCode::UNAUTHORIZED,
            "Reconnect desktop to your account",
          ),
        }
      }),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let account = |key: &str| LinkedAccount {
      api_base_url: base.clone(),
      web_origin: "https://my.example.test".into(),
      identity: crate::types::DesktopAccountIdentity {
        user_id: "user_fixture".into(),
        organization_id: "org_fixture".into(),
      },
      account: crate::types::LinkedAccountSnapshot {
        email: "desktop@example.test".into(),
        name: None,
        verified_at: chrono::Utc::now().to_rfc3339(),
      },
      credential: crate::types::DesktopAccountCredential {
        key: key.into(),
        expires_at: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
      },
    };

    assert_eq!(
      fetch(&account("stella_dr_good")).await.unwrap(),
      HashSet::from([DesktopFeature::ActivityTimeline])
    );
    assert!(fetch(&account("stella_dr_bad")).await.is_err());
    server.abort();
  }
}
