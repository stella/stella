use std::collections::{BTreeMap, BTreeSet};

use crate::byte_offsets::ByteOffsets;
use crate::signatures::PersonSpanTerminators;
use crate::types::Result;

#[cfg(test)]
use super::common::contains_span;
use super::common::{byte_len, entity_len, is_caller_owned};
use super::document::{CharSpan, ResolutionDocument};
use super::{DetectionSource, PipelineEntity};

/// Inputs to the boundary pass. `person_terminators` is empty when the
/// engine has no signature data, which disables person-span truncation.
#[derive(Clone, Copy, Debug)]
pub struct BoundaryParams<'a> {
  pub entities: &'a [PipelineEntity],
  pub full_text: &'a str,
  pub person_terminators: PersonSpanTerminators<'a>,
}

pub fn enforce_boundary_consistency(
  params: BoundaryParams<'_>,
) -> Result<Vec<PipelineEntity>> {
  let BoundaryParams {
    entities,
    full_text,
    person_terminators,
  } = params;
  let document = ResolutionDocument::new(full_text);
  enforce_boundary_consistency_with_document(
    entities.to_vec(),
    &document,
    person_terminators,
  )
}

pub(crate) fn enforce_boundary_consistency_with_document(
  entities: Vec<PipelineEntity>,
  document: &ResolutionDocument<'_>,
  person_terminators: PersonSpanTerminators<'_>,
) -> Result<Vec<PipelineEntity>> {
  let offsets = document.offsets();
  let analysis = document.word_analysis();
  let fixed = fix_partial_words(
    entities,
    &offsets,
    &analysis.spans,
    &analysis.boundaries,
  )?;
  // Truncation runs after word-boundary expansion so expansion cannot push a
  // person span back across a terminator it was just pulled behind.
  let truncated = truncate_person_spans(
    fixed,
    document.text(),
    &offsets,
    person_terminators,
  )?;
  let resolved = resolve_cross_label_overlaps(truncated, &offsets)?;
  let deduped = deduplicate_spans(resolved);
  let merged = merge_adjacent(deduped, &offsets)?;
  Ok(remove_nested_same_label(merged))
}

/// Stop person spans at a signature-stamp phrase or a form-field label.
///
/// Stamp phrases are configured terminators, while field labels are exact,
/// language-keyed vocabulary from `signature-detection.json`.
fn truncate_person_spans(
  entities: Vec<PipelineEntity>,
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  terminators: PersonSpanTerminators<'_>,
) -> Result<Vec<PipelineEntity>> {
  if terminators.stamp_phrases.is_empty() && terminators.field_labels.is_empty()
  {
    return Ok(entities);
  }

  let mut result = Vec::with_capacity(entities.len());
  for mut entity in entities {
    if entity.label != crate::labels::PERSON_LABEL
      || has_locked_boundary(&entity)
    {
      result.push(entity);
      continue;
    }

    if let Some(prefix_end) =
      leading_terminator_end(full_text, &entity, terminators)
    {
      // A detector may include both a leading signing-software stamp and the
      // signer. Retain the name after the exact terminator; only discard the
      // entity when it contains no text beyond that prefix.
      let trimmed_start = trim_leading_separator(full_text, prefix_end);
      if trimmed_start >= entity.end {
        continue;
      }
      entity.start = trimmed_start;
      entity.text = offsets.slice(trimmed_start, entity.end)?;
      result.push(entity);
      continue;
    }

    let Some(cut) = terminator_start_within(full_text, &entity, terminators)
    else {
      result.push(entity);
      continue;
    };

    let trimmed_end = trim_trailing_space(full_text, entity.start, cut);
    if trimmed_end <= entity.start {
      continue;
    }

    entity.end = trimmed_end;
    entity.text = offsets.slice(entity.start, trimmed_end)?;
    result.push(entity);
  }

  Ok(result)
}

fn leading_terminator_end(
  full_text: &str,
  entity: &PipelineEntity,
  terminators: PersonSpanTerminators<'_>,
) -> Option<u32> {
  let Ok(start) = usize::try_from(entity.start) else {
    return None;
  };
  let tail = full_text.get(start..).unwrap_or_default();
  stamp_phrase_end(tail, terminators.stamp_phrases)
    .or_else(|| field_label_end(tail, terminators.field_labels))
    .and_then(|relative| u32::try_from(start.saturating_add(relative)).ok())
}

/// Byte offset of the first terminator beginning inside the entity span.
///
/// A stamp phrase may run past `entity.end` (the detector stops at the name,
/// so "Karel Digitálně" holds only the first word of "digitálně podepsal"),
/// so phrases are matched against the full text from each candidate token.
fn terminator_start_within(
  full_text: &str,
  entity: &PipelineEntity,
  terminators: PersonSpanTerminators<'_>,
) -> Option<u32> {
  let start = usize::try_from(entity.start).ok()?;
  let end = usize::try_from(entity.end).ok()?;
  let window = full_text.get(start..end)?;

  window
    .char_indices()
    .filter(|&(offset, _)| {
      offset > 0 && is_token_start(window, offset) && offset < end
    })
    .find(|&(offset, _)| {
      let absolute = start.saturating_add(offset);
      let tail = full_text.get(absolute..).unwrap_or_default();
      starts_with_stamp_phrase(tail, terminators.stamp_phrases)
        || is_colon_tied_field_label(tail, terminators.field_labels)
    })
    .and_then(|(offset, _)| u32::try_from(start.saturating_add(offset)).ok())
}

fn starts_with_stamp_phrase(tail: &str, phrases: &[String]) -> bool {
  stamp_phrase_end(tail, phrases).is_some()
}

fn stamp_phrase_end(tail: &str, phrases: &[String]) -> Option<usize> {
  phrases.iter().find_map(|phrase| {
    if !starts_with_ignore_case(tail, phrase) {
      return None;
    }
    let rest = remainder_after_chars(tail, phrase.chars().count())?;
    if rest.chars().next().is_some_and(char::is_alphanumeric) {
      return None;
    }
    Some(tail.len().saturating_sub(rest.len()))
  })
}

/// A field label counts only when optional whitespace after it ends in a colon.
/// Without the colon, "Name" and "Jméno" are ordinary words, and a surname
/// that happens to collide with the vocabulary keeps its place in the span.
fn is_colon_tied_field_label(tail: &str, labels: &[String]) -> bool {
  field_label_end(tail, labels).is_some()
}

fn field_label_end(tail: &str, labels: &[String]) -> Option<usize> {
  labels.iter().find_map(|label| {
    if !starts_with_ignore_case(tail, label) {
      return None;
    }
    let after_label = remainder_after_chars(tail, label.chars().count())?;
    let after_space = after_label.trim_start();
    let separator = after_space.chars().next()?;
    matches!(separator, ':' | '：').then(|| {
      let label_end = tail.len().saturating_sub(after_label.len());
      let separator_start = tail.len().saturating_sub(after_space.len());
      label_end.max(separator_start.saturating_add(separator.len_utf8()))
    })
  })
}

fn trim_leading_separator(full_text: &str, start: u32) -> u32 {
  let Ok(start_index) = usize::try_from(start) else {
    return start;
  };
  let tail = full_text.get(start_index..).unwrap_or_default();
  let trimmed = tail.trim_start_matches(|character: char| {
    character.is_whitespace() || matches!(character, ':' | '：' | '-' | '–')
  });
  u32::try_from(full_text.len().saturating_sub(trimmed.len())).unwrap_or(start)
}

fn remainder_after_chars(value: &str, count: usize) -> Option<&str> {
  if count == value.chars().count() {
    return Some("");
  }
  let index = value.char_indices().nth(count)?.0;
  value.get(index..)
}

/// Case-insensitive prefix test. `needle` is lowercased at prepare time.
fn starts_with_ignore_case(haystack: &str, needle: &str) -> bool {
  let mut lowered = haystack.chars().flat_map(char::to_lowercase);
  needle
    .chars()
    .all(|expected| lowered.next() == Some(expected))
}

fn is_token_start(window: &str, offset: usize) -> bool {
  window
    .get(..offset)
    .and_then(|prefix| prefix.chars().next_back())
    .is_none_or(|previous| !previous.is_alphanumeric())
}

fn trim_trailing_space(full_text: &str, start: u32, end: u32) -> u32 {
  let (Ok(start_index), Ok(end_index)) =
    (usize::try_from(start), usize::try_from(end))
  else {
    return end;
  };
  let Some(slice) = full_text.get(start_index..end_index) else {
    return end;
  };
  let trimmed = slice.trim_end();
  start.saturating_add(byte_len(trimmed))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LabelSummary {
  Empty,
  Uniform(usize),
  Mixed,
}

impl LabelSummary {
  const fn combine(left: Self, right: Self) -> Self {
    match (left, right) {
      (Self::Empty, summary) | (summary, Self::Empty) => summary,
      (Self::Uniform(left_label), Self::Uniform(right_label))
        if left_label == right_label =>
      {
        Self::Uniform(left_label)
      }
      _ => Self::Mixed,
    }
  }

  const fn has_different_label(self, excluded_label: usize) -> bool {
    match self {
      Self::Empty => false,
      Self::Uniform(label) => label != excluded_label,
      Self::Mixed => true,
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BoundaryPoint {
  position: u32,
  label_id: usize,
}

// Each tree node records whether all positions below it share one label.
// A query can therefore discard a same-label subtree in one step and descend
// only toward the nearest cross-label start or end.
#[derive(Debug)]
struct BoundaryPositionIndex {
  points: Vec<BoundaryPoint>,
  summaries: Vec<LabelSummary>,
  leaf_count: usize,
}

#[derive(Debug, Default)]
struct BoundarySearchResult {
  position: Option<u32>,
  #[cfg(test)]
  node_visits: usize,
}

impl BoundaryPositionIndex {
  fn new(
    entities: &[PipelineEntity],
    label_ids: &[usize],
    position: impl Fn(&PipelineEntity) -> u32,
  ) -> Self {
    let mut points = entities
      .iter()
      .zip(label_ids)
      .map(|(entity, &label_id)| BoundaryPoint {
        position: position(entity),
        label_id,
      })
      .collect::<Vec<_>>();
    points.sort_by_key(|point| point.position);

    let leaf_count = points.len().next_power_of_two();
    let mut summaries = vec![LabelSummary::Empty; leaf_count.saturating_mul(2)];
    for (index, point) in points.iter().enumerate() {
      if let Some(summary) = summaries.get_mut(leaf_count.saturating_add(index))
      {
        *summary = LabelSummary::Uniform(point.label_id);
      }
    }
    for index in (1..leaf_count).rev() {
      let left = summaries
        .get(index.saturating_mul(2))
        .copied()
        .unwrap_or(LabelSummary::Empty);
      let right = summaries
        .get(index.saturating_mul(2).saturating_add(1))
        .copied()
        .unwrap_or(LabelSummary::Empty);
      if let Some(summary) = summaries.get_mut(index) {
        *summary = LabelSummary::combine(left, right);
      }
    }

    Self {
      points,
      summaries,
      leaf_count,
    }
  }

  fn leftmost_different(
    &self,
    start: u32,
    end: u32,
    excluded_label: usize,
  ) -> BoundarySearchResult {
    let query_start =
      self.points.partition_point(|point| point.position < start);
    let query_end = self.points.partition_point(|point| point.position < end);
    #[cfg(test)]
    let mut node_visits = 0_usize;
    #[cfg(test)]
    let mut record_visit = || {
      node_visits = node_visits.saturating_add(1);
    };
    #[cfg(not(test))]
    let mut record_visit = || {};
    let position = self.find_different(
      BoundarySearchParams {
        node: 1,
        node_start: 0,
        node_end: self.leaf_count,
        query_start,
        query_end,
        excluded_label,
        direction: SearchDirection::Leftmost,
      },
      &mut record_visit,
    );
    BoundarySearchResult {
      position,
      #[cfg(test)]
      node_visits,
    }
  }

  fn rightmost_different(
    &self,
    start_exclusive: u32,
    end_inclusive: u32,
    excluded_label: usize,
  ) -> BoundarySearchResult {
    let query_start = self
      .points
      .partition_point(|point| point.position <= start_exclusive);
    let query_end = self
      .points
      .partition_point(|point| point.position <= end_inclusive);
    #[cfg(test)]
    let mut node_visits = 0_usize;
    #[cfg(test)]
    let mut record_visit = || {
      node_visits = node_visits.saturating_add(1);
    };
    #[cfg(not(test))]
    let mut record_visit = || {};
    let position = self.find_different(
      BoundarySearchParams {
        node: 1,
        node_start: 0,
        node_end: self.leaf_count,
        query_start,
        query_end,
        excluded_label,
        direction: SearchDirection::Rightmost,
      },
      &mut record_visit,
    );
    BoundarySearchResult {
      position,
      #[cfg(test)]
      node_visits,
    }
  }

  fn find_different(
    &self,
    params: BoundarySearchParams,
    record_visit: &mut impl FnMut(),
  ) -> Option<u32> {
    let BoundarySearchParams {
      node,
      node_start,
      node_end,
      query_start,
      query_end,
      excluded_label,
      direction,
    } = params;
    if node_end <= query_start || node_start >= query_end {
      return None;
    }

    record_visit();
    if !self
      .summaries
      .get(node)
      .copied()
      .unwrap_or(LabelSummary::Empty)
      .has_different_label(excluded_label)
    {
      return None;
    }
    if node_end.saturating_sub(node_start) == 1 {
      return self.points.get(node_start).map(|point| point.position);
    }

    let midpoint =
      node_start.saturating_add(node_end.saturating_sub(node_start) >> 1);
    let left = BoundarySearchParams {
      node: node.saturating_mul(2),
      node_start,
      node_end: midpoint,
      query_start,
      query_end,
      excluded_label,
      direction,
    };
    let right = BoundarySearchParams {
      node: node.saturating_mul(2).saturating_add(1),
      node_start: midpoint,
      node_end,
      query_start,
      query_end,
      excluded_label,
      direction,
    };
    match direction {
      SearchDirection::Leftmost => self
        .find_different(left, record_visit)
        .or_else(|| self.find_different(right, record_visit)),
      SearchDirection::Rightmost => self
        .find_different(right, record_visit)
        .or_else(|| self.find_different(left, record_visit)),
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SearchDirection {
  Leftmost,
  Rightmost,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BoundarySearchParams {
  node: usize,
  node_start: usize,
  node_end: usize,
  query_start: usize,
  query_end: usize,
  excluded_label: usize,
  direction: SearchDirection,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct BoundaryFixStats {
  #[cfg(test)]
  index_node_visits: usize,
}

impl BoundaryFixStats {
  #[inline]
  #[cfg(test)]
  const fn record_search(&mut self, search: &BoundarySearchResult) {
    self.index_node_visits =
      self.index_node_visits.saturating_add(search.node_visits);
  }
}

#[derive(Debug)]
struct BoundaryOverlapIndexes {
  label_ids: Vec<usize>,
  starts: BoundaryPositionIndex,
  ends: BoundaryPositionIndex,
}

impl BoundaryOverlapIndexes {
  fn new(entities: &[PipelineEntity]) -> Self {
    let mut labels = BTreeMap::<&str, usize>::new();
    let label_ids = entities
      .iter()
      .map(|entity| {
        let next_id = labels.len();
        *labels.entry(&entity.label).or_insert(next_id)
      })
      .collect::<Vec<_>>();
    Self {
      starts: BoundaryPositionIndex::new(entities, &label_ids, |entity| {
        entity.start
      }),
      ends: BoundaryPositionIndex::new(entities, &label_ids, |entity| {
        entity.end
      }),
      label_ids,
    }
  }
}

fn fix_partial_words(
  entities: Vec<PipelineEntity>,
  offsets: &ByteOffsets<'_>,
  spans: &[CharSpan],
  boundaries: &BTreeSet<u32>,
) -> Result<Vec<PipelineEntity>> {
  fix_partial_words_with_stats(entities, offsets, spans, boundaries)
    .map(|(fixed, _)| fixed)
}

fn fix_partial_words_with_stats(
  mut entities: Vec<PipelineEntity>,
  offsets: &ByteOffsets<'_>,
  spans: &[CharSpan],
  boundaries: &BTreeSet<u32>,
) -> Result<(Vec<PipelineEntity>, BoundaryFixStats)> {
  entities.sort_by_key(|entity| entity.start);
  let indexes = BoundaryOverlapIndexes::new(&entities);
  #[cfg(test)]
  let mut stats = BoundaryFixStats::default();
  #[cfg(not(test))]
  let stats = BoundaryFixStats::default();

  for (index, entity) in entities.iter_mut().enumerate() {
    if has_locked_boundary(entity) || has_detector_locked_boundary(entity) {
      continue;
    }

    if entity.text != offsets.slice_ref(entity.start, entity.end)? {
      continue;
    }

    let mut new_start = word_start_at(entity.start, boundaries, spans);
    let mut new_end = word_end_at(entity.end, boundaries, spans);

    {
      let label_id = indexes.label_ids.get(index).copied().unwrap_or_default();
      let left =
        indexes
          .ends
          .rightmost_different(new_start, entity.start, label_id);
      #[cfg(test)]
      stats.record_search(&left);
      if let Some(end) = left.position {
        new_start = new_start.max(end);
      }
      let right = indexes
        .starts
        .leftmost_different(entity.end, new_end, label_id);
      #[cfg(test)]
      stats.record_search(&right);
      if let Some(start) = right.position {
        new_end = new_end.min(start);
      }
    }

    if new_start == entity.start && new_end == entity.end {
      continue;
    }

    entity.start = new_start;
    entity.end = new_end;
    entity.text = offsets.slice(new_start, new_end)?;
  }

  Ok((entities, stats))
}

fn resolve_cross_label_overlaps(
  entities: Vec<PipelineEntity>,
  offsets: &ByteOffsets<'_>,
) -> Result<Vec<PipelineEntity>> {
  resolve_cross_label_overlaps_with_stats(entities, offsets)
    .map(|(resolved, _)| resolved)
}

#[cfg(test)]
fn resolve_cross_label_overlaps_linear(
  entities: &[PipelineEntity],
  offsets: &ByteOffsets<'_>,
) -> Result<Vec<PipelineEntity>> {
  let mut sorted = entities.to_vec();
  sorted.sort_by_key(|entity| entity.start);

  let mut left_index = 0;
  while left_index < sorted.len() {
    let mut right_index = left_index.saturating_add(1);
    while right_index < sorted.len() {
      let Some(left) = sorted.get(left_index) else {
        break;
      };
      let Some(right) = sorted.get(right_index) else {
        break;
      };
      if right.start >= left.end {
        break;
      }
      if left.label == right.label
        || contains_span(left, right)
        || contains_span(right, left)
      {
        right_index = right_index.saturating_add(1);
        continue;
      }

      let left_len = entity_len(left);
      let right_len = entity_len(right);
      let left_locked = has_locked_boundary(left);
      let right_locked = has_locked_boundary(right);
      let left_wins = if left_locked == right_locked {
        match left.score.total_cmp(&right.score) {
          std::cmp::Ordering::Greater => true,
          std::cmp::Ordering::Less => false,
          std::cmp::Ordering::Equal => left_len >= right_len,
        }
      } else {
        left_locked
      };

      if left_wins {
        let new_start = left.end;
        if let Some(right_mut) = sorted.get_mut(right_index) {
          right_mut.start = new_start;
          right_mut.text = offsets.slice(new_start, right_mut.end)?;
        }
        right_index = right_index.saturating_add(1);
        continue;
      }

      let new_end = right.start;
      if let Some(left_mut) = sorted.get_mut(left_index) {
        left_mut.end = new_end;
        left_mut.text = offsets.slice(left_mut.start, new_end)?;
      }
      break;
    }

    left_index = left_index.saturating_add(1);
  }

  Ok(
    sorted
      .into_iter()
      .filter(|entity| entity.start < entity.end)
      .collect(),
  )
}

fn resolve_cross_label_overlaps_with_stats(
  mut entities: Vec<PipelineEntity>,
  offsets: &ByteOffsets<'_>,
) -> Result<(Vec<PipelineEntity>, CrossingOverlapStats)> {
  entities.sort_by_key(|entity| entity.start);
  let mut index = CrossingOverlapIndex::new(&entities);
  #[cfg(test)]
  let mut stats = CrossingOverlapStats::default();
  #[cfg(not(test))]
  let stats = CrossingOverlapStats::default();

  for left_index in 0..entities.len() {
    let mut search_from = left_index.saturating_add(1);
    while let Some(left) = entities.get(left_index) {
      let barrier = index.first_start_at_least(search_from, left.end);
      #[cfg(test)]
      stats.record_search(&barrier);
      let search_end = barrier.index.unwrap_or(entities.len());
      let crossing = index.first_crossing(
        search_from,
        search_end,
        left.start,
        left.end,
        index.label_id(left_index),
      );
      #[cfg(test)]
      stats.record_search(&crossing);
      let Some(right_index) = crossing.index else {
        break;
      };

      let Some(right) = entities.get(right_index) else {
        break;
      };
      let left_len = entity_len(left);
      let right_len = entity_len(right);
      let left_locked = has_locked_boundary(left);
      let right_locked = has_locked_boundary(right);
      let left_wins = if left_locked == right_locked {
        match left.score.total_cmp(&right.score) {
          std::cmp::Ordering::Greater => true,
          std::cmp::Ordering::Less => false,
          std::cmp::Ordering::Equal => left_len >= right_len,
        }
      } else {
        left_locked
      };

      if left_wins {
        let new_start = left.end;
        if let Some(right_mut) = entities.get_mut(right_index) {
          right_mut.start = new_start;
          right_mut.text = offsets.slice(new_start, right_mut.end)?;
        }
        index.update_start(right_index, new_start);
        #[cfg(test)]
        {
          stats.start_updates = stats.start_updates.saturating_add(1);
        }
        search_from = right_index.saturating_add(1);
        continue;
      }

      let new_end = right.start;
      if let Some(left_mut) = entities.get_mut(left_index) {
        left_mut.end = new_end;
        left_mut.text = offsets.slice(left_mut.start, new_end)?;
      }
      break;
    }
  }

  Ok((
    entities
      .into_iter()
      .filter(|entity| entity.start < entity.end)
      .collect(),
    stats,
  ))
}

fn deduplicate_spans(mut entities: Vec<PipelineEntity>) -> Vec<PipelineEntity> {
  entities.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| left.end.cmp(&right.end))
      .then_with(|| left.label.cmp(&right.label))
      .then_with(|| right.score.total_cmp(&left.score))
  });
  entities.dedup_by(|right, left| {
    left.start == right.start
      && left.end == right.end
      && left.label == right.label
  });
  entities
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LabelEnd {
  label_id: usize,
  end: u32,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct CrossLabelMaxEnds {
  first: Option<LabelEnd>,
  second: Option<LabelEnd>,
}

impl CrossLabelMaxEnds {
  fn insert(&mut self, candidate: LabelEnd) {
    if let Some(first) = &mut self.first
      && first.label_id == candidate.label_id
    {
      first.end = first.end.max(candidate.end);
      return;
    }
    if let Some(second) = &mut self.second
      && second.label_id == candidate.label_id
    {
      second.end = second.end.max(candidate.end);
      if self.first.is_some_and(|first| second.end > first.end) {
        std::mem::swap(&mut self.first, &mut self.second);
      }
      return;
    }

    if self.first.is_none_or(|first| candidate.end > first.end) {
      self.second = self.first;
      self.first = Some(candidate);
      return;
    }
    if self.second.is_none_or(|second| candidate.end > second.end) {
      self.second = Some(candidate);
    }
  }

  fn max_end_excluding(self, excluded_label: usize) -> Option<u32> {
    self
      .first
      .filter(|entry| entry.label_id != excluded_label)
      .or(self.second)
      .map(|entry| entry.end)
  }

  fn combine(left: Self, right: Self) -> Self {
    let mut combined = Self::default();
    for candidate in [left.first, left.second, right.first, right.second]
      .into_iter()
      .flatten()
    {
      combined.insert(candidate);
    }
    combined
  }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct CrossLabelMinEnds {
  first: Option<LabelEnd>,
  second: Option<LabelEnd>,
}

impl CrossLabelMinEnds {
  fn insert(&mut self, candidate: LabelEnd) {
    if let Some(first) = &mut self.first
      && first.label_id == candidate.label_id
    {
      first.end = first.end.min(candidate.end);
      return;
    }
    if let Some(second) = &mut self.second
      && second.label_id == candidate.label_id
    {
      second.end = second.end.min(candidate.end);
      if self.first.is_some_and(|first| second.end < first.end) {
        std::mem::swap(&mut self.first, &mut self.second);
      }
      return;
    }

    if self.first.is_none_or(|first| candidate.end < first.end) {
      self.second = self.first;
      self.first = Some(candidate);
      return;
    }
    if self.second.is_none_or(|second| candidate.end < second.end) {
      self.second = Some(candidate);
    }
  }

  fn min_end_excluding(self, excluded_label: usize) -> Option<u32> {
    self
      .first
      .filter(|entry| entry.label_id != excluded_label)
      .or(self.second)
      .map(|entry| entry.end)
  }

  fn combine(left: Self, right: Self) -> Self {
    let mut combined = Self::default();
    for candidate in [left.first, left.second, right.first, right.second]
      .into_iter()
      .flatten()
    {
      combined.insert(candidate);
    }
    combined
  }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct CrossingOverlapSearch {
  index: Option<usize>,
  #[cfg(test)]
  node_visits: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct CrossingOverlapStats {
  #[cfg(test)]
  searches: usize,
  #[cfg(test)]
  node_visits: usize,
  #[cfg(test)]
  start_updates: usize,
}

impl CrossingOverlapStats {
  #[cfg(test)]
  const fn record_search(&mut self, search: &CrossingOverlapSearch) {
    self.searches = self.searches.saturating_add(1);
    self.node_visits = self.node_visits.saturating_add(search.node_visits);
  }
}

struct CrossingOverlapIndex {
  starts: Vec<u32>,
  label_ids: Vec<usize>,
  max_starts: Vec<u32>,
  min_starts: Vec<u32>,
  max_ends: Vec<CrossLabelMaxEnds>,
  min_ends: Vec<CrossLabelMinEnds>,
  leaf_count: usize,
}

impl CrossingOverlapIndex {
  fn new(entities: &[PipelineEntity]) -> Self {
    let leaf_count = entities.len().next_power_of_two().max(1);
    let tree_len = leaf_count.saturating_mul(2);
    let mut labels = BTreeMap::<&str, usize>::new();
    let label_ids = entities
      .iter()
      .map(|entity| {
        let next_id = labels.len();
        *labels.entry(&entity.label).or_insert(next_id)
      })
      .collect::<Vec<_>>();
    let starts = entities
      .iter()
      .map(|entity| entity.start)
      .collect::<Vec<_>>();
    let mut max_starts = vec![0_u32; tree_len];
    let mut min_starts = vec![u32::MAX; tree_len];
    let mut max_ends = vec![CrossLabelMaxEnds::default(); tree_len];
    let mut min_ends = vec![CrossLabelMinEnds::default(); tree_len];

    for (index, entity) in entities.iter().enumerate() {
      let leaf = leaf_count.saturating_add(index);
      if let Some(start) = max_starts.get_mut(leaf) {
        *start = entity.start;
      }
      if let Some(start) = min_starts.get_mut(leaf) {
        *start = entity.start;
      }
      if let Some(summary) = max_ends.get_mut(leaf) {
        summary.insert(LabelEnd {
          label_id: label_ids.get(index).copied().unwrap_or_default(),
          end: entity.end,
        });
      }
      if let Some(summary) = min_ends.get_mut(leaf) {
        summary.insert(LabelEnd {
          label_id: label_ids.get(index).copied().unwrap_or_default(),
          end: entity.end,
        });
      }
    }
    for node in (1..leaf_count).rev() {
      let left = node.saturating_mul(2);
      let right = left.saturating_add(1);
      let max_left_start = max_starts.get(left).copied().unwrap_or_default();
      let max_right_start = max_starts.get(right).copied().unwrap_or_default();
      if let Some(start) = max_starts.get_mut(node) {
        *start = max_left_start.max(max_right_start);
      }
      let min_left_start = min_starts.get(left).copied().unwrap_or(u32::MAX);
      let min_right_start = min_starts.get(right).copied().unwrap_or(u32::MAX);
      if let Some(start) = min_starts.get_mut(node) {
        *start = min_left_start.min(min_right_start);
      }
      let max_left_ends = max_ends.get(left).copied().unwrap_or_default();
      let max_right_ends = max_ends.get(right).copied().unwrap_or_default();
      if let Some(summary) = max_ends.get_mut(node) {
        *summary = CrossLabelMaxEnds::combine(max_left_ends, max_right_ends);
      }
      let min_left_ends = min_ends.get(left).copied().unwrap_or_default();
      let min_right_ends = min_ends.get(right).copied().unwrap_or_default();
      if let Some(summary) = min_ends.get_mut(node) {
        *summary = CrossLabelMinEnds::combine(min_left_ends, min_right_ends);
      }
    }

    Self {
      starts,
      label_ids,
      max_starts,
      min_starts,
      max_ends,
      min_ends,
      leaf_count,
    }
  }

  fn label_id(&self, index: usize) -> usize {
    self.label_ids.get(index).copied().unwrap_or_default()
  }

  fn update_start(&mut self, index: usize, start: u32) {
    let Some(stored) = self.starts.get_mut(index) else {
      return;
    };
    *stored = start;
    let mut node = self.leaf_count.saturating_add(index);
    if let Some(max_start) = self.max_starts.get_mut(node) {
      *max_start = start;
    }
    if let Some(min_start) = self.min_starts.get_mut(node) {
      *min_start = start;
    }
    while node > 1 {
      node >>= 1;
      let left = node.saturating_mul(2);
      let right = left.saturating_add(1);
      let maximum = self
        .max_starts
        .get(left)
        .copied()
        .unwrap_or_default()
        .max(self.max_starts.get(right).copied().unwrap_or_default());
      if let Some(max_start) = self.max_starts.get_mut(node) {
        *max_start = maximum;
      }
      let minimum = self
        .min_starts
        .get(left)
        .copied()
        .unwrap_or(u32::MAX)
        .min(self.min_starts.get(right).copied().unwrap_or(u32::MAX));
      if let Some(min_start) = self.min_starts.get_mut(node) {
        *min_start = minimum;
      }
    }
  }

  fn first_start_at_least(
    &self,
    from: usize,
    threshold: u32,
  ) -> CrossingOverlapSearch {
    self.search(
      from,
      self.starts.len(),
      |node| {
        self.max_starts.get(node).copied().unwrap_or_default() >= threshold
      },
      |index| {
        self
          .starts
          .get(index)
          .is_some_and(|start| *start >= threshold)
      },
    )
  }

  fn first_crossing(
    &self,
    from: usize,
    to: usize,
    left_start: u32,
    left_end: u32,
    excluded_label: usize,
  ) -> CrossingOverlapSearch {
    self.search(
      from,
      to,
      |node| {
        let right_crossing =
          self.max_starts.get(node).copied().unwrap_or_default() > left_start
            && self
              .max_ends
              .get(node)
              .copied()
              .unwrap_or_default()
              .max_end_excluding(excluded_label)
              .is_some_and(|end| end > left_end);
        let left_crossing =
          self.min_starts.get(node).copied().unwrap_or(u32::MAX) < left_start
            && self
              .min_ends
              .get(node)
              .copied()
              .unwrap_or_default()
              .min_end_excluding(excluded_label)
              .is_some_and(|end| end < left_end);
        right_crossing || left_crossing
      },
      |index| {
        let start = self.starts.get(index).copied().unwrap_or_default();
        let end = self
          .max_ends
          .get(self.leaf_count.saturating_add(index))
          .copied()
          .unwrap_or_default()
          .max_end_excluding(excluded_label);
        self.label_id(index) != excluded_label
          && end.is_some_and(|end| {
            (start > left_start && end > left_end)
              || (start < left_start && end < left_end)
          })
      },
    )
  }

  fn search(
    &self,
    from: usize,
    to: usize,
    node_may_match: impl Fn(usize) -> bool,
    leaf_matches: impl Fn(usize) -> bool,
  ) -> CrossingOverlapSearch {
    #[cfg(test)]
    let mut node_visits = 0_usize;
    #[cfg(test)]
    let mut record_visit = || {
      node_visits = node_visits.saturating_add(1);
    };
    #[cfg(not(test))]
    let mut record_visit = || {};
    let index = Self::search_node(
      TreeSearchParams {
        node: 1,
        node_start: 0,
        node_end: self.leaf_count,
        query_start: from,
        query_end: to,
      },
      &node_may_match,
      &leaf_matches,
      &mut record_visit,
    );
    CrossingOverlapSearch {
      index,
      #[cfg(test)]
      node_visits,
    }
  }

  fn search_node(
    params: TreeSearchParams,
    node_may_match: &impl Fn(usize) -> bool,
    leaf_matches: &impl Fn(usize) -> bool,
    record_visit: &mut impl FnMut(),
  ) -> Option<usize> {
    if params.node_end <= params.query_start
      || params.node_start >= params.query_end
    {
      return None;
    }
    record_visit();
    if !node_may_match(params.node) {
      return None;
    }
    if params.node_end.saturating_sub(params.node_start) == 1 {
      return leaf_matches(params.node_start).then_some(params.node_start);
    }

    let midpoint = params
      .node_start
      .saturating_add(params.node_end.saturating_sub(params.node_start) >> 1);
    Self::search_node(
      TreeSearchParams {
        node: params.node.saturating_mul(2),
        node_start: params.node_start,
        node_end: midpoint,
        query_start: params.query_start,
        query_end: params.query_end,
      },
      node_may_match,
      leaf_matches,
      record_visit,
    )
    .or_else(|| {
      Self::search_node(
        TreeSearchParams {
          node: params.node.saturating_mul(2).saturating_add(1),
          node_start: midpoint,
          node_end: params.node_end,
          query_start: params.query_start,
          query_end: params.query_end,
        },
        node_may_match,
        leaf_matches,
        record_visit,
      )
    })
  }
}

#[derive(Clone, Copy)]
struct TreeSearchParams {
  node: usize,
  node_start: usize,
  node_end: usize,
  query_start: usize,
  query_end: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct GapOccupancyResult {
  occupied: bool,
  #[cfg(test)]
  activated_entities: usize,
}

/// Start-sorted intervals activated once as the right edge advances. Keeping
/// the two greatest ends from distinct labels makes each cross-label overlap
/// query constant-time after amortized linear activation.
struct GapOccupancyIndex {
  starts: Vec<u32>,
  ends: Vec<u32>,
  label_ids: Vec<usize>,
  activation_cursor: usize,
  max_ends: CrossLabelMaxEnds,
}

impl GapOccupancyIndex {
  fn new(entities: &[PipelineEntity]) -> Self {
    let mut labels = BTreeMap::<&str, usize>::new();
    let label_ids = entities
      .iter()
      .map(|entity| {
        let next_id = labels.len();
        *labels.entry(&entity.label).or_insert(next_id)
      })
      .collect();
    Self {
      starts: entities.iter().map(|entity| entity.start).collect(),
      ends: entities.iter().map(|entity| entity.end).collect(),
      label_ids,
      activation_cursor: 0,
      max_ends: CrossLabelMaxEnds::default(),
    }
  }

  fn has_cross_label_overlap(
    &mut self,
    entity_index: usize,
    gap_start: u32,
    gap_end: u32,
  ) -> GapOccupancyResult {
    #[cfg(test)]
    let mut activated_entities = 0_usize;
    while self
      .starts
      .get(self.activation_cursor)
      .is_some_and(|start| *start < gap_end)
    {
      let Some(end) = self.ends.get(self.activation_cursor).copied() else {
        break;
      };
      let label_id = self
        .label_ids
        .get(self.activation_cursor)
        .copied()
        .unwrap_or_default();
      self.max_ends.insert(LabelEnd { label_id, end });
      self.activation_cursor = self.activation_cursor.saturating_add(1);
      #[cfg(test)]
      {
        activated_entities = activated_entities.saturating_add(1);
      }
    }

    let excluded_label = self
      .label_ids
      .get(entity_index)
      .copied()
      .unwrap_or_default();
    GapOccupancyResult {
      occupied: self
        .max_ends
        .max_end_excluding(excluded_label)
        .is_some_and(|end| end > gap_start),
      #[cfg(test)]
      activated_entities,
    }
  }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct MergeAdjacentStats {
  #[cfg(test)]
  gap_queries: usize,
  #[cfg(test)]
  activated_entities: usize,
}

impl MergeAdjacentStats {
  #[cfg(test)]
  const fn record_query(&mut self, query: GapOccupancyResult) {
    self.gap_queries = self.gap_queries.saturating_add(1);
    self.activated_entities = self
      .activated_entities
      .saturating_add(query.activated_entities);
  }
}

fn merge_adjacent(
  entities: Vec<PipelineEntity>,
  offsets: &ByteOffsets<'_>,
) -> Result<Vec<PipelineEntity>> {
  merge_adjacent_with_stats(entities, offsets).map(|(merged, _)| merged)
}

fn merge_adjacent_with_stats(
  mut entities: Vec<PipelineEntity>,
  offsets: &ByteOffsets<'_>,
) -> Result<(Vec<PipelineEntity>, MergeAdjacentStats)> {
  entities.sort_by_key(|entity| entity.start);
  let mut occupancy_index = GapOccupancyIndex::new(&entities);
  let mut result = Vec::<PipelineEntity>::new();
  let mut last_by_label = BTreeMap::<String, usize>::new();
  #[cfg(test)]
  let mut stats = MergeAdjacentStats::default();
  #[cfg(not(test))]
  let stats = MergeAdjacentStats::default();

  for (entity_index, entity) in entities.into_iter().enumerate() {
    if has_locked_boundary(&entity) {
      result.push(entity);
      continue;
    }

    let Some(previous_index) = last_by_label.get(&entity.label).copied() else {
      let index = result.len();
      last_by_label.insert(entity.label.clone(), index);
      result.push(entity);
      continue;
    };

    let Some(previous) = result.get(previous_index) else {
      let index = result.len();
      last_by_label.insert(entity.label.clone(), index);
      result.push(entity);
      continue;
    };

    if !has_locked_boundary(previous) && entity.start < previous.end {
      merge_into_previous(&mut result, previous_index, &entity, offsets)?;
      continue;
    }

    let gap = offsets.slice_ref(previous.end, entity.start)?;
    let gap_start = previous.end;
    let gap_end = entity.start;
    let legal_form_comma = (is_legal_form_organization(previous)
      || is_legal_form_organization(&entity))
      && gap.contains(',');

    let mergeable = !has_locked_boundary(previous)
      && !legal_form_comma
      && entity.label != "country"
      && is_mergeable_gap(gap);
    let gap_occupied = mergeable && {
      let query = occupancy_index.has_cross_label_overlap(
        entity_index,
        gap_start,
        gap_end,
      );
      #[cfg(test)]
      stats.record_query(query);
      query.occupied
    };

    if mergeable && !gap_occupied {
      merge_into_previous(&mut result, previous_index, &entity, offsets)?;
      continue;
    }

    let index = result.len();
    last_by_label.insert(entity.label.clone(), index);
    result.push(entity);
  }

  Ok((result, stats))
}

fn remove_nested_same_label(
  mut entities: Vec<PipelineEntity>,
) -> Vec<PipelineEntity> {
  entities.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| entity_len(right).cmp(&entity_len(left)))
  });

  let mut result = Vec::new();
  let mut max_end_by_label = BTreeMap::<String, u32>::new();

  for entity in entities {
    if max_end_by_label
      .get(&entity.label)
      .is_some_and(|max_end| entity.end <= *max_end)
    {
      continue;
    }
    max_end_by_label.insert(entity.label.clone(), entity.end);
    result.push(entity);
  }

  result
}

fn word_start_at(
  position: u32,
  boundaries: &BTreeSet<u32>,
  spans: &[CharSpan],
) -> u32 {
  let mut cursor = position;
  while cursor > 0 && !boundaries.contains(&cursor) {
    let index = spans.partition_point(|span| span.end <= cursor);
    if index == 0 {
      return cursor;
    }
    let Some(previous) = spans.get(index.saturating_sub(1)) else {
      return cursor;
    };
    if is_word_start_stop(previous.ch) {
      return cursor;
    }
    cursor = previous.start;
  }
  cursor
}

fn word_end_at(
  position: u32,
  boundaries: &BTreeSet<u32>,
  spans: &[CharSpan],
) -> u32 {
  let mut cursor = position;
  let text_end = spans.last().map_or(0, |span| span.end);
  while cursor < text_end && !boundaries.contains(&cursor) {
    let index = spans.partition_point(|span| span.start < cursor);
    let Some(next) = spans.get(index) else {
      return cursor;
    };
    if is_word_end_stop(next.ch) {
      return cursor;
    }
    cursor = next.end;
  }
  cursor
}

fn merge_into_previous(
  entities: &mut [PipelineEntity],
  previous_index: usize,
  entity: &PipelineEntity,
  offsets: &ByteOffsets<'_>,
) -> Result<()> {
  if let Some(previous) = entities.get_mut(previous_index) {
    previous.end = previous.end.max(entity.end);
    previous.text = offsets.slice(previous.start, previous.end)?;
    if entity.score.total_cmp(&previous.score).is_gt() {
      previous.score = entity.score;
    }
  }
  Ok(())
}

const fn has_locked_boundary(entity: &PipelineEntity) -> bool {
  is_caller_owned(entity)
}

fn has_detector_locked_boundary(entity: &PipelineEntity) -> bool {
  entity.label == crate::labels::PHONE_NUMBER_LABEL
    && entity.source == DetectionSource::Trigger
}

fn is_legal_form_organization(entity: &PipelineEntity) -> bool {
  entity.label == crate::labels::ORGANIZATION_LABEL
    && entity.source == DetectionSource::LegalForm
}

fn is_mergeable_gap(gap: &str) -> bool {
  gap.is_empty()
    || (byte_len(gap) <= 3
      && gap.chars().all(|ch| matches!(ch, ' ' | '\t' | ',' | '-')))
}

const fn is_word_start_stop(ch: char) -> bool {
  matches!(ch, '\n' | '\r' | ',' | ';' | '(' | ')' | '[' | ']' | '&')
}

const fn is_word_end_stop(ch: char) -> bool {
  matches!(
    ch,
    '\n' | '\r' | ',' | ';' | '.' | '(' | ')' | '[' | ']' | '&'
  )
}

#[cfg(test)]
mod tests {
  use proptest::prelude::*;

  use super::*;

  const SAME_LABEL_SCALING_ENTITY_COUNT: usize = 20_000;

  #[test]
  fn production_resolution_owns_its_growing_entity_buffer() {
    let boundary_source = include_str!("boundary.rs");
    let resolution_source = include_str!("../prepared/resolution_phase.rs");

    for stage in [
      "fix_partial_words",
      "truncate_person_spans",
      "resolve_cross_label_overlaps",
      "deduplicate_spans",
      "merge_adjacent",
      "remove_nested_same_label",
    ] {
      let marker = format!("fn {stage}");
      let signature_start = boundary_source.find(&marker).unwrap_or_default();
      let signature_end = signature_start
        .saturating_add(160)
        .min(boundary_source.len());
      let signature = boundary_source
        .get(signature_start..signature_end)
        .unwrap_or_default();
      assert!(
        signature.contains("Vec<PipelineEntity>"),
        "resolution stages must consume the owned entity buffer: {stage}"
      );
      assert!(!signature.contains("&[PipelineEntity]"));
    }
    assert!(
      !resolution_source.contains("].concat()"),
      "resolution must extend an owned buffer instead of concatenating clones"
    );

    let production_end = boundary_source
      .find("\n#[cfg(test)]\nmod tests {")
      .unwrap_or(boundary_source.len());
    let production = boundary_source.get(..production_end).unwrap_or_default();
    assert_eq!(
      production.matches("entities.to_vec()").count(),
      2,
      "only the public borrowed compatibility API and test reference model may clone the entity buffer"
    );
    assert!(
      production.matches("entities.sort_by").count() <= 5,
      "new full-buffer sorts require an explicit resolution complexity review"
    );
  }

  fn fix_partial_words_legacy(
    entities: &[PipelineEntity],
    offsets: &ByteOffsets<'_>,
    spans: &[CharSpan],
    boundaries: &BTreeSet<u32>,
  ) -> Result<Vec<PipelineEntity>> {
    let mut sorted = entities.to_vec();
    sorted.sort_by_key(|entity| entity.start);
    let mut fixed = Vec::with_capacity(sorted.len());

    for (index, entity) in sorted.iter().enumerate() {
      if has_locked_boundary(entity) || has_detector_locked_boundary(entity) {
        fixed.push(entity.clone());
        continue;
      }
      if entity.text != offsets.slice(entity.start, entity.end)? {
        fixed.push(entity.clone());
        continue;
      }

      let mut new_start = word_start_at(entity.start, boundaries, spans);
      let mut new_end = word_end_at(entity.end, boundaries, spans);
      for (other_index, other) in sorted.iter().enumerate() {
        if other_index == index || other.label == entity.label {
          continue;
        }
        if other.end > new_start && other.end <= entity.start {
          new_start = new_start.max(other.end);
        }
        if other.start >= entity.end && other.start < new_end {
          new_end = new_end.min(other.start);
        }
      }

      if new_start == entity.start && new_end == entity.end {
        fixed.push(entity.clone());
        continue;
      }
      let mut adjusted = entity.clone();
      adjusted.start = new_start;
      adjusted.end = new_end;
      adjusted.text = offsets.slice(new_start, new_end)?;
      fixed.push(adjusted);
    }

    Ok(fixed)
  }

  fn merge_adjacent_legacy(
    entities: &[PipelineEntity],
    offsets: &ByteOffsets<'_>,
  ) -> Result<Vec<PipelineEntity>> {
    let mut sorted = entities.to_vec();
    sorted.sort_by_key(|entity| entity.start);
    let mut result = Vec::<PipelineEntity>::new();
    let mut last_by_label = BTreeMap::<String, usize>::new();

    for entity in &sorted {
      if has_locked_boundary(entity) {
        result.push(entity.clone());
        continue;
      }
      let Some(previous_index) = last_by_label.get(&entity.label).copied()
      else {
        let index = result.len();
        result.push(entity.clone());
        last_by_label.insert(entity.label.clone(), index);
        continue;
      };
      let Some(previous) = result.get(previous_index) else {
        let index = result.len();
        result.push(entity.clone());
        last_by_label.insert(entity.label.clone(), index);
        continue;
      };
      if !has_locked_boundary(previous) && entity.start < previous.end {
        merge_into_previous(&mut result, previous_index, entity, offsets)?;
        continue;
      }

      let gap = offsets.slice(previous.end, entity.start)?;
      let gap_start = previous.end;
      let gap_end = entity.start;
      let gap_occupied = sorted.iter().any(|other| {
        other.label != entity.label
          && other.start < gap_end
          && other.end > gap_start
      });
      let legal_form_comma = (is_legal_form_organization(previous)
        || is_legal_form_organization(entity))
        && gap.contains(',');
      if !has_locked_boundary(previous)
        && !legal_form_comma
        && entity.label != "country"
        && !gap_occupied
        && is_mergeable_gap(&gap)
      {
        merge_into_previous(&mut result, previous_index, entity, offsets)?;
        continue;
      }

      let index = result.len();
      result.push(entity.clone());
      last_by_label.insert(entity.label.clone(), index);
    }

    Ok(result)
  }

  proptest! {
    #[test]
    fn indexed_partial_word_fix_matches_legacy_scan(
      full_text in "[a-zA-Z ,;.\\n']{0,128}",
      raw_entities in proptest::collection::vec(
        (any::<u16>(), any::<u16>(), 0_u8..4, any::<bool>(), 0_u8..3),
        0..128,
      ),
    ) {
      let text_len = full_text.len();
      let entities = raw_entities
        .into_iter()
        .enumerate()
        .map(|(index, (left, right, label_index, exact_text, source_index))| {
          let modulus = text_len.saturating_add(1);
          let left = usize::from(left).checked_rem(modulus).unwrap_or_default();
          let right = usize::from(right).checked_rem(modulus).unwrap_or_default();
          let start = left.min(right);
          let end = left.max(right);
          let label = match label_index {
            0 => "person",
            1 => "organization",
            2 => crate::labels::PHONE_NUMBER_LABEL,
            _ => "address",
          };
          let source = match source_index {
            0 => DetectionSource::Ner,
            1 => DetectionSource::Trigger,
            _ => DetectionSource::Caller,
          };
          let detected_text = if exact_text {
            full_text.get(start..end).unwrap_or_default()
          } else {
            "intentionally stale"
          };
          PipelineEntity::detected(
            u32::try_from(start).unwrap_or(u32::MAX),
            u32::try_from(end).unwrap_or(u32::MAX),
            label,
            detected_text,
            f64::from(u32::try_from(index).unwrap_or(u32::MAX)),
            source,
          )
        })
        .collect::<Vec<_>>();
      let offsets = ByteOffsets::new(&full_text);
      let document = ResolutionDocument::new(&full_text);
      let analysis = document.word_analysis();

      prop_assert_eq!(
        fix_partial_words(
          entities.clone(),
          &offsets,
          &analysis.spans,
          &analysis.boundaries,
        )?,
        fix_partial_words_legacy(
          &entities,
          &offsets,
          &analysis.spans,
          &analysis.boundaries,
        )?,
      );
    }

    #[test]
    fn indexed_adjacent_merge_matches_legacy_scan(
      characters in proptest::collection::vec(
        prop_oneof![
          Just('a'), Just('Z'), Just(' '), Just('\t'), Just(','), Just('-'),
          Just('.'), Just('\n'), Just('é'), Just('東'), Just('🙂'),
          Just('\u{0301}'), Just('\u{00a0}'),
        ],
        0..96,
      ),
      raw_entities in proptest::collection::vec(
        (any::<u16>(), any::<u16>(), 0_u8..5, 0_u8..4),
        0..128,
      ),
    ) {
      let full_text = characters.into_iter().collect::<String>();
      let mut boundaries = full_text
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
      boundaries.push(full_text.len());
      let entities = raw_entities
        .into_iter()
        .enumerate()
        .map(|(index, (left, right, label_index, source_index))| {
          let left_index = usize::from(left)
            .checked_rem(boundaries.len())
            .unwrap_or_default();
          let right_index = usize::from(right)
            .checked_rem(boundaries.len())
            .unwrap_or_default();
          let start = boundaries.get(left_index).copied().unwrap_or_default();
          let end = boundaries.get(right_index).copied().unwrap_or_default();
          let label = match label_index {
            0 => "person",
            1 => crate::labels::ORGANIZATION_LABEL,
            2 => "address",
            3 => "country",
            _ => crate::labels::PHONE_NUMBER_LABEL,
          };
          let source = match source_index {
            0 => DetectionSource::Ner,
            1 => DetectionSource::LegalForm,
            2 => DetectionSource::Caller,
            _ => DetectionSource::Trigger,
          };
          let detected_text = full_text
            .get(start..end)
            .unwrap_or("malformed span");
          PipelineEntity::detected(
            u32::try_from(start).unwrap_or(u32::MAX),
            u32::try_from(end).unwrap_or(u32::MAX),
            label,
            detected_text,
            f64::from(u32::try_from(index).unwrap_or(u32::MAX)),
            source,
          )
        })
        .collect::<Vec<_>>();
      let offsets = ByteOffsets::new(&full_text);

      prop_assert_eq!(
        merge_adjacent(entities.clone(), &offsets),
        merge_adjacent_legacy(&entities, &offsets),
      );
    }

    #[test]
    fn indexed_cross_label_overlap_matches_legacy_scan(
      characters in proptest::collection::vec(
        prop_oneof![Just('a'), Just(' '), Just('é'), Just('東'), Just('🙂')],
        0..96,
      ),
      raw_entities in proptest::collection::vec(
        (any::<u16>(), any::<u16>(), 0_u8..4, 0_u8..4, 0_u8..5),
        0..128,
      ),
    ) {
      let full_text = characters.into_iter().collect::<String>();
      let mut boundaries = full_text
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
      boundaries.push(full_text.len());
      let entities = raw_entities
        .into_iter()
        .map(|(raw_left, raw_right, label_index, source_index, score_index)| {
          let left_index = usize::from(raw_left)
            .checked_rem(boundaries.len())
            .unwrap_or_default();
          let right_index = usize::from(raw_right)
            .checked_rem(boundaries.len())
            .unwrap_or_default();
          let left = boundaries.get(left_index).copied().unwrap_or_default();
          let right = boundaries.get(right_index).copied().unwrap_or_default();
          let start = left.min(right);
          let end = left.max(right);
          let label = match label_index {
            0 => "person",
            1 => crate::labels::ORGANIZATION_LABEL,
            2 => "address",
            _ => crate::labels::PHONE_NUMBER_LABEL,
          };
          let source = match source_index {
            0 => DetectionSource::Ner,
            1 => DetectionSource::Trigger,
            2 => DetectionSource::Caller,
            _ => DetectionSource::Regex,
          };
          PipelineEntity::detected(
            u32::try_from(start).unwrap_or(u32::MAX),
            u32::try_from(end).unwrap_or(u32::MAX),
            label,
            full_text.get(start..end).unwrap_or_default(),
            f64::from(score_index) / 4.0,
            source,
          )
        })
        .collect::<Vec<_>>();
      let offsets = ByteOffsets::new(&full_text);

      prop_assert_eq!(
        resolve_cross_label_overlaps_with_stats(entities.clone(), &offsets)
          .map(|(resolved, _)| resolved),
        resolve_cross_label_overlaps_linear(&entities, &offsets),
      );
    }
  }

  #[test]
  #[ignore = "release-mode scaling regression check"]
  fn cross_label_overlap_containment_scaling_is_bounded() -> Result<()> {
    let full_text = "x".repeat(SAME_LABEL_SCALING_ENTITY_COUNT + 1);
    let entities = (0..SAME_LABEL_SCALING_ENTITY_COUNT)
      .map(|index| {
        PipelineEntity::detected(
          0,
          u32::try_from(index.saturating_add(1)).unwrap_or(u32::MAX),
          if index % 2 == 0 { "person" } else { "address" },
          "x",
          0.9,
          DetectionSource::Ner,
        )
      })
      .collect::<Vec<_>>();
    let offsets = ByteOffsets::new(&full_text);
    let (resolved, stats) =
      resolve_cross_label_overlaps_with_stats(entities.clone(), &offsets)?;

    assert_eq!(resolved, entities);
    assert_eq!(stats.start_updates, 0);
    let expected_searches = SAME_LABEL_SCALING_ENTITY_COUNT.saturating_mul(2);
    assert_eq!(stats.searches, expected_searches);
    assert_eq!(stats.node_visits, expected_searches);

    Ok(())
  }

  #[test]
  #[ignore = "release-mode scaling regression check"]
  fn fix_partial_words_same_label_scaling_is_bounded() -> Result<()> {
    let full_text = "word";
    let offsets = ByteOffsets::new(full_text);
    let document = ResolutionDocument::new(full_text);
    let analysis = document.word_analysis();
    let entities = (0..SAME_LABEL_SCALING_ENTITY_COUNT)
      .map(|index| {
        let start = u32::try_from(index % 4).unwrap_or(u32::MAX);
        PipelineEntity::detected(
          start,
          start.saturating_add(1),
          "person",
          full_text.get(index % 4..index % 4 + 1).unwrap_or_default(),
          0.9,
          DetectionSource::Ner,
        )
      })
      .collect::<Vec<_>>();

    let (fixed, stats) = fix_partial_words_with_stats(
      entities,
      &offsets,
      &analysis.spans,
      &analysis.boundaries,
    )?;

    assert_eq!(fixed.len(), SAME_LABEL_SCALING_ENTITY_COUNT);
    assert!(
      fixed.iter().all(|entity| {
        entity.start == 0
          && entity.end == 4
          && entity.text == "word"
          && entity.label == "person"
          && entity.source == DetectionSource::Ner
          && entity.score.to_bits() == 0.9_f64.to_bits()
      }),
      "indexed resolution must retain all entity invariants"
    );
    assert!(
      stats.index_node_visits
        <= SAME_LABEL_SCALING_ENTITY_COUNT.saturating_mul(2),
      "same-label searches visited {} index nodes for {} entities",
      stats.index_node_visits,
      SAME_LABEL_SCALING_ENTITY_COUNT,
    );
    Ok(())
  }

  #[test]
  #[ignore = "release-mode scaling regression check"]
  fn merge_adjacent_same_label_scaling_is_bounded() -> Result<()> {
    let fixture = "MA 02101-1234.\n\n";
    let full_text = fixture.repeat(SAME_LABEL_SCALING_ENTITY_COUNT);
    let entities = (0..SAME_LABEL_SCALING_ENTITY_COUNT)
      .map(|index| {
        let start = index.saturating_mul(fixture.len());
        PipelineEntity::detected(
          u32::try_from(start).unwrap_or(u32::MAX),
          u32::try_from(start.saturating_add(13)).unwrap_or(u32::MAX),
          "address",
          "MA 02101-1234",
          0.9,
          DetectionSource::Ner,
        )
      })
      .collect::<Vec<_>>();
    let offsets = ByteOffsets::new(&full_text);
    let (separated, separated_stats) =
      merge_adjacent_with_stats(entities.clone(), &offsets)?;

    assert_eq!(separated, entities);
    assert_eq!(separated_stats.gap_queries, 0);
    assert_eq!(separated_stats.activated_entities, 0);

    let mergeable_text = "A ".repeat(SAME_LABEL_SCALING_ENTITY_COUNT);
    let mergeable_entities = (0..SAME_LABEL_SCALING_ENTITY_COUNT)
      .map(|index| {
        let start = index.saturating_mul(2);
        PipelineEntity::detected(
          u32::try_from(start).unwrap_or(u32::MAX),
          u32::try_from(start.saturating_add(1)).unwrap_or(u32::MAX),
          "person",
          "A",
          0.9,
          DetectionSource::Ner,
        )
      })
      .collect::<Vec<_>>();
    let mergeable_offsets = ByteOffsets::new(&mergeable_text);
    let (merged, merged_stats) =
      merge_adjacent_with_stats(mergeable_entities, &mergeable_offsets)?;

    assert_eq!(merged.len(), 1);
    let only = merged
      .first()
      .ok_or(crate::types::Error::InvalidSpan { start: 0, end: 0 })?;
    assert_eq!(only.start, 0);
    assert_eq!(
      only.end,
      u32::try_from(mergeable_text.len().saturating_sub(1)).unwrap_or(u32::MAX)
    );
    assert_eq!(only.label, "person");
    assert!(
      merged_stats.gap_queries < SAME_LABEL_SCALING_ENTITY_COUNT,
      "one gap query per later entity is the linear upper bound"
    );
    assert!(
      merged_stats.activated_entities < SAME_LABEL_SCALING_ENTITY_COUNT,
      "each interval may be activated at most once"
    );
    Ok(())
  }
}
