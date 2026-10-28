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
//! owned by this user, or a local-only named pipe on Windows; never a TCP
//! listener. A request names the sign-in it was launched for, so a run
//! started before a different sign-in receives nothing.
//!
//! Ported from t3code's `CodexManagedTokenBroker`, `CodexManagedTokenProtocol`
//! and `managedChatGptToken` helper (MIT).

use std::{
  future::Future,
  io::{Read, Write},
  path::Path,
  sync::Arc,
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

async fn serve_connection<S, C>(source: Arc<S>, mut connection: C)
where
  S: TokenSource,
  C: AsyncRead + AsyncWrite + Unpin,
{
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
    let admitted = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let task = tokio::spawn(async move {
      loop {
        let Ok((stream, _)) = listener.accept().await else {
          tokio::time::sleep(Duration::from_millis(50)).await;
          continue;
        };
        let Ok(permit) = Arc::clone(&admitted).try_acquire_owned() else {
          continue;
        };
        let source = Arc::clone(&source);
        tokio::spawn(async move {
          serve_connection(source, stream).await;
          drop(permit);
        });
      }
    });
    Ok(Self {
      endpoint,
      task,
      _directory: directory,
    })
  }

  #[cfg(windows)]
  pub(crate) fn start<S: TokenSource>(source: Arc<S>) -> std::io::Result<Self> {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    let endpoint = format!(r"\\.\pipe\stella-token-{}", uuid::Uuid::new_v4());
    // Remote clients are refused; the first instance claims the name, so
    // no other process can have created it first.
    let create = |name: &str, first: bool| -> std::io::Result<NamedPipeServer> {
      ServerOptions::new()
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .create(name)
    };
    let mut server = create(&endpoint, true)?;
    let name = endpoint.clone();
    let admitted = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let task = tokio::spawn(async move {
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
        let source = Arc::clone(&source);
        tokio::spawn(async move {
          serve_connection(source, instance).await;
          drop(permit);
        });
      }
    });
    Ok(Self { endpoint, task })
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexChatGptLaunch {
  /// Passed to `codex app-server` as `-c <override>`, in this order.
  pub config_overrides: Vec<String>,
  /// Removed from the environment the run inherits.
  pub removed_environment: &'static [&'static str],
  /// `initialize`'s `clientInfo.name`, matching the registration's
  /// `agent_name_hint`.
  pub client_name: &'static str,
}

fn toml_string(value: &str) -> String {
  // A JSON string literal is a valid TOML basic string.
  serde_json::to_string(value).expect("a string serializes")
}

pub(crate) fn launch_for(
  helper: &Path,
  endpoint: &str,
  profile_key: &str,
) -> CodexChatGptLaunch {
  let args = [TOKEN_HELPER_ARGUMENT, endpoint, profile_key]
    .map(toml_string)
    .join(",");
  let provider = format!(
    "model_providers.{PROVIDER_ID}={{name=\"ChatGPT plan\",base_url={base},wire_api=\"responses\",\
     requires_openai_auth=false,supports_websockets=false,auth={{command={command},args=[{args}],\
     timeout_ms={timeout},refresh_interval_ms=0}}}}",
    base = toml_string(crate::chatgpt_auth::RESOURCE),
    command = toml_string(&helper.to_string_lossy()),
    timeout = COMMAND_TIMEOUT.as_millis(),
  );
  CodexChatGptLaunch {
    config_overrides: vec![format!("model_provider=\"{PROVIDER_ID}\""), provider],
    removed_environment: REMOVED_ENVIRONMENT,
    client_name: AGENT_NAME,
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
/// usable connection.
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
  Ok(launch_for(&helper, broker.endpoint(), &profile_key))
}

/// Token-helper mode: when `args` start the helper, asks the broker and
/// returns the exit code. Codex reads a bare token from stdout.
pub fn run_token_helper(args: &[std::ffi::OsString]) -> Option<i32> {
  if args.get(1).and_then(|arg| arg.to_str()) != Some(TOKEN_HELPER_ARGUMENT) {
    return None;
  }
  let (Some(endpoint), Some(profile_key), None) = (
    args.get(2).and_then(|arg| arg.to_str()),
    args.get(3).and_then(|arg| arg.to_str()),
    args.get(4),
  ) else {
    return Some(fail_helper());
  };
  match request_token(endpoint, profile_key) {
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
  if !endpoint.starts_with(r"\\.\pipe\stella-token-") {
    return None;
  }
  std::fs::OpenOptions::new()
    .read(true)
    .write(true)
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

  #[tokio::test(flavor = "multi_thread")]
  async fn the_socket_is_private_to_this_user() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let broker = CodexManagedTokenBroker::start(Arc::new(FixedSource)).unwrap();
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
  async fn only_a_complete_request_for_the_current_sign_in_gets_a_token() {
    let broker = CodexManagedTokenBroker::start(Arc::new(FixedSource)).unwrap();
    let endpoint = broker.endpoint().to_owned();
    tokio::task::spawn_blocking(move || {
      let good = format!("{{\"version\":1,\"profileKey\":\"{KEY}\"}}\n");
      assert_eq!(
        exchange(&endpoint, good.as_bytes()),
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
      // The helper speaks the same protocol.
      assert_eq!(
        request_token(&endpoint, KEY).as_deref(),
        Some("access-fixture")
      );
      assert_eq!(request_token(&endpoint, &other_key), None);
      assert_eq!(request_token(&endpoint, "short"), None);
    })
    .await
    .unwrap();
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn a_silent_peer_is_disconnected() {
    let broker = CodexManagedTokenBroker::start(Arc::new(FixedSource)).unwrap();
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
      run_token_helper(&["stella-desktop".into(), TOKEN_HELPER_ARGUMENT.into()]),
      Some(1)
    );
  }

  #[test]
  fn the_launch_names_the_helper_and_broker_but_no_token() {
    let launch = launch_for(
      Path::new("/Applications/Stella.app/Contents/MacOS/stella-desktop"),
      "/tmp/stella-token-abc/s",
      KEY,
    );
    assert_eq!(
      launch.config_overrides[0],
      "model_provider=\"openai_chatgpt_plan\""
    );
    assert_eq!(
      launch.config_overrides[1],
      format!(
        "model_providers.openai_chatgpt_plan={{name=\"ChatGPT plan\",\
         base_url=\"https://api.openai.com/v1\",wire_api=\"responses\",\
         requires_openai_auth=false,supports_websockets=false,\
         auth={{command=\"/Applications/Stella.app/Contents/MacOS/stella-desktop\",\
         args=[\"--codex-chatgpt-token\",\"/tmp/stella-token-abc/s\",\"{KEY}\"],\
         timeout_ms=80000,refresh_interval_ms=0}}}}"
      )
    );
    assert_eq!(launch.client_name, "Stella");
    assert!(launch.removed_environment.contains(&"OPENAI_API_KEY"));
    assert!(launch.removed_environment.contains(&"ACCESS_TOKEN"));
  }

  #[test]
  fn windows_paths_stay_valid_toml() {
    let launch = launch_for(
      Path::new(r"C:\Program Files\Stella\stella-desktop.exe"),
      r"\\.\pipe\stella-token-1",
      KEY,
    );
    assert!(
      launch.config_overrides[1]
        .contains(r#"command="C:\\Program Files\\Stella\\stella-desktop.exe""#)
    );
    assert!(launch.config_overrides[1].contains(r#""\\\\.\\pipe\\stella-token-1""#));
  }
}
