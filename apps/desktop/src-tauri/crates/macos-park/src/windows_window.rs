//! Bounded cross-process caption reads, with no window messages or logging.

use windows_sys::Win32::{
  Foundation::HWND,
  System::Threading::GetCurrentProcessId,
  UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
  },
};

const MAX_TITLE_UTF16_UNITS: usize = 512;
const TITLE_BUFFER_UNITS: i32 = 513;

fn process_for_window(window: HWND) -> Option<u32> {
  if window.is_null() {
    return None;
  }
  let mut process_id = 0;
  // SAFETY: HWND values are opaque handles checked by Windows; a destroyed
  // window fails. The output points to live stack storage for this call.
  let thread_id = unsafe { GetWindowThreadProcessId(window, &mut process_id) };
  (thread_id != 0 && process_id != 0).then_some(process_id)
}

/// Windows serves cross-process captions from cached window metadata, without
/// messaging the target. Skipping our own process avoids GetWindowTextW's
/// potentially blocking same-process WM_GETTEXT path.
pub fn focused_window_title(process_id: u32) -> Option<String> {
  // SAFETY: Both queries take no pointers and return OS-owned scalar/handle values.
  let (window, own_process_id) =
    unsafe { (GetForegroundWindow(), GetCurrentProcessId()) };
  if process_id == own_process_id || process_for_window(window)? != process_id {
    return None;
  }
  let mut buffer = [0u16; MAX_TITLE_UTF16_UNITS + 1];
  // SAFETY: The fixed buffer lives throughout the synchronous call and its
  // capacity matches nMaxCount. The window belongs to another process, so this
  // reads the cached caption rather than sending a blocking window message.
  let copied =
    unsafe { GetWindowTextW(window, buffer.as_mut_ptr(), TITLE_BUFFER_UNITS) };
  // SAFETY: This takes no pointers; HWND is compared only as an opaque handle.
  if copied <= 0
    || unsafe { GetForegroundWindow() } != window
    || process_for_window(window)? != process_id
  {
    return None;
  }
  // Reject possible truncation so privacy markers cannot be cut off the end.
  let copied = usize::try_from(copied).ok()?;
  if copied >= MAX_TITLE_UTF16_UNITS {
    return None;
  }
  String::from_utf16(&buffer[..copied]).ok()
}
