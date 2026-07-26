//! End-to-end digest gate: each reconstructed frozen config, fed through the
//! same prepare/package path the native binding uses, must reproduce the
//! SHA-256 package digest committed in `manifest.json`.
//!
//! `assemble_parity` independently proves that the assembler reproduces every
//! reconstructed [`BindingPreparedSearchConfig`]. This companion test converts
//! that oracle to a core `PreparedEngineConfig`, prepares the artifacts,
//! serializes the uncompressed core package, and hashes the bytes. Together the
//! tests prove byte identity without preparing every package twice. Deliberate
//! behavior changes are refreshed through the independently reviewed frozen
//! manifest documented alongside the fixtures.

pub mod assemble_support;

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use stella_anonymize_adapter_contract::{
  BindingPreparedSearchConfig, prepared_search_config_from_binding,
  prepared_search_core_package_to_bytes,
};
use stella_anonymize_core::PreparedEngine;

use assemble_support::read_expected_value;

#[derive(Deserialize)]
struct Manifest {
  fixtures: Vec<ManifestFixture>,
}

#[derive(Deserialize)]
struct ManifestFixture {
  name: String,
  #[serde(rename = "packageDigest")]
  package_digest: Option<String>,
}

fn fixtures_dir() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/assemble")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
  let text = fs::read_to_string(path)
    .map_err(|error| format!("read {}: {error}", path.display()))?;
  serde_json::from_str(&text)
    .map_err(|error| format!("parse {}: {error}", path.display()))
}

fn frozen_package_digest(
  binding: BindingPreparedSearchConfig,
) -> Result<String, String> {
  let core_config = prepared_search_config_from_binding(binding)
    .map_err(|error| format!("config_from_binding failed: {error}"))?;
  let artifacts = PreparedEngine::prepare_artifacts(core_config.clone())
    .map_err(|error| format!("prepare_artifacts failed: {error}"))?;
  let artifact_bytes = artifacts
    .to_bytes()
    .map_err(|error| format!("artifacts.to_bytes failed: {error}"))?;
  let package =
    prepared_search_core_package_to_bytes(&core_config, &artifact_bytes)
      .map_err(|error| format!("package_to_bytes failed: {error}"))?;

  let mut hasher = Sha256::new();
  hasher.update(&package);
  let digest = hasher.finalize();
  let mut hex = String::new();
  for byte in digest {
    let _ = write!(hex, "{byte:02x}");
  }
  Ok(hex)
}

#[test]
fn assemble_package_digests_match_manifest() -> Result<(), String> {
  let dir = fixtures_dir();
  let manifest: Manifest = read_json(&dir.join("manifest.json"))?;

  let mut failures = Vec::new();
  let mut checked = 0usize;
  for fixture in &manifest.fixtures {
    let Some(expected) = fixture.package_digest.as_ref() else {
      failures.push(format!("{}: manifest digest is null", fixture.name));
      continue;
    };
    let expected_binding: BindingPreparedSearchConfig =
      match read_expected_value(&dir, &fixture.name).and_then(|value| {
        serde_json::from_value(value)
          .map_err(|error| format!("parse reconstructed config: {error}"))
      }) {
        Ok(binding) => binding,
        Err(error) => {
          failures.push(format!("{}: {error}", fixture.name));
          continue;
        }
      };
    match frozen_package_digest(expected_binding) {
      Ok(oracle_digest) if &oracle_digest == expected => checked += 1,
      Ok(oracle_digest) => {
        failures.push(format!(
          "{}: frozen oracle digest {oracle_digest} != {expected}",
          fixture.name
        ));
      }
      Err(error) => {
        failures.push(format!("{}: frozen oracle: {error}", fixture.name));
      }
    }
  }

  if !failures.is_empty() {
    return Err(format!(
      "digest gate mismatches ({} of {}):\n{}",
      failures.len(),
      manifest.fixtures.len(),
      failures.join("\n")
    ));
  }
  assert_eq!(
    checked,
    manifest.fixtures.len(),
    "expected every fixture digest to be checked"
  );
  Ok(())
}
