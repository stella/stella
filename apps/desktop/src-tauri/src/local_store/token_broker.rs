//! Filesystem and endpoint operations for the private token channel.
//!
//! The broker keeps one endpoint across app starts. A Codex run the harness
//! holder kept through a restart names that endpoint in its environment, so
//! the restarted broker must listen there for the run's next token request
//! to reach it. Each start records its endpoint in the app's data
//! ([`record_endpoint`]). The next start listens there again when it passes
//! every check a fresh endpoint passes and nothing else listens there, and
//! on a fresh endpoint, recorded in its place, otherwise.

#[cfg(any(unix, windows))]
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

/// The socket's name inside the broker's private directory.
#[cfg(unix)]
const SOCKET_NAME: &str = "s";

/// Every broker directory's name: this prefix and 12 lowercase hex digits.
#[cfg(unix)]
const DIRECTORY_PREFIX: &str = "stella-token-";

/// Stays below macOS's 104-byte and Linux's 108-byte socket path limits.
#[cfg(unix)]
pub(crate) const SOCKET_PATH_BYTES: usize = 100;

/// Every broker pipe name starts with this; the helper opens no other pipe.
#[cfg(windows)]
pub(crate) const PIPE_PREFIX: &str = r"\\.\pipe\stella-token-";

/// A record longer than any endpoint this module makes is not one.
#[cfg(any(unix, windows))]
const RECORD_BYTES: usize = 1024;

/// The endpoint a previous start recorded in `record`, if any.
#[cfg(any(unix, windows))]
pub(crate) fn recorded_endpoint(record: &Path) -> Option<String> {
  use std::io::Read;

  let mut text = String::new();
  std::fs::File::open(record)
    .ok()?
    .take((RECORD_BYTES + 1) as u64)
    .read_to_string(&mut text)
    .ok()?;
  (!text.is_empty() && text.len() <= RECORD_BYTES).then_some(text)
}

/// Records `endpoint` in `record` for the next start. Without the record the
/// next start listens at a fresh endpoint, which only the runs it launches
/// itself can reach.
#[cfg(any(unix, windows))]
pub(crate) fn record_endpoint(record: &Path, endpoint: &str) {
  let recorded = record
    .parent()
    .map_or(Ok(()), super::create_private_dir)
    .map_err(|error| error.to_string())
    .and_then(|()| super::write_private_atomic(record, endpoint.as_bytes()));
  if recorded.is_err() {
    tracing::warn!("the token broker endpoint was not recorded for the next start");
  }
}

/// The pipe a previous start recorded in `record`, when it is a broker pipe.
#[cfg(windows)]
pub(crate) fn recorded_pipe(record: &Path) -> Option<String> {
  recorded_endpoint(record).filter(|name| {
    name
      .strip_prefix(PIPE_PREFIX)
      .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
  })
}

/// A pipe name no other start used.
#[cfg(windows)]
pub(crate) fn fresh_pipe() -> String {
  format!("{PIPE_PREFIX}{}", uuid::Uuid::new_v4())
}

/// The broker's directory with its socket bound: the one `record` names when
/// a previous start left it private to this user and nothing listens in it
/// any more, else a fresh one, recorded for the next start.
#[cfg(unix)]
pub(crate) fn bind_broker(
  record: &Path,
) -> std::io::Result<(OwnedDirectory, std::os::fd::OwnedFd)> {
  if let Some(recorded) = recorded_endpoint(record) {
    match OwnedDirectory::reopen(Path::new(&recorded)) {
      Ok(mut directory) => match directory.bind_socket() {
        Ok(socket) => return Ok((directory, socket)),
        Err(error) => {
          tracing::info!(kind = ?error.kind(), "the token broker cannot listen at its recorded endpoint");
        }
      },
      Err(error) => {
        tracing::info!(kind = ?error.kind(), "the token broker's recorded endpoint is not private");
      }
    }
  }
  let mut directory = OwnedDirectory::create()?;
  let socket = directory.bind_socket()?;
  match directory.socket_path().to_str() {
    Some(endpoint) => record_endpoint(record, endpoint),
    None => tracing::warn!("the token broker endpoint is not UTF-8"),
  }
  Ok((directory, socket))
}

/// Whether `endpoint` is a socket of this user's in a `0700` directory of
/// this user's: the helper asks nothing of any other socket.
#[cfg(unix)]
pub(crate) fn is_private_socket(endpoint: &Path) -> bool {
  use std::os::unix::fs::{FileTypeExt, MetadataExt};

  let owner = rustix::process::geteuid().as_raw();
  let Some(directory) = endpoint.parent() else {
    return false;
  };
  let (Ok(directory), Ok(socket)) = (
    std::fs::symlink_metadata(directory),
    std::fs::symlink_metadata(endpoint),
  ) else {
    return false;
  };
  endpoint.is_absolute()
    && directory.is_dir()
    && directory.uid() == owner
    && directory.mode() & 0o777 == 0o700
    && socket.file_type().is_socket()
    && socket.uid() == owner
}

#[cfg(unix)]
fn not_private() -> std::io::Error {
  std::io::Error::new(
    std::io::ErrorKind::PermissionDenied,
    "token broker directory is not private",
  )
}

/// The temporary folders a broker directory may be in, in order.
#[cfg(unix)]
fn parents() -> [PathBuf; 2] {
  [std::env::temp_dir(), PathBuf::from("/tmp")]
}

#[cfg(unix)]
fn is_directory_name(name: &str) -> bool {
  name.strip_prefix(DIRECTORY_PREFIX).is_some_and(|id| {
    id.len() == 12
      && id
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
  })
}

/// A `0700` directory of this user's in a temporary folder. It outlives the
/// broker, so the next start can listen in it again; when dropped, only the
/// socket this broker bound is removed.
#[cfg(unix)]
pub(crate) struct OwnedDirectory {
  pub(crate) path: PathBuf,
  device: u64,
  inode: u64,
  /// The device and inode of the socket this broker bound here.
  socket: Option<(u64, u64)>,
}

#[cfg(unix)]
impl OwnedDirectory {
  /// A new directory, named as no other start named one.
  pub(crate) fn create() -> std::io::Result<Self> {
    let name = format!(
      "{DIRECTORY_PREFIX}{}",
      &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let mut last = std::io::Error::other("no private directory for the token broker");
    for parent in parents() {
      match std::fs::canonicalize(&parent)
        .and_then(|parent| Self::open_in(&parent, &name, false))
      {
        Ok(directory) => return Ok(directory),
        Err(error) => last = error,
      }
    }
    Err(last)
  }

  /// The directory of a previous start's `endpoint`, made again at the same
  /// path when it is gone. Refused unless it is a broker directory directly
  /// in one of the temporary folders that passes the checks of a fresh one.
  fn reopen(endpoint: &Path) -> std::io::Result<Self> {
    if endpoint.file_name() != Some(std::ffi::OsStr::new(SOCKET_NAME)) {
      return Err(not_private());
    }
    let directory = endpoint.parent().ok_or_else(not_private)?;
    let name = directory
      .file_name()
      .and_then(|name| name.to_str())
      .filter(|name| is_directory_name(name))
      .ok_or_else(not_private)?;
    let parent = directory.parent().ok_or_else(not_private)?;
    let in_a_temporary_folder = parents().iter().any(|candidate| {
      std::fs::canonicalize(candidate).is_ok_and(|candidate| candidate == parent)
    });
    if !in_a_temporary_folder {
      return Err(not_private());
    }
    Self::open_in(parent, name, true)
  }

  /// Where the broker socket is bound.
  pub(crate) fn socket_path(&self) -> PathBuf {
    self.path.join(SOCKET_NAME)
  }

  /// Binds the broker socket in this directory, readable and writable by the
  /// owner only. A socket a previous broker left here is replaced once
  /// nothing listens on it; a live one is never taken over.
  ///
  /// The platforms differ on purpose. Linux binds through a descriptor pinned
  /// to the directory this process checked (`/proc/self/fd`), so a directory
  /// swapped in after the check never receives the socket. macOS has no
  /// directory-relative bind, so it binds the checked path; refusing there
  /// would leave ChatGPT-plan Codex runs without a token.
  #[cfg(target_os = "linux")]
  pub(crate) fn bind_socket(&mut self) -> std::io::Result<std::os::fd::OwnedFd> {
    use rustix::fs::{AtFlags, Mode, OFlags};
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};

    let directory = std::fs::File::from(rustix::fs::open(
      self.path.as_path(),
      OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
      Mode::empty(),
    )?);
    let metadata = directory.metadata()?;
    if metadata.dev() != self.device
      || metadata.ino() != self.inode
      || metadata.uid() != rustix::process::geteuid().as_raw()
      || metadata.mode() & 0o777 != 0o700
    {
      return Err(not_private());
    }
    // O_PATH pins the socket inode without connecting to it; the no-follow
    // open refuses a name that was replaced by a symbolic link.
    let open_socket = || -> std::io::Result<std::fs::File> {
      Ok(std::fs::File::from(rustix::fs::openat(
        &directory,
        SOCKET_NAME,
        OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
      )?))
    };
    let pinned = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
      .join(SOCKET_NAME);
    let listener = bind_replacing_stale(&pinned, || {
      own_socket(&open_socket()?.metadata()?)?;
      rustix::fs::unlinkat(&directory, SOCKET_NAME, AtFlags::empty())
        .map_err(Into::into)
    })?;
    let socket = open_socket()?;
    restrict_socket(&socket)?;
    let bound = socket.metadata()?;
    self.socket = Some((bound.dev(), bound.ino()));
    Ok(listener.into())
  }

  #[cfg(not(target_os = "linux"))]
  pub(crate) fn bind_socket(&mut self) -> std::io::Result<std::os::fd::OwnedFd> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let path = self.socket_path();
    let listener = bind_replacing_stale(&path, || {
      own_socket(&std::fs::symlink_metadata(&path)?)?;
      std::fs::remove_file(&path)
    })?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    let bound = std::fs::symlink_metadata(&path)?;
    self.socket = Some((bound.dev(), bound.ino()));
    Ok(listener.into())
  }

  /// `name` in `parent`, created `0700` unless `reuse` allows one that is
  /// there. Either way the parent must be this user's and closed to others,
  /// or root's and sticky, and the directory a real one of this user's with
  /// mode `0700` whose socket path fits.
  fn open_in(parent: &Path, name: &str, reuse: bool) -> std::io::Result<Self> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    let path = parent.join(name);
    if path.join(SOCKET_NAME).as_os_str().len() > SOCKET_PATH_BYTES {
      return Err(std::io::Error::other("token broker path is too long"));
    }
    let created = match std::fs::DirBuilder::new().mode(0o700).create(&path) {
      Ok(()) => true,
      Err(error) if reuse && error.kind() == std::io::ErrorKind::AlreadyExists => false,
      Err(error) => return Err(error),
    };
    let owner = rustix::process::geteuid().as_raw();
    let parent_metadata = std::fs::symlink_metadata(parent)?;
    let parent_mode = parent_metadata.mode();
    let parent_trusted = parent_metadata.is_dir()
      && ((parent_metadata.uid() == owner && parent_mode & 0o022 == 0)
        || (parent_metadata.uid() == 0
          && (parent_mode & 0o022 == 0 || parent_mode & 0o1000 != 0)));
    if created {
      std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    let metadata = std::fs::symlink_metadata(&path)?;
    if !parent_trusted
      || !metadata.is_dir()
      || metadata.file_type().is_symlink()
      || metadata.uid() != owner
      || metadata.mode() & 0o777 != 0o700
    {
      if created {
        crate::logging::best_effort(
          std::fs::remove_dir(&path),
          "refused broker directory was not removed",
        );
      }
      return Err(not_private());
    }
    Ok(Self {
      path,
      device: metadata.dev(),
      inode: metadata.ino(),
      socket: None,
    })
  }
}

#[cfg(unix)]
impl Drop for OwnedDirectory {
  fn drop(&mut self) {
    use std::os::unix::fs::MetadataExt;
    // Never touch a directory that was replaced, or anything but the socket
    // this broker bound: a later start may already listen here.
    let Some((device, inode)) = self.socket else {
      return;
    };
    let Ok(current) = std::fs::symlink_metadata(&self.path) else {
      return;
    };
    if current.dev() != self.device || current.ino() != self.inode || !current.is_dir()
    {
      return;
    }
    let socket = self.socket_path();
    if std::fs::symlink_metadata(&socket)
      .is_ok_and(|bound| bound.dev() == device && bound.ino() == inode)
    {
      crate::logging::best_effort(std::fs::remove_file(socket), "broker socket was not removed");
    }
  }
}

/// Binds `path`. A socket already there is removed (`remove_stale`) and
/// bound anew only when nothing listens on it any more, as when a broker
/// ended without removing it. A live one is another broker's: binding fails.
#[cfg(unix)]
fn bind_replacing_stale(
  path: &Path,
  remove_stale: impl FnOnce() -> std::io::Result<()>,
) -> std::io::Result<std::os::unix::net::UnixListener> {
  match std::os::unix::net::UnixListener::bind(path) {
    Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {}
    bound => return bound,
  }
  match std::os::unix::net::UnixStream::connect(path) {
    Ok(_live) => {
      return Err(std::io::Error::new(
        std::io::ErrorKind::AddrInUse,
        "another token broker listens here",
      ));
    }
    Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {}
    Err(error) => return Err(error),
  }
  remove_stale()?;
  std::os::unix::net::UnixListener::bind(path)
}

/// Only a socket of this user's is ever removed as stale.
#[cfg(unix)]
fn own_socket(metadata: &std::fs::Metadata) -> std::io::Result<()> {
  use std::os::unix::fs::{FileTypeExt, MetadataExt};

  if metadata.file_type().is_socket()
    && metadata.uid() == rustix::process::geteuid().as_raw()
  {
    Ok(())
  } else {
    Err(not_private())
  }
}

/// Linux cannot `fchmod` an `O_PATH` descriptor; its proc descriptor name
/// follows the pinned inode, even after the socket's name is replaced.
#[cfg(target_os = "linux")]
fn restrict_socket(socket: &std::fs::File) -> std::io::Result<()> {
  use std::os::{
    fd::AsRawFd,
    unix::fs::{FileTypeExt, MetadataExt},
  };

  let metadata = socket.metadata()?;
  if !metadata.file_type().is_socket() {
    return Err(std::io::Error::new(
      std::io::ErrorKind::InvalidInput,
      "token broker socket is not a socket",
    ));
  }
  if metadata.uid() != rustix::process::geteuid().as_raw() {
    return Err(std::io::Error::new(
      std::io::ErrorKind::PermissionDenied,
      "token broker socket owner differs",
    ));
  }
  let path = std::path::PathBuf::from(format!("/proc/self/fd/{}", socket.as_raw_fd()));
  rustix::fs::chmodat(
    rustix::fs::CWD,
    path.as_path(),
    rustix::fs::Mode::from_raw_mode(0o600),
    rustix::fs::AtFlags::empty(),
  )
  .map_err(Into::into)
}

#[cfg(windows)]
pub(crate) fn connect(endpoint: &str) -> Option<std::fs::File> {
  use std::os::windows::fs::OpenOptionsExt;

  /// `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`: a server answering
  /// on this name can identify the helper but never act as it.
  const IDENTIFY_ONLY: u32 = 0x0010_0000 | 0x0001_0000;

  if !endpoint.starts_with(PIPE_PREFIX) {
    return None;
  }
  std::fs::OpenOptions::new()
    .read(true)
    .write(true)
    .security_qos_flags(IDENTIFY_ONLY)
    .open(endpoint)
    .ok()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
  use super::*;
  use rustix::fs::{Mode, OFlags};
  use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt, symlink};

  #[test]
  fn the_socket_is_bound_only_in_the_directory_this_process_created() {
    let mut directory = OwnedDirectory::create().unwrap();
    let moved = directory.path.with_extension("moved");
    let outside = directory.path.with_extension("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::rename(&directory.path, &moved).unwrap();
    symlink(&outside, &directory.path).unwrap();
    assert!(directory.bind_socket().is_err());
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    std::fs::remove_file(&directory.path).unwrap();
    std::fs::rename(&moved, &directory.path).unwrap();

    let listener = directory.bind_socket().unwrap();
    let socket = directory.socket_path();
    let metadata = std::fs::symlink_metadata(&socket).unwrap();
    assert!(metadata.file_type().is_socket());
    assert_eq!(metadata.mode() & 0o777, 0o600);
    drop(listener);
    std::fs::remove_dir(outside).unwrap();
    let path = directory.path.clone();
    drop(directory);
    assert!(!socket.exists(), "the broker removes the socket it bound");
    std::fs::remove_dir(path).unwrap();
  }

  #[test]
  fn socket_permissions_follow_the_opened_inode_after_name_replacement() {
    let directory = OwnedDirectory::create().unwrap();
    let path = directory.path.join(SOCKET_NAME);
    let moved = directory.path.join("moved");
    let outside = directory.path.join("outside");
    std::fs::write(&outside, b"outside").unwrap();
    std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o644)).unwrap();
    let unchanged = std::fs::metadata(&outside).unwrap().mode();
    let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let handle = std::fs::File::from(
      rustix::fs::open(
        directory.path.as_path(),
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
      )
      .unwrap(),
    );
    let open_socket = || {
      std::fs::File::from(
        rustix::fs::openat(
          &handle,
          SOCKET_NAME,
          OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
          Mode::empty(),
        )
        .unwrap(),
      )
    };
    let socket = open_socket();
    std::fs::rename(&path, &moved).unwrap();
    symlink(&outside, &path).unwrap();
    restrict_socket(&socket).unwrap();
    assert_eq!(std::fs::metadata(&moved).unwrap().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(&outside).unwrap().mode(), unchanged);
    assert_eq!(
      restrict_socket(&open_socket()).unwrap_err().kind(),
      std::io::ErrorKind::InvalidInput
    );
    std::fs::remove_file(&moved).unwrap();
    std::fs::remove_file(&outside).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(&directory.path).unwrap();
  }
}
