//! The local log's account of each dictation: how long its steps took and
//! how it ended, so a slow dictation, or one that was kept in clipboard
//! history but not typed, can be explained from `desktop.log`.
//!
//! A line names ids, kinds, counts and durations only: never audio, the
//! transcript, window titles or the text before the cursor. Lines follow the
//! `desktop timing window=… span=… duration_ms=…` shape of the clipboard's
//! spans, but they stay on this computer: `desktop_telemetry` also sends
//! clipboard spans to the analytics sink while reporting is on, and nothing
//! here is queued for it, since these lines describe dictation settings
//! (where speech is transcribed, with which model) that its payload does not
//! carry.

#![cfg_attr(
  not(dictation),
  allow(
    dead_code,
    reason = "only builds with the speech engine trace dictations"
  )
)]

use std::{
  fmt,
  time::{Duration, Instant},
};

use crate::{
  dictation::Failed, dictation_cloud::Destination, dictation_focus::Moved,
  dictation_live::Tally,
};

/// Model ids come from the server's list: anything but these characters is
/// replaced, so a line stays one token per field.
const MAX_MODEL_ID_CHARS: usize = 64;

/// How AI cleanup went for one dictation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cleanup {
  /// Turned off: the transcript is typed as it is.
  Off,
  Applied,
  /// Refused, failed or implausible: the transcript is typed.
  Skipped,
  TimedOut,
  /// Longer than cleanup accepts: the transcript is typed.
  TooLong,
}

/// How a dictation ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
  Typed,
  /// No speech, or a transcript with no words: nothing to type.
  Empty,
  /// A tap, a shortcut on the hold key, or dictation turned off meanwhile.
  Cancelled,
  Failed(Failed),
}

/// One line of the local log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
  /// Press until release.
  Hold {
    duration: Duration,
    audio: Duration,
    /// Stretches cut at a pause while the key was down.
    stretches: usize,
    /// The system's own setting for the globe key, read raw, while the
    /// hold key is fn; `None` while another key is used.
    globe_key: Option<GlobeKey>,
  },
  /// Release until the transcript was ready.
  Transcribe {
    duration: Duration,
    destination: Destination,
    /// The model that answered last: stella AI's, or this computer's once
    /// a stella AI failure fell back to it.
    model: Option<String>,
    tally: Tally,
  },
  /// The cleanup round trip; zero while cleanup is off.
  Cleanup {
    duration: Duration,
    cleanup: Cleanup,
  },
  /// The text was ready until it was typed, or refused.
  Insert {
    duration: Duration,
    /// The focus read right before typing; about a second means the main
    /// thread did not answer in time.
    focus_read: Option<Duration>,
    kept_in_history: bool,
  },
  /// Press until the end, and how it ended.
  End {
    duration: Duration,
    outcome: Outcome,
    /// What differed between the focus at the press and before typing.
    moved: Option<Moved>,
  },
}

/// The globe key's system setting (`AppleFnUsageType`), as stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlobeKey {
  /// Never changed: the system default applies.
  Unset,
  #[cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, reason = "only a Mac reads the globe key setting")
  )]
  Value(i64),
}

impl Line {
  const fn span(&self) -> &'static str {
    match self {
      Self::Hold { .. } => "DictationHold",
      Self::Transcribe { .. } => "DictationTranscribe",
      Self::Cleanup { .. } => "DictationCleanup",
      Self::Insert { .. } => "DictationInsert",
      Self::End { .. } => "DictationEnd",
    }
  }

  const fn duration(&self) -> Duration {
    match self {
      Self::Hold { duration, .. }
      | Self::Transcribe { duration, .. }
      | Self::Cleanup { duration, .. }
      | Self::Insert { duration, .. }
      | Self::End { duration, .. } => *duration,
    }
  }

  /// Writes the line to the local log, and nowhere else.
  pub fn log(&self) {
    tracing::info!("desktop timing {self}");
  }
}

const fn millis(duration: Duration) -> u128 {
  duration.as_millis()
}

const fn destination(destination: Destination) -> &'static str {
  match destination {
    Destination::Local => "Local",
    Destination::Cloud => "StellaAi",
  }
}

fn model_token(model: &str) -> String {
  model
    .chars()
    .take(MAX_MODEL_ID_CHARS)
    .map(|character| {
      if character.is_ascii_alphanumeric() || "._:/-".contains(character) {
        character
      } else {
        '_'
      }
    })
    .collect()
}

impl fmt::Display for Line {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(
      f,
      "window=Dictation span={} duration_ms={}",
      self.span(),
      millis(self.duration())
    )?;
    match self {
      Self::Hold {
        audio,
        stretches,
        globe_key,
        ..
      } => {
        write!(f, " audio_ms={} stretches={stretches}", millis(*audio))?;
        match globe_key {
          Some(GlobeKey::Unset) => write!(f, " globe_key=unset"),
          Some(GlobeKey::Value(value)) => write!(f, " globe_key={value}"),
          None => Ok(()),
        }
      }
      Self::Transcribe {
        destination: chosen,
        model,
        tally,
        ..
      } => {
        // stella AI answers only until it fails once.
        let engine = match chosen {
          Destination::Cloud if !tally.fell_back => "StellaAi",
          Destination::Cloud | Destination::Local => "Local",
        };
        write!(f, " destination={} engine={engine}", destination(*chosen))?;
        if let Some(model) = model {
          write!(f, " model={}", model_token(model))?;
        }
        write!(
          f,
          " stretches={} requests={} fallback={} audio_ms={}",
          tally.stretches,
          tally.requests,
          tally.fell_back,
          millis(tally.speech)
        )
      }
      Self::Cleanup { cleanup, .. } => {
        let on = !matches!(cleanup, Cleanup::Off);
        write!(
          f,
          " cleanup={} outcome={cleanup:?}",
          if on { "on" } else { "off" }
        )
      }
      Self::Insert {
        focus_read,
        kept_in_history,
        ..
      } => {
        if let Some(read) = focus_read {
          write!(f, " focus_read_ms={}", millis(*read))?;
        }
        write!(f, " kept_in_history={kept_in_history}")
      }
      Self::End { outcome, moved, .. } => {
        match outcome {
          Outcome::Failed(Failed {
            failure,
            kept_in_history,
          }) => write!(
            f,
            " outcome=Failed failure={failure:?} kept_in_history={kept_in_history}"
          )?,
          other => write!(f, " outcome={other:?}")?,
        }
        match moved {
          Some(moved) => write!(f, " focus_moved={moved:?}"),
          None => Ok(()),
        }
      }
    }
  }
}

/// The clock of one dictation, from the press.
pub struct Trace {
  pressed: Instant,
  released: Option<Instant>,
}

impl Trace {
  pub fn pressed() -> Self {
    Self {
      pressed: Instant::now(),
      released: None,
    }
  }

  /// Marks the release and returns how long the key was down.
  pub fn release(&mut self) -> Duration {
    let now = Instant::now();
    self.released = Some(now);
    now.duration_since(self.pressed)
  }

  /// How long the key was down; zero before the release.
  pub fn held(&self) -> Duration {
    self.released.map_or(Duration::ZERO, |released| {
      released.duration_since(self.pressed)
    })
  }

  /// Since the release, or since the press before one.
  pub fn since_release(&self) -> Duration {
    self.released.unwrap_or(self.pressed).elapsed()
  }

  pub fn since_press(&self) -> Duration {
    self.pressed.elapsed()
  }
}

/// Times `step`, for a line about it.
pub fn timed<T>(step: impl FnOnce() -> T) -> (T, Duration) {
  let started = Instant::now();
  let value = step();
  (value, started.elapsed())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::dictation::Failure;

  const fn ms(millis: u64) -> Duration {
    Duration::from_millis(millis)
  }

  #[test]
  fn a_hold_names_its_audio_and_stretches_and_the_globe_key_setting() {
    let hold = Line::Hold {
      duration: ms(4_210),
      audio: ms(4_180),
      stretches: 2,
      globe_key: Some(GlobeKey::Value(2)),
    };
    assert_eq!(
      hold.to_string(),
      "window=Dictation span=DictationHold duration_ms=4210 audio_ms=4180 \
       stretches=2 globe_key=2"
    );
    let other_key = Line::Hold {
      duration: ms(900),
      audio: ms(880),
      stretches: 0,
      globe_key: None,
    };
    assert!(!other_key.to_string().contains("globe_key"));
    let unset = Line::Hold {
      duration: ms(900),
      audio: ms(880),
      stretches: 0,
      globe_key: Some(GlobeKey::Unset),
    };
    assert!(unset.to_string().ends_with(" globe_key=unset"));
  }

  #[test]
  fn a_transcription_names_where_and_how_without_any_text() {
    let line = Line::Transcribe {
      duration: ms(1_312),
      destination: Destination::Cloud,
      model: Some("scribe v2\n=1".to_string()),
      tally: Tally {
        stretches: 4,
        requests: 2,
        fell_back: false,
        speech: ms(9_400),
      },
    };
    assert_eq!(
      line.to_string(),
      "window=Dictation span=DictationTranscribe duration_ms=1312 \
       destination=StellaAi engine=StellaAi model=scribe_v2__1 stretches=4 \
       requests=2 fallback=false audio_ms=9400"
    );
    let local = Line::Transcribe {
      duration: ms(80),
      destination: Destination::Local,
      model: None,
      tally: Tally::default(),
    };
    assert!(!local.to_string().contains("model="));
  }

  #[test]
  fn cleanup_says_whether_it_ran_and_how_it_went() {
    let off = Line::Cleanup {
      duration: Duration::ZERO,
      cleanup: Cleanup::Off,
    };
    assert_eq!(
      off.to_string(),
      "window=Dictation span=DictationCleanup duration_ms=0 cleanup=off outcome=Off"
    );
    let timed_out = Line::Cleanup {
      duration: ms(5_001),
      cleanup: Cleanup::TimedOut,
    };
    assert!(
      timed_out
        .to_string()
        .ends_with("duration_ms=5001 cleanup=on outcome=TimedOut")
    );
  }

  #[test]
  fn an_untyped_dictation_names_its_failure_and_whether_history_has_it() {
    let end = Line::End {
      duration: ms(7_000),
      outcome: Outcome::Failed(Failed {
        failure: Failure::FocusChanged,
        kept_in_history: true,
      }),
      moved: Some(Moved::Window),
    };
    assert_eq!(
      end.to_string(),
      "window=Dictation span=DictationEnd duration_ms=7000 outcome=Failed \
       failure=FocusChanged kept_in_history=true focus_moved=Window"
    );
    let typed = Line::End {
      duration: ms(3_000),
      outcome: Outcome::Typed,
      moved: None,
    };
    assert!(
      typed
        .to_string()
        .ends_with("duration_ms=3000 outcome=Typed")
    );
    let insert = Line::Insert {
      duration: ms(1_020),
      focus_read: Some(ms(1_001)),
      kept_in_history: true,
    };
    assert!(
      insert
        .to_string()
        .ends_with("duration_ms=1020 focus_read_ms=1001 kept_in_history=true")
    );
  }

  #[test]
  fn model_ids_stay_one_bounded_token() {
    assert_eq!(
      model_token("eleven/scribe_v1.0:eu-1"),
      "eleven/scribe_v1.0:eu-1"
    );
    assert_eq!(model_token("a b=c"), "a_b_c");
    assert_eq!(model_token(&"x".repeat(200)).len(), MAX_MODEL_ID_CHARS);
  }
}
