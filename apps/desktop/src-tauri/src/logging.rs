//! Persistent, size-capped log file.
//!
//! The app is usually started by its login item, so stderr goes nowhere.
//! Every tracing event is therefore also appended to
//! `<app data>/logs/desktop.log`, rotated once to `desktop.log.1` when it
//! exceeds the cap, so a report from a user carries recent history. The
//! folder is the one the tray's "Reveal app data" item opens.
//!
//! A second, shareable trail of account and handoff events goes to the
//! platform log directory. It carries levels, event names and codes only:
//! see `TrailLayer`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tracing::field::{Field, Visit};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

use crate::config::APP_DATA_DIR_NAME;

const LOG_DIR_NAME: &str = "logs";
const LOG_FILE_NAME: &str = "desktop.log";
#[cfg(test)]
const ROTATED_LOG_FILE_NAME: &str = "desktop.log.1";
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const DESKTOP_LOG: LogFiles = LogFiles {
  name: LOG_FILE_NAME,
  previous: 1,
  max_bytes: MAX_LOG_BYTES,
};
const TRAIL_LOG: LogFiles = LogFiles {
  name: "desktop-trail.log",
  previous: 4,
  max_bytes: 1024 * 1024,
};

/// Events for the trail log use this target, e.g.
/// `tracing::info!(target: TRAIL_TARGET, event = "handoff.parked")`.
pub const TRAIL_TARGET: &str = "desktop_trail";
/// The only fields the trail writes. Values are codes, never free text.
const TRAIL_FIELDS: [&str; 4] = ["event", "code", "status", "target_kind"];
const MAX_TRAIL_VALUE_CHARS: usize = 64;

/// A file and how many rotated copies of it are kept.
#[derive(Clone, Copy)]
struct LogFiles {
  name: &'static str,
  previous: usize,
  max_bytes: u64,
}

pub fn init() {
  let filter =
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
  let stderr = fmt::layer().with_writer(io::stderr);
  let trail = trail_dir()
    .and_then(|dir| RollingLog::open(&dir, TRAIL_LOG))
    .map(TrailLayer::new);
  let trail_error = trail.as_ref().err().map(ToString::to_string);
  let registry = tracing_subscriber::registry()
    .with(trail.ok())
    .with(filter)
    .with(stderr);

  match log_dir().and_then(|dir| RollingLog::open(&dir, DESKTOP_LOG)) {
    Ok(log) => {
      registry
        .with(fmt::layer().with_ansi(false).with_writer(Mutex::new(log)))
        .init();
      // The file is meant to be shared, so its own path (which carries the
      // account name) stays out of it.
      tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        "desktop log file opened"
      );
    }
    Err(error) => {
      registry.init();
      tracing::warn!(error = %error, "desktop log file unavailable, stderr only");
    }
  }
  if let Some(error) = trail_error {
    tracing::warn!(error = %error, "desktop trail log unavailable");
  }
}

/// The platform's per-user log directory for this app.
fn trail_dir() -> io::Result<PathBuf> {
  let missing = || io::Error::new(io::ErrorKind::NotFound, "no log directory");
  #[cfg(target_os = "macos")]
  let dir = dirs::home_dir()
    .ok_or_else(missing)?
    .join("Library/Logs")
    .join(APP_DATA_DIR_NAME);
  #[cfg(not(target_os = "macos"))]
  let dir = dirs::state_dir()
    .or_else(dirs::data_local_dir)
    .ok_or_else(missing)?
    .join(APP_DATA_DIR_NAME)
    .join(LOG_DIR_NAME);
  Ok(dir)
}

/// Writes trail events as `<time> <LEVEL> field=value ...`. Only the fields in
/// `TRAIL_FIELDS` are written, and only when their value is a short code, so
/// keys, tokens, emails, document names, URLs and free-text messages cannot
/// reach the file whatever an event carries.
struct TrailLayer<W> {
  writer: Mutex<W>,
}

impl<W: Write> TrailLayer<W> {
  fn new(writer: W) -> Self {
    Self {
      writer: Mutex::new(writer),
    }
  }
}

#[derive(Default)]
struct TrailFields(Vec<(&'static str, String)>);

impl TrailFields {
  fn keep(&mut self, field: &Field, value: String) {
    let allowed = TRAIL_FIELDS.contains(&field.name())
      && !value.is_empty()
      && value.chars().count() <= MAX_TRAIL_VALUE_CHARS
      && value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'));
    if allowed {
      self.0.push((field.name(), value));
    }
  }
}

impl Visit for TrailFields {
  fn record_str(&mut self, field: &Field, value: &str) {
    self.keep(field, value.to_string());
  }
  fn record_u64(&mut self, field: &Field, value: u64) {
    self.keep(field, value.to_string());
  }
  fn record_i64(&mut self, field: &Field, value: i64) {
    self.keep(field, value.to_string());
  }
  fn record_bool(&mut self, field: &Field, value: bool) {
    self.keep(field, value.to_string());
  }
  fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
    self.keep(field, format!("{value:?}"));
  }
}

impl<S, W> Layer<S> for TrailLayer<W>
where
  S: tracing::Subscriber,
  W: Write + Send + 'static,
{
  fn on_event(
    &self,
    event: &tracing::Event<'_>,
    _: tracing_subscriber::layer::Context<'_, S>,
  ) {
    if event.metadata().target() != TRAIL_TARGET {
      return;
    }
    let mut fields = TrailFields::default();
    event.record(&mut fields);
    let mut line = format!(
      "{} {}",
      chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
      event.metadata().level()
    );
    for (name, value) in fields.0 {
      line.push(' ');
      line.push_str(name);
      line.push('=');
      line.push_str(&value);
    }
    line.push('\n');
    if let Ok(mut writer) = self.writer.lock() {
      let _ = writer.write_all(line.as_bytes());
      let _ = writer.flush();
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
  files: LogFiles,
}

impl RollingLog {
  fn open(dir: &Path, files: LogFiles) -> io::Result<Self> {
    fs::create_dir_all(dir)?;
    let path = dir.join(files.name);
    let file = open_append(&path)?;
    let written = file.metadata()?.len();
    Ok(Self {
      dir: dir.to_path_buf(),
      path,
      file,
      written,
      files,
    })
  }

  fn rotated(&self, generation: usize) -> PathBuf {
    self.dir.join(format!("{}.{generation}", self.files.name))
  }

  fn rotate(&mut self) -> io::Result<()> {
    self.file.flush()?;
    // Shift `.1` to `.2` and so on; the oldest copy falls off. Windows
    // refuses to rename over an existing file.
    for generation in (1..=self.files.previous).rev() {
      let from = if generation == 1 {
        self.path.clone()
      } else {
        self.rotated(generation - 1)
      };
      let to = self.rotated(generation);
      if to.exists() {
        fs::remove_file(&to)?;
      }
      if from.exists() {
        fs::rename(&from, &to)?;
      }
    }
    self.file = open_append(&self.path)?;
    self.written = 0;
    Ok(())
  }
}

impl Write for RollingLog {
  fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
    let max_bytes = self.files.max_bytes;
    if self.written > 0 && self.written + buf.len() as u64 > max_bytes {
      self.rotate()?;
    }
    // A single line larger than the cap is cut: the disk bound wins over
    // the completeness of one event.
    let allowed =
      usize::try_from(max_bytes).map_or(buf.len(), |max| buf.len().min(max));
    let written = self.file.write(&buf[..allowed])?;
    self.written += written as u64;
    Ok(if written == allowed {
      buf.len()
    } else {
      written
    })
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

/// Logs `cause` as the reason for `what`. Only for causes whose text carries
/// no credentials or personal data; see [`log_json_error`] and
/// [`log_request_error`] for the ones that can.
pub fn log_cause(cause: &impl std::fmt::Display, what: &'static str) {
  tracing::warn!(cause = %cause, "{what}");
}

/// Replaces an error with a fixed message for the caller and keeps the cause
/// in the local log, under the same rule as [`log_cause`].
pub fn with_cause_logged<E: std::fmt::Display>(
  message: &'static str,
) -> impl FnOnce(E) -> String {
  move |cause| {
    log_cause(&cause, message);
    message.to_string()
  }
}

/// Replaces an error with `replacement`, such as a failure kind the caller
/// matches on, and keeps the cause in the local log as [`log_cause`] does.
pub fn replaced_logged<E: std::fmt::Display, T>(
  what: &'static str,
  replacement: T,
) -> impl FnOnce(E) -> T {
  move |cause| {
    log_cause(&cause, what);
    replacement
  }
}

/// serde repeats input values in its messages, and the inputs here include
/// credentials and client data: only the category and position are logged.
pub fn log_json_error(error: &serde_json::Error, what: &'static str) {
  tracing::warn!(
    category = ?error.classify(),
    line = error.line(),
    column = error.column(),
    "{what}"
  );
}

/// reqwest names the URL in its messages, which can carry search terms and
/// identifiers: only the kind of failure and the status are logged.
pub fn log_request_error(error: &reqwest::Error, what: &'static str) {
  tracing::warn!(
    timeout = error.is_timeout(),
    connect = error.is_connect(),
    decode = error.is_decode(),
    status = error.status().map(|status| status.as_u16()),
    "{what}"
  );
}

/// [`with_cause_logged`] for a JSON error, logged as [`log_json_error`] does.
pub fn json_cause_logged(
  message: &'static str,
) -> impl FnOnce(serde_json::Error) -> String {
  move |error| {
    log_json_error(&error, message);
    message.to_string()
  }
}

/// [`with_cause_logged`] for an HTTP error, logged as [`log_request_error`]
/// does.
pub fn request_cause_logged(
  message: &'static str,
) -> impl FnOnce(reqwest::Error) -> String {
  move |error| {
    log_request_error(&error, message);
    message.to_string()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const TEST_LOG: LogFiles = LogFiles {
    max_bytes: 64,
    ..DESKTOP_LOG
  };

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
    let mut log = RollingLog::open(&dir, TEST_LOG).unwrap();
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
      let mut log = RollingLog::open(&dir, TEST_LOG).unwrap();
      log.write_all(&[b'x'; 40]).unwrap();
    }
    let mut log = RollingLog::open(&dir, TEST_LOG).unwrap();
    assert_eq!(log.written, 40);

    log.write_all(&[b'y'; 40]).unwrap();
    assert_eq!(
      fs::read(dir.join(ROTATED_LOG_FILE_NAME)).unwrap(),
      [b'x'; 40]
    );
    assert_eq!(fs::read(dir.join(LOG_FILE_NAME)).unwrap(), [b'y'; 40]);

    fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_single_oversized_line_is_cut_at_the_cap() {
    let dir = unique_dir();
    let mut log = RollingLog::open(&dir, TEST_LOG).unwrap();
    let file_len = |name: &str| fs::metadata(dir.join(name)).unwrap().len();

    log.write_all(&[b'x'; 100]).unwrap();
    assert_eq!(file_len(LOG_FILE_NAME), 64);
    assert!(!dir.join(ROTATED_LOG_FILE_NAME).exists());

    log.write_all(&[b'y'; 100]).unwrap();
    assert_eq!(file_len(ROTATED_LOG_FILE_NAME), 64);
    assert_eq!(file_len(LOG_FILE_NAME), 64);

    fs::remove_dir_all(dir).unwrap();
  }

  #[cfg(unix)]
  #[test]
  fn log_file_is_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt;

    let dir = unique_dir();
    let _log = RollingLog::open(&dir, TEST_LOG).unwrap();
    let mode = fs::metadata(dir.join(LOG_FILE_NAME))
      .unwrap()
      .permissions()
      .mode();
    assert_eq!(mode & 0o777, 0o600);

    fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn the_trail_keeps_its_rotated_copies_bounded() {
    let dir = unique_dir();
    let files = LogFiles {
      max_bytes: 10,
      ..TRAIL_LOG
    };
    let mut log = RollingLog::open(&dir, files).unwrap();
    for _ in 0..20 {
      log.write_all(&[b'x'; 10]).unwrap();
    }
    assert_eq!(fs::read_dir(&dir).unwrap().count(), TRAIL_LOG.previous + 1);
    fs::remove_dir_all(dir).unwrap();
  }

  #[derive(Clone, Default)]
  struct Captured(std::sync::Arc<Mutex<Vec<u8>>>);
  impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
      self.0.lock().unwrap().extend_from_slice(buf);
      Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
      Ok(())
    }
  }

  #[test]
  fn the_trail_never_records_secrets_or_personal_data() {
    let private_path = std::env::temp_dir().join("trail-private-file");
    let private_path = private_path.to_string_lossy();
    let captured = Captured::default();
    let subscriber =
      tracing_subscriber::registry().with(TrailLayer::new(captured.clone()));
    tracing::subscriber::with_default(subscriber, || {
      tracing::warn!(
        target: TRAIL_TARGET,
        event = "handoff.failed",
        code = "dialog.handoffAccountMismatch",
        status = 403_u16,
        target_kind = ?crate::handoff::Target::PdfSigning,
        key = "stella_dr_secret",
        token = "handoff-fixture",
        email = "lawyer@example.test",
        document_name = "Contract.pdf",
        api_base_url = "https://api.example.test",
        clipboard = "copied text",
        path = %private_path,
        error = "Desktop account lawyer@example.test was rejected",
        "free text naming Contract.pdf"
      );
      // A permitted field still drops a value that is not a plain code.
      tracing::info!(target: TRAIL_TARGET, event = "account.linked", code = "lawyer@example.test");
      tracing::info!(event = "not.a.trail.event", code = "elsewhere");
    });
    let written = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    let lines: Vec<&str> = written.lines().collect();
    assert_eq!(lines.len(), 2, "{written}");
    assert!(lines[0].ends_with(
      " WARN event=handoff.failed code=dialog.handoffAccountMismatch status=403 target_kind=PdfSigning"
    ), "{written}");
    assert!(
      lines[1].ends_with(" INFO event=account.linked"),
      "{written}"
    );
    for denied in [
      "stella_dr_secret",
      "handoff-fixture",
      "lawyer@example.test",
      "Contract.pdf",
      "api.example.test",
      "copied text",
      private_path.as_ref(),
      "rejected",
      "free text",
      "key=",
      "token=",
      "email=",
      "error=",
      "message=",
      "elsewhere",
    ] {
      assert!(
        !written.contains(denied),
        "trail recorded {denied:?}: {written}"
      );
    }
  }
}
