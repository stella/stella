//! How a cleaned-up dictation becomes keystrokes in the app that has focus.
//!
//! The one owner of that mapping: segments arrive from the cleanup answer,
//! the focused app picks a class, and the class decides which keystroke a
//! line break, a paragraph or bold becomes. Text never presses a key: control
//! characters in it become spaces, so only the strokes planned here can send
//! Return. A terminal never gets Return at all, and a chat app never gets a
//! plain Return, which would send the message.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine type these")
)]

use serde::Deserialize;

/// One piece of a cleaned-up dictation, as the API sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Segment {
  Text { text: String, bold: bool },
  LineBreak,
  ParagraphBreak,
}

/// What the focused app does with formatting keystrokes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppClass {
  /// Word processors and mail: bold toggles, Return starts a paragraph.
  Rich,
  /// Message composers: Return sends, so every break is Shift+Return.
  Chat,
  /// Web pages: bold toggles where the page supports it, breaks are soft.
  Browser,
  /// Shells: Return runs a command, so breaks become spaces and nothing bolds.
  Terminal,
  /// Anything else: plain text with soft breaks.
  Other,
}

/// Bundle identifiers on macOS and executable names on Windows, lowercased.
const RICH_APPS: &[&str] = &[
  "com.microsoft.word",
  "com.apple.iwork.pages",
  "com.apple.textedit",
  "com.apple.mail",
  "com.microsoft.outlook",
  "com.apple.notes",
  "winword.exe",
  "outlook.exe",
  "olk.exe",
];
const CHAT_APPS: &[&str] = &[
  "com.tinyspeck.slackmacgap",
  "com.microsoft.teams",
  "com.microsoft.teams2",
  "net.whatsapp.whatsapp",
  "desktop.whatsapp",
  "com.apple.mobilesms",
  "com.hnc.discord",
  "ru.keepcoder.telegram",
  "org.telegram.desktop",
  "org.whispersystems.signal-desktop",
  "slack.exe",
  "ms-teams.exe",
  "teams.exe",
  "whatsapp.exe",
  "discord.exe",
  "telegram.exe",
  "signal.exe",
];
const BROWSER_APPS: &[&str] = &[
  "com.google.chrome",
  "com.apple.safari",
  "company.thebrowser.browser",
  "org.mozilla.firefox",
  "com.microsoft.edgemac",
  "com.brave.browser",
  "chrome.exe",
  "firefox.exe",
  "msedge.exe",
  "brave.exe",
  "arc.exe",
];
const TERMINAL_APPS: &[&str] = &[
  "com.apple.terminal",
  "com.googlecode.iterm2",
  "com.mitchellh.ghostty",
  "dev.warp.warp-stable",
  "windowsterminal.exe",
  "openconsole.exe",
  "conhost.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
];

impl AppClass {
  /// The class of the app with this identifier; `Other` when unknown.
  pub fn of(identifier: Option<&str>) -> Self {
    let Some(identifier) = identifier.map(|value| value.trim().to_lowercase()) else {
      return Self::Other;
    };
    let listed = |apps: &[&str]| apps.contains(&identifier.as_str());
    if listed(RICH_APPS) {
      Self::Rich
    } else if listed(CHAT_APPS) {
      Self::Chat
    } else if listed(BROWSER_APPS) {
      Self::Browser
    } else if listed(TERMINAL_APPS) {
      Self::Terminal
    } else {
      Self::Other
    }
  }

  const fn bolds(self) -> bool {
    matches!(self, Self::Rich | Self::Chat | Self::Browser)
  }
}

/// A key a formatting stroke presses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
  Return,
  B,
}

/// One input event sequence for the focused app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stroke {
  Text(String),
  Key(Key),
  Shift(Key),
  /// With the platform's command modifier: Command on macOS, Control on
  /// Windows.
  Command(Key),
}

/// The transcript exactly as dictation types it without cleanup. The
/// trailing space lets the next dictation continue the sentence.
pub fn raw(transcript: &str) -> Vec<Stroke> {
  vec![Stroke::Text(format!("{transcript} "))]
}

/// The strokes that type `segments` into an app of `class`. A dictation that
/// ends in text keeps the trailing space raw text gets; one that ends in a
/// break does not start the new line with a space.
pub fn plan(segments: &[Segment], class: AppClass) -> Vec<Stroke> {
  let mut strokes = Plan::default();
  for segment in normalized(segments) {
    match segment {
      Piece::Text { text, bold } if bold && class.bolds() => strokes.bold(&text),
      Piece::Text { text, .. } => strokes.text(&text),
      Piece::Break { paragraph } => match class {
        AppClass::Terminal => strokes.space(),
        AppClass::Rich if paragraph => strokes.push(Stroke::Key(Key::Return)),
        AppClass::Rich => strokes.push(Stroke::Shift(Key::Return)),
        AppClass::Chat | AppClass::Browser | AppClass::Other => {
          strokes.push(Stroke::Shift(Key::Return));
          if paragraph {
            strokes.push(Stroke::Shift(Key::Return));
          }
        }
      },
    }
  }
  strokes.finish()
}

enum Piece {
  Text { text: String, bold: bool },
  Break { paragraph: bool },
}

/// Text without control characters, trimmed where it meets a break, and
/// without the pieces that leaves empty.
fn normalized(segments: &[Segment]) -> Vec<Piece> {
  let mut pieces = segments
    .iter()
    .map(|segment| match segment {
      Segment::Text { text, bold } => Piece::Text {
        text: text
          .chars()
          .map(|character| {
            if character.is_control() {
              ' '
            } else {
              character
            }
          })
          .collect(),
        bold: *bold,
      },
      Segment::LineBreak => Piece::Break { paragraph: false },
      Segment::ParagraphBreak => Piece::Break { paragraph: true },
    })
    .collect::<Vec<_>>();
  for index in 0..pieces.len() {
    let after_break = index > 0 && matches!(pieces[index - 1], Piece::Break { .. });
    let before_break = matches!(pieces.get(index + 1), Some(Piece::Break { .. }));
    if let Piece::Text { text, .. } = &mut pieces[index] {
      if after_break {
        *text = text.trim_start().to_string();
      }
      if before_break {
        *text = text.trim_end().to_string();
      }
    }
  }
  pieces.retain(|piece| !matches!(piece, Piece::Text { text, .. } if text.is_empty()));
  pieces
}

#[derive(Default)]
struct Plan(Vec<Stroke>);

impl Plan {
  fn push(&mut self, stroke: Stroke) {
    self.0.push(stroke);
  }

  /// Joins adjacent text into one stroke.
  fn text(&mut self, text: &str) {
    if text.is_empty() {
      return;
    }
    if let Some(Stroke::Text(previous)) = self.0.last_mut() {
      previous.push_str(text);
    } else {
      self.0.push(Stroke::Text(text.to_string()));
    }
  }

  /// Toggles bold around the phrase; the spaces around it stay plain.
  fn bold(&mut self, text: &str) {
    let core = text.trim();
    if core.is_empty() {
      self.text(text);
      return;
    }
    let start = text.len() - text.trim_start().len();
    self.text(&text[..start]);
    self.push(Stroke::Command(Key::B));
    self.text(core);
    self.push(Stroke::Command(Key::B));
    self.text(&text[start + core.len()..]);
  }

  /// One space between words, none at the start and none doubled.
  fn space(&mut self) {
    match self.0.last() {
      None => {}
      Some(Stroke::Text(previous)) if previous.ends_with(char::is_whitespace) => {}
      Some(_) => self.text(" "),
    }
  }

  fn finish(mut self) -> Vec<Stroke> {
    if matches!(self.0.last(), Some(Stroke::Text(_) | Stroke::Command(_))) {
      self.space();
    }
    self.0
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn text(value: &str) -> Segment {
    Segment::Text {
      text: value.to_string(),
      bold: false,
    }
  }

  fn bold(value: &str) -> Segment {
    Segment::Text {
      text: value.to_string(),
      bold: true,
    }
  }

  fn typed(value: &str) -> Stroke {
    Stroke::Text(value.to_string())
  }

  /// "nový řádek a tedy nový řádek se rozhodl odejít tečka"
  fn product_example() -> Vec<Segment> {
    vec![
      Segment::LineBreak,
      text("a tedy"),
      Segment::LineBreak,
      text("se rozhodl odejít."),
    ]
  }

  const ALL_CLASSES: [AppClass; 5] = [
    AppClass::Rich,
    AppClass::Chat,
    AppClass::Browser,
    AppClass::Terminal,
    AppClass::Other,
  ];

  #[test]
  fn apps_are_classed_by_identifier_whatever_the_case() {
    assert_eq!(AppClass::of(Some("com.microsoft.Word")), AppClass::Rich);
    assert_eq!(AppClass::of(Some("WINWORD.EXE")), AppClass::Rich);
    assert_eq!(
      AppClass::of(Some("com.tinyspeck.slackmacgap")),
      AppClass::Chat
    );
    assert_eq!(AppClass::of(Some("ms-teams.exe")), AppClass::Chat);
    assert_eq!(AppClass::of(Some("com.apple.Safari")), AppClass::Browser);
    assert_eq!(AppClass::of(Some("msedge.exe")), AppClass::Browser);
    assert_eq!(
      AppClass::of(Some("com.mitchellh.ghostty")),
      AppClass::Terminal
    );
    assert_eq!(
      AppClass::of(Some("WindowsTerminal.exe")),
      AppClass::Terminal
    );
    assert_eq!(AppClass::of(Some("com.example.unknown")), AppClass::Other);
    assert_eq!(AppClass::of(None), AppClass::Other);
  }

  #[test]
  fn every_listed_identifier_is_lowercase_and_in_one_class_only() {
    let lists = [RICH_APPS, CHAT_APPS, BROWSER_APPS, TERMINAL_APPS];
    let all = lists.concat();
    for identifier in &all {
      assert_eq!(*identifier, identifier.to_lowercase());
      assert_eq!(
        all.iter().filter(|other| *other == identifier).count(),
        1,
        "{identifier}"
      );
    }
  }

  #[test]
  fn the_product_example_breaks_lines_per_app_class() {
    assert_eq!(
      plan(&product_example(), AppClass::Rich),
      vec![
        Stroke::Shift(Key::Return),
        typed("a tedy"),
        Stroke::Shift(Key::Return),
        typed("se rozhodl odejít. "),
      ]
    );
    assert_eq!(
      plan(&product_example(), AppClass::Terminal),
      vec![typed("a tedy se rozhodl odejít. ")]
    );
  }

  #[test]
  fn paragraphs_follow_each_app_class() {
    let segments = [text("Ano."), Segment::ParagraphBreak, text("Ne.")];
    let shift = Stroke::Shift(Key::Return);
    assert_eq!(
      plan(&segments, AppClass::Rich),
      vec![typed("Ano."), Stroke::Key(Key::Return), typed("Ne. ")]
    );
    for class in [AppClass::Chat, AppClass::Browser, AppClass::Other] {
      assert_eq!(
        plan(&segments, class),
        vec![typed("Ano."), shift.clone(), shift.clone(), typed("Ne. ")],
        "{class:?}"
      );
    }
    assert_eq!(
      plan(&segments, AppClass::Terminal),
      vec![typed("Ano. Ne. ")]
    );
  }

  #[test]
  fn bold_toggles_around_the_phrase_only_where_the_app_bolds() {
    let segments = [text("Lhůta je"), bold(" 24 "), text("dní.")];
    for class in [AppClass::Rich, AppClass::Chat, AppClass::Browser] {
      assert_eq!(
        plan(&segments, class),
        vec![
          typed("Lhůta je "),
          Stroke::Command(Key::B),
          typed("24"),
          Stroke::Command(Key::B),
          typed(" dní. "),
        ],
        "{class:?}"
      );
    }
    for class in [AppClass::Terminal, AppClass::Other] {
      assert_eq!(
        plan(&segments, class),
        vec![typed("Lhůta je 24 dní. ")],
        "{class:?}"
      );
    }
  }

  #[test]
  fn a_dictation_ending_in_bold_keeps_its_trailing_space_outside_the_bold() {
    assert_eq!(
      plan(&[bold("42")], AppClass::Rich),
      vec![
        Stroke::Command(Key::B),
        typed("42"),
        Stroke::Command(Key::B),
        typed(" "),
      ]
    );
  }

  #[test]
  fn terminals_and_chats_never_get_a_plain_return() {
    let segments = [
      Segment::ParagraphBreak,
      text("ls\n-la\r"),
      Segment::LineBreak,
      Segment::ParagraphBreak,
      text("done"),
      Segment::ParagraphBreak,
    ];
    for class in [AppClass::Terminal, AppClass::Chat] {
      let strokes = plan(&segments, class);
      assert!(!strokes.contains(&Stroke::Key(Key::Return)), "{class:?}");
      for stroke in &strokes {
        if let Stroke::Text(value) = stroke {
          assert!(!value.contains(['\n', '\r']), "{class:?}");
        }
      }
    }
    assert!(
      plan(&segments, AppClass::Terminal)
        .iter()
        .all(|stroke| matches!(stroke, Stroke::Text(_)))
    );
    assert_eq!(
      plan(&segments, AppClass::Terminal),
      vec![typed("ls -la done ")]
    );
  }

  #[test]
  fn text_next_to_a_break_loses_the_spaces_that_would_start_or_end_a_line() {
    let segments = [text("Vážení, "), Segment::LineBreak, text(" děkuji")];
    assert_eq!(
      plan(&segments, AppClass::Other),
      vec![
        typed("Vážení,"),
        Stroke::Shift(Key::Return),
        typed("děkuji ")
      ]
    );
  }

  #[test]
  fn a_dictation_of_only_breaks_types_only_breaks() {
    for class in ALL_CLASSES {
      let strokes = plan(&[Segment::LineBreak], class);
      assert!(
        strokes
          .iter()
          .all(|stroke| !matches!(stroke, Stroke::Text(_))),
        "{class:?}"
      );
    }
  }

  #[test]
  fn raw_text_is_typed_exactly_with_the_trailing_space() {
    assert_eq!(raw("nový řádek a tedy"), vec![typed("nový řádek a tedy ")]);
  }
}
