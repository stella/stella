//! The default output endpoint's volume, read and set through the Windows
//! audio endpoint API. Endpoints are named by their endpoint id, which stays
//! the same across launches. No audio is read.

use windows::{
  Win32::{
    Media::Audio::{
      Endpoints::IAudioEndpointVolume, IMMDevice, IMMDeviceEnumerator,
      MMDeviceEnumerator, eConsole, eRender,
    },
    System::Com::{
      CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    },
  },
  core::{HSTRING, PCWSTR},
};

fn enumerator() -> Option<IMMDeviceEnumerator> {
  // SAFETY: initializing COM on this thread has no preconditions. A thread
  // already in another apartment answers RPC_E_CHANGED_MODE and stays
  // usable there, so the answer is not checked.
  let _apartment = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
  // SAFETY: the class id names the system device enumerator, which
  // implements the requested interface.
  unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.ok()
}

fn endpoint_volume(id: &str) -> Option<IAudioEndpointVolume> {
  let id = HSTRING::from(id);
  // SAFETY: `id` is a NUL-terminated wide string that outlives the call.
  let device: IMMDevice =
    unsafe { enumerator()?.GetDevice(PCWSTR(id.as_ptr())) }.ok()?;
  // SAFETY: render endpoints implement IAudioEndpointVolume; no activation
  // parameters are needed.
  unsafe { device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) }.ok()
}

/// The id of the endpoint sound plays through now.
pub fn default_output_device_id() -> Option<String> {
  // SAFETY: rendering and the console role are valid arguments.
  let device =
    unsafe { enumerator()?.GetDefaultAudioEndpoint(eRender, eConsole) }.ok()?;
  // SAFETY: the endpoint returns its id allocated for the caller, who frees
  // it with CoTaskMemFree once it is copied.
  let raw = unsafe { device.GetId() }.ok()?;
  // SAFETY: `raw` is the NUL-terminated string just returned.
  let id = unsafe { raw.to_string() }.ok();
  // SAFETY: `raw` came from the COM allocator and is not used again.
  unsafe { CoTaskMemFree(Some(raw.0.cast_const().cast())) };
  id.filter(|id| !id.is_empty())
}

/// The master volume of the endpoint with `id`, from 0 to 1.
pub fn output_volume(id: &str) -> Option<f32> {
  let volume = endpoint_volume(id)?;
  // SAFETY: a plain read of an activated interface.
  let level = unsafe { volume.GetMasterVolumeLevelScalar() }.ok()?;
  level.is_finite().then_some(level.clamp(0.0, 1.0))
}

/// Sets the master volume of the endpoint with `id`; whether it took.
pub fn set_output_volume(id: &str, volume: f32) -> bool {
  let Some(endpoint) = endpoint_volume(id) else {
    return false;
  };
  // SAFETY: a null event context is allowed: no change notification is
  // tied to this caller.
  unsafe {
    endpoint.SetMasterVolumeLevelScalar(volume.clamp(0.0, 1.0), std::ptr::null())
  }
  .is_ok()
}
