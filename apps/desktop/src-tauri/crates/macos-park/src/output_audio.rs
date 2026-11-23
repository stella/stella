//! The default output device: whether it plays through headphones, and its
//! volume, read and set through CoreAudio. Devices are named by their
//! CoreAudio UID, which stays the same across launches. No permission
//! prompt is involved, and no audio is read.

use std::{mem::size_of, ptr};

use core_foundation::{
  base::TCFType,
  string::{CFString, CFStringRef},
};

use crate::microphone::{
  AudioObjectGetPropertyData, AudioObjectPropertyAddress, AudioTransport, ELEMENT_MAIN,
  SYSTEM_OBJECT, address, device_for_uid, four_char_code, transport,
};

const DEFAULT_OUTPUT_DEVICE: u32 = four_char_code(b"dOut");
const DEVICE_UID: u32 = four_char_code(b"uid ");
const DATA_SOURCE: u32 = four_char_code(b"ssrc");
/// The headphone jack of a built-in output.
const HEADPHONES_SOURCE: u32 = four_char_code(b"hdpn");
/// The volume the menu bar control sets, across all channels.
const VIRTUAL_MAIN_VOLUME: u32 = four_char_code(b"vmvc");
const SCOPE_OUTPUT: u32 = four_char_code(b"outp");

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
  fn AudioObjectSetPropertyData(
    object: u32,
    address: *const AudioObjectPropertyAddress,
    qualifier_size: u32,
    qualifier: *const std::ffi::c_void,
    size: u32,
    data: *const std::ffi::c_void,
  ) -> i32;
}

const fn output_address(selector: u32) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress {
    selector,
    scope: SCOPE_OUTPUT,
    element: ELEMENT_MAIN,
  }
}

/// The UID of the device sound plays through now.
pub fn default_output_device_id() -> Option<String> {
  let mut device = 0u32;
  let mut size = size_of::<u32>() as u32;
  // SAFETY: the property is an AudioObjectID and `device` is a writable u32.
  let status = unsafe {
    AudioObjectGetPropertyData(
      SYSTEM_OBJECT,
      &address(DEFAULT_OUTPUT_DEVICE),
      0,
      ptr::null(),
      &mut size,
      (&raw mut device).cast(),
    )
  };
  if status != 0 || device == 0 {
    return None;
  }
  let mut uid: CFStringRef = ptr::null();
  let mut size = size_of::<CFStringRef>() as u32;
  // SAFETY: the property is a CFStringRef and `uid` is a writable pointer.
  let status = unsafe {
    AudioObjectGetPropertyData(
      device,
      &address(DEVICE_UID),
      0,
      ptr::null(),
      &mut size,
      (&raw mut uid).cast(),
    )
  };
  if status != 0 || uid.is_null() {
    return None;
  }
  // SAFETY: CoreAudio returns the UID retained for the caller (create
  // rule); wrapping takes that ownership and releases it on drop.
  let uid = unsafe { CFString::wrap_under_create_rule(uid) }.to_string();
  (!uid.is_empty()).then_some(uid)
}

/// Whether the device with UID `id` plays into the listener's ears rather
/// than the room: Bluetooth (most of which are headphones or headsets), or
/// a built-in output on its headphone jack. `None` while it is not
/// connected.
pub fn output_plays_on_headphones(id: &str) -> Option<bool> {
  let device = device_for_uid(id)?;
  Some(match transport(device)? {
    AudioTransport::Bluetooth => true,
    AudioTransport::BuiltIn => read_u32(device, DATA_SOURCE) == Some(HEADPHONES_SOURCE),
    AudioTransport::Other => false,
  })
}

/// The volume of the device with UID `id`, from 0 to 1; `None` for a
/// device without a volume of its own, such as most digital outputs.
pub fn output_volume(id: &str) -> Option<f32> {
  let device = device_for_uid(id)?;
  let mut volume = 0f32;
  let mut size = size_of::<f32>() as u32;
  // SAFETY: the property is a Float32 and `volume` is a writable f32.
  let status = unsafe {
    AudioObjectGetPropertyData(
      device,
      &output_address(VIRTUAL_MAIN_VOLUME),
      0,
      ptr::null(),
      &mut size,
      (&raw mut volume).cast(),
    )
  };
  (status == 0 && volume.is_finite()).then_some(volume.clamp(0.0, 1.0))
}

/// Sets the volume of the device with UID `id`; whether it took.
pub fn set_output_volume(id: &str, volume: f32) -> bool {
  let Some(device) = device_for_uid(id) else {
    return false;
  };
  let volume = volume.clamp(0.0, 1.0);
  // SAFETY: the property is a Float32, `volume` lives across the call and
  // its size is given.
  let status = unsafe {
    AudioObjectSetPropertyData(
      device,
      &output_address(VIRTUAL_MAIN_VOLUME),
      0,
      ptr::null(),
      size_of::<f32>() as u32,
      (&raw const volume).cast(),
    )
  };
  status == 0
}

fn read_u32(device: u32, selector: u32) -> Option<u32> {
  let mut value = 0u32;
  let mut size = size_of::<u32>() as u32;
  // SAFETY: the property is a UInt32 and `value` is a writable u32.
  let status = unsafe {
    AudioObjectGetPropertyData(
      device,
      &output_address(selector),
      0,
      ptr::null(),
      &mut size,
      (&raw mut value).cast(),
    )
  };
  (status == 0).then_some(value)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_unknown_device_has_no_route_or_volume() {
    let id = "stella-no-such-audio-device";
    assert_eq!(output_plays_on_headphones(id), None);
    assert_eq!(output_volume(id), None);
    assert!(!set_output_volume(id, 0.5));
  }

  /// The selectors above are written by hand; this proves the default
  /// output lookup against the running system wherever it has one, without
  /// changing anything.
  #[test]
  fn the_default_output_reads_back_by_its_uid() {
    let Some(id) = default_output_device_id() else {
      return;
    };
    assert!(output_plays_on_headphones(&id).is_some());
    if let Some(volume) = output_volume(&id) {
      assert!((0.0..=1.0).contains(&volume));
    }
  }
}
