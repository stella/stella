//! Turns captured microphone audio into what the speech model reads: 16 kHz
//! mono samples. Pure functions, so they are tested without a microphone.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine capture audio")
)]

pub const MODEL_SAMPLE_RATE: u32 = 16_000;
/// Shorter holds are accidental presses.
const MIN_SPEECH_SAMPLES: usize = MODEL_SAMPLE_RATE as usize * 3 / 10;
/// A window at least this loud is speech on any microphone. Quieter audio is
/// silence, on which speech models invent closing phrases, unless it stands
/// clearly above the noise of a quiet microphone.
const SPEECH_DBFS: f32 = -54.0;
/// On a quiet microphone, windows this far above its noise floor are speech.
const ABOVE_FLOOR_DB: f32 = 12.0;
/// Even above a very low noise floor, quieter windows are never speech.
const LOWEST_SPEECH_DBFS: f32 = -66.0;
/// Speech above the noise floor lasts this long; a click or a breath does not.
const SUSTAINED_MILLIS: usize = 180;
/// Sound at the speech level counts once it lasts this long; a click does not.
const LOUD_SUSTAINED_MILLIS: usize = 90;
/// While a recording goes on, its noise floor follows louder frames this
/// slowly, in dB per frame, and quieter ones at once.
const FLOOR_RISE_DB: f32 = 0.02;
/// Loudness is judged over windows this long when deciding on speech.
const WINDOW_MILLIS: usize = 30;
/// The noise floor is the level this fraction of windows stays under.
const FLOOR_QUANTILE: f64 = 0.2;
/// The noise floor needs at least this many windows to be measured.
const FLOOR_WINDOWS: usize = 5;
/// Exact digital silence reads as this level.
const SILENT_DBFS: f32 = -120.0;
/// Loudness is judged over frames this long while recording.
pub const FRAME_MILLIS: usize = 20;
/// This much silence after speech ends a stretch, which is then transcribed
/// while the speaker goes on.
pub const PAUSE_MILLIS: usize = 500;
/// A stretch shorter than this waits for the next pause, so the model never
/// gets a lone word without its sentence.
pub const MIN_STRETCH_MILLIS: usize = 1_000;
/// Silence kept before speech; longer silence is dropped as it arrives.
pub const LEAD_MILLIS: usize = PAUSE_MILLIS / 2;
// Whole frames make up a pause, and a stretch outlasts the pause ending it.
const _: () = assert!(
  PAUSE_MILLIS.is_multiple_of(FRAME_MILLIS) && MIN_STRETCH_MILLIS > PAUSE_MILLIS
);
/// Filter half-width in input samples at the lowered cutoff.
const SINC_ZERO_CROSSINGS: f64 = 16.0;

/// Averages interleaved frames into one channel.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
  if channels <= 1 {
    return interleaved.to_vec();
  }
  interleaved
    .chunks_exact(channels)
    .map(|frame| frame.iter().sum::<f32>() / channels as f32)
    .collect()
}

/// Windowed-sinc resampling. Lowering the rate lowers the cutoff with it, so
/// frequencies the target rate cannot represent do not alias into speech.
pub fn resample(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
  if from_rate == to_rate || input.is_empty() {
    return input.to_vec();
  }
  let ratio = f64::from(to_rate) / f64::from(from_rate);
  let cutoff = ratio.min(1.0);
  let half_width = SINC_ZERO_CROSSINGS / cutoff;
  let output_len = (input.len() as f64 * ratio).round() as usize;
  (0..output_len)
    .map(|index| {
      let position = index as f64 / ratio;
      let first = (position - half_width).ceil().max(0.0) as usize;
      let last = ((position + half_width).floor() as usize).min(input.len() - 1);
      let mut sum = 0.0;
      let mut weights = 0.0;
      for (offset, sample) in input[first..=last].iter().enumerate() {
        let distance = (first + offset) as f64 - position;
        let weight = sinc(distance * cutoff) * hann(distance / half_width);
        sum += f64::from(*sample) * weight;
        weights += weight;
      }
      if weights.abs() < f64::EPSILON {
        0.0
      } else {
        (sum / weights) as f32
      }
    })
    .collect()
}

/// Samples in `millis` milliseconds at `rate`.
pub const fn samples_in(millis: usize, rate: u32) -> usize {
  millis * rate as usize / 1_000
}

fn sinc(x: f64) -> f64 {
  if x.abs() < 1e-9 {
    1.0
  } else {
    let phase = std::f64::consts::PI * x;
    phase.sin() / phase
  }
}

/// `position` runs from -1 to 1 across the window.
fn hann(position: f64) -> f64 {
  0.5 * (1.0 + (std::f64::consts::PI * position).cos())
}

/// Level of a window in dBFS once its steady offset is removed: some built-in
/// microphones deliver a constant offset that is not sound.
fn level_dbfs(window: &[f32]) -> f32 {
  if window.is_empty() {
    return SILENT_DBFS;
  }
  let count = window.len() as f64;
  let offset = window.iter().map(|sample| f64::from(*sample)).sum::<f64>() / count;
  let energy = window
    .iter()
    .map(|sample| (f64::from(*sample) - offset).powi(2))
    .sum::<f64>();
  let rms = (energy / count).sqrt();
  if rms <= 0.0 {
    return SILENT_DBFS;
  }
  ((20.0 * rms.log10()) as f32).max(SILENT_DBFS)
}

/// The level a window must reach to count as sound: the speech level, or on
/// a quiet microphone a level clearly above its noise floor.
fn threshold(floor: Option<f32>) -> f32 {
  floor.map_or(SPEECH_DBFS, |floor| {
    (floor + ABOVE_FLOOR_DB).clamp(LOWEST_SPEECH_DBFS, SPEECH_DBFS)
  })
}

/// Judges frames one by one as a recording arrives, at any rate: a frame is
/// sound when it reaches the speech level or, on a quiet microphone, stands
/// clearly above the noise heard so far. Nothing is quiet.
#[derive(Debug, Default)]
pub struct FrameGate {
  floor: Option<f32>,
}

impl FrameGate {
  pub fn quiet(&mut self, frame: &[f32]) -> bool {
    let level = level_dbfs(frame);
    let quiet = level < threshold(self.floor);
    // Exact digital silence says nothing about the room.
    if level > SILENT_DBFS {
      self.floor = Some(match self.floor {
        Some(floor) if floor < level => (floor + FLOOR_RISE_DB).min(level),
        _ => level,
      });
    }
    quiet
  }
}

/// The level most windows of background stay under, from the quieter windows.
/// Exact digital silence says nothing about the room and is left out.
fn noise_floor(levels: &[f32]) -> Option<f32> {
  let mut heard = levels
    .iter()
    .copied()
    .filter(|level| *level > SILENT_DBFS)
    .collect::<Vec<_>>();
  if heard.len() < FLOOR_WINDOWS {
    return None;
  }
  heard.sort_by(f32::total_cmp);
  let index = ((heard.len() - 1) as f64 * FLOOR_QUANTILE).round() as usize;
  Some(heard[index])
}

/// Whether 16 kHz audio holds speech: a short run of windows at the speech
/// level, or, on a quiet microphone, a longer run clearly above its noise.
fn heard(samples: &[f32]) -> bool {
  let window = samples_in(WINDOW_MILLIS, MODEL_SAMPLE_RATE);
  let levels = samples
    .chunks_exact(window)
    .map(level_dbfs)
    .collect::<Vec<_>>();
  let lasts = |threshold: f32, millis: usize| {
    let needed = millis.div_ceil(WINDOW_MILLIS);
    let mut run = 0;
    levels.iter().any(|level| {
      run = if *level >= threshold { run + 1 } else { 0 };
      run >= needed
    })
  };
  lasts(SPEECH_DBFS, LOUD_SUSTAINED_MILLIS)
    || noise_floor(&levels)
      .is_some_and(|floor| lasts(threshold(Some(floor)), SUSTAINED_MILLIS))
}

/// Whether 16 kHz audio is long and loud enough to be worth transcribing.
pub fn holds_speech(samples: &[f32]) -> bool {
  samples.len() >= MIN_SPEECH_SAMPLES && heard(samples)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sine(frequency: f64, rate: u32, seconds: f64) -> Vec<f32> {
    let count = (f64::from(rate) * seconds) as usize;
    (0..count)
      .map(|index| {
        let time = index as f64 / f64::from(rate);
        (0.5 * (std::f64::consts::TAU * frequency * time).sin()) as f32
      })
      .collect()
  }

  fn rms(samples: &[f32]) -> f64 {
    let middle = &samples[samples.len() / 4..samples.len() * 3 / 4];
    let energy = middle.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>();
    (energy / middle.len() as f64).sqrt()
  }

  #[test]
  fn mono_averages_each_frame() {
    assert_eq!(to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
  }

  #[test]
  fn mono_passes_one_channel_through() {
    assert_eq!(to_mono(&[0.25, 0.75], 1), vec![0.25, 0.75]);
  }

  #[test]
  fn mono_ignores_a_torn_trailing_frame() {
    assert_eq!(to_mono(&[1.0, 1.0, 1.0], 2), vec![1.0]);
  }

  #[test]
  fn resampling_keeps_the_duration() {
    let output = resample(&vec![0.0; 48_000], 48_000, 16_000);

    assert_eq!(output.len(), 16_000);
  }

  #[test]
  fn resampling_keeps_speech_band_energy() {
    let input = sine(440.0, 48_000, 0.5);

    let output = resample(&input, 48_000, 16_000);

    assert!((rms(&output) - rms(&input)).abs() < 0.01);
  }

  #[test]
  fn resampling_rejects_what_the_target_rate_cannot_hold() {
    let input = sine(12_000.0, 48_000, 0.5);

    let output = resample(&input, 48_000, 16_000);

    assert!(rms(&output) < 0.01, "aliased energy: {}", rms(&output));
  }

  #[test]
  fn resampling_raises_a_low_rate() {
    let output = resample(&sine(440.0, 8_000, 0.5), 8_000, 16_000);

    assert_eq!(output.len(), 8_000);
  }

  #[test]
  fn resampling_the_same_rate_changes_nothing() {
    assert_eq!(resample(&[0.1, 0.2], 16_000, 16_000), vec![0.1, 0.2]);
  }

  #[test]
  fn resampling_nothing_gives_nothing() {
    assert!(resample(&[], 48_000, 16_000).is_empty());
  }

  #[test]
  fn a_brief_press_is_not_speech() {
    assert!(!holds_speech(&sine(440.0, MODEL_SAMPLE_RATE, 0.1)));
  }

  #[test]
  fn silence_is_not_speech() {
    assert!(!holds_speech(&vec![0.0; MODEL_SAMPLE_RATE as usize]));
  }

  #[test]
  fn audible_audio_is_speech() {
    assert!(holds_speech(&sine(440.0, MODEL_SAMPLE_RATE, 1.0)));
  }

  /// A tone whose level is `dbfs`, riding on a constant `offset`.
  fn tone_at(dbfs: f32, offset: f32, seconds: f64) -> Vec<f32> {
    let peak = 10f64.powf(f64::from(dbfs) / 20.0) * std::f64::consts::SQRT_2;
    sine(220.0, MODEL_SAMPLE_RATE, seconds)
      .into_iter()
      .map(|sample| (f64::from(sample) * 2.0 * peak) as f32 + offset)
      .collect()
  }

  /// Steady noise at about `dbfs`, the same on every run.
  fn noise_at(dbfs: f32, seconds: f64) -> Vec<f32> {
    let amplitude = 10f64.powf(f64::from(dbfs) / 20.0) * 3f64.sqrt();
    let count = (f64::from(MODEL_SAMPLE_RATE) * seconds) as usize;
    let mut state = 0x2545_f491_u32;
    (0..count)
      .map(|_| {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let unit = f64::from(state) / f64::from(u32::MAX) * 2.0 - 1.0;
        (unit * amplitude) as f32
      })
      .collect()
  }

  fn mix(base: &mut [f32], from: usize, added: &[f32]) {
    for (sample, extra) in base[from..].iter_mut().zip(added) {
      *sample += extra;
    }
  }

  fn quiet(frame: &[f32]) -> bool {
    FrameGate::default().quiet(frame)
  }

  #[test]
  fn quiet_is_the_same_level_speech_is_measured_against() {
    assert!(quiet(&tone_at(SPEECH_DBFS - 1.0, 0.0, 1.0)));
    assert!(!quiet(&tone_at(SPEECH_DBFS + 1.0, 0.0, 1.0)));
    assert!(!holds_speech(&tone_at(SPEECH_DBFS - 1.0, 0.0, 1.0)));
    assert!(holds_speech(&tone_at(SPEECH_DBFS + 1.0, 0.0, 1.0)));
    assert!(quiet(&[]));
  }

  #[test]
  fn a_steady_offset_is_not_sound() {
    assert!(quiet(&vec![0.05; 320]));
    assert!(!holds_speech(&vec![0.05; MODEL_SAMPLE_RATE as usize]));
  }

  #[test]
  fn speech_on_a_steady_offset_is_heard() {
    assert!(holds_speech(&tone_at(SPEECH_DBFS + 3.0, 0.05, 1.0)));
  }

  #[test]
  fn quiet_speech_above_a_quiet_room_is_heard() {
    let mut audio = noise_at(-78.0, 2.0);
    mix(&mut audio, 8_000, &tone_at(-60.0, 0.0, 0.5));

    assert!(holds_speech(&audio));
  }

  #[test]
  fn quiet_speech_needs_to_last() {
    let mut audio = noise_at(-78.0, 2.0);
    mix(&mut audio, 8_000, &tone_at(-60.0, 0.0, 0.06));

    assert!(!holds_speech(&audio));
  }

  #[test]
  fn sound_close_to_the_room_noise_is_not_speech() {
    let mut audio = noise_at(-64.0, 2.0);
    mix(&mut audio, 8_000, &tone_at(-60.0, 0.0, 0.5));

    assert!(!holds_speech(&audio));
  }

  #[test]
  fn a_click_is_not_speech() {
    let mut audio = vec![0.0; MODEL_SAMPLE_RATE as usize];
    mix(&mut audio, 8_000, &tone_at(-40.0, 0.0, 0.03));

    assert!(!holds_speech(&audio));
  }

  #[test]
  fn frames_of_quiet_speech_stand_out_from_the_noise_heard_before() {
    let frame = samples_in(20, MODEL_SAMPLE_RATE);
    let mut gate = FrameGate::default();
    let mut noise = noise_at(-78.0, 1.0);
    for sample in &mut noise {
      *sample += 0.05;
    }
    assert!(noise.chunks_exact(frame).all(|part| gate.quiet(part)));
    let speech = tone_at(-60.0, 0.05, 1.0);

    assert!(speech.chunks_exact(frame).all(|part| !gate.quiet(part)));
    // Without the noise before it, the same speech is below the speech level.
    assert!(quiet(&speech[..frame]));
  }

  #[test]
  fn room_noise_alone_is_not_speech() {
    assert!(!holds_speech(&noise_at(-60.0, 2.0)));
  }

  #[test]
  fn sound_below_the_lowest_speech_level_is_not_speech() {
    let mut audio = vec![0.0; MODEL_SAMPLE_RATE as usize * 2];
    mix(&mut audio, 8_000, &noise_at(-100.0, 1.9));
    mix(
      &mut audio,
      16_000,
      &tone_at(LOWEST_SPEECH_DBFS - 2.0, 0.0, 0.5),
    );

    assert!(!holds_speech(&audio));
  }
}
