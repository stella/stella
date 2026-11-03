//! Where a holder listens; the desktop decides, and the holder takes the
//! path it is given.
//!
//! On Unix the socket lives in a short per-user runtime folder, not in the
//! holder's app data folder: a socket path must fit `sun_path` (104 bytes on
//! macOS, 108 on Linux, its NUL included), and an app data path grows with
//! the home folder and the user name. The runtime folder is `$TMPDIR` on
//! macOS (per user, 0700, cleared on reboot like the holder itself) and
//! `$XDG_RUNTIME_DIR` elsewhere; when that is unset or not private,
//! `/tmp/stella-<uid>`, created 0700. A folder that is another user's, open
//! to group or others, or a symlink is refused, and so is a path that does
//! not fit: there is no shortened or truncated fallback.
//!
//! On Windows the endpoint is a named pipe derived from the holder's folder.
//!
//! Finding a running holder must not depend on the environment matching the
//! launch that started it, so the holder records its endpoint next to its
//! secret (`<holder folder>/endpoint`). The desktop tries that path first,
//! after the same checks as a fresh one, and computes a fresh path only when
//! no recorded endpoint answers.

use std::ffi::OsString;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

/// The file a holder records its endpoint in, beside its secret.
pub(super) const ENDPOINT_FILE: &str = "endpoint";

/// `sun_path` bytes, its terminating NUL included.
#[cfg(target_os = "linux")]
pub(super) const SUN_PATH_BYTES: usize = 108;
#[cfg(not(target_os = "linux"))]
pub(super) const SUN_PATH_BYTES: usize = 104;

/// Longest pipe name Windows accepts.
#[cfg(windows)]
const MAX_PIPE_NAME_CHARS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EndpointError {
  /// The path does not fit: `bytes` long, at most `limit` allowed.
  TooLong { bytes: usize, limit: usize },
  /// The socket folder is another user's, a symlink, or open to group or
  /// others.
  Insecure,
  /// The folder could not be created or read.
  Unavailable(std::io::ErrorKind),
}

impl From<std::io::Error> for EndpointError {
  fn from(error: std::io::Error) -> Self {
    Self::Unavailable(error.kind())
  }
}

/// Where holder endpoints go, resolved once per supervisor.
#[derive(Debug, Clone)]
pub(super) struct Endpoints {
  #[cfg(unix)]
  uid: u32,
  /// The folder fresh sockets go in; an error leaves only recorded ones.
  #[cfg(unix)]
  fresh: Result<PathBuf, EndpointError>,
}

impl Endpoints {
  /// The user's runtime folder, or `socket_dir` when the settings name one;
  /// either must be private to the user.
  pub(super) fn resolve(
    holder_root: &Path,
    socket_dir: Option<&Path>,
  ) -> Result<Self, EndpointError> {
    #[cfg(unix)]
    {
      let uid = own_uid(holder_root)?;
      let fresh = match socket_dir {
        Some(dir) => checked(dir, uid).map(|()| dir.to_path_buf()),
        None => runtime_dir(user_runtime_dir().as_deref(), Path::new("/tmp"), uid),
      };
      Ok(Self { uid, fresh })
    }
    #[cfg(windows)]
    {
      let _unused = socket_dir;
      std::fs::create_dir_all(holder_root)?;
      Ok(Self {})
    }
  }

  /// The endpoint the holder of `holder_dir` recorded, when it passes the
  /// checks a fresh one must pass.
  pub(super) fn recorded(&self, holder_dir: &Path) -> Option<OsString> {
    let text = std::fs::read_to_string(holder_dir.join(ENDPOINT_FILE)).ok()?;
    #[cfg(unix)]
    let usable = usable_socket(Path::new(&text), self.uid);
    #[cfg(windows)]
    let usable = usable_pipe(&text);
    match usable {
      Ok(()) => Some(OsString::from(text)),
      Err(error) => {
        tracing::warn!(target: super::LOG_TARGET, ?error, "ignored a recorded harness holder endpoint");
        None
      }
    }
  }

  /// A fresh endpoint for the holder whose folder is `holder_dir`.
  pub(super) fn fresh(&self, holder_dir: &Path) -> Result<OsString, EndpointError> {
    #[cfg(unix)]
    {
      let version = holder_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
      let dir = self.fresh.as_ref().map_err(|error| *error)?;
      socket_path(dir, &version).map(PathBuf::into_os_string)
    }
    #[cfg(windows)]
    {
      use sha2::{Digest, Sha256};
      let digest = Sha256::digest(holder_dir.as_os_str().as_encoded_bytes());
      let name = format!(
        r"\\.\pipe\stella-agent-holder-{}",
        hex::encode(&digest[..16])
      );
      usable_pipe(&name)?;
      Ok(OsString::from(name))
    }
  }
}

#[cfg(windows)]
fn usable_pipe(name: &str) -> Result<(), EndpointError> {
  if !name.starts_with(r"\\.\pipe\stella-agent-holder-") {
    return Err(EndpointError::Insecure);
  }
  if name.len() > MAX_PIPE_NAME_CHARS {
    return Err(EndpointError::TooLong {
      bytes: name.len(),
      limit: MAX_PIPE_NAME_CHARS,
    });
  }
  Ok(())
}

/// The socket of a sidecar version in `dir`, or why it cannot be one.
#[cfg(unix)]
pub(super) fn socket_path(dir: &Path, version: &str) -> Result<PathBuf, EndpointError> {
  let path = dir.join(format!("stella-holder-{version}.sock"));
  fits(&path)?;
  Ok(path)
}

/// Whether a socket path fits `sun_path`.
#[cfg(unix)]
fn fits(path: &Path) -> Result<(), EndpointError> {
  let bytes = path.as_os_str().len();
  let limit = SUN_PATH_BYTES - 1;
  if bytes > limit {
    return Err(EndpointError::TooLong { bytes, limit });
  }
  Ok(())
}

/// A recorded socket path: it fits, and its folder is private to `uid`.
#[cfg(unix)]
pub(super) fn usable_socket(path: &Path, uid: u32) -> Result<(), EndpointError> {
  fits(path)?;
  if !path.is_absolute() {
    return Err(EndpointError::Insecure);
  }
  checked(path.parent().ok_or(EndpointError::Insecure)?, uid)
}

#[cfg(unix)]
fn user_runtime_dir() -> Option<PathBuf> {
  #[cfg(target_os = "macos")]
  let variable = "TMPDIR";
  #[cfg(not(target_os = "macos"))]
  let variable = "XDG_RUNTIME_DIR";
  std::env::var_os(variable)
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
}

/// The preferred folder when it is private to `uid`, else
/// `<fallback_base>/stella-<uid>`, created 0700 and checked the same way.
#[cfg(unix)]
pub(super) fn runtime_dir(
  preferred: Option<&Path>,
  fallback_base: &Path,
  uid: u32,
) -> Result<PathBuf, EndpointError> {
  use std::os::unix::fs::DirBuilderExt;
  if let Some(dir) = preferred.filter(|dir| checked(dir, uid).is_ok()) {
    return Ok(dir.to_path_buf());
  }
  let fallback = fallback_base.join(format!("stella-{uid}"));
  match std::fs::DirBuilder::new().mode(0o700).create(&fallback) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
    Err(error) => return Err(error.into()),
  }
  checked(&fallback, uid)?;
  Ok(fallback)
}

/// A real folder (not a symlink) owned by `uid` and closed to group and
/// others.
#[cfg(unix)]
pub(super) fn checked(dir: &Path, uid: u32) -> Result<(), EndpointError> {
  use std::os::unix::fs::MetadataExt;
  let metadata = std::fs::symlink_metadata(dir)?;
  if metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o077 == 0 {
    Ok(())
  } else {
    Err(EndpointError::Insecure)
  }
}

/// This process's user: the owner of a file it just created, which needs no
/// `unsafe` system call.
#[cfg(unix)]
pub(super) fn own_uid(scratch: &Path) -> Result<u32, EndpointError> {
  use std::os::unix::fs::{DirBuilderExt, MetadataExt};
  std::fs::DirBuilder::new()
    .recursive(true)
    .mode(0o700)
    .create(scratch)?;
  let probe = scratch.join(format!(".uid-{}", uuid::Uuid::new_v4().simple()));
  let created = std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&probe)
    .and_then(|file| file.metadata());
  let _removed = std::fs::remove_file(&probe);
  Ok(created?.uid())
}

#[cfg(all(test, unix))]
mod tests {
  use std::fs;
  use std::os::unix::fs::PermissionsExt;

  use super::*;

  struct Scratch(PathBuf);

  impl Scratch {
    fn new() -> Self {
      let id = uuid::Uuid::new_v4().simple().to_string();
      let path = std::env::temp_dir().join(format!("se-{}", &id[..8]));
      fs::create_dir_all(&path).unwrap();
      fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
      Self(path)
    }

    fn dir(&self, name: &str, mode: u32) -> PathBuf {
      let dir = self.0.join(name);
      fs::create_dir_all(&dir).unwrap();
      fs::set_permissions(&dir, fs::Permissions::from_mode(mode)).unwrap();
      dir
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _removed = fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn a_socket_path_fits_sun_path_or_is_refused() {
    let name_bytes = "/stella-holder-1.4.0.sock".len();
    let limit = SUN_PATH_BYTES - 1;
    let fits = PathBuf::from(format!("/{}", "a".repeat(limit - name_bytes - 1)));
    let path = socket_path(&fits, "1.4.0").unwrap();
    assert_eq!(path.as_os_str().len(), limit);
    let over = PathBuf::from(format!("/{}", "a".repeat(limit - name_bytes)));
    assert_eq!(
      socket_path(&over, "1.4.0"),
      Err(EndpointError::TooLong {
        bytes: SUN_PATH_BYTES,
        limit
      })
    );
  }

  #[test]
  fn a_long_home_folder_does_not_reach_the_socket_path() {
    let home = format!("/Users/{}", "a-long-user-name".repeat(3));
    let holder_dir = PathBuf::from(format!(
      "{home}/Library/Application Support/legal.stella.desktop/agent-holder/10.20.30"
    ));
    // The app data folder itself would not fit.
    assert!(matches!(
      socket_path(holder_dir.parent().unwrap(), "10.20.30"),
      Err(EndpointError::TooLong { .. })
    ));
    let endpoints = Endpoints {
      uid: 0,
      fresh: Ok(PathBuf::from(
        "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/",
      )),
    };
    let endpoint = PathBuf::from(endpoints.fresh(&holder_dir).unwrap());
    assert_eq!(
      endpoint,
      PathBuf::from(
        "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/stella-holder-10.20.30.sock"
      )
    );
  }

  #[test]
  fn a_private_runtime_folder_is_used_as_it_is() {
    let scratch = Scratch::new();
    let uid = own_uid(&scratch.0).unwrap();
    let preferred = scratch.dir("runtime", 0o700);
    assert_eq!(
      runtime_dir(Some(&preferred), &scratch.0, uid),
      Ok(preferred)
    );
  }

  #[test]
  fn a_runtime_folder_others_can_reach_falls_back_to_a_private_one() {
    let scratch = Scratch::new();
    let uid = own_uid(&scratch.0).unwrap();
    let open = scratch.dir("runtime", 0o755);
    let fallback = runtime_dir(Some(&open), &scratch.0, uid).unwrap();
    assert_eq!(fallback, scratch.0.join(format!("stella-{uid}")));
    assert_eq!(
      fs::metadata(&fallback).unwrap().permissions().mode() & 0o777,
      0o700
    );
  }

  #[test]
  fn a_fallback_folder_that_is_not_private_is_refused() {
    let scratch = Scratch::new();
    let uid = own_uid(&scratch.0).unwrap();
    scratch.dir(&format!("stella-{uid}"), 0o755);
    assert_eq!(
      runtime_dir(None, &scratch.0, uid),
      Err(EndpointError::Insecure)
    );
  }

  #[test]
  fn a_folder_of_another_user_is_refused() {
    let scratch = Scratch::new();
    let uid = own_uid(&scratch.0).unwrap();
    let private = scratch.dir("runtime", 0o700);
    assert_eq!(checked(&private, uid), Ok(()));
    assert_eq!(
      checked(&private, uid.wrapping_add(1)),
      Err(EndpointError::Insecure)
    );
    assert_eq!(
      runtime_dir(None, &scratch.0, uid.wrapping_add(1)),
      Err(EndpointError::Insecure)
    );
  }

  #[test]
  fn a_recorded_endpoint_passes_the_checks_of_a_fresh_one_or_is_ignored() {
    let scratch = Scratch::new();
    let uid = own_uid(&scratch.0).unwrap();
    let holder_dir = scratch.dir("1.4.0", 0o700);
    let endpoints = Endpoints {
      uid,
      fresh: Err(EndpointError::Insecure),
    };
    let record = |path: &Path| {
      fs::write(
        holder_dir.join(ENDPOINT_FILE),
        path.as_os_str().as_encoded_bytes(),
      )
      .unwrap();
    };
    assert_eq!(endpoints.recorded(&holder_dir), None, "nothing recorded");

    let private = socket_path(&scratch.dir("private", 0o700), "1.4.0").unwrap();
    record(&private);
    assert_eq!(
      endpoints.recorded(&holder_dir),
      Some(private.into_os_string())
    );

    let shared = scratch
      .dir("shared", 0o755)
      .join("stella-holder-1.4.0.sock");
    record(&shared);
    assert_eq!(endpoints.recorded(&holder_dir), None);
    assert_eq!(usable_socket(&shared, uid), Err(EndpointError::Insecure));

    let long = scratch
      .dir(&"d".repeat(SUN_PATH_BYTES), 0o700)
      .join("stella-holder-1.4.0.sock");
    record(&long);
    assert_eq!(endpoints.recorded(&holder_dir), None);
    assert!(matches!(
      usable_socket(&long, uid),
      Err(EndpointError::TooLong { .. })
    ));

    record(Path::new("relative/stella-holder-1.4.0.sock"));
    assert_eq!(endpoints.recorded(&holder_dir), None);
  }

  #[test]
  fn a_symlinked_fallback_folder_is_refused() {
    let scratch = Scratch::new();
    let uid = own_uid(&scratch.0).unwrap();
    let target = scratch.dir("elsewhere", 0o700);
    std::os::unix::fs::symlink(&target, scratch.0.join(format!("stella-{uid}")))
      .unwrap();
    assert_eq!(
      runtime_dir(None, &scratch.0, uid),
      Err(EndpointError::Insecure)
    );
  }
}
