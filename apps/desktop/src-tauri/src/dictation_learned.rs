//! Fixes stella learned for how the speaker spells dictated words: one list
//! for each linked account, kept on this computer and synced with the
//! speaker's own list on the server (`/v1/desktop/dictation/learned-fixes`),
//! which only they can read. A fix that is on rewrites its words in every
//! dictation before cleanup or typing (`dictation_spelling::apply_learned`).
//!
//! The list works offline: a change applies here at once and waits, in the
//! same file, to be sent. The server applies the waiting changes in order and
//! answers with the whole list, which replaces the one here once nothing new
//! waits. Deleting what stella learned clears this computer at once and the
//! server on the next sync; changes made before the delete are dropped
//! there too. An older server without the route leaves the list here and is
//! asked again later. Like custom words, the fixes are never logged.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine apply fixes")
)]

use std::{
  sync::{
    Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
  },
  time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{
  device_preference::DevicePreference,
  dictation_spelling::{LearnedSpelling, phrase_words},
  dictation_words::dictation_namespace,
  http_client::{DesktopHttpClient, HttpClientOptions},
};

/// One file for each account, named by its local data namespace.
const FILE_PREFIX: &str = "dictation-learned-fixes-";
/// Payload-free: Settings reads the list again.
pub const CHANGED_EVENT: &str = "dictation-learned-changed";
const NO_ACCOUNT: &str = "learned fixes need a linked account";
const UNREADABLE: &str = "learned fixes could not be read";
/// Changes made close together go in one request.
const SYNC_DELAY: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Rounds of one sync: a change queued while one request runs goes in the
/// next round.
const SYNC_ROUNDS: usize = 4;
const MAX_REPLY_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
  path: String,
  max_fixes: usize,
  /// In UTF-16 code units, the way the API measures them.
  max_text_length: usize,
  max_words: usize,
  max_changes_per_request: usize,
}

const CONTRACT: &str =
  include_str!("../../../../packages/api-contract/src/dictation-learned-fixes.json");

fn contract() -> &'static Contract {
  static PARSED: OnceLock<Contract> = OnceLock::new();
  PARSED.get_or_init(|| {
    serde_json::from_str(CONTRACT)
      .expect("the committed learned dictation fixes contract must be valid")
  })
}

/// Where a fix stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FixStatus {
  /// Seen once; not applied yet.
  Learning,
  /// Applied to every dictation.
  On,
  /// Switched off by the speaker.
  Off,
  /// Corrected another way, or kept as dictated: never applied.
  Contradicted,
}

/// What the speaker switches a fix to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Switch {
  On,
  Off,
}

impl Switch {
  const fn status(self) -> FixStatus {
    match self {
      Self::On => FixStatus::On,
      Self::Off => FixStatus::Off,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedFix {
  /// The words as dictated.
  pub from: String,
  /// The words as the speaker writes them.
  pub to: String,
  /// How many dictations were corrected this way.
  pub seen: u32,
  pub status: FixStatus,
}

/// A change made on this computer, as the server takes it. Its number, the
/// next of this computer's, makes a resent change count once: the server
/// applies only numbers above the highest it applied from this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Change {
  /// The speaker said how dictated words are spelled: on at once.
  Taught {
    /// 0 for a change an earlier build queued, numbered before it is sent.
    #[serde(default)]
    seq: u64,
    from: String,
    to: String,
  },
  /// The speaker switched a fix on or off.
  Switched {
    #[serde(default)]
    seq: u64,
    from: String,
    status: Switch,
  },
}

impl Change {
  const fn seq(&self) -> u64 {
    match self {
      Self::Taught { seq, .. } | Self::Switched { seq, .. } => *seq,
    }
  }

  const fn number(&mut self, number: u64) {
    match self {
      Self::Taught { seq, .. } | Self::Switched { seq, .. } => *seq = number,
    }
  }
}

/// The file: the list as it reads on this computer, what is still to be
/// sent, and the server's generation it is based on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
  generation: u64,
  fixes: Vec<LearnedFix>,
  pending: Vec<Change>,
  /// The speaker deleted what stella learned; the server is told first.
  clear_pending: bool,
  /// Counts the deletes, so a reply to an earlier one leaves a later one
  /// waiting.
  #[serde(default)]
  clear_count: u64,
  /// The id this computer's changes go out under, made with its first
  /// change. Kept in this file with `seq`, so the two are only ever lost
  /// together: an id kept with a lost count would number new changes the
  /// server already counted, and it would drop them.
  #[serde(default)]
  device: Option<String>,
  /// The number of the last change made here; the next one is one more.
  #[serde(default)]
  seq: u64,
}

impl Stored {
  /// Queues `change` as this computer's next.
  fn queue(&mut self, mut change: Change) {
    self.number_queued();
    self.seq += 1;
    change.number(self.seq);
    self.pending.push(change);
    self.with_device();
  }

  /// Numbers the changes an earlier build queued without a number; true
  /// when it changed the file.
  fn number_queued(&mut self) -> bool {
    let mut numbered = false;
    for change in &mut self.pending {
      if change.seq() == 0 {
        self.seq += 1;
        change.number(self.seq);
        numbered = true;
      }
    }
    if !self.pending.is_empty() && self.device.is_none() {
      self.with_device();
      numbered = true;
    }
    numbered
  }

  fn with_device(&mut self) {
    if self.device.is_none() {
      self.device = Some(uuid::Uuid::new_v4().to_string());
    }
  }
}

/// The server's answer to every learned-fixes request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
  generation: u64,
  fixes: Vec<LearnedFix>,
}

/// What a window shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedView {
  fixes: Vec<LearnedFix>,
}

/// Why words cannot be a fix; the window says why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
  Empty,
  LineBreak,
  TooLong,
  TooManyWords,
  Same,
  /// Punctuation inside the dictated words, or at their edge without the
  /// same in how they are written: a fix matches words only.
  Punctuation,
}

/// `text` as a fix's side: trimmed, single spaces between its words, within
/// the contract's limits.
pub fn accepted(text: &str) -> Result<String, Refusal> {
  // A tab or a line break inside: the text is not one phrase.
  if text.trim().chars().any(char::is_control) {
    return Err(Refusal::LineBreak);
  }
  let words = text.split_whitespace().collect::<Vec<_>>();
  if words.is_empty() {
    return Err(Refusal::Empty);
  }
  if words.len() > contract().max_words {
    return Err(Refusal::TooManyWords);
  }
  let joined = words.join(" ");
  if joined.encode_utf16().count() > contract().max_text_length {
    return Err(Refusal::TooLong);
  }
  Ok(joined)
}

/// `from` → `to` as a fix of dictated words: punctuation at the edges of
/// `from` comes off both sides when `to` has the same there, so selecting
/// `Novak,` teaches `Novak` → `Novák`. Other punctuation in `from` could
/// never match dictated words and is refused.
fn learnable(from: &str, to: &str) -> Result<(String, String), Refusal> {
  let (before, words, after) = phrase_words(from).ok_or(Refusal::Punctuation)?;
  if before.is_empty() && after.is_empty() {
    return Ok((from.to_string(), to.to_string()));
  }
  let written = to
    .strip_prefix(before)
    .and_then(|rest| rest.strip_suffix(after))
    .map(str::trim)
    .filter(|rest| !rest.is_empty())
    .ok_or(Refusal::Punctuation)?;
  Ok((words.trim().to_string(), written.to_string()))
}

/// How two fixes' dictated words compare: lower case, curly apostrophes
/// made straight, single spaces.
fn key(phrase: &str) -> String {
  phrase
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase()
    .replace('’', "'")
}

/// `fixes` after the speaker taught `from` → `to`: on at once, moved to the
/// end, the oldest unused fix dropped beyond the limit.
fn taught(fixes: &[LearnedFix], from: &str, to: &str) -> Vec<LearnedFix> {
  let wanted = key(from);
  let known = fixes.iter().find(|fix| key(&fix.from) == wanted);
  let fix = LearnedFix {
    from: from.to_string(),
    to: to.to_string(),
    seen: known.map_or(1, |fix| fix.seen.max(1)),
    status: FixStatus::On,
  };
  let mut next = fixes
    .iter()
    .filter(|each| key(&each.from) != wanted)
    .cloned()
    .collect::<Vec<_>>();
  next.push(fix);
  while next.len() > contract().max_fixes {
    // Only a fix that is on is in use, as in `@stll/transcript`.
    let unused = next
      .iter()
      .position(|fix| fix.status != FixStatus::On)
      .unwrap_or(0);
    next.remove(unused);
  }
  next
}

/// `fixes` with the one for `from` switched; unchanged without one.
fn switched(fixes: &[LearnedFix], from: &str, to: Switch) -> Vec<LearnedFix> {
  let wanted = key(from);
  fixes
    .iter()
    .map(|fix| {
      if key(&fix.from) == wanted {
        LearnedFix {
          status: to.status(),
          ..fix.clone()
        }
      } else {
        fix.clone()
      }
    })
    .collect()
}

fn preference(namespace: &str) -> DevicePreference {
  DevicePreference::in_app_data(&format!("{FILE_PREFIX}{namespace}"))
}

/// Serializes every read-change-write of the files.
static FILES: Mutex<()> = Mutex::new(());

/// The file for `namespace`; nothing stored reads as an empty list, a file
/// that cannot be read as an error.
fn read(namespace: &str) -> Result<Stored, String> {
  match preference(namespace).read_stored() {
    Ok(None) => Ok(Stored::default()),
    // A serde error is never logged: it can quote a fix.
    Ok(Some(stored)) => {
      serde_json::from_str(&stored).map_err(|_error| UNREADABLE.to_string())
    }
    Err(_error) => Err(UNREADABLE.to_string()),
  }
}

fn write(namespace: &str, stored: &Stored) -> Result<(), String> {
  let text = serde_json::to_string(stored).map_err(|_error| UNREADABLE.to_string())?;
  preference(namespace).write(&text)
}

/// Changes the file for `namespace` under the files lock.
fn update<T>(
  namespace: &str,
  apply: impl FnOnce(&mut Stored) -> T,
) -> Result<T, String> {
  let _files = FILES.lock().unwrap_or_else(|error| error.into_inner());
  change(namespace, apply)
}

/// Changes the file of the account `resolve` names, resolving it under the
/// files lock: a disconnect that erased the files first leaves no account,
/// so a change arriving after it never recreates a file. `None` without an
/// account.
fn update_resolved<T>(
  resolve: impl FnOnce() -> Option<String>,
  apply: impl FnOnce(&mut Stored) -> T,
) -> Result<Option<T>, String> {
  let _files = FILES.lock().unwrap_or_else(|error| error.into_inner());
  let Some(namespace) = resolve() else {
    return Ok(None);
  };
  change(&namespace, apply).map(Some)
}

/// Reads, changes and writes the file; the caller holds the files lock.
fn change<T>(
  namespace: &str,
  apply: impl FnOnce(&mut Stored) -> T,
) -> Result<T, String> {
  let mut stored = read(namespace)?;
  let value = apply(&mut stored);
  write(namespace, &stored)?;
  Ok(value)
}

fn changed(app: &AppHandle) {
  if let Err(error) = app.emit(CHANGED_EVENT, ()) {
    tracing::warn!(%error, "learned dictation fixes change event failed");
  }
}

/// The fixes that are on for the account dictation runs for, as the
/// spelling pass takes them: none without an account, an error when the
/// file cannot be read.
fn on_fixes(app: &AppHandle) -> Result<Vec<LearnedFix>, String> {
  let Some(namespace) = dictation_namespace(app) else {
    return Ok(Vec::new());
  };
  Ok(
    read(&namespace)?
      .fixes
      .into_iter()
      .filter(|fix| fix.status == FixStatus::On)
      .collect(),
  )
}

/// `text` with every fix that is on applied. A file that cannot be read
/// leaves the text as dictated and says so in the log, never what it holds.
pub fn apply(app: &AppHandle, text: &str) -> String {
  let fixes = match on_fixes(app) {
    Ok(fixes) => fixes,
    Err(error) => {
      tracing::warn!(%error, "learned dictation fixes not applied");
      return text.to_string();
    }
  };
  let spellings = fixes
    .iter()
    .map(|fix| LearnedSpelling {
      from: &fix.from,
      to: &fix.to,
    })
    .collect::<Vec<_>>();
  crate::dictation_spelling::apply_learned(text, &spellings)
}

/// Records that `from` is written `to`, on at once, and syncs it.
pub fn teach(app: &AppHandle, from: &str, to: &str) -> Result<(), TeachFailure> {
  let from = accepted(from).map_err(TeachFailure::Refused)?;
  let to = accepted(to).map_err(TeachFailure::Refused)?;
  let (from, to) = learnable(&from, &to).map_err(TeachFailure::Refused)?;
  if from == to {
    return Err(TeachFailure::Refused(Refusal::Same));
  }
  update_resolved(
    || dictation_namespace(app),
    |stored| {
      stored.fixes = taught(&stored.fixes, &from, &to);
      stored.queue(Change::Taught { seq: 0, from, to });
    },
  )
  .map_err(|_error| TeachFailure::NotSaved)?
  .ok_or(TeachFailure::NotSaved)?;
  changed(app);
  sync_soon(app);
  Ok(())
}

/// Why a taught fix was not kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeachFailure {
  Refused(Refusal),
  /// No account, or the file could not be read or written.
  NotSaved,
}

/// Forgets every account's fixes on this computer, as the account
/// disconnects: the server keeps the speaker's list for their other devices.
/// Files of an account that expired before are erased too, since its
/// namespace is no longer known.
pub fn erase_all() {
  let _files = FILES.lock().unwrap_or_else(|error| error.into_inner());
  let Some(directory) =
    dirs::data_dir().map(|data| data.join(crate::config::APP_DATA_DIR_NAME))
  else {
    return;
  };
  let entries = match std::fs::read_dir(&directory) {
    Ok(entries) => entries,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
    Err(error) => {
      tracing::warn!(%error, "learned dictation fixes were not erased");
      return;
    }
  };
  for entry in entries.flatten() {
    let name = entry.file_name();
    let Some(name) = name.to_str() else {
      continue;
    };
    if !name.starts_with(FILE_PREFIX) {
      continue;
    }
    if let Err(error) = DevicePreference::in_app_data(name).remove() {
      tracing::warn!(%error, "learned dictation fixes were not erased");
    }
  }
}

#[tauri::command]
pub fn dictation_learned_get(app: AppHandle) -> Result<LearnedView, String> {
  let namespace = dictation_namespace(&app).ok_or(NO_ACCOUNT)?;
  let stored = read(&namespace)?;
  Ok(LearnedView {
    fixes: stored.fixes,
  })
}

#[tauri::command]
pub fn dictation_learned_switch(
  app: AppHandle,
  from: String,
  status: Switch,
) -> Result<LearnedView, String> {
  let namespace = dictation_namespace(&app).ok_or(NO_ACCOUNT)?;
  let fixes = update(&namespace, |stored| {
    stored.fixes = switched(&stored.fixes, &from, status);
    stored.queue(Change::Switched {
      seq: 0,
      from,
      status,
    });
    stored.fixes.clone()
  })?;
  changed(&app);
  sync_soon(&app);
  Ok(LearnedView { fixes })
}

/// Deletes what stella learned: here at once, on the server and so on every
/// device at the next sync. Works whether or not the file could be read.
#[tauri::command]
pub fn dictation_learned_delete(app: AppHandle) -> Result<LearnedView, String> {
  let namespace = dictation_namespace(&app).ok_or(NO_ACCOUNT)?;
  {
    let _files = FILES.lock().unwrap_or_else(|error| error.into_inner());
    // The count goes on: the server knows this computer's earlier numbers.
    // A file that cannot be read starts again under a new id.
    let kept = read(&namespace).unwrap_or_default();
    write(
      &namespace,
      &Stored {
        generation: kept.generation,
        fixes: Vec::new(),
        pending: Vec::new(),
        clear_pending: true,
        clear_count: kept.clear_count.wrapping_add(1),
        device: kept.device,
        seq: kept.seq,
      },
    )?;
  }
  changed(&app);
  sync_soon(&app);
  Ok(LearnedView { fixes: Vec::new() })
}

/// Counts scheduled syncs, so only the last of a burst runs.
static SCHEDULED: AtomicU64 = AtomicU64::new(0);

/// Syncs a little later, once changes made together are all queued; at
/// launch, once dictation runs for an account.
pub fn sync_soon(app: &AppHandle) {
  let ticket = SCHEDULED.fetch_add(1, Ordering::SeqCst) + 1;
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(SYNC_DELAY).await;
    if SCHEDULED.load(Ordering::SeqCst) == ticket {
      sync(&app).await;
    }
  });
}

/// One sync at a time.
static SYNCING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Sends what waits and takes the server's list. Any failure leaves the
/// file as it is for the next sync; nothing is shown.
async fn sync(app: &AppHandle) {
  let _syncing = SYNCING.lock().await;
  let Some(namespace) = dictation_namespace(app) else {
    return;
  };
  for _ in 0..SYNC_ROUNDS {
    match sync_round(app, &namespace).await {
      Ok(Round::Done) => return,
      Ok(Round::Again) => {}
      Err(Stop::OlderServer) => {
        tracing::info!("learned dictation fixes: the server does not sync them yet");
        return;
      }
      Err(Stop::Failed) => {
        tracing::info!("learned dictation fixes: sync failed, kept for later");
        return;
      }
    }
  }
  // The rounds ran out with changes still waiting: the rest goes in a sync
  // of its own rather than waiting for the next change.
  sync_soon(app);
}

enum Round {
  Done,
  /// More changes were queued during the request.
  Again,
}

enum Stop {
  /// The server has no such route: an older API.
  OlderServer,
  Failed,
}

/// What one request does, decided from the file.
enum Request {
  /// The delete with this count, of this generation: a later delete stays
  /// waiting, and a resent one leaves what was learned after it.
  Clear {
    count: u64,
    generation: u64,
  },
  Send {
    generation: u64,
    device: String,
    changes: Vec<Change>,
  },
  Read {
    generation: u64,
  },
}

async fn sync_round(app: &AppHandle, namespace: &str) -> Result<Round, Stop> {
  let request = {
    let _files = FILES.lock().unwrap_or_else(|error| error.into_inner());
    let mut stored = read(namespace).map_err(|_error| Stop::Failed)?;
    // Changes an earlier build queued are numbered and written back before
    // they go out, so a resend carries the same numbers. Otherwise nothing
    // is written: a file Disconnect erased stays erased.
    if stored.number_queued() {
      write(namespace, &stored).map_err(|_error| Stop::Failed)?;
    }
    request_for(&stored)
  };
  // The account lease is held until the reply is written, so Disconnect
  // cannot erase the file while the reply is read and then see it written
  // back.
  let (reply, account) = send(app, namespace, &request).await?;
  let again = update(namespace, |stored| settle(stored, &request, reply))
    .map_err(|_error| Stop::Failed)?;
  drop(account);
  changed(app);
  Ok(if again { Round::Again } else { Round::Done })
}

/// The request for what the file holds.
fn request_for(stored: &Stored) -> Request {
  if stored.clear_pending {
    return Request::Clear {
      count: stored.clear_count,
      generation: stored.generation,
    };
  }
  let device = stored
    .device
    .as_ref()
    .filter(|_device| !stored.pending.is_empty());
  if let Some(device) = device {
    Request::Send {
      generation: stored.generation,
      device: device.clone(),
      changes: stored
        .pending
        .iter()
        .take(contract().max_changes_per_request)
        .cloned()
        .collect(),
    }
  } else {
    Request::Read {
      generation: stored.generation,
    }
  }
}

/// `stored` after the server answered `request`: what it took no longer
/// waits, and its list replaces the one here once nothing waits. True while
/// something still waits.
fn settle(stored: &mut Stored, request: &Request, reply: Snapshot) -> bool {
  match request {
    Request::Clear { count, .. } => {
      if stored.clear_count == *count {
        stored.clear_pending = false;
      }
    }
    // Deleted here while the request was out: the delete goes first, and
    // this answer is not taken.
    Request::Send { .. } | Request::Read { .. } if stored.clear_pending => {
      return true;
    }
    // Deleted on another device: what was learned here before it went with
    // it, also what was learned while the request was out.
    Request::Send { generation, .. } | Request::Read { generation }
      if reply.generation != *generation =>
    {
      stored.pending.clear();
    }
    Request::Send { changes, .. } => {
      let sent = changes.last().map_or(0, Change::seq);
      stored.pending.retain(|change| change.seq() > sent);
    }
    Request::Read { .. } => {}
  }
  stored.generation = reply.generation;
  let settled = stored.pending.is_empty() && !stored.clear_pending;
  if settled {
    stored.fixes = reply.fixes;
  }
  !settled
}

/// The server's answer, and the account request whose lease the caller holds
/// until the answer is written.
async fn send(
  app: &AppHandle,
  namespace: &str,
  request: &Request,
) -> Result<(Snapshot, crate::account::AccountRequest), Stop> {
  let account = crate::dictation_cleanup::dictation_account(app)
    .await
    .map_err(|_error| Stop::Failed)?;
  if account.local_data_namespace() != namespace {
    return Err(Stop::Failed);
  }
  let client = DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(REQUEST_TIMEOUT),
  })
  .map_err(|_error| Stop::Failed)?;
  let url = format!("{}{}", account.api_base_url, contract().path);
  let builder = match request {
    Request::Clear { generation, .. } => {
      client.delete(format!("{url}?generation={generation}"))
    }
    Request::Send {
      generation,
      device,
      changes,
    } => client.post(url).json(&serde_json::json!({
      "generation": generation,
      "device": device,
      "changes": changes,
    })),
    Request::Read { .. } => client.get(url),
  };
  let signed = crate::http_client::device_proof_request(
    builder,
    &account.device_key,
    Some(&account.credential.key),
    None,
  )
  .map_err(|_error| Stop::Failed)?;
  let response = signed.send().await.map_err(|_error| Stop::Failed)?;
  let status = response.status();
  if status == reqwest::StatusCode::NOT_FOUND {
    return Err(Stop::OlderServer);
  }
  if !status.is_success() {
    tracing::info!(%status, "learned dictation fixes: request refused");
    return Err(Stop::Failed);
  }
  let bytes = response.bytes().await.map_err(|_error| Stop::Failed)?;
  if bytes.len() > MAX_REPLY_BYTES {
    return Err(Stop::Failed);
  }
  // A serde error is never logged: it can quote a fix.
  let snapshot: Snapshot =
    serde_json::from_slice(&bytes).map_err(|_error| Stop::Failed)?;
  Ok((snapshot, account))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_change_resolves_its_account_under_the_files_lock() {
    let mut applied = false;
    let changed = update_resolved(
      || {
        // A disconnect erases under the same lock, so it cannot run between
        // this lookup and the write.
        assert!(FILES.try_lock().is_err()); // kit-allow: asserts the lookup runs under the process-global files lock
        None
      },
      |_stored| applied = true,
    );
    assert_eq!(changed, Ok(None));
    assert!(!applied);
  }

  fn fix(from: &str, to: &str, status: FixStatus) -> LearnedFix {
    LearnedFix {
      from: from.to_string(),
      to: to.to_string(),
      seen: 1,
      status,
    }
  }

  #[test]
  fn edge_punctuation_comes_off_both_sides_and_other_punctuation_is_refused() {
    assert_eq!(
      learnable("Novak,", "Novák,"),
      Ok(("Novak".to_string(), "Novák".to_string()))
    );
    assert_eq!(
      learnable("jon smith", "Jon Smyth"),
      Ok(("jon smith".to_string(), "Jon Smyth".to_string()))
    );
    assert_eq!(learnable("C++", "Rust"), Err(Refusal::Punctuation));
    assert_eq!(learnable("Novak,", "Novák"), Err(Refusal::Punctuation));
    assert_eq!(
      learnable("St. John", "Saint John"),
      Err(Refusal::Punctuation)
    );
  }

  #[test]
  fn a_reply_to_an_earlier_delete_leaves_a_later_one_waiting() {
    let mut stored = Stored {
      generation: 1,
      clear_pending: true,
      clear_count: 2,
      ..Stored::default()
    };
    let reply = || Snapshot {
      generation: 2,
      fixes: vec![fix("kept", "Kept", FixStatus::On)],
    };
    let clear = |count| Request::Clear {
      count,
      generation: 1,
    };
    assert!(settle(&mut stored, &clear(1), reply()));
    assert!(stored.clear_pending);
    assert!(stored.fixes.is_empty());
    assert!(!settle(&mut stored, &clear(2), reply()));
    assert!(!stored.clear_pending);
    assert_eq!(stored.fixes, vec![fix("kept", "Kept", FixStatus::On)]);
  }

  fn taught_change(from: &str) -> Change {
    Change::Taught {
      seq: 0,
      from: from.to_string(),
      to: from.to_uppercase(),
    }
  }

  #[test]
  fn changes_are_numbered_in_turn_under_one_id_that_a_delete_keeps() {
    let mut stored = Stored::default();
    stored.queue(taught_change("one"));
    stored.queue(taught_change("two"));
    let numbers = stored.pending.iter().map(Change::seq).collect::<Vec<_>>();
    assert_eq!(numbers, vec![1, 2]);
    let device = stored.device.clone();
    assert!(device.is_some());
    // What a delete writes keeps the id and the count.
    let mut deleted = Stored {
      clear_pending: true,
      device: stored.device.clone(),
      seq: stored.seq,
      ..Stored::default()
    };
    deleted.queue(taught_change("three"));
    assert_eq!(deleted.pending.first().map(Change::seq), Some(3));
    assert_eq!(deleted.device, device);
  }

  #[test]
  fn an_answer_takes_the_changes_sent_and_leaves_the_ones_made_since() {
    let mut stored = Stored::default();
    stored.queue(taught_change("one"));
    stored.queue(taught_change("two"));
    let Request::Send {
      generation,
      device,
      changes,
    } = request_for(&stored)
    else {
      panic!("changes wait, so they are sent");
    };
    stored.queue(taught_change("three"));
    let request = Request::Send {
      generation,
      device,
      changes,
    };
    let reply = Snapshot {
      generation: 0,
      fixes: Vec::new(),
    };
    assert!(settle(&mut stored, &request, reply));
    let numbers = stored.pending.iter().map(Change::seq).collect::<Vec<_>>();
    assert_eq!(numbers, vec![3]);
  }

  #[test]
  fn a_read_that_finds_another_devices_delete_drops_what_waits() {
    let mut stored = Stored {
      generation: 3,
      ..Stored::default()
    };
    let request = request_for(&stored);
    assert!(matches!(request, Request::Read { generation: 3 }));
    // Learned here while the read was out, before the delete it finds.
    stored.queue(taught_change("late"));
    let reply = Snapshot {
      generation: 4,
      fixes: Vec::new(),
    };
    assert!(!settle(&mut stored, &request, reply));
    assert!(stored.pending.is_empty());
    assert_eq!(stored.generation, 4);
  }

  #[test]
  fn a_delete_made_while_a_request_was_out_goes_first() {
    let mut stored = Stored::default();
    stored.queue(taught_change("one"));
    let request = request_for(&stored);
    stored.pending.clear();
    stored.clear_pending = true;
    stored.queue(taught_change("after"));
    let reply = Snapshot {
      generation: 0,
      fixes: vec![fix("one", "ONE", FixStatus::On)],
    };
    assert!(settle(&mut stored, &request, reply));
    assert!(stored.clear_pending);
    assert!(stored.fixes.is_empty());
    assert_eq!(stored.pending.len(), 1);
    assert!(matches!(
      request_for(&stored),
      Request::Clear { generation: 0, .. }
    ));
  }

  #[test]
  fn changes_an_earlier_build_queued_by_id_are_numbered_once() {
    let mut stored: Stored = serde_json::from_value(serde_json::json!({
      "generation": 0,
      "fixes": [],
      "pending": [
        {"type": "taught", "id": "id-1", "from": "novak", "to": "Novák"},
        {"type": "switched", "id": "id-2", "from": "novak", "status": "off"},
      ],
      "clearPending": false,
    }))
    .unwrap();
    assert!(stored.number_queued());
    let numbers = stored.pending.iter().map(Change::seq).collect::<Vec<_>>();
    assert_eq!(numbers, vec![1, 2]);
    assert!(stored.device.is_some());
    assert!(!stored.number_queued());
  }

  #[test]
  fn a_stored_file_without_a_delete_count_reads() {
    let stored: Stored = serde_json::from_value(serde_json::json!({
      "generation": 3,
      "fixes": [],
      "pending": [],
      "clearPending": false,
    }))
    .unwrap();
    assert_eq!(stored.clear_count, 0);
  }

  #[test]
  fn the_contract_reads() {
    assert_eq!(contract().path, "/v1/desktop/dictation/learned-fixes");
    assert!(contract().max_fixes > 0);
    assert!(contract().max_changes_per_request > 0);
  }

  #[test]
  fn words_are_kept_trimmed_with_single_spaces_within_the_limits() {
    assert_eq!(accepted("  Jon   Smyth "), Ok("Jon Smyth".to_string()));
    assert_eq!(accepted("   "), Err(Refusal::Empty));
    assert_eq!(accepted("one\ntwo"), Err(Refusal::LineBreak));
    assert_eq!(accepted("a\tb"), Err(Refusal::LineBreak));
    assert_eq!(accepted("one two three four"), Err(Refusal::TooManyWords));
    assert_eq!(accepted(&"x".repeat(49)), Err(Refusal::TooLong));
    assert!(accepted(&"x".repeat(48)).is_ok());
    // Measured in UTF-16 units, as the API measures it.
    assert_eq!(accepted(&"😀".repeat(25)), Err(Refusal::TooLong));
  }

  #[test]
  fn a_taught_fix_is_on_at_once_and_replaces_the_one_for_the_same_words() {
    let fixes = vec![
      fix("novak", "Nowak", FixStatus::Contradicted),
      fix("other", "Others", FixStatus::On),
    ];
    let next = taught(&fixes, "Novak", "Novák");
    assert_eq!(
      next,
      vec![
        fix("other", "Others", FixStatus::On),
        fix("Novak", "Novák", FixStatus::On),
      ]
    );
  }

  #[test]
  fn teaching_beyond_the_limit_drops_the_oldest_unused_fix_first() {
    let mut fixes = (0..contract().max_fixes)
      .map(|index| fix(&format!("word{index}"), "Word", FixStatus::On))
      .collect::<Vec<_>>();
    fixes[3].status = FixStatus::Learning;
    fixes[1].status = FixStatus::Off;
    let next = taught(&fixes, "fresh", "Fresh");
    assert_eq!(next.len(), contract().max_fixes);
    // A fix switched off is unused too, and the older one goes.
    assert!(next.iter().all(|each| each.from != "word1"));
    assert!(next.iter().any(|each| each.from == "word3"));
    assert_eq!(next.last().map(|each| each.from.as_str()), Some("fresh"));
  }

  #[test]
  fn a_switch_finds_its_fix_whatever_the_case_and_apostrophe() {
    let fixes = vec![fix("o’brien", "O'Brien", FixStatus::On)];
    assert_eq!(
      switched(&fixes, "O'BRIEN", Switch::Off),
      vec![fix("o’brien", "O'Brien", FixStatus::Off)]
    );
    assert_eq!(switched(&fixes, "nobody", Switch::Off), fixes);
  }

  #[test]
  fn changes_go_out_in_the_contract_shape() {
    let taught = Change::Taught {
      seq: 1,
      from: "novak".to_string(),
      to: "Novák".to_string(),
    };
    assert_eq!(
      serde_json::to_value(&taught).unwrap(),
      serde_json::json!({"type": "taught", "seq": 1, "from": "novak", "to": "Novák"})
    );
    let switched = Change::Switched {
      seq: 2,
      from: "novak".to_string(),
      status: Switch::Off,
    };
    assert_eq!(
      serde_json::to_value(&switched).unwrap(),
      serde_json::json!({"type": "switched", "seq": 2, "from": "novak", "status": "off"})
    );
  }

  #[test]
  fn the_server_list_reads_with_every_status() {
    let snapshot: Snapshot = serde_json::from_value(serde_json::json!({
      "generation": 2,
      "fixes": [
        {"from": "a", "to": "b", "seen": 1, "status": "learning"},
        {"from": "c", "to": "d", "seen": 2, "status": "on"},
        {"from": "e", "to": "f", "seen": 2, "status": "off"},
        {"from": "g", "to": "h", "seen": 1, "status": "contradicted"},
      ],
    }))
    .unwrap();
    assert_eq!(snapshot.generation, 2);
    assert_eq!(snapshot.fixes.len(), 4);
  }
}
