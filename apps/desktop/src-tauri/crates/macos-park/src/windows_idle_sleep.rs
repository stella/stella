//! Keeping the PC from idle sleep while work the user started runs, and
//! whether it runs on battery power. Windows keeps an execution state per
//! thread, so each assertion owns a thread that sets the state and clears it
//! again when the assertion drops. Only the system is kept awake: the display
//! still turns off.

use std::{
  sync::mpsc,
  thread::{self, JoinHandle},
};

use windows_sys::Win32::System::Power::{
  ES_CONTINUOUS, ES_SYSTEM_REQUIRED, GetSystemPowerStatus, SYSTEM_POWER_STATUS,
  SetThreadExecutionState,
};

/// `ACLineStatus` when the PC is not on mains power.
const AC_LINE_OFFLINE: u8 = 0;

/// Holds off idle system sleep until dropped.
#[derive(Debug)]
pub struct IdleSleepAssertion {
  /// Dropping it ends the thread, which clears its execution state first.
  release: Option<mpsc::Sender<()>>,
  thread: Option<JoinHandle<()>>,
}

impl Drop for IdleSleepAssertion {
  fn drop(&mut self) {
    drop(self.release.take());
    if let Some(thread) = self.thread.take() {
      let _joined = thread.join();
    }
  }
}

/// Holds off idle system sleep; `None` when the system refused. `reason`
/// names the thread that holds it.
pub fn prevent_idle_sleep(reason: &str) -> Option<IdleSleepAssertion> {
  let (release, released) = mpsc::channel::<()>();
  let (taken, took) = mpsc::sync_channel::<bool>(1);
  let thread = thread::Builder::new()
    .name(reason.chars().take(32).collect())
    .spawn(move || {
      // SAFETY: The call takes flags only and changes the calling thread's
      // execution state, which this thread alone owns.
      let previous =
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
      let held = previous != 0;
      let _sent = taken.send(held);
      if !held {
        return;
      }
      // Blocks until the assertion drops its sender.
      let _released = released.recv();
      // SAFETY: As above; `ES_CONTINUOUS` alone clears the requirement.
      let _cleared = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    })
    .ok()?;
  if took.recv().unwrap_or(false) {
    return Some(IdleSleepAssertion {
      release: Some(release),
      thread: Some(thread),
    });
  }
  let _joined = thread.join();
  None
}

/// Whether the PC draws from its battery now. A PC without one, or whose
/// power status cannot be read, counts as on mains power.
pub fn on_battery_power() -> bool {
  let mut status = SYSTEM_POWER_STATUS::default();
  // SAFETY: `status` is a writable SYSTEM_POWER_STATUS the call fills.
  let read = unsafe { GetSystemPowerStatus(&raw mut status) } != 0;
  read && status.ACLineStatus == AC_LINE_OFFLINE
}

#[cfg(test)]
mod tests {
  #[test]
  fn an_assertion_is_taken_and_released() {
    let assertion = super::prevent_idle_sleep("stella-keep-awake-test");
    assert!(assertion.is_some());
    drop(assertion);
  }

  #[test]
  fn the_power_source_reads_without_failing() {
    let _on_battery = super::on_battery_power();
  }
}
