//! How long the user has given no keyboard or pointer input.
//!
//! Both platforms expose this through safe bindings (CoreGraphics' event
//! source state on macOS, `GetLastInputInfo` on Windows), so no `unsafe`
//! code is needed here. Other platforms report nothing.

use std::time::Duration;

#[cfg(target_os = "macos")]
pub fn since_last_input() -> Option<Duration> {
  use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType};

  // kCGAnyInputEventType: every keyboard, pointer and tablet event.
  const ANY_INPUT_EVENT: CGEventType = CGEventType(u32::MAX);
  let seconds = CGEventSource::seconds_since_last_event_type(
    CGEventSourceStateID::CombinedSessionState,
    ANY_INPUT_EVENT,
  );
  Duration::try_from_secs_f64(seconds).ok()
}

#[cfg(target_os = "windows")]
pub fn since_last_input() -> Option<Duration> {
  let last_input = winsafe::GetLastInputInfo().ok()?;
  // `dwTime` is a 32-bit tick count; the low half of the 64-bit count is
  // the same clock, and wrapping subtraction survives the 49.7-day rollover.
  #[allow(
    clippy::cast_possible_truncation,
    reason = "the low 32 bits are GetTickCount, the clock dwTime uses"
  )]
  let now = winsafe::GetTickCount64() as u32;
  Some(Duration::from_millis(u64::from(
    now.wrapping_sub(last_input.dwTime),
  )))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn since_last_input() -> Option<Duration> {
  None
}
