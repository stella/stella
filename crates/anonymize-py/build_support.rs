use std::fs;
use std::io;
use std::path::Path;

#[allow(clippy::disallowed_macros)]
pub fn copy_generated_file(
  source: &Path,
  target: &Path,
  required: bool,
  missing_message: &str,
) -> io::Result<()> {
  if source.is_file() {
    fs::copy(source, target)?;
    return Ok(());
  }
  if target.exists() {
    fs::remove_file(target)?;
  }
  report_missing_native_packages(required, missing_message)
}

// Cargo build scripts report optional missing artifacts through stdout directives.
#[allow(clippy::disallowed_macros, clippy::print_stdout)]
pub fn report_missing_native_packages(
  require_native: bool,
  message: &str,
) -> io::Result<()> {
  if require_native {
    return Err(io::Error::new(io::ErrorKind::NotFound, message.to_owned()));
  }
  println!("cargo:warning={message}");
  Ok(())
}
