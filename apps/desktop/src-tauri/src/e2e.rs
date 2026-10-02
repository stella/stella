//! HTTP contract tests for the desktop status bridge.

use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::bridge::{BridgeState, build_router};
use crate::session_manager::SessionManager;

const ALLOWED_ORIGIN: &str = "http://localhost:3000";

struct TestBridge {
  base_url: String,
  task: tokio::task::JoinHandle<()>,
}

impl TestBridge {
  fn client() -> crate::http_client::DesktopHttpClient {
    crate::http_client::DesktopHttpClient::new(Default::default()).unwrap()
  }

  fn url(&self, path: &str) -> String {
    format!("{}{path}", self.base_url)
  }
}

impl Drop for TestBridge {
  fn drop(&mut self) {
    self.task.abort();
  }
}

async fn spawn_test_bridge() -> TestBridge {
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let address = listener.local_addr().unwrap();
  let router = build_router(BridgeState {
    account: Arc::new(Mutex::new(crate::account::AccountStore::Memory(None))),
    manager: Arc::new(Mutex::new(SessionManager::new())),
    static_allowed_origins: HashSet::from([ALLOWED_ORIGIN.to_string()]),
    bridge_port: address.port(),
  });
  let task = tokio::spawn(async move {
    axum::serve(listener, router).await.unwrap();
  });
  TestBridge {
    base_url: format!("http://{address}"),
    task,
  }
}

#[tokio::test]
async fn status_requests_require_a_connection_proof_over_http() {
  let bridge = spawn_test_bridge().await;
  let client = TestBridge::client();
  for path in [
    "/health",
    "/v1/connection?correlationId=11111111-1111-4111-8111-111111111111",
  ] {
    for origin in [
      None,
      Some(ALLOWED_ORIGIN),
      Some("https://other.example.test"),
    ] {
      let mut request = client.get(bridge.url(path));
      if let Some(origin) = origin {
        request = request.header("origin", origin);
      }
      let response = request.send().await.unwrap();
      assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
      assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
      if origin == Some(ALLOWED_ORIGIN) {
        assert_eq!(
          response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
          ALLOWED_ORIGIN
        );
      } else {
        assert!(
          response
            .headers()
            .get("access-control-allow-origin")
            .is_none()
        );
      }
    }
  }
}

#[tokio::test]
async fn preflight_declares_read_methods_and_proof_headers_over_http() {
  let bridge = spawn_test_bridge().await;
  let response = TestBridge::client()
    .request(reqwest::Method::OPTIONS, bridge.url("/v1/connection"))
    .header("origin", ALLOWED_ORIGIN)
    .header("access-control-request-method", "GET")
    .send()
    .await
    .unwrap();
  assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
  let headers = response.headers();
  assert_eq!(
    headers.get("access-control-allow-origin").unwrap(),
    ALLOWED_ORIGIN
  );
  assert_eq!(
    headers.get("access-control-allow-methods").unwrap(),
    "GET, OPTIONS"
  );
  assert!(
    headers
      .get("access-control-allow-headers")
      .unwrap()
      .to_str()
      .unwrap()
      .contains("x-stella-bridge-proof")
  );
  assert_eq!(
    headers.get("access-control-allow-private-network").unwrap(),
    "true"
  );
}

#[tokio::test]
async fn bridge_commands_are_not_available_over_http() {
  let bridge = spawn_test_bridge().await;
  for path in ["/v1/link-account", "/v1/open-file"] {
    let response = TestBridge::client()
      .post(bridge.url(path))
      .header("origin", ALLOWED_ORIGIN)
      .json(
        &serde_json::json!({"correlationId":"11111111-1111-4111-8111-111111111111"}),
      )
      .send()
      .await
      .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
  }
}
