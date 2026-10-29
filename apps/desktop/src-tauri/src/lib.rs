mod accessibility_guide;
mod account;
mod activity;
mod activity_calls;
mod activity_commands;
mod activity_details;
mod activity_store;
mod activity_window;
mod app_lifecycle;
mod app_window;
mod autostart;
mod bridge;
mod chatgpt_auth;
mod chatgpt_auth_commands;
mod clipboard;
mod clipboard_commands;
#[cfg(target_os = "macos")]
mod clipboard_image_export;
mod clipboard_screen_capture;
mod clipboard_shortcut;
mod clipboard_store;
mod clipboard_welcome;
mod clipboard_window;
mod codex_managed_token_broker;
mod commands;
mod config;
mod deep_link;
mod desktop_crash;
mod desktop_crash_native;
mod desktop_telemetry;
mod device_preference;
mod device_proof;
mod diagnostics;
#[cfg(test)]
mod e2e;
mod feature_access;
mod feature_gate;
mod foreground_app;
mod foreground_app_visual;
mod handoff;
mod harness_archive;
mod harness_commands;
mod harness_installation;
mod harness_release;
mod http_client;
mod i18n;
mod idle_time;
mod keychain;
mod local_store;
mod local_window;
mod logging;
mod managed_policy;
mod marker_file;
mod onboarding;
mod pdf_signing;
mod permissions;
mod presence;
mod registry;
mod relaunch;
mod session_manager;
mod session_store;
mod sse;
#[cfg(test)]
mod test_child_processes;
mod time_entry_commands;
mod time_entry_submit;
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

use crate::logging::best_effort;
use clipboard::{ClipboardAppState, ClipboardManager};
use commands::AppState;
use session_manager::SessionManager;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

/// Runs the managed Codex token helper when the process was started as one,
/// and returns its exit code; `None` for an ordinary launch.
pub fn run_codex_token_helper() -> Option<i32> {
  let args = std::env::args_os().collect::<Vec<_>>();
  codex_managed_token_broker::run_token_helper(&args)
}

pub fn run() {
  logging::init();

  let desktop_telemetry = desktop_telemetry::DesktopTelemetry::start();
  let crash_monitor = desktop_crash::DesktopCrashMonitor::start(&desktop_telemetry);

  i18n::init();

  let bridge_port = config::resolve_bridge_port();
  let allowed_origins = config::resolve_allowed_origins();

  let manager = Arc::new(Mutex::new(SessionManager::new()));
  let account = Arc::new(Mutex::new(account::AccountStore::default()));
  let clipboard_manager = Arc::new(std::sync::Mutex::new(ClipboardManager::new()));
  let activity_manager: activity::ActivityAppState =
    Arc::new(std::sync::Mutex::new(activity::ActivityManager::new()));
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
    .manage::<account::AccountState>(Arc::clone(&account))
    .manage::<ClipboardAppState>(Arc::clone(&clipboard_manager))
    .manage(clipboard_window::ClipboardEditorSessions::default())
    .manage(clipboard_window::ClipboardStartupTrace::default())
    .manage::<clipboard_shortcut::ClipboardShortcutState>(std::sync::Mutex::new(
      clipboard_shortcut::ClipboardShortcut::load(),
    ))
    .manage::<onboarding::OnboardingState>(std::sync::Mutex::new(
      onboarding::Onboarding::load(),
    ))
    .manage(feature_gate::FeatureGates::blocking(
      managed_policy::current().blocked_features(),
    ))
    .manage::<activity::ActivityAppState>(Arc::clone(&activity_manager))
    .manage(crash_monitor)
    .manage(desktop_telemetry.clone())
    .setup(move |app| {
      let handle = app.handle().clone();
      #[cfg(target_os = "macos")]
      if let Ok(mut clipboard) = clipboard_manager.lock()
        && let Err(error) = clipboard.reconcile_image_exports()
      {
        tracing::warn!(error = %error, "clipboard image export cleanup will be retried");
      }
      let initial_deep_links = app.deep_link().get_current()?;
      let reveal_clipboard_on_launch =
        app_lifecycle::should_reveal_clipboard_on_launch(
          launch_args.iter().map(String::as_str),
          initial_deep_links
            .as_ref()
            .is_some_and(|urls| !urls.is_empty()),
        );
      // Clipboard history initializes on a dedicated thread because the OS
      // keychain can block on authorization and the watcher runs continuously.
      // Managed policy can turn it off: then nothing is read or recorded.
      if !managed_policy::current().clipboard_disabled {
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
      // taken, and the clipboard stays reachable from the tray.
      if clipboard_shortcut::register_at_launch(&handle)
        == clipboard_shortcut::ShortcutRegistration::Unavailable
      {
        desktop_telemetry.capture(desktop_telemetry::DesktopErrorReport {
          window: desktop_telemetry::DesktopTelemetryWindow::Clipboard,
          operation:
            desktop_telemetry::DesktopTelemetryOperation::ClipboardShortcutRegister,
          code: desktop_telemetry::DesktopTelemetryErrorCode::ShortcutUnavailable,
        });
      }

      if reveal_clipboard_on_launch {
        clipboard_window::show_on_launch(&handle);
      }

      if let Some(installation) = harness_installation::HarnessInstallation::open_default() {
        app.manage(installation);
      }
      chatgpt_auth_commands::manage(&handle);
      activity::start(handle.clone(), Arc::clone(&activity_manager));
      {
        let manager = Arc::clone(&manager);
        feature_access::start(
          handle.clone(),
          Arc::new(move |app, feature, enabled| match feature {
            feature_gate::DesktopFeature::ActivityTimeline => {
              activity::apply_feature_gate(app, enabled);
              if enabled {
                onboarding::feature_enabled(app, feature);
              }
              let manager = Arc::clone(&manager);
              let app = app.clone();
              tauri::async_runtime::spawn(async move {
                let snapshot = manager.lock().await.get_snapshot();
                tray::refresh(&app, &snapshot);
              });
            }
            feature_gate::DesktopFeature::TimeBilling => {
              use tauri::Emitter;
              best_effort(app.emit(activity::CHANGED_EVENT, ()), "activity change was not announced");
            }
            feature_gate::DesktopFeature::LocalAgents => {
              harness_commands::apply_feature_gate(app, enabled);
              chatgpt_auth_commands::apply_feature_gate(app, enabled);
            }
          }),
        );
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

          tray::refresh(&handle, &mgr.get_snapshot());
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
              tray::MenuAction::OpenActivity => {
                activity_window::show(&handle);
              }
              tray::MenuAction::SetActivityRecording(status) => {
                if activity::set_recording_from_tray(&handle, status).is_err() {
                  best_effort(
                    handle.notification().builder()
                      .title(i18n::t("tray.activity"))
                      .body(i18n::t("activity.errorUpdate"))
                      .show(),
                    "activity recording failure was not notified",
                  );
                  activity_window::show(&handle);
                }
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
                  updater::CheckOutcome::Disabled => {
                    tracing::debug!("tray updater check skipped: updates are managed");
                  }
                }
              }
              tray::MenuAction::OpenEditRoot => {
                manager.lock().await.open_edit_root().await;
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
                  drop(mgr);
                  crate::session_manager::retry_session(Arc::clone(&manager), &id).await;
                }
              }
              tray::MenuAction::RetrySession(id) => {
                let mut mgr = manager.lock().await;
                if mgr.retry_session_now(&id) {
                  mgr.persist_sessions_public().await;
                  drop(mgr);
                  crate::session_manager::retry_session(Arc::clone(&manager), &id).await;
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
          bridge::start_bridge(
            bridge_port,
            allowed_origins,
            manager_for_bridge,
            account,
          )
          .await;
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

      presence::start(handle.clone());

      // Check for updates in the background after launch settles.
      updater::schedule_startup_check(handle.clone(), Arc::clone(&manager));

      // Hide dock icon on macOS (tray-only app)
      #[cfg(target_os = "macos")]
      {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
      }

      onboarding::show_if_pending(
        &handle,
        launch_args
          .iter()
          .any(|arg| arg == app_lifecycle::BACKGROUND_LAUNCH_ARGUMENT),
      );

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
    .run(|app, event| match event {
      tauri::RunEvent::ExitRequested { api, code, .. } => {
        if app_lifecycle::should_prevent_exit(code) {
          tracing::info!("prevented background desktop process from exiting");
          api.prevent_exit();
        } else {
          tracing::info!(?code, "desktop process received an explicit exit request");
        }
      }
      tauri::RunEvent::Exit => {
        activity::flush_on_exit(app);
        desktop_crash::clean_exit(app);
        #[cfg(target_os = "macos")]
        if let Some(clipboard) = app.try_state::<ClipboardAppState>()
          && let Ok(mut clipboard) = clipboard.lock()
          && let Err(error) = clipboard.reconcile_image_exports()
        {
          tracing::warn!(error = %error, "clipboard image export cleanup will be retried");
        }
        tracing::info!("desktop event loop exited");
      }
      _ => {}
    });
}

/// The settings window's size. The browser harness reads these lines and
/// renders the window at this size (`tests/desktop-window-sizes.ts`).
const SETTINGS_WINDOW_WIDTH: f64 = 480.0;
const SETTINGS_WINDOW_HEIGHT: f64 = 460.0;

pub(crate) fn ensure_main_window(handle: &tauri::AppHandle, tab: &str) {
  // Accessory apps must explicitly activate to bring windows to front.
  #[cfg(target_os = "macos")]
  best_effort(handle.show(), "app could not be shown");

  if let Some(window) = handle.get_webview_window("main") {
    best_effort(window.show(), "settings window could not be shown");
    best_effort(window.set_focus(), "settings window could not be focused");
    best_effort(
      handle.emit_to("main", "activate-tab", serde_json::json!({ "tab": tab })),
      "settings tab change was not announced",
    );
    return;
  }

  let builder = crate::app_window::builder(handle, "main", "index.html")
    .title("stella desktop")
    .inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
    .resizable(false);
  let builder = window_placement::centered_on_target_screen(
    handle,
    builder,
    tauri::LogicalSize::new(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT),
  );

  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);

  match builder.build() {
    Ok(window) => {
      // A shortcut paused for recording must not stay released after the
      // window that recorded it is gone.
      let resume_handle = handle.clone();
      window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
          clipboard_shortcut::resume_after_window_closed(&resume_handle);
        }
      });
      // Emit tab activation after a short delay to let the webview load
      let handle = handle.clone();
      let tab = tab.to_string();
      tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        best_effort(
          handle.emit_to("main", "activate-tab", serde_json::json!({ "tab": tab })),
          "tab activation was not announced",
        );
      });
    }
    Err(e) => {
      tracing::error!(error = %e, "failed to create settings window");
    }
  }
}

#[cfg(feature = "allocation-tests")]
pub use clipboard::allocation_harness as clipboard_allocation_harness;
#[cfg(feature = "allocation-tests")]
pub use session_manager::allocation_harness as session_allocation_harness;
