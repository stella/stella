//! Types dictated text into the focused app as keyboard events, so inserting
//! it never touches the clipboard.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypeTextFailed;

/// Whether the system lets this app type into others. Asks when it does not.
#[cfg(target_os = "macos")]
pub fn request_access() -> bool {
  stella_desktop_macos::accessibility_trusted()
    || stella_desktop_macos::request_accessibility_permission()
}

#[cfg(target_os = "macos")]
pub fn type_text(text: &str) -> Result<(), TypeTextFailed> {
  stella_desktop_macos::type_text(text).map_err(|_error| TypeTextFailed)
}

/// Windows lets any app of the same integrity level send input.
#[cfg(target_os = "windows")]
pub const fn request_access() -> bool {
  true
}

#[cfg(target_os = "windows")]
pub fn type_text(text: &str) -> Result<(), TypeTextFailed> {
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
    let sent = w::SendInput(&events).map_err(|_error| TypeTextFailed)?;
    if sent as usize != events.len() {
      return Err(TypeTextFailed);
    }
    std::thread::sleep(CHUNK_PAUSE);
  }
  Ok(())
}

/// Lets the receiving app drain its queue between chunks.
#[cfg(target_os = "windows")]
const CHUNK_PAUSE: std::time::Duration = std::time::Duration::from_millis(2);
#[cfg(target_os = "windows")]
const CHUNK_UNITS: usize = 64;
