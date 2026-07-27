#![allow(
  clippy::arithmetic_side_effects,
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::panic,
  clippy::unwrap_used
)]

use std::collections::BTreeMap;

use proptest::prelude::{Just, ProptestConfig, Strategy, any};
use proptest::{
  collection, prop_assert, prop_assert_eq, prop_assume, proptest, sample,
};
use stella_anonymize_core::{
  DetectionSource, Entity, Error, LiteralSearchOptions, OperatorConfig,
  PipelineEntity, RedactionReplacement, RegexSearchOptions, SearchIndex,
  SearchIndexArtifacts, SearchMatch, SearchOptions, SearchPattern, deanonymise,
  merge_and_dedup, normalize_for_search, redact_text, sanitize_entities,
};

const PROPERTY_CASES: u32 = 128;

/// Width and punctuation variants that `normalize_for_search` folds to an ASCII
/// representative. Kept in sync with the `replacement_char` match arms.
const FOLDED_CHARS: [char; 7] = [
  '\u{00a0}', '\u{2007}', '\u{202f}', // -> ' '
  '\u{2013}', '\u{2014}', // -> '-'
  '\u{201c}', '\u{201d}', // -> '"'
];

fn byte_len(text: &str) -> u32 {
  u32::try_from(text.len()).unwrap_or(u32::MAX)
}

fn text_char() -> impl Strategy<Value = char> {
  sample::select(vec![
    'a', 'b', 'Z', '0', '9', ' ', '-', '.', ',', ':', '\u{00a0}', 'á', 'ř',
    '界', '🦀', '\u{0301}',
  ])
}

fn search_char() -> impl Strategy<Value = char> {
  sample::select(vec!['a', 'b', 'Z', '0', '9', 'á', 'ř', '界', '🦀'])
}

fn text_fragment(max_len: usize) -> impl Strategy<Value = String> {
  collection::vec(text_char(), 0..max_len)
    .prop_map(|chars| chars.into_iter().collect())
}

fn entity_text() -> impl Strategy<Value = String> {
  collection::vec(search_char(), 1..8)
    .prop_map(|chars| chars.into_iter().collect())
}

fn fuzzy_text() -> impl Strategy<Value = String> {
  collection::vec(search_char(), 2..8)
    .prop_map(|chars| chars.into_iter().collect())
}

fn trim_text() -> impl Strategy<Value = String> {
  collection::vec(
    sample::select(vec![
      ' ', '\t', '\n', ',', ';', ':', '"', '\'', '“', '”', '‘', '’', '«', '»',
      '!', '?',
    ]),
    0..6,
  )
  .prop_map(|chars| chars.into_iter().collect())
}

fn source_strategy() -> impl Strategy<Value = DetectionSource> {
  sample::select(vec![
    DetectionSource::Caller,
    DetectionSource::Trigger,
    DetectionSource::Regex,
    DetectionSource::DenyList,
    DetectionSource::LegalForm,
    DetectionSource::Gazetteer,
    DetectionSource::Country,
    DetectionSource::Ner,
    DetectionSource::Coreference,
  ])
}

fn label_strategy() -> impl Strategy<Value = &'static str> {
  sample::select(vec![
    "person",
    "organization",
    "address",
    "date",
    "registration number",
  ])
}

fn redaction_case() -> impl Strategy<Value = (String, Vec<Entity>)> {
  collection::vec((text_fragment(8), entity_text()), 1..8).prop_map(
    |segments| {
      let mut text = String::new();
      let mut entities = Vec::new();

      for (index, (prefix, value)) in segments.into_iter().enumerate() {
        text.push_str(&prefix);
        let start = byte_len(&text);
        text.push_str(&value);
        let end = byte_len(&text);
        entities.push(Entity::detected(
          start,
          end,
          format!("generated label {index}"),
          value,
        ));
      }
      text.push_str(" tail");

      (text, entities)
    },
  )
}

fn reserved_person_redaction_case()
-> impl Strategy<Value = (String, Vec<Entity>, u32)> {
  (
    1_u32..8,
    collection::vec((text_fragment(8), entity_text()), 1..8),
  )
    .prop_map(|(reserved_count, segments)| {
      let mut text = (1..=reserved_count)
        .map(|index| format!("[PERSON_{index}]"))
        .collect::<Vec<_>>()
        .join(" ");
      text.push(' ');

      let mut entities = Vec::new();
      for (prefix, value) in segments {
        text.push_str(&prefix);
        let start = byte_len(&text);
        text.push_str(&value);
        let end = byte_len(&text);
        entities.push(Entity::detected(start, end, "person", value));
      }

      (text, entities, reserved_count)
    })
}

fn displayed_entity_case() -> impl Strategy<Value = (String, Entity, String)> {
  (
    text_fragment(8),
    entity_text(),
    text_fragment(8),
    entity_text(),
  )
    .prop_map(|(prefix, value, suffix, display_text)| {
      let start = byte_len(&prefix);
      let end = start.saturating_add(byte_len(&value));
      let text = format!("{prefix}{value}{suffix}");
      let entity = Entity::detected(start, end, "person", display_text);
      (text, entity, value)
    })
}

fn same_alias_coreference_case()
-> impl Strategy<Value = (String, Vec<Entity>, String, String)> {
  (entity_text(), entity_text(), entity_text()).prop_map(
    |(alias, first_source_seed, second_source_seed)| {
      let source_a = format!("{first_source_seed} source A");
      let source_b = format!("{second_source_seed} source B");
      let text = format!("{alias} met {alias}.");
      let first_start = 0;
      let first_end = byte_len(&alias);
      let second_start = byte_len(&format!("{alias} met "));
      let second_end = second_start.saturating_add(byte_len(&alias));
      let entities = vec![
        Entity::coreference(
          first_start,
          first_end,
          "person",
          alias.clone(),
          source_a.clone(),
        ),
        Entity::coreference(
          second_start,
          second_end,
          "person",
          alias,
          source_b.clone(),
        ),
      ];
      (text, entities, source_a, source_b)
    },
  )
}

fn pipeline_entity_strategy() -> impl Strategy<Value = PipelineEntity> {
  (
    0_u32..80,
    1_u32..24,
    label_strategy(),
    source_strategy(),
    0.0_f64..1.0,
  )
    .prop_map(|(start, len, label, source, score)| {
      let end = start.saturating_add(len);
      PipelineEntity::detected(
        start,
        end,
        label,
        "x".repeat(usize::try_from(len).unwrap_or(0)),
        score,
        source,
      )
    })
}

fn literal_search_case()
-> impl Strategy<Value = (Vec<SearchPattern>, SearchOptions, String)> {
  collection::vec(entity_text(), 1..6)
    .prop_flat_map(|needles| {
      let patterns = needles
        .iter()
        .map(|needle| SearchPattern::LiteralWithOptions {
          pattern: needle.clone(),
          case_insensitive: Some(false),
          whole_words: Some(false),
        })
        .collect::<Vec<_>>();
      (
        Just(patterns),
        collection::vec((text_fragment(8), sample::select(needles)), 1..10),
        text_fragment(8),
      )
    })
    .prop_map(|(patterns, segments, suffix)| {
      let mut haystack = String::new();
      for (prefix, needle) in segments {
        haystack.push_str(&prefix);
        haystack.push_str(&needle);
      }
      haystack.push_str(&suffix);

      (
        patterns,
        SearchOptions {
          literal: LiteralSearchOptions {
            case_insensitive: false,
            whole_words: false,
          },
          ..SearchOptions::default()
        },
        haystack,
      )
    })
}

fn all_literal_identity_search_case()
-> impl Strategy<Value = (Vec<SearchPattern>, SearchOptions, String)> {
  collection::vec(entity_text(), 1..6)
    .prop_flat_map(|needles| {
      let patterns = needles
        .iter()
        .map(|needle| SearchPattern::Literal(needle.clone()))
        .collect::<Vec<_>>();
      (
        Just(patterns),
        collection::vec((text_fragment(8), sample::select(needles)), 1..10),
        text_fragment(8),
      )
    })
    .prop_map(|(patterns, segments, suffix)| {
      let mut haystack = String::new();
      for (prefix, needle) in segments {
        haystack.push_str(&prefix);
        haystack.push_str(&needle);
      }
      haystack.push_str(&suffix);

      (
        patterns,
        SearchOptions {
          literal: LiteralSearchOptions {
            case_insensitive: false,
            whole_words: false,
          },
          ..SearchOptions::default()
        },
        haystack,
      )
    })
}

fn mixed_search_case()
-> impl Strategy<Value = (Vec<SearchPattern>, SearchOptions, String)> {
  (
    entity_text(),
    entity_text(),
    fuzzy_text(),
    text_fragment(8),
    text_fragment(8),
    text_fragment(8),
  )
    .prop_map(|(literal, regex_literal, fuzzy, prefix, middle, suffix)| {
      let patterns = vec![
        SearchPattern::LiteralWithOptions {
          pattern: literal.clone(),
          case_insensitive: Some(false),
          whole_words: Some(false),
        },
        SearchPattern::Regex(regex::escape(&regex_literal)),
        SearchPattern::Fuzzy {
          pattern: fuzzy.clone(),
          distance: Some(1),
        },
      ];
      let haystack =
        format!("{prefix}{literal} {middle}{regex_literal} {fuzzy}{suffix}");

      (
        patterns,
        SearchOptions {
          literal: LiteralSearchOptions {
            case_insensitive: false,
            whole_words: false,
          },
          regex: RegexSearchOptions {
            whole_words: false,
            overlap_all: true,
            ..RegexSearchOptions::default()
          },
          ..SearchOptions::default()
        },
        haystack,
      )
    })
}

fn mutated_search_patterns(patterns: &[SearchPattern]) -> Vec<SearchPattern> {
  let mut result = patterns.to_vec();
  let Some(first) = result.first_mut() else {
    return result;
  };

  match first {
    SearchPattern::Literal(pattern)
    | SearchPattern::Regex(pattern)
    | SearchPattern::Fuzzy { pattern, .. }
    | SearchPattern::LiteralWithOptions { pattern, .. }
    | SearchPattern::RegexWithOptions { pattern, .. } => pattern.push('x'),
  }

  result
}

#[derive(Clone, Copy, Debug)]
enum ArtifactCorruption {
  Header,
  Version,
  TrailingData,
  Truncated,
}

fn artifact_corruption() -> impl Strategy<Value = ArtifactCorruption> {
  sample::select(vec![
    ArtifactCorruption::Header,
    ArtifactCorruption::Version,
    ArtifactCorruption::TrailingData,
    ArtifactCorruption::Truncated,
  ])
}

fn corrupt_artifact(
  mut bytes: Vec<u8>,
  corruption: ArtifactCorruption,
) -> Vec<u8> {
  match corruption {
    ArtifactCorruption::Header => {
      let first = bytes.first_mut().expect("artifact header byte");
      *first ^= 0xff;
    }
    ArtifactCorruption::Version => {
      let version_byte = bytes.get_mut(8).expect("artifact version byte");
      *version_byte ^= 0xff;
    }
    ArtifactCorruption::TrailingData => bytes.push(0),
    ArtifactCorruption::Truncated => {
      bytes.pop();
    }
  }
  bytes
}

fn search_output_is_valid(
  haystack: &str,
  pattern_count: usize,
  matches: &[SearchMatch],
) -> bool {
  let mut previous: Option<(u32, u32, u32)> = None;

  for found in matches {
    if found.start() >= found.end() {
      return false;
    }

    let Ok(pattern) = usize::try_from(found.pattern()) else {
      return false;
    };
    if pattern >= pattern_count {
      return false;
    }

    let Ok(start) = usize::try_from(found.start()) else {
      return false;
    };
    let Ok(end) = usize::try_from(found.end()) else {
      return false;
    };
    if haystack.get(start..end).is_none() {
      return false;
    }

    let current = (found.start(), found.end(), found.pattern());
    if previous.is_some_and(|last| last > current) {
      return false;
    }
    previous = Some(current);
  }

  true
}

fn normalizable_char() -> impl Strategy<Value = char> {
  sample::select(vec![
    'a', 'Z', '0', ' ', '-', '"', 'á', 'ř', '界', '🦀', '\u{0301}', '\u{00a0}',
    '\u{2007}', '\u{202f}', '\u{2013}', '\u{2014}', '\u{201c}', '\u{201d}',
  ])
}

fn normalizable_text() -> impl Strategy<Value = String> {
  collection::vec(normalizable_char(), 0..24)
    .prop_map(|chars| chars.into_iter().collect())
}

/// Text that contains none of the fold targets, so normalization must be the
/// identity (exercises the `has_replacement` fast-path).
fn plain_text() -> impl Strategy<Value = String> {
  collection::vec(
    sample::select(vec!['a', 'Z', '0', ' ', '-', '"', 'á', 'ř', '界', '🦀']),
    0..24,
  )
  .prop_map(|chars| chars.into_iter().collect())
}

/// Source slice for a generated span, or a marker when the offsets do not
/// address a valid slice. `redact_text` rejects those spans, so the marker is
/// never redacted.
fn display_text_for_span(text: &str, start: u32, end: u32) -> String {
  slice_at(text, start, end)
    .map_or_else(|| String::from("invalid-span"), ToOwned::to_owned)
}

fn slice_at(text: &str, start: u32, end: u32) -> Option<&str> {
  let start = usize::try_from(start).ok()?;
  let end = usize::try_from(end).ok()?;
  text.get(start..end)
}

/// Whether one placeholder replaced two different source slices. The redaction
/// map keeps a single original per placeholder, so `deanonymise` cannot restore
/// both. `detected_placeholder_identity_uses_sanitized_text` in `redaction.rs`
/// pins the merge this detects.
fn merges_distinct_originals(
  text: &str,
  replacements: &[RedactionReplacement],
) -> bool {
  let mut originals = BTreeMap::<&str, &str>::new();
  for replacement in replacements {
    let Some(slice) = slice_at(text, replacement.start, replacement.end) else {
      continue;
    };
    if originals
      .insert(replacement.replacement.as_str(), slice)
      .is_some_and(|previous| previous != slice)
    {
      return true;
    }
  }
  false
}

fn person_placeholder_number(placeholder: &str) -> Option<u32> {
  placeholder
    .strip_prefix("[PERSON_")?
    .strip_suffix(']')?
    .parse::<u32>()
    .ok()
}

proptest! {
  #![proptest_config(ProptestConfig {
    cases: PROPERTY_CASES,
    ..ProptestConfig::default()
  })]

  #[test]
  fn generated_redactions_round_trip_on_utf8_boundaries(
    (text, entities) in redaction_case(),
  ) {
    let result = redact_text(&text, &entities, &OperatorConfig::default())
      .unwrap();

    prop_assert_eq!(result.entity_count, entities.len());
    let restored = deanonymise(&result.redacted_text, &result.redaction_map);
    prop_assert_eq!(restored.as_str(), text.as_str());
    for entry in &result.redaction_map {
      prop_assert!(!text.contains(&entry.placeholder));
    }
  }

  #[test]
  fn generated_redactions_skip_reserved_person_placeholders(
    (text, entities, reserved_count) in reserved_person_redaction_case(),
  ) {
    let result = redact_text(&text, &entities, &OperatorConfig::default())
      .unwrap();

    prop_assert_eq!(result.entity_count, entities.len());
    let restored = deanonymise(&result.redacted_text, &result.redaction_map);
    prop_assert_eq!(restored.as_str(), text.as_str());

    for entry in &result.redaction_map {
      prop_assert!(!text.contains(&entry.placeholder));
      let Some(index) = person_placeholder_number(&entry.placeholder) else {
        prop_assert!(false, "unexpected placeholder {}", entry.placeholder);
        continue;
      };
      prop_assert!(index > reserved_count);
    }
  }

  #[test]
  fn generated_detected_originals_use_source_slice_not_display_text(
    (text, entity, source_slice) in displayed_entity_case(),
  ) {
    let result = redact_text(
      &text,
      std::slice::from_ref(&entity),
      &OperatorConfig::default(),
    )
    .unwrap();

    prop_assert_eq!(result.redaction_map.len(), 1);
    prop_assert_eq!(result.redaction_map[0].original.as_str(), source_slice.as_str());
    let restored = deanonymise(&result.redacted_text, &result.redaction_map);
    prop_assert_eq!(restored.as_str(), text.as_str());
  }

  #[test]
  fn generated_same_alias_coreferences_keep_distinct_source_identity(
    (text, entities, source_a, source_b) in same_alias_coreference_case(),
  ) {
    let result = redact_text(&text, &entities, &OperatorConfig::default())
      .unwrap();

    prop_assert_eq!(result.entity_count, 2);
    prop_assert_eq!(result.redaction_map.len(), 2);
    prop_assert!(
      result.redaction_map[0].placeholder
        != result.redaction_map[1].placeholder,
    );
    prop_assert_eq!(result.redaction_map[0].original.as_str(), source_a.as_str());
    prop_assert_eq!(result.redaction_map[1].original.as_str(), source_b.as_str());
    prop_assert!(result.redacted_text.contains(&result.redaction_map[0].placeholder));
    prop_assert!(result.redacted_text.contains(&result.redaction_map[1].placeholder));
  }

  #[test]
  fn generated_entity_spans_fail_or_round_trip(
    text in text_fragment(32),
    spans in collection::vec((0_u32..80, 0_u32..80, label_strategy()), 0..16),
  ) {
    let entities = spans
      .into_iter()
      .map(|(start, end, label)| {
        // Carry each entity's own source slice, the way a detector or an
        // external caller does. A shared constant would give every entity the
        // same placeholder identity, so one placeholder would stand for
        // unrelated spans and the spans under test would never be exercised.
        let display = display_text_for_span(&text, start, end);
        Entity::detected(start, end, label, display)
      })
      .collect::<Vec<_>>();

    let result = redact_text(&text, &entities, &OperatorConfig::default());
    if let Ok(redacted) = result {
      for entry in &redacted.redaction_map {
        prop_assert!(!text.contains(&entry.placeholder));
      }
      // Entities that share a placeholder identity intentionally share a
      // placeholder, and the map stores one original per placeholder, so
      // `deanonymise` restores every occurrence to that original. Exact
      // restoration is therefore only guaranteed while no placeholder stands
      // for two different source slices.
      if !merges_distinct_originals(&text, &redacted.replacements) {
        let restored =
          deanonymise(&redacted.redacted_text, &redacted.redaction_map);
        prop_assert_eq!(restored.as_str(), text.as_str());
      }
    }
  }

  #[test]
  fn invalid_interior_utf8_offsets_are_rejected(
    ch in any::<char>().prop_filter(
      "multi-byte scalar",
      |candidate| candidate.len_utf8() > 1,
    ),
  ) {
    let text = format!("a{ch}z");
    let end = 1_u32.saturating_add(
      u32::try_from(ch.len_utf8()).unwrap_or(u32::MAX),
    );
    let entities = vec![Entity::detected(2, end, "person", ch.to_string())];

    let error = redact_text(&text, &entities, &OperatorConfig::default())
      .unwrap_err();

    prop_assert_eq!(error, Error::ByteOffsetInsideCodepoint { offset: 2 });
  }

  #[test]
  fn merge_and_dedup_never_leaves_partial_overlaps(
    entities in collection::vec(pipeline_entity_strategy(), 0..32),
  ) {
    let result = merge_and_dedup(&entities);
    let second_pass = merge_and_dedup(&result);
    prop_assert_eq!(&second_pass, &result);

    for entity in &result {
      prop_assert!(entity.start < entity.end);
    }

    for pair in result.windows(2) {
      let left = &pair[0];
      let right = &pair[1];
      prop_assert!(left.start <= right.start);
    }

    for (index, left) in result.iter().enumerate() {
      for right in result.iter().skip(index.saturating_add(1)) {
        let overlaps = left.end > right.start && left.start < right.end;
        let same_span = left.start == right.start && left.end == right.end;
        prop_assert!(
          !overlaps || same_span,
          "partial overlap survived: {left:?} / {right:?}",
        );
      }
    }
  }

  #[test]
  fn sanitize_entities_keeps_trimmed_spans_inside_original_span(
    leading in trim_text(),
    core in entity_text(),
    trailing in trim_text(),
    label in label_strategy(),
    base_start in 0_u32..20,
  ) {
    let raw = format!("{leading}{core}{trailing}");
    let original = PipelineEntity::detected(
      base_start,
      base_start.saturating_add(byte_len(&raw)),
      label,
      raw,
      0.5,
      DetectionSource::Ner,
    );

    let result = sanitize_entities(std::slice::from_ref(&original));

    for entity in &result {
      prop_assert!(entity.start >= original.start);
      prop_assert!(entity.end <= original.end);
      prop_assert!(entity.start < entity.end);
      prop_assert!(byte_len(&entity.text) <= entity.end.saturating_sub(entity.start));
      prop_assert!(entity.text.chars().any(char::is_alphanumeric));
      prop_assert_eq!(entity.text.trim(), entity.text.as_str());
    }
  }

  #[test]
  fn literal_search_matches_are_valid_utf8_slices(
    prefix in text_fragment(12),
    needle in entity_text(),
    suffix in text_fragment(12),
  ) {
    let haystack = format!("{prefix}{needle}{suffix}");
    let expected_start = byte_len(&prefix);
    let expected_end = expected_start.saturating_add(byte_len(&needle));
    let index = SearchIndex::new(
      vec![SearchPattern::Literal(needle.clone())],
      SearchOptions {
        literal: LiteralSearchOptions {
          case_insensitive: false,
          whole_words: false,
        },
        ..SearchOptions::default()
      },
    )
    .unwrap();

    let matches = index.find_iter(&haystack).unwrap();

    let includes_expected = matches.iter().any(|found| matches!(
      found,
      SearchMatch::Literal { pattern: 0, start, end }
        if *start == expected_start && *end == expected_end
    ));
    prop_assert!(includes_expected);
    for found in matches {
      let SearchMatch::Literal { start, end, .. } = found else {
        continue;
      };
      let start = usize::try_from(start).unwrap();
      let end = usize::try_from(end).unwrap();
      let Some(slice) = haystack.get(start..end) else {
        prop_assert!(false, "literal match was not a valid UTF-8 slice");
        continue;
      };
      prop_assert_eq!(slice, needle.as_str());
    }
  }

  #[test]
  fn prepared_literal_search_artifacts_match_direct_search(
    (patterns, options, haystack) in literal_search_case(),
  ) {
    let artifacts =
      SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
    prop_assume!(!artifacts.slots.is_empty());
    let encoded = artifacts.to_bytes().unwrap();
    let decoded = SearchIndexArtifacts::from_bytes(&encoded).unwrap();
    prop_assert_eq!(&decoded, &artifacts);

    let direct = SearchIndex::new(patterns.clone(), options).unwrap();
    let prepared =
      SearchIndex::new_with_artifacts(patterns.clone(), options, &decoded)
        .unwrap();
    let direct_matches = direct.find_iter(&haystack).unwrap();
    let prepared_matches = prepared.find_iter(&haystack).unwrap();

    prop_assert_eq!(&prepared_matches, &direct_matches);
    prop_assert!(search_output_is_valid(
      &haystack,
      patterns.len(),
      &prepared_matches,
    ));
  }

  #[test]
  fn prepared_all_literal_artifacts_load_without_original_patterns(
    (patterns, options, haystack) in all_literal_identity_search_case(),
  ) {
    let artifacts =
      SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
    let encoded = artifacts.to_bytes().unwrap();
    let decoded = SearchIndexArtifacts::from_bytes(&encoded).unwrap();

    let direct = SearchIndex::new(patterns.clone(), options).unwrap();
    let prepared =
      SearchIndex::new_with_artifacts(Vec::new(), options, &decoded)
        .unwrap();
    let direct_matches = direct.find_iter(&haystack).unwrap();
    let prepared_matches = prepared.find_iter(&haystack).unwrap();

    prop_assert_eq!(prepared.len(), patterns.len());
    prop_assert_eq!(&prepared_matches, &direct_matches);
    prop_assert!(search_output_is_valid(
      &haystack,
      patterns.len(),
      &prepared_matches,
    ));
  }

  #[test]
  fn artifact_only_literal_loader_rejects_per_pattern_literal_options(
    (patterns, options, _haystack) in literal_search_case(),
  ) {
    let artifacts =
      SearchIndex::prepare_artifacts(patterns, options).unwrap();
    let encoded = artifacts.to_bytes().unwrap();
    let decoded = SearchIndexArtifacts::from_bytes(&encoded).unwrap();

    prop_assert!(
      SearchIndex::new_with_artifacts(Vec::new(), options, &decoded).is_err()
    );
  }

  #[test]
  fn prepared_mixed_search_artifacts_match_direct_search(
    (patterns, options, haystack) in mixed_search_case(),
  ) {
    let artifacts =
      SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
    let encoded = artifacts.to_bytes().unwrap();
    let decoded = SearchIndexArtifacts::from_bytes(&encoded).unwrap();

    let direct = SearchIndex::new(patterns.clone(), options).unwrap();
    let prepared =
      SearchIndex::new_with_artifacts(patterns.clone(), options, &decoded)
        .unwrap();
    let direct_matches = direct.find_iter(&haystack).unwrap();
    let prepared_matches = prepared.find_iter(&haystack).unwrap();

    prop_assert_eq!(&prepared_matches, &direct_matches);
    prop_assert!(search_output_is_valid(
      &haystack,
      patterns.len(),
      &prepared_matches,
    ));
  }

  #[test]
  fn direct_mixed_search_match_presence_matches_find_iter(
    (patterns, options, haystack) in mixed_search_case(),
  ) {
    let index = SearchIndex::new(patterns.clone(), options).unwrap();
    let matches = index.find_iter(&haystack).unwrap();

    prop_assert_eq!(index.is_match(&haystack).unwrap(), !matches.is_empty());
    prop_assert!(search_output_is_valid(
      &haystack,
      patterns.len(),
      &matches,
    ));
  }

  #[test]
  fn prepared_mixed_search_artifacts_reject_same_shape_stale_patterns(
    (patterns, options, _haystack) in mixed_search_case(),
  ) {
    let artifacts =
      SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
    let stale_patterns = mutated_search_patterns(&patterns);
    prop_assume!(stale_patterns != patterns);

    prop_assert!(
      SearchIndex::new_with_artifacts(stale_patterns, options, &artifacts)
        .is_err()
    );
  }

  #[test]
  fn malformed_search_artifacts_fail_closed(
    (patterns, options, _haystack) in literal_search_case(),
    corruption in artifact_corruption(),
  ) {
    let artifacts =
      SearchIndex::prepare_artifacts(patterns, options).unwrap();
    let encoded = artifacts.to_bytes().unwrap();
    let corrupted = corrupt_artifact(encoded, corruption);

    prop_assert!(SearchIndexArtifacts::from_bytes(&corrupted).is_err());
  }

  #[test]
  fn search_artifacts_reject_missing_and_extra_slots(
    (patterns, options, _haystack) in literal_search_case(),
  ) {
    let artifacts =
      SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
    prop_assume!(!artifacts.slots.is_empty());

    let missing = SearchIndexArtifacts::default();
    prop_assert!(
      SearchIndex::new_with_artifacts(patterns.clone(), options, &missing)
        .is_err()
    );

    let mut extra = artifacts;
    let first = extra.slots.first().expect("prepared slot").clone();
    extra.slots.push(first);
    prop_assert!(
      SearchIndex::new_with_artifacts(patterns, options, &extra).is_err()
    );
  }

  #[test]
  fn normalize_for_search_is_idempotent_and_char_count_stable(
    text in normalizable_text(),
  ) {
    let once = normalize_for_search(&text);

    // Idempotent: normalized text is a fixed point. Offset maps and cache
    // keys built on the output must not drift on a second pass.
    let twice = normalize_for_search(&once);
    prop_assert_eq!(&twice, &once);

    // The fold is 1:1 per scalar, so it never adds or drops a codepoint.
    prop_assert_eq!(once.chars().count(), text.chars().count());

    // Every fold target is gone from the output.
    for folded in FOLDED_CHARS {
      prop_assert!(!once.contains(folded));
    }
  }

  #[test]
  fn normalize_for_search_is_identity_without_fold_targets(
    text in plain_text(),
  ) {
    // With no fold target present the fast-path must return the input
    // verbatim (same bytes, not just an equal-looking string).
    prop_assert_eq!(normalize_for_search(&text), text);
  }
}
