//! Types dictated text into the focused app as keyboard events, so inserting
//! it never touches the clipboard. Formatting arrives as the few keystrokes
//! `dictation_format` plans; nothing else presses a key.

use crate::dictation_format::{Key, Stroke};

/// How long typing waits for the speaker to let go of the shortcut.
#[cfg(any(target_os = "windows", test))]
const RELEASE_WAIT: std::time::Duration = std::time::Duration::from_secs(1);
#[cfg(target_os = "windows")]
const RELEASE_POLL: std::time::Duration = std::time::Duration::from_millis(10);

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

/// Asks `held` every `poll` until it reports nothing held, for at most
/// `limit`. Whether everything was released in time.
#[cfg(any(target_os = "windows", test))]
fn released_within(
  limit: std::time::Duration,
  poll: std::time::Duration,
  mut held: impl FnMut() -> bool,
) -> bool {
  let deadline = std::time::Instant::now() + limit;
  loop {
    if !held() {
      return true;
    }
    if std::time::Instant::now() >= deadline {
      return false;
    }
    std::thread::sleep(poll);
  }
}

/// Waits, briefly, until Control, Alt, Shift and the Windows keys are
/// physically up. Windows applies a held modifier to injected keys, so the
/// shortcut still held at release would turn the text into shortcuts. False
/// when one is still down after [`RELEASE_WAIT`]; nothing may be typed then.
#[cfg(target_os = "windows")]
pub fn wait_for_released_modifiers() -> bool {
  use winsafe::co::VK;

  released_within(RELEASE_WAIT, RELEASE_POLL, || {
    [VK::CONTROL, VK::MENU, VK::SHIFT, VK::LWIN, VK::RWIN]
      .into_iter()
      .any(winsafe::GetAsyncKeyState)
  })
}

/// macOS posts every event with its own modifier flags, so a held key does
/// not change what is typed.
#[cfg(not(target_os = "windows"))]
pub const fn wait_for_released_modifiers() -> bool {
  true
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

#[cfg(test)]
mod tests {
  use std::time::{Duration, Instant};

  use super::*;

  #[test]
  fn typing_goes_ahead_once_the_keys_are_released() {
    let mut polls = 0;
    assert!(released_within(
      RELEASE_WAIT,
      Duration::from_millis(1),
      || {
        polls += 1;
        polls < 4
      }
    ));
    assert_eq!(polls, 4);
  }

  #[test]
  fn keys_held_past_the_wait_type_nothing_and_the_wait_is_bounded() {
    let started = Instant::now();
    let limit = Duration::from_millis(40);
    assert!(!released_within(limit, Duration::from_millis(5), || true));
    let waited = started.elapsed();
    assert!(waited >= limit);
    assert!(waited < limit * 10);
  }
}
