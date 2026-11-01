//! One thread owns a dictation from key press to inserted text. Commands wait
//! in a channel while it transcribes, so two dictations never overlap.

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
  dictation_worker::{self, Response},
};

/// A warm model answers at once but holds about a gigabyte of memory.
const WORKER_IDLE: Duration = Duration::from_secs(300);
const MAX_RECORDING_SECONDS: usize = 600;

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
            recorder = Some(started);
            dictation::set_phase(app, Phase::Recording);
          }
          Err(failure) => dictation::report_failure(app, failure),
        }
      }
      Ok(Command::Press) => {}
      Ok(Command::Release) => {
        if let Some(active) = recorder.take() {
          dictation::set_phase(app, Phase::Transcribing);
          if let Err(failure) = finish(active, &mut worker) {
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
  if !stella_desktop_macos::accessibility_trusted() {
    stella_desktop_macos::request_accessibility_permission();
    return Err(Failure::Accessibility);
  }
  Recorder::start().ok_or(Failure::Microphone)
}

fn finish(recorder: Recorder, worker: &mut Option<Worker>) -> Result<(), Failure> {
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
  let text = transcribe(worker, &model, &samples).ok_or(Failure::Transcription)?;
  let text = text.trim();
  if text.is_empty() {
    return Ok(());
  }
  // The trailing space lets the next dictation continue the sentence.
  stella_desktop_macos::type_text(&format!("{text} "))
    .map_err(|_typing| Failure::Accessibility)
}

fn transcribe(
  worker: &mut Option<Worker>,
  model: &Path,
  samples: &[f32],
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
  match worker.as_mut()?.transcribe(model, samples) {
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
}

impl Worker {
  fn start() -> io::Result<Self> {
    let mut child = Process::new(std::env::current_exe()?)
      .arg(dictation_worker::WORKER_ARG)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .spawn()?;
    let stdin = child.stdin.take().ok_or(io::ErrorKind::BrokenPipe)?;
    let stdout = child.stdout.take().ok_or(io::ErrorKind::BrokenPipe)?;
    Ok(Self {
      child,
      stdin,
      stdout: BufReader::new(stdout),
    })
  }

  fn transcribe(&mut self, model: &Path, samples: &[f32]) -> io::Result<Response> {
    dictation_worker::write_request(&mut self.stdin, model, samples)?;
    dictation_worker::read_response(&mut self.stdout)
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
