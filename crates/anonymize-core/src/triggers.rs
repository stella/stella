use std::collections::{BTreeMap, BTreeSet, HashMap};

use regex::{Regex, RegexBuilder};

use crate::bounded_regex::BoundedRegex;
use crate::byte_offsets::ByteOffsets;
use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::resolution::{DetectionSource, PipelineEntity};
use crate::types::{Error, Result, SearchMatch};
use crate::validators::validate_named_id;

use super::processors::PatternSlice;

const TRIGGER_SCORE: f64 = 0.95;
const MAX_TRIGGER_VALUE_LEN: usize = 100;
const MIN_TRIGGER_PHONE_DIGITS: usize = 5;
const TRIGGER_LOOKAHEAD_MARGIN: usize = 128;
const LINE_TRIGGER_LOOKAHEAD: usize = 2_048;
const MATCH_PATTERN_LOOKAHEAD: usize = 512;
const MAX_IDENTIFIER_VALUE_CHARS: usize = 128;
const MAX_IDENTIFIER_ALPHA_RUN: usize = 12;
/// ASCII and fullwidth colon, the separators form-field labels use.
const FIELD_LABEL_SEPARATORS: [char; 2] = [':', '：'];
pub const PERSON_OR_ORGANIZATION_TRIGGER_LABEL: &str = "person-or-organization";

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct TriggerData {
  pub rules: Vec<TriggerRule>,
  pub address_stop_keywords: Vec<String>,
  pub party_position_terms: Vec<String>,
  pub legal_form_suffixes: Vec<String>,
  #[serde(default)]
  pub post_nominals: Vec<String>,
  pub sentence_terminal_currency_terms: Vec<String>,
  #[serde(default)]
  pub phone_extension_labels: Vec<String>,
  #[serde(default)]
  pub number_markers: Vec<String>,
  #[serde(default)]
  pub number_labels: Vec<String>,
  #[serde(default)]
  pub person_field_labels: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct TriggerRule {
  pub trigger: String,
  pub label: String,
  pub strategy: TriggerStrategy,
  pub validations: Vec<TriggerValidation>,
  pub include_trigger: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub enum TriggerStrategy {
  ToNextComma {
    stop_words: Vec<String>,
    max_length: Option<u32>,
  },
  ToEndOfLine,
  NWords {
    count: u32,
  },
  CompanyIdValue,
  Address {
    max_chars: Option<u32>,
  },
  MatchPattern {
    pattern: String,
    flags: Option<String>,
  },
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub enum TriggerValidation {
  StartsUppercase,
  MinLength(u32),
  MaxLength(u32),
  NoDigits,
  HasDigits,
  MatchesPattern {
    pattern: String,
    flags: Option<String>,
  },
  ValidId {
    validator: String,
  },
}

pub(crate) struct PreparedTriggerData {
  rules: Vec<PreparedTriggerRule>,
  address_stop_keywords: Vec<String>,
  party_position_terms: Vec<String>,
  legal_form_suffixes: Vec<String>,
  post_nominals: Vec<String>,
  sentence_terminal_currency_terms: Vec<String>,
  phone_extension_labels: Vec<String>,
  number_markers: Vec<String>,
  number_labels: Vec<String>,
  person_field_labels: Vec<String>,
}

#[derive(Default)]
struct TriggerRegexCache {
  regex: BTreeMap<TriggerPatternKey, Regex>,
  bounded_regex: BTreeMap<TriggerPatternKey, BoundedRegex>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct TriggerPatternKey {
  pattern: String,
  flags: Option<String>,
}

struct PreparedTriggerRule {
  trigger: String,
  label: String,
  strategy: PreparedTriggerStrategy,
  validations: Vec<PreparedTriggerValidation>,
  include_trigger: bool,
}

struct SuccessfulTriggerCandidate<'a> {
  found: SearchMatch,
  rule: &'a PreparedTriggerRule,
  entity: PipelineEntity,
}

enum PreparedTriggerStrategy {
  ToNextComma {
    stop_words: Vec<String>,
    max_length: Option<usize>,
  },
  ToEndOfLine,
  NWords {
    count: usize,
  },
  CompanyIdValue,
  Address {
    max_chars: Option<usize>,
  },
  MatchPattern {
    regex: BoundedRegex,
  },
}

enum PreparedTriggerValidation {
  StartsUppercase,
  MinLength(usize),
  MaxLength(usize),
  NoDigits,
  HasDigits,
  MatchesPattern { regex: Regex },
  ValidId { validator: String },
}

#[derive(Clone)]
struct ExtractedValue {
  start: u32,
  end: u32,
  text: String,
}

struct TriggerExtractionData<'a> {
  address_stop_keywords: &'a [String],
  party_position_terms: &'a [String],
  post_nominals: &'a [String],
  sentence_terminal_currency_terms: &'a [String],
  phone_extension_labels: &'a [String],
  number_markers: &'a [String],
  number_labels: &'a [String],
}

impl PreparedTriggerData {
  pub(crate) fn new(data: TriggerData) -> Result<Self> {
    let mut regex_cache = TriggerRegexCache::default();
    let rules = data
      .rules
      .into_iter()
      .map(|rule| PreparedTriggerRule::new(rule, &mut regex_cache))
      .collect::<Result<Vec<_>>>()?;
    Ok(Self {
      rules,
      address_stop_keywords: data.address_stop_keywords,
      party_position_terms: data.party_position_terms,
      legal_form_suffixes: data.legal_form_suffixes,
      post_nominals: data
        .post_nominals
        .into_iter()
        .filter(|term| !term.trim().is_empty())
        .collect(),
      sentence_terminal_currency_terms: data
        .sentence_terminal_currency_terms
        .into_iter()
        .filter(|term| !term.is_empty())
        .collect(),
      phone_extension_labels: data
        .phone_extension_labels
        .into_iter()
        .filter(|term| !term.is_empty())
        .collect(),
      number_markers: data
        .number_markers
        .into_iter()
        .filter(|term| !term.is_empty())
        .collect(),
      number_labels: data
        .number_labels
        .into_iter()
        .filter(|term| !term.is_empty())
        .collect(),
      person_field_labels: data
        .person_field_labels
        .into_iter()
        .filter(|term| !term.is_empty())
        .collect(),
    })
  }
}

impl PreparedTriggerRule {
  fn new(
    rule: TriggerRule,
    regex_cache: &mut TriggerRegexCache,
  ) -> Result<Self> {
    Ok(Self {
      trigger: rule.trigger,
      label: rule.label,
      strategy: PreparedTriggerStrategy::new(rule.strategy, regex_cache)?,
      validations: rule
        .validations
        .into_iter()
        .map(|validation| {
          PreparedTriggerValidation::new(validation, regex_cache)
        })
        .collect::<Result<Vec<_>>>()?,
      include_trigger: rule.include_trigger,
    })
  }
}

impl PreparedTriggerStrategy {
  fn new(
    strategy: TriggerStrategy,
    regex_cache: &mut TriggerRegexCache,
  ) -> Result<Self> {
    Ok(match strategy {
      TriggerStrategy::ToNextComma {
        stop_words,
        max_length,
      } => Self::ToNextComma {
        stop_words,
        max_length: max_length.and_then(|value| usize::try_from(value).ok()),
      },
      TriggerStrategy::ToEndOfLine => Self::ToEndOfLine,
      TriggerStrategy::NWords { count } => Self::NWords {
        count: usize::try_from(count).unwrap_or(usize::MAX),
      },
      TriggerStrategy::CompanyIdValue => Self::CompanyIdValue,
      TriggerStrategy::Address { max_chars } => Self::Address {
        max_chars: max_chars.and_then(|value| usize::try_from(value).ok()),
      },
      TriggerStrategy::MatchPattern { pattern, flags } => Self::MatchPattern {
        regex: regex_cache.bounded_regex(format!("^(?:{pattern})"), flags)?,
      },
    })
  }
}

impl PreparedTriggerValidation {
  fn new(
    validation: TriggerValidation,
    regex_cache: &mut TriggerRegexCache,
  ) -> Result<Self> {
    Ok(match validation {
      TriggerValidation::StartsUppercase => Self::StartsUppercase,
      TriggerValidation::MinLength(min) => {
        Self::MinLength(usize::try_from(min).unwrap_or(usize::MAX))
      }
      TriggerValidation::MaxLength(max) => {
        Self::MaxLength(usize::try_from(max).unwrap_or(usize::MAX))
      }
      TriggerValidation::NoDigits => Self::NoDigits,
      TriggerValidation::HasDigits => Self::HasDigits,
      TriggerValidation::MatchesPattern { pattern, flags } => {
        Self::MatchesPattern {
          regex: regex_cache.regex(pattern, flags)?,
        }
      }
      TriggerValidation::ValidId { validator } => Self::ValidId { validator },
    })
  }
}

impl TriggerRegexCache {
  fn regex(&mut self, pattern: String, flags: Option<String>) -> Result<Regex> {
    let key = TriggerPatternKey { pattern, flags };
    if let Some(regex) = self.regex.get(&key) {
      return Ok(regex.clone());
    }

    let regex = build_regex(&key.pattern, key.flags.as_deref())?;
    self.regex.insert(key, regex.clone());
    Ok(regex)
  }

  fn bounded_regex(
    &mut self,
    pattern: String,
    flags: Option<String>,
  ) -> Result<BoundedRegex> {
    let key = TriggerPatternKey { pattern, flags };
    if let Some(regex) = self.bounded_regex.get(&key) {
      return Ok(regex.clone());
    }

    let regex = build_bounded_regex(&key.pattern, key.flags.as_deref())?;
    self.bounded_regex.insert(key, regex.clone());
    Ok(regex)
  }
}

#[allow(clippy::too_many_lines)]
pub(crate) fn process_trigger_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &PreparedTriggerData,
  person_value_labels: &[String],
  title_tokens: &BTreeSet<String>,
  mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
) -> Result<Vec<PipelineEntity>> {
  let offsets = ByteOffsets::new(full_text);
  let mut candidates = Vec::new();
  let extraction_data = TriggerExtractionData {
    address_stop_keywords: &data.address_stop_keywords,
    party_position_terms: &data.party_position_terms,
    post_nominals: &data.post_nominals,
    sentence_terminal_currency_terms: &data.sentence_terminal_currency_terms,
    phone_extension_labels: &data.phone_extension_labels,
    number_markers: &data.number_markers,
    number_labels: &data.number_labels,
  };

  for found in matches {
    let Some(local_index) = slice.local_index(found.pattern()) else {
      continue;
    };
    let Some(rule) = data.rules.get(local_index) else {
      continue;
    };
    if !has_left_boundary(full_text, &offsets, found.start())? {
      record_trigger_rejection(&mut diagnostics, found, rule, "left-boundary");
      continue;
    }
    if !has_right_boundary(full_text, &offsets, found.end(), &rule.trigger)? {
      record_trigger_rejection(&mut diagnostics, found, rule, "right-boundary");
      continue;
    }
    let Some(raw_value) = extract_value(
      full_text,
      &offsets,
      found.end(),
      &rule.strategy,
      &rule.label,
      &extraction_data,
    )?
    else {
      record_trigger_rejection(&mut diagnostics, found, rule, "empty-value");
      continue;
    };
    let Some(mut value) = strip_quotes(&raw_value) else {
      record_trigger_rejection(
        &mut diagnostics,
        found,
        rule,
        "empty-quoted-value",
      );
      continue;
    };
    // A field label at offset 0 (`Name: Jane Roe`) leaves no prefix to keep:
    // the name follows the label, so drop the label and its separator and
    // judge the remainder.
    if rule.label == crate::labels::PERSON_LABEL {
      while let Some(value_start) =
        leading_field_label_value_start(&value.text, person_value_labels)
      {
        let Some(rest) = value.text.get(value_start..).map(str::to_owned)
        else {
          break;
        };
        let Some(offset) = byte_to_offset(value_start) else {
          break;
        };
        value.start = value.start.saturating_add(offset);
        value.text = rest;
      }
      if value.text.is_empty() {
        record_trigger_rejection(
          &mut diagnostics,
          found,
          rule,
          "field-label-value",
        );
        continue;
      }
    }
    // Trailing role triggers (`…, director` / `…, ředitelem`) often sit
    // immediately before the next form field (`IČO: …`, `EIN: …`). Those
    // label-shaped values are not people. Preserve a complete person-shaped
    // prefix when the field label follows it on the same line.
    if rule.label == crate::labels::PERSON_LABEL
      && let Some(label_start) =
        inline_field_label_start(&value.text, &data.person_field_labels)
    {
      let prefix = trim_field_separator(
        value.text.get(..label_start).unwrap_or_default().trim_end(),
      );
      let complete_person_prefix =
        person_name_run_end(prefix) == Some(prefix.len());
      if !complete_person_prefix {
        record_trigger_rejection(
          &mut diagnostics,
          found,
          rule,
          "field-label-value",
        );
        continue;
      }
      value.end = value.start.saturating_add(u32_len(prefix));
      value.text = prefix.to_owned();
    }
    if !apply_validations(&value.text, &rule.validations) {
      record_trigger_rejection(&mut diagnostics, found, rule, "validation");
      continue;
    }
    if rule.label == crate::labels::PHONE_NUMBER_LABEL
      && !is_plausible_phone_trigger_value(&value.text)
    {
      record_trigger_rejection(&mut diagnostics, found, rule, "phone-shape");
      continue;
    }
    if rule.label == crate::labels::PHONE_NUMBER_LABEL
      && char_count(&value.text) > MAX_TRIGGER_VALUE_LEN
    {
      let delimiter_offset =
        skip_trimmed_whitespace(full_text, &offsets, value.end)?;
      if char_at(full_text, &offsets, delimiter_offset)? != Some('\n')
        && char_at(full_text, &offsets, delimiter_offset)? != Some('\t')
      {
        value = cap_phone_value(&value);
      }
    }

    let entity_start = if rule.include_trigger {
      found.start()
    } else {
      value.start
    };
    let mut entity_end = value.end;
    let mut entity_text = offsets.slice(entity_start, entity_end)?;
    let mut label = if (rule.label == crate::labels::PERSON_LABEL
      && has_known_legal_form_suffix(&entity_text, &data.legal_form_suffixes))
      || rule.label == PERSON_OR_ORGANIZATION_TRIGGER_LABEL
    {
      String::from(crate::labels::ORGANIZATION_LABEL)
    } else {
      rule.label.clone()
    };

    if rule.label == PERSON_OR_ORGANIZATION_TRIGGER_LABEL
      && !has_known_legal_form_suffix(&entity_text, &data.legal_form_suffixes)
      && let Some(end) =
        organization_value_person_span_end(&value.text, title_tokens)
      && let Some(head) = value.text.get(..end)
    {
      label = String::from(crate::labels::PERSON_LABEL);
      if end < value.text.len() {
        entity_end = value.start.saturating_add(u32_len(head));
        entity_text = offsets.slice(entity_start, entity_end)?;
      }
    }

    if label == crate::labels::PERSON_LABEL
      && let Some(end) = person_name_run_end(&value.text)
      && end < value.text.len()
      && let Some(head) = value.text.get(..end)
    {
      entity_end = value.start.saturating_add(u32_len(head));
      entity_text = offsets.slice(entity_start, entity_end)?;
    }

    if label.is_empty() {
      label.clone_from(&rule.label);
    }
    candidates.push(SuccessfulTriggerCandidate {
      found: *found,
      rule,
      entity: PipelineEntity::detected(
        entity_start,
        entity_end,
        label,
        entity_text,
        TRIGGER_SCORE,
        DetectionSource::Trigger,
      ),
    });
  }

  // Several configured field grammars intentionally share a start
  // (`passport number` and `passport number is`). A successful longer rule
  // owns that field grammar for its label, but a boundary-valid rule that
  // cannot extract or validate a value must leave the shorter fallback
  // available. Distinct labels and equal-length alternatives remain available.
  let mut maximum_successful_end_by_start_and_label =
    HashMap::<(u32, String), u32>::new();
  for candidate in &candidates {
    maximum_successful_end_by_start_and_label
      .entry((candidate.found.start(), candidate.entity.label.clone()))
      .and_modify(|end| *end = (*end).max(candidate.found.end()))
      .or_insert_with(|| candidate.found.end());
  }

  let mut results = Vec::with_capacity(candidates.len());
  for candidate in candidates {
    if maximum_successful_end_by_start_and_label
      .get(&(candidate.found.start(), candidate.entity.label.clone()))
      .is_some_and(|maximum_end| candidate.found.end() < *maximum_end)
    {
      record_trigger_rejection(
        &mut diagnostics,
        &candidate.found,
        candidate.rule,
        "shorter-same-start-trigger",
      );
      continue;
    }
    results.push(candidate.entity);
  }

  Ok(results)
}

fn trim_field_separator(text: &str) -> &str {
  text
    .trim_end_matches(['-', '–', '—', '/', '|', ';'])
    .trim_end()
}

fn record_trigger_rejection(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  found: &SearchMatch,
  rule: &PreparedTriggerRule,
  reason: &'static str,
) {
  let Some(diagnostics) = diagnostics.as_deref_mut() else {
    return;
  };
  diagnostics.record_rejection(
    DiagnosticStage::EntityTrigger,
    Some(found.pattern()),
    Some(&rule.label),
    Some(found.start()),
    Some(found.end()),
    reason,
  );
}

fn extract_value(
  text: &str,
  offsets: &ByteOffsets<'_>,
  trigger_end: u32,
  strategy: &PreparedTriggerStrategy,
  label: &str,
  data: &TriggerExtractionData<'_>,
) -> Result<Option<ExtractedValue>> {
  let trigger_end_byte = offsets.validate_offset(trigger_end)?;
  let lookahead = get_trigger_lookahead(strategy);
  let lookahead_end_offset = offsets.offset_after_utf16_units(
    trigger_end,
    u32::try_from(lookahead).unwrap_or(u32::MAX),
  )?;
  let lookahead_end = offsets.validate_offset(lookahead_end_offset)?;
  let remaining = text
    .get(trigger_end_byte..lookahead_end)
    .unwrap_or_default();
  let stripped = remaining.trim_start_matches(|ch: char| {
    ch.is_whitespace() || matches!(ch, ':' | ';' | '#' | '=')
  });
  let trimmed_offset = remaining.len().saturating_sub(stripped.len());
  let value_start_byte = trigger_end_byte.saturating_add(trimmed_offset);
  if stripped.is_empty() {
    return Ok(None);
  }

  let extracted = match strategy {
    PreparedTriggerStrategy::ToNextComma {
      stop_words,
      max_length,
    } => {
      // An uncapped scan that consumes the whole lookahead window while
      // more text exists beyond it never found its structural delimiter:
      // the "value" would be an arbitrary window-sized prefix and the tail
      // would stay unredacted while looking covered. Fail closed instead
      // of emitting the truncated span. When the window already reaches
      // the end of the text, running off it is a legitimate end-of-input
      // value and is kept.
      //
      // The scanner receives the full text tail and treats the window
      // purely as a consumption limit, so every delimiter form — single
      // characters, multi-character stop words (anchored at or straddling
      // the edge), sentence terminators — keeps its normal lookahead even
      // at the window boundary; see `extract_to_next_comma`.
      let tail = text.get(value_start_byte..).unwrap_or(stripped);
      let scan_limit = lookahead_end.saturating_sub(value_start_byte);
      extract_to_next_comma(&ToNextCommaScanArgs {
        value_text: tail,
        scan_limit,
        value_start_byte,
        label,
        stop_words,
        length_cap: *max_length,
        post_nominals: data.post_nominals,
        sentence_terminal_currency_terms: data.sentence_terminal_currency_terms,
      })
      .and_then(|scan| {
        if scan.hit_window_end && max_length.is_none() {
          return None;
        }
        Some(scan.value)
      })
    }
    PreparedTriggerStrategy::ToEndOfLine => extract_to_end_of_line(
      remaining,
      stripped,
      value_start_byte,
      label,
      data.phone_extension_labels,
    ),
    PreparedTriggerStrategy::NWords { count } => extract_n_words(
      stripped,
      value_start_byte,
      *count,
      label,
      data.number_markers,
    ),
    PreparedTriggerStrategy::CompanyIdValue => {
      extract_company_id_value(text, trigger_end_byte, data.number_labels)
    }
    PreparedTriggerStrategy::Address { max_chars } => extract_address(
      stripped,
      value_start_byte,
      max_chars.unwrap_or(120),
      data.address_stop_keywords,
      data.party_position_terms,
      data.sentence_terminal_currency_terms,
    ),
    PreparedTriggerStrategy::MatchPattern { regex } => {
      extract_match_pattern(stripped, value_start_byte, regex)?
    }
  };
  Ok(extracted.and_then(|value| byte_value_to_offsets(text, offsets, value)))
}

/// A `to-next-comma` scan result: the extracted value plus whether the
/// scan was truncated by the lookahead window — it reached the window
/// limit with more text beyond and no structural delimiter (comma,
/// newline, bracket, sentence terminator, stop word) anchored exactly at
/// the limit. The caller fails closed on truncation for uncapped rules.
struct ToNextCommaScan {
  value: ByteValue,
  hit_window_end: bool,
}

/// Inputs for [`extract_to_next_comma`].
struct ToNextCommaScanArgs<'a> {
  /// The full text tail from the value start — deliberately *not* clipped
  /// to the lookahead window, so every delimiter check keeps its normal
  /// lookahead (and one byte of look-behind for stop-word boundaries) even
  /// at the window edge.
  value_text: &'a str,
  /// Maximum bytes of `value_text` the value may consume (the lookahead
  /// window). Delimiter checks may read past it; the value itself may only
  /// exceed it by an in-flight skip (decimal comma, post-nominal), which
  /// then still counts as window truncation when more text follows.
  scan_limit: usize,
  value_start_byte: usize,
  label: &'a str,
  stop_words: &'a [String],
  length_cap: Option<usize>,
  post_nominals: &'a [String],
  sentence_terminal_currency_terms: &'a [String],
}

/// One scan decision at a byte position: end the value before this
/// position, or advance by a number of bytes. `None` means the position is
/// past the end of the text.
enum ScanStep {
  Stop,
  /// Consume this many additional bytes of soft-wrapped continuation,
  /// then stop. Structurally a stop: the delimiter was found, and only a
  /// bounded, fully scanned continuation run joins the value.
  StopAfter(usize),
  Advance(usize),
}

/// Advances past whitespace that `byte_value` would trim from the end of
/// the emitted value anyway. Never crosses `\n`, `\r`, or `\t` — those are
/// structural stops in their own right and must stay visible to
/// `scan_step`.
/// The walk is bounded by `LINE_TRIGGER_LOOKAHEAD` additional bytes so the
/// padding probe cannot turn the fixed per-trigger lookahead into a
/// full-tail scan on a crafted document with enormous same-line space
/// runs. A padding run longer than a whole extra lookahead window never
/// occurs in a real value-plus-delimiter shape; when the bound is
/// exhausted the caller's `scan_step` lands on whitespace, reads it as
/// value content, and the scan fails closed as clipped — preserving the
/// clipping invariant for every realistic input.
fn skip_trimmable_padding(value_text: &str, start: usize) -> usize {
  let limit = start.saturating_add(LINE_TRIGGER_LOOKAHEAD);
  let mut end = start;
  while end < limit {
    let Some((ch, len)) = char_at_byte(value_text, end) else {
      break;
    };
    if !ch.is_whitespace() || matches!(ch, '\n' | '\r' | '\t') {
      break;
    }
    end = end.saturating_add(len);
  }
  end
}

/// Scans a soft-wrapped continuation after a newline: one run of
/// capitalized words (separated by spaces or tabs) on the following line.
/// Returns the byte end of the run, or `None` when the next line does not
/// start with a capitalized word (blank lines and lowercase prose keep
/// the newline as a plain stop). The walk is bounded by
/// `LINE_TRIGGER_LOOKAHEAD` additional bytes for the same reason as
/// `skip_trimmable_padding`; a run that exhausts the bound is not
/// absorbed at all, so a crafted continuation line cannot extend the
/// value past one extra lookahead window.
fn take_soft_wrapped_capitalized_run(text: &str, from: usize) -> Option<usize> {
  let limit = from.saturating_add(LINE_TRIGGER_LOOKAHEAD);
  let mut cursor = from;
  let mut consumed_word = false;
  loop {
    while let Some((ch, len)) = char_at_byte(text, cursor) {
      if cursor >= limit {
        return None;
      }
      if ch == ' ' || ch == '\t' {
        cursor = cursor.saturating_add(len);
        continue;
      }
      break;
    }
    let Some((ch, _)) = char_at_byte(text, cursor) else {
      break;
    };
    if ch == '\n' || !ch.is_uppercase() {
      break;
    }
    let word_start = cursor;
    while let Some((next, len)) = char_at_byte(text, cursor) {
      if cursor >= limit {
        return None;
      }
      if next.is_alphabetic() {
        cursor = cursor.saturating_add(len);
        continue;
      }
      break;
    }
    if cursor == word_start {
      break;
    }
    consumed_word = true;
  }
  consumed_word.then_some(cursor)
}

fn scan_step(
  value_text: &str,
  end: usize,
  label: &str,
  stop_words: &[String],
  post_nominals: &[String],
  sentence_terminal_currency_terms: &[String],
) -> Option<ScanStep> {
  let (ch, len) = char_at_byte(value_text, end)?;
  // '\r' stops alongside '\n': mid-text a CR is either followed by an LF
  // (which stopped anyway, with the CR trimmed as trailing whitespace) or
  // is itself a legacy line break; treating it as a stop keeps a CRLF at
  // the window edge from looking like ordinary clipped content.
  if matches!(ch, '\n' | '\r' | '(' | ')' | '[' | ']' | '\t' | ';') {
    // EDGAR HTML exhibits often wrap mid-phrase ("State of New\nYork").
    // For address values, absorb one soft-wrapped capitalized run and
    // then stop, so following lowercase prose ("are authorized") is not
    // captured. Blank lines still terminate: the character after the
    // newline is another newline, which is not a capitalized word.
    if ch == '\n'
      && label == crate::labels::ADDRESS_LABEL
      && let Some(wrapped_end) =
        take_soft_wrapped_capitalized_run(value_text, end.saturating_add(len))
    {
      return Some(ScanStep::StopAfter(wrapped_end.saturating_sub(end)));
    }
    return Some(ScanStep::Stop);
  }
  if ch == '.'
    && is_sentence_terminator(value_text, end, sentence_terminal_currency_terms)
  {
    return Some(ScanStep::Stop);
  }
  if hits_stop_word(value_text, end, stop_words) {
    return Some(ScanStep::Stop);
  }
  if ch == ',' {
    let after = value_text.get(end..).unwrap_or_default();
    if is_decimal_comma(after) {
      return Some(ScanStep::Advance(len));
    }
    if label == crate::labels::PERSON_LABEL
      && let Some(skip) = post_nominal_len(after, post_nominals)
    {
      return Some(ScanStep::Advance(skip));
    }
    return Some(ScanStep::Stop);
  }
  Some(ScanStep::Advance(len))
}

fn extract_to_next_comma(
  args: &ToNextCommaScanArgs<'_>,
) -> Option<ToNextCommaScan> {
  let ToNextCommaScanArgs {
    value_text,
    scan_limit,
    value_start_byte,
    label,
    stop_words,
    length_cap,
    post_nominals,
    sentence_terminal_currency_terms,
  } = *args;
  let limit = scan_limit.min(value_text.len());
  let mut end = 0;
  let mut stopped = false;
  while end < limit {
    match scan_step(
      value_text,
      end,
      label,
      stop_words,
      post_nominals,
      sentence_terminal_currency_terms,
    ) {
      None => break,
      Some(ScanStep::Stop) => {
        stopped = true;
        break;
      }
      Some(ScanStep::StopAfter(step)) => {
        end = end.saturating_add(step);
        stopped = true;
        break;
      }
      Some(ScanStep::Advance(step)) => {
        end = end.saturating_add(step.max(1));
      }
    }
  }
  // The clipping invariant: the scan is clipped only if terminating it
  // would require consuming additional *value* content — non-trimmable,
  // non-delimiter characters — beyond the limit. Trailing trim-able
  // padding (whitespace `byte_value` strips from the emitted value
  // regardless) is walked through first, exactly as it would be consumed
  // mid-window, and the same `scan_step` used inside the loop then decides
  // at the first non-padding position: a delimiter, stop word, or end of
  // text there terminates the value identically to mid-window behavior,
  // while real value content past the limit fails closed. Nothing walked
  // here can reach the emitted value, because it is all trailing
  // whitespace. A soft-wrap continuation (`StopAfter`) anchored at the
  // limit is real value content beyond the window, so it also fails
  // closed rather than counting as a plain stop.
  let hit_window_end = if stopped {
    false
  } else {
    end = skip_trimmable_padding(value_text, end);
    end < value_text.len()
      && !matches!(
        scan_step(
          value_text,
          end,
          label,
          stop_words,
          post_nominals,
          sentence_terminal_currency_terms,
        ),
        Some(ScanStep::Stop)
      )
  };
  if let Some(cap) = length_cap
    && prefix_char_count(value_text, end) > cap
  {
    end = cap_at_word_boundary(value_text, cap);
  }
  byte_value(value_text, value_start_byte, end).map(|value| ToNextCommaScan {
    value,
    hit_window_end,
  })
}

fn extract_to_end_of_line(
  remaining: &str,
  value_text: &str,
  value_start_byte: usize,
  label: &str,
  phone_extension_labels: &[String],
) -> Option<ByteValue> {
  let consumed = remaining.len().saturating_sub(value_text.len());
  if consumed > 0 && remaining.get(..consumed)?.contains('\n') {
    return None;
  }
  let mut end = value_text.len();
  let mut found_line_stop = false;
  for ch in ['\n', '\t'] {
    if let Some(index) = value_text.find(ch)
      && index < end
    {
      end = index;
      found_line_stop = true;
    }
  }
  if label == crate::labels::PHONE_NUMBER_LABEL
    && let Some(shape_end) =
      phone_shape_end(value_text.get(..end)?, phone_extension_labels)
    && shape_end < end
  {
    end = shape_end.min(MAX_TRIGGER_VALUE_LEN);
    found_line_stop = true;
  }
  if !found_line_stop {
    end = cap_at_word_boundary(value_text, end.min(MAX_TRIGGER_VALUE_LEN));
  }
  byte_value(value_text, value_start_byte, end)
}

fn extract_n_words(
  value_text: &str,
  value_start_byte: usize,
  count: usize,
  _label: &str,
  number_markers: &[String],
) -> Option<ByteValue> {
  let cell_end = value_text.find('\t').unwrap_or(value_text.len());
  let cell = value_text.get(..cell_end)?;
  let mut words = Vec::<WordToken<'_>>::new();
  for word in cell.split_whitespace() {
    if punctuation_only(word) || number_marker(word, number_markers) {
      continue;
    }
    let search_pos = words.last().map_or(0, |entry| entry.end);
    let relative = cell.get(search_pos..)?.find(word)?;
    let start = search_pos.saturating_add(relative);
    words.push(WordToken {
      _text: word,
      start,
      end: start.saturating_add(word.len()),
    });
    if words.len() >= count {
      break;
    }
  }
  let first = words.first().copied()?;
  let last = words.last().copied()?;
  byte_value(
    cell.get(first.start..last.end)?,
    value_start_byte.saturating_add(first.start),
    last.end.saturating_sub(first.start),
  )
}

#[derive(Clone, Copy)]
struct WordToken<'a> {
  _text: &'a str,
  start: usize,
  end: usize,
}

fn extract_company_id_value(
  text: &str,
  trigger_end_byte: usize,
  number_labels: &[String],
) -> Option<ByteValue> {
  let raw = text.get(trigger_end_byte..)?;
  let trigger_last = text.get(..trigger_end_byte)?.chars().next_back();
  let allow_empty_sep = matches!(trigger_last, Some('°' | 'º' | '№' | '#'));
  let sep_len = separator_len(raw, allow_empty_sep)?;
  let mut after_sep = raw.get(sep_len..)?;
  let mut label_offset = 0;
  if let Some(len) = number_label_len(after_sep, number_labels) {
    label_offset = len;
    after_sep = after_sep.get(len..)?;
  }
  let id_raw = id_value_prefix(after_sep)?;
  let id_text = id_raw.trim().trim_end_matches(|ch: char| {
    matches!(ch, '.' | ',' | ';' | ':' | '!' | '?')
  });
  if id_text.is_empty() {
    return None;
  }
  let leading = id_raw.len().saturating_sub(id_raw.trim_start().len());
  Some(ByteValue {
    start_byte: trigger_end_byte
      .saturating_add(sep_len)
      .saturating_add(label_offset)
      .saturating_add(leading),
    end_byte: trigger_end_byte
      .saturating_add(sep_len)
      .saturating_add(label_offset)
      .saturating_add(leading)
      .saturating_add(id_text.len()),
  })
}

fn extract_address(
  mut value_text: &str,
  mut value_start_byte: usize,
  max_len: usize,
  stop_keywords: &[String],
  party_position_terms: &[String],
  sentence_terminal_currency_terms: &[String],
) -> Option<ByteValue> {
  if let Some(trimmed) =
    trim_leading_party_position(value_text, party_position_terms)
  {
    value_start_byte = value_start_byte.saturating_add(trimmed);
    value_text = value_text.get(trimmed..)?;
  }

  let mut end = 0;
  while end < value_text.len() && prefix_char_count(value_text, end) < max_len {
    let Some((ch, len)) = char_at_byte(value_text, end) else {
      break;
    };
    if matches!(ch, '\n' | '(') {
      break;
    }
    if matches!(ch, ' ' | '\t')
      && address_stop_hit(value_text.get(end..)?.trim_start(), stop_keywords)
    {
      break;
    }
    if ch == '.' {
      let after_period = value_text.get(end.saturating_add(len)..)?;
      if address_stop_hit(after_period.trim_start(), stop_keywords) {
        break;
      }
      if let Some((next, _)) = char_at_byte(value_text, end.saturating_add(len))
        && (next.is_alphabetic() || next.is_ascii_digit())
      {
        end = end.saturating_add(len);
        continue;
      }
      if value_text
        .get(end.saturating_add(len)..)
        .is_some_and(|tail| {
          tail.starts_with(' ')
            && tail.trim_start().chars().next().is_some_and(|next_ch| {
              next_ch.is_alphabetic() || next_ch.is_ascii_digit()
            })
        })
        && !is_sentence_terminator(
          value_text,
          end,
          sentence_terminal_currency_terms,
        )
      {
        end = end.saturating_add(len);
        continue;
      }
      break;
    }
    if ch == ',' {
      let after = value_text.get(end.saturating_add(len)..)?.trim_start();
      if address_stop_hit(after, stop_keywords) {
        break;
      }
      if after.chars().next().is_some_and(|next_ch| {
        next_ch.is_ascii_digit() || next_ch.is_uppercase()
      }) {
        end = end.saturating_add(len);
        continue;
      }
      break;
    }
    end = end.saturating_add(len);
  }
  if prefix_char_count(value_text, end) >= max_len
    && let Some(last_space) = value_text.get(..end)?.rfind(' ')
    && last_space > 0
  {
    end = last_space;
  }
  byte_value(value_text, value_start_byte, end)
}

fn extract_match_pattern(
  value_text: &str,
  value_start_byte: usize,
  regex: &BoundedRegex,
) -> Result<Option<ByteValue>> {
  let line = value_text
    .split_once('\n')
    .map_or(value_text, |(head, _)| head);
  // A backtrack-budget failure propagates as a typed error rather than
  // reading as "no match": silently dropping the trigger would report a
  // successful redaction while the triggered value stayed uncovered.
  let Some(found) = regex.find(line)? else {
    return Ok(None);
  };
  if found.start != 0 || found.is_empty() {
    return Ok(None);
  }
  Ok(Some(ByteValue {
    start_byte: value_start_byte.saturating_add(found.start),
    end_byte: value_start_byte.saturating_add(found.end),
  }))
}

#[derive(Clone, Copy)]
struct ByteValue {
  start_byte: usize,
  end_byte: usize,
}

fn byte_value(
  value_text: &str,
  value_start_byte: usize,
  end: usize,
) -> Option<ByteValue> {
  let raw = value_text.get(..end)?;
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return None;
  }
  let leading = raw.len().saturating_sub(raw.trim_start().len());
  let trailing = raw.len().saturating_sub(raw.trim_end().len());
  Some(ByteValue {
    start_byte: value_start_byte.saturating_add(leading),
    end_byte: value_start_byte
      .saturating_add(end)
      .saturating_sub(trailing),
  })
}

fn byte_value_to_offsets(
  full_text: &str,
  _offsets: &ByteOffsets<'_>,
  value: ByteValue,
) -> Option<ExtractedValue> {
  if !full_text.is_char_boundary(value.start_byte)
    || !full_text.is_char_boundary(value.end_byte)
  {
    return None;
  }
  Some(ExtractedValue {
    start: byte_to_offset(value.start_byte)?,
    end: byte_to_offset(value.end_byte)?,
    text: full_text.get(value.start_byte..value.end_byte)?.to_owned(),
  })
}

fn strip_quotes(value: &ExtractedValue) -> Option<ExtractedValue> {
  let leading = value.text.len().saturating_sub(
    value
      .text
      .trim_start_matches(|ch: char| {
        ch.is_whitespace()
          || matches!(ch, '„' | '"' | '»' | '«' | '\'' | '(' | ')')
      })
      .len(),
  );
  let stripped = value.text.get(leading..)?.trim_end_matches(|ch: char| {
    ch.is_whitespace() || matches!(ch, '"' | '»' | '«' | '\'' | '(' | ')')
  });
  if stripped.is_empty() {
    return None;
  }
  Some(ExtractedValue {
    start: value
      .start
      .saturating_add(u32_len(value.text.get(..leading)?)),
    end: value
      .start
      .saturating_add(u32_len(value.text.get(..leading)?))
      .saturating_add(u32_len(stripped)),
    text: stripped.to_owned(),
  })
}

fn apply_validations(
  text: &str,
  validations: &[PreparedTriggerValidation],
) -> bool {
  let text_len = text.chars().count();
  validations.iter().all(|validation| match validation {
    PreparedTriggerValidation::StartsUppercase => {
      text.chars().next().is_some_and(char::is_uppercase)
    }
    PreparedTriggerValidation::MinLength(min) => text_len >= *min,
    PreparedTriggerValidation::MaxLength(max) => text_len <= *max,
    PreparedTriggerValidation::NoDigits => {
      !text.chars().any(|ch| ch.is_ascii_digit())
    }
    PreparedTriggerValidation::HasDigits => {
      text.chars().any(|ch| ch.is_ascii_digit())
    }
    PreparedTriggerValidation::MatchesPattern { regex } => regex.is_match(text),
    PreparedTriggerValidation::ValidId { validator } => {
      validate_named_id(validator, text)
    }
  })
}

fn build_regex(pattern: &str, flags: Option<&str>) -> Result<Regex> {
  let mut builder = RegexBuilder::new(pattern);
  if flags.is_some_and(|flags| flags.contains('i')) {
    builder.case_insensitive(true);
  }
  builder.build().map_err(|error| Error::Search {
    engine: crate::types::SearchEngine::Regex,
    reason: error.to_string(),
  })
}

fn build_bounded_regex(
  pattern: &str,
  flags: Option<&str>,
) -> Result<BoundedRegex> {
  let source = if flags.is_some_and(|flags| flags.contains('i')) {
    format!("(?i:{pattern})")
  } else {
    pattern.to_owned()
  };
  BoundedRegex::new(&source)
}

fn get_trigger_lookahead(strategy: &PreparedTriggerStrategy) -> usize {
  match strategy {
    // No configured cap: scan a full line so the structural stop
    // conditions (comma, hard-stop char, newline) can find the real end
    // of a long value instead of being cut short by the lookahead.
    PreparedTriggerStrategy::ToNextComma {
      max_length: None, ..
    }
    | PreparedTriggerStrategy::ToEndOfLine => LINE_TRIGGER_LOOKAHEAD,
    PreparedTriggerStrategy::ToNextComma {
      max_length: Some(max),
      ..
    } => max.saturating_add(TRIGGER_LOOKAHEAD_MARGIN),
    PreparedTriggerStrategy::NWords { count } => count
      .saturating_mul(64)
      .saturating_add(TRIGGER_LOOKAHEAD_MARGIN),
    PreparedTriggerStrategy::CompanyIdValue => 256,
    PreparedTriggerStrategy::Address { max_chars } => max_chars
      .unwrap_or(120)
      .saturating_add(TRIGGER_LOOKAHEAD_MARGIN),
    PreparedTriggerStrategy::MatchPattern { .. } => MATCH_PATTERN_LOOKAHEAD,
  }
}

fn has_left_boundary(
  text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
) -> Result<bool> {
  if start == 0 {
    return Ok(true);
  }
  let byte = offsets.validate_offset(start)?;
  Ok(
    !text
      .get(..byte)
      .and_then(|prefix| prefix.chars().next_back())
      .is_some_and(char::is_alphabetic),
  )
}

fn has_right_boundary(
  text: &str,
  offsets: &ByteOffsets<'_>,
  end: u32,
  trigger: &str,
) -> Result<bool> {
  let Some(last) = trigger.chars().next_back() else {
    return Ok(false);
  };
  if !last.is_alphabetic() {
    return Ok(true);
  }
  let byte = offsets.validate_offset(end)?;
  Ok(
    !text
      .get(byte..)
      .and_then(|suffix| suffix.chars().next())
      .is_some_and(char::is_alphabetic),
  )
}

fn char_at(
  text: &str,
  offsets: &ByteOffsets<'_>,
  offset: u32,
) -> Result<Option<char>> {
  let byte = offsets.validate_offset(offset)?;
  Ok(text.get(byte..).and_then(|suffix| suffix.chars().next()))
}

/// Advances past whitespace that extraction already trimmed off the value
/// (e.g. trailing spaces before a line/tab delimiter), so delimiter checks
/// against `value.end` see the real next structural character instead of
/// the trimmed padding. Never skips `\n`/`\t` themselves, since those are
/// the delimiters callers check for.
fn skip_trimmed_whitespace(
  text: &str,
  offsets: &ByteOffsets<'_>,
  offset: u32,
) -> Result<u32> {
  let byte = offsets.validate_offset(offset)?;
  let Some(suffix) = text.get(byte..) else {
    return Ok(offset);
  };
  let trimmed = suffix.trim_start_matches(|ch: char| {
    ch.is_whitespace() && !matches!(ch, '\n' | '\t')
  });
  let skipped = suffix.len().saturating_sub(trimmed.len());
  Ok(offset.saturating_add(u32::try_from(skipped).unwrap_or(u32::MAX)))
}

fn char_at_byte(text: &str, byte: usize) -> Option<(char, usize)> {
  text
    .get(byte..)
    .and_then(|tail| tail.chars().next())
    .map(|ch| (ch, ch.len_utf8()))
}

fn cap_at_word_boundary(value_text: &str, cap: usize) -> usize {
  let mut capped = byte_index_after_chars(value_text, cap);
  while capped > 0
    && previous_char_is_word(value_text, capped)
    && is_word_byte(value_text, capped)
  {
    capped = previous_char_boundary(value_text, capped);
  }
  capped
}

fn byte_index_after_chars(value_text: &str, count: usize) -> usize {
  value_text
    .char_indices()
    .nth(count)
    .map_or(value_text.len(), |(index, _)| index)
}

fn prefix_char_count(value_text: &str, end: usize) -> usize {
  value_text
    .get(..end)
    .map_or(usize::MAX, |prefix| prefix.chars().count())
}

fn char_count(value_text: &str) -> usize {
  value_text.chars().count()
}

fn previous_char_is_word(text: &str, byte: usize) -> bool {
  text
    .get(..byte)
    .and_then(|prefix| prefix.chars().next_back())
    .is_some_and(char::is_alphanumeric)
}

fn previous_char_boundary(text: &str, byte: usize) -> usize {
  text
    .get(..byte)
    .and_then(|prefix| prefix.char_indices().next_back())
    .map_or(0, |(index, _)| index)
}

fn is_word_byte(text: &str, byte: usize) -> bool {
  text
    .get(byte..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(char::is_alphanumeric)
}

fn hits_stop_word(text: &str, byte: usize, stop_words: &[String]) -> bool {
  if stop_words.is_empty() {
    return false;
  }
  if byte > 0 && is_word_byte(text, byte.saturating_sub(1)) {
    return false;
  }
  let Some(tail) = text.get(byte..) else {
    return false;
  };
  stop_words.iter().any(|word| {
    unicode_case_prefix_len(tail, word).is_some_and(|word_len| {
      tail
        .get(word_len..)
        .and_then(|after| after.chars().next())
        .is_none_or(|ch| !ch.is_alphanumeric())
    })
  })
}

fn unicode_case_prefix_len(text: &str, prefix: &str) -> Option<usize> {
  if prefix.is_empty() {
    return None;
  }
  let prefix_chars = prefix.chars().count();
  let mut end = 0usize;
  let mut count = 0usize;
  for (index, ch) in text.char_indices() {
    if count == prefix_chars {
      break;
    }
    count = count.saturating_add(1);
    end = index.saturating_add(ch.len_utf8());
  }
  if count != prefix_chars {
    return None;
  }
  let candidate = text.get(..end)?;
  (candidate.to_lowercase() == prefix.to_lowercase()).then_some(end)
}

fn is_decimal_comma(text: &str) -> bool {
  let mut chars = text.chars();
  if chars.next() != Some(',') {
    return false;
  }
  chars
    .next()
    .is_some_and(|ch| ch.is_ascii_digit() || matches!(ch, '-' | '–' | '—'))
}

fn post_nominal_len(text: &str, post_nominals: &[String]) -> Option<usize> {
  let trimmed = text.strip_prefix(',')?.trim_start();
  let len_before = text.len().saturating_sub(trimmed.len());
  post_nominals
    .iter()
    .filter_map(|term| post_nominal_prefix_len(trimmed, term))
    .max()
    .map(|term_len| len_before.saturating_add(term_len))
}

fn post_nominal_prefix_len(text: &str, term: &str) -> Option<usize> {
  let mut text_index = 0usize;
  for expected in term.chars() {
    if expected == '.' {
      let next = text.get(text_index..)?.chars().next()?;
      if next != '.' {
        return None;
      }
      text_index = text_index.saturating_add(next.len_utf8());
      let rest = text.get(text_index..)?;
      text_index = text_index
        .saturating_add(rest.len().saturating_sub(rest.trim_start().len()));
      continue;
    }

    let next = text.get(text_index..)?.chars().next()?;
    if !next.eq_ignore_ascii_case(&expected) {
      return None;
    }
    text_index = text_index.saturating_add(next.len_utf8());
  }

  if text
    .get(text_index..)
    .is_some_and(|tail| tail.starts_with('.'))
  {
    text_index = text_index.saturating_add(1);
  }
  Some(text_index)
}

fn is_sentence_terminator(
  text: &str,
  period_byte: usize,
  sentence_terminal_currency_terms: &[String],
) -> bool {
  let Some(tail) = text.get(period_byte..) else {
    return false;
  };
  if !next_is_sentence_start(tail) {
    return false;
  }
  let head = text.get(..period_byte).unwrap_or_default();
  lowercase_tail_len(head) >= 5
    || currency_tail(head, sentence_terminal_currency_terms)
    || head
      .chars()
      .next_back()
      .is_some_and(|ch| ch.is_ascii_digit())
    || (proper_noun_tail(head) && next_is_real_sentence(tail))
}

fn next_is_sentence_start(tail: &str) -> bool {
  let Some(after_period) = tail.strip_prefix('.') else {
    return false;
  };
  if after_period.trim_start().is_empty() {
    return true;
  }
  if !after_period.starts_with(char::is_whitespace) {
    return false;
  }
  after_period
    .trim_start()
    .chars()
    .next()
    .is_some_and(char::is_uppercase)
}

fn next_is_real_sentence(tail: &str) -> bool {
  let Some(after_period) = tail.strip_prefix('.') else {
    return false;
  };
  if !after_period.starts_with(char::is_whitespace) {
    return false;
  }
  let mut chars = after_period.trim_start().chars();
  chars.next().is_some_and(char::is_uppercase)
    && chars.next().is_some_and(char::is_lowercase)
    && chars.next().is_some_and(char::is_lowercase)
}

fn lowercase_tail_len(text: &str) -> usize {
  text
    .chars()
    .rev()
    .take_while(|ch| ch.is_lowercase())
    .count()
}

fn currency_tail(
  text: &str,
  sentence_terminal_currency_terms: &[String],
) -> bool {
  sentence_terminal_currency_terms
    .iter()
    .any(|term| has_currency_code_tail(text, term))
}

fn has_currency_code_tail(text: &str, code: &str) -> bool {
  let Some(start) = text.len().checked_sub(code.len()) else {
    return false;
  };
  let Some(tail) = text.get(start..) else {
    return false;
  };
  if tail.to_lowercase() != code.to_lowercase() {
    return false;
  }
  text
    .get(..start)
    .and_then(|prefix| prefix.chars().next_back())
    .is_none_or(|ch| !ch.is_alphabetic())
}

fn proper_noun_tail(text: &str) -> bool {
  let mut start = text.len();
  for (index, ch) in text.char_indices().rev() {
    if !ch.is_alphabetic() {
      break;
    }
    start = index;
  }
  let Some(word) = text.get(start..) else {
    return false;
  };
  let mut chars = word.chars();
  if !chars.next().is_some_and(char::is_uppercase) {
    return false;
  }
  if chars.clone().count() < 3 || !chars.all(char::is_lowercase) {
    return false;
  }
  text
    .get(..start)
    .and_then(|prefix| prefix.chars().next_back())
    .is_none_or(|ch| !ch.is_alphabetic() && ch != '.')
}

fn punctuation_only(text: &str) -> bool {
  text.chars().all(|ch| !ch.is_alphanumeric())
}

fn number_marker(text: &str, number_markers: &[String]) -> bool {
  number_markers
    .iter()
    .any(|marker| text.eq_ignore_ascii_case(marker))
}

fn phone_shape_end(
  text: &str,
  phone_extension_labels: &[String],
) -> Option<usize> {
  let mut chars = text.char_indices();
  let (_, first) = chars.next()?;
  if !(first == '+' || first == '(' || first.is_ascii_digit()) {
    return None;
  }
  let mut end = first.len_utf8();
  for (index, ch) in chars {
    if ch == '.'
      && text
        .get(index.saturating_add(ch.len_utf8())..)
        .is_some_and(|tail| {
          tail.starts_with(char::is_whitespace)
            && !dot_space_precedes_phone_digits(tail)
        })
    {
      break;
    }
    if ch.is_ascii_digit()
      || ch.is_whitespace()
      || matches!(ch, '(' | ')' | '.' | '/' | '-' | '–' | '—' | '‑')
    {
      end = index.saturating_add(ch.len_utf8());
      continue;
    }
    break;
  }
  while end > 0
    && text
      .get(..end)
      .and_then(|head| head.chars().next_back())
      .is_some_and(|ch| !ch.is_ascii_digit())
  {
    end = end.saturating_sub(next_len_backward(text, end));
  }
  if let Some(extension_len) = text
    .get(end..)
    .and_then(|tail| phone_extension_suffix_len(tail, phone_extension_labels))
  {
    end = end.saturating_add(extension_len);
  }
  (end > 0).then_some(end)
}

/// Reports whether a lookahead past a `.` + whitespace finds a phone digit
/// group, i.e. the dot is a separator inside a number (`"+1. 555"`) rather
/// than a sentence-ending period. A following digit run only counts as a
/// phone group when it is not itself a list ordinal: digits immediately
/// followed by `.` and then a non-digit (`"… 5678. 1. Definitions"`) are a
/// numbered-sentence marker, so the original dot ends the value.
fn dot_space_precedes_phone_digits(after_dot: &str) -> bool {
  let rest = after_dot.trim_start();
  let digit_len = rest
    .char_indices()
    .find(|(_, ch)| !ch.is_ascii_digit())
    .map_or(rest.len(), |(index, _)| index);
  if digit_len == 0 {
    return false;
  }
  let Some(after_marker_dot) = rest
    .get(digit_len..)
    .and_then(|tail| tail.strip_prefix('.'))
  else {
    return true;
  };
  !after_marker_dot
    .trim_start()
    .starts_with(|ch: char| !ch.is_ascii_digit())
}

fn phone_extension_suffix_len(
  text: &str,
  phone_extension_labels: &[String],
) -> Option<usize> {
  let leading = text.len().saturating_sub(text.trim_start().len());
  let trimmed = text.get(leading..)?;
  for label in phone_extension_labels {
    let Some(rest) = ascii_case_prefix_rest(trimmed, label) else {
      continue;
    };
    let (rest, dot_len) = if label.eq_ignore_ascii_case("ext") {
      rest
        .strip_prefix('.')
        .map_or((rest, 0_usize), |after_dot| (after_dot, 1_usize))
    } else {
      (rest, 0_usize)
    };
    let whitespace = rest.len().saturating_sub(rest.trim_start().len());
    let digits = rest.get(whitespace..)?;
    let mut digit_end = 0;
    let mut digit_count = 0_usize;
    for (index, ch) in digits.char_indices() {
      if !ch.is_ascii_digit() || digit_count >= 6 {
        break;
      }
      digit_count = digit_count.saturating_add(1);
      digit_end = index.saturating_add(ch.len_utf8());
    }
    if digit_count > 0 {
      return Some(
        leading
          .saturating_add(label.len())
          .saturating_add(dot_len)
          .saturating_add(whitespace)
          .saturating_add(digit_end),
      );
    }
  }
  None
}

fn ascii_case_prefix_rest<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
  let head = text.get(..prefix.len())?;
  if !head.eq_ignore_ascii_case(prefix) {
    return None;
  }
  text.get(prefix.len()..)
}

fn next_len_backward(text: &str, byte: usize) -> usize {
  text
    .get(..byte)
    .and_then(|head| head.chars().next_back())
    .map_or(1, char::len_utf8)
}

fn is_plausible_phone_trigger_value(value: &str) -> bool {
  let trimmed = value.trim_start();
  if !trimmed
    .chars()
    .next()
    .is_some_and(|ch| ch == '+' || ch == '(' || ch.is_ascii_digit())
  {
    return false;
  }
  if looks_like_iso_date(trimmed) || inline_field_label(trimmed) {
    return false;
  }
  trimmed.chars().filter(char::is_ascii_digit).count()
    >= MIN_TRIGGER_PHONE_DIGITS
}

/// Recognizes `YYYY-MM-DD` and `YYYY/MM/DD` shaped date padding (the
/// separator must be the same character in both positions) so date-shaped
/// text following a phone trigger isn't mistaken for a phone number.
fn looks_like_iso_date(text: &str) -> bool {
  let bytes = text.as_bytes();
  let Some(separator @ (b'-' | b'/')) = bytes.get(4).copied() else {
    return false;
  };
  bytes.len() >= 10
    && bytes
      .get(0..4)
      .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    && bytes.get(7).copied() == Some(separator)
    && bytes
      .get(5..7)
      .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    && bytes
      .get(8..10)
      .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
}

fn inline_field_label(text: &str) -> bool {
  inline_field_label_token_start(text).is_some()
}

fn inline_field_label_start(
  text: &str,
  configured_labels: &[String],
) -> Option<usize> {
  configured_labels
    .iter()
    .filter_map(|label| configured_field_label_start(text, label))
    .min()
}

/// Offset of the value after a configured field label at offset 0
/// (`Name: Jane Roe` gives the offset of `Jane`).
///
/// The longest matching label wins, so `Tax identification number: …` is not
/// truncated to the `Tax id` label.
fn leading_field_label_value_start(
  text: &str,
  configured_labels: &[String],
) -> Option<usize> {
  configured_labels
    .iter()
    .filter(|label| configured_field_label_start(text, label) == Some(0))
    .filter_map(|label| {
      let rest = text
        .get(label.len()..)?
        .trim_start()
        .strip_prefix(FIELD_LABEL_SEPARATORS)?
        .trim_start();
      text.len().checked_sub(rest.len())
    })
    .max()
}

fn configured_field_label_start(text: &str, label: &str) -> Option<usize> {
  if label.is_empty() {
    return None;
  }
  for (start, _) in text.char_indices().take(40) {
    let left_boundary = start == 0
      || text
        .get(..start)
        .and_then(|head| head.chars().next_back())
        .is_some_and(char::is_whitespace);
    if !left_boundary {
      continue;
    }
    let end = start.saturating_add(label.len());
    let Some(candidate) = text.get(start..end) else {
      continue;
    };
    if candidate.to_lowercase() != label.to_lowercase() {
      continue;
    }
    let after = text.get(end..).unwrap_or_default().trim_start();
    if after.starts_with(':') || after.starts_with('：') {
      return Some(start);
    }
  }
  None
}

fn inline_field_label_token_start(text: &str) -> Option<usize> {
  let mut token_start = None;
  let mut token_letters = 0_usize;
  for (index, ch) in text.char_indices().take(40) {
    if matches!(ch, ':' | '：') && token_letters >= 2 {
      return token_start;
    }
    if ch.is_alphabetic() {
      token_start.get_or_insert(index);
      token_letters = token_letters.saturating_add(1);
      continue;
    }
    if ch.is_whitespace() {
      token_start = None;
      token_letters = 0;
      continue;
    }
    if matches!(ch, '/' | '-') && token_start.is_some() {
      continue;
    }
    if token_start.is_some() {
      break;
    }
  }
  None
}

fn cap_phone_value(value: &ExtractedValue) -> ExtractedValue {
  let capped_end = cap_at_word_boundary(&value.text, MAX_TRIGGER_VALUE_LEN)
    .min(MAX_TRIGGER_VALUE_LEN);
  let capped = value.text.get(..capped_end).unwrap_or_default().trim_end();
  ExtractedValue {
    start: value.start,
    end: value.start.saturating_add(u32_len(capped)),
    text: capped.to_owned(),
  }
}

fn trim_leading_party_position(text: &str, terms: &[String]) -> Option<usize> {
  for prefix in terms {
    let prefix_len = prefix.len();
    let Some(head) = text.get(..prefix_len) else {
      continue;
    };
    if head.to_lowercase() != *prefix {
      continue;
    }
    let rest = text.get(prefix_len..)?;
    let ws_len = rest.len().saturating_sub(rest.trim_start().len());
    if ws_len == 0 {
      continue;
    }
    let candidate = rest.get(ws_len..)?;
    if candidate
      .chars()
      .next()
      .is_some_and(|ch| ch.is_uppercase() || ch.is_ascii_digit())
    {
      return Some(prefix_len.saturating_add(ws_len));
    }
  }
  None
}

fn address_stop_hit(text: &str, stop_keywords: &[String]) -> bool {
  let lower = text.to_lowercase();
  stop_keywords.iter().any(|keyword| {
    lower.starts_with(keyword)
      && lower
        .get(keyword.len()..)
        .and_then(|after| after.chars().next())
        .is_none_or(|ch| {
          ch.is_whitespace()
            || matches!(ch, ':' | ';' | ',' | '.' | '!' | '?' | '(' | ')')
            || ch.is_ascii_digit()
        })
  })
}

fn separator_len(raw: &str, allow_empty: bool) -> Option<usize> {
  let trimmed_colon = raw.trim_start();
  let leading = raw.len().saturating_sub(trimmed_colon.len());
  if let Some(after_colon) = trimmed_colon.strip_prefix(':') {
    return Some(
      leading.saturating_add(1).saturating_add(
        after_colon
          .len()
          .saturating_sub(after_colon.trim_start().len()),
      ),
    );
  }
  if leading > 0 || allow_empty {
    return Some(leading);
  }
  None
}

fn number_label_len(text: &str, number_labels: &[String]) -> Option<usize> {
  for label in number_labels {
    let Some(rest) = text.get(label.len()..) else {
      continue;
    };
    if text
      .get(..label.len())
      .is_some_and(|head| head.eq_ignore_ascii_case(label))
      && (rest.starts_with(char::is_whitespace) || rest.starts_with(':'))
    {
      return Some(label.len().saturating_add(separator_len(rest, false)?));
    }
  }
  None
}

fn id_value_prefix(text: &str) -> Option<&str> {
  let bytes = text.as_bytes();
  let mut end = 0_usize;
  let mut chars = 0_usize;
  let mut digits = 0_usize;
  let mut leading_alpha = 0_usize;
  let mut alpha_run = 0_usize;
  let mut max_alpha_run = 0_usize;
  let mut groups = IdentifierGroupState::new();

  while let Some(&byte) = bytes.get(end) {
    if byte.is_ascii_digit() {
      digits = digits.saturating_add(1);
      alpha_run = 0;
      end = end.saturating_add(1);
      chars = chars.saturating_add(1);
      groups.observe_digit();
    } else if byte.is_ascii_alphabetic() {
      if digits == 0 {
        leading_alpha = leading_alpha.saturating_add(1);
      }
      alpha_run = alpha_run.saturating_add(1);
      max_alpha_run = max_alpha_run.max(alpha_run);
      end = end.saturating_add(1);
      chars = chars.saturating_add(1);
      groups.observe_non_digit();
    } else if matches!(byte, b'.' | b'-' | b'/') {
      if end == 0
        || !bytes
          .get(end.saturating_add(1))
          .is_some_and(u8::is_ascii_alphanumeric)
      {
        break;
      }
      alpha_run = 0;
      end = end.saturating_add(1);
      chars = chars.saturating_add(1);
      groups.observe_non_digit();
    } else if matches!(byte, b' ' | b'\t') {
      let (next, continuation) = continuation_after_whitespace(
        bytes,
        end,
        digits,
        leading_alpha,
        &mut groups,
      );
      match continuation {
        IdentifierContinuation::Consume if end > 0 => {}
        IdentifierContinuation::Reject => return None,
        IdentifierContinuation::Consume | IdentifierContinuation::Stop => {
          break;
        }
      }
      chars = chars.saturating_add(next.saturating_sub(end));
      alpha_run = 0;
      end = next;
    } else {
      break;
    }

    if chars > MAX_IDENTIFIER_VALUE_CHARS {
      return None;
    }
  }

  let candidate = text.get(..end)?;
  let clean_boundary = is_clean_identifier_boundary(text.get(end..)?);
  (digits >= 2
    && end >= 5
    && leading_alpha <= MAX_IDENTIFIER_ALPHA_RUN
    && max_alpha_run <= MAX_IDENTIFIER_ALPHA_RUN
    && clean_boundary
    && !single_digit_dotted_prefix(candidate))
  .then_some(candidate)
}

fn is_clean_identifier_boundary(tail: &str) -> bool {
  let mut chars = tail.chars();
  let Some(boundary) = chars.next() else {
    return true;
  };
  if boundary.is_whitespace() {
    return true;
  }
  let token = immediate_boundary_token(chars.as_str());
  match boundary {
    '(' | '[' | '{' | '—' | '―' => {
      !token.is_overlong() && !token.has_numeric() && !token.begins_uppercase()
    }
    '‐' | '‑' | '‒' | '–' => {
      !token.is_overlong() && !token.has_alphanumeric()
    }
    ch if is_identifier_quote(ch) => {
      !token.is_overlong() && !token.has_numeric()
    }
    ch => matches!(
      ch,
      '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}' | '…'
    ),
  }
}

#[derive(Clone, Copy)]
struct ImmediateBoundaryToken {
  evidence: u8,
}

impl ImmediateBoundaryToken {
  const NUMERIC: u8 = 1;
  const ALPHANUMERIC: u8 = 1 << 1;
  const UPPERCASE: u8 = 1 << 2;
  const OVERLONG: u8 = 1 << 3;

  const fn has_numeric(self) -> bool {
    self.evidence & Self::NUMERIC != 0
  }

  const fn has_alphanumeric(self) -> bool {
    self.evidence & Self::ALPHANUMERIC != 0
  }

  const fn begins_uppercase(self) -> bool {
    self.evidence & Self::UPPERCASE != 0
  }

  const fn is_overlong(self) -> bool {
    self.evidence & Self::OVERLONG != 0
  }
}

fn immediate_boundary_token(tail: &str) -> ImmediateBoundaryToken {
  let mut token = ImmediateBoundaryToken { evidence: 0 };
  let mut chars = 0_usize;
  for ch in tail.chars() {
    if ch.is_whitespace() || is_boundary_token_terminator(ch) {
      break;
    }
    if chars >= MAX_IDENTIFIER_VALUE_CHARS {
      token.evidence |= ImmediateBoundaryToken::OVERLONG;
      break;
    }
    if chars == 0 && ch.is_uppercase() {
      token.evidence |= ImmediateBoundaryToken::UPPERCASE;
    }
    if ch.is_numeric() {
      token.evidence |= ImmediateBoundaryToken::NUMERIC;
    }
    if ch.is_alphanumeric() {
      token.evidence |= ImmediateBoundaryToken::ALPHANUMERIC;
    }
    chars = chars.saturating_add(1);
  }
  token
}

const fn is_boundary_token_terminator(ch: char) -> bool {
  matches!(
    ch,
    '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}' | '…'
  ) || is_identifier_quote(ch)
}

const fn is_identifier_quote(ch: char) -> bool {
  matches!(
    ch,
    '\''
      | '"'
      | '‘'
      | '’'
      | '‚'
      | '‛'
      | '“'
      | '”'
      | '„'
      | '‟'
      | '«'
      | '»'
      | '‹'
      | '›'
  )
}

struct IdentifierGroupState {
  completed_numeric: usize,
  chars: usize,
  current_evidence: u8,
  has_structured_digit_prefix: bool,
}

impl IdentifierGroupState {
  const DIGIT: u8 = 1;
  const STRUCTURE: u8 = 1 << 1;

  const fn new() -> Self {
    Self {
      completed_numeric: 0,
      chars: 0,
      current_evidence: 0,
      has_structured_digit_prefix: false,
    }
  }

  const fn observe_digit(&mut self) {
    self.chars = self.chars.saturating_add(1);
    self.current_evidence |= Self::DIGIT;
  }

  const fn observe_non_digit(&mut self) {
    self.chars = self.chars.saturating_add(1);
    self.current_evidence |= Self::STRUCTURE;
  }

  fn complete(&mut self) -> (usize, bool) {
    self.completed_numeric = self.completed_numeric.saturating_add(
      usize::from(self.chars > 0 && self.current_evidence == Self::DIGIT),
    );
    self.has_structured_digit_prefix |=
      self.current_evidence == (Self::DIGIT | Self::STRUCTURE);
    self.chars = 0;
    self.current_evidence = 0;
    (self.completed_numeric, self.has_structured_digit_prefix)
  }
}

fn continuation_after_whitespace(
  bytes: &[u8],
  mut next: usize,
  prior_digits: usize,
  current_leading_alpha: usize,
  groups: &mut IdentifierGroupState,
) -> (usize, IdentifierContinuation) {
  while bytes
    .get(next)
    .is_some_and(|value| matches!(value, b' ' | b'\t'))
  {
    next = next.saturating_add(1);
  }
  let (completed_numeric_groups, has_structured_digit_prefix) =
    groups.complete();
  let continuation = classify_identifier_continuation(
    bytes,
    next,
    prior_digits,
    current_leading_alpha,
    completed_numeric_groups,
    has_structured_digit_prefix,
  );
  (next, continuation)
}

#[derive(Clone, Copy)]
enum IdentifierContinuation {
  Consume,
  Stop,
  Reject,
}

fn classify_identifier_continuation(
  bytes: &[u8],
  start: usize,
  prior_digits: usize,
  current_leading_alpha: usize,
  completed_numeric_groups: usize,
  has_structured_digit_prefix: bool,
) -> IdentifierContinuation {
  let Some(first) = bytes.get(start) else {
    return IdentifierContinuation::Stop;
  };
  if !first.is_ascii_alphanumeric() && *first != b'_' {
    return IdentifierContinuation::Stop;
  }

  let mut end = start;
  let mut has_identifier_evidence = false;
  while bytes.get(end).is_some_and(|value| {
    value.is_ascii_alphanumeric() || matches!(value, b'.' | b'-' | b'/' | b'_')
  }) {
    has_identifier_evidence |=
      bytes.get(end).is_some_and(|byte| is_id_evidence(*byte));
    end = end.saturating_add(1);
    if end.saturating_sub(start) > MAX_IDENTIFIER_VALUE_CHARS {
      return overlong_continuation(has_identifier_evidence);
    }
  }
  let Some(mut token) = bytes.get(start..end) else {
    return IdentifierContinuation::Reject;
  };
  if token.contains(&b'_') {
    return if token.iter().any(u8::is_ascii_digit) {
      IdentifierContinuation::Reject
    } else {
      IdentifierContinuation::Stop
    };
  }
  if token.last() == Some(&b'.') {
    let Some(trimmed) = token.get(..token.len().saturating_sub(1)) else {
      return IdentifierContinuation::Reject;
    };
    token = trimmed;
  }
  if token.is_empty() {
    return IdentifierContinuation::Stop;
  }

  let has_separator = token
    .iter()
    .any(|value| matches!(value, b'.' | b'-' | b'/'));
  if has_separator {
    return classify_separated_identifier_continuation(
      token,
      *first,
      prior_digits,
      bytes.get(end).copied(),
    );
  }

  let digits = token.iter().filter(|value| value.is_ascii_digit()).count();
  if digits == token.len() {
    return classify_numeric_identifier_continuation(
      bytes,
      end,
      digits,
      prior_digits,
      current_leading_alpha,
      completed_numeric_groups,
      has_structured_digit_prefix,
    );
  }
  if prior_digits > 0 {
    if digits < 2 {
      return IdentifierContinuation::Stop;
    }
    return if max_ascii_alpha_run(token) <= MAX_IDENTIFIER_ALPHA_RUN {
      IdentifierContinuation::Consume
    } else {
      IdentifierContinuation::Reject
    };
  }
  if !first.is_ascii_alphabetic() {
    return IdentifierContinuation::Stop;
  }
  if token.len() <= 3 && digits > 0 {
    IdentifierContinuation::Consume
  } else {
    IdentifierContinuation::Stop
  }
}

fn classify_separated_identifier_continuation(
  token: &[u8],
  first: u8,
  prior_digits: usize,
  following: Option<u8>,
) -> IdentifierContinuation {
  if token
    .last()
    .is_some_and(|value| matches!(value, b'-' | b'/'))
  {
    return IdentifierContinuation::Reject;
  }
  let digits = token.iter().filter(|value| value.is_ascii_digit()).count();
  if !first.is_ascii_alphabetic() {
    return if digits >= 2 && !is_ascii_date_shape(token, following) {
      IdentifierContinuation::Consume
    } else {
      IdentifierContinuation::Stop
    };
  }
  if digits < 2 {
    return IdentifierContinuation::Stop;
  }
  let alpha_limit = if prior_digits > 0 {
    MAX_IDENTIFIER_ALPHA_RUN
  } else {
    3
  };
  if max_ascii_alpha_run(token) <= alpha_limit {
    IdentifierContinuation::Consume
  } else if prior_digits > 0 {
    IdentifierContinuation::Reject
  } else {
    IdentifierContinuation::Stop
  }
}

fn max_ascii_alpha_run(token: &[u8]) -> usize {
  token
    .iter()
    .fold((0_usize, 0_usize), |(current, maximum), value| {
      let current = if value.is_ascii_alphabetic() {
        current.saturating_add(1)
      } else {
        0
      };
      (current, maximum.max(current))
    })
    .1
}

fn classify_numeric_identifier_continuation(
  bytes: &[u8],
  end: usize,
  digits: usize,
  prior_digits: usize,
  current_leading_alpha: usize,
  completed_numeric_groups: usize,
  has_structured_digit_prefix: bool,
) -> IdentifierContinuation {
  if has_structured_digit_prefix {
    return classify_structured_prefix_numeric_continuation(
      bytes,
      end,
      digits,
      prior_digits,
    );
  }
  let grouped_numeric = classify_grouped_numeric_continuation(
    bytes,
    end,
    digits,
    prior_digits,
    current_leading_alpha,
    completed_numeric_groups,
  );
  if matches!(grouped_numeric, IdentifierContinuation::Reject) {
    return IdentifierContinuation::Reject;
  }
  if digits >= 2
    && ((prior_digits == 0 && (1..=3).contains(&current_leading_alpha))
      || matches!(grouped_numeric, IdentifierContinuation::Consume))
  {
    IdentifierContinuation::Consume
  } else {
    IdentifierContinuation::Stop
  }
}

fn classify_grouped_numeric_continuation(
  bytes: &[u8],
  end: usize,
  digits: usize,
  prior_digits: usize,
  current_leading_alpha: usize,
  completed_numeric_groups: usize,
) -> IdentifierContinuation {
  if !(2..=3).contains(&digits) || completed_numeric_groups == 0 {
    return IdentifierContinuation::Stop;
  }
  match following_numeric_group(bytes, end, NumericGroupPolicy::Grouped) {
    FollowingNumericGroup::Absent
      if completed_numeric_groups >= 2
        || (current_leading_alpha == 0 && (2..=3).contains(&prior_digits))
        || (1..=MAX_IDENTIFIER_ALPHA_RUN).contains(&current_leading_alpha) =>
    {
      IdentifierContinuation::Consume
    }
    FollowingNumericGroup::Absent => IdentifierContinuation::Stop,
    FollowingNumericGroup::Valid => IdentifierContinuation::Consume,
    FollowingNumericGroup::Invalid => IdentifierContinuation::Reject,
  }
}

fn classify_structured_prefix_numeric_continuation(
  bytes: &[u8],
  end: usize,
  digits: usize,
  prior_digits: usize,
) -> IdentifierContinuation {
  if prior_digits == 0 {
    return IdentifierContinuation::Stop;
  }
  if digits < 2 {
    return IdentifierContinuation::Reject;
  }
  match following_numeric_group(bytes, end, NumericGroupPolicy::Structured) {
    FollowingNumericGroup::Absent | FollowingNumericGroup::Valid => {
      IdentifierContinuation::Consume
    }
    FollowingNumericGroup::Invalid => IdentifierContinuation::Reject,
  }
}

const fn is_id_evidence(value: u8) -> bool {
  value.is_ascii_digit() || matches!(value, b'.' | b'-' | b'/' | b'_')
}

const fn overlong_continuation(
  has_identifier_evidence: bool,
) -> IdentifierContinuation {
  if has_identifier_evidence {
    IdentifierContinuation::Reject
  } else {
    IdentifierContinuation::Stop
  }
}

#[derive(Clone, Copy)]
enum FollowingNumericGroup {
  Absent,
  Valid,
  Invalid,
}

#[derive(Clone, Copy)]
enum NumericGroupPolicy {
  Grouped,
  Structured,
}

const PROSE_YEAR_MIN: u16 = 1900;
const PROSE_YEAR_MAX: u16 = 2099;

fn following_numeric_group(
  bytes: &[u8],
  mut start: usize,
  policy: NumericGroupPolicy,
) -> FollowingNumericGroup {
  if start > MAX_IDENTIFIER_VALUE_CHARS {
    return FollowingNumericGroup::Invalid;
  }
  if start == MAX_IDENTIFIER_VALUE_CHARS {
    return following_group_at_identifier_cap(bytes, start, false);
  }
  let limit = bytes.len().min(MAX_IDENTIFIER_VALUE_CHARS);
  let before_whitespace = start;
  while start < limit
    && bytes
      .get(start)
      .is_some_and(|value| matches!(value, b' ' | b'\t'))
  {
    start = start.saturating_add(1);
  }
  if start == MAX_IDENTIFIER_VALUE_CHARS {
    return following_group_at_identifier_cap(
      bytes,
      start,
      start > before_whitespace,
    );
  }
  if start >= limit {
    return if bytes.get(start).is_none() {
      FollowingNumericGroup::Absent
    } else {
      FollowingNumericGroup::Invalid
    };
  }
  if !bytes.get(start).is_some_and(u8::is_ascii_digit) {
    return FollowingNumericGroup::Absent;
  }
  let mut end = start;
  while end < limit && bytes.get(end).is_some_and(u8::is_ascii_digit) {
    end = end.saturating_add(1);
  }
  let digits = end.saturating_sub(start);
  let dirty_boundary = bytes.get(end).is_some_and(|value| {
    value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-' | b'/')
  });
  let structured = matches!(policy, NumericGroupPolicy::Structured);
  let prose_year = !structured
    && !dirty_boundary
    && bytes
      .get(start..end)
      .and_then(parse_ascii_year)
      .is_some_and(|year| (PROSE_YEAR_MIN..=PROSE_YEAR_MAX).contains(&year));
  if prose_year {
    FollowingNumericGroup::Absent
  } else if digits < 2 || (!structured && digits > 3) || dirty_boundary {
    FollowingNumericGroup::Invalid
  } else {
    FollowingNumericGroup::Valid
  }
}

fn following_group_at_identifier_cap(
  bytes: &[u8],
  start: usize,
  preceded_by_whitespace: bool,
) -> FollowingNumericGroup {
  let Some(tail) = bytes.get(start..) else {
    return FollowingNumericGroup::Invalid;
  };
  let Some(tail) = bounded_utf8_prefix(tail) else {
    return FollowingNumericGroup::Invalid;
  };
  if tail.is_empty() {
    return FollowingNumericGroup::Absent;
  }

  let mut token_start = 0_usize;
  let mut whitespace = 0_usize;
  for ch in tail.chars() {
    if !ch.is_whitespace() {
      break;
    }
    whitespace = whitespace.saturating_add(1);
    token_start = token_start.saturating_add(ch.len_utf8());
    if whitespace >= MAX_IDENTIFIER_VALUE_CHARS {
      return FollowingNumericGroup::Invalid;
    }
  }
  if token_start == 0 && !preceded_by_whitespace {
    return if is_clean_identifier_boundary(tail) {
      FollowingNumericGroup::Absent
    } else {
      FollowingNumericGroup::Invalid
    };
  }

  let Some(after_whitespace) = tail.get(token_start..) else {
    return FollowingNumericGroup::Invalid;
  };
  let Some(first) = after_whitespace.chars().next() else {
    return FollowingNumericGroup::Absent;
  };
  if is_clean_identifier_boundary(after_whitespace) {
    return FollowingNumericGroup::Absent;
  }
  if !first.is_alphanumeric() {
    return FollowingNumericGroup::Invalid;
  }
  let token = immediate_boundary_token(after_whitespace);
  if first.is_numeric() || token.has_numeric() {
    FollowingNumericGroup::Invalid
  } else {
    FollowingNumericGroup::Absent
  }
}

fn bounded_utf8_prefix(bytes: &[u8]) -> Option<&str> {
  let end = bytes
    .len()
    .min(MAX_IDENTIFIER_VALUE_CHARS.saturating_mul(4));
  match str::from_utf8(bytes.get(..end)?) {
    Ok(prefix) => Some(prefix),
    Err(error) if error.error_len().is_none() => {
      str::from_utf8(bytes.get(..error.valid_up_to())?).ok()
    }
    Err(_) => None,
  }
}

fn parse_ascii_year(value: &[u8]) -> Option<u16> {
  let [thousands, hundreds, tens, ones] = value else {
    return None;
  };
  [thousands, hundreds, tens, ones].into_iter().try_fold(
    0_u16,
    |year, digit| {
      let digit = digit.checked_sub(b'0').filter(|digit| *digit <= 9)?;
      Some(year.saturating_mul(10).saturating_add(u16::from(digit)))
    },
  )
}

fn is_ascii_date_shape(token: &[u8], following: Option<u8>) -> bool {
  let Some(separator) =
    token.iter().position(|value| matches!(value, b'T' | b't'))
  else {
    return is_conventional_ascii_date(token);
  };
  let Some((date, time_prefix)) = token
    .split_at_checked(separator)
    .and_then(|(date, suffix)| suffix.get(1..).map(|time| (date, time)))
  else {
    return false;
  };
  is_ascii_time_prefix(time_prefix, following)
    && is_conventional_ascii_date(date)
}

fn is_ascii_time_prefix(token: &[u8], following: Option<u8>) -> bool {
  let mut end = token
    .iter()
    .take_while(|value| value.is_ascii_digit())
    .count();
  if end == 0 {
    return false;
  }
  let valid_time_width = if following == Some(b':') && token.len() == end {
    (1..=2).contains(&end)
  } else {
    matches!(end, 2 | 4 | 6)
  };
  if !valid_time_width {
    return false;
  }
  if token.get(end) == Some(&b'.') {
    end = end.saturating_add(1);
    let fraction_digits = token
      .get(end..)
      .into_iter()
      .flatten()
      .take_while(|value| value.is_ascii_digit())
      .count();
    if fraction_digits == 0 {
      return false;
    }
    end = end.saturating_add(fraction_digits);
  }
  let Some(suffix) = token.get(end..) else {
    return false;
  };
  match suffix {
    [] | [b'Z' | b'z'] => true,
    [b'-', offset @ ..] => {
      matches!(offset.len(), 2 | 4) && offset.iter().all(u8::is_ascii_digit)
    }
    _ => false,
  }
}

fn is_conventional_ascii_date(token: &[u8]) -> bool {
  let mut separators = token
    .iter()
    .filter(|value| matches!(value, b'.' | b'-' | b'/'));
  let (Some(first_separator), Some(second_separator), None) =
    (separators.next(), separators.next(), separators.next())
  else {
    return false;
  };
  if first_separator != second_separator {
    return false;
  }

  let mut parts = token.split(|value| matches!(value, b'.' | b'-' | b'/'));
  let (Some(first), Some(second), Some(third), None) =
    (parts.next(), parts.next(), parts.next(), parts.next())
  else {
    return false;
  };
  [first, second, third]
    .iter()
    .all(|part| !part.is_empty() && part.iter().all(u8::is_ascii_digit))
    && ((first.len() == 4
      && (1..=2).contains(&second.len())
      && (1..=2).contains(&third.len()))
      || ((1..=2).contains(&first.len())
        && (1..=2).contains(&second.len())
        && matches!(third.len(), 2 | 4)))
}

fn single_digit_dotted_prefix(text: &str) -> bool {
  let mut chars = text.trim_start().chars();
  let Some(first) = chars.next() else {
    return false;
  };
  first.is_ascii_digit()
    && chars.next() == Some('.')
    && chars.next().is_some_and(|ch| ch.is_ascii_digit())
}

fn has_known_legal_form_suffix(text: &str, suffixes: &[String]) -> bool {
  suffixes.iter().any(|suffix| {
    let mut from = 0;
    while let Some(relative) =
      text.get(from..).and_then(|tail| tail.find(suffix))
    {
      let start = from.saturating_add(relative);
      let end = start.saturating_add(suffix.len());
      from = start.saturating_add(1);
      if !suffix.chars().all(char::is_alphabetic) {
        return true;
      }
      let left = text
        .get(..start)
        .and_then(|head| head.chars().next_back())
        .is_none_or(|ch| !ch.is_alphanumeric());
      let right = text
        .get(end..)
        .and_then(|tail| tail.chars().next())
        .is_none_or(|ch| !ch.is_alphanumeric());
      if left && right {
        return true;
      }
    }
    false
  })
}

fn person_name_run_end(text: &str) -> Option<usize> {
  let mut end = 0;
  let mut saw_token = false;
  let tokens = text.split_whitespace().collect::<Vec<_>>();
  for (index, token) in tokens.iter().enumerate() {
    let trimmed = trim_name_token(token);
    if is_person_name_run_token(trimmed, saw_token, &tokens, index) {
      let relative = text.get(end..)?.find(token)?;
      end = end.saturating_add(relative).saturating_add(token.len());
      saw_token = true;
      continue;
    }
    break;
  }
  saw_token.then_some(end)
}

/// End offset of a person-shaped prefix inside an organization trigger value.
///
/// Accepts either a title-led name (`Ing. Jan Henig`) or an untitled
/// two-token name (`Petr Šulc`). Rejects multi-word institutional names
/// (`Gymnázium Jana Keplera`, `Správa a údržba …`). Trailing lowercase
/// prose after a person-shaped run is trimmed (`… Henig uzavírá`).
fn organization_value_person_span_end(
  text: &str,
  title_tokens: &BTreeSet<String>,
) -> Option<usize> {
  let end = person_name_run_end(text)?;
  let head = text.get(..end)?.trim_end();
  if head.is_empty() || !is_person_shaped_name_run(head, title_tokens) {
    return None;
  }
  let rest = text.get(end..)?.trim_start();
  if rest.is_empty() {
    return Some(end);
  }
  let first_rest = rest.split_whitespace().next()?;
  first_rest
    .chars()
    .next()
    .is_some_and(char::is_lowercase)
    .then_some(end)
}

fn is_person_shaped_name_run(
  text: &str,
  title_tokens: &BTreeSet<String>,
) -> bool {
  let tokens = text
    .split_whitespace()
    .map(trim_name_token)
    .filter(|token| !token.is_empty())
    .collect::<Vec<_>>();
  if tokens.is_empty()
    || tokens.iter().any(|token| {
      !is_person_title_token(token, title_tokens)
        && !is_capitalized_name_token(token)
    })
  {
    return false;
  }
  let name_tokens = tokens
    .iter()
    .copied()
    .filter(|token| !is_person_title_token(token, title_tokens))
    .collect::<Vec<_>>();
  if tokens
    .first()
    .is_some_and(|token| is_person_title_token(token, title_tokens))
  {
    return matches!(name_tokens.len(), 1..=3);
  }
  name_tokens.len() == 2 && tokens.len() == 2
}

fn is_person_title_token(token: &str, title_tokens: &BTreeSet<String>) -> bool {
  let bare = token
    .trim_matches(|ch: char| matches!(ch, '.' | ','))
    .to_lowercase();
  title_tokens.contains(&bare)
}

fn is_person_name_run_token(
  token: &str,
  saw_token: bool,
  tokens: &[&str],
  index: usize,
) -> bool {
  if is_capitalized_name_token(token) {
    return true;
  }
  if !saw_token {
    return false;
  }
  if is_apostrophe_name_continuation(token) {
    return true;
  }
  is_name_particle(token) && has_name_after_particle(tokens, index)
}

fn has_name_after_particle(tokens: &[&str], index: usize) -> bool {
  for token in tokens.iter().skip(index.saturating_add(1)) {
    let trimmed = trim_name_token(token);
    if is_capitalized_name_token(trimmed)
      || is_apostrophe_name_continuation(trimmed)
    {
      return true;
    }
    if is_name_particle(trimmed) {
      continue;
    }
    return false;
  }
  false
}

fn is_capitalized_name_token(token: &str) -> bool {
  token.chars().next().is_some_and(char::is_uppercase)
}

fn is_apostrophe_name_continuation(token: &str) -> bool {
  token
    .strip_prefix("d'")
    .or_else(|| token.strip_prefix("d’"))
    .is_some_and(is_capitalized_name_token)
}

fn is_name_particle(token: &str) -> bool {
  matches!(
    token,
    "de"
      | "del"
      | "della"
      | "der"
      | "den"
      | "di"
      | "du"
      | "da"
      | "das"
      | "do"
      | "dos"
      | "el"
      | "la"
      | "le"
      | "van"
      | "von"
      | "y"
      | "zu"
      | "af"
      | "av"
      | "ben"
      | "bin"
      | "al"
      | "ten"
      | "ter"
      | "zum"
      | "zur"
      | "d'"
      | "d’"
  )
}

fn trim_name_token(token: &str) -> &str {
  token.trim_matches(',')
}

fn u32_len(text: &str) -> u32 {
  u32::try_from(text.len()).unwrap_or(u32::MAX)
}

fn byte_to_offset(byte: usize) -> Option<u32> {
  u32::try_from(byte).ok()
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::unwrap_used)]
mod tests {
  use crate::search::{SearchIndex, SearchOptions, SearchPattern};

  use super::*;

  fn trigger_test_data(rules: Vec<TriggerRule>) -> PreparedTriggerData {
    PreparedTriggerData::new(TriggerData {
      rules,
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap()
  }

  fn n_words_rule(trigger: &str, label: &str) -> TriggerRule {
    TriggerRule {
      trigger: String::from(trigger),
      label: String::from(label),
      strategy: TriggerStrategy::NWords { count: 1 },
      validations: Vec::new(),
      include_trigger: false,
    }
  }

  #[test]
  fn longer_same_start_trigger_makes_field_grammar_authoritative() {
    let text = "passport number is Z12345678";
    let data = trigger_test_data(vec![
      n_words_rule("passport number", "passport number"),
      n_words_rule("passport number is", "passport number"),
    ]);
    let entities = process_trigger_matches(
      &[
        SearchMatch::Literal {
          pattern: 0,
          start: 0,
          end: u32::try_from("passport number".len()).unwrap(),
        },
        SearchMatch::Literal {
          pattern: 1,
          start: 0,
          end: u32::try_from("passport number is".len()).unwrap(),
        },
      ],
      PatternSlice { start: 0, end: 2 },
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Z12345678");
  }

  #[test]
  fn equal_length_same_start_trigger_alternatives_are_preserved() {
    let text = "record number 12345";
    let data = trigger_test_data(vec![
      n_words_rule("record number", "registration number"),
      n_words_rule("record number", "case number"),
    ]);
    let end = u32::try_from("record number".len()).unwrap();
    let entities = process_trigger_matches(
      &[
        SearchMatch::Literal {
          pattern: 0,
          start: 0,
          end,
        },
        SearchMatch::Literal {
          pattern: 1,
          start: 0,
          end,
        },
      ],
      PatternSlice { start: 0, end: 2 },
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    assert_eq!(entities.len(), 2);
    assert_eq!(entities[0].text, "12345");
    assert_eq!(entities[1].text, "12345");
  }

  #[test]
  fn shorter_same_start_trigger_with_distinct_label_is_preserved() {
    let text = "record number code 12345";
    let data = trigger_test_data(vec![
      TriggerRule {
        trigger: String::from("record number"),
        label: String::from("case number"),
        strategy: TriggerStrategy::NWords { count: 2 },
        validations: Vec::new(),
        include_trigger: false,
      },
      n_words_rule("record number code", "registration number"),
    ]);
    let entities = process_trigger_matches(
      &[
        SearchMatch::Literal {
          pattern: 0,
          start: 0,
          end: u32::try_from("record number".len()).unwrap(),
        },
        SearchMatch::Literal {
          pattern: 1,
          start: 0,
          end: u32::try_from("record number code".len()).unwrap(),
        },
      ],
      PatternSlice { start: 0, end: 2 },
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    assert_eq!(entities.len(), 2);
    assert_eq!(entities[0].label, "case number");
    assert_eq!(entities[0].text, "code 12345");
    assert_eq!(entities[1].label, "registration number");
    assert_eq!(entities[1].text, "12345");
  }

  #[test]
  fn boundary_invalid_longer_trigger_does_not_shadow_valid_fallback() {
    let text = "VAT numbers 12345";
    let data = trigger_test_data(vec![
      TriggerRule {
        trigger: String::from("VAT"),
        label: String::from("tax identification number"),
        strategy: TriggerStrategy::NWords { count: 2 },
        validations: Vec::new(),
        include_trigger: false,
      },
      n_words_rule("VAT number", "tax identification number"),
    ]);
    let entities = process_trigger_matches(
      &[
        SearchMatch::Literal {
          pattern: 0,
          start: 0,
          end: u32::try_from("VAT".len()).unwrap(),
        },
        SearchMatch::Literal {
          pattern: 1,
          start: 0,
          end: u32::try_from("VAT number".len()).unwrap(),
        },
      ],
      PatternSlice { start: 0, end: 2 },
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "numbers 12345");
  }

  proptest::proptest! {
    #[test]
    fn validation_failed_longer_trigger_does_not_shadow_valid_fallback(
      identifier in "[0-9]{1,12}",
    ) {
      let text = format!("record number code {identifier}");
      let data = trigger_test_data(vec![
        TriggerRule {
          trigger: String::from("record number"),
          label: String::from("registration number"),
          strategy: TriggerStrategy::NWords { count: 2 },
          validations: vec![TriggerValidation::HasDigits],
          include_trigger: false,
        },
        TriggerRule {
          trigger: String::from("record number code"),
          label: String::from("registration number"),
          strategy: TriggerStrategy::NWords { count: 1 },
          validations: vec![TriggerValidation::NoDigits],
          include_trigger: false,
        },
      ]);
      let entities = process_trigger_matches(
        &[
          SearchMatch::Literal {
            pattern: 0,
            start: 0,
            end: u32::try_from("record number".len()).unwrap(),
          },
          SearchMatch::Literal {
            pattern: 1,
            start: 0,
            end: u32::try_from("record number code".len()).unwrap(),
          },
        ],
        PatternSlice { start: 0, end: 2 },
        &text,
        &data,
        &[],
        &BTreeSet::new(),
        None,
      )
      .unwrap();

      proptest::prop_assert_eq!(entities.len(), 1);
      proptest::prop_assert_eq!(
        &entities[0].text,
        &format!("code {identifier}"),
      );
    }
  }

  #[test]
  fn court_trigger_includes_trigger_span() {
    let text = "zapsaná v obchodním rejstříku vedeném Krajským soudem v Ústí nad Labem, oddíl B";
    let start = text.find("Krajským soudem").unwrap();
    let end = start.saturating_add("Krajským soudem".len());
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("krajským soudem"),
        label: String::from("organization"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: vec![String::from("oddíl")],
          max_length: None,
        },
        validations: vec![TriggerValidation::MinLength(3)],
        include_trigger: true,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap();

    let entities = process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "organization");
    assert_eq!(entities[0].source, DetectionSource::Trigger);
    assert_eq!(entities[0].text, "Krajským soudem v Ústí nad Labem");
  }

  #[test]
  fn court_trigger_survives_generated_slice_shape() {
    let text = "zapsaná v obchodním rejstříku vedeném Krajským soudem v Ústí nad Labem, oddíl B";
    let slice = PatternSlice {
      start: 1372,
      end: 2791,
    };
    let mut patterns = Vec::new();
    for index in 0..slice.end {
      let pattern = if index == slice.start.saturating_add(216) {
        String::from("krajským soudem")
      } else {
        format!("needle-{index}")
      };
      patterns.push(SearchPattern::LiteralWithOptions {
        pattern,
        case_insensitive: Some(true),
        whole_words: Some(false),
      });
    }
    let search = SearchIndex::new(patterns, SearchOptions::default()).unwrap();
    let mut rules = Vec::new();
    for index in slice.start..slice.end {
      let trigger = if index == slice.start.saturating_add(216) {
        String::from("krajským soudem")
      } else {
        format!("needle-{index}")
      };
      rules.push(TriggerRule {
        trigger,
        label: String::from("organization"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: vec![
            String::from("dne"),
            String::from("v oddíle"),
            String::from("oddíl"),
            String::from("vložka"),
          ],
          max_length: None,
        },
        validations: vec![TriggerValidation::MinLength(3)],
        include_trigger: true,
      });
    }
    let data = PreparedTriggerData::new(TriggerData {
      rules,
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap();

    let matches = search.find_iter(text).unwrap();
    let entities = process_trigger_matches(
      &matches,
      slice,
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "organization");
    assert_eq!(entities[0].source, DetectionSource::Trigger);
    assert_eq!(entities[0].text, "Krajským soudem v Ústí nad Labem");
  }

  #[test]
  fn court_trigger_lookahead_can_end_inside_later_utf8_scalar() {
    let prefix = "zapsaná v obchodním rejstříku vedeném Krajským soudem v Ústí nad Labem, oddíl B";
    let trigger_start = prefix.find("Krajským soudem").unwrap();
    let trigger_end = trigger_start.saturating_add("Krajským soudem".len());
    // An unset `max_length` scans a full line (LINE_TRIGGER_LOOKAHEAD),
    // not the historical MAX_TRIGGER_VALUE_LEN + margin window.
    let lookahead_end = trigger_end.saturating_add(LINE_TRIGGER_LOOKAHEAD);
    let padding_len =
      lookahead_end.saturating_sub(prefix.len()).saturating_sub(1);
    let text = format!("{prefix}{}é trailing", "x".repeat(padding_len));
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("krajským soudem"),
        label: String::from("organization"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: vec![String::from("oddíl")],
          max_length: None,
        },
        validations: vec![TriggerValidation::MinLength(3)],
        include_trigger: true,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap();

    let entities = process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(trigger_start).unwrap(),
        end: u32::try_from(trigger_end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      &text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Krajským soudem v Ústí nad Labem");
  }

  #[test]
  fn person_trigger_keeps_full_name_with_missing_particle() {
    let text = "Name: Maarten ten Brink, born 1980";
    let start = text.find("Name").unwrap();
    let end = start.saturating_add("Name".len());
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("Name"),
        label: String::from("person"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: Vec::new(),
          max_length: None,
        },
        validations: vec![TriggerValidation::StartsUppercase],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap();

    let entities = process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    // "ten" is a missing name particle (see is_name_particle); without it
    // person_name_run_end() would trim the span to just "Maarten",
    // leaking "ten Brink".
    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Maarten ten Brink");
  }

  #[test]
  fn person_trigger_keeps_real_name_after_role_trigger() {
    let text = "approved by director Jane Roe, on site";
    let trigger = "director";
    let start = text.find(trigger).unwrap();
    let end = start.saturating_add(trigger.len());
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from(trigger),
        label: String::from("person"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: Vec::new(),
          max_length: None,
        },
        validations: vec![TriggerValidation::StartsUppercase],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap();

    let entities = process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Jane Roe");
  }

  #[test]
  fn person_trigger_trims_a_same_line_field_label_after_a_real_name() {
    let trigger = "director";
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from(trigger),
        label: String::from("person"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: Vec::new(),
          max_length: None,
        },
        validations: vec![TriggerValidation::StartsUppercase],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: vec![
        String::from("Name"),
        String::from("Title"),
        String::from("Tax ID"),
        String::from("Jméno"),
        String::from("Titul"),
        String::from("HRB"),
        String::from("USt-IdNr."),
      ],
    })
    .unwrap();

    for (text, expected) in [
      (
        "approved by director Janem Zorbax Tax ID： 12345678, on site",
        "Janem Zorbax",
      ),
      (
        "approved by director Jane Roe Name: account holder, on site",
        "Jane Roe",
      ),
      (
        "approved by director Janem Novákem - IČO: 12345678, on site",
        "Janem Novákem",
      ),
      (
        "approved by director Janem Novákem Jméno: držitele účtu",
        "Janem Novákem",
      ),
      ("approved by director Novák Titul: jednatel", "Novák"),
      (
        "approved by director Hans Müller HRB: 1234, on site",
        "Hans Müller",
      ),
      (
        "approved by director Hans Müller USt-IdNr.: DE123456789",
        "Hans Müller",
      ),
    ] {
      let start = text.find(trigger).unwrap();
      let end = start.saturating_add(trigger.len());
      let entities = process_trigger_matches(
        &[SearchMatch::Literal {
          pattern: 0,
          start: u32::try_from(start).unwrap(),
          end: u32::try_from(end).unwrap(),
        }],
        PatternSlice { start: 0, end: 1 },
        text,
        &data,
        &[],
        &BTreeSet::new(),
        None,
      )
      .unwrap();

      assert_eq!(entities.len(), 1, "{text}");
      assert_eq!(entities[0].text, expected, "{text}");
    }
  }

  #[test]
  fn person_trigger_strips_a_leading_field_label_before_the_name() {
    let trigger = "represented by";
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from(trigger),
        label: String::from("person"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: Vec::new(),
          max_length: None,
        },
        validations: vec![TriggerValidation::StartsUppercase],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: vec![
        String::from("Name"),
        String::from("Title"),
        String::from("Jméno"),
        String::from("Address"),
        String::from("Date"),
      ],
    })
    .unwrap();
    let person_value_labels = [String::from("Name"), String::from("Jméno")];

    for (text, expected) in [
      (
        "the seller, represented by Name: Jane Roe, signed",
        "Jane Roe",
      ),
      (
        "the seller, represented by Name： Jane Roe, signed",
        "Jane Roe",
      ),
      (
        "the seller, represented by Name: Jane Roe Title: director, signed",
        "Jane Roe",
      ),
      ("the seller, represented by Jméno: Jan Novák", "Jan Novák"),
    ] {
      let start = text.find(trigger).unwrap();
      let end = start.saturating_add(trigger.len());
      let entities = process_trigger_matches(
        &[SearchMatch::Literal {
          pattern: 0,
          start: u32::try_from(start).unwrap(),
          end: u32::try_from(end).unwrap(),
        }],
        PatternSlice { start: 0, end: 1 },
        text,
        &data,
        &person_value_labels,
        &BTreeSet::new(),
        None,
      )
      .unwrap();

      assert_eq!(entities.len(), 1, "{text}");
      assert_eq!(entities[0].text, expected, "{text}");
      assert_eq!(
        entities[0].start,
        u32::try_from(text.find(expected).unwrap()).unwrap(),
        "{text}"
      );
    }

    for text in [
      "the seller, represented by Address: Main Street, signed",
      "the seller, represented by Date: August Twenty, signed",
    ] {
      let start = text.find(trigger).unwrap();
      let end = start.saturating_add(trigger.len());
      let entities = process_trigger_matches(
        &[SearchMatch::Literal {
          pattern: 0,
          start: u32::try_from(start).unwrap(),
          end: u32::try_from(end).unwrap(),
        }],
        PatternSlice { start: 0, end: 1 },
        text,
        &data,
        &person_value_labels,
        &BTreeSet::new(),
        None,
      )
      .unwrap();

      assert!(entities.is_empty(), "{text}");
    }
  }

  #[test]
  fn configured_field_label_matching_is_unicode_case_insensitive() {
    assert_eq!(
      configured_field_label_start("IČO : 00209805", "ičo"),
      Some(0)
    );
  }

  fn organization_role_trigger_data(
    legal_form_suffixes: Vec<String>,
  ) -> PreparedTriggerData {
    PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("zhotovitel"),
        label: String::from(PERSON_OR_ORGANIZATION_TRIGGER_LABEL),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: Vec::new(),
          max_length: None,
        },
        validations: vec![TriggerValidation::StartsUppercase],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes,
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap()
  }

  fn run_organization_role_trigger(
    text: &str,
    data: &PreparedTriggerData,
  ) -> Vec<(String, String)> {
    let title_tokens = BTreeSet::from([
      String::from("ing"),
      String::from("mgr"),
      String::from("prof"),
    ]);
    let Some(start) = text.to_lowercase().find("zhotovitel") else {
      return Vec::new();
    };
    let end = start.saturating_add("zhotovitel".len());
    process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      text,
      data,
      &[],
      &title_tokens,
      None,
    )
    .unwrap()
    .into_iter()
    .map(|entity| (entity.label, entity.text))
    .collect()
  }

  #[test]
  fn organization_role_trigger_reclassifies_titled_person() {
    let data = organization_role_trigger_data(Vec::new());
    let texts =
      run_organization_role_trigger("Zhotovitel:\nIng. Jan Henig\n", &data);
    assert_eq!(
      texts,
      vec![(String::from("person"), String::from("Ing. Jan Henig"))]
    );
  }

  #[test]
  fn organization_role_trigger_reclassifies_untitled_two_token_person() {
    let data = organization_role_trigger_data(Vec::new());
    let texts =
      run_organization_role_trigger("Zhotovitel:\nPetr Šulc\n", &data);
    assert_eq!(
      texts,
      vec![(String::from("person"), String::from("Petr Šulc"))]
    );
  }

  #[test]
  fn organization_role_trigger_does_not_treat_institutional_head_as_suffix() {
    let data = organization_role_trigger_data(Vec::new());
    let texts =
      run_organization_role_trigger("Zhotovitel:\nJohn Court\n", &data);
    assert_eq!(
      texts,
      vec![(String::from("person"), String::from("John Court"))]
    );
  }

  #[test]
  fn organization_role_trigger_trims_trailing_prose_from_person() {
    let data = organization_role_trigger_data(Vec::new());
    let texts = run_organization_role_trigger(
      "zhotovitel Ing. Jan Henig uzavírá smlouvu\n",
      &data,
    );
    assert_eq!(
      texts,
      vec![(String::from("person"), String::from("Ing. Jan Henig"))]
    );
  }

  #[test]
  fn organization_role_trigger_keeps_multi_word_organization() {
    let data = organization_role_trigger_data(Vec::new());
    let texts = run_organization_role_trigger(
      "Zhotovitel:\nSpráva a údržba silnic Plzeňského kraje\n",
      &data,
    );
    assert_eq!(
      texts,
      vec![(
        String::from("organization"),
        String::from("Správa a údržba silnic Plzeňského kraje")
      )]
    );
  }

  #[test]
  fn organization_role_trigger_keeps_three_token_institution_name() {
    let data = organization_role_trigger_data(Vec::new());
    let texts = run_organization_role_trigger(
      "Zhotovitel:\nGymnázium Jana Keplera\n",
      &data,
    );
    assert_eq!(
      texts,
      vec![(
        String::from("organization"),
        String::from("Gymnázium Jana Keplera")
      )]
    );
  }

  #[test]
  fn organization_role_trigger_keeps_legal_form_company() {
    let data = organization_role_trigger_data(vec![String::from("s.r.o.")]);
    let texts =
      run_organization_role_trigger("Zhotovitel:\nLAFURNI, s.r.o.\n", &data);
    // to-next-comma stops before the legal-form suffix after the comma, so
    // the captured value is the bare company name; without a person shape
    // it stays organization.
    assert_eq!(
      texts,
      vec![(String::from("organization"), String::from("LAFURNI"))]
    );
  }

  #[test]
  fn to_next_comma_without_max_length_captures_full_value() {
    let long_value = "A".repeat(150);
    let text = format!("Address: {long_value}, next line");
    let start = text.find("Address").unwrap();
    let end = start.saturating_add("Address".len());
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("Address"),
        label: String::from("organization"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: Vec::new(),
          max_length: None,
        },
        validations: vec![TriggerValidation::MinLength(3)],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap();

    let entities = process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      &text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    // No configured `maxLength` must mean genuinely uncapped: the value is
    // over MAX_TRIGGER_VALUE_LEN (100) chars but ends cleanly at the
    // comma, so it must not be truncated to ~100 chars.
    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, long_value);
  }

  fn uncapped_to_next_comma_data() -> PreparedTriggerData {
    uncapped_to_next_comma_data_with_stops(Vec::new())
  }

  fn uncapped_to_next_comma_data_with_stops(
    stop_words: Vec<String>,
  ) -> PreparedTriggerData {
    PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("Address"),
        label: String::from("organization"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words,
          max_length: None,
        },
        validations: vec![TriggerValidation::MinLength(3)],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap()
  }

  fn run_single_trigger(text: &str, data: &PreparedTriggerData) -> Vec<String> {
    let start = text.find("Address").unwrap();
    let end = start.saturating_add("Address".len());
    process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      text,
      data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap()
    .into_iter()
    .map(|entity| entity.text)
    .collect()
  }

  #[test]
  fn uncapped_to_next_comma_fails_closed_on_clipped_lookahead_window() {
    // The delimiter sits beyond the LINE_TRIGGER_LOOKAHEAD window and more
    // text exists past the window, so the scan never reaches a structural
    // stop. Emitting the window-sized prefix would present a truncated
    // span as a complete value while the tail stays unredacted; the
    // extraction must fail closed instead.
    let data = uncapped_to_next_comma_data();
    let overflow = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_add(64));
    let text = format!("Address: {overflow}, next line");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      Vec::<String>::new(),
      "a window-truncated uncapped value must not be emitted"
    );
  }

  #[test]
  fn uncapped_to_next_comma_keeps_value_ending_at_end_of_text() {
    // Running off the window is legitimate when the window already covers
    // the rest of the text: the value simply ends at end of input.
    let data = uncapped_to_next_comma_data();

    let texts = run_single_trigger("Address: Acme Corporation", &data);

    assert_eq!(texts, vec![String::from("Acme Corporation")]);
  }

  #[test]
  fn uncapped_to_next_comma_keeps_value_with_delimiter_at_window_edge() {
    // The lookahead window spans LINE_TRIGGER_LOOKAHEAD UTF-16 units from
    // the trigger end; ": " consumes two of them, so this value fills the
    // window exactly and its comma is the very next character. The
    // delimiter sits at the window edge, the value is complete, and it
    // must be emitted rather than rejected as window-clipped.
    let data = uncapped_to_next_comma_data();
    let exact = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(2));
    let text = format!("Address: {exact}, next line");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      vec![exact],
      "a complete value whose delimiter sits exactly at the window edge must be kept"
    );
  }

  #[test]
  fn uncapped_to_next_comma_keeps_value_with_padding_before_edge_comma() {
    // Trim-able padding between the window edge and the comma does not
    // make the value clipped: mid-window the spaces would be consumed and
    // then trimmed by byte_value, and the edge must behave identically.
    let data = uncapped_to_next_comma_data();
    let value = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(2));
    let text = format!("Address: {value}   , next line");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      vec![value],
      "padding before an edge comma must complete the value"
    );
  }

  #[test]
  fn uncapped_to_next_comma_keeps_value_with_padding_before_edge_stop_word() {
    // The same holds when the delimiter past the padding is a configured
    // stop word rather than a delimiter character.
    let data =
      uncapped_to_next_comma_data_with_stops(vec![String::from("oddíl")]);
    let value = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(2));
    let text = format!("Address: {value}   oddíl B");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      vec![value],
      "padding before an edge stop word must complete the value"
    );
  }

  #[test]
  fn uncapped_to_next_comma_rejects_padding_followed_by_value_content() {
    // Padding past the edge followed by more value content is a genuine
    // truncation: terminating the scan would require consuming that
    // content, so the extraction still fails closed.
    let data = uncapped_to_next_comma_data();
    let value = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(2));
    let text = format!("Address: {value}   more, next line");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      Vec::<String>::new(),
      "padding followed by value content past the edge must fail closed"
    );
  }

  #[test]
  fn uncapped_to_next_comma_keeps_value_with_padding_up_to_the_bound() {
    // A padding run of exactly LINE_TRIGGER_LOOKAHEAD bytes stays within
    // the bounded probe: the walk ends precisely on the comma and the
    // value is complete.
    let data = uncapped_to_next_comma_data();
    let value = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(2));
    let padding = " ".repeat(LINE_TRIGGER_LOOKAHEAD);
    let text = format!("Address: {value}{padding}, next line");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      vec![value],
      "padding up to the probe bound must still complete the value"
    );
  }

  #[test]
  fn uncapped_to_next_comma_rejects_padding_beyond_the_bound() {
    // A padding run longer than the probe bound is not walked to its end:
    // the probe stops inside the run, the position reads as unconsumed
    // content, and the scan fails closed without scanning the tail.
    let data = uncapped_to_next_comma_data();
    let value = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(2));
    let padding = " ".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_add(1));
    let text = format!("Address: {value}{padding}, next line");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      Vec::<String>::new(),
      "padding beyond the probe bound must fail closed"
    );
  }

  #[test]
  fn uncapped_to_next_comma_keeps_value_with_padding_to_end_of_text() {
    // Padding that runs to the end of the text terminates the value like
    // any end-of-input value; nothing of value sits past the window.
    let data = uncapped_to_next_comma_data();
    let value = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(2));
    let text = format!("Address: {value}   ");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      vec![value],
      "padding to the end of text must complete the value"
    );
  }

  #[test]
  fn uncapped_to_next_comma_keeps_value_with_stop_word_at_window_edge() {
    // A multi-character stop word ("oddíl") anchored exactly at the window
    // edge must end the value the same way it would mid-window: the value
    // is complete, not clipped. The scanner sees the full text tail, so
    // the stop word (and its trailing word boundary) stays visible.
    let data =
      uncapped_to_next_comma_data_with_stops(vec![String::from("oddíl")]);
    // ": " consumes two window units and the separating space one more, so
    // the stop word starts exactly at LINE_TRIGGER_LOOKAHEAD units past
    // the trigger end.
    let value = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(3));
    let text = format!("Address: {value} oddíl B");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      vec![value],
      "a stop word anchored at the window edge must complete the value"
    );
  }

  #[test]
  fn uncapped_to_next_comma_keeps_value_with_stop_word_straddling_edge() {
    // A stop word that begins inside the window but extends past the edge
    // must also be recognized: a window-clipped slice would hide its tail
    // ("od|díl"), miss the match, and wrongly report the scan as clipped.
    let data =
      uncapped_to_next_comma_data_with_stops(vec![String::from("oddíl")]);
    // The stop word starts two characters before the window edge.
    let value = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(5));
    let text = format!("Address: {value} oddíl B, next line");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      vec![value],
      "a stop word straddling the window edge must complete the value"
    );
  }

  #[test]
  fn uncapped_to_next_comma_keeps_value_with_crlf_at_window_edge() {
    // A CRLF line break at the window edge is a delimiter, not clipped
    // content: '\r' stops the scan exactly like '\n'.
    let data = uncapped_to_next_comma_data();
    let value = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(2));
    let text = format!("Address: {value}\r\nnext line");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      vec![value],
      "a CRLF at the window edge must complete the value"
    );
  }

  #[test]
  fn uncapped_to_next_comma_rejects_multi_unit_char_crossing_the_edge() {
    // A surrogate-pair character whose two UTF-16 units would straddle the
    // window limit pushes the limit to the char boundary before it; the
    // value genuinely continues past the window, so the scan must fail
    // closed — without panicking on a mid-character slice.
    let data = uncapped_to_next_comma_data();
    let value = "A".repeat(LINE_TRIGGER_LOOKAHEAD.saturating_sub(3));
    let text = format!("Address: {value}\u{1F600}BBBB, next line");

    let texts = run_single_trigger(&text, &data);

    assert_eq!(
      texts,
      Vec::<String>::new(),
      "a value continuing through the edge with a multi-unit char must fail closed"
    );
  }

  #[test]
  fn phone_trigger_accepts_dot_space_separators() {
    let text = "Phone: +1. 555. 123. 4567\n";
    let start = text.find("Phone").unwrap();
    let end = start.saturating_add("Phone".len());
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("Phone"),
        label: String::from("phone number"),
        strategy: TriggerStrategy::ToEndOfLine,
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap();

    let entities = process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    // phone_shape_end() must not hard-stop on ". " when digits follow
    // shortly after; otherwise the value is dropped by the 5-digit
    // plausibility check.
    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "phone number");
    assert_eq!(entities[0].text, "+1. 555. 123. 4567");
  }

  #[test]
  fn phone_trigger_cap_ignores_trailing_spaces_before_newline() {
    let digits = "1".repeat(105);
    let text = format!("Phone: {digits}   \n");
    let start = text.find("Phone").unwrap();
    let end = start.saturating_add("Phone".len());
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("Phone"),
        label: String::from("phone number"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: Vec::new(),
          max_length: None,
        },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap();

    let entities = process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      &text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    // The scan (and byte_value()'s trailing-whitespace trim) leaves
    // value.end pointing before the 3 trailing spaces, not at the `\n`.
    // The cap decision must look past that trimmed whitespace instead of
    // treating the value as un-delimited and truncating it.
    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, digits);
  }

  #[test]
  fn address_to_next_comma_soft_wraps_one_capitalized_continuation_line() {
    let text = "laws of the State of New\nYork shall govern";
    let start = text.find("State of").unwrap();
    let end = start.saturating_add("State of".len());
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("state of"),
        label: String::from("address"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: vec![
            String::from("or"),
            String::from("and"),
            String::from("shall"),
          ],
          max_length: Some(30),
        },
        validations: Vec::new(),
        include_trigger: true,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap();

    let entities = process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "State of New\nYork");
  }

  #[test]
  fn address_soft_wrap_does_not_absorb_following_lowercase_prose() {
    let text = "banking institutions in the State of New\nYork are authorized or required";
    let start = text.find("State of").unwrap();
    let end = start.saturating_add("State of".len());
    let data = PreparedTriggerData::new(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("state of"),
        label: String::from("address"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: vec![
            String::from("or"),
            String::from("and"),
            String::from("shall"),
          ],
          max_length: Some(30),
        },
        validations: Vec::new(),
        include_trigger: true,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    })
    .unwrap();

    let entities = process_trigger_matches(
      &[SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
      }],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
      &[],
      &BTreeSet::new(),
      None,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "State of New\nYork");
  }
}
