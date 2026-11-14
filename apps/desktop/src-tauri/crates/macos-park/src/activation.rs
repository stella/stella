use objc2::{MainThreadMarker, available};
use objc2_app_kit::{
  NSApplication, NSApplicationActivationOptions, NSRunningApplication, NSWindow,
};

/// Makes `ns_window` key and requests activation for this app, so the window
/// is the key window of the active app and WebKit draws its caret and focus
/// ring. A non-activating panel cannot serve here: making one key lets the
/// app's window take keystrokes while the app stays inactive.
///
/// From macOS 14 activation is cooperative: `activate()` is a request the
/// system honours "after considering the user's intent and larger system
/// context"
/// (<https://developer.apple.com/documentation/appkit/passing-control-from-one-app-to-another-with-cooperative-activation>),
/// and it "doesn't guarantee app activation"
/// (<https://developer.apple.com/documentation/appkit/nsapplication/activate()>).
/// Callers therefore request it while handling the user's own action. Before
/// macOS 14, `activate(ignoringOtherApps: true)` activates "regardless" of the
/// active app
/// (<https://developer.apple.com/documentation/appkit/nsapplication/activate(ignoringotherapps:)>).
pub(crate) fn activate_with_key_window(
  application: &NSApplication,
  ns_window: &NSWindow,
) {
  // "When you send a makeKey() message to an NSWindow object, you ensure that
  // it's the key window when the app is active" (activate(ignoringOtherApps:)).
  ns_window.makeKeyAndOrderFront(None);
  if available!(macos = 14.0) {
    application.activate();
    return;
  }
  #[allow(
    deprecated,
    reason = "activate() exists from macOS 14; this branch runs only below it"
  )]
  application.activateIgnoringOtherApps(true);
}

/// Outcome of handing activation back to the app that was frontmost before an
/// activating window opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationReturn {
  /// The system accepted the request to activate the previous app.
  Requested,
  /// The system declined the request; stella stays active.
  Declined,
  /// stella is no longer active, so the user already chose where focus went.
  NotActive,
  /// No running app has the recorded process identifier any more.
  PreviousAppGone,
  /// Not called on the main thread, where AppKit must be used.
  NotOnMainThread,
}

/// Hands activation back to the app with `process_id` when stella is still
/// active and that app is still running.
pub fn return_activation(process_id: i32) -> ActivationReturn {
  let Some(main_thread) = MainThreadMarker::new() else {
    return ActivationReturn::NotOnMainThread;
  };
  let application = NSApplication::sharedApplication(main_thread);
  if !application.isActive() {
    return ActivationReturn::NotActive;
  }
  let Some(previous) =
    NSRunningApplication::runningApplicationWithProcessIdentifier(process_id)
      .filter(|previous| !previous.isTerminated())
  else {
    return ActivationReturn::PreviousAppGone;
  };
  let requested = if available!(macos = 14.0) {
    // "Only the active app can influence the activation context. It does so
    // by yielding to an explicit target app before the target app activates"
    // (<https://developer.apple.com/documentation/appkit/passing-control-from-one-app-to-another-with-cooperative-activation>).
    // `activate(from:options:)` then names stella as the app the target takes
    // active status from, after the yield
    // (<https://developer.apple.com/documentation/appkit/nsrunningapplication/activate(from:options:)>).
    application.yieldActivationToApplication(&previous);
    previous.activateFromApplication_options(
      &NSRunningApplication::currentApplication(),
      NSApplicationActivationOptions::empty(),
    )
  } else {
    // Without ignoring other apps, "activation deactivates the calling app
    // (assuming it was active), and then the new app is activated only if
    // there's no currently active application"
    // (<https://developer.apple.com/documentation/appkit/nsapplication/activationoptions/activateignoringotherapps>).
    previous.activateWithOptions(NSApplicationActivationOptions::empty())
  };
  if requested {
    ActivationReturn::Requested
  } else {
    ActivationReturn::Declined
  }
}
