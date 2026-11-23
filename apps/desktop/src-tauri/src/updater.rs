// Auto-updater wiring.
//
// The Tauri updater plugin fetches `latest.json`; this module owns bounded
// package download, signature verification, scheduling, and user feedback:
//
// - On startup, run a delayed background check (so the launch path
//   isn't blocked by network I/O).
// - While the app keeps running, repeat that background check so
//   long-lived desktop sessions still pick up new releases.
// - Settings → About checks without installing, shows what it found,
//   and installs through that same check when the user asks. The tray's
//   "Check for updates" opens About and runs that check there.
// - When an update is found and no desktop edit sessions are
//   active, download + install + relaunch. The installer handles
//   the binary swap; `crate::relaunch` owns the hand-over to the
//   new binary.
// - When an administrator set `DisableUpdates`, nothing checks: the
//   organization deploys new versions itself.
//
// What the updater is doing lives in one place, `UPDATER`: every path
// above moves its state, Settings reads it with `updater_state` and follows
// `UPDATER_STATE_EVENT`, so a download started anywhere shows on About
// whenever the page is opened.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use reqwest::header::{ACCEPT, HeaderValue};
use tauri::{AppHandle, Emitter, async_runtime};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::http_client::{DesktopHttpClient, HttpClientOptions};
use crate::session_manager::SessionManager;

const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(10);
const WAKE_CHECK_TICK: Duration = Duration::from_secs(30);
const MAX_UPDATE_PACKAGE_BYTES: usize = 256 * 1024 * 1024;
/// Download progress reaches the window at most this often; every other
/// state change is announced at once.
const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(250);
/// The event every updater state change is announced with.
pub const UPDATER_STATE_EVENT: &str = "updater-state";
static LAST_CHECK: AtomicU64 = AtomicU64::new(0);
static UPDATER: UpdaterBoard = UpdaterBoard::new();

const BACKGROUND_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

// `Installed` means the exit of this process has been requested and
// the relaunch is under way; callers must not schedule further work.
// `Disabled` means managed policy turned in-app updates off.
#[derive(Debug)]
pub enum CheckOutcome {
  Deferred { version: String },
  UpToDate,
  Installed { version: String },
  Failed(String),
  Disabled,
}

pub fn schedule_startup_check(handle: AppHandle, manager: Arc<Mutex<SessionManager>>) {
  if crate::managed_policy::current().updates_disabled {
    tracing::info!("in-app updates are turned off by managed policy");
    UPDATER.set(&TauriHost(&handle), UpdaterState::Managed);
    return;
  }
  if let Some(path) = last_check_path() {
    match std::fs::read_to_string(path) {
      Ok(value) => match value.trim().parse() {
        Ok(timestamp) => LAST_CHECK.store(timestamp, Ordering::Relaxed),
        Err(error) => tracing::warn!(%error, "updater timestamp unreadable"),
      },
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => tracing::warn!(%error, "updater timestamp unavailable"),
    }
  }
  async_runtime::spawn(async move {
    tokio::time::sleep(STARTUP_CHECK_DELAY).await;

    loop {
      let now = unix_seconds(SystemTime::now());
      let last_check = LAST_CHECK.load(Ordering::Relaxed);
      if cfg!(debug_assertions) || !check_due(last_check, now) {
        tokio::time::sleep(WAKE_CHECK_TICK).await;
        continue;
      }
      let sessions = &*manager;
      let active_edit_sessions =
        move || async move { sessions.lock().await.has_active_edit_sessions() };

      match run_check(&handle, active_edit_sessions).await {
        CheckOutcome::Deferred { version } => {
          tracing::debug!(
              version = %version,
              "background updater: deferred while desktop edits are active"
          );
        }
        CheckOutcome::UpToDate => {
          tracing::debug!("background updater: up to date");
        }
        CheckOutcome::Installed { version } => {
          tracing::info!(version = %version, "background updater: installed, relaunching");
          return;
        }
        CheckOutcome::Failed(err) => {
          tracing::warn!(error = %err, "background updater check failed");
        }
        CheckOutcome::Disabled => return,
      }

      tokio::time::sleep(WAKE_CHECK_TICK).await;
    }
  });
}

fn unix_seconds(time: SystemTime) -> u64 {
  time
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs()
}

fn check_due(last_check: u64, now: u64) -> bool {
  last_check == 0
    || now < last_check
    || now - last_check >= BACKGROUND_CHECK_INTERVAL.as_secs()
}

fn last_check_path() -> Option<std::path::PathBuf> {
  dirs::data_dir().map(|root| {
    root
      .join(crate::config::APP_DATA_DIR_NAME)
      .join("updater-last-check")
  })
}

fn record_check(now: u64) {
  LAST_CHECK.store(now, Ordering::Relaxed);
  let Some(path) = last_check_path() else {
    tracing::warn!("updater timestamp has no data directory");
    return;
  };
  let result = crate::local_store::create_private_dir(
    path.parent().expect("updater data directory"),
  )
  .map_err(|error| error.to_string())
  .and_then(|()| {
    crate::local_store::write_private_atomic(&path, now.to_string().as_bytes())
  });
  if let Err(error) = result {
    tracing::warn!(%error, "updater timestamp could not be saved");
  }
}

/// Returns true when callers must stop because the app is relaunching.
pub async fn check_on_handoff(
  handle: &AppHandle,
  manager: &Mutex<SessionManager>,
) -> bool {
  if cfg!(debug_assertions) {
    return false;
  }
  let active_edit_sessions =
    move || async move { manager.lock().await.has_active_edit_sessions() };
  match run_check(handle, active_edit_sessions).await {
    CheckOutcome::Installed { .. } => true,
    CheckOutcome::Failed(error) => {
      tracing::warn!(%error, "handoff updater check failed");
      false
    }
    CheckOutcome::Deferred { .. } | CheckOutcome::UpToDate | CheckOutcome::Disabled => {
      false
    }
  }
}

/// What became of a found update before its install: deferred because a
/// document is open for editing, failed to download, or downloaded and
/// still clear to install.
enum PreparedInstall<Package> {
  Deferred,
  DownloadFailed(String),
  Ready(Package),
}

/// Asks whether desktop edits are active, downloads, and asks again right
/// before the install: a document can open while the package downloads.
async fn prepare_install<Package, Active, ActiveFuture, Download, DownloadFuture>(
  active_edit_sessions: &Active,
  download: Download,
) -> PreparedInstall<Package>
where
  Active: Fn() -> ActiveFuture,
  ActiveFuture: Future<Output = bool>,
  Download: FnOnce() -> DownloadFuture,
  DownloadFuture: Future<Output = Result<Package, String>>,
{
  if active_edit_sessions().await {
    return PreparedInstall::Deferred;
  }
  let package = match download().await {
    Ok(package) => package,
    Err(err) => return PreparedInstall::DownloadFailed(err),
  };
  if active_edit_sessions().await {
    return PreparedInstall::Deferred;
  }
  PreparedInstall::Ready(package)
}

/// `active_edit_sessions` is asked when an update is found and again right
/// before it installs, so an edit that starts during the download defers it.
/// A check or install already running finishes first; this one then runs.
pub async fn run_check<Active, ActiveFuture>(
  handle: &AppHandle,
  active_edit_sessions: Active,
) -> CheckOutcome
where
  Active: Fn() -> ActiveFuture,
  ActiveFuture: Future<Output = bool>,
{
  let host = TauriHost(handle);
  if crate::managed_policy::current().updates_disabled {
    UPDATER.set(&host, UpdaterState::Managed);
    return CheckOutcome::Disabled;
  }
  UPDATER.run_check(&host, &active_edit_sessions).await
}

/// Settings → About: whether a newer version exists. Installs nothing. While
/// another check or install runs, whoever started it, the answer is what that
/// one is doing.
pub async fn check_from_settings(handle: &AppHandle) -> UpdaterSnapshot {
  let host = TauriHost(handle);
  if crate::managed_policy::current().updates_disabled {
    UPDATER.set(&host, UpdaterState::Managed);
    return UPDATER.snapshot();
  }
  UPDATER.check_unless_busy(&host).await
}

/// Settings → About: installs through the check the background schedule runs,
/// so active desktop edits defer it the same way. While another check or
/// install runs, the answer is what that one is doing.
pub async fn install_from_settings<Active, ActiveFuture>(
  handle: &AppHandle,
  active_edit_sessions: Active,
) -> UpdaterSnapshot
where
  Active: Fn() -> ActiveFuture,
  ActiveFuture: Future<Output = bool>,
{
  let host = TauriHost(handle);
  if crate::managed_policy::current().updates_disabled {
    UPDATER.set(&host, UpdaterState::Managed);
    return UPDATER.snapshot();
  }
  UPDATER
    .install_unless_busy(&host, &active_edit_sessions)
    .await
}

/// What the updater is doing now, for Settings and diagnostics.
pub fn current() -> UpdaterSnapshot {
  UPDATER.snapshot()
}

fn build_updater(handle: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
  let exit_handle = handle.clone();
  handle
    .updater_builder()
    .on_before_exit(move || {
      crate::desktop_crash::clean_exit(&exit_handle);
      exit_handle.cleanup_before_exit();
    })
    .build()
    .map_err(|err| err.to_string())
}

// What the updater is doing, whoever started it: the startup check, the
// background schedule, a handoff, the tray or Settings. Settings → About
// renders it; the webview reads it through the generated desktop RPC
// contract. A download's `totalBytes` is null when the server does not say
// how large the package is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum UpdaterState {
  Idle,
  Checking,
  UpToDate,
  Available {
    version: String,
  },
  Downloading {
    version: String,
    #[serde(rename = "receivedBytes")]
    #[cfg_attr(test, ts(type = "number"))]
    received_bytes: u64,
    #[serde(rename = "totalBytes")]
    #[cfg_attr(test, ts(type = "number | null"))]
    total_bytes: Option<u64>,
  },
  Installing {
    version: String,
  },
  Deferred {
    version: String,
  },
  Failed {
    during: UpdaterStep,
  },
  Managed,
}

// Which part of the updater's work failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum UpdaterStep {
  Check,
  Install,
}

// The updater's state with its revision: every change raises the revision,
// so a window keeps the newest of the answers and events that reach it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UpdaterSnapshot {
  #[cfg_attr(test, ts(type = "number"))]
  pub revision: u64,
  pub state: UpdaterState,
}

/// What a check and an install need from the platform. The app's is
/// `TauriHost`; tests drive the same transitions with a fake.
trait UpdaterHost: Sync {
  type Update: Send + Sync;
  type Package: Send;

  /// Asks the release feed for a newer version.
  fn find(&self) -> impl Future<Output = Result<Option<Self::Update>, String>> + Send;
  fn version(update: &Self::Update) -> String;
  /// Downloads and verifies the package, reporting the bytes received so far
  /// and the total when the server names it.
  fn download<'a>(
    &'a self,
    update: &'a Self::Update,
    progress: &'a (dyn Fn(u64, Option<u64>) + Send + Sync),
  ) -> impl Future<Output = Result<Self::Package, String>> + Send + 'a;
  fn install(&self, update: &Self::Update, package: &Self::Package) -> Result<(), String>;
  fn relaunch(&self) -> Result<(), String>;
  /// Records when the feed was last asked, for the background schedule.
  fn record_check(&self);
  /// Hands crash reporting back after an update that did not install.
  fn resume_after_failed_update(&self);
  fn notify(&self, title: &str, body: &str);
  /// Tells the windows that the updater's state changed.
  fn announce(&self, snapshot: &UpdaterSnapshot);
}

struct TauriHost<'a>(&'a AppHandle);

impl UpdaterHost for TauriHost<'_> {
  type Update = tauri_plugin_updater::Update;
  type Package = VerifiedUpdatePackage;

  fn find(&self) -> impl Future<Output = Result<Option<Self::Update>, String>> + Send {
    async move {
      build_updater(self.0)?
        .check()
        .await
        .map_err(|err| err.to_string())
    }
  }

  fn version(update: &Self::Update) -> String {
    update.version.clone()
  }

  fn download<'a>(
    &'a self,
    update: &'a Self::Update,
    progress: &'a (dyn Fn(u64, Option<u64>) + Send + Sync),
  ) -> impl Future<Output = Result<Self::Package, String>> + Send + 'a {
    download_update_package(update, progress)
  }

  fn install(&self, update: &Self::Update, package: &Self::Package) -> Result<(), String> {
    crate::local_store::install_update(update, package)
  }

  fn relaunch(&self) -> Result<(), String> {
    // On Windows the plugin has already handed off to the installer and
    // exited; this only runs where the bundle was swapped in place.
    crate::relaunch::after_update(self.0)
  }

  fn record_check(&self) {
    record_check(unix_seconds(SystemTime::now()));
  }

  fn resume_after_failed_update(&self) {
    #[cfg(windows)]
    crate::desktop_crash::resume_after_failed_update(self.0);
  }

  fn notify(&self, title: &str, body: &str) {
    notify(self.0, title, body);
  }

  fn announce(&self, snapshot: &UpdaterSnapshot) {
    crate::logging::best_effort(
      self
        .0
        .emit_to(crate::SETTINGS_WINDOW_LABEL, UPDATER_STATE_EVENT, snapshot),
      "updater state change was not announced",
    );
  }
}

struct Published {
  snapshot: UpdaterSnapshot,
  announced_at: Option<Instant>,
}

/// The updater's one state, and the lock that keeps two checks or installs
/// from running at once.
struct UpdaterBoard {
  operation: Mutex<()>,
  published: std::sync::Mutex<Published>,
}

impl UpdaterBoard {
  const fn new() -> Self {
    Self {
      operation: Mutex::const_new(()),
      published: std::sync::Mutex::new(Published {
        snapshot: UpdaterSnapshot {
          revision: 0,
          state: UpdaterState::Idle,
        },
        announced_at: None,
      }),
    }
  }

  fn snapshot(&self) -> UpdaterSnapshot {
    self
      .published
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .snapshot
      .clone()
  }

  /// Records `state` and returns the snapshot to announce. Download progress
  /// within `PROGRESS_EVENT_INTERVAL` of the last announcement is recorded
  /// but not announced; the last step of a download, and every other change,
  /// always is.
  fn record(&self, state: UpdaterState, now: Instant) -> Option<UpdaterSnapshot> {
    let mut published = self
      .published
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    let progress_step = matches!(
      (&published.snapshot.state, &state),
      (
        UpdaterState::Downloading { version: before, .. },
        UpdaterState::Downloading { version: after, received_bytes, total_bytes },
      ) if before == after && Some(*received_bytes) != *total_bytes
    );
    let recently_announced = published
      .announced_at
      .is_some_and(|at| now.saturating_duration_since(at) < PROGRESS_EVENT_INTERVAL);
    let revision = published.snapshot.revision + 1;
    published.snapshot = UpdaterSnapshot { revision, state };
    if progress_step && recently_announced {
      return None;
    }
    published.announced_at = Some(now);
    Some(published.snapshot.clone())
  }

  fn set<Host: UpdaterHost>(&self, host: &Host, state: UpdaterState) {
    if let Some(snapshot) = self.record(state, Instant::now()) {
      host.announce(&snapshot);
    }
  }

  async fn run_check<Host, Active, ActiveFuture>(
    &self,
    host: &Host,
    active_edit_sessions: &Active,
  ) -> CheckOutcome
  where
    Host: UpdaterHost,
    Active: Fn() -> ActiveFuture,
    ActiveFuture: Future<Output = bool>,
  {
    let _operation = self.operation.lock().await;
    self.check_and_install(host, active_edit_sessions).await
  }

  async fn check_unless_busy<Host: UpdaterHost>(&self, host: &Host) -> UpdaterSnapshot {
    let Ok(_operation) = self.operation.try_lock() else {
      return self.snapshot();
    };
    self.set(host, UpdaterState::Checking);
    let found = match host.find().await {
      Ok(Some(update)) => UpdaterState::Available {
        version: Host::version(&update),
      },
      Ok(None) => UpdaterState::UpToDate,
      Err(error) => {
        tracing::warn!(%error, "settings updater check failed");
        UpdaterState::Failed {
          during: UpdaterStep::Check,
        }
      }
    };
    self.set(host, found);
    self.snapshot()
  }

  async fn install_unless_busy<Host, Active, ActiveFuture>(
    &self,
    host: &Host,
    active_edit_sessions: &Active,
  ) -> UpdaterSnapshot
  where
    Host: UpdaterHost,
    Active: Fn() -> ActiveFuture,
    ActiveFuture: Future<Output = bool>,
  {
    let Ok(_operation) = self.operation.try_lock() else {
      return self.snapshot();
    };
    if let CheckOutcome::Failed(error) =
      self.check_and_install(host, active_edit_sessions).await
    {
      tracing::warn!(%error, "settings update install failed");
    }
    self.snapshot()
  }

  /// Runs with `operation` held.
  async fn check_and_install<Host, Active, ActiveFuture>(
    &self,
    host: &Host,
    active_edit_sessions: &Active,
  ) -> CheckOutcome
  where
    Host: UpdaterHost,
    Active: Fn() -> ActiveFuture,
    ActiveFuture: Future<Output = bool>,
  {
    let install_failed = || UpdaterState::Failed {
      during: UpdaterStep::Install,
    };
    host.record_check();
    self.set(host, UpdaterState::Checking);
    let update = match host.find().await {
      Ok(Some(update)) => update,
      Ok(None) => {
        self.set(host, UpdaterState::UpToDate);
        return CheckOutcome::UpToDate;
      }
      Err(err) => {
        self.set(
          host,
          UpdaterState::Failed {
            during: UpdaterStep::Check,
          },
        );
        return CheckOutcome::Failed(err);
      }
    };

    let version = Host::version(&update);
    let progress = |received_bytes: u64, total_bytes: Option<u64>| {
      self.set(
        host,
        UpdaterState::Downloading {
          version: version.clone(),
          received_bytes,
          total_bytes,
        },
      );
    };
    let prepared = prepare_install(active_edit_sessions, || async {
      host.notify(
        "stella update available",
        &format!("Installing v{version}…"),
      );
      progress(0, None);
      host.download(&update, &progress).await
    })
    .await;
    let package = match prepared {
      PreparedInstall::Ready(package) => package,
      PreparedInstall::Deferred => {
        host.notify(
          "stella update available",
          "stella desktop will update after active desktop edits are finished.",
        );
        self.set(
          host,
          UpdaterState::Deferred {
            version: version.clone(),
          },
        );
        return CheckOutcome::Deferred { version };
      }
      PreparedInstall::DownloadFailed(err) => {
        host.resume_after_failed_update();
        host.notify("stella update failed", &err);
        self.set(host, install_failed());
        return CheckOutcome::Failed(err);
      }
    };

    self.set(
      host,
      UpdaterState::Installing {
        version: version.clone(),
      },
    );
    if let Err(err) = host.install(&update, &package) {
      host.resume_after_failed_update();
      host.notify("stella update failed", &err);
      self.set(host, install_failed());
      return CheckOutcome::Failed(err);
    }

    if let Err(err) = host.relaunch() {
      host.notify(
        "stella update installed",
        "Quit and reopen stella desktop to finish updating.",
      );
      self.set(host, install_failed());
      return CheckOutcome::Failed(format!(
        "v{version} installed but the relaunch failed: {err}"
      ));
    }

    CheckOutcome::Installed { version }
  }
}

fn updater_public_key() -> Result<String, String> {
  let config: serde_json::Value =
    serde_json::from_str(include_str!("../tauri.conf.json"))
      .map_err(|error| format!("Updater configuration is invalid: {error}"))?;
  config
    .pointer("/plugins/updater/pubkey")
    .and_then(serde_json::Value::as_str)
    .map(str::to_owned)
    .ok_or_else(|| "Updater public key is missing".to_string())
}

fn decode_base64_text(value: &str) -> Result<String, String> {
  let decoded = base64::engine::general_purpose::STANDARD
    .decode(value)
    .map_err(|error| format!("Updater signature encoding is invalid: {error}"))?;
  String::from_utf8(decoded)
    .map_err(|error| format!("Updater signature encoding is not UTF-8: {error}"))
}

fn signed_version(trusted_comment: &str) -> Option<&str> {
  trusted_comment
    .split('\t')
    .find_map(|field| field.strip_prefix("version:"))
}

/// An update package whose signature this module checked; only
/// `verify_update_package` constructs one, so nothing unverified installs.
pub struct VerifiedUpdatePackage(Vec<u8>);

impl VerifiedUpdatePackage {
  pub fn as_bytes(&self) -> &[u8] {
    &self.0
  }
}

fn verify_update_package(
  package: Vec<u8>,
  signature: &str,
  announced_version: &str,
) -> Result<VerifiedUpdatePackage, String> {
  verify_signed_package(
    &updater_public_key()?,
    &package,
    signature,
    announced_version,
  )?;
  Ok(VerifiedUpdatePackage(package))
}

/// Verifies `package` against `public_key` and requires the signature's
/// trusted comment to bind `announced_version`.
fn verify_signed_package(
  public_key: &str,
  package: &[u8],
  signature: &str,
  announced_version: &str,
) -> Result<(), String> {
  let public_key = PublicKey::decode(&decode_base64_text(public_key)?)
    .map_err(|error| format!("Updater public key is invalid: {error}"))?;
  let signature = Signature::decode(&decode_base64_text(signature)?)
    .map_err(|error| format!("Updater signature is invalid: {error}"))?;
  public_key
    .verify(package, &signature, true)
    .map_err(|error| format!("Updater signature verification failed: {error}"))?;
  let signed = signed_version(signature.trusted_comment())
    .ok_or_else(|| "Updater signature does not bind a release version".to_string())?;
  if signed.trim_start_matches('v') != announced_version.trim_start_matches('v') {
    return Err(
      "Updater signature version does not match the announced release".to_string(),
    );
  }
  Ok(())
}

fn checked_update_size(current: usize, chunk: usize) -> Result<usize, String> {
  let next = current
    .checked_add(chunk)
    .ok_or_else(|| "Update package size overflowed".to_string())?;
  if next > MAX_UPDATE_PACKAGE_BYTES {
    return Err(format!(
      "Update package exceeds the {MAX_UPDATE_PACKAGE_BYTES} byte limit"
    ));
  }
  Ok(next)
}

async fn download_update_package(
  update: &tauri_plugin_updater::Update,
  progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<VerifiedUpdatePackage, String> {
  let mut headers = update.headers.clone();
  if !headers.contains_key(ACCEPT) {
    headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
  }
  let client = DesktopHttpClient::new(HttpClientOptions {
    timeout: update.timeout,
    redirect: reqwest::redirect::Policy::default(),
  })
  .map_err(|error| format!("Updater client failed: {error}"))?;
  let response = client
    .get(update.download_url.clone())
    .headers(headers)
    .send()
    .await
    .map_err(|error| format!("Update download failed: {error}"))?;
  if !response.status().is_success() {
    return Err(format!(
      "Update download returned HTTP {}",
      response.status().as_u16()
    ));
  }
  if let Some(content_length) = response.content_length()
    && content_length > MAX_UPDATE_PACKAGE_BYTES as u64
  {
    return Err(format!(
      "Update package exceeds the {MAX_UPDATE_PACKAGE_BYTES} byte limit"
    ));
  }

  let total = response.content_length();
  let mut package = Vec::new();
  let mut stream = response.bytes_stream();
  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(|error| format!("Update download failed: {error}"))?;
    checked_update_size(package.len(), chunk.len())?;
    package.extend_from_slice(&chunk);
    progress(package.len() as u64, total);
  }
  verify_update_package(package, &update.signature, &update.version)
}

fn notify(handle: &AppHandle, title: &str, body: &str) {
  if let Err(err) = handle
    .notification()
    .builder()
    .title(title)
    .body(body)
    .show()
  {
    tracing::warn!(error = %err, "updater notification failed");
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::AtomicUsize;

  /// Answers each "are desktop edits active?" in turn, counting the asks.
  fn edit_state(
    answers: &'static [bool],
  ) -> (Arc<AtomicUsize>, impl Fn() -> std::future::Ready<bool>) {
    let asked = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&asked);
    let active = move || {
      let index = counter.fetch_add(1, Ordering::SeqCst);
      std::future::ready(answers[index])
    };
    (asked, active)
  }

  #[tokio::test]
  async fn an_edit_opened_during_the_download_defers_the_install() {
    let (asked, active) = edit_state(&[false, true]);
    let downloads = AtomicUsize::new(0);
    let prepared = prepare_install(&active, || async {
      downloads.fetch_add(1, Ordering::SeqCst);
      Ok::<_, String>("package")
    })
    .await;

    assert!(matches!(prepared, PreparedInstall::Deferred));
    assert_eq!(downloads.load(Ordering::SeqCst), 1);
    assert_eq!(asked.load(Ordering::SeqCst), 2);
  }

  #[tokio::test]
  async fn an_edit_open_when_the_update_is_found_skips_the_download() {
    let (asked, active) = edit_state(&[true]);
    let downloads = AtomicUsize::new(0);
    let prepared = prepare_install(&active, || async {
      downloads.fetch_add(1, Ordering::SeqCst);
      Ok::<_, String>("package")
    })
    .await;

    assert!(matches!(prepared, PreparedInstall::Deferred));
    assert_eq!(downloads.load(Ordering::SeqCst), 0);
    assert_eq!(asked.load(Ordering::SeqCst), 1);
  }

  #[tokio::test]
  async fn no_edits_before_or_after_the_download_installs() {
    let (_, active) = edit_state(&[false, false]);
    let prepared =
      prepare_install(&active, || async { Ok::<_, String>("package") }).await;

    assert!(matches!(prepared, PreparedInstall::Ready("package")));
  }

  #[tokio::test]
  async fn a_failed_download_is_reported_without_asking_again() {
    let (asked, active) = edit_state(&[false]);
    let prepared =
      prepare_install(&active, || async { Err::<&str, _>("offline".to_string()) })
        .await;

    assert!(
      matches!(prepared, PreparedInstall::DownloadFailed(err) if err == "offline")
    );
    assert_eq!(asked.load(Ordering::SeqCst), 1);
  }

  /// A release feed and installer a test scripts. With `hold_download`, the
  /// download stops after its first chunk until the test calls `release`, so
  /// the test can look at the updater while an install is under way.
  struct FakeHost {
    found: Result<Option<&'static str>, String>,
    chunks: &'static [u64],
    total: Option<u64>,
    download_result: Result<(), String>,
    install_result: Result<(), String>,
    hold_download: bool,
    download_started: tokio::sync::Notify,
    download_released: tokio::sync::Notify,
    finds: AtomicUsize,
    downloads: AtomicUsize,
    installs: AtomicUsize,
    announced: std::sync::Mutex<Vec<UpdaterSnapshot>>,
  }

  impl FakeHost {
    fn offering(version: &'static str) -> Self {
      Self {
        found: Ok(Some(version)),
        chunks: &[100, 200, 300],
        total: Some(300),
        download_result: Ok(()),
        install_result: Ok(()),
        hold_download: false,
        download_started: tokio::sync::Notify::new(),
        download_released: tokio::sync::Notify::new(),
        finds: AtomicUsize::new(0),
        downloads: AtomicUsize::new(0),
        installs: AtomicUsize::new(0),
        announced: std::sync::Mutex::new(Vec::new()),
      }
    }

    fn announced(&self) -> Vec<UpdaterSnapshot> {
      self.announced.lock().unwrap().clone()
    }
  }

  impl UpdaterHost for FakeHost {
    type Update = &'static str;
    type Package = &'static str;

    fn find(&self) -> impl Future<Output = Result<Option<Self::Update>, String>> + Send {
      self.finds.fetch_add(1, Ordering::SeqCst);
      std::future::ready(self.found.clone())
    }

    fn version(update: &Self::Update) -> String {
      (*update).to_string()
    }

    fn download<'a>(
      &'a self,
      _update: &'a Self::Update,
      progress: &'a (dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> impl Future<Output = Result<Self::Package, String>> + Send + 'a {
      async move {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        for (index, received) in self.chunks.iter().enumerate() {
          progress(*received, self.total);
          if index == 0 && self.hold_download {
            self.download_started.notify_one();
            self.download_released.notified().await;
          }
        }
        self.download_result.clone().map(|()| "package")
      }
    }

    fn install(&self, _update: &Self::Update, package: &Self::Package) -> Result<(), String> {
      assert_eq!(*package, "package");
      self.installs.fetch_add(1, Ordering::SeqCst);
      self.install_result.clone()
    }

    fn relaunch(&self) -> Result<(), String> {
      Ok(())
    }

    fn record_check(&self) {}

    fn resume_after_failed_update(&self) {}

    fn notify(&self, _title: &str, _body: &str) {}

    fn announce(&self, snapshot: &UpdaterSnapshot) {
      self.announced.lock().unwrap().push(snapshot.clone());
    }
  }

  fn no_edits() -> std::future::Ready<bool> {
    std::future::ready(false)
  }

  fn downloading(version: &str, received_bytes: u64, total_bytes: Option<u64>) -> UpdaterState {
    UpdaterState::Downloading {
      version: version.to_string(),
      received_bytes,
      total_bytes,
    }
  }

  #[tokio::test]
  async fn an_install_started_in_the_background_shows_in_later_settings_reads() {
    let board = UpdaterBoard::new();
    let host = FakeHost {
      hold_download: true,
      ..FakeHost::offering("0.9.90")
    };

    let background = board.run_check(&host, &no_edits);
    let settings = async {
      host.download_started.notified().await;
      // Settings opened mid-download: the read and a check both name the
      // download, and the check asks the feed nothing.
      assert_eq!(board.snapshot().state, downloading("0.9.90", 100, Some(300)));
      let checked = board.check_unless_busy(&host).await;
      assert_eq!(checked.state, downloading("0.9.90", 100, Some(300)));
      assert_eq!(host.finds.load(Ordering::SeqCst), 1);
      // Install from Settings starts no second install either.
      let installed = board.install_unless_busy(&host, &no_edits).await;
      assert_eq!(installed.state, downloading("0.9.90", 100, Some(300)));
      host.download_released.notify_one();
    };
    let (outcome, ()) = tokio::time::timeout(Duration::from_secs(5), async {
      tokio::join!(background, settings)
    })
    .await
    .expect("a settings check never waits for the install it reports");

    assert!(matches!(outcome, CheckOutcome::Installed { version } if version == "0.9.90"));
    assert_eq!(host.downloads.load(Ordering::SeqCst), 1);
    assert_eq!(host.installs.load(Ordering::SeqCst), 1);
    assert_eq!(
      board.snapshot().state,
      UpdaterState::Installing {
        version: "0.9.90".into()
      }
    );
  }

  #[tokio::test]
  async fn a_settings_check_offers_the_update_and_installs_nothing() {
    let board = UpdaterBoard::new();
    let host = FakeHost::offering("0.9.90");

    let checked = board.check_unless_busy(&host).await;

    assert_eq!(
      checked.state,
      UpdaterState::Available {
        version: "0.9.90".into()
      }
    );
    assert_eq!(host.downloads.load(Ordering::SeqCst), 0);
    let states: Vec<_> = host.announced().into_iter().map(|s| s.state).collect();
    assert_eq!(states, vec![UpdaterState::Checking, checked.state]);
  }

  #[tokio::test]
  async fn each_check_and_install_outcome_leaves_its_state() {
    let failed = |during| UpdaterState::Failed { during };
    let cases: Vec<(FakeHost, bool, UpdaterState)> = vec![
      (
        FakeHost {
          found: Ok(None),
          ..FakeHost::offering("0.9.90")
        },
        false,
        UpdaterState::UpToDate,
      ),
      (
        FakeHost {
          found: Err("offline".into()),
          ..FakeHost::offering("0.9.90")
        },
        false,
        failed(UpdaterStep::Check),
      ),
      (
        FakeHost::offering("0.9.90"),
        true,
        UpdaterState::Deferred {
          version: "0.9.90".into(),
        },
      ),
      (
        FakeHost {
          download_result: Err("signature mismatch".into()),
          ..FakeHost::offering("0.9.90")
        },
        false,
        failed(UpdaterStep::Install),
      ),
      (
        FakeHost {
          install_result: Err("disk full".into()),
          ..FakeHost::offering("0.9.90")
        },
        false,
        failed(UpdaterStep::Install),
      ),
      (
        FakeHost::offering("0.9.90"),
        false,
        UpdaterState::Installing {
          version: "0.9.90".into(),
        },
      ),
    ];
    for (host, editing, expected) in cases {
      let board = UpdaterBoard::new();
      let active = move || std::future::ready(editing);
      board.run_check(&host, &active).await;

      assert_eq!(board.snapshot().state, expected);
      let announced = host.announced();
      assert_eq!(announced.first().map(|s| &s.state), Some(&UpdaterState::Checking));
      assert_eq!(announced.last().map(|s| &s.state), Some(&expected));
      assert!(
        announced.windows(2).all(|pair| pair[0].revision < pair[1].revision),
        "{announced:?}"
      );
    }
  }

  #[test]
  fn download_progress_is_announced_at_most_once_per_interval() {
    let board = UpdaterBoard::new();
    let start = Instant::now();
    let at = |millis| start + Duration::from_millis(millis);

    assert!(board.record(UpdaterState::Checking, at(0)).is_some());
    assert!(board.record(downloading("0.9.90", 0, Some(300)), at(1)).is_some());
    // Inside the interval the step is kept, not announced.
    assert!(board.record(downloading("0.9.90", 100, Some(300)), at(100)).is_none());
    assert_eq!(board.snapshot().state, downloading("0.9.90", 100, Some(300)));
    assert!(
      board
        .record(downloading("0.9.90", 200, Some(300)), at(1) + PROGRESS_EVENT_INTERVAL)
        .is_some()
    );
    // The last step and the change after it are always announced.
    assert!(board.record(downloading("0.9.90", 300, Some(300)), at(300)).is_some());
    let installing = UpdaterState::Installing {
      version: "0.9.90".into(),
    };
    assert_eq!(
      board.record(installing.clone(), at(301)),
      Some(UpdaterSnapshot {
        revision: 6,
        state: installing,
      })
    );
  }

  #[test]
  fn updater_snapshot_serializes_for_the_settings_window() {
    assert_eq!(
      serde_json::to_value(UpdaterSnapshot {
        revision: 3,
        state: downloading("0.9.90", 100, None),
      })
      .expect("updater snapshot serializes"),
      serde_json::json!({
        "revision": 3,
        "state": {
          "status": "downloading",
          "version": "0.9.90",
          "receivedBytes": 100,
          "totalBytes": null,
        },
      })
    );
    assert_eq!(
      serde_json::to_value(UpdaterState::Failed {
        during: UpdaterStep::Install
      })
      .expect("updater state serializes"),
      serde_json::json!({ "status": "failed", "during": "install" })
    );
  }

  #[test]
  fn update_package_limit_accepts_the_boundary_and_rejects_one_more_byte() {
    assert_eq!(
      checked_update_size(0, MAX_UPDATE_PACKAGE_BYTES),
      Ok(MAX_UPDATE_PACKAGE_BYTES)
    );
    assert!(checked_update_size(MAX_UPDATE_PACKAGE_BYTES, 1).is_err());
    assert!(checked_update_size(usize::MAX, 1).is_err());
  }

  // A throwaway test key (its private half was never kept) and the package it
  // signed with `tauri signer sign --app-version 1.2.3`, as releases sign.
  const FIXTURE_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUzRDQ5QjAyMDBEQTQ3NUMKUldSY1I5b0FBcHZVNDg0WW9OemxmZXo5ZGpFbm9KNkRiaDF0MWhNNmxBaG5abVBUNEN4d1BPQTUK";
  const FIXTURE_PACKAGE: &[u8] = b"stella updater fixture package";
  const FIXTURE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSY1I5b0FBcHZVNDMyZER3QWpQaDE5OU5YZHZuTk9QRC91ajVKTVY4UmlKbzJzSWhNVk1sRjBTNlFUN0NDUHhEMnBIWENrY1V3aGxMT3RMMHA5ang0RnIvaWlZeVdkOGdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyOTE4MzMxCWZpbGU6cGFja2FnZS5iaW4JdmVyc2lvbjoxLjIuMwp1ZzZySHRaa0Q3UzlwYlRVd0w2RnFxRmRZMnNxL2o5SUpKRmg5dFc1dVA3VzJSQ0w0VlBZTjBqbS9LUHdoVUk3OWZacDRBRnJHYjNSbStDNWk2UktBZz09Cg==";

  #[test]
  fn a_package_signed_for_the_announced_version_verifies() {
    assert_eq!(
      verify_signed_package(
        FIXTURE_PUBLIC_KEY,
        FIXTURE_PACKAGE,
        FIXTURE_SIGNATURE,
        "1.2.3"
      ),
      Ok(())
    );
    assert_eq!(
      verify_signed_package(
        FIXTURE_PUBLIC_KEY,
        FIXTURE_PACKAGE,
        FIXTURE_SIGNATURE,
        "v1.2.3"
      ),
      Ok(())
    );
  }

  #[test]
  fn a_package_changed_after_signing_is_refused() {
    let mut tampered = FIXTURE_PACKAGE.to_vec();
    tampered[0] ^= 1;
    let refused =
      verify_signed_package(FIXTURE_PUBLIC_KEY, &tampered, FIXTURE_SIGNATURE, "1.2.3");
    assert!(
      refused
        .as_ref()
        .is_err_and(|error| error.starts_with("Updater signature verification failed")),
      "{refused:?}"
    );
  }

  #[test]
  fn a_signature_for_another_version_is_refused() {
    assert_eq!(
      verify_signed_package(
        FIXTURE_PUBLIC_KEY,
        FIXTURE_PACKAGE,
        FIXTURE_SIGNATURE,
        "1.2.4"
      ),
      Err("Updater signature version does not match the announced release".to_string())
    );
  }

  #[test]
  fn the_release_public_key_is_configured_and_decodes() {
    let key = updater_public_key().expect("updater public key");
    assert!(PublicKey::decode(&decode_base64_text(&key).expect("base64 key")).is_ok());
  }

  #[test]
  fn signed_version_requires_an_explicit_version_field() {
    assert_eq!(
      signed_version("timestamp:1\tversion:v1.2.3"),
      Some("v1.2.3")
    );
    assert_eq!(signed_version("timestamp:1"), None);
  }

  #[test]
  fn presence_task_is_started_independently_of_updater_work() {
    let setup = include_str!("lib.rs");
    let updater = include_str!("updater.rs")
      .split("#[cfg(test)]")
      .next()
      .unwrap();
    let independently_started = |setup: &str, updater: &str| {
      setup.matches("presence::start(handle.clone());").count() == 1
        && setup
          .matches(
            "updater::schedule_startup_check(handle.clone(), Arc::clone(&manager));",
          )
          .count()
          == 1
        && !updater.contains("presence::")
    };
    assert!(independently_started(setup, updater));
    assert!(!independently_started(
      &setup.replace("presence::start(handle.clone());", ""),
      updater
    ));
    assert!(!independently_started(
      setup,
      "crate::presence::report(&handle).await;"
    ));
  }

  #[tokio::test]
  async fn held_updater_work_does_not_delay_startup_heartbeat_or_wake() {
    let (updater_started, started) = tokio::sync::oneshot::channel();
    let (release_updater, released) = tokio::sync::oneshot::channel();
    let updater = tokio::spawn(async move {
      let _operation = UPDATER.operation.lock().await;
      updater_started.send(()).unwrap();
      released.await.unwrap();
    });
    started.await.unwrap();

    let (reports, mut reported) = tokio::sync::mpsc::unbounded_channel();
    let (ticks, ticked) = tokio::sync::mpsc::unbounded_channel();
    let ticked = std::sync::Arc::new(tokio::sync::Mutex::new(ticked));
    let presence = tokio::spawn(crate::presence::run_loop(
      1_000,
      move || {
        reports.send(()).unwrap();
        std::future::ready(())
      },
      move || {
        let ticked = std::sync::Arc::clone(&ticked);
        async move { ticked.lock().await.recv().await.unwrap() }
      },
      || {},
    ));

    // The updater remains suspended throughout every observed report.
    tokio::time::timeout(Duration::from_secs(5), reported.recv())
      .await
      .expect("startup report must not wait for updater work")
      .unwrap();
    let interval = 3 * 60;
    for elapsed in (30..=interval).step_by(30) {
      ticks.send(1_000 + elapsed).unwrap();
    }
    tokio::time::timeout(Duration::from_secs(5), reported.recv())
      .await
      .expect("heartbeat must not wait for updater work")
      .unwrap();
    assert!(matches!(
      reported.try_recv(),
      Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));

    ticks.send(1_000 + interval + 121).unwrap();
    tokio::time::timeout(Duration::from_secs(5), reported.recv())
      .await
      .expect("wake report must not wait for updater work")
      .unwrap();
    assert!(!updater.is_finished());
    release_updater.send(()).unwrap();
    updater.await.unwrap();
    presence.abort();
    assert!(presence.await.unwrap_err().is_cancelled());
  }

  #[test]
  fn wall_clock_sleep_gap_is_due_without_advancing_a_monotonic_timer() {
    let last = 1_000_000;
    assert!(!check_due(last, last + 30));
    assert!(!check_due(
      last,
      last + BACKGROUND_CHECK_INTERVAL.as_secs() - 1
    ));
    assert!(check_due(last, last + BACKGROUND_CHECK_INTERVAL.as_secs()));
    assert!(check_due(last, last + 24 * 60 * 60));
    assert!(check_due(last, last - 1));
    assert!(check_due(0, last));
  }
}
