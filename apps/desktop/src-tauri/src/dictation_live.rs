//! Transcribes a dictation stretch by stretch while the speaker is still
//! talking. One background thread takes the stretches in the order they were
//! cut, so this computer's model answers one request at a time and stella AI
//! gets one chunk at a time, and recording never waits for either.
//!
//! This computer transcribes each stretch as it is cut. stella AI admits a
//! set number of requests a minute, so its stretches ride together: the
//! first request goes out once `FIRST_UPLOAD_MILLIS` of audio waits, every
//! later one once `UPLOAD_MILLIS` does, each with every stretch cut by then,
//! and the rest goes when recording stops.
//!
//! The texts are joined only once recording stops, so nothing is typed
//! before then; meanwhile the text so far goes to the preview, which shows
//! it and types nothing. A stretch stella AI cannot transcribe sends the whole
//! dictation to this computer, as a failed recording always did: the
//! stretches stella AI already answered are transcribed again here, and none
//! of its texts are used. Audio is held only until its stretch has its text,
//! except the stretches stella AI answered while such a fallback is still
//! possible. A cancelled dictation discards every text, finished or not.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine transcribe")
)]

use std::{
  collections::BTreeMap,
  io, iter,
  sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Sender},
  },
  thread::{self, JoinHandle},
  time::Duration,
};

use crate::{
  dictation::Failure,
  dictation_audio::{MODEL_SAMPLE_RATE, holds_speech, resample, samples_in},
  dictation_cloud::{self, Attempt, Destination},
};

/// The least audio one request to stella AI carries while recording goes on,
/// after the first. The server admits 30 transcription requests a minute for
/// one person, and a request for every one-second stretch would spend them
/// within a single dictation. With the first request sooner, a minute of
/// speech is at most thirteen requests, the last one at the release
/// included, which leaves room for dictation elsewhere on the same account.
const UPLOAD_MILLIS: usize = 5_000;
/// The least audio the first request carries: the text starts to show, and a
/// short dictation has less left to send at the release.
const FIRST_UPLOAD_MILLIS: usize = 3_000;

/// What turns one stretch of 16 kHz audio into text, or `None` when it
/// cannot.
pub trait Transcribe {
  fn cloud(&mut self, samples: &[f32]) -> Option<String>;
  fn local(&mut self, samples: &[f32]) -> Option<String>;
  /// The text so far, in recording order, each time it changes: this
  /// computer's after each stretch, stella AI's after each request. Empty
  /// once a fallback, a failure or a cancel discarded what came before.
  fn preview(&mut self, _text: &str) {}
}

/// The texts of a dictation's stretches by their place in it, joined in that
/// order however they arrived.
#[derive(Debug, Default)]
pub struct Transcripts(BTreeMap<usize, String>);

impl Transcripts {
  pub fn insert(&mut self, index: usize, text: &str) {
    self.0.insert(index, text.trim().to_string());
  }

  /// Every text in recording order, single spaces between, empty ones left
  /// out.
  pub fn joined(&self) -> String {
    self
      .0
      .values()
      .filter(|text| !text.is_empty())
      .map(String::as_str)
      .collect::<Vec<_>>()
      .join(" ")
  }
}

/// What one dictation's transcription did, for the local log: counts and
/// lengths, never audio or text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally {
  /// Stretches that held speech and were transcribed.
  pub stretches: usize,
  /// Requests to stella AI.
  pub requests: usize,
  /// stella AI failed and this computer transcribed the dictation instead.
  pub fell_back: bool,
  /// How much speech was transcribed.
  pub speech: Duration,
}

/// One dictation's transcription, stretch by stretch.
pub struct Transcription<T> {
  transcriber: T,
  destination: Destination,
  local_installed: bool,
  attempt: Attempt,
  texts: Transcripts,
  /// Stretches not yet sent to stella AI, as one piece of audio at the place
  /// of the first.
  waiting: Option<(usize, Vec<f32>)>,
  /// Audio stella AI answered, kept while this computer may still have to
  /// transcribe the whole dictation.
  kept: Vec<(usize, Vec<f32>)>,
  failure: Option<Failure>,
  tally: Tally,
  /// 16 kHz samples of speech taken, for the tally.
  speech_samples: usize,
  /// The text the preview shows.
  previewed: String,
}

impl<T: Transcribe> Transcription<T> {
  pub fn new(transcriber: T, destination: Destination, local_installed: bool) -> Self {
    let attempt = dictation_cloud::attempts(destination, local_installed)
      .first()
      .copied()
      .unwrap_or(Attempt::Local);
    Self {
      transcriber,
      destination,
      local_installed,
      attempt,
      texts: Transcripts::default(),
      waiting: None,
      kept: Vec::new(),
      failure: None,
      tally: Tally::default(),
      speech_samples: 0,
      previewed: String::new(),
    }
  }

  /// Whether another stretch would still be transcribed.
  pub const fn wants_audio(&self) -> bool {
    self.failure.is_none()
  }

  /// Takes stretch `index`: this computer transcribes it at once, stella AI
  /// gets it with its next request. Silent stretches are skipped; after a
  /// failure nothing more is transcribed.
  pub fn add(&mut self, index: usize, samples: Vec<f32>) {
    if !self.wants_audio() || !holds_speech(&samples) {
      return;
    }
    self.tally.stretches += 1;
    self.speech_samples += samples.len();
    match self.attempt {
      Attempt::Cloud => match self.waiting.as_mut() {
        Some((_, waiting)) => waiting.extend_from_slice(&samples),
        None => self.waiting = Some((index, samples)),
      },
      Attempt::Local => self.local(index, &samples),
    }
  }

  /// Sends stella AI the stretches that wait, once they are worth a request
  /// while recording goes on: sooner for the first request of the
  /// dictation.
  pub fn upload_due(&mut self) {
    let millis = if self.tally.requests == 0 {
      FIRST_UPLOAD_MILLIS
    } else {
      UPLOAD_MILLIS
    };
    let due = samples_in(millis, MODEL_SAMPLE_RATE);
    if self
      .waiting
      .as_ref()
      .is_some_and(|(_, waiting)| waiting.len() >= due)
    {
      self.upload();
    }
  }

  /// Sends stella AI every stretch that waits, as one piece of audio.
  fn upload(&mut self) {
    let Some((index, samples)) = self.waiting.take() else {
      return;
    };
    self.tally.requests += 1;
    match self.transcriber.cloud(&samples) {
      Some(text) => {
        self.texts.insert(index, &text);
        if self.local_installed {
          self.kept.push((index, samples));
        }
        self.refresh_preview();
      }
      None => self.fall_back(index, samples),
    }
  }

  /// stella AI failed: this computer transcribes the whole dictation, the
  /// audio already answered included, or the dictation fails.
  fn fall_back(&mut self, index: usize, samples: Vec<f32>) {
    if !self.local_installed {
      self.fail();
      return;
    }
    self.attempt = Attempt::Local;
    self.tally.fell_back = true;
    self.texts = Transcripts::default();
    let kept = std::mem::take(&mut self.kept);
    for (kept_index, kept_samples) in kept.into_iter().chain([(index, samples)]) {
      self.local(kept_index, &kept_samples);
      if !self.wants_audio() {
        return;
      }
    }
  }

  fn local(&mut self, index: usize, samples: &[f32]) {
    match self.transcriber.local(samples) {
      Some(text) => {
        self.texts.insert(index, &text);
        self.refresh_preview();
      }
      None => self.fail(),
    }
  }

  /// Hands the preview the text so far when it changed. A fallback starts
  /// over without stella AI's texts, so the first text this computer
  /// returns replaces them.
  fn refresh_preview(&mut self) {
    let joined = self.texts.joined();
    if joined != self.previewed {
      self.transcriber.preview(&joined);
      self.previewed = joined;
    }
  }

  fn fail(&mut self) {
    self.failure = Some(dictation_cloud::failure(
      self.destination,
      self.local_installed,
    ));
    self.texts = Transcripts::default();
    self.waiting = None;
    self.kept = Vec::new();
    self.refresh_preview();
  }

  /// Audio still held for a possible fallback.
  #[cfg(test)]
  fn kept_samples(&self) -> usize {
    self.kept.iter().map(|(_, samples)| samples.len()).sum()
  }

  /// [`Self::finish_tallied`] without the tally.
  #[cfg(test)]
  pub fn finish(self) -> (Result<String, Failure>, T) {
    let (result, transcriber, _tally) = self.finish_tallied();
    (result, transcriber)
  }

  /// Recording stopped: sends stella AI what still waits, then the joined
  /// text, or the failure the dictation reports, the transcriber back, and
  /// what the transcription did.
  pub fn finish_tallied(mut self) -> (Result<String, Failure>, T, Tally) {
    self.upload();
    let result = match self.failure {
      Some(failure) => Err(failure),
      None => Ok(self.texts.joined()),
    };
    let tally = self.tally();
    (result, self.transcriber, tally)
  }

  fn tally(&self) -> Tally {
    let speech = Duration::from_secs_f64(
      self.speech_samples as f64 / f64::from(MODEL_SAMPLE_RATE),
    );
    Tally {
      speech,
      ..self.tally
    }
  }

  /// The transcriber back without another request: what waits is dropped,
  /// and so is what the preview shows.
  pub fn discard(mut self) -> T {
    self.texts = Transcripts::default();
    self.refresh_preview();
    self.transcriber
  }
}

/// How a dictation's transcription ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
  Text(String),
  Failed(Failure),
  /// Cancelled: every text is discarded.
  Cancelled,
}

/// The background thread of one dictation.
pub struct Live<T> {
  stretches: Sender<(usize, Vec<f32>)>,
  next: usize,
  cancelled: Arc<AtomicBool>,
  thread: JoinHandle<(Ended, T, Tally)>,
}

impl<T: Transcribe + Send + 'static> Live<T> {
  /// Starts transcribing stretches recorded at `rate`. Setting `cancelled`
  /// discards the dictation.
  pub fn start(
    mut transcription: Transcription<T>,
    rate: u32,
    cancelled: Arc<AtomicBool>,
  ) -> io::Result<Self> {
    let (stretches, received) = mpsc::channel::<(usize, Vec<f32>)>();
    let flag = Arc::clone(&cancelled);
    let thread = thread::Builder::new()
      .name("dictation-transcription".to_string())
      .spawn(move || {
        let discarded = || flag.load(Ordering::SeqCst);
        'recording: while let Ok(first) = received.recv() {
          // Every stretch cut while the last request was out is taken with
          // this one, so stella AI gets them in one request.
          for (index, stretch) in iter::once(first).chain(received.try_iter()) {
            if discarded() {
              break 'recording;
            }
            if transcription.wants_audio() {
              let samples = resample(&stretch, rate, MODEL_SAMPLE_RATE);
              drop(stretch);
              transcription.add(index, samples);
            }
          }
          if discarded() {
            break;
          }
          transcription.upload_due();
        }
        if discarded() {
          let tally = transcription.tally();
          return (Ended::Cancelled, transcription.discard(), tally);
        }
        let (result, transcriber, tally) = transcription.finish_tallied();
        let ended = if discarded() {
          Ended::Cancelled
        } else {
          match result {
            Ok(text) => Ended::Text(text),
            Err(failure) => Ended::Failed(failure),
          }
        };
        (ended, transcriber, tally)
      })?;
    Ok(Self {
      stretches,
      next: 0,
      cancelled,
      thread,
    })
  }

  /// Queues the next stretch; recording goes on at once.
  pub fn send(&mut self, stretch: Vec<f32>) {
    if self.stretches.send((self.next, stretch)).is_err() {
      tracing::warn!("dictation transcription stopped early");
    }
    self.next += 1;
  }

  /// Waits for every queued stretch, then how the transcription ended and
  /// the transcriber back; `None` if the thread did not survive.
  pub fn finish(self) -> Option<(Ended, T)> {
    self
      .finish_tallied()
      .map(|(ended, transcriber, _tally)| (ended, transcriber))
  }

  /// [`Self::finish`], with what the transcription did.
  pub fn finish_tallied(self) -> Option<(Ended, T, Tally)> {
    drop(self.stretches);
    self.thread.join().ok()
  }

  /// Stretches queued so far, silent ones included.
  pub const fn sent(&self) -> usize {
    self.next
  }

  /// Discards the dictation: queued stretches are dropped, the one in
  /// progress ends unused, and the transcriber comes back.
  pub fn cancel(self) -> Option<T> {
    self.cancelled.store(true, Ordering::SeqCst);
    self.finish().map(|(_, transcriber)| transcriber)
  }
}

#[cfg(test)]
mod tests {
  use std::sync::mpsc::Receiver;

  use super::*;

  const SECOND: usize = MODEL_SAMPLE_RATE as usize;
  /// The audio that is worth a request to stella AI after the first.
  const UPLOAD: usize = UPLOAD_MILLIS / 1_000 * SECOND;
  /// The audio that is worth the first request.
  const FIRST_UPLOAD: usize = FIRST_UPLOAD_MILLIS / 1_000 * SECOND;

  /// A tone loud enough to count as speech.
  fn tone(length: usize) -> Vec<f32> {
    (0..length)
      .map(|index| 0.3 * ((index as f32) * 0.05).sin())
      .collect()
  }

  /// Speech of `length` samples whose first sample names it.
  fn speech(name: usize, length: usize) -> Vec<f32> {
    let mut samples = tone(length);
    samples[0] = name as f32 / 100.0;
    samples
  }

  /// A one-second stretch.
  fn stretch(name: usize) -> Vec<f32> {
    speech(name, SECOND)
  }

  /// A stretch that is worth a request to stella AI by itself.
  fn long(name: usize) -> Vec<f32> {
    speech(name, UPLOAD)
  }

  fn name(samples: &[f32]) -> usize {
    (samples[0] * 100.0).round() as usize
  }

  /// Answers by the name of the audio's first stretch; `None` for the names
  /// listed as failing.
  #[derive(Default)]
  struct Fake {
    cloud_fails: Vec<usize>,
    local_fails: Vec<usize>,
    cloud_calls: Vec<usize>,
    /// How much audio each call to stella AI carried.
    cloud_lengths: Vec<usize>,
    local_calls: Vec<usize>,
    /// Every text handed to the preview, in order.
    previews: Vec<String>,
    /// Signals each call, then waits for leave to answer.
    gate: Option<(Sender<usize>, Receiver<()>)>,
  }

  impl Fake {
    fn pass(&self, name: usize) {
      if let Some((started, leave)) = &self.gate {
        started.send(name).unwrap();
        leave.recv().unwrap();
      }
    }
  }

  impl Transcribe for Fake {
    fn cloud(&mut self, samples: &[f32]) -> Option<String> {
      let name = name(samples);
      self.cloud_calls.push(name);
      self.cloud_lengths.push(samples.len());
      self.pass(name);
      (!self.cloud_fails.contains(&name)).then(|| format!("cloud{name}"))
    }

    fn local(&mut self, samples: &[f32]) -> Option<String> {
      let name = name(samples);
      self.local_calls.push(name);
      self.pass(name);
      (!self.local_fails.contains(&name)).then(|| format!("local{name}"))
    }

    fn preview(&mut self, text: &str) {
      self.previews.push(text.to_string());
    }
  }

  /// Transcribes `count` stretches made by `stretch` and named from one, the
  /// way the background thread does when none of them had to queue.
  fn run_each(
    fake: Fake,
    destination: Destination,
    installed: bool,
    count: usize,
    stretch: fn(usize) -> Vec<f32>,
  ) -> (Result<String, Failure>, Fake) {
    let mut transcription = Transcription::new(fake, destination, installed);
    for index in 0..count {
      transcription.add(index, stretch(index + 1));
      transcription.upload_due();
    }
    transcription.finish()
  }

  /// Long stretches to stella AI, with the tally.
  fn run_tallied(
    fake: Fake,
    installed: bool,
    count: usize,
  ) -> (Result<String, Failure>, Fake, Tally) {
    let mut transcription = Transcription::new(fake, Destination::Cloud, installed);
    for index in 0..count {
      transcription.add(index, long(index + 1));
      transcription.upload_due();
    }
    transcription.finish_tallied()
  }

  /// One-second stretches.
  fn run(
    fake: Fake,
    destination: Destination,
    installed: bool,
    count: usize,
  ) -> (Result<String, Failure>, Fake) {
    run_each(fake, destination, installed, count, stretch)
  }

  /// Stretches that each go to stella AI as a request of their own.
  fn run_long(
    fake: Fake,
    installed: bool,
    count: usize,
  ) -> (Result<String, Failure>, Fake) {
    run_each(fake, Destination::Cloud, installed, count, long)
  }

  #[test]
  fn texts_join_in_recording_order_however_they_arrive() {
    let mut texts = Transcripts::default();
    texts.insert(2, " third ");
    texts.insert(0, "first");
    texts.insert(3, "  ");
    texts.insert(1, "second");
    assert_eq!(texts.joined(), "first second third");
    assert_eq!(Transcripts::default().joined(), "");
  }

  #[test]
  fn this_computer_transcribes_every_stretch_and_never_calls_stella_ai() {
    let (result, fake) = run(Fake::default(), Destination::Local, true, 3);
    assert_eq!(result, Ok("local1 local2 local3".to_string()));
    assert_eq!(fake.local_calls, vec![1, 2, 3]);
    assert!(fake.cloud_calls.is_empty());
  }

  #[test]
  fn a_failed_stretch_on_this_computer_fails_the_dictation_without_partial_text() {
    let fake = Fake {
      local_fails: vec![2],
      ..Fake::default()
    };
    let (result, fake) = run(fake, Destination::Local, true, 4);
    assert_eq!(result, Err(Failure::Transcription));
    // Nothing after the failure is transcribed.
    assert_eq!(fake.local_calls, vec![1, 2]);
  }

  #[test]
  fn a_missing_model_is_reported_for_this_computer() {
    let fake = Fake {
      local_fails: vec![1],
      ..Fake::default()
    };
    assert_eq!(
      run(fake, Destination::Local, false, 1).0,
      Err(Failure::ModelMissing)
    );
  }

  #[test]
  fn stella_ai_answers_without_this_computer() {
    let (result, fake) = run_long(Fake::default(), true, 3);
    assert_eq!(result, Ok("cloud1 cloud2 cloud3".to_string()));
    assert_eq!(fake.cloud_lengths, vec![UPLOAD; 3]);
    assert!(fake.local_calls.is_empty());
  }

  #[test]
  fn short_stretches_wait_and_go_to_stella_ai_in_one_request() {
    let mut transcription =
      Transcription::new(Fake::default(), Destination::Cloud, true);
    for index in 0..2 {
      transcription.add(index, stretch(index + 1));
      transcription.upload_due();
    }
    // Two seconds are not worth a request while recording goes on.
    assert!(transcription.transcriber.cloud_calls.is_empty());
    let (result, fake) = transcription.finish();
    assert_eq!(result, Ok("cloud1".to_string()));
    assert_eq!(fake.cloud_lengths, vec![2 * SECOND]);
  }

  #[test]
  fn the_first_request_goes_after_three_seconds_and_the_others_after_five() {
    let mut transcription =
      Transcription::new(Fake::default(), Destination::Cloud, true);
    // The second at which each request went out while recording went on.
    let mut sent_at = Vec::new();
    for second in 1..=14 {
      transcription.add(second - 1, stretch(second));
      let before = transcription.transcriber.cloud_calls.len();
      transcription.upload_due();
      if transcription.transcriber.cloud_calls.len() > before {
        sent_at.push(second);
      }
    }
    assert_eq!(sent_at, vec![3, 8, 13]);
    let (result, fake) = transcription.finish();
    assert_eq!(result, Ok("cloud1 cloud4 cloud9 cloud14".to_string()));
    assert_eq!(
      fake.cloud_lengths,
      vec![FIRST_UPLOAD, UPLOAD, UPLOAD, SECOND]
    );
  }

  #[test]
  fn a_request_goes_to_stella_ai_once_enough_audio_waits() {
    let (result, fake) = run(Fake::default(), Destination::Cloud, true, 12);
    assert_eq!(result, Ok("cloud1 cloud4 cloud9".to_string()));
    assert_eq!(fake.cloud_lengths, vec![FIRST_UPLOAD, UPLOAD, 4 * SECOND]);
  }

  #[test]
  fn a_minute_of_continuous_speech_stays_within_fourteen_requests() {
    let (_, fake) = run(Fake::default(), Destination::Cloud, false, 60);
    // At 3 s, then every 5 s up to 58 s, and the last 2 s at the release.
    assert_eq!(fake.cloud_calls.len(), 13);
    assert_eq!(fake.cloud_lengths.iter().sum::<usize>(), 60 * SECOND);
    // However the pauses cut the speech, a minute stays within the bound.
    for millis in [300, 500, 1_500, 2_500, 3_000, 4_000, 7_000] {
      let length = samples_in(millis, MODEL_SAMPLE_RATE);
      let mut transcription =
        Transcription::new(Fake::default(), Destination::Cloud, false);
      for index in 0..(60 * SECOND).div_ceil(length) {
        transcription.add(index, speech(index + 1, length));
        transcription.upload_due();
      }
      let (_, fake) = transcription.finish();
      assert!(
        fake.cloud_calls.len() <= 14,
        "{millis} ms stretches made {} requests",
        fake.cloud_calls.len()
      );
    }
  }

  #[test]
  fn every_stretch_already_cut_goes_in_one_request() {
    let mut transcription =
      Transcription::new(Fake::default(), Destination::Cloud, false);
    // Four long stretches were cut while an earlier request was out.
    for index in 0..4 {
      transcription.add(index, long(index + 1));
    }
    transcription.upload_due();
    let (result, fake) = transcription.finish();
    assert_eq!(result, Ok("cloud1".to_string()));
    assert_eq!(fake.cloud_lengths, vec![4 * UPLOAD]);
  }

  #[test]
  fn a_discarded_transcription_sends_nothing_that_waited() {
    let mut transcription =
      Transcription::new(Fake::default(), Destination::Cloud, true);
    transcription.add(0, stretch(1));
    transcription.upload_due();
    assert!(transcription.discard().cloud_calls.is_empty());
  }

  #[test]
  fn a_stella_ai_failure_transcribes_the_whole_dictation_on_this_computer() {
    let fake = Fake {
      cloud_fails: vec![3],
      ..Fake::default()
    };
    let (result, fake) = run_long(fake, true, 5);
    // Every stretch, the ones stella AI answered included, comes from this
    // computer, and nothing after the failure goes to stella AI.
    assert_eq!(result, Ok("local1 local2 local3 local4 local5".to_string()));
    assert_eq!(fake.cloud_calls, vec![1, 2, 3]);
    assert_eq!(fake.local_calls, vec![1, 2, 3, 4, 5]);
  }

  #[test]
  fn a_failed_last_request_falls_back_with_what_waited() {
    let fake = Fake {
      cloud_fails: vec![2],
      ..Fake::default()
    };
    let mut transcription = Transcription::new(fake, Destination::Cloud, true);
    transcription.add(0, long(1));
    transcription.upload_due();
    // Two short stretches wait until recording stops, then stella AI fails.
    transcription.add(1, stretch(2));
    transcription.add(2, stretch(3));
    transcription.upload_due();
    let (result, fake) = transcription.finish();
    assert_eq!(result, Ok("local1 local2".to_string()));
    assert_eq!(fake.cloud_calls, vec![1, 2]);
    assert_eq!(fake.local_calls, vec![1, 2]);
  }

  #[test]
  fn a_stella_ai_failure_without_the_model_fails_the_dictation() {
    let fake = Fake {
      cloud_fails: vec![2],
      ..Fake::default()
    };
    let (result, fake) = run_long(fake, false, 4);
    assert_eq!(result, Err(Failure::CloudTranscription));
    assert_eq!(fake.cloud_calls, vec![1, 2]);
    assert!(fake.local_calls.is_empty());
  }

  #[test]
  fn a_failed_fallback_reports_stella_ai() {
    let fake = Fake {
      cloud_fails: vec![2],
      local_fails: vec![1],
      ..Fake::default()
    };
    let (result, fake) = run_long(fake, true, 3);
    assert_eq!(result, Err(Failure::CloudTranscription));
    assert_eq!(fake.local_calls, vec![1]);
  }

  #[test]
  fn the_tally_counts_speech_requests_and_a_fallback() {
    let mut transcription =
      Transcription::new(Fake::default(), Destination::Cloud, true);
    transcription.add(0, vec![0.0; SECOND]);
    for index in 1..=6 {
      transcription.add(index, stretch(index));
      transcription.upload_due();
    }
    let (_, _, tally) = transcription.finish_tallied();
    // The silent stretch is not counted; three seconds made the first
    // request while recording went on, the other three went at the release.
    assert_eq!(
      tally,
      Tally {
        stretches: 6,
        requests: 2,
        fell_back: false,
        speech: Duration::from_secs(6),
      }
    );
    let fake = Fake {
      cloud_fails: vec![1],
      ..Fake::default()
    };
    let (result, _, tally) = run_tallied(fake, true, 2);
    assert_eq!(result, Ok("local1 local2".to_string()));
    assert_eq!((tally.requests, tally.fell_back), (1, true));
  }

  #[test]
  fn silent_stretches_are_not_transcribed() {
    let mut transcription =
      Transcription::new(Fake::default(), Destination::Local, true);
    transcription.add(0, vec![0.0; SECOND]);
    transcription.add(1, stretch(2));
    let (result, fake) = transcription.finish();
    assert_eq!(result, Ok("local2".to_string()));
    assert_eq!(fake.local_calls, vec![2]);
  }

  #[test]
  fn audio_is_held_only_while_a_fallback_may_need_it() {
    let mut local = Transcription::new(Fake::default(), Destination::Local, true);
    local.add(0, stretch(1));
    assert_eq!(local.kept_samples(), 0);
    let mut unbacked = Transcription::new(Fake::default(), Destination::Cloud, false);
    unbacked.add(0, long(1));
    unbacked.upload_due();
    assert_eq!(unbacked.kept_samples(), 0);
    let fake = Fake {
      cloud_fails: vec![3],
      ..Fake::default()
    };
    let mut backed = Transcription::new(fake, Destination::Cloud, true);
    backed.add(0, long(1));
    backed.upload_due();
    backed.add(1, long(2));
    backed.upload_due();
    assert_eq!(backed.kept_samples(), 2 * UPLOAD);
    // Once this computer has redone them, nothing is held any more.
    backed.add(2, long(3));
    backed.upload_due();
    assert_eq!(backed.kept_samples(), 0);
    backed.add(3, long(4));
    backed.upload_due();
    assert_eq!(backed.kept_samples(), 0);
  }

  fn previews(texts: &[&str]) -> Vec<String> {
    texts.iter().map(ToString::to_string).collect()
  }

  #[test]
  fn the_preview_grows_with_each_stretch_this_computer_answers() {
    let (_, fake) = run(Fake::default(), Destination::Local, true, 3);
    assert_eq!(
      fake.previews,
      previews(&["local1", "local1 local2", "local1 local2 local3"])
    );
  }

  #[test]
  fn the_preview_keeps_recording_order_when_stretches_answer_out_of_order() {
    let mut transcription =
      Transcription::new(Fake::default(), Destination::Local, true);
    transcription.add(2, stretch(3));
    transcription.add(0, stretch(1));
    transcription.add(1, stretch(2));
    let (_, fake) = transcription.finish();
    assert_eq!(
      fake.previews,
      previews(&["local3", "local1 local3", "local1 local2 local3"])
    );
  }

  #[test]
  fn the_preview_grows_with_each_request_stella_ai_answers() {
    let (_, fake) = run(Fake::default(), Destination::Cloud, true, 12);
    // Three seconds ride in the first request and five in the next; the
    // last four go on release.
    assert_eq!(
      fake.previews,
      previews(&["cloud1", "cloud1 cloud4", "cloud1 cloud4 cloud9"])
    );
  }

  #[test]
  fn a_fallback_replaces_every_stella_ai_text_in_the_preview() {
    let fake = Fake {
      cloud_fails: vec![3],
      ..Fake::default()
    };
    let (_, fake) = run_long(fake, true, 4);
    assert_eq!(
      fake.previews,
      previews(&[
        "cloud1",
        "cloud1 cloud2",
        "local1",
        "local1 local2",
        "local1 local2 local3",
        "local1 local2 local3 local4",
      ])
    );
  }

  #[test]
  fn a_failure_clears_the_preview() {
    let fake = Fake {
      local_fails: vec![2],
      ..Fake::default()
    };
    let (_, fake) = run(fake, Destination::Local, true, 3);
    assert_eq!(fake.previews, previews(&["local1", ""]));
    let fake = Fake {
      cloud_fails: vec![2],
      ..Fake::default()
    };
    let (_, fake) = run_long(fake, false, 3);
    assert_eq!(fake.previews, previews(&["cloud1", ""]));
  }

  #[test]
  fn a_discarded_transcription_clears_the_preview_once() {
    let mut shown = Transcription::new(Fake::default(), Destination::Local, true);
    shown.add(0, stretch(1));
    assert_eq!(shown.discard().previews, previews(&["local1", ""]));
    let unshown = Transcription::new(Fake::default(), Destination::Local, true);
    assert!(unshown.discard().previews.is_empty());
  }

  #[test]
  fn cancelling_clears_the_preview_after_the_stretch_in_progress() {
    let (started, started_rx) = mpsc::channel();
    let (leave, leave_rx) = mpsc::channel();
    let fake = Fake {
      gate: Some((started, leave_rx)),
      ..Fake::default()
    };
    let transcription = Transcription::new(fake, Destination::Local, true);
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut live =
      Live::start(transcription, MODEL_SAMPLE_RATE, Arc::clone(&cancelled)).unwrap();
    live.send(stretch(1));
    live.send(stretch(2));
    assert_eq!(started_rx.recv().unwrap(), 1);
    leave.send(()).unwrap();
    // The second stretch is being transcribed when the dictation is
    // cancelled; whatever it returns, the preview ends empty.
    assert_eq!(started_rx.recv().unwrap(), 2);
    cancelled.store(true, Ordering::SeqCst);
    leave.send(()).unwrap();
    let (ended, fake) = live.finish().unwrap();
    assert_eq!(ended, Ended::Cancelled);
    assert_eq!(fake.previews.last().map(String::as_str), Some(""));
    assert_eq!(fake.previews.first().map(String::as_str), Some("local1"));
  }

  #[test]
  fn the_background_thread_joins_every_stretch_in_order() {
    let transcription = Transcription::new(Fake::default(), Destination::Local, true);
    let mut live =
      Live::start(transcription, MODEL_SAMPLE_RATE, Arc::default()).unwrap();
    for name in 1..=4 {
      live.send(stretch(name));
    }
    let (ended, fake) = live.finish().unwrap();
    assert_eq!(
      ended,
      Ended::Text("local1 local2 local3 local4".to_string())
    );
    assert_eq!(fake.local_calls, vec![1, 2, 3, 4]);
  }

  #[test]
  fn a_failure_ends_the_dictation_as_a_failure() {
    let fake = Fake {
      local_fails: vec![1],
      ..Fake::default()
    };
    let transcription = Transcription::new(fake, Destination::Local, true);
    let mut live =
      Live::start(transcription, MODEL_SAMPLE_RATE, Arc::default()).unwrap();
    live.send(stretch(1));
    live.send(stretch(2));
    let (ended, fake) = live.finish().unwrap();
    assert_eq!(ended, Ended::Failed(Failure::Transcription));
    assert_eq!(fake.local_calls, vec![1]);
  }

  #[test]
  fn cancelling_discards_the_stretch_in_progress_and_every_queued_one() {
    let (started, started_rx) = mpsc::channel();
    let (leave, leave_rx) = mpsc::channel();
    let fake = Fake {
      gate: Some((started, leave_rx)),
      ..Fake::default()
    };
    let transcription = Transcription::new(fake, Destination::Local, true);
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut live =
      Live::start(transcription, MODEL_SAMPLE_RATE, Arc::clone(&cancelled)).unwrap();
    for name in 1..=3 {
      live.send(stretch(name));
    }
    // The first stretch is being transcribed when the dictation is cancelled.
    assert_eq!(started_rx.recv().unwrap(), 1);
    cancelled.store(true, Ordering::SeqCst);
    leave.send(()).unwrap();
    let (ended, fake) = live.finish().unwrap();
    assert_eq!(ended, Ended::Cancelled);
    assert_eq!(fake.local_calls, vec![1]);
  }

  #[test]
  fn stretches_cut_during_a_request_go_to_stella_ai_in_the_next_one() {
    let (started, started_rx) = mpsc::channel();
    let (leave, leave_rx) = mpsc::channel();
    let fake = Fake {
      gate: Some((started, leave_rx)),
      ..Fake::default()
    };
    let transcription = Transcription::new(fake, Destination::Cloud, false);
    let mut live =
      Live::start(transcription, MODEL_SAMPLE_RATE, Arc::default()).unwrap();
    live.send(long(1));
    // Three more stretches are cut while the first request is out.
    assert_eq!(started_rx.recv().unwrap(), 1);
    live.send(long(2));
    live.send(long(3));
    live.send(stretch(4));
    leave.send(()).unwrap();
    assert_eq!(started_rx.recv().unwrap(), 2);
    leave.send(()).unwrap();
    let (ended, fake) = live.finish().unwrap();
    assert_eq!(ended, Ended::Text("cloud1 cloud2".to_string()));
    assert_eq!(fake.cloud_lengths, vec![UPLOAD, 2 * UPLOAD + SECOND]);
  }

  #[test]
  fn cancelling_sends_stella_ai_nothing_that_waited() {
    let transcription = Transcription::new(Fake::default(), Destination::Cloud, true);
    let mut live =
      Live::start(transcription, MODEL_SAMPLE_RATE, Arc::default()).unwrap();
    live.send(stretch(1));
    let fake = live.cancel().unwrap();
    assert!(fake.cloud_calls.is_empty());
  }

  #[test]
  fn cancel_returns_the_transcriber_for_the_next_dictation() {
    let transcription = Transcription::new(Fake::default(), Destination::Local, true);
    let live = Live::start(transcription, MODEL_SAMPLE_RATE, Arc::default()).unwrap();
    assert!(live.cancel().is_some());
  }

  #[test]
  fn stretches_recorded_at_another_rate_reach_the_model_at_its_rate() {
    #[derive(Default)]
    struct Lengths(Vec<usize>);
    impl Transcribe for Lengths {
      fn cloud(&mut self, _samples: &[f32]) -> Option<String> {
        None
      }
      fn local(&mut self, samples: &[f32]) -> Option<String> {
        self.0.push(samples.len());
        Some(String::new())
      }
    }
    let transcription =
      Transcription::new(Lengths::default(), Destination::Local, true);
    let mut live = Live::start(transcription, 48_000, Arc::default()).unwrap();
    live.send(tone(48_000));
    let (ended, lengths) = live.finish().unwrap();
    assert_eq!(ended, Ended::Text(String::new()));
    assert_eq!(lengths.0, vec![SECOND]);
  }
}
