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
use std::time::Duration;

use tauri::{AppHandle, async_runtime};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::session_manager::SessionManager;

const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(10);
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
  if cfg!(debug_assertions) {
    tracing::debug!("background updater skipped in debug build");
    return;
  }

  async_runtime::spawn(async move {
    tokio::time::sleep(STARTUP_CHECK_DELAY).await;

    loop {
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

      tokio::time::sleep(BACKGROUND_CHECK_INTERVAL).await;
    }
  });
}

pub async fn run_check(handle: &AppHandle, active_edit_sessions: bool) -> CheckOutcome {
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
