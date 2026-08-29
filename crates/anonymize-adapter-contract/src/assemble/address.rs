//! `address_context_data` and `address_seed_data`.
//!
//! `address_context_data` ports `getAddressContextData`
//! (`filters/confidence-boost.ts`); `address_seed_data` ports
//! `getAddressSeedData` (`detectors/address-seeds.ts`). Both are emitted only
//! when the "address" label is allowed.
//!
//! The two share the "flatten a language-keyed dictionary" shape but differ in
//! case handling, exactly mirroring the TypeScript: prepositions and street
//! abbreviations are lowercased before deduping, while bare-house stopwords and
//! address-seed words keep their original casing (deduped by a lowercase key).

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, OrderedMap, StandaloneStreetDetection, parse_data_file,
  parse_ordered_data_file,
};

use super::AssembleContext;
use super::language::{language_config_matches, language_keyed_terms};
use crate::{
  BindingAddressContextData, BindingAddressSeedData,
  BindingStandaloneStreetData,
};

#[derive(Deserialize)]
struct AddressPrepositions {
  #[serde(default)]
  address: OrderedMap<Value>,
  #[serde(default)]
  temporal: OrderedMap<Value>,
}

#[derive(Deserialize)]
struct Conjunctions {
  #[serde(default)]
  coordinating: OrderedMap<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddressExitFollowers {
  #[serde(default)]
  after_coordinating_conjunction: OrderedMap<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddressContextJson {
  #[serde(default)]
  bare_house_stopwords: OrderedMap<Value>,
}

/// Mirrors `buildStreetTypePatterns` (`detectors/address-seeds.ts`): flatten
/// every array value of `address-street-types.json` in document order, no dedup
/// and no case change. Non-array values (the `_comment` string) are skipped.
///
/// # Errors
///
/// Returns [`AssembleError`] when `address-street-types.json` fails to parse.
pub(super) fn street_type_patterns() -> Result<Vec<String>, AssembleError> {
  let street_types: OrderedMap<Value> =
    parse_ordered_data_file("address-street-types.json")?;
  let mut words = Vec::new();
  for (_key, value) in &street_types {
    let Some(items) = value.as_array() else {
      continue;
    };
    for word in items {
      if let Some(word) = word.as_str() {
        words.push(word.to_string());
      }
    }
  }
  Ok(words)
}

// ── address_context_data ────────────────────────────

/// # Errors
///
/// Returns [`AssembleError`] when any backing data file fails to parse.
pub(super) fn build_address_context_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingAddressContextData>, AssembleError> {
  if !ctx.label_allowed("address") {
    return Ok(None);
  }
  let prepositions: AddressPrepositions =
    parse_data_file("address-prepositions.json")?;
  let street_types: OrderedMap<Value> =
    parse_ordered_data_file("address-street-types.json")?;
  let context: AddressContextJson = parse_data_file("address-context.json")?;

  Ok(Some(BindingAddressContextData {
    address_prepositions: dedup_lowercased(&language_record_values(
      &prepositions.address,
    )),
    temporal_prepositions: dedup_lowercased(&language_record_values(
      &prepositions.temporal,
    )),
    street_abbreviations: build_street_abbreviations(&street_types),
    bare_house_stopwords: dedup_exact(&language_record_values(
      &context.bare_house_stopwords,
    )),
  }))
}

/// Mirrors `languageRecordValues` with the identity transform: concatenate the
/// array values of every non-`_` language key, in order, without deduping.
fn language_record_values(record: &OrderedMap<Value>) -> Vec<String> {
  let mut values = Vec::new();
  for (language, words) in record {
    if language.starts_with('_') {
      continue;
    }
    let Some(items) = words.as_array() else {
      continue;
    };
    for word in items {
      if let Some(word) = word.as_str() {
        values.push(word.to_string());
      }
    }
  }
  values
}

/// JS `[...new Set(values.map(w => w.toLowerCase()))]`.
fn dedup_lowercased(values: &[String]) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut result = Vec::new();
  for value in values {
    let lowered = value.to_lowercase();
    if seen.insert(lowered.clone()) {
      result.push(lowered);
    }
  }
  result
}

/// JS `[...new Set(values)]`: first-occurrence dedup, original casing.
fn dedup_exact(values: &[String]) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut result = Vec::new();
  for value in values {
    if seen.insert(value.clone()) {
      result.push(value.clone());
    }
  }
  result
}

/// Mirrors `buildStreetAbbrevs`: lowercased words that contain a dot, deduped
/// in first-occurrence order across all non-`_` language keys.
fn build_street_abbreviations(street_types: &OrderedMap<Value>) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut result = Vec::new();
  for (key, words) in street_types {
    if key.starts_with('_') {
      continue;
    }
    let Some(items) = words.as_array() else {
      continue;
    };
    for word in items {
      let Some(word) = word.as_str() else {
        continue;
      };
      if !word.contains('.') {
        continue;
      }
      let lowered = word.to_lowercase();
      if seen.insert(lowered.clone()) {
        result.push(lowered);
      }
    }
  }
  result
}

// ── address_seed_data ───────────────────────────────

pub(super) struct AddressSharedData {
  boundary_words: Vec<String>,
  br_cep_cue_words: Vec<String>,
  pub(super) us_state_abbreviations: Vec<String>,
}

/// # Errors
///
/// Returns [`AssembleError`] when any backing data file fails to parse.
pub(super) fn build_address_shared_data(
  ctx: &AssembleContext<'_>,
) -> Result<AddressSharedData, AssembleError> {
  let boundaries: OrderedMap<Value> =
    parse_ordered_data_file("address-boundaries.json")?;
  let stop_keywords: OrderedMap<Value> =
    parse_ordered_data_file("address-stop-keywords.json")?;
  let street_types: OrderedMap<Value> =
    parse_ordered_data_file("address-street-types.json")?;
  let conjunctions: Conjunctions = parse_data_file("conjunctions.json")?;
  let exit_followers: AddressExitFollowers =
    parse_data_file("address-exit-followers.json")?;
  let scoped = super::language::apply_pipeline_language_scope(ctx.config)?;

  let mut boundary_words = Vec::new();
  extend_deduplicated(
    &mut boundary_words,
    scoped_boundary_words(&boundaries, ctx.content_languages.as_deref()),
  );
  extend_deduplicated(
    &mut boundary_words,
    scoped_boundary_words(&stop_keywords, ctx.content_languages.as_deref()),
  );
  extend_deduplicated(
    &mut boundary_words,
    contextual_conjunction_boundaries(&ContextualBoundaryData {
      conjunctions: &conjunctions.coordinating,
      followers: &exit_followers.after_coordinating_conjunction,
      selected_languages: ctx.content_languages.as_deref(),
    }),
  );

  // The deny list resolves regions and countries into one country set where
  // "empty" means "every country"; the state abbreviations must follow the
  // same set, or a region-only or empty scope loses them while keeping the
  // matching cities.
  let allowed_countries = super::deny_list::resolve_countries(
    ctx.config.deny_list_regions.as_deref(),
    scoped.deny_list_countries.as_deref(),
  );

  Ok(AddressSharedData {
    boundary_words,
    br_cep_cue_words: build_br_cue_words(&street_types, &boundaries),
    us_state_abbreviations: scoped_country_words(
      "address-state-abbreviations.json",
      "US",
      allowed_countries.as_deref(),
    )?,
  })
}

pub(super) fn build_address_seed_data(
  ctx: &AssembleContext<'_>,
  shared: &AddressSharedData,
) -> Result<Option<BindingAddressSeedData>, AssembleError> {
  let legal_form_boundaries_are_needed = ctx.label_allowed("organization")
    && ctx.config.enable_legal_forms != Some(false);
  if !ctx.label_allowed("address") && !legal_form_boundaries_are_needed {
    return Ok(None);
  }
  let unit_abbreviations: OrderedMap<Value> =
    parse_ordered_data_file("address-unit-abbreviations.json")?;

  Ok(Some(BindingAddressSeedData {
    boundary_words: shared.boundary_words.clone(),
    br_cep_cue_words: shared.br_cep_cue_words.clone(),
    unit_abbreviations: language_keyed_terms(
      &unit_abbreviations,
      ctx.content_languages.as_deref(),
    ),
    standalone_street: build_standalone_street_data(ctx)?,
  }))
}

/// Standalone street detection needs the street-type vocabulary at detection
/// time: a compound street name ("Hauptstraße") never reaches the whole-word
/// street-type automaton, so the detector matches those tails itself.
///
/// The whole-word automaton is assembled across every language, so the payload
/// carries only the selected languages' words and the detector scores nothing
/// outside them: an English-only pipeline must not detect "Hauptstraße 5".
/// Emitting the field only for opting-in callers keeps every other prepared
/// package unchanged.
fn build_standalone_street_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingStandaloneStreetData>, AssembleError> {
  if !ctx.label_allowed("address")
    || ctx.config.standalone_street_detection
      != StandaloneStreetDetection::HouseNumberAnchored
  {
    return Ok(None);
  }
  let street_type_words = scoped_street_type_words(ctx)?;
  if street_type_words.is_empty() {
    return Ok(None);
  }
  Ok(Some(BindingStandaloneStreetData { street_type_words }))
}

/// Mirrors `street_type_patterns`, restricted to the languages this pipeline
/// is scoped to. An unscoped pipeline keeps every language.
fn scoped_street_type_words(
  ctx: &AssembleContext<'_>,
) -> Result<Vec<String>, AssembleError> {
  let street_types: OrderedMap<Value> =
    parse_ordered_data_file("address-street-types.json")?;
  let mut words = Vec::new();
  for (language, value) in &street_types {
    if language.starts_with('_')
      || !language_config_matches(language, ctx.content_languages.as_deref())
    {
      continue;
    }
    let Some(items) = value.as_array() else {
      continue;
    };
    for word in items.iter().filter_map(Value::as_str) {
      words.push(word.to_string());
    }
  }
  Ok(words)
}

fn scoped_country_words(
  file: &str,
  country: &str,
  selected_countries: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  if selected_countries
    .is_some_and(|selected| !selected.iter().any(|value| value == country))
  {
    return Ok(Vec::new());
  }
  let values: OrderedMap<Value> = parse_ordered_data_file(file)?;
  Ok(
    values
      .get(country)
      .and_then(Value::as_array)
      .into_iter()
      .flatten()
      .filter_map(Value::as_str)
      .map(ToOwned::to_owned)
      .collect(),
  )
}

fn scoped_boundary_words(
  record: &OrderedMap<Value>,
  selected_languages: Option<&[String]>,
) -> Vec<String> {
  let mut words = Vec::new();
  for (language, values) in record {
    if language != "universal"
      && !language_config_matches(language, selected_languages)
    {
      continue;
    }
    let Some(values) = values.as_array() else {
      continue;
    };
    words.extend(
      values
        .iter()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned),
    );
  }
  words
}

struct ContextualBoundaryData<'a> {
  conjunctions: &'a OrderedMap<Value>,
  followers: &'a OrderedMap<Value>,
  selected_languages: Option<&'a [String]>,
}

/// A conjunction can join address components, so it becomes an address exit
/// only when followed by a same-language notice or delivery phrase.
fn contextual_conjunction_boundaries(
  data: &ContextualBoundaryData<'_>,
) -> Vec<String> {
  let mut boundaries = Vec::new();
  for (language, conjunction_values) in data.conjunctions {
    if !language_config_matches(language, data.selected_languages) {
      continue;
    }
    let Some(conjunction_values) = conjunction_values.as_array() else {
      continue;
    };
    let Some(follower_values) =
      data.followers.get(language).and_then(Value::as_array)
    else {
      continue;
    };
    for conjunction in conjunction_values.iter().filter_map(Value::as_str) {
      for follower in follower_values.iter().filter_map(Value::as_str) {
        if !conjunction.is_empty() && !follower.is_empty() {
          boundaries.push(format!("{conjunction} {follower}"));
        }
      }
    }
  }
  boundaries
}

fn extend_deduplicated(words: &mut Vec<String>, additions: Vec<String>) {
  let mut seen = words
    .iter()
    .map(|word| word.to_lowercase())
    .collect::<HashSet<_>>();
  for word in additions {
    if !word.is_empty() && seen.insert(word.to_lowercase()) {
      words.push(word);
    }
  }
}

/// Mirrors `loadBrCueWords`: the `pt-br` arrays of `address-street-types` then
/// `address-boundaries`, deduped by lowercase in first-occurrence order.
fn build_br_cue_words(
  street_types: &OrderedMap<Value>,
  boundaries: &OrderedMap<Value>,
) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for source in [street_types, boundaries] {
    let Some((_, value)) = source.iter().find(|(key, _)| key == "pt-br") else {
      continue;
    };
    let Some(items) = value.as_array() else {
      continue;
    };
    for item in items {
      let Some(word) = item.as_str() else {
        continue;
      };
      if word.is_empty() {
        continue;
      }
      if seen.insert(word.to_lowercase()) {
        out.push(word.to_string());
      }
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use stella_anonymize_core::assemble::{
    AssembleError, PipelineConfig, StandaloneStreetDetection, parse_data_file,
  };

  use super::{
    AssembleContext, Conjunctions, build_address_seed_data,
    build_address_shared_data, build_standalone_street_data,
    language_record_values,
  };

  fn config(languages: Vec<String>) -> PipelineConfig {
    PipelineConfig {
      threshold: 0.5,
      enable_trigger_phrases: false,
      enable_regex: false,
      languages: Some(languages),
      language: None,
      enable_legal_forms: Some(false),
      enable_name_corpus: false,
      name_corpus_languages: None,
      enable_deny_list: false,
      deny_list_countries: None,
      deny_list_regions: None,
      deny_list_exclude_categories: None,
      custom_deny_list: None,
      custom_regexes: None,
      enable_gazetteer: false,
      enable_countries: Some(false),
      enable_confidence_boost: false,
      enable_coreference: false,
      enable_zone_classification: Some(false),
      enable_hotword_rules: Some(false),
      standalone_street_detection: StandaloneStreetDetection::default(),
      labels: vec![String::from("address")],
      workspace_id: String::from("address-language-test"),
      dictionaries: None,
    }
  }

  fn standalone_street_words(
    languages: &[&str],
  ) -> Result<Vec<String>, AssembleError> {
    let mut config = config(
      languages
        .iter()
        .map(|language| (*language).to_owned())
        .collect(),
    );
    config.standalone_street_detection =
      StandaloneStreetDetection::HouseNumberAnchored;
    let context = AssembleContext {
      config: &config,
      dictionaries: None,
      content_languages: config.languages.clone(),
      allowed_labels: None,
    };
    Ok(
      build_standalone_street_data(&context)?
        .map(|data| data.street_type_words)
        .unwrap_or_default(),
    )
  }

  fn unit_abbreviations(
    languages: &[&str],
  ) -> Result<Vec<String>, AssembleError> {
    let config = config(
      languages
        .iter()
        .map(|language| (*language).to_owned())
        .collect(),
    );
    let context = AssembleContext {
      config: &config,
      dictionaries: None,
      content_languages: config.languages.clone(),
      allowed_labels: None,
    };
    let shared = build_address_shared_data(&context)?;
    Ok(
      build_address_seed_data(&context, &shared)?
        .map(|data| data.unit_abbreviations)
        .unwrap_or_default(),
    )
  }

  #[test]
  fn unit_abbreviations_follow_language_scope() -> Result<(), AssembleError> {
    assert!(
      unit_abbreviations(&["en"])?
        .iter()
        .any(|word| word == "apt.")
    );
    assert!(unit_abbreviations(&["de"])?.is_empty());
    Ok(())
  }

  #[test]
  fn standalone_street_vocabulary_follows_language_scope()
  -> Result<(), AssembleError> {
    let english = standalone_street_words(&["en"])?;
    assert!(english.iter().any(|word| word == "Street"));
    assert!(!english.iter().any(|word| word == "Stra\u{df}e"));
    assert!(!english.iter().any(|word| word == "rue"));

    let german = standalone_street_words(&["de"])?;
    assert!(german.iter().any(|word| word == "Stra\u{df}e"));
    assert!(!german.iter().any(|word| word == "Street"));

    let both = standalone_street_words(&["de", "en"])?;
    assert!(both.iter().any(|word| word == "Street"));
    assert!(both.iter().any(|word| word == "Stra\u{df}e"));
    Ok(())
  }

  #[test]
  fn standalone_street_data_is_absent_without_scoped_street_types()
  -> Result<(), AssembleError> {
    assert!(standalone_street_words(&["ja"])?.is_empty());
    Ok(())
  }

  #[test]
  fn standalone_street_data_is_absent_unless_the_caller_opts_in()
  -> Result<(), AssembleError> {
    let config = config(vec![String::from("de")]);
    let context = AssembleContext {
      config: &config,
      dictionaries: None,
      content_languages: config.languages.clone(),
      allowed_labels: None,
    };
    assert_eq!(build_standalone_street_data(&context)?, None);
    Ok(())
  }

  fn boundary_words(languages: &[&str]) -> Result<Vec<String>, AssembleError> {
    let config = config(
      languages
        .iter()
        .map(|language| (*language).to_owned())
        .collect(),
    );
    let context = AssembleContext {
      config: &config,
      dictionaries: None,
      content_languages: config.languages.clone(),
      allowed_labels: None,
    };
    Ok(build_address_shared_data(&context)?.boundary_words)
  }

  fn state_abbreviations(
    countries: &[&str],
  ) -> Result<Vec<String>, AssembleError> {
    scoped_state_abbreviations(countries, &[])
  }

  fn scoped_state_abbreviations(
    countries: &[&str],
    regions: &[&str],
  ) -> Result<Vec<String>, AssembleError> {
    let mut config = config(Vec::new());
    config.deny_list_countries = Some(
      countries
        .iter()
        .map(|country| (*country).to_owned())
        .collect(),
    );
    config.deny_list_regions =
      Some(regions.iter().map(|region| (*region).to_owned()).collect());
    let context = AssembleContext {
      config: &config,
      dictionaries: None,
      content_languages: config.languages.clone(),
      allowed_labels: None,
    };
    Ok(build_address_shared_data(&context)?.us_state_abbreviations)
  }

  #[test]
  fn state_abbreviations_follow_country_scope() -> Result<(), AssembleError> {
    assert!(
      state_abbreviations(&["US"])?
        .iter()
        .any(|state| state == "DE")
    );
    assert!(state_abbreviations(&["DE"])?.is_empty());
    Ok(())
  }

  /// An empty country list means "every country" to `resolveCountries`, so it
  /// must not strip the US state abbreviations either.
  #[test]
  fn empty_country_scope_keeps_us_states() -> Result<(), AssembleError> {
    assert!(state_abbreviations(&[])?.iter().any(|state| state == "DE"));
    Ok(())
  }

  /// A region that resolves to the US pulls in US cities, so it must pull in
  /// the US state abbreviations even when `denyListCountries` omits "US".
  #[test]
  fn region_scope_keeps_us_states() -> Result<(), AssembleError> {
    assert!(
      scoped_state_abbreviations(&["GB"], &["Americas"])?
        .iter()
        .any(|state| state == "DE")
    );
    assert!(scoped_state_abbreviations(&["GB"], &["Europe"])?.is_empty());
    Ok(())
  }

  fn assert_no_bare_conjunctions(
    boundaries: &[String],
  ) -> Result<(), AssembleError> {
    let conjunctions: Conjunctions = parse_data_file("conjunctions.json")?;
    for conjunction in language_record_values(&conjunctions.coordinating) {
      assert!(!boundaries.iter().any(|word| word == &conjunction));
    }
    Ok(())
  }

  #[test]
  fn contextual_boundaries_follow_english_scope() -> Result<(), AssembleError> {
    let boundaries = boundary_words(&["en"])?;

    assert!(boundaries.iter().any(|word| word == "attention"));
    assert!(!boundaries.iter().any(|word| word == "bank"));
    assert!(boundaries.iter().any(|word| word == "or emailed"));
    assert!(boundaries.iter().any(|word| word == "or sent"));
    assert!(boundaries.iter().any(|word| word == "and delivered"));
    assert!(boundaries.iter().any(|word| word == "and provide"));
    assert!(boundaries.iter().any(|word| word == "or at"));
    assert!(boundaries.iter().any(|word| word == "and by"));
    assert!(boundaries.iter().any(|word| word == "or to"));
    assert!(boundaries.iter().any(|word| word == "or via"));
    assert_no_bare_conjunctions(&boundaries)?;
    Ok(())
  }

  #[test]
  fn unreviewed_german_scope_has_no_contextual_boundaries()
  -> Result<(), AssembleError> {
    let boundaries = boundary_words(&["de"])?;

    assert!(boundaries.iter().any(|word| word == "bank"));
    assert!(!boundaries.iter().any(|word| word == "attention"));
    assert!(!boundaries.iter().any(|word| word == "or emailed"));
    assert!(!boundaries.iter().any(|word| word == "or sent"));
    assert!(!boundaries.iter().any(|word| word == "and delivered"));
    assert!(!boundaries.iter().any(|word| word == "and provide"));
    assert!(!boundaries.iter().any(|word| word == "or at"));
    assert!(!boundaries.iter().any(|word| word == "and by"));
    assert!(!boundaries.iter().any(|word| word == "or to"));
    assert!(!boundaries.iter().any(|word| word == "or via"));
    assert_no_bare_conjunctions(&boundaries)?;
    Ok(())
  }

  #[test]
  fn multilingual_scope_includes_selected_reviewed_english_grammar()
  -> Result<(), AssembleError> {
    let boundaries = boundary_words(&["de", "en"])?;
    let english_only = boundary_words(&["en"])?;

    assert!(boundaries.iter().any(|word| word == "or emailed"));
    assert!(boundaries.iter().any(|word| word == "or sent"));
    assert!(boundaries.iter().any(|word| word == "and provide"));
    assert!(boundaries.iter().any(|word| word == "bank"));
    assert!(
      english_only
        .iter()
        .all(|word| boundaries.iter().any(|candidate| candidate == word))
    );
    assert_no_bare_conjunctions(&boundaries)?;
    Ok(())
  }
}
