//! Filesystem and endpoint operations for the private token channel.

#[cfg(unix)]
use std::path::Path;

/// The socket's name inside the broker's private directory.
#[cfg(unix)]
const SOCKET_NAME: &str = "s";

/// Every broker pipe name starts with this; the helper opens no other pipe.
#[cfg(windows)]
pub(crate) const PIPE_PREFIX: &str = r"\\.\pipe\stella-token-";

/// A `0700` directory this process created, removed (only if it is still
/// the same directory) when dropped.
#[cfg(unix)]
pub(crate) struct OwnedDirectory {
  pub(crate) path: std::path::PathBuf,
  device: u64,
  inode: u64,
}

#[cfg(unix)]
impl OwnedDirectory {
  pub(crate) fn create() -> std::io::Result<Self> {
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

  /// Binds the broker socket in this directory, readable and writable by the
  /// owner only.
  ///
  /// The platforms differ on purpose. Linux binds through a descriptor pinned
  /// to the directory this process created (`/proc/self/fd`), so a directory
  /// swapped in after creation never receives the socket. macOS has no
  /// directory-relative bind, so it binds the checked path; refusing there
  /// would leave ChatGPT-plan Codex runs without a token.
  #[cfg(target_os = "linux")]
  pub(crate) fn bind_socket(&self) -> std::io::Result<std::os::fd::OwnedFd> {
    use rustix::fs::{Mode, OFlags};
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
      return Err(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "token broker directory is not private",
      ));
    }
    let pinned =
      std::path::PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
        .join(SOCKET_NAME);
    let listener = std::os::unix::net::UnixListener::bind(pinned)?;
    // O_PATH pins the socket inode without connecting to it; the no-follow
    // open refuses a name that was replaced by a symbolic link.
    let socket = std::fs::File::from(rustix::fs::openat(
      &directory,
      SOCKET_NAME,
      OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
      Mode::empty(),
    )?);
    restrict_socket(&socket)?;
    Ok(listener.into())
  }

  #[cfg(not(target_os = "linux"))]
  pub(crate) fn bind_socket(&self) -> std::io::Result<std::os::fd::OwnedFd> {
    use std::os::unix::fs::PermissionsExt;

    let path = self.path.join(SOCKET_NAME);
    let listener = std::os::unix::net::UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener.into())
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
    let _ = std::fs::remove_file(self.path.join(SOCKET_NAME));
    let _ = std::fs::remove_dir(&self.path);
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
    let directory = OwnedDirectory::create().unwrap();
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
    let metadata = std::fs::symlink_metadata(directory.path.join(SOCKET_NAME)).unwrap();
    assert!(metadata.file_type().is_socket());
    assert_eq!(metadata.mode() & 0o777, 0o600);
    drop(listener);
    std::fs::remove_dir(outside).unwrap();
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
  }
}
