use std::collections::HashMap;
use std::sync::OnceLock;

static TRANSLATIONS: OnceLock<Translations> = OnceLock::new();

struct Translations {
  locale: &'static str,
  messages: HashMap<String, String>,
  fallback: HashMap<String, String>,
}

/// Every locale the app ships, in the picker's order. A test asserts this
/// list is exactly the message files on disk, which the TypeScript side pins
/// to the shared UI-locale list, so the two cannot drift apart.
const LOCALES: &[(&str, &str)] = &[
  ("en", include_str!("../../src/i18n/langs/en.json")),
  ("ar", include_str!("../../src/i18n/langs/ar.json")),
  ("cs", include_str!("../../src/i18n/langs/cs.json")),
  ("de", include_str!("../../src/i18n/langs/de.json")),
  ("es", include_str!("../../src/i18n/langs/es.json")),
  ("et", include_str!("../../src/i18n/langs/et.json")),
  ("fr", include_str!("../../src/i18n/langs/fr.json")),
  ("hu", include_str!("../../src/i18n/langs/hu.json")),
  ("lt", include_str!("../../src/i18n/langs/lt.json")),
  ("lv", include_str!("../../src/i18n/langs/lv.json")),
  ("pl", include_str!("../../src/i18n/langs/pl.json")),
  ("pt-BR", include_str!("../../src/i18n/langs/pt-BR.json")),
  ("sk", include_str!("../../src/i18n/langs/sk.json")),
];

/// Flatten nested JSON into dot-separated keys.
/// `{"tray": {"settings": "Settings"}}` becomes `{"tray.settings": "Settings"}`.
fn flatten_json(
  value: &serde_json::Value,
  prefix: &str,
  out: &mut HashMap<String, String>,
) {
  match value {
    serde_json::Value::Object(map) => {
      for (key, val) in map {
        let full_key = if prefix.is_empty() {
          key.clone()
        } else {
          format!("{prefix}.{key}")
        };
        flatten_json(val, &full_key, out);
      }
    }
    serde_json::Value::String(s) => {
      out.insert(prefix.to_string(), s.clone());
    }
    _ => {}
  }
}

fn parse_locale(json_str: &str) -> HashMap<String, String> {
  let value: serde_json::Value = serde_json::from_str(json_str).unwrap_or_default();
  let mut map = HashMap::new();
  flatten_json(&value, "", &mut map);
  map
}

fn locale_source(locale: &str) -> Option<(&'static str, &'static str)> {
  LOCALES
    .iter()
    .find(|(l, _)| *l == locale)
    .map(|(l, source)| (*l, *source))
}

/// Map a system locale tag onto a shipped locale: the exact tag first, then
/// the base code, and finally Portuguese, whose only build is `pt-BR`. Mirrors
/// the TypeScript resolver so both sides pick the same file for a tag.
fn resolve_locale(tag: &str) -> Option<&'static str> {
  let normalized = tag.replace('_', "-");
  if let Some((locale, _)) = locale_source(&normalized) {
    return Some(locale);
  }
  let base = normalized.split('-').next()?;
  if let Some((locale, _)) = locale_source(base) {
    return Some(locale);
  }
  if base == "pt" {
    return locale_source("pt-BR").map(|(locale, _)| locale);
  }
  None
}

fn detect_locale() -> &'static str {
  sys_locale::get_locale()
    .and_then(|tag| resolve_locale(&tag))
    .unwrap_or("en")
}

/// Initialize the translation system. Call once at startup.
pub fn init() {
  init_with_locale(detect_locale());
}

/// Initialize with a specific locale. Useful for tests.
#[cfg(test)]
pub fn init_en() {
  init_with_locale("en");
}

fn init_with_locale(locale: &str) {
  TRANSLATIONS.get_or_init(|| {
    let fallback = parse_locale(locale_source("en").map(|(_, s)| s).unwrap_or("{}"));

    match locale_source(locale) {
      Some((locale, source)) => Translations {
        locale,
        messages: parse_locale(source),
        fallback,
      },
      None => Translations {
        locale: "en",
        messages: fallback.clone(),
        fallback,
      },
    }
  });
}

/// Look up a translation key. Falls back to English, then returns the key itself.
pub fn t(key: &str) -> &str {
  let tr = TRANSLATIONS
    .get()
    .expect("i18n not initialized; call i18n::init() first");
  tr.messages
    .get(key)
    .or_else(|| tr.fallback.get(key))
    .map(String::as_str)
    .unwrap_or(key)
}

/// Look up a translation key and replace `{var}` placeholders.
pub fn t_fmt(key: &str, vars: &[(&str, &str)]) -> String {
  let template = t(key);
  let mut result = template.to_string();
  for (name, value) in vars {
    result = result.replace(&format!("{{{name}}}"), value);
  }
  result
}

/// Look up a pluralized translation key.
/// Handles ICU-style `{count, plural, one {…} few {…} other {…}}` patterns.
/// Supports `few` form for languages that need it (cs, sk, pl, lt).
pub fn t_plural(key: &str, count: usize) -> String {
  let template = t(key);

  // Parse ICU plural: {count, plural, one {…} few {…} other {…}}
  if let Some(start) = template.find("{count, plural,") {
    let rest = &template[start..];
    let form = select_plural_form(count);

    // Try the exact form first, fall back to "other"
    let branch = extract_plural_branch(rest, form)
      .or_else(|| extract_plural_branch(rest, "other"));

    if let Some(b) = branch {
      return b.replace("{count}", &count.to_string());
    }
  }

  // Fallback: simple replacement
  template.replace("{count}", &count.to_string())
}

/// CLDR plural category for Arabic, whose six categories the branch probe
/// below cannot express: it knows only one/few/other.
fn arabic_plural_form(count: usize) -> &'static str {
  match count {
    0 => "zero",
    1 => "one",
    2 => "two",
    _ => match count % 100 {
      3..=10 => "few",
      11..=99 => "many",
      _ => "other",
    },
  }
}

/// Select the ICU plural form based on the active locale and count.
/// Covers CLDR plural rules for supported languages.
fn select_plural_form(count: usize) -> &'static str {
  let tr = TRANSLATIONS.get().expect("i18n not initialized");
  if tr.locale == "ar" {
    return arabic_plural_form(count);
  }

  // Check if this locale has a "few" branch by testing a known key
  let has_few = tr.messages.values().any(|v| v.contains("few {"));

  if count == 1 {
    "one"
  } else if has_few && (2..=4).contains(&count) {
    "few"
  } else {
    "other"
  }
}

/// Extract a branch from an ICU plural pattern.
/// Input: `{count, plural, one {1 active edit} other {{count} active edits}}`
/// For form "one", returns: `1 active edit`
fn extract_plural_branch(icu: &str, form: &str) -> Option<String> {
  let needle = format!("{form} {{");
  let branch_start = icu.find(&needle)?;
  let content_start = branch_start + needle.len();
  let rest = &icu[content_start..];

  // Find the matching closing brace (handle nested `{count}`)
  let mut depth = 1;
  let mut end = 0;
  for (i, ch) in rest.char_indices() {
    match ch {
      '{' => depth += 1,
      '}' => {
        depth -= 1;
        if depth == 0 {
          end = i;
          break;
        }
      }
      _ => {}
    }
  }

  if end > 0 {
    Some(rest[..end].to_string())
  } else {
    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ensure_init() {
    init_en();
  }

  // -- LOCALES --

  /// The tray strings and the window strings must cover the same languages.
  /// The TypeScript side pins its catalogue directory to the shared UI-locale
  /// list, so matching the directory here is what keeps Rust in step with it.
  #[test]
  fn locales_cover_every_shipped_message_file() {
    let dir =
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/i18n/langs");
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
      .expect("desktop message directory")
      .map(|entry| entry.expect("directory entry").path())
      .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
      .map(|path| {
        path
          .file_stem()
          .expect("message file name")
          .to_string_lossy()
          .into_owned()
      })
      .collect();
    on_disk.sort();

    let mut declared: Vec<String> =
      LOCALES.iter().map(|(l, _)| (*l).to_string()).collect();
    declared.sort();

    assert_eq!(declared, on_disk);
  }

  // -- resolve_locale --

  #[test]
  fn test_resolve_locale_exact_tag() {
    assert_eq!(resolve_locale("pt-BR"), Some("pt-BR"));
    assert_eq!(resolve_locale("cs"), Some("cs"));
  }

  #[test]
  fn test_resolve_locale_base_code() {
    assert_eq!(resolve_locale("de-AT"), Some("de"));
    assert_eq!(resolve_locale("ar_EG"), Some("ar"));
  }

  #[test]
  fn test_resolve_locale_portuguese_falls_back_to_brazilian() {
    assert_eq!(resolve_locale("pt-PT"), Some("pt-BR"));
  }

  #[test]
  fn test_resolve_locale_unknown() {
    assert_eq!(resolve_locale("ja-JP"), None);
  }

  // -- arabic_plural_form --

  #[test]
  fn test_arabic_plural_form_covers_every_category() {
    assert_eq!(arabic_plural_form(0), "zero");
    assert_eq!(arabic_plural_form(1), "one");
    assert_eq!(arabic_plural_form(2), "two");
    assert_eq!(arabic_plural_form(3), "few");
    assert_eq!(arabic_plural_form(10), "few");
    assert_eq!(arabic_plural_form(11), "many");
    assert_eq!(arabic_plural_form(99), "many");
    assert_eq!(arabic_plural_form(100), "other");
    assert_eq!(arabic_plural_form(102), "other");
    assert_eq!(arabic_plural_form(103), "few");
  }

  // -- flatten_json --

  #[test]
  fn test_flatten_json_simple() {
    let json: serde_json::Value =
      serde_json::from_str(r#"{"greeting": "hello"}"#).unwrap();
    let mut map = HashMap::new();
    flatten_json(&json, "", &mut map);
    assert_eq!(map.get("greeting").unwrap(), "hello");
    assert_eq!(map.len(), 1);
  }

  #[test]
  fn test_flatten_json_nested() {
    let json: serde_json::Value =
      serde_json::from_str(r#"{"tray": {"settings": "Settings", "quit": "Quit"}}"#)
        .unwrap();
    let mut map = HashMap::new();
    flatten_json(&json, "", &mut map);
    assert_eq!(map.get("tray.settings").unwrap(), "Settings");
    assert_eq!(map.get("tray.quit").unwrap(), "Quit");
    assert_eq!(map.len(), 2);
  }

  #[test]
  fn test_flatten_json_deeply_nested() {
    let json: serde_json::Value =
      serde_json::from_str(r#"{"a": {"b": {"c": {"d": "deep"}}}}"#).unwrap();
    let mut map = HashMap::new();
    flatten_json(&json, "", &mut map);
    assert_eq!(map.get("a.b.c.d").unwrap(), "deep");
    assert_eq!(map.len(), 1);
  }

  #[test]
  fn test_flatten_json_non_string_values_skipped() {
    let json: serde_json::Value = serde_json::from_str(
      r#"{"count": 42, "active": true, "label": "hello", "items": [1,2]}"#,
    )
    .unwrap();
    let mut map = HashMap::new();
    flatten_json(&json, "", &mut map);
    // Only "label" is a string; everything else is skipped
    assert_eq!(map.len(), 1);
    assert_eq!(map.get("label").unwrap(), "hello");
  }

  // -- extract_plural_branch --

  #[test]
  fn test_extract_plural_branch_one() {
    let icu = "{count, plural, one {1 active edit} other {{count} active edits}}";
    let branch = extract_plural_branch(icu, "one").unwrap();
    assert_eq!(branch, "1 active edit");
  }

  #[test]
  fn test_extract_plural_branch_other() {
    let icu = "{count, plural, one {1 active edit} other {{count} active edits}}";
    let branch = extract_plural_branch(icu, "other").unwrap();
    assert_eq!(branch, "{count} active edits");
  }

  #[test]
  fn test_extract_plural_branch_missing_form() {
    let icu = "{count, plural, one {1 item} other {{count} items}}";
    assert!(extract_plural_branch(icu, "few").is_none());
  }

  // -- t_plural --

  #[test]
  fn test_t_plural_one() {
    ensure_init();
    let result = t_plural("tray.activeEdits", 1);
    assert_eq!(result, "1 active edit");
  }

  #[test]
  fn test_t_plural_other() {
    ensure_init();
    let result = t_plural("tray.activeEdits", 5);
    assert_eq!(result, "5 active edits");
  }

  #[test]
  fn test_t_plural_zero_uses_other() {
    ensure_init();
    let result = t_plural("tray.activeEdits", 0);
    assert_eq!(result, "0 active edits");
  }

  // -- t_fmt --

  #[test]
  fn test_t_fmt_replacement() {
    ensure_init();
    // Use a key that exists with a {var} placeholder, or test manually
    // Since we may not have a key with placeholders in the tray namespace,
    // we test with a missing key (falls back to the key itself)
    let result = t_fmt("missing.key.{name}", &[("name", "world")]);
    assert_eq!(result, "missing.key.world");
  }

  #[test]
  fn test_t_fmt_multiple_vars() {
    ensure_init();
    let result = t_fmt("{a} and {b}", &[("a", "X"), ("b", "Y")]);
    assert_eq!(result, "X and Y");
  }

  // -- t (basic lookup) --

  #[test]
  fn test_t_returns_fallback_for_unknown_key() {
    ensure_init();
    let result = t("this.key.does.not.exist");
    assert_eq!(result, "this.key.does.not.exist");
  }

  #[test]
  fn test_t_returns_english_for_known_key() {
    ensure_init();
    let result = t("tray.noActiveEdits");
    assert_eq!(result, "No active edits");
  }
}
