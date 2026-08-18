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

/// Set to `1` to rewrite `manifest.json` with the digests of the current
/// frozen oracles instead of failing on a mismatch. The digests derive from
/// the reviewed `*.expected*.json` fixtures, never from the assembler under
/// test, so this is the sanctioned refresh after an intentional oracle edit.
const UPDATE_MANIFEST_ENV: &str = "ANONYMIZE_UPDATE_ASSEMBLE_MANIFEST";

fn write_manifest_digests(
  path: &Path,
  digests: &[(String, String)],
) -> Result<(), String> {
  // Edit the text in place so key order and formatting survive; a JSON
  // round-trip would reorder the hand-maintained manifest.
  let mut text = fs::read_to_string(path)
    .map_err(|error| format!("read {}: {error}", path.display()))?;
  for (name, digest) in digests {
    let name_key =
      format!("\"name\": {}", serde_json::Value::from(name.as_str()));
    let name_at = text
      .find(&name_key)
      .ok_or_else(|| format!("manifest.json has no fixture named {name}"))?;
    let digest_key = "\"packageDigest\": \"";
    let digest_at = text
      .get(name_at..)
      .and_then(|tail| tail.find(digest_key))
      .map(|offset| {
        name_at
          .saturating_add(offset)
          .saturating_add(digest_key.len())
      })
      .ok_or_else(|| format!("{name}: manifest.json has no packageDigest"))?;
    let digest_end = text
      .get(digest_at..)
      .and_then(|tail| tail.find('"'))
      .map(|offset| digest_at.saturating_add(offset))
      .ok_or_else(|| format!("{name}: unterminated packageDigest"))?;
    text.replace_range(digest_at..digest_end, digest);
  }
  fs::write(path, text)
    .map_err(|error| format!("write {}: {error}", path.display()))
}

#[test]
fn assemble_package_digests_match_manifest() -> Result<(), String> {
  let dir = fixtures_dir();
  let manifest_path = dir.join("manifest.json");
  let manifest: Manifest = read_json(&manifest_path)?;
  let update = std::env::var(UPDATE_MANIFEST_ENV).is_ok_and(|v| v == "1");

  let mut failures = Vec::new();
  let mut refreshed = Vec::new();
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
      Ok(oracle_digest) if update => {
        refreshed.push((fixture.name.clone(), oracle_digest));
        checked += 1;
      }
      Ok(oracle_digest) => {
        failures.push(format!(
          "{}: frozen oracle digest {oracle_digest} != {expected} \
           (set {UPDATE_MANIFEST_ENV}=1 to refresh manifest.json)",
          fixture.name
        ));
      }
      Err(error) => {
        failures.push(format!("{}: frozen oracle: {error}", fixture.name));
      }
    }
  }

  if !refreshed.is_empty() {
    write_manifest_digests(&manifest_path, &refreshed)?;
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
