use super::OpenMode;
use std::{
  ffi::OsString,
  fs, io,
  path::{Path, PathBuf},
};

pub(super) fn create_directory(path: &Path) -> io::Result<()> {
  fs::create_dir_all(path)
}

pub(super) struct Parent {
  path: PathBuf,
}

impl Parent {
  pub(super) fn at(path: &Path) -> io::Result<Self> {
    if !path.is_absolute() || path.file_name().is_none() {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid local file path",
      ));
    }
    Ok(Self {
      path: path.to_path_buf(),
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
    })
  }

  pub(super) fn open(&self, mode: OpenMode) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    match mode {
      OpenMode::Read => {
        options.read(true);
      }
      OpenMode::CreateNew => {
        options.write(true).create_new(true);
      }
      OpenMode::Append => {
        options.append(true).create(true);
      }
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

  pub(super) fn link_to(&self, destination: &Self) -> io::Result<()> {
    fs::hard_link(&self.path, &destination.path)
  }

  pub(super) fn remove(&self) -> io::Result<()> {
    fs::remove_file(&self.path)
  }
}
