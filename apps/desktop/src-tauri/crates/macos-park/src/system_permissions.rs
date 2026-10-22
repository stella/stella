//! Probes and prompts for the system permissions the desktop app explains to
//! the user. Nothing here changes a setting by itself: macOS shows its own
//! prompt and the user decides.

use std::{path::Path, ptr::NonNull, sync::mpsc, time::Duration};

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSBundle, NSError, NSString, NSURL};
use objc2_service_management::{SMAppService, SMAppServiceStatus};
use objc2_user_notifications::{
  UNAuthorizationOptions, UNAuthorizationStatus, UNNotificationSettings,
  UNUserNotificationCenter,
};

/// The settings query answers from a system daemon; a stuck daemon must not
/// hold the caller's thread.
const NOTIFICATION_SETTINGS_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationAuthorization {
  NotDetermined,
  Denied,
  Authorized,
  /// Not running from an app bundle, or the daemon did not answer in time.
  Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginItemApproval {
  Approved,
  /// The user switched the item off in Login Items.
  RequiresApproval,
  /// macOS before 13, or a status that says nothing about approval.
  Unknown,
}

/// `UNUserNotificationCenter` raises an Objective-C exception in a process
/// that does not run from an app bundle, such as a development binary.
fn runs_from_app_bundle() -> bool {
  let bundle = NSBundle::mainBundle();
  bundle.bundleIdentifier().is_some()
    && bundle.bundlePath().to_string().ends_with(".app")
}

pub fn notification_authorization() -> NotificationAuthorization {
  if !runs_from_app_bundle() {
    return NotificationAuthorization::Unavailable;
  }
  let (sender, receiver) = mpsc::sync_channel(1);
  let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
    // SAFETY: the framework passes a live settings object for the duration of
    // the completion handler; only a copied status value leaves the block.
    let status = unsafe { settings.as_ref() }.authorizationStatus();
    let _ = sender.try_send(status);
  });
  UNUserNotificationCenter::currentNotificationCenter()
    .getNotificationSettingsWithCompletionHandler(&handler);
  match receiver.recv_timeout(NOTIFICATION_SETTINGS_TIMEOUT) {
    Ok(UNAuthorizationStatus::NotDetermined) => {
      NotificationAuthorization::NotDetermined
    }
    Ok(UNAuthorizationStatus::Denied) => NotificationAuthorization::Denied,
    // Authorized, provisional and ephemeral authorizations all deliver.
    Ok(_) => NotificationAuthorization::Authorized,
    Err(_) => NotificationAuthorization::Unavailable,
  }
}

/// Shows the system prompt the first time; afterwards macOS answers from the
/// stored decision without prompting, so callers re-read the status.
pub fn request_notification_authorization() {
  if !runs_from_app_bundle() {
    return;
  }
  let handler = RcBlock::new(|_granted: Bool, _error: *mut NSError| {});
  UNUserNotificationCenter::currentNotificationCenter()
    .requestAuthorizationWithOptions_completionHandler(
      UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
      &handler,
    );
}

/// Whether Login Items lets a launch agent registered at `plist` run.
pub fn login_item_approval(plist: &Path) -> LoginItemApproval {
  if !objc2::available!(macos = 13.0) {
    return LoginItemApproval::Unknown;
  }
  let Some(path) = plist.to_str() else {
    return LoginItemApproval::Unknown;
  };
  let url = NSURL::fileURLWithPath(&NSString::from_str(path));
  // SAFETY: SMAppService exists from macOS 13, checked above, and the call
  // reads a live file URL without taking ownership of it.
  match unsafe { SMAppService::statusForLegacyURL(&url) } {
    SMAppServiceStatus::Enabled => LoginItemApproval::Approved,
    SMAppServiceStatus::RequiresApproval => LoginItemApproval::RequiresApproval,
    _ => LoginItemApproval::Unknown,
  }
}
