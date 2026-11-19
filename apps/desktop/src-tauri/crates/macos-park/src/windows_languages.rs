//! The languages this user works in on Windows, as language tags: the
//! preferred display languages and the languages of the installed input
//! languages (keyboard layouts). Only tags are read, never anything typed.

use windows_sys::Win32::{
  Globalization::{GetUserPreferredUILanguages, LCIDToLocaleName, MUI_LANGUAGE_NAME},
  UI::Input::KeyboardAndMouse::{GetKeyboardLayoutList, HKL},
};

/// Longest locale name, including the terminating null.
const MAX_LOCALE_NAME: usize = 85;
const MAX_LAYOUTS: usize = 64;
const MAX_LANGUAGE_UNITS: u32 = 4096;

/// The preferred display languages in their order, such as `cs-CZ`.
pub fn preferred_languages() -> Vec<String> {
  let mut count = 0_u32;
  let mut units = MAX_LANGUAGE_UNITS;
  let mut buffer = vec![0_u16; units as usize];
  // SAFETY: Both out-pointers are live locals and the buffer holds `units`
  // UTF-16 units, which the call writes at most.
  let read = unsafe {
    GetUserPreferredUILanguages(
      MUI_LANGUAGE_NAME,
      &raw mut count,
      buffer.as_mut_ptr(),
      &raw mut units,
    )
  };
  if read == 0 {
    return Vec::new();
  }
  buffer.truncate((units as usize).min(buffer.len()));
  buffer
    .split(|unit| *unit == 0)
    .filter(|name| !name.is_empty())
    .filter_map(|name| String::from_utf16(name).ok())
    .collect()
}

/// The language of every installed input language, in the system's order.
pub fn keyboard_languages() -> Vec<String> {
  let mut layouts: [HKL; MAX_LAYOUTS] = [std::ptr::null_mut(); MAX_LAYOUTS];
  // SAFETY: The array holds `MAX_LAYOUTS` handles, the most the call writes.
  let count =
    unsafe { GetKeyboardLayoutList(MAX_LAYOUTS as i32, layouts.as_mut_ptr()) };
  let count = usize::try_from(count).unwrap_or(0).min(MAX_LAYOUTS);
  layouts[..count]
    .iter()
    .filter_map(|layout| {
      // The low word of a layout handle is its language identifier.
      let language = (*layout as usize & 0xFFFF) as u32;
      let mut name = [0_u16; MAX_LOCALE_NAME];
      // SAFETY: The buffer holds `MAX_LOCALE_NAME` units, the most a locale
      // name takes; the call writes at most that many.
      let written = unsafe {
        LCIDToLocaleName(language, name.as_mut_ptr(), MAX_LOCALE_NAME as i32, 0)
      };
      let written = usize::try_from(written).ok()?.checked_sub(1)?;
      String::from_utf16(&name[..written.min(MAX_LOCALE_NAME)]).ok()
    })
    .collect()
}
