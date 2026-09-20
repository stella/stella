// A harness-free executable keeps AppKit on the process main thread. Include
// the production implementation to exercise its private window-configuration seam.
#[cfg(target_os = "macos")]
include!("../src/park.rs");

#[cfg(target_os = "macos")]
fn main() {
  use objc2::rc::{Retained, autoreleasepool};
  use objc2::runtime::{AnyObject, ClassBuilder};
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

    // The persistent clipboard panel owns dismissal at AppKit's key-window
    // lifecycle boundary. Generic framework focus events are not reliable
    // after the runtime NSWindow is converted into this NSPanel subclass.
    // SAFETY: initialized on the main thread and retained until after close;
    // disabling release-on-close prevents AppKit consuming that ownership.
    let panel: Retained<NSWindow> = unsafe {
      let mut tao_window = ClassBuilder::new(c"StellaTestTaoWindow", NSWindow::class())
        .expect("test Tao window class must only be registered once");
      tao_window.add_ivar::<Bool>(c"focusable");
      let tao_window = tao_window.register();
      let allocated: *mut AnyObject = msg_send![tao_window, alloc];
      let panel: *mut NSWindow = msg_send![
        allocated,
        initWithContentRect: frame,
        styleMask: NSWindowStyleMask::Borderless,
        backing: NSBackingStoreType::Buffered,
        defer: false,
      ];
      let panel = Retained::from_raw(panel).expect("test Tao window must initialize");
      panel.setReleasedWhenClosed(false);
      panel
    };
    let original_panel_class = panel.class();
    assert!(!class_layouts_match(
      NSWindow::class(),
      ClipboardPanel::class()
    ));
    assert!(class_layouts_match(
      original_panel_class,
      ClipboardPanel::class()
    ));

    assert!(make_nonactivating_panel(&panel));
    assert_eq!(panel.class(), ClipboardPanel::class());
    panel.setAlphaValue(1.0);
    panel.setIgnoresMouseEvents(false);
    panel.makeKeyAndOrderFront(None);
    assert!(panel.isKeyWindow());

    // Explicit dismissal (the path invoked after web content gives Escape to
    // the clipboard) uses the same native parking transition.
    set_panel_parked(&panel);
    assert_eq!(panel.alphaValue(), 0.0);
    assert!(panel.ignoresMouseEvents());

    panel.setAlphaValue(1.0);
    panel.setIgnoresMouseEvents(false);
    panel.makeKeyAndOrderFront(None);
    assert!(panel.isKeyWindow());

    // Clicking outside transfers key status and invokes the panel override.
    panel.resignKeyWindow();

    assert_eq!(panel.alphaValue(), 0.0);
    assert!(panel.ignoresMouseEvents());

    // Presenting the parked panel keeps the webview as first responder: the
    // content-view visibility cycle that resumes WebKit's commits makes AppKit
    // resign the responder inside it, and a panel that is key without the
    // webview as first responder swallows every keystroke.
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
    panel.setContentView(Some(&webview));
    assert!(panel.makeFirstResponder(Some(&webview)));
    // Every open after a dismissal (Escape, copy, outside click) walks the
    // same park → present round trip, so the responder must survive it
    // repeatedly, not only on a fresh panel.
    for _ in 0..3 {
      present_panel(&panel);
      assert!(panel.isKeyWindow());
      assert_eq!(panel.alphaValue(), 1.0);
      assert!(!panel.ignoresMouseEvents());
      assert!(std::ptr::eq::<objc2_app_kit::NSResponder>(
        panel.firstResponder().as_deref().unwrap(),
        &***webview,
      ));
      park_panel(&panel);
      assert_eq!(panel.alphaValue(), 0.0);
      assert!(panel.ignoresMouseEvents());
      assert!(std::ptr::eq::<objc2_app_kit::NSResponder>(
        panel.firstResponder().as_deref().unwrap(),
        &***webview,
      ));
    }

    panel.close();
    // The production panel lives as long as the process. Deallocating a
    // re-classed window that hosted a webview trips WebKit's observer
    // teardown (the reason transient overlays keep their class), so the
    // panel and its webview outlive the pool.
    std::mem::forget(webview);
    std::mem::forget(panel);
  });
}

#[cfg(not(target_os = "macos"))]
fn main() {}
