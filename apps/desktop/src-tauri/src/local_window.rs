//! Proof that an IPC call came from a local-only feature's own window.
//!
//! Local-only data (clipboard history, the activity timeline) reaches a
//! webview only through accessors that take a [`LocalCaller`]. The proof
//! requires both one of the feature's window labels and the bundled app
//! origin, so another window or a remote page cannot read the data even if a
//! capability grants it the command.

use std::marker::PhantomData;
use tauri::{
  AppHandle, Manager, Runtime,
  ipc::{CommandArg, CommandItem, InvokeError},
};

/// A local-only feature whose data is served to its windows only. Adding a
/// feature means one implementation here plus one entry in
/// `tests/local-only-features.ts`.
pub trait LocalWindowFeature {
  const WINDOW_LABELS: &'static [&'static str];
  const REFUSAL: &'static str;

  /// Whether the feature exists right now; a feature that can be switched off
  /// refuses every call while it is off.
  fn is_available<R: Runtime>(_app: &AppHandle<R>) -> bool {
    true
  }
}

pub struct LocalCaller<F>(PhantomData<F>);

impl<F: LocalWindowFeature> LocalCaller<F> {
  fn verify(
    label: &str,
    url: Option<&tauri::Url>,
    dev_origin: Option<&tauri::Url>,
  ) -> Option<Self> {
    let feature_window = F::WINDOW_LABELS.contains(&label);
    let app_origin =
      url.is_some_and(|url| crate::app_window::is_app_origin(url, dev_origin));
    (feature_window && app_origin).then_some(Self(PhantomData))
  }

  #[cfg(test)]
  pub(crate) fn for_test() -> Self {
    Self(PhantomData)
  }
}

impl<'de, R: Runtime, F: LocalWindowFeature> CommandArg<'de, R> for LocalCaller<F> {
  fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
    let webview = command.message.webview();
    if !F::is_available(webview.app_handle()) {
      return Err(InvokeError::from(F::REFUSAL));
    }
    let url = webview.url().ok();
    let dev_origin = crate::app_window::dev_origin(&webview);
    Self::verify(webview.label(), url.as_ref(), dev_origin.as_ref())
      .ok_or_else(|| InvokeError::from(F::REFUSAL))
  }
}

pub struct ClipboardWindows;

impl LocalWindowFeature for ClipboardWindows {
  const WINDOW_LABELS: &'static [&'static str] = &[
    crate::clipboard_window::CLIPBOARD_WINDOW_LABEL,
    crate::clipboard_window::CLIPBOARD_EDITOR_WINDOW_LABEL,
  ];
  const REFUSAL: &'static str = "clipboard history is not available here";
}

pub type ClipboardCaller = LocalCaller<ClipboardWindows>;

#[cfg(test)]
mod tests {
  use super::*;

  const OTHER_LABELS: [&str; 7] = [
    "main",
    "pdf-sign-dialog",
    "selfhost-connect-dialog",
    "takeover-dialog",
    "clipboard ",
    "Clipboard",
    "",
  ];

  fn assert_only_feature_windows_on_the_app_origin<F: LocalWindowFeature>() {
    let page = tauri::Url::parse("tauri://localhost/index.html").unwrap();
    let dev = tauri::Url::parse("http://127.0.0.1:5177").unwrap();
    let dev_page = tauri::Url::parse("http://127.0.0.1:5177/index.html").unwrap();
    assert!(!F::WINDOW_LABELS.is_empty());
    for label in F::WINDOW_LABELS {
      assert!(LocalCaller::<F>::verify(label, Some(&page), None).is_some());
      assert!(LocalCaller::<F>::verify(label, Some(&dev_page), Some(&dev)).is_some());
      assert!(LocalCaller::<F>::verify(label, Some(&dev_page), None).is_none());
      assert!(LocalCaller::<F>::verify(label, None, None).is_none());
      for remote in [
        "https://my.stll.app/",
        "https://example.org/index.html",
        "http://localhost:3000/",
      ] {
        let remote = tauri::Url::parse(remote).unwrap();
        assert!(LocalCaller::<F>::verify(label, Some(&remote), Some(&dev)).is_none());
      }
    }
    for label in OTHER_LABELS
      .iter()
      .filter(|label| !F::WINDOW_LABELS.contains(label))
    {
      assert!(LocalCaller::<F>::verify(label, Some(&page), None).is_none());
    }
  }

  #[test]
  fn clipboard_callers_are_clipboard_windows_on_the_app_origin() {
    assert_only_feature_windows_on_the_app_origin::<ClipboardWindows>();
  }
}
