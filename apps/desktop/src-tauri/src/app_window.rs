//! The one constructor for webview windows.
//!
//! Every window shows a page bundled with the app and stays on the app's own
//! origin: navigation to any other origin is cancelled and new windows are
//! refused, so a page cannot hand anything it renders to another origin by
//! loading a URL. `clippy.toml` disallows the raw constructor everywhere else.

use tauri::{
  Manager, Runtime, Url, WebviewUrl,
  webview::{NewWindowResponse, WebviewWindowBuilder},
};

/// Host the custom protocol is served from where the platform maps it onto
/// http(s) (Windows, Android).
const CUSTOM_PROTOCOL_HTTP_HOST: &str = "tauri.localhost";

pub(crate) fn builder<'a, R: Runtime, M: Manager<R>>(
  manager: &'a M,
  label: &str,
  page: impl Into<std::path::PathBuf>,
) -> WebviewWindowBuilder<'a, R, M> {
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
}
