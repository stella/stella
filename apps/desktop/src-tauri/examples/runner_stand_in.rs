//! The development stand-in computer for a checkout's local stack; see
//! `src/desktop_runner/stand_in.rs`. `bun run agent:up -- --local-runner`
//! builds and starts it.

fn main() {
  std::process::exit(stella_desktop_lib::run_runner_stand_in());
}
