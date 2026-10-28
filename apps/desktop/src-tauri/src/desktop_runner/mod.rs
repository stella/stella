//! Stella Desktop as a runner: one outbound WebSocket to the API that
//! receives run commands and hands them to a local harness host.
//!
//! The runner exists only while the `local-agents` feature is on for the
//! linked account. Until a harness host is installed every run is refused
//! with `harness_not_installed`, through the same journal and socket path a
//! host will use.

mod client;
mod harness;
mod journal;
mod state;
#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::watch;

use self::client::{
  Authorized, JournalOpener, Runner, RunnerAuth, RunnerConfig, RunnerParts,
};
use self::harness::{NoHarnessReports, UnavailableHarnessHost};
use self::journal::{Journal, JournalBacking};
pub(crate) use self::state::RunnerState;
use crate::keychain::LocalDataKey;
use crate::local_store::{self, StoreKey};

/// Announces a state change; the window reads it with `desktop_runner_get_state`.
pub(crate) const STATE_EVENT: &str = "desktop-runner-state-changed";
const DEBUG_PERSISTENCE_ENV: &str = "STELLA_ENABLE_DEBUG_RUNNER_PERSISTENCE";
const JOURNAL_DIRECTORY: &str = "desktop-runner";

/// The runner task while the feature is on, and the state it last reported.
pub(crate) struct DesktopRunnerControl {
  state: Arc<watch::Sender<RunnerState>>,
  tasks: Mutex<Tasks>,
}

#[derive(Default)]
struct Tasks {
  /// Stops the running task.
  running: Option<watch::Sender<bool>>,
  /// The latest task; a new one starts after it ended, so two never share
  /// the journal.
  latest: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Default for DesktopRunnerControl {
  fn default() -> Self {
    Self {
      state: Arc::new(watch::channel(RunnerState::Off).0),
      tasks: Mutex::new(Tasks::default()),
    }
  }
}

impl DesktopRunnerControl {
  fn start(&self, app: &AppHandle) {
    let Ok(mut tasks) = self.tasks.lock() else {
      return;
    };
    if tasks.running.is_some() {
      return;
    }
    let (stop, stopped) = watch::channel(false);
    tasks.running = Some(stop);
    let previous = tasks.latest.take();
    let app = app.clone();
    let state = Arc::clone(&self.state);
    tasks.latest = Some(tauri::async_runtime::spawn(async move {
      if let Some(previous) = previous
        && previous.await.is_err()
      {
        tracing::warn!("the previous desktop runner task failed");
      }
      let Ok(Ok(desktop_id)) =
        tokio::task::spawn_blocking(crate::presence::desktop_id).await
      else {
        tracing::warn!("desktop runner has no installation id");
        return;
      };
      let app_version = app.package_info().version.to_string();
      let runner = Runner::new(RunnerParts {
        config: RunnerConfig {
          desktop_id,
          app_version: app_version.clone(),
          timing: client::RunnerTiming::default(),
          random: unit_random,
        },
        auth: Arc::new(AccountAuth { app: app.clone() }),
        journals: Arc::new(EncryptedJournals),
        host: Arc::new(UnavailableHarnessHost::new(app_version)),
        reports: Arc::new(NoHarnessReports),
        state,
        wakes: crate::presence::subscribe_wakes(),
        stop: stopped,
      });
      runner.run().await;
    }));
  }

  fn stop(&self) {
    if let Ok(mut tasks) = self.tasks.lock()
      && let Some(stop) = tasks.running.take()
    {
      stop.send_replace(true);
    }
  }
}

/// Start the runner when the feature turns on for the account, stop it when
/// it turns off.
pub(crate) fn apply_feature_gate(app: &AppHandle, enabled: bool) {
  let control = app.state::<DesktopRunnerControl>();
  if enabled {
    control.start(app);
  } else {
    control.stop();
  }
}

/// Emit a payload-free event on every state change.
pub(crate) fn watch_state(app: &AppHandle) {
  let mut changes = app.state::<DesktopRunnerControl>().state.subscribe();
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    while changes.changed().await.is_ok() {
      if app.emit(STATE_EVENT, ()).is_err() {
        tracing::warn!("desktop runner state event could not be sent");
      }
    }
  });
}

#[tauri::command]
pub(crate) fn desktop_runner_get_state(
  window: WebviewWindow,
  control: State<'_, DesktopRunnerControl>,
) -> Result<RunnerState, String> {
  if window.label() != "main" {
    return Err("the runner state is not available in this window".into());
  }
  Ok(control.state.borrow().clone())
}

struct AccountAuth {
  app: AppHandle,
}

impl RunnerAuth for AccountAuth {
  fn authorize(&self) -> BoxFuture<'_, Result<Option<Authorized>, String>> {
    Box::pin(async move {
      let state = self.app.state::<crate::account::AccountState>();
      let Some(request) = crate::account::request_account(&state).await? else {
        return Ok(None);
      };
      Ok(Some(Authorized {
        api_base_url: request.api_base_url.clone(),
        bearer: zeroize::Zeroizing::new(request.credential.key.clone()),
        device_key: request.device_key.clone(),
        namespace: request.local_data_namespace(),
        lease: Some(Box::new(request)),
      }))
    })
  }
}

/// One encrypted journal per account, under its own keychain key.
struct EncryptedJournals;

impl JournalOpener for EncryptedJournals {
  fn open(&self, namespace: &str) -> Journal {
    Journal::open(journal_backing(namespace), client::now_ms())
  }
}

fn journal_backing(namespace: &str) -> JournalBacking {
  if local_store::debug_build_is_memory_only(DEBUG_PERSISTENCE_ENV) {
    return JournalBacking::Memory;
  }
  let Some(root) = dirs::data_dir() else {
    return JournalBacking::Memory;
  };
  let directory = root
    .join(crate::config::APP_DATA_DIR_NAME)
    .join(JOURNAL_DIRECTORY)
    .join(namespace);
  let data_exists =
    std::fs::read_dir(&directory).is_ok_and(|mut entries| entries.next().is_some());
  match local_store::resolve_key(LocalDataKey::DesktopRunner(namespace), data_exists) {
    StoreKey::Key(key) => JournalBacking::Encrypted { directory, key },
    // Unreadable records stay on disk; the API drops the runs they held.
    StoreKey::MemoryOnly | StoreKey::DeletionOnly => JournalBacking::Memory,
  }
}

/// Uniform in `[0, 1)` from the system random source.
#[allow(
  clippy::cast_precision_loss,
  reason = "the top 53 bits fill an f64 mantissa exactly"
)]
fn unit_random() -> f64 {
  use ring::rand::SecureRandom;
  let mut bytes = [0_u8; 8];
  if ring::rand::SystemRandom::new().fill(&mut bytes).is_err() {
    return 0.5;
  }
  (u64::from_le_bytes(bytes) >> 11) as f64 / (1_u64 << 53) as f64
}
