//! Which key dictation listens for, and how its presses become dictations.
//!
//! On a Mac the default is fn held on its own; the speaker can pick another
//! modifier. On Windows the default is the combination of Control, Alt and
//! Space, which the global shortcut plugin registers without watching any
//! other key. Holding Control and the Windows key, or the right Control key,
//! needs a keyboard hook that sees every key going down, so Windows offers
//! those only as a choice the speaker makes.
//!
//! A modifier is also part of shortcuts typed on it, so a press becomes a
//! dictation only when it is the key alone and held long enough:
//! - a hold shorter than [`MINIMUM_HOLD`] is discarded without transcribing;
//! - a press while another modifier is already down does not record, and
//!   another key changing while the hold key is down cancels the recording.
//!
//! Recording still starts on the press, so nothing is lost to the wait; a
//! discarded hold just throws its audio away.

use std::time::Duration;

use serde::Serialize;

/// Holds shorter than this are taps or shortcuts, not dictation.
pub const MINIMUM_HOLD: Duration = Duration::from_millis(300);

/// The key dictation listens for, as the speaker chose it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HoldChoice {
  /// fn (the globe key), on a Mac.
  Fn,
  RightOption,
  RightCommand,
  /// The right Control key, on a Mac or on Windows.
  RightControl,
  /// Control and the Windows key together, on Windows.
  ControlWindows,
  /// Control, Option (Alt) and Space, held together.
  Combination,
}

impl HoldChoice {
  /// What this computer offers, the default first.
  pub const OFFERED: &'static [Self] = if cfg!(target_os = "windows") {
    &[Self::Combination, Self::ControlWindows, Self::RightControl]
  } else if cfg!(target_os = "macos") {
    &[
      Self::Fn,
      Self::RightOption,
      Self::RightCommand,
      Self::RightControl,
      Self::Combination,
    ]
  } else {
    &[Self::Combination]
  };

  pub const fn stored(self) -> &'static str {
    match self {
      Self::Fn => "fn",
      Self::RightOption => "rightOption",
      Self::RightCommand => "rightCommand",
      Self::RightControl => "rightControl",
      Self::ControlWindows => "controlWindows",
      Self::Combination => "combination",
    }
  }

  /// The stored choice when this computer offers it, otherwise the default.
  pub fn parse(stored: Option<&str>) -> Self {
    Self::OFFERED
      .iter()
      .copied()
      .find(|choice| Some(choice.stored()) == stored)
      .unwrap_or(Self::OFFERED[0])
  }

  /// The choice named by `value`, if this computer offers it.
  pub fn offered(value: &str) -> Option<Self> {
    Self::OFFERED
      .iter()
      .copied()
      .find(|choice| choice.stored() == value)
  }
}

/// One change of the hold key, as a listener reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
  /// The key went down. `others_held`: another modifier was already down.
  Down { others_held: bool },
  /// The key went up.
  Up,
  /// Another key changed while the hold key was down.
  OtherKey,
}

/// What a dictation does about an input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
  /// Start recording.
  Start,
  /// Stop recording and transcribe.
  Transcribe,
  /// Stop recording and discard it.
  Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Phase {
  #[default]
  Idle,
  /// Recording since this moment.
  Recording(Duration),
  /// The key is down, but this hold is a shortcut: ignored until release.
  Ignoring,
}

/// Turns hold key inputs into dictation actions. Pure, so the rules are
/// tested without a keyboard or a clock: `now` is any monotonic time, such
/// as the time since the listener started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Gesture {
  phase: Phase,
}

impl Gesture {
  pub fn handle(&mut self, input: Input, now: Duration) -> Option<Action> {
    match (self.phase, input) {
      (Phase::Idle, Input::Down { others_held: true }) => {
        self.phase = Phase::Ignoring;
        None
      }
      (Phase::Idle, Input::Down { others_held: false }) => {
        self.phase = Phase::Recording(now);
        Some(Action::Start)
      }
      (Phase::Recording(since), Input::Up) => {
        self.phase = Phase::Idle;
        Some(if now.saturating_sub(since) < MINIMUM_HOLD {
          Action::Cancel
        } else {
          Action::Transcribe
        })
      }
      (Phase::Recording(_), Input::OtherKey) => {
        self.phase = Phase::Ignoring;
        Some(Action::Cancel)
      }
      (Phase::Ignoring, Input::Up) => {
        self.phase = Phase::Idle;
        None
      }
      // A repeated press, a release with no press seen, or another key
      // outside a recording.
      _ => None,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const ALONE: Input = Input::Down { others_held: false };

  #[test]
  fn a_long_hold_transcribes() {
    let start = Duration::from_secs(10);
    let mut gesture = Gesture::default();

    assert_eq!(gesture.handle(ALONE, start), Some(Action::Start));
    assert_eq!(
      gesture.handle(Input::Up, start + MINIMUM_HOLD),
      Some(Action::Transcribe)
    );
  }

  #[test]
  fn a_short_tap_is_discarded() {
    let start = Duration::from_secs(10);
    let mut gesture = Gesture::default();

    gesture.handle(ALONE, start);
    assert_eq!(
      gesture.handle(Input::Up, start + Duration::from_millis(120)),
      Some(Action::Cancel)
    );
  }

  #[test]
  fn another_key_while_held_cancels_and_the_rest_of_the_hold_is_ignored() {
    let start = Duration::from_secs(10);
    let mut gesture = Gesture::default();

    gesture.handle(ALONE, start);
    assert_eq!(gesture.handle(Input::OtherKey, start), Some(Action::Cancel));
    assert_eq!(gesture.handle(Input::OtherKey, start), None);
    assert_eq!(gesture.handle(Input::Up, start + MINIMUM_HOLD * 3), None);
    assert_eq!(gesture.handle(ALONE, start), Some(Action::Start));
  }

  #[test]
  fn a_press_with_another_modifier_down_never_records() {
    let start = Duration::from_secs(10);
    let mut gesture = Gesture::default();

    assert_eq!(
      gesture.handle(Input::Down { others_held: true }, start),
      None
    );
    assert_eq!(gesture.handle(Input::Up, start + MINIMUM_HOLD * 3), None);
  }

  #[test]
  fn repeats_and_stray_releases_do_nothing() {
    let start = Duration::from_secs(10);
    let mut gesture = Gesture::default();

    assert_eq!(gesture.handle(Input::Up, start), None);
    gesture.handle(ALONE, start);
    assert_eq!(gesture.handle(ALONE, start), None);
  }

  #[test]
  fn the_first_offered_choice_is_the_default() {
    assert_eq!(HoldChoice::parse(None), HoldChoice::OFFERED[0]);
    assert_eq!(HoldChoice::parse(Some("unknown")), HoldChoice::OFFERED[0]);
    assert_eq!(
      HoldChoice::parse(Some("combination")),
      HoldChoice::Combination
    );
  }

  #[test]
  fn every_offered_choice_reads_back_from_its_stored_name() {
    for choice in HoldChoice::OFFERED {
      assert_eq!(HoldChoice::offered(choice.stored()), Some(*choice));
    }
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn a_mac_defaults_to_fn_and_offers_no_windows_key() {
    assert_eq!(HoldChoice::OFFERED[0], HoldChoice::Fn);
    assert_eq!(HoldChoice::offered("controlWindows"), None);
  }

  #[cfg(target_os = "windows")]
  #[test]
  fn windows_defaults_to_the_combination_and_offers_no_fn() {
    assert_eq!(HoldChoice::OFFERED[0], HoldChoice::Combination);
    assert_eq!(HoldChoice::offered("fn"), None);
  }
}
