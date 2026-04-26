use axum::{
  extract::State,
  http::{HeaderMap, HeaderValue, Method, StatusCode},
  response::IntoResponse,
  routing::{get, post},
  Json, Router,
};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::session_manager::SessionManager;
use crate::types::OpenDocxRequest;

#[derive(Clone)]
pub struct BridgeState {
  pub manager: Arc<Mutex<SessionManager>>,
  pub allowed_origins: HashSet<String>,
  pub bridge_port: u16,
}

fn is_allowed_origin(state: &BridgeState, origin: Option<&str>) -> bool {
  origin
    .map(|o| state.allowed_origins.contains(o))
    .unwrap_or(false)
}

fn cors_headers(origin: Option<&str>, allowed: bool) -> HeaderMap {
  let mut headers = HeaderMap::new();
  headers.insert("Content-Type", HeaderValue::from_static("application/json"));

  if allowed {
    if let Some(o) = origin {
      if let Ok(val) = HeaderValue::from_str(o) {
        headers.insert("Access-Control-Allow-Origin", val);
        headers.insert(
          "Access-Control-Allow-Headers",
          HeaderValue::from_static("content-type"),
        );
        headers.insert(
          "Access-Control-Allow-Methods",
          HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        // Chrome Private Network Access: required for localhost <-> 127.0.0.1
        headers.insert(
          "Access-Control-Allow-Private-Network",
          HeaderValue::from_static("true"),
        );
        headers.insert("Vary", HeaderValue::from_static("Origin"));
      }
    }
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
) -> impl IntoResponse {
  (cors_headers(origin, allowed), (status, Json(body)))
}

async fn health(
  State(state): State<BridgeState>,
  headers: HeaderMap,
) -> impl IntoResponse {
  let origin = get_origin(&headers);
  let origin_ref = origin.as_deref();

  if origin_ref.is_some() && !is_allowed_origin(&state, origin_ref) {
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
    serde_json::json!({ "ok": true, "bridgePort": state.bridge_port }),
    origin_ref,
    is_allowed_origin(&state, origin_ref),
  )
  .into_response()
}

async fn open_docx(
  State(state): State<BridgeState>,
  headers: HeaderMap,
  Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
  let origin = get_origin(&headers);
  let origin_ref = origin.as_deref();

  if !is_allowed_origin(&state, origin_ref) {
    return json_response(
      StatusCode::FORBIDDEN,
      serde_json::json!({
          "message": "Desktop bridge only accepts requests from allowed stella origins."
      }),
      origin_ref,
      false,
    )
    .into_response();
  }

  let request: OpenDocxRequest = match serde_json::from_value(body) {
    Ok(r) => r,
    Err(_) => {
      return json_response(
        StatusCode::BAD_REQUEST,
        serde_json::json!({ "message": "Invalid open-docx payload" }),
        origin_ref,
        true,
      )
      .into_response();
    }
  };

  // Clone the HTTP client while briefly holding the lock, then download
  // outside the lock to avoid blocking health checks during network I/O.
  let http_client = {
    let mgr = state.manager.lock().await;
    mgr.http_client().clone()
  };

  let prefetched = crate::session_manager::download_docx_standalone(
    &http_client,
    &request.remote_session.download_url,
  )
  .await;

  let prefetched_buffer = match prefetched {
    Ok(buf) => Some(buf),
    Err(e) => {
      return json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        serde_json::json!({ "message": e }),
        origin_ref,
        true,
      )
      .into_response();
    }
  };

  let result = {
    let mut manager = state.manager.lock().await;
    manager.open_docx(request, prefetched_buffer).await
  };

  match result {
    Ok(ref result_data) => {
      // Attach file watcher outside the lock
      crate::session_manager::SessionManager::attach_watcher(
        &state.manager,
        &result_data.session_id,
      )
      .await;

      // Start SSE listener for real-time session events (skips if already active)
      {
        let mut mgr = state.manager.lock().await;
        mgr.ensure_sse_listener(&state.manager, &result_data.session_id);
      }

      let body = serde_json::to_value(result_data).unwrap_or_default();
      json_response(StatusCode::OK, body, origin_ref, true).into_response()
    }
    Err(message) => json_response(
      StatusCode::INTERNAL_SERVER_ERROR,
      serde_json::json!({ "message": message }),
      origin_ref,
      true,
    )
    .into_response(),
  }
}

async fn not_found(
  State(state): State<BridgeState>,
  headers: HeaderMap,
) -> impl IntoResponse {
  let origin = get_origin(&headers);
  let origin_ref = origin.as_deref();
  let allowed = is_allowed_origin(&state, origin_ref);

  json_response(
    StatusCode::NOT_FOUND,
    serde_json::json!({ "message": "Not found" }),
    origin_ref,
    allowed,
  )
  .into_response()
}

pub async fn start_bridge(
  bridge_port: u16,
  allowed_origins: HashSet<String>,
  manager: Arc<Mutex<SessionManager>>,
) {
  let state = BridgeState {
    manager,
    allowed_origins,
    bridge_port,
  };

  let app = Router::new()
    .route("/health", get(health))
    .route("/v1/open-docx", post(open_docx))
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
          let allowed = is_allowed_origin(&state, origin_ref);

          return Ok::<_, std::convert::Infallible>(
            (StatusCode::NO_CONTENT, cors_headers(origin_ref, allowed)).into_response(),
          );
        }
        Ok(next.run(req).await)
      },
    ))
    .with_state(state);

  let addr = std::net::SocketAddr::from(([127, 0, 0, 1], bridge_port));
  tracing::info!(port = bridge_port, "HTTP bridge starting");

  let listener = match tokio::net::TcpListener::bind(addr).await {
    Ok(l) => l,
    Err(e) => {
      tracing::error!(error = %e, "failed to bind bridge port");
      return;
    }
  };

  if let Err(e) = axum::serve(listener, app).await {
    tracing::error!(error = %e, "bridge server error");
  }
}
