//! Stella Desktop as a runner: one outbound WebSocket to the API that
//! receives run commands and hands them to the local harness host
//! (`sidecar_host.rs`), which runs Codex or Claude Code through the harness
//! sidecar's holder.
//!
//! The runner exists only while the `local-agents` feature is on for the
//! linked account. The host lives as long as the app, so runs keep their
//! holder connection while the runner reconnects or the feature toggles.
//! Without a data folder no host runs, and every run is refused with
//! `harness_not_installed` through the same journal and socket path.

mod client;
mod harness;
mod journal;
mod run_folders;
mod sidecar_host;
#[cfg(all(test, unix))]
#[allow(
  clippy::disallowed_methods,
  reason = "tests construct local file fixtures"
)]
mod sidecar_host_tests;
#[cfg(all(feature = "dev-runner-stand-in", unix))]
#[allow(
  clippy::disallowed_methods,
  reason = "the development stand-in keeps its link and folders under the checkout's .stella-dev"
)]
pub(crate) mod stand_in;
mod state;
#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::future::BoxFuture;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::watch;

use self::client::{
  Authorized, JournalOpener, Runner, RunnerAuth, RunnerConfig, RunnerParts,
};
use self::harness::{
  HarnessHost, HarnessReports, NoHarnessReports, UnavailableHarnessHost,
};
use self::journal::{Journal, JournalBacking, SharedJournal};
use self::sidecar_host::{
  HarnessCredentials, HostSettings, InstallSettled, InstalledHarness, LocalHarnesses,
  SidecarHarnessHost,
};
pub(crate) use self::state::RunnerState;
use crate::harness_installation::HarnessInstallation;
use crate::harness_release::{ManagedHarness, ManagedTool};
use crate::harness_sidecar::{
  HarnessLaunchSettings, ReconnectBackoff, SidecarLaunch, SidecarSettings,
  SkillFolderRef,
};
use crate::keychain::LocalDataKey;
use crate::local_store::{self, StoreKey};
use crate::runner_protocol::Harness;

/// Announces a state change; the window reads it with `desktop_runner_get_state`.
pub(crate) const STATE_EVENT: &str = "desktop-runner-state-changed";
const DEBUG_PERSISTENCE_ENV: &str = "STELLA_ENABLE_DEBUG_RUNNER_PERSISTENCE";
const JOURNAL_DIRECTORY: &str = "desktop-runner";

/// The runner task while the feature is on, and the state it last reported.
pub(crate) struct DesktopRunnerControl {
  state: Arc<watch::Sender<RunnerState>>,
  tasks: Mutex<Tasks>,
  /// The harness host, made by the first runner task; `None` inside when
  /// this computer has no data folder for it.
  host: Arc<OnceLock<Option<SidecarHarnessHost>>>,
  /// The runners' journal: hosts keep journaling into it while no runner
  /// runs, and the next runner sends what it holds.
  journal: Arc<SharedJournal>,
}

#[derive(Default)]
struct Tasks {
  /// The running task's start; `Some` while a task holds the runner.
  running: Option<Running>,
  /// Counts starts, so an ending task clears only its own marker.
  starts: u64,
  /// The latest task; a new one starts after it ended, so two never share
  /// the journal.
  latest: Option<tauri::async_runtime::JoinHandle<()>>,
}

struct Running {
  start: u64,
  /// Stops the task.
  stop: watch::Sender<bool>,
}

impl Tasks {
  /// Claim the runner for a new task: its start and stop signal, or `None`
  /// while a task already holds it.
  fn begin(&mut self) -> Option<(u64, watch::Receiver<bool>)> {
    if self.running.is_some() {
      return None;
    }
    let (stop, stopped) = watch::channel(false);
    self.starts = self.starts.wrapping_add(1);
    self.running = Some(Running {
      start: self.starts,
      stop,
    });
    Some((self.starts, stopped))
  }

  /// Ask the running task to stop and release the runner.
  fn stop(&mut self) {
    if let Some(running) = self.running.take() {
      running.stop.send_replace(true);
    }
  }

  /// The task of `start` ended. A newer start keeps its marker.
  fn ended(&mut self, start: u64) {
    if self
      .running
      .as_ref()
      .is_some_and(|running| running.start == start)
    {
      self.running = None;
    }
  }
}

/// Releases the runner when its task ends by any path (setup failure, the
/// runner returning, a panic), so a later enable starts a new task.
struct TaskEnd {
  app: AppHandle,
  start: u64,
}

impl Drop for TaskEnd {
  fn drop(&mut self) {
    if let Some(control) = self.app.try_state::<DesktopRunnerControl>()
      && let Ok(mut tasks) = control.tasks.lock()
    {
      tasks.ended(self.start);
    }
  }
}

impl Default for DesktopRunnerControl {
  fn default() -> Self {
    Self {
      state: Arc::new(watch::channel(RunnerState::Off).0),
      tasks: Mutex::new(Tasks::default()),
      host: Arc::new(OnceLock::new()),
      journal: Arc::new(SharedJournal::default()),
    }
  }
}

impl DesktopRunnerControl {
  fn start(&self, app: &AppHandle) {
    let Ok(mut tasks) = self.tasks.lock() else {
      return;
    };
    let Some((start, stopped)) = tasks.begin() else {
      return;
    };
    let previous = tasks.latest.take();
    let app = app.clone();
    let state = Arc::clone(&self.state);
    let host_slot = Arc::clone(&self.host);
    let journal = Arc::clone(&self.journal);
    tasks.latest = Some(tauri::async_runtime::spawn(async move {
      let _end = TaskEnd {
        app: app.clone(),
        start,
      };
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
      let (host, reports): (Arc<dyn HarnessHost>, Arc<dyn HarnessReports>) =
        match host_slot.get_or_init(|| sidecar_host(&app)) {
          Some(host) => (Arc::new(host.clone()), Arc::new(host.clone())),
          None => (
            Arc::new(UnavailableHarnessHost::new(app_version.clone())),
            Arc::new(NoHarnessReports),
          ),
        };
      let runner = Runner::new(RunnerParts {
        config: RunnerConfig {
          desktop_id,
          app_version,
          timing: client::RunnerTiming::default(),
          random: unit_random,
        },
        auth: Arc::new(AccountAuth { app: app.clone() }),
        journals: Arc::new(EncryptedJournals),
        journal,
        host,
        reports,
        state,
        wakes: crate::presence::subscribe_wakes(),
        stop: stopped,
      });
      runner.run().await;
    }));
  }

  fn stop(&self) {
    if let Ok(mut tasks) = self.tasks.lock() {
      tasks.stop();
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

/// Where the host keeps its holders and run folders, under the app's data.
const HOLDER_DIRECTORY: &str = "agent-holder";
const RUNS_DIRECTORY: &str = "agent-runs";
/// Where every run on this computer once shared one cache. Each chat has its
/// own beside its folder now; what is left here is removed once no holder of
/// an earlier version, whose runs may still use it, is left.
const RETIRED_PACKAGE_CACHE_DIRECTORY: &str = "agent-package-cache";

/// The folders on this computer every run writes to, which a skill folder must
/// stay out of.
pub(crate) fn run_folders_on_this_computer() -> Vec<std::path::PathBuf> {
  dirs::data_dir()
    .map(|data| data.join(crate::config::APP_DATA_DIR_NAME))
    .map(|data| {
      vec![
        data.join(RUNS_DIRECTORY),
        data.join(RETIRED_PACKAGE_CACHE_DIRECTORY),
      ]
    })
    .unwrap_or_default()
}

/// The app's harness host: the bundled sidecar, the managed CLIs and the
/// ChatGPT connection. `None` without a data folder.
fn sidecar_host(app: &AppHandle) -> Option<SidecarHarnessHost> {
  let Some(data) = dirs::data_dir() else {
    tracing::warn!("the harness host has no data directory");
    return None;
  };
  let data = data.join(crate::config::APP_DATA_DIR_NAME);
  let launch = std::env::current_exe()
    .ok()
    .and_then(|executable| SidecarLaunch::for_app(&executable))?;
  let version = app.package_info().version.to_string();
  Some(SidecarHarnessHost::new(
    HostSettings {
      sidecar: SidecarSettings {
        launch,
        holder_root: data.join(HOLDER_DIRECTORY),
        socket_dir: None,
        sidecar_version: version.clone(),
        app_version: version,
        // Set from the account the runner connects for.
        api_origin: String::new(),
        hello_timeout: Duration::from_secs(10),
        start_timeout: Duration::from_secs(20),
        shutdown_grace: Duration::from_secs(10),
        backoff: ReconnectBackoff::DEFAULT,
        retired_dirs: vec![data.join(RETIRED_PACKAGE_CACHE_DIRECTORY)],
      },
      workspaces: data.join(RUNS_DIRECTORY),
      probe_interval: sidecar_host::PROBE_INTERVAL,
    },
    Arc::new(ManagedHarnesses { app: app.clone() }),
  ))
}

fn sign_in_changes() -> &'static tokio::sync::watch::Sender<u64> {
  static CHANGES: std::sync::OnceLock<tokio::sync::watch::Sender<u64>> =
    std::sync::OnceLock::new();
  CHANGES.get_or_init(|| tokio::sync::watch::channel(0).0)
}

/// A harness sign-in, sign-out or credential changed: its report is probed
/// again now rather than at the next periodic probe.
pub(crate) fn harness_sign_in_changed() {
  sign_in_changes().send_modify(|count| *count = count.wrapping_add(1));
}

/// The CLIs the installer manages, and Codex on the user's ChatGPT plan when
/// it is connected.
struct ManagedHarnesses {
  app: AppHandle,
}

impl LocalHarnesses for ManagedHarnesses {
  fn skill_folders(&self) -> Vec<SkillFolderRef> {
    crate::local_skill_folders::SkillFolders::for_this_computer().for_run()
  }

  fn on_install_settled(&self, settled: InstallSettled) {
    // A sign-in, sign-out or new credential changes what a probe finds too.
    let mut sign_ins = sign_in_changes().subscribe();
    let signed = Arc::clone(&settled);
    tauri::async_runtime::spawn(async move {
      while sign_ins.changed().await.is_ok() {
        signed();
      }
    });
    let Some(installation) = self.app.try_state::<HarnessInstallation>() else {
      return;
    };
    for harness in ManagedHarness::ALL {
      let mut states = installation.subscribe(harness);
      let settled = Arc::clone(&settled);
      tauri::async_runtime::spawn(async move {
        // A download changes the state with every chunk; only an install
        // that ended changes what a probe finds.
        while states.changed().await.is_ok() {
          let running = states.borrow_and_update().is_running();
          if !running {
            settled();
          }
        }
      });
    }
  }

  fn installed(&self, harness: Harness) -> Option<InstalledHarness> {
    let managed = match harness {
      Harness::Codex => ManagedHarness::Codex,
      Harness::ClaudeCode => ManagedHarness::ClaudeCode,
      Harness::Opencode => return None,
    };
    let installation = self.app.try_state::<HarnessInstallation>()?;
    let lease = installation.acquire(managed).ok()?;
    let (_variable, config_dir) = lease.config_env();
    let version = lease.version().to_owned();
    let executable = lease.executable().to_path_buf();
    let config_dir = config_dir.to_path_buf();
    // A run still starts on a computer whose Bun is not installed yet; its
    // commands then find whatever the computer has.
    let bun = installation.acquire_tool(ManagedTool::Bun).ok();
    let tool_path = bun
      .iter()
      .filter_map(|bun| bun.executable().parent().map(std::path::PathBuf::from))
      .collect();
    Some(InstalledHarness {
      version,
      executable,
      config_dir,
      tool_path,
      lease: Box::new((lease, bun)),
    })
  }

  fn credentials(&self, harness: Harness) -> BoxFuture<'_, Option<HarnessCredentials>> {
    Box::pin(async move {
      if harness != Harness::Codex {
        // Claude Code uses its own sign-in in its stella-owned home.
        return None;
      }
      let launch =
        match crate::chatgpt_auth_commands::codex_chatgpt_launch(&self.app).await {
          Ok(launch) => launch,
          // Not connected: Codex runs on its own home's sign-in, if any.
          Err(crate::codex_managed_token_broker::CodexLaunchError::Access(_)) => {
            return None;
          }
          Err(crate::codex_managed_token_broker::CodexLaunchError::Broker) => {
            tracing::warn!("the ChatGPT token broker is unavailable");
            return None;
          }
        };
      let settings = HarnessLaunchSettings {
        config_overrides: launch.config_overrides.clone(),
        environment: launch
          .environment
          .iter()
          .map(|(name, value)| ((*name).to_owned(), value.clone()))
          .collect(),
        removed_environment: launch
          .removed_environment
          .iter()
          .map(|name| (*name).to_owned())
          .collect(),
        client_name: Some(launch.client_name.to_owned()),
        process_grant: true,
      };
      Some(HarnessCredentials {
        settings,
        grant: Some(Arc::new(move |pid| {
          Box::new(launch.authorize(pid)) as Box<dyn Send + Sync>
        })),
      })
    })
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
