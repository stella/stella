use std::sync::Arc;
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

use crate::session_manager::SessionManager;
use crate::types::{AppSnapshot, DesktopNotificationPreferences};

pub type AppState = Arc<Mutex<SessionManager>>;

fn stella_account_url(linked_self_host_origin: Option<&str>) -> String {
  let default_web_origin = crate::config::default_connect_target().1;
  format!(
    "{}/settings/account/desktop",
    linked_self_host_origin.unwrap_or(&default_web_origin)
  )
}

/// The API and web origin a new browser connection goes to: the selected
/// self-hosted server, else the build's own server. A remembered self-hosted
/// link without a selected server has no API to connect to yet.
fn browser_connect_target_from(
  selected: Option<&crate::types::TrustedSelfHostConnection>,
  remembered_self_host: bool,
) -> Result<(String, String), String> {
  match selected {
    Some(connection) => Ok((
      connection.api_base_url.clone(),
      connection.web_origin.clone(),
    )),
    None if remembered_self_host => {
      Err("Reconnect the self-hosted desktop server to select its API".into())
    }
    None => Ok(crate::config::default_connect_target()),
  }
}

pub(crate) fn browser_connect_target(
  manager: &SessionManager,
) -> Result<(String, String), String> {
  browser_connect_target_from(
    manager.selected_self_host_connection(),
    manager.linked_self_host_origin().is_some(),
  )
}

/// The server the account card names for a new connection. It is always the
/// server `open_stella_account` would open, or the remembered self-hosted one
/// that has to be reconnected first.
pub(crate) fn browser_connect_server(manager: &SessionManager) -> String {
  match browser_connect_target(manager) {
    Ok((_, web_origin)) => web_origin,
    Err(_) => manager
      .linked_self_host_origin()
      .map_or_else(|| crate::config::default_connect_target().1, str::to_owned),
  }
}

#[tauri::command]
pub async fn get_state(state: State<'_, AppState>) -> Result<AppSnapshot, String> {
  let mgr = state.lock().await;
  Ok(mgr.get_snapshot())
}

#[tauri::command]
pub async fn open_stella_account(
  app: tauri::AppHandle,
  state: State<'_, AppState>,
  account: State<'_, crate::account::AccountState>,
) -> Result<(), String> {
  let linked = crate::account::current(&account).await?;
  if linked.is_none() {
    let (api_base_url, origin) = browser_connect_target(&*state.lock().await)?;
    return crate::account::open_browser_connection(&app, &api_base_url, &origin)
      .await
      .inspect_err(|error| {
        tracing::warn!(error = %error, web_origin = %origin, "stella web connection did not open");
      });
  }
  let web_origin = linked.as_ref().map(|account| account.web_origin.as_str());
  app
    .opener()
    .open_url(stella_account_url(web_origin), None::<&str>)
    .map_err(|e| format!("stella desktop could not open stella web: {e}"))
}

#[tauri::command]
pub async fn update_notification_preferences(
  prefs: DesktopNotificationPreferences,
  state: State<'_, AppState>,
) -> Result<AppSnapshot, String> {
  let mut mgr = state.lock().await;
  Ok(mgr.update_notification_preferences(prefs).await)
}

#[tauri::command]
pub async fn open_session_file(
  session_id: String,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.open_session_file(&session_id))
}

#[tauri::command]
pub async fn reveal_session(
  session_id: String,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.reveal_session(&session_id))
}

#[tauri::command]
pub async fn finish_session(
  session_id: String,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  let mut mgr = state.lock().await;
  let result = mgr.finish_session(&session_id);
  if result {
    mgr.persist_sessions_public().await;
  }
  drop(mgr);
  if result {
    crate::session_manager::retry_session(Arc::clone(state.inner()), &session_id).await;
  }
  Ok(result)
}

#[tauri::command]
pub async fn retry_session(
  session_id: String,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  let mut mgr = state.lock().await;
  let result = mgr.retry_session_now(&session_id);
  if result {
    mgr.persist_sessions_public().await;
  }
  drop(mgr);
  if result {
    crate::session_manager::retry_session(Arc::clone(state.inner()), &session_id).await;
  }
  Ok(result)
}

#[tauri::command]
pub async fn takeover_dialog_respond(
  approved: bool,
  window: tauri::WebviewWindow,
) -> Result<(), String> {
  let label = window.label().to_string();
  crate::session_manager::set_takeover_response(&label, approved);
  let _ = window.close();
  Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticDialogBounds {
  max_width: f64,
  max_height: f64,
}

#[tauri::command]
pub async fn fit_static_dialog(
  window: tauri::WebviewWindow,
  width: f64,
  height: f64,
) -> Result<StaticDialogBounds, String> {
  if !matches!(
    window.label(),
    "selfhost-connect-dialog" | "pdf-sign-dialog"
  ) {
    return Err("Only static approval dialogs can request content sizing".into());
  }
  if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
    return Err("Invalid dialog content size".into());
  }
  let area = crate::window_placement::target_work_area(window.app_handle());
  let max_width = area.map_or(720.0, |area| (area.width - 64.0).min(720.0));
  let max_height = area.map_or(960.0, |area| (area.height - 64.0).min(960.0));
  let size = tauri::LogicalSize::new(width.min(max_width), height.min(max_height));
  window.set_size(size).map_err(|error| error.to_string())?;
  if let Some(area) = area {
    window
      .set_position(crate::window_placement::centered_origin(area, size))
      .map_err(|error| error.to_string())?;
  }
  Ok(StaticDialogBounds {
    max_width,
    max_height,
  })
}

#[tauri::command]
pub async fn self_host_connect_dialog_respond(
  approved: bool,
  window: tauri::WebviewWindow,
) -> Result<(), String> {
  crate::deep_link::set_self_host_connect_response(approved);
  let _ = window.close();
  Ok(())
}

/// The PDF signing dialog's Sign and Cancel. Sign keeps the call open until
/// the flow behind it finishes, so the dialog can render the outcome; a
/// response with no flow waiting for it (a second click, an expired dialog)
/// only closes the window.
#[tauri::command]
pub async fn pdf_sign_respond(
  response: crate::pdf_signing::PdfSignDialogResponse,
  window: tauri::WebviewWindow,
) -> Result<crate::pdf_signing::PdfSignResult, String> {
  use crate::pdf_signing::{DialogChoice, PdfSignDialogResponse, PdfSignResult};

  let choice = match response {
    PdfSignDialogResponse::Sign { identity_id } => DialogChoice::Sign { identity_id },
    PdfSignDialogResponse::Retry => DialogChoice::Retry,
    PdfSignDialogResponse::Cancel => DialogChoice::Cancel,
  };
  let waiting = crate::pdf_signing::submit_dialog_choice(choice);

  match waiting {
    Some(outcome) => Ok(outcome.await.unwrap_or(PdfSignResult::Cancelled)),
    None => {
      let _ = window.close();
      Ok(PdfSignResult::Cancelled)
    }
  }
}

#[tauri::command]
pub async fn respond_to_takeover(
  session_id: String,
  approved: bool,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  Ok(
    crate::session_manager::respond_to_takeover(
      Arc::clone(state.inner()),
      &session_id,
      approved,
    )
    .await,
  )
}

#[tauri::command]
pub async fn copy_diagnostics(state: State<'_, AppState>) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.copy_diagnostics())
}

#[tauri::command]
pub async fn email_support() -> Result<bool, String> {
  Ok(SessionManager::email_support())
}

#[tauri::command]
pub async fn reveal_support_root(state: State<'_, AppState>) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.reveal_support_root())
}

#[tauri::command]
pub async fn open_edit_root(state: State<'_, AppState>) -> Result<bool, String> {
  let mgr = state.lock().await;
  Ok(mgr.open_edit_root().await)
}

#[tauri::command]
pub async fn is_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
  use tauri_plugin_autostart::ManagerExt;
  app
    .autolaunch()
    .is_enabled()
    .map_err(|e| format!("autostart check failed: {e}"))
}

#[tauri::command]
pub async fn set_autostart(
  enabled: bool,
  app: tauri::AppHandle,
) -> Result<bool, String> {
  use tauri_plugin_autostart::ManagerExt;
  if enabled {
    crate::autostart::enable(&app)?;
  } else {
    app
      .autolaunch()
      .disable()
      .map_err(|e| format!("autostart disable failed: {e}"))?;
  }
  Ok(enabled)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn browser_connect_target_follows_the_selected_server() {
    let selected = crate::types::TrustedSelfHostConnection {
      api_base_url: "https://api.stella.example".into(),
      trusted_at: "2026-10-15T00:00:00Z".into(),
      web_origin: "https://stella.example".into(),
    };
    for remembered in [true, false] {
      assert_eq!(
        browser_connect_target_from(Some(&selected), remembered).unwrap(),
        (
          "https://api.stella.example".to_owned(),
          "https://stella.example".to_owned()
        )
      );
    }
    assert_eq!(
      browser_connect_target_from(None, false).unwrap(),
      crate::config::default_connect_target()
    );
    assert!(browser_connect_target_from(None, true).is_err());
  }

  #[test]
  fn account_settings_url_uses_the_linked_self_host_origin() {
    assert_eq!(
      stella_account_url(Some("https://stella.example")),
      "https://stella.example/settings/account/desktop"
    );
    assert_eq!(
      stella_account_url(None),
      "https://my.stll.app/settings/account/desktop"
    );
  }
}
