mod contract {
  use std::collections::BTreeSet;

  const PROBES: &str = include_str!("../examples/local_file_creation_guard.rs");
  const EXPECTATION: &str = "#[expect(clippy::disallowed_methods";

  // Clippy proves each probe is rejected while linting the example; this
  // keeps the probe list equal to the configured bans.
  #[test]
  fn every_banned_writer_has_one_expecting_probe() {
    let configured: BTreeSet<_> = include_str!("../clippy.toml")
      .lines()
      .filter(|line| line.contains("create private desktop files through local_store"))
      .map(|line| line.split('"').nth(1).unwrap().to_string())
      .collect();
    let guards: Vec<_> = PROBES
      .lines()
      .filter_map(|line| line.trim().strip_prefix("// guard: ").map(str::to_string))
      .collect();
    let probes: BTreeSet<_> = guards.iter().cloned().collect();
    assert_eq!(probes.len(), guards.len(), "each writer has one probe");
    assert_eq!(
      configured, probes,
      "every configured writer must have a probe"
    );
    let probe_functions = PROBES
      .lines()
      .filter(|line| {
        line.starts_with("fn probe_") || line.starts_with("async fn probe_")
      })
      .count();
    let expectations = PROBES
      .lines()
      .filter(|line| line.starts_with(EXPECTATION))
      .count();
    assert_eq!(probe_functions, guards.len(), "one guard per probe");
    assert_eq!(expectations, probe_functions, "every probe expects the ban");
  }
}
