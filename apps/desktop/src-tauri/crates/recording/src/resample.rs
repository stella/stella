//! Windowed-sinc resampling with a precomputed kernel table, fast enough for
//! hours of audio: each output sample is one short dot product. Lowering the
//! rate lowers the cutoff with it, so frequencies the target rate cannot
//! hold do not alias into speech.

/// Filter half-width in input samples at the lowered cutoff.
const ZERO_CROSSINGS: f64 = 16.0;
/// Fractional positions the kernel is tabulated at. Positions in between use
/// the nearest; the error is far below what speech recognition hears.
const PHASES: usize = 256;

/// `input` at `from_rate`, as samples at `to_rate`.
pub fn resample(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
  if from_rate == to_rate || input.is_empty() || from_rate == 0 || to_rate == 0 {
    return input.to_vec();
  }
  let ratio = f64::from(to_rate) / f64::from(from_rate);
  let cutoff = ratio.min(1.0);
  let half_width = ZERO_CROSSINGS / cutoff;
  // Taps reach `reach` samples either side of the position's floor.
  let reach = half_width.ceil() as usize;
  let taps = 2 * reach;
  let table = kernel_table(cutoff, half_width, reach);
  let output_len = (input.len() as f64 * ratio).round() as usize;
  let step = f64::from(from_rate) / f64::from(to_rate);
  let last = input.len() - 1;
  (0..output_len)
    .map(|index| {
      let position = index as f64 * step;
      let floor = position.floor();
      let phase = ((position - floor) * PHASES as f64).round() as usize;
      let (base, phase) = if phase == PHASES {
        (floor as usize + 1, 0)
      } else {
        (floor as usize, phase)
      };
      let weights = &table[phase * taps..(phase + 1) * taps];
      // Tap `k` reads input `base + k + 1 - reach`; edges repeat the end
      // samples, which a piece's quiet edges make harmless.
      let mut sum = 0.0_f32;
      for (tap, weight) in weights.iter().enumerate() {
        let source = (base + tap + 1).saturating_sub(reach).min(last);
        sum += input[source] * weight;
      }
      sum
    })
    .collect()
}

/// One normalized kernel per phase, `2 * reach` taps each.
fn kernel_table(cutoff: f64, half_width: f64, reach: usize) -> Vec<f32> {
  let taps = 2 * reach;
  let mut table = Vec::with_capacity((PHASES + 1) * taps);
  for phase in 0..=PHASES {
    let fraction = phase as f64 / PHASES as f64;
    let weights = (0..taps)
      .map(|tap| {
        // The tap's input sample minus the output position.
        let distance = tap as f64 + 1.0 - reach as f64 - fraction;
        if distance.abs() >= half_width {
          0.0
        } else {
          sinc(distance * cutoff) * hann(distance / half_width)
        }
      })
      .collect::<Vec<_>>();
    let total = weights.iter().sum::<f64>();
    table.extend(weights.iter().map(|weight| {
      if total.abs() < f64::EPSILON {
        0.0
      } else {
        (weight / total) as f32
      }
    }));
  }
  table
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
    (samples.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / samples.len() as f64)
      .sqrt()
  }

  #[test]
  fn the_same_rate_is_returned_unchanged() {
    let input = sine(440.0, 16_000, 0.1);
    assert_eq!(resample(&input, 16_000, 16_000), input);
    assert!(resample(&[], 44_100, 16_000).is_empty());
  }

  #[test]
  fn speech_frequencies_survive_common_rates() {
    for from in [8_000, 11_025, 22_050, 44_100, 48_000, 96_000] {
      let input = sine(1_000.0, from, 1.0);
      let output = resample(&input, from, 16_000);
      assert_eq!(output.len(), 16_000, "from {from}");
      // Away from the edges, a 1 kHz tone keeps its level.
      let middle = &output[2_000..14_000];
      let expected = 0.5 / std::f64::consts::SQRT_2;
      assert!(
        (rms(middle) - expected).abs() < 0.01,
        "from {from}: {}",
        rms(middle)
      );
      // And its shape: compare with the tone generated at 16 kHz.
      let reference = sine(1_000.0, 16_000, 1.0);
      let error = middle
        .iter()
        .zip(&reference[2_000..14_000])
        .map(|(left, right)| f64::from(left - right).abs())
        .fold(0.0, f64::max);
      assert!(error < 0.02, "from {from}: error {error}");
    }
  }

  #[test]
  fn frequencies_above_the_new_limit_do_not_alias_into_speech() {
    // 12 kHz cannot exist at 16 kHz; without filtering it folds to 4 kHz.
    let input = sine(12_000.0, 48_000, 1.0);
    let output = resample(&input, 48_000, 16_000);
    assert!(rms(&output[1_000..15_000]) < 0.01, "{}", rms(&output));
  }
}
