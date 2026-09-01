// Login-item registration. The autostart plugin writes the native
// registration; on macOS the launch agent it produces needs one more key
// than the plugin's template offers.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

pub fn enable(app: &AppHandle) -> Result<(), String> {
  app
    .autolaunch()
    .enable()
    .map_err(|err| format!("autostart enable failed: {err}"))?;

  #[cfg(target_os = "macos")]
  launch_agent::abandon_process_group(app)?;

  Ok(())
}

#[cfg(target_os = "macos")]
mod launch_agent {
  use std::path::PathBuf;

  use tauri::AppHandle;

  const ABANDON_PROCESS_GROUP_KEY: &str = "AbandonProcessGroup";

  // launchd kills every process still in a job's process group when the
  // job exits. The post-update relaunch helper already runs in its own
  // group; this keeps any other child of a login-launched app from being
  // reaped alongside it.
  pub fn abandon_process_group(app: &AppHandle) -> Result<(), String> {
    let path = plist_path(app)?;
    let mut agent = plist::Value::from_file(&path)
      .map_err(|err| format!("launch agent {} unreadable: {err}", path.display()))?
      .into_dictionary()
      .ok_or_else(|| format!("launch agent {} is not a dictionary", path.display()))?;

    agent.insert(
      ABANDON_PROCESS_GROUP_KEY.to_string(),
      plist::Value::Boolean(true),
    );

    plist::to_file_xml(&path, &agent)
      .map_err(|err| format!("launch agent {} not writable: {err}", path.display()))
  }

  // Mirrors the autostart plugin's launch agent location:
  // `~/Library/LaunchAgents/<package name>.plist`.
  fn plist_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("home directory unavailable")?;
    Ok(
      home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", app.package_info().name)),
    )
  }
}
