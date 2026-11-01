//! Hold-to-talk dictation into any app. Speech is transcribed on this
//! computer: audio never leaves it, and neither audio nor text is stored.
//!
//! This module owns the preference, the speech model file and the shortcut.
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
  feature_gate::{DesktopFeature, FeatureGates},
  http_client::{DesktopHttpClient, HttpClientOptions},
};

const PREFERENCE_FILE_NAME: &str = "dictation-enabled";
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationSnapshot {
  available: bool,
  enabled: bool,
  model: ModelState,
  model_bytes: u64,
  phase: Phase,
  failure: Option<Failure>,
  keys: ShortcutKeys,
  shortcut_taken: bool,
}

struct Inner {
  enabled: bool,
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
    Self(Mutex::new(Inner {
      enabled,
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

  fn snapshot(&self, available: bool) -> DictationSnapshot {
    let inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
    DictationSnapshot {
      available,
      enabled: inner.enabled,
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
}

fn change<T>(app: &AppHandle, apply: impl FnOnce(&mut Inner) -> T) -> T {
  let value = app.state::<DictationState>().update(apply);
  if let Err(error) = app.emit(CHANGED_EVENT, ()) {
    tracing::warn!(%error, "dictation change event failed");
  }
  value
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

#[tauri::command]
pub fn dictation_get_snapshot(
  app: AppHandle,
  state: State<'_, DictationState>,
) -> DictationSnapshot {
  state.snapshot(available(&app))
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
  let unchanged = change(&app, |inner| {
    let unchanged = inner.enabled == enabled;
    inner.enabled = enabled;
    unchanged
  });
  if !unchanged {
    DevicePreference::in_app_data(PREFERENCE_FILE_NAME).write(if enabled {
      ENABLED_VALUE
    } else {
      DISABLED_VALUE
    })?;
    if enabled {
      start(&app);
    } else {
      stop(&app);
    }
  }
  Ok(state.snapshot(true))
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
  Ok(state.snapshot(true))
}

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Streams beside the target and renames only a verified file into place, so
/// the model path never holds a partial or altered download.
async fn download_model(app: &AppHandle) -> Result<(), String> {
  let target = model_path().ok_or("app data directory is unavailable")?;
  let parent = target.parent().ok_or("model path is invalid")?;
  tokio::fs::create_dir_all(parent)
    .await
    .map_err(|error| format!("model directory failed: {error}"))?;
  let partial = target.with_extension("part");
  match stream_model(app, &partial).await {
    Ok(()) => tokio::fs::rename(&partial, &target)
      .await
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
  let mut file = tokio::fs::File::create(partial)
    .await
    .map_err(|error| format!("model file failed: {error}"))?;
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
