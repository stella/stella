//! The runner against a local WebSocket server that behaves as the API
//! gateway does (`apps/api/src/lib/desktop-runner/gateway.db.test.ts` drives
//! the other side the same way): the real client, journal and frame limits,
//! over a real socket.

use std::{
  collections::HashMap,
  path::PathBuf,
  sync::{Arc, Mutex},
  time::Duration,
};

use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use serde_json::{Value, json};
use tokio::{
  net::{TcpListener, TcpStream},
  sync::watch,
  task::JoinHandle,
};
use tokio_tungstenite::{
  WebSocketStream,
  tungstenite::{
    Message,
    handshake::server::{ErrorResponse, Request, Response},
    http::HeaderMap,
    protocol::{CloseFrame, frame::coding::CloseCode as WireCloseCode},
  },
};
use uuid::Uuid;

use super::client::{
  Authorized, JournalOpener, Runner, RunnerAuth, RunnerConfig, RunnerParts,
  RunnerTiming,
};
use super::harness::{
  EmitError, HarnessHost, NoHarnessReports, RunOutput, RunSink, UnavailableHarnessHost,
};
use super::journal::{Journal, JournalBacking};
use super::state::RunnerState;
use crate::device_proof::DeviceKey;
use crate::runner_protocol::{
  ApprovalKind, DESKTOP_ID_HEADER, Harness, HarnessReport, MAX_FRAME_BYTES, PATH,
  PROTOCOL, RejectReason, RunApproval, RunInput, RunOutcome, RunStart, RunTokenRefresh,
};

const WAIT: Duration = Duration::from_secs(10);
const BEARER: &str = "stella_desktop_fixture_bearer";
const RUN: &str = "0192f3a0-6b1c-7d2e-8f30-0000000000a1";

fn timing() -> RunnerTiming {
  RunnerTiming {
    connect_timeout: Duration::from_secs(5),
    welcome_timeout: Duration::from_secs(5),
    silence_timeout: Duration::from_secs(30),
    backoff_base: Duration::from_millis(20),
    backoff_cap: Duration::from_millis(80),
    signed_out_retry: Duration::from_millis(50),
  }
}

/// A gateway as the desktop sees it: accepts upgrades, records each one.
struct Gateway {
  listener: TcpListener,
}

struct Connection {
  socket: WebSocketStream<TcpStream>,
  headers: HeaderMap,
  path: String,
}

impl Gateway {
  async fn bind() -> Self {
    Self {
      listener: TcpListener::bind("127.0.0.1:0").await.unwrap(),
    }
  }

  fn base_url(&self) -> String {
    format!("http://{}", self.listener.local_addr().unwrap())
  }

  #[allow(
    clippy::result_large_err,
    reason = "tungstenite fixes the handshake callback's error type"
  )]
  async fn accept(&self) -> Connection {
    let (stream, _) = tokio::time::timeout(WAIT, self.listener.accept())
      .await
      .expect("the runner connects")
      .unwrap();
    let seen = Arc::new(Mutex::new(None));
    let record = Arc::clone(&seen);
    let socket = tokio_tungstenite::accept_hdr_async(
      stream,
      move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        *record.lock().unwrap() =
          Some((request.headers().clone(), request.uri().path().to_owned()));
        Ok(response)
      },
    )
    .await
    .unwrap();
    let (headers, path) = seen.lock().unwrap().take().unwrap();
    Connection {
      socket,
      headers,
      path,
    }
  }

  /// No upgrade arrives within `quiet`.
  async fn stays_quiet(&self, quiet: Duration) {
    assert!(
      tokio::time::timeout(quiet, self.listener.accept())
        .await
        .is_err(),
      "the runner reconnected"
    );
  }
}

impl Connection {
  /// The next text frame, as JSON.
  async fn receive(&mut self) -> Value {
    loop {
      let frame = tokio::time::timeout(WAIT, self.socket.next())
        .await
        .expect("the runner sends a frame")
        .expect("the socket is open")
        .unwrap();
      match frame {
        Message::Text(text) => return serde_json::from_str(&text).unwrap(),
        Message::Ping(_) | Message::Pong(_) => {}
        other => panic!("unexpected frame {other:?}"),
      }
    }
  }

  async fn receive_type(&mut self, kind: &str) -> Value {
    let message = self.receive().await;
    assert_eq!(message["type"], kind, "{message}");
    message
  }

  async fn send(&mut self, message: Value) {
    self
      .socket
      .send(Message::text(message.to_string()))
      .await
      .unwrap();
  }

  async fn hello(&mut self) -> Value {
    self.receive_type("hello").await
  }

  async fn welcome(&mut self, resume: &[(&str, u32)]) {
    let resume: Vec<Value> = resume
      .iter()
      .map(|(run_id, ack_seq)| json!({"runId": run_id, "ackSeq": ack_seq}))
      .collect();
    self
      .send(json!({"type": "welcome", "protocol": PROTOCOL, "resume": resume}))
      .await;
  }

  async fn close(&mut self, code: u16, reason: &'static str) {
    self
      .socket
      .close(Some(CloseFrame {
        code: WireCloseCode::from(code),
        reason: reason.into(),
      }))
      .await
      .unwrap();
  }

  /// The runner went away; the close code it sent, if any.
  async fn closed(&mut self) -> Option<u16> {
    loop {
      match tokio::time::timeout(WAIT, self.socket.next())
        .await
        .expect("the runner closes")
      {
        Some(Ok(Message::Close(frame))) => {
          return frame.map(|frame| u16::from(frame.code));
        }
        Some(Ok(_)) => {}
        Some(Err(_)) | None => return None,
      }
    }
  }
}

fn run_start(run_id: &str, expires_at: &str) -> Value {
  json!({
    "type": "run.start",
    "runId": run_id,
    "harness": "codex",
    "harnessVersion": "0.50.0",
    "model": "gpt-5-codex",
    "harnessSessionId": null,
    "instructions": "Summarize the matter.",
    "messages": [{"role": "user", "content": "Summarize the matter."}],
    "policy": {"network": "open", "fs": "workspace"},
    "mcp": {
      "serverName": "stella",
      "url": "https://api.example.test/mcp",
      "token": "run-token-1",
      "expiresAt": expires_at,
    },
  })
}

fn text_chunk(delta: &str) -> RunOutput {
  RunOutput::Event(
    serde_json::from_value(json!({
      "type": "TEXT_MESSAGE_CONTENT",
      "messageId": "message-1",
      "delta": delta,
    }))
    .unwrap(),
  )
}

/// Records every call and keeps each run's sink for the test to emit through.
#[derive(Default)]
struct RecordingHost {
  calls: Mutex<Vec<String>>,
  sinks: Mutex<HashMap<String, RunSink>>,
}

impl RecordingHost {
  fn calls(&self) -> Vec<String> {
    self.calls.lock().unwrap().clone()
  }

  fn sink(&self, run_id: &str) -> RunSink {
    self.sinks.lock().unwrap()[run_id].clone()
  }

  fn record(&self, call: String) {
    self.calls.lock().unwrap().push(call);
  }
}

impl HarnessHost for RecordingHost {
  fn sidecar_version(&self) -> String {
    "1.2.3".to_owned()
  }

  fn start(&self, start: RunStart, sink: RunSink) -> Result<(), RejectReason> {
    self.record(format!("start {}", start.run_id));
    self.sinks.lock().unwrap().insert(start.run_id, sink);
    Ok(())
  }

  fn input(&self, input: RunInput) {
    self.record(format!("input {}", input.input_id));
  }

  fn approval(&self, approval: RunApproval) {
    self.record(format!("approval {}", approval.request_id));
  }

  fn interrupt(&self, run_id: &str) {
    self.record(format!("interrupt {run_id}"));
  }

  fn cancel(&self, run_id: &str) {
    self.record(format!("cancel {run_id}"));
  }

  fn token(&self, refresh: RunTokenRefresh) {
    self.record(format!("token {}", refresh.expires_at));
  }
}

struct FixtureAuth {
  base_url: String,
  device_key: DeviceKey,
  signed_in: bool,
}

impl RunnerAuth for FixtureAuth {
  fn authorize(&self) -> BoxFuture<'_, Result<Option<Authorized>, String>> {
    Box::pin(async move {
      Ok(self.signed_in.then(|| Authorized {
        api_base_url: self.base_url.clone(),
        bearer: zeroize::Zeroizing::new(BEARER.to_owned()),
        device_key: self.device_key.clone(),
        namespace: "fixture-account".to_owned(),
        lease: None,
      }))
    })
  }
}

/// An encrypted journal in a directory the test owns, so a second runner
/// reads what the first wrote.
struct DirectoryJournals(PathBuf);

impl JournalOpener for DirectoryJournals {
  fn open(&self, namespace: &str) -> Journal {
    Journal::open(
      JournalBacking::Encrypted {
        directory: self.0.join(namespace),
        key: [9; 32],
      },
      super::client::now_ms(),
    )
  }
}

struct Started {
  state: watch::Receiver<RunnerState>,
  stop: watch::Sender<bool>,
  wake: watch::Sender<u64>,
  task: JoinHandle<()>,
}

impl Started {
  async fn reaches(&mut self, wanted: impl Fn(&RunnerState) -> bool) -> RunnerState {
    tokio::time::timeout(WAIT, self.state.wait_for(|state| wanted(state)))
      .await
      .expect("the runner reaches the state")
      .unwrap()
      .clone()
  }

  async fn stop(self) {
    self.stop.send_replace(true);
    tokio::time::timeout(WAIT, self.task)
      .await
      .expect("the runner stops")
      .unwrap();
  }
}

struct Setup {
  host: Arc<dyn HarnessHost>,
  journal_dir: PathBuf,
  timing: RunnerTiming,
  device_key: DeviceKey,
  desktop_id: Uuid,
  signed_in: bool,
}

impl Setup {
  fn new(host: Arc<dyn HarnessHost>) -> Self {
    Self {
      host,
      journal_dir: std::env::temp_dir()
        .join(format!("stella-runner-test-{}", Uuid::new_v4())),
      timing: timing(),
      device_key: DeviceKey::fixture(),
      desktop_id: Uuid::new_v4(),
      signed_in: true,
    }
  }

  fn start(&self, gateway: &Gateway) -> Started {
    let state = Arc::new(watch::channel(RunnerState::Off).0);
    let observed = state.subscribe();
    let (stop, stopped) = watch::channel(false);
    let (wake, wakes) = watch::channel(0);
    let runner = Runner::new(RunnerParts {
      config: RunnerConfig {
        desktop_id: self.desktop_id,
        app_version: "1.4.0".to_owned(),
        timing: self.timing.clone(),
        random: || 0.5,
      },
      auth: Arc::new(FixtureAuth {
        base_url: gateway.base_url(),
        device_key: self.device_key.clone(),
        signed_in: self.signed_in,
      }),
      journals: Arc::new(DirectoryJournals(self.journal_dir.clone())),
      host: Arc::clone(&self.host),
      reports: Arc::new(NoHarnessReports),
      state,
      wakes,
      stop: stopped,
    });
    Started {
      state: observed,
      stop,
      wake,
      task: tokio::spawn(runner.run()),
    }
  }
}

impl Drop for Setup {
  fn drop(&mut self) {
    let _cleanup = std::fs::remove_dir_all(&self.journal_dir);
  }
}

#[tokio::test]
async fn the_upgrade_carries_bearer_fresh_device_proof_and_installation_and_hello_lists_harnesses()
 {
  let gateway = Gateway::bind().await;
  let setup = Setup::new(Arc::new(UnavailableHarnessHost::new("1.4.0".to_owned())));
  let mut runner = setup.start(&gateway);
  let mut proofs = Vec::new();
  for _ in 0..2 {
    let mut connection = gateway.accept().await;
    assert_eq!(connection.path, PATH);
    assert_eq!(
      connection.headers["authorization"],
      format!("Bearer {BEARER}")
    );
    assert_eq!(
      connection.headers[DESKTOP_ID_HEADER],
      setup.desktop_id.to_string()
    );
    assert_eq!(connection.headers["user-agent"], "stella-desktop");
    assert!(
      connection.headers["x-stella-local-client"]
        .to_str()
        .unwrap()
        .starts_with("desktop/")
    );
    let proof = connection.headers["dpop"].to_str().unwrap().to_owned();
    // The proof names the public URL the API checks: GET, path only.
    let mut checked = reqwest::Request::new(
      reqwest::Method::GET,
      format!("{}{PATH}", gateway.base_url()).parse().unwrap(),
    );
    checked.headers_mut().insert("dpop", proof.parse().unwrap());
    checked.headers_mut().insert(
      "authorization",
      connection.headers["authorization"].clone(),
    );
    crate::device_proof::tests::verify_request(
      &checked,
      &setup.device_key.thumbprint().unwrap(),
      Some(BEARER),
      None,
    );
    proofs.push(proof);

    let hello = connection.hello().await;
    assert_eq!(hello["protocol"], PROTOCOL);
    assert_eq!(hello["appVersion"], "1.4.0");
    assert_eq!(hello["activeRuns"], json!([]));
    let reported: Vec<HarnessReport> =
      serde_json::from_value(hello["harnesses"].clone()).unwrap();
    assert_eq!(reported.len(), Harness::ALL.len());
    assert!(
      reported
        .iter()
        .all(|report| matches!(report, HarnessReport::NotInstalled(_)))
    );
    connection.welcome(&[]).await;
    runner
      .reaches(|state| *state == RunnerState::Connected)
      .await;
    connection.close(1011, "internal_error").await;
  }
  assert_ne!(proofs[0], proofs[1], "every connection signs a new proof");
  runner.stop().await;
}

#[tokio::test]
async fn without_a_harness_a_run_is_refused_as_not_installed_and_the_refusal_is_repeated()
 {
  let gateway = Gateway::bind().await;
  let setup = Setup::new(Arc::new(UnavailableHarnessHost::new("1.4.0".to_owned())));
  let runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.welcome(&[]).await;
  for _ in 0..2 {
    connection
      .send(run_start(RUN, "2026-10-28T13:00:00.000Z"))
      .await;
    assert_eq!(
      connection.receive().await,
      json!({"type": "run.rejected", "runId": RUN, "reason": "harness_not_installed"})
    );
  }
  runner.stop().await;
  // A refused run is never held, so the next hello does not list it.
  let runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  assert_eq!(connection.hello().await["activeRuns"], json!([]));
  connection.welcome(&[]).await;
  connection
    .send(run_start(RUN, "2026-10-28T13:00:00.000Z"))
    .await;
  assert_eq!(
    connection.receive().await["reason"],
    "harness_not_installed"
  );
  runner.stop().await;
}

#[tokio::test]
async fn unacknowledged_messages_are_resent_from_welcome_resume_across_reconnects_and_restarts()
 {
  let gateway = Gateway::bind().await;
  let host = Arc::new(RecordingHost::default());
  let setup = Setup::new(Arc::clone(&host) as Arc<dyn HarnessHost>);
  let runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.welcome(&[]).await;
  connection
    .send(run_start(RUN, "2026-10-28T13:00:00.000Z"))
    .await;
  assert_eq!(
    connection.receive().await,
    json!({"type": "run.accepted", "runId": RUN})
  );
  let sink = host.sink(RUN);
  for (expected, delta) in [(1, "One"), (2, "Two"), (3, "Three")] {
    assert_eq!(sink.emit(text_chunk(delta)).await.unwrap().get(), expected);
    let event = connection.receive_type("run.event").await;
    assert_eq!(event["seq"], expected);
    assert_eq!(event["chunk"]["delta"], delta);
  }
  connection
    .send(json!({"type": "ack", "runId": RUN, "seq": 1}))
    .await;
  connection.close(1011, "internal_error").await;

  // Produced while disconnected: journaled, sent after the next welcome.
  assert_eq!(sink.emit(text_chunk("Four")).await.unwrap().get(), 4);

  let mut connection = gateway.accept().await;
  assert_eq!(
    connection.hello().await["activeRuns"],
    json!([{"runId": RUN, "lastSeq": 4}])
  );
  // The API stored through 2 even though only 1 was acknowledged.
  connection.welcome(&[(RUN, 2)]).await;
  for seq in [3, 4] {
    assert_eq!(connection.receive_type("run.event").await["seq"], seq);
  }
  runner.stop().await;

  // A restart reads the journal: still unacknowledged, still resent.
  let restarted_host = Arc::new(RecordingHost::default());
  let restarted = Setup {
    host: Arc::clone(&restarted_host) as Arc<dyn HarnessHost>,
    journal_dir: setup.journal_dir.clone(),
    timing: timing(),
    device_key: setup.device_key.clone(),
    desktop_id: setup.desktop_id,
    signed_in: true,
  };
  let runner = restarted.start(&gateway);
  let mut connection = gateway.accept().await;
  assert_eq!(
    connection.hello().await["activeRuns"],
    json!([{"runId": RUN, "lastSeq": 4}])
  );
  connection.welcome(&[(RUN, 3)]).await;
  let resent = connection.receive_type("run.event").await;
  assert_eq!(
    (resent["seq"].clone(), resent["chunk"]["delta"].clone()),
    (json!(4), json!("Four"))
  );
  // The held run's start is not resent by the API; one that is gets the
  // journaled answer without reaching the new host.
  connection
    .send(run_start(RUN, "2026-10-28T13:00:00.000Z"))
    .await;
  assert_eq!(connection.receive().await["type"], "run.accepted");
  assert!(restarted_host.calls().is_empty());
  runner.stop().await;
}

#[tokio::test]
async fn a_finished_run_is_forgotten_once_acknowledged_and_a_run_welcome_omits_is_dropped()
 {
  let gateway = Gateway::bind().await;
  let host = Arc::new(RecordingHost::default());
  let setup = Setup::new(Arc::clone(&host) as Arc<dyn HarnessHost>);
  let runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.welcome(&[]).await;
  let finished = "0192f3a0-6b1c-7d2e-8f30-0000000000b1";
  for run_id in [finished, RUN] {
    connection
      .send(run_start(run_id, "2026-10-28T13:00:00.000Z"))
      .await;
    connection.receive_type("run.accepted").await;
  }
  let done = host.sink(finished);
  let request_id = "0192f3a0-6b1c-7d2e-8f30-0000000000f1";
  assert_eq!(
    done
      .emit(RunOutput::ApprovalRequest {
        request_id: request_id.to_owned(),
        kind: ApprovalKind::Command,
        summary: "Run the test suite".to_owned(),
      })
      .await
      .unwrap()
      .get(),
    1
  );
  assert_eq!(
    connection.receive().await,
    json!({
      "type": "run.approval_request",
      "runId": finished,
      "seq": 1,
      "requestId": request_id,
      "kind": "command",
      "summary": "Run the test suite",
    })
  );
  assert_eq!(
    done
      .emit(RunOutput::Finished {
        outcome: RunOutcome::Completed,
        harness_session_id: Some("session-1".to_owned()),
      })
      .await
      .unwrap()
      .get(),
    2
  );
  assert_eq!(
    connection.receive_type("run.finished").await["harnessSessionId"],
    "session-1"
  );
  // Nothing follows the final message.
  assert_eq!(
    done.emit(text_chunk("late")).await,
    Err(EmitError::RunClosed)
  );
  connection
    .send(json!({"type": "ack", "runId": finished, "seq": 2}))
    .await;
  host.sink(RUN).emit(text_chunk("Working")).await.unwrap();
  connection.receive_type("run.event").await;
  connection.close(1011, "internal_error").await;

  let mut connection = gateway.accept().await;
  assert_eq!(
    connection.hello().await["activeRuns"],
    json!([{"runId": RUN, "lastSeq": 1}])
  );
  // The API no longer holds the run: it is stopped and forgotten.
  connection.welcome(&[]).await;
  connection.close(1011, "internal_error").await;
  let mut connection = gateway.accept().await;
  assert_eq!(connection.hello().await["activeRuns"], json!([]));
  assert!(host.calls().contains(&format!("cancel {RUN}")));
  assert_eq!(
    host.sink(RUN).emit(text_chunk("gone")).await,
    Err(EmitError::RunClosed)
  );
  runner.stop().await;
}

#[tokio::test]
async fn duplicate_commands_reach_the_host_once_also_after_a_restart_and_only_a_newer_token_follows()
 {
  let gateway = Gateway::bind().await;
  let host = Arc::new(RecordingHost::default());
  let setup = Setup::new(Arc::clone(&host) as Arc<dyn HarnessHost>);
  let runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.welcome(&[]).await;
  let input = json!({
    "type": "run.input",
    "runId": RUN,
    "inputId": "0192f3a0-6b1c-7d2e-8f30-0000000000c1",
    "message": {"role": "user", "content": "Also check the dates."},
  });
  let approval = json!({
    "type": "run.approval",
    "runId": RUN,
    "requestId": "0192f3a0-6b1c-7d2e-8f30-0000000000d1",
    "decision": "approve",
  });
  let token = |expires_at: &str| json!({"type": "run.token", "runId": RUN, "token": "run-token-2", "expiresAt": expires_at});
  for _ in 0..2 {
    connection
      .send(run_start(RUN, "2026-10-28T13:00:00.000Z"))
      .await;
    connection.receive_type("run.accepted").await;
    connection.send(input.clone()).await;
    connection.send(approval.clone()).await;
    connection
      .send(json!({"type": "run.interrupt", "runId": RUN}))
      .await;
  }
  connection.send(token("2026-10-28T13:15:00.000Z")).await;
  connection.send(token("2026-10-28T13:10:00.000Z")).await;
  connection.send(token("2026-10-28T13:15:00.000Z")).await;
  // The start's own token is the oldest; neither older nor equal follows.
  connection.send(token("2026-10-28T12:00:00.000Z")).await;
  // A command for a run this desktop does not hold changes nothing.
  connection
    .send(
      json!({"type": "run.cancel", "runId": "0192f3a0-6b1c-7d2e-8f30-0000000000e1"}),
    )
    .await;
  // Answered in order, so everything before it was handled.
  connection
    .send(run_start(RUN, "2026-10-28T13:00:00.000Z"))
    .await;
  connection.receive_type("run.accepted").await;
  assert_eq!(
    host.calls(),
    [
      format!("start {RUN}"),
      "input 0192f3a0-6b1c-7d2e-8f30-0000000000c1".to_owned(),
      "approval 0192f3a0-6b1c-7d2e-8f30-0000000000d1".to_owned(),
      format!("interrupt {RUN}"),
      "token 2026-10-28T13:15:00.000Z".to_owned(),
    ]
  );
  runner.stop().await;

  let restarted_host = Arc::new(RecordingHost::default());
  let restarted = Setup {
    host: Arc::clone(&restarted_host) as Arc<dyn HarnessHost>,
    journal_dir: setup.journal_dir.clone(),
    timing: timing(),
    device_key: setup.device_key.clone(),
    desktop_id: setup.desktop_id,
    signed_in: true,
  };
  let runner = restarted.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.welcome(&[(RUN, 0)]).await;
  // The API replays its queue on a new socket.
  connection.send(input).await;
  connection.send(approval).await;
  connection
    .send(json!({"type": "run.interrupt", "runId": RUN}))
    .await;
  connection
    .send(json!({"type": "run.cancel", "runId": RUN}))
    .await;
  connection
    .send(json!({"type": "run.cancel", "runId": RUN}))
    .await;
  connection
    .send(run_start(RUN, "2026-10-28T13:00:00.000Z"))
    .await;
  connection.receive_type("run.accepted").await;
  assert_eq!(restarted_host.calls(), [format!("cancel {RUN}")]);
  runner.stop().await;
}

#[tokio::test]
async fn upgrade_required_is_surfaced_and_never_reconnects() {
  let gateway = Gateway::bind().await;
  let setup = Setup::new(Arc::new(UnavailableHarnessHost::new("1.4.0".to_owned())));
  let mut runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection
    .send(
      json!({"type": "upgrade_required", "minimumProtocol": 2, "currentProtocol": 3}),
    )
    .await;
  connection.close(4001, "upgrade_required").await;
  assert_eq!(
    runner
      .reaches(|state| matches!(state, RunnerState::UpgradeRequired { .. }))
      .await,
    RunnerState::UpgradeRequired {
      minimum_protocol: Some(2),
      current_protocol: Some(3),
    }
  );
  gateway.stays_quiet(Duration::from_millis(400)).await;
  runner.stop().await;
}

#[tokio::test]
async fn a_replaced_socket_stays_closed_and_a_wake_does_not_reopen_it() {
  let gateway = Gateway::bind().await;
  let setup = Setup::new(Arc::new(UnavailableHarnessHost::new("1.4.0".to_owned())));
  let mut runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.welcome(&[]).await;
  runner
    .reaches(|state| *state == RunnerState::Connected)
    .await;
  connection.close(4002, "superseded").await;
  runner
    .reaches(|state| *state == RunnerState::Replaced)
    .await;
  runner.wake.send_replace(1);
  gateway.stays_quiet(Duration::from_millis(400)).await;
  runner.stop().await;
}

#[tokio::test]
async fn a_revoked_credential_signs_the_runner_out_instead_of_backing_off() {
  let gateway = Gateway::bind().await;
  let setup = Setup::new(Arc::new(UnavailableHarnessHost::new("1.4.0".to_owned())));
  let mut runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.welcome(&[]).await;
  runner
    .reaches(|state| *state == RunnerState::Connected)
    .await;
  connection.close(4008, "credential_revoked").await;
  runner
    .reaches(|state| *state == RunnerState::SignedOut)
    .await;
  runner.stop().await;
}

#[tokio::test]
async fn going_away_waits_the_delay_the_api_asked_for() {
  let gateway = Gateway::bind().await;
  let setup = Setup::new(Arc::new(UnavailableHarnessHost::new("1.4.0".to_owned())));
  let mut runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.welcome(&[]).await;
  connection
    .send(json!({"type": "reconnect", "afterMs": 600}))
    .await;
  connection.close(1001, "going_away").await;
  assert_eq!(
    runner
      .reaches(|state| matches!(state, RunnerState::Retrying { .. }))
      .await,
    RunnerState::Retrying {
      attempt: 0,
      retry_in_ms: 600
    }
  );
  // Well past the backoff the other codes would use.
  gateway.stays_quiet(Duration::from_millis(400)).await;
  let mut connection = gateway.accept().await;
  connection.hello().await;
  runner.stop().await;
}

#[tokio::test]
async fn other_closes_back_off_with_growing_delays_and_a_wake_reconnects_at_once() {
  let gateway = Gateway::bind().await;
  let mut setup = Setup::new(Arc::new(UnavailableHarnessHost::new("1.4.0".to_owned())));
  setup.timing.backoff_base = Duration::from_millis(40);
  setup.timing.backoff_cap = Duration::from_secs(60);
  let mut runner = setup.start(&gateway);
  let mut delays = Vec::new();
  for _ in 0..3 {
    let mut connection = gateway.accept().await;
    connection.hello().await;
    // No welcome: the failure counts against the backoff.
    connection.close(4004, "sequence_gap").await;
    let RunnerState::Retrying { retry_in_ms, .. } = runner
      .reaches(|state| matches!(state, RunnerState::Retrying { .. }))
      .await
    else {
      unreachable!()
    };
    delays.push(retry_in_ms);
  }
  // Equal jitter at 0.5: three quarters of 40, 80, 160 ms.
  assert_eq!(delays, [30, 60, 120]);

  // A long backoff is cut short by a wake.
  setup.timing.backoff_base = Duration::from_secs(60);
  runner.stop().await;
  let mut runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.close(1011, "internal_error").await;
  runner
    .reaches(|state| matches!(state, RunnerState::Retrying { .. }))
    .await;
  gateway.stays_quiet(Duration::from_millis(200)).await;
  runner.wake.send_replace(1);
  let mut connection = gateway.accept().await;
  connection.hello().await;

  // On a live socket, a wake drops it and connects again right away.
  connection.welcome(&[]).await;
  runner
    .reaches(|state| *state == RunnerState::Connected)
    .await;
  runner.wake.send_replace(2);
  assert_eq!(connection.closed().await, Some(1001));
  let mut connection = gateway.accept().await;
  connection.hello().await;
  runner.stop().await;
}

#[tokio::test]
async fn frames_over_the_limit_are_refused_both_ways() {
  let gateway = Gateway::bind().await;
  let host = Arc::new(RecordingHost::default());
  let setup = Setup::new(Arc::clone(&host) as Arc<dyn HarnessHost>);
  let mut runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.welcome(&[]).await;
  connection
    .send(run_start(RUN, "2026-10-28T13:00:00.000Z"))
    .await;
  connection.receive_type("run.accepted").await;

  // An output whose frame would pass the limit is refused before it is
  // journaled, and takes no position.
  let sink = host.sink(RUN);
  let oversized = "x".repeat(MAX_FRAME_BYTES);
  assert_eq!(
    sink.emit(text_chunk(&oversized)).await,
    Err(EmitError::TooLarge)
  );
  assert_eq!(sink.emit(text_chunk("fits")).await.unwrap().get(), 1);
  assert_eq!(connection.receive_type("run.event").await["seq"], 1);

  // A frame from the API over the limit drops the socket: the runner stops
  // reading at the frame header, so the write may fail midway.
  let _partial = connection
    .socket
    .send(Message::text("x".repeat(MAX_FRAME_BYTES + 1)))
    .await;
  runner
    .reaches(|state| matches!(state, RunnerState::Retrying { .. }))
    .await;
  let mut connection = gateway.accept().await;
  assert_eq!(
    connection.hello().await["activeRuns"],
    json!([{"runId": RUN, "lastSeq": 1}])
  );
  runner.stop().await;
}

#[tokio::test]
async fn no_welcome_in_time_closes_the_socket_and_retries() {
  let gateway = Gateway::bind().await;
  let mut setup = Setup::new(Arc::new(UnavailableHarnessHost::new("1.4.0".to_owned())));
  setup.timing.welcome_timeout = Duration::from_millis(200);
  let mut runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  assert_eq!(connection.closed().await, Some(1000));
  runner
    .reaches(|state| matches!(state, RunnerState::Retrying { .. }))
    .await;
  let mut connection = gateway.accept().await;
  connection.hello().await;
  runner.stop().await;
}

#[tokio::test]
async fn without_an_account_the_runner_waits_signed_out_and_never_connects() {
  let gateway = Gateway::bind().await;
  let mut setup = Setup::new(Arc::new(UnavailableHarnessHost::new("1.4.0".to_owned())));
  setup.signed_in = false;
  let mut runner = setup.start(&gateway);
  runner
    .reaches(|state| *state == RunnerState::SignedOut)
    .await;
  gateway.stays_quiet(Duration::from_millis(200)).await;
  runner.stop().await;
}

#[tokio::test]
async fn stopping_closes_the_socket_normally_and_reports_off() {
  let gateway = Gateway::bind().await;
  let setup = Setup::new(Arc::new(UnavailableHarnessHost::new("1.4.0".to_owned())));
  let mut runner = setup.start(&gateway);
  let mut connection = gateway.accept().await;
  connection.hello().await;
  connection.welcome(&[]).await;
  runner
    .reaches(|state| *state == RunnerState::Connected)
    .await;
  let mut state = runner.state.clone();
  runner.stop().await;
  assert_eq!(connection.closed().await, Some(1000));
  assert_eq!(*state.borrow_and_update(), RunnerState::Off);
}
