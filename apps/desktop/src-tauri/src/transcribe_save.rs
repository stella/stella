//! Saving a transcribed recording as Word documents: on this computer
//! through the native save dialog, or in a matter as a folder named after
//! the recording that holds the transcript, the cleaned-up text and the
//! original recording.
//!
//! The recording is the file the window holds, never a path the webview
//! names. It is read twice, never whole: once for its checksum, once while
//! it streams to the presigned upload URL the API signed against that
//! checksum and its size.

use std::{
  collections::BTreeMap,
  io::Read,
  path::{Path, PathBuf},
  sync::Arc,
  time::Duration,
};

use futures_util::stream;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Window};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncReadExt;

use crate::{
  dictation_cloud,
  docx_writer::{self, Block},
  http_client::{DesktopHttpClient, HttpClientOptions},
  transcribe_recording::{
    TRANSCRIBE_WINDOW_LABEL, chosen_recording, extension, file_name, require_available,
    require_window, valid_id,
  },
};

/// The window hears how a save to a matter is getting on.
const PROGRESS_EVENT: &str = "transcribe-save-progress";
/// The most text a save takes: the transcript or the cleaned-up text.
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 200;
/// The contract's bounds on what a folder is filed with.
const MAX_DOCUMENT_NAME_CHARS: usize = 220;
const MAX_LABEL_CHARS: usize = 100;
const MAX_MARKDOWN_CHARS: usize = 1_200_000;
const MAX_INSTRUCTIONS: usize = 200;
const MAX_INSTRUCTION_CHARS: usize = 2000;
/// A transcript is at most four hours, in at most this many paragraphs.
const MAX_PARAGRAPHS: usize = 2000;
const MAX_PARAGRAPH_CHARS: usize = 10_000;
const MAX_START_MS: u64 = 4 * 60 * 60 * 1000;
/// How long one PUT of the recording may run: the largest matter document
/// on a link of about one megabit, as the web app and the CLI allow.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const READ_CHUNK_BYTES: usize = 256 * 1024;
const SAVE_FAILURE: &str = "the transcript could not be saved to the matter";
const AUDIO_FAILURE: &str = "the recording could not be saved to the matter";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Paragraph {
  start_ms: u64,
  text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cleaned {
  markdown: String,
  #[serde(default)]
  instructions: Vec<String>,
}

fn chars(text: &str) -> usize {
  text.chars().count()
}

fn bounded_name(text: &str, max: usize, what: &str) -> Result<(), String> {
  let length = chars(text.trim());
  if length == 0 || length > max {
    return Err(format!("the {what} is empty or too long"));
  }
  Ok(())
}

fn valid_paragraphs(paragraphs: &[Paragraph]) -> Result<(), String> {
  let total = paragraphs
    .iter()
    .map(|paragraph| paragraph.text.len())
    .sum::<usize>();
  if paragraphs.is_empty()
    || paragraphs.len() > MAX_PARAGRAPHS
    || total > MAX_TEXT_BYTES
    || paragraphs.iter().any(|paragraph| {
      paragraph.start_ms > MAX_START_MS || chars(&paragraph.text) > MAX_PARAGRAPH_CHARS
    })
  {
    return Err("the transcript is empty or too large to save".to_string());
  }
  Ok(())
}

fn valid_cleaned(cleaned: &Cleaned) -> Result<(), String> {
  let markdown = chars(cleaned.markdown.trim());
  if markdown == 0
    || markdown > MAX_MARKDOWN_CHARS
    || cleaned.markdown.len() > MAX_TEXT_BYTES
    || cleaned.instructions.len() > MAX_INSTRUCTIONS
    || cleaned.instructions.iter().any(|instruction| {
      let length = chars(instruction.trim());
      length == 0 || length > MAX_INSTRUCTION_CHARS
    })
  {
    return Err("the cleaned-up text is empty or too large to save".to_string());
  }
  Ok(())
}

fn title(text: &str) -> String {
  text.trim().chars().take(MAX_TITLE_CHARS).collect()
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DocxKind {
  /// The transcript with the time each paragraph starts.
  Raw,
  /// The cleaned-up text from its Markdown.
  Cleaned,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDocxRequest {
  kind: DocxKind,
  title: String,
  /// The name the save dialog suggests; the title when absent.
  file_name: Option<String>,
  #[serde(default)]
  paragraphs: Vec<Paragraph>,
  markdown: Option<String>,
  #[serde(default)]
  instructions: Vec<String>,
  /// The label above the instructions, in the member's language.
  instructions_label: Option<String>,
}

/// The document a local save writes, once the request holds what its kind
/// needs within bounds.
fn docx_blocks(request: &SaveDocxRequest) -> Result<Vec<Block>, String> {
  bounded_name(&request.title, MAX_TITLE_CHARS, "title")?;
  match request.kind {
    DocxKind::Raw => {
      valid_paragraphs(&request.paragraphs)?;
      Ok(docx_writer::transcript_blocks(
        &title(&request.title),
        request
          .paragraphs
          .iter()
          .map(|paragraph| (paragraph.start_ms, paragraph.text.as_str())),
      ))
    }
    DocxKind::Cleaned => {
      let cleaned = Cleaned {
        markdown: request.markdown.clone().unwrap_or_default(),
        instructions: request.instructions.clone(),
      };
      valid_cleaned(&cleaned)?;
      let label = request.instructions_label.as_deref().unwrap_or_default();
      if !cleaned.instructions.is_empty() {
        bounded_name(label, MAX_LABEL_CHARS, "instructions label")?;
      }
      Ok(docx_writer::cleaned_blocks(
        &cleaned.markdown,
        &cleaned.instructions,
        label,
      ))
    }
  }
}

/// A `.docx` file name from what the window suggested, without path
/// separators or characters file systems refuse.
fn docx_file_name(suggested: &str) -> String {
  let cleaned = suggested
    .chars()
    .filter(|character| !character.is_control())
    .map(|character| match character {
      '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
      other => other,
    })
    .take(MAX_DOCUMENT_NAME_CHARS)
    .collect::<String>();
  let cleaned = cleaned.trim().trim_start_matches('.').trim();
  let stem = cleaned
    .strip_suffix(".docx")
    .or_else(|| cleaned.strip_suffix(".DOCX"))
    .unwrap_or(cleaned)
    .trim();
  if stem.is_empty() {
    "Transcript.docx".to_string()
  } else {
    format!("{stem}.docx")
  }
}

/// Saves the transcript or the cleaned-up text as a Word document where
/// the user picks; `false` when they cancel.
#[tauri::command]
pub async fn transcribe_save_docx(
  app: AppHandle,
  window: Window,
  request: SaveDocxRequest,
) -> Result<bool, String> {
  require_window(&window)?;
  let bytes = docx_writer::docx(&docx_blocks(&request)?)?;
  let suggested =
    docx_file_name(request.file_name.as_deref().unwrap_or(&request.title));
  let (picked, answer) = tokio::sync::oneshot::channel();
  let mut dialog = app
    .dialog()
    .file()
    .set_file_name(&suggested)
    .add_filter("Word", &["docx"]);
  if let Some(parent) = app.get_webview_window(TRANSCRIBE_WINDOW_LABEL) {
    dialog = dialog.set_parent(&parent);
  }
  dialog.save_file(move |file| {
    if picked.send(file).is_err() {
      tracing::debug!("document save finished after its command ended");
    }
  });
  let Ok(Some(file)) = answer.await else {
    return Ok(false);
  };
  let path = file
    .into_path()
    .map_err(|_unreadable| "the chosen place has no path".to_string())?;
  tauri::async_runtime::spawn_blocking(move || {
    crate::local_store::write_private_atomic(&path, &bytes)
  })
  .await
  .map_err(|error| format!("the document could not be saved: {error}"))??;
  Ok(true)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveFolderRequest {
  matter_id: String,
  /// The recording's title, which names the folder.
  title: String,
  paragraphs: Vec<Paragraph>,
  /// The documents' names, in the member's language, without `.docx`.
  transcript_name: String,
  cleaned_name: String,
  /// The label above the dictation's instructions.
  instructions_label: String,
  cleaned: Option<Cleaned>,
  /// Whether the recording itself goes into the folder too.
  #[serde(default = "include_audio_by_default")]
  include_audio: bool,
}

const fn include_audio_by_default() -> bool {
  true
}

fn valid_folder_request(request: &SaveFolderRequest) -> Result<(), String> {
  valid_id(&request.matter_id)?;
  bounded_name(&request.title, MAX_TITLE_CHARS, "title")?;
  valid_paragraphs(&request.paragraphs)?;
  bounded_name(
    &request.transcript_name,
    MAX_DOCUMENT_NAME_CHARS,
    "document name",
  )?;
  bounded_name(
    &request.cleaned_name,
    MAX_DOCUMENT_NAME_CHARS,
    "document name",
  )?;
  bounded_name(
    &request.instructions_label,
    MAX_LABEL_CHARS,
    "instructions label",
  )?;
  request.cleaned.as_ref().map_or(Ok(()), valid_cleaned)
}

/// What the API is told about the recording before it is uploaded.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AudioDeclaration {
  name: String,
  mime_type: &'static str,
  size: u64,
  sha256_hex: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderNames<'a> {
  transcript_name: &'a str,
  cleaned_name: &'a str,
  instructions_label: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderBody<'a> {
  matter_id: &'a str,
  title: String,
  paragraphs: &'a [Paragraph],
  folder: FolderNames<'a>,
  #[serde(skip_serializing_if = "Option::is_none")]
  cleaned: Option<Cleaned>,
  #[serde(skip_serializing_if = "Option::is_none")]
  audio: Option<AudioDeclaration>,
}

fn folder_body<'a>(
  request: &'a SaveFolderRequest,
  audio: Option<AudioDeclaration>,
) -> FolderBody<'a> {
  FolderBody {
    matter_id: &request.matter_id,
    title: title(&request.title),
    paragraphs: &request.paragraphs,
    folder: FolderNames {
      transcript_name: request.transcript_name.trim(),
      cleaned_name: request.cleaned_name.trim(),
      instructions_label: request.instructions_label.trim(),
    },
    cleaned: request.cleaned.as_ref().map(|cleaned| Cleaned {
      markdown: cleaned.markdown.trim().to_string(),
      instructions: cleaned
        .instructions
        .iter()
        .map(|instruction| instruction.trim().to_string())
        .collect(),
    }),
    audio,
  }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
  /// `transcript` or `cleaned`.
  kind: String,
  file_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(
  tag = "status",
  rename_all = "snake_case",
  rename_all_fields = "camelCase"
)]
enum AudioReply {
  Upload {
    upload_id: String,
    url: String,
    headers: BTreeMap<String, String>,
  },
  TooLarge {
    max_bytes: u64,
  },
  Refused {
    message: String,
  },
  #[serde(other)]
  Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderReply {
  folder_name: String,
  files: Vec<SavedFile>,
  audio: Option<AudioReply>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioSavedReply {
  file_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioFinalizeBody<'a> {
  matter_id: &'a str,
  upload_id: &'a str,
}

/// What became of the recording.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  tag = "outcome"
)]
pub enum SavedAudio {
  /// It is in the folder under this name.
  Saved { file_name: String },
  /// It is larger than a matter document may be, so it was left out.
  TooLarge { max_bytes: u64 },
  /// It could not be uploaded or filed; the documents were saved.
  Failed,
  /// The window no longer holds it, so only the documents were saved.
  Missing,
  /// The window did not ask for it.
  NotIncluded,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFolder {
  folder_name: String,
  files: Vec<SavedFile>,
  audio: SavedAudio,
}

/// How a save to a matter is getting on, for the window to show.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  tag = "stage"
)]
enum SaveProgress {
  /// The recording's checksum is being read.
  Preparing,
  /// The folder and the documents are being filed.
  Documents,
  /// The recording is on its way.
  Uploading { sent_bytes: u64, total_bytes: u64 },
  /// The API is checking and filing the recording.
  Finishing,
}

fn report(app: &AppHandle, progress: &SaveProgress) {
  crate::logging::best_effort(
    app.emit_to(TRANSCRIBE_WINDOW_LABEL, PROGRESS_EVENT, progress),
    "save progress was not announced",
  );
}

/// The content type a matter shows the recording with, from its extension.
fn audio_mime_type(extension: Option<&str>) -> &'static str {
  match extension.unwrap_or_default() {
    "wav" => "audio/wav",
    "mp3" => "audio/mpeg",
    "m4a" => "audio/mp4",
    "aac" => "audio/aac",
    "flac" => "audio/flac",
    "ogg" | "oga" => "audio/ogg",
    "opus" => "audio/opus",
    "aif" | "aiff" | "aifc" => "audio/aiff",
    "wma" => "audio/x-ms-wma",
    "amr" => "audio/amr",
    "3gp" => "audio/3gpp",
    "mp4" | "m4v" => "video/mp4",
    "mov" => "video/quicktime",
    "webm" => "video/webm",
    "mkv" => "video/x-matroska",
    "caf" => "audio/x-caf",
    _ => "application/octet-stream",
  }
}

/// The file's size and SHA-256, read in pieces.
fn file_sha256(path: &Path) -> std::io::Result<(u64, String)> {
  let mut file = std::fs::File::open(path)?;
  let mut hasher = Sha256::new();
  let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
  let mut size = 0_u64;
  loop {
    let read = file.read(&mut buffer)?;
    if read == 0 {
      break;
    }
    hasher.update(&buffer[..read]);
    size += u64::try_from(read).unwrap_or(u64::MAX);
  }
  Ok((size, hex::encode(hasher.finalize())))
}

enum AudioPlan {
  Declared(AudioDeclaration),
  TooLarge(u64),
}

/// Declares the recording when it fits a matter document; the checksum is
/// read only then.
fn plan_audio(path: &Path, max_bytes: u64) -> Result<AudioPlan, String> {
  let declared_size = std::fs::metadata(path)
    .map_err(|error| format!("the recording could not be read: {error}"))?
    .len();
  if declared_size > max_bytes {
    return Ok(AudioPlan::TooLarge(max_bytes));
  }
  let (size, sha256_hex) = file_sha256(path)
    .map_err(|error| format!("the recording could not be read: {error}"))?;
  if size == 0 {
    return Err("the recording is empty".to_string());
  }
  if size > max_bytes {
    return Ok(AudioPlan::TooLarge(max_bytes));
  }
  let extension = extension(path);
  Ok(AudioPlan::Declared(AudioDeclaration {
    name: file_name(path),
    mime_type: audio_mime_type(extension.as_deref()),
    size,
    sha256_hex,
  }))
}

/// Where the recording may be uploaded: the presigned URL over HTTPS, or
/// over HTTP to a development server.
fn upload_url(url: &str) -> Result<reqwest::Url, String> {
  let parsed =
    reqwest::Url::parse(url).map_err(|_invalid| "the upload address is invalid")?;
  match parsed.scheme() {
    "https" => Ok(parsed),
    "http" if cfg!(debug_assertions) => Ok(parsed),
    _ => Err("the upload address is not secure".to_string()),
  }
}

/// PUTs the file to a presigned URL with the headers it was signed with,
/// streamed from disk in pieces, never held whole. `progress` hears the
/// bytes sent so far.
pub(crate) async fn put_file(
  client: &DesktopHttpClient,
  url: &str,
  headers: &BTreeMap<String, String>,
  path: &Path,
  size: u64,
  progress: Arc<dyn Fn(u64) + Send + Sync>,
) -> Result<(), String> {
  let url = upload_url(url)?;
  let file = tokio::fs::File::open(path)
    .await
    .map_err(|error| format!("the recording could not be read: {error}"))?;
  // Never more than was declared: the URL is signed for that length.
  let body = stream::try_unfold(
    (file.take(size), 0_u64, progress),
    |(mut file, sent, progress)| async move {
      let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
      let read = file.read(&mut buffer).await?;
      if read == 0 {
        return Ok::<_, std::io::Error>(None);
      }
      buffer.truncate(read);
      let sent = sent + u64::try_from(read).unwrap_or(u64::MAX);
      progress(sent);
      Ok(Some((buffer, (file, sent, progress))))
    },
  );
  let mut request = client.put(url).body(reqwest::Body::wrap_stream(body));
  for (name, value) in headers {
    request = request.header(name.as_str(), value.as_str());
  }
  let response = request
    .send()
    .await
    .map_err(crate::logging::request_cause_logged(AUDIO_FAILURE))?;
  if !response.status().is_success() {
    tracing::warn!(status = %response.status(), "recording upload refused");
    return Err(AUDIO_FAILURE.to_string());
  }
  Ok(())
}

/// Reports upload progress at most once per percent.
fn upload_progress(app: &AppHandle, total: u64) -> Arc<dyn Fn(u64) + Send + Sync> {
  let app = app.clone();
  let last = Arc::new(std::sync::atomic::AtomicU64::new(u64::MAX));
  Arc::new(move |sent| {
    let percent = sent.saturating_mul(100) / total.max(1);
    if last.swap(percent, std::sync::atomic::Ordering::Relaxed) != percent {
      report(
        &app,
        &SaveProgress::Uploading {
          sent_bytes: sent,
          total_bytes: total,
        },
      );
    }
  })
}

/// Uploads the recording the API reserved and has it filed in the folder.
async fn upload_audio(
  app: &AppHandle,
  matter_id: &str,
  path: &Path,
  size: u64,
  upload_id: &str,
  url: &str,
  headers: &BTreeMap<String, String>,
) -> Result<String, String> {
  let client = DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(UPLOAD_TIMEOUT),
  })
  .map_err(crate::logging::request_cause_logged(AUDIO_FAILURE))?;
  put_file(
    &client,
    url,
    headers,
    path,
    size,
    upload_progress(app, size),
  )
  .await?;
  report(app, &SaveProgress::Finishing);
  let reply = dictation_cloud::finalize_transcript_audio(
    app,
    &AudioFinalizeBody {
      matter_id,
      upload_id,
    },
    AUDIO_FAILURE,
  )
  .await?;
  serde_json::from_slice::<AudioSavedReply>(&reply)
    .map(|saved| saved.file_name)
    .map_err(|_error| AUDIO_FAILURE.to_string())
}

/// Saves the transcript to the matter as a folder named after the
/// recording: the transcript as a Word document, the cleaned-up text as a
/// second one when the window has it, and the recording itself when it
/// fits a matter document. The window hears `transcribe-save-progress`
/// meanwhile. A recording that cannot be saved does not undo the
/// documents; the reply says what became of it.
#[tauri::command]
pub async fn transcribe_save_to_matter_folder(
  app: AppHandle,
  window: Window,
  request: SaveFolderRequest,
) -> Result<SavedFolder, String> {
  require_window(&window)?;
  require_available(&app)?;
  valid_folder_request(&request)?;
  let recording: Option<PathBuf> = if request.include_audio {
    chosen_recording(&app)
  } else {
    None
  };
  let plan = match recording.clone() {
    Some(path) => {
      report(&app, &SaveProgress::Preparing);
      let max_bytes = dictation_cloud::max_transcript_audio_bytes();
      Some(
        tauri::async_runtime::spawn_blocking(move || plan_audio(&path, max_bytes))
          .await
          .map_err(|error| format!("the recording could not be read: {error}"))?,
      )
    }
    None => None,
  };
  // A recording that cannot be read is left out; the documents still go.
  let (declaration, mut audio) = match plan {
    Some(Ok(AudioPlan::Declared(declaration))) => {
      (Some(declaration), SavedAudio::Failed)
    }
    Some(Ok(AudioPlan::TooLarge(max_bytes))) => {
      (None, SavedAudio::TooLarge { max_bytes })
    }
    Some(Err(error)) => {
      tracing::warn!(%error, "recording left out of the matter folder");
      (None, SavedAudio::Failed)
    }
    None if request.include_audio => (None, SavedAudio::Missing),
    None => (None, SavedAudio::NotIncluded),
  };
  let declared_size = declaration.as_ref().map(|declared| declared.size);
  report(&app, &SaveProgress::Documents);
  let reply = dictation_cloud::save_transcript(
    &app,
    &folder_body(&request, declaration),
    SAVE_FAILURE,
  )
  .await?;
  let reply: FolderReply =
    serde_json::from_slice(&reply).map_err(|_error| SAVE_FAILURE.to_string())?;
  match (reply.audio, recording, declared_size) {
    (
      Some(AudioReply::Upload {
        upload_id,
        url,
        headers,
      }),
      Some(path),
      Some(size),
    ) => {
      audio = match upload_audio(
        &app,
        &request.matter_id,
        &path,
        size,
        &upload_id,
        &url,
        &headers,
      )
      .await
      {
        Ok(file_name) => SavedAudio::Saved { file_name },
        Err(error) => {
          tracing::warn!(%error, "recording not saved to the matter folder");
          SavedAudio::Failed
        }
      };
    }
    (Some(AudioReply::TooLarge { max_bytes }), _, _) => {
      audio = SavedAudio::TooLarge { max_bytes };
    }
    (Some(AudioReply::Refused { message }), _, _) => {
      tracing::warn!(%message, "the matter did not take the recording");
      audio = SavedAudio::Failed;
    }
    _ => {}
  }
  Ok(SavedFolder {
    folder_name: reply.folder_name,
    files: reply.files,
    audio,
  })
}

#[cfg(test)]
mod tests {
  use std::sync::{Mutex, atomic::AtomicU64};

  use axum::{Router, body::Bytes, http::HeaderMap, routing::put};

  use super::*;

  fn paragraph(text: &str) -> Paragraph {
    Paragraph {
      start_ms: 0,
      text: text.to_string(),
    }
  }

  fn folder_request() -> SaveFolderRequest {
    serde_json::from_value(serde_json::json!({
      "matterId": "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a8b",
      "title": "Diktát – odpověď na mail",
      "paragraphs": [{ "startMs": 0, "text": "Dobrý den." }],
      "transcriptName": "Diktát – odpověď na mail – přepis",
      "cleanedName": "Diktát – odpověď na mail – upravený text",
      "instructionsLabel": "Pokyny k diktátu:",
      "cleaned": { "markdown": "Dobrý den.", "instructions": ["Udělej z toho e-mail."] }
    }))
    .unwrap()
  }

  #[test]
  fn a_folder_request_is_bounded_and_names_a_plain_matter() {
    let request = folder_request();
    assert!(request.include_audio);
    assert!(valid_folder_request(&request).is_ok());
    let invalid = [
      SaveFolderRequest {
        matter_id: "a/b".to_string(),
        ..folder_request()
      },
      SaveFolderRequest {
        paragraphs: vec![],
        ..folder_request()
      },
      SaveFolderRequest {
        transcript_name: "  ".to_string(),
        ..folder_request()
      },
      SaveFolderRequest {
        instructions_label: "x".repeat(MAX_LABEL_CHARS + 1),
        ..folder_request()
      },
      SaveFolderRequest {
        cleaned: Some(Cleaned {
          markdown: "Text".to_string(),
          instructions: vec![String::new()],
        }),
        ..folder_request()
      },
      SaveFolderRequest {
        cleaned: Some(Cleaned {
          markdown: "Text".to_string(),
          instructions: vec!["x".to_string(); MAX_INSTRUCTIONS + 1],
        }),
        ..folder_request()
      },
    ];
    for request in invalid {
      assert!(valid_folder_request(&request).is_err(), "{request:?}");
    }
    // The webview never names a path, and unknown fields are refused.
    assert!(
      serde_json::from_value::<SaveFolderRequest>(serde_json::json!({
        "matterId": "m", "title": "t", "paragraphs": [], "transcriptName": "a",
        "cleanedName": "b", "instructionsLabel": "c", "path": "/etc/passwd"
      }))
      .is_err()
    );
  }

  #[test]
  fn the_api_gets_the_folder_names_cleaned_text_and_declared_recording() {
    let request = folder_request();
    let body = serde_json::to_value(folder_body(
      &request,
      Some(AudioDeclaration {
        name: "Diktát.m4a".to_string(),
        mime_type: "audio/mp4",
        size: 3,
        sha256_hex: "ab".repeat(32),
      }),
    ))
    .unwrap();
    assert_eq!(
      body,
      serde_json::json!({
        "matterId": "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a8b",
        "title": "Diktát – odpověď na mail",
        "paragraphs": [{ "startMs": 0, "text": "Dobrý den." }],
        "folder": {
          "transcriptName": "Diktát – odpověď na mail – přepis",
          "cleanedName": "Diktát – odpověď na mail – upravený text",
          "instructionsLabel": "Pokyny k diktátu:"
        },
        "cleaned": { "markdown": "Dobrý den.", "instructions": ["Udělej z toho e-mail."] },
        "audio": { "name": "Diktát.m4a", "mimeType": "audio/mp4", "size": 3, "sha256Hex": "ab".repeat(32) }
      })
    );
    let without = serde_json::to_value(folder_body(
      &SaveFolderRequest {
        cleaned: None,
        ..folder_request()
      },
      None,
    ))
    .unwrap();
    assert!(without.get("cleaned").is_none());
    assert!(without.get("audio").is_none());
  }

  #[test]
  fn the_window_reads_the_folder_and_what_became_of_the_recording() {
    let reply: FolderReply = serde_json::from_value(serde_json::json!({
      "fileName": "a.docx",
      "folderName": "Diktát (2)",
      "files": [{ "kind": "transcript", "fileName": "a.docx" }],
      "audio": { "status": "too_large", "maxBytes": 10 }
    }))
    .unwrap();
    assert!(matches!(
      reply.audio,
      Some(AudioReply::TooLarge { max_bytes: 10 })
    ));
    let upload: AudioReply = serde_json::from_value(serde_json::json!({
      "status": "upload", "uploadId": "u", "url": "https://s3.example/x",
      "expiresAt": "2026-11-20T12:00:00.000Z", "headers": { "content-length": "3" }
    }))
    .unwrap();
    assert!(matches!(upload, AudioReply::Upload { .. }));
    let newer: AudioReply =
      serde_json::from_value(serde_json::json!({ "status": "later" })).unwrap();
    assert!(matches!(newer, AudioReply::Unknown));
    assert_eq!(
      serde_json::to_value(SavedFolder {
        folder_name: "Diktát".to_string(),
        files: vec![],
        audio: SavedAudio::TooLarge { max_bytes: 5 },
      })
      .unwrap(),
      serde_json::json!({ "folderName": "Diktát", "files": [], "audio": { "outcome": "tooLarge", "maxBytes": 5 } })
    );
    assert_eq!(
      serde_json::to_value(SaveProgress::Uploading {
        sent_bytes: 1,
        total_bytes: 2
      })
      .unwrap(),
      serde_json::json!({ "stage": "uploading", "sentBytes": 1, "totalBytes": 2 })
    );
  }

  #[test]
  fn a_local_save_builds_the_kind_of_document_it_names() {
    let raw: SaveDocxRequest = serde_json::from_value(serde_json::json!({
      "kind": "raw", "title": "Memo", "paragraphs": [{ "startMs": 61000, "text": "First." }]
    }))
    .unwrap();
    let blocks = docx_blocks(&raw).unwrap();
    assert_eq!(blocks.len(), 2);
    let cleaned: SaveDocxRequest = serde_json::from_value(serde_json::json!({
      "kind": "cleaned", "title": "Memo", "markdown": "# Reply\n\n- one",
      "instructions": ["Formal."], "instructionsLabel": "Instructions:"
    }))
    .unwrap();
    assert!(matches!(
      docx_blocks(&cleaned).unwrap().first(),
      Some(Block::Note { .. })
    ));
    let unlabeled = SaveDocxRequest {
      instructions_label: None,
      ..cleaned.clone()
    };
    assert!(docx_blocks(&unlabeled).is_err());
    let empty = SaveDocxRequest {
      markdown: None,
      ..cleaned
    };
    assert!(docx_blocks(&empty).is_err());
    let no_paragraphs = SaveDocxRequest {
      paragraphs: vec![],
      ..raw
    };
    assert!(docx_blocks(&no_paragraphs).is_err());
    assert!(
      docx_blocks(&SaveDocxRequest {
        paragraphs: vec![paragraph(&"x".repeat(MAX_PARAGRAPH_CHARS + 1))],
        ..no_paragraphs
      })
      .is_err()
    );
  }

  #[test]
  fn suggested_docx_names_never_name_another_folder() {
    assert_eq!(docx_file_name("../Memo.docx"), "-Memo.docx");
    assert_eq!(docx_file_name("Memo cleaned up"), "Memo cleaned up.docx");
    assert_eq!(docx_file_name("  "), "Transcript.docx");
  }

  #[test]
  fn recordings_are_declared_with_their_type_size_and_checksum() {
    let directory =
      std::env::temp_dir().join(format!("stella-plan-{}", uuid::Uuid::new_v4()));
    crate::local_store::create_private_dir(&directory).unwrap();
    let path = directory.join("Diktát.m4a");
    crate::local_store::write_private_atomic(&path, b"abc").unwrap();
    let Ok(AudioPlan::Declared(declared)) = plan_audio(&path, 10) else {
      panic!("a small recording is declared");
    };
    assert_eq!(
      declared,
      AudioDeclaration {
        name: "Diktát.m4a".to_string(),
        mime_type: "audio/mp4",
        size: 3,
        sha256_hex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
          .to_string(),
      }
    );
    assert!(matches!(plan_audio(&path, 2), Ok(AudioPlan::TooLarge(2))));
    assert_eq!(audio_mime_type(Some("dss")), "application/octet-stream");
    std::fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn uploads_go_only_to_a_secure_address() {
    assert!(upload_url("https://bucket.s3.example/key?X-Amz-Signature=1").is_ok());
    assert!(upload_url("ftp://example.test/key").is_err());
    assert!(upload_url("not a url").is_err());
  }

  #[tokio::test]
  async fn a_file_streams_to_the_presigned_url_with_its_signed_headers() {
    let received: Arc<Mutex<Option<(HeaderMap, Bytes)>>> = Arc::default();
    let seen = Arc::clone(&received);
    let app = Router::new().route(
      "/upload",
      put(move |headers: HeaderMap, body: Bytes| {
        let seen = Arc::clone(&seen);
        async move {
          *seen.lock().unwrap() = Some((headers, body));
          ""
        }
      }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
      axum::serve(listener, app).await.unwrap();
    });

    let directory =
      std::env::temp_dir().join(format!("stella-put-{}", uuid::Uuid::new_v4()));
    crate::local_store::create_private_dir(&directory).unwrap();
    let path = directory.join("Recording.wav");
    // Several read pieces, so the body is streamed in more than one.
    let content = (0..(READ_CHUNK_BYTES * 2 + 17))
      .map(|index| u8::try_from(index % 251).unwrap())
      .collect::<Vec<_>>();
    crate::local_store::write_private_atomic(&path, &content).unwrap();
    let size = content.len() as u64;
    let headers = BTreeMap::from([
      ("content-type".to_string(), "audio/wav".to_string()),
      ("content-length".to_string(), size.to_string()),
      ("x-amz-checksum-sha256".to_string(), "checksum".to_string()),
    ]);
    let last = Arc::new(AtomicU64::new(0));
    let calls = Arc::new(AtomicU64::new(0));
    let progress: Arc<dyn Fn(u64) + Send + Sync> = {
      let (last, calls) = (Arc::clone(&last), Arc::clone(&calls));
      Arc::new(move |sent| {
        last.store(sent, std::sync::atomic::Ordering::SeqCst);
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
      })
    };
    let client = DesktopHttpClient::new(HttpClientOptions::default()).unwrap();
    put_file(
      &client,
      &format!("http://{address}/upload"),
      &headers,
      &path,
      size,
      progress,
    )
    .await
    .unwrap();

    let (headers, body) = received.lock().unwrap().take().expect("the PUT arrived");
    assert_eq!(body.as_ref(), content.as_slice());
    assert_eq!(headers["content-length"], size.to_string().as_str());
    assert!(headers.get("transfer-encoding").is_none());
    assert_eq!(headers["content-type"], "audio/wav");
    assert_eq!(headers["x-amz-checksum-sha256"], "checksum");
    assert_eq!(last.load(std::sync::atomic::Ordering::SeqCst), size);
    assert!(calls.load(std::sync::atomic::Ordering::SeqCst) >= 2);
    std::fs::remove_dir_all(directory).unwrap();
  }
}
