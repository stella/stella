//! Sign in to Claude Code for the local agents: the managed CLI's own
//! sign-in, pointed at its Stella-owned configuration directory.
//!
//! The desktop never runs an OAuth flow for Claude and never handles the
//! user's Claude credentials. It starts `claude auth login`, which opens the
//! browser and keeps the sign-in where the CLI always keeps it (the system
//! keychain on macOS, its configuration directory elsewhere); it reads the
//! state through `claude auth status --json`, and signs out through
//! `claude auth logout`. Each runs with the environment rules in [`cli`].
//!
//! Approach adapted from t3code (MIT, `ClaudeHome.ts`): a separate Claude
//! account is a separate `CLAUDE_CONFIG_DIR`, signed in with the CLI's own
//! `claude auth login` and `HOME` left in place so the keychain is found.
//!
//! The sign-in counts the way the agent engine's Claude Code adapter counts
//! it: a Claude subscription runs turns, an API key does not.

mod cli;
#[cfg(all(test, unix))]
mod tests;

use std::{
  sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
  },
  time::Duration,
};

use serde::Serialize;
use tokio::sync::oneshot;

pub(crate) use cli::ClaudeCodeLaunch;
use cli::SignIn;

pub(crate) struct ClaudeCodeAuthConfig {
  /// How long the browser sign-in may take before the CLI is stopped.
  pub sign_in_timeout: Duration,
  /// How long a status read or a sign-out may take.
  pub command_timeout: Duration,
}

impl ClaudeCodeAuthConfig {
  pub(crate) fn standard() -> Self {
    Self {
      sign_in_timeout: Duration::from_secs(10 * 60),
      command_timeout: Duration::from_secs(30),
    }
  }
}

/// What a window may know about the sign-in. It carries no credential and
/// no sign-in link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
  tag = "state",
  rename_all = "snake_case",
  rename_all_fields = "camelCase"
)]
pub enum ClaudeCodeStatus {
  /// The managed CLI is not installed, so nothing can sign in yet.
  NotInstalled,
  SignedOut,
  SigningIn {
    /// The CLI printed its sign-in page, which can be opened again.
    sign_in_page: bool,
  },
  SignedIn {
    email: Option<String>,
    plan: Option<String>,
  },
  /// Signed in with an API key, which local agents do not use.
  ApiKey,
  Failed {
    reason: ClaudeCodeFailure,
  },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeCodeFailure {
  /// The CLI ended without a subscription sign-in.
  NotCompleted,
  TimedOut,
  /// The CLI could not be started or its status read.
  Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LaunchError {
  NotInstalled,
  Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignOutError {
  /// A sign-in is in progress; cancel it first.
  SigningIn,
  NotInstalled,
  Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenPageError {
  /// No sign-in is in progress, or the CLI has not named its page yet.
  NoPage,
  BrowserUnavailable,
}

pub(crate) struct ClaudeCodeAuthHooks {
  /// The managed CLI to run, held in place for as long as the value lives.
  pub launch: Box<dyn Fn() -> Result<ClaudeCodeLaunch, LaunchError> + Send + Sync>,
  /// Opens the system browser.
  pub open_browser: Box<dyn Fn(&str) -> bool + Send + Sync>,
  /// The status changed; windows pull it again.
  pub changed: Box<dyn Fn() + Send + Sync>,
}

#[derive(Clone)]
pub struct ClaudeCodeAuth(Arc<Inner>);

struct Inner {
  config: ClaudeCodeAuthConfig,
  hooks: ClaudeCodeAuthHooks,
  attempt: Mutex<Option<Attempt>>,
  /// The last sign-in's failure, shown until the next one starts.
  failure: Mutex<Option<ClaudeCodeFailure>>,
  next_attempt: AtomicU64,
  /// Serializes the commands that change the sign-in.
  changing: tokio::sync::Mutex<()>,
}

struct Attempt {
  id: u64,
  /// The page the CLI asked the browser to open. It holds no credential,
  /// but it is never logged or sent to a window.
  sign_in_page: Option<String>,
  _cancel: oneshot::Sender<()>,
}

enum AttemptEnd {
  Settled(Result<(), ClaudeCodeFailure>),
  Cancelled,
}

impl ClaudeCodeAuth {
  pub(crate) fn new(config: ClaudeCodeAuthConfig, hooks: ClaudeCodeAuthHooks) -> Self {
    Self(Arc::new(Inner {
      config,
      hooks,
      attempt: Mutex::new(None),
      failure: Mutex::new(None),
      next_attempt: AtomicU64::new(1),
      changing: tokio::sync::Mutex::new(()),
    }))
  }

  /// The sign-in as the CLI reports it, with a sign-in in progress or the
  /// last one's failure shown over it.
  pub(crate) async fn status(&self) -> ClaudeCodeStatus {
    if let Some(signing_in) = self.signing_in() {
      return signing_in;
    }
    let read = match (self.0.hooks.launch)() {
      Err(LaunchError::NotInstalled) => return ClaudeCodeStatus::NotInstalled,
      Err(LaunchError::Unavailable) => None,
      Ok(launch) => self.read_sign_in(&launch).await,
    };
    // A sign-in that started while the CLI answered is what the user sees.
    if let Some(signing_in) = self.signing_in() {
      return signing_in;
    }
    let failure = self.0.failure.lock().ok().and_then(|failure| *failure);
    match (read, failure) {
      (Some(SignIn::Subscription { email, plan }), _) => {
        ClaudeCodeStatus::SignedIn { email, plan }
      }
      (Some(SignIn::ApiKey), _) => ClaudeCodeStatus::ApiKey,
      (Some(SignIn::None), Some(reason)) => ClaudeCodeStatus::Failed { reason },
      (Some(SignIn::None), None) => ClaudeCodeStatus::SignedOut,
      (None, _) => ClaudeCodeStatus::Failed {
        reason: ClaudeCodeFailure::Unavailable,
      },
    }
  }

  fn signing_in(&self) -> Option<ClaudeCodeStatus> {
    let attempt = self.0.attempt.lock().ok()?;
    attempt.as_ref().map(|attempt| ClaudeCodeStatus::SigningIn {
      sign_in_page: attempt.sign_in_page.is_some(),
    })
  }

  async fn read_sign_in(&self, launch: &ClaudeCodeLaunch) -> Option<SignIn> {
    let command = cli::command(launch, &cli::STATUS_ARGS);
    let (_status, stdout) = cli::run(command, self.0.config.command_timeout)
      .await
      .inspect_err(|error| {
        tracing::warn!(?error, "Claude Code sign-in status was not read");
      })
      .ok()?;
    cli::parse_status(&stdout)
  }

  /// Starts the CLI's browser sign-in. While one is in progress another
  /// start does nothing, so a repeated click cannot start a second CLI;
  /// cancel it first to start over.
  pub(crate) fn start(&self) {
    let id = self.0.next_attempt.fetch_add(1, Ordering::Relaxed);
    let (cancel, cancelled) = oneshot::channel();
    let Ok(mut attempt) = self.0.attempt.lock() else {
      return;
    };
    if attempt.is_some() {
      return;
    }
    *attempt = Some(Attempt {
      id,
      sign_in_page: None,
      _cancel: cancel,
    });
    drop(attempt);
    if let Ok(mut failure) = self.0.failure.lock() {
      failure.take();
    }
    (self.0.hooks.changed)();
    let auth = self.clone();
    tokio::spawn(async move {
      let end = tokio::select! {
        result = auth.run_attempt(id) => AttemptEnd::Settled(result),
        _ = cancelled => AttemptEnd::Cancelled,
      };
      auth.finish_attempt(id, end);
    });
  }

  /// Stops the sign-in in progress, if any; its CLI is killed.
  pub(crate) fn cancel(&self) {
    let cancelled = self
      .0
      .attempt
      .lock()
      .is_ok_and(|mut attempt| attempt.take().is_some());
    if cancelled {
      (self.0.hooks.changed)();
    }
  }

  fn finish_attempt(&self, id: u64, end: AttemptEnd) {
    let current = self.0.attempt.lock().is_ok_and(|mut attempt| {
      if attempt.as_ref().is_some_and(|attempt| attempt.id == id) {
        attempt.take();
        true
      } else {
        false
      }
    });
    // A cancelled attempt was taken, and the change shown, by `cancel`.
    if !current {
      return;
    }
    if let AttemptEnd::Settled(Err(reason)) = end
      && let Ok(mut failure) = self.0.failure.lock()
    {
      *failure = Some(reason);
    }
    (self.0.hooks.changed)();
  }

  async fn run_attempt(&self, id: u64) -> Result<(), ClaudeCodeFailure> {
    let launch =
      (self.0.hooks.launch)().map_err(|_unavailable| ClaudeCodeFailure::Unavailable)?;
    let _changing = self.0.changing.lock().await;
    let mut command = cli::command(&launch, &cli::LOGIN_ARGS);
    // Kept open for the whole attempt: the CLI may wait on it.
    command.stdin(std::process::Stdio::piped());
    let mut child = cli::spawn(&mut command).await.map_err(|error| {
      tracing::warn!(kind = ?error.kind(), "managed Claude Code sign-in did not start");
      ClaudeCodeFailure::Unavailable
    })?;
    let _stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let found = |url: String| self.record_sign_in_page(id, url);
    let ended = tokio::time::timeout(self.0.config.sign_in_timeout, async {
      let ((), (), status) = tokio::join!(
        cli::watch_for_sign_in_page(stdout, found),
        cli::watch_for_sign_in_page(stderr, found),
        child.wait(),
      );
      status
    })
    .await;
    // Dropping the child on any early return kills the CLI.
    let status = ended
      .map_err(|_elapsed| ClaudeCodeFailure::TimedOut)?
      .map_err(|_wait| ClaudeCodeFailure::Unavailable)?;
    if !status.success() {
      tracing::info!(status = ?status.code(), "Claude Code sign-in ended without signing in");
      return Err(ClaudeCodeFailure::NotCompleted);
    }
    match self.read_sign_in(&launch).await {
      Some(SignIn::Subscription { .. }) => Ok(()),
      Some(SignIn::None | SignIn::ApiKey) => Err(ClaudeCodeFailure::NotCompleted),
      None => Err(ClaudeCodeFailure::Unavailable),
    }
  }

  fn record_sign_in_page(&self, id: u64, url: String) {
    let recorded =
      self
        .0
        .attempt
        .lock()
        .is_ok_and(|mut attempt| match attempt.as_mut() {
          Some(current) if current.id == id && current.sign_in_page.is_none() => {
            current.sign_in_page = Some(url);
            true
          }
          _ => false,
        });
    if recorded {
      (self.0.hooks.changed)();
    }
  }

  /// Opens the sign-in page again, for when the browser did not open or its
  /// tab was closed.
  pub(crate) fn open_sign_in_page(&self) -> Result<(), OpenPageError> {
    let page = self
      .0
      .attempt
      .lock()
      .ok()
      .and_then(|attempt| attempt.as_ref()?.sign_in_page.clone())
      .ok_or(OpenPageError::NoPage)?;
    if (self.0.hooks.open_browser)(&page) {
      Ok(())
    } else {
      Err(OpenPageError::BrowserUnavailable)
    }
  }

  /// Signs the CLI out of its Stella-owned configuration directory. The
  /// user's own Claude Code sign-in is a different directory and stays.
  pub(crate) async fn sign_out(&self) -> Result<(), SignOutError> {
    if self.signing_in().is_some() {
      return Err(SignOutError::SigningIn);
    }
    let launch = (self.0.hooks.launch)().map_err(|error| match error {
      LaunchError::NotInstalled => SignOutError::NotInstalled,
      LaunchError::Unavailable => SignOutError::Failed,
    })?;
    let _changing = self.0.changing.lock().await;
    let command = cli::command(&launch, &cli::LOGOUT_ARGS);
    let result = cli::run(command, self.0.config.command_timeout).await;
    let signed_out = match result {
      Ok((status, _)) if status.success() => Ok(()),
      Ok((status, _)) => {
        tracing::warn!(status = ?status.code(), "Claude Code sign-out failed");
        Err(SignOutError::Failed)
      }
      Err(error) => {
        tracing::warn!(?error, "Claude Code sign-out did not run");
        Err(SignOutError::Failed)
      }
    };
    if signed_out.is_ok()
      && let Ok(mut failure) = self.0.failure.lock()
    {
      failure.take();
    }
    (self.0.hooks.changed)();
    signed_out
  }
}
