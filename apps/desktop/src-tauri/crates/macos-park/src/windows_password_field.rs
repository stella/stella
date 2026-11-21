//! Whether the control that has keyboard focus in another app is a password
//! field. Asks the focused control for its password character with a short
//! timeout, so a hung app cannot stall the caller. Classic edit controls
//! answer; controls drawn by an app itself (browsers, Electron) do not, and
//! read as not secure.

use std::{mem::size_of, ptr};

use windows_sys::Win32::{
  System::Threading::GetCurrentProcessId,
  UI::WindowsAndMessaging::{
    GUITHREADINFO, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId,
    SMTO_ABORTIFHUNG, SendMessageTimeoutW,
  },
};

/// `EM_GETPASSWORDCHAR`: nonzero from an edit control that hides its text.
const EM_GETPASSWORDCHAR: u32 = 0x00D2;
const TIMEOUT_MILLIS: u32 = 100;

/// Whether the focused control of the foreground window, in process
/// `process_id`, hides what is typed. False when it cannot be read.
pub fn focused_field_is_secure(process_id: u32) -> bool {
  // SAFETY: Both queries take no pointers and return OS-owned values.
  let (window, own_process_id) =
    unsafe { (GetForegroundWindow(), GetCurrentProcessId()) };
  if window.is_null() || process_id == own_process_id {
    return false;
  }
  let mut window_process = 0;
  // SAFETY: The output points to live stack storage for this call; a
  // destroyed window fails.
  let thread_id = unsafe { GetWindowThreadProcessId(window, &raw mut window_process) };
  if thread_id == 0 || window_process != process_id {
    return false;
  }
  let mut info = GUITHREADINFO {
    cbSize: size_of::<GUITHREADINFO>() as u32,
    ..GUITHREADINFO::default()
  };
  // SAFETY: `info` is live, writable and carries its own size.
  if unsafe { GetGUIThreadInfo(thread_id, &raw mut info) } == 0
    || info.hwndFocus.is_null()
  {
    return false;
  }
  let mut password_char = 0_usize;
  // SAFETY: The message carries no pointers; the result points to live stack
  // storage, and the timeout bounds a busy or hung target.
  let answered = unsafe {
    SendMessageTimeoutW(
      info.hwndFocus,
      EM_GETPASSWORDCHAR,
      0,
      0,
      SMTO_ABORTIFHUNG,
      TIMEOUT_MILLIS,
      ptr::from_mut(&mut password_char),
    )
  };
  answered != 0 && password_char != 0
}
