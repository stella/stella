use std::{
  collections::HashMap,
  ffi::{OsStr, OsString},
  fs::File,
  io,
  os::unix::fs::MetadataExt,
  path::{Component, Path, PathBuf},
  sync::{Arc, Mutex, OnceLock},
};

use rustix::fs::{self, AtFlags, Mode, OFlags};

use super::OpenMode;

const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
  .union(OFlags::DIRECTORY)
  .union(OFlags::NOFOLLOW)
  .union(OFlags::CLOEXEC);
const DIRECTORY_MODE: Mode = Mode::from_raw_mode(0o700);
const FILE_MODE: Mode = Mode::from_raw_mode(0o600);

fn invalid_path() -> io::Error {
  io::Error::new(io::ErrorKind::InvalidInput, "invalid local file path")
}

fn check_owner(file: &File) -> io::Result<()> {
  if file.metadata()?.uid() != rustix::process::geteuid().as_raw() {
    return Err(io::Error::new(
      io::ErrorKind::PermissionDenied,
      "local file owner differs",
    ));
  }
  Ok(())
}

fn child_directory(
  parent: &File,
  name: &OsStr,
  create: bool,
  restrict: bool,
) -> io::Result<File> {
  if create {
    match fs::mkdirat(parent, name, DIRECTORY_MODE) {
      Ok(()) => fs::fsync(parent)?,
      Err(rustix::io::Errno::EXIST) => {}
      Err(error) => return Err(error.into()),
    }
  }
  let directory = File::from(fs::openat(parent, name, DIRECTORY_FLAGS, Mode::empty())?);
  if restrict {
    check_owner(&directory)?;
    fs::fchmod(&directory, DIRECTORY_MODE)?;
  }
  Ok(directory)
}

fn absolute_directory(path: &Path) -> io::Result<File> {
  if !path.is_absolute() {
    return Err(invalid_path());
  }
  let mut directory = File::from(fs::open("/", DIRECTORY_FLAGS, Mode::empty())?);
  for component in path.components() {
    match component {
      Component::RootDir => {}
      Component::Normal(name) => {
        directory = child_directory(&directory, name, true, false)?
      }
      _ => return Err(invalid_path()),
    }
  }
  Ok(directory)
}

fn roots() -> Vec<(PathBuf, bool)> {
  let mut roots = Vec::new();
  for base in [
    dirs::data_dir(),
    dirs::data_local_dir(),
    dirs::cache_dir(),
    dirs::state_dir(),
  ]
  .into_iter()
  .flatten()
  {
    roots.push((base.join(crate::config::APP_DATA_DIR_NAME), true));
  }
  #[cfg(target_os = "macos")]
  if let Some(home) = dirs::home_dir() {
    roots.push((
      home
        .join("Library/Logs")
        .join(crate::config::APP_DATA_DIR_NAME),
      true,
    ));
    roots.push((home.join("Library/LaunchAgents"), false));
  }
  roots.push((std::env::temp_dir(), false));
  roots
}

// Platform-selected ancestors may be system aliases. Resolve those before
// pinning the application root; the root and its descendants remain no-follow.
fn physical_platform_parent(path: &Path) -> io::Result<PathBuf> {
  let mut ancestor = path;
  let mut missing = Vec::new();
  loop {
    match ancestor.canonicalize() {
      Ok(mut physical) => {
        for name in missing.into_iter().rev() {
          physical.push(name);
        }
        return Ok(physical);
      }
      Err(error) if error.kind() == io::ErrorKind::NotFound => {
        missing.push(ancestor.file_name().ok_or_else(invalid_path)?);
        ancestor = ancestor.parent().ok_or_else(invalid_path)?;
      }
      Err(error) => return Err(error),
    }
  }
}

fn physical_application_root(path: &Path) -> io::Result<PathBuf> {
  Ok(
    physical_platform_parent(path.parent().ok_or_else(invalid_path)?)?
      .join(path.file_name().ok_or_else(invalid_path)?),
  )
}

fn root_for(path: &Path) -> io::Result<(Arc<File>, PathBuf)> {
  let (root_path, restrict) = roots()
    .into_iter()
    .filter(|(root, _)| path.starts_with(root))
    .max_by_key(|(root, _)| root.components().count())
    .ok_or_else(invalid_path)?;
  let temporary_anchor = root_path == std::env::temp_dir();
  let relative = path
    .strip_prefix(&root_path)
    .map_err(|error| {
      io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("invalid local file path: {error}"),
      )
    })?
    .to_path_buf();
  static ROOTS: OnceLock<Mutex<HashMap<PathBuf, Arc<File>>>> = OnceLock::new();
  // The registry only caches opened handles, so a panic elsewhere cannot leave
  // it inconsistent.
  let mut opened = ROOTS
    .get_or_init(Mutex::default)
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner);
  if let Some(directory) = opened.get(&root_path) {
    if !temporary_anchor {
      check_owner(directory)?;
    }
    if restrict {
      fs::fchmod(directory, DIRECTORY_MODE)?;
    }
    return Ok((Arc::clone(directory), relative));
  }
  // The temporary anchor itself is platform supplied; application roots
  // retain no-follow traversal after resolving only their platform parent.
  let physical_root = if temporary_anchor {
    root_path.canonicalize()?
  } else {
    physical_application_root(&root_path)?
  };
  let directory = absolute_directory(&physical_root)?;
  if temporary_anchor {
    let metadata = directory.metadata()?;
    let trusted = (metadata.uid() == rustix::process::geteuid().as_raw()
      && metadata.mode() & 0o022 == 0)
      || (metadata.uid() == 0
        && (metadata.mode() & 0o022 == 0 || metadata.mode() & 0o1000 != 0));
    if !trusted {
      return Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "temporary root is not trusted",
      ));
    }
  }
  if !temporary_anchor {
    check_owner(&directory)?;
  }
  if restrict {
    fs::fchmod(&directory, DIRECTORY_MODE)?;
  }
  let directory = Arc::new(directory);
  opened.insert(root_path, Arc::clone(&directory));
  drop(opened);
  Ok((directory, relative))
}

pub(super) fn create_directory(path: &Path) -> io::Result<()> {
  directory(path, true).map(|_| ())
}

pub(super) fn directory(path: &Path, create: bool) -> io::Result<File> {
  let (root, relative) = root_for(path)?;
  let mut directory = root.try_clone()?;
  for component in relative.components() {
    let Component::Normal(name) = component else {
      return Err(invalid_path());
    };
    directory = child_directory(&directory, name, create, true)?;
  }
  Ok(directory)
}

pub(super) struct Parent {
  directory: File,
  name: OsString,
}

impl Parent {
  pub(super) fn at(path: &Path) -> io::Result<Self> {
    let name = path.file_name().ok_or_else(invalid_path)?.to_os_string();
    let parent = path.parent().ok_or_else(invalid_path)?;
    Ok(Self {
      directory: directory(parent, false)?,
      name,
    })
  }

  pub(super) fn sibling(&self, name: OsString) -> io::Result<Self> {
    let mut components = Path::new(&name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
      || components.next().is_some()
    {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid local file name",
      ));
    }
    Ok(Self {
      directory: self.directory.try_clone()?,
      name,
    })
  }

  pub(super) fn create_runtime_file(
    &self,
    mode: super::RuntimeFileMode,
  ) -> io::Result<File> {
    let permissions = Mode::from_raw_mode(match mode {
      super::RuntimeFileMode::Data => 0o644,
      super::RuntimeFileMode::Executable => 0o755,
    });
    let file = File::from(fs::openat(
      &self.directory,
      &self.name,
      OFlags::WRONLY
        | OFlags::CREATE
        | OFlags::EXCL
        | OFlags::NOFOLLOW
        | OFlags::CLOEXEC,
      permissions,
    )?);
    check_owner(&file)?;
    fs::fchmod(&file, permissions)?;
    Ok(file)
  }

  pub(super) fn create_directory_new(&self) -> io::Result<()> {
    fs::mkdirat(&self.directory, &self.name, DIRECTORY_MODE)?;
    let directory = child_directory(&self.directory, &self.name, false, true)?;
    fs::fsync(&directory)?;
    fs::fsync(&self.directory)?;
    Ok(())
  }

  pub(super) fn publish_directory(&self, destination: &Self) -> io::Result<()> {
    let directory = child_directory(&self.directory, &self.name, false, true)?;
    fs::fsync(&directory)?;
    fs::renameat_with(
      &self.directory,
      &self.name,
      &destination.directory,
      &destination.name,
      fs::RenameFlags::NOREPLACE,
    )?;
    fs::fsync(&destination.directory)?;
    fs::fsync(&self.directory)?;
    Ok(())
  }

  #[cfg(target_os = "linux")]
  pub(super) fn bind_socket(&self) -> io::Result<tokio::net::UnixListener> {
    use std::os::fd::AsRawFd;
    let metadata = self.directory.metadata()?;
    check_owner(&self.directory)?;
    if metadata.mode() & 0o777 != 0o700 {
      return Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "socket directory is not private",
      ));
    }
    let path = PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd()))
      .join(&self.name);
    let listener = tokio::net::UnixListener::bind(path)?;
    // O_PATH can pin a socket inode without opening a connection to it. The
    // no-follow open also refuses to chmod a replaced symbolic link's target.
    let socket = File::from(fs::openat(
      &self.directory,
      &self.name,
      OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
      Mode::empty(),
    )?);
    restrict_socket(&socket)?;
    Ok(listener)
  }

  #[cfg(not(target_os = "linux"))]
  pub(super) fn bind_socket(&self) -> io::Result<tokio::net::UnixListener> {
    check_owner(&self.directory)?;
    Err(io::Error::new(
      io::ErrorKind::Unsupported,
      super::UnsupportedPinnedOperation("Unix socket binding"),
    ))
  }

  pub(super) fn open(&self, mode: OpenMode) -> io::Result<File> {
    let flags = match mode {
      OpenMode::Read => OFlags::RDONLY,
      OpenMode::CreateNew => OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
      OpenMode::Append => OFlags::WRONLY | OFlags::CREATE | OFlags::APPEND,
      #[cfg(test)]
      OpenMode::AppendExisting => OFlags::WRONLY | OFlags::APPEND,
      OpenMode::Lock => OFlags::RDWR | OFlags::CREATE,
    };
    let file = File::from(fs::openat(
      &self.directory,
      &self.name,
      flags | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
      FILE_MODE,
    )?);
    if !file.metadata()?.is_file() {
      return Err(invalid_path());
    }
    check_owner(&file)?;
    Ok(file)
  }

  fn check_entry(&self) -> io::Result<()> {
    match self.open(OpenMode::Read) {
      Ok(_) => Ok(()),
      Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
      Err(error) => Err(error),
    }
  }

  pub(super) fn rename_to(&self, destination: &Self) -> io::Result<()> {
    self.rename_to_with(destination, &File::sync_all)
  }

  pub(super) fn rename_to_with(
    &self,
    destination: &Self,
    sync: &impl Fn(&File) -> io::Result<()>,
  ) -> io::Result<()> {
    let source = self.open(OpenMode::Read)?;
    fs::fchmod(&source, FILE_MODE)?;
    destination.check_entry()?;
    fs::renameat(
      &self.directory,
      &self.name,
      &destination.directory,
      &destination.name,
    )?;
    sync(&destination.directory)?;
    let source_metadata = self.directory.metadata()?;
    let destination_metadata = destination.directory.metadata()?;
    if source_metadata.dev() != destination_metadata.dev()
      || source_metadata.ino() != destination_metadata.ino()
    {
      sync(&self.directory)?;
    }
    Ok(())
  }

  pub(super) fn move_to(&self, destination: &Self) -> io::Result<()> {
    let source = self.open(OpenMode::Read)?;
    fs::fchmod(&source, FILE_MODE)?;
    fs::fsync(&source)?;
    destination.check_entry()?;
    fs::renameat_with(
      &self.directory,
      &self.name,
      &destination.directory,
      &destination.name,
      fs::RenameFlags::NOREPLACE,
    )?;
    fs::fsync(&destination.directory)?;
    fs::fsync(&self.directory)?;
    Ok(())
  }

  pub(super) fn link_to(&self, destination: &Self) -> io::Result<()> {
    let source = self.open(OpenMode::Read)?;
    fs::fchmod(&source, FILE_MODE)?;
    destination.check_entry()?;
    fs::linkat(
      &self.directory,
      &self.name,
      &destination.directory,
      &destination.name,
      AtFlags::empty(),
    )?;
    fs::fsync(&destination.directory)?;
    Ok(())
  }

  pub(super) fn remove(&self) -> io::Result<()> {
    fs::unlinkat(&self.directory, &self.name, AtFlags::empty())?;
    fs::fsync(&self.directory)?;
    Ok(())
  }
}

#[cfg(target_os = "linux")]
fn restrict_socket(socket: &File) -> io::Result<()> {
  use std::os::{fd::AsRawFd, unix::fs::FileTypeExt};
  if !socket.metadata()?.file_type().is_socket() {
    return Err(invalid_path());
  }
  check_owner(socket)?;
  // Linux does not fchmod O_PATH descriptors. Its proc descriptor namespace
  // follows the pinned inode, including after unlink or replacement of the name.
  let path = PathBuf::from(format!("/proc/self/fd/{}", socket.as_raw_fd()));
  fs::chmodat(fs::CWD, &path, FILE_MODE, AtFlags::empty()).map_err(Into::into)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[cfg(target_os = "linux")]
  #[test]
  fn socket_permissions_follow_the_opened_inode_after_name_replacement() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = super::super::create_temporary_root().unwrap();
    let path = root.join("s");
    let moved = root.join("moved");
    let outside = root.join("outside");
    super::super::write_private_atomic(&outside, b"outside").unwrap();
    std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o644)).unwrap();
    let unchanged = std::fs::metadata(&outside).unwrap().mode();
    assert_eq!(unchanged & 0o777, 0o644);
    let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let parent = Parent::at(&path).unwrap();
    let socket = File::from(
      fs::openat(
        &parent.directory,
        &parent.name,
        OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
      )
      .unwrap(),
    );
    std::fs::rename(&path, &moved).unwrap();
    symlink(&outside, &path).unwrap();
    restrict_socket(&socket).unwrap();
    assert_eq!(std::fs::metadata(&moved).unwrap().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(&outside).unwrap().mode(), unchanged);
    let replaced = File::from(
      fs::openat(
        &parent.directory,
        &parent.name,
        OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
      )
      .unwrap(),
    );
    assert_eq!(
      restrict_socket(&replaced).unwrap_err().kind(),
      io::ErrorKind::InvalidInput
    );
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn platform_aliases_keep_application_roots_no_follow() {
    use std::os::unix::fs::symlink;
    let root =
      std::env::temp_dir().join(format!("stella-platform-{}", uuid::Uuid::new_v4()));
    let physical = root.join("physical");
    std::fs::create_dir_all(&physical).unwrap();
    let alias = root.join("platform");
    symlink(&physical, &alias).unwrap();
    let application = alias.join("missing/stella");
    let resolved = physical_application_root(&application).unwrap();
    let handle = absolute_directory(&resolved).unwrap();
    assert_eq!(
      handle.metadata().unwrap().ino(),
      std::fs::metadata(&application).unwrap().ino()
    );
    std::fs::remove_dir(&application).unwrap();
    symlink(&physical, &application).unwrap();
    assert!(
      absolute_directory(&physical_application_root(&application).unwrap()).is_err()
    );
    std::fs::remove_dir_all(root).unwrap();
  }
}
