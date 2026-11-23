//! "Fix last dictation": the speaker selects the words a dictation got
//! wrong in any app and asks, from its shortcut or the tray, to fix them. A
//! small stella panel shows them and takes the right spelling; saving teaches
//! it as a fix that is on at once (`dictation_learned::teach`) and syncs it.
//!
//! The other app's text is read only when the speaker asks, and only its
//! selection, through Accessibility on a Mac or UI Automation on Windows:
//! never a password field, never stella's own windows, and never more than
//! `MAX_SELECTION_UTF16_UNITS`. Where no selection can be read, the panel
//! offers the words of the last dictation (`dictation_retype`'s memory) to
//! pick from. What it read stays in this process's memory while the panel
//! is open, and is never logged.

#![cfg_attr(
  not(dictation),
  allow(
    dead_code,
    reason = "only builds with the speech engine fix dictations"
  )
)]

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use crate::{
  dictation_focus::{self, FocusTarget},
  dictation_learned::{self, Refusal, TeachFailure},
  dictation_retype::Request,
};

pub const FIX_WINDOW_LABEL: &str = "dictation-fix";
/// Payload-free: the panel reads its state again.
const CHANGED_EVENT: &str = "dictation-fix-changed";
const WIDTH: f64 = 440.0;
const HEIGHT: f64 = 300.0;
/// A selection longer than this is not read: a fix is a few words.
const MAX_SELECTION_UTF16_UNITS: usize = 200;
/// The words of the last dictation the panel offers, at most.
const MAX_LAST_WORDS: usize = 120;

/// Option+Shift+T on a Mac. Elsewhere Control+Alt+Shift+T: Control+Alt is
/// AltGr on Windows, and T is a letter AltGr, with or without Shift, types
/// nothing with on the Czech, Slovak, Hungarian, Polish and Baltic layouts.
#[cfg(target_os = "macos")]
pub fn shortcut() -> Shortcut {
  Shortcut::new(Some(Modifiers::ALT.union(Modifiers::SHIFT)), Code::KeyT)
}

#[cfg(not(target_os = "macos"))]
pub fn shortcut() -> Shortcut {
  Shortcut::new(
    Some(
      Modifiers::CONTROL
        .union(Modifiers::ALT)
        .union(Modifiers::SHIFT),
    ),
    Code::KeyT,
  )
}

/// What the panel shows: the words selected in the other app, or else the
/// words of the last dictation to pick from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixRequest {
  selection: Option<String>,
  last_words: Vec<String>,
}

/// The request the open panel shows, only in memory.
#[derive(Default)]
pub struct FixPanel(Mutex<Option<FixRequest>>);

impl FixPanel {
  fn set(&self, request: Option<FixRequest>) {
    *self.0.lock().unwrap_or_else(|error| error.into_inner()) = request;
  }

  fn get(&self) -> Option<FixRequest> {
    self
      .0
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .clone()
  }
}

/// Reads what to fix as the request arrives, off the thread that delivered
/// it (the focus lookup waits for the main thread), then opens the panel.
pub fn request(app: &AppHandle, request: Request) {
  let app = app.clone();
  let spawned = std::thread::Builder::new()
    .name("dictation-fix".to_string())
    .spawn(move || {
      if request == Request::Tray {
        std::thread::sleep(crate::dictation_retype::TRAY_SETTLE);
      }
      let selection = dictation_focus::current(&app)
        .as_ref()
        .and_then(selected_text)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
      let last_words = if selection.is_none() {
        last_words(&app)
      } else {
        Vec::new()
      };
      app.state::<FixPanel>().set(Some(FixRequest {
        selection,
        last_words,
      }));
      show(&app);
    });
  if let Err(error) = spawned {
    tracing::warn!(%error, "dictation fix could not start");
  }
}

/// The words of the last dictation as it was typed, while clipboard history
/// still holds it.
fn last_words(app: &AppHandle) -> Vec<String> {
  crate::dictation::last_dictation(app)
    .map(|last| {
      let typed =
        crate::dictation_cleanup::typed_text(&last.transcript, last.cleaned.as_deref());
      crate::dictation_spelling::words_of(&typed)
        .into_iter()
        .take(MAX_LAST_WORDS)
        .collect()
    })
    .unwrap_or_default()
}

/// The selection in the focused app, never in stella's own windows.
fn selected_text(target: &FocusTarget) -> Option<String> {
  if u32::try_from(target.process_id()).ok() == Some(std::process::id()) {
    return None;
  }
  platform_selected_text(target.process_id())
}

#[cfg(target_os = "macos")]
fn platform_selected_text(process_id: i64) -> Option<String> {
  let process_id = i32::try_from(process_id).ok()?;
  stella_desktop_macos::selected_text(process_id, MAX_SELECTION_UTF16_UNITS)
}

#[cfg(target_os = "windows")]
fn platform_selected_text(process_id: i64) -> Option<String> {
  let process_id = u32::try_from(process_id).ok()?;
  stella_desktop_macos::selected_text(process_id, MAX_SELECTION_UTF16_UNITS)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const fn platform_selected_text(_process_id: i64) -> Option<String> {
  None
}

fn show(app: &AppHandle) {
  #[cfg(target_os = "macos")]
  crate::logging::best_effort(app.show(), "app could not be shown");
  if let Some(window) = app.get_webview_window(FIX_WINDOW_LABEL) {
    crate::logging::best_effort(
      app.emit_to(FIX_WINDOW_LABEL, CHANGED_EVENT, ()),
      "emit dictation fix change",
    );
    if window.show().and_then(|()| window.set_focus()).is_err() {
      tracing::warn!("dictation fix panel could not be focused");
    }
    return;
  }
  let size = LogicalSize::new(WIDTH, HEIGHT);
  let builder = crate::app_window::builder(app, FIX_WINDOW_LABEL, "index.html")
    .title("stella")
    .inner_size(size.width, size.height)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(true);
  let builder = crate::window_placement::centered_on_target_screen(app, builder, size);
  let Ok(window) = builder.build() else {
    tracing::warn!("dictation fix panel could not be created");
    // No window will ever close it: the selection read for it goes now.
    app.state::<FixPanel>().set(None);
    return;
  };
  if window.set_focus().is_err() {
    tracing::warn!("dictation fix panel could not be focused");
  }
  let handle = app.clone();
  window.on_window_event(move |event| {
    if matches!(event, WindowEvent::Destroyed) {
      handle.state::<FixPanel>().set(None);
    }
  });
}

fn close(app: &AppHandle) {
  app.state::<FixPanel>().set(None);
  if let Some(window) = app.get_webview_window(FIX_WINDOW_LABEL)
    && window.close().is_err()
  {
    tracing::warn!("dictation fix panel could not be closed");
  }
}

/// What saving a fix came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FixSaved {
  Saved,
  Refused {
    reason: Refusal,
  },
  /// No linked account, or the list could not be read or written.
  NotSaved,
}

#[tauri::command]
pub fn dictation_fix_get_state(panel: State<'_, FixPanel>) -> FixRequest {
  panel.get().unwrap_or_default()
}

#[tauri::command]
pub fn dictation_fix_save(app: AppHandle, from: String, to: String) -> FixSaved {
  match dictation_learned::teach(&app, &from, &to) {
    Ok(()) => {
      close(&app);
      FixSaved::Saved
    }
    Err(TeachFailure::Refused(reason)) => FixSaved::Refused { reason },
    Err(TeachFailure::NotSaved) => FixSaved::NotSaved,
  }
}

#[tauri::command]
pub fn dictation_fix_close(app: AppHandle) {
  close(&app);
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
    assert_ne!(shortcut(), crate::dictation_retype::shortcut());
  }

  #[test]
  fn the_shortcut_is_never_a_letter_altgr_types_with() {
    let shortcut = shortcut();
    let altgr = Modifiers::CONTROL.union(Modifiers::ALT);
    assert!(
      cfg!(target_os = "macos") || shortcut.mods != altgr,
      "Control+Alt+letter is AltGr+letter, which types a character on many layouts"
    );
    // Letters AltGr, with or without Shift, types with on Czech, Slovak,
    // Hungarian, Polish, Latvian or Estonian layouts.
    let typing = [
      Code::KeyA,
      Code::KeyB,
      Code::KeyC,
      Code::KeyD,
      Code::KeyE,
      Code::KeyF,
      Code::KeyG,
      Code::KeyI,
      Code::KeyJ,
      Code::KeyK,
      Code::KeyL,
      Code::KeyM,
      Code::KeyN,
      Code::KeyO,
      Code::KeyQ,
      Code::KeyR,
      Code::KeyS,
      Code::KeyU,
      Code::KeyV,
      Code::KeyW,
      Code::KeyX,
      Code::KeyY,
      Code::KeyZ,
    ];
    assert!(!typing.contains(&shortcut.key));
  }

  #[test]
  fn a_save_answers_in_the_shape_the_panel_reads() {
    assert_eq!(
      serde_json::to_value(FixSaved::Saved).unwrap(),
      serde_json::json!({"status": "saved"})
    );
    assert_eq!(
      serde_json::to_value(FixSaved::Refused {
        reason: Refusal::TooManyWords
      })
      .unwrap(),
      serde_json::json!({"status": "refused", "reason": "tooManyWords"})
    );
    assert_eq!(
      serde_json::to_value(FixRequest {
        selection: None,
        last_words: vec!["Novak".to_string()],
      })
      .unwrap(),
      serde_json::json!({"selection": null, "lastWords": ["Novak"]})
    );
  }
}
