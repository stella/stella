// Relaunch after an in-place update.
//
// `AppHandle::restart` spawns the new binary as a child in the current
// process group and exits. When the app was started by its login launch
// agent, launchd owns that process group and signals every member as soon
// as the job exits, so the freshly spawned binary dies while still blocked
// in exec behind Gatekeeper's rescan of the replaced bundle.
//
// On macOS the relaunch therefore runs from a detached helper that outlives
// this process, waits for it to exit, and asks LaunchServices to open the
// bundle: a Gatekeeper-evaluated launch that belongs to no old job. Windows
// never reaches this module; the updater plugin hands off to the installer,
// which relaunches the app itself.

#[cfg(target_os = "macos")]
pub use macos::after_update;

#[cfg(not(target_os = "macos"))]
pub fn after_update(handle: &tauri::AppHandle) -> Result<(), String> {
  handle.restart()
}

#[cfg(target_os = "macos")]
mod macos {
  use std::ffi::{OsStr, OsString};
  use std::os::unix::process::CommandExt;
  use std::path::{Path, PathBuf};
  use std::process::{Command, Stdio};

  use tauri::{AppHandle, Manager};

  // Positional parameters: $1 = pid to wait for, $2 = bundle path, the
  // rest = arguments for the relaunched app. Waiting for the old process
  // keeps the single-instance socket free for the new one. Nothing
  // observes the helper after this process exits, so the helper posts
  // the fallback notification itself when the relaunch does not happen.
  const RELAUNCH_SCRIPT: &str = r#"
fallback() {
  /usr/bin/osascript -e 'display notification "Quit and reopen Stella to finish updating." with title "Stella update installed"' >/dev/null 2>&1
  exit 1
}
i=0
while kill -0 "$1" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 300 ]; then fallback; fi
  sleep 0.1
done
bundle="$2"
shift 2
if [ "$#" -gt 0 ]; then
  /usr/bin/open "$bundle" --args "$@" || fallback
else
  /usr/bin/open "$bundle" || fallback
fi
"#;

  pub fn after_update(handle: &AppHandle) -> Result<(), String> {
    let env = handle.env();
    let binary = tauri::process::current_binary(&env)
      .map_err(|err| format!("current binary path unavailable: {err}"))?;
    let bundle = bundle_root(&binary)
      .ok_or_else(|| format!("{} is not inside an app bundle", binary.display()))?;

    relaunch_command(
      std::process::id(),
      &bundle,
      env.args_os.iter().skip(1).cloned(),
    )
    .spawn()
    .map_err(|err| format!("relaunch helper could not be spawned: {err}"))?;

    handle.exit(0);
    Ok(())
  }

  fn relaunch_command(
    pid: u32,
    bundle: &Path,
    args: impl IntoIterator<Item = OsString>,
  ) -> Command {
    let mut command = Command::new("/bin/sh");
    command
      .arg("-c")
      .arg(RELAUNCH_SCRIPT)
      .arg("stella-relaunch")
      .arg(pid.to_string())
      .arg(bundle)
      .args(args)
      // Own process group: launchd's teardown of the exiting job must not
      // reach the helper.
      .process_group(0)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    command
  }

  fn bundle_root(binary: &Path) -> Option<PathBuf> {
    let macos_dir = binary
      .parent()
      .filter(|dir| dir.file_name() == Some(OsStr::new("MacOS")))?;
    let contents_dir = macos_dir
      .parent()
      .filter(|dir| dir.file_name() == Some(OsStr::new("Contents")))?;
    let bundle = contents_dir.parent()?;
    (bundle.extension() == Some(OsStr::new("app"))).then(|| bundle.to_path_buf())
  }

  #[cfg(test)]
  mod tests {
    use super::*;

    #[test]
    fn bundle_root_requires_the_bundle_layout() {
      assert_eq!(
        bundle_root(Path::new(
          "/Applications/stella desktop.app/Contents/MacOS/stella-desktop"
        )),
        Some(PathBuf::from("/Applications/stella desktop.app"))
      );
      assert_eq!(
        bundle_root(Path::new("/tmp/build/target/release/stella-desktop")),
        None
      );
      assert_eq!(
        bundle_root(Path::new(
          "/tmp/stella desktop/Contents/MacOS/stella-desktop"
        )),
        None
      );
    }

    #[test]
    fn relaunch_command_forwards_pid_bundle_and_launch_arguments() {
      let command = relaunch_command(
        4242,
        Path::new("/Applications/stella desktop.app"),
        [OsString::from("--stella-background-launch")],
      );

      assert_eq!(command.get_program(), OsStr::new("/bin/sh"));
      let args: Vec<&OsStr> = command.get_args().collect();
      assert_eq!(
        args,
        [
          OsStr::new("-c"),
          OsStr::new(RELAUNCH_SCRIPT),
          OsStr::new("stella-relaunch"),
          OsStr::new("4242"),
          OsStr::new("/Applications/stella desktop.app"),
          OsStr::new("--stella-background-launch"),
        ]
      );
    }
  }
}
