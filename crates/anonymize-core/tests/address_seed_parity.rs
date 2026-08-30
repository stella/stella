#![allow(clippy::expect_used)]

mod support;

use stella_anonymize_core::{
  AddressSeedData, DenyListFilterData, DenyListMatchData, LiteralSearchOptions,
  OperatorConfig, PatternSlice, PreparedEngine, PreparedEngineConfig,
  PreparedEngineSlices, RegexMatchMeta, SearchOptions, SearchPattern,
  StandaloneStreetData,
};
use support::prepared_config;

fn empty_config(slices: PreparedEngineSlices) -> PreparedEngineConfig {
  prepared_config! {
    regex_patterns: vec![],
    custom_regex_patterns: vec![],
    literal_patterns: vec![],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: slices,
    regex_meta: vec![],
    custom_regex_meta: vec![],
    deny_list_data: None,
    false_positive_filters: None,
    gazetteer_data: None,
    country_data: None,
    hotword_data: None,
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    zone_data: None,
    address_context_data: None,
    coreference_data: None,
    name_corpus_data: None,
    signature_data: None,
    date_data: None,
    monetary_data: None,
  }
}

fn address_texts(
  result: &stella_anonymize_core::StaticRedactionResult,
) -> Vec<&str> {
  result
    .resolved_entities
    .iter()
    .filter(|entity| entity.label == "address")
    .map(|entity| entity.text.as_str())
    .collect()
}

#[test]
fn detects_state_qualified_zip_plus_four_address_seed() {
  let prepared = PreparedEngine::new(prepared_config! {
    address_seed_data: Some(AddressSeedData::default()),
    false_positive_filters: Some(DenyListFilterData {
      us_state_abbreviations: std::iter::once(String::from("CA")).collect(),
      ..DenyListFilterData::default()
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .expect("address seed data should prepare");

  let result = prepared
    .redact_static_entities(
      "Registered office: CA 94304-1050. Notices follow.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  assert!(
    address_texts(&result).contains(&"CA 94304-1050"),
    "resolved address entities: {:?}",
    result.resolved_entities,
  );
  assert!(!result.redaction.redacted_text.contains("94304-1050"));
}

#[test]
fn detects_cue_gated_br_cep_address_seed() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Rua"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      street_types: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    address_seed_data: Some(AddressSeedData {
      boundary_words: Vec::new(),
      br_cep_cue_words: vec![String::from("CEP")],
      unit_abbreviations: Vec::new(),
      ..AddressSeedData::default()
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .expect("address seed data should prepare");

  let result = prepared
    .redact_static_entities(
      "Enviar para CEP 01001-000, Rua Boa Vista, 100. Obrigado.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  assert!(
    address_texts(&result).contains(&"CEP 01001-000, Rua Boa Vista, 100"),
    "resolved address entities: {:?}",
    result.resolved_entities,
  );
  assert!(!result.redaction.redacted_text.contains("01001-000"));
}

#[test]
fn detects_titlecase_street_number_address_seed() {
  let prepared = PreparedEngine::new(prepared_config! {
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .expect("address seed data should prepare");

  let result = prepared
    .redact_static_entities(
      "Registered office: Květnici 551/8, Praha 14000. Notices follow.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  assert!(
    address_texts(&result).contains(&"Květnici 551/8, Praha 14000"),
    "resolved address entities: {:?}; address seed entities: {:?}",
    result.resolved_entities,
    result.detections.entities.address_seed(),
  );
}

#[test]
fn detects_italian_cap_address_seed() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Roma"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Via"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
    ],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      street_types: PatternSlice { start: 1, end: 2 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Roma")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .expect("address seed data should prepare");

  let result = prepared
    .redact_static_entities(
      "Registered office: Via Roma, 00100 Roma. Notices follow.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  assert!(
    address_texts(&result).contains(&"Via Roma, 00100 Roma"),
    "resolved address entities: {:?}; address seed entities: {:?}",
    result.resolved_entities,
    result.detections.entities.address_seed(),
  );
}

#[test]
fn keeps_date_like_street_name_in_address_seed_span() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from("May 15"))],
    regex_meta: vec![RegexMatchMeta::new("date", 0.9)],
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("London"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Street"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
    ],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      deny_list: PatternSlice { start: 0, end: 1 },
      street_types: PatternSlice { start: 1, end: 2 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("London")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .expect("address seed data should prepare");

  let result = prepared
    .redact_static_entities(
      "Notices go to May 15 Street, London 12345.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  assert!(
    address_texts(&result).contains(&"May 15 Street, London 12345"),
    "resolved address entities: {:?}; address seed entities: {:?}",
    result.resolved_entities,
    result.detections.entities.address_seed(),
  );
  assert!(!result.redaction.redacted_text.contains("May 15 Street"));
}

fn barrier_address_engine() -> PreparedEngine {
  barrier_address_engine_with_threshold(0.0)
}

fn barrier_address_engine_with_threshold(threshold: f64) -> PreparedEngine {
  let literal = |pattern: &str| SearchPattern::LiteralWithOptions {
    pattern: String::from(pattern),
    case_insensitive: Some(true),
    whole_words: Some(true),
  };
  let mut config = prepared_config! {
    regex_patterns: vec![
      SearchPattern::Regex(String::from(r"\d:\d{2}-cv-\d{5}")),
      SearchPattern::Regex(String::from(r"[a-z]+@[a-z]+\.[a-z]+")),
    ],
    regex_meta: vec![
      RegexMatchMeta::new("case number", 0.9),
      RegexMatchMeta::new("email address", 0.9),
    ],
    literal_patterns: vec![literal("Paris"), literal("Street")],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 2 },
      deny_list: PatternSlice { start: 0, end: 1 },
      street_types: PatternSlice { start: 1, end: 2 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Paris")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  };
  config.policy.threshold = threshold;
  PreparedEngine::new(config).expect("address seed data should prepare")
}

/// A barrier entity between two halves of an address splits the seed cluster.
/// Each half is then judged on its own, and a street with no city beside it
/// carries only one kind of evidence, so it used to be dropped. Standalone
/// street detection is off here, matching the shipped default, so the run
/// evidence is what has to keep the street.
#[test]
fn keeps_both_halves_of_an_address_split_by_a_case_number() {
  let prepared = barrier_address_engine_with_threshold(0.7);

  let result = prepared
    .redact_static_entities(
      "Notices to 123 Main Street, Case No. 1:23-cv-04567, Paris 75002.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  let addresses = address_texts(&result);
  assert!(
    addresses.contains(&"123 Main Street"),
    "street half was dropped; addresses: {addresses:?}",
  );
  assert!(
    addresses.contains(&"Paris 75002"),
    "city half was dropped; addresses: {addresses:?}",
  );
  assert!(!result.redaction.redacted_text.contains("Main Street"));
  // The barrier still keeps the case number out of the address span.
  assert!(!result.redaction.redacted_text.contains("1:23-cv-04567"));
}

#[test]
fn entity_barriers_do_not_hide_residual_prose_between_address_seeds() {
  let prepared = barrier_address_engine();
  let result = prepared
    .redact_static_entities(
      "123 Main Street, Case No. 1:23-cv-04567, was transferred to Paris 75002.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  let addresses = address_texts(&result);
  assert!(!addresses.contains(&"123 Main Street"));
  assert!(addresses.contains(&"Paris 75002"));
}

#[test]
fn sentence_boundaries_outside_entities_separate_address_evidence() {
  let prepared = barrier_address_engine();
  for text in [
    "123 Main Street. Case No. 1:23-cv-04567. Paris 75002.",
    "123 Main Street. reference@example.test. Paris 75002.",
  ] {
    let result = prepared
      .redact_static_entities(text, &OperatorConfig::default())
      .expect("static redaction should succeed");

    let addresses = address_texts(&result);
    assert!(!addresses.contains(&"123 Main Street"));
    assert!(addresses.contains(&"Paris 75002"));
  }
}

#[test]
fn unsegmented_residual_prose_separates_address_evidence() {
  let prepared = barrier_address_engine();
  let result = prepared
    .redact_static_entities(
      "123 Main Street, Case No. 1:23-cv-04567, これは無関係な文章です Paris 75002.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  let addresses = address_texts(&result);
  assert!(!addresses.contains(&"123 Main Street"));
  assert!(addresses.contains(&"Paris 75002"));
}

#[test]
fn lowercase_entity_contents_do_not_count_as_residual_prose() {
  let prepared = barrier_address_engine();
  let result = prepared
    .redact_static_entities(
      "Notices to 123 Main Street, reference@example.test, Paris 75002.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  let addresses = address_texts(&result);
  assert!(addresses.contains(&"123 Main Street"));
  assert!(addresses.contains(&"Paris 75002"));
}

#[test]
fn city_fragments_do_not_grow_over_capitalized_prose() {
  let prepared = barrier_address_engine();
  let result = prepared
    .redact_static_entities(
      "123 Main Street, Case No. 1:23-cv-04567, Paris Meridian Capital signed.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  let addresses = address_texts(&result);
  assert!(addresses.contains(&"123 Main Street"));
  assert!(
    !addresses.iter().any(|address| address.contains("Capital")),
    "address entities: {addresses:?}; address seeds: {:?}",
    result.detections.entities.address_seed(),
  );
}

#[test]
fn paragraph_barriers_keep_unrelated_address_evidence_separate() {
  let prepared = barrier_address_engine();
  let paragraph_result = prepared
    .redact_static_entities(
      "The filing mentions 123 Main Street.\n\nParis 75002.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");
  let paragraph_addresses = address_texts(&paragraph_result);
  assert!(
    !paragraph_addresses.contains(&"123 Main Street"),
    "unrelated street borrowed evidence across a paragraph: {paragraph_addresses:?}",
  );
  assert!(
    paragraph_addresses.contains(&"Paris 75002"),
    "self-contained city and postal code were dropped: {paragraph_addresses:?}",
  );

  for separator in [
    "\n\n",
    "\r\n\r\n",
    "\u{000c}",
    "\u{2028}\u{2028}",
    "\u{2029}",
  ] {
    let text = format!(
      "The filing mentions 123 Main Street.{separator}1:23-cv-04567{separator}Paris 75002."
    );
    let separator_result = prepared
      .redact_static_entities(&text, &OperatorConfig::default())
      .expect("static redaction should succeed");

    let separator_addresses = address_texts(&separator_result);
    assert!(
      !separator_addresses.contains(&"123 Main Street"),
      "unrelated street borrowed evidence across {separator:?}: {separator_addresses:?}",
    );
  }
}

#[test]
fn clusters_address_seeds_across_multibyte_text_gap() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Springfield"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Street"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
    ],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      street_types: PatternSlice { start: 1, end: 2 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Springfield")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .expect("address seed data should prepare");
  let gap = "á".repeat(140);
  let full_text =
    format!("Send notices to Main Street, {gap} Springfield 12345.");

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .expect("static redaction should succeed");

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.text.contains("Main Street")
        && entity.text.contains("Springfield 12345")),
    "resolved address entities: {:?}; address seed entities: {:?}",
    result.resolved_entities,
    result.detections.entities.address_seed(),
  );
}

#[test]
fn preserves_unit_abbreviation_inside_address_seed_span() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Springfield"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Street"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
    ],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      street_types: PatternSlice { start: 1, end: 2 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Springfield")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData {
      boundary_words: Vec::new(),
      br_cep_cue_words: Vec::new(),
      unit_abbreviations: vec![String::from("apt.")],
      ..AddressSeedData::default()
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .expect("address seed data should prepare");

  for designator in ["Apt.", "Apt"] {
    let suffix = "á".repeat(97);
    let full_text = format!(
      "Notices go to 10 Main Street, Springfield 12345 {designator} 5 {suffix}. Thank you."
    );
    let result = prepared
      .redact_static_entities(&full_text, &OperatorConfig::default())
      .expect("static redaction should succeed");
    let expected =
      format!("10 Main Street, Springfield 12345 {designator} 5 {suffix}");

    assert!(
      address_texts(&result).contains(&expected.as_str()),
      "resolved address entities: {:?}; address seed entities: {:?}",
      result.resolved_entities,
      result.detections.entities.address_seed(),
    );
    assert!(!result.redaction.redacted_text.contains(&suffix));
  }
}

/// Fixture for the city-anchored / standalone street cases: "Paris" as a
/// deny-list city, a street-type slice covering the words the cases need.
fn street_engine(standalone: Option<StandaloneStreetData>) -> PreparedEngine {
  let literal = |pattern: &str| SearchPattern::LiteralWithOptions {
    pattern: String::from(pattern),
    case_insensitive: Some(true),
    whole_words: Some(true),
  };
  PreparedEngine::new(prepared_config! {
    literal_patterns: vec![
      literal("Paris"),
      literal("Springfield"),
      literal("Send"),
      literal("Rue"),
      literal("Street"),
      literal("Straße"),
      literal("calle"),
    ],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 3 },
      street_types: PatternSlice { start: 3, end: 7 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      // "Send" is a real place name that is also an ordinary English word;
      // the city dictionaries carry it, which is what made a sentence join a
      // street cluster.
      labels: vec![vec![String::from("address")]; 3].into(),
      custom_labels: vec![vec![]; 3].into(),
      originals: vec![
        String::from("Paris"),
        String::from("Springfield"),
        String::from("Send"),
      ],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]; 3].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData {
      unit_abbreviations: vec![String::from("apt."), String::from("unit.")],
      standalone_street: standalone,
      ..AddressSeedData::default()
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .expect("address seed data should prepare")
}

fn street_addresses(prepared: &PreparedEngine, full_text: &str) -> Vec<String> {
  let result = prepared
    .redact_static_entities(full_text, &OperatorConfig::default())
    .expect("static redaction should succeed");
  address_texts(&result)
    .into_iter()
    .map(ToOwned::to_owned)
    .collect()
}

#[test]
fn address_span_ends_at_the_city_not_the_conjunction_that_follows() {
  let prepared = street_engine(None);

  assert_eq!(
    street_addresses(
      &prepared,
      "Notices to the offices of 14 Rue de la Paix, Paris, and Meridian shall apply.",
    ),
    vec![String::from("14 Rue de la Paix, Paris")],
  );
}

#[test]
fn address_span_ends_at_the_city_not_the_prose_that_follows() {
  let prepared = street_engine(None);

  assert_eq!(
    street_addresses(
      &prepared,
      "Notices to the offices of 14 Rue de la Paix, Paris last year.",
    ),
    vec![String::from("14 Rue de la Paix, Paris")],
  );
}

#[test]
fn address_span_still_grows_past_a_city_followed_by_a_postal_code() {
  let prepared = street_engine(None);

  assert_eq!(
    street_addresses(
      &prepared,
      "Notices go to 10 Rue Verte, Paris 75002 Apt. 5."
    ),
    vec![String::from("10 Rue Verte, Paris 75002 Apt. 5")],
  );
}

#[test]
fn standalone_street_detection_is_off_by_default() {
  let prepared = street_engine(None);

  for text in ["14 Rue de la Paix", "123 Main Street", "Hauptstraße 5"] {
    assert!(
      street_addresses(&prepared, text).is_empty(),
      "unexpected address in {text:?}",
    );
  }
}

#[test]
fn standalone_street_detection_accepts_a_house_number_in_either_order() {
  let prepared = street_engine(Some(StandaloneStreetData {
    street_type_words: ["Rue", "Street", "Straße"]
      .into_iter()
      .map(String::from)
      .collect(),
  }));

  assert_eq!(
    street_addresses(&prepared, "14 Rue de la Paix"),
    vec![String::from("14 Rue de la Paix")],
  );
  assert_eq!(
    street_addresses(&prepared, "123 Main Street"),
    vec![String::from("123 Main Street")],
  );
  // "Hauptstraße" never reaches the whole-word street-type automaton; the
  // compound tail index standalone mode carries is what seeds it.
  assert_eq!(
    street_addresses(&prepared, "Hauptstraße 5"),
    vec![String::from("Hauptstraße 5")],
  );
}

#[test]
fn standalone_street_detection_requires_a_house_number() {
  let prepared = street_engine(Some(StandaloneStreetData {
    street_type_words: ["Rue", "Street", "Straße"]
      .into_iter()
      .map(String::from)
      .collect(),
  }));

  for text in ["Main Street", "Rue de la Paix", "Hauptstraße"] {
    assert!(
      street_addresses(&prepared, text).is_empty(),
      "unexpected address in {text:?}",
    );
  }
}

#[test]
fn standalone_street_span_stops_at_the_prose_after_the_street_name() {
  let prepared = street_engine(Some(StandaloneStreetData {
    street_type_words: ["Rue", "Street", "Straße"]
      .into_iter()
      .map(String::from)
      .collect(),
  }));

  assert_eq!(
    street_addresses(
      &prepared,
      "Our office at 14 Rue de la Paix are closed on Monday."
    ),
    vec![String::from("14 Rue de la Paix")],
  );
}

#[test]
fn multi_line_notice_block_still_joins_street_and_destination_lines() {
  let prepared = street_engine(None);

  assert_eq!(
    street_addresses(&prepared, "ACME Corp\n10 Rue Verte\nParis 75002"),
    vec![String::from("10 Rue Verte Paris 75002")],
  );
}

#[test]
fn address_span_keeps_a_unit_component_that_follows_the_city() {
  let prepared = street_engine(None);

  for (unit, expected) in [
    ("Apt. 5", "10 Main Street, Springfield Apt. 5"),
    ("Apt A", "10 Main Street, Springfield Apt A"),
    ("Apt. PH1", "10 Main Street, Springfield Apt. PH1"),
    ("Apt A12", "10 Main Street, Springfield Apt A12"),
    ("Apt Ä1", "10 Main Street, Springfield Apt Ä1"),
    ("Apt. A-12", "10 Main Street, Springfield Apt. A-12"),
    ("Apt. PH-1", "10 Main Street, Springfield Apt. PH-1"),
    ("Apt. 12-B", "10 Main Street, Springfield Apt. 12-B"),
    ("Apt. ５", "10 Main Street, Springfield Apt. ５"),
    ("Apt. ٥", "10 Main Street, Springfield Apt. ٥"),
    ("Apt. ५", "10 Main Street, Springfield Apt. ५"),
    (
      "Apt. A\u{0308}1",
      "10 Main Street, Springfield Apt. A\u{0308}1",
    ),
    ("Apt.\u{2028}5", "10 Main Street, Springfield Apt.\u{2028}5"),
  ] {
    let text = format!("Notices go to 10 Main Street, Springfield {unit}.");
    assert_eq!(
      street_addresses(&prepared, &text),
      vec![String::from(expected)]
    );
  }
}

#[test]
fn address_span_requires_a_value_after_an_ambiguous_unit_alias() {
  let prepared = street_engine(None);

  assert_eq!(
    street_addresses(
      &prepared,
      "Notices go to 10 Main Street, Springfield unit tests failed."
    ),
    vec![String::from("10 Main Street, Springfield")],
  );
  assert_eq!(
    street_addresses(
      &prepared,
      "Notices go to 10 Main Street, Springfield unit ph-1 tests failed."
    ),
    vec![String::from("10 Main Street, Springfield")],
  );
  for unsupported_numeral in ["½", "Ⅻ"] {
    assert_eq!(
      street_addresses(
        &prepared,
        &format!(
          "Notices go to 10 Main Street, Springfield unit {unsupported_numeral} tests failed."
        )
      ),
      vec![String::from("10 Main Street, Springfield")],
    );
  }
}

#[test]
fn address_span_stops_after_an_ambiguous_unit_value() {
  let prepared = street_engine(None);

  assert_eq!(
    street_addresses(
      &prepared,
      "Notices go to 10 Main Street, Springfield unit 5 tests failed."
    ),
    vec![String::from("10 Main Street, Springfield unit 5")],
  );
}

#[test]
fn address_span_ends_at_the_city_when_no_unit_component_follows() {
  let prepared = street_engine(None);

  assert_eq!(
    street_addresses(
      &prepared,
      "Notices go to 10 Main Street, Springfield and Meridian signs."
    ),
    vec![String::from("10 Main Street, Springfield")],
  );
}

fn standalone_engine() -> PreparedEngine {
  street_engine(Some(StandaloneStreetData {
    street_type_words: ["Rue", "Street", "Straße"]
      .into_iter()
      .map(String::from)
      .collect(),
  }))
}

#[test]
fn standalone_street_span_excludes_leading_prose() {
  let prepared = standalone_engine();

  // "Send" is a deny-list city, so it seeds a cluster four words to the left
  // of the street word. The sentence between them must keep the two apart.
  let found = street_addresses(&prepared, "Send it to 14 Rue de la Paix.");

  assert!(
    found.iter().any(|text| text == "14 Rue de la Paix"),
    "address entities: {found:?}",
  );
  assert!(
    !found.iter().any(|text| text.contains("it to")),
    "address entities: {found:?}",
  );
}

#[test]
fn standalone_street_span_excludes_leading_prose_in_german() {
  let prepared = standalone_engine();

  assert_eq!(
    street_addresses(&prepared, "Bitte an Hauptstraße 5 senden."),
    vec![String::from("Hauptstraße 5")],
  );
}

#[test]
fn standalone_street_span_keeps_a_multi_word_street_name() {
  let prepared = standalone_engine();

  assert_eq!(
    street_addresses(&prepared, "221B Baker Street"),
    vec![String::from("221B Baker Street")],
  );
  assert_eq!(
    street_addresses(&prepared, "14 Rue de la Paix"),
    vec![String::from("14 Rue de la Paix")],
  );
}

#[test]
fn standalone_street_span_stops_at_a_capitalized_prose_run() {
  let prepared = standalone_engine();

  // Nothing left of the house number belongs to the street, however many
  // capitalized words precede it.
  assert_eq!(
    street_addresses(&prepared, "Alpha Beta Gamma 14 Rue de la Paix"),
    vec![String::from("14 Rue de la Paix")],
  );
}

#[test]
fn city_anchored_span_excludes_leading_prose() {
  let prepared = street_engine(None);

  assert_eq!(
    street_addresses(&prepared, "Registered at 14 Rue de la Paix, Paris"),
    vec![String::from("14 Rue de la Paix, Paris")],
  );
  let found =
    street_addresses(&prepared, "Send it to 14 Rue de la Paix, Paris.");
  assert!(
    found.iter().any(|text| text == "14 Rue de la Paix, Paris"),
    "address entities: {found:?}",
  );
  assert!(
    !found.iter().any(|text| text.contains("it to")),
    "address entities: {found:?}",
  );
}

#[test]
fn address_span_joins_a_lowercase_multi_word_street_name() {
  let prepared = street_engine(None);

  // French street names carry lowercase name words ("paix", "liberté") and a
  // connective ("et") that no particle list enumerates. Once the street word
  // is in the cluster, those words are street-name material.
  assert_eq!(
    street_addresses(&prepared, "10 rue de la paix et de la liberté, Paris",),
    vec![String::from("10 rue de la paix et de la liberté, Paris")],
  );
}

#[test]
fn address_span_joins_a_lowercase_spanish_street_name() {
  let prepared = street_engine(None);

  // A two-digit house number: the generic left expansion skips single
  // characters, which is unrelated to the connective under test here.
  assert_eq!(
    street_addresses(&prepared, "15 calle de la paz y de la libertad, Paris"),
    vec![String::from("15 calle de la paz y de la libertad, Paris")],
  );
}

#[test]
fn prose_before_a_street_word_still_ends_the_cluster() {
  let prepared = street_engine(None);

  // The barrier only guards a gap that has not reached a street word yet, so
  // the sentence in front of the address must still split it.
  let found =
    street_addresses(&prepared, "Send it to 10 rue de la paix, Paris");
  assert!(
    found.iter().any(|text| text == "10 rue de la paix, Paris"),
    "address entities: {found:?}",
  );
  assert!(
    !found.iter().any(|text| text.contains("it to")),
    "address entities: {found:?}",
  );
}

#[test]
fn standalone_street_span_keeps_a_non_ascii_unit_letter() {
  let prepared = standalone_engine();

  // The unit letter is one character, not the two bytes it encodes to.
  assert_eq!(
    street_addresses(&prepared, "Hauptstraße 5Ä"),
    vec![String::from("Hauptstraße 5Ä")],
  );
}

#[test]
fn a_header_number_does_not_join_a_later_street_address() {
  let prepared = street_engine(None);

  // A bare five-digit number in a docket header seeds a postal code. It must
  // not reach across the sentence to the address that follows; this is the
  // shape behind the refreshed digest in the address-seed scaling suite.
  let found = street_addresses(
    &prepared,
    "Notice 12345: send process to 100 Main Street, Springfield 02101.",
  );

  assert!(
    found
      .iter()
      .any(|text| text == "100 Main Street, Springfield 02101"),
    "address entities: {found:?}",
  );
  assert!(
    !found.iter().any(|text| text.contains("Notice")),
    "address entities: {found:?}",
  );
}
