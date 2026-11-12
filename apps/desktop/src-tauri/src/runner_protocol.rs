//! Serde types for the desktop runner socket, mirroring
//! `@stll/api-contract/desktop-runner`.
//!
//! The tests round-trip every message in the contract's shared fixture file
//! and compare each closed value list, the socket path, the installation
//! header, the close codes and the timings with it, so a field, tag or value
//! that differs from the API fails here.

use std::{collections::BTreeMap, num::NonZeroU32, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub(crate) const PROTOCOL: u32 = 2;
/// Largest frame either side sends or accepts, in UTF-8 bytes.
pub(crate) const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// Sequenced messages one run may store; the API refuses more.
pub(crate) const MAX_MESSAGES_PER_RUN: u32 = 20_000;
/// UTF-8 bytes of sequenced messages one run may store.
pub(crate) const MAX_MESSAGE_BYTES_PER_RUN: u64 = 64 * 1024 * 1024;
/// Where the runner socket lives under the API base URL.
pub(crate) const PATH: &str = "/v1/desktop/runner";
/// Names the installation the socket belongs to.
pub(crate) const DESKTOP_ID_HEADER: &str = "stella-desktop-id";
/// The API pings this often and closes a socket after two silent intervals.
pub(crate) const PING_INTERVAL: Duration = Duration::from_millis(20_000);
/// The API closes a socket that sent no `hello` within this.
pub(crate) const HELLO_TIMEOUT: Duration = Duration::from_millis(10_000);
/// The close code of a frame the contract rejects; its reason says why.
pub(crate) const POLICY_VIOLATION_CODE: u16 = 1008;
/// Questions one `run.answer` may answer.
pub(crate) const MAX_ANSWERED_QUESTIONS: usize = 32;
/// Answers one question may take.
pub(crate) const MAX_ANSWERS_PER_QUESTION: usize = 64;
/// UTF-16 code units of one answer, as the API counts them.
pub(crate) const MAX_ANSWER_LENGTH: usize = 16_384;
/// UTF-16 code units of a question id.
pub(crate) const MAX_QUESTION_ID_LENGTH: usize = 256;

/// Why the API closed a runner socket, with the contract's key for each.
macro_rules! close_codes {
  ($($variant:ident => $key:literal, $code:literal, $reason:literal);+ $(;)?) => {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum CloseCode {
      $($variant,)+
    }

    impl CloseCode {
      pub(crate) fn from_code(code: u16) -> Option<Self> {
        match code {
          $($code => Some(Self::$variant),)+
          _ => None,
        }
      }

      #[cfg(test)]
      const ALL: &[Self] = &[$(Self::$variant),+];

      #[cfg(test)]
      const fn contract(self) -> (&'static str, u16, &'static str) {
        match self {
          $(Self::$variant => ($key, $code, $reason),)+
        }
      }
    }
  };
}

close_codes! {
  GoingAway => "goingAway", 1001, "going_away";
  UnsupportedData => "unsupportedData", 1003, "binary_frame";
  TooLarge => "tooLarge", 1009, "too_large";
  InternalError => "internalError", 1011, "internal_error";
  Overloaded => "overloaded", 1013, "overloaded";
  UpgradeRequired => "upgradeRequired", 4001, "upgrade_required";
  Superseded => "superseded", 4002, "superseded";
  HeartbeatTimeout => "heartbeatTimeout", 4003, "heartbeat_timeout";
  SequenceGap => "sequenceGap", 4004, "sequence_gap";
  HelloTimeout => "helloTimeout", 4005, "hello_timeout";
  UnknownRun => "unknownRun", 4006, "unknown_run";
  TooManyRunners => "tooManyRunners", 4007, "too_many_runners";
  CredentialRevoked => "credentialRevoked", 4008, "credential_revoked";
  FeatureDisabled => "featureDisabled", 4009, "feature_disabled";
}

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

    #[cfg_attr(
      not(test),
      allow(dead_code, reason = "the tests compare every closed list with the contract")
    )]
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
      #[cfg(test)]
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
  HarnessUnavailable => "harness_unavailable",
  HarnessVersionUnavailable => "harness_version_unavailable",
  ModelUnavailable => "model_unavailable",
  PolicyUnsupported => "policy_unsupported",
  AtCapacity => "at_capacity",
  RunTooLarge => "run_too_large",
  UnknownRun => "unknown_run",
  FolderBusy => "folder_busy",
});

wire_values!(FolderRestoreOutcome {
  Restored => "restored",
  NoCheckpoint => "no_checkpoint",
  NotNewest => "not_newest",
  FolderBusy => "folder_busy",
  Failed => "failed",
});

wire_values!(HarnessUnavailableReason {
  HarnessFailed => "harness_failed",
  UnexpectedAnswer => "unexpected_answer",
  ProbeFailed => "probe_failed",
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

// How much a run asks before it acts; `Ask` is every harness's default.
wire_values!(ApprovalMode {
  Ask => "ask",
  Auto => "auto",
  FullAuto => "full_auto",
});

/// A run-scoped MCP token. `Debug` never prints it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct McpToken(pub(crate) String);

impl std::fmt::Debug for McpToken {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str("McpToken(..)")
  }
}

/// Answers to a blocking question, keyed by question id: option labels or
/// free text. They may hold a secret the question asked for, so `Debug`
/// prints only the question ids. Parsing enforces the contract's bounds.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "BTreeMap<String, Vec<String>>")]
pub(crate) struct QuestionAnswers(BTreeMap<String, Vec<String>>);

impl QuestionAnswers {
  pub(crate) fn question_ids(&self) -> impl Iterator<Item = &str> {
    self.0.keys().map(String::as_str)
  }
}

fn utf16_length(value: &str) -> usize {
  value.encode_utf16().count()
}

impl TryFrom<BTreeMap<String, Vec<String>>> for QuestionAnswers {
  type Error = String;

  fn try_from(answers: BTreeMap<String, Vec<String>>) -> Result<Self, Self::Error> {
    if answers.len() > MAX_ANSWERED_QUESTIONS {
      return Err(format!(
        "at most {MAX_ANSWERED_QUESTIONS} questions are answered at once"
      ));
    }
    for (id, given) in &answers {
      if id.is_empty() || utf16_length(id) > MAX_QUESTION_ID_LENGTH {
        return Err("a question id is empty or too long".to_owned());
      }
      if given.len() > MAX_ANSWERS_PER_QUESTION
        || given
          .iter()
          .any(|answer| utf16_length(answer) > MAX_ANSWER_LENGTH)
      {
        return Err(format!("the answers to question {id} exceed the limits"));
      }
    }
    Ok(Self(answers))
  }
}

impl std::fmt::Debug for QuestionAnswers {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.debug_set().entries(self.question_ids()).finish()
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
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadyHarness {
  pub(crate) id: Harness,
  pub(crate) version: String,
  pub(crate) capabilities: Vec<HarnessCapability>,
  /// The approval modes this desktop can run the harness in; lists `Ask`.
  pub(crate) approval_modes: Vec<ApprovalMode>,
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

/// An installed harness this desktop could not check, so it can neither offer
/// it nor say it is unsupported.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct UnavailableHarness {
  pub(crate) id: Harness,
  pub(crate) reason: HarnessUnavailableReason,
}

wire_union!(HarnessReport tagged "state" {
  Ready(ReadyHarness) => "ready",
  NeedsLogin(SignedOutHarness) => "needs_login",
  LimitUntil(LimitedHarness) => "limit_until",
  NotInstalled(MissingHarness) => "not_installed",
  Unsupported(UnsupportedHarness) => "unsupported",
  Unavailable(UnavailableHarness) => "unavailable",
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

/// How a folder restore ended; it names no file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderRestored {
  pub(crate) restore_id: String,
  pub(crate) outcome: FolderRestoreOutcome,
}

wire_union!(DesktopMessage tagged "type" {
  Hello(Hello) => "hello",
  HarnessStatus(HarnessStatus) => "harness.status",
  RunAccepted(RunRef) => "run.accepted",
  RunRejected(RunRejected) => "run.rejected",
  RunEvent(RunEvent) => "run.event",
  RunApprovalRequest(RunApprovalRequest) => "run.approval_request",
  RunFinished(RunFinished) => "run.finished",
  FolderRestored(FolderRestored) => "folder.restored",
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
  pub(crate) approvals: ApprovalMode,
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
  /// The folder the run works in; a chat's runs share one.
  pub(crate) folder_id: String,
  pub(crate) harness: Harness,
  pub(crate) harness_version: String,
  pub(crate) model: String,
  pub(crate) harness_session_id: Option<String>,
  pub(crate) instructions: String,
  pub(crate) messages: Vec<JsonObject>,
  /// Files the sidecar copies into the run's folder before the harness starts.
  #[serde(default)]
  pub(crate) attachments: Vec<RunAttachment>,
  pub(crate) policy: RunPolicy,
  pub(crate) mcp: McpBinding,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunAttachment {
  pub(crate) path: String,
  pub(crate) url: String,
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

/// Answers to a blocking question the run asked. The request id is the id of
/// the question's interrupt in the run's chunks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunAnswer {
  pub(crate) run_id: String,
  pub(crate) request_id: String,
  pub(crate) answers: QuestionAnswers,
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

/// A chat folder's id. Only a UUID names a folder, so no path rides in it;
/// anything else fails to parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct FolderId(uuid::Uuid);

impl FolderId {
  pub(crate) const fn uuid(self) -> uuid::Uuid {
    self.0
  }
}

impl TryFrom<String> for FolderId {
  type Error = uuid::Error;

  fn try_from(id: String) -> Result<Self, Self::Error> {
    uuid::Uuid::parse_str(&id).map(Self)
  }
}

impl From<FolderId> for String {
  fn from(id: FolderId) -> Self {
    id.0.to_string()
  }
}

/// Put a chat's folder back as it was before the run, from the checkpoint the
/// run took. Sent again on a new socket until it is answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderRestore {
  pub(crate) restore_id: String,
  pub(crate) folder_id: FolderId,
  pub(crate) run_id: String,
}

wire_union!(ServerMessage tagged "type" {
  Welcome(Welcome) => "welcome",
  UpgradeRequired(UpgradeRequired) => "upgrade_required",
  Reconnect(Reconnect) => "reconnect",
  RunStart(Box<RunStart>) => "run.start",
  RunInput(RunInput) => "run.input",
  RunApproval(RunApproval) => "run.approval",
  RunAnswer(RunAnswer) => "run.answer",
  RunInterrupt(RunRef) => "run.interrupt",
  RunCancel(RunRef) => "run.cancel",
  RunToken(RunTokenRefresh) => "run.token",
  Ack(Ack) => "ack",
  FolderRestore(FolderRestore) => "folder.restore",
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
        "harnessUnavailableReasons",
        names(
          HarnessUnavailableReason::ALL
            .iter()
            .map(|value| value.wire_name()),
        ),
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
        "folderRestoreOutcomes",
        names(
          FolderRestoreOutcome::ALL
            .iter()
            .map(|value| value.wire_name()),
        ),
      ),
      (
        "networkPolicies",
        names(NetworkPolicy::ALL.iter().map(|value| value.wire_name())),
      ),
      (
        "fsPolicies",
        names(FsPolicy::ALL.iter().map(|value| value.wire_name())),
      ),
      (
        "approvalModes",
        names(ApprovalMode::ALL.iter().map(|value| value.wire_name())),
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
    let limits = &fixtures["vocabulary"]["runLimits"];
    assert_eq!(
      limits["maxMessagesPerRun"].as_u64(),
      Some(u64::from(MAX_MESSAGES_PER_RUN))
    );
    assert_eq!(
      limits["maxMessageBytesPerRun"].as_u64(),
      Some(MAX_MESSAGE_BYTES_PER_RUN)
    );
    let answers = &fixtures["vocabulary"]["answerLimits"];
    for (name, rust) in [
      ("maxQuestions", MAX_ANSWERED_QUESTIONS),
      ("maxAnswersPerQuestion", MAX_ANSWERS_PER_QUESTION),
      ("maxAnswerLength", MAX_ANSWER_LENGTH),
      ("maxQuestionIdLength", MAX_QUESTION_ID_LENGTH),
    ] {
      assert_eq!(answers[name].as_u64(), u64::try_from(rust).ok(), "{name}");
    }
  }

  #[test]
  fn answers_take_each_bound_and_refuse_one_past_it() {
    let parses = |answers: Value| {
      serde_json::from_value::<ServerMessage>(serde_json::json!({
        "type": "run.answer",
        "runId": "0192f3a0-6b1c-7d2e-8f30-000000000001",
        "requestId": "0192f3a0-6b1c-7d2e-8f30-0000000000b1",
        "answers": answers,
      }))
      .is_ok()
    };
    let questions = |count: usize| {
      Value::Object(
        (0..count)
          .map(|index| (format!("q{index}"), serde_json::json!(["a"])))
          .collect(),
      )
    };
    let answers = |count: usize| serde_json::json!({ "tone": vec!["a"; count] });
    let answer = |text: String| serde_json::json!({ "tone": [text] });
    let id = |length: usize| {
      let mut map = Map::new();
      map.insert("q".repeat(length), serde_json::json!(["a"]));
      Value::Object(map)
    };
    let cases = [
      (
        "questions",
        questions(MAX_ANSWERED_QUESTIONS),
        questions(MAX_ANSWERED_QUESTIONS + 1),
      ),
      (
        "answers",
        answers(MAX_ANSWERS_PER_QUESTION),
        answers(MAX_ANSWERS_PER_QUESTION + 1),
      ),
      (
        "answer length",
        answer("a".repeat(MAX_ANSWER_LENGTH)),
        answer("a".repeat(MAX_ANSWER_LENGTH + 1)),
      ),
      (
        "question id",
        id(MAX_QUESTION_ID_LENGTH),
        id(MAX_QUESTION_ID_LENGTH + 1),
      ),
    ];
    for (name, at_bound, past_bound) in cases {
      assert!(parses(at_bound), "{name} at the bound");
      assert!(!parses(past_bound), "{name} past the bound");
    }
    // Two UTF-8 bytes, one UTF-16 code unit: the bound is on code units.
    assert!(parses(answer("é".repeat(MAX_ANSWER_LENGTH))));
  }

  #[test]
  fn answers_stay_out_of_debug_output() {
    let fixtures = fixtures();
    for message in entries(&fixtures, "/valid/server") {
      if message["type"] != "run.answer" {
        continue;
      }
      let parsed: ServerMessage = serde_json::from_value(message.clone()).unwrap();
      let debug = format!("{parsed:?}");
      for answers in message["answers"].as_object().unwrap().values() {
        for answer in answers.as_array().unwrap() {
          assert!(!debug.contains(answer.as_str().unwrap()), "{debug}");
        }
      }
      assert!(debug.contains("tone"), "{debug}");
    }
  }

  #[test]
  fn socket_path_header_close_codes_and_timings_match_the_contract() {
    let fixtures = fixtures();
    let vocabulary = &fixtures["vocabulary"];
    assert_eq!(vocabulary["path"], PATH);
    assert_eq!(vocabulary["desktopIdHeader"], DESKTOP_ID_HEADER);
    assert_eq!(vocabulary["policyViolationCode"], POLICY_VIOLATION_CODE);
    let millis = |name: &str| {
      Duration::from_millis(
        vocabulary["timing"][name]
          .as_u64()
          .unwrap_or_else(|| panic!("timing {name}")),
      )
    };
    assert_eq!(millis("pingIntervalMs"), PING_INTERVAL);
    assert_eq!(millis("helloTimeoutMs"), HELLO_TIMEOUT);

    let contract = vocabulary["close"].as_object().expect("close codes");
    let rust: BTreeSet<String> = CloseCode::ALL
      .iter()
      .map(|close| close.contract().0.to_owned())
      .collect();
    assert_eq!(rust, contract.keys().cloned().collect::<BTreeSet<_>>());
    for close in CloseCode::ALL {
      let (key, code, reason) = close.contract();
      assert_eq!(contract[key]["code"], code, "{key}");
      assert_eq!(contract[key]["reason"], reason, "{key}");
      assert_eq!(CloseCode::from_code(code), Some(*close));
    }
    assert_eq!(CloseCode::from_code(POLICY_VIOLATION_CODE), None);
    assert_eq!(CloseCode::from_code(1000), None);
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
