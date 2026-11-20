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
  let started = Instant::now();
  loop {
    match child.try_wait() {
      Ok(Some(status)) => {
        if !status.success() {
          return None;
        }
        let mut output = String::new();
        let mut stdout = child.stdout.take()?;
        std::io::Read::read_to_string(&mut stdout, &mut output).ok()?;
        return parse_version(&output);
      }
      Ok(None) if started.elapsed() < VERSION_TIMEOUT => {
        std::thread::sleep(VERSION_POLL)
      }
      _ => {
        crate::logging::best_effort(child.kill(), "agent version probe was not killed");
        crate::logging::best_effort(child.wait(), "agent version probe was not reaped");
        return None;
      }
    }
  }
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
static VERSIONS: Mutex<Option<(FileStamp, Option<String>)>> = Mutex::new(None);

/// The Antigravity CLI on this computer and its version; `None` when it is
/// not installed or does not say its version.
pub(crate) fn antigravity() -> Option<(PathBuf, String)> {
  let home = dirs_home();
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
  // Read without holding the lock: `--version` may take seconds.
  let version = cached.unwrap_or_else(|| {
    let version = read_version(&executable);
    *VERSIONS
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner) =
      Some((current, version.clone()));
    version
  });
  version.map(|version| (executable, version))
}

fn dirs_home() -> Option<PathBuf> {
  #[cfg(windows)]
  let home = std::env::var_os("USERPROFILE");
  #[cfg(not(windows))]
  let home = std::env::var_os("HOME");
  home.map(PathBuf::from).filter(|home| home.is_absolute())
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

  #[cfg(unix)]
  #[test]
  fn finds_the_cli_on_the_path_before_the_usual_places() {
    use std::os::unix::fs::PermissionsExt;
    let root = TempDir::new();
    let on_path = root.path().join("path-bin");
    let home = root.path().join("home");
    let local = home.join(".local").join("bin");
    std::fs::create_dir_all(&on_path).unwrap();
    std::fs::create_dir_all(&local).unwrap();
    for dir in [&on_path, &local] {
      let agy = dir.join("agy");
      std::fs::write(&agy, "#!/bin/sh\necho 1.5.0\n").unwrap();
      std::fs::set_permissions(&agy, std::fs::Permissions::from_mode(0o755)).unwrap();
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
    std::fs::write(root.path().join("agy"), "not a program").unwrap();
    let path_var = std::env::join_paths([root.path()]).unwrap();
    assert_eq!(find_antigravity(Some(&path_var), None), None);
  }
}
