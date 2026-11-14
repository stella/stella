//! Sends what a run could not send by its end.
//!
//! While a run goes, the sidecar sends what each step produced to stella. A
//! finished run takes nothing more, except the steps it named just before
//! its finish; the sidecar hands those over in `<runId>.awaited`, beside the
//! run's kept steps in the chat's step output store
//! (`run_folders::step_output_store`): one marker per step, named by the
//! step's key and holding its kind. This module sends
//! them once the API can be reached again, also after the app restarted.
//!
//! The folder's name says whose it is: `<runId>.pending` is the sidecar's
//! while the run goes and is never read here. A run the runner's journal
//! still holds is left alone too: until the API acknowledged the run's last
//! messages it may not know the steps are awaited.
//!
//! One step is sent at a time, by a task of its own that no run and no
//! connection waits for. Everything is safe to repeat: a step leaves its
//! folder only once the API settled or refused it for good, and the folder
//! goes once it holds no step, or once nobody judged its steps for
//! [`LEFT_FOR`]. What is on disk is read as untrusted input: only regular
//! files the user owns, never through a link, and never past a size cap.

use std::{
  collections::HashSet,
  io::Read,
  path::{Path, PathBuf},
  sync::{Arc, Mutex},
  time::{Duration, SystemTime},
};

use futures_util::future::BoxFuture;
use tokio::sync::watch;
use uuid::Uuid;

use super::client::{Authorized, RunnerAuth};
use super::run_folders::STEP_OUTPUT_STORE_SUFFIX;
use super::state::{Backoff, RunnerState};
use super::step_outputs::is_hex_key;
use crate::http_client::{DesktopHttpClient, HttpClientOptions};
use crate::local_store::{self, OpenMode};
use crate::runner_protocol::DESKTOP_ID_HEADER;

const LOG_TARGET: &str = "desktop_runner::awaited_steps";

/// Beside a run's kept steps, the folder the sidecar hands over at the run's
/// end: the name the sidecar renames `<runId>.pending` to.
const AWAITED_SUFFIX: &str = ".awaited";
/// How long a handed-over folder is left when nobody judged its steps (no
/// connection, or another account's run). Longer than the time the API
/// awaits a step, so the API's own refusal ends a folder first whenever it
/// can be asked.
const LEFT_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// The most steps of one run sent before its folder is listed again: as many
/// as a run may announce.
const MAX_STEPS_PER_LISTING: usize = 2000;
/// A marker holds its step's kind, a short word.
const MARKER_MAX_BYTES: u64 = 16;
/// A kept step's header line, `{"bytes":<n>}`, is far shorter.
const STEP_HEADER_MAX_BYTES: usize = 64;
/// The largest share of a step that is kept, whatever its kind.
const STEP_KEPT_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// The kinds a marker may name; `image` is the one kept whole or not at all.
const STEP_KINDS: [&str; 4] = ["command", "diff", "conversation", IMAGE_KIND];
const IMAGE_KIND: &str = "image";
/// One step's request; a kept image on a slow line needs this long.
const SEND_TIMEOUT: Duration = Duration::from_secs(60);
/// The API's answer to a step is one short object.
const ANSWER_MAX_BYTES: usize = 4096;
/// Between tries while the API cannot take a step, or a run is not
/// acknowledged yet.
const RETRY_BASE: Duration = Duration::from_secs(15);
const RETRY_CAP: Duration = Duration::from_secs(15 * 60);
/// While connected with nothing left to send, how often the stores are
/// looked at again: a run may end, and hand steps over, at any time.
const LOOK_AGAIN_AFTER: Duration = Duration::from_secs(5 * 60);

/// A run's handed-over steps: the folder of their markers and the folder
/// their content is kept in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AwaitedRun {
  pub(super) run_id: Uuid,
  awaited: PathBuf,
  kept: PathBuf,
}

/// What is sent for one step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StepUpload {
  /// One of [`STEP_KINDS`].
  pub(super) kind: &'static str,
  /// How many bytes the step produced.
  pub(super) total_bytes: u64,
  /// The kept bytes; `None` for an image past its cap, which sends its size.
  pub(super) content: Option<Vec<u8>>,
}

/// How the API answered one step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Answer {
  /// Stored, or refused for good: the step is not sent again.
  Settled,
  /// The run is not this account's to send for: its folder is left alone.
  NotThisAccount,
  /// The API could not be asked or could not take the step now.
  Later,
}

/// What to do with a run's folder.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RunPlan {
  /// It holds no step, or nobody judged its steps for [`LEFT_FOR`].
  Remove,
  /// Send these steps, by key.
  Send(Vec<String>),
}

/// How one look at the stores ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Pass {
  /// Nothing is left that can be sent now.
  Idle,
  /// Something is left for a later try.
  Later,
}

/// Sends one step to the API.
pub(super) trait StepSender: Send + Sync + 'static {
  fn send<'a>(
    &'a self,
    run_id: Uuid,
    step_key: &'a str,
    step: StepUpload,
  ) -> BoxFuture<'a, Answer>;
}

/// The directories in `dir` by name; links to directories are not among
/// them. A `dir` that is not there holds none.
fn directories_in(dir: &Path) -> std::io::Result<Vec<(String, PathBuf)>> {
  let entries = match std::fs::read_dir(dir) {
    Ok(entries) => entries,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      return Ok(Vec::new());
    }
    Err(error) => return Err(error),
  };
  let mut directories = Vec::new();
  for entry in entries {
    let entry = entry?;
    // `file_type` does not follow a link.
    if entry.file_type()?.is_dir()
      && let Ok(name) = entry.file_name().into_string()
    {
      directories.push((name, entry.path()));
    }
  }
  Ok(directories)
}

/// The run a handed-over folder's name names, in the one spelling the
/// sidecar writes.
fn awaited_run_id(name: &str) -> Option<Uuid> {
  let run = name.strip_suffix(AWAITED_SUFFIX)?;
  Uuid::parse_str(run)
    .ok()
    .filter(|run_id| run_id.to_string() == run)
}

/// Every handed-over folder in the step output stores beside the chat
/// folders in `folders`.
pub(super) fn awaited_runs(folders: &Path) -> std::io::Result<Vec<AwaitedRun>> {
  let mut runs = Vec::new();
  for (name, store) in directories_in(folders)? {
    let is_store = name
      .strip_suffix(STEP_OUTPUT_STORE_SUFFIX)
      .is_some_and(|chat| Uuid::parse_str(chat).is_ok());
    if !is_store {
      continue;
    }
    for (name, awaited) in directories_in(&store)? {
      if let Some(run_id) = awaited_run_id(&name) {
        runs.push(AwaitedRun {
          run_id,
          kept: store.join(run_id.to_string()),
          awaited,
        });
      }
    }
  }
  Ok(runs)
}

/// Whether a folder whose newest marker is from `newest` was left too long.
/// A clock that went back leaves it.
pub(super) fn left_too_long(newest: SystemTime, now: SystemTime) -> bool {
  now.duration_since(newest).is_ok_and(|age| age > LEFT_FOR)
}

/// What to do with `run`'s folder at `now`: its markers are the regular
/// files named by a step key, and nothing else in it counts.
pub(super) fn plan_run(
  run: &AwaitedRun,
  now: SystemTime,
  max_steps: usize,
) -> std::io::Result<RunPlan> {
  let mut step_keys = Vec::new();
  let mut newest: Option<SystemTime> = None;
  for entry in std::fs::read_dir(&run.awaited)? {
    let entry = entry?;
    let Ok(name) = entry.file_name().into_string() else {
      continue;
    };
    // Neither `file_type` nor an entry's `metadata` follows a link.
    if !entry.file_type()?.is_file() || !is_hex_key(&name) {
      continue;
    }
    let modified = entry.metadata()?.modified()?;
    newest = Some(newest.map_or(modified, |newest| newest.max(modified)));
    if step_keys.len() < max_steps {
      step_keys.push(name);
    }
  }
  Ok(match newest {
    Some(newest) if !left_too_long(newest, now) => RunPlan::Send(step_keys),
    Some(_) | None => RunPlan::Remove,
  })
}

/// A private regular file's bytes, read without following a link; `None`
/// when it holds more than `cap`.
fn read_capped(path: &Path, cap: u64) -> std::io::Result<Option<Vec<u8>>> {
  let file = local_store::open_private(OpenMode::Read, path)?;
  let mut bytes = Vec::new();
  file.take(cap.saturating_add(1)).read_to_end(&mut bytes)?;
  let within = u64::try_from(bytes.len()).is_ok_and(|length| length <= cap);
  Ok(within.then_some(bytes))
}

/// The kind a marker's bytes name.
pub(super) fn marker_kind(marker: &[u8]) -> Option<&'static str> {
  let named = std::str::from_utf8(marker).ok()?.trim();
  STEP_KINDS.into_iter().find(|kind| *kind == named)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StepHeader {
  bytes: u64,
}

/// A kept step file as what is sent for it: its header line, `{"bytes":<n>}`
/// with how many bytes the step produced, then the bytes kept of them.
pub(super) fn kept_step(kind: &'static str, mut file: Vec<u8>) -> Option<StepUpload> {
  let head = file.get(..file.len().min(STEP_HEADER_MAX_BYTES))?;
  let newline = head.iter().position(|byte| *byte == b'\n')?;
  let header: StepHeader = serde_json::from_slice(file.get(..newline)?).ok()?;
  let content = file.split_off(newline + 1);
  let kept = u64::try_from(content.len()).ok()?;
  if kept > header.bytes {
    // More kept than produced: not a file the sidecar wrote.
    return None;
  }
  Some(StepUpload {
    kind,
    total_bytes: header.bytes,
    // An image is kept whole or not at all: none kept is one past its cap.
    content: (kind != IMAGE_KIND || !content.is_empty()).then_some(content),
  })
}

/// What to send for one step of `run`; `None` when its marker or kept file
/// is missing, is not a regular file of the user's, is too large, or is not
/// what the sidecar writes. Such a step is never sent.
pub(super) fn read_step(run: &AwaitedRun, step_key: &str) -> Option<StepUpload> {
  if !is_hex_key(step_key) {
    return None;
  }
  let marker = read_capped(&run.awaited.join(step_key), MARKER_MAX_BYTES).ok()??;
  let kind = marker_kind(&marker)?;
  let header_and_kept =
    STEP_KEPT_MAX_BYTES.saturating_add(u64::try_from(STEP_HEADER_MAX_BYTES).ok()?);
  let file = read_capped(&run.kept.join(step_key), header_and_kept).ok()??;
  kept_step(kind, file)
}

/// The API's answer as what becomes of the step. A success counts only with
/// the API's own answer in it: some other server's page settles nothing.
pub(super) fn answer_of(status: u16, body: &[u8]) -> Answer {
  match status {
    200..=299 => {
      let stored = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .is_some_and(|answer| {
          answer.get("state").is_some_and(|state| state.is_string())
        });
      if stored {
        Answer::Settled
      } else {
        Answer::Later
      }
    }
    // The account may not send for this run, or does not know it.
    403 | 404 => Answer::NotThisAccount,
    401 | 408 | 429 | 500..=599 => Answer::Later,
    _ => Answer::Settled,
  }
}

fn forget_step(run: &AwaitedRun, step_key: &str) -> std::io::Result<()> {
  match local_store::remove_private(&run.awaited.join(step_key)) {
    Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
    Ok(()) | Err(_) => Ok(()),
  }
}

fn forget_run(run: &AwaitedRun) {
  // Removes a link in the folder, never what it points to.
  if let Err(error) = std::fs::remove_dir_all(&run.awaited)
    && error.kind() != std::io::ErrorKind::NotFound
  {
    tracing::warn!(target: LOG_TARGET, kind = ?error.kind(), "a run's sent steps were not removed");
  }
}

/// Runs `work` off the async threads; `None` when it could not run.
async fn blocking<T: Send + 'static>(
  work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
  tokio::task::spawn_blocking(work).await.ok()
}

/// How sending one run's steps ended.
enum Drained {
  /// The folder is gone, or left for the time it is kept.
  Done,
  Later,
}

/// Sends the steps runs handed over at their end.
pub(super) struct AwaitedSteps {
  /// Where the chat folders are, each with its step output store beside it.
  pub(super) folders: PathBuf,
  pub(super) sender: Arc<dyn StepSender>,
  /// Whether the runner's journal still holds the run.
  pub(super) holds: Arc<dyn Fn(&str) -> bool + Send + Sync>,
  pub(super) now: fn() -> SystemTime,
  /// Uniform in `[0, 1)`, for the delay between tries.
  pub(super) random: fn() -> f64,
  /// The most steps of one run sent before its folder is listed again.
  max_steps_per_listing: usize,
  /// Runs the API said are not this account's: not asked about again while
  /// the connection lasts, so a kept step is not sent over and over.
  not_this_account: Mutex<HashSet<Uuid>>,
}

/// What [`AwaitedSteps::new`] is made of.
pub(super) struct AwaitedStepsParts {
  pub(super) folders: PathBuf,
  pub(super) sender: Arc<dyn StepSender>,
  pub(super) holds: Arc<dyn Fn(&str) -> bool + Send + Sync>,
  pub(super) random: fn() -> f64,
}

impl AwaitedSteps {
  pub(super) fn new(parts: AwaitedStepsParts) -> Self {
    Self {
      folders: parts.folders,
      sender: parts.sender,
      holds: parts.holds,
      now: SystemTime::now,
      random: parts.random,
      max_steps_per_listing: MAX_STEPS_PER_LISTING,
      not_this_account: Mutex::default(),
    }
  }

  fn is_not_this_account(&self, run_id: Uuid) -> bool {
    self
      .not_this_account
      .lock()
      .is_ok_and(|runs| runs.contains(&run_id))
  }

  /// A new connection may be another account's: every run is asked about
  /// again.
  fn ask_about_every_run_again(&self) {
    if let Ok(mut runs) = self.not_this_account.lock() {
      runs.clear();
    }
  }

  /// Look at every store once and send what was handed over, one step at a
  /// time, until nothing is left or the API cannot take a step now.
  pub(super) async fn pass(&self) -> Pass {
    let folders = self.folders.clone();
    let Some(Ok(runs)) = blocking(move || awaited_runs(&folders)).await else {
      tracing::warn!(target: LOG_TARGET, "the step output stores could not be listed");
      return Pass::Later;
    };
    let mut pass = Pass::Idle;
    for run in runs {
      if self.is_not_this_account(run.run_id) {
        continue;
      }
      if (self.holds)(&run.run_id.to_string()) {
        // Not acknowledged yet: the API may not await the steps so far.
        pass = Pass::Later;
        continue;
      }
      match self.drain(run).await {
        Drained::Done => {}
        Drained::Later => return Pass::Later,
      }
    }
    pass
  }

  async fn drain(&self, run: AwaitedRun) -> Drained {
    let run = Arc::new(run);
    loop {
      let now = (self.now)();
      let max_steps = self.max_steps_per_listing;
      let listed = Arc::clone(&run);
      let planned = blocking(move || plan_run(&listed, now, max_steps)).await;
      let step_keys = match planned {
        Some(Ok(RunPlan::Send(step_keys))) => step_keys,
        Some(Ok(RunPlan::Remove)) => {
          let gone = Arc::clone(&run);
          if blocking(move || forget_run(&gone)).await.is_none() {
            tracing::warn!(target: LOG_TARGET, "a run's sent steps were not removed");
          }
          return Drained::Done;
        }
        Some(Err(_)) | None => {
          tracing::warn!(target: LOG_TARGET, "a run's handed-over steps could not be listed");
          return Drained::Done;
        }
      };
      for step_key in step_keys {
        let read = Arc::clone(&run);
        let key = step_key.clone();
        let step = blocking(move || read_step(&read, &key)).await.flatten();
        let answer = match step {
          Some(step) => self.sender.send(run.run_id, &step_key, step).await,
          // Nothing that can be sent: the step is dropped.
          None => Answer::Settled,
        };
        match answer {
          Answer::Settled => {
            let sent = Arc::clone(&run);
            let removed = blocking(move || forget_step(&sent, &step_key)).await;
            if !matches!(removed, Some(Ok(()))) {
              // A marker that stays would be sent again without end.
              tracing::warn!(target: LOG_TARGET, "a sent step's marker was not removed");
              return Drained::Done;
            }
          }
          Answer::NotThisAccount => {
            if let Ok(mut runs) = self.not_this_account.lock() {
              runs.insert(run.run_id);
            }
            return Drained::Done;
          }
          Answer::Later => return Drained::Later,
        }
      }
    }
  }

  /// Send what was handed over whenever the runner is connected: at each
  /// connection, then every [`LOOK_AGAIN_AFTER`] while it lasts, and after
  /// a growing pause while something is left for later. Never returns; the
  /// holder drops it to stop it.
  pub(super) async fn run(self, mut states: watch::Receiver<RunnerState>) {
    let mut backoff = Backoff::new(RETRY_BASE, RETRY_CAP);
    loop {
      let connected = *states.borrow() == RunnerState::Connected;
      if !connected {
        self.ask_about_every_run_again();
        until_connected(&mut states, true).await;
      }
      match self.pass().await {
        Pass::Idle => {
          backoff.reset();
          let disconnected = until_connected(&mut states, false);
          if tokio::time::timeout(LOOK_AGAIN_AFTER, disconnected)
            .await
            .is_ok()
          {
            self.ask_about_every_run_again();
          }
        }
        Pass::Later => {
          tokio::time::sleep(backoff.next_delay((self.random)())).await;
        }
      }
    }
  }
}

/// Resolves once the runner is connected, or is not, as `connected` says;
/// never once the runner's state is gone.
async fn until_connected(states: &mut watch::Receiver<RunnerState>, connected: bool) {
  let reached = states
    .wait_for(|state| (*state == RunnerState::Connected) == connected)
    .await
    .is_ok();
  if !reached {
    std::future::pending::<()>().await;
  }
}

/// Sends a step as the computer: the linked account's credential with a
/// proof by the device key, for the installation the run ran on.
pub(super) struct AccountStepSender {
  pub(super) auth: Arc<dyn RunnerAuth>,
  pub(super) desktop_id: Uuid,
}

impl StepSender for AccountStepSender {
  fn send<'a>(
    &'a self,
    run_id: Uuid,
    step_key: &'a str,
    step: StepUpload,
  ) -> BoxFuture<'a, Answer> {
    Box::pin(async move {
      let Ok(Some(authorized)) = self.auth.authorize().await else {
        // Signed out, or the account cannot be read now.
        return Answer::Later;
      };
      let target = StepTarget {
        desktop_id: self.desktop_id,
        run_id,
        step_key,
      };
      send_step(authorized, &target, step).await
    })
  }
}

struct StepTarget<'a> {
  desktop_id: Uuid,
  run_id: Uuid,
  step_key: &'a str,
}

/// Where a computer sends an awaited step of a run that is over.
fn step_url(api_base_url: &str, run_id: Uuid, step_key: &str) -> String {
  format!(
    "{}/v1/desktop/runner/runs/{run_id}/steps/{step_key}/content",
    api_base_url.trim_end_matches('/')
  )
}

/// Holds the account, and with it the lease on its credential, until the
/// API answered.
async fn send_step(
  authorized: Authorized,
  target: &StepTarget<'_>,
  step: StepUpload,
) -> Answer {
  let Ok(client) = DesktopHttpClient::new(HttpClientOptions {
    // A redirect would move the credential to another URL.
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(SEND_TIMEOUT),
  }) else {
    return Answer::Later;
  };
  let mut form = reqwest::multipart::Form::new();
  if let Some(content) = step.content {
    form = form.part(
      "content",
      reqwest::multipart::Part::bytes(content).file_name("content"),
    );
  }
  let request = client
    .put(step_url(
      &authorized.api_base_url,
      target.run_id,
      target.step_key,
    ))
    .query(&[
      ("kind", step.kind.to_owned()),
      ("totalBytes", step.total_bytes.to_string()),
    ])
    .header(DESKTOP_ID_HEADER, target.desktop_id.to_string())
    .multipart(form);
  let Ok(request) = crate::http_client::device_proof_request(
    request,
    &authorized.device_key,
    Some(authorized.bearer.as_str()),
    None,
  ) else {
    return Answer::Later;
  };
  let Ok(mut response) = request.send().await else {
    return Answer::Later;
  };
  let status = response.status().as_u16();
  let mut body = Vec::new();
  loop {
    match response.chunk().await {
      Ok(Some(chunk)) if body.len() + chunk.len() <= ANSWER_MAX_BYTES => {
        body.extend_from_slice(&chunk);
      }
      Ok(None) => return answer_of(status, &body),
      // An answer cut short or too long is not the API's answer.
      Ok(Some(_)) | Err(_) => return answer_of(status, &[]),
    }
  }
}

#[cfg(test)]
#[allow(
  clippy::disallowed_methods,
  reason = "tests construct local file fixtures"
)]
mod tests {
  use super::*;

  const DAY: Duration = Duration::from_secs(24 * 60 * 60);

  /// A folder of chat folders with one chat's step output store in it.
  struct Stores {
    folders: PathBuf,
    store: PathBuf,
  }

  impl Stores {
    fn new() -> Self {
      let folders =
        std::env::temp_dir().join(format!("awaited-steps-{}", Uuid::new_v4()));
      let store = folders.join(format!("{}{STEP_OUTPUT_STORE_SUFFIX}", Uuid::new_v4()));
      local_store::create_private_dir(&store).unwrap();
      Self { folders, store }
    }

    /// A run that handed `steps` over, each `(key, kind, kept file)`.
    fn run(&self, steps: &[(String, &str, Vec<u8>)]) -> AwaitedRun {
      let run_id = Uuid::new_v4();
      let run = AwaitedRun {
        run_id,
        awaited: self.store.join(format!("{run_id}{AWAITED_SUFFIX}")),
        kept: self.store.join(run_id.to_string()),
      };
      local_store::create_private_dir(&run.awaited).unwrap();
      local_store::create_private_dir(&run.kept).unwrap();
      for (key, kind, kept) in steps {
        local_store::write_test_fixture(run.awaited.join(key), kind).unwrap();
        local_store::write_test_fixture(run.kept.join(key), kept).unwrap();
      }
      run
    }
  }

  impl Drop for Stores {
    fn drop(&mut self) {
      drop(std::fs::remove_dir_all(&self.folders));
    }
  }

  fn key(fill: char) -> String {
    fill.to_string().repeat(64)
  }

  fn kept(total: u64, content: &[u8]) -> Vec<u8> {
    let mut file = format!("{{\"bytes\":{total}}}\n").into_bytes();
    file.extend_from_slice(content);
    file
  }

  fn markers(run: &AwaitedRun) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(&run.awaited) else {
      return Vec::new();
    };
    let mut names: Vec<String> = entries
      .map(|entry| entry.unwrap().file_name().into_string().unwrap())
      .collect();
    names.sort();
    names
  }

  /// Answers each step as scripted (`Settled` once the script is used up)
  /// and records what it was asked to send.
  #[derive(Default)]
  struct Scripted {
    answers: Mutex<Vec<Answer>>,
    sent: Mutex<Vec<(Uuid, String, StepUpload)>>,
  }

  impl Scripted {
    fn answering(answers: &[Answer]) -> Arc<Self> {
      let mut answers = answers.to_vec();
      answers.reverse();
      Arc::new(Self {
        answers: Mutex::new(answers),
        sent: Mutex::default(),
      })
    }

    fn sent_keys(&self) -> Vec<String> {
      let mut keys: Vec<String> = self
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|(_, key, _)| key.clone())
        .collect();
      keys.sort();
      keys
    }
  }

  impl StepSender for Scripted {
    fn send<'a>(
      &'a self,
      run_id: Uuid,
      step_key: &'a str,
      step: StepUpload,
    ) -> BoxFuture<'a, Answer> {
      self
        .sent
        .lock()
        .unwrap()
        .push((run_id, step_key.to_owned(), step));
      let answer = self
        .answers
        .lock()
        .unwrap()
        .pop()
        .unwrap_or(Answer::Settled);
      Box::pin(async move { answer })
    }
  }

  fn steps_of(stores: &Stores, sender: &Arc<Scripted>) -> AwaitedSteps {
    AwaitedSteps::new(AwaitedStepsParts {
      folders: stores.folders.clone(),
      sender: Arc::clone(sender) as Arc<dyn StepSender>,
      holds: Arc::new(|_run: &str| false),
      random: || 0.5,
    })
  }

  fn plan(run: &AwaitedRun, now: SystemTime) -> RunPlan {
    plan_run(run, now, MAX_STEPS_PER_LISTING).unwrap().sorted()
  }

  #[test]
  fn only_handed_over_folders_of_runs_in_step_stores_are_found() {
    let stores = Stores::new();
    let run = stores.run(&[]);
    // The sidecar's own folder of a run that still goes, a run's kept steps,
    // a name that is no run, and a store-like folder that is no chat's.
    let going = Uuid::new_v4();
    local_store::create_private_dir(&stores.store.join(format!("{going}.pending")))
      .unwrap();
    local_store::create_private_dir(&stores.store.join(going.to_string())).unwrap();
    local_store::create_private_dir(&stores.store.join("notes.awaited")).unwrap();
    local_store::create_private_dir(
      &stores
        .folders
        .join(format!("other{STEP_OUTPUT_STORE_SUFFIX}"))
        .join(format!("{}{AWAITED_SUFFIX}", Uuid::new_v4())),
    )
    .unwrap();
    assert_eq!(awaited_runs(&stores.folders).unwrap(), vec![run]);
    assert!(
      awaited_runs(&stores.folders.join("missing"))
        .unwrap()
        .is_empty()
    );
  }

  #[cfg(unix)]
  #[test]
  fn a_link_is_never_a_store_a_run_or_a_step() {
    let stores = Stores::new();
    let run = stores.run(&[(key('a'), "command", kept(3, b"out"))]);
    let outside = stores.folders.join("outside");
    local_store::create_private_dir(&outside).unwrap();
    local_store::write_test_fixture(outside.join("secret"), kept(6, b"secret"))
      .unwrap();
    // A linked store, a linked run folder, a linked marker and a linked
    // kept file, each pointing out of the step store.
    std::os::unix::fs::symlink(
      &stores.store,
      stores
        .folders
        .join(format!("{}{STEP_OUTPUT_STORE_SUFFIX}", Uuid::new_v4())),
    )
    .unwrap();
    std::os::unix::fs::symlink(
      &outside,
      stores
        .store
        .join(format!("{}{AWAITED_SUFFIX}", Uuid::new_v4())),
    )
    .unwrap();
    std::os::unix::fs::symlink(outside.join("secret"), run.awaited.join(key('b')))
      .unwrap();
    local_store::write_test_fixture(run.awaited.join(key('c')), "command").unwrap();
    std::os::unix::fs::symlink(outside.join("secret"), run.kept.join(key('c')))
      .unwrap();

    assert_eq!(awaited_runs(&stores.folders).unwrap(), vec![run.clone()]);
    assert_eq!(
      plan(&run, SystemTime::now()),
      RunPlan::Send(vec![key('a'), key('c')])
    );
    assert!(read_step(&run, &key('a')).is_some());
    assert_eq!(read_step(&run, &key('b')), None);
    assert_eq!(read_step(&run, &key('c')), None);
    // Removing the folder removes the links, not what they point to.
    forget_run(&run);
    assert!(!run.awaited.exists());
    assert!(outside.join("secret").is_file());
  }

  impl RunPlan {
    /// The listing order is the file system's: compare by sorted keys.
    fn sorted(self) -> Self {
      match self {
        Self::Send(mut keys) => {
          keys.sort();
          Self::Send(keys)
        }
        Self::Remove => Self::Remove,
      }
    }
  }

  #[test]
  fn a_folder_is_sent_while_it_holds_steps_and_removed_once_empty_or_left_too_long() {
    let stores = Stores::new();
    let run = stores.run(&[(key('a'), "command", kept(3, b"out"))]);
    local_store::write_test_fixture(run.awaited.join("notes.txt"), "not a step")
      .unwrap();
    let now = SystemTime::now();
    assert_eq!(plan(&run, now), RunPlan::Send(vec![key('a')]));
    assert_eq!(
      plan(&run, now + LEFT_FOR - DAY),
      RunPlan::Send(vec![key('a')])
    );
    assert_eq!(plan(&run, now + LEFT_FOR + DAY), RunPlan::Remove);
    // A clock that went back removes nothing.
    assert_eq!(plan(&run, now - DAY), RunPlan::Send(vec![key('a')]));
    // Only what is not a marker is left: nothing to wait for.
    forget_step(&run, &key('a')).unwrap();
    assert_eq!(plan(&run, now), RunPlan::Remove);
    // A marker that is already gone is no failure.
    forget_step(&run, &key('a')).unwrap();
  }

  #[test]
  fn the_local_wait_is_longer_than_the_time_the_api_awaits_a_step() {
    // The API awaits a step for as long as a run waits for its computer (a
    // day); a folder is given up here only well after that.
    assert!(LEFT_FOR > DAY * 2);
    let now = SystemTime::now();
    assert!(!left_too_long(now - DAY, now));
    assert!(left_too_long(now - LEFT_FOR - Duration::from_secs(1), now));
    assert!(!left_too_long(now + DAY, now));
  }

  #[test]
  fn a_kept_step_is_read_as_the_sidecar_wrote_it() {
    assert_eq!(
      kept_step("command", kept(10, b"out")),
      Some(StepUpload {
        kind: "command",
        total_bytes: 10,
        content: Some(b"out".to_vec()),
      })
    );
    // A command that printed nothing sends its empty output; an image with
    // none kept was past its cap and sends its size alone.
    assert_eq!(
      kept_step("command", kept(0, b"")).unwrap().content,
      Some(Vec::new())
    );
    assert_eq!(kept_step("image", kept(99, b"")).unwrap().content, None);
    assert_eq!(
      kept_step("image", kept(3, b"png")).unwrap().content,
      Some(b"png".to_vec())
    );
    // Not the sidecar's: no header line, a header that says something else,
    // more kept than produced, a header past its length.
    assert_eq!(kept_step("command", b"out".to_vec()), None);
    assert_eq!(kept_step("command", b"{\"size\":3}\nout".to_vec()), None);
    assert_eq!(kept_step("command", kept(2, b"out")), None);
    let mut long = vec![b' '; STEP_HEADER_MAX_BYTES];
    long.extend_from_slice(&kept(3, b"out"));
    assert_eq!(kept_step("command", long), None);
  }

  #[test]
  fn a_marker_names_one_of_the_kinds_or_nothing() {
    assert_eq!(marker_kind(b"command"), Some("command"));
    assert_eq!(marker_kind(b"diff\n"), Some("diff"));
    assert_eq!(marker_kind(b"conversation"), Some("conversation"));
    assert_eq!(marker_kind(b"image"), Some("image"));
    assert_eq!(marker_kind(b"video"), None);
    assert_eq!(marker_kind(b""), None);
    assert_eq!(marker_kind(&[0xff, 0xfe]), None);
  }

  #[test]
  fn a_step_that_cannot_be_what_the_sidecar_wrote_is_not_read() {
    let stores = Stores::new();
    let cap = usize::try_from(STEP_KEPT_MAX_BYTES).unwrap();
    let run = stores.run(&[
      (key('a'), "command", kept(3, b"out")),
      (key('b'), "video", kept(3, b"out")),
      (key('c'), "a kind far too long to be one", kept(3, b"out")),
      (key('d'), "command", b"no header".to_vec()),
      (key('e'), "image", kept(u64::MAX, &vec![0; cap])),
      (key('f'), "image", kept(u64::MAX, &vec![0; cap + 64])),
    ]);
    assert!(read_step(&run, &key('a')).is_some());
    for refused in ['b', 'c', 'd', 'f'] {
      assert_eq!(read_step(&run, &key(refused)), None, "step {refused}");
    }
    // The largest kept share is read whole.
    assert_eq!(
      read_step(&run, &key('e')).unwrap().content.unwrap().len(),
      cap
    );
    // No marker, no kept file, and a key that is none.
    assert_eq!(read_step(&run, &key('0')), None);
    local_store::write_test_fixture(run.awaited.join(key('1')), "command").unwrap();
    assert_eq!(read_step(&run, &key('1')), None);
    assert_eq!(read_step(&run, "../key"), None);
  }

  #[test]
  fn an_answer_settles_a_step_leaves_it_or_asks_again() {
    let stored = br#"{"state":"stored"}"#;
    assert_eq!(answer_of(200, stored), Answer::Settled);
    assert_eq!(answer_of(200, br#"{"state":"too_large"}"#), Answer::Settled);
    // A success that is not the API's answer settles nothing.
    assert_eq!(answer_of(200, b"<html>Sign in</html>"), Answer::Later);
    assert_eq!(answer_of(200, b""), Answer::Later);
    assert_eq!(answer_of(200, br#"{"state":1}"#), Answer::Later);
    // Refused for good: not awaited, its time passed, another computer,
    // other content, a request the API cannot read.
    for status in [400, 409, 410, 413, 422] {
      assert_eq!(answer_of(status, b""), Answer::Settled, "status {status}");
    }
    for status in [403, 404] {
      assert_eq!(
        answer_of(status, b""),
        Answer::NotThisAccount,
        "status {status}"
      );
    }
    for status in [401, 408, 429, 500, 502, 503, 504] {
      assert_eq!(answer_of(status, b""), Answer::Later, "status {status}");
    }
  }

  #[tokio::test]
  async fn handed_over_steps_are_sent_one_at_a_time_and_their_folder_goes() {
    let stores = Stores::new();
    let run = stores.run(&[
      (key('a'), "command", kept(3, b"out")),
      (key('b'), "image", kept(99, b"")),
    ]);
    let sender = Scripted::answering(&[]);
    let steps = steps_of(&stores, &sender);
    assert_eq!(steps.pass().await, Pass::Idle);
    let mut sent = sender.sent.lock().unwrap().clone();
    sent.sort_by(|left, right| left.1.cmp(&right.1));
    assert_eq!(
      sent,
      vec![
        (
          run.run_id,
          key('a'),
          StepUpload {
            kind: "command",
            total_bytes: 3,
            content: Some(b"out".to_vec()),
          }
        ),
        (
          run.run_id,
          key('b'),
          StepUpload {
            kind: "image",
            total_bytes: 99,
            content: None,
          }
        ),
      ]
    );
    assert!(!run.awaited.exists());
    // The kept steps are not this module's to remove.
    assert!(run.kept.join(key('a')).is_file());
    // A second look finds nothing and sends nothing.
    assert_eq!(steps.pass().await, Pass::Idle);
    assert_eq!(sender.sent.lock().unwrap().len(), 2);
  }

  #[tokio::test]
  async fn a_step_the_api_cannot_take_now_stays_and_ends_the_pass() {
    let stores = Stores::new();
    let first = stores.run(&[
      (key('a'), "command", kept(3, b"out")),
      (key('b'), "command", kept(3, b"out")),
    ]);
    let second = stores.run(&[(key('c'), "command", kept(3, b"out"))]);
    let sender = Scripted::answering(&[Answer::Later]);
    let steps = steps_of(&stores, &sender);
    // The first step asked is not taken: nothing else is asked.
    assert_eq!(steps.pass().await, Pass::Later);
    assert_eq!(sender.sent.lock().unwrap().len(), 1);
    assert_eq!(markers(&first).len() + markers(&second).len(), 3);
    // The next pass sends every step, the one not taken among them.
    assert_eq!(steps.pass().await, Pass::Idle);
    assert_eq!(sender.sent.lock().unwrap().len(), 4);
    assert!(!first.awaited.exists());
    assert!(!second.awaited.exists());
  }

  #[tokio::test]
  async fn a_run_of_another_account_is_left_and_the_others_are_still_sent() {
    let stores = Stores::new();
    let first = stores.run(&[(key('a'), "command", kept(3, b"out"))]);
    let second = stores.run(&[(key('b'), "command", kept(3, b"out"))]);
    let sender = Scripted::answering(&[Answer::NotThisAccount]);
    let steps = steps_of(&stores, &sender);
    assert_eq!(steps.pass().await, Pass::Idle);
    // Whichever run was asked first is left whole; the other is gone.
    assert_eq!(sender.sent_keys(), vec![key('a'), key('b')]);
    assert_eq!(markers(&first).len() + markers(&second).len(), 1);
    assert_ne!(first.awaited.exists(), second.awaited.exists());
    // While the connection lasts the run is not asked about again.
    assert_eq!(steps.pass().await, Pass::Idle);
    assert_eq!(sender.sent.lock().unwrap().len(), 2);
    // A new connection may be the run's own account: it is asked again.
    steps.ask_about_every_run_again();
    assert_eq!(steps.pass().await, Pass::Idle);
    assert_eq!(sender.sent.lock().unwrap().len(), 3);
    assert!(!first.awaited.exists());
    assert!(!second.awaited.exists());
  }

  #[tokio::test]
  async fn a_run_the_journal_still_holds_is_not_sent_until_it_is_acknowledged() {
    let stores = Stores::new();
    let held = stores.run(&[(key('a'), "command", kept(3, b"out"))]);
    let free = stores.run(&[(key('b'), "command", kept(3, b"out"))]);
    let sender = Scripted::answering(&[]);
    let held_id = held.run_id.to_string();
    let steps = AwaitedSteps {
      holds: Arc::new(move |run: &str| run == held_id),
      ..steps_of(&stores, &sender)
    };
    assert_eq!(steps.pass().await, Pass::Later);
    assert_eq!(sender.sent_keys(), vec![key('b')]);
    assert_eq!(markers(&held), vec![key('a')]);
    assert!(!free.awaited.exists());
    // Acknowledged: the journal let the run go.
    let steps = steps_of(&stores, &sender);
    assert_eq!(steps.pass().await, Pass::Idle);
    assert_eq!(sender.sent_keys(), vec![key('a'), key('b')]);
    assert!(!held.awaited.exists());
  }

  #[tokio::test]
  async fn a_step_that_cannot_be_sent_is_dropped_without_asking_the_api() {
    let stores = Stores::new();
    let run = stores.run(&[
      (key('a'), "video", kept(3, b"out")),
      (key('b'), "command", b"no header".to_vec()),
    ]);
    local_store::write_test_fixture(run.awaited.join(key('c')), "command").unwrap();
    let sender = Scripted::answering(&[]);
    assert_eq!(steps_of(&stores, &sender).pass().await, Pass::Idle);
    assert!(sender.sent.lock().unwrap().is_empty());
    assert!(!run.awaited.exists());
  }

  #[tokio::test]
  async fn a_folder_nobody_judged_for_too_long_is_removed_unsent() {
    let stores = Stores::new();
    let run = stores.run(&[(key('a'), "command", kept(3, b"out"))]);
    let sender = Scripted::answering(&[]);
    let steps = AwaitedSteps {
      now: || SystemTime::now() + LEFT_FOR + DAY,
      ..steps_of(&stores, &sender)
    };
    assert_eq!(steps.pass().await, Pass::Idle);
    assert!(sender.sent.lock().unwrap().is_empty());
    assert!(!run.awaited.exists());
  }

  #[tokio::test]
  async fn more_steps_than_one_listing_holds_are_all_sent() {
    let stores = Stores::new();
    let steps: Vec<(String, &str, Vec<u8>)> = ('a'..='e')
      .map(|fill| (key(fill), "command", kept(1, b"x")))
      .collect();
    let run = stores.run(&steps);
    assert!(matches!(
      plan_run(&run, SystemTime::now(), 2).unwrap(),
      RunPlan::Send(listed) if listed.len() == 2
    ));
    let sender = Scripted::answering(&[]);
    let sending = AwaitedSteps {
      max_steps_per_listing: 2,
      ..steps_of(&stores, &sender)
    };
    assert_eq!(sending.pass().await, Pass::Idle);
    assert_eq!(sender.sent_keys(), ('a'..='e').map(key).collect::<Vec<_>>());
    assert!(!run.awaited.exists());
  }

  struct FixtureAuth {
    api_base_url: String,
    device_key: crate::device_proof::DeviceKey,
  }

  impl RunnerAuth for FixtureAuth {
    fn authorize(&self) -> BoxFuture<'_, Result<Option<Authorized>, String>> {
      Box::pin(async move {
        Ok(Some(Authorized {
          api_base_url: self.api_base_url.clone(),
          bearer: zeroize::Zeroizing::new("fixture_key".to_owned()),
          device_key: self.device_key.clone(),
          namespace: "fixture".to_owned(),
          lease: None,
        }))
      })
    }
  }

  #[tokio::test]
  async fn a_step_is_put_to_the_api_as_the_computer_the_run_ran_on() {
    use axum::{
      Router,
      body::Bytes,
      extract::OriginalUri,
      http::{HeaderMap, StatusCode},
      routing::put,
    };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let device_key = crate::device_proof::DeviceKey::fixture();
    let thumbprint = device_key.thumbprint().unwrap();
    let desktop_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let received = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&received);
    let origin = base.clone();
    let router = Router::new().route(
      "/v1/desktop/runner/runs/{run_id}/steps/{step_key}/content",
      put(
        move |OriginalUri(uri): OriginalUri, headers: HeaderMap, body: Bytes| {
          let mut request = reqwest::Request::new(
            reqwest::Method::PUT,
            format!("{origin}{uri}").parse().unwrap(),
          );
          *request.headers_mut() = headers.clone();
          crate::device_proof::tests::verify_request(
            &request,
            &thumbprint,
            Some("fixture_key"),
            None,
          );
          let is_form = headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("multipart/form-data; boundary=");
          let body = String::from_utf8(body.to_vec()).unwrap();
          // The form's one part, if it has one: its bytes.
          let content = body.contains("name=\"content\"").then(|| {
            let part = body.split("\r\n\r\n").nth(1).unwrap();
            part.split("\r\n--").next().unwrap().to_owned()
          });
          let image = uri
            .query()
            .is_some_and(|query| query.contains("kind=image"));
          seen.lock().unwrap().push((
            uri.to_string(),
            headers[DESKTOP_ID_HEADER].to_str().unwrap().to_owned(),
            is_form,
            content,
          ));
          async move {
            if image {
              (StatusCode::CONFLICT, r#"{"code":"step_not_awaited"}"#)
            } else {
              (StatusCode::OK, r#"{"state":"stored"}"#)
            }
          }
        },
      ),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let sender = AccountStepSender {
      auth: Arc::new(FixtureAuth {
        api_base_url: format!("{base}/"),
        device_key,
      }),
      desktop_id,
    };
    let stored = sender
      .send(
        run_id,
        &key('a'),
        StepUpload {
          kind: "command",
          total_bytes: 12,
          content: Some(b"out".to_vec()),
        },
      )
      .await;
    let refused = sender
      .send(
        run_id,
        &key('b'),
        StepUpload {
          kind: "image",
          total_bytes: 99,
          content: None,
        },
      )
      .await;
    server.abort();
    assert_eq!(stored, Answer::Settled);
    assert_eq!(refused, Answer::Settled);
    assert_eq!(
      *received.lock().unwrap(),
      vec![
        (
          format!(
            "/v1/desktop/runner/runs/{run_id}/steps/{}/content?kind=command&totalBytes=12",
            key('a')
          ),
          desktop_id.to_string(),
          true,
          Some("out".to_owned()),
        ),
        (
          format!(
            "/v1/desktop/runner/runs/{run_id}/steps/{}/content?kind=image&totalBytes=99",
            key('b')
          ),
          desktop_id.to_string(),
          true,
          None,
        ),
      ]
    );
    // Nothing listens there: the API cannot be reached.
    let unused = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let nowhere = format!("http://{}", unused.local_addr().unwrap());
    drop(unused);
    let sender = AccountStepSender {
      auth: Arc::new(FixtureAuth {
        api_base_url: nowhere,
        device_key: crate::device_proof::DeviceKey::fixture(),
      }),
      desktop_id,
    };
    let away = sender
      .send(
        run_id,
        &key('c'),
        StepUpload {
          kind: "command",
          total_bytes: 1,
          content: Some(b"x".to_vec()),
        },
      )
      .await;
    assert_eq!(away, Answer::Later);
  }
}
