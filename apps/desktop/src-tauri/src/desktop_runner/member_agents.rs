//! Coding agents the member installed on this computer themselves, which the
//! desktop runs but does not install: Antigravity's `agy` CLI. The desktop
//! finds the executable, reads its version with `--version` (and nothing
//! else), and hands both to the sidecar, which speaks to the agent over the
//! Agent Client Protocol. The agent keeps its own sign-in; the member signs
//! in from the agent itself.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

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
