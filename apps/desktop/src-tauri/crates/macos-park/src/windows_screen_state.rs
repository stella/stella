//! Whether the screen could be read: on, locked, or the display off.
//! Activity reads it on each sample while no input comes; nothing is kept.
//!
//! Windows has no call that reports the display's power state, only a
//! notification, so the first read subscribes to it for the life of the
//! process and keeps the last state it delivered. The system sends the
//! current state as soon as the subscription is made.

use std::sync::{
  Once,
  atomic::{AtomicU8, Ordering},
};

use windows_sys::{
  Win32::{
    Foundation::ERROR_SUCCESS,
    System::{
      Power::{
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, POWERBROADCAST_SETTING,
        PowerSettingRegisterNotification,
      },
      StationsAndDesktops::{CloseDesktop, DESKTOP_SWITCHDESKTOP, OpenInputDesktop},
      SystemServices::GUID_CONSOLE_DISPLAY_STATE,
    },
    UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_POWERSETTINGCHANGE},
  },
  core::GUID,
};

use crate::ScreenState;

/// `GUID_CONSOLE_DISPLAY_STATE` values.
const DISPLAY_OFF: u8 = 0;
const DISPLAY_ON: u8 = 1;

static DISPLAY_STATE: AtomicU8 = AtomicU8::new(DISPLAY_ON);
static SUBSCRIBE: Once = Once::new();

/// The screen now. A lock wins over a display that is off: the lock is what
/// the member chose.
pub fn screen_state() -> ScreenState {
  SUBSCRIBE.call_once(subscribe_to_display_state);
  if input_desktop_is_locked() {
    return ScreenState::Locked;
  }
  // Dimmed (2) still shows the screen.
  if DISPLAY_STATE.load(Ordering::Relaxed) == DISPLAY_OFF {
    return ScreenState::DisplayAsleep;
  }
  ScreenState::On
}

/// While the lock screen (or another secure desktop) takes input, an
/// ordinary process cannot open the input desktop.
fn input_desktop_is_locked() -> bool {
  // SAFETY: The call takes flags and an access mask only; a returned handle
  // is closed below.
  let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP) };
  if desktop.is_null() {
    return true;
  }
  // SAFETY: `desktop` is the handle `OpenInputDesktop` just returned.
  let _closed = unsafe { CloseDesktop(desktop) };
  false
}

fn same_guid(a: &GUID, b: &GUID) -> bool {
  a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

/// Receives display power changes on a system thread.
unsafe extern "system" fn display_state_changed(
  _context: *const core::ffi::c_void,
  kind: u32,
  setting: *const core::ffi::c_void,
) -> u32 {
  if kind != PBT_POWERSETTINGCHANGE || setting.is_null() {
    return ERROR_SUCCESS;
  }
  // SAFETY: For `PBT_POWERSETTINGCHANGE` the system passes a
  // POWERBROADCAST_SETTING valid for the duration of the callback; its first
  // data byte is present whenever `DataLength` is at least one.
  let setting = unsafe { &*setting.cast::<POWERBROADCAST_SETTING>() };
  if same_guid(&setting.PowerSetting, &GUID_CONSOLE_DISPLAY_STATE)
    && setting.DataLength >= 1
  {
    DISPLAY_STATE.store(setting.Data[0], Ordering::Relaxed);
  }
  ERROR_SUCCESS
}

fn subscribe_to_display_state() {
  // The subscription lives as long as the process, so its parameters do too.
  let parameters: &'static mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS =
    Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
      Callback: Some(display_state_changed),
      Context: core::ptr::null_mut(),
    }));
  let setting = GUID_CONSOLE_DISPLAY_STATE;
  let mut registration = core::ptr::null_mut();
  // Without the subscription the display reads as on, as before it existed,
  // so a refusal needs no handling.
  // SAFETY: `setting` and `registration` are live locals, `parameters` is a
  // valid subscription that outlives the process's use of it, and the
  // callback only reads the setting the system passes it.
  let _status = unsafe {
    PowerSettingRegisterNotification(
      &raw const setting,
      DEVICE_NOTIFY_CALLBACK,
      core::ptr::from_mut(parameters).cast(),
      &raw mut registration,
    )
  };
}

#[cfg(test)]
mod tests {
  #[test]
  fn the_screen_state_reads_without_failing() {
    let _state = super::screen_state();
  }
}
