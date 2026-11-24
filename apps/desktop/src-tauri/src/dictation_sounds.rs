//! Short, quiet sounds that tell the speaker dictation took the key: two
//! rising notes once a hold is long enough to be a dictation, two falling
//! ones once recording stops. A tap or a cancelled hold sounds nothing. The
//! notes are made here, so no sound file ships, and they play on the system
//! output on a thread of their own, so a slow device never delays recording.

use std::{thread, time::Duration};

use cpal::{
  FromSample, SampleFormat, SizedSample,
  traits::{DeviceTrait, HostTrait, StreamTrait},
};

use crate::dictation_audio::samples_in;

/// Loud enough to notice, well below speech or a notification sound.
const PEAK: f32 = 0.06;
/// Each note's length.
const NOTE_MILLIS: usize = 60;
/// The output keeps playing this long after the last note, so its buffer
/// drains before the stream closes.
const DRAIN: Duration = Duration::from_millis(80);
/// A fifth apart: the same two notes, rising or falling.
const LOW_HZ: f64 = 587.33;
const HIGH_HZ: f64 = 880.0;
/// How long a cue sounds, from the first note until its output drains.
pub const CUE_LENGTH: Duration =
  Duration::from_millis(2 * NOTE_MILLIS as u64).saturating_add(DRAIN);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cue {
  /// The hold became a dictation: listening.
  Start,
  /// Recording stopped.
  Stop,
}

/// Plays `cue` without waiting for it.
pub fn play(cue: Cue) {
  let spawned = thread::Builder::new()
    .name("dictation-sound".to_string())
    .spawn(move || {
      if let Err(error) = play_now(cue) {
        tracing::debug!(%error, "dictation sound was not played");
      }
    });
  if let Err(error) = spawned {
    tracing::debug!(%error, "dictation sound thread failed to start");
  }
}

fn play_now(cue: Cue) -> Result<(), String> {
  let device = cpal::default_host()
    .default_output_device()
    .ok_or("no output device")?;
  let config = device
    .default_output_config()
    .map_err(|error| error.to_string())?;
  let channels = usize::from(config.channels());
  let rate = config.sample_rate();
  let notes = samples(cue, rate);
  let length = Duration::from_secs_f64(notes.len() as f64 / f64::from(rate.max(1)));
  let stream_config = config.config();
  let stream = match config.sample_format() {
    SampleFormat::F32 => build::<f32>(&device, &stream_config, notes, channels),
    SampleFormat::I16 => build::<i16>(&device, &stream_config, notes, channels),
    SampleFormat::I32 => build::<i32>(&device, &stream_config, notes, channels),
    SampleFormat::U16 => build::<u16>(&device, &stream_config, notes, channels),
    _ => return Err("unsupported output format".to_string()),
  }?;
  stream.play().map_err(|error| error.to_string())?;
  thread::sleep(length + DRAIN);
  drop(stream);
  Ok(())
}

fn build<T>(
  device: &cpal::Device,
  config: &cpal::StreamConfig,
  notes: Vec<f32>,
  channels: usize,
) -> Result<cpal::Stream, String>
where
  T: SizedSample + FromSample<f32>,
{
  let mut next = notes.into_iter();
  device
    .build_output_stream(
      *config,
      move |data: &mut [T], _info: &cpal::OutputCallbackInfo| {
        for frame in data.chunks_mut(channels.max(1)) {
          let value = T::from_sample(next.next().unwrap_or(0.0));
          frame.fill(value);
        }
      },
      |error| tracing::debug!(%error, "dictation sound stream failed"),
      None,
    )
    .map_err(|error| error.to_string())
}

/// The cue's two notes at `rate`, each rising from and falling back to
/// silence, so neither clicks.
pub fn samples(cue: Cue, rate: u32) -> Vec<f32> {
  let (first, second) = match cue {
    Cue::Start => (LOW_HZ, HIGH_HZ),
    Cue::Stop => (HIGH_HZ, LOW_HZ),
  };
  let length = samples_in(NOTE_MILLIS, rate);
  [first, second]
    .into_iter()
    .flat_map(|frequency| note(frequency, length, rate))
    .collect()
}

fn note(frequency: f64, length: usize, rate: u32) -> impl Iterator<Item = f32> {
  let rate = f64::from(rate.max(1));
  (0..length).map(move |index| {
    let progress = index as f64 / length as f64;
    let envelope = (std::f64::consts::PI * progress).sin();
    let phase = std::f64::consts::TAU * frequency * index as f64 / rate;
    (f64::from(PEAK) * envelope * phase.sin()) as f32
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  const RATE: u32 = 48_000;

  #[test]
  fn each_cue_is_two_short_notes() {
    let start = samples(Cue::Start, RATE);
    assert_eq!(start.len(), samples_in(NOTE_MILLIS, RATE) * 2);
    assert_eq!(samples(Cue::Stop, RATE).len(), start.len());
  }

  #[test]
  fn a_cue_stays_quiet_and_begins_and_ends_in_silence() {
    for cue in [Cue::Start, Cue::Stop] {
      let notes = samples(cue, RATE);
      assert!(notes.iter().all(|sample| sample.abs() <= PEAK));
      assert!(notes[0].abs() < 1e-6);
      assert!(notes[notes.len() - 1].abs() < 0.01);
    }
  }

  #[test]
  fn start_rises_and_stop_falls() {
    let crossings = |notes: &[f32]| {
      notes
        .windows(2)
        .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
        .count()
    };
    let start = samples(Cue::Start, RATE);
    let (low, high) = start.split_at(start.len() / 2);
    assert!(crossings(low) < crossings(high));
    let stop = samples(Cue::Stop, RATE);
    let (high, low) = stop.split_at(stop.len() / 2);
    assert!(crossings(high) > crossings(low));
  }
}
