use std::collections::BTreeMap;

use crate::resolution::{PipelineEntity, SourceDetail};
use crate::search::{
  LiteralSearchOptions, SearchIndex, SearchOptions, SearchPattern,
};
use crate::span_index::SpanIndex;
use crate::types::{Error, Result, SearchMatch};

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct HotwordRuleData {
  pub rules: Vec<HotwordRule>,
  #[serde(default)]
  pub pattern_rule_indices: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct HotwordRule {
  #[serde(default)]
  pub hotwords: Vec<String>,
  pub target_labels: Vec<String>,
  pub score_adjustment: f64,
  pub reclassify_to: Option<String>,
  pub proximity_before: u32,
  pub proximity_after: u32,
}

pub(crate) struct PreparedHotwordData {
  rules: Vec<HotwordRule>,
  rule_indices_by_target_label: BTreeMap<String, Vec<usize>>,
  pattern_rule_indices: Vec<u32>,
  search: SearchIndex,
}

impl PreparedHotwordData {
  pub(crate) fn new(data: HotwordRuleData) -> Result<Self> {
    let mut patterns = Vec::new();
    let mut pattern_rule_indices = Vec::new();
    let mut rule_indices_by_target_label = BTreeMap::new();

    for (rule_index, rule) in data.rules.iter().enumerate() {
      for target_label in &rule.target_labels {
        let rule_indices = rule_indices_by_target_label
          .entry(target_label.clone())
          .or_insert_with(Vec::new);
        if rule_indices.last().copied() != Some(rule_index) {
          rule_indices.push(rule_index);
        }
      }
      let rule_index =
        u32::try_from(rule_index).map_err(|_| Error::InvalidStaticData {
          field: "hotword_data.rules",
          reason: String::from("rule index exceeds u32 range"),
        })?;
      for hotword in &rule.hotwords {
        if hotword.is_empty() {
          return Err(Error::InvalidStaticData {
            field: "hotword_data.rules.hotwords",
            reason: String::from("hotword must not be empty"),
          });
        }
        patterns.push(SearchPattern::LiteralWithOptions {
          pattern: hotword.clone(),
          case_insensitive: Some(true),
          whole_words: Some(true),
        });
        pattern_rule_indices.push(rule_index);
      }
    }

    let search = SearchIndex::new(
      patterns,
      SearchOptions {
        literal: LiteralSearchOptions {
          case_insensitive: true,
          whole_words: true,
        },
        ..SearchOptions::default()
      },
    )?;

    Ok(Self {
      rules: data.rules,
      rule_indices_by_target_label,
      pattern_rule_indices,
      search,
    })
  }
}

pub(crate) fn apply_hotword_rules(
  entities: Vec<PipelineEntity>,
  full_text: &str,
  data: &PreparedHotwordData,
  allowed_labels: &[String],
) -> Result<Vec<PipelineEntity>> {
  let hits_by_rule = collect_hits_by_rule(full_text, data)?;
  let text_offsets = Utf16OffsetMap::new(full_text)?;
  let mut result = Vec::with_capacity(entities.len());

  for entity in entities {
    if caller_owned(&entity) {
      result.push(entity);
      continue;
    }

    let adjusted =
      apply_entity_rules(entity, &text_offsets, data, &hits_by_rule)?;
    if label_allowed(&adjusted.label, allowed_labels) {
      result.push(adjusted);
    }
  }

  Ok(result)
}

fn collect_hits_by_rule(
  full_text: &str,
  data: &PreparedHotwordData,
) -> Result<Vec<SpanIndex<SearchMatch>>> {
  let mut hits_by_rule = vec![Vec::new(); data.rules.len()];

  for found in data.search.find_iter(full_text)? {
    let Ok(local_index) = usize::try_from(found.pattern()) else {
      return Err(Error::InvalidStaticData {
        field: "hotword_data.pattern_rule_indices",
        reason: String::from("pattern index exceeds usize range"),
      });
    };
    let Some(rule_index) = data.pattern_rule_indices.get(local_index) else {
      continue;
    };
    let Ok(rule_index) = usize::try_from(*rule_index) else {
      return Err(Error::InvalidStaticData {
        field: "hotword_data.pattern_rule_indices",
        reason: String::from("rule index exceeds usize range"),
      });
    };
    let Some(bucket) = hits_by_rule.get_mut(rule_index) else {
      return Err(Error::InvalidStaticData {
        field: "hotword_data.pattern_rule_indices",
        reason: String::from("rule index out of range"),
      });
    };
    bucket.push(found);
  }

  Ok(
    hits_by_rule
      .into_iter()
      .map(|hits| {
        SpanIndex::new(
          hits.into_iter().map(|hit| (hit.start(), hit.end(), hit)),
        )
      })
      .collect(),
  )
}

fn apply_entity_rules(
  mut entity: PipelineEntity,
  text_offsets: &Utf16OffsetMap,
  data: &PreparedHotwordData,
  hits_by_rule: &[SpanIndex<SearchMatch>],
) -> Result<PipelineEntity> {
  let mut best = None::<HotwordAdjustment>;

  let Some(rule_indices) = data.rule_indices_by_target_label.get(&entity.label)
  else {
    return Ok(entity);
  };
  for rule_index in rule_indices {
    let Some(rule) = data.rules.get(*rule_index) else {
      continue;
    };
    let Some(rule_hits) = hits_by_rule.get(*rule_index) else {
      continue;
    };
    let window_start =
      text_offsets.offset_before_units(entity.start, rule.proximity_before)?;
    let window_end =
      text_offsets.offset_after_units(entity.end, rule.proximity_after)?;
    rule_hits.try_for_each_intersecting(window_start, window_end, |hit| {
      let Some((distance, max_distance)) =
        hotword_distance(text_offsets, &entity, hit, rule)?
      else {
        return Ok(());
      };
      let decay = if max_distance == 0 {
        1.0
      } else {
        1.0 - (f64::from(distance) / f64::from(max_distance))
      };
      let adjustment = rule.score_adjustment * decay;
      if adjustment.abs() <= f64::EPSILON {
        return Ok(());
      }
      if best
        .as_ref()
        .is_some_and(|best| adjustment.abs() <= best.score.abs())
      {
        return Ok(());
      }

      best = Some(HotwordAdjustment {
        score: adjustment,
        reclassify_to: if adjustment.is_sign_positive() {
          rule.reclassify_to.clone()
        } else {
          None
        },
      });
      Ok(())
    })?;
  }

  let Some(best) = best else {
    return Ok(entity);
  };

  entity.score = (entity.score + best.score).clamp(0.0, 1.0);
  if let Some(label) = best.reclassify_to {
    entity.label = label;
  }
  Ok(entity)
}

fn hotword_distance(
  text_offsets: &Utf16OffsetMap,
  entity: &PipelineEntity,
  hit: &SearchMatch,
  rule: &HotwordRule,
) -> Result<Option<(u32, u32)>> {
  let (distance, max_distance) = if hit.end() <= entity.start {
    (
      text_offsets.distance_between(hit.end(), entity.start)?,
      rule.proximity_before,
    )
  } else if hit.start() >= entity.end {
    (
      text_offsets.distance_between(entity.end, hit.start())?,
      rule.proximity_after,
    )
  } else {
    (0, u32::max(rule.proximity_before, rule.proximity_after))
  };

  if distance > max_distance {
    return Ok(None);
  }
  Ok(Some((distance, max_distance)))
}

const fn caller_owned(entity: &PipelineEntity) -> bool {
  matches!(
    entity.source_detail,
    Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
  )
}

fn label_allowed(label: &str, allowed_labels: &[String]) -> bool {
  allowed_labels.is_empty()
    || allowed_labels.iter().any(|allowed| allowed == label)
}

struct HotwordAdjustment {
  score: f64,
  reclassify_to: Option<String>,
}

struct Utf16OffsetMap {
  byte_offsets: Vec<usize>,
  utf16_offsets: Vec<u32>,
}

impl Utf16OffsetMap {
  fn new(full_text: &str) -> Result<Self> {
    let mut byte_offsets = Vec::new();
    let mut utf16_offsets = Vec::new();
    let mut utf16_offset = 0_u32;

    for (byte_offset, character) in full_text.char_indices() {
      byte_offsets.push(byte_offset);
      utf16_offsets.push(utf16_offset);
      let width = u32::try_from(character.len_utf16())
        .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })?;
      utf16_offset = utf16_offset
        .checked_add(width)
        .ok_or(Error::ByteOffsetOutOfBounds { offset: u32::MAX })?;
    }

    byte_offsets.push(full_text.len());
    utf16_offsets.push(utf16_offset);

    Ok(Self {
      byte_offsets,
      utf16_offsets,
    })
  }

  fn distance_between(&self, start: u32, end: u32) -> Result<u32> {
    if start > end {
      return Err(Error::InvalidSpan { start, end });
    }
    let start_units = self.utf16_units_at(start)?;
    let end_units = self.utf16_units_at(end)?;
    Ok(end_units.saturating_sub(start_units))
  }

  fn offset_before_units(&self, offset: u32, units: u32) -> Result<u32> {
    let offset_units = self.utf16_units_at(offset)?;
    let minimum_units = offset_units.saturating_sub(units);
    let index = self
      .utf16_offsets
      .partition_point(|candidate| *candidate < minimum_units);
    self.byte_offset_at(index)
  }

  fn offset_after_units(&self, offset: u32, units: u32) -> Result<u32> {
    let offset_units = self.utf16_units_at(offset)?;
    let maximum_units = offset_units.saturating_add(units);
    let boundary = self
      .utf16_offsets
      .partition_point(|candidate| *candidate <= maximum_units);
    self.byte_offset_at(boundary.saturating_sub(1))
  }

  fn byte_offset_at(&self, index: usize) -> Result<u32> {
    let byte_offset = self
      .byte_offsets
      .get(index)
      .copied()
      .ok_or(Error::ByteOffsetOutOfBounds { offset: u32::MAX })?;
    u32::try_from(byte_offset)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })
  }

  fn utf16_units_at(&self, offset: u32) -> Result<u32> {
    let byte_offset = usize::try_from(offset)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset })?;
    let max_offset = self.byte_offsets.last().copied().unwrap_or(0);
    if byte_offset > max_offset {
      return Err(Error::ByteOffsetOutOfBounds { offset });
    }

    let index = self
      .byte_offsets
      .binary_search(&byte_offset)
      .map_err(|_| Error::ByteOffsetInsideCodepoint { offset })?;
    self
      .utf16_offsets
      .get(index)
      .copied()
      .ok_or(Error::ByteOffsetOutOfBounds { offset: u32::MAX })
  }
}

#[cfg(test)]
mod tests {
  use proptest::prelude::*;

  use super::*;
  use crate::byte_offsets::ByteOffsets;
  use crate::resolution::DetectionSource;

  #[test]
  fn utf16_offset_map_matches_slice_distance_on_boundaries() -> Result<()> {
    let text = "A😀áZ";
    let map = Utf16OffsetMap::new(text)?;
    let offsets = ByteOffsets::new(text);
    let mut boundaries = text
      .char_indices()
      .map(|(offset, _)| offset)
      .collect::<Vec<_>>();
    boundaries.push(text.len());

    for start in &boundaries {
      for end in &boundaries {
        if start > end {
          continue;
        }
        let start_offset = u32::try_from(*start)
          .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })?;
        let end_offset = u32::try_from(*end)
          .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })?;

        assert_eq!(
          map.distance_between(start_offset, end_offset)?,
          offsets.utf16_units_between(start_offset, end_offset)?
        );
      }
    }

    Ok(())
  }

  proptest! {
    #[test]
    fn indexed_hotword_rules_match_linear_reference(
      spans in proptest::collection::vec((0_u16..512, 0_u16..32, 0_u16..1000), 0..256),
    ) {
      let full_text = "risk filler client filler ".repeat(24);
      let data = PreparedHotwordData::new(HotwordRuleData {
        rules: vec![
          HotwordRule {
            hotwords: vec![String::from("risk")],
            target_labels: vec![String::from("person")],
            score_adjustment: 0.4,
            reclassify_to: Some(String::from("organization")),
            proximity_before: 40,
            proximity_after: 15,
          },
          HotwordRule {
            hotwords: vec![String::from("client")],
            target_labels: vec![String::from("person")],
            score_adjustment: -0.3,
            reclassify_to: None,
            proximity_before: 12,
            proximity_after: 35,
          },
        ],
        pattern_rule_indices: Vec::new(),
      })?;
      let entities = spans.into_iter().map(|(start, width, score)| {
        let start = u32::from(start).min(
          u32::try_from(full_text.len()).unwrap_or(u32::MAX).saturating_sub(1),
        );
        let end = start
          .saturating_add(u32::from(width).saturating_add(1))
          .min(u32::try_from(full_text.len()).unwrap_or(u32::MAX));
        PipelineEntity::detected(
          start,
          end,
          "person",
          full_text
            .get(
              usize::try_from(start).unwrap_or_default()
                ..usize::try_from(end).unwrap_or_default(),
            )
            .unwrap_or_default(),
          f64::from(score) / 1000.0,
          DetectionSource::Regex,
        )
      }).collect::<Vec<_>>();

      let indexed = apply_hotword_rules(
        entities.clone(),
        &full_text,
        &data,
        &[],
      )?;
      let linear = apply_hotword_rules_linear(entities, &full_text, &data)?;
      prop_assert_eq!(indexed, linear);
    }
  }

  #[test]
  fn hotword_query_visits_only_hits_intersecting_the_proximity_window()
  -> Result<()> {
    let index = SpanIndex::new((0_u32..10_000).map(|start| {
      let offset = start.saturating_mul(10);
      (offset, offset.saturating_add(4), offset)
    }));
    let mut visited = Vec::new();
    index.try_for_each_intersecting(50_000, 50_020, |offset| {
      visited.push(*offset);
      Ok::<_, Error>(())
    })?;

    assert_eq!(visited, vec![50_000, 50_010, 50_020]);
    assert!(
      index.intersecting_query_work(50_000, 50_020) < 128,
      "a narrow hotword query must traverse the index, not all 10,000 spans",
    );
    Ok(())
  }

  fn apply_hotword_rules_linear(
    entities: Vec<PipelineEntity>,
    full_text: &str,
    data: &PreparedHotwordData,
  ) -> Result<Vec<PipelineEntity>> {
    let mut hits_by_rule = vec![Vec::new(); data.rules.len()];
    for found in data.search.find_iter(full_text)? {
      let pattern = usize::try_from(found.pattern()).unwrap_or(usize::MAX);
      let rule_index = data
        .pattern_rule_indices
        .get(pattern)
        .and_then(|index| usize::try_from(*index).ok())
        .unwrap_or(usize::MAX);
      if let Some(hits) = hits_by_rule.get_mut(rule_index) {
        hits.push(found);
      }
    }
    let offsets = Utf16OffsetMap::new(full_text)?;
    entities
      .into_iter()
      .map(|entity| {
        let mut best = None::<HotwordAdjustment>;
        for (rule_index, rule) in data.rules.iter().enumerate() {
          if !rule
            .target_labels
            .iter()
            .any(|label| label == &entity.label)
          {
            continue;
          }
          for hit in hits_by_rule.get(rule_index).into_iter().flatten() {
            let Some((distance, max_distance)) =
              hotword_distance(&offsets, &entity, hit, rule)?
            else {
              continue;
            };
            let decay = if max_distance == 0 {
              1.0
            } else {
              1.0 - (f64::from(distance) / f64::from(max_distance))
            };
            let adjustment = rule.score_adjustment * decay;
            if adjustment.abs() <= f64::EPSILON
              || best
                .as_ref()
                .is_some_and(|best| adjustment.abs() <= best.score.abs())
            {
              continue;
            }
            best = Some(HotwordAdjustment {
              score: adjustment,
              reclassify_to: if adjustment.is_sign_positive() {
                rule.reclassify_to.clone()
              } else {
                None
              },
            });
          }
        }
        let Some(best) = best else {
          return Ok(entity);
        };
        let mut adjusted = entity;
        adjusted.score = (adjusted.score + best.score).clamp(0.0, 1.0);
        if let Some(label) = best.reclassify_to {
          adjusted.label = label;
        }
        Ok(adjusted)
      })
      .collect()
  }
}
