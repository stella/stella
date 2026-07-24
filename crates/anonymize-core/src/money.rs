use std::collections::BTreeSet;

use crate::anchored::{
  AnchorSpan, AnchorTerm, AnchoredExtractor, AnchoredRule,
};
use crate::resolution::{DetectionSource, PipelineEntity, SourceDetail};
use crate::types::Result;

use crate::labels::MONETARY_AMOUNT_LABEL;
const MONEY_SCORE: f64 = 0.9;
const MAX_LEFT_SCAN_BYTES: usize = 96;
const MAX_MONEY_NUMBER_SCAN_BYTES: usize = 48;
const MAX_UNGROUPED_MONEY_DIGITS: usize = 9;

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct MonetaryData {
  pub currencies: CurrencyData,
  pub amount_words: AmountWordsData,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct CurrencyData {
  pub codes: Vec<String>,
  pub symbols: Vec<String>,
  pub local_names: Vec<String>,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct AmountWordsData {
  pub written_amount_patterns: Vec<WrittenAmountPatternData>,
  pub magnitude_suffixes: Vec<MagnitudeSuffixData>,
  pub share_quantity_terms: Vec<ShareQuantityTermData>,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct WrittenAmountPatternData {
  pub keywords: Vec<String>,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct MagnitudeSuffixData {
  pub words: Vec<String>,
  pub abbreviations_case_insensitive: Vec<String>,
  pub abbreviations_case_sensitive: Vec<String>,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct ShareQuantityTermData {
  pub modifiers: Vec<String>,
  pub nouns: Vec<String>,
}

pub(crate) struct PreparedMonetaryData {
  extractor: AnchoredExtractor<MonetaryRule>,
}

impl PreparedMonetaryData {
  pub(crate) fn new(data: MonetaryData) -> Option<Self> {
    AnchoredExtractor::new(MonetaryRule::new(data))
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

  pub(crate) fn extend_entities(
    &self,
    full_text: &str,
    entities: Vec<PipelineEntity>,
  ) -> Vec<PipelineEntity> {
    self.extractor.rule().extend_entities(full_text, entities)
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AnchorKind {
  Code,
  Symbol,
  LocalName,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct MagnitudeTerm {
  text: String,
  folded: String,
  case_insensitive: bool,
}

struct MonetaryRule {
  codes: BTreeSet<String>,
  symbols: BTreeSet<String>,
  local_names: Vec<CurrencyName>,
  magnitudes: Vec<MagnitudeTerm>,
  quantity_followers: Vec<String>,
  written_amount_keywords: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CurrencyName {
  text: String,
  folded: String,
  case_insensitive: bool,
  whole_words: bool,
}

impl MonetaryRule {
  fn new(data: MonetaryData) -> Self {
    let codes = clean_terms(data.currencies.codes)
      .into_iter()
      .collect::<BTreeSet<_>>();
    let symbols = clean_terms(data.currencies.symbols)
      .into_iter()
      .collect::<BTreeSet<_>>();
    let mut local_names = clean_terms(data.currencies.local_names)
      .into_iter()
      .map(currency_name)
      .collect::<Vec<_>>();
    local_names.sort_by_key(|name| std::cmp::Reverse(name.text.len()));
    let mut magnitudes = Vec::new();
    for entry in data.amount_words.magnitude_suffixes {
      magnitudes.extend(
        clean_terms(entry.words)
          .into_iter()
          .map(|text| magnitude_term(text, true)),
      );
      magnitudes.extend(
        clean_terms(entry.abbreviations_case_insensitive)
          .into_iter()
          .map(|text| magnitude_term(text, true)),
      );
      magnitudes.extend(
        clean_terms(entry.abbreviations_case_sensitive)
          .into_iter()
          .map(|text| magnitude_term(text, false)),
      );
    }
    magnitudes.sort_by_key(|term| std::cmp::Reverse(term.text.len()));

    let mut quantity_followers = Vec::new();
    for entry in data.amount_words.share_quantity_terms {
      quantity_followers.extend(clean_terms(entry.modifiers));
      quantity_followers.extend(clean_terms(entry.nouns));
    }
    quantity_followers.sort_by_key(|term| std::cmp::Reverse(term.len()));

    let mut written_amount_keywords = Vec::new();
    for entry in data.amount_words.written_amount_patterns {
      written_amount_keywords.extend(
        clean_terms(entry.keywords)
          .into_iter()
          .map(|term| term.to_lowercase()),
      );
    }
    written_amount_keywords.sort_by_key(|term| std::cmp::Reverse(term.len()));

    Self {
      codes,
      symbols,
      local_names,
      magnitudes,
      quantity_followers,
      written_amount_keywords,
    }
  }

  fn classify_anchor(&self, text: &str) -> Option<AnchorKind> {
    if self.symbols.contains(text) {
      return Some(AnchorKind::Symbol);
    }
    if self.codes.contains(text) {
      return Some(AnchorKind::Code);
    }

    let folded = text.to_lowercase();
    self.local_names.iter().find_map(|name| {
      if name.case_insensitive && name.folded == folded {
        return Some(AnchorKind::LocalName);
      }
      (!name.case_insensitive && name.text == text)
        .then_some(AnchorKind::LocalName)
    })
  }
}

impl AnchoredRule for MonetaryRule {
  fn anchor_terms(&self) -> Vec<AnchorTerm> {
    let mut anchors = Vec::new();
    anchors.extend(
      self
        .codes
        .iter()
        .cloned()
        .map(AnchorTerm::word_case_sensitive),
    );
    anchors.extend(self.symbols.iter().cloned().map(AnchorTerm::symbol));
    anchors.extend(self.local_names.iter().map(|name| {
      AnchorTerm::new(
        name.text.clone(),
        name.case_insensitive,
        name.whole_words,
      )
    }));
    anchors
  }

  fn extract(
    &self,
    full_text: &str,
    anchor: AnchorSpan,
  ) -> Result<Vec<PipelineEntity>> {
    let Some(anchor_text) = str_slice(full_text, anchor.start, anchor.end)
    else {
      return Ok(Vec::new());
    };
    let Some(kind) = self.classify_anchor(anchor_text) else {
      return Ok(Vec::new());
    };

    let mut entities = Vec::new();
    if let Some((start, end)) =
      self.leading_amount_span(full_text, anchor, kind)
      && let Some(entity) = money_entity(full_text, start, end)
    {
      entities.push(entity);
    }
    if let Some((start, end)) =
      self.trailing_amount_span(full_text, anchor, kind)
      && let Some(entity) = money_entity(full_text, start, end)
    {
      entities.push(entity);
    }

    Ok(entities)
  }
}

impl MonetaryRule {
  fn extend_entities(
    &self,
    full_text: &str,
    mut entities: Vec<PipelineEntity>,
  ) -> Vec<PipelineEntity> {
    for entity in &mut entities {
      self.extend_entity(full_text, entity);
    }
    entities
  }

  fn extend_entity(&self, full_text: &str, entity: &mut PipelineEntity) {
    if entity.label != MONETARY_AMOUNT_LABEL || caller_owned(entity) {
      return;
    }

    let mut end = usize::try_from(entity.end).unwrap_or(usize::MAX);
    if !ends_with_letter(&entity.text)
      && let Some(currency_end) = self.trailing_currency_end(full_text, end)
    {
      end = currency_end;
    }
    end = self.extend_written_amount(full_text, end);

    let Ok(end_u32) = u32::try_from(end) else {
      return;
    };
    if end_u32 == entity.end {
      return;
    }

    let Ok(start) = usize::try_from(entity.start) else {
      return;
    };
    let Some(text) = str_slice(full_text, start, end) else {
      return;
    };
    entity.end = end_u32;
    text.clone_into(&mut entity.text);
  }

  fn trailing_currency_end(&self, text: &str, index: usize) -> Option<usize> {
    let start = skip_trailing_currency_gap(text, index, 4);

    for name in &self.local_names {
      let end = start.saturating_add(name.text.len());
      let Some(candidate) = str_slice(text, start, end) else {
        continue;
      };
      let matches = if name.case_insensitive {
        candidate.to_lowercase() == name.folded
      } else {
        candidate == name.text
      };
      if matches && right_alnum_boundary(text, end) {
        return Some(end);
      }
    }

    for code in &self.codes {
      let end = start.saturating_add(code.len());
      let Some(candidate) = str_slice(text, start, end) else {
        continue;
      };
      if candidate == code && right_alnum_boundary(text, end) {
        return Some(end);
      }
    }

    None
  }

  fn leading_amount_span(
    &self,
    text: &str,
    anchor: AnchorSpan,
    kind: AnchorKind,
  ) -> Option<(usize, usize)> {
    if !left_money_boundary(text, anchor.start, kind) {
      return None;
    }

    let number_start = skip_horizontal_ws_limit(text, anchor.end, 2);
    let number = parse_number_forward(text, number_start)?;
    let (end, _) = self
      .parse_magnitude_forward(text, number.end)
      .unwrap_or((number.end, false));
    right_money_boundary(text, end)
      .then(|| (anchor.start, self.extend_written_amount(text, end)))
  }

  fn trailing_amount_span(
    &self,
    text: &str,
    anchor: AnchorSpan,
    kind: AnchorKind,
  ) -> Option<(usize, usize)> {
    if !right_money_boundary(text, anchor.end) {
      return None;
    }

    let scan_start = char_boundary_before(
      text,
      anchor.start.saturating_sub(MAX_LEFT_SCAN_BYTES),
    );
    let window = str_slice(text, scan_start, anchor.start)?;
    let mut best = None;

    for (offset, ch) in window.char_indices() {
      if !ch.is_ascii_digit() {
        continue;
      }
      let number_start = scan_start.saturating_add(offset);
      let number = parse_number_forward(text, number_start)?;
      let (after_number, has_magnitude) = self
        .parse_magnitude_forward(text, number.end)
        .unwrap_or((number.end, false));
      let after_gap = skip_horizontal_ws_limit(text, after_number, 4);
      if after_gap != anchor.start {
        continue;
      }

      let start = leading_symbol_start(text, number.start)
        .filter(|value| left_money_boundary(text, *value, AnchorKind::Symbol))
        .unwrap_or(number.start);
      if !left_money_boundary(text, start, kind) {
        continue;
      }
      if has_magnitude
        && kind != AnchorKind::Symbol
        && self.has_quantity_follower(text, anchor.end)
      {
        continue;
      }
      let end = self.extend_written_amount(text, anchor.end);
      if best.is_none_or(|(best_start, _)| start < best_start) {
        best = Some((start, end));
      }
    }

    best
  }

  fn parse_magnitude_forward(
    &self,
    text: &str,
    index: usize,
  ) -> Option<(usize, bool)> {
    let start = skip_horizontal_ws_limit(text, index, 8);
    self.match_magnitude_at(text, start).map(|end| (end, true))
  }

  fn match_magnitude_at(&self, text: &str, index: usize) -> Option<usize> {
    for term in &self.magnitudes {
      let end = index.saturating_add(term.text.len());
      let Some(candidate) = str_slice(text, index, end) else {
        continue;
      };
      let matches = if term.case_insensitive {
        candidate.to_lowercase() == term.folded
      } else {
        candidate == term.text
      };
      if matches && right_word_boundary(text, end) {
        return Some(end);
      }
    }
    None
  }

  fn has_quantity_follower(&self, text: &str, index: usize) -> bool {
    let start = skip_horizontal_ws_limit(text, index, 16);
    self.quantity_followers.iter().any(|term| {
      let end = start.saturating_add(term.len());
      str_slice(text, start, end).is_some_and(|candidate| {
        candidate.to_lowercase() == *term && right_word_boundary(text, end)
      })
    })
  }

  fn extend_written_amount(&self, text: &str, index: usize) -> usize {
    if self.written_amount_keywords.is_empty() {
      return index;
    }

    self.match_written_amount_at(text, index).unwrap_or(index)
  }

  fn match_written_amount_at(&self, text: &str, index: usize) -> Option<usize> {
    let after = str_tail(text, index)?;
    let mut cursor = 0usize;

    if let Some(ch) = after.chars().next()
      && matches!(ch, ',' | ';')
    {
      cursor = cursor.saturating_add(ch.len_utf8());
    }

    cursor = skip_horizontal_ws_limit(after, cursor, usize::MAX);
    if after.get(cursor..)?.chars().next()? != '(' {
      return None;
    }

    cursor = cursor.saturating_add('('.len_utf8());
    let keyword_end = self.match_written_amount_keyword(after, cursor)?;
    cursor = keyword_end;
    let separator = after.get(cursor..)?.chars().next()?;
    if separator == '\n' || separator == '\r' {
      return None;
    }
    if separator != ':' && !separator.is_whitespace() {
      return None;
    }
    cursor = cursor.saturating_add(separator.len_utf8());

    let mut content_chars = 0usize;
    for (offset, ch) in after.get(cursor..)?.char_indices() {
      if ch == '\n' || ch == '\r' {
        return None;
      }
      if ch == ')' {
        if content_chars == 0 || content_chars > 120 {
          return None;
        }
        return Some(
          index
            .saturating_add(cursor)
            .saturating_add(offset)
            .saturating_add(ch.len_utf8()),
        );
      }
      content_chars = content_chars.saturating_add(1);
      if content_chars > 120 {
        return None;
      }
    }

    None
  }

  fn match_written_amount_keyword(
    &self,
    text: &str,
    index: usize,
  ) -> Option<usize> {
    for keyword in &self.written_amount_keywords {
      let end = index.saturating_add(keyword.len());
      let Some(candidate) = str_slice(text, index, end) else {
        continue;
      };
      if candidate.to_lowercase() == *keyword {
        return Some(end);
      }
    }
    None
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct NumberSpan {
  start: usize,
  end: usize,
}

fn parse_number_forward(text: &str, index: usize) -> Option<NumberSpan> {
  let mut digits = 0usize;
  let mut end = index;
  let mut value_end = index;
  let mut current_group_digits = 0usize;
  let mut first_component_digits = 0usize;
  let mut has_separator = false;
  let mut has_grouping_separator = false;

  for (offset, ch) in str_tail(text, index)?.char_indices() {
    let char_start = index.saturating_add(offset);
    if char_start.saturating_sub(index) > MAX_MONEY_NUMBER_SCAN_BYTES {
      break;
    }

    if ch.is_ascii_digit() {
      digits = digits.saturating_add(1);
      current_group_digits = current_group_digits.saturating_add(1);
      end = char_start.saturating_add(ch.len_utf8());
      value_end = end;
      continue;
    }

    if is_dash(ch) && digits > 0 {
      value_end = char_start.saturating_add(ch.len_utf8());
      break;
    }

    if is_number_separator(ch)
      && number_separator_continues(
        text,
        char_start.saturating_add(ch.len_utf8()),
        ch,
      )
    {
      if !has_separator {
        first_component_digits = current_group_digits;
      }
      let next_index = char_start.saturating_add(ch.len_utf8());
      let next_group_digits = digit_run_after_separator(text, next_index, ch);
      if current_group_digits > 0
        && current_group_digits <= 3
        && next_group_digits == 3
      {
        has_grouping_separator = true;
      }
      has_separator = true;
      current_group_digits = 0;
      end = char_start.saturating_add(ch.len_utf8());
      continue;
    }

    break;
  }

  if digits == 0 {
    return None;
  }
  let leading_digits = if has_separator {
    first_component_digits
  } else {
    digits
  };
  if !has_grouping_separator && leading_digits > MAX_UNGROUPED_MONEY_DIGITS {
    return None;
  }

  Some(NumberSpan {
    start: index,
    end: value_end.max(end),
  })
}

fn digit_run_after_separator(
  text: &str,
  index: usize,
  separator: char,
) -> usize {
  let mut count = 0usize;
  let mut skipping_spaces = separator.is_whitespace();
  for ch in str_tail(text, index).into_iter().flat_map(str::chars) {
    if skipping_spaces && ch.is_whitespace() && ch != '\n' && ch != '\r' {
      continue;
    }
    skipping_spaces = false;
    if !ch.is_ascii_digit() {
      break;
    }
    count = count.saturating_add(1);
  }
  count
}

fn number_separator_continues(
  text: &str,
  index: usize,
  separator: char,
) -> bool {
  let mut saw_space = false;
  for ch in str_tail(text, index)
    .into_iter()
    .flat_map(str::chars)
    .take(2)
  {
    if ch == '\n' || ch == '\r' {
      return false;
    }
    if ch.is_whitespace() {
      saw_space = true;
      continue;
    }
    if separator.is_whitespace() {
      return ch.is_ascii_digit();
    }
    return (!saw_space && ch.is_ascii_digit()) || is_dash(ch);
  }
  false
}

fn money_entity(
  full_text: &str,
  start: usize,
  end: usize,
) -> Option<PipelineEntity> {
  let start_u32 = u32::try_from(start).unwrap_or(u32::MAX);
  let end_u32 = u32::try_from(end).unwrap_or(u32::MAX);
  Some(PipelineEntity::detected(
    start_u32,
    end_u32,
    MONETARY_AMOUNT_LABEL,
    str_slice(full_text, start, end)?.to_owned(),
    MONEY_SCORE,
    DetectionSource::Regex,
  ))
}

fn leading_symbol_start(text: &str, number_start: usize) -> Option<usize> {
  let before_number = skip_horizontal_ws_backward_limit(text, number_start, 2);
  let (symbol_start, ch) = previous_char(text, before_number)?;
  is_currency_symbol(ch).then_some(symbol_start)
}

fn currency_name(text: String) -> CurrencyName {
  let case_insensitive = is_ascii_phrase(&text) && text.chars().count() >= 3;
  let whole_words = text
    .chars()
    .all(|ch| ch.is_alphanumeric() || ch.is_whitespace());
  CurrencyName {
    folded: text.to_lowercase(),
    text,
    case_insensitive,
    whole_words,
  }
}

fn magnitude_term(text: String, case_insensitive: bool) -> MagnitudeTerm {
  MagnitudeTerm {
    folded: text.to_lowercase(),
    text,
    case_insensitive,
  }
}

fn clean_terms(values: Vec<String>) -> Vec<String> {
  values
    .into_iter()
    .map(|value| value.trim().to_owned())
    .filter(|value| !value.is_empty())
    .collect()
}

fn left_money_boundary(text: &str, index: usize, kind: AnchorKind) -> bool {
  if kind == AnchorKind::Symbol {
    return true;
  }
  previous_char(text, index).is_none_or(|(_, ch)| !is_identifier_char(ch))
}

fn right_money_boundary(text: &str, index: usize) -> bool {
  str_tail(text, index)
    .and_then(|value| value.chars().next())
    .is_none_or(|ch| ch.is_whitespace() || ".,;!?)]}".contains(ch))
}

fn right_word_boundary(text: &str, index: usize) -> bool {
  str_tail(text, index)
    .and_then(|value| value.chars().next())
    .is_none_or(|ch| !is_identifier_char(ch))
}

fn is_ascii_phrase(text: &str) -> bool {
  text
    .chars()
    .all(|ch| ch.is_ascii_alphabetic() || ch.is_whitespace())
}

fn is_identifier_char(ch: char) -> bool {
  ch == '_' || ch.is_alphanumeric()
}

fn right_alnum_boundary(text: &str, index: usize) -> bool {
  str_tail(text, index)
    .and_then(|value| value.chars().next())
    .is_none_or(|ch| !ch.is_alphanumeric())
}

fn ends_with_letter(text: &str) -> bool {
  text.chars().next_back().is_some_and(char::is_alphabetic)
}

const fn caller_owned(entity: &PipelineEntity) -> bool {
  matches!(
    entity.source_detail,
    Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
  )
}

const fn is_number_separator(ch: char) -> bool {
  ch == ','
    || ch == '.'
    || ch == '\''
    || (ch.is_whitespace() && ch != '\n' && ch != '\r')
}

const fn is_dash(ch: char) -> bool {
  matches!(
    ch,
    '-'
      | '‐'
      | '‑'
      | '‒'
      | '–'
      | '—'
      | '―'
      | '⸺'
      | '⸻'
      | '⁃'
      | '־'
      | '−'
  )
}

const fn is_currency_symbol(ch: char) -> bool {
  matches!(
    ch,
    '$'
      | '£'
      | '¥'
      | '৳'
      | '₡'
      | '₦'
      | '₩'
      | '₪'
      | '₫'
      | '€'
      | '₭'
      | '₮'
      | '₱'
      | '₲'
      | '₴'
      | '₵'
      | '₸'
      | '₹'
      | '₺'
      | '₼'
      | '₽'
      | '₾'
  )
}

fn skip_horizontal_ws_limit(
  text: &str,
  mut index: usize,
  max_chars: usize,
) -> usize {
  let mut skipped = 0usize;
  while skipped < max_chars {
    let Some(ch) = str_tail(text, index).and_then(|value| value.chars().next())
    else {
      break;
    };
    if ch == '\n' || ch == '\r' || !ch.is_whitespace() {
      break;
    }
    index = index.saturating_add(ch.len_utf8());
    skipped = skipped.saturating_add(1);
  }
  index
}

fn skip_trailing_currency_gap(
  text: &str,
  mut index: usize,
  max_chars: usize,
) -> usize {
  let mut skipped = 0usize;
  while skipped < max_chars {
    let Some(ch) = str_tail(text, index).and_then(|value| value.chars().next())
    else {
      break;
    };
    if ch == '\n' || ch == '\t' || !ch.is_whitespace() {
      break;
    }
    index = index.saturating_add(ch.len_utf8());
    skipped = skipped.saturating_add(1);
  }
  index
}

fn skip_horizontal_ws_backward_limit(
  text: &str,
  mut index: usize,
  max_chars: usize,
) -> usize {
  let mut skipped = 0usize;
  while skipped < max_chars {
    let Some((char_start, ch)) = previous_char(text, index) else {
      break;
    };
    if ch == '\n' || ch == '\r' || !ch.is_whitespace() {
      break;
    }
    index = char_start;
    skipped = skipped.saturating_add(1);
  }
  index
}

fn previous_char(text: &str, index: usize) -> Option<(usize, char)> {
  str_head(text, index)?.char_indices().next_back()
}

const fn char_boundary_before(text: &str, mut index: usize) -> usize {
  while !text.is_char_boundary(index) {
    index = index.saturating_sub(1);
  }
  index
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
