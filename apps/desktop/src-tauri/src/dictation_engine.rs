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
  dictation_hold_key::HoldChoice,
  dictation_input,
  dictation_live::{Ended, Live, Transcribe, Transcription},
  dictation_microphone::{self, Choice, InputDevice},
  dictation_pauses::Segmenter,
  dictation_preview, dictation_spelling,
  dictation_trace::{self, Cleanup, GlobeKey, Line, Outcome, Trace},
  dictation_worker::{self, Response},
};

/// A warm model answers at once but holds about a gigabyte of memory.
const WORKER_IDLE: Duration = Duration::from_secs(300);
/// How often captured audio is checked for a pause while the key is down.
const LISTEN: Duration = Duration::from_millis(100);
const MAX_RECORDING_SECONDS: usize = 600;
/// A shorter hold that heard nothing is a tap, not a dictation that failed.
const MIN_NOTICED_HOLD: Duration = Duration::from_millis(500);
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

/// A dictation while its key is down.
struct Active {
  capture: Capture,
  focus: Option<FocusTarget>,
  context: CleanupContext,
  trace: Trace,
  /// How often the panel checks for a password field between results.
  password_watch: dictation_preview::PasswordWatch,
}

/// What a dictation that did not fail came to.
enum Delivered {
  Typed,
  /// No words to type.
  Empty,
  Cancelled,
}

fn run(app: &AppHandle, commands: &Receiver<Command>) {
  let mut worker = None;
  let mut active: Option<Active> = None;
  loop {
    let wait = if active.is_some() {
      LISTEN
    } else {
      WORKER_IDLE
    };
    match commands.recv_timeout(wait) {
      Ok(Command::Press) if active.is_none() => {
        let trace = Trace::pressed();
        dictation::clear_failure(app);
        // The microphone belongs to the dictation, not to a test of it.
        dictation_microphone::stop_test(app);
        // Read before capture starts: the microphone never opens for a
        // password field that already has focus.
        let focus = dictation_focus::current(app);
        if dictation_focus::in_password_field(focus.as_ref()) {
          dictation::report_failure(app, Failure::PasswordField);
          end(
            app,
            &trace,
            Outcome::Failed(Failure::PasswordField.into()),
            None,
          );
        } else {
          let model = dictation::start_recording(app);
          dictation_preview::start(app);
          match begin(app, model, focus.as_ref(), &mut worker) {
            Ok(capture) => {
              // Read once recording runs, so it never delays capture; the
              // context is where the speaker pressed the shortcut.
              let context = dictation_context::read(
                focus.as_ref(),
                dictation::context_sharing(app),
              );
              active = Some(Active {
                capture,
                focus,
                context,
                trace,
                password_watch: dictation_preview::PasswordWatch::default(),
              });
            }
            Err(failure) => {
              let device = (failure == Failure::Microphone)
                .then(|| default_input().map(|device| device.name))
                .flatten();
              dictation::report_input_failure(app, failure, device);
              dictation::set_phase(app, Phase::Idle);
              end(app, &trace, Outcome::Failed(failure.into()), None);
            }
          }
        }
      }
      Ok(Command::Press) => {
        if let Some(active) = active.as_mut() {
          active.capture.listen();
        }
      }
      Ok(Command::Cancel) => {
        // A tap or a shortcut on the hold key: nothing is transcribed.
        if let Some(active) = active.take() {
          cancel(app, active, &mut worker);
        }
      }
      Ok(Command::Release) => {
        if let Some(Active {
          capture,
          focus,
          context,
          mut trace,
          ..
        }) = active.take()
        {
          dictation::set_phase(app, Phase::Transcribing);
          trace.release();
          dictation_preview::release(app);
          let device = capture.recorder.device.clone();
          let mut moved = None;
          let outcome = match finish(
            app,
            capture,
            focus.as_ref(),
            &context,
            &mut worker,
            &trace,
            &mut moved,
          ) {
            Ok(Delivered::Typed) => Outcome::Typed,
            Ok(Delivered::Empty) => Outcome::Empty,
            Ok(Delivered::Cancelled) => Outcome::Cancelled,
            Err(failed) => {
              dictation::report_input_failure(app, failed, device);
              Outcome::Failed(failed)
            }
          };
          dictation::set_phase(app, Phase::Idle);
          end(app, &trace, outcome, moved);
        }
      }
      Err(RecvTimeoutError::Timeout) => match active.as_mut() {
        Some(active) => {
          active.capture.listen();
          // Between transcription results too: a password field that takes
          // focus while the panel shows hides it at once.
          if active.password_watch.due(dictation_preview::showing(app))
            && focused_on_password(app, active.focus.as_ref())
          {
            dictation_preview::block(app);
          }
        }
        None => worker = None,
      },
      Err(RecvTimeoutError::Disconnected) => break,
    }
  }
  // Dictation was turned off with the key still down: nothing is kept.
  if let Some(active) = active {
    cancel(app, active, &mut worker);
  }
}

/// Logs the hold: how long, how much audio, how many stretches were cut
/// while the key was down, and on fn what the system itself does with that
/// key.
fn log_hold(
  app: &AppHandle,
  held: Duration,
  frames: usize,
  rate: u32,
  stretches: usize,
) {
  let globe_key = (dictation::hold_key(app) == HoldChoice::Fn).then(globe_key);
  Line::Hold {
    duration: held,
    audio: Duration::from_secs_f64(frames as f64 / f64::from(rate.max(1))),
    stretches,
    globe_key,
  }
  .log();
}

/// Discards a dictation in progress and logs it as cancelled.
fn cancel(app: &AppHandle, active: Active, worker: &mut Option<Worker>) {
  let Active {
    capture, mut trace, ..
  } = active;
  let held = trace.release();
  let frames = capture.recorded + capture.recorder.waiting_frames();
  log_hold(
    app,
    held,
    frames,
    capture.recorder.rate,
    capture.live.sent(),
  );
  capture.cancel(worker);
  dictation::set_phase(app, Phase::Idle);
  end(app, &trace, Outcome::Cancelled, None);
}

/// Logs how the dictation ended; whatever the end, the preview goes.
fn end(
  app: &AppHandle,
  trace: &Trace,
  outcome: Outcome,
  moved: Option<dictation_focus::Moved>,
) {
  dictation_preview::end(app);
  Line::End {
    duration: trace.since_press(),
    outcome,
    moved,
  }
  .log();
}

/// A dictation while the key is down: audio arrives, and every stretch of
/// speech it completes goes to the background to be transcribed.
struct Capture {
  recorder: Recorder,
  segmenter: Segmenter,
  live: Live<Engines>,
  language: SpeakerLanguage,
  /// Mono samples taken so far, for the local log.
  recorded: usize,
}

impl Capture {
  fn listen(&mut self) {
    let mono = to_mono(&self.recorder.take(), self.recorder.channels);
    self.recorded += mono.len();
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

fn begin(
  app: &AppHandle,
  model: Option<PathBuf>,
  focus: Option<&FocusTarget>,
  worker: &mut Option<Worker>,
) -> Result<Capture, Failure> {
  // stella AI transcribes without the speech model on this computer.
  let (destination, cloud_model) = dictation::destination(app);
  if destination == Destination::Local && model.is_none() {
    return Err(Failure::ModelMissing);
  }
  if !dictation_input::request_access() {
    return Err(Failure::Accessibility);
  }
  let recorder =
    Recorder::start(dictation::microphone_choice()).ok_or(Failure::Microphone)?;
  if let Some(chosen) = &recorder.missing {
    dictation::report_missing_microphone(app, chosen, recorder.device.clone());
  }
  let language = dictation::language(app);
  let local_installed = model.is_some();
  let mut cloud = CloudSession::new(
    app.clone(),
    cloud_model,
    language.hint,
    crate::dictation_words::words(app),
  );
  if destination == Destination::Cloud {
    // Beside recording, so no request waits for the list after the release.
    cloud.look_up_models();
  }
  let engines = Engines {
    cloud,
    worker: worker.take(),
    model,
    language: language.hint,
    destination,
    preview: PreviewFeed {
      app: app.clone(),
      focus: focus.cloned(),
    },
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
    recorded: 0,
  })
}

#[cfg(target_os = "macos")]
fn globe_key() -> GlobeKey {
  stella_desktop_macos::globe_key_usage().map_or(GlobeKey::Unset, GlobeKey::Value)
}

#[cfg(not(target_os = "macos"))]
const fn globe_key() -> GlobeKey {
  GlobeKey::Unset
}

fn finish(
  app: &AppHandle,
  capture: Capture,
  focus: Option<&FocusTarget>,
  context: &CleanupContext,
  worker: &mut Option<Worker>,
  trace: &Trace,
  moved: &mut Option<dictation_focus::Moved>,
) -> Result<Delivered, Failed> {
  let Capture {
    recorder,
    mut segmenter,
    mut live,
    language,
    recorded,
  } = capture;
  let channels = recorder.channels;
  let rate = recorder.rate;
  let stretches = live.sent();
  let held = trace.held();
  let Some(last) = recorder.finish() else {
    log_hold(app, held, recorded, rate, stretches);
    discard(live, worker);
    return Err(Failure::Microphone.into());
  };
  // Counted once the stream stopped, so the last frames it delivered count.
  log_hold(
    app,
    held,
    recorded + last.len() / channels.max(1),
    rate,
    stretches,
  );
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
  let (ended, engines, tally) = live.finish_tallied().ok_or(Failure::Transcription)?;
  // Some stretches went to the speech model on this computer, which takes
  // no custom words.
  let transcribed_here = engines.destination == Destination::Local || tally.fell_back;
  Line::Transcribe {
    duration: trace.since_release(),
    destination: engines.destination,
    model: if engines.destination == Destination::Cloud && !tally.fell_back {
      engines.cloud.model_id().map(str::to_string)
    } else {
      Some(dictation::local_model_id().to_string())
    },
    model_list: engines.cloud.list_read(),
    tally,
  }
  .log();
  *worker = engines.worker;
  let text = match ended {
    Ended::Text(text) => text,
    Ended::Failed(failure) => return Err(failure.into()),
    Ended::Cancelled => return Ok(Delivered::Cancelled),
  };
  let text = text.trim();
  if text.is_empty() {
    // A hold that heard nothing is told unless it was a tap.
    return heard_nothing(held).map(|()| Delivered::Empty);
  }
  let cleanup_enabled = dictation::cleanup_enabled(app);
  // Cleanup spells the custom words itself; without it, the words the speech
  // model here missed are spelled on this computer.
  let respelled;
  let text = if transcribed_here && !cleanup_enabled {
    respelled = dictation_spelling::respell(text, &crate::dictation_words::words(app));
    respelled.as_str()
  } else {
    text
  };
  let ((cleaned, cleanup), cleanup_took) = dictation_trace::timed(|| {
    if cleanup_enabled {
      let words = crate::dictation_words::words(app);
      dictation_cleanup::clean_up(app, text, &language.speaker, &words, context)
    } else {
      (None, Cleanup::Off)
    }
  });
  Line::Cleanup {
    duration: cleanup_took,
    cleanup,
  }
  .log();
  let (delivered, insert_took) =
    dictation_trace::timed(|| deliver(app, text, cleaned.as_deref(), focus, moved));
  let (result, focus_read, kept_in_history) = delivered;
  Line::Insert {
    duration: insert_took,
    focus_read,
    kept_in_history,
  }
  .log();
  result.map(|()| Delivered::Typed)
}

/// Keeps the text and types it: what came of it, how long the focus read
/// before typing took, and whether the text is in clipboard history.
fn deliver(
  app: &AppHandle,
  text: &str,
  cleaned: Option<&[Segment]>,
  focus: Option<&FocusTarget>,
  moved: &mut Option<dictation_focus::Moved>,
) -> (Result<(), Failed>, Option<Duration>, bool) {
  // Focus may have moved to a password field meanwhile: such text is
  // neither kept nor typed.
  if dictation_focus::in_password_field(dictation_focus::current(app).as_ref()) {
    return (Err(Failure::PasswordField.into()), None, false);
  }
  let identifier = focus.and_then(|target| target.identifier.as_deref());
  // Kept before typing, so a dictation that cannot be typed is not lost.
  let kept_in_history = clipboard::keep_dictation(
    app,
    &dictation_cleanup::typed_text(text, cleaned),
    identifier,
  );
  let mut focus_read = None;
  let typed = type_into_focus(app, text, cleaned, focus, &mut focus_read, moved);
  let result = typed.map_err(|failure| Failed {
    failure,
    kept_in_history,
  });
  (result, focus_read, kept_in_history)
}

/// A dictation that recorded sound and produced no words: a failure the
/// speaker is told about, unless the hold was a tap.
fn heard_nothing(held: Duration) -> Result<(), Failed> {
  if held < MIN_NOTICED_HOLD {
    Ok(())
  } else {
    Err(Failure::NothingHeard.into())
  }
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
  focus_read: &mut Option<Duration>,
  moved: &mut Option<dictation_focus::Moved>,
) -> Result<(), Failure> {
  // A modifier still held down would turn typed text into shortcuts.
  if !dictation_input::wait_for_released_modifiers() {
    return Err(Failure::ShortcutHeld);
  }
  // The wait above can let a password field take focus in the same window,
  // so the field is checked again just before anything is typed.
  let (current, read) = dictation_trace::timed(|| dictation_focus::current(app));
  *focus_read = Some(read);
  if dictation_focus::in_password_field(current.as_ref()) {
    return Err(Failure::PasswordField);
  }
  if let (Some(pressed), Some(now)) = (focus, current.as_ref()) {
    *moved = dictation_focus::moved(pressed, now);
  }
  // Transcription and cleanup take a moment; text goes only to the app the
  // speaker pressed the shortcut in.
  match dictation_focus::insertion(focus, current.as_ref()) {
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
  /// Where the speaker chose to transcribe, for the local log.
  destination: Destination,
  preview: PreviewFeed,
}

/// Where the text so far goes while the key is down.
struct PreviewFeed {
  app: AppHandle,
  /// The app the speaker pressed in: while its focused field is a password
  /// field, nothing is shown.
  focus: Option<FocusTarget>,
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

  fn preview(&mut self, text: &str) {
    let PreviewFeed { app, focus } = &self.preview;
    if !text.is_empty() && focused_on_password(app, focus.as_ref()) {
      dictation_preview::block(app);
    } else {
      dictation_preview::text(app, text);
    }
  }
}

/// Whether a password field has focus now, wherever focus went since the
/// press. When focus cannot be read now, the app pressed in is asked
/// instead: the panel is hidden whenever either says so, and shown only
/// when neither can tell, as typing is.
fn focused_on_password(app: &AppHandle, pressed: Option<&FocusTarget>) -> bool {
  let now = dictation_focus::current(app);
  dictation_focus::in_password_field(now.as_ref().or(pressed))
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
pub(crate) struct Recorder {
  stop: Sender<()>,
  thread: JoinHandle<()>,
  tape: Shared,
  pub(crate) channels: usize,
  rate: u32,
  /// The input device's name, as the OS shows it.
  pub(crate) device: Option<String>,
  /// The chosen microphone's name when it was not connected and the system
  /// default records instead.
  missing: Option<String>,
}

impl Recorder {
  /// Opens `choice`, or the system default without one or while it is not
  /// connected.
  pub(crate) fn start(choice: Option<Choice>) -> Option<Self> {
    let (stop, stopped) = mpsc::channel();
    let (ready, started) = mpsc::channel();
    let thread = thread::Builder::new()
      .name("dictation-capture".to_string())
      .spawn(move || capture(choice.as_ref(), &ready, &stopped))
      .ok()?;
    let Opened {
      tape,
      channels,
      rate,
      device,
      missing,
    } = started.recv().ok().flatten()?;
    Some(Self {
      stop,
      thread,
      tape,
      channels,
      rate,
      device,
      missing,
    })
  }

  /// The audio captured since the last take, in whole frames.
  pub(crate) fn take(&self) -> Vec<f32> {
    take_frames(&mut lock(&self.tape), self.channels)
  }

  /// Whole frames captured and not taken yet, left on the tape.
  fn waiting_frames(&self) -> usize {
    lock(&self.tape).samples.len() / self.channels.max(1)
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
struct Opened {
  tape: Shared,
  channels: usize,
  rate: u32,
  device: Option<String>,
  missing: Option<String>,
}

fn capture(
  choice: Option<&Choice>,
  ready: &Sender<Option<Opened>>,
  stopped: &Receiver<()>,
) {
  let opened = open_stream(choice).filter(|(stream, _)| stream.play().is_ok());
  let handed = opened.as_ref().map(|(_, opened)| Opened {
    tape: Arc::clone(&opened.tape),
    channels: opened.channels,
    rate: opened.rate,
    device: opened.device.clone(),
    missing: opened.missing.clone(),
  });
  if ready.send(handed).is_err() {
    return;
  }
  let Some((stream, _)) = opened else {
    return;
  };
  // Ends when `Recorder::finish` drops the sender, or the recorder is gone.
  while stopped.recv().is_ok() {}
  drop(stream);
}

/// An input device as Settings lists it; `None` without a stable id.
fn listed(device: &cpal::Device) -> Option<InputDevice> {
  let id = device.id().ok()?.to_string();
  let description = device.description().ok();
  Some(InputDevice {
    name: description
      .as_ref()
      .map_or_else(|| id.clone(), |description| description.name().to_string()),
    bluetooth: description.is_some_and(|description| {
      description.interface_type() == cpal::InterfaceType::Bluetooth
    }),
    id,
  })
}

/// Every input device, in the order the OS lists them.
pub(crate) fn input_devices() -> Vec<InputDevice> {
  let Ok(devices) = cpal::default_host().input_devices() else {
    return Vec::new();
  };
  let mut listed_devices: Vec<InputDevice> = Vec::new();
  for device in devices.filter_map(|device| listed(&device)) {
    if !listed_devices.iter().any(|known| known.id == device.id) {
      listed_devices.push(device);
    }
  }
  listed_devices
}

/// The system default input device.
pub(crate) fn default_input() -> Option<InputDevice> {
  listed(&cpal::default_host().default_input_device()?)
}

/// The device `choice` names when it is connected, otherwise the system
/// default with the chosen name it stands in for.
fn pick_device(choice: Option<&Choice>) -> Option<(cpal::Device, Option<String>)> {
  let host = cpal::default_host();
  if let Some(choice) = choice {
    let chosen = choice
      .id
      .parse::<cpal::DeviceId>()
      .ok()
      .and_then(|id| host.device_by_id(&id));
    if let Some(device) = chosen {
      return Some((device, None));
    }
    return Some((host.default_input_device()?, Some(choice.name.clone())));
  }
  Some((host.default_input_device()?, None))
}

fn open_stream(choice: Option<&Choice>) -> Option<(cpal::Stream, Opened)> {
  let (device, missing) = pick_device(choice)?;
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
  let name = listed(&device).map(|device| device.name);
  Some((
    stream,
    Opened {
      tape,
      channels,
      rate,
      device: name,
      missing,
    },
  ))
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
  fn a_hold_that_heard_nothing_is_reported_unless_it_was_a_tap() {
    assert_eq!(heard_nothing(Duration::from_millis(200)), Ok(()));
    assert_eq!(
      heard_nothing(MIN_NOTICED_HOLD - Duration::from_millis(1)),
      Ok(())
    );
    assert_eq!(
      heard_nothing(MIN_NOTICED_HOLD),
      Err(Failure::NothingHeard.into())
    );
    // A headset still switching profile sends silence for a second or so.
    assert_eq!(
      heard_nothing(Duration::from_millis(1_500)),
      Err(Failure::NothingHeard.into())
    );
  }

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
