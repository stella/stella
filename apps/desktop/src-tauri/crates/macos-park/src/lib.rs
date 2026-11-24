//! Safe wrappers over local desktop window and accessibility calls:
//! presenting it as a non-activating panel and parking it. The desktop crate
//! forbids `unsafe` code, so the class swap, pointer derefs and the
//! private-selector call live here behind a minimal API that owns their
//! soundness (pointers are obtained from live Tauri windows, and the main
//! thread is verified before any AppKit call).
//!
//! Activity metadata is returned only as owned values; native pointers never
//! cross this crate's safe API. Clipboard presentation is macOS-only.

#[cfg(target_os = "macos")]
mod focused_window;
#[cfg(target_os = "macos")]
pub use focused_window::{
  FocusedWindowDetails, accessibility_trusted, focused_field_is_secure,
  focused_window_details, request_accessibility_permission, selected_text,
  text_before_cursor,
};

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[cfg_attr(
  not(target_os = "windows"),
  allow(
    dead_code,
    reason = "the Windows matcher is tested everywhere, used on Windows"
  )
)]
mod hold_key_edges;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub use hold_key_edges::{HoldEdge, HoldKey};

#[cfg(target_os = "macos")]
mod hold_key;
#[cfg(target_os = "macos")]
pub use hold_key::{
  HoldKeyListener, HoldKeyUnsupported, globe_key_usage, listen_for_hold_key,
};

#[cfg(target_os = "windows")]
mod windows_hold_key;
#[cfg(target_os = "windows")]
pub use windows_hold_key::{HoldKeyListener, HoldKeyUnsupported, listen_for_hold_key};

#[cfg(target_os = "macos")]
mod idle_sleep;
#[cfg(target_os = "macos")]
pub use idle_sleep::{IdleSleepAssertion, on_battery_power, prevent_idle_sleep};

#[cfg(target_os = "windows")]
mod windows_idle_sleep;
#[cfg(target_os = "windows")]
pub use windows_idle_sleep::{
  IdleSleepAssertion, on_battery_power, prevent_idle_sleep,
};

#[cfg(target_os = "macos")]
mod managed_preferences;
#[cfg(target_os = "macos")]
pub use managed_preferences::{ManagedPreference, managed_preference};

#[cfg(target_os = "macos")]
mod microphone;
#[cfg(target_os = "macos")]
pub use microphone::{
  AudioTransport, audio_device_transport, microphone_input_bundle_ids,
};

#[cfg(target_os = "macos")]
mod output_audio;
#[cfg(target_os = "macos")]
pub use output_audio::{
  default_output_device_id, output_plays_on_headphones, output_volume,
  set_output_volume,
};

#[cfg(target_os = "windows")]
mod windows_output_audio;
#[cfg(target_os = "windows")]
pub use windows_output_audio::{
  default_output_device_id, output_volume, set_output_volume,
};

#[cfg(target_os = "macos")]
mod system_permissions;
#[cfg(target_os = "macos")]
pub use system_permissions::{
  LoginItemApproval, MicrophoneAuthorization, NotificationAuthorization,
  login_item_approval, microphone_authorization, notification_authorization,
  request_microphone_permission, request_notification_authorization,
};

#[cfg(target_os = "macos")]
mod text_input;
#[cfg(target_os = "macos")]
pub use text_input::{FormattingKey, TypeTextError, press_key, type_text};

#[cfg(target_os = "macos")]
mod user_languages;
#[cfg(target_os = "macos")]
pub use user_languages::{keyboard_languages, preferred_languages};

#[cfg(target_os = "macos")]
mod work_priority;
#[cfg(target_os = "macos")]
pub use work_priority::prefer_user_initiated;

#[cfg(target_os = "windows")]
mod windows_languages;
#[cfg(target_os = "windows")]
pub use windows_languages::{keyboard_languages, preferred_languages};

#[cfg(target_os = "macos")]
mod window_bounds;
#[cfg(target_os = "macos")]
pub use window_bounds::{WindowBounds, frontmost_window_number, largest_window_bounds};

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod process_identity;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub use process_identity::parent_process_id;
#[cfg(target_os = "windows")]
pub use process_identity::{create_owner_only_pipe, named_pipe_client_process_id};

/// Why the operating system could not decode a recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemAudioError {
  /// No decoder on this computer reads the file.
  Unsupported,
  /// The file stopped decoding partway, or reported an impossible format.
  Unreadable,
}

#[cfg(target_os = "macos")]
mod system_audio;
#[cfg(target_os = "macos")]
pub use system_audio::SystemAudioReader;

#[cfg(target_os = "windows")]
mod system_audio_windows;
#[cfg(target_os = "windows")]
pub use system_audio_windows::SystemAudioReader;

#[cfg(target_os = "windows")]
mod windows_password_field;
#[cfg(target_os = "windows")]
pub use windows_password_field::focused_field_is_secure;

#[cfg(target_os = "windows")]
mod windows_selection;
#[cfg(target_os = "windows")]
pub use windows_selection::selected_text;

#[cfg(target_os = "windows")]
mod windows_window;
#[cfg(target_os = "windows")]
pub use windows_window::focused_window_title;

#[cfg(target_os = "macos")]
mod activation;
#[cfg(target_os = "macos")]
pub use activation::{ActivationReturn, return_activation};

#[cfg(target_os = "macos")]
mod park;
#[cfg(target_os = "macos")]
pub use park::{
  disable_occlusion_detection, is_panel_presented, observe_panel_deactivation,
  park_window, prepare_transient_overlay, present_activating_window, present_key_panel,
  present_passive_overlay,
};
