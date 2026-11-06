//! Hands the managed Codex its ChatGPT access token, and nothing else does.
//!
//! Codex app-server runs with a model provider whose `auth.command` is this
//! app's own executable in token-helper mode. Whenever Codex needs a token
//! (at start, and again after a 401), it runs the helper, which asks the
//! broker over a private channel and prints the bare token on stdout. The
//! broker renews the token first when it is about to expire, so a run never
//! has to restart for a renewal, and no token is ever placed in an
//! environment variable, a command line, a file or a log.
//!
//! The channel is a Unix socket (mode 0600) in a directory (mode 0700)
//! owned by this user, or a named pipe only the current user can open and no
//! remote client can reach; never a TCP listener. The broker answers only a
//! peer process descended from a Codex process the desktop started and
//! registered with [`CodexChatGptLaunch::authorize`], and only for the
//! sign-in that run was launched with. The broker endpoint and that sign-in's
//! key reach the helper through Codex's environment, never a command line,
//! and the helper asks only a socket in a private directory of its own user.
//!
//! A Codex run the harness holder keeps through an app restart still names
//! the endpoint it was launched with, so the broker listens at the same
//! endpoint on every start (recorded in the app's data; see
//! `local_store::token_broker`). What it authorized does not carry over: a
//! restarted app authorizes a kept run's Codex process again when it resumes
//! the run, under the sign-in connected then.
//!
//! Ported from t3code's `CodexManagedTokenBroker`, `CodexManagedTokenProtocol`
//! and `managedChatGptToken` helper (MIT).

use std::{
  collections::HashMap,
  future::Future,
  io::{Read, Write},
  path::Path,
  sync::{Arc, Mutex},
  time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{
  io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
  sync::Semaphore,
};

use crate::chatgpt_auth::{AGENT_NAME, AccessError, ChatGptAuth};
#[cfg(any(unix, windows))]
use crate::local_store::token_broker;

/// The argument that starts the desktop executable as the token helper.
pub const TOKEN_HELPER_ARGUMENT: &str = "--codex-chatgpt-token";
/// Where the helper finds the broker.
pub(crate) const BROKER_ENVIRONMENT: &str = "STELLA_CODEX_TOKEN_BROKER";
/// The sign-in the run was launched with.
pub(crate) const PROFILE_ENVIRONMENT: &str = "STELLA_CODEX_TOKEN_PROFILE";
/// The provider ID Codex records in its rollouts; resuming needs it unchanged.
pub(crate) const PROVIDER_ID: &str = "openai_chatgpt_plan";
const PROTOCOL_VERSION: u8 = 1;
/// Requests are small; tokens can be large JWTs. Neither is ever truncated
/// into something that could be accepted.
const REQUEST_BYTES: usize = 1024;
const RESPONSE_BYTES: usize = 64 * 1024;
/// An idle or incomplete peer does not keep its connection.
const SOCKET_IDLE: Duration = Duration::from_secs(5);
/// A renewal (20 s) plus storage and startup headroom.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(80);
const MAX_CONNECTIONS: usize = 32;
/// How many ancestors of a peer are checked for an authorized Codex process.
const MAX_ANCESTRY: usize = 32;

/// Variables a managed Codex run must not inherit: each could send the run
/// to another provider or billing path.
pub(crate) const REMOVED_ENVIRONMENT: &[&str] = &[
  "ACCESS_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenRequest {
  version: u8,
  profile_key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenResponse {
  token: String,
}

fn is_profile_key(value: &str) -> bool {
  value.len() == 64
    && value
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Where the broker gets tokens from.
pub(crate) trait TokenSource: Send + Sync + 'static {
  /// The current token for the sign-in `profile_key` names, or nothing.
  fn token(&self, profile_key: String) -> impl Future<Output = Option<String>> + Send;
}

impl TokenSource for ChatGptAuth {
  async fn token(&self, profile_key: String) -> Option<String> {
    match self.access(Some(&profile_key)).await {
      Ok(token) => Some(token),
      Err(error) => {
        tracing::info!(?error, "managed Codex token request was refused");
        None
      }
    }
  }
}

/// The Codex processes the desktop started whose descendants may ask.
#[derive(Debug, Default)]
pub(crate) struct AuthorizedProcesses(Mutex<HashMap<u32, usize>>);

impl AuthorizedProcesses {
  fn contains(&self, pid: u32) -> bool {
    self
      .0
      .lock()
      .is_ok_and(|granted| granted.contains_key(&pid))
  }

  /// Whether `peer` is an authorized process or descends from one.
  fn admits(&self, peer: u32) -> bool {
    let mut pid = peer;
    for _ in 0..MAX_ANCESTRY {
      if self.contains(pid) {
        return true;
      }
      match parent_process_id(pid) {
        Some(parent) if parent != pid && parent != 0 => pid = parent,
        _ => return false,
      }
    }
    false
  }
}

/// Lets a Codex process and its descendants use the broker until dropped.
/// Drop it when the process exits, so a reused process ID is not trusted.
#[derive(Debug)]
pub struct BrokerGrant {
  processes: Arc<AuthorizedProcesses>,
  pid: u32,
}

impl BrokerGrant {
  fn new(processes: &Arc<AuthorizedProcesses>, pid: u32) -> Self {
    if let Ok(mut granted) = processes.0.lock() {
      *granted.entry(pid).or_default() += 1;
    }
    Self {
      processes: Arc::clone(processes),
      pid,
    }
  }
}

impl Drop for BrokerGrant {
  fn drop(&mut self) {
    if let Ok(mut granted) = self.processes.0.lock()
      && let Some(count) = granted.get_mut(&self.pid)
    {
      *count -= 1;
      if *count == 0 {
        granted.remove(&self.pid);
      }
    }
  }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn parent_process_id(pid: u32) -> Option<u32> {
  stella_desktop_macos::parent_process_id(pid)
}

#[cfg(target_os = "linux")]
fn parent_process_id(pid: u32) -> Option<u32> {
  // `pid (comm) state ppid …`; the command name can hold spaces and `)`.
  let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
  let (_, fields) = stat.rsplit_once(')')?;
  fields.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn parent_process_id(_pid: u32) -> Option<u32> {
  None
}

/// Reads one newline-terminated frame of at most `max` bytes. Anything after
/// the newline, or no newline before EOF, is an invalid frame.
async fn read_frame<R: AsyncRead + Unpin>(
  reader: &mut R,
  max: usize,
) -> Option<Vec<u8>> {
  let mut buffer = Vec::with_capacity(256);
  let mut chunk = [0_u8; 1024];
  loop {
    let read = reader.read(&mut chunk).await.ok()?;
    if read == 0 {
      return None;
    }
    if buffer.len() + read > max {
      return None;
    }
    buffer.extend_from_slice(&chunk[..read]);
    if let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
      if end != buffer.len() - 1 {
        return None;
      }
      buffer.truncate(end);
      return Some(buffer);
    }
  }
}

async fn serve_connection<S, C>(
  source: Arc<S>,
  processes: Arc<AuthorizedProcesses>,
  peer: Option<u32>,
  mut connection: C,
) where
  S: TokenSource,
  C: AsyncRead + AsyncWrite + Unpin,
{
  // Only a process the desktop's own Codex started is answered at all.
  if !peer.is_some_and(|peer| processes.admits(peer)) {
    tracing::info!("token broker refused a process outside the managed Codex runs");
    return;
  }
  // Send nothing until a complete, valid request arrived: a peer that can
  // only read learns nothing.
  let Ok(Some(frame)) =
    tokio::time::timeout(SOCKET_IDLE, read_frame(&mut connection, REQUEST_BYTES)).await
  else {
    return;
  };
  let Ok(request) = serde_json::from_slice::<TokenRequest>(&frame) else {
    return;
  };
  if request.version != PROTOCOL_VERSION || !is_profile_key(&request.profile_key) {
    return;
  }
  let Ok(Some(token)) =
    tokio::time::timeout(COMMAND_TIMEOUT, source.token(request.profile_key)).await
  else {
    return;
  };
  let Ok(mut frame) = serde_json::to_vec(&TokenResponse { token }) else {
    return;
  };
  frame.push(b'\n');
  if frame.len() > RESPONSE_BYTES {
    return;
  }
  let written = tokio::time::timeout(SOCKET_IDLE, async {
    connection.write_all(&frame).await?;
    connection.shutdown().await
  })
  .await;
  if !matches!(written, Ok(Ok(()))) {
    tracing::debug!("managed Codex token response was not delivered");
  }
}

/// The running broker. Dropping it stops the listener and removes its
/// socket; the directory stays for the next start.
pub struct CodexManagedTokenBroker {
  endpoint: String,
  processes: Arc<AuthorizedProcesses>,
  task: tokio::task::JoinHandle<()>,
  /// Its socket is removed with the broker.
  #[cfg(unix)]
  _directory: token_broker::OwnedDirectory,
}

impl Drop for CodexManagedTokenBroker {
  fn drop(&mut self) {
    self.task.abort();
  }
}

impl CodexManagedTokenBroker {
  pub(crate) fn endpoint(&self) -> &str {
    &self.endpoint
  }

  /// Starts the broker at the endpoint `record` names, where runs launched
  /// before an app restart still ask, or at a fresh one it records there.
  #[cfg(unix)]
  pub(crate) fn start<S: TokenSource>(
    source: Arc<S>,
    record: &Path,
  ) -> std::io::Result<Self> {
    let (directory, socket) = token_broker::bind_broker(record)?;
    let listener = std::os::unix::net::UnixListener::from(socket);
    listener.set_nonblocking(true)?;
    let listener = tokio::net::UnixListener::from_std(listener)?;
    let endpoint = directory
      .socket_path()
      .to_str()
      .ok_or_else(|| std::io::Error::other("token broker path is not UTF-8"))?
      .to_owned();
    let processes = Arc::new(AuthorizedProcesses::default());
    let admitted = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let task = tokio::spawn({
      let processes = Arc::clone(&processes);
      async move {
        loop {
          let Ok((stream, _)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
          };
          let Ok(permit) = Arc::clone(&admitted).try_acquire_owned() else {
            continue;
          };
          let peer = stream
            .peer_cred()
            .ok()
            .and_then(|credentials| credentials.pid())
            .and_then(|pid| u32::try_from(pid).ok());
          let source = Arc::clone(&source);
          let processes = Arc::clone(&processes);
          tokio::spawn(async move {
            serve_connection(source, processes, peer, stream).await;
            drop(permit);
          });
        }
      }
    });
    Ok(Self {
      endpoint,
      processes,
      task,
      _directory: directory,
    })
  }

  /// Starts the broker on the pipe `record` names, where runs launched
  /// before an app restart still ask, or on a fresh one it records there.
  #[cfg(windows)]
  pub(crate) fn start<S: TokenSource>(
    source: Arc<S>,
    record: &Path,
  ) -> std::io::Result<Self> {
    use std::os::windows::io::AsHandle;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    // Remote clients are refused, only the current user may open the pipe,
    // and the first instance claims the name, so no other process can have
    // created it first.
    let create = |name: &str, first: bool| -> std::io::Result<NamedPipeServer> {
      let mut options = ServerOptions::new();
      options
        .first_pipe_instance(first)
        .reject_remote_clients(true);
      stella_desktop_macos::create_owner_only_pipe(&options, name)
    };
    // A recorded name another process holds is never shared: this start
    // takes a fresh one instead.
    let reused = token_broker::recorded_pipe(record)
      .and_then(|name| create(&name, true).ok().map(|server| (name, server)));
    let (endpoint, mut server) = match reused {
      Some(reused) => reused,
      None => {
        let endpoint = token_broker::fresh_pipe();
        let server = create(&endpoint, true)?;
        token_broker::record_endpoint(record, &endpoint);
        (endpoint, server)
      }
    };
    let name = endpoint.clone();
    let processes = Arc::new(AuthorizedProcesses::default());
    let admitted = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let task = tokio::spawn({
      let processes = Arc::clone(&processes);
      async move {
        loop {
          let connected = server.connect().await;
          let next = match create(&name, false) {
            Ok(next) => next,
            Err(error) => {
              tracing::warn!(kind = ?error.kind(), "token broker pipe stopped accepting requests");
              return;
            }
          };
          let instance = std::mem::replace(&mut server, next);
          if connected.is_err() {
            continue;
          }
          let Ok(permit) = Arc::clone(&admitted).try_acquire_owned() else {
            continue;
          };
          let peer =
            stella_desktop_macos::named_pipe_client_process_id(instance.as_handle())
              .ok();
          let source = Arc::clone(&source);
          let processes = Arc::clone(&processes);
          tokio::spawn(async move {
            serve_connection(source, processes, peer, instance).await;
            drop(permit);
          });
        }
      }
    });
    Ok(Self {
      endpoint,
      processes,
      task,
    })
  }

  #[cfg(not(any(unix, windows)))]
  pub(crate) fn start<S: TokenSource>(
    _source: Arc<S>,
    _record: &Path,
  ) -> std::io::Result<Self> {
    Err(std::io::Error::other(
      "no private token channel on this platform",
    ))
  }
}

/// What a managed Codex app-server run needs to use the ChatGPT plan.
#[derive(Debug, Clone)]
pub struct CodexChatGptLaunch {
  /// Passed to `codex app-server` as `-c <override>`, in this order.
  pub config_overrides: Vec<String>,
  /// Set in the run's environment; the helper Codex starts reads them.
  pub environment: Vec<(&'static str, String)>,
  /// Removed from the environment the run inherits.
  pub removed_environment: &'static [&'static str],
  /// `initialize`'s `clientInfo.name`, matching the registration's
  /// `agent_name_hint`.
  pub client_name: &'static str,
  processes: Arc<AuthorizedProcesses>,
}

impl CodexChatGptLaunch {
  /// Lets the Codex process started with this launch, and its descendants,
  /// ask the broker for a token while the grant is held.
  pub fn authorize(&self, codex_pid: u32) -> BrokerGrant {
    BrokerGrant::new(&self.processes, codex_pid)
  }
}

fn toml_string(value: &str) -> String {
  // A JSON string literal is a valid TOML basic string.
  serde_json::to_string(value).expect("a string serializes")
}

pub(crate) fn launch_for(
  helper: &Path,
  endpoint: &str,
  profile_key: &str,
  processes: Arc<AuthorizedProcesses>,
) -> CodexChatGptLaunch {
  let provider = format!(
    "model_providers.{PROVIDER_ID}={{name=\"ChatGPT plan\",base_url={base},wire_api=\"responses\",\
     requires_openai_auth=false,supports_websockets=false,auth={{command={command},args=[{arg}],\
     timeout_ms={timeout},refresh_interval_ms=0}}}}",
    base = toml_string(crate::chatgpt_auth::RESOURCE),
    command = toml_string(&helper.to_string_lossy()),
    arg = toml_string(TOKEN_HELPER_ARGUMENT),
    timeout = COMMAND_TIMEOUT.as_millis(),
  );
  CodexChatGptLaunch {
    config_overrides: vec![format!("model_provider=\"{PROVIDER_ID}\""), provider],
    environment: vec![
      (BROKER_ENVIRONMENT, endpoint.to_owned()),
      (PROFILE_ENVIRONMENT, profile_key.to_owned()),
    ],
    removed_environment: REMOVED_ENVIRONMENT,
    client_name: AGENT_NAME,
    processes,
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexLaunchError {
  /// Sign in with ChatGPT first, or again.
  Access(AccessError),
  /// The private channel could not be prepared.
  Broker,
}

/// The launch configuration for the next Codex run on the user's ChatGPT
/// plan. It starts the broker on first use, at the endpoint `record` names,
/// and fails early when there is no usable connection. The caller authorizes
/// the Codex process once it runs, and again when a restarted app resumes
/// its run.
pub(crate) async fn codex_chatgpt_launch(
  auth: &ChatGptAuth,
  broker: &tokio::sync::OnceCell<CodexManagedTokenBroker>,
  record: &Path,
) -> Result<CodexChatGptLaunch, CodexLaunchError> {
  let broker = broker
    .get_or_try_init(|| async {
      CodexManagedTokenBroker::start(Arc::new(auth.clone()), record)
    })
    .await
    .map_err(|error| {
      tracing::warn!(kind = ?error.kind(), "token broker did not start");
      CodexLaunchError::Broker
    })?;
  auth.access(None).await.map_err(CodexLaunchError::Access)?;
  let profile_key = auth.profile_key().await.map_err(CodexLaunchError::Access)?;
  let helper = std::env::current_exe().map_err(|_unknown| CodexLaunchError::Broker)?;
  Ok(launch_for(
    &helper,
    broker.endpoint(),
    &profile_key,
    Arc::clone(&broker.processes),
  ))
}

/// Token-helper mode: when `args` start the helper, asks the broker named in
/// the environment and returns the exit code. Codex reads a bare token from
/// stdout.
pub fn run_token_helper(args: &[std::ffi::OsString]) -> Option<i32> {
  if args.get(1).and_then(|arg| arg.to_str()) != Some(TOKEN_HELPER_ARGUMENT) {
    return None;
  }
  if args.len() != 2 {
    return Some(fail_helper());
  }
  match helper_token(|name| std::env::var(name).ok()) {
    Some(token) => {
      let mut stdout = std::io::stdout().lock();
      if stdout
        .write_all(token.as_bytes())
        .and_then(|()| stdout.flush())
        .is_ok()
      {
        Some(0)
      } else {
        Some(1)
      }
    }
    None => Some(fail_helper()),
  }
}

fn helper_token(environment: impl Fn(&str) -> Option<String>) -> Option<String> {
  request_token(
    &environment(BROKER_ENVIRONMENT)?,
    &environment(PROFILE_ENVIRONMENT)?,
  )
}

fn fail_helper() -> i32 {
  let _ = std::io::stderr()
    .write_all(b"Could not use the ChatGPT connection. Reconnect ChatGPT in Stella.\n");
  1
}

fn request_token(endpoint: &str, profile_key: &str) -> Option<String> {
  if !is_profile_key(profile_key) {
    return None;
  }
  let mut request = serde_json::to_vec(&TokenRequest {
    version: PROTOCOL_VERSION,
    profile_key: profile_key.to_owned(),
  })
  .ok()?;
  request.push(b'\n');
  let mut connection = connect(endpoint)?;
  connection.write_all(&request).ok()?;
  let mut response = Vec::new();
  connection
    .take((RESPONSE_BYTES + 1) as u64)
    .read_to_end(&mut response)
    .ok()?;
  if response.len() > RESPONSE_BYTES || response.last() != Some(&b'\n') {
    return None;
  }
  response.pop();
  serde_json::from_slice::<TokenResponse>(&response)
    .ok()
    .map(|response| response.token)
    .filter(|token| !token.is_empty())
}

#[cfg(unix)]
fn connect(endpoint: &str) -> Option<std::os::unix::net::UnixStream> {
  // Never a socket another user could have put at a path the run names.
  if !token_broker::is_private_socket(Path::new(endpoint)) {
    return None;
  }
  let stream = std::os::unix::net::UnixStream::connect(endpoint).ok()?;
  stream.set_read_timeout(Some(COMMAND_TIMEOUT)).ok()?;
  stream.set_write_timeout(Some(SOCKET_IDLE)).ok()?;
  Some(stream)
}

#[cfg(windows)]
fn connect(endpoint: &str) -> Option<std::fs::File> {
  token_broker::connect(endpoint)
}

#[cfg(not(any(unix, windows)))]
fn connect(_endpoint: &str) -> Option<std::fs::File> {
  None
}

#[cfg(all(test, unix))]
#[allow(
  clippy::disallowed_methods,
  reason = "tests construct local file fixtures"
)]
mod tests {
  use std::{cell::RefCell, path::PathBuf};

  use super::*;

  const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  struct FixedSource;

  impl TokenSource for FixedSource {
    async fn token(&self, profile_key: String) -> Option<String> {
      (profile_key == KEY).then(|| "access-fixture".to_owned())
    }
  }

  fn exchange(endpoint: &str, request: &[u8]) -> Vec<u8> {
    let mut stream = std::os::unix::net::UnixStream::connect(endpoint).unwrap();
    stream
      .set_read_timeout(Some(Duration::from_secs(10)))
      .unwrap();
    // The broker closes a refused peer at once, so these can lose that race;
    // only the response says what the broker decided.
    let _ = stream.write_all(request);
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    response
  }

  fn good_request() -> String {
    format!("{{\"version\":1,\"profileKey\":\"{KEY}\"}}\n")
  }

  /// An app data folder of its own, where brokers record their endpoint as
  /// app starts do. Removes it and the broker directories made for it, which
  /// outlive their brokers.
  struct Place {
    root: PathBuf,
    directories: RefCell<Vec<PathBuf>>,
  }

  impl Place {
    fn new() -> Self {
      // Short, so a socket made in it fits a socket path.
      let root = std::env::temp_dir().join(format!(
        "sbt-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
      ));
      crate::local_store::create_private_dir(&root).unwrap();
      Self {
        root,
        directories: RefCell::default(),
      }
    }

    fn record(&self) -> PathBuf {
      self.root.join("codex-token-broker")
    }

    /// Records `endpoint` as an earlier start would have.
    fn recorded(&self, endpoint: &Path) {
      crate::local_store::write_private_atomic(
        &self.record(),
        endpoint.as_os_str().as_encoded_bytes(),
      )
      .unwrap();
    }

    /// Removed at the end, with the place.
    fn made(&self, path: &Path) {
      self.directories.borrow_mut().push(path.to_owned());
    }

    /// One app start's broker.
    fn start(&self) -> CodexManagedTokenBroker {
      let broker =
        CodexManagedTokenBroker::start(Arc::new(FixedSource), &self.record()).unwrap();
      self.made(Path::new(broker.endpoint()).parent().unwrap());
      broker
    }
  }

  impl Drop for Place {
    fn drop(&mut self) {
      for directory in self.directories.get_mut().drain(..) {
        let _ = std::fs::remove_dir_all(directory);
      }
      let _ = std::fs::remove_dir_all(&self.root);
    }
  }

  /// A broker that answers this test process, as if it were a managed Codex.
  fn started(place: &Place) -> (CodexManagedTokenBroker, BrokerGrant) {
    let broker = place.start();
    let grant = BrokerGrant::new(&broker.processes, std::process::id());
    (broker, grant)
  }

  /// The token helper as a run launched with `launch` starts it, from that
  /// run's environment.
  async fn helper_of(launch: &CodexChatGptLaunch) -> Option<String> {
    let environment = launch.environment.clone();
    tokio::task::spawn_blocking(move || {
      helper_token(|name: &str| {
        environment
          .iter()
          .find(|(variable, _)| *variable == name)
          .map(|(_, value)| value.clone())
      })
    })
    .await
    .unwrap()
  }

  fn directory_with_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
  }

  /// A same-user process that is not part of any managed Codex run.
  fn unrelated_process() -> std::process::Child {
    std::process::Command::new("/bin/sleep")
      .arg("30")
      .spawn()
      .unwrap()
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn the_socket_is_private_to_this_user() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let place = Place::new();
    let (broker, _grant) = started(&place);
    let socket = Path::new(broker.endpoint()).to_owned();
    assert!(socket.as_os_str().len() <= token_broker::SOCKET_PATH_BYTES);
    let socket_mode = std::fs::metadata(&socket).unwrap().permissions().mode();
    assert_eq!(socket_mode & 0o777, 0o600);
    let directory = socket.parent().unwrap().to_owned();
    let directory_metadata = std::fs::symlink_metadata(&directory).unwrap();
    assert_eq!(directory_metadata.mode() & 0o777, 0o700);
    assert_eq!(
      directory_metadata.uid(),
      std::fs::metadata(&socket).unwrap().uid()
    );
    assert_eq!(
      token_broker::recorded_endpoint(&place.record()).as_deref(),
      Some(broker.endpoint()),
      "the next start finds the endpoint"
    );

    drop(broker);
    assert!(!socket.exists(), "the broker removes its socket");
    assert!(directory.is_dir(), "the next start listens here again");
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn a_run_launched_before_a_restart_gets_tokens_once_the_new_app_authorizes_it()
  {
    let place = Place::new();
    let first = place.start();
    let launch = launch_for(
      Path::new("/bin/true"),
      first.endpoint(),
      KEY,
      Arc::clone(&first.processes),
    );
    let grant = launch.authorize(std::process::id());
    assert_eq!(helper_of(&launch).await.as_deref(), Some("access-fixture"));

    // The app ends; the run goes on in the holder with this environment. An
    // app that exits leaves its socket behind, with nothing listening.
    let endpoint = PathBuf::from(first.endpoint());
    drop(grant);
    drop(first);
    drop(std::os::unix::net::UnixListener::bind(&endpoint).unwrap());

    let second = place.start();
    assert_eq!(Path::new(second.endpoint()), endpoint);
    // Nothing the first app authorized carries over.
    assert_eq!(helper_of(&launch).await, None);
    // Resuming the run authorizes its process with the new app's broker.
    let resumed = launch_for(
      Path::new("/bin/true"),
      second.endpoint(),
      KEY,
      Arc::clone(&second.processes),
    );
    assert_eq!(resumed.environment, launch.environment);
    let regrant = resumed.authorize(std::process::id());
    assert_eq!(helper_of(&launch).await.as_deref(), Some("access-fixture"));
    drop(regrant);
    assert_eq!(helper_of(&launch).await, None);
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn a_live_broker_keeps_its_endpoint_and_another_start_listens_elsewhere() {
    let place = Place::new();
    let (first, _grant) = started(&place);
    let second = place.start();
    assert_ne!(first.endpoint(), second.endpoint());
    assert_eq!(
      token_broker::recorded_endpoint(&place.record()).as_deref(),
      Some(second.endpoint())
    );
    let endpoint = first.endpoint().to_owned();
    let served = tokio::task::spawn_blocking(move || {
      exchange(&endpoint, good_request().as_bytes())
    })
    .await
    .unwrap();
    assert_eq!(served, b"{\"token\":\"access-fixture\"}\n");
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn a_recorded_endpoint_that_is_not_a_private_broker_directory_is_not_used() {
    let place = Place::new();
    let temporary = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    let name = || {
      format!(
        "stella-token-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
      )
    };
    // Open to others.
    let open = temporary.join(name());
    directory_with_mode(&open, 0o755);
    place.made(&open);
    // A link to a private directory.
    let target = place.root.join("target");
    directory_with_mode(&target, 0o700);
    let link = temporary.join(name());
    std::os::unix::fs::symlink(&target, &link).unwrap();
    place.made(&link);
    // Private, but not in a temporary folder.
    let elsewhere = place.root.join(name());
    directory_with_mode(&elsewhere, 0o700);
    // Not a broker directory's name.
    let unnamed =
      temporary.join(format!("stella-other-{}", uuid::Uuid::new_v4().simple()));
    directory_with_mode(&unnamed, 0o700);
    place.made(&unnamed);
    let refused = [
      open.join("s"),
      link.join("s"),
      elsewhere.join("s"),
      unnamed.join("s"),
      PathBuf::from(name()).join("s"),
    ];
    for recorded in &refused {
      place.recorded(recorded);
      let broker = place.start();
      assert_ne!(Path::new(broker.endpoint()), recorded.as_path());
      assert_eq!(
        token_broker::recorded_endpoint(&place.record()).as_deref(),
        Some(broker.endpoint()),
        "a fresh endpoint replaces the record"
      );
    }
    for directory in [&open, &target, &elsewhere, &unnamed] {
      assert_eq!(std::fs::read_dir(directory).unwrap().count(), 0);
    }
  }

  #[test]
  fn the_helper_asks_only_a_socket_in_a_private_directory_of_its_user() {
    let place = Place::new();
    let open = place.root.join("open");
    directory_with_mode(&open, 0o755);
    let endpoint = open.join("s");
    let listener = std::os::unix::net::UnixListener::bind(&endpoint).unwrap();
    listener.set_nonblocking(true).unwrap();
    // Everything else about the request is right: only the directory others
    // can reach keeps the helper from connecting.
    let named = endpoint.to_string_lossy().into_owned();
    let environment = |name: &str| match name {
      BROKER_ENVIRONMENT => Some(named.clone()),
      PROFILE_ENVIRONMENT => Some(KEY.to_owned()),
      _ => None,
    };
    assert_eq!(helper_token(environment), None);
    assert!(
      matches!(
        listener.accept(),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
      ),
      "the helper did not connect"
    );
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn an_unrelated_same_user_process_is_refused() {
    let place = Place::new();
    let broker = place.start();
    let mut codex = unrelated_process();
    // Only the "Codex" process tree is authorized; this test process is not
    // in it, although it runs as the same user and holds the right key.
    let codex_grant = BrokerGrant::new(&broker.processes, codex.id());
    let endpoint = broker.endpoint().to_owned();
    let processes = Arc::clone(&broker.processes);
    tokio::task::spawn_blocking(move || {
      assert!(exchange(&endpoint, good_request().as_bytes()).is_empty());
      let own = BrokerGrant::new(&processes, std::process::id());
      assert_eq!(
        exchange(&endpoint, good_request().as_bytes()),
        b"{\"token\":\"access-fixture\"}\n"
      );
      // A grant ends with its run.
      drop(own);
      assert!(exchange(&endpoint, good_request().as_bytes()).is_empty());
    })
    .await
    .unwrap();
    drop(codex_grant);
    codex.kill().unwrap();
    codex.wait().unwrap();
  }

  #[test]
  fn descendants_of_an_authorized_process_are_admitted() {
    let mut child = unrelated_process();
    let parent = AuthorizedProcesses::default();
    let parent_grant = BrokerGrant::new(&Arc::new(parent), std::process::id());
    assert!(parent_grant.processes.admits(child.id()));
    assert!(parent_grant.processes.admits(std::process::id()));
    let only_child = Arc::new(AuthorizedProcesses::default());
    let child_grant = BrokerGrant::new(&only_child, child.id());
    assert!(!child_grant.processes.admits(std::process::id()));
    child.kill().unwrap();
    child.wait().unwrap();
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn only_a_complete_request_for_the_current_sign_in_gets_a_token() {
    let place = Place::new();
    let (broker, _grant) = started(&place);
    let endpoint = broker.endpoint().to_owned();
    tokio::task::spawn_blocking(move || {
      assert_eq!(
        exchange(&endpoint, good_request().as_bytes()),
        b"{\"token\":\"access-fixture\"}\n"
      );
      let other_key = "f".repeat(64);
      for refused in [
        format!("{{\"version\":1,\"profileKey\":\"{other_key}\"}}\n"),
        format!("{{\"version\":2,\"profileKey\":\"{KEY}\"}}\n"),
        format!("{{\"version\":1,\"profileKey\":\"{KEY}\",\"extra\":1}}\n"),
        format!(
          "{{\"version\":1,\"profileKey\":\"{}\"}}\n",
          KEY.to_uppercase()
        ),
        format!("{{\"version\":1,\"profileKey\":\"{KEY}\"}}\nmore"),
        format!("{{\"version\":1,\"profileKey\":\"{KEY}\"}}"),
        format!("{}\n", "x".repeat(REQUEST_BYTES)),
        "not json\n".to_owned(),
      ] {
        assert!(
          exchange(&endpoint, refused.as_bytes()).is_empty(),
          "{refused}"
        );
      }
      // The helper speaks the same protocol, from its environment.
      let environment = |broker: String, key: String| {
        move |name: &str| match name {
          BROKER_ENVIRONMENT => Some(broker.clone()),
          PROFILE_ENVIRONMENT => Some(key.clone()),
          _ => None,
        }
      };
      assert_eq!(
        helper_token(environment(endpoint.clone(), KEY.into())).as_deref(),
        Some("access-fixture")
      );
      assert_eq!(helper_token(environment(endpoint.clone(), other_key)), None);
      assert_eq!(helper_token(environment(endpoint, "short".into())), None);
      assert_eq!(helper_token(|_| None), None);
    })
    .await
    .unwrap();
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn a_silent_peer_is_disconnected() {
    let place = Place::new();
    let (broker, _grant) = started(&place);
    let endpoint = broker.endpoint().to_owned();
    tokio::task::spawn_blocking(move || {
      let mut stream = std::os::unix::net::UnixStream::connect(&endpoint).unwrap();
      // The broker closes the connection before this read would time out.
      stream.set_read_timeout(Some(SOCKET_IDLE * 3)).unwrap();
      let mut response = Vec::new();
      stream.read_to_end(&mut response).unwrap();
      assert!(response.is_empty());
    })
    .await
    .unwrap();
  }

  #[test]
  fn the_helper_ignores_ordinary_launches() {
    assert_eq!(run_token_helper(&["stella-desktop".into()]), None);
    assert_eq!(
      run_token_helper(&["stella-desktop".into(), "--background".into()]),
      None
    );
    assert_eq!(
      run_token_helper(&[
        "stella-desktop".into(),
        TOKEN_HELPER_ARGUMENT.into(),
        "extra".into()
      ]),
      Some(1)
    );
  }

  #[test]
  fn the_launch_keeps_the_broker_and_sign_in_off_the_command_line() {
    let launch = launch_for(
      Path::new("/Applications/Stella.app/Contents/MacOS/stella-desktop"),
      "/tmp/stella-token-abc/s",
      KEY,
      Arc::default(),
    );
    assert_eq!(
      launch.config_overrides[0],
      "model_provider=\"openai_chatgpt_plan\""
    );
    assert_eq!(
      launch.config_overrides[1],
      "model_providers.openai_chatgpt_plan={name=\"ChatGPT plan\",\
       base_url=\"https://api.openai.com/v1\",wire_api=\"responses\",\
       requires_openai_auth=false,supports_websockets=false,\
       auth={command=\"/Applications/Stella.app/Contents/MacOS/stella-desktop\",\
       args=[\"--codex-chatgpt-token\"],timeout_ms=80000,refresh_interval_ms=0}}"
    );
    assert_eq!(
      launch.environment,
      [
        (BROKER_ENVIRONMENT, "/tmp/stella-token-abc/s".to_owned()),
        (PROFILE_ENVIRONMENT, KEY.to_owned()),
      ]
    );
    for argument in &launch.config_overrides {
      assert!(!argument.contains(KEY));
      assert!(!argument.contains("stella-token-abc"));
    }
    assert_eq!(launch.client_name, "Stella");
    assert!(launch.removed_environment.contains(&"OPENAI_API_KEY"));
    assert!(launch.removed_environment.contains(&"ACCESS_TOKEN"));
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn a_launch_authorizes_its_codex_process_until_the_grant_ends() {
    let place = Place::new();
    let broker = place.start();
    let launch = launch_for(
      Path::new("/bin/true"),
      broker.endpoint(),
      KEY,
      Arc::clone(&broker.processes),
    );
    let endpoint = broker.endpoint().to_owned();
    let grant = launch.authorize(std::process::id());
    let served = tokio::task::spawn_blocking({
      let endpoint = endpoint.clone();
      move || exchange(&endpoint, good_request().as_bytes())
    })
    .await
    .unwrap();
    assert_eq!(served, b"{\"token\":\"access-fixture\"}\n");
    drop(grant);
    let refused = tokio::task::spawn_blocking(move || {
      exchange(&endpoint, good_request().as_bytes())
    })
    .await
    .unwrap();
    assert!(refused.is_empty());
  }

  #[test]
  fn windows_paths_stay_valid_toml() {
    let launch = launch_for(
      Path::new(r"C:\Program Files\Stella\stella-desktop.exe"),
      r"\\.\pipe\stella-token-1",
      KEY,
      Arc::default(),
    );
    assert!(
      launch.config_overrides[1]
        .contains(r#"command="C:\\Program Files\\Stella\\stella-desktop.exe""#)
    );
  }
}
