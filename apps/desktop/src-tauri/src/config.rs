use std::collections::HashSet;

use crate::types::DEFAULT_BRIDGE_PORT;

const DEFAULT_WEB_PORT: u16 = 3000;

// Comma-separated origins baked into the binary at compile time. Distribution
// builds set STELLA_DESKTOP_DEFAULT_ORIGINS so the shipped client trusts the
// matching SPA out of the box; builds without the variable default to
// loopback-only, and any additional origins must be supplied explicitly via
// the runtime STELLA_DESKTOP_ALLOWED_ORIGINS variable.
const BUILD_TIME_DEFAULT_ORIGINS: Option<&str> =
  option_env!("STELLA_DESKTOP_DEFAULT_ORIGINS");

fn parse_port(value: Option<String>, fallback: u16) -> u16 {
  value
    .and_then(|v| v.parse::<u16>().ok())
    .filter(|&p| p >= 1)
    .unwrap_or(fallback)
}

fn parse_origins(value: Option<String>) -> Vec<String> {
  value
    .unwrap_or_default()
    .split(',')
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect()
}

pub fn resolve_bridge_port() -> u16 {
  parse_port(
    std::env::var("STELLA_DESKTOP_BRIDGE_PORT").ok(),
    DEFAULT_BRIDGE_PORT,
  )
}

pub fn resolve_allowed_origins() -> HashSet<String> {
  let web_port = parse_port(std::env::var("STELLA_WEB_PORT").ok(), DEFAULT_WEB_PORT);

  let mut origins = HashSet::new();
  origins.insert(format!("http://127.0.0.1:{web_port}"));
  origins.insert(format!("http://localhost:{web_port}"));

  for origin in parse_origins(BUILD_TIME_DEFAULT_ORIGINS.map(str::to_string)) {
    origins.insert(origin);
  }

  for origin in parse_origins(std::env::var("STELLA_DESKTOP_ALLOWED_ORIGINS").ok()) {
    origins.insert(origin);
  }

  origins
}
