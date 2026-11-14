//! How a dictation becomes keystrokes in the app that has focus.
//!
//! The one owner of that mapping: segments arrive from the cleanup answer,
//! the focused app picks a class, and the class decides which keystroke a
//! line break, a paragraph or bold becomes. Text never presses a key: every
//! text stroke, cleaned or raw, from this computer or stella AI, is
//! [`TypedText`], in which control characters and the Unicode line and
//! paragraph separators became spaces and bidirectional controls were
//! dropped, so only the strokes planned here can send Return.
//!
//! Only a known app gets formatting keystrokes. A word processor or mail app
//! gets Return for a paragraph, Shift+Return for a line and Command/Control+B
//! for bold; a chat app or a browser gets Shift+Return for every break, since
//! a plain Return would send the message or the form, and bold except in
//! Firefox, where Command/Control+B opens the bookmarks. Terminals, code
//! editors with an integrated terminal, every app not listed here, and any
//! dictation whose app could not be read when the shortcut was pressed get
//! plain text only: every break becomes a single space, nothing bolds, and
//! neither Return nor Shift+Return is ever pressed.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine type these")
)]

/// One piece of a cleaned-up dictation; `dictation_cleanup` reads it from
/// the API's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
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
  /// A browser whose Command/Control+B is not bold (Firefox opens the
  /// bookmarks): soft breaks, nothing bolds.
  PlainBrowser,
  /// Shells, terminal apps and code editors with an integrated terminal:
  /// Return runs a command, so breaks become spaces and nothing bolds.
  Terminal,
  /// Anything unknown, or an app that could not be read: plain text, breaks
  /// become spaces and nothing bolds, the same as a terminal.
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
/// Chromium browsers and Safari, where Command/Control+B bolds in an
/// editable page.
const BROWSER_APPS: &[&str] = &[
  "com.google.chrome",
  "com.apple.safari",
  "company.thebrowser.browser",
  "com.microsoft.edgemac",
  "com.brave.browser",
  "chrome.exe",
  "msedge.exe",
  "brave.exe",
  "arc.exe",
];
const PLAIN_BROWSER_APPS: &[&str] = &["org.mozilla.firefox", "firefox.exe"];
const TERMINAL_APPS: &[&str] = &[
  // Terminal apps.
  "com.apple.terminal",
  "com.googlecode.iterm2",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "io.alacritty",
  "com.github.wez.wezterm",
  "co.zeit.hyper",
  "org.tabby",
  "windowsterminal.exe",
  "openconsole.exe",
  "conhost.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "mintty.exe",
  "alacritty.exe",
  "wezterm-gui.exe",
  "wezterm.exe",
  "putty.exe",
  "hyper.exe",
  "tabby.exe",
  "warp.exe",
  // Code editors whose integrated terminal can have focus.
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
/// Identifier prefixes that are terminals whatever follows: every Warp,
/// Herdr and Zed channel, every JetBrains IDE and every ConEmu build.
const TERMINAL_PREFIXES: &[&str] = &[
  "dev.warp.",
  "dev.herdr.",
  "dev.zed.",
  "com.jetbrains.",
  "conemu",
];

impl AppClass {
  /// The class of the app with this identifier; `Other` when unknown or
  /// unread.
  pub fn of(identifier: Option<&str>) -> Self {
    let Some(identifier) = identifier.map(|value| value.trim().to_lowercase()) else {
      return Self::Other;
    };
    let listed = |apps: &[&str]| apps.contains(&identifier.as_str());
    if listed(TERMINAL_APPS)
      || TERMINAL_PREFIXES
        .iter()
        .any(|prefix| identifier.starts_with(prefix))
    {
      Self::Terminal
    } else if listed(RICH_APPS) {
      Self::Rich
    } else if listed(CHAT_APPS) {
      Self::Chat
    } else if listed(BROWSER_APPS) {
      Self::Browser
    } else if listed(PLAIN_BROWSER_APPS) {
      Self::PlainBrowser
    } else {
      Self::Other
    }
  }

  const fn bolds(self) -> bool {
    matches!(self, Self::Rich | Self::Chat | Self::Browser)
  }
}

/// Characters text is never typed with: controls, the Unicode line and
/// paragraph separators, and the bidirectional controls.
pub fn is_untyped(character: char) -> bool {
  character.is_control() || is_separator(character) || is_bidi_control(character)
}

const fn is_separator(character: char) -> bool {
  matches!(character, '\u{2028}' | '\u{2029}')
}

/// Embedding, override and isolate controls, which reorder the text around
/// them.
pub const fn is_bidi_control(character: char) -> bool {
  matches!(character, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// A key a formatting stroke presses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
  Return,
  B,
}

/// Text with every control and separator replaced by a space and every
/// bidirectional control dropped. Its only constructor applies that rule,
/// so no text stroke can carry a character that presses a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedText(String);

impl TypedText {
  pub fn new(text: &str) -> Self {
    Self(typeable(text))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }

  fn push(&mut self, text: &str) {
    self.0.push_str(&typeable(text));
  }
}

/// `text` with controls and separators as spaces and without bidirectional
/// controls.
fn typeable(text: &str) -> String {
  text
    .chars()
    .filter(|character| !is_bidi_control(*character))
    .map(|character| {
      if character.is_control() || is_separator(character) {
        ' '
      } else {
        character
      }
    })
    .collect()
}

/// One input event sequence for the focused app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stroke {
  Text(TypedText),
  Key(Key),
  Shift(Key),
  /// With the platform's command modifier: Command on macOS, Control on
  /// Windows.
  Command(Key),
}

/// The transcript as dictation types it without cleanup: as is, except for
/// the characters no text is typed with. The trailing space lets the next
/// dictation continue the sentence.
pub fn raw(transcript: &str) -> Vec<Stroke> {
  vec![Stroke::Text(TypedText::new(&format!("{transcript} ")))]
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
        AppClass::Terminal | AppClass::Other => strokes.space(),
        AppClass::Rich if paragraph => strokes.push(Stroke::Key(Key::Return)),
        AppClass::Rich => strokes.push(Stroke::Shift(Key::Return)),
        AppClass::Chat | AppClass::Browser | AppClass::PlainBrowser => {
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

/// The segments as plain text, the way a clipboard keeps them: a line break
/// is a newline, a paragraph break an empty line, bold is plain, and the
/// text is the same text `plan` types.
pub fn plain_text(segments: &[Segment]) -> String {
  let mut text = String::new();
  for piece in normalized(segments) {
    match piece {
      Piece::Text { text: piece, .. } => text.push_str(&piece),
      Piece::Break { paragraph: false } => text.push('\n'),
      Piece::Break { paragraph: true } => text.push_str("\n\n"),
    }
  }
  text.trim().to_string()
}

enum Piece {
  Text { text: String, bold: bool },
  Break { paragraph: bool },
}

/// Text without controls, separators or bidirectional controls, trimmed where
/// it meets a break, and without the pieces that leaves empty.
fn normalized(segments: &[Segment]) -> Vec<Piece> {
  let mut pieces = segments
    .iter()
    .map(|segment| match segment {
      Segment::Text { text, bold } => Piece::Text {
        text: typeable(text),
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
      previous.push(text);
    } else {
      self.0.push(Stroke::Text(TypedText::new(text)));
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
      Some(Stroke::Text(previous))
        if previous.as_str().ends_with(char::is_whitespace) => {}
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

  /// A stroke of exactly `value`, bypassing the rule [`TypedText::new`]
  /// applies, so a comparison shows what that rule produced.
  fn typed(value: &str) -> Stroke {
    Stroke::Text(TypedText(value.to_string()))
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

  const ALL_CLASSES: [AppClass; 6] = [
    AppClass::Rich,
    AppClass::Chat,
    AppClass::Browser,
    AppClass::PlainBrowser,
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
    assert_eq!(
      AppClass::of(Some("org.mozilla.firefox")),
      AppClass::PlainBrowser
    );
    assert_eq!(AppClass::of(Some("firefox.exe")), AppClass::PlainBrowser);
    assert_eq!(AppClass::of(Some("com.example.unknown")), AppClass::Other);
    assert_eq!(AppClass::of(None), AppClass::Other);
  }

  #[test]
  fn terminal_apps_and_editors_with_a_terminal_are_terminals() {
    for identifier in [
      "net.kovidgoyal.kitty",
      "org.alacritty",
      "com.github.wez.wezterm",
      "co.zeit.hyper",
      "org.tabby",
      "dev.warp.Warp-Stable",
      "dev.warp.Warp-Preview",
      "dev.herdr.app",
      "mintty.exe",
      "alacritty.exe",
      "wezterm-gui.exe",
      "putty.exe",
      "ConEmu64.exe",
      "ConEmu.exe",
      "com.microsoft.VSCode",
      "com.todesktop.230313mzl4w4u92",
      "com.jetbrains.intellij",
      "com.jetbrains.pycharm.ce",
      "dev.zed.Zed",
      "Code.exe",
      "Cursor.exe",
      "idea64.exe",
    ] {
      assert_eq!(
        AppClass::of(Some(identifier)),
        AppClass::Terminal,
        "{identifier}"
      );
    }
  }

  #[test]
  fn every_listed_identifier_is_lowercase_and_in_one_class_only() {
    let lists = [
      RICH_APPS,
      CHAT_APPS,
      BROWSER_APPS,
      PLAIN_BROWSER_APPS,
      TERMINAL_APPS,
      TERMINAL_PREFIXES,
    ];
    let all = lists.concat();
    for identifier in &all {
      assert_eq!(*identifier, identifier.to_lowercase());
      assert_eq!(
        all.iter().filter(|other| *other == identifier).count(),
        1,
        "{identifier}"
      );
    }
    for identifier in [RICH_APPS, CHAT_APPS, BROWSER_APPS, PLAIN_BROWSER_APPS].concat()
    {
      assert!(
        !TERMINAL_PREFIXES
          .iter()
          .any(|prefix| identifier.starts_with(prefix)),
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
    for class in [AppClass::Chat, AppClass::Browser, AppClass::PlainBrowser] {
      assert_eq!(
        plan(&segments, class),
        vec![typed("Ano."), shift.clone(), shift.clone(), typed("Ne. ")],
        "{class:?}"
      );
    }
    for class in [AppClass::Terminal, AppClass::Other] {
      assert_eq!(
        plan(&segments, class),
        vec![typed("Ano. Ne. ")],
        "{class:?}"
      );
    }
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
    for class in [AppClass::PlainBrowser, AppClass::Terminal, AppClass::Other] {
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
  fn an_unknown_or_unread_app_gets_plain_text_and_never_a_return() {
    let segments = [
      text("Vážení,"),
      Segment::LineBreak,
      bold("děkuji"),
      Segment::ParagraphBreak,
      text("Jan"),
    ];
    for identifier in [Some("com.example.unknown"), None] {
      let class = AppClass::of(identifier);
      assert_eq!(
        plan(&segments, class),
        vec![typed("Vážení, děkuji Jan ")],
        "{identifier:?}"
      );
    }
  }

  #[test]
  fn separators_and_bidirectional_controls_never_reach_the_app() {
    let segments = [
      text("a\u{2028}b\u{2029}c"),
      text(" d\u{202E}e\u{2066}f\u{2069}"),
    ];
    for class in ALL_CLASSES {
      assert_eq!(
        plan(&segments, class),
        vec![typed("a b c def ")],
        "{class:?}"
      );
    }
    for character in [
      '\u{2028}', '\u{2029}', '\u{202A}', '\u{202E}', '\u{2066}', '\u{2069}', '\n',
    ] {
      assert!(is_untyped(character), "{character:?}");
    }
    assert!(!is_untyped('ř'));
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
    for class in [AppClass::Terminal, AppClass::Other, AppClass::Chat] {
      let strokes = plan(&segments, class);
      assert!(!strokes.contains(&Stroke::Key(Key::Return)), "{class:?}");
      for stroke in &strokes {
        if let Stroke::Text(value) = stroke {
          assert!(!value.as_str().contains(['\n', '\r']), "{class:?}");
        }
      }
    }
    for class in [AppClass::Terminal, AppClass::Other] {
      assert!(
        plan(&segments, class)
          .iter()
          .all(|stroke| matches!(stroke, Stroke::Text(_))),
        "{class:?}"
      );
      assert_eq!(plan(&segments, class), vec![typed("ls -la done ")]);
    }
  }

  #[test]
  fn text_next_to_a_break_loses_the_spaces_that_would_start_or_end_a_line() {
    let segments = [text("Vážení, "), Segment::LineBreak, text(" děkuji")];
    assert_eq!(
      plan(&segments, AppClass::Browser),
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

  #[test]
  fn the_plain_text_keeps_breaks_as_newlines_and_bold_as_text() {
    assert_eq!(plain_text(&product_example()), "a tedy\nse rozhodl odejít.");
    assert_eq!(
      plain_text(&[
        text("Lhůta je "),
        bold("24"),
        text(" dní. "),
        Segment::ParagraphBreak,
        text(" Konec\u{2028}textu\u{202E}"),
      ]),
      "Lhůta je 24 dní.\n\nKonec textu"
    );
    assert_eq!(plain_text(&[Segment::LineBreak]), "");
  }

  #[test]
  fn raw_text_never_breaks_a_line_or_carries_a_control() {
    let transcript = "ls\n-la\rpwd\u{2028}echo\u{2029}\u{202E}ok\u{2066}\u{7}done";
    assert!(transcript.chars().any(is_untyped));
    assert_eq!(raw(transcript), vec![typed("ls -la pwd echo ok done ")]);
  }
}
