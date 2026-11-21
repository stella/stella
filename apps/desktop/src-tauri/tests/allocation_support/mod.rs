use std::collections::BTreeSet;

pub const SIZES: [usize; 2] = [64 * 1024, 640 * 1024];

// This registry is the surface of the allocation harness. No exemptions.
const HOT_PATHS: &[&str] = &["clipboard", "session_gate", "session_upload"];

pub fn census() {
  let tests = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/tests"))
    .unwrap()
    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
    .filter_map(|name| {
      name
        .strip_prefix("allocation_")?
        .strip_suffix(".rs")
        .map(str::to_owned)
    })
    .collect::<BTreeSet<_>>();
  let registered = HOT_PATHS
    .iter()
    .map(|path| path.to_string())
    .collect::<BTreeSet<_>>();
  assert_eq!(
    tests, registered,
    "every registered hot path must have an allocation test"
  );
}
