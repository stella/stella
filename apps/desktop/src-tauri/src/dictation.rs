//! Hold-to-talk dictation into any app. Speech is transcribed on this
//! computer: audio never leaves it, and neither audio nor text is stored.
//! With AI cleanup on (the default), the transcribed text, never the audio,
//! goes through stella to the organization's AI provider before it is typed,
//! and stella does not store it. Only when the user chooses stella AI for
//! transcription does the audio leave this computer.
//!
//! This module owns the preferences, the speech model file and the shortcut.
//! `dictation_engine` owns capture, transcription and insertion on one thread.

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
/// Enough progress events to look alive, few enough to stay cheap.
const PROGRESS_STEP_BYTES: u64 = MODEL_BYTES / 100;

fn shortcut() -> Shortcut {
  Shortcut::new(Some(Modifiers::CONTROL.union(Modifiers::ALT)), Code::Space)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
  Press,
  Release,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationSnapshot {
  available: bool,
  enabled: bool,
  cleanup: bool,
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
  keys: ShortcutKeys,
  shortcut_taken: bool,
}

struct Inner {
  enabled: bool,
  cleanup: bool,
  language: Choice,
  destination: Destination,
  cloud_model: Option<String>,
  model: ModelState,
  phase: Phase,
  failure: Option<Failure>,
  shortcut_taken: bool,
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
    Self(Mutex::new(Inner {
      enabled,
      cleanup,
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
      commands: None,
    }))
  }

  fn snapshot(
    &self,
    available: bool,
    cloud_available: bool,
    inferred: Vec<&'static str>,
  ) -> DictationSnapshot {
    let inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
    DictationSnapshot {
      available,
      enabled: inner.enabled,
      cleanup: inner.cleanup,
      language: LanguageSnapshot::new(&inner.language, inferred),
      cloud_available,
      destination: inner.destination.effective(cloud_available),
      cloud_model: inner.cloud_model.clone(),
      model: inner.model,
      model_bytes: MODEL_BYTES,
      phase: inner.phase,
      failure: inner.failure,
      keys: ShortcutKeys::of(&shortcut()),
      shortcut_taken: inner.shortcut_taken,
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

/// Whether a finished dictation goes through AI cleanup before it is typed.
pub fn cleanup_enabled(app: &AppHandle) -> bool {
  app.state::<DictationState>().update(|inner| inner.cleanup)
}

pub fn set_phase(app: &AppHandle, phase: Phase) {
  change(app, |inner| inner.phase = phase);
  show_phase_in_tray(app, phase);
}

pub fn report_failure(app: &AppHandle, failure: Failure) {
  change(app, |inner| inner.failure = Some(failure));
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

fn on_shortcut(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
  let command = match event.state {
    ShortcutState::Pressed => Command::Press,
    ShortcutState::Released => Command::Release,
  };
  let sender = app
    .state::<DictationState>()
    .update(|inner| inner.commands.clone());
  if let Some(sender) = sender
    && sender.send(command).is_err()
  {
    tracing::warn!("dictation engine stopped");
  }
}

fn start(app: &AppHandle) {
  #[cfg(dictation)]
  {
    crate::dictation_input::request_access();
    let sender = crate::dictation_engine::spawn(app.clone());
    change(app, |inner| inner.commands = sender);
  }
  let taken = match app.global_shortcut().on_shortcut(shortcut(), on_shortcut) {
    Ok(()) => false,
    Err(error) => {
      tracing::warn!(%error, "dictation shortcut could not be registered");
      true
    }
  };
  change(app, |inner| inner.shortcut_taken = taken);
}

fn stop(app: &AppHandle) {
  if let Err(error) = app.global_shortcut().unregister(shortcut()) {
    tracing::warn!(%error, "dictation shortcut could not be released");
  }
  // Dropping the sender ends the engine thread and with it the worker.
  change(app, |inner| {
    inner.commands = None;
    inner.shortcut_taken = false;
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
  state.snapshot(available, cloud_available(app), inferred)
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
      language: Choice::Automatic,
      destination: Destination::parse(None),
      cloud_model: None,
      model: ModelState::Missing,
      phase: Phase::Idle,
      failure: None,
      shortcut_taken: false,
      commands: None,
    }))
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
