use std::collections::BTreeSet;
use std::fmt::Write as _;

use crate::resolution::{DetectionSource, PipelineEntity};

use crate::labels::PERSON_LABEL;
use crate::name_corpus::PreparedNameCorpusData;
use crate::types::{Error, Result};
const MAX_NAME_LEN: usize = 60;
const MAX_WITNESS_SCAN_UNITS: usize = 600;
const MAX_PARTY_ROLE_NAME_EVIDENCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PARTY_ROLE_NAME_EVIDENCE_TOKENS: usize = 500_000;
const SIGNATURE_ONLY_PERSON_LABELS: &[&str] = &["by"];

#[derive(Clone, Copy)]
struct PartyRoleEvidence<'a> {
  first_names: Option<&'a BTreeSet<String>>,
  name_corpus: Option<&'a PreparedNameCorpusData>,
  party_role_name_tokens: &'a [String],
  title_tokens: &'a BTreeSet<String>,
}

impl PartyRoleEvidence<'_> {
  fn has_person_name_token(self, candidate: &str) -> bool {
    let candidate = without_leading_title_tokens(candidate, self.title_tokens);
    if let Some(corpus) = self.name_corpus {
      return corpus.has_leading_person_name_token(candidate)
        || (!corpus.is_organization(candidate)
          && starts_with_sorted_name_token(
            candidate,
            self.party_role_name_tokens,
          ));
    }
    self.first_names.is_some_and(|first_names| {
      starts_with_first_name_token(candidate, first_names)
    }) || starts_with_sorted_name_token(candidate, self.party_role_name_tokens)
  }
}

#[derive(Clone, Copy)]
enum CandidateContext<'a> {
  SignatureBlock,
  PersonValueField,
  LabelledField,
  PartyRoleField(PartyRoleEvidence<'a>),
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct SignatureData {
  #[serde(default)]
  pub labels: Vec<String>,
  /// Language-scoped labels whose values are known to be person names.
  #[serde(default)]
  pub person_value_labels: Vec<String>,
  /// Language-scoped labels that introduce people in legal notice blocks.
  #[serde(default)]
  pub person_list_labels: Vec<String>,
  /// Front-coded cross-locale given-name evidence used only for legal-party
  /// fields.
  pub party_role_name_evidence: String,
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
  /// Language-scoped contact fields that terminate a preceding person name.
  #[serde(default)]
  pub contact_field_labels: Vec<String>,
  /// Fixed strings PDF signing software stamps onto a page ("Digitally
  /// signed by", "Digitálně podepsal"). They sit immediately after a name
  /// and must terminate the person span rather than extend it.
  pub signature_stamp_phrases: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedSignatureData {
  labels: Vec<String>,
  person_value_labels: Vec<String>,
  signature_only_person_labels: Vec<String>,
  party_role_labels: Vec<String>,
  party_role_name_tokens: Vec<String>,
  person_list_labels: Vec<String>,
  witness_phrases: Vec<String>,
  form_field_labels: Vec<String>,
  contact_field_labels: Vec<String>,
  signature_stamp_phrases: Vec<String>,
  name_particles: Vec<String>,
  post_nominal_suffixes: Vec<String>,
  organization_suffixes: Vec<String>,
  image_stub_prefixes: Vec<String>,
}

impl PreparedSignatureData {
  pub(crate) fn new(
    data: SignatureData,
    party_role_labels: Vec<String>,
  ) -> Result<Self> {
    let mut contact_field_labels =
      non_empty_lowercase(data.contact_field_labels);
    contact_field_labels.sort_unstable();
    contact_field_labels.dedup();
    let mut form_field_labels = non_empty_lowercase(data.form_field_labels);
    form_field_labels.extend(contact_field_labels.iter().cloned());
    form_field_labels.sort_unstable();
    form_field_labels.dedup();
    let labels = non_empty_lowercase(data.labels);
    let signature_only_person_labels = labels
      .iter()
      .filter(|label| SIGNATURE_ONLY_PERSON_LABELS.contains(&label.as_str()))
      .cloned()
      .collect();
    let party_role_name_tokens = decode_party_role_name_evidence(
      &data.party_role_name_evidence,
    )
    .map_err(|reason| Error::InvalidStaticData {
      field: "signature_data.party_role_name_evidence",
      reason,
    })?;
    Ok(Self {
      labels,
      person_value_labels: non_empty_lowercase(data.person_value_labels),
      signature_only_person_labels,
      party_role_labels: non_empty_lowercase(party_role_labels),
      party_role_name_tokens,
      person_list_labels: non_empty_lowercase(data.person_list_labels),
      witness_phrases: non_empty_lowercase(data.witness_phrases),
      form_field_labels,
      contact_field_labels,
      signature_stamp_phrases: non_empty_lowercase(
        data.signature_stamp_phrases,
      ),
      name_particles: non_empty_lowercase(data.name_particles),
      post_nominal_suffixes: non_empty_compact_lowercase(
        data.post_nominal_suffixes,
      ),
      organization_suffixes: non_empty_lowercase(data.organization_suffixes),
      image_stub_prefixes: non_empty_lowercase(data.image_stub_prefixes),
    })
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

  /// Labels that positively introduce a person value (`Name: Jane Roe`).
  /// Unlike `form_field_labels`, these do not include address, date, tax, or
  /// signature fields.
  #[must_use]
  pub(crate) fn person_value_labels(&self) -> &[String] {
    &self.person_value_labels
  }
}

/// Front-codes sorted, lowercased tokens into one compact exact-membership
/// payload. The prepared package compresses this shared-prefix representation
/// further without duplicating the source dictionary as a string array.
#[doc(hidden)]
/// Error returned when compact party-role name evidence cannot be encoded.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum PartyRoleNameEvidenceEncodeError {
  /// The source dictionary exceeds the supported entry count.
  TokenLimit,
  /// The encoded evidence exceeds the supported payload size.
  ByteLimit,
  /// A token could not be represented by the front-coded format.
  Encoding,
}

impl std::fmt::Display for PartyRoleNameEvidenceEncodeError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::TokenLimit => {
        formatter.write_str("source evidence exceeds token limit")
      }
      Self::ByteLimit => {
        formatter.write_str("encoded evidence exceeds byte limit")
      }
      Self::Encoding => {
        formatter.write_str("party-role name evidence encoding failed")
      }
    }
  }
}

impl std::error::Error for PartyRoleNameEvidenceEncodeError {}

pub fn encode_party_role_name_evidence(
  source_tokens: impl IntoIterator<Item = String>,
) -> std::result::Result<String, PartyRoleNameEvidenceEncodeError> {
  let mut normalized = Vec::new();
  for token in source_tokens {
    if normalized.len() >= MAX_PARTY_ROLE_NAME_EVIDENCE_TOKENS {
      return Err(PartyRoleNameEvidenceEncodeError::TokenLimit);
    }
    let token = token.to_lowercase();
    if !token.is_empty() {
      normalized.push(token);
    }
  }
  let mut normalized_tokens = normalized;
  normalized_tokens.sort_unstable();
  normalized_tokens.dedup();
  let mut encoded = String::new();
  let mut previous = String::new();
  for token in normalized_tokens {
    let mut prefix_len = previous
      .bytes()
      .zip(token.bytes())
      .take_while(|(left, right)| left == right)
      .count();
    while !previous.is_char_boundary(prefix_len)
      || !token.is_char_boundary(prefix_len)
    {
      prefix_len = prefix_len.saturating_sub(1);
    }
    let suffix = token
      .get(prefix_len..)
      .ok_or(PartyRoleNameEvidenceEncodeError::Encoding)?;
    write!(encoded, "{prefix_len:x},{:x}:{suffix}", suffix.len())
      .map_err(|_| PartyRoleNameEvidenceEncodeError::Encoding)?;
    if encoded.len() > MAX_PARTY_ROLE_NAME_EVIDENCE_BYTES {
      return Err(PartyRoleNameEvidenceEncodeError::ByteLimit);
    }
    previous = token;
  }
  Ok(encoded)
}

fn starts_with_sorted_name_token(text: &str, names: &[String]) -> bool {
  let Some(first_token) = text.split_whitespace().next() else {
    return false;
  };
  names.binary_search(&first_token.to_lowercase()).is_ok()
    || crate::name_corpus::segmented_word_texts(first_token)
      .next()
      .is_some_and(|word| names.binary_search(&word.to_lowercase()).is_ok())
}

fn starts_with_first_name_token(text: &str, names: &BTreeSet<String>) -> bool {
  let Some(first_token) = text.split_whitespace().next() else {
    return false;
  };
  names.contains(&first_token.to_lowercase())
    || crate::name_corpus::segmented_word_texts(first_token)
      .next()
      .is_some_and(|word| names.contains(&word.to_lowercase()))
}

fn without_leading_title_tokens<'a>(
  mut text: &'a str,
  title_tokens: &BTreeSet<String>,
) -> &'a str {
  loop {
    let trimmed = text.trim_start();
    let Some(token) = trimmed.split_whitespace().next() else {
      return trimmed;
    };
    let bare = token
      .trim_matches(|ch: char| matches!(ch, '.' | ','))
      .to_lowercase();
    if !title_tokens.contains(&bare) {
      return trimmed;
    }
    text = &trimmed[token.len()..];
  }
}

pub(crate) fn decode_party_role_name_evidence(
  encoded: &str,
) -> std::result::Result<Vec<String>, String> {
  if encoded.len() > MAX_PARTY_ROLE_NAME_EVIDENCE_BYTES {
    return Err(String::from("encoded evidence exceeds byte limit"));
  }
  let mut cursor = 0usize;
  let mut previous = String::new();
  let mut tokens = Vec::new();
  while cursor < encoded.len() {
    if tokens.len() >= MAX_PARTY_ROLE_NAME_EVIDENCE_TOKENS {
      return Err(String::from("encoded evidence exceeds token limit"));
    }
    let comma = encoded
      .get(cursor..)
      .and_then(|tail| tail.find(','))
      .map(|offset| cursor.saturating_add(offset))
      .ok_or_else(|| String::from("missing prefix separator"))?;
    let colon = encoded
      .get(comma.saturating_add(1)..)
      .and_then(|tail| tail.find(':'))
      .map(|offset| comma.saturating_add(1).saturating_add(offset))
      .ok_or_else(|| String::from("missing suffix separator"))?;
    let prefix_len = usize::from_str_radix(
      encoded
        .get(cursor..comma)
        .ok_or_else(|| String::from("invalid prefix header bounds"))?,
      16,
    )
    .map_err(|_| String::from("invalid prefix length"))?;
    let suffix_len = usize::from_str_radix(
      encoded
        .get(comma.saturating_add(1)..colon)
        .ok_or_else(|| String::from("invalid suffix header bounds"))?,
      16,
    )
    .map_err(|_| String::from("invalid suffix length"))?;
    let suffix_start = colon.saturating_add(1);
    let suffix_end = suffix_start
      .checked_add(suffix_len)
      .ok_or_else(|| String::from("suffix length overflow"))?;
    if prefix_len > previous.len()
      || !previous.is_char_boundary(prefix_len)
      || suffix_end > encoded.len()
      || !encoded.is_char_boundary(suffix_end)
    {
      return Err(String::from("invalid front-coded token bounds"));
    }
    let mut token = previous
      .get(..prefix_len)
      .ok_or_else(|| String::from("invalid decoded token prefix boundary"))?
      .to_owned();
    token.push_str(
      encoded
        .get(suffix_start..suffix_end)
        .ok_or_else(|| String::from("invalid token utf-8 boundary"))?,
    );
    if token.is_empty() || tokens.last().is_some_and(|prior| prior >= &token) {
      return Err(String::from("tokens are not strictly sorted"));
    }
    previous.clone_from(&token);
    tokens.push(token);
    cursor = suffix_end;
  }
  Ok(tokens)
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
pub(crate) struct DetectSignaturesArgs<'a> {
  pub full_text: &'a str,
  pub data: &'a PreparedSignatureData,
  pub first_names: Option<&'a BTreeSet<String>>,
  pub name_corpus: Option<&'a PreparedNameCorpusData>,
  pub title_tokens: &'a BTreeSet<String>,
}

#[must_use]
pub(crate) fn detect_signatures(
  args: &DetectSignaturesArgs<'_>,
) -> Vec<PipelineEntity> {
  let full_text = args.full_text;
  let data = args.data;
  let first_names = args.first_names;
  let name_corpus = args.name_corpus;
  let title_tokens = args.title_tokens;
  let mut results = Vec::new();
  detect_slash_s(full_text, data, &mut results);
  detect_labelled_names(DetectLabelledNamesArgs {
    full_text,
    data,
    first_names,
    name_corpus,
    title_tokens,
    results: &mut results,
  });
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

struct DetectLabelledNamesArgs<'a> {
  full_text: &'a str,
  data: &'a PreparedSignatureData,
  first_names: Option<&'a BTreeSet<String>>,
  name_corpus: Option<&'a PreparedNameCorpusData>,
  title_tokens: &'a BTreeSet<String>,
  results: &'a mut Vec<PipelineEntity>,
}

fn detect_labelled_names(args: DetectLabelledNamesArgs<'_>) {
  let DetectLabelledNamesArgs {
    full_text,
    data,
    first_names,
    name_corpus,
    title_tokens,
    results,
  } = args;
  let mut line_start = 0usize;
  while line_start <= full_text.len() {
    let line_end = find_line_end(full_text, line_start);
    if let Some(line) = full_text.get(line_start..line_end) {
      detect_labelled_names_in_line(DetectLabelledNamesInLineArgs {
        full_text,
        data,
        first_names,
        name_corpus,
        title_tokens,
        line,
        line_start,
        results,
      });
    }
    if line_end >= full_text.len() {
      break;
    }
    line_start = line_end.saturating_add(1);
  }
}

struct DetectLabelledNamesInLineArgs<'a> {
  full_text: &'a str,
  data: &'a PreparedSignatureData,
  first_names: Option<&'a BTreeSet<String>>,
  name_corpus: Option<&'a PreparedNameCorpusData>,
  title_tokens: &'a BTreeSet<String>,
  line: &'a str,
  line_start: usize,
  results: &'a mut Vec<PipelineEntity>,
}

fn detect_labelled_names_in_line(args: DetectLabelledNamesInLineArgs<'_>) {
  let DetectLabelledNamesInLineArgs {
    full_text,
    data,
    first_names,
    name_corpus,
    title_tokens,
    line,
    line_start,
    results,
  } = args;
  let mut cursor = 0usize;
  let mut field_label_starts = None::<FieldLabelStarts>;
  let mut following_contact_fields = [None::<bool>; 2];
  while let Some(label) = find_label(line, cursor, data) {
    let value_start =
      slash_s_prefix_end(line, label.value_start).unwrap_or(label.value_start);
    let remaining = line.get(value_start..).unwrap_or_default();
    let column_end = first_column_end(remaining).unwrap_or(remaining.len());
    let starts = field_label_starts.get_or_insert_with(|| {
      collect_field_label_starts(
        line,
        &data.form_field_labels,
        &data.contact_field_labels,
      )
    });
    let next_field_start = starts
      .all
      .get(starts.all.partition_point(|start| *start < value_start))
      .copied();
    let next_contact_start = starts
      .contact
      .get(starts.contact.partition_point(|start| *start < value_start))
      .copied();
    let field_end = next_field_start
      .unwrap_or(line.len())
      .saturating_sub(value_start);
    let value_end = value_start.saturating_add(column_end.min(field_end));
    let global_start = line_start.saturating_add(value_start);
    let global_end = line_start.saturating_add(value_end);
    let value_is_empty = line
      .get(value_start..value_end)
      .unwrap_or_default()
      .trim()
      .is_empty();
    let has_same_line_structure = line
      .get(value_start..value_end)
      .is_some_and(|value| value.contains(';'))
      || (next_contact_start.is_some()
        && next_contact_start == next_field_start);
    let following_line_index = usize::from(value_is_empty);
    let requires_list_structure = label.kind.requires_list_structure();
    let has_following_contact_field = requires_list_structure
      && following_contact_fields
        .get_mut(following_line_index)
        .is_some_and(|cached| {
          *cached.get_or_insert_with(|| {
            following_non_empty_line_starts_with_field(
              full_text,
              line_start.saturating_add(line.len()),
              following_line_index,
              &data.contact_field_labels,
            )
          })
        });
    if requires_list_structure
      && !has_same_line_structure
      && !has_following_contact_field
    {
      cursor = value_end.max(label.next_cursor);
      continue;
    }
    let context = label.kind.candidate_context(PartyRoleEvidence {
      first_names,
      name_corpus,
      party_role_name_tokens: &data.party_role_name_tokens,
      title_tokens,
    });
    if value_is_empty {
      try_emit_forward_lines(
        results,
        full_text,
        data,
        global_end.saturating_add(1),
        3,
        0.9,
        context,
      );
    } else {
      try_emit_semicolon_list(
        results,
        full_text,
        data,
        global_start,
        global_end,
        0.95,
        context,
      );
    }
    cursor = value_end.max(label.next_cursor);
  }
}

fn try_emit_semicolon_list(
  results: &mut Vec<PipelineEntity>,
  full_text: &str,
  data: &PreparedSignatureData,
  start: usize,
  end: usize,
  score: f64,
  context: CandidateContext<'_>,
) {
  let value = full_text.get(start..end).unwrap_or_default();
  let mut segment_start = 0usize;
  for (relative, ch) in value.char_indices() {
    if ch != ';' {
      continue;
    }
    try_emit(
      results,
      full_text,
      data,
      start.saturating_add(segment_start),
      start.saturating_add(relative),
      score,
      context,
    );
    segment_start = relative.saturating_add(ch.len_utf8());
  }
  try_emit(
    results,
    full_text,
    data,
    start.saturating_add(segment_start),
    end,
    score,
    context,
  );
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
  context: CandidateContext<'_>,
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
  context: CandidateContext<'_>,
) -> bool {
  let raw = full_text.get(start..end).unwrap_or_default();
  if contains_org_suffix(raw, data) {
    return false;
  }
  let candidate = normalise_candidate(raw, data);
  if matches!(
    context,
    CandidateContext::PersonValueField
      | CandidateContext::LabelledField
      | CandidateContext::PartyRoleField(_)
  ) && ends_with_configured_label(&candidate, data)
  {
    return false;
  }
  if let CandidateContext::PartyRoleField(evidence) = context
    && !evidence.has_person_name_token(&candidate)
  {
    return false;
  }
  if !(is_name_shape(&candidate, data)
    || matches!(context, CandidateContext::PersonValueField)
      && (is_person_value_name_token(&candidate)
        || is_particle_led_name_shape(&candidate, data)))
  {
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

fn is_person_value_name_token(text: &str) -> bool {
  let text_len = text.chars().map(char::len_utf16).sum::<usize>();
  (2..=MAX_NAME_LEN).contains(&text_len)
    && !text.chars().any(char::is_whitespace)
    && is_cap_token(text)
}

fn is_particle_led_name_shape(
  text: &str,
  data: &PreparedSignatureData,
) -> bool {
  let text_len = text.chars().map(char::len_utf16).sum::<usize>();
  if !(3..=MAX_NAME_LEN).contains(&text_len) {
    return false;
  }
  let mut tokens = text.split([' ', '\t']).filter(|token| !token.is_empty());
  let Some(first) = tokens.next() else {
    return false;
  };
  let remaining = tokens.collect::<Vec<_>>();
  is_name_particle(first, data)
    && remaining.iter().any(|token| is_cap_token(token))
    && remaining
      .iter()
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
  kind: LabelKind,
}

#[derive(Clone, Copy)]
enum LabelKind {
  PersonValue,
  SignatureOnly,
  PartyRole,
  PersonList,
}

impl LabelKind {
  const fn requires_list_structure(self) -> bool {
    matches!(self, Self::PersonList)
  }

  const fn candidate_context(
    self,
    evidence: PartyRoleEvidence<'_>,
  ) -> CandidateContext<'_> {
    match self {
      Self::PersonValue => CandidateContext::PersonValueField,
      Self::PartyRole => CandidateContext::PartyRoleField(evidence),
      Self::SignatureOnly | Self::PersonList => CandidateContext::LabelledField,
    }
  }
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
    if let Some((after_label, kind)) = label_end_at(line, cursor, data) {
      let mut after_spaces = skip_horizontal_ws(line, after_label);
      if let Some(separator_len) =
        line.get(after_spaces..).and_then(field_label_separator_len)
      {
        after_spaces =
          skip_horizontal_ws(line, after_spaces.saturating_add(separator_len));
        return Some(LabelMatch {
          value_start: after_spaces,
          next_cursor: after_spaces.saturating_add(1),
          kind,
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
) -> Option<(usize, LabelKind)> {
  if !boundary_before(line, start) {
    return None;
  }
  let tail = line.get(start..)?;
  for (label, kind) in data
    .person_value_labels
    .iter()
    .map(|label| (label, LabelKind::PersonValue))
    .chain(
      data
        .signature_only_person_labels
        .iter()
        .map(|label| (label, LabelKind::SignatureOnly)),
    )
    .chain(
      data
        .party_role_labels
        .iter()
        .map(|label| (label, LabelKind::PartyRole)),
    )
    .chain(
      data
        .person_list_labels
        .iter()
        .map(|label| (label, LabelKind::PersonList)),
    )
  {
    if let Some(relative_end) = unicode_case_insensitive_prefix_end(tail, label)
    {
      let end = start.saturating_add(relative_end);
      if label_tail_is_valid(line, end) {
        return Some((end, kind));
      }
    }
  }
  None
}

#[derive(Default)]
struct FieldLabelStarts {
  all: Vec<usize>,
  contact: Vec<usize>,
}

fn collect_field_label_starts(
  line: &str,
  labels: &[String],
  contact_labels: &[String],
) -> FieldLabelStarts {
  let mut starts = FieldLabelStarts::default();
  let mut cursor = 0usize;
  while cursor < line.len() {
    if !line.is_char_boundary(cursor) {
      cursor = cursor.saturating_add(1);
      continue;
    }
    if boundary_before(line, cursor) {
      let Some(tail) = line.get(cursor..) else {
        break;
      };
      for label in labels {
        let Some(relative_end) =
          unicode_case_insensitive_prefix_end(tail, label)
        else {
          continue;
        };
        let after_label = cursor.saturating_add(relative_end);
        let after_spaces = skip_horizontal_ws(line, after_label);
        if line
          .get(after_spaces..)
          .and_then(field_label_separator_len)
          .is_some()
        {
          starts.all.push(cursor);
          if contact_labels.binary_search(label).is_ok() {
            starts.contact.push(cursor);
          }
          break;
        }
      }
    }
    cursor = cursor.saturating_add(1);
  }
  starts
}

fn following_non_empty_line_starts_with_field(
  text: &str,
  current_line_end: usize,
  skip_non_empty_lines: usize,
  labels: &[String],
) -> bool {
  let mut line_start = current_line_end;
  let mut skipped = 0_usize;
  while line_start < text.len() {
    if text
      .get(line_start..)
      .is_some_and(|tail| tail.starts_with('\n'))
    {
      line_start = line_start.saturating_add(1);
    }
    let line_end = find_line_end(text, line_start);
    let line = text.get(line_start..line_end).unwrap_or_default().trim();
    if !line.is_empty() {
      if skipped < skip_non_empty_lines {
        skipped = skipped.saturating_add(1);
        line_start = line_end;
        continue;
      }
      return line_starts_with_field(line, labels);
    }
    if line_end >= text.len() {
      return false;
    }
    line_start = line_end;
  }
  false
}

fn line_starts_with_field(line: &str, labels: &[String]) -> bool {
  labels.iter().any(|label| {
    let Some(after_label) = unicode_case_insensitive_prefix_end(line, label)
    else {
      return false;
    };
    let after_label = skip_horizontal_ws(line, after_label);
    line
      .get(after_label..)
      .and_then(field_label_separator_len)
      .is_some()
  })
}

fn unicode_case_insensitive_prefix_end(
  text: &str,
  prefix: &str,
) -> Option<usize> {
  let mut expected = prefix.chars().flat_map(char::to_lowercase).peekable();
  if expected.peek().is_none() {
    return Some(0);
  }
  for (start, character) in text.char_indices() {
    for folded in character.to_lowercase() {
      if expected.next() != Some(folded) {
        return None;
      }
    }
    if expected.peek().is_none() {
      return Some(start.saturating_add(character.len_utf8()));
    }
  }
  None
}

fn label_tail_is_valid(line: &str, end: usize) -> bool {
  line
    .get(end..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(|ch| is_field_label_separator(ch) || ch == ' ' || ch == '\t')
}

fn field_label_separator_len(text: &str) -> Option<usize> {
  text
    .chars()
    .next()
    .filter(|ch| is_field_label_separator(*ch))
    .map(char::len_utf8)
}

const fn is_field_label_separator(ch: char) -> bool {
  matches!(ch, ':' | '：')
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
  use std::collections::BTreeSet;

  use proptest::prelude::*;

  use crate::name_corpus::{NameCorpusData, PreparedNameCorpusData};

  use super::{
    DetectSignaturesArgs, PreparedSignatureData, SignatureData,
    detect_signatures,
  };

  #[allow(
    clippy::panic,
    reason = "this test helper must fail immediately when a fixture violates the constructor contract"
  )]
  fn prepared_signature_data(
    data: SignatureData,
    party_role_labels: Vec<String>,
  ) -> PreparedSignatureData {
    let Ok(prepared) = PreparedSignatureData::new(data, party_role_labels)
    else {
      panic!("test signature data must be valid");
    };
    prepared
  }

  #[allow(
    clippy::panic,
    reason = "this test helper must fail immediately when fixed evidence exceeds encoder bounds"
  )]
  fn encoded_name_evidence(source: impl IntoIterator<Item = String>) -> String {
    let Ok(encoded) = super::encode_party_role_name_evidence(source) else {
      panic!("test party-role evidence must be encodable");
    };
    encoded
  }

  fn detect(text: &str) -> Vec<crate::resolution::PipelineEntity> {
    detect_signatures(&DetectSignaturesArgs {
      full_text: text,
      data: &test_data(),
      first_names: None,
      name_corpus: None,
      title_tokens: &BTreeSet::new(),
    })
  }

  fn test_data() -> PreparedSignatureData {
    prepared_signature_data(
      SignatureData {
        labels: vec![String::from("name")],
        person_value_labels: vec![String::from("name")],
        person_list_labels: vec![
          String::from("attention"),
          String::from("do rąk własnych"),
        ],
        party_role_name_evidence: String::new(),
        witness_phrases: vec![String::from("in witness whereof")],
        form_field_labels: Vec::new(),
        contact_field_labels: vec![
          String::from("email"),
          String::from("tel"),
          String::from("téléphone"),
        ],
        signature_stamp_phrases: Vec::new(),
        name_particles: Vec::new(),
        post_nominal_suffixes: Vec::new(),
        organization_suffixes: vec![String::from("inc.")],
        image_stub_prefixes: Vec::new(),
      },
      Vec::new(),
    )
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
  fn party_role_fields_use_their_scoped_role_vocabulary() {
    let data = prepared_signature_data(
      SignatureData {
        person_value_labels: vec![String::from("name")],
        ..SignatureData::default()
      },
      vec![String::from("seller"), String::from("borrower")],
    );
    let names = PreparedNameCorpusData::new(NameCorpusData {
      first_names: vec![String::from("Imani"), String::from("Zofia")],
      surnames: vec![String::from("Nwosu"), String::from("Wrona")],
      ..NameCorpusData::default()
    });

    assert_eq!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Imani Nwosu",
        data: &data,
        first_names: None,
        name_corpus: Some(&names),
        title_tokens: &BTreeSet::new(),
      })
      .into_iter()
      .map(|entity| entity.text)
      .collect::<Vec<_>>(),
      ["Imani Nwosu"]
    );
    assert_eq!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Borrower:\nZofia Wrona",
        data: &data,
        first_names: None,
        name_corpus: Some(&names),
        title_tokens: &BTreeSet::new(),
      })
      .into_iter()
      .map(|entity| entity.text)
      .collect::<Vec<_>>(),
      ["Zofia Wrona"]
    );
    assert!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Acme Trading",
        data: &data,
        first_names: None,
        name_corpus: Some(&names),
        title_tokens: &BTreeSet::new(),
      })
      .is_empty()
    );
  }

  #[test]
  fn party_role_fields_require_leading_configured_first_names_without_corpus() {
    let data = prepared_signature_data(
      SignatureData {
        person_value_labels: vec![String::from("name")],
        ..SignatureData::default()
      },
      vec![String::from("seller")],
    );
    let first_names = BTreeSet::from([String::from("imani")]);
    assert_eq!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Imani Nwosu",
        data: &data,
        first_names: Some(&first_names),
        name_corpus: None,
        title_tokens: &BTreeSet::new(),
      })
      .into_iter()
      .map(|entity| entity.text)
      .collect::<Vec<_>>(),
      ["Imani Nwosu"]
    );

    let hyphenated_first_names = BTreeSet::from([String::from("jean")]);
    assert_eq!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Jean-Paul Smith",
        data: &data,
        first_names: Some(&hyphenated_first_names),
        name_corpus: None,
        title_tokens: &BTreeSet::new(),
      })
      .into_iter()
      .map(|entity| entity.text)
      .collect::<Vec<_>>(),
      ["Jean-Paul Smith"]
    );
    let compound_first_names = BTreeSet::from([String::from("arnoud-jan")]);
    assert_eq!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Arnoud-Jan Smith",
        data: &data,
        first_names: Some(&compound_first_names),
        name_corpus: None,
        title_tokens: &BTreeSet::new(),
      })
      .into_iter()
      .map(|entity| entity.text)
      .collect::<Vec<_>>(),
      ["Arnoud-Jan Smith"]
    );
    assert!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Acme Trading",
        data: &data,
        first_names: Some(&first_names),
        name_corpus: None,
        title_tokens: &BTreeSet::new(),
      })
      .is_empty()
    );
    assert!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Acme Imani",
        data: &data,
        first_names: Some(&first_names),
        name_corpus: None,
        title_tokens: &BTreeSet::new(),
      })
      .is_empty()
    );
  }

  #[test]
  fn party_role_fields_skip_configured_titles_before_name_evidence() {
    let data = prepared_signature_data(
      SignatureData::default(),
      vec![String::from("seller")],
    );
    let first_names = BTreeSet::from([String::from("jane")]);
    let title_tokens = BTreeSet::from([String::from("dr")]);

    let detected = detect_signatures(&DetectSignaturesArgs {
      full_text: "Seller: Dr. Jane Roe",
      data: &data,
      first_names: Some(&first_names),
      name_corpus: None,
      title_tokens: &title_tokens,
    });
    assert_eq!(
      detected
        .into_iter()
        .map(|entity| entity.text)
        .collect::<Vec<_>>(),
      ["Dr. Jane Roe"],
    );
    assert!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Dr. Acme Trading",
        data: &data,
        first_names: Some(&first_names),
        name_corpus: None,
        title_tokens: &title_tokens,
      })
      .is_empty(),
    );
  }

  #[test]
  fn party_role_fields_use_cross_locale_evidence_without_corpus() {
    let data = prepared_signature_data(
      SignatureData {
        party_role_name_evidence: encoded_name_evidence([
          String::from("Imani"),
          String::from("Zofia"),
          String::from("Arnoud-Jan"),
        ]),
        ..SignatureData::default()
      },
      vec![String::from("seller")],
    );

    assert_eq!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Imani Nwosu",
        data: &data,
        first_names: None,
        name_corpus: None,
        title_tokens: &BTreeSet::new(),
      })
      .into_iter()
      .map(|entity| entity.text)
      .collect::<Vec<_>>(),
      ["Imani Nwosu"]
    );
    assert!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Acme Imani",
        data: &data,
        first_names: None,
        name_corpus: None,
        title_tokens: &BTreeSet::new(),
      })
      .is_empty()
    );
    assert_eq!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Arnoud-Jan Smith",
        data: &data,
        first_names: None,
        name_corpus: None,
        title_tokens: &BTreeSet::new(),
      })
      .into_iter()
      .map(|entity| entity.text)
      .collect::<Vec<_>>(),
      ["Arnoud-Jan Smith"]
    );
  }

  #[test]
  fn scoped_corpus_uses_cross_locale_evidence_only_at_the_name_start() {
    let data = prepared_signature_data(
      SignatureData {
        party_role_name_evidence: encoded_name_evidence([
          String::from("Abdul-Malik"),
          String::from("Imani"),
        ]),
        ..SignatureData::default()
      },
      vec![String::from("seller")],
    );
    let names = PreparedNameCorpusData::new(NameCorpusData::default());

    let detected = detect_signatures(&DetectSignaturesArgs {
      full_text: "Seller: Abdul-Malik Smith",
      data: &data,
      first_names: None,
      name_corpus: Some(&names),
      title_tokens: &BTreeSet::new(),
    });
    assert_eq!(
      detected
        .into_iter()
        .map(|entity| entity.text)
        .collect::<Vec<_>>(),
      ["Abdul-Malik Smith"]
    );
    assert!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Acme Imani",
        data: &data,
        first_names: None,
        name_corpus: Some(&names),
        title_tokens: &BTreeSet::new(),
      })
      .is_empty()
    );
  }

  #[test]
  fn scoped_corpus_requires_name_evidence_at_the_candidate_start() {
    let data = prepared_signature_data(
      SignatureData::default(),
      vec![String::from("seller")],
    );
    let names = PreparedNameCorpusData::new(NameCorpusData {
      first_names: vec![String::from("Abdul-Malik"), String::from("Imani")],
      ..NameCorpusData::default()
    });

    for (text, expected) in [
      ("Seller: Imani Nwosu", "Imani Nwosu"),
      ("Seller: Abdul-Malik Smith", "Abdul-Malik Smith"),
    ] {
      let detected = detect_signatures(&DetectSignaturesArgs {
        full_text: text,
        data: &data,
        first_names: None,
        name_corpus: Some(&names),
        title_tokens: &BTreeSet::new(),
      });
      assert_eq!(
        detected
          .into_iter()
          .map(|entity| entity.text)
          .collect::<Vec<_>>(),
        [expected],
      );
    }
    assert!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Seller: Acme Imani",
        data: &data,
        first_names: None,
        name_corpus: Some(&names),
        title_tokens: &BTreeSet::new(),
      })
      .is_empty(),
    );
  }

  #[test]
  fn party_role_name_evidence_round_trips_normalized_unicode() {
    let source = ["Élodie", "Arnoud-Jan", "İpek", "Élodie", ""]
      .into_iter()
      .map(String::from)
      .collect::<Vec<_>>();
    let encoded = encoded_name_evidence(source);

    assert_eq!(
      super::decode_party_role_name_evidence(&encoded),
      Ok(vec![
        String::from("arnoud-jan"),
        String::from("i\u{307}pek"),
        String::from("élodie"),
      ])
    );
  }

  #[test]
  fn party_role_name_evidence_enforces_source_and_payload_bounds() {
    let token_limit_result =
      super::encode_party_role_name_evidence(std::iter::repeat_n(
        String::from("name"),
        super::MAX_PARTY_ROLE_NAME_EVIDENCE_TOKENS.saturating_add(1),
      ));
    assert_eq!(
      token_limit_result,
      Err(super::PartyRoleNameEvidenceEncodeError::TokenLimit)
    );

    let byte_limit_result = super::encode_party_role_name_evidence([
      "x".repeat(super::MAX_PARTY_ROLE_NAME_EVIDENCE_BYTES.saturating_add(1))
    ]);
    assert_eq!(
      byte_limit_result,
      Err(super::PartyRoleNameEvidenceEncodeError::ByteLimit)
    );
  }

  #[test]
  fn legacy_by_label_remains_signature_only() {
    let data = prepared_signature_data(
      SignatureData {
        labels: vec![String::from("by"), String::from("name")],
        person_value_labels: vec![String::from("jméno")],
        ..SignatureData::default()
      },
      Vec::new(),
    );

    assert_eq!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "By: Q. Z. Mercer",
        data: &data,
        first_names: None,
        name_corpus: None,
        title_tokens: &BTreeSet::new(),
      })
      .into_iter()
      .map(|entity| entity.text)
      .collect::<Vec<_>>(),
      ["Q. Z. Mercer"]
    );
    assert!(
      detect_signatures(&DetectSignaturesArgs {
        full_text: "Name: Main Street",
        data: &data,
        first_names: None,
        name_corpus: None,
        title_tokens: &BTreeSet::new(),
      })
      .is_empty()
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
  fn detects_labelled_name_after_full_width_colon() {
    let entities = detect("Name： Jane Roe");

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Jane Roe"]
    );
  }

  #[test]
  fn full_width_colon_fields_terminate_the_preceding_name() {
    let entities = detect("Name： Jane Roe Email： mail@example.com");

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Jane Roe"]
    );
  }

  #[test]
  fn full_width_colon_contact_field_structures_a_person_list() {
    let entities = detect("Attention: Jane Roe\nEmail： mail@example.com");

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Jane Roe"]
    );
  }

  #[test]
  fn person_value_fields_accept_split_and_particle_led_names() {
    let data = prepared_signature_data(
      SignatureData {
        person_value_labels: vec![
          String::from("jméno"),
          String::from("příjmení"),
        ],
        form_field_labels: vec![
          String::from("jméno"),
          String::from("příjmení"),
        ],
        name_particles: vec![String::from("de")],
        ..SignatureData::default()
      },
      Vec::new(),
    );
    let entities = detect_signatures(&DetectSignaturesArgs {
      full_text: "Jméno: Jan Příjmení: de Vries",
      data: &data,
      first_names: None,
      name_corpus: None,
      title_tokens: &BTreeSet::new(),
    });

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Jan", "de Vries"]
    );
    for text in ["Příjmení: de der", "Příjmení: van der Meer"] {
      assert!(
        detect_signatures(&DetectSignaturesArgs {
          full_text: text,
          data: &data,
          first_names: None,
          name_corpus: None,
          title_tokens: &BTreeSet::new(),
        })
        .is_empty(),
        "unexpected person field match for {text:?}",
      );
    }
  }

  #[test]
  fn person_value_fields_accept_short_names_only_with_reviewed_labels() {
    let data = prepared_signature_data(
      SignatureData {
        person_value_labels: vec![String::from("name")],
        form_field_labels: vec![String::from("name")],
        labels: vec![String::from("by")],
        ..SignatureData::default()
      },
      Vec::new(),
    );

    let entities = detect_signatures(&DetectSignaturesArgs {
      full_text: "Name: Li",
      data: &data,
      first_names: None,
      name_corpus: None,
      title_tokens: &BTreeSet::new(),
    });
    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Li"]
    );

    for text in ["Li", "By: Li", "Name: li", "Name: A"] {
      assert!(
        detect_signatures(&DetectSignaturesArgs {
          full_text: text,
          data: &data,
          first_names: None,
          name_corpus: None,
          title_tokens: &BTreeSet::new(),
        })
        .is_empty(),
        "unexpected short-name match for {text:?}",
      );
    }
  }

  #[test]
  fn detects_attention_name_lists_before_contact_fields() {
    let entities =
      detect("Attention: Steven Patch; Spencer Ho Email: contact@example.test");

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Steven Patch", "Spencer Ho"]
    );
  }

  #[test]
  fn detects_attention_name_lists_at_line_end() {
    let entities = detect("Attention: Mark Bonham; Sam Gardiner");

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Mark Bonham", "Sam Gardiner"]
    );
  }

  #[test]
  fn detects_unicode_case_variants_of_localized_labels() {
    let entities = detect(
      "DO RĄK WŁASNYCH: Anna Kowalska; Piotr Nowak\n\
       Attention: Élodie Martin TÉLÉPHONE: +33 1 23 45 67 89",
    );

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Anna Kowalska", "Piotr Nowak", "Élodie Martin"]
    );
  }

  #[test]
  fn detects_person_value_before_a_following_contact_line() {
    let entities = detect("Attention:\nJane Doe\nEmail: jane@example.test");

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Jane Doe"]
    );
  }

  proptest! {
    #[test]
    fn person_list_structure_gates_generated_name_fields(
      first_index in 0_usize..3,
      second_index in 0_usize..3,
      shape in 0_u8..5,
    ) {
      let names = ["Jane Doe", "Priya Raman", "Élodie Martin"];
      let first = names.get(first_index).copied().unwrap_or("Jane Doe");
      let second = names.get(second_index).copied().unwrap_or("Jane Doe");
      let (text, expected) = match shape {
        0 => (
          format!("Attention: {first}; {second}"),
          vec![first, second],
        ),
        1 => (
          format!("Attention: {first} Email: notices@example.test"),
          vec![first],
        ),
        2 => (
          format!("Attention: {first}\nEmail: notices@example.test"),
          vec![first],
        ),
        3 => (
          format!("Attention:\n{first}\nEmail: notices@example.test"),
          vec![first],
        ),
        _ => (format!("Attention: {first}"), Vec::new()),
      };
      let actual = detect(&text)
        .into_iter()
        .map(|entity| entity.text)
        .collect::<Vec<_>>();

      prop_assert_eq!(actual, expected);
    }
  }

  #[test]
  fn rejects_unstructured_attention_prose_and_contact_departments() {
    assert!(detect("Attention: General Terms").is_empty());
    assert!(detect("Customer Service Tel: +1 555 0100").is_empty());
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
