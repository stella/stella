//! Optional transcription by stella AI. Only when the server enables cloud
//! dictation for the linked account and the user chose it does the captured
//! audio leave this computer: it goes, as WAV chunks the API's limits admit,
//! to that account, with a model its region offers and the dictation
//! language. Audio and text are never logged or stored here.
//!
//! The choice is read again before every chunk; once it is no longer stella
//! AI, or dictation is off, no further chunk is sent. When stella AI cannot
//! transcribe and the speech model is installed, the dictation is
//! transcribed on this computer instead: the more private destination. A
//! dictation set to this computer never goes to stella AI.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine transcribe")
)]

use std::{future::Future, ops::Range, sync::OnceLock, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
  account::AccountRequest,
  dictation::{self, Failure},
  dictation_audio::holds_speech,
  dictation_cleanup::{self, dictation_account},
  feature_gate::{DesktopFeature, FeatureGates},
  http_client::{DesktopHttpClient, HttpClientOptions},
  logging::{json_cause_logged, request_cause_logged},
};

const FAILURE: &str = "dictation transcription request failed";
const UNAVAILABLE: &str = "stella AI transcription is not enabled for this account";
const STOPPED: &str = "dictation no longer goes to stella AI";
const TIMED_OUT: &str = "stella AI transcription timed out";
/// One chunk's upload and transcription.
pub const CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
/// Every chunk of one dictation together, account and model reads included.
/// Past it the dictation falls back as any other failure does.
pub const DEADLINE: Duration = Duration::from_secs(120);
/// The account read, bounded as cleanup bounds it.
const ACCOUNT_TIMEOUT: Duration = dictation_cleanup::TIMEOUT;
const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const WAV_HEADER_BYTES: usize = 44;
/// The stretch a chunk boundary is cut in, and how far before the limit it
/// is looked for.
const QUIET_WINDOW_MILLIS: usize = 200;
const CUT_SEARCH_MILLIS: usize = 5_000;
/// A final chunk shorter than this joins the one before it.
const MIN_CHUNK_MILLIS: usize = 1_000;
/// How much of the second a cut keeps in reserve a joined chunk may use.
const JOIN_RESERVE_MILLIS: usize = 500;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
  models_path: String,
  transcribe_path: String,
  max_audio_bytes: usize,
  max_audio_seconds: usize,
}

const CONTRACT: &str = include_str!(
  "../../../../packages/api-contract/src/desktop-dictation-transcription.json"
);

fn contract() -> &'static Contract {
  static PARSED: OnceLock<Contract> = OnceLock::new();
  PARSED.get_or_init(|| {
    serde_json::from_str(CONTRACT)
      .expect("the committed dictation transcription contract must be valid")
  })
}

/// Where the user asked dictation to be transcribed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Destination {
  /// The speech model on this computer; audio never leaves it.
  Local,
  /// stella AI; audio goes to stella and the chosen model's provider.
  Cloud,
}

impl Destination {
  /// The stored preference; anything but `cloud` is this computer.
  pub fn parse(stored: Option<&str>) -> Self {
    if stored == Some("cloud") {
      Self::Cloud
    } else {
      Self::Local
    }
  }

  pub const fn stored(self) -> &'static str {
    match self {
      Self::Local => "local",
      Self::Cloud => "cloud",
    }
  }

  /// The destination a dictation actually uses: stella AI only while the
  /// server enables it, whatever the stored preference says.
  pub const fn effective(self, cloud_enabled: bool) -> Self {
    match self {
      Self::Cloud if cloud_enabled => Self::Cloud,
      Self::Cloud | Self::Local => Self::Local,
    }
  }
}

/// Whether the server enables stella AI transcription for this account.
pub fn enabled(app: &AppHandle) -> bool {
  app
    .try_state::<FeatureGates>()
    .is_some_and(|gates| gates.is_enabled(DesktopFeature::DictationCloud))
}

/// One attempt at turning the audio into text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attempt {
  Local,
  Cloud,
}

/// The attempts, in order: stella AI first when chosen, then this computer
/// when its model is installed. This computer never falls back to stella AI.
pub fn attempts(destination: Destination, local_installed: bool) -> Vec<Attempt> {
  match destination {
    Destination::Local => vec![Attempt::Local],
    Destination::Cloud if local_installed => vec![Attempt::Cloud, Attempt::Local],
    Destination::Cloud => vec![Attempt::Cloud],
  }
}

/// The text of the first attempt that produced one. Without any, a local
/// dictation whose model is missing reports that; anything else reports the
/// failure of the destination the user chose.
pub fn transcribe_with(
  destination: Destination,
  local_installed: bool,
  mut cloud: impl FnMut() -> Option<String>,
  mut local: impl FnMut() -> Option<String>,
) -> Result<String, Failure> {
  for attempt in attempts(destination, local_installed) {
    let text = match attempt {
      Attempt::Cloud => cloud(),
      Attempt::Local => local(),
    };
    if let Some(text) = text {
      return Ok(text);
    }
  }
  match destination {
    Destination::Local if !local_installed => Err(Failure::ModelMissing),
    Destination::Local => Err(Failure::Transcription),
    Destination::Cloud => Err(Failure::CloudTranscription),
  }
}

/// 16-bit PCM WAV of mono samples, the format the API reads exactly.
pub fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
  let data_bytes = u32::try_from(samples.len() * 2).unwrap_or(u32::MAX);
  let mut bytes = Vec::with_capacity(WAV_HEADER_BYTES + samples.len() * 2);
  bytes.extend_from_slice(b"RIFF");
  bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
  bytes.extend_from_slice(b"WAVEfmt ");
  bytes.extend_from_slice(&16_u32.to_le_bytes());
  bytes.extend_from_slice(&1_u16.to_le_bytes());
  bytes.extend_from_slice(&1_u16.to_le_bytes());
  bytes.extend_from_slice(&rate.to_le_bytes());
  bytes.extend_from_slice(&(rate * 2).to_le_bytes());
  bytes.extend_from_slice(&2_u16.to_le_bytes());
  bytes.extend_from_slice(&16_u16.to_le_bytes());
  bytes.extend_from_slice(b"data");
  bytes.extend_from_slice(&data_bytes.to_le_bytes());
  for sample in samples {
    // The clamped sample scaled to the i16 range fits by construction.
    let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
    bytes.extend_from_slice(&value.to_le_bytes());
  }
  bytes
}

/// Samples in `millis` milliseconds at `rate`.
const fn samples_in(millis: usize, rate: u32) -> usize {
  millis * rate as usize / 1_000
}

/// The longest chunk: a second under the API's limit, so a container
/// rounding a boundary never pushes one over it.
fn chunk_limit(rate: u32) -> usize {
  contract().max_audio_seconds.saturating_sub(1).max(1) * rate as usize
}

/// The longest chunk a short final piece may join into: the chunk limit plus
/// part of the second it keeps in reserve.
fn join_limit(rate: u32) -> usize {
  chunk_limit(rate) + samples_in(JOIN_RESERVE_MILLIS, rate)
}

/// Where to cut inside `search`: the middle of its quietest `window`-long
/// stretch, so a boundary falls in a pause rather than inside a word.
fn quietest_cut(samples: &[f32], search: Range<usize>, window: usize) -> usize {
  let search = search.start.min(samples.len())..search.end.min(samples.len());
  if window == 0 || search.len() <= window {
    return search.start + search.len() / 2;
  }
  let hop = (window / 4).max(1);
  let energy = |start: usize| {
    samples[start..start + window]
      .iter()
      .map(|sample| f64::from(*sample).powi(2))
      .sum::<f64>()
  };
  let quietest = (search.start..=search.end - window)
    .step_by(hop)
    .min_by(|left, right| energy(*left).total_cmp(&energy(*right)))
    .unwrap_or(search.start);
  quietest + window / 2
}

/// The pieces a dictation is uploaded in: each at most the chunk limit, cut
/// at the quietest moment of the last seconds before it. A final piece too
/// short to transcribe well joins the one before it when the two still fit
/// the API's limit; otherwise the two are split again around their middle.
pub fn chunk_bounds(samples: &[f32], rate: u32) -> Vec<Range<usize>> {
  let limit = chunk_limit(rate);
  let window = samples_in(QUIET_WINDOW_MILLIS, rate);
  let search = samples_in(CUT_SEARCH_MILLIS, rate).min(limit / 2);
  let mut bounds = Vec::new();
  let mut start = 0;
  while samples.len() - start > limit {
    let end = start + limit;
    let cut = quietest_cut(samples, end - search..end, window);
    bounds.push(start..cut);
    start = cut;
  }
  bounds.push(start..samples.len());
  let short_tail = bounds.len() >= 2
    && bounds
      .last()
      .is_some_and(|last| last.len() < samples_in(MIN_CHUNK_MILLIS, rate));
  if short_tail && let (Some(last), Some(previous)) = (bounds.pop(), bounds.pop()) {
    if last.end - previous.start <= join_limit(rate) {
      bounds.push(previous.start..last.end);
    } else {
      let middle = previous.start + (last.end - previous.start) / 2;
      let cut = quietest_cut(samples, middle - search / 2..middle + search / 2, window);
      bounds.push(previous.start..cut);
      bounds.push(cut..last.end);
    }
  }
  bounds
}

/// The chunks worth uploading: every piece that holds speech.
pub fn chunks(samples: &[f32], rate: u32) -> Vec<&[f32]> {
  chunk_bounds(samples, rate)
    .into_iter()
    .map(|range| &samples[range])
    .filter(|piece| holds_speech(piece))
    .collect()
}

fn client(timeout: Duration) -> Result<DesktopHttpClient, String> {
  DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(timeout),
  })
  .map_err(request_cause_logged(FAILURE))
}

async fn read_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
  if !response.status().is_success() {
    return Err(format!(
      "stella AI refused the request: {}",
      response.status()
    ));
  }
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(request_cause_logged(FAILURE))?
  {
    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err("stella AI answer is too large".to_string());
    }
    body.extend_from_slice(&chunk);
  }
  Ok(body)
}

/// `future`'s result, or `elapsed` once `limit` passes.
async fn within<T>(
  limit: Duration,
  elapsed: &str,
  future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
  tokio::time::timeout(limit, future)
    .await
    .unwrap_or_else(|_elapsed| Err(elapsed.to_string()))
}

/// The dictation account, read within the cleanup bound, and only while the
/// server enables stella AI transcription for that same account.
async fn cloud_account(app: &AppHandle) -> Result<AccountRequest, String> {
  let account = within(ACCOUNT_TIMEOUT, TIMED_OUT, dictation_account(app)).await?;
  let bound = app
    .try_state::<FeatureGates>()
    .and_then(|gates| gates.account_binding(DesktopFeature::DictationCloud))
    .is_some_and(|(_, namespace)| account.local_data_namespace() == namespace);
  if bound {
    Ok(account)
  } else {
    Err(UNAVAILABLE.to_string())
  }
}

#[derive(Deserialize)]
struct Transcript {
  text: String,
}

async fn send_chunk(
  account: &AccountRequest,
  wav: Vec<u8>,
  model_id: Option<&str>,
  language: Option<&str>,
) -> Result<String, String> {
  let file = reqwest::multipart::Part::bytes(wav)
    .file_name("dictation.wav")
    .mime_str("audio/wav")
    .map_err(request_cause_logged(FAILURE))?;
  let mut form = reqwest::multipart::Form::new().part("file", file);
  if let Some(model_id) = model_id {
    form = form.text("modelId", model_id.to_string());
  }
  if let Some(language) = language {
    form = form.text("language", language.to_string());
  }
  let response = crate::http_client::device_proof_request(
    client(CHUNK_TIMEOUT)?
      .post(format!(
        "{}{}",
        account.api_base_url,
        contract().transcribe_path
      ))
      .multipart(form),
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?
  .send()
  .await
  .map_err(request_cause_logged(FAILURE))?;
  let body = read_bounded(response).await?;
  // A serde error is never logged with its message: it can quote the text.
  serde_json::from_slice::<Transcript>(&body)
    .map(|transcript| transcript.text)
    .map_err(|_error| FAILURE.to_string())
}

/// Sends `pieces` in order, each within [`CHUNK_TIMEOUT`] and all within
/// `budget`, asking `allowed` before every one; the first refusal, failure or
/// timeout stops the rest.
async fn upload<F>(
  pieces: Vec<Vec<u8>>,
  budget: Duration,
  allowed: impl Fn() -> bool,
  mut send: impl FnMut(Vec<u8>) -> F,
) -> Result<String, String>
where
  F: Future<Output = Result<String, String>>,
{
  let deadline = tokio::time::Instant::now() + budget;
  let mut texts = Vec::with_capacity(pieces.len());
  for piece in pieces {
    if !allowed() {
      return Err(STOPPED.to_string());
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
      return Err(TIMED_OUT.to_string());
    }
    let text = within(CHUNK_TIMEOUT.min(remaining), TIMED_OUT, send(piece)).await?;
    texts.push(text.trim().to_string());
  }
  Ok(
    texts
      .into_iter()
      .filter(|text| !text.is_empty())
      .collect::<Vec<_>>()
      .join(" "),
  )
}

/// The model a dictation uses: the stored one while the region still offers
/// it, otherwise the region's default, which then replaces the stored one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelChoice {
  pub model_id: String,
  /// The stored model is missing or no longer offered.
  pub replaces_stored: bool,
}

pub fn choose_model(
  stored: Option<&str>,
  offered: &CloudModels,
) -> Option<ModelChoice> {
  if let Some(stored) = stored.filter(|stored| offered.offers(stored)) {
    return Some(ModelChoice {
      model_id: stored.to_string(),
      replaces_stored: false,
    });
  }
  offered
    .default_model_id
    .as_deref()
    .filter(|default| offered.offers(default))
    .or_else(|| offered.models.first().map(|model| model.id.as_str()))
    .map(|model_id| ModelChoice {
      model_id: model_id.to_string(),
      replaces_stored: true,
    })
}

async fn transcribe_chunks(
  app: &AppHandle,
  pieces: Vec<Vec<u8>>,
  stored_model: Option<&str>,
  language: Option<&str>,
) -> Result<String, String> {
  let offered = models(app).await?;
  let choice =
    choose_model(stored_model, &offered).ok_or_else(|| UNAVAILABLE.to_string())?;
  if choice.replaces_stored {
    dictation::adopt_cloud_model(app, &choice.model_id)?;
  }
  let model_id = choice.model_id;
  upload(
    pieces,
    DEADLINE,
    || dictation::cloud_chosen(app),
    |piece| {
      let model_id = model_id.clone();
      async move {
        let account = cloud_account(app).await?;
        let text = send_chunk(&account, piece, Some(&model_id), language).await;
        drop(account);
        text
      }
    },
  )
  .await
}

/// The audio's text from stella AI, chunk by chunk within [`DEADLINE`], or
/// an error that names no audio and no text.
pub fn transcribe(
  app: &AppHandle,
  samples: &[f32],
  rate: u32,
  model_id: Option<&str>,
  language: Option<&str>,
) -> Result<String, String> {
  let pieces = chunks(samples, rate)
    .into_iter()
    .map(|piece| wav(piece, rate))
    .collect::<Vec<_>>();
  if pieces
    .iter()
    .any(|piece| piece.len() > contract().max_audio_bytes)
  {
    return Err("dictation audio is larger than stella AI accepts".to_string());
  }
  if pieces.is_empty() {
    return Ok(String::new());
  }
  dictation_cleanup::bounded(
    DEADLINE,
    transcribe_chunks(app, pieces, model_id, language),
  )
  .unwrap_or_else(|| Err(TIMED_OUT.to_string()))
}

/// One model stella AI offers this organization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudModel {
  id: String,
  display_name: String,
}

/// The models stella AI offers this organization, as the API lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudModels {
  models: Vec<CloudModel>,
  default_model_id: Option<String>,
  unavailable: Option<String>,
}

impl CloudModels {
  pub fn offers(&self, model_id: &str) -> bool {
    self.models.iter().any(|model| model.id == model_id)
  }
}

pub async fn models(app: &AppHandle) -> Result<CloudModels, String> {
  let account = cloud_account(app).await?;
  let response = crate::http_client::device_proof_request(
    client(MODELS_TIMEOUT)?.get(format!(
      "{}{}",
      account.api_base_url,
      contract().models_path
    )),
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?
  .send()
  .await
  .map_err(request_cause_logged(FAILURE));
  drop(account);
  let body = read_bounded(response?).await?;
  serde_json::from_slice(&body).map_err(json_cause_logged(FAILURE))
}

#[cfg(test)]
mod tests {
  use std::sync::atomic::{AtomicUsize, Ordering};

  use super::*;
  use crate::dictation_format::{AppClass, Stroke, is_untyped};

  const RATE: u32 = 16_000;

  fn seconds(value: f64) -> usize {
    (value * f64::from(RATE)) as usize
  }

  /// A steady tone loud enough to count as speech, with a silent stretch of
  /// `pause` samples starting at each of `pauses`.
  fn speech(total: usize, pauses: &[usize], pause: usize) -> Vec<f32> {
    (0..total)
      .map(|index| {
        if pauses
          .iter()
          .any(|start| (*start..*start + pause).contains(&index))
        {
          0.0
        } else {
          0.3 * ((index as f32) * 0.05).sin()
        }
      })
      .collect()
  }

  fn models_fixture(default: Option<&str>) -> CloudModels {
    CloudModels {
      models: [
        "mistralai/voxtral-mini-transcribe",
        "openai/whisper-large-v3",
      ]
      .map(|id| CloudModel {
        id: id.to_string(),
        display_name: id.to_string(),
      })
      .to_vec(),
      default_model_id: default.map(ToString::to_string),
      unavailable: None,
    }
  }

  #[test]
  fn this_computer_never_falls_back_to_stella_ai() {
    assert_eq!(attempts(Destination::Local, true), vec![Attempt::Local]);
    assert_eq!(attempts(Destination::Local, false), vec![Attempt::Local]);
    let mut cloud_calls = 0;
    let result = transcribe_with(
      Destination::Local,
      true,
      || {
        cloud_calls += 1;
        Some("cloud".to_string())
      },
      || None,
    );
    assert_eq!(result, Err(Failure::Transcription));
    assert_eq!(cloud_calls, 0);
  }

  #[test]
  fn stella_ai_falls_back_to_this_computer_only_with_the_model_installed() {
    assert_eq!(
      attempts(Destination::Cloud, true),
      vec![Attempt::Cloud, Attempt::Local]
    );
    assert_eq!(attempts(Destination::Cloud, false), vec![Attempt::Cloud]);
    assert_eq!(
      transcribe_with(Destination::Cloud, true, || None, || Some("local".into())),
      Ok("local".to_string())
    );
    let mut local_calls = 0;
    let result = transcribe_with(
      Destination::Cloud,
      false,
      || None,
      || {
        local_calls += 1;
        Some("local".to_string())
      },
    );
    assert_eq!(result, Err(Failure::CloudTranscription));
    assert_eq!(local_calls, 0);
  }

  #[test]
  fn a_working_destination_answers_without_a_fallback() {
    let mut local_calls = 0;
    let result = transcribe_with(
      Destination::Cloud,
      true,
      || Some("cloud".to_string()),
      || {
        local_calls += 1;
        None
      },
    );
    assert_eq!(result, Ok("cloud".to_string()));
    assert_eq!(local_calls, 0);
  }

  #[test]
  fn a_missing_model_is_reported_for_this_computer() {
    assert_eq!(
      transcribe_with(Destination::Local, false, || None, || None),
      Err(Failure::ModelMissing)
    );
  }

  #[test]
  fn only_cloud_is_stored_as_stella_ai() {
    assert_eq!(Destination::parse(Some("cloud")), Destination::Cloud);
    for stored in [None, Some("local"), Some("Cloud"), Some("")] {
      assert_eq!(Destination::parse(stored), Destination::Local);
    }
    assert_eq!(
      Destination::parse(Some(Destination::Cloud.stored())),
      Destination::Cloud
    );
  }

  #[test]
  fn a_stored_stella_ai_choice_stays_local_without_the_server_decision() {
    assert_eq!(Destination::Cloud.effective(false), Destination::Local);
    assert_eq!(Destination::Local.effective(false), Destination::Local);
    assert_eq!(Destination::Local.effective(true), Destination::Local);
    assert_eq!(Destination::Cloud.effective(true), Destination::Cloud);
  }

  #[test]
  fn wav_is_a_16_bit_mono_pcm_file_of_the_samples() {
    let bytes = wav(&[0.0, 1.0, -1.0, 2.0], RATE);
    assert_eq!(bytes.len(), WAV_HEADER_BYTES + 8);
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(
      u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8,
      bytes.len()
    );
    assert_eq!(&bytes[8..16], b"WAVEfmt ");
    assert_eq!(u16::from_le_bytes([bytes[20], bytes[21]]), 1);
    assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 1);
    assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), RATE);
    assert_eq!(
      u32::from_le_bytes(bytes[28..32].try_into().unwrap()),
      RATE * 2
    );
    assert_eq!(&bytes[36..40], b"data");
    let samples = bytes[44..]
      .chunks(2)
      .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
      .collect::<Vec<_>>();
    assert_eq!(samples, vec![0, i16::MAX, -i16::MAX, i16::MAX]);
  }

  #[test]
  fn every_chunk_fits_the_api_limits_and_the_pieces_cover_the_audio() {
    let ten_minutes = speech(seconds(600.0), &[], 0);
    let bounds = chunk_bounds(&ten_minutes, RATE);
    assert_eq!(bounds.first().map(|range| range.start), Some(0));
    assert_eq!(
      bounds.last().map(|range| range.end),
      Some(ten_minutes.len())
    );
    for pair in bounds.windows(2) {
      assert_eq!(pair[0].end, pair[1].start);
    }
    for range in &bounds {
      assert!(range.len() <= join_limit(RATE));
      assert!(range.len() >= seconds(1.0));
      assert!(
        wav(&ten_minutes[range.clone()], RATE).len() <= contract().max_audio_bytes
      );
    }
    assert!(join_limit(RATE) < contract().max_audio_seconds * RATE as usize);
    assert_eq!(chunk_bounds(&[0.0; 10], RATE), vec![0..10]);
  }

  #[test]
  fn a_chunk_is_cut_in_the_quietest_moment_before_the_limit() {
    let limit = chunk_limit(RATE);
    // A pause two and a half seconds before the limit.
    let pause = limit - seconds(2.5);
    let audio = speech(limit + seconds(20.0), &[pause], seconds(0.3));
    let bounds = chunk_bounds(&audio, RATE);
    assert_eq!(bounds.len(), 2);
    let cut = bounds[0].end;
    assert!(
      (pause..pause + seconds(0.3)).contains(&cut),
      "cut at {cut}, pause at {pause}"
    );
    // Without a pause the cut still falls within the last five seconds.
    let steady = speech(limit + seconds(20.0), &[], 0);
    let cut = chunk_bounds(&steady, RATE)[0].end;
    assert!((limit - seconds(5.0)..=limit).contains(&cut));
  }

  #[test]
  fn a_final_piece_under_a_second_joins_or_rebalances_the_one_before() {
    let limit = chunk_limit(RATE);
    // A pause right before the limit leaves a tail of half a second, and the
    // two still fit the API's limit together: one chunk.
    let joined = speech(limit + seconds(0.4), &[limit - seconds(0.2)], seconds(0.2));
    assert_eq!(chunk_bounds(&joined, RATE), vec![0..joined.len()]);
    // A longer total does not fit: the two are split again near the middle.
    let full = speech(limit + seconds(0.8), &[limit - seconds(0.2)], seconds(0.2));
    let bounds = chunk_bounds(&full, RATE);
    assert_eq!(bounds.len(), 2, "{bounds:?}");
    assert_eq!(bounds[0].start, 0);
    assert_eq!(bounds[0].end, bounds[1].start);
    assert_eq!(bounds[1].end, full.len());
    for range in &bounds {
      assert!(range.len() >= seconds(25.0), "{range:?}");
      assert!(range.len() <= limit);
    }
  }

  #[test]
  fn silent_pieces_are_not_uploaded() {
    let limit = chunk_limit(RATE);
    let mut audio = speech(limit + seconds(10.0), &[], 0);
    for sample in &mut audio[limit - seconds(5.0)..] {
      *sample = 0.0;
    }
    assert_eq!(chunk_bounds(&audio, RATE).len(), 2);
    assert_eq!(chunks(&audio, RATE).len(), 1);
  }

  #[test]
  fn the_stored_model_is_used_only_while_the_region_offers_it() {
    let offered = models_fixture(Some("openai/whisper-large-v3"));
    assert_eq!(
      choose_model(Some("mistralai/voxtral-mini-transcribe"), &offered),
      Some(ModelChoice {
        model_id: "mistralai/voxtral-mini-transcribe".to_string(),
        replaces_stored: false,
      })
    );
    for stale in [Some("retired/model"), None] {
      assert_eq!(
        choose_model(stale, &offered),
        Some(ModelChoice {
          model_id: "openai/whisper-large-v3".to_string(),
          replaces_stored: true,
        }),
        "{stale:?}"
      );
    }
    assert_eq!(
      choose_model(Some("retired/model"), &models_fixture(None))
        .map(|choice| choice.model_id),
      Some("mistralai/voxtral-mini-transcribe".to_string())
    );
    let none = CloudModels {
      models: Vec::new(),
      default_model_id: None,
      unavailable: Some("region".to_string()),
    };
    assert_eq!(choose_model(Some("retired/model"), &none), None);
  }

  #[tokio::test]
  async fn the_choice_is_read_again_before_every_chunk() {
    let checks = AtomicUsize::new(0);
    let sent = AtomicUsize::new(0);
    let result = upload(
      vec![vec![1], vec![2], vec![3]],
      DEADLINE,
      // stella AI stays chosen for the first chunk only.
      || checks.fetch_add(1, Ordering::SeqCst) == 0,
      |_piece| {
        sent.fetch_add(1, Ordering::SeqCst);
        async { Ok("first".to_string()) }
      },
    )
    .await;
    assert_eq!(result, Err(STOPPED.to_string()));
    assert_eq!(sent.load(Ordering::SeqCst), 1);
    assert_eq!(checks.load(Ordering::SeqCst), 2);
  }

  #[test]
  fn a_stopped_upload_falls_back_to_this_computer_only_with_its_model() {
    // The upload stops once the choice changes; the dictation then follows
    // the same fallback as any other stella AI failure.
    assert_eq!(
      transcribe_with(Destination::Cloud, true, || None, || Some("local".into())),
      Ok("local".to_string())
    );
    assert_eq!(
      transcribe_with(Destination::Cloud, false, || None, || Some("local".into())),
      Err(Failure::CloudTranscription)
    );
  }

  #[tokio::test]
  async fn every_chunk_answers_in_order_while_the_choice_holds() {
    let mut order = 0;
    let result = upload(
      vec![vec![1], vec![2], vec![3]],
      DEADLINE,
      || true,
      |_piece| {
        order += 1;
        let text = if order == 2 {
          " ".to_string()
        } else {
          format!(" part {order} ")
        };
        async move { Ok(text) }
      },
    )
    .await;
    assert_eq!(result, Ok("part 1 part 3".to_string()));
  }

  #[tokio::test(start_paused = true)]
  async fn a_chunk_that_never_answers_fails_by_the_chunk_timeout() {
    let sent = AtomicUsize::new(0);
    let result = upload(
      vec![vec![1], vec![2]],
      DEADLINE,
      || true,
      |_piece| {
        sent.fetch_add(1, Ordering::SeqCst);
        std::future::pending::<Result<String, String>>()
      },
    )
    .await;
    // A pending answer ends only by a timer; the paused clock runs it.
    assert_eq!(result, Err(TIMED_OUT.to_string()));
    assert_eq!(sent.load(Ordering::SeqCst), 1);
    assert_eq!(CHUNK_TIMEOUT, Duration::from_secs(30));
  }

  #[tokio::test(start_paused = true)]
  async fn no_chunk_is_sent_once_the_dictation_deadline_passes() {
    let sent = AtomicUsize::new(0);
    let result = upload(
      vec![vec![1]; 6],
      DEADLINE,
      || true,
      |_piece| {
        sent.fetch_add(1, Ordering::SeqCst);
        async {
          // Each answer arrives just inside the chunk timeout.
          tokio::time::advance(CHUNK_TIMEOUT - Duration::from_secs(1)).await;
          Ok("part".to_string())
        }
      },
    )
    .await;
    // Four answers take 116 s; the fifth may use only the 4 s left, and with
    // the deadline gone no sixth chunk is sent. Chunk timeouts alone would
    // have sent all six.
    assert_eq!(result, Err(TIMED_OUT.to_string()));
    assert_eq!(sent.load(Ordering::SeqCst), 5);
    assert_eq!(DEADLINE, Duration::from_secs(120));
  }

  #[tokio::test]
  async fn a_cloud_transcript_typed_raw_never_presses_return_or_types_a_control() {
    let answers = [
      "ls\r\n-la\n",
      "pwd\u{2028}rm\u{2029}\u{202E}x\u{2066}\u{1b}[A",
    ];
    let mut next = answers.iter();
    let transcript = upload(
      vec![vec![1], vec![2]],
      DEADLINE,
      || true,
      |_piece| {
        let text = next.next().copied().unwrap_or_default().to_string();
        async move { Ok(text) }
      },
    )
    .await
    .unwrap();
    assert!(transcript.contains(['\r', '\n', '\u{2028}', '\u{202E}']));
    // Cleanup off, refused, timed out or skipped: the transcript is typed raw.
    for class in [
      AppClass::Terminal,
      AppClass::Other,
      AppClass::Chat,
      AppClass::Rich,
    ] {
      let strokes = dictation_cleanup::strokes(&transcript, None, class);
      let [Stroke::Text(text)] = strokes.as_slice() else {
        panic!("{class:?} gets a keystroke from a raw transcript");
      };
      assert_eq!(text.as_str(), "ls  -la pwd rm x [A ", "{class:?}");
      assert!(!text.as_str().chars().any(is_untyped), "{class:?}");
    }
  }

  #[test]
  fn the_contract_paths_are_versioned_desktop_routes() {
    assert!(contract().models_path.starts_with("/v1/desktop/"));
    assert!(contract().transcribe_path.starts_with("/v1/desktop/"));
  }

  #[test]
  fn a_listed_model_is_offered_and_an_unknown_answer_is_refused() {
    let models: CloudModels = serde_json::from_str(
      r#"{"models":[{"id":"mistralai/voxtral-mini-transcribe","displayName":"Voxtral Mini Transcribe"}],"defaultModelId":"mistralai/voxtral-mini-transcribe","unavailable":null}"#,
    )
    .unwrap();
    assert!(models.offers("mistralai/voxtral-mini-transcribe"));
    assert!(!models.offers("openai/whisper-large-v3"));
    assert!(
      serde_json::from_str::<CloudModels>(
        r#"{"models":[],"defaultModelId":null,"unavailable":null,"price":1}"#
      )
      .is_err()
    );
  }
}
