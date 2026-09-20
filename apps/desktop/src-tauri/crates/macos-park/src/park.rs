use objc2::runtime::{AnyClass, AnyObject, Bool, NSObjectProtocol};
use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
  NSApplication, NSPanel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use tauri::{Runtime, WebviewWindow};

define_class!(
  /// Class the clipboard window is re-classed to once it exists. A
  /// non-activating panel takes key status without activating the app: the app
  /// the user was working in stays frontmost, keeps its menu bar, and regains
  /// its caret the moment the panel gives key status back.
  // SAFETY: NSPanel has no subclassing requirements beyond NSWindow's, and the
  // mirrored Bool matches TaoWindow's only ivar. The runtime layout check
  // rejects the conversion if Tao's class changes.
  #[unsafe(super(NSPanel))]
  #[thread_kind = MainThreadOnly]
  #[name = "StellaClipboardPanel"]
  #[ivars = Bool]
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

    /// AppKit owns outside-click detection for a non-activating panel. Tao's
    /// generic focus event is not guaranteed for this runtime class, so park
    /// the panel at the lifecycle boundary that AppKit always calls when
    /// another window takes key status.
    #[unsafe(method(resignKeyWindow))]
    fn resign_key_window(&self) {
      // SAFETY: this forwards the parameter-free NSWindow lifecycle method to
      // NSPanel before changing presentation-only window properties.
      unsafe {
        let () = msg_send![super(self), resignKeyWindow];
      }
      set_panel_parked(self);
    }
  }
);

fn set_panel_parked(ns_window: &NSWindow) {
  ns_window.setAlphaValue(0.0);
  ns_window.setIgnoresMouseEvents(true);
}

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

fn class_layouts_match(source: &AnyClass, target: &AnyClass) -> bool {
  source.instance_size() == target.instance_size()
}

fn make_nonactivating_panel(ns_window: &NSWindow) -> bool {
  let panel_class = ClipboardPanel::class();
  if ns_window.class() == panel_class {
    return true;
  }
  if !class_layouts_match(ns_window.class(), panel_class) {
    return false;
  }
  // SAFETY: the layout check proves the existing allocation covers the new
  // class. Its mirrored Bool occupies TaoWindow's `focusable` storage; the
  // clipboard window lives for the process lifetime, so it is not deallocated
  // through the replacement class.
  unsafe { AnyObject::set_class(ns_window, panel_class) };
  ns_window.setStyleMask(ns_window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
  // A full-screen app owns its own Space, and only a window marked
  // FullScreenAuxiliary may be ordered onto it; the floating window level
  // alone leaves the panel behind the full-screen app. CanJoinAllSpaces is
  // what tao maps `visible_on_all_workspaces` to, and setting the behaviour
  // replaces it wholesale, so keep it.
  ns_window.setCollectionBehavior(
    ns_window.collectionBehavior()
      | NSWindowCollectionBehavior::FullScreenAuxiliary
      | NSWindowCollectionBehavior::CanJoinAllSpaces,
  );
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
  true
}

fn configure_transient_overlay(ns_window: &NSWindow) {
  // Transient webviews must keep their original runtime class: WebKit and
  // AppKit register KVO observers against it and remove them during teardown.
  ns_window.setCollectionBehavior(
    ns_window.collectionBehavior()
      | NSWindowCollectionBehavior::FullScreenAuxiliary
      | NSWindowCollectionBehavior::CanJoinAllSpaces,
  );
  ns_window.setHidesOnDeactivate(false);
}

/// Prepares a disposable overlay without the persistent clipboard panel's
/// class conversion. The caller uses Tauri's ordinary show/focus lifecycle.
pub fn prepare_transient_overlay<R: Runtime>(window: &WebviewWindow<R>) {
  if let Some((_, ns_window)) = ns_window(window) {
    configure_transient_overlay(ns_window);
  }
}

/// Shows the window as the key window without activating the app (so the app
/// underneath stays frontmost), restoring it from a park first. Re-classes it
/// into a non-activating panel on first use. Returns false when the change
/// could not be applied (not on the main thread, or no window handle); the
/// caller then falls back to an activating show.
pub fn present_key_panel<R: Runtime>(window: &WebviewWindow<R>) -> bool {
  // This legacy conversion is restricted to the process-lifetime clipboard
  // window, which parks instead of closing. Disposable windows retain their
  // runtime class so AppKit/WebKit can unregister their observers safely.
  if window.label() != "clipboard" {
    return false;
  }
  let Some((main_thread, ns_window)) = ns_window(window) else {
    return false;
  };
  if !make_nonactivating_panel(ns_window) {
    return false;
  }
  // Cmd-H from an activating window (settings) hides the whole app, and
  // ordering a window front does not clear that.
  let app = NSApplication::sharedApplication(main_thread);
  if app.isHidden() {
    app.unhideWithoutActivation();
  }
  present_panel(ns_window);
  true
}

/// Restores a parked panel and makes it key, with the webview still its first
/// responder: a key panel whose first responder is the panel itself swallows
/// every keystroke until a mouse event over the webview hands them back.
fn present_panel(ns_window: &NSWindow) {
  ns_window.setAlphaValue(1.0);
  ns_window.setIgnoresMouseEvents(false);
  // Frames WebKit rendered while the window was parked never reach the
  // screen, and presenting alone commits nothing new, so the page shows its
  // pre-park frame until the next input. A visibility cycle on the content
  // view is a real view-state change for WebKit and resumes the commits.
  // Hiding the view that holds the first responder makes AppKit resign it to
  // the window, and neither unhiding nor becoming key hands it back, so it is
  // restored by hand. The cycle runs before the panel is key so the page
  // never sees a blur in the middle of an open.
  let first_responder = ns_window.firstResponder();
  if let Some(content) = ns_window.contentView() {
    content.setHidden(true);
    content.setHidden(false);
  }
  ns_window.makeFirstResponder(first_responder.as_deref());
  ns_window.makeKeyAndOrderFront(None);
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
  park_panel(ns_window);
  true
}

fn park_panel(ns_window: &NSWindow) {
  set_panel_parked(ns_window);
  // Ordering out is the only public way to give key status back. Ordering
  // straight back in keeps the page on screen; WebKit coalesces the two into
  // no visibility change.
  if ns_window.isKeyWindow() {
    ns_window.orderOut(None);
    ns_window.orderFront(None);
  }
}

/// Whether the persistent clipboard panel is currently presented. Native
/// presentation state is the source of truth because AppKit can park the panel
/// directly when an outside click makes it resign key status.
pub fn is_panel_presented<R: Runtime>(window: &WebviewWindow<R>) -> bool {
  let Some((_, ns_window)) = ns_window(window) else {
    return false;
  };
  ns_window.alphaValue() > 0.0 && !ns_window.ignoresMouseEvents()
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
