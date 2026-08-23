#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::sync::OnceLock;

use proptest::prelude::{ProptestConfig, any};
use proptest::{collection, prop_assert, prop_assert_eq, proptest, sample};
use serde::Deserialize;
use stella_anonymize_adapter_contract::{
  BindingPreparedArtifactPolicy, BindingSearchPattern,
  assemble_static_search_config,
};
use stella_anonymize_core::assemble::{GazetteerEntry, PipelineConfig};
use stella_anonymize_core::{
  Error, FuzzySearchOptions, LiteralSearchOptions, PreparedArtifactPolicy,
  RegexArtifactPolicy, RegexSearchOptions, SearchIndex, SearchIndexArtifacts,
  SearchMatch, SearchOptions, SearchPattern,
};

#[derive(Deserialize)]
struct AssembleFixtureInput {
  config: PipelineConfig,
  #[serde(default)]
  gazetteer: Vec<GazetteerEntry>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmailObfuscationVocabulary {
  at_tokens: Vec<String>,
  dot_tokens: Vec<String>,
}

fn assemble_fixture_input() -> AssembleFixtureInput {
  serde_json::from_str(include_str!(
    "fixtures/assemble/baseline-all-on.input.json"
  ))
  .unwrap()
}

fn email_obfuscation_vocabularies()
-> BTreeMap<String, EmailObfuscationVocabulary> {
  serde_json::from_str(include_str!(
    "../../../packages/data/config/email-obfuscation-tokens.json"
  ))
  .unwrap()
}

fn assembled_obfuscated_email_pattern(
  language: &str,
  vocabulary: &EmailObfuscationVocabulary,
) -> BindingSearchPattern {
  let mut input = assemble_fixture_input();
  input.config.languages = Some(vec![language.to_string()]);
  let assembled =
    assemble_static_search_config(&input.config, None, &input.gazetteer)
      .unwrap();
  let dot_tokens = vocabulary
    .dot_tokens
    .iter()
    .filter(|token| !token.is_empty())
    .cloned()
    .collect::<Vec<_>>();
  let pattern = assembled
    .regex_patterns
    .into_iter()
    .find(|pattern| {
      pattern.lazy == Some(true)
        && pattern.prefilter_any.as_deref() == Some(dot_tokens.as_slice())
    })
    .expect("assembled language-owned written-email pattern");
  assert_eq!(
    pattern.prefilter_case_insensitive,
    Some(true),
    "the dot-token gate must preserve the main regex's case insensitivity"
  );
  assert_eq!(
    pattern.prefilter_regex, None,
    "the written-email pattern must not retain a secondary regex"
  );
  assert_eq!(
    pattern.prefilter_window_bytes, None,
    "the written-email pattern must not impose a prefilter window"
  );
  assert_eq!(
    pattern.prepared_artifact_policy, None,
    "the written-email pattern must not override artifact policy"
  );
  pattern
}

fn written_email_search_pattern(
  pattern: BindingSearchPattern,
) -> SearchPattern {
  SearchPattern::RegexWithOptions {
    pattern: pattern.pattern,
    lazy: true,
    prefilter_any: pattern.prefilter_any.unwrap_or_default(),
    prefilter_case_insensitive: pattern.prefilter_case_insensitive,
    prefilter_regex: None,
    prefilter_window_bytes: pattern
      .prefilter_window_bytes
      .map(|value| usize::try_from(value).unwrap()),
    prepared_artifact_policy: pattern.prepared_artifact_policy.map(|policy| {
      match policy {
        BindingPreparedArtifactPolicy::Include => {
          PreparedArtifactPolicy::Include
        }
        BindingPreparedArtifactPolicy::Omit => PreparedArtifactPolicy::Omit,
      }
    }),
  }
}

fn obfuscated_email_pattern() -> SearchPattern {
  let vocabularies = email_obfuscation_vocabularies();
  let vocabulary = vocabularies.get("en").unwrap();
  written_email_search_pattern(assembled_obfuscated_email_pattern(
    "en", vocabulary,
  ))
}

fn written_email_search_options() -> SearchOptions {
  SearchOptions {
    regex: RegexSearchOptions {
      artifact_policy: RegexArtifactPolicy::Omit,
      ..RegexSearchOptions::default()
    },
    ..SearchOptions::default()
  }
}

fn written_email_indexes() -> (&'static SearchIndex, &'static SearchIndex) {
  static OPTIMIZED: OnceLock<SearchIndex> = OnceLock::new();
  static REFERENCE: OnceLock<SearchIndex> = OnceLock::new();

  let optimized = OPTIMIZED.get_or_init(|| {
    SearchIndex::new(
      vec![obfuscated_email_pattern()],
      written_email_search_options(),
    )
    .unwrap()
  });
  let reference = REFERENCE.get_or_init(|| {
    let vocabularies = email_obfuscation_vocabularies();
    let vocabulary = vocabularies.get("en").unwrap();
    SearchIndex::new(
      vec![SearchPattern::Regex(
        assembled_obfuscated_email_pattern("en", vocabulary).pattern,
      )],
      written_email_search_options(),
    )
    .unwrap()
  });
  (optimized, reference)
}

#[test]
fn search_index_routes_literal_regex_and_fuzzy_patterns() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::Literal(String::from("Alice")),
      SearchPattern::Regex(String::from(r"\b[A-Z]{2}\d{4}\b")),
      SearchPattern::Fuzzy {
        pattern: String::from("Muller"),
        distance: Some(1),
      },
    ],
    SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: false,
        whole_words: true,
      },
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
        ..RegexSearchOptions::default()
      },
      fuzzy: FuzzySearchOptions {
        case_insensitive: true,
        whole_words: true,
        normalize_diacritics: false,
      },
    },
  )
  .unwrap();

  let matches = index
    .find_iter("Alice signed AB1234. Later, Muler countersigned.")
    .unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 0,
        end: 5,
      },
      SearchMatch::Regex {
        pattern: 1,
        start: 13,
        end: 19,
      },
      SearchMatch::Fuzzy {
        pattern: 2,
        start: 28,
        end: 33,
        distance: 1,
      },
    ]
  );
}

#[test]
fn search_index_preserves_byte_offsets_from_primitive_engines() {
  const SUPPLEMENTARY_SCALAR: &str = "\u{1F9EA}";

  let index = SearchIndex::new(
    vec![
      SearchPattern::Literal(String::from("Bob")),
      SearchPattern::Regex(String::from(SUPPLEMENTARY_SCALAR)),
    ],
    SearchOptions::default(),
  )
  .unwrap();

  let haystack = format!("A {SUPPLEMENTARY_SCALAR} Bob");
  let matches = index.find_iter(&haystack).unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Regex {
        pattern: 1,
        start: 2,
        end: 6,
      },
      SearchMatch::Literal {
        pattern: 0,
        start: 7,
        end: 10,
      },
    ]
  );
}

#[test]
fn search_index_preserves_case_insensitive_literal_byte_offsets() {
  let index = SearchIndex::new(
    vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("krajským soudem"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    SearchOptions::default(),
  )
  .unwrap();

  let haystack = "zapsaná v obchodním rejstříku vedeném Krajským soudem";
  let start = haystack.find("Krajským").unwrap();
  let end = haystack.len();

  assert_eq!(
    index.find_iter(haystack).unwrap(),
    vec![SearchMatch::Literal {
      pattern: 0,
      start: u32::try_from(start).unwrap(),
      end: u32::try_from(end).unwrap(),
    }]
  );
}

#[test]
fn search_index_preserves_large_case_insensitive_literal_byte_offsets() {
  let mut patterns = Vec::new();
  for index in 0..300 {
    let pattern = if index == 216 {
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
  let index = SearchIndex::new(patterns, SearchOptions::default()).unwrap();

  let haystack = "zapsaná v obchodním rejstříku vedeném Krajským soudem v Ústí";
  let start = haystack.find("Krajským").unwrap();
  let end = start.saturating_add("Krajským soudem".len());

  assert_eq!(
    index.find_iter(haystack).unwrap(),
    vec![SearchMatch::Literal {
      pattern: 216,
      start: u32::try_from(start).unwrap(),
      end: u32::try_from(end).unwrap(),
    }]
  );
}

#[test]
fn search_index_returns_overlapping_literal_matches() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::Literal(String::from("Alice")),
      SearchPattern::Literal(String::from("Alice Smith")),
    ],
    SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: false,
        whole_words: true,
      },
      ..SearchOptions::default()
    },
  )
  .unwrap();

  let matches = index.find_iter("Alice Smith signed.").unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 0,
        end: 5,
      },
      SearchMatch::Literal {
        pattern: 1,
        start: 0,
        end: 11,
      },
    ]
  );
}

#[test]
fn search_index_can_return_overlapping_regex_matches() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::Regex(String::from("Alice")),
      SearchPattern::Regex(String::from("Alice Smith")),
    ],
    SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: true,
        ..RegexSearchOptions::default()
      },
      ..SearchOptions::default()
    },
  )
  .unwrap();

  let matches = index.find_iter("Alice Smith signed.").unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Regex {
        pattern: 0,
        start: 0,
        end: 5,
      },
      SearchMatch::Regex {
        pattern: 1,
        start: 0,
        end: 11,
      },
    ]
  );
}

#[test]
fn search_index_supports_per_pattern_literal_word_boundaries() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("he"),
        case_insensitive: None,
        whole_words: Some(true),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("s.r.o."),
        case_insensitive: None,
        whole_words: Some(false),
      },
    ],
    SearchOptions::default(),
  )
  .unwrap();

  let matches = index.find_iter("shell Acme s.r.o. he").unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Literal {
        pattern: 1,
        start: 11,
        end: 17,
      },
      SearchMatch::Literal {
        pattern: 0,
        start: 18,
        end: 20,
      },
    ]
  );
}

#[test]
fn search_index_supports_per_pattern_literal_case_sensitivity() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("alice"),
        case_insensitive: Some(true),
        whole_words: None,
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("bob"),
        case_insensitive: Some(false),
        whole_words: None,
      },
    ],
    SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: false,
        whole_words: true,
      },
      ..SearchOptions::default()
    },
  )
  .unwrap();

  let matches = index.find_iter("Alice Bob bob").unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 0,
        end: 5,
      },
      SearchMatch::Literal {
        pattern: 1,
        start: 10,
        end: 13,
      },
    ]
  );
}

#[test]
fn search_index_reports_match_presence_across_engines() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::Literal(String::from("Alice")),
      SearchPattern::Regex(String::from(r"\d{4}")),
    ],
    SearchOptions::default(),
  )
  .unwrap();

  assert!(index.is_match("Case 2026").unwrap());
  assert!(!index.is_match("No hit").unwrap());
}

#[test]
fn search_index_prepared_artifacts_match_direct_index() {
  let patterns = vec![
    SearchPattern::Literal(String::from("Alice")),
    SearchPattern::Regex(String::from(r"\b[A-Z]{2}\d{4}\b")),
    SearchPattern::Fuzzy {
      pattern: String::from("Muller"),
      distance: Some(1),
    },
  ];
  let options = SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: false,
      whole_words: true,
    },
    regex: RegexSearchOptions {
      whole_words: false,
      overlap_all: false,
      ..RegexSearchOptions::default()
    },
    fuzzy: FuzzySearchOptions {
      case_insensitive: true,
      whole_words: true,
      normalize_diacritics: false,
    },
  };
  let artifacts =
    SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
  assert!(
    !artifacts.slots.is_empty(),
    "prepared engine index should record text-search slot artifacts"
  );
  let direct = SearchIndex::new(patterns.clone(), options).unwrap();
  let prepared =
    SearchIndex::new_with_artifacts(patterns, options, &artifacts).unwrap();
  let haystack = "Alice signed AB1234. Later, Muler countersigned.";

  assert_eq!(
    prepared.find_iter(haystack).unwrap(),
    direct.find_iter(haystack).unwrap()
  );
  assert_eq!(prepared.is_match(haystack), direct.is_match(haystack));
}

#[test]
fn search_index_prepared_artifacts_roundtrip_bytes() {
  let patterns = vec![
    SearchPattern::Literal(String::from("Alice")),
    SearchPattern::Literal(String::from("Bob")),
  ];
  let options = SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: true,
      whole_words: true,
    },
    ..SearchOptions::default()
  };
  let artifacts =
    SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
  let bytes = artifacts.to_bytes().unwrap();
  let decoded = SearchIndexArtifacts::from_bytes(&bytes).unwrap();

  assert_eq!(decoded, artifacts);

  let direct = SearchIndex::new(patterns.clone(), options).unwrap();
  let prepared =
    SearchIndex::new_with_artifacts(patterns, options, &decoded).unwrap();
  assert_eq!(
    prepared.find_iter("Alice and Bob").unwrap(),
    direct.find_iter("Alice and Bob").unwrap()
  );
}

#[test]
fn search_index_prepared_artifacts_reject_invalid_bytes() {
  let error = SearchIndexArtifacts::from_bytes(b"not-valid").unwrap_err();

  assert!(
    matches!(error, Error::InvalidStaticData { .. }),
    "invalid artifact bytes should fail at the format boundary"
  );
}

#[test]
fn search_index_prepared_artifacts_reject_wrong_slot_count() {
  let patterns = vec![SearchPattern::Literal(String::from("Alice"))];
  let options = SearchOptions::default();
  let mut artifacts =
    SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
  artifacts.slots.clear();

  assert!(
    SearchIndex::new_with_artifacts(patterns, options, &artifacts).is_err(),
    "missing prepared slot artifacts should fail"
  );
}

#[test]
fn search_index_prepared_artifacts_reject_stale_patterns() {
  let options = SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: false,
      whole_words: false,
    },
    ..SearchOptions::default()
  };
  let artifacts = SearchIndex::prepare_artifacts(
    vec![SearchPattern::Literal(String::from("Alice"))],
    options,
  )
  .unwrap();
  let stale_patterns = vec![SearchPattern::Literal(String::from("Bob"))];

  assert!(
    SearchIndex::new_with_artifacts(stale_patterns, options, &artifacts)
      .is_err(),
    "same-count stale prepared artifacts should fail"
  );
}

#[test]
fn search_index_prepared_artifacts_reject_stale_literal_options() {
  let prepare_options = SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: false,
      whole_words: false,
    },
    ..SearchOptions::default()
  };
  let load_options = SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: true,
      whole_words: false,
    },
    ..SearchOptions::default()
  };
  let patterns = vec![SearchPattern::Literal(String::from("Alice"))];
  let artifacts =
    SearchIndex::prepare_artifacts(patterns.clone(), prepare_options).unwrap();

  assert!(
    SearchIndex::new_with_artifacts(patterns, load_options, &artifacts)
      .is_err(),
    "prepared artifacts should be bound to literal search options"
  );
}

#[test]
fn written_email_literal_prefilter_removes_secondary_regex_artifact() {
  let artifacts = SearchIndex::prepare_artifacts(
    vec![obfuscated_email_pattern()],
    written_email_search_options(),
  )
  .unwrap();
  let slot = artifacts.slots.first().unwrap();

  assert_eq!(
    slot.aho_automata.len(),
    0,
    "a single literal cue must stay on the allocation-free inline path"
  );
  assert_eq!(
    slot.regex_sets.len(),
    1,
    "only the authoritative email regex should need a regex artifact"
  );
}

fn token_case_variants(token: &str) -> Vec<String> {
  let alternating = token
    .chars()
    .enumerate()
    .flat_map(|(index, character)| {
      if index % 2 == 0 {
        character.to_uppercase().collect::<Vec<_>>()
      } else {
        character.to_lowercase().collect::<Vec<_>>()
      }
    })
    .collect::<String>();
  let mut variants = vec![
    token.to_string(),
    token.to_lowercase(),
    token.to_uppercase(),
    alternating,
  ];
  variants.sort();
  variants.dedup();
  variants
}

#[test]
fn every_shipped_written_email_vocabulary_matches_unfiltered_reference() {
  let vocabularies = email_obfuscation_vocabularies();
  assert!(
    !vocabularies.is_empty(),
    "written-email coverage requires at least one shipped vocabulary"
  );

  for (language, vocabulary) in vocabularies {
    let assembled = assembled_obfuscated_email_pattern(&language, &vocabulary);
    let source = assembled.pattern.clone();
    let optimized = SearchIndex::new(
      vec![written_email_search_pattern(assembled)],
      written_email_search_options(),
    )
    .unwrap();
    let reference = SearchIndex::new(
      vec![SearchPattern::Regex(source)],
      written_email_search_options(),
    )
    .unwrap();
    let at_tokens = vocabulary
      .at_tokens
      .iter()
      .filter(|token| !token.is_empty());
    let dot_tokens = vocabulary
      .dot_tokens
      .iter()
      .filter(|token| !token.is_empty());

    for at_token in at_tokens {
      for dot_token in dot_tokens.clone() {
        for at_variant in token_case_variants(at_token) {
          for dot_variant in token_case_variants(dot_token) {
            for whitespace in [" ", "  ", "\t", "\u{a0}"] {
              let haystack = format!(
                "Contact alice{whitespace}{at_variant}{whitespace}example{whitespace}{dot_variant}{whitespace}com now"
              );
              let optimized_matches = optimized.find_iter(&haystack).unwrap();
              assert!(
                !optimized_matches.is_empty(),
                "{language} literal gate rejected a main-regex match for {haystack:?}"
              );
              assert_eq!(
                optimized_matches,
                reference.find_iter(&haystack).unwrap(),
                "{language} literal gate changed match identity for {haystack:?}"
              );
            }
          }
        }
      }
    }
  }
}

proptest! {
  #![proptest_config(ProptestConfig {
    cases: 96,
    ..ProptestConfig::default()
  })]

  #[test]
  fn written_email_literal_prefilter_matches_reference_for_arbitrary_text(
    characters in collection::vec(any::<char>(), 0..256),
  ) {
    let haystack = characters.into_iter().collect::<String>();
    let (optimized, reference) = written_email_indexes();

    prop_assert_eq!(
      optimized.find_iter(&haystack).unwrap(),
      reference.find_iter(&haystack).unwrap(),
    );
  }

  #[test]
  fn written_email_literal_prefilter_preserves_case_and_unicode_whitespace(
    local in "[a-z0-9]{1,12}",
    domain in "[a-z0-9]{1,12}",
    suffix in "[a-z]{2,6}",
    at_token in sample::select(vec!["at", "At", "aT", "AT"]),
    dot_token in sample::select(vec!["dot", "Dot", "dOt", "DOT"]),
    whitespace in sample::select(vec![" ", "  ", "\t", "\u{a0}"]),
  ) {
    let haystack = format!(
      "Contact {local}{whitespace}{at_token}{whitespace}{domain}{whitespace}{dot_token}{whitespace}{suffix} now"
    );
    let (optimized, reference) = written_email_indexes();
    let optimized_matches = optimized.find_iter(&haystack).unwrap();

    prop_assert!(!optimized_matches.is_empty());
    prop_assert_eq!(optimized_matches, reference.find_iter(&haystack).unwrap());
  }
}
