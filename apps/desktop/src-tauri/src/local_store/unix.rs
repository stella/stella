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
  #[cfg(test)]
  roots.push((std::env::temp_dir(), false));
  roots
}

fn root_for(path: &Path) -> io::Result<(Arc<File>, PathBuf)> {
  let (root_path, restrict) = roots()
    .into_iter()
    .filter(|(root, _)| path.starts_with(root))
    .max_by_key(|(root, _)| root.components().count())
    .ok_or_else(invalid_path)?;
  #[cfg(test)]
  let temporary_anchor = root_path == std::env::temp_dir();
  #[cfg(not(test))]
  let temporary_anchor = false;
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
  // Only the platform-supplied temporary anchor may contain a system alias.
  // All descendants, including test fixtures, still use no-follow traversal.
  #[cfg(test)]
  let physical_root = if root_path == std::env::temp_dir() {
    root_path.canonicalize()?
  } else {
    root_path.clone()
  };
  #[cfg(not(test))]
  let physical_root = root_path.clone();
  let directory = absolute_directory(&physical_root)?;
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
    let source = self.open(OpenMode::Read)?;
    fs::fchmod(&source, FILE_MODE)?;
    destination.check_entry()?;
    fs::renameat(
      &self.directory,
      &self.name,
      &destination.directory,
      &destination.name,
    )?;
    fs::fsync(&destination.directory)?;
    let source_metadata = self.directory.metadata()?;
    let destination_metadata = destination.directory.metadata()?;
    if source_metadata.dev() != destination_metadata.dev()
      || source_metadata.ino() != destination_metadata.ino()
    {
      fs::fsync(&self.directory)?;
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
