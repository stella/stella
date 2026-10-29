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
//! The channel is a Unix socket (mode 0600) in a fresh directory (mode 0700)
//! owned by this user, or a named pipe only the current user can open and no
//! remote client can reach; never a TCP listener. The broker answers only a
//! peer process descended from a Codex process the desktop started and
//! registered with [`CodexChatGptLaunch::authorize`], and only for the
//! sign-in that run was launched with. The broker endpoint and that sign-in's
//! key reach the helper through Codex's environment, never a command line.
//!
//! Ported from t3code's `CodexManagedTokenBroker`, `CodexManagedTokenProtocol`
//! and `managedChatGptToken` helper (MIT).

// The desktop runner's harness host takes the launch and its grant; until it
// lands only the tests do.
#![cfg_attr(
  not(all(test, unix)),
  allow(
    dead_code,
    reason = "the desktop runner's harness host consumes the launch"
  )
)]

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
/// Stays below macOS's 104-byte and Linux's 108-byte socket path limits.
#[cfg(unix)]
const UNIX_SOCKET_PATH_BYTES: usize = 100;

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
/// directory.
pub struct CodexManagedTokenBroker {
  endpoint: String,
  processes: Arc<AuthorizedProcesses>,
  task: tokio::task::JoinHandle<()>,
  /// Removed with the broker.
  #[cfg(unix)]
  _directory: OwnedDirectory,
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

  #[cfg(unix)]
  pub(crate) fn start<S: TokenSource>(source: Arc<S>) -> std::io::Result<Self> {
    let directory = OwnedDirectory::create()?;
    let path = directory.path.join("s");
    if path.as_os_str().len() > UNIX_SOCKET_PATH_BYTES {
      return Err(std::io::Error::other("token broker path is too long"));
    }
    let listener = tokio::net::UnixListener::bind(&path)?;
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    let endpoint = path
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

  #[cfg(windows)]
  pub(crate) fn start<S: TokenSource>(source: Arc<S>) -> std::io::Result<Self> {
    use std::os::windows::io::AsHandle;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    let endpoint = format!(r"\\.\pipe\stella-token-{}", uuid::Uuid::new_v4());
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
    let mut server = create(&endpoint, true)?;
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
  pub(crate) fn start<S: TokenSource>(_source: Arc<S>) -> std::io::Result<Self> {
    Err(std::io::Error::other(
      "no private token channel on this platform",
    ))
  }
}

/// A `0700` directory this process created, removed (only if it is still
/// the same directory) when dropped.
#[cfg(unix)]
struct OwnedDirectory {
  path: std::path::PathBuf,
  device: u64,
  inode: u64,
}

#[cfg(unix)]
impl OwnedDirectory {
  fn create() -> std::io::Result<Self> {
    let candidates = [std::env::temp_dir(), std::path::PathBuf::from("/tmp")];
    let mut last = std::io::Error::other("no private directory for the token broker");
    for parent in candidates {
      match Self::create_in(&parent) {
        Ok(directory) => return Ok(directory),
        Err(error) => last = error,
      }
    }
    Err(last)
  }

  fn create_in(parent: &Path) -> std::io::Result<Self> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    let parent = std::fs::canonicalize(parent)?;
    let name = format!(
      "stella-token-{}",
      &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let path = parent.join(name);
    std::fs::DirBuilder::new().mode(0o700).create(&path)?;
    let created = std::fs::symlink_metadata(&path)?;
    let owner = created.uid();
    let parent_metadata = std::fs::symlink_metadata(&parent)?;
    let parent_mode = parent_metadata.mode();
    // The parent must be ours and closed to others, or root's and sticky.
    let parent_trusted = parent_metadata.is_dir()
      && ((parent_metadata.uid() == owner && parent_mode & 0o022 == 0)
        || (parent_metadata.uid() == 0
          && (parent_mode & 0o022 == 0 || parent_mode & 0o1000 != 0)));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    let created = std::fs::symlink_metadata(&path)?;
    if !parent_trusted
      || !created.is_dir()
      || created.file_type().is_symlink()
      || created.mode() & 0o777 != 0o700
    {
      let _ = std::fs::remove_dir(&path);
      return Err(std::io::Error::other(
        "token broker directory is not private",
      ));
    }
    Ok(Self {
      path,
      device: created.dev(),
      inode: created.ino(),
    })
  }
}

#[cfg(unix)]
impl Drop for OwnedDirectory {
  fn drop(&mut self) {
    use std::os::unix::fs::MetadataExt;
    // Never remove a directory that was replaced, or anything but our socket.
    let Ok(current) = std::fs::symlink_metadata(&self.path) else {
      return;
    };
    if current.dev() != self.device || current.ino() != self.inode || !current.is_dir()
    {
      return;
    }
    let _ = std::fs::remove_file(self.path.join("s"));
    let _ = std::fs::remove_dir(&self.path);
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
/// plan. It starts the broker on first use and fails early when there is no
/// usable connection. The caller authorizes the Codex process once it runs.
pub(crate) async fn codex_chatgpt_launch(
  auth: &ChatGptAuth,
  broker: &tokio::sync::OnceCell<CodexManagedTokenBroker>,
) -> Result<CodexChatGptLaunch, CodexLaunchError> {
  let broker = broker
    .get_or_try_init(|| async {
      CodexManagedTokenBroker::start(Arc::new(auth.clone()))
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
  let stream = std::os::unix::net::UnixStream::connect(endpoint).ok()?;
  stream.set_read_timeout(Some(COMMAND_TIMEOUT)).ok()?;
  stream.set_write_timeout(Some(SOCKET_IDLE)).ok()?;
  Some(stream)
}

#[cfg(windows)]
fn connect(endpoint: &str) -> Option<std::fs::File> {
  use std::os::windows::fs::OpenOptionsExt;

  /// `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`: a server answering
  /// on this name can identify the helper but never act as it.
  const IDENTIFY_ONLY: u32 = 0x0010_0000 | 0x0001_0000;

  if !endpoint.starts_with(r"\\.\pipe\stella-token-") {
    return None;
  }
  std::fs::OpenOptions::new()
    .read(true)
    .write(true)
    .security_qos_flags(IDENTIFY_ONLY)
    .open(endpoint)
    .ok()
}

#[cfg(not(any(unix, windows)))]
fn connect(_endpoint: &str) -> Option<std::fs::File> {
  None
}

#[cfg(all(test, unix))]
mod tests {
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
    stream.write_all(request).unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    response
  }

  fn good_request() -> String {
    format!("{{\"version\":1,\"profileKey\":\"{KEY}\"}}\n")
  }

  /// A broker that answers this test process, as if it were a managed Codex.
  fn started() -> (CodexManagedTokenBroker, BrokerGrant) {
    let broker = CodexManagedTokenBroker::start(Arc::new(FixedSource)).unwrap();
    let grant = BrokerGrant::new(&broker.processes, std::process::id());
    (broker, grant)
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

    let (broker, _grant) = started();
    let socket = Path::new(broker.endpoint());
    assert!(socket.as_os_str().len() <= UNIX_SOCKET_PATH_BYTES);
    let socket_mode = std::fs::metadata(socket).unwrap().permissions().mode();
    assert_eq!(socket_mode & 0o777, 0o600);
    let directory = socket.parent().unwrap();
    let directory_metadata = std::fs::symlink_metadata(directory).unwrap();
    assert_eq!(directory_metadata.mode() & 0o777, 0o700);
    assert_eq!(
      directory_metadata.uid(),
      std::fs::metadata(socket).unwrap().uid()
    );

    let directory = directory.to_owned();
    drop(broker);
    assert!(!directory.exists(), "the broker removes its directory");
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn an_unrelated_same_user_process_is_refused() {
    let broker = CodexManagedTokenBroker::start(Arc::new(FixedSource)).unwrap();
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
    let (broker, _grant) = started();
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
    let (broker, _grant) = started();
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
    let broker = CodexManagedTokenBroker::start(Arc::new(FixedSource)).unwrap();
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
