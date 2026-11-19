//! Watches a key held on its own on Windows, for hold-to-talk dictation.
//!
//! A low-level keyboard hook on a thread of its own receives key changes and
//! passes every one on unchanged. Only virtual-key codes are read, never
//! characters, and only to tell the hold key from a shortcut on it; nothing
//! is kept. Events injected by an app, stella's own typing included, are
//! ignored.
//!
//! Windows opens the Start menu when the Windows key is released with no
//! other key pressed while it was down. Once Control and Windows are held,
//! the listener presses and releases an unassigned key (`0xE8`), so letting
//! go never opens it.

use std::{
  cell::RefCell,
  ptr,
  sync::{
    Arc,
    atomic::{AtomicBool, AtomicU32, Ordering},
  },
  thread,
};

use windows_sys::Win32::{
  Foundation::{LPARAM, LRESULT, WPARAM},
  System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
  UI::{
    Input::KeyboardAndMouse::{
      GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
      SendInput,
    },
    WindowsAndMessaging::{
      CallNextHookEx, GetMessageW, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
      PM_NOREMOVE, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
      UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_QUIT,
      WM_SYSKEYDOWN, WM_SYSKEYUP,
    },
  },
};

use crate::hold_key_edges::{HoldEdge, HoldKey, WindowsMatcher};

/// Unassigned by Windows; pressing it keeps the Start menu shut.
const MASK_KEY: u16 = 0xE8;
/// Asks the listener thread to press [`MASK_KEY`], outside the hook.
const MASK_MESSAGE: u32 = WM_APP + 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HoldKeyUnsupported;

/// Listens while it lives; dropping it removes the hook. No edge is reported
/// after the drop.
pub struct HoldKeyListener {
  stop: Arc<AtomicBool>,
  thread_id: Arc<AtomicU32>,
}

impl Drop for HoldKeyListener {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::SeqCst);
    let thread_id = self.thread_id.load(Ordering::SeqCst);
    if thread_id != 0 {
      // SAFETY: posting to a thread id is harmless if the thread has ended.
      unsafe { PostThreadMessageW(thread_id, WM_QUIT, 0, 0) };
    }
  }
}

struct Context {
  matcher: WindowsMatcher,
  masks_start_menu: bool,
  stop: Arc<AtomicBool>,
  thread_id: u32,
  on_edge: Box<dyn Fn(HoldEdge)>,
}

thread_local! {
  /// The listener thread's state, read by the hook, which Windows calls on
  /// the thread that installed it.
  static CONTEXT: RefCell<Option<Context>> = const { RefCell::new(None) };
}

/// Starts listening for `key` on a thread of its own. `on_edge` runs on that
/// thread and must return quickly: Windows skips a hook that is slow.
/// `on_listening` says whether the hook is installed.
pub fn listen_for_hold_key(
  key: HoldKey,
  on_edge: impl Fn(HoldEdge) + Send + 'static,
  on_listening: impl Fn(bool) + Send + 'static,
) -> Result<HoldKeyListener, HoldKeyUnsupported> {
  let matcher = WindowsMatcher::new(key).ok_or(HoldKeyUnsupported)?;
  let stop = Arc::new(AtomicBool::new(false));
  let thread_id = Arc::new(AtomicU32::new(0));
  let (thread_stop, thread_id_out) = (Arc::clone(&stop), Arc::clone(&thread_id));
  thread::Builder::new()
    .name("dictation-hold-key".to_string())
    .spawn(move || {
      // SAFETY: plain calls; `message` is a valid out pointer. The peek
      // creates this thread's message queue so a posted quit is not lost.
      let id = unsafe {
        let mut message = MSG::default();
        PeekMessageW(&raw mut message, ptr::null_mut(), 0, 0, PM_NOREMOVE);
        GetCurrentThreadId()
      };
      thread_id_out.store(id, Ordering::SeqCst);
      if thread_stop.load(Ordering::SeqCst) {
        return;
      }
      CONTEXT.with_borrow_mut(|context| {
        *context = Some(Context {
          matcher,
          masks_start_menu: key == HoldKey::ControlWindows,
          stop: thread_stop,
          thread_id: id,
          on_edge: Box::new(on_edge),
        });
      });
      serve(&on_listening);
    })
    .map_err(|_spawn_failed| HoldKeyUnsupported)?;
  Ok(HoldKeyListener { stop, thread_id })
}

fn serve(on_listening: &dyn Fn(bool)) {
  // SAFETY: `on_key` matches the hook signature; the module handle of this
  // process is valid for its life.
  let hook = unsafe {
    SetWindowsHookExW(
      WH_KEYBOARD_LL,
      Some(on_key),
      GetModuleHandleW(ptr::null()),
      0,
    )
  };
  if hook.is_null() {
    on_listening(false);
    return;
  }
  // The hook hears only changes from now on: start from the modifiers
  // already down. Events that arrive meanwhile wait for the message loop
  // below, so none is lost.
  CONTEXT.with_borrow_mut(|context| {
    if let Some(context) = context.as_mut() {
      context.matcher.sync(modifier_down);
    }
  });
  on_listening(true);
  let mut message = MSG::default();
  // SAFETY: `message` is a valid out pointer; a null window reads this
  // thread's messages. GetMessageW returns 0 on WM_QUIT and -1 on error.
  while unsafe { GetMessageW(&raw mut message, ptr::null_mut(), 0, 0) } > 0 {
    if message.message == MASK_MESSAGE {
      press_mask_key();
    }
  }
  // SAFETY: `hook` was installed above and is removed once.
  unsafe { UnhookWindowsHookEx(hook) };
}

/// Whether the physical key `code` is down now: the high bit of
/// `GetAsyncKeyState`.
fn modifier_down(code: u16) -> bool {
  // SAFETY: a plain query of one virtual key's state.
  unsafe { GetAsyncKeyState(i32::from(code)) < 0 }
}

fn press_mask_key() {
  let input = |flags| INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 {
      ki: KEYBDINPUT {
        wVk: MASK_KEY,
        wScan: 0,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  };
  let inputs = [input(0), input(KEYEVENTF_KEYUP)];
  // SAFETY: `inputs` holds two initialized keyboard inputs of the size given.
  unsafe {
    SendInput(
      inputs.len() as u32,
      inputs.as_ptr(),
      size_of::<INPUT>() as i32,
    );
  }
}

/// Reads the key change, then passes it on unchanged.
unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  if code == HC_ACTION as i32 {
    // SAFETY: for HC_ACTION, `lparam` points to the event's KBDLLHOOKSTRUCT.
    let event = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
    let down = match wparam as u32 {
      WM_KEYDOWN | WM_SYSKEYDOWN => Some(true),
      WM_KEYUP | WM_SYSKEYUP => Some(false),
      _ => None,
    };
    if let Some(down) = down
      && event.flags & LLKHF_INJECTED == 0
      && let Ok(vk_code) = u16::try_from(event.vkCode)
    {
      feed(vk_code, down);
    }
  }
  // SAFETY: passes the event to the next hook, as every hook must.
  unsafe { CallNextHookEx(ptr::null_mut(), code, wparam, lparam) }
}

fn feed(vk_code: u16, down: bool) {
  CONTEXT.with(|cell| {
    // A hook called again while the state is borrowed skips the event.
    let Ok(mut borrowed) = cell.try_borrow_mut() else {
      return;
    };
    let Some(context) = borrowed.as_mut() else {
      return;
    };
    let Some(edge) = context.matcher.feed(vk_code, down) else {
      return;
    };
    if context.stop.load(Ordering::SeqCst) {
      return;
    }
    if context.masks_start_menu && matches!(edge, HoldEdge::Down { .. }) {
      // SAFETY: posting to this thread's own queue.
      unsafe { PostThreadMessageW(context.thread_id, MASK_MESSAGE, 0, 0) };
    }
    (context.on_edge)(edge);
  });
}
