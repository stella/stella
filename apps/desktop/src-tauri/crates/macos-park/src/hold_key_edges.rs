//! The keys dictation can be held on and what a listener reports about
//! them, shared by the macOS and Windows listeners. The Windows matcher is
//! pure and lives here, so it is tested on every platform.

/// A key, or on Windows a pair, held on its own to dictate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HoldKey {
  /// fn (the globe key) on a Mac.
  Fn,
  /// The right Option key on a Mac.
  RightOption,
  /// The right Command key on a Mac.
  RightCommand,
  /// The right Control key, on a Mac or on Windows.
  RightControl,
  /// Control and the Windows key together, either side of each, on Windows.
  ControlWindows,
}

/// One change of the hold key, as a listener sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldEdge {
  /// The key went down. `others_held`: another modifier was already down,
  /// so this press is part of a shortcut.
  Down { others_held: bool },
  /// The key went up.
  Up,
  /// Another key changed while the hold key was down: a shortcut on it.
  OtherKey,
}

/// Windows virtual-key codes the matcher reads (`VK_*`).
pub(crate) mod vk {
  pub const LSHIFT: u16 = 0xA0;
  pub const RSHIFT: u16 = 0xA1;
  pub const LCONTROL: u16 = 0xA2;
  pub const RCONTROL: u16 = 0xA3;
  pub const LMENU: u16 = 0xA4;
  pub const RMENU: u16 = 0xA5;
  pub const LWIN: u16 = 0x5B;
  pub const RWIN: u16 = 0x5C;
  pub const CONTROL: u16 = 0x11;
}

/// The keys a Windows hold key is made of and the modifiers that make a
/// press part of a shortcut.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct Down {
  control: [bool; 2],
  windows: [bool; 2],
  shift: [bool; 2],
  alt: [bool; 2],
  right_control: bool,
}

impl Down {
  /// The keys this state tracks, each side of each modifier.
  const TRACKED: [u16; 8] = [
    vk::LCONTROL,
    vk::RCONTROL,
    vk::LWIN,
    vk::RWIN,
    vk::LSHIFT,
    vk::RSHIFT,
    vk::LMENU,
    vk::RMENU,
  ];

  fn set(&mut self, code: u16, down: bool) {
    match code {
      vk::LCONTROL => self.control[0] = down,
      vk::RCONTROL => {
        self.control[1] = down;
        self.right_control = down;
      }
      vk::LWIN => self.windows[0] = down,
      vk::RWIN => self.windows[1] = down,
      vk::LSHIFT => self.shift[0] = down,
      vk::RSHIFT => self.shift[1] = down,
      vk::LMENU => self.alt[0] = down,
      vk::RMENU => self.alt[1] = down,
      _ => {}
    }
  }

  fn any(pair: [bool; 2]) -> bool {
    pair[0] || pair[1]
  }
}

/// What the low-level keyboard events mean for one Windows hold key. Pure,
/// so it is tested without a hook. Events the system or another app
/// injected never reach it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsMatcher {
  key: HoldKey,
  down: Down,
  held: bool,
}

impl WindowsMatcher {
  /// None for a key Windows keyboards do not have.
  pub fn new(key: HoldKey) -> Option<Self> {
    matches!(key, HoldKey::RightControl | HoldKey::ControlWindows).then_some(Self {
      key,
      down: Down::default(),
      held: false,
    })
  }

  /// Takes the modifiers already down when listening starts, as `is_down`
  /// reads them, since the hook hears only later changes. Reports nothing:
  /// a hold key already down when listening starts is treated as held, so a
  /// dictation never starts halfway through a hold.
  pub fn sync(&mut self, is_down: impl Fn(u16) -> bool) {
    for code in Down::TRACKED {
      self.down.set(code, is_down(code));
    }
    self.held = self.active();
  }

  /// Whether `code` belongs to the hold key itself, so its repeats while held
  /// are not another key.
  fn part_of_key(&self, code: u16) -> bool {
    match self.key {
      HoldKey::ControlWindows => matches!(
        code,
        vk::LCONTROL | vk::RCONTROL | vk::LWIN | vk::RWIN | vk::CONTROL
      ),
      _ => matches!(code, vk::RCONTROL | vk::CONTROL),
    }
  }

  fn active(&self) -> bool {
    match self.key {
      HoldKey::ControlWindows => {
        Down::any(self.down.control) && Down::any(self.down.windows)
      }
      _ => self.down.right_control,
    }
  }

  /// Another modifier down besides the hold key's own.
  fn others_held(&self) -> bool {
    let shift_or_alt = Down::any(self.down.shift) || Down::any(self.down.alt);
    match self.key {
      HoldKey::ControlWindows => shift_or_alt,
      _ => shift_or_alt || self.down.control[0] || Down::any(self.down.windows),
    }
  }

  /// One key event: `code` went down (`down`) or up.
  pub fn feed(&mut self, code: u16, down: bool) -> Option<HoldEdge> {
    self.down.set(code, down);
    if self.held {
      if !self.active() {
        self.held = false;
        return Some(HoldEdge::Up);
      }
      // A repeat of the hold key's own keys while held is not another key.
      return (down && !self.part_of_key(code)).then_some(HoldEdge::OtherKey);
    }
    if down && self.part_of_key(code) && self.active() {
      self.held = true;
      return Some(HoldEdge::Down {
        others_held: self.others_held(),
      });
    }
    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn control_windows() -> WindowsMatcher {
    WindowsMatcher::new(HoldKey::ControlWindows).unwrap_or_else(|| unreachable!())
  }

  fn right_control() -> WindowsMatcher {
    WindowsMatcher::new(HoldKey::RightControl).unwrap_or_else(|| unreachable!())
  }

  const KEY_D: u16 = 0x44;

  #[test]
  fn control_then_windows_is_a_press_and_either_up_a_release() {
    let mut pair = control_windows();

    assert_eq!(pair.feed(vk::LCONTROL, true), None);
    assert_eq!(
      pair.feed(vk::LWIN, true),
      Some(HoldEdge::Down { others_held: false })
    );
    assert_eq!(
      pair.feed(vk::LWIN, true),
      None,
      "a repeat is not another key"
    );
    assert_eq!(pair.feed(vk::LCONTROL, false), Some(HoldEdge::Up));
    assert_eq!(pair.feed(vk::LWIN, false), None);
  }

  #[test]
  fn windows_then_control_is_a_press_too() {
    let mut pair = control_windows();

    pair.feed(vk::RWIN, true);
    assert_eq!(
      pair.feed(vk::RCONTROL, true),
      Some(HoldEdge::Down { others_held: false })
    );
    assert_eq!(pair.feed(vk::RWIN, false), Some(HoldEdge::Up));
  }

  #[test]
  fn a_letter_while_held_is_a_shortcut() {
    let mut pair = control_windows();

    pair.feed(vk::LCONTROL, true);
    pair.feed(vk::LWIN, true);
    assert_eq!(pair.feed(KEY_D, true), Some(HoldEdge::OtherKey));
    assert_eq!(pair.feed(KEY_D, false), None);
  }

  #[test]
  fn a_press_with_shift_down_is_a_chord() {
    let mut pair = control_windows();

    pair.feed(vk::LSHIFT, true);
    pair.feed(vk::LCONTROL, true);
    assert_eq!(
      pair.feed(vk::LWIN, true),
      Some(HoldEdge::Down { others_held: true })
    );
  }

  #[test]
  fn right_control_alone() {
    let mut control = right_control();

    assert_eq!(control.feed(vk::LCONTROL, true), None);
    control.feed(vk::LCONTROL, false);
    assert_eq!(
      control.feed(vk::RCONTROL, true),
      Some(HoldEdge::Down { others_held: false })
    );
    assert_eq!(control.feed(vk::RCONTROL, true), None, "a repeat");
    assert_eq!(control.feed(vk::RSHIFT, true), Some(HoldEdge::OtherKey));
    assert_eq!(control.feed(vk::RCONTROL, false), Some(HoldEdge::Up));
  }

  #[test]
  fn right_control_after_the_windows_key_is_a_chord() {
    let mut control = right_control();

    control.feed(vk::LWIN, true);
    assert_eq!(
      control.feed(vk::RCONTROL, true),
      Some(HoldEdge::Down { others_held: true })
    );
  }

  #[test]
  fn shift_already_down_when_listening_starts_makes_a_chord() {
    let mut pair = control_windows();

    pair.sync(|code| code == vk::LSHIFT);
    pair.feed(vk::LCONTROL, true);
    assert_eq!(
      pair.feed(vk::LWIN, true),
      Some(HoldEdge::Down { others_held: true })
    );
  }

  #[test]
  fn nothing_down_when_listening_starts_changes_nothing() {
    let mut control = right_control();

    control.sync(|_code| false);
    assert_eq!(
      control.feed(vk::RCONTROL, true),
      Some(HoldEdge::Down { others_held: false })
    );
  }

  #[test]
  fn a_hold_key_already_down_when_listening_starts_never_records() {
    let mut control = right_control();

    control.sync(|code| code == vk::RCONTROL);
    assert_eq!(control.feed(vk::RCONTROL, true), None, "a repeat");
    assert_eq!(control.feed(vk::RCONTROL, false), Some(HoldEdge::Up));
    assert_eq!(
      control.feed(vk::RCONTROL, true),
      Some(HoldEdge::Down { others_held: false })
    );
  }

  #[test]
  fn mac_keys_have_no_windows_matcher() {
    assert!(WindowsMatcher::new(HoldKey::Fn).is_none());
    assert!(WindowsMatcher::new(HoldKey::RightOption).is_none());
  }
}
