//! Cuts a recording into pieces short enough for one transcription, the way
//! the phone app cuts a long dictation: a piece ends at the first pause once
//! it is long enough to be worth its own request, or, where the speaker
//! never pauses, just before the transcription's limit at the quietest
//! moment of its last seconds. A cut falls in the middle of the pause, so
//! neither side loses the end or the start of a word.

/// When a piece ends. The defaults are the phone app's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PieceRules {
  /// No cut before this: shorter pieces only add requests.
  pub minimum_ms: u32,
  /// Cut by then whatever is said, a margin under the API's minute.
  pub maximum_ms: u32,
  /// Quieter than this, in dBFS over one frame, is a pause.
  pub silence_db: f32,
  /// A pause this long is between words, not inside one.
  pub pause_ms: u32,
}

impl Default for PieceRules {
  fn default() -> Self {
    Self {
      minimum_ms: 15_000,
      maximum_ms: 55_000,
      silence_db: -45.0,
      pause_ms: 600,
    }
  }
}

/// Loudness is judged over frames this long.
const FRAME_MS: u32 = 20;
/// Where no pause comes, the cut is looked for in the last seconds before
/// the maximum, over stretches this long.
const FORCED_SEARCH_MS: u32 = 5_000;
const FORCED_WINDOW_MS: u32 = 200;
/// Shorter, or this quiet throughout, a piece holds no speech worth a
/// request: speech models invent closing phrases on silence.
const MIN_SPEECH_MS: u32 = 300;

/// One piece of a recording, at the rate the samples were pushed at.
#[derive(Debug, Clone, PartialEq)]
pub struct Piece {
  /// Zero-based, in the order spoken.
  pub index: usize,
  /// Where the piece starts in the recording, in samples.
  pub start: u64,
  pub samples: Vec<f32>,
  /// How long the piece is quiet at its start and its end: the pause
  /// between two pieces is the first one's end plus the second one's start.
  pub leading_quiet_ms: u32,
  pub trailing_quiet_ms: u32,
  /// Whether anything in the piece is loud enough to be speech.
  pub speech: bool,
}

/// Takes a recording's samples as they are decoded and hands out each piece
/// once it is cut. Holds only the piece being cut.
pub struct Pieces {
  rate: u32,
  rules: PieceRules,
  frame: usize,
  /// Samples of the piece being cut, from `start`.
  buffer: Vec<f32>,
  start: u64,
  index: usize,
  /// Frames of `buffer` already judged.
  judged: usize,
  /// The sample where the current quiet run began, if it is quiet now.
  quiet_since: Option<usize>,
}

impl Pieces {
  pub fn new(rate: u32, rules: PieceRules) -> Self {
    let frame = samples_in(FRAME_MS, rate).max(1);
    Self {
      rate,
      rules,
      frame,
      buffer: Vec::new(),
      start: 0,
      index: 0,
      judged: 0,
      quiet_since: None,
    }
  }

  /// Adds decoded samples; returns the pieces they complete, in order.
  pub fn push(&mut self, samples: &[f32]) -> Vec<Piece> {
    self.buffer.extend_from_slice(samples);
    let minimum = samples_in(self.rules.minimum_ms, self.rate);
    let maximum = samples_in(self.rules.maximum_ms, self.rate).max(self.frame);
    let pause = samples_in(self.rules.pause_ms, self.rate);
    let mut cut = Vec::new();
    while (self.judged + 1) * self.frame <= self.buffer.len() {
      let frame_start = self.judged * self.frame;
      let frame_end = frame_start + self.frame;
      self.judged += 1;
      if is_quiet(&self.buffer[frame_start..frame_end], self.rules.silence_db) {
        let since = *self.quiet_since.get_or_insert(frame_start);
        if frame_end - since >= pause && frame_end >= minimum {
          // The middle of the pause, but never before the minimum: a quiet
          // stretch that began earlier still leaves a piece worth sending.
          let middle = since + (frame_end - since) / 2;
          cut.push(self.cut_at(middle.max(minimum.min(frame_end))));
          continue;
        }
      } else {
        self.quiet_since = None;
      }
      if frame_end >= maximum {
        let window = samples_in(FORCED_WINDOW_MS, self.rate);
        let search = samples_in(FORCED_SEARCH_MS, self.rate).min(frame_end / 2);
        let at = quietest(&self.buffer[..frame_end], frame_end - search, window);
        cut.push(self.cut_at(at));
      }
    }
    cut
  }

  /// The rest of the recording, once decoding ends; none when nothing is
  /// left.
  pub fn finish(mut self) -> Option<Piece> {
    if self.buffer.is_empty() {
      return None;
    }
    let length = self.buffer.len();
    Some(self.cut_at(length))
  }

  /// Hands out `buffer[..at]` as the next piece and keeps the rest, whose
  /// frames are judged again from its own start.
  fn cut_at(&mut self, at: usize) -> Piece {
    let at = at.clamp(1, self.buffer.len());
    let rest = self.buffer.split_off(at);
    let samples = std::mem::replace(&mut self.buffer, rest);
    let piece = self.piece(samples);
    self.start += at as u64;
    self.index += 1;
    self.judged = 0;
    self.quiet_since = None;
    piece
  }

  fn piece(&self, samples: Vec<f32>) -> Piece {
    let frames = samples.chunks(self.frame).collect::<Vec<_>>();
    let silence_db = self.rules.silence_db;
    let leading = frames
      .iter()
      .take_while(|frame| is_quiet(frame, silence_db))
      .count();
    let trailing = frames
      .iter()
      .rev()
      .take_while(|frame| is_quiet(frame, silence_db))
      .count();
    let frame_ms = |count: usize| {
      u32::try_from(count)
        .unwrap_or(u32::MAX)
        .saturating_mul(FRAME_MS)
    };
    let speech =
      leading < frames.len() && samples.len() >= samples_in(MIN_SPEECH_MS, self.rate);
    Piece {
      index: self.index,
      start: self.start,
      leading_quiet_ms: frame_ms(leading),
      trailing_quiet_ms: frame_ms(trailing),
      speech,
      samples,
    }
  }
}

/// Samples in `millis` milliseconds at `rate`.
const fn samples_in(millis: u32, rate: u32) -> usize {
  (millis as u64 * rate as u64 / 1_000) as usize
}

fn is_quiet(frame: &[f32], silence_db: f32) -> bool {
  if frame.is_empty() {
    return true;
  }
  let energy =
    frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32;
  // 20·log10(rms) = 10·log10(mean square); silence below the float floor
  // is quiet too.
  energy <= f32::MIN_POSITIVE || 10.0 * energy.log10() < silence_db
}

/// The middle of the quietest `window`-long stretch of `samples` at or after
/// `from`.
fn quietest(samples: &[f32], from: usize, window: usize) -> usize {
  let from = from.min(samples.len());
  if window == 0 || samples.len() - from <= window {
    return from + (samples.len() - from) / 2;
  }
  let hop = (window / 4).max(1);
  let energy = |start: usize| {
    samples[start..start + window]
      .iter()
      .map(|sample| sample * sample)
      .sum::<f32>()
  };
  let start = (from..=samples.len() - window)
    .step_by(hop)
    .min_by(|left, right| energy(*left).total_cmp(&energy(*right)))
    .unwrap_or(from);
  start + window / 2
}

#[cfg(test)]
mod tests {
  use super::*;

  const RATE: u32 = 16_000;

  fn seconds(value: f64) -> usize {
    (value * f64::from(RATE)) as usize
  }

  /// Speech-loud tone with silent `(start, length)` stretches.
  fn speech(total: usize, pauses: &[(usize, usize)]) -> Vec<f32> {
    (0..total)
      .map(|index| {
        if pauses
          .iter()
          .any(|(start, length)| (*start..start + length).contains(&index))
        {
          0.0
        } else {
          0.3 * ((index as f32) * 0.05).sin()
        }
      })
      .collect()
  }

  /// Pushes in decoder-sized blocks and finishes.
  fn cut(audio: &[f32]) -> Vec<Piece> {
    let mut pieces = Pieces::new(RATE, PieceRules::default());
    let mut out = Vec::new();
    for block in audio.chunks(4_096) {
      out.extend(pieces.push(block));
    }
    out.extend(pieces.finish());
    out
  }

  fn assert_whole(pieces: &[Piece], total: usize) {
    let mut next = 0_u64;
    for (index, piece) in pieces.iter().enumerate() {
      assert_eq!(piece.index, index);
      assert_eq!(
        piece.start, next,
        "piece {index} starts where the last ended"
      );
      next += piece.samples.len() as u64;
    }
    assert_eq!(next, total as u64, "no sample is lost or repeated");
  }

  #[test]
  fn a_short_recording_is_one_piece() {
    let audio = speech(seconds(12.0), &[(seconds(5.0), seconds(1.0))]);
    let pieces = cut(&audio);
    assert_eq!(pieces.len(), 1);
    assert!(pieces[0].speech);
    assert_whole(&pieces, audio.len());
  }

  #[test]
  fn a_pause_before_the_minimum_is_not_a_cut() {
    let audio = speech(
      seconds(30.0),
      &[(seconds(10.0), seconds(1.0)), (seconds(20.0), seconds(1.0))],
    );
    let pieces = cut(&audio);
    assert_eq!(pieces.len(), 2);
    // The cut falls inside the pause after the minimum, not the one before.
    let end = pieces[0].samples.len();
    assert!(
      (seconds(20.0)..seconds(21.0)).contains(&end),
      "cut at {end}"
    );
    assert!(
      pieces[0].trailing_quiet_ms >= 280,
      "{}",
      pieces[0].trailing_quiet_ms
    );
    assert!(
      pieces[1].leading_quiet_ms >= 280,
      "{}",
      pieces[1].leading_quiet_ms
    );
    assert_whole(&pieces, audio.len());
  }

  #[test]
  fn a_pause_shorter_than_the_rule_is_inside_a_sentence() {
    let audio = speech(seconds(40.0), &[(seconds(18.0), seconds(0.4))]);
    let pieces = cut(&audio);
    assert_eq!(pieces.len(), 1, "a 400 ms gap never cuts");
  }

  #[test]
  fn speech_without_pauses_is_cut_before_the_limit_at_its_quietest() {
    // A dip in level, not silence, 3 s before the maximum.
    let mut audio = speech(seconds(130.0), &[]);
    for sample in &mut audio[seconds(52.0)..seconds(52.3)] {
      *sample *= 0.05;
    }
    let pieces = cut(&audio);
    assert!(pieces.len() >= 3);
    for piece in &pieces {
      assert!(
        piece.samples.len() <= seconds(55.0),
        "piece {}",
        piece.index
      );
    }
    let end = pieces[0].samples.len();
    assert!(
      (seconds(52.0)..seconds(52.3)).contains(&end),
      "cut at {end}"
    );
    assert_whole(&pieces, audio.len());
  }

  #[test]
  fn silence_is_not_speech() {
    let audio = vec![0.0; seconds(70.0)];
    let pieces = cut(&audio);
    assert!(pieces.iter().all(|piece| !piece.speech));
    assert!(
      pieces
        .iter()
        .all(|piece| piece.samples.len() <= seconds(55.0))
    );
    assert_whole(&pieces, audio.len());
    assert!(cut(&[]).is_empty());
  }

  #[test]
  fn twenty_minutes_with_a_pause_every_twenty_seconds_cut_at_each() {
    let every = seconds(20.0);
    let audio = (0..seconds(1_200.0))
      .map(|index| {
        if index >= every && index % every < seconds(0.8) {
          0.0
        } else {
          0.3 * ((index as f32) * 0.05).sin()
        }
      })
      .collect::<Vec<_>>();
    let pieces = cut(&audio);
    assert_eq!(pieces.len(), 60);
    for piece in &pieces[..59] {
      let length = piece.samples.len();
      assert!((seconds(19.0)..seconds(21.0)).contains(&length), "{length}");
    }
    assert_whole(&pieces, audio.len());
  }

  #[test]
  fn long_silence_is_cut_at_the_minimum_not_before() {
    let pieces = cut(&vec![0.0; seconds(40.0)]);
    assert_eq!(pieces[0].samples.len(), seconds(15.0));
    assert_eq!(pieces[0].leading_quiet_ms, 15_000);
  }

  #[test]
  fn the_quiet_level_follows_the_rule() {
    // -40 dBFS is speech to the rule, -50 dBFS a pause.
    let level = |db: f32| 10_f32.powf(db / 20.0) * std::f32::consts::SQRT_2;
    let tone = |amplitude: f32| {
      (0..320)
        .map(|index| amplitude * (index as f32 * 0.3).sin())
        .collect::<Vec<_>>()
    };
    assert!(!is_quiet(&tone(level(-40.0)), -45.0));
    assert!(is_quiet(&tone(level(-50.0)), -45.0));
    assert!(is_quiet(&[0.0; 320], -45.0));
  }
}
