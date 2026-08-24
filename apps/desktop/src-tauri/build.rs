include!("src/command_manifest.rs");

macro_rules! declare_stella_command_names {
  ($($path:path => $name:literal),* $(,)?) => {
    const STELLA_COMMAND_NAMES: &[&str] = &[$($name),*];
  };
}

with_stella_commands!(declare_stella_command_names);

fn main() {
  let attributes = tauri_build::Attributes::new()
    .app_manifest(tauri_build::AppManifest::new().commands(STELLA_COMMAND_NAMES));
  tauri_build::try_build(attributes).expect("failed to run tauri build script");
}
