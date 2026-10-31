//! The supervisor against a stand-in holder: this test binary, started again
//! through a shell script as the one ignored test `stand_in_holder`, which
//! serves the protocol on a real Unix socket. Spawning detached, connecting,
//! reconnecting, resuming, draining and shutdown run for real without Bun or
//! a harness CLI. The TypeScript holder itself is tested against the same
//! protocol fixtures in `packages/agent-engine`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write as _;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::net::unix::OwnedWriteHalf;
use tokio::sync::{Mutex, mpsc};

use super::protocol::{ProbeFailure, ProbedModel};
use super::*;
use crate::runner_protocol::{
  FsPolicy, HarnessCapability, McpBinding, McpToken, NetworkPolicy, RunPolicy,
};

const WAIT: Duration = Duration::from_secs(10);
const REQUEST_ID: &str = "6f1c2d1e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const VERSION: &str = "1.4.0";
const STAND_IN_TEST: &str = "harness_sidecar::tests::stand_in_holder";

struct Fixture {
  root: PathBuf,
}

impl Fixture {
  fn new() -> Self {
    // The fixture's root is also its socket folder: short and private.
    let id = uuid::Uuid::new_v4().simple().to_string();
    let root = std::env::temp_dir().join(format!("sh-{}", &id[..8]));
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let script = root.join("stand-in");
    let exe = std::env::current_exe().unwrap();
    fs::write(
      &script,
      format!(
        "#!/bin/sh\nSTAND_IN_DIR=\"$2\" STAND_IN_ENDPOINT=\"$4\" exec \"{}\" --exact {STAND_IN_TEST} --ignored --test-threads=1\n",
        exe.display()
      ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    Self { root }
  }

  fn holders(&self) -> PathBuf {
    self.root.join("holders")
  }

  fn log(&self) -> PathBuf {
    self.root.join("stand-in.log")
  }

  /// The socket of a holder version.
  fn endpoint(&self, version: &str) -> PathBuf {
    endpoint::socket_path(&self.root, version).unwrap()
  }

  fn endpoint_of(&self, holder_dir: &Path) -> PathBuf {
    self.endpoint(&holder_dir.file_name().unwrap().to_string_lossy())
  }

  /// Where a holder said it listens, else where this fixture puts it.
  fn recorded_or_computed(&self, holder_dir: &Path) -> PathBuf {
    fs::read_to_string(holder_dir.join(endpoint::ENDPOINT_FILE))
      .map_or_else(|_missing| self.endpoint_of(holder_dir), PathBuf::from)
  }

  /// A private socket folder below the fixture.
  fn socket_dir(&self, name: &str) -> PathBuf {
    let dir = self.root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    dir
  }

  fn sidecar_with_sockets_in(&self, socket_dir: PathBuf) -> HarnessSidecar {
    let mut settings = self.settings_for(VERSION, self.stand_in());
    settings.socket_dir = Some(socket_dir);
    HarnessSidecar::spawn(settings)
  }

  fn settings_for(&self, version: &str, launch: SidecarLaunch) -> SidecarSettings {
    SidecarSettings {
      launch: launch.env("FAKE_SIDECAR_LOG", self.log()),
      holder_root: self.holders(),
      socket_dir: Some(self.root.clone()),
      sidecar_version: version.to_owned(),
      app_version: "1.4.0".to_owned(),
      api_origin: "https://api.example.test".to_owned(),
      hello_timeout: Duration::from_secs(5),
      start_timeout: Duration::from_secs(10),
      shutdown_grace: Duration::from_secs(5),
      backoff: ReconnectBackoff {
        initial: Duration::from_millis(20),
        max: Duration::from_millis(100),
      },
    }
  }

  fn stand_in(&self) -> SidecarLaunch {
    SidecarLaunch::program(self.root.join("stand-in"), Vec::new())
  }

  fn sidecar_at(&self, version: &str) -> HarnessSidecar {
    HarnessSidecar::spawn(self.settings_for(version, self.stand_in()))
  }

  fn sidecar(&self) -> HarnessSidecar {
    self.sidecar_at(VERSION)
  }

  /// Every line a stand-in read, parsed.
  fn received(&self) -> Vec<Value> {
    fs::read_to_string(self.log())
      .unwrap_or_default()
      .lines()
      .filter_map(|line| serde_json::from_str(line).ok())
      .collect()
  }

  fn starts(&self) -> usize {
    fs::read_to_string(self.log())
      .unwrap_or_default()
      .lines()
      .filter(|line| line.starts_with("started "))
      .count()
  }
}

impl Drop for Fixture {
  /// Stop every stand-in still running: holders outlive their supervisor.
  fn drop(&mut self) {
    for entry in fs::read_dir(self.holders()).into_iter().flatten().flatten() {
      let dir = entry.path();
      let Some(secret) = read_secret(&dir) else {
        continue;
      };
      if let Ok(mut socket) =
        std::os::unix::net::UnixStream::connect(self.recorded_or_computed(&dir))
      {
        let hello = json!({
          "type": "hello",
          "protocol": SIDECAR_PROTOCOL,
          "secret": secret.0,
          "appVersion": "1.4.0",
          "apiOrigin": "https://api.example.test",
          "resume": [],
        });
        let _written = writeln!(socket, "{hello}\n{}", json!({ "type": "shutdown" }));
      }
    }
    let _removed = fs::remove_dir_all(&self.root);
  }
}

/// Runs a test body on its own runtime while holding the child-process guard.
fn with_children(body: impl std::future::Future<Output = ()>) {
  let _children = crate::test_child_processes::exclusive();
  tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .build()
    .unwrap()
    .block_on(body);
}

fn run_start(model: &str) -> SidecarRunStart {
  SidecarRunStart {
    run_id: uuid::Uuid::new_v4().to_string(),
    thread_id: "thread-1".to_owned(),
    harness: Harness::Codex,
    executable: "/data/harness/codex/0.165.0/codex".to_owned(),
    config_dir: "/data/harness-home/codex".to_owned(),
    workspace_dir: "/data/runs/1".to_owned(),
    model: model.to_owned(),
    instructions: String::new(),
    messages: vec![
      json!({ "role": "user", "content": "Find the lease decision." })
        .as_object()
        .unwrap()
        .clone(),
    ],
    harness_session_id: None,
    policy: RunPolicy {
      network: NetworkPolicy::Open,
      fs: FsPolicy::Workspace,
    },
    mcp: McpBinding {
      server_name: "stella".to_owned(),
      url: "https://api.example.test/mcp".to_owned(),
      token: McpToken("run-token-1".to_owned()),
      expires_at: "2026-10-28T12:00:00.000Z".to_owned(),
    },
  }
}

async fn next(outputs: &mut mpsc::Receiver<SidecarRunOutput>) -> SidecarRunOutput {
  tokio::time::timeout(WAIT, outputs.recv())
    .await
    .expect("the run reported in time")
    .expect("the run channel stays open until it finishes")
}

async fn finish(
  outputs: &mut mpsc::Receiver<SidecarRunOutput>,
) -> Vec<SidecarRunOutput> {
  let mut all = Vec::new();
  loop {
    let output = next(outputs).await;
    let finished = matches!(output, SidecarRunOutput::Finished { .. });
    all.push(output);
    if finished {
      return all;
    }
  }
}

fn started(run_id: &str) -> SidecarRunOutput {
  SidecarRunOutput::Event(
    json!({ "type": "RUN_STARTED", "runId": run_id })
      .as_object()
      .unwrap()
      .clone(),
  )
}

fn ended(outcome: RunOutcome) -> SidecarRunOutput {
  SidecarRunOutput::Finished {
    outcome,
    harness_session_id: None,
  }
}

fn seq(value: u32) -> NonZeroU32 {
  NonZeroU32::new(value).unwrap()
}

/// Wait for a condition another process makes true.
async fn until(what: &str, condition: impl Fn() -> bool) {
  let deadline = tokio::time::Instant::now() + WAIT;
  while !condition() {
    assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
    tokio::time::sleep(Duration::from_millis(20)).await;
  }
}

#[test]
fn a_run_streams_its_outputs_in_order_and_finishes() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let start = run_start("gpt-test");
    let run_id = start.run_id.clone();
    let mut outputs = sidecar.start_run(start).unwrap();
    assert_eq!(
      finish(&mut outputs).await,
      vec![
        started(&run_id),
        SidecarRunOutput::ApprovalRequest {
          request_id: REQUEST_ID.to_owned(),
          kind: ApprovalKind::Command,
          summary: "Deletes a file".to_owned(),
        },
        SidecarRunOutput::Finished {
          outcome: RunOutcome::Completed,
          harness_session_id: Some("thread-a".to_owned()),
        },
      ]
    );
    sidecar.shutdown().await;
  });
  let received = fixture.received();
  let hello = &received[0];
  assert_eq!(hello["type"], "hello");
  assert_eq!(hello["protocol"], SIDECAR_PROTOCOL);
  assert_eq!(hello["appVersion"], "1.4.0");
  assert_eq!(hello["apiOrigin"], "https://api.example.test");
  assert_eq!(hello["resume"], json!([]));
  assert!(HolderSecret::parse(hello["secret"].as_str().unwrap()).is_some());
  assert_eq!(received[1]["type"], "run.start");
  assert_eq!(received.last().unwrap(), &json!({ "type": "shutdown" }));
}

#[test]
fn probes_answer_with_the_holder_report() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let outcome = sidecar
      .probe(HarnessProbe {
        request_id: REQUEST_ID.to_owned(),
        harness: Harness::Codex,
        executable: "/data/harness/codex/0.165.0/codex".to_owned(),
        config_dir: "/data/harness-home/codex".to_owned(),
      })
      .await;
    assert_eq!(
      outcome,
      Ok(ProbeOutcome::NeedsLogin {
        version: "0.165.0".to_owned()
      })
    );
    sidecar.shutdown().await;
  });
}

#[test]
fn commands_for_a_run_reach_the_holder() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let start = run_start("wait");
    let run_id = start.run_id.clone();
    let mut outputs = sidecar.start_run(start).unwrap();
    assert_eq!(next(&mut outputs).await, started(&run_id));
    sidecar
      .token(RunTokenRefresh {
        run_id: run_id.clone(),
        token: McpToken("run-token-2".to_owned()),
        expires_at: "2026-10-28T13:00:00.000Z".to_owned(),
      })
      .unwrap();
    sidecar
      .approval(RunApproval {
        run_id: run_id.clone(),
        request_id: REQUEST_ID.to_owned(),
        decision: crate::runner_protocol::ApprovalDecision::Deny,
      })
      .unwrap();
    sidecar.interrupt(&run_id).unwrap();
    sidecar.cancel(&run_id).unwrap();
    assert_eq!(
      finish(&mut outputs).await,
      vec![ended(RunOutcome::Cancelled)]
    );
    sidecar.ack(&run_id, seq(2)).unwrap();
    assert_eq!(sidecar.held_runs().await, Ok(Vec::new()));
    sidecar.shutdown().await;
  });
  let types: Vec<Value> = fixture
    .received()
    .iter()
    .map(|message| message["type"].clone())
    .collect();
  assert_eq!(
    types,
    vec![
      "hello",
      "run.start",
      "run.token",
      "run.approval",
      "run.interrupt",
      "run.cancel",
      "ack",
      "shutdown"
    ]
  );
}

#[test]
fn runs_outlive_the_supervisor_and_resume_in_the_next_one() {
  let fixture = Fixture::new();
  with_children(async {
    let first = fixture.sidecar();
    let start = run_start("wait");
    let run_id = start.run_id.clone();
    let mut outputs = first.start_run(start).unwrap();
    assert_eq!(next(&mut outputs).await, started(&run_id));
    // What quitting the app does: the handle goes, nothing is sent.
    drop(first);
    // The holder still answers once the old supervisor let go.
    let endpoint = fixture.endpoint(VERSION);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(endpoint.exists());

    let second = fixture.sidecar();
    assert_eq!(
      second.held_runs().await,
      Ok(vec![HeldRun {
        run_id: run_id.clone(),
        harness: Harness::Codex,
        last_seq: 1,
      }])
    );
    let mut resumed = second.resume_run(&run_id, 1).await.unwrap();
    assert_eq!(
      second.resume_run(&run_id, 1).await.err(),
      Some(ResumeError::AlreadyClaimed)
    );
    second.cancel(&run_id).unwrap();
    assert_eq!(
      finish(&mut resumed).await,
      vec![ended(RunOutcome::Cancelled)]
    );
    second.ack(&run_id, seq(2)).unwrap();
    assert_eq!(second.held_runs().await, Ok(Vec::new()));
    assert_eq!(
      second.resume_run(&run_id, 0).await.err(),
      Some(ResumeError::UnknownRun)
    );
    second.shutdown().await;
  });
  assert_eq!(
    fixture.starts(),
    1,
    "the second supervisor started no holder"
  );
  let resumes: Vec<Value> = fixture
    .received()
    .into_iter()
    .filter(|message| message["type"] == "resume")
    .collect();
  assert_eq!(resumes.len(), 1);
  assert_eq!(resumes[0]["afterSeq"], 1);
}

#[test]
fn a_dropped_connection_resumes_after_the_last_delivered_message() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let start = run_start("wait");
    let run_id = start.run_id.clone();
    let mut outputs = sidecar.start_run(start).unwrap();
    assert_eq!(next(&mut outputs).await, started(&run_id));
    // Another connection replaces this one; the supervisor reconnects and
    // resumes after `seq` 1, so nothing arrives twice.
    let dir = fixture.holders().join(VERSION);
    let mut intruder =
      std::os::unix::net::UnixStream::connect(fixture.endpoint(VERSION)).unwrap();
    let hello = json!({
      "type": "hello",
      "protocol": SIDECAR_PROTOCOL,
      "secret": read_secret(&dir).unwrap().0,
      "appVersion": "1.4.0",
      "apiOrigin": "https://api.example.test",
      "resume": [],
    });
    writeln!(intruder, "{hello}").unwrap();
    until("the supervisor reconnected", || {
      fixture
        .received()
        .iter()
        .filter(|message| message["type"] == "hello")
        .count()
        >= 3
    })
    .await;
    sidecar.cancel(&run_id).unwrap();
    assert_eq!(
      finish(&mut outputs).await,
      vec![ended(RunOutcome::Cancelled)]
    );
    sidecar.shutdown().await;
  });
  let hellos: Vec<Value> = fixture
    .received()
    .into_iter()
    .filter(|message| message["type"] == "hello")
    .collect();
  assert_eq!(hellos[2]["resume"][0]["afterSeq"], 1);
}

#[test]
fn a_new_version_drains_the_old_holder_and_removes_its_folder() {
  let fixture = Fixture::new();
  with_children(async {
    let old = fixture.sidecar_at("1.3.0");
    let start = run_start("wait");
    let run_id = start.run_id.clone();
    let mut outputs = old.start_run(start).unwrap();
    assert_eq!(next(&mut outputs).await, started(&run_id));
    drop(old);
    tokio::time::sleep(Duration::from_millis(200)).await;

    let new = fixture.sidecar();
    assert_eq!(
      new.held_runs().await.map(|held| held.len()),
      Ok(1),
      "the old holder's run is listed"
    );
    let mut fresh = new.start_run(run_start("gpt-test")).unwrap();
    assert!(matches!(
      finish(&mut fresh).await.last(),
      Some(SidecarRunOutput::Finished {
        outcome: RunOutcome::Completed,
        ..
      })
    ));
    let mut resumed = new.resume_run(&run_id, 1).await.unwrap();
    new.cancel(&run_id).unwrap();
    assert_eq!(
      finish(&mut resumed).await,
      vec![ended(RunOutcome::Cancelled)]
    );
    new.ack(&run_id, seq(2)).unwrap();
    let old_dir = fixture.holders().join("1.3.0");
    until("the drained holder's folder is removed", || {
      !old_dir.exists()
    })
    .await;
    assert!(fixture.endpoint(VERSION).exists());
    new.shutdown().await;
  });
  assert_eq!(fixture.starts(), 2);
  assert!(
    fixture
      .received()
      .iter()
      .any(|message| message["type"] == "drain")
  );
}

#[test]
fn a_holder_that_dies_fails_its_runs_and_the_next_run_starts_a_new_one() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let mut crashed = sidecar.start_run(run_start("crash")).unwrap();
    let outputs = finish(&mut crashed).await;
    assert_eq!(outputs.last(), Some(&ended(RunOutcome::Failed)));
    let mut after = sidecar.start_run(run_start("gpt-test")).unwrap();
    assert!(matches!(
      finish(&mut after).await.last(),
      Some(SidecarRunOutput::Finished {
        outcome: RunOutcome::Completed,
        ..
      })
    ));
    sidecar.shutdown().await;
  });
  assert_eq!(fixture.starts(), 2, "a new holder was started");
}

#[test]
fn a_line_that_breaks_the_protocol_fails_the_held_runs() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let mut waiting = sidecar.start_run(run_start("wait")).unwrap();
    let mut broken = sidecar.start_run(run_start("garbage")).unwrap();
    assert_eq!(finish(&mut broken).await, vec![ended(RunOutcome::Failed)]);
    let waited = finish(&mut waiting).await;
    assert_eq!(waited.last(), Some(&ended(RunOutcome::Failed)));
    sidecar.shutdown().await;
  });
}

#[test]
fn shutdown_stops_the_runs_the_holder_and_the_supervisor() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let start = run_start("wait");
    let run_id = start.run_id.clone();
    let mut held = sidecar.start_run(start).unwrap();
    assert_eq!(next(&mut held).await, started(&run_id));
    sidecar.shutdown().await;
    assert_eq!(finish(&mut held).await, vec![ended(RunOutcome::Cancelled)]);
    assert_eq!(
      sidecar.start_run(run_start("gpt-test")).err(),
      Some(SidecarUnavailable::Stopped)
    );
  });
  assert_eq!(fixture.starts(), 1);
  assert!(!fixture.endpoint(VERSION).exists());
}

#[test]
fn a_holder_that_cannot_start_fails_runs_and_probes() {
  let fixture = Fixture::new();
  with_children(async {
    let missing = SidecarLaunch::program(fixture.root.join("missing"), Vec::new());
    let sidecar = HarnessSidecar::spawn(fixture.settings_for(VERSION, missing));
    let mut outputs = sidecar.start_run(run_start("gpt-test")).unwrap();
    assert_eq!(finish(&mut outputs).await, vec![ended(RunOutcome::Failed)]);
    let probe = sidecar
      .probe(HarnessProbe {
        request_id: REQUEST_ID.to_owned(),
        harness: Harness::Codex,
        executable: "/x".to_owned(),
        config_dir: "/y".to_owned(),
      })
      .await;
    assert_eq!(probe, Err(ProbeError::SidecarDown));
    sidecar.shutdown().await;
  });
}

#[test]
fn a_holder_folder_other_users_can_reach_is_refused() {
  let fixture = Fixture::new();
  let dir = fixture.holders().join(VERSION);
  fs::create_dir_all(&dir).unwrap();
  fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
  with_children(async {
    let sidecar = fixture.sidecar();
    let mut outputs = sidecar.start_run(run_start("gpt-test")).unwrap();
    assert_eq!(finish(&mut outputs).await, vec![ended(RunOutcome::Failed)]);
    sidecar.shutdown().await;
  });
  assert_eq!(fixture.starts(), 0);
}

/// Starts a run against settings whose socket folder is `socket_dir`.
fn run_with_socket_dir(
  fixture: &Fixture,
  socket_dir: PathBuf,
) -> Vec<SidecarRunOutput> {
  let mut outputs = Vec::new();
  with_children(async {
    let mut settings = fixture.settings_for(VERSION, fixture.stand_in());
    settings.socket_dir = Some(socket_dir);
    let sidecar = HarnessSidecar::spawn(settings);
    let mut run = sidecar.start_run(run_start("gpt-test")).unwrap();
    outputs = finish(&mut run).await;
    sidecar.shutdown().await;
  });
  outputs
}

#[test]
fn a_holder_is_found_where_it_recorded_its_endpoint_after_the_runtime_folder_moved() {
  let fixture = Fixture::new();
  let first_dir = fixture.socket_dir("run-a");
  let second_dir = fixture.socket_dir("run-b");
  with_children(async {
    let first = fixture.sidecar_with_sockets_in(first_dir.clone());
    let start = run_start("wait");
    let run_id = start.run_id.clone();
    let mut outputs = first.start_run(start).unwrap();
    assert_eq!(next(&mut outputs).await, started(&run_id));
    drop(first);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The next launch's environment names another runtime folder.
    let second = fixture.sidecar_with_sockets_in(second_dir.clone());
    assert_eq!(
      second.held_runs().await,
      Ok(vec![HeldRun {
        run_id: run_id.clone(),
        harness: Harness::Codex,
        last_seq: 1,
      }])
    );
    let mut resumed = second.resume_run(&run_id, 1).await.unwrap();
    second.cancel(&run_id).unwrap();
    assert_eq!(
      finish(&mut resumed).await,
      vec![ended(RunOutcome::Cancelled)]
    );
    second.shutdown().await;
  });
  assert_eq!(fixture.starts(), 1, "no second holder was started");
  assert!(
    !endpoint::socket_path(&second_dir, VERSION)
      .unwrap()
      .exists()
  );
  assert!(
    !fixture
      .holders()
      .join(VERSION)
      .join(endpoint::ENDPOINT_FILE)
      .exists()
  );
}

#[test]
fn a_recorded_endpoint_nothing_answers_on_is_dropped_for_a_fresh_holder() {
  let fixture = Fixture::new();
  let dir = fixture.holders().join(VERSION);
  fs::create_dir_all(&dir).unwrap();
  fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
  let stale = endpoint::socket_path(&fixture.socket_dir("gone"), VERSION).unwrap();
  let record = dir.join(endpoint::ENDPOINT_FILE);
  fs::write(&record, stale.as_os_str().as_encoded_bytes()).unwrap();
  with_children(async {
    let sidecar = fixture.sidecar();
    let mut outputs = sidecar.start_run(run_start("gpt-test")).unwrap();
    assert!(matches!(
      finish(&mut outputs).await.last(),
      Some(SidecarRunOutput::Finished {
        outcome: RunOutcome::Completed,
        ..
      })
    ));
    assert_eq!(
      PathBuf::from(fs::read_to_string(&record).unwrap()),
      fixture.endpoint(VERSION),
      "the fresh holder recorded its own endpoint"
    );
    sidecar.shutdown().await;
  });
  assert_eq!(fixture.starts(), 1);
}

#[test]
fn a_socket_folder_other_users_can_reach_is_refused() {
  let fixture = Fixture::new();
  let open = fixture.root.join("sockets");
  fs::create_dir_all(&open).unwrap();
  fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).unwrap();
  assert_eq!(
    run_with_socket_dir(&fixture, open),
    vec![ended(RunOutcome::Failed)]
  );
  assert_eq!(fixture.starts(), 0);
}

#[test]
fn a_socket_path_over_the_platform_limit_is_never_used() {
  let fixture = Fixture::new();
  let long = fixture.root.join("d".repeat(endpoint::SUN_PATH_BYTES));
  fs::create_dir_all(&long).unwrap();
  fs::set_permissions(&long, fs::Permissions::from_mode(0o700)).unwrap();
  assert!(matches!(
    endpoint::socket_path(&long, VERSION),
    Err(EndpointError::TooLong { .. })
  ));
  assert_eq!(
    run_with_socket_dir(&fixture, long),
    vec![ended(RunOutcome::Failed)]
  );
  assert_eq!(fixture.starts(), 0);
}

#[test]
fn a_bundled_holder_runs_from_a_private_copy_in_its_version_folder() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = HarnessSidecar::spawn(
      fixture.settings_for(VERSION, fixture.stand_in().per_version_copy()),
    );
    let mut outputs = sidecar.start_run(run_start("gpt-test")).unwrap();
    assert!(matches!(
      finish(&mut outputs).await.last(),
      Some(SidecarRunOutput::Finished {
        outcome: RunOutcome::Completed,
        ..
      })
    ));
    sidecar.shutdown().await;
  });
  let dir = fixture.holders().join(VERSION);
  let copy = dir.join(BUNDLED_NAME);
  assert_eq!(
    fs::read(&copy).unwrap(),
    fs::read(fixture.root.join("stand-in")).unwrap()
  );
  assert_eq!(
    fs::metadata(&copy).unwrap().permissions().mode() & 0o777,
    0o700
  );
  assert_eq!(
    fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
    0o700
  );
}

#[test]
fn the_bundled_sidecar_sits_beside_the_app_executable() {
  let launch = SidecarLaunch::bundled(Path::new(
    "/Applications/stella.app/Contents/MacOS/stella-desktop",
  ))
  .unwrap();
  assert_eq!(
    launch.program,
    PathBuf::from("/Applications/stella.app/Contents/MacOS/stella-agent-sidecar")
  );
  assert_eq!(launch.install, Install::PerVersionCopy);
  let source = SidecarLaunch::from_source(PathBuf::from("bun"));
  assert_eq!(source.install, Install::InPlace);
  assert!(
    PathBuf::from(&source.args[0])
      .ends_with("packages/agent-engine/src/sidecar/main.ts")
  );
}

#[test]
fn reconnect_delays_double_up_to_the_maximum() {
  let backoff = ReconnectBackoff::DEFAULT;
  assert_eq!(backoff.delay(0), Duration::from_millis(100));
  assert_eq!(backoff.delay(1), Duration::from_millis(200));
  assert_eq!(backoff.delay(3), Duration::from_millis(800));
  assert_eq!(backoff.delay(40), Duration::from_secs(2));
}

#[test]
fn probe_outcomes_become_runner_reports() {
  let ready = ProbeOutcome::Ready {
    version: "0.165.0".to_owned(),
    capabilities: vec![HarnessCapability::Approvals, HarnessCapability::Approvals],
    models: vec![
      ProbedModel {
        id: "gpt-test".to_owned(),
        label: "GPT Test".to_owned(),
        is_default: true,
      },
      ProbedModel {
        id: "gpt-test".to_owned(),
        label: "Again".to_owned(),
        is_default: false,
      },
    ],
  };
  assert_eq!(
    harness_report(Harness::Codex, &ready),
    HarnessReport::Ready(ReadyHarness {
      id: Harness::Codex,
      version: "0.165.0".to_owned(),
      capabilities: vec![HarnessCapability::Approvals],
      models: vec![HarnessModel {
        id: "gpt-test".to_owned(),
        label: "GPT Test".to_owned(),
      }],
    })
  );
  let no_models = ProbeOutcome::Ready {
    version: "0.165.0".to_owned(),
    capabilities: Vec::new(),
    models: Vec::new(),
  };
  assert_eq!(
    harness_report(Harness::Codex, &no_models),
    HarnessReport::Unsupported(UnsupportedHarness {
      id: Harness::Codex,
      version: Some("0.165.0".to_owned()),
    })
  );
  assert_eq!(
    harness_report(
      Harness::Codex,
      &ProbeOutcome::NeedsLogin {
        version: "0.165.0".to_owned()
      }
    ),
    HarnessReport::NeedsLogin(SignedOutHarness {
      id: Harness::Codex,
      version: "0.165.0".to_owned(),
    })
  );
  assert_eq!(
    harness_report(
      Harness::Codex,
      &ProbeOutcome::Unsupported {
        version: "0.150.0".to_owned(),
        recommended_version: Some("0.164.0".to_owned()),
      }
    ),
    HarnessReport::Unsupported(UnsupportedHarness {
      id: Harness::Codex,
      version: Some("0.150.0".to_owned()),
    })
  );
  assert_eq!(
    harness_report(
      Harness::ClaudeCode,
      &ProbeOutcome::Failed {
        reason: ProbeFailure::Unsupported,
        message: "no adapter".to_owned(),
      }
    ),
    HarnessReport::Unsupported(UnsupportedHarness {
      id: Harness::ClaudeCode,
      version: None,
    })
  );
}

/// The stand-in holder process. The other tests start it through the
/// script in their fixture, which names its folder and socket; run without
/// them, as in a full test run, it returns at once.
#[test]
#[ignore = "the stand-in holder process the other tests start"]
fn stand_in_holder() {
  let (Some(dir), Some(endpoint), Some(log)) = (
    std::env::var_os("STAND_IN_DIR"),
    std::env::var_os("STAND_IN_ENDPOINT"),
    std::env::var_os("FAKE_SIDECAR_LOG"),
  ) else {
    return;
  };
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap()
    .block_on(stand_in::serve(
      PathBuf::from(dir),
      PathBuf::from(endpoint),
      PathBuf::from(log),
    ));
}

/// What the stand-in does, by the started run's model:
/// - `gpt-test`: an event, an approval request, then `completed`;
/// - `wait`: an event, then nothing until it is cancelled;
/// - `crash`: an event, then the process exits without cleaning up;
/// - `garbage`: a line that is not JSON.
mod stand_in {
  use super::*;

  struct StandInRun {
    harness: Value,
    last: u32,
    finished: bool,
    kept: Vec<(u32, String)>,
  }

  struct Connection {
    id: u64,
    writer: OwnedWriteHalf,
    attached: HashSet<String>,
  }

  struct State {
    dir: PathBuf,
    endpoint: PathBuf,
    log: PathBuf,
    secret: String,
    draining: bool,
    runs: HashMap<String, StandInRun>,
    current: Option<Connection>,
  }

  fn append(log: &Path, line: &str) {
    let mut file = fs::OpenOptions::new()
      .create(true)
      .append(true)
      .open(log)
      .unwrap();
    writeln!(file, "{line}").unwrap();
  }

  pub(super) async fn serve(dir: PathBuf, endpoint: PathBuf, log: PathBuf) {
    let version = dir.file_name().unwrap().to_string_lossy().into_owned();
    append(&log, &format!("started {version}"));
    let _stale = fs::remove_file(&endpoint);
    let listener = UnixListener::bind(&endpoint).unwrap();
    let secret = format!(
      "{}{}",
      uuid::Uuid::new_v4().simple(),
      uuid::Uuid::new_v4().simple()
    );
    fs::write(dir.join(SECRET_FILE), &secret).unwrap();
    fs::write(
      dir.join(endpoint::ENDPOINT_FILE),
      endpoint.as_os_str().as_encoded_bytes(),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(State {
      dir,
      endpoint,
      log,
      secret,
      draining: false,
      runs: HashMap::new(),
      current: None,
    }));
    let mut next_id = 0;
    loop {
      let (stream, _address) = listener.accept().await.unwrap();
      next_id += 1;
      tokio::spawn(connection(
        Arc::clone(&state),
        stream,
        next_id,
        version.clone(),
      ));
    }
  }

  async fn connection(
    state: Arc<Mutex<State>>,
    stream: tokio::net::UnixStream,
    id: u64,
    version: String,
  ) {
    let (read, writer) = stream.into_split();
    let mut writer = Some(writer);
    let mut lines = tokio::io::BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      let mut held = state.lock().await;
      append(&held.log, &line);
      let Ok(message) = serde_json::from_str::<Value>(&line) else {
        return;
      };
      if let Some(mut writer) = writer.take() {
        if message["type"] != "hello" || message["secret"] != held.secret.as_str() {
          return;
        }
        let runs: Vec<Value> = held
          .runs
          .iter()
          .map(|(run_id, run)| {
            json!({ "runId": run_id, "harness": run.harness, "lastSeq": run.last })
          })
          .collect();
        let mode = if held.draining { "draining" } else { "serving" };
        let hello = json!({
          "type": "hello",
          "protocol": SIDECAR_PROTOCOL,
          "sidecarVersion": version,
          "mode": mode,
          "runs": runs,
        });
        writer
          .write_all(format!("{hello}\n").as_bytes())
          .await
          .unwrap();
        if let Some(mut previous) = held.current.take() {
          let _closed = previous.writer.shutdown().await;
        }
        let mut connection = Connection {
          id,
          writer,
          attached: HashSet::new(),
        };
        for point in message["resume"].as_array().cloned().unwrap_or_default() {
          resume(&held, &mut connection, &point, "hello").await;
        }
        held.current = Some(connection);
        continue;
      }
      if held.current.as_ref().map(|current| current.id) != Some(id) {
        return;
      }
      command(&mut held, &message).await;
      drop(held);
    }
    let mut held = state.lock().await;
    if held.current.as_ref().map(|current| current.id) == Some(id) {
      held.current = None;
    }
  }

  async fn write(held: &mut State, line: &str) {
    if let Some(current) = held.current.as_mut() {
      let _written = current
        .writer
        .write_all(format!("{line}\n").as_bytes())
        .await;
    }
  }

  async fn resume(
    held: &State,
    connection: &mut Connection,
    point: &Value,
    message_type: &str,
  ) {
    let run_id = point["runId"].as_str().unwrap().to_owned();
    let after = point["afterSeq"].as_u64().unwrap();
    let Some(run) = held.runs.get(&run_id) else {
      let rejected = json!({
        "type": "rejected",
        "reason": "unknown_run",
        "messageType": message_type,
        "runId": run_id,
      });
      let _written = connection
        .writer
        .write_all(format!("{rejected}\n").as_bytes())
        .await;
      return;
    };
    for (seq, line) in &run.kept {
      if u64::from(*seq) > after {
        let _written = connection.writer.write_all(line.as_bytes()).await;
      }
    }
    connection.attached.insert(run_id);
  }

  async fn emit(held: &mut State, run_id: &str, mut message: Value) {
    let State { runs, current, .. } = held;
    let run = runs.get_mut(run_id).unwrap();
    run.last += 1;
    message["seq"] = json!(run.last);
    if message["type"] == "run.finished" {
      run.finished = true;
    }
    let line = format!("{message}\n");
    run.kept.push((run.last, line.clone()));
    if let Some(current) = current
      .as_mut()
      .filter(|current| current.attached.contains(run_id))
    {
      let _written = current.writer.write_all(line.as_bytes()).await;
    }
  }

  fn finished(run_id: &str, outcome: &str, session: Option<&str>) -> Value {
    json!({
      "type": "run.finished",
      "runId": run_id,
      "outcome": outcome,
      "harnessSessionId": session,
    })
  }

  fn exit(held: &State) -> ! {
    let _socket = fs::remove_file(&held.endpoint);
    let _secret = fs::remove_file(held.dir.join(SECRET_FILE));
    let _record = fs::remove_file(held.dir.join(endpoint::ENDPOINT_FILE));
    std::process::exit(0);
  }

  async fn command(held: &mut State, message: &Value) {
    let run_id = message["runId"].as_str().unwrap_or_default().to_owned();
    match message["type"].as_str().unwrap_or_default() {
      "run.start" => {
        held.runs.insert(
          run_id.clone(),
          StandInRun {
            harness: message["harness"].clone(),
            last: 0,
            finished: false,
            kept: Vec::new(),
          },
        );
        if let Some(current) = held.current.as_mut() {
          current.attached.insert(run_id.clone());
        }
        let event = json!({
          "type": "run.event",
          "runId": run_id,
          "chunk": { "type": "RUN_STARTED", "runId": run_id },
        });
        match message["model"].as_str().unwrap_or_default() {
          "garbage" => write(held, "not json").await,
          "wait" => emit(held, &run_id, event).await,
          "crash" => {
            emit(held, &run_id, event).await;
            std::process::exit(3);
          }
          _ => {
            emit(held, &run_id, event).await;
            let request = json!({
              "type": "run.approval_request",
              "runId": run_id,
              "requestId": REQUEST_ID,
              "kind": "command",
              "summary": "Deletes a file",
            });
            emit(held, &run_id, request).await;
            emit(
              held,
              &run_id,
              finished(&run_id, "completed", Some("thread-a")),
            )
            .await;
          }
        }
      }
      "run.cancel" => {
        if held.runs.get(&run_id).is_some_and(|run| !run.finished) {
          emit(held, &run_id, finished(&run_id, "cancelled", None)).await;
        }
      }
      "harness.probe" => {
        let probed = json!({
          "type": "harness.probed",
          "requestId": message["requestId"],
          "harness": "codex",
          "outcome": { "type": "needs_login", "version": "0.165.0" },
        });
        write(held, &probed.to_string()).await;
      }
      "ack" => {
        let through = message["seq"].as_u64().unwrap_or_default();
        if let Some(run) = held.runs.get_mut(&run_id) {
          run.kept.retain(|(seq, _line)| u64::from(*seq) > through);
          if run.finished && run.kept.is_empty() {
            held.runs.remove(&run_id);
          }
        }
        if held.draining && held.runs.is_empty() {
          exit(held);
        }
      }
      "resume" => {
        if let Some(mut current) = held.current.take() {
          resume(held, &mut current, message, "resume").await;
          held.current = Some(current);
        }
      }
      "drain" => {
        held.draining = true;
        if held.runs.is_empty() {
          exit(held);
        }
      }
      "shutdown" => {
        let running: Vec<String> = held
          .runs
          .iter()
          .filter(|(_run_id, run)| !run.finished)
          .map(|(run_id, _run)| run_id.clone())
          .collect();
        for run_id in running {
          emit(held, &run_id, finished(&run_id, "cancelled", None)).await;
        }
        exit(held);
      }
      _ => {}
    }
  }
}
