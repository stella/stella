//! Managed agent CLIs: install, cancel, remove, status and the executable a
//! run starts, per harness.
//!
//! Approach adapted from t3code's `CodexInstallation` (MIT): a pinned URL,
//! digest and size; a streamed download with a size cap and a running digest;
//! unpacking into a staging directory; a `--version` probe; publication as an
//! immutable `<harness>/<version>` directory; an atomic `active.json` pointer;
//! and in-process leases that keep a release in place while it runs.
//!
//! Layout under the app data directory:
//!
//! ```text
//! harness/<harness>/<version>/              one release, `.install-complete.json` inside
//! harness/<harness>/active.json             {"version", "previous"}
//! harness/<harness>/.install-<operation>/   staging, removed when the operation ends
//! harness-home/<harness>/                   CODEX_HOME or CLAUDE_CONFIG_DIR
//! ```
//!
//! A new release becomes active only after its probe passes, so a failed or
//! cancelled install leaves the active release as it was. The pointer keeps
//! the release it replaced; when the active release is found incomplete, the
//! pointer rolls back to that previous release. Executables are never placed
//! on `PATH`: a run starts the absolute path from its lease, with only the
//! Stella-owned configuration directory, never the user's `~/.codex` or
//! `~/.claude`.

// Leases, state subscriptions and configuration directories are taken by the
// desktop agent runner; until it lands only the tests take them, and those
// need a Unix shell for their fixture executables.
#![cfg_attr(
  not(all(test, unix)),
  allow(dead_code, reason = "the desktop agent runner consumes the lease API")
)]

use std::{
  collections::{HashMap, HashSet},
  future::Future,
  io::Write,
  num::NonZeroUsize,
  path::{Path, PathBuf},
  process::Stdio,
  sync::{Arc, Mutex, MutexGuard, PoisonError},
  time::Duration,
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::Digest;
use tokio::{io::AsyncWriteExt, sync::watch};

use crate::harness_archive::{self, UnpackError};
use crate::harness_release::{
  ArchiveDigest, HarnessRelease, HarnessReleases, ManagedHarness,
  is_contained_relative, is_release_version,
};
use crate::http_client::{DesktopHttpClient, HttpClientOptions};

const ACTIVE_POINTER: &str = "active.json";
const INSTALL_RECORD: &str = ".install-complete.json";
const STAGING_PREFIX: &str = ".install-";
const POINTER_STAGING_PREFIX: &str = ".active-";
const MAX_RECORD_BYTES: u64 = 8 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(45 * 60);
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(90);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const MAX_REDIRECTS: usize = 10;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// What a harness's installation looks like right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
  tag = "state",
  rename_all = "snake_case",
  rename_all_fields = "camelCase"
)]
pub enum HarnessInstallState {
  NotInstalled,
  Downloading {
    operation_id: String,
    version: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    /// The release runs keep using until this one is ready.
    active: Option<String>,
  },
  /// Unpacking and probing the downloaded release.
  Verifying {
    operation_id: String,
    version: String,
    active: Option<String>,
  },
  Ready {
    active: String,
  },
  Failed {
    reason: InstallFailure,
    active: Option<String>,
  },
}

impl HarnessInstallState {
  fn settled(active: Option<String>) -> Self {
    active.map_or(Self::NotInstalled, |active| Self::Ready { active })
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallFailure {
  /// The request failed, was refused, or the connection broke mid-body.
  DownloadFailed,
  /// More bytes arrived than the pinned size.
  Oversize,
  /// The body ended before the pinned size.
  Incomplete,
  DigestMismatch,
  /// The archive holds something other than contained files and directories,
  /// or lacks the executable.
  ArchiveRejected,
  /// The executable did not report the pinned version.
  ProbeFailed,
  Storage,
  /// The installed release or its pointer is unreadable and nothing could be
  /// rolled back to.
  CorruptInstall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessError {
  /// No release of this harness exists for this platform.
  UnsupportedPlatform,
  NotInstalled,
  CorruptInstall,
  /// A running process holds a lease on the release.
  InUse,
  /// An install or removal of the harness is in progress.
  Busy,
  /// The operation to cancel is not the current one.
  NotCurrent,
  Storage,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivePointer {
  version: String,
  previous: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallRecord {
  version: String,
  target: String,
  digest: ArchiveDigest,
  executable: String,
}

enum Operation {
  Idle,
  Installing {
    id: String,
    cancel: watch::Sender<bool>,
  },
  Removing,
}

struct Slot {
  state: watch::Sender<HarnessInstallState>,
  operation: Operation,
  leases: HashMap<String, NonZeroUsize>,
}

struct Slots {
  codex: Mutex<Slot>,
  claude_code: Mutex<Slot>,
}

struct Inner {
  root: PathBuf,
  config_root: PathBuf,
  releases: HarnessReleases,
  client: DesktopHttpClient,
  slots: Slots,
}

/// The one owner of `<app data>/harness` and `<app data>/harness-home`.
#[derive(Clone)]
pub struct HarnessInstallation(Arc<Inner>);

/// Keeps one installed release in place while a process runs from it.
pub struct HarnessLease {
  inner: Arc<Inner>,
  harness: ManagedHarness,
  version: String,
  executable: PathBuf,
  config_dir: PathBuf,
}

impl HarnessLease {
  pub fn version(&self) -> &str {
    &self.version
  }

  pub fn executable(&self) -> &Path {
    &self.executable
  }

  /// The variable and directory the CLI must be started with.
  pub fn config_env(&self) -> (&'static str, &Path) {
    (self.harness.config_env(), &self.config_dir)
  }
}

impl Drop for HarnessLease {
  fn drop(&mut self) {
    let mut slot = self.inner.slot(self.harness);
    let remaining = slot
      .leases
      .get(&self.version)
      .and_then(|count| NonZeroUsize::new(count.get() - 1));
    if let Some(count) = remaining {
      slot.leases.insert(self.version.clone(), count);
    } else {
      slot.leases.remove(&self.version);
    }
  }
}

enum Stop {
  Cancelled,
  Failed(InstallFailure),
}

impl HarnessInstallation {
  pub fn open_default() -> Option<Self> {
    let Some(data) = dirs::data_dir() else {
      tracing::warn!("managed harnesses have no data directory");
      return None;
    };
    let data = data.join(crate::config::APP_DATA_DIR_NAME);
    Self::open(
      data.join("harness"),
      data.join("harness-home"),
      HarnessReleases::pinned(),
    )
  }

  /// Reads the installed state; creates nothing. Staging left by an earlier
  /// process is removed: only one desktop process runs at a time.
  pub fn open(
    root: PathBuf,
    config_root: PathBuf,
    releases: HarnessReleases,
  ) -> Option<Self> {
    let client = match DesktopHttpClient::new(HttpClientOptions {
      timeout: Some(DOWNLOAD_TIMEOUT),
      redirect: redirect_policy(),
    }) {
      Ok(client) => client,
      Err(error) => {
        crate::logging::log_request_error(
          &error,
          "managed harness client is unavailable",
        );
        return None;
      }
    };
    let slot = |harness: ManagedHarness| {
      let dir = root.join(harness.id());
      remove_staging(&dir);
      Mutex::new(Slot {
        state: watch::channel(disk_state(&dir)).0,
        operation: Operation::Idle,
        leases: HashMap::new(),
      })
    };
    let slots = Slots {
      codex: slot(ManagedHarness::Codex),
      claude_code: slot(ManagedHarness::ClaudeCode),
    };
    Some(Self(Arc::new(Inner {
      slots,
      root,
      config_root,
      releases,
      client,
    })))
  }

  pub fn state(&self, harness: ManagedHarness) -> HarnessInstallState {
    self.0.slot(harness).state.borrow().clone()
  }

  pub fn subscribe(
    &self,
    harness: ManagedHarness,
  ) -> watch::Receiver<HarnessInstallState> {
    self.0.slot(harness).state.subscribe()
  }

  /// Starts installing the pinned release, or returns the install already
  /// running for this harness.
  pub fn start(
    &self,
    harness: ManagedHarness,
  ) -> Result<HarnessInstallState, HarnessError> {
    let release = self
      .0
      .releases
      .get(harness)
      .cloned()
      .ok_or(HarnessError::UnsupportedPlatform)?;
    let mut slot = self.0.slot(harness);
    match slot.operation {
      Operation::Idle => {}
      Operation::Installing { .. } => return Ok(slot.state.borrow().clone()),
      Operation::Removing => return Err(HarnessError::Busy),
    }
    let active = resolve_active(&self.0.harness_dir(harness))
      .ok()
      .map(|installed| installed.version);
    if active.as_ref() == Some(&release.version) {
      let state = HarnessInstallState::settled(active);
      replace_state(&slot, state.clone());
      return Ok(state);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (cancel, cancelled) = watch::channel(false);
    let state = HarnessInstallState::Downloading {
      operation_id: id.clone(),
      version: release.version.clone(),
      downloaded_bytes: 0,
      total_bytes: release.asset.archive_bytes,
      active,
    };
    replace_state(&slot, state.clone());
    slot.operation = Operation::Installing {
      id: id.clone(),
      cancel,
    };
    drop(slot);
    let inner = Arc::clone(&self.0);
    tauri::async_runtime::spawn(inner.run(harness, release, id, cancelled));
    Ok(state)
  }

  /// Asks the running install to stop; the state settles on the release that
  /// was active before it.
  pub fn cancel(
    &self,
    harness: ManagedHarness,
    operation_id: &str,
  ) -> Result<HarnessInstallState, HarnessError> {
    let slot = self.0.slot(harness);
    let Operation::Installing { id, cancel } = &slot.operation else {
      return Err(HarnessError::NotCurrent);
    };
    if id != operation_id {
      return Err(HarnessError::NotCurrent);
    }
    cancel.send_modify(|cancelled| *cancelled = true);
    let state = slot.state.borrow().clone();
    drop(slot);
    Ok(state)
  }

  pub fn cancel_all(&self) {
    for harness in ManagedHarness::ALL {
      let slot = self.0.slot(harness);
      if let Operation::Installing { cancel, .. } = &slot.operation {
        cancel.send_modify(|cancelled| *cancelled = true);
      }
    }
  }

  /// Removes every installed release of the harness. Refused while a process
  /// holds a lease or an install runs. The configuration directory stays.
  pub async fn remove(&self, harness: ManagedHarness) -> Result<(), HarnessError> {
    {
      let mut slot = self.0.slot(harness);
      if !matches!(slot.operation, Operation::Idle) {
        return Err(HarnessError::Busy);
      }
      if !slot.leases.is_empty() {
        return Err(HarnessError::InUse);
      }
      slot.operation = Operation::Removing;
    }
    let dir = self.0.harness_dir(harness);
    let removed = remove_tree(dir.clone()).await;
    let mut slot = self.0.slot(harness);
    slot.operation = Operation::Idle;
    replace_state(&slot, disk_state(&dir));
    drop(slot);
    removed.map_err(crate::logging::replaced_logged(
      "managed harness was not removed",
      HarnessError::Storage,
    ))
  }

  /// The active release's executable, held in place until the lease drops.
  /// An incomplete active release rolls the pointer back to the previous one.
  pub fn acquire(&self, harness: ManagedHarness) -> Result<HarnessLease, HarnessError> {
    let config_dir = self.0.config_root.join(harness.id());
    create_private_dir(&config_dir).map_err(crate::logging::replaced_logged(
      "managed harness configuration directory was not created",
      HarnessError::Storage,
    ))?;
    let mut slot = self.0.slot(harness);
    if matches!(slot.operation, Operation::Removing) {
      return Err(HarnessError::Busy);
    }
    let installed = resolve_active(&self.0.harness_dir(harness))?;
    let count = slot
      .leases
      .get(&installed.version)
      .map_or(NonZeroUsize::MIN, |count| count.saturating_add(1));
    slot.leases.insert(installed.version.clone(), count);
    if matches!(slot.operation, Operation::Idle) {
      replace_state(
        &slot,
        HarnessInstallState::settled(Some(installed.version.clone())),
      );
    }
    drop(slot);
    Ok(HarnessLease {
      inner: Arc::clone(&self.0),
      harness,
      version: installed.version,
      executable: installed.executable,
      config_dir,
    })
  }
}

impl Inner {
  fn slot(&self, harness: ManagedHarness) -> MutexGuard<'_, Slot> {
    let slot = match harness {
      ManagedHarness::Codex => &self.slots.codex,
      ManagedHarness::ClaudeCode => &self.slots.claude_code,
    };
    slot.lock().unwrap_or_else(PoisonError::into_inner)
  }

  fn harness_dir(&self, harness: ManagedHarness) -> PathBuf {
    self.root.join(harness.id())
  }

  async fn run(
    self: Arc<Self>,
    harness: ManagedHarness,
    release: HarnessRelease,
    id: String,
    cancelled: watch::Receiver<bool>,
  ) {
    let dir = self.harness_dir(harness);
    let staging = dir.join(format!("{STAGING_PREFIX}{id}"));
    let outcome = self
      .install(harness, &release, &id, &staging, cancelled)
      .await;
    if let Err(error) = remove_tree(staging).await {
      crate::logging::log_cause(&error, "managed harness staging was not removed");
    }
    let mut slot = self.slot(harness);
    slot.operation = Operation::Idle;
    let active = resolve_active(&dir).ok().map(|installed| installed.version);
    let state = match outcome {
      Ok(()) | Err(Stop::Cancelled) => HarnessInstallState::settled(active),
      Err(Stop::Failed(reason)) => HarnessInstallState::Failed { reason, active },
    };
    replace_state(&slot, state);
    drop(slot);
  }

  async fn install(
    &self,
    harness: ManagedHarness,
    release: &HarnessRelease,
    id: &str,
    staging: &Path,
    mut cancelled: watch::Receiver<bool>,
  ) -> Result<(), Stop> {
    let dir = self.harness_dir(harness);
    tokio::fs::create_dir_all(&dir)
      .await
      .map_err(failed_storage("managed harness directory was not created"))?;
    tokio::fs::create_dir(staging)
      .await
      .map_err(failed_storage("managed harness staging was not created"))?;
    let destination = dir.join(&release.version);
    if tokio::fs::symlink_metadata(&destination).await.is_ok() {
      if let Some(executable) = matching_release(&dir, release) {
        self.verifying(harness, id);
        probe(
          harness,
          &executable,
          &release.version,
          staging,
          &mut cancelled,
        )
        .await?;
        return self.activate(harness, &release.version).await;
      }
      // An incomplete or different release under the pinned version's name;
      // a running process cannot hold it, because leases need a valid record.
      if self.slot(harness).leases.contains_key(&release.version) {
        return Err(Stop::Failed(InstallFailure::Storage));
      }
      remove_tree(destination.clone())
        .await
        .map_err(failed_storage(
          "stale managed harness release was not removed",
        ))?;
    }

    let archive = staging.join("download");
    self
      .download(harness, id, release, &archive, &mut cancelled)
      .await?;
    self.verifying(harness, id);
    let runtime = staging.join("runtime");
    tokio::fs::create_dir(&runtime)
      .await
      .map_err(failed_storage("managed harness runtime was not created"))?;
    let unpacked = {
      let (archive, runtime, cancelled) =
        (archive.clone(), runtime.clone(), cancelled.clone());
      tokio::task::spawn_blocking(move || {
        harness_archive::unpack(&archive, &runtime, &cancelled)
      })
      .await
      .map_err(failed_storage("managed harness unpacking stopped"))?
    };
    match unpacked {
      Ok(()) => {}
      Err(UnpackError::Cancelled) => return Err(Stop::Cancelled),
      Err(UnpackError::Rejected) => {
        return Err(Stop::Failed(InstallFailure::ArchiveRejected));
      }
      Err(UnpackError::Storage) => return Err(Stop::Failed(InstallFailure::Storage)),
    }
    if let Err(error) = tokio::fs::remove_file(archive).await {
      crate::logging::log_cause(&error, "managed harness archive was not removed");
    }
    let executable = contained_join(&runtime, &release.asset.executable);
    if !is_nonempty_file(&executable) {
      tracing::warn!("managed harness archive lacks its executable");
      return Err(Stop::Failed(InstallFailure::ArchiveRejected));
    }
    probe(
      harness,
      &executable,
      &release.version,
      staging,
      &mut cancelled,
    )
    .await?;
    write_new_file(
      &runtime.join(INSTALL_RECORD),
      &serde_json::to_vec(&InstallRecord {
        version: release.version.clone(),
        target: release.asset.target.clone(),
        digest: release.asset.digest.clone(),
        executable: release.asset.executable.clone(),
      })
      .map_err(|error| {
        crate::logging::log_json_error(
          &error,
          "managed harness record was not encoded",
        );
        Stop::Failed(InstallFailure::Storage)
      })?,
    )
    .map_err(failed_storage("managed harness record was not written"))?;
    publish(&runtime, &destination)
      .await
      .map_err(failed_storage("managed harness release was not published"))?;
    self.activate(harness, &release.version).await
  }

  async fn download(
    &self,
    harness: ManagedHarness,
    id: &str,
    release: &HarnessRelease,
    archive: &Path,
    cancelled: &mut watch::Receiver<bool>,
  ) -> Result<(), Stop> {
    let asset = &release.asset;
    let mut response = until_cancelled(cancelled, self.client.get(&asset.url).send())
      .await?
      .map_err(failed_request("managed harness download failed"))?;
    if !response.status().is_success() {
      tracing::warn!(
        status = response.status().as_u16(),
        "managed harness download refused"
      );
      return Err(Stop::Failed(InstallFailure::DownloadFailed));
    }
    if response
      .content_length()
      .is_some_and(|length| length > asset.archive_bytes)
    {
      return Err(Stop::Failed(InstallFailure::Oversize));
    }
    let mut file = tokio::fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(archive)
      .await
      .map_err(failed_storage("managed harness download was not created"))?;
    let mut digest = Digester::new(&asset.digest);
    let mut downloaded = 0u64;
    // The first chunk is always reported, then at most every interval.
    let mut reported: Option<tokio::time::Instant> = None;
    loop {
      let chunk = until_cancelled(
        cancelled,
        tokio::time::timeout(STALL_TIMEOUT, response.chunk()),
      )
      .await?
      .map_err(|elapsed| {
        crate::logging::log_cause(&elapsed, "managed harness download stalled");
        Stop::Failed(InstallFailure::DownloadFailed)
      })?
      .map_err(failed_request("managed harness download broke off"))?;
      let Some(chunk) = chunk else {
        break;
      };
      downloaded = downloaded.saturating_add(chunk.len() as u64);
      if downloaded > asset.archive_bytes {
        return Err(Stop::Failed(InstallFailure::Oversize));
      }
      digest.update(&chunk);
      file
        .write_all(&chunk)
        .await
        .map_err(failed_storage("managed harness download was not written"))?;
      if reported.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL) {
        reported = Some(tokio::time::Instant::now());
        self.progress(harness, id, downloaded);
      }
    }
    file
      .flush()
      .await
      .map_err(failed_storage("managed harness download was not written"))?;
    file
      .sync_all()
      .await
      .map_err(failed_storage("managed harness download was not flushed"))?;
    self.progress(harness, id, downloaded);
    if downloaded != asset.archive_bytes {
      return Err(Stop::Failed(InstallFailure::Incomplete));
    }
    if !digest.matches(&asset.digest) {
      tracing::warn!("managed harness download failed its digest check");
      return Err(Stop::Failed(InstallFailure::DigestMismatch));
    }
    Ok(())
  }

  fn progress(&self, harness: ManagedHarness, id: &str, downloaded: u64) {
    self
      .slot(harness)
      .state
      .send_if_modified(|state| match state {
        HarnessInstallState::Downloading {
          operation_id,
          downloaded_bytes,
          ..
        } if operation_id == id && *downloaded_bytes != downloaded => {
          *downloaded_bytes = downloaded;
          true
        }
        _ => false,
      });
  }

  fn verifying(&self, harness: ManagedHarness, id: &str) {
    self
      .slot(harness)
      .state
      .send_if_modified(|state| match state {
        HarnessInstallState::Downloading {
          operation_id,
          version,
          active,
          ..
        } if operation_id == id => {
          let verifying = HarnessInstallState::Verifying {
            operation_id: operation_id.clone(),
            version: version.clone(),
            active: active.clone(),
          };
          *state = verifying;
          true
        }
        _ => false,
      });
  }

  /// Points new runs at `version`, keeping the release it replaces, and
  /// removes every other release no lease holds.
  async fn activate(&self, harness: ManagedHarness, version: &str) -> Result<(), Stop> {
    let dir = self.harness_dir(harness);
    let stale = {
      let slot = self.slot(harness);
      let previous = resolve_active(&dir)
        .ok()
        .map(|installed| installed.version)
        .filter(|previous| previous != version);
      write_pointer(
        &dir,
        &ActivePointer {
          version: version.to_string(),
          previous: previous.clone(),
        },
      )
      .map_err(failed_storage("managed harness pointer was not written"))?;
      let keep = [Some(version.to_string()), previous]
        .into_iter()
        .flatten()
        .chain(slot.leases.keys().cloned())
        .collect::<HashSet<_>>();
      drop(slot);
      release_dirs(&dir)
        .into_iter()
        .filter(|name| !keep.contains(name))
        .map(|name| dir.join(name))
        .collect::<Vec<_>>()
    };
    for path in stale {
      if let Err(error) = remove_tree(path).await {
        crate::logging::log_cause(
          &error,
          "superseded managed harness release was not removed",
        );
      }
    }
    Ok(())
  }
}

struct Installed {
  version: String,
  executable: PathBuf,
}

fn replace_state(slot: &Slot, state: HarnessInstallState) {
  slot.state.send_modify(|current| *current = state);
}

/// The active release, rolling the pointer back to the previous release when
/// the active one is incomplete. Callers hold the harness's slot lock, which
/// serialises every pointer write.
fn resolve_active(dir: &Path) -> Result<Installed, HarnessError> {
  let pointer = dir.join(ACTIVE_POINTER);
  if std::fs::symlink_metadata(&pointer).is_err() {
    return Err(HarnessError::NotInstalled);
  }
  let Some(ActivePointer { version, previous }) = read_record(&pointer) else {
    tracing::warn!("managed harness pointer is unreadable");
    return Err(HarnessError::CorruptInstall);
  };
  if let Some(executable) = installed_executable(dir, &version) {
    return Ok(Installed {
      version,
      executable,
    });
  }
  let Some((previous, executable)) = previous.and_then(|previous| {
    installed_executable(dir, &previous).map(|exe| (previous, exe))
  }) else {
    tracing::warn!("managed harness release is incomplete");
    return Err(HarnessError::CorruptInstall);
  };
  write_pointer(
    dir,
    &ActivePointer {
      version: previous.clone(),
      previous: None,
    },
  )
  .map_err(crate::logging::replaced_logged(
    "managed harness rollback was not written",
    HarnessError::Storage,
  ))?;
  tracing::warn!(
    "managed harness release is incomplete; rolled back to the previous release"
  );
  Ok(Installed {
    version: previous,
    executable,
  })
}

fn disk_state(dir: &Path) -> HarnessInstallState {
  match resolve_active(dir) {
    Ok(installed) => HarnessInstallState::settled(Some(installed.version)),
    Err(HarnessError::NotInstalled) => HarnessInstallState::NotInstalled,
    Err(_) => HarnessInstallState::Failed {
      reason: InstallFailure::CorruptInstall,
      active: None,
    },
  }
}

fn installed_record(dir: &Path, version: &str) -> Option<(InstallRecord, PathBuf)> {
  if !is_release_version(version) {
    return None;
  }
  let release = dir.join(version);
  let record: InstallRecord = read_record(&release.join(INSTALL_RECORD))?;
  if record.version != version || !is_contained_relative(&record.executable) {
    return None;
  }
  let executable = contained_join(&release, &record.executable);
  is_nonempty_file(&executable).then_some((record, executable))
}

fn installed_executable(dir: &Path, version: &str) -> Option<PathBuf> {
  installed_record(dir, version).map(|(_, executable)| executable)
}

/// The installed release's executable when it is exactly the pinned asset.
fn matching_release(dir: &Path, release: &HarnessRelease) -> Option<PathBuf> {
  let (record, executable) = installed_record(dir, &release.version)?;
  (record.digest == release.asset.digest
    && record.target == release.asset.target
    && record.executable == release.asset.executable)
    .then_some(executable)
}

fn release_dirs(dir: &Path) -> Vec<String> {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return Vec::new();
  };
  entries
    .filter_map(Result::ok)
    .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
    .filter_map(|entry| entry.file_name().into_string().ok())
    .filter(|name| is_release_version(name))
    .collect()
}

fn read_record<T: DeserializeOwned>(path: &Path) -> Option<T> {
  let metadata = std::fs::symlink_metadata(path).ok()?;
  if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES {
    return None;
  }
  let bytes = std::fs::read(path).ok()?;
  serde_json::from_slice(&bytes)
    .map_err(|error| {
      crate::logging::log_json_error(&error, "managed harness record is invalid")
    })
    .ok()
}

fn write_new_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
  let mut options = std::fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(path)?;
  file.write_all(contents)?;
  file.sync_all()
}

/// Replaces `active.json` in one rename, so a reader sees the old pointer or
/// the new one and never a partial file.
fn write_pointer(dir: &Path, pointer: &ActivePointer) -> std::io::Result<()> {
  let staged = dir.join(format!(
    "{POINTER_STAGING_PREFIX}{}.json",
    uuid::Uuid::new_v4()
  ));
  let contents = serde_json::to_vec(pointer).map_err(std::io::Error::other)?;
  let written = write_new_file(&staged, &contents)
    .and_then(|()| std::fs::rename(&staged, dir.join(ACTIVE_POINTER)));
  if written.is_err() {
    let _ = std::fs::remove_file(staged);
  }
  written
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
  let mut builder = std::fs::DirBuilder::new();
  builder.recursive(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::DirBuilderExt;
    builder.mode(0o700);
  }
  builder.create(path)
}

fn remove_staging(dir: &Path) {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return;
  };
  for entry in entries.filter_map(Result::ok) {
    let name = entry.file_name();
    let Some(name) = name.to_str() else {
      continue;
    };
    if !name.starts_with(STAGING_PREFIX) && !name.starts_with(POINTER_STAGING_PREFIX) {
      continue;
    }
    let path = entry.path();
    let removed = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
      std::fs::remove_dir_all(path)
    } else {
      std::fs::remove_file(path)
    };
    if let Err(error) = removed {
      crate::logging::log_cause(
        &error,
        "stale managed harness staging was not removed",
      );
    }
  }
}

async fn remove_tree(path: PathBuf) -> std::io::Result<()> {
  tokio::task::spawn_blocking(move || match std::fs::remove_dir_all(path) {
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    result => result,
  })
  .await
  .map_err(std::io::Error::other)?
}

/// Windows can keep a just-probed executable open for a moment (antivirus
/// scans, process rundown), so the publishing rename is retried there.
async fn publish(runtime: &Path, destination: &Path) -> std::io::Result<()> {
  let mut attempts = 0;
  loop {
    match tokio::fs::rename(runtime, destination).await {
      Err(_) if cfg!(windows) && attempts < 10 => {
        attempts += 1;
        tokio::time::sleep(Duration::from_millis(100)).await;
      }
      result => return result,
    }
  }
}

fn contained_join(root: &Path, relative: &str) -> PathBuf {
  relative
    .split('/')
    .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn is_nonempty_file(path: &Path) -> bool {
  std::fs::symlink_metadata(path)
    .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

/// Runs only `<executable> --version`: no prompt, no sign-in, and an
/// environment holding nothing but a throwaway home inside the staging
/// directory, so the probe can neither reach the network nor read the
/// user's own configuration.
fn probe_command(
  harness: ManagedHarness,
  executable: &Path,
  home: &Path,
) -> tokio::process::Command {
  let mut command = tokio::process::Command::new(executable);
  command
    .arg("--version")
    .env_clear()
    .env("HOME", home)
    .env("TMPDIR", home)
    .env(harness.config_env(), home)
    .envs(harness.probe_env().iter().copied())
    .current_dir(home)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .kill_on_drop(true);
  #[cfg(windows)]
  {
    command
      .env("USERPROFILE", home)
      .env("TEMP", home)
      .env("TMP", home)
      .creation_flags(CREATE_NO_WINDOW);
    for name in ["SystemRoot", "windir"] {
      if let Some(value) = std::env::var_os(name) {
        command.env(name, value);
      }
    }
  }
  command
}

async fn probe(
  harness: ManagedHarness,
  executable: &Path,
  version: &str,
  staging: &Path,
  cancelled: &mut watch::Receiver<bool>,
) -> Result<(), Stop> {
  let home = staging.join("probe-home");
  tokio::fs::create_dir_all(&home)
    .await
    .map_err(failed_storage("managed harness probe home was not created"))?;
  let mut command = probe_command(harness, executable, &home);
  let output = until_cancelled(
    cancelled,
    tokio::time::timeout(PROBE_TIMEOUT, probe_output(&mut command)),
  )
  .await?
  .map_err(|elapsed| {
    crate::logging::log_cause(&elapsed, "managed harness probe timed out");
    Stop::Failed(InstallFailure::ProbeFailed)
  })?
  .map_err(|error| {
    crate::logging::log_cause(&error, "managed harness probe did not start");
    Stop::Failed(InstallFailure::ProbeFailed)
  })?;
  if output.status.success()
    && harness.reports_version(&String::from_utf8_lossy(&output.stdout), version)
  {
    return Ok(());
  }
  tracing::warn!(status = ?output.status.code(), "managed harness probe reported another version");
  Err(Stop::Failed(InstallFailure::ProbeFailed))
}

/// A child forked elsewhere in the process can briefly hold the just-written
/// executable open, which fails the exec with "text file busy"; that is
/// retried a few times.
async fn probe_output(
  command: &mut tokio::process::Command,
) -> std::io::Result<std::process::Output> {
  let mut attempts = 0;
  loop {
    match command.output().await {
      Err(error)
        if error.kind() == std::io::ErrorKind::ExecutableFileBusy && attempts < 5 =>
      {
        attempts += 1;
        tokio::time::sleep(Duration::from_millis(50)).await;
      }
      result => return result,
    }
  }
}

async fn until_cancelled<T>(
  cancelled: &mut watch::Receiver<bool>,
  work: impl Future<Output = T>,
) -> Result<T, Stop> {
  tokio::select! {
    biased;
    () = wait_cancelled(cancelled) => Err(Stop::Cancelled),
    value = work => Ok(value),
  }
}

async fn wait_cancelled(cancelled: &mut watch::Receiver<bool>) {
  // Bound first: the borrow `wait_for` returns must not live across the
  // pending await below.
  let closed = cancelled.wait_for(|cancelled| *cancelled).await.is_err();
  if closed {
    std::future::pending::<()>().await;
  }
}

fn redirect_policy() -> reqwest::redirect::Policy {
  reqwest::redirect::Policy::custom(|attempt| {
    if attempt.previous().len() >= MAX_REDIRECTS {
      attempt.error("too many redirects")
    } else if attempt.url().scheme() == "https" {
      attempt.follow()
    } else {
      attempt.stop()
    }
  })
}

fn failed_storage<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> Stop {
  crate::logging::replaced_logged(what, Stop::Failed(InstallFailure::Storage))
}

fn failed_request(what: &'static str) -> impl FnOnce(reqwest::Error) -> Stop {
  move |error| {
    crate::logging::log_request_error(&error, what);
    Stop::Failed(InstallFailure::DownloadFailed)
  }
}

enum Digester {
  Sha256(sha2::Sha256),
  Sha512(sha2::Sha512),
}

impl Digester {
  fn new(expected: &ArchiveDigest) -> Self {
    match expected {
      ArchiveDigest::Sha256(_) => Self::Sha256(sha2::Sha256::new()),
      ArchiveDigest::Sha512(_) => Self::Sha512(sha2::Sha512::new()),
    }
  }

  fn update(&mut self, bytes: &[u8]) {
    match self {
      Self::Sha256(hasher) => hasher.update(bytes),
      Self::Sha512(hasher) => hasher.update(bytes),
    }
  }

  fn matches(self, expected: &ArchiveDigest) -> bool {
    match (self, expected) {
      (Self::Sha256(hasher), ArchiveDigest::Sha256(expected)) => {
        hex::encode(hasher.finalize()) == *expected
      }
      (Self::Sha512(hasher), ArchiveDigest::Sha512(expected)) => {
        hex::encode(hasher.finalize()) == *expected
      }
      (Self::Sha256(_), ArchiveDigest::Sha512(_))
      | (Self::Sha512(_), ArchiveDigest::Sha256(_)) => false,
    }
  }
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use crate::harness_archive::tests::{FixtureEntry, TempDir, archive};
  use crate::harness_release::ReleaseAsset;
  use std::sync::atomic::{AtomicUsize, Ordering};

  /// How the fixture server answers one archive URL.
  #[derive(Clone)]
  enum Serve {
    Bytes(Vec<u8>),
    /// Streams the bytes without a declared length.
    Chunked(Vec<u8>),
    /// Declares `declared` bytes, sends `bytes`, then breaks the connection.
    BrokenAfter {
      bytes: Vec<u8>,
      declared: u64,
    },
    /// Declares `declared` bytes, sends `bytes`, then sends nothing more.
    StallAfter {
      bytes: Vec<u8>,
      declared: u64,
    },
    /// Answers with the bytes once the semaphore hands out a permit.
    Gated {
      bytes: Vec<u8>,
      open: Arc<tokio::sync::Semaphore>,
    },
  }

  struct Fixture {
    base: String,
    requests: Arc<AtomicUsize>,
  }

  impl Fixture {
    fn url(&self, path: &str) -> String {
      format!("{}{path}", self.base)
    }

    fn requests(&self) -> usize {
      self.requests.load(Ordering::SeqCst)
    }
  }

  async fn serve(routes: Vec<(&'static str, Serve)>) -> Fixture {
    use axum::{Router, routing::get};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let mut router = Router::new();
    for (path, answer) in routes {
      let requests = Arc::clone(&requests);
      router = router.route(
        path,
        get(move || {
          let answer = answer.clone();
          let requests = Arc::clone(&requests);
          async move {
            requests.fetch_add(1, Ordering::SeqCst);
            respond(answer).await
          }
        }),
      );
    }
    tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    Fixture { base, requests }
  }

  type Chunk = Result<Vec<u8>, std::io::Error>;

  async fn respond(answer: Serve) -> axum::response::Response {
    use axum::{body::Body, http::header::CONTENT_LENGTH, response::IntoResponse};
    use futures_util::StreamExt;
    match answer {
      Serve::Bytes(bytes) => bytes.into_response(),
      Serve::Chunked(bytes) => {
        let chunks = bytes
          .chunks(512)
          .map(|chunk| Ok(chunk.to_vec()))
          .collect::<Vec<Chunk>>();
        Body::from_stream(futures_util::stream::iter(chunks)).into_response()
      }
      Serve::BrokenAfter { bytes, declared } => {
        let chunks: [Chunk; 2] = [
          Ok(bytes),
          Err(std::io::Error::other("fixture connection broke")),
        ];
        (
          [(CONTENT_LENGTH, declared.to_string())],
          Body::from_stream(futures_util::stream::iter(chunks)),
        )
          .into_response()
      }
      Serve::StallAfter { bytes, declared } => {
        let chunks: [Chunk; 1] = [Ok(bytes)];
        let stream = futures_util::stream::iter(chunks)
          .chain(futures_util::stream::pending::<Chunk>());
        (
          [(CONTENT_LENGTH, declared.to_string())],
          Body::from_stream(stream),
        )
          .into_response()
      }
      Serve::Gated { bytes, open } => {
        open.acquire().await.unwrap().forget();
        bytes.into_response()
      }
    }
  }

  /// A Codex-shaped archive whose executable prints `reported`, and only
  /// when it runs with the probe's private home and configuration directory.
  fn codex_archive(reported: &str) -> Vec<u8> {
    let script = format!(
      "#!/bin/sh\n\
       case \"$HOME\" in */probe-home) ;; *) exit 3 ;; esac\n\
       [ \"$CODEX_HOME\" = \"$HOME\" ] || exit 4\n\
       echo \"codex-cli {reported}\"\n"
    );
    archive(&[
      FixtureEntry::Directory("bin/"),
      FixtureEntry::File {
        path: "bin/codex",
        contents: script.as_bytes(),
        mode: 0o755,
      },
      FixtureEntry::File {
        path: "codex-package.json",
        contents: b"{}",
        mode: 0o644,
      },
    ])
  }

  fn release(version: &str, url: String, archive: &[u8]) -> HarnessRelease {
    HarnessRelease {
      version: version.to_string(),
      asset: ReleaseAsset {
        url,
        digest: ArchiveDigest::Sha256(hex::encode(sha2::Sha256::digest(archive))),
        archive_bytes: archive.len() as u64,
        target: "fixture-target".to_string(),
        executable: "bin/codex".to_string(),
      },
    }
  }

  fn open(dir: &TempDir, codex: HarnessRelease) -> HarnessInstallation {
    HarnessInstallation::open(
      dir.path().join("harness"),
      dir.path().join("harness-home"),
      HarnessReleases {
        codex: Some(codex),
        claude_code: None,
      },
    )
    .unwrap()
  }

  fn codex_dir(dir: &TempDir) -> PathBuf {
    dir.path().join("harness").join("codex")
  }

  fn pointer(dir: &TempDir) -> (String, Option<String>) {
    let bytes = std::fs::read(codex_dir(dir).join(ACTIVE_POINTER)).unwrap();
    let pointer: ActivePointer = serde_json::from_slice(&bytes).unwrap();
    (pointer.version, pointer.previous)
  }

  fn entries(dir: &Path) -> Vec<String> {
    let mut names = std::fs::read_dir(dir)
      .unwrap()
      .map(|entry| entry.unwrap().file_name().into_string().unwrap())
      .collect::<Vec<_>>();
    names.sort();
    names
  }

  fn names<const N: usize>(names: [&str; N]) -> Vec<String> {
    names.map(String::from).to_vec()
  }

  fn ready(version: &str) -> HarnessInstallState {
    HarnessInstallState::Ready {
      active: version.to_string(),
    }
  }

  fn failed(reason: InstallFailure, active: Option<&str>) -> HarnessInstallState {
    HarnessInstallState::Failed {
      reason,
      active: active.map(String::from),
    }
  }

  async fn settle(installation: &HarnessInstallation) -> HarnessInstallState {
    let mut changes = installation.subscribe(ManagedHarness::Codex);
    tokio::time::timeout(
      Duration::from_secs(30),
      changes.wait_for(|state| {
        !matches!(
          state,
          HarnessInstallState::Downloading { .. }
            | HarnessInstallState::Verifying { .. }
        )
      }),
    )
    .await
    .expect("the install settles")
    .unwrap()
    .clone()
  }

  async fn install(installation: &HarnessInstallation) -> HarnessInstallState {
    installation.start(ManagedHarness::Codex).unwrap();
    settle(installation).await
  }

  /// Fixture executables run as child processes; see `test_child_processes`.
  fn run<F: Future<Output = ()>>(test: impl FnOnce() -> F) {
    let _children = crate::test_child_processes::exclusive();
    tokio::runtime::Builder::new_multi_thread()
      .worker_threads(2)
      .enable_all()
      .build()
      .unwrap()
      .block_on(test());
  }

  #[test]
  fn installs_activates_and_leases_the_pinned_release() {
    run(|| async {
      let bytes = codex_archive("1.0.0");
      let fixture = serve(vec![("/v1.tar.gz", Serve::Bytes(bytes.clone()))]).await;
      let dir = TempDir::new();
      let installation =
        open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &bytes));
      assert_eq!(
        installation.state(ManagedHarness::Codex),
        HarnessInstallState::NotInstalled
      );
      assert!(
        !dir.path().join("harness").exists(),
        "opening creates nothing"
      );

      let started = installation.start(ManagedHarness::Codex).unwrap();
      assert!(matches!(
        &started,
        HarnessInstallState::Downloading { version, total_bytes, active: None, .. }
          if version == "1.0.0" && *total_bytes == bytes.len() as u64
      ));
      assert_eq!(settle(&installation).await, ready("1.0.0"));
      assert_eq!(entries(&codex_dir(&dir)), names(["1.0.0", ACTIVE_POINTER]));
      assert_eq!(pointer(&dir), ("1.0.0".to_string(), None));
      assert!(codex_dir(&dir).join("1.0.0").join(INSTALL_RECORD).is_file());

      let lease = installation.acquire(ManagedHarness::Codex).unwrap();
      assert_eq!(lease.version(), "1.0.0");
      assert_eq!(
        lease.executable(),
        codex_dir(&dir).join("1.0.0").join("bin").join("codex")
      );
      let (variable, config) = lease.config_env();
      assert_eq!(variable, "CODEX_HOME");
      assert_eq!(config, dir.path().join("harness-home").join("codex"));
      {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(config).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
      }

      // The pinned release is already active: nothing is downloaded again.
      assert_eq!(
        installation.start(ManagedHarness::Codex).unwrap(),
        ready("1.0.0")
      );
      assert_eq!(fixture.requests(), 1);
    });
  }

  #[test]
  fn a_digest_mismatch_installs_nothing() {
    run(|| async {
      let served = codex_archive("1.0.0");
      let mut tampered = served.clone();
      let last = tampered.len() - 1;
      tampered[last] ^= 0xff;
      let fixture = serve(vec![("/v1.tar.gz", Serve::Bytes(tampered))]).await;
      let dir = TempDir::new();
      let installation =
        open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &served));
      assert_eq!(
        install(&installation).await,
        failed(InstallFailure::DigestMismatch, None)
      );
      assert!(
        entries(&codex_dir(&dir)).is_empty(),
        "no release, no staging"
      );
      assert_eq!(
        installation.acquire(ManagedHarness::Codex).err(),
        Some(HarnessError::NotInstalled)
      );
    });
  }

  #[test]
  fn downloads_larger_than_the_pinned_size_are_cut_off() {
    run(|| async {
      let bytes = codex_archive("1.0.0");
      let mut larger = bytes.clone();
      larger.extend_from_slice(&[0; 4096]);
      let fixture = serve(vec![
        ("/declared.tar.gz", Serve::Bytes(larger.clone())),
        ("/chunked.tar.gz", Serve::Chunked(larger)),
      ])
      .await;
      for path in ["/declared.tar.gz", "/chunked.tar.gz"] {
        let dir = TempDir::new();
        let installation = open(&dir, release("1.0.0", fixture.url(path), &bytes));
        assert_eq!(
          install(&installation).await,
          failed(InstallFailure::Oversize, None),
          "{path}"
        );
        assert!(entries(&codex_dir(&dir)).is_empty(), "{path}");
      }
    });
  }

  #[test]
  fn truncated_and_interrupted_downloads_install_nothing() {
    run(|| async {
      let bytes = codex_archive("1.0.0");
      let half = bytes[..bytes.len() / 2].to_vec();
      let fixture = serve(vec![
        ("/short.tar.gz", Serve::Bytes(half.clone())),
        (
          "/broken.tar.gz",
          Serve::BrokenAfter {
            bytes: half,
            declared: bytes.len() as u64,
          },
        ),
      ])
      .await;
      for (path, reason) in [
        ("/short.tar.gz", InstallFailure::Incomplete),
        ("/broken.tar.gz", InstallFailure::DownloadFailed),
      ] {
        let dir = TempDir::new();
        let installation = open(&dir, release("1.0.0", fixture.url(path), &bytes));
        assert_eq!(install(&installation).await, failed(reason, None), "{path}");
        assert!(entries(&codex_dir(&dir)).is_empty(), "{path}");
      }
    });
  }

  #[test]
  fn a_failed_probe_keeps_the_previous_release_active() {
    run(|| async {
      let v1 = codex_archive("1.0.0");
      let wrong = codex_archive("9.9.9");
      let fixture = serve(vec![
        ("/v1.tar.gz", Serve::Bytes(v1.clone())),
        ("/v2.tar.gz", Serve::Bytes(wrong.clone())),
      ])
      .await;
      let dir = TempDir::new();
      let first = open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &v1));
      assert_eq!(install(&first).await, ready("1.0.0"));
      drop(first);

      let upgraded = open(&dir, release("2.0.0", fixture.url("/v2.tar.gz"), &wrong));
      assert_eq!(
        install(&upgraded).await,
        failed(InstallFailure::ProbeFailed, Some("1.0.0"))
      );
      assert_eq!(pointer(&dir), ("1.0.0".to_string(), None));
      assert_eq!(entries(&codex_dir(&dir)), names(["1.0.0", ACTIVE_POINTER]));
      let lease = upgraded.acquire(ManagedHarness::Codex).unwrap();
      assert_eq!(lease.version(), "1.0.0");
    });
  }

  #[test]
  fn removal_is_refused_while_a_lease_is_held() {
    run(|| async {
      let bytes = codex_archive("1.0.0");
      let fixture = serve(vec![("/v1.tar.gz", Serve::Bytes(bytes.clone()))]).await;
      let dir = TempDir::new();
      let installation =
        open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &bytes));
      assert_eq!(install(&installation).await, ready("1.0.0"));

      let lease = installation.acquire(ManagedHarness::Codex).unwrap();
      let second = installation.acquire(ManagedHarness::Codex).unwrap();
      drop(second);
      assert_eq!(
        installation.remove(ManagedHarness::Codex).await,
        Err(HarnessError::InUse)
      );
      assert!(lease.executable().is_file());
      assert_eq!(installation.state(ManagedHarness::Codex), ready("1.0.0"));

      drop(lease);
      installation.remove(ManagedHarness::Codex).await.unwrap();
      assert!(!codex_dir(&dir).exists());
      assert_eq!(
        installation.state(ManagedHarness::Codex),
        HarnessInstallState::NotInstalled
      );
      assert!(
        dir.path().join("harness-home").join("codex").is_dir(),
        "removing the releases keeps their configuration"
      );
    });
  }

  #[test]
  fn cancelling_mid_download_leaves_the_previous_release_active() {
    run(|| async {
      let v1 = codex_archive("1.0.0");
      let v2 = codex_archive("2.0.0");
      let fixture = serve(vec![
        ("/v1.tar.gz", Serve::Bytes(v1.clone())),
        (
          "/v2.tar.gz",
          Serve::StallAfter {
            bytes: v2[..v2.len() / 2].to_vec(),
            declared: v2.len() as u64,
          },
        ),
      ])
      .await;
      let dir = TempDir::new();
      let first = open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &v1));
      assert_eq!(install(&first).await, ready("1.0.0"));
      drop(first);

      let upgraded = open(&dir, release("2.0.0", fixture.url("/v2.tar.gz"), &v2));
      let HarnessInstallState::Downloading { operation_id, .. } =
        upgraded.start(ManagedHarness::Codex).unwrap()
      else {
        panic!("the upgrade starts downloading");
      };
      let mut changes = upgraded.subscribe(ManagedHarness::Codex);
      let progressed = tokio::time::timeout(
        Duration::from_secs(30),
        changes.wait_for(|state| {
          matches!(
            state,
            HarnessInstallState::Downloading { downloaded_bytes, .. }
              if *downloaded_bytes > 0
          )
        }),
      )
      .await
      .expect("the download makes progress")
      .is_ok();
      assert!(progressed);
      assert_eq!(
        upgraded
          .cancel(ManagedHarness::Codex, "another-operation")
          .err(),
        Some(HarnessError::NotCurrent)
      );
      upgraded
        .cancel(ManagedHarness::Codex, &operation_id)
        .unwrap();

      assert_eq!(settle(&upgraded).await, ready("1.0.0"));
      assert_eq!(pointer(&dir), ("1.0.0".to_string(), None));
      assert_eq!(
        entries(&codex_dir(&dir)),
        names(["1.0.0", ACTIVE_POINTER]),
        "the staging directory is gone"
      );
      assert_eq!(
        upgraded.cancel(ManagedHarness::Codex, &operation_id).err(),
        Some(HarnessError::NotCurrent)
      );
    });
  }

  #[test]
  fn an_incomplete_active_release_rolls_back_to_the_previous_one() {
    run(|| async {
      let v1 = codex_archive("1.0.0");
      let v2 = codex_archive("2.0.0");
      let fixture = serve(vec![
        ("/v1.tar.gz", Serve::Bytes(v1.clone())),
        ("/v2.tar.gz", Serve::Bytes(v2.clone())),
      ])
      .await;
      let dir = TempDir::new();
      let first = open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &v1));
      assert_eq!(install(&first).await, ready("1.0.0"));
      drop(first);
      let upgraded = open(&dir, release("2.0.0", fixture.url("/v2.tar.gz"), &v2));
      assert_eq!(install(&upgraded).await, ready("2.0.0"));
      assert_eq!(
        pointer(&dir),
        ("2.0.0".to_string(), Some("1.0.0".to_string()))
      );

      let executable = codex_dir(&dir).join("2.0.0").join("bin").join("codex");
      std::fs::remove_file(executable).unwrap();
      let lease = upgraded.acquire(ManagedHarness::Codex).unwrap();
      assert_eq!(lease.version(), "1.0.0");
      assert_eq!(pointer(&dir), ("1.0.0".to_string(), None));
      assert_eq!(upgraded.state(ManagedHarness::Codex), ready("1.0.0"));
    });
  }

  /// Places a complete release directory, as a finished install leaves it.
  fn stage(dir: &TempDir, version: &str) {
    let release = codex_dir(dir).join(version);
    std::fs::create_dir_all(release.join("bin")).unwrap();
    std::fs::write(release.join("bin").join("codex"), b"#!/bin/sh\n").unwrap();
    let record = InstallRecord {
      version: version.to_string(),
      target: "fixture-target".to_string(),
      digest: ArchiveDigest::Sha256("00".repeat(32)),
      executable: "bin/codex".to_string(),
    };
    std::fs::write(
      release.join(INSTALL_RECORD),
      serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
  }

  #[test]
  fn activation_keeps_the_previous_and_leased_releases_only() {
    run(|| async {
      let bytes = codex_archive("1.0.0");
      let fixture = serve(vec![("/v1.tar.gz", Serve::Bytes(bytes.clone()))]).await;
      let dir = TempDir::new();
      let installation =
        open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &bytes));
      assert_eq!(install(&installation).await, ready("1.0.0"));
      let lease = installation.acquire(ManagedHarness::Codex).unwrap();

      for version in ["2.0.0", "3.0.0"] {
        stage(&dir, version);
        let activated = installation
          .0
          .activate(ManagedHarness::Codex, version)
          .await;
        assert!(activated.is_ok());
      }
      assert_eq!(
        entries(&codex_dir(&dir)),
        names(["1.0.0", "2.0.0", "3.0.0", ACTIVE_POINTER]),
        "1.0.0 is neither active nor previous, but leased"
      );
      assert_eq!(
        pointer(&dir),
        ("3.0.0".to_string(), Some("2.0.0".to_string()))
      );

      drop(lease);
      stage(&dir, "4.0.0");
      let activated = installation
        .0
        .activate(ManagedHarness::Codex, "4.0.0")
        .await;
      assert!(activated.is_ok());
      assert_eq!(
        entries(&codex_dir(&dir)),
        names(["3.0.0", "4.0.0", ACTIVE_POINTER])
      );
    });
  }

  #[test]
  fn a_corrupted_install_record_is_reported_and_reinstalled() {
    run(|| async {
      let bytes = codex_archive("1.0.0");
      let fixture = serve(vec![("/v1.tar.gz", Serve::Bytes(bytes.clone()))]).await;
      let dir = TempDir::new();
      let pinned = release("1.0.0", fixture.url("/v1.tar.gz"), &bytes);
      assert_eq!(install(&open(&dir, pinned.clone())).await, ready("1.0.0"));

      let record = codex_dir(&dir).join("1.0.0").join(INSTALL_RECORD);
      std::fs::write(record, b"{\"version\":").unwrap();
      let reopened = open(&dir, pinned.clone());
      let corrupt = failed(InstallFailure::CorruptInstall, None);
      assert_eq!(reopened.state(ManagedHarness::Codex), corrupt);
      assert_eq!(
        reopened.acquire(ManagedHarness::Codex).err(),
        Some(HarnessError::CorruptInstall)
      );
      assert_eq!(install(&reopened).await, ready("1.0.0"));
      assert_eq!(
        fixture.requests(),
        2,
        "the damaged release is fetched again"
      );
      assert!(reopened.acquire(ManagedHarness::Codex).is_ok());

      std::fs::write(codex_dir(&dir).join(ACTIVE_POINTER), b"not json").unwrap();
      assert_eq!(open(&dir, pinned).state(ManagedHarness::Codex), corrupt);
    });
  }

  #[test]
  fn concurrent_installs_of_one_harness_share_one_download() {
    run(|| async {
      let bytes = codex_archive("1.0.0");
      let gate = Arc::new(tokio::sync::Semaphore::new(0));
      let fixture = serve(vec![(
        "/v1.tar.gz",
        Serve::Gated {
          bytes: bytes.clone(),
          open: Arc::clone(&gate),
        },
      )])
      .await;
      let dir = TempDir::new();
      let installation =
        open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &bytes));
      let (first, second) = std::thread::scope(|scope| {
        let first = scope.spawn(|| installation.start(ManagedHarness::Codex));
        let second = scope.spawn(|| installation.start(ManagedHarness::Codex));
        (
          first.join().unwrap().unwrap(),
          second.join().unwrap().unwrap(),
        )
      });
      let operation = |state: &HarnessInstallState| match state {
        HarnessInstallState::Downloading { operation_id, .. } => operation_id.clone(),
        other => panic!("both calls see the running install, not {other:?}"),
      };
      assert_eq!(operation(&first), operation(&second));
      gate.add_permits(1);
      assert_eq!(settle(&installation).await, ready("1.0.0"));
      assert_eq!(fixture.requests(), 1);
    });
  }

  #[test]
  fn leftover_staging_is_removed_when_opened() {
    let dir = TempDir::new();
    let harness = codex_dir(&dir);
    std::fs::create_dir_all(harness.join(".install-left").join("runtime")).unwrap();
    std::fs::write(harness.join(".active-left.json"), b"{}").unwrap();
    let installation = HarnessInstallation::open(
      dir.path().join("harness"),
      dir.path().join("harness-home"),
      HarnessReleases {
        codex: None,
        claude_code: None,
      },
    )
    .unwrap();
    assert!(entries(&harness).is_empty());
    assert_eq!(
      installation.start(ManagedHarness::Codex).err(),
      Some(HarnessError::UnsupportedPlatform)
    );
  }

  #[test]
  fn the_probe_runs_only_version_with_a_private_environment() {
    let home = Path::new("/private/probe-home");
    let expected_home = Some(home.to_str().unwrap().to_string());
    for harness in ManagedHarness::ALL {
      let command = probe_command(harness, Path::new("/opt/tool"), home);
      let command = command.as_std();
      assert_eq!(command.get_args().collect::<Vec<_>>(), ["--version"]);
      let envs = command
        .get_envs()
        .map(|(key, value)| {
          (
            key.to_str().unwrap().to_string(),
            value.map(|value| value.to_str().unwrap().to_string()),
          )
        })
        .collect::<HashMap<_, _>>();
      assert_eq!(envs.get("HOME"), Some(&expected_home));
      assert_eq!(envs.get(harness.config_env()), Some(&expected_home));
      assert!(!envs.contains_key("PATH"));
      for (key, value) in harness.probe_env() {
        assert_eq!(envs.get(*key), Some(&Some((*value).to_string())));
      }
    }
  }
}
