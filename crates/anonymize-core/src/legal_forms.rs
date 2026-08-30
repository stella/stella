use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use crate::byte_offsets::ByteOffsets;
use crate::processors::PatternSlice;
use crate::resolution::{DetectionSource, PipelineEntity};
use crate::types::{Result, SearchMatch};

const LEGAL_FORM_SCORE: f64 = 0.95;
const HEAD_TOKEN_CAP: usize = 20;
const MAX_LOWER_BRIDGE: usize = 4;
const MAX_NAME_LOOKBACK: usize = 32;

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct LegalFormData {
  pub suffixes: Vec<String>,
  pub non_ascii_name_short_suffixes: Vec<String>,
  pub normalized_boundary_suffixes: Vec<String>,
  pub normalized_in_name_words: Vec<String>,
  pub normalized_suffix_words: Vec<String>,
  pub role_heads: Vec<String>,
  pub sentence_verb_indicators: Vec<String>,
  pub clause_noun_heads: Vec<String>,
  pub connector_prose_heads: Vec<String>,
  pub structural_single_cap_prefixes: Vec<String>,
  pub leading_clause_phrases: Vec<String>,
  pub leading_clause_direct_prefixes: Vec<String>,
  pub connector_words: Vec<String>,
  pub and_connector_words: Vec<String>,
  pub in_name_prepositions: Vec<String>,
  pub company_suffix_words: Vec<String>,
  pub comma_gated_direct_prefixes: Vec<String>,
  pub institutional_heads: Vec<String>,
  pub institutional_complement_heads: Vec<String>,
  pub institutional_complement_starters: Vec<String>,
  pub institutional_complement_connectors: Vec<String>,
  pub institutional_generic_words: Vec<String>,
  pub institutional_prefix_generic_words: Vec<String>,
  pub lowercase_bridge: LowercaseBridge,
}

/// Whether the backward name walk may cross arbitrary lowercase words once a
/// capitalized word is already part of the span.
///
/// Languages that capitalize only the first word of a name are open; English
/// admits only a closed connector set, so prose such as `invested in` ends
/// the name.
#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub enum LowercaseBridge {
  #[default]
  Open,
  Closed {
    words: Vec<String>,
  },
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PreparedLowercaseBridge {
  Open,
  Closed(HashSet<String>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedLegalFormData {
  suffixes: Vec<String>,
  non_ascii_name_short_suffixes: HashSet<String>,
  list_suffix_indices_by_last_char: HashMap<char, Vec<usize>>,
  suffix_indices_by_last_char: HashMap<char, Vec<usize>>,
  normalized_boundary_suffixes: HashSet<String>,
  normalized_in_name_words: HashSet<String>,
  normalized_suffix_words: HashSet<String>,
  role_heads: HashSet<String>,
  soft_wrap_boundary_labels: HashSet<String>,
  sentence_verb_indicators: HashSet<String>,
  clause_noun_heads: HashSet<String>,
  connector_prose_heads: HashSet<String>,
  structural_single_cap_prefixes: HashSet<String>,
  leading_clause_phrases: Vec<String>,
  leading_clause_direct_prefixes: Vec<String>,
  connector_words: HashSet<String>,
  and_connector_words: HashSet<String>,
  in_name_prepositions: HashSet<String>,
  company_suffix_words: HashSet<String>,
  comma_gated_direct_prefixes: HashSet<String>,
  institutional_heads: HashSet<String>,
  institutional_complement_heads: HashSet<String>,
  institutional_complement_starters: HashSet<String>,
  institutional_complement_connectors: HashSet<String>,
  institutional_generic_words: HashSet<String>,
  institutional_prefix_generic_words: HashSet<String>,
  lowercase_bridge: PreparedLowercaseBridge,
}

impl PreparedLegalFormData {
  #[cfg(test)]
  fn new(data: LegalFormData) -> Self {
    Self::new_with_soft_wrap_boundary_labels(data, Vec::new())
  }

  pub(crate) fn new_with_soft_wrap_boundary_labels(
    data: LegalFormData,
    soft_wrap_boundary_labels: Vec<String>,
  ) -> Self {
    let LegalFormData {
      suffixes,
      non_ascii_name_short_suffixes,
      normalized_boundary_suffixes,
      normalized_in_name_words,
      normalized_suffix_words,
      role_heads,
      sentence_verb_indicators,
      clause_noun_heads,
      connector_prose_heads,
      structural_single_cap_prefixes,
      leading_clause_phrases,
      leading_clause_direct_prefixes,
      connector_words,
      and_connector_words,
      in_name_prepositions,
      company_suffix_words,
      comma_gated_direct_prefixes,
      institutional_heads,
      institutional_complement_heads,
      institutional_complement_starters,
      institutional_complement_connectors,
      institutional_generic_words,
      institutional_prefix_generic_words,
      lowercase_bridge,
    } = data;
    // Connector words and in-name prepositions bridge in every policy; a
    // closed list only adds to them.
    let lowercase_bridge = match lowercase_bridge {
      LowercaseBridge::Open => PreparedLowercaseBridge::Open,
      LowercaseBridge::Closed { words } => {
        let mut allowed = lower_set(words);
        allowed.extend(connector_words.iter().map(|word| word.to_lowercase()));
        allowed
          .extend(in_name_prepositions.iter().map(|word| word.to_lowercase()));
        PreparedLowercaseBridge::Closed(allowed)
      }
    };
    let list_suffix_indices_by_last_char =
      suffix_indices_by_last_char_matching(&suffixes, |suffix| {
        !is_roman_legal_suffix(suffix)
      });
    let suffix_indices_by_last_char = suffix_indices_by_last_char(&suffixes);

    Self {
      suffixes,
      non_ascii_name_short_suffixes: lower_set(non_ascii_name_short_suffixes),
      list_suffix_indices_by_last_char,
      suffix_indices_by_last_char,
      normalized_boundary_suffixes: lower_set(normalized_boundary_suffixes),
      normalized_in_name_words: lower_set(normalized_in_name_words),
      normalized_suffix_words: lower_set(normalized_suffix_words),
      role_heads: lower_set(role_heads),
      soft_wrap_boundary_labels: lower_set(soft_wrap_boundary_labels),
      sentence_verb_indicators: lower_set(sentence_verb_indicators),
      clause_noun_heads: lower_set(clause_noun_heads),
      connector_prose_heads: lower_set(connector_prose_heads),
      structural_single_cap_prefixes: lower_set(structural_single_cap_prefixes),
      leading_clause_phrases: lower_vec(leading_clause_phrases),
      leading_clause_direct_prefixes: lower_vec(leading_clause_direct_prefixes),
      connector_words: lower_set(connector_words),
      and_connector_words: lower_set(and_connector_words),
      in_name_prepositions: lower_set(in_name_prepositions),
      company_suffix_words: lower_set(company_suffix_words),
      comma_gated_direct_prefixes: lower_set(comma_gated_direct_prefixes),
      institutional_heads: lower_set(institutional_heads),
      institutional_complement_heads: lower_set(institutional_complement_heads),
      institutional_complement_starters: lower_set(
        institutional_complement_starters,
      ),
      institutional_complement_connectors: lower_set(
        institutional_complement_connectors,
      ),
      institutional_generic_words: lower_set(institutional_generic_words),
      institutional_prefix_generic_words: lower_set(
        institutional_prefix_generic_words,
      ),
      lowercase_bridge,
    }
  }

  pub(crate) fn has_leading_clause_phrase(&self, text: &str) -> bool {
    let trimmed = text.trim_end_matches(char::is_whitespace);
    let lower = lowercase_lookup(trimmed);
    self.leading_clause_phrases.iter().any(|phrase| {
      let Some(before_phrase) = lower.strip_suffix(phrase) else {
        return false;
      };
      before_phrase
        .chars()
        .next_back()
        .is_none_or(|ch| !ch.is_alphanumeric())
    })
  }

  pub(crate) fn has_subject_clause_tail(&self, text: &str) -> bool {
    let mut words = text
      .split(|ch: char| !ch.is_alphabetic())
      .filter(|word| !word.is_empty());
    let Some(verb) = words.next() else {
      return false;
    };
    if !contains_lowercase(&self.sentence_verb_indicators, verb) {
      return false;
    }
    words
      .take(3)
      .any(|word| contains_lowercase(&self.role_heads, word))
  }

  pub(crate) fn is_party_label_prefix(&self, text: &str) -> bool {
    let trimmed = text.trim();
    let Some(label) = trimmed
      .strip_suffix(':')
      .or_else(|| trimmed.strip_suffix('：'))
      .map(str::trim_end)
    else {
      return false;
    };
    let mut words = label
      .split(|ch: char| !ch.is_alphanumeric())
      .filter(|word| !word.is_empty());
    let Some(role) = words.next() else {
      return false;
    };
    if !contains_lowercase(&self.role_heads, role) {
      return false;
    }
    let Some(discriminator) = words.next() else {
      return true;
    };
    words.next().is_none()
      && discriminator.chars().count() <= 2
      && discriminator
        .chars()
        .all(|ch| ch.is_uppercase() || ch.is_numeric())
  }

  fn bridges_lowercase(&self, token: &str) -> bool {
    match &self.lowercase_bridge {
      PreparedLowercaseBridge::Open => true,
      PreparedLowercaseBridge::Closed(allowed) => {
        contains_lowercase(allowed, token)
      }
    }
  }
}

fn suffix_indices_by_last_char(
  suffixes: &[String],
) -> HashMap<char, Vec<usize>> {
  suffix_indices_by_last_char_matching(suffixes, |_| true)
}

fn suffix_indices_by_last_char_matching(
  suffixes: &[String],
  include: impl Fn(&str) -> bool,
) -> HashMap<char, Vec<usize>> {
  let mut by_char = HashMap::<char, Vec<usize>>::new();
  for (index, suffix) in suffixes.iter().enumerate() {
    if !include(suffix) {
      continue;
    }
    let Some(last) = suffix.chars().next_back() else {
      continue;
    };
    by_char.entry(last).or_default().push(index);
  }
  by_char
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Candidate {
  start: usize,
  suffix_start: usize,
  matched_suffix_start: usize,
  suffix_end: usize,
  end: usize,
  trimmed: bool,
}

pub(crate) fn process_legal_form_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &PreparedLegalFormData,
) -> Result<Vec<PipelineEntity>> {
  if data.suffixes.is_empty() {
    return Ok(Vec::new());
  }

  let offsets = ByteOffsets::new(full_text);
  let mut candidates = Vec::new();
  for found in matches {
    if slice.local_index(found.pattern()).is_none() {
      continue;
    }

    let suffix_start = offsets.validate_offset(found.start())?;
    let suffix_end = offsets.validate_offset(found.end())?;
    let effective_suffix_start =
      effective_line_wrapped_suffix_start(full_text, suffix_start);
    if !is_leading_separator(full_text, suffix_start)
      || !is_trailing_boundary(full_text, suffix_end)
    {
      continue;
    }

    let candidate_end = extend_institutional_complement(
      full_text,
      suffix_start,
      suffix_end,
      data,
    );
    let head_starts_name = candidate_end > suffix_end
      && effective_suffix_start == suffix_start
      && full_text
        .get(suffix_start..suffix_end)
        .is_some_and(starts_upper);
    let walker_start =
      match walk_backward(full_text, effective_suffix_start, data) {
        Some(start) if start < effective_suffix_start => start,
        _ if head_starts_name => effective_suffix_start,
        _ => continue,
      };

    // Narrow to the org name before the sentence check. The walker bridges
    // lowercase words (up to MAX_LOWER_BRIDGE) and can reach back over a verb
    // clause into a prior sentence ("Initech term sheet. This deed is made by
    // Initech Corporation"). trim_to_first_cap_after_verb drops that prose, so
    // the sentence-boundary guard must run on the trimmed span or it rejects a
    // candidate that would have trimmed cleanly to a single-sentence org.
    let candidate_start =
      if head_starts_name && walker_start == effective_suffix_start {
        walker_start
      } else {
        trim_to_first_cap_after_verb(
          full_text,
          walker_start,
          effective_suffix_start,
          data,
        )
      };
    if candidate_start > effective_suffix_start
      || (candidate_start == effective_suffix_start && !head_starts_name)
    {
      continue;
    }
    // A sentence break inside the candidate ("Acme Inc. Beta LLC") no longer
    // drops the whole thing: re-clip to just after the break and re-validate
    // the trimmed remainder so the later org ("Beta LLC") still gets emitted.
    let Some(clipped_start) = clip_past_sentence_breaks(
      full_text,
      candidate_start,
      effective_suffix_start,
    ) else {
      continue;
    };
    // The clipped remainder can open with lowercase bridge prose that was
    // only reachable because the backward walk had seen a capitalized token
    // before the break ("Acme Inc. the supplier Beta LLC"): re-anchor it at
    // the first token that can start an org name, exactly like the walk
    // would have if it had started inside this sentence.
    let candidate_start = if clipped_start == candidate_start {
      candidate_start
    } else {
      trim_to_first_name_token(
        full_text,
        clipped_start,
        effective_suffix_start,
        data,
      )
    };
    if candidate_start > effective_suffix_start
      || (candidate_start == effective_suffix_start && !head_starts_name)
    {
      continue;
    }

    candidates.push(Candidate {
      start: candidate_start,
      suffix_start: effective_suffix_start,
      matched_suffix_start: suffix_start,
      suffix_end,
      end: candidate_end,
      trimmed: candidate_start != walker_start,
    });
  }

  let candidates = drop_overlapping(candidates, full_text, data);
  let mut entities = Vec::new();
  for candidate in candidates {
    process_candidate(&mut entities, full_text, &candidate, data);
  }
  let mut seen_spans = HashSet::new();
  entities.retain(|entity| seen_spans.insert((entity.start, entity.end)));
  let emitted_spans = entities
    .iter()
    .map(|entity| (entity.start, entity.end))
    .collect::<Vec<_>>();
  entities.retain(|entity| {
    !emitted_spans
      .iter()
      .any(|&(start, end)| start == entity.start && end > entity.end)
  });

  Ok(entities)
}

const MAX_INSTITUTIONAL_COMPLEMENT_TOKENS: usize = 12;
const MAX_INSTITUTIONAL_COMPLEMENT_BYTES: usize = 180;

/// Extends complement-bearing institutional heads in names such as
/// "Department of Justice" and "Society for the Protection of Children".
/// The grammar is intentionally narrow: an exact configured head, an `of` or
/// `for` starter, connector words, and at least one capitalized complement.
fn extend_institutional_complement(
  text: &str,
  suffix_start: usize,
  suffix_end: usize,
  data: &PreparedLegalFormData,
) -> usize {
  let Some(head) = text.get(suffix_start..suffix_end) else {
    return suffix_end;
  };
  if !data
    .institutional_complement_heads
    .contains(normalize_suffix_token(head).to_lowercase().as_str())
  {
    return suffix_end;
  }

  let mut scan_limit = suffix_end
    .saturating_add(MAX_INSTITUTIONAL_COMPLEMENT_BYTES)
    .min(text.len());
  while !text.is_char_boundary(scan_limit) {
    scan_limit = scan_limit.saturating_sub(1);
  }
  let tail = text.get(suffix_end..scan_limit).unwrap_or_default();
  let boundary = tail
    .char_indices()
    .find_map(|(index, character)| {
      let absolute_index = suffix_end.saturating_add(index);
      (matches!(
        character,
        '\n' | '\r' | ',' | ';' | ':' | '(' | ')' | '[' | ']'
      ) || (character == '.'
        && !is_dotted_uppercase_acronym_period(text, absolute_index)))
      .then_some(index)
    })
    .unwrap_or(tail.len());
  let scan_end = suffix_end.saturating_add(boundary);
  let mut tokens = word_tokens(text, suffix_end, scan_end);
  let Some(starter) = tokens.next() else {
    return suffix_end;
  };
  if !data
    .institutional_complement_starters
    .contains(lowercase_lookup(starter.text).as_ref())
  {
    return suffix_end;
  }
  let mut last_capital_end = None;
  for token in tokens.take(MAX_INSTITUTIONAL_COMPLEMENT_TOKENS) {
    if starts_upper(token.text) {
      last_capital_end = Some(token.end);
      continue;
    }
    if !data
      .institutional_complement_connectors
      .contains(lowercase_lookup(token.text).as_ref())
    {
      break;
    }
  }
  last_capital_end.unwrap_or(suffix_end)
}

fn effective_line_wrapped_suffix_start(
  text: &str,
  suffix_start: usize,
) -> usize {
  let mut scan = suffix_start;
  while let Some((prev_start, ch)) = previous_char(text, scan) {
    if matches!(ch, ' ' | '\t') {
      scan = prev_start;
      continue;
    }
    break;
  }

  let Some((newline_start, '\n')) = previous_char(text, scan) else {
    return suffix_start;
  };
  let mut before = newline_start;
  while let Some((prev_start, ch)) = previous_char(text, before) {
    if ch == ' ' {
      before = prev_start;
      continue;
    }
    return if ch == '.' { before } else { suffix_start };
  }

  suffix_start
}

fn is_trailing_boundary(text: &str, end: usize) -> bool {
  text
    .get(end..)
    .and_then(|suffix| suffix.chars().next())
    .is_none_or(|ch| !ch.is_alphanumeric())
}

fn is_leading_separator(text: &str, suffix_start: usize) -> bool {
  let Some((prev_start, prev)) = previous_char(text, suffix_start) else {
    return true;
  };
  if prev.is_alphanumeric() {
    return false;
  }
  if prev != '.' {
    return true;
  }
  previous_char(text, prev_start).is_none_or(|(_, ch)| !ch.is_alphabetic())
}

fn walk_backward(
  text: &str,
  suffix_start: usize,
  data: &PreparedLegalFormData,
) -> Option<usize> {
  let mut pos = suffix_start;
  let mut steps = 0;
  let mut leftmost_cap = None::<usize>;
  let mut lower_bridge_run = 0_usize;
  let mut crossed_soft_wrap = false;

  while steps < HEAD_TOKEN_CAP {
    let Some(token) = token_before(text, pos, steps == 0, data) else {
      break;
    };
    let crossed_newline = text
      .get(token.end..pos)
      .is_some_and(|between| between.contains('\n'));
    if crossed_newline {
      if preceding_line_is_role_list(text, pos, data) {
        break;
      }
      if crossed_soft_wrap {
        break;
      }
      crossed_soft_wrap = true;
    }
    if !is_acceptable_token(token.text, data) {
      break;
    }
    // `45,000,000` splits into digit tokens at the skipped commas; a grouped
    // number is an amount, never a name word, so the walk ends before it
    // ("USD 45,000,000 Acme Holdings Ltd." keeps "Acme Holdings Ltd.").
    if is_grouped_number_fragment(text, &token) {
      break;
    }

    if starts_lower(token.text) && leftmost_cap.is_some() {
      if !data.bridges_lowercase(token.text) {
        break;
      }
      let after_token = text.get(token.end..pos).unwrap_or_default();
      if starts_with_list_separator(after_token)
        && is_legal_form_suffix_word(token.text, data)
      {
        break;
      }
    }

    if contains_lowercase(&data.connector_words, token.text) {
      let is_party_list_connector = data
        .and_connector_words
        .contains(lowercase_lookup(token.text).as_ref());
      let suffix_mode = leading_entity_word(text, pos).is_some_and(|word| {
        data
          .company_suffix_words
          .contains(lowercase_lookup(&word).as_ref())
      });
      if connector_has_boundary_evidence(text, &token, data)
        || (is_party_list_connector
          && !suffix_mode
          && has_middle_initial_before(text, token.start))
      {
        break;
      }
      let previous = token_before(text, token.start, false, data);
      if is_party_list_connector
        && previous.as_ref().is_some_and(|found| {
          let lower = lowercase_lookup(found.text);
          data.clause_noun_heads.contains(lower.as_ref())
            || data.connector_prose_heads.contains(lower.as_ref())
        })
      {
        break;
      }
      if previous
        .as_ref()
        .is_some_and(|found| is_legal_form_suffix_word(found.text, data))
      {
        break;
      }
    }

    if starts_upper(token.text) {
      leftmost_cap = Some(token.start);
      lower_bridge_run = 0;
    } else if starts_lower(token.text) {
      if leftmost_cap.is_some() {
        lower_bridge_run = lower_bridge_run.saturating_add(1);
        if lower_bridge_run > MAX_LOWER_BRIDGE {
          break;
        }
      }
    } else {
      lower_bridge_run = 0;
    }

    pos = token.start;
    steps = steps.saturating_add(1);
  }

  leftmost_cap
}

fn preceding_line_is_role_list(
  text: &str,
  next_line_start: usize,
  data: &PreparedLegalFormData,
) -> bool {
  let Some(before_next_line) = text.get(..next_line_start) else {
    return false;
  };
  let Some(newline_start) = before_next_line.rfind('\n') else {
    return false;
  };
  let previous_lines =
    before_next_line.get(..newline_start).unwrap_or_default();
  let line_start = previous_lines
    .rfind('\n')
    .map_or(0, |index| index.saturating_add(1));
  let line = previous_lines.get(line_start..).unwrap_or_default().trim();
  line
    .split(',')
    .map(str::trim)
    .filter(|segment| !segment.is_empty())
    .filter(|segment| segment_starts_with_role_head(segment, data))
    .take(2)
    .count()
    >= 2
}

fn segment_starts_with_role_head(
  segment: &str,
  data: &PreparedLegalFormData,
) -> bool {
  let lower = lowercase_lookup(segment);
  data.role_heads.iter().any(|role_head| {
    lower.strip_prefix(role_head).is_some_and(|rest| {
      rest.is_empty()
        || rest
          .chars()
          .next()
          .is_some_and(|character| !character.is_alphanumeric())
    })
  })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Token<'a> {
  start: usize,
  end: usize,
  text: &'a str,
}

fn token_before<'a>(
  text: &'a str,
  pos: usize,
  allow_suffix_adjacent_jurisdiction: bool,
  data: &PreparedLegalFormData,
) -> Option<Token<'a>> {
  let mut end = pos;
  while let Some((prev_start, ch)) = previous_char(text, end) {
    if ch == '\n' {
      // Soft EDGAR wrap inside a firm name: comma lists
      // ("Slate,\nMeagher & Flom LLP") or a single mid-name headword
      // ("Sidus\nSpace, Inc."). A bare paragraph break still stops.
      if !allows_soft_wrap_continuation(
        text,
        prev_start,
        allow_suffix_adjacent_jurisdiction,
        data,
      ) {
        return None;
      }
      end = prev_start;
      continue;
    }
    if ch == ')' {
      // Skip only short jurisdiction markers such as "(UK)" / "(US)" that
      // sit between the firm name and the legal-form suffix. Broader
      // parentheticals ("Licensor (Wells Fargo Bank, N.A.)") still stop the
      // walk so the role word outside the paren is not absorbed.
      if !allow_suffix_adjacent_jurisdiction {
        return None;
      }
      let open_start = jurisdiction_parenthetical_open(text, prev_start)?;
      end = open_start;
      continue;
    }
    if is_inter_token_space(ch) || matches!(ch, ',' | ';') {
      end = prev_start;
      continue;
    }
    break;
  }
  if end == 0 {
    return None;
  }

  let mut start = end;
  while let Some((prev_start, ch)) = previous_char(text, start) {
    if ch == '\n' || !is_token_char(ch) {
      break;
    }
    start = prev_start;
  }

  (start < end).then(|| Token {
    start,
    end,
    text: text.get(start..end).unwrap_or_default(),
  })
}

fn allows_soft_wrap_continuation(
  text: &str,
  newline_start: usize,
  suffix_is_the_continuation: bool,
  data: &PreparedLegalFormData,
) -> bool {
  comma_before_soft_wrap(text, newline_start, suffix_is_the_continuation)
    || single_token_name_soft_wrap(text, newline_start, data)
}

fn comma_before_soft_wrap(
  text: &str,
  newline_start: usize,
  suffix_is_the_continuation: bool,
) -> bool {
  let before_newline = text.get(..newline_start).unwrap_or_default();
  let line_start = before_newline
    .rfind('\n')
    .map_or(0, |index| index.saturating_add(1));
  let line = before_newline.get(line_start..).unwrap_or_default().trim();
  let Some(content) = line.strip_suffix(',').map(str::trim_end) else {
    return false;
  };
  if content
    .chars()
    .any(|character| character.is_numeric() || matches!(character, ':' | '：'))
  {
    return false;
  }

  let has_ampersand = content.contains('&');
  if has_ampersand {
    // A connector-complete line is a prior firm record unless the continuation
    // is the legal suffix itself: `Smith, Gambrell & Russell,\nLLP`.
    return suffix_is_the_continuation;
  }

  // Named continuations use a comma-separated surname-list shape such as
  // `Skadden, Arps, Slate,\nMeagher & Flom LLP`. Requiring three single-token,
  // mixed-case segments excludes labelled and unlabelled address lines without
  // embedding address vocabulary.
  let (segment_count, all_name_shaped) = content
    .split(',')
    .map(str::trim)
    .filter(|segment| !segment.is_empty())
    .fold((0_usize, true), |(count, valid), segment| {
      let single_token = segment.split_whitespace().count() == 1;
      let has_lowercase = segment.chars().any(char::is_lowercase);
      (
        count.saturating_add(1),
        valid && single_token && has_lowercase,
      )
    });
  segment_count >= 3 && all_name_shaped
}

/// EDGAR often wraps a one-token issuer head onto the next line before the
/// rest of a legal-form name (`Sidus\nSpace, Inc.`). Require an isolated,
/// single name-shaped token after a blank line so field labels, multi-word
/// headers, and role lists stay hard boundaries.
fn single_token_name_soft_wrap(
  text: &str,
  newline_start: usize,
  data: &PreparedLegalFormData,
) -> bool {
  let before_newline = text.get(..newline_start).unwrap_or_default();
  let line_start = before_newline
    .rfind('\n')
    .map_or(0, |index| index.saturating_add(1));
  if !previous_line_is_blank(
    before_newline.get(..line_start).unwrap_or_default(),
  ) {
    return false;
  }
  let has_organization_context =
    previous_nonempty_line_has_organization_cue(
      before_newline.get(..line_start).unwrap_or_default(),
      data,
    ) || uppercase_tokens_surround_soft_wrap(text, newline_start);
  if !has_organization_context {
    return false;
  }
  single_token_name_soft_wrap_shape(text, newline_start, data)
}

fn uppercase_tokens_surround_soft_wrap(
  text: &str,
  newline_start: usize,
) -> bool {
  let before = text
    .get(..newline_start)
    .unwrap_or_default()
    .lines()
    .next_back()
    .unwrap_or_default()
    .trim();
  let after = text
    .get(newline_start.saturating_add(1)..)
    .unwrap_or_default()
    .split_whitespace()
    .next()
    .unwrap_or_default()
    .trim_end_matches([',', ';', '.', ':']);
  let before_letters = before.chars().filter(|ch| ch.is_alphabetic()).count();
  before.split_whitespace().count() == 1
    && (2..=5).contains(&before_letters)
    && [before, after].into_iter().all(|token| {
      token.chars().any(char::is_alphabetic)
        && token
          .chars()
          .all(|ch| !ch.is_alphabetic() || ch.is_uppercase())
    })
}

fn previous_nonempty_line_has_organization_cue(
  before_current_line: &str,
  data: &PreparedLegalFormData,
) -> bool {
  let Some(line) = before_current_line
    .lines()
    .rev()
    .find(|line| !line.trim().is_empty())
  else {
    return false;
  };
  let normalized = lowercase_lookup(line);
  data
    .role_heads
    .iter()
    .chain(&data.company_suffix_words)
    .any(|cue| contains_bounded_phrase(normalized.as_ref(), cue))
}

fn contains_bounded_phrase(text: &str, phrase: &str) -> bool {
  text.match_indices(phrase).any(|(start, matched)| {
    let before = text
      .get(..start)
      .and_then(|prefix| prefix.chars().next_back());
    let end = start.saturating_add(matched.len());
    let after = text.get(end..).and_then(|suffix| suffix.chars().next());
    before.is_none_or(|ch| !ch.is_alphabetic())
      && after.is_none_or(|ch| !ch.is_alphabetic())
  })
}

fn single_token_name_soft_wrap_shape(
  text: &str,
  newline_start: usize,
  data: &PreparedLegalFormData,
) -> bool {
  let before_newline = text.get(..newline_start).unwrap_or_default();
  let line_start = before_newline
    .rfind('\n')
    .map_or(0, |index| index.saturating_add(1));
  let line = before_newline.get(line_start..).unwrap_or_default().trim();
  if line.chars().any(|character| {
    character.is_numeric() || matches!(character, ':' | '：' | ',' | '&')
  }) {
    return false;
  }
  if line.split_whitespace().count() != 1 {
    return false;
  }
  let token = line.trim_end_matches(['.', ';']);
  if !is_name_shaped_org_token(token) {
    return false;
  }
  if data.soft_wrap_boundary_labels.is_empty() {
    return false;
  }
  let lower = lowercase_lookup(token);
  if data.role_heads.contains(lower.as_ref())
    || data.soft_wrap_boundary_labels.contains(lower.as_ref())
    || data.structural_single_cap_prefixes.contains(lower.as_ref())
  {
    return false;
  }
  let after = text
    .get(newline_start.saturating_add(1)..)
    .unwrap_or_default();
  if after.starts_with('\n') {
    return false;
  }
  let after_token = after
    .trim_start_matches(is_inter_token_space)
    .split_whitespace()
    .next()
    .unwrap_or_default()
    .trim_end_matches([',', ';', '.']);
  is_name_shaped_org_token(after_token)
}

fn previous_line_is_blank(before_current_line: &str) -> bool {
  let Some(previous_lines) = before_current_line
    .strip_suffix("\r\n")
    .or_else(|| before_current_line.strip_suffix('\n'))
    .or_else(|| before_current_line.strip_suffix('\r'))
  else {
    return false;
  };
  let previous_line_start = previous_lines
    .rfind(['\r', '\n'])
    .map_or(0, |index| index.saturating_add(1));
  previous_lines
    .get(previous_line_start..)
    .is_some_and(|line| line.trim().is_empty())
}

fn is_name_shaped_org_token(token: &str) -> bool {
  let mut chars = token.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  if !first.is_uppercase() {
    return false;
  }
  for character in chars {
    if character.is_uppercase() || character.is_lowercase() {
      continue;
    }
    if matches!(character, '-' | '\'' | '’') {
      continue;
    }
    return false;
  }
  true
}

fn jurisdiction_parenthetical_open(
  text: &str,
  close_paren_start: usize,
) -> Option<usize> {
  let mut scan = close_paren_start;
  let mut letter_count = 0_usize;
  while let Some((prev_start, ch)) = previous_char(text, scan) {
    if ch == '(' {
      // ISO-style jurisdiction markers have at least two letters. Reject
      // one-letter section/schedule markers such as "(A) LLC".
      return (letter_count >= 2).then_some(prev_start);
    }
    if is_inter_token_space(ch) || ch == '.' {
      scan = prev_start;
      continue;
    }
    // Jurisdiction markers are short uppercase codes (UK, US, LLP offices).
    if !ch.is_ascii_uppercase() {
      return None;
    }
    letter_count = letter_count.saturating_add(1);
    // Cap at a few letters so "(Wells Fargo...)" never qualifies.
    if letter_count > 3 {
      return None;
    }
    scan = prev_start;
  }
  None
}

const fn is_inter_token_space(ch: char) -> bool {
  matches!(ch, ' ' | '\t' | '\r' | '\u{00a0}' | '\u{202f}')
}

fn is_token_char(ch: char) -> bool {
  ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '.' | '&' | '-')
}

fn is_acceptable_token(token: &str, data: &PreparedLegalFormData) -> bool {
  token
    .chars()
    .next()
    .is_some_and(|ch| ch.is_alphabetic() || ch.is_ascii_digit())
    || contains_lowercase(&data.connector_words, token)
}

/// A grouped number, or one group of it: `45,000,000` splits into digit
/// tokens at the skipped commas, while `3.750.000` stays one token because
/// `.` is a token character. Either way it is an amount, not a name word.
fn is_grouped_number_fragment(text: &str, token: &Token<'_>) -> bool {
  if token.text.is_empty()
    || !token
      .text
      .bytes()
      .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b','))
    || !token.text.bytes().any(|byte| byte.is_ascii_digit())
  {
    return false;
  }
  // A separator between two digits inside the token ("3.750.000").
  let grouped_inside = token.text.as_bytes().windows(3).any(|window| {
    matches!(
      window,
      [left, b'.' | b',', right]
        if left.is_ascii_digit() && right.is_ascii_digit()
    )
  });
  if grouped_inside {
    return true;
  }
  if !token.text.bytes().all(|byte| byte.is_ascii_digit()) {
    return false;
  }
  let joined_before = previous_char(text, token.start)
    .filter(|(_, ch)| matches!(ch, ',' | '.'))
    .and_then(|(separator_start, _)| previous_char(text, separator_start))
    .is_some_and(|(_, ch)| ch.is_ascii_digit());
  let joined_after = next_char(text, token.end)
    .filter(|(_, ch)| matches!(ch, ',' | '.'))
    .and_then(|(separator_start, ch)| {
      next_char(text, separator_start.saturating_add(ch.len_utf8()))
    })
    .is_some_and(|(_, ch)| ch.is_ascii_digit());
  joined_before || joined_after
}

/// Whether a `,` or `;` sits directly before `pos` (ignoring spaces).
fn list_separator_precedes(text: &str, pos: usize) -> bool {
  let mut cursor = pos;
  while let Some((char_start, ch)) = previous_char(text, cursor) {
    if is_inter_token_space(ch) {
      cursor = char_start;
      continue;
    }
    return matches!(ch, ',' | ';');
  }
  false
}

fn connector_has_boundary_evidence(
  text: &str,
  connector: &Token<'_>,
  data: &PreparedLegalFormData,
) -> bool {
  let lower = lowercase_lookup(connector.text);
  let is_party_list_connector =
    data.and_connector_words.contains(lower.as_ref());
  if is_party_list_connector && list_separator_precedes(text, connector.start) {
    return true;
  }

  let Some(previous) = simple_word_before(text, connector.start) else {
    return false;
  };
  let Some(next) = word_tokens(text, connector.end, text.len()).next() else {
    return false;
  };
  let previous_lower = lowercase_lookup(previous.text);
  let next_lower = lowercase_lookup(next.text);
  data.leading_clause_phrases.iter().any(|phrase| {
    let mut words = phrase.split_whitespace();
    words.next() == Some(previous_lower.as_ref())
      && words.next() == Some(lower.as_ref())
      && words.next() == Some(next_lower.as_ref())
      && words.next().is_none()
  })
}

fn starts_upper(text: &str) -> bool {
  text.chars().next().is_some_and(is_name_initial)
}

fn is_name_initial(character: char) -> bool {
  character.is_uppercase()
    || (!character.is_lowercase() && character.is_alphabetic())
}

fn starts_lower(text: &str) -> bool {
  text.chars().next().is_some_and(char::is_lowercase)
}

fn starts_with_list_separator(text: &str) -> bool {
  text
    .chars()
    .next()
    .is_some_and(|ch| matches!(ch, ',' | ';'))
}

fn normalize_suffix_token(text: &str) -> Cow<'_, str> {
  if !text
    .chars()
    .any(|ch| is_suffix_ignored_char(ch) || ch.is_uppercase())
  {
    return Cow::Borrowed(text);
  }

  let mut normalized = String::with_capacity(text.len());
  for ch in text.chars() {
    if is_suffix_ignored_char(ch) {
      continue;
    }
    normalized.extend(ch.to_lowercase());
  }
  Cow::Owned(normalized)
}

const fn is_suffix_ignored_char(ch: char) -> bool {
  matches!(ch, '.' | ',' | ' ' | '\t' | '\u{00a0}' | '\u{202f}')
}

fn is_legal_form_suffix_word(word: &str, data: &PreparedLegalFormData) -> bool {
  let normalized = normalize_suffix_token(word);
  !normalized.is_empty()
    && data.normalized_suffix_words.contains(normalized.as_ref())
}

fn is_known_boundary_suffix(word: &str, data: &PreparedLegalFormData) -> bool {
  let normalized = normalize_suffix_token(word);
  !normalized.is_empty()
    && data
      .normalized_boundary_suffixes
      .contains(normalized.as_ref())
}

fn is_in_name_legal_form_word(
  word: &str,
  data: &PreparedLegalFormData,
) -> bool {
  let normalized = normalize_suffix_token(word);
  !normalized.is_empty()
    && data.normalized_in_name_words.contains(normalized.as_ref())
}

fn has_middle_initial_before(text: &str, pos: usize) -> bool {
  let start = pos.saturating_sub(MAX_NAME_LOOKBACK);
  let Some(slice) = text.get(start..pos) else {
    return false;
  };
  let trimmed = slice.trim_end_matches(is_inter_token_space);
  let Some(last_word) = trailing_word(trimmed) else {
    return false;
  };
  let before_word = trimmed.get(..last_word.start).unwrap_or_default();
  let before_word = before_word.trim_end_matches(is_inter_token_space);
  let Some((dot_start, '.')) = previous_char(before_word, before_word.len())
  else {
    return false;
  };
  previous_char(before_word, dot_start).is_some_and(|(_, ch)| ch.is_uppercase())
}

fn trailing_word(text: &str) -> Option<Token<'_>> {
  let mut end = text.len();
  while let Some((prev_start, ch)) = previous_char(text, end) {
    if ch.is_alphabetic() || matches!(ch, '\'' | '’') {
      break;
    }
    end = prev_start;
  }
  let mut start = end;
  while let Some((prev_start, ch)) = previous_char(text, start) {
    if !(ch.is_alphabetic() || matches!(ch, '\'' | '’')) {
      break;
    }
    start = prev_start;
  }
  (start < end).then(|| Token {
    start,
    end,
    text: text.get(start..end).unwrap_or_default(),
  })
}

/// Scans `text[start..suffix_start]` for a sentence-ending `. ` boundary and,
/// if one is found, returns the byte offset immediately after it (the start
/// of the next word). `None` means the whole span reads as a single
/// sentence.
fn crosses_sentence_end(
  text: &str,
  start: usize,
  suffix_start: usize,
) -> Option<usize> {
  let slice = text.get(start..suffix_start)?;
  let mut previous = None::<char>;
  let mut lowercase_run = 0_usize;
  let mut uppercase_run = 0_usize;

  for (offset, ch) in slice.char_indices() {
    if ch.is_uppercase() {
      // An interior dot delimits a word, so a capital right after one starts
      // a fresh run. This keeps compact initials ("J.P.") from looking like a
      // two-letter acronym followed by a sentence break, while a real acronym
      // ("INC.") still accumulates its run before the trailing period. The
      // lowercase branch below already gates on the previous char, so only the
      // uppercase run needs this guard.
      uppercase_run = if previous == Some('.') {
        1
      } else {
        uppercase_run.saturating_add(1)
      };
      lowercase_run = 0;
      previous = Some(ch);
      continue;
    }
    if ch.is_lowercase() {
      if previous.is_some_and(char::is_uppercase) || lowercase_run > 0 {
        lowercase_run = lowercase_run.saturating_add(1);
      }
      uppercase_run = 0;
      previous = Some(ch);
      continue;
    }
    if ch == '.' {
      previous = Some(ch);
      continue;
    }
    if ch.is_whitespace() && previous == Some('.') {
      if lowercase_run >= 2 || uppercase_run >= 2 {
        return Some(
          start.saturating_add(offset).saturating_add(ch.len_utf8()),
        );
      }
      lowercase_run = 0;
      uppercase_run = 0;
    }
    previous = Some(ch);
  }

  None
}

/// Re-clips `candidate_start` past every sentence break found before
/// `suffix_start`, re-validating the trimmed remainder each time, instead of
/// discarding the whole candidate the way a single `crosses_sentence_end`
/// check used to. For "Acme Inc. Beta LLC", this narrows the `LLC` candidate
/// from "Acme Inc. Beta " down to "Beta " rather than dropping it outright,
/// so the later org is still emitted. Returns `None` only when no text is
/// left before `suffix_start` once every break has been clipped past.
fn clip_past_sentence_breaks(
  text: &str,
  start: usize,
  suffix_start: usize,
) -> Option<usize> {
  let mut candidate_start = start;
  while let Some(break_end) =
    crosses_sentence_end(text, candidate_start, suffix_start)
  {
    candidate_start = break_end;
    if candidate_start >= suffix_start {
      return None;
    }
  }
  Some(candidate_start)
}

/// Advances to the first token that can legitimately start an org name: an
/// uppercase-leading token that is not a role/clause head, or a
/// digit-leading token ("360 Ventures LLC", mirroring `trim_role_head`'s
/// digit acceptance). Used after clipping past a sentence break, where the
/// remainder may open with lowercase prose the backward walk only bridged
/// because of a capitalized token before the break. Returns `suffix_start`
/// (an empty candidate) when no such token exists.
fn trim_to_first_name_token(
  text: &str,
  start: usize,
  suffix_start: usize,
  data: &PreparedLegalFormData,
) -> usize {
  for token in word_tokens(text, start, suffix_start) {
    let starts_digit = token
      .text
      .chars()
      .next()
      .is_some_and(|ch| ch.is_ascii_digit());
    if !starts_upper(token.text) && !starts_digit {
      continue;
    }
    let lower = lowercase_lookup(token.text);
    if data.role_heads.contains(lower.as_ref())
      || data.clause_noun_heads.contains(lower.as_ref())
    {
      continue;
    }
    return token.start;
  }
  suffix_start
}

fn trim_to_first_cap_after_verb(
  text: &str,
  candidate_start: usize,
  suffix_start: usize,
  data: &PreparedLegalFormData,
) -> usize {
  if candidate_start >= suffix_start {
    return candidate_start;
  }
  let mut last_verb_end = None::<usize>;
  for token in word_tokens(text, candidate_start, suffix_start) {
    if starts_lower(token.text)
      && contains_lowercase(&data.sentence_verb_indicators, token.text)
    {
      last_verb_end = Some(token.end);
    }
  }

  let Some(scan_start) = last_verb_end else {
    return candidate_start;
  };
  for token in word_tokens(text, scan_start, suffix_start) {
    if !starts_upper(token.text) {
      continue;
    }
    let lower = lowercase_lookup(token.text);
    if data.role_heads.contains(lower.as_ref())
      || data.clause_noun_heads.contains(lower.as_ref())
    {
      continue;
    }
    return token.start;
  }

  suffix_start
}

const fn word_tokens(text: &str, start: usize, end: usize) -> WordTokens<'_> {
  WordTokens {
    text,
    end,
    cursor: start,
  }
}

struct WordTokens<'a> {
  text: &'a str,
  end: usize,
  cursor: usize,
}

impl<'a> Iterator for WordTokens<'a> {
  type Item = Token<'a>;

  fn next(&mut self) -> Option<Self::Item> {
    while self.cursor < self.end {
      let Some((ch_start, ch)) = next_char(self.text, self.cursor) else {
        self.cursor = self.end;
        return None;
      };
      if !is_word_token_char(ch) {
        self.cursor = ch_start.saturating_add(ch.len_utf8());
        continue;
      }

      let token_start = ch_start;
      let mut token_end = ch_start.saturating_add(ch.len_utf8());
      while token_end < self.end {
        let Some((next_start, next)) = next_char(self.text, token_end) else {
          break;
        };
        if !is_word_token_char(next) {
          break;
        }
        token_end = next_start.saturating_add(next.len_utf8());
      }
      self.cursor = token_end;
      let token_text = self.text.get(token_start..token_end)?;
      return Some(Token {
        start: token_start,
        end: token_end,
        text: token_text,
      });
    }
    None
  }
}

fn is_word_token_char(ch: char) -> bool {
  ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '-')
}

fn drop_overlapping(
  candidates: Vec<Candidate>,
  full_text: &str,
  data: &PreparedLegalFormData,
) -> Vec<Candidate> {
  let mut sorted = candidates;
  sorted.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| right.end.cmp(&left.end))
  });

  let mut accepted = vec![false; sorted.len()];
  let mut containment =
    CandidateContainmentIndex::new(&sorted, full_text, data);
  for index in 0..sorted.len() {
    let Some(candidate) = sorted.get(index) else {
      continue;
    };
    if containment.has_blocking_container(candidate) {
      continue;
    }
    if let Some(slot) = accepted.get_mut(index) {
      *slot = true;
    }
    containment.accept(candidate, full_text, data);
  }
  let mut out = sorted
    .into_iter()
    .zip(accepted)
    .filter_map(|(candidate, accepted)| accepted.then_some(candidate))
    .collect::<Vec<_>>();
  out.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| left.end.cmp(&right.end))
  });
  out
}

struct CandidateContainmentIndex {
  institutional_suffix_starts: Vec<usize>,
  institutional_max_ends: Vec<usize>,
  non_institutional_max_end: usize,
  delimiter_offsets: Vec<usize>,
  #[cfg(test)]
  operations: std::cell::Cell<usize>,
}

impl CandidateContainmentIndex {
  fn new(
    candidates: &[Candidate],
    full_text: &str,
    data: &PreparedLegalFormData,
  ) -> Self {
    let mut institutional_suffix_starts = candidates
      .iter()
      .filter(|candidate| {
        candidate_is_institutional(candidate, full_text, data)
      })
      .map(|candidate| candidate.matched_suffix_start)
      .collect::<Vec<_>>();
    institutional_suffix_starts.sort_unstable();
    institutional_suffix_starts.dedup();
    Self {
      institutional_max_ends: vec![
        0;
        institutional_suffix_starts
          .len()
          .saturating_add(1)
      ],
      institutional_suffix_starts,
      non_institutional_max_end: 0,
      delimiter_offsets: full_text
        .char_indices()
        .filter_map(|(offset, character)| {
          matches!(character, ',' | ';').then_some(offset)
        })
        .collect(),
      #[cfg(test)]
      operations: std::cell::Cell::new(0),
    }
  }

  fn accept(
    &mut self,
    candidate: &Candidate,
    full_text: &str,
    data: &PreparedLegalFormData,
  ) {
    if !candidate_is_institutional(candidate, full_text, data) {
      self.non_institutional_max_end =
        self.non_institutional_max_end.max(candidate.end);
      return;
    }
    let mut position = self
      .institutional_suffix_starts
      .partition_point(|start| *start < candidate.matched_suffix_start)
      .saturating_add(1);
    while position < self.institutional_max_ends.len() {
      #[cfg(test)]
      {
        self.operations.set(self.operations.get().saturating_add(1));
      }
      if let Some(max_end) = self.institutional_max_ends.get_mut(position) {
        *max_end = (*max_end).max(candidate.end);
      }
      position = position.saturating_add(position & position.wrapping_neg());
    }
  }

  fn has_blocking_container(&self, candidate: &Candidate) -> bool {
    if self.non_institutional_max_end >= candidate.end {
      return true;
    }
    let delimiter = self
      .delimiter_offsets
      .get(
        self
          .delimiter_offsets
          .partition_point(|offset| *offset < candidate.suffix_end),
      )
      .copied()
      .unwrap_or(usize::MAX);
    let mut position = self
      .institutional_suffix_starts
      .partition_point(|start| *start <= delimiter);
    let mut max_end = 0;
    while position > 0 {
      #[cfg(test)]
      {
        self.operations.set(self.operations.get().saturating_add(1));
      }
      max_end = max_end.max(
        self
          .institutional_max_ends
          .get(position)
          .copied()
          .unwrap_or_default(),
      );
      position &= position.saturating_sub(1);
    }
    max_end >= candidate.end
  }

  #[cfg(test)]
  const fn operations(&self) -> usize {
    self.operations.get()
  }
}

fn candidate_is_institutional(
  candidate: &Candidate,
  full_text: &str,
  data: &PreparedLegalFormData,
) -> bool {
  full_text
    .get(candidate.matched_suffix_start..candidate.suffix_end)
    .is_some_and(|head| {
      data
        .institutional_heads
        .contains(&normalize_suffix_token(head).to_lowercase())
    })
}

fn process_candidate(
  results: &mut Vec<PipelineEntity>,
  full_text: &str,
  candidate: &Candidate,
  data: &PreparedLegalFormData,
) {
  let Some(raw_text) = full_text.get(candidate.start..candidate.end) else {
    return;
  };
  let processed_end = candidate.start.saturating_add(trim_end_byte(raw_text));
  if processed_end <= candidate.start {
    return;
  }
  let Some(text) = full_text.get(candidate.start..processed_end) else {
    return;
  };
  if text.len() < 5 {
    return;
  }

  let mut processed_start = candidate.start;
  let mut processed_text = text;
  if is_structural_single_cap_match(processed_text, data)
    || is_bare_single_cap_structural_inner_match(
      full_text,
      candidate.start,
      processed_text,
      data,
    )
  {
    return;
  }

  let role_trimmed = if let Some(trimmed) = trim_role_head(
    full_text,
    processed_start,
    processed_text,
    candidate.suffix_start,
    data,
  ) {
    let Some(next_text) = full_text.get(trimmed.start..processed_end) else {
      return;
    };
    processed_start = trimmed.start;
    processed_text = next_text;
    true
  } else {
    false
  };

  if processed_text.contains('\n')
    && has_disallowed_line_break(processed_text, data)
  {
    return;
  }

  let (entity_start, entity_text) = candidate_entity_span(
    full_text,
    candidate,
    processed_start,
    processed_end,
    processed_text,
    role_trimmed,
    data,
  );
  emit_candidate_segments(
    results,
    full_text,
    candidate,
    text,
    entity_start,
    entity_text,
    data,
  );
}

fn candidate_entity_span<'a>(
  full_text: &'a str,
  candidate: &Candidate,
  processed_start: usize,
  processed_end: usize,
  processed_text: &'a str,
  role_trimmed: bool,
  data: &PreparedLegalFormData,
) -> (usize, &'a str) {
  if candidate.trimmed
    || role_trimmed
    || is_bare_single_cap_legal_form(processed_text)
  {
    return (processed_start, processed_text);
  }

  let extended = extend_backward(full_text, processed_start, data, false);
  if extended < processed_start
    && let Some(extended_text) = full_text.get(extended..processed_end)
  {
    return (extended, extended_text.trim_end());
  }

  (processed_start, processed_text)
}

fn emit_candidate_segments(
  results: &mut Vec<PipelineEntity>,
  full_text: &str,
  candidate: &Candidate,
  original_text: &str,
  entity_start: usize,
  entity_text: &str,
  data: &PreparedLegalFormData,
) {
  for segment in split_embedded_legal_form_list(entity_start, entity_text, data)
  {
    let (mut segment_start, mut segment_text) =
      trim_embedded_legal_form_list_prefix(segment.start, segment.text, data);
    let leading = trim_leading_clause(segment_text, data);
    if leading.offset > 0
      && let Some(trimmed) = segment_text.get(leading.offset..)
    {
      segment_start = segment_start.saturating_add(leading.offset);
      segment_text = trimmed.trim_start();
      segment_start = segment_start.saturating_add(leading_ws_len(trimmed));
    }

    if segment_text.contains('\n')
      && has_disallowed_line_break(segment_text, data)
    {
      continue;
    }

    let mut emit_start = segment_start;
    let mut emit_text = segment_text;
    let prefix = prefix_info(emit_text);
    let all_caps_match =
      prefix.part.len() > 2 && prefix.part == prefix.part.to_uppercase();
    if all_caps_match && leading.offset == 0 {
      let word_count = if prefix.end > 0 {
        emit_text
          .get(..prefix.end)
          .unwrap_or_default()
          .split_whitespace()
          .count()
      } else {
        emit_text.split_whitespace().count()
      };
      if word_count > 3 {
        emit_start = candidate.start;
        emit_text = original_text;
      }
    }

    if has_roman_numeral_suffix(emit_text) {
      continue;
    }
    if short_ascii_suffix_has_ambiguous_non_ascii_prefix(emit_text, data) {
      continue;
    }
    let end = emit_start.saturating_add(emit_text.len());
    let Some(validated_start) = named_institutional_span_start(
      full_text, emit_start, end, candidate, data,
    ) else {
      continue;
    };
    if validated_start != emit_start {
      let Some(trimmed) = full_text.get(validated_start..end) else {
        continue;
      };
      emit_start = validated_start;
      emit_text = trimmed;
    }
    results.push(PipelineEntity::detected(
      u32::try_from(emit_start).unwrap_or(u32::MAX),
      u32::try_from(end).unwrap_or(u32::MAX),
      "organization",
      emit_text,
      LEGAL_FORM_SCORE,
      DetectionSource::LegalForm,
    ));
  }
}

fn named_institutional_span_start(
  full_text: &str,
  emit_start: usize,
  emit_end: usize,
  candidate: &Candidate,
  data: &PreparedLegalFormData,
) -> Option<usize> {
  let candidate_head = full_text
    .get(candidate.matched_suffix_start..candidate.suffix_end)
    .filter(|head| {
      data
        .institutional_heads
        .contains(&normalize_suffix_token(head).to_lowercase())
    })
    .and_then(|_| {
      (emit_start <= candidate.matched_suffix_start
        && candidate.suffix_end <= emit_end)
        .then_some((candidate.matched_suffix_start, candidate.suffix_end))
    });
  let Some((head_start, head_end)) = candidate_head.or_else(|| {
    trailing_institutional_head_span(full_text, emit_start, emit_end, data)
  }) else {
    return Some(emit_start);
  };

  let prefix = full_text.get(emit_start..head_start)?;
  match institutional_fragment_has_specific_name(prefix, data, false) {
    None => word_tokens(full_text, emit_start, head_start)
      .skip(1)
      .filter(|token| {
        let lower = lowercase_lookup(token.text);
        let dotted_prefix =
          is_configured_dotted_institutional_prefix(full_text, token.end, data);
        starts_upper(token.text)
          && (dotted_prefix
            || (!data.institutional_generic_words.contains(lower.as_ref())
              && !data
                .institutional_prefix_generic_words
                .contains(lower.as_ref())
              && !data
                .institutional_complement_connectors
                .contains(lower.as_ref())
              && !matches!(lower.as_ref(), "apos" | "rsquo" | "s")))
      })
      .find_map(|token| {
        full_text
          .get(token.start..head_start)
          .and_then(|trimmed_prefix| {
            (institutional_fragment_has_specific_name(
              trimmed_prefix,
              data,
              false,
            ) == Some(true))
            .then_some(token.start)
          })
      }),
    Some(true) => Some(emit_start),
    Some(false) => full_text
      .get(head_end..emit_end)
      .and_then(|complement| {
        institutional_fragment_has_specific_name(complement, data, true)
      })
      .is_some_and(|specific| specific)
      .then_some(emit_start),
  }
}

fn trailing_institutional_head_span(
  full_text: &str,
  emit_start: usize,
  emit_end: usize,
  data: &PreparedLegalFormData,
) -> Option<(usize, usize)> {
  let emitted = full_text.get(emit_start..emit_end)?;
  data
    .suffixes
    .iter()
    .filter(|suffix| {
      emitted.ends_with(suffix.as_str())
        && data
          .institutional_heads
          .contains(&normalize_suffix_token(suffix).to_lowercase())
    })
    .max_by_key(|suffix| suffix.len())
    .map(|suffix| (emit_end.saturating_sub(suffix.len()), emit_end))
}

fn institutional_fragment_has_specific_name(
  fragment: &str,
  data: &PreparedLegalFormData,
  is_complement: bool,
) -> Option<bool> {
  if fragment.char_indices().any(|(index, character)| {
    matches!(character, ',' | ':' | '!' | '?' | '\n' | '\r')
      || (character == '.'
        && !is_dotted_uppercase_acronym_period(fragment, index)
        && !is_configured_dotted_institutional_prefix(fragment, index, data))
  }) {
    return None;
  }

  let mut specific = false;
  for token in word_tokens(fragment, 0, fragment.len()) {
    let lower = lowercase_lookup(token.text);
    if data.institutional_generic_words.contains(lower.as_ref())
      || (!is_complement
        && data
          .institutional_prefix_generic_words
          .contains(lower.as_ref()))
      || data
        .institutional_complement_connectors
        .contains(lower.as_ref())
      || matches!(lower.as_ref(), "apos" | "rsquo" | "s")
    {
      continue;
    }
    if starts_upper(token.text) {
      specific = true;
      continue;
    }
    if token
      .text
      .chars()
      .all(|character| character.is_ascii_digit())
    {
      if !matches!(token.text, "39" | "8217") {
        specific = true;
      }
      continue;
    }
    return None;
  }
  Some(specific)
}

fn is_configured_dotted_institutional_prefix(
  text: &str,
  period_start: usize,
  data: &PreparedLegalFormData,
) -> bool {
  if text.as_bytes().get(period_start) != Some(&b'.') {
    return false;
  }
  let Some(token) = word_tokens(text, 0, period_start).last() else {
    return false;
  };
  token.end == period_start
    && token.text.chars().count() <= 3
    && data
      .institutional_prefix_generic_words
      .contains(lowercase_lookup(token.text).as_ref())
    && next_char(text, period_start.saturating_add(1))
      .is_none_or(|(_, character)| character.is_whitespace())
}

fn is_dotted_uppercase_acronym_period(text: &str, period_start: usize) -> bool {
  let Some((letter_start, letter)) = previous_char(text, period_start) else {
    return false;
  };
  if !letter.is_ascii_uppercase() {
    return false;
  }

  let after_period = period_start.saturating_add('.'.len_utf8());
  if text
    .get(after_period..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(|next| next.is_ascii_uppercase())
  {
    return true;
  }

  let Some((prior_period_start, '.')) = previous_char(text, letter_start)
  else {
    return false;
  };
  previous_char(text, prior_period_start)
    .is_some_and(|(_, prior_letter)| prior_letter.is_ascii_uppercase())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TrimmedStart {
  start: usize,
}

fn trim_role_head(
  full_text: &str,
  match_start: usize,
  text: &str,
  suffix_start: usize,
  data: &PreparedLegalFormData,
) -> Option<TrimmedStart> {
  let first = first_role_word(text)?;
  let first_lower = lowercase_lookup(first.text);
  let first_leading = first.text.split('-').next().unwrap_or_default();
  let first_leading = lowercase_lookup(first_leading);
  if !data.role_heads.contains(first_lower.as_ref())
    && !data.role_heads.contains(first_leading.as_ref())
  {
    return None;
  }

  let suffix_offset = suffix_start.checked_sub(match_start)?;
  if suffix_offset >= text.len() {
    return None;
  }
  let mid_start = first.end;
  if mid_start >= suffix_offset {
    return None;
  }
  let mid = text.get(mid_start..suffix_offset).unwrap_or_default();
  let mut last_verb_end = None::<usize>;
  for token in word_tokens(text, mid_start, suffix_offset) {
    if data
      .sentence_verb_indicators
      .contains(lowercase_lookup(token.text).as_ref())
    {
      last_verb_end = Some(token.end);
    }
  }
  let digit_after_role = mid
    .trim_start()
    .chars()
    .next()
    .is_some_and(|ch| ch.is_ascii_digit());
  let appositive_role_head = !digit_after_role
    && last_verb_end.is_none()
    && preceding_word_is_sentence_verb(full_text, match_start, data);

  if last_verb_end.is_none() && !digit_after_role && !appositive_role_head {
    return None;
  }

  let scan_start = last_verb_end.unwrap_or(mid_start);
  for token in word_tokens(text, scan_start, suffix_offset) {
    // A digit-leading token ("360", "1") is a valid span start alongside an
    // uppercase-leading one: "Client 360 LLC" / "Vendor 1 LLC" put the
    // digit right after the role word with no later capitalized word to
    // recover on, so restricting the scan to starts_upper alone clipped the
    // whole name down to the bare suffix.
    let starts_digit = token
      .text
      .chars()
      .next()
      .is_some_and(|ch| ch.is_ascii_digit());
    if !starts_upper(token.text) && !starts_digit {
      continue;
    }
    let lower = lowercase_lookup(token.text);
    if data.role_heads.contains(lower.as_ref())
      || data.clause_noun_heads.contains(lower.as_ref())
    {
      continue;
    }
    return Some(TrimmedStart {
      start: match_start.saturating_add(token.start),
    });
  }

  Some(TrimmedStart {
    start: match_start.saturating_add(suffix_offset),
  })
}

fn first_role_word(text: &str) -> Option<Token<'_>> {
  let mut end = 0_usize;
  let mut saw = false;
  let mut previous_was_hyphen = false;
  while let Some((start, ch)) = next_char(text, end) {
    if ch.is_alphabetic() {
      saw = true;
      previous_was_hyphen = false;
      end = start.saturating_add(ch.len_utf8());
      continue;
    }
    if ch == '-' && saw {
      previous_was_hyphen = true;
      end = start.saturating_add(ch.len_utf8());
      continue;
    }
    if previous_was_hyphen {
      end = start.saturating_sub('-'.len_utf8());
    }
    break;
  }
  (saw && end > 0).then(|| Token {
    start: 0,
    end,
    text: text.get(..end).unwrap_or_default(),
  })
}

fn preceding_word_is_sentence_verb(
  full_text: &str,
  match_start: usize,
  data: &PreparedLegalFormData,
) -> bool {
  let window_start = match_start.saturating_sub(40);
  let Some(before) = full_text.get(window_start..match_start) else {
    return false;
  };
  trailing_word(before).is_some_and(|word| {
    data
      .sentence_verb_indicators
      .contains(lowercase_lookup(word.text).as_ref())
  })
}

fn is_structural_single_cap_match(
  text: &str,
  data: &PreparedLegalFormData,
) -> bool {
  let mut tokens = text.split_whitespace();
  let Some(first) = tokens.next() else {
    return false;
  };
  let Some(second) = tokens.next() else {
    return false;
  };
  data
    .structural_single_cap_prefixes
    .contains(lowercase_lookup(first).as_ref())
    && is_single_cap_token(second.trim_matches(','))
}

fn is_bare_single_cap_structural_inner_match(
  full_text: &str,
  match_start: usize,
  text: &str,
  data: &PreparedLegalFormData,
) -> bool {
  if !is_bare_single_cap_legal_form(text) {
    return false;
  }
  token_before(full_text, match_start, false, data).is_some_and(|token| {
    data
      .structural_single_cap_prefixes
      .contains(lowercase_lookup(token.text).as_ref())
  })
}

fn is_bare_single_cap_legal_form(text: &str) -> bool {
  let Some(first) = text.chars().next() else {
    return false;
  };
  if !first.is_uppercase() {
    return false;
  }
  let after_first = text.get(first.len_utf8()..).unwrap_or_default();
  after_first
    .chars()
    .next()
    .is_some_and(|ch| is_inter_token_space(ch) || ch == ',')
}

fn is_single_cap_token(text: &str) -> bool {
  let mut chars = text.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  first.is_uppercase() && chars.next().is_none()
}

fn has_disallowed_line_break(text: &str, data: &PreparedLegalFormData) -> bool {
  let mut search_start = 0_usize;
  while let Some(relative) =
    text.get(search_start..).and_then(|tail| tail.find('\n'))
  {
    let index = search_start.saturating_add(relative);
    let before = text.get(..index).unwrap_or_default();
    let after = text.get(index.saturating_add(1)..).unwrap_or_default();
    let before_trimmed = before.trim_end_matches(is_inter_token_space);
    let dotted_designator_before = before_trimmed.ends_with('.');
    // EDGAR often soft-wraps comma-separated firm names:
    // "Skadden, Arps, Slate,\nMeagher & Flom LLP".
    let comma_continuation_before = before_trimmed.ends_with(',');
    let after_trimmed = after.trim_matches(is_inter_token_space);
    let legal_suffix_after = is_dotted_upper_suffix(after_trimmed);
    let all_caps_suffix_after = after_trimmed
      .trim_end_matches('.')
      .chars()
      .all(char::is_uppercase)
      && after_trimmed.chars().any(char::is_uppercase);
    let upper_name_after =
      after_trimmed.chars().next().is_some_and(is_name_initial);
    // The backward walk already established the blank-line evidence. This
    // span-local pass only rechecks the mid-name shape.
    let single_token_name_continuation =
      single_token_name_soft_wrap_shape(text, index, data);
    let allowed = (comma_continuation_before && upper_name_after)
      || single_token_name_continuation
      || (dotted_designator_before
        && (legal_suffix_after || all_caps_suffix_after));
    if !allowed {
      return true;
    }
    search_start = index.saturating_add(1);
  }
  false
}

fn is_dotted_upper_suffix(text: &str) -> bool {
  let mut saw_upper = false;
  for part in text.split('.') {
    if part.is_empty() {
      continue;
    }
    if !part.chars().all(char::is_uppercase) {
      return false;
    }
    saw_upper = true;
  }
  saw_upper
}

fn extend_backward(
  full_text: &str,
  match_start: usize,
  data: &PreparedLegalFormData,
  force_suffix_mode: bool,
) -> usize {
  let head_word = leading_entity_word(full_text, match_start);
  let suffix_mode = force_suffix_mode
    || head_word
      .as_ref()
      .is_some_and(|word| contains_lowercase(&data.company_suffix_words, word));
  let mut pos = match_start;

  while let Some(found) = simple_word_before(full_text, pos) {
    let word = found.text;
    let lower = lowercase_lookup(word);
    let is_upper = starts_upper(word);
    let is_connector = data.connector_words.contains(lower.as_ref());
    let is_in_name_prep =
      suffix_mode && data.in_name_prepositions.contains(lower.as_ref());

    if is_upper {
      pos = found.start;
      continue;
    }

    if is_connector {
      let is_party_list_connector =
        data.and_connector_words.contains(lower.as_ref());
      if connector_has_boundary_evidence(full_text, &found, data) {
        break;
      }
      let Some(previous) = simple_word_before(full_text, found.start) else {
        break;
      };
      let continues_company_name = leading_entity_word(full_text, pos)
        .is_some_and(|leading_word| {
          data
            .company_suffix_words
            .contains(lowercase_lookup(&leading_word).as_ref())
        });
      if !starts_upper(previous.text)
        || (!continues_company_name
          && (is_known_boundary_suffix(previous.text, data)
            || data.institutional_heads.contains(
              normalize_suffix_token(previous.text)
                .to_lowercase()
                .as_str(),
            )))
      {
        break;
      }
      if is_party_list_connector {
        let upper_before =
          count_upper_words_before(full_text, found.start, suffix_mode, data);
        let middle_initial = has_middle_initial_before(full_text, found.start);
        if upper_before <= 1
          && (data
            .clause_noun_heads
            .contains(lowercase_lookup(previous.text).as_ref())
            || data
              .connector_prose_heads
              .contains(lowercase_lookup(previous.text).as_ref()))
        {
          break;
        }
        // A bare "exactly two capitalized words" run before the connector is
        // not, by itself, evidence of a person name: it equally matches a
        // two-word company prefix ("Acme Widgets and Bar, Inc."), and
        // blocking on word count alone left that prefix unredacted. Require
        // actual person-name evidence (a dotted middle initial, optionally
        // paired with a single-cap lead-in for the suffix-first case) before
        // refusing to extend across the connector. Even then, a connector
        // word already known to be a legal-form word inside a name (e.g.
        // "Trust") overrides the initial and lets the walk continue, since
        // that is corroborating evidence for a company name, not a person.
        let person_name_boundary = if suffix_mode {
          middle_initial && has_single_cap_prefix_before(full_text, match_start)
        } else {
          middle_initial && !is_in_name_legal_form_word(previous.text, data)
        };
        if person_name_boundary {
          break;
        }
      }
      pos = previous.start;
      continue;
    }

    if is_in_name_prep {
      let Some(previous) = simple_word_before(full_text, found.start) else {
        break;
      };
      if !starts_upper(previous.text) {
        break;
      }
      pos = previous.start;
      continue;
    }

    break;
  }

  skip_initials_backward(full_text, pos)
}

fn simple_word_before(text: &str, pos: usize) -> Option<Token<'_>> {
  let mut end = pos;
  while let Some((prev_start, ch)) = previous_char(text, end) {
    if ch == '\n' {
      return None;
    }
    if ch.is_whitespace() {
      end = prev_start;
      continue;
    }
    break;
  }

  let mut start = end;
  while let Some((prev_start, ch)) = previous_char(text, start) {
    if !(ch.is_alphabetic() || ch == '&') {
      break;
    }
    start = prev_start;
  }

  (start < end).then(|| Token {
    start,
    end,
    text: text.get(start..end).unwrap_or_default(),
  })
}

fn leading_entity_word(text: &str, start: usize) -> Option<String> {
  let mut end = start;
  while let Some((ch_start, ch)) = next_char(text, end) {
    if !(ch.is_alphabetic() || ch == '&') {
      break;
    }
    end = ch_start.saturating_add(ch.len_utf8());
  }
  (end > start).then(|| text.get(start..end).unwrap_or_default().to_owned())
}

fn count_upper_words_before(
  full_text: &str,
  pos: usize,
  cross_in_name_preps: bool,
  data: &PreparedLegalFormData,
) -> usize {
  let mut count = 0_usize;
  let mut scan = pos;
  while scan > 0 {
    let Some(found) = simple_word_before(full_text, scan) else {
      break;
    };
    if starts_upper(found.text) {
      count = count.saturating_add(1);
      scan = found.start;
      continue;
    }
    if cross_in_name_preps
      && data
        .in_name_prepositions
        .contains(lowercase_lookup(found.text).as_ref())
    {
      let Some(previous) = simple_word_before(full_text, found.start) else {
        break;
      };
      if !starts_upper(previous.text) {
        break;
      }
      scan = found.start;
      continue;
    }
    break;
  }
  count
}

fn has_single_cap_prefix_before(full_text: &str, match_start: usize) -> bool {
  simple_word_before(full_text, match_start)
    .is_some_and(|word| is_single_cap_token(word.text))
}

fn skip_initials_backward(full_text: &str, pos: usize) -> usize {
  let mut cursor = pos;
  let mut start = pos;
  let mut initial_count = 0_usize;
  loop {
    while let Some((previous_start, ch)) = previous_char(full_text, cursor) {
      if !is_inter_token_space(ch) {
        break;
      }
      cursor = previous_start;
    }
    let Some((dot_start, '.')) = previous_char(full_text, cursor) else {
      break;
    };
    let Some((letter_start, letter)) = previous_char(full_text, dot_start)
    else {
      break;
    };
    if !letter.is_uppercase() {
      break;
    }
    start = letter_start;
    initial_count = initial_count.saturating_add(1);
    cursor = letter_start;
  }

  if initial_count >= 2
    && previous_char(full_text, start)
      .is_none_or(|(_, ch)| !ch.is_alphanumeric())
  {
    return start;
  }
  pos
}

#[derive(Clone, Copy, Debug)]
struct Segment<'a> {
  start: usize,
  text: &'a str,
}

fn split_embedded_legal_form_list<'a>(
  entity_start: usize,
  entity_text: &'a str,
  data: &PreparedLegalFormData,
) -> Vec<Segment<'a>> {
  if !entity_text.contains([',', ';']) {
    return vec![Segment {
      start: entity_start,
      text: entity_text,
    }];
  }

  let mut cuts = vec![0_usize];
  for (suffix_end, _) in entity_text.match_indices([',', ';']) {
    let Some(before) = entity_text.get(..suffix_end) else {
      continue;
    };
    if !ends_with_list_suffix(before, data) {
      continue;
    }
    let Some(after) = entity_text.get(suffix_end..) else {
      continue;
    };
    let boundary_len = legal_list_boundary_len(after);
    if boundary_len > 0
      && following_list_segment_has_name(after, boundary_len, data)
    {
      cuts.push(suffix_end.saturating_add(boundary_len));
    }
  }

  cuts.sort_unstable();
  cuts.dedup();
  if cuts.len() == 1 {
    return vec![Segment {
      start: entity_start,
      text: entity_text,
    }];
  }

  let mut segments = Vec::new();
  for (index, start) in cuts.iter().enumerate() {
    let end = cuts
      .get(index.saturating_add(1))
      .copied()
      .unwrap_or(entity_text.len());
    if *start >= end {
      continue;
    }
    let Some(segment) = entity_text.get(*start..end) else {
      continue;
    };
    let trimmed = segment.trim_end_matches(|ch: char| {
      ch.is_whitespace() || matches!(ch, ',' | ';')
    });
    if trimmed.is_empty()
      || (!has_name_before_trailing_list_suffix(trimmed, data)
        && !starts_with_named_institutional_complement(trimmed, data))
    {
      continue;
    }
    segments.push(Segment {
      start: entity_start.saturating_add(*start),
      text: trimmed,
    });
  }

  segments
}

fn following_list_segment_has_name(
  after_suffix: &str,
  boundary_len: usize,
  data: &PreparedLegalFormData,
) -> bool {
  let Some(after_boundary) = after_suffix.get(boundary_len..) else {
    return false;
  };
  let segment_end = after_boundary
    .find([',', ';'])
    .unwrap_or(after_boundary.len());
  let segment = after_boundary.get(..segment_end).unwrap_or_default().trim();
  if has_name_before_trailing_list_suffix(segment, data) {
    return true;
  }
  if starts_with_named_institutional_complement(segment, data) {
    return true;
  }

  // A list member can itself use the conventional comma before its legal
  // form ("Acme Holdings, Inc."). Look through exactly one such comma, but
  // still require a real name before the suffix so ", Inc." is never treated
  // as a separate organization.
  let Some(after_comma) = after_boundary.get(segment_end..) else {
    return false;
  };
  let Some(after_comma) = after_comma.strip_prefix(',') else {
    return false;
  };
  let legal_form_end =
    after_comma.find([',', ';']).unwrap_or(after_comma.len());
  let legal_form = after_comma.get(..legal_form_end).unwrap_or_default().trim();
  if legal_form.is_empty() {
    return false;
  }
  let combined_len = segment_end
    .saturating_add(','.len_utf8())
    .saturating_add(legal_form_end);
  after_boundary
    .get(..combined_len)
    .map(str::trim)
    .is_some_and(|combined| {
      has_name_before_trailing_list_suffix(combined, data)
    })
}

fn starts_with_named_institutional_complement(
  segment: &str,
  data: &PreparedLegalFormData,
) -> bool {
  data
    .suffixes
    .iter()
    .filter(|head| {
      data
        .institutional_heads
        .contains(&normalize_suffix_token(head).to_lowercase())
    })
    .filter_map(|head| {
      segment.strip_prefix(head).filter(|rest| {
        rest
          .chars()
          .next()
          .is_some_and(|character| !character.is_alphanumeric())
      })
    })
    .any(|complement| {
      institutional_fragment_has_specific_name(complement, data, true)
        == Some(true)
    })
}

fn has_name_before_trailing_list_suffix(
  segment: &str,
  data: &PreparedLegalFormData,
) -> bool {
  longest_trailing_suffix(
    segment,
    &data.list_suffix_indices_by_last_char,
    &data.suffixes,
  )
  .and_then(|suffix| segment.get(..segment.len().saturating_sub(suffix.len())))
  .is_some_and(|prefix| prefix.chars().any(char::is_alphanumeric))
}

fn legal_list_boundary_len(text: &str) -> usize {
  let mut chars = text.char_indices();
  let Some((_, first)) = chars.next() else {
    return 0;
  };
  if !matches!(first, ',' | ';') {
    return 0;
  }
  let mut end = first.len_utf8();
  let mut saw_space = false;
  for (index, ch) in chars {
    if ch.is_whitespace() {
      saw_space = true;
      end = index.saturating_add(ch.len_utf8());
      continue;
    }
    if saw_space && (is_name_initial(ch) || ch == '.') {
      return end;
    }
    return 0;
  }
  0
}

fn ends_with_legal_suffix(text: &str, data: &PreparedLegalFormData) -> bool {
  let Some(last) = text.chars().next_back() else {
    return false;
  };
  data
    .suffix_indices_by_last_char
    .get(&last)
    .is_some_and(|indices| {
      indices.iter().any(|index| {
        data
          .suffixes
          .get(*index)
          .is_some_and(|suffix| text.ends_with(suffix))
      })
    })
}

fn trim_embedded_legal_form_list_prefix<'a>(
  entity_start: usize,
  entity_text: &'a str,
  data: &PreparedLegalFormData,
) -> (usize, &'a str) {
  if !entity_text.contains(',') {
    return (entity_start, entity_text);
  }

  let mut cut = 0_usize;
  for (suffix_end, _) in entity_text.match_indices(',') {
    let Some(before) = entity_text.get(..suffix_end) else {
      continue;
    };
    if !ends_with_list_suffix(before, data) {
      continue;
    }
    let Some(after) = entity_text.get(suffix_end..) else {
      continue;
    };
    let boundary_len = comma_upper_boundary_len(after);
    if boundary_len == 0
      || !following_list_segment_has_name(after, boundary_len, data)
    {
      continue;
    }
    let next_start = suffix_end.saturating_add(boundary_len);
    if entity_text.get(next_start..).is_some_and(|remainder| {
      ends_with_legal_suffix(remainder, data)
        || starts_with_named_institutional_complement(remainder, data)
    }) {
      cut = cut.max(next_start);
    }
  }

  if cut == 0 {
    return (entity_start, entity_text);
  }
  (
    entity_start.saturating_add(cut),
    entity_text.get(cut..).unwrap_or_default(),
  )
}

fn is_digit_grouping_comma(before: &str, after: &str) -> bool {
  before.ends_with(|ch: char| ch.is_ascii_digit())
    && after.len() >= 3
    && after.bytes().take(3).all(|byte| byte.is_ascii_digit())
}

fn comma_upper_boundary_len(text: &str) -> usize {
  let Some(stripped) = text.strip_prefix(',') else {
    return 0;
  };
  let ws_len = leading_ws_len(stripped);
  if ws_len == 0 {
    return 0;
  }
  let after_ws = stripped.get(ws_len..).unwrap_or_default();
  if after_ws.chars().next().is_some_and(is_name_initial) {
    return ','.len_utf8().saturating_add(ws_len);
  }
  0
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LeadingTrim {
  offset: usize,
}

fn trim_leading_clause(
  text: &str,
  data: &PreparedLegalFormData,
) -> LeadingTrim {
  // Search on a lowercased copy for case-insensitive matching, but keep a map
  // back to original byte offsets. `to_lowercase()` can change byte lengths
  // ("İ" U+0130 -> "i" + U+0307), so any offset taken from `lower` must be
  // translated before it is used to slice the original `text` or returned as a
  // cut (the caller slices the original with it).
  let (lower, lower_to_orig) = lowercase_with_offset_map(text);
  let to_orig =
    |offset: usize| lower_to_orig.get(offset).copied().unwrap_or(text.len());
  let mut cut = 0_usize;

  for phrase in &data.leading_clause_phrases {
    let mut search_from = 0_usize;
    while let Some(relative) =
      lower.get(search_from..).and_then(|tail| tail.find(phrase))
    {
      let start = search_from.saturating_add(relative);
      let end = start.saturating_add(phrase.len());
      search_from = end;
      let before_ok = start == 0
        || lower
          .get(..start)
          .and_then(|prefix| prefix.chars().next_back())
          .is_some_and(char::is_whitespace);
      let after_ws = lower.get(end..).map(leading_ws_len).unwrap_or_default();
      if before_ok && after_ws > 0 {
        cut = cut.max(to_orig(end.saturating_add(after_ws)));
      }
    }
  }

  for prefix in &data.leading_clause_direct_prefixes {
    let mut search_from = 0_usize;
    while let Some(relative) = lower
      .get(search_from..)
      .and_then(|tail| find_word_at_boundary(tail, prefix))
    {
      let start = search_from.saturating_add(relative);
      let end = start.saturating_add(prefix.len());
      search_from = end;
      let after_ws = lower.get(end..).map(leading_ws_len).unwrap_or_default();
      let after_orig = to_orig(end.saturating_add(after_ws));
      // The company name after the prefix must be capitalized. Read the
      // original text (in original byte offsets), not the lowercased copy, or
      // this check never passes.
      let after = text
        .get(after_orig..)
        .and_then(|suffix| suffix.chars().next());
      if after_ws == 0 || !after.is_some_and(char::is_uppercase) {
        continue;
      }

      let before = text.get(..to_orig(start)).unwrap_or_default();
      let prefix_lower = prefix.to_lowercase();
      if data.comma_gated_direct_prefixes.contains(&prefix_lower) {
        let has_comma = before.trim_end().ends_with(',');
        let has_sentence_verb =
          word_tokens(before, 0, before.len()).any(|word| {
            starts_lower(word.text)
              && data
                .sentence_verb_indicators
                .contains(lowercase_lookup(word.text).as_ref())
          });
        if !has_comma && !has_sentence_verb {
          continue;
        }
      }

      let mut word_count = 0_usize;
      let mut has_lower_word = false;
      for word in word_tokens(before, 0, before.len()) {
        word_count = word_count.saturating_add(1);
        has_lower_word |= starts_lower(word.text);
      }
      let has_prose_prefix = word_count >= 3 && has_lower_word;
      if has_prose_prefix {
        cut = cut.max(after_orig);
      }
    }
  }

  for (comma, _) in text.match_indices(',') {
    let before = text.get(..comma).unwrap_or_default();
    if !before.chars().any(|ch| ch.is_ascii_digit()) {
      continue;
    }
    let after = text.get(comma.saturating_add(1)..).unwrap_or_default();
    // A thousands separator ("45,000,000") is not a clause boundary.
    if is_digit_grouping_comma(before, after) {
      continue;
    }
    let ws = leading_ws_len(after);
    let candidate = after.get(ws..).unwrap_or_default();
    let upper_words = word_tokens(candidate, 0, candidate.len())
      .filter(|word| starts_upper(word.text))
      .count();
    if upper_words >= 3 {
      cut = cut.max(comma.saturating_add(1).saturating_add(ws));
    }
  }

  LeadingTrim { offset: cut }
}

/// Lowercase `text`, returning the folded string plus a table that maps each
/// byte offset in the folded string back to the byte offset of the original
/// character that produced it. The final entry maps the end of the folded
/// string to `text.len()`. Case folding can change byte lengths, so offsets
/// found in the folded copy must be translated through this table before they
/// index or slice the original text.
fn lowercase_with_offset_map(text: &str) -> (String, Vec<usize>) {
  let mut lower = String::with_capacity(text.len());
  let mut lower_to_orig = Vec::with_capacity(text.len().saturating_add(1));
  for (orig_idx, ch) in text.char_indices() {
    for folded in ch.to_lowercase() {
      lower.push(folded);
      lower_to_orig.resize(lower.len(), orig_idx);
    }
  }
  lower_to_orig.push(text.len());
  (lower, lower_to_orig)
}

fn find_word_at_boundary(haystack: &str, needle: &str) -> Option<usize> {
  let mut from = 0_usize;
  while let Some(relative) = haystack.get(from..)?.find(needle) {
    let start = from.saturating_add(relative);
    let end = start.saturating_add(needle.len());
    let left_ok = previous_char(haystack, start)
      .is_none_or(|(_, ch)| !ch.is_alphanumeric());
    let right_ok = haystack
      .get(end..)
      .and_then(|suffix| suffix.chars().next())
      .is_none_or(|ch| !ch.is_alphanumeric());
    if left_ok && right_ok {
      return Some(start);
    }
    from = end;
  }
  None
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PrefixInfo {
  end: usize,
  part: String,
}

fn prefix_info(text: &str) -> PrefixInfo {
  let end = text.rfind(',').or_else(|| text.rfind(' ')).unwrap_or(0);
  let source = if end > 0 {
    text.get(..end).unwrap_or_default()
  } else {
    text
  };
  PrefixInfo {
    end,
    part: source.chars().filter(|ch| ch.is_alphabetic()).collect(),
  }
}

fn has_roman_numeral_suffix(text: &str) -> bool {
  let separator = last_suffix_separator(text);
  let raw_suffix = separator
    .and_then(|index| text.get(index.saturating_add(1)..))
    .unwrap_or_default();
  let suffix = clean_suffix(raw_suffix);
  !suffix.is_empty() && is_roman_numeral(&suffix)
}

fn short_ascii_suffix_has_ambiguous_non_ascii_prefix(
  text: &str,
  data: &PreparedLegalFormData,
) -> bool {
  let separator = last_suffix_separator(text);
  let raw_suffix = separator
    .and_then(|index| text.get(index.saturating_add(1)..))
    .unwrap_or_default();
  let suffix = clean_suffix(raw_suffix);
  if suffix.len() > 2 || raw_suffix.contains('.') {
    return false;
  }
  let prefix = separator
    .and_then(|index| text.get(..index))
    .unwrap_or(text)
    .trim_matches(|ch: char| {
      ch.is_whitespace() || matches!(ch, '\u{00a0}' | '\u{202f}')
    });
  if prefix.is_ascii() {
    return false;
  }
  if !data
    .non_ascii_name_short_suffixes
    .contains(&suffix.to_lowercase())
  {
    return true;
  }

  // A short bare suffix is easily confused with an ordinary uppercase
  // abbreviation. Inspect the active phrase after the last clause separator;
  // a trailing separator belongs to the legal-name punctuation itself.
  let last_clause_separator = prefix
    .char_indices()
    .rev()
    .find(|(_, ch)| matches!(ch, ',' | ';' | ':'))
    .map(|(index, ch)| (index, ch.len_utf8()));
  let active = last_clause_separator
    .and_then(|(index, width)| prefix.get(index.saturating_add(width)..))
    .map(str::trim)
    .filter(|tail| !tail.is_empty())
    .or_else(|| {
      last_clause_separator
        .and_then(|(index, _)| prefix.get(..index))
        .map(str::trim)
    })
    .unwrap_or(prefix);
  let tokens = word_tokens(active, 0, active.len()).collect::<Vec<_>>();
  let starts_like_name =
    tokens.first().is_some_and(|token| starts_upper(token.text));
  let capitalized = tokens
    .iter()
    .filter(|token| starts_upper(token.text))
    .count();

  !starts_like_name || (tokens.len() > 3 && capitalized < 2)
}

fn last_suffix_separator(text: &str) -> Option<usize> {
  text
    .char_indices()
    .filter_map(|(index, ch)| {
      matches!(ch, ' ' | '\t' | '\u{00a0}' | '\u{202f}' | ',').then_some(index)
    })
    .next_back()
}

fn clean_suffix(text: &str) -> String {
  text.chars().filter(|ch| !matches!(ch, '.' | ',')).collect()
}

fn is_roman_legal_suffix(text: &str) -> bool {
  let suffix = clean_suffix(text);
  !suffix.is_empty() && is_roman_numeral(&suffix)
}

fn ends_with_list_suffix(text: &str, data: &PreparedLegalFormData) -> bool {
  longest_trailing_suffix(
    text,
    &data.list_suffix_indices_by_last_char,
    &data.suffixes,
  )
  .is_some()
}

fn longest_trailing_suffix<'a>(
  text: &str,
  indices_by_last_char: &HashMap<char, Vec<usize>>,
  suffixes: &'a [String],
) -> Option<&'a str> {
  let last = text.chars().next_back()?;
  indices_by_last_char
    .get(&last)?
    .iter()
    .filter_map(|index| suffixes.get(*index))
    .filter(|suffix| text.ends_with(suffix.as_str()))
    .max_by_key(|suffix| suffix.len())
    .map(String::as_str)
}

fn is_roman_numeral(text: &str) -> bool {
  if text.is_empty()
    || !text.chars().next().is_some_and(|ch| {
      ch == 'I'
        || ch == 'V'
        || ch == 'X'
        || ch == 'L'
        || ch == 'C'
        || ch == 'D'
        || ch == 'M'
    })
  {
    return false;
  }

  let bytes = text.as_bytes();
  let mut index = 0_usize;

  let _ = take_repeated(bytes, &mut index, b'M', 3);

  if consume_pair(bytes, &mut index, b'C', b'M')
    || consume_pair(bytes, &mut index, b'C', b'D')
  {
  } else {
    let _ = consume(bytes, &mut index, b'D');
    let _ = take_repeated(bytes, &mut index, b'C', 3);
  }

  if consume_pair(bytes, &mut index, b'X', b'C')
    || consume_pair(bytes, &mut index, b'X', b'L')
  {
  } else {
    let _ = consume(bytes, &mut index, b'L');
    let _ = take_repeated(bytes, &mut index, b'X', 3);
  }

  if consume_pair(bytes, &mut index, b'I', b'X')
    || consume_pair(bytes, &mut index, b'I', b'V')
  {
  } else {
    let _ = consume(bytes, &mut index, b'V');
    let _ = take_repeated(bytes, &mut index, b'I', 3);
  }

  index == bytes.len()
}

fn take_repeated(
  bytes: &[u8],
  index: &mut usize,
  target: u8,
  max: usize,
) -> usize {
  let mut count = 0_usize;
  while count < max && bytes.get(*index) == Some(&target) {
    *index = index.saturating_add(1);
    count = count.saturating_add(1);
  }
  count
}

fn consume_pair(
  bytes: &[u8],
  index: &mut usize,
  first: u8,
  second: u8,
) -> bool {
  if bytes.get(*index) != Some(&first)
    || bytes.get(index.saturating_add(1)) != Some(&second)
  {
    return false;
  }
  *index = index.saturating_add(2);
  true
}

fn consume(bytes: &[u8], index: &mut usize, target: u8) -> bool {
  if bytes.get(*index) != Some(&target) {
    return false;
  }
  *index = index.saturating_add(1);
  true
}

fn trim_end_byte(text: &str) -> usize {
  text.trim_end().len()
}

fn leading_ws_len(text: &str) -> usize {
  let mut len = 0_usize;
  for ch in text.chars() {
    if !ch.is_whitespace() {
      break;
    }
    len = len.saturating_add(ch.len_utf8());
  }
  len
}

fn previous_char(text: &str, pos: usize) -> Option<(usize, char)> {
  text.get(..pos)?.char_indices().next_back()
}

fn next_char(text: &str, pos: usize) -> Option<(usize, char)> {
  text
    .get(pos..)?
    .char_indices()
    .next()
    .map(|(relative, ch)| (pos.saturating_add(relative), ch))
}

fn lower_set(values: Vec<String>) -> HashSet<String> {
  values
    .into_iter()
    .filter(|value| !value.is_empty())
    .map(|value| value.to_lowercase())
    .collect()
}

fn lower_vec(values: Vec<String>) -> Vec<String> {
  values
    .into_iter()
    .filter(|value| !value.is_empty())
    .map(|value| value.to_lowercase())
    .collect()
}

fn lowercase_lookup(text: &str) -> Cow<'_, str> {
  if text.chars().any(char::is_uppercase) {
    Cow::Owned(text.to_lowercase())
  } else {
    Cow::Borrowed(text)
  }
}

fn contains_lowercase(set: &HashSet<String>, text: &str) -> bool {
  set.contains(lowercase_lookup(text).as_ref())
}

#[cfg(test)]
mod tests {
  #![allow(clippy::expect_used, clippy::unwrap_used)]

  use std::collections::HashSet;

  use super::{
    Candidate, CandidateContainmentIndex, LegalFormData, PreparedLegalFormData,
    crosses_sentence_end, drop_overlapping, ends_with_list_suffix,
    extend_backward, is_roman_legal_suffix,
    previous_nonempty_line_has_organization_cue, process_legal_form_matches,
    split_embedded_legal_form_list, trim_embedded_legal_form_list_prefix,
    trim_leading_clause, trim_role_head,
  };
  use crate::processors::PatternSlice;
  use crate::types::SearchMatch;
  use proptest::prelude::*;

  proptest! {
    #[test]
    fn indexed_overlap_filter_matches_exhaustive_reference(
      raw in proptest::collection::vec(
        (any::<u8>(), any::<u8>(), any::<u8>(), any::<u8>()),
        0..512,
      ),
    ) {
      let full_text = "A,;".repeat(100);
      let data = PreparedLegalFormData::new(LegalFormData {
        institutional_heads: vec![String::from("a")],
        ..LegalFormData::default()
      });
      let candidates = raw.into_iter().map(|(left, right, suffix, tail)| {
        let start = usize::from(left.min(right));
        let end = usize::from(left.max(right)).saturating_add(1);
        let width = end.saturating_sub(start).max(1);
        let suffix_offset =
          usize::from(suffix).checked_rem(width).unwrap_or_default();
        let matched_suffix_start = start.saturating_add(suffix_offset);
        let suffix_end = matched_suffix_start
          .saturating_add(1)
          .min(end);
        Candidate {
          start,
          suffix_start: matched_suffix_start,
          matched_suffix_start,
          suffix_end,
          end: end.saturating_add(usize::from(tail) % 2),
          trimmed: false,
        }
      }).collect::<Vec<_>>();

      prop_assert_eq!(
        drop_overlapping(candidates.clone(), &full_text, &data),
        legacy_drop_overlapping(candidates, &full_text, &data),
      );
    }

    #[test]
    fn trailing_suffix_index_matches_exhaustive_lookup(
      suffixes in proptest::collection::vec("[A-Z][A-Za-z.]{0,7}", 0..80),
      prefix in "[A-Za-z ,;]{0,120}",
    ) {
      let expected = suffixes.iter().any(|suffix| {
        !is_roman_legal_suffix(suffix) && prefix.ends_with(suffix)
      });
      let data = PreparedLegalFormData::new(LegalFormData {
        suffixes,
        ..LegalFormData::default()
      });
      prop_assert_eq!(ends_with_list_suffix(&prefix, &data), expected);
    }

    #[test]
    fn indexed_list_split_and_trim_match_legacy_reference(
      name_offset in 0_usize..7,
      suffix_offset in 0_usize..10,
      boundary_offset in 0_usize..10,
      entity_start in 0_usize..256,
    ) {
      let names = [
        "Acme",
        "Élan",
        "İstanbul",
        "Cafe\u{301}",
        "Žlutý",
        "München",
        "東京",
      ];
      // The pairs exercise nested ASCII, multibyte-final, and combining-mark
      // suffixes. Exact matching is intentional: normalization is unchanged
      // from the exhaustive implementation.
      let suffixes = [
        "LLC",
        "C",
        "Inc.",
        "GmbH",
        "AŞ",
        "Ş",
        "株式会社",
        "社",
        "e\u{301}",
        "\u{301}",
      ];
      let boundaries = [
        (',', " "),
        (';', " "),
        (',', "\u{a0}"),
        (';', "\u{a0}"),
        (',', "\u{202f}"),
        (';', "\u{202f}"),
        (',', "\r\n  "),
        (';', "\r\n  "),
        (',', "\t"),
        (';', "\t"),
      ];
      let data = PreparedLegalFormData::new(LegalFormData {
        suffixes: suffixes.iter().map(|suffix| (*suffix).to_string()).collect(),
        ..LegalFormData::default()
      });
      let mut text = String::new();
      for member in 0..=boundaries.len() {
        let name = names
          .iter()
          .cycle()
          .nth(member.wrapping_add(name_offset))
          .copied()
          .expect("wrapped name index");
        let suffix = suffixes
          .iter()
          .cycle()
          .nth(member.wrapping_add(suffix_offset))
          .copied()
          .expect("wrapped suffix index");
        text.push_str(name);
        text.push(' ');
        text.push_str(suffix);
        if member < boundaries.len() {
          let (delimiter, whitespace) = boundaries
            .iter()
            .cycle()
            .nth(member.wrapping_add(boundary_offset))
            .copied()
            .expect("wrapped boundary index");
          text.push(delimiter);
          text.push_str(whitespace);
        }
      }

      let indexed = split_embedded_legal_form_list(entity_start, &text, &data);
      let exhaustive = legacy_split_embedded_legal_form_list(
        entity_start,
        &text,
        &data,
      );
      prop_assert_eq!(
        segment_identity(&indexed),
        segment_identity(&exhaustive),
      );
      prop_assert_eq!(
        trim_embedded_legal_form_list_prefix(entity_start, &text, &data),
        legacy_trim_embedded_legal_form_list_prefix(
          entity_start,
          &text,
          &data,
        ),
      );
    }
  }

  #[test]
  fn containment_index_bounds_work_for_dense_institutional_candidates() {
    const CANDIDATE_COUNT: usize = 10_000;
    let data = PreparedLegalFormData::new(LegalFormData {
      institutional_heads: vec![String::from("a")],
      ..LegalFormData::default()
    });
    let full_text = "A".repeat(CANDIDATE_COUNT);
    let candidates = (0..CANDIDATE_COUNT)
      .map(|index| Candidate {
        start: index,
        suffix_start: index,
        matched_suffix_start: index,
        suffix_end: index + 1,
        end: index + 1,
        trimmed: false,
      })
      .collect::<Vec<_>>();
    let mut index =
      CandidateContainmentIndex::new(&candidates, &full_text, &data);
    for candidate in &candidates {
      assert!(!index.has_blocking_container(candidate));
      index.accept(candidate, &full_text, &data);
    }

    let logarithmic_bound = CANDIDATE_COUNT * 30;
    assert!(index.operations() < logarithmic_bound);
  }

  fn candidate_blocks(
    outer: &Candidate,
    candidate: &Candidate,
    full_text: &str,
    data: &PreparedLegalFormData,
  ) -> bool {
    if candidate.start < outer.start || candidate.end > outer.end {
      return false;
    }
    let outer_is_institutional = full_text
      .get(outer.matched_suffix_start..outer.suffix_end)
      .is_some_and(|head| {
        data
          .institutional_heads
          .contains(&super::normalize_suffix_token(head).to_lowercase())
      });
    let separated_earlier_suffix = candidate.suffix_end
      <= outer.matched_suffix_start
      && full_text
        .get(candidate.suffix_end..outer.matched_suffix_start)
        .is_some_and(|between| between.contains([',', ';']));
    !(outer_is_institutional && separated_earlier_suffix)
  }

  fn legacy_drop_overlapping(
    mut candidates: Vec<Candidate>,
    full_text: &str,
    data: &PreparedLegalFormData,
  ) -> Vec<Candidate> {
    candidates.sort_by(|left, right| {
      left
        .start
        .cmp(&right.start)
        .then_with(|| right.end.cmp(&left.end))
    });
    let mut accepted = Vec::new();
    for candidate in candidates {
      if accepted
        .iter()
        .any(|outer| candidate_blocks(outer, &candidate, full_text, data))
      {
        continue;
      }
      accepted.push(candidate);
    }
    accepted.sort_by(|left, right| {
      left
        .start
        .cmp(&right.start)
        .then_with(|| left.end.cmp(&right.end))
    });
    accepted
  }

  fn legacy_list_suffixes(
    data: &PreparedLegalFormData,
  ) -> impl Iterator<Item = &str> + '_ {
    data
      .suffixes
      .iter()
      .map(String::as_str)
      .filter(|suffix| !is_roman_legal_suffix(suffix))
  }

  fn legacy_has_name_before_trailing_list_suffix(
    segment: &str,
    data: &PreparedLegalFormData,
  ) -> bool {
    legacy_list_suffixes(data)
      .filter(|suffix| segment.ends_with(*suffix))
      .max_by_key(|suffix| suffix.len())
      .and_then(|suffix| {
        segment.get(..segment.len().saturating_sub(suffix.len()))
      })
      .is_some_and(|prefix| prefix.chars().any(char::is_alphanumeric))
  }

  fn legacy_following_list_segment_has_name(
    after_suffix: &str,
    boundary_len: usize,
    data: &PreparedLegalFormData,
  ) -> bool {
    let Some(after_boundary) = after_suffix.get(boundary_len..) else {
      return false;
    };
    let segment_end = after_boundary
      .find([',', ';'])
      .unwrap_or(after_boundary.len());
    let segment = after_boundary.get(..segment_end).unwrap_or_default().trim();
    if legacy_has_name_before_trailing_list_suffix(segment, data)
      || super::starts_with_named_institutional_complement(segment, data)
    {
      return true;
    }

    let Some(after_comma) = after_boundary.get(segment_end..) else {
      return false;
    };
    let Some(after_comma) = after_comma.strip_prefix(',') else {
      return false;
    };
    let legal_form_end =
      after_comma.find([',', ';']).unwrap_or(after_comma.len());
    let legal_form =
      after_comma.get(..legal_form_end).unwrap_or_default().trim();
    if legal_form.is_empty() {
      return false;
    }
    let combined_len = segment_end
      .saturating_add(','.len_utf8())
      .saturating_add(legal_form_end);
    after_boundary
      .get(..combined_len)
      .map(str::trim)
      .is_some_and(|combined| {
        legacy_has_name_before_trailing_list_suffix(combined, data)
      })
  }

  fn legacy_split_embedded_legal_form_list<'a>(
    entity_start: usize,
    entity_text: &'a str,
    data: &PreparedLegalFormData,
  ) -> Vec<super::Segment<'a>> {
    if !entity_text.contains([',', ';']) {
      return vec![super::Segment {
        start: entity_start,
        text: entity_text,
      }];
    }

    let mut cuts = vec![0_usize];
    for suffix in legacy_list_suffixes(data) {
      let mut search_from = 0_usize;
      while let Some(relative) = entity_text
        .get(search_from..)
        .and_then(|tail| tail.find(suffix))
      {
        let suffix_start = search_from.saturating_add(relative);
        let suffix_end = suffix_start.saturating_add(suffix.len());
        search_from = suffix_end;
        if suffix_end >= entity_text.len().saturating_sub(1) {
          continue;
        }
        let Some(after) = entity_text.get(suffix_end..) else {
          continue;
        };
        let boundary_len = super::legal_list_boundary_len(after);
        if boundary_len > 0
          && legacy_following_list_segment_has_name(after, boundary_len, data)
        {
          cuts.push(suffix_end.saturating_add(boundary_len));
        }
      }
    }

    cuts.sort_unstable();
    cuts.dedup();
    if cuts.len() == 1 {
      return vec![super::Segment {
        start: entity_start,
        text: entity_text,
      }];
    }

    let mut segments = Vec::new();
    for (index, start) in cuts.iter().enumerate() {
      let end = cuts
        .get(index.saturating_add(1))
        .copied()
        .unwrap_or(entity_text.len());
      if *start >= end {
        continue;
      }
      let Some(segment) = entity_text.get(*start..end) else {
        continue;
      };
      let trimmed = segment.trim_end_matches(|ch: char| {
        ch.is_whitespace() || matches!(ch, ',' | ';')
      });
      if trimmed.is_empty()
        || (!legacy_has_name_before_trailing_list_suffix(trimmed, data)
          && !super::starts_with_named_institutional_complement(trimmed, data))
      {
        continue;
      }
      segments.push(super::Segment {
        start: entity_start.saturating_add(*start),
        text: trimmed,
      });
    }
    segments
  }

  fn legacy_trim_embedded_legal_form_list_prefix<'a>(
    entity_start: usize,
    entity_text: &'a str,
    data: &PreparedLegalFormData,
  ) -> (usize, &'a str) {
    if !entity_text.contains(',') {
      return (entity_start, entity_text);
    }

    let mut cut = 0_usize;
    for suffix in legacy_list_suffixes(data) {
      let mut search_from = 0_usize;
      while let Some(relative) = entity_text
        .get(search_from..)
        .and_then(|tail| tail.find(suffix))
      {
        let suffix_start = search_from.saturating_add(relative);
        let suffix_end = suffix_start.saturating_add(suffix.len());
        search_from = suffix_end;
        if suffix_end >= entity_text.len().saturating_sub(1) {
          continue;
        }
        let Some(after) = entity_text.get(suffix_end..) else {
          continue;
        };
        let boundary_len = super::comma_upper_boundary_len(after);
        if boundary_len == 0
          || !legacy_following_list_segment_has_name(after, boundary_len, data)
        {
          continue;
        }
        let next_start = suffix_end.saturating_add(boundary_len);
        if entity_text.get(next_start..).is_some_and(|remainder| {
          super::ends_with_legal_suffix(remainder, data)
            || super::starts_with_named_institutional_complement(
              remainder, data,
            )
        }) {
          cut = cut.max(next_start);
        }
      }
    }

    if cut == 0 {
      return (entity_start, entity_text);
    }
    (
      entity_start.saturating_add(cut),
      entity_text.get(cut..).unwrap_or_default(),
    )
  }

  fn segment_identity<'a>(
    segments: &'a [super::Segment<'a>],
  ) -> Vec<(usize, &'a str)> {
    segments
      .iter()
      .map(|segment| (segment.start, segment.text))
      .collect()
  }

  #[test]
  fn empty_list_suffixes_are_ignored() {
    // The assembler drops empty legal forms. Keep the core preparation path
    // fail-safe too: an empty suffix has no trailing character to index and
    // must never create a cut or make an exhaustive search fail to advance.
    let data = PreparedLegalFormData::new(LegalFormData {
      suffixes: vec![String::new()],
      ..LegalFormData::default()
    });
    let text = "Acme LLC, Beta Inc.";
    assert!(!ends_with_list_suffix("Acme LLC", &data));
    assert_eq!(
      segment_identity(&split_embedded_legal_form_list(7, text, &data)),
      [(7, text)],
    );
    assert_eq!(
      trim_embedded_legal_form_list_prefix(7, text, &data),
      (7, text),
    );
  }

  #[test]
  #[ignore = "release-mode scaling regression check"]
  fn delimiter_dense_legal_form_lists_scale_with_input_size() {
    let mut suffixes = vec![String::from("LLC"), String::from("Inc.")];
    suffixes.extend((0..256).map(|index| format!("DenseBucket{index:03}C")));
    let data = PreparedLegalFormData::new(LegalFormData {
      suffixes,
      ..LegalFormData::default()
    });
    let fixture = "Ácme LLC, Béťa Inc.; ";
    let sizes: [usize; 3] = [16 * 1024, 64 * 1024, 256 * 1024];
    let mut samples = Vec::new();

    for target_bytes in sizes {
      let repeats = target_bytes.div_ceil(fixture.len());
      let text = fixture.repeat(repeats);
      let expected_segments = repeats.saturating_mul(2);
      let warm = split_embedded_legal_form_list(0, &text, &data);
      assert_eq!(warm.len(), expected_segments);

      let mut best = std::time::Duration::MAX;
      for _ in 0..5 {
        let started = web_time::Instant::now();
        let segments = split_embedded_legal_form_list(0, &text, &data);
        let trimmed = trim_embedded_legal_form_list_prefix(0, &text, &data);
        best = best.min(started.elapsed());
        assert_eq!(segments.len(), expected_segments);
        std::hint::black_box((segments, trimmed));
      }
      samples.push((text.len(), best.as_nanos()));
    }

    let (smallest_bytes, smallest_nanos) = samples.first().copied().unwrap();
    let (largest_bytes, largest_nanos) = samples.last().copied().unwrap();
    assert!(
      largest_nanos.saturating_mul(u128::try_from(smallest_bytes).unwrap())
        <= smallest_nanos
          .saturating_mul(u128::try_from(largest_bytes).unwrap())
          .saturating_mul(4),
      "delimiter-dense legal-form time per byte regressed: {samples:?}",
    );
  }

  fn leading_clause_data() -> PreparedLegalFormData {
    PreparedLegalFormData::new(LegalFormData {
      leading_clause_phrases: vec![
        String::from("by and among"),
        String::from("by and between"),
        String::from("is between"),
      ],
      leading_clause_direct_prefixes: vec![
        String::from("by"),
        String::from("among"),
        String::from("amongst"),
        String::from("between"),
      ],
      comma_gated_direct_prefixes: vec![
        String::from("among"),
        String::from("amongst"),
        String::from("between"),
      ],
      connector_words: vec![String::from("and")],
      and_connector_words: vec![String::from("and")],
      ..LegalFormData::default()
    })
  }

  #[test]
  fn comma_gated_prefix_trims_long_preamble() {
    // A long comma-laden preamble before a comma-gated direct prefix must trim
    // back to the company name, not drop the whole candidate. The capital-word
    // check after the prefix has to read the original text, not the lowercased
    // copy, or it never fires.
    let data = leading_clause_data();
    let text =
      "Investment Agreement, dated as of March 9, 2020, among Twitter, Inc.";
    let trim = trim_leading_clause(text, &data);
    assert_eq!(text.get(trim.offset..), Some("Twitter, Inc."));
  }

  #[test]
  fn direct_prefix_offset_survives_turkish_dotted_capital() {
    // `to_lowercase()` expands "İ" (U+0130) to "i" + U+0307, so a byte offset
    // taken from the lowercased copy drifts one byte past the original once an
    // İ precedes the clause. The recovered company name must be sliced in
    // original-text space: the Turkish input yields the same result as its
    // ASCII twin, with no mis-slice, panic, or None-degradation.
    let data = leading_clause_data();
    let ascii = "Istanbul Holding A.S. Investment Agreement, dated as of March 9, 2020, among Twitter, Inc.";
    let turkish = "İstanbul Holding A.Ş. Investment Agreement, dated as of March 9, 2020, among Twitter, Inc.";
    let ascii_trim = trim_leading_clause(ascii, &data);
    let turkish_trim = trim_leading_clause(turkish, &data);
    assert_eq!(ascii.get(ascii_trim.offset..), Some("Twitter, Inc."));
    assert_eq!(turkish.get(turkish_trim.offset..), Some("Twitter, Inc."));
  }

  #[test]
  fn comma_gated_prefix_keeps_in_name_capitalised_word() {
    // "Stand By Me LLC": "By" is capitalized and mid-name, and the text before
    // it is not prose, so the direct prefix must not trim.
    let data = leading_clause_data();
    let text = "Stand By Me LLC";
    let trim = trim_leading_clause(text, &data);
    assert_eq!(trim.offset, 0);
  }

  fn crosses(text: &str, prefix: &str) -> bool {
    // Treat the org candidate as spanning the whole text up to the trailing
    // legal-form suffix (the caller passes walker_start and suffix_start).
    let suffix_start = text.rfind(prefix).unwrap_or(text.len());
    crosses_sentence_end(text, 0, suffix_start).is_some()
  }

  #[test]
  fn compact_initials_are_not_a_sentence_break() {
    // "J.P. Morgan Securities LLC" — the interior dot must not make "J.P."
    // read as a two-letter acronym followed by a sentence end.
    assert!(!crosses("J.P. Morgan Securities LLC", "LLC"));
    assert!(!crosses("U.S. Robotics Corp LLC", "LLC"));
  }

  #[test]
  fn dotted_geo_acronym_joins_like_a_name_initial() {
    // A two-letter dotted acronym is structurally identical whether it is a
    // geographic prefix ("U.S. Bancorp Inc.") or a person-name initial ("J.P.
    // Morgan Securities LLC"). The recovered TypeScript detector absorbed both
    // unconditionally (skipInitialsBackward: `(?:\p{Lu}\.\s?){2,}`, no
    // known-acronym exception list), so "U.S. Beta LLC" joins the same way.
    // Splitting it would regress the real "U.S. Bancorp"/"U.S. Robotics"
    // orgs, which share the exact same shape.
    assert!(!crosses("U.S. Beta LLC", "LLC"));
    assert!(!crosses("U.S. Bancorp Inc.", "Inc."));
  }

  #[test]
  fn spaced_initials_stay_a_single_candidate() {
    assert!(!crosses("J. P. Morgan Securities LLC", "LLC"));
  }

  #[test]
  fn genuine_sentence_break_still_detected() {
    // A real 2+ letter word (any case) before ". " remains a boundary.
    assert!(crosses("Price. LLC", "LLC"));
    assert!(crosses("Acme INC. Beta LLC", "LLC"));
  }

  fn legal_form_test_data() -> PreparedLegalFormData {
    PreparedLegalFormData::new(LegalFormData {
      suffixes: vec![String::from("LLC"), String::from("Inc.")],
      ..LegalFormData::default()
    })
  }

  fn english_vocabulary(source: &str) -> Vec<String> {
    let value: serde_json::Value =
      serde_json::from_str(source).expect("language-keyed vocabulary JSON");
    value
      .get("en")
      .and_then(serde_json::Value::as_array)
      .expect("English vocabulary array")
      .iter()
      .map(|word| word.as_str().expect("vocabulary string").to_string())
      .collect()
  }

  fn object_vocabulary(source: &str, key: &str) -> Vec<String> {
    let value: serde_json::Value =
      serde_json::from_str(source).expect("vocabulary JSON object");
    value
      .get(key)
      .and_then(serde_json::Value::as_array)
      .expect("vocabulary array")
      .iter()
      .map(|word| word.as_str().expect("vocabulary string").to_string())
      .collect()
  }

  fn english_object_vocabulary(source: &str, key: &str) -> Vec<String> {
    let value: serde_json::Value =
      serde_json::from_str(source).expect("language-keyed vocabulary JSON");
    value
      .get("en")
      .and_then(|english| english.get(key))
      .and_then(serde_json::Value::as_array)
      .expect("English vocabulary array")
      .iter()
      .map(|word| word.as_str().expect("vocabulary string").to_string())
      .collect()
  }

  fn language_keyed_object_vocabulary(
    source: &str,
    key: &str,
    language: &str,
  ) -> Vec<String> {
    let value: serde_json::Value =
      serde_json::from_str(source).expect("language-keyed vocabulary JSON");
    value
      .get(key)
      .and_then(|languages| languages.get(language))
      .and_then(serde_json::Value::as_array)
      .expect("language vocabulary array")
      .iter()
      .map(|word| word.as_str().expect("vocabulary string").to_string())
      .collect()
  }

  fn scoped_object_vocabulary(
    source: &str,
    order_key: &str,
    ownership_key: &str,
    language: &str,
  ) -> Vec<String> {
    let owned: HashSet<String> =
      language_keyed_object_vocabulary(source, ownership_key, language)
        .into_iter()
        .collect();
    object_vocabulary(source, order_key)
      .into_iter()
      .filter(|word| owned.contains(word))
      .collect()
  }

  fn legal_form_entities(
    text: &str,
    suffixes: &[&str],
    institutional_heads: &[&str],
  ) -> Vec<String> {
    legal_form_entities_with_short_suffix_scope(
      text,
      suffixes,
      institutional_heads,
      suffixes,
    )
  }

  fn legal_form_entities_with_short_suffix_scope(
    text: &str,
    suffixes: &[&str],
    institutional_heads: &[&str],
    non_ascii_name_short_suffixes: &[&str],
  ) -> Vec<String> {
    let complement_starters = english_vocabulary(include_str!(
      "../../../packages/data/config/institutional-organization-complement-starters.json"
    ));
    let complement_connectors = english_vocabulary(include_str!(
      "../../../packages/data/config/institutional-organization-complement-connectors.json"
    ));
    let generic_words = english_vocabulary(include_str!(
      "../../../packages/data/config/institutional-organization-generic-name-words.json"
    ));
    let prefix_generic_words = english_vocabulary(include_str!(
      "../../../packages/data/config/institutional-organization-prefix-generic-name-words.json"
    ));
    let legal_form_rule_words =
      include_str!("../../../packages/data/config/legal-form-rule-words.json");
    let leading_clauses = include_str!(
      "../../../packages/data/config/legal-form-leading-clauses.json"
    );
    let connector_words = scoped_object_vocabulary(
      legal_form_rule_words,
      "connectorWords",
      "connectorWordLanguages",
      "en",
    );
    let data = PreparedLegalFormData::new(LegalFormData {
      suffixes: suffixes.iter().map(ToString::to_string).collect(),
      non_ascii_name_short_suffixes: non_ascii_name_short_suffixes
        .iter()
        .map(ToString::to_string)
        .collect(),
      connector_words,
      and_connector_words: language_keyed_object_vocabulary(
        legal_form_rule_words,
        "partyConnectorWords",
        "en",
      ),
      company_suffix_words: object_vocabulary(
        legal_form_rule_words,
        "companySuffixWords",
      ),
      leading_clause_phrases: english_object_vocabulary(
        leading_clauses,
        "phrases",
      ),
      leading_clause_direct_prefixes: english_object_vocabulary(
        leading_clauses,
        "directPrefixes",
      ),
      comma_gated_direct_prefixes: object_vocabulary(
        legal_form_rule_words,
        "commaGatedDirectPrefixes",
      ),
      institutional_heads: institutional_heads
        .iter()
        .map(ToString::to_string)
        .collect(),
      institutional_complement_heads: institutional_heads
        .iter()
        .map(ToString::to_string)
        .collect(),
      institutional_complement_starters: complement_starters,
      institutional_complement_connectors: complement_connectors,
      institutional_generic_words: generic_words,
      institutional_prefix_generic_words: prefix_generic_words,
      ..LegalFormData::default()
    });
    let found = suffixes
      .iter()
      .enumerate()
      .flat_map(|(pattern, suffix)| {
        text
          .match_indices(suffix)
          .map(move |(start, _)| SearchMatch::Literal {
            pattern: u32::try_from(pattern).expect("pattern"),
            start: u32::try_from(start).expect("start"),
            end: u32::try_from(
              start.checked_add(suffix.len()).expect("end offset"),
            )
            .expect("end"),
          })
      })
      .collect::<Vec<_>>();
    process_legal_form_matches(
      &found,
      PatternSlice {
        start: 0,
        end: u32::try_from(suffixes.len()).expect("slice end"),
      },
      text,
      &data,
    )
    .expect("institutional organization detection")
    .into_iter()
    .map(|entity| entity.text)
    .collect()
  }

  fn institutional_head_entities(text: &str, head: &str) -> Vec<String> {
    legal_form_entities(text, &[head], &[head])
  }

  #[test]
  fn institutional_heads_recover_named_legal_and_public_organizations() {
    for (text, head) in [
      ("Benefits Agency", "Agency"),
      ("Foreign and Commonwealth Office", "Office"),
      (
        "National Society for the Prevention of Cruelty to Children",
        "Society",
      ),
      ("Siverek Security Directorate", "Directorate"),
      ("Siverek Magistrates' Court", "Court"),
      ("Diyarbakır State Security Court", "Court"),
      ("Court of Appeal", "Court"),
      ("Office of the U.S. Attorney", "Office"),
      ("Office of the United Nations High Commissioner", "Office"),
      ("U.S. District Court", "Court"),
      ("OFFICE OF THE U.S. ATTORNEY GENERAL", "OFFICE"),
      ("U.S. DISTRICT COURT", "COURT"),
      ("Ministry of Finance", "Ministry"),
      ("Department of Trade", "Department"),
      ("ǅuro Court", "Court"),
      ("東京 Court", "Court"),
    ] {
      assert_eq!(institutional_head_entities(text, head), [text]);
    }
  }

  #[test]
  fn short_legal_forms_support_non_ascii_organization_names() {
    for (text, suffix) in [
      ("Küstenwerke AG", "AG"),
      ("Étoile SA", "SA"),
      ("Řeka SE", "SE"),
      ("Société générale SA", "SA"),
      ("Société Générale, SA", "SA"),
      ("Bank für Internationalen Zahlungsausgleich AG", "AG"),
    ] {
      assert_eq!(legal_form_entities(text, &[suffix], &[]), [text]);
    }
  }

  #[test]
  fn short_legal_forms_still_require_a_trailing_boundary() {
    assert!(legal_form_entities("Minha AGÊNCIA", &["AG"], &[]).is_empty());
    assert!(legal_form_entities("PLANO DE SAÚDE", &["SA"], &[]).is_empty());
  }

  #[test]
  fn short_legal_forms_reject_non_ascii_prose_abbreviations() {
    for (text, suffix) in [
      ("Zapsaná v obchodním rejstříku vedeném u KS", "KS"),
      ("191 KW, benzín BA", "BA"),
    ] {
      assert!(legal_form_entities(text, &[suffix], &[]).is_empty());
    }
  }

  #[test]
  fn short_legal_form_unicode_names_follow_language_scope() {
    assert_eq!(
      legal_form_entities_with_short_suffix_scope(
        "Řeka SE",
        &["SE", "PS"],
        &[],
        &["SE"],
      ),
      ["Řeka SE"]
    );
    assert!(
      legal_form_entities_with_short_suffix_scope(
        "Škoda Octavia 110 PS",
        &["SE", "PS"],
        &[],
        &["SE"],
      )
      .is_empty()
    );
    assert_eq!(
      legal_form_entities_with_short_suffix_scope(
        "Latvijas Šķiedra PS",
        &["SE", "PS"],
        &[],
        &["PS"],
      ),
      ["Latvijas Šķiedra PS"]
    );
  }

  #[test]
  fn institutional_complement_scan_preserves_utf8_boundaries() {
    let text = format!("Court of Appeal {}é", "x".repeat(168));
    assert_eq!(
      institutional_head_entities(&text, "Court"),
      ["Court of Appeal"]
    );
  }

  #[test]
  fn institutional_lists_validate_each_segment_against_its_own_head() {
    for text in ["Acme Court, Beta Court", "Acme Court; Beta Court"] {
      assert_eq!(
        institutional_head_entities(text, "Court"),
        ["Acme Court", "Beta Court"]
      );
    }
    assert_eq!(
      institutional_head_entities("Court, Beta Court", "Court"),
      ["Beta Court"]
    );
    assert_eq!(
      legal_form_entities(
        "Acme Court, Inc.",
        &["Court", "Inc", "Inc."],
        &["Court"],
      ),
      ["Acme Court, Inc."]
    );
    assert_eq!(
      legal_form_entities(
        "Acme Court, Beta Inc.",
        &["Court", "Inc", "Inc."],
        &["Court"],
      ),
      ["Acme Court", "Beta Inc."]
    );
    assert_eq!(
      legal_form_entities(
        "Acme LLC, Beta Court",
        &["LLC", "Court"],
        &["Court"],
      ),
      ["Acme LLC", "Beta Court"]
    );
    assert_eq!(
      legal_form_entities("Acme LLC, Inc.", &["LLC", "Inc", "Inc."], &[],),
      ["Acme LLC, Inc."]
    );
    assert_eq!(
      legal_form_entities("Acme LLC, LLC", &["LLC"], &[]),
      ["Acme LLC, LLC"]
    );
    // A bare conjunction is also valid inside one title-cased organization
    // name. Without punctuation, retain one fail-closed redaction span.
    assert_eq!(
      institutional_head_entities("Court and Beta Court", "Court"),
      ["Court and Beta Court"]
    );
    assert_eq!(
      institutional_head_entities("Acme Court and Beta Court", "Court"),
      ["Acme Court and Beta Court"]
    );
    assert_eq!(
      legal_form_entities(
        "Finance Committee and Beta Court",
        &["Committee", "Court"],
        &["Committee", "Court"],
      ),
      ["Finance Committee and Beta Court"]
    );
    assert_eq!(
      legal_form_entities(
        "Acme Court and Beta Inc.",
        &["Court", "Inc", "Inc."],
        &["Court"],
      ),
      ["Acme Court and Beta Inc."]
    );
    assert_eq!(
      legal_form_entities(
        "John Smith and Company, Inc., Acme Technologies and X Holdings I, Inc.",
        &["Company", "Inc", "Inc.", "I"],
        &["Company"],
      ),
      [
        "John Smith and Company, Inc.",
        "Acme Technologies and X Holdings I, Inc."
      ]
    );
    assert_eq!(
      legal_form_entities(
        "Acme Inc., Court of Appeal",
        &["Inc", "Inc.", "Court"],
        &["Court"],
      ),
      ["Acme Inc.", "Court of Appeal"]
    );
    assert_eq!(
      legal_form_entities(
        "Acme Inc., Court",
        &["Inc", "Inc.", "Court"],
        &["Court"],
      ),
      ["Acme Inc."]
    );
  }

  #[test]
  fn institutional_head_before_company_connector_remains_in_name() {
    assert_eq!(
      legal_form_entities(
        "Acme Court and Associates LLC",
        &["Court", "LLC"],
        &["Court"],
      ),
      ["Acme Court and Associates LLC"]
    );
  }

  #[test]
  fn institutional_heads_do_not_emit_bare_generic_references() {
    assert!(institutional_head_entities("the Court held", "Court").is_empty());
    assert!(
      institutional_head_entities("an Agency responded", "Agency").is_empty()
    );
    assert!(institutional_head_entities("This is Court", "Court").is_empty());
    assert!(
      institutional_head_entities("The claimant was an Agency", "Agency")
        .is_empty()
    );
    for (text, head) in [
      ("A Court may decide", "Court"),
      ("A Foundation may decide", "Foundation"),
      ("An Agency responded", "Agency"),
      ("Legal Department", "Department"),
      ("Head of Trade Department", "Department"),
      ("Finance Committee", "Committee"),
      ("Our Court held", "Court"),
      ("Such Court may decide", "Court"),
      ("That Court held", "Court"),
      ("These Court proceedings", "Court"),
      ("This Court held", "Court"),
      ("Those Court proceedings", "Court"),
      ("WHEREAS, the Board of Directors", "Board"),
      ("Subject to approval by the Board", "Board"),
      ("The Compensation Committee", "Committee"),
      ("The Society responded", "Society"),
    ] {
      assert!(
        institutional_head_entities(text, head).is_empty(),
        "generic institutional reference should not emit: {text}"
      );
    }
    assert_eq!(
      institutional_head_entities("Parent&rsquo;s Board of Directors", "Board",),
      ["Parent&rsquo;s Board of Directors"]
    );
    assert_eq!(
      institutional_head_entities(
        "Chairman of the Board reporting to Parent&rsquo;s Board of Directors",
        "Board",
      ),
      ["Parent&rsquo;s Board of Directors"]
    );
    assert_eq!(
      institutional_head_entities(
        "its Chairman of the Board reporting to Parent&rsquo;s Board of Directors",
        "Board",
      ),
      ["Parent&rsquo;s Board of Directors"]
    );
    assert!(
      institutional_head_entities(
        "its Chairman of the Board reporting to the Board of Directors",
        "Board",
      )
      .is_empty()
    );
    assert_eq!(
      institutional_head_entities(
        "reporting to St. Jude Children's Research Hospital",
        "Hospital",
      ),
      ["St. Jude Children's Research Hospital"]
    );
    assert!(
      institutional_head_entities("reporting to St. Hospital", "Hospital")
        .is_empty()
    );
    assert_eq!(
      institutional_head_entities(
        "Acme Society for the purposes of this Agreement",
        "Society",
      ),
      ["Acme Society"]
    );
  }

  #[test]
  fn verb_trimming_does_not_emit_a_bare_legal_suffix() {
    let text = "Client is Corporation";
    let suffix = "Corporation";
    let suffix_start = text.find(suffix).unwrap();
    let data = PreparedLegalFormData::new(LegalFormData {
      suffixes: vec![suffix.to_string()],
      sentence_verb_indicators: vec![String::from("is")],
      ..LegalFormData::default()
    });
    let found = SearchMatch::Literal {
      pattern: 0,
      start: u32::try_from(suffix_start).unwrap(),
      end: u32::try_from(suffix_start + suffix.len()).unwrap(),
    };

    assert!(
      process_legal_form_matches(
        &[found],
        PatternSlice { start: 0, end: 1 },
        text,
        &data,
      )
      .unwrap()
      .is_empty()
    );
  }

  #[test]
  fn sentence_break_reclips_instead_of_dropping_the_candidate() {
    // "Acme Inc. Beta LLC signed the agreement." — the LLC candidate's
    // backward walk reaches all the way to "Acme", crossing the "Inc. "
    // sentence break along the way. The old code dropped the whole
    // candidate via `continue`, so "Beta LLC" was never emitted. It now
    // re-clips forward past the break and re-validates the remainder, so
    // both the sentence-preceding "Acme Inc." and the later "Beta LLC" are
    // detected.
    let data = legal_form_test_data();
    let text = "Acme Inc. Beta LLC signed the agreement.";
    let inc_start = text.find("Inc.").unwrap();
    let inc_end = inc_start + "Inc.".len();
    let llc_start = text.find("LLC").unwrap();
    let llc_end = llc_start + "LLC".len();
    let matches = [
      SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(inc_start).unwrap(),
        end: u32::try_from(inc_end).unwrap(),
      },
      SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(llc_start).unwrap(),
        end: u32::try_from(llc_end).unwrap(),
      },
    ];
    let slice = PatternSlice { start: 0, end: 1 };
    let entities =
      process_legal_form_matches(&matches, slice, text, &data).unwrap();
    let texts: Vec<&str> =
      entities.iter().map(|entity| entity.text.as_str()).collect();
    assert!(texts.contains(&"Acme Inc."), "{texts:?}");
    assert!(texts.contains(&"Beta LLC"), "{texts:?}");
  }

  #[test]
  fn sentence_break_clip_retrims_leading_lowercase_prose() {
    // "Acme Inc. the supplier Beta LLC ..." — the LLC candidate's backward
    // walk bridges "the supplier" and reaches "Acme" across the "Inc. "
    // break. Clipping past the break used to leave the candidate anchored
    // on the lowercase prose ("the supplier Beta LLC"); the remainder is
    // now re-anchored at the first org-name-capable token, so only
    // "Beta LLC" is emitted for the second sentence.
    let data = legal_form_test_data();
    let text = "Acme Inc. the supplier Beta LLC signed the agreement.";
    let inc_start = text.find("Inc.").unwrap();
    let inc_end = inc_start + "Inc.".len();
    let llc_start = text.find("LLC").unwrap();
    let llc_end = llc_start + "LLC".len();
    let matches = [
      SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(inc_start).unwrap(),
        end: u32::try_from(inc_end).unwrap(),
      },
      SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(llc_start).unwrap(),
        end: u32::try_from(llc_end).unwrap(),
      },
    ];
    let slice = PatternSlice { start: 0, end: 1 };
    let entities =
      process_legal_form_matches(&matches, slice, text, &data).unwrap();
    let texts: Vec<&str> =
      entities.iter().map(|entity| entity.text.as_str()).collect();
    assert!(texts.contains(&"Acme Inc."), "{texts:?}");
    assert!(texts.contains(&"Beta LLC"), "{texts:?}");
    assert!(
      !texts.iter().any(|candidate| candidate.contains("supplier")),
      "leading prose must be trimmed from the clipped candidate: {texts:?}"
    );
  }

  fn firm_name_llp_data() -> PreparedLegalFormData {
    PreparedLegalFormData::new(LegalFormData {
      suffixes: vec![String::from("LLP")],
      connector_words: vec![String::from("&"), String::from("and")],
      and_connector_words: vec![String::from("and")],
      ..LegalFormData::default()
    })
  }

  fn org_texts_for(text: &str, suffix: &str) -> Vec<String> {
    let suffix_start = text.find(suffix).expect("suffix present");
    let suffix_end = suffix_start.saturating_add(suffix.len());
    let found = SearchMatch::Literal {
      pattern: 0,
      start: u32::try_from(suffix_start).unwrap(),
      end: u32::try_from(suffix_end).unwrap(),
    };
    process_legal_form_matches(
      &[found],
      PatternSlice { start: 0, end: 1 },
      text,
      &firm_name_llp_data(),
    )
    .unwrap()
    .into_iter()
    .map(|entity| entity.text)
    .collect()
  }

  #[test]
  fn jurisdiction_parenthetical_before_llp_keeps_firm_name() {
    // Law-firm notices often insert a jurisdiction marker before the
    // legal-form suffix: "Meagher & Flom (UK) LLP". Parentheses used to
    // stop the backward walk, so the org was dropped entirely.
    let text = "Skadden, Arps, Slate, Meagher & Flom (U.K.) LLP";
    let texts = org_texts_for(text, "LLP");
    assert!(
      texts.iter().any(|candidate| candidate == text),
      "expected full firm span, got {texts:?}"
    );
  }

  #[test]
  fn role_word_outside_bank_parenthetical_is_not_absorbed() {
    // Skipping every "(" / ")" as a separator used to extend
    // "Wells Fargo Bank, N.A." leftward into "Licensor (...)".
    let data = PreparedLegalFormData::new(LegalFormData {
      suffixes: vec![String::from("N.A.")],
      ..LegalFormData::default()
    });
    let text = "account designated by Licensor (Wells Fargo Bank, N.A.)";
    let suffix = "N.A.";
    let suffix_start = text.find(suffix).expect("suffix present");
    let suffix_end = suffix_start.saturating_add(suffix.len());
    let found = SearchMatch::Literal {
      pattern: 0,
      start: u32::try_from(suffix_start).unwrap(),
      end: u32::try_from(suffix_end).unwrap(),
    };
    let texts: Vec<String> = process_legal_form_matches(
      &[found],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
    )
    .unwrap()
    .into_iter()
    .map(|entity| entity.text)
    .collect();
    assert!(
      texts
        .iter()
        .any(|candidate| candidate == "Wells Fargo Bank, N.A."),
      "expected bank span only, got {texts:?}"
    );
    assert!(
      texts
        .iter()
        .all(|candidate| !candidate.contains("Licensor")),
      "role word must stay outside the org span: {texts:?}"
    );
  }

  #[test]
  fn jurisdiction_parenthetical_away_from_suffix_stops_name_walk() {
    let text = "Licensor (US) Acme LLP";
    let texts = org_texts_for(text, "LLP");
    assert_eq!(texts, vec![String::from("Acme LLP")]);
  }

  #[test]
  fn one_letter_parenthetical_before_suffix_is_not_a_jurisdiction() {
    let texts = org_texts_for("Schedule (A) LLC Agreement", "LLC");
    assert!(
      texts
        .iter()
        .all(|candidate| !candidate.contains("Schedule")),
      "schedule marker must not be absorbed into an organization: {texts:?}"
    );
  }

  #[test]
  fn comma_soft_wrap_before_llp_keeps_firm_name() {
    // EDGAR HTML reflow splits comma-separated firm names across a line.
    let text = "Skadden, Arps, Slate,\r\nMeagher & Flom (UK) LLP";
    let texts = org_texts_for(text, "LLP");
    let normalized: Vec<String> = texts
      .iter()
      .map(|candidate| candidate.replace("\r\n", " "))
      .collect();
    assert!(
      normalized.iter().any(|candidate| candidate
        == "Skadden, Arps, Slate, Meagher & Flom (UK) LLP"),
      "expected soft-wrapped firm span, got {texts:?}"
    );
  }

  #[test]
  fn single_token_soft_wrap_keeps_evidenced_issuer_names() {
    // Sidus Space employment agreement (2026-07-24): notice-block issuer
    // wrapped mid-name without a comma (`Sidus\nSpace, Inc.`).
    let data = PreparedLegalFormData::new_with_soft_wrap_boundary_labels(
      LegalFormData {
        suffixes: vec![String::from("Inc.")],
        role_heads: vec![String::from("donneur d'ordre")],
        company_suffix_words: vec![String::from("Company")],
        ..LegalFormData::default()
      },
      vec![String::from("attention")],
    );
    assert!(previous_nonempty_line_has_organization_cue(
      "Si au donneur d'ordre:\n\n",
      &data,
    ));
    for (text, suffix, expected) in [
      (
        "If to the Company:\n\nSidus\nSpace, Inc.\n\n150 N Sykes",
        "Inc.",
        "Sidus Space, Inc.",
      ),
      (
        "Authorized signatories\n\nGT\nBIOPHARMA, INC.",
        "INC.",
        "GT BIOPHARMA, INC.",
      ),
    ] {
      let suffix_start = text.find(suffix).unwrap();
      let found = SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(suffix_start).unwrap(),
        end: u32::try_from(suffix_start + suffix.len()).unwrap(),
      };
      let texts: Vec<String> = process_legal_form_matches(
        &[found],
        PatternSlice { start: 0, end: 1 },
        text,
        &data,
      )
      .unwrap()
      .into_iter()
      .map(|entity| entity.text.replace('\n', " "))
      .collect();
      assert!(
        texts.iter().any(|candidate| candidate == expected),
        "expected {expected:?}, got {texts:?}"
      );
    }
  }

  #[test]
  fn headers_and_field_labels_stop_firm_name_soft_wrap() {
    let data = PreparedLegalFormData::new_with_soft_wrap_boundary_labels(
      LegalFormData {
        suffixes: vec![String::from("Inc.")],
        company_suffix_words: vec![String::from("Company")],
        ..LegalFormData::default()
      },
      vec![String::from("attention"), String::from("table")],
    );
    for text in [
      String::from("THE COMPANY\nAcme Inc."),
      String::from("COMPANY\nAcme Inc."),
      String::from("If to the Company:\n\nAttention\nAcme Inc."),
      String::from("\n\nDefinitions\nAcme Inc."),
      String::from("\n\nTABLE\nAcme Inc."),
    ] {
      let suffix = "Inc.";
      let suffix_start = text.find(suffix).unwrap();
      let found = SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(suffix_start).unwrap(),
        end: u32::try_from(suffix_start + suffix.len()).unwrap(),
      };
      let texts: Vec<String> = process_legal_form_matches(
        &[found],
        PatternSlice { start: 0, end: 1 },
        &text,
        &data,
      )
      .unwrap()
      .into_iter()
      .map(|entity| entity.text)
      .collect();
      assert_eq!(texts, vec![String::from("Acme Inc.")]);
    }
  }

  #[test]
  fn paragraph_break_still_stops_firm_name_walk() {
    let text = "Unrelated Party.\n\nMeagher & Flom LLP";
    let texts = org_texts_for(text, "LLP");
    assert_eq!(texts, vec![String::from("Meagher & Flom LLP")]);
  }

  #[test]
  fn single_comma_line_boundary_still_stops_firm_name_walk() {
    let text = "Unrelated Party,\nMeagher & Flom LLP";
    let texts = org_texts_for(text, "LLP");
    assert_eq!(texts, vec![String::from("Meagher & Flom LLP")]);
  }

  #[test]
  fn comma_rich_address_line_still_stops_firm_name_walk() {
    let text = "Address: New York, NY,\nAcme LLC";
    let texts = org_texts_for(text, "LLC");
    assert_eq!(texts, vec![String::from("Acme LLC")]);
  }

  #[test]
  fn unlabelled_address_line_still_stops_firm_name_walk() {
    let text = "650 Page Mill Road, Palo Alto, CA,\nAcme LLC";
    let texts = org_texts_for(text, "LLC");
    assert_eq!(texts, vec![String::from("Acme LLC")]);
  }

  #[test]
  fn preceding_comma_rich_firm_line_still_stops_name_walk() {
    let text = "Wachtell, Lipton, Rosen & Katz,\nSkadden, Arps, Slate,\nMeagher & Flom (UK) LLP";
    let texts = org_texts_for(text, "LLP");
    assert_eq!(
      texts,
      vec![String::from(
        "Skadden, Arps, Slate,\nMeagher & Flom (UK) LLP"
      )]
    );
  }

  #[test]
  fn directly_preceding_connector_complete_firm_record_stops_name_walk() {
    let text = "Wachtell, Lipton, Rosen & Katz,\nMeagher & Flom (UK) LLP";
    let texts = org_texts_for(text, "LLP");
    assert_eq!(texts, vec![String::from("Meagher & Flom (UK) LLP")]);
  }

  #[test]
  fn comma_separated_party_roles_do_not_soft_wrap_into_organization() {
    let text = "Buyer, Seller,\nAcme LLC";
    let data = PreparedLegalFormData::new(LegalFormData {
      suffixes: vec![String::from("LLC")],
      role_heads: vec![String::from("buyer"), String::from("seller")],
      ..LegalFormData::default()
    });
    let suffix = "LLC";
    let suffix_start = text.find(suffix).unwrap();
    let found = SearchMatch::Literal {
      pattern: 0,
      start: u32::try_from(suffix_start).unwrap(),
      end: u32::try_from(suffix_start + suffix.len()).unwrap(),
    };
    let texts: Vec<String> = process_legal_form_matches(
      &[found],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
    )
    .unwrap()
    .into_iter()
    .map(|entity| entity.text)
    .collect();
    assert_eq!(texts, vec![String::from("Acme LLC")]);
  }

  #[test]
  fn decorated_party_roles_do_not_soft_wrap_into_organization() {
    let text = "Buyer (the “Buyer”), Seller,\nAcme LLC";
    let data = PreparedLegalFormData::new(LegalFormData {
      suffixes: vec![String::from("LLC")],
      role_heads: vec![String::from("buyer"), String::from("seller")],
      ..LegalFormData::default()
    });
    let suffix = "LLC";
    let suffix_start = text.find(suffix).unwrap();
    let found = SearchMatch::Literal {
      pattern: 0,
      start: u32::try_from(suffix_start).unwrap(),
      end: u32::try_from(suffix_start + suffix.len()).unwrap(),
    };
    let texts: Vec<String> = process_legal_form_matches(
      &[found],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
    )
    .unwrap()
    .into_iter()
    .map(|entity| entity.text)
    .collect();
    assert_eq!(texts, vec![String::from("Acme LLC")]);
  }

  #[test]
  fn multi_word_party_roles_do_not_soft_wrap_into_organization() {
    let text = "Donneur d'ordre, Emprunteur,\nAcme SARL";
    let data = PreparedLegalFormData::new(LegalFormData {
      suffixes: vec![String::from("SARL")],
      role_heads: vec![
        String::from("donneur d'ordre"),
        String::from("emprunteur"),
      ],
      ..LegalFormData::default()
    });
    let suffix = "SARL";
    let suffix_start = text.find(suffix).unwrap();
    let found = SearchMatch::Literal {
      pattern: 0,
      start: u32::try_from(suffix_start).unwrap(),
      end: u32::try_from(suffix_start + suffix.len()).unwrap(),
    };
    let texts: Vec<String> = process_legal_form_matches(
      &[found],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
    )
    .unwrap()
    .into_iter()
    .map(|entity| entity.text)
    .collect();
    assert_eq!(texts, vec![String::from("Acme SARL")]);
  }

  #[test]
  fn connector_complete_firm_can_wrap_immediately_before_legal_suffix() {
    let text = "Wachtell, Lipton, Rosen & Katz,\nLLP";
    let texts = org_texts_for(text, "LLP");
    assert_eq!(texts, vec![String::from(text)]);
  }

  #[test]
  fn short_connector_complete_firm_can_wrap_before_legal_suffix() {
    let text = "Smith, Gambrell & Russell,\nLLP";
    let texts = org_texts_for(text, "LLP");
    assert_eq!(texts, vec![String::from(text)]);
  }

  fn connector_test_data() -> PreparedLegalFormData {
    PreparedLegalFormData::new(LegalFormData {
      connector_words: vec![String::from("and")],
      and_connector_words: vec![String::from("and")],
      ..LegalFormData::default()
    })
  }

  fn czech_party_connector_entities(text: &str) -> Vec<String> {
    let suffix = "s.r.o.";
    let suffix_start = text.find(suffix).expect("suffix present");
    let found = SearchMatch::Literal {
      pattern: 0,
      start: u32::try_from(suffix_start).unwrap(),
      end: u32::try_from(suffix_start.saturating_add(suffix.len())).unwrap(),
    };
    let data = PreparedLegalFormData::new(LegalFormData {
      suffixes: vec![String::from(suffix)],
      connector_words: vec![String::from("a")],
      and_connector_words: vec![String::from("a")],
      role_heads: vec![
        String::from("smluvní"),
        String::from("strany"),
        String::from("nájemce"),
        String::from("kupujícím"),
      ],
      ..LegalFormData::default()
    });
    process_legal_form_matches(
      &[found],
      PatternSlice { start: 0, end: 1 },
      text,
      &data,
    )
    .unwrap()
    .into_iter()
    .map(|entity| entity.text)
    .collect()
  }

  #[test]
  fn unpunctuated_party_list_connector_fails_closed() {
    let text = "Smluvní strany Filip Sedláček a Orlické strojírny s.r.o.";
    assert_eq!(
      czech_party_connector_entities(text),
      vec![String::from(text)]
    );
  }

  #[test]
  fn role_label_does_not_split_connector_inside_organization_name() {
    let text = "Nájemce: Základní škola a Mateřská škola Brno, s.r.o.";
    assert_eq!(
      czech_party_connector_entities(text),
      vec![String::from("Základní škola a Mateřská škola Brno, s.r.o.")]
    );
  }

  proptest! {
    #[test]
    fn singular_role_labeled_company_is_not_party_evidence(
      label_space in prop_oneof![Just(" "), Just("\t"), Just("\u{00a0}"), Just("\u{202f}")],
      connector_space in prop_oneof![Just(" "), Just("\t"), Just("\u{00a0}"), Just("\u{202f}")],
    ) {
      for role in ["Nájemce:", "Smluvní strany:"] {
        for organization in [
          format!("Základní škola{connector_space}a{connector_space}Mateřská škola Brno, s.r.o."),
          format!("Alfa Beta{connector_space}a{connector_space}Partneři s.r.o."),
        ] {
          let text = format!("{role}{label_space}{organization}");
          prop_assert_eq!(
            czech_party_connector_entities(&text),
            vec![organization]
          );
        }
      }
    }
  }

  #[test]
  fn comma_before_ampersand_stays_inside_company_name() {
    let text = "Smith, Jones, & Brown LLP";
    assert_eq!(org_texts_for(text, "LLP"), vec![String::from(text)]);
  }

  #[test]
  fn language_connector_without_party_evidence_stays_inside_name() {
    let text = "Masaryk a partneři s.r.o.";
    assert_eq!(
      czech_party_connector_entities(text),
      vec![String::from(text)]
    );
  }

  proptest! {
    #[test]
    fn list_separator_connector_boundary_is_unicode_whitespace_invariant(
      separator in prop_oneof![Just(","), Just(";")],
      whitespace in prop_oneof![Just(" "), Just("\t"), Just("\u{00a0}"), Just("\u{202f}")],
    ) {
      let text = format!(
        "Jan Novák{separator}{whitespace}a{whitespace}kupujícím společností Modrá věž s.r.o."
      );
      prop_assert_eq!(
        czech_party_connector_entities(&text),
        vec![String::from("Modrá věž s.r.o.")]
      );
    }
  }

  #[test]
  fn connector_boundary_extends_across_two_word_company_prefix() {
    // "Acme Widgets and Bar, Inc." — "Widgets" is not a recognized in-name
    // legal-form word and there is no middle initial, so the old
    // "exactly two capitalized words" check alone stopped the walk at
    // "and" and left "Acme Widgets and" unredacted. Corroborating
    // person-name evidence is now required to block the walk, so absent
    // any it continues across the connector and recovers the full prefix.
    let data = connector_test_data();
    let text = "Acme Widgets and Bar, Inc.";
    let match_start = text.find("Bar").unwrap();
    assert_eq!(extend_backward(text, match_start, &data, false), 0);
  }

  proptest! {
    #[test]
    fn suffix_mode_recovers_companies_with_spaced_or_compact_initials(
      initial_space in prop_oneof![Just(""), Just(" "), Just("\t"), Just("\u{00a0}")],
    ) {
      let mut data = connector_test_data();
      data.company_suffix_words.insert(String::from("company"));
      let text = format!("J.{initial_space}P. Morgan and Company LLC");
      let company_start = text.find("Company").unwrap();

      prop_assert_eq!(extend_backward(&text, company_start, &data, false), 0);
      prop_assert_eq!(legal_form_entities(&text, &["LLC"], &[]), [text]);
    }

    #[test]
    fn ampersand_before_a_role_named_company_stays_inside_the_name(
      whitespace in prop_oneof![Just(" "), Just("\t"), Just("\u{00a0}"), Just("\u{202f}")],
    ) {
      let data = PreparedLegalFormData::new(LegalFormData {
        connector_words: vec![String::from("&")],
        and_connector_words: vec![String::from("and")],
        role_heads: vec![String::from("customer")],
        company_suffix_words: vec![String::from("solutions")],
        ..LegalFormData::default()
      });
      let text = format!("Smith, Jones,{whitespace}&{whitespace}Customer Solutions LLC");
      let suffix_start = text.find("LLC").unwrap();

      prop_assert_eq!(super::walk_backward(&text, suffix_start, &data), Some(0));
    }

    #[test]
    fn foreign_alphabetic_connector_cannot_create_an_english_party_boundary(
      whitespace in prop_oneof![Just(" "), Just("\t"), Just("\u{00a0}"), Just("\u{202f}")],
    ) {
      let data = PreparedLegalFormData::new(LegalFormData {
        connector_words: vec![String::from("e")],
        and_connector_words: vec![String::from("and")],
        role_heads: vec![String::from("customer")],
        company_suffix_words: vec![String::from("solutions")],
        ..LegalFormData::default()
      });
      let text = format!("Smith, Jones,{whitespace}e{whitespace}Customer Solutions LLC");
      let suffix_start = text.find("LLC").unwrap();

      prop_assert_eq!(super::walk_backward(&text, suffix_start, &data), Some(0));
    }
  }

  #[test]
  fn language_owned_connector_prose_still_marks_a_party_boundary() {
    let mut data = connector_test_data();
    data.connector_prose_heads.insert(String::from("supplier"));
    let text = "Supplier and Acme LLC";
    let organization_start = text.find("Acme").unwrap();
    let suffix_start = text.find("LLC").unwrap();

    assert_eq!(
      super::walk_backward(text, suffix_start, &data),
      Some(organization_start)
    );
  }

  #[test]
  fn connector_clause_nouns_are_language_isolated() {
    let text = "Alpha Beta Dohoda and Holdings LLC";
    let suffix_start = text.find("LLC").unwrap();
    let organization_start = text.find("Holdings").unwrap();
    let english = connector_test_data();
    let mut czech = connector_test_data();
    czech.clause_noun_heads.insert(String::from("dohoda"));

    assert_eq!(super::walk_backward(text, suffix_start, &english), Some(0));
    assert_eq!(
      super::walk_backward(text, suffix_start, &czech),
      Some(organization_start)
    );
  }

  #[test]
  fn connector_boundary_extends_across_institutional_head_for_company_word() {
    let mut data = connector_test_data();
    data.company_suffix_words.insert(String::from("associates"));
    data.institutional_heads.insert(String::from("court"));
    data
      .normalized_boundary_suffixes
      .insert(String::from("court"));
    let text = "Acme Court and Associates LLC";
    let match_start = text.find("Associates").unwrap();
    assert_eq!(extend_backward(text, match_start, &data, false), 0);
  }

  #[test]
  fn connector_boundary_still_protects_an_initialed_person_name() {
    // "Paul J. Newman and Apple, Inc." — a genuine dotted middle initial is
    // real person-name evidence, so the walk must still stop at "and"
    // rather than swallowing the person's name into the org span. (The
    // bare "Paul Newman and Apple, Inc." form carries no local signal that
    // distinguishes it from a genuine two-word company prefix like "Acme
    // Widgets and Bar, Inc." above — this initialed variant is the
    // preserved case the guard can still tell apart.)
    let data = connector_test_data();
    for (text, organization) in [
      ("Paul J. Newman and Apple, Inc.", "Apple, Inc."),
      ("Elon R. Musk and X Corp.", "X Corp."),
      ("Elon R. Musk and X Holdings I, Inc.", "X Holdings I, Inc."),
    ] {
      let match_start = text.find(organization).unwrap();
      assert_eq!(
        extend_backward(text, match_start, &data, false),
        match_start
      );
      let suffix = organization.split_whitespace().next_back().unwrap();
      assert_eq!(legal_form_entities(text, &[suffix], &[]), [organization]);
    }
  }

  #[test]
  fn configured_party_clause_does_not_absorb_a_preceding_date() {
    let text =
      "March 11, 2022 by and between HEALTHCARE TRUST OF AMERICA, INC.";
    let data = leading_clause_data();
    let company_start = text.find("HEALTHCARE").expect("company name");
    let suffix_start = text.find("INC").expect("legal form");
    assert_eq!(
      super::walk_backward(text, suffix_start, &data),
      Some(company_start)
    );
    assert_eq!(
      extend_backward(text, company_start, &data, false),
      company_start
    );
    assert_eq!(
      text.get(trim_leading_clause(text, &data).offset..),
      Some("HEALTHCARE TRUST OF AMERICA, INC.")
    );
    assert_eq!(
      legal_form_entities(text, &["INC", "INC."], &[]),
      ["HEALTHCARE TRUST OF AMERICA, INC."]
    );
  }

  fn role_head_test_data() -> PreparedLegalFormData {
    PreparedLegalFormData::new(LegalFormData {
      role_heads: vec![String::from("client"), String::from("vendor")],
      ..LegalFormData::default()
    })
  }

  #[test]
  fn role_head_digit_trim_recovers_digit_led_name() {
    // "Client 360 LLC" / "Vendor 1 LLC" — the role word is immediately
    // followed by a digit with no verb in between, so trim_role_head's
    // recovery scan has to find where the real name resumes. Restricting
    // the scan to uppercase-leading tokens skipped the digit-leading token
    // entirely and, with no later uppercase word to recover on, collapsed
    // the span down to the bare "LLC" suffix. A digit-leading token is now
    // accepted too, so "360"/"1" anchors the recovered span instead of
    // losing the name.
    let data = role_head_test_data();

    let client_text = "Client 360 LLC";
    let client_suffix_start = client_text.find("LLC").unwrap();
    let client_trim =
      trim_role_head(client_text, 0, client_text, client_suffix_start, &data)
        .expect("digit-after-role should still trim");
    assert_eq!(client_text.get(client_trim.start..), Some("360 LLC"));

    let vendor_text = "Vendor 1 LLC";
    let vendor_suffix_start = vendor_text.find("LLC").unwrap();
    let vendor_trim =
      trim_role_head(vendor_text, 0, vendor_text, vendor_suffix_start, &data)
        .expect("digit-after-role should still trim");
    assert_eq!(vendor_text.get(vendor_trim.start..), Some("1 LLC"));
  }
}
