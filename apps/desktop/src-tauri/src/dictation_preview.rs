//! The running transcript while the speaker talks, in a small panel under
//! stella's status icon, which already shows that dictation records.
//! `dictation_live` hands it the joined text of every stretch answered so
//! far: this computer's model per stretch, stella AI per request.
//!
//! The panel only shows. It never takes focus or clicks, so the app the
//! speaker dictates into keeps its caret and stays the one text is typed
//! into, and nothing in it is ever typed: on release the final text, after
//! cleanup, is typed as before. Nothing is shown while the app the speaker
//! pressed in has a password field focused, and the text is gone once the
//! dictation ends, however it ends. Neither the text nor the panel is logged
//! or stored.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine show previews")
)]

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, State};

use crate::window_placement::WorkArea;

pub const PREVIEW_WINDOW_LABEL: &str = "dictation-preview";
/// Payload-free: the panel reads the text through the snapshot command.
const CHANGED_EVENT: &str = "dictation-preview-changed";
/// The panel's window. The page draws a card that grows with the text from
/// the edge nearest the status icon; the rest of the window is transparent
/// and lets clicks through.
const WIDTH: f64 = 380.0;
const HEIGHT: f64 = 176.0;
/// Between the status icon and the panel.
const GAP: f64 = 6.0;
/// Between the panel and the edge of the screen.
const MARGIN: f64 = 8.0;

/// Where a dictation is, as the panel shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
  /// No dictation, or nothing to show.
  #[default]
  Hidden,
  /// The key is down; the text grows as stretches are answered.
  Listening,
  /// The key is up; the last stretch and cleanup are on their way.
  Finishing,
}

/// The edge of the window the card sits against: the one nearest the
/// status icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Anchor {
  #[default]
  Top,
  Bottom,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshot {
  pub stage: Stage,
  pub text: String,
  pub anchor: Anchor,
}

/// What the panel shows for the dictation in progress. Pure: the engine and
/// the transcription thread drive it, and the window follows `visible`.
#[derive(Debug, Default)]
pub struct Preview {
  snapshot: PreviewSnapshot,
  /// A password field was focused during this dictation: nothing more is
  /// shown until the next one.
  blocked: bool,
}

impl Preview {
  /// A dictation started: nothing to show until its first text.
  pub fn start(&mut self) -> bool {
    self.blocked = false;
    self.set(Stage::Listening, String::new())
  }

  /// The text so far, in recording order. Empty when a fallback or a
  /// failure discarded what was shown.
  pub fn text(&mut self, text: &str) -> bool {
    if self.blocked || self.snapshot.stage == Stage::Hidden {
      return false;
    }
    self.set(self.snapshot.stage, text.trim().to_string())
  }

  /// The key is up.
  pub fn release(&mut self) -> bool {
    if self.blocked || self.snapshot.stage == Stage::Hidden {
      return false;
    }
    let text = self.snapshot.text.clone();
    self.set(Stage::Finishing, text)
  }

  /// A password field has focus: the text goes, and nothing more is shown
  /// for this dictation.
  pub fn block(&mut self) -> bool {
    self.blocked = true;
    self.set(Stage::Hidden, String::new())
  }

  /// The dictation ended: typed, failed or cancelled.
  pub fn end(&mut self) -> bool {
    self.blocked = false;
    self.set(Stage::Hidden, String::new())
  }

  /// Whether the panel is on screen: during a dictation, once it has text.
  pub fn visible(&self) -> bool {
    self.snapshot.stage != Stage::Hidden && !self.snapshot.text.is_empty()
  }

  pub fn snapshot(&self) -> PreviewSnapshot {
    self.snapshot.clone()
  }

  fn set_anchor(&mut self, anchor: Anchor) {
    self.snapshot.anchor = anchor;
  }

  /// Whether anything the panel shows changed.
  fn set(&mut self, stage: Stage, text: String) -> bool {
    let changed = self.snapshot.stage != stage || self.snapshot.text != text;
    self.snapshot.stage = stage;
    self.snapshot.text = text;
    changed
  }
}

pub struct PreviewState(Mutex<Preview>);

impl PreviewState {
  pub fn new() -> Self {
    Self(Mutex::new(Preview::default()))
  }

  fn update<T>(&self, apply: impl FnOnce(&mut Preview) -> T) -> T {
    let mut preview = self.0.lock().unwrap_or_else(|error| error.into_inner());
    apply(&mut preview)
  }
}

/// Applies `change` and brings the panel in line with it.
fn apply(app: &AppHandle, change: impl FnOnce(&mut Preview) -> bool) {
  let Some(state) = app.try_state::<PreviewState>() else {
    return;
  };
  let (changed, visible) = state.update(|preview| {
    let changed = change(preview);
    (changed, preview.visible())
  });
  if !changed {
    return;
  }
  if visible {
    show(app);
  } else {
    hide(app);
  }
  crate::logging::best_effort(
    app.emit_to(PREVIEW_WINDOW_LABEL, CHANGED_EVENT, ()),
    "dictation preview change was not announced",
  );
}

pub fn start(app: &AppHandle) {
  apply(app, Preview::start);
}

pub fn text(app: &AppHandle, text: &str) {
  apply(app, |preview| preview.text(text));
}

pub fn release(app: &AppHandle) {
  apply(app, Preview::release);
}

pub fn block(app: &AppHandle) {
  apply(app, Preview::block);
}

pub fn end(app: &AppHandle) {
  apply(app, Preview::end);
}

#[tauri::command]
pub fn dictation_preview_get_snapshot(
  state: State<'_, PreviewState>,
) -> PreviewSnapshot {
  state.update(|preview| preview.snapshot())
}

/// Under the status icon, centred on it and kept on its screen; above it
/// when the icon sits in the lower half of the screen (a Windows taskbar).
pub fn placement(icon: WorkArea, screen: WorkArea) -> (LogicalPosition<f64>, Anchor) {
  let x = clamped(
    icon.x + icon.width / 2.0 - WIDTH / 2.0,
    screen.x + MARGIN,
    screen.x + screen.width - WIDTH - MARGIN,
  );
  if icon.y + icon.height / 2.0 < screen.y + screen.height / 2.0 {
    let y = (icon.y + icon.height + GAP).max(screen.y);
    (LogicalPosition::new(x, y), Anchor::Top)
  } else {
    let y = (icon.y - GAP - HEIGHT).min(screen.y + screen.height - HEIGHT);
    (LogicalPosition::new(x, y), Anchor::Bottom)
  }
}

/// Without a status icon to stand under: the corner of the work area where
/// the system keeps its status icons.
pub fn corner_placement(area: WorkArea) -> (LogicalPosition<f64>, Anchor) {
  let x = (area.x + area.width - WIDTH - MARGIN).max(area.x);
  if cfg!(target_os = "macos") {
    (LogicalPosition::new(x, area.y + MARGIN), Anchor::Top)
  } else {
    let y = (area.y + area.height - HEIGHT - MARGIN).max(area.y);
    (LogicalPosition::new(x, y), Anchor::Bottom)
  }
}

/// `value` within `low..=high`, or `low` when the range is empty.
fn clamped(value: f64, low: f64, high: f64) -> f64 {
  value.min(high).max(low)
}

fn position(app: &AppHandle) -> Option<(LogicalPosition<f64>, Anchor)> {
  crate::tray::status_icon_placement(app)
    .map(|icon| placement(icon.frame, icon.screen))
    .or_else(|| crate::window_placement::target_work_area(app).map(corner_placement))
}

/// Creates the panel the first time it is needed; it is hidden, not closed,
/// between dictations.
fn window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
  if let Some(window) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
    return Some(window);
  }
  let built = crate::app_window::builder(app, PREVIEW_WINDOW_LABEL, "index.html")
    .title("stella desktop")
    .inner_size(WIDTH, HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .focused(false)
    .focusable(false)
    .skip_taskbar(true)
    .visible(false)
    .build();
  match built {
    Ok(window) => Some(window),
    Err(error) => {
      tracing::warn!(%error, "dictation preview could not be created");
      None
    }
  }
}

/// Places the panel, creating it the first time, then shows it on the main
/// thread. Called off the main thread: building a window waits for the event
/// loop. The anchor is stored first, so the page reads it with the text.
fn show(app: &AppHandle) {
  let placement = position(app);
  if let (Some((_, anchor)), Some(state)) = (placement, app.try_state::<PreviewState>())
  {
    state.update(|preview| preview.set_anchor(anchor));
  }
  let Some(window) = window(app) else {
    return;
  };
  if let Some((origin, _)) = placement {
    crate::logging::best_effort(
      window.set_position(origin),
      "dictation preview could not be placed",
    );
  }
  if app.run_on_main_thread(move || present(&window)).is_err() {
    tracing::warn!("dictation preview skipped: the event loop is gone");
  }
}

/// Orders the panel in front without making it key or activating stella.
#[cfg(target_os = "macos")]
fn present(window: &tauri::WebviewWindow) {
  if !stella_desktop_macos::present_passive_overlay(window) {
    tracing::warn!("dictation preview could not be shown");
  }
}

/// The window cannot take focus, so showing it leaves focus where it is.
#[cfg(not(target_os = "macos"))]
fn present(window: &tauri::WebviewWindow) {
  crate::logging::best_effort(
    window.set_ignore_cursor_events(true),
    "dictation preview could not let clicks through",
  );
  crate::logging::best_effort(window.show(), "dictation preview could not be shown");
}

fn hide(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
    crate::logging::best_effort(window.hide(), "dictation preview could not be hidden");
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn area(x: f64, y: f64, width: f64, height: f64) -> WorkArea {
    WorkArea {
      x,
      y,
      width,
      height,
    }
  }

  #[test]
  fn the_panel_appears_with_the_first_text_and_follows_the_transcript() {
    let mut preview = Preview::default();
    assert!(preview.start());
    assert!(!preview.visible());
    assert!(preview.text("Dear Ms Novak,"));
    assert!(preview.visible());
    assert!(
      !preview.text("Dear Ms Novak,"),
      "an unchanged text is no change"
    );
    assert!(preview.text(" Dear Ms Novak, thank you "));
    assert_eq!(
      preview.snapshot(),
      PreviewSnapshot {
        stage: Stage::Listening,
        text: "Dear Ms Novak, thank you".to_string(),
        anchor: Anchor::Top,
      }
    );
  }

  #[test]
  fn release_keeps_the_text_until_the_dictation_ends() {
    let mut preview = Preview::default();
    preview.start();
    preview.text("first");
    assert!(preview.release());
    assert_eq!(preview.snapshot().stage, Stage::Finishing);
    assert_eq!(preview.snapshot().text, "first");
    // The last stretch arrives after the release.
    assert!(preview.text("first second"));
    assert!(preview.end());
    assert!(!preview.visible());
    assert_eq!(preview.snapshot().text, "");
  }

  #[test]
  fn a_cancelled_or_failed_dictation_leaves_nothing_on_screen() {
    let mut preview = Preview::default();
    preview.start();
    preview.text("half a sentence");
    assert!(preview.end());
    assert_eq!(preview.snapshot().stage, Stage::Hidden);
    // A late text from the dictation that ended shows nothing.
    assert!(!preview.text("half a sentence more"));
    assert!(!preview.visible());
  }

  #[test]
  fn a_discarded_text_hides_the_panel_until_new_text_arrives() {
    let mut preview = Preview::default();
    preview.start();
    preview.text("from stella AI");
    // A fallback to this computer drops stella AI's texts.
    assert!(preview.text(""));
    assert!(!preview.visible());
    assert!(preview.text("from this computer"));
    assert!(preview.visible());
  }

  #[test]
  fn a_password_field_shows_nothing_for_the_rest_of_the_dictation() {
    let mut preview = Preview::default();
    preview.start();
    preview.text("my account");
    assert!(preview.block());
    assert!(!preview.visible());
    assert!(!preview.text("my account number"));
    assert!(!preview.release());
    assert!(!preview.visible());
    // The next dictation shows again.
    preview.end();
    preview.start();
    assert!(preview.text("next"));
    assert!(preview.visible());
  }

  #[test]
  fn nothing_shows_outside_a_dictation() {
    let mut preview = Preview::default();
    assert!(!preview.text("stray"));
    assert!(!preview.release());
    assert!(!preview.visible());
  }

  #[test]
  fn the_panel_hangs_under_a_menu_bar_icon_and_stays_on_its_screen() {
    let screen = area(0.0, 0.0, 1512.0, 982.0);
    let (origin, anchor) = placement(area(1200.0, 0.0, 24.0, 24.0), screen);
    assert_eq!(anchor, Anchor::Top);
    assert_eq!(origin.y, 24.0 + GAP);
    assert_eq!(origin.x, 1212.0 - WIDTH / 2.0);
    // An icon near the right edge pulls the panel inside the screen.
    let (origin, _) = placement(area(1490.0, 0.0, 20.0, 24.0), screen);
    assert_eq!(origin.x, 1512.0 - WIDTH - MARGIN);
    // On a second screen to the left, the panel stays on that screen.
    let left = area(-1920.0, 0.0, 1920.0, 1080.0);
    let (origin, _) = placement(area(-1910.0, 0.0, 20.0, 24.0), left);
    assert_eq!(origin.x, -1920.0 + MARGIN);
  }

  #[test]
  fn the_panel_stands_above_a_taskbar_icon() {
    let screen = area(0.0, 0.0, 1920.0, 1040.0);
    let (origin, anchor) = placement(area(1700.0, 1048.0, 24.0, 24.0), screen);
    assert_eq!(anchor, Anchor::Bottom);
    assert_eq!(origin.y, 1040.0 - HEIGHT);
    let (origin, _) = placement(area(1700.0, 900.0, 24.0, 24.0), screen);
    assert_eq!(origin.y, 900.0 - GAP - HEIGHT);
  }

  #[test]
  fn a_screen_narrower_than_the_panel_pins_it_to_the_left_edge() {
    let screen = area(0.0, 0.0, 300.0, 600.0);
    let (origin, _) = placement(area(150.0, 0.0, 20.0, 20.0), screen);
    assert_eq!(origin.x, MARGIN);
  }
}
