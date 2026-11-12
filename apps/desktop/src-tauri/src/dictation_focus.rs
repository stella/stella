//! Which app a dictation types into. The target is read when the shortcut is
//! pressed and again right before typing; when focus moved to another app in
//! between (transcription and cleanup take a moment), nothing is typed, so a
//! dictation never lands in a window the speaker did not choose. Only app
//! identity is read: never window titles or contents.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine read focus")
)]

use tauri::AppHandle;

/// The focused app: bundle identifier and process on macOS, executable,
/// process and window on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FocusTarget {
  pub identifier: Option<String>,
  process_id: i64,
  window: Option<isize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Insertion {
  Allowed,
  FocusMoved,
}

/// Whether text may go to the app focused now. Without a target read at the
/// press there is nothing to compare, and typing goes ahead as it always did;
/// once a target was read, a focus that cannot be read again counts as moved.
pub fn insertion(
  pressed: Option<&FocusTarget>,
  now: Option<&FocusTarget>,
) -> Insertion {
  match (pressed, now) {
    (None, _) => Insertion::Allowed,
    (Some(pressed), Some(now)) if pressed == now => Insertion::Allowed,
    (Some(_), _) => Insertion::FocusMoved,
  }
}

#[cfg(target_os = "macos")]
pub fn current(app: &AppHandle) -> Option<FocusTarget> {
  let foreground = crate::foreground_app::current(app)?;
  Some(FocusTarget {
    identifier: foreground.identifier,
    process_id: i64::from(foreground.process_id),
    window: None,
  })
}

#[cfg(target_os = "windows")]
pub fn current(app: &AppHandle) -> Option<FocusTarget> {
  use winsafe::{HWND, prelude::Handle as _};

  let window = HWND::GetForegroundWindow()?;
  let foreground = crate::foreground_app::current(app)?;
  let (_, process_id) = window.GetWindowThreadProcessId();
  // The app lookup reads the foreground window again; a different process
  // means focus moved between the two reads.
  if process_id != foreground.process_id {
    return None;
  }
  Some(FocusTarget {
    identifier: foreground.identifier,
    process_id: i64::from(process_id),
    window: Some(window.ptr() as isize),
  })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn current(_app: &AppHandle) -> Option<FocusTarget> {
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  fn target(identifier: &str, process_id: i64, window: Option<isize>) -> FocusTarget {
    FocusTarget {
      identifier: Some(identifier.to_string()),
      process_id,
      window,
    }
  }

  #[test]
  fn the_app_focused_at_the_press_still_receives_the_text() {
    let word = target("com.microsoft.word", 41, None);
    assert_eq!(
      insertion(Some(&word), Some(&word.clone())),
      Insertion::Allowed
    );
  }

  #[test]
  fn another_app_another_process_or_another_window_gets_nothing() {
    let pressed = target("winword.exe", 41, Some(7));
    for now in [
      target("slack.exe", 41, Some(7)),
      target("winword.exe", 42, Some(7)),
      target("winword.exe", 41, Some(8)),
    ] {
      assert_eq!(
        insertion(Some(&pressed), Some(&now)),
        Insertion::FocusMoved,
        "{now:?}"
      );
    }
  }

  #[test]
  fn a_focus_that_cannot_be_read_again_counts_as_moved() {
    let pressed = target("com.apple.mail", 3, None);
    assert_eq!(insertion(Some(&pressed), None), Insertion::FocusMoved);
  }

  #[test]
  fn without_a_target_at_the_press_typing_goes_ahead_as_before() {
    assert_eq!(insertion(None, None), Insertion::Allowed);
    assert_eq!(
      insertion(None, Some(&target("com.apple.mail", 3, None))),
      Insertion::Allowed
    );
  }
}
