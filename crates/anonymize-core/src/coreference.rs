use regex::{Regex, RegexBuilder};
use std::collections::{BTreeMap, BTreeSet};

use crate::byte_offsets::ByteOffsets;
use crate::resolution::{PipelineEntity, SourceDetail};
use crate::types::{Error, Result};

const SEARCH_WINDOW: u32 = 200;
const COREFERENCE_SCORE: f64 = 0.95;
const ORG_PROPAGATION_SCORE: f64 = 0.9;
const ORG_DETERMINER_LOOKBACK: usize = 40;
const MAX_ALIASES_PER_DEFINITION: usize = 2;
const MAX_COMPACT_ORG_ALIAS_UNITS: usize = 8;

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct CoreferenceData {
  #[serde(default)]
  pub definition_patterns: Vec<CoreferencePatternData>,
  #[serde(default)]
  pub role_stop_terms: Vec<String>,
  #[serde(default)]
  pub legal_form_aliases: Vec<String>,
  #[serde(default)]
  pub organization_suffixes: Vec<String>,
  #[serde(default)]
  pub organization_determiners: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct CoreferencePatternData {
  pub pattern: String,
  #[serde(default)]
  pub flags: String,
}

pub(crate) struct PreparedCoreferenceData {
  definition_patterns: Vec<Regex>,
  role_stop_terms: BTreeSet<String>,
  legal_form_aliases: BTreeSet<String>,
  legal_form_suffixes: Vec<String>,
  org_determiner: Option<Regex>,
}

struct DefinedTerm {
  alias: String,
  label: String,
  source_text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OrgSeed {
  base_name: String,
  label: String,
  source_text: String,
}

impl PreparedCoreferenceData {
  pub(crate) fn new(data: CoreferenceData) -> Result<Self> {
    let mut definition_patterns =
      Vec::with_capacity(data.definition_patterns.len());
    for pattern in &data.definition_patterns {
      definition_patterns.push(compile_definition_pattern(pattern)?);
    }

    let mut legal_form_suffixes = if data.organization_suffixes.is_empty() {
      data.legal_form_aliases.clone()
    } else {
      data.organization_suffixes.clone()
    };
    legal_form_suffixes.sort_by_key(|suffix| std::cmp::Reverse(suffix.len()));

    Ok(Self {
      definition_patterns,
      role_stop_terms: lower_set(data.role_stop_terms),
      legal_form_aliases: data
        .legal_form_aliases
        .into_iter()
        .filter_map(|alias| normalized_legal_form_alias(&alias))
        .collect(),
      legal_form_suffixes,
      org_determiner: compile_org_determiner(&data.organization_determiners)?,
    })
  }

  pub(crate) fn process(
    &self,
    full_text: &str,
    existing_entities: &[PipelineEntity],
    threshold: f64,
  ) -> Result<Vec<PipelineEntity>> {
    let mut results = self.propagate_organization_names(
      full_text,
      existing_entities,
      threshold,
    )?;

    if !self.definition_patterns.is_empty() {
      let terms = if results.is_empty() {
        self.extract_defined_terms(full_text, existing_entities)?
      } else {
        let mut definition_entities = existing_entities.to_vec();
        definition_entities.extend(results.iter().cloned());
        self.extract_defined_terms(full_text, &definition_entities)?
      };
      results.extend(Self::find_alias_spans(full_text, &terms)?);
    }

    Ok(results)
  }

  fn extract_defined_terms(
    &self,
    full_text: &str,
    entities: &[PipelineEntity],
  ) -> Result<Vec<DefinedTerm>> {
    let offsets = ByteOffsets::new(full_text);
    let mut sorted = entities
      .iter()
      .filter(|entity| !caller_owned(entity))
      .collect::<Vec<_>>();
    sorted.sort_by_key(|entity| entity.start);

    let mut terms = Vec::new();
    let mut seen = BTreeSet::new();

    for pattern in &self.definition_patterns {
      for captures in pattern.captures_iter(full_text) {
        let Some(full_match) = captures.get(0) else {
          continue;
        };
        let definition_start =
          usize_to_u32("coreference.definition_start", full_match.start())?;
        let Some(source) =
          nearest_preceding_source(&sorted, &offsets, definition_start)?
        else {
          continue;
        };
        let gap = offsets.slice(source.end, definition_start)?;
        if has_clause_boundary(&gap) {
          continue;
        }

        for alias_match in captures
          .iter()
          .skip(1)
          .flatten()
          .take(MAX_ALIASES_PER_DEFINITION)
        {
          let alias = alias_match.as_str().trim();
          if alias.chars().count() < 2 {
            continue;
          }
          if self.role_stop_terms.contains(&alias.to_lowercase()) {
            continue;
          }
          if normalized_legal_form_alias(alias).is_some_and(|normalized| {
            self.legal_form_aliases.contains(&normalized)
          }) {
            continue;
          }
          let has_similarity = has_entity_similarity(alias, &source.text)
            || (source.label == "organization"
              && has_compact_organization_similarity(alias, &source.text));
          if !has_similarity {
            continue;
          }

          let key = format!("{}::{}", alias.to_lowercase(), source.label);
          if !seen.insert(key) {
            continue;
          }

          terms.push(DefinedTerm {
            alias: alias.to_owned(),
            label: source.label.clone(),
            source_text: source.text.clone(),
          });
        }
      }
    }

    Ok(terms)
  }

  fn find_alias_spans(
    full_text: &str,
    terms: &[DefinedTerm],
  ) -> Result<Vec<PipelineEntity>> {
    let mut results = Vec::new();

    for term in terms {
      let mut search_from = 0;
      while search_from < full_text.len() {
        let Some(relative) = full_text
          .get(search_from..)
          .and_then(|tail| tail.find(&term.alias))
        else {
          break;
        };
        let start = search_from.saturating_add(relative);
        let end = start.saturating_add(term.alias.len());
        if !is_word_boundary(full_text, start, end) {
          search_from = next_char_boundary(full_text, start);
          continue;
        }

        let start_u32 = usize_to_u32("coreference.alias_start", start)?;
        let end_u32 = usize_to_u32("coreference.alias_end", end)?;
        results.push(PipelineEntity::coreference(
          start_u32,
          end_u32,
          term.label.clone(),
          term.alias.clone(),
          COREFERENCE_SCORE,
          term.source_text.clone(),
        ));
        search_from = end;
      }
    }

    Ok(results)
  }

  fn propagate_organization_names(
    &self,
    full_text: &str,
    existing_entities: &[PipelineEntity],
    threshold: f64,
  ) -> Result<Vec<PipelineEntity>> {
    if threshold > ORG_PROPAGATION_SCORE || self.legal_form_suffixes.is_empty()
    {
      return Ok(Vec::new());
    }

    let seeds = self.organization_seeds(existing_entities);
    if seeds.is_empty() {
      return Ok(Vec::new());
    }

    let mut covered = existing_entities
      .iter()
      .map(|entity| (entity.start, entity.end))
      .collect::<Vec<_>>();
    let mut results = Vec::new();

    for seed in seeds {
      let mut search_from = 0usize;
      while search_from < full_text.len() {
        let Some(relative) = full_text
          .get(search_from..)
          .and_then(|tail| tail.find(&seed.base_name))
        else {
          break;
        };
        let start = search_from.saturating_add(relative);
        let end = start.saturating_add(seed.base_name.len());
        if !is_word_boundary(full_text, start, end) {
          search_from = next_char_boundary(full_text, start);
          continue;
        }

        let span_start =
          self.determiner_start(full_text, start).unwrap_or(start);
        let start_u32 = usize_to_u32("coreference.org_start", span_start)?;
        let end_u32 = usize_to_u32("coreference.org_end", end)?;
        if !span_overlaps(&covered, start_u32, end_u32) {
          results.push(PipelineEntity::coreference(
            start_u32,
            end_u32,
            seed.label.clone(),
            full_text.get(span_start..end).unwrap_or_default(),
            ORG_PROPAGATION_SCORE,
            seed.source_text.clone(),
          ));
          covered.push((start_u32, end_u32));
        }

        search_from = end;
      }
    }

    Ok(results)
  }

  fn organization_seeds(
    &self,
    existing_entities: &[PipelineEntity],
  ) -> Vec<OrgSeed> {
    let mut seed_by_base = BTreeMap::<String, OrgSeed>::new();

    for entity in existing_entities {
      if entity.label != "organization" || caller_owned(entity) {
        continue;
      }
      let Some(base) = self.organization_base_name(&entity.text) else {
        continue;
      };
      let entry = seed_by_base.entry(base.clone()).or_insert_with(|| OrgSeed {
        base_name: base.clone(),
        label: entity.label.clone(),
        source_text: entity.text.clone(),
      });
      if entry.source_text != entity.text {
        entry.source_text = base;
      }
    }

    seed_by_base.into_values().collect()
  }

  fn organization_base_name(&self, text: &str) -> Option<String> {
    for suffix in &self.legal_form_suffixes {
      let Some(base) = text.strip_suffix(suffix) else {
        continue;
      };
      let base =
        base.trim_end_matches(|ch: char| ch == ',' || ch.is_whitespace());
      let base = base.trim();
      if text_units(base) >= 3 {
        return Some(base.to_owned());
      }
    }
    None
  }

  fn determiner_start(
    &self,
    full_text: &str,
    match_start: usize,
  ) -> Option<usize> {
    let lookback_start =
      offset_before_text_units(full_text, match_start, ORG_DETERMINER_LOOKBACK);
    let lookback = full_text.get(lookback_start..match_start)?;
    let captures = self.org_determiner.as_ref()?.captures(lookback)?;
    let determiner = captures.get(1)?;
    let start = lookback_start.saturating_add(determiner.start());
    previous_char(full_text, start)
      .is_none_or(|ch| !is_word_char(ch))
      .then_some(start)
  }
}

fn compile_org_determiner(patterns: &[String]) -> Result<Option<Regex>> {
  if patterns.is_empty() {
    return Ok(None);
  }

  let pattern = format!("({})\\s+$", patterns.join("|"));
  RegexBuilder::new(&pattern)
    .case_insensitive(true)
    .unicode(true)
    .build()
    .map(Some)
    .map_err(|error| Error::InvalidStaticData {
      field: "coreference_data.org_determiner",
      reason: error.to_string(),
    })
}

fn compile_definition_pattern(data: &CoreferencePatternData) -> Result<Regex> {
  let mut builder = RegexBuilder::new(&data.pattern);
  for flag in data.flags.chars() {
    match flag {
      'g' | 'u' => {}
      'i' => {
        builder.case_insensitive(true);
      }
      'm' => {
        builder.multi_line(true);
      }
      's' => {
        builder.dot_matches_new_line(true);
      }
      _ => {
        return Err(Error::InvalidStaticData {
          field: "coreference_data.definition_patterns",
          reason: format!("unsupported regex flag '{flag}'"),
        });
      }
    }
  }
  builder.build().map_err(|error| Error::InvalidStaticData {
    field: "coreference_data.definition_patterns",
    reason: error.to_string(),
  })
}

fn nearest_preceding_source<'a>(
  sorted: &[&'a PipelineEntity],
  offsets: &ByteOffsets<'_>,
  definition_start: u32,
) -> Result<Option<&'a PipelineEntity>> {
  for entity in sorted.iter().rev() {
    if entity.end > definition_start {
      continue;
    }
    if offsets.utf16_units_between(entity.end, definition_start)?
      > SEARCH_WINDOW
    {
      break;
    }
    if matches!(entity.label.as_str(), "person" | "organization") {
      return Ok(Some(*entity));
    }
  }
  Ok(None)
}

fn has_clause_boundary(gap: &str) -> bool {
  if gap.contains(';') {
    return true;
  }

  for (index, ch) in gap.char_indices() {
    if ch != '.' {
      continue;
    }
    let Some(after_dot) = gap.get(index.saturating_add(ch.len_utf8())..) else {
      return true;
    };
    let mut tail = after_dot.chars();
    let next = loop {
      let Some(candidate) = tail.next() else {
        return true;
      };
      if candidate.is_whitespace()
        || matches!(candidate, '"' | '\'' | '„' | '‚' | '(')
      {
        continue;
      }
      break candidate;
    };
    if next.is_uppercase() {
      return true;
    }
  }

  false
}

fn has_entity_similarity(alias: &str, entity_text: &str) -> bool {
  let alias_lower = alias.to_lowercase();
  let entity_lower = entity_text.to_lowercase();

  if alias_lower.chars().count() >= 3 && entity_lower.contains(&alias_lower) {
    return true;
  }
  if entity_lower.chars().count() >= 3 && alias_lower.contains(&entity_lower) {
    return true;
  }

  let alias_words = split_similarity_words(&alias_lower);
  let entity_words = split_similarity_words(&entity_lower);
  let entity_word_set = entity_words.iter().collect::<BTreeSet<_>>();
  if alias_words
    .iter()
    .any(|word| entity_word_set.contains(word))
  {
    return true;
  }

  if !is_all_uppercase(alias) || alias.chars().count() < 2 {
    return false;
  }
  let alias_len = alias.chars().count();
  if alias_len > entity_words.len() {
    return false;
  }
  for start in 0..=entity_words.len().saturating_sub(alias_len) {
    let initials = entity_words
      .iter()
      .skip(start)
      .take(alias_len)
      .filter_map(|word| word.chars().next())
      .collect::<String>();
    if initials == alias_lower {
      return true;
    }
  }

  false
}

fn has_compact_organization_similarity(alias: &str, entity_text: &str) -> bool {
  let alias_units = alias.chars().count();
  if !(3..=MAX_COMPACT_ORG_ALIAS_UNITS).contains(&alias_units)
    || !alias
      .chars()
      .all(|ch| ch.is_alphabetic() && ch.is_uppercase())
  {
    return false;
  }

  let alias_chars = alias.to_lowercase().chars().collect::<Vec<_>>();
  let entity_lower = entity_text.to_lowercase();
  let entity_words = split_similarity_words(&entity_lower);
  let mut states = BTreeSet::from([(0_usize, 0_usize)]);
  for word in entity_words {
    let word_chars = word.chars().collect::<Vec<_>>();
    let mut next = states.clone();
    for (consumed, contributing_words) in &states {
      let Some(expected_first) = alias_chars.get(*consumed) else {
        continue;
      };
      if word_chars.first() != Some(expected_first) {
        continue;
      }
      let mut matched = 1_usize;
      next.insert((
        consumed.saturating_add(matched),
        contributing_words.saturating_add(1),
      ));
      for word_char in word_chars.iter().skip(1) {
        if alias_chars.get(consumed.saturating_add(matched)) != Some(word_char)
        {
          continue;
        }
        matched = matched.saturating_add(1);
        next.insert((
          consumed.saturating_add(matched),
          contributing_words.saturating_add(1),
        ));
      }
    }
    states = next;
  }

  states.iter().any(|(consumed, contributing_words)| {
    *consumed == alias_chars.len() && *contributing_words >= 2
  })
}

fn split_similarity_words(text: &str) -> Vec<String> {
  text
    .split(|ch: char| {
      matches!(
        ch,
        ' '
          | '\t'
          | '\n'
          | '\r'
          | '.'
          | ','
          | ';'
          | ':'
          | '\''
          | '"'
          | '('
          | ')'
          | '/'
          | '-'
      )
    })
    .filter(|word| word.chars().count() >= 2)
    .map(ToOwned::to_owned)
    .collect()
}

fn is_all_uppercase(text: &str) -> bool {
  text.chars().all(char::is_uppercase)
}

fn normalized_legal_form_alias(alias: &str) -> Option<String> {
  let normalized = alias.split_whitespace().collect::<String>().to_lowercase();
  (!normalized.is_empty()).then_some(normalized)
}

fn is_word_boundary(full_text: &str, start: usize, end: usize) -> bool {
  previous_char(full_text, start).is_none_or(|ch| !is_word_char(ch))
    && next_char(full_text, end).is_none_or(|ch| !is_word_char(ch))
}

fn previous_char(full_text: &str, index: usize) -> Option<char> {
  full_text.get(..index)?.chars().next_back()
}

fn next_char(full_text: &str, index: usize) -> Option<char> {
  full_text.get(index..)?.chars().next()
}

fn next_char_boundary(full_text: &str, index: usize) -> usize {
  let Some(ch) = next_char(full_text, index) else {
    return full_text.len();
  };
  index.saturating_add(ch.len_utf8())
}

fn is_word_char(ch: char) -> bool {
  ch.is_alphanumeric() || is_combining_mark(ch)
}

fn span_overlaps(covered: &[(u32, u32)], start: u32, end: u32) -> bool {
  covered.iter().any(|(covered_start, covered_end)| {
    start < *covered_end && end > *covered_start
  })
}

fn text_units(text: &str) -> usize {
  text.chars().map(char::len_utf16).sum()
}

fn offset_before_text_units(
  full_text: &str,
  end: usize,
  max_units: usize,
) -> usize {
  let Some(prefix) = full_text.get(..end) else {
    return 0;
  };
  let mut units = 0usize;
  for (index, ch) in prefix.char_indices().rev() {
    let width = ch.len_utf16();
    if units.saturating_add(width) > max_units {
      return index.saturating_add(ch.len_utf8());
    }
    units = units.saturating_add(width);
  }
  0
}

const fn is_combining_mark(ch: char) -> bool {
  matches!(
    ch,
    '\u{0300}'..='\u{036f}'
      | '\u{1ab0}'..='\u{1aff}'
      | '\u{1dc0}'..='\u{1dff}'
      | '\u{20d0}'..='\u{20ff}'
      | '\u{fe20}'..='\u{fe2f}'
  )
}

const fn caller_owned(entity: &PipelineEntity) -> bool {
  matches!(
    entity.source_detail,
    Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
  )
}

fn lower_set(values: Vec<String>) -> BTreeSet<String> {
  values
    .into_iter()
    .map(|value| value.to_lowercase())
    .collect()
}

fn usize_to_u32(field: &'static str, value: usize) -> Result<u32> {
  u32::try_from(value).map_err(|_| Error::InvalidStaticData {
    field,
    reason: String::from("offset exceeds u32 range"),
  })
}
