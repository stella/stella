//! Golden parity: the Rust assembler must reproduce the TypeScript
//! `buildNativeStaticSearchBundle` output for every field of the native static
//! config.
//!
//! Each `<name>.input.json` holds the `{ config, gazetteer }` inputs. One full
//! baseline plus per-fixture structural deltas reconstructs every frozen native
//! static config. This test still compares every field (large arrays via a
//! targeted first-difference report); the companion `assemble_digest` test then
//! proves the assembled config is byte-identical end to end. Deliberate
//! behavior changes require an independent source and explicit manual review,
//! as documented alongside the fixtures.

pub mod assemble_support;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use stella_anonymize_adapter_contract::{
  BindingPreparedSearchConfig, assemble_static_search_config,
};
use stella_anonymize_core::assemble::{GazetteerEntry, PipelineConfig};

use assemble_support::read_expected_value;

#[derive(Deserialize)]
struct FixtureInput {
  config: PipelineConfig,
  #[serde(default)]
  gazetteer: Vec<GazetteerEntry>,
}

fn fixtures_dir() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/assemble")
}

fn collect_input_paths(dir: &Path) -> Result<Vec<PathBuf>, String> {
  let mut paths = Vec::new();
  let entries =
    fs::read_dir(dir).map_err(|error| format!("read_dir failed: {error}"))?;
  for entry in entries {
    let path = entry.map_err(|error| format!("dir entry: {error}"))?.path();
    let is_input = path
      .file_name()
      .and_then(|name| name.to_str())
      .is_some_and(|name| name.ends_with(".input.json"));
    if is_input {
      paths.push(path);
    }
  }
  paths.sort();
  Ok(paths)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
  let text = fs::read_to_string(path)
    .map_err(|error| format!("read {}: {error}", path.display()))?;
  serde_json::from_str(&text)
    .map_err(|error| format!("parse {}: {error}", path.display()))
}

fn first_json_difference(
  path: &str,
  actual: &Value,
  expected: &Value,
) -> String {
  match (actual, expected) {
    (Value::Object(actual), Value::Object(expected)) => {
      for key in actual.keys().chain(expected.keys()) {
        if actual.get(key) == expected.get(key) {
          continue;
        }
        let child_path = format!("{path}.{key}");
        return match (actual.get(key), expected.get(key)) {
          (Some(actual), Some(expected)) => {
            first_json_difference(&child_path, actual, expected)
          }
          (actual, expected) => {
            format!("{child_path}: {actual:?} != {expected:?}")
          }
        };
      }
      format!("{path}: object key order differs")
    }
    (Value::Array(actual), Value::Array(expected)) => {
      for (index, (actual_item, expected_item)) in
        actual.iter().zip(expected.iter()).enumerate()
      {
        if actual_item != expected_item {
          return first_json_difference(
            &format!("{path}[{index}]"),
            actual_item,
            expected_item,
          );
        }
      }
      format!("{path}.length: {} != {}", actual.len(), expected.len())
    }
    _ => format!("{path}: {actual:?} != {expected:?}"),
  }
}

fn serialized_difference<T: Serialize>(actual: &T, expected: &T) -> String {
  let actual = serde_json::to_value(actual)
    .unwrap_or_else(|error| Value::String(error.to_string()));
  let expected = serde_json::to_value(expected)
    .unwrap_or_else(|error| Value::String(error.to_string()));
  first_json_difference("config", &actual, &expected)
}

/// Requires full structural equality, then reports the first mismatch through
/// the existing field-focused diagnostics when possible.
fn compare_full_config(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual == expected {
    return Ok(());
  }
  compare_field_diagnostics(name, actual, expected)?;
  Err(format!(
    "{name}: full prepared config differs outside the targeted diagnostics: {}",
    serialized_difference(actual, expected)
  ))
}

fn compare_field_diagnostics(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.allowed_labels != expected.allowed_labels {
    return Err(format!(
      "{name}: allowed_labels {:?} != {:?}",
      actual.allowed_labels, expected.allowed_labels
    ));
  }
  if actual.threshold.to_bits() != expected.threshold.to_bits() {
    return Err(format!(
      "{name}: threshold {} != {}",
      actual.threshold, expected.threshold
    ));
  }
  if actual.confidence_boost != expected.confidence_boost {
    return Err(format!(
      "{name}: confidence_boost {} != {}",
      actual.confidence_boost, expected.confidence_boost
    ));
  }
  if actual.custom_regex_patterns != expected.custom_regex_patterns {
    return Err(format!(
      "{name}: custom_regex_patterns {:?} != {:?}",
      actual.custom_regex_patterns, expected.custom_regex_patterns
    ));
  }
  if actual.regex_options != expected.regex_options {
    return Err(format!(
      "{name}: regex_options {:?} != {:?}",
      actual.regex_options, expected.regex_options
    ));
  }
  if actual.custom_regex_options != expected.custom_regex_options {
    return Err(format!(
      "{name}: custom_regex_options {:?} != {:?}",
      actual.custom_regex_options, expected.custom_regex_options
    ));
  }
  if actual.signature_data != expected.signature_data {
    return Err(format!(
      "{name}: signature_data {:?} != {:?}",
      actual.signature_data, expected.signature_data
    ));
  }
  if actual.monetary_data != expected.monetary_data {
    return Err(format!(
      "{name}: monetary_data {:?} != {:?}",
      actual.monetary_data, expected.monetary_data
    ));
  }
  if actual.date_data != expected.date_data {
    return Err(format!(
      "{name}: date_data {:?} != {:?}",
      actual.date_data, expected.date_data
    ));
  }
  if actual.zone_data != expected.zone_data {
    return Err(format!(
      "{name}: zone_data {:?} != {:?}",
      actual.zone_data, expected.zone_data
    ));
  }
  if actual.address_context_data != expected.address_context_data {
    return Err(format!(
      "{name}: address_context_data {:?} != {:?}",
      actual.address_context_data, expected.address_context_data
    ));
  }
  if actual.address_seed_data != expected.address_seed_data {
    return Err(format!(
      "{name}: address_seed_data {:?} != {:?}",
      actual.address_seed_data, expected.address_seed_data
    ));
  }
  if actual.country_data != expected.country_data {
    return Err(format!(
      "{name}: country_data {:?} != {:?}",
      actual.country_data, expected.country_data
    ));
  }
  if actual.hotword_data != expected.hotword_data {
    return Err(format!(
      "{name}: hotword_data {:?} != {:?}",
      actual.hotword_data, expected.hotword_data
    ));
  }
  if actual.custom_regex_meta != expected.custom_regex_meta {
    return Err(format!(
      "{name}: custom_regex_meta {:?} != {:?}",
      actual.custom_regex_meta, expected.custom_regex_meta
    ));
  }
  compare_c2_data(name, actual, expected)?;
  compare_trigger_data(name, actual, expected)?;
  compare_regex_and_legal(name, actual, expected)?;
  compare_c3_data(name, actual, expected)?;
  Ok(())
}

/// Compares two string vectors, reporting the first divergent index.
fn compare_str_vec(
  label: &str,
  got: &[String],
  want: &[String],
) -> Result<(), String> {
  if got.len() != want.len() {
    return Err(format!("{label} length {} != {}", got.len(), want.len()));
  }
  for (index, (g, w)) in got.iter().zip(want.iter()).enumerate() {
    if g != w {
      return Err(format!("{label}[{index}] {g:?} != {w:?}"));
    }
  }
  Ok(())
}

/// Slice C3: the deny-list unit and the literal/slice fields.
fn compare_c3_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.literal_patterns.len() != expected.literal_patterns.len() {
    return Err(format!(
      "{name}: literal_patterns length {} != {}",
      actual.literal_patterns.len(),
      expected.literal_patterns.len()
    ));
  }
  for (index, (got, want)) in actual
    .literal_patterns
    .iter()
    .zip(expected.literal_patterns.iter())
    .enumerate()
  {
    if got != want {
      return Err(format!(
        "{name}: literal_patterns[{index}] differs\n  got:  {got:?}\n  want: {want:?}"
      ));
    }
  }
  if actual.literal_options != expected.literal_options {
    return Err(format!(
      "{name}: literal_options {:?} != {:?}",
      actual.literal_options, expected.literal_options
    ));
  }
  if actual.literal_patterns_from_deny_list_data
    != expected.literal_patterns_from_deny_list_data
  {
    return Err(format!(
      "{name}: literal_patterns_from_deny_list_data {} != {}",
      actual.literal_patterns_from_deny_list_data,
      expected.literal_patterns_from_deny_list_data
    ));
  }
  if actual.slices != expected.slices {
    return Err(format!(
      "{name}: slices {:?} != {:?}",
      actual.slices, expected.slices
    ));
  }
  if actual.name_corpus_mode != expected.name_corpus_mode {
    return Err(format!(
      "{name}: name_corpus_mode {:?} != {:?}",
      actual.name_corpus_mode, expected.name_corpus_mode
    ));
  }
  compare_name_corpus_data(name, actual, expected)?;
  compare_filters(
    &format!("{name}: false_positive_filters"),
    actual.false_positive_filters.as_ref(),
    expected.false_positive_filters.as_ref(),
  )?;
  compare_deny_list_data(name, actual, expected)?;
  Ok(())
}

fn compare_name_corpus_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  match (&actual.name_corpus_data, &expected.name_corpus_data) {
    (None, None) => Ok(()),
    (Some(got), Some(want)) => {
      let fields: [(&str, &Vec<String>, &Vec<String>); 15] = [
        ("first_names", &got.first_names, &want.first_names),
        ("surnames", &got.surnames, &want.surnames),
        ("title_tokens", &got.title_tokens, &want.title_tokens),
        (
          "title_abbreviations",
          &got.title_abbreviations,
          &want.title_abbreviations,
        ),
        ("excluded_words", &got.excluded_words, &want.excluded_words),
        ("common_words", &got.common_words, &want.common_words),
        (
          "non_western_names",
          &got.non_western_names,
          &want.non_western_names,
        ),
        (
          "excluded_all_caps",
          &got.excluded_all_caps,
          &want.excluded_all_caps,
        ),
        ("ja_suffixes", &got.ja_suffixes, &want.ja_suffixes),
        (
          "arabic_connectors",
          &got.arabic_connectors,
          &want.arabic_connectors,
        ),
        (
          "relation_connectors",
          &got.relation_connectors,
          &want.relation_connectors,
        ),
        (
          "hyphenated_prefixes",
          &got.hyphenated_prefixes,
          &want.hyphenated_prefixes,
        ),
        (
          "cjk_non_person_terms",
          &got.cjk_non_person_terms,
          &want.cjk_non_person_terms,
        ),
        (
          "cjk_surname_starters",
          &got.cjk_surname_starters,
          &want.cjk_surname_starters,
        ),
        (
          "organization_terms",
          &got.organization_terms,
          &want.organization_terms,
        ),
      ];
      for (field, got_vec, want_vec) in fields {
        compare_str_vec(
          &format!("{name}: name_corpus_data.{field}"),
          got_vec,
          want_vec,
        )?;
      }
      Ok(())
    }
    (got, want) => Err(format!(
      "{name}: name_corpus_data presence differs (got {}, want {})",
      got.is_some(),
      want.is_some()
    )),
  }
}

fn compare_filters(
  label: &str,
  got: Option<&stella_anonymize_adapter_contract::BindingDenyListFilterData>,
  want: Option<&stella_anonymize_adapter_contract::BindingDenyListFilterData>,
) -> Result<(), String> {
  match (got, want) {
    (None, None) => Ok(()),
    (Some(got), Some(want)) => {
      let fields: [(&str, &Vec<String>, &Vec<String>); 18] = [
        ("stopwords", &got.stopwords, &want.stopwords),
        ("allow_list", &got.allow_list, &want.allow_list),
        (
          "person_stopwords",
          &got.person_stopwords,
          &want.person_stopwords,
        ),
        (
          "person_trailing_nouns",
          &got.person_trailing_nouns,
          &want.person_trailing_nouns,
        ),
        (
          "address_trailing_nouns",
          &got.address_trailing_nouns,
          &want.address_trailing_nouns,
        ),
        (
          "address_stopwords",
          &got.address_stopwords,
          &want.address_stopwords,
        ),
        (
          "address_jurisdiction_prefixes",
          &got.address_jurisdiction_prefixes,
          &want.address_jurisdiction_prefixes,
        ),
        ("street_types", &got.street_types, &want.street_types),
        (
          "address_component_terms",
          &got.address_component_terms,
          &want.address_component_terms,
        ),
        (
          "ambiguous_street_type_terms",
          &got.ambiguous_street_type_terms,
          &want.ambiguous_street_type_terms,
        ),
        ("first_names", &got.first_names, &want.first_names),
        ("generic_roles", &got.generic_roles, &want.generic_roles),
        (
          "number_abbrev_prefixes",
          &got.number_abbrev_prefixes,
          &want.number_abbrev_prefixes,
        ),
        (
          "sentence_starters",
          &got.sentence_starters,
          &want.sentence_starters,
        ),
        (
          "trailing_address_word_exclusions",
          &got.trailing_address_word_exclusions,
          &want.trailing_address_word_exclusions,
        ),
        (
          "document_heading_words",
          &got.document_heading_words,
          &want.document_heading_words,
        ),
        (
          "document_heading_ordinal_markers",
          &got.document_heading_ordinal_markers,
          &want.document_heading_ordinal_markers,
        ),
        (
          "defined_term_cues",
          &got.defined_term_cues,
          &want.defined_term_cues,
        ),
      ];
      for (field, got_vec, want_vec) in fields {
        compare_str_vec(&format!("{label}.{field}"), got_vec, want_vec)?;
      }
      if got.signing_place_guards != want.signing_place_guards {
        return Err(format!(
          "{label}.signing_place_guards {:?} != {:?}",
          got.signing_place_guards, want.signing_place_guards
        ));
      }
      Ok(())
    }
    (got, want) => Err(format!(
      "{label} presence differs (got {}, want {})",
      got.is_some(),
      want.is_some()
    )),
  }
}

fn compare_deny_list_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  match (&actual.deny_list_data, &expected.deny_list_data) {
    (None, None) => Ok(()),
    (Some(got), Some(want)) => {
      compare_str_vec(
        &format!("{name}: deny_list_data.originals"),
        &got.originals,
        &want.originals,
      )?;
      compare_str_vec(
        &format!("{name}: deny_list_data.label_table"),
        &got.label_table,
        &want.label_table,
      )?;
      compare_str_vec(
        &format!("{name}: deny_list_data.source_table"),
        &got.source_table,
        &want.source_table,
      )?;
      compare_u32_matrix(
        &format!("{name}: deny_list_data.label_indices"),
        &got.label_indices,
        &want.label_indices,
      )?;
      compare_u32_matrix(
        &format!("{name}: deny_list_data.source_indices"),
        &got.source_indices,
        &want.source_indices,
      )?;
      compare_u32_matrix(
        &format!("{name}: deny_list_data.custom_label_indices"),
        &got.custom_label_indices,
        &want.custom_label_indices,
      )?;
      compare_filters(
        &format!("{name}: deny_list_data.filters"),
        got.filters.as_ref(),
        want.filters.as_ref(),
      )?;
      Ok(())
    }
    (got, want) => Err(format!(
      "{name}: deny_list_data presence differs (got {}, want {})",
      got.is_some(),
      want.is_some()
    )),
  }
}

fn compare_u32_matrix(
  label: &str,
  got: &[Vec<u32>],
  want: &[Vec<u32>],
) -> Result<(), String> {
  if got.len() != want.len() {
    return Err(format!("{label} length {} != {}", got.len(), want.len()));
  }
  for (index, (g, w)) in got.iter().zip(want.iter()).enumerate() {
    if g != w {
      return Err(format!("{label}[{index}] {g:?} != {w:?}"));
    }
  }
  Ok(())
}

/// Slice C2 data fields compared field-by-field.
fn compare_c2_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.gazetteer_data != expected.gazetteer_data {
    return Err(format!(
      "{name}: gazetteer_data {:?} != {:?}",
      actual.gazetteer_data, expected.gazetteer_data
    ));
  }
  if actual.coreference_data != expected.coreference_data {
    return Err(format!(
      "{name}: coreference_data {:?} != {:?}",
      actual.coreference_data, expected.coreference_data
    ));
  }
  Ok(())
}

/// Compares `trigger_data` with a targeted first-difference report (the rule
/// array has ~1400 entries, so a full `{:?}` dump is unreadable).
fn compare_trigger_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  match (&actual.trigger_data, &expected.trigger_data) {
    (None, None) => return Ok(()),
    (Some(got), Some(want)) => {
      if got.rules.len() != want.rules.len() {
        return Err(format!(
          "{name}: trigger_data.rules length {} != {}",
          got.rules.len(),
          want.rules.len()
        ));
      }
      for (index, (g, w)) in got.rules.iter().zip(want.rules.iter()).enumerate()
      {
        if g != w {
          return Err(format!(
            "{name}: trigger_data.rules[{index}] differs\n  got:  {g:?}\n  want: {w:?}"
          ));
        }
      }
      if got != want {
        return Err(format!(
          "{name}: trigger_data support members differ\n  got:  {:?}\n  want: {:?}",
          TriggerSupport::from(got),
          TriggerSupport::from(want)
        ));
      }
    }
    (got, want) => {
      return Err(format!(
        "{name}: trigger_data presence differs (got {}, want {})",
        got.is_some(),
        want.is_some()
      ));
    }
  }
  Ok(())
}

/// Support-member view of `trigger_data` (rules elided) for readable diffs.
#[derive(Debug)]
#[allow(dead_code)]
struct TriggerSupport<'a> {
  address_stop_keywords: &'a [String],
  party_position_terms: &'a [String],
  post_nominals: &'a [String],
  sentence_terminal_currency_terms: &'a [String],
  phone_extension_labels: &'a [String],
  number_markers: &'a [String],
  number_labels: &'a [String],
  person_field_labels: &'a [String],
}

impl<'a> From<&'a stella_anonymize_adapter_contract::BindingTriggerData>
  for TriggerSupport<'a>
{
  fn from(
    data: &'a stella_anonymize_adapter_contract::BindingTriggerData,
  ) -> Self {
    Self {
      address_stop_keywords: &data.address_stop_keywords,
      party_position_terms: &data.party_position_terms,
      post_nominals: &data.post_nominals,
      sentence_terminal_currency_terms: &data.sentence_terminal_currency_terms,
      phone_extension_labels: &data.phone_extension_labels,
      number_markers: &data.number_markers,
      number_labels: &data.number_labels,
      person_field_labels: &data.person_field_labels,
    }
  }
}

/// `regex_meta` (full), `legal_form_data` (full), and the full `regex_patterns`
/// array (static + signing prefix, then legal-form and trigger literal tails).
fn compare_regex_and_legal(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.regex_meta != expected.regex_meta {
    return Err(format!(
      "{name}: regex_meta {:?} != {:?}",
      actual.regex_meta, expected.regex_meta
    ));
  }
  if actual.legal_form_data != expected.legal_form_data {
    return Err(format!(
      "{name}: legal_form_data {:?} != {:?}",
      actual.legal_form_data, expected.legal_form_data
    ));
  }
  compare_regex_patterns(name, actual, expected)
}

/// FULL check for `regex_patterns` with a targeted first-difference report.
fn compare_regex_patterns(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.regex_patterns.len() != expected.regex_patterns.len() {
    return Err(format!(
      "{name}: regex_patterns length {} != {}",
      actual.regex_patterns.len(),
      expected.regex_patterns.len()
    ));
  }
  for (index, (got, want)) in actual
    .regex_patterns
    .iter()
    .zip(expected.regex_patterns.iter())
    .enumerate()
  {
    if got != want {
      return Err(format!(
        "{name}: regex_patterns[{index}] differs\n  got:  {got:?}\n  want: {want:?}"
      ));
    }
  }
  Ok(())
}

fn check_fixture(input_path: &Path) -> Result<(), String> {
  let name = input_path
    .file_name()
    .and_then(|file_name| file_name.to_str())
    .and_then(|file_name| file_name.strip_suffix(".input.json"))
    .unwrap_or("<unknown>");
  let input: FixtureInput = read_json(input_path)?;
  let expected: BindingPreparedSearchConfig =
    serde_json::from_value(read_expected_value(&fixtures_dir(), name)?)
      .map_err(|error| {
        format!("{name}: parse reconstructed config: {error}")
      })?;
  let actual = assemble_static_search_config(
    &input.config,
    input.config.dictionaries.as_ref(),
    &input.gazetteer,
  )
  .map_err(|error| format!("{name}: assemble failed: {error}"))?;
  compare_full_config(name, &actual, &expected)
}

#[test]
fn assemble_parity_matches_typescript() -> Result<(), String> {
  let dir = fixtures_dir();
  let inputs = collect_input_paths(&dir)?;
  if inputs.len() < 30 {
    return Err(format!(
      "expected the captured fixture set, found {} inputs in {}",
      inputs.len(),
      dir.display()
    ));
  }

  let mut failures = Vec::new();
  for input_path in &inputs {
    if let Err(error) = check_fixture(input_path) {
      failures.push(error);
    }
  }
  if failures.is_empty() {
    return Ok(());
  }
  Err(format!(
    "assemble parity mismatches ({} of {}):\n{}",
    failures.len(),
    inputs.len(),
    failures.join("\n")
  ))
}

#[derive(Clone, Debug)]
enum JsonPathSegment {
  Key(String),
  Index(usize),
}

const OPEN_LANGUAGE_MAPS: [&str; 3] = [
  "month_names_by_language",
  "lowercase_month_ambiguities",
  "year_words_by_language",
];

fn collect_closed_object_paths(
  value: &Value,
  path: &mut Vec<JsonPathSegment>,
  paths: &mut Vec<Vec<JsonPathSegment>>,
  covered_object_paths: &mut HashSet<String>,
  parent_key: Option<&str>,
) {
  match value {
    Value::Object(object) => {
      if parent_key.is_some_and(|key| OPEN_LANGUAGE_MAPS.contains(&key)) {
        return;
      }
      let discriminator = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
      let object_path = semantic_object_path(path, discriminator);
      if covered_object_paths.insert(object_path) {
        paths.push(path.clone());
      }
      for (key, child) in object {
        path.push(JsonPathSegment::Key(key.clone()));
        collect_closed_object_paths(
          child,
          path,
          paths,
          covered_object_paths,
          Some(key),
        );
        path.pop();
      }
    }
    Value::Array(array) => {
      for (index, child) in array.iter().enumerate() {
        path.push(JsonPathSegment::Index(index));
        collect_closed_object_paths(
          child,
          path,
          paths,
          covered_object_paths,
          parent_key,
        );
        path.pop();
      }
    }
    _ => {}
  }
}

fn semantic_object_path(
  path: &[JsonPathSegment],
  discriminator: &str,
) -> String {
  let mut semantic = String::new();
  for segment in path {
    match segment {
      JsonPathSegment::Key(key) => {
        if !semantic.is_empty() {
          semantic.push('/');
        }
        semantic.push_str(key);
      }
      JsonPathSegment::Index(_) => semantic.push_str("[*]"),
    }
  }
  format!("{semantic}|{discriminator}")
}

fn object_at_path_mut<'a>(
  mut value: &'a mut Value,
  path: &[JsonPathSegment],
) -> Option<&'a mut serde_json::Map<String, Value>> {
  for segment in path {
    value = match segment {
      JsonPathSegment::Key(key) => value.get_mut(key)?,
      JsonPathSegment::Index(index) => value.get_mut(*index)?,
    };
  }
  value.as_object_mut()
}

#[test]
fn prepared_config_rejects_unknown_members_recursively() -> Result<(), String> {
  let fixture = fixtures_dir().join("baseline-all-on.expected.json");
  let value: Value = read_json(&fixture)?;
  let mut paths = Vec::new();
  let mut covered_object_paths = HashSet::new();
  collect_closed_object_paths(
    &value,
    &mut Vec::new(),
    &mut paths,
    &mut covered_object_paths,
    None,
  );
  if paths.len() < 20 {
    return Err(format!(
      "expected broad recursive DTO coverage, found only {} object paths",
      paths.len()
    ));
  }
  for same_shape_dto_path in [
    "zone_data/section_heading_patterns[*]|",
    "coreference_data/definition_patterns[*]|",
  ] {
    if !covered_object_paths.contains(same_shape_dto_path) {
      return Err(format!(
        "recursive DTO coverage skipped {same_shape_dto_path}"
      ));
    }
  }

  for path in paths {
    let mut with_unknown = value.clone();
    let object = object_at_path_mut(&mut with_unknown, &path)
      .ok_or_else(|| format!("object path disappeared: {path:?}"))?;
    object.insert(
      String::from("__unexpected_prepared_config_member"),
      Value::Bool(true),
    );
    if serde_json::from_value::<BindingPreparedSearchConfig>(with_unknown)
      .is_ok()
    {
      return Err(format!("unknown member accepted at {path:?}"));
    }
  }
  Ok(())
}

#[test]
fn prepared_config_language_maps_remain_open() -> Result<(), String> {
  let fixture = fixtures_dir().join("baseline-all-on.expected.json");
  let mut value: Value = read_json(&fixture)?;
  let date_data = value
    .get_mut("date_data")
    .and_then(Value::as_object_mut)
    .ok_or_else(|| String::from("fixture lacks date_data"))?;
  for field in OPEN_LANGUAGE_MAPS {
    date_data
      .get_mut(field)
      .and_then(Value::as_object_mut)
      .ok_or_else(|| format!("fixture lacks date_data.{field}"))?
      .insert(
        String::from("x-test-language"),
        Value::Array(vec![Value::String(String::from("token"))]),
      );
  }
  serde_json::from_value::<BindingPreparedSearchConfig>(value)
    .map(|_| ())
    .map_err(|error| format!("open language map rejected a language: {error}"))
}

#[test]
fn country_metadata_uses_exact_camel_case_and_closed_variants()
-> Result<(), String> {
  let valid = serde_json::json!({
    "labels": ["country", "country", "country", "country"],
    "isoCodes": ["CH", "US", "GB", "DE"],
    "variants": ["name", "alias", "alpha3", "alpha2"]
  });
  let parsed = serde_json::from_value::<
    stella_anonymize_adapter_contract::BindingCountryMatchData,
  >(valid.clone())
  .map_err(|error| {
    format!("canonical country metadata should parse: {error}")
  })?;
  assert_eq!(
    serde_json::to_value(parsed)
      .map_err(|error| format!("country metadata should serialize: {error}"))?,
    valid
  );

  for invalid in [
    serde_json::json!({
      "labels": ["country"],
      "iso_codes": ["CH"],
      "variants": ["name"]
    }),
    serde_json::json!({
      "labels": ["country"],
      "isoCodes": ["CH"],
      "variants": ["Name"]
    }),
    serde_json::json!({
      "labels": ["country"],
      "isoCodes": ["CH"],
      "variants": ["Alpha3"]
    }),
    serde_json::json!({
      "labels": ["country"],
      "isoCodes": ["CH"],
      "variants": ["Alpha2"]
    }),
    serde_json::json!({
      "labels": ["country"],
      "isoCodes": ["CH"],
      "variants": ["other"]
    }),
  ] {
    assert!(
      serde_json::from_value::<
        stella_anonymize_adapter_contract::BindingCountryMatchData,
      >(invalid)
      .is_err()
    );
  }
  Ok(())
}
