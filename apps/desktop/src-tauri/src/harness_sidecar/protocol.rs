//! Serde types for the harness sidecar's socket protocol, mirroring
//! `packages/agent-engine/src/sidecar/protocol.ts`.
//!
//! Values the runner socket already defines (harnesses, decisions, outcomes,
//! policies, MCP tokens, acks) are the runner protocol's own types, so the
//! host relays them without a translation table. The tests round-trip every
//! message in the sidecar's fixture file and compare each closed list with it.

use std::num::NonZeroU32;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::runner_protocol::{
  Ack, ApprovalKind, Harness, HarnessCapability, JsonObject, McpBinding, RunApproval,
  RunOutcome, RunPolicy, RunRef, RunTokenRefresh,
};

pub(crate) const SIDECAR_PROTOCOL: u32 = 2;
/// Largest line either side writes or accepts, in UTF-8 bytes.
pub(crate) const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
/// Runs one `hello` may resume or list.
pub(crate) const MAX_HELD_RUNS: usize = 1000;
/// Hex characters of the holder's secret.
pub(crate) const SECRET_HEX_LENGTH: usize = 64;

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
  HelloRepeated => "hello_repeated",
  ProtocolMismatch => "protocol_mismatch",
  UnknownRun => "unknown_run",
  DuplicateRun => "duplicate_run",
  Draining => "draining",
  AtCapacity => "at_capacity",
  OriginMismatch => "origin_mismatch",
});

wire_values!(HolderMode {
  Serving => "serving",
  Draining => "draining",
});

wire_values!(ProbeFailure {
  HarnessUnavailable => "harness_unavailable",
  ProtocolViolation => "protocol_violation",
  Unsupported => "unsupported",
});

/// The secret the holder writes next to its socket. `Debug` never prints it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct HolderSecret(pub(crate) String);

impl HolderSecret {
  /// The secret as read from its file; `None` unless it is 32 bytes of hex.
  pub(crate) fn parse(text: &str) -> Option<Self> {
    let text = text.trim();
    (text.len() == SECRET_HEX_LENGTH
      && text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then(|| Self(text.to_owned()))
  }
}

impl std::fmt::Debug for HolderSecret {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str("HolderSecret(..)")
  }
}

/// Where the host's copy of a run ends; the holder sends what follows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResumePoint {
  pub(crate) run_id: String,
  pub(crate) after_seq: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostHello {
  pub(crate) protocol: u32,
  pub(crate) secret: HolderSecret,
  pub(crate) app_version: String,
  /// The only upstream the sidecar's MCP proxy forwards to.
  pub(crate) api_origin: String,
  pub(crate) resume: Vec<ResumePoint>,
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

/// What the desktop writes to the holder.
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
  /// The API stored the run's messages up to `seq`; cumulative.
  #[serde(rename = "ack")]
  Ack(Ack),
  #[serde(rename = "resume")]
  Resume(ResumePoint),
  #[serde(rename = "drain")]
  Drain,
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
    "ack",
    "resume",
    "drain",
    "shutdown",
  ];
}

/// A run the holder holds: running, or finished and not yet acked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeldRun {
  pub(crate) run_id: String,
  pub(crate) harness: Harness,
  /// The run's latest `seq`; 0 before its first message.
  pub(crate) last_seq: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarHello {
  pub(crate) protocol: u32,
  pub(crate) sidecar_version: String,
  pub(crate) mode: HolderMode,
  pub(crate) runs: Vec<HeldRun>,
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
  pub(crate) seq: NonZeroU32,
  pub(crate) chunk: Chunk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarApprovalRequest {
  pub(crate) run_id: String,
  pub(crate) seq: NonZeroU32,
  pub(crate) request_id: String,
  pub(crate) kind: ApprovalKind,
  pub(crate) summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarRunFinished {
  pub(crate) run_id: String,
  pub(crate) seq: NonZeroU32,
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

/// What the holder writes to the desktop.
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
      (
        "holderModes",
        names(HolderMode::ALL.iter().map(|value| value.wire_name())),
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
  fn protocol_and_limits_match_the_contract() {
    let fixtures = fixtures();
    assert_eq!(fixtures["vocabulary"]["protocol"], SIDECAR_PROTOCOL);
    assert_eq!(
      fixtures["vocabulary"]["maxLineBytes"].as_u64(),
      u64::try_from(MAX_LINE_BYTES).ok()
    );
    assert_eq!(
      fixtures["vocabulary"]["maxHeldRuns"].as_u64(),
      u64::try_from(MAX_HELD_RUNS).ok()
    );
  }

  #[test]
  fn tokens_and_the_secret_stay_out_of_debug_output() {
    let fixtures = fixtures();
    let secret = "ab".repeat(32);
    for message in entries(&fixtures, "/valid/host") {
      let parsed: HostMessage = serde_json::from_value(message.clone()).unwrap();
      let debug = format!("{parsed:?}");
      for token in ["run-token-1", "run-token-2", secret.as_str()] {
        assert!(!debug.contains(token), "{debug}");
      }
    }
  }

  #[test]
  fn a_secret_is_read_only_as_32_bytes_of_lowercase_hex() {
    let secret = "ab".repeat(32);
    assert_eq!(
      HolderSecret::parse(&format!("{secret}\n")),
      Some(HolderSecret(secret.clone()))
    );
    for refused in [
      String::new(),
      "ab".repeat(31),
      "AB".repeat(32),
      format!("{}zz", "ab".repeat(31)),
    ] {
      assert_eq!(HolderSecret::parse(&refused), None, "{refused}");
    }
  }
}
