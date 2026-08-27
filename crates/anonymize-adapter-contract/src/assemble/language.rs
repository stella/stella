//! Language-scope helpers shared by the templating field builders.
//!
//! Ports `configuredContentLanguages` (`language-scope.ts`) plus the two
//! per-field language matchers used by the ported getters:
//! `selectedLanguageKeys` (`detectors/regex.ts`, date scoping) and
//! `signingClauseLanguageMatches` (`build-unified-search.ts`, zone scoping).
//! `applyPipelineLanguageScope` is ported here because name-corpus and
//! deny-list assembly both consume its derived scopes.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, OrderedMap, PipelineConfig, parse_data_file,
};

/// Effective `nameCorpusLanguages` / `denyListCountries` after
/// `applyPipelineLanguageScope`.
pub(super) struct ScopedLanguages {
  pub name_corpus_languages: Option<Vec<String>>,
  pub deny_list_countries: Option<Vec<String>>,
}

/// A single `language-scopes.json` entry.
#[derive(Deserialize)]
struct LanguageScope {
  #[serde(default, rename = "nameCorpusLanguages")]
  name_corpus_languages: Vec<String>,
  #[serde(default, rename = "denyListCountries")]
  deny_list_countries: Vec<String>,
}

/// The `language-scopes.json` document.
#[derive(Deserialize)]
struct ScopeData {
  #[serde(default)]
  languages: std::collections::BTreeMap<String, LanguageScope>,
}

/// Mirrors `configuredLanguages`: `languages` if present (even empty), else the
/// single `language` wrapped, else empty.
fn configured_languages(config: &PipelineConfig) -> Vec<String> {
  if let Some(languages) = config.languages.as_ref() {
    return languages.clone();
  }
  config
    .language
    .as_ref()
    .map(|language| vec![language.clone()])
    .unwrap_or_default()
}

/// Mirrors `uniquePush`: append values not already present, order preserved.
fn unique_push(target: &mut Vec<String>, values: &[String]) {
  let mut seen: HashSet<String> = target.iter().cloned().collect();
  for value in values {
    if seen.insert(value.clone()) {
      target.push(value.clone());
    }
  }
}

/// Mirrors `applyPipelineLanguageScope`: derives `nameCorpusLanguages` and
/// `denyListCountries` from the configured content languages via
/// `language-scopes.json`, but only fills a field the caller left unset.
///
/// # Errors
///
/// Returns [`AssembleError`] when `language-scopes.json` fails to parse.
pub(super) fn apply_pipeline_language_scope(
  config: &PipelineConfig,
) -> Result<ScopedLanguages, AssembleError> {
  let languages = configured_languages(config);
  if languages.is_empty() {
    return Ok(ScopedLanguages {
      name_corpus_languages: config.name_corpus_languages.clone(),
      deny_list_countries: config.deny_list_countries.clone(),
    });
  }

  let scope_data: ScopeData = parse_data_file("language-scopes.json")?;

  let mut name_corpus_languages: Vec<String> = Vec::new();
  let mut deny_list_countries: Vec<String> = Vec::new();
  let mut has_resolved_scope = false;
  for language in &languages {
    let normalized = normalize_language_key(language);
    if normalized.is_empty() {
      continue;
    }
    let scope = scope_data.languages.get(&normalized).or_else(|| {
      normalized
        .split_once('-')
        .and_then(|(base, _)| scope_data.languages.get(base))
    });
    let Some(scope) = scope else {
      continue;
    };
    has_resolved_scope = true;
    unique_push(&mut name_corpus_languages, &scope.name_corpus_languages);
    unique_push(&mut deny_list_countries, &scope.deny_list_countries);
  }

  Ok(ScopedLanguages {
    name_corpus_languages: config
      .name_corpus_languages
      .clone()
      .or_else(|| has_resolved_scope.then_some(name_corpus_languages)),
    deny_list_countries: config
      .deny_list_countries
      .clone()
      .or_else(|| has_resolved_scope.then_some(deny_list_countries)),
  })
}

/// Mirrors `configuredContentLanguages`: prefer `languages` (even when empty),
/// fall back to the single `language`, else `None` for "all languages".
pub(super) fn configured_content_languages(
  config: &PipelineConfig,
) -> Option<Vec<String>> {
  if let Some(languages) = config.languages.as_ref() {
    return Some(languages.clone());
  }
  config
    .language
    .as_ref()
    .map(|language| vec![language.clone()])
}

/// Mirrors `normalizeLanguageKey`: JS `language.trim().toLowerCase()`.
pub(super) fn normalize_language_key(language: &str) -> String {
  language.trim().to_lowercase()
}

/// Mirrors `selectedLanguageKeys`: the normalized selection plus each base
/// language (before `-`), or `None` when nothing usable was selected.
pub(super) fn selected_language_keys(
  languages: Option<&[String]>,
) -> Option<HashSet<String>> {
  let languages = languages?;
  if languages.is_empty() {
    return None;
  }
  let mut selected = HashSet::new();
  for language in languages {
    let normalized = normalize_language_key(language);
    if normalized.is_empty() {
      continue;
    }
    if let Some((base, _)) = normalized.split_once('-') {
      selected.insert(base.to_string());
    }
    selected.insert(normalized);
  }
  if selected.is_empty() {
    None
  } else {
    Some(selected)
  }
}

/// Mirrors `baseLanguage`: the segment before the first `-`, or the whole
/// string when there is none.
fn base_language(language: &str) -> &str {
  language.split('-').next().unwrap_or(language)
}

/// Mirrors `languageConfigMatches` from `util/language-selection.ts`.
pub(super) fn language_config_matches(
  config_language: &str,
  selected: Option<&[String]>,
) -> bool {
  let Some(selected) = selected else {
    return true;
  };
  let normalized_selected: Vec<String> = selected
    .iter()
    .map(|language| normalize_language_key(language))
    .filter(|language| !language.is_empty())
    .collect();
  if normalized_selected.is_empty() {
    return true;
  }
  let normalized_config = normalize_language_key(config_language);
  if normalized_config.is_empty() {
    return false;
  }
  let generic_config = base_language(&normalized_config) == normalized_config;
  normalized_selected.iter().any(|language| {
    language == &normalized_config
      || (generic_config && base_language(language) == normalized_config)
  })
}

/// Mirrors `languageKeyedTerms`: concatenate the array values of every language
/// that matches the selection (`und` always matches), then dedup by exact
/// string keeping first-occurrence order (`uniqueStrings`).
pub(super) fn language_keyed_terms(
  values: &OrderedMap<Value>,
  selected: Option<&[String]>,
) -> Vec<String> {
  let mut result = Vec::new();
  let mut seen = HashSet::new();
  for (language, terms) in values {
    let Some(terms) = terms.as_array() else {
      continue;
    };
    if language != "und" && !language_config_matches(language, selected) {
      continue;
    }
    for term in terms {
      let Some(term) = term.as_str() else {
        continue;
      };
      if seen.insert(term.to_string()) {
        result.push(term.to_string());
      }
    }
  }
  result
}

/// Mirrors `signingClauseLanguageMatches`: no selection matches everything;
/// otherwise the entry language must equal a selected language or its base.
pub(super) fn signing_clause_language_matches(
  entry_language: &str,
  selected: Option<&[String]>,
) -> bool {
  let Some(selected) = selected else {
    return true;
  };
  if selected.is_empty() {
    return true;
  }
  let normalized_entry = entry_language.to_lowercase();
  selected.iter().any(|language| {
    let normalized = language.trim().to_lowercase();
    normalized == normalized_entry
      || normalized.split('-').next() == Some(normalized_entry.as_str())
  })
}

#[cfg(test)]
mod tests {
  #![allow(clippy::expect_used)]

  use stella_anonymize_core::assemble::{
    PipelineConfig, StandaloneStreetDetection,
  };

  use super::apply_pipeline_language_scope;

  fn pipeline_config(language: &str) -> PipelineConfig {
    PipelineConfig {
      threshold: 0.3,
      enable_trigger_phrases: true,
      enable_regex: true,
      languages: None,
      language: Some(String::from(language)),
      enable_legal_forms: Some(true),
      enable_name_corpus: true,
      name_corpus_languages: None,
      enable_deny_list: true,
      deny_list_countries: None,
      deny_list_regions: None,
      deny_list_exclude_categories: None,
      custom_deny_list: None,
      custom_regexes: None,
      enable_gazetteer: false,
      enable_countries: Some(true),
      enable_confidence_boost: true,
      enable_coreference: true,
      enable_zone_classification: Some(true),
      enable_hotword_rules: Some(true),
      standalone_street_detection: StandaloneStreetDetection::default(),
      labels: Vec::new(),
      workspace_id: String::from("language-scope-test"),
      dictionaries: None,
    }
  }

  #[test]
  fn preserves_a_supported_languages_empty_name_scope() {
    let scoped = apply_pipeline_language_scope(&pipeline_config("lv"))
      .expect("Latvian language scope should parse");

    assert_eq!(scoped.name_corpus_languages, Some(Vec::new()));
    assert_eq!(scoped.deny_list_countries, Some(vec![String::from("LV")]));
  }
}
