//! Filesystem and endpoint operations for the private token channel.

#[cfg(unix)]
use std::path::Path;

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

  pub(crate) fn restrict_socket(&self) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
      self.path.join("s"),
      std::fs::Permissions::from_mode(0o600),
    )
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

#[cfg(windows)]
pub(crate) fn connect(endpoint: &str) -> Option<std::fs::File> {
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
