use std::collections::BTreeSet;
use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use crate::address_seeds::soft_wrapped_us_city_tail;
use crate::byte_offsets::ByteOffsets;
use crate::processors::DenyListFilterData;
use crate::resolution::{
  DetectionSource, PipelineEntity, ResolutionDocument, SourceDetail,
};
use crate::types::{Error, Result};

use crate::labels::{
  ADDRESS_LABEL, BIRTH_NUMBER_LABEL, CASE_NUMBER_LABEL, IP_ADDRESS_LABEL,
  ORGANIZATION_LABEL, PERSON_LABEL, REGISTRATION_NUMBER_LABEL,
};
const MAX_ORGANIZATION_LENGTH: usize = 80;
const MAX_PERSON_LENGTH: usize = 60;
const MAX_OPEN_ENDED_ORGANIZATION_WORDS: usize = 8;
const ALL_CAPS_LINE_LETTER_THRESHOLD: usize = 5;
const ALL_CAPS_LINE_RATIO: f64 = 0.95;
const ALL_CAPS_LINE_PROSE_EXTRA_LETTERS: usize = 20;
const ALL_CAPS_LINE_HEADING_WORD_LIMIT: usize = 5;
const MAX_PAGE_FOOTER_TOTAL: u32 = 1_000;

static POSTAL_CODE_RE: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r"\d{3}\s?\d{2}").ok());
static SECTION_NUMBER_RE: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r"^(?:§\s*)?\d{1,3}(?:\.\d{1,3}){0,4}\.?$").ok());

struct LineContext<'a> {
  line: &'a str,
  before: &'a str,
  after: &'a str,
  entity: Range<usize>,
}

fn line_context<'a>(
  document: &'a ResolutionDocument<'a>,
  offsets: &ByteOffsets<'_>,
  entity: &PipelineEntity,
) -> Result<Option<LineContext<'a>>> {
  let full_text = document.text();
  let start = offsets.validate_offset(entity.start)?;
  let end = offsets.validate_offset(entity.end)?;
  if start > end {
    return Err(Error::InvalidSpan {
      start: entity.start,
      end: entity.end,
    });
  }
  let Some(line_range) = document.line_range(start, end) else {
    return Ok(None);
  };
  let line = full_text
    .get(line_range.clone())
    .ok_or(Error::InvalidSpan {
      start: entity.start,
      end: entity.end,
    })?;
  let relative_start = start.saturating_sub(line_range.start);
  let relative_end = end.saturating_sub(line_range.start);
  let before = line.get(..relative_start).ok_or(Error::InvalidSpan {
    start: entity.start,
    end: entity.end,
  })?;
  let after = line.get(relative_end..).ok_or(Error::InvalidSpan {
    start: entity.start,
    end: entity.end,
  })?;
  Ok(Some(LineContext {
    line,
    before,
    after,
    entity: relative_start..relative_end,
  }))
}

pub(crate) struct FilterEntityFalsePositivesArgs<'a> {
  pub(crate) entities: Vec<PipelineEntity>,
  pub(crate) document: &'a ResolutionDocument<'a>,
  pub(crate) filters: Option<&'a DenyListFilterData>,
  pub(crate) directional_abbreviations: Option<&'a BTreeSet<String>>,
  pub(crate) legal_form_clause_introducers: Option<&'a [String]>,
}

pub(crate) fn filter_entity_false_positives(
  args: FilterEntityFalsePositivesArgs<'_>,
) -> Result<Vec<PipelineEntity>> {
  let FilterEntityFalsePositivesArgs {
    entities,
    document,
    filters,
    directional_abbreviations,
    legal_form_clause_introducers,
  } = args;
  let offsets = document.offsets();
  let mut filtered = Vec::with_capacity(entities.len());
  for entity in entities {
    if is_caller_owned(&entity) {
      filtered.push(entity);
      continue;
    }

    let Some(normalized) =
      normalize_entity(entity, &offsets, filters, directional_abbreviations)?
    else {
      continue;
    };
    if should_reject_entity(ShouldRejectEntityArgs {
      entity: &normalized,
      document,
      offsets: &offsets,
      filters,
      legal_form_clause_introducers,
    })? {
      continue;
    }
    filtered.push(normalized);
  }

  Ok(filtered)
}

fn normalize_entity(
  mut entity: PipelineEntity,
  offsets: &ByteOffsets<'_>,
  filters: Option<&DenyListFilterData>,
  directional_abbreviations: Option<&BTreeSet<String>>,
) -> Result<Option<PipelineEntity>> {
  let raw_text = offsets.slice_ref(entity.start, entity.end)?;
  let mut start_byte = 0usize;
  let mut end_byte = raw_text.len();

  trim_leading_artifacts(raw_text, &mut start_byte, end_byte);
  trim_leading_whitespace(raw_text, &mut start_byte, end_byte);

  if entity.label == ADDRESS_LABEL
    && let Some(filters) = filters
  {
    if let Some(trimmed) =
      address_role_prefix_len(slice(raw_text, start_byte, end_byte)?, filters)
    {
      start_byte = start_byte.saturating_add(trimmed);
      trim_leading_whitespace(raw_text, &mut start_byte, end_byte);
    }

    let address_text = slice(raw_text, start_byte, end_byte)?;
    if let Some(trimmed_end) = trim_trailing_address_prose(
      address_text,
      filters,
      directional_abbreviations,
    ) {
      end_byte = start_byte.saturating_add(trimmed_end);
    }
  }

  if entity.label == ORGANIZATION_LABEL
    && matches!(
      entity.source,
      DetectionSource::Trigger | DetectionSource::Coreference
    )
  {
    let org_text = slice(raw_text, start_byte, end_byte)?;
    // An open-ended trigger org (to-next-comma with no comma before the
    // sentence end) captures the court/company name plus trailing sentence
    // prose ("Conseil de prud'hommes des Sables-d'Olonne a rendu son
    // jugement"). Left whole it trips the open-ended word-count guard and the
    // whole entity is dropped. When it exceeds the guard, trim the trailing
    // lowercase prose back to the last capitalized token (the proper-noun
    // core) so the name survives. Gated on the same word cap, so shorter orgs
    // that already pass are never touched.
    if word_count(org_text) > MAX_OPEN_ENDED_ORGANIZATION_WORDS
      && let Some(cut) = trim_open_ended_org_prose(
        org_text,
        filters.map(|filters| &filters.sentence_starters),
        filters.map(|filters| &filters.in_name_connectors),
      )
    {
      end_byte = start_byte.saturating_add(cut);
    }
  }

  trim_trailing_separators(raw_text, start_byte, &mut end_byte);
  if start_byte >= end_byte {
    return Ok(None);
  }

  let cleaned_raw = slice(raw_text, start_byte, end_byte)?;
  if !cleaned_raw.chars().any(char::is_alphanumeric) {
    return Ok(None);
  }

  let original_start = entity.start;
  entity.start = original_start
    .saturating_add(byte_len(raw_text.get(..start_byte).unwrap_or_default()));
  entity.end = entity.start.saturating_add(byte_len(cleaned_raw));
  normalize_display_text(NormalizeDisplayTextParams {
    text: &mut entity.text,
    raw_text,
    cleaned_raw,
    start_byte,
    end_byte,
  });
  Ok(Some(entity))
}

pub(crate) struct SoftWrappedCityPersonCandidate {
  pub(crate) city_name: String,
  pub(crate) end: u32,
}

/// Soft-wrapped US city lines (`Merritt\nIsland, FL 32953`) can leave the
/// first city token as a person surname hit. Return the possible city name
/// and address end; the prepared literal index supplies the city evidence.
pub(crate) fn soft_wrapped_city_person_candidate(
  entity: &PipelineEntity,
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  state_abbreviations: &BTreeSet<String>,
) -> Result<Option<SoftWrappedCityPersonCandidate>> {
  if entity.label != PERSON_LABEL
    || entity.source != DetectionSource::DenyList
    || entity.source_detail == Some(SourceDetail::CustomDenyList)
  {
    return Ok(None);
  }
  let person = entity.text.trim();
  if person.split_whitespace().count() != 1
    || !person.chars().next().is_some_and(char::is_uppercase)
  {
    return Ok(None);
  }
  let after_byte = offsets.validate_offset(entity.end)?;
  let after = full_text.get(after_byte..).unwrap_or_default();
  let Some((tail_len, city_tail)) =
    soft_wrapped_us_city_tail(after, state_abbreviations)
  else {
    return Ok(None);
  };
  let Ok(tail_units) = u32::try_from(tail_len) else {
    return Ok(None);
  };
  let mut city_name = String::with_capacity(
    person
      .len()
      .saturating_add(city_tail.len().saturating_add(1)),
  );
  city_name.push_str(person);
  city_name.push(' ');
  city_name.push_str(city_tail);
  Ok(Some(SoftWrappedCityPersonCandidate {
    city_name,
    end: entity.end.saturating_add(tail_units),
  }))
}

struct ShouldRejectEntityArgs<'a> {
  entity: &'a PipelineEntity,
  document: &'a ResolutionDocument<'a>,
  offsets: &'a ByteOffsets<'a>,
  filters: Option<&'a DenyListFilterData>,
  legal_form_clause_introducers: Option<&'a [String]>,
}

fn should_reject_entity(args: ShouldRejectEntityArgs<'_>) -> Result<bool> {
  let ShouldRejectEntityArgs {
    entity,
    document,
    offsets,
    filters,
    legal_form_clause_introducers,
  } = args;
  let full_text = document.text();
  let text = entity.text.trim();
  if is_template_placeholder(text) {
    return Ok(true);
  }
  if exceeds_label_length(entity) {
    return Ok(true);
  }
  if exceeds_open_ended_word_count(entity) {
    return Ok(true);
  }
  // Explicit section markers (`§ 6`, `6.1`, `3.2.4`) are never addresses,
  // including when a place-of-performance cue extracts them as trigger values.
  // A single dotted number needs heading context because the same shape is
  // valid for sentence-final house numbers and postal codes.
  if entity.label == ADDRESS_LABEL
    && is_explicit_address_section(document, offsets, entity)?
  {
    return Ok(true);
  }
  if entity.label != IP_ADDRESS_LABEL
    && entity.label != ADDRESS_LABEL
    && is_section_number(text)
    && entity.source != DetectionSource::Trigger
  {
    return Ok(true);
  }
  if is_standalone_year(text) && entity.source != DetectionSource::Trigger {
    return Ok(true);
  }
  if entity.source != DetectionSource::Trigger
    && entity.label != CASE_NUMBER_LABEL
    && text.chars().next().is_some_and(|ch| ch.is_ascii_digit())
    && let Some(filters) = filters
    && has_number_abbrev_prefix(full_text, offsets, entity, filters)?
  {
    return Ok(true);
  }
  if entity.label == REGISTRATION_NUMBER_LABEL && is_short_letter_run(text) {
    return Ok(true);
  }
  // Birth-number identifiers are numeric (e.g. YYMMDD/NNNN). Trigger n-word
  // extraction can otherwise keep the next prose token after a cue such as
  // "rodné číslo," / "birth number".
  if entity.label == BIRTH_NUMBER_LABEL
    && !text.chars().any(|ch| ch.is_ascii_digit())
  {
    return Ok(true);
  }
  if entity.label == PERSON_LABEL && text.chars().any(|ch| ch.is_ascii_digit())
  {
    return Ok(true);
  }
  if let Some(filters) = filters {
    if entity.label == PERSON_LABEL
      && (is_single_rejected_token(text, &filters.person_stopwords)
        || is_single_rejected_token(text, &filters.allow_list))
    {
      return Ok(true);
    }
    if entity.label == PERSON_LABEL
      && ends_in_configured_trailing_noun(
        entity,
        &filters.person_trailing_nouns,
      )
    {
      return Ok(true);
    }
    if role_exact_match(entity, filters) {
      return Ok(true);
    }
  }
  if entity.label == ORGANIZATION_LABEL
    && is_all_caps_candidate(text)
    && is_all_caps_boilerplate_line(IsAllCapsBoilerplateLineArgs {
      document,
      offsets,
      entity,
      legal_form_clause_introducers,
    })?
  {
    return Ok(true);
  }
  if entity.label == ORGANIZATION_LABEL
    && filters
      .is_some_and(|filters| is_document_structure_heading(text, filters))
  {
    return Ok(true);
  }
  if entity.label == ORGANIZATION_LABEL
    && let Some(filters) = filters
    && is_numbered_page_footer(document, offsets, entity, filters)?
  {
    return Ok(true);
  }
  if entity.label == ADDRESS_LABEL && should_reject_address(entity, filters) {
    return Ok(true);
  }

  Ok(false)
}

fn should_reject_address(
  entity: &PipelineEntity,
  filters: Option<&DenyListFilterData>,
) -> bool {
  let text = entity.text.trim();
  if filters.is_some_and(|filters| is_signing_place_address(text, filters)) {
    return true;
  }
  if entity.source == DetectionSource::DenyList
    && filters.is_some_and(|filters| {
      ends_in_configured_trailing_noun(entity, &filters.address_trailing_nouns)
    })
  {
    return true;
  }
  // Street-type words inside statute titles (e.g. Dodd-Frank Wall Street
  // Reform ... Act) must not keep an over-long address span alive.
  if looks_like_statute_title_address(text) {
    return true;
  }

  let has_digits = text.chars().any(|ch| ch.is_ascii_digit());
  let has_component =
    filters.is_some_and(|filters| has_address_component(text, filters));
  if filters.is_some_and(|filters| is_jurisdiction_address(text, filters)) {
    return false;
  }
  if entity.source == DetectionSource::Trigger && !has_digits {
    if filters.is_some_and(|filters| is_only_ambiguous_component(text, filters))
    {
      return true;
    }
    if !has_component {
      return true;
    }
  }

  text.chars().count() > 40
    && !has_digits
    && !regex_is_match(&POSTAL_CODE_RE, text)
    && !has_component
}

fn looks_like_statute_title_address(text: &str) -> bool {
  if text.chars().any(|ch| ch.is_ascii_digit()) {
    return false;
  }
  let lower = text.to_lowercase();
  lower.contains("street")
    && (lower.contains(" reform")
      || lower.contains(" protection act")
      || lower.contains(" act "))
}

fn exceeds_label_length(entity: &PipelineEntity) -> bool {
  if entity.source == DetectionSource::LegalForm {
    return false;
  }
  let max = match entity.label.as_str() {
    ORGANIZATION_LABEL => MAX_ORGANIZATION_LENGTH,
    PERSON_LABEL => MAX_PERSON_LENGTH,
    _ => return false,
  };
  entity.text.chars().count() > max
}

fn exceeds_open_ended_word_count(entity: &PipelineEntity) -> bool {
  entity.label == ORGANIZATION_LABEL
    && matches!(
      entity.source,
      DetectionSource::Trigger | DetectionSource::Coreference
    )
    && word_count(&entity.text) > MAX_OPEN_ENDED_ORGANIZATION_WORDS
}

fn is_template_placeholder(text: &str) -> bool {
  let trimmed = text.trim();
  if trimmed.len() >= 3 && trimmed.chars().all(|ch| ch == '.' || ch == '_') {
    return true;
  }
  let Some(inner) = bracketed_inner(trimmed, '[', ']')
    .or_else(|| bracketed_inner(trimmed, '{', '}'))
  else {
    return false;
  };
  !inner.is_empty()
    && inner
      .chars()
      .all(|ch| ch == '_' || ch.is_alphanumeric() || ch.is_whitespace())
}

fn bracketed_inner(text: &str, open: char, close: char) -> Option<&str> {
  let mut chars = text.chars();
  if chars.next()? != open || chars.next_back()? != close {
    return None;
  }
  let start = open.len_utf8();
  let end = text.len().saturating_sub(close.len_utf8());
  text.get(start..end)
}

fn is_section_number(text: &str) -> bool {
  regex_is_match(&SECTION_NUMBER_RE, text.trim())
}

fn is_explicit_address_section(
  document: &ResolutionDocument<'_>,
  offsets: &ByteOffsets<'_>,
  entity: &PipelineEntity,
) -> Result<bool> {
  let trimmed = entity.text.trim();
  if let Some(section) = trimmed.strip_prefix('§') {
    return Ok(
      !section.trim().is_empty()
        && section
          .trim()
          .chars()
          .all(|ch| ch.is_ascii_digit() || ch == '.'),
    );
  }
  if !is_section_number(trimmed) {
    return Ok(false);
  }
  let without_terminal = trimmed.trim_end_matches('.');
  if without_terminal.contains('.') {
    return Ok(true);
  }
  if !trimmed.ends_with('.') {
    return Ok(false);
  }

  let Some(context) = line_context(document, offsets, entity)? else {
    return Ok(false);
  };
  if !context.before.trim().is_empty() {
    return Ok(false);
  }
  Ok(starts_with_section_heading_prefix(context.line))
}

fn is_standalone_year(text: &str) -> bool {
  let trimmed = text.trim();
  trimmed.len() == 4
    && trimmed.chars().all(|ch| ch.is_ascii_digit())
    && (trimmed.starts_with("19") || trimmed.starts_with("20"))
}

fn has_number_abbrev_prefix(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  entity: &PipelineEntity,
  filters: &DenyListFilterData,
) -> Result<bool> {
  let start = offsets.validate_offset(entity.start)?;
  let before = full_text.get(..start).ok_or(Error::InvalidSpan {
    start: entity.start,
    end: entity.end,
  })?;
  Ok(ends_with_number_abbrev(before, filters))
}

pub(crate) fn ends_with_number_abbrev(
  text: &str,
  filters: &DenyListFilterData,
) -> bool {
  let lower = text.trim_end().to_lowercase();
  filters.number_abbrev_prefixes.iter().any(|prefix| {
    let Some(before_prefix) = lower.strip_suffix(prefix) else {
      return false;
    };
    before_prefix
      .chars()
      .next_back()
      .is_none_or(|ch| ch.is_whitespace() || ch == '(')
  })
}

fn is_document_structure_heading(
  text: &str,
  filters: &DenyListFilterData,
) -> bool {
  let Some((word_end, word)) = first_word(text.trim_start()) else {
    return false;
  };
  if !filters
    .document_heading_words
    .contains(&word.to_lowercase())
  {
    return false;
  }
  let Some(rest) = text.trim_start().get(word_end..) else {
    return false;
  };
  starts_with_ordinal_marker_digit(rest, filters)
}

fn starts_with_ordinal_marker_digit(
  text: &str,
  filters: &DenyListFilterData,
) -> bool {
  let trimmed = text.trim_start();
  let lower = trimmed.to_lowercase();
  filters
    .document_heading_ordinal_markers
    .iter()
    .any(|marker| {
      if marker.is_empty() {
        return false;
      }
      if !lower.starts_with(marker) {
        return false;
      }
      let Some(rest) = trimmed.get(marker.len()..) else {
        return false;
      };
      rest
        .trim_start()
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_digit())
    })
}

fn is_short_letter_run(text: &str) -> bool {
  let letters = text.trim();
  (1..=2).contains(&letters.chars().count())
    && letters.chars().all(char::is_alphabetic)
}

/// True when the entity text is a single token (after punctuation trim)
/// whose lowercase form appears in `rejected`. Used for both person
/// stopwords and deny-list allow-list entries: allow-listed surfaces
/// already suppress curated keyword hits, so they must not survive as
/// single-token person triggers either (e.g. "represented by Shares of
/// Common Stock").
fn is_single_rejected_token(text: &str, rejected: &BTreeSet<String>) -> bool {
  let token = trim_token_punctuation(text);
  !token.is_empty()
    && !token.chars().any(char::is_whitespace)
    && rejected.contains(&token.to_lowercase())
}

fn ends_in_configured_trailing_noun(
  entity: &PipelineEntity,
  trailing_nouns: &BTreeSet<String>,
) -> bool {
  if matches!(
    entity.source_detail,
    Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
  ) {
    return false;
  }

  let mut words = entity
    .text
    .split(|ch: char| !ch.is_alphabetic())
    .filter(|word| !word.is_empty());
  if words.next().is_none() {
    return false;
  }
  let Some(last) = words.next_back() else {
    return false;
  };
  trailing_nouns.contains(&last.to_lowercase())
}

fn role_exact_match(
  entity: &PipelineEntity,
  filters: &DenyListFilterData,
) -> bool {
  matches!(entity.label.as_str(), PERSON_LABEL | ORGANIZATION_LABEL)
    && filters
      .generic_roles
      .contains(&entity.text.trim().to_lowercase())
}

fn is_numbered_page_footer(
  document: &ResolutionDocument<'_>,
  offsets: &ByteOffsets<'_>,
  entity: &PipelineEntity,
  filters: &DenyListFilterData,
) -> Result<bool> {
  if entity.source != DetectionSource::Trigger {
    return Ok(false);
  }
  let Some((head, page)) = words_and_number(&entity.text) else {
    return Ok(false);
  };
  let head = head.to_lowercase();

  let Some(context) = line_context(document, offsets, entity)? else {
    return Ok(false);
  };
  if !context.before.trim().is_empty() {
    return Ok(false);
  }

  let line_remainder = context.after.trim();
  if line_remainder.is_empty() {
    return Ok(
      filters.page_footer_markers.contains(&head)
        && page <= MAX_PAGE_FOOTER_TOTAL,
    );
  }
  let counter =
    bracketed_inner(line_remainder, '(', ')').unwrap_or(line_remainder);
  let Some((counter_head, total)) = words_and_number(counter) else {
    return Ok(false);
  };
  let marker = format!("{head} {}", counter_head.to_lowercase());
  if !filters.page_footer_markers.contains(&marker) {
    return Ok(false);
  }
  Ok(page <= total && total <= MAX_PAGE_FOOTER_TOTAL)
}

fn words_and_number(text: &str) -> Option<(&str, u32)> {
  let trimmed = text.trim().trim_start_matches(',').trim_start();
  let split = trimmed.rfind(char::is_whitespace)?;
  let words = trimmed
    .get(..split)?
    .trim_end()
    .trim_end_matches(':')
    .trim_end();
  let number = trimmed.get(split..)?.trim();
  if words.is_empty()
    || (words != "/"
      && !words
        .split_whitespace()
        .all(|word| word.chars().all(char::is_alphabetic)))
    || !number.chars().all(|ch| ch.is_ascii_digit())
  {
    return None;
  }
  Some((words, number.parse().ok()?))
}

fn is_all_caps_candidate(text: &str) -> bool {
  let mut has_upper = false;
  for ch in text.chars().filter(|ch| ch.is_alphabetic()) {
    if ch.is_lowercase() {
      return false;
    }
    has_upper |= ch.is_uppercase();
  }
  has_upper
}

struct IsAllCapsBoilerplateLineArgs<'a> {
  document: &'a ResolutionDocument<'a>,
  offsets: &'a ByteOffsets<'a>,
  entity: &'a PipelineEntity,
  legal_form_clause_introducers: Option<&'a [String]>,
}

fn is_all_caps_boilerplate_line(
  args: IsAllCapsBoilerplateLineArgs<'_>,
) -> Result<bool> {
  let IsAllCapsBoilerplateLineArgs {
    document,
    offsets,
    entity,
    legal_form_clause_introducers,
  } = args;
  let Some(context) = line_context(document, offsets, entity)? else {
    return Ok(false);
  };

  let mut letter_count = 0usize;
  let mut upper_count = 0usize;
  let mut outside_entity_letters = 0usize;
  for (index, ch) in context.line.char_indices() {
    if !ch.is_alphabetic() {
      continue;
    }
    letter_count = letter_count.saturating_add(1);
    if ch.is_uppercase() {
      upper_count = upper_count.saturating_add(1);
    }
    if index < context.entity.start || index >= context.entity.end {
      outside_entity_letters = outside_entity_letters.saturating_add(1);
    }
  }

  if letter_count <= ALL_CAPS_LINE_LETTER_THRESHOLD {
    return Ok(false);
  }
  if !uppercase_ratio_at_least(upper_count, letter_count) {
    return Ok(false);
  }
  if starts_with_section_heading_prefix(context.line) {
    return Ok(true);
  }
  // Contracts routinely set party clauses and captions in all caps. A
  // legal-form suffix is positive organization evidence, so it outweighs the
  // surrounding prose heuristic when the entity sits inside the clause or is
  // followed by caption punctuation. At the start of an unpunctuated heading,
  // however, a short ambiguous suffix can make the first heading words look
  // like an organization.
  let has_caption_delimiter = context
    .after
    .trim_start()
    .chars()
    .next()
    .is_some_and(|ch| matches!(ch, ',' | ':' | ';' | '(' | '-' | '–' | '—'));
  let has_clause_introducer = context
    .before
    .split(|ch: char| !ch.is_alphabetic())
    .rfind(|word| !word.is_empty())
    .is_some_and(|word| {
      legal_form_clause_introducers
        .unwrap_or_default()
        .iter()
        .any(|introducer| word.eq_ignore_ascii_case(introducer))
    });
  let legal_form_heading = entity.source == DetectionSource::LegalForm
    && !has_caption_delimiter
    && !has_clause_introducer;
  if outside_entity_letters >= ALL_CAPS_LINE_PROSE_EXTRA_LETTERS
    && (entity.source != DetectionSource::LegalForm || legal_form_heading)
  {
    return Ok(true);
  }
  Ok(
    word_count(&entity.text) > ALL_CAPS_LINE_HEADING_WORD_LIMIT
      && !entity.text.contains(','),
  )
}

fn starts_with_section_heading_prefix(line: &str) -> bool {
  let mut chars = line.trim_start().chars().peekable();
  if chars.peek().is_some_and(|ch| *ch == '§') {
    chars.next();
    while chars.peek().is_some_and(|ch| ch.is_whitespace()) {
      chars.next();
    }
  }

  let mut saw_digit = false;
  let mut group_digits = 0usize;
  while let Some(ch) = chars.peek().copied() {
    if ch.is_ascii_digit() {
      saw_digit = true;
      group_digits = group_digits.saturating_add(1);
      if group_digits > 3 {
        return false;
      }
      chars.next();
      continue;
    }
    if ch == '.' && saw_digit {
      group_digits = 0;
      chars.next();
      continue;
    }
    break;
  }
  if !saw_digit {
    return false;
  }
  while chars.peek().is_some_and(|ch| ch.is_whitespace()) {
    chars.next();
  }
  chars.next().is_some_and(char::is_uppercase)
}

fn trim_leading_artifacts(text: &str, start: &mut usize, end: usize) {
  while let Some(rest) = text.get(*start..end) {
    if !rest.starts_with('.') {
      break;
    }
    let after_dot_start = '.'.len_utf8();
    let Some(after_dot) = rest.get(after_dot_start..) else {
      break;
    };
    let whitespace = leading_whitespace_len(after_dot);
    if whitespace == 0 {
      break;
    }
    *start =
      (*start).saturating_add(after_dot_start.saturating_add(whitespace));
  }
}

fn trim_leading_whitespace(text: &str, start: &mut usize, end: usize) {
  let Some(rest) = text.get(*start..end) else {
    return;
  };
  *start = (*start).saturating_add(leading_whitespace_len(rest));
}

fn trim_trailing_separators(text: &str, start: usize, end: &mut usize) {
  while let Some(slice) = text.get(start..*end) {
    let Some((index, ch)) = slice.char_indices().next_back() else {
      break;
    };
    // Letterhead separators (comma, bullet) are not part of the value.
    if ch.is_whitespace() || ch == ',' || ch == '•' {
      *end = start.saturating_add(index);
      continue;
    }
    break;
  }
}

fn address_role_prefix_len(
  text: &str,
  filters: &DenyListFilterData,
) -> Option<usize> {
  let (word_end, word) = first_word(text)?;
  if !filters.generic_roles.contains(&word.to_lowercase()) {
    return None;
  }
  let rest = text.get(word_end..)?;
  let whitespace = leading_whitespace_len(rest);
  if whitespace == 0 {
    return None;
  }
  let candidate = rest.get(whitespace..)?;
  if looks_like_address_start(candidate, filters) {
    return Some(word_end.saturating_add(whitespace));
  }
  None
}

fn looks_like_address_start(text: &str, filters: &DenyListFilterData) -> bool {
  let trimmed = text.trim_start();
  trimmed.chars().next().is_some_and(|ch| {
    ch.is_ascii_digit()
      || ch.is_uppercase()
      || has_address_component(trimmed, filters)
  })
}

fn trim_trailing_address_prose(
  text: &str,
  filters: &DenyListFilterData,
  directional_abbreviations: Option<&BTreeSet<String>>,
) -> Option<usize> {
  for (index, ch) in text.char_indices() {
    if ch != '.' {
      continue;
    }
    let before = text.get(..index)?;
    if !before.chars().any(|candidate| candidate.is_ascii_digit()) {
      continue;
    }
    let after = text
      .get(index.saturating_add('.'.len_utf8())..)?
      .trim_start();

    // The current period may be the trailing dot of a street abbreviation
    // ("123 Main St." -> "Suite 100"). Street types are stored dotted ("st."),
    // so `before` (which excludes this dot) never matches; include the dot so
    // the abbreviation is recognized as an address component. Full street
    // names ("Street") already match on `before`.
    let before_with_dot = text
      .get(..index.saturating_add('.'.len_utf8()))
      .unwrap_or(before);
    if text_ends_with_address_component(before_with_dot, filters) {
      // Dotted abbreviation ("St."). The period is only the abbreviation's own
      // dot when a unit/address continuation follows ("Suite 100"); otherwise
      // it is a real sentence boundary and trailing prose must be trimmed. Keep
      // the abbreviation dot in the retained span.
      if is_unit_or_address_continuation(
        after,
        filters,
        directional_abbreviations,
      ) {
        continue;
      }
      if after.chars().next().is_some_and(char::is_uppercase) {
        return Some(before_with_dot.len());
      }
      continue;
    }
    if text_ends_with_address_component(before.trim_end(), filters) {
      // Full street name ("Street") preceding a hard address anchor: the
      // street name is never a sentence boundary here.
      continue;
    }
    if is_unit_or_address_continuation(
      after,
      filters,
      directional_abbreviations,
    ) {
      continue;
    }
    if after.chars().next().is_some_and(char::is_uppercase) {
      return Some(before.trim_end().len());
    }
  }
  None
}

/// A period followed by `after` is not a sentence break when `after` opens a
/// short fragment, carries an address component, or reads as a unit designator
/// plus identifier ("Suite 100", "Apt 4B") rather than a new prose sentence.
fn is_unit_or_address_continuation(
  after: &str,
  filters: &DenyListFilterData,
  directional_abbreviations: Option<&BTreeSet<String>>,
) -> bool {
  after.len() < 5
    || has_address_component(after, filters)
    || directional_abbreviations.is_some_and(|abbreviations| {
      crate::address_seeds::starts_with_address_directional_continuation(
        after,
        abbreviations,
      )
    })
    || starts_with_unit_number(after, filters)
}

/// True when `text` opens with a recognized unit designator ("Suite", "Apt",
/// "Unit", ...) immediately followed by a short unit identifier: digit-leading
/// ("Suite 100", "Unit 5", "Apt 4B") or a short alphanumeric letter code
/// ("Suite A", "Unit B2"). Prose sentences ("The tenant shall ...") and
/// capitalized headings that merely precede a number ("Section 2 applies")
/// fail because their first token is not a designator; prose after a real
/// designator ("Suite The") fails the short-identifier shape.
fn starts_with_unit_number(text: &str, filters: &DenyListFilterData) -> bool {
  let mut words = text.split_whitespace();
  let Some(first) = words.next() else {
    return false;
  };
  let designator = first.trim_end_matches('.').to_lowercase();
  if !filters.unit_designators.contains(&designator) {
    return false;
  }
  words.next().is_some_and(is_unit_identifier)
}

/// A unit identifier after a designator: digit-leading of any length, or a
/// short (<= 3 chars) alphanumeric code such as "A" or "B2".
fn is_unit_identifier(word: &str) -> bool {
  let token = word.trim_end_matches([',', '.', ';']);
  let mut chars = token.chars();
  let Some(head) = chars.next() else {
    return false;
  };
  if head.is_ascii_digit() {
    return true;
  }
  // Letter codes: a single letter ("Suite A") or letter + digits ("Unit B2").
  // Requiring digits after the letter keeps prose words ("Suite The") out.
  head.is_ascii_alphabetic()
    && token.chars().count() <= 3
    && chars.all(|ch| ch.is_ascii_digit())
}

fn has_address_component(text: &str, filters: &DenyListFilterData) -> bool {
  let lower = text.to_lowercase();
  filters
    .street_types
    .iter()
    .any(|component| contains_component(&lower, component))
    || filters
      .address_component_terms
      .iter()
      .any(|component| contains_component(&lower, component))
}

fn is_only_ambiguous_component(
  text: &str,
  filters: &DenyListFilterData,
) -> bool {
  filters
    .ambiguous_street_type_terms
    .iter()
    .any(|term| is_only_ambiguous_component_term(text, filters, term))
}

fn is_only_ambiguous_component_term(
  text: &str,
  filters: &DenyListFilterData,
  term: &str,
) -> bool {
  if term.is_empty() {
    return false;
  }
  let Some((start, end)) = find_ambiguous_component_occurrence(text, term)
  else {
    return false;
  };
  if text
    .get(end..)
    .is_some_and(starts_with_capitalized_token_after_space)
  {
    return false;
  }
  let mut stripped = String::with_capacity(text.len());
  stripped.push_str(text.get(..start).unwrap_or_default());
  stripped.push(' ');
  stripped.push_str(text.get(end..).unwrap_or_default());
  !has_address_component(&stripped, filters)
}

fn find_ambiguous_component_occurrence(
  text: &str,
  term: &str,
) -> Option<(usize, usize)> {
  text.char_indices().find_map(|(start, _)| {
    let match_len = case_insensitive_prefix_len(text.get(start..)?, term)?;
    let end = start.saturating_add(match_len);
    let left_ok = text
      .get(..start)
      .and_then(|prefix| prefix.chars().next_back())
      .is_none_or(is_left_component_boundary);
    let right_ok = text
      .get(end..)
      .and_then(|suffix| suffix.chars().next())
      .is_none_or(is_right_component_boundary);
    (left_ok && right_ok).then_some((start, end))
  })
}

fn case_insensitive_prefix_len(text: &str, prefix: &str) -> Option<usize> {
  let mut consumed = 0usize;
  for expected in prefix.chars() {
    let actual = text.get(consumed..)?.chars().next()?;
    if !actual.eq_ignore_ascii_case(&expected) {
      return None;
    }
    consumed = consumed.saturating_add(actual.len_utf8());
  }
  Some(consumed)
}

fn starts_with_capitalized_token_after_space(text: &str) -> bool {
  let leading = leading_whitespace_len(text);
  if leading == 0 {
    return false;
  }
  text
    .get(leading..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(char::is_uppercase)
}

fn is_jurisdiction_address(text: &str, filters: &DenyListFilterData) -> bool {
  let lower = text.to_lowercase();
  filters.address_jurisdiction_prefixes.iter().any(|prefix| {
    let Some(rest) = lower.strip_prefix(prefix) else {
      return false;
    };
    rest.chars().next().is_some_and(char::is_whitespace)
      && rest.chars().any(char::is_alphabetic)
  })
}

fn text_ends_with_address_component(
  text: &str,
  filters: &DenyListFilterData,
) -> bool {
  let lower = text.to_lowercase();
  filters.street_types.iter().any(|component| {
    if component.is_empty() || !lower.ends_with(component) {
      return false;
    }
    let prefix_len = lower.len().saturating_sub(component.len());
    lower
      .get(..prefix_len)
      .and_then(|prefix| prefix.chars().next_back())
      .is_none_or(is_left_component_boundary)
  })
}

fn contains_component(text: &str, component: &str) -> bool {
  if component.is_empty() {
    return false;
  }
  text.match_indices(component).any(|(start, _)| {
    let end = start.saturating_add(component.len());
    let left_ok = text
      .get(..start)
      .and_then(|prefix| prefix.chars().next_back())
      .is_none_or(is_left_component_boundary);
    let right_ok = text
      .get(end..)
      .and_then(|suffix| suffix.chars().next())
      .is_none_or(is_right_component_boundary);
    left_ok && right_ok
  })
}

const fn is_left_component_boundary(ch: char) -> bool {
  ch.is_whitespace() || ch == ',' || ch == '(' || ch == '['
}

const fn is_right_component_boundary(ch: char) -> bool {
  ch.is_whitespace() || matches!(ch, ',' | '.' | '/' | ')' | ']')
}

fn is_signing_place_address(text: &str, filters: &DenyListFilterData) -> bool {
  let lower = text.to_lowercase();
  filters.signing_place_guards.iter().any(|guard| {
    guard.prefix_phrases.iter().any(|prefix| {
      !prefix.is_empty()
        && lower.starts_with(prefix)
        && guard
          .suffix_phrases
          .iter()
          .any(|suffix| !suffix.is_empty() && lower.ends_with(suffix))
    })
  })
}

fn first_word(text: &str) -> Option<(usize, &str)> {
  let mut end = 0usize;
  for (index, ch) in text.char_indices() {
    if !ch.is_alphabetic() {
      break;
    }
    end = index.saturating_add(ch.len_utf8());
  }
  if end == 0 {
    return None;
  }
  text.get(..end).map(|word| (end, word))
}

/// Byte offset just past the last capitalized token that belongs to the leading
/// organization name. Scanning records capitalized tokens as the retained span
/// and stops at a lowercase sentence-starter (`the`, `for`, `by`, ...) that
/// marks the transition from the name to trailing clause prose, so a
/// capitalized defined term later in the sentence ("... shall provide the
/// Services ...") is not mistaken for the name's tail.
///
/// The starter-stop is *armed* only after the scan has passed at least one
/// lowercase token that is neither a sentence-starter nor an in-name connector
/// (`filters.in_name_connectors`). An in-name article that appears before any prose
/// ("Bank of **the** West National Association") therefore does not cut the
/// name: it arrives unarmed. A run of lowercase connector words inside the name
/// ("Tribunal de commerce des Sables-d'Olonne") is likewise preserved. Returns
/// `Some` only when trailing content follows the retained span, so callers can
/// trim it off.
fn trim_open_ended_org_prose(
  text: &str,
  sentence_starters: Option<&BTreeSet<String>>,
  in_name_connectors: Option<&BTreeSet<String>>,
) -> Option<usize> {
  let mut last_capital_end = None::<usize>;
  let mut word_start = None::<usize>;
  let mut word_is_capital = false;
  let mut armed = false;
  let mut prev_word = None::<&str>;
  let trimmed_end = text.trim_end().len();
  for (idx, ch) in text.char_indices() {
    let is_word_char =
      ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '-' | '.');
    if is_word_char {
      if word_start.is_none() {
        word_start = Some(idx);
        word_is_capital = ch.is_uppercase();
      }
      continue;
    }
    let Some(start) = word_start.take() else {
      continue;
    };
    let word = text.get(start..idx);
    let is_capital = word_is_capital || is_elided_capital(word);
    // A capitalized token that opens a new sentence ("... de Paris. La
    // décision ...") must stop the scan, not extend the name. It qualifies
    // only when the previous token ended in a sentence-final period and this
    // token is a starter/connector that has no business inside the name.
    if is_capital
      && starts_new_sentence(
        prev_word,
        word,
        sentence_starters,
        in_name_connectors,
      )
    {
      break;
    }
    if is_capital {
      last_capital_end = Some(idx);
      prev_word = word;
      continue;
    }
    if armed && is_sentence_starter(word, sentence_starters) {
      break;
    }
    if !is_in_name_connector(word, in_name_connectors)
      && !is_sentence_starter(word, sentence_starters)
    {
      armed = true;
    }
    prev_word = word;
  }
  if let Some(start) = word_start {
    let tail = text.get(start..trimmed_end);
    if (word_is_capital || is_elided_capital(tail))
      && !starts_new_sentence(
        prev_word,
        tail,
        sentence_starters,
        in_name_connectors,
      )
    {
      last_capital_end = Some(trimmed_end);
    }
  }
  let end = last_capital_end?;
  (end < trimmed_end).then_some(end)
}

/// French/Italian elisions hide the capital behind an apostrophe:
/// "d'Aix-en-Provence", "l'Oreal", "dell'Arte". A token whose 1-4 letter
/// lowercase prefix is followed by an apostrophe and an uppercase letter is
/// part of a proper name, not clause prose.
fn is_elided_capital(word: Option<&str>) -> bool {
  let Some(word) = word else {
    return false;
  };
  let Some(apostrophe) = word.find(['\'', '\u{2019}']) else {
    return false;
  };
  let Some(prefix) = word.get(..apostrophe) else {
    return false;
  };
  if prefix.is_empty()
    || prefix.chars().count() > 4
    || !prefix
      .chars()
      .all(|ch| ch.is_alphabetic() && ch.is_lowercase())
  {
    return false;
  }
  word
    .get(apostrophe..)
    .and_then(|tail| tail.chars().nth(1))
    .is_some_and(char::is_uppercase)
}

fn is_in_name_connector(
  word: Option<&str>,
  in_name_connectors: Option<&BTreeSet<String>>,
) -> bool {
  let (Some(word), Some(connectors)) = (word, in_name_connectors) else {
    return false;
  };
  connectors.contains(&word.to_lowercase())
}

fn is_sentence_starter(
  word: Option<&str>,
  sentence_starters: Option<&BTreeSet<String>>,
) -> bool {
  let (Some(word), Some(starters)) = (word, sentence_starters) else {
    return false;
  };
  starters.contains(&word.to_lowercase())
}

/// A capitalized `word` begins a new sentence (so it must not be recorded as
/// part of the organization name) when the previous token closed a sentence
/// and this token is a sentence-starter or an in-name connector used at
/// sentence position (French "La", "Le", ...). A capitalized connector after a
/// sentence-final period is a sentence start, not an in-name particle.
fn starts_new_sentence(
  prev_word: Option<&str>,
  word: Option<&str>,
  sentence_starters: Option<&BTreeSet<String>>,
  in_name_connectors: Option<&BTreeSet<String>>,
) -> bool {
  ends_with_sentence_final_period(prev_word)
    && (is_sentence_starter(word, sentence_starters)
      || is_in_name_connector(word, in_name_connectors))
}

/// The token closes a sentence: it ends in a period whose stem is a
/// multi-character word carrying a lowercase letter ("Paris."). This excludes
/// dotted initialisms and acronyms ("J.P.", "U.S.") whose stem has no
/// lowercase letter, so a capitalized token still joins the name across them.
fn ends_with_sentence_final_period(word: Option<&str>) -> bool {
  let Some(word) = word else {
    return false;
  };
  let stem = word.trim_end_matches('.');
  stem.len() != word.len()
    && stem.chars().take(2).count() == 2
    && stem.chars().any(char::is_lowercase)
}

fn word_count(text: &str) -> usize {
  let mut count = 0usize;
  let mut in_word = false;
  for ch in text.chars() {
    let word_char =
      ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '-' | '.');
    if word_char && !in_word {
      count = count.saturating_add(1);
    }
    in_word = word_char;
  }
  count
}

fn trim_token_punctuation(text: &str) -> &str {
  text
    .trim()
    .trim_matches(|ch: char| matches!(ch, '.' | ',' | ';' | ':' | '!' | '?'))
}

fn leading_whitespace_len(text: &str) -> usize {
  let mut len = 0usize;
  for ch in text.chars() {
    if !ch.is_whitespace() {
      break;
    }
    len = len.saturating_add(ch.len_utf8());
  }
  len
}

fn slice(text: &str, start: usize, end: usize) -> Result<&str> {
  text.get(start..end).ok_or_else(|| Error::InvalidSpan {
    start: u32::try_from(start).unwrap_or(u32::MAX),
    end: u32::try_from(end).unwrap_or(u32::MAX),
  })
}

fn collapse_display_whitespace(text: &str) -> String {
  let mut out = String::new();
  let mut whitespace = String::new();

  for ch in text.chars() {
    if ch.is_whitespace() {
      whitespace.push(ch);
      continue;
    }

    flush_whitespace(&mut out, &mut whitespace);
    out.push(ch);
  }

  flush_whitespace(&mut out, &mut whitespace);
  out
}

struct NormalizeDisplayTextParams<'a> {
  text: &'a mut String,
  raw_text: &'a str,
  cleaned_raw: &'a str,
  start_byte: usize,
  end_byte: usize,
}

fn normalize_display_text(params: NormalizeDisplayTextParams<'_>) {
  let NormalizeDisplayTextParams {
    text,
    raw_text,
    cleaned_raw,
    start_byte,
    end_byte,
  } = params;
  if display_whitespace_needs_collapse(cleaned_raw) {
    *text = collapse_display_whitespace(cleaned_raw);
    return;
  }
  if text == cleaned_raw {
    return;
  }
  if text == raw_text {
    text.truncate(end_byte);
    drop(text.drain(..start_byte));
    return;
  }
  *text = cleaned_raw.to_owned();
}

fn display_whitespace_needs_collapse(text: &str) -> bool {
  let mut whitespace_count = 0usize;
  for ch in text.chars() {
    if !ch.is_whitespace() {
      whitespace_count = 0;
      continue;
    }
    if matches!(ch, '\n' | '\r') || whitespace_count > 0 {
      return true;
    }
    whitespace_count = 1;
  }
  false
}

fn flush_whitespace(output: &mut String, whitespace: &mut String) {
  if whitespace.is_empty() {
    return;
  }

  if whitespace.chars().any(|ch| matches!(ch, '\n' | '\r'))
    || whitespace.chars().count() >= 2
  {
    output.push(' ');
  } else if let Some(ch) = whitespace.chars().next() {
    output.push(ch);
  }

  whitespace.clear();
}

fn byte_len(text: &str) -> u32 {
  u32::try_from(text.len()).unwrap_or(u32::MAX)
}

fn regex_is_match(regex: &LazyLock<Option<Regex>>, text: &str) -> bool {
  regex
    .as_ref()
    .is_some_and(|compiled| compiled.is_match(text))
}

fn uppercase_ratio_at_least(upper_count: usize, letter_count: usize) -> bool {
  let Some(upper) = u32::try_from(upper_count).ok().map(f64::from) else {
    return true;
  };
  let Some(total) = u32::try_from(letter_count).ok().map(f64::from) else {
    return true;
  };
  upper / total >= ALL_CAPS_LINE_RATIO
}

const fn is_caller_owned(entity: &PipelineEntity) -> bool {
  matches!(
    entity.source_detail,
    Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
  )
}

#[cfg(test)]
mod tests {
  #![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

  use std::collections::BTreeSet;

  use super::*;

  fn filter_entity_false_positives(
    entities: Vec<PipelineEntity>,
    full_text: &str,
    filters: Option<&DenyListFilterData>,
  ) -> Result<Vec<PipelineEntity>> {
    let clause_introducers = [
      String::from("among"),
      String::from("amongst"),
      String::from("between"),
      String::from("by"),
      String::from("with"),
    ];
    filter_with_clause_introducers(FilterWithClauseIntroducersArgs {
      entities,
      full_text,
      filters,
      clause_introducers: &clause_introducers,
    })
  }

  struct FilterWithClauseIntroducersArgs<'a> {
    entities: Vec<PipelineEntity>,
    full_text: &'a str,
    filters: Option<&'a DenyListFilterData>,
    clause_introducers: &'a [String],
  }

  fn filter_with_clause_introducers(
    args: FilterWithClauseIntroducersArgs<'_>,
  ) -> Result<Vec<PipelineEntity>> {
    let FilterWithClauseIntroducersArgs {
      entities,
      full_text,
      filters,
      clause_introducers,
    } = args;
    let document = ResolutionDocument::new(full_text);
    super::filter_entity_false_positives(FilterEntityFalsePositivesArgs {
      entities,
      document: &document,
      filters,
      directional_abbreviations: None,
      legal_form_clause_introducers: Some(clause_introducers),
    })
  }

  fn trim_trailing_address_prose(
    text: &str,
    filters: &DenyListFilterData,
  ) -> Option<usize> {
    super::trim_trailing_address_prose(text, filters, None)
  }

  #[test]
  fn normalization_reuses_unchanged_text_allocation() -> Result<()> {
    let full_text = "Alice";
    let entity =
      entity(full_text, full_text, PERSON_LABEL, DetectionSource::Regex);
    let text_pointer = entity.text.as_ptr();
    let normalized = filter_entity_false_positives(
      vec![entity],
      full_text,
      Some(&DenyListFilterData::default()),
    )?;

    assert_eq!(normalized.len(), 1);
    assert_eq!(
      normalized.first().map(|item| item.text.as_ptr()),
      Some(text_pointer)
    );
    Ok(())
  }

  #[test]
  fn normalization_trims_text_in_place() -> Result<()> {
    let full_text = ". Alice,";
    let entity =
      entity(full_text, full_text, PERSON_LABEL, DetectionSource::Regex);
    let text_pointer = entity.text.as_ptr();
    let normalized = normalize_entity(
      entity,
      &ByteOffsets::new(full_text),
      Some(&DenyListFilterData::default()),
      None,
    )?
    .ok_or(Error::InvalidSpan { start: 0, end: 0 })?;

    assert_eq!(normalized.start, 2);
    assert_eq!(normalized.end, 7);
    assert_eq!(normalized.text, "Alice");
    assert_eq!(normalized.text.as_ptr(), text_pointer);
    Ok(())
  }

  #[test]
  fn unchanged_text_allocations_stay_constant_as_entity_count_scales()
  -> Result<()> {
    const ENTITY_COUNT: usize = 20_000;
    let full_text = "Alice";
    let entities = (0..ENTITY_COUNT)
      .map(|_| {
        entity(full_text, full_text, PERSON_LABEL, DetectionSource::Regex)
      })
      .collect::<Vec<_>>();
    let input_pointers = entities
      .iter()
      .map(|entity| entity.text.as_ptr())
      .collect::<Vec<_>>();
    let normalized = filter_entity_false_positives(entities, full_text, None)?;
    let output_pointers = normalized
      .iter()
      .map(|entity| entity.text.as_ptr())
      .collect::<Vec<_>>();

    assert_eq!(normalized.len(), ENTITY_COUNT);
    assert_eq!(output_pointers, input_pointers);
    Ok(())
  }

  #[test]
  fn trims_trailing_prose_back_to_last_capital() {
    // Trailing prose is all lowercase, so the last-capital scan lands on the
    // name's final proper-noun token even without a sentence-starter boundary.
    assert_eq!(
      trim_open_ended_org_prose(
        "Conseil de prud'hommes des Sables-d'Olonne a rendu son jugement",
        None,
        Some(&in_name_connectors()),
      ),
      Some("Conseil de prud'hommes des Sables-d'Olonne".len())
    );
    assert_eq!(
      trim_open_ended_org_prose(
        "Tribunal judiciaire du Mans statue sur l'affaire",
        None,
        Some(&in_name_connectors()),
      ),
      Some("Tribunal judiciaire du Mans".len())
    );
  }

  #[test]
  fn stops_at_sentence_starter_before_trailing_defined_term() {
    // Trailing clause prose contains a capitalized defined term ("Services").
    // Without a boundary the last-capital scan would keep it; the lowercase
    // sentence-starter "the" marks the end of the org name so the trim lands on
    // "Corporation".
    let starters = set(["the", "this", "for", "by"]);
    assert_eq!(
      trim_open_ended_org_prose(
        "ACME Corporation shall provide the Services under this agreement",
        Some(&starters),
        Some(&in_name_connectors()),
      ),
      Some("ACME Corporation".len())
    );
  }

  #[test]
  fn keeps_in_name_article_before_prose() {
    // "the" here is an in-name article inside "Bank of the West National
    // Association", not the start of trailing clause prose. The scan must not
    // stop on it (it arrives before any prose token arms the starter-stop), so
    // the trim lands at/after "Association".
    let starters = set(["the", "this", "for", "by", "a"]);
    assert_eq!(
      trim_open_ended_org_prose(
        "Bank of the West National Association shall provide services",
        Some(&starters),
        Some(&in_name_connectors()),
      ),
      Some("Bank of the West National Association".len())
    );
  }

  #[test]
  fn arms_starter_stop_only_after_prose_token() {
    // Symmetric to the in-name article case: once a prose token ("shall") has
    // been seen, a following sentence-starter ("the") does stop the scan so the
    // capitalized defined term ("Services") stays out of the name.
    let starters = set(["the", "this", "for", "by", "a"]);
    assert_eq!(
      trim_open_ended_org_prose(
        "ACME Corporation shall provide the Services under this agreement",
        Some(&starters),
        Some(&in_name_connectors()),
      ),
      Some("ACME Corporation".len())
    );
  }

  #[test]
  fn elided_city_name_is_kept_when_trimming_org_prose() {
    let starters = set(["the", "this", "for", "by", "a"]);
    let text = "Conseil de prud'hommes d'Aix-en-Provence a rendu son jugement";
    let keep = "Conseil de prud'hommes d'Aix-en-Provence";
    assert_eq!(
      trim_open_ended_org_prose(
        text,
        Some(&starters),
        Some(&in_name_connectors())
      ),
      Some(keep.len()),
      "the elided d'Aix-en-Provence token must count as capitalized"
    );
  }

  #[test]
  fn in_name_connector_does_not_arm_before_city() {
    // French court name: the "de"/"des" connectors do not arm the starter-stop,
    // so the hyphenated city is recorded before any English-style starter
    // ("a") could stop the scan. Trim ends at "Sables-d'Olonne".
    let starters = set(["the", "this", "for", "by", "a"]);
    assert_eq!(
      trim_open_ended_org_prose(
        "Tribunal de commerce des Sables-d'Olonne a rendu son jugement",
        Some(&starters),
        Some(&in_name_connectors()),
      ),
      Some("Tribunal de commerce des Sables-d'Olonne".len())
    );
  }

  #[test]
  fn stops_at_capitalized_sentence_starter_after_period() {
    // "Tribunal de commerce de Paris. La décision ..." — the sentence-final
    // period after "Paris" ends the court name. "La" is a capitalized French
    // sentence starter (also an in-name connector when lowercased), so left
    // unchecked it is recorded as a name token and the retained span keeps
    // ". La" garbage. The post-period stop cuts the scan at the period so the
    // name ends at "Paris." (the caller does not strip the trailing dot).
    assert_eq!(
      trim_open_ended_org_prose(
        "Tribunal de commerce de Paris. La décision a été rendue aujourd'hui",
        None,
        Some(&in_name_connectors()),
      ),
      Some("Tribunal de commerce de Paris.".len())
    );
  }

  #[test]
  fn dotted_initials_join_across_capital_after_period() {
    // "J.P." is a dotted initialism, not a sentence end: its stem carries no
    // lowercase letter, so the following capitalized token joins the name and
    // only the trailing lowercase clause is trimmed.
    let starters = set(["the", "this", "for", "by", "a"]);
    assert_eq!(
      trim_open_ended_org_prose(
        "J.P. Morgan Chase Bank agreed to the terms",
        Some(&starters),
        Some(&in_name_connectors()),
      ),
      Some("J.P. Morgan Chase Bank".len())
    );
  }

  #[test]
  fn open_ended_org_stops_before_capitalized_sentence_starter() {
    // Entity-level: the open-ended trigger org exceeds the word guard, is
    // trimmed to "...Paris.", and the following French sentence ("La décision
    // ...") is dropped rather than absorbed. Uses default filters (empty
    // sentence starters) to prove the in-name-connector path ("la") arms the
    // stop without any per-language starter data.
    let text =
      "Tribunal de commerce de Paris. La décision a été rendue aujourd'hui.";
    let filters = DenyListFilterData {
      in_name_connectors: in_name_connectors(),
      ..DenyListFilterData::default()
    };
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        text,
        ORGANIZATION_LABEL,
        DetectionSource::Trigger,
      )],
      text,
      Some(&filters),
    )
    .unwrap();
    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Tribunal de commerce de Paris.");
  }

  #[test]
  fn keeps_capital_terminated_names_untrimmed() {
    // Nothing to trim when the name already ends at a capital token.
    assert_eq!(
      trim_open_ended_org_prose(
        "Conseil de prud'hommes des Sables-d'Olonne",
        None,
        Some(&in_name_connectors()),
      ),
      None
    );
    assert_eq!(
      trim_open_ended_org_prose(
        "Bank of America",
        None,
        Some(&in_name_connectors())
      ),
      None
    );
  }

  #[test]
  fn open_ended_court_org_survives_word_guard_by_trimming() {
    // Nine words with trailing prose: rejected outright before the trim,
    // now trimmed to the five-word proper-noun core and kept.
    let text =
      "Conseil de prud'hommes des Sables-d'Olonne a rendu son jugement.";
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        text,
        ORGANIZATION_LABEL,
        DetectionSource::Trigger,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();
    assert_eq!(entities.len(), 1);
    assert_eq!(
      entities[0].text,
      "Conseil de prud'hommes des Sables-d'Olonne"
    );
  }

  #[test]
  fn keeps_unit_continuation_after_street_abbreviation() {
    // "123 Main St. Suite 100": the period is the street abbreviation's own
    // dot, not a sentence end, so the unit continuation must not be trimmed.
    let filters = DenyListFilterData {
      street_types: set(["st.", "street"]),
      unit_designators: unit_designators(),
      ..DenyListFilterData::default()
    };
    assert_eq!(
      trim_trailing_address_prose("123 Main St. Suite 100", &filters),
      None
    );
    // A full street name behaves the same (already did).
    assert_eq!(
      trim_trailing_address_prose("123 Main Street. Suite 100", &filters),
      None
    );
  }

  #[test]
  fn keeps_lettered_suite_continuation_after_abbreviation() {
    let filters = DenyListFilterData {
      street_types: set(["st.", "street"]),
      unit_designators: unit_designators(),
      ..DenyListFilterData::default()
    };
    assert_eq!(
      trim_trailing_address_prose("123 Main St. Suite A", &filters),
      None,
      "a lettered unit after a designator is an address continuation"
    );
    assert_eq!(
      trim_trailing_address_prose("123 Main St. Suite The tenant", &filters),
      Some("123 Main St.".len()),
      "prose after a designator must still trim"
    );
  }

  #[test]
  fn keeps_unit_designator_but_trims_capitalized_heading_after_abbreviation() {
    // Only real unit designators ("Suite", "Apt") count as a continuation of
    // the address. A capitalized heading that merely precedes a number
    // ("Section 2 applies") is trailing prose and must be trimmed off.
    let filters = DenyListFilterData {
      street_types: set(["st.", "street"]),
      unit_designators: unit_designators(),
      ..DenyListFilterData::default()
    };
    assert_eq!(
      trim_trailing_address_prose("123 Main St. Apt 4B", &filters),
      None
    );
    assert_eq!(
      trim_trailing_address_prose("123 Main St. Section 2 applies", &filters),
      Some("123 Main St.".len())
    );
  }

  #[test]
  fn trims_new_sentence_after_street_abbreviation() {
    // "123 Main St. The tenant shall pay rent": the period is the street
    // abbreviation's dot, but what follows is a new prose sentence, not a
    // unit continuation, so the sentence trim must apply while keeping the
    // abbreviation dot on "St.".
    let filters = DenyListFilterData {
      street_types: set(["st.", "street"]),
      unit_designators: unit_designators(),
      ..DenyListFilterData::default()
    };
    assert_eq!(
      trim_trailing_address_prose(
        "123 Main St. The tenant shall pay rent",
        &filters
      ),
      Some("123 Main St.".len())
    );
  }

  #[test]
  fn rejects_birth_number_values_without_digits() {
    let entities = filter_entity_false_positives(
      vec![entity(
        "údaje",
        "údaje",
        BIRTH_NUMBER_LABEL,
        DetectionSource::Trigger,
      )],
      "údaje",
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn soft_wrapped_us_city_person_produces_lookup_candidate() {
    // Sidus Space employment agreement (2026-07-24): `Merritt\nIsland, FL
    // 32953` left the city headword labeled as a person.
    let full_text = "Merritt\nIsland, FL 32953";
    let states = std::iter::once(String::from("FL")).collect();
    let candidate = soft_wrapped_city_person_candidate(
      &entity(
        "Merritt",
        "Merritt",
        PERSON_LABEL,
        DetectionSource::DenyList,
      ),
      full_text,
      &ByteOffsets::new(full_text),
      &states,
    )
    .unwrap()
    .unwrap();

    assert_eq!(candidate.city_name, "Merritt Island");
    assert_eq!(candidate.end, 24);

    let mut custom = entity(
      "Merritt",
      "Merritt",
      PERSON_LABEL,
      DetectionSource::DenyList,
    );
    custom.source_detail = Some(SourceDetail::CustomDenyList);
    assert!(
      soft_wrapped_city_person_candidate(
        &custom,
        full_text,
        &ByteOffsets::new(full_text),
        &states,
      )
      .unwrap()
      .is_none()
    );
  }

  #[test]
  fn soft_wrapped_us_city_accepts_lowercase_particles() {
    let full_text = "Coeur\nd'Alene, ID 83814";
    let states = std::iter::once(String::from("ID")).collect();
    let candidate = soft_wrapped_city_person_candidate(
      &entity("Coeur", "Coeur", PERSON_LABEL, DetectionSource::DenyList),
      full_text,
      &ByteOffsets::new(full_text),
      &states,
    )
    .unwrap()
    .unwrap();

    assert_eq!(candidate.city_name, "Coeur d'Alene");
    assert_eq!(
      candidate.end,
      u32::try_from(full_text.len()).unwrap_or(u32::MAX)
    );
  }

  #[test]
  fn keeps_birth_number_values_with_digits() {
    let text = "900101/1234";
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        text,
        BIRTH_NUMBER_LABEL,
        DetectionSource::Trigger,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, text);
  }

  #[test]
  fn trims_trailing_bullet_separator() {
    let text = "Sulická 1597/48, 142 00 Praha 4 •";
    let entities = filter_entity_false_positives(
      vec![entity(text, text, ADDRESS_LABEL, DetectionSource::Regex)],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Sulická 1597/48, 142 00 Praha 4");
  }

  #[test]
  fn rejects_template_placeholders() {
    let entities = filter_entity_false_positives(
      vec![entity(
        "[NAME]",
        "[NAME]",
        PERSON_LABEL,
        DetectionSource::Regex,
      )],
      "[NAME]",
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn rejects_generic_false_positives_without_deny_list_filters() {
    let text = "[NAME]\n17. NO ASSIGNMENT.\n";
    let heading_start = text.find("NO ASSIGNMENT").unwrap();
    let heading_end = heading_start.saturating_add("NO ASSIGNMENT".len());
    let entities = filter_entity_false_positives(
      vec![
        entity("[NAME]", "[NAME]", PERSON_LABEL, DetectionSource::Regex),
        PipelineEntity::detected(
          u32::try_from(heading_start).unwrap(),
          u32::try_from(heading_end).unwrap(),
          ORGANIZATION_LABEL,
          "NO ASSIGNMENT",
          0.8,
          DetectionSource::Regex,
        ),
      ],
      text,
      None,
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn trims_address_role_prefix_from_shared_role_data() {
    let text = "sídlo prodávajícího Na Květnici 1";
    let start = text.find("prodávajícího").unwrap();
    let filters = DenyListFilterData {
      generic_roles: set(["prodávajícího"]),
      ..DenyListFilterData::default()
    };

    let entities = filter_entity_false_positives(
      vec![PipelineEntity::detected(
        u32::try_from(start).unwrap(),
        u32::try_from(text.len()).unwrap(),
        ADDRESS_LABEL,
        "prodávajícího Na Květnici 1",
        0.8,
        DetectionSource::Trigger,
      )],
      text,
      Some(&filters),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Na Květnici 1");
    assert_eq!(
      entities[0].start,
      u32::try_from("sídlo prodávajícího ".len()).unwrap()
    );
  }

  #[test]
  fn preserves_single_non_breaking_space_in_entity_text() {
    let text = "Městským soudem v\u{00a0}Praze";
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        text,
        ORGANIZATION_LABEL,
        DetectionSource::Trigger,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, text);
  }

  #[test]
  fn rejects_trigger_address_without_digits_or_street_component() {
    let entities = filter_entity_false_positives(
      vec![entity(
        "Nejsme plátci DPH",
        "Nejsme plátci DPH",
        ADDRESS_LABEL,
        DetectionSource::Trigger,
      )],
      "Nejsme plátci DPH",
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn deny_list_addresses_respect_address_only_trailing_nouns() {
    let text = "Independence Day";
    let filters = DenyListFilterData {
      address_trailing_nouns: set(["day"]),
      ..DenyListFilterData::default()
    };
    let rejected = filter_entity_false_positives(
      vec![entity(text, text, ADDRESS_LABEL, DetectionSource::DenyList)],
      text,
      Some(&filters),
    )
    .unwrap();
    let kept_without_english_terms = filter_entity_false_positives(
      vec![entity(text, text, ADDRESS_LABEL, DetectionSource::DenyList)],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(rejected.is_empty());
    assert_eq!(kept_without_english_terms.len(), 1);
  }

  #[test]
  fn keeps_people_who_share_an_address_trailing_noun() {
    let text = "Dorothy Day";
    let filters = DenyListFilterData {
      address_trailing_nouns: set(["day"]),
      ..DenyListFilterData::default()
    };
    let entities = filter_entity_false_positives(
      vec![entity(text, text, PERSON_LABEL, DetectionSource::DenyList)],
      text,
      Some(&filters),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
  }

  #[test]
  fn keeps_trigger_address_with_street_component() {
    let filters = DenyListFilterData {
      street_types: set(["street"]),
      ..DenyListFilterData::default()
    };
    let entities = filter_entity_false_positives(
      vec![entity(
        "West Street",
        "West Street",
        ADDRESS_LABEL,
        DetectionSource::Trigger,
      )],
      "West Street",
      Some(&filters),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
  }

  #[test]
  fn keeps_configured_jurisdiction_addresses_without_digits() {
    let filters = DenyListFilterData {
      address_jurisdiction_prefixes: set(["state of"]),
      ..DenyListFilterData::default()
    };
    let entities = filter_entity_false_positives(
      vec![entity(
        "State of Delaware",
        "State of Delaware",
        ADDRESS_LABEL,
        DetectionSource::Trigger,
      )],
      "State of Delaware",
      Some(&filters),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
  }

  #[test]
  fn rejects_person_stopwords() {
    let filters = DenyListFilterData {
      person_stopwords: set(["tato"]),
      ..DenyListFilterData::default()
    };
    let entities = filter_entity_false_positives(
      vec![entity("Tato", "Tato", PERSON_LABEL, DetectionSource::Regex)],
      "Tato",
      Some(&filters),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn rejects_person_spans_ending_in_defined_term_heads() {
    let filters = DenyListFilterData {
      person_trailing_nouns: set(["description", "award", "awards"]),
      ..DenyListFilterData::default()
    };
    for text in ["Job Description", "Sales Award", "Sales Awards"] {
      let entities = filter_entity_false_positives(
        vec![entity(text, text, PERSON_LABEL, DetectionSource::DenyList)],
        text,
        Some(&filters),
      )
      .unwrap();
      assert!(entities.is_empty(), "{text}");
    }
  }

  #[test]
  fn rejects_allow_listed_single_token_person_triggers() {
    let filters = DenyListFilterData {
      allow_list: set(["shares"]),
      ..DenyListFilterData::default()
    };
    let entities = filter_entity_false_positives(
      vec![entity(
        "Shares",
        "Shares",
        PERSON_LABEL,
        DetectionSource::Trigger,
      )],
      "Shares",
      Some(&filters),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn rejects_all_caps_section_heading_organizations() {
    let text = "17. NO ASSIGNMENT.\n";
    let start = text.find("NO ASSIGNMENT").unwrap();
    let end = start.saturating_add("NO ASSIGNMENT".len());
    let entities = filter_entity_false_positives(
      vec![PipelineEntity::detected(
        u32::try_from(start).unwrap(),
        u32::try_from(end).unwrap(),
        ORGANIZATION_LABEL,
        "NO ASSIGNMENT",
        0.8,
        DetectionSource::Regex,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn keeps_legal_form_organizations_on_all_caps_lines() {
    // Contracts are routinely set in all caps. The boilerplate heuristic
    // reads the surrounding line, so a party named in an all-caps clause
    // looks like a heading; a legal-form suffix is positive evidence that it
    // is a company, and must survive the line-shape veto.
    for terminal in [".", "!", "?", "。", "！", "？"] {
      let text =
        format!("THIS AGREEMENT IS WITH ACME LIMITED IN PRAGUE{terminal}\n");
      let start = text.find("ACME LIMITED").unwrap();
      let end = start.saturating_add("ACME LIMITED".len());
      let entities = filter_entity_false_positives(
        vec![PipelineEntity::detected(
          u32::try_from(start).unwrap(),
          u32::try_from(end).unwrap(),
          ORGANIZATION_LABEL,
          "ACME LIMITED",
          0.8,
          DetectionSource::LegalForm,
        )],
        &text,
        Some(&DenyListFilterData::default()),
      )
      .unwrap();

      assert_eq!(entities.len(), 1, "terminal {terminal:?}");
    }
  }

  #[test]
  fn keeps_long_legal_form_party_clauses() {
    let text = "THIS AGREEMENT IS WITH ACME LIMITED AS THE SELLER UNDER THIS AGREEMENT.\n";
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        "ACME LIMITED",
        ORGANIZATION_LABEL,
        DetectionSource::LegalForm,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
  }

  #[test]
  fn legal_form_party_clauses_use_scoped_introducers() {
    for (text, entity_text, introducers) in [
      (
        "DIESE VEREINBARUNG IST MIT ACME GMBH ALS VERKÄUFER GESCHLOSSEN.\n",
        "ACME GMBH",
        vec![String::from("mit"), String::from("zwischen")],
      ),
      (
        "TATO SMLOUVA JE S ACME S.R.O. JAKO PRODÁVAJÍCÍ UZAVŘENA.\n",
        "ACME S.R.O.",
        vec![String::from("mezi"), String::from("s")],
      ),
    ] {
      let entities =
        filter_with_clause_introducers(FilterWithClauseIntroducersArgs {
          entities: vec![entity(
            text,
            entity_text,
            ORGANIZATION_LABEL,
            DetectionSource::LegalForm,
          )],
          full_text: text,
          filters: Some(&DenyListFilterData::default()),
          clause_introducers: &introducers,
        })
        .unwrap();
      assert_eq!(entities.len(), 1, "text {text:?}");
    }

    let german =
      "DIESE VEREINBARUNG IST MIT ACME GMBH ALS VERKÄUFER GESCHLOSSEN.\n";
    let english_introducers = [String::from("with")];
    let entities =
      filter_with_clause_introducers(FilterWithClauseIntroducersArgs {
        entities: vec![entity(
          german,
          "ACME GMBH",
          ORGANIZATION_LABEL,
          DetectionSource::LegalForm,
        )],
        full_text: german,
        filters: Some(&DenyListFilterData::default()),
        clause_introducers: &english_introducers,
      })
      .unwrap();
    assert!(entities.is_empty());
  }

  #[test]
  fn rejects_legal_form_organizations_in_numbered_all_caps_headings() {
    let text = "17. FORMATION OF LIMITED LIABILITY COMPANY\n";
    let entity_text = "LIMITED LIABILITY COMPANY";
    let start = text.find(entity_text).unwrap();
    let entities = filter_entity_false_positives(
      vec![PipelineEntity::detected(
        u32::try_from(start).unwrap(),
        u32::try_from(start.saturating_add(entity_text.len())).unwrap(),
        ORGANIZATION_LABEL,
        entity_text,
        0.8,
        DetectionSource::LegalForm,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn rejects_mid_line_legal_forms_in_unnumbered_all_caps_headings() {
    for terminal in ["", ".", "。"] {
      let text = format!(
        "REGISTRATION OF LIMITED LIABILITY COMPANY REQUIREMENTS AND PROCEDURES{terminal}\n"
      );
      let entity_text = "LIMITED LIABILITY COMPANY";
      let entities = filter_entity_false_positives(
        vec![entity(
          &text,
          entity_text,
          ORGANIZATION_LABEL,
          DetectionSource::LegalForm,
        )],
        &text,
        Some(&DenyListFilterData::default()),
      )
      .unwrap();

      assert!(entities.is_empty(), "terminal {terminal:?}");
    }
  }

  #[test]
  fn rejects_short_tailed_punctuated_legal_form_headings() {
    let text = "REGISTRATION OF LIMITED LIABILITY COMPANY PROCEDURES.\n";
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        "LIMITED LIABILITY COMPANY",
        ORGANIZATION_LABEL,
        DetectionSource::LegalForm,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn rejects_legal_form_prefixes_in_unnumbered_all_caps_headings() {
    let text = "RÁMCOVÁ DOHODA NA POSKYTOVÁNÍ PRÁVNÍCH SLUŽEB\n";
    let entity_text = "RÁMCOVÁ DOHODA NA";
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        entity_text,
        ORGANIZATION_LABEL,
        DetectionSource::LegalForm,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn keeps_leading_all_caps_legal_form_captions() {
    let text =
      "ACME LIMITED, A DELAWARE CORPORATION AND PARTY TO THIS AGREEMENT\n";
    let entity_text = "ACME LIMITED";
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        entity_text,
        ORGANIZATION_LABEL,
        DetectionSource::LegalForm,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
  }

  #[test]
  fn keeps_colon_delimited_all_caps_legal_form_captions() {
    let text =
      "ACME LIMITED: A DELAWARE CORPORATION AND PARTY TO THIS AGREEMENT\n";
    let entity_text = "ACME LIMITED";
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        entity_text,
        ORGANIZATION_LABEL,
        DetectionSource::LegalForm,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
  }

  #[test]
  fn keeps_dash_delimited_all_caps_legal_form_captions() {
    for separator in ["-", "–", "—"] {
      let text = format!(
        "ACME LIMITED {separator} A DELAWARE CORPORATION AND PARTY TO THIS AGREEMENT\n"
      );
      let entity_text = "ACME LIMITED";
      let entities = filter_entity_false_positives(
        vec![entity(
          &text,
          entity_text,
          ORGANIZATION_LABEL,
          DetectionSource::LegalForm,
        )],
        &text,
        Some(&DenyListFilterData::default()),
      )
      .unwrap();

      assert_eq!(entities.len(), 1, "separator {separator:?}");
    }
  }

  #[test]
  fn keeps_multiline_all_caps_organizations() {
    let text = "ACME\nCORP";
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        text,
        ORGANIZATION_LABEL,
        DetectionSource::Regex,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "ACME CORP");
  }

  #[test]
  fn rejects_explicit_address_sections_but_keeps_address_numbers() {
    for (full_text, marker) in [
      ("6. Heading", "6."),
      ("6.1", "6.1"),
      ("3.2.4", "3.2.4"),
      ("§ 1983", "§ 1983"),
    ] {
      let section = filter_entity_false_positives(
        vec![entity(
          full_text,
          marker,
          ADDRESS_LABEL,
          DetectionSource::Trigger,
        )],
        full_text,
        Some(&DenyListFilterData::default()),
      )
      .unwrap();
      assert!(section.is_empty(), "{marker}");
    }

    for (full_text, value) in
      [("123", "123"), ("č.p. 6.", "6."), ("C.P. 28001.", "28001.")]
    {
      let address_number = filter_entity_false_positives(
        vec![entity(
          full_text,
          value,
          ADDRESS_LABEL,
          DetectionSource::Trigger,
        )],
        full_text,
        Some(&DenyListFilterData::default()),
      )
      .unwrap();

      assert_eq!(address_number.len(), 1, "{full_text}");
    }
  }

  #[test]
  fn rejects_numbered_page_footers_without_hiding_numbered_names() {
    let filters = DenyListFilterData {
      page_footer_markers: set([
        "oldal /",
        "oldal összesen",
        "strana",
        "stran celkem",
        "strana celkem",
        "strany celkem",
        "strona łącznie",
      ]),
      ..DenyListFilterData::default()
    };
    let text = "Strana 7 (celkem 7)\rStrany 4 (celkem 9)\r\nStran celkem 9\nStrana 8\nStrona 4 (łącznie 9)\nOldal 1 / 2\nOldal: 1 (összesen: 7)\nStudio 54 (Group 100)\nAcme Industries";
    let entities = filter_entity_false_positives(
      vec![
        entity(
          text,
          "Strana 7",
          ORGANIZATION_LABEL,
          DetectionSource::Trigger,
        ),
        entity(
          text,
          "Strany 4",
          ORGANIZATION_LABEL,
          DetectionSource::Trigger,
        ),
        entity(
          text,
          "Stran celkem 9",
          ORGANIZATION_LABEL,
          DetectionSource::Trigger,
        ),
        entity(
          text,
          "Strana 8",
          ORGANIZATION_LABEL,
          DetectionSource::Trigger,
        ),
        entity(
          text,
          "Strona 4",
          ORGANIZATION_LABEL,
          DetectionSource::Trigger,
        ),
        entity(
          text,
          "Oldal 1",
          ORGANIZATION_LABEL,
          DetectionSource::Trigger,
        ),
        entity(
          text,
          "Oldal: 1",
          ORGANIZATION_LABEL,
          DetectionSource::Trigger,
        ),
        entity(
          text,
          "Studio 54",
          ORGANIZATION_LABEL,
          DetectionSource::Trigger,
        ),
        entity(
          text,
          "Acme Industries",
          ORGANIZATION_LABEL,
          DetectionSource::Trigger,
        ),
      ],
      text,
      Some(&filters),
    )
    .unwrap();

    assert_eq!(entities.len(), 2);
    assert_eq!(entities[0].text, "Studio 54");
    assert_eq!(entities[1].text, "Acme Industries");
  }

  #[test]
  fn keeps_ipv4_addresses_that_resemble_section_numbers() {
    let text = "192.0.2.1";
    let entities = filter_entity_false_positives(
      vec![entity(text, text, IP_ADDRESS_LABEL, DetectionSource::Regex)],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, text);
  }

  fn entity(
    full_text: &str,
    text: &str,
    label: &str,
    source: DetectionSource,
  ) -> PipelineEntity {
    let start = full_text.find(text).expect("entity text is in fixture");
    let end = start.saturating_add(text.len());
    PipelineEntity::detected(
      u32::try_from(start).expect("fixture offset fits u32"),
      u32::try_from(end).expect("fixture offset fits u32"),
      label,
      text,
      0.8,
      source,
    )
  }

  fn set<const N: usize>(values: [&str; N]) -> BTreeSet<String> {
    values.into_iter().map(String::from).collect()
  }

  fn in_name_connectors() -> BTreeSet<String> {
    set([
      "of", "and", "de", "des", "du", "da", "la", "le", "von", "van", "und",
      "&",
    ])
  }

  fn unit_designators() -> BTreeSet<String> {
    set([
      "suite",
      "ste",
      "apt",
      "apartment",
      "unit",
      "floor",
      "fl",
      "bldg",
      "building",
      "room",
      "rm",
      "no",
    ])
  }
}
