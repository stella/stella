//! Persistent, size-capped log file.
//!
//! The app is usually started by its login item, so stderr goes nowhere.
//! Every tracing event is therefore also appended to
//! `<app data>/logs/desktop.log`, rotated once to `desktop.log.1` when it
//! exceeds the cap, so a report from a user carries recent history. The
//! folder is the one the tray's "Reveal app data" item opens.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

use crate::config::APP_DATA_DIR_NAME;

const LOG_DIR_NAME: &str = "logs";
const LOG_FILE_NAME: &str = "desktop.log";
const ROTATED_LOG_FILE_NAME: &str = "desktop.log.1";
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

pub fn init() {
  let filter =
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
  let stderr = fmt::layer().with_writer(io::stderr);
  let registry = tracing_subscriber::registry().with(filter).with(stderr);

  match log_dir().and_then(|dir| RollingLog::open(&dir, MAX_LOG_BYTES)) {
    Ok(log) => {
      let path = log.path.clone();
      registry
        .with(fmt::layer().with_ansi(false).with_writer(Mutex::new(log)))
        .init();
      tracing::info!(
        path = %path.display(),
        version = env!("CARGO_PKG_VERSION"),
        "desktop log file opened"
      );
    }
    Err(error) => {
      registry.init();
      tracing::warn!(error = %error, "desktop log file unavailable, stderr only");
    }
  }
}

fn log_dir() -> io::Result<PathBuf> {
  let data_dir = dirs::data_dir()
    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no data directory"))?;
  Ok(data_dir.join(APP_DATA_DIR_NAME).join(LOG_DIR_NAME))
}

struct RollingLog {
  dir: PathBuf,
  path: PathBuf,
  file: File,
  written: u64,
  max_bytes: u64,
}

impl RollingLog {
  fn open(dir: &Path, max_bytes: u64) -> io::Result<Self> {
    fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE_NAME);
    let file = open_append(&path)?;
    let written = file.metadata()?.len();
    Ok(Self {
      dir: dir.to_path_buf(),
      path,
      file,
      written,
      max_bytes,
    })
  }

  fn rotate(&mut self) -> io::Result<()> {
    self.file.flush()?;
    let rotated = self.dir.join(ROTATED_LOG_FILE_NAME);
    // Windows refuses to rename over an existing file.
    if rotated.exists() {
      fs::remove_file(&rotated)?;
    }
    fs::rename(&self.path, &rotated)?;
    self.file = open_append(&self.path)?;
    self.written = 0;
    Ok(())
  }
}

impl Write for RollingLog {
  fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
    if self.written > 0 && self.written + buf.len() as u64 > self.max_bytes {
      self.rotate()?;
    }
    let written = self.file.write(buf)?;
    self.written += written as u64;
    Ok(written)
  }

  fn flush(&mut self) -> io::Result<()> {
    self.file.flush()
  }
}

// Log lines can name documents and accounts, so the file is private to
// the user like the rest of the app data.
fn open_append(path: &Path) -> io::Result<File> {
  let mut options = OpenOptions::new();
  options.create(true).append(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  options.open(path)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn unique_dir() -> PathBuf {
    std::env::temp_dir().join(format!(
      "stella-desktop-log-{}-{}",
      std::process::id(),
      uuid::Uuid::new_v4()
    ))
  }

  #[test]
  fn rotates_once_past_the_cap_and_keeps_one_previous_file() {
    let dir = unique_dir();
    let mut log = RollingLog::open(&dir, 64).unwrap();
    let line = [b'x'; 20];
    let file_len = |name: &str| fs::metadata(dir.join(name)).unwrap().len();

    for _ in 0..3 {
      log.write_all(&line).unwrap();
    }
    assert!(!dir.join(ROTATED_LOG_FILE_NAME).exists());
    assert_eq!(file_len(LOG_FILE_NAME), 60);

    // The fourth line would exceed the cap: the full file becomes the
    // single previous file and the line starts a fresh one.
    log.write_all(&line).unwrap();
    assert_eq!(file_len(ROTATED_LOG_FILE_NAME), 60);
    assert_eq!(file_len(LOG_FILE_NAME), 20);

    // A later rotation replaces the previous file instead of adding one.
    for _ in 0..3 {
      log.write_all(&line).unwrap();
    }
    assert_eq!(file_len(ROTATED_LOG_FILE_NAME), 60);
    assert_eq!(file_len(LOG_FILE_NAME), 20);
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);

    fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn reopening_counts_existing_content_toward_the_cap() {
    let dir = unique_dir();
    {
      let mut log = RollingLog::open(&dir, 64).unwrap();
      log.write_all(&[b'x'; 40]).unwrap();
    }
    let mut log = RollingLog::open(&dir, 64).unwrap();
    assert_eq!(log.written, 40);

    log.write_all(&[b'y'; 40]).unwrap();
    assert_eq!(
      fs::read(dir.join(ROTATED_LOG_FILE_NAME)).unwrap(),
      [b'x'; 40]
    );
    assert_eq!(fs::read(dir.join(LOG_FILE_NAME)).unwrap(), [b'y'; 40]);

    fs::remove_dir_all(dir).unwrap();
  }

  #[cfg(unix)]
  #[test]
  fn log_file_is_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt;

    let dir = unique_dir();
    let _log = RollingLog::open(&dir, 64).unwrap();
    let mode = fs::metadata(dir.join(LOG_FILE_NAME))
      .unwrap()
      .permissions()
      .mode();
    assert_eq!(mode & 0o777, 0o600);

    fs::remove_dir_all(dir).unwrap();
  }
}
