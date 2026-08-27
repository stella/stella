//! Deny-list assembly: ports `buildDenyListFilterData`
//! (`detectors/deny-list.ts:1255`) into `false_positive_filters`, and
//! `buildDenyList` (`:761`) + `toNativeDenyListData` (`:1829`) into
//! `deny_list_data`.
//!
//! The two share a single `DenyListFilterData` value (both call
//! `buildDenyListFilterData` on the same context, which is deterministic), so
//! the filters are built once and reused for `false_positive_filters` and the
//! `filters` member of `deny_list_data`.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, DenyListCategory, Dictionaries, OrderedMap, PipelineConfig,
  parse_data_file, parse_ordered_data_file,
};

use super::js::{js_lowercase, lower_sorted_unique, normalize_for_search};
use super::language::{normalize_language_key, selected_language_keys};
use super::names::{NameCorpus, expand_name_declensions};
use super::{address, legal_forms};
use crate::{
  BindingDenyListFilterData, BindingDenyListMatchData,
  BindingSigningPlaceGuardData,
};

const CITY_HEAD_NAME_SOURCE: &str = "city-head-name";

// ── shared word-collection helpers ──────────────────────────────────────────

/// Mirrors `collectLanguageWordValues`: gather every non-empty string from the
/// `words` array plus every non-`_`-prefixed key's array, then `lowerSortedUnique`.
fn append_word_array<'a>(target: &mut Vec<&'a str>, value: Option<&'a Value>) {
  if let Some(array) = value.and_then(Value::as_array) {
    for entry in array {
      if let Some(text) = entry.as_str().filter(|text| !text.is_empty()) {
        target.push(text);
      }
    }
  }
}

fn collect_language_word_values(data: &OrderedMap<Value>) -> Vec<String> {
  let mut words: Vec<&str> = Vec::new();
  append_word_array(
    &mut words,
    data.iter().find(|(k, _)| k == "words").map(|(_, v)| v),
  );
  for (key, value) in data {
    if key == "words" || key.starts_with('_') {
      continue;
    }
    append_word_array(&mut words, Some(value));
  }
  lower_sorted_unique(words)
}

/// `collectLanguageWordValues` for a file loaded by name.
fn language_word_file(name: &str) -> Result<Vec<String>, AssembleError> {
  let data: OrderedMap<Value> = parse_ordered_data_file(name)?;
  Ok(collect_language_word_values(&data))
}

fn scoped_language_word_file(
  name: &str,
  languages: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  let data: OrderedMap<Value> = parse_ordered_data_file(name)?;
  let Some(selected) = selected_language_keys(languages) else {
    return Ok(collect_language_word_values(&data));
  };

  let mut words = Vec::new();
  append_word_array(
    &mut words,
    data
      .iter()
      .find(|(key, _)| key == "words")
      .map(|(_, value)| value),
  );
  for (key, value) in &data {
    if key.starts_with('_') || !selected.contains(&normalize_language_key(key))
    {
      continue;
    }
    append_word_array(&mut words, Some(value));
  }
  Ok(lower_sorted_unique(words))
}

fn scoped_page_footer_markers(
  selected: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  let data: OrderedMap<Value> =
    parse_ordered_data_file("page-footer-markers.json")?;
  let mut markers = Vec::new();
  for (language, value) in &data {
    if language.starts_with('_')
      || !super::language::language_config_matches(language, selected)
    {
      continue;
    }
    let Some(group) = value.as_object() else {
      continue;
    };
    let mut page_words = Vec::new();
    append_word_array(&mut page_words, group.get("pageWords"));
    let mut count_words = Vec::new();
    append_word_array(&mut count_words, group.get("countWords"));
    for page_word in &page_words {
      markers.push(page_word.to_lowercase());
      for count_word in &count_words {
        markers.push(format!(
          "{} {}",
          page_word.to_lowercase(),
          count_word.to_lowercase()
        ));
      }
    }
  }
  Ok(lower_sorted_unique(markers.iter().map(String::as_str)))
}

/// `languageWordValues(record)`: `collectLanguageWordValues` of a sub-record,
/// or empty when the value is not a record.
fn language_word_values(value: Option<&Value>) -> Vec<String> {
  let Some(object @ Value::Object(_)) = value else {
    return Vec::new();
  };
  // Reserialize into an OrderedMap to preserve document key order.
  let ordered: OrderedMap<Value> =
    serde_json::from_value(object.clone()).unwrap_or_default();
  collect_language_word_values(&ordered)
}

/// `collectLanguageFilterValues`: `lowerSortedUnique` of the selected arrays
/// across every `deny-list-filters.json` language group.
fn deny_list_filter_static(
  selector: &str,
) -> Result<Vec<String>, AssembleError> {
  let data: OrderedMap<Value> =
    parse_ordered_data_file("deny-list-filters.json")?;
  let mut collected: Vec<String> = Vec::new();
  for (_language, group) in &data {
    if let Some(array) = group.get(selector).and_then(Value::as_array) {
      for entry in array {
        if let Some(text) = entry.as_str() {
          collected.push(text.to_string());
        }
      }
    }
  }
  Ok(lower_sorted_unique(collected.iter().map(String::as_str)))
}

// ── false_positive_filters (buildDenyListFilterData) ────────────────────────

#[derive(Deserialize)]
struct WordsFile {
  #[serde(default)]
  words: Vec<String>,
}

#[derive(Deserialize)]
struct GenericRoles {
  #[serde(default)]
  roles: Vec<String>,
}

/// First-name corpus lowercased for stopword exclusion.
fn first_name_exclusions(corpus: &NameCorpus) -> HashSet<String> {
  corpus
    .first_names_list
    .iter()
    .map(|name| js_lowercase(name))
    .collect()
}

/// `new Set(...)` insertion-order dedup for a `words`-style file.
fn set_ordered(words: Vec<String>) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for word in words {
    if seen.insert(word.clone()) {
      out.push(word);
    }
  }
  out
}

/// Mirrors `buildStreetTypeFilterValues`: `lowerSortedUnique` of the raw
/// street-type pattern list.
fn street_type_filter_values() -> Result<Vec<String>, AssembleError> {
  Ok(lower_sorted_unique(
    address::street_type_patterns()?.iter().map(String::as_str),
  ))
}

/// Builds the shared `DenyListFilterData` value.
///
/// # Errors
///
/// Returns [`AssembleError`] when an embedded filter data file fails to parse.
pub(super) fn build_deny_list_filter_data(
  corpus: &NameCorpus,
  content_languages: Option<&[String]>,
) -> Result<BindingDenyListFilterData, AssembleError> {
  // stopwords: stopwords.json filtered by first-name exclusions, Set order.
  let exclusions = first_name_exclusions(corpus);
  let stopwords_file: Vec<String> = parse_data_file("stopwords.json")?;
  let stopwords = set_ordered(
    stopwords_file
      .into_iter()
      .filter(|word| !exclusions.contains(word))
      .collect(),
  );

  let allow_list: WordsFile = parse_data_file("allow-list.json")?;
  let allow_list = set_ordered(allow_list.words);

  let person_stopwords =
    set_ordered(language_word_file("person-stopwords.json")?);
  let person_trailing_nouns = set_ordered(scoped_language_word_file(
    "defined-term-heads.json",
    content_languages,
  )?);
  let address_trailing_nouns = set_ordered(scoped_language_word_file(
    "address-trailing-nouns.json",
    content_languages,
  )?);

  let address_stopwords_file: WordsFile =
    parse_data_file("address-stopwords.json")?;
  let address_stopwords = set_ordered(address_stopwords_file.words);

  let address_jurisdiction_prefixes =
    language_word_file("address-jurisdiction-prefixes.json")?;

  let shapes: Value = parse_data_file("false-positive-shapes.json")?;
  let shape = |key: &str| language_word_values(shapes.get(key));

  // genericRoles: generic-roles.json roles (Set order), then legal role heads.
  let generic_roles_file: GenericRoles = parse_data_file("generic-roles.json")?;
  let mut generic_roles = set_ordered(generic_roles_file.roles);
  generic_roles.extend(legal_forms::role_heads(content_languages)?);
  let page_footer_markers = scoped_page_footer_markers(content_languages)?;

  // trailingAddressWordExclusions: lowerSortedUnique union, then Set (no-op).
  let mut trailing_union: Vec<String> = Vec::new();
  trailing_union.extend(legal_forms::role_heads(content_languages)?);
  trailing_union.extend(legal_forms::clause_noun_heads()?);
  trailing_union.extend(language_word_file("organization-unit-heads.json")?);
  trailing_union
    .extend(language_word_file("document-structure-headings.json")?);
  let trailing_address_word_exclusions =
    lower_sorted_unique(trailing_union.iter().map(String::as_str));

  let document_heading_words =
    language_word_file("document-structure-headings.json")?;

  let unit_designators = language_word_file("unit-designators.json")?;
  let in_name_connectors = language_word_file("in-name-connectors.json")?;

  let signing_place_guards = build_signing_place_guards()?;

  Ok(BindingDenyListFilterData {
    stopwords,
    allow_list,
    person_stopwords,
    person_trailing_nouns,
    address_trailing_nouns,
    address_stopwords,
    address_jurisdiction_prefixes,
    street_types: street_type_filter_values()?,
    address_component_terms: shape("addressComponentTerms"),
    ambiguous_street_type_terms: shape("ambiguousStreetTypeTerms"),
    first_names: corpus.first_names_list.clone(),
    generic_roles,
    page_footer_markers,
    number_abbrev_prefixes: shape("numberAbbrevPrefixes"),
    sentence_starters: deny_list_filter_static("sentenceStarters")?,
    trailing_address_word_exclusions,
    document_heading_words,
    document_heading_ordinal_markers: shape("documentHeadingOrdinalMarkers"),
    defined_term_cues: deny_list_filter_static("definedTermCues")?,
    unit_designators,
    in_name_connectors,
    us_state_abbreviations: Vec::new(),
    signing_place_guards,
    // Both title sources: dotted honorifics ("M.", "Sig.", "Sr.") live in
    // `title_abbreviations` (already trailing-dot-stripped and lowercased),
    // not in `titles_list`, and the defined-term-quote first-name exception
    // (`starts_with_known_first_name`, processors.rs) must recognize them
    // too or a quote like `"M. Jean Dupont" shall mean ...` stays
    // suppressed. Downstream `lower_set` dedups the union.
    title_tokens: corpus
      .titles_list
      .iter()
      .chain(corpus.title_abbreviations.iter())
      .cloned()
      .collect(),
  })
}

/// Mirrors `loadSigningPlaceFilters`: guard phrase pairs from
/// `signing-clauses.json`, each `lowerSortedUnique`, both sides non-empty.
fn build_signing_place_guards()
-> Result<Vec<BindingSigningPlaceGuardData>, AssembleError> {
  #[derive(Deserialize)]
  struct SigningClauses {
    #[serde(default)]
    patterns: Vec<SigningPattern>,
  }
  #[derive(Deserialize)]
  struct SigningPattern {
    #[serde(default, rename = "guardPrefixPhrases")]
    guard_prefix_phrases: Vec<String>,
    #[serde(default, rename = "guardSuffixPhrases")]
    guard_suffix_phrases: Vec<String>,
  }
  let data: SigningClauses = parse_data_file("signing-clauses.json")?;
  let mut guards = Vec::new();
  for pattern in data.patterns {
    let prefix_phrases = lower_sorted_unique(
      pattern.guard_prefix_phrases.iter().map(String::as_str),
    );
    let suffix_phrases = lower_sorted_unique(
      pattern.guard_suffix_phrases.iter().map(String::as_str),
    );
    if !prefix_phrases.is_empty() && !suffix_phrases.is_empty() {
      guards.push(BindingSigningPlaceGuardData {
        prefix_phrases,
        suffix_phrases,
      });
    }
  }
  Ok(guards)
}

// ── deny_list_data (buildDenyList → toNativeDenyListData) ────────────────────

/// Intermediate deny-list data mirroring `DenyListData` (pre-native encoding).
pub(super) struct DenyListData {
  labels: Vec<Vec<String>>,
  custom_labels: Vec<Vec<String>>,
  originals: Vec<String>,
  sources: Vec<Vec<String>>,
}

/// Accumulator state shared by the entry-adding closures.
struct Builder {
  pattern_list: Vec<String>,
  label_list: Vec<Vec<String>>,
  custom_label_list: Vec<Vec<String>>,
  source_list: Vec<Vec<String>>,
  pattern_index: HashMap<String, usize>,
}

impl Builder {
  fn new() -> Self {
    Self {
      pattern_list: Vec::new(),
      label_list: Vec::new(),
      custom_label_list: Vec::new(),
      source_list: Vec::new(),
      pattern_index: HashMap::new(),
    }
  }

  /// Registers a brand-new pattern with its initial label/source.
  fn push_new(
    &mut self,
    normalized: String,
    lower: String,
    label: &str,
    source: &str,
  ) {
    self.pattern_index.insert(lower, self.pattern_list.len());
    self.pattern_list.push(normalized);
    self.label_list.push(vec![label.to_string()]);
    self
      .custom_label_list
      .push(if source == "custom-deny-list" {
        vec![label.to_string()]
      } else {
        Vec::new()
      });
    self.source_list.push(vec![source.to_string()]);
  }

  /// Merges an additional label/source into an already-registered pattern
  /// (`addPatternLabel` / `addPatternSource` / the custom-label branch).
  fn merge_existing(&mut self, index: usize, label: &str, source: &str) {
    if let Some(labels) = self.label_list.get_mut(index) {
      push_unique_str(labels, label);
    }
    if let Some(sources) = self.source_list.get_mut(index) {
      push_unique_str(sources, source);
    }
    if source == "custom-deny-list"
      && let Some(customs) = self.custom_label_list.get_mut(index)
    {
      push_unique_str(customs, label);
    }
  }

  /// Adds only a source to an existing pattern (the title branch).
  fn merge_source(&mut self, index: usize, source: &str) {
    if let Some(sources) = self.source_list.get_mut(index) {
      push_unique_str(sources, source);
    }
  }

  fn into_data(self) -> Option<DenyListData> {
    if self.pattern_list.is_empty() {
      return None;
    }
    Some(DenyListData {
      labels: self.label_list,
      custom_labels: self.custom_label_list,
      originals: self.pattern_list,
      sources: self.source_list,
    })
  }
}

fn push_unique_str(list: &mut Vec<String>, value: &str) {
  if !list.iter().any(|existing| existing == value) {
    list.push(value.to_string());
  }
}

/// Mirrors `stripCuratedPatternSyntax`.
fn strip_curated_pattern_syntax(value: &str) -> String {
  if value.contains('|') || value.contains('\\') {
    value.chars().filter(|c| *c != '|' && *c != '\\').collect()
  } else {
    value.to_string()
  }
}

/// Mirrors `SINGLE_WORD_RE`: `^\p{L}+$`.
fn is_single_word(value: &str) -> bool {
  !value.is_empty() && value.chars().all(is_unicode_letter)
}

/// `\p{L}` approximation. The deny-list tokens the assembler processes are
/// alphabetic Latin/BMP text, where `char::is_alphabetic` (the Unicode
/// `Alphabetic` property) coincides with the general category `L`.
fn is_unicode_letter(ch: char) -> bool {
  ch.is_alphabetic()
}

/// Mirrors `isCuratedNoiseAcronym`: `^(?=.{3,}$)\p{L}(?:\.\p{L}){0,3}\.?$`.
fn is_curated_noise_acronym(value: &str) -> bool {
  let chars: Vec<char> = value.chars().collect();
  if chars.len() < 3 {
    return false;
  }
  // `.{3,}$` uses `.`, which does not match line terminators.
  if chars
    .iter()
    .any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
  {
    return false;
  }
  if !chars.first().copied().is_some_and(is_unicode_letter) {
    return false;
  }
  let mut i = 1usize;
  let mut groups = 0u32;
  while groups < 3
    && chars.get(i) == Some(&'.')
    && chars
      .get(i.saturating_add(1))
      .copied()
      .is_some_and(is_unicode_letter)
  {
    i = i.saturating_add(2);
    groups = groups.saturating_add(1);
  }
  if chars.get(i) == Some(&'.') {
    i = i.saturating_add(1);
  }
  i == chars.len()
}

/// Mirrors `dottedAcronymSegmentCount` + the `<= 2` guard of
/// `isShortCuratedNoiseAcronym`.
fn is_short_curated_noise_acronym(value: &str) -> bool {
  if !is_curated_noise_acronym(value) {
    return false;
  }
  let segments = value.split('.').filter(|s| !s.is_empty()).count();
  segments <= 2
}

const fn category_name(category: DenyListCategory) -> &'static str {
  match category {
    DenyListCategory::Names => "Names",
    DenyListCategory::Places => "Places",
    DenyListCategory::Addresses => "Addresses",
    DenyListCategory::Courts => "Courts",
    DenyListCategory::Financial => "Financial",
    DenyListCategory::Government => "Government",
    DenyListCategory::Healthcare => "Healthcare",
    DenyListCategory::Education => "Education",
    DenyListCategory::Political => "Political",
    DenyListCategory::Organizations => "Organizations",
    DenyListCategory::International => "International",
  }
}

/// Result of a region lookup: unknown name, an "all countries" region
/// (`Global` / `International`), or an explicit code list.
enum RegionLookup {
  Unknown,
  All,
  Codes(&'static [&'static str]),
}

/// Region tables from `regions.ts` needed by `resolveCountries`.
fn region_codes(name: &str) -> RegionLookup {
  match name {
    "Global" | "International" => RegionLookup::All,
    "Europe" => RegionLookup::Codes(&[
      "AL", "AD", "AT", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI",
      "FR", "DE", "GR", "HU", "IS", "IE", "IT", "XK", "LV", "LI", "LT", "LU",
      "MD", "ME", "MK", "MT", "MC", "NL", "NO", "PL", "PT", "RO", "RS", "SK",
      "SI", "ES", "SE", "CH", "UA", "GB",
    ]),
    "Americas" => RegionLookup::Codes(&[
      "US", "CA", "MX", "BR", "AR", "CL", "CO", "PE", "EC", "VE", "UY", "PY",
      "BO", "CR", "PA", "DO", "GT", "HN", "SV", "NI", "CU",
    ]),
    "AsiaPacific" => RegionLookup::Codes(&[
      "AU", "NZ", "JP", "KR", "CN", "TW", "SG", "MY", "TH", "VN", "PH", "ID",
      "IN", "PK", "BD", "LK", "NP", "HK", "MO",
    ]),
    "MENA" => RegionLookup::Codes(&[
      "AE", "SA", "IL", "TR", "EG", "JO", "LB", "IQ", "IR", "QA", "KW", "BH",
      "OM", "MA", "TN", "DZ", "LY", "SY", "YE", "PS",
    ]),
    "SubSaharanAfrica" => RegionLookup::Codes(&[
      "ZA", "NG", "KE", "GH", "TZ", "ET", "SN", "CI", "CM", "UG", "RW", "MZ",
      "AO", "ZW", "BW", "NA", "MU",
    ]),
    "EU" => RegionLookup::Codes(&[
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
      "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
      "SI", "ES", "SE",
    ]),
    "DACH" => RegionLookup::Codes(&["DE", "AT", "CH"]),
    "Nordics" => RegionLookup::Codes(&["DK", "SE", "NO", "FI", "IS"]),
    "CEE" => RegionLookup::Codes(&[
      "CZ", "SK", "PL", "HU", "RO", "BG", "HR", "SI", "LT", "LV", "EE",
    ]),
    "Anglosphere" => RegionLookup::Codes(&["GB", "US", "CA", "AU", "NZ", "IE"]),
    "Benelux" => RegionLookup::Codes(&["BE", "NL", "LU"]),
    "GulfStates" => RegionLookup::Codes(&["AE", "SA", "QA", "KW", "BH", "OM"]),
    "SouthAsia" => RegionLookup::Codes(&["IN", "PK", "BD", "LK", "NP"]),
    "EastAsia" => RegionLookup::Codes(&["CN", "JP", "KR", "TW"]),
    "SoutheastAsia" => {
      RegionLookup::Codes(&["SG", "MY", "TH", "VN", "PH", "ID"])
    }
    "Oceania" => RegionLookup::Codes(&["AU", "NZ"]),
    _ => RegionLookup::Unknown,
  }
}

/// Mirrors `resolveCountries`. `None` means "all countries".
fn resolve_countries(
  regions: Option<&[String]>,
  countries: Option<&[String]>,
) -> Option<Vec<String>> {
  let has_regions = regions.is_some_and(|r| !r.is_empty());
  let has_countries = countries.is_some_and(|c| !c.is_empty());
  if !has_regions && !has_countries {
    return None;
  }
  let mut result: Vec<String> = Vec::new();
  let mut seen: HashSet<String> = HashSet::new();
  let mut add = |code: &str, out: &mut Vec<String>| {
    if seen.insert(code.to_string()) {
      out.push(code.to_string());
    }
  };
  if let Some(regions) = regions {
    for name in regions {
      match region_codes(name) {
        RegionLookup::Unknown => {}
        RegionLookup::All => return None,
        RegionLookup::Codes(codes) => {
          for code in codes {
            add(code, &mut result);
          }
        }
      }
    }
  }
  if let Some(countries) = countries {
    for code in countries {
      add(code, &mut result);
    }
  }
  Some(result)
}

/// Mirrors `getCityEntries`.
fn city_entries(
  dictionaries: Option<&Dictionaries>,
  allowed_countries: Option<&[String]>,
) -> Vec<String> {
  let Some(by_country) =
    dictionaries.and_then(|d| d.cities_by_country.as_ref())
  else {
    return dictionaries
      .and_then(|d| d.cities.clone())
      .unwrap_or_default();
  };
  let mut result = Vec::new();
  match allowed_countries {
    None => {
      for entries in by_country.values() {
        result.extend(entries.iter().cloned());
      }
    }
    Some(countries) => {
      for country in countries {
        if let Some(entries) = by_country.get(&country.to_uppercase()) {
          result.extend(entries.iter().cloned());
        }
      }
    }
  }
  result
}

struct DenyBuildContext<'a> {
  config: &'a PipelineConfig,
  dictionaries: Option<&'a Dictionaries>,
  use_scoped_name_corpus: bool,
  corpus: &'a NameCorpus,
  common_words: &'a HashSet<String>,
  city_head_words: &'a HashSet<String>,
  month_names: &'a HashSet<String>,
  common_word_exemptions: &'a HashSet<String>,
}

/// Excluded deny-list categories as a lookup set.
fn exclude_category_set(config: &PipelineConfig) -> HashSet<String> {
  config
    .deny_list_exclude_categories
    .clone()
    .unwrap_or_default()
    .into_iter()
    .collect()
}

/// Mirrors `buildDenyList`, returning the intermediate `DenyListData` (or `None`
/// when `buildDenyList` returns null).
pub(super) fn build_deny_list(
  ctx: &DenyBuildContextArgs<'_>,
) -> Result<Option<DenyListData>, AssembleError> {
  let month_names = load_month_names()?;
  let common_word_exemptions = load_common_word_exemptions()?;
  let allowed_countries = resolve_countries(
    ctx.config.deny_list_regions.as_deref(),
    ctx.deny_list_countries,
  );
  let exclude_categories = exclude_category_set(ctx.config);
  let city_list = city_entries(ctx.dictionaries, allowed_countries.as_deref());
  let city_head_words = if exclude_categories.contains("Places") {
    HashSet::new()
  } else {
    city_head_words(&city_list)
  };
  let dctx = DenyBuildContext {
    config: ctx.config,
    dictionaries: ctx.dictionaries,
    use_scoped_name_corpus: ctx.name_corpus_languages.is_some(),
    corpus: ctx.corpus,
    common_words: &ctx.corpus.common_words_set,
    city_head_words: &city_head_words,
    month_names: &month_names,
    common_word_exemptions: &common_word_exemptions,
  };

  let dictionaries = dctx.dictionaries;
  let has_deny_list = dictionaries
    .is_some_and(|d| d.deny_list.is_some() && d.deny_list_meta.is_some());
  let has_custom_deny_list = dctx
    .config
    .custom_deny_list
    .as_ref()
    .is_some_and(|list| !list.is_empty());
  let has_cities = !city_list.is_empty();

  if !has_deny_list && !has_cities && !has_custom_deny_list {
    return Ok(build_name_corpus_only(&dctx));
  }

  let mut builder = Builder::new();

  apply_dictionary_entries(
    &mut builder,
    &dctx,
    allowed_countries.as_deref(),
    &exclude_categories,
  );

  if has_cities && !exclude_categories.contains("Places") {
    for entry in &city_list {
      add_deny_list_entry(&mut builder, &dctx, entry, "address", "city");
    }
    for entry in soft_wrapped_city_head_entries(&city_list) {
      add_deny_list_entry(
        &mut builder,
        &dctx,
        &entry,
        "person",
        CITY_HEAD_NAME_SOURCE,
      );
    }
  }

  if let Some(custom) = dctx.config.custom_deny_list.as_ref() {
    for entry in custom {
      add_deny_list_entry(
        &mut builder,
        &dctx,
        &entry.value,
        &entry.label,
        "custom-deny-list",
      );
      for variant in entry.variants.iter().flatten() {
        add_deny_list_entry(
          &mut builder,
          &dctx,
          variant,
          &entry.label,
          "custom-deny-list",
        );
      }
    }
  }

  append_name_corpus_entries(&mut builder, &dctx, &exclude_categories);
  Ok(builder.into_data())
}

/// Applies the injected dictionary deny lists (the `if (hasDenyList)` block).
fn apply_dictionary_entries(
  builder: &mut Builder,
  dctx: &DenyBuildContext<'_>,
  allowed_countries: Option<&[String]>,
  exclude_categories: &HashSet<String>,
) {
  let dictionaries = dctx.dictionaries;
  let (Some(deny_list), Some(meta_data)) = (
    dictionaries.and_then(|d| d.deny_list.as_ref()),
    dictionaries.and_then(|d| d.deny_list_meta.as_ref()),
  ) else {
    return;
  };
  for (id, entries) in deny_list {
    let Some(meta) = meta_data.get(id) else {
      continue;
    };
    let category = category_name(meta.category);
    if category == "Names"
      && (!dctx.config.enable_name_corpus || dctx.use_scoped_name_corpus)
    {
      continue;
    }
    if exclude_categories.contains(category) {
      continue;
    }
    if meta.label == "country" && dctx.config.enable_countries == Some(false) {
      continue;
    }
    if let Some(allowed) = allowed_countries
      && let Some(country) = meta.country.as_ref()
      && !allowed.iter().any(|c| c == country)
    {
      continue;
    }
    // Names-category dictionaries (the bundled per-language first-name and
    // surname lists, plus the mixed-gender `names/global` fallback) are all
    // genuine person-name sources, not generic curated terms. Tag them
    // `name-dictionary` rather than the generic `deny-list` source so
    // `has_person_name_source` (processors.rs) recognizes them the same way
    // it recognizes the scoped `first-name`/`surname` name-corpus expansion;
    // otherwise a chain built entirely from these entries (e.g. an
    // unscoped-config match on a global-list-only name) is silently dropped
    // in `append_person_name_hits`.
    let source = if category == "Names" {
      "name-dictionary"
    } else {
      "deny-list"
    };
    for entry in entries {
      add_deny_list_entry(builder, dctx, entry, &meta.label, source);
    }
  }
}

/// Arguments for [`build_deny_list`].
pub(super) struct DenyBuildContextArgs<'a> {
  pub config: &'a PipelineConfig,
  pub dictionaries: Option<&'a Dictionaries>,
  pub name_corpus_languages: Option<&'a [String]>,
  pub deny_list_countries: Option<&'a [String]>,
  pub corpus: &'a NameCorpus,
}

fn build_name_corpus_only(dctx: &DenyBuildContext<'_>) -> Option<DenyListData> {
  if !dctx.config.enable_name_corpus {
    return None;
  }
  let exclude_categories = exclude_category_set(dctx.config);
  if exclude_categories.contains("Names") {
    return None;
  }
  let mut builder = Builder::new();
  append_name_corpus_entries(&mut builder, dctx, &exclude_categories);
  builder.into_data()
}

fn add_deny_list_entry(
  builder: &mut Builder,
  dctx: &DenyBuildContext<'_>,
  entry: &str,
  label: &str,
  source: &str,
) {
  let normalized = if source == "custom-deny-list" {
    normalize_for_search(entry)
  } else {
    strip_curated_pattern_syntax(&normalize_for_search(entry))
  };
  if normalized.is_empty() {
    return;
  }
  let lower = js_lowercase(&normalized);
  let mut effective_source = source;
  if source != "custom-deny-list" {
    let is_loaded_city_head_name = source == CITY_HEAD_NAME_SOURCE
      || source == "name-dictionary" && dctx.city_head_words.contains(&lower);
    if label != "address" {
      if is_single_word(&normalized)
        && dctx.common_words.contains(&lower)
        && !dctx.common_word_exemptions.contains(&lower)
        && !is_loaded_city_head_name
      {
        return;
      }
      if is_short_curated_noise_acronym(&normalized) {
        return;
      }
    } else if dctx.month_names.contains(&lower) {
      return;
    }
    if is_loaded_city_head_name
      && dctx.common_words.contains(&lower)
      && !dctx.common_word_exemptions.contains(&lower)
    {
      effective_source = CITY_HEAD_NAME_SOURCE;
    }
  }
  if let Some(&existing) = builder.pattern_index.get(&lower) {
    builder.merge_existing(existing, label, effective_source);
  } else {
    builder.push_new(normalized, lower, label, effective_source);
  }
}

fn city_head_words(cities: &[String]) -> HashSet<String> {
  let mut result = HashSet::new();
  for city in cities {
    let normalized = normalize_for_search(city);
    let mut words = normalized.split_whitespace();
    let (Some(head), Some(_)) = (words.next(), words.next()) else {
      continue;
    };
    result.insert(js_lowercase(head));
  }
  result
}

fn soft_wrapped_city_head_entries(cities: &[String]) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut result = Vec::new();
  for city in cities {
    let normalized = normalize_for_search(city);
    let mut words = normalized.split_whitespace();
    let (Some(head), Some(_)) = (words.next(), words.next()) else {
      continue;
    };
    let lower = js_lowercase(head);
    if seen.insert(lower) {
      result.push(String::from(head));
    }
  }
  result
}

fn append_name_corpus_entries(
  builder: &mut Builder,
  dctx: &DenyBuildContext<'_>,
  exclude_categories: &HashSet<String>,
) {
  if !dctx.config.enable_name_corpus || exclude_categories.contains("Names") {
    return;
  }

  let corpus = dctx.corpus;
  for name in &corpus.first_names_list {
    add_name_entry(builder, name, "first-name");
    add_declined_variants(builder, dctx, name, "first-name");
  }
  for name in &corpus.surnames_list {
    add_name_entry(builder, name, "surname");
    add_declined_variants(builder, dctx, name, "surname");
  }
  for title in &corpus.titles_list {
    let norm = strip_curated_pattern_syntax(&normalize_for_search(title));
    if norm.is_empty() {
      continue;
    }
    let lower = js_lowercase(&norm);
    if let Some(&existing) = builder.pattern_index.get(&lower) {
      builder.merge_source(existing, "title");
    } else {
      builder.push_new(norm, lower, "person", "title");
    }
  }
}

fn add_name_entry(builder: &mut Builder, name: &str, source: &str) {
  let normalized = strip_curated_pattern_syntax(&normalize_for_search(name));
  if normalized.is_empty() {
    return;
  }
  if is_curated_noise_acronym(&normalized) {
    return;
  }
  let lower = js_lowercase(&normalized);
  if let Some(&existing) = builder.pattern_index.get(&lower) {
    builder.merge_existing(existing, "person", source);
  } else {
    builder.push_new(normalized, lower, "person", source);
  }
}

fn add_declined_variants(
  builder: &mut Builder,
  dctx: &DenyBuildContext<'_>,
  name: &str,
  source: &str,
) {
  for variant in expand_name_declensions(name) {
    if dctx.common_words.contains(&js_lowercase(&variant)) {
      continue;
    }
    add_name_entry(builder, &variant, source);
  }
}

fn load_month_names() -> Result<HashSet<String>, AssembleError> {
  #[derive(Deserialize)]
  struct DateMonths {
    #[serde(default)]
    en: Vec<String>,
  }
  let data: DateMonths = parse_data_file("date-months.json")?;
  Ok(data.en.iter().map(|m| js_lowercase(m)).collect())
}

/// Loads `deny-list-common-word-exemptions.json` as a lowercased lookup set.
///
/// These are curated deny-list entries (e.g. bank/org aliases like
/// "Citizens") that collide with `common-words-en.json` and would otherwise
/// be dropped by `add_deny_list_entry`'s single-common-word veto. This is
/// deliberately a separate file from `allow-list.json`: the allow list is
/// consulted at match time and unconditionally rejects matches on its
/// keywords (`curated_labels_for_match`), so routing the assemble-time
/// exemption through it would register the pattern but suppress every match,
/// making the recovery a no-op. A dedicated exemption set keeps the two
/// mechanisms disjoint; the `common_word_exemptions_stay_off_the_allow_list`
/// test enforces that invariant.
fn load_common_word_exemptions() -> Result<HashSet<String>, AssembleError> {
  let exemptions: WordsFile =
    parse_data_file("deny-list-common-word-exemptions.json")?;
  Ok(
    exemptions
      .words
      .iter()
      .map(|word| js_lowercase(word))
      .collect(),
  )
}

// ── native encoding (toNativeDenyListData) ──────────────────────────────────

/// Insertion-order string-group encoder (`createStringGroupEncoder`).
struct StringGroupEncoder {
  table: Vec<String>,
  indexes: HashMap<String, u32>,
}

impl StringGroupEncoder {
  fn new() -> Self {
    Self {
      table: Vec::new(),
      indexes: HashMap::new(),
    }
  }

  fn encode_value(&mut self, value: &str) -> u32 {
    if let Some(&index) = self.indexes.get(value) {
      return index;
    }
    let index = u32::try_from(self.table.len()).unwrap_or(u32::MAX);
    self.table.push(value.to_string());
    self.indexes.insert(value.to_string(), index);
    index
  }

  fn encode(&mut self, values: &[String]) -> Vec<u32> {
    values
      .iter()
      .map(|value| self.encode_value(value))
      .collect()
  }
}

/// Mirrors `toNativeDenyListData`.
pub(super) fn to_native_deny_list_data(
  data: DenyListData,
  filters: BindingDenyListFilterData,
) -> BindingDenyListMatchData {
  let mut label_encoder = StringGroupEncoder::new();
  let mut source_encoder = StringGroupEncoder::new();
  let label_indices: Vec<Vec<u32>> = data
    .labels
    .iter()
    .map(|labels| label_encoder.encode(labels))
    .collect();
  let source_indices: Vec<Vec<u32>> = data
    .sources
    .iter()
    .map(|sources| source_encoder.encode(sources))
    .collect();

  let has_custom = data.custom_labels.iter().any(|labels| !labels.is_empty());
  let custom_label_indices = if has_custom {
    let encoded: Vec<Vec<u32>> = (0..data.originals.len())
      .map(|index| {
        label_encoder
          .encode(data.custom_labels.get(index).map_or(&[][..], Vec::as_slice))
      })
      .collect();
    if encoded.iter().any(|indices| !indices.is_empty()) {
      encoded
    } else {
      Vec::new()
    }
  } else {
    Vec::new()
  };

  BindingDenyListMatchData {
    labels: Vec::new(),
    label_table: label_encoder.table,
    label_indices,
    custom_labels: Vec::new(),
    custom_label_indices,
    originals: data.originals,
    sources: Vec::new(),
    source_table: source_encoder.table,
    source_indices,
    filters: Some(filters),
  }
}

// ── literal-boundary helpers used by mod.rs (literal_patterns) ───────────────

/// Mirrors `customDenyListNeedsWholeWords`: first and last chars are alphanumeric.
pub(super) fn custom_deny_list_needs_whole_words(pattern: &str) -> bool {
  let is_alnum = |c: char| c.is_alphabetic() || c.is_numeric();
  let first = pattern.chars().next();
  let last = pattern.chars().next_back();
  first.is_some_and(is_alnum) && last.is_some_and(is_alnum)
}

/// The deny-list `originals` and `sources` needed for literal-pattern synthesis.
pub(super) fn deny_originals_and_sources(
  data: &BindingDenyListMatchData,
) -> (Vec<String>, Vec<Vec<String>>) {
  let sources: Vec<Vec<String>> = data
    .source_indices
    .iter()
    .map(|indices| {
      indices
        .iter()
        .filter_map(|&i| {
          usize::try_from(i)
            .ok()
            .and_then(|i| data.source_table.get(i))
            .cloned()
        })
        .collect()
    })
    .collect();
  (data.originals.clone(), sources)
}

#[cfg(test)]
mod tests {
  #![allow(clippy::expect_used)]

  use stella_anonymize_core::assemble::DictionaryMeta;

  use super::super::names::build_name_corpus;
  use super::*;

  const ENGLISH_FIRST_NAMES_JSON: &str =
    include_str!("../../../../packages/data/dictionaries/names/first/en.json");
  const FRENCH_FIRST_NAMES_JSON: &str =
    include_str!("../../../../packages/data/dictionaries/names/first/fr.json");

  fn test_pipeline_config() -> PipelineConfig {
    PipelineConfig {
      threshold: 0.5,
      enable_trigger_phrases: false,
      enable_regex: false,
      languages: None,
      language: None,
      enable_legal_forms: None,
      enable_name_corpus: false,
      name_corpus_languages: None,
      enable_deny_list: true,
      deny_list_countries: None,
      deny_list_regions: None,
      deny_list_exclude_categories: None,
      custom_deny_list: None,
      custom_regexes: None,
      enable_gazetteer: false,
      enable_countries: None,
      enable_confidence_boost: false,
      enable_coreference: false,
      enable_zone_classification: None,
      enable_hotword_rules: None,
      standalone_street_detection:
        stella_anonymize_core::assemble::StandaloneStreetDetection::default(),
      labels: Vec::new(),
      workspace_id: String::from("test-workspace"),
      dictionaries: None,
    }
  }

  fn test_corpus() -> NameCorpus {
    NameCorpus {
      first_names_list: Vec::new(),
      surnames_list: Vec::new(),
      titles_list: Vec::new(),
      title_abbreviations: Vec::new(),
      excluded_list: Vec::new(),
      common_words: Vec::new(),
      non_western_names_list: Vec::new(),
      excluded_all_caps_list: Vec::new(),
      common_words_set: HashSet::new(),
    }
  }

  #[test]
  fn every_multi_word_city_contributes_a_soft_wrap_head() {
    let entries = soft_wrapped_city_head_entries(&[
      String::from("Merritt Island"),
      String::from("Coeur d'Alene"),
      String::from("Merritt Harbour"),
      String::from("Oslo"),
    ]);

    assert_eq!(
      entries,
      vec![String::from("Merritt"), String::from("Coeur")]
    );
  }

  #[test]
  fn stopword_exclusions_follow_name_corpus_scope_not_content_language() {
    let dictionaries = Dictionaries {
      first_names: Some(OrderedMap(vec![
        (
          String::from("en"),
          serde_json::from_str(ENGLISH_FIRST_NAMES_JSON)
            .expect("English first-name corpus should parse"),
        ),
        (
          String::from("fr"),
          serde_json::from_str(FRENCH_FIRST_NAMES_JSON)
            .expect("French first-name corpus should parse"),
        ),
      ])),
      ..Dictionaries::default()
    };
    let english_scope = [String::from("en")];
    let french_scope = [String::from("fr")];
    let english_corpus =
      build_name_corpus(Some(&dictionaries), Some(english_scope.as_slice()))
        .expect("English name corpus should build");
    let french_corpus =
      build_name_corpus(Some(&dictionaries), Some(french_scope.as_slice()))
        .expect("French name corpus should build");
    let french_names: HashSet<String> = french_corpus
      .first_names_list
      .iter()
      .map(|name| js_lowercase(name))
      .collect();
    let stopword_source: HashSet<String> =
      parse_data_file::<Vec<String>>("stopwords.json")
        .expect("stopwords should parse")
        .into_iter()
        .collect();
    let english_only_stopwords: Vec<String> = english_corpus
      .first_names_list
      .iter()
      .map(|name| js_lowercase(name))
      .filter(|name| {
        stopword_source.contains(name) && !french_names.contains(name)
      })
      .collect();
    assert!(
      !english_only_stopwords.is_empty(),
      "the fixture corpora should include an English-only stopword collision"
    );

    // Deliberately pass the opposite content-language scopes. Only the name
    // corpus selected above may decide which first names leave the stopwords.
    let english_filters = build_deny_list_filter_data(
      &english_corpus,
      Some(french_scope.as_slice()),
    )
    .expect("English filters should build");
    let french_filters = build_deny_list_filter_data(
      &french_corpus,
      Some(english_scope.as_slice()),
    )
    .expect("French filters should build");
    let english_stopwords: HashSet<&str> = english_filters
      .stopwords
      .iter()
      .map(String::as_str)
      .collect();
    let french_stopwords: HashSet<&str> = french_filters
      .stopwords
      .iter()
      .map(String::as_str)
      .collect();
    for name in &english_only_stopwords {
      assert!(
        !english_stopwords.contains(name.as_str()),
        "English corpus name should be excluded from stopwords: {name}"
      );
      assert!(
        french_stopwords.contains(name.as_str()),
        "English-only corpus name leaked into French exclusions: {name}"
      );
    }
  }

  /// `add_deny_list_entry`'s common-word veto (single-word, non-address,
  /// non-custom entries whose lowercase form is in `common-words-en.json`)
  /// used to drop known org/bank aliases like "Citizens" outright. This
  /// exercises the assemble-time exemption directly: an entry present in
  /// `common_word_exemptions` must survive even though it is also a common
  /// word.
  #[test]
  fn exempted_org_alias_survives_common_word_filter() {
    let config = test_pipeline_config();
    let corpus = test_corpus();
    let common_words = HashSet::from([String::from("citizens")]);
    let city_head_words = HashSet::new();
    let month_names = HashSet::new();
    let common_word_exemptions = HashSet::from([String::from("citizens")]);
    let dctx = DenyBuildContext {
      config: &config,
      dictionaries: None,
      use_scoped_name_corpus: false,
      corpus: &corpus,
      common_words: &common_words,
      city_head_words: &city_head_words,
      month_names: &month_names,
      common_word_exemptions: &common_word_exemptions,
    };
    let mut builder = Builder::new();

    add_deny_list_entry(
      &mut builder,
      &dctx,
      "Citizens",
      "organization",
      "deny-list",
    );

    assert!(
      builder.pattern_index.contains_key("citizens"),
      "an exempted org alias should survive the common-word filter"
    );
  }

  /// A common word that is *not* exempted must still be dropped: the
  /// exemption above is deliberately narrow.
  #[test]
  fn plain_common_word_without_exemption_is_still_dropped() {
    let config = test_pipeline_config();
    let corpus = test_corpus();
    let common_words = HashSet::from([String::from("agreement")]);
    let city_head_words = HashSet::new();
    let month_names = HashSet::new();
    let common_word_exemptions = HashSet::new();
    let dctx = DenyBuildContext {
      config: &config,
      dictionaries: None,
      use_scoped_name_corpus: false,
      corpus: &corpus,
      common_words: &common_words,
      city_head_words: &city_head_words,
      month_names: &month_names,
      common_word_exemptions: &common_word_exemptions,
    };
    let mut builder = Builder::new();

    add_deny_list_entry(
      &mut builder,
      &dctx,
      "Agreement",
      "organization",
      "deny-list",
    );

    assert!(
      !builder.pattern_index.contains_key("agreement"),
      "a non-allow-listed common word should still be dropped"
    );
  }

  /// A global fallback name that is also a common word must survive when it
  /// heads a loaded city. It stays tagged as a person-name source so runtime
  /// city-tail evidence can reclassify it before generic person filtering.
  #[test]
  fn common_word_city_head_gets_conditional_source() {
    let config = PipelineConfig {
      enable_name_corpus: true,
      ..test_pipeline_config()
    };
    let corpus = test_corpus();
    let common_words = HashSet::from([String::from("fair")]);
    let city_head_words = HashSet::from([String::from("fair")]);
    let month_names = HashSet::new();
    let common_word_exemptions = HashSet::new();
    let dictionaries = Dictionaries {
      deny_list: Some(OrderedMap(vec![(
        String::from("names/global"),
        vec![String::from("Fair")],
      )])),
      deny_list_meta: Some(OrderedMap(vec![(
        String::from("names/global"),
        DictionaryMeta {
          label: String::from("person"),
          category: DenyListCategory::Names,
          country: None,
        },
      )])),
      ..Dictionaries::default()
    };
    let dctx = DenyBuildContext {
      config: &config,
      dictionaries: Some(&dictionaries),
      use_scoped_name_corpus: false,
      corpus: &corpus,
      common_words: &common_words,
      city_head_words: &city_head_words,
      month_names: &month_names,
      common_word_exemptions: &common_word_exemptions,
    };
    let mut builder = Builder::new();

    apply_dictionary_entries(&mut builder, &dctx, None, &HashSet::new());

    let index = builder
      .pattern_index
      .get("fair")
      .copied()
      .expect("loaded city head should be registered");
    assert_eq!(
      builder.source_list.get(index),
      Some(&vec![String::from(CITY_HEAD_NAME_SOURCE)])
    );
  }

  #[test]
  fn excluded_places_do_not_exempt_city_heads_from_common_word_filter() {
    let config = PipelineConfig {
      enable_name_corpus: true,
      deny_list_exclude_categories: Some(vec![String::from("Places")]),
      ..test_pipeline_config()
    };
    let corpus = NameCorpus {
      common_words_set: HashSet::from([String::from("fair")]),
      ..test_corpus()
    };
    let dictionaries = Dictionaries {
      cities: Some(vec![String::from("Fair Haven")]),
      deny_list: Some(OrderedMap(vec![(
        String::from("names/global"),
        vec![String::from("Fair")],
      )])),
      deny_list_meta: Some(OrderedMap(vec![(
        String::from("names/global"),
        DictionaryMeta {
          label: String::from("person"),
          category: DenyListCategory::Names,
          country: None,
        },
      )])),
      ..Dictionaries::default()
    };

    let data = build_deny_list(&DenyBuildContextArgs {
      config: &config,
      dictionaries: Some(&dictionaries),
      name_corpus_languages: None,
      deny_list_countries: None,
      corpus: &corpus,
    })
    .expect("deny-list assembly should succeed");

    assert!(data.is_none());
  }

  /// The defined-term-quote filter must carry both title sources: plain
  /// title tokens ("dr") and the trailing-dot-stripped abbreviations
  /// ("m" from "M."). Only `titles_list` used to be wired through, so a
  /// quote like `"M. Jean Dupont" shall mean ...` never got the leading
  /// title stripped and stayed suppressed.
  #[test]
  fn quote_filter_title_tokens_include_title_abbreviations() {
    let corpus = NameCorpus {
      titles_list: vec![String::from("dr")],
      title_abbreviations: vec![String::from("m")],
      ..test_corpus()
    };

    let filters = build_deny_list_filter_data(&corpus, None)
      .expect("deny-list filter data should assemble");

    assert!(
      filters.title_tokens.contains(&String::from("dr")),
      "plain title tokens should be retained"
    );
    assert!(
      filters.title_tokens.contains(&String::from("m")),
      "title abbreviations should be unioned into the quote filter"
    );
  }

  #[test]
  fn defined_term_heads_follow_content_language_scope() {
    let corpus = test_corpus();
    let english =
      build_deny_list_filter_data(&corpus, Some(&[String::from("en-US")]))
        .expect("English deny-list filter data should assemble");
    let japanese =
      build_deny_list_filter_data(&corpus, Some(&[String::from("ja")]))
        .expect("Japanese deny-list filter data should assemble");

    assert!(
      english
        .person_trailing_nouns
        .contains(&String::from("award"))
    );
    assert!(
      english
        .address_trailing_nouns
        .contains(&String::from("day"))
    );
    assert!(
      japanese.person_trailing_nouns.is_empty()
        && japanese.address_trailing_nouns.is_empty(),
      "English trailing nouns must not leak into Japanese packages"
    );
  }

  #[test]
  fn page_footer_markers_follow_content_language_scope() {
    let coverage = [
      ("cs", "strana", "stran celkem"),
      ("de", "seite", "seiten insgesamt"),
      ("en", "page", "pages of"),
      ("pt-br", "página", "páginas de"),
      ("es", "página", "páginas de"),
      ("fr", "page", "pages sur"),
      ("hu", "oldal", "oldalak összesen"),
      ("it", "pagina", "pagine di"),
      ("lv", "lapa", "lappuses no"),
      ("pl", "strona", "stron łącznie"),
      ("ro", "pagina", "pagini din"),
      ("sk", "strana", "strán celkom"),
      ("sv", "sida", "sidor av"),
    ];
    let scope_data: Value = parse_data_file("language-scopes.json")
      .expect("language scopes should parse");
    let scope_languages: HashSet<String> = scope_data
      .get("languages")
      .and_then(Value::as_object)
      .expect("language scopes should contain a language map")
      .keys()
      .cloned()
      .collect();
    let covered_languages: HashSet<String> = coverage
      .iter()
      .map(|(language, _, _)| String::from(*language))
      .collect();
    assert_eq!(
      covered_languages, scope_languages,
      "every supported content language needs reviewed page-footer vocabulary"
    );

    for (language, standalone, paired) in coverage {
      let selected = [String::from(language)];
      let filters =
        build_deny_list_filter_data(&test_corpus(), Some(&selected))
          .expect("language-scoped deny-list filters should assemble");
      for expected in [standalone, paired] {
        assert!(
          filters
            .page_footer_markers
            .contains(&String::from(expected)),
          "{language} should include {expected}"
        );
      }
      if language != "en" {
        assert!(
          !filters
            .page_footer_markers
            .contains(&String::from("page of")),
          "{language} should not import English page markers"
        );
      }
    }
  }

  /// The assemble-time exemption is only effective while the exempted word
  /// stays *off* the match-time allow list: `curated_labels_for_match`
  /// (processors.rs) unconditionally rejects any keyword present in
  /// `allow-list.json`, so a word in both files would be registered at
  /// assemble time and then suppressed on every match, silently undoing the
  /// recovery.
  #[test]
  fn common_word_exemptions_stay_off_the_allow_list() {
    let exemptions = load_common_word_exemptions()
      .expect("embedded exemption file should parse");
    assert!(
      !exemptions.is_empty(),
      "the exemption file should carry at least one entry"
    );
    let allow_list: WordsFile = parse_data_file("allow-list.json")
      .expect("embedded allow-list file should parse");
    let allow_list: HashSet<String> = allow_list
      .words
      .iter()
      .map(|word| js_lowercase(word))
      .collect();
    let overlap: Vec<&String> = exemptions.intersection(&allow_list).collect();
    assert!(
      overlap.is_empty(),
      "deny-list common-word exemptions must not appear in allow-list.json \
       (match-time filtering would suppress every match): {overlap:?}"
    );
  }
}
