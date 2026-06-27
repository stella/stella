use std::collections::HashSet;

use crate::types::DEFAULT_BRIDGE_PORT;

const DEFAULT_WEB_PORT: u16 = 3000;
const PRODUCTION_API_BASE_URL: &str = "https://api.stll.app";

// Comma-separated origins baked into the binary at compile time. Distribution
// builds set STELLA_DESKTOP_DEFAULT_ORIGINS so the shipped client trusts the
// matching SPA out of the box; builds without the variable default to
// loopback-only, and any additional origins must be supplied explicitly via
// the runtime STELLA_DESKTOP_ALLOWED_ORIGINS variable.
const BUILD_TIME_DEFAULT_ORIGINS: Option<&str> =
  option_env!("STELLA_DESKTOP_DEFAULT_ORIGINS");
const BUILD_TIME_DEFAULT_API_BASE_URLS: Option<&str> =
  option_env!("STELLA_DESKTOP_DEFAULT_API_BASE_URLS");

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

fn is_loopback_host(parsed: &reqwest::Url) -> bool {
  parsed.host_str().is_some_and(|host| {
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
  })
}

fn is_allowed_user_trusted_url(parsed: &reqwest::Url) -> bool {
  parsed.scheme() == "https"
    || (cfg!(debug_assertions) && parsed.scheme() == "http" && is_loopback_host(parsed))
}

fn normalize_url_origin(parsed: &reqwest::Url) -> Result<String, String> {
  // `host()` (unlike `host_str()`) keeps the brackets around IPv6 literals, so
  // debug loopback origins like `http://[::1]:3000` round-trip and still match
  // the browser-sent `Origin` header.
  let host = parsed
    .host()
    .ok_or_else(|| "Self-host URL must include a host.".to_string())?;
  let port = parsed
    .port()
    .map(|value| format!(":{value}"))
    .unwrap_or_default();
  Ok(format!("{}://{host}{port}", parsed.scheme()))
}

fn reject_non_origin_url(parsed: &reqwest::Url) -> Result<(), String> {
  if !parsed.username().is_empty()
    || parsed.password().is_some()
    || parsed.query().is_some()
    || parsed.fragment().is_some()
    || parsed.path() != "/"
  {
    return Err(
      "Self-host URL must be an exact origin without path, query or credentials."
        .to_string(),
    );
  }

  Ok(())
}

pub fn normalize_api_base_url(url: &str) -> String {
  let normalized = url.trim_end_matches('/');
  match normalized {
    "https://app.stll.app" | "https://my.stll.app" => {
      "https://api.stll.app".to_string()
    }
    _ => normalized.to_string(),
  }
}

pub fn normalize_self_host_web_origin(value: &str) -> Result<String, String> {
  let parsed = reqwest::Url::parse(value.trim())
    .map_err(|_| "Self-host web origin is not a valid URL.".to_string())?;
  reject_non_origin_url(&parsed)?;

  if !is_allowed_user_trusted_url(&parsed) {
    return Err("Self-host web origin must use HTTPS.".to_string());
  }

  normalize_url_origin(&parsed)
}

pub fn normalize_self_host_api_base_url(value: &str) -> Result<String, String> {
  let normalized = normalize_api_base_url(value.trim());
  let parsed = reqwest::Url::parse(&normalized)
    .map_err(|_| "Self-host API URL is not a valid URL.".to_string())?;
  reject_non_origin_url(&parsed)?;

  if !is_allowed_user_trusted_url(&parsed) {
    return Err("Self-host API URL must use HTTPS.".to_string());
  }

  normalize_url_origin(&parsed)
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

pub fn resolve_trusted_api_base_urls() -> HashSet<String> {
  let mut urls = HashSet::new();
  urls.insert(PRODUCTION_API_BASE_URL.to_string());

  for origin in resolve_allowed_origins() {
    urls.insert(normalize_api_base_url(&origin));
  }

  for url in parse_origins(BUILD_TIME_DEFAULT_API_BASE_URLS.map(str::to_string)) {
    urls.insert(normalize_api_base_url(&url));
  }

  for url in parse_origins(std::env::var("STELLA_DESKTOP_ALLOWED_API_BASE_URLS").ok()) {
    urls.insert(normalize_api_base_url(&url));
  }

  urls
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn normalizes_self_host_web_origin() {
    assert_eq!(
      normalize_self_host_web_origin("https://web-production.example/").unwrap(),
      "https://web-production.example"
    );
  }

  #[test]
  fn rejects_self_host_origin_with_path() {
    assert!(normalize_self_host_web_origin("https://example.com/app").is_err());
  }

  #[test]
  fn rejects_insecure_non_loopback_origin() {
    assert!(normalize_self_host_web_origin("http://example.com").is_err());
  }

  #[test]
  fn normalizes_production_app_origin_to_api_url() {
    assert_eq!(
      normalize_self_host_api_base_url("https://my.stll.app").unwrap(),
      "https://api.stll.app"
    );
  }
}
