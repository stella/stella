//! One thread owns a dictation from key press to inserted text. Commands wait
//! in a channel while it transcribes and cleans up, so two dictations never
//! overlap.

use std::{
  io::{self, BufReader},
  path::Path,
  process::{Child, ChildStdin, ChildStdout, Command as Process, Stdio},
  sync::{
    Arc, Mutex,
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
  dictation::{self, Command, Failure, Phase},
  dictation_audio::{MODEL_SAMPLE_RATE, holds_speech, resample, to_mono},
  dictation_cleanup,
  dictation_focus::{self, FocusTarget, Insertion},
  dictation_format::AppClass,
  dictation_input,
  dictation_worker::{self, Response},
};

/// A warm model answers at once but holds about a gigabyte of memory.
const WORKER_IDLE: Duration = Duration::from_secs(300);
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
  let mut recorder = None;
  loop {
    match commands.recv_timeout(WORKER_IDLE) {
      Ok(Command::Press) if recorder.is_none() => {
        dictation::clear_failure(app);
        match begin() {
          Ok(started) => {
            dictation::set_phase(app, Phase::Recording);
            // Read once recording runs, so the lookup never delays capture.
            recorder = Some((started, dictation_focus::current(app)));
          }
          Err(failure) => dictation::report_failure(app, failure),
        }
      }
      Ok(Command::Press) => {}
      Ok(Command::Release) => {
        if let Some((active, focus)) = recorder.take() {
          dictation::set_phase(app, Phase::Transcribing);
          if let Err(failure) = finish(app, active, focus.as_ref(), &mut worker) {
            dictation::report_failure(app, failure);
          }
          dictation::set_phase(app, Phase::Idle);
        }
      }
      Err(RecvTimeoutError::Timeout) => worker = None,
      Err(RecvTimeoutError::Disconnected) => break,
    }
  }
  if recorder.is_some() {
    dictation::set_phase(app, Phase::Idle);
  }
}

fn begin() -> Result<Recorder, Failure> {
  if dictation::installed_model().is_none() {
    return Err(Failure::ModelMissing);
  }
  if !dictation_input::request_access() {
    return Err(Failure::Accessibility);
  }
  Recorder::start().ok_or(Failure::Microphone)
}

fn finish(
  app: &AppHandle,
  recorder: Recorder,
  focus: Option<&FocusTarget>,
  worker: &mut Option<Worker>,
) -> Result<(), Failure> {
  let captured = recorder.finish().ok_or(Failure::Microphone)?;
  // A denied microphone delivers exact zeros rather than an error.
  if captured.interleaved.iter().all(|sample| *sample == 0.0) {
    return Err(Failure::Microphone);
  }
  let mono = to_mono(&captured.interleaved, captured.channels);
  let samples = resample(&mono, captured.rate, MODEL_SAMPLE_RATE);
  if !holds_speech(&samples) {
    return Ok(());
  }
  let model = dictation::installed_model().ok_or(Failure::ModelMissing)?;
  let language = dictation::language(app);
  let text = transcribe(worker, &model, &samples, language.hint)
    .ok_or(Failure::Transcription)?;
  let text = text.trim();
  if text.is_empty() {
    return Ok(());
  }
  let cleaned = dictation::cleanup_enabled(app)
    .then(|| dictation_cleanup::clean_up(app, text, &language.speaker))
    .flatten();
  // Transcription and cleanup take a moment; text goes only to the app the
  // speaker pressed the shortcut in.
  if dictation_focus::insertion(focus, dictation_focus::current(app).as_ref())
    == Insertion::FocusMoved
  {
    return Err(Failure::FocusChanged);
  }
  let class = AppClass::of(focus.and_then(|target| target.identifier.as_deref()));
  dictation_input::send(&dictation_cleanup::strokes(text, cleaned.as_deref(), class))
    .map_err(|_typing| Failure::Accessibility)
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

struct Captured {
  interleaved: Vec<f32>,
  channels: usize,
  rate: u32,
}

/// The audio stream is tied to the thread that built it, so a thread holds it
/// for exactly as long as the key is down.
struct Recorder {
  stop: Sender<()>,
  thread: JoinHandle<Option<Captured>>,
}

impl Recorder {
  fn start() -> Option<Self> {
    let (stop, stopped) = mpsc::channel();
    let (ready, started) = mpsc::channel();
    let thread = thread::Builder::new()
      .name("dictation-capture".to_string())
      .spawn(move || capture(&ready, &stopped))
      .ok()?;
    if started.recv().unwrap_or(false) {
      Some(Self { stop, thread })
    } else {
      None
    }
  }

  fn finish(self) -> Option<Captured> {
    drop(self.stop);
    self.thread.join().ok().flatten()
  }
}

fn capture(ready: &Sender<bool>, stopped: &Receiver<()>) -> Option<Captured> {
  let opened = open_stream();
  let started = opened
    .as_ref()
    .is_some_and(|(stream, ..)| stream.play().is_ok());
  if ready.send(started).is_err() || !started {
    return None;
  }
  let (stream, buffer, channels, rate) = opened?;
  // Ends when `Recorder::finish` drops the sender.
  while stopped.recv().is_ok() {}
  drop(stream);
  let interleaved =
    std::mem::take(&mut *buffer.lock().unwrap_or_else(|error| error.into_inner()));
  Some(Captured {
    interleaved,
    channels,
    rate,
  })
}

type Buffer = Arc<Mutex<Vec<f32>>>;

fn open_stream() -> Option<(cpal::Stream, Buffer, usize, u32)> {
  let device = cpal::default_host().default_input_device()?;
  let config = device.default_input_config().ok()?;
  let channels = usize::from(config.channels());
  let rate = config.sample_rate();
  let limit = MAX_RECORDING_SECONDS * rate as usize * channels;
  let buffer = Buffer::default();
  let stream_config = config.config();
  let stream = match config.sample_format() {
    SampleFormat::F32 => build::<f32>(&device, &stream_config, &buffer, limit),
    SampleFormat::I16 => build::<i16>(&device, &stream_config, &buffer, limit),
    SampleFormat::I32 => build::<i32>(&device, &stream_config, &buffer, limit),
    SampleFormat::U16 => build::<u16>(&device, &stream_config, &buffer, limit),
    _ => None,
  }?;
  Some((stream, buffer, channels, rate))
}

fn build<T>(
  device: &cpal::Device,
  config: &cpal::StreamConfig,
  buffer: &Buffer,
  limit: usize,
) -> Option<cpal::Stream>
where
  T: SizedSample,
  f32: FromSample<T>,
{
  let sink = Arc::clone(buffer);
  device
    .build_input_stream(
      *config,
      move |data: &[T], _info: &cpal::InputCallbackInfo| {
        let mut samples = sink.lock().unwrap_or_else(|error| error.into_inner());
        let room = limit.saturating_sub(samples.len());
        samples.extend(
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
