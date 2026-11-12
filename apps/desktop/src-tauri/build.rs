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

/// The API contract owns the document limit. The desktop app bounds an Office
/// download by the same value, read from the contract's source at build time
/// so no copy of it exists here. The declaration is one line whose value is a
/// product of integer literals (`200 * 1024 * 1024`).
fn emit_document_limit() {
  const DECLARATION: &str = "export const UPLOAD_DOCUMENT_MAX_BYTES: number = ";
  let manifest_dir =
    std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
  let source_path = std::path::Path::new(&manifest_dir)
    .join("../../../packages/api-contract/src/document-version-upload.ts");
  println!("cargo:rerun-if-changed={}", source_path.display());
  let source = std::fs::read_to_string(&source_path)
    .expect("the API contract's upload module is readable");
  let expression = source
    .lines()
    .find_map(|line| line.strip_prefix(DECLARATION))
    .and_then(|rest| rest.strip_suffix(';'))
    .expect("the API contract declares UPLOAD_DOCUMENT_MAX_BYTES on one line");
  let bytes = expression
    .split('*')
    .map(|factor| {
      factor
        .trim()
        .replace('_', "")
        .parse::<u64>()
        .expect("each factor of the document limit is an integer literal")
    })
    .try_fold(1_u64, u64::checked_mul)
    .expect("the document limit fits in u64");
  println!("cargo:rustc-env=STELLA_UPLOAD_DOCUMENT_MAX_BYTES={bytes}");
}

fn main() {
  configure_dictation();
  emit_document_limit();
  let attributes = tauri_build::Attributes::new()
    .app_manifest(tauri_build::AppManifest::new().commands(STELLA_COMMAND_NAMES));
  tauri_build::try_build(attributes).expect("failed to run tauri build script");
}
