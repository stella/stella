// Auto-updater wiring.
//
// The Tauri updater plugin fetches `latest.json`; this module owns bounded
// package download, signature verification, scheduling, and user feedback:
//
// - On startup, run a delayed background check (so the launch path
//   isn't blocked by network I/O).
// - While the app keeps running, repeat that background check so
//   long-lived desktop sessions still pick up new releases.
// - When the tray "Check for updates" item is clicked, run the same
//   check synchronously and notify whether an update was found.
// - When an update is found and no desktop edit sessions are
//   active, download + install + relaunch. The installer handles
//   the binary swap; `crate::relaunch` owns the hand-over to the
//   new binary.
// - When an administrator set `DisableUpdates`, nothing checks: the
//   organization deploys new versions itself.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use reqwest::header::{ACCEPT, HeaderValue};
use tauri::{AppHandle, async_runtime};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::http_client::{DesktopHttpClient, HttpClientOptions};
use crate::session_manager::SessionManager;

const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(10);
const WAKE_CHECK_TICK: Duration = Duration::from_secs(30);
const MAX_UPDATE_PACKAGE_BYTES: usize = 256 * 1024 * 1024;
static LAST_CHECK: AtomicU64 = AtomicU64::new(0);
static CHECK_LOCK: Mutex<()> = Mutex::const_new(());

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
      let active_edit_sessions = {
        let mgr = manager.lock().await;
        mgr.has_active_edit_sessions()
      };

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
  let active = manager.lock().await.has_active_edit_sessions();
  match run_check(handle, active).await {
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

pub async fn run_check(handle: &AppHandle, active_edit_sessions: bool) -> CheckOutcome {
  if crate::managed_policy::current().updates_disabled {
    return CheckOutcome::Disabled;
  }
  // Startup, handoffs and tray actions cannot run installers concurrently.
  let _check = CHECK_LOCK.lock().await;
  record_check(unix_seconds(SystemTime::now()));
  let exit_handle = handle.clone();
  let updater = match handle
    .updater_builder()
    .on_before_exit(move || {
      crate::desktop_crash::clean_exit(&exit_handle);
      exit_handle.cleanup_before_exit();
    })
    .build()
  {
    Ok(u) => u,
    Err(err) => return CheckOutcome::Failed(err.to_string()),
  };

  let update = match updater.check().await {
    Ok(Some(update)) => update,
    Ok(None) => return CheckOutcome::UpToDate,
    Err(err) => return CheckOutcome::Failed(err.to_string()),
  };

  let version = update.version.clone();
  if active_edit_sessions {
    notify(
      handle,
      "Stella update available",
      "Stella Desktop will update after active desktop edits are finished.",
    );
    return CheckOutcome::Deferred { version };
  }

  notify(
    handle,
    "Stella update available",
    &format!("Installing v{version}…"),
  );

  let package = match download_update_package(&update).await {
    Ok(package) => package,
    Err(err) => {
      #[cfg(windows)]
      crate::desktop_crash::resume_after_failed_update(handle);
      notify(handle, "Stella update failed", &err);
      return CheckOutcome::Failed(err);
    }
  };

  if let Err(err) = crate::local_store::install_update(&update, &package) {
    #[cfg(windows)]
    crate::desktop_crash::resume_after_failed_update(handle);
    notify(handle, "Stella update failed", &err);
    return CheckOutcome::Failed(err);
  }

  // On Windows the plugin has already handed off to the installer and
  // exited; this line only runs where the bundle was swapped in place.
  if let Err(err) = crate::relaunch::after_update(handle) {
    notify(
      handle,
      "Stella update installed",
      "Quit and reopen Stella to finish updating.",
    );
    return CheckOutcome::Failed(format!(
      "v{version} installed but the relaunch failed: {err}"
    ));
  }

  CheckOutcome::Installed { version }
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

  let mut package = Vec::new();
  let mut stream = response.bytes_stream();
  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(|error| format!("Update download failed: {error}"))?;
    checked_update_size(package.len(), chunk.len())?;
    package.extend_from_slice(&chunk);
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
      let _operation = CHECK_LOCK.lock().await;
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
