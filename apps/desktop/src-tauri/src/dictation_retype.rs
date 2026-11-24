//! Types the last dictation again into the field that has focus now, from
//! its own shortcut or the tray. The text stays only in this process's
//! memory, and only while clipboard history holds that dictation: one that
//! history did not keep (history paused or turned off by the organization,
//! an app left out of it, a password field) is never remembered, and
//! deleting it from history, clearing or pausing history forgets it here
//! too. Typing it again passes the guards a dictation passes: never into a
//! password field, never while a shortcut key is still held, and never into
//! another app than the one focused when it was asked for.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine type text")
)]

use std::time::Duration;

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use crate::dictation_format::Segment;

/// The tray menu closes and focus settles back on the app under it before
/// focus is read.
pub const TRAY_SETTLE: Duration = Duration::from_millis(250);

/// Option+Shift+V on a Mac. Elsewhere Control+Alt+Shift+V: Windows reads
/// Control+Alt as AltGr, and AltGr+V types `@` on Czech, Slovak and
/// Hungarian keyboards.
#[cfg(target_os = "macos")]
pub fn shortcut() -> Shortcut {
  Shortcut::new(Some(Modifiers::ALT.union(Modifiers::SHIFT)), Code::KeyV)
}

#[cfg(not(target_os = "macos"))]
pub fn shortcut() -> Shortcut {
  Shortcut::new(
    Some(
      Modifiers::CONTROL
        .union(Modifiers::ALT)
        .union(Modifiers::SHIFT),
    ),
    Code::KeyV,
  )
}

/// What asked for the last dictation again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Request {
  Shortcut,
  Tray,
}

/// The last dictation clipboard history kept, as it was typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastDictation {
  /// Its clipboard history item: once history no longer holds it, it is
  /// not typed again.
  pub history_id: String,
  pub transcript: String,
  pub cleaned: Option<Vec<Segment>>,
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::clipboard_shortcut::{self, ShortcutKeys};

  #[test]
  fn the_shortcut_passes_the_shortcut_rules_and_clashes_with_no_other_stella_shortcut()
  {
    let keys = ShortcutKeys::of(&shortcut());
    assert_eq!(clipboard_shortcut::validate(&keys), Ok(shortcut()));
    assert_ne!(shortcut(), clipboard_shortcut::default_shortcut());
    assert_ne!(shortcut(), crate::dictation::shortcut());
  }

  #[test]
  fn the_shortcut_is_never_altgr_with_a_letter() {
    let mods = shortcut().mods;
    let altgr = Modifiers::CONTROL.union(Modifiers::ALT);
    assert!(
      cfg!(target_os = "macos") || mods != altgr,
      "Control+Alt+V is AltGr+V, which types a character on many layouts"
    );
  }
}
