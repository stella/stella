//! Types dictated text into the focused app as keyboard events, so inserting
//! it never touches the clipboard. Formatting arrives as the few keystrokes
//! `dictation_format` plans; nothing else presses a key.

use crate::dictation_format::{Key, Stroke};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypeTextFailed;

/// Sends every stroke in order and stops at the first one the system refuses.
pub fn send(strokes: &[Stroke]) -> Result<(), TypeTextFailed> {
  for stroke in strokes {
    match stroke {
      Stroke::Text(text) => type_text(text)?,
      Stroke::Key(key) => press(*key, false, false)?,
      Stroke::Shift(key) => press(*key, false, true)?,
      Stroke::Command(key) => press(*key, true, false)?,
    }
  }
  Ok(())
}

/// Whether the system lets this app type into others. Asks when it does not.
#[cfg(target_os = "macos")]
pub fn request_access() -> bool {
  stella_desktop_macos::accessibility_trusted()
    || stella_desktop_macos::request_accessibility_permission()
}

#[cfg(target_os = "macos")]
fn type_text(text: &str) -> Result<(), TypeTextFailed> {
  stella_desktop_macos::type_text(text).map_err(|_error| TypeTextFailed)
}

/// `command` is the Command key on macOS.
#[cfg(target_os = "macos")]
fn press(key: Key, command: bool, shift: bool) -> Result<(), TypeTextFailed> {
  use stella_desktop_macos::FormattingKey;

  let key = match key {
    Key::Return => FormattingKey::Return,
    Key::B => FormattingKey::B,
  };
  stella_desktop_macos::press_key(key, command, shift).map_err(|_error| TypeTextFailed)
}

/// Windows lets any app of the same integrity level send input.
#[cfg(target_os = "windows")]
pub const fn request_access() -> bool {
  true
}

#[cfg(target_os = "windows")]
fn type_text(text: &str) -> Result<(), TypeTextFailed> {
  use winsafe::{self as w, co};

  let units = text.encode_utf16().collect::<Vec<_>>();
  for chunk in units.chunks(CHUNK_UNITS) {
    let events = chunk
      .iter()
      .flat_map(|unit| {
        [
          co::KEYEVENTF::UNICODE,
          co::KEYEVENTF::UNICODE | co::KEYEVENTF::KEYUP,
        ]
        .map(|flags| {
          w::HwKbMouse::Kb(w::KEYBDINPUT {
            wScan: *unit,
            dwFlags: flags,
            ..Default::default()
          })
        })
      })
      .collect::<Vec<_>>();
    send_input(&events)?;
    std::thread::sleep(CHUNK_PAUSE);
  }
  Ok(())
}

/// `command` is the Control key on Windows. The modifier goes down before the
/// key and up after it, in one batch no other input can interleave with.
#[cfg(target_os = "windows")]
fn press(key: Key, command: bool, shift: bool) -> Result<(), TypeTextFailed> {
  use winsafe::{self as w, co};

  let key = match key {
    Key::Return => co::VK::RETURN,
    Key::B => co::VK::CHAR_B,
  };
  let modifiers = [(command, co::VK::CONTROL), (shift, co::VK::SHIFT)]
    .into_iter()
    .filter_map(|(held, modifier)| held.then_some(modifier))
    .collect::<Vec<_>>();
  let event = |key: co::VK, up: bool| {
    w::HwKbMouse::Kb(w::KEYBDINPUT {
      wVk: key,
      dwFlags: if up {
        co::KEYEVENTF::KEYUP
      } else {
        co::KEYEVENTF::default()
      },
      ..Default::default()
    })
  };
  let events = modifiers
    .iter()
    .map(|modifier| event(*modifier, false))
    .chain([event(key, false), event(key, true)])
    .chain(
      modifiers
        .iter()
        .rev()
        .map(|modifier| event(*modifier, true)),
    )
    .collect::<Vec<_>>();
  send_input(&events)?;
  std::thread::sleep(CHUNK_PAUSE);
  Ok(())
}

#[cfg(target_os = "windows")]
fn send_input(events: &[winsafe::HwKbMouse]) -> Result<(), TypeTextFailed> {
  let sent = winsafe::SendInput(events).map_err(|_error| TypeTextFailed)?;
  if sent as usize == events.len() {
    Ok(())
  } else {
    Err(TypeTextFailed)
  }
}

/// Lets the receiving app drain its queue between chunks.
#[cfg(target_os = "windows")]
const CHUNK_PAUSE: std::time::Duration = std::time::Duration::from_millis(2);
#[cfg(target_os = "windows")]
const CHUNK_UNITS: usize = 64;
