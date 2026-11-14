//! Transcribes a dictation stretch by stretch while the speaker is still
//! talking. One background thread takes the stretches in the order they were
//! cut, so this computer's model answers one request at a time and stella AI
//! gets one chunk at a time, and recording never waits for either.
//!
//! The texts are joined only once recording stops, so nothing is typed
//! before then. A stretch stella AI cannot transcribe sends the whole
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
  io,
  sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Sender},
  },
  thread::{self, JoinHandle},
};

use crate::{
  dictation::Failure,
  dictation_audio::{MODEL_SAMPLE_RATE, holds_speech, resample},
  dictation_cloud::{self, Attempt, Destination},
};

/// What turns one stretch of 16 kHz audio into text, or `None` when it
/// cannot.
pub trait Transcribe {
  fn cloud(&mut self, samples: &[f32]) -> Option<String>;
  fn local(&mut self, samples: &[f32]) -> Option<String>;
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

/// One dictation's transcription, stretch by stretch.
pub struct Transcription<T> {
  transcriber: T,
  destination: Destination,
  local_installed: bool,
  attempt: Attempt,
  texts: Transcripts,
  /// Stretches stella AI answered, kept while this computer may still have
  /// to transcribe the whole dictation.
  kept: Vec<(usize, Vec<f32>)>,
  failure: Option<Failure>,
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
      kept: Vec::new(),
      failure: None,
    }
  }

  /// Whether another stretch would still be transcribed.
  pub const fn wants_audio(&self) -> bool {
    self.failure.is_none()
  }

  /// Transcribes stretch `index`. Silent stretches are skipped; after a
  /// failure nothing more is transcribed.
  pub fn add(&mut self, index: usize, samples: Vec<f32>) {
    if !self.wants_audio() || !holds_speech(&samples) {
      return;
    }
    match self.attempt {
      Attempt::Cloud => match self.transcriber.cloud(&samples) {
        Some(text) => {
          self.texts.insert(index, &text);
          if self.local_installed {
            self.kept.push((index, samples));
          }
        }
        None => self.fall_back(index, samples),
      },
      Attempt::Local => self.local(index, &samples),
    }
  }

  /// stella AI failed: this computer transcribes the whole dictation, the
  /// stretches already answered included, or the dictation fails.
  fn fall_back(&mut self, index: usize, samples: Vec<f32>) {
    if !self.local_installed {
      self.fail();
      return;
    }
    self.attempt = Attempt::Local;
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
      Some(text) => self.texts.insert(index, &text),
      None => self.fail(),
    }
  }

  fn fail(&mut self) {
    self.failure = Some(dictation_cloud::failure(
      self.destination,
      self.local_installed,
    ));
    self.texts = Transcripts::default();
    self.kept = Vec::new();
  }

  /// Audio still held for a possible fallback.
  #[cfg(test)]
  fn kept_samples(&self) -> usize {
    self.kept.iter().map(|(_, samples)| samples.len()).sum()
  }

  /// The joined text, or the failure the dictation reports, and the
  /// transcriber back.
  pub fn finish(self) -> (Result<String, Failure>, T) {
    let result = match self.failure {
      Some(failure) => Err(failure),
      None => Ok(self.texts.joined()),
    };
    (result, self.transcriber)
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
  thread: JoinHandle<(Ended, T)>,
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
        for (index, stretch) in received {
          if flag.load(Ordering::SeqCst) {
            break;
          }
          if transcription.wants_audio() {
            let samples = resample(&stretch, rate, MODEL_SAMPLE_RATE);
            drop(stretch);
            transcription.add(index, samples);
          }
        }
        let (result, transcriber) = transcription.finish();
        let ended = if flag.load(Ordering::SeqCst) {
          Ended::Cancelled
        } else {
          match result {
            Ok(text) => Ended::Text(text),
            Err(failure) => Ended::Failed(failure),
          }
        };
        (ended, transcriber)
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
    drop(self.stretches);
    self.thread.join().ok()
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

  /// A stretch of speech whose first sample names it.
  fn stretch(name: usize) -> Vec<f32> {
    let mut samples = vec![0.3; SECOND];
    samples[0] = name as f32 / 100.0;
    samples
  }

  fn name(samples: &[f32]) -> usize {
    (samples[0] * 100.0).round() as usize
  }

  /// Answers by the stretch's name; `None` for the names listed as failing.
  #[derive(Default)]
  struct Fake {
    cloud_fails: Vec<usize>,
    local_fails: Vec<usize>,
    cloud_calls: Vec<usize>,
    local_calls: Vec<usize>,
    /// Signals each local call, then waits for leave to answer.
    gate: Option<(Sender<usize>, Receiver<()>)>,
  }

  impl Transcribe for Fake {
    fn cloud(&mut self, samples: &[f32]) -> Option<String> {
      let name = name(samples);
      self.cloud_calls.push(name);
      (!self.cloud_fails.contains(&name)).then(|| format!("cloud{name}"))
    }

    fn local(&mut self, samples: &[f32]) -> Option<String> {
      let name = name(samples);
      self.local_calls.push(name);
      if let Some((started, leave)) = &self.gate {
        started.send(name).unwrap();
        leave.recv().unwrap();
      }
      (!self.local_fails.contains(&name)).then(|| format!("local{name}"))
    }
  }

  fn run(
    fake: Fake,
    destination: Destination,
    installed: bool,
    count: usize,
  ) -> (Result<String, Failure>, Fake) {
    let mut transcription = Transcription::new(fake, destination, installed);
    for index in 0..count {
      transcription.add(index, stretch(index + 1));
    }
    transcription.finish()
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
    let (result, fake) = run(Fake::default(), Destination::Cloud, true, 3);
    assert_eq!(result, Ok("cloud1 cloud2 cloud3".to_string()));
    assert!(fake.local_calls.is_empty());
  }

  #[test]
  fn a_stella_ai_failure_transcribes_the_whole_dictation_on_this_computer() {
    let fake = Fake {
      cloud_fails: vec![3],
      ..Fake::default()
    };
    let (result, fake) = run(fake, Destination::Cloud, true, 5);
    // Every stretch, the ones stella AI answered included, comes from this
    // computer, and nothing after the failure goes to stella AI.
    assert_eq!(result, Ok("local1 local2 local3 local4 local5".to_string()));
    assert_eq!(fake.cloud_calls, vec![1, 2, 3]);
    assert_eq!(fake.local_calls, vec![1, 2, 3, 4, 5]);
  }

  #[test]
  fn a_stella_ai_failure_without_the_model_fails_the_dictation() {
    let fake = Fake {
      cloud_fails: vec![2],
      ..Fake::default()
    };
    let (result, fake) = run(fake, Destination::Cloud, false, 4);
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
    let (result, fake) = run(fake, Destination::Cloud, true, 3);
    assert_eq!(result, Err(Failure::CloudTranscription));
    assert_eq!(fake.local_calls, vec![1]);
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
    unbacked.add(0, stretch(1));
    assert_eq!(unbacked.kept_samples(), 0);
    let fake = Fake {
      cloud_fails: vec![3],
      ..Fake::default()
    };
    let mut backed = Transcription::new(fake, Destination::Cloud, true);
    backed.add(0, stretch(1));
    backed.add(1, stretch(2));
    assert_eq!(backed.kept_samples(), 2 * SECOND);
    // Once this computer has redone them, nothing is held any more.
    backed.add(2, stretch(3));
    assert_eq!(backed.kept_samples(), 0);
    backed.add(3, stretch(4));
    assert_eq!(backed.kept_samples(), 0);
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
    live.send(vec![0.3; 48_000]);
    let (ended, lengths) = live.finish().unwrap();
    assert_eq!(ended, Ended::Text(String::new()));
    assert_eq!(lengths.0, vec![SECOND]);
  }
}
