//! The managed Claude Code CLI's own `auth` commands, run with nothing but
//! its Stella-owned configuration directory.
//!
//! The environment is the desktop's own, minus every variable that would
//! move the CLI onto an API key, a third-party provider or another endpoint,
//! or mark it as part of a parent Claude Code session; the same rules the
//! agent engine's Claude Code adapter applies to a turn. `HOME` stays, since
//! the CLI keeps its sign-in in the system keychain on macOS and finds that
//! keychain through it.
//!
//! What the CLI prints is read only to find its sign-in page and its status
//! report; neither is logged, and credentials never pass through here.

use std::{
  ffi::{OsStr, OsString},
  future::Future,
  path::PathBuf,
  process::{ExitStatus, Stdio},
  time::Duration,
};

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::harness_release::ManagedHarness;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Variables dropped from the CLI's environment, matched case-insensitively
/// because Windows treats variable names that way.
const STRIPPED_ENV_PREFIXES: [&str; 2] = ["ANTHROPIC_", "CLAUDE_"];
const STRIPPED_ENV_NAMES: [&str; 2] = ["CLAUDECODE", "AWS_BEARER_TOKEN_BEDROCK"];

/// Set for every CLI process the desktop starts.
const FIXED_ENV: [(&str, &str); 3] = [
  // The managed release is replaced by the desktop, never by the CLI.
  ("DISABLE_AUTOUPDATER", "1"),
  ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
  ("ENABLE_CLAUDEAI_MCP_SERVERS", "false"),
];

pub(super) const STATUS_ARGS: [&str; 3] = ["auth", "status", "--json"];
pub(super) const LOGIN_ARGS: [&str; 2] = ["auth", "login"];
pub(super) const LOGOUT_ARGS: [&str; 2] = ["auth", "logout"];

/// The most output kept from one command; the rest is drained unread.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// Hosts a sign-in page may be on. The CLI is the pinned release, but a page
/// on any other host is still never opened.
const SIGN_IN_HOSTS: [&str; 3] = ["claude.ai", "claude.com", "anthropic.com"];

/// One run of the managed CLI: its executable, its Stella-owned
/// configuration directory and the environment to start from.
pub(crate) struct ClaudeCodeLaunch {
  pub executable: PathBuf,
  pub config_dir: PathBuf,
  /// The desktop's environment; credential and endpoint overrides are
  /// dropped before the CLI sees it.
  pub environment: Vec<(OsString, OsString)>,
  /// Keeps the installed release in place while the CLI runs.
  pub _hold: Box<dyn Send + Sync>,
}

fn is_stripped(name: &OsStr) -> bool {
  let name = name.to_string_lossy().to_ascii_uppercase();
  STRIPPED_ENV_NAMES.contains(&name.as_str())
    || STRIPPED_ENV_PREFIXES
      .iter()
      .any(|prefix| name.starts_with(prefix))
}

pub(super) fn command(
  launch: &ClaudeCodeLaunch,
  args: &[&str],
) -> tokio::process::Command {
  let mut command = tokio::process::Command::new(&launch.executable);
  command
    .args(args)
    .env_clear()
    .envs(
      launch
        .environment
        .iter()
        .filter(|(name, _)| !is_stripped(name))
        .map(|(name, value)| (name, value)),
    )
    .envs(FIXED_ENV)
    .env(ManagedHarness::ClaudeCode.config_env(), &launch.config_dir)
    .current_dir(&launch.config_dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
  #[cfg(windows)]
  command.creation_flags(CREATE_NO_WINDOW);
  command
}

/// A child forked elsewhere in the process can briefly hold a just-written
/// executable open, which fails the exec with "text file busy"; that is
/// retried a few times.
pub(super) async fn spawn(
  command: &mut tokio::process::Command,
) -> std::io::Result<tokio::process::Child> {
  let mut attempts = 0;
  loop {
    match command.spawn() {
      Err(error)
        if error.kind() == std::io::ErrorKind::ExecutableFileBusy && attempts < 5 =>
      {
        attempts += 1;
        tokio::time::sleep(Duration::from_millis(50)).await;
      }
      result => return result,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RunError {
  /// The CLI did not start.
  Spawn,
  TimedOut,
  /// The caller stopped waiting for it.
  Stopped,
  /// It printed more than a status report can be.
  Oversize,
}

/// Kills the CLI and waits until it is gone. Dropping the child would kill
/// it too, but without waiting for it to exit.
pub(super) async fn reap(child: &mut tokio::process::Child) {
  if let Err(error) = child.kill().await {
    tracing::warn!(kind = ?error.kind(), "managed Claude Code was not stopped");
  }
}

/// Runs a short command to its end: its exit status and what it printed on
/// standard output. Standard error is drained unread. A command that times
/// out or is stopped through `stop` is killed and reaped before this
/// returns, so it never outlives the caller's wait.
pub(super) async fn run(
  mut command: tokio::process::Command,
  timeout: Duration,
  stop: impl Future<Output = ()>,
) -> Result<(ExitStatus, Vec<u8>), RunError> {
  let mut child = spawn(&mut command).await.map_err(|error| {
    tracing::warn!(kind = ?error.kind(), "managed Claude Code did not start");
    RunError::Spawn
  })?;
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  let ended = {
    let finished = tokio::time::timeout(timeout, async {
      let (output, (), status) =
        tokio::join!(read_capped(stdout), drain(stderr), child.wait());
      let status = status.map_err(|_wait| RunError::Spawn)?;
      Ok((status, output?))
    });
    tokio::select! {
      finished = finished => finished.map_err(|_elapsed| RunError::TimedOut),
      () = stop => Err(RunError::Stopped),
    }
  };
  match ended {
    Ok(finished) => finished,
    Err(error) => {
      reap(&mut child).await;
      Err(error)
    }
  }
}

async fn read_capped(
  stream: Option<impl AsyncRead + Unpin>,
) -> Result<Vec<u8>, RunError> {
  let mut output = Vec::new();
  let Some(stream) = stream else {
    return Ok(output);
  };
  let mut stream = stream.take(MAX_OUTPUT_BYTES as u64 + 1);
  stream
    .read_to_end(&mut output)
    .await
    .map_err(|_read| RunError::Spawn)?;
  if output.len() > MAX_OUTPUT_BYTES {
    return Err(RunError::Oversize);
  }
  let mut rest = stream.into_inner();
  let _ = tokio::io::copy(&mut rest, &mut tokio::io::sink()).await;
  Ok(output)
}

pub(super) async fn drain(stream: Option<impl AsyncRead + Unpin>) {
  if let Some(mut stream) = stream {
    let _ = tokio::io::copy(&mut stream, &mut tokio::io::sink()).await;
  }
}

/// Reads a stream to its end, calling `found` once with the first sign-in
/// page it names. Only the last [`MAX_OUTPUT_BYTES`] are kept, so a page
/// printed after a long preamble is still found, and the stream is read to
/// its end so the CLI never blocks on a full pipe.
pub(super) async fn watch_for_sign_in_page(
  stream: Option<impl AsyncRead + Unpin>,
  found: impl Fn(String),
) {
  let Some(mut stream) = stream else {
    return;
  };
  let mut seen = Vec::new();
  let mut chunk = [0_u8; 4096];
  let mut reported = false;
  loop {
    let read = match stream.read(&mut chunk).await {
      Ok(0) | Err(_) => break,
      Ok(read) => read,
    };
    if reported {
      continue;
    }
    seen.extend_from_slice(&chunk[..read]);
    if let Some(excess) = seen.len().checked_sub(MAX_OUTPUT_BYTES) {
      seen.drain(..excess);
    }
    let text = String::from_utf8_lossy(&seen);
    // Only a link followed by whitespace is complete; the rest may still
    // be arriving.
    let complete = text
      .rfind(char::is_whitespace)
      .map_or("", |end| &text[..end]);
    if let Some(url) = sign_in_page(complete) {
      reported = true;
      found(url);
    }
  }
  if !reported && let Some(url) = sign_in_page(&String::from_utf8_lossy(&seen)) {
    found(url);
  }
}

/// The first `https` link in `text` on one of [`SIGN_IN_HOSTS`].
pub(super) fn sign_in_page(text: &str) -> Option<String> {
  text.match_indices("https://").find_map(|(start, _)| {
    let candidate: String = text[start..]
      .chars()
      .take_while(char::is_ascii_graphic)
      .collect();
    let candidate = candidate.trim_end_matches(['.', ',', ')', ']', '"', '\'', '>']);
    let url = reqwest::Url::parse(candidate).ok()?;
    let host = url.host_str()?;
    let allowed = url.scheme() == "https"
      && url.username().is_empty()
      && url.password().is_none()
      && SIGN_IN_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")));
    allowed.then(|| url.to_string())
  })
}

/// `claude auth status --json`, as far as the desktop reads it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusReport {
  logged_in: bool,
  #[serde(default)]
  auth_method: Option<String>,
  #[serde(default)]
  api_key_source: Option<String>,
  #[serde(default)]
  email: Option<String>,
  #[serde(default)]
  subscription_type: Option<String>,
}

/// The sign-in a configuration directory holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SignIn {
  None,
  /// A Claude subscription, the only sign-in a turn runs on.
  Subscription {
    email: Option<String>,
    plan: Option<String>,
  },
  /// An API key, which would bill the API instead of the subscription; the
  /// agent engine treats it as signed out.
  ApiKey,
}

/// Reads the status report. The CLI exits non-zero when signed out, so the
/// report is read whatever the exit status; only an unreadable one fails.
pub(super) fn parse_status(stdout: &[u8]) -> Option<SignIn> {
  let report: StatusReport = match serde_json::from_slice(stdout) {
    Ok(report) => report,
    Err(error) => {
      crate::logging::log_json_error(
        &error,
        "Claude Code sign-in status was unreadable",
      );
      return None;
    }
  };
  if !report.logged_in {
    return Some(SignIn::None);
  }
  let api_key = report
    .api_key_source
    .as_deref()
    .is_some_and(|source| !source.is_empty() && source != "none")
    || report.auth_method.as_deref() == Some("api_key");
  if api_key {
    return Some(SignIn::ApiKey);
  }
  Some(SignIn::Subscription {
    email: non_empty(report.email),
    plan: non_empty(report.subscription_type),
  })
}

fn non_empty(value: Option<String>) -> Option<String> {
  value
    .map(|value| value.trim().to_owned())
    .filter(|value| !value.is_empty())
}
