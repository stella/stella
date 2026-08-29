use std::collections::{BTreeMap, BTreeSet, HashSet, btree_map::Entry};

use smallvec::SmallVec;

use crate::address_seeds::soft_wrapped_us_city_tail;
use crate::byte_offsets::ByteOffsets;
use crate::prepared_metadata::{
  PreparedCountryMatchData, PreparedGazetteerMatchData, PreparedRegexMatchData,
};
use crate::resolution::{
  DetectionSource, PipelineEntity, ResolutionDocument, SourceDetail,
};
use crate::types::{Error, Result, SearchMatch};

const GAZETTEER_EXACT_SCORE: f64 = 0.9;
const GAZETTEER_FUZZY_SCORE: f64 = 0.85;
const COUNTRY_SCORE: f64 = 0.95;
const DENY_LIST_SCORE: f64 = 0.9;
const MAX_GAZETTEER_PREFIX_OVERSHOOT: u32 = 7;
const CUSTOM_DENY_LIST_SOURCE: &str = "custom-deny-list";
const DENY_LIST_SOURCE: &str = "deny-list";
const CITY_SOURCE: &str = "city";
const FIRST_NAME_SOURCE: &str = "first-name";
const SURNAME_SOURCE: &str = "surname";
const CITY_HEAD_NAME_SOURCE: &str = "city-head-name";
const CZECH_FEMININE_SURNAME_SUFFIX: &str = "ová";
const TITLE_SOURCE: &str = "title";
/// A deny-list entry sourced from an injected Names-category dictionary
/// (e.g. the bundled `names/global` fallback list), as opposed to the
/// scoped `first-name`/`surname` name-corpus expansion. Carries the same
/// person-name weight as those two sources: see [`has_person_name_source`].
const NAME_DICTIONARY_SOURCE: &str = "name-dictionary";
use crate::labels::{ADDRESS_LABEL, PERSON_LABEL};

#[derive(
  Clone,
  Copy,
  Debug,
  Default,
  Eq,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct PatternSlice {
  pub start: u32,
  pub end: u32,
}

impl PatternSlice {
  #[must_use]
  pub const fn is_empty(self) -> bool {
    self.start >= self.end
  }

  #[must_use]
  pub const fn len(self) -> u32 {
    self.end.saturating_sub(self.start)
  }

  #[must_use]
  pub const fn contains(self, pattern: u32) -> bool {
    pattern >= self.start && pattern < self.end
  }

  pub(crate) fn local_index(self, pattern: u32) -> Option<usize> {
    if !self.contains(pattern) {
      return None;
    }
    usize::try_from(pattern.saturating_sub(self.start)).ok()
  }
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct RegexMatchMeta {
  pub label: String,
  pub score: f64,
  pub source_detail: Option<SourceDetail>,
  pub requires_validation: bool,
  pub validator_id: Option<String>,
  pub validator_input: Option<String>,
  pub min_byte_length: Option<u32>,
}

impl RegexMatchMeta {
  #[must_use]
  pub fn new(label: impl Into<String>, score: f64) -> Self {
    Self {
      label: label.into(),
      score,
      source_detail: None,
      requires_validation: false,
      validator_id: None,
      validator_input: None,
      min_byte_length: None,
    }
  }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct GazetteerMatchData {
  pub labels: Vec<String>,
  pub is_fuzzy: Vec<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct CountryMatchData {
  pub labels: Vec<String>,
  #[serde(rename = "isoCodes")]
  pub iso_codes: Vec<String>,
  pub variants: Vec<CountryVariant>,
}

#[derive(
  Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
#[serde(rename_all = "lowercase")]
pub enum CountryVariant {
  Name,
  Alias,
  Alpha3,
  Alpha2,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct DenyListMatchData {
  pub labels: StringGroups,
  pub custom_labels: StringGroups,
  pub originals: Vec<String>,
  #[serde(default)]
  pub pattern_meta: DenyListPatternMetaSet,
  pub sources: StringGroups,
  pub filters: Option<DenyListFilterData>,
}

#[derive(
  Clone,
  Copy,
  Debug,
  Default,
  Eq,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct DenyListPatternMeta {
  pub has_alphanumeric: bool,
  pub short_upper_acronym: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
pub struct DenyListPatternMetaSet {
  len: usize,
  has_alphanumeric: Vec<u8>,
  short_upper_acronym: Vec<u8>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StringGroups {
  table: Vec<String>,
  groups: Vec<StringGroupIndexes>,
  group_table: Vec<StringGroupIndexes>,
  group_refs: Vec<u32>,
  empty_len: usize,
}

type StringGroupIndexes = SmallVec<[u32; 2]>;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum StringGroupsWire {
  Empty {
    len: usize,
  },
  Groups {
    table: Vec<String>,
    groups: Vec<StringGroupIndexes>,
  },
  Refs {
    table: Vec<String>,
    group_table: Vec<StringGroupIndexes>,
    group_refs: Vec<u32>,
  },
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum StringGroupsWireRef<'a> {
  Empty {
    len: usize,
  },
  Groups {
    table: &'a [String],
    groups: &'a [StringGroupIndexes],
  },
  Refs {
    table: &'a [String],
    group_table: &'a [StringGroupIndexes],
    group_refs: &'a [u32],
  },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StringGroup<'a> {
  table: &'a [String],
  indexes: &'a [u32],
}

impl StringGroups {
  #[must_use]
  pub fn from_groups(groups: Vec<Vec<String>>) -> Self {
    let mut table = Vec::new();
    let mut table_indexes = BTreeMap::<String, u32>::new();
    let groups = groups
      .into_iter()
      .map(|group| {
        group
          .into_iter()
          .map(|value| {
            string_table_index(value, &mut table, &mut table_indexes)
          })
          .collect::<StringGroupIndexes>()
      })
      .collect();

    Self::from_table_and_groups(table, groups)
  }

  pub fn from_table_indices(
    table: Vec<String>,
    groups: Vec<Vec<u32>>,
    field: &'static str,
  ) -> Result<Self> {
    for group in &groups {
      for &index in group {
        let Ok(index) = usize::try_from(index) else {
          return Err(Error::InvalidStaticData {
            field,
            reason: String::from("string table index exceeds usize range"),
          });
        };
        if index >= table.len() {
          return Err(Error::InvalidStaticData {
            field,
            reason: String::from("string table index out of range"),
          });
        }
      }
    }

    let groups = groups
      .into_iter()
      .map(StringGroupIndexes::from_vec)
      .collect();

    Ok(Self::from_table_and_groups(table, groups))
  }

  #[must_use]
  pub const fn empty_groups(len: usize) -> Self {
    Self {
      table: Vec::new(),
      groups: Vec::new(),
      group_table: Vec::new(),
      group_refs: Vec::new(),
      empty_len: len,
    }
  }

  #[must_use]
  pub const fn len(&self) -> usize {
    if self.empty_len > 0 {
      return self.empty_len;
    }
    if self.group_refs.is_empty() {
      return self.groups.len();
    }
    self.group_refs.len()
  }

  #[must_use]
  pub const fn is_empty(&self) -> bool {
    self.len() == 0
  }

  #[must_use]
  pub fn get(&self, index: usize) -> Option<StringGroup<'_>> {
    let indexes = self.group_indexes(index)?;
    Some(StringGroup {
      table: &self.table,
      indexes,
    })
  }

  pub fn iter(&self) -> impl Iterator<Item = StringGroup<'_>> {
    (0..self.len()).filter_map(|index| self.get(index))
  }

  pub fn validate(&self, field: &'static str) -> Result<()> {
    if self.empty_len > 0 {
      if self.table.is_empty()
        && self.groups.is_empty()
        && self.group_table.is_empty()
        && self.group_refs.is_empty()
      {
        return Ok(());
      }
      return Err(Error::InvalidStaticData {
        field,
        reason: String::from("empty string groups carry data"),
      });
    }

    if self.group_refs.is_empty() {
      validate_group_indexes(field, &self.table, &self.groups)?;
      return Ok(());
    }

    validate_group_indexes(field, &self.table, &self.group_table)?;
    for &group_ref in &self.group_refs {
      let Ok(index) = usize::try_from(group_ref) else {
        return Err(Error::InvalidStaticData {
          field,
          reason: String::from("group reference exceeds usize range"),
        });
      };
      if index >= self.group_table.len() {
        return Err(Error::InvalidStaticData {
          field,
          reason: String::from("group reference out of range"),
        });
      }
    }
    Ok(())
  }

  fn from_table_and_groups(
    table: Vec<String>,
    groups: Vec<StringGroupIndexes>,
  ) -> Self {
    let (group_table, group_refs) = compact_repeated_groups(&groups);
    if group_table.len() < groups.len() {
      return Self {
        table,
        groups: Vec::new(),
        group_table,
        group_refs,
        empty_len: 0,
      };
    }

    Self {
      table,
      groups,
      group_table: Vec::new(),
      group_refs: Vec::new(),
      empty_len: 0,
    }
  }

  fn group_indexes(&self, index: usize) -> Option<&[u32]> {
    if self.empty_len > 0 {
      return (index < self.empty_len).then_some(&[]);
    }
    if self.group_refs.is_empty() {
      return self.groups.get(index).map(SmallVec::as_slice);
    }
    let group_ref = *self.group_refs.get(index)?;
    let group_index = usize::try_from(group_ref).ok()?;
    self.group_table.get(group_index).map(SmallVec::as_slice)
  }
}

fn compact_repeated_groups(
  groups: &[StringGroupIndexes],
) -> (Vec<StringGroupIndexes>, Vec<u32>) {
  let mut table = Vec::<StringGroupIndexes>::new();
  let mut table_indexes = BTreeMap::<Vec<u32>, u32>::new();
  let mut refs = Vec::with_capacity(groups.len());
  for group in groups {
    let key = group.to_vec();
    let index = match table_indexes.entry(key) {
      Entry::Occupied(entry) => *entry.get(),
      Entry::Vacant(entry) => {
        let index = u32::try_from(table.len()).unwrap_or(u32::MAX);
        entry.insert(index);
        table.push(group.clone());
        index
      }
    };
    refs.push(index);
  }
  (table, refs)
}

fn validate_group_indexes(
  field: &'static str,
  table: &[String],
  groups: &[StringGroupIndexes],
) -> Result<()> {
  for group in groups {
    for &index in group {
      let Ok(index) = usize::try_from(index) else {
        return Err(Error::InvalidStaticData {
          field,
          reason: String::from("string table index exceeds usize range"),
        });
      };
      if index >= table.len() {
        return Err(Error::InvalidStaticData {
          field,
          reason: String::from("string table index out of range"),
        });
      }
    }
  }
  Ok(())
}

impl DenyListMatchData {
  pub fn compact_runtime_patterns(&mut self) {
    if self.originals.is_empty() {
      return;
    }

    self.pattern_meta = DenyListPatternMetaSet::from_patterns(&self.originals);
    self.originals.clear();
  }

  fn pattern_meta(&self, index: usize) -> DenyListPatternMeta {
    self
      .pattern_meta
      .get(index)
      .or_else(|| {
        self
          .originals
          .get(index)
          .map(|pattern| DenyListPatternMeta::from_pattern(pattern))
      })
      .unwrap_or_default()
  }

  pub(crate) fn pattern_has_city_source(&self, index: usize) -> bool {
    self
      .sources
      .get(index)
      .is_some_and(|sources| sources.iter().any(|source| source == CITY_SOURCE))
  }
}

impl DenyListPatternMetaSet {
  #[must_use]
  pub fn from_entries(entries: &[DenyListPatternMeta]) -> Self {
    if entries.is_empty() {
      return Self::default();
    }

    let len = entries.len();
    let mut has_alphanumeric = vec![0u8; bitset_len(len)];
    let mut short_upper_acronym = vec![0u8; bitset_len(len)];
    for (index, entry) in entries.iter().enumerate() {
      if entry.has_alphanumeric {
        set_bit(&mut has_alphanumeric, index);
      }
      if entry.short_upper_acronym {
        set_bit(&mut short_upper_acronym, index);
      }
    }
    Self {
      len,
      has_alphanumeric,
      short_upper_acronym,
    }
  }

  #[must_use]
  pub fn from_patterns(patterns: &[String]) -> Self {
    let entries = patterns
      .iter()
      .map(|pattern| DenyListPatternMeta::from_pattern(pattern))
      .collect::<Vec<_>>();
    Self::from_entries(&entries)
  }

  #[must_use]
  pub const fn len(&self) -> usize {
    self.len
  }

  #[must_use]
  pub const fn is_empty(&self) -> bool {
    self.len == 0
  }

  #[must_use]
  pub fn first(&self) -> Option<DenyListPatternMeta> {
    self.get(0)
  }

  #[must_use]
  pub fn get(&self, index: usize) -> Option<DenyListPatternMeta> {
    if index >= self.len {
      return None;
    }
    Some(DenyListPatternMeta {
      has_alphanumeric: has_bit(&self.has_alphanumeric, index),
      short_upper_acronym: has_bit(&self.short_upper_acronym, index),
    })
  }
}

impl<'de> serde::Deserialize<'de> for DenyListPatternMetaSet {
  fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    #[derive(serde::Deserialize)]
    struct Wire {
      len: usize,
      has_alphanumeric: Vec<u8>,
      short_upper_acronym: Vec<u8>,
    }

    let wire = Wire::deserialize(deserializer)?;
    validate_meta_bitsets(
      wire.len,
      &wire.has_alphanumeric,
      &wire.short_upper_acronym,
    )
    .map_err(serde::de::Error::custom)?;
    Ok(Self {
      len: wire.len,
      has_alphanumeric: wire.has_alphanumeric,
      short_upper_acronym: wire.short_upper_acronym,
    })
  }
}

const fn bitset_len(len: usize) -> usize {
  len.div_ceil(8)
}

fn validate_meta_bitsets(
  len: usize,
  has_alphanumeric: &[u8],
  short_upper_acronym: &[u8],
) -> std::result::Result<(), String> {
  let expected_len = bitset_len(len);
  if has_alphanumeric.len() != expected_len {
    return Err(format!(
      "has_alphanumeric bitset length mismatch: expected {expected_len}, got {}",
      has_alphanumeric.len()
    ));
  }
  if short_upper_acronym.len() != expected_len {
    return Err(format!(
      "short_upper_acronym bitset length mismatch: expected {expected_len}, got {}",
      short_upper_acronym.len()
    ));
  }
  if has_unused_bits(has_alphanumeric, len)
    || has_unused_bits(short_upper_acronym, len)
  {
    return Err(String::from("pattern metadata bitset has unused bits set"));
  }
  Ok(())
}

fn set_bit(bits: &mut [u8], index: usize) {
  let Some(byte) = bits.get_mut(bit_byte_index(index)) else {
    return;
  };
  *byte |= 1u8 << bit_offset(index);
}

fn has_bit(bits: &[u8], index: usize) -> bool {
  bits
    .get(bit_byte_index(index))
    .is_some_and(|byte| byte & (1u8 << bit_offset(index)) != 0)
}

const fn bit_byte_index(index: usize) -> usize {
  index >> 3
}

const fn bit_offset(index: usize) -> usize {
  index & 7
}

fn has_unused_bits(bits: &[u8], len: usize) -> bool {
  let used_in_last = len % 8;
  if used_in_last == 0 {
    return false;
  }
  let Some(last) = bits.last() else {
    return false;
  };
  let unused_mask = u8::MAX << used_in_last;
  last & unused_mask != 0
}

impl DenyListPatternMeta {
  fn from_pattern(pattern: &str) -> Self {
    Self {
      has_alphanumeric: pattern.chars().any(char::is_alphanumeric),
      short_upper_acronym: !pattern.is_empty()
        && pattern.len() <= 5
        && all_upper(pattern),
    }
  }
}

impl From<Vec<Vec<String>>> for StringGroups {
  fn from(groups: Vec<Vec<String>>) -> Self {
    Self::from_groups(groups)
  }
}

impl serde::Serialize for StringGroups {
  fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    let wire = if self.empty_len > 0 {
      StringGroupsWireRef::Empty {
        len: self.empty_len,
      }
    } else if self.group_refs.is_empty() {
      StringGroupsWireRef::Groups {
        table: &self.table,
        groups: &self.groups,
      }
    } else {
      StringGroupsWireRef::Refs {
        table: &self.table,
        group_table: &self.group_table,
        group_refs: &self.group_refs,
      }
    };
    wire.serialize(serializer)
  }
}

impl<'de> serde::Deserialize<'de> for StringGroups {
  fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    let groups = match StringGroupsWire::deserialize(deserializer)? {
      StringGroupsWire::Empty { len } => Self::empty_groups(len),
      StringGroupsWire::Groups { table, groups } => {
        Self::from_table_and_groups(table, groups)
      }
      StringGroupsWire::Refs {
        table,
        group_table,
        group_refs,
      } => Self {
        table,
        groups: Vec::new(),
        group_table,
        group_refs,
        empty_len: 0,
      },
    };
    groups
      .validate("string_groups")
      .map_err(serde::de::Error::custom)?;
    Ok(groups)
  }
}

impl<'a> StringGroup<'a> {
  #[must_use]
  pub const fn is_empty(self) -> bool {
    self.indexes.is_empty()
  }

  pub fn iter(self) -> impl Iterator<Item = &'a str> + 'a {
    self
      .indexes
      .iter()
      .filter_map(|index| usize::try_from(*index).ok())
      .filter_map(|index| self.table.get(index))
      .map(String::as_str)
  }

  #[must_use]
  pub fn contains(self, value: &str) -> bool {
    self.iter().any(|entry| entry == value)
  }

  #[must_use]
  pub fn to_strings(self) -> Vec<String> {
    self.iter().map(String::from).collect()
  }
}

fn string_table_index(
  value: String,
  table: &mut Vec<String>,
  table_indexes: &mut BTreeMap<String, u32>,
) -> u32 {
  if let Some(index) = table_indexes.get(&value) {
    return *index;
  }
  let index = u32::try_from(table.len()).unwrap_or(u32::MAX);
  table_indexes.insert(value.clone(), index);
  table.push(value);
  index
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct DenyListFilterData {
  pub stopwords: BTreeSet<String>,
  pub allow_list: BTreeSet<String>,
  pub person_stopwords: BTreeSet<String>,
  pub person_trailing_nouns: BTreeSet<String>,
  pub address_trailing_nouns: BTreeSet<String>,
  pub address_stopwords: BTreeSet<String>,
  pub address_jurisdiction_prefixes: BTreeSet<String>,
  pub street_types: BTreeSet<String>,
  pub address_component_terms: BTreeSet<String>,
  pub ambiguous_street_type_terms: BTreeSet<String>,
  pub first_names: BTreeSet<String>,
  pub generic_roles: BTreeSet<String>,
  pub page_footer_markers: BTreeSet<String>,
  pub number_abbrev_prefixes: BTreeSet<String>,
  pub sentence_starters: BTreeSet<String>,
  pub trailing_address_word_exclusions: BTreeSet<String>,
  pub document_heading_words: BTreeSet<String>,
  pub document_heading_ordinal_markers: BTreeSet<String>,
  pub defined_term_cues: BTreeSet<String>,
  pub signing_place_guards: Vec<SigningPlaceGuardData>,
  /// Lowercase title tokens (e.g. "dr", "mr", "prof") that may prefix a
  /// person name. Used to strip a leading title before checking whether a
  /// defined-term quote starts with a known first name.
  pub title_tokens: BTreeSet<String>,
  /// Lowercase building unit designators ("suite", "apt", "unit", ...) that
  /// introduce a unit line rather than a new prose sentence.
  pub unit_designators: BTreeSet<String>,
  /// Lowercase connective words allowed inside a name ("of", "de", "von",
  /// "and", "&", ...); a run of them between capitals stays part of the name.
  pub in_name_connectors: BTreeSet<String>,
  /// Country-scoped US postal abbreviations. Empty when US data is disabled.
  pub us_state_abbreviations: BTreeSet<String>,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct SigningPlaceGuardData {
  pub prefix_phrases: BTreeSet<String>,
  pub suffix_phrases: BTreeSet<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RawDenyListMatch {
  pattern: usize,
  start: u32,
  end: u32,
  labels: Vec<String>,
  custom_labels: Vec<String>,
  has_person_name_source: bool,
  has_city_head_name_source: bool,
  has_surname_evidence: bool,
  text: String,
}

/// Spans of deny-list hits that carry surname evidence, built once per
/// document. Single-name context checks ask about one span, so the backing
/// set stays private and callers get only that bounded query.
#[derive(Debug, Default)]
struct SurnameEvidenceIndex {
  spans: HashSet<(u32, u32)>,
  /// Structural work counters: one visit per hit at build, one probe per
  /// query. Together they pin the total work at hits + queries.
  #[cfg(test)]
  build_visits: usize,
  #[cfg(test)]
  probes: std::cell::Cell<usize>,
}

impl SurnameEvidenceIndex {
  fn build(hits: &[RawDenyListMatch]) -> Self {
    let mut spans = HashSet::new();
    #[cfg(test)]
    let mut build_visits = 0usize;
    for hit in hits {
      #[cfg(test)]
      {
        build_visits = build_visits.saturating_add(1);
      }
      if hit.has_surname_evidence {
        spans.insert((hit.start, hit.end));
      }
    }
    Self {
      spans,
      #[cfg(test)]
      build_visits,
      #[cfg(test)]
      probes: std::cell::Cell::new(0),
    }
  }

  fn covers(&self, start: u32, end: u32) -> bool {
    #[cfg(test)]
    self.probes.set(self.probes.get().saturating_add(1));
    self.spans.contains(&(start, end))
  }
}

fn sources_include(sources: StringGroup<'_>, expected: &str) -> bool {
  sources.iter().any(|source| source == expected)
}

fn sources_include_regular_person_name(sources: StringGroup<'_>) -> bool {
  [FIRST_NAME_SOURCE, SURNAME_SOURCE, NAME_DICTIONARY_SOURCE]
    .iter()
    .any(|source| sources_include(sources, source))
}

pub fn process_regex_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  meta: &[RegexMatchMeta],
) -> Result<Vec<PipelineEntity>> {
  let prepared =
    PreparedRegexMatchData::new(meta.to_vec(), slice, "regex_meta")?;
  process_prepared_regex_matches(matches, full_text, &prepared)
}

pub(crate) fn process_prepared_regex_matches(
  matches: &[SearchMatch],
  full_text: &str,
  meta: &PreparedRegexMatchData,
) -> Result<Vec<PipelineEntity>> {
  let offsets = ByteOffsets::new(full_text);
  let mut results = Vec::new();

  for found in matches {
    let pattern = found.pattern();
    let Some(entry) = meta.get(pattern) else {
      continue;
    };
    let text = offsets.slice(found.start(), found.end())?;
    if !entry.accepts(&text) || !entry.accepts_byte_length(byte_len(&text)) {
      continue;
    }

    let mut entity = PipelineEntity::detected(
      found.start(),
      found.end(),
      entry.label(),
      text,
      entry.score(),
      DetectionSource::Regex,
    );
    entity.source_detail = entry.source_detail();
    results.push(entity);
  }

  Ok(results)
}

pub fn process_deny_list_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &DenyListMatchData,
) -> Result<Vec<PipelineEntity>> {
  let document = ResolutionDocument::new(full_text);
  process_deny_list_matches_with_field_labels(
    matches,
    slice,
    &document,
    data,
    &[],
  )
}

pub(crate) fn process_deny_list_matches_with_field_labels(
  matches: &[SearchMatch],
  slice: PatternSlice,
  document: &ResolutionDocument<'_>,
  data: &DenyListMatchData,
  person_field_labels: &[String],
) -> Result<Vec<PipelineEntity>> {
  let full_text = document.text();
  let offsets = document.offsets();
  let mut matches =
    collect_deny_list_matches(matches, slice, full_text, data, &offsets)?;
  suppress_shorter_curated_contained_matches(&mut matches);

  let mut results = Vec::new();
  let mut name_hits = Vec::new();

  for found in &matches {
    for label in &found.custom_labels {
      let mut entity = PipelineEntity::detected(
        found.start,
        found.end,
        label.clone(),
        found.text.clone(),
        DENY_LIST_SCORE,
        DetectionSource::DenyList,
      );
      entity.source_detail = Some(SourceDetail::CustomDenyList);
      results.push(entity);
    }
  }

  for found in &matches {
    if found.labels.is_empty() {
      continue;
    }
    if found.labels.iter().any(|label| label == PERSON_LABEL)
      && (found.has_person_name_source
        || !filter_contains(
          data
            .filters
            .as_ref()
            .map(|filters| &filters.person_stopwords),
          &found.text.to_lowercase(),
        ))
    {
      name_hits.push(found.clone());
    }

    let suppress_address =
      should_suppress_address(full_text, &offsets, data, found)?;
    for label in found.labels.iter().filter(|label| *label != PERSON_LABEL) {
      if label == ADDRESS_LABEL && suppress_address {
        continue;
      }
      results.push(PipelineEntity::detected(
        found.start,
        found.end,
        label.clone(),
        found.text.clone(),
        DENY_LIST_SCORE,
        DetectionSource::DenyList,
      ));
    }
  }

  append_person_name_hits(
    &mut results,
    data,
    &mut name_hits,
    &SurnameEvidenceIndex::build(&matches),
    person_field_labels,
    document,
  )?;
  extend_city_districts(
    &mut results,
    full_text,
    &offsets,
    data.filters.as_ref(),
  )?;

  Ok(results)
}

fn suppress_shorter_curated_contained_matches(
  matches: &mut [RawDenyListMatch],
) {
  let mut ranges = Vec::<(u32, u32)>::new();
  for found in matches.iter() {
    if found.labels.is_empty() {
      continue;
    }
    ranges.push((found.start, found.end));
  }

  ranges.sort_by(|left, right| {
    left.0.cmp(&right.0).then_with(|| right.1.cmp(&left.1))
  });

  let mut suppress = BTreeSet::<(u32, u32)>::new();
  let mut max_end = None::<u32>;
  let mut max_end_start = None::<u32>;
  for (start, end) in ranges {
    if max_end.is_some_and(|container_end| {
      container_end > end
        || (container_end == end
          && max_end_start
            .is_some_and(|container_start| container_start < start))
    }) {
      suppress.insert((start, end));
    }
    if max_end.is_none_or(|current| end > current) {
      max_end = Some(end);
      max_end_start = Some(start);
    }
  }

  if suppress.is_empty() {
    return;
  }

  for found in matches.iter_mut() {
    if found.labels.is_empty() {
      continue;
    }
    if suppress.contains(&(found.start, found.end)) {
      found.labels.clear();
    }
  }
}

fn collect_deny_list_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &DenyListMatchData,
  offsets: &ByteOffsets<'_>,
) -> Result<Vec<RawDenyListMatch>> {
  let mut results = Vec::new();

  for found in matches {
    let Some(local_index) = slice.local_index(found.pattern()) else {
      continue;
    };
    let Some(labels) = data.labels.get(local_index) else {
      continue;
    };
    let Some(sources) = data.sources.get(local_index) else {
      continue;
    };
    validate_deny_list_sources(sources)?;

    let match_text = offsets.slice(found.start(), found.end())?;
    let keyword = match_text.to_lowercase();
    let pattern_meta = data.pattern_meta(local_index);
    let custom_pattern_labels = data
      .custom_labels
      .get(local_index)
      .map(StringGroup::to_strings)
      .unwrap_or_default();
    let custom_edges_are_valid = custom_match_has_valid_edges(
      full_text,
      offsets,
      found.start(),
      found.end(),
      pattern_meta.has_alphanumeric,
    )?;
    let custom_labels = if custom_edges_are_valid {
      custom_pattern_labels.clone()
    } else {
      Vec::new()
    };

    if labels.is_empty() && custom_labels.is_empty() {
      continue;
    }

    let has_city_head_name_source =
      sources_include(sources, CITY_HEAD_NAME_SOURCE);
    let city_head_name_requires_tail = has_city_head_name_source
      && !sources_include_regular_person_name(sources);
    let mut keep_surname_evidence = false;
    let curated_labels = if has_curated_source(sources) {
      let filters = data.filters.as_ref().ok_or(Error::MissingStaticData {
        field: "deny_list.filters",
      })?;
      let curated_match = CuratedDenyListMatch {
        full_text,
        offsets,
        start: found.start(),
        match_text: &match_text,
        keyword: &keyword,
        pattern_meta,
        labels,
        custom_pattern_labels: &custom_pattern_labels,
        custom_edges_are_valid,
        city_head_name_requires_tail,
        filters,
      };
      keep_surname_evidence = sources_include(sources, SURNAME_SOURCE)
        && uppercase_surname_evidence_is_allowed(&curated_match)?;
      curated_labels_for_match(&curated_match)?
    } else {
      Vec::new()
    };

    if curated_labels.is_empty()
      && custom_labels.is_empty()
      && !keep_surname_evidence
    {
      continue;
    }

    results.push(RawDenyListMatch {
      pattern: local_index,
      start: found.start(),
      end: found.end(),
      labels: curated_labels,
      custom_labels,
      has_person_name_source: has_city_head_name_source
        || sources_include_regular_person_name(sources),
      has_city_head_name_source,
      has_surname_evidence: keep_surname_evidence,
      text: match_text,
    });
  }

  results.sort_by(|left, right| {
    left
      .pattern
      .cmp(&right.pattern)
      .then_with(|| left.start.cmp(&right.start))
      .then_with(|| left.end.cmp(&right.end))
  });
  Ok(results)
}

struct CuratedDenyListMatch<'a> {
  full_text: &'a str,
  offsets: &'a ByteOffsets<'a>,
  start: u32,
  match_text: &'a str,
  keyword: &'a str,
  pattern_meta: DenyListPatternMeta,
  labels: StringGroup<'a>,
  custom_pattern_labels: &'a [String],
  custom_edges_are_valid: bool,
  city_head_name_requires_tail: bool,
  filters: &'a DenyListFilterData,
}

fn curated_labels_for_match(
  args: &CuratedDenyListMatch<'_>,
) -> Result<Vec<String>> {
  let acronym_matches_acronym =
    !args.pattern_meta.short_upper_acronym || all_upper(args.match_text);
  let source_char = char_at(args.full_text, args.offsets, args.start)?;
  let common_word = args.filters.stopwords.contains(args.keyword)
    || args.filters.allow_list.contains(args.keyword);
  let has_city_tail = has_soft_wrapped_us_city_tail(args)?;
  let city_head_candidate = common_word && has_city_tail;
  let passes_filters = source_char.is_some_and(char::is_uppercase)
    && (!common_word || city_head_candidate)
    && acronym_matches_acronym
    && !all_upper(args.match_text);

  if !passes_filters || !args.custom_edges_are_valid {
    return Ok(Vec::new());
  }

  if is_dotted_acronym_suffix_collision(
    args.full_text,
    args.offsets,
    args.start,
    args.match_text,
  )? {
    return Ok(Vec::new());
  }

  // Hyphen compounds (Dodd-Frank, Brno-Nový) are real tokens for places and
  // orgs; preserve person names only when both components have name evidence.
  let has_hyphen_edge = has_hyphen_compound_edge(
    args.full_text,
    args.offsets,
    args.start,
    args.start.saturating_add(byte_len(args.match_text)),
  )?;
  let supported_hyphenated_person = has_hyphen_edge
    && has_supported_hyphenated_person_edge(
      args.full_text,
      args.offsets,
      args.start,
      args.start.saturating_add(byte_len(args.match_text)),
      args.keyword,
      args.filters,
    )?;

  Ok(
    args
      .labels
      .iter()
      .filter(|label| {
        let is_custom_duplicate = args
          .custom_pattern_labels
          .iter()
          .any(|custom| custom == label);
        let is_hyphenated_person = has_hyphen_edge
          && !supported_hyphenated_person
          && *label == PERSON_LABEL;
        let is_city_head_person_without_evidence = args
          .city_head_name_requires_tail
          && !has_city_tail
          && *label == PERSON_LABEL;
        !is_custom_duplicate
          && !is_hyphenated_person
          && !is_city_head_person_without_evidence
      })
      .map(String::from)
      .collect(),
  )
}

fn has_soft_wrapped_us_city_tail(
  args: &CuratedDenyListMatch<'_>,
) -> Result<bool> {
  let end = args.start.saturating_add(byte_len(args.match_text));
  let end_byte = args.offsets.validate_offset(end)?;
  Ok(
    args
      .full_text
      .get(end_byte..)
      .and_then(|after| {
        soft_wrapped_us_city_tail(after, &args.filters.us_state_abbreviations)
      })
      .is_some(),
  )
}

fn uppercase_surname_evidence_is_allowed(
  args: &CuratedDenyListMatch<'_>,
) -> Result<bool> {
  let acronym_matches_acronym =
    !args.pattern_meta.short_upper_acronym || all_upper(args.match_text);
  let source_char = char_at(args.full_text, args.offsets, args.start)?;
  if !all_upper(args.match_text)
    || !source_char.is_some_and(char::is_uppercase)
    || args.filters.stopwords.contains(args.keyword)
    || args.filters.allow_list.contains(args.keyword)
    || !acronym_matches_acronym
    || !args.custom_edges_are_valid
    || is_dotted_acronym_suffix_collision(
      args.full_text,
      args.offsets,
      args.start,
      args.match_text,
    )?
  {
    return Ok(false);
  }

  let end = args.start.saturating_add(byte_len(args.match_text));
  if !has_hyphen_compound_edge(args.full_text, args.offsets, args.start, end)? {
    return Ok(true);
  }

  has_supported_hyphenated_person_edge(
    args.full_text,
    args.offsets,
    args.start,
    end,
    args.keyword,
    args.filters,
  )
}

fn should_suppress_address(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  data: &DenyListMatchData,
  found: &RawDenyListMatch,
) -> Result<bool> {
  if !is_single_word(found.text.as_str()) {
    return Ok(false);
  }
  let Some(filters) = &data.filters else {
    return Ok(false);
  };
  if is_signing_place_context(
    full_text,
    offsets,
    found.start,
    found.end,
    filters,
  )? {
    return Ok(true);
  }
  let lower = found.text.to_lowercase();
  if !filters.address_stopwords.contains(&lower) {
    return Ok(false);
  }

  Ok(!has_adjacent_address_evidence(
    full_text,
    found.start,
    found.end,
    filters,
  )?)
}

fn is_signing_place_context(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
  filters: &DenyListFilterData,
) -> Result<bool> {
  if filters.signing_place_guards.is_empty() {
    return Ok(false);
  }

  let start_byte = offsets.validate_offset(start)?;
  let end_byte = offsets.validate_offset(end)?;
  let before = full_text.get(..start_byte).unwrap_or_default();
  let after = full_text.get(end_byte..).unwrap_or_default();

  Ok(filters.signing_place_guards.iter().any(|guard| {
    !guard.prefix_phrases.is_empty()
      && !guard.suffix_phrases.is_empty()
      && context_before_matches_any_phrase(before, &guard.prefix_phrases)
      && context_after_matches_any_phrase(after, &guard.suffix_phrases)
  }))
}

fn context_before_matches_any_phrase(
  before: &str,
  phrases: &BTreeSet<String>,
) -> bool {
  phrases.iter().any(|phrase| {
    phrase.is_empty() || context_before_matches_phrase(before, phrase)
  })
}

fn context_after_matches_any_phrase(
  after: &str,
  phrases: &BTreeSet<String>,
) -> bool {
  phrases.iter().any(|phrase| {
    phrase.is_empty() || context_after_matches_phrase(after, phrase)
  })
}

fn context_before_matches_phrase(before: &str, phrase: &str) -> bool {
  let trimmed = before.trim_end_matches(char::is_whitespace);
  let Some((phrase_start, suffix)) =
    trailing_char_slice(trimmed, phrase.chars().count())
  else {
    return false;
  };
  if !casefolds_to(suffix, phrase) {
    return false;
  }
  char_before_byte(trimmed, phrase_start).is_none_or(|ch| !ch.is_alphanumeric())
}

fn context_after_matches_phrase(after: &str, phrase: &str) -> bool {
  let trimmed = after.trim_start_matches(char::is_whitespace);
  let trimmed = trimmed.strip_prefix(',').map_or(trimmed, |value| {
    value.trim_start_matches(char::is_whitespace)
  });
  let Some(prefix) = leading_char_slice(trimmed, phrase.chars().count()) else {
    return false;
  };
  if !casefolds_to(prefix, phrase) {
    return false;
  }
  char_after_byte(trimmed, prefix.len()).is_none_or(|ch| !ch.is_alphanumeric())
}

fn trailing_char_slice(text: &str, char_count: usize) -> Option<(usize, &str)> {
  let mut start = text.len();
  for _ in 0..char_count {
    let (previous_start, _) = text.get(..start)?.char_indices().next_back()?;
    start = previous_start;
  }
  Some((start, text.get(start..)?))
}

fn leading_char_slice(text: &str, char_count: usize) -> Option<&str> {
  let mut end = 0_usize;
  for _ in 0..char_count {
    let (index, ch) = text.get(end..)?.char_indices().next()?;
    end = end.saturating_add(index).saturating_add(ch.len_utf8());
  }
  text.get(..end)
}

fn casefolds_to(value: &str, lower: &str) -> bool {
  value.to_lowercase() == lower
}

fn has_city_tail_context(
  hit: &RawDenyListMatch,
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  filters: &DenyListFilterData,
) -> Result<bool> {
  if !hit.has_city_head_name_source {
    return Ok(false);
  }
  let end_byte = offsets.validate_offset(hit.end)?;
  Ok(
    full_text
      .get(end_byte..)
      .and_then(|after| {
        soft_wrapped_us_city_tail(after, &filters.us_state_abbreviations)
      })
      .is_some(),
  )
}

fn prepare_name_hits(name_hits: &mut [RawDenyListMatch]) -> Vec<bool> {
  name_hits.sort_by_key(|hit| hit.start);
  vec![false; name_hits.len()]
}

fn append_person_name_hits(
  results: &mut Vec<PipelineEntity>,
  data: &DenyListMatchData,
  name_hits: &mut [RawDenyListMatch],
  surname_evidence: &SurnameEvidenceIndex,
  person_field_labels: &[String],
  document: &ResolutionDocument<'_>,
) -> Result<()> {
  let full_text = document.text();
  let offsets = document.offsets();
  let mut consumed = prepare_name_hits(name_hits);

  for index in 0..name_hits.len() {
    if consumed.get(index).copied().unwrap_or(false) {
      continue;
    }
    let Some(hit) = name_hits.get(index) else {
      continue;
    };

    let mut chain = vec![hit];
    let mut cursor = index.saturating_add(1);

    while cursor < name_hits.len() && chain.len() < 5 {
      let Some(next) = name_hits.get(cursor) else {
        break;
      };
      let Some(prev) = chain.last().copied() else {
        break;
      };
      if next.start < prev.end {
        break;
      }
      let gap = offsets.slice(prev.end, next.start)?;
      if person_chain_breaks(prev.text.as_str(), gap.as_str()) {
        break;
      }

      chain.push(next);
      cursor = cursor.saturating_add(1);
    }

    for consumed_index in index..index.saturating_add(chain.len()) {
      if let Some(entry) = consumed.get_mut(consumed_index) {
        *entry = true;
      }
    }

    if !chain.iter().copied().any(has_person_name_source) {
      continue;
    }

    let Some(first) = chain.first() else {
      continue;
    };
    let Some(last) = chain.last() else {
      continue;
    };
    let Some(filters) = &data.filters else {
      continue;
    };
    if is_suppressible_defined_term_quote(
      full_text,
      &offsets,
      first.start,
      filters,
    )? {
      continue;
    }

    let city_tail = has_city_tail_context(first, full_text, &offsets, filters)?;
    let single_name_context = if chain.len() == 1 && city_tail {
      SingleNameContext::Capitalized
    } else if chain.len() == 1 {
      single_name_hit_context(SingleNameHitContextOptions {
        full_text,
        offsets: &offsets,
        first_name_span: first.start..last.end,
        filters,
        surname_evidence,
      })?
    } else {
      SingleNameContext::None
    };
    if chain.len() == 1 && single_name_context == SingleNameContext::None {
      continue;
    }
    let mut extended = extend_person_name(
      full_text,
      &offsets,
      first.start,
      last.end,
      filters,
      person_field_labels,
      document,
    )?;
    let score = extended_person_score(chain.len(), single_name_context);
    if let SingleNameContext::KnownUppercaseSurname { end } =
      single_name_context
      && end > extended.end
    {
      extended = ExtendedName {
        end,
        text: offsets.slice(first.start, end)?,
      };
    }

    results.push(PipelineEntity::detected(
      first.start,
      extended.end,
      PERSON_LABEL,
      extended.text,
      score,
      DetectionSource::DenyList,
    ));
  }

  Ok(())
}

const fn extended_person_score(
  chain_len: usize,
  context: SingleNameContext,
) -> f64 {
  if chain_len >= 2
    || matches!(context, SingleNameContext::KnownUppercaseSurname { .. })
  {
    return 0.9;
  }
  0.5
}

pub fn process_gazetteer_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &GazetteerMatchData,
) -> Result<Vec<PipelineEntity>> {
  let prepared = PreparedGazetteerMatchData::new(data.clone(), slice)?;
  process_prepared_gazetteer_matches(matches, full_text, &prepared)
}

pub(crate) fn process_prepared_gazetteer_matches(
  matches: &[SearchMatch],
  full_text: &str,
  data: &PreparedGazetteerMatchData,
) -> Result<Vec<PipelineEntity>> {
  let offsets = ByteOffsets::new(full_text);
  let mut results = Vec::new();
  let mut exact_spans = Vec::<(u32, u32)>::new();

  for found in matches {
    let Some(row) = data.get(found.pattern()) else {
      continue;
    };
    if row.is_fuzzy() {
      continue;
    }
    let extended = try_gazetteer_prefix_extension(&offsets, found)?;
    let (end, text, source_detail) = if let Some(extension) = extended {
      extension
    } else {
      (
        found.end(),
        offsets.slice(found.start(), found.end())?,
        None,
      )
    };

    exact_spans.push((found.start(), end));
    let mut entity = PipelineEntity::detected(
      found.start(),
      end,
      row.label(),
      text,
      GAZETTEER_EXACT_SCORE,
      DetectionSource::Gazetteer,
    );
    entity.source_detail = source_detail;
    results.push(entity);
  }

  for found in matches {
    let Some(row) = data.get(found.pattern()) else {
      continue;
    };
    if !row.is_fuzzy() {
      continue;
    }
    if fuzzy_distance(found) == Some(0) {
      continue;
    }
    if exact_spans
      .iter()
      .any(|(start, end)| found.start() < *end && found.end() > *start)
    {
      continue;
    }

    results.push(PipelineEntity::detected(
      found.start(),
      found.end(),
      row.label(),
      offsets.slice(found.start(), found.end())?,
      GAZETTEER_FUZZY_SCORE,
      DetectionSource::Gazetteer,
    ));
  }

  Ok(results)
}

pub fn process_country_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &CountryMatchData,
) -> Result<Vec<PipelineEntity>> {
  let prepared = PreparedCountryMatchData::new(data.clone(), slice)?;
  process_prepared_country_matches(matches, full_text, &prepared)
}

pub(crate) fn process_prepared_country_matches(
  matches: &[SearchMatch],
  full_text: &str,
  data: &PreparedCountryMatchData,
) -> Result<Vec<PipelineEntity>> {
  let offsets = ByteOffsets::new(full_text);
  let mut results = Vec::new();

  for found in matches {
    let Some(label) = data.label(found.pattern()) else {
      continue;
    };
    if !starts_as_proper_noun(full_text, &offsets, found.start())? {
      continue;
    }

    results.push(PipelineEntity::detected(
      found.start(),
      found.end(),
      label,
      offsets.slice(found.start(), found.end())?,
      COUNTRY_SCORE,
      DetectionSource::Country,
    ));
  }

  Ok(results)
}

pub(crate) fn ensure_supported_deny_list_sources(
  data: &DenyListMatchData,
) -> Result<()> {
  let mut needs_filters = false;
  for sources in data.sources.iter() {
    validate_deny_list_sources(sources)?;
    needs_filters |= has_curated_source(sources);
  }

  if needs_filters && data.filters.is_none() {
    return Err(Error::MissingStaticData {
      field: "deny_list.filters",
    });
  }

  Ok(())
}

fn validate_deny_list_sources(sources: StringGroup<'_>) -> Result<()> {
  if sources.is_empty() {
    return Err(Error::UnsupportedDenyListSource {
      source: String::from("<missing>"),
    });
  }

  for source in sources.iter() {
    match source {
      DENY_LIST_SOURCE
      | CITY_SOURCE
      | CUSTOM_DENY_LIST_SOURCE
      | FIRST_NAME_SOURCE
      | SURNAME_SOURCE
      | TITLE_SOURCE
      | CITY_HEAD_NAME_SOURCE
      | NAME_DICTIONARY_SOURCE => {}
      _ => {
        return Err(Error::UnsupportedDenyListSource {
          source: String::from(source),
        });
      }
    }
  }

  Ok(())
}

fn has_curated_source(sources: StringGroup<'_>) -> bool {
  sources
    .iter()
    .any(|source| source != CUSTOM_DENY_LIST_SOURCE)
}

const fn has_person_name_source(found: &RawDenyListMatch) -> bool {
  found.has_person_name_source
}

fn filter_contains(set: Option<&BTreeSet<String>>, value: &str) -> bool {
  set.is_some_and(|set| set.contains(value))
}

fn char_at(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  offset: u32,
) -> Result<Option<char>> {
  let byte = offsets.validate_offset(offset)?;
  Ok(full_text.get(byte..).and_then(|tail| tail.chars().next()))
}

fn char_before_byte(full_text: &str, byte: usize) -> Option<char> {
  full_text
    .get(..byte)
    .and_then(|prefix| prefix.chars().next_back())
}

fn char_after_byte(full_text: &str, byte: usize) -> Option<char> {
  full_text
    .get(byte..)
    .and_then(|suffix| suffix.chars().next())
}

fn byte_len(text: &str) -> u32 {
  u32::try_from(text.len()).unwrap_or(u32::MAX)
}

fn all_upper(text: &str) -> bool {
  let mut saw_letter = false;
  for ch in text.chars() {
    if !ch.is_alphabetic() || !ch.is_uppercase() {
      return false;
    }
    saw_letter = true;
  }
  saw_letter
}

fn is_single_word(text: &str) -> bool {
  let mut saw_letter = false;
  for ch in text.chars() {
    if !ch.is_alphabetic() {
      return false;
    }
    saw_letter = true;
  }
  saw_letter
}

fn is_dotted_acronym(text: &str) -> bool {
  if text.chars().count() < 3 {
    return false;
  }

  let mut segments = 0_u8;
  let mut chars = text.chars().peekable();
  while let Some(ch) = chars.next() {
    if !ch.is_alphabetic() {
      return false;
    }
    segments = segments.saturating_add(1);
    if segments > 4 {
      return false;
    }
    match chars.peek().copied() {
      Some('.') => {
        let _ = chars.next();
        if chars.peek().is_none() {
          break;
        }
      }
      None => break,
      Some(_) => return false,
    }
  }

  segments > 0
}

fn is_dotted_acronym_suffix_collision(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  match_text: &str,
) -> Result<bool> {
  if !is_dotted_acronym(match_text) {
    return Ok(false);
  }

  let start_byte = offsets.validate_offset(start)?;
  let prefix = full_text
    .get(..start_byte)
    .unwrap_or_default()
    .chars()
    .rev()
    .take(2)
    .collect::<Vec<_>>();

  Ok(matches!(
    (prefix.first().copied(), prefix.get(1).copied()),
    (Some('.'), Some(ch)) if ch.is_alphabetic()
  ))
}

fn has_adjacent_address_evidence(
  full_text: &str,
  start: u32,
  end: u32,
  filters: &DenyListFilterData,
) -> Result<bool> {
  let window = adjacent_text_window(full_text, start, end)?;
  Ok(has_address_format(&window) || has_street_type(&window, filters))
}

fn adjacent_text_window(
  full_text: &str,
  start: u32,
  end: u32,
) -> Result<String> {
  let offsets = ByteOffsets::new(full_text);
  let full_len = offsets.len()?;
  let window_start = offsets.floor_offset(start.saturating_sub(40))?;
  let window_end =
    offsets.floor_offset(end.saturating_add(40).min(full_len))?;
  offsets.slice(window_start, window_end)
}

fn has_address_format(text: &str) -> bool {
  has_state_after_comma(text)
    || has_us_zip(text)
    || has_cz_sk_postal_code(text)
    || has_pl_postal_code(text)
}

fn has_state_after_comma(text: &str) -> bool {
  let chars = text.chars().collect::<Vec<_>>();
  for index in 0..chars.len() {
    if chars.get(index) != Some(&',') {
      continue;
    }
    let mut cursor = index.saturating_add(1);
    while chars.get(cursor).is_some_and(|ch| ch.is_whitespace()) {
      cursor = cursor.saturating_add(1);
    }
    let first = chars.get(cursor).copied();
    let second = chars.get(cursor.saturating_add(1)).copied();
    let after = chars.get(cursor.saturating_add(2)).copied();
    if first.is_some_and(char::is_uppercase)
      && second.is_some_and(char::is_uppercase)
      && !after.is_some_and(char::is_alphanumeric)
    {
      return true;
    }
  }
  false
}

fn has_us_zip(text: &str) -> bool {
  let chars = text.chars().collect::<Vec<_>>();
  for index in 0..chars.len() {
    if !five_digits_at(&chars, index) {
      continue;
    }
    let after_five = index.saturating_add(5);
    let has_zip4 = chars.get(after_five) == Some(&'-')
      && four_digits_at(&chars, after_five.saturating_add(1));
    let end = if has_zip4 {
      after_five.saturating_add(5)
    } else {
      after_five
    };
    if !chars
      .get(index.wrapping_sub(1))
      .is_some_and(char::is_ascii_digit)
      && !chars.get(end).is_some_and(char::is_ascii_digit)
    {
      return true;
    }
  }
  false
}

fn has_cz_sk_postal_code(text: &str) -> bool {
  let chars = text.chars().collect::<Vec<_>>();
  for index in 0..chars.len() {
    if three_digits_at(&chars, index)
      && chars.get(index.saturating_add(3)) == Some(&' ')
      && two_digits_at(&chars, index.saturating_add(4))
    {
      return true;
    }
  }
  false
}

fn has_pl_postal_code(text: &str) -> bool {
  let chars = text.chars().collect::<Vec<_>>();
  for index in 0..chars.len() {
    if two_digits_at(&chars, index)
      && chars.get(index.saturating_add(2)) == Some(&'-')
      && three_digits_at(&chars, index.saturating_add(3))
    {
      return true;
    }
  }
  false
}

fn digits_at(chars: &[char], start: usize, len: usize) -> bool {
  start.checked_add(len).is_some_and(|end| end <= chars.len())
    && chars
      .get(start..start.saturating_add(len))
      .is_some_and(|slice| slice.iter().all(char::is_ascii_digit))
}

fn two_digits_at(chars: &[char], start: usize) -> bool {
  digits_at(chars, start, 2)
}

fn three_digits_at(chars: &[char], start: usize) -> bool {
  digits_at(chars, start, 3)
}

fn four_digits_at(chars: &[char], start: usize) -> bool {
  digits_at(chars, start, 4)
}

fn five_digits_at(chars: &[char], start: usize) -> bool {
  digits_at(chars, start, 5)
}

fn has_street_type(window: &str, filters: &DenyListFilterData) -> bool {
  let lower_window = window.to_lowercase();
  for street_type in &filters.street_types {
    if street_type.is_empty() {
      continue;
    }
    let lower_type = street_type.to_lowercase();
    if street_type_matches(lower_window.as_str(), lower_type.as_str()) {
      return true;
    }
  }
  false
}

fn street_type_matches(window: &str, street_type: &str) -> bool {
  for (byte, _) in window.match_indices(street_type) {
    let before = char_before_byte(window, byte);
    if before.is_some_and(char::is_alphanumeric) {
      continue;
    }
    let end = byte.saturating_add(street_type.len());
    let Some(last) = street_type.chars().next_back() else {
      continue;
    };
    if last.is_alphanumeric()
      && char_after_byte(window, end).is_some_and(char::is_alphanumeric)
    {
      continue;
    }
    return true;
  }
  false
}

fn person_chain_breaks(previous_text: &str, gap: &str) -> bool {
  byte_len(gap) > 4
    || gap.is_empty()
    || gap.chars().any(is_line_break)
    || gap.contains('\t')
    || gap
      .chars()
      .any(|ch| matches!(ch, '!' | '?' | ';' | ':' | ','))
    || (gap.contains('.') && !is_initial_continuation_gap(previous_text, gap))
}

fn is_initial_continuation_gap(text: &str, gap: &str) -> bool {
  let mut chars = text.chars();
  let text_is_single_upper =
    chars.next().is_some_and(char::is_uppercase) && chars.next().is_none();
  if text_is_single_upper && dot_space_gap(gap) {
    return true;
  }

  let mut remaining = gap;
  let Some(after_space) = consume_horizontal_space(remaining, 1, 2) else {
    return false;
  };
  remaining = after_space;
  let mut consumed_initial = false;

  loop {
    let Some(ch) = remaining.chars().next() else {
      return consumed_initial;
    };
    if !ch.is_uppercase() {
      return false;
    }
    let Some(after_initial) = remaining.strip_prefix(ch) else {
      return false;
    };
    let Some(after_dot) = after_initial.strip_prefix('.') else {
      return false;
    };
    let Some(after_initial_gap) = consume_horizontal_space(after_dot, 1, 2)
    else {
      return false;
    };
    remaining = after_initial_gap;
    consumed_initial = true;
  }
}

fn dot_space_gap(gap: &str) -> bool {
  let Some(rest) = gap.strip_prefix('.') else {
    return false;
  };
  consume_horizontal_space(rest, 1, 2).is_some_and(str::is_empty)
}

fn consume_horizontal_space(
  text: &str,
  min: usize,
  max: usize,
) -> Option<&str> {
  let mut consumed = 0_usize;
  let mut byte = 0_usize;
  for ch in text.chars() {
    if is_line_break(ch) || !ch.is_whitespace() || consumed == max {
      break;
    }
    consumed = consumed.saturating_add(1);
    byte = byte.saturating_add(ch.len_utf8());
  }
  (consumed >= min).then(|| text.get(byte..)).flatten()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SingleNameContext {
  None,
  Capitalized,
  UppercaseShape,
  KnownUppercaseSurname { end: u32 },
}

struct SingleNameHitContextOptions<'a> {
  full_text: &'a str,
  offsets: &'a ByteOffsets<'a>,
  first_name_span: std::ops::Range<u32>,
  filters: &'a DenyListFilterData,
  surname_evidence: &'a SurnameEvidenceIndex,
}

fn single_name_hit_context(
  options: SingleNameHitContextOptions<'_>,
) -> Result<SingleNameContext> {
  let SingleNameHitContextOptions {
    full_text,
    offsets,
    first_name_span,
    filters,
    surname_evidence,
  } = options;
  let tail = slice_from(full_text, offsets, first_name_span.end)?;
  let (rest, next_start, separator) =
    skip_leading_middle_initials(tail, first_name_span.end);
  let whitespace_token = rest
    .chars()
    .take_while(|ch| !ch.is_whitespace())
    .collect::<String>();
  let surname_token = strip_trailing_name_punctuation(&whitespace_token);
  let next_word = surname_token
    .chars()
    .take_while(|ch| ch.is_alphabetic())
    .collect::<String>();
  let next_lower = next_word.to_lowercase();
  let next_end = next_start.saturating_add(byte_len(&next_word));
  let mut chars = next_word.chars();
  let Some(first) = chars.next() else {
    return Ok(SingleNameContext::None);
  };
  let Some(second) = chars.next() else {
    return Ok(SingleNameContext::None);
  };
  let remaining_is_upper = chars.all(char::is_uppercase);
  if !first.is_uppercase() || filters.sentence_starters.contains(&next_lower) {
    return Ok(SingleNameContext::None);
  }
  if second.is_lowercase() {
    return Ok(SingleNameContext::Capitalized);
  }
  if second.is_uppercase()
    && remaining_is_upper
    && surname_context_separator_is_supported(separator)
    && surname_evidence.covers(next_start, next_end)
  {
    return Ok(SingleNameContext::KnownUppercaseSurname { end: next_end });
  }
  if separator == " " && is_uppercase_czech_feminine_surname(&next_word) {
    return Ok(SingleNameContext::UppercaseShape);
  }
  // Title-led first names (Ing./Dr./Mgr. …) often write the surname in
  // all caps without dictionary evidence. Unlock only that shape; bare
  // `Firstname ACRONYM` stays suppressed.
  if remaining_is_upper
    && separator == " "
    && !filters.stopwords.contains(&next_lower)
    && !filters.person_stopwords.contains(&next_lower)
    && !filters.allow_list.contains(&next_lower)
    && is_title_led_uppercase_surname_candidate(surname_token)
    && name_preceded_by_title_token(offsets, first_name_span.start, filters)?
  {
    return Ok(SingleNameContext::UppercaseShape);
  }
  Ok(SingleNameContext::None)
}

fn is_title_led_uppercase_surname_candidate(token: &str) -> bool {
  let mut parts = token.split('-');
  let Some(head) = parts.next() else {
    return false;
  };
  let letter_count = head.chars().count();
  if letter_count < 3 {
    return false;
  }
  if !all_upper(head) || parts.any(|part| !all_upper(part)) {
    return false;
  }
  // Reject short all-ASCII tokens (VAT, NATO); keep diacritic surnames and
  // longer uppercase tokens, including validated hyphenated forms.
  !head.is_ascii() || letter_count >= 5
}

fn name_preceded_by_title_token(
  offsets: &ByteOffsets<'_>,
  name_start: u32,
  filters: &DenyListFilterData,
) -> Result<bool> {
  if name_start == 0 {
    return Ok(false);
  }
  let head = offsets.slice_ref(0, name_start)?;
  let trimmed = head.trim_end();
  let separator = head.get(trimmed.len()..).unwrap_or_default();
  if !take_person_name_extension_separator(separator)
    .is_some_and(|(_, after)| after.is_empty())
  {
    return Ok(false);
  }
  let Some(token) = trimmed.split_whitespace().next_back() else {
    return Ok(false);
  };
  let bare = token.trim_end_matches('.');
  if bare.is_empty() {
    return Ok(false);
  }
  Ok(filters.title_tokens.contains(&bare.to_lowercase()))
}

/// Skip `A.` / `R.` middle initials so the following surname can arm
/// single-token person extension (`Paul A. Pinkston`).
fn skip_leading_middle_initials(tail: &str, end: u32) -> (&str, u32, &str) {
  let mut rest = tail;
  let mut next_start = end;
  let mut separator = "";
  let mut skipped_initial = false;

  loop {
    let trimmed = rest.trim_start();
    let whitespace_bytes = rest.len().saturating_sub(trimmed.len());
    let whitespace = rest.get(..whitespace_bytes).unwrap_or_default();
    next_start = next_start.saturating_add(byte_len(whitespace));
    if !skipped_initial {
      separator = whitespace;
    }
    rest = trimmed;

    let token = rest
      .chars()
      .take_while(|ch| !ch.is_whitespace())
      .collect::<String>();
    if !is_middle_initial_token(&token) {
      if skipped_initial {
        separator = " ";
      }
      return (rest, next_start, separator);
    }

    let token_bytes = byte_len(&token);
    let Some(after) = rest.get(usize::try_from(token_bytes).unwrap_or(0)..)
    else {
      return (rest, next_start, separator);
    };
    next_start = next_start.saturating_add(token_bytes);
    rest = after;
    skipped_initial = true;
  }
}

fn surname_context_separator_is_supported(separator: &str) -> bool {
  let mut count = 0_usize;
  let mut line_breaks = 0_usize;
  for ch in separator.chars() {
    if !ch.is_whitespace() {
      return false;
    }
    count = count.saturating_add(1);
    if ch == '\n' {
      line_breaks = line_breaks.saturating_add(1);
    }
  }
  (1..=4).contains(&count) && line_breaks <= 1
}

/// Reference model for [`SurnameEvidenceIndex`]: the straightforward scan the
/// index replaces. Kept as the equivalence oracle for the index tests.
#[cfg(test)]
fn deny_list_has_surname(
  evidence_hits: &[RawDenyListMatch],
  start: u32,
  end: u32,
) -> bool {
  evidence_hits.iter().any(|found| {
    found.has_surname_evidence && found.start == start && found.end == end
  })
}

fn is_uppercase_czech_feminine_surname(word: &str) -> bool {
  all_upper(word)
    && word.to_lowercase().ends_with(CZECH_FEMININE_SURNAME_SUFFIX)
}

fn slice_from<'a>(
  full_text: &'a str,
  offsets: &ByteOffsets<'_>,
  start: u32,
) -> Result<&'a str> {
  let byte = offsets.validate_offset(start)?;
  full_text
    .get(byte..)
    .ok_or(Error::ByteOffsetOutOfBounds { offset: start })
}

struct ExtendedName {
  end: u32,
  text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PersonSoftWrapContext {
  None,
  Signature,
  FieldLabel,
}

fn extend_person_name(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
  filters: &DenyListFilterData,
  person_field_labels: &[String],
  document: &ResolutionDocument<'_>,
) -> Result<ExtendedName> {
  let mut new_end = end;
  let mut soft_wrap_context =
    person_soft_wrap_context(document, offsets, start, person_field_labels)?;
  // EDGAR HTML often soft-wraps the surname onto the next line after a
  // given name (`/s/ Alan\nKhalili`). Only signature markers and compact
  // field-label layouts may cross one line break.
  loop {
    let tail = slice_from(full_text, offsets, new_end)?;
    let Some((separator, after_separator)) =
      take_person_name_extension_separator(tail)
    else {
      break;
    };
    let wraps = separator.chars().any(is_line_break);
    if !wraps && separator != " " {
      break;
    }
    if wraps {
      if soft_wrapped_us_city_tail(tail, &filters.us_state_abbreviations)
        .is_some()
      {
        break;
      }
      if soft_wrap_context == PersonSoftWrapContext::None {
        break;
      }
      soft_wrap_context = PersonSoftWrapContext::None;
    }
    let word_start = new_end.saturating_add(byte_len(separator));
    let Some(first) = after_separator.chars().next() else {
      break;
    };
    if !first.is_uppercase() {
      break;
    }

    let word = read_until_whitespace(full_text, offsets, word_start)?;
    let stripped = strip_trailing_name_punctuation(&word);
    // Dotted middle initials ("A.", "R.") are part of the name; keep
    // scanning so the surname after them is absorbed.
    if is_middle_initial_token(&word) {
      new_end = word_start.saturating_add(byte_len(&word));
      continue;
    }
    if stripped.chars().count() < 2 {
      break;
    }
    let lower = stripped.to_lowercase();
    if filters.stopwords.contains(&lower)
      || filters.person_stopwords.contains(&lower)
      || (wraps && filters.sentence_starters.contains(&lower))
      || (wraps && word.ends_with(':'))
    {
      break;
    }

    new_end = word_start.saturating_add(byte_len(stripped));
  }

  Ok(ExtendedName {
    end: new_end,
    text: offsets.slice(start, new_end)?,
  })
}

fn person_soft_wrap_context(
  document: &ResolutionDocument<'_>,
  offsets: &ByteOffsets<'_>,
  start: u32,
  person_field_labels: &[String],
) -> Result<PersonSoftWrapContext> {
  let start_byte = offsets.validate_offset(start)?;
  let Some((current_line, previous_line)) =
    document.line_prefix_and_previous(start_byte)
  else {
    return Err(Error::ByteOffsetOutOfBounds { offset: start });
  };
  if current_line.trim() == "/s/" {
    return Ok(PersonSoftWrapContext::Signature);
  }
  let label = previous_line.unwrap_or_default().trim();
  let normalized_label = label
    .strip_suffix(':')
    .map(str::trim)
    .unwrap_or_default()
    .to_lowercase();
  if person_field_labels
    .iter()
    .any(|candidate| candidate == &normalized_label)
  {
    return Ok(PersonSoftWrapContext::FieldLabel);
  }
  Ok(PersonSoftWrapContext::None)
}

/// Separator before an extended person-name token: one to four whitespace
/// characters with at most one newline (EDGAR soft wrap).
fn take_person_name_extension_separator(tail: &str) -> Option<(&str, &str)> {
  let mut count = 0_usize;
  let mut line_breaks = 0_usize;
  let mut byte = 0_usize;
  let mut previous_was_carriage_return = false;
  for ch in tail.chars() {
    if !is_supported_name_separator(ch) {
      break;
    }
    if ch == '\u{2029}' {
      return None;
    }
    count = count.saturating_add(1);
    match ch {
      '\r' => {
        line_breaks = line_breaks.saturating_add(1);
        previous_was_carriage_return = true;
      }
      '\n' if previous_was_carriage_return => {
        previous_was_carriage_return = false;
      }
      '\n' | '\u{2028}' => {
        line_breaks = line_breaks.saturating_add(1);
        previous_was_carriage_return = false;
      }
      _ => {
        previous_was_carriage_return = false;
      }
    }
    byte = byte.saturating_add(ch.len_utf8());
    if count == 4 {
      break;
    }
  }
  if !(1..=4).contains(&count) || line_breaks > 1 {
    return None;
  }
  Some((tail.get(..byte)?, tail.get(byte..)?))
}

const fn is_line_break(ch: char) -> bool {
  matches!(ch, '\r' | '\n' | '\u{2028}' | '\u{2029}')
}

fn is_supported_name_separator(ch: char) -> bool {
  is_line_break(ch) || ch == '\t' || (ch.is_whitespace() && !ch.is_control())
}

fn is_middle_initial_token(word: &str) -> bool {
  let mut chars = word.chars();
  chars.next().is_some_and(char::is_uppercase)
    && chars.next() == Some('.')
    && chars
      .all(|ch| matches!(ch, ',' | ';' | '”' | '"' | '’' | '\'' | '“' | '»'))
}

fn read_until_whitespace(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
) -> Result<String> {
  let tail = slice_from(full_text, offsets, start)?;
  Ok(tail.chars().take_while(|ch| !ch.is_whitespace()).collect())
}

fn strip_trailing_name_punctuation(word: &str) -> &str {
  word.trim_end_matches([',', ';', '.', '”', '"', '’', '\'', '“', '»'])
}

struct DefinedTermQuote {
  content: String,
  after_closing_quote: String,
}

fn is_suppressible_defined_term_quote(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  filters: &DenyListFilterData,
) -> Result<bool> {
  let Some(quote) =
    find_defined_term_quote_content(full_text, offsets, start, filters)?
  else {
    return Ok(false);
  };
  let words = quote
    .content
    .split(|ch: char| !ch.is_alphabetic())
    .filter(|word| !word.is_empty())
    .collect::<Vec<_>>();

  if words.len() >= 2
    && starts_with_known_first_name(&quote.content, filters)
    && has_person_role_definition(&quote.after_closing_quote, filters)
  {
    return Ok(false);
  }

  Ok(words.len() >= 2)
}

fn find_defined_term_quote_content(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  filters: &DenyListFilterData,
) -> Result<Option<DefinedTermQuote>> {
  let start_byte = offsets.validate_offset(start)?;
  let Some(quote_start) = find_opening_quote(full_text, start_byte) else {
    return Ok(None);
  };
  let Some((quote_end, quote_char)) =
    find_closing_quote(full_text, quote_start, start_byte)
  else {
    return Ok(None);
  };
  let after_start = quote_end.saturating_add(quote_char.len_utf8());
  let after = full_text.get(after_start..).unwrap_or_default();
  let after_window = take_bytes(after, 120);
  if strip_defined_term_cue(&after_window, filters).is_none() {
    return Ok(None);
  }

  let quote_width = full_text
    .get(quote_start..)
    .and_then(|tail| tail.chars().next())
    .map_or(0, char::len_utf8);
  let content_start = quote_start.saturating_add(quote_width);

  Ok(Some(DefinedTermQuote {
    content: full_text
      .get(content_start..quote_end)
      .unwrap_or_default()
      .to_owned(),
    after_closing_quote: after_window,
  }))
}

fn find_opening_quote(full_text: &str, start_byte: usize) -> Option<usize> {
  let prefix = full_text.get(..start_byte)?;
  let mut distance = 0_u32;
  for (byte, ch) in prefix.char_indices().rev() {
    distance = distance.saturating_add(byte_len(ch.encode_utf8(&mut [0; 4])));
    if distance > 80 || ch == '\n' {
      break;
    }
    if opening_quotes().contains(&ch) && is_quote_boundary(full_text, byte, ch)
    {
      return Some(byte);
    }
    if closing_quotes().contains(&ch) && is_quote_boundary(full_text, byte, ch)
    {
      break;
    }
  }
  None
}

fn find_closing_quote(
  full_text: &str,
  quote_start: usize,
  start_byte: usize,
) -> Option<(usize, char)> {
  let tail = full_text.get(start_byte..)?;
  let mut distance = byte_len(full_text.get(quote_start..start_byte)?);
  for (relative, ch) in tail.char_indices() {
    if distance > 120 {
      break;
    }
    let byte = start_byte.saturating_add(relative);
    if closing_quotes().contains(&ch) && is_quote_boundary(full_text, byte, ch)
    {
      return Some((byte, ch));
    }
    distance = distance.saturating_add(byte_len(ch.encode_utf8(&mut [0; 4])));
  }
  None
}

fn is_quote_boundary(full_text: &str, byte: usize, ch: char) -> bool {
  if ch != '\'' && ch != '’' {
    return true;
  }
  let after_byte = byte.saturating_add(ch.len_utf8());
  let before = char_before_byte(full_text, byte);
  let after = char_after_byte(full_text, after_byte);
  !(before.is_some_and(char::is_alphabetic)
    && after.is_some_and(char::is_alphabetic))
}

fn opening_quotes() -> &'static BTreeSet<char> {
  static QUOTES: std::sync::LazyLock<BTreeSet<char>> =
    std::sync::LazyLock::new(|| {
      BTreeSet::from(['"', '\'', '“', '„', '‟', '‘', '‛', '«'])
    });
  &QUOTES
}

fn closing_quotes() -> &'static BTreeSet<char> {
  static QUOTES: std::sync::LazyLock<BTreeSet<char>> =
    std::sync::LazyLock::new(|| {
      BTreeSet::from(['"', '\'', '”', '’', '»', '“'])
    });
  &QUOTES
}

fn take_bytes(text: &str, max: u32) -> String {
  let mut taken = String::new();
  let mut len = 0_u32;
  for ch in text.chars() {
    let width = byte_len(ch.encode_utf8(&mut [0; 4]));
    if len.saturating_add(width) > max {
      break;
    }
    taken.push(ch);
    len = len.saturating_add(width);
  }
  taken
}

fn strip_defined_term_cue<'a>(
  after: &'a str,
  filters: &DenyListFilterData,
) -> Option<&'a str> {
  let trimmed =
    after.trim_start_matches(|ch: char| ch.is_whitespace() || ch == ',');
  let lower = trimmed.to_lowercase();
  for cue in &filters.defined_term_cues {
    if lower.starts_with(cue) && word_boundary_after(lower.as_str(), cue.len())
    {
      // `cue.len()` is a byte offset in the LOWERED text; lowercasing can
      // change byte lengths (e.g. Turkish dotted capital), so translate to
      // the matching boundary in the original `trimmed` before slicing.
      return trimmed.get(original_offset_for_lower_len(trimmed, cue.len())?..);
    }
  }
  None
}

/// Maps a byte length in `text.to_lowercase()` space back to the byte offset
/// in `text` whose chars produced exactly that many lowered bytes. Returns
/// `None` when the lowered length does not land on a char boundary.
fn original_offset_for_lower_len(
  text: &str,
  lower_len: usize,
) -> Option<usize> {
  let mut lowered = 0usize;
  for (offset, ch) in text.char_indices() {
    if lowered == lower_len {
      return Some(offset);
    }
    if lowered > lower_len {
      return None;
    }
    lowered = lowered
      .saturating_add(ch.to_lowercase().map(char::len_utf8).sum::<usize>());
  }
  (lowered == lower_len).then_some(text.len())
}

fn word_boundary_after(text: &str, byte: usize) -> bool {
  text
    .get(byte..)
    .and_then(|tail| tail.chars().next())
    .is_none_or(|ch| !ch.is_alphabetic())
}

fn starts_with_known_first_name(
  quote_content: &str,
  filters: &DenyListFilterData,
) -> bool {
  let trimmed = quote_content.trim();
  let first_word = trimmed
    .chars()
    .take_while(|ch| ch.is_alphabetic())
    .collect::<String>();
  if first_word.is_empty() {
    return false;
  }
  if filters.title_tokens.contains(&first_word.to_lowercase()) {
    // A leading title ("Dr. John Smith") is not itself the person's first
    // name; strip it (and the separator that follows, e.g. ". ") and check
    // the next word instead.
    let rest = trimmed
      .trim_start_matches(|ch: char| ch.is_alphabetic())
      .trim_start_matches(|ch: char| !ch.is_alphabetic());
    let next_word = rest
      .chars()
      .take_while(|ch| ch.is_alphabetic())
      .collect::<String>();
    return !next_word.is_empty()
      && filters.first_names.contains(&next_word.to_lowercase());
  }
  filters.first_names.contains(&first_word.to_lowercase())
}

fn has_person_role_definition(
  after_closing_quote: &str,
  filters: &DenyListFilterData,
) -> bool {
  let Some(after_cue) = strip_defined_term_cue(after_closing_quote, filters)
  else {
    return false;
  };
  after_cue
    .split(|ch: char| !ch.is_alphabetic())
    .filter(|word| !word.is_empty())
    .take(8)
    .any(|word| filters.generic_roles.contains(&word.to_lowercase()))
}

fn extend_city_districts(
  entities: &mut [PipelineEntity],
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  filters: Option<&DenyListFilterData>,
) -> Result<()> {
  const PERSONAL_NAME_PREFIX_WINDOW: u32 = 64;

  for entity in entities {
    if entity.label != ADDRESS_LABEL
      || entity.source_detail == Some(SourceDetail::CustomDenyList)
    {
      continue;
    }

    let after = slice_from(full_text, offsets, entity.end)?;
    let mut district_suffix = match_district_suffix(after, false);
    if district_suffix.is_none()
      && let Some(roman_suffix) = match_district_suffix(after, true)
    {
      // City lists overlap surnames (e.g. US city "Ferguson"). Do not treat
      // generational Roman numerals after a personal-name prefix as districts.
      let prefix_start = offsets.floor_offset(
        entity.start.saturating_sub(PERSONAL_NAME_PREFIX_WINDOW),
      )?;
      let name_prefix_before = offsets.slice(prefix_start, entity.start)?;
      let allow_roman_district = filters.is_none_or(|filters| {
        !has_personal_name_prefix(&name_prefix_before, filters)
      });
      if allow_roman_district {
        district_suffix = Some(roman_suffix);
      }
    }
    if let Some(suffix) = district_suffix {
      entity.end = entity.end.saturating_add(byte_len(suffix));
      entity.text = offsets.slice(entity.start, entity.end)?;
    }

    if let Some(suffix) =
      match_dash_district(slice_from(full_text, offsets, entity.end)?)
    {
      entity.end = entity.end.saturating_add(byte_len(suffix));
      entity.text = offsets.slice(entity.start, entity.end)?;
    }

    let postal_before = offsets.slice(
      offsets.floor_offset(entity.start.saturating_sub(10))?,
      entity.start,
    )?;
    if let Some(prefix) = postal_prefix(&postal_before) {
      entity.start = entity.start.saturating_sub(byte_len(prefix));
      entity.text = offsets.slice(entity.start, entity.end)?;
    }

    if let Some(filters) = filters
      && let Some(suffix) = match_trailing_address_word(
        slice_from(full_text, offsets, entity.end)?,
        filters,
      )
    {
      entity.end = entity.end.saturating_add(byte_len(suffix));
      entity.text = offsets.slice(entity.start, entity.end)?;
    }
  }

  Ok(())
}

fn match_district_suffix(after: &str, allow_roman: bool) -> Option<&str> {
  let rest = after.strip_prefix(' ')?;
  let suffix = numeric_district(rest).or_else(|| {
    if allow_roman {
      roman_district(rest)
    } else {
      None
    }
  })?;
  let end = ' '.len_utf8().saturating_add(suffix.len());
  let next = after.get(end..).and_then(|tail| tail.chars().next());
  next
    .is_none_or(is_district_boundary)
    .then(|| after.get(..end))
    .flatten()
}

fn numeric_district(text: &str) -> Option<&str> {
  let digits = text
    .chars()
    .take_while(char::is_ascii_digit)
    .collect::<String>();
  if digits.is_empty() || digits.len() > 2 {
    return None;
  }
  text.get(..digits.len())
}

fn roman_district(text: &str) -> Option<&str> {
  roman_districts()
    .iter()
    .find_map(|roman| text.starts_with(roman).then_some(*roman))
}

/// True when `before` ends with a given name and optional middle initials,
/// so a following city-list hit is likely a surname rather than a bare city.
fn has_personal_name_prefix(
  before: &str,
  filters: &DenyListFilterData,
) -> bool {
  let mut rest = before.trim_end_matches(|ch: char| ch.is_whitespace());
  while let Some(dot_index) = rest
    .char_indices()
    .next_back()
    .and_then(|(i, ch)| (ch == '.').then_some(i))
  {
    if dot_index.saturating_add('.'.len_utf8()) != rest.len() {
      break;
    }
    let before_dot = rest.get(..dot_index).unwrap_or_default();
    let Some((initial_index, initial)) = before_dot.char_indices().next_back()
    else {
      break;
    };
    if !initial.is_uppercase()
      || before_dot
        .get(initial_index..)
        .is_none_or(|tail| tail.chars().count() != 1)
    {
      break;
    }
    let prefix = before_dot
      .get(..initial_index)
      .unwrap_or_default()
      .trim_end();
    if prefix.is_empty() {
      break;
    }
    rest = prefix;
  }

  let Some(last_word) = rest.split_whitespace().next_back() else {
    return false;
  };
  filters.first_names.contains(&last_word.to_lowercase())
}

const fn roman_districts() -> &'static [&'static str] {
  &[
    "XXX", "XXIX", "XXVIII", "XXVII", "XXVI", "XXV", "XXIV", "XXIII", "XXII",
    "XXI", "XX", "XIX", "XVIII", "XVII", "XVI", "XV", "XIV", "XIII", "XII",
    "XI", "X", "IX", "VIII", "VII", "VI", "IV", "III", "II",
  ]
}

const fn is_district_boundary(ch: char) -> bool {
  ch.is_whitespace() || matches!(ch, ',' | ';' | '.' | ')' | '"')
}

fn match_dash_district(after: &str) -> Option<&str> {
  let (space_len, after_space) = consume_spaces_or_tabs(after, 1, 4)?;
  let dash = after_space.chars().next()?;
  if dash != '-' && dash != '–' {
    return None;
  }
  let after_dash = after_space.get(dash.len_utf8()..)?;
  let (post_dash_spaces, word_start) =
    consume_spaces_or_tabs(after_dash, 0, usize::MAX)
      .unwrap_or((0, after_dash));
  let mut chars = word_start.chars();
  let first = chars.next()?;
  let second = chars.next()?;
  if !first.is_uppercase() || !second.is_lowercase() {
    return None;
  }
  let word_len = first
    .len_utf8()
    .saturating_add(second.len_utf8())
    .saturating_add(
      chars
        .take_while(|ch| ch.is_lowercase())
        .map(char::len_utf8)
        .sum::<usize>(),
    );
  let total = space_len
    .saturating_add(dash.len_utf8())
    .saturating_add(post_dash_spaces)
    .saturating_add(word_len);
  after.get(..total)
}

fn consume_spaces_or_tabs(
  text: &str,
  min: usize,
  max: usize,
) -> Option<(usize, &str)> {
  let mut consumed = 0_usize;
  let mut byte = 0_usize;
  for ch in text.chars() {
    if (ch != ' ' && ch != '\t') || consumed == max {
      break;
    }
    consumed = consumed.saturating_add(1);
    byte = byte.saturating_add(ch.len_utf8());
  }
  (consumed >= min)
    .then(|| text.get(byte..).map(|rest| (byte, rest)))
    .flatten()
}

fn postal_prefix(before: &str) -> Option<&str> {
  let trimmed_end = before.trim_end();
  let suffix_ws = before.len().saturating_sub(trimmed_end.len());
  let before_dash =
    trimmed_end.trim_end_matches(|ch: char| ch.is_whitespace() || is_dash(ch));
  let dash_ws = trimmed_end.len().saturating_sub(before_dash.len());

  if let Some(code) = trailing_postal_code(before_dash) {
    let start = before_dash.len().saturating_sub(code.len());
    let end = before
      .len()
      .saturating_sub(suffix_ws)
      .saturating_add(dash_ws);
    return before.get(start..end);
  }
  None
}

fn trailing_postal_code(text: &str) -> Option<&str> {
  let chars = text.chars().collect::<Vec<_>>();
  if chars.len() >= 5 {
    let start = chars.len().saturating_sub(5);
    if five_digits_at(&chars, start) {
      return text.get(byte_index_for_char(text, start)..);
    }
  }
  if chars.len() >= 6 {
    let start = chars.len().saturating_sub(6);
    if three_digits_at(&chars, start)
      && chars.get(start.saturating_add(3)) == Some(&' ')
      && two_digits_at(&chars, start.saturating_add(4))
    {
      return text.get(byte_index_for_char(text, start)..);
    }
  }
  None
}

fn byte_index_for_char(text: &str, char_index: usize) -> usize {
  text
    .char_indices()
    .nth(char_index)
    .map_or(text.len(), |(byte, _)| byte)
}

const fn is_dash(ch: char) -> bool {
  matches!(ch, '-' | '‑' | '–' | '—')
}

fn match_trailing_address_word<'a>(
  after: &'a str,
  filters: &DenyListFilterData,
) -> Option<&'a str> {
  let (space_len, word_start) = consume_whitespace_no_newline(after, 1, 4)?;
  let mut chars = word_start.chars();
  let first = chars.next()?;
  let second = chars.next()?;
  if !first.is_uppercase() || !second.is_lowercase() {
    return None;
  }
  let rest_len = chars
    .take_while(|ch| ch.is_lowercase())
    .map(char::len_utf8)
    .sum::<usize>();
  let word_len = first
    .len_utf8()
    .saturating_add(second.len_utf8())
    .saturating_add(rest_len);
  let word = word_start.get(..word_len)?;
  if filters
    .trailing_address_word_exclusions
    .contains(&word.to_lowercase())
  {
    return None;
  }
  after.get(..space_len.saturating_add(word_len))
}

fn consume_whitespace_no_newline(
  text: &str,
  min: usize,
  max: usize,
) -> Option<(usize, &str)> {
  let mut consumed = 0_usize;
  let mut byte = 0_usize;
  for ch in text.chars() {
    if is_line_break(ch) || !ch.is_whitespace() || consumed == max {
      break;
    }
    consumed = consumed.saturating_add(1);
    byte = byte.saturating_add(ch.len_utf8());
  }
  (consumed >= min)
    .then(|| text.get(byte..).map(|rest| (byte, rest)))
    .flatten()
}

fn try_gazetteer_prefix_extension(
  offsets: &ByteOffsets<'_>,
  found: &SearchMatch,
) -> Result<Option<(u32, String, Option<SourceDetail>)>> {
  let max_end = offsets
    .offset_after_utf16_units(found.end(), MAX_GAZETTEER_PREFIX_OVERSHOOT)?;
  if max_end <= found.end().saturating_add(1) {
    return Ok(None);
  }

  let after = offsets.slice(found.end(), max_end)?;
  if !after.starts_with(' ') {
    return Ok(None);
  }

  let suffix_end = next_space_offset_after_initial(&after);
  if suffix_end <= 1 {
    return Ok(None);
  }

  let new_end = found.end().saturating_add(suffix_end);
  Ok(Some((
    new_end,
    offsets.slice(found.start(), new_end)?,
    Some(SourceDetail::GazetteerExtension),
  )))
}

fn next_space_offset_after_initial(text: &str) -> u32 {
  let mut offset = 0_u32;

  for ch in text.chars() {
    let width = u32::try_from(ch.len_utf8()).unwrap_or(u32::MAX);
    if offset > 0 && ch == ' ' {
      return offset;
    }
    offset = offset.saturating_add(width);
  }

  offset
}

fn starts_as_proper_noun(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
) -> Result<bool> {
  let start_byte = offsets.validate_offset(start)?;
  let Some(ch) = full_text
    .get(start_byte..)
    .and_then(|tail| tail.chars().next())
  else {
    return Ok(false);
  };

  let upper = ch.to_uppercase().to_string();
  let lower = ch.to_lowercase().to_string();
  if upper == lower {
    return Ok(true);
  }

  Ok(ch.to_string() == upper)
}

fn custom_match_has_valid_edges(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
  pattern_has_alphanumeric: bool,
) -> Result<bool> {
  if !pattern_has_alphanumeric {
    return Ok(true);
  }

  let start_byte = offsets.validate_offset(start)?;
  let end_byte = offsets.validate_offset(end)?;
  let previous = full_text
    .get(..start_byte)
    .and_then(|prefix| prefix.chars().next_back());
  if previous.is_some_and(char::is_alphanumeric) {
    return Ok(false);
  }

  let next = full_text
    .get(end_byte..)
    .and_then(|suffix| suffix.chars().next());
  if next.is_some_and(char::is_alphanumeric) {
    return Ok(false);
  }

  Ok(true)
}

fn has_hyphen_compound_edge(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
) -> Result<bool> {
  let start_byte = offsets.validate_offset(start)?;
  let end_byte = offsets.validate_offset(end)?;
  let previous = full_text
    .get(..start_byte)
    .and_then(|prefix| prefix.chars().next_back());
  if previous.is_some_and(is_dash) {
    return Ok(true);
  }
  let next = full_text
    .get(end_byte..)
    .and_then(|suffix| suffix.chars().next());
  Ok(next.is_some_and(is_dash))
}

fn has_supported_hyphenated_person_edge(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
  keyword: &str,
  filters: &DenyListFilterData,
) -> Result<bool> {
  if !filters.first_names.contains(keyword) {
    return Ok(false);
  }

  let start_byte = offsets.validate_offset(start)?;
  let end_byte = offsets.validate_offset(end)?;
  let previous_dash = full_text
    .get(..start_byte)
    .and_then(|prefix| prefix.chars().next_back())
    .filter(|ch| is_dash(*ch));
  if let Some(dash) = previous_dash {
    let partner = start_byte
      .checked_sub(dash.len_utf8())
      .and_then(|hyphen_byte| full_text.get(..hyphen_byte))
      .map(|prefix| {
        prefix
          .chars()
          .rev()
          .take_while(|ch| ch.is_alphabetic())
          .collect::<String>()
          .chars()
          .rev()
          .collect::<String>()
          .to_lowercase()
      });
    if partner.is_some_and(|word| filters.first_names.contains(&word)) {
      return Ok(true);
    }
  }

  let next_dash = full_text
    .get(end_byte..)
    .and_then(|suffix| suffix.chars().next())
    .filter(|ch| is_dash(*ch));
  if let Some(dash) = next_dash {
    let partner = end_byte
      .checked_add(dash.len_utf8())
      .and_then(|partner_byte| full_text.get(partner_byte..))
      .map(|suffix| {
        suffix
          .chars()
          .take_while(|ch| ch.is_alphabetic())
          .collect::<String>()
          .to_lowercase()
      });
    if partner.is_some_and(|word| filters.first_names.contains(&word)) {
      return Ok(true);
    }
  }

  Ok(false)
}

const fn fuzzy_distance(found: &SearchMatch) -> Option<u32> {
  let SearchMatch::Fuzzy { distance, .. } = found else {
    return None;
  };
  Some(*distance)
}

#[cfg(test)]
mod tests {
  #![allow(clippy::indexing_slicing, clippy::unwrap_used)]

  use web_time::Instant;

  use super::*;

  #[test]
  fn string_groups_compact_repeated_groups() {
    let groups = StringGroups::from_groups(vec![
      vec![String::from("person")],
      vec![String::from("person")],
      vec![String::from("address"), String::from("location")],
      vec![String::from("person")],
    ]);

    assert!(groups.groups.is_empty());
    assert_eq!(groups.group_table.len(), 2);
    assert_eq!(groups.group_refs, vec![0, 0, 1, 0]);
    assert_eq!(
      groups.get(2).unwrap().to_strings(),
      vec![String::from("address"), String::from("location")]
    );
    assert_eq!(
      groups
        .iter()
        .map(StringGroup::to_strings)
        .collect::<Vec<_>>(),
      vec![
        vec![String::from("person")],
        vec![String::from("person")],
        vec![String::from("address"), String::from("location")],
        vec![String::from("person")],
      ]
    );
    assert!(groups.validate("test").is_ok());
  }

  #[test]
  fn string_groups_reject_invalid_compact_reference() {
    let groups = StringGroups {
      table: vec![String::from("person")],
      groups: Vec::new(),
      group_table: vec![StringGroupIndexes::from_vec(vec![0])],
      group_refs: vec![1],
      empty_len: 0,
    };

    assert!(matches!(
      groups.validate("test"),
      Err(Error::InvalidStaticData { field: "test", .. })
    ));
  }

  #[test]
  fn string_groups_empty_groups_store_only_length() {
    let groups = StringGroups::empty_groups(4);

    assert_eq!(groups.len(), 4);
    assert!(groups.table.is_empty());
    assert!(groups.groups.is_empty());
    assert!(groups.group_table.is_empty());
    assert!(groups.group_refs.is_empty());
    assert_eq!(groups.get(0).unwrap().to_strings(), Vec::<String>::new());
    assert_eq!(groups.get(3).unwrap().to_strings(), Vec::<String>::new());
    assert!(groups.get(4).is_none());
    assert!(groups.validate("test").is_ok());
  }

  #[test]
  fn deny_list_emits_name_dictionary_sourced_person_match() {
    // A Names-category injected dictionary (e.g. the bundled `names/global`
    // fallback list) is tagged `name-dictionary` at assemble time
    // (assemble/deny_list.rs `apply_dictionary_entries`). A match sourced
    // only from that dictionary must still be treated as a person name and
    // emitted, not silently dropped for lacking a `first-name`/`surname`
    // source. The trailing capitalized word supplies the single-hit context
    // `append_person_name_hits` requires and is absorbed by
    // `extend_person_name`.
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 7,
    }];
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Aabidah")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("name-dictionary")]].into(),
      filters: Some(DenyListFilterData::default()),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      "Aabidah Rahman signed the form.",
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "person");
    assert_eq!(entities[0].text, "Aabidah Rahman");
  }

  #[test]
  fn deny_list_keeps_allow_list_name_at_soft_wrapped_city_head() {
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 4,
    }];
    let mut allow_list = BTreeSet::new();
    allow_list.insert(String::from("fair"));
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Fair")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("name-dictionary")]].into(),
      filters: Some(DenyListFilterData {
        allow_list,
        us_state_abbreviations: std::iter::once(String::from("CA")).collect(),
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      "Fair\nOaks, CA 95628",
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "person");
    assert_eq!(entities[0].text, "Fair");
  }

  #[test]
  fn deny_list_extends_person_across_edgar_soft_wrap() {
    // Sidus Space employment agreement (2026-07-24): `/s/ Alan\nKhalili`
    // left the surname residual when extension stopped at the line break.
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 4,
      end: 8,
    }];
    let mut filters = DenyListFilterData::default();
    filters.first_names.insert(String::from("alan"));
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Alan")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("first-name")]].into(),
      filters: Some(filters),
    };

    for (text, expected) in [
      ("/s/ Alan\nKhalili\n", "Alan\nKhalili"),
      ("/s/ Alan\rKhalili\rZephyr", "Alan\rKhalili"),
      (
        "/s/ Alan\u{2028}Khalili\u{2028}Zephyr",
        "Alan\u{2028}Khalili",
      ),
      ("/s/ Alan\u{2029}Khalili", "Alan"),
      ("/s/ Alan\u{000b}Khalili", "Alan"),
      ("/s/ Alan\u{000c}Khalili", "Alan"),
      ("/s/ Alan\tKhalili", "Alan"),
      ("/s/ Alan Joseph\nKhalili", "Alan Joseph\nKhalili"),
    ] {
      let entities = process_deny_list_matches(
        &matches,
        PatternSlice { start: 0, end: 1 },
        text,
        &data,
      )
      .unwrap();

      assert_eq!(entities.len(), 1);
      assert_eq!(entities[0].label, "person");
      assert_eq!(entities[0].text, expected);
    }

    let text = "Name:\nAlan Qwxyz\nZyxwv";
    let document = ResolutionDocument::new(text);
    let field_entities = process_deny_list_matches_with_field_labels(
      &[SearchMatch::Literal {
        pattern: 0,
        start: 6,
        end: 10,
      }],
      PatternSlice { start: 0, end: 1 },
      &document,
      &data,
      &[String::from("name")],
    )
    .unwrap();
    assert_eq!(field_entities.len(), 1);
    assert_eq!(field_entities[0].text, "Alan Qwxyz\nZyxwv");
  }

  #[test]
  fn person_soft_wrap_field_label_must_be_adjacent() {
    let field_labels = [String::from("name")];
    for (text, expected) in [
      ("Name:\nAlice", PersonSoftWrapContext::FieldLabel),
      ("Name:\rAlice", PersonSoftWrapContext::FieldLabel),
      ("Name:\r\nAlice", PersonSoftWrapContext::FieldLabel),
      ("Name:\u{2028}Alice", PersonSoftWrapContext::FieldLabel),
      ("Name:\n\n\nAlice", PersonSoftWrapContext::None),
      ("Name:\u{2029}Alice", PersonSoftWrapContext::None),
      ("Invoice:\nAlice", PersonSoftWrapContext::None),
    ] {
      let start = u32::try_from(text.find("Alice").unwrap()).unwrap();
      let document = ResolutionDocument::new(text);
      assert_eq!(
        person_soft_wrap_context(
          &document,
          &ByteOffsets::new(text),
          start,
          &field_labels,
        )
        .unwrap(),
        expected,
      );
    }
  }

  #[test]
  fn deny_list_soft_wrap_does_not_absorb_email_field_label() {
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 5,
    }];
    let mut filters = DenyListFilterData::default();
    filters.first_names.insert(String::from("anika"));
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Anika")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("first-name")]].into(),
      filters: Some(filters),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      "Anika Hermann Bargfrede\nEmail: abargfrede@example.com",
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Anika Hermann Bargfrede");
  }

  #[test]
  fn deny_list_soft_wrap_does_not_absorb_city_state_zip_tail() {
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 7,
    }];
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Merritt")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("surname")]].into(),
      filters: Some(DenyListFilterData {
        us_state_abbreviations: std::iter::once(String::from("FL")).collect(),
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      "Merritt\nIsland, FL 32953",
      &data,
    )
    .unwrap();

    // Surname-only hits need capitalized context to emit; Island supplies it,
    // but the city/state/ZIP tail must block extension so FP reclassification
    // can recover the address span.
    assert!(
      entities
        .iter()
        .all(|entity| entity.text.replace('\n', " ") != "Merritt Island"),
      "city tail must not join the person span: {entities:?}"
    );
  }

  #[test]
  fn compacted_deny_list_accepts_uppercase_surname_as_single_hit_context() {
    let matches = vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 0,
        end: 6,
      },
      SearchMatch::Literal {
        pattern: 1,
        start: 7,
        end: 19,
      },
    ];
    let mut data = DenyListMatchData {
      labels: vec![vec![String::from("person")], vec![String::from("person")]]
        .into(),
      custom_labels: vec![vec![], vec![]].into(),
      originals: vec![String::from("Ctibor"), String::from("Příkladný")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![
        vec![String::from("first-name")],
        vec![String::from("surname")],
      ]
      .into(),
      filters: Some(DenyListFilterData::default()),
    };
    data.compact_runtime_patterns();
    assert!(data.originals.is_empty());

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 2 },
      "Ctibor PŘÍKLADNÝ podepsal smlouvu.",
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "person");
    assert_eq!(entities[0].text, "Ctibor PŘÍKLADNÝ");
  }

  #[test]
  fn compacted_deny_list_covers_uppercase_surname_after_ocr_whitespace() {
    let mut data = DenyListMatchData {
      labels: vec![vec![String::from("person")], vec![String::from("person")]]
        .into(),
      custom_labels: vec![vec![], vec![]].into(),
      originals: vec![String::from("Ctibor"), String::from("Příkladný")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![
        vec![String::from("first-name")],
        vec![String::from("surname")],
      ]
      .into(),
      filters: Some(DenyListFilterData::default()),
    };
    data.compact_runtime_patterns();

    for separator in ["  ", "\t", "\n"] {
      let text = format!("Ctibor{separator}PŘÍKLADNÝ podepsal smlouvu.");
      let surname_start =
        u32::try_from(text.find("PŘÍKLADNÝ").unwrap()).unwrap();
      let matches = vec![
        SearchMatch::Literal {
          pattern: 0,
          start: 0,
          end: 6,
        },
        SearchMatch::Literal {
          pattern: 1,
          start: surname_start,
          end: surname_start.saturating_add(byte_len("PŘÍKLADNÝ")),
        },
      ];

      let entities = process_deny_list_matches(
        &matches,
        PatternSlice { start: 0, end: 2 },
        &text,
        &data,
      )
      .unwrap();

      assert_eq!(entities.len(), 1, "separator {separator:?}");
      assert_eq!(
        entities[0].text,
        format!("Ctibor{separator}PŘÍKLADNÝ"),
        "separator {separator:?}"
      );
    }
  }

  #[test]
  fn compacted_deny_list_does_not_use_allow_list_surname_as_context() {
    let mut allow_list = BTreeSet::new();
    allow_list.insert(String::from("stock"));
    let mut data = DenyListMatchData {
      labels: vec![vec![String::from("person")], vec![String::from("person")]]
        .into(),
      custom_labels: vec![vec![], vec![]].into(),
      originals: vec![String::from("Alice"), String::from("Stock")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![
        vec![String::from("first-name")],
        vec![String::from("surname")],
      ]
      .into(),
      filters: Some(DenyListFilterData {
        allow_list,
        ..DenyListFilterData::default()
      }),
    };
    data.compact_runtime_patterns();
    let matches = vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 0,
        end: 5,
      },
      SearchMatch::Literal {
        pattern: 1,
        start: 6,
        end: 11,
      },
    ];

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 2 },
      "Alice STOCK option",
      &data,
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn compacted_deny_list_does_not_emit_uppercase_surname_standalone() {
    let matches = vec![SearchMatch::Literal {
      pattern: 1,
      start: 0,
      end: 12,
    }];
    let mut data = DenyListMatchData {
      labels: vec![vec![String::from("person")], vec![String::from("person")]]
        .into(),
      custom_labels: vec![vec![], vec![]].into(),
      originals: vec![String::from("Ctibor"), String::from("Příkladný")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![
        vec![String::from("first-name")],
        vec![String::from("surname")],
      ]
      .into(),
      filters: Some(DenyListFilterData::default()),
    };
    data.compact_runtime_patterns();

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 2 },
      "PŘÍKLADNÝ podepsal smlouvu.",
      &data,
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn deny_list_accepts_uppercase_ova_surname_without_surname_evidence() {
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 6,
    }];
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Ctibor")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("first-name")]].into(),
      filters: Some(DenyListFilterData::default()),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      "Ctibor PŘÍKLADOVÁ podepsala smlouvu.",
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "person");
    assert_eq!(entities[0].text, "Ctibor PŘÍKLADOVÁ");
  }

  #[test]
  fn deny_list_title_led_uppercase_surname_boundaries() {
    for (text, title, first_name, expected) in [
      (
        "Ing. Ctibor WURTZEL podepsal smlouvu.",
        "ing",
        "Ctibor",
        Some("Ctibor WURTZEL"),
      ),
      (
        "Ing. Ctibor WURTZEL-VL projekt",
        "ing",
        "Ctibor",
        Some("Ctibor WURTZEL-VL"),
      ),
      ("Ctibor WURTZEL podepsal smlouvu.", "ing", "Ctibor", None),
      ("Dr. Mark VAT as exempt.", "dr", "Mark", None),
      ("Dr. Mark AUGUST", "dr", "Mark", None),
      ("Dr.\n\nMark ALPHA", "dr", "Mark", None),
      ("Dr.\r\rMark ALPHA", "dr", "Mark", None),
      ("Dr.\u{2028}\u{2028}Mark ALPHA", "dr", "Mark", None),
      ("Dr.\u{2029}Mark ALPHA", "dr", "Mark", None),
      ("Ing. Ctibor\nWURTZEL", "ing", "Ctibor", None),
      ("Ing. Ctibor WURTZEL-123", "ing", "Ctibor", None),
    ] {
      let start = u32::try_from(text.find(first_name).unwrap()).unwrap();
      let end = start.saturating_add(byte_len(first_name));
      let matches = [SearchMatch::Literal {
        pattern: 0,
        start,
        end,
      }];
      let data = DenyListMatchData {
        labels: vec![vec![String::from("person")]].into(),
        custom_labels: vec![vec![]].into(),
        originals: vec![String::from(first_name)],
        pattern_meta: DenyListPatternMetaSet::default(),
        sources: vec![vec![String::from("first-name")]].into(),
        filters: Some(DenyListFilterData {
          person_stopwords: [String::from("august")].into(),
          title_tokens: [String::from(title)].into(),
          ..DenyListFilterData::default()
        }),
      };
      let entities = process_deny_list_matches(
        &matches,
        PatternSlice { start: 0, end: 1 },
        text,
        &data,
      )
      .unwrap();
      assert_eq!(
        entities.first().map(|entity| entity.text.as_str()),
        expected,
        "unexpected person span for {text:?}"
      );
    }
  }

  #[test]
  fn deny_list_rejects_uppercase_ova_sentence_starter() {
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 6,
    }];
    let mut sentence_starters = BTreeSet::new();
    sentence_starters.insert(String::from("příkladová"));
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Ctibor")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("first-name")]].into(),
      filters: Some(DenyListFilterData {
        sentence_starters,
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      "Ctibor PŘÍKLADOVÁ podepsala smlouvu.",
      &data,
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn deny_list_accepts_short_uppercase_surname_as_single_hit_context() {
    let matches = vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 0,
        end: 4,
      },
      SearchMatch::Literal {
        pattern: 1,
        start: 5,
        end: 10,
      },
    ];
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")], vec![String::from("person")]]
        .into(),
      custom_labels: vec![vec![], vec![]].into(),
      originals: vec![String::from("Anna"), String::from("Nová")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![
        vec![String::from("first-name")],
        vec![String::from("surname")],
      ]
      .into(),
      filters: Some(DenyListFilterData::default()),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 2 },
      "Anna NOVÁ podepsala smlouvu.",
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "person");
    assert_eq!(entities[0].text, "Anna NOVÁ");
  }

  #[test]
  fn deny_list_keeps_single_name_when_context_is_not_extended() {
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 7,
    }];
    let mut stopwords = BTreeSet::new();
    stopwords.insert(String::from("director"));
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Michael")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("first-name")]].into(),
      filters: Some(DenyListFilterData {
        stopwords,
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      "Michael  Director signed the agreement.",
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "person");
    assert_eq!(entities[0].text, "Michael");
  }

  #[test]
  fn deny_list_rejects_short_uppercase_acronym_as_single_hit_context() {
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 4,
    }];
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Rady")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("first-name")]].into(),
      filters: Some(DenyListFilterData::default()),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      "Rady EU adopted the regulation.",
      &data,
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn deny_list_rejects_uppercase_acronym_as_single_hit_context() {
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 4,
    }];
    let mut data = DenyListMatchData {
      labels: vec![vec![String::from("person")], vec![String::from("person")]]
        .into(),
      custom_labels: vec![vec![], vec![]].into(),
      originals: vec![String::from("Mark"), String::from("Smith")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![
        vec![String::from("first-name")],
        vec![String::from("surname")],
      ]
      .into(),
      filters: Some(DenyListFilterData::default()),
    };
    data.compact_runtime_patterns();

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 2 },
      "Mark VAT as exempt.",
      &data,
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn deny_list_exempts_corpus_backed_person_stopword_from_veto() {
    // "tito" is a legitimate global `person_stopwords` entry (e.g. to guard
    // against a Czech demonstrative pronoun), but the same token is also a
    // genuine first-name corpus match here. The corpus-backed match must not
    // be vetoed purely because its lowercase form is stopworded. The
    // trailing capitalized surname supplies the single-hit context
    // `append_person_name_hits` requires and is absorbed by
    // `extend_person_name`.
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 4,
    }];
    let mut person_stopwords = BTreeSet::new();
    person_stopwords.insert(String::from("tito"));
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Tito")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("first-name")]].into(),
      filters: Some(DenyListFilterData {
        person_stopwords,
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      "Tito Broz signed the agreement.",
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "person");
    assert_eq!(entities[0].text, "Tito Broz");
  }

  #[test]
  fn deny_list_still_vetoes_non_corpus_person_stopword() {
    // A person-labeled match with no corpus-name source (here: `title`,
    // matching a bare title-list pattern rather than a first-name/surname
    // corpus hit) should still be suppressed by the stopword veto; the
    // exemption above is deliberately narrow.
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 5,
    }];
    let mut person_stopwords = BTreeSet::new();
    person_stopwords.insert(String::from("agent"));
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Agent")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("title")]].into(),
      filters: Some(DenyListFilterData {
        person_stopwords,
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      "Agent signed the form.",
      &data,
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn deny_list_redacts_titled_name_in_defined_term_quote() {
    // `"Dr. John Smith" shall mean ...` must still redact "John Smith": the
    // defined-term-quote suppression has an exception for quotes that start
    // with a known first name followed by a role definition, but the raw
    // quote content starts with the title "Dr", not the name. Stripping a
    // leading known title before the first-name check lets the exception
    // fire correctly.
    let text = "\"Dr. John Smith\" shall mean the party of the first part.";
    let matches = vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 5,
        end: 9,
      },
      SearchMatch::Literal {
        pattern: 1,
        start: 10,
        end: 15,
      },
    ];
    let mut first_names = BTreeSet::new();
    first_names.insert(String::from("john"));
    let mut title_tokens = BTreeSet::new();
    title_tokens.insert(String::from("dr"));
    let mut defined_term_cues = BTreeSet::new();
    defined_term_cues.insert(String::from("shall mean"));
    let mut generic_roles = BTreeSet::new();
    generic_roles.insert(String::from("party"));

    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")], vec![String::from("person")]]
        .into(),
      custom_labels: vec![vec![], vec![]].into(),
      originals: vec![String::from("John"), String::from("Smith")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![
        vec![String::from("first-name")],
        vec![String::from("surname")],
      ]
      .into(),
      filters: Some(DenyListFilterData {
        first_names,
        generic_roles,
        defined_term_cues,
        title_tokens,
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 2 },
      text,
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "person");
    assert_eq!(entities[0].text, "John Smith");
  }

  #[test]
  fn deny_list_redacts_abbreviated_title_name_in_defined_term_quote() {
    // Dotted honorifics like the French "M." come from the corpus
    // title-abbreviation list (trailing dot stripped to "m" at assemble
    // time), not the plain title-token list. The quote filter must carry
    // them too: `"M. Jean Dupont" shall mean ...` has to strip the "M."
    // before the first-name check so the defined-term-quote exception
    // still fires.
    let text = "\"M. Jean Dupont\" shall mean the party of the first part.";
    let matches = vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 4,
        end: 8,
      },
      SearchMatch::Literal {
        pattern: 1,
        start: 9,
        end: 15,
      },
    ];
    let mut first_names = BTreeSet::new();
    first_names.insert(String::from("jean"));
    let mut title_tokens = BTreeSet::new();
    title_tokens.insert(String::from("m"));
    let mut defined_term_cues = BTreeSet::new();
    defined_term_cues.insert(String::from("shall mean"));
    let mut generic_roles = BTreeSet::new();
    generic_roles.insert(String::from("party"));

    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")], vec![String::from("person")]]
        .into(),
      custom_labels: vec![vec![], vec![]].into(),
      originals: vec![String::from("Jean"), String::from("Dupont")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![
        vec![String::from("first-name")],
        vec![String::from("surname")],
      ]
      .into(),
      filters: Some(DenyListFilterData {
        first_names,
        generic_roles,
        defined_term_cues,
        title_tokens,
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 2 },
      text,
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "person");
    assert_eq!(entities[0].text, "Jean Dupont");
  }

  #[test]
  fn deny_list_rejects_name_fragment_after_hyphen() {
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Frank")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("first-name")]].into(),
      filters: Some(DenyListFilterData::default()),
    };

    for dash in ['-', '‑', '–'] {
      let text = format!("under the Dodd{dash}Frank Wall Street Reform Act.");
      let start = u32::try_from(text.find("Frank").unwrap()).unwrap();
      let matches = vec![SearchMatch::Literal {
        pattern: 0,
        start,
        end: start.saturating_add(5),
      }];
      let entities = process_deny_list_matches(
        &matches,
        PatternSlice { start: 0, end: 1 },
        &text,
        &data,
      )
      .unwrap();

      assert!(entities.is_empty(), "dash {dash:?}");
    }
  }

  #[test]
  fn deny_list_keeps_supported_hyphenated_person_name() {
    let text = "Signed by Jean-Paul Smith.";
    let names = ["Jean", "Paul", "Smith"];
    let matches = names
      .iter()
      .enumerate()
      .map(|(pattern, name)| {
        let start = u32::try_from(text.find(name).unwrap()).unwrap();
        SearchMatch::Literal {
          pattern: u32::try_from(pattern).unwrap(),
          start,
          end: start.saturating_add(byte_len(name)),
        }
      })
      .collect::<Vec<_>>();
    let mut first_names = BTreeSet::new();
    first_names.insert(String::from("jean"));
    first_names.insert(String::from("paul"));
    let data = DenyListMatchData {
      labels: vec![
        vec![String::from("person")],
        vec![String::from("person")],
        vec![String::from("person")],
      ]
      .into(),
      custom_labels: vec![vec![], vec![], vec![]].into(),
      originals: names.map(String::from).to_vec(),
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![
        vec![String::from("first-name")],
        vec![String::from("first-name")],
        vec![String::from("surname")],
      ]
      .into(),
      filters: Some(DenyListFilterData {
        first_names,
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 3 },
      text,
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "person");
    assert_eq!(entities[0].text, "Jean-Paul Smith");
  }

  #[test]
  fn deny_list_keeps_standalone_city_roman_district() {
    let text = "office in Paris XV near the river";
    let start = u32::try_from(text.find("Paris").unwrap()).unwrap();
    let end = start.saturating_add(5);
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start,
      end,
    }];
    let data = DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Paris")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Paris XV");
  }

  #[test]
  fn deny_list_keeps_city_roman_district_after_capitalized_non_name() {
    let text = "Company's Paris XV office";
    let start = u32::try_from(text.find("Paris").unwrap()).unwrap();
    let end = start.saturating_add(5);
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start,
      end,
    }];
    let mut first_names = BTreeSet::new();
    first_names.insert(String::from("james"));
    let data = DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Paris")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData {
        first_names,
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Paris XV");
  }

  #[test]
  fn deny_list_does_not_attach_generational_roman_after_person_prefix() {
    let text = "and James J. Ferguson III (hereinafter referred to as you)";
    let start = u32::try_from(text.find("Ferguson").unwrap()).unwrap();
    let end = start.saturating_add(8);
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start,
      end,
    }];
    let mut first_names = BTreeSet::new();
    first_names.insert(String::from("james"));
    let data = DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Ferguson")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData {
        first_names,
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Ferguson");
    assert!(!entities.iter().any(|entity| entity.text == "Ferguson III"));
  }

  #[test]
  fn personal_name_prefix_requires_first_name_evidence() {
    let mut first_names = BTreeSet::new();
    first_names.insert(String::from("james"));
    let filters = DenyListFilterData {
      first_names,
      ..DenyListFilterData::default()
    };

    assert!(has_personal_name_prefix("and James J. ", &filters));
    assert!(has_personal_name_prefix("James\nJ. ", &filters));
    assert!(!has_personal_name_prefix("Company's ", &filters));
    assert!(!has_personal_name_prefix("office in ", &filters));
    assert!(!has_personal_name_prefix("", &filters));
  }

  #[test]
  fn deny_list_extends_person_across_dotted_middle_initial() {
    let text = "between Paul A. Pinkston (\"I\" or \"Employee\")";
    let paul_start = u32::try_from(text.find("Paul").unwrap()).unwrap();
    let paul_end = paul_start.saturating_add(4);
    let matches = vec![SearchMatch::Literal {
      pattern: 0,
      start: paul_start,
      end: paul_end,
    }];
    let mut first_names = BTreeSet::new();
    first_names.insert(String::from("paul"));
    let data = DenyListMatchData {
      labels: vec![vec![String::from("person")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Paul")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("first-name")]].into(),
      filters: Some(DenyListFilterData {
        first_names,
        ..DenyListFilterData::default()
      }),
    };

    let entities = process_deny_list_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
    )
    .unwrap();

    assert!(
      entities
        .iter()
        .any(|entity| entity.label == "person"
          && entity.text == "Paul A. Pinkston"),
      "{entities:?}"
    );
  }

  #[test]
  fn bare_single_letter_is_not_a_middle_initial() {
    assert!(!is_middle_initial_token("A"));
    assert!(is_middle_initial_token("A."));
  }

  fn surname_evidence_fixture(count: u32) -> Vec<RawDenyListMatch> {
    (0..count)
      .map(|index| {
        let start = index.saturating_mul(16);
        RawDenyListMatch {
          pattern: 0,
          start,
          end: start.saturating_add(9),
          labels: vec![String::from("person")],
          custom_labels: Vec::new(),
          has_person_name_source: true,
          has_city_head_name_source: false,
          has_surname_evidence: index.is_multiple_of(3),
          text: String::from("PRIKLADNY"),
        }
      })
      .collect()
  }

  #[test]
  fn surname_evidence_index_matches_the_reference_scan() {
    let hits = surname_evidence_fixture(64);
    let index = SurnameEvidenceIndex::build(&hits);
    for start in 0..u32::try_from(hits.len()).unwrap().saturating_mul(16) {
      for width in [0_u32, 8, 9, 10] {
        let end = start.saturating_add(width);
        assert_eq!(
          index.covers(start, end),
          deny_list_has_surname(&hits, start, end),
          "span {start}..{end} disagrees with the reference scan"
        );
      }
    }
  }

  /// The index must cost one visit per hit to build and one probe per query,
  /// never a scan per candidate. Doubling the hit count must not change the
  /// per-query probe count.
  #[test]
  fn surname_evidence_index_work_stays_linear_in_hits_and_queries() {
    for count in [64_u32, 1_024] {
      let hits = surname_evidence_fixture(count);
      let index = SurnameEvidenceIndex::build(&hits);
      assert_eq!(index.build_visits, hits.len());

      for hit in &hits {
        index.covers(hit.start, hit.end);
      }
      assert_eq!(index.probes.get(), hits.len());
    }
  }

  #[test]
  fn surname_evidence_index_holds_only_spans_carrying_evidence() {
    let hits = surname_evidence_fixture(9);
    let index = SurnameEvidenceIndex::build(&hits);
    assert_eq!(index.spans.len(), 3);
  }

  fn uppercase_surname_deny_list_sample(
    target_bytes: usize,
  ) -> (usize, std::time::Duration) {
    const FIXTURE: &str = "Ctibor PRIKLADNY podepsal smlouvu.\n";
    const SURNAME_BYTES: u32 = 9;
    let repeats = target_bytes.div_ceil(FIXTURE.len());
    let full_text = FIXTURE.repeat(repeats);
    let stride = u32::try_from(FIXTURE.len()).unwrap();
    let mut matches = Vec::with_capacity(repeats.saturating_mul(2));
    for index in 0..u32::try_from(repeats).unwrap() {
      let base = index.saturating_mul(stride);
      matches.push(SearchMatch::Literal {
        pattern: 0,
        start: base,
        end: base.saturating_add(6),
      });
      let surname_start = base.saturating_add(7);
      matches.push(SearchMatch::Literal {
        pattern: 1,
        start: surname_start,
        end: surname_start.saturating_add(SURNAME_BYTES),
      });
    }
    let mut data = DenyListMatchData {
      labels: vec![vec![String::from("person")], vec![String::from("person")]]
        .into(),
      custom_labels: vec![vec![], vec![]].into(),
      originals: vec![String::from("Ctibor"), String::from("Prikladny")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![
        vec![String::from("first-name")],
        vec![String::from("surname")],
      ]
      .into(),
      filters: Some(DenyListFilterData::default()),
    };
    data.compact_runtime_patterns();

    let mut best = std::time::Duration::MAX;
    for _ in 0..3 {
      let start = Instant::now();
      let entities = process_deny_list_matches(
        &matches,
        PatternSlice { start: 0, end: 2 },
        &full_text,
        &data,
      )
      .unwrap();
      best = best.min(start.elapsed());
      assert_eq!(entities.len(), repeats);
    }
    (full_text.len(), best)
  }

  #[test]
  #[ignore = "release-mode scaling regression check"]
  fn uppercase_surname_context_scales_with_deny_list_hit_count() {
    let small = uppercase_surname_deny_list_sample(64 * 1024);
    let large = uppercase_surname_deny_list_sample(1024 * 1024);
    let samples = [small, large];
    assert!(
      large
        .1
        .as_nanos()
        .saturating_mul(u128::try_from(small.0).unwrap_or(u128::MAX))
        <= small
          .1
          .as_nanos()
          .saturating_mul(u128::try_from(large.0).unwrap_or(u128::MAX))
          .saturating_mul(3),
      "uppercase surname context time per byte regressed: {samples:?}"
    );
    assert!(
      large.1 <= std::time::Duration::from_secs(1),
      "uppercase surname context exceeded 1 s at 1 MiB: {samples:?}"
    );
  }
}
