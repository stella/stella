#[cfg(unix)]
mod unix {
  use std::{
    collections::{BTreeMap, BTreeSet},
    process::Command,
  };

  const PROBES: &str = include_str!("../examples/local_file_creation_guard.rs");

  fn active(path: &str) -> bool {
    !path.starts_with("plist::") || cfg!(target_os = "macos")
  }

  #[test]
  fn local_file_creation_clippy_contract() {
    let configured: BTreeSet<_> = include_str!("../clippy.toml")
      .lines()
      .filter(|line| line.contains("create private desktop files through local_store"))
      .map(|line| line.split('"').nth(1).unwrap().to_string())
      .collect();
    let probes: BTreeSet<_> = PROBES
      .lines()
      .filter_map(|line| line.trim().strip_prefix("// guard: ").map(str::to_string))
      .collect();
    assert_eq!(
      configured, probes,
      "every configured writer must have a compile-fail probe"
    );
    // kit-allow: real cargo clippy compile-fail check that the disallowed file-creation lint fires; the process boundary is the subject of the test
    let output = Command::new("cargo")
      .current_dir(env!("CARGO_MANIFEST_DIR"))
      .args([
        "clippy",
        "--locked",
        "--offline",
        "--example",
        "local_file_creation_guard",
        "--features",
        "local-file-guard-probe",
        "--message-format=json",
        "--",
        "-D",
        "warnings",
      ])
      .output()
      .expect("Clippy must run the writer probes");
    assert!(!output.status.success(), "writer probes must be rejected");
    let mut rejected = BTreeMap::<String, usize>::new();
    let mut unexpected = Vec::new();
    for line in String::from_utf8(output.stdout).unwrap().lines() {
      let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
        continue;
      };
      if record["reason"] != "compiler-message" || record["message"]["level"] != "error"
      {
        continue;
      }
      let message = &record["message"];
      if message["code"]["code"] != "clippy::disallowed_methods" {
        unexpected.push(message.to_string());
        continue;
      }
      let span = message["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|span| span["is_primary"] == true)
        .unwrap();
      assert!(
        span["file_name"]
          .as_str()
          .unwrap()
          .ends_with("local_file_creation_guard.rs")
      );
      let line_number = usize::try_from(span["line_start"].as_u64().unwrap()).unwrap();
      let path = PROBES
        .lines()
        .take(line_number)
        .filter_map(|line| line.trim().strip_prefix("// guard: "))
        .last()
        .unwrap();
      *rejected.entry(path.to_string()).or_default() += 1;
    }
    assert!(
      unexpected.is_empty(),
      "unexpected compile errors: {unexpected:?}\n{}",
      String::from_utf8_lossy(&output.stderr)
    );
    let expected: BTreeMap<_, _> = configured
      .into_iter()
      .filter(|path| active(path))
      .map(|path| (path, 1))
      .collect();
    assert_eq!(
      rejected,
      expected,
      "each writer must produce exactly its configured lint at its call site\n{}",
      String::from_utf8_lossy(&output.stderr)
    );
  }
}
