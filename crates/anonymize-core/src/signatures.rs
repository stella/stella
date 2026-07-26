use crate::resolution::{DetectionSource, PipelineEntity};

use crate::labels::PERSON_LABEL;
const MAX_NAME_LEN: usize = 60;
const MAX_WITNESS_SCAN_UNITS: usize = 600;

#[derive(Clone, Copy, Eq, PartialEq)]
enum CandidateContext {
  SignatureBlock,
  LabelledField,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct SignatureData {
  #[serde(default)]
  pub labels: Vec<String>,
  #[serde(default)]
  pub witness_phrases: Vec<String>,
  #[serde(default)]
  pub name_particles: Vec<String>,
  #[serde(default)]
  pub post_nominal_suffixes: Vec<String>,
  #[serde(default)]
  pub organization_suffixes: Vec<String>,
  #[serde(default)]
  pub image_stub_prefixes: Vec<String>,
  /// Form-field label words ("Name", "Jméno", "Funkce"). Tied to a ':' they
  /// start the next field of a signature grid, so they terminate the span
  /// that precedes them instead of joining it.
  pub form_field_labels: Vec<String>,
  /// Fixed strings PDF signing software stamps onto a page ("Digitally
  /// signed by", "Digitálně podepsal"). They sit immediately after a name
  /// and must terminate the person span rather than extend it.
  pub signature_stamp_phrases: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedSignatureData {
  labels: Vec<String>,
  witness_phrases: Vec<String>,
  form_field_labels: Vec<String>,
  signature_stamp_phrases: Vec<String>,
  name_particles: Vec<String>,
  post_nominal_suffixes: Vec<String>,
  organization_suffixes: Vec<String>,
  image_stub_prefixes: Vec<String>,
}

impl PreparedSignatureData {
  #[must_use]
  pub(crate) fn new(data: SignatureData) -> Self {
    Self {
      labels: non_empty_lowercase(data.labels),
      witness_phrases: non_empty_lowercase(data.witness_phrases),
      form_field_labels: non_empty_lowercase(data.form_field_labels),
      signature_stamp_phrases: non_empty_lowercase(
        data.signature_stamp_phrases,
      ),
      name_particles: non_empty_lowercase(data.name_particles),
      post_nominal_suffixes: non_empty_compact_lowercase(
        data.post_nominal_suffixes,
      ),
      organization_suffixes: non_empty_lowercase(data.organization_suffixes),
      image_stub_prefixes: non_empty_lowercase(data.image_stub_prefixes),
    }
  }

  /// Vocabulary that terminates a person span. Owned here because it is
  /// signature-block domain data; applied once, in the resolution boundary
  /// pass, rather than by each detector that can produce a person span.
  #[must_use]
  pub(crate) fn person_span_terminators(&self) -> PersonSpanTerminators<'_> {
    PersonSpanTerminators {
      stamp_phrases: &self.signature_stamp_phrases,
      field_labels: &self.form_field_labels,
    }
  }

  #[must_use]
  pub(crate) fn form_field_labels(&self) -> &[String] {
    &self.form_field_labels
  }
}

/// Lowercased vocabulary marking where a person span must stop.
#[derive(Clone, Copy, Debug, Default)]
pub struct PersonSpanTerminators<'a> {
  /// Signing-software stamps that follow a name ("digitally signed by").
  pub stamp_phrases: &'a [String],
  /// Field labels that start the next cell of a form ("name", "jméno").
  pub field_labels: &'a [String],
}

#[must_use]
pub(crate) fn detect_signatures(
  full_text: &str,
  data: &PreparedSignatureData,
) -> Vec<PipelineEntity> {
  let mut results = Vec::new();
  detect_slash_s(full_text, data, &mut results);
  detect_labelled_names(full_text, data, &mut results);
  detect_witness_blocks(full_text, data, &mut results);
  results
}

fn detect_slash_s(
  full_text: &str,
  data: &PreparedSignatureData,
  results: &mut Vec<PipelineEntity>,
) {
  let mut cursor = 0usize;
  while let Some(relative) =
    full_text.get(cursor..).and_then(|tail| tail.find("/s/"))
  {
    let mark_start = cursor.saturating_add(relative);
    let mut after_mark = mark_start.saturating_add("/s/".len());
    after_mark = skip_horizontal_ws(full_text, after_mark);
    let line_end = find_line_end(full_text, after_mark);
    let same_line = full_text
      .get(after_mark..line_end)
      .unwrap_or_default()
      .trim();
    if same_line.is_empty() {
      try_emit_forward_lines(
        results,
        full_text,
        data,
        line_end.saturating_add(1),
        4,
        0.9,
        CandidateContext::SignatureBlock,
      );
    } else {
      let first_cell_end = after_mark.saturating_add(
        full_text.get(after_mark..line_end).map_or_else(
          || line_end.saturating_sub(after_mark),
          slash_s_cell_end,
        ),
      );
      try_emit(
        results,
        full_text,
        data,
        after_mark,
        first_cell_end,
        0.95,
        CandidateContext::SignatureBlock,
      );
    }

    if let Some((prev_start, prev_end)) =
      find_prev_line(full_text, data, mark_start)
    {
      try_emit(
        results,
        full_text,
        data,
        prev_start,
        prev_end,
        0.85,
        CandidateContext::SignatureBlock,
      );
    }
    cursor = mark_start.saturating_add("/s/".len());
  }
}

fn detect_labelled_names(
  full_text: &str,
  data: &PreparedSignatureData,
  results: &mut Vec<PipelineEntity>,
) {
  let mut line_start = 0usize;
  while line_start <= full_text.len() {
    let line_end = find_line_end(full_text, line_start);
    if let Some(line) = full_text.get(line_start..line_end) {
      detect_labelled_names_in_line(full_text, data, line_start, line, results);
    }
    if line_end >= full_text.len() {
      break;
    }
    line_start = line_end.saturating_add(1);
  }
}

fn detect_labelled_names_in_line(
  full_text: &str,
  data: &PreparedSignatureData,
  line_start: usize,
  line: &str,
  results: &mut Vec<PipelineEntity>,
) {
  let mut cursor = 0usize;
  while let Some(label) = find_label(line, cursor, data) {
    let mut value_start = label.value_start;
    if let Some(after_slash) = slash_s_prefix_end(line, value_start) {
      value_start = after_slash;
    }
    let value_end = value_start.saturating_add(
      line
        .get(value_start..)
        .and_then(first_column_end)
        .unwrap_or_else(|| line.len().saturating_sub(value_start)),
    );
    let global_start = line_start.saturating_add(value_start);
    let global_end = line_start.saturating_add(value_end);
    let value_is_empty = line
      .get(value_start..value_end)
      .unwrap_or_default()
      .trim()
      .is_empty();
    if value_is_empty {
      try_emit_forward_lines(
        results,
        full_text,
        data,
        global_end.saturating_add(1),
        3,
        0.9,
        CandidateContext::LabelledField,
      );
    } else {
      try_emit(
        results,
        full_text,
        data,
        global_start,
        global_end,
        0.95,
        CandidateContext::LabelledField,
      );
    }
    cursor = value_end.max(label.next_cursor);
  }
}

fn detect_witness_blocks(
  full_text: &str,
  data: &PreparedSignatureData,
  results: &mut Vec<PipelineEntity>,
) {
  let mut cursor = 0usize;
  while let Some((anchor, phrase_len)) =
    find_next_witness_phrase(full_text, cursor, data)
  {
    if !has_word_boundaries(full_text, anchor, phrase_len) {
      cursor = anchor.saturating_add(1);
      continue;
    }
    let anchor_line_end = find_line_end(full_text, anchor);
    if anchor_line_end >= full_text.len() {
      break;
    }
    let limit =
      advance_utf16_boundary(full_text, anchor, MAX_WITNESS_SCAN_UNITS);
    if let Some(scan_from) = find_witness_sentence_end(full_text, anchor, limit)
    {
      try_emit_forward_lines(
        results,
        full_text,
        data,
        scan_from,
        6,
        0.85,
        CandidateContext::SignatureBlock,
      );
    }
    cursor = anchor.saturating_add(phrase_len);
  }
}

fn try_emit_forward_lines(
  results: &mut Vec<PipelineEntity>,
  full_text: &str,
  data: &PreparedSignatureData,
  from_pos: usize,
  max_lines: usize,
  score: f64,
  context: CandidateContext,
) -> bool {
  let mut pos = from_pos;
  for _ in 0..max_lines {
    if pos >= full_text.len() {
      return false;
    }
    let line_end = find_line_end(full_text, pos);
    let line = full_text.get(pos..line_end).unwrap_or_default().trim();
    if !line.is_empty()
      && !is_image_stub(line, data)
      && try_emit(results, full_text, data, pos, line_end, score, context)
    {
      return true;
    }
    pos = line_end.saturating_add(1);
  }
  false
}

fn try_emit(
  results: &mut Vec<PipelineEntity>,
  full_text: &str,
  data: &PreparedSignatureData,
  start: usize,
  end: usize,
  score: f64,
  context: CandidateContext,
) -> bool {
  let raw = full_text.get(start..end).unwrap_or_default();
  if contains_org_suffix(raw, data) {
    return false;
  }
  let candidate = normalise_candidate(raw, data);
  if context == CandidateContext::LabelledField
    && ends_with_configured_label(&candidate, data)
  {
    return false;
  }
  if !is_name_shape(&candidate, data) {
    return false;
  }
  let Some(offset) = raw.find(&candidate) else {
    return false;
  };
  let abs_start = start.saturating_add(offset);
  let abs_end = abs_start.saturating_add(candidate.len());
  let Ok(start_u32) = u32::try_from(abs_start) else {
    return false;
  };
  let Ok(end_u32) = u32::try_from(abs_end) else {
    return false;
  };
  results.push(PipelineEntity::detected(
    start_u32,
    end_u32,
    PERSON_LABEL,
    candidate,
    score,
    DetectionSource::Trigger,
  ));
  true
}

fn ends_with_configured_label(
  candidate: &str,
  data: &PreparedSignatureData,
) -> bool {
  let Some(last) = candidate.split_whitespace().next_back() else {
    return false;
  };
  data
    .labels
    .iter()
    .any(|label| last.eq_ignore_ascii_case(label))
}

fn normalise_candidate(text: &str, data: &PreparedSignatureData) -> String {
  let stripped = strip_post_nominal_suffix(text.trim(), data);
  let first_cell_end = first_column_end(stripped).unwrap_or(stripped.len());
  stripped
    .get(..first_cell_end)
    .unwrap_or(stripped)
    .trim()
    .to_owned()
}

fn strip_post_nominal_suffix<'a>(
  text: &'a str,
  data: &PreparedSignatureData,
) -> &'a str {
  let Some(comma) = text.rfind(',') else {
    return text;
  };
  let suffix = text
    .get(comma.saturating_add(1)..)
    .unwrap_or_default()
    .trim()
    .trim_end_matches('.');
  let compact = suffix
    .chars()
    .filter(|ch| *ch != '.')
    .collect::<String>()
    .to_lowercase();
  if data
    .post_nominal_suffixes
    .iter()
    .any(|configured_suffix| configured_suffix == &compact)
  {
    return text.get(..comma).unwrap_or(text).trim();
  }
  text
}

fn is_name_shape(text: &str, data: &PreparedSignatureData) -> bool {
  let text_len = text.chars().map(char::len_utf16).sum::<usize>();
  if !(3..=MAX_NAME_LEN).contains(&text_len) {
    return false;
  }
  let tokens = text.split([' ', '\t']).filter(|token| !token.is_empty());
  let tokens = tokens.collect::<Vec<_>>();
  if !(2..=5).contains(&tokens.len()) {
    return false;
  }
  let Some(first) = tokens.first() else {
    return false;
  };
  if !is_cap_token(first) {
    return false;
  }
  tokens
    .iter()
    .skip(1)
    .all(|token| is_name_particle(token, data) || is_cap_token(token))
}

fn is_cap_token(token: &str) -> bool {
  let mut chars = token.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  if !first.is_uppercase() {
    return false;
  }
  let mut tail_len = 0usize;
  for ch in chars {
    if tail_len >= 30 {
      return false;
    }
    if !matches!(ch, '\u{0300}'..='\u{036f}' | '.' | '\'' | '-' | '’')
      && !ch.is_alphabetic()
    {
      return false;
    }
    tail_len = tail_len.saturating_add(1);
  }
  true
}

fn is_name_particle(token: &str, data: &PreparedSignatureData) -> bool {
  data
    .name_particles
    .iter()
    .any(|particle| token.eq_ignore_ascii_case(particle))
}

fn contains_org_suffix(text: &str, data: &PreparedSignatureData) -> bool {
  let lower = text.to_lowercase();
  data
    .organization_suffixes
    .iter()
    .any(|suffix| contains_bounded(&lower, suffix))
}

fn contains_bounded(text: &str, needle: &str) -> bool {
  let mut cursor = 0usize;
  while let Some(relative) =
    text.get(cursor..).and_then(|tail| tail.find(needle))
  {
    let start = cursor.saturating_add(relative);
    let end = start.saturating_add(needle.len());
    if boundary_before(text, start) && boundary_after(text, end) {
      return true;
    }
    cursor = start.saturating_add(1);
  }
  false
}

fn boundary_before(text: &str, byte: usize) -> bool {
  char_before(text, byte).is_none_or(|ch| !ch.is_alphanumeric())
}

fn boundary_after(text: &str, byte: usize) -> bool {
  char_after(text, byte).is_none_or(|ch| !ch.is_alphanumeric())
}

fn first_column_end(text: &str) -> Option<usize> {
  let mut run_start = None::<usize>;
  let mut run_len = 0usize;
  for (index, ch) in text.char_indices() {
    if ch == '\t' {
      return Some(index);
    }
    if ch.is_whitespace() {
      if run_start.is_none() {
        run_start = Some(index);
      }
      run_len = run_len.saturating_add(1);
      if run_len >= 3 {
        return run_start;
      }
      continue;
    }
    run_start = None;
    run_len = 0;
  }
  None
}

/// End of the signed name after `/s/`: stop at a column break or at another
/// `/s/` on the same line (EDGAR often packs two signatures on one row).
fn slash_s_cell_end(text: &str) -> usize {
  let next_slash = next_slash_s_offset(text);
  let column = first_column_end(text);
  match (next_slash, column) {
    (Some(slash), Some(col)) => slash.min(col),
    (Some(slash), None) => slash,
    (None, Some(col)) => col,
    (None, None) => text.len(),
  }
}

fn next_slash_s_offset(text: &str) -> Option<usize> {
  let mut cursor = 0usize;
  while let Some(relative) =
    text.get(cursor..).and_then(|tail| tail.find("/s/"))
  {
    let at = cursor.saturating_add(relative);
    if boundary_before(text, at) {
      return Some(at);
    }
    cursor = at.saturating_add(1);
  }
  None
}

#[derive(Clone, Copy)]
struct LabelMatch {
  value_start: usize,
  next_cursor: usize,
}

fn find_label(
  line: &str,
  from: usize,
  data: &PreparedSignatureData,
) -> Option<LabelMatch> {
  let mut cursor = from;
  while cursor < line.len() {
    if !line.is_char_boundary(cursor) {
      cursor = cursor.saturating_add(1);
      continue;
    }
    if let Some(after_label) = label_end_at(line, cursor, data) {
      let mut after_spaces = skip_horizontal_ws(line, after_label);
      if line.get(after_spaces..)?.starts_with(':') {
        after_spaces = skip_horizontal_ws(line, after_spaces.saturating_add(1));
        return Some(LabelMatch {
          value_start: after_spaces,
          next_cursor: after_spaces.saturating_add(1),
        });
      }
    }
    cursor = cursor.saturating_add(1);
  }
  None
}

fn label_end_at(
  line: &str,
  start: usize,
  data: &PreparedSignatureData,
) -> Option<usize> {
  if !boundary_before(line, start) {
    return None;
  }
  let tail = line.get(start..)?;
  for label in &data.labels {
    if starts_with_ascii_ci(tail, label) {
      let end = start.saturating_add(label.len());
      if label_tail_is_valid(line, end) {
        return Some(end);
      }
    }
  }
  None
}

fn label_tail_is_valid(line: &str, end: usize) -> bool {
  line
    .get(end..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(|ch| ch == ':' || ch == ' ' || ch == '\t')
}

fn slash_s_prefix_end(line: &str, start: usize) -> Option<usize> {
  let tail = line.get(start..)?;
  if !tail.starts_with("/s/") {
    return None;
  }
  let after = start.saturating_add("/s/".len());
  let has_space = line
    .get(after..)
    .and_then(|value| value.chars().next())
    .is_some_and(|ch| ch == ' ' || ch == '\t');
  has_space.then(|| skip_horizontal_ws(line, after))
}

fn skip_horizontal_ws(text: &str, from: usize) -> usize {
  let mut cursor = from;
  while let Some(ch) = text.get(cursor..).and_then(|tail| tail.chars().next()) {
    if ch != ' ' && ch != '\t' {
      break;
    }
    cursor = cursor.saturating_add(ch.len_utf8());
  }
  cursor
}

fn find_line_end(text: &str, pos: usize) -> usize {
  text
    .get(pos..)
    .and_then(|tail| tail.find('\n'))
    .map_or(text.len(), |relative| pos.saturating_add(relative))
}

fn find_prev_line(
  full_text: &str,
  data: &PreparedSignatureData,
  pos: usize,
) -> Option<(usize, usize)> {
  if pos == 0 {
    return None;
  }
  let bytes = full_text.as_bytes();
  let mut cursor = pos.saturating_sub(1);
  while cursor > 0 && bytes.get(cursor).copied() != Some(b'\n') {
    cursor = cursor.saturating_sub(1);
  }
  if bytes.get(cursor).copied() != Some(b'\n') {
    return None;
  }

  while cursor > 0 {
    let line_end = cursor;
    let mut line_start = line_end;
    while line_start > 0
      && bytes.get(line_start.saturating_sub(1)).copied() != Some(b'\n')
    {
      line_start = line_start.saturating_sub(1);
    }
    let line = full_text
      .get(line_start..line_end)
      .unwrap_or_default()
      .trim();
    if !line.is_empty() && !is_image_stub(line, data) {
      return Some((line_start, line_end));
    }
    if line_start == 0 {
      break;
    }
    cursor = line_start.saturating_sub(1);
  }
  None
}

fn find_witness_sentence_end(
  full_text: &str,
  from: usize,
  limit: usize,
) -> Option<usize> {
  let mut line_start = from;
  while line_start < limit {
    let line_end = find_line_end(full_text, line_start).min(limit);
    let line = full_text
      .get(line_start..line_end)
      .unwrap_or_default()
      .trim_end();
    if line.ends_with('.') || line.ends_with(':') || line.ends_with(';') {
      return Some(line_end.saturating_add(1));
    }
    let next_start = line_end.saturating_add(1);
    if next_start >= limit {
      return None;
    }
    let next_end = find_line_end(full_text, next_start).min(limit);
    let next_line_empty = full_text
      .get(next_start..next_end)
      .unwrap_or_default()
      .trim()
      .is_empty();
    if next_line_empty {
      return Some(next_end.saturating_add(1));
    }
    line_start = next_start;
  }
  None
}

fn find_next_witness_phrase(
  full_text: &str,
  from: usize,
  data: &PreparedSignatureData,
) -> Option<(usize, usize)> {
  let tail = full_text.get(from..).unwrap_or_default();
  data
    .witness_phrases
    .iter()
    .filter_map(|phrase| {
      find_ascii_case_insensitive(tail, phrase)
        .map(|relative| (from.saturating_add(relative), phrase.len()))
    })
    .min_by_key(|(anchor, _)| *anchor)
}

fn advance_utf16_boundary(text: &str, start: usize, max_units: usize) -> usize {
  let Some(tail) = text.get(start..) else {
    return start;
  };
  let mut units = 0usize;
  for (relative, ch) in tail.char_indices() {
    let width = ch.len_utf16();
    if units.saturating_add(width) > max_units {
      return start.saturating_add(relative);
    }
    units = units.saturating_add(width);
  }
  text.len()
}

fn find_ascii_case_insensitive(text: &str, needle: &str) -> Option<usize> {
  let needle_len = needle.len();
  if needle_len == 0 || text.len() < needle_len {
    return None;
  }
  let mut cursor = 0usize;
  while cursor.saturating_add(needle_len) <= text.len() {
    if text.is_char_boundary(cursor)
      && starts_with_ascii_ci(text.get(cursor..)?, needle)
    {
      return Some(cursor);
    }
    cursor = cursor.saturating_add(1);
  }
  None
}

fn starts_with_ascii_ci(text: &str, prefix: &str) -> bool {
  let Some(candidate) = text.get(..prefix.len()) else {
    return false;
  };
  candidate.eq_ignore_ascii_case(prefix)
}

fn has_word_boundaries(text: &str, start: usize, len: usize) -> bool {
  boundary_before(text, start)
    && boundary_after(text, start.saturating_add(len))
}

fn char_before(text: &str, byte: usize) -> Option<char> {
  text.get(..byte)?.chars().next_back()
}

fn char_after(text: &str, byte: usize) -> Option<char> {
  text.get(byte..)?.chars().next()
}

fn is_image_stub(line: &str, data: &PreparedSignatureData) -> bool {
  let lower = line.trim_start().to_lowercase();
  data
    .image_stub_prefixes
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn non_empty_lowercase(values: Vec<String>) -> Vec<String> {
  values
    .into_iter()
    .map(|value| value.trim().to_lowercase())
    .filter(|value| !value.is_empty())
    .collect()
}

fn non_empty_compact_lowercase(values: Vec<String>) -> Vec<String> {
  values
    .into_iter()
    .map(|value| {
      value
        .trim()
        .trim_end_matches('.')
        .chars()
        .filter(|ch| *ch != '.')
        .collect::<String>()
        .to_lowercase()
    })
    .filter(|value| !value.is_empty())
    .collect()
}

#[cfg(test)]
mod tests {
  use super::{PreparedSignatureData, SignatureData, detect_signatures};

  fn detect(text: &str) -> Vec<crate::resolution::PipelineEntity> {
    detect_signatures(text, &test_data())
  }

  fn test_data() -> PreparedSignatureData {
    PreparedSignatureData::new(SignatureData {
      labels: vec![String::from("name")],
      witness_phrases: vec![String::from("in witness whereof")],
      form_field_labels: Vec::new(),
      signature_stamp_phrases: Vec::new(),
      name_particles: Vec::new(),
      post_nominal_suffixes: Vec::new(),
      organization_suffixes: vec![String::from("inc.")],
      image_stub_prefixes: Vec::new(),
    })
  }

  #[test]
  fn detects_two_slash_signatures_on_same_line() {
    let entities = detect("/s/ Paul A. Pinkston /s/ Clark R. Moore");

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Paul A. Pinkston", "Clark R. Moore"]
    );
  }

  #[test]
  fn detects_slash_signature_same_line() {
    let entities = detect("/s/ Jane Doe   Chief Executive Officer");

    assert_eq!(entities.len(), 1);
    assert_eq!(
      entities.first().map(|entity| entity.text.as_str()),
      Some("Jane Doe")
    );
  }

  #[test]
  fn counts_signature_name_length_in_text_units() {
    let name = "Élodie ŽluťoučkýKůň ÚpělĎábelskéÓdy ÁÉÍÓÚÝČĎĚŇŘŠŤŽ";
    assert!(name.len() > super::MAX_NAME_LEN);
    assert!(
      name.chars().map(char::len_utf16).sum::<usize>() <= super::MAX_NAME_LEN
    );

    let entities = detect(&format!("/s/ {name}"));

    assert_eq!(entities.len(), 1);
    assert_eq!(
      entities.first().map(|entity| entity.text.as_str()),
      Some(name)
    );
  }

  #[test]
  fn rejects_overlong_capitalized_signature_tokens() {
    let entities = detect("/s/ Supercalifragilisticexpialidociousxxxx Smith");

    assert!(entities.is_empty());
  }

  #[test]
  fn measures_witness_scan_window_in_text_units() {
    let preamble = "é".repeat(350);
    let entities = detect(&format!("IN WITNESS WHEREOF {preamble}.\nJane Doe"));

    assert_eq!(entities.len(), 1);
    assert_eq!(
      entities.first().map(|entity| entity.text.as_str()),
      Some("Jane Doe")
    );
  }

  #[test]
  fn detects_multiple_labelled_name_columns() {
    let entities =
      detect("Name: Priya Ramanathan   Name: Jonathan H. Whitaker");

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Priya Ramanathan", "Jonathan H. Whitaker"]
    );
  }

  #[test]
  fn labelled_fields_reject_values_ending_in_another_field_label() {
    assert!(detect("Name: General Name").is_empty());
    assert_eq!(
      detect("/s/ General Name")
        .first()
        .map(|entity| entity.text.as_str()),
      Some("General Name")
    );
  }

  #[test]
  fn skips_organization_caption_before_signature_mark() {
    let entities = detect("TWITTER, INC.\n/s/ Jane Doe");

    assert_eq!(entities.len(), 1);
    assert_eq!(
      entities.first().map(|entity| entity.text.as_str()),
      Some("Jane Doe")
    );
  }
}
