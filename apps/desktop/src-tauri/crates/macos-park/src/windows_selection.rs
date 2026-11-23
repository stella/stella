//! The text selected in the control that has keyboard focus in another app,
//! read through UI Automation once, only when the person asks to fix a
//! dictated word. Never a password field, never stella's own process, and
//! never a selection longer than the caller takes. Nothing is logged.

use windows::Win32::{
  System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
    CoUninitialize,
  },
  UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
  },
};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;

/// COM initialized for this thread for as long as it lives.
struct Com {
  uninitialize: bool,
}

impl Com {
  fn start() -> Self {
    // SAFETY: initializes COM for this thread; balanced in `drop` only when
    // this call succeeded.
    let uninitialize = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    Self { uninitialize }
  }
}

impl Drop for Com {
  fn drop(&mut self) {
    if self.uninitialize {
      // SAFETY: balances the successful `CoInitializeEx` in `start`.
      unsafe { CoUninitialize() };
    }
  }
}

/// The selection in the focused control of process `process_id`, when it
/// holds at most `max_utf16_units` UTF-16 units; `None` otherwise and
/// whenever a read fails.
pub fn selected_text(process_id: u32, max_utf16_units: usize) -> Option<String> {
  // SAFETY: The query takes no pointers and returns this process's id.
  if max_utf16_units == 0 || process_id == unsafe { GetCurrentProcessId() } {
    return None;
  }
  let _com = Com::start();
  // SAFETY: COM is initialized on this thread above; the class and interface
  // are UI Automation's own, and the result is an owned interface.
  let automation: IUIAutomation =
    unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
  // SAFETY: The automation object is live; the result is an owned element.
  let element = unsafe { automation.GetFocusedElement() }.ok()?;
  // SAFETY: Property reads on a live element; a gone element fails.
  let owner = unsafe { element.CurrentProcessId() }.ok()?;
  if u32::try_from(owner).ok()? != process_id {
    return None;
  }
  // SAFETY: As above.
  if unsafe { element.CurrentIsPassword() }.ok()?.as_bool() {
    return None;
  }
  // SAFETY: The pattern id names the interface asked for; the result is owned.
  let pattern: IUIAutomationTextPattern =
    unsafe { element.GetCurrentPatternAs(UIA_TextPatternId) }.ok()?;
  // SAFETY: Reads on live, owned automation objects.
  let ranges = unsafe { pattern.GetSelection() }.ok()?;
  // SAFETY: As above.
  if unsafe { ranges.Length() }.ok()? != 1 {
    return None;
  }
  // SAFETY: Index 0 exists: the array holds exactly one range.
  let range = unsafe { ranges.GetElement(0) }.ok()?;
  // One unit more than taken, so a longer selection is told apart from one
  // that fits exactly.
  let wanted = i32::try_from(max_utf16_units.saturating_add(1)).ok()?;
  // SAFETY: As above; the text is copied into an owned string.
  let text = unsafe { range.GetText(wanted) }.ok()?.to_string();
  let length = text.encode_utf16().count();
  (length > 0 && length <= max_utf16_units).then_some(text)
}
