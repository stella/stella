//! Types text into the focused app as keyboard events, so inserting text
//! never touches the clipboard.

use std::{thread, time::Duration};

use objc2_core_graphics::{CGEvent, CGEventFlags, CGEventTapLocation};

/// `CGEventKeyboardSetUnicodeString` honours about twenty UTF-16 units.
const CHUNK_UNITS: usize = 16;
/// Lets the receiving app drain its queue between chunks.
const CHUNK_PAUSE: Duration = Duration::from_millis(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypeTextError;

/// Posts `text` to the session. The system drops these events silently
/// unless the process holds Accessibility access; check that first.
pub fn type_text(text: &str) -> Result<(), TypeTextError> {
  let units = text.encode_utf16().collect::<Vec<_>>();
  for chunk in chunks(&units) {
    for key_down in [true, false] {
      let event =
        CGEvent::new_keyboard_event(None, 0, key_down).ok_or(TypeTextError)?;
      // Modifiers still held from a shortcut must not reach the app.
      CGEvent::set_flags(Some(&event), CGEventFlags::empty());
      // SAFETY: `chunk` outlives the call, which copies `chunk.len()` units.
      unsafe {
        CGEvent::keyboard_set_unicode_string(
          Some(&event),
          chunk.len() as _,
          chunk.as_ptr(),
        );
      }
      CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    }
    thread::sleep(CHUNK_PAUSE);
  }
  Ok(())
}

/// Splits UTF-16 into event-sized chunks without separating a surrogate pair.
fn chunks(units: &[u16]) -> Vec<&[u16]> {
  let mut parts = Vec::new();
  let mut rest = units;
  while !rest.is_empty() {
    let mut end = rest.len().min(CHUNK_UNITS);
    if end < rest.len() && (0xD800..0xDC00).contains(&rest[end - 1]) {
      end -= 1;
    }
    let (part, tail) = rest.split_at(end);
    parts.push(part);
    rest = tail;
  }
  parts
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn chunks_keep_every_unit_in_order() {
    let units = "Příliš žluťoučký kůň úpěl ďábelské ódy"
      .encode_utf16()
      .collect::<Vec<_>>();

    let parts = chunks(&units);

    assert!(parts.iter().all(|part| part.len() <= CHUNK_UNITS));
    assert_eq!(parts.concat(), units);
  }

  #[test]
  fn chunks_never_split_a_surrogate_pair() {
    let text = format!("{}😀tail", "a".repeat(CHUNK_UNITS - 1));
    let units = text.encode_utf16().collect::<Vec<_>>();

    let parts = chunks(&units);

    for part in parts {
      assert!(String::from_utf16(part).is_ok());
    }
  }

  #[test]
  fn chunks_of_nothing_are_empty() {
    assert!(chunks(&[]).is_empty());
  }
}
