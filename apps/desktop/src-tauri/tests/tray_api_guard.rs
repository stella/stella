//! Enumerate the pinned API instead of hand-maintaining a second method list.

use std::{collections::BTreeSet, fs, path::PathBuf, process::Command};

#[derive(serde::Deserialize)]
struct CargoMetadata {
  packages: Vec<CargoPackage>,
}

#[derive(serde::Deserialize)]
struct CargoPackage {
  name: String,
  version: String,
  manifest_path: PathBuf,
}

fn tauri_source() -> PathBuf {
  let package = include_str!("../Cargo.lock")
    .split("[[package]]")
    .find(|package| package.lines().any(|line| line == "name = \"tauri\""))
    .expect("Cargo.lock must pin tauri");
  let version = package
    .lines()
    .find_map(|line| line.strip_prefix("version = \"")?.strip_suffix('"'))
    .expect("tauri must have a pinned version");
  // Cargo resolves custom registries and cache locations; the test must not
  // duplicate its environment or registry-directory conventions.
  let output = Command::new("cargo")
    .args(["metadata", "--format-version", "1", "--locked", "--offline"])
    .output()
    .expect("Cargo metadata must be available to the API census");
  assert!(
    output.status.success(),
    "Cargo metadata failed: {}",
    String::from_utf8_lossy(&output.stderr)
  );
  let metadata: CargoMetadata = serde_json::from_slice(&output.stdout)
    .expect("Cargo metadata must describe the pinned dependency sources");
  metadata
    .packages
    .into_iter()
    .find(|package| package.name == "tauri" && package.version == version)
    .expect("Cargo metadata must contain the lockfile-pinned tauri package")
    .manifest_path
    .parent()
    .expect("tauri manifest must have a package directory")
    .join("src")
}

fn public_methods(source: &str) -> BTreeSet<String> {
  source
    .lines()
    .filter_map(|line| {
      let method = line.trim_start().strip_prefix("pub fn ")?;
      Some(
        method
          .chars()
          .take_while(|character| character.is_alphanumeric() || *character == '_')
          .collect(),
      )
    })
    .collect()
}

#[test]
fn every_pinned_native_tray_method_is_confined_to_its_owner() {
  // Cargo has fetched the dependency sources before compiling this test.
  let root = tauri_source();
  let tray = fs::read_to_string(root.join("tray/mod.rs")).unwrap();
  let app = fs::read_to_string(root.join("app.rs")).unwrap();
  let mut paths = BTreeSet::new();
  for receiver in ["TrayIconBuilder", "TrayIcon"] {
    let implementation = tray
      .split(&format!("impl<R: Runtime> {receiver}<R> {{"))
      .nth(1)
      .expect("the pinned tray receiver must have an implementation")
      .split("\n}\n")
      .next()
      .unwrap();
    let methods = public_methods(implementation);
    assert!(
      !methods.is_empty(),
      "the {receiver} census must find methods"
    );
    paths.extend(
      methods
        .into_iter()
        .map(|method| format!("tauri::tray::{receiver}::{method}")),
    );
  }
  let shared = app
    .split("macro_rules! shared_app_impl {")
    .nth(1)
    .unwrap()
    .split("\n}\n")
    .next()
    .unwrap();
  let shared_methods: BTreeSet<_> = public_methods(shared)
    .into_iter()
    .filter(|method| method.contains("tray"))
    .collect();
  assert!(
    !shared_methods.is_empty(),
    "the application census must find tray APIs"
  );
  let receivers: BTreeSet<_> = app
    .lines()
    .filter_map(|line| {
      line
        .strip_prefix("shared_app_impl!(")?
        .split('<')
        .next()
        .map(str::to_string)
    })
    .collect();
  assert!(
    !receivers.is_empty(),
    "the application census must find receivers"
  );
  for receiver in receivers {
    paths.extend(
      shared_methods
        .iter()
        .map(|method| format!("tauri::{receiver}::{method}")),
    );
  }
  for implementation in app.split("impl<R: Runtime> Builder<R> {").skip(1) {
    let body = implementation.split("\n}\n").next().unwrap();
    paths.extend(
      public_methods(body)
        .into_iter()
        .filter(|method| method.contains("tray"))
        .map(|method| format!("tauri::Builder::{method}")),
    );
  }
  let config = include_str!("../clippy.toml");
  let method_config = config
    .split("disallowed-methods = [")
    .nth(1)
    .unwrap()
    .split("\n]")
    .next()
    .unwrap();
  let bans: BTreeSet<_> = method_config
    .lines()
    .filter_map(|line| {
      line
        .trim_start()
        .strip_prefix("{ path = \"")?
        .split('"')
        .next()
        .map(str::to_string)
    })
    .collect();
  for path in paths {
    assert!(
      bans.contains(&path),
      "unprotected native tray method: {path}"
    );
  }
  for receiver in ["TrayIcon", "TrayIconBuilder"] {
    let type_config = config.split("disallowed-types = [").nth(1).unwrap();
    assert!(
      type_config.contains(&format!("path = \"tauri::tray::{receiver}\"")),
      "raw native tray types must stay with their owner"
    );
  }
}
