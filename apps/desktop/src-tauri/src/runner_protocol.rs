//! Serde types for the desktop runner socket, mirroring
//! `@stll/api-contract/desktop-runner`.
//!
//! The tests round-trip every message in the contract's shared fixture file
//! and compare each closed value list with it, so a field, tag or value that
//! differs from the API schema fails here.

use std::num::NonZeroU32;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub(crate) const PROTOCOL: u32 = 1;
/// Largest frame either side sends or accepts, in UTF-8 bytes.
pub(crate) const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// A closed string value whose variant list is also its `ALL` list.
macro_rules! wire_values {
  ($name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    pub(crate) enum $name {
      $(
        #[serde(rename = $wire)]
        $variant,
      )+
    }

    impl $name {
      pub(crate) const ALL: &[Self] = &[$(Self::$variant),+];

      pub(crate) const fn wire_name(self) -> &'static str {
        match self {
          $(Self::$variant => $wire),+
        }
      }
    }
  };
}

/// An internally tagged union whose variant list is also its `TAGS` list.
macro_rules! wire_union {
  ($name:ident tagged $tag:literal { $($variant:ident($payload:ty) => $wire:literal),+ $(,)? }) => {
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(tag = $tag)]
    pub(crate) enum $name {
      $(
        #[serde(rename = $wire)]
        $variant($payload),
      )+
    }

    impl $name {
      pub(crate) const TAGS: &[&str] = &[$($wire),+];
    }
  };
}

wire_values!(Harness {
  Codex => "codex",
  ClaudeCode => "claude-code",
  Opencode => "opencode",
});

wire_values!(HarnessCapability {
  Approvals => "approvals",
  Interrupt => "interrupt",
  Resume => "resume",
  ImageInput => "image_input",
});

wire_values!(RejectReason {
  HarnessNotInstalled => "harness_not_installed",
  HarnessNeedsLogin => "harness_needs_login",
  HarnessLimited => "harness_limited",
  HarnessUnsupported => "harness_unsupported",
  HarnessVersionUnavailable => "harness_version_unavailable",
  ModelUnavailable => "model_unavailable",
  PolicyUnsupported => "policy_unsupported",
  AtCapacity => "at_capacity",
  UnknownRun => "unknown_run",
});

wire_values!(ApprovalKind {
  Command => "command",
  FileChange => "file_change",
  McpTool => "mcp_tool",
  Tool => "tool",
});

wire_values!(ApprovalDecision {
  Approve => "approve",
  ApproveForSession => "approve_for_session",
  Deny => "deny",
});

wire_values!(RunOutcome {
  Completed => "completed",
  Interrupted => "interrupted",
  Cancelled => "cancelled",
  Failed => "failed",
  LimitReached => "limit_reached",
  NeedsLogin => "needs_login",
});

wire_values!(NetworkPolicy { Open => "open" });

wire_values!(FsPolicy { Workspace => "workspace" });

/// A run-scoped MCP token. `Debug` never prints it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct McpToken(pub(crate) String);

impl std::fmt::Debug for McpToken {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str("McpToken(..)")
  }
}

/// A TanStack `StreamChunk` or `ModelMessage`, relayed without reading it.
pub(crate) type JsonObject = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct HarnessModel {
  pub(crate) id: String,
  pub(crate) label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ReadyHarness {
  pub(crate) id: Harness,
  pub(crate) version: String,
  pub(crate) capabilities: Vec<HarnessCapability>,
  pub(crate) models: Vec<HarnessModel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct SignedOutHarness {
  pub(crate) id: Harness,
  pub(crate) version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LimitedHarness {
  pub(crate) id: Harness,
  pub(crate) version: String,
  pub(crate) resets_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct MissingHarness {
  pub(crate) id: Harness,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct UnsupportedHarness {
  pub(crate) id: Harness,
  /// `None` when this desktop cannot run the harness at any version.
  pub(crate) version: Option<String>,
}

wire_union!(HarnessReport tagged "state" {
  Ready(ReadyHarness) => "ready",
  NeedsLogin(SignedOutHarness) => "needs_login",
  LimitUntil(LimitedHarness) => "limit_until",
  NotInstalled(MissingHarness) => "not_installed",
  Unsupported(UnsupportedHarness) => "unsupported",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveRun {
  pub(crate) run_id: String,
  pub(crate) last_seq: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hello {
  pub(crate) protocol: u32,
  pub(crate) app_version: String,
  pub(crate) sidecar_version: String,
  pub(crate) harnesses: Vec<HarnessReport>,
  pub(crate) active_runs: Vec<ActiveRun>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct HarnessStatus {
  pub(crate) harness: HarnessReport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunRef {
  pub(crate) run_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunRejected {
  pub(crate) run_id: String,
  pub(crate) reason: RejectReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunEvent {
  pub(crate) run_id: String,
  pub(crate) seq: NonZeroU32,
  pub(crate) chunk: JsonObject,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunApprovalRequest {
  pub(crate) run_id: String,
  pub(crate) seq: NonZeroU32,
  pub(crate) request_id: String,
  pub(crate) kind: ApprovalKind,
  pub(crate) summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunFinished {
  pub(crate) run_id: String,
  pub(crate) seq: NonZeroU32,
  pub(crate) outcome: RunOutcome,
  pub(crate) harness_session_id: Option<String>,
}

wire_union!(DesktopMessage tagged "type" {
  Hello(Hello) => "hello",
  HarnessStatus(HarnessStatus) => "harness.status",
  RunAccepted(RunRef) => "run.accepted",
  RunRejected(RunRejected) => "run.rejected",
  RunEvent(RunEvent) => "run.event",
  RunApprovalRequest(RunApprovalRequest) => "run.approval_request",
  RunFinished(RunFinished) => "run.finished",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResumePoint {
  pub(crate) run_id: String,
  pub(crate) ack_seq: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Welcome {
  pub(crate) protocol: u32,
  pub(crate) resume: Vec<ResumePoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpgradeRequired {
  pub(crate) minimum_protocol: u32,
  pub(crate) current_protocol: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reconnect {
  pub(crate) after_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct RunPolicy {
  pub(crate) network: NetworkPolicy,
  pub(crate) fs: FsPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpBinding {
  pub(crate) server_name: String,
  pub(crate) url: String,
  pub(crate) token: McpToken,
  pub(crate) expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunStart {
  pub(crate) run_id: String,
  pub(crate) harness: Harness,
  pub(crate) harness_version: String,
  pub(crate) model: String,
  pub(crate) harness_session_id: Option<String>,
  pub(crate) instructions: String,
  pub(crate) messages: Vec<JsonObject>,
  pub(crate) policy: RunPolicy,
  pub(crate) mcp: McpBinding,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunInput {
  pub(crate) run_id: String,
  pub(crate) input_id: String,
  pub(crate) message: JsonObject,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunApproval {
  pub(crate) run_id: String,
  pub(crate) request_id: String,
  pub(crate) decision: ApprovalDecision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunTokenRefresh {
  pub(crate) run_id: String,
  pub(crate) token: McpToken,
  pub(crate) expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ack {
  pub(crate) run_id: String,
  pub(crate) seq: NonZeroU32,
}

wire_union!(ServerMessage tagged "type" {
  Welcome(Welcome) => "welcome",
  UpgradeRequired(UpgradeRequired) => "upgrade_required",
  Reconnect(Reconnect) => "reconnect",
  RunStart(RunStart) => "run.start",
  RunInput(RunInput) => "run.input",
  RunApproval(RunApproval) => "run.approval",
  RunInterrupt(RunRef) => "run.interrupt",
  RunCancel(RunRef) => "run.cancel",
  RunToken(RunTokenRefresh) => "run.token",
  Ack(Ack) => "ack",
});

#[cfg(test)]
mod tests {
  use std::collections::BTreeSet;

  use serde::de::DeserializeOwned;

  use super::*;

  const FIXTURES: &str =
    include_str!("../../../../packages/api-contract/src/desktop-runner.fixtures.json");

  fn fixtures() -> Value {
    serde_json::from_str(FIXTURES).expect("desktop runner fixtures are JSON")
  }

  fn entries<'a>(fixtures: &'a Value, path: &str) -> &'a [Value] {
    fixtures
      .pointer(path)
      .and_then(Value::as_array)
      .unwrap_or_else(|| panic!("fixture list {path}"))
  }

  fn round_trip<T: Serialize + DeserializeOwned>(message: &Value) -> Value {
    let parsed: T = serde_json::from_value(message.clone())
      .unwrap_or_else(|error| panic!("{message} does not parse: {error}"));
    serde_json::to_value(parsed).expect("message serializes")
  }

  fn listed(fixtures: &Value, name: &str) -> BTreeSet<String> {
    entries(fixtures, &format!("/vocabulary/{name}"))
      .iter()
      .map(|value| value.as_str().expect("vocabulary value").to_owned())
      .collect()
  }

  fn names(values: impl IntoIterator<Item = &'static str>) -> BTreeSet<String> {
    values.into_iter().map(str::to_owned).collect()
  }

  #[test]
  fn every_valid_message_round_trips_unchanged() {
    let fixtures = fixtures();
    for message in entries(&fixtures, "/valid/desktop") {
      assert_eq!(&round_trip::<DesktopMessage>(message), message);
    }
    for message in entries(&fixtures, "/valid/server") {
      assert_eq!(&round_trip::<ServerMessage>(message), message);
    }
  }

  #[test]
  fn unknown_fields_are_dropped_and_chunk_fields_kept() {
    let fixtures = fixtures();
    for case in entries(&fixtures, "/unknownFields") {
      let output = match case["direction"].as_str() {
        Some("desktop") => round_trip::<DesktopMessage>(&case["input"]),
        Some("server") => round_trip::<ServerMessage>(&case["input"]),
        other => panic!("unknown fixture direction {other:?}"),
      };
      assert_ne!(case["input"], case["parsed"]);
      assert_eq!(output, case["parsed"], "{}", case["name"]);
    }
  }

  #[test]
  fn server_messages_the_contract_rejects_do_not_parse() {
    let fixtures = fixtures();
    for case in entries(&fixtures, "/rejected/server") {
      assert!(
        serde_json::from_value::<ServerMessage>(case["message"].clone()).is_err(),
        "{}",
        case["name"]
      );
    }
  }

  #[test]
  fn closed_values_match_the_contract() {
    let fixtures = fixtures();
    let cases = [
      (
        "harnesses",
        names(Harness::ALL.iter().map(|value| value.wire_name())),
      ),
      (
        "harnessCapabilities",
        names(HarnessCapability::ALL.iter().map(|value| value.wire_name())),
      ),
      (
        "runRejectReasons",
        names(RejectReason::ALL.iter().map(|value| value.wire_name())),
      ),
      (
        "approvalKinds",
        names(ApprovalKind::ALL.iter().map(|value| value.wire_name())),
      ),
      (
        "approvalDecisions",
        names(ApprovalDecision::ALL.iter().map(|value| value.wire_name())),
      ),
      (
        "runOutcomes",
        names(RunOutcome::ALL.iter().map(|value| value.wire_name())),
      ),
      (
        "networkPolicies",
        names(NetworkPolicy::ALL.iter().map(|value| value.wire_name())),
      ),
      (
        "fsPolicies",
        names(FsPolicy::ALL.iter().map(|value| value.wire_name())),
      ),
      ("harnessStates", names(HarnessReport::TAGS.iter().copied())),
      (
        "desktopMessageTypes",
        names(DesktopMessage::TAGS.iter().copied()),
      ),
      (
        "serverMessageTypes",
        names(ServerMessage::TAGS.iter().copied()),
      ),
    ];
    for (name, rust) in cases {
      assert_eq!(rust, listed(&fixtures, name), "{name}");
    }
  }

  #[test]
  fn protocol_and_frame_limit_match_the_contract() {
    let fixtures = fixtures();
    assert_eq!(fixtures["vocabulary"]["protocol"]["current"], PROTOCOL);
    assert_eq!(
      fixtures["vocabulary"]["maxFrameBytes"].as_u64(),
      u64::try_from(MAX_FRAME_BYTES).ok()
    );
  }

  #[test]
  fn tokens_stay_out_of_debug_output() {
    let fixtures = fixtures();
    for message in entries(&fixtures, "/valid/server") {
      let parsed: ServerMessage = serde_json::from_value(message.clone()).unwrap();
      let debug = format!("{parsed:?}");
      for token in ["run-token-1", "run-token-2"] {
        assert!(!debug.contains(token), "{debug}");
      }
    }
  }
}
