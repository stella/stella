#[path = "../build_support.rs"]
pub mod build_support;

use std::error::Error;
use std::fs;

use build_support::copy_generated_file;

#[test]
fn optional_missing_source_removes_stale_target() -> Result<(), Box<dyn Error>>
{
  let directory = std::env::temp_dir().join(format!(
    "stella-anonymize-build-support-{}",
    std::process::id()
  ));
  if directory.exists() {
    fs::remove_dir_all(&directory)?;
  }
  fs::create_dir_all(&directory)?;
  let missing_source = directory.join("missing-input.json.gz");
  let stale_target = directory.join("default-pipeline-input.json.gz");
  fs::write(&stale_target, b"stale")?;

  copy_generated_file(
    &missing_source,
    &stale_target,
    false,
    "optional test input is missing",
  )?;

  assert!(!stale_target.exists());
  fs::remove_dir_all(directory)?;
  Ok(())
}
