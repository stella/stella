//! Bounded Accessibility reads for explicitly enabled local activity capture
//! and for the dictation context a speaker chose to share with cleanup.

use core_foundation::{
  base::{CFIndex, CFRange, CFType, CFTypeRef, TCFType},
  boolean::CFBoolean,
  dictionary::{CFDictionary, CFDictionaryRef},
  string::{CFString, CFStringGetCharacters, CFStringRef},
};
use std::{ffi::c_void, ptr};

const AX_SUCCESS: i32 = 0;
const AX_TIMEOUT_SECONDS: f32 = 0.15;
// Reject oversized values rather than dropping a private-window suffix.
const MAX_ATTRIBUTE_UTF16_UNITS: isize = 16_384;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
  fn AXIsProcessTrusted() -> u8;
  fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
  static kAXTrustedCheckOptionPrompt: CFStringRef;
  fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
  fn AXUIElementGetTypeID() -> usize;
  fn AXUIElementCopyAttributeValue(
    element: CFTypeRef,
    attribute: CFStringRef,
    value: *mut CFTypeRef,
  ) -> i32;
  fn AXUIElementSetMessagingTimeout(element: CFTypeRef, timeout: f32) -> i32;
  fn AXValueGetTypeID() -> usize;
  fn AXValueGetType(value: CFTypeRef) -> u32;
  fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> u8;
}

/// `kAXValueTypeCFRange` in `AXValue.h`.
const AX_VALUE_TYPE_CF_RANGE: u32 = 4;
const SECURE_TEXT_FIELD: &str = "AXSecureTextField";

pub struct FocusedWindowDetails {
  pub window_title: Option<String>,
  pub document: Option<String>,
}

pub fn accessibility_trusted() -> bool {
  // SAFETY: This process-wide query takes no pointers and cannot prompt.
  unsafe { AXIsProcessTrusted() != 0 }
}

/// Requests the system prompt; the returned trust state can remain false
/// because permission is granted asynchronously in System Settings.
pub fn request_accessibility_permission() -> bool {
  // SAFETY: The framework exports an immortal CFString constant.
  let prompt = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
  let options = CFDictionary::from_CFType_pairs(&[(prompt, CFBoolean::true_value())]);
  // SAFETY: The dictionary owns a valid CFString/CFBoolean pair for the call.
  unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0 }
}

fn owned_type(reference: CFTypeRef) -> Option<CFType> {
  if reference.is_null() {
    return None;
  }
  // SAFETY: Callers supply non-null Create/Copy-rule references owned here.
  Some(unsafe { CFType::wrap_under_create_rule(reference) })
}

fn attribute(element: &CFType, name: &str) -> Option<CFType> {
  let name = CFString::new(name);
  let mut value = ptr::null();
  // SAFETY: The live AX element and CFString remain owned during the call;
  // the output points to stack storage. Successful Copy results are retained.
  let status = unsafe {
    AXUIElementCopyAttributeValue(
      element.as_CFTypeRef(),
      name.as_concrete_TypeRef(),
      &mut value,
    )
  };
  if status != AX_SUCCESS {
    return None;
  }
  owned_type(value)
}

fn focused_window(application: &CFType) -> Option<CFType> {
  let window = attribute(application, "AXFocusedWindow")?;
  // SAFETY: The framework's type-ID query has no arguments or ownership effects.
  if window.type_of() != unsafe { AXUIElementGetTypeID() } {
    return None;
  }
  // AX timeouts apply to each object, not to objects reached through it.
  set_timeout(&window).then_some(window)
}

fn set_timeout(element: &CFType) -> bool {
  // SAFETY: Callers hold a live, type-checked AX element; the timeout is positive.
  unsafe {
    AXUIElementSetMessagingTimeout(element.as_CFTypeRef(), AX_TIMEOUT_SECONDS)
      == AX_SUCCESS
  }
}

fn string_attribute(element: &CFType, name: &str) -> Result<Option<String>, ()> {
  let Some(string) =
    attribute(element, name).and_then(|value| value.downcast::<CFString>())
  else {
    return Ok(None);
  };
  if string.char_len() > MAX_ATTRIBUTE_UTF16_UNITS {
    return Err(());
  }
  Ok(Some(string.to_string()))
}

fn local_document_path(value: &str) -> Option<String> {
  // Only local file authorities are accepted, including percent-encoded paths.
  let remainder = value.strip_prefix("file://")?;
  let slash = remainder.find('/')?;
  let authority = &remainder[..slash];
  if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
    return None;
  }
  // A raw backslash is ambiguous: URL parsing reads it as a separator, so the
  // path would name another document. A literal one arrives encoded (%5C).
  if remainder[slash..].starts_with("//")
    || remainder[slash..].contains(['?', '#', '\\'])
    || value.chars().any(char::is_control)
  {
    return None;
  }
  let path = tauri::Url::parse(value).ok()?.to_file_path().ok()?;
  let path = path.to_str()?;
  if !std::path::Path::new(path).is_absolute()
    || path.starts_with("//")
    || path.chars().any(char::is_control)
  {
    return None;
  }
  Some(path.to_string())
}

/// Reads one focused window without prompting or logging captured values.
/// A focus change during the bounded reads discards the observation.
pub fn focused_window_details(pid: i32) -> Option<FocusedWindowDetails> {
  if pid <= 0 || !accessibility_trusted() {
    return None;
  }
  // SAFETY: A positive process ID is accepted by AX; its Create result is owned
  // below. A process exit yields failed attribute reads, not pointer misuse.
  let application = owned_type(unsafe { AXUIElementCreateApplication(pid) })?;
  if !set_timeout(&application) {
    return None;
  }
  let window = focused_window(&application)?;
  let window_title = string_attribute(&window, "AXTitle").ok()?;
  let document = string_attribute(&window, "AXDocument")
    .ok()?
    .and_then(|value| local_document_path(&value));
  if window != focused_window(&application)? {
    return None;
  }
  Some(FocusedWindowDetails {
    window_title,
    document,
  })
}

/// Where the insertion point of a text element is: the start of its
/// selection, in UTF-16 units, as Accessibility reports it.
fn selection_start(element: &CFType) -> Option<CFIndex> {
  let value = attribute(element, "AXSelectedTextRange")?;
  // SAFETY: The framework's type-ID query has no arguments or ownership effects.
  if value.type_of() != unsafe { AXValueGetTypeID() } {
    return None;
  }
  // SAFETY: `value` is a live AXValue, checked above; the query only reads it.
  if unsafe { AXValueGetType(value.as_CFTypeRef()) } != AX_VALUE_TYPE_CF_RANGE {
    return None;
  }
  let mut range = CFRange {
    location: 0,
    length: 0,
  };
  // SAFETY: A CFRange AXValue, checked above, copies exactly one CFRange into
  // the stack value the pointer names, which outlives the call.
  let copied = unsafe {
    AXValueGetValue(
      value.as_CFTypeRef(),
      AX_VALUE_TYPE_CF_RANGE,
      ptr::from_mut(&mut range).cast(),
    )
  };
  (copied != 0 && range.location >= 0).then_some(range.location)
}

/// Up to `max_characters` characters right before the insertion point of the
/// focused text element of process `pid`, read without prompting or logging.
/// `None` for a password field, an element without text or an insertion
/// point, and whenever a read fails: the caller then goes on without it.
pub fn text_before_cursor(pid: i32, max_characters: usize) -> Option<String> {
  if pid <= 0 || max_characters == 0 || !accessibility_trusted() {
    return None;
  }
  // SAFETY: A positive process ID is accepted by AX; its Create result is owned
  // below. A process exit yields failed attribute reads, not pointer misuse.
  let application = owned_type(unsafe { AXUIElementCreateApplication(pid) })?;
  if !set_timeout(&application) {
    return None;
  }
  let element = attribute(&application, "AXFocusedUIElement")?;
  // SAFETY: The framework's type-ID query has no arguments or ownership effects.
  if element.type_of() != unsafe { AXUIElementGetTypeID() } || !set_timeout(&element) {
    return None;
  }
  // A password field never gives its text away, whatever else it reports.
  for name in ["AXRole", "AXSubrole"] {
    if string_attribute(&element, name).ok()?.as_deref() == Some(SECURE_TEXT_FIELD) {
      return None;
    }
  }
  let end = selection_start(&element)?;
  let value = attribute(&element, "AXValue")?.downcast::<CFString>()?;
  if end == 0 || end > value.char_len() {
    return None;
  }
  // A character takes at most two UTF-16 units.
  let wanted = CFIndex::try_from(max_characters.saturating_mul(2))
    .ok()?
    .min(end);
  let mut units = vec![0_u16; usize::try_from(wanted).ok()?];
  // SAFETY: The range lies inside the string (0 <= end - wanted < end <=
  // length) and the buffer holds exactly `wanted` units for the copy.
  unsafe {
    CFStringGetCharacters(
      value.as_concrete_TypeRef(),
      CFRange {
        location: end - wanted,
        length: wanted,
      },
      units.as_mut_ptr(),
    );
  }
  // A surrogate pair the cut splits decodes to nothing, not a replacement.
  let text: String = char::decode_utf16(units).filter_map(Result::ok).collect();
  let count = text.chars().count();
  Some(
    text
      .chars()
      .skip(count.saturating_sub(max_characters))
      .collect(),
  )
}

#[cfg(test)]
mod tests {
  use super::local_document_path;

  #[test]
  fn documents_reject_every_percent_encoded_ascii_control() {
    for byte in (0..=31).chain(std::iter::once(127)) {
      for encoded in [format!("%{byte:02X}"), format!("%{byte:02x}")] {
        assert_eq!(
          local_document_path(&format!("file:///Matter{encoded}.docx")),
          None,
        );
      }
    }
    assert_eq!(
      local_document_path("file:///Matter%2500.docx").as_deref(),
      Some("/Matter%00.docx"),
    );
  }

  #[test]
  fn documents_accept_only_local_file_urls() {
    assert_eq!(
      local_document_path("file:///Volumes/Matters/Matter%20notes.docx").as_deref(),
      Some("/Volumes/Matters/Matter notes.docx")
    );
    assert_eq!(
      local_document_path("file://localhost/Volumes/Matters/Matter.docx").as_deref(),
      Some("/Volumes/Matters/Matter.docx")
    );
    assert_eq!(
      local_document_path("file:///Users/me/Matter%5Cnotes.docx").as_deref(),
      Some("/Users/me/Matter\\notes.docx")
    );
    for value in [
      "https://example.test/Matter.docx",
      "file://server/share/Matter.docx",
      "file://user@localhost/Matter.docx",
      "file:///Matter.docx?token=sensitive",
      "file:///Matter.docx#fragment",
      "file:///Matter%00.docx",
      "file:///Matter%0A.docx",
      "file:////server/share/Matter.docx",
      "file:///%2Fserver/share/Matter.docx",
      "file:relative.docx",
      "file:///Users/me/Matter\\notes.docx",
    ] {
      assert_eq!(local_document_path(value), None);
    }
  }
}
