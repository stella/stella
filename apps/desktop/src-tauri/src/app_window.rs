//! The one constructor for webview windows, and the owner of how open
//! windows show the app.
//!
//! Every window shows a page bundled with the app and stays on the app's own
//! origin: navigation to any other origin is cancelled and new windows are
//! refused, so a page cannot hand anything it renders to another origin by
//! loading a URL. `clippy.toml` disallows the raw constructor everywhere else.
//!
//! On macOS stella lives in the menu bar. While a window people work in is
//! open (Settings, Transcribe, Activity, a dialog) it also shows in the Dock
//! and the app switcher like any app, and clicking its Dock icon brings that
//! window back; panels that float over another app's work never do.
//! `clippy.toml` disallows changing the activation policy anywhere else.

use std::collections::BTreeSet;
use std::sync::{Mutex, PoisonError};

use tauri::{
  AppHandle, Manager, Runtime, Url, Webview, WebviewUrl, Window, WindowEvent,
  webview::{NewWindowResponse, PageLoadEvent, PageLoadPayload, WebviewWindowBuilder},
};

/// What a window is to the person using it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowKind {
  /// A window people work in and come back to: while one is open, stella
  /// shows in the Dock and the app switcher.
  App,
  /// A popup or panel over another app's work (the clipboard, dictation's
  /// notice, preview and fix panel, the accessibility guide). It never puts
  /// stella in the Dock.
  Panel,
}

/// Host the custom protocol is served from where the platform maps it onto
/// http(s) (Windows, Android).
const CUSTOM_PROTOCOL_HTTP_HOST: &str = "tauri.localhost";

pub(crate) fn builder<'a, R: Runtime, M: Manager<R>>(
  manager: &'a M,
  label: &str,
  page: impl Into<std::path::PathBuf>,
  kind: WindowKind,
) -> WebviewWindowBuilder<'a, R, M> {
  if let Some(windows) = manager.try_state::<AppWindows>() {
    windows.update(|open| open.built(label, kind));
  }
  let dev_origin = dev_origin(manager);
  #[allow(
    clippy::disallowed_methods,
    reason = "the owner: every window gets the origin lock below"
  )]
  WebviewWindowBuilder::new(manager, label, WebviewUrl::App(page.into()))
    .on_navigation(move |url| is_app_origin(url, dev_origin.as_ref()))
    .on_new_window(|_, _| NewWindowResponse::Deny)
}

/// The dev server a development build loads its pages from.
pub(crate) fn dev_origin<R: Runtime, M: Manager<R>>(manager: &M) -> Option<Url> {
  tauri::is_dev()
    .then(|| manager.config().build.dev_url.clone())
    .flatten()
}

/// The bundled pages' origin: the custom protocol, or the dev server in a
/// development build.
pub(crate) fn is_app_origin(url: &Url, dev_origin: Option<&Url>) -> bool {
  match url.scheme() {
    "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
    "http" | "https" if url.host_str() == Some(CUSTOM_PROTOCOL_HTTP_HOST) => {
      url.port().is_none()
    }
    _ => dev_origin.is_some_and(|dev| dev.origin() == url.origin()),
  }
}

/// Whether the app shows in the Dock and the app switcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presence {
  /// In the Dock and the app switcher, like any app.
  Dock,
  /// Only the menu bar icon.
  MenuBar,
}

/// The presence a change in the number of open app windows asks for: the
/// first one puts stella in the Dock, closing the last takes it out.
fn presence_change(before: usize, after: usize) -> Option<Presence> {
  match (before, after) {
    (0, 1..) => Some(Presence::Dock),
    (1.., 0) => Some(Presence::MenuBar),
    _ => None,
  }
}

/// The app windows that are open, by label.
#[derive(Debug, Default)]
struct OpenAppWindows {
  /// Labels last built as app windows; a panel's label never counts.
  app_labels: BTreeSet<String>,
  /// The open app windows, the one focused most recently last.
  open: Vec<String>,
}

impl OpenAppWindows {
  fn built(&mut self, label: &str, kind: WindowKind) {
    match kind {
      WindowKind::App => {
        self.app_labels.insert(label.to_string());
      }
      WindowKind::Panel => {
        self.app_labels.remove(label);
      }
    }
  }

  /// The window's page started loading, so the window exists. A window
  /// whose build failed never gets here and never counts.
  fn opened(&mut self, label: &str) -> Option<Presence> {
    if !self.app_labels.contains(label) || self.open.iter().any(|open| open == label) {
      return None;
    }
    let before = self.open.len();
    self.open.push(label.to_string());
    presence_change(before, self.open.len())
  }

  fn focused(&mut self, label: &str) -> Option<Presence> {
    if !self.app_labels.contains(label) {
      return None;
    }
    let before = self.open.len();
    self.open.retain(|open| open != label);
    self.open.push(label.to_string());
    presence_change(before, self.open.len())
  }

  fn closed(&mut self, label: &str) -> Option<Presence> {
    let before = self.open.len();
    self.open.retain(|open| open != label);
    self.app_labels.remove(label);
    presence_change(before, self.open.len())
  }

  #[cfg(any(target_os = "macos", test))]
  fn most_recent(&self) -> Option<&str> {
    self.open.last().map(String::as_str)
  }
}

/// The open app windows; managed once for the app's lifetime.
#[derive(Default)]
pub(crate) struct AppWindows(Mutex<OpenAppWindows>);

impl AppWindows {
  fn update<T>(&self, apply: impl FnOnce(&mut OpenAppWindows) -> T) -> T {
    apply(&mut self.0.lock().unwrap_or_else(PoisonError::into_inner))
  }
}

fn apply<R: Runtime>(
  app: &AppHandle<R>,
  label: &str,
  change: impl FnOnce(&mut OpenAppWindows, &str) -> Option<Presence>,
) {
  let Some(windows) = app.try_state::<AppWindows>() else {
    return;
  };
  if let Some(presence) = windows.update(|open| change(open, label)) {
    show_presence(app, presence);
  }
}

/// Every webview's page load, from the app's page-load hook.
pub(crate) fn page_loading<R: Runtime>(
  webview: &Webview<R>,
  payload: &PageLoadPayload<'_>,
) {
  if payload.event() == PageLoadEvent::Started {
    apply(
      webview.app_handle(),
      webview.label(),
      OpenAppWindows::opened,
    );
  }
}

/// Every window's events, from the app's window-event hook.
pub(crate) fn window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
  match event {
    WindowEvent::Focused(true) => {
      apply(window.app_handle(), window.label(), OpenAppWindows::focused);
    }
    WindowEvent::Destroyed => {
      apply(window.app_handle(), window.label(), OpenAppWindows::closed);
    }
    _ => {}
  }
}

/// The Dock icon was clicked: the app window used last comes to the front.
#[cfg(target_os = "macos")]
pub(crate) fn reopen<R: Runtime>(app: &AppHandle<R>) {
  let Some(label) = app
    .try_state::<AppWindows>()
    .and_then(|windows| windows.update(|open| open.most_recent().map(str::to_string)))
  else {
    return;
  };
  let Some(window) = app.get_webview_window(&label) else {
    return;
  };
  crate::logging::best_effort(window.unminimize(), "window could not be restored");
  crate::logging::best_effort(window.show(), "window could not be shown");
  crate::logging::best_effort(window.set_focus(), "window could not be focused");
}

/// stella starts in the menu bar only; an app window opening puts it in the
/// Dock.
#[cfg(target_os = "macos")]
pub(crate) fn start_in_menu_bar<R: Runtime>(app: &mut tauri::App<R>) {
  #[allow(
    clippy::disallowed_methods,
    reason = "the owner: open app windows decide the Dock presence"
  )]
  app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

#[cfg(target_os = "macos")]
fn show_presence<R: Runtime>(app: &AppHandle<R>, presence: Presence) {
  let handle = app.clone();
  let switched = app.run_on_main_thread(move || match presence {
    Presence::Dock => {
      #[allow(
        clippy::disallowed_methods,
        reason = "the owner: open app windows decide the Dock presence"
      )]
      let joined = handle.set_activation_policy(tauri::ActivationPolicy::Regular);
      crate::logging::best_effort(joined, "app could not join the Dock");
    }
    Presence::MenuBar => {
      // Leaving the Dock can hand activation to another app than the one
      // the person is in: whoever is frontmost now stays frontmost.
      let frontmost = objc2_app_kit::NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .filter(|frontmost| {
          u32::try_from(frontmost.processIdentifier()).ok() != Some(std::process::id())
        });
      #[allow(
        clippy::disallowed_methods,
        reason = "the owner: open app windows decide the Dock presence"
      )]
      let left = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
      crate::logging::best_effort(left, "app could not leave the Dock");
      if let Some(frontmost) = frontmost
        && !frontmost
          .activateWithOptions(objc2_app_kit::NSApplicationActivationOptions(0))
      {
        tracing::debug!("the frontmost app was not kept in front");
      }
    }
  });
  crate::logging::best_effort(switched, "Dock presence was not updated");
}

/// Other platforms list every window in their own taskbar already.
#[cfg(not(target_os = "macos"))]
fn show_presence<R: Runtime>(_app: &AppHandle<R>, _presence: Presence) {}

#[cfg(test)]
mod tests {
  use super::*;

  fn url(raw: &str) -> Url {
    Url::parse(raw).unwrap()
  }

  #[test]
  fn bundled_pages_are_the_app_origin() {
    for raw in [
      "tauri://localhost/index.html",
      "tauri://localhost/pdf-sign-dialog.html#payload",
      "http://tauri.localhost/index.html",
      "https://tauri.localhost/takeover-dialog.html",
    ] {
      assert!(is_app_origin(&url(raw), None), "{raw}");
    }
  }

  #[test]
  fn every_other_origin_is_refused() {
    for raw in [
      "https://my.stll.app/",
      "https://example.org/?q=text",
      "http://localhost:3000/",
      "http://127.0.0.1:5177/",
      "tauri://localhost.example.org/",
      "tauri://localhost:8080/",
      "http://tauri.localhost.example.org/",
      "http://tauri.localhost:8080/",
      "https://user@tauri.example.org/",
      "file:///etc/hosts",
      "data:text/html,<p>page</p>",
      "javascript:void(0)",
      "about:blank",
      "blob:https://example.org/uuid",
      "mailto:someone@example.org",
      "stella://open",
    ] {
      assert!(!is_app_origin(&url(raw), None), "{raw}");
    }
  }

  #[test]
  fn the_dev_server_is_the_app_origin_only_when_configured() {
    let dev = url("http://127.0.0.1:5177");
    assert!(is_app_origin(
      &url("http://127.0.0.1:5177/index.html"),
      Some(&dev)
    ));
    assert!(!is_app_origin(&url("http://127.0.0.1:5178/"), Some(&dev)));
    assert!(!is_app_origin(&url("http://localhost:5177/"), Some(&dev)));
    assert!(!is_app_origin(&url("https://127.0.0.1:5177/"), Some(&dev)));
    assert!(!is_app_origin(&url("http://127.0.0.1:5177/"), None));
  }

  #[test]
  fn the_first_app_window_joins_the_dock_and_the_last_one_leaves_it() {
    assert_eq!(presence_change(0, 1), Some(Presence::Dock));
    assert_eq!(presence_change(1, 2), None);
    assert_eq!(presence_change(2, 1), None);
    assert_eq!(presence_change(1, 0), Some(Presence::MenuBar));
    assert_eq!(presence_change(0, 0), None);
    assert_eq!(presence_change(3, 3), None);
  }

  #[test]
  fn app_windows_keep_stella_in_the_dock_until_the_last_one_closes() {
    let mut windows = OpenAppWindows::default();
    windows.built("main", WindowKind::App);
    windows.built("transcribe", WindowKind::App);
    assert_eq!(windows.opened("main"), Some(Presence::Dock));
    assert_eq!(
      windows.opened("main"),
      None,
      "a reload is not a second window"
    );
    assert_eq!(windows.opened("transcribe"), None);
    assert_eq!(windows.closed("main"), None);
    assert_eq!(windows.closed("transcribe"), Some(Presence::MenuBar));
    assert_eq!(windows.closed("transcribe"), None, "a window closes once");
  }

  #[test]
  fn panels_never_put_stella_in_the_dock() {
    let mut windows = OpenAppWindows::default();
    windows.built("clipboard", WindowKind::Panel);
    windows.built("dictation-preview", WindowKind::Panel);
    assert_eq!(windows.opened("clipboard"), None);
    assert_eq!(windows.focused("clipboard"), None);
    assert_eq!(windows.opened("dictation-preview"), None);
    assert_eq!(windows.closed("clipboard"), None);
    assert_eq!(windows.most_recent(), None);

    // A panel open beside an app window does not hold stella in the Dock.
    windows.built("main", WindowKind::App);
    assert_eq!(windows.opened("main"), Some(Presence::Dock));
    assert_eq!(windows.opened("dictation-preview"), None);
    assert_eq!(windows.closed("main"), Some(Presence::MenuBar));
  }

  #[test]
  fn a_window_whose_build_failed_never_counts() {
    let mut windows = OpenAppWindows::default();
    windows.built("activity", WindowKind::App);
    assert_eq!(windows.most_recent(), None);
    assert_eq!(windows.closed("activity"), None);
    assert_eq!(windows.opened("activity"), None, "its label is forgotten");
  }

  #[test]
  fn the_dock_icon_brings_back_the_window_focused_last() {
    let mut windows = OpenAppWindows::default();
    for label in ["main", "transcribe", "activity"] {
      windows.built(label, WindowKind::App);
      windows.opened(label);
    }
    assert_eq!(windows.most_recent(), Some("activity"));
    assert_eq!(windows.focused("transcribe"), None);
    assert_eq!(windows.most_recent(), Some("transcribe"));
    windows.closed("transcribe");
    assert_eq!(windows.most_recent(), Some("activity"));
    windows.focused("main");
    windows.closed("activity");
    assert_eq!(windows.most_recent(), Some("main"));
  }
}
