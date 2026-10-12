include!("../../dependency-guard.rs");

#[test]
fn local_store_has_no_network_dependency_path() {
  assert_no_network_dependencies(
    env!("CARGO_MANIFEST_DIR"),
    "stella-desktop-local-store",
  );
}
