//! Hold-to-talk dictation into any app. Speech is transcribed on this
//! computer: audio never leaves it and is never stored. The finished text is
//! kept only in stella's own clipboard history on this computer, labelled as
//! a dictation, while that history is on; the system clipboard is never
//! written. With AI cleanup on (the default), the transcribed text, never the
//! audio, goes through stella to the organization's AI provider before it is
//! typed, with the kind of app it goes to and, when the user shares them, the
//! window title and the text before the cursor; stella stores none of it.
//! Only when the user chooses stella AI for transcription does the audio
//! leave this computer.
//!
//! This module owns the preferences, the speech model file and the key it
//! listens for (`dictation_hold_key` holds the rules for that key).
//! `dictation_engine` owns capture, transcription and insertion on one thread;
//! `dictation_live` transcribes each stretch of speech while the key is down.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine drive these")
)]

use std::{
  path::{Path, PathBuf},
  sync::{Mutex, mpsc::Sender},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{
  Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};
use tokio::io::AsyncWriteExt;

use crate::{
  clipboard_shortcut::ShortcutKeys,
  config::APP_DATA_DIR_NAME,
  device_preference::DevicePreference,
  dictation_cloud::{self, CloudModels, Destination},
  dictation_context::{self, Sharing},
  dictation_hold_key::{self, Action, Gesture, HoldChoice},
  dictation_language::{self, Choice, LanguageSnapshot},
  feature_gate::{DesktopFeature, FeatureGates},
  http_client::{DesktopHttpClient, HttpClientOptions},
};

const PREFERENCE_FILE_NAME: &str = "dictation-enabled";
/// On unless the user turned it off.
const CLEANUP_PREFERENCE_FILE_NAME: &str = "dictation-cleanup";
/// `auto` or a language code the speech model lists.
const LANGUAGE_PREFERENCE_FILE_NAME: &str = "dictation-language";
/// `local` (this computer, the default) or `cloud` (stella AI).
const DESTINATION_PREFERENCE_FILE_NAME: &str = "dictation-destination";
/// The stella AI transcription model the user picked; absent: the default.
const CLOUD_MODEL_PREFERENCE_FILE_NAME: &str = "dictation-cloud-model";
/// Off unless the user turned it on: cleanup also gets the window title.
const SHARE_WINDOW_TITLE_PREFERENCE_FILE_NAME: &str = "dictation-share-window-title";
/// Off unless the user turned it on: cleanup also gets the text before the
/// cursor.
const SHARE_TEXT_BEFORE_CURSOR_PREFERENCE_FILE_NAME: &str =
  "dictation-share-text-before-cursor";
/// The key dictation listens for; absent: this computer's default.
const HOLD_KEY_PREFERENCE_FILE_NAME: &str = "dictation-hold-key";
const MAX_MODEL_ID_BYTES: usize = 128;
const ENABLED_VALUE: &str = "on";
const DISABLED_VALUE: &str = "off";
/// Payload-free: windows read the new state through the snapshot command.
const CHANGED_EVENT: &str = "dictation-changed";

/// Set by the build script for targets the speech engine supports.
const SUPPORTED: bool = cfg!(dictation);

/// Parakeet Ultra by Moondream (CC BY 4.0), quantized by handy-computer.
const MODEL_FILE_NAME: &str = "parakeet-ultra-Q8_0.gguf";
const MODEL_URL: &str = "https://huggingface.co/handy-computer/parakeet-ultra-gguf/resolve/a1539be1b849ea7463b88343e5277b373d0c4ea9/parakeet-ultra-Q8_0.gguf";
const MODEL_BYTES: u64 = 740_363_168;
const MODEL_SHA256: &str =
  "007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59";
/// The speech model's name in the local log: its file name without the
/// extension.
pub fn local_model_id() -> &'static str {
  MODEL_FILE_NAME
    .strip_suffix(".gguf")
    .unwrap_or(MODEL_FILE_NAME)
}

/// Enough progress events to look alive, few enough to stay cheap.
const PROGRESS_STEP_BYTES: u64 = MODEL_BYTES / 100;

fn shortcut() -> Shortcut {
  Shortcut::new(Some(Modifiers::CONTROL.union(Modifiers::ALT)), Code::Space)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
  Press,
  Release,
  /// Stop recording and discard it: a tap or a shortcut on the hold key.
  Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ModelState {
  Missing,
  Downloading { received: u64, total: u64 },
  Failed,
  Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
  Idle,
  Recording,
  Transcribing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Failure {
  Accessibility,
  Microphone,
  ModelMissing,
  Transcription,
  /// Another app had focus by the time the text was ready; nothing was typed.
  FocusChanged,
  /// Focus could not be read again before typing, so nothing was typed.
  FocusUnconfirmed,
  /// Shortcut keys were still held down when the text was ready; typing
  /// would have combined them with the text, so nothing was typed.
  ShortcutHeld,
  /// stella AI could not transcribe, and this computer has no speech model to
  /// fall back to.
  CloudTranscription,
  /// A password field had focus at the press or before typing: the
  /// dictation was neither kept nor typed.
  PasswordField,
}

/// A dictation that went wrong, and whether its text is in stella's
/// clipboard history all the same.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Failed {
  pub failure: Failure,
  pub kept_in_history: bool,
}

impl From<Failure> for Failed {
  fn from(failure: Failure) -> Self {
    Self {
      failure,
      kept_in_history: false,
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationSnapshot {
  available: bool,
  enabled: bool,
  cleanup: bool,
  /// Whether cleanup also gets the focused window's title.
  share_window_title: bool,
  /// Whether cleanup also gets the text before the cursor.
  share_text_before_cursor: bool,
  /// Whether this computer can read the text before the cursor; without it
  /// the window does not offer the switch.
  text_before_cursor_available: bool,
  /// Whether a dictation's text goes to clipboard history: not while the
  /// user paused it or the organization turned it off.
  keeps_in_history: bool,
  language: LanguageSnapshot,
  /// Whether the server enables stella AI transcription for this account;
  /// without it the window offers no choice of destination.
  cloud_available: bool,
  /// The destination dictation uses: this computer whenever stella AI is
  /// not available, whatever the stored preference says.
  destination: Destination,
  cloud_model: Option<String>,
  model: ModelState,
  model_bytes: u64,
  phase: Phase,
  failure: Option<Failure>,
  /// Whether the failed dictation's text is in clipboard history.
  failure_kept_in_history: bool,
  /// The combination of Control, Option (Alt) and Space, one of the choices.
  keys: ShortcutKeys,
  shortcut_taken: bool,
  /// The key dictation listens for, and what this computer offers.
  hold_key: HoldChoice,
  hold_keys: &'static [HoldChoice],
  /// The hold key cannot be heard yet: on a Mac, until stella has
  /// Accessibility access.
  hold_key_waiting: bool,
}

/// What listens for the key while dictation runs.
enum Listening {
  None,
  Combination,
  #[cfg(any(target_os = "macos", target_os = "windows"))]
  Hold(
    #[allow(dead_code, reason = "held only so that dropping it stops the listener")]
    stella_desktop_macos::HoldKeyListener,
  ),
}

struct Inner {
  enabled: bool,
  cleanup: bool,
  share_window_title: bool,
  share_text_before_cursor: bool,
  language: Choice,
  destination: Destination,
  cloud_model: Option<String>,
  model: ModelState,
  phase: Phase,
  failure: Option<Failed>,
  shortcut_taken: bool,
  hold_key: HoldChoice,
  hold_key_waiting: bool,
  listening: Listening,
  /// Counts listeners started, so a stopped one cannot report its state.
  listener_generation: u64,
  commands: Option<Sender<Command>>,
}

pub struct DictationState(Mutex<Inner>);

impl DictationState {
  pub fn load() -> Self {
    let preference = DevicePreference::in_app_data(PREFERENCE_FILE_NAME);
    let enabled = SUPPORTED && preference.read().as_deref() == Some(ENABLED_VALUE);
    let cleanup = DevicePreference::in_app_data(CLEANUP_PREFERENCE_FILE_NAME)
      .read()
      .as_deref()
      != Some(DISABLED_VALUE);
    let shared = |file_name: &str| {
      DevicePreference::in_app_data(file_name).read().as_deref() == Some(ENABLED_VALUE)
    };
    let share_window_title = shared(SHARE_WINDOW_TITLE_PREFERENCE_FILE_NAME);
    let share_text_before_cursor =
      shared(SHARE_TEXT_BEFORE_CURSOR_PREFERENCE_FILE_NAME);
    let language = Choice::parse(
      DevicePreference::in_app_data(LANGUAGE_PREFERENCE_FILE_NAME)
        .read()
        .as_deref(),
    );
    let destination = Destination::parse(
      DevicePreference::in_app_data(DESTINATION_PREFERENCE_FILE_NAME)
        .read()
        .as_deref(),
    );
    let cloud_model = DevicePreference::in_app_data(CLOUD_MODEL_PREFERENCE_FILE_NAME)
      .read()
      .filter(|model_id| valid_model_id(model_id));
    let hold_key = HoldChoice::parse(
      DevicePreference::in_app_data(HOLD_KEY_PREFERENCE_FILE_NAME)
        .read()
        .as_deref(),
    );
    Self(Mutex::new(Inner {
      enabled,
      cleanup,
      share_window_title,
      share_text_before_cursor,
      language,
      destination,
      cloud_model,
      model: if installed_model().is_some() {
        ModelState::Ready
      } else {
        ModelState::Missing
      },
      phase: Phase::Idle,
      failure: None,
      shortcut_taken: false,
      hold_key,
      hold_key_waiting: false,
      listening: Listening::None,
      listener_generation: 0,
      commands: None,
    }))
  }

  fn snapshot(
    &self,
    available: bool,
    cloud_available: bool,
    inferred: Vec<&'static str>,
    keeps_in_history: bool,
  ) -> DictationSnapshot {
    let inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
    DictationSnapshot {
      available,
      enabled: inner.enabled,
      cleanup: inner.cleanup,
      share_window_title: inner.share_window_title,
      share_text_before_cursor: inner.share_text_before_cursor
        && dictation_context::TEXT_BEFORE_CURSOR_SUPPORTED,
      text_before_cursor_available: dictation_context::TEXT_BEFORE_CURSOR_SUPPORTED,
      keeps_in_history,
      language: LanguageSnapshot::new(&inner.language, inferred),
      cloud_available,
      destination: inner.destination.effective(cloud_available),
      cloud_model: inner.cloud_model.clone(),
      model: inner.model,
      model_bytes: MODEL_BYTES,
      phase: inner.phase,
      failure: inner.failure.map(|failed| failed.failure),
      failure_kept_in_history: inner
        .failure
        .is_some_and(|failed| failed.kept_in_history),
      keys: ShortcutKeys::of(&shortcut()),
      shortcut_taken: inner.shortcut_taken,
      hold_key: inner.hold_key,
      hold_keys: HoldChoice::OFFERED,
      hold_key_waiting: inner.hold_key_waiting,
    }
  }

  fn update<T>(&self, apply: impl FnOnce(&mut Inner) -> T) -> T {
    let mut inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
    apply(&mut inner)
  }

  /// Writes `value` to `preference` and only then applies `apply`, under one
  /// lock: the state never holds a preference that is not stored, so a
  /// failed write changes nothing and a retry writes again.
  fn store<T>(
    &self,
    preference: &DevicePreference,
    value: &str,
    apply: impl FnOnce(&mut Inner) -> T,
  ) -> Result<T, String> {
    let mut inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
    preference.write(value)?;
    Ok(apply(&mut inner))
  }
}

fn publish(app: &AppHandle) {
  if let Err(error) = app.emit(CHANGED_EVENT, ()) {
    tracing::warn!(%error, "dictation change event failed");
  }
}

fn change<T>(app: &AppHandle, apply: impl FnOnce(&mut Inner) -> T) -> T {
  let value = app.state::<DictationState>().update(apply);
  publish(app);
  value
}

/// A preference change: stored first, then applied and published.
fn change_preference<T>(
  app: &AppHandle,
  file_name: &str,
  value: &str,
  apply: impl FnOnce(&mut Inner) -> T,
) -> Result<T, String> {
  let value = app.state::<DictationState>().store(
    &DevicePreference::in_app_data(file_name),
    value,
    apply,
  )?;
  publish(app);
  Ok(value)
}

const fn stored_switch(enabled: bool) -> &'static str {
  if enabled {
    ENABLED_VALUE
  } else {
    DISABLED_VALUE
  }
}

/// A build that can run the model, for an account the server enabled.
fn available(app: &AppHandle) -> bool {
  SUPPORTED
    && app
      .state::<FeatureGates>()
      .is_enabled(DesktopFeature::Dictation)
}

fn model_path() -> Option<PathBuf> {
  dirs::data_dir().map(|data_dir| {
    data_dir
      .join(APP_DATA_DIR_NAME)
      .join("dictation")
      .join(MODEL_FILE_NAME)
  })
}

/// The model file, once a complete download sits at its path. Its digest was
/// checked before the rename that put it there.
pub fn installed_model() -> Option<PathBuf> {
  model_path().filter(|path| {
    std::fs::symlink_metadata(path)
      .is_ok_and(|meta| meta.is_file() && meta.len() == MODEL_BYTES)
  })
}

/// The language hint for the model and the languages the speaker uses.
pub struct SpeakerLanguage {
  pub hint: Option<&'static str>,
  pub speaker: Vec<&'static str>,
}

/// What the current language choice means on this computer right now.
pub fn language(app: &AppHandle) -> SpeakerLanguage {
  let choice = app
    .state::<DictationState>()
    .update(|inner| inner.language.clone());
  let inferred = match choice {
    Choice::Automatic => dictation_language::inferred(app),
    Choice::Language(_) => Vec::new(),
  };
  SpeakerLanguage {
    hint: dictation_language::hint(&choice, &inferred),
    speaker: dictation_language::speaker_languages(&choice, &inferred),
  }
}

fn valid_model_id(model_id: &str) -> bool {
  !model_id.is_empty()
    && model_id.len() <= MAX_MODEL_ID_BYTES
    && !model_id.chars().any(char::is_control)
}

/// Whether the server enables stella AI transcription alongside dictation.
fn cloud_available(app: &AppHandle) -> bool {
  available(app) && dictation_cloud::enabled(app)
}

/// Where a dictation is transcribed, and the stella AI model it uses there.
/// A stored `cloud` without the server's decision is this computer.
pub fn destination(app: &AppHandle) -> (Destination, Option<String>) {
  let cloud_available = cloud_available(app);
  app.state::<DictationState>().update(|inner| {
    (
      inner.destination.effective(cloud_available),
      inner.cloud_model.clone(),
    )
  })
}

/// Read before every chunk sent to stella AI: dictation is still on and
/// still set to stella AI, and the server still enables both.
pub fn cloud_chosen(app: &AppHandle) -> bool {
  let cloud_available = cloud_available(app);
  app.state::<DictationState>().update(|inner| {
    inner.enabled && inner.destination.effective(cloud_available) == Destination::Cloud
  })
}

/// Replaces a stored model the region no longer offers, or none, with the
/// one dictation now uses, so the window shows and keeps what is used.
pub fn adopt_cloud_model(app: &AppHandle, model_id: &str) -> Result<(), String> {
  if !valid_model_id(model_id) {
    return Err("this transcription model is not offered".to_string());
  }
  let stored = app
    .state::<DictationState>()
    .update(|inner| inner.cloud_model.clone());
  if stored.as_deref() == Some(model_id) {
    return Ok(());
  }
  change_preference(app, CLOUD_MODEL_PREFERENCE_FILE_NAME, model_id, |inner| {
    inner.cloud_model = Some(model_id.to_string());
  })
}

/// The server's stella AI decision changed: windows read the new snapshot.
pub fn apply_cloud_gate(app: &AppHandle) {
  change(app, |_inner| ());
}

/// The key dictation listens for.
pub fn hold_key(app: &AppHandle) -> HoldChoice {
  app.state::<DictationState>().update(|inner| inner.hold_key)
}

/// Whether a finished dictation goes through AI cleanup before it is typed.
pub fn cleanup_enabled(app: &AppHandle) -> bool {
  app.state::<DictationState>().update(|inner| inner.cleanup)
}

/// Starts a dictation: marks it recording and reads the speech model under
/// the lock the model's removal takes, so a removal either sees the dictation
/// and refuses, or has already marked the model missing and none is used.
pub fn start_recording(app: &AppHandle) -> Option<PathBuf> {
  let model = change(app, |inner| {
    inner.phase = Phase::Recording;
    if inner.model == ModelState::Missing {
      None
    } else {
      installed_model()
    }
  });
  show_phase_in_tray(app, Phase::Recording);
  model
}

pub fn set_phase(app: &AppHandle, phase: Phase) {
  change(app, |inner| inner.phase = phase);
  show_phase_in_tray(app, phase);
}

/// What cleanup may read about where the text goes besides the kind of app:
/// nothing while cleanup is off, otherwise what the speaker shares.
pub fn context_sharing(app: &AppHandle) -> Sharing {
  app.state::<DictationState>().update(|inner| Sharing {
    window_title: inner.cleanup && inner.share_window_title,
    text_before_cursor: inner.cleanup
      && inner.share_text_before_cursor
      && dictation_context::TEXT_BEFORE_CURSOR_SUPPORTED,
  })
}

pub fn report_failure(app: &AppHandle, failed: impl Into<Failed>) {
  let failed = failed.into();
  change(app, |inner| inner.failure = Some(failed));
}

pub fn clear_failure(app: &AppHandle) {
  change(app, |inner| inner.failure = None);
}

/// The only sign of recording away from the settings window.
fn show_phase_in_tray(app: &AppHandle, phase: Phase) {
  let mark = match phase {
    Phase::Idle => None,
    Phase::Recording => Some("●"),
    Phase::Transcribing => Some("…"),
  };
  crate::tray::set_status_mark(app, mark);
}

fn send_command(app: &AppHandle, command: Command) {
  let sender = app
    .state::<DictationState>()
    .update(|inner| inner.commands.clone());
  if let Some(sender) = sender
    && sender.send(command).is_err()
  {
    tracing::warn!("dictation engine stopped");
  }
}

impl DictationState {
  /// Sends `command` from the hold key listener started as `generation`,
  /// under the lock `unlisten` advances the generation under: a stopped
  /// listener's command is dropped, so it can never follow the `Cancel` that
  /// replaced the listener. The channel is unbounded, so sending under the
  /// lock never blocks.
  fn send_from_listener(&self, generation: u64, command: Command) {
    let delivered = self.update(|inner| {
      if inner.listener_generation != generation {
        return true;
      }
      inner
        .commands
        .as_ref()
        .is_none_or(|sender| sender.send(command).is_ok())
    });
    if !delivered {
      tracing::warn!("dictation engine stopped");
    }
  }
}

fn on_shortcut(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
  send_command(
    app,
    match event.state {
      ShortcutState::Pressed => Command::Press,
      ShortcutState::Released => Command::Release,
    },
  );
}

/// Starts listening for the chosen key. A listener that cannot start leaves
/// the reason in the snapshot.
fn listen(app: &AppHandle) {
  let (choice, generation) = app.state::<DictationState>().update(|inner| {
    inner.listener_generation += 1;
    (inner.hold_key, inner.listener_generation)
  });
  let listening = match choice {
    HoldChoice::Combination => {
      match app.global_shortcut().on_shortcut(shortcut(), on_shortcut) {
        Ok(()) => Listening::Combination,
        Err(error) => {
          tracing::warn!(%error, "dictation shortcut could not be registered");
          change(app, |inner| inner.shortcut_taken = true);
          Listening::None
        }
      }
    }
    _ => listen_for_hold_key(app, choice, generation),
  };
  change(app, |inner| inner.listening = listening);
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn listen_for_hold_key(
  app: &AppHandle,
  choice: HoldChoice,
  generation: u64,
) -> Listening {
  use std::cell::Cell;

  use stella_desktop_macos::{HoldEdge, HoldKey};

  let key = match choice {
    HoldChoice::Fn => HoldKey::Fn,
    HoldChoice::RightOption => HoldKey::RightOption,
    HoldChoice::RightCommand => HoldKey::RightCommand,
    HoldChoice::RightControl => HoldKey::RightControl,
    HoldChoice::ControlWindows | HoldChoice::Combination => HoldKey::ControlWindows,
  };
  let edges_app = app.clone();
  let gesture = Cell::new(Gesture::default());
  let started = std::time::Instant::now();
  let on_edge = move |edge: HoldEdge| {
    let input = match edge {
      HoldEdge::Down { others_held } => dictation_hold_key::Input::Down { others_held },
      HoldEdge::Up => dictation_hold_key::Input::Up,
      HoldEdge::OtherKey => dictation_hold_key::Input::OtherKey,
    };
    let mut current = gesture.get();
    let action = current.handle(input, started.elapsed());
    gesture.set(current);
    if let Some(action) = action {
      edges_app.state::<DictationState>().send_from_listener(
        generation,
        match action {
          Action::Start => Command::Press,
          Action::Transcribe => Command::Release,
          Action::Cancel => Command::Cancel,
        },
      );
    }
  };
  let state_app = app.clone();
  let on_listening = move |listening: bool| {
    change(&state_app, |inner| {
      if inner.listener_generation == generation {
        inner.hold_key_waiting = !listening;
      }
    });
  };
  match stella_desktop_macos::listen_for_hold_key(key, on_edge, on_listening) {
    Ok(listener) => Listening::Hold(listener),
    Err(_unsupported) => {
      tracing::warn!("dictation hold key could not be watched");
      change(app, |inner| inner.hold_key_waiting = true);
      Listening::None
    }
  }
}

/// No other platform offers a hold key.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn listen_for_hold_key(
  _app: &AppHandle,
  _choice: HoldChoice,
  _generation: u64,
) -> Listening {
  Listening::None
}

/// Stops listening; a recording in progress is left to its release or to
/// the engine stopping.
fn unlisten(app: &AppHandle) {
  let listening = change(app, |inner| {
    inner.listener_generation += 1;
    inner.shortcut_taken = false;
    inner.hold_key_waiting = false;
    std::mem::replace(&mut inner.listening, Listening::None)
  });
  if matches!(listening, Listening::Combination)
    && let Err(error) = app.global_shortcut().unregister(shortcut())
  {
    tracing::warn!(%error, "dictation shortcut could not be released");
  }
  // Dropping a hold key listener stops it.
  drop(listening);
}

fn start(app: &AppHandle) {
  #[cfg(dictation)]
  {
    crate::dictation_input::request_access();
    let sender = crate::dictation_engine::spawn(app.clone());
    change(app, |inner| inner.commands = sender);
  }
  listen(app);
}

fn stop(app: &AppHandle) {
  unlisten(app);
  // Dropping the sender ends the engine thread and with it the worker.
  change(app, |inner| {
    inner.commands = None;
    inner.failure = None;
  });
}

/// The server's decision, applied whenever it arrives or changes. Nothing
/// listens for the shortcut until it says this account may dictate.
pub fn apply_feature_gate(app: &AppHandle, enabled: bool) {
  let (wanted, running) = app
    .state::<DictationState>()
    .update(|inner| (inner.enabled, inner.commands.is_some()));
  if enabled && wanted && !running {
    start(app);
  } else if !enabled && running {
    stop(app);
  }
  change(app, |_inner| ());
}

/// The snapshot a window reads, with the languages inferred right now.
fn read_snapshot(app: &AppHandle, state: &DictationState) -> DictationSnapshot {
  let available = available(app);
  let inferred = if available {
    dictation_language::inferred(app)
  } else {
    Vec::new()
  };
  state.snapshot(
    available,
    cloud_available(app),
    inferred,
    crate::clipboard::keeps_dictations(app),
  )
}

#[tauri::command]
pub fn dictation_get_snapshot(
  app: AppHandle,
  state: State<'_, DictationState>,
) -> DictationSnapshot {
  read_snapshot(&app, &state)
}

#[tauri::command]
pub fn dictation_set_enabled(
  app: AppHandle,
  state: State<'_, DictationState>,
  enabled: bool,
) -> Result<DictationSnapshot, String> {
  if !available(&app) {
    return Err("dictation is not available on this computer".to_string());
  }
  let unchanged = change_preference(
    &app,
    PREFERENCE_FILE_NAME,
    stored_switch(enabled),
    |inner| {
      let unchanged = inner.enabled == enabled;
      inner.enabled = enabled;
      unchanged
    },
  )?;
  if !unchanged {
    if enabled {
      start(&app);
    } else {
      stop(&app);
    }
  }
  Ok(read_snapshot(&app, &state))
}

#[tauri::command]
pub fn dictation_set_cleanup(
  app: AppHandle,
  state: State<'_, DictationState>,
  enabled: bool,
) -> Result<DictationSnapshot, String> {
  if !available(&app) {
    return Err("dictation is not available on this computer".to_string());
  }
  change_preference(
    &app,
    CLEANUP_PREFERENCE_FILE_NAME,
    stored_switch(enabled),
    |inner| inner.cleanup = enabled,
  )?;
  Ok(read_snapshot(&app, &state))
}

/// Whether cleanup also gets the focused window's title.
#[tauri::command]
pub fn dictation_set_share_window_title(
  app: AppHandle,
  state: State<'_, DictationState>,
  enabled: bool,
) -> Result<DictationSnapshot, String> {
  if !available(&app) {
    return Err("dictation is not available on this computer".to_string());
  }
  change_preference(
    &app,
    SHARE_WINDOW_TITLE_PREFERENCE_FILE_NAME,
    stored_switch(enabled),
    |inner| inner.share_window_title = enabled,
  )?;
  Ok(read_snapshot(&app, &state))
}

/// Whether cleanup also gets the text before the cursor, where this
/// computer can read it.
#[tauri::command]
pub fn dictation_set_share_text_before_cursor(
  app: AppHandle,
  state: State<'_, DictationState>,
  enabled: bool,
) -> Result<DictationSnapshot, String> {
  if !available(&app) {
    return Err("dictation is not available on this computer".to_string());
  }
  if enabled && !dictation_context::TEXT_BEFORE_CURSOR_SUPPORTED {
    return Err(
      "the text before the cursor cannot be read on this computer".to_string(),
    );
  }
  change_preference(
    &app,
    SHARE_TEXT_BEFORE_CURSOR_PREFERENCE_FILE_NAME,
    stored_switch(enabled),
    |inner| inner.share_text_before_cursor = enabled,
  )?;
  Ok(read_snapshot(&app, &state))
}

#[tauri::command]
pub fn dictation_set_language(
  app: AppHandle,
  state: State<'_, DictationState>,
  language: String,
) -> Result<DictationSnapshot, String> {
  if !available(&app) {
    return Err("dictation is not available on this computer".to_string());
  }
  let choice = Choice::parse(Some(&language));
  if choice.stored() != language {
    return Err("this language is not available for dictation".to_string());
  }
  change_preference(
    &app,
    LANGUAGE_PREFERENCE_FILE_NAME,
    choice.stored(),
    |inner| inner.language = choice,
  )?;
  Ok(read_snapshot(&app, &state))
}

#[tauri::command]
pub fn dictation_set_destination(
  app: AppHandle,
  state: State<'_, DictationState>,
  destination: Destination,
) -> Result<DictationSnapshot, String> {
  if !available(&app) {
    return Err("dictation is not available on this computer".to_string());
  }
  if destination == Destination::Cloud && !cloud_available(&app) {
    return Err("stella AI transcription is not available".to_string());
  }
  if state.update(|inner| inner.destination) != destination {
    change_preference(
      &app,
      DESTINATION_PREFERENCE_FILE_NAME,
      destination.stored(),
      |inner| inner.destination = destination,
    )?;
  }
  Ok(read_snapshot(&app, &state))
}

/// The models stella AI offers this organization; the window picks from it.
/// A stored model the region no longer offers is replaced by the one
/// dictation would use, so the window shows what is used.
/// The key dictation listens for, from what this computer offers. Applies
/// from the next press.
#[tauri::command]
pub fn dictation_set_hold_key(
  app: AppHandle,
  state: State<'_, DictationState>,
  hold_key: String,
) -> Result<DictationSnapshot, String> {
  if !available(&app) {
    return Err("dictation is not available on this computer".to_string());
  }
  let Some(choice) = HoldChoice::offered(&hold_key) else {
    return Err("this key is not offered for dictation".to_string());
  };
  if state.update(|inner| inner.hold_key) != choice {
    change_preference(
      &app,
      HOLD_KEY_PREFERENCE_FILE_NAME,
      choice.stored(),
      |inner| {
        inner.hold_key = choice;
      },
    )?;
    if state.update(|inner| inner.commands.is_some()) {
      unlisten(&app);
      // The old key's release will never be heard: a recording it started
      // is discarded.
      send_command(&app, Command::Cancel);
      listen(&app);
    }
  }
  Ok(read_snapshot(&app, &state))
}

#[tauri::command]
pub async fn dictation_get_cloud_models(app: AppHandle) -> Result<CloudModels, String> {
  if !cloud_available(&app) {
    return Err("stella AI transcription is not available".to_string());
  }
  let offered = dictation_cloud::models(&app).await?;
  let stored = app
    .state::<DictationState>()
    .update(|inner| inner.cloud_model.clone());
  if let Some(choice) = dictation_cloud::choose_model(stored.as_deref(), &offered)
    && choice.replaces_stored
  {
    adopt_cloud_model(&app, &choice.model_id)?;
  }
  Ok(offered)
}

#[tauri::command]
pub async fn dictation_set_cloud_model(
  app: AppHandle,
  model_id: String,
) -> Result<DictationSnapshot, String> {
  if !cloud_available(&app) {
    return Err("stella AI transcription is not available".to_string());
  }
  // Only a model the organization is offered right now can be chosen.
  if !valid_model_id(&model_id)
    || !dictation_cloud::models(&app).await?.offers(&model_id)
  {
    return Err("this transcription model is not offered".to_string());
  }
  adopt_cloud_model(&app, &model_id)?;
  let state = app.state::<DictationState>();
  Ok(read_snapshot(&app, &state))
}

#[tauri::command]
pub fn dictation_download_model(
  app: AppHandle,
  state: State<'_, DictationState>,
) -> Result<DictationSnapshot, String> {
  if !available(&app) {
    return Err("dictation is not available on this computer".to_string());
  }
  let begin = change(&app, |inner| {
    let begin = !matches!(
      inner.model,
      ModelState::Downloading { .. } | ModelState::Ready
    );
    if begin {
      inner.model = ModelState::Downloading {
        received: 0,
        total: MODEL_BYTES,
      };
    }
    begin
  });
  if begin {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
      let model = match download_model(&handle).await {
        Ok(()) => ModelState::Ready,
        Err(error) => {
          tracing::warn!(%error, "speech model download failed");
          ModelState::Failed
        }
      };
      change(&handle, |inner| inner.model = model);
    });
  }
  Ok(read_snapshot(&app, &state))
}

/// Deletes the speech model from this computer, for someone who transcribes
/// with stella AI or wants the disk space back. Refused while a dictation runs
/// or the model downloads. A warm worker lets go of the model once it idles.
#[tauri::command]
pub fn dictation_remove_model(
  app: AppHandle,
  state: State<'_, DictationState>,
) -> Result<DictationSnapshot, String> {
  if !available(&app) {
    return Err("dictation is not available on this computer".to_string());
  }
  let path = model_path().ok_or("app data directory is unavailable")?;
  // Checked and marked missing under one lock, so no download or dictation
  // starts on a model about to go.
  let busy = change(&app, |inner| {
    let busy = inner.phase != Phase::Idle
      || matches!(inner.model, ModelState::Downloading { .. });
    if !busy {
      inner.model = ModelState::Missing;
    }
    busy
  });
  if busy {
    return Err("the speech model is in use".to_string());
  }
  match std::fs::remove_file(&path) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => {
      // Still on disk, for example while Windows has it open.
      let model = if installed_model().is_some() {
        ModelState::Ready
      } else {
        ModelState::Missing
      };
      change(&app, |inner| inner.model = model);
      return Err(format!("speech model removal failed: {error}"));
    }
  }
  Ok(read_snapshot(&app, &state))
}

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Streams beside the target and renames only a verified file into place, so
/// the model path never holds a partial or altered download.
async fn download_model(app: &AppHandle) -> Result<(), String> {
  let target = model_path().ok_or("app data directory is unavailable")?;
  let parent = target.parent().ok_or("model path is invalid")?;
  crate::local_store::create_private_dir(parent)
    .map_err(|error| format!("model directory failed: {error}"))?;
  let partial = target.with_extension("part");
  // A download an earlier run did not finish leaves its partial file behind;
  // the new one is created fresh beside the target.
  match tokio::fs::remove_file(&partial).await {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => return Err(format!("stale partial model failed: {error}")),
  }
  match stream_model(app, &partial).await {
    Ok(()) => crate::local_store::rename_private(&partial, &target)
      .map_err(|error| format!("model rename failed: {error}")),
    Err(error) => {
      if let Err(remove) = tokio::fs::remove_file(&partial).await {
        tracing::debug!(%remove, "partial speech model already gone");
      }
      Err(error)
    }
  }
}

async fn stream_model(app: &AppHandle, partial: &Path) -> Result<(), String> {
  let client = DesktopHttpClient::new(HttpClientOptions {
    timeout: None,
    redirect: reqwest::redirect::Policy::limited(5),
  })
  .map_err(|error| format!("http client failed: {error}"))?;
  let mut response = client
    .get(MODEL_URL)
    .send()
    .await
    .and_then(reqwest::Response::error_for_status)
    .map_err(|error| format!("model request failed: {error}"))?;
  let mut file = tokio::fs::File::from_std(
    crate::local_store::open_private(crate::local_store::OpenMode::CreateNew, partial)
      .map_err(|error| format!("model file failed: {error}"))?,
  );
  let mut digest = Sha256::new();
  let mut received = 0_u64;
  let mut reported = 0_u64;
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|error| format!("model read failed: {error}"))?
  {
    received += chunk.len() as u64;
    if received > MODEL_BYTES {
      return Err("model is larger than expected".to_string());
    }
    digest.update(&chunk);
    file
      .write_all(&chunk)
      .await
      .map_err(|error| format!("model write failed: {error}"))?;
    if received - reported >= PROGRESS_STEP_BYTES {
      reported = received;
      change(app, |inner| {
        inner.model = ModelState::Downloading {
          received,
          total: MODEL_BYTES,
        };
      });
    }
  }
  file
    .flush()
    .await
    .map_err(|error| format!("model flush failed: {error}"))?;
  if received != MODEL_BYTES || hex(&digest.finalize()) != MODEL_SHA256 {
    return Err("model failed verification".to_string());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn hex_is_lowercase_and_zero_padded() {
    assert_eq!(hex(&[0x00, 0x0f, 0xab]), "000fab");
  }

  #[test]
  fn the_pinned_model_is_a_full_digest_of_the_named_file() {
    assert_eq!(MODEL_SHA256.len(), 64);
    assert!(MODEL_URL.ends_with(MODEL_FILE_NAME));
  }

  #[test]
  fn failures_reach_the_window_by_their_string_names() {
    for (failure, name) in [
      (Failure::FocusChanged, "focusChanged"),
      (Failure::FocusUnconfirmed, "focusUnconfirmed"),
      (Failure::ShortcutHeld, "shortcutHeld"),
      (Failure::PasswordField, "passwordField"),
      (Failure::CloudTranscription, "cloudTranscription"),
    ] {
      assert_eq!(
        serde_json::to_value(failure).unwrap(),
        serde_json::json!(name)
      );
    }
  }

  fn state(cleanup: bool) -> DictationState {
    DictationState(Mutex::new(Inner {
      enabled: true,
      cleanup,
      share_window_title: false,
      share_text_before_cursor: false,
      language: Choice::Automatic,
      destination: Destination::parse(None),
      cloud_model: None,
      model: ModelState::Missing,
      phase: Phase::Idle,
      failure: None,
      shortcut_taken: false,
      hold_key: HoldChoice::parse(None),
      hold_key_waiting: false,
      listening: Listening::None,
      listener_generation: 0,
      commands: None,
    }))
  }

  #[test]
  fn the_snapshot_names_the_hold_key_and_what_is_offered() {
    let snapshot =
      serde_json::to_value(state(true).snapshot(true, false, Vec::new(), false))
        .unwrap();

    assert_eq!(
      snapshot["holdKey"],
      serde_json::json!(HoldChoice::OFFERED[0].stored())
    );
    assert_eq!(
      snapshot["holdKeys"].as_array().map(Vec::len),
      Some(HoldChoice::OFFERED.len())
    );
    assert_eq!(snapshot["holdKeyWaiting"], serde_json::json!(false));
  }

  #[test]
  fn a_stopped_listener_sends_no_command() {
    let state = state(true);
    let (sender, receiver) = std::sync::mpsc::channel();
    state.update(|inner| {
      inner.commands = Some(sender);
      inner.listener_generation = 2;
    });

    state.send_from_listener(1, Command::Press);
    state.send_from_listener(2, Command::Release);

    assert_eq!(receiver.try_iter().collect::<Vec<_>>(), [Command::Release]);
  }

  fn temp_preference() -> (DevicePreference, PathBuf) {
    let dir =
      std::env::temp_dir().join(format!("stella-dictation-{}", uuid::Uuid::new_v4()));
    (DevicePreference::at(dir.join("dictation-cleanup")), dir)
  }

  #[test]
  fn a_preference_that_cannot_be_stored_leaves_the_state_unchanged() {
    let (_, dir) = temp_preference();
    // A directory where the file belongs refuses the write.
    let blocked = dir.join("dictation-cleanup");
    crate::local_store::create_private_dir(&blocked).unwrap();
    let state = state(true);
    let mut applied = false;
    assert!(
      state
        .store(&DevicePreference::at(blocked), DISABLED_VALUE, |inner| {
          applied = true;
          inner.cleanup = false;
        })
        .is_err()
    );
    assert!(!applied);
    assert!(state.update(|inner| inner.cleanup));
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_stored_preference_is_applied_and_reads_back() {
    let (preference, dir) = temp_preference();
    let state = state(true);
    state
      .store(&preference, DISABLED_VALUE, |inner| inner.cleanup = false)
      .unwrap();
    assert!(!state.update(|inner| inner.cleanup));
    assert_eq!(preference.read().as_deref(), Some(DISABLED_VALUE));
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_failure_says_whether_the_text_is_in_clipboard_history() {
    let state = state(true);
    let snapshot = |state: &DictationState| {
      serde_json::to_value(state.snapshot(true, false, Vec::new(), true)).unwrap()
    };
    assert_eq!(snapshot(&state)["failureKeptInHistory"], false);
    state.update(|inner| {
      inner.failure = Some(Failed {
        failure: Failure::FocusChanged,
        kept_in_history: true,
      });
    });
    let kept = snapshot(&state);
    assert_eq!(kept["failure"], "focusChanged");
    assert_eq!(kept["failureKeptInHistory"], true);
    // A failure before any text, such as a missing microphone, keeps nothing.
    state.update(|inner| inner.failure = Some(Failure::Microphone.into()));
    let lost = snapshot(&state);
    assert_eq!(lost["failure"], "microphone");
    assert_eq!(lost["failureKeptInHistory"], false);
  }

  #[test]
  fn context_sharing_starts_off_and_the_snapshot_reports_it() {
    let state = state(true);
    let snapshot =
      serde_json::to_value(state.snapshot(true, false, Vec::new(), true)).unwrap();
    assert_eq!(snapshot["shareWindowTitle"], false);
    assert_eq!(snapshot["shareTextBeforeCursor"], false);
    assert_eq!(
      snapshot["textBeforeCursorAvailable"],
      dictation_context::TEXT_BEFORE_CURSOR_SUPPORTED
    );
  }

  #[test]
  fn the_snapshot_tags_download_progress() {
    let model = ModelState::Downloading {
      received: 1,
      total: 2,
    };

    assert_eq!(
      serde_json::to_value(model).unwrap(),
      serde_json::json!({ "status": "downloading", "received": 1, "total": 2 })
    );
  }
}
