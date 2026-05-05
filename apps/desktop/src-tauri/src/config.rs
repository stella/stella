use std::collections::HashSet;

use crate::types::DEFAULT_BRIDGE_PORT;

const DEFAULT_WEB_PORT: u16 = 3000;

const DEFAULT_PROD_ORIGINS: &[&str] = &["https://my.stll.app", "https://app.stll.app"];

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

  for origin in DEFAULT_PROD_ORIGINS {
    origins.insert((*origin).to_string());
  }

  for origin in parse_origins(std::env::var("STELLA_DESKTOP_ALLOWED_ORIGINS").ok()) {
    origins.insert(origin);
  }

  origins
}
