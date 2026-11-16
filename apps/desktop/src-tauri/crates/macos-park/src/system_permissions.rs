//! Probes and prompts for the system permissions the desktop app explains to
//! the user. Nothing here changes a setting by itself: macOS shows its own
//! prompt and the user decides.

use std::{
  ffi::CStr,
  path::Path,
  ptr::NonNull,
  sync::{OnceLock, mpsc},
  time::Duration,
};

use block2::RcBlock;
use objc2::{
  msg_send,
  rc::Retained,
  runtime::{AnyClass, AnyObject, Bool},
};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicrophoneAuthorization {
  NotDetermined,
  Denied,
  Authorized,
  /// macOS before 14, where the app cannot read its microphone permission.
  Unavailable,
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
    match sender.try_send(status) {
      // The caller stops waiting after NOTIFICATION_SETTINGS_TIMEOUT.
      Ok(()) | Err(mpsc::TrySendError::Disconnected(_)) => {}
      Err(mpsc::TrySendError::Full(_)) => {
        unreachable!("notification settings callback delivered more than once");
      }
    }
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

const AVFAUDIO_PATH: &CStr = c"/System/Library/Frameworks/AVFAudio.framework/AVFAudio";

/// `AVAudioApplicationRecordPermission` values, four-character codes.
const RECORD_PERMISSION_UNDETERMINED: isize = 0x756e_6474;
const RECORD_PERMISSION_DENIED: isize = 0x6465_6e79;
const RECORD_PERMISSION_GRANTED: isize = 0x6772_6e74;

/// `AVAudioApplication`, which reads and asks for the microphone permission
/// from macOS 14. AVFAudio is opened on first use rather than linked, so the
/// app still starts on a macOS that does not ship it.
fn audio_application_class() -> Option<&'static AnyClass> {
  static LOADED: OnceLock<bool> = OnceLock::new();
  if !objc2::available!(macos = 14.0) {
    return None;
  }
  let loaded = *LOADED.get_or_init(|| {
    // SAFETY: the path is a NUL-terminated constant; the handle stays open
    // for the life of the process, so the classes it registers stay valid.
    let handle = unsafe {
      libc::dlopen(AVFAUDIO_PATH.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL)
    };
    !handle.is_null()
  });
  if !loaded {
    return None;
  }
  AnyClass::get(c"AVAudioApplication")
}

/// Whether macOS lets this app record from the microphone. Reading never
/// prompts.
pub fn microphone_authorization() -> MicrophoneAuthorization {
  let Some(class) = audio_application_class() else {
    return MicrophoneAuthorization::Unavailable;
  };
  // SAFETY: `sharedInstance` is a class method of AVAudioApplication, which
  // exists from macOS 14 (checked above), and returns a shared object.
  let shared: Option<Retained<AnyObject>> = unsafe { msg_send![class, sharedInstance] };
  let Some(shared) = shared else {
    return MicrophoneAuthorization::Unavailable;
  };
  // SAFETY: `recordPermission` is an instance method of that shared object
  // and returns an NSInteger-backed enum.
  let permission: isize = unsafe { msg_send![&*shared, recordPermission] };
  match permission {
    RECORD_PERMISSION_UNDETERMINED => MicrophoneAuthorization::NotDetermined,
    RECORD_PERMISSION_DENIED => MicrophoneAuthorization::Denied,
    RECORD_PERMISSION_GRANTED => MicrophoneAuthorization::Authorized,
    _ => MicrophoneAuthorization::Unavailable,
  }
}

/// Shows the system prompt the first time; afterwards macOS answers from the
/// stored decision without prompting, so callers re-read the status. A
/// process outside an app bundle has no usage description to show, and macOS
/// would end it instead of asking.
pub fn request_microphone_permission() {
  if !runs_from_app_bundle() {
    return;
  }
  let Some(class) = audio_application_class() else {
    return;
  };
  let handler = RcBlock::new(|_granted: Bool| {});
  // SAFETY: the class method exists from macOS 14 (checked above) and copies
  // the completion block, which captures nothing.
  let () = unsafe {
    msg_send![class, requestRecordPermissionWithCompletionHandler: &*handler]
  };
}
