use crate::byte_offsets::ByteOffsets;
use crate::resolution::{PipelineEntity, SourceDetail};
use crate::types::{Error, Result};

const NEAR_MISS_BAND: f64 = 0.15;
const BOOST_PER_NEIGHBOUR: f64 = 0.05;
const CONTEXT_WINDOW_CHARS: f64 = 150.0;
const HIGH_CONFIDENCE_FLOOR: f64 = 0.9;

pub(super) fn filter_entities_for_config(
  entities: Vec<PipelineEntity>,
  threshold: f64,
  allowed_labels: &[String],
) -> Vec<PipelineEntity> {
  filter_entities_for_threshold(
    filter_entities_for_labels(entities, allowed_labels),
    threshold,
  )
}

#[derive(Clone, Copy)]
pub(super) struct RedactionFilterOptions<'a> {
  pub(super) full_text: &'a str,
  pub(super) threshold: f64,
  pub(super) confidence_boost: bool,
  pub(super) allowed_labels: &'a [String],
  pub(super) boost_anchor_labels: &'a [String],
}

pub(super) fn filter_entities_for_redaction(
  entities: Vec<PipelineEntity>,
  options: RedactionFilterOptions<'_>,
) -> Result<Vec<PipelineEntity>> {
  let entities = filter_entities_for_labels(entities, options.allowed_labels);
  if options.confidence_boost {
    return boost_near_miss_entities(
      entities,
      options.full_text,
      options.threshold,
      options.boost_anchor_labels,
    );
  }
  Ok(filter_entities_for_threshold(entities, options.threshold))
}

pub(super) fn filter_entities_for_labels(
  entities: Vec<PipelineEntity>,
  allowed_labels: &[String],
) -> Vec<PipelineEntity> {
  entities
    .into_iter()
    .filter(|entity| {
      allowed_labels.is_empty()
        || allowed_labels.iter().any(|label| label == &entity.label)
    })
    .collect()
}

pub(super) fn label_is_allowed(label: &str, allowed_labels: &[String]) -> bool {
  allowed_labels.is_empty()
    || allowed_labels.iter().any(|allowed| allowed == label)
}

pub(super) fn clear_internal_source_details(entities: &mut [PipelineEntity]) {
  for entity in entities {
    if entity.source_detail == Some(SourceDetail::AddressContext) {
      entity.source_detail = None;
    }
  }
}

fn filter_entities_for_threshold(
  entities: Vec<PipelineEntity>,
  threshold: f64,
) -> Vec<PipelineEntity> {
  entities
    .into_iter()
    .filter(|entity| {
      entity.score >= threshold
        || entity.source_detail == Some(SourceDetail::AddressContext)
    })
    .collect()
}

fn boost_near_miss_entities(
  entities: Vec<PipelineEntity>,
  full_text: &str,
  threshold: f64,
  anchor_labels: &[String],
) -> Result<Vec<PipelineEntity>> {
  let near_miss_floor = f64::max(0.0, threshold - NEAR_MISS_BAND);
  let byte_offsets = ByteOffsets::new(full_text);
  let text_offsets = TextOffsetMap::new(full_text);
  let anchors = entities
    .iter()
    .filter(|entity| {
      entity.score >= HIGH_CONFIDENCE_FLOOR
        && label_is_allowed(&entity.label, anchor_labels)
    })
    .map(|entity| entity_midpoint(entity, &byte_offsets, &text_offsets))
    .collect::<Result<Vec<_>>>()?;

  let mut boosted = Vec::with_capacity(entities.len());
  for mut entity in entities {
    if entity.score >= threshold {
      boosted.push(entity);
      continue;
    }
    if entity.score < near_miss_floor {
      continue;
    }

    let midpoint = entity_midpoint(&entity, &byte_offsets, &text_offsets)?;
    let neighbours = anchors
      .iter()
      .filter(|anchor| (midpoint - **anchor).abs() <= CONTEXT_WINDOW_CHARS)
      .count();
    let neighbour_count = u32::try_from(neighbours).unwrap_or(u32::MAX);
    let boosted_score =
      f64::from(neighbour_count).mul_add(BOOST_PER_NEIGHBOUR, entity.score);
    if boosted_score < threshold {
      continue;
    }

    entity.score = f64::min(1.0, boosted_score);
    boosted.push(entity);
  }

  Ok(boosted)
}

fn entity_midpoint(
  entity: &PipelineEntity,
  byte_offsets: &ByteOffsets<'_>,
  text_offsets: &TextOffsetMap,
) -> Result<f64> {
  let start = text_offsets.offset_for(byte_offsets, entity.start)?;
  let end = text_offsets.offset_for(byte_offsets, entity.end)?;
  Ok(f64::midpoint(start, end))
}

/// A character boundary paired with the cumulative UTF-16 code-unit offset at
/// that boundary. The public offset space (matching the TypeScript pipeline and
/// its entity offsets) counts UTF-16 code units, so the near-miss window must be
/// measured in the same units: a non-BMP character (emoji, astral CJK) counts as
/// two units, not one scalar value.
struct TextBoundary {
  byte_offset: usize,
  utf16_offset: u32,
}

struct TextOffsetMap {
  boundaries: Vec<TextBoundary>,
}

impl TextOffsetMap {
  fn new(full_text: &str) -> Self {
    let mut boundaries = Vec::with_capacity(full_text.len().saturating_add(1));
    let mut utf16_offset = 0_u32;
    for (byte_offset, ch) in full_text.char_indices() {
      boundaries.push(TextBoundary {
        byte_offset,
        utf16_offset,
      });
      let width = u32::try_from(ch.len_utf16()).unwrap_or(u32::MAX);
      utf16_offset = utf16_offset.saturating_add(width);
    }
    boundaries.push(TextBoundary {
      byte_offset: full_text.len(),
      utf16_offset,
    });
    Self { boundaries }
  }

  fn offset_for(
    &self,
    byte_offsets: &ByteOffsets<'_>,
    offset: u32,
  ) -> Result<f64> {
    let byte_offset = byte_offsets.validate_offset(offset)?;
    let index = self
      .boundaries
      .binary_search_by_key(&byte_offset, |boundary| boundary.byte_offset)
      .map_err(|_| Error::ByteOffsetInsideCodepoint { offset })?;
    let utf16_offset = self
      .boundaries
      .get(index)
      .ok_or(Error::ByteOffsetOutOfBounds { offset })?
      .utf16_offset;
    Ok(f64::from(utf16_offset))
  }
}

#[cfg(test)]
mod tests {
  use super::boost_near_miss_entities;
  use crate::resolution::{DetectionSource, PipelineEntity};

  /// The near-miss confidence window must be measured in UTF-16 code units (the
  /// public offset space, matching the TypeScript `boostNearMissEntities`), not
  /// in Unicode scalar values. With non-BMP characters between a high-confidence
  /// anchor and a near-miss entity, scalar counting undercounts the distance:
  /// each emoji is one scalar but two UTF-16 units. This entity sits inside the
  /// 150-unit window when counting scalars but outside it when counting UTF-16
  /// units, so scalar counting would wrongly boost and redact it.
  #[test]
  fn boost_window_measures_utf16_units_not_scalars() {
    // "AAAA" + 100 emoji + "BBBB". Each emoji is 1 scalar, 2 UTF-16 units,
    // 4 UTF-8 bytes. Anchor midpoint is 2 in both spaces. Near-miss midpoint is
    // 6 + 100 = 106 scalars (inside the 150 window) but 6 + 200 = 206 UTF-16
    // units (outside it), so the two measures disagree about the window.
    let full_text = format!("AAAA{}BBBB", "\u{1F600}".repeat(100));

    // "BBBB" is the four trailing ASCII bytes of the text.
    let near_miss_start =
      u32::try_from(full_text.len().saturating_sub(4)).unwrap_or(u32::MAX);
    let entities = vec![
      // High-confidence anchor at the very start.
      PipelineEntity::detected(
        0,
        4,
        "person",
        "AAAA",
        0.95,
        DetectionSource::Ner,
      ),
      // Near-miss: 0.82 is within [threshold - 0.15, threshold) for threshold
      // 0.85. One neighbour would lift it to 0.87 (>= threshold); zero
      // neighbours leaves it at 0.82 (< threshold) and it is dropped.
      PipelineEntity::detected(
        near_miss_start,
        near_miss_start.saturating_add(4),
        "person",
        "BBBB",
        0.82,
        DetectionSource::Ner,
      ),
    ];

    let boosted = boost_near_miss_entities(entities, &full_text, 0.85, &[]);
    assert!(boosted.is_ok(), "boost should not error on valid offsets");

    // UTF-16 (TS parity): the near-miss is outside the window, gets no boost,
    // and is dropped. Only the anchor survives. Scalar counting would keep both.
    let texts = boosted
      .unwrap_or_default()
      .iter()
      .map(|entity| entity.text.clone())
      .collect::<Vec<_>>();
    assert_eq!(
      texts,
      vec!["AAAA"],
      "near-miss must be dropped in UTF-16 space"
    );
  }

  #[test]
  fn excluded_labels_do_not_anchor_confidence_boosts() {
    let entities = vec![
      PipelineEntity::detected(
        0,
        4,
        "person",
        "AAAA",
        0.95,
        DetectionSource::Ner,
      ),
      PipelineEntity::detected(
        5,
        9,
        "address",
        "BBBB",
        0.82,
        DetectionSource::Regex,
      ),
    ];
    let boosted = boost_near_miss_entities(
      entities,
      "AAAA BBBB",
      0.85,
      &[String::from("address")],
    );

    assert!(boosted.is_ok(), "boost should not error on valid offsets");
    let boosted = boosted.unwrap_or_default();
    assert_eq!(boosted.len(), 1);
    assert_eq!(
      boosted.first().map(|entity| entity.label.as_str()),
      Some("person")
    );
  }
}
