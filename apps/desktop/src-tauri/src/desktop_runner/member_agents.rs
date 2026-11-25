//! Coding agents the member installed on this computer themselves, which the
//! desktop runs but does not install: Antigravity's `agy` CLI. The desktop
//! finds the executable, reads its version with `--version` (and nothing
//! else), and hands both to the sidecar, which speaks to the agent over the
//! Agent Client Protocol. The agent keeps its own sign-in; the member signs
//! in from the agent itself.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use crate::runner_protocol::HarnessReport;

/// How long `--version` may take before the executable counts as unusable.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_POLL: Duration = Duration::from_millis(20);

/// The names the Antigravity CLI is installed under.
#[cfg(not(windows))]
const ANTIGRAVITY_NAMES: &[&str] = &["agy", "antigravity"];
#[cfg(windows)]
const ANTIGRAVITY_NAMES: &[&str] = &["agy.exe", "antigravity.exe"];

/// Where the installer puts the CLI when the app's `PATH` does not name it:
/// an app started from the Dock or Finder does not get the shell's `PATH`.
fn usual_dirs(home: Option<&Path>) -> Vec<PathBuf> {
  let mut dirs = Vec::new();
  if let Some(home) = home {
    dirs.push(home.join(".local").join("bin"));
  }
  #[cfg(not(windows))]
  {
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
  }
  dirs
}

#[cfg(unix)]
fn has_execute_bit(metadata: &std::fs::Metadata) -> bool {
  use std::os::unix::fs::PermissionsExt;
  metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
const fn has_execute_bit(_metadata: &std::fs::Metadata) -> bool {
  true
}

fn is_executable_file(path: &Path) -> bool {
  std::fs::metadata(path).is_ok_and(|metadata| {
    metadata.is_file() && metadata.len() > 0 && has_execute_bit(&metadata)
  })
}

/// The first Antigravity CLI on `path_var`'s directories, then the usual
/// install directories. The path is kept as found, not resolved: a version
/// manager's shim picks the release by the name it was started under.
pub(crate) fn find_antigravity(
  path_var: Option<&std::ffi::OsStr>,
  home: Option<&Path>,
) -> Option<PathBuf> {
  let mut dirs: Vec<PathBuf> = path_var
    .map(|value| std::env::split_paths(value).collect())
    .unwrap_or_default();
  dirs.extend(usual_dirs(home));
  dirs
    .iter()
    .filter(|dir| dir.is_absolute())
    .flat_map(|dir| ANTIGRAVITY_NAMES.iter().map(move |name| dir.join(name)))
    .find(|candidate| is_executable_file(candidate))
}

/// The `major.minor.patch` version `--version` printed, as its first word
/// that is one (`1.5.0`, `agy 1.5.0`, `v1.5.0`).
pub(crate) fn parse_version(output: &str) -> Option<String> {
  output
    .split_whitespace()
    .map(|word| word.trim_start_matches('v'))
    .find(|word| {
      let parts: Vec<&str> = word.split('.').collect();
      parts.len() == 3
        && parts.iter().all(|part| {
          !part.is_empty()
            && part.len() <= 9
            && part.bytes().all(|b| b.is_ascii_digit())
        })
    })
    .map(str::to_owned)
}

/// Runs `<executable> --version` with no input, bounded by
/// `VERSION_TIMEOUT`; the child is killed when it takes longer.
fn read_version(executable: &Path) -> Option<String> {
  let mut command = Command::new(executable);
  command
    .arg("--version")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
  }
  let mut child = command.spawn().ok()?;
  let deadline = Instant::now() + VERSION_TIMEOUT;
  // Read on a thread of its own, so a child that leaves something holding
  // its output open cannot hold this past the deadline.
  let stdout = child.stdout.take()?;
  let (sender, output) = std::sync::mpsc::channel();
  std::thread::spawn(move || {
    let mut stdout = stdout;
    let mut text = String::new();
    let read = std::io::Read::read_to_string(&mut stdout, &mut text).map(|_| text);
    // The receiver has given up when the deadline passed.
    crate::logging::best_effort(
      sender.send(read),
      "agent version came after its deadline",
    );
  });
  let succeeded = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status.success(),
      Ok(None) if Instant::now() < deadline => std::thread::sleep(VERSION_POLL),
      _ => {
        crate::logging::best_effort(child.kill(), "agent version probe was not killed");
        crate::logging::best_effort(child.wait(), "agent version probe was not reaped");
        return None;
      }
    }
  };
  let remaining = deadline.saturating_duration_since(Instant::now());
  let text = output.recv_timeout(remaining).ok()?.ok()?;
  if !succeeded {
    return None;
  }
  parse_version(&text)
}

/// What identifies an executable on disk between two looks at it.
#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
  path: PathBuf,
  len: u64,
  modified: Option<SystemTime>,
}

fn stamp(path: &Path) -> Option<FileStamp> {
  let metadata = std::fs::metadata(path).ok()?;
  Some(FileStamp {
    path: path.to_path_buf(),
    len: metadata.len(),
    modified: metadata.modified().ok(),
  })
}

/// The last version read, kept while the executable is unchanged, so the
/// regular probe and every run start do not run `--version` again.
static VERSIONS: Mutex<Option<(FileStamp, String)>> = Mutex::new(None);

/// Status of the member-installed Antigravity CLI for desktop Settings. Its
/// sign-in is the run probe's answer, so Settings and every run agree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AntigravityCliStatus {
  NotInstalled,
  TooOld {
    version: String,
  },
  SignedOut {
    version: String,
  },
  SignedIn {
    version: String,
  },
  /// Installed, but its sign-in could not be asked about.
  Unchecked {
    version: String,
    reason: AntigravityUncheckedReason,
  },
}

/// Why the CLI's sign-in could not be asked about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AntigravityUncheckedReason {
  /// This computer is not connected to stella yet, so no probe runs.
  NotConnected,
  /// The probe started the CLI and got no usable answer.
  CheckFailed,
}

const ANTIGRAVITY_MIN_VERSION: (u64, u64, u64) = (1, 5, 0);

pub(crate) fn version_at_least(version: &str, min: (u64, u64, u64)) -> bool {
  let mut parts = version
    .split('.')
    .filter_map(|part| part.parse::<u64>().ok());
  let Some(major) = parts.next() else {
    return false;
  };
  let Some(minor) = parts.next() else {
    return false;
  };
  let Some(patch) = parts.next() else {
    return false;
  };
  parts.next().is_none() && (major, minor, patch) >= min
}

/// The version of an installed CLI that serves ACP, or the status that says
/// why there is none. `refresh` reads the version again.
pub(crate) fn antigravity_installed(
  refresh: bool,
) -> Result<String, AntigravityCliStatus> {
  if refresh {
    *VERSIONS
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
  }
  let Some((_executable, version)) = antigravity() else {
    return Err(AntigravityCliStatus::NotInstalled);
  };
  if !version_at_least(&version, ANTIGRAVITY_MIN_VERSION) {
    return Err(AntigravityCliStatus::TooOld { version });
  }
  Ok(version)
}

/// The status of an installed CLI of `version`, from the run probe's
/// `report`. The CLI keeps its sign-in where it likes (the system keychain,
/// from 1.5), so only the CLI can say whether it has one; the probe asks it.
/// `None`: no probe can run yet (this computer is not connected to stella).
pub(crate) fn antigravity_sign_in(
  version: String,
  report: Option<&HarnessReport>,
) -> AntigravityCliStatus {
  match report {
    None => AntigravityCliStatus::Unchecked {
      version,
      reason: AntigravityUncheckedReason::NotConnected,
    },
    // A quota reached is still a signed-in CLI.
    Some(HarnessReport::Ready(_) | HarnessReport::LimitUntil(_)) => {
      AntigravityCliStatus::SignedIn { version }
    }
    Some(HarnessReport::NeedsLogin(_)) => AntigravityCliStatus::SignedOut { version },
    Some(HarnessReport::Unsupported(_)) => AntigravityCliStatus::TooOld { version },
    // Removed between the two looks.
    Some(HarnessReport::NotInstalled(_)) => AntigravityCliStatus::NotInstalled,
    Some(HarnessReport::Unavailable(_)) => AntigravityCliStatus::Unchecked {
      version,
      reason: AntigravityUncheckedReason::CheckFailed,
    },
  }
}

/// The Antigravity CLI on this computer and its version; `None` when it is
/// not installed or does not say its version.
pub(crate) fn antigravity() -> Option<(PathBuf, String)> {
  let home = dirs::home_dir().filter(|home| home.is_absolute());
  let executable =
    find_antigravity(std::env::var_os("PATH").as_deref(), home.as_deref())?;
  let current = stamp(&executable)?;
  let cached = {
    let cache = VERSIONS
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache
      .as_ref()
      .filter(|(seen, _)| *seen == current)
      .map(|(_, version)| version.clone())
  };
  // Read without holding the lock: `--version` may take seconds. Only a
  // version is kept: a failed read is tried again on the next look.
  let version = match cached {
    Some(version) => version,
    None => {
      let version = read_version(&executable)?;
      *VERSIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((current, version.clone()));
      version
    }
  };
  Some((executable, version))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn checks_antigravity_minimum_version() {
    assert!(!version_at_least("1.4.9", ANTIGRAVITY_MIN_VERSION));
    assert!(version_at_least("1.5.0", ANTIGRAVITY_MIN_VERSION));
    assert!(version_at_least("1.6.12", ANTIGRAVITY_MIN_VERSION));
    assert!(version_at_least("2.0.0", ANTIGRAVITY_MIN_VERSION));
  }

  /// The run probe's reports of the CLI, as the sidecar sends them.
  fn report(json: serde_json::Value) -> HarnessReport {
    serde_json::from_value(json).unwrap()
  }

  #[test]
  fn the_sign_in_is_the_run_probes_answer() {
    use AntigravityCliStatus as Status;
    let version = || "1.5.17".to_owned();
    let ready = report(serde_json::json!({
      "state": "ready", "id": "antigravity", "version": "1.5.17",
      "capabilities": [], "approvalModes": ["ask"], "models": [],
    }));
    let limited = report(serde_json::json!({
      "state": "limit_until", "id": "antigravity", "version": "1.5.17",
      "resetsAt": "2026-11-26T00:00:00Z",
    }));
    let signed_out = report(serde_json::json!({
      "state": "needs_login", "id": "antigravity", "version": "1.5.17",
    }));
    let unsupported = report(serde_json::json!({
      "state": "unsupported", "id": "antigravity", "version": "1.5.17",
    }));
    let missing = report(serde_json::json!({
      "state": "not_installed", "id": "antigravity",
    }));
    let unavailable = report(serde_json::json!({
      "state": "unavailable", "id": "antigravity", "reason": "probe_failed",
    }));
    let cases = [
      (Some(&ready), Status::SignedIn { version: version() }),
      (Some(&limited), Status::SignedIn { version: version() }),
      (Some(&signed_out), Status::SignedOut { version: version() }),
      (Some(&unsupported), Status::TooOld { version: version() }),
      (Some(&missing), Status::NotInstalled),
      (
        Some(&unavailable),
        Status::Unchecked {
          version: version(),
          reason: AntigravityUncheckedReason::CheckFailed,
        },
      ),
      (
        None,
        Status::Unchecked {
          version: version(),
          reason: AntigravityUncheckedReason::NotConnected,
        },
      ),
    ];
    for (probed, expected) in cases {
      assert_eq!(antigravity_sign_in(version(), probed), expected);
    }
  }

  #[test]
  fn settings_reads_the_status_in_its_wire_shape() {
    assert_eq!(
      serde_json::to_value(AntigravityCliStatus::Unchecked {
        version: "1.5.17".to_owned(),
        reason: AntigravityUncheckedReason::NotConnected,
      })
      .unwrap(),
      serde_json::json!({
        "state": "unchecked", "version": "1.5.17", "reason": "not_connected",
      })
    );
    assert_eq!(
      serde_json::to_value(AntigravityCliStatus::SignedOut {
        version: "1.5.17".to_owned(),
      })
      .unwrap(),
      serde_json::json!({ "state": "signed_out", "version": "1.5.17" })
    );
  }

  #[test]
  fn reads_the_version_word() {
    assert_eq!(parse_version("1.5.0\n").as_deref(), Some("1.5.0"));
    assert_eq!(
      parse_version("agy 1.6.12 (darwin)").as_deref(),
      Some("1.6.12")
    );
    assert_eq!(parse_version("v1.5.0").as_deref(), Some("1.5.0"));
    assert_eq!(parse_version("1.5"), None);
    assert_eq!(parse_version("1.5.0-beta"), None);
    assert_eq!(parse_version(""), None);
  }

  #[cfg(unix)]
  use crate::harness_archive::tests::TempDir;

  /// A file at `path` holding `text`, executable or not.
  #[cfg(unix)]
  fn file(path: &Path, text: &str, executable: bool) {
    use std::io::Write;
    let mut file = crate::local_store::create_harness_file(path, executable).unwrap();
    file.write_all(text.as_bytes()).unwrap();
  }

  #[cfg(unix)]
  #[test]
  fn finds_the_cli_on_the_path_before_the_usual_places() {
    let root = TempDir::new();
    let on_path = root.path().join("path-bin");
    let home = root.path().join("home");
    let local = home.join(".local").join("bin");
    crate::local_store::create_private_dir(&on_path).unwrap();
    crate::local_store::create_private_dir(&local).unwrap();
    for dir in [&on_path, &local] {
      file(&dir.join("agy"), "#!/bin/sh\necho 1.5.0\n", true);
    }
    let path_var = std::env::join_paths([&on_path]).unwrap();
    assert_eq!(
      find_antigravity(Some(&path_var), Some(&home)),
      Some(on_path.join("agy"))
    );
    // Without it on the PATH, the usual install directory is looked at.
    assert_eq!(find_antigravity(None, Some(&home)), Some(local.join("agy")));
    assert_eq!(read_version(&local.join("agy")).as_deref(), Some("1.5.0"));
  }

  #[cfg(unix)]
  #[test]
  fn a_file_that_is_not_executable_is_not_the_cli() {
    let root = TempDir::new();
    let agy = root.path().join("agy");
    file(&agy, "not a program", false);
    // Discovery also looks in the computer's own install directories, so
    // the file is judged on its own.
    assert!(!is_executable_file(&agy));
  }
}
