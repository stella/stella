//! Where another app's main window sits on screen, so a small guide can
//! dock beside it. Only bounds, layer and owner are read: window titles and
//! contents would need Screen Recording, and this never asks for them.

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

/// The largest on-screen normal window of process `pid`.
pub fn largest_window_bounds(pid: i32) -> Option<WindowBounds> {
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
  let windows: CFArray<CFDictionary<CFString, CFType>> =
    unsafe { CFArray::wrap_under_create_rule(list) };
  windows
    .iter()
    .filter(|window| {
      number(window, "kCGWindowOwnerPID") == Some(i64::from(pid))
        && number(window, "kCGWindowLayer") == Some(i64::from(NORMAL_LAYER))
    })
    .filter_map(|window| bounds(&window))
    .max_by(|left, right| {
      (left.width * left.height).total_cmp(&(right.width * right.height))
    })
}
