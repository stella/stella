include!("src/command_manifest.rs");

macro_rules! declare_stella_command_names {
  ($($path:path => $name:literal),* $(,)?) => {
    const STELLA_COMMAND_NAMES: &[&str] = &[$($name),*];
  };
}

with_stella_commands!(declare_stella_command_names);

/// Sets `cfg(dictation)` on the targets that link the speech engine, the same
/// ones `Cargo.toml` gives its dependencies.
fn configure_dictation() {
  println!("cargo::rustc-check-cfg=cfg(dictation)");
  let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
  let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
  let apple_silicon = os == "macos" && arch == "aarch64";
  if apple_silicon || os == "windows" {
    println!("cargo:rustc-cfg=dictation");
  }
  if apple_silicon {
    link_clang_runtime();
  }
}

/// The speech engine's Objective-C checks OS versions through `@available`,
/// which lives in clang's runtime library. rustc links without default
/// libraries, so nothing else brings that library in.
fn link_clang_runtime() {
  let output = std::process::Command::new("xcrun")
    .args(["clang", "--print-runtime-dir"])
    .output()
    .expect("failed to run xcrun");
  assert!(output.status.success(), "clang has no runtime directory");
  let directory = String::from_utf8(output.stdout).expect("runtime path is UTF-8");
  println!("cargo:rustc-link-search=native={}", directory.trim());
  println!("cargo:rustc-link-lib=static=clang_rt.osx");
}

fn main() {
  configure_dictation();
  let attributes = tauri_build::Attributes::new()
    .app_manifest(tauri_build::AppManifest::new().commands(STELLA_COMMAND_NAMES));
  tauri_build::try_build(attributes).expect("failed to run tauri build script");
}
