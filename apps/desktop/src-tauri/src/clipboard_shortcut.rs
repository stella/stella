//! The global shortcut that opens clipboard history. It is a device
//! preference the user can change: candidates are validated here, the one
//! owner of the rules, and registered with the OS, which reports a shortcut
//! another app already holds.

use std::{str::FromStr, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{
  Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

use crate::device_preference::DevicePreference;

const PREFERENCE_FILE_NAME: &str = "clipboard-shortcut";

/// Payload-free: windows read the new state through the snapshot command.
pub const CHANGED_EVENT: &str = "clipboard-shortcut-changed";

/// Command on macOS, Control elsewhere, as `CommandOrControl` resolves.
#[cfg(target_os = "macos")]
const PRIMARY: Modifiers = Modifiers::SUPER;
#[cfg(not(target_os = "macos"))]
const PRIMARY: Modifiers = Modifiers::CONTROL;

pub fn default_shortcut() -> Shortcut {
  Shortcut::new(Some(PRIMARY.union(Modifiers::SHIFT)), Code::KeyV)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutModifier {
  Control,
  Alt,
  Shift,
  Super,
}

impl ShortcutModifier {
  const ALL: [Self; 4] = [Self::Control, Self::Alt, Self::Shift, Self::Super];

  const fn flag(self) -> Modifiers {
    match self {
      Self::Control => Modifiers::CONTROL,
      Self::Alt => Modifiers::ALT,
      Self::Shift => Modifiers::SHIFT,
      Self::Super => Modifiers::SUPER,
    }
  }
}

/// A shortcut as the windows describe it: modifier names and a W3C key code
/// such as `KeyV`, the same physical-key naming the OS registration uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutKeys {
  pub modifiers: Vec<ShortcutModifier>,
  pub code: String,
}

impl ShortcutKeys {
  pub fn of(shortcut: &Shortcut) -> Self {
    Self {
      modifiers: ShortcutModifier::ALL
        .into_iter()
        .filter(|modifier| shortcut.mods.contains(modifier.flag()))
        .collect(),
      code: shortcut.key.to_string(),
    }
  }
}

/// What a reserved combination already does, so the window can name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReservedAction {
  Copy,
  Paste,
  Cut,
  Undo,
  Redo,
  SelectAll,
  Quit,
  CloseWindow,
  Hide,
  Minimize,
  AppSwitcher,
  Spotlight,
  InputSource,
  Screenshot,
  ForceQuit,
  WindowMenu,
  Start,
  TaskManager,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum ShortcutRejection {
  /// Without Control, Option/Alt or Command the shortcut would type text.
  NeedsModifier,
  /// Not a key the OS can register as a shortcut, including a lone modifier.
  UnsupportedKey,
  SystemReserved {
    action: ReservedAction,
  },
  /// Windows keeps Win-key combinations for itself.
  WindowsKeyReserved,
  /// The OS refused the registration: another app holds the combination.
  Taken,
}

const fn combo(modifiers: Modifiers, code: Code, action: ReservedAction) -> Reserved {
  Reserved {
    modifiers,
    code,
    action,
  }
}

struct Reserved {
  modifiers: Modifiers,
  code: Code,
  action: ReservedAction,
}

#[cfg(target_os = "macos")]
const RESERVED: &[Reserved] = {
  use Modifiers as M;
  use ReservedAction as A;
  const SHIFT_COMMAND: Modifiers = M::SHIFT.union(M::SUPER);
  &[
    combo(M::SUPER, Code::KeyC, A::Copy),
    combo(M::SUPER, Code::KeyV, A::Paste),
    combo(M::SUPER, Code::KeyX, A::Cut),
    combo(M::SUPER, Code::KeyZ, A::Undo),
    combo(SHIFT_COMMAND, Code::KeyZ, A::Redo),
    combo(M::SUPER, Code::KeyA, A::SelectAll),
    combo(M::SUPER, Code::KeyQ, A::Quit),
    combo(M::SUPER, Code::KeyW, A::CloseWindow),
    combo(M::SUPER, Code::KeyH, A::Hide),
    combo(M::SUPER, Code::KeyM, A::Minimize),
    combo(M::SUPER, Code::Tab, A::AppSwitcher),
    combo(M::SUPER, Code::Space, A::Spotlight),
    combo(M::CONTROL, Code::Space, A::InputSource),
    combo(SHIFT_COMMAND, Code::Digit3, A::Screenshot),
    combo(SHIFT_COMMAND, Code::Digit4, A::Screenshot),
    combo(SHIFT_COMMAND, Code::Digit5, A::Screenshot),
    combo(M::ALT.union(M::SUPER), Code::Escape, A::ForceQuit),
  ]
};

#[cfg(not(target_os = "macos"))]
const RESERVED: &[Reserved] = {
  use Modifiers as M;
  use ReservedAction as A;
  &[
    combo(M::CONTROL, Code::KeyC, A::Copy),
    combo(M::CONTROL, Code::KeyV, A::Paste),
    combo(M::CONTROL, Code::KeyX, A::Cut),
    combo(M::CONTROL, Code::KeyZ, A::Undo),
    combo(M::CONTROL, Code::KeyY, A::Redo),
    combo(M::CONTROL, Code::KeyA, A::SelectAll),
    combo(M::ALT, Code::Tab, A::AppSwitcher),
    combo(M::ALT, Code::F4, A::CloseWindow),
    combo(M::ALT, Code::Space, A::WindowMenu),
    combo(M::CONTROL, Code::Escape, A::Start),
    combo(M::CONTROL.union(M::SHIFT), Code::Escape, A::TaskManager),
  ]
};

/// Toggle keys the registration parser accepts but no one presses as a
/// shortcut's main key.
const LOCK_KEYS: &[Code] = &[Code::CapsLock, Code::NumLock, Code::ScrollLock];

/// The rules every candidate passes before the OS is asked to register it.
pub fn validate(keys: &ShortcutKeys) -> Result<Shortcut, ShortcutRejection> {
  // The registration parser, not the full W3C code list: it knows exactly
  // the keys the OS can register, and lone modifiers are not among them.
  if keys.code.contains('+') {
    return Err(ShortcutRejection::UnsupportedKey);
  }
  let code = Shortcut::from_str(&keys.code)
    .map(|parsed| parsed.key)
    .map_err(|_| ShortcutRejection::UnsupportedKey)?;
  if LOCK_KEYS.contains(&code) {
    return Err(ShortcutRejection::UnsupportedKey);
  }
  let modifiers = keys
    .modifiers
    .iter()
    .fold(Modifiers::empty(), |all, modifier| all | modifier.flag());
  if modifiers.difference(Modifiers::SHIFT).is_empty() {
    return Err(ShortcutRejection::NeedsModifier);
  }
  if cfg!(target_os = "windows") && modifiers.contains(Modifiers::SUPER) {
    return Err(ShortcutRejection::WindowsKeyReserved);
  }
  if let Some(reserved) = RESERVED
    .iter()
    .find(|reserved| reserved.modifiers == modifiers && reserved.code == code)
  {
    return Err(ShortcutRejection::SystemReserved {
      action: reserved.action,
    });
  }
  Ok(Shortcut::new(Some(modifiers), code))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutRegistration {
  Active,
  /// Released while a window records a new shortcut.
  Paused,
  /// The OS refused it; the clipboard stays reachable from the tray.
  Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardShortcutSnapshot {
  pub keys: ShortcutKeys,
  pub default_keys: ShortcutKeys,
  pub registration: ShortcutRegistration,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ShortcutCheck {
  Valid,
  Rejected { rejection: ShortcutRejection },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ShortcutUpdate {
  Saved {
    snapshot: ClipboardShortcutSnapshot,
  },
  Rejected {
    rejection: ShortcutRejection,
    snapshot: ClipboardShortcutSnapshot,
  },
}

pub struct ClipboardShortcut {
  current: Shortcut,
  registration: ShortcutRegistration,
  preference: DevicePreference,
}

pub type ClipboardShortcutState = Mutex<ClipboardShortcut>;

impl ClipboardShortcut {
  /// A stored value that no longer passes validation falls back to the
  /// default rather than registering something the rules now refuse.
  pub fn load() -> Self {
    let preference = DevicePreference::in_app_data(PREFERENCE_FILE_NAME);
    let current = preference
      .read()
      .and_then(|stored| Shortcut::from_str(&stored).ok())
      .filter(|stored| validate(&ShortcutKeys::of(stored)).is_ok())
      .unwrap_or_else(default_shortcut);
    Self {
      current,
      registration: ShortcutRegistration::Unavailable,
      preference,
    }
  }

  fn snapshot(&self) -> ClipboardShortcutSnapshot {
    ClipboardShortcutSnapshot {
      keys: ShortcutKeys::of(&self.current),
      default_keys: ShortcutKeys::of(&default_shortcut()),
      registration: self.registration,
    }
  }
}

fn on_pressed(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
  if event.state == ShortcutState::Pressed {
    crate::clipboard_window::toggle(app);
  }
}

fn register(app: &AppHandle, shortcut: Shortcut) -> bool {
  match app.global_shortcut().on_shortcut(shortcut, on_pressed) {
    Ok(()) => true,
    Err(error) => {
      tracing::warn!(error = %error, "clipboard shortcut registration was refused");
      false
    }
  }
}

fn unregister(app: &AppHandle, shortcut: Shortcut) {
  if let Err(error) = app.global_shortcut().unregister(shortcut) {
    tracing::warn!(error = %error, "clipboard shortcut could not be released");
  }
}

/// Registers the saved shortcut. A refusal is non-fatal: the shortcut may be
/// taken, and the clipboard stays reachable from the tray.
pub fn register_at_launch(app: &AppHandle) -> ShortcutRegistration {
  let state = app.state::<ClipboardShortcutState>();
  let Ok(mut shortcut) = state.lock() else {
    return ShortcutRegistration::Unavailable;
  };
  shortcut.registration = if register(app, shortcut.current) {
    ShortcutRegistration::Active
  } else {
    ShortcutRegistration::Unavailable
  };
  shortcut.registration
}

/// Re-registers a paused shortcut. Windows call this when recording ends
/// without a change, and the app calls it when a recording window closes.
pub fn resume(app: &AppHandle) {
  let state = app.state::<ClipboardShortcutState>();
  let Ok(mut shortcut) = state.lock() else {
    return;
  };
  if shortcut.registration != ShortcutRegistration::Paused {
    return;
  }
  shortcut.registration = if register(app, shortcut.current) {
    ShortcutRegistration::Active
  } else {
    ShortcutRegistration::Unavailable
  };
  drop(shortcut);
  let _ = app.emit(CHANGED_EVENT, ());
}

fn locked<'a>(
  state: &'a State<'_, ClipboardShortcutState>,
) -> Result<std::sync::MutexGuard<'a, ClipboardShortcut>, String> {
  state
    .lock()
    .map_err(|_| "clipboard shortcut state is unavailable".to_string())
}

#[tauri::command]
pub async fn shortcut_get_snapshot(
  state: State<'_, ClipboardShortcutState>,
) -> Result<ClipboardShortcutSnapshot, String> {
  Ok(locked(&state)?.snapshot())
}

#[tauri::command]
pub async fn shortcut_check(keys: ShortcutKeys) -> Result<ShortcutCheck, String> {
  Ok(match validate(&keys) {
    Ok(_) => ShortcutCheck::Valid,
    Err(rejection) => ShortcutCheck::Rejected { rejection },
  })
}

/// Releases the shortcut while a window records a new one; otherwise the OS
/// swallows the current combination before the window can see it.
#[tauri::command]
pub async fn shortcut_pause(
  app: AppHandle,
  state: State<'_, ClipboardShortcutState>,
) -> Result<ClipboardShortcutSnapshot, String> {
  let mut shortcut = locked(&state)?;
  if shortcut.registration == ShortcutRegistration::Active {
    unregister(&app, shortcut.current);
    shortcut.registration = ShortcutRegistration::Paused;
  }
  Ok(shortcut.snapshot())
}

#[tauri::command]
pub async fn shortcut_resume(
  app: AppHandle,
  state: State<'_, ClipboardShortcutState>,
) -> Result<ClipboardShortcutSnapshot, String> {
  resume(&app);
  Ok(locked(&state)?.snapshot())
}

/// Registers the new shortcut before releasing the old one, so a refusal or
/// a failed save leaves the previous shortcut working.
#[tauri::command]
pub async fn shortcut_set(
  app: AppHandle,
  state: State<'_, ClipboardShortcutState>,
  keys: ShortcutKeys,
) -> Result<ShortcutUpdate, String> {
  let mut shortcut = locked(&state)?;
  let next = match validate(&keys) {
    Ok(next) => next,
    Err(rejection) => {
      return Ok(ShortcutUpdate::Rejected {
        rejection,
        snapshot: shortcut.snapshot(),
      });
    }
  };
  let previous = shortcut.current;
  let previous_registration = shortcut.registration;
  if next != previous {
    if !register(&app, next) {
      restore(&app, &mut shortcut, previous_registration);
      return Ok(ShortcutUpdate::Rejected {
        rejection: ShortcutRejection::Taken,
        snapshot: shortcut.snapshot(),
      });
    }
    if let Err(error) = shortcut.preference.write(&next.into_string()) {
      unregister(&app, next);
      restore(&app, &mut shortcut, previous_registration);
      return Err(error);
    }
    if previous_registration == ShortcutRegistration::Active {
      unregister(&app, previous);
    }
    shortcut.current = next;
    shortcut.registration = ShortcutRegistration::Active;
  } else {
    restore(&app, &mut shortcut, previous_registration);
  }
  let snapshot = shortcut.snapshot();
  drop(shortcut);
  let _ = app.emit(CHANGED_EVENT, ());
  Ok(ShortcutUpdate::Saved { snapshot })
}

/// Puts the previous shortcut back after a candidate was not applied.
fn restore(
  app: &AppHandle,
  shortcut: &mut ClipboardShortcut,
  previous: ShortcutRegistration,
) {
  if previous == ShortcutRegistration::Paused {
    shortcut.registration = if register(app, shortcut.current) {
      ShortcutRegistration::Active
    } else {
      ShortcutRegistration::Unavailable
    };
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn keys(modifiers: &[ShortcutModifier], code: &str) -> ShortcutKeys {
    ShortcutKeys {
      modifiers: modifiers.to_vec(),
      code: code.to_string(),
    }
  }

  fn modifier_sets() -> Vec<Vec<ShortcutModifier>> {
    (0..16_u8)
      .map(|mask| {
        ShortcutModifier::ALL
          .into_iter()
          .enumerate()
          .filter(|(index, _)| mask & (1 << index) != 0)
          .map(|(_, modifier)| modifier)
          .collect()
      })
      .collect()
  }

  #[test]
  fn the_default_shortcut_passes_validation_and_round_trips_through_its_keys() {
    let default = default_shortcut();
    assert_eq!(validate(&ShortcutKeys::of(&default)), Ok(default));
    assert_eq!(
      Shortcut::from_str(&default.into_string()).ok(),
      Some(default)
    );
  }

  #[test]
  fn every_accepted_shortcut_round_trips_through_its_stored_form() {
    for modifiers in modifier_sets() {
      for code in ["KeyV", "KeyK", "Digit7", "Space", "F9", "Comma", "ArrowUp"] {
        let Ok(shortcut) = validate(&keys(&modifiers, code)) else {
          continue;
        };
        assert_eq!(ShortcutKeys::of(&shortcut).code, code);
        assert_eq!(
          Shortcut::from_str(&shortcut.into_string()).ok(),
          Some(shortcut)
        );
      }
    }
  }

  #[test]
  fn no_key_is_accepted_without_a_modifier_other_than_shift() {
    for code in ["KeyV", "Digit1", "Space", "Enter", "F1"] {
      assert_eq!(
        validate(&keys(&[], code)),
        Err(ShortcutRejection::NeedsModifier)
      );
      assert_eq!(
        validate(&keys(&[ShortcutModifier::Shift], code)),
        Err(ShortcutRejection::NeedsModifier)
      );
    }
  }

  #[test]
  fn every_reserved_combination_is_refused_with_its_action() {
    for reserved in RESERVED {
      let candidate =
        ShortcutKeys::of(&Shortcut::new(Some(reserved.modifiers), reserved.code));
      assert_eq!(
        validate(&candidate),
        Err(ShortcutRejection::SystemReserved {
          action: reserved.action
        })
      );
    }
  }

  #[test]
  fn lone_modifiers_and_unknown_codes_are_not_shortcut_keys() {
    for code in [
      "ShiftLeft",
      "MetaRight",
      "ControlLeft",
      "CapsLock",
      "Alt+KeyV",
      "NotAKey",
      "",
    ] {
      assert_eq!(
        validate(&keys(&[ShortcutModifier::Control], code)),
        Err(ShortcutRejection::UnsupportedKey)
      );
    }
  }

  #[test]
  fn win_key_combinations_are_refused_only_on_windows() {
    let result = validate(&keys(
      &[ShortcutModifier::Super, ShortcutModifier::Alt],
      "KeyK",
    ));
    if cfg!(target_os = "windows") {
      assert_eq!(result, Err(ShortcutRejection::WindowsKeyReserved));
    } else {
      assert!(result.is_ok());
    }
  }

  #[test]
  fn rejections_serialize_with_a_reason_the_windows_can_switch_on() {
    let reserved = serde_json::to_value(ShortcutRejection::SystemReserved {
      action: ReservedAction::SelectAll,
    })
    .unwrap();
    assert_eq!(
      reserved,
      serde_json::json!({ "reason": "systemReserved", "action": "selectAll" })
    );
    let taken = serde_json::to_value(ShortcutCheck::Rejected {
      rejection: ShortcutRejection::Taken,
    })
    .unwrap();
    assert_eq!(
      taken,
      serde_json::json!({ "status": "rejected", "rejection": { "reason": "taken" } })
    );
  }
}
