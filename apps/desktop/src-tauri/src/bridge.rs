use axum::{
  Json, Router,
  extract::{Query, State},
  http::{HeaderMap, HeaderValue, Method, StatusCode},
  response::IntoResponse,
  routing::get,
};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::session_manager::SessionManager;
use crate::types::{BRIDGE_CAPABILITIES, BRIDGE_VERSION};

const BIND_RETRY_INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const BIND_RETRY_MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct BridgeState {
  pub account: crate::account::AccountState,
  pub manager: Arc<Mutex<SessionManager>>,
  pub static_allowed_origins: HashSet<String>,
  pub bridge_port: u16,
}

async fn is_allowed_origin(state: &BridgeState, origin: Option<&str>) -> bool {
  let Some(origin) = origin else {
    return false;
  };
  if state.static_allowed_origins.contains(origin) {
    return true;
  }

  let manager = state.manager.lock().await;
  manager.is_trusted_self_host_origin(origin)
}

fn cors_headers(origin: Option<&str>, allowed: bool) -> HeaderMap {
  let mut headers = HeaderMap::new();
  headers.insert("Content-Type", HeaderValue::from_static("application/json"));
  headers.insert("Cache-Control", HeaderValue::from_static("no-store"));

  if allowed
    && let Some(o) = origin
    && let Ok(val) = HeaderValue::from_str(o)
  {
    headers.insert("Access-Control-Allow-Origin", val);
    headers.insert(
      "Access-Control-Allow-Headers",
      HeaderValue::from_static(
        "content-type, x-stella-bridge-time, x-stella-bridge-proof",
      ),
    );
    headers.insert(
      "Access-Control-Allow-Methods",
      HeaderValue::from_static("GET, OPTIONS"),
    );
    // Chrome Private Network Access: required for localhost <-> 127.0.0.1
    headers.insert(
      "Access-Control-Allow-Private-Network",
      HeaderValue::from_static("true"),
    );
    headers.insert("Vary", HeaderValue::from_static("Origin"));
  }

  headers
}

fn get_origin(headers: &HeaderMap) -> Option<String> {
  headers
    .get("origin")
    .and_then(|v| v.to_str().ok())
    .map(|s| s.to_string())
}

fn json_response(
  status: StatusCode,
  body: serde_json::Value,
  origin: Option<&str>,
  allowed: bool,
) -> axum::response::Response {
  (cors_headers(origin, allowed), (status, Json(body))).into_response()
}

async fn health(
  State(state): State<BridgeState>,
  headers: HeaderMap,
) -> impl IntoResponse {
  let origin = get_origin(&headers);
  let origin_ref = origin.as_deref();
  let allowed = is_allowed_origin(&state, origin_ref).await;

  if origin_ref.is_some() && !allowed {
    return json_response(
      StatusCode::FORBIDDEN,
      serde_json::json!({ "message": "Desktop bridge origin is not allowed." }),
      origin_ref,
      false,
    )
    .into_response();
  }

  json_response(
    StatusCode::OK,
    serde_json::json!({
      "ok": true,
      "bridgePort": state.bridge_port,
      "bridgeVersion": BRIDGE_VERSION,
      "capabilities": BRIDGE_CAPABILITIES,
    }),
    origin_ref,
    allowed,
  )
  .into_response()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionQuery {
  correlation_id: String,
}

async fn connection_status(
  State(state): State<BridgeState>,
  headers: HeaderMap,
  Query(query): Query<ConnectionQuery>,
) -> impl IntoResponse {
  let origin = get_origin(&headers);
  let allowed = is_allowed_origin(&state, origin.as_deref()).await;
  let Ok(status) = crate::account::signed_browser_connection_status(
    &state.account,
    &query.correlation_id,
  )
  .await
  else {
    return json_response(
      StatusCode::UNAUTHORIZED,
      serde_json::json!({"message":"Desktop connection is unavailable"}),
      origin.as_deref(),
      allowed,
    );
  };
  json_response(
    StatusCode::OK,
    serde_json::json!(status),
    origin.as_deref(),
    allowed,
  )
}

async fn not_found(
  State(state): State<BridgeState>,
  headers: HeaderMap,
) -> impl IntoResponse {
  let origin = get_origin(&headers);
  let origin_ref = origin.as_deref();
  let allowed = is_allowed_origin(&state, origin_ref).await;

  json_response(
    StatusCode::NOT_FOUND,
    serde_json::json!({ "message": "Not found" }),
    origin_ref,
    allowed,
  )
  .into_response()
}

pub(crate) fn build_router(state: BridgeState) -> Router {
  Router::new()
    .route("/health", get(health))
    .route("/v1/connection", get(connection_status))
    .fallback(not_found)
    .layer(axum::middleware::from_fn_with_state(
      state.clone(),
      |State(state): State<BridgeState>,
       req: axum::extract::Request,
       next: axum::middleware::Next| async move {
        if req.method() == Method::OPTIONS {
          let headers = req.headers().clone();
          let origin = get_origin(&headers);
          let origin_ref = origin.as_deref();
          let allowed = is_allowed_origin(&state, origin_ref).await;

          return Ok::<_, std::convert::Infallible>(
            (StatusCode::NO_CONTENT, cors_headers(origin_ref, allowed)).into_response(),
          );
        }
        let origin = get_origin(req.headers());
        if !crate::account::authorize_bridge_request(
          origin.as_deref(),
          req
            .headers()
            .get("x-stella-bridge-time")
            .and_then(|v| v.to_str().ok()),
          req
            .headers()
            .get("x-stella-bridge-proof")
            .and_then(|v| v.to_str().ok()),
          req.method().as_str(),
          &req.uri().to_string(),
        ) {
          let allowed = is_allowed_origin(&state, origin.as_deref()).await;
          return Ok(
            json_response(
              StatusCode::UNAUTHORIZED,
              serde_json::json!({"message":"Desktop connection is unavailable"}),
              origin.as_deref(),
              allowed,
            )
            .into_response(),
          );
        }
        Ok(next.run(req).await)
      },
    ))
    .with_state(state)
}

pub async fn start_bridge(
  bridge_port: u16,
  static_allowed_origins: HashSet<String>,
  manager: Arc<Mutex<SessionManager>>,
  account: crate::account::AccountState,
) {
  let state = BridgeState {
    account,
    manager,
    static_allowed_origins,
    bridge_port,
  };

  let app = build_router(state);

  let addr = std::net::SocketAddr::from(([127, 0, 0, 1], bridge_port));
  tracing::info!(port = bridge_port, "HTTP bridge starting");

  // Status checks resume when the configured port becomes available.
  let mut backoff = BIND_RETRY_INITIAL_BACKOFF;
  loop {
    match tokio::net::TcpListener::bind(addr).await {
      Ok(listener) => {
        backoff = BIND_RETRY_INITIAL_BACKOFF;
        tracing::info!(port = bridge_port, "HTTP bridge listening");
        if let Err(e) = axum::serve(listener, app.clone()).await {
          tracing::error!(error = %e, "bridge server error");
        }
      }
      Err(e) => {
        tracing::warn!(error = %e, port = bridge_port, "failed to bind bridge port, retrying");
      }
    }

    tokio::time::sleep(backoff).await;
    backoff = (backoff * 2).min(BIND_RETRY_MAX_BACKOFF);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use axum::body::Body;
  use axum::http::Request;
  use tower::ServiceExt;

  fn test_state() -> BridgeState {
    BridgeState {
      account: Arc::new(Mutex::new(crate::account::AccountStore::Memory(None))),
      manager: Arc::new(Mutex::new(SessionManager::new())),
      static_allowed_origins: HashSet::from(["http://localhost:3000".to_string()]),
      bridge_port: 0,
    }
  }

  #[tokio::test]
  async fn bridge_requests_require_a_current_connection_proof() {
    for path in [
      "/health",
      "/v1/connection?correlationId=11111111-1111-4111-8111-111111111111",
      "/v1/link-account",
      "/v1/open-file",
    ] {
      let response = build_router(test_state())
        .oneshot(
          Request::builder()
            .method("GET")
            .uri(path)
            .header("origin", "http://localhost:3000")
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
      assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
  }

  #[tokio::test]
  async fn a_connection_proof_authenticates_the_request_and_response() {
    let fixture = crate::account::bridge_proof_fixture();
    let uri = format!("/v1/connection?correlationId={}", fixture.correlation_id);
    let timestamp = chrono::Utc::now().timestamp().to_string();
    let key =
      ring::hmac::Key::new(ring::hmac::HMAC_SHA256, fixture.port_secret.as_bytes());
    let proof = hex::encode(
      ring::hmac::sign(&key, format!("{timestamp}\nGET\n{uri}").as_bytes()).as_ref(),
    );
    for (origin, expected_status) in [
      ("http://localhost:3000", StatusCode::OK),
      ("https://other.example", StatusCode::UNAUTHORIZED),
    ] {
      let response = build_router(test_state())
        .oneshot(
          Request::builder()
            .method("GET")
            .uri(&uri)
            .header("origin", origin)
            .header("x-stella-bridge-time", &timestamp)
            .header("x-stella-bridge-proof", &proof)
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
      assert_eq!(response.status(), expected_status);
      if expected_status != StatusCode::OK {
        continue;
      }
      let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
      let reply: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
      assert_eq!(reply["correlationId"], fixture.correlation_id);
      assert_eq!(reply["status"], "pending");
      let timestamp = reply["timestamp"].as_str().unwrap();
      let signature = hex::decode(reply["proof"].as_str().unwrap()).unwrap();
      assert!(
        ring::hmac::verify(
          &key,
          format!("{}\npending\n{timestamp}", fixture.correlation_id).as_bytes(),
          &signature
        )
        .is_ok()
      );
      assert!(
        ring::hmac::verify(
          &key,
          format!("{}\nconnected\n{timestamp}", fixture.correlation_id).as_bytes(),
          &signature
        )
        .is_err()
      );
    }
  }

  #[tokio::test]
  async fn preflight_declares_connection_proof_headers() {
    let response = build_router(test_state())
      .oneshot(
        Request::builder()
          .method("OPTIONS")
          .uri("/health")
          .header("origin", "http://localhost:3000")
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(
      response.headers()["access-control-allow-headers"]
        .to_str()
        .unwrap()
        .contains("x-stella-bridge-proof")
    );
  }
}
