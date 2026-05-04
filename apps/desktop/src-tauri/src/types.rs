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

/// Monotonic integer the web app uses to feature-detect the
/// bridge protocol it's talking to. Increment by 1 every time a
/// new bridge endpoint or backwards-compatible field is added so
/// the web side can gate features on `snapshot.bridgeVersion >= N`
/// without coupling to the desktop's literal app version.
pub const BRIDGE_VERSION: u32 = 1;

/// Feature flags advertised to the web app. Add a string here
/// whenever a new capability lands on the bridge so the web app
/// can check for it explicitly (e.g. `caps.includes("docx.v2")`).
/// Strictly additive — never remove a string once shipped or older
/// web builds will assume the capability is gone and degrade.
pub const BRIDGE_CAPABILITIES: &[&str] = &[];

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
  pub update: DesktopUpdateSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocxRequest {
  pub api_base_url: String,
  pub entity_id: String,
  pub linked_account: Option<LinkedAccountSnapshot>,
  pub property_id: String,
  pub remote_session: OpenDocxRemoteSession,
  pub workspace_id: String,
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
