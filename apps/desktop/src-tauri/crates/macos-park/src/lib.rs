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
  FocusedWindowDetails, accessibility_trusted, focused_window_details,
  request_accessibility_permission,
};

#[cfg(target_os = "windows")]
mod windows_window;
#[cfg(target_os = "windows")]
pub use windows_window::focused_window_title;

#[cfg(target_os = "macos")]
mod park;
#[cfg(target_os = "macos")]
pub use park::{
  disable_occlusion_detection, is_panel_presented, park_window,
  prepare_transient_overlay, present_key_panel,
};
