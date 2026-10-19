use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::fs;

use crate::types::{
  DesktopEditFileType, DesktopNotificationPreferences, LinkedAccountSnapshot,
  SessionStatus, TrustedSelfHostConnection,
};

const fn default_persisted_file_type() -> DesktopEditFileType {
  DesktopEditFileType::Docx
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDesktopSession {
  pub api_base_url: String,
  pub base_version_number: i64,
  pub entity_id: String,
  // Stores written before multi-format editing contain DOCX sessions only.
  #[serde(default = "default_persisted_file_type")]
  pub file_type: DesktopEditFileType,
  pub file_name: String,
  pub file_path: String,
  pub id: String,
  pub key: String,
  pub last_checkpoint_at: Option<String>,
  pub last_checkpoint_sha: Option<String>,
  pub last_error: Option<String>,
  pub last_local_sha: String,
  pub pending_finalize: bool,
  pub property_id: String,
  pub status: SessionStatus,
  pub takeover_detected: bool,
  pub workspace_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStorePayload {
  #[serde(default)]
  pub cleanup_paths: Vec<String>,
  pub linked_account: Option<LinkedAccountSnapshot>,
  #[serde(default)]
  pub linked_account_web_origin: Option<String>,
  #[serde(default)]
  pub selected_self_host_connection: Option<TrustedSelfHostConnection>,
  pub notification_preferences: Option<DesktopNotificationPreferences>,
  pub sessions: Vec<PersistedDesktopSession>,
  #[serde(default)]
  pub trusted_self_host_connections: Vec<TrustedSelfHostConnection>,
}

#[derive(Debug)]
pub enum StoreLoadIssue {
  InvalidStore,
  UnreadableStore,
}

pub struct LoadedSessionStore {
  pub cleanup_paths: Vec<String>,
  pub linked_account: Option<LinkedAccountSnapshot>,
  pub linked_account_web_origin: Option<String>,
  pub selected_self_host_connection: Option<TrustedSelfHostConnection>,
  pub notification_preferences: Option<DesktopNotificationPreferences>,
  pub sessions: Vec<PersistedDesktopSession>,
  pub trusted_self_host_connections: Vec<TrustedSelfHostConnection>,
  pub load_issue: Option<StoreLoadIssue>,
}

pub async fn load_session_store(store_path: &Path) -> LoadedSessionStore {
  let empty = LoadedSessionStore {
    cleanup_paths: Vec::new(),
    linked_account: None,
    linked_account_web_origin: None,
    selected_self_host_connection: None,
    notification_preferences: None,
    sessions: Vec::new(),
    trusted_self_host_connections: Vec::new(),
    load_issue: None,
  };

  let raw = match fs::read_to_string(store_path).await {
    Ok(content) => content,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return empty,
    Err(_) => {
      return LoadedSessionStore {
        load_issue: Some(StoreLoadIssue::UnreadableStore),
        ..empty
      };
    }
  };

  match serde_json::from_str::<SessionStorePayload>(&raw) {
    Ok(payload) => LoadedSessionStore {
      cleanup_paths: payload.cleanup_paths,
      linked_account: payload.linked_account,
      linked_account_web_origin: payload.linked_account_web_origin,
      selected_self_host_connection: payload.selected_self_host_connection,
      notification_preferences: payload.notification_preferences,
      sessions: payload.sessions,
      trusted_self_host_connections: payload.trusted_self_host_connections,
      load_issue: None,
    },
    Err(error) => {
      crate::logging::log_json_error(&error, "session store is invalid");
      LoadedSessionStore {
        load_issue: Some(StoreLoadIssue::InvalidStore),
        ..empty
      }
    }
  }
}

pub async fn persist_session_store(
  store_path: &Path,
  payload: &SessionStorePayload,
) -> Result<(), String> {
  let path = store_path.to_path_buf();
  let json = serde_json::to_vec_pretty(payload)
    .map_err(|error| format!("serialize failed: {error}"))?;
  tokio::task::spawn_blocking(move || {
    if let Some(parent) = path.parent() {
      crate::local_store::create_private_dir(parent)
        .map_err(|error| format!("mkdir failed: {error}"))?;
    }
    crate::local_store::write_private_atomic(&path, &json)
  })
  .await
  .map_err(|error| format!("store task failed: {error}"))?
}

#[cfg(test)]
#[allow(
  clippy::disallowed_methods,
  reason = "tests construct local file fixtures"
)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  #[cfg(unix)]
  #[tokio::test]
  async fn local_file_creation_keeps_session_state() {
    use std::os::unix::fs::PermissionsExt;
    if crate::local_store::local_file_creation_child(
      "session_store::tests::local_file_creation_keeps_session_state",
    ) {
      return;
    }
    let path = unique_path("local-file");
    persist_session_store(&path, &make_payload()).await.unwrap();
    assert_eq!(
      std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
      0o600
    );
    assert_eq!(
      std::fs::metadata(path.parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777,
      0o700
    );
    assert_eq!(
      std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
      1
    );
    let blocked = path.join("sessions.json");
    assert!(
      persist_session_store(&blocked, &make_payload())
        .await
        .unwrap_err()
        .contains("mkdir failed")
    );
    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  fn make_session() -> PersistedDesktopSession {
    PersistedDesktopSession {
      api_base_url: "https://api.example.com".into(),
      base_version_number: 1,
      entity_id: "ent-1".into(),
      file_type: DesktopEditFileType::Docx,
      file_name: "contract.docx".into(),
      file_path: "/tmp/contract.docx".into(),
      id: "sess-1".into(),
      key: "key-abc".into(),
      last_checkpoint_at: None,
      last_checkpoint_sha: None,
      last_error: None,
      last_local_sha: "deadbeef".into(),
      pending_finalize: false,
      property_id: "prop-1".into(),
      status: SessionStatus::Ready,
      takeover_detected: false,
      workspace_id: "ws-1".into(),
    }
  }

  fn make_payload() -> SessionStorePayload {
    SessionStorePayload {
      cleanup_paths: vec!["/tmp/old.docx".into()],
      linked_account: Some(LinkedAccountSnapshot {
        email: "user@example.com".into(),
        name: Some("Test User".into()),
        verified_at: "2026-01-01T00:00:00Z".into(),
      }),
      linked_account_web_origin: Some("https://selfhost.example".into()),
      selected_self_host_connection: None,
      notification_preferences: Some(DesktopNotificationPreferences::default()),
      sessions: vec![make_session()],
      trusted_self_host_connections: vec![TrustedSelfHostConnection {
        api_base_url: "https://api.selfhost.example".into(),
        trusted_at: "2026-01-01T00:00:00Z".into(),
        web_origin: "https://selfhost.example".into(),
      }],
    }
  }

  fn unique_path(name: &str) -> PathBuf {
    let directory =
      std::env::temp_dir().join(format!("stella-test-{name}-{}", uuid::Uuid::new_v4()));
    crate::local_store::create_private_dir(&directory).unwrap();
    directory.join("sessions.json")
  }

  // -- Serde round-trip --

  #[test]
  fn test_serde_roundtrip() {
    let payload = make_payload();
    let json = serde_json::to_string_pretty(&payload).unwrap();
    let deserialized: SessionStorePayload = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.sessions.len(), 1);
    assert_eq!(deserialized.sessions[0].id, "sess-1");
    assert_eq!(deserialized.sessions[0].status, SessionStatus::Ready);
    assert_eq!(deserialized.cleanup_paths, vec!["/tmp/old.docx"]);
    assert_eq!(
      deserialized.trusted_self_host_connections[0].web_origin,
      "https://selfhost.example"
    );
    assert!(deserialized.linked_account.is_some());
    assert_eq!(
      deserialized.linked_account_web_origin.as_deref(),
      Some("https://selfhost.example")
    );
    assert_eq!(
      deserialized.linked_account.unwrap().email,
      "user@example.com"
    );
  }

  #[test]
  fn persisted_account_without_web_origin_remains_readable() {
    let mut value = serde_json::to_value(make_payload()).unwrap();
    value
      .as_object_mut()
      .unwrap()
      .remove("linkedAccountWebOrigin");

    let payload: SessionStorePayload = serde_json::from_value(value).unwrap();

    assert!(payload.linked_account.is_some());
    assert!(payload.linked_account_web_origin.is_none());
  }

  #[test]
  fn persisted_docx_session_without_file_type_still_loads() {
    let mut value = serde_json::to_value(make_session()).unwrap();
    value.as_object_mut().unwrap().remove("fileType");

    let session: PersistedDesktopSession = serde_json::from_value(value).unwrap();

    assert_eq!(session.file_type, DesktopEditFileType::Docx);
  }

  // -- load_session_store --

  #[tokio::test]
  async fn test_load_missing_file_returns_default() {
    let path = unique_path("missing");
    let loaded = load_session_store(&path).await;
    assert!(loaded.sessions.is_empty());
    assert!(loaded.load_issue.is_none());
    assert!(loaded.linked_account.is_none());
  }

  #[tokio::test]
  async fn test_load_corrupt_json_returns_issue() {
    let path = unique_path("corrupt");
    fs::write(&path, "not valid json {{{").await.unwrap();

    let loaded = load_session_store(&path).await;
    assert!(loaded.sessions.is_empty());
    assert!(matches!(
      loaded.load_issue,
      Some(StoreLoadIssue::InvalidStore)
    ));

    let _ = fs::remove_file(&path).await;
  }

  // -- persist + load round-trip --

  #[tokio::test]
  async fn test_persist_and_reload() {
    let path = unique_path("persist");
    let session = make_session();
    let linked = Some(LinkedAccountSnapshot {
      email: "test@test.com".into(),
      name: None,
      verified_at: "2026-04-25T00:00:00Z".into(),
    });
    let prefs = DesktopNotificationPreferences::default();

    persist_session_store(
      &path,
      &SessionStorePayload {
        cleanup_paths: vec!["/tmp/cleanup.docx".into()],
        linked_account: linked,
        linked_account_web_origin: Some("https://selfhost.example".into()),
        selected_self_host_connection: None,
        notification_preferences: Some(prefs),
        sessions: vec![session],
        trusted_self_host_connections: vec![TrustedSelfHostConnection {
          api_base_url: "https://api.selfhost.example".into(),
          trusted_at: "2026-04-25T00:00:00Z".into(),
          web_origin: "https://selfhost.example".into(),
        }],
      },
    )
    .await
    .unwrap();

    let loaded = load_session_store(&path).await;
    assert!(loaded.load_issue.is_none());
    assert_eq!(loaded.sessions.len(), 1);
    assert_eq!(loaded.sessions[0].file_name, "contract.docx");
    assert_eq!(loaded.cleanup_paths, vec!["/tmp/cleanup.docx"]);
    assert_eq!(
      loaded.trusted_self_host_connections[0].api_base_url,
      "https://api.selfhost.example"
    );
    assert_eq!(loaded.linked_account.unwrap().email, "test@test.com");
    assert_eq!(
      loaded.linked_account_web_origin.as_deref(),
      Some("https://selfhost.example")
    );

    let _ = fs::remove_file(&path).await;
  }
}
