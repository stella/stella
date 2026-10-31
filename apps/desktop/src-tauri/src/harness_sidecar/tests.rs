//! The supervisor against a stand-in sidecar: a shell script that speaks the
//! protocol, so spawning, framing, restarts and shutdown run for real without
//! Bun or a harness CLI. The TypeScript sidecar itself is tested against the
//! same protocol fixtures in `packages/agent-engine`.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::protocol::{ProbeFailure, ProbedModel};
use super::*;
use crate::runner_protocol::{
  FsPolicy, HarnessCapability, McpBinding, McpToken, NetworkPolicy, RunPolicy,
};

const WAIT: Duration = Duration::from_secs(10);
const REQUEST_ID: &str = "6f1c2d1e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";

const FAKE_SIDECAR: &str = r#"#!/bin/sh
log="$FAKE_SIDECAR_LOG"
echo started >> "$log"
read -r hello || exit 1
echo "$hello" >> "$log"
echo "fake sidecar ready" >&2
printf '%s\n' '{"type":"hello","protocol":1,"sidecarVersion":"1.2.3"}'
field() { printf '%s' "$2" | sed "s/.*\"$1\":\"\([^\"]*\)\".*/\1/"; }
while read -r line; do
  echo "$line" >> "$log"
  case "$line" in
    *'"type":"shutdown"'*) exit 0 ;;
    *'"type":"harness.probe"'*)
      printf '{"type":"harness.probed","requestId":"%s","harness":"codex","outcome":{"type":"needs_login","version":"0.165.0"}}\n' "$(field requestId "$line")" ;;
    *'"type":"run.cancel"'*)
      printf '{"type":"run.finished","runId":"%s","outcome":"cancelled","harnessSessionId":null}\n' "$(field runId "$line")" ;;
    *'"type":"run.start"'*)
      id=$(field runId "$line")
      case "$line" in
        *'"model":"crash"'*)
          printf '{"type":"run.event","runId":"%s","chunk":{"type":"RUN_STARTED"}}\n' "$id"
          exit 3 ;;
        *'"model":"garbage"'*) echo 'not json' ;;
        *'"model":"wait"'*) ;;
        *)
          printf '{"type":"run.event","runId":"%s","chunk":{"type":"RUN_STARTED","runId":"%s"}}\n' "$id" "$id"
          printf '{"type":"run.approval_request","runId":"%s","requestId":"6f1c2d1e-3a4b-4c5d-8e6f-7a8b9c0d1e2f","kind":"command","summary":"Deletes a file"}\n' "$id"
          printf '{"type":"run.finished","runId":"%s","outcome":"completed","harnessSessionId":"thread-a"}\n' "$id" ;;
      esac ;;
  esac
done
"#;

struct Fixture {
  root: PathBuf,
}

impl Fixture {
  fn new() -> Self {
    let root =
      std::env::temp_dir().join(format!("stella-sidecar-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let script = root.join("fake-sidecar");
    fs::write(&script, FAKE_SIDECAR).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    Self { root }
  }

  fn log(&self) -> PathBuf {
    self.root.join("sidecar.log")
  }

  fn settings(&self, program: PathBuf) -> SidecarSettings {
    SidecarSettings {
      launch: SidecarLaunch::program(program, Vec::new())
        .env("FAKE_SIDECAR_LOG", self.log()),
      app_version: "1.4.0".to_owned(),
      api_origin: "https://api.example.test".to_owned(),
      hello_timeout: Duration::from_secs(5),
      shutdown_grace: Duration::from_secs(2),
      backoff: RestartBackoff {
        initial: Duration::from_millis(50),
        max: Duration::from_millis(200),
        stable_after: Duration::from_secs(60),
      },
    }
  }

  fn sidecar(&self) -> HarnessSidecar {
    HarnessSidecar::spawn(self.settings(self.root.join("fake-sidecar")))
  }

  /// Every line the fake read from its stdin, parsed.
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
      .filter(|line| *line == "started")
      .count()
  }
}

impl Drop for Fixture {
  fn drop(&mut self) {
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

fn failed() -> SidecarRunOutput {
  SidecarRunOutput::Finished {
    outcome: RunOutcome::Failed,
    harness_session_id: None,
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
    let chunk = json!({ "type": "RUN_STARTED", "runId": run_id });
    assert_eq!(
      finish(&mut outputs).await,
      vec![
        SidecarRunOutput::Event(chunk.as_object().unwrap().clone()),
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
  assert_eq!(
    received[0],
    json!({
      "type": "hello",
      "protocol": 1,
      "appVersion": "1.4.0",
      "apiOrigin": "https://api.example.test",
    })
  );
  assert_eq!(received[1]["type"], "run.start");
  assert_eq!(received.last().unwrap(), &json!({ "type": "shutdown" }));
}

#[test]
fn probes_answer_with_the_sidecar_report() {
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
fn commands_for_a_run_reach_the_sidecar() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let start = run_start("wait");
    let run_id = start.run_id.clone();
    let mut outputs = sidecar.start_run(start).unwrap();
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
      vec![SidecarRunOutput::Finished {
        outcome: RunOutcome::Cancelled,
        harness_session_id: None,
      }]
    );
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
      "shutdown"
    ]
  );
}

#[test]
fn a_crash_fails_the_runs_it_held_and_the_sidecar_restarts() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let mut crashed = sidecar.start_run(run_start("crash")).unwrap();
    let outputs = finish(&mut crashed).await;
    assert_eq!(outputs.last(), Some(&failed()));
    let mut after = sidecar.start_run(run_start("gpt-test")).unwrap();
    // A run sent while the sidecar is restarting fails at once; the next
    // one after the restart completes.
    let mut completed = false;
    for _ in 0..50 {
      let last = finish(&mut after).await.pop();
      if matches!(
        last,
        Some(SidecarRunOutput::Finished {
          outcome: RunOutcome::Completed,
          ..
        })
      ) {
        completed = true;
        break;
      }
      tokio::time::sleep(Duration::from_millis(50)).await;
      after = sidecar.start_run(run_start("gpt-test")).unwrap();
    }
    assert!(completed, "a run completed after the restart");
    sidecar.shutdown().await;
  });
  assert!(fixture.starts() >= 2, "the sidecar was started again");
}

#[test]
fn a_line_that_breaks_the_protocol_fails_the_held_runs() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let mut waiting = sidecar.start_run(run_start("wait")).unwrap();
    let mut broken = sidecar.start_run(run_start("garbage")).unwrap();
    assert_eq!(finish(&mut broken).await, vec![failed()]);
    assert_eq!(finish(&mut waiting).await, vec![failed()]);
    sidecar.shutdown().await;
  });
}

#[test]
fn shutdown_stops_the_sidecar_and_the_supervisor() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = fixture.sidecar();
    let mut held = sidecar.start_run(run_start("wait")).unwrap();
    // The start is written before the shutdown, in order.
    tokio::time::sleep(Duration::from_millis(200)).await;
    sidecar.shutdown().await;
    assert_eq!(finish(&mut held).await, vec![failed()]);
    assert_eq!(
      sidecar.start_run(run_start("gpt-test")).err(),
      Some(SidecarUnavailable::Stopped)
    );
  });
  assert_eq!(fixture.starts(), 1);
}

#[test]
fn a_sidecar_that_cannot_start_fails_runs_and_probes() {
  let fixture = Fixture::new();
  with_children(async {
    let sidecar = HarnessSidecar::spawn(fixture.settings(fixture.root.join("missing")));
    let mut outputs = sidecar.start_run(run_start("gpt-test")).unwrap();
    assert_eq!(finish(&mut outputs).await, vec![failed()]);
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
fn the_bundled_sidecar_sits_beside_the_app_executable() {
  let launch = SidecarLaunch::bundled(std::path::Path::new(
    "/Applications/stella.app/Contents/MacOS/stella-desktop",
  ))
  .unwrap();
  assert_eq!(
    launch.program,
    PathBuf::from("/Applications/stella.app/Contents/MacOS/stella-agent-sidecar")
  );
  let source = SidecarLaunch::from_source(PathBuf::from("bun"));
  assert!(
    PathBuf::from(&source.args[0])
      .ends_with("packages/agent-engine/src/sidecar/main.ts")
  );
}

#[test]
fn restart_delays_double_up_to_the_maximum() {
  let backoff = RestartBackoff::DEFAULT;
  assert_eq!(backoff.delay(0), Duration::from_millis(500));
  assert_eq!(backoff.delay(1), Duration::from_secs(1));
  assert_eq!(backoff.delay(3), Duration::from_secs(4));
  assert_eq!(backoff.delay(40), Duration::from_secs(60));
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
      &ProbeOutcome::LimitUntil {
        version: "2.1.309".to_owned(),
        resets_at: "2026-10-28T14:00:00Z".to_owned(),
      }
    ),
    HarnessReport::LimitUntil(LimitedHarness {
      id: Harness::ClaudeCode,
      version: "2.1.309".to_owned(),
      resets_at: "2026-10-28T14:00:00Z".to_owned(),
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
