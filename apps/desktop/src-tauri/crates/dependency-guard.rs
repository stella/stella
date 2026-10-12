use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn prohibited_package(name: &str) -> bool {
  const EXACT: &[&str] = &[
    "tauri",
    "reqwest",
    "h2",
    "h3",
    "quinn",
    "ureq",
    "isahc",
    "curl",
    "surf",
    "attohttpc",
    "native-tls",
    "openssl",
    "socket2",
    "axum",
    "opener",
    "stella-desktop",
  ];
  const PREFIXES: &[&str] = &[
    "tauri-",
    "hyper",
    "tungstenite",
    "rustls",
    "tower",
    "sentry",
    "posthog",
    "opentelemetry",
  ];
  EXACT.contains(&name) || PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a [Value], String> {
  value[key]
    .as_array()
    .map(Vec::as_slice)
    .ok_or_else(|| format!("cargo metadata is missing array {key}"))
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
  value[key]
    .as_str()
    .ok_or_else(|| format!("cargo metadata is missing string {key}"))
}

// Cargo metadata without --filter-platform includes target-specific edges. Resolved
// features are intentionally checked as reported, including workspace unification.
fn check_dependency_closure(metadata: &Value, root_name: &str) -> Result<(), String> {
  let mut packages = BTreeMap::new();
  let mut root = None;
  for package in array(metadata, "packages")? {
    let id = string(package, "id")?;
    let name = string(package, "name")?;
    if packages.insert(id, name).is_some() {
      return Err(format!("cargo metadata repeats package {id}"));
    }
    if name == root_name && root.replace(id).is_some() {
      return Err(format!(
        "cargo metadata has multiple packages named {root_name}"
      ));
    }
  }
  let root =
    root.ok_or_else(|| format!("cargo metadata has no package {root_name}"))?;
  let mut nodes = BTreeMap::new();
  for node in array(&metadata["resolve"], "nodes")? {
    let id = string(node, "id")?;
    if nodes.insert(id, node).is_some() {
      return Err(format!("cargo metadata repeats resolve node {id}"));
    }
  }
  let mut pending = vec![root];
  let mut visited = BTreeSet::new();
  while let Some(id) = pending.pop() {
    if !visited.insert(id) {
      continue;
    }
    let name = packages
      .get(id)
      .ok_or_else(|| format!("cargo metadata has no package for {id}"))?;
    let node = nodes
      .get(id)
      .ok_or_else(|| format!("cargo metadata has no resolve node for {id}"))?;
    if prohibited_package(name) {
      return Err(format!(
        "{root_name} reaches prohibited dependency {name} ({id})"
      ));
    }
    let features = array(node, "features")?;
    for feature in features {
      let feature = feature
        .as_str()
        .ok_or_else(|| format!("cargo metadata has a non-string feature for {id}"))?;
      if *name == "tokio" && feature == "net" {
        return Err(format!(
          "{root_name} reaches tokio with resolved net feature ({id})"
        ));
      }
    }
    for dependency in array(node, "deps")? {
      let kinds = array(dependency, "dep_kinds")?;
      if kinds.is_empty() {
        return Err(format!("cargo metadata has no dependency kinds for {id}"));
      }
      let mut production = false;
      for kind in kinds {
        match kind.get("kind") {
          Some(Value::Null) => production = true,
          Some(Value::String(kind)) if kind == "build" => production = true,
          Some(Value::String(kind)) if kind == "dev" => {}
          _ => {
            return Err(format!(
              "cargo metadata has an unknown dependency kind for {id}"
            ));
          }
        }
      }
      if production {
        pending.push(string(dependency, "pkg")?);
      }
    }
  }
  Ok(())
}

#[allow(
  clippy::disallowed_types,
  reason = "the integration guard invokes Cargo metadata only; product crates cannot start processes"
)]
fn assert_no_network_dependencies(manifest_dir: &str, root_name: &str) {
  use std::process::Command;
  let output = Command::new(env!("CARGO"))
    .args([
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--manifest-path",
    ])
    .arg(std::path::Path::new(manifest_dir).join("Cargo.toml"))
    .output()
    .expect("cargo metadata must run for the dependency boundary check");
  assert!(
    output.status.success(),
    "cargo metadata failed: {}",
    String::from_utf8_lossy(&output.stderr)
  );
  let metadata = serde_json::from_slice(&output.stdout)
    .expect("cargo metadata must produce valid JSON");
  check_dependency_closure(&metadata, root_name)
    .unwrap_or_else(|failure| panic!("{failure}"));
}

#[cfg(test)]
mod guard_tests {
  use super::*;
  use serde_json::json;

  fn fixture(leaf: &str, kind: Value, features: &[&str]) -> Value {
    json!({
        "packages": [
            {"id": "root", "name": "local-history"},
            {"id": "middle", "name": "intermediate"},
            {"id": "leaf", "name": leaf}
        ],
        "resolve": {"nodes": [
            {"id": "root", "features": [], "deps": [
                {"pkg": "middle", "dep_kinds": [{"kind": null, "target": null}]}
            ]},
            {"id": "middle", "features": [], "deps": [
                {"pkg": "leaf", "dep_kinds": [{"kind": kind, "target": "cfg(windows)"}]}
            ]},
            {"id": "leaf", "features": features, "deps": []}
        ]}
    })
  }

  #[test]
  fn rejects_network_dependencies_through_intermediate_packages_on_other_platforms() {
    for kind in [Value::Null, json!("build")] {
      let failure =
        check_dependency_closure(&fixture("hyper", kind, &[]), "local-history")
          .expect_err("transitive hyper must be rejected");
      assert!(failure.contains("prohibited dependency hyper"), "{failure}");
    }
  }

  #[test]
  fn rejects_every_prohibited_prefix_in_the_dependency_closure() {
    for name in [
      "tauri-plugin-opener",
      "hyper-util",
      "tungstenite-extra",
      "rustls-webpki",
      "tower-http",
      "sentry-core",
      "posthog-client",
      "opentelemetry-sdk",
    ] {
      let failure =
        check_dependency_closure(&fixture(name, Value::Null, &[]), "local-history")
          .expect_err("prefixed network dependency must be rejected");
      assert!(failure.contains(name), "{failure}");
    }
  }

  #[test]
  fn rejects_tokio_net_from_resolved_workspace_features() {
    let failure = check_dependency_closure(
      &fixture("tokio", Value::Null, &["rt", "net"]),
      "local-history",
    )
    .expect_err("resolved tokio net must be rejected");
    assert!(
      failure.contains("tokio with resolved net feature"),
      "{failure}"
    );
    assert!(
      check_dependency_closure(
        &fixture("tokio", Value::Null, &["rt"]),
        "local-history",
      )
      .is_ok()
    );
  }

  #[test]
  fn ignores_only_exclusively_development_edges() {
    let mut metadata = fixture("hyper", json!("dev"), &[]);
    assert!(check_dependency_closure(&metadata, "local-history").is_ok());
    metadata["resolve"]["nodes"][1]["deps"][0]["dep_kinds"] = json!([
        {"kind": "dev", "target": null}, {"kind": "build", "target": "cfg(windows)"}
    ]);
    let failure = check_dependency_closure(&metadata, "local-history")
      .expect_err("a build edge remains prohibited when also used in development");
    assert!(failure.contains("prohibited dependency hyper"), "{failure}");
  }

  #[test]
  fn fails_closed_when_the_dependency_graph_is_incomplete() {
    let mut metadata = fixture("harmless", Value::Null, &[]);
    metadata["resolve"]["nodes"].as_array_mut().unwrap().pop();
    let failure = check_dependency_closure(&metadata, "local-history")
      .expect_err("missing graph nodes cannot certify the closure");
    assert!(failure.contains("no resolve node for leaf"), "{failure}");
  }
}
