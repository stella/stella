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
// - When an update is found, download + install + restart. The
//   installer handles the binary swap; tauri_plugin_process is
//   required for the post-install restart to work cross-platform.

use std::time::Duration;

use tauri::{async_runtime, AppHandle};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(10);
const BACKGROUND_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

// Outcome of an update check that *did not* apply an update. The
// "update applied" path doesn't appear here because the install
// step calls `AppHandle::restart()`, which exits the current
// process and never returns.
#[derive(Debug)]
pub enum CheckOutcome {
  UpToDate,
  Failed(String),
}

pub fn schedule_startup_check(handle: AppHandle) {
  if cfg!(debug_assertions) {
    tracing::debug!("background updater skipped in debug build");
    return;
  }

  async_runtime::spawn(async move {
    tokio::time::sleep(STARTUP_CHECK_DELAY).await;

    loop {
      match run_check(&handle).await {
        CheckOutcome::UpToDate => {
          tracing::debug!("background updater: up to date");
        }
        CheckOutcome::Failed(err) => {
          tracing::warn!(error = %err, "background updater check failed");
        }
      }

      tokio::time::sleep(BACKGROUND_CHECK_INTERVAL).await;
    }
  });
}

pub async fn run_check(handle: &AppHandle) -> CheckOutcome {
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

  // Restart so the new binary takes over. `restart` exits the
  // current process and never returns; the type-level `!` coerces
  // to `CheckOutcome` to satisfy the signature.
  handle.restart()
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
