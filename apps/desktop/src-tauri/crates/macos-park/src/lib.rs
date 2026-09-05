//! Safe wrappers over the raw AppKit/WebKit calls behind the clipboard window:
//! presenting it as a non-activating panel and parking it. The desktop crate
//! forbids `unsafe` code, so the class swap, pointer derefs and the
//! private-selector call live here behind a minimal API that owns their
//! soundness (pointers are obtained from live Tauri windows, and the main
//! thread is verified before any AppKit call).
//!
//! Everything is a no-op off macOS; the crate is empty there.

#[cfg(target_os = "macos")]
mod park;
#[cfg(target_os = "macos")]
pub use park::{disable_occlusion_detection, park_window, present_key_panel};
