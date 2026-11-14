//! Fetches which server-gated features exist for the linked account.
//!
//! The request carries only the desktop account key and receives only
//! per-feature decisions; this module never reads or sends feature data. The
//! decision is refreshed at startup, on every account link or unlink, right
//! after the computer wakes, and every 2 minutes. Anything but an explicit
//! `enabled` (no account, a refusal, an unknown status) turns a feature off.
//!
//! A read that could not happen (the network is down after a wake, the
//! server failed, the Keychain did not answer in time) decides nothing: the
//! last decision stands, bounded by the credential's expiry, and the read is
//! retried within seconds rather than at the next 2 minute tick.

use serde::Deserialize;
use std::{
  collections::{HashMap, HashSet},
  sync::{Arc, OnceLock},
  time::Duration,
};
use tauri::{AppHandle, Manager};

use crate::account::{self, AccountRequest, AccountState};
use crate::feature_gate::{DesktopFeature, FeatureGates};
use crate::http_client::{DesktopHttpClient, HttpClientOptions};
use crate::logging::{json_cause_logged, request_cause_logged};

const REFRESH_INTERVAL: Duration = Duration::from_secs(2 * 60);
/// The first retry after a read that could not happen; each next one waits
/// twice as long, up to the refresh interval.
const FIRST_RETRY: Duration = Duration::from_secs(5);
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
    .map_err(json_cause_logged("feature access response is invalid"))?;
  Ok(
    response
      .features
      .into_iter()
      .filter(|(_, decision)| decision.status == ENABLED_STATUS)
      .filter_map(|(id, _)| DesktopFeature::from_id(&id))
      .collect(),
  )
}

/// Why a read produced no decision from the server.
#[derive(Debug, PartialEq, Eq)]
enum FetchFailure {
  /// The request never got an answer, or the server failed: nothing is
  /// known, so the last decision stands and the read is retried soon.
  Unreached(String),
  /// The server refused the request or answered with something unreadable:
  /// gated features go off.
  Refused(String),
}

/// A server failure or a rate limit says nothing about the account; any
/// other refusal does.
fn failure_for_status(status: reqwest::StatusCode) -> FetchFailure {
  let message = format!("feature access request was refused: {status}");
  if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
    FetchFailure::Unreached(message)
  } else {
    FetchFailure::Refused(message)
  }
}

/// How long to wait before retrying a read that could not happen.
fn next_retry(previous: Option<Duration>) -> Duration {
  previous.map_or(FIRST_RETRY, |wait| (wait * 2).min(REFRESH_INTERVAL))
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
  .map_err(request_cause_logged("feature access client is unavailable"))?;
  Ok(CLIENT.get_or_init(|| client))
}

fn signed_request(
  client: &DesktopHttpClient,
  request: &AccountRequest,
) -> Result<crate::http_client::DeviceProofRequest, String> {
  crate::http_client::device_proof_request(
    client.get(format!("{}{}", request.api_base_url, contract().path)),
    &request.device_key,
    Some(&request.credential.key),
    None,
  )
}

async fn fetch(
  request: &AccountRequest,
) -> Result<HashSet<DesktopFeature>, FetchFailure> {
  let mut response =
    signed_request(client().map_err(FetchFailure::Unreached)?, request)
      .map_err(FetchFailure::Refused)?
      .send()
      .await
      .map_err(request_cause_logged("feature access request failed"))
      .map_err(FetchFailure::Unreached)?;
  if !response.status().is_success() {
    return Err(failure_for_status(response.status()));
  }
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(request_cause_logged("feature access response failed"))
    .map_err(FetchFailure::Unreached)?
  {
    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err(FetchFailure::Refused(
        "feature access response is too large".to_string(),
      ));
    }
    body.extend_from_slice(&chunk);
  }
  enabled_features(&body).map_err(FetchFailure::Refused)
}

struct AccountDecision {
  namespace: Option<String>,
  expires_at: Option<chrono::DateTime<chrono::Utc>>,
  enabled: HashSet<DesktopFeature>,
}

/// What one read tells about the account's features.
enum Outcome {
  Decided(AccountDecision),
  /// Nothing could be read; the last decision stands.
  Unknown,
}

async fn current_decision(app: &AppHandle) -> Outcome {
  let closed = || {
    Outcome::Decided(AccountDecision {
      namespace: None,
      expires_at: None,
      enabled: HashSet::new(),
    })
  };
  let Some(state) = app.try_state::<AccountState>() else {
    return closed();
  };
  let request = match account::request_account(&state).await {
    Ok(Some(request)) => {
      account::set_reconnect_needed(app, false);
      request
    }
    Ok(None) => {
      account::set_reconnect_needed(app, false);
      return closed();
    }
    Err(error) if error == crate::device_proof::RECONNECT => {
      account::set_reconnect_needed(app, true);
      tracing::warn!(error = %error, "feature access skipped: account needs reconnecting");
      return closed();
    }
    // The Keychain did not answer (often while the computer sleeps): the
    // account is still linked, so nothing is decided until it can be read.
    Err(error) => {
      tracing::warn!(error = %error, "feature access deferred: account is unreadable now");
      return Outcome::Unknown;
    }
  };
  let namespace = Some(request.local_data_namespace());
  let expires_at = chrono::DateTime::parse_from_rfc3339(&request.credential.expires_at)
    .ok()
    .map(|expiry| expiry.with_timezone(&chrono::Utc));
  let enabled = match fetch(&request).await {
    Ok(enabled) => enabled,
    Err(FetchFailure::Unreached(error)) => {
      tracing::warn!(error = %error, "feature access deferred: the server was not reached");
      return Outcome::Unknown;
    }
    Err(FetchFailure::Refused(error)) => {
      tracing::warn!(error = %error, "feature access is unavailable; gated features stay off");
      HashSet::new()
    }
  };
  drop(request);
  Outcome::Decided(AccountDecision {
    namespace,
    expires_at,
    enabled,
  })
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

/// Asks the refresh loop to fetch now: a member who turned a feature on in the
/// browser sees it as soon as they come back to the app.
pub fn refresh_now() {
  refresh_signal().notify_one();
}

pub type FeatureChangeHandler =
  Arc<dyn Fn(&AppHandle, DesktopFeature, bool) + Send + Sync>;

/// Runs the refresh loop. `on_change` is called with every feature whose
/// state changed, after the new decision is visible through [`FeatureGates`].
pub fn start(app: AppHandle, on_change: FeatureChangeHandler) {
  tauri::async_runtime::spawn(async move {
    let mut interval = tokio::time::interval(REFRESH_INTERVAL);
    let mut wakes = crate::presence::subscribe_wakes();
    // Set while the last read could not happen: when to read again.
    let mut retry: Option<Duration> = None;
    loop {
      let retrying = async {
        match retry {
          Some(wait) => tokio::time::sleep(wait).await,
          None => std::future::pending().await,
        }
      };
      tokio::select! {
        _ = interval.tick() => {}
        () = refresh_signal().notified() => {}
        // A wake can follow a network change; the decision is read again
        // right away instead of at the next tick.
        _ = wakes.changed() => {}
        () = retrying => {}
      }
      let Some(gates) = app.try_state::<FeatureGates>() else {
        return;
      };
      let Some(generation) = gates.generation() else {
        return;
      };
      let decision = match current_decision(&app).await {
        Outcome::Decided(decision) => {
          retry = None;
          decision
        }
        Outcome::Unknown => {
          let wait = next_retry(retry);
          tracing::info!(
            retry_in_seconds = wait.as_secs(),
            "feature access read again soon"
          );
          retry = Some(wait);
          continue;
        }
      };
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
  use crate::account::LinkedAccount;

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
  fn a_server_failure_decides_nothing_and_a_refusal_turns_features_off() {
    for status in [
      reqwest::StatusCode::INTERNAL_SERVER_ERROR,
      reqwest::StatusCode::BAD_GATEWAY,
      reqwest::StatusCode::SERVICE_UNAVAILABLE,
      reqwest::StatusCode::TOO_MANY_REQUESTS,
    ] {
      assert!(
        matches!(failure_for_status(status), FetchFailure::Unreached(_)),
        "{status}"
      );
    }
    for status in [
      reqwest::StatusCode::UNAUTHORIZED,
      reqwest::StatusCode::FORBIDDEN,
      reqwest::StatusCode::NOT_FOUND,
    ] {
      assert!(
        matches!(failure_for_status(status), FetchFailure::Refused(_)),
        "{status}"
      );
    }
  }

  #[test]
  fn a_read_that_could_not_happen_is_retried_within_seconds_then_less_often() {
    let mut waits = Vec::new();
    let mut retry = None;
    for _ in 0..7 {
      let wait = next_retry(retry);
      waits.push(wait.as_secs());
      retry = Some(wait);
    }
    assert_eq!(waits, [5, 10, 20, 40, 80, 120, 120]);
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
  async fn the_request_carries_a_verified_device_proof() {
    let request = AccountRequest::fixture(LinkedAccount {
      api_base_url: "https://api.example.test".into(),
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
        key: "stella_dr_good".into(),
        expires_at: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
      },
      device_key: crate::device_proof::DeviceKey::default(),
    })
    .await;
    let built = signed_request(client().unwrap(), &request).unwrap().build();
    assert_eq!(built.method(), reqwest::Method::GET);
    assert_eq!(
      built.url().as_str(),
      format!("https://api.example.test{}", contract().path)
    );
    assert_eq!(built.headers()["authorization"], "Bearer stella_dr_good");
    crate::device_proof::tests::verify_request(
      &built,
      &request.device_key.thumbprint().unwrap(),
      Some("stella_dr_good"),
      None,
    );
  }

  #[tokio::test]
  async fn fetch_sends_the_signed_account_key_and_fails_closed_on_refusal() {
    use axum::{Router, http::HeaderMap, http::StatusCode, routing::get};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().route(
      &contract().path,
      get(|headers: HeaderMap| async move {
        let signed = headers
          .get("dpop")
          .and_then(|value| value.to_str().ok())
          .is_some_and(|proof| proof.split('.').count() == 3);
        match headers
          .get("authorization")
          .and_then(|value| value.to_str().ok())
        {
          Some("Bearer stella_dr_good") if signed => (
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
      device_key: crate::device_proof::DeviceKey::default(),
    };

    assert_eq!(
      fetch(&AccountRequest::fixture(account("stella_dr_good")).await)
        .await
        .unwrap(),
      HashSet::from([DesktopFeature::ActivityTimeline])
    );
    assert!(matches!(
      fetch(&AccountRequest::fixture(account("stella_dr_bad")).await).await,
      Err(FetchFailure::Refused(_))
    ));
    server.abort();
    let _stopped = server.await;
    // A server that is gone decides nothing.
    assert!(matches!(
      fetch(&AccountRequest::fixture(account("stella_dr_good")).await).await,
      Err(FetchFailure::Unreached(_))
    ));
  }
}
