mod bridge;
mod commands;
mod config;
mod deep_link;
mod i18n;
mod keychain;
mod session_manager;
mod session_store;
mod sse;
mod tray;
mod types;
mod updater;

use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;
use tracing_subscriber::EnvFilter;

use commands::AppState;
use session_manager::SessionManager;

pub fn run() {
  tracing_subscriber::fmt()
    .with_env_filter(
      EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
    )
    .init();

  i18n::init();

  let bridge_port = config::resolve_bridge_port();
  let allowed_origins = config::resolve_allowed_origins();

  let manager = Arc::new(Mutex::new(SessionManager::new()));
  #[cfg(target_os = "macos")]
  let manager_for_single_instance = Arc::clone(&manager);

  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(
      move |_app, _args, _cwd| {
        #[cfg(target_os = "macos")]
        for arg in _args {
          if arg.starts_with("stella://") {
            deep_link::handle_url(
              &arg,
              Arc::clone(&manager_for_single_instance),
              _app.clone(),
            );
          }
        }
      },
    ))
    .plugin(tauri_plugin_autostart::init(
      MacosLauncher::LaunchAgent,
      None,
    ))
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage::<AppState>(Arc::clone(&manager))
    .setup(move |app| {
      let handle = app.handle().clone();

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
          if let Ok(menu) = tray::build_tray_menu(&handle, &snapshot) {
            if let Some(tray) = handle.tray_by_id("main") {
              let _ = tray.set_menu(Some(menu));
            }
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
                std::process::exit(0);
              }
              tray::MenuAction::OpenPreferences(tab) => {
                ensure_main_window(&handle, tab);
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
                let mgr = manager.lock().await;
                mgr.email_support();
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

      // Enable auto-start on first launch
      {
        use tauri_plugin_autostart::ManagerExt;
        let autostart = handle.autolaunch();
        if let Ok(false) = autostart.is_enabled() {
          let _ = autostart.enable();
          tracing::info!("auto-start enabled on first launch");
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
        use tauri_plugin_deep_link::DeepLinkExt;
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

        if let Some(urls) = app.deep_link().get_current()? {
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
    .invoke_handler(tauri::generate_handler![
      commands::get_state,
      commands::update_notification_preferences,
      commands::open_session_file,
      commands::reveal_session,
      commands::finish_session,
      commands::retry_session,
      commands::respond_to_takeover,
      commands::takeover_dialog_respond,
      commands::copy_diagnostics,
      commands::email_support,
      commands::reveal_support_root,
      commands::open_edit_root,
      commands::is_autostart_enabled,
      commands::set_autostart,
    ])
    .build(tauri::generate_context!())
    .expect("error while building stella desktop")
    .run(|_app, event| {
      if let tauri::RunEvent::ExitRequested { api, .. } = event {
        // Prevent exit when the last window closes — we're a tray app.
        api.prevent_exit();
      }
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
  .resizable(false)
  .center();

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
