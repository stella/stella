use objc2::MainThreadMarker;
use objc2::runtime::AnyObject;
use objc2::{msg_send, sel};
use objc2_app_kit::NSWindow;
use tauri::{Runtime, WebviewWindow};

/// Makes the window fully transparent and click-through (parked) or restores
/// it. Returns false when the change could not be applied (not on the main
/// thread, or no window handle); the caller then falls back to hiding.
pub fn set_window_parked<R: Runtime>(window: &WebviewWindow<R>, parked: bool) -> bool {
  if MainThreadMarker::new().is_none() {
    return false;
  }
  let Ok(ns_window) = window.ns_window() else {
    return false;
  };
  if ns_window.is_null() {
    return false;
  }
  // SAFETY: `ns_window` returns a valid pointer to the live window's NSWindow
  // and the main thread was verified above.
  let ns_window = unsafe { &*ns_window.cast::<NSWindow>() };
  ns_window.setAlphaValue(if parked { 0.0 } else { 1.0 });
  ns_window.setIgnoresMouseEvents(parked);
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
