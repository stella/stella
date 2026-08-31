//! Safe wrappers over the raw AppKit/WebKit calls behind clipboard window
//! parking. The desktop crate forbids `unsafe` code, so the pointer derefs
//! and the private-selector call live here behind a minimal API that owns
//! their soundness (pointers are obtained from live Tauri windows, and the
//! main thread is verified before any AppKit call).
//!
//! Everything is a no-op off macOS; the crate is empty there.

#[cfg(target_os = "macos")]
mod park;
#[cfg(target_os = "macos")]
pub use park::{disable_occlusion_detection, set_window_parked};
