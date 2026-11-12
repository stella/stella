//! Where another app's main window sits on screen, so a small guide can
//! dock beside it, and which of its windows is in front, so dictation can
//! tell whether focus moved to another window. Only bounds, layer, number and
//! owner are read: window titles and contents would need Screen Recording,
//! and this never asks for them.

use core_foundation::{
  array::{CFArray, CFArrayRef},
  base::{CFType, TCFType},
  dictionary::{CFDictionary, CFDictionaryRef},
  number::CFNumber,
  string::CFString,
};

#[repr(C)]
#[derive(Default)]
struct CGPoint {
  x: f64,
  y: f64,
}

#[repr(C)]
#[derive(Default)]
struct CGSize {
  width: f64,
  height: f64,
}

#[repr(C)]
#[derive(Default)]
struct CGRect {
  origin: CGPoint,
  size: CGSize,
}

const ON_SCREEN_ONLY: u32 = 1 << 0;
const EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
const NULL_WINDOW_ID: u32 = 0;
/// The normal window layer; menus, panels and overlays sit above it.
const NORMAL_LAYER: i32 = 0;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
  fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
  fn CGRectMakeWithDictionaryRepresentation(
    dict: CFDictionaryRef,
    rect: *mut CGRect,
  ) -> u8;
}

/// Top-left origin in points, as window positions are given to Tauri.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowBounds {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

fn number(window: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<i64> {
  window
    .find(CFString::from_static_string(key))?
    .downcast::<CFNumber>()?
    .to_i64()
}

fn bounds(window: &CFDictionary<CFString, CFType>) -> Option<WindowBounds> {
  let dictionary = window
    .find(CFString::from_static_string("kCGWindowBounds"))?
    .downcast::<CFDictionary>()?;
  let mut rect = CGRect::default();
  // SAFETY: the dictionary is a live CFDictionary owned above and the output
  // points to stack storage of the documented layout.
  let parsed = unsafe {
    CGRectMakeWithDictionaryRepresentation(dictionary.as_concrete_TypeRef(), &mut rect)
  };
  (parsed != 0).then_some(WindowBounds {
    x: rect.origin.x,
    y: rect.origin.y,
    width: rect.size.width,
    height: rect.size.height,
  })
}

/// Every on-screen window, front to back.
fn on_screen_windows() -> Option<CFArray<CFDictionary<CFString, CFType>>> {
  // SAFETY: the call takes plain integers; its nullable Copy-rule result is
  // checked before ownership is wrapped and released by CFArray.
  let list = unsafe {
    CGWindowListCopyWindowInfo(
      ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS,
      NULL_WINDOW_ID,
    )
  };
  if list.is_null() {
    return None;
  }
  // SAFETY: a non-null CGWindowListCopyWindowInfo result is a CFArray of
  // CFDictionary values with CFString keys, returned under the Create rule.
  Some(unsafe { CFArray::wrap_under_create_rule(list) })
}

fn is_normal_window_of(window: &CFDictionary<CFString, CFType>, pid: i32) -> bool {
  number(window, "kCGWindowOwnerPID") == Some(i64::from(pid))
    && number(window, "kCGWindowLayer") == Some(i64::from(NORMAL_LAYER))
}

/// The window server's number for the frontmost on-screen normal window of
/// process `pid`: the document or main window the app shows in front. Panels
/// and other layers above it belong to the same process and are not
/// counted, so this tells the app's normal windows apart.
pub fn frontmost_window_number(pid: i32) -> Option<u32> {
  let windows = on_screen_windows()?;
  let window = windows
    .iter()
    .find(|window| is_normal_window_of(window, pid))?;
  u32::try_from(number(&window, "kCGWindowNumber")?).ok()
}

/// The largest on-screen normal window of process `pid`.
pub fn largest_window_bounds(pid: i32) -> Option<WindowBounds> {
  on_screen_windows()?
    .iter()
    .filter(|window| is_normal_window_of(window, pid))
    .filter_map(|window| bounds(&window))
    .max_by(|left, right| {
      (left.width * left.height).total_cmp(&(right.width * right.height))
    })
}
