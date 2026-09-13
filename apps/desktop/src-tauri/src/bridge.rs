use axum::{
  Json, Router,
  extract::{Query, State},
  http::{HeaderMap, HeaderValue, Method, StatusCode},
  response::IntoResponse,
  routing::{get, post},
};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::session_manager::{LinkedAccountOriginUpdate, SessionManager};
use crate::types::{
  BRIDGE_CAPABILITIES, BRIDGE_VERSION, LinkAccountRequest, OpenFileRequest,
  is_safe_session_id,
};

const BIND_RETRY_INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const BIND_RETRY_MAX_BACKOFF: Duration = Duration::from_secs(30);

pub type AccountNotifier = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub struct BridgeState {
  pub account: crate::account::AccountState,
  pub manager: Arc<Mutex<SessionManager>>,
  pub static_allowed_origins: HashSet<String>,
  pub bridge_port: u16,
  /// Runs after the account link changes so every desktop surface can refresh.
  pub notify_account: AccountNotifier,
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
#[serde(rename_all = "camelCase")]
struct ApiBaseUrlQuery {
  api_base_url: String,
}

async fn account_status(
  State(state): State<BridgeState>,
  headers: HeaderMap,
  Query(query): Query<ApiBaseUrlQuery>,
) -> axum::response::Response {
  let origin = get_origin(&headers);
  let origin_ref = origin.as_deref();
  if !is_allowed_origin(&state, origin_ref).await {
    return json_response(
      StatusCode::FORBIDDEN,
      serde_json::json!({"message":"Desktop bridge origin is not allowed."}),
      origin_ref,
      false,
    )
    .into_response();
  }
  let Ok(api_base_url) =
    crate::config::normalize_self_host_api_base_url(&query.api_base_url)
  else {
    return json_response(
      StatusCode::BAD_REQUEST,
      serde_json::json!({"message":"Invalid desktop account server"}),
      origin_ref,
      true,
    )
    .into_response();
  };
  let Ok(saved) = crate::account::current(&state.account).await else {
    return json_response(
      StatusCode::SERVICE_UNAVAILABLE,
      serde_json::json!({"message":"Desktop account is unavailable"}),
      origin_ref,
      true,
    )
    .into_response();
  };
  let snapshot = if let Some(saved) = saved {
    if saved.api_base_url != api_base_url
      || Some(saved.web_origin.as_str()) != origin_ref
    {
      return json_response(StatusCode::CONFLICT,
        serde_json::json!({"message":"Disconnect the current desktop account before connecting another"}),
        origin_ref, true).into_response();
    }
    match crate::registry::request(
      saved.request_auth(),
      serde_json::json!({"type":"config"}),
    )
    .await
    {
      Ok(_) => saved.snapshot(),
      Err(error) if error == crate::registry::not_connected() => {
        if crate::account::invalidate(&state.account, &saved)
          .await
          .is_err()
        {
          return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({"message":"Desktop account is unavailable"}),
            origin_ref,
            true,
          )
          .into_response();
        }
        (state.notify_account)();
        crate::types::DesktopAccountSnapshot::Disconnected
      }
      Err(_) => {
        return json_response(
          StatusCode::SERVICE_UNAVAILABLE,
          serde_json::json!({"message":"Desktop account verification is unavailable"}),
          origin_ref,
          true,
        )
        .into_response();
      }
    }
  } else {
    crate::types::DesktopAccountSnapshot::Disconnected
  };
  json_response(
    StatusCode::OK,
    serde_json::json!(snapshot),
    origin_ref,
    true,
  )
  .into_response()
}

async fn self_host_connection(
  State(state): State<BridgeState>,
  headers: HeaderMap,
  Query(query): Query<ApiBaseUrlQuery>,
) -> impl IntoResponse {
  let origin = get_origin(&headers);
  let origin_ref = origin.as_deref();
  let allowed = is_allowed_origin(&state, origin_ref).await;

  if origin_ref.is_none() || !allowed {
    return json_response(
      StatusCode::FORBIDDEN,
      serde_json::json!({ "message": "Desktop bridge origin is not allowed." }),
      origin_ref,
      false,
    )
    .into_response();
  }

  let trusted = {
    let manager = state.manager.lock().await;
    manager.is_trusted_self_host_connection(
      origin_ref.unwrap_or_default(),
      &query.api_base_url,
    )
  };

  json_response(
    StatusCode::OK,
    serde_json::json!({ "trusted": trusted }),
    origin_ref,
    true,
  )
  .into_response()
}

async fn open_file_request(
  State(state): State<BridgeState>,
  headers: HeaderMap,
  Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
  let origin = get_origin(&headers);
  let origin_ref = origin.as_deref();
  let allowed = is_allowed_origin(&state, origin_ref).await;

  if !allowed {
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

  let request: OpenFileRequest = match serde_json::from_value(body) {
    Ok(r) => r,
    Err(_) => {
      return json_response(
        StatusCode::BAD_REQUEST,
        serde_json::json!({ "message": "Invalid desktop file payload" }),
        origin_ref,
        allowed,
      )
      .into_response();
    }
  };

  if !is_safe_session_id(&request.remote_session.session_id) {
    return json_response(
      StatusCode::BAD_REQUEST,
      serde_json::json!({ "message": "Invalid desktop file payload" }),
      origin_ref,
      allowed,
    )
    .into_response();
  }

  // A dynamically trusted self-host origin is approved as an exact
  // web-origin/API pair. Static origins ship with the build and are always
  // allowed, but a self-host origin must not download/sync against an API it
  // was never approved for, so re-check the connection against the payload's
  // `apiBaseUrl`.
  let is_static_origin = state
    .static_allowed_origins
    .contains(origin_ref.unwrap_or_default());
  let trusted_self_host_connection = {
    let manager = state.manager.lock().await;
    manager.is_trusted_self_host_connection(
      origin_ref.unwrap_or_default(),
      &request.api_base_url,
    )
  };
  if !is_static_origin && !trusted_self_host_connection {
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
  let linked_account_web_origin =
    trusted_self_host_connection.then(|| origin_ref.unwrap_or_default().to_string());

  // Clone the HTTP client while briefly holding the lock, then download
  // outside the lock to avoid blocking health checks during network I/O.
  let http_client = {
    let mgr = state.manager.lock().await;
    mgr.http_client().clone()
  };

  let prefetched = crate::session_manager::download_file_standalone(
    request.remote_session.file_type,
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
        allowed,
      )
      .into_response();
    }
  };

  let result = {
    let mut manager = state.manager.lock().await;
    manager
      .open_file(
        request,
        prefetched_buffer,
        LinkedAccountOriginUpdate::Replace(linked_account_web_origin),
      )
      .await
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
      json_response(StatusCode::OK, body, origin_ref, allowed).into_response()
    }
    Err(message) => json_response(
      StatusCode::INTERNAL_SERVER_ERROR,
      serde_json::json!({ "message": message }),
      origin_ref,
      allowed,
    )
    .into_response(),
  }
}

async fn link_account(
  State(state): State<BridgeState>,
  headers: HeaderMap,
  Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
  let origin = get_origin(&headers);
  let origin_ref = origin.as_deref();
  let allowed = is_allowed_origin(&state, origin_ref).await;

  if !allowed {
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

  let Ok(request) = serde_json::from_value::<LinkAccountRequest>(body) else {
    return json_response(
      StatusCode::BAD_REQUEST,
      serde_json::json!({ "message": "Invalid linked account payload" }),
      origin_ref,
      allowed,
    )
    .into_response();
  };

  let is_static_origin = state
    .static_allowed_origins
    .contains(origin_ref.unwrap_or_default());
  let trusted_self_host_connection = {
    let manager = state.manager.lock().await;
    manager.is_trusted_self_host_connection(
      origin_ref.unwrap_or_default(),
      &request.api_base_url,
    )
  };
  if !is_static_origin && !trusted_self_host_connection {
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

  let trusted_api = trusted_self_host_connection
    || is_static_origin
      && crate::config::resolve_trusted_api_base_urls().contains(
        &crate::config::normalize_api_base_url(&request.api_base_url),
      );
  if !trusted_api {
    return json_response(
      StatusCode::FORBIDDEN,
      serde_json::json!({"message":"Desktop account connection is not allowed"}),
      origin_ref,
      allowed,
    )
    .into_response();
  }
  match crate::account::link(&state.account, request, origin_ref.unwrap_or_default())
    .await
  {
    Ok(crate::account::LinkOutcome::Linked) => (state.notify_account)(),
    Ok(crate::account::LinkOutcome::Unchanged) => {}
    Err(error) => {
      tracing::warn!(reason = %error, "desktop account link failed");
      return json_response(
        StatusCode::BAD_REQUEST,
        serde_json::json!({"message":"Desktop account connection failed"}),
        origin_ref,
        allowed,
      )
      .into_response();
    }
  }

  json_response(
    StatusCode::OK,
    serde_json::json!({ "linked": true }),
    origin_ref,
    allowed,
  )
  .into_response()
}

async fn open_file(
  state: State<BridgeState>,
  headers: HeaderMap,
  body: Json<serde_json::Value>,
) -> impl IntoResponse {
  open_file_request(state, headers, body).await
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

fn build_router(state: BridgeState) -> Router {
  Router::new()
    .route("/health", get(health))
    .route("/v1/self-host-connection", get(self_host_connection))
    .route("/v1/link-account", post(link_account))
    .route("/v1/account", get(account_status))
    .route("/v1/open-file", post(open_file))
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
  notify_account: AccountNotifier,
) {
  let state = BridgeState {
    account,
    manager,
    static_allowed_origins,
    bridge_port,
    notify_account,
  };

  let app = build_router(state);

  let addr = std::net::SocketAddr::from(([127, 0, 0, 1], bridge_port));
  tracing::info!(port = bridge_port, "HTTP bridge starting");

  // The bridge is the primary handoff transport while the app runs, so a
  // transiently occupied port must not disable it for the whole app
  // lifetime: keep retrying with capped backoff.
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
  use axum::body::{Body, to_bytes};
  use axum::http::Request;
  use tower::ServiceExt;

  fn test_state() -> BridgeState {
    let mut allowed = HashSet::new();
    allowed.insert("http://localhost:3000".to_string());
    BridgeState {
      account: Arc::new(Mutex::new(crate::account::AccountStore::Memory(None))),
      manager: Arc::new(Mutex::new(SessionManager::new())),
      static_allowed_origins: allowed,
      bridge_port: 0,
      notify_account: Arc::new(|| ()),
    }
  }

  fn open_file_body(session_id: &str) -> serde_json::Value {
    serde_json::json!({
      "apiBaseUrl": "https://api.example.com",
      "entityId": "11111111-1111-1111-1111-111111111111",
      "linkedAccount": null,
      "propertyId": "22222222-2222-2222-2222-222222222222",
      "remoteSession": {
        "baseVersionNumber": 1,
        "downloadUrl": "https://example.com/doc.docx",
        "fileType": "docx",
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
  async fn health_advertises_bridge_contract() {
    let app = build_router(test_state());
    let request = Request::builder()
      .method("GET")
      .uri("/health")
      .header("origin", "http://localhost:3000")
      .body(Body::empty())
      .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), 65_536).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["ok"], serde_json::json!(true));
    assert_eq!(value["bridgeVersion"], serde_json::json!(BRIDGE_VERSION));
    assert_eq!(
      value["capabilities"],
      serde_json::json!(BRIDGE_CAPABILITIES)
    );
  }

  #[tokio::test]
  async fn self_host_connection_accepts_trusted_origin() {
    let state = test_state();
    {
      let mut manager = state.manager.lock().await;
      manager.trust_self_host_connection_for_test(
        "https://web-production.example".to_string(),
        "https://api-production.example".to_string(),
      );
    }

    let app = build_router(state);
    let request = Request::builder()
      .method("GET")
      .uri("/v1/self-host-connection?apiBaseUrl=https%3A%2F%2Fapi-production.example")
      .header("origin", "https://web-production.example")
      .body(Body::empty())
      .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
      response
        .headers()
        .get("access-control-allow-origin")
        .unwrap(),
      "https://web-production.example"
    );

    let body = to_bytes(response.into_body(), 65_536).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["trusted"], serde_json::json!(true));
  }

  async fn post_open_file(state: BridgeState, body: serde_json::Value) -> StatusCode {
    let app = build_router(state);
    let request = Request::builder()
      .method("POST")
      .uri("/v1/open-file")
      .header("origin", "http://localhost:3000")
      .header("content-type", "application/json")
      .body(Body::from(serde_json::to_vec(&body).unwrap()))
      .unwrap();

    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    // Drain the body so tracing/log lines for the response complete.
    let _ = to_bytes(response.into_body(), 65_536).await.unwrap();
    status
  }

  #[tokio::test]
  async fn open_file_rejects_invalid_session_id() {
    let status = post_open_file(test_state(), open_file_body("../etc/passwd")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
  }

  #[tokio::test]
  async fn generic_open_file_route_is_exposed() {
    let app = build_router(test_state());
    let request = Request::builder()
      .method(Method::OPTIONS)
      .uri("/v1/open-file")
      .header("origin", "http://localhost:3000")
      .body(Body::empty())
      .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
  }

  #[tokio::test]
  async fn open_file_rejects_self_host_origin_with_unapproved_api() {
    let state = test_state();
    {
      let mut manager = state.manager.lock().await;
      manager.trust_self_host_connection_for_test(
        "https://web-production.example".to_string(),
        "https://api-production.example".to_string(),
      );
    }

    // The origin is trusted, but the payload targets a different API than the
    // one approved for this connection, so it must be rejected before any
    // download is attempted.
    let app = build_router(state);
    let request = Request::builder()
      .method("POST")
      .uri("/v1/open-file")
      .header("origin", "https://web-production.example")
      .header("content-type", "application/json")
      .body(Body::from(
        serde_json::to_vec(&open_file_body("e8400e29-1d4a-4716-8a3a-2c83de7ab2e6"))
          .unwrap(),
      ))
      .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
  }

  #[tokio::test]
  async fn open_file_rejects_disallowed_origin() {
    let app = build_router(test_state());
    let request = Request::builder()
      .method("POST")
      .uri("/v1/open-file")
      .header("origin", "https://evil.example")
      .header("content-type", "application/json")
      .body(Body::from(
        serde_json::to_vec(&open_file_body("e8400e29-1d4a-4716-8a3a-2c83de7ab2e6"))
          .unwrap(),
      ))
      .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
  }

  #[tokio::test]
  async fn link_account_rejects_invalid_payload() {
    let app = build_router(test_state());
    let request = Request::builder()
      .method("POST")
      .uri("/v1/link-account")
      .header("origin", "http://localhost:3000")
      .header("content-type", "application/json")
      .body(Body::from(
        serde_json::to_vec(&serde_json::json!({
          "apiBaseUrl": "https://api.example.com",
          "linkedAccount": {
            "email": "not-an-email",
            "name": null,
            "verifiedAt": "not-a-time"
          }
        }))
        .unwrap(),
      ))
      .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
  }

  struct AccountLinkHarness {
    router: Router,
    account: crate::account::AccountState,
    notifications: Arc<std::sync::atomic::AtomicUsize>,
    api_url: String,
    server: tokio::task::JoinHandle<()>,
  }

  impl AccountLinkHarness {
    async fn new(status: StatusCode, store: crate::account::AccountStore) -> Self {
      let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
      let api_url = format!("http://{}", listener.local_addr().unwrap());
      let api = Router::new().route(
        "/v1/desktop-registry/request",
        post(move || async move {
          (
            status,
            Json(serde_json::json!({"registries":[], "defaultRegistryId":null, "identity":{"userId":"user_fixture","organizationId":"org_fixture"}, "account": {"email":"desktop@example.test", "name":"Desktop Account", "verifiedAt":chrono::Utc::now().to_rfc3339()}})),
          )
        }),
      );
      let server = tokio::spawn(async move {
        axum::serve(listener, api).await.unwrap();
      });
      let mut state = test_state();
      state
        .manager
        .lock()
        .await
        .trust_self_host_connection_for_test(
          "http://localhost:3000".into(),
          api_url.clone(),
        );
      state.account = Arc::new(Mutex::new(store));
      let notifications = Arc::new(std::sync::atomic::AtomicUsize::new(0));
      let observed = Arc::clone(&notifications);
      state.notify_account = Arc::new(move || {
        observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
      });
      Self {
        account: Arc::clone(&state.account),
        router: build_router(state),
        notifications,
        api_url,
        server,
      }
    }

    fn payload(&self) -> serde_json::Value {
      serde_json::to_value(LinkAccountRequest {
        api_base_url: self.api_url.clone(),
        credential: crate::types::DesktopAccountCredential {
          key: "stella_dr_fixture".into(),
          expires_at: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        },
      })
      .unwrap()
    }

    async fn status(
      &self,
      origin: Option<&str>,
      api_base_url: &str,
    ) -> axum::response::Response {
      let mut url = reqwest::Url::parse("http://localhost/v1/account").unwrap();
      url
        .query_pairs_mut()
        .append_pair("apiBaseUrl", api_base_url);
      let mut request =
        Request::builder().uri(format!("{}?{}", url.path(), url.query().unwrap()));
      if let Some(origin) = origin {
        request = request.header("origin", origin);
      }
      self
        .router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
    }

    async fn link(&self, body: serde_json::Value) -> axum::response::Response {
      let request = Request::builder()
        .method("POST")
        .uri("/v1/link-account")
        .header("origin", "http://localhost:3000")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
      self.router.clone().oneshot(request).await.unwrap()
    }
  }

  impl Drop for AccountLinkHarness {
    fn drop(&mut self) {
      self.server.abort();
    }
  }

  #[tokio::test]
  async fn account_link_commits_profile_and_search_access_in_one_event() {
    let harness = AccountLinkHarness::new(
      StatusCode::OK,
      crate::account::AccountStore::Memory(None),
    )
    .await;
    let response = harness.link(harness.payload()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
      harness.link(harness.payload()).await.status(),
      StatusCode::OK
    );
    let linked = crate::account::current(&harness.account)
      .await
      .unwrap()
      .unwrap();
    assert_eq!(linked.account.email, "desktop@example.test");
    assert_eq!(linked.credential.key, "stella_dr_fixture");
    assert_eq!(linked.web_origin, "http://localhost:3000");
    assert_eq!(linked.api_base_url, harness.api_url);
    assert!(
      crate::registry::request(
        linked.request_auth(),
        serde_json::json!({"type":"search", "registry":"ares", "query":"fixture"})
      )
      .await
      .is_ok()
    );
    assert_eq!(
      harness
        .notifications
        .load(std::sync::atomic::Ordering::SeqCst),
      1
    );
  }

  #[tokio::test]
  async fn account_preflight_is_origin_bound_and_never_exposes_credentials() {
    let harness = AccountLinkHarness::new(
      StatusCode::OK,
      crate::account::AccountStore::Memory(None),
    )
    .await;
    for origin in [None, Some("https://evil.example")] {
      assert_eq!(
        harness.status(origin, &harness.api_url).await.status(),
        StatusCode::FORBIDDEN
      );
    }
    let empty = harness
      .status(Some("http://localhost:3000"), &harness.api_url)
      .await;
    assert_eq!(empty.status(), StatusCode::OK);
    assert_eq!(
      serde_json::from_slice::<serde_json::Value>(
        &to_bytes(empty.into_body(), 4096).await.unwrap()
      )
      .unwrap(),
      serde_json::json!({"status":"disconnected"})
    );
    assert_eq!(
      harness.link(harness.payload()).await.status(),
      StatusCode::OK
    );
    for _ in 0..3 {
      let response = harness
        .status(Some("http://localhost:3000"), &harness.api_url)
        .await;
      assert_eq!(response.status(), StatusCode::OK);
      assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
      let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
      let snapshot: crate::types::DesktopAccountSnapshot =
        serde_json::from_slice(&bytes).unwrap();
      assert!(matches!(
        snapshot,
        crate::types::DesktopAccountSnapshot::Connected { .. }
      ));
      let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
      assert!(json.get("credential").is_none());
      assert!(
        !String::from_utf8(bytes.to_vec())
          .unwrap()
          .contains("stella_dr_fixture")
      );
    }
    assert_eq!(
      harness
        .notifications
        .load(std::sync::atomic::Ordering::SeqCst),
      1
    );
    assert_eq!(
      harness
        .status(Some("http://localhost:3000"), "https://other.example")
        .await
        .status(),
      StatusCode::CONFLICT
    );
    assert_eq!(
      harness
        .status(Some("http://localhost:3000"), "not a URL")
        .await
        .status(),
      StatusCode::BAD_REQUEST
    );
  }

  #[tokio::test]
  async fn rejected_or_unsaved_credentials_never_publish_a_linked_profile() {
    for (status, store) in [
      (
        StatusCode::UNAUTHORIZED,
        crate::account::AccountStore::Memory(None),
      ),
      (
        StatusCode::FORBIDDEN,
        crate::account::AccountStore::Memory(None),
      ),
      (
        StatusCode::SERVICE_UNAVAILABLE,
        crate::account::AccountStore::Memory(None),
      ),
      (StatusCode::OK, crate::account::AccountStore::ReadOnly(None)),
    ] {
      let harness = AccountLinkHarness::new(status, store).await;
      assert_eq!(
        harness.link(harness.payload()).await.status(),
        StatusCode::BAD_REQUEST
      );
      assert!(
        crate::account::current(&harness.account)
          .await
          .unwrap()
          .is_none()
      );
      assert_eq!(
        harness
          .notifications
          .load(std::sync::atomic::Ordering::SeqCst),
        0
      );
    }
  }

  #[tokio::test]
  async fn profile_only_and_untrusted_api_links_are_rejected() {
    let harness = AccountLinkHarness::new(
      StatusCode::OK,
      crate::account::AccountStore::Memory(None),
    )
    .await;
    let mut profile_only = harness.payload();
    profile_only.as_object_mut().unwrap().remove("credential");
    assert_eq!(
      harness.link(profile_only).await.status(),
      StatusCode::BAD_REQUEST
    );
    let mut untrusted_api = harness.payload();
    untrusted_api["apiBaseUrl"] = serde_json::json!("http://127.0.0.1:9");
    assert_eq!(
      harness.link(untrusted_api).await.status(),
      StatusCode::FORBIDDEN
    );
    assert!(
      crate::account::current(&harness.account)
        .await
        .unwrap()
        .is_none()
    );
  }

  #[tokio::test]
  async fn link_account_rejects_disallowed_origin() {
    let app = build_router(test_state());
    let request = Request::builder()
      .method("POST")
      .uri("/v1/link-account")
      .header("origin", "https://evil.example")
      .header("content-type", "application/json")
      .body(Body::from(
        serde_json::to_vec(&serde_json::json!({
          "apiBaseUrl": "https://api.example.com",
          "linkedAccount": {
            "email": "user@example.com",
            "name": null,
            "verifiedAt": "2026-08-31T10:00:00Z"
          }
        }))
        .unwrap(),
      ))
      .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
  }
}
