//! Opt-in local window metadata. Browser titles require separate consent:
//! captions can omit private-browsing markers.
use crate::{
  activity::{ActivityDetailsAccess, MAX_DETAIL_BYTES},
  foreground_app::{self, ForegroundApp},
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CapturedWindowPrivacy {
  #[default]
  Ordinary,
  Private,
}

#[derive(Default, PartialEq, Eq)]
pub struct WindowDetails {
  pub privacy: CapturedWindowPrivacy,
  pub window_title: Option<String>,
  pub document: Option<String>,
}

const BROWSER_FAMILIES: &[&str] = &[
  "safari", "chrome", "chromium", "msedge", "edge", "firefox", "brave", "arc",
];
const BROWSER_IDENTIFIER_PREFIXES: &[&str] = &[
  "com.apple.safari",
  "com.google.chrome",
  "org.chromium.chromium",
  "com.microsoft.edgemac",
  "org.mozilla.firefox",
  "com.brave.browser",
  "company.thebrowser.browser",
];
const PRIVATE_WINDOW_MARKERS: &[&str] = &[
  "private browsing",
  "incognito",
  "inprivate",
  "private window",
  "private tab",
  "private mode",
];

pub fn is_browser(identifier: &str, name: &str) -> bool {
  let identifier = identifier.to_lowercase();
  let name = name.to_lowercase();
  BROWSER_IDENTIFIER_PREFIXES
    .iter()
    .any(|prefix| identifier.starts_with(prefix))
    || BROWSER_FAMILIES.iter().any(|browser| {
      identifier
        .split(['.', '-', '_'])
        .any(|part| part == *browser)
        || name.split([' ', '-', '_']).any(|part| part == *browser)
    })
}

fn is_private_window(title: &str) -> bool {
  let title: String = title
    .chars()
    .filter(|character| !character.is_control())
    .flat_map(char::to_lowercase)
    .collect();
  PRIVATE_WINDOW_MARKERS
    .iter()
    .any(|marker| title.contains(marker))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowDetailsSource {
  Application,
  Browser,
}

impl WindowDetailsSource {
  pub(crate) fn for_app(identifier: &str, name: &str) -> Self {
    if is_browser(identifier, name) {
      Self::Browser
    } else {
      Self::Application
    }
  }
}

pub(crate) fn sanitized_details(
  title: Option<String>,
  document: Option<String>,
  source: WindowDetailsSource,
) -> WindowDetails {
  // Check the complete caption before truncating it: a privacy marker can be
  // beyond the storage limit. No URL is accepted as a document by the wrapper.
  if source == WindowDetailsSource::Browser
    && title.as_deref().is_some_and(is_private_window)
  {
    return WindowDetails {
      privacy: CapturedWindowPrivacy::Private,
      ..WindowDetails::default()
    };
  }
  WindowDetails {
    privacy: CapturedWindowPrivacy::Ordinary,
    window_title: title
      .as_deref()
      .and_then(|value| foreground_app::bounded_metadata(value, MAX_DETAIL_BYTES)),
    document: document
      .as_deref()
      .and_then(|value| foreground_app::bounded_metadata(value, MAX_DETAIL_BYTES)),
  }
}

pub fn capture(
  foreground: &ForegroundApp,
  browser_titles_enabled: bool,
) -> WindowDetails {
  let source = WindowDetailsSource::for_app(
    foreground.identifier.as_deref().unwrap_or(""),
    &foreground.name,
  );
  if !browser_titles_enabled
    && is_browser(
      foreground.identifier.as_deref().unwrap_or(""),
      &foreground.name,
    )
  {
    return WindowDetails::default();
  }
  #[cfg(target_os = "macos")]
  {
    let Some(details) =
      stella_desktop_macos::focused_window_details(foreground.process_id)
    else {
      return WindowDetails::default();
    };
    sanitized_details(details.window_title, details.document, source)
  }
  #[cfg(target_os = "windows")]
  {
    sanitized_details(
      stella_desktop_macos::focused_window_title(foreground.process_id),
      None,
      source,
    )
  }
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  WindowDetails::default()
}

pub fn access_status(enabled: bool) -> ActivityDetailsAccess {
  if !enabled {
    return ActivityDetailsAccess::Disabled;
  }
  #[cfg(target_os = "macos")]
  {
    if stella_desktop_macos::accessibility_trusted() {
      ActivityDetailsAccess::Ready
    } else {
      ActivityDetailsAccess::AccessibilityRequired
    }
  }
  #[cfg(target_os = "windows")]
  {
    ActivityDetailsAccess::Ready
  }
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  {
    ActivityDetailsAccess::Unavailable
  }
}

pub fn request_permission() {
  #[cfg(target_os = "macos")]
  {
    stella_desktop_macos::request_accessibility_permission();
  }
}

pub fn open_accessibility_settings() -> Result<(), String> {
  #[cfg(target_os = "macos")]
  {
    opener::open(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    )
    .map_err(|_| "activity accessibility settings could not be opened".to_string())
  }
  #[cfg(not(target_os = "macos"))]
  Err("activity accessibility settings are unavailable".to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn private_browser_markers_and_browser_families_are_data_driven() {
    for (browser, title) in [
      ("com.apple.Safari", "Matter — Private Browsing"),
      ("com.google.Chrome", "Matter — Incognito"),
      ("com.microsoft.edgemac", "Matter — InPrivate"),
      ("org.mozilla.firefox", "Matter — Private Window"),
      ("com.brave.Browser", "Matter — Private Window"),
      ("company.thebrowser.Browser", "Matter — Private Mode"),
    ] {
      let name = match browser {
        "com.microsoft.edgemac" => "Microsoft Edge",
        "company.thebrowser.Browser" => "Arc",
        _ => browser,
      };
      assert!(is_browser(browser, name));
      assert!(is_private_window(title));
      assert!(
        sanitized_details(
          Some(title.into()),
          Some("/private.docx".into()),
          WindowDetailsSource::Browser
        ) == WindowDetails {
          privacy: CapturedWindowPrivacy::Private,
          ..WindowDetails::default()
        }
      );
    }
    assert!(is_browser("com.google.Chrome", "Chrome"));
    assert!(!is_browser("com.microsoft.Word", "Word"));
    assert!(!is_private_window("Contract.docx — Word"));
    assert!(is_private_window("Private Incog\u{0}nito window"));
    assert!(is_private_window(&format!("{} Incognito", "x".repeat(600))));
  }

  #[test]
  fn renaming_known_browser_bundles_cannot_bypass_separate_consent() {
    for identifier in [
      "com.apple.Safari",
      "com.apple.SafariTechnologyPreview",
      "com.google.Chrome.canary",
      "org.chromium.Chromium",
      "com.microsoft.edgemac",
      "com.microsoft.edgemac.Beta",
      "org.mozilla.firefox",
      "org.mozilla.firefoxdeveloperedition",
      "com.brave.Browser.beta",
      "company.thebrowser.Browser",
      "chrome.exe",
      "msedge.exe",
      "firefox.exe",
      "brave.exe",
    ] {
      for name in ["Legal Browser", "Prohlížeč", "Private application"] {
        assert!(is_browser(identifier, name), "{identifier}");
      }
    }
  }

  #[test]
  fn ordinary_document_titles_with_private_browser_terms_are_retained() {
    let title = "Private Browsing memorandum — Word";
    let details = sanitized_details(
      Some(title.into()),
      Some("/docs/memorandum.docx".into()),
      WindowDetailsSource::Application,
    );
    assert_eq!(details.privacy, CapturedWindowPrivacy::Ordinary);
    assert_eq!(details.window_title.as_deref(), Some(title));
    assert_eq!(details.document.as_deref(), Some("/docs/memorandum.docx"));
    let browser = sanitized_details(
      Some(title.into()),
      Some("/docs/memorandum.docx".into()),
      WindowDetailsSource::Browser,
    );
    assert_eq!(browser.privacy, CapturedWindowPrivacy::Private);
    assert!(browser.window_title.is_none());
    assert!(browser.document.is_none());
  }

  #[test]
  fn details_strip_controls_and_are_bounded_on_utf8_boundaries() {
    let details = sanitized_details(
      Some(format!("\n{}\u{0} ", "ž".repeat(400))),
      Some(" /docs/contract\u{7}.docx ".into()),
      WindowDetailsSource::Application,
    );
    assert_eq!(
      details.window_title.as_ref().unwrap().len(),
      MAX_DETAIL_BYTES
    );
    assert_eq!(details.document.as_deref(), Some("/docs/contract.docx"));
    assert_eq!(access_status(false), ActivityDetailsAccess::Disabled);
  }
}
