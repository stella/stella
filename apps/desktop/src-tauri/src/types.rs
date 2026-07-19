use serde::{Deserialize, Serialize};

pub const DEFAULT_BRIDGE_PORT: u16 = 45_901;
pub const DOCX_MIME_TYPE: &str =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
  Opening,
  Ready,
  Syncing,
  Finalizing,
  Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
  pub base_version_number: i64,
  pub entity_id: String,
  pub file_name: String,
  pub file_path: String,
  pub id: String,
  pub last_error: Option<String>,
  pub last_checkpoint_at: Option<String>,
  pub pending_finalize: bool,
  pub property_id: String,
  pub status: SessionStatus,
  pub takeover_detected: bool,
  pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationPreferences {
  pub document_ready: bool,
  pub revision_created: bool,
  pub sync_issues: bool,
}

impl Default for DesktopNotificationPreferences {
  fn default() -> Self {
    Self {
      document_ready: true,
      revision_created: true,
      sync_issues: true,
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedAccountSnapshot {
  pub email: String,
  pub name: Option<String>,
  pub verified_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocxRemoteSession {
  pub base_version_number: i64,
  pub download_url: String,
  pub file_name: String,
  pub last_checkpoint_at: Option<String>,
  pub resumed_from_checkpoint: bool,
  pub session_id: String,
  pub session_token: String,
  pub took_over_existing_session: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateSnapshot {
  pub base_url: Option<String>,
  pub channel: Option<String>,
  pub current_hash: Option<String>,
  pub current_version: Option<String>,
  pub last_checked_at: Option<String>,
  pub latest_hash: Option<String>,
  pub latest_version: Option<String>,
  pub status: String,
  pub status_message: String,
  pub update_available: bool,
  pub update_ready: bool,
}

impl Default for DesktopUpdateSnapshot {
  fn default() -> Self {
    Self {
      base_url: None,
      channel: None,
      current_hash: None,
      // Stamp the build's own version so the Settings panel shows
      // it immediately, before any updater check populates the
      // remote-version fields. Without this, the UI falls back to
      // the "Preview build" / "Development build" label.
      current_version: Some(env!("CARGO_PKG_VERSION").to_string()),
      last_checked_at: None,
      latest_hash: None,
      latest_version: None,
      status: "disabled".to_string(),
      status_message: "Updates will appear here once configured.".to_string(),
      update_available: false,
      update_ready: false,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedSelfHostConnection {
  pub api_base_url: String,
  pub trusted_at: String,
  pub web_origin: String,
}

/// Monotonic integer the web app uses to feature-detect the
/// bridge protocol it's talking to. Increment by 1 every time a
/// new bridge endpoint or backwards-compatible field is added so
/// the web side can gate features on `snapshot.bridgeVersion >= N`
/// without coupling to the desktop's literal app version.
pub const BRIDGE_VERSION: u32 = 8;

/// Feature flags advertised to the web app. Add a string here
/// whenever a new capability lands on the bridge so the web app
/// can check for it explicitly (e.g. `caps.includes("docx.v2")`).
/// Strictly additive — never remove a string once shipped or older
/// web builds will assume the capability is gone and degrade.
pub const BRIDGE_CAPABILITIES: &[&str] = &["self-host.connect"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
  pub bridge_port: u16,
  /// See [`BRIDGE_VERSION`].
  pub bridge_version: u32,
  /// See [`BRIDGE_CAPABILITIES`].
  pub capabilities: Vec<String>,
  pub linked_account: Option<LinkedAccountSnapshot>,
  pub notification_preferences: DesktopNotificationPreferences,
  pub running_since: String,
  pub sessions: Vec<SessionSnapshot>,
  pub trusted_self_host_connections: Vec<TrustedSelfHostConnection>,
  pub update: DesktopUpdateSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocxRequest {
  pub api_base_url: String,
  pub entity_id: String,
  #[serde(default)]
  pub handoff_id: Option<String>,
  pub linked_account: Option<LinkedAccountSnapshot>,
  pub property_id: String,
  pub remote_session: OpenDocxRemoteSession,
  pub workspace_id: String,
}

/// Server-issued session identifiers are UUIDs. Locking the predicate to UUID
/// shape — 8-4-4-4-12 ASCII hex, total 36 characters — keeps the rest of the
/// desktop pipeline free of platform-specific escaping concerns (Windows
/// reserved device names, trailing dot/space normalization, mixed-case
/// collisions on case-insensitive filesystems).
pub const SESSION_ID_LEN: usize = 36;
const UUID_HYPHEN_POSITIONS: &[usize] = &[8, 13, 18, 23];

pub fn is_safe_session_id(value: &str) -> bool {
  if value.len() != SESSION_ID_LEN {
    return false;
  }
  for (idx, ch) in value.char_indices() {
    let must_be_hyphen = UUID_HYPHEN_POSITIONS.contains(&idx);
    if must_be_hyphen {
      if ch != '-' {
        return false;
      }
    } else if !ch.is_ascii_hexdigit() {
      return false;
    }
  }
  true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocxResponse {
  pub already_open: bool,
  pub file_path: String,
  pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResponse {
  pub checkpointed_at: String,
  // Serde surface: mirrors the server checkpoint contract; not branched on yet.
  #[allow(dead_code)]
  pub noop: bool,
  /// Present when the server rotates the session token on a non-noop checkpoint.
  pub rotated_session_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum FinalizeResponse {
  #[serde(rename_all = "camelCase")]
  Finalized {
    // Serde surface: mirrors the server finalize contract; not branched on yet.
    #[allow(dead_code)]
    entity_id: String,
    version_number: i64,
  },
  NoChanges,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
  pub code: Option<String>,
  pub message: Option<String>,
}

#[cfg(test)]
mod tests {
  use super::*;

  // -- SessionStatus serde --

  #[test]
  fn test_session_status_serialize() {
    assert_eq!(
      serde_json::to_string(&SessionStatus::Opening).unwrap(),
      r#""opening""#
    );
    assert_eq!(
      serde_json::to_string(&SessionStatus::Ready).unwrap(),
      r#""ready""#
    );
    assert_eq!(
      serde_json::to_string(&SessionStatus::Syncing).unwrap(),
      r#""syncing""#
    );
    assert_eq!(
      serde_json::to_string(&SessionStatus::Finalizing).unwrap(),
      r#""finalizing""#
    );
    assert_eq!(
      serde_json::to_string(&SessionStatus::Error).unwrap(),
      r#""error""#
    );
  }

  #[test]
  fn test_session_status_deserialize() {
    assert_eq!(
      serde_json::from_str::<SessionStatus>(r#""opening""#).unwrap(),
      SessionStatus::Opening
    );
    assert_eq!(
      serde_json::from_str::<SessionStatus>(r#""error""#).unwrap(),
      SessionStatus::Error
    );
  }

  #[test]
  fn test_session_status_deserialize_invalid() {
    assert!(serde_json::from_str::<SessionStatus>(r#""unknown""#).is_err());
  }

  // -- AppSnapshot round-trip --

  #[test]
  fn test_app_snapshot_roundtrip() {
    let snapshot = AppSnapshot {
      bridge_port: 45_901,
      bridge_version: BRIDGE_VERSION,
      capabilities: BRIDGE_CAPABILITIES
        .iter()
        .map(|s| (*s).to_string())
        .collect(),
      linked_account: Some(LinkedAccountSnapshot {
        email: "test@test.com".into(),
        name: Some("Jane".into()),
        verified_at: "2026-01-01T00:00:00Z".into(),
      }),
      notification_preferences: DesktopNotificationPreferences::default(),
      running_since: "2026-01-01T00:00:00Z".into(),
      sessions: vec![SessionSnapshot {
        base_version_number: 3,
        entity_id: "ent-1".into(),
        file_name: "brief.docx".into(),
        file_path: "/tmp/brief.docx".into(),
        id: "sess-42".into(),
        last_error: None,
        last_checkpoint_at: Some("2026-01-01T12:00:00Z".into()),
        pending_finalize: false,
        property_id: "prop-1".into(),
        status: SessionStatus::Ready,
        takeover_detected: false,
        workspace_id: "ws-1".into(),
      }],
      trusted_self_host_connections: vec![TrustedSelfHostConnection {
        api_base_url: "https://api.selfhost.example".into(),
        trusted_at: "2026-01-01T00:00:00Z".into(),
        web_origin: "https://selfhost.example".into(),
      }],
      update: DesktopUpdateSnapshot::default(),
    };

    let json = serde_json::to_string(&snapshot).unwrap();
    let deserialized: AppSnapshot = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.bridge_port, 45_901);
    assert_eq!(deserialized.sessions.len(), 1);
    assert_eq!(deserialized.sessions[0].id, "sess-42");
    assert_eq!(deserialized.sessions[0].status, SessionStatus::Ready);
    assert_eq!(
      deserialized.linked_account.as_ref().unwrap().email,
      "test@test.com"
    );
  }

  // -- OpenDocxRequest round-trip --

  #[test]
  fn test_open_docx_request_roundtrip() {
    let req = OpenDocxRequest {
      api_base_url: "https://api.example.com".into(),
      entity_id: "ent-1".into(),
      handoff_id: None,
      linked_account: None,
      property_id: "prop-1".into(),
      remote_session: OpenDocxRemoteSession {
        base_version_number: 2,
        download_url: "https://s3.example.com/doc.docx".into(),
        file_name: "motion.docx".into(),
        last_checkpoint_at: None,
        resumed_from_checkpoint: false,
        session_id: "rs-1".into(),
        session_token: "tok-abc".into(),
        took_over_existing_session: false,
      },
      workspace_id: "ws-1".into(),
    };

    let json = serde_json::to_string(&req).unwrap();
    let deserialized: OpenDocxRequest = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.entity_id, "ent-1");
    assert_eq!(deserialized.remote_session.session_id, "rs-1");
    assert_eq!(deserialized.remote_session.file_name, "motion.docx");
  }

  // -- OpenDocxResponse round-trip --

  #[test]
  fn test_open_docx_response_roundtrip() {
    let resp = OpenDocxResponse {
      already_open: true,
      file_path: "/tmp/motion.docx".into(),
      session_id: "sess-99".into(),
    };

    let json = serde_json::to_string(&resp).unwrap();
    let deserialized: OpenDocxResponse = serde_json::from_str(&json).unwrap();

    assert!(deserialized.already_open);
    assert_eq!(deserialized.session_id, "sess-99");
    assert_eq!(deserialized.file_path, "/tmp/motion.docx");
  }

  // -- session id validation --

  #[test]
  fn is_safe_session_id_accepts_lowercase_uuid() {
    assert!(is_safe_session_id("e8400e29-1d4a-4716-8a3a-2c83de7ab2e6"));
    assert!(is_safe_session_id("00000000-0000-0000-0000-000000000000"));
  }

  #[test]
  fn is_safe_session_id_accepts_uppercase_hex() {
    assert!(is_safe_session_id("E8400E29-1D4A-4716-8A3A-2C83DE7AB2E6"));
  }

  #[test]
  fn is_safe_session_id_rejects_path_traversal_and_separators() {
    assert!(!is_safe_session_id(
      "../e8400e29-1d4a-4716-8a3a-2c83de7ab2e6"
    ));
    assert!(!is_safe_session_id("e8400e29/1d4a/4716/8a3a/2c83de7ab2e6"));
    assert!(!is_safe_session_id("e8400e29\\1d4a-4716-8a3a-2c83de7ab2e6"));
    assert!(!is_safe_session_id(".."));
    assert!(!is_safe_session_id("a:b"));
  }

  #[test]
  fn is_safe_session_id_rejects_wrong_length_or_shape() {
    assert!(!is_safe_session_id(""));
    assert!(!is_safe_session_id("e8400e29-1d4a-4716-8a3a-2c83de7ab2e"));
    assert!(!is_safe_session_id("e8400e29-1d4a-4716-8a3a-2c83de7ab2e60"));
    assert!(!is_safe_session_id("e8400e2901d4a47168a3a2c83de7ab2e60000"));
    assert!(!is_safe_session_id("g8400e29-1d4a-4716-8a3a-2c83de7ab2e6"));
    assert!(!is_safe_session_id("e8400e29 1d4a 4716 8a3a 2c83de7ab2e6"));
  }

  // -- camelCase field naming --

  #[test]
  fn test_camel_case_field_names() {
    let resp = OpenDocxResponse {
      already_open: false,
      file_path: "/tmp/a.docx".into(),
      session_id: "s1".into(),
    };
    let json = serde_json::to_string(&resp).unwrap();
    assert!(json.contains("alreadyOpen"));
    assert!(json.contains("filePath"));
    assert!(json.contains("sessionId"));
    // Ensure snake_case is NOT present
    assert!(!json.contains("already_open"));
    assert!(!json.contains("file_path"));
    assert!(!json.contains("session_id"));
  }
}

/// Golden-fixture contract shared with the TypeScript bridge types.
///
/// The JSON files under `apps/desktop/fixtures/rpc/` are the single
/// source of truth for every message that crosses the web <-> desktop
/// bridge. `src/shared/rpc.golden.test.ts` validates the same files
/// against the TypeScript `rpc.ts` types; this module validates the Rust
/// serde types. A field renamed, retyped, or dropped on either side
/// without updating the fixtures fails one of the two suites, so
/// TS/Rust message-shape drift cannot land silently.
///
/// The fixtures are embedded with `include_str!` (path relative to this
/// source file), the same mechanism `i18n.rs` uses for bundled language
/// packs, so `cargo test` needs no runtime file access.
#[cfg(test)]
mod fixture_tests {
  use super::*;

  const APP_SNAPSHOT: &str = include_str!("../../fixtures/rpc/app-snapshot.json");
  const SESSION_SYNCING: &str =
    include_str!("../../fixtures/rpc/session-snapshot-syncing.json");
  const SESSION_ERROR: &str =
    include_str!("../../fixtures/rpc/session-snapshot-error.json");
  const OPEN_DOCX_REQUEST: &str =
    include_str!("../../fixtures/rpc/open-docx-request.json");
  const OPEN_DOCX_RESPONSE: &str =
    include_str!("../../fixtures/rpc/open-docx-response.json");
  const LINKED_ACCOUNT: &str = include_str!("../../fixtures/rpc/linked-account.json");
  const DESKTOP_UPDATE: &str = include_str!("../../fixtures/rpc/desktop-update.json");
  const TRUSTED_SELF_HOST: &str =
    include_str!("../../fixtures/rpc/trusted-self-host-connection.json");
  const NOTIFICATION_PREFERENCES: &str =
    include_str!("../../fixtures/rpc/notification-preferences.json");

  /// Deserialize a fixture into `T`, re-serialize it, and assert the
  /// value round-trips unchanged. Because none of these structs use
  /// `skip_serializing_if`, a missing, renamed, or ignored-unknown field
  /// makes the re-serialized value diverge from the fixture, so this is a
  /// bidirectional drift guard for symmetric types.
  fn assert_roundtrip<T>(fixture: &str)
  where
    T: serde::de::DeserializeOwned + serde::Serialize,
  {
    let original: serde_json::Value =
      serde_json::from_str(fixture).expect("fixture is valid JSON");
    let typed: T = serde_json::from_str(fixture).expect("fixture deserializes into T");
    let reserialized = serde_json::to_value(&typed).expect("T serializes");
    assert_eq!(
      reserialized, original,
      "serde round-trip diverged from the golden fixture",
    );
  }

  #[test]
  fn app_snapshot_fixture_roundtrips() {
    assert_roundtrip::<AppSnapshot>(APP_SNAPSHOT);
  }

  #[test]
  fn session_snapshot_fixtures_roundtrip() {
    assert_roundtrip::<SessionSnapshot>(SESSION_SYNCING);
    assert_roundtrip::<SessionSnapshot>(SESSION_ERROR);

    // Status strings map onto the enum variants exactly.
    let syncing: SessionSnapshot = serde_json::from_str(SESSION_SYNCING).unwrap();
    assert_eq!(syncing.status, SessionStatus::Syncing);
    let errored: SessionSnapshot = serde_json::from_str(SESSION_ERROR).unwrap();
    assert_eq!(errored.status, SessionStatus::Error);
    assert_eq!(
      errored.last_error.as_deref(),
      Some("Checkpoint upload failed: connection reset")
    );
  }

  #[test]
  fn open_docx_response_fixture_roundtrips() {
    assert_roundtrip::<OpenDocxResponse>(OPEN_DOCX_RESPONSE);
  }

  #[test]
  fn linked_account_fixture_roundtrips() {
    assert_roundtrip::<LinkedAccountSnapshot>(LINKED_ACCOUNT);
    let account: LinkedAccountSnapshot = serde_json::from_str(LINKED_ACCOUNT).unwrap();
    assert_eq!(account.name, None);
  }

  #[test]
  fn desktop_update_fixture_roundtrips() {
    assert_roundtrip::<DesktopUpdateSnapshot>(DESKTOP_UPDATE);
  }

  #[test]
  fn trusted_self_host_fixture_roundtrips() {
    assert_roundtrip::<TrustedSelfHostConnection>(TRUSTED_SELF_HOST);
  }

  #[test]
  fn notification_preferences_fixture_roundtrips() {
    assert_roundtrip::<DesktopNotificationPreferences>(NOTIFICATION_PREFERENCES);
  }

  /// `OpenDocxRequest` is intentionally deserialize-only here: the Rust
  /// struct carries a `#[serde(default)] handoff_id` that the TypeScript
  /// `OpenDocxRequest` type (and the HTTP bridge payload the web sends)
  /// omit. Since the field has no `skip_serializing_if`, re-serializing
  /// injects `"handoffId": null`, which the shared fixture deliberately
  /// does not contain, so a strict round-trip would not hold. We assert
  /// the fixture deserializes and the required fields decode correctly;
  /// the asymmetry is documented rather than papered over.
  #[test]
  fn open_docx_request_fixture_deserializes() {
    let request: OpenDocxRequest =
      serde_json::from_str(OPEN_DOCX_REQUEST).expect("fixture deserializes");
    assert_eq!(request.api_base_url, "https://api.example.com");
    assert_eq!(request.entity_id, "11111111-1111-4111-8111-111111111111");
    assert_eq!(request.handoff_id, None);
    assert_eq!(
      request.remote_session.session_id,
      "e8400e29-1d4a-4716-8a3a-2c83de7ab2e6"
    );
    assert!(is_safe_session_id(&request.remote_session.session_id));
    assert_eq!(request.remote_session.file_name, "motion.docx");
    let linked = request.linked_account.expect("linked account present");
    assert_eq!(linked.email, "counsel@example.com");
  }
}
