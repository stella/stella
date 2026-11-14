//! One thread owns a dictation from key press to inserted text. While the
//! key is down it hands every stretch of speech to a background thread that
//! transcribes it at once; on release it waits for the last stretch, cleans
//! up the joined text once and types it. Commands wait in a channel
//! meanwhile, so two dictations never overlap.

use std::{
  io::{self, BufReader},
  path::{Path, PathBuf},
  process::{Child, ChildStdin, ChildStdout, Command as Process, Stdio},
  sync::{
    Arc, Mutex, MutexGuard,
    mpsc::{self, Receiver, RecvTimeoutError, Sender},
  },
  thread::{self, JoinHandle},
  time::Duration,
};

use cpal::{
  FromSample, SampleFormat, SizedSample,
  traits::{DeviceTrait, HostTrait, StreamTrait},
};
use tauri::AppHandle;

use crate::{
  clipboard,
  dictation::{self, Command, Failed, Failure, Phase, SpeakerLanguage},
  dictation_audio::to_mono,
  dictation_cleanup,
  dictation_cloud::{self, CloudSession, Destination},
  dictation_context::{self, CleanupContext},
  dictation_focus::{self, FocusTarget, Insertion},
  dictation_format::{AppClass, Segment},
  dictation_input,
  dictation_live::{Ended, Live, Transcribe, Transcription},
  dictation_pauses::Segmenter,
  dictation_worker::{self, Response},
};

/// A warm model answers at once but holds about a gigabyte of memory.
const WORKER_IDLE: Duration = Duration::from_secs(300);
/// How often captured audio is checked for a pause while the key is down.
const LISTEN: Duration = Duration::from_millis(100);
const MAX_RECORDING_SECONDS: usize = 600;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// The speaker waits on every request, so a busy machine must not starve it.
#[cfg(target_os = "windows")]
const ABOVE_NORMAL_PRIORITY_CLASS: u32 = 0x0000_8000;

pub fn spawn(app: AppHandle) -> Option<Sender<Command>> {
  let (sender, receiver) = mpsc::channel();
  match thread::Builder::new()
    .name("dictation".to_string())
    .spawn(move || run(&app, &receiver))
  {
    Ok(_) => Some(sender),
    Err(error) => {
      tracing::warn!(%error, "dictation thread failed to start");
      None
    }
  }
}

fn run(app: &AppHandle, commands: &Receiver<Command>) {
  let mut worker = None;
  let mut active: Option<(Capture, Option<FocusTarget>, CleanupContext)> = None;
  loop {
    let wait = if active.is_some() {
      LISTEN
    } else {
      WORKER_IDLE
    };
    match commands.recv_timeout(wait) {
      Ok(Command::Press) if active.is_none() => {
        dictation::clear_failure(app);
        match begin(app, &mut worker) {
          Ok(started) => {
            dictation::set_phase(app, Phase::Recording);
            // Read once recording runs, so the lookups never delay capture;
            // the context is where the speaker pressed the shortcut.
            let focus = dictation_focus::current(app);
            let context =
              dictation_context::read(focus.as_ref(), dictation::context_sharing(app));
            active = Some((started, focus, context));
          }
          Err(failure) => dictation::report_failure(app, failure),
        }
      }
      Ok(Command::Press) => {
        if let Some((capture, ..)) = active.as_mut() {
          capture.listen();
        }
      }
      Ok(Command::Release) => {
        if let Some((capture, focus, context)) = active.take() {
          dictation::set_phase(app, Phase::Transcribing);
          if let Err(failed) =
            finish(app, capture, focus.as_ref(), &context, &mut worker)
          {
            dictation::report_failure(app, failed);
          }
          dictation::set_phase(app, Phase::Idle);
        }
      }
      Err(RecvTimeoutError::Timeout) => match active.as_mut() {
        Some((capture, ..)) => capture.listen(),
        None => worker = None,
      },
      Err(RecvTimeoutError::Disconnected) => break,
    }
  }
  // Dictation was turned off with the key still down: nothing is kept.
  if let Some((capture, ..)) = active {
    capture.cancel(&mut worker);
    dictation::set_phase(app, Phase::Idle);
  }
}

/// A dictation while the key is down: audio arrives, and every stretch of
/// speech it completes goes to the background to be transcribed.
struct Capture {
  recorder: Recorder,
  segmenter: Segmenter,
  live: Live<Engines>,
  language: SpeakerLanguage,
}

impl Capture {
  fn listen(&mut self) {
    let mono = to_mono(&self.recorder.take(), self.recorder.channels);
    for stretch in self.segmenter.push(&mono) {
      self.live.send(stretch);
    }
  }

  /// Discards the dictation, texts in progress included; the worker stays
  /// warm.
  fn cancel(self, worker: &mut Option<Worker>) {
    drop(self.recorder);
    discard(self.live, worker);
  }
}

fn begin(app: &AppHandle, worker: &mut Option<Worker>) -> Result<Capture, Failure> {
  // stella AI transcribes without the speech model on this computer.
  let (destination, cloud_model) = dictation::destination(app);
  let model = dictation::installed_model();
  if destination == Destination::Local && model.is_none() {
    return Err(Failure::ModelMissing);
  }
  if !dictation_input::request_access() {
    return Err(Failure::Accessibility);
  }
  let recorder = Recorder::start().ok_or(Failure::Microphone)?;
  let language = dictation::language(app);
  let local_installed = model.is_some();
  let engines = Engines {
    cloud: CloudSession::new(app.clone(), cloud_model, language.hint),
    worker: worker.take(),
    model,
    language: language.hint,
  };
  let transcription = Transcription::new(engines, destination, local_installed);
  let live =
    Live::start(transcription, recorder.rate, Arc::default()).map_err(|error| {
      tracing::warn!(%error, "dictation transcription failed to start");
      dictation_cloud::failure(destination, local_installed)
    })?;
  Ok(Capture {
    segmenter: Segmenter::new(recorder.rate),
    recorder,
    live,
    language,
  })
}

fn finish(
  app: &AppHandle,
  capture: Capture,
  focus: Option<&FocusTarget>,
  context: &CleanupContext,
  worker: &mut Option<Worker>,
) -> Result<(), Failed> {
  let Capture {
    recorder,
    mut segmenter,
    mut live,
    language,
  } = capture;
  let channels = recorder.channels;
  let Some(last) = recorder.finish() else {
    discard(live, worker);
    return Err(Failure::Microphone.into());
  };
  for stretch in segmenter.push(&to_mono(&last, channels)) {
    live.send(stretch);
  }
  let rest = segmenter.finish();
  // A denied microphone delivers exact zeros rather than an error.
  if !rest.signal {
    discard(live, worker);
    return Err(Failure::Microphone.into());
  }
  live.send(rest.samples);
  let (ended, engines) = live.finish().ok_or(Failure::Transcription)?;
  *worker = engines.worker;
  let text = match ended {
    Ended::Text(text) => text,
    Ended::Failed(failure) => return Err(failure.into()),
    Ended::Cancelled => return Ok(()),
  };
  let text = text.trim();
  if text.is_empty() {
    return Ok(());
  }
  let cleaned = dictation::cleanup_enabled(app)
    .then(|| dictation_cleanup::clean_up(app, text, &language.speaker, context))
    .flatten();
  let identifier = focus.and_then(|target| target.identifier.as_deref());
  // Kept before typing, so a dictation that cannot be typed is not lost.
  let kept_in_history = clipboard::keep_dictation(
    app,
    &dictation_cleanup::typed_text(text, cleaned.as_deref()),
    identifier,
  );
  type_into_focus(app, text, cleaned.as_deref(), focus).map_err(|failure| Failed {
    failure,
    kept_in_history,
  })
}

/// Drops a dictation's transcription and keeps its worker.
fn discard(live: Live<Engines>, worker: &mut Option<Worker>) {
  if let Some(engines) = live.cancel() {
    *worker = engines.worker;
  }
}

fn type_into_focus(
  app: &AppHandle,
  text: &str,
  cleaned: Option<&[Segment]>,
  focus: Option<&FocusTarget>,
) -> Result<(), Failure> {
  // A modifier still held down would turn typed text into shortcuts.
  if !dictation_input::wait_for_released_modifiers() {
    return Err(Failure::ShortcutHeld);
  }
  // Transcription and cleanup take a moment; text goes only to the app the
  // speaker pressed the shortcut in.
  match dictation_focus::insertion(focus, dictation_focus::current(app).as_ref()) {
    Insertion::Allowed => {}
    Insertion::FocusMoved => return Err(Failure::FocusChanged),
    Insertion::FocusUnconfirmed => return Err(Failure::FocusUnconfirmed),
  }
  let class = AppClass::of(focus.and_then(|target| target.identifier.as_deref()));
  dictation_input::send(&dictation_cleanup::strokes(text, cleaned, class))
    .map_err(|_typing| Failure::Accessibility)
}

/// How one stretch becomes text: stella AI for this dictation, or the
/// speech model on this computer through the worker, which stays warm from
/// one dictation to the next.
struct Engines {
  cloud: CloudSession,
  worker: Option<Worker>,
  model: Option<PathBuf>,
  language: Option<&'static str>,
}

impl Transcribe for Engines {
  fn cloud(&mut self, samples: &[f32]) -> Option<String> {
    self
      .cloud
      .transcribe(samples)
      .inspect_err(|error| {
        tracing::info!(%error, "stella AI transcription failed");
      })
      .ok()
  }

  fn local(&mut self, samples: &[f32]) -> Option<String> {
    let model = self.model.as_deref()?;
    transcribe(&mut self.worker, model, samples, self.language)
  }
}

fn transcribe(
  worker: &mut Option<Worker>,
  model: &Path,
  samples: &[f32],
  language: Option<&str>,
) -> Option<String> {
  if worker.is_none() {
    *worker = match Worker::start() {
      Ok(started) => Some(started),
      Err(error) => {
        tracing::warn!(%error, "dictation worker failed to start");
        None
      }
    };
  }
  match worker.as_mut()?.transcribe(model, samples, language) {
    Ok(Response::Text(text)) => Some(text),
    Ok(Response::Failed) => None,
    Err(error) => {
      tracing::warn!(%error, "dictation worker stopped");
      *worker = None;
      None
    }
  }
}

struct Worker {
  child: Child,
  stdin: ChildStdin,
  stdout: BufReader<ChildStdout>,
  backend_logged: bool,
}

impl Worker {
  fn start() -> io::Result<Self> {
    let mut process = Process::new(std::env::current_exe()?);
    process
      .arg(dictation_worker::WORKER_ARG)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::null());
    // A console window must not flash up for a background process.
    #[cfg(target_os = "windows")]
    std::os::windows::process::CommandExt::creation_flags(
      &mut process,
      CREATE_NO_WINDOW | ABOVE_NORMAL_PRIORITY_CLASS,
    );
    let mut child = process.spawn()?;
    let stdin = child.stdin.take().ok_or(io::ErrorKind::BrokenPipe)?;
    let stdout = child.stdout.take().ok_or(io::ErrorKind::BrokenPipe)?;
    Ok(Self {
      child,
      stdin,
      stdout: BufReader::new(stdout),
      backend_logged: false,
    })
  }

  fn transcribe(
    &mut self,
    model: &Path,
    samples: &[f32],
    language: Option<&str>,
  ) -> io::Result<Response> {
    dictation_worker::write_request(&mut self.stdin, model, samples, language)?;
    let reply = dictation_worker::read_response(&mut self.stdout)?;
    // Once per worker: which compute backend the model resolved to.
    if !self.backend_logged
      && let Some(backend) = reply.backend.as_deref()
    {
      self.backend_logged = true;
      tracing::info!(
        target: crate::logging::TRAIL_TARGET,
        event = "dictation.worker_backend",
        code = backend
      );
    }
    Ok(reply.response)
  }
}

impl Drop for Worker {
  fn drop(&mut self) {
    if let Err(error) = self.child.kill() {
      tracing::debug!(%error, "dictation worker already gone");
    }
    if let Err(error) = self.child.wait() {
      tracing::debug!(%error, "dictation worker could not be reaped");
    }
  }
}

/// Audio the stream delivered and not yet taken, and how much was taken
/// before it.
#[derive(Default)]
struct Tape {
  samples: Vec<f32>,
  taken: usize,
}

type Shared = Arc<Mutex<Tape>>;

fn lock(tape: &Shared) -> MutexGuard<'_, Tape> {
  tape.lock().unwrap_or_else(|error| error.into_inner())
}

/// The whole frames on `tape`, taken off it; a frame torn by the stream
/// waits for the rest of its channels.
fn take_frames(tape: &mut Tape, channels: usize) -> Vec<f32> {
  let whole = tape.samples.len() - tape.samples.len() % channels.max(1);
  tape.taken += whole;
  tape.samples.drain(..whole).collect()
}

/// The audio stream is tied to the thread that built it, so a thread holds it
/// for exactly as long as the key is down, while the dictation thread takes
/// its audio as it arrives.
struct Recorder {
  stop: Sender<()>,
  thread: JoinHandle<()>,
  tape: Shared,
  channels: usize,
  rate: u32,
}

impl Recorder {
  fn start() -> Option<Self> {
    let (stop, stopped) = mpsc::channel();
    let (ready, started) = mpsc::channel();
    let thread = thread::Builder::new()
      .name("dictation-capture".to_string())
      .spawn(move || capture(&ready, &stopped))
      .ok()?;
    let (tape, channels, rate) = started.recv().ok().flatten()?;
    Some(Self {
      stop,
      thread,
      tape,
      channels,
      rate,
    })
  }

  /// The audio captured since the last take, in whole frames.
  fn take(&self) -> Vec<f32> {
    take_frames(&mut lock(&self.tape), self.channels)
  }

  /// Stops the stream and takes the last of its audio; `None` when capture
  /// did not survive.
  fn finish(self) -> Option<Vec<f32>> {
    let Self {
      stop,
      thread,
      tape,
      channels,
      ..
    } = self;
    drop(stop);
    if thread.join().is_err() {
      return None;
    }
    Some(take_frames(&mut lock(&tape), channels))
  }
}

/// What the capture thread hands over once its stream plays.
type Opened = (Shared, usize, u32);

fn capture(ready: &Sender<Option<Opened>>, stopped: &Receiver<()>) {
  let opened = open_stream().filter(|(stream, ..)| stream.play().is_ok());
  let handed = opened
    .as_ref()
    .map(|(_, tape, channels, rate)| (Arc::clone(tape), *channels, *rate));
  if ready.send(handed).is_err() {
    return;
  }
  let Some((stream, ..)) = opened else {
    return;
  };
  // Ends when `Recorder::finish` drops the sender, or the recorder is gone.
  while stopped.recv().is_ok() {}
  drop(stream);
}

fn open_stream() -> Option<(cpal::Stream, Shared, usize, u32)> {
  let device = cpal::default_host().default_input_device()?;
  let config = device.default_input_config().ok()?;
  let channels = usize::from(config.channels());
  let rate = config.sample_rate();
  let limit = MAX_RECORDING_SECONDS * rate as usize * channels;
  let tape = Shared::default();
  let stream_config = config.config();
  let stream = match config.sample_format() {
    SampleFormat::F32 => build::<f32>(&device, &stream_config, &tape, limit),
    SampleFormat::I16 => build::<i16>(&device, &stream_config, &tape, limit),
    SampleFormat::I32 => build::<i32>(&device, &stream_config, &tape, limit),
    SampleFormat::U16 => build::<u16>(&device, &stream_config, &tape, limit),
    _ => None,
  }?;
  Some((stream, tape, channels, rate))
}

fn build<T>(
  device: &cpal::Device,
  config: &cpal::StreamConfig,
  tape: &Shared,
  limit: usize,
) -> Option<cpal::Stream>
where
  T: SizedSample,
  f32: FromSample<T>,
{
  let sink = Arc::clone(tape);
  device
    .build_input_stream(
      *config,
      move |data: &[T], _info: &cpal::InputCallbackInfo| {
        let mut tape = lock(&sink);
        // The limit counts everything recorded, taken or not.
        let room = limit.saturating_sub(tape.taken + tape.samples.len());
        tape.samples.extend(
          data
            .iter()
            .take(room)
            .map(|sample| sample.to_sample::<f32>()),
        );
      },
      |error| tracing::warn!(%error, "dictation audio stream failed"),
      None,
    )
    .ok()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_whole_frames_are_taken_and_the_rest_waits() {
    let mut tape = Tape {
      samples: vec![0.1, 0.2, 0.3, 0.4, 0.5],
      taken: 0,
    };
    assert_eq!(take_frames(&mut tape, 2), vec![0.1, 0.2, 0.3, 0.4]);
    assert_eq!(tape.samples, vec![0.5]);
    tape.samples.push(0.6);
    assert_eq!(take_frames(&mut tape, 2), vec![0.5, 0.6]);
    assert!(tape.samples.is_empty());
    // Taken audio still counts toward the recording limit.
    assert_eq!(tape.taken, 6);
  }
}
