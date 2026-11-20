//! Keeping the Mac from idle sleep while work the user started runs, through
//! an IOKit power assertion, and whether it runs on battery power. Only idle
//! system sleep is held off: the display still sleeps, and closing the lid
//! still sleeps the Mac, which no assertion can prevent.

use core_foundation::{
  base::{CFType, CFTypeRef, TCFType},
  string::{CFString, CFStringRef},
};

/// `kIOPMAssertPreventUserIdleSystemSleep`.
const PREVENT_USER_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";
/// `kIOPMAssertionLevelOn`.
const ASSERTION_LEVEL_ON: u32 = 255;
/// `kIOPMBatteryPowerKey`, what the providing power source reads on battery.
const BATTERY_POWER: &str = "Battery Power";
/// `kIOReturnSuccess`.
const SUCCESS: i32 = 0;

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
  fn IOPMAssertionCreateWithName(
    assertion_type: CFStringRef,
    level: u32,
    name: CFStringRef,
    id: *mut u32,
  ) -> i32;
  fn IOPMAssertionRelease(id: u32) -> i32;
  fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
  fn IOPSGetProvidingPowerSourceType(snapshot: CFTypeRef) -> CFStringRef;
}

/// Holds off idle system sleep until dropped.
#[derive(Debug)]
pub struct IdleSleepAssertion {
  id: u32,
}

impl Drop for IdleSleepAssertion {
  fn drop(&mut self) {
    // SAFETY: `id` names the assertion this value created, and it is
    // released exactly once, here.
    let _released = unsafe { IOPMAssertionRelease(self.id) };
  }
}

/// Holds off idle system sleep, naming `reason` in `pmset -g assertions`;
/// `None` when the system refused.
pub fn prevent_idle_sleep(reason: &str) -> Option<IdleSleepAssertion> {
  let assertion_type = CFString::from_static_string(PREVENT_USER_IDLE_SYSTEM_SLEEP);
  let name = CFString::new(reason);
  let mut id = 0u32;
  // SAFETY: Both strings are live CFStrings borrowed for the call, and `id`
  // is a writable u32 the call fills on success.
  let status = unsafe {
    IOPMAssertionCreateWithName(
      assertion_type.as_concrete_TypeRef(),
      ASSERTION_LEVEL_ON,
      name.as_concrete_TypeRef(),
      &raw mut id,
    )
  };
  (status == SUCCESS).then_some(IdleSleepAssertion { id })
}

/// Whether the Mac draws from its battery now. A Mac without one, or whose
/// power source cannot be read, counts as on mains power.
pub fn on_battery_power() -> bool {
  // SAFETY: The function takes no arguments and returns a new snapshot (or
  // null), owned here under the create rule.
  let snapshot = unsafe { IOPSCopyPowerSourcesInfo() };
  if snapshot.is_null() {
    return false;
  }
  // SAFETY: Non-null and owned by this call, as checked above; released
  // when `snapshot` drops, after the source type below was read.
  let snapshot = unsafe { CFType::wrap_under_create_rule(snapshot) };
  // SAFETY: `snapshot` is a live power sources snapshot; the string it
  // answers belongs to the snapshot, so it is retained under the get rule.
  let source = unsafe { IOPSGetProvidingPowerSourceType(snapshot.as_CFTypeRef()) };
  if source.is_null() {
    return false;
  }
  // SAFETY: Non-null and kept alive by `snapshot`, as above.
  let source = unsafe { CFString::wrap_under_get_rule(source) };
  source == CFString::from_static_string(BATTERY_POWER)
}

#[cfg(test)]
mod tests {
  #[test]
  fn an_assertion_is_taken_and_released() {
    let assertion = super::prevent_idle_sleep("stella desktop test");
    assert!(assertion.is_some());
    drop(assertion);
  }

  #[test]
  fn the_power_source_reads_without_failing() {
    let _on_battery = super::on_battery_power();
  }
}
