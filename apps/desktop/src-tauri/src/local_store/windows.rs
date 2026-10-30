use super::OpenMode;
use std::{
  ffi::OsString,
  fs, io,
  path::{Path, PathBuf},
};

const FILE_SHARE_READ: u32 = 0x1;
const FILE_SHARE_WRITE: u32 = 0x2;
const FILE_SHARE_DELETE: u32 = 0x4;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

pub(super) fn create_directory(path: &Path) -> io::Result<()> {
  if !path.is_absolute() {
    return Err(io::Error::new(
      io::ErrorKind::InvalidInput,
      "invalid local directory",
    ));
  }
  let mut current = PathBuf::new();
  for component in path.components() {
    current.push(component);
    if matches!(
      component,
      std::path::Component::Prefix(_) | std::path::Component::RootDir
    ) {
      continue;
    }
    let pinned = Parent::at(&current)?;
    match pinned.create_directory_new() {
      Ok(()) => {}
      Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
      Err(error) => return Err(error),
    }
    // Verify the new leaf before continuing the walk, including on the last
    // component. Holding the parent pins its path while opening the leaf.
    let _leaf = Parent::at(&current.join(".directory-check"))?;
  }
  Ok(())
}

pub(super) struct Parent {
  path: PathBuf,
  // Denying delete sharing pins every ancestor while an operation uses paths.
  parents: Vec<fs::File>,
}

impl Parent {
  pub(super) fn at(path: &Path) -> io::Result<Self> {
    if !path.is_absolute() || path.file_name().is_none() {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid local file path",
      ));
    }
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let mut current = PathBuf::new();
    let mut parents = Vec::new();
    for component in path
      .parent()
      .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent"))?
      .components()
    {
      if !matches!(
        component,
        std::path::Component::Prefix(_)
          | std::path::Component::RootDir
          | std::path::Component::Normal(_)
      ) {
        return Err(io::Error::new(
          io::ErrorKind::InvalidInput,
          "invalid local directory",
        ));
      }
      current.push(component);
      if matches!(component, std::path::Component::Prefix(_)) {
        continue;
      }
      let directory = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&current)?;
      let metadata = directory.metadata()?;
      if !metadata.is_dir()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
      {
        return Err(io::Error::new(
          io::ErrorKind::PermissionDenied,
          "local directory is a reparse point",
        ));
      }
      parents.push(directory);
    }
    Ok(Self {
      path: path.to_path_buf(),
      parents,
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
      path: self.path.with_file_name(name),
      parents: self
        .parents
        .iter()
        .map(fs::File::try_clone)
        .collect::<io::Result<Vec<_>>>()?,
    })
  }

  pub(super) fn create_runtime_file(
    &self,
    _mode: super::RuntimeFileMode,
  ) -> io::Result<fs::File> {
    self.open(OpenMode::CreateNew)
  }

  pub(super) fn create_directory_new(&self) -> io::Result<()> {
    fs::create_dir(&self.path)
  }

  pub(super) fn publish_directory(&self, destination: &Self) -> io::Result<()> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let directory = fs::OpenOptions::new()
      .read(true)
      .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
      .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
      .open(&self.path)?;
    let metadata = directory.metadata()?;
    if !metadata.is_dir()
      || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
      return Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "published directory is a reparse point",
      ));
    }
    self.move_to(destination)
  }

  pub(super) fn open(&self, mode: OpenMode) -> io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    let mut options = fs::OpenOptions::new();
    match mode {
      OpenMode::Read => {
        options.read(true);
      }
      OpenMode::ExclusiveRead => {
        options.read(true).share_mode(0);
      }
      OpenMode::CreateNew => {
        options.write(true).create_new(true);
      }
      OpenMode::Append => {
        options.append(true).create(true);
      }
      #[cfg(test)]
      OpenMode::AppendExisting => {
        options.append(true);
      }
      OpenMode::Lock => {
        options.read(true).write(true).create(true).truncate(false);
      }
    }
    options.open(&self.path)
  }

  pub(super) fn rename_to(&self, destination: &Self) -> io::Result<()> {
    fs::rename(&self.path, &destination.path)
  }

  pub(super) fn rename_to_with(
    &self,
    destination: &Self,
    _sync: &impl Fn(&fs::File) -> io::Result<()>,
  ) -> io::Result<()> {
    self.rename_to(destination)
  }

  pub(super) fn move_to(&self, destination: &Self) -> io::Result<()> {
    let source = self.path.to_str().ok_or_else(|| {
      io::Error::new(io::ErrorKind::InvalidInput, "invalid local file path")
    })?;
    let destination = destination.path.to_str().ok_or_else(|| {
      io::Error::new(io::ErrorKind::InvalidInput, "invalid local file path")
    })?;
    winsafe::MoveFileEx(
      source,
      Some(destination),
      winsafe::co::MOVEFILE::WRITE_THROUGH,
    )
    .map_err(|error| io::Error::from_raw_os_error(error.raw() as i32))
  }

  pub(super) fn link_to(&self, destination: &Self) -> io::Result<()> {
    fs::hard_link(&self.path, &destination.path)
  }

  pub(super) fn remove(&self) -> io::Result<()> {
    fs::remove_file(&self.path)
  }
}
