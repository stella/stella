//! The languages this user works in, as language tags: the preferred
//! languages in System Settings and the languages of the enabled keyboard
//! input sources. Only tags are read, never anything typed.

use core_foundation::{
  array::{CFArray, CFArrayRef},
  base::{CFType, CFTypeRef, TCFType},
  string::{CFString, CFStringRef},
};
use objc2::MainThreadMarker;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
  fn CFLocaleCopyPreferredLanguages() -> CFArrayRef;
}

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
  fn TISCreateInputSourceList(
    properties: CFTypeRef,
    include_all_installed: u8,
  ) -> CFArrayRef;
  fn TISGetInputSourceProperty(source: CFTypeRef, key: CFStringRef) -> CFTypeRef;
  static kTISPropertyInputSourceCategory: CFStringRef;
  static kTISCategoryKeyboardInputSource: CFStringRef;
  static kTISPropertyInputSourceLanguages: CFStringRef;
}

fn strings(array: &CFArray) -> Vec<String> {
  array
    .iter()
    .filter_map(|item| {
      if item.is_null() {
        return None;
      }
      // SAFETY: A non-null CFArray element is a live CF object the array
      // retains for at least as long as `array` is borrowed here.
      let value = unsafe { CFType::wrap_under_get_rule(*item) };
      value
        .downcast_into::<CFString>()
        .map(|text| text.to_string())
    })
    .collect()
}

/// The preferred languages in their order, such as `en-CZ` then `cs-CZ`.
pub fn preferred_languages() -> Vec<String> {
  // SAFETY: The function takes no arguments and returns a new array (or
  // null), owned here under the create rule.
  let array = unsafe { CFLocaleCopyPreferredLanguages() };
  if array.is_null() {
    return Vec::new();
  }
  // SAFETY: Non-null and owned by this call, as checked above.
  let array =
    unsafe { CFArray::<*const std::ffi::c_void>::wrap_under_create_rule(array) };
  strings(&array)
}

/// The primary language of every enabled keyboard layout or input method.
/// Text Input Sources answer reliably only on the main thread, hence the
/// marker.
pub fn keyboard_languages(_main_thread: MainThreadMarker) -> Vec<String> {
  // SAFETY: A null filter with `false` lists the enabled input sources; the
  // array is new and owned here under the create rule.
  let sources = unsafe { TISCreateInputSourceList(std::ptr::null(), 0) };
  if sources.is_null() {
    return Vec::new();
  }
  // SAFETY: Non-null and owned by this call, as checked above.
  let sources =
    unsafe { CFArray::<*const std::ffi::c_void>::wrap_under_create_rule(sources) };
  // SAFETY: The framework exports immortal CFString constants.
  let (category_key, keyboard, languages_key) = unsafe {
    (
      kTISPropertyInputSourceCategory,
      CFString::wrap_under_get_rule(kTISCategoryKeyboardInputSource),
      kTISPropertyInputSourceLanguages,
    )
  };
  sources
    .iter()
    .filter_map(|source| {
      let source = *source;
      if source.is_null() {
        return None;
      }
      // SAFETY: `source` is a live input source the list retains; property
      // values follow the get rule and are retained by the wrappers below.
      let category = unsafe { TISGetInputSourceProperty(source, category_key) };
      // SAFETY: As above.
      let languages = unsafe { TISGetInputSourceProperty(source, languages_key) };
      if category.is_null() || languages.is_null() {
        return None;
      }
      // SAFETY: Non-null CF objects owned by the source, as checked above.
      let (category, languages) = unsafe {
        (
          CFType::wrap_under_get_rule(category),
          CFType::wrap_under_get_rule(languages),
        )
      };
      if category.downcast_into::<CFString>()? != keyboard {
        return None;
      }
      let languages = languages.downcast_into::<CFArray>()?;
      strings(&languages).into_iter().next()
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn preferred_languages_are_language_tags() {
    for tag in preferred_languages() {
      assert!(!tag.is_empty());
      assert!(
        tag
          .chars()
          .all(|character| character.is_ascii_alphanumeric()
            || character == '-'
            || character == '_')
      );
    }
  }
}
