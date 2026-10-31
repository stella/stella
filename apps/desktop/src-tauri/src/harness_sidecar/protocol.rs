//! Serde types for the harness sidecar's stdio protocol, mirroring
//! `packages/agent-engine/src/sidecar/protocol.ts`.
//!
//! Values the runner socket already defines (harnesses, decisions, outcomes,
//! policies, MCP tokens) are the runner protocol's own types, so the host
//! relays them without a translation table. The tests round-trip every
//! message in the sidecar's fixture file and compare each closed list with it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::runner_protocol::{
  ApprovalKind, Harness, HarnessCapability, JsonObject, McpBinding, RunApproval,
  RunOutcome, RunPolicy, RunRef, RunTokenRefresh,
};

pub(crate) const SIDECAR_PROTOCOL: u32 = 1;
/// Largest line either side writes or accepts, in UTF-8 bytes.
pub(crate) const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

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
      #[cfg(test)]
      pub(crate) const ALL: &[Self] = &[$(Self::$variant),+];

      pub(crate) const fn wire_name(self) -> &'static str {
        match self {
          $(Self::$variant => $wire),+
        }
      }
    }
  };
}

wire_values!(Rejection {
  TooLarge => "too_large",
  NotJson => "not_json",
  UnknownType => "unknown_type",
  Invalid => "invalid",
  HelloRequired => "hello_required",
  HelloRepeated => "hello_repeated",
  ProtocolMismatch => "protocol_mismatch",
  UnknownRun => "unknown_run",
  DuplicateRun => "duplicate_run",
});

wire_values!(ProbeFailure {
  HarnessUnavailable => "harness_unavailable",
  ProtocolViolation => "protocol_violation",
  Unsupported => "unsupported",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostHello {
  pub(crate) protocol: u32,
  pub(crate) app_version: String,
  /// The only upstream the sidecar's MCP proxy forwards to.
  pub(crate) api_origin: String,
}

/// Which managed CLI to run and the stella-owned home it runs with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessProbe {
  pub(crate) request_id: String,
  pub(crate) harness: Harness,
  pub(crate) executable: String,
  pub(crate) config_dir: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarRunStart {
  pub(crate) run_id: String,
  pub(crate) thread_id: String,
  pub(crate) harness: Harness,
  pub(crate) executable: String,
  pub(crate) config_dir: String,
  pub(crate) workspace_dir: String,
  pub(crate) model: String,
  pub(crate) instructions: String,
  pub(crate) messages: Vec<JsonObject>,
  pub(crate) harness_session_id: Option<String>,
  pub(crate) policy: RunPolicy,
  pub(crate) mcp: McpBinding,
}

/// What the desktop writes to the sidecar's stdin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum HostMessage {
  #[serde(rename = "hello")]
  Hello(HostHello),
  #[serde(rename = "harness.probe")]
  HarnessProbe(HarnessProbe),
  #[serde(rename = "run.start")]
  RunStart(Box<SidecarRunStart>),
  #[serde(rename = "run.approval")]
  RunApproval(RunApproval),
  #[serde(rename = "run.interrupt")]
  RunInterrupt(RunRef),
  #[serde(rename = "run.cancel")]
  RunCancel(RunRef),
  #[serde(rename = "run.token")]
  RunToken(RunTokenRefresh),
  #[serde(rename = "shutdown")]
  Shutdown,
}

impl HostMessage {
  #[cfg(test)]
  pub(crate) const TAGS: &[&str] = &[
    "hello",
    "harness.probe",
    "run.start",
    "run.approval",
    "run.interrupt",
    "run.cancel",
    "run.token",
    "shutdown",
  ];
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarHello {
  pub(crate) protocol: u32,
  pub(crate) sidecar_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbedModel {
  pub(crate) id: String,
  pub(crate) label: String,
  pub(crate) is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum ProbeOutcome {
  #[serde(rename = "ready")]
  Ready {
    version: String,
    capabilities: Vec<HarnessCapability>,
    models: Vec<ProbedModel>,
  },
  #[serde(rename = "needs_login")]
  NeedsLogin { version: String },
  #[serde(rename = "limit_until", rename_all = "camelCase")]
  LimitUntil { version: String, resets_at: String },
  /// A version the compatibility policy refuses for this desktop release.
  #[serde(rename = "unsupported", rename_all = "camelCase")]
  Unsupported {
    version: String,
    recommended_version: Option<String>,
  },
  #[serde(rename = "failed")]
  Failed {
    reason: ProbeFailure,
    message: String,
  },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessProbed {
  pub(crate) request_id: String,
  pub(crate) harness: Harness,
  pub(crate) outcome: ProbeOutcome,
}

/// A TanStack `StreamChunk`, relayed unread; only its `type` is required.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "JsonObject", into = "JsonObject")]
pub(crate) struct Chunk(pub(crate) JsonObject);

impl TryFrom<JsonObject> for Chunk {
  type Error = &'static str;

  fn try_from(object: JsonObject) -> Result<Self, Self::Error> {
    match object.get("type") {
      Some(Value::String(_)) => Ok(Self(object)),
      _ => Err("a chunk names its type"),
    }
  }
}

impl From<Chunk> for JsonObject {
  fn from(chunk: Chunk) -> Self {
    chunk.0
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarRunEvent {
  pub(crate) run_id: String,
  pub(crate) chunk: Chunk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarApprovalRequest {
  pub(crate) run_id: String,
  pub(crate) request_id: String,
  pub(crate) kind: ApprovalKind,
  pub(crate) summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarRunFinished {
  pub(crate) run_id: String,
  pub(crate) outcome: RunOutcome,
  pub(crate) harness_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Rejected {
  pub(crate) reason: Rejection,
  pub(crate) message_type: Option<String>,
  pub(crate) run_id: Option<String>,
}

/// What the sidecar writes to its stdout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum SidecarMessage {
  #[serde(rename = "hello")]
  Hello(SidecarHello),
  #[serde(rename = "harness.probed")]
  HarnessProbed(HarnessProbed),
  #[serde(rename = "run.event")]
  RunEvent(SidecarRunEvent),
  #[serde(rename = "run.approval_request")]
  RunApprovalRequest(SidecarApprovalRequest),
  #[serde(rename = "run.finished")]
  RunFinished(SidecarRunFinished),
  #[serde(rename = "rejected")]
  Rejected(Rejected),
}

impl SidecarMessage {
  #[cfg(test)]
  pub(crate) const TAGS: &[&str] = &[
    "hello",
    "harness.probed",
    "run.event",
    "run.approval_request",
    "run.finished",
    "rejected",
  ];
}

#[cfg(test)]
mod tests {
  use std::collections::BTreeSet;

  use serde::de::DeserializeOwned;

  use super::*;

  const FIXTURES: &str = include_str!(
    "../../../../../packages/agent-engine/src/sidecar/protocol.fixtures.json"
  );

  fn fixtures() -> Value {
    serde_json::from_str(FIXTURES).expect("sidecar fixtures are JSON")
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
    for message in entries(&fixtures, "/valid/host") {
      assert_eq!(&round_trip::<HostMessage>(message), message);
    }
    for message in entries(&fixtures, "/valid/sidecar") {
      assert_eq!(&round_trip::<SidecarMessage>(message), message);
    }
  }

  #[test]
  fn sidecar_messages_the_contract_rejects_do_not_parse() {
    let fixtures = fixtures();
    for case in entries(&fixtures, "/rejected/sidecar") {
      assert!(
        serde_json::from_value::<SidecarMessage>(case["message"].clone()).is_err(),
        "{}",
        case["name"]
      );
    }
  }

  #[test]
  fn closed_values_match_the_contract() {
    let fixtures = fixtures();
    let cases = [
      ("hostMessageTypes", names(HostMessage::TAGS.iter().copied())),
      ("messageTypes", names(SidecarMessage::TAGS.iter().copied())),
      (
        "rejections",
        names(Rejection::ALL.iter().map(|value| value.wire_name())),
      ),
      (
        "probeFailures",
        names(ProbeFailure::ALL.iter().map(|value| value.wire_name())),
      ),
    ];
    for (name, rust) in cases {
      assert_eq!(rust, listed(&fixtures, name), "{name}");
    }
  }

  #[test]
  fn every_host_tag_serializes_as_listed() {
    let fixtures = fixtures();
    let tags: BTreeSet<String> = entries(&fixtures, "/valid/host")
      .iter()
      .map(|message| {
        let parsed: HostMessage = serde_json::from_value(message.clone()).unwrap();
        serde_json::to_value(parsed).unwrap()["type"]
          .as_str()
          .unwrap()
          .to_owned()
      })
      .collect();
    assert_eq!(tags, names(HostMessage::TAGS.iter().copied()));
  }

  #[test]
  fn protocol_and_line_limit_match_the_contract() {
    let fixtures = fixtures();
    assert_eq!(fixtures["vocabulary"]["protocol"], SIDECAR_PROTOCOL);
    assert_eq!(
      fixtures["vocabulary"]["maxLineBytes"].as_u64(),
      u64::try_from(MAX_LINE_BYTES).ok()
    );
  }

  #[test]
  fn tokens_stay_out_of_debug_output() {
    let fixtures = fixtures();
    for message in entries(&fixtures, "/valid/host") {
      let parsed: HostMessage = serde_json::from_value(message.clone()).unwrap();
      let debug = format!("{parsed:?}");
      for token in ["run-token-1", "run-token-2"] {
        assert!(!debug.contains(token), "{debug}");
      }
    }
  }
}
