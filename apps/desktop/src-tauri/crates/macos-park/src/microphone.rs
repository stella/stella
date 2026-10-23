//! Which apps are capturing from a microphone right now, from CoreAudio's
//! per-process objects (macOS 14 and later; earlier systems report none).
//! Only each capturing process's bundle identifier is read: never audio,
//! devices or levels, and no permission prompt is involved.

use std::{ffi::c_void, mem::size_of, ptr};

use core_foundation::{
  base::TCFType,
  string::{CFString, CFStringRef},
};

#[repr(C)]
struct AudioObjectPropertyAddress {
  selector: u32,
  scope: u32,
  element: u32,
}

const fn four_char_code(code: &[u8; 4]) -> u32 {
  u32::from_be_bytes(*code)
}

const SYSTEM_OBJECT: u32 = 1;
const PROCESS_OBJECT_LIST: u32 = four_char_code(b"prs#");
const PROCESS_BUNDLE_ID: u32 = four_char_code(b"pbid");
const PROCESS_IS_RUNNING_INPUT: u32 = four_char_code(b"piri");
const SCOPE_GLOBAL: u32 = four_char_code(b"glob");
const ELEMENT_MAIN: u32 = 0;
/// More capturing processes than this is not a call worth attributing.
const MAX_PROCESSES: usize = 512;

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
  fn AudioObjectGetPropertyDataSize(
    object: u32,
    address: *const AudioObjectPropertyAddress,
    qualifier_size: u32,
    qualifier: *const c_void,
    size: *mut u32,
  ) -> i32;
  fn AudioObjectGetPropertyData(
    object: u32,
    address: *const AudioObjectPropertyAddress,
    qualifier_size: u32,
    qualifier: *const c_void,
    size: *mut u32,
    data: *mut c_void,
  ) -> i32;
}

/// Bundle identifiers of the processes capturing microphone input. Helper
/// processes report their own identifiers; callers map them to their app.
pub fn microphone_input_bundle_ids() -> Vec<String> {
  process_objects()
    .into_iter()
    .filter(|&object| is_running_input(object))
    .filter_map(bundle_id)
    .collect()
}

fn address(selector: u32) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress {
    selector,
    scope: SCOPE_GLOBAL,
    element: ELEMENT_MAIN,
  }
}

fn process_objects() -> Vec<u32> {
  let address = address(PROCESS_OBJECT_LIST);
  let mut size = 0u32;
  // SAFETY: `address` is a valid property address, no qualifier is passed,
  // and `size` is a writable u32.
  let status = unsafe {
    AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, ptr::null(), &mut size)
  };
  if status != 0 {
    return Vec::new();
  }
  let count = (size as usize / size_of::<u32>()).min(MAX_PROCESSES);
  if count == 0 {
    return Vec::new();
  }
  let mut objects = vec![0u32; count];
  let mut size = u32::try_from(count * size_of::<u32>()).unwrap_or(0);
  // SAFETY: `objects` provides `size` writable bytes of u32 slots, the
  // element type of this property.
  let status = unsafe {
    AudioObjectGetPropertyData(
      SYSTEM_OBJECT,
      &address,
      0,
      ptr::null(),
      &mut size,
      objects.as_mut_ptr().cast(),
    )
  };
  if status != 0 {
    return Vec::new();
  }
  objects.truncate(size as usize / size_of::<u32>());
  objects
}

fn is_running_input(object: u32) -> bool {
  let mut running = 0u32;
  let mut size = size_of::<u32>() as u32;
  // SAFETY: the property is a UInt32 and `running` is a writable u32.
  let status = unsafe {
    AudioObjectGetPropertyData(
      object,
      &address(PROCESS_IS_RUNNING_INPUT),
      0,
      ptr::null(),
      &mut size,
      (&raw mut running).cast(),
    )
  };
  status == 0 && running != 0
}

fn bundle_id(object: u32) -> Option<String> {
  let mut value: CFStringRef = ptr::null();
  let mut size = size_of::<CFStringRef>() as u32;
  // SAFETY: the property is a CFStringRef and `value` is a writable pointer.
  let status = unsafe {
    AudioObjectGetPropertyData(
      object,
      &address(PROCESS_BUNDLE_ID),
      0,
      ptr::null(),
      &mut size,
      (&raw mut value).cast(),
    )
  };
  if status != 0 || value.is_null() {
    return None;
  }
  // SAFETY: CoreAudio returns the bundle identifier retained for the caller
  // (create rule); wrapping takes that ownership and releases it on drop.
  let value = unsafe { CFString::wrap_under_create_rule(value) }.to_string();
  (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
  use super::*;

  const PROCESS_PID: u32 = four_char_code(b"ppid");

  fn pid(object: u32) -> Option<i32> {
    let mut pid = 0i32;
    let mut size = size_of::<i32>() as u32;
    // SAFETY: the property is a pid_t and `pid` is a writable i32.
    let status = unsafe {
      AudioObjectGetPropertyData(
        object,
        &address(PROCESS_PID),
        0,
        ptr::null(),
        &mut size,
        (&raw mut pid).cast(),
      )
    };
    (status == 0).then_some(pid)
  }

  /// The selectors and struct layout above are written by hand; this proves
  /// them against the running system. Querying the HAL makes this test a
  /// CoreAudio client, so it must appear in the process list (macOS 14+),
  /// not capturing input, and without a bundle identifier.
  #[test]
  fn the_process_list_finds_this_test_process_not_capturing() {
    let objects = process_objects();
    assert!(!objects.is_empty(), "CoreAudio listed no processes");
    let me = i32::try_from(std::process::id()).unwrap();
    let own = objects
      .iter()
      .copied()
      .find(|&object| pid(object) == Some(me))
      .expect("this test process is listed after querying the HAL");
    assert!(!is_running_input(own));
    assert_eq!(bundle_id(own), None);
    assert!(
      microphone_input_bundle_ids()
        .iter()
        .all(|bundle_id| !bundle_id.is_empty())
    );
  }
}
