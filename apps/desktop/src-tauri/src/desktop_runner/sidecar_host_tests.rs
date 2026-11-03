//! The harness host end to end, with nothing of ours mocked: the real runner
//! over a local gateway socket, the real journal, the real supervisor and a
//! real holder process (the supervisor tests' stand-in, which re-executes
//! this test binary). Only the managed CLIs and the ChatGPT connection are
//! fakes, since neither may run here.

use std::{
  path::PathBuf,
  sync::{Arc, Mutex},
  time::Duration,
};

use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use super::harness::{HarnessHost, HarnessReports};
use super::sidecar_host::{
  HarnessCredentials, HostSettings, InstalledHarness, LocalHarnesses,
  SidecarHarnessHost,
};
use super::tests::{Connection, Gateway, Setup};
use crate::harness_sidecar::tests::Fixture;
use crate::harness_sidecar::{HarnessLaunchSettings, HarnessSidecar};
use crate::runner_protocol::Harness;

const WAIT: Duration = Duration::from_secs(10);
const VERSION: &str = "0.50.0";
/// The approval request id the stand-in holder asks with.
const REQUEST_ID: &str = "6f1c2d1e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
/// The stand-in's scenarios, each a model the probe reports.
const MODELS: &[&str] = &[
  "gpt-test",
  "wait",
  "interruptible",
  "approve",
  "needs-login",
  "crash",
];

/// Codex installed at `VERSION`, optionally on a credential that records
/// every process it authorizes; Claude Code not installed.
struct FakeHarnesses {
  root: PathBuf,
  credentials: Option<HarnessCredentials>,
}

impl LocalHarnesses for FakeHarnesses {
  fn installed(&self, harness: Harness) -> Option<InstalledHarness> {
    (harness == Harness::Codex).then(|| InstalledHarness {
      version: VERSION.to_owned(),
      executable: self.root.join("harness/codex"),
      config_dir: self.root.join("harness-home/codex"),
      lease: Box::new(()),
    })
  }

  fn credentials(&self, harness: Harness) -> BoxFuture<'_, Option<HarnessCredentials>> {
    let credentials = (harness == Harness::Codex)
      .then(|| self.credentials.clone())
      .flatten();
    Box::pin(async move { credentials })
  }
}

/// Every process id a credential authorized, and how many grants are held.
#[derive(Default)]
struct Grants {
  authorized: Mutex<Vec<u32>>,
  held: Arc<Mutex<usize>>,
}

struct Held(Arc<Mutex<usize>>);

impl Drop for Held {
  fn drop(&mut self) {
    *self.0.lock().unwrap() -= 1;
  }
}

fn chatgpt_credentials(grants: &Arc<Grants>) -> HarnessCredentials {
  let grants = Arc::clone(grants);
  HarnessCredentials {
    settings: HarnessLaunchSettings {
      config_overrides: vec!["model_provider=\"openai_chatgpt_plan\"".to_owned()],
      environment: [(
        "STELLA_CODEX_TOKEN_BROKER".to_owned(),
        "/broker/s".to_owned(),
      )]
      .into_iter()
      .collect(),
      removed_environment: vec!["OPENAI_API_KEY".to_owned()],
      client_name: Some("Stella".to_owned()),
      process_grant: true,
    },
    grant: Some(Arc::new(move |pid| {
      grants.authorized.lock().unwrap().push(pid);
      *grants.held.lock().unwrap() += 1;
      Box::new(Held(Arc::clone(&grants.held))) as Box<dyn Send + Sync>
    })),
  }
}

/// A host on a stand-in holder, and the probe answer it reads.
struct Place {
  fixture: Fixture,
}

impl Place {
  fn new() -> Self {
    let place = Self {
      fixture: Fixture::new(),
    };
    place.probe_answers(&ready());
    place
  }

  /// What the next probe of Codex answers.
  fn probe_answers(&self, outcome: &Value) {
    std::fs::write(
      self.fixture.log().with_file_name("probe-codex.json"),
      outcome.to_string(),
    )
    .unwrap();
  }

  fn host(
    &self,
    credentials: Option<HarnessCredentials>,
    probe_interval: Duration,
  ) -> SidecarHarnessHost {
    SidecarHarnessHost::new(
      HostSettings {
        sidecar: self.fixture.settings_for("1.4.0", self.fixture.stand_in()),
        workspaces: self.workspaces(),
        probe_interval,
      },
      Arc::new(FakeHarnesses {
        root: self.fixture.root.clone(),
        credentials,
      }),
    )
  }

  fn workspaces(&self) -> PathBuf {
    self.fixture.root.join("runs")
  }

  /// Every message the holder read, of one type.
  fn received(&self, kind: &str) -> Vec<Value> {
    self
      .fixture
      .received()
      .into_iter()
      .filter(|message| message["type"] == kind)
      .collect()
  }

  /// The holder seqs the host acked for a run, in order.
  fn acks(&self, run_id: &str) -> Vec<u64> {
    self
      .received("ack")
      .iter()
      .filter(|ack| ack["runId"] == run_id)
      .map(|ack| ack["seq"].as_u64().unwrap())
      .collect()
  }
}

fn ready() -> Value {
  let models: Vec<Value> = MODELS
    .iter()
    .map(|id| json!({ "id": id, "label": id, "isDefault": false }))
    .collect();
  json!({
    "type": "ready",
    "version": VERSION,
    "capabilities": ["approvals", "interrupt"],
    "models": models,
  })
}

fn setup(host: &SidecarHarnessHost) -> Setup {
  let mut setup = Setup::new(Arc::new(host.clone()) as Arc<dyn HarnessHost>);
  setup.reports = Arc::new(host.clone()) as Arc<dyn HarnessReports>;
  setup
}

fn run_id() -> String {
  uuid::Uuid::new_v4().to_string()
}

fn run_start(run_id: &str, model: &str) -> Value {
  json!({
    "type": "run.start",
    "runId": run_id,
    "harness": "codex",
    "harnessVersion": VERSION,
    "model": model,
    "harnessSessionId": null,
    "instructions": "Summarize the matter.",
    "messages": [{"role": "user", "content": "Summarize the matter."}],
    "policy": {"network": "open", "fs": "workspace"},
    "mcp": {
      "serverName": "stella",
      "url": "https://api.example.test/mcp",
      "token": "run-token-1",
      "expiresAt": "2026-10-28T13:00:00.000Z",
    },
  })
}

fn codex_state(report: &Value) -> Option<&str> {
  (report["id"] == "codex").then(|| report["state"].as_str().unwrap_or_default())
}

/// Accept a connection, welcome it with `resume`, and wait until the API
/// knows Codex as `state`, from `hello` or a later `harness.status`.
async fn connect(gateway: &Gateway, resume: &[(&str, u32)], state: &str) -> Connection {
  let mut connection = gateway.accept().await;
  let hello = connection.hello().await;
  connection.welcome(resume).await;
  let known = hello["harnesses"]
    .as_array()
    .unwrap()
    .iter()
    .any(|report| codex_state(report) == Some(state));
  if !known {
    status(&mut connection, state).await;
  }
  connection
}

/// The next `harness.status`, which must report Codex as `state`.
async fn status(connection: &mut Connection, state: &str) -> Value {
  let status = connection.receive_type("harness.status").await;
  assert_eq!(codex_state(&status["harness"]), Some(state), "{status}");
  status
}

/// The run's messages up to and including its `run.finished`.
async fn until_finished(connection: &mut Connection) -> Vec<Value> {
  let mut messages = Vec::new();
  loop {
    let message = connection.receive().await;
    let finished = message["type"] == "run.finished";
    messages.push(message);
    if finished {
      return messages;
    }
  }
}

fn seqs(messages: &[Value]) -> Vec<u64> {
  messages
    .iter()
    .filter_map(|message| message["seq"].as_u64())
    .collect()
}

/// Wait for a condition another process or task makes true.
async fn until(what: &str, condition: impl Fn() -> bool) {
  let deadline = tokio::time::Instant::now() + WAIT;
  while !condition() {
    assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
    tokio::time::sleep(Duration::from_millis(20)).await;
  }
}

/// A test body on its own runtime, holding the child-process guard.
fn run(body: impl std::future::Future<Output = ()>) {
  let _children = crate::test_child_processes::exclusive();
  tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .build()
    .unwrap()
    .block_on(body);
}

/// Stop every holder the fixture's host started.
fn stop_holders(place: &Place) {
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap()
    .block_on(async {
      let settings = place
        .fixture
        .settings_for("1.4.0", place.fixture.stand_in());
      HarnessSidecar::spawn(settings).shutdown().await;
    });
}

#[test]
fn a_run_streams_through_the_runner_in_its_own_order_and_acks_the_holder_after_each_output()
 {
  let place = Place::new();
  let id = run_id();
  run(async {
    let host = place.host(None, Duration::from_secs(3600));
    let setup = setup(&host);
    let gateway = Gateway::bind().await;
    let runner = setup.start(&gateway);
    let mut connection = connect(&gateway, &[], "ready").await;
    connection.send(run_start(&id, "gpt-test")).await;
    assert_eq!(
      connection.receive().await,
      json!({"type": "run.accepted", "runId": id})
    );
    let messages = until_finished(&mut connection).await;
    assert_eq!(seqs(&messages), vec![1, 2, 3]);
    assert_eq!(messages[0]["chunk"]["type"], "RUN_STARTED");
    assert_eq!(messages[1]["type"], "run.approval_request");
    assert_eq!(messages[1]["requestId"], REQUEST_ID);
    assert_eq!(messages[2]["outcome"], "completed");
    assert_eq!(messages[2]["harnessSessionId"], "thread-a");
    until("the holder was acked through its last seq", || {
      place.acks(&id) == vec![1, 2, 3]
    })
    .await;
    let workspace = place.workspaces().join(&id);
    until("the run's folder was removed", || !workspace.exists()).await;
    runner.stop().await;
  });
  stop_holders(&place);
  let start = place.received("run.start").remove(0);
  assert_eq!(start["runId"], id.as_str());
  assert_eq!(start["threadId"], id.as_str());
  assert_eq!(
    start["executable"],
    place.fixture.root.join("harness/codex").to_str().unwrap()
  );
  assert_eq!(
    start["configDir"],
    place
      .fixture
      .root
      .join("harness-home/codex")
      .to_str()
      .unwrap()
  );
  assert_eq!(
    start["workspaceDir"],
    place.workspaces().join(&id).to_str().unwrap()
  );
  assert_eq!(start["launch"]["processGrant"], false);
}

#[test]
fn runs_the_harness_cannot_take_are_refused_before_the_holder_sees_them() {
  let place = Place::new();
  run(async {
    let host = place.host(None, Duration::from_millis(100));
    let setup = setup(&host);
    let gateway = Gateway::bind().await;
    let runner = setup.start(&gateway);
    let mut connection = connect(&gateway, &[], "ready").await;
    let mut older = run_start(&run_id(), "gpt-test");
    older["harnessVersion"] = json!("0.49.0");
    let mut claude = run_start(&run_id(), "gpt-test");
    claude["harness"] = json!("claude-code");
    let cases = [
      (run_start(&run_id(), "gpt-unknown"), "model_unavailable"),
      (older, "harness_version_unavailable"),
      (claude, "harness_not_installed"),
    ];
    for (start, reason) in cases {
      connection.send(start.clone()).await;
      assert_eq!(
        connection.receive().await,
        json!({"type": "run.rejected", "runId": start["runId"], "reason": reason})
      );
    }
    for (outcome, reason) in [
      (
        json!({ "type": "needs_login", "version": VERSION }),
        "harness_needs_login",
      ),
      (
        json!({ "type": "limit_until", "version": VERSION, "resetsAt": "2026-10-28T14:00:00Z" }),
        "harness_limited",
      ),
      (
        json!({ "type": "unsupported", "version": VERSION, "recommendedVersion": null }),
        "harness_unsupported",
      ),
    ] {
      place.probe_answers(&outcome);
      // The next probe changes the report, and the API hears of it.
      let state = connection.receive_type("harness.status").await;
      assert_ne!(state["harness"]["state"], "ready", "{state}");
      let start = run_start(&run_id(), "gpt-test");
      connection.send(start.clone()).await;
      assert_eq!(
        connection.receive().await,
        json!({"type": "run.rejected", "runId": start["runId"], "reason": reason})
      );
    }
    runner.stop().await;
  });
  stop_holders(&place);
  assert!(place.received("run.start").is_empty());
}

#[test]
fn approvals_interrupts_and_cancels_reach_the_harness_and_its_end_comes_back() {
  let place = Place::new();
  run(async {
    let host = place.host(None, Duration::from_secs(3600));
    let setup = setup(&host);
    let gateway = Gateway::bind().await;
    let runner = setup.start(&gateway);
    let mut connection = connect(&gateway, &[], "ready").await;

    let approved = run_id();
    connection.send(run_start(&approved, "approve")).await;
    connection.receive_type("run.accepted").await;
    connection.receive_type("run.event").await;
    let request = connection.receive_type("run.approval_request").await;
    connection
      .send(json!({
        "type": "run.approval",
        "runId": approved,
        "requestId": request["requestId"],
        "decision": "approve_for_session",
      }))
      .await;
    let rest = until_finished(&mut connection).await;
    assert_eq!(rest[0]["chunk"]["delta"], "approve_for_session");
    assert_eq!(rest[1]["outcome"], "completed");
    assert_eq!(seqs(&rest), vec![3, 4]);

    for (model, command, outcome) in [
      ("interruptible", "run.interrupt", "interrupted"),
      ("wait", "run.cancel", "cancelled"),
    ] {
      let id = run_id();
      connection.send(run_start(&id, model)).await;
      connection.receive_type("run.accepted").await;
      connection.receive_type("run.event").await;
      connection.send(json!({"type": command, "runId": id})).await;
      let finished = connection.receive_type("run.finished").await;
      assert_eq!(finished["outcome"], outcome);
      assert_eq!(finished["seq"], 2);
    }
    runner.stop().await;
  });
  stop_holders(&place);
}

#[test]
fn a_holder_that_dies_ends_its_runs_failed_and_input_is_answered_on_the_stream() {
  let place = Place::new();
  run(async {
    let host = place.host(None, Duration::from_secs(3600));
    let setup = setup(&host);
    let gateway = Gateway::bind().await;
    let runner = setup.start(&gateway);
    let mut connection = connect(&gateway, &[], "ready").await;

    let waiting = run_id();
    connection.send(run_start(&waiting, "wait")).await;
    connection.receive_type("run.accepted").await;
    connection.receive_type("run.event").await;
    connection
      .send(json!({
        "type": "run.input",
        "runId": waiting,
        "inputId": "input-1",
        "message": {"role": "user", "content": "And the appeal?"},
      }))
      .await;
    let answered = connection.receive_type("run.event").await;
    assert_eq!(answered["seq"], 2);
    assert_eq!(answered["chunk"]["type"], "RUN_ERROR");
    assert_eq!(answered["chunk"]["code"], "input_unsupported");
    assert_eq!(answered["chunk"]["runId"], waiting.as_str());

    let crashed = run_id();
    connection.send(run_start(&crashed, "crash")).await;
    connection.receive_type("run.accepted").await;
    // Both runs end failed: the one that crashed the holder, and the one
    // it held. Neither end came from the holder, so no ack names it.
    let mut ends = Vec::new();
    while ends.len() < 2 {
      let message = connection.receive().await;
      if message["type"] == "run.finished" {
        ends.push((
          message["runId"].as_str().unwrap().to_owned(),
          message["seq"].clone(),
          message["outcome"].clone(),
        ));
      }
    }
    ends.sort_by(|left, right| left.0.cmp(&right.0));
    let mut expected = vec![
      (waiting.clone(), json!(3), json!("failed")),
      (crashed.clone(), json!(2), json!("failed")),
    ];
    expected.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(ends, expected);
    runner.stop().await;
  });
  stop_holders(&place);
}

#[test]
fn a_changed_probe_reaches_the_api_and_a_run_that_needs_a_login_probes_again() {
  let place = Place::new();
  run(async {
    let host = place.host(None, Duration::from_secs(3600));
    let setup = setup(&host);
    let gateway = Gateway::bind().await;
    let runner = setup.start(&gateway);
    let mut connection = connect(&gateway, &[], "ready").await;
    let probes = place.received("harness.probe").len();
    place.probe_answers(&json!({ "type": "needs_login", "version": VERSION }));
    let id = run_id();
    connection.send(run_start(&id, "needs-login")).await;
    connection.receive_type("run.accepted").await;
    let messages = until_finished(&mut connection).await;
    assert_eq!(messages.last().unwrap()["outcome"], "needs_login");
    let changed = status(&mut connection, "needs_login").await;
    assert_eq!(changed["harness"]["version"], VERSION);
    assert!(place.received("harness.probe").len() > probes);
    runner.stop().await;
  });
  stop_holders(&place);
}

#[test]
fn a_harness_process_runs_only_once_its_credential_authorized_it() {
  let place = Place::new();
  let grants = Arc::new(Grants::default());
  let id = run_id();
  run(async {
    let host = place.host(
      Some(chatgpt_credentials(&grants)),
      Duration::from_secs(3600),
    );
    let setup = setup(&host);
    let gateway = Gateway::bind().await;
    let runner = setup.start(&gateway);
    let mut connection = connect(&gateway, &[], "ready").await;
    // The probe's process was authorized before it answered.
    assert_eq!(grants.authorized.lock().unwrap().len(), 1);
    connection.send(run_start(&id, "gpt-test")).await;
    connection.receive_type("run.accepted").await;
    let messages = until_finished(&mut connection).await;
    assert_eq!(seqs(&messages), vec![1, 2, 3]);
    assert_eq!(grants.authorized.lock().unwrap().len(), 2);
    until("the run's grant was released", || {
      *grants.held.lock().unwrap() == 0
    })
    .await;
    runner.stop().await;
  });
  stop_holders(&place);
  let start = place.received("run.start").remove(0);
  assert_eq!(start["launch"]["processGrant"], true);
  assert_eq!(start["launch"]["clientName"], "Stella");
  assert_eq!(
    start["launch"]["configOverrides"],
    json!(["model_provider=\"openai_chatgpt_plan\""])
  );
  assert_eq!(
    start["launch"]["environment"],
    json!({ "STELLA_CODEX_TOKEN_BROKER": "/broker/s" })
  );
  let granted: Vec<Value> = place.received("harness.process_granted");
  assert_eq!(granted.len(), 2);
  assert_eq!(granted[1]["id"], id.as_str());
  // Both reports named the stand-in holder's own process.
  let authorized = grants.authorized.lock().unwrap().clone();
  assert_eq!(authorized[0], authorized[1]);
}

#[test]
fn a_restarted_runner_takes_over_a_run_the_host_held_and_acks_only_what_it_journaled() {
  let place = Place::new();
  let id = run_id();
  run(async {
    let host = place.host(None, Duration::from_secs(3600));
    let setup = setup(&host);
    let gateway = Gateway::bind().await;
    let runner = setup.start(&gateway);
    let mut connection = connect(&gateway, &[], "ready").await;
    connection.send(run_start(&id, "wait")).await;
    connection.receive_type("run.accepted").await;
    connection.receive_type("run.event").await;
    until("the holder was acked for the event", || {
      place.acks(&id) == vec![1]
    })
    .await;
    runner.stop().await;

    // The holder ends the run while no runner journals: nothing is acked.
    host.cancel(&id);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(place.acks(&id), vec![1]);

    let runner = setup.start(&gateway);
    let mut connection = connect(&gateway, &[(id.as_str(), 1)], "ready").await;
    let finished = connection.receive_type("run.finished").await;
    assert_eq!(finished["seq"], 2);
    assert_eq!(finished["outcome"], "cancelled");
    until("the holder was acked once journaled", || {
      place.acks(&id) == vec![1, 2]
    })
    .await;
    runner.stop().await;
  });
  stop_holders(&place);
}

/// The first app: start a run and see its first event journaled, then quit
/// (the runtime and every task on it end, as when the process exits). The
/// journal stays in `journal_dir`.
fn first_app(
  place: &Place,
  journal_dir: &std::path::Path,
  id: &str,
  credentials: Option<HarnessCredentials>,
) {
  run(async {
    let host = place.host(credentials, Duration::from_secs(3600));
    let mut setup = setup(&host);
    let own = std::mem::replace(&mut setup.journal_dir, journal_dir.to_path_buf());
    let _unused = std::fs::remove_dir_all(own);
    let gateway = Gateway::bind().await;
    let runner = setup.start(&gateway);
    let mut connection = connect(&gateway, &[], "ready").await;
    connection.send(run_start(id, "wait")).await;
    connection.receive_type("run.accepted").await;
    let event = connection.receive_type("run.event").await;
    assert_eq!(event["seq"], 1);
    until("the holder was acked for the event", || {
      place.acks(id) == vec![1]
    })
    .await;
    runner.stop().await;
    // The journal outlives this app; the test removes it at the end.
    setup.journal_dir = place.fixture.root.join("no-journal");
  });
}

/// A journal folder the test removes at its end.
fn journal_dir(place: &Place) -> PathBuf {
  place.fixture.root.join("journal")
}

#[test]
fn a_restarted_app_resumes_a_held_run_after_its_journal_without_a_repeat_or_a_gap() {
  let place = Place::new();
  let grants = Arc::new(Grants::default());
  let id = run_id();
  let journal = journal_dir(&place);
  first_app(&place, &journal, &id, Some(chatgpt_credentials(&grants)));
  let granted_for_run = || {
    place
      .received("harness.process_granted")
      .iter()
      .filter(|granted| granted["id"] == id.as_str())
      .count()
  };
  assert_eq!(granted_for_run(), 1);
  run(async {
    let host = place.host(
      Some(chatgpt_credentials(&grants)),
      Duration::from_secs(3600),
    );
    let mut setup = setup(&host);
    let own = std::mem::replace(&mut setup.journal_dir, journal.clone());
    let _unused = std::fs::remove_dir_all(own);
    let gateway = Gateway::bind().await;
    let runner = setup.start(&gateway);
    let mut connection = gateway.accept().await;
    let hello = connection.hello().await;
    assert_eq!(hello["activeRuns"], json!([{"runId": id, "lastSeq": 1}]));
    connection.welcome(&[(id.as_str(), 1)]).await;
    // The resumed holder reports the run's process again, and the new app
    // authorizes it.
    until("the resumed run's process was authorized again", || {
      granted_for_run() == 2
    })
    .await;
    connection
      .send(json!({"type": "run.cancel", "runId": id}))
      .await;
    let mut messages = Vec::new();
    loop {
      let message = connection.receive().await;
      if message["type"] == "harness.status" {
        continue;
      }
      let finished = message["type"] == "run.finished";
      messages.push(message);
      if finished {
        break;
      }
    }
    assert_eq!(seqs(&messages), vec![2]);
    assert_eq!(messages[0]["outcome"], "cancelled");
    until("the holder was acked through the end", || {
      place.acks(&id) == vec![1, 2]
    })
    .await;
    runner.stop().await;
  });
  stop_holders(&place);
  let resumes = place.received("resume");
  assert_eq!(resumes.len(), 1);
  assert_eq!(resumes[0]["afterSeq"], 1);
  assert_eq!(
    place.fixture.starts(),
    1,
    "the second app started no holder"
  );
}

#[test]
fn a_restarted_app_ends_a_journaled_run_the_holder_no_longer_has_as_failed() {
  let place = Place::new();
  let id = run_id();
  let journal = journal_dir(&place);
  first_app(&place, &journal, &id, None);
  // The holder goes away with its runs while no app runs.
  stop_holders(&place);
  run(async {
    let host = place.host(None, Duration::from_secs(3600));
    let mut setup = setup(&host);
    let own = std::mem::replace(&mut setup.journal_dir, journal.clone());
    let _unused = std::fs::remove_dir_all(own);
    let gateway = Gateway::bind().await;
    let runner = setup.start(&gateway);
    let mut connection = gateway.accept().await;
    connection.hello().await;
    connection.welcome(&[(id.as_str(), 1)]).await;
    let finished = loop {
      let message = connection.receive().await;
      if message["type"] == "run.finished" {
        break message;
      }
    };
    assert_eq!(finished["seq"], 2);
    assert_eq!(finished["outcome"], "failed");
    runner.stop().await;
  });
  stop_holders(&place);
}
