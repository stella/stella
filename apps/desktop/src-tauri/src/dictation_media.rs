//! What dictation does to other sound while it records: nothing (the
//! default), lower the output volume, or (on a Mac) pause what Music or
//! Spotify is playing, so it does not end up in the transcript. Optionally
//! only while sound plays through speakers: a microphone does not hear
//! headphones.
//!
//! Whatever is changed is put back when recording stops, however the
//! dictation ends. The guard puts it back when it is dropped: at the end of
//! recording, on a cancel, when dictation is turned off, and when a panic
//! unwinds the dictation thread. Quitting puts back what a dictation still
//! holds. A record written before the volume changes lets the next launch
//! put back what a crash left. A volume the speaker changed meanwhile is
//! left as they set it.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine record")
)]

use std::{
  sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
  },
  thread::{self, JoinHandle},
  time::Duration,
};

use serde::{Deserialize, Serialize};

use crate::device_preference::DevicePreference;

pub const PREFERENCE_FILE_NAME: &str = "dictation-while-dictating";
/// On unless the speaker turned it off.
pub const SPEAKERS_ONLY_PREFERENCE_FILE_NAME: &str = "dictation-media-speakers-only";
/// What a dictation changed and has not put back yet; empty otherwise.
const HELD_FILE_NAME: &str = "dictation-media-held";
/// The volume goes down to this share of what it was.
const LOWERED_SHARE: f32 = 0.2;
/// At or below this the output is silent already: nothing to lower.
const SILENT: f32 = 0.01;
/// A volume within this of the one set is still the one set.
const SAME_VOLUME: f32 = 0.02;

/// What happens to other sound while dictation records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WhileDictating {
  Nothing,
  Lower,
  #[cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, reason = "offered on a Mac only")
  )]
  Pause,
}

impl WhileDictating {
  /// Pausing reaches the Mac's music players only.
  pub const OFFERED: &'static [Self] = if cfg!(target_os = "macos") {
    &[Self::Nothing, Self::Lower, Self::Pause]
  } else {
    &[Self::Nothing, Self::Lower]
  };

  /// The stored preference; anything unknown or not offered here is
  /// nothing.
  pub fn parse(stored: Option<&str>) -> Self {
    Self::OFFERED
      .iter()
      .copied()
      .find(|choice| Some(choice.stored()) == stored)
      .unwrap_or(Self::Nothing)
  }

  pub const fn stored(self) -> &'static str {
    match self {
      Self::Nothing => "nothing",
      Self::Lower => "lower",
      Self::Pause => "pause",
    }
  }
}

/// A music player whose playback a dictation can pause.
#[cfg_attr(
  not(target_os = "macos"),
  allow(dead_code, reason = "pausing is offered on a Mac only")
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Player {
  Music,
  Spotify,
}

/// What a dictation changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Held {
  /// The output `device` went from `previous` down to `lowered`.
  Lowered {
    device: String,
    previous: f32,
    lowered: f32,
  },
  /// These players were playing and were paused.
  Paused { players: Vec<Player> },
}

/// What the running dictation holds, for the guard and for quitting.
static HELD: Mutex<Option<Held>> = Mutex::new(None);

/// Changes other sound for one recording and puts it back when dropped.
pub struct MediaGuard {
  apply: Option<JoinHandle<()>>,
  ended: Arc<AtomicBool>,
}

/// Starts `choice` after `delay` (the start sound plays at full volume
/// first), off the dictation thread, so a slow player never delays
/// recording. `None` when there is nothing to do.
pub fn begin(
  choice: WhileDictating,
  speakers_only: bool,
  delay: Duration,
) -> Option<MediaGuard> {
  if choice == WhileDictating::Nothing {
    return None;
  }
  let ended = Arc::new(AtomicBool::new(false));
  let ended_before = Arc::clone(&ended);
  let apply = thread::Builder::new()
    .name("dictation-media".to_string())
    .spawn(move || {
      thread::sleep(delay);
      if ended_before.load(Ordering::SeqCst) {
        return;
      }
      if speakers_only && platform::plays_on_headphones() {
        tracing::info!("dictation left other sound alone: it plays on headphones");
        return;
      }
      let held = match choice {
        WhileDictating::Lower => lower(),
        WhileDictating::Pause => platform::pause(),
        WhileDictating::Nothing => None,
      };
      if let Some(held) = held {
        hold(held);
      }
    })
    .inspect_err(|error| {
      tracing::warn!(%error, "dictation could not change other sound");
    })
    .ok();
  Some(MediaGuard { apply, ended })
}

impl Drop for MediaGuard {
  fn drop(&mut self) {
    self.ended.store(true, Ordering::SeqCst);
    // A change in progress finishes first, so it is put back too.
    if let Some(apply) = self.apply.take()
      && apply.join().is_err()
    {
      tracing::warn!("changing other sound for dictation panicked");
    }
    restore();
  }
}

/// Puts back what a dictation still holds, or what a record left by a
/// crash says one held. Run when the guard drops, at launch and on quit.
pub fn restore() {
  let held = HELD
    .lock()
    .unwrap_or_else(|error| error.into_inner())
    .take()
    .or_else(read_record);
  if let Some(held) = held {
    undo(held);
  }
  write_record(None);
}

fn hold(held: Held) {
  write_record(Some(&held));
  *HELD.lock().unwrap_or_else(|error| error.into_inner()) = Some(held);
}

fn lower() -> Option<Held> {
  let device = platform::default_output_device_id()?;
  let previous = platform::output_volume(&device)?;
  if previous <= SILENT {
    return None;
  }
  let lowered = previous * LOWERED_SHARE;
  // Recorded before the change, so a crash right after it is put back.
  write_record(Some(&Held::Lowered {
    device: device.clone(),
    previous,
    lowered,
  }));
  if !platform::set_output_volume(&device, lowered) {
    write_record(None);
    return None;
  }
  tracing::info!("dictation lowered other sound");
  // The device may round the volume set: what it reads back is what is
  // compared when it is put back.
  let lowered = platform::output_volume(&device).unwrap_or(lowered);
  Some(Held::Lowered {
    device,
    previous,
    lowered,
  })
}

fn undo(held: Held) {
  match held {
    Held::Lowered {
      device,
      previous,
      lowered,
    } => {
      let now = platform::output_volume(&device);
      if should_restore_volume(now, lowered) {
        if platform::set_output_volume(&device, previous) {
          tracing::info!("dictation put the volume back");
        } else {
          tracing::warn!("dictation could not put the volume back");
        }
      }
    }
    Held::Paused { players } => platform::resume(&players),
  }
}

/// Whether the volume is still the one dictation set: one the speaker
/// changed meanwhile, or a device gone, is left alone.
fn should_restore_volume(now: Option<f32>, lowered: f32) -> bool {
  now.is_some_and(|now| (now - lowered).abs() <= SAME_VOLUME)
}

fn record() -> DevicePreference {
  DevicePreference::in_app_data(HELD_FILE_NAME)
}

fn read_record() -> Option<Held> {
  let stored = record().read()?;
  serde_json::from_str(&stored)
    .inspect_err(|error| {
      tracing::warn!(%error, "the record of a dictation's sound change was not read");
    })
    .ok()
}

fn write_record(held: Option<&Held>) {
  // Nothing held and nothing recorded: no file is written.
  if held.is_none() && record().read().is_none() {
    return;
  }
  let value = held
    .map(serde_json::to_string)
    .transpose()
    .unwrap_or_else(|error| {
      tracing::warn!(%error, "the record of a dictation's sound change was not made");
      None
    })
    .unwrap_or_default();
  if let Err(error) = record().write(&value) {
    tracing::warn!(%error, "the record of a dictation's sound change was not stored");
  }
}

#[cfg(all(dictation, target_os = "macos"))]
mod platform {
  use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
  };

  use super::{Held, Player};

  pub use stella_desktop_macos::{
    default_output_device_id, output_volume, set_output_volume,
  };

  /// A player that does not answer in this long is left as it is.
  const SCRIPT_TIMEOUT: Duration = Duration::from_secs(3);
  const SCRIPT_POLL: Duration = Duration::from_millis(20);

  impl Player {
    const ALL: [Self; 2] = [Self::Music, Self::Spotify];

    const fn bundle_id(self) -> &'static str {
      match self {
        Self::Music => "com.apple.Music",
        Self::Spotify => "com.spotify.client",
      }
    }
  }

  pub fn plays_on_headphones() -> bool {
    default_output_device_id()
      .and_then(|id| stella_desktop_macos::output_plays_on_headphones(&id))
      .unwrap_or(false)
  }

  /// Pauses each player that is running and playing. A player that is not
  /// running is never asked, so none is launched.
  pub fn pause() -> Option<Held> {
    let players = Player::ALL
      .into_iter()
      .filter(|player| {
        script(&format!("application id \"{}\" is running", player.bundle_id()))
          .as_deref()
          == Some("true")
      })
      .filter(|player| {
        script(&format!(
          "tell application id \"{}\"\nif player state is playing then\npause\nreturn \"paused\"\nend if\nend tell\nreturn \"\"",
          player.bundle_id()
        ))
        .as_deref()
          == Some("paused")
      })
      .collect::<Vec<_>>();
    if players.is_empty() {
      return None;
    }
    tracing::info!(count = players.len(), "dictation paused music");
    Some(Held::Paused { players })
  }

  pub fn resume(players: &[Player]) {
    for player in players {
      if script(&format!(
        "tell application id \"{}\" to play",
        player.bundle_id()
      ))
      .is_none()
      {
        tracing::warn!("dictation could not resume music");
      }
    }
  }

  /// Runs one AppleScript and returns what it printed; `None` when it fails,
  /// is refused permission to control the player, or does not finish in
  /// time.
  fn script(source: &str) -> Option<String> {
    let mut child = Command::new("/usr/bin/osascript")
      .arg("-e")
      .arg(source)
      .stdin(Stdio::null())
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .spawn()
      .inspect_err(|error| tracing::debug!(%error, "osascript did not start"))
      .ok()?;
    let started = Instant::now();
    loop {
      match child.try_wait() {
        Ok(Some(status)) => {
          let mut printed = String::new();
          child.stdout.take()?.read_to_string(&mut printed).ok()?;
          return status.success().then(|| printed.trim().to_string());
        }
        Ok(None) if started.elapsed() < SCRIPT_TIMEOUT => thread::sleep(SCRIPT_POLL),
        Ok(None) | Err(_) => {
          if let Err(error) = child.kill() {
            tracing::debug!(%error, "osascript could not be stopped");
          }
          if let Err(error) = child.wait() {
            tracing::debug!(%error, "osascript was not reaped");
          }
          return None;
        }
      }
    }
  }
}

#[cfg(all(dictation, not(target_os = "macos")))]
mod platform {
  use cpal::{
    DeviceType, InterfaceType,
    traits::{DeviceTrait, HostTrait},
  };

  use super::{Held, Player};

  pub use stella_desktop_macos::{
    default_output_device_id, output_volume, set_output_volume,
  };

  /// What the default endpoint says it is: headphones and headsets by their
  /// form factor, and Bluetooth devices, most of which are worn.
  pub fn plays_on_headphones() -> bool {
    cpal::default_host()
      .default_output_device()
      .and_then(|device| device.description().ok())
      .is_some_and(|description| {
        matches!(
          description.device_type(),
          DeviceType::Headphones
            | DeviceType::Headset
            | DeviceType::Earpiece
            | DeviceType::Handset
            | DeviceType::HearingAid
        ) || description.interface_type() == InterfaceType::Bluetooth
      })
  }

  /// Not offered here: `WhileDictating::OFFERED` leaves it out.
  pub const fn pause() -> Option<Held> {
    None
  }

  pub fn resume(_players: &[Player]) {}
}

/// Builds without the speech engine never record.
#[cfg(not(dictation))]
mod platform {
  use super::{Held, Player};

  pub const fn plays_on_headphones() -> bool {
    false
  }

  pub const fn default_output_device_id() -> Option<String> {
    None
  }

  pub const fn output_volume(_id: &str) -> Option<f32> {
    None
  }

  pub const fn set_output_volume(_id: &str, _volume: f32) -> bool {
    false
  }

  pub const fn pause() -> Option<Held> {
    None
  }

  pub fn resume(_players: &[Player]) {}
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_choice_reads_back_and_defaults_to_nothing() {
    for choice in WhileDictating::OFFERED {
      assert_eq!(WhileDictating::parse(Some(choice.stored())), *choice);
      assert_eq!(
        serde_json::to_value(choice).unwrap(),
        serde_json::json!(choice.stored())
      );
    }
    assert_eq!(WhileDictating::parse(None), WhileDictating::Nothing);
    assert_eq!(WhileDictating::parse(Some("mute")), WhileDictating::Nothing);
    assert_eq!(
      WhileDictating::parse(Some("pause")),
      if cfg!(target_os = "macos") {
        WhileDictating::Pause
      } else {
        WhileDictating::Nothing
      }
    );
  }

  #[test]
  fn only_the_volume_dictation_set_is_put_back() {
    assert!(should_restore_volume(Some(0.1), 0.1));
    assert!(should_restore_volume(Some(0.11), 0.1));
    // The speaker turned it up or down meanwhile, or the device is gone.
    assert!(!should_restore_volume(Some(0.5), 0.1));
    assert!(!should_restore_volume(Some(0.0), 0.1));
    assert!(!should_restore_volume(None, 0.1));
  }

  #[test]
  fn the_record_of_a_change_reads_back() {
    let lowered = Held::Lowered {
      device: "BuiltInSpeakerDevice".to_string(),
      previous: 0.5,
      lowered: 0.1,
    };
    let paused = Held::Paused {
      players: vec![Player::Spotify],
    };
    for held in [lowered, paused] {
      let stored = serde_json::to_string(&held).unwrap();
      assert_eq!(serde_json::from_str::<Held>(&stored).unwrap(), held);
    }
  }

  #[test]
  fn doing_nothing_starts_nothing() {
    assert!(begin(WhileDictating::Nothing, true, Duration::ZERO).is_none());
  }
}
