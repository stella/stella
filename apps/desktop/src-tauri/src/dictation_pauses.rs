//! Cuts a recording into stretches of speech while it is still going on, so
//! each stretch can be transcribed as soon as the speaker pauses. A pause is
//! [`PAUSE_MILLIS`] of frames below the silence level that already decides
//! whether audio holds speech; a stretch is cut in the middle of its pause.
//! A stretch that grows to the length of one stella AI chunk is cut at its
//! quietest moment, the same cut an upload makes.
//!
//! Every decision is taken frame by frame on the audio alone, so where the
//! cuts fall never depends on how the microphone delivers its samples. Pure:
//! tested on synthetic audio, without a microphone or a clock.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine record")
)]

use crate::{
  dictation_audio::{
    FRAME_MILLIS, LEAD_MILLIS, MIN_STRETCH_MILLIS, PAUSE_MILLIS, quiet, samples_in,
  },
  dictation_cloud,
};

/// Splits mono audio at one sample rate into stretches as it arrives. Holds
/// only the audio since the last cut.
pub struct Segmenter {
  rate: u32,
  frame: usize,
  pause: usize,
  lead: usize,
  min_stretch: usize,
  /// Audio since the last cut, not yet handed out.
  pending: Vec<f32>,
  /// How much of `pending` has been judged frame by frame.
  judged: usize,
  /// Whether `pending` holds a loud frame.
  heard: bool,
  /// Where in `pending` the quiet run after the last loud frame began.
  quiet_since: Option<usize>,
  /// Whether any sample at all was not exactly zero.
  signal: bool,
}

/// What is left once recording stops.
pub struct Rest {
  /// The audio after the last cut.
  pub samples: Vec<f32>,
  /// Whether the microphone delivered anything but exact zeros, which a
  /// denied microphone delivers instead of an error.
  pub signal: bool,
}

impl Segmenter {
  pub fn new(rate: u32) -> Self {
    Self {
      rate,
      frame: samples_in(FRAME_MILLIS, rate).max(1),
      pause: samples_in(PAUSE_MILLIS, rate),
      lead: samples_in(LEAD_MILLIS, rate),
      min_stretch: samples_in(MIN_STRETCH_MILLIS, rate),
      pending: Vec::new(),
      judged: 0,
      heard: false,
      quiet_since: None,
      signal: false,
    }
  }

  /// Adds captured audio and returns every stretch it completes, in order.
  pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
    self.signal |= samples.iter().any(|sample| *sample != 0.0);
    self.pending.extend_from_slice(samples);
    let mut stretches = Vec::new();
    while self.judged + self.frame <= self.pending.len() {
      let start = self.judged;
      self.judged += self.frame;
      if quiet(&self.pending[start..self.judged]) {
        self.on_quiet(start, &mut stretches);
      } else {
        self.on_loud(start);
      }
      if let Some(cut) =
        dictation_cloud::cap_cut(&self.pending[..self.judged], self.rate)
      {
        stretches.push(self.cut(cut));
        // The cut falls inside speech, so what follows it is speech too.
        self.heard = true;
      }
    }
    stretches
  }

  fn on_loud(&mut self, start: usize) {
    if !self.heard {
      // Speech starts: only a short lead of the silence before it stays.
      self.drop_front(start.saturating_sub(self.lead));
    }
    self.heard = true;
    self.quiet_since = None;
  }

  fn on_quiet(&mut self, start: usize, stretches: &mut Vec<Vec<f32>>) {
    if !self.heard {
      // Silence before any speech is dropped in whole seconds as it
      // arrives, so a silent hold never piles up audio.
      let excess = self.judged.saturating_sub(self.lead);
      if excess >= self.rate as usize {
        self.drop_front(excess);
      }
      return;
    }
    let since = *self.quiet_since.get_or_insert(start);
    if self.judged - since >= self.pause && since >= self.min_stretch {
      stretches.push(self.cut(since + self.pause / 2));
      self.heard = false;
    }
  }

  /// Hands out the audio before `at` and keeps the rest.
  fn cut(&mut self, at: usize) -> Vec<f32> {
    let stretch = self.pending.drain(..at).collect();
    self.judged -= at;
    self.quiet_since = self.quiet_since.map(|since| since.saturating_sub(at));
    stretch
  }

  fn drop_front(&mut self, count: usize) {
    if count > 0 {
      self.pending.drain(..count);
      self.judged -= count;
    }
  }

  /// Audio held for the stretch still going on.
  #[cfg(test)]
  pub fn pending(&self) -> usize {
    self.pending.len()
  }

  /// The audio after the last cut, once recording stops.
  pub fn finish(self) -> Rest {
    Rest {
      samples: self.pending,
      signal: self.signal,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const RATE: u32 = 16_000;

  fn millis(value: usize) -> usize {
    samples_in(value, RATE)
  }

  /// A tone well above the silence level, continuing in phase across calls.
  fn tone(from: usize, count: usize) -> impl Iterator<Item = f32> {
    (from..from + count).map(|index| 0.3 * ((index as f32) * 0.05).sin())
  }

  /// Audio of alternating speech and silence, in milliseconds.
  fn audio(parts: &[(bool, usize)]) -> Vec<f32> {
    let mut samples = Vec::new();
    for (loud, length) in parts {
      let count = millis(*length);
      if *loud {
        let from = samples.len();
        samples.extend(tone(from, count));
      } else {
        samples.extend(std::iter::repeat_n(0.0, count));
      }
    }
    samples
  }

  /// Every stretch, then the rest, pushing `samples` in blocks of `block`.
  fn split(samples: &[f32], block: usize) -> (Vec<Vec<f32>>, Rest) {
    let mut segmenter = Segmenter::new(RATE);
    let mut stretches = Vec::new();
    for piece in samples.chunks(block) {
      stretches.extend(segmenter.push(piece));
    }
    (stretches, segmenter.finish())
  }

  #[test]
  fn a_pause_after_speech_ends_a_stretch_in_its_middle() {
    let samples = audio(&[(true, 2_000), (false, 600), (true, 1_500)]);
    let (stretches, rest) = split(&samples, 1_600);
    assert_eq!(stretches.len(), 1);
    // The stretch ends a quarter second into the pause.
    assert_eq!(stretches[0].len(), millis(2_000 + PAUSE_MILLIS / 2));
    assert_eq!(stretches[0][..], samples[..stretches[0].len()]);
    // The rest is the next speech with the kept lead of silence before it.
    assert_eq!(rest.samples.len(), millis(LEAD_MILLIS + 1_500));
    assert_eq!(
      rest.samples[..],
      samples[samples.len() - rest.samples.len()..]
    );
    assert!(rest.signal);
  }

  #[test]
  fn a_shorter_pause_does_not_cut() {
    let samples = audio(&[
      (true, 2_000),
      (false, PAUSE_MILLIS - FRAME_MILLIS),
      (true, 1_000),
    ]);
    let (stretches, rest) = split(&samples, 1_600);
    assert!(stretches.is_empty());
    assert_eq!(rest.samples, samples);
    // One frame more and it does.
    let samples = audio(&[(true, 2_000), (false, PAUSE_MILLIS), (true, 1_000)]);
    assert_eq!(split(&samples, 1_600).0.len(), 1);
  }

  #[test]
  fn a_lone_word_waits_for_its_sentence() {
    let samples = audio(&[
      (true, 400),
      (false, 800),
      (true, 1_600),
      (false, 800),
      (true, 500),
    ]);
    let (stretches, rest) = split(&samples, 1_600);
    // The first pause follows less than a second of speech: no cut there.
    assert_eq!(stretches.len(), 1);
    assert_eq!(
      stretches[0].len(),
      millis(400 + 800 + 1_600 + PAUSE_MILLIS / 2)
    );
    // Nothing inside the stretch was dropped, the short pause included.
    assert_eq!(stretches[0][..], samples[..stretches[0].len()]);
    assert_eq!(rest.samples.len(), millis(LEAD_MILLIS + 500));
  }

  #[test]
  fn every_pause_cuts_once_and_the_pieces_rebuild_the_recording() {
    let samples = audio(&[
      (true, 1_500),
      (false, 700),
      (true, 3_000),
      (false, 1_200),
      (true, 2_000),
      (false, 520),
      (true, 1_000),
    ]);
    let (stretches, rest) = split(&samples, 480);
    // Each pause, from `start` to `end` in milliseconds, cuts at its middle
    // and drops the silence between the cut and the lead kept before the
    // next speech.
    let pauses = [(1_500, 2_200), (5_200, 6_400), (8_400, 8_920)];
    let mut expected = Vec::new();
    let mut from = 0;
    for (start, end) in pauses {
      let cut = millis(start + PAUSE_MILLIS / 2);
      expected.push(samples[from..cut].to_vec());
      from = millis(end - LEAD_MILLIS);
    }
    assert_eq!(stretches, expected);
    assert_eq!(rest.samples[..], samples[from..]);
    // Only silence was dropped.
    let held = stretches.iter().map(Vec::len).sum::<usize>() + rest.samples.len();
    assert_eq!(
      samples.len() - held,
      millis((700 - PAUSE_MILLIS) + (1_200 - PAUSE_MILLIS) + (520 - PAUSE_MILLIS))
    );
  }

  #[test]
  fn the_cuts_never_depend_on_how_the_audio_arrives() {
    let samples = audio(&[
      (false, 2_300),
      (true, 1_300),
      (false, 900),
      (true, 2_100),
      (false, 510),
      (true, 1_700),
      (false, 3_000),
    ]);
    let (reference, rest) = split(&samples, samples.len());
    assert_eq!(reference.len(), 3);
    for block in [1, 7, 160, 321, 1_000, 4_096] {
      let (stretches, other) = split(&samples, block);
      assert_eq!(stretches, reference, "block of {block}");
      assert_eq!(other.samples, rest.samples, "block of {block}");
    }
  }

  #[test]
  fn silence_before_speech_is_not_held() {
    let mut segmenter = Segmenter::new(RATE);
    for piece in audio(&[(false, 60_000)]).chunks(1_600) {
      assert!(segmenter.push(piece).is_empty());
    }
    // A minute of silence leaves less than a second and a half held.
    assert!(
      segmenter.pending() < millis(1_500),
      "{}",
      segmenter.pending()
    );
    let rest = segmenter.finish();
    assert!(!rest.signal, "exact zeros are no signal");
  }

  #[test]
  fn speech_keeps_a_short_lead_of_the_silence_before_it() {
    let samples = audio(&[(false, 3_000), (true, 1_000)]);
    let (stretches, rest) = split(&samples, 1_600);
    assert!(stretches.is_empty());
    assert_eq!(rest.samples.len(), millis(LEAD_MILLIS + 1_000));
    assert_eq!(
      rest.samples[..],
      samples[samples.len() - rest.samples.len()..]
    );
  }

  #[test]
  fn unbroken_speech_is_cut_before_it_outgrows_a_chunk() {
    let total = millis(150_000);
    let samples = tone(0, total).collect::<Vec<_>>();
    let (stretches, rest) = split(&samples, 4_800);
    assert_eq!(stretches.len(), 2);
    // `cap_cut` answers only for audio longer than one chunk.
    assert!(dictation_cloud::cap_cut(&samples, RATE).is_some());
    for stretch in &stretches {
      assert_eq!(dictation_cloud::cap_cut(stretch, RATE), None);
      assert!(stretch.len() > millis(50_000), "{}", stretch.len());
    }
    let held = stretches.iter().map(Vec::len).sum::<usize>() + rest.samples.len();
    assert_eq!(held, total);
  }

  #[test]
  fn a_pause_cut_and_a_length_cut_follow_each_other() {
    // A long first stretch is cut for length, then the pause still cuts the
    // speech that follows.
    let samples = audio(&[(true, 70_000), (false, 800), (true, 1_000)]);
    let (stretches, rest) = split(&samples, 1_600);
    assert_eq!(stretches.len(), 2);
    assert_eq!(dictation_cloud::cap_cut(&stretches[0], RATE), None);
    assert_eq!(
      stretches[0].len() + stretches[1].len(),
      millis(70_000 + PAUSE_MILLIS / 2)
    );
    assert!(!rest.samples.is_empty());
  }

  #[test]
  fn a_handed_out_stretch_is_no_longer_held() {
    let mut segmenter = Segmenter::new(RATE);
    let stretches = segmenter.push(&audio(&[(true, 5_000), (false, 600)]));
    assert_eq!(stretches.len(), 1);
    assert_eq!(segmenter.pending(), millis(600 - PAUSE_MILLIS / 2));
  }
}
