// A harness-free executable keeps AppKit on the process main thread. Include
// the production implementation to exercise its private window-configuration seam.
#[cfg(target_os = "macos")]
include!("../src/park.rs");
#[cfg(target_os = "macos")]
#[path = "../src/activation.rs"]
mod activation;

/// Dispatches AppKit events until `condition` holds: activation changes reach
/// the process as events, and the harness has no running event loop. False
/// when it still does not hold after a bounded number of event waits.
#[cfg(target_os = "macos")]
fn pump_until(application: &NSApplication, condition: impl Fn() -> bool) -> bool {
  use objc2_app_kit::NSEventMask;
  use objc2_foundation::{NSDate, NSDefaultRunLoopMode};

  const EVENT_WAITS: usize = 200;
  const EVENT_WAIT_SECONDS: f64 = 0.05;

  for _ in 0..EVENT_WAITS {
    if condition() {
      return true;
    }
    let until = NSDate::dateWithTimeIntervalSinceNow(EVENT_WAIT_SECONDS);
    // SAFETY: NSDefaultRunLoopMode is an immutable Foundation constant.
    let mode = unsafe { NSDefaultRunLoopMode };
    if let Some(event) = application.nextEventMatchingMask_untilDate_inMode_dequeue(
      NSEventMask::Any,
      Some(&until),
      mode,
      true,
    ) {
      application.sendEvent(&event);
    }
  }
  condition()
}

/// Requests activation for `editor` and reports whether the system granted it.
/// From macOS 14 activation is cooperative and a request made without the
/// user's own action may be declined, which this harness cannot supply, so a
/// decline there is reported and the caller skips what depends on it. Below
/// macOS 14 activation ignores other apps and must succeed.
#[cfg(target_os = "macos")]
fn activated(application: &NSApplication, editor: &NSWindow) -> bool {
  activation::activate_with_key_window(application, editor);
  if pump_until(application, || {
    application.isActive() && editor.isKeyWindow()
  }) {
    return true;
  }
  assert!(
    objc2::available!(macos = 14.0),
    "below macOS 14 the editor must be the key window of the active app"
  );
  eprintln!(
    "the system declined activation without a user action; activation is not observed"
  );
  false
}

#[cfg(target_os = "macos")]
fn main() {
  use activation::{ActivationReturn, return_activation};
  use objc2::rc::{Retained, autoreleasepool};
  use objc2::runtime::{AnyClass, AnyObject, ClassBuilder};
  use objc2_app_kit::{
    NSApplicationActivationPolicy, NSBackingStoreType, NSRunningApplication,
    NSWorkspace,
  };
  use objc2_foundation::{NSPoint, NSRect, NSSize};
  use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

  autoreleasepool(|_| {
    let main_thread = MainThreadMarker::new().expect("AppKit requires the main thread");
    let application = NSApplication::sharedApplication(main_thread);
    assert!(application.setActivationPolicy(NSApplicationActivationPolicy::Regular));
    let own_process_id = NSRunningApplication::currentApplication().processIdentifier();
    // The app the user was in before stella's editor opened. Production
    // records it the same way, before activating; the harness can observe a
    // hand-back only when another app is frontmost as it starts.
    let previous_app = NSWorkspace::sharedWorkspace()
      .frontmostApplication()
      .filter(|app| app.processIdentifier() != own_process_id);
    // This harness pumps events itself instead of calling run(), which
    // normally completes AppKit's launch before starting its event loop.
    application.finishLaunching();
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

    // The editor is an ordinary window that activates the app: WebKit draws
    // the caret and focus ring only in the active app's key window, and a
    // non-activating panel would leave the app inactive while it is key.
    // SAFETY: initialized on the main thread and retained until after close;
    // disabling release-on-close prevents AppKit consuming that ownership.
    let editor = unsafe {
      let editor = NSWindow::initWithContentRect_styleMask_backing_defer(
        NSWindow::alloc(main_thread),
        frame,
        NSWindowStyleMask::Titled
          | NSWindowStyleMask::Closable
          | NSWindowStyleMask::Resizable,
        NSBackingStoreType::Buffered,
        false,
      );
      editor.setReleasedWhenClosed(false);
      editor
    };
    let editor_class = editor.class();
    let mut activation_observed = true;
    for _ in 0..3 {
      // Production opens the editor while another app is active.
      application.deactivate();
      assert!(
        pump_until(&application, || !application.isActive()),
        "the editor must open with the app inactive"
      );

      if !activated(&application, &editor) {
        activation_observed = false;
        editor.orderOut(None);
        break;
      }
      assert!(std::ptr::eq::<NSWindow>(
        application.keyWindow().as_deref().unwrap(),
        &*editor,
      ));
      // Presenting keeps the runtime class WebKit registers its observers
      // against, unlike the clipboard panel's conversion.
      assert_eq!(editor.class(), editor_class);

      match &previous_app {
        Some(previous) => {
          assert_eq!(
            return_activation(previous.processIdentifier()),
            ActivationReturn::Requested
          );
          editor.orderOut(None);
          assert!(
            pump_until(&application, || previous.isActive()
              && !application.isActive()),
            "closing the editor must reactivate the app frontmost before it opened"
          );
        }
        None => {
          eprintln!(
            "no other app was frontmost; the activation hand-back is not observed"
          );
          editor.orderOut(None);
        }
      }
    }

    // The hand-back never takes activation from wherever the user went.
    application.deactivate();
    assert!(pump_until(&application, || !application.isActive()));
    assert_eq!(
      return_activation(own_process_id),
      ActivationReturn::NotActive
    );

    // An app that is no longer running cannot be reactivated, and stella
    // stays active. macOS process identifiers stay far below i32::MAX, so
    // it names no running app.
    if activation_observed && activated(&application, &editor) {
      assert_eq!(
        return_activation(i32::MAX),
        ActivationReturn::PreviousAppGone
      );
      assert!(application.isActive());
    }
    editor.orderOut(None);
    editor.close();

    // Activating the app for the editor leaves the clipboard panel's
    // non-activating presentation as it was. AppKit may start observing the
    // panel by then; key-value observing swaps its runtime class for an
    // `NSKVONotifying_` subclass and answers `-class` with the class it was,
    // so the panel's own answer is what still has to be the clipboard panel.
    // SAFETY: `-class` takes no arguments and returns the receiver's class;
    // the panel is retained and used on the main thread.
    let reported_panel_class: &AnyClass = unsafe { msg_send![&*panel, class] };
    assert_eq!(reported_panel_class, ClipboardPanel::class());
    assert!(
      panel
        .styleMask()
        .contains(NSWindowStyleMask::NonactivatingPanel)
    );
    assert!(panel.collectionBehavior().contains(
      NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::CanJoinAllSpaces
    ));
    assert!(!panel.hidesOnDeactivate());

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
