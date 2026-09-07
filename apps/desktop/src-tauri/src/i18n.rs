use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};

use crate::config::APP_DATA_DIR_NAME;

/// The locale the native strings render in. It lives here rather than in
/// Tauri's managed state because `t` is called from places that hold no
/// `AppHandle`: the session manager, the retry loop, the tray builder.
static ACTIVE: RwLock<Option<&'static Translations>> = RwLock::new(None);

/// Catalogues parsed so far, kept for the process lifetime so `t` can hand out
/// a `&str` that outlives a locale change. Bounded by the shipped locales.
static PARSED: Mutex<Vec<&'static Translations>> = Mutex::new(Vec::new());

/// The saved language, one locale tag. Absent means "follow the system", which
/// is also what an unreadable or unrecognised file means.
const LANGUAGE_FILE_NAME: &str = "language";

struct Translations {
  locale: &'static str,
  messages: HashMap<String, String>,
  fallback: &'static HashMap<String, String>,
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

fn english_messages() -> &'static HashMap<String, String> {
  static ENGLISH: OnceLock<HashMap<String, String>> = OnceLock::new();
  ENGLISH.get_or_init(|| {
    parse_locale(locale_source("en").map_or("{}", |(_, source)| source))
  })
}

fn translations_for(
  locale: &'static str,
  source: &'static str,
) -> &'static Translations {
  let mut parsed = PARSED.lock().expect("i18n catalogue cache");
  if let Some(cached) = parsed.iter().copied().find(|t| t.locale == locale) {
    return cached;
  }

  let built: &'static Translations = Box::leak(Box::new(Translations {
    locale,
    messages: parse_locale(source),
    fallback: english_messages(),
  }));
  parsed.push(built);
  built
}

fn active() -> &'static Translations {
  let guard = ACTIVE.read().expect("i18n active locale");
  guard.expect("i18n not initialized; call i18n::init() first")
}

/// The locale the native strings currently render in.
pub fn active_locale() -> &'static str {
  active().locale
}

/// Renders the native strings in `tag`'s locale from here on. Returns the
/// locale that was resolved, or `None` when the app ships nothing for `tag`.
pub fn set_active_locale(tag: &str) -> Option<&'static str> {
  let locale = resolve_locale(tag)?;
  let (locale, source) = locale_source(locale)?;
  let translations = translations_for(locale, source);
  *ACTIVE.write().expect("i18n active locale") = Some(translations);
  Some(locale)
}

/// The saved language wins over the system's: it is the one the user picked in
/// this app, and it must survive a system whose locale says otherwise.
fn choose_startup_locale(
  saved: Option<&'static str>,
  system: Option<&'static str>,
) -> &'static str {
  saved.or(system).unwrap_or("en")
}

fn system_locale() -> Option<&'static str> {
  sys_locale::get_locale().and_then(|tag| resolve_locale(&tag))
}

/// Initialize the translation system. Call once at startup.
pub fn init() {
  let saved = saved_language_path()
    .as_deref()
    .and_then(read_language_file)
    .and_then(|tag| resolve_locale(&tag));
  set_active_locale(choose_startup_locale(saved, system_locale()));
}

/// Initialize with English. Tests read the source catalogue, never the saved
/// language, so a developer's own preference cannot change what they assert.
#[cfg(test)]
pub fn init_en() {
  set_active_locale("en");
}

fn saved_language_path() -> Option<PathBuf> {
  dirs::data_dir()
    .map(|data_dir| data_dir.join(APP_DATA_DIR_NAME).join(LANGUAGE_FILE_NAME))
}

/// Reads the saved locale tag. Only a regular file counts: a directory or a
/// symlink at the path is never read, as with the app-data marker files.
fn read_language_file(path: &Path) -> Option<String> {
  if !fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file()) {
    return None;
  }
  let raw = fs::read_to_string(path).ok()?;
  let tag = raw.trim();
  (!tag.is_empty()).then(|| tag.to_string())
}

fn write_language_file(path: &Path, locale: &str) -> Result<(), String> {
  match fs::symlink_metadata(path) {
    Ok(meta) if !meta.file_type().is_file() => {
      return Err("saved language path is not a regular file".to_string());
    }
    _ => {}
  }

  let parent = path
    .parent()
    .ok_or_else(|| "saved language path is invalid".to_string())?;
  fs::create_dir_all(parent)
    .map_err(|error| format!("saved language directory failed: {error}"))?;

  // Written beside the target and renamed into place, as the clipboard store
  // does: the rename replaces whatever sits at the path in one step instead
  // of following a link planted there after the check above.
  let temp_path = path.with_extension(format!(
    "{}.{}.tmp",
    std::process::id(),
    uuid::Uuid::new_v4()
  ));
  if let Err(error) = fs::write(&temp_path, locale) {
    let _ = fs::remove_file(&temp_path);
    return Err(format!("saved language write failed: {error}"));
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;

    if let Err(error) =
      fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600))
    {
      let _ = fs::remove_file(&temp_path);
      return Err(format!("saved language permissions failed: {error}"));
    }
  }
  if let Err(error) = fs::rename(&temp_path, path) {
    let _ = fs::remove_file(&temp_path);
    return Err(format!("saved language replace failed: {error}"));
  }
  Ok(())
}

/// Saves `locale` so the next launch renders native strings in it before any
/// window exists. Writing only on a change keeps a window's start-up
/// reconciliation from touching the disk on every launch.
fn persist_language(locale: &str) -> Result<(), String> {
  let path = saved_language_path()
    .ok_or_else(|| "app data directory is unavailable".to_string())?;
  if read_language_file(&path).as_deref() == Some(locale) {
    return Ok(());
  }
  write_language_file(&path, locale)
}

/// Right-to-left locales, as the shared direction map the web app reads
/// declares them. A test pins this list to that map.
const RTL_LOCALES: &[&str] = &["ar"];

/// The direction the active locale lays out in, for a window that has no
/// bundle of its own to read it from.
pub fn text_direction() -> &'static str {
  if RTL_LOCALES.contains(&active_locale()) {
    "rtl"
  } else {
    "ltr"
  }
}

/// The catalogue entries under `namespace`, keyed by their leaf name, as a
/// JSON object. The dialog windows render from this rather than carrying
/// their own copies of the strings, so their keys live in the catalogues with
/// everything else and the parity test covers them.
pub fn namespace_json(namespace: &str) -> String {
  let tr = active();
  let prefix = format!("{namespace}.");
  let mut entries = serde_json::Map::new();
  // English first so a locale that is missing a key still renders something.
  for source in [tr.fallback, &tr.messages] {
    for (key, value) in source {
      if let Some(leaf) = key.strip_prefix(&prefix) {
        entries.insert(leaf.to_string(), serde_json::Value::String(value.clone()));
      }
    }
  }
  serde_json::Value::Object(entries).to_string()
}

/// The locale the native strings render in, for a window that has to agree
/// with them.
#[tauri::command]
pub fn get_desktop_language() -> String {
  active_locale().to_string()
}

/// Switches the native strings to `language` and saves the choice. The tray
/// menu is the one native string that is built once and cached, so it is
/// rebuilt here; notifications and dialogs render when they are shown.
#[tauri::command]
pub async fn set_desktop_language(
  language: String,
  app: tauri::AppHandle,
  state: tauri::State<'_, crate::commands::AppState>,
) -> Result<String, String> {
  let unshipped = || format!("stella desktop does not ship the language {language}.");
  let locale = resolve_locale(&language).ok_or_else(unshipped)?;
  // Saved before it goes live: a choice the disk refused must not become the
  // locale the notifications already render in while the tray and the
  // windows stay behind, and the next launch would revert it anyway.
  persist_language(locale)?;

  let previous = active_locale();
  let locale = set_active_locale(locale).ok_or_else(unshipped)?;

  if locale != previous {
    let snapshot = state.lock().await.get_snapshot();
    crate::tray::refresh(&app, &snapshot);
  }

  Ok(locale.to_string())
}

/// Look up a translation key. Falls back to English, then returns the key itself.
pub fn t(key: &str) -> &str {
  let tr = active();
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
  let tr = active();
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

  /// The web app reads its directions from `packages/locales`; a dialog window
  /// has no bundle to read them from, so the list here is a second copy. This
  /// reads the shared map so the copy cannot quietly disagree with it, and
  /// fails if a shipped locale is missing from the map altogether.
  #[test]
  fn rtl_locales_match_the_shared_direction_map() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../../../packages/locales/src/directions.ts");
    let source = std::fs::read_to_string(&path).expect("shared direction map");

    let mut mapped: Vec<(String, String)> = Vec::new();
    for line in source.lines() {
      let Some((left, right)) = line.split_once(':') else {
        continue;
      };
      let locale = left.trim().trim_matches('"');
      let Some(direction) = right.trim().strip_prefix('"') else {
        continue;
      };
      let Some(direction) = direction.split('"').next() else {
        continue;
      };
      if direction == "ltr" || direction == "rtl" {
        mapped.push((locale.to_string(), direction.to_string()));
      }
    }

    let mut declared: Vec<String> =
      LOCALES.iter().map(|(l, _)| (*l).to_string()).collect();
    declared.sort();
    let mut mapped_locales: Vec<String> =
      mapped.iter().map(|(locale, _)| locale.clone()).collect();
    mapped_locales.sort();
    assert_eq!(declared, mapped_locales);

    let mut shared_rtl: Vec<&str> = mapped
      .iter()
      .filter(|(_, direction)| direction == "rtl")
      .map(|(locale, _)| locale.as_str())
      .collect();
    shared_rtl.sort_unstable();
    let mut ours = RTL_LOCALES.to_vec();
    ours.sort_unstable();
    assert_eq!(ours, shared_rtl);
  }

  #[test]
  fn dialog_strings_come_from_the_catalogue() {
    ensure_init();
    let strings: serde_json::Value =
      serde_json::from_str(&namespace_json("dialog")).unwrap();

    assert_eq!(strings["deny"], "Deny");
    assert_eq!(
      strings["takeoverTitle"],
      "{requester} wants to take over editing"
    );
    // The namespace prefix is stripped and nothing outside it leaks in.
    assert!(strings.get("dialog.deny").is_none());
    assert!(strings.get("settings").is_none());
  }

  // -- startup resolution --

  fn unique_path() -> PathBuf {
    std::env::temp_dir().join(format!("stella-language-{}", uuid::Uuid::new_v4()))
  }

  #[test]
  fn saved_language_beats_the_system_locale() {
    assert_eq!(choose_startup_locale(Some("cs"), Some("de")), "cs");
  }

  #[test]
  fn system_locale_applies_when_nothing_is_saved() {
    assert_eq!(choose_startup_locale(None, Some("de")), "de");
  }

  #[test]
  fn english_applies_when_neither_resolves() {
    assert_eq!(choose_startup_locale(None, None), "en");
  }

  #[test]
  fn a_saved_language_round_trips() {
    let path = unique_path();
    assert_eq!(read_language_file(&path), None);

    write_language_file(&path, "pt-BR").unwrap();
    assert_eq!(read_language_file(&path).as_deref(), Some("pt-BR"));

    write_language_file(&path, "ar").unwrap();
    assert_eq!(read_language_file(&path).as_deref(), Some("ar"));

    fs::remove_file(&path).unwrap();
  }

  #[test]
  fn a_directory_is_never_a_saved_language() {
    let path = unique_path();
    fs::create_dir(&path).unwrap();

    assert_eq!(read_language_file(&path), None);
    assert!(write_language_file(&path, "cs").is_err());

    fs::remove_dir(&path).unwrap();
  }

  #[test]
  fn an_unrecognised_saved_language_is_ignored() {
    let path = unique_path();
    write_language_file(&path, "kl-GL").unwrap();

    let saved = read_language_file(&path).and_then(|tag| resolve_locale(&tag));
    assert_eq!(choose_startup_locale(saved, Some("de")), "de");

    fs::remove_file(&path).unwrap();
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
