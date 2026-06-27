//! End-to-end tests for the desktop app's external interfaces.
//!
//! Unlike the in-process `tower::oneshot` unit tests in [`crate::bridge`], these
//! boot the real Axum bridge on a real loopback socket and drive it with a real
//! HTTP client. They exercise the wire contract the web app actually depends on:
//! status codes, CORS headers, preflight handling, and the self-host trust
//! round trip.
//!
//! This module is the shared harness for desktop e2e coverage. Extend
//! [`spawn_test_bridge`] (or add sibling submodules) as more surfaces become
//! drivable end to end.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::bridge::start_bridge;
use crate::session_manager::SessionManager;
use crate::types::{BRIDGE_CAPABILITIES, BRIDGE_VERSION};

const ALLOWED_ORIGIN: &str = "http://localhost:3000";
const DISALLOWED_ORIGIN: &str = "https://evil.example";

/// A bridge server bound to an ephemeral loopback port for the lifetime of a
/// test, plus a handle to the [`SessionManager`] backing it so a test can seed
/// trust state before driving requests.
struct TestBridge {
  base_url: String,
  manager: Arc<Mutex<SessionManager>>,
}

impl TestBridge {
  fn client() -> reqwest::Client {
    reqwest::Client::new()
  }

  fn url(&self, path: &str) -> String {
    format!("{}{path}", self.base_url)
  }

  async fn wait_until_ready(&self) {
    let client = Self::client();
    for _ in 0..100 {
      if let Ok(response) = client.get(self.url("/health")).send().await
        && response.status().is_success()
      {
        return;
      }
      tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("test bridge never served a healthy response");
  }

  /// GET `/v1/self-host-connection` for a web origin / API pair, returning the
  /// decoded JSON body.
  async fn self_host_connection(
    &self,
    origin: &str,
    api_base_url: &str,
  ) -> serde_json::Value {
    let url = reqwest::Url::parse_with_params(
      &self.url("/v1/self-host-connection"),
      &[("apiBaseUrl", api_base_url)],
    )
    .expect("build self-host-connection url");
    let response = Self::client()
      .get(url)
      .header("origin", origin)
      .send()
      .await
      .expect("self-host-connection request");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    response.json().await.expect("self-host-connection body")
  }
}

async fn spawn_test_bridge() -> TestBridge {
  spawn_test_bridge_with_origins(HashSet::from([ALLOWED_ORIGIN.to_string()])).await
}

async fn spawn_test_bridge_with_origins(
  static_allowed_origins: HashSet<String>,
) -> TestBridge {
  // Drive the real production entry point (bind + serve) rather than a test-only
  // router so the harness exercises the same code path the app runs. Bind a
  // throwaway socket to claim a free loopback port, then hand it to start_bridge.
  let port = free_loopback_port().await;
  let manager = Arc::new(Mutex::new(SessionManager::new()));

  tokio::spawn(start_bridge(port, static_allowed_origins, manager.clone()));

  let bridge = TestBridge {
    base_url: format!("http://127.0.0.1:{port}"),
    manager,
  };
  bridge.wait_until_ready().await;
  bridge
}

async fn free_loopback_port() -> u16 {
  let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
    .await
    .expect("bind probe socket");
  listener.local_addr().expect("resolve probe address").port()
}

fn open_docx_body(session_id: &str) -> serde_json::Value {
  serde_json::json!({
    "apiBaseUrl": "https://api.example.com",
    "entityId": "11111111-1111-1111-1111-111111111111",
    "linkedAccount": null,
    "propertyId": "22222222-2222-2222-2222-222222222222",
    "remoteSession": {
      "baseVersionNumber": 1,
      "downloadUrl": "https://example.com/doc.docx",
      "fileName": "doc.docx",
      "lastCheckpointAt": null,
      "resumedFromCheckpoint": false,
      "sessionId": session_id,
      "sessionToken": "token",
      "tookOverExistingSession": false,
    },
    "workspaceId": "33333333-3333-3333-3333-333333333333",
  })
}

#[tokio::test]
async fn health_reports_bridge_contract_over_real_socket() {
  let bridge = spawn_test_bridge().await;

  let response = TestBridge::client()
    .get(bridge.url("/health"))
    .header("origin", ALLOWED_ORIGIN)
    .send()
    .await
    .unwrap();

  assert_eq!(response.status(), reqwest::StatusCode::OK);
  assert_eq!(
    response
      .headers()
      .get("access-control-allow-origin")
      .unwrap(),
    ALLOWED_ORIGIN
  );

  let body: serde_json::Value = response.json().await.unwrap();
  assert_eq!(body["ok"], serde_json::json!(true));
  assert_eq!(body["bridgeVersion"], serde_json::json!(BRIDGE_VERSION));
  assert_eq!(body["capabilities"], serde_json::json!(BRIDGE_CAPABILITIES));
}

#[tokio::test]
async fn health_allows_request_without_origin_but_omits_cors_header() {
  let bridge = spawn_test_bridge().await;

  let response = TestBridge::client()
    .get(bridge.url("/health"))
    .send()
    .await
    .unwrap();

  // A browser-less probe (no Origin) is allowed, but must not be granted a
  // cross-origin grant header.
  assert_eq!(response.status(), reqwest::StatusCode::OK);
  assert!(
    response
      .headers()
      .get("access-control-allow-origin")
      .is_none()
  );
}

#[tokio::test]
async fn health_rejects_disallowed_origin() {
  let bridge = spawn_test_bridge().await;

  let response = TestBridge::client()
    .get(bridge.url("/health"))
    .header("origin", DISALLOWED_ORIGIN)
    .send()
    .await
    .unwrap();

  assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn cors_preflight_advertises_contract_for_allowed_origin() {
  let bridge = spawn_test_bridge().await;

  let response = TestBridge::client()
    .request(reqwest::Method::OPTIONS, bridge.url("/v1/open-docx"))
    .header("origin", ALLOWED_ORIGIN)
    .header("access-control-request-method", "POST")
    .send()
    .await
    .unwrap();

  assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
  let headers = response.headers();
  assert_eq!(
    headers.get("access-control-allow-origin").unwrap(),
    ALLOWED_ORIGIN
  );
  assert!(
    headers
      .get("access-control-allow-methods")
      .unwrap()
      .to_str()
      .unwrap()
      .contains("POST")
  );
  // Chrome Private Network Access: the bridge lives on loopback, so it must
  // grant localhost <-> 127.0.0.1 calls.
  assert_eq!(
    headers.get("access-control-allow-private-network").unwrap(),
    "true"
  );
}

#[tokio::test]
async fn open_docx_rejects_disallowed_origin() {
  let bridge = spawn_test_bridge().await;

  let response = TestBridge::client()
    .post(bridge.url("/v1/open-docx"))
    .header("origin", DISALLOWED_ORIGIN)
    .json(&open_docx_body("e8400e29-1d4a-4716-8a3a-2c83de7ab2e6"))
    .send()
    .await
    .unwrap();

  assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn open_docx_rejects_invalid_session_id() {
  let bridge = spawn_test_bridge().await;

  let response = TestBridge::client()
    .post(bridge.url("/v1/open-docx"))
    .header("origin", ALLOWED_ORIGIN)
    .json(&open_docx_body("../etc/passwd"))
    .send()
    .await
    .unwrap();

  assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn self_host_connection_round_trip_over_real_socket() {
  let bridge = spawn_test_bridge().await;
  {
    let mut manager = bridge.manager.lock().await;
    manager.trust_self_host_connection_for_test(
      "https://web.example".to_string(),
      "https://api.example".to_string(),
    );
  }

  // The approved web/API pair reads back as trusted...
  let approved = bridge
    .self_host_connection("https://web.example", "https://api.example")
    .await;
  assert_eq!(approved["trusted"], serde_json::json!(true));

  // ...but the same (now trusted) origin asking about a different API does not.
  let mismatched = bridge
    .self_host_connection("https://web.example", "https://other.example")
    .await;
  assert_eq!(mismatched["trusted"], serde_json::json!(false));
}

#[tokio::test]
async fn self_host_connection_rejects_untrusted_origin() {
  let bridge = spawn_test_bridge().await;

  let url = reqwest::Url::parse_with_params(
    &bridge.url("/v1/self-host-connection"),
    &[("apiBaseUrl", "https://api.example")],
  )
  .unwrap();
  let response = TestBridge::client()
    .get(url)
    .header("origin", "https://stranger.example")
    .send()
    .await
    .unwrap();

  assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn unknown_path_returns_not_found() {
  let bridge = spawn_test_bridge().await;

  let response = TestBridge::client()
    .get(bridge.url("/v1/does-not-exist"))
    .header("origin", ALLOWED_ORIGIN)
    .send()
    .await
    .unwrap();

  assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
}
