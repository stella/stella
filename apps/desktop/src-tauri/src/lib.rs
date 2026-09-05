mod app_lifecycle;
mod autostart;
mod bridge;
mod clipboard;
mod clipboard_commands;
mod clipboard_screen_capture;
mod clipboard_store;
mod clipboard_welcome;
mod clipboard_window;
mod commands;
mod config;
mod deep_link;
mod desktop_telemetry;
mod diagnostics;
#[cfg(test)]
mod e2e;
mod i18n;
mod keychain;
mod logging;
mod marker_file;
mod relaunch;
mod session_manager;
mod session_store;
mod sse;
mod tray;
mod types;
mod updater;
mod window_placement;

include!("command_manifest.rs");

macro_rules! generate_stella_handler {
  ($($path:path => $name:literal),* $(,)?) => {
    tauri::generate_handler![$($path),*]
  };
}

use clipboard::{ClipboardAppState, ClipboardManager};
use clipboard_commands::ClipboardEditorState;
use commands::AppState;
use session_manager::SessionManager;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

pub fn run() {
  logging::init();

  i18n::init();

  let bridge_port = config::resolve_bridge_port();
  let allowed_origins = config::resolve_allowed_origins();

  let manager = Arc::new(Mutex::new(SessionManager::new()));
  let clipboard_manager = Arc::new(std::sync::Mutex::new(ClipboardManager::new()));
  let launch_args = std::env::args().collect::<Vec<_>>();
  #[cfg(target_os = "macos")]
  let manager_for_single_instance = Arc::clone(&manager);

  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(
      move |app, args, _cwd| {
        let reveal_clipboard = app_lifecycle::should_reveal_clipboard_on_launch(
          args.iter().map(String::as_str),
          false,
        );
        #[cfg(target_os = "macos")]
        {
          for arg in &args {
            if arg.starts_with("stella://") {
              deep_link::handle_url(
                arg,
                Arc::clone(&manager_for_single_instance),
                app.clone(),
              );
            }
          }
        }
        #[cfg(not(target_os = "macos"))]
        {
          let _ = (app, args);
        }
        if reveal_clipboard {
          clipboard_window::show(app);
        }
      },
    ))
    .plugin(tauri_plugin_autostart::init(
      MacosLauncher::LaunchAgent,
      Some(vec![app_lifecycle::BACKGROUND_LAUNCH_ARGUMENT]),
    ))
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage::<AppState>(Arc::clone(&manager))
    .manage::<ClipboardAppState>(Arc::clone(&clipboard_manager))
    .manage::<ClipboardEditorState>(Arc::new(std::sync::Mutex::new(None)))
    .manage(clipboard_window::ClipboardStartupTrace::default())
    .manage(clipboard_window::ClipboardWindowPark::default())
    .setup(move |app| {
      let handle = app.handle().clone();
      let initial_deep_links = app.deep_link().get_current()?;
      let reveal_clipboard_on_launch =
        app_lifecycle::should_reveal_clipboard_on_launch(
          launch_args.iter().map(String::as_str),
          initial_deep_links
            .as_ref()
            .is_some_and(|urls| !urls.is_empty()),
        );
      let desktop_telemetry = desktop_telemetry::DesktopTelemetry::start();
      app.manage(desktop_telemetry.clone());

      // Clipboard history initializes on a dedicated thread because the OS
      // keychain can block on authorization and the watcher runs continuously.
      {
        let clipboard_manager = Arc::clone(&clipboard_manager);
        let clipboard_handle = handle.clone();
        let watcher_telemetry = desktop_telemetry.clone();
        let spawn_telemetry = desktop_telemetry.clone();
        if let Err(error) = std::thread::Builder::new()
          .name("stella-clipboard-watcher".to_string())
          .spawn(move || {
            clipboard::initialize_and_watch(
              clipboard_manager,
              clipboard_handle,
              watcher_telemetry,
            );
          })
        {
          tracing::error!(error = %error, "clipboard watcher thread could not start");
          spawn_telemetry.capture(desktop_telemetry::DesktopErrorReport {
            window: desktop_telemetry::DesktopTelemetryWindow::Clipboard,
            operation:
              desktop_telemetry::DesktopTelemetryOperation::ClipboardWatcherStart,
            code: desktop_telemetry::DesktopTelemetryErrorCode::WatcherUnavailable,
          });
        }
      }

      // Registration is intentionally non-fatal: the shortcut may already be
      // taken, and the timeline stays reachable from the tray.
      {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        if let Err(error) = app.global_shortcut().on_shortcut(
          "CommandOrControl+Shift+V",
          |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
              clipboard_window::toggle(app);
            }
          },
        ) {
          tracing::warn!(error = %error, "clipboard shortcut is unavailable");
          desktop_telemetry.capture(desktop_telemetry::DesktopErrorReport {
            window: desktop_telemetry::DesktopTelemetryWindow::Clipboard,
            operation:
              desktop_telemetry::DesktopTelemetryOperation::ClipboardShortcutRegister,
            code: desktop_telemetry::DesktopTelemetryErrorCode::ShortcutUnavailable,
          });
        }
      }

      if reveal_clipboard_on_launch {
        clipboard_window::show_on_launch(&handle);
      }

      // Restore sessions and build the initial tray menu off the main thread.
      // Session restore reads the OS keychain, which can block on user
      // authorization; the event loop is not running yet, so blocking setup
      // makes macOS report the app as not responding. The guard is acquired
      // synchronously here so every other manager consumer (bridge, deep
      // links, tray actions) queues behind the restore instead of racing it.
      {
        let manager = Arc::clone(&manager);
        // A second-instance notification can race this lock on Windows and
        // Linux, so fall back to awaiting instead of panicking.
        let setup_guard = Arc::clone(&manager).try_lock_owned();
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
          let mut mgr = match setup_guard {
            Ok(guard) => guard,
            Err(_) => {
              tracing::warn!("session manager contended during setup");
              Arc::clone(&manager).lock_owned().await
            }
          };
          mgr.set_app_handle(handle.clone());
          mgr.initialize().await;
          let session_ids = mgr.session_ids_needing_watchers();
          drop(mgr);

          // Attach file watchers and SSE listeners outside the lock
          for sid in &session_ids {
            SessionManager::attach_watcher(&manager, sid).await;
          }

          let mut mgr = manager.lock().await;
          for sid in &session_ids {
            mgr.ensure_sse_listener(&manager, sid);
          }

          let snapshot = mgr.get_snapshot();
          if let Ok(menu) = tray::build_tray_menu(&handle, &snapshot)
            && let Some(tray) = handle.tray_by_id("main")
          {
            let _ = tray.set_menu(Some(menu));
          }
        });
      }

      // Handle tray menu events
      {
        let manager_for_tray = Arc::clone(&manager);
        let handle_for_tray = handle.clone();
        app.on_menu_event(move |_app_handle, event| {
          let action = event.id().as_ref().to_string();
          let menu_action = tray::handle_menu_action(&action);
          let manager = Arc::clone(&manager_for_tray);
          let handle = handle_for_tray.clone();

          tauri::async_runtime::spawn(async move {
            match menu_action {
              tray::MenuAction::Quit => {
                let mgr = manager.lock().await;
                mgr.persist_sessions_public().await;
                drop(mgr);
                handle.exit(0);
              }
              tray::MenuAction::OpenPreferences(tab) => {
                ensure_main_window(&handle, tab);
              }
              tray::MenuAction::OpenClipboard => {
                clipboard_window::show(&handle);
              }
              tray::MenuAction::CheckForUpdates => {
                let active_edit_sessions = {
                  let mgr = manager.lock().await;
                  mgr.has_active_edit_sessions()
                };

                match updater::run_check(&handle, active_edit_sessions).await {
                  updater::CheckOutcome::Deferred { version } => {
                    tracing::info!(
                        version = %version,
                        "tray-triggered updater check deferred while desktop edits are active"
                    );
                  }
                  updater::CheckOutcome::UpToDate => {
                    if let Err(err) = handle
                      .notification()
                      .builder()
                      .title("Stella is up to date")
                      .show()
                    {
                      tracing::warn!(error = %err, "up-to-date notification failed");
                    }
                  }
                  updater::CheckOutcome::Installed { version } => {
                    tracing::info!(version = %version, "tray-triggered update installed, relaunching");
                  }
                  updater::CheckOutcome::Failed(msg) => {
                    tracing::warn!(error = %msg, "tray-triggered updater check failed");
                  }
                }
              }
              tray::MenuAction::OpenEditRoot => {
                let mgr = manager.lock().await;
                mgr.open_edit_root().await;
              }
              tray::MenuAction::CopyDiagnostics => {
                let mgr = manager.lock().await;
                mgr.copy_diagnostics();
              }
              tray::MenuAction::EmailSupport => {
                SessionManager::email_support();
              }
              tray::MenuAction::RevealSupportRoot => {
                let mgr = manager.lock().await;
                mgr.reveal_support_root();
              }
              tray::MenuAction::OpenSessionFile(id) => {
                let mgr = manager.lock().await;
                mgr.open_session_file(&id);
              }
              tray::MenuAction::RevealSession(id) => {
                let mgr = manager.lock().await;
                mgr.reveal_session(&id);
              }
              tray::MenuAction::FinishSession(id) => {
                let mut mgr = manager.lock().await;
                if mgr.finish_session(&id) {
                  mgr.persist_sessions_public().await;
                  mgr.retry_session(&id).await;
                }
              }
              tray::MenuAction::RetrySession(id) => {
                let mut mgr = manager.lock().await;
                if mgr.retry_session_now(&id) {
                  mgr.persist_sessions_public().await;
                  mgr.retry_session(&id).await;
                }
              }
            }
          });
        });
      }

      // Spawn HTTP bridge server
      {
        let manager_for_bridge = Arc::clone(&manager);
        tauri::async_runtime::spawn(async move {
          bridge::start_bridge(bridge_port, allowed_origins, manager_for_bridge).await;
        });
      }

      // Spawn retry loop
      {
        let manager_for_retry = Arc::clone(&manager);
        tauri::async_runtime::spawn(async move {
          session_manager::run_retry_loop(manager_for_retry).await;
        });
      }

      // Keep an enabled native registration synchronized with the plugin's
      // configured background-launch argument. Enabling overwrites the
      // existing registration without changing one the user disabled.
      {
        match handle.autolaunch().is_enabled() {
          Ok(true) => {
            if let Err(error) = autostart::enable(&handle) {
              tracing::warn!(error = %error, "auto-start registration could not be refreshed");
            }
          }
          Ok(false) => {}
          Err(error) => {
            tracing::warn!(error = %error, "auto-start registration could not be checked");
          }
        }
      }

      // Check for updates in the background after launch settles.
      updater::schedule_startup_check(handle.clone(), Arc::clone(&manager));

      // Hide dock icon on macOS (tray-only app)
      #[cfg(target_os = "macos")]
      {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
      }

      // Register deep link handler
      {
        let manager_for_deep_link = Arc::clone(&manager);
        let handle_for_deep_link = handle.clone();
        let handle_deep_link_urls = move |urls: Vec<reqwest::Url>| {
          for url in urls {
            tracing::info!(
                scheme = %url.scheme(),
                "deep link received"
            );
            deep_link::handle_url(
              url.as_str(),
              Arc::clone(&manager_for_deep_link),
              handle_for_deep_link.clone(),
            );
          }
        };

        if let Some(urls) = initial_deep_links {
          handle_deep_link_urls(urls);
        }

        let manager_for_deep_link = Arc::clone(&manager);
        let handle_for_deep_link = handle.clone();
        let _ = app.deep_link().on_open_url(move |event| {
          for url in event.urls() {
            tracing::info!(
                scheme = %url.scheme(),
                "deep link received"
            );
            deep_link::handle_url(
              url.as_str(),
              Arc::clone(&manager_for_deep_link),
              handle_for_deep_link.clone(),
            );
          }
        });
      }

      tracing::info!("stella desktop started");
      Ok(())
    })
    .invoke_handler(with_stella_commands!(generate_stella_handler))
    .build(tauri::generate_context!())
    .expect("error while building stella desktop")
    .run(|_app, event| match event {
      tauri::RunEvent::ExitRequested { api, code, .. } => {
        if app_lifecycle::should_prevent_exit(code) {
          tracing::info!("prevented background desktop process from exiting");
          api.prevent_exit();
        } else {
          tracing::info!(?code, "desktop process received an explicit exit request");
        }
      }
      tauri::RunEvent::Exit => tracing::info!("desktop event loop exited"),
      _ => {}
    });
}

fn ensure_main_window(handle: &tauri::AppHandle, tab: &str) {
  // Accessory apps must explicitly activate to bring windows to front.
  #[cfg(target_os = "macos")]
  let _ = handle.show();

  if let Some(window) = handle.get_webview_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
    let _ = handle.emit_to("main", "activate-tab", serde_json::json!({ "tab": tab }));
    return;
  }

  let builder = tauri::WebviewWindowBuilder::new(
    handle,
    "main",
    tauri::WebviewUrl::App("index.html".into()),
  )
  .title("stella desktop")
  .inner_size(480.0, 460.0)
  .resizable(false);
  let builder = window_placement::centered_on_target_screen(
    handle,
    builder,
    tauri::LogicalSize::new(480.0, 460.0),
  );

  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);

  match builder.build() {
    Ok(_window) => {
      // Emit tab activation after a short delay to let the webview load
      let handle = handle.clone();
      let tab = tab.to_string();
      tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let _ =
          handle.emit_to("main", "activate-tab", serde_json::json!({ "tab": tab }));
      });
    }
    Err(e) => {
      tracing::error!(error = %e, "failed to create settings window");
    }
  }
}
