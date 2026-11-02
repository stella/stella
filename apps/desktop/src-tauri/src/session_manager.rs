use futures_util::{StreamExt, future::join_all};
use notify::{
  Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
  event::{AccessKind, AccessMode},
};
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::config;
pub use crate::config::normalize_api_base_url;
use crate::diagnostics::{
  DiagnosticNotificationPreferences, DiagnosticSession, DiagnosticStoreLoadIssue,
  DiagnosticUpdate, DiagnosticsInput, render_diagnostics,
};
use crate::http_client::DesktopHttpClient;
use crate::session_store::{self, PersistedDesktopSession, StoreLoadIssue};
use crate::types::*;
use zip::ZipArchive;

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
  drop(guard);
  rx
}

/// Called by the takeover dialog's Allow/Deny buttons via invoke.
pub fn set_takeover_response(label: &str, approved: bool) {
  let mut guard = TAKEOVER_SENDERS.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(ref mut map) = *guard
    && let Some(tx) = map.remove(label)
  {
    let _ = tx.send(approved);
  }
}

const CHECKPOINT_DEBOUNCE: Duration = Duration::from_millis(1200);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20);
const REMOTE_SAVE_TIMEOUT: Duration = Duration::from_secs(60);
const RETRY_INTERVAL: Duration = Duration::from_secs(15);
const KEYCHAIN_RESTORE_TIMEOUT: Duration = Duration::from_secs(10);
const OPEN_PROBE_INTERVAL: Duration = Duration::from_secs(1);
const OPEN_PROBE_IDLE_INTERVAL: Duration = Duration::from_secs(15);
const CLOSED_RECHECK_COUNT: u8 = 5;
const TAKEN_OVER_CODE: &str = "desktop_edit_session_taken_over";
const LIBRE_OFFICE_LOCK_PREFIX: &str = ".~lock.";
const LIBRE_OFFICE_LOCK_SUFFIX: &str = "#";
const MICROSOFT_OFFICE_LOCK_PREFIX: &str = "~$";
const SUPPORT_EMAIL: &str = "hello@stll.app";
const CONTENT_TYPES_ENTRY: &str = "[Content_Types].xml";
const MAX_OFFICE_DOWNLOAD_BYTES: u64 = 50 * 1024 * 1024;
const ZIP_LOCAL_FILE_HEADER_MAGIC: &[u8] = b"PK\x03\x04";
const GENERIC_OFFICE_DOWNLOAD_MIME_TYPES: &[&str] =
  &["application/octet-stream", "binary/octet-stream"];

// Internal session with runtime-only fields
struct DesktopSession {
  // Persisted fields
  api_base_url: String,
  base_version_number: i64,
  entity_id: String,
  file_type: DesktopEditFileType,
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
  generation: uuid::Uuid,
  last_observed_file: Option<FileFingerprint>,
  changed_during_remote_save: bool,
  checkpoint_in_flight: bool,
  finalize_in_flight: bool,
  local_open_seen: bool,
  closed_recheck_count: u8,
  retry_notice_shown: bool,
  watcher: Option<RecommendedWatcher>,
  checkpoint_timer: Option<JoinHandle<()>>,
  open_probe_timer: Option<JoinHandle<()>>,
  sse_listener: Option<JoinHandle<()>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileFingerprint {
  size: u64,
  modified: std::time::SystemTime,
  identity: u64,
}

trait SessionFileSystem: Send + Sync {
  fn fingerprint(&self, path: &Path) -> std::io::Result<FileFingerprint>;
  fn read<'a>(
    &'a self,
    path: &'a Path,
  ) -> futures_util::future::BoxFuture<'a, std::io::Result<Vec<u8>>>;
}

struct LocalSessionFileSystem;

impl SessionFileSystem for LocalSessionFileSystem {
  fn fingerprint(&self, path: &Path) -> std::io::Result<FileFingerprint> {
    let metadata = std::fs::metadata(path)?;
    #[cfg(unix)]
    let identity = {
      use std::os::unix::fs::MetadataExt;
      metadata.ino()
    };
    #[cfg(not(unix))]
    let identity = 0;
    Ok(FileFingerprint {
      size: metadata.len(),
      modified: metadata.modified()?,
      identity,
    })
  }

  fn read<'a>(
    &'a self,
    path: &'a Path,
  ) -> futures_util::future::BoxFuture<'a, std::io::Result<Vec<u8>>> {
    Box::pin(tokio::fs::read(path))
  }
}

#[cfg(test)]
#[derive(Default)]
struct SessionCosts {
  writes: std::sync::atomic::AtomicUsize,
  emits: std::sync::atomic::AtomicUsize,
}

struct SyncCheckpointInput {
  generation: uuid::Uuid,
  session_id: String,
  file_type: DesktopEditFileType,
  file_path: String,
  api_base_url: String,
  session_token: String,
  file_name: String,
  last_checkpoint_sha: Option<String>,
  fingerprint: FileFingerprint,
  last_local_sha: String,
  pending_finalize: bool,
}

impl DesktopSession {
  fn to_persisted(&self) -> PersistedDesktopSession {
    PersistedDesktopSession {
      api_base_url: self.api_base_url.clone(),
      base_version_number: self.base_version_number,
      entity_id: self.entity_id.clone(),
      file_type: self.file_type,
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
      file_type: self.file_type,
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
    if let Some(handle) = self.open_probe_timer.take() {
      handle.abort();
    }
    if let Some(handle) = self.sse_listener.take() {
      handle.abort();
    }
  }
}

pub struct SessionManager {
  file_system: Arc<dyn SessionFileSystem>,
  #[cfg(test)]
  costs: Arc<SessionCosts>,
  sessions: HashMap<String, DesktopSession>,
  session_ids_by_key: HashMap<String, String>,
  unconfirmed_sessions: HashMap<String, PersistedDesktopSession>,
  cleanup_paths: HashSet<String>,
  linked_account: Option<LinkedAccountSnapshot>,
  linked_account_web_origin: Option<String>,
  selected_self_host_connection: Option<TrustedSelfHostConnection>,
  notification_preferences: DesktopNotificationPreferences,
  trusted_self_host_connections: Vec<TrustedSelfHostConnection>,
  update: DesktopUpdateSnapshot,
  running_since: String,
  bridge_port: u16,
  store_path: PathBuf,
  edit_root: PathBuf,
  support_root: PathBuf,
  store_load_issue: Option<StoreLoadIssue>,
  http_client: DesktopHttpClient,
  app_handle: Option<AppHandle>,
}

fn session_key(workspace_id: &str, entity_id: &str, property_id: &str) -> String {
  format!("{workspace_id}:{entity_id}:{property_id}")
}

fn has_file_type_extension(name: &str, file_type: DesktopEditFileType) -> bool {
  Path::new(name)
    .extension()
    .and_then(|extension| extension.to_str())
    .is_some_and(|extension| {
      extension.eq_ignore_ascii_case(file_type.extension().trim_start_matches('.'))
    })
}

fn sanitize_file_name(name: &str, file_type: DesktopEditFileType) -> String {
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
    return file_type.default_file_name().to_string();
  }

  if has_file_type_extension(trimmed, file_type) {
    trimmed.to_string()
  } else {
    format!("{trimmed}{}", file_type.extension())
  }
}

fn oversized_office_download_error() -> String {
  "stella desktop refused an oversized Office file download.".to_string()
}

fn oversized_office_download(overflow: std::num::TryFromIntError) -> String {
  crate::logging::log_cause(&overflow, "Office download size does not fit");
  oversized_office_download_error()
}

fn non_office_download_body_error(file_type: DesktopEditFileType) -> String {
  format!(
    "stella desktop refused a non-{} download body.",
    file_type.extension().trim_start_matches('.')
  )
}

fn is_allowed_download_content_type(
  file_type: DesktopEditFileType,
  content_type: &str,
) -> bool {
  let media_type = content_type.split(';').next().unwrap_or_default().trim();

  media_type.eq_ignore_ascii_case(file_type.mime_type())
    || GENERIC_OFFICE_DOWNLOAD_MIME_TYPES
      .iter()
      .any(|generic| media_type.eq_ignore_ascii_case(generic))
}

fn validate_office_download_response(
  file_type: DesktopEditFileType,
  response: &reqwest::Response,
) -> Result<(), String> {
  if let Some(content_length) = response.headers().get(CONTENT_LENGTH) {
    let size = content_length
      .to_str()
      .ok()
      .and_then(|value| value.parse::<u64>().ok())
      .ok_or_else(|| {
        "stella desktop received an invalid Office file download size.".to_string()
      })?;

    if size > MAX_OFFICE_DOWNLOAD_BYTES {
      return Err(oversized_office_download_error());
    }
  }

  let Some(content_type) = response.headers().get(CONTENT_TYPE) else {
    return Ok(());
  };

  let content_type =
    content_type
      .to_str()
      .map_err(crate::logging::with_cause_logged(
        "stella desktop received an invalid Office file content type.",
      ))?;

  if is_allowed_download_content_type(file_type, content_type) {
    return Ok(());
  }

  Err("stella desktop refused a non-Office file download response.".to_string())
}

async fn read_office_download_bytes(
  response: reqwest::Response,
) -> Result<Vec<u8>, String> {
  let mut bytes = Vec::new();
  let mut stream = response.bytes_stream();

  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(|e| {
      format!("stella desktop could not read the Office file download: {e}")
    })?;
    let current_size = u64::try_from(bytes.len()).map_err(oversized_office_download)?;
    let chunk_size = u64::try_from(chunk.len()).map_err(oversized_office_download)?;
    let next_size = current_size
      .checked_add(chunk_size)
      .ok_or_else(oversized_office_download_error)?;

    if next_size > MAX_OFFICE_DOWNLOAD_BYTES {
      return Err(oversized_office_download_error());
    }

    bytes.extend_from_slice(&chunk);
  }

  Ok(bytes)
}

fn validate_office_download_bytes(
  file_type: DesktopEditFileType,
  bytes: &[u8],
) -> Result<(), String> {
  let size = u64::try_from(bytes.len()).map_err(oversized_office_download)?;
  if size > MAX_OFFICE_DOWNLOAD_BYTES {
    return Err(oversized_office_download_error());
  }

  if !bytes.starts_with(ZIP_LOCAL_FILE_HEADER_MAGIC) {
    return Err(non_office_download_body_error(file_type));
  }

  let archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| {
    crate::logging::log_cause(&error, "Office download is not a zip archive");
    non_office_download_body_error(file_type)
  })?;
  let has_content_types = archive.index_for_name(CONTENT_TYPES_ENTRY).is_some();
  let required_entry = file_type.main_part_path();

  if has_content_types && archive.index_for_name(required_entry).is_some() {
    return Ok(());
  }

  Err(non_office_download_body_error(file_type))
}

async fn align_managed_copy_file_name(
  file_path: &str,
  file_name: &str,
) -> Result<String, String> {
  let path = Path::new(file_path);
  let current_name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or_default();

  if current_name == file_name {
    return Ok(file_path.to_string());
  }

  let parent = path.parent().ok_or_else(|| {
    "stella desktop could not resolve the managed Office file folder.".to_string()
  })?;
  let aligned_path = parent.join(file_name);

  if tokio::fs::try_exists(&aligned_path).await.map_err(|e| {
    format!("stella desktop could not inspect the managed Office file: {e}")
  })? {
    return Err(
      "stella desktop could not align the managed Office file name.".to_string(),
    );
  }

  crate::local_store::rename_private(path, &aligned_path).map_err(|e| {
    format!("stella desktop could not rename the managed Office file: {e}")
  })?;

  Ok(aligned_path.to_string_lossy().to_string())
}

/// Reduces a string to a single safe path segment so callers can't widen the
/// scope of a `Path::join` by accident. Operates on the raw string (no
/// `Path::new`) so the result is identical on Linux, macOS and Windows even
/// when the input contains either separator. Replaces every ASCII control
/// character so a sneaky `\u{1}` or DEL can't slip through.
fn sanitize_path_segment(value: &str) -> String {
  let replaced = value
    .replace(
      |c: char| {
        c.is_ascii_control()
          || ['/', '"', '\\', '<', '>', '|', '*', '?', ':'].contains(&c)
      },
      "_",
    )
    .replace("..", "__");

  let trimmed = replaced.trim_matches(|c: char| c == '.' || c == ' ');
  if trimmed.is_empty() {
    "session".to_string()
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
  let Some(remote) = remote_checkpoint_at else {
    return false;
  };
  let Some(local) = local_checkpoint_at else {
    return true;
  };
  remote > local
}

fn is_microsoft_office_lock_file_for(candidate: &str, file_name: &str) -> bool {
  let Some(candidate_suffix) = candidate.strip_prefix(MICROSOFT_OFFICE_LOCK_PREFIX)
  else {
    return false;
  };

  if candidate_suffix == file_name {
    return true;
  }

  if file_name.starts_with(MICROSOFT_OFFICE_LOCK_PREFIX) {
    return false;
  }

  let mut file_name_chars = file_name.chars();
  file_name_chars.next();
  file_name_chars.next();

  candidate_suffix == file_name_chars.as_str()
}

fn is_libre_office_lock_file_for(candidate: &str, file_name: &str) -> bool {
  candidate
    .strip_prefix(LIBRE_OFFICE_LOCK_PREFIX)
    .and_then(|name| name.strip_suffix(LIBRE_OFFICE_LOCK_SUFFIX))
    .is_some_and(|name| name == file_name)
}

fn is_temporary_lock_file_for(candidate: &str, file_name: &str) -> bool {
  is_microsoft_office_lock_file_for(candidate, file_name)
    || is_libre_office_lock_file_for(candidate, file_name)
}

async fn has_temporary_lock_file(dir: &Path, file_name: &str) -> bool {
  match tokio::fs::read_dir(dir).await {
    Ok(mut entries) => {
      while let Ok(Some(entry)) = entries.next_entry().await {
        if is_temporary_lock_file_for(&entry.file_name().to_string_lossy(), file_name) {
          return true;
        }
      }
      false
    }
    Err(_) => false,
  }
}

#[cfg(target_os = "windows")]
fn append_probe_reports_locked(file_path: &Path) -> bool {
  match crate::local_store::open_private(
    crate::local_store::OpenMode::AppendExisting,
    file_path,
  ) {
    Ok(_) => false,
    Err(e) => matches!(
      e.kind(),
      std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
    ),
  }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn lsof_reports_open(file_path: &Path) -> bool {
  match Command::new("lsof").arg("-t").arg(file_path).output().await {
    Ok(output) if output.status.success() => !output.stdout.is_empty(),
    Ok(output) => !output.stdout.is_empty(),
    Err(_) => false,
  }
}

async fn local_file_appears_open(file_path: &Path, file_name: &str) -> bool {
  let dir = file_path.parent().unwrap_or(Path::new("."));

  if has_temporary_lock_file(dir, file_name).await {
    return true;
  }

  #[cfg(target_os = "windows")]
  if append_probe_reports_locked(file_path) {
    return true;
  }

  #[cfg(any(target_os = "macos", target_os = "linux"))]
  {
    lsof_reports_open(file_path).await
  }

  #[cfg(not(any(target_os = "macos", target_os = "linux")))]
  {
    false
  }
}

impl SessionManager {
  pub fn new() -> Self {
    let data_dir = dirs::data_dir()
      .unwrap_or_else(|| PathBuf::from("."))
      .join(config::APP_DATA_DIR_NAME);

    let bridge_port = config::resolve_bridge_port();

    Self {
      file_system: Arc::new(LocalSessionFileSystem),
      #[cfg(test)]
      costs: Arc::new(SessionCosts::default()),
      sessions: HashMap::new(),
      session_ids_by_key: HashMap::new(),
      unconfirmed_sessions: HashMap::new(),
      cleanup_paths: HashSet::new(),
      linked_account: None,
      linked_account_web_origin: None,
      selected_self_host_connection: None,
      notification_preferences: DesktopNotificationPreferences::default(),
      trusted_self_host_connections: Vec::new(),
      update: DesktopUpdateSnapshot::default(),
      running_since: chrono_now(),
      bridge_port,
      store_path: data_dir.join("desktop-edit-sessions.json"),
      edit_root: data_dir.join("editing"),
      support_root: data_dir.clone(),
      store_load_issue: None,
      http_client: DesktopHttpClient::new(Default::default())
        .expect("desktop HTTP client initialization failed"),
      app_handle: None,
    }
  }

  pub fn set_app_handle(&mut self, handle: AppHandle) {
    self.app_handle = Some(handle);
  }

  pub async fn initialize(&mut self) {
    let store = session_store::load_session_store(&self.store_path).await;

    // Older stores record only the remembered web origin. Restore its pair
    // only when unique; an ambiguous API selection needs explicit reconnection.
    self.selected_self_host_connection =
      store.selected_self_host_connection.or_else(|| {
        let origin = store.linked_account_web_origin.as_deref()?;
        let mut matches = store
          .trusted_self_host_connections
          .iter()
          .filter(|connection| connection.web_origin == origin);
        let selected = matches.next()?;
        if matches.next().is_some() {
          return None;
        }
        Some(selected.clone())
      });
    self.linked_account = store.linked_account;
    self.linked_account_web_origin = store.linked_account_web_origin;
    if let Some(prefs) = store.notification_preferences {
      self.notification_preferences = prefs;
    }
    self.trusted_self_host_connections = store.trusted_self_host_connections;
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

    self.unconfirmed_sessions.clear();

    let persisted_sessions: Vec<PersistedDesktopSession> = store
      .sessions
      .into_iter()
      .filter(|persisted| Path::new(&persisted.file_path).exists())
      .collect();
    let restored_tokens = join_all(persisted_sessions.iter().map(|persisted| async {
      (
        persisted.id.clone(),
        crate::keychain::get_token_with_timeout(
          &persisted.id,
          KEYCHAIN_RESTORE_TIMEOUT,
        )
        .await,
      )
    }))
    .await;
    let mut token_restore_unavailable = false;

    for (persisted, (_, restored_token)) in
      persisted_sessions.into_iter().zip(restored_tokens)
    {
      // Token lives in OS keychain. A confirmed missing token prunes the
      // session, but an inconclusive keychain read must retain the persisted
      // metadata for a later retry.
      let session_token = match restored_token {
        Ok(Some(token)) => token,
        Ok(None) => {
          tracing::warn!(
              session_id = %persisted.id,
              "session token missing from keychain, skipping restore"
          );
          continue;
        }
        Err(crate::keychain::KeychainReadUnavailable) => {
          token_restore_unavailable = true;
          tracing::warn!(
              session_id = %persisted.id,
              "session token could not be confirmed, retaining persisted session for retry"
          );
          self
            .unconfirmed_sessions
            .insert(persisted.id.clone(), persisted);
          continue;
        }
      };

      let session = DesktopSession {
        api_base_url: persisted.api_base_url,
        base_version_number: persisted.base_version_number,
        entity_id: persisted.entity_id,
        file_type: persisted.file_type,
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
        generation: uuid::Uuid::new_v4(),
        last_observed_file: None,
        changed_during_remote_save: false,
        checkpoint_in_flight: false,
        finalize_in_flight: false,
        local_open_seen: false,
        closed_recheck_count: 0,
        retry_notice_shown: false,
        watcher: None,
        checkpoint_timer: None,
        open_probe_timer: None,
        sse_listener: None,
      };

      let key = session.key.clone();
      let id = session.id.clone();
      self.unconfirmed_sessions.remove(&id);
      self.sessions.insert(id.clone(), session);
      self.session_ids_by_key.insert(key, id);
    }

    if token_restore_unavailable {
      tracing::warn!(
        "session store persistence skipped because one or more keychain reads were inconclusive"
      );
      return;
    }
    self.retry_pending_cleanup().await;
    self.persist_sessions().await;
  }

  /// Returns session IDs that need watchers attached (called after initialize).
  pub fn session_ids_needing_watchers(&self) -> Vec<String> {
    self
      .sessions
      .values()
      .filter(|s| !s.takeover_detected && s.watcher.is_none())
      .map(|s| s.id.clone())
      .collect()
  }

  pub fn get_snapshot(&self) -> AppSnapshot {
    let mut sessions: Vec<SessionSnapshot> =
      self.sessions.values().map(|s| s.to_snapshot()).collect();
    sessions.sort_by(|a, b| a.file_name.cmp(&b.file_name));

    AppSnapshot {
      bridge_port: self.bridge_port,
      bridge_version: crate::types::BRIDGE_VERSION,
      capabilities: crate::types::BRIDGE_CAPABILITIES
        .iter()
        .map(|s| (*s).to_string())
        .collect(),
      notification_preferences: self.notification_preferences.clone(),
      running_since: self.running_since.clone(),
      sessions,
      trusted_self_host_connections: self.trusted_self_host_connections.clone(),
      update: self.update.clone(),
    }
  }

  /// Resolve an exact local edit path. The activity matcher accepts its opaque
  /// matter ID only when it belongs to the current caller's candidate set.
  pub(crate) fn activity_matter_for_document(&self, document: &str) -> Option<String> {
    let session = self
      .sessions
      .values()
      .find(|session| session.file_path == document)?;
    self.linked_account.as_ref()?;
    Some(session.workspace_id.clone())
  }

  /// Expose the HTTP client so callers can download outside the lock.
  pub fn http_client(&self) -> &DesktopHttpClient {
    &self.http_client
  }

  pub fn remote_status_probe_details(
    &self,
    session_id: &str,
  ) -> Option<(DesktopHttpClient, String, String)> {
    self.sessions.get(session_id).map(|session| {
      (
        self.http_client.clone(),
        session.api_base_url.clone(),
        session.session_token.clone(),
      )
    })
  }

  pub async fn open_file(
    &mut self,
    request: OpenFileRequest,
    prefetched_buffer: Vec<u8>,
  ) -> Result<OpenFileResponse, String> {
    let key = session_key(
      &request.workspace_id,
      &request.entity_id,
      &request.property_id,
    );
    self
      .sync_linked_account(request.linked_account.as_ref())
      .await?;

    let remote = &request.remote_session;
    let file_type = remote.file_type;
    let managed_file_name = sanitize_file_name(&remote.file_name, file_type);

    // Check for reusable existing session
    let existing_id = self.session_ids_by_key.get(&key).cloned();
    let can_reuse = if let Some(ref eid) = existing_id {
      if let Some(existing) = self.sessions.get(eid) {
        existing.id == remote.session_id
          && existing.file_type == file_type
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
      let file_path = {
        let existing = self.sessions.get(&eid).unwrap();
        align_managed_copy_file_name(&existing.file_path, &managed_file_name).await?
      };

      // Update keychain with the (potentially refreshed) token
      if let Err(e) = crate::keychain::store_token(&eid, &remote.session_token) {
        tracing::error!(error = %e, "failed to update session token in keychain");
      }

      // Update session fields, then extract what we need before dropping the borrow
      let (file_path, session_id, file_name) = {
        let session = self.sessions.get_mut(&eid).unwrap();
        session.generation = uuid::Uuid::new_v4();
        session.checkpoint_in_flight = false;
        session.finalize_in_flight = false;
        session.api_base_url = normalize_api_base_url(&request.api_base_url);
        session.base_version_number = remote.base_version_number;
        session.file_type = file_type;
        session.file_name = managed_file_name;
        session.file_path = file_path;
        session.last_checkpoint_at = remote.last_checkpoint_at.clone();
        session.last_error = None;
        session.local_open_seen = false;
        session.closed_recheck_count = 0;
        session.changed_during_remote_save = false;
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

      return Ok(OpenFileResponse {
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
    let buffer = prefetched_buffer;
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
      file_type,
      file_name: managed_file_name,
      generation: uuid::Uuid::new_v4(),
      last_observed_file: self.file_system.fingerprint(Path::new(&file_path)).ok(),
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
      changed_during_remote_save: false,
      checkpoint_in_flight: false,
      finalize_in_flight: false,
      local_open_seen: false,
      closed_recheck_count: 0,
      retry_notice_shown: false,
      watcher: None,
      checkpoint_timer: None,
      open_probe_timer: None,
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

    self.unconfirmed_sessions.remove(&session_id);
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

    Ok(OpenFileResponse {
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

  fn finish_confirmed_closed_session(&mut self, session_id: &str) -> bool {
    let confirmed = self.sessions.get(session_id).is_some_and(|session| {
      session.local_open_seen
        && session.closed_recheck_count >= CLOSED_RECHECK_COUNT
        && !session.pending_finalize
        && !session.checkpoint_in_flight
        && !session.finalize_in_flight
        && !session.takeover_detected
    });
    confirmed && self.finish_session(session_id)
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

  pub async fn link_account(
    &mut self,
    linked_account: LinkedAccountSnapshot,
    web_origin: Option<String>,
  ) -> Result<(), String> {
    let previous_account = self.linked_account.replace(linked_account);
    let previous_web_origin =
      std::mem::replace(&mut self.linked_account_web_origin, web_origin);
    if let Err(error) = self.persist_sessions_result().await {
      self.linked_account = previous_account;
      self.linked_account_web_origin = previous_web_origin;
      return Err(error);
    }
    self.emit_state_change();
    Ok(())
  }

  async fn sync_linked_account(
    &mut self,
    linked_account: Option<&LinkedAccountSnapshot>,
  ) -> Result<(), String> {
    let Some(linked_account) = linked_account else {
      return Ok(());
    };
    let changed = self.linked_account.as_ref().is_none_or(|current| {
      current.email != linked_account.email
        || current.name != linked_account.name
        || current.verified_at != linked_account.verified_at
    });
    if !changed {
      return Ok(());
    }

    self
      .link_account(
        linked_account.clone(),
        self.linked_account_web_origin.clone(),
      )
      .await
  }

  pub fn linked_self_host_origin(&self) -> Option<&str> {
    self.linked_account.as_ref()?;
    let web_origin = self.linked_account_web_origin.as_deref()?;
    self
      .is_trusted_self_host_origin(web_origin)
      .then_some(web_origin)
  }

  pub fn selected_self_host_connection(&self) -> Option<&TrustedSelfHostConnection> {
    let selected = self.selected_self_host_connection.as_ref()?;
    self
      .is_trusted_self_host_connection(&selected.web_origin, &selected.api_base_url)
      .then_some(selected)
  }

  pub fn is_trusted_self_host_origin(&self, origin: &str) -> bool {
    self
      .trusted_self_host_connections
      .iter()
      .any(|connection| connection.web_origin == origin)
  }

  pub fn is_trusted_self_host_api_base_url(&self, api_base_url: &str) -> bool {
    // Approval stores the API via the full self-host normalizer, so the lookup
    // must canonicalize the same way (default ports, host case) or a valid
    // connection reads back as untrusted.
    let Ok(normalized_api_base_url) =
      config::normalize_self_host_api_base_url(api_base_url)
    else {
      return false;
    };
    self
      .trusted_self_host_connections
      .iter()
      .any(|connection| connection.api_base_url == normalized_api_base_url)
  }

  pub fn trusted_self_host_web_origin(&self, api_base_url: &str) -> Option<String> {
    let normalized_api_base_url =
      config::normalize_self_host_api_base_url(api_base_url).ok()?;
    self
      .trusted_self_host_connections
      .iter()
      .find(|connection| connection.api_base_url == normalized_api_base_url)
      .map(|connection| connection.web_origin.clone())
  }

  pub fn is_trusted_self_host_connection(
    &self,
    web_origin: &str,
    api_base_url: &str,
  ) -> bool {
    let Ok(normalized_api_base_url) =
      config::normalize_self_host_api_base_url(api_base_url)
    else {
      return false;
    };
    self.trusted_self_host_connections.iter().any(|connection| {
      connection.web_origin == web_origin
        && connection.api_base_url == normalized_api_base_url
    })
  }

  pub async fn trust_self_host_connection(
    &mut self,
    web_origin: String,
    api_base_url: String,
  ) -> AppSnapshot {
    self.upsert_trusted_self_host_connection(web_origin, api_base_url, chrono_now());
    self.persist_sessions().await;
    self.emit_state_change();
    self.get_snapshot()
  }

  #[cfg(test)]
  pub fn trust_self_host_connection_for_test(
    &mut self,
    web_origin: String,
    api_base_url: String,
  ) {
    self.upsert_trusted_self_host_connection(
      web_origin,
      api_base_url,
      "2026-01-01T00:00:00Z".to_string(),
    );
  }

  fn upsert_trusted_self_host_connection(
    &mut self,
    web_origin: String,
    api_base_url: String,
    trusted_at: String,
  ) {
    let normalized_api_base_url = normalize_api_base_url(&api_base_url);
    self.selected_self_host_connection = Some(TrustedSelfHostConnection {
      web_origin: web_origin.clone(),
      api_base_url: normalized_api_base_url.clone(),
      trusted_at: trusted_at.clone(),
    });
    if let Some(connection) =
      self
        .trusted_self_host_connections
        .iter_mut()
        .find(|connection| {
          connection.web_origin == web_origin
            && connection.api_base_url == normalized_api_base_url
        })
    {
      connection.trusted_at = trusted_at;
      return;
    }

    self
      .trusted_self_host_connections
      .push(TrustedSelfHostConnection {
        api_base_url: normalized_api_base_url,
        trusted_at,
        web_origin,
      });
    self
      .trusted_self_host_connections
      .sort_by(|a, b| a.web_origin.cmp(&b.web_origin));
  }

  pub async fn persist_sessions_public(&self) {
    self.persist_sessions().await;
  }

  pub fn session_exists(&self, session_id: &str) -> bool {
    self.sessions.contains_key(session_id)
  }

  pub fn has_active_edit_sessions(&self) -> bool {
    self
      .sessions
      .values()
      .any(|session| !session.takeover_detected)
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
    let Some(session) = self.sessions.get(session_id) else {
      return;
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

  fn prepare_takeover_response(
    &self,
    session_id: &str,
    approved: bool,
  ) -> Option<reqwest::RequestBuilder> {
    let session = self.sessions.get(session_id)?;
    let url = format!(
      "{}/v1/desktop-edit-sessions/{session_id}/respond-takeover",
      session.api_base_url
    );
    Some(
      self
        .http_client
        .post(url)
        .json(&serde_json::json!({
          "sessionToken": session.session_token, "approved": approved,
        }))
        .timeout(Duration::from_secs(10)),
    )
  }

  pub async fn open_edit_root(&self) -> bool {
    let root = self.edit_root.clone();
    if !matches!(
      tokio::task::spawn_blocking(move || crate::local_store::create_private_dir(
        &root
      ))
      .await,
      Ok(Ok(()))
    ) {
      return false;
    }
    open_path_native(self.edit_root.to_string_lossy().as_ref()).is_ok()
  }

  pub fn reveal_support_root(&self) -> bool {
    open_path_native(self.support_root.to_string_lossy().as_ref()).is_ok()
  }

  pub fn email_support() -> bool {
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

  async fn prepare_checkpoint(
    &mut self,
    session_id: &str,
  ) -> Option<SyncCheckpointInput> {
    let session = self.sessions.get_mut(session_id)?;
    if session.checkpoint_in_flight
      || session.finalize_in_flight
      || session.takeover_detected
    {
      return None;
    }
    let fingerprint = match self.file_system.fingerprint(Path::new(&session.file_path))
    {
      Ok(fingerprint) => fingerprint,
      Err(error) => {
        let message = format!("Failed to read file: {error}");
        if session.last_error.as_ref() != Some(&message) {
          session.last_error = Some(message);
          session.status = SessionStatus::Error;
          self.persist_sessions().await;
          self.emit_state_change();
        }
        return None;
      }
    };
    if session.last_observed_file.as_ref() == Some(&fingerprint)
      && session.last_error.is_none()
      && session.status
        == (if session.pending_finalize {
          SessionStatus::Finalizing
        } else {
          SessionStatus::Ready
        })
      && (session.last_checkpoint_sha.as_deref()
        == Some(session.last_local_sha.as_str())
        || (session.last_checkpoint_sha.is_none() && !session.pending_finalize))
    {
      return None;
    }
    session.changed_during_remote_save = false;
    session.checkpoint_in_flight = true;
    Some(SyncCheckpointInput {
      generation: session.generation,
      session_id: session.id.clone(),
      file_type: session.file_type,
      file_path: session.file_path.clone(),
      api_base_url: session.api_base_url.clone(),
      session_token: session.session_token.clone(),
      file_name: session.file_name.clone(),
      last_checkpoint_sha: session.last_checkpoint_sha.clone(),
      fingerprint,
      last_local_sha: session.last_local_sha.clone(),
      pending_finalize: session.pending_finalize,
    })
  }

  async fn apply_checkpoint(
    &mut self,
    session_id: &str,
    fingerprint: FileFingerprint,
    generation: uuid::Uuid,
    result: CheckpointResult,
  ) -> bool {
    let Some(session) = self.sessions.get_mut(session_id) else {
      return false;
    };
    if session.generation != generation || session.takeover_detected {
      return false;
    }
    session.checkpoint_in_flight = false;

    match result {
      CheckpointResult::Unchanged { sha } => {
        if session.changed_during_remote_save {
          session.last_observed_file = None;
          return false;
        }
        session.last_observed_file = Some(fingerprint);
        let status = if session.pending_finalize {
          SessionStatus::Finalizing
        } else {
          SessionStatus::Ready
        };
        let state_changed = session.last_error.take().is_some()
          || session.last_local_sha != sha
          || session.status != status;
        session.last_local_sha = sha;
        session.status = status;
        if state_changed {
          self.persist_sessions().await;
          self.emit_state_change();
        }
        true
      }
      CheckpointResult::Uploaded {
        next_sha,
        current_sha,
        checkpointed_at,
        rotated_token,
      } => {
        let changed_during_upload =
          session.changed_during_remote_save || current_sha != next_sha;

        session.last_observed_file = if changed_during_upload {
          None
        } else {
          Some(fingerprint)
        };

        // Apply rotated token from server
        if let Some(ref new_token) = rotated_token {
          session.session_token = new_token.clone();
          if let Err(e) = crate::keychain::store_token(&session.id, new_token) {
            tracing::warn!(error = %e, "failed to store rotated token in keychain");
          }
        }

        session.last_checkpoint_sha = Some(next_sha.clone());
        session.last_local_sha = current_sha;
        session.last_checkpoint_at = Some(checkpointed_at);
        session.last_error = None;
        session.retry_notice_shown = false;
        session.changed_during_remote_save = false;
        session.status = if changed_during_upload {
          SessionStatus::Syncing
        } else if session.pending_finalize {
          SessionStatus::Finalizing
        } else {
          SessionStatus::Ready
        };

        self.persist_sessions().await;
        self.emit_state_change();

        if changed_during_upload {
          return false;
        }

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
    client: &DesktopHttpClient,
    file_system: &dyn SessionFileSystem,
    input: &SyncCheckpointInput,
  ) -> CheckpointResult {
    let file_bytes = match file_system.read(Path::new(&input.file_path)).await {
      Ok(b) => b,
      Err(e) => return CheckpointResult::Error(format!("Failed to read file: {e}")),
    };

    let next_sha = hash_bytes(&file_bytes);

    if Some(next_sha.as_str()) == input.last_checkpoint_sha.as_deref()
      || (input.last_checkpoint_sha.is_none()
        && !input.pending_finalize
        && next_sha == input.last_local_sha)
    {
      return CheckpointResult::Unchanged { sha: next_sha };
    }

    let form = reqwest::multipart::Form::new()
      .part(
        "file",
        reqwest::multipart::Part::bytes(file_bytes)
          .file_name(input.file_name.clone())
          .mime_str(input.file_type.mime_type())
          .unwrap(),
      )
      .text("sessionToken", input.session_token.clone());

    let url = format!(
      "{}/v1/desktop-edit-sessions/{}/checkpoint",
      input.api_base_url, input.session_id
    );

    let response = match client
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
        if let Some(ref err) = error_body
          && err.code.as_deref() == Some(TAKEN_OVER_CODE)
        {
          return CheckpointResult::TakenOver(err.message.clone().unwrap_or_else(
            || crate::i18n::t("notification.takenOverLocalError").to_string(),
          ));
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
      Ok(cp) => {
        let current_sha = if file_system
          .fingerprint(Path::new(&input.file_path))
          .ok()
          .as_ref()
          == Some(&input.fingerprint)
        {
          next_sha.clone()
        } else {
          match file_system.read(Path::new(&input.file_path)).await {
            Ok(bytes) => hash_bytes(&bytes),
            Err(e) => {
              return CheckpointResult::Error(format!(
                "Failed to re-read file after checkpoint upload: {e}"
              ));
            }
          }
        };

        CheckpointResult::Uploaded {
          next_sha,
          current_sha,
          checkpointed_at: cp.checkpointed_at,
          rotated_token: cp.rotated_session_token,
        }
      }
      Err(e) => CheckpointResult::Error(format!(
        "stella desktop received an invalid checkpoint response: {e}"
      )),
    }
  }

  // --- Finalize ---

  async fn prepare_finalize(&mut self, session_id: &str) -> Option<FinalizeInput> {
    let (file_path, checkpoint_sha) = {
      let session = match self.sessions.get(session_id) {
        Some(s)
          if !s.checkpoint_in_flight
            && !s.finalize_in_flight
            && !s.takeover_detected =>
        {
          s
        }
        _ => return None,
      };

      let checkpoint_sha = session.last_checkpoint_sha.clone()?;

      if session.last_local_sha != checkpoint_sha {
        return None;
      }

      (session.file_path.clone(), checkpoint_sha)
    };

    let current_sha = match self.file_system.read(Path::new(&file_path)).await {
      Ok(bytes) => hash_bytes(&bytes),
      Err(e) => {
        let session = self.sessions.get_mut(session_id).unwrap();
        session.last_error = Some(format!("Failed to read file before finalize: {e}"));
        session.status = SessionStatus::Error;
        self.persist_sessions().await;
        self.emit_state_change();
        return None;
      }
    };

    if current_sha != checkpoint_sha {
      let session = self.sessions.get_mut(session_id).unwrap();
      session.last_local_sha = current_sha;
      session.pending_finalize = true;
      session.status = SessionStatus::Syncing;
      self.persist_sessions().await;
      self.emit_state_change();
      return None;
    }

    let session = self.sessions.get_mut(session_id).unwrap();
    session.changed_during_remote_save = false;
    session.finalize_in_flight = true;
    session.last_error = None;
    session.status = SessionStatus::Finalizing;
    let api_base_url = session.api_base_url.clone();
    let sid = session.id.clone();
    let session_token = session.session_token.clone();
    let pending_finalize = session.pending_finalize;

    Some(FinalizeInput {
      generation: session.generation,
      api_base_url,
      session_id: sid,
      session_token,
      pending_finalize,
    })
  }

  async fn apply_finalize(
    &mut self,
    session_id: &str,
    pending_finalize: bool,
    generation: uuid::Uuid,
    result: FinalizeResult,
  ) -> bool {
    let Some(session) = self.sessions.get_mut(session_id) else {
      return false;
    };
    if session.generation != generation || session.takeover_detected {
      return false;
    }
    session.finalize_in_flight = false;

    match result {
      FinalizeResult::Finalized { version_number } => {
        if session.changed_during_remote_save {
          session.changed_during_remote_save = false;
          session.last_error = Some(
            "The file changed while stella desktop was finalizing. Your local copy was preserved."
              .to_string(),
          );
          session.pending_finalize = false;
          session.status = SessionStatus::Error;
          self.persist_sessions().await;
          self.emit_state_change();
          return false;
        }

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
        if session.changed_during_remote_save {
          session.changed_during_remote_save = false;
          session.last_error = Some(
            "The file changed while stella desktop was finalizing. Your local copy was preserved."
              .to_string(),
          );
          session.pending_finalize = false;
          session.status = SessionStatus::Error;
          self.persist_sessions().await;
          self.emit_state_change();
          return false;
        }

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
    client: &DesktopHttpClient,
    session_id: &str,
    api_base_url: &str,
    session_token: &str,
  ) -> FinalizeResult {
    let url = format!("{api_base_url}/v1/desktop-edit-sessions/{session_id}/finalize");
    let body = serde_json::json!({ "sessionToken": session_token });

    let response = match client
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
        if let Some(ref err) = error_body
          && err.code.as_deref() == Some(TAKEN_OVER_CODE)
        {
          return FinalizeResult::TakenOver(err.message.clone().unwrap_or_else(|| {
            crate::i18n::t("notification.takenOverLocalError").to_string()
          }));
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
      Ok(FinalizeResponse::Finalized { version_number, .. }) => {
        FinalizeResult::Finalized { version_number }
      }
      Ok(FinalizeResponse::NoChanges) => FinalizeResult::NoChanges,
      Err(e) => FinalizeResult::Error(format!(
        "stella desktop received an invalid finalize response: {e}"
      )),
    }
  }

  // --- Retry loop (called from spawned timer) ---

  // --- File watcher ---

  pub async fn attach_watcher(manager: &Arc<Mutex<Self>>, session_id: &str) {
    let (watch_dir, file_name, sid) = {
      let mgr = manager.lock().await;
      let session = match mgr.sessions.get(session_id) {
        Some(s) if !s.takeover_detected => s,
        _ => return,
      };

      let dir = Path::new(&session.file_path)
        .parent()
        .unwrap_or(Path::new("."));

      let watched = (
        dir.to_path_buf(),
        session.file_name.clone(),
        session.id.clone(),
      );
      drop(mgr);
      watched
    };

    let mgr_for_watcher = Arc::clone(manager);
    let sid_for_watcher = sid.clone();
    let fname_for_watcher = file_name.clone();

    let runtime = tokio::runtime::Handle::current();
    let watcher_result = notify::recommended_watcher(move |res: Result<Event, _>| {
      if let Ok(event) = res {
        if !event_needs_open_probe(&event.kind) {
          return;
        }
        let changed_file = event
          .paths
          .iter()
          .filter_map(|path| path.file_name().and_then(|name| name.to_str()))
          .find(|name| {
            *name == fname_for_watcher
              || is_temporary_lock_file_for(name, &fname_for_watcher)
          })
          .map(str::to_string);
        if !event.paths.is_empty() && changed_file.is_none() {
          return;
        }

        let mgr = Arc::clone(&mgr_for_watcher);
        let sid = sid_for_watcher.clone();
        let fname = fname_for_watcher.clone();

        runtime.spawn(async move {
          handle_filesystem_event(mgr, &sid, changed_file.as_deref(), &fname).await;
        });
      }
    });

    let mut mgr = manager.lock().await;
    if let Some(session) = mgr.sessions.get_mut(&sid) {
      match watcher_result {
        Ok(mut w) => match w.watch(&watch_dir, RecursiveMode::NonRecursive) {
          Ok(()) => {
            ensure_open_probe_loop(session, manager, &sid);
            session.watcher = Some(w);
          }
          Err(error) => tracing::warn!(%error, "failed to watch editing directory"),
        },
        Err(e) => {
          tracing::warn!(error = %e, "failed to create file watcher");
        }
      }
    }
  }

  // --- Internal helpers ---

  async fn mark_session_taken_over(&mut self, session_id: &str, message: &str) {
    let Some(session) = self.sessions.get_mut(session_id) else {
      return;
    };

    session.cancel_timers();
    session.generation = uuid::Uuid::new_v4();
    session.checkpoint_in_flight = false;
    session.finalize_in_flight = false;
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

      if remove_local_files && let Some(parent) = Path::new(&session.file_path).parent()
      {
        self
          .schedule_cleanup_path(parent.to_string_lossy().to_string())
          .await;
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
      .map(|session| session.file_path.as_str())
      .chain(
        self
          .unconfirmed_sessions
          .values()
          .map(|session| session.file_path.as_str()),
      )
      .filter_map(|file_path| {
        Path::new(file_path)
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
    let Some(session) = self.sessions.get_mut(session_id) else {
      return;
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

  async fn write_managed_copy(
    &self,
    folder_name: &str,
    file_name: &str,
    buffer: &[u8],
  ) -> Result<String, String> {
    let edit_root = self.edit_root.clone();
    let session_folder = edit_root.join(sanitize_path_segment(folder_name));
    let file_path = session_folder.join(file_name);
    let buffer = buffer.to_vec();
    tokio::task::spawn_blocking(move || {
      crate::local_store::create_private_dir(&edit_root)
        .and_then(|()| crate::local_store::create_private_dir(&session_folder))
        .map_err(|error| format!("Failed to create editing folder: {error}"))?;
      crate::local_store::write_private_atomic(&file_path, &buffer)
        .map_err(|error| format!("Failed to write Office file: {error}"))?;
      Ok(file_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("Office file task failed: {error}"))?
  }

  async fn persist_sessions_result(&self) -> Result<(), String> {
    #[cfg(test)]
    self
      .costs
      .writes
      .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut persisted: Vec<PersistedDesktopSession> = self
      .unconfirmed_sessions
      .values()
      .filter(|session| !self.sessions.contains_key(&session.id))
      .cloned()
      .collect();
    persisted.extend(self.sessions.values().map(|s| s.to_persisted()));
    persisted.sort_by(|a, b| a.id.cmp(&b.id));

    let cleanup: Vec<String> = {
      let mut v: Vec<String> = self.cleanup_paths.iter().cloned().collect();
      v.sort();
      v
    };

    session_store::persist_session_store(
      &self.store_path,
      &session_store::SessionStorePayload {
        cleanup_paths: cleanup,
        linked_account: self.linked_account.clone(),
        linked_account_web_origin: self.linked_account_web_origin.clone(),
        selected_self_host_connection: self.selected_self_host_connection.clone(),
        notification_preferences: Some(self.notification_preferences.clone()),
        sessions: persisted,
        trusted_self_host_connections: self.trusted_self_host_connections.clone(),
      },
    )
    .await
  }

  async fn persist_sessions(&self) {
    if let Err(e) = self.persist_sessions_result().await {
      tracing::error!(error = %e, "failed to persist session store");
    }
  }

  fn emit_state_change(&self) {
    #[cfg(test)]
    self
      .costs
      .emits
      .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Some(ref handle) = self.app_handle {
      let snapshot = self.get_snapshot();
      let _ = handle.emit_to("main", "state-changed", &snapshot);

      crate::tray::refresh(handle, &snapshot);
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
    render_diagnostics(DiagnosticsInput {
      generated_at: chrono_now(),
      bridge_port: self.bridge_port,
      running_since: &self.running_since,
      linked_account_present: self.linked_account.is_some(),
      store_load_issue: self.store_load_issue.as_ref().map(|issue| match issue {
        StoreLoadIssue::InvalidStore => DiagnosticStoreLoadIssue::InvalidStore,
        StoreLoadIssue::UnreadableStore => DiagnosticStoreLoadIssue::UnreadableStore,
      }),
      notification_preferences: DiagnosticNotificationPreferences {
        document_ready: self.notification_preferences.document_ready,
        revision_created: self.notification_preferences.revision_created,
        sync_issues: self.notification_preferences.sync_issues,
      },
      update: DiagnosticUpdate {
        configured: self.update.base_url.is_some(),
        channel_configured: self.update.channel.is_some(),
        current_version: self.update.current_version.as_deref(),
        last_checked_at: self.update.last_checked_at.as_deref(),
        latest_version: self.update.latest_version.as_deref(),
        update_available: self.update.update_available,
        update_ready: self.update.update_ready,
      },
      sessions: self
        .sessions
        .values()
        .map(|session| DiagnosticSession {
          status: session.status,
          has_last_checkpoint: session.last_checkpoint_at.is_some(),
          has_last_error: session.last_error.is_some(),
          pending_finalize: session.pending_finalize,
          takeover_detected: session.takeover_detected,
        })
        .collect(),
      cleanup_paths_queued: self.cleanup_paths.len(),
    })
  }
}

// --- Helper types ---

enum CheckpointResult {
  Unchanged {
    sha: String,
  },
  Uploaded {
    next_sha: String,
    current_sha: String,
    checkpointed_at: String,
    rotated_token: Option<String>,
  },
  TakenOver(String),
  SessionClosed(String),
  Error(String),
}

struct FinalizeInput {
  generation: uuid::Uuid,
  api_base_url: String,
  session_id: String,
  session_token: String,
  pending_finalize: bool,
}

enum FinalizeResult {
  Finalized { version_number: i64 },
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

fn event_needs_open_probe(kind: &EventKind) -> bool {
  matches!(
    kind,
    EventKind::Modify(_)
      | EventKind::Create(_)
      | EventKind::Remove(_)
      | EventKind::Access(AccessKind::Close(AccessMode::Write))
  )
}

// --- File system event handler (called from watcher callback) ---

async fn handle_filesystem_event(
  manager: Arc<Mutex<SessionManager>>,
  session_id: &str,
  changed_file: Option<&str>,
  managed_file_name: &str,
) {
  let is_managed = changed_file.is_none() || changed_file == Some(managed_file_name);
  let is_temporary_lock = changed_file
    .is_some_and(|file| is_temporary_lock_file_for(file, managed_file_name));
  let is_relevant = is_managed || is_temporary_lock;
  let mut state_changed = false;

  {
    let mut mgr = manager.lock().await;
    let session = match mgr.sessions.get_mut(session_id) {
      Some(s) if !s.takeover_detected => s,
      _ => return,
    };

    if is_relevant {
      if is_managed {
        session.last_observed_file = None;
      }
      if session.pending_finalize && !session.finalize_in_flight {
        session.pending_finalize = false;
        session.local_open_seen = true;
        session.closed_recheck_count = 0;
        session.status = if session
          .last_checkpoint_sha
          .as_deref()
          .is_some_and(|sha| session.last_local_sha == sha)
        {
          SessionStatus::Ready
        } else {
          SessionStatus::Syncing
        };
        state_changed = true;
      }

      if is_managed && (session.checkpoint_in_flight || session.finalize_in_flight) {
        session.changed_during_remote_save = true;
      }
      ensure_open_probe_loop(session, &manager, session_id);
    }
    drop(mgr);
  }

  if state_changed {
    let mgr = manager.lock().await;
    mgr.persist_sessions().await;
    mgr.emit_state_change();
  }

  if is_managed {
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
          if let Some(session) =
            mgr_for_timer.lock().await.sessions.get_mut(&sid_for_timer)
          {
            session.checkpoint_timer.take();
          }
          retry_session(mgr_for_timer, &sid_for_timer).await;
        }));
      }
    }
  }
}

fn ensure_open_probe_loop(
  session: &mut DesktopSession,
  manager: &Arc<Mutex<SessionManager>>,
  session_id: &str,
) {
  if let Some(handle) = session.open_probe_timer.take() {
    handle.abort();
  }
  session.closed_recheck_count = 0;
  let mgr_clone = Arc::clone(manager);
  let sid = session_id.to_string();
  session.open_probe_timer = Some(tokio::spawn(async move {
    run_open_probe_loop(|| probe_session_open(&mgr_clone, &sid)).await;
  }));
}

enum OpenProbeSchedule {
  Stopped,
  Watching,
  ConfirmingClose,
}

/// Lockless editors can close without a filesystem event. Keep a sparse
/// fallback alive; only a suspected close needs the faster confirmation rate.
async fn run_open_probe_loop<F, Fut>(mut probe: F)
where
  F: FnMut() -> Fut,
  Fut: std::future::Future<Output = OpenProbeSchedule>,
{
  let mut interval = OPEN_PROBE_INTERVAL;
  loop {
    tokio::time::sleep(interval).await;
    interval = match probe().await {
      OpenProbeSchedule::Stopped => return,
      OpenProbeSchedule::Watching => OPEN_PROBE_IDLE_INTERVAL,
      OpenProbeSchedule::ConfirmingClose => OPEN_PROBE_INTERVAL,
    };
  }
}

async fn probe_session_open(
  manager: &Arc<Mutex<SessionManager>>,
  session_id: &str,
) -> OpenProbeSchedule {
  probe_session_open_with(manager, session_id, |file_path, file_name| async move {
    local_file_appears_open(Path::new(&file_path), &file_name).await
  })
  .await
}

async fn probe_session_open_with<F, Fut>(
  manager: &Arc<Mutex<SessionManager>>,
  session_id: &str,
  observe_open: F,
) -> OpenProbeSchedule
where
  F: FnOnce(String, String) -> Fut,
  Fut: std::future::Future<Output = bool>,
{
  let Some((file_path, file_name, generation)) = ({
    let mgr = manager.lock().await;
    let input = mgr.sessions.get(session_id).and_then(|session| {
      (!session.pending_finalize && !session.takeover_detected).then(|| {
        (
          session.file_path.clone(),
          session.file_name.clone(),
          session.generation,
        )
      })
    });
    drop(mgr);
    input
  }) else {
    return OpenProbeSchedule::Stopped;
  };

  let appears_open = observe_open(file_path, file_name).await;
  let mut mgr = manager.lock().await;
  let Some(session) = mgr.sessions.get_mut(session_id) else {
    return OpenProbeSchedule::Stopped;
  };
  if session.generation != generation
    || session.pending_finalize
    || session.takeover_detected
  {
    return OpenProbeSchedule::Stopped;
  }
  if appears_open {
    session.local_open_seen = true;
    session.closed_recheck_count = 0;
    return OpenProbeSchedule::Watching;
  }
  if !session.local_open_seen {
    return OpenProbeSchedule::Watching;
  }
  session.closed_recheck_count = session.closed_recheck_count.saturating_add(1);
  if session.closed_recheck_count < CLOSED_RECHECK_COUNT
    || session.checkpoint_in_flight
    || session.finalize_in_flight
  {
    return OpenProbeSchedule::ConfirmingClose;
  }

  // Stop detection before remote work: a new watcher event may safely rearm
  // the timer without canceling a checkpoint upload.
  session.open_probe_timer.take();
  mgr.finish_session(session_id);
  mgr.persist_sessions().await;
  drop(mgr);
  retry_session(Arc::clone(manager), session_id).await;
  OpenProbeSchedule::Stopped
}

pub async fn respond_to_takeover(
  manager: Arc<Mutex<SessionManager>>,
  session_id: &str,
  approved: bool,
) -> bool {
  let request = manager
    .lock()
    .await
    .prepare_takeover_response(session_id, approved);
  let Some(request) = request else {
    return false;
  };
  match request.send().await {
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

/// Each remote operation owns its input; the manager guard cannot cross the request.
pub async fn retry_session(manager: Arc<Mutex<SessionManager>>, session_id: &str) {
  for _ in 0..3 {
    let (input, client, file_system) = {
      let mut mgr = manager.lock().await;
      (
        mgr.prepare_checkpoint(session_id).await,
        mgr.http_client.clone(),
        Arc::clone(&mgr.file_system),
      )
    };
    let checkpoint_ready = match input {
      Some(input) => {
        let result =
          SessionManager::do_sync_checkpoint(&client, file_system.as_ref(), &input)
            .await;
        manager
          .lock()
          .await
          .apply_checkpoint(session_id, input.fingerprint, input.generation, result)
          .await
      }
      None => manager
        .lock()
        .await
        .sessions
        .get(session_id)
        .is_some_and(|s| {
          !s.checkpoint_in_flight
            && !s.finalize_in_flight
            && !s.takeover_detected
            && s.last_error.is_none()
            && s.last_checkpoint_sha.as_deref() == Some(s.last_local_sha.as_str())
        }),
    };
    if checkpoint_ready {
      let input = {
        let mut mgr = manager.lock().await;
        // A confirmed close remains pending when its last probe overlapped
        // the upload. The save owner resumes finalization after it settles.
        if mgr.finish_confirmed_closed_session(session_id) {
          mgr.persist_sessions().await;
        }
        if mgr
          .sessions
          .get(session_id)
          .is_some_and(|s| s.pending_finalize)
        {
          mgr.prepare_finalize(session_id).await
        } else {
          None
        }
      };
      if let Some(input) = input {
        let result = SessionManager::do_finalize(
          &client,
          &input.session_id,
          &input.api_base_url,
          &input.session_token,
        )
        .await;
        manager
          .lock()
          .await
          .apply_finalize(session_id, input.pending_finalize, input.generation, result)
          .await;
      }
      return;
    }
    let should_retry = manager
      .lock()
      .await
      .sessions
      .get(session_id)
      .is_some_and(|s| {
        !s.takeover_detected
          && !s.checkpoint_in_flight
          && !s.finalize_in_flight
          && s.last_error.is_none()
          && (s.status == SessionStatus::Syncing || s.changed_during_remote_save)
      });
    if !should_retry {
      return;
    }
  }
}

// --- Retry loop (spawned as background task) ---

trait RetryClock {
  fn tick(&mut self) -> futures_util::future::BoxFuture<'_, bool>;
}

struct IntervalRetryClock(tokio::time::Interval);

impl RetryClock for IntervalRetryClock {
  fn tick(&mut self) -> futures_util::future::BoxFuture<'_, bool> {
    Box::pin(async move {
      self.0.tick().await;
      true
    })
  }
}

pub async fn run_retry_loop(manager: Arc<Mutex<SessionManager>>) {
  let mut clock = IntervalRetryClock(tokio::time::interval(RETRY_INTERVAL));
  run_retry_clock(manager, &mut clock).await;
}

async fn run_retry_clock(
  manager: Arc<Mutex<SessionManager>>,
  clock: &mut (impl RetryClock + Send),
) {
  while clock.tick().await {
    let session_ids = {
      let mut mgr = manager.lock().await;
      mgr.retry_pending_cleanup().await;
      mgr.sessions.keys().cloned().collect::<Vec<_>>()
    };
    for id in session_ids {
      retry_session(Arc::clone(&manager), &id).await;
    }
  }
}

/// Download an Office file without holding the session manager lock.
/// Used by the bridge to avoid blocking other operations during network I/O.
pub async fn download_file_standalone(
  file_type: DesktopEditFileType,
  client: &DesktopHttpClient,
  url: &str,
) -> Result<Vec<u8>, String> {
  let response = client
    .get(url)
    .timeout(DOWNLOAD_TIMEOUT)
    .send()
    .await
    .map_err(|e| format!("stella desktop could not download the Office file: {e}"))?;

  if !response.status().is_success() {
    return Err("stella desktop could not download the Office file.".to_string());
  }

  validate_office_download_response(file_type, &response)?;

  let bytes = read_office_download_bytes(response).await?;
  validate_office_download_bytes(file_type, &bytes)?;
  Ok(bytes)
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
  // Pass dynamic data via URL hash — the static HTML reads it via JS. The
  // dialog's own wording travels the same way: it holds no strings of its own,
  // so it renders in the language the rest of the app runs in.
  let hash = format!(
    "requester={}&fileName={}&strings={}&lang={}&dir={}",
    urlencode(requested_by),
    urlencode(file_name),
    urlencode(&crate::i18n::namespace_json("dialog")),
    urlencode(crate::i18n::active_locale()),
    urlencode(crate::i18n::text_direction()),
  );

  let builder = crate::app_window::builder(
    handle,
    "takeover-dialog",
    format!("takeover-dialog.html#{hash}"),
  )
  .title(crate::i18n::t("dialog.takeoverWindowTitle"))
  .inner_size(400.0, 260.0)
  .resizable(false)
  .always_on_top(true);
  let window = crate::window_placement::centered_on_target_screen(
    handle,
    builder,
    tauri::LogicalSize::new(400.0, 260.0),
  )
  .build();

  match window {
    Ok(w) => {
      let label = w.label().to_string();

      // Register a per-dialog response channel
      let rx = register_takeover_dialog(&label);

      // Wait for the dialog button click. A closed dialog drops the sender and denies.
      rx.await.unwrap_or_default()
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
#[allow(
  clippy::disallowed_methods,
  reason = "tests construct local file fixtures"
)]
mod tests {
  use super::*;
  use std::io::{Cursor, Write};
  use zip::write::SimpleFileOptions;

  #[cfg(unix)]
  #[tokio::test]
  async fn local_file_creation_keeps_edit_copies() {
    use std::os::unix::fs::PermissionsExt;
    if crate::local_store::local_file_creation_child(
      "session_manager::tests::local_file_creation_keeps_edit_copies",
    ) {
      return;
    }
    let mut manager = SessionManager::new();
    manager.edit_root =
      std::env::temp_dir().join(format!("stella-edit-{}", uuid::Uuid::new_v4()));
    let path = PathBuf::from(
      manager
        .write_managed_copy("session", "document.docx", b"document")
        .await
        .unwrap(),
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"document");
    assert_eq!(
      std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
      0o600
    );
    for directory in [manager.edit_root.as_path(), path.parent().unwrap()] {
      assert_eq!(
        std::fs::metadata(directory).unwrap().permissions().mode() & 0o777,
        0o700
      );
    }
    std::fs::remove_dir_all(manager.edit_root).unwrap();
  }

  fn persisted_session_for_test(id: &str) -> PersistedDesktopSession {
    PersistedDesktopSession {
      api_base_url: "https://api.example.com".to_string(),
      base_version_number: 1,
      entity_id: format!("entity-{id}"),
      file_type: DesktopEditFileType::Docx,
      file_name: format!("{id}.docx"),
      file_path: std::env::temp_dir()
        .join(format!("{id}.docx"))
        .to_string_lossy()
        .to_string(),
      id: id.to_string(),
      key: format!("workspace-{id}:entity-{id}:property-{id}"),
      last_checkpoint_at: None,
      last_checkpoint_sha: None,
      last_error: None,
      last_local_sha: "local-sha".to_string(),
      pending_finalize: false,
      property_id: format!("property-{id}"),
      status: SessionStatus::Ready,
      takeover_detected: false,
      workspace_id: format!("workspace-{id}"),
    }
  }

  fn desktop_session_for_test(
    persisted: PersistedDesktopSession,
    session_token: &str,
  ) -> DesktopSession {
    DesktopSession {
      api_base_url: persisted.api_base_url,
      base_version_number: persisted.base_version_number,
      entity_id: persisted.entity_id,
      file_type: persisted.file_type,
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
      session_token: session_token.to_string(),
      status: persisted.status,
      takeover_detected: persisted.takeover_detected,
      workspace_id: persisted.workspace_id,
      generation: uuid::Uuid::new_v4(),
      last_observed_file: None,
      changed_during_remote_save: false,
      checkpoint_in_flight: false,
      finalize_in_flight: false,
      local_open_seen: false,
      closed_recheck_count: 0,
      retry_notice_shown: false,
      watcher: None,
      checkpoint_timer: None,
      open_probe_timer: None,
      sse_listener: None,
    }
  }

  #[test]
  fn open_detection_ignores_its_own_file_read_events() {
    for access in [
      AccessKind::Read,
      AccessKind::Open(AccessMode::Read),
      AccessKind::Close(AccessMode::Read),
    ] {
      assert!(!event_needs_open_probe(&EventKind::Access(access)));
    }
    assert!(event_needs_open_probe(&EventKind::Access(
      AccessKind::Close(AccessMode::Write)
    )));
  }

  #[tokio::test(start_paused = true)]
  async fn open_detection_bounds_probes_for_five_idle_sessions() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let spawns = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();
    for _ in 0..5 {
      let spawns = Arc::clone(&spawns);
      handles.push(tokio::spawn(async move {
        run_open_probe_loop(|| {
          spawns.fetch_add(1, Ordering::SeqCst);
          std::future::ready(OpenProbeSchedule::Watching)
        })
        .await;
      }));
    }
    tokio::task::yield_now().await;
    tokio::time::advance(OPEN_PROBE_INTERVAL).await;
    tokio::task::yield_now().await;
    assert_eq!(spawns.load(Ordering::SeqCst), 5);
    for _ in 0..3 {
      tokio::time::advance(OPEN_PROBE_IDLE_INTERVAL).await;
      tokio::task::yield_now().await;
    }
    tokio::time::advance(OPEN_PROBE_IDLE_INTERVAL - OPEN_PROBE_INTERVAL).await;
    tokio::task::yield_now().await;
    assert_eq!(spawns.load(Ordering::SeqCst), 20);
    for handle in handles {
      assert!(!handle.is_finished());
      handle.abort();
      assert!(handle.await.unwrap_err().is_cancelled());
    }
  }

  #[tokio::test(start_paused = true)]
  async fn closing_an_unchanged_lockless_document_finalizes_without_a_filesystem_event()
  {
    use axum::{Router, routing::post};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let (manager, _, _) = idle_test_manager();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let request_count = Arc::clone(&requests);
    let router = Router::new().route(
      "/v1/desktop-edit-sessions/{id}/finalize",
      post(move || {
        let requests = Arc::clone(&request_count);
        async move {
          requests.fetch_add(1, Ordering::SeqCst);
          axum::Json(serde_json::json!({ "outcome": "no_changes" }))
        }
      }),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    {
      let mut mgr = manager.lock().await;
      let session = mgr.sessions.get_mut("idle-0").unwrap();
      session.api_base_url = base_url;
      assert!(
        session.last_checkpoint_sha.as_deref() == Some(session.last_local_sha.as_str())
      );
      drop(mgr);
    }
    let open = Arc::new(AtomicBool::new(true));
    let observed_open = Arc::clone(&open);
    let probe_manager = Arc::clone(&manager);
    let handle = tokio::spawn(async move {
      run_open_probe_loop(|| {
        probe_session_open_with(&probe_manager, "idle-0", |_, _| {
          std::future::ready(observed_open.load(Ordering::SeqCst))
        })
      })
      .await;
    });
    tokio::task::yield_now().await;
    tokio::time::advance(OPEN_PROBE_INTERVAL).await;
    tokio::task::yield_now().await;
    assert!(manager.lock().await.sessions["idle-0"].local_open_seen);
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    // Closing changes only the OS observation, with no watcher event or save.
    open.store(false, Ordering::SeqCst);
    tokio::time::advance(OPEN_PROBE_IDLE_INTERVAL).await;
    tokio::task::yield_now().await;
    for _ in 1..CLOSED_RECHECK_COUNT {
      tokio::time::advance(OPEN_PROBE_INTERVAL).await;
      tokio::task::yield_now().await;
    }
    tokio::time::resume();
    handle.await.unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(!manager.lock().await.sessions.contains_key("idle-0"));
    server.abort();
    std::fs::remove_file(&manager.lock().await.store_path).unwrap();
  }

  #[derive(Default)]
  struct CountingFileSystem {
    files: std::sync::Mutex<HashMap<PathBuf, (FileFingerprint, Vec<u8>)>>,
    reads: std::sync::atomic::AtomicUsize,
  }

  impl CountingFileSystem {
    fn put(&self, path: &str, bytes: &[u8], revision: u64) -> FileFingerprint {
      let fingerprint = FileFingerprint {
        size: bytes.len() as u64,
        modified: std::time::UNIX_EPOCH + Duration::from_secs(revision),
        identity: revision,
      };
      self
        .files
        .lock()
        .unwrap()
        .insert(PathBuf::from(path), (fingerprint.clone(), bytes.to_vec()));
      fingerprint
    }
  }

  impl SessionFileSystem for CountingFileSystem {
    fn fingerprint(&self, path: &Path) -> std::io::Result<FileFingerprint> {
      self
        .files
        .lock()
        .unwrap()
        .get(path)
        .map(|(fingerprint, _)| fingerprint.clone())
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
    }

    fn read<'a>(
      &'a self,
      path: &'a Path,
    ) -> futures_util::future::BoxFuture<'a, std::io::Result<Vec<u8>>> {
      self
        .reads
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
      Box::pin(async move {
        self
          .files
          .lock()
          .unwrap()
          .get(path)
          .map(|(_, bytes)| bytes.clone())
          .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
      })
    }
  }

  fn idle_test_manager() -> (
    Arc<Mutex<SessionManager>>,
    Arc<CountingFileSystem>,
    Arc<SessionCosts>,
  ) {
    crate::i18n::init_en();
    let mut manager = SessionManager::new();
    let fs = Arc::new(CountingFileSystem::default());
    manager.file_system = fs.clone();
    let root =
      std::env::temp_dir().join(format!("stella-idle-{}", uuid::Uuid::new_v4()));
    manager.store_path = root.join("sessions.json");
    manager.edit_root = root.join("editing");
    for n in 0..5 {
      let mut session = desktop_session_for_test(
        persisted_session_for_test(&format!("idle-{n}")),
        "token",
      );
      session.file_path = manager
        .edit_root
        .join(&session.id)
        .join(&session.file_name)
        .to_string_lossy()
        .into_owned();
      session.last_local_sha = hash_bytes(b"unchanged document");
      session.last_checkpoint_sha = if n % 2 == 0 {
        Some(session.last_local_sha.clone())
      } else {
        None
      };
      session.last_observed_file =
        Some(fs.put(&session.file_path, b"unchanged document", 1));
      manager.sessions.insert(session.id.clone(), session);
    }
    let costs = Arc::clone(&manager.costs);
    (Arc::new(Mutex::new(manager)), fs, costs)
  }

  struct MinuteRetryClock {
    elapsed: Duration,
  }

  impl RetryClock for MinuteRetryClock {
    fn tick(&mut self) -> futures_util::future::BoxFuture<'_, bool> {
      Box::pin(async move {
        if self.elapsed == Duration::from_secs(60) {
          return false;
        }
        self.elapsed += RETRY_INTERVAL;
        true
      })
    }
  }

  #[tokio::test]
  async fn idle_cost_all_sessions_do_no_work_for_one_minute() {
    use std::sync::atomic::Ordering;
    let (manager, fs, costs) = idle_test_manager();
    let mut clock = MinuteRetryClock {
      elapsed: Duration::ZERO,
    };
    run_retry_clock(Arc::clone(&manager), &mut clock).await;
    assert_eq!(clock.elapsed, Duration::from_secs(60));
    assert_eq!(manager.lock().await.sessions.len(), 5);
    tracing::debug!(
      "idle minute / 5 sessions: reads={} writes={} emits={}",
      fs.reads.load(Ordering::Relaxed),
      costs.writes.load(Ordering::Relaxed),
      costs.emits.load(Ordering::Relaxed)
    );
    assert_eq!(fs.reads.load(Ordering::Relaxed), 0, "idle file reads");
    assert_eq!(costs.writes.load(Ordering::Relaxed), 0, "idle store writes");
    assert_eq!(costs.emits.load(Ordering::Relaxed), 0, "idle state emits");
  }

  #[tokio::test]
  async fn idle_cost_fingerprint_changes_read_once_without_publishing_equal_content() {
    use std::sync::atomic::Ordering;
    let (manager, fs, costs) = idle_test_manager();
    // Enumerate the manager's entire registry; every session follows the same gate.
    let sessions = manager
      .lock()
      .await
      .sessions
      .values()
      .map(|s| (s.id.clone(), s.file_path.clone()))
      .collect::<Vec<_>>();
    for (id, path) in &sessions {
      // A replacement inode with identical content must refresh the observation,
      // without a remote save or a persisted/UI state transition.
      fs.put(path, b"unchanged document", 2);
      retry_session(Arc::clone(&manager), id).await;
      retry_session(Arc::clone(&manager), id).await;
    }
    assert_eq!(fs.reads.load(Ordering::Relaxed), sessions.len());
    assert_eq!(costs.writes.load(Ordering::Relaxed), 0);
    assert_eq!(costs.emits.load(Ordering::Relaxed), 0);
  }

  #[tokio::test]
  async fn idle_cost_remote_operations_release_manager_and_publish_once() {
    use axum::{Router, routing::post};
    use std::sync::atomic::Ordering;
    let (manager, fs, costs) = idle_test_manager();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let request_count = Arc::clone(&requests);
    let manager_in_request = Arc::clone(&manager);
    let router = Router::new().route("/v1/desktop-edit-sessions/{id}/checkpoint", post(move || {
      let manager = Arc::clone(&manager_in_request);
      let requests = Arc::clone(&request_count);
      async move {
        assert!(manager.try_lock().is_ok(), "manager held across upload");
        requests.fetch_add(1, Ordering::Relaxed);
        axum::Json(serde_json::json!({ "checkpointedAt": "2026-01-01T00:00:00Z", "noop": false }))
      }
    }));
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let sessions = {
      let mut mgr = manager.lock().await;
      for s in mgr.sessions.values_mut() {
        s.api_base_url = base_url.clone();
      }
      mgr
        .sessions
        .values()
        .map(|s| (s.id.clone(), s.file_path.clone()))
        .collect::<Vec<_>>()
    };
    for (id, path) in &sessions {
      fs.put(path, b"changed document", 2);
      retry_session(Arc::clone(&manager), id).await;
      retry_session(Arc::clone(&manager), id).await;
    }
    assert_eq!(requests.load(Ordering::Relaxed), sessions.len());
    assert_eq!(fs.reads.load(Ordering::Relaxed), sessions.len());
    assert_eq!(costs.writes.load(Ordering::Relaxed), sessions.len());
    assert_eq!(costs.emits.load(Ordering::Relaxed), sessions.len());
    server.abort();
    std::fs::remove_file(&manager.lock().await.store_path).unwrap();
  }

  #[tokio::test]
  async fn managed_file_events_checkpoint_changed_bytes_with_the_same_fingerprint() {
    use axum::{Router, routing::post};
    use std::sync::atomic::Ordering;
    let (manager, fs, _) = idle_test_manager();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let request_count = Arc::clone(&requests);
    let router = Router::new().route(
      "/v1/desktop-edit-sessions/{id}/checkpoint",
      post(move || {
        let requests = Arc::clone(&request_count);
        async move {
          requests.fetch_add(1, Ordering::Relaxed);
          axum::Json(serde_json::json!({
            "checkpointedAt": "2026-01-01T00:00:00Z",
            "noop": false
          }))
        }
      }),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let (id, path, name, previous_fingerprint) = {
      let mut mgr = manager.lock().await;
      let session = mgr.sessions.get_mut("idle-0").unwrap();
      session.api_base_url = base_url;
      let values = (
        session.id.clone(),
        session.file_path.clone(),
        session.file_name.clone(),
        session.last_observed_file.clone().unwrap(),
      );
      drop(mgr);
      values
    };
    let changed = b"modified! document";
    assert_ne!(hash_bytes(changed), hash_bytes(b"unchanged document"));
    assert_eq!(fs.put(&path, changed, 1), previous_fingerprint);
    retry_session(Arc::clone(&manager), &id).await;
    assert_eq!(fs.reads.load(Ordering::Relaxed), 0);
    assert_eq!(requests.load(Ordering::Relaxed), 0);

    handle_filesystem_event(Arc::clone(&manager), &id, Some(&name), &name).await;
    {
      let mut mgr = manager.lock().await;
      let session = mgr.sessions.get_mut(&id).unwrap();
      assert!(session.last_observed_file.is_none());
      // Drive the same retry boundary directly, without waiting on debounce
      // or starting platform-specific open-file probes in this fixture.
      if let Some(timer) = session.checkpoint_timer.take() {
        timer.abort();
      }
      if let Some(timer) = session.open_probe_timer.take() {
        timer.abort();
      }
      drop(mgr);
    }
    retry_session(Arc::clone(&manager), &id).await;
    retry_session(Arc::clone(&manager), &id).await;
    assert_eq!(fs.reads.load(Ordering::Relaxed), 1);
    assert_eq!(requests.load(Ordering::Relaxed), 1);
    let checkpoint = manager.lock().await.sessions[&id]
      .last_checkpoint_sha
      .clone();
    assert_eq!(checkpoint, Some(hash_bytes(changed)));
    server.abort();
    std::fs::remove_file(&manager.lock().await.store_path).unwrap();
  }

  #[tokio::test]
  async fn idle_cost_finalize_releases_manager_during_request() {
    use axum::{Router, routing::post};
    use std::sync::atomic::Ordering;
    let (manager, _, costs) = idle_test_manager();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let manager_in_request = Arc::clone(&manager);
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let request_count = Arc::clone(&requests);
    let router = Router::new().route(
      "/v1/desktop-edit-sessions/{id}/finalize",
      post(move || {
        let manager = Arc::clone(&manager_in_request);
        let requests = Arc::clone(&request_count);
        async move {
          assert!(manager.try_lock().is_ok(), "manager held across finalize");
          requests.fetch_add(1, Ordering::Relaxed);
          // Keep this isolated fixture out of keychain/session-removal code.
          (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({"message": "retry fixture"})),
          )
        }
      }),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let sessions = {
      let mut mgr = manager.lock().await;
      for s in mgr.sessions.values_mut() {
        s.api_base_url = base_url.clone();
        s.last_checkpoint_sha = Some(s.last_local_sha.clone());
        s.pending_finalize = true;
        s.status = SessionStatus::Finalizing;
      }
      mgr.sessions.keys().cloned().collect::<Vec<_>>()
    };
    for id in &sessions {
      retry_session(Arc::clone(&manager), id).await;
    }
    assert_eq!(requests.load(Ordering::Relaxed), sessions.len());
    assert_eq!(costs.writes.load(Ordering::Relaxed), sessions.len());
    assert_eq!(costs.emits.load(Ordering::Relaxed), sessions.len());
    server.abort();
    std::fs::remove_file(&manager.lock().await.store_path).unwrap();
  }

  #[tokio::test(start_paused = true)]
  async fn confirmed_close_finishes_after_in_flight_checkpoint_settles() {
    use axum::{Router, routing::post};
    let (manager, _, _) = idle_test_manager();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().route(
      "/v1/desktop-edit-sessions/{id}/finalize",
      post(|| async {
        (
          axum::http::StatusCode::SERVICE_UNAVAILABLE,
          axum::Json(serde_json::json!({"message": "retry fixture"})),
        )
      }),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let ids = {
      let mut mgr = manager.lock().await;
      for session in mgr.sessions.values_mut() {
        session.api_base_url = base_url.clone();
        session.last_checkpoint_sha = Some(session.last_local_sha.clone());
        session.local_open_seen = true;
        session.closed_recheck_count = CLOSED_RECHECK_COUNT;
        session.checkpoint_in_flight = true;
      }
      mgr.sessions.keys().cloned().collect::<Vec<_>>()
    };
    for id in &ids {
      retry_session(Arc::clone(&manager), id).await;
      assert!(!manager.lock().await.sessions[id].pending_finalize);
    }
    tokio::time::advance(OPEN_PROBE_INTERVAL * u32::from(CLOSED_RECHECK_COUNT)).await;
    {
      let mut mgr = manager.lock().await;
      for session in mgr.sessions.values_mut() {
        session.checkpoint_in_flight = false;
      }
    }
    for id in &ids {
      retry_session(Arc::clone(&manager), id).await;
      assert!(manager.lock().await.sessions[id].pending_finalize);
    }
    server.abort();
    std::fs::remove_file(&manager.lock().await.store_path).unwrap();
  }

  #[tokio::test]
  async fn idle_cost_stale_responses_preserve_the_current_generation() {
    use std::sync::atomic::Ordering;
    let (manager, fs, costs) = idle_test_manager();
    let mut mgr = manager.lock().await;
    let ids = mgr.sessions.keys().cloned().collect::<Vec<_>>();
    for id in &ids {
      let (old_generation, fingerprint) = {
        let session = mgr.sessions.get_mut(id).unwrap();
        let old_generation = session.generation;
        session.generation = uuid::Uuid::new_v4();
        session.session_token = "refreshed-token".into();
        (
          old_generation,
          fs.fingerprint(Path::new(&session.file_path)).unwrap(),
        )
      };
      let before = serde_json::to_value(mgr.sessions[id].to_persisted()).unwrap();
      assert!(
        !mgr
          .apply_checkpoint(
            id,
            fingerprint,
            old_generation,
            CheckpointResult::Uploaded {
              next_sha: "obsolete-sha".into(),
              current_sha: "obsolete-sha".into(),
              checkpointed_at: "obsolete-time".into(),
              rotated_token: None,
            }
          )
          .await
      );
      assert!(
        !mgr
          .apply_finalize(
            id,
            true,
            old_generation,
            FinalizeResult::Error("obsolete-error".into())
          )
          .await
      );
      assert_eq!(
        serde_json::to_value(mgr.sessions[id].to_persisted()).unwrap(),
        before
      );
      assert_eq!(mgr.sessions[id].session_token, "refreshed-token");
    }
    assert_eq!(costs.writes.load(Ordering::Relaxed), 0);
    assert_eq!(costs.emits.load(Ordering::Relaxed), 0);
  }

  #[tokio::test]
  async fn idle_cost_unchanged_content_converges_after_an_event_during_save() {
    use std::sync::atomic::Ordering;
    let (manager, fs, costs) = idle_test_manager();
    let mut mgr = manager.lock().await;
    let ids = mgr.sessions.keys().cloned().collect::<Vec<_>>();
    for id in &ids {
      let (fingerprint, generation, sha) = {
        let session = mgr.sessions.get_mut(id).unwrap();
        session.changed_during_remote_save = true;
        session.checkpoint_in_flight = true;
        (
          fs.fingerprint(Path::new(&session.file_path)).unwrap(),
          session.generation,
          session.last_local_sha.clone(),
        )
      };
      assert!(
        !mgr
          .apply_checkpoint(
            id,
            fingerprint,
            generation,
            CheckpointResult::Unchanged { sha }
          )
          .await
      );
      let input = mgr.prepare_checkpoint(id).await.unwrap();
      // The save owner rechecks after an event, even when it ultimately reads equal bytes.
      assert!(
        mgr
          .apply_checkpoint(
            id,
            input.fingerprint,
            input.generation,
            CheckpointResult::Unchanged {
              sha: input.last_local_sha
            }
          )
          .await
      );
      assert_eq!(mgr.sessions[id].status, SessionStatus::Ready);
      assert!(mgr.prepare_checkpoint(id).await.is_none());
    }
    drop(mgr);
    assert_eq!(costs.writes.load(Ordering::Relaxed), 0);
    assert_eq!(costs.emits.load(Ordering::Relaxed), 0);
  }

  #[tokio::test]
  async fn idle_cost_takeover_response_releases_manager_during_request() {
    use axum::{Router, routing::post};
    use std::sync::atomic::Ordering;
    let (manager, _, costs) = idle_test_manager();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let manager_in_request = Arc::clone(&manager);
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let request_count = Arc::clone(&requests);
    let router = Router::new().route(
      "/v1/desktop-edit-sessions/{id}/respond-takeover",
      post(move || {
        let manager = Arc::clone(&manager_in_request);
        let requests = Arc::clone(&request_count);
        async move {
          assert!(
            manager.try_lock().is_ok(),
            "manager held across takeover response"
          );
          requests.fetch_add(1, Ordering::Relaxed);
          axum::http::StatusCode::OK
        }
      }),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let ids = {
      let mut mgr = manager.lock().await;
      for s in mgr.sessions.values_mut() {
        s.api_base_url = base_url.clone();
      }
      mgr.sessions.keys().cloned().collect::<Vec<_>>()
    };
    for id in &ids {
      assert!(respond_to_takeover(Arc::clone(&manager), id, true).await);
    }
    assert_eq!(requests.load(Ordering::Relaxed), ids.len());
    assert_eq!(costs.writes.load(Ordering::Relaxed), 0);
    assert_eq!(costs.emits.load(Ordering::Relaxed), 0);
    server.abort();
  }

  #[tokio::test]
  async fn idle_cost_restored_syncing_state_converges_once() {
    use std::sync::atomic::Ordering;
    let (manager, _, costs) = idle_test_manager();
    let ids = {
      let mut mgr = manager.lock().await;
      for s in mgr.sessions.values_mut() {
        s.status = SessionStatus::Syncing;
      }
      mgr.sessions.keys().cloned().collect::<Vec<_>>()
    };
    for id in &ids {
      retry_session(Arc::clone(&manager), id).await;
      retry_session(Arc::clone(&manager), id).await;
    }
    assert!(
      manager
        .lock()
        .await
        .sessions
        .values()
        .all(|s| s.status == SessionStatus::Ready)
    );
    assert_eq!(costs.writes.load(Ordering::Relaxed), ids.len());
    assert_eq!(costs.emits.load(Ordering::Relaxed), ids.len());
    std::fs::remove_file(&manager.lock().await.store_path).unwrap();
  }

  #[test]
  fn is_microsoft_office_lock_file_for_matches_supported_extensions() {
    for extension in ["docx", "xlsx", "pptx"] {
      let file_name = format!("document.{extension}");
      assert!(is_microsoft_office_lock_file_for(
        &format!("~$cument.{extension}"),
        &file_name
      ));
      assert!(is_microsoft_office_lock_file_for(
        &format!("~${file_name}"),
        &file_name
      ));
      assert!(!is_microsoft_office_lock_file_for(&file_name, &file_name));
    }
    assert!(!is_microsoft_office_lock_file_for(
      "~$brief.docx",
      "~$brief.docx"
    ));
  }

  #[test]
  fn temporary_lock_file_detection_matches_supported_owner_files() {
    assert!(is_temporary_lock_file_for("~$cument.docx", "document.docx"));
    assert!(is_temporary_lock_file_for(
      ".~lock.document.docx#",
      "document.docx"
    ));
    assert!(!is_temporary_lock_file_for(
      ".~lock.other.docx#",
      "document.docx"
    ));
    assert!(!is_temporary_lock_file_for(
      "document.docx",
      "document.docx"
    ));
  }

  #[test]
  fn sanitize_file_name_preserves_the_expected_office_extension() {
    for (file_type, extension) in [
      (DesktopEditFileType::Docx, "docx"),
      (DesktopEditFileType::Xlsx, "xlsx"),
      (DesktopEditFileType::Pptx, "pptx"),
    ] {
      assert_eq!(
        sanitize_file_name(&format!("brief.{extension}"), file_type),
        format!("brief.{extension}")
      );
      assert_eq!(
        sanitize_file_name("Agreement", file_type),
        format!("Agreement.{extension}")
      );
      assert_eq!(
        sanitize_file_name("../payload.bat", file_type),
        format!("payload.bat.{extension}")
      );
    }
  }

  #[test]
  fn office_download_content_type_matches_expected_kind() {
    assert!(is_allowed_download_content_type(
      DesktopEditFileType::Docx,
      DOCX_MIME_TYPE
    ));
    assert!(is_allowed_download_content_type(
      DesktopEditFileType::Docx,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary"
    ));
    assert!(is_allowed_download_content_type(
      DesktopEditFileType::Xlsx,
      XLSX_MIME_TYPE
    ));
    assert!(is_allowed_download_content_type(
      DesktopEditFileType::Pptx,
      PPTX_MIME_TYPE
    ));
    assert!(is_allowed_download_content_type(
      DesktopEditFileType::Docx,
      "application/octet-stream"
    ));
    assert!(is_allowed_download_content_type(
      DesktopEditFileType::Pptx,
      "binary/octet-stream"
    ));
    assert!(!is_allowed_download_content_type(
      DesktopEditFileType::Xlsx,
      DOCX_MIME_TYPE
    ));
    assert!(!is_allowed_download_content_type(
      DesktopEditFileType::Docx,
      "text/html"
    ));
  }

  #[test]
  fn office_download_bytes_require_kind_specific_archive_entries() {
    assert!(
      validate_office_download_bytes(
        DesktopEditFileType::Docx,
        &zip_bytes(&[
          CONTENT_TYPES_ENTRY,
          DesktopEditFileType::Docx.main_part_path(),
        ])
      )
      .is_ok()
    );
    assert!(
      validate_office_download_bytes(
        DesktopEditFileType::Xlsx,
        &zip_bytes(&[
          CONTENT_TYPES_ENTRY,
          DesktopEditFileType::Xlsx.main_part_path(),
        ])
      )
      .is_ok()
    );
    assert!(
      validate_office_download_bytes(
        DesktopEditFileType::Pptx,
        &zip_bytes(&[
          CONTENT_TYPES_ENTRY,
          DesktopEditFileType::Pptx.main_part_path(),
        ])
      )
      .is_ok()
    );
    assert!(
      validate_office_download_bytes(
        DesktopEditFileType::Docx,
        &zip_bytes(&["payload.bin"])
      )
      .is_err()
    );
    assert!(
      validate_office_download_bytes(DesktopEditFileType::Docx, b"#!/bin/sh\n")
        .is_err()
    );
  }

  #[tokio::test]
  async fn reused_managed_copy_is_renamed_to_sanitized_office_name() {
    let dir = std::env::temp_dir()
      .join(format!("stella-desktop-test-{}", uuid::Uuid::new_v4()));
    let source = dir.join("Agreement");
    let target = dir.join("Agreement.docx");

    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(&source, b"test").await.unwrap();

    let aligned_path =
      align_managed_copy_file_name(&source.to_string_lossy(), "Agreement.docx")
        .await
        .unwrap();

    assert_eq!(aligned_path, target.to_string_lossy());
    assert!(!source.exists());
    assert!(target.exists());

    tokio::fs::remove_dir_all(dir).await.unwrap();
  }

  #[tokio::test]
  async fn persist_sessions_keeps_unconfirmed_sessions() {
    let path = std::env::temp_dir()
      .join(format!(
        "stella-desktop-sessions-{}.json",
        uuid::Uuid::new_v4()
      ))
      .join("sessions.json");
    let mut manager = SessionManager::new();
    manager.store_path = path.clone();
    manager.unconfirmed_sessions.insert(
      "session-unconfirmed".to_string(),
      persisted_session_for_test("session-unconfirmed"),
    );

    manager.persist_sessions().await;

    let loaded = session_store::load_session_store(&path).await;
    let session_ids: Vec<String> = loaded
      .sessions
      .into_iter()
      .map(|session| session.id)
      .collect();
    assert_eq!(session_ids, vec!["session-unconfirmed"]);

    tokio::fs::remove_file(path).await.unwrap();
  }

  #[tokio::test]
  async fn document_account_identity_and_origin_persist() {
    let path = std::env::temp_dir()
      .join(format!(
        "stella-desktop-sessions-{}.json",
        uuid::Uuid::new_v4()
      ))
      .join("sessions.json");
    let mut manager = SessionManager::new();
    manager.store_path = path.clone();
    let account = LinkedAccountSnapshot {
      email: "user@example.com".to_string(),
      name: Some("Test User".to_string()),
      verified_at: "2026-08-31T10:00:00Z".to_string(),
    };

    manager.trust_self_host_connection_for_test(
      "https://selfhost.example".to_string(),
      "https://api.selfhost.example".to_string(),
    );
    manager
      .link_account(account, Some("https://selfhost.example".to_string()))
      .await
      .unwrap();

    assert_eq!(
      manager
        .linked_account
        .as_ref()
        .map(|value| value.email.as_str()),
      Some("user@example.com")
    );
    assert_eq!(
      manager.linked_self_host_origin(),
      Some("https://selfhost.example")
    );
    let loaded = session_store::load_session_store(&path).await;
    assert_eq!(
      loaded
        .linked_account
        .as_ref()
        .map(|value| value.email.as_str()),
      Some("user@example.com")
    );
    assert_eq!(
      loaded.linked_account_web_origin.as_deref(),
      Some("https://selfhost.example")
    );

    tokio::fs::remove_file(path).await.unwrap();
  }

  #[tokio::test]
  async fn the_selected_self_host_keeps_its_api_and_origin_together() {
    let path = std::env::temp_dir()
      .join(format!(
        "stella-selected-selfhost-{}.json",
        uuid::Uuid::new_v4()
      ))
      .join("sessions.json");
    let mut manager = SessionManager::new();
    manager.store_path = path.clone();
    manager.trust_self_host_connection_for_test(
      "https://selfhost.example".into(),
      "https://api.first.example".into(),
    );
    manager.trust_self_host_connection_for_test(
      "https://selfhost.example".into(),
      "https://api.selected.example".into(),
    );
    let selected = manager.selected_self_host_connection().unwrap();
    assert_eq!(selected.api_base_url, "https://api.selected.example");
    assert_eq!(selected.web_origin, "https://selfhost.example");
    manager.persist_sessions_result().await.unwrap();
    let mut restored = SessionManager::new();
    restored.store_path = path.clone();
    restored.initialize().await;
    let selected = restored.selected_self_host_connection().unwrap();
    assert_eq!(selected.api_base_url, "https://api.selected.example");
    assert_eq!(selected.web_origin, "https://selfhost.example");
    tokio::fs::remove_file(path).await.unwrap();
  }

  #[tokio::test]
  async fn document_relink_preserves_the_account_origin() {
    let path = std::env::temp_dir()
      .join(format!(
        "stella-desktop-account-origin-{}.json",
        uuid::Uuid::new_v4()
      ))
      .join("sessions.json");
    let mut manager = SessionManager::new();
    manager.store_path = path.clone();
    manager.trust_self_host_connection_for_test(
      "https://first.example".to_string(),
      "https://api.first.example".to_string(),
    );
    let account = LinkedAccountSnapshot {
      email: "user@example.com".to_string(),
      name: Some("Test User".to_string()),
      verified_at: "2026-08-31T10:00:00Z".to_string(),
    };
    manager
      .link_account(account.clone(), Some("https://first.example".to_string()))
      .await
      .unwrap();

    // A relink with changed profile details keeps the stored origin.
    let renamed = LinkedAccountSnapshot {
      name: Some("Renamed User".to_string()),
      ..account
    };
    manager.sync_linked_account(Some(&renamed)).await.unwrap();
    assert_eq!(
      manager.linked_self_host_origin(),
      Some("https://first.example")
    );

    tokio::fs::remove_file(path).await.unwrap();
  }

  #[tokio::test]
  async fn active_session_supersedes_unconfirmed_copy_on_persist() {
    let path = std::env::temp_dir()
      .join(format!(
        "stella-desktop-sessions-{}.json",
        uuid::Uuid::new_v4()
      ))
      .join("sessions.json");
    let mut manager = SessionManager::new();
    manager.store_path = path.clone();
    let persisted = persisted_session_for_test("session-restored");
    manager
      .unconfirmed_sessions
      .insert(persisted.id.clone(), persisted.clone());
    manager.sessions.insert(
      persisted.id.clone(),
      desktop_session_for_test(persisted, "restored-token"),
    );

    manager.persist_sessions().await;

    let loaded = session_store::load_session_store(&path).await;
    assert_eq!(loaded.sessions.len(), 1);
    assert_eq!(loaded.sessions[0].id, "session-restored");

    tokio::fs::remove_file(path).await.unwrap();
  }

  fn zip_bytes(entries: &[&str]) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    let options =
      SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    for entry in entries {
      archive.start_file(entry, options).unwrap();
      archive.write_all(b"test").unwrap();
    }

    archive.finish().unwrap().into_inner()
  }

  #[test]
  fn sanitize_path_segment_replaces_separators_consistently() {
    // Pure-string semantics — identical on Linux, macOS and Windows.
    assert_eq!(sanitize_path_segment("a/b"), "a_b");
    assert_eq!(sanitize_path_segment("a\\b"), "a_b");
    assert_eq!(sanitize_path_segment("a..b"), "a__b");
    assert_eq!(sanitize_path_segment("session-1234"), "session-1234");
  }

  #[test]
  fn sanitize_path_segment_neutralises_traversal_and_absolute_paths() {
    let traversal = sanitize_path_segment("../foo");
    assert!(!traversal.contains(".."));
    assert!(!traversal.contains('/'));

    let absolute = sanitize_path_segment("/etc/passwd");
    assert!(!absolute.starts_with('/'));
    assert!(!absolute.contains('/'));

    let dotdot = sanitize_path_segment("..");
    assert!(!dotdot.contains('.'));
  }

  #[test]
  fn sanitize_path_segment_strips_trailing_dots_and_spaces() {
    // Windows treats trailing dots and spaces as if absent.
    assert_eq!(sanitize_path_segment("foo."), "foo");
    assert_eq!(sanitize_path_segment("foo "), "foo");
    assert_eq!(sanitize_path_segment("foo. . "), "foo");
  }

  #[test]
  fn sanitize_path_segment_replaces_all_ascii_control_chars() {
    // Windows forbids every ASCII control character (0x00–0x1F, 0x7F)
    // in filenames, not just the obvious newline/tab/null.
    assert_eq!(sanitize_path_segment("a\u{1}b"), "a_b");
    assert_eq!(sanitize_path_segment("a\u{7f}b"), "a_b");
    assert_eq!(sanitize_path_segment("\tfoo\nbar\r"), "_foo_bar_");
    assert_eq!(sanitize_path_segment("a\u{0}b"), "a_b");
  }

  #[test]
  fn sanitize_path_segment_falls_back_when_input_strips_to_empty() {
    assert_eq!(sanitize_path_segment(""), "session");
    assert_eq!(sanitize_path_segment("."), "session");
    assert_eq!(sanitize_path_segment("   "), "session");
  }

  #[test]
  fn diagnostics_export_redacts_private_session_and_account_data() {
    let mut manager = SessionManager::new();
    manager.support_root = PathBuf::from("/Users/alice/Client Matter/support");
    manager.edit_root = PathBuf::from("/Users/alice/Client Matter/editing");
    manager.linked_account = Some(LinkedAccountSnapshot {
      email: "attorney@example.com".to_string(),
      name: Some("Private Attorney".to_string()),
      verified_at: "private-verification-time".to_string(),
    });
    manager.store_load_issue = Some(StoreLoadIssue::InvalidStore);
    manager.update.base_url = Some("https://private-api.example.com".to_string());
    manager.update.channel = Some("secret-channel".to_string());
    manager.update.current_hash = Some("private-current-hash".to_string());
    manager.update.latest_hash = Some("private-latest-hash".to_string());
    manager.update.latest_version = Some("9.9.9".to_string());
    manager.update.status_message = "private status details".to_string();
    manager.update.update_available = true;

    let mut persisted = persisted_session_for_test("private-session-id");
    persisted.file_name = "Client Matter.docx".to_string();
    persisted.file_path = "/Users/alice/Client Matter.docx".to_string();
    persisted.last_checkpoint_at = Some("private-checkpoint-time".to_string());
    persisted.last_error =
      Some("upload failed for /Users/alice/Client Matter.docx".to_string());
    persisted.pending_finalize = true;
    persisted.status = SessionStatus::Error;
    persisted.takeover_detected = true;
    manager.sessions.insert(
      persisted.id.clone(),
      desktop_session_for_test(persisted, "private-session-token"),
    );
    manager
      .cleanup_paths
      .insert("/Users/alice/Client Matter/orphan.docx".to_string());

    let diagnostics = manager.get_diagnostics_text();
    let parsed: serde_json::Value = serde_json::from_str(&diagnostics).unwrap();

    for private_value in [
      "/Users/alice",
      "Client Matter",
      "attorney@example.com",
      "Private Attorney",
      "private-verification-time",
      "private-api.example.com",
      "secret-channel",
      "private-current-hash",
      "private-latest-hash",
      "private status details",
      "private-session-id",
      "private-session-token",
      "private-checkpoint-time",
      "upload failed",
    ] {
      assert!(!diagnostics.contains(private_value));
    }

    assert!(parsed.get("linkedAccount").is_none());
    assert!(parsed["app"].get("supportRoot").is_none());
    assert!(parsed["app"].get("temporaryWorkingCopiesRoot").is_none());
    assert!(parsed["update"].get("baseUrl").is_none());
    assert!(parsed["update"].get("channel").is_none());
    assert!(parsed["update"].get("currentHash").is_none());
    assert!(parsed["update"].get("latestHash").is_none());
    assert!(parsed["update"].get("statusMessage").is_none());
    assert_eq!(parsed["linkedAccountPresent"], true);
    assert_eq!(parsed["storeLoadIssue"], "invalidStore");
    assert_eq!(
      parsed["notificationPreferences"],
      serde_json::json!({
        "documentReady": true,
        "revisionCreated": true,
        "syncIssues": true,
      })
    );
    assert_eq!(parsed["update"]["configured"], true);
    assert_eq!(parsed["update"]["channelConfigured"], true);
    assert_eq!(parsed["update"]["latestVersion"], "9.9.9");
    assert_eq!(parsed["sessions"]["total"], 1);
    assert_eq!(parsed["sessions"]["byStatus"]["error"], 1);
    assert_eq!(parsed["sessions"]["withLastCheckpoint"], 1);
    assert_eq!(parsed["sessions"]["withLastError"], 1);
    assert_eq!(parsed["sessions"]["pendingFinalize"], 1);
    assert_eq!(parsed["sessions"]["takeoverDetected"], 1);
    assert_eq!(parsed["cleanupPathsQueued"], 1);
    assert!(parsed["managedPolicy"]["updatesDisabled"].is_boolean());
    assert!(parsed["managedPolicy"]["serverConfigured"].is_boolean());
  }

  #[test]
  fn trust_lookup_canonicalizes_api_base_url_like_approval() {
    let mut manager = SessionManager::new();
    manager.trust_self_host_connection_for_test(
      "https://web.example".to_string(),
      "https://api.example".to_string(),
    );

    // A lookup using a canonical-equivalent form (explicit default port,
    // uppercase host, trailing slash) must still match the stored connection.
    assert!(manager.is_trusted_self_host_connection(
      "https://web.example",
      "https://API.example:443/",
    ));
    assert!(manager.is_trusted_self_host_api_base_url("https://API.example:443/"));
    assert!(
      !manager.is_trusted_self_host_connection(
        "https://web.example",
        "https://other.example"
      )
    );
  }
}

#[cfg(feature = "allocation-tests")]
#[path = "session_allocation_harness.rs"]
pub mod allocation_harness;
