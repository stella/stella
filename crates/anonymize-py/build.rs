pub mod build_support;

use std::env;
use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use build_support::{copy_generated_file, report_missing_native_packages};

const NATIVE_PACKAGE_SCOPED_PREFIX: &str = "native-pipeline.";
const NATIVE_PACKAGE_SUFFIX: &str = ".stlanonpkg";
const DEFAULT_NATIVE_PACKAGE: &str = "native-pipeline.stlanonpkg";
const DEFAULT_PIPELINE_INPUT: &str = "default-pipeline-input.json.gz";
const PIPELINE_LANGUAGE_SCOPES: &str = "pipeline-language-scopes.json";
// Set by the wheel build (`bun run python:wheel`) so a wheel is never produced
// without the bundled native pipeline packages. Plain `cargo build`/`test` runs
// before the JS build has generated the packages, so those flows only warn.
const REQUIRE_NATIVE_PACKAGES_ENV: &str =
  "STELLA_ANONYMIZE_REQUIRE_NATIVE_PACKAGES";

fn main() -> Result<(), Box<dyn Error>> {
  pyo3_build_config::add_extension_module_link_args();
  copy_generated_native_packages()?;
  Ok(())
}

#[allow(clippy::disallowed_macros)]
fn copy_generated_native_packages() -> io::Result<()> {
  let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
    .map(PathBuf::from)
    .ok_or_else(|| {
      io::Error::new(io::ErrorKind::NotFound, "CARGO_MANIFEST_DIR is unset")
    })?;
  println!("cargo:rerun-if-env-changed={REQUIRE_NATIVE_PACKAGES_ENV}");
  let require_native = native_packages_required();
  let Some(repo_root) = manifest_dir.parent().and_then(Path::parent) else {
    return report_missing_native_packages(
      require_native,
      "unable to locate the repository root for native pipeline packages",
    );
  };
  let source_dir = repo_root.join("packages").join("anonymize");
  println!("cargo:rerun-if-changed={}", source_dir.display());
  if !source_dir.exists() {
    return report_missing_native_packages(
      require_native,
      &format!(
        "native pipeline package source directory is missing: {}",
        source_dir.display()
      ),
    );
  }

  let target_dir = manifest_dir
    .join("python")
    .join("stella_anonymize")
    .join("native_packages");
  fs::create_dir_all(&target_dir)?;
  let mut copied_default = false;
  for entry in fs::read_dir(&source_dir)? {
    let entry = entry?;
    let file_name = entry.file_name();
    let file_name = file_name.to_string_lossy();
    if !is_native_package_name(&file_name) {
      continue;
    }
    if file_name == DEFAULT_NATIVE_PACKAGE {
      copied_default = true;
    }
    fs::copy(entry.path(), target_dir.join(file_name.as_ref()))?;
  }
  if !copied_default {
    return report_missing_native_packages(
      require_native,
      &format!(
        "default native pipeline package `{DEFAULT_NATIVE_PACKAGE}` is missing from {}; run `bun run build` before building the wheel",
        source_dir.display()
      ),
    );
  }
  let default_pipeline_input = source_dir.join(DEFAULT_PIPELINE_INPUT);
  copy_generated_file(
    &default_pipeline_input,
    &target_dir.join(DEFAULT_PIPELINE_INPUT),
    require_native,
    &format!(
      "semantic pipeline input `{DEFAULT_PIPELINE_INPUT}` is missing from {}; run `bun run build` before building the wheel",
      source_dir.display()
    ),
  )?;
  let language_scopes = source_dir
    .join("src")
    .join("data")
    .join("language-scopes.json");
  copy_generated_file(
    &language_scopes,
    &target_dir.join(PIPELINE_LANGUAGE_SCOPES),
    require_native,
    &format!(
      "pipeline language scopes are missing from {}; reinstall the complete source tree",
      language_scopes.display()
    ),
  )?;
  Ok(())
}

fn native_packages_required() -> bool {
  env::var(REQUIRE_NATIVE_PACKAGES_ENV)
    .is_ok_and(|value| !value.is_empty() && value != "0")
}

fn is_native_package_name(file_name: &str) -> bool {
  file_name == DEFAULT_NATIVE_PACKAGE
    || (file_name
      .strip_prefix(NATIVE_PACKAGE_SCOPED_PREFIX)
      .is_some()
      && file_name.ends_with(NATIVE_PACKAGE_SUFFIX))
}
