// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Codex asks this executable for its ChatGPT token; that mode starts no app.
  if let Some(code) = stella_desktop_lib::run_codex_token_helper() {
    std::process::exit(code);
  }
  stella_desktop_lib::run()
}
