use axum::{
  Json, Router,
  extract::{Path, Query, State},
  http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
  response::IntoResponse,
  routing::get,
};
use std::collections::HashSet;
use std::io::{Read, Seek};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::desktop_runner::step_outputs;
use crate::session_manager::SessionManager;
use crate::types::{BRIDGE_CAPABILITIES, BRIDGE_VERSION};

const BIND_RETRY_INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const BIND_RETRY_MAX_BACKOFF: Duration = Duration::from_secs(30);

/// Step outputs authenticate with a grant, not the linking proof
/// (`chat-local-run-step-output` in the API contract, whose fixtures the tests
/// below follow).
const STEP_OUTPUT_PATH_PREFIX: &str = "/v1/runs/";
const GRANT_EXPIRES_AT_HEADER: &str = "x-stella-bridge-grant";
const TOTAL_BYTES_HEADER: &str = "x-stella-output-bytes";
/// The longest a grant lasts, plus the proof window for a clock that differs.
const GRANT_MAX_SECONDS: i64 = 300 + 30;
/// The most of any kept step that is served: the largest of the contract's
/// caps by kind (an image's). A kept file does not say which kind it holds;
/// the sidecar writes none past its own kind's cap, and a page takes no more
/// than the cap of the kind it reads.
const STEP_OUTPUT_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// A step file's header line, `{"bytes":<n>}`, is far shorter.
const STEP_HEADER_MAX_BYTES: u64 = 64;
const STREAM_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct BridgeState {
  pub account: crate::account::AccountState,
  pub manager: Arc<Mutex<SessionManager>>,
  pub static_allowed_origins: HashSet<String>,
  pub bridge_port: u16,
  /// Where the runs' folders and their step outputs are; `None` without a
  /// data folder, and then no step is on this computer.
  pub run_folders: Option<PathBuf>,
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
        "content-type, x-stella-bridge-time, x-stella-bridge-proof, x-stella-bridge-grant",
      ),
    );
    headers.insert(
      "Access-Control-Expose-Headers",
      HeaderValue::from_static(TOTAL_BYTES_HEADER),
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

/// Why a step's output is not served, as the page reads it: a run this
/// computer does not hold, a step it kept nothing for, or a request it cannot
/// authenticate (another account, an expired grant, an origin it does not
/// trust).
#[derive(Clone, Copy)]
enum StepRefusal {
  RunNotHere,
  StepNotKept,
  Unauthorized,
}

impl StepRefusal {
  fn response(self, origin: Option<&str>, allowed: bool) -> axum::response::Response {
    let (status, code) = match self {
      Self::RunNotHere => (StatusCode::NOT_FOUND, "run_not_here"),
      Self::StepNotKept => (StatusCode::NOT_FOUND, "step_not_kept"),
      Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
    };
    json_response(status, serde_json::json!({ "code": code }), origin, allowed)
  }
}

/// The key a page's grant for `run_id` signs requests with, derived from the
/// run's output key and the account linked here: a grant made for another
/// member, organization or run derives another key and never verifies.
fn grant_key(
  output_key: &str,
  run_id: &str,
  identity: &crate::types::DesktopAccountIdentity,
  expires_at: i64,
) -> String {
  let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, output_key.as_bytes());
  let message = format!(
    "stella.step-output-grant.v1\n{run_id}\n{}\n{}\n{expires_at}",
    identity.user_id, identity.organization_id
  );
  hex::encode(ring::hmac::sign(&key, message.as_bytes()).as_ref())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StepHeader {
  bytes: u64,
}

/// A kept step, opened past its header line, with how many bytes it had.
struct OpenedStep {
  file: std::fs::File,
  total_bytes: u64,
}

fn open_step(file: &std::path::Path) -> Result<OpenedStep, StepRefusal> {
  let mut opened =
    crate::local_store::open_private(crate::local_store::OpenMode::Read, file)
      .map_err(|_unreadable| StepRefusal::StepNotKept)?;
  let mut head = Vec::new();
  (&mut opened)
    .take(STEP_HEADER_MAX_BYTES)
    .read_to_end(&mut head)
    .map_err(|_unreadable| StepRefusal::StepNotKept)?;
  let newline = head
    .iter()
    .position(|byte| *byte == b'\n')
    .ok_or(StepRefusal::StepNotKept)?;
  let header: StepHeader = serde_json::from_slice(&head[..newline])
    .map_err(|_not_a_header| StepRefusal::StepNotKept)?;
  let body_start =
    u64::try_from(newline + 1).map_err(|_too_large| StepRefusal::StepNotKept)?;
  opened
    .seek(std::io::SeekFrom::Start(body_start))
    .map_err(|_unreadable| StepRefusal::StepNotKept)?;
  Ok(OpenedStep {
    file: opened,
    total_bytes: header.bytes,
  })
}

/// The body of a kept step, read and sent in chunks, never past the largest
/// cap a step is kept under.
fn streamed(file: std::fs::File) -> axum::body::Body {
  use tokio::io::AsyncReadExt;
  let reader = tokio::fs::File::from_std(file).take(STEP_OUTPUT_MAX_BYTES);
  let stream = futures_util::stream::unfold(Some(reader), |state| async move {
    let mut reader = state?;
    let mut buffer = vec![0_u8; STREAM_CHUNK_BYTES];
    match reader.read(&mut buffer).await {
      Ok(0) => None,
      Ok(read) => {
        buffer.truncate(read);
        Some((Ok(axum::body::Bytes::from(buffer)), Some(reader)))
      }
      Err(error) => Some((Err(error), None)),
    }
  });
  axum::body::Body::from_stream(stream)
}

/// What a request must carry to read a step: a fresh grant for this run and
/// the account linked here, and a proof signed with it over this request.
struct StepRequest<'a> {
  run_id: &'a str,
  uri: &'a str,
  headers: &'a HeaderMap,
  identity: &'a crate::types::DesktopAccountIdentity,
  now: i64,
}

fn granted(output_key: &str, request: &StepRequest<'_>) -> bool {
  let header = |name: &str| {
    request
      .headers
      .get(name)
      .and_then(|value| value.to_str().ok())
  };
  let (Some(expires_at), Some(timestamp), Some(proof)) = (
    header(GRANT_EXPIRES_AT_HEADER).and_then(|value| value.parse::<i64>().ok()),
    header("x-stella-bridge-time"),
    header("x-stella-bridge-proof"),
  ) else {
    return false;
  };
  if expires_at < request.now
    || expires_at.saturating_sub(request.now) > GRANT_MAX_SECONDS
  {
    return false;
  }
  let key = grant_key(output_key, request.run_id, request.identity, expires_at);
  crate::account::valid_request_proof(
    key.as_bytes(),
    &crate::account::BridgeRequestProof {
      timestamp,
      proof,
      method: "GET",
      uri: request.uri,
      now: request.now,
    },
  )
}

/// One step's output or diff, for a page of the account linked here, served
/// from this computer only: the run's key and the step's file never leave it.
async fn step_output(
  State(state): State<BridgeState>,
  Path((run_id, step_key)): Path<(String, String)>,
  uri: Uri,
  headers: HeaderMap,
) -> axum::response::Response {
  let origin = get_origin(&headers);
  let origin_ref = origin.as_deref();
  let allowed = is_allowed_origin(&state, origin_ref).await;
  let refuse = |refusal: StepRefusal| refusal.response(origin_ref, allowed);
  let account = crate::account::current(&state.account).await.ok().flatten();
  let Some(account) = account
    .filter(|account| allowed && origin_ref == Some(account.web_origin.as_str()))
  else {
    return refuse(StepRefusal::Unauthorized);
  };
  let (Ok(run), Some(folders)) = (uuid::Uuid::parse_str(&run_id), state.run_folders)
  else {
    return refuse(StepRefusal::RunNotHere);
  };
  let identity = account.identity;
  let request_uri = uri.to_string();
  let now = chrono::Utc::now().timestamp();
  let opened = tokio::task::spawn_blocking(move || {
    let dir = step_outputs::run_dir(&folders, run).ok_or(StepRefusal::RunNotHere)?;
    let key = step_outputs::read_key(&dir).ok_or(StepRefusal::RunNotHere)?;
    let run_text = run.to_string();
    let request = StepRequest {
      run_id: &run_text,
      uri: &request_uri,
      headers: &headers,
      identity: &identity,
      now,
    };
    if !granted(&key, &request) {
      return Err(StepRefusal::Unauthorized);
    }
    let file =
      step_outputs::step_file(&dir, &step_key).ok_or(StepRefusal::StepNotKept)?;
    open_step(&file)
  })
  .await
  .unwrap_or(Err(StepRefusal::StepNotKept));
  let opened = match opened {
    Ok(opened) => opened,
    Err(refusal) => return refuse(refusal),
  };
  let mut response_headers = cors_headers(origin_ref, allowed);
  response_headers.insert(
    "Content-Type",
    HeaderValue::from_static("text/plain; charset=utf-8"),
  );
  response_headers.insert(
    "X-Content-Type-Options",
    HeaderValue::from_static("nosniff"),
  );
  response_headers.insert(TOTAL_BYTES_HEADER, HeaderValue::from(opened.total_bytes));
  (StatusCode::OK, response_headers, streamed(opened.file)).into_response()
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
    .route(
      "/v1/runs/{run_id}/steps/{step_key}/output",
      get(step_output),
    )
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
        // A step output checks its own grant.
        if req.uri().path().starts_with(STEP_OUTPUT_PATH_PREFIX) {
          return Ok(next.run(req).await);
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
    run_folders: crate::desktop_runner::run_folders_directory(),
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
pub(crate) mod tests {
  use super::*;
  use axum::body::Body;
  use axum::http::Request;
  use tower::ServiceExt;

  fn test_state() -> BridgeState {
    BridgeState {
      account: Arc::new(Mutex::new(crate::account::AccountStore::Memory(None))),
      manager: Arc::new(Mutex::new(
        SessionManager::new().expect("test data directory"),
      )),
      static_allowed_origins: HashSet::from(["http://localhost:3000".to_string()]),
      bridge_port: 0,
      run_folders: None,
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
      let signed = |status: &str| {
        format!(
          "{}\n{}\n{}\n{status}\n{timestamp}",
          fixture.correlation_id, fixture.verifier_hash, fixture.device_jkt
        )
      };
      assert!(
        ring::hmac::verify(&key, signed("pending").as_bytes(), &signature).is_ok()
      );
      assert!(
        ring::hmac::verify(&key, signed("connected").as_bytes(), &signature).is_err()
      );
    }
  }

  const STEP_FIXTURES: &str = include_str!(
    "../../../../packages/api-contract/src/chat-local-run-step-output.fixtures.json"
  );

  fn step_fixtures() -> serde_json::Value {
    serde_json::from_str(STEP_FIXTURES).unwrap()
  }

  fn identity(user_id: &str) -> crate::types::DesktopAccountIdentity {
    crate::types::DesktopAccountIdentity {
      user_id: user_id.into(),
      organization_id: "org-fixture-1".into(),
    }
  }

  fn linked(user_id: &str) -> crate::account::LinkedAccount {
    crate::account::LinkedAccount {
      api_base_url: "https://api.example.test".into(),
      web_origin: "http://localhost:3000".into(),
      account: crate::types::LinkedAccountSnapshot {
        email: "desktop@example.test".into(),
        name: None,
        verified_at: "2026-10-01T00:00:00Z".into(),
      },
      identity: identity(user_id),
      credential: crate::types::DesktopAccountCredential {
        key: "stella_dr_fixture".into(),
        expires_at: (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339(),
      },
      device_key: crate::device_proof::DeviceKey::fixture(),
    }
  }

  #[test]
  fn a_grant_and_its_request_proof_follow_the_contract() {
    let fixtures = step_fixtures();
    let grant = &fixtures["grant"];
    let request = &fixtures["request"];
    assert_eq!(
      fixtures["headers"]["grantExpiresAt"],
      GRANT_EXPIRES_AT_HEADER
    );
    assert_eq!(fixtures["headers"]["totalBytes"], TOTAL_BYTES_HEADER);
    let caps = fixtures["maxBytes"].as_object().unwrap();
    assert_eq!(
      caps.values().map(|cap| cap.as_u64().unwrap()).max(),
      Some(STEP_OUTPUT_MAX_BYTES)
    );
    assert_eq!(
      fixtures["grantSeconds"]
        .as_i64()
        .map(|seconds| seconds + 30),
      Some(GRANT_MAX_SECONDS)
    );
    let key = grant_key(
      grant["outputKey"].as_str().unwrap(),
      grant["runId"].as_str().unwrap(),
      &crate::types::DesktopAccountIdentity {
        user_id: grant["userId"].as_str().unwrap().into(),
        organization_id: grant["organizationId"].as_str().unwrap().into(),
      },
      grant["expiresAt"].as_i64().unwrap(),
    );
    assert_eq!(key, grant["grantHmac"].as_str().unwrap());
    let timestamp = request["timestamp"].as_str().unwrap();
    assert!(crate::account::valid_request_proof(
      key.as_bytes(),
      &crate::account::BridgeRequestProof {
        timestamp,
        proof: request["proof"].as_str().unwrap(),
        method: "GET",
        uri: request["path"].as_str().unwrap(),
        now: timestamp.parse().unwrap(),
      },
    ));
  }

  struct StepPlace {
    root: std::path::PathBuf,
    /// Where the run's steps are kept.
    dir: std::path::PathBuf,
    run: uuid::Uuid,
    output_key: String,
  }

  impl Drop for StepPlace {
    fn drop(&mut self) {
      drop(std::fs::remove_dir_all(&self.root));
    }
  }

  #[allow(
    clippy::disallowed_methods,
    reason = "tests construct local file fixtures"
  )]
  fn step_place() -> StepPlace {
    let root =
      std::env::temp_dir().join(format!("bridge-steps-{}", uuid::Uuid::new_v4()));
    let run = uuid::Uuid::new_v4();
    let output_key = "cd".repeat(32);
    let dir = root
      .join(format!("{}.step-outputs", uuid::Uuid::new_v4()))
      .join(run.to_string());
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("key"), &output_key).unwrap();
    std::fs::write(
      dir.join("ab".repeat(32)),
      "{\"bytes\":40}\nPermission denied: notes.md\n",
    )
    .unwrap();
    StepPlace {
      root,
      dir,
      run,
      output_key,
    }
  }

  async fn read_step(
    place: &StepPlace,
    signer: &str,
    run: uuid::Uuid,
    step_key: &str,
  ) -> axum::response::Response {
    read_step_at(&place.root, &place.output_key, signer, run, step_key).await
  }

  /// One step, asked for by a page of the account linked here
  /// (`user-fixture-1`) with a grant `signer` made from `output_key`, from a
  /// bridge serving the run folders in `run_folders`.
  pub(crate) async fn read_step_at(
    run_folders: &std::path::Path,
    output_key: &str,
    signer: &str,
    run: uuid::Uuid,
    step_key: &str,
  ) -> axum::response::Response {
    let uri = format!("/v1/runs/{run}/steps/{step_key}/output");
    let now = chrono::Utc::now().timestamp();
    let expires_at = now + 120;
    let key = grant_key(output_key, &run.to_string(), &identity(signer), expires_at);
    let timestamp = now.to_string();
    let signing = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key.as_bytes());
    let proof = hex::encode(
      ring::hmac::sign(&signing, format!("{timestamp}\nGET\n{uri}").as_bytes())
        .as_ref(),
    );
    let state = BridgeState {
      account: Arc::new(Mutex::new(crate::account::AccountStore::Memory(Some(
        linked("user-fixture-1"),
      )))),
      run_folders: Some(run_folders.to_path_buf()),
      ..test_state()
    };
    build_router(state)
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(&uri)
          .header("origin", "http://localhost:3000")
          .header(GRANT_EXPIRES_AT_HEADER, expires_at.to_string())
          .header("x-stella-bridge-time", &timestamp)
          .header("x-stella-bridge-proof", &proof)
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap()
  }

  async fn code_of(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
      .await
      .unwrap();
    serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["code"].clone()
  }

  #[tokio::test]
  async fn a_step_is_served_to_the_linked_account_and_to_no_other() {
    let place = step_place();
    let step = "ab".repeat(32);
    let response = read_step(&place, "user-fixture-1", place.run, &step).await;
    assert_eq!(response.status(), StatusCode::OK);
    let header = |name: &str| response.headers()[name].to_str().unwrap().to_owned();
    assert_eq!(header(TOTAL_BYTES_HEADER), "40");
    assert_eq!(
      header("access-control-allow-origin"),
      "http://localhost:3000"
    );
    assert_eq!(header("access-control-expose-headers"), TOTAL_BYTES_HEADER);
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
      .await
      .unwrap();
    assert_eq!(&bytes[..], b"Permission denied: notes.md\n");

    // A grant made for another member derives another key.
    let other = read_step(&place, "user-fixture-2", place.run, &step).await;
    assert_eq!(other.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(other).await, "unauthorized");

    let elsewhere =
      read_step(&place, "user-fixture-1", uuid::Uuid::new_v4(), &step).await;
    assert_eq!(elsewhere.status(), StatusCode::NOT_FOUND);
    assert_eq!(code_of(elsewhere).await, "run_not_here");

    let missing =
      read_step(&place, "user-fixture-1", place.run, &"ef".repeat(32)).await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(code_of(missing).await, "step_not_kept");
  }

  #[tokio::test]
  #[allow(
    clippy::disallowed_methods,
    reason = "tests construct local file fixtures"
  )]
  async fn a_kept_step_is_served_whole_at_the_cap_and_never_past_it() {
    let place = step_place();
    let cap = usize::try_from(STEP_OUTPUT_MAX_BYTES).unwrap();
    let header = b"{\"bytes\":1}\n";
    for (step, kept, served) in [
      ("0a".repeat(32), cap, cap),
      // A file holding more than any step keeps is cut where it is served.
      ("0b".repeat(32), cap + 1, cap),
    ] {
      let mut file = header.to_vec();
      file.resize(header.len() + kept, 0x2a);
      std::fs::write(place.dir.join(&step), file).unwrap();
      let response = read_step(&place, "user-fixture-1", place.run, &step).await;
      assert_eq!(response.status(), StatusCode::OK);
      let bytes = axum::body::to_bytes(response.into_body(), cap + 2)
        .await
        .unwrap();
      assert_eq!(bytes.len(), served);
    }
  }

  #[tokio::test]
  async fn a_step_request_without_a_grant_is_refused() {
    let place = step_place();
    let state = BridgeState {
      account: Arc::new(Mutex::new(crate::account::AccountStore::Memory(Some(
        linked("user-fixture-1"),
      )))),
      run_folders: Some(place.root.clone()),
      ..test_state()
    };
    let response = build_router(state)
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!(
            "/v1/runs/{}/steps/{}/output",
            place.run,
            "ab".repeat(32)
          ))
          .header("origin", "http://localhost:3000")
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
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
