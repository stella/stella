//! Unpacks a verified harness archive (`.tar.gz`) into an empty directory.
//!
//! The digest was checked before this runs, so the limits here guard against
//! a release that changed shape, not against tampering: only regular files
//! and directories at contained relative paths are accepted, with bounded
//! entry count and size. Modes are not taken from the archive; a file is
//! either executable (0755) or not (0644).

use std::{
  fs::{self, File, OpenOptions},
  io::{BufReader, Read, Write},
  path::{Path, PathBuf},
};

use tokio::sync::watch;

use crate::harness_release::is_contained_relative;

const MAX_ENTRIES: usize = 10_000;
const MAX_UNPACKED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnpackError {
  Cancelled,
  /// The archive is unreadable or holds an entry outside the accepted shape.
  Rejected,
  Storage,
}

pub(crate) fn unpack(
  archive: &Path,
  destination: &Path,
  cancel: &watch::Receiver<bool>,
) -> Result<(), UnpackError> {
  let file = File::open(archive).map_err(storage("harness archive is unreadable"))?;
  let mut archive =
    tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(file)));
  let entries = archive
    .entries()
    .map_err(rejected("harness archive is not a tar archive"))?;
  let mut count = 0usize;
  let mut unpacked = 0u64;
  for entry in entries {
    if *cancel.borrow() {
      return Err(UnpackError::Cancelled);
    }
    let mut entry = entry.map_err(rejected("harness archive entry is unreadable"))?;
    count += 1;
    if count > MAX_ENTRIES {
      return Err(UnpackError::Rejected);
    }
    let kind = entry.header().entry_type();
    if kind == tar::EntryType::XGlobalHeader {
      continue;
    }
    let target = contained_target(destination, &entry.path_bytes())?;
    if kind.is_dir() {
      fs::create_dir_all(target).map_err(storage("harness directory not created"))?;
      continue;
    }
    if !kind.is_file() {
      tracing::warn!(entry_type = ?kind, "harness archive holds a link or special file");
      return Err(UnpackError::Rejected);
    }
    let executable = entry
      .header()
      .mode()
      .map_err(rejected("harness archive entry has no mode"))?
      & 0o111
      != 0;
    let size = entry
      .header()
      .size()
      .map_err(rejected("harness archive entry has no size"))?;
    unpacked = unpacked.saturating_add(size);
    if unpacked > MAX_UNPACKED_BYTES {
      return Err(UnpackError::Rejected);
    }
    if write_file(&mut entry, &target, executable, cancel)? != size {
      tracing::warn!("harness archive entry is shorter than its header");
      return Err(UnpackError::Rejected);
    }
  }
  Ok(())
}

fn contained_target(destination: &Path, path: &[u8]) -> Result<PathBuf, UnpackError> {
  let path = std::str::from_utf8(path)
    .map_err(rejected("harness archive path is not UTF-8"))?
    .trim_end_matches('/');
  if !is_contained_relative(path) {
    tracing::warn!("harness archive path leaves its directory");
    return Err(UnpackError::Rejected);
  }
  Ok(
    path
      .split('/')
      .fold(destination.to_path_buf(), |dir, part| dir.join(part)),
  )
}

/// Returns the number of bytes written.
fn write_file(
  entry: &mut impl Read,
  target: &Path,
  executable: bool,
  cancel: &watch::Receiver<bool>,
) -> Result<u64, UnpackError> {
  if let Some(parent) = target.parent() {
    fs::create_dir_all(parent).map_err(storage("harness directory not created"))?;
  }
  let mut options = OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(if executable { 0o755 } else { 0o644 });
  }
  #[cfg(not(unix))]
  let _ = executable;
  let mut file = options.open(target).map_err(|error| {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
      tracing::warn!("harness archive repeats a path");
      UnpackError::Rejected
    } else {
      crate::logging::log_cause(&error, "harness file not created");
      UnpackError::Storage
    }
  })?;
  let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
  let mut written = 0u64;
  loop {
    if *cancel.borrow() {
      return Err(UnpackError::Cancelled);
    }
    let read = entry
      .read(&mut buffer)
      .map_err(rejected("harness archive entry is truncated"))?;
    if read == 0 {
      break;
    }
    file
      .write_all(&buffer[..read])
      .map_err(storage("harness file not written"))?;
    written += read as u64;
  }
  file
    .sync_all()
    .map_err(storage("harness file not flushed"))?;
  Ok(written)
}

fn rejected<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> UnpackError {
  crate::logging::replaced_logged(what, UnpackError::Rejected)
}

fn storage<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> UnpackError {
  crate::logging::replaced_logged(what, UnpackError::Storage)
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;

  /// A directory under the system temporary directory, removed on drop.
  pub(crate) struct TempDir(PathBuf);

  impl TempDir {
    pub(crate) fn new() -> Self {
      let path =
        std::env::temp_dir().join(format!("stella-harness-{}", uuid::Uuid::new_v4()));
      fs::create_dir_all(&path).unwrap();
      Self(path)
    }

    pub(crate) fn path(&self) -> &Path {
      &self.0
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  pub(crate) enum FixtureEntry<'a> {
    File {
      path: &'a str,
      contents: &'a [u8],
      mode: u32,
    },
    Directory(&'a str),
    Symlink {
      path: &'a str,
      target: &'a str,
    },
  }

  /// A gzip tar archive. Paths are written raw, so tests can build archives
  /// the `tar` crate's safe setters would refuse.
  pub(crate) fn archive(entries: &[FixtureEntry<'_>]) -> Vec<u8> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
      Vec::new(),
      flate2::Compression::fast(),
    ));
    for entry in entries {
      match *entry {
        FixtureEntry::File {
          path,
          contents,
          mode,
        } => append(
          &mut builder,
          path,
          tar::EntryType::Regular,
          mode,
          contents,
          None,
        ),
        FixtureEntry::Directory(path) => {
          append(
            &mut builder,
            path,
            tar::EntryType::Directory,
            0o755,
            &[],
            None,
          );
        }
        FixtureEntry::Symlink { path, target } => append(
          &mut builder,
          path,
          tar::EntryType::Symlink,
          0o777,
          &[],
          Some(target),
        ),
      }
    }
    builder.into_inner().unwrap().finish().unwrap()
  }

  fn append(
    builder: &mut tar::Builder<flate2::write::GzEncoder<Vec<u8>>>,
    path: &str,
    kind: tar::EntryType,
    mode: u32,
    contents: &[u8],
    link: Option<&str>,
  ) {
    let mut header = tar::Header::new_gnu();
    if let Some(link) = link {
      header.set_link_name(link).unwrap();
    }
    header.set_entry_type(kind);
    header.set_mode(mode);
    header.set_size(contents.len() as u64);
    let name = &mut header.as_old_mut().name;
    name.fill(0);
    name[..path.len()].copy_from_slice(path.as_bytes());
    header.set_cksum();
    builder.append(&header, contents).unwrap();
  }

  fn unpack_bytes(bytes: &[u8]) -> (TempDir, Result<(), UnpackError>) {
    let dir = TempDir::new();
    let archive = dir.path().join("archive.tar.gz");
    fs::write(&archive, bytes).unwrap();
    let destination = dir.path().join("runtime");
    fs::create_dir(&destination).unwrap();
    let (_cancel, receiver) = watch::channel(false);
    let result = unpack(&archive, &destination, &receiver);
    (dir, result)
  }

  #[test]
  fn files_and_directories_unpack_with_normalised_modes() {
    let (dir, result) = unpack_bytes(&archive(&[
      FixtureEntry::Directory("bin/"),
      FixtureEntry::File {
        path: "bin/tool",
        contents: b"#!/bin/sh\n",
        mode: 0o777,
      },
      FixtureEntry::File {
        path: "share/notes.txt",
        contents: b"notes",
        mode: 0o666,
      },
    ]));
    result.unwrap();
    let runtime = dir.path().join("runtime");
    assert_eq!(fs::read(runtime.join("bin/tool")).unwrap(), b"#!/bin/sh\n");
    assert_eq!(fs::read(runtime.join("share/notes.txt")).unwrap(), b"notes");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let mode = |path: &str| {
        fs::metadata(runtime.join(path))
          .unwrap()
          .permissions()
          .mode()
          & 0o777
      };
      assert_eq!(mode("bin/tool"), 0o755);
      assert_eq!(mode("share/notes.txt"), 0o644);
    }
  }

  #[test]
  fn links_escapes_and_repeated_paths_are_rejected() {
    let file = |path| FixtureEntry::File {
      path,
      contents: b"x",
      mode: 0o644,
    };
    for entries in [
      vec![FixtureEntry::Symlink {
        path: "bin/tool",
        target: "/etc/passwd",
      }],
      vec![file("../escape")],
      vec![file("/absolute")],
      vec![file("bin/../../escape")],
      vec![file("C:/drive")],
      vec![file("bin\\tool")],
      vec![file("./bin/tool")],
      vec![file("bin/tool"), file("bin/tool")],
    ] {
      let (dir, result) = unpack_bytes(&archive(&entries));
      assert_eq!(result, Err(UnpackError::Rejected));
      assert!(!dir.path().join("escape").exists());
    }
  }

  #[test]
  fn a_corrupt_archive_is_rejected() {
    let mut bytes = archive(&[FixtureEntry::File {
      path: "bin/tool",
      contents: &[7; 4096],
      mode: 0o755,
    }]);
    bytes.truncate(bytes.len() / 2);
    assert_eq!(unpack_bytes(&bytes).1, Err(UnpackError::Rejected));
    assert_eq!(
      unpack_bytes(b"not an archive").1,
      Err(UnpackError::Rejected)
    );
  }
}
