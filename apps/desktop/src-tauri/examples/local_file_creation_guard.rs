//! One probe per writer banned in clippy.toml. Clippy lints this example with
//! every target, and each probe expects the ban: a writer the configuration
//! stops rejecting fails the lint as an unfulfilled expectation.
#![allow(dead_code, reason = "probes are linted, never run")]

fn main() {}

#[cfg(windows)]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_windows_move() {
  // guard: winsafe::MoveFileEx
  let _ = winsafe::MoveFileEx(
    "unused",
    Some("unused"),
    winsafe::co::MOVEFILE::WRITE_THROUGH,
  );
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_0() {
  // guard: std::fs::rename
  let _ = std::fs::rename("unused", "unused");
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_1() {
  // guard: std::fs::hard_link
  let _ = std::fs::hard_link("unused", "unused");
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_2() {
  // guard: tokio::fs::rename
  let _ = tokio::fs::rename("unused", "unused").await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_3() {
  // guard: tokio::fs::hard_link
  let _ = tokio::fs::hard_link("unused", "unused").await;
}

#[cfg(target_os = "macos")]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_4() {
  // guard: plist::to_file_xml
  let _ = plist::to_file_xml("unused", &"value");
}

#[cfg(target_os = "macos")]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_5() {
  // guard: plist::to_file_binary
  let _ = plist::to_file_binary("unused", &"value");
}

#[cfg(target_os = "macos")]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_6(value: &plist::Value) {
  // guard: plist::Value::to_file_xml
  let _ = value.to_file_xml("unused");
}

#[cfg(target_os = "macos")]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_7(value: &plist::Value) {
  // guard: plist::Value::to_file_binary
  let _ = value.to_file_binary("unused");
}

#[cfg(unix)]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_8() {
  // guard: rustix::fs::open
  let _ = rustix::fs::open(
    "unused",
    rustix::fs::OFlags::RDONLY,
    rustix::fs::Mode::empty(),
  );
}

#[cfg(unix)]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_9(directory: &std::fs::File) {
  // guard: rustix::fs::openat
  let _ = rustix::fs::openat(
    directory,
    "unused",
    rustix::fs::OFlags::RDONLY,
    rustix::fs::Mode::empty(),
  );
}

#[cfg(unix)]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_10(directory: &std::fs::File) {
  // guard: rustix::fs::mkdirat
  let _ = rustix::fs::mkdirat(directory, "unused", rustix::fs::Mode::empty());
}

#[cfg(unix)]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_11(directory: &std::fs::File) {
  // guard: rustix::fs::renameat
  let _ = rustix::fs::renameat(directory, "unused", directory, "unused");
}

#[cfg(unix)]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_12(directory: &std::fs::File) {
  // guard: rustix::fs::linkat
  let _ = rustix::fs::linkat(
    directory,
    "unused",
    directory,
    "unused",
    rustix::fs::AtFlags::empty(),
  );
}

#[cfg(unix)]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_13(directory: &std::fs::File) {
  // guard: rustix::fs::fchmod
  let _ = rustix::fs::fchmod(directory, rustix::fs::Mode::empty());
}

#[cfg(unix)]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_14(directory: &std::fs::File) {
  // guard: rustix::fs::unlinkat
  let _ = rustix::fs::unlinkat(directory, "unused", rustix::fs::AtFlags::empty());
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_15(manager: &tauri_plugin_autostart::AutoLaunchManager) {
  // guard: tauri_plugin_autostart::AutoLaunchManager::enable
  let _ = manager.enable();
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_16(manager: &tauri_plugin_autostart::AutoLaunchManager) {
  // guard: tauri_plugin_autostart::AutoLaunchManager::disable
  let _ = manager.disable();
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_17(update: &tauri_plugin_updater::Update) {
  // guard: tauri_plugin_updater::Update::download_and_install
  let _ = update.download_and_install(|_, _| {}, || {}).await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_18(update: &tauri_plugin_updater::Update) {
  // guard: tauri_plugin_updater::Update::install
  let _ = update.install([]);
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_19(update: &tauri_plugin_updater::Update) {
  // guard: tauri_plugin_updater::Update::download
  let _ = update.download(|_, _| {}, || {}).await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_20() {
  // guard: tokio::fs::DirBuilder::create
  let _ = tokio::fs::DirBuilder::new().create("unused").await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_21() {
  // guard: std::fs::write
  let _ = std::fs::write("unused", b"check");
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_22() {
  // guard: std::fs::File::create
  let _ = std::fs::File::create("unused");
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_23() {
  // guard: std::fs::File::create_new
  let _ = std::fs::File::create_new("unused");
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_24() {
  // guard: std::fs::create_dir_all
  let _ = std::fs::create_dir_all("unused");
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_25() {
  // guard: std::fs::create_dir
  let _ = std::fs::create_dir("unused");
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_26() {
  // guard: std::fs::DirBuilder::create
  let _ = std::fs::DirBuilder::new().create("unused");
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_27() {
  // guard: std::fs::OpenOptions::open
  let _ = std::fs::OpenOptions::new().write(true).open("unused");
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_28() {
  // guard: std::fs::set_permissions
  let _ = std::fs::set_permissions(
    "unused",
    std::fs::metadata("unused").unwrap().permissions(),
  );
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_29(file: &std::fs::File) {
  // guard: std::fs::File::set_permissions
  let _ = file.set_permissions(std::fs::metadata("unused").unwrap().permissions());
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_30() {
  // guard: std::fs::copy
  let _ = std::fs::copy("unused", "unused");
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_31() {
  // guard: tokio::fs::write
  let _ = tokio::fs::write("unused", b"check").await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_32() {
  // guard: tokio::fs::File::create
  let _ = tokio::fs::File::create("unused").await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_33() {
  // guard: tokio::fs::File::create_new
  let _ = tokio::fs::File::create_new("unused").await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_34() {
  // guard: tokio::fs::create_dir_all
  let _ = tokio::fs::create_dir_all("unused").await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_35() {
  // guard: tokio::fs::create_dir
  let _ = tokio::fs::create_dir("unused").await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_36() {
  // guard: tokio::fs::OpenOptions::open
  let _ = tokio::fs::OpenOptions::new()
    .write(true)
    .open("unused")
    .await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_37() {
  // guard: tokio::fs::set_permissions
  let _ = tokio::fs::set_permissions(
    "unused",
    std::fs::metadata("unused").unwrap().permissions(),
  )
  .await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_38(file: &tokio::fs::File) {
  // guard: tokio::fs::File::set_permissions
  let _ = file
    .set_permissions(std::fs::metadata("unused").unwrap().permissions())
    .await;
}

#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
async fn probe_39() {
  // guard: tokio::fs::copy
  let _ = tokio::fs::copy("unused", "unused").await;
}

#[cfg(unix)]
#[expect(clippy::disallowed_methods, reason = "the ban must reject this call")]
fn probe_rename(directory: &std::fs::File) {
  // guard: rustix::fs::renameat_with
  let _ = rustix::fs::renameat_with(
    directory,
    "unused",
    directory,
    "unused",
    rustix::fs::RenameFlags::NOREPLACE,
  );
}
