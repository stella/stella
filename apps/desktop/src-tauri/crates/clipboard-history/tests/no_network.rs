include!("../../dependency-guard.rs");

#[test]
fn clipboard_history_has_no_network_dependency_path() {
  assert_no_network_dependencies(
    env!("CARGO_MANIFEST_DIR"),
    "stella-desktop-clipboard-history",
  );
}
