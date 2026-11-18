//! Watches one modifier key held on its own, for hold-to-talk dictation.
//!
//! A listen-only event tap at the session level receives modifier changes
//! (`flagsChanged`) and nothing else: it never sees what is typed, password
//! fields included, and it returns every event unchanged. It is created only
//! once stella has Accessibility access, which dictation already asks for to
//! type its text, so macOS never asks for Input Monitoring; until then the
//! listener waits.
//!
//! Left and right share one `CGEventFlags` bit, so a side is matched by the
//! keycode each `flagsChanged` event carries, and the other side by the
//! per-side bits the event's flags also carry; fn is matched by its flag.
//! The listener reports a press made while another modifier is down, and
//! another modifier changing while the key is held, for the caller to tell a
//! shortcut from a dictation.
//!
//! The tap cannot see the C in Command-C. Instead, each time the hold key
//! changes, the listener reads how many keys have gone down in the session
//! so far: a count that needs no permission and names no key. If it moved
//! while the key was held, a key was typed on it, and that is reported as
//! another key before the release.
//!
//! macOS disables a tap that is slow to answer or that user input disables.
//! The listener re-enables it at once and checks it every second in case a
//! disable went unseen. A hold the tap was off for may have missed a key or
//! a release, so it is reported as interrupted, with the release if the key
//! is up by then.

use std::{
  cell::Cell,
  ffi::c_void,
  ptr::NonNull,
  sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
  },
  thread,
  time::Duration,
};

use objc2_core_foundation::{
  CFMachPort, CFRetained, CFRunLoop, kCFRunLoopCommonModes, kCFRunLoopDefaultMode,
};
use objc2_core_graphics::{
  CGEvent, CGEventField, CGEventFlags, CGEventMask, CGEventSource,
  CGEventSourceStateID, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
  CGEventTapProxy, CGEventType,
};

use crate::hold_key_edges::{HoldEdge, HoldKey};

/// How long the run loop waits before the stop flag and the tap are checked.
const TICK_SECONDS: f64 = 1.0;
/// How long a listener without Accessibility access waits before it tries
/// to create the tap again.
const RETRY: Duration = Duration::from_secs(1);

/// The modifier keycodes that count as another key while the hold key is
/// down: both sides of Command, Shift, Option and Control, and fn. Caps Lock
/// does not count.
const MODIFIER_KEYCODES: [i64; 9] = [54, 55, 56, 58, 59, 60, 61, 62, 63];

/// The modifiers that make a press part of a shortcut, fn included. The hold
/// key's own flag is taken out when it is matched.
const OTHER_MODIFIERS: CGEventFlags = CGEventFlags::MaskShift
  .union(CGEventFlags::MaskControl)
  .union(CGEventFlags::MaskAlternate)
  .union(CGEventFlags::MaskCommand)
  .union(CGEventFlags::MaskSecondaryFn);

/// The per-side bits of the left modifiers in an event's raw flags
/// (`NX_DEVICELCTLKEYMASK`, `NX_DEVICELALTKEYMASK`, `NX_DEVICELCMDKEYMASK`).
const LEFT_CONTROL_SIDE: u64 = 0x01;
const LEFT_OPTION_SIDE: u64 = 0x20;
const LEFT_COMMAND_SIDE: u64 = 0x08;

impl HoldKey {
  /// `kVK_Function`, `kVK_RightOption`, `kVK_RightCommand`,
  /// `kVK_RightControl`; None for a key macOS does not have.
  const fn keycode(self) -> Option<i64> {
    match self {
      Self::Fn => Some(63),
      Self::RightOption => Some(61),
      Self::RightCommand => Some(54),
      Self::RightControl => Some(62),
      Self::ControlWindows => None,
    }
  }

  const fn flag(self) -> CGEventFlags {
    match self {
      Self::Fn => CGEventFlags::MaskSecondaryFn,
      Self::RightOption => CGEventFlags::MaskAlternate,
      Self::RightCommand => CGEventFlags::MaskCommand,
      Self::RightControl | Self::ControlWindows => CGEventFlags::MaskControl,
    }
  }

  /// The per-side bit of the left key that shares this key's flag; 0 for fn.
  const fn other_side(self) -> u64 {
    match self {
      Self::Fn => 0,
      Self::RightOption => LEFT_OPTION_SIDE,
      Self::RightCommand => LEFT_COMMAND_SIDE,
      Self::RightControl | Self::ControlWindows => LEFT_CONTROL_SIDE,
    }
  }
}

/// What the `flagsChanged` events mean for one key. Pure, so the matching is
/// tested without a tap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Matcher {
  key: HoldKey,
  keycode: i64,
  held: bool,
  /// The session's count of key presses when the hold began, or when a key
  /// typed during it was last reported.
  key_downs: u32,
}

impl Matcher {
  const fn new(key: HoldKey, keycode: i64) -> Self {
    Self {
      key,
      keycode,
      held: false,
      key_downs: 0,
    }
  }

  /// One `flagsChanged` event, with the session's count of key presses read
  /// as it arrived. At most two edges: another key, then the release.
  /// - Press: the key's keycode arrives with its flag set (fn: its flag is
  ///   set on any event). It is part of a shortcut when another modifier is
  ///   down, the other side of the same key included.
  /// - Release: the key's keycode arrives again, or its flag is clear on any
  ///   event while held, which also covers a missed release.
  /// - Another modifier's keycode while held is another key, and so is a
  ///   count of key presses that moved since the press.
  fn feed(
    &mut self,
    keycode: i64,
    flags: CGEventFlags,
    key_downs: u32,
  ) -> Vec<HoldEdge> {
    let flag = self.key.flag();
    let flag_set = flags.contains(flag);
    if self.held {
      let mut edges = self.typed_since_press(key_downs);
      // Our side went up while the other side still holds the shared flag.
      let side_released = self.key != HoldKey::Fn && keycode == self.keycode;
      if !flag_set || side_released {
        self.held = false;
        edges.push(HoldEdge::Up);
      } else if edges.is_empty()
        && keycode != self.keycode
        && MODIFIER_KEYCODES.contains(&keycode)
      {
        edges.push(HoldEdge::OtherKey);
      }
      return edges;
    }
    if !flag_set || (self.key != HoldKey::Fn && keycode != self.keycode) {
      return Vec::new();
    }
    self.held = true;
    self.key_downs = key_downs;
    let others = flags & OTHER_MODIFIERS & !flag;
    let other_side = (flags.0 & self.key.other_side()) != 0;
    vec![HoldEdge::Down {
      others_held: !others.is_empty() || other_side,
    }]
  }

  /// Another key, if keys went down since the press or the last report.
  fn typed_since_press(&mut self, key_downs: u32) -> Vec<HoldEdge> {
    if key_downs == self.key_downs {
      return Vec::new();
    }
    self.key_downs = key_downs;
    vec![HoldEdge::OtherKey]
  }

  /// After the tap was off, from the flags, whether the key itself is down
  /// and the count of key presses now. A hold in progress may have missed a
  /// key or a release, so it is reported as interrupted (another key), with
  /// the release if the key is up now. A press missed meanwhile is not
  /// reported, so a dictation never starts halfway through a hold.
  fn resync(
    &mut self,
    flags_now: CGEventFlags,
    key_down_now: bool,
    key_downs: u32,
  ) -> Vec<HoldEdge> {
    if !self.held {
      return Vec::new();
    }
    self.key_downs = key_downs;
    // The other side can hold the shared flag; the key's own state says
    // whether our side is still down.
    let released = !flags_now.contains(self.key.flag())
      || (self.key != HoldKey::Fn && !key_down_now);
    let mut edges = vec![HoldEdge::OtherKey];
    if released {
      self.held = false;
      edges.push(HoldEdge::Up);
    }
    edges
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HoldKeyUnsupported;

/// Listens while it lives. Dropping it stops the listener within a second;
/// no edge is reported after the drop.
pub struct HoldKeyListener {
  stop: Arc<AtomicBool>,
}

impl Drop for HoldKeyListener {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::SeqCst);
  }
}

/// Starts listening for `key` on a thread of its own. `on_edge` runs on that
/// thread and must return quickly: a slow tap is disabled by macOS.
/// `on_listening` says whether the tap exists, false while Accessibility
/// access is missing.
pub fn listen_for_hold_key(
  key: HoldKey,
  on_edge: impl Fn(HoldEdge) + Send + 'static,
  on_listening: impl Fn(bool) + Send + 'static,
) -> Result<HoldKeyListener, HoldKeyUnsupported> {
  let keycode = key.keycode().ok_or(HoldKeyUnsupported)?;
  let stop = Arc::new(AtomicBool::new(false));
  let thread_stop = Arc::clone(&stop);
  thread::Builder::new()
    .name("dictation-hold-key".to_string())
    .spawn(move || {
      // Built on the thread: the tap pointer it holds never leaves it.
      let context = Context {
        matcher: Cell::new(Matcher::new(key, keycode)),
        tap: Cell::new(None),
        stop: thread_stop,
        on_edge: Box::new(on_edge),
      };
      run(&context, &on_listening);
    })
    .map_err(|_spawn_failed| HoldKeyUnsupported)?;
  Ok(HoldKeyListener { stop })
}

/// What the tap callback reads. Owned by the listener thread, which is the
/// only thread the callback runs on.
struct Context {
  matcher: Cell<Matcher>,
  /// The tap while it exists, for the callback to re-enable it.
  tap: Cell<Option<NonNull<CFMachPort>>>,
  stop: Arc<AtomicBool>,
  on_edge: Box<dyn Fn(HoldEdge)>,
}

impl Context {
  fn stopped(&self) -> bool {
    self.stop.load(Ordering::SeqCst)
  }

  fn emit(&self, edges: Vec<HoldEdge>) {
    for edge in edges {
      if self.stopped() {
        return;
      }
      (self.on_edge)(edge);
    }
  }

  fn feed(&self, keycode: i64, flags: CGEventFlags) {
    let mut matcher = self.matcher.get();
    let edges = matcher.feed(keycode, flags, key_downs());
    self.matcher.set(matcher);
    self.emit(edges);
  }

  /// Turns the tap back on if macOS turned it off, then reports the hold it
  /// interrupted, if any.
  fn ensure_enabled(&self, tap: &CFMachPort) {
    if CGEvent::tap_is_enabled(tap) {
      return;
    }
    CGEvent::tap_enable(tap, true);
    if !CGEvent::tap_is_enabled(tap) {
      return;
    }
    let mut matcher = self.matcher.get();
    let key_down_now = u16::try_from(matcher.keycode).is_ok_and(|keycode| {
      CGEventSource::key_state(CGEventSourceStateID::CombinedSessionState, keycode)
    });
    let edges = matcher.resync(
      CGEventSource::flags_state(CGEventSourceStateID::CombinedSessionState),
      key_down_now,
      key_downs(),
    );
    self.matcher.set(matcher);
    self.emit(edges);
  }
}

/// How many keys have gone down in this login session: a count, not which
/// keys, read without any permission.
fn key_downs() -> u32 {
  CGEventSource::counter_for_event_type(
    CGEventSourceStateID::CombinedSessionState,
    CGEventType::KeyDown,
  )
}

fn run(context: &Context, on_listening: &dyn Fn(bool)) {
  let mut listening = None;
  while !context.stopped() {
    let Some(tap) = create_tap(context) else {
      if listening != Some(false) {
        listening = Some(false);
        on_listening(false);
      }
      thread::sleep(RETRY);
      continue;
    };
    listening = Some(true);
    on_listening(true);
    serve(context, &tap);
    // Leaving with the key still down: the caller hears no release, but it
    // drops a stopped listener's edges anyway.
    if !context.stopped() {
      on_listening(false);
      listening = Some(false);
    }
  }
}

fn create_tap(context: &Context) -> Option<CFRetained<CFMachPort>> {
  // Without Accessibility access, creating a keyboard tap would make macOS
  // ask for Input Monitoring, which stella never asks for: wait instead.
  if !crate::accessibility_trusted() {
    return None;
  }
  let mask: CGEventMask = 1 << CGEventType::FlagsChanged.0;
  // SAFETY: `on_event` matches the callback signature, and `context` outlives
  // the tap: `serve` invalidates it before returning, and the context lives
  // until the thread ends.
  unsafe {
    CGEvent::tap_create(
      CGEventTapLocation::SessionEventTap,
      CGEventTapPlacement::HeadInsertEventTap,
      CGEventTapOptions::ListenOnly,
      mask,
      Some(on_event),
      std::ptr::from_ref(context).cast_mut().cast::<c_void>(),
    )
  }
}

/// Runs the tap until the listener stops.
fn serve(context: &Context, tap: &CFMachPort) {
  let (Some(source), Some(run_loop)) = (
    CFMachPort::new_run_loop_source(None, Some(tap), 0),
    CFRunLoop::current(),
  ) else {
    tap.invalidate();
    return;
  };
  // SAFETY: the run loop mode constants are immutable statics of
  // CoreFoundation, valid for the life of the process.
  let (common, default) = unsafe { (kCFRunLoopCommonModes, kCFRunLoopDefaultMode) };
  context.tap.set(Some(NonNull::from(tap)));
  run_loop.add_source(Some(&source), common);
  CGEvent::tap_enable(tap, true);
  while !context.stopped() {
    CFRunLoop::run_in_mode(default, TICK_SECONDS, false);
    context.ensure_enabled(tap);
  }
  CGEvent::tap_enable(tap, false);
  run_loop.remove_source(Some(&source), common);
  tap.invalidate();
  context.tap.set(None);
}

/// Returns every event unchanged: the tap only listens.
unsafe extern "C-unwind" fn on_event(
  _proxy: CGEventTapProxy,
  kind: CGEventType,
  event: NonNull<CGEvent>,
  user_info: *mut c_void,
) -> *mut CGEvent {
  // SAFETY: `user_info` is the listener thread's `Context`, which outlives
  // the tap (see `create_tap`); the callback runs only on that thread, from
  // its run loop.
  let context = unsafe { &*user_info.cast::<Context>().cast_const() };
  if kind == CGEventType::TapDisabledByTimeout
    || kind == CGEventType::TapDisabledByUserInput
  {
    if let Some(tap) = context.tap.get() {
      // SAFETY: the pointer is set only while `serve` holds the tap alive.
      context.ensure_enabled(unsafe { tap.as_ref() });
    }
  } else if kind == CGEventType::FlagsChanged {
    // SAFETY: the event is valid for the duration of the callback.
    let event_ref = unsafe { event.as_ref() };
    let keycode =
      CGEvent::integer_value_field(Some(event_ref), CGEventField::KeyboardEventKeycode);
    context.feed(keycode, CGEvent::flags(Some(event_ref)));
  }
  event.as_ptr()
}

#[cfg(test)]
mod tests {
  use super::*;

  const NONE: CGEventFlags = CGEventFlags::empty();
  /// The per-side bits of right Option and right Command.
  const RIGHT_OPTION_SIDE: u64 = 0x40;
  const RIGHT_COMMAND_SIDE: u64 = 0x10;
  /// No key typed: the count of key presses stays put.
  const COUNT: u32 = 7;
  const DOWN_ALONE: HoldEdge = HoldEdge::Down { others_held: false };
  const DOWN_IN_A_CHORD: HoldEdge = HoldEdge::Down { others_held: true };

  fn matcher(key: HoldKey) -> Matcher {
    Matcher::new(key, key.keycode().unwrap_or_default())
  }

  fn with_sides(flags: CGEventFlags, sides: u64) -> CGEventFlags {
    CGEventFlags(flags.0 | sides)
  }

  #[test]
  fn fn_press_and_release() {
    let mut fn_key = matcher(HoldKey::Fn);

    assert_eq!(
      fn_key.feed(63, CGEventFlags::MaskSecondaryFn, COUNT),
      [DOWN_ALONE]
    );
    assert_eq!(fn_key.feed(63, NONE, COUNT), [HoldEdge::Up]);
  }

  #[test]
  fn the_left_side_does_not_count_for_the_right() {
    let mut right = matcher(HoldKey::RightOption);
    let left_down = with_sides(CGEventFlags::MaskAlternate, LEFT_OPTION_SIDE);

    assert_eq!(right.feed(58, left_down, COUNT), []);
    assert_eq!(right.feed(58, NONE, COUNT), []);
    assert_eq!(
      right.feed(
        61,
        with_sides(CGEventFlags::MaskAlternate, RIGHT_OPTION_SIDE),
        COUNT
      ),
      [DOWN_ALONE]
    );
  }

  #[test]
  fn a_press_while_the_other_side_is_down_is_a_chord() {
    let mut right = matcher(HoldKey::RightOption);
    let left_down = with_sides(CGEventFlags::MaskAlternate, LEFT_OPTION_SIDE);

    right.feed(58, left_down, COUNT);
    assert_eq!(
      right.feed(61, with_sides(left_down, RIGHT_OPTION_SIDE), COUNT),
      [DOWN_IN_A_CHORD]
    );
  }

  #[test]
  fn releasing_our_side_while_the_other_holds_the_flag_is_a_release() {
    let mut right = matcher(HoldKey::RightCommand);

    right.feed(54, CGEventFlags::MaskCommand, COUNT);
    assert_eq!(
      right.feed(55, CGEventFlags::MaskCommand, COUNT),
      [HoldEdge::OtherKey]
    );
    assert_eq!(
      right.feed(54, CGEventFlags::MaskCommand, COUNT),
      [HoldEdge::Up]
    );
  }

  #[test]
  fn a_press_with_another_modifier_down_is_a_chord() {
    let mut fn_key = matcher(HoldKey::Fn);

    assert_eq!(
      fn_key.feed(
        63,
        CGEventFlags::MaskSecondaryFn | CGEventFlags::MaskShift,
        COUNT
      ),
      [DOWN_IN_A_CHORD]
    );
  }

  #[test]
  fn a_press_with_fn_down_is_a_chord() {
    let mut command = matcher(HoldKey::RightCommand);

    assert_eq!(
      command.feed(
        54,
        with_sides(
          CGEventFlags::MaskCommand | CGEventFlags::MaskSecondaryFn,
          RIGHT_COMMAND_SIDE
        ),
        COUNT
      ),
      [DOWN_IN_A_CHORD]
    );
  }

  #[test]
  fn another_modifier_while_held_is_reported() {
    let mut control = matcher(HoldKey::RightControl);

    control.feed(62, CGEventFlags::MaskControl, COUNT);
    assert_eq!(
      control.feed(
        56,
        CGEventFlags::MaskControl | CGEventFlags::MaskShift,
        COUNT
      ),
      [HoldEdge::OtherKey]
    );
  }

  #[test]
  fn a_key_typed_while_held_is_reported_before_the_release() {
    let mut command = matcher(HoldKey::RightCommand);

    command.feed(54, CGEventFlags::MaskCommand, COUNT);
    // Command-C: the C is counted, never seen.
    assert_eq!(
      command.feed(54, NONE, COUNT + 1),
      [HoldEdge::OtherKey, HoldEdge::Up]
    );
  }

  #[test]
  fn a_key_typed_while_held_is_reported_on_the_next_modifier_change() {
    let mut fn_key = matcher(HoldKey::Fn);

    fn_key.feed(63, CGEventFlags::MaskSecondaryFn, COUNT);
    assert_eq!(
      fn_key.feed(
        56,
        CGEventFlags::MaskSecondaryFn | CGEventFlags::MaskShift,
        COUNT + 2
      ),
      [HoldEdge::OtherKey]
    );
    assert_eq!(fn_key.feed(63, NONE, COUNT + 2), [HoldEdge::Up]);
  }

  #[test]
  fn keys_typed_before_the_press_do_not_count() {
    let mut fn_key = matcher(HoldKey::Fn);

    fn_key.feed(63, CGEventFlags::MaskSecondaryFn, COUNT);
    fn_key.feed(63, NONE, COUNT);
    assert_eq!(
      fn_key.feed(63, CGEventFlags::MaskSecondaryFn, COUNT + 5),
      [DOWN_ALONE]
    );
    assert_eq!(fn_key.feed(63, NONE, COUNT + 5), [HoldEdge::Up]);
  }

  #[test]
  fn a_count_that_wraps_still_moved() {
    let mut fn_key = matcher(HoldKey::Fn);

    fn_key.feed(63, CGEventFlags::MaskSecondaryFn, u32::MAX);
    assert_eq!(fn_key.feed(63, NONE, 0), [HoldEdge::OtherKey, HoldEdge::Up]);
  }

  #[test]
  fn caps_lock_is_not_another_modifier() {
    let mut fn_key = matcher(HoldKey::Fn);

    fn_key.feed(63, CGEventFlags::MaskSecondaryFn, COUNT);
    assert_eq!(
      fn_key.feed(
        57,
        CGEventFlags::MaskSecondaryFn | CGEventFlags::MaskAlphaShift,
        COUNT
      ),
      []
    );
  }

  #[test]
  fn a_flag_cleared_on_any_event_is_a_missed_release() {
    let mut fn_key = matcher(HoldKey::Fn);

    fn_key.feed(63, CGEventFlags::MaskSecondaryFn, COUNT);
    assert_eq!(
      fn_key.feed(56, CGEventFlags::MaskShift, COUNT),
      [HoldEdge::Up]
    );
  }

  #[test]
  fn resync_interrupts_a_hold_and_reports_a_missed_release() {
    let mut fn_key = matcher(HoldKey::Fn);

    assert_eq!(fn_key.resync(NONE, false, COUNT), []);
    fn_key.feed(63, CGEventFlags::MaskSecondaryFn, COUNT);
    assert_eq!(
      fn_key.resync(CGEventFlags::MaskSecondaryFn, true, COUNT),
      [HoldEdge::OtherKey]
    );
    assert_eq!(
      fn_key.resync(NONE, false, COUNT),
      [HoldEdge::OtherKey, HoldEdge::Up]
    );
    assert_eq!(fn_key.resync(NONE, false, COUNT), []);
  }

  #[test]
  fn resync_reads_our_side_when_the_other_holds_the_flag() {
    let mut right = matcher(HoldKey::RightCommand);

    right.feed(54, CGEventFlags::MaskCommand, COUNT);
    assert_eq!(
      right.resync(CGEventFlags::MaskCommand, false, COUNT),
      [HoldEdge::OtherKey, HoldEdge::Up]
    );
    assert_eq!(right.feed(55, NONE, COUNT), []);
  }

  #[test]
  fn a_press_missed_while_the_tap_was_off_is_not_reported() {
    let mut fn_key = matcher(HoldKey::Fn);

    assert_eq!(
      fn_key.resync(CGEventFlags::MaskSecondaryFn, true, COUNT),
      []
    );
  }

  #[test]
  fn control_windows_is_not_a_mac_key() {
    assert!(
      listen_for_hold_key(HoldKey::ControlWindows, |_edge| {}, |_listening| {})
        .is_err()
    );
  }
}
