// Auto-updater wiring.
//
// The Tauri updater plugin only fetches `latest.json` and verifies
// signatures; it doesn't decide *when* to check or *how* to surface
// the result. This module owns those decisions:
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

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, async_runtime};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::session_manager::SessionManager;

const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(10);
const WAKE_CHECK_TICK: Duration = Duration::from_secs(30);
static LAST_CHECK: AtomicU64 = AtomicU64::new(0);
static CHECK_LOCK: Mutex<()> = Mutex::const_new(());

const BACKGROUND_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

// `Installed` means the exit of this process has been requested and
// the relaunch is under way; callers must not schedule further work.
#[derive(Debug)]
pub enum CheckOutcome {
  Deferred { version: String },
  UpToDate,
  Installed { version: String },
  Failed(String),
}

pub fn schedule_startup_check(handle: AppHandle, manager: Arc<Mutex<SessionManager>>) {
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
  let result = std::fs::create_dir_all(path.parent().expect("updater data directory"))
    .and_then(|()| std::fs::write(path, now.to_string()));
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
    CheckOutcome::Deferred { .. } | CheckOutcome::UpToDate => false,
  }
}

pub async fn run_check(handle: &AppHandle, active_edit_sessions: bool) -> CheckOutcome {
  // Startup, handoffs and tray actions cannot run installers concurrently.
  let _check = CHECK_LOCK.lock().await;
  record_check(unix_seconds(SystemTime::now()));
  let updater = match handle.updater() {
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

  if let Err(err) = update
    .download_and_install(|_chunk, _total| {}, || {})
    .await
  {
    let msg = err.to_string();
    notify(handle, "Stella update failed", &msg);
    return CheckOutcome::Failed(msg);
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
