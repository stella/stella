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

  let suffix = "á".repeat(97);
  let full_text = format!(
    "Notices go to 10 Main Street, Springfield 12345 Apt. 5 {suffix}. Thank you."
  );
  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .expect("static redaction should succeed");
  let expected = format!("10 Main Street, Springfield 12345 Apt. 5 {suffix}");

  assert!(
    address_texts(&result).contains(&expected.as_str()),
    "resolved address entities: {:?}; address seed entities: {:?}",
    result.resolved_entities,
    result.detections.entities.address_seed(),
  );
  assert!(!result.redaction.redacted_text.contains("Apt. 5"));
  assert!(!result.redaction.redacted_text.contains(&suffix));
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
      literal("Rue"),
      literal("Street"),
      literal("Straße"),
    ],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 2 },
      street_types: PatternSlice { start: 2, end: 5 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")], vec![String::from("address")]]
        .into(),
      custom_labels: vec![vec![], vec![]].into(),
      originals: vec![String::from("Paris"), String::from("Springfield")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")], vec![String::from("city")]]
        .into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData {
      unit_abbreviations: vec![String::from("apt.")],
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

  // "Apt. 5" is not an address seed, so the city is the cluster's rightmost
  // seed; the unit abbreviation still belongs to the address.
  assert_eq!(
    street_addresses(
      &prepared,
      "Notices go to 10 Main Street, Springfield Apt. 5."
    ),
    vec![String::from("10 Main Street, Springfield Apt. 5")],
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
