use serde::{Deserialize, Serialize};
use std::{
  fs::{self, OpenOptions},
  io::{self, Read, Write},
  path::{Path, PathBuf},
  sync::{Arc, Mutex},
  time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

use crate::{
  config::APP_DATA_DIR_NAME,
  desktop_crash_native::{NativeCrashSummary, find_summary},
  desktop_telemetry::{DesktopErrorDetail, DesktopTelemetry},
};

const MARKER_NAME: &str = "desktop-run.json";
const MAX_MARKER_BYTES: u64 = 4096;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RunMarker {
  version: String,
  start_time_secs: u64,
  pid: u32,
  panic: Option<PanicSummary>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PanicSummary {
  location: Option<String>,
  thread: String,
  message: String,
}

impl PanicSummary {
  fn new(
    message: &str,
    file: Option<&str>,
    line: Option<u32>,
    thread: Option<&str>,
  ) -> Self {
    let detail = DesktopErrorDetail {
      error_name: "RustPanic".into(),
      message: message.into(),
      frame: None,
    }
    .sanitized();
    Self {
      location: file.zip(line).and_then(|(file, line)| {
        // Rust location paths can include the builder's home directory.
        let filename = file.rsplit(['/', '\\']).next()?;
        (!filename.is_empty()
          && filename.len() <= 100
          && filename
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)))
        .then(|| format!("{filename}:{line}"))
      }),
      thread: match thread {
        Some(
          name @ ("main"
          | "unknown"
          | "tokio-runtime-worker"
          | "stella-clipboard-watcher"),
        ) => name.into(),
        Some(name) if crate::desktop_telemetry::is_message_digest(name) => name.into(),
        Some(name) => crate::desktop_telemetry::message_digest(name),
        None => "unknown".into(),
      },
      message: detail.message,
    }
  }

  fn sanitized(self) -> Self {
    // Disk is a trust boundary too: never forward editable marker strings.
    let location = self.location.and_then(|location| {
      let (file, line) = location.rsplit_once(':')?;
      Self::new("", Some(file), Some(line.parse().ok()?), None).location
    });
    let mut sanitized = Self::new(&self.message, None, None, Some(&self.thread));
    sanitized.location = location;
    sanitized
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CrashReport {
  Panic { panic: PanicSummary },
  Native { native: NativeCrashSummary },
  Unknown,
}

/// Run records carry bounded diagnostics, unlike the empty preference markers
/// owned by marker_file. An owned record is consumed before it enters the queue.
#[derive(Clone)]
pub struct DesktopCrashMonitor {
  state: Arc<Mutex<CrashState>>,
}

enum RunLifecycle {
  Running,
  Exiting,
}

enum MonitoringMode {
  Enabled(RunMarker),
  Disabled,
}

enum TrackingState {
  Waiting { path: PathBuf, mode: MonitoringMode },
  Owned { lock: RunLock, mode: MonitoringMode },
  Unavailable,
}

#[derive(Clone, Copy)]
enum PreviousCrashDisposition {
  Capture,
  Discard,
}

struct CrashState {
  lifecycle: RunLifecycle,
  tracking: TrackingState,
  previous_crash: PreviousCrashDisposition,
}

enum Acquisition {
  Complete(Option<RunMarker>),
  Contended,
}

struct RetryPolicy {
  timeout: Duration,
  initial_delay: Duration,
  maximum_delay: Duration,
}

const STARTUP_RETRY_POLICY: RetryPolicy = RetryPolicy {
  timeout: Duration::from_secs(60),
  initial_delay: Duration::from_millis(50),
  maximum_delay: Duration::from_secs(1),
};

impl DesktopCrashMonitor {
  pub fn start(telemetry: &DesktopTelemetry) -> Self {
    let now = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_or(0, |time| time.as_secs());
    let tracking = match dirs::data_local_dir() {
      Some(dir) => TrackingState::Waiting {
        path: dir.join(APP_DATA_DIR_NAME).join(MARKER_NAME),
        mode: if telemetry.is_enabled() {
          MonitoringMode::Enabled(new_marker(now, std::process::id()))
        } else {
          MonitoringMode::Disabled
        },
      },
      None => {
        tracing::warn!("desktop crash marker directory unavailable");
        TrackingState::Unavailable
      }
    };
    let monitor = Self {
      state: Arc::new(Mutex::new(CrashState {
        lifecycle: RunLifecycle::Running,
        tracking,
        previous_crash: if telemetry.is_enabled() {
          PreviousCrashDisposition::Capture
        } else {
          PreviousCrashDisposition::Discard
        },
      })),
    };
    // The hook can retain a redacted panic while ownership is pending; it
    // never writes through another process's lock.
    monitor.install_panic_hook();
    match monitor.try_acquire() {
      Ok(Acquisition::Complete(previous)) => capture_previous(telemetry, previous),
      Ok(Acquisition::Contended) => {
        let waiting = monitor.clone();
        let telemetry = telemetry.clone();
        let retry_thread = std::thread::Builder::new()
          .name("stella-crash-monitor".into())
          .spawn(move || {
            match waiting.acquire_with_retry(&STARTUP_RETRY_POLICY) {
              Ok(Acquisition::Complete(previous)) => capture_previous(&telemetry, previous),
              Ok(Acquisition::Contended) => {
                if waiting.state.lock().is_ok_and(|state| matches!(state.lifecycle, RunLifecycle::Running)) {
                  tracing::warn!("desktop crash marker ownership timed out");
                }
              }
              Err(error) => tracing::warn!(kind = ?error.kind(), "desktop crash marker startup failed"),
            }
          });
        if retry_thread.is_err() {
          tracing::warn!("desktop crash marker retry thread unavailable");
        }
      }
      Err(error) => {
        tracing::warn!(kind = ?error.kind(), "desktop crash marker startup failed")
      }
    }
    monitor
  }

  fn try_acquire(&self) -> io::Result<Acquisition> {
    let mut state = self
      .state
      .lock()
      .map_err(|_| io::Error::other("crash marker lock unavailable"))?;
    if matches!(state.lifecycle, RunLifecycle::Exiting) {
      return Ok(Acquisition::Contended);
    }
    let TrackingState::Waiting { path, .. } = &state.tracking else {
      return Ok(Acquisition::Complete(None));
    };
    let Some(lock) = lock_run(path)? else {
      return Ok(Acquisition::Contended);
    };
    let TrackingState::Waiting { mode, .. } =
      std::mem::replace(&mut state.tracking, TrackingState::Unavailable)
    else {
      unreachable!("tracking state changed while locked")
    };
    let (mode, previous) = match mode {
      MonitoringMode::Enabled(run) => {
        let previous = begin_run(&lock, run.start_time_secs, run.pid)?;
        let previous = match state.previous_crash {
          PreviousCrashDisposition::Capture => previous,
          PreviousCrashDisposition::Discard => None,
        };
        // A caught panic may have arrived while startup awaited ownership.
        if run.panic.is_some() {
          write_marker(&lock.path, &run)?;
        }
        (MonitoringMode::Enabled(run), previous)
      }
      MonitoringMode::Disabled => {
        discard_disabled_marker(&lock)?;
        (MonitoringMode::Disabled, None)
      }
    };
    state.tracking = TrackingState::Owned { lock, mode };
    Ok(Acquisition::Complete(previous))
  }

  fn acquire_with_retry(&self, policy: &RetryPolicy) -> io::Result<Acquisition> {
    let started = Instant::now();
    let mut delay = policy.initial_delay;
    loop {
      if let result @ Acquisition::Complete(_) = self.try_acquire()? {
        return Ok(result);
      }
      let remaining = policy.timeout.saturating_sub(started.elapsed());
      if remaining.is_zero() {
        let mut state = self
          .state
          .lock()
          .map_err(|_| io::Error::other("crash marker lock unavailable"))?;
        if matches!(state.lifecycle, RunLifecycle::Running) {
          state.tracking = TrackingState::Unavailable;
        }
        return Ok(Acquisition::Contended);
      }
      std::thread::sleep(delay.min(remaining));
      delay = delay.saturating_mul(2).min(policy.maximum_delay);
    }
  }

  fn install_panic_hook(&self) {
    let state = Arc::clone(&self.state);
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
      let message = info
        .payload()
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic");
      let thread = std::thread::current();
      let summary = PanicSummary::new(
        message,
        info.location().map(|location| location.file()),
        info.location().map(|location| location.line()),
        thread.name(),
      );
      // Never block a panicking thread behind another panic or a poisoned lock.
      if let Ok(mut state) = state.try_lock() {
        match &mut state.tracking {
          TrackingState::Waiting {
            mode: MonitoringMode::Enabled(run),
            ..
          } => run.panic = Some(summary),
          TrackingState::Owned {
            lock,
            mode: MonitoringMode::Enabled(run),
          } => {
            run.panic = Some(summary);
            if write_marker(&lock.path, run).is_err() {
              tracing::warn!("desktop panic marker write failed");
            }
          }
          TrackingState::Waiting {
            mode: MonitoringMode::Disabled,
            ..
          }
          | TrackingState::Owned {
            mode: MonitoringMode::Disabled,
            ..
          }
          | TrackingState::Unavailable => {}
        }
      }
      default(info);
    }));
  }

  pub fn set_reporting(&self, enabled: bool) {
    let Ok(mut state) = self.state.lock() else {
      tracing::warn!("desktop crash marker lock unavailable");
      return;
    };
    // Once discarded, old crash diagnostics must stay discarded even if
    // reporting is re-enabled before the previous owner releases its lock.
    if !enabled {
      state.previous_crash = PreviousCrashDisposition::Discard;
    }
    let now = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_or(0, |time| time.as_secs());
    match &mut state.tracking {
      TrackingState::Waiting { mode, .. } => {
        *mode = if enabled {
          MonitoringMode::Enabled(new_marker(now, std::process::id()))
        } else {
          MonitoringMode::Disabled
        };
      }
      TrackingState::Owned { lock, mode } => {
        if enabled {
          if matches!(mode, MonitoringMode::Disabled) {
            let run = new_marker(now, std::process::id());
            if write_marker(&lock.path, &run).is_err() {
              tracing::warn!("desktop crash marker enablement failed");
              return;
            }
            *mode = MonitoringMode::Enabled(run);
          }
        } else {
          *mode = MonitoringMode::Disabled;
          if let Err(error) = fs::remove_file(&lock.path)
            && error.kind() != io::ErrorKind::NotFound
          {
            tracing::warn!(kind = ?error.kind(), "desktop crash marker opt-out cleanup failed");
          }
        }
      }
      TrackingState::Unavailable => {}
    }
  }

  #[cfg(test)]
  pub(crate) fn at(path: PathBuf) -> Self {
    Self {
      state: Arc::new(Mutex::new(CrashState {
        lifecycle: RunLifecycle::Running,
        tracking: TrackingState::Waiting {
          path,
          mode: MonitoringMode::Disabled,
        },
        previous_crash: PreviousCrashDisposition::Discard,
      })),
    }
  }

  pub fn clean_exit(&self) {
    let Ok(mut state) = self.state.lock() else {
      tracing::warn!("desktop crash marker lock unavailable");
      return;
    };
    // A queued retry must not recreate a marker after clean exit begins.
    state.lifecycle = RunLifecycle::Exiting;
    let TrackingState::Owned {
      lock,
      mode: MonitoringMode::Enabled(_),
    } = &state.tracking
    else {
      return;
    };
    if let Err(error) = fs::remove_file(&lock.path)
      && error.kind() != io::ErrorKind::NotFound
    {
      tracing::warn!(kind = ?error.kind(), "desktop crash marker removal failed");
    }
  }

  #[cfg(any(windows, test))]
  fn resume_after_failed_update(&self) {
    let Ok(mut state) = self.state.lock() else {
      tracing::warn!("desktop crash marker lock unavailable");
      return;
    };
    state.lifecycle = RunLifecycle::Running;
    if let TrackingState::Owned {
      lock,
      mode: MonitoringMode::Enabled(run),
    } = &state.tracking
      && write_marker(&lock.path, run).is_err()
    {
      tracing::warn!("desktop crash marker restoration failed");
    }
  }
}

fn capture_previous(telemetry: &DesktopTelemetry, previous: Option<RunMarker>) {
  let Some(previous) = previous else { return };
  let report = match previous.panic {
    Some(panic) => CrashReport::Panic {
      panic: panic.sanitized(),
    },
    None => match find_summary(previous.start_time_secs) {
      Some(native) => CrashReport::Native { native },
      None => CrashReport::Unknown,
    },
  };
  telemetry.capture_startup_crash(report);
}

pub fn clean_exit(app: &tauri::AppHandle) {
  if let Some(monitor) = app.try_state::<DesktopCrashMonitor>() {
    monitor.clean_exit();
  }
}

#[cfg(windows)]
pub fn resume_after_failed_update(app: &tauri::AppHandle) {
  if let Some(monitor) = app.try_state::<DesktopCrashMonitor>() {
    monitor.resume_after_failed_update();
  }
}

struct RunLock {
  path: PathBuf,
  _file: fs::File,
}

fn lock_run(path: &Path) -> io::Result<Option<RunLock>> {
  let parent = path.parent().ok_or_else(|| {
    io::Error::new(io::ErrorKind::InvalidInput, "missing marker directory")
  })?;
  fs::create_dir_all(parent)?;
  let mut options = OpenOptions::new();
  options.read(true).write(true).create(true).truncate(false);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let file = options.open(path.with_extension("lock"))?;
  match file.try_lock() {
    Ok(()) => Ok(Some(RunLock {
      path: path.to_path_buf(),
      _file: file,
    })),
    Err(fs::TryLockError::WouldBlock) => Ok(None),
    Err(fs::TryLockError::Error(error)) => Err(error),
  }
}

fn new_marker(start_time_secs: u64, pid: u32) -> RunMarker {
  RunMarker {
    version: env!("CARGO_PKG_VERSION").into(),
    start_time_secs,
    pid,
    panic: None,
  }
}

fn read_marker(path: &Path) -> io::Result<Option<RunMarker>> {
  let metadata = match fs::symlink_metadata(path) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(error),
  };
  if !metadata.file_type().is_file() || metadata.len() > MAX_MARKER_BYTES {
    return Err(io::Error::new(
      io::ErrorKind::InvalidData,
      "invalid crash marker",
    ));
  }
  let mut bytes = Vec::new();
  fs::File::open(path)?
    .take(MAX_MARKER_BYTES + 1)
    .read_to_end(&mut bytes)?;
  serde_json::from_slice(&bytes)
    .map(Some)
    .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid crash marker"))
}

fn read_previous_run(path: &Path) -> io::Result<Option<RunMarker>> {
  match read_marker(path) {
    Err(error)
      if error.kind() == io::ErrorKind::InvalidData
        && fs::symlink_metadata(path)
          .is_ok_and(|metadata| metadata.file_type().is_file()) =>
    {
      // An interrupted or obsolete record must not disable all future runs.
      fs::remove_file(path)?;
      tracing::warn!("invalid desktop crash marker discarded");
      Ok(None)
    }
    result => result,
  }
}

fn write_marker(path: &Path, marker: &RunMarker) -> io::Result<()> {
  let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
  // Atomic replacement preserves the startup record if a panic write fails.
  let mut options = OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(&temporary)?;
  let result = (|| {
    serde_json::to_writer(&mut file, marker)?;
    file.flush()?;
    file.sync_all()?;
    fs::rename(&temporary, path)
  })();
  if result.is_err() {
    let _ = fs::remove_file(temporary);
  }
  result
}

fn begin_run(lock: &RunLock, now: u64, pid: u32) -> io::Result<Option<RunMarker>> {
  // The exclusive OS lock proves the old owner exited. Its PID may already
  // belong to an unrelated process, so PID liveness cannot veto recovery.
  let path = &lock.path;
  let previous = read_previous_run(path)?;
  if previous.is_some() {
    // Consume first: a failed enqueue or another abort must not replay it.
    fs::remove_file(path)?;
  }
  write_marker(path, &new_marker(now, pid))?;
  Ok(previous)
}

fn discard_disabled_marker(lock: &RunLock) -> io::Result<()> {
  if read_previous_run(&lock.path)?.is_some() {
    fs::remove_file(&lock.path)?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn path() -> PathBuf {
    std::env::temp_dir()
      .join(format!("stella-crash-{}", uuid::Uuid::new_v4()))
      .join(MARKER_NAME)
  }

  fn monitor(path: PathBuf, run: RunMarker) -> DesktopCrashMonitor {
    DesktopCrashMonitor {
      state: Arc::new(Mutex::new(CrashState {
        lifecycle: RunLifecycle::Running,
        tracking: TrackingState::Owned {
          lock: RunLock {
            _file: fs::File::open(path.with_extension("lock")).unwrap(),
            path,
          },
          mode: MonitoringMode::Enabled(run),
        },
        previous_crash: PreviousCrashDisposition::Capture,
      })),
    }
  }

  fn waiting_monitor(path: PathBuf, run: RunMarker) -> DesktopCrashMonitor {
    DesktopCrashMonitor {
      state: Arc::new(Mutex::new(CrashState {
        lifecycle: RunLifecycle::Running,
        tracking: TrackingState::Waiting {
          path,
          mode: MonitoringMode::Enabled(run),
        },
        previous_crash: PreviousCrashDisposition::Capture,
      })),
    }
  }

  const TEST_RETRY_POLICY: RetryPolicy = RetryPolicy {
    timeout: Duration::from_secs(1),
    initial_delay: Duration::from_millis(1),
    maximum_delay: Duration::from_millis(5),
  };

  #[test]
  fn replacement_is_monitored_after_the_previous_instance_releases_its_lock() {
    let path = path();
    let previous = lock_run(&path).unwrap().unwrap();
    begin_run(&previous, 100, 41).unwrap();
    let replacement = waiting_monitor(path.clone(), new_marker(200, 42));
    assert!(matches!(
      replacement.try_acquire().unwrap(),
      Acquisition::Contended
    ));
    // A caught panic while waiting is retained until the marker is writable.
    {
      let mut state = replacement.state.lock().unwrap();
      let TrackingState::Waiting {
        mode: MonitoringMode::Enabled(run),
        ..
      } = &mut state.tracking
      else {
        panic!("expected pending ownership")
      };
      run.panic = Some(PanicSummary::new(
        "private document",
        Some("code.rs"),
        Some(42),
        Some("main"),
      ));
    }
    let release = std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(20));
      drop(previous);
    });
    let Acquisition::Complete(Some(previous)) =
      replacement.acquire_with_retry(&TEST_RETRY_POLICY).unwrap()
    else {
      panic!("expected recovered ownership")
    };
    release.join().unwrap();
    assert_eq!(previous.pid, 41);
    let current = read_marker(&path).unwrap().unwrap();
    assert_eq!(current.pid, 42);
    assert_eq!(current.start_time_secs, 200);
    assert_eq!(
      current.panic.unwrap().location.as_deref(),
      Some("code.rs:42")
    );
    assert!(lock_run(&path).unwrap().is_none());
    replacement.clean_exit();
    assert!(read_marker(&path).unwrap().is_none());
    drop(replacement);
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn retries_are_bounded_and_clean_exit_prevents_late_marker_creation() {
    let path = path();
    let previous = lock_run(&path).unwrap().unwrap();
    let replacement = waiting_monitor(path.clone(), new_marker(200, 42));
    let policy = RetryPolicy {
      timeout: Duration::ZERO,
      initial_delay: Duration::from_millis(1),
      maximum_delay: Duration::from_millis(1),
    };
    assert!(matches!(
      replacement.acquire_with_retry(&policy).unwrap(),
      Acquisition::Contended
    ));
    assert!(matches!(
      replacement.state.lock().unwrap().tracking,
      TrackingState::Unavailable
    ));
    drop(replacement);
    let replacement = waiting_monitor(path.clone(), new_marker(200, 42));
    replacement.clean_exit();
    drop(previous);
    assert!(matches!(
      replacement.try_acquire().unwrap(),
      Acquisition::Contended
    ));
    assert!(read_marker(&path).unwrap().is_none());
    replacement.resume_after_failed_update();
    assert!(matches!(
      replacement.try_acquire().unwrap(),
      Acquisition::Complete(None)
    ));
    assert_eq!(read_marker(&path).unwrap().unwrap().pid, 42);
    replacement.clean_exit();
    drop(replacement);
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn opt_out_discards_stale_crashes_even_if_reenabled_before_acquiring_ownership() {
    let path = path();
    let previous = lock_run(&path).unwrap().unwrap();
    begin_run(&previous, 100, 41).unwrap();
    let monitor = waiting_monitor(path.clone(), new_marker(200, 42));
    monitor.set_reporting(false);
    monitor.set_reporting(true);
    drop(previous);
    assert!(matches!(
      monitor.try_acquire().unwrap(),
      Acquisition::Complete(None)
    ));
    assert_eq!(read_marker(&path).unwrap().unwrap().pid, std::process::id());
    monitor.set_reporting(false);
    assert!(read_marker(&path).unwrap().is_none());
    monitor.set_reporting(true);
    assert!(read_marker(&path).unwrap().is_some());
    monitor.clean_exit();
    drop(monitor);
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn concurrent_startup_cannot_claim_or_consume_another_runs_marker() {
    let path = path();
    let lock = lock_run(&path).unwrap().unwrap();
    assert!(lock_run(&path).unwrap().is_none());
    drop(lock);
    assert!(lock_run(&path).unwrap().is_some());
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn clean_exit_clears_the_run_and_is_idempotent() {
    let path = path();
    let lock = lock_run(&path).unwrap().unwrap();
    assert!(begin_run(&lock, 100, 41).unwrap().is_none());
    let monitor = monitor(path.clone(), new_marker(100, 41));
    monitor.clean_exit();
    monitor.clean_exit();
    assert!(read_marker(&path).unwrap().is_none());
    drop(monitor);
    drop(lock);
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn failed_update_restores_the_marker_after_before_exit_cleanup() {
    let path = path();
    let lock = lock_run(&path).unwrap().unwrap();
    begin_run(&lock, 100, 41).unwrap();
    let monitor = monitor(path.clone(), new_marker(100, 41));
    monitor.clean_exit();
    assert!(read_marker(&path).unwrap().is_none());
    monitor.resume_after_failed_update();
    assert_eq!(read_marker(&path).unwrap().unwrap().pid, 41);
    monitor.clean_exit();
    drop(monitor);
    drop(lock);
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn leftover_is_consumed_once_and_live_owners_are_never_overwritten() {
    let path = path();
    let lock = lock_run(&path).unwrap().unwrap();
    assert!(begin_run(&lock, 100, 41).unwrap().is_none());
    assert!(lock_run(&path).unwrap().is_none());
    assert_eq!(read_marker(&path).unwrap().unwrap().pid, 41);
    drop(lock);
    let lock = lock_run(&path).unwrap().unwrap();
    let previous = begin_run(&lock, 200, 42).unwrap().unwrap();
    assert_eq!(previous.start_time_secs, 100);
    assert_eq!(previous.pid, 41);
    assert!(lock_run(&path).unwrap().is_none());
    assert_eq!(read_marker(&path).unwrap().unwrap().pid, 42);
    monitor(path.clone(), new_marker(200, 42)).clean_exit();
    assert!(begin_run(&lock, 300, 43).unwrap().is_none());
    monitor(path.clone(), new_marker(300, 43)).clean_exit();
    drop(lock);
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn stale_marker_with_an_unrelated_live_pid_is_consumed_when_lock_is_available() {
    let path = path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    // The test process is alive, but never owned this stale app run.
    let unrelated_live_pid = std::process::id();
    write_marker(&path, &new_marker(100, unrelated_live_pid)).unwrap();
    let lock = lock_run(&path).unwrap().unwrap();
    let current_pid = unrelated_live_pid.checked_add(1).unwrap();
    let previous = begin_run(&lock, 200, current_pid).unwrap().unwrap();
    assert_eq!(previous.pid, unrelated_live_pid);
    assert_eq!(previous.start_time_secs, 100);
    let current = read_marker(&path).unwrap().unwrap();
    assert_eq!(current.pid, current_pid);
    assert_eq!(current.start_time_secs, 200);
    monitor(path.clone(), current).clean_exit();
    assert!(begin_run(&lock, 300, current_pid).unwrap().is_none());
    monitor(path.clone(), new_marker(300, current_pid)).clean_exit();
    drop(lock);
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn disabled_telemetry_discards_old_diagnostics_after_claiming_ownership() {
    let path = path();
    let lock = lock_run(&path).unwrap().unwrap();
    begin_run(&lock, 100, std::process::id()).unwrap();
    discard_disabled_marker(&lock).unwrap();
    assert!(read_marker(&path).unwrap().is_none());
    drop(lock);
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn invalid_regular_markers_do_not_disable_future_runs() {
    let path = path();
    let lock = lock_run(&path).unwrap().unwrap();
    for bytes in [
      b"interrupted record".to_vec(),
      vec![b'x'; usize::try_from(MAX_MARKER_BYTES + 1).unwrap()],
    ] {
      fs::write(&path, bytes).unwrap();
      assert!(begin_run(&lock, 100, 41).unwrap().is_none());
      assert_eq!(read_marker(&path).unwrap().unwrap().pid, 41);
      monitor(path.clone(), new_marker(100, 41)).clean_exit();
    }
    drop(lock);
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn panic_text_is_digested_and_location_strips_both_path_styles() {
    for file in [
      "/Volumes/Example/alice/private/code.rs",
      r"C:\Example\alice\private\code.rs",
    ] {
      let summary = PanicSummary::new(
        "private document alice@example.invalid",
        Some(file),
        Some(42),
        Some("alice's document"),
      );
      assert_eq!(summary.location.as_deref(), Some("code.rs:42"));
      let wire = serde_json::to_string(&summary).unwrap();
      for secret in ["alice", "Example", "private", "document", "@"] {
        assert!(!wire.contains(secret), "leaked {secret}");
      }
      assert!(crate::desktop_telemetry::is_message_digest(
        &summary.message
      ));
      assert_eq!(
        serde_json::to_string(&summary.clone().sanitized()).unwrap(),
        wire
      );
    }
  }

  #[test]
  fn rejects_oversized_and_nonregular_markers() {
    let path = path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
      &path,
      vec![b'x'; usize::try_from(MAX_MARKER_BYTES + 1).unwrap()],
    )
    .unwrap();
    assert_eq!(
      read_marker(&path).unwrap_err().kind(),
      io::ErrorKind::InvalidData
    );
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(
      read_marker(&path).unwrap_err().kind(),
      io::ErrorKind::InvalidData
    );
    fs::remove_dir(&path).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  // The hook is process-global. Test it in a child so parallel Rust tests keep
  // their default hook and never share marker ownership.
  #[test]
  fn panic_hook_records_location_before_unwinding() {
    let path = path();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
      .args([
        "--exact",
        "desktop_crash::tests::panic_hook_child",
        "--nocapture",
      ])
      .env("STELLA_CRASH_TEST_MARKER", &path)
      .status()
      .unwrap();
    assert!(status.success());
    let panic = read_marker(&path).unwrap().unwrap().panic.unwrap();
    assert!(panic.location.unwrap().starts_with("desktop_crash.rs:"));
    assert!(crate::desktop_telemetry::is_message_digest(&panic.message));
    fs::remove_file(&path).unwrap();
    fs::remove_file(path.with_extension("lock")).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn panic_hook_child() {
    let Some(path) = std::env::var_os("STELLA_CRASH_TEST_MARKER").map(PathBuf::from)
    else {
      return;
    };
    let lock = lock_run(&path).unwrap().unwrap();
    begin_run(&lock, 100, std::process::id()).unwrap();
    let monitor = waiting_monitor(path, new_marker(200, std::process::id()));
    monitor.install_panic_hook();
    assert!(std::panic::catch_unwind(|| panic!("private document")).is_err());
    drop(lock);
    assert!(matches!(
      monitor.acquire_with_retry(&TEST_RETRY_POLICY).unwrap(),
      Acquisition::Complete(Some(_))
    ));
  }
}
