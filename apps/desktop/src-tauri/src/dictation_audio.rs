//! Turns captured microphone audio into what the speech model reads: 16 kHz
//! mono samples. Pure functions, so they are tested without a microphone.

pub const MODEL_SAMPLE_RATE: u32 = 16_000;
/// Shorter holds are accidental presses.
const MIN_SPEECH_SAMPLES: usize = MODEL_SAMPLE_RATE as usize * 3 / 10;
/// Quieter audio is silence, on which speech models invent closing phrases.
const SILENCE_RMS: f32 = 0.002;
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

/// Whether 16 kHz audio is long and loud enough to be worth transcribing.
pub fn holds_speech(samples: &[f32]) -> bool {
  if samples.len() < MIN_SPEECH_SAMPLES {
    return false;
  }
  let energy = samples
    .iter()
    .map(|sample| f64::from(*sample).powi(2))
    .sum::<f64>();
  (energy / samples.len() as f64).sqrt() >= f64::from(SILENCE_RMS)
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
}
