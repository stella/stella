//! Bounded Accessibility reads for explicitly enabled local activity capture.

use core_foundation::{
  base::{CFType, CFTypeRef, TCFType},
  boolean::CFBoolean,
  dictionary::{CFDictionary, CFDictionaryRef},
  string::{CFString, CFStringRef},
  url::{CFURL, CFURLCopyFileSystemPath, CFURLCreateWithString, kCFURLPOSIXPathStyle},
};
use std::ptr;

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
}

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
  if remainder[slash..].contains(['?', '#']) || value.chars().any(char::is_control) {
    return None;
  }
  let string = CFString::new(value);
  // SAFETY: CFURL reads a live CFString, with no base URL. Its nullable Create
  // result is checked before ownership is wrapped and released by CFURL.
  let reference = unsafe {
    CFURLCreateWithString(ptr::null_mut(), string.as_concrete_TypeRef(), ptr::null())
  };
  if reference.is_null() {
    return None;
  }
  // SAFETY: The non-null reference was returned by CFURLCreateWithString.
  let url = unsafe { CFURL::wrap_under_create_rule(reference) };
  // A CFString preserves embedded NULs for validation; converting through a
  // C filesystem buffer would truncate an encoded NUL before we can reject it.
  // SAFETY: The live file URL is owned above; this nullable Copy result is
  // checked and owned before inspecting its type or contents.
  let path = owned_type(unsafe {
    CFURLCopyFileSystemPath(url.as_concrete_TypeRef(), kCFURLPOSIXPathStyle).cast()
  })?
  .downcast::<CFString>()?
  .to_string();
  if !std::path::Path::new(&path).is_absolute()
    || path.starts_with("//")
    || path.chars().any(char::is_control)
  {
    return None;
  }
  Some(path)
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

#[cfg(test)]
mod tests {
  use super::local_document_path;

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
    for value in [
      "https://example.test/Matter.docx",
      "file://server/share/Matter.docx",
      "file://user@localhost/Matter.docx",
      "file:///Matter.docx?token=sensitive",
      "file:///Matter.docx#fragment",
      "file:///Matter%00.docx",
      "file:///Matter%0A.docx",
      "file:////server/share/Matter.docx",
      "file:relative.docx",
    ] {
      assert_eq!(local_document_path(value), None);
    }
  }
}
