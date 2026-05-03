use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::config;
use crate::session_store::{self, PersistedDesktopSession, StoreLoadIssue};
use crate::types::*;

/// Per-dialog response senders, keyed by dialog label to avoid race conditions
/// when multiple takeover requests arrive for different sessions.
static TAKEOVER_SENDERS: std::sync::Mutex<
  Option<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
> = std::sync::Mutex::new(None);

fn init_takeover_senders() {
  let mut guard = TAKEOVER_SENDERS.lock().unwrap_or_else(|e| e.into_inner());
  if guard.is_none() {
    *guard = Some(HashMap::new());
  }
}

/// Register a oneshot sender for a dialog label, returning the receiver.
fn register_takeover_dialog(label: &str) -> tokio::sync::oneshot::Receiver<bool> {
  init_takeover_senders();
  let (tx, rx) = tokio::sync::oneshot::channel();
  let mut guard = TAKEOVER_SENDERS.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(ref mut map) = *guard {
    map.insert(label.to_string(), tx);
  }
  rx
}

/// Called by the takeover dialog's Allow/Deny buttons via invoke.
pub fn set_takeover_response(label: &str, approved: bool) {
  let mut guard = TAKEOVER_SENDERS.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(ref mut map) = *guard {
    if let Some(tx) = map.remove(label) {
      let _ = tx.send(approved);
    }
  }
}

const AUTO_FINALIZE_DELAY: Duration = Duration::from_millis(2500);
const CHECKPOINT_DEBOUNCE: Duration = Duration::from_millis(1200);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20);
const REMOTE_SAVE_TIMEOUT: Duration = Duration::from_secs(60);
const RETRY_INTERVAL: Duration = Duration::from_secs(15);
const LOCK_POLL_INTERVAL: Duration = Duration::from_secs(2);
const TAKEN_OVER_CODE: &str = "desktop_edit_session_taken_over";
const WORD_LOCK_PREFIX: &str = "~$";
const SUPPORT_EMAIL: &str = "hello@stll.app";

// Internal session with runtime-only fields
struct DesktopSession {
  // Persisted fields
  api_base_url: String,
  base_version_number: i64,
  entity_id: String,
  file_name: String,
  file_path: String,
  id: String,
  key: String,
  last_checkpoint_at: Option<String>,
  last_checkpoint_sha: Option<String>,
  last_error: Option<String>,
  last_local_sha: String,
  pending_finalize: bool,
  property_id: String,
  session_token: String,
  status: SessionStatus,
  takeover_detected: bool,
  workspace_id: String,
  // Runtime-only
  checkpoint_in_flight: bool,
  finalize_in_flight: bool,
  word_lock_seen: bool,
  retry_notice_shown: bool,
  _watcher: Option<RecommendedWatcher>,
  checkpoint_timer: Option<JoinHandle<()>>,
  auto_finalize_timer: Option<JoinHandle<()>>,
  lock_poll_timer: Option<JoinHandle<()>>,
  sse_listener: Option<JoinHandle<()>>,
}

impl DesktopSession {
  fn to_persisted(&self) -> PersistedDesktopSession {
    PersistedDesktopSession {
      api_base_url: self.api_base_url.clone(),
      base_version_number: self.base_version_number,
      entity_id: self.entity_id.clone(),
      file_name: self.file_name.clone(),
      file_path: self.file_path.clone(),
      id: self.id.clone(),
      key: self.key.clone(),
      last_checkpoint_at: self.last_checkpoint_at.clone(),
      last_checkpoint_sha: self.last_checkpoint_sha.clone(),
      last_error: self.last_error.clone(),
      last_local_sha: self.last_local_sha.clone(),
      pending_finalize: self.pending_finalize,
      property_id: self.property_id.clone(),
      status: self.status,
      takeover_detected: self.takeover_detected,
      workspace_id: self.workspace_id.clone(),
    }
  }

  fn to_snapshot(&self) -> SessionSnapshot {
    SessionSnapshot {
      base_version_number: self.base_version_number,
      entity_id: self.entity_id.clone(),
      file_name: self.file_name.clone(),
      file_path: self.file_path.clone(),
      id: self.id.clone(),
      last_error: self.last_error.clone(),
      last_checkpoint_at: self.last_checkpoint_at.clone(),
      pending_finalize: self.pending_finalize,
      property_id: self.property_id.clone(),
      status: self.status,
      takeover_detected: self.takeover_detected,
      workspace_id: self.workspace_id.clone(),
    }
  }

  fn cancel_timers(&mut self) {
    if let Some(handle) = self.checkpoint_timer.take() {
      handle.abort();
    }
    if let Some(handle) = self.auto_finalize_timer.take() {
      handle.abort();
    }
    if let Some(handle) = self.lock_poll_timer.take() {
      handle.abort();
    }
    if let Some(handle) = self.sse_listener.take() {
      handle.abort();
    }
  }
}

pub struct SessionManager {
  sessions: HashMap<String, DesktopSession>,
  session_ids_by_key: HashMap<String, String>,
  cleanup_paths: HashSet<String>,
  linked_account: Option<LinkedAccountSnapshot>,
  notification_preferences: DesktopNotificationPreferences,
  update: DesktopUpdateSnapshot,
  running_since: String,
  bridge_port: u16,
  store_path: PathBuf,
  edit_root: PathBuf,
  support_root: PathBuf,
  store_load_issue: Option<StoreLoadIssue>,
  http_client: reqwest::Client,
  app_handle: Option<AppHandle>,
}

fn session_key(workspace_id: &str, entity_id: &str, property_id: &str) -> String {
  format!("{workspace_id}:{entity_id}:{property_id}")
}

fn normalize_api_base_url(url: &str) -> String {
  url.strip_suffix('/').unwrap_or(url).to_string()
}

fn sanitize_file_name(name: &str) -> String {
  let base = Path::new(name)
    .file_name()
    .and_then(|n| n.to_str())
    .unwrap_or(name);

  let sanitized = base
    .replace(
      [
        '/', '"', '\\', '<', '>', '\r', '\n', '\0', '|', '*', '?', ':',
      ],
      "_",
    )
    .replace("..", "__");

  let trimmed = sanitized.trim_matches('.');
  if trimmed.is_empty() {
    "document.docx".to_string()
  } else {
    trimmed.to_string()
  }
}

fn hash_bytes(data: &[u8]) -> String {
  hex::encode(Sha256::digest(data))
}

fn did_remote_checkpoint_advance(
  local_checkpoint_at: &Option<String>,
  remote_checkpoint_at: &Option<String>,
) -> bool {
  let remote = match remote_checkpoint_at {
    Some(r) => r,
    None => return false,
  };
  let local = match local_checkpoint_at {
    Some(l) => l,
    None => return true,
  };
  remote > local
}

fn is_word_lock_file_for(candidate: &str, file_name: &str) -> bool {
  let Some(candidate_suffix) = candidate.strip_prefix(WORD_LOCK_PREFIX) else {
    return false;
  };

  if candidate_suffix == file_name {
    return true;
  }

  if file_name.starts_with(WORD_LOCK_PREFIX) {
    return false;
  }

  let mut file_name_chars = file_name.chars();
  file_name_chars.next();
  file_name_chars.next();

  candidate_suffix == file_name_chars.as_str()
}

async fn has_word_lock_file(dir: &Path, file_name: &str) -> bool {
  match tokio::fs::read_dir(dir).await {
    Ok(mut entries) => {
      while let Ok(Some(entry)) = entries.next_entry().await {
        if is_word_lock_file_for(&entry.file_name().to_string_lossy(), file_name) {
          return true;
        }
      }
      false
    }
    Err(_) => false,
  }
}

impl SessionManager {
  pub fn new() -> Self {
    let data_dir = dirs::data_dir()
      .unwrap_or_else(|| PathBuf::from("."))
      .join("legal.stella.desktop");

    let bridge_port = config::resolve_bridge_port();

    Self {
      sessions: HashMap::new(),
      session_ids_by_key: HashMap::new(),
      cleanup_paths: HashSet::new(),
      linked_account: None,
      notification_preferences: DesktopNotificationPreferences::default(),
      update: DesktopUpdateSnapshot::default(),
      running_since: chrono_now(),
      bridge_port,
      store_path: data_dir.join("desktop-edit-sessions.json"),
      edit_root: data_dir.join("editing"),
      support_root: data_dir.clone(),
      store_load_issue: None,
      http_client: reqwest::Client::new(),
      app_handle: None,
    }
  }

  pub fn set_app_handle(&mut self, handle: AppHandle) {
    self.app_handle = Some(handle);
  }

  pub async fn initialize(&mut self) {
    let store = session_store::load_session_store(&self.store_path).await;

    self.linked_account = store.linked_account;
    if let Some(prefs) = store.notification_preferences {
      self.notification_preferences = prefs;
    }
    self.store_load_issue = store.load_issue;

    if self.store_load_issue.is_some() {
      self.show_notification(
        NotifType::SyncIssues,
        crate::i18n::t("notification.recoveryResetTitle"),
        Some(crate::i18n::t("notification.recoveryResetBody")),
      );
    }

    for path in store.cleanup_paths {
      self.cleanup_paths.insert(path);
    }

    for persisted in store.sessions {
      if !Path::new(&persisted.file_path).exists() {
        continue;
      }

      // Token lives in OS keychain; skip sessions without one
      let session_token = match crate::keychain::get_token(&persisted.id) {
        Some(t) => t,
        None => {
          tracing::warn!(
              session_id = %persisted.id,
              "session token missing from keychain, skipping restore"
          );
          continue;
        }
      };

      let session = DesktopSession {
        api_base_url: persisted.api_base_url,
        base_version_number: persisted.base_version_number,
        entity_id: persisted.entity_id,
        file_name: persisted.file_name,
        file_path: persisted.file_path,
        id: persisted.id,
        key: persisted.key,
        last_checkpoint_at: persisted.last_checkpoint_at,
        last_checkpoint_sha: persisted.last_checkpoint_sha,
        last_error: persisted.last_error,
        last_local_sha: persisted.last_local_sha,
        pending_finalize: persisted.pending_finalize,
        property_id: persisted.property_id,
        session_token,
        status: persisted.status,
        takeover_detected: persisted.takeover_detected,
        workspace_id: persisted.workspace_id,
        checkpoint_in_flight: false,
        finalize_in_flight: false,
        word_lock_seen: false,
        retry_notice_shown: false,
        _watcher: None,
        checkpoint_timer: None,
        auto_finalize_timer: None,
        lock_poll_timer: None,
        sse_listener: None,
      };

      let key = session.key.clone();
      let id = session.id.clone();
      self.sessions.insert(id.clone(), session);
      self.session_ids_by_key.insert(key, id);
    }

    self.retry_pending_cleanup().await;
    self.persist_sessions().await;
  }

  /// Returns session IDs that need watchers attached (called after initialize).
  pub fn session_ids_needing_watchers(&self) -> Vec<String> {
    self
      .sessions
      .values()
      .filter(|s| !s.takeover_detected)
      .map(|s| s.id.clone())
      .collect()
  }

  pub fn get_snapshot(&self) -> AppSnapshot {
    let mut sessions: Vec<SessionSnapshot> =
      self.sessions.values().map(|s| s.to_snapshot()).collect();
    sessions.sort_by(|a, b| a.file_name.cmp(&b.file_name));

    AppSnapshot {
      bridge_port: self.bridge_port,
      linked_account: self.linked_account.clone(),
      notification_preferences: self.notification_preferences.clone(),
      running_since: self.running_since.clone(),
      sessions,
      update: self.update.clone(),
    }
  }

  /// Expose the HTTP client so callers can download outside the lock.
  pub fn http_client(&self) -> &reqwest::Client {
    &self.http_client
  }

  pub async fn open_docx(
    &mut self,
    request: OpenDocxRequest,
    prefetched_buffer: Option<Vec<u8>>,
  ) -> Result<OpenDocxResponse, String> {
    let key = session_key(
      &request.workspace_id,
      &request.entity_id,
      &request.property_id,
    );
    let remote = &request.remote_session;
    let managed_file_name = sanitize_file_name(&remote.file_name);

    // Sync linked account
    if let Some(ref account) = request.linked_account {
      let changed = self.linked_account.as_ref().is_none_or(|la| {
        la.email != account.email
          || la.name != account.name
          || la.verified_at != account.verified_at
      });
      if changed {
        self.linked_account = Some(account.clone());
        self.persist_sessions().await;
      }
    }

    // Check for reusable existing session
    let existing_id = self.session_ids_by_key.get(&key).cloned();
    let can_reuse = if let Some(ref eid) = existing_id {
      if let Some(existing) = self.sessions.get(eid) {
        existing.id == remote.session_id
          && Path::new(&existing.file_path).exists()
          && !did_remote_checkpoint_advance(
            &existing.last_checkpoint_at,
            &remote.last_checkpoint_at,
          )
      } else {
        false
      }
    } else {
      false
    };

    if can_reuse {
      let eid = existing_id.unwrap();

      // Update keychain with the (potentially refreshed) token
      if let Err(e) = crate::keychain::store_token(&eid, &remote.session_token) {
        tracing::error!(error = %e, "failed to update session token in keychain");
      }

      // Update session fields, then extract what we need before dropping the borrow
      let (file_path, session_id, file_name) = {
        let session = self.sessions.get_mut(&eid).unwrap();
        session.api_base_url = normalize_api_base_url(&request.api_base_url);
        session.base_version_number = remote.base_version_number;
        session.file_name = managed_file_name;
        session.last_checkpoint_at = remote.last_checkpoint_at.clone();
        session.last_error = None;
        session.pending_finalize = false;
        session.retry_notice_shown = false;
        session.session_token = remote.session_token.clone();
        session.status = SessionStatus::Ready;
        session.takeover_detected = false;
        (
          session.file_path.clone(),
          session.id.clone(),
          session.file_name.clone(),
        )
      };

      self.persist_sessions().await;
      self.emit_state_change();

      open_path_native(&file_path)?;

      self.show_notification(
        NotifType::DocumentReady,
        crate::i18n::t("settings.stellaDesktop"),
        Some(&file_name),
      );

      return Ok(OpenDocxResponse {
        already_open: true,
        file_path,
        session_id,
      });
    }

    // Determine folder name for managed copy
    let folder_name = if let Some(ref eid) = existing_id {
      if let Some(existing) = self.sessions.get(eid) {
        if existing.id == remote.session_id && Path::new(&existing.file_path).exists() {
          format!("{}-{}", remote.session_id, uuid::Uuid::new_v4())
        } else {
          remote.session_id.clone()
        }
      } else {
        remote.session_id.clone()
      }
    } else {
      remote.session_id.clone()
    };

    // Use prefetched buffer (downloaded outside the lock) or download now
    let buffer = match prefetched_buffer {
      Some(buf) => buf,
      None => self.download_docx(&remote.download_url).await?,
    };
    let local_sha = hash_bytes(&buffer);

    // Write to local disk
    let file_path = self
      .write_managed_copy(&folder_name, &managed_file_name, &buffer)
      .await?;

    // Clean up existing session if any
    if let Some(eid) = existing_id {
      self.cleanup_session_internal(&eid, false).await;
    }

    // Create new session
    let session = DesktopSession {
      api_base_url: normalize_api_base_url(&request.api_base_url),
      base_version_number: remote.base_version_number,
      entity_id: request.entity_id,
      file_name: managed_file_name,
      file_path: file_path.clone(),
      id: remote.session_id.clone(),
      key: key.clone(),
      last_checkpoint_at: remote.last_checkpoint_at.clone(),
      last_checkpoint_sha: if remote.resumed_from_checkpoint {
        Some(local_sha.clone())
      } else {
        None
      },
      last_error: None,
      last_local_sha: local_sha,
      pending_finalize: false,
      property_id: request.property_id,
      session_token: remote.session_token.clone(),
      status: SessionStatus::Opening,
      takeover_detected: false,
      workspace_id: request.workspace_id,
      checkpoint_in_flight: false,
      finalize_in_flight: false,
      word_lock_seen: false,
      retry_notice_shown: false,
      _watcher: None,
      checkpoint_timer: None,
      auto_finalize_timer: None,
      lock_poll_timer: None,
      sse_listener: None,
    };

    let session_id = session.id.clone();

    // Store token in OS keychain (not on disk)
    if let Err(e) = crate::keychain::store_token(&session_id, &remote.session_token) {
      tracing::error!(error = %e, "failed to store session token in keychain");
      return Err(
        "stella desktop could not securely store the session token.".to_string(),
      );
    }

    self.sessions.insert(session_id.clone(), session);
    self.session_ids_by_key.insert(key, session_id.clone());
    self.persist_sessions().await;
    self.emit_state_change();

    // Open in default app
    if let Err(e) = open_path_native(&file_path) {
      self.cleanup_session_internal(&session_id, false).await;
      return Err(e);
    }

    let session = self.sessions.get_mut(&session_id).unwrap();
    session.status = SessionStatus::Ready;
    let file_name = session.file_name.clone();
    self.persist_sessions().await;
    self.emit_state_change();

    let subtitle = if remote.took_over_existing_session {
      crate::i18n::t("notification.openedResumed")
    } else if remote.resumed_from_checkpoint {
      crate::i18n::t("notification.openedRecovered")
    } else {
      crate::i18n::t("notification.openedSaveNormally")
    };

    self.show_notification(
      NotifType::DocumentReady,
      crate::i18n::t("notification.openedTitle"),
      Some(&crate::i18n::t_fmt(
        "notification.openedBody",
        &[("fileName", &file_name), ("subtitle", subtitle)],
      )),
    );

    Ok(OpenDocxResponse {
      already_open: false,
      file_path,
      session_id,
    })
  }

  pub fn open_session_file(&self, session_id: &str) -> bool {
    self
      .sessions
      .get(session_id)
      .map(|s| open_path_native(&s.file_path).is_ok())
      .unwrap_or(false)
  }

  pub fn reveal_session(&self, session_id: &str) -> bool {
    if let Some(session) = self.sessions.get(session_id) {
      reveal_in_folder(&session.file_path);
      true
    } else {
      false
    }
  }

  pub fn finish_session(&mut self, session_id: &str) -> bool {
    let session = match self.sessions.get_mut(session_id) {
      Some(s) if !s.takeover_detected => s,
      _ => return false,
    };

    session.pending_finalize = true;
    session.last_error = None;
    session.status = if session.last_local_sha
      == session.last_checkpoint_sha.as_deref().unwrap_or("")
    {
      SessionStatus::Finalizing
    } else {
      SessionStatus::Syncing
    };

    self.emit_state_change();
    true
  }

  pub fn retry_session_now(&mut self, session_id: &str) -> bool {
    let session = match self.sessions.get_mut(session_id) {
      Some(s) if !s.takeover_detected => s,
      _ => return false,
    };

    session.last_error = None;
    session.retry_notice_shown = false;

    if session.pending_finalize {
      session.status = if session.last_local_sha
        == session.last_checkpoint_sha.as_deref().unwrap_or("")
      {
        SessionStatus::Finalizing
      } else {
        SessionStatus::Syncing
      };
    }

    self.emit_state_change();
    true
  }

  pub async fn update_notification_preferences(
    &mut self,
    prefs: DesktopNotificationPreferences,
  ) -> AppSnapshot {
    self.notification_preferences = prefs;
    self.persist_sessions().await;
    self.emit_state_change();
    self.get_snapshot()
  }

  pub async fn persist_sessions_public(&self) {
    self.persist_sessions().await;
  }

  pub fn session_exists(&self, session_id: &str) -> bool {
    self.sessions.contains_key(session_id)
  }

  pub async fn mark_session_taken_over_public(
    &mut self,
    session_id: &str,
    message: &str,
  ) {
    self.mark_session_taken_over(session_id, message).await;
  }

  pub async fn close_remote_session_public(&mut self, session_id: &str, message: &str) {
    self.close_remote_session(session_id, message).await;
  }

  /// Show a takeover request notification and add tray actions.
  /// Show a takeover request as a native macOS dialog with Allow/Deny buttons.
  /// The response is sent back to the API automatically.
  pub fn show_takeover_request(&self, session_id: &str, requested_by: &str) {
    let session = match self.sessions.get(session_id) {
      Some(s) => s,
      None => return,
    };

    let file_name = session.file_name.clone();
    let sid = session_id.to_string();
    let api_base_url = session.api_base_url.clone();
    let session_token = session.session_token.clone();
    let http_client = self.http_client.clone();
    let requested_by = requested_by.to_string();

    // Show a takeover dialog as a small Tauri webview window.
    let app_handle = self.app_handle.clone();

    tokio::spawn(async move {
      let approved = if let Some(handle) = app_handle {
        show_takeover_dialog(&handle, &requested_by, &file_name).await
      } else {
        false
      };

      // Send response to API
      let url =
        format!("{api_base_url}/v1/desktop-edit-sessions/{sid}/respond-takeover");
      let body = serde_json::json!({
        "sessionToken": session_token,
        "approved": approved,
      });

      match http_client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
      {
        Ok(r) if r.status().is_success() => {
          tracing::info!(
            session_id = %sid,
            approved,
            "takeover response sent"
          );
        }
        Ok(r) => {
          tracing::warn!(
            session_id = %sid,
            status = r.status().as_u16(),
            "takeover response failed"
          );
        }
        Err(e) => {
          tracing::warn!(
            session_id = %sid,
            error = %e,
            "takeover response network error"
          );
        }
      }
    });
  }

  /// Respond to a takeover request (called from tray menu action).
  pub async fn respond_to_takeover(&self, session_id: &str, approved: bool) -> bool {
    let session = match self.sessions.get(session_id) {
      Some(s) => s,
      None => return false,
    };

    let url = format!(
      "{}/v1/desktop-edit-sessions/{}/respond-takeover",
      session.api_base_url, session_id
    );

    let body = serde_json::json!({
      "sessionToken": session.session_token,
      "approved": approved,
    });

    match self
      .http_client
      .post(&url)
      .json(&body)
      .timeout(Duration::from_secs(10))
      .send()
      .await
    {
      Ok(r) if r.status().is_success() => true,
      Ok(r) => {
        tracing::warn!(
          session_id,
          status = r.status().as_u16(),
          "respond-takeover failed"
        );
        false
      }
      Err(e) => {
        tracing::warn!(
          session_id,
          error = %e,
          "respond-takeover network error"
        );
        false
      }
    }
  }

  pub async fn open_edit_root(&self) -> bool {
    let _ = tokio::fs::create_dir_all(&self.edit_root).await;
    open_path_native(self.edit_root.to_string_lossy().as_ref()).is_ok()
  }

  pub fn reveal_support_root(&self) -> bool {
    open_path_native(self.support_root.to_string_lossy().as_ref()).is_ok()
  }

  pub fn email_support(&self) -> bool {
    let subject = urlencode("stella desktop support");
    open_url(&format!("mailto:{SUPPORT_EMAIL}?subject={subject}"))
  }

  pub fn copy_diagnostics(&self) -> bool {
    if let Some(ref handle) = self.app_handle {
      use tauri_plugin_clipboard_manager::ClipboardExt;
      let text = self.get_diagnostics_text();
      if handle.clipboard().write_text(text).is_ok() {
        self.show_notification(
          NotifType::SyncIssues,
          crate::i18n::t("notification.diagnosticsCopiedTitle"),
          Some(crate::i18n::t("notification.diagnosticsCopiedBody")),
        );
        return true;
      }
    }
    false
  }

  // --- Checkpoint sync ---

  pub async fn sync_checkpoint(&mut self, session_id: &str) -> bool {
    {
      let session = match self.sessions.get(session_id) {
        Some(s)
          if !s.checkpoint_in_flight
            && !s.finalize_in_flight
            && !s.takeover_detected =>
        {
          s
        }
        _ => return false,
      };

      if !Path::new(&session.file_path).exists() {
        let session = self.sessions.get_mut(session_id).unwrap();
        session.last_error = Some("The managed local file is missing.".to_string());
        session.status = SessionStatus::Error;
        self.persist_sessions().await;
        self.emit_state_change();
        return false;
      }
    }

    let session = self.sessions.get_mut(session_id).unwrap();
    session.checkpoint_in_flight = true;
    session.last_error = None;
    session.status = SessionStatus::Syncing;
    let file_path = session.file_path.clone();
    let api_base_url = session.api_base_url.clone();
    let sid = session.id.clone();
    let session_token = session.session_token.clone();
    let file_name = session.file_name.clone();
    let last_checkpoint_sha = session.last_checkpoint_sha.clone();
    // Release the mutable borrow before calling other self methods
    #[allow(dropping_references)]
    drop(session);

    self.persist_sessions().await;
    self.emit_state_change();

    let result = self
      .do_sync_checkpoint(
        &sid,
        &file_path,
        &api_base_url,
        &session_token,
        &file_name,
        last_checkpoint_sha.as_deref(),
      )
      .await;

    let session = match self.sessions.get_mut(session_id) {
      Some(s) => s,
      None => return false,
    };
    session.checkpoint_in_flight = false;

    match result {
      CheckpointResult::Unchanged => {
        session.status = if session.pending_finalize {
          SessionStatus::Finalizing
        } else {
          SessionStatus::Ready
        };
        self.persist_sessions().await;
        self.emit_state_change();
        true
      }
      CheckpointResult::Uploaded {
        next_sha,
        checkpointed_at,
        rotated_token,
      } => {
        // Apply rotated token from server
        if let Some(ref new_token) = rotated_token {
          session.session_token = new_token.clone();
          if let Err(e) = crate::keychain::store_token(&session.id, new_token) {
            tracing::warn!(error = %e, "failed to store rotated token in keychain");
          }
        }

        session.last_checkpoint_sha = Some(next_sha.clone());
        session.last_local_sha = next_sha;
        session.last_checkpoint_at = Some(checkpointed_at);
        session.last_error = None;
        session.retry_notice_shown = false;
        session.status = if session.pending_finalize {
          SessionStatus::Finalizing
        } else {
          SessionStatus::Ready
        };
        self.persist_sessions().await;
        self.emit_state_change();
        true
      }
      CheckpointResult::TakenOver(message) => {
        self.mark_session_taken_over(session_id, &message).await;
        false
      }
      CheckpointResult::SessionClosed(message) => {
        self.close_remote_session(session_id, &message).await;
        false
      }
      CheckpointResult::Error(message) => {
        let session = self.sessions.get_mut(session_id).unwrap();
        session.last_error = Some(message);
        session.status = SessionStatus::Error;
        let file_name = session.file_name.clone();
        let show_notice = !session.retry_notice_shown;
        session.retry_notice_shown = true;
        self.persist_sessions().await;
        self.emit_state_change();

        if show_notice {
          self.show_notification(
            NotifType::SyncIssues,
            crate::i18n::t("notification.checkpointDelayedTitle"),
            Some(&crate::i18n::t_fmt(
              "notification.checkpointDelayedBody",
              &[("fileName", &file_name)],
            )),
          );
        }
        false
      }
    }
  }

  async fn do_sync_checkpoint(
    &self,
    session_id: &str,
    file_path: &str,
    api_base_url: &str,
    session_token: &str,
    file_name: &str,
    last_checkpoint_sha: Option<&str>,
  ) -> CheckpointResult {
    let file_bytes = match tokio::fs::read(file_path).await {
      Ok(b) => b,
      Err(e) => return CheckpointResult::Error(format!("Failed to read file: {e}")),
    };

    let next_sha = hash_bytes(&file_bytes);

    if Some(next_sha.as_str()) == last_checkpoint_sha {
      return CheckpointResult::Unchanged;
    }

    let form = reqwest::multipart::Form::new()
      .part(
        "file",
        reqwest::multipart::Part::bytes(file_bytes)
          .file_name(file_name.to_string())
          .mime_str(DOCX_MIME_TYPE)
          .unwrap(),
      )
      .text("sessionToken", session_token.to_string());

    let url =
      format!("{api_base_url}/v1/desktop-edit-sessions/{session_id}/checkpoint");

    let response = match self
      .http_client
      .post(&url)
      .multipart(form)
      .timeout(REMOTE_SAVE_TIMEOUT)
      .send()
      .await
    {
      Ok(r) => r,
      Err(e) => {
        return CheckpointResult::Error(format!(
          "stella desktop could not save the latest checkpoint: {e}"
        ));
      }
    };

    if !response.status().is_success() {
      let status = response.status();
      let error_body: Option<ErrorResponse> = response.json().await.ok();

      if status.as_u16() == 409 {
        if let Some(ref err) = error_body {
          if err.code.as_deref() == Some(TAKEN_OVER_CODE) {
            return CheckpointResult::TakenOver(err.message.clone().unwrap_or_else(
              || crate::i18n::t("notification.takenOverLocalError").to_string(),
            ));
          }
        }
        return CheckpointResult::SessionClosed(
          error_body
            .and_then(|e| e.message)
            .unwrap_or_else(|| "Desktop edit session is already closed.".to_string()),
        );
      }

      return CheckpointResult::Error(
        error_body.and_then(|e| e.message).unwrap_or_else(|| {
          "stella desktop could not save the latest checkpoint.".to_string()
        }),
      );
    }

    match response.json::<CheckpointResponse>().await {
      Ok(cp) => CheckpointResult::Uploaded {
        next_sha,
        checkpointed_at: cp.checkpointed_at,
        rotated_token: cp.rotated_session_token,
      },
      Err(e) => CheckpointResult::Error(format!(
        "stella desktop received an invalid checkpoint response: {e}"
      )),
    }
  }

  // --- Finalize ---

  pub async fn finalize_session(&mut self, session_id: &str) -> bool {
    {
      let session = match self.sessions.get(session_id) {
        Some(s) if !s.finalize_in_flight && !s.takeover_detected => s,
        _ => return false,
      };

      let sha_match = session
        .last_checkpoint_sha
        .as_deref()
        .is_some_and(|cs| session.last_local_sha == cs);
      if !sha_match {
        return false;
      }
    }

    let session = self.sessions.get_mut(session_id).unwrap();
    session.finalize_in_flight = true;
    session.last_error = None;
    session.status = SessionStatus::Finalizing;
    let api_base_url = session.api_base_url.clone();
    let sid = session.id.clone();
    let session_token = session.session_token.clone();
    let pending_finalize = session.pending_finalize;
    #[allow(dropping_references)]
    drop(session);

    self.persist_sessions().await;
    self.emit_state_change();

    let result = self.do_finalize(&sid, &api_base_url, &session_token).await;

    let session = match self.sessions.get_mut(session_id) {
      Some(s) => s,
      None => return false,
    };
    session.finalize_in_flight = false;

    match result {
      FinalizeResult::Finalized { version_number, .. } => {
        let file_name = session.file_name.clone();
        self.show_notification(
          NotifType::RevisionCreated,
          crate::i18n::t("notification.revisionCreatedTitle"),
          Some(&crate::i18n::t_fmt(
            "notification.revisionCreatedBody",
            &[
              ("fileName", &file_name),
              ("versionNumber", &version_number.to_string()),
            ],
          )),
        );
        self.cleanup_session_internal(session_id, true).await;
        true
      }
      FinalizeResult::NoChanges => {
        self.cleanup_session_internal(session_id, true).await;
        true
      }
      FinalizeResult::TakenOver(message) => {
        self.mark_session_taken_over(session_id, &message).await;
        false
      }
      FinalizeResult::SessionClosed(message) => {
        self.close_remote_session(session_id, &message).await;
        false
      }
      FinalizeResult::Error(message) => {
        let session = self.sessions.get_mut(session_id).unwrap();
        session.last_error = Some(message);
        session.status = SessionStatus::Error;
        let file_name = session.file_name.clone();
        let show_notice = !session.retry_notice_shown;
        session.retry_notice_shown = true;
        self.persist_sessions().await;
        self.emit_state_change();

        if show_notice {
          let body_key = if pending_finalize {
            "notification.finalizeDelayedPreserved"
          } else {
            "notification.finalizeDelayedResumed"
          };
          self.show_notification(
            NotifType::SyncIssues,
            crate::i18n::t("notification.finalizeDelayedTitle"),
            Some(&format!("{file_name} — {}", crate::i18n::t(body_key))),
          );
        }
        false
      }
    }
  }

  async fn do_finalize(
    &self,
    session_id: &str,
    api_base_url: &str,
    session_token: &str,
  ) -> FinalizeResult {
    let url = format!("{api_base_url}/v1/desktop-edit-sessions/{session_id}/finalize");
    let body = serde_json::json!({ "sessionToken": session_token });

    let response = match self
      .http_client
      .post(&url)
      .json(&body)
      .timeout(REMOTE_SAVE_TIMEOUT)
      .send()
      .await
    {
      Ok(r) => r,
      Err(e) => {
        return FinalizeResult::Error(format!(
          "stella desktop could not finalize this edit: {e}"
        ));
      }
    };

    if !response.status().is_success() {
      let status = response.status();
      let error_body: Option<ErrorResponse> = response.json().await.ok();

      if status.as_u16() == 409 {
        if let Some(ref err) = error_body {
          if err.code.as_deref() == Some(TAKEN_OVER_CODE) {
            return FinalizeResult::TakenOver(err.message.clone().unwrap_or_else(
              || crate::i18n::t("notification.takenOverLocalError").to_string(),
            ));
          }
        }
        return FinalizeResult::SessionClosed(
          error_body
            .and_then(|e| e.message)
            .unwrap_or_else(|| "Desktop edit session is already closed.".to_string()),
        );
      }

      return FinalizeResult::Error(error_body.and_then(|e| e.message).unwrap_or_else(
        || "stella desktop could not finalize this edit.".to_string(),
      ));
    }

    match response.json::<FinalizeResponse>().await {
      Ok(FinalizeResponse::Finalized {
        entity_id,
        version_number,
      }) => FinalizeResult::Finalized {
        entity_id,
        version_number,
      },
      Ok(FinalizeResponse::NoChanges) => FinalizeResult::NoChanges,
      Err(e) => FinalizeResult::Error(format!(
        "stella desktop received an invalid finalize response: {e}"
      )),
    }
  }

  // --- Retry loop (called from spawned timer) ---

  pub async fn retry_pending_work(&mut self) {
    self.retry_pending_cleanup().await;

    let session_ids: Vec<String> = self.sessions.keys().cloned().collect();
    for sid in session_ids {
      self.retry_session(&sid).await;
    }
  }

  pub async fn retry_session(&mut self, session_id: &str) {
    if self
      .sessions
      .get(session_id)
      .is_none_or(|s| s.takeover_detected)
    {
      return;
    }

    let checkpoint_ready = self.sync_checkpoint(session_id).await;

    let should_finalize = self
      .sessions
      .get(session_id)
      .is_some_and(|s| s.pending_finalize);

    if should_finalize && checkpoint_ready {
      self.finalize_session(session_id).await;
    }
  }

  // --- File watcher ---

  pub async fn attach_watcher(manager: &Arc<Mutex<Self>>, session_id: &str) {
    let (watch_dir, file_name, sid) = {
      let mut mgr = manager.lock().await;
      let session = match mgr.sessions.get_mut(session_id) {
        Some(s) if !s.takeover_detected => s,
        _ => return,
      };

      let dir = Path::new(&session.file_path)
        .parent()
        .unwrap_or(Path::new("."));
      session.word_lock_seen = has_word_lock_file(dir, &session.file_name).await;

      (
        dir.to_path_buf(),
        session.file_name.clone(),
        session.id.clone(),
      )
    };

    let mgr_for_watcher = Arc::clone(manager);
    let sid_for_watcher = sid.clone();
    let fname_for_watcher = file_name.clone();

    let watcher_result = notify::recommended_watcher(move |res: Result<Event, _>| {
      if let Ok(event) = res {
        match event.kind {
          EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_) => {
            let changed_file = event
              .paths
              .first()
              .and_then(|p| p.file_name())
              .and_then(|n| n.to_str())
              .map(|s| s.to_string());

            let mgr = Arc::clone(&mgr_for_watcher);
            let sid = sid_for_watcher.clone();
            let fname = fname_for_watcher.clone();

            let _ = tokio::runtime::Handle::try_current().map(|handle| {
              handle.spawn(async move {
                handle_filesystem_event(mgr, &sid, changed_file.as_deref(), &fname)
                  .await;
              });
            });
          }
          _ => {}
        }
      }
    });

    let mut mgr = manager.lock().await;
    if let Some(session) = mgr.sessions.get_mut(&sid) {
      match watcher_result {
        Ok(mut w) => {
          let _ = w.watch(&watch_dir, RecursiveMode::NonRecursive);
          session._watcher = Some(w);
        }
        Err(e) => {
          tracing::warn!(error = %e, "failed to create file watcher");
        }
      }
    }
  }

  // --- Internal helpers ---

  async fn mark_session_taken_over(&mut self, session_id: &str, message: &str) {
    let session = match self.sessions.get_mut(session_id) {
      Some(s) => s,
      None => return,
    };

    session.cancel_timers();
    session.last_error = Some(message.to_string());
    session.pending_finalize = false;
    session.retry_notice_shown = false;
    session.status = SessionStatus::Error;
    session.takeover_detected = true;
    let file_name = session.file_name.clone();

    self.persist_sessions().await;
    self.emit_state_change();

    self.show_notification(
      NotifType::SyncIssues,
      crate::i18n::t("notification.takenOverTitle"),
      Some(&crate::i18n::t_fmt(
        "notification.takenOverBody",
        &[("fileName", &file_name)],
      )),
    );
  }

  async fn close_remote_session(&mut self, session_id: &str, message: &str) {
    if let Some(session) = self.sessions.get(session_id) {
      let file_name = session.file_name.clone();
      let has_unsaved = session
        .last_checkpoint_sha
        .as_deref()
        .is_none_or(|cs| session.last_local_sha != cs);

      let body_key = if has_unsaved {
        "notification.sessionClosedUnsaved"
      } else {
        "notification.sessionClosedSaved"
      };
      let body = crate::i18n::t_fmt(body_key, &[("fileName", &file_name)]);

      self.show_notification(NotifType::SyncIssues, message, Some(&body));
    }
    self.cleanup_session_internal(session_id, false).await;
  }

  async fn cleanup_session_internal(
    &mut self,
    session_id: &str,
    remove_local_files: bool,
  ) {
    // Remove token from OS keychain
    crate::keychain::delete_token(session_id);

    if let Some(mut session) = self.sessions.remove(session_id) {
      session.cancel_timers();
      self.session_ids_by_key.remove(&session.key);

      if remove_local_files {
        if let Some(parent) = Path::new(&session.file_path).parent() {
          self
            .schedule_cleanup_path(parent.to_string_lossy().to_string())
            .await;
        }
      }
    }

    self.persist_sessions().await;
    self.emit_state_change();
  }

  async fn schedule_cleanup_path(&mut self, path: String) {
    if self.try_remove_cleanup_path(&path).await {
      return;
    }
    self.cleanup_paths.insert(path);
  }

  async fn try_remove_cleanup_path(&mut self, path: &str) -> bool {
    match tokio::fs::remove_dir_all(path).await {
      Ok(()) => {
        self.cleanup_paths.remove(path);
        true
      }
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
        self.cleanup_paths.remove(path);
        true
      }
      Err(_) => {
        self.cleanup_paths.insert(path.to_string());
        false
      }
    }
  }

  async fn retry_pending_cleanup(&mut self) {
    let active_folders: HashSet<String> = self
      .sessions
      .values()
      .filter_map(|s| {
        Path::new(&s.file_path)
          .parent()
          .map(|p| p.to_string_lossy().to_string())
      })
      .collect();

    let paths: Vec<String> = self.cleanup_paths.iter().cloned().collect();
    let mut changed = false;

    for path in paths {
      if active_folders.contains(&path) {
        self.cleanup_paths.remove(&path);
        changed = true;
        continue;
      }
      if self.try_remove_cleanup_path(&path).await {
        changed = true;
      }
    }

    if changed {
      self.persist_sessions().await;
    }
  }

  /// Spawn an SSE listener for a session if one isn't already running.
  pub fn ensure_sse_listener(
    &mut self,
    manager_arc: &Arc<Mutex<SessionManager>>,
    session_id: &str,
  ) {
    let session = match self.sessions.get_mut(session_id) {
      Some(s) => s,
      None => return,
    };

    // Don't spawn if already active or session is in error state
    if session
      .sse_listener
      .as_ref()
      .is_some_and(|h| !h.is_finished())
      || session.takeover_detected
    {
      return;
    }

    let handle = crate::sse::spawn_sse_listener(
      Arc::clone(manager_arc),
      session_id.to_string(),
      session.api_base_url.clone(),
    );
    session.sse_listener = Some(handle);
  }

  async fn download_docx(&self, url: &str) -> Result<Vec<u8>, String> {
    let response = self
      .http_client
      .get(url)
      .timeout(DOWNLOAD_TIMEOUT)
      .send()
      .await
      .map_err(|e| format!("stella desktop could not download the DOCX draft: {e}"))?;

    if !response.status().is_success() {
      return Err("stella desktop could not download the DOCX draft.".to_string());
    }

    response
      .bytes()
      .await
      .map(|b| b.to_vec())
      .map_err(|e| format!("stella desktop could not read the DOCX download: {e}"))
  }

  async fn write_managed_copy(
    &self,
    folder_name: &str,
    file_name: &str,
    buffer: &[u8],
  ) -> Result<String, String> {
    let session_folder = self.edit_root.join(folder_name);
    tokio::fs::create_dir_all(&session_folder)
      .await
      .map_err(|e| format!("Failed to create editing folder: {e}"))?;

    let file_path = session_folder.join(file_name);
    tokio::fs::write(&file_path, buffer)
      .await
      .map_err(|e| format!("Failed to write DOCX file: {e}"))?;

    Ok(file_path.to_string_lossy().to_string())
  }

  async fn persist_sessions(&self) {
    let persisted: Vec<PersistedDesktopSession> =
      self.sessions.values().map(|s| s.to_persisted()).collect();

    let cleanup: Vec<String> = {
      let mut v: Vec<String> = self.cleanup_paths.iter().cloned().collect();
      v.sort();
      v
    };

    if let Err(e) = session_store::persist_session_store(
      &self.store_path,
      &cleanup,
      &self.linked_account,
      &self.notification_preferences,
      &persisted,
    )
    .await
    {
      tracing::error!(error = %e, "failed to persist session store");
    }
  }

  fn emit_state_change(&self) {
    if let Some(ref handle) = self.app_handle {
      let snapshot = self.get_snapshot();
      let _ = handle.emit("state-changed", &snapshot);

      // Rebuild tray menu to reflect new state
      if let Ok(menu) = crate::tray::build_tray_menu(handle, &snapshot) {
        if let Some(tray) = handle.tray_by_id("main") {
          let _ = tray.set_menu(Some(menu));
        }
      }
    }
  }

  fn show_notification(&self, notif_type: NotifType, title: &str, body: Option<&str>) {
    let enabled = match notif_type {
      NotifType::DocumentReady => self.notification_preferences.document_ready,
      NotifType::RevisionCreated => self.notification_preferences.revision_created,
      NotifType::SyncIssues => self.notification_preferences.sync_issues,
    };

    if !enabled {
      return;
    }

    if let Some(ref handle) = self.app_handle {
      let mut builder =
        tauri_plugin_notification::NotificationExt::notification(handle)
          .builder()
          .title(title);
      if let Some(b) = body {
        builder = builder.body(b);
      }
      match builder.show() {
        Ok(()) => tracing::info!(title, "notification shown"),
        Err(e) => tracing::warn!(title, error = %e, "notification failed"),
      }
    } else {
      tracing::warn!(title, "notification skipped: no app_handle");
    }
  }

  fn get_diagnostics_text(&self) -> String {
    let diagnostics = serde_json::json!({
        "generatedAt": chrono_now(),
        "platform": {
            "arch": std::env::consts::ARCH,
            "os": std::env::consts::OS,
            "framework": "tauri",
        },
        "app": {
            "bridgePort": self.bridge_port,
            "runningSince": self.running_since,
            "supportRoot": self.support_root.to_string_lossy(),
            "temporaryWorkingCopiesRoot": self.edit_root.to_string_lossy(),
        },
        "linkedAccount": self.linked_account,
        "storeLoadIssue": self.store_load_issue.as_ref().map(|i| format!("{i:?}")),
        "notificationPreferences": self.notification_preferences,
        "update": self.update,
        "sessions": self.sessions.values().map(|s| {
            serde_json::json!({
                "hasLocalCopy": true,
                "id": s.id,
                "lastCheckpointAt": s.last_checkpoint_at,
                "lastError": s.last_error,
                "pendingFinalize": s.pending_finalize,
                "status": s.status,
                "takeoverDetected": s.takeover_detected,
            })
        }).collect::<Vec<_>>(),
        "cleanupPathsQueued": self.cleanup_paths.len(),
    });

    serde_json::to_string_pretty(&diagnostics).unwrap_or_default()
  }
}

// --- Helper types ---

enum CheckpointResult {
  Unchanged,
  Uploaded {
    next_sha: String,
    checkpointed_at: String,
    rotated_token: Option<String>,
  },
  TakenOver(String),
  SessionClosed(String),
  Error(String),
}

#[allow(dead_code)]
enum FinalizeResult {
  Finalized {
    entity_id: String,
    version_number: i64,
  },
  NoChanges,
  TakenOver(String),
  SessionClosed(String),
  Error(String),
}

enum NotifType {
  DocumentReady,
  RevisionCreated,
  SyncIssues,
}

// --- File system event handler (called from watcher callback) ---

async fn handle_filesystem_event(
  manager: Arc<Mutex<SessionManager>>,
  session_id: &str,
  changed_file: Option<&str>,
  managed_file_name: &str,
) {
  let is_managed = changed_file.is_none() || changed_file == Some(managed_file_name);

  let (should_schedule_checkpoint, file_path, file_name) = {
    let mgr = manager.lock().await;
    let session = match mgr.sessions.get(session_id) {
      Some(s) if !s.takeover_detected => s,
      _ => return,
    };
    (
      is_managed,
      session.file_path.clone(),
      session.file_name.clone(),
    )
  };

  let dir = Path::new(&file_path).parent().unwrap_or(Path::new("."));
  let has_lock = has_word_lock_file(dir, &file_name).await;

  {
    let mut mgr = manager.lock().await;
    let session = match mgr.sessions.get_mut(session_id) {
      Some(s) if !s.takeover_detected => s,
      _ => return,
    };

    if has_lock {
      if let Some(handle) = session.auto_finalize_timer.take() {
        handle.abort();
      }
      session.word_lock_seen = true;

      // Start lock poll if not already running
      if session.lock_poll_timer.is_none() {
        let mgr_clone = Arc::clone(&manager);
        let sid = session_id.to_string();
        session.lock_poll_timer = Some(tokio::spawn(async move {
          lock_poll_loop(mgr_clone, sid).await;
        }));
      }
      return;
    }

    if session.word_lock_seen && !session.pending_finalize {
      session.word_lock_seen = false;
      if let Some(handle) = session.lock_poll_timer.take() {
        handle.abort();
      }

      // Schedule auto-finalize
      let mgr_clone = Arc::clone(&manager);
      let sid = session_id.to_string();
      session.auto_finalize_timer = Some(tokio::spawn(async move {
        tokio::time::sleep(AUTO_FINALIZE_DELAY).await;
        let mut mgr = mgr_clone.lock().await;
        let should_finish = mgr.sessions.get(&sid).is_some_and(|s| {
          !s.pending_finalize && !s.takeover_detected && !s.word_lock_seen
        });
        if should_finish {
          mgr.finish_session(&sid);
          let _ = mgr.persist_sessions().await;
          mgr.retry_session(&sid).await;
        }
      }));
    }
  }

  if should_schedule_checkpoint {
    // Schedule debounced checkpoint
    let mgr_clone = Arc::clone(&manager);
    let sid = session_id.to_string();

    {
      let mut mgr = manager.lock().await;
      if let Some(session) = mgr.sessions.get_mut(&sid) {
        if let Some(handle) = session.checkpoint_timer.take() {
          handle.abort();
        }
        let mgr_for_timer = Arc::clone(&mgr_clone);
        let sid_for_timer = sid.clone();
        session.checkpoint_timer = Some(tokio::spawn(async move {
          tokio::time::sleep(CHECKPOINT_DEBOUNCE).await;
          let mut mgr = mgr_for_timer.lock().await;
          mgr.retry_session(&sid_for_timer).await;
        }));
      }
    }
  }
}

async fn lock_poll_loop(manager: Arc<Mutex<SessionManager>>, session_id: String) {
  let mut interval = tokio::time::interval(LOCK_POLL_INTERVAL);
  interval.tick().await; // skip first immediate tick

  loop {
    interval.tick().await;

    let (file_path, file_name) = {
      let mgr = manager.lock().await;
      match mgr.sessions.get(&session_id) {
        Some(s) if s.word_lock_seen && !s.pending_finalize => {
          (s.file_path.clone(), s.file_name.clone())
        }
        _ => return,
      }
    };

    let dir = Path::new(&file_path).parent().unwrap_or(Path::new("."));
    let has_lock = has_word_lock_file(dir, &file_name).await;

    if !has_lock {
      let mut mgr = manager.lock().await;
      if let Some(session) = mgr.sessions.get_mut(&session_id) {
        session.word_lock_seen = false;
        if let Some(handle) = session.lock_poll_timer.take() {
          handle.abort();
        }

        // Schedule auto-finalize
        let mgr_clone = Arc::clone(&manager);
        let sid = session_id.clone();
        session.auto_finalize_timer = Some(tokio::spawn(async move {
          tokio::time::sleep(AUTO_FINALIZE_DELAY).await;
          let mut m = mgr_clone.lock().await;
          let should_finish = m.sessions.get(&sid).is_some_and(|s| {
            !s.pending_finalize && !s.takeover_detected && !s.word_lock_seen
          });
          if should_finish {
            m.finish_session(&sid);
            m.persist_sessions().await;
            m.retry_session(&sid).await;
          }
        }));
      }
      return;
    }
  }
}

// --- Retry loop (spawned as background task) ---

pub async fn run_retry_loop(manager: Arc<Mutex<SessionManager>>) {
  let mut interval = tokio::time::interval(RETRY_INTERVAL);
  loop {
    interval.tick().await;
    let mut mgr = manager.lock().await;
    mgr.retry_pending_work().await;
  }
}

/// Download a DOCX file without holding the session manager lock.
/// Used by the bridge to avoid blocking other operations during network I/O.
pub async fn download_docx_standalone(
  client: &reqwest::Client,
  url: &str,
) -> Result<Vec<u8>, String> {
  let response = client
    .get(url)
    .timeout(DOWNLOAD_TIMEOUT)
    .send()
    .await
    .map_err(|e| format!("stella desktop could not download the DOCX draft: {e}"))?;

  if !response.status().is_success() {
    return Err("stella desktop could not download the DOCX draft.".to_string());
  }

  response
    .bytes()
    .await
    .map(|b| b.to_vec())
    .map_err(|e| format!("stella desktop could not read the DOCX download: {e}"))
}

// --- Platform helpers ---

fn open_path_native(path: &str) -> Result<(), String> {
  opener::open(path).map_err(|e| format!("stella desktop could not open the file: {e}"))
}

fn reveal_in_folder(path: &str) {
  #[cfg(target_os = "macos")]
  {
    let _ = std::process::Command::new("open")
      .args(["-R", path])
      .spawn();
  }
  #[cfg(target_os = "windows")]
  {
    let _ = std::process::Command::new("explorer")
      .args(["/select,", path])
      .spawn();
  }
  #[cfg(target_os = "linux")]
  {
    if let Some(parent) = Path::new(path).parent() {
      let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
    }
  }
}

fn open_url(url: &str) -> bool {
  opener::open(url).is_ok()
}

/// Percent-encode a string for use in URL query/hash parameters.
fn urlencode(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for byte in s.bytes() {
    match byte {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
        out.push(byte as char);
      }
      _ => {
        out.push_str(&format!("%{byte:02X}"));
      }
    }
  }
  out
}

async fn show_takeover_dialog(
  handle: &AppHandle,
  requested_by: &str,
  file_name: &str,
) -> bool {
  // Pass dynamic data via URL hash — the static HTML reads it via JS.
  let hash = format!(
    "requester={}&fileName={}",
    urlencode(requested_by),
    urlencode(file_name),
  );

  let window = tauri::WebviewWindowBuilder::new(
    handle,
    "takeover-dialog",
    tauri::WebviewUrl::App(format!("takeover-dialog.html#{hash}").into()),
  )
  .title("stella desktop")
  .inner_size(400.0, 260.0)
  .resizable(false)
  .center()
  .always_on_top(true)
  .build();

  match window {
    Ok(w) => {
      let label = w.label().to_string();

      // Register a per-dialog response channel
      let rx = register_takeover_dialog(&label);

      // Wait for the dialog button click (or window close = deny)
      match rx.await {
        Ok(approved) => approved,
        Err(_) => false, // sender dropped (window closed without clicking)
      }
    }
    Err(e) => {
      tracing::warn!(error = %e, "failed to open takeover dialog");
      false
    }
  }
}

fn chrono_now() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn is_word_lock_file_for_matches_replacement_and_prefixed_owner_files() {
    assert!(is_word_lock_file_for("~$cument.docx", "document.docx"));
    assert!(is_word_lock_file_for("~$document.docx", "document.docx"));
    assert!(!is_word_lock_file_for("document.docx", "document.docx"));
    assert!(!is_word_lock_file_for("~$brief.docx", "~$brief.docx"));
  }
}
