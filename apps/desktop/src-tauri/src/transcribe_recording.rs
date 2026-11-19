//! Transcribes a recording the user chose: a dictaphone file, a voice memo,
//! a meeting recording or a video's sound. The file is read on this
//! computer, decoded to one channel and cut into pieces of under a minute at
//! the speaker's pauses; each piece is transcribed on this computer or, when
//! the user chose stella AI, by the model dictation uses, a few at a time.
//! The text of each piece reaches the window as soon as it and every piece
//! before it are done. Stopping cancels what is still outstanding and keeps
//! the text so far.
//!
//! The file is only read, never copied, and no audio or text is written to
//! disk here: the text exists in the window until the user copies it, saves
//! it as a file or saves it to a matter. A file is only ever chosen through
//! the native picker or dropped on the window, so the webview never names a
//! path this code reads.

use std::{
  path::{Path, PathBuf},
  sync::{
    Arc, Mutex, PoisonError,
    atomic::{AtomicBool, AtomicU64, Ordering},
  },
  time::Duration,
};

use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use stella_desktop_recording::{
  self as recording, Detected, Format, MonoSource, PIECE_SAMPLE_RATE, Piece,
  PieceRules, Pieces, Refusal,
};
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;

use crate::{dictation, dictation_cloud, dictation_cloud::RecordingModel};

pub(crate) const TRANSCRIBE_WINDOW_LABEL: &str = "transcribe";

const FILE_EVENT: &str = "transcribe-file";
const PIECE_EVENT: &str = "transcribe-piece";
const FINISHED_EVENT: &str = "transcribe-finished";
/// Pieces stella AI transcribes at once; order is kept whatever finishes
/// first.
const CLOUD_PIECES_AT_ONCE: usize = 3;
/// Pieces decoded ahead of the transcription, so it never waits on the disk.
const PIECES_AHEAD: usize = 4;
/// One piece's upload and transcription; a piece is under a minute.
const PIECE_TIMEOUT: Duration = Duration::from_secs(90);
/// Room for a header the container rounds up.
const DURATION_TOLERANCE_MS: u64 = 2_000;
const MAX_FILE_NAME_CHARS: usize = 200;
const MAX_SAVED_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 200;
const MAX_QUERY_BYTES: usize = 200;

/// Extensions the picker offers. Anything else can still be dropped; its
/// bytes decide.
const PICKER_EXTENSIONS: &[&str] = &[
  "wav", "mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "aif", "aiff", "aifc",
  "wma", "amr", "3gp", "mp4", "m4v", "mov", "webm", "mkv", "caf", "dss", "ds2",
];

/// Where a recording is transcribed: the same choice dictation offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Destination {
  Local,
  Cloud,
}

/// Why a chosen file is not transcribed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Refused {
  /// Olympus or Philips DSS or DS2: export WAV first.
  Dictaphone,
  /// Not a recording, or one no decoder on this computer reads.
  Unsupported,
  /// Longer than four hours.
  TooLong,
  /// Damaged, or not what its header says.
  Unreadable,
}

/// A chosen file, as the window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  tag = "status"
)]
pub enum FileChoice {
  Ready {
    /// Which choice this is: a start names it, so it never transcribes a
    /// file chosen after the window last heard.
    selection: u64,
    name: String,
    format: &'static str,
    duration_ms: Option<u64>,
  },
  Refused {
    name: String,
    reason: Refused,
  },
}

/// What a transcription can do on this computer right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeSnapshot {
  /// The window has anything to offer: a build that transcribes, for an
  /// account the server enabled dictation for.
  available: bool,
  /// The speech model is on this computer.
  local_ready: bool,
  cloud_available: bool,
  /// Where dictation transcribes; the window starts there.
  destination: Destination,
  file: Option<FileChoice>,
  /// A transcription is running.
  running: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
  destination: Destination,
  matter_id: Option<String>,
  /// The chosen file the window announced.
  selection: u64,
  /// The stella AI model the window showed, with its warning where its
  /// provider keeps the audio.
  model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
  job: u64,
  /// The stella AI model, when the recording goes there.
  model: Option<RecordingModel>,
}

/// One transcribed piece, in the order spoken.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PieceText {
  job: u64,
  index: usize,
  start_ms: u64,
  end_ms: u64,
  /// The quiet between this piece and the one before it.
  pause_before_ms: u64,
  text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Failure {
  /// The speech model is not on this computer.
  ModelMissing,
  /// The model on this computer failed.
  Local,
  /// stella AI failed twice on the same piece, or is no longer enabled.
  Cloud,
  /// The file stopped decoding.
  Unreadable,
  /// The file runs past four hours after all.
  TooLong,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  tag = "outcome"
)]
enum Finished {
  Done { job: u64, duration_ms: u64 },
  Stopped { job: u64 },
  Failed { job: u64, failure: Failure },
}

struct Chosen {
  path: PathBuf,
  format: Format,
  choice: FileChoice,
}

struct Job {
  id: u64,
  stop: Arc<AtomicBool>,
  workers: Arc<LocalWorkers>,
  task: tauri::async_runtime::JoinHandle<()>,
}

impl Job {
  /// Ends the job now, the speech model's child included even while it is
  /// in the middle of a piece.
  fn end_now(&self) {
    self.stop.store(true, Ordering::SeqCst);
    self.task.abort();
    self.workers.kill();
  }
}

#[derive(Default)]
struct Inner {
  file: Option<Chosen>,
  job: Option<Job>,
  /// Counts choices, clears and closes: a file inspected under an older
  /// count is stale and is dropped.
  selection: u64,
  /// The window shows a transcript of `file` until the user asks for
  /// another; a newly chosen file does not replace it meanwhile.
  holds_result: bool,
}

impl Inner {
  fn refuse_change(&self) -> Result<(), String> {
    if self.job.is_some() {
      return Err("a recording is being transcribed".to_string());
    }
    if self.holds_result {
      return Err("the last transcript is still open".to_string());
    }
    Ok(())
  }

  /// Starts a choice; its file is inspected outside the lock.
  fn begin_choice(&mut self) -> Result<u64, String> {
    self.refuse_change()?;
    self.selection += 1;
    Ok(self.selection)
  }

  /// Keeps an inspected file, unless the choice went stale meanwhile.
  fn commit_choice(&mut self, selection: u64, chosen: Option<Chosen>) -> bool {
    if self.selection != selection || self.refuse_change().is_err() {
      return false;
    }
    self.file = chosen;
    true
  }

  /// Forgets the file and whatever was being inspected.
  fn clear(&mut self) {
    self.selection += 1;
    self.file = None;
    self.holds_result = false;
  }

  /// The file a start names, if it is still the chosen one.
  fn startable(&self, selection: u64) -> Result<&Chosen, String> {
    self.refuse_change()?;
    self
      .file
      .as_ref()
      .filter(|chosen| {
        matches!(
          chosen.choice,
          FileChoice::Ready { selection: current, .. } if current == selection
        )
      })
      .ok_or_else(|| "choose a recording first".to_string())
  }
}

#[derive(Default)]
pub struct TranscribeState {
  inner: Mutex<Inner>,
  next_job: AtomicU64,
}

impl TranscribeState {
  fn update<T>(&self, apply: impl FnOnce(&mut Inner) -> T) -> T {
    apply(&mut self.inner.lock().unwrap_or_else(PoisonError::into_inner))
  }
}

/// Whether this computer offers the window: dictation is on its way here.
pub(crate) fn available(app: &AppHandle) -> bool {
  dictation::available(app)
}

fn require_window(window: &Window) -> Result<(), String> {
  if window.label() == TRANSCRIBE_WINDOW_LABEL {
    Ok(())
  } else {
    Err("recording transcription is not available here".to_string())
  }
}

fn require_available(app: &AppHandle) -> Result<(), String> {
  if available(app) {
    Ok(())
  } else {
    Err("recording transcription is not available".to_string())
  }
}

fn file_name(path: &Path) -> String {
  path
    .file_name()
    .map(|name| {
      name
        .to_string_lossy()
        .chars()
        .take(MAX_FILE_NAME_CHARS)
        .collect()
    })
    .unwrap_or_default()
}

fn extension(path: &Path) -> Option<String> {
  path
    .extension()
    .and_then(|extension| extension.to_str())
    .map(str::to_ascii_lowercase)
}

/// Looks at a file without decoding it: its format from the first bytes,
/// its length from the header where the decoder can read one.
fn inspect(path: &Path, selection: u64) -> (Option<Format>, FileChoice) {
  let name = file_name(path);
  let refused = |reason| {
    (
      None,
      FileChoice::Refused {
        name: name.clone(),
        reason,
      },
    )
  };
  let extension = extension(path);
  let mut head = [0_u8; recording::HEAD_BYTES];
  let read = match std::fs::File::open(path).and_then(|mut file| {
    use std::io::Read;
    file.read(&mut head)
  }) {
    Ok(read) => read,
    Err(_error) => return refused(Refused::Unreadable),
  };
  let format = match recording::detect(&head[..read], extension.as_deref()) {
    Detected::Recording(format) => format,
    Detected::Refused(Refusal::Ds2 | Refusal::Dss) => {
      return refused(Refused::Dictaphone);
    }
    Detected::Refused(Refusal::Unknown) => return refused(Refused::Unsupported),
  };
  let source = match open_source(path, format, extension.as_deref()) {
    Ok(source) => source,
    Err(reason) => return refused(reason),
  };
  let duration_ms = source.duration_ms();
  if duration_ms.is_some_and(|duration| {
    duration > recording::MAX_RECORDING_MS + DURATION_TOLERANCE_MS
  }) {
    return refused(Refused::TooLong);
  }
  (
    Some(format),
    FileChoice::Ready {
      selection,
      name,
      format: format.label(),
      duration_ms,
    },
  )
}

/// The decoder for `format`: Symphonia where it reads the codec, the
/// operating system's for the rest and for what Symphonia turns down.
fn open_source(
  path: &Path,
  format: Format,
  extension: Option<&str>,
) -> Result<Box<dyn MonoSource>, Refused> {
  if !format.needs_system_decoder() {
    match recording::open(path, extension) {
      Ok(source) => return Ok(Box::new(source)),
      Err(recording::DecodeError::Io(_)) => return Err(Refused::Unreadable),
      Err(_unsupported_or_damaged) => {}
    }
  }
  system_source(path)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn system_source(path: &Path) -> Result<Box<dyn MonoSource>, Refused> {
  stella_desktop_macos::SystemAudioReader::open(path)
    .map(|reader| Box::new(SystemSource(reader)) as Box<dyn MonoSource>)
    .map_err(|error| match error {
      stella_desktop_macos::SystemAudioError::Unsupported => Refused::Unsupported,
      stella_desktop_macos::SystemAudioError::Unreadable => Refused::Unreadable,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_source(_path: &Path) -> Result<Box<dyn MonoSource>, Refused> {
  Err(Refused::Unsupported)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct SystemSource(stella_desktop_macos::SystemAudioReader);

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl MonoSource for SystemSource {
  fn sample_rate(&self) -> u32 {
    self.0.sample_rate()
  }

  fn duration_ms(&self) -> Option<u64> {
    self.0.duration_ms()
  }

  fn read(&mut self, out: &mut Vec<f32>) -> Result<bool, recording::DecodeError> {
    self
      .0
      .read_mono(out)
      .map_err(|_error| recording::DecodeError::Unreadable)
  }
}

/// Keeps a chosen file and tells the window. A file chosen while a
/// transcription runs, or while the window shows its transcript, is not
/// taken: the transcript keeps its file until the user asks for another.
/// An inspection that a newer choice, a clear or the window's close
/// overtook is dropped.
fn choose(app: &AppHandle, path: PathBuf) -> Result<FileChoice, String> {
  let state = app.state::<TranscribeState>();
  let selection = state.update(Inner::begin_choice)?;
  let (format, choice) = inspect(&path, selection);
  let chosen = format.map(|format| Chosen {
    path,
    format,
    choice: choice.clone(),
  });
  if !state.update(|inner| inner.commit_choice(selection, chosen)) {
    return Err("a newer choice replaced this recording".to_string());
  }
  crate::logging::best_effort(
    app.emit_to(TRANSCRIBE_WINDOW_LABEL, FILE_EVENT, &choice),
    "chosen recording was not announced",
  );
  Ok(choice)
}

/// A file dropped on the window. Only the first is taken.
pub(crate) fn dropped(app: &AppHandle, paths: &[PathBuf]) {
  let Some(path) = paths.first().cloned() else {
    return;
  };
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    if let Err(error) = choose(&app, path) {
      tracing::info!(%error, "dropped recording was not taken");
    }
  });
}

/// Ends any transcription when the window closes, and forgets the file.
pub(crate) fn window_closed(app: &AppHandle) {
  let job = app.state::<TranscribeState>().update(|inner| {
    inner.clear();
    inner.job.take()
  });
  if let Some(job) = job {
    job.end_now();
  }
}

#[tauri::command]
pub fn transcribe_get_snapshot(
  app: AppHandle,
  window: Window,
  state: State<'_, TranscribeState>,
) -> Result<TranscribeSnapshot, String> {
  require_window(&window)?;
  let available = available(&app);
  let cloud_available = available && dictation::cloud_available(&app);
  let destination = match dictation::destination(&app).0 {
    dictation_cloud::Destination::Cloud if cloud_available => Destination::Cloud,
    _ => Destination::Local,
  };
  let (file, running) = state.update(|inner| {
    (
      inner.file.as_ref().map(|chosen| chosen.choice.clone()),
      inner.job.as_ref().map(|job| job.id),
    )
  });
  Ok(TranscribeSnapshot {
    available,
    local_ready: dictation::installed_model().is_some(),
    cloud_available,
    destination,
    file,
    running,
  })
}

/// The stella AI model a recording goes to, as the window shows it before
/// a file can be chosen for it; a start names it back.
#[tauri::command]
pub async fn transcribe_get_model(
  app: AppHandle,
  window: Window,
) -> Result<RecordingModel, String> {
  require_window(&window)?;
  require_available(&app)?;
  if !dictation::cloud_available(&app) {
    return Err("stella AI transcription is not available".to_string());
  }
  dictation_cloud::recording_model(&app).await
}

/// Opens the native picker; `None` when the user closes it.
#[tauri::command]
pub async fn transcribe_choose_file(
  app: AppHandle,
  window: Window,
) -> Result<Option<FileChoice>, String> {
  require_window(&window)?;
  require_available(&app)?;
  let (picked, answer) = tokio::sync::oneshot::channel();
  let mut dialog = app
    .dialog()
    .file()
    .add_filter("Recording", PICKER_EXTENSIONS);
  if let Some(parent) = app.get_webview_window(TRANSCRIBE_WINDOW_LABEL) {
    dialog = dialog.set_parent(&parent);
  }
  dialog.pick_file(move |file| {
    if picked.send(file).is_err() {
      tracing::debug!("recording pick finished after its command ended");
    }
  });
  let Ok(Some(file)) = answer.await else {
    return Ok(None);
  };
  let path = file
    .into_path()
    .map_err(|_unreadable| "the chosen file has no path".to_string())?;
  tauri::async_runtime::spawn_blocking(move || choose(&app, path).map(Some))
    .await
    .map_err(|error| format!("the recording could not be read: {error}"))?
}

#[tauri::command]
pub fn transcribe_clear_file(
  window: Window,
  state: State<'_, TranscribeState>,
) -> Result<(), String> {
  require_window(&window)?;
  state.update(|inner| {
    if inner.job.is_none() {
      inner.clear();
    }
  });
  Ok(())
}

#[tauri::command]
pub async fn transcribe_start(
  app: AppHandle,
  window: Window,
  request: StartRequest,
) -> Result<Started, String> {
  require_window(&window)?;
  require_available(&app)?;
  let matter_id = request
    .matter_id
    .filter(|id| !id.is_empty())
    .map(|id| valid_id(&id).map(|()| id))
    .transpose()?;
  let model = match request.destination {
    Destination::Cloud => {
      if !dictation::cloud_available(&app) {
        return Err("stella AI transcription is not available".to_string());
      }
      let model = dictation_cloud::recording_model(&app).await?;
      // The recording goes only to the model, and its warning, the window
      // showed; a model changed since then is shown again first.
      if request.model_id.as_deref() != Some(model.id.as_str()) {
        return Err("the stella AI model changed; check it again".to_string());
      }
      Some(model)
    }
    Destination::Local => None,
  };
  let state = app.state::<TranscribeState>();
  let job = state.next_job.fetch_add(1, Ordering::SeqCst) + 1;
  let stop = Arc::new(AtomicBool::new(false));
  let workers = Arc::new(LocalWorkers::default());
  let plan = Plan {
    job,
    destination: request.destination,
    model: model.clone(),
    matter_id,
    language: dictation::language(&app).hint,
    workers: Arc::clone(&workers),
  };
  state.update(|inner| {
    let chosen = inner.startable(request.selection)?;
    let task = tauri::async_runtime::spawn(run(
      app.clone(),
      chosen.path.clone(),
      chosen.format,
      plan,
      Arc::clone(&stop),
    ));
    inner.job = Some(Job {
      id: job,
      stop,
      workers,
      task,
    });
    inner.holds_result = true;
    Ok::<(), String>(())
  })?;
  Ok(Started { job, model })
}

/// Stops a transcription; the text so far stays in the window.
#[tauri::command]
pub fn transcribe_stop(
  app: AppHandle,
  window: Window,
  state: State<'_, TranscribeState>,
  job: u64,
) -> Result<(), String> {
  require_window(&window)?;
  let running = state.update(|inner| {
    if inner.job.as_ref().is_some_and(|running| running.id == job) {
      inner.job.take()
    } else {
      None
    }
  });
  if let Some(running) = running {
    running.end_now();
    announce(&app, &Finished::Stopped { job });
  }
  Ok(())
}

fn valid_id(id: &str) -> Result<(), String> {
  if id.len() <= 200
    && id.chars().all(|character| {
      character.is_ascii_alphanumeric() || character == '-' || character == '_'
    })
  {
    Ok(())
  } else {
    Err("this matter cannot be used".to_string())
  }
}

struct Plan {
  job: u64,
  destination: Destination,
  /// The stella AI model, and the account the recording started for.
  model: Option<RecordingModel>,
  matter_id: Option<String>,
  language: Option<&'static str>,
  workers: Arc<LocalWorkers>,
}

fn announce(app: &AppHandle, finished: &Finished) {
  crate::logging::best_effort(
    app.emit_to(TRANSCRIBE_WINDOW_LABEL, FINISHED_EVENT, finished),
    "transcription end was not announced",
  );
}

async fn run(
  app: AppHandle,
  path: PathBuf,
  format: Format,
  plan: Plan,
  stop: Arc<AtomicBool>,
) {
  let job = plan.job;
  let finished = match transcribe(&app, path, format, &plan, &stop).await {
    Ok(duration_ms) => Finished::Done { job, duration_ms },
    Err(failure) => Finished::Failed { job, failure },
  };
  let current = app.state::<TranscribeState>().update(|inner| {
    let current = inner.job.as_ref().is_some_and(|running| running.id == job);
    if current {
      inner.job = None;
    }
    current
  });
  // A stopped job was announced by the stop itself.
  if current && !stop.load(Ordering::SeqCst) {
    announce(&app, &finished);
  }
}

/// What the decoding thread hands on.
enum Decoded {
  Piece(Ready),
  End { duration_ms: u64 },
  Failed(Failure),
}

/// A piece at 16 kHz with where it sits in the recording.
struct Ready {
  index: usize,
  start_ms: u64,
  end_ms: u64,
  pause_before_ms: u64,
  speech: bool,
  samples: Vec<f32>,
}

async fn transcribe(
  app: &AppHandle,
  path: PathBuf,
  format: Format,
  plan: &Plan,
  stop: &Arc<AtomicBool>,
) -> Result<u64, Failure> {
  let (sender, receiver) = tokio::sync::mpsc::channel(PIECES_AHEAD);
  let decoding = Arc::clone(stop);
  std::thread::Builder::new()
    .name("transcribe-decode".to_string())
    .spawn(move || decode(&path, format, &sender, &decoding))
    .map_err(|_error| Failure::Unreadable)?;
  let decoded = stream::unfold(receiver, |mut receiver| async move {
    receiver.recv().await.map(|item| (item, receiver))
  });
  match plan.destination {
    Destination::Cloud => {
      let model = plan.model.as_ref().ok_or(Failure::Cloud)?;
      let texts = decoded
        .map(|item| async move {
          match item {
            Decoded::Piece(piece) => {
              let text = cloud_text(app, &piece, model, plan).await;
              Decoded::piece_text(piece, text)
            }
            other => Step::Other(other),
          }
        })
        .buffered(CLOUD_PIECES_AT_ONCE);
      deliver(app, plan.job, texts).await
    }
    Destination::Local => {
      let model = dictation::installed_model().ok_or(Failure::ModelMissing)?;
      let worker = Arc::new(Mutex::new(None::<LocalWorker>));
      let texts = decoded
        .map(|item| {
          let model = model.clone();
          let worker = Arc::clone(&worker);
          let workers = Arc::clone(&plan.workers);
          async move {
            match item {
              Decoded::Piece(piece) => {
                let language = plan.language;
                let result = tauri::async_runtime::spawn_blocking(move || {
                  let text = local_text(
                    &worker,
                    &workers,
                    &model,
                    &piece.samples,
                    language,
                    piece.speech,
                  );
                  (piece, text)
                })
                .await;
                match result {
                  Ok((piece, text)) => Decoded::piece_text(piece, text),
                  Err(_join) => Step::Failed(Failure::Local),
                }
              }
              other => Step::Other(other),
            }
          }
        })
        .buffered(1);
      deliver(app, plan.job, texts).await
    }
  }
}

/// A piece's outcome, or what else the decoder said.
enum Step {
  Text(PieceText),
  Failed(Failure),
  Other(Decoded),
}

impl Decoded {
  fn piece_text(piece: Ready, text: Result<String, Failure>) -> Step {
    match text {
      Ok(text) => Step::Text(PieceText {
        job: 0,
        index: piece.index,
        start_ms: piece.start_ms,
        end_ms: piece.end_ms,
        pause_before_ms: piece.pause_before_ms,
        text,
      }),
      Err(failure) => Step::Failed(failure),
    }
  }
}

/// Hands each piece's text to the window in order until the recording
/// ends or a piece fails.
async fn deliver(
  app: &AppHandle,
  job: u64,
  steps: impl futures_util::Stream<Item = Step>,
) -> Result<u64, Failure> {
  futures_util::pin_mut!(steps);
  while let Some(step) = steps.next().await {
    match step {
      Step::Text(mut text) => {
        text.job = job;
        crate::logging::best_effort(
          app.emit_to(TRANSCRIBE_WINDOW_LABEL, PIECE_EVENT, &text),
          "transcribed piece was not delivered",
        );
      }
      Step::Failed(failure) | Step::Other(Decoded::Failed(failure)) => {
        return Err(failure);
      }
      Step::Other(Decoded::End { duration_ms }) => return Ok(duration_ms),
      Step::Other(Decoded::Piece(_)) => {}
    }
  }
  // The decoder ended without saying how: it was stopped.
  Err(Failure::Unreadable)
}

/// One piece through stella AI, tried again once before the recording
/// fails. A piece without speech is not sent. Both attempts name the piece
/// the same way, so stella counts it once. Once the dictation account is
/// another than the one the recording started for, no piece is sent and
/// the recording fails, keeping the text so far.
async fn cloud_text(
  app: &AppHandle,
  piece: &Ready,
  model: &RecordingModel,
  plan: &Plan,
) -> Result<String, Failure> {
  if !piece.speech {
    return Ok(String::new());
  }
  let wav = dictation_cloud::wav(&piece.samples, PIECE_SAMPLE_RATE);
  let piece_id = uuid::Uuid::new_v4().to_string();
  for attempt in 0..2 {
    // Read before every request: stella AI may have been turned off.
    if !dictation::cloud_available(app) {
      return Err(Failure::Cloud);
    }
    match dictation_cloud::transcribe_recording_piece(
      app,
      wav.clone(),
      dictation_cloud::RecordingPiece {
        model,
        piece_id: &piece_id,
        language: plan.language,
        matter_id: plan.matter_id.as_deref(),
        timeout: PIECE_TIMEOUT,
      },
    )
    .await
    {
      Ok(text) => return Ok(text.trim().to_string()),
      Err(dictation_cloud::PieceFailure::AccountChanged) => {
        tracing::info!("the dictation account changed during a recording");
        return Err(Failure::Cloud);
      }
      Err(dictation_cloud::PieceFailure::Failed(error)) => {
        tracing::info!(%error, attempt, "a recording piece was not transcribed");
      }
    }
  }
  Err(Failure::Cloud)
}

/// Decodes on its own thread, handing pieces on as they are cut. Ends when
/// the recording does, when it fails, or when the job is stopped.
fn decode(
  path: &Path,
  format: Format,
  sender: &tokio::sync::mpsc::Sender<Decoded>,
  stop: &AtomicBool,
) {
  let send = |item| sender.blocking_send(item).is_ok();
  let extension = extension(path);
  let mut source = match open_source(path, format, extension.as_deref()) {
    Ok(source) => source,
    Err(_refused) => {
      send(Decoded::Failed(Failure::Unreadable));
      return;
    }
  };
  let rate = source.sample_rate();
  let mut cutter = Pieces::new(rate, PieceRules::default());
  let mut block = Vec::new();
  let mut decoded = 0_u64;
  let mut previous_trailing_ms = 0_u64;
  let hand_on = |piece: Piece, previous_trailing_ms: &mut u64| {
    let start_ms = recording::millis(piece.start, rate);
    let end_ms = recording::millis(piece.start + piece.samples.len() as u64, rate);
    let pause_before_ms = *previous_trailing_ms + u64::from(piece.leading_quiet_ms);
    *previous_trailing_ms = u64::from(piece.trailing_quiet_ms);
    send(Decoded::Piece(Ready {
      index: piece.index,
      start_ms,
      end_ms,
      pause_before_ms: if piece.index == 0 { 0 } else { pause_before_ms },
      speech: piece.speech,
      samples: recording::resample(&piece.samples, rate, PIECE_SAMPLE_RATE),
    }))
  };
  loop {
    if stop.load(Ordering::SeqCst) {
      return;
    }
    block.clear();
    let more = match source.read(&mut block) {
      Ok(more) => more,
      Err(_error) => {
        send(Decoded::Failed(Failure::Unreadable));
        return;
      }
    };
    decoded += block.len() as u64;
    if recording::millis(decoded, rate)
      > recording::MAX_RECORDING_MS + DURATION_TOLERANCE_MS
    {
      send(Decoded::Failed(Failure::TooLong));
      return;
    }
    for piece in cutter.push(&block) {
      if !hand_on(piece, &mut previous_trailing_ms) {
        return;
      }
    }
    if !more {
      break;
    }
  }
  if let Some(piece) = cutter.finish()
    && !hand_on(piece, &mut previous_trailing_ms)
  {
    return;
  }
  send(Decoded::End {
    duration_ms: recording::millis(decoded, rate),
  });
}

type SharedChild = Arc<Mutex<std::process::Child>>;

/// A job's speech-model child, reachable from Stop and the window's close
/// while a piece holds its pipes: killing it ends the piece's wait for the
/// reply, and once the job is stopped no new child is kept.
#[derive(Default)]
struct LocalWorkers {
  stopped: AtomicBool,
  child: Mutex<Option<SharedChild>>,
}

impl LocalWorkers {
  fn kill(&self) {
    self.stopped.store(true, Ordering::SeqCst);
    let child = self
      .child
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .take();
    if let Some(child) = child {
      kill_child(&child);
    }
  }

  /// Keeps `child` where a stop finds it; `false`, with the child killed,
  /// once the job was stopped.
  #[cfg_attr(not(any(dictation, test)), allow(dead_code))]
  fn register(&self, child: &SharedChild) -> bool {
    *self.child.lock().unwrap_or_else(PoisonError::into_inner) =
      Some(Arc::clone(child));
    if self.stopped.load(Ordering::SeqCst) {
      kill_child(child);
      return false;
    }
    true
  }
}

fn kill_child(child: &SharedChild) {
  let killed = child.lock().unwrap_or_else(PoisonError::into_inner).kill();
  if let Err(error) = killed {
    tracing::debug!(%error, "recording worker already gone");
  }
}

/// The speech model on this computer, in a child process kept warm for the
/// whole recording, as dictation runs it.
#[cfg(dictation)]
struct LocalWorker {
  child: SharedChild,
  stdin: std::process::ChildStdin,
  stdout: std::io::BufReader<std::process::ChildStdout>,
}

#[cfg(not(dictation))]
struct LocalWorker;

#[cfg(dictation)]
impl LocalWorker {
  fn start(workers: &LocalWorkers) -> std::io::Result<Self> {
    use std::process::{Command, Stdio};
    let mut process = Command::new(std::env::current_exe()?);
    process
      .arg(crate::dictation_worker::WORKER_ARG)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::null());
    // A console window must not flash up for a background process.
    #[cfg(target_os = "windows")]
    std::os::windows::process::CommandExt::creation_flags(&mut process, 0x0800_0000);
    let mut child = process.spawn()?;
    let stdin = child.stdin.take().ok_or(std::io::ErrorKind::BrokenPipe)?;
    let stdout = child.stdout.take().ok_or(std::io::ErrorKind::BrokenPipe)?;
    let worker = Self {
      child: Arc::new(Mutex::new(child)),
      stdin,
      stdout: std::io::BufReader::new(stdout),
    };
    if workers.register(&worker.child) {
      Ok(worker)
    } else {
      Err(std::io::ErrorKind::Interrupted.into())
    }
  }

  fn transcribe(
    &mut self,
    model: &Path,
    samples: &[f32],
    language: Option<&str>,
  ) -> std::io::Result<Option<String>> {
    crate::dictation_worker::write_request(&mut self.stdin, model, samples, language)?;
    let reply = crate::dictation_worker::read_response(&mut self.stdout)?;
    Ok(match reply.response {
      crate::dictation_worker::Response::Text(text) => Some(text),
      crate::dictation_worker::Response::Failed => None,
    })
  }
}

#[cfg(dictation)]
impl Drop for LocalWorker {
  fn drop(&mut self) {
    kill_child(&self.child);
    let reaped = self
      .child
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .wait();
    if let Err(error) = reaped {
      tracing::debug!(%error, "recording worker could not be reaped");
    }
  }
}

/// One piece through the speech model on this computer.
#[cfg(dictation)]
fn local_text(
  worker: &Mutex<Option<LocalWorker>>,
  workers: &LocalWorkers,
  model: &Path,
  samples: &[f32],
  language: Option<&str>,
  speech: bool,
) -> Result<String, Failure> {
  if !speech {
    return Ok(String::new());
  }
  // Pieces run one at a time, so the warm worker is taken out of its slot
  // for the request and put back when it still answers.
  let warm = worker.lock().unwrap_or_else(PoisonError::into_inner).take();
  let mut running = match warm {
    Some(running) => running,
    None => LocalWorker::start(workers).map_err(|_error| Failure::Local)?,
  };
  let text = match running.transcribe(model, samples, language) {
    Ok(Some(text)) => Ok(text.trim().to_string()),
    Ok(None) => Err(Failure::Local),
    // A worker that stopped answering is dropped, and the next piece starts
    // another.
    Err(_error) => return Err(Failure::Local),
  };
  *worker.lock().unwrap_or_else(PoisonError::into_inner) = Some(running);
  text
}

#[cfg(not(dictation))]
fn local_text(
  _worker: &Mutex<Option<LocalWorker>>,
  _workers: &LocalWorkers,
  _model: &Path,
  _samples: &[f32],
  _language: Option<&str>,
  _speech: bool,
) -> Result<String, Failure> {
  Err(Failure::ModelMissing)
}

/// Copies the transcript, as the window lays it out.
#[tauri::command]
pub fn transcribe_copy_text(window: Window, text: String) -> Result<(), String> {
  require_window(&window)?;
  if text.trim().is_empty() || text.len() > MAX_SAVED_TEXT_BYTES {
    return Err("the transcript is empty or too large to copy".to_string());
  }
  crate::clipboard::write_plain_text(text)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextRequest {
  text: String,
  file_name: String,
}

/// Saves the transcript where the user picks; `false` when they cancel.
#[tauri::command]
pub async fn transcribe_save_text(
  app: AppHandle,
  window: Window,
  request: SaveTextRequest,
) -> Result<bool, String> {
  require_window(&window)?;
  if request.text.trim().is_empty() || request.text.len() > MAX_SAVED_TEXT_BYTES {
    return Err("the transcript is empty or too large to save".to_string());
  }
  let suggested = safe_file_name(&request.file_name);
  let (picked, answer) = tokio::sync::oneshot::channel();
  let mut dialog = app
    .dialog()
    .file()
    .set_file_name(&suggested)
    .add_filter("Text", &["txt"]);
  if let Some(parent) = app.get_webview_window(TRANSCRIBE_WINDOW_LABEL) {
    dialog = dialog.set_parent(&parent);
  }
  dialog.save_file(move |file| {
    if picked.send(file).is_err() {
      tracing::debug!("transcript save finished after its command ended");
    }
  });
  let Ok(Some(file)) = answer.await else {
    return Ok(false);
  };
  let path = file
    .into_path()
    .map_err(|_unreadable| "the chosen place has no path".to_string())?;
  let bytes = request.text.into_bytes();
  tauri::async_runtime::spawn_blocking(move || {
    crate::local_store::write_private_atomic(&path, &bytes)
  })
  .await
  .map_err(|error| format!("the transcript could not be saved: {error}"))??;
  Ok(true)
}

/// A file name the window suggested, without path separators or characters
/// file systems refuse.
fn safe_file_name(name: &str) -> String {
  let cleaned = name
    .chars()
    .filter(|character| !character.is_control())
    .map(|character| match character {
      '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
      other => other,
    })
    .take(MAX_TITLE_CHARS)
    .collect::<String>();
  let cleaned = cleaned.trim().trim_start_matches('.').trim();
  if cleaned.is_empty() {
    "Transcript.txt".to_string()
  } else {
    cleaned.to_string()
  }
}

#[tauri::command]
pub async fn transcribe_search_matters(
  app: AppHandle,
  window: Window,
  query: String,
) -> Result<Vec<crate::time_entry_submit::Matter>, String> {
  require_window(&window)?;
  require_available(&app)?;
  if query.len() > MAX_QUERY_BYTES {
    return Err("the search is too long".to_string());
  }
  let account = crate::dictation_cleanup::dictation_account(&app).await?;
  let matters = crate::time_entry_submit::search_matters(&account, &query).await;
  drop(account);
  matters
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptParagraph {
  start_ms: u64,
  text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveToMatterRequest {
  matter_id: String,
  title: String,
  paragraphs: Vec<TranscriptParagraph>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTranscript {
  file_name: String,
}

const SAVE_FAILURE: &str = "the transcript could not be saved to the matter";

/// Files the transcript in the matter as a Word document, through the
/// linked account.
#[tauri::command]
pub async fn transcribe_save_to_matter(
  app: AppHandle,
  window: Window,
  request: SaveToMatterRequest,
) -> Result<SavedTranscript, String> {
  require_window(&window)?;
  require_available(&app)?;
  valid_id(&request.matter_id)?;
  let text_bytes = request
    .paragraphs
    .iter()
    .map(|paragraph| paragraph.text.len())
    .sum::<usize>();
  if request.paragraphs.is_empty() || text_bytes > MAX_SAVED_TEXT_BYTES {
    return Err("the transcript is empty or too large to save".to_string());
  }
  let title = request
    .title
    .chars()
    .take(MAX_TITLE_CHARS)
    .collect::<String>();
  let body = SaveToMatterRequest { title, ..request };
  let bytes = dictation_cloud::save_transcript(&app, &body, SAVE_FAILURE).await?;
  serde_json::from_slice(&bytes).map_err(|_error| SAVE_FAILURE.to_string())
}

/// Opens the window, from the tray or the Settings window.
#[tauri::command]
pub fn transcribe_open(app: AppHandle) -> Result<(), String> {
  require_available(&app)?;
  crate::transcribe_window::show(&app);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn suggested_file_names_never_name_another_folder() {
    assert_eq!(safe_file_name("Memo to file.txt"), "Memo to file.txt");
    assert_eq!(safe_file_name("../../etc/passwd"), "-..-etc-passwd");
    assert_eq!(safe_file_name("a\\b:c*d?.txt"), "a-b-c-d-.txt");
    assert_eq!(safe_file_name("  \u{0}\n "), "Transcript.txt");
    assert_eq!(safe_file_name(".hidden"), "hidden");
  }

  fn chosen(selection: u64) -> Chosen {
    Chosen {
      path: PathBuf::from("Hearing.m4a"),
      format: Format::M4a,
      choice: FileChoice::Ready {
        selection,
        name: "Hearing.m4a".to_string(),
        format: "M4A",
        duration_ms: None,
      },
    }
  }

  #[test]
  fn an_inspection_overtaken_by_a_newer_choice_or_a_clear_is_dropped() {
    let mut inner = Inner::default();
    let first = inner.begin_choice().unwrap();
    let second = inner.begin_choice().unwrap();
    assert!(inner.commit_choice(second, Some(chosen(second))));
    assert!(!inner.commit_choice(first, Some(chosen(first))));
    assert!(inner.startable(second).is_ok());

    let late = inner.begin_choice().unwrap();
    inner.clear();
    assert!(!inner.commit_choice(late, Some(chosen(late))));
    assert!(inner.file.is_none());
  }

  #[test]
  fn a_start_takes_only_the_file_the_window_announced() {
    let mut inner = Inner::default();
    let announced = inner.begin_choice().unwrap();
    assert!(inner.commit_choice(announced, Some(chosen(announced))));
    let newer = inner.begin_choice().unwrap();
    assert!(inner.commit_choice(newer, Some(chosen(newer))));
    assert!(inner.startable(announced).is_err());
    assert!(inner.startable(newer).is_ok());
  }

  #[test]
  fn a_transcript_keeps_its_file_until_the_user_asks_for_another() {
    let mut inner = Inner::default();
    let selection = inner.begin_choice().unwrap();
    assert!(inner.commit_choice(selection, Some(chosen(selection))));
    inner.holds_result = true;
    assert!(inner.begin_choice().is_err());
    assert!(inner.startable(selection).is_err());
    inner.clear();
    assert!(inner.begin_choice().is_ok());
  }

  #[cfg(unix)]
  #[test]
  fn stopping_kills_a_worker_that_is_still_busy() {
    let workers = LocalWorkers::default();
    let child: SharedChild = Arc::new(Mutex::new(
      std::process::Command::new("sleep") // kit-allow: a real worker process, killed and reaped; no timing is waited on
        .arg("30")
        .spawn()
        .unwrap(),
    ));
    assert!(workers.register(&child));
    workers.kill();
    let status = child.lock().unwrap().wait().unwrap();
    assert!(!status.success());

    let late: SharedChild = Arc::new(Mutex::new(
      std::process::Command::new("sleep") // kit-allow: a real worker process, killed and reaped; no timing is waited on
        .arg("30")
        .spawn()
        .unwrap(),
    ));
    assert!(
      !workers.register(&late),
      "a stopped job keeps no new worker"
    );
    assert!(!late.lock().unwrap().wait().unwrap().success());
  }

  #[test]
  fn matter_ids_are_plain_identifiers() {
    assert!(valid_id("0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a8b").is_ok());
    assert!(valid_id("a/b").is_err());
    assert!(valid_id(&"a".repeat(201)).is_err());
  }

  #[test]
  fn the_window_reads_choices_and_outcomes_by_name() {
    let refused = FileChoice::Refused {
      name: "Memo.ds2".to_string(),
      reason: Refused::Dictaphone,
    };
    assert_eq!(
      serde_json::to_value(&refused).unwrap(),
      serde_json::json!({ "status": "refused", "name": "Memo.ds2", "reason": "dictaphone" })
    );
    let ready = FileChoice::Ready {
      selection: 4,
      name: "Hearing.m4a".to_string(),
      format: "M4A",
      duration_ms: Some(1_000),
    };
    assert_eq!(
      serde_json::to_value(&ready).unwrap(),
      serde_json::json!({ "status": "ready", "selection": 4, "name": "Hearing.m4a", "format": "M4A", "durationMs": 1_000 })
    );
    assert_eq!(
      serde_json::to_value(Finished::Done {
        job: 3,
        duration_ms: 5
      })
      .unwrap(),
      serde_json::json!({ "outcome": "done", "job": 3, "durationMs": 5 })
    );
    assert_eq!(
      serde_json::to_value(Finished::Failed {
        job: 2,
        failure: Failure::TooLong
      })
      .unwrap(),
      serde_json::json!({ "outcome": "failed", "job": 2, "failure": "tooLong" })
    );
  }
}
