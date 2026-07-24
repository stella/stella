use std::collections::{BTreeMap, BTreeSet};

use crate::anchored::{
  AnchorSpan, AnchorTerm, AnchoredExtractor, AnchoredRule,
};
use crate::resolution::{DetectionSource, PipelineEntity};
use crate::types::Result;

use crate::labels::DATE_LABEL;
const DATE_SCORE: f64 = 1.0;

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct DateData {
  pub month_names_by_language: BTreeMap<String, Vec<String>>,
  pub lowercase_month_ambiguities: BTreeMap<String, Vec<String>>,
  pub year_words_by_language: BTreeMap<String, Vec<String>>,
}

pub(crate) struct PreparedDateData {
  extractor: AnchoredExtractor<DateRule>,
}

impl PreparedDateData {
  pub(crate) fn new(data: &DateData) -> Option<Self> {
    AnchoredExtractor::new(DateRule::new(data))
      .map(|extractor| Self { extractor })
  }

  pub(crate) fn anchor_terms(&self) -> Vec<AnchorTerm> {
    self.extractor.anchor_terms()
  }

  pub(crate) fn process(
    &self,
    full_text: &str,
    anchors: &[AnchorSpan],
  ) -> Result<Vec<PipelineEntity>> {
    self.extractor.extract(full_text, anchors)
  }
}

struct DateRule {
  month_names: BTreeSet<String>,
  lowercase_ambiguous_month_names: BTreeSet<String>,
  year_words: BTreeSet<String>,
}

impl DateRule {
  fn new(data: &DateData) -> Self {
    Self {
      month_names: unique_word_set(&data.month_names_by_language, 3),
      lowercase_ambiguous_month_names: unique_word_set(
        &data.lowercase_month_ambiguities,
        3,
      ),
      year_words: unique_word_set(&data.year_words_by_language, 2),
    }
  }
}

impl AnchoredRule for DateRule {
  fn anchor_terms(&self) -> Vec<AnchorTerm> {
    self
      .month_names
      .iter()
      .cloned()
      .map(AnchorTerm::word_case_insensitive)
      .chain(
        self
          .year_words
          .iter()
          .cloned()
          .map(AnchorTerm::word_case_insensitive),
      )
      .collect()
  }

  fn extract(
    &self,
    full_text: &str,
    anchor: AnchorSpan,
  ) -> Result<Vec<PipelineEntity>> {
    let span = word_span(full_text, anchor);
    let clean = str_slice(full_text, span.start, span.end)
      .unwrap_or_default()
      .trim_end_matches('.')
      .to_lowercase();
    let mut spans = Vec::new();
    if self.month_names.contains(&clean) {
      spans.extend(
        date_spans_for_month(
          full_text,
          span.start,
          span.end,
          self.lowercase_ambiguous_month_names.contains(&clean),
        )
        .into_iter()
        .map(|(start, end)| (start, end, DetectionSource::Regex)),
      );
    }
    if self.year_words.contains(&clean)
      && let Some(year) = year_after_word_span(full_text, span.end)
    {
      spans.push((year.0, year.1, DetectionSource::Trigger));
    }

    Ok(
      spans
        .into_iter()
        .filter_map(|(start, end, source)| {
          date_entity(full_text, start, end, source)
        })
        .collect(),
    )
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Span {
  start: usize,
  end: usize,
}

fn unique_word_set(
  values_by_language: &BTreeMap<String, Vec<String>>,
  min_chars: usize,
) -> BTreeSet<String> {
  let mut seen = BTreeSet::new();
  for names in values_by_language.values() {
    for name in names {
      let clean = name.trim().trim_end_matches('.').to_lowercase();
      if clean.chars().count() >= min_chars {
        seen.insert(clean);
      }
    }
  }
  seen
}

fn word_span(full_text: &str, anchor: AnchorSpan) -> Span {
  let mut end = anchor.end.min(full_text.len());
  if starts_with_at(full_text, end, ".") {
    end = end.saturating_add(1);
  }
  Span {
    start: anchor.start,
    end,
  }
}

fn year_after_word_span(text: &str, word_end: usize) -> Option<(usize, usize)> {
  let after_word = skip_horizontal_ws(text, word_end);
  parse_year_forward(text, after_word)
}

fn date_spans_for_month(
  full_text: &str,
  month_start: usize,
  month_end: usize,
  ambiguous_month: bool,
) -> Vec<(usize, usize)> {
  let mut spans = Vec::new();

  if let Some(span) = day_month_year_span(full_text, month_start, month_end) {
    spans.push(span);
  } else if let Some(span) =
    day_month_span(full_text, month_start, month_end, ambiguous_month)
  {
    spans.push(span);
  }
  if let Some(span) = ordinal_day_month_span(full_text, month_start, month_end)
  {
    spans.push(span);
  }
  if let Some(span) = de_day_month_year_span(full_text, month_start, month_end)
  {
    spans.push(span);
  } else if let Some(span) =
    de_day_month_span(full_text, month_start, month_end, ambiguous_month)
  {
    spans.push(span);
  }
  if let Some(span) = month_day_year_span(full_text, month_start, month_end) {
    spans.push(span);
  }
  if let Some(span) = month_year_span(full_text, month_start, month_end) {
    spans.push(span);
  }
  if let Some(span) = year_month_day_span(full_text, month_start, month_end) {
    spans.push(span);
  }

  spans
}

fn day_month_span(
  text: &str,
  month_start: usize,
  month_end: usize,
  ambiguous_month: bool,
) -> Option<(usize, usize)> {
  let month = str_slice(text, month_start, month_end)?;
  if !allows_yearless_month(text, month, month_end, ambiguous_month) {
    return None;
  }
  let day = day_before_month(text, month_start)?;
  if starts_with_year_like_suffix(text, month_end) {
    return None;
  }
  right_date_boundary(text, month_end).then_some((day.0, month_end))
}

fn allows_yearless_month(
  text: &str,
  month: &str,
  month_end: usize,
  ambiguous: bool,
) -> bool {
  !ambiguous
    || is_titlecase_word(month)
    || has_hard_terminal_day_month_boundary(text, month_end)
}

fn is_titlecase_word(value: &str) -> bool {
  let mut letters = value.chars().filter(|character| character.is_alphabetic());
  letters.next().is_some_and(char::is_uppercase)
    && letters.all(char::is_lowercase)
}

fn has_hard_terminal_day_month_boundary(text: &str, month_end: usize) -> bool {
  let after_month = skip_horizontal_ws(text, month_end);
  str_tail(text, after_month)
    .and_then(|tail| tail.chars().next())
    .is_none_or(|character| {
      matches!(character, '.' | ';' | ':' | '!' | '?' | ')' | ']')
    })
}

fn date_entity(
  full_text: &str,
  start: usize,
  end: usize,
  source: DetectionSource,
) -> Option<PipelineEntity> {
  let start_u32 = u32::try_from(start).unwrap_or(u32::MAX);
  let end_u32 = u32::try_from(end).unwrap_or(u32::MAX);
  Some(PipelineEntity::detected(
    start_u32,
    end_u32,
    DATE_LABEL,
    str_slice(full_text, start, end)?.to_owned(),
    DATE_SCORE,
    source,
  ))
}

fn day_month_year_span(
  text: &str,
  month_start: usize,
  month_end: usize,
) -> Option<(usize, usize)> {
  let day = day_before_month(text, month_start)?;
  let after_month = skip_date_year_separator(text, month_end);
  let year = parse_year_forward(text, after_month)?;
  let end = parse_time_suffix(text, year.1).unwrap_or(year.1);
  Some((day.0, end))
}

fn ordinal_day_month_span(
  text: &str,
  month_start: usize,
  month_end: usize,
) -> Option<(usize, usize)> {
  let day = ordinal_day_before_month(text, month_start)?;
  let after_month = skip_date_year_separator(text, month_end);
  let end = parse_year_forward(text, after_month).map_or(month_end, |year| {
    parse_time_suffix(text, year.1).unwrap_or(year.1)
  });
  Some((day.0, end))
}

fn de_day_month_year_span(
  text: &str,
  month_start: usize,
  month_end: usize,
) -> Option<(usize, usize)> {
  let day = de_day_before_month(text, month_start)?;
  let after_month = skip_horizontal_ws(text, month_end);
  let after_de = parse_de_prefix(text, after_month).unwrap_or(after_month);
  let year = parse_year_forward(text, after_de)?;
  Some((day.0, year.1))
}

fn de_day_month_span(
  text: &str,
  month_start: usize,
  month_end: usize,
  ambiguous: bool,
) -> Option<(usize, usize)> {
  let month = str_slice(text, month_start, month_end)?;
  if !allows_yearless_month(text, month, month_end, ambiguous) {
    return None;
  }
  let day = de_day_before_month(text, month_start)?;
  if starts_with_year_like_suffix(text, month_end) {
    return None;
  }
  right_date_boundary(text, month_end).then_some((day.0, month_end))
}

fn month_day_year_span(
  text: &str,
  month_start: usize,
  month_end: usize,
) -> Option<(usize, usize)> {
  let after_month = skip_horizontal_ws(text, month_end);
  let day = parse_day_forward(text, after_month)?;
  let after_day = skip_date_year_separator(text, day.1);
  if let Some(year) = parse_year_forward(text, after_day) {
    return Some((month_start, year.1));
  }
  right_date_boundary(text, day.1).then_some((month_start, day.1))
}

fn month_year_span(
  text: &str,
  month_start: usize,
  month_end: usize,
) -> Option<(usize, usize)> {
  let after_month = skip_horizontal_ws(text, month_end);
  let year = parse_year_forward(text, after_month)?;
  Some((month_start, year.1))
}

fn year_month_day_span(
  text: &str,
  month_start: usize,
  month_end: usize,
) -> Option<(usize, usize)> {
  let before_month = skip_horizontal_ws_backward(text, month_start);
  if !ends_with_before(text, before_month, ".") {
    return None;
  }
  let year_end = before_month.saturating_sub(1);
  let year = parse_digits_backward(text, year_end, 4, 4)?;
  if !left_date_boundary(text, year.0) {
    return None;
  }

  let after_month = skip_horizontal_ws(text, month_end);
  let day = parse_day_forward(text, after_month)?;
  let end = if starts_with_at(text, day.1, ".") {
    day.1.saturating_add(1)
  } else {
    day.1
  };
  Some((year.0, end))
}

fn day_before_month(text: &str, month_start: usize) -> Option<(usize, usize)> {
  let mut end = skip_horizontal_ws_backward(text, month_start);
  if end == month_start {
    return None;
  }
  if ends_with_before(text, end, ".") {
    end = end.saturating_sub(1);
  }
  let day = parse_day_backward(text, end)?;
  left_date_boundary(text, day.0).then_some(day)
}

fn ordinal_day_before_month(
  text: &str,
  month_start: usize,
) -> Option<(usize, usize)> {
  let end = skip_horizontal_ws_backward(text, month_start);
  if end == month_start {
    return None;
  }
  for suffix in ["st", "nd", "rd", "th"] {
    if !ends_with_before_ascii_case_insensitive(text, end, suffix) {
      continue;
    }
    let day_end = end.saturating_sub(suffix.len());
    let day = parse_day_backward(text, day_end)?;
    if left_date_boundary(text, day.0) {
      return Some((day.0, end));
    }
  }
  None
}

fn de_day_before_month(
  text: &str,
  month_start: usize,
) -> Option<(usize, usize)> {
  let end = skip_horizontal_ws_backward(text, month_start);
  let de_start = end.checked_sub(2)?;
  if !str_slice(text, de_start, end)?.eq_ignore_ascii_case("de") {
    return None;
  }
  let day_end = skip_horizontal_ws_backward(text, de_start);
  let day = parse_day_backward(text, day_end)?;
  left_date_boundary(text, day.0).then_some((day.0, end))
}

fn parse_de_prefix(text: &str, index: usize) -> Option<usize> {
  let end = index.saturating_add(2);
  if !str_slice(text, index, end)?.eq_ignore_ascii_case("de") {
    return None;
  }
  Some(skip_horizontal_ws(text, end))
}

fn parse_year_forward(text: &str, index: usize) -> Option<(usize, usize)> {
  let year = parse_digits_forward(text, index, 4, 4)?;
  right_date_boundary(text, year.1).then_some(year)
}

fn starts_with_ascii_digit(text: &str, index: usize) -> bool {
  str_tail(text, index)
    .and_then(|tail| tail.chars().next())
    .is_some_and(|character| character.is_ascii_digit())
}

fn starts_with_year_like_suffix(text: &str, month_end: usize) -> bool {
  let after_month = skip_year_like_suffix_separator(text, month_end);
  let after_de = parse_de_prefix(text, after_month).unwrap_or(after_month);
  starts_with_ascii_digit(text, skip_any_ws(text, after_de))
}

fn parse_day_forward(text: &str, index: usize) -> Option<(usize, usize)> {
  let span = parse_digits_forward(text, index, 1, 2)?;
  valid_day(text, span).then_some(span)
}

fn parse_day_backward(text: &str, index: usize) -> Option<(usize, usize)> {
  let span = parse_digits_backward(text, index, 1, 2)?;
  valid_day(text, span).then_some(span)
}

#[must_use]
fn valid_day(text: &str, span: (usize, usize)) -> bool {
  str_slice(text, span.0, span.1)
    .and_then(|value| value.parse::<u8>().ok())
    .is_some_and(|day| (1..=31).contains(&day))
}

fn parse_digits_forward(
  text: &str,
  index: usize,
  min: usize,
  max: usize,
) -> Option<(usize, usize)> {
  let mut end = index;
  let mut count = 0usize;
  for ch in str_tail(text, index)?.chars() {
    if !ch.is_ascii_digit() || count == max {
      break;
    }
    end = end.saturating_add(ch.len_utf8());
    count = count.saturating_add(1);
  }
  (count >= min).then_some((index, end))
}

fn parse_digits_backward(
  text: &str,
  index: usize,
  min: usize,
  max: usize,
) -> Option<(usize, usize)> {
  let mut start = index;
  let mut count = 0usize;
  for (char_start, ch) in str_head(text, index)?.char_indices().rev() {
    if !ch.is_ascii_digit() || count == max {
      break;
    }
    start = char_start;
    count = count.saturating_add(1);
  }
  (count >= min).then_some((start, index))
}

fn parse_time_suffix(text: &str, index: usize) -> Option<usize> {
  let start = skip_horizontal_ws(text, index);
  let hour = parse_digits_forward(text, start, 1, 2)?;
  if !starts_with_at(text, hour.1, ":") {
    return None;
  }
  let minute = parse_digits_forward(text, hour.1.saturating_add(1), 2, 2)?;
  if !starts_with_at(text, minute.1, ":") {
    return Some(minute.1);
  }
  parse_digits_forward(text, minute.1.saturating_add(1), 2, 2)
    .map(|second| second.1)
}

fn skip_date_year_separator(text: &str, index: usize) -> usize {
  if starts_with_at(text, index, ",") {
    return skip_any_ws(text, index.saturating_add(1));
  }
  skip_horizontal_ws(text, index)
}

fn skip_year_like_suffix_separator(text: &str, index: usize) -> usize {
  let after_comma = if starts_with_at(text, index, ",") {
    index.saturating_add(1)
  } else {
    index
  };
  skip_any_ws(text, after_comma)
}

fn skip_any_ws(text: &str, mut index: usize) -> usize {
  while let Some(ch) =
    str_tail(text, index).and_then(|value| value.chars().next())
  {
    if !ch.is_whitespace() {
      break;
    }
    index = index.saturating_add(ch.len_utf8());
  }
  index
}

fn skip_horizontal_ws(text: &str, mut index: usize) -> usize {
  while let Some(ch) =
    str_tail(text, index).and_then(|value| value.chars().next())
  {
    if ch == '\n' || ch == '\r' || !ch.is_whitespace() {
      break;
    }
    index = index.saturating_add(ch.len_utf8());
  }
  index
}

fn skip_horizontal_ws_backward(text: &str, mut index: usize) -> usize {
  while let Some((char_start, ch)) =
    str_head(text, index).and_then(|value| value.char_indices().next_back())
  {
    if ch == '\n' || ch == '\r' || !ch.is_whitespace() {
      break;
    }
    index = char_start;
  }
  index
}

fn left_date_boundary(text: &str, index: usize) -> bool {
  str_head(text, index)
    .and_then(|value| value.chars().next_back())
    .is_none_or(|ch| !is_identifier_char(ch))
}

fn right_date_boundary(text: &str, index: usize) -> bool {
  str_tail(text, index)
    .and_then(|value| value.chars().next())
    .is_none_or(|ch| ch.is_whitespace() || ".,;!?)]".contains(ch))
}

fn is_identifier_char(ch: char) -> bool {
  ch == '_' || ch.is_alphanumeric()
}

fn starts_with_at(text: &str, index: usize, needle: &str) -> bool {
  str_tail(text, index).is_some_and(|value| value.starts_with(needle))
}

fn ends_with_before(text: &str, index: usize, needle: &str) -> bool {
  str_head(text, index).is_some_and(|value| value.ends_with(needle))
}

fn ends_with_before_ascii_case_insensitive(
  text: &str,
  index: usize,
  needle: &str,
) -> bool {
  let Some(start) = index.checked_sub(needle.len()) else {
    return false;
  };
  str_slice(text, start, index)
    .is_some_and(|value| value.eq_ignore_ascii_case(needle))
}

fn str_head(text: &str, index: usize) -> Option<&str> {
  text.get(..index)
}

fn str_tail(text: &str, index: usize) -> Option<&str> {
  text.get(index..)
}

fn str_slice(text: &str, start: usize, end: usize) -> Option<&str> {
  text.get(start..end)
}

#[cfg(test)]
mod tests {
  use super::date_spans_for_month;

  fn spans(text: &str) -> Vec<String> {
    spans_for(text, "July", false)
  }

  fn spans_for(text: &str, month: &str, ambiguous_month: bool) -> Vec<String> {
    let Some(month_start) = text.find(month) else {
      return Vec::new();
    };
    date_spans_for_month(
      text,
      month_start,
      month_start.saturating_add(month.len()),
      ambiguous_month,
    )
    .into_iter()
    .map(|(start, end)| text.get(start..end).unwrap_or_default().to_owned())
    .collect()
  }

  #[test]
  fn detects_plain_day_month_without_a_year() {
    assert_eq!(spans("The hearing was on 22 July."), vec!["22 July"]);
  }

  #[test]
  fn full_date_does_not_emit_a_nested_partial_date() {
    let found = spans("The hearing was on 22 July 2026.");
    assert_eq!(found, vec!["22 July 2026", "July 2026"]);
    assert!(!found.iter().any(|span| span == "22 July"));

    let comma_separated = spans("The hearing was on 22 July, 2026.");
    assert_eq!(comma_separated, vec!["22 July, 2026"]);

    assert!(spans("The malformed date is 22 July 20260.").is_empty());
    assert!(spans("The malformed date is 22 July, 2026A.").is_empty());
    assert!(spans("The malformed date is 22 July\n20260.").is_empty());
    assert!(
      spans_for("La fecha es 12 mayo de\n20260.", "mayo", false).is_empty()
    );
  }

  #[test]
  fn rejects_out_of_range_and_identifier_days() {
    assert!(spans("The reference is 42 July.").is_empty());
    assert!(spans("The reference is item22 July.").is_empty());
  }

  #[test]
  fn rejects_lowercase_words_that_overlap_month_names() {
    assert!(spans_for("Section 12 may be amended.", "may", true).is_empty());
    assert!(
      spans_for("Section 12 may, upon notice, be amended.", "may", true)
        .is_empty()
    );
    assert!(spans_for("SECTION 12 MAY BE AMENDED", "MAY", true).is_empty());
    assert!(spans_for("Section 12 may\nbe amended.", "may", true).is_empty());
    assert!(spans_for("Sections 11 and 12 set forth", "set", true).is_empty());
    assert_eq!(spans_for("Due 12 may.", "may", true), vec!["12 may"]);
    assert_eq!(
      spans_for("Effective 12 May next week.", "May", true),
      vec!["12 May"]
    );
    assert_eq!(spans_for("Due 12 may!", "may", true), vec!["12 may"]);
    assert_eq!(spans_for("Due 12 may?", "may", true), vec!["12 may"]);
  }

  #[test]
  fn accepts_unambiguous_lowercase_months_used_in_other_languages() {
    assert_eq!(
      spans_for("Audience le 22 juillet.", "juillet", false),
      vec!["22 juillet"]
    );
    assert_eq!(
      spans_for("Audiencia 12 mayo.", "mayo", false),
      vec!["12 mayo"]
    );
    assert_eq!(
      spans_for("Jednání 12 září.", "září", false),
      vec!["12 září"]
    );
  }

  #[test]
  fn detects_de_prefixed_day_month_without_a_year() {
    assert_eq!(
      spans_for("Audiencia 12 de mayo.", "mayo", false),
      vec!["12 de mayo"]
    );
    assert_eq!(
      spans_for("Audiência 12 de maio.", "maio", false),
      vec!["12 de maio"]
    );
    assert!(
      spans_for("Audiencia 12 de mayo, 20260.", "mayo", false).is_empty()
    );
    assert!(
      spans_for("Audiencia 12 de mayo de 20260.", "mayo", false).is_empty()
    );
    assert!(
      spans_for("Audiencia 12 de mayo de 2026A.", "mayo", false).is_empty()
    );
    assert!(
      spans_for("Audiencia 12 de mayo\nde 20260.", "mayo", false).is_empty()
    );
    assert!(
      spans_for("Audiencia 12 de mayo de\n20260.", "mayo", false).is_empty()
    );
  }
}
