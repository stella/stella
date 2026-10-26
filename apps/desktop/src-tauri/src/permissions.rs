//! The system permissions the desktop app explains and asks for: their live
//! status on this computer, the action that asks the OS, and the settings
//! page where the user changes them. Each row exists because something the
//! app does on this computer needs it.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::feature_gate::{DesktopFeature, FeatureGates};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
  Notifications,
  OpenAtLogin,
  Accessibility,
}

impl Permission {
  /// Display order.
  pub const ALL: [Self; 3] =
    [Self::Notifications, Self::OpenAtLogin, Self::Accessibility];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStatus {
  NotDetermined,
  Granted,
  Denied,
  /// An organisation's policy decides; the user cannot change it.
  #[cfg_attr(
    not(target_os = "windows"),
    allow(dead_code, reason = "only Windows reports notification policy")
  )]
  Managed,
  /// This OS has no such gate, or this build cannot read it.
  NotApplicable,
}

/// What the desktop app does on this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopSurface {
  DocumentHandoff,
  ClipboardHistory,
  ActivityDetails,
}

impl DesktopSurface {
  pub const ALL: [Self; 3] = [
    Self::DocumentHandoff,
    Self::ClipboardHistory,
    Self::ActivityDetails,
  ];
}

/// Which permissions each surface needs. Total by construction: a new
/// surface does not compile until it states its permissions.
pub const fn required_permissions(surface: DesktopSurface) -> &'static [Permission] {
  match surface {
    DesktopSurface::DocumentHandoff => {
      &[Permission::Notifications, Permission::OpenAtLogin]
    }
    DesktopSurface::ClipboardHistory => &[Permission::OpenAtLogin],
    DesktopSurface::ActivityDetails => &[Permission::Accessibility],
  }
}

fn surface_available(surface: DesktopSurface, gates: &FeatureGates) -> bool {
  match surface {
    DesktopSurface::DocumentHandoff | DesktopSurface::ClipboardHistory => true,
    DesktopSurface::ActivityDetails => {
      gates.is_enabled(DesktopFeature::ActivityTimeline)
    }
  }
}

/// The permissions some available surface needs, in display order.
pub fn needed_permissions(gates: &FeatureGates) -> Vec<Permission> {
  Permission::ALL
    .into_iter()
    .filter(|permission| {
      DesktopSurface::ALL.into_iter().any(|surface| {
        surface_available(surface, gates)
          && required_permissions(surface).contains(permission)
      })
    })
    .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRow {
  pub permission: Permission,
  pub status: PermissionStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsSnapshot {
  /// Rows for needed permissions this OS gates; `NotApplicable` rows are
  /// left out because there is nothing to explain.
  pub rows: Vec<PermissionRow>,
}

pub fn status(app: &AppHandle, permission: Permission) -> PermissionStatus {
  match permission {
    Permission::Notifications => notifications_status(app),
    Permission::OpenAtLogin => open_at_login_status(app),
    Permission::Accessibility => accessibility_status(),
  }
}

/// Reads every needed permission. The notification probe waits on a system
/// daemon, so callers run this off the async workers.
pub fn snapshot(app: &AppHandle) -> PermissionsSnapshot {
  let needed = needed_permissions(&app.state::<FeatureGates>());
  PermissionsSnapshot {
    rows: needed
      .into_iter()
      .map(|permission| PermissionRow {
        permission,
        status: status(app, permission),
      })
      .filter(|row| row.status != PermissionStatus::NotApplicable)
      .collect(),
  }
}

async fn snapshot_off_thread(app: AppHandle) -> Result<PermissionsSnapshot, String> {
  tauri::async_runtime::spawn_blocking(move || snapshot(&app))
    .await
    .map_err(crate::logging::with_cause_logged(
      "permission status could not be read",
    ))
}

#[cfg(target_os = "macos")]
fn notifications_status(_app: &AppHandle) -> PermissionStatus {
  use stella_desktop_macos::NotificationAuthorization;
  match stella_desktop_macos::notification_authorization() {
    NotificationAuthorization::NotDetermined => PermissionStatus::NotDetermined,
    NotificationAuthorization::Denied => PermissionStatus::Denied,
    NotificationAuthorization::Authorized => PermissionStatus::Granted,
    NotificationAuthorization::Unavailable => PermissionStatus::NotApplicable,
  }
}

/// Windows has no notification prompt: toasts are on unless the user or a
/// policy turned them off, which the registry records.
#[cfg(target_os = "windows")]
fn notifications_status(app: &AppHandle) -> PermissionStatus {
  use windows_registry::{CURRENT_USER, Key, LOCAL_MACHINE};

  const POLICY: &str =
    r"Software\Policies\Microsoft\Windows\CurrentVersion\PushNotifications";
  const GLOBAL: &str = r"Software\Microsoft\Windows\CurrentVersion\PushNotifications";
  const PER_APP: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings";

  let value = |root: &Key, path: &str, name: &str| {
    root.open(path).and_then(|key| key.get_u32(name)).ok()
  };
  if [CURRENT_USER, LOCAL_MACHINE]
    .iter()
    .any(|root| value(root, POLICY, "NoToastApplicationNotification") == Some(1))
  {
    return PermissionStatus::Managed;
  }
  // The notification plugin posts under the bundle identifier as its
  // application user model ID.
  let per_app = format!(r"{PER_APP}\{}", app.config().identifier);
  if value(CURRENT_USER, GLOBAL, "ToastEnabled") == Some(0)
    || value(CURRENT_USER, &per_app, "Enabled") == Some(0)
  {
    return PermissionStatus::Denied;
  }
  PermissionStatus::Granted
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn notifications_status(_app: &AppHandle) -> PermissionStatus {
  PermissionStatus::NotApplicable
}

fn open_at_login_status(app: &AppHandle) -> PermissionStatus {
  match app.autolaunch().is_enabled() {
    Ok(true) => registered_login_item_status(app),
    Ok(false) => PermissionStatus::NotDetermined,
    Err(error) => {
      tracing::warn!(error = %error, "login item status could not be read");
      PermissionStatus::NotDetermined
    }
  }
}

/// A registered launch agent still needs Login Items approval on macOS 13+.
#[cfg(target_os = "macos")]
fn registered_login_item_status(app: &AppHandle) -> PermissionStatus {
  use stella_desktop_macos::LoginItemApproval;
  let Ok(path) = crate::autostart::launch_agent_path(app) else {
    return PermissionStatus::Granted;
  };
  match stella_desktop_macos::login_item_approval(&path) {
    LoginItemApproval::RequiresApproval => PermissionStatus::Denied,
    LoginItemApproval::Approved | LoginItemApproval::Unknown => {
      PermissionStatus::Granted
    }
  }
}

/// Windows reports a login item switched off in Startup apps as not enabled,
/// and enabling it again restores it.
#[cfg(not(target_os = "macos"))]
fn registered_login_item_status(_app: &AppHandle) -> PermissionStatus {
  PermissionStatus::Granted
}

#[cfg(target_os = "macos")]
fn accessibility_status() -> PermissionStatus {
  // macOS records no refusal: an untrusted app has simply not been allowed.
  if stella_desktop_macos::accessibility_trusted() {
    PermissionStatus::Granted
  } else {
    PermissionStatus::NotDetermined
  }
}

#[cfg(not(target_os = "macos"))]
fn accessibility_status() -> PermissionStatus {
  PermissionStatus::NotApplicable
}

/// The OS settings page for a permission, where the user changes it.
#[cfg_attr(
  target_os = "macos",
  allow(
    clippy::unnecessary_wraps,
    reason = "every macOS permission has a page; other platforms have permissions without one"
  )
)]
fn settings_url(app: &AppHandle, permission: Permission) -> Option<String> {
  #[cfg(target_os = "macos")]
  {
    Some(match permission {
      Permission::Notifications => format!(
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={}",
        app.config().identifier
      ),
      Permission::OpenAtLogin => {
        "x-apple.systempreferences:com.apple.LoginItems-Settings.extension".to_string()
      }
      Permission::Accessibility => ACCESSIBILITY_SETTINGS_URL.to_string(),
    })
  }
  #[cfg(target_os = "windows")]
  {
    let _ = app;
    match permission {
      Permission::Notifications => Some("ms-settings:notifications".to_string()),
      Permission::OpenAtLogin => Some("ms-settings:startupapps".to_string()),
      Permission::Accessibility => None,
    }
  }
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  {
    let _ = (app, permission);
    None
  }
}

#[cfg(target_os = "macos")]
pub const ACCESSIBILITY_SETTINGS_URL: &str =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

pub fn open_settings(app: &AppHandle, permission: Permission) -> Result<(), String> {
  let url = settings_url(app, permission)
    .ok_or_else(|| "this permission has no settings page here".to_string())?;
  opener::open(url)
    .map_err(crate::logging::with_cause_logged(
      "system settings could not be opened",
    ))
    .inspect(|()| {
      if permission == Permission::Accessibility {
        crate::accessibility_guide::show(app);
      }
    })
}

/// Asks the OS where it can ask, and otherwise opens the settings page.
fn request(app: &AppHandle, permission: Permission) -> Result<(), String> {
  match permission {
    Permission::OpenAtLogin => crate::autostart::enable(app),
    Permission::Notifications => {
      #[cfg(target_os = "macos")]
      if notifications_status(app) == PermissionStatus::NotDetermined {
        stella_desktop_macos::request_notification_authorization();
        return Ok(());
      }
      open_settings(app, permission)
    }
    Permission::Accessibility => {
      // Asking adds the app to the Accessibility list, switched off; the
      // user turns it on in the pane opened next.
      #[cfg(target_os = "macos")]
      stella_desktop_macos::request_accessibility_permission();
      open_settings(app, permission)
    }
  }
}

#[tauri::command]
pub async fn permissions_get_snapshot(
  app: AppHandle,
) -> Result<PermissionsSnapshot, String> {
  snapshot_off_thread(app).await
}

#[tauri::command]
pub async fn permissions_request(
  app: AppHandle,
  permission: Permission,
) -> Result<PermissionsSnapshot, String> {
  let request_app = app.clone();
  tauri::async_runtime::spawn_blocking(move || request(&request_app, permission))
    .await
    .map_err(crate::logging::with_cause_logged(
      "permission request could not run",
    ))??;
  snapshot_off_thread(app).await
}

#[tauri::command]
pub async fn permissions_open_settings(
  app: AppHandle,
  permission: Permission,
) -> Result<(), String> {
  open_settings(&app, permission)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn every_surface_needs_at_least_one_listed_permission() {
    for surface in DesktopSurface::ALL {
      let needed = required_permissions(surface);
      assert!(!needed.is_empty(), "{surface:?} states no permission");
      assert!(
        needed
          .iter()
          .all(|permission| Permission::ALL.contains(permission))
      );
    }
  }

  #[test]
  fn every_permission_is_needed_by_some_surface() {
    for permission in Permission::ALL {
      assert!(
        DesktopSurface::ALL
          .into_iter()
          .any(|surface| required_permissions(surface).contains(&permission)),
        "{permission:?} has no surface that needs it"
      );
    }
  }

  #[test]
  fn accessibility_is_needed_only_while_activity_is_enabled() {
    let gates = FeatureGates::default();
    assert_eq!(
      needed_permissions(&gates),
      vec![Permission::Notifications, Permission::OpenAtLogin]
    );
  }

  #[test]
  fn statuses_serialize_as_the_names_the_windows_switch_on() {
    let row = PermissionRow {
      permission: Permission::OpenAtLogin,
      status: PermissionStatus::NotDetermined,
    };
    assert_eq!(
      serde_json::to_value(row).unwrap(),
      serde_json::json!({ "permission": "openAtLogin", "status": "notDetermined" })
    );
  }
}
