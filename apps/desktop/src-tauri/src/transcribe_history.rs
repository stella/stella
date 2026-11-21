//! The transcripts the "Transcribe a recording" window keeps on this
//! computer, so the user can open a past one again: each finished or
//! stopped transcription, with its cleaned version and where it was saved
//! once those exist. The recording itself is never kept here, only its
//! name, format and length.
//!
//! Each linked account has its own history under its local data namespace,
//! encrypted at rest under its own keychain key like the other local stores
//! (`apps/desktop/docs/local-only-data.md`): one file for the account's
//! retention choice, one index of what the list shows, and one file for
//! each transcript. A transcript is kept for the account's retention (30
//! days unless the user chose 7, 90, or not to keep any), at most
//! [`MAX_ENTRIES`] of them and [`MAX_TOTAL_BYTES`] of text in all, the
//! oldest going first. Expired transcripts of every account on this
//! computer are deleted at start, when the window opens and hourly.
//! Disconnecting an account deletes its history: an erase marker is
//! written first, so an erasure cut short finishes before that history is
//! opened again.
//!
//! Transcripts are the user's words: they are never logged and never sent
//! anywhere from here.

use std::{
  collections::{HashMap, HashSet},
  fs,
  path::{Path, PathBuf},
  sync::{Mutex, OnceLock, PoisonError},
  time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Window};

use crate::{
  feature_gate::{DesktopFeature, FeatureGates},
  keychain::LocalDataKey,
  local_store::{self, EncryptedJsonFile, EncryptedReadError, StoreKey},
  transcribe_recording::Failure,
};

/// Retention when the account never chose one.
const DEFAULT_RETENTION_DAYS: u16 = 30;
/// The retention choices, in days; 0 keeps nothing.
const RETENTION_CHOICES: [u16; 4] = [0, 7, 30, 90];
/// Transcripts one account keeps; the oldest go first.
const MAX_ENTRIES: usize = 500;
/// Text one account keeps in all; the oldest transcripts go first.
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// The raw transcript, and the cleaned one, each: what the window copies or
/// saves at most.
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PARAGRAPHS: usize = 100_000;
const MAX_INSTRUCTIONS: usize = 50;
const MAX_INSTRUCTION_CHARS: usize = 2_000;
const MAX_NAME_CHARS: usize = 200;
const MAX_FORMAT_CHARS: usize = 32;
const MAX_ID_CHARS: usize = 200;
/// Room a transcript takes besides its text, counted toward the total.
const ENTRY_OVERHEAD_BYTES: u64 = 1_024;
const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

const DIRECTORY: &str = "transcribe-history";
const ENTRIES_DIRECTORY: &str = "entries";
const SETTINGS_FILE: &str = "settings.json";
const INDEX_FILE: &str = "index.json";
const ERASE_MARKER: &str = "erase";
const LABEL: &str = "transcript history";
const DEBUG_PERSISTENCE_ENV: &str =
  "STELLA_ENABLE_DEBUG_TRANSCRIBE_HISTORY_PERSISTENCE";

const NO_ACCOUNT: &str = "transcript history needs a linked account";
const NOT_FOUND: &str = "this transcript is no longer kept";
const LOCKED: &str = "transcript history cannot be opened on this computer";

/// One paragraph of the raw transcript, where it starts in the recording.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
  start_ms: u64,
  text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatterRef {
  id: String,
  name: String,
}

/// The transcript after AI cleanup, and what the user asked cleanup to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleaned {
  markdown: String,
  #[serde(default)]
  instructions: Vec<String>,
}

/// Where the transcript was saved in stella.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedToMatter {
  matter_id: String,
  matter_name: String,
  folder_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
  Done,
  Stopped,
  Failed,
}

/// A transcript as the window hands it over and gets it back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
  file_name: String,
  format: String,
  #[serde(default)]
  duration_ms: Option<u64>,
  /// The stella AI model's display name, or `thisComputer`.
  model: String,
  #[serde(default)]
  matter: Option<MatterRef>,
  paragraphs: Vec<Paragraph>,
  #[serde(default)]
  cleaned: Option<Cleaned>,
  #[serde(default)]
  saved_to_matter: Option<SavedToMatter>,
  outcome: Outcome,
  /// Why it failed; only with a failed outcome.
  #[serde(default)]
  failure: Option<Failure>,
}

/// A kept transcript. `created_at` is in milliseconds since the epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
  id: String,
  created_at: i64,
  #[serde(flatten)]
  transcript: Transcript,
}

/// A kept transcript with the moment it will be deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
  #[serde(flatten)]
  entry: Entry,
  expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMatterName {
  matter_name: String,
}

/// A row of the history list: never the text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
  id: String,
  created_at: i64,
  file_name: String,
  duration_ms: Option<u64>,
  cleaned: bool,
  saved_to_matter: Option<SavedMatterName>,
  expires_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutRequest {
  /// The transcript to update in place; none keeps a new one.
  #[serde(default)]
  id: Option<String>,
  #[serde(flatten)]
  transcript: Transcript,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
  id: String,
  expires_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
  days: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
  retention_days: u16,
}

impl Default for Settings {
  fn default() -> Self {
    Self {
      retention_days: DEFAULT_RETENTION_DAYS,
    }
  }
}

/// What the list shows of one transcript, newest first in the index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
  id: String,
  created_at: i64,
  file_name: String,
  duration_ms: Option<u64>,
  cleaned: bool,
  saved_matter_name: Option<String>,
  bytes: u64,
}

impl Summary {
  fn of(entry: &Entry) -> Self {
    let transcript = &entry.transcript;
    let text: usize = transcript
      .paragraphs
      .iter()
      .map(|paragraph| paragraph.text.len())
      .sum::<usize>()
      + transcript.cleaned.as_ref().map_or(0, |cleaned| {
        cleaned.markdown.len()
          + cleaned.instructions.iter().map(String::len).sum::<usize>()
      });
    Self {
      id: entry.id.clone(),
      created_at: entry.created_at,
      file_name: transcript.file_name.clone(),
      duration_ms: transcript.duration_ms,
      cleaned: transcript.cleaned.is_some(),
      saved_matter_name: transcript
        .saved_to_matter
        .as_ref()
        .map(|saved| saved.matter_name.clone()),
      bytes: u64::try_from(text).unwrap_or(u64::MAX) + ENTRY_OVERHEAD_BYTES,
    }
  }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
  entries: Vec<Summary>,
  /// Transcripts being updated: named here before their file changes, so
  /// an update cut short before the index caught up is read again from
  /// the transcript, which is the truth.
  #[serde(default)]
  updating: Vec<String>,
}

/// Where one account's history lives: encrypted files, or memory alone.
trait Vault {
  fn load_settings(&self) -> Result<Option<Settings>, EncryptedReadError>;
  fn save_settings(&mut self, settings: &Settings) -> Result<(), String>;
  fn load_index(&self) -> Result<Option<Index>, EncryptedReadError>;
  fn save_index(&mut self, index: &Index) -> Result<(), String>;
  fn load_entry(&self, id: &str) -> Result<Option<Entry>, EncryptedReadError>;
  fn save_entry(&mut self, entry: &Entry) -> Result<(), String>;
  fn remove_entry(&mut self, id: &str) -> Result<(), String>;
  /// The transcripts stored, whatever the index says.
  fn entry_ids(&self) -> Result<Vec<String>, String>;
}

/// An id this store minted: a UUID, so it is safe in a file name.
fn parse_id(id: &str) -> Result<String, String> {
  uuid::Uuid::parse_str(id)
    .map(|id| id.hyphenated().to_string())
    .map_err(|_invalid| NOT_FOUND.to_string())
}

fn not_found(error: &std::io::Error) -> bool {
  error.kind() == std::io::ErrorKind::NotFound
}

struct DiskVault {
  directory: PathBuf,
  namespace: String,
  key: [u8; 32],
}

impl DiskVault {
  fn file(&self, path: PathBuf, purpose: &str) -> EncryptedJsonFile {
    EncryptedJsonFile::new(self.key, path, LABEL).with_associated_data(
      format!("transcribe-history:{purpose}:{}", self.namespace).into_bytes(),
    )
  }

  fn settings(&self) -> EncryptedJsonFile {
    self.file(self.directory.join(SETTINGS_FILE), "settings")
  }

  fn index(&self) -> EncryptedJsonFile {
    self.file(self.directory.join(INDEX_FILE), "index")
  }

  fn entries(&self) -> PathBuf {
    self.directory.join(ENTRIES_DIRECTORY)
  }

  fn entry(&self, id: &str) -> EncryptedJsonFile {
    self.file(
      self.entries().join(format!("{id}.json")),
      &format!("entry:{id}"),
    )
  }
}

impl Vault for DiskVault {
  fn load_settings(&self) -> Result<Option<Settings>, EncryptedReadError> {
    self.settings().load_checked()
  }

  fn save_settings(&mut self, settings: &Settings) -> Result<(), String> {
    self.settings().persist(settings)
  }

  fn load_index(&self) -> Result<Option<Index>, EncryptedReadError> {
    self.index().load_checked()
  }

  fn save_index(&mut self, index: &Index) -> Result<(), String> {
    self.index().persist(index)
  }

  fn load_entry(&self, id: &str) -> Result<Option<Entry>, EncryptedReadError> {
    self.entry(id).load_checked()
  }

  fn save_entry(&mut self, entry: &Entry) -> Result<(), String> {
    self.entry(&entry.id).persist(entry)
  }

  fn remove_entry(&mut self, id: &str) -> Result<(), String> {
    match local_store::remove_private(self.entry(id).path()) {
      Ok(()) => Ok(()),
      Err(error) if not_found(&error) => Ok(()),
      Err(error) => Err(format!("{LABEL} entry removal failed: {error}")),
    }
  }

  fn entry_ids(&self) -> Result<Vec<String>, String> {
    let listing = match fs::read_dir(self.entries()) {
      Ok(listing) => listing,
      Err(error) if not_found(&error) => return Ok(Vec::new()),
      Err(error) => return Err(format!("{LABEL} listing failed: {error}")),
    };
    stored_entry_ids(listing.map(|item| item.map(|item| item.path())))
  }
}

/// The transcript ids among the files of an entries directory. A listing
/// that fails partway is an error, never a shorter list: the index is
/// matched to it, and an id missing from it would read as a transcript gone.
fn stored_entry_ids(
  files: impl Iterator<Item = std::io::Result<PathBuf>>,
) -> Result<Vec<String>, String> {
  let mut ids = Vec::new();
  for file in files {
    let path = file.map_err(|error| format!("{LABEL} listing failed: {error}"))?;
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
      continue;
    };
    if let Some(id) = name.strip_suffix(".json")
      && let Ok(parsed) = parse_id(id)
      && parsed == id
    {
      ids.push(parsed);
    } else if name.ends_with(".tmp") {
      // A write cut short; every write here holds the store's lock.
      crate::logging::best_effort(
        local_store::remove_private(&path),
        "transcript history leftover was not removed",
      );
    }
  }
  Ok(ids)
}

/// A history kept for this run only: a debug build, or a keychain that
/// cannot hold the key while no history exists yet.
#[derive(Default)]
struct MemoryVault {
  settings: Option<Settings>,
  index: Option<Index>,
  entries: HashMap<String, Entry>,
}

impl Vault for MemoryVault {
  fn load_settings(&self) -> Result<Option<Settings>, EncryptedReadError> {
    Ok(self.settings)
  }

  fn save_settings(&mut self, settings: &Settings) -> Result<(), String> {
    self.settings = Some(*settings);
    Ok(())
  }

  fn load_index(&self) -> Result<Option<Index>, EncryptedReadError> {
    Ok(self.index.clone())
  }

  fn save_index(&mut self, index: &Index) -> Result<(), String> {
    self.index = Some(index.clone());
    Ok(())
  }

  fn load_entry(&self, id: &str) -> Result<Option<Entry>, EncryptedReadError> {
    Ok(self.entries.get(id).cloned())
  }

  fn save_entry(&mut self, entry: &Entry) -> Result<(), String> {
    self.entries.insert(entry.id.clone(), entry.clone());
    Ok(())
  }

  fn remove_entry(&mut self, id: &str) -> Result<(), String> {
    self.entries.remove(id);
    Ok(())
  }

  fn entry_ids(&self) -> Result<Vec<String>, String> {
    Ok(self.entries.keys().cloned().collect())
  }
}

fn clean_text(value: &str, max_chars: usize) -> String {
  value
    .chars()
    .filter(|character| !character.is_control())
    .take(max_chars)
    .collect::<String>()
    .trim()
    .to_string()
}

fn valid_matter_id(id: &str) -> Result<(), String> {
  if !id.is_empty()
    && id.len() <= MAX_ID_CHARS
    && id.chars().all(|character| {
      character.is_ascii_alphanumeric() || character == '-' || character == '_'
    })
  {
    Ok(())
  } else {
    Err("this matter cannot be kept in the history".to_string())
  }
}

/// The transcript as kept: names trimmed to their limits, sizes checked.
/// Too much text is refused whole, never cut.
fn normalized(mut transcript: Transcript) -> Result<Transcript, String> {
  transcript.file_name = clean_text(&transcript.file_name, MAX_NAME_CHARS);
  transcript.format = clean_text(&transcript.format, MAX_FORMAT_CHARS);
  transcript.model = clean_text(&transcript.model, MAX_NAME_CHARS);
  if let Some(matter) = &mut transcript.matter {
    valid_matter_id(&matter.id)?;
    matter.name = clean_text(&matter.name, MAX_NAME_CHARS);
  }
  if let Some(saved) = &mut transcript.saved_to_matter {
    valid_matter_id(&saved.matter_id)?;
    saved.matter_name = clean_text(&saved.matter_name, MAX_NAME_CHARS);
    saved.folder_name = clean_text(&saved.folder_name, MAX_NAME_CHARS);
  }
  let raw: usize = transcript
    .paragraphs
    .iter()
    .map(|paragraph| paragraph.text.len())
    .sum();
  if transcript.paragraphs.len() > MAX_PARAGRAPHS || raw > MAX_TEXT_BYTES {
    return Err("the transcript is too large to keep".to_string());
  }
  if let Some(cleaned) = &mut transcript.cleaned {
    if cleaned.markdown.len() > MAX_TEXT_BYTES {
      return Err("the cleaned transcript is too large to keep".to_string());
    }
    if cleaned.instructions.len() > MAX_INSTRUCTIONS
      || cleaned
        .instructions
        .iter()
        .any(|instruction| instruction.chars().count() > MAX_INSTRUCTION_CHARS)
    {
      return Err("the cleanup instructions are too long to keep".to_string());
    }
  }
  match transcript.outcome {
    Outcome::Failed if transcript.failure.is_none() => {
      return Err("a failed transcript names its failure".to_string());
    }
    Outcome::Failed => {}
    Outcome::Done | Outcome::Stopped => transcript.failure = None,
  }
  Ok(transcript)
}

fn expires_at(created_at: i64, days: u16) -> i64 {
  created_at.saturating_add(i64::from(days).saturating_mul(DAY_MS))
}

fn newest_first(entries: &mut [Summary]) {
  entries.sort_by(|a, b| {
    b.created_at
      .cmp(&a.created_at)
      .then_with(|| b.id.cmp(&a.id))
  });
}

/// How much one account keeps at most.
#[derive(Debug, Clone, Copy)]
struct Limits {
  entries: usize,
  total_bytes: u64,
}

const LIMITS: Limits = Limits {
  entries: MAX_ENTRIES,
  total_bytes: MAX_TOTAL_BYTES,
};

/// One account's history, loaded: its retention and its index.
struct History<'v> {
  vault: &'v mut dyn Vault,
  settings: Settings,
  index: Index,
  limits: Limits,
}

impl<'v> History<'v> {
  /// Opens the history, repairing what an interrupted write or a damaged
  /// file left: a damaged index is rebuilt from the transcripts, a
  /// transcript the index lost is listed again, and one that cannot be
  /// read is deleted. Expired transcripts go.
  fn open(vault: &'v mut dyn Vault, now: i64) -> Result<Self, String> {
    Self::open_within(vault, now, LIMITS)
  }

  fn open_within(
    vault: &'v mut dyn Vault,
    now: i64,
    limits: Limits,
  ) -> Result<Self, String> {
    let settings = match vault.load_settings() {
      Ok(settings) => settings.unwrap_or_default(),
      Err(EncryptedReadError::Unavailable(error)) => return Err(error),
      Err(EncryptedReadError::Unreadable(_) | EncryptedReadError::Incompatible(_)) => {
        tracing::warn!(
          "transcript history settings were unreadable; using the default"
        );
        Settings::default()
      }
    };
    let (index, mut changed) = match vault.load_index() {
      Ok(Some(index)) => (index, false),
      Ok(None) => (Index::default(), false),
      Err(EncryptedReadError::Unavailable(error)) => return Err(error),
      Err(EncryptedReadError::Unreadable(_) | EncryptedReadError::Incompatible(_)) => {
        tracing::warn!("transcript history index was unreadable; rebuilding it");
        (Index::default(), true)
      }
    };
    let mut history = Self {
      vault,
      settings,
      index,
      limits,
    };
    changed |= history.reconcile()?;
    changed |= history.prune(now)?;
    if changed {
      history.vault.save_index(&history.index)?;
    }
    Ok(history)
  }

  /// Matches the index to the transcripts stored.
  fn reconcile(&mut self) -> Result<bool, String> {
    let stored: HashSet<String> = self.vault.entry_ids()?.into_iter().collect();
    let before = self.index.entries.len();
    let mut listed = HashSet::new();
    self.index.entries.retain(|summary| {
      stored.contains(&summary.id) && listed.insert(summary.id.clone())
    });
    let mut changed = self.index.entries.len() != before;
    for id in stored.difference(&listed) {
      match self.vault.load_entry(id) {
        Ok(Some(entry)) if entry.id == *id => {
          self.index.entries.push(Summary::of(&entry));
        }
        Ok(_)
        | Err(
          EncryptedReadError::Unreadable(_) | EncryptedReadError::Incompatible(_),
        ) => {
          tracing::warn!("an unreadable kept transcript was deleted");
          self.vault.remove_entry(id)?;
        }
        Err(EncryptedReadError::Unavailable(error)) => return Err(error),
      }
      changed = true;
    }
    for id in std::mem::take(&mut self.index.updating) {
      changed = true;
      if !stored.contains(&id) {
        continue;
      }
      match self.vault.load_entry(&id) {
        Ok(Some(entry)) if entry.id == id => {
          self.index.entries.retain(|summary| summary.id != id);
          self.index.entries.push(Summary::of(&entry));
        }
        Ok(_)
        | Err(
          EncryptedReadError::Unreadable(_) | EncryptedReadError::Incompatible(_),
        ) => {
          tracing::warn!("an unreadable kept transcript was deleted");
          self.vault.remove_entry(&id)?;
          self.index.entries.retain(|summary| summary.id != id);
        }
        Err(EncryptedReadError::Unavailable(error)) => return Err(error),
      }
    }
    if changed {
      newest_first(&mut self.index.entries);
    }
    Ok(changed)
  }

  /// Deletes expired transcripts and the oldest beyond the limits. The
  /// files go before the index names them no more, so a cut-short prune
  /// never brings a transcript back.
  fn prune(&mut self, now: i64) -> Result<bool, String> {
    let days = self.settings.retention_days;
    let mut kept = 0usize;
    let mut bytes = 0u64;
    let mut dropped = Vec::new();
    for summary in &self.index.entries {
      let expired = days == 0 || expires_at(summary.created_at, days) <= now;
      if expired
        || kept >= self.limits.entries
        || bytes.saturating_add(summary.bytes) > self.limits.total_bytes
      {
        dropped.push(summary.id.clone());
      } else {
        kept += 1;
        bytes = bytes.saturating_add(summary.bytes);
      }
    }
    if dropped.is_empty() {
      return Ok(false);
    }
    for id in &dropped {
      self.vault.remove_entry(id)?;
    }
    let dropped: HashSet<_> = dropped.into_iter().collect();
    self
      .index
      .entries
      .retain(|summary| !dropped.contains(&summary.id));
    self.index.updating.retain(|id| !dropped.contains(id));
    Ok(true)
  }

  fn expires(&self, created_at: i64) -> i64 {
    expires_at(created_at, self.settings.retention_days)
  }

  fn list(&self) -> Vec<ListItem> {
    self
      .index
      .entries
      .iter()
      .map(|summary| ListItem {
        id: summary.id.clone(),
        created_at: summary.created_at,
        file_name: summary.file_name.clone(),
        duration_ms: summary.duration_ms,
        cleaned: summary.cleaned,
        saved_to_matter: summary
          .saved_matter_name
          .clone()
          .map(|matter_name| SavedMatterName { matter_name }),
        expires_at: self.expires(summary.created_at),
      })
      .collect()
  }

  fn forget(&mut self, id: &str) -> Result<(), String> {
    self.vault.remove_entry(id)?;
    self.index.entries.retain(|summary| summary.id != id);
    self.index.updating.retain(|updating| updating != id);
    self.vault.save_index(&self.index)
  }

  fn get(&mut self, id: &str) -> Result<EntryView, String> {
    let id = parse_id(id)?;
    if !self.index.entries.iter().any(|summary| summary.id == id) {
      return Err(NOT_FOUND.to_string());
    }
    match self.vault.load_entry(&id) {
      Ok(Some(entry)) if entry.id == id => Ok(EntryView {
        expires_at: self.expires(entry.created_at),
        entry,
      }),
      Ok(_)
      | Err(EncryptedReadError::Unreadable(_) | EncryptedReadError::Incompatible(_)) => {
        tracing::warn!("an unreadable kept transcript was deleted");
        self.forget(&id)?;
        Err(NOT_FOUND.to_string())
      }
      Err(EncryptedReadError::Unavailable(error)) => Err(error),
    }
  }

  /// Keeps a transcript, or updates the one `id` names; none while the
  /// account keeps no history.
  fn put(&mut self, request: PutRequest, now: i64) -> Result<Option<Kept>, String> {
    if self.settings.retention_days == 0 {
      return Ok(None);
    }
    let transcript = normalized(request.transcript)?;
    let updates = request.id.is_some();
    let entry = match request.id {
      Some(id) => {
        let id = parse_id(&id)?;
        let summary = self
          .index
          .entries
          .iter()
          .find(|summary| summary.id == id)
          .ok_or_else(|| NOT_FOUND.to_string())?;
        Entry {
          id,
          created_at: summary.created_at,
          transcript,
        }
      }
      None => Entry {
        id: uuid::Uuid::new_v4().hyphenated().to_string(),
        created_at: now,
        transcript,
      },
    };
    if updates {
      // The index names the update before the transcript changes: one cut
      // short is repaired from the transcript when the history next opens.
      self.index.updating.push(entry.id.clone());
      self.vault.save_index(&self.index)?;
    }
    self.vault.save_entry(&entry)?;
    let summary = Summary::of(&entry);
    self.index.entries.retain(|kept| kept.id != entry.id);
    self.index.updating.retain(|id| *id != entry.id);
    self.index.entries.push(summary);
    newest_first(&mut self.index.entries);
    self.prune(now)?;
    self.vault.save_index(&self.index)?;
    if !self.index.entries.iter().any(|kept| kept.id == entry.id) {
      // Already past retention, or larger than the limits allow.
      return Ok(None);
    }
    Ok(Some(Kept {
      expires_at: self.expires(entry.created_at),
      id: entry.id,
    }))
  }

  fn delete(&mut self, id: &str) -> Result<(), String> {
    let Ok(id) = parse_id(id) else {
      return Ok(());
    };
    self.forget(&id)
  }

  fn retention(&self) -> Retention {
    Retention {
      days: self.settings.retention_days,
    }
  }

  fn set_retention(&mut self, days: u16, now: i64) -> Result<Retention, String> {
    if !RETENTION_CHOICES.contains(&days) {
      return Err("this retention is not offered".to_string());
    }
    self.settings = Settings {
      retention_days: days,
    };
    // Deleting first: a choice to keep less never waits on a failed write.
    if self.prune(now)? {
      self.vault.save_index(&self.index)?;
    }
    self.vault.save_settings(&self.settings)?;
    Ok(self.retention())
  }
}

/// The time the store runs on, in milliseconds since the epoch.
fn now_ms() -> i64 {
  chrono::Utc::now().timestamp_millis()
}

fn history_root() -> Option<PathBuf> {
  dirs::data_dir()
    .map(|data| data.join(crate::config::APP_DATA_DIR_NAME).join(DIRECTORY))
}

fn memory_only() -> bool {
  static MEMORY_ONLY: OnceLock<bool> = OnceLock::new();
  *MEMORY_ONLY
    .get_or_init(|| local_store::debug_build_is_memory_only(DEBUG_PERSISTENCE_ENV))
}

/// Whether `name` is a namespace directory: the account digest.
fn is_namespace(name: &str) -> bool {
  name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn has_data(directory: &Path) -> bool {
  [SETTINGS_FILE, INDEX_FILE]
    .iter()
    .any(|file| directory.join(file).exists())
    || fs::read_dir(directory.join(ENTRIES_DIRECTORY))
      .is_ok_and(|mut entries| entries.next().is_some())
}

fn remove_file(path: &Path) -> Result<(), String> {
  match fs::remove_file(path) {
    Ok(()) => Ok(()),
    Err(error) if not_found(&error) => Ok(()),
    Err(error) => Err(format!("{LABEL} erase failed: {error}")),
  }
}

fn remove_dir(path: &Path) -> Result<(), String> {
  match fs::remove_dir_all(path) {
    Ok(()) => Ok(()),
    Err(error) if not_found(&error) => Ok(()),
    Err(error) => Err(format!("{LABEL} erase failed: {error}")),
  }
}

/// Deletes one account's history: the marker first, then the transcripts,
/// the index and the settings, the key, and the marker last, so an erasure
/// cut short is finished before the history opens again.
fn erase_directory(
  directory: &Path,
  delete_key: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
  if !directory.exists() {
    return delete_key();
  }
  let marker = directory.join(ERASE_MARKER);
  if !marker.exists() {
    local_store::write_private_atomic(&marker, b"")?;
  }
  finish_erasure(directory, delete_key)
}

fn finish_erasure(
  directory: &Path,
  delete_key: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
  remove_dir(&directory.join(ENTRIES_DIRECTORY))?;
  remove_file(&directory.join(INDEX_FILE))?;
  remove_file(&directory.join(SETTINGS_FILE))?;
  // Without data the old key is harmless; a later open finds and reuses it.
  if let Err(error) = delete_key() {
    tracing::warn!(error = %error, "transcript history key was not removed");
  }
  remove_file(&directory.join(ERASE_MARKER))?;
  remove_dir(directory)
}

fn delete_key(namespace: &str) -> Result<(), String> {
  crate::keychain::delete_local_data_key(LocalDataKey::TranscribeHistory(namespace))
}

/// How a history reaches its keychain key; tests stand in for the keychain.
trait HistoryKeys {
  fn resolve(&self, namespace: &str, data_exists: bool) -> StoreKey;
  fn delete(&self, namespace: &str) -> Result<(), String>;
}

struct Keychain;

impl HistoryKeys for Keychain {
  fn resolve(&self, namespace: &str, data_exists: bool) -> StoreKey {
    local_store::resolve_key(LocalDataKey::TranscribeHistory(namespace), data_exists)
  }

  fn delete(&self, namespace: &str) -> Result<(), String> {
    delete_key(namespace)
  }
}

/// Where the histories live: encrypted files under `root`, or memory alone.
#[derive(Clone, Copy)]
enum Storage<'a> {
  Memory,
  Disk {
    root: &'a Path,
    keys: &'a dyn HistoryKeys,
  },
}

impl<'a> Storage<'a> {
  fn of(root: Option<&'a Path>) -> Self {
    root.map_or(Self::Memory, |root| Self::Disk {
      root,
      keys: &Keychain,
    })
  }
}

/// The directory histories live under, or none for a run that keeps nothing
/// on disk.
fn storage_root() -> Option<PathBuf> {
  (!memory_only()).then(history_root).flatten()
}

#[derive(Default)]
struct Stores {
  /// Each account's history in memory: a run that keeps nothing on disk, or
  /// a keychain that could not hold the key yet.
  memory: HashMap<String, MemoryVault>,
  /// The feature-gate generation each disconnected account was erased at. A
  /// request bound to the account at that generation or before was queued
  /// for the account that left, and never writes its history back.
  disconnected: HashMap<String, u64>,
}

#[derive(Default)]
pub struct TranscribeHistoryState {
  stores: Mutex<Stores>,
}

/// Moves a history kept in memory to disk once the keychain holds its key:
/// the retention choice first, so keeping less is never lost, then the
/// transcripts it still keeps, then their index.
fn move_to_disk(
  from: &mut MemoryVault,
  to: &mut dyn Vault,
  now: i64,
) -> Result<(), String> {
  let (settings, index) = {
    let history = History::open(&mut *from, now)?;
    (history.settings, history.index)
  };
  if from.settings.is_some() {
    to.save_settings(&settings)?;
  }
  for summary in &index.entries {
    if let Some(entry) = from.entries.get(&summary.id) {
      to.save_entry(entry)?;
    }
  }
  if !index.entries.is_empty() {
    to.save_index(&index)?;
  }
  Ok(())
}

/// Opens the history of `namespace` and runs `apply` on it; the caller holds
/// the store's lock.
fn open_locked<T>(
  stores: &mut Stores,
  storage: Storage<'_>,
  namespace: &str,
  now: i64,
  apply: impl FnOnce(&mut History<'_>) -> Result<T, String>,
) -> Result<T, String> {
  let Storage::Disk { root, keys } = storage else {
    let vault = stores.memory.entry(namespace.to_string()).or_default();
    return apply(&mut History::open(vault, now)?);
  };
  let directory = root.join(namespace);
  if directory.join(ERASE_MARKER).exists() {
    finish_erasure(&directory, || keys.delete(namespace))?;
  }
  match keys.resolve(namespace, has_data(&directory)) {
    StoreKey::Key(key) => {
      let mut vault = DiskVault {
        directory,
        namespace: namespace.to_string(),
        key,
      };
      // The keychain answered again: what this run kept in memory meanwhile
      // moves to disk before the memory copy goes.
      if let Some(kept) = stores.memory.get_mut(namespace) {
        move_to_disk(kept, &mut vault, now)?;
        stores.memory.remove(namespace);
      }
      apply(&mut History::open(&mut vault, now)?)
    }
    StoreKey::MemoryOnly => {
      let vault = stores.memory.entry(namespace.to_string()).or_default();
      apply(&mut History::open(vault, now)?)
    }
    StoreKey::DeletionOnly => Err(LOCKED.to_string()),
  }
}

fn erase_locked(
  stores: &mut Stores,
  storage: Storage<'_>,
  namespace: &str,
) -> Result<(), String> {
  stores.memory.remove(namespace);
  match storage {
    Storage::Disk { root, keys } => {
      erase_directory(&root.join(namespace), || keys.delete(namespace))
    }
    Storage::Memory => Ok(()),
  }
}

impl TranscribeHistoryState {
  fn lock(&self) -> std::sync::MutexGuard<'_, Stores> {
    self.stores.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// Runs `apply` on the history of the account bound at the feature-gate
  /// `generation`, holding the store's lock throughout. A request bound
  /// before that account was disconnected is refused.
  #[allow(
    clippy::significant_drop_tightening,
    reason = "the lock serializes every read and write of the store"
  )]
  fn with_history<T>(
    &self,
    storage: Storage<'_>,
    namespace: &str,
    generation: u64,
    now: i64,
    apply: impl FnOnce(&mut History<'_>) -> Result<T, String>,
  ) -> Result<T, String> {
    let mut stores = self.lock();
    if stores
      .disconnected
      .get(namespace)
      .is_some_and(|&erased| generation <= erased)
    {
      return Err(NO_ACCOUNT.to_string());
    }
    open_locked(&mut stores, storage, namespace, now, apply)
  }

  fn erase(&self, storage: Storage<'_>, namespace: &str) -> Result<(), String> {
    erase_locked(&mut self.lock(), storage, namespace)
  }

  /// Erases the history of an account being disconnected. Requests bound to
  /// it at `generation` or before are refused from now on, so one queued
  /// behind this erasure never writes the history back.
  #[allow(
    clippy::significant_drop_tightening,
    reason = "the lock serializes every read and write of the store"
  )]
  fn erase_disconnected(
    &self,
    storage: Storage<'_>,
    namespace: &str,
    generation: u64,
  ) -> Result<(), String> {
    let mut stores = self.lock();
    let erased = stores
      .disconnected
      .entry(namespace.to_string())
      .or_insert(generation);
    *erased = (*erased).max(generation);
    erase_locked(&mut stores, storage, namespace)
  }

  /// Runs retention on one history that exists; never creates one.
  #[allow(
    clippy::significant_drop_tightening,
    reason = "the lock serializes every read and write of the store"
  )]
  fn sweep_one(
    &self,
    storage: Storage<'_>,
    namespace: &str,
    now: i64,
  ) -> Result<(), String> {
    let mut stores = self.lock();
    let on_disk = match storage {
      Storage::Disk { root, .. } => root.join(namespace).exists(),
      Storage::Memory => false,
    };
    if !on_disk && !stores.memory.contains_key(namespace) {
      return Ok(());
    }
    open_locked(&mut stores, storage, namespace, now, |_history| Ok(()))
  }

  /// Deletes expired transcripts of every account on this computer, and
  /// finishes erasures cut short.
  fn sweep(&self, storage: Storage<'_>, now: i64) {
    let namespaces: Vec<String> = self.lock().memory.keys().cloned().collect();
    let on_disk: Vec<String> = match storage {
      Storage::Disk { root, .. } => fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|item| item.file_name().to_str().map(str::to_string))
        .filter(|name| is_namespace(name))
        .collect(),
      Storage::Memory => Vec::new(),
    };
    let all: HashSet<String> = namespaces.into_iter().chain(on_disk).collect();
    for namespace in all {
      if self.sweep_one(storage, &namespace, now).is_err() {
        tracing::warn!("transcript history retention could not run for an account");
      }
    }
  }
}

/// The account the window transcribes for: the feature-gate generation it
/// is bound at, and its local data namespace.
fn binding(app: &AppHandle) -> Result<(u64, String), String> {
  app
    .try_state::<FeatureGates>()
    .and_then(|gates| gates.account_binding(DesktopFeature::Dictation))
    .ok_or_else(|| NO_ACCOUNT.to_string())
}

/// Runs `apply` on the current account's history away from the main thread.
async fn run<T: Send + 'static>(
  app: AppHandle,
  apply: impl FnOnce(&mut History<'_>, i64) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  let (generation, namespace) = binding(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    let now = now_ms();
    let root = storage_root();
    app.state::<TranscribeHistoryState>().with_history(
      Storage::of(root.as_deref()),
      &namespace,
      generation,
      now,
      |history| apply(history, now),
    )
  })
  .await
  .map_err(|_error| format!("{LABEL} is unavailable"))?
}

fn sweep_now(app: &AppHandle) {
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    if let Some(state) = app.try_state::<TranscribeHistoryState>() {
      let root = storage_root();
      state.sweep(Storage::of(root.as_deref()), now_ms());
    }
  });
}

/// Deletes expired transcripts now and every hour after.
pub(crate) fn start_retention_sweep(app: AppHandle) {
  tauri::async_runtime::spawn(async move {
    let mut interval = tokio::time::interval(SWEEP_INTERVAL);
    loop {
      interval.tick().await;
      sweep_now(&app);
    }
  });
}

/// The window opened: expired transcripts go before it lists any.
pub(crate) fn window_opened(app: &AppHandle) {
  sweep_now(app);
}

/// Deletes the history of an account being disconnected.
pub(crate) async fn erase_account(app: &AppHandle, namespace: String) {
  // Read while the account is still bound: every request bound to it so far
  // is refused once its history is erased. Unreadable gates refuse all.
  let generation = app
    .try_state::<FeatureGates>()
    .and_then(|gates| gates.generation())
    .unwrap_or(u64::MAX);
  let app = app.clone();
  let erased = tauri::async_runtime::spawn_blocking(move || {
    let root = storage_root();
    app
      .try_state::<TranscribeHistoryState>()
      .map_or(Ok(()), |state| {
        state.erase_disconnected(Storage::of(root.as_deref()), &namespace, generation)
      })
  })
  .await;
  if !matches!(erased, Ok(Ok(()))) {
    tracing::warn!("transcript history of a disconnected account was not erased yet");
  }
}

fn require(app: &AppHandle, window: &Window) -> Result<(), String> {
  crate::transcribe_recording::require_window(window)?;
  crate::transcribe_recording::require_available(app)
}

/// The kept transcripts, newest first, without their text.
#[tauri::command]
pub async fn transcribe_history_list(
  app: AppHandle,
  window: Window,
) -> Result<Vec<ListItem>, String> {
  require(&app, &window)?;
  run(app, |history, _now| Ok(history.list())).await
}

#[tauri::command]
pub async fn transcribe_history_get(
  app: AppHandle,
  window: Window,
  id: String,
) -> Result<EntryView, String> {
  require(&app, &window)?;
  run(app, move |history, _now| history.get(&id)).await
}

/// Keeps a transcript, or updates the one the request names; `null` while
/// the account keeps no history.
#[tauri::command]
pub async fn transcribe_history_put(
  app: AppHandle,
  window: Window,
  entry: PutRequest,
) -> Result<Option<Kept>, String> {
  require(&app, &window)?;
  run(app, move |history, now| history.put(entry, now)).await
}

#[tauri::command]
pub async fn transcribe_history_delete(
  app: AppHandle,
  window: Window,
  id: String,
) -> Result<(), String> {
  require(&app, &window)?;
  run(app, move |history, _now| history.delete(&id)).await
}

#[tauri::command]
pub async fn transcribe_history_get_retention(
  app: AppHandle,
  window: Window,
) -> Result<Retention, String> {
  require(&app, &window)?;
  run(app, |history, _now| Ok(history.retention())).await
}

/// Sets how long the account keeps transcripts; 0 deletes them all and
/// keeps none.
#[tauri::command]
pub async fn transcribe_history_set_retention(
  app: AppHandle,
  window: Window,
  days: u16,
) -> Result<Retention, String> {
  require(&app, &window)?;
  if days == 0 {
    // Choosing to keep nothing also clears a history whose key is lost.
    let (_generation, namespace) = binding(&app)?;
    let erasing = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
      let root = storage_root();
      erasing
        .state::<TranscribeHistoryState>()
        .erase(Storage::of(root.as_deref()), &namespace)
    })
    .await
    .map_err(|_error| format!("{LABEL} is unavailable"))??;
  }
  run(app, move |history, now| history.set_retention(days, now)).await
}

#[cfg(test)]
mod tests {
  use super::*;

  const NOW: i64 = 1_800_000_000_000;

  fn transcript(name: &str, text: &str) -> Transcript {
    Transcript {
      file_name: name.to_string(),
      format: "mp3".to_string(),
      duration_ms: Some(61_000),
      model: "thisComputer".to_string(),
      matter: None,
      paragraphs: vec![Paragraph {
        start_ms: 0,
        text: text.to_string(),
      }],
      cleaned: None,
      saved_to_matter: None,
      outcome: Outcome::Done,
      failure: None,
    }
  }

  fn new(transcript: Transcript) -> PutRequest {
    PutRequest {
      id: None,
      transcript,
    }
  }

  fn temp_directory() -> PathBuf {
    std::env::temp_dir().join(format!(
      "stella-transcribe-history-{}",
      uuid::Uuid::new_v4()
    ))
  }

  fn disk(directory: &Path, namespace: &str) -> DiskVault {
    DiskVault {
      directory: directory.to_path_buf(),
      namespace: namespace.to_string(),
      key: [7; 32],
    }
  }

  fn put(vault: &mut dyn Vault, transcript: Transcript, now: i64) -> Kept {
    History::open(vault, now)
      .unwrap()
      .put(new(transcript), now)
      .unwrap()
      .unwrap()
  }

  fn ids(vault: &mut dyn Vault, now: i64) -> Vec<String> {
    History::open(vault, now)
      .unwrap()
      .list()
      .into_iter()
      .map(|item| item.id)
      .collect()
  }

  #[test]
  fn a_transcript_is_kept_updated_in_place_and_read_back() {
    let directory = temp_directory();
    let mut vault = disk(&directory, "a");
    let first = put(&mut vault, transcript("memo.mp3", "Dobrý den."), NOW);
    assert_eq!(first.expires_at, NOW + 30 * DAY_MS);

    let mut cleaned = transcript("memo.mp3", "Dobrý den.");
    cleaned.cleaned = Some(Cleaned {
      markdown: "# Memo\n\nDobrý den.".to_string(),
      instructions: vec!["headings".to_string()],
    });
    cleaned.saved_to_matter = Some(SavedToMatter {
      matter_id: "m-1".to_string(),
      matter_name: "Novák v. Svoboda".to_string(),
      folder_name: "Recordings".to_string(),
    });
    let mut history = History::open(&mut vault, NOW + 5).unwrap();
    let updated = history
      .put(
        PutRequest {
          id: Some(first.id.clone()),
          transcript: cleaned.clone(),
        },
        NOW + 5,
      )
      .unwrap()
      .unwrap();
    // Updating keeps the id and the retention counted from the start.
    assert_eq!(updated, first);
    let list = history.list();
    assert_eq!(list.len(), 1);
    assert!(list[0].cleaned);
    assert_eq!(
      list[0].saved_to_matter,
      Some(SavedMatterName {
        matter_name: "Novák v. Svoboda".to_string()
      })
    );

    let view = History::open(&mut vault, NOW + 10)
      .unwrap()
      .get(&first.id)
      .unwrap();
    assert_eq!(view.entry.transcript, cleaned);
    assert_eq!(view.entry.created_at, NOW);
    assert_eq!(view.expires_at, NOW + 30 * DAY_MS);
    // Nothing is stored readable.
    for path in [
      directory.join(INDEX_FILE),
      vault.entry(&first.id).path().to_path_buf(),
    ] {
      let bytes = fs::read(path).unwrap();
      assert!(!String::from_utf8_lossy(&bytes).contains("Dobr"));
      assert!(!String::from_utf8_lossy(&bytes).contains("memo"));
    }
    fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn the_list_is_newest_first_and_carries_no_text() {
    let mut vault = MemoryVault::default();
    let a = put(&mut vault, transcript("a.wav", "first"), NOW);
    let c = put(&mut vault, transcript("c.wav", "third"), NOW + 2);
    let b = put(&mut vault, transcript("b.wav", "second"), NOW + 1);
    assert_eq!(ids(&mut vault, NOW + 3), vec![c.id, b.id, a.id]);
    let list =
      serde_json::to_string(&History::open(&mut vault, NOW + 3).unwrap().list())
        .unwrap();
    assert!(!list.contains("first") && !list.contains("second"));
    assert!(list.contains("\"createdAt\"") && list.contains("\"expiresAt\""));
  }

  #[test]
  fn an_update_of_an_unknown_transcript_is_refused() {
    let mut vault = MemoryVault::default();
    let mut history = History::open(&mut vault, NOW).unwrap();
    let request = PutRequest {
      id: Some(uuid::Uuid::new_v4().to_string()),
      transcript: transcript("a.wav", "x"),
    };
    assert_eq!(history.put(request, NOW), Err(NOT_FOUND.to_string()));
    assert_eq!(history.get("../../etc/passwd").unwrap_err(), NOT_FOUND);
    assert!(history.delete("../../etc/passwd").is_ok());
  }

  #[test]
  fn retention_deletes_expired_transcripts_by_the_clock() {
    let directory = temp_directory();
    let mut vault = disk(&directory, "a");
    let old = put(&mut vault, transcript("old.wav", "old"), NOW);
    let recent = put(&mut vault, transcript("new.wav", "new"), NOW + 20 * DAY_MS);
    assert_eq!(ids(&mut vault, NOW + 30 * DAY_MS - 1).len(), 2);
    assert_eq!(ids(&mut vault, NOW + 30 * DAY_MS), vec![recent.id.clone()]);
    // The expired transcript's file is gone too.
    assert!(!vault.entry(&old.id).path().exists());

    let mut history = History::open(&mut vault, NOW + 30 * DAY_MS).unwrap();
    assert_eq!(
      history.set_retention(7, NOW + 30 * DAY_MS),
      Ok(Retention { days: 7 })
    );
    assert!(history.list().is_empty());
    assert_eq!(
      History::open(&mut vault, NOW).unwrap().retention(),
      Retention { days: 7 }
    );
    assert!(
      History::open(&mut vault, NOW)
        .unwrap()
        .set_retention(14, NOW)
        .is_err()
    );
    fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn dont_keep_deletes_everything_and_keeps_nothing() {
    let mut vault = MemoryVault::default();
    put(&mut vault, transcript("a.wav", "a"), NOW);
    let mut history = History::open(&mut vault, NOW).unwrap();
    assert_eq!(history.set_retention(0, NOW), Ok(Retention { days: 0 }));
    assert!(history.list().is_empty());
    assert_eq!(history.put(new(transcript("b.wav", "b")), NOW), Ok(None));
    assert!(vault.entries.is_empty());
    let mut history = History::open(&mut vault, NOW).unwrap();
    assert_eq!(history.retention(), Retention { days: 0 });
    assert!(history.list().is_empty());
    // Choosing to keep again keeps new transcripts.
    history.set_retention(90, NOW).unwrap();
    assert_eq!(
      put(&mut vault, transcript("c.wav", "c"), NOW).expires_at,
      NOW + 90 * DAY_MS
    );
  }

  #[test]
  fn the_oldest_go_beyond_the_count_and_size_limits() {
    let mut vault = MemoryVault::default();
    let limits = Limits {
      entries: 3,
      total_bytes: MAX_TOTAL_BYTES,
    };
    let mut history = History::open_within(&mut vault, NOW, limits).unwrap();
    let mut kept = Vec::new();
    for offset in 0..4 {
      kept.push(
        history
          .put(new(transcript("a.wav", "x")), NOW + offset)
          .unwrap()
          .unwrap()
          .id,
      );
    }
    let listed: Vec<_> = history.list().into_iter().map(|item| item.id).collect();
    assert_eq!(
      listed,
      vec![kept[3].clone(), kept[2].clone(), kept[1].clone()]
    );
    assert_eq!(vault.entries.len(), 3);
    assert!(!vault.entries.contains_key(&kept[0]));

    // Two transcripts of 100 bytes of text fit in 2 × 1124 bytes; a third
    // pushes the oldest out.
    let mut vault = MemoryVault::default();
    let limits = Limits {
      entries: MAX_ENTRIES,
      total_bytes: 2 * (100 + ENTRY_OVERHEAD_BYTES),
    };
    let text = "x".repeat(100);
    let mut history = History::open_within(&mut vault, NOW, limits).unwrap();
    let mut kept = Vec::new();
    for offset in 0..3 {
      kept.push(
        history
          .put(new(transcript("a.wav", &text)), NOW + offset)
          .unwrap()
          .unwrap()
          .id,
      );
    }
    let listed: Vec<_> = history.list().into_iter().map(|item| item.id).collect();
    assert_eq!(listed, vec![kept[2].clone(), kept[1].clone()]);
    // One larger than the whole limit is not kept at all.
    let huge = "x".repeat(3_000);
    assert_eq!(
      history.put(new(transcript("a.wav", &huge)), NOW + 3),
      Ok(None)
    );
    assert_eq!(history.list().len(), 2);
  }

  #[test]
  fn too_much_text_is_refused_whole() {
    let mut vault = MemoryVault::default();
    let mut history = History::open(&mut vault, NOW).unwrap();
    let too_big = "x".repeat(MAX_TEXT_BYTES + 1);
    assert!(
      history
        .put(new(transcript("a.wav", &too_big)), NOW)
        .is_err()
    );
    let mut cleaned = transcript("a.wav", "ok");
    cleaned.cleaned = Some(Cleaned {
      markdown: too_big,
      instructions: Vec::new(),
    });
    assert!(history.put(new(cleaned), NOW).is_err());
    let mut failed = transcript("a.wav", "ok");
    failed.outcome = Outcome::Failed;
    assert!(history.put(new(failed.clone()), NOW).is_err());
    failed.failure = Some(Failure::Cloud);
    assert!(history.put(new(failed), NOW).unwrap().is_some());
    let mut bad_matter = transcript("a.wav", "ok");
    bad_matter.matter = Some(MatterRef {
      id: "../x".to_string(),
      name: "M".to_string(),
    });
    assert!(history.put(new(bad_matter), NOW).is_err());
    assert_eq!(history.list().len(), 1);
  }

  #[test]
  fn accounts_never_see_each_others_history() {
    let directory = temp_directory();
    let mut a = disk(&directory.join("a"), "a");
    let mut b = disk(&directory.join("b"), "b");
    let kept = put(&mut a, transcript("a.wav", "secret"), NOW);
    assert!(ids(&mut b, NOW).is_empty());
    assert!(History::open(&mut b, NOW).unwrap().get(&kept.id).is_err());
    // A file moved into another account's history does not decrypt there,
    // even under the same key.
    let target = b.entry(&kept.id).path().to_path_buf();
    local_store::create_private_dir(target.parent().unwrap()).unwrap();
    local_store::write_test_fixture(
      &target,
      fs::read(a.entry(&kept.id).path()).unwrap(),
    )
    .unwrap();
    assert!(ids(&mut b, NOW).is_empty());
    assert!(!target.exists());
    assert_eq!(ids(&mut a, NOW), vec![kept.id]);
    fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn a_damaged_index_is_rebuilt_and_a_damaged_transcript_deleted() {
    let directory = temp_directory();
    let mut vault = disk(&directory, "a");
    let a = put(&mut vault, transcript("a.wav", "a"), NOW);
    let b = put(&mut vault, transcript("b.wav", "b"), NOW + 1);
    History::open(&mut vault, NOW)
      .unwrap()
      .set_retention(90, NOW)
      .unwrap();
    local_store::write_test_fixture(directory.join(INDEX_FILE), b"{not an envelope")
      .unwrap();
    assert_eq!(ids(&mut vault, NOW + 2), vec![b.id.clone(), a.id.clone()]);

    local_store::write_test_fixture(vault.entry(&a.id).path(), b"damaged").unwrap();
    let mut history = History::open(&mut vault, NOW + 2).unwrap();
    // The index still names it until it is read.
    assert_eq!(history.get(&a.id), Err(NOT_FOUND.to_string()));
    assert_eq!(history.list().len(), 1);
    assert!(!vault.entry(&a.id).path().exists());

    // A transcript written before its index was cut short is listed again;
    // a damaged one found that way is deleted.
    let orphan = Entry {
      id: uuid::Uuid::new_v4().to_string(),
      created_at: NOW + 3,
      transcript: transcript("orphan.wav", "o"),
    };
    vault.save_entry(&orphan).unwrap();
    let damaged = uuid::Uuid::new_v4().to_string();
    local_store::write_test_fixture(vault.entry(&damaged).path(), b"damaged").unwrap();
    assert_eq!(ids(&mut vault, NOW + 4), vec![orphan.id, b.id]);
    assert!(!vault.entry(&damaged).path().exists());

    // A damaged settings file falls back to the default.
    local_store::write_test_fixture(directory.join(SETTINGS_FILE), b"damaged").unwrap();
    assert_eq!(
      History::open(&mut vault, NOW).unwrap().retention(),
      Retention {
        days: DEFAULT_RETENTION_DAYS
      }
    );
    fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn a_wrong_key_reads_nothing() {
    let directory = temp_directory();
    let mut vault = disk(&directory, "a");
    put(&mut vault, transcript("a.wav", "a"), NOW);
    let mut wrong = DiskVault {
      key: [8; 32],
      ..disk(&directory, "a")
    };
    // The index cannot be read; its transcripts cannot either and go.
    assert!(ids(&mut wrong, NOW).is_empty());
    fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn erasing_an_account_finishes_even_after_an_interruption() {
    let root = temp_directory();
    let directory = root.join("a");
    let mut vault = disk(&directory, "a");
    put(&mut vault, transcript("a.wav", "a"), NOW);
    // Interrupted: the marker is written, nothing else happened.
    local_store::write_test_fixture(directory.join(ERASE_MARKER), b"").unwrap();
    let mut keys = 0;
    finish_erasure(&directory, || {
      keys += 1;
      Ok(())
    })
    .unwrap();
    assert_eq!(keys, 1);
    assert!(!directory.exists());

    let mut vault = disk(&directory, "a");
    put(&mut vault, transcript("a.wav", "a"), NOW);
    // A key that cannot be removed does not keep the transcripts.
    erase_directory(&directory, || Err("keychain unavailable".to_string())).unwrap();
    assert!(!directory.exists());
    assert!(erase_directory(&directory, || Ok(())).is_ok());
    fs::remove_dir(root).unwrap();
  }

  /// A keychain that holds the test key once `available`, and none before.
  #[derive(Default)]
  struct TestKeys {
    available: std::cell::Cell<bool>,
  }

  impl HistoryKeys for TestKeys {
    fn resolve(&self, _namespace: &str, data_exists: bool) -> StoreKey {
      if self.available.get() {
        StoreKey::Key([7; 32])
      } else if data_exists {
        StoreKey::DeletionOnly
      } else {
        StoreKey::MemoryOnly
      }
    }

    fn delete(&self, _namespace: &str) -> Result<(), String> {
      Ok(())
    }
  }

  /// A vault whose listing fails, or that stops writing the index once a
  /// transcript is written: a process cut short at that point.
  struct Faulty<'v> {
    inner: &'v mut dyn Vault,
    listing_fails: bool,
    stops_after_entry: bool,
    entry_written: bool,
  }

  impl Vault for Faulty<'_> {
    fn load_settings(&self) -> Result<Option<Settings>, EncryptedReadError> {
      self.inner.load_settings()
    }

    fn save_settings(&mut self, settings: &Settings) -> Result<(), String> {
      self.inner.save_settings(settings)
    }

    fn load_index(&self) -> Result<Option<Index>, EncryptedReadError> {
      self.inner.load_index()
    }

    fn save_index(&mut self, index: &Index) -> Result<(), String> {
      if self.stops_after_entry && self.entry_written {
        return Err("stopped".to_string());
      }
      self.inner.save_index(index)
    }

    fn load_entry(&self, id: &str) -> Result<Option<Entry>, EncryptedReadError> {
      self.inner.load_entry(id)
    }

    fn save_entry(&mut self, entry: &Entry) -> Result<(), String> {
      self.entry_written = true;
      self.inner.save_entry(entry)
    }

    fn remove_entry(&mut self, id: &str) -> Result<(), String> {
      self.inner.remove_entry(id)
    }

    fn entry_ids(&self) -> Result<Vec<String>, String> {
      if self.listing_fails {
        return Err("listing failed".to_string());
      }
      self.inner.entry_ids()
    }
  }

  #[test]
  fn a_request_queued_before_disconnect_never_writes_the_history_back() {
    let root = temp_directory();
    let keys = TestKeys::default();
    keys.available.set(true);
    let storage = Storage::Disk {
      root: &root,
      keys: &keys,
    };
    let state = TranscribeHistoryState::default();
    let namespace = "a".repeat(64);
    let bound_at = 4;
    state
      .with_history(storage, &namespace, bound_at, NOW, |history| {
        history.put(new(transcript("a.wav", "a")), NOW)
      })
      .unwrap()
      .unwrap();
    // Disconnect erases the history while a put bound to the account still
    // waits for the store's lock; that put then runs.
    state
      .erase_disconnected(storage, &namespace, bound_at)
      .unwrap();
    let stale = state.with_history(storage, &namespace, bound_at, NOW, |history| {
      history.put(new(transcript("b.wav", "b")), NOW)
    });
    assert_eq!(stale, Err(NO_ACCOUNT.to_string()));
    assert!(!root.join(&namespace).exists());
    // The retention sweep never brings an erased history back either.
    state.sweep(storage, NOW);
    assert!(!root.join(&namespace).exists());

    // Linked again, the account is bound at a later generation.
    state
      .with_history(storage, &namespace, bound_at + 1, NOW, |history| {
        history.put(new(transcript("c.wav", "c")), NOW)
      })
      .unwrap()
      .unwrap();
    assert!(root.join(&namespace).exists());
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn a_listing_that_fails_partway_never_rewrites_the_index() {
    let directory = temp_directory();
    let mut vault = disk(&directory, "a");
    put(&mut vault, transcript("a.wav", "a"), NOW);
    put(&mut vault, transcript("b.wav", "b"), NOW + 1);
    let index = fs::read(directory.join(INDEX_FILE)).unwrap();

    let files = vec![
      Ok(directory.join("x.json")),
      Err(std::io::Error::other("device gone")),
    ];
    assert!(stored_entry_ids(files.into_iter()).is_err());

    let mut faulty = Faulty {
      inner: &mut vault,
      listing_fails: true,
      stops_after_entry: false,
      entry_written: false,
    };
    assert!(History::open(&mut faulty, NOW + 2).is_err());
    assert_eq!(fs::read(directory.join(INDEX_FILE)).unwrap(), index);
    assert_eq!(ids(&mut vault, NOW + 2).len(), 2);
    fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn a_key_the_keychain_gives_later_keeps_what_memory_held() {
    let root = temp_directory();
    let keys = TestKeys::default();
    let storage = Storage::Disk {
      root: &root,
      keys: &keys,
    };
    let state = TranscribeHistoryState::default();
    let namespace = "b".repeat(64);
    let kept = state
      .with_history(storage, &namespace, 1, NOW, |history| {
        history.set_retention(7, NOW)?;
        history.put(new(transcript("a.wav", "a")), NOW)
      })
      .unwrap()
      .unwrap();
    assert!(!root.join(&namespace).exists());

    keys.available.set(true);
    let view = state
      .with_history(storage, &namespace, 1, NOW + 1, |history| {
        history.get(&kept.id)
      })
      .unwrap();
    assert_eq!(view.expires_at, NOW + 7 * DAY_MS);
    let mut on_disk = disk(&root.join(&namespace), &namespace);
    assert_eq!(ids(&mut on_disk, NOW + 2), vec![kept.id]);
    assert_eq!(
      History::open(&mut on_disk, NOW + 2).unwrap().retention(),
      Retention { days: 7 }
    );

    // A choice to keep nothing survives the move; no transcript does.
    let namespace = "c".repeat(64);
    keys.available.set(false);
    state
      .with_history(storage, &namespace, 1, NOW, |history| {
        history.put(new(transcript("a.wav", "a")), NOW)?;
        history.set_retention(0, NOW)
      })
      .unwrap();
    keys.available.set(true);
    assert_eq!(
      state
        .with_history(storage, &namespace, 1, NOW, |history| Ok(
          history.retention()
        ))
        .unwrap(),
      Retention { days: 0 }
    );
    let mut on_disk = disk(&root.join(&namespace), &namespace);
    assert!(ids(&mut on_disk, NOW).is_empty());
    assert_eq!(
      on_disk.load_settings().unwrap(),
      Some(Settings { retention_days: 0 })
    );
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn an_update_cut_short_before_the_index_is_repaired_from_the_transcript() {
    let directory = temp_directory();
    let mut vault = disk(&directory, "a");
    let first = put(&mut vault, transcript("memo.mp3", "Dobrý den."), NOW);
    let mut cleaned = transcript("memo.mp3", "Dobrý den.");
    cleaned.cleaned = Some(Cleaned {
      markdown: "# Memo\n\nDobrý den.".to_string(),
      instructions: Vec::new(),
    });
    // The process stops after the transcript is written, before the index
    // catches up.
    let mut faulty = Faulty {
      inner: &mut vault,
      listing_fails: false,
      stops_after_entry: true,
      entry_written: false,
    };
    let update = History::open(&mut faulty, NOW + 1).unwrap().put(
      PutRequest {
        id: Some(first.id.clone()),
        transcript: cleaned.clone(),
      },
      NOW + 1,
    );
    assert!(update.is_err());
    assert_eq!(
      History::open(&mut vault, NOW + 2)
        .unwrap()
        .get(&first.id)
        .unwrap()
        .entry
        .transcript,
      cleaned
    );

    let history = History::open(&mut vault, NOW + 2).unwrap();
    let list = history.list();
    assert_eq!(list.len(), 1);
    assert!(list[0].cleaned);
    assert!(history.index.updating.is_empty());
    let bytes = history.index.entries[0].bytes;
    drop(history);
    assert_eq!(
      bytes,
      Summary::of(&vault.load_entry(&first.id).unwrap().unwrap()).bytes
    );
    fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn the_window_sends_camel_case_and_ids_stay_out_of_paths() {
    let request: PutRequest = serde_json::from_value(serde_json::json!({
      "fileName": "memo.m4a",
      "format": "m4a",
      "durationMs": 1000,
      "model": "thisComputer",
      "matter": { "id": "m_1", "name": "Matter" },
      "paragraphs": [{ "startMs": 0, "text": "Hi" }],
      "cleaned": { "markdown": "Hi", "instructions": [] },
      "savedToMatter": null,
      "outcome": "failed",
      "failure": "tooLong"
    }))
    .unwrap();
    assert_eq!(request.id, None);
    assert_eq!(request.transcript.failure, Some(Failure::TooLong));
    assert!(parse_id("../x").is_err());
    assert!(is_namespace(&"a".repeat(64)));
    assert!(!is_namespace("../a"));
  }
}
