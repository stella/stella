use objc2::runtime::{AnyObject, NSObjectProtocol};
use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSApplication, NSPanel, NSWindow, NSWindowStyleMask};
use tauri::{Runtime, WebviewWindow};

define_class!(
  /// Class the clipboard window is re-classed to once it exists. A
  /// non-activating panel takes key status without activating the app: the app
  /// the user was working in stays frontmost, keeps its menu bar, and regains
  /// its caret the moment the panel gives key status back.
  // SAFETY: NSPanel has no subclassing requirements beyond NSWindow's, and the
  // struct does not implement Drop.
  #[unsafe(super(NSPanel))]
  #[thread_kind = MainThreadOnly]
  #[name = "StellaClipboardPanel"]
  struct ClipboardPanel;

  impl ClipboardPanel {
    // Re-classing drops tao's override of these; without it a borderless
    // window refuses key status.
    #[unsafe(method(canBecomeKeyWindow))]
    fn can_become_key_window(&self) -> bool {
      true
    }

    #[unsafe(method(canBecomeMainWindow))]
    fn can_become_main_window(&self) -> bool {
      false
    }
  }
);

fn ns_window<R: Runtime>(
  window: &WebviewWindow<R>,
) -> Option<(MainThreadMarker, &NSWindow)> {
  let main_thread = MainThreadMarker::new()?;
  let ns_window = window.ns_window().ok()?;
  if ns_window.is_null() {
    return None;
  }
  // SAFETY: `ns_window` returns a valid pointer to the live window's NSWindow
  // and the main thread was verified above.
  Some((main_thread, unsafe { &*ns_window.cast::<NSWindow>() }))
}

fn make_nonactivating_panel(ns_window: &NSWindow) {
  let panel_class = ClipboardPanel::class();
  if ns_window.class() == panel_class {
    return;
  }
  // SAFETY: NSPanel adds no instance variables to NSWindow, so the window's
  // existing allocation covers the new class. tao's `focusable` ivar becomes
  // unreachable; its only reader is `set_focusable`, which nothing calls on
  // this window.
  unsafe { AnyObject::set_class(ns_window, panel_class) };
  ns_window.setStyleMask(ns_window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
  // The mask alone does not update the window server's prevents-activation
  // state on a window that already exists: keyboard use would stay
  // non-activating, but a click inside the panel would activate the app and
  // dismissal would then leave it frontmost. Private AppKit setter, hence the
  // `respondsToSelector` guard; an AppKit without it keeps the click caveat.
  let selector = sel!(_setPreventsActivation:);
  if ns_window.respondsToSelector(selector) {
    // SAFETY: the instance responds to the selector, which takes one BOOL.
    unsafe {
      let () = msg_send![ns_window, _setPreventsActivation: true];
    }
  }
  // Panels hide when their app deactivates by default, which would defeat
  // parking every time key status moves back to the previous app.
  ns_window.setHidesOnDeactivate(false);
}

/// Shows the window as the key window without activating the app (so the app
/// underneath stays frontmost), restoring it from a park first. Re-classes it
/// into a non-activating panel on first use. Returns false when the change
/// could not be applied (not on the main thread, or no window handle); the
/// caller then falls back to an activating show.
pub fn present_key_panel<R: Runtime>(window: &WebviewWindow<R>) -> bool {
  let Some((main_thread, ns_window)) = ns_window(window) else {
    return false;
  };
  make_nonactivating_panel(ns_window);
  ns_window.setAlphaValue(1.0);
  ns_window.setIgnoresMouseEvents(false);
  // Cmd-H from an activating window (settings) hides the whole app, and
  // ordering a window front does not clear that.
  let app = NSApplication::sharedApplication(main_thread);
  if app.isHidden() {
    app.unhideWithoutActivation();
  }
  ns_window.makeKeyAndOrderFront(None);
  true
}

/// Parks the window: fully transparent, click-through, and no longer key, so
/// the app underneath gets its caret back. The window stays ordered in and
/// WebKit keeps the page warm. Returns false when the change could not be
/// applied (not on the main thread, or no window handle); the caller then
/// falls back to hiding.
pub fn park_window<R: Runtime>(window: &WebviewWindow<R>) -> bool {
  let Some((_, ns_window)) = ns_window(window) else {
    return false;
  };
  ns_window.setAlphaValue(0.0);
  ns_window.setIgnoresMouseEvents(true);
  // Ordering out is the only public way to give key status back. Ordering
  // straight back in keeps the page on screen; WebKit coalesces the two into
  // no visibility change.
  if ns_window.isKeyWindow() {
    ns_window.orderOut(None);
    ns_window.orderFront(None);
  }
  true
}

/// Stops the webview from tracking window occlusion, so a parked window
/// (alpha 0) is never reported occluded, which would suspend WebKit's
/// rendering and defeat the parking. Private WebKit setter, hence the
/// `respondsToSelector` guard; a WebKit without it keeps the default.
pub fn disable_occlusion_detection<R: Runtime>(window: &WebviewWindow<R>) {
  let _ = window.with_webview(|webview| {
    // SAFETY: `inner` returns a valid WKWebView pointer for the lifetime of
    // the closure, which Tauri runs on the main thread. The selector is only
    // messaged when the instance responds to it, and it takes one BOOL.
    unsafe {
      let webview = &*webview.inner().cast::<AnyObject>();
      let selector = sel!(_setWindowOcclusionDetectionEnabled:);
      let responds: bool = msg_send![webview, respondsToSelector: selector];
      if responds {
        let () = msg_send![webview, _setWindowOcclusionDetectionEnabled: false];
      }
    }
  });
}
