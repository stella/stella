// A harness-free executable keeps AppKit on the process main thread. Include
// the production implementation to exercise its private window-configuration seam.
#[cfg(target_os = "macos")]
include!("../src/park.rs");

#[cfg(target_os = "macos")]
fn main() {
  use objc2::rc::autoreleasepool;
  use objc2_app_kit::NSBackingStoreType;
  use objc2_foundation::{NSPoint, NSRect, NSSize};
  use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

  autoreleasepool(|_| {
    let main_thread = MainThreadMarker::new().expect("AppKit requires the main thread");
    let _application = NSApplication::sharedApplication(main_thread);
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(100.0, 100.0));
    for _ in 0..3 {
      // SAFETY: initialized on the main thread and retained until after close;
      // disabling release-on-close prevents AppKit consuming that ownership.
      let window = unsafe {
        let window = NSWindow::initWithContentRect_styleMask_backing_defer(
          NSWindow::alloc(main_thread),
          frame,
          NSWindowStyleMask::Borderless,
          NSBackingStoreType::Buffered,
          false,
        );
        window.setReleasedWhenClosed(false);
        window
      };
      // SAFETY: the configuration and webview are initialized and retained on
      // the main thread. The empty webview never loads a URL or user data.
      let webview = unsafe {
        let configuration = WKWebViewConfiguration::new(main_thread);
        WKWebView::initWithFrame_configuration(
          WKWebView::alloc(main_thread),
          frame,
          &configuration,
        )
      };
      window.setContentView(Some(&webview));
      let observed_class = window.class();
      for _ in 0..3 {
        configure_transient_overlay(&window);
        assert_eq!(window.class(), observed_class);
        assert!(
          window
            .collectionBehavior()
            .contains(NSWindowCollectionBehavior::FullScreenAuxiliary)
        );
        assert!(
          window
            .collectionBehavior()
            .contains(NSWindowCollectionBehavior::CanJoinAllSpaces)
        );
        assert!(std::ptr::eq::<objc2_app_kit::NSView>(
          window.contentView().as_deref().unwrap(),
          &**webview,
        ));
      }
      // WebKit unregisters its real contentLayoutRect observer here, exactly
      // as Wry does when dropping a closed registry webview. No UI is shown.
      webview.removeFromSuperview();
      assert!(webview.window().is_none());
      window.close();
    }
  });
}

#[cfg(not(target_os = "macos"))]
fn main() {}

