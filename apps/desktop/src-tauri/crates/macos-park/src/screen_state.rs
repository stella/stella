//! Whether the screen could be read: on, locked, or the display asleep.
//! Activity reads it on each sample while no input comes; nothing is kept.

use objc2_core_foundation::{CFBoolean, CFDictionary, CFRetained, CFString, CFType};
use objc2_core_graphics::{
  CGDisplayIsAsleep, CGMainDisplayID, CGSessionCopyCurrentDictionary,
};

use crate::ScreenState;

/// The session key macOS sets while the lock screen covers the session.
const SCREEN_IS_LOCKED: &str = "CGSSessionScreenIsLocked";

/// The screen now. A lock wins over a sleeping display: macOS can lock as
/// the display sleeps, and the lock is what the member chose.
pub fn screen_state() -> ScreenState {
  if screen_is_locked() {
    return ScreenState::Locked;
  }
  if CGDisplayIsAsleep(CGMainDisplayID()) {
    return ScreenState::DisplayAsleep;
  }
  ScreenState::On
}

fn screen_is_locked() -> bool {
  // `None` outside a graphical session, where nothing can be locked.
  let Some(session) = CGSessionCopyCurrentDictionary() else {
    return false;
  };
  // SAFETY: CGSession.h documents the session dictionary as CFString keys
  // to CoreFoundation values; it is a copy this function owns and nothing
  // mutates it.
  let session: CFRetained<CFDictionary<CFString, CFType>> =
    unsafe { CFRetained::cast_unchecked(session) };
  session
    .get(&CFString::from_static_str(SCREEN_IS_LOCKED))
    .and_then(|value| value.downcast::<CFBoolean>().ok())
    .is_some_and(|locked| locked.as_bool())
}

#[cfg(test)]
mod tests {
  #[test]
  fn the_screen_state_reads_without_failing() {
    let _state = super::screen_state();
  }
}
