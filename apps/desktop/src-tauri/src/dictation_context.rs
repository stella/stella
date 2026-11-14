//! What AI cleanup is told about where a dictation goes, so it writes in
//! that app's register.
//!
//! The one owner of that context. The kind of app (email, chat, document,
//! browser, code, terminal or other) comes from the same focused-app lookup
//! that guards typing and goes with every cleanup. It is separate from
//! `dictation_format::AppClass`, which decides keystrokes: a mail app and a
//! word processor type alike but are written to differently. Two more pieces
//! are read only when the speaker turned each on: the focused window's title,
//! and the text right before the cursor (macOS only, through Accessibility).
//! Both are read when the shortcut is pressed, bounded to the contract's
//! lengths, and dropped when they cannot be read: cleanup then goes ahead
//! without them. Nothing here is logged or stored.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine send context")
)]

use serde::Serialize;

use crate::{
  dictation_cleanup,
  dictation_focus::FocusTarget,
  dictation_format::{self, AppClass},
};

/// The kind of app a dictation goes to, as the cleanup contract names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppKind {
  Email,
  Chat,
  Document,
  Browser,
  Code,
  Terminal,
  Other,
}

/// Mail apps, by bundle identifier on macOS and executable on Windows,
/// lowercased. Webmail is a page like any other, so it stays `Browser`.
const EMAIL_APPS: &[&str] = &[
  "com.apple.mail",
  "com.microsoft.outlook",
  "com.readdle.smartemail-mac",
  "com.readdle.sparkdesktop",
  "it.bloop.airmail2",
  "org.mozilla.thunderbird",
  "outlook.exe",
  "olk.exe",
  "thunderbird.exe",
];
/// Word processors. An online document cannot be told apart from another
/// page, so it stays `Browser`.
const DOCUMENT_APPS: &[&str] = &[
  "com.microsoft.word",
  "com.apple.iwork.pages",
  "com.apple.textedit",
  "org.libreoffice.script",
  "winword.exe",
];
/// Code editors and IDEs. They type as terminals (`AppClass::Terminal`),
/// since their integrated terminal can have focus.
const CODE_APPS: &[&str] = &[
  "com.microsoft.vscode",
  "com.microsoft.vscodeinsiders",
  "com.vscodium",
  "com.todesktop.230313mzl4w4u92",
  "com.google.android.studio",
  "code.exe",
  "code - insiders.exe",
  "vscodium.exe",
  "cursor.exe",
  "zed.exe",
  "idea64.exe",
  "pycharm64.exe",
  "webstorm64.exe",
  "goland64.exe",
  "rider64.exe",
  "clion64.exe",
  "phpstorm64.exe",
  "rubymine64.exe",
  "datagrip64.exe",
  "rustrover64.exe",
  "studio64.exe",
];
/// Identifier prefixes of every Zed channel and every JetBrains IDE.
const CODE_PREFIXES: &[&str] = &["dev.zed.", "com.jetbrains."];

impl AppKind {
  /// The kind of the app with this identifier; `Other` when unknown or
  /// unread. Chats, browsers and terminals are the ones `AppClass` knows.
  pub fn of(identifier: Option<&str>) -> Self {
    let Some(identifier) = identifier.map(|value| value.trim().to_lowercase()) else {
      return Self::Other;
    };
    let listed = |apps: &[&str]| apps.contains(&identifier.as_str());
    if listed(EMAIL_APPS) {
      Self::Email
    } else if listed(DOCUMENT_APPS) {
      Self::Document
    } else if listed(CODE_APPS)
      || CODE_PREFIXES
        .iter()
        .any(|prefix| identifier.starts_with(prefix))
    {
      Self::Code
    } else {
      match AppClass::of(Some(&identifier)) {
        AppClass::Chat => Self::Chat,
        AppClass::Browser | AppClass::PlainBrowser => Self::Browser,
        AppClass::Terminal => Self::Terminal,
        // Notes and the other rich editors not listed above.
        AppClass::Rich => Self::Document,
        AppClass::Other => Self::Other,
      }
    }
  }
}

/// Which of the opt-in pieces the speaker shares with cleanup.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sharing {
  pub window_title: bool,
  pub text_before_cursor: bool,
}

/// The `context` field of a cleanup request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupContext {
  pub app_kind: AppKind,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub window_title: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub text_before_cursor: Option<String>,
}

impl CleanupContext {
  /// The kind of the app focused at the press, and nothing else.
  pub fn kind_only(focus: Option<&FocusTarget>) -> Self {
    Self {
      app_kind: AppKind::of(focus.and_then(|target| target.identifier.as_deref())),
      window_title: None,
      text_before_cursor: None,
    }
  }
}

/// The context of the app focused at the press: its kind, and what
/// `sharing` allows when it can be read.
pub fn read(focus: Option<&FocusTarget>, sharing: Sharing) -> CleanupContext {
  let mut context = CleanupContext::kind_only(focus);
  let Some(target) = focus else {
    return context;
  };
  if sharing.window_title {
    context.window_title = window_title(target.process_id()).and_then(|title| {
      bounded_title(&title, dictation_cleanup::context_limits().window_title)
    });
  }
  if sharing.text_before_cursor {
    context.text_before_cursor =
      text_before_cursor(target.process_id()).and_then(|text| {
        bounded_text_before_cursor(
          &text,
          dictation_cleanup::context_limits().text_before_cursor,
        )
      });
  }
  context
}

/// Whether this platform can read the text before the cursor at all. Where
/// it cannot, the switch is not offered.
pub const TEXT_BEFORE_CURSOR_SUPPORTED: bool = cfg!(target_os = "macos");

/// The title of a private browser window is never shared: it is withheld
/// the way the activity timeline withholds it.
fn shareable_title(title: Option<String>) -> Option<String> {
  let details = crate::activity_details::sanitized_details(title, None);
  match details.privacy {
    crate::activity_details::CapturedWindowPrivacy::Ordinary => details.window_title,
    crate::activity_details::CapturedWindowPrivacy::Private => None,
  }
}

#[cfg(target_os = "macos")]
fn window_title(process_id: i64) -> Option<String> {
  let process_id = i32::try_from(process_id).ok()?;
  shareable_title(
    stella_desktop_macos::focused_window_details(process_id)?.window_title,
  )
}

#[cfg(target_os = "windows")]
fn window_title(process_id: i64) -> Option<String> {
  let process_id = u32::try_from(process_id).ok()?;
  shareable_title(stella_desktop_macos::focused_window_title(process_id))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn window_title(_process_id: i64) -> Option<String> {
  None
}

#[cfg(target_os = "macos")]
fn text_before_cursor(process_id: i64) -> Option<String> {
  let process_id = i32::try_from(process_id).ok()?;
  stella_desktop_macos::text_before_cursor(
    process_id,
    dictation_cleanup::context_limits().text_before_cursor,
  )
}

#[cfg(not(target_os = "macos"))]
fn text_before_cursor(_process_id: i64) -> Option<String> {
  None
}

/// The title without controls, separators or bidirectional controls,
/// trimmed and cut to its first `max` characters; `None` when nothing is
/// left.
fn bounded_title(title: &str, max: usize) -> Option<String> {
  let title: String = title
    .chars()
    .filter(|character| !dictation_format::is_untyped(*character))
    .collect();
  let cut: String = title.trim().chars().take(max).collect();
  let cut = cut.trim_end();
  (!cut.is_empty()).then(|| cut.to_string())
}

/// The last `max` characters of the text, with its line breaks and tabs
/// kept: any line ending or separator becomes `\n`, other controls become a
/// space and bidirectional controls are dropped. `None` when only
/// whitespace is left.
fn bounded_text_before_cursor(text: &str, max: usize) -> Option<String> {
  let text: String = text
    .replace("\r\n", "\n")
    .chars()
    .filter_map(|character| match character {
      '\n' | '\r' | '\u{2028}' | '\u{2029}' => Some('\n'),
      '\t' => Some('\t'),
      character if dictation_format::is_bidi_control(character) => None,
      character if dictation_format::is_untyped(character) => Some(' '),
      character => Some(character),
    })
    .collect();
  let length = text.chars().count();
  let kept: String = text.chars().skip(length.saturating_sub(max)).collect();
  (!kept.trim().is_empty()).then_some(kept)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn apps_are_kinded_by_identifier_whatever_the_case() {
    for (identifier, kind) in [
      ("com.apple.mail", AppKind::Email),
      ("com.microsoft.Outlook", AppKind::Email),
      ("OUTLOOK.EXE", AppKind::Email),
      ("com.readdle.SparkDesktop", AppKind::Email),
      ("it.bloop.airmail2", AppKind::Email),
      ("org.mozilla.thunderbird", AppKind::Email),
      ("com.microsoft.Word", AppKind::Document),
      ("WINWORD.EXE", AppKind::Document),
      ("com.apple.iWork.Pages", AppKind::Document),
      ("com.apple.TextEdit", AppKind::Document),
      ("com.tinyspeck.slackmacgap", AppKind::Chat),
      ("ms-teams.exe", AppKind::Chat),
      ("com.apple.Safari", AppKind::Browser),
      ("org.mozilla.firefox", AppKind::Browser),
      ("msedge.exe", AppKind::Browser),
      ("com.microsoft.VSCode", AppKind::Code),
      ("dev.zed.Zed", AppKind::Code),
      ("com.jetbrains.intellij", AppKind::Code),
      ("Cursor.exe", AppKind::Code),
      ("com.mitchellh.ghostty", AppKind::Terminal),
      ("WindowsTerminal.exe", AppKind::Terminal),
      ("dev.warp.Warp-Stable", AppKind::Terminal),
      ("com.example.unknown", AppKind::Other),
    ] {
      assert_eq!(AppKind::of(Some(identifier)), kind, "{identifier}");
    }
    assert_eq!(AppKind::of(None), AppKind::Other);
  }

  #[test]
  fn every_listed_identifier_is_lowercase_and_in_one_kind_only() {
    let all = [EMAIL_APPS, DOCUMENT_APPS, CODE_APPS, CODE_PREFIXES].concat();
    for identifier in &all {
      assert_eq!(*identifier, identifier.to_lowercase());
      assert_eq!(
        all.iter().filter(|other| *other == identifier).count(),
        1,
        "{identifier}"
      );
    }
  }

  /// The kind only picks the register; keystrokes stay with `AppClass`, so a
  /// code editor's integrated terminal never gets a Return.
  #[test]
  fn code_editors_still_type_as_terminals() {
    for identifier in CODE_APPS {
      assert_eq!(
        AppClass::of(Some(identifier)),
        AppClass::Terminal,
        "{identifier}"
      );
    }
    for identifier in ["dev.zed.zed", "com.jetbrains.pycharm.ce"] {
      assert_eq!(AppClass::of(Some(identifier)), AppClass::Terminal);
      assert_eq!(AppKind::of(Some(identifier)), AppKind::Code);
    }
  }

  #[test]
  fn every_kind_is_one_the_contract_names() {
    let kinds = [
      AppKind::Email,
      AppKind::Chat,
      AppKind::Document,
      AppKind::Browser,
      AppKind::Code,
      AppKind::Terminal,
      AppKind::Other,
    ];
    let names: Vec<String> = kinds
      .iter()
      .map(|kind| {
        serde_json::to_value(kind)
          .unwrap()
          .as_str()
          .unwrap()
          .to_string()
      })
      .collect();
    assert_eq!(names, dictation_cleanup::contract_app_kinds());
  }

  #[test]
  fn the_kind_alone_is_sent_without_title_or_text() {
    let context = CleanupContext {
      app_kind: AppKind::Email,
      window_title: None,
      text_before_cursor: None,
    };
    assert_eq!(
      serde_json::to_value(&context).unwrap(),
      serde_json::json!({ "appKind": "email" })
    );
    assert_eq!(
      read(None, Sharing::default()),
      CleanupContext::kind_only(None)
    );
    assert_eq!(
      read(
        None,
        Sharing {
          window_title: true,
          text_before_cursor: true,
        }
      ),
      CleanupContext::kind_only(None)
    );
  }

  #[test]
  fn a_title_is_cleaned_and_cut_to_its_first_characters() {
    assert_eq!(bounded_title("  \u{202E}\n ", 200), None);
    assert_eq!(
      bounded_title(" Kupní smlouva\u{2028}– Novák.docx\u{7} ", 200).as_deref(),
      Some("Kupní smlouva– Novák.docx")
    );
    let long = "📄".repeat(250);
    let cut = bounded_title(&long, 200).unwrap();
    assert_eq!(cut.chars().count(), 200);
  }

  #[test]
  fn only_the_end_of_the_text_before_the_cursor_is_kept() {
    let text = format!("{}Článek 3\r\nKupní cena\t", "x".repeat(2000));
    let kept = bounded_text_before_cursor(&text, 1000).unwrap();
    assert_eq!(kept.chars().count(), 1000);
    assert!(kept.ends_with("Článek 3\nKupní cena\t"));
    assert_eq!(
      bounded_text_before_cursor("a\u{7}b\u{202E}c\rd\u{2029}", 1000).as_deref(),
      Some("a bc\nd\n")
    );
    assert_eq!(bounded_text_before_cursor(" \n\t", 1000), None);
  }

  /// What the contract's schema admits: no control except a line break or a
  /// tab in the text, none at all in the title.
  #[test]
  fn bounded_context_never_carries_a_control_the_server_refuses() {
    let messy = "a\u{0}b\u{1b}c\r\u{85}d\u{2028}e\u{202A}f\t";
    let title = bounded_title(messy, 200).unwrap();
    assert!(!title.chars().any(char::is_control));
    let text = bounded_text_before_cursor(messy, 1000).unwrap();
    assert!(
      text
        .chars()
        .all(|character| !character.is_control() || matches!(character, '\n' | '\t'))
    );
  }
}
