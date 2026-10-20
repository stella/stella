//! End-to-end test access: a W3C WebDriver server inside the app, compiled
//! only with the debug-only `webdriver` feature.

use tauri::{AppHandle, Manager, ipc::CapabilityBuilder};

/// Set to `settings` to open Settings at launch. Its entry point is the tray,
/// which a WebDriver client cannot reach.
const OPEN_ENV: &str = "STELLA_WEBDRIVER_OPEN";

/// Runs before any window is created, so the plugin's page scripts reach every
/// window. The capability is added at runtime to keep it out of the capability
/// files that release builds compile in.
pub fn start(app: &AppHandle) -> tauri::Result<()> {
  app.plugin(tauri_plugin_wdio_webdriver::init())?;
  app.add_capability(
    CapabilityBuilder::new("webdriver")
      .windows(["*"])
      .permission("wdio-webdriver:default"),
  )?;
  if std::env::var(OPEN_ENV).as_deref() == Ok("settings") {
    crate::ensure_main_window(app, "general");
  }
  Ok(())
}
