use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::fs;

use crate::types::{
  DesktopNotificationPreferences, LinkedAccountSnapshot, SessionStatus,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDesktopSession {
  pub api_base_url: String,
  pub base_version_number: i64,
  pub entity_id: String,
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
  pub notification_preferences: Option<DesktopNotificationPreferences>,
  pub sessions: Vec<PersistedDesktopSession>,
}

#[derive(Debug)]
pub enum StoreLoadIssue {
  InvalidStore,
  UnreadableStore,
}

pub struct LoadedSessionStore {
  pub cleanup_paths: Vec<String>,
  pub linked_account: Option<LinkedAccountSnapshot>,
  pub notification_preferences: Option<DesktopNotificationPreferences>,
  pub sessions: Vec<PersistedDesktopSession>,
  pub load_issue: Option<StoreLoadIssue>,
}

pub async fn load_session_store(store_path: &Path) -> LoadedSessionStore {
  let empty = LoadedSessionStore {
    cleanup_paths: Vec::new(),
    linked_account: None,
    notification_preferences: None,
    sessions: Vec::new(),
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
      notification_preferences: payload.notification_preferences,
      sessions: payload.sessions,
      load_issue: None,
    },
    Err(_) => LoadedSessionStore {
      load_issue: Some(StoreLoadIssue::InvalidStore),
      ..empty
    },
  }
}

pub async fn persist_session_store(
  store_path: &Path,
  cleanup_paths: &[String],
  linked_account: &Option<LinkedAccountSnapshot>,
  notification_preferences: &DesktopNotificationPreferences,
  sessions: &[PersistedDesktopSession],
) -> Result<(), String> {
  if let Some(parent) = store_path.parent() {
    fs::create_dir_all(parent)
      .await
      .map_err(|e| format!("mkdir failed: {e}"))?;
  }

  let payload = SessionStorePayload {
    cleanup_paths: cleanup_paths.to_vec(),
    linked_account: linked_account.clone(),
    notification_preferences: Some(notification_preferences.clone()),
    sessions: sessions.to_vec(),
  };

  let json = serde_json::to_string_pretty(&payload)
    .map_err(|e| format!("serialize failed: {e}"))?;

  let temp_path = format!(
    "{}.{}.{}.tmp",
    store_path.display(),
    std::process::id(),
    uuid::Uuid::new_v4()
  );

  fs::write(&temp_path, &json)
    .await
    .map_err(|e| format!("write failed: {e}"))?;

  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ =
      fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o600)).await;
  }

  fs::rename(&temp_path, store_path)
    .await
    .map_err(|e| format!("rename failed: {e}"))?;

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn make_session() -> PersistedDesktopSession {
    PersistedDesktopSession {
      api_base_url: "https://api.example.com".into(),
      base_version_number: 1,
      entity_id: "ent-1".into(),
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
      notification_preferences: Some(DesktopNotificationPreferences::default()),
      sessions: vec![make_session()],
    }
  }

  fn unique_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
      "stella-test-{}-{}.json",
      name,
      uuid::Uuid::new_v4()
    ))
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
    assert!(deserialized.linked_account.is_some());
    assert_eq!(
      deserialized.linked_account.unwrap().email,
      "user@example.com"
    );
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
      &["/tmp/cleanup.docx".into()],
      &linked,
      &prefs,
      &[session],
    )
    .await
    .unwrap();

    let loaded = load_session_store(&path).await;
    assert!(loaded.load_issue.is_none());
    assert_eq!(loaded.sessions.len(), 1);
    assert_eq!(loaded.sessions[0].file_name, "contract.docx");
    assert_eq!(loaded.cleanup_paths, vec!["/tmp/cleanup.docx"]);
    assert_eq!(loaded.linked_account.unwrap().email, "test@test.com");

    let _ = fs::remove_file(&path).await;
  }
}
