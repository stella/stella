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
  dictation_spelling::LearnedSpelling,
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

/// A change made on this computer, as the server takes it. Its id makes a
/// resent change count once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Change {
  /// The speaker said how dictated words are spelled: on at once.
  Taught {
    id: String,
    from: String,
    to: String,
  },
  /// The speaker switched a fix on or off.
  Switched {
    id: String,
    from: String,
    status: Switch,
  },
}

impl Change {
  fn id(&self) -> &str {
    match self {
      Self::Taught { id, .. } | Self::Switched { id, .. } => id,
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
    let unused = next
      .iter()
      .position(|fix| {
        matches!(fix.status, FixStatus::Learning | FixStatus::Contradicted)
      })
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
/// spelling pass takes them; none without an account or a readable file.
pub fn on_fixes(app: &AppHandle) -> Vec<LearnedFix> {
  dictation_namespace(app)
    .and_then(|namespace| read(&namespace).ok())
    .map(|stored| {
      stored
        .fixes
        .into_iter()
        .filter(|fix| fix.status == FixStatus::On)
        .collect()
    })
    .unwrap_or_default()
}

/// `text` with every fix that is on applied.
pub fn apply(app: &AppHandle, text: &str) -> String {
  let fixes = on_fixes(app);
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
  if from == to {
    return Err(TeachFailure::Refused(Refusal::Same));
  }
  let namespace = dictation_namespace(app).ok_or(TeachFailure::NotSaved)?;
  update(&namespace, |stored| {
    stored.fixes = taught(&stored.fixes, &from, &to);
    stored.pending.push(Change::Taught {
      id: uuid::Uuid::new_v4().to_string(),
      from,
      to,
    });
  })
  .map_err(|_error| TeachFailure::NotSaved)?;
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

/// Forgets the account's fixes on this computer, as it disconnects: the
/// server keeps the speaker's list for their other devices.
pub fn erase_account(namespace: &str) {
  let _files = FILES.lock().unwrap_or_else(|error| error.into_inner());
  if let Err(error) = preference(namespace).remove() {
    tracing::warn!(%error, "learned dictation fixes were not erased");
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
    stored.pending.push(Change::Switched {
      id: uuid::Uuid::new_v4().to_string(),
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
    let generation = read(&namespace).map_or(0, |stored| stored.generation);
    write(
      &namespace,
      &Stored {
        generation,
        fixes: Vec::new(),
        pending: Vec::new(),
        clear_pending: true,
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
  Clear,
  Send {
    generation: u64,
    changes: Vec<Change>,
  },
  Read,
}

async fn sync_round(app: &AppHandle, namespace: &str) -> Result<Round, Stop> {
  let request = {
    let _files = FILES.lock().unwrap_or_else(|error| error.into_inner());
    let stored = read(namespace).map_err(|_error| Stop::Failed)?;
    if stored.clear_pending {
      Request::Clear
    } else if stored.pending.is_empty() {
      Request::Read
    } else {
      Request::Send {
        generation: stored.generation,
        changes: stored
          .pending
          .iter()
          .take(contract().max_changes_per_request)
          .cloned()
          .collect(),
      }
    }
  };
  let reply = send(app, namespace, &request).await?;
  let again = update(namespace, |stored| {
    match &request {
      Request::Clear => stored.clear_pending = false,
      Request::Send { changes, .. } => {
        stored
          .pending
          .retain(|change| changes.iter().all(|sent| sent.id() != change.id()));
      }
      Request::Read => {}
    }
    stored.generation = reply.generation;
    let settled = stored.pending.is_empty() && !stored.clear_pending;
    if settled {
      stored.fixes = reply.fixes;
    }
    !settled
  })
  .map_err(|_error| Stop::Failed)?;
  changed(app);
  Ok(if again { Round::Again } else { Round::Done })
}

async fn send(
  app: &AppHandle,
  namespace: &str,
  request: &Request,
) -> Result<Snapshot, Stop> {
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
    Request::Clear => client.delete(url),
    Request::Send {
      generation,
      changes,
    } => client.post(url).json(&serde_json::json!({
      "generation": generation,
      "changes": changes,
    })),
    Request::Read => client.get(url),
  };
  let signed = crate::http_client::device_proof_request(
    builder,
    &account.device_key,
    Some(&account.credential.key),
    None,
  )
  .map_err(|_error| Stop::Failed)?;
  let response = signed.send().await.map_err(|_error| Stop::Failed)?;
  drop(account);
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
  serde_json::from_slice(&bytes).map_err(|_error| Stop::Failed)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fix(from: &str, to: &str, status: FixStatus) -> LearnedFix {
    LearnedFix {
      from: from.to_string(),
      to: to.to_string(),
      seen: 1,
      status,
    }
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
    let next = taught(&fixes, "fresh", "Fresh");
    assert_eq!(next.len(), contract().max_fixes);
    assert!(next.iter().all(|each| each.from != "word3"));
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
      id: "id-1".to_string(),
      from: "novak".to_string(),
      to: "Novák".to_string(),
    };
    assert_eq!(
      serde_json::to_value(&taught).unwrap(),
      serde_json::json!({"type": "taught", "id": "id-1", "from": "novak", "to": "Novák"})
    );
    let switched = Change::Switched {
      id: "id-2".to_string(),
      from: "novak".to_string(),
      status: Switch::Off,
    };
    assert_eq!(
      serde_json::to_value(&switched).unwrap(),
      serde_json::json!({"type": "switched", "id": "id-2", "from": "novak", "status": "off"})
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
