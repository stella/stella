#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;
use std::time::Instant;

use sha2::{Digest, Sha256};
use stella_anonymize_core::{
  AddressContextData, AddressSeedData, AmountWordsData, CallerDetection,
  CallerDetectionParams, CallerRedactionOptions, CoreferenceData,
  CoreferencePatternData, CountryMatchData, CountryVariant, CurrencyData,
  DateData, DenyListFilterData, DenyListMatchData, DetectionSource,
  DiagnosticEventKind, DiagnosticStage, EntityKind, Error, FuzzySearchOptions,
  GazetteerMatchData, HotwordRule, HotwordRuleData, LegalFormData,
  LiteralSearchOptions, MagnitudeSuffixData, MonetaryData, OperatorConfig,
  PERSON_OR_ORGANIZATION_TRIGGER_LABEL, PatternSlice, PreparedEngine,
  PreparedEngineArtifacts, PreparedEngineConfig, PreparedEngineSlices,
  PreparedSessionCallerRedactionOptions, PreparedSessionRedactionOptions,
  REDACTION_TEXT_MAX_BYTES, RedactionSession, RegexMatchMeta,
  RegexSearchOptions, SearchOptions, SearchPattern, SessionId,
  SessionLifecycle, SessionTimestamp, SignatureData, SourceDetail, TriggerData,
  TriggerRule, TriggerStrategy, TriggerValidation, WrittenAmountPatternData,
  ZoneData, ZonePatternData, ZoneSigningClauseData, redact_text,
  redact_text_with_session,
};
use support::prepared_config;

#[test]
fn caller_detections_use_the_shared_resolution_and_redaction_pipeline() {
  let prepared = PreparedEngine::new(prepared_config! {
    threshold: 0.5,
    allowed_labels: vec![String::from("person")],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let detections = vec![
    caller_detection(CallerDetectionParams {
      start: 0,
      end: 5,
      label: String::from("person"),
      score: 0.9,
      provider_id: String::from("test-provider"),
      detection_id: String::from("person-1"),
    })
    .unwrap(),
  ];

  let result = prepared
    .redact_static_entities_with_caller_detections(
      "Alice signed.",
      CallerRedactionOptions {
        operators: &OperatorConfig::default(),
        detections: &detections,
      },
    )
    .unwrap();

  assert_eq!(result.resolved_entities.len(), 1);
  assert_eq!(result.resolved_entities[0].text, "Alice");
  assert_eq!(result.resolved_entities[0].source, DetectionSource::Caller);
  assert_eq!(
    result.resolved_entities[0]
      .caller_provenance
      .as_ref()
      .map(|provenance| (provenance.provider_id(), provenance.detection_id())),
    Some(("test-provider", "person-1"))
  );
  assert_eq!(result.redaction.redacted_text, "[PERSON_1] signed.");

  let below_threshold = vec![
    caller_detection(CallerDetectionParams {
      start: 0,
      end: 5,
      label: String::from("person"),
      score: 0.4,
      provider_id: String::from("test-provider"),
      detection_id: String::from("person-2"),
    })
    .unwrap(),
  ];
  let below_threshold_result = prepared
    .redact_static_entities_with_caller_detections(
      "Alice signed.",
      CallerRedactionOptions {
        operators: &OperatorConfig::default(),
        detections: &below_threshold,
      },
    )
    .unwrap();
  assert!(below_threshold_result.resolved_entities.is_empty());
  assert_eq!(
    below_threshold_result.redaction.redacted_text,
    "Alice signed."
  );
}

#[test]
fn address_only_selection_keeps_same_span_address_evidence() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      "Merritt, FL 32953",
    ))],
    custom_regex_patterns: vec![SearchPattern::Regex(String::from(
      "Merritt, FL 32953",
    ))],
    regex_meta: vec![RegexMatchMeta::new("person", 0.9)],
    custom_regex_meta: vec![RegexMatchMeta::new("address", 0.9)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      custom_regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    allowed_labels: vec![String::from("address")],
    threshold: 0.3,
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities("Merritt, FL 32953", &OperatorConfig::default())
    .unwrap();

  assert_eq!(result.resolved_entities.len(), 1);
  assert_eq!(result.resolved_entities[0].label, "address");
  assert_eq!(result.redaction.redacted_text, "[ADDRESS_1]");
}

#[test]
fn caller_detections_reuse_session_placeholders_across_documents() {
  let prepared = PreparedEngine::new(prepared_config! {
    threshold: 0.5,
    allowed_labels: vec![String::from("person")],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let mut session =
    RedactionSession::new(SessionId::new("case_1").expect("valid id"));
  let first_detections = [caller_detection(CallerDetectionParams {
    start: 0,
    end: 5,
    label: String::from("person"),
    score: 0.9,
    provider_id: String::from("test-provider"),
    detection_id: String::from("first-person"),
  })
  .unwrap()];
  let second_detections = [caller_detection(CallerDetectionParams {
    start: 0,
    end: 5,
    label: String::from("person"),
    score: 0.9,
    provider_id: String::from("test-provider"),
    detection_id: String::from("second-person"),
  })
  .unwrap()];

  let first = prepared
    .redact_static_entities_with_caller_detections_and_session(
      "Alice signed.",
      PreparedSessionCallerRedactionOptions {
        operators: &OperatorConfig::default(),
        detections: &first_detections,
        session: &mut session,
        observed_at: None,
      },
    )
    .unwrap();
  let second = prepared
    .redact_static_entities_with_caller_detections_and_session(
      "Alice replied.",
      PreparedSessionCallerRedactionOptions {
        operators: &OperatorConfig::default(),
        detections: &second_detections,
        session: &mut session,
        observed_at: None,
      },
    )
    .unwrap();

  assert_eq!(first.redaction.redacted_text, "[PERSON_case%5F1_1] signed.");
  assert_eq!(
    second.redaction.redacted_text,
    "[PERSON_case%5F1_1] replied."
  );
  assert_eq!(first.redaction.replacements.len(), 1);
  assert_eq!(first.redaction.replacements[0].start, 0);
  assert_eq!(first.redaction.replacements[0].end, 5);
  assert_eq!(
    first.redaction.replacements[0].replacement,
    "[PERSON_case%5F1_1]"
  );
  assert_eq!(session.mapping_count(), 1);
}

#[test]
fn caller_detections_reject_offsets_inside_utf8_codepoints() {
  let prepared =
    PreparedEngine::new(empty_config(PreparedEngineSlices::default())).unwrap();
  let detections = vec![
    caller_detection(CallerDetectionParams {
      start: 1,
      end: 2,
      label: String::from("person"),
      score: 0.9,
      provider_id: String::from("test-provider"),
      detection_id: String::from("person-1"),
    })
    .unwrap(),
  ];

  let error = prepared
    .redact_static_entities_with_caller_detections(
      "é signed.",
      CallerRedactionOptions {
        operators: &OperatorConfig::default(),
        detections: &detections,
      },
    )
    .unwrap_err();

  assert_eq!(error, Error::ByteOffsetInsideCodepoint { offset: 1 });
}

#[test]
fn deterministic_detections_win_equal_span_conflicts_with_callers() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Literal(String::from("Alice"))],
    regex_meta: vec![RegexMatchMeta::new("person", 0.8)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("person")],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let detections = vec![
    caller_detection(CallerDetectionParams {
      start: 0,
      end: 5,
      label: String::from("person"),
      score: 1.0,
      provider_id: String::from("test-provider"),
      detection_id: String::from("person-1"),
    })
    .unwrap(),
  ];

  let result = prepared
    .redact_static_entities_with_caller_detections(
      "Alice signed.",
      CallerRedactionOptions {
        operators: &OperatorConfig::default(),
        detections: &detections,
      },
    )
    .unwrap();

  assert_eq!(result.resolved_entities.len(), 1);
  assert_eq!(result.resolved_entities[0].source, DetectionSource::Regex);
}

#[test]
fn caller_detection_constructor_rejects_invalid_fields() {
  assert!(
    caller_detection(CallerDetectionParams {
      start: 5,
      end: 5,
      label: String::from("person"),
      score: 0.9,
      provider_id: String::from("test-provider"),
      detection_id: String::from("person-1"),
    })
    .is_err()
  );
  assert!(
    caller_detection(CallerDetectionParams {
      start: 0,
      end: 5,
      label: String::from("  "),
      score: 0.9,
      provider_id: String::from("test-provider"),
      detection_id: String::from("person-1"),
    })
    .is_err()
  );
  assert!(
    caller_detection(CallerDetectionParams {
      start: 0,
      end: 5,
      label: String::from("person"),
      score: f64::NAN,
      provider_id: String::from("test-provider"),
      detection_id: String::from("person-1"),
    })
    .is_err()
  );
  assert!(
    caller_detection(CallerDetectionParams {
      start: 0,
      end: 5,
      label: String::from("person"),
      score: 1.1,
      provider_id: String::from("test-provider"),
      detection_id: String::from("person-1"),
    })
    .is_err()
  );
  assert!(matches!(
    caller_detection(CallerDetectionParams {
      start: 0,
      end: 5,
      label: String::from("person"),
      score: 0.9,
      provider_id: String::from("contains whitespace"),
      detection_id: String::from("person-1"),
    }),
    Err(Error::InvalidCallerDetection {
      field: "provider_id",
      ..
    })
  ));
}

#[test]
fn caller_diagnostics_report_provenance_and_retention_without_text() {
  let prepared = PreparedEngine::new(prepared_config! {
    threshold: 0.5,
    allowed_labels: vec![String::from("person")],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let detections = vec![
    caller_detection(CallerDetectionParams {
      start: 0,
      end: 5,
      label: String::from("person"),
      score: 0.9,
      provider_id: String::from("test-provider"),
      detection_id: String::from("person-1"),
    })
    .unwrap(),
    caller_detection(CallerDetectionParams {
      start: 13,
      end: 16,
      label: String::from("person"),
      score: 0.4,
      provider_id: String::from("test-provider"),
      detection_id: String::from("person-2"),
    })
    .unwrap(),
  ];

  let result = prepared
    .redact_static_entities_with_caller_detections_and_diagnostics(
      "Alice signed Bob",
      CallerRedactionOptions {
        operators: &OperatorConfig::default(),
        detections: &detections,
      },
    )
    .unwrap();
  let input_summary = result
    .diagnostics
    .events
    .iter()
    .find(|event| {
      event.stage == DiagnosticStage::EntityCallerInput
        && event.kind == DiagnosticEventKind::StageSummary
    })
    .unwrap();
  let retained_summary = result
    .diagnostics
    .events
    .iter()
    .find(|event| {
      event.stage == DiagnosticStage::EntityCallerRetained
        && event.kind == DiagnosticEventKind::StageSummary
    })
    .unwrap();
  assert_eq!(input_summary.count, Some(2));
  assert_eq!(retained_summary.count, Some(1));
  assert!(
    result
      .diagnostics
      .events
      .iter()
      .all(|event| event.text.is_none())
  );
  assert!(result.diagnostics.events.iter().any(|event| {
    event.provider_id.as_deref() == Some("test-provider")
      && event.detection_id.as_deref() == Some("person-1")
  }));
}

#[test]
fn caller_detection_identities_are_unique_per_request() {
  let prepared =
    PreparedEngine::new(empty_config(PreparedEngineSlices::default())).unwrap();
  let detection = caller_detection(CallerDetectionParams {
    start: 0,
    end: 5,
    label: String::from("person"),
    score: 0.9,
    provider_id: String::from("test-provider"),
    detection_id: String::from("person-1"),
  })
  .unwrap();
  let error = prepared
    .redact_static_entities_with_caller_detections(
      "Alice signed.",
      CallerRedactionOptions {
        operators: &OperatorConfig::default(),
        detections: &[detection.clone(), detection],
      },
    )
    .unwrap_err();
  assert!(matches!(
    error,
    Error::InvalidCallerDetection {
      field: "detection_id",
      ..
    }
  ));
}

fn caller_detection(
  params: CallerDetectionParams,
) -> stella_anonymize_core::Result<CallerDetection> {
  CallerDetection::new(params)
}

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

fn legal_form_prepared_engine(suffixes: Vec<&str>) -> PreparedEngine {
  let suffix_strings = suffixes
    .iter()
    .map(|suffix| (*suffix).to_owned())
    .collect::<Vec<_>>();
  let regex_patterns = suffixes
    .into_iter()
    .map(|suffix| SearchPattern::Literal(suffix.to_owned()))
    .collect::<Vec<_>>();

  PreparedEngine::new(prepared_config! {
    regex_patterns: regex_patterns,
    regex_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: false,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      legal_forms: PatternSlice {
        start: 0,
        end: u32::try_from(suffix_strings.len()).unwrap(),
      },
      ..PreparedEngineSlices::default()
    },
    legal_form_data: Some(LegalFormData {
      suffixes: suffix_strings,
      normalized_boundary_suffixes: vec![
        String::from("as"),
        String::from("co"),
        String::from("inc"),
        String::from("ltd"),
        String::from("llc"),
        String::from("pty"),
        String::from("sro"),
      ],
      normalized_in_name_words: vec![String::from("co")],
      normalized_suffix_words: vec![
        String::from("as"),
        String::from("co"),
        String::from("inc"),
        String::from("ltd"),
        String::from("llc"),
        String::from("pty"),
        String::from("sro"),
      ],
      connector_words: vec![
        String::from("&"),
        String::from("a"),
        String::from("and"),
      ],
      and_connector_words: vec![String::from("and")],
      in_name_prepositions: vec![String::from("of")],
      company_suffix_words: vec![String::from("Company")],
      sentence_verb_indicators: vec![
        String::from("include"),
        String::from("is"),
        String::from("podepsaly"),
      ],
      ..LegalFormData::default()
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap()
}

fn address_context_data() -> AddressContextData {
  AddressContextData {
    address_prepositions: vec![String::from("na"), String::from("mezi")],
    temporal_prepositions: vec![String::from("od"), String::from("do")],
    street_abbreviations: vec![String::from("ul.")],
    bare_house_stopwords: vec![String::from("section")],
  }
}

fn zone_data() -> ZoneData {
  ZoneData {
    section_heading_patterns: vec![ZonePatternData {
      pattern: String::from(r"^\s*(?:Article|Článek)\s*1"),
      flags: String::from("iu"),
    }],
    signing_clauses: vec![ZoneSigningClauseData {
      prefix: String::from(r"(?:V|Ve)\s+"),
      suffix: String::from(r"\s*,?\s*dne"),
      prepositions: vec![String::from("nad")],
    }],
  }
}

fn coreference_data() -> CoreferenceData {
  CoreferenceData {
    definition_patterns: vec![
      CoreferencePatternData {
        pattern: String::from(
          r#"\((?:(?:together\s+with\s+its\s+affiliates,\s+)?the|hereinafter)\s+["'“‘]\s*([^"'”’]+?)\s*["'”’]\s+or\s+["'“‘]\s*([^"'”’]+?)\s*["'”’]\s*\)"#,
        ),
        flags: String::from("gi"),
      },
      CoreferencePatternData {
        pattern: String::from(r#"\((?:hereinafter|the)\s+["']([^"']+)["']\)"#),
        flags: String::from("gi"),
      },
    ],
    role_stop_terms: vec![String::from("seller"), String::from("company")],
    legal_form_aliases: vec![String::from("LLC")],
    organization_suffixes: vec![String::from("LLC")],
    organization_determiners: vec![String::from(
      r"the\s+(?:company|corporation|firm)",
    )],
  }
}

fn legal_form_coreference_prepared_engine(
  suffixes: Vec<&str>,
) -> PreparedEngine {
  let suffix_strings = suffixes
    .iter()
    .map(|suffix| (*suffix).to_owned())
    .collect::<Vec<_>>();
  let regex_patterns = suffixes
    .into_iter()
    .map(|suffix| SearchPattern::Literal(suffix.to_owned()))
    .collect::<Vec<_>>();

  PreparedEngine::new(prepared_config! {
    regex_patterns: regex_patterns,
    regex_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: false,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      legal_forms: PatternSlice {
        start: 0,
        end: u32::try_from(suffix_strings.len()).unwrap(),
      },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("organization")],
    legal_form_data: Some(LegalFormData {
      suffixes: suffix_strings.clone(),
      normalized_boundary_suffixes: vec![String::from("llc")],
      normalized_suffix_words: vec![String::from("llc")],
      company_suffix_words: vec![String::from("Company")],
      ..LegalFormData::default()
    }),
    coreference_data: Some(CoreferenceData {
      definition_patterns: vec![CoreferencePatternData {
        pattern: String::from(r#"\((?:hereinafter|the)\s+["']([^"']+)["']\)"#),
        flags: String::from("gi"),
      }],
      role_stop_terms: vec![String::from("seller")],
      legal_form_aliases: suffix_strings.clone(),
      organization_suffixes: suffix_strings,
      organization_determiners: vec![String::from(
        r"the\s+(?:company|corporation|firm)",
      )],
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap()
}

#[test]
fn prepared_engine_runs_legal_form_pass_on_normalized_text() {
  let prepared = legal_form_prepared_engine(vec!["Pty Ltd"]);
  let result = prepared
    .detect_static_entities("Acme Pty\u{00a0}Ltd signed the agreement.")
    .unwrap();

  assert_eq!(result.entities.legal_form().len(), 1);
  assert_eq!(result.entities.legal_form()[0].text, "Acme Pty\u{00a0}Ltd");
}

#[test]
fn prepared_engine_runs_normalized_literal_pass() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![],
    custom_regex_patterns: vec![],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Acme Corp"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: PreparedEngineSlices {
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![],
    custom_regex_meta: vec![],
    deny_list_data: None,
    false_positive_filters: None,
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
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
  })
  .unwrap();

  let result = prepared
    .detect_static_entities("Acme\u{00a0}Corp. signed")
    .unwrap();

  assert_eq!(result.entities.gazetteer().len(), 1);
  assert_eq!(result.entities.gazetteer()[0].text, "Acme\u{00a0}Corp");
}

#[test]
fn prepared_engine_adds_slash_house_number_address_context() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bPraha 2\b"))],
    regex_meta: vec![RegexMatchMeta::new("address", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Sídlo: Praha 2, Vinohradská 2512/2a",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.resolved_entities.iter().any(|entity| {
    entity.label == "address" && entity.text.contains("Vinohradská 2512/2a")
  }));
}

#[test]
fn prepared_engine_adds_orphan_header_street_line_context() {
  let full_text = format!(
    "ACME s.r.o.\nEvropská 710\n160 00 Praha\n{}",
    "body ".repeat(200)
  );
  let prepared = PreparedEngine::new(prepared_config! {
    custom_regex_patterns: vec![SearchPattern::Regex(String::from(
      r"ACME s\.r\.o\.",
    ))],
    custom_regex_meta: vec![RegexMatchMeta::new("organization", 1.0)],
    slices: PreparedEngineSlices {
      custom_regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("organization"), String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities_with_diagnostics(
      &full_text,
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.result.resolved_entities.iter().any(|entity| {
    entity.label == "address" && entity.text == "Evropská 710"
  }));
  assert!(result.diagnostics.events.iter().any(|event| {
    event.stage == DiagnosticStage::EntityAddressContext
      && event.kind == DiagnosticEventKind::StageSummary
      && event.count == Some(1)
  }));
}

#[test]
fn prepared_engine_keeps_address_context_above_threshold() {
  let full_text = format!(
    "ACME s.r.o.\nEvropská 710\n160 00 Praha\n{}",
    "body ".repeat(200)
  );
  let prepared = PreparedEngine::new(prepared_config! {
    custom_regex_patterns: vec![SearchPattern::Regex(String::from(
      r"ACME s\.r\.o\.",
    ))],
    custom_regex_meta: vec![RegexMatchMeta::new("organization", 1.0)],
    slices: PreparedEngineSlices {
      custom_regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.9,
    allowed_labels: vec![String::from("organization"), String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();

  assert!(result.resolved_entities.iter().any(|entity| {
    entity.label == "address"
      && entity.text == "Evropská 710"
      && entity.source_detail.is_none()
  }));
}

#[test]
fn prepared_engine_measures_bare_house_context_in_text_offsets() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bPraha 10\b"))],
    regex_meta: vec![RegexMatchMeta::new("address", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let full_text = format!("Praha 10 {} Evropská 710.", "á".repeat(40));

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.text == "Evropská 710")
  );
}

#[test]
fn prepared_engine_filters_capitalized_bare_house_stopwords() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bPraha 10\b"))],
    regex_meta: vec![RegexMatchMeta::new("address", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Praha 10 Section 183 follows.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    !result
      .resolved_entities
      .iter()
      .any(|entity| entity.text == "Section 183")
  );
}

#[test]
fn prepared_engine_measures_slash_address_context_in_text_offsets() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bPraha 10\b"))],
    regex_meta: vec![RegexMatchMeta::new("address", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let full_text = format!("Praha 10 {} Vinohradská 2512/2a.", "á".repeat(145));

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.text == "Vinohradská 2512/2a")
  );
}

#[test]
fn prepared_engine_finds_slash_address_context_after_long_multibyte_prefix() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bPraha 10\b"))],
    regex_meta: vec![RegexMatchMeta::new("address", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let full_text = format!(
    "{}\nPraha 10 {} Vinohradská 2512/2a.",
    "č".repeat(4_000),
    "á".repeat(145)
  );

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.text == "Vinohradská 2512/2a")
  );
}

#[test]
fn prepared_engine_finds_known_address_context_beyond_header_limit() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bPraha 10\b"))],
    regex_meta: vec![RegexMatchMeta::new("address", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let full_text = format!(
    "{}\nPraha 10; Vinohradská 2512/2a.",
    "contract body\n".repeat(3_000),
  );

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.text.contains("Vinohradská 2512/2a"))
  );
}

#[test]
fn address_context_large_document_output_digest_is_stable() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bPraha 10\b"))],
    regex_meta: vec![RegexMatchMeta::new("address", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let full_text = (0..400).fold(String::new(), |mut text, index| {
    writeln!(
      &mut text,
      "Clause {index}: Praha 10, Vinohradská 2512/2a. The terms continue."
    )
    .unwrap();
    text
  });

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();

  let address_text = "Praha 10, Vinohradská 2512/2a";
  let expected_address_spans = full_text
    .match_indices(address_text)
    .map(|(start, text)| (start, start.saturating_add(text.len())))
    .collect::<Vec<_>>();
  let actual_address_spans = result
    .resolved_entities
    .iter()
    .filter(|entity| entity.text == address_text)
    .map(|entity| {
      (
        usize::try_from(entity.start).unwrap_or(usize::MAX),
        usize::try_from(entity.end).unwrap_or(usize::MAX),
      )
    })
    .collect::<Vec<_>>();

  assert_eq!(result.resolved_entities.len(), 800);
  assert_eq!(result.redaction.entity_count, 800);
  assert_eq!(actual_address_spans, expected_address_spans);
  assert_eq!(
    result.redaction.redacted_text.matches("[ADDRESS_").count(),
    800,
  );
  assert!(!result.redaction.redacted_text.contains(address_text));
  assert_eq!(
    result
      .redaction
      .redacted_text
      .matches("The terms continue.")
      .count(),
    400,
  );

  assert_eq!(
    static_redaction_digest(&result),
    "c43269315ab1014bc5754596ac55d68a65956c2a6b42582d8b7bd9b908d7fec2",
  );
}

#[test]
#[ignore = "release-mode scaling regression check"]
fn address_context_cost_scales_with_input_size() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bPraha 10\b"))],
    regex_meta: vec![RegexMatchMeta::new("address", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let fixture = format!(
    "Clause: Praha 10, Vinohradská 2512/2a. {}\n",
    "The terms continue under this Agreement. ".repeat(48),
  );
  let sizes: [usize; 5] =
    [48 * 1024, 100 * 1024, 250 * 1024, 500 * 1024, 1024 * 1024];
  let mut samples = Vec::new();

  for target_bytes in sizes {
    let repeats = target_bytes.div_ceil(fixture.len());
    let text = fixture.repeat(repeats);
    let expected_entities = repeats;
    let warm = prepared
      .redact_static_entities(&text, &OperatorConfig::default())
      .unwrap();
    assert_eq!(warm.redaction.entity_count, expected_entities);

    let mut best: Option<std::time::Duration> = None;
    for _ in 0..5 {
      let start = Instant::now();
      let result = prepared
        .redact_static_entities(&text, &OperatorConfig::default())
        .unwrap();
      let elapsed = start.elapsed();
      assert_eq!(result.redaction.entity_count, expected_entities);
      std::hint::black_box(result);
      best = Some(best.map_or(elapsed, |current| current.min(elapsed)));
    }
    samples.push((text.len(), best.unwrap().as_nanos()));
  }

  let (smallest_bytes, smallest_nanos) = samples.first().copied().unwrap();
  let (largest_bytes, largest_nanos) = samples.last().copied().unwrap();
  assert!(
    largest_nanos.saturating_mul(u128::try_from(smallest_bytes).unwrap())
      <= smallest_nanos
        .saturating_mul(u128::try_from(largest_bytes).unwrap())
        .saturating_mul(4),
    "address-context time per byte regressed: {samples:?}",
  );
}

fn static_redaction_digest(
  result: &stella_anonymize_core::StaticRedactionResult,
) -> String {
  let mut hasher = Sha256::new();
  update_digest_field(&mut hasher, result.redaction.redacted_text.as_bytes());
  for entity in &result.resolved_entities {
    hasher.update(entity.start.to_le_bytes());
    hasher.update(entity.end.to_le_bytes());
    update_digest_field(&mut hasher, entity.label.as_bytes());
    update_digest_field(&mut hasher, entity.text.as_bytes());
    hasher.update(entity.score.to_bits().to_le_bytes());
    update_digest_field(
      &mut hasher,
      format!("{:?}:{:?}", entity.source, entity.source_detail).as_bytes(),
    );
  }
  let digest = hasher.finalize();
  let mut encoded = String::with_capacity(digest.len().saturating_mul(2));
  for byte in digest {
    write!(&mut encoded, "{byte:02x}").unwrap();
  }
  encoded
}

fn update_digest_field(hasher: &mut Sha256, value: &[u8]) {
  hasher.update(u64::try_from(value.len()).unwrap().to_le_bytes());
  hasher.update(value);
}

#[test]
fn prepared_engine_ignores_caller_owned_addresses_for_bare_house_context() {
  let mut meta = RegexMatchMeta::new("address", 1.0);
  meta.source_detail = Some(SourceDetail::CustomRegex);
  let prepared = PreparedEngine::new(prepared_config! {
    custom_regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\bPraha 2\b",
    ))],
    custom_regex_meta: vec![meta],
    slices: PreparedEngineSlices {
      custom_regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Delivery area Praha 2, Evropská 710.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    !result
      .resolved_entities
      .iter()
      .any(|entity| entity.text == "Evropská 710")
  );
}

#[test]
fn prepared_engine_measures_header_zone_in_text_offsets() {
  let full_text = format!(
    "{}\nACME s.r.o.\nEvropská 710\n{}",
    "body ".repeat(80),
    "é".repeat(2_000)
  );
  let prepared = PreparedEngine::new(prepared_config! {
    custom_regex_patterns: vec![SearchPattern::Regex(String::from(
      r"ACME s\.r\.o\.",
    ))],
    custom_regex_meta: vec![RegexMatchMeta::new("organization", 1.0)],
    slices: PreparedEngineSlices {
      custom_regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("organization"), String::from("address")],
    address_context_data: Some(address_context_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();

  assert!(
    !result
      .resolved_entities
      .iter()
      .any(|entity| entity.text == "Evropská 710")
  );
}

#[test]
fn prepared_engine_adds_coreference_aliases_with_source_placeholder() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"Acme Corporation",
    ))],
    regex_meta: vec![RegexMatchMeta::new("organization", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("organization")],
    coreference_data: Some(coreference_data()),
    name_corpus_data: None,
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      r#"Acme Corporation (the "Acme") signed. Acme later paid."#,
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.resolved_entities.iter().any(|entity| {
    entity.source == DetectionSource::Coreference && entity.text == "Acme"
  }));
  assert_eq!(
    result.redaction.redacted_text,
    r#"[ORGANIZATION_1] (the "[ORGANIZATION_1]") signed. [ORGANIZATION_1] later paid."#,
  );
}

#[test]
fn prepared_engine_accepts_validated_second_alias_and_rejects_generic_role() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"Acme Holdings, Inc\.",
    ))],
    regex_meta: vec![RegexMatchMeta::new("organization", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("organization")],
    coreference_data: Some(coreference_data()),
    name_corpus_data: None,
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Acme Holdings, Inc., a Delaware corporation (together with its affiliates, the “ Company ” or “ AHI ”), signed. AHI filed; Company remained.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.resolved_entities.iter().any(|entity| {
    let EntityKind::Coreference { source_text } = &entity.kind else {
      return false;
    };
    entity.text == "AHI" && source_text == "Acme Holdings, Inc."
  }));
  assert!(!result.resolved_entities.iter().any(|entity| {
    entity.source == DetectionSource::Coreference && entity.text == "Company"
  }));
  assert_eq!(
    result.redaction.redacted_text,
    "[ORGANIZATION_1], a Delaware corporation (together with its affiliates, the “ Company ” or “ [ORGANIZATION_1] ”), signed. [ORGANIZATION_1] filed; Company remained.",
  );
}

#[test]
fn prepared_engine_requires_compact_aliases_to_follow_word_initials() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"Intercontinental Exchange, Inc\.|Acme Corporation|The Acme Manufacturing Company",
    ))],
    regex_meta: vec![RegexMatchMeta::new("organization", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("organization")],
    coreference_data: Some(coreference_data()),
    name_corpus_data: None,
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Intercontinental Exchange, Inc. (the \"ICE\") filed. ICE responded. \
       Acme Corporation licensed a painting (the \"Artwork\" or \"ART\"). \
       ART remained on display. The Acme Manufacturing Company (the \"AMC\") \
       signed. AMC performed.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.resolved_entities.iter().any(|entity| {
    entity.source == DetectionSource::Coreference && entity.text == "ICE"
  }));
  assert!(!result.resolved_entities.iter().any(|entity| {
    entity.source == DetectionSource::Coreference && entity.text == "ART"
  }));
  assert!(result.resolved_entities.iter().any(|entity| {
    entity.source == DetectionSource::Coreference && entity.text == "AMC"
  }));
}

#[test]
fn prepared_engine_bounds_aliases_extracted_from_one_definition() {
  let mut data = coreference_data();
  data.definition_patterns = vec![CoreferencePatternData {
    pattern: String::from(
      r#"\(the\s+["']([^"']+)["']\s+or\s+["']([^"']+)["']\s+or\s+["']([^"']+)["']\)"#,
    ),
    flags: String::from("gi"),
  }];
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"Acme Corporation",
    ))],
    regex_meta: vec![RegexMatchMeta::new("organization", 1.0)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("organization")],
    coreference_data: Some(data),
    name_corpus_data: None,
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      r#"Acme Corporation (the "Acme" or "AC" or "ACME") signed. Acme and AC filed; ACME remained."#,
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.resolved_entities.iter().any(|entity| {
    entity.source == DetectionSource::Coreference && entity.text == "Acme"
  }));
  assert!(result.resolved_entities.iter().any(|entity| {
    entity.source == DetectionSource::Coreference && entity.text == "AC"
  }));
  assert!(!result.resolved_entities.iter().any(|entity| {
    entity.source == DetectionSource::Coreference && entity.text == "ACME"
  }));
}

#[test]
fn prepared_engine_propagates_bare_organization_names() {
  let prepared = legal_form_coreference_prepared_engine(vec!["LLC"]);

  let result = prepared
    .redact_static_entities(
      "Acme LLC signed. Acme paid.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.resolved_entities.iter().any(|entity| {
    entity.source == DetectionSource::Coreference && entity.text == "Acme"
  }));
  assert_eq!(
    result.redaction.redacted_text,
    "[ORGANIZATION_1] signed. [ORGANIZATION_1] paid.",
  );
}

#[test]
fn prepared_engine_extends_propagated_organization_determiners() {
  let prepared = legal_form_coreference_prepared_engine(vec!["LLC"]);

  let result = prepared
    .redact_static_entities(
      "Acme LLC signed. The Company Acme paid.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.resolved_entities.iter().any(|entity| {
    entity.source == DetectionSource::Coreference
      && entity.text == "The Company Acme"
  }));
  assert_eq!(
    result.redaction.redacted_text,
    "[ORGANIZATION_1] signed. [ORGANIZATION_1] paid.",
  );
}

#[test]
fn prepared_engine_uses_propagated_orgs_as_defined_term_sources() {
  let prepared = legal_form_coreference_prepared_engine(vec!["LLC"]);
  let full_text = format!(
    "Acme LLC signed. {} Acme (the \"Acme Platform\") paid. Acme Platform renewed.",
    "body ".repeat(50),
  );

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();

  assert!(result.resolved_entities.iter().any(|entity| {
    let EntityKind::Coreference { source_text } = &entity.kind else {
      return false;
    };
    entity.source == DetectionSource::Coreference
      && entity.text == "Acme Platform"
      && source_text == "Acme"
  }));
}

#[test]
fn prepared_engine_does_not_seed_coreference_from_caller_owned_entities() {
  let mut meta = RegexMatchMeta::new("organization", 1.0);
  meta.source_detail = Some(SourceDetail::CustomRegex);
  let prepared = PreparedEngine::new(prepared_config! {
    custom_regex_patterns: vec![SearchPattern::Regex(String::from(
      r"Acme Corporation",
    ))],
    custom_regex_meta: vec![meta],
    slices: PreparedEngineSlices {
      custom_regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("organization")],
    coreference_data: Some(coreference_data()),
    name_corpus_data: None,
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      r#"Acme Corporation (the "Acme") signed. Acme later paid."#,
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    !result
      .resolved_entities
      .iter()
      .any(|entity| { entity.source == DetectionSource::Coreference })
  );
}

#[test]
fn prepared_engine_rejects_role_and_legal_form_coreference_aliases() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![
      SearchPattern::Regex(String::from(r"Acme Corporation")),
      SearchPattern::Regex(String::from(r"Beta LLC")),
    ],
    regex_meta: vec![
      RegexMatchMeta::new("organization", 1.0),
      RegexMatchMeta::new("organization", 1.0),
    ],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 2 },
      ..PreparedEngineSlices::default()
    },
    threshold: 0.5,
    allowed_labels: vec![String::from("organization")],
    coreference_data: Some(coreference_data()),
    name_corpus_data: None,
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      r#"Acme Corporation (the "Seller") signed. Seller paid. Beta LLC (the "LLC") joined. LLC remained."#,
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    !result
      .resolved_entities
      .iter()
      .any(|entity| { entity.source == DetectionSource::Coreference })
  );
}

#[test]
fn prepared_engine_artifacts_match_direct_prepare() {
  let config = prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bID\d{3}\b"))],
    custom_regex_patterns: vec![],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Acme Corp"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("identifier", 1.0)],
    custom_regex_meta: vec![],
    deny_list_data: None,
    false_positive_filters: None,
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
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
  };
  let artifacts = PreparedEngine::prepare_artifacts(config.clone()).unwrap();
  assert!(
    !artifacts.literals.slots.is_empty(),
    "literal index should produce prepared artifacts"
  );

  let direct = PreparedEngine::new(config.clone()).unwrap();
  let prepared =
    PreparedEngine::new_with_artifacts(config.clone(), &artifacts).unwrap();
  let text = "Acme\u{00a0}Corp. signed ID123";

  assert_eq!(
    prepared.find_matches(text).unwrap(),
    direct.find_matches(text).unwrap()
  );

  let mut missing = artifacts;
  missing.literals.slots.clear();
  assert!(
    PreparedEngine::new_with_artifacts(config, &missing).is_err(),
    "missing literal artifacts should fail"
  );
}

#[test]
fn prepared_engine_artifacts_roundtrip_bytes() {
  let config = prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bID\d{3}\b"))],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Acme Corp"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("identifier", 1.0)],
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    ..empty_config(PreparedEngineSlices::default())
  };
  let artifacts = PreparedEngine::prepare_artifacts(config.clone()).unwrap();
  let bytes = artifacts.to_bytes().unwrap();
  let decoded = PreparedEngineArtifacts::from_bytes(&bytes).unwrap();

  assert_eq!(decoded, artifacts);

  let direct = PreparedEngine::new(config.clone()).unwrap();
  let prepared = PreparedEngine::new_with_artifacts(config, &decoded).unwrap();
  assert_eq!(
    prepared.find_matches("Acme Corp signed ID123").unwrap(),
    direct.find_matches("Acme Corp signed ID123").unwrap()
  );
}

#[test]
fn prepared_engine_artifacts_reject_invalid_bytes() {
  let error = PreparedEngineArtifacts::from_bytes(b"not-valid").unwrap_err();

  assert!(
    matches!(error, Error::InvalidStaticData { .. }),
    "invalid prepared-search artifacts should fail at the format boundary"
  );
}

fn turkey_country_match_data() -> CountryMatchData {
  CountryMatchData {
    labels: vec![String::from("country")],
    iso_codes: vec![String::from("TR")],
    variants: vec![CountryVariant::Name],
  }
}

#[test]
fn prepared_engine_emits_static_detector_entities() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b[A-Z]{2}\d{4}\b",
    ))],
    custom_regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\bMAT-\d{3}\b",
    ))],
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Acme"),
        case_insensitive: Some(true),
        whole_words: Some(false),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Turkey"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
    ],
    regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
        ..RegexSearchOptions::default()
      },
      ..SearchOptions::default()
    },
    custom_regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
        ..RegexSearchOptions::default()
      },
      ..SearchOptions::default()
    },
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      fuzzy: FuzzySearchOptions::default(),
      ..SearchOptions::default()
    },
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      custom_regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      countries: PatternSlice { start: 1, end: 2 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    custom_regex_meta: vec![RegexMatchMeta {
      label: String::from("matter id"),
      score: 1.0,
      source_detail: Some(SourceDetail::CustomRegex),
      requires_validation: false,
      validator_id: None,
      validator_input: None,
      min_byte_length: None,
    }],
    deny_list_data: None,
    false_positive_filters: None,
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    country_data: Some(turkey_country_match_data()),
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
  })
  .unwrap();

  let result = prepared
    .detect_static_entities("Acme s.r.o. filed AB1234 in Turkey under MAT-123")
    .unwrap();

  assert_eq!(result.entities.regex()[0].label, "registration number");
  assert_eq!(result.entities.custom_regex()[0].label, "matter id");
  assert_eq!(
    result.entities.custom_regex()[0].source_detail,
    Some(SourceDetail::CustomRegex)
  );
  assert_eq!(result.entities.gazetteer()[0].text, "Acme s.r.o.");
  assert_eq!(
    result.entities.country()[0].source,
    DetectionSource::Country
  );
}

#[test]
fn prepared_engine_extends_gazetteer_suffix_in_text_offsets() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Acme"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities("Acme spółka signed.", &OperatorConfig::default())
    .unwrap();

  assert!(result.resolved_entities.iter().any(|entity| {
    entity.label == "organization" && entity.text == "Acme spółka"
  }));
  assert_eq!(result.redaction.redacted_text, "[ORGANIZATION_1] signed.");
}

#[test]
fn prepared_engine_preserves_overlapping_custom_regex_matches() {
  let prepared = PreparedEngine::new(prepared_config! {
    custom_regex_patterns: vec![
      SearchPattern::Regex(String::from("Alice")),
      SearchPattern::Regex(String::from("Alice Smith")),
    ],
    custom_regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: true,
        ..RegexSearchOptions::default()
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      custom_regex: PatternSlice { start: 0, end: 2 },
      ..PreparedEngineSlices::default()
    },
    custom_regex_meta: vec![
      RegexMatchMeta {
        label: String::from("person"),
        score: 1.0,
        source_detail: Some(SourceDetail::CustomRegex),
        requires_validation: false,
        validator_id: None,
        validator_input: None,
        min_byte_length: None,
      },
      RegexMatchMeta {
        label: String::from("person"),
        score: 1.0,
        source_detail: Some(SourceDetail::CustomRegex),
        requires_validation: false,
        validator_id: None,
        validator_input: None,
        min_byte_length: None,
      },
    ],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities("Alice Smith signed.")
    .unwrap();
  let custom_texts = result
    .entities
    .custom_regex()
    .iter()
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();

  assert_eq!(custom_texts, ["Alice", "Alice Smith"]);
}

#[test]
fn prepared_engine_drops_person_spans_ending_in_trailing_noun() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\bCOBRA Reimbursement Period\b",
    ))],
    regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
        ..RegexSearchOptions::default()
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("person", 0.9)],
    deny_list_data: Some(DenyListMatchData {
      labels: Vec::new().into(),
      custom_labels: Vec::new().into(),
      originals: Vec::new(),
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: Vec::new().into(),
      filters: Some(DenyListFilterData {
        person_trailing_nouns: BTreeSet::from([String::from("period")]),
        ..DenyListFilterData::default()
      }),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Payments continue during the COBRA Reimbursement Period.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.resolved_entities.is_empty());
}

#[test]
fn prepared_engine_extracts_dates_from_anchored_data() {
  let prepared = PreparedEngine::new(prepared_config! {
    date_data: Some(DateData {
      month_names_by_language: BTreeMap::from([
        (
          String::from("en"),
          vec![
            String::from("January"),
            String::from("March"),
            String::from("December"),
          ],
        ),
        (
          String::from("cs"),
          vec![String::from("ledna"), String::from("únor")],
        ),
      ]),
      lowercase_month_ambiguities: BTreeMap::from([(
        String::from("en"),
        vec![String::from("March")],
      )]),
      year_words_by_language: BTreeMap::from([(
        String::from("cs"),
        vec![String::from("roce")],
      )]),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities(
      "Signed 7 January 2025, renewed March 9, 2026, effective 2026. únor 3., filed 1.ledna 2026 and signed 1. ledna 2026. Ends December 31, \n\n2025. Výpis v roce 2026.",
    )
    .unwrap();
  let entities = result
    .entities
    .anchored()
    .iter()
    .map(|entity| (entity.text.as_str(), entity.label.as_str(), entity.source))
    .collect::<Vec<_>>();

  assert_eq!(
    entities,
    [
      ("7 January 2025", "date", DetectionSource::Regex),
      ("March 9, 2026", "date", DetectionSource::Regex),
      ("2026. únor 3.", "date", DetectionSource::Regex),
      ("ledna 2026", "date", DetectionSource::Regex),
      ("1. ledna 2026", "date", DetectionSource::Regex),
      ("December 31, \n\n2025", "date", DetectionSource::Regex),
      ("2026", "date", DetectionSource::Trigger),
    ],
  );
}

#[test]
fn prepared_engine_extracts_uppercase_ordinal_dates() {
  let prepared = PreparedEngine::new(prepared_config! {
    date_data: Some(DateData {
      month_names_by_language: BTreeMap::from([(
        String::from("en"),
        vec![String::from("January")],
      )]),
      lowercase_month_ambiguities: BTreeMap::new(),
      year_words_by_language: BTreeMap::new(),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities("Filed on 1ST January 2025.")
    .unwrap();

  assert!(
    result
      .entities
      .anchored()
      .iter()
      .any(|entity| entity.text == "1ST January 2025")
  );
}

#[test]
fn prepared_engine_extracts_written_date_of_birth_trigger() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("geboren am"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedEngineSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("geboren am"),
        label: String::from("date of birth"),
        strategy: TriggerStrategy::NWords { count: 3 },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Herr Müller, geboren am 21. März 1968, ist Geschäftsführer.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "date of birth"
        && entity.text == "21. März 1968")
  );
}

#[test]
fn prepared_engine_honors_single_word_written_date_trigger_count() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("geboren am"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedEngineSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("geboren am"),
        label: String::from("date of birth"),
        strategy: TriggerStrategy::NWords { count: 1 },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Herr Müller, geboren am 21. März 1968, ist Geschäftsführer.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "date of birth" && entity.text == "21.")
  );
}

#[test]
fn prepared_engine_extracts_year_after_duplicate_year_word_noise() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: ["rok", "an", "roce"]
      .into_iter()
      .map(|pattern| SearchPattern::LiteralWithOptions {
        pattern: String::from(pattern),
        case_insensitive: Some(true),
        whole_words: Some(false),
      })
      .collect(),
    regex_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      triggers: PatternSlice { start: 0, end: 3 },
      ..PreparedEngineSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: ["rok", "an", "roce"]
        .into_iter()
        .map(|trigger| TriggerRule {
          trigger: String::from(trigger),
          label: String::from("date"),
          strategy: TriggerStrategy::NWords { count: 1 },
          validations: vec![TriggerValidation::MatchesPattern {
            pattern: String::from(r"^(?:19|20)\d{2}\.?$"),
            flags: None,
          }],
          include_trigger: false,
        })
        .collect(),
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let text = "účetní uzávěrku za roky 2019, 2020, 2021, 2022, 2023 a 2024, výpis z valné hromady konané v\u{00a0}roce 2026 a to nejpozději";
  let result = prepared.detect_static_entities(text).unwrap();

  assert!(
    result
      .entities
      .trigger()
      .iter()
      .any(|entity| entity.label == "date" && entity.text == "2026")
  );
}

#[test]
fn prepared_engine_trigger_caps_by_characters_not_bytes() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("ve výši"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedEngineSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("ve výši"),
        label: String::from("monetary amount"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: Vec::new(),
          max_length: None,
        },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let expected = "0,2 % z Ceny Plnění dle příslušné Dílčí smlouvy za každý i započatý kalendářní den prodlení";
  let result = prepared
    .detect_static_entities(&format!("Smluvní pokuta ve výši {expected}."))
    .unwrap();

  assert!(
    result.entities.trigger().iter().any(|entity| entity.label
      == "monetary amount"
      && entity.text == expected)
  );
}

#[test]
fn prepared_engine_trigger_validations_count_characters_not_bytes() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("jméno"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedEngineSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("jméno"),
        label: String::from("person"),
        strategy: TriggerStrategy::NWords { count: 1 },
        validations: vec![
          TriggerValidation::MinLength(5),
          TriggerValidation::MaxLength(5),
        ],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities("Smluvní jméno Áběčď bylo ověřeno.")
    .unwrap();

  assert!(
    result
      .entities
      .trigger()
      .iter()
      .any(|entity| entity.label == "person" && entity.text == "Áběčď")
  );
}

#[test]
fn prepared_engine_rejects_lowercase_acronym_trigger_collisions() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("dni"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedEngineSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("DNI"),
        label: String::from("national identification number"),
        strategy: TriggerStrategy::CompanyIdValue,
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let lower = prepared
    .detect_static_entities("Cena je stanovena ke dni 6.11.2025.")
    .unwrap();
  assert!(lower.entities.trigger().is_empty());

  let upper = prepared
    .detect_static_entities("Documento DNI 12345678Z.")
    .unwrap();
  assert!(
    upper
      .entities
      .trigger()
      .iter()
      .any(|entity| entity.text == "12345678Z"
        && entity.label == "national identification number")
  );
}

#[test]
fn prepared_engine_trims_party_position_before_triggered_address() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("sídlo"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedEngineSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("sídlo"),
        label: String::from("address"),
        strategy: TriggerStrategy::Address {
          max_chars: Some(120),
        },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: vec![String::from("prodávajícího")],
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities(
      "Místem předání je sídlo prodávajícího Na Květnici 1657/16, 140 00 Praha 4.",
    )
    .unwrap();

  assert!(
    result
      .entities
      .trigger()
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "Na Květnici 1657/16, 140 00 Praha 4")
  );
}

#[test]
fn prepared_engine_extracts_money_from_anchored_data() {
  let prepared = PreparedEngine::new(prepared_config! {
    monetary_data: Some(MonetaryData {
      currencies: CurrencyData {
        codes: vec![String::from("USD"), String::from("EUR")],
        symbols: vec![String::from("$")],
        local_names: vec![String::from("Kč"), String::from("korun českých")],
      },
      amount_words: AmountWordsData {
        written_amount_patterns: vec![],
        number_words: vec![],
        magnitude_suffixes: vec![MagnitudeSuffixData {
          words: vec![String::from("million")],
          abbreviations_case_insensitive: vec![],
          abbreviations_case_sensitive: vec![],
          abbreviations_attached: vec![],
        }],
        share_quantity_terms: vec![],
      },
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities(
      "Fees are USD 1,250,000.00, $450,000, 25 million EUR and 275 000 Kč.",
    )
    .unwrap();
  let entities = result
    .entities
    .anchored()
    .iter()
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();

  assert_eq!(
    entities,
    [
      "USD 1,250,000.00",
      "$450,000",
      "25 million EUR",
      "275 000 Kč",
    ],
  );
}

#[test]
fn anchored_date_and_money_output_digest_is_stable() {
  let prepared = PreparedEngine::new(prepared_config! {
    date_data: Some(DateData {
      month_names_by_language: BTreeMap::from([(
        String::from("en"),
        vec![String::from("January"), String::from("May")],
      )]),
      lowercase_month_ambiguities: BTreeMap::new(),
      year_words_by_language: BTreeMap::new(),
    }),
    monetary_data: Some(MonetaryData {
      currencies: CurrencyData {
        codes: vec![String::from("USD"), String::from("EUR")],
        symbols: vec![String::from("$")],
        local_names: vec![],
      },
      amount_words: AmountWordsData {
        written_amount_patterns: vec![],
        number_words: vec![],
        magnitude_suffixes: vec![],
        share_quantity_terms: vec![],
      },
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let full_text = concat!(
    "Signed 7 January 2025. May 9, 2026 is the renewal date. ",
    "Fees are USD 1,250.00, $450 and 275 EUR."
  );

  let result = prepared
    .redact_static_entities(full_text, &OperatorConfig::default())
    .unwrap();

  assert_eq!(result.redaction.entity_count, 4);
  assert_eq!(
    static_redaction_digest(&result),
    "0475c5cf59979e7b4dffd2644db7aa083c54deda4d4c9b42da535f518ad69e33",
  );
}

#[test]
fn prepared_engine_rejects_long_ungrouped_money_numbers() {
  let prepared = PreparedEngine::new(prepared_config! {
    monetary_data: Some(MonetaryData {
      currencies: CurrencyData {
        codes: vec![String::from("USD")],
        symbols: vec![String::from("$")],
        local_names: vec![],
      },
      amount_words: AmountWordsData {
        written_amount_patterns: vec![],
        number_words: vec![],
        magnitude_suffixes: vec![],
        share_quantity_terms: vec![],
      },
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities(
      "Reject USD 123456789012345 and $123456789012345. Keep USD 123456789, $123456789.00 and USD 1,234,567,890.",
    )
    .unwrap();
  let entities = result
    .entities
    .anchored()
    .iter()
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();

  assert!(!entities.contains(&"USD 123456789012345"));
  assert!(!entities.contains(&"$123456789012345"));
  assert!(entities.contains(&"USD 123456789"));
  assert!(entities.contains(&"$123456789.00"));
  assert!(entities.contains(&"USD 1,234,567,890"));
}

#[test]
fn prepared_engine_extends_money_to_written_amount_parenthetical() {
  let prepared = PreparedEngine::new(prepared_config! {
    monetary_data: Some(MonetaryData {
      currencies: CurrencyData {
        codes: vec![],
        symbols: vec![],
        local_names: vec![String::from("Kč")],
      },
      amount_words: AmountWordsData {
        number_words: vec![],
        written_amount_patterns: vec![WrittenAmountPatternData {
          keywords: vec![String::from("slovy")],
        }],
        magnitude_suffixes: vec![],
        share_quantity_terms: vec![],
      },
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities(
      "Smluvní pokuta je 50.000,- Kč (slovy: padesát tisíc korun českých).",
    )
    .unwrap();
  let entities = result
    .entities
    .anchored()
    .iter()
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();

  assert_eq!(
    entities,
    ["50.000,- Kč (slovy: padesát tisíc korun českých)"],
  );
}

#[test]
fn prepared_engine_redacts_static_entities_end_to_end() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b[A-Z]{2}\d{4}\b",
    ))],
    custom_regex_patterns: vec![],
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Acme"),
        case_insensitive: Some(true),
        whole_words: Some(false),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Turkey"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
    ],
    regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
        ..RegexSearchOptions::default()
      },
      ..SearchOptions::default()
    },
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      countries: PatternSlice { start: 1, end: 2 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    custom_regex_meta: vec![],
    deny_list_data: None,
    false_positive_filters: None,
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    country_data: Some(turkey_country_match_data()),
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
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Acme s.r.o. filed AB1234 in Turkey.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(
    result.redaction.redacted_text,
    "[ORGANIZATION_1] filed [REGISTRATION_NUMBER_1] in [COUNTRY_1]."
  );
  assert_eq!(result.redaction.entity_count, 3);
  assert_eq!(result.resolved_entities.len(), 3);
}

#[test]
fn prepared_engine_applies_threshold_before_merge() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![
      SearchPattern::Regex(String::from("Acme")),
      SearchPattern::Regex(String::from(r"Acme s\.r\.o\.")),
    ],
    regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: true,
        ..RegexSearchOptions::default()
      },
      ..SearchOptions::default()
    },
    threshold: 0.5,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 2 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![
      RegexMatchMeta::new("organization", 0.9),
      RegexMatchMeta::new("organization", 0.4),
    ],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities("Acme s.r.o. signed.", &OperatorConfig::default())
    .unwrap();

  assert_eq!(
    result.redaction.redacted_text,
    "[ORGANIZATION_1] s.r.o. signed."
  );
  assert_eq!(result.resolved_entities.len(), 1);
  assert_eq!(result.resolved_entities[0].text, "Acme");
}

#[test]
fn prepared_engine_applies_header_zone_boost_before_threshold() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from("Alice"))],
    regex_meta: vec![RegexMatchMeta::new("person", 0.45)],
    threshold: 0.5,
    allowed_labels: vec![String::from("person")],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    zone_data: Some(zone_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities_with_diagnostics(
      "Parties\nAlice\nArticle 1\nBody",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(result.result.resolved_entities.len(), 1);
  assert_eq!(result.result.resolved_entities[0].text, "Alice");
  assert!((result.result.resolved_entities[0].score - 0.55).abs() < 1e-12);
  assert!(result.diagnostics.events.iter().any(|event| {
    event.stage == DiagnosticStage::EntityZoneAdjustment
      && event.kind == DiagnosticEventKind::StageSummary
      && event.count == Some(1)
  }));
}

#[test]
fn notice_person_list_outranks_an_overlapping_address_candidate() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from("Spencer Ho"))],
    regex_meta: vec![RegexMatchMeta::new("address", 0.8)],
    allowed_labels: vec![String::from("person"), String::from("address")],
    threshold: 0.5,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    signature_data: Some(SignatureData {
      person_list_labels: vec![String::from("attention")],
      contact_field_labels: vec![String::from("email")],
      ..SignatureData::default()
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Attention: Steven Patch; Spencer Ho Email: contact@example.test",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(
    result
      .resolved_entities
      .iter()
      .map(|entity| (entity.text.as_str(), entity.label.as_str()))
      .collect::<Vec<_>>(),
    vec![("Steven Patch", "person"), ("Spencer Ho", "person")]
  );
}

#[derive(Clone, Copy)]
enum FilterPlacement {
  TopLevel,
  NestedDenyList,
}

fn signature_filter_engine(placement: FilterPlacement) -> PreparedEngine {
  let filters = DenyListFilterData {
    first_names: BTreeSet::from([String::from("imani")]),
    title_tokens: BTreeSet::from([String::from("ing")]),
    ..DenyListFilterData::default()
  };
  let (deny_list_data, false_positive_filters) = match placement {
    FilterPlacement::TopLevel => (None, Some(filters)),
    FilterPlacement::NestedDenyList => (
      Some(DenyListMatchData {
        labels: Vec::<Vec<String>>::new().into(),
        custom_labels: Vec::<Vec<String>>::new().into(),
        originals: Vec::new(),
        pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
        sources: Vec::<Vec<String>>::new().into(),
        filters: Some(filters),
      }),
      None,
    ),
  };
  PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("zhotovitel"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    allowed_labels: vec![String::from("person")],
    slices: PreparedEngineSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: deny_list_data,
    false_positive_filters: false_positive_filters,
    legal_form_data: Some(LegalFormData {
      role_heads: vec![String::from("seller")],
      ..LegalFormData::default()
    }),
    signature_data: Some(SignatureData::default()),
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("zhotovitel"),
        label: String::from(PERSON_OR_ORGANIZATION_TRIGGER_LABEL),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: Vec::new(),
          max_length: None,
        },
        validations: vec![TriggerValidation::StartsUppercase],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap()
}

#[test]
fn nested_deny_list_filters_match_top_level_detector_inputs() {
  let top_level = signature_filter_engine(FilterPlacement::TopLevel);
  let nested = signature_filter_engine(FilterPlacement::NestedDenyList);

  for (text, expected) in [
    ("Seller: Imani Nwosu", "Imani Nwosu"),
    ("Zhotovitel: Ing. Jan Henig,", "Ing. Jan Henig"),
  ] {
    let resolved = |engine: &PreparedEngine| {
      engine
        .redact_static_entities(text, &OperatorConfig::default())
        .unwrap()
        .resolved_entities
        .into_iter()
        .map(|entity| (entity.text, entity.label))
        .collect::<Vec<_>>()
    };
    let top_level_entities = resolved(&top_level);
    let nested_entities = resolved(&nested);

    assert_eq!(nested_entities, top_level_entities, "input {text:?}");
    assert_eq!(
      nested_entities,
      [(String::from(expected), String::from("person"))],
      "input {text:?}",
    );
  }
}

#[test]
fn prepared_engine_applies_table_zone_boost_before_threshold() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from("Alice"))],
    regex_meta: vec![RegexMatchMeta::new("person", 0.46)],
    threshold: 0.5,
    allowed_labels: vec![String::from("person")],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    zone_data: Some(zone_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Article 1\nName\tAddress\tId\nAlice\tPrague\t123",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(result.resolved_entities.len(), 1);
  assert!((result.resolved_entities[0].score - 0.51).abs() < 1e-12);
}

#[test]
fn prepared_engine_applies_signature_zone_boost_before_threshold() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from("Alice"))],
    regex_meta: vec![RegexMatchMeta::new("person", 0.36)],
    threshold: 0.5,
    allowed_labels: vec![String::from("person")],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    zone_data: Some(zone_data()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Article 1\nBody\nV Praze dne 1.1.2024\nAlice",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(result.resolved_entities.len(), 1);
  assert!((result.resolved_entities[0].score - 0.51).abs() < 1e-12);
}

#[test]
fn prepared_engine_boosts_near_miss_entities_when_enabled() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![
      SearchPattern::Regex(String::from(r"\bANCHOR-\d+\b")),
      SearchPattern::Regex(String::from(r"\bNEAR-\d+\b")),
    ],
    threshold: 0.5,
    confidence_boost: true,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 2 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![
      RegexMatchMeta::new("registration number", 0.95),
      RegexMatchMeta::new("matter id", 0.45),
    ],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "ANCHOR-123 signed with NEAR-456.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(result.resolved_entities.len(), 2);
  assert_eq!(result.resolved_entities[0].text, "ANCHOR-123");
  assert_eq!(result.resolved_entities[1].text, "NEAR-456");
  assert!((result.resolved_entities[1].score - 0.5).abs() < f64::EPSILON);
  assert_eq!(
    result.redaction.redacted_text,
    "[REGISTRATION_NUMBER_1] signed with [MATTER_ID_1]."
  );
}

#[test]
fn prepared_engine_boost_counts_text_offsets_not_bytes() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![
      SearchPattern::Regex(String::from(r"\bANCHOR-\d+\b")),
      SearchPattern::Regex(String::from(r"\bNEAR-\d+\b")),
    ],
    threshold: 0.5,
    confidence_boost: true,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 2 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![
      RegexMatchMeta::new("registration number", 0.95),
      RegexMatchMeta::new("matter id", 0.45),
    ],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let full_text = format!("ANCHOR-123 {} NEAR-456.", "á".repeat(120));

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();

  assert_eq!(result.resolved_entities.len(), 2);
  assert_eq!(result.resolved_entities[0].text, "ANCHOR-123");
  assert_eq!(result.resolved_entities[1].text, "NEAR-456");
  assert!((result.resolved_entities[1].score - 0.5).abs() < f64::EPSILON);
}

#[test]
fn prepared_engine_hotword_distance_uses_utf16_offsets() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b\d{2}\.\d{2}\.\d{4}\b",
    ))],
    allowed_labels: vec![String::from("date of birth")],
    threshold: 0.8,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("date", 0.7)],
    hotword_data: Some(HotwordRuleData {
      rules: vec![HotwordRule {
        hotwords: vec![String::from("born")],
        target_labels: vec![String::from("date")],
        score_adjustment: 1.0,
        reclassify_to: Some(String::from("date of birth")),
        proximity_before: 40,
        proximity_after: 40,
      }],
      pattern_rule_indices: vec![],
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let full_text = format!("born {} 12.03.1990", "😀".repeat(30));

  let result = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();

  assert!(result.resolved_entities.is_empty());
}

#[test]
fn prepared_engine_hotword_searches_original_text() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b\d{2}\.\d{2}\.\d{4}\b",
    ))],
    allowed_labels: vec![String::from("date")],
    threshold: 0.96,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("date", 0.95)],
    hotword_data: Some(HotwordRuleData {
      rules: vec![HotwordRule {
        hotwords: vec![String::from("tax ID")],
        target_labels: vec![String::from("date")],
        score_adjustment: 0.1,
        reclassify_to: None,
        proximity_before: 60,
        proximity_after: 60,
      }],
      pattern_rule_indices: vec![],
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "tax\u{00a0}ID 12.03.1990",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.resolved_entities.is_empty());
}

#[test]
fn prepared_engine_rejects_legacy_hotword_slice() {
  let result = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::Literal(String::from("born"))],
    slices: PreparedEngineSlices {
      hotwords: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    hotword_data: Some(HotwordRuleData {
      rules: vec![HotwordRule {
        hotwords: vec![String::from("born")],
        target_labels: vec![String::from("date")],
        score_adjustment: 0.1,
        reclassify_to: None,
        proximity_before: 60,
        proximity_after: 60,
      }],
      pattern_rule_indices: vec![0],
    }),
    ..empty_config(PreparedEngineSlices::default())
  });

  assert!(matches!(
    result,
    Err(Error::UnsupportedStaticSlice { slice: "hotwords" })
  ));
}

#[test]
fn prepared_engine_applies_hotword_reclassification_before_threshold() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b\d{2}\.\d{2}\.\d{4}\b",
    ))],
    allowed_labels: vec![String::from("date of birth")],
    threshold: 0.8,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("date", 0.7)],
    hotword_data: Some(HotwordRuleData {
      rules: vec![HotwordRule {
        hotwords: vec![String::from("narozen")],
        target_labels: vec![String::from("date")],
        score_adjustment: 0.15,
        reclassify_to: Some(String::from("date of birth")),
        proximity_before: 60,
        proximity_after: 60,
      }],
      pattern_rule_indices: vec![],
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "narozen dne 12.03.1990 v Praze",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(result.resolved_entities.len(), 1);
  assert_eq!(result.resolved_entities[0].label, "date of birth");
  assert_eq!(result.resolved_entities[0].text, "12.03.1990");
  assert_eq!(
    result.redaction.redacted_text,
    "narozen dne [DATE_OF_BIRTH_1] v Praze"
  );
}

#[test]
fn prepared_engine_applies_allowed_labels_before_redaction() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from("Alice"))],
    allowed_labels: vec![String::from("date")],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("person", 1.0)],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities("Alice signed.", &OperatorConfig::default())
    .unwrap();

  assert_eq!(result.redaction.redacted_text, "Alice signed.");
  assert!(result.resolved_entities.is_empty());
}

#[test]
fn prepared_engine_reuses_session_placeholders_across_documents() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\b(?:Alice|Bob)\b"))],
    allowed_labels: vec![String::from("person")],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("person", 1.0)],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let mut session =
    RedactionSession::new(SessionId::new("case_1").expect("valid id"));

  let first = prepared
    .redact_static_entities_with_session(
      "Alice signed.",
      PreparedSessionRedactionOptions {
        operators: &OperatorConfig::default(),
        session: &mut session,
        observed_at: None,
      },
    )
    .expect("first document should redact");
  let second = prepared
    .redact_static_entities_with_session(
      "Bob met Alice.",
      PreparedSessionRedactionOptions {
        operators: &OperatorConfig::default(),
        session: &mut session,
        observed_at: None,
      },
    )
    .expect("second document should redact");

  assert_eq!(first.redaction.redacted_text, "[PERSON_case%5F1_1] signed.");
  assert_eq!(
    second.redaction.redacted_text,
    "[PERSON_case%5F1_2] met [PERSON_case%5F1_1]."
  );
  assert_eq!(session.mapping_count(), 2);

  let lifecycle = SessionLifecycle::new(
    SessionTimestamp::from_epoch_seconds(100),
    Some(SessionTimestamp::from_epoch_seconds(200)),
  )
  .expect("valid lifecycle");
  let mut expired_session = RedactionSession::new_with_lifecycle(
    SessionId::new("expired_case").expect("valid id"),
    lifecycle,
  )
  .expect("session should initialize");
  let before = expired_session.clone();
  let error = prepared
    .redact_static_entities_with_session(
      "Alice signed.",
      PreparedSessionRedactionOptions {
        operators: &OperatorConfig::default(),
        session: &mut expired_session,
        observed_at: Some(SessionTimestamp::from_epoch_seconds(200)),
      },
    )
    .expect_err("expired session should fail before prepared execution");
  assert_eq!(error, Error::SessionExpired);
  assert_eq!(expired_session, before);
}

#[test]
fn prepared_engine_session_update_is_transactional() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from("Alice"))],
    allowed_labels: vec![String::from("person")],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("person", 1.0)],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let mut session =
    RedactionSession::new(SessionId::new("case_1").expect("valid id"));
  let before = session.clone();

  let error = prepared
    .redact_static_entities_with_session(
      "[PERSON_case%5F1_1] Alice signed.",
      PreparedSessionRedactionOptions {
        operators: &OperatorConfig::default(),
        session: &mut session,
        observed_at: None,
      },
    )
    .expect_err("reserved session placeholder should fail");

  assert_eq!(
    error,
    Error::SessionPlaceholderCollision {
      placeholder: String::from("[PERSON_case%5F1_1]")
    }
  );
  assert_eq!(session, before);
}

#[test]
fn prepared_engine_keeps_person_name_particles_after_trigger() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Pan"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedEngineSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("Pan"),
        label: String::from("person"),
        strategy: TriggerStrategy::ToEndOfLine,
        validations: vec![TriggerValidation::StartsUppercase],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let with_apostrophe = prepared
    .detect_static_entities("Pan Jean d'Arc přijel pozdě.")
    .unwrap();
  assert!(
    with_apostrophe
      .entities
      .trigger()
      .iter()
      .any(|entity| entity.text == "Jean d'Arc")
  );

  let with_particle = prepared
    .detect_static_entities("Pan João dos Santos přijel pozdě.")
    .unwrap();
  assert!(
    with_particle
      .entities
      .trigger()
      .iter()
      .any(|entity| entity.text == "João dos Santos")
  );

  let trailing_particle = prepared
    .detect_static_entities("Pan Novák von tady odešel.")
    .unwrap();
  assert!(
    trailing_particle
      .entities
      .trigger()
      .iter()
      .any(|entity| entity.text == "Novák")
  );
  assert!(
    trailing_particle
      .entities
      .trigger()
      .iter()
      .all(|entity| !entity.text.contains("von"))
  );
}

#[test]
fn prepared_engine_redacts_custom_deny_list_entities() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![],
    custom_regex_patterns: vec![],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Secret Code"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![],
    custom_regex_meta: vec![],
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("matter")]].into(),
      custom_labels: vec![vec![String::from("matter")]].into(),
      originals: vec![String::from("Secret Code")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("custom-deny-list")]].into(),
      filters: None,
    }),
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
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Secret Code was disclosed.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(result.detections.entities.deny_list().len(), 1);
  assert_eq!(result.redaction.redacted_text, "[MATTER_1] was disclosed.");
  assert_eq!(result.redaction.entity_count, 1);
}

#[test]
fn prepared_engine_parallel_path_matches_diagnostics_path() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b[A-Z]{3}-\d{3}\b",
    ))],
    custom_regex_patterns: vec![],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Secret Code"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("reference", 0.9)],
    custom_regex_meta: vec![],
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("matter")]].into(),
      custom_labels: vec![vec![String::from("matter")]].into(),
      originals: vec![String::from("Secret Code")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("custom-deny-list")]].into(),
      filters: None,
    }),
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
  })
  .unwrap();
  let full_text = format!("{} Secret Code ABC-123.", "prefix ".repeat(1_200));

  let parallel = prepared
    .redact_static_entities(&full_text, &OperatorConfig::default())
    .unwrap();
  let diagnostics = prepared
    .redact_static_entities_with_diagnostics(
      &full_text,
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(
    parallel.redaction.redacted_text,
    diagnostics.result.redaction.redacted_text
  );
  assert_eq!(
    parallel.redaction.entity_count,
    diagnostics.result.redaction.entity_count
  );
}

#[test]
fn prepared_engine_rejects_unsupported_static_slices() {
  let unsupported = PatternSlice { start: 0, end: 1 };
  let error = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::Literal(String::from("Secret"))],
    ..empty_config(PreparedEngineSlices {
      deny_list: unsupported,
      ..PreparedEngineSlices::default()
    })
  })
  .err()
  .expect("unsupported slice should be rejected");

  assert_eq!(error, Error::UnsupportedStaticSlice { slice: "deny_list" });
}

#[test]
fn prepared_engine_requires_gazetteer_metadata_for_gazetteer_slice() {
  let error = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::Literal(String::from("Acme"))],
    ..empty_config(PreparedEngineSlices {
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    })
  })
  .err()
  .expect("gazetteer slice should require metadata");

  assert_eq!(
    error,
    Error::MissingStaticData {
      field: "gazetteer_data"
    }
  );
}

#[test]
fn prepared_engine_rejects_truncated_country_metadata() {
  let error = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::Literal(String::from("Turkey"))],
    country_data: Some(CountryMatchData {
      labels: Vec::new(),
      iso_codes: Vec::new(),
      variants: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices {
      countries: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    })
  })
  .err()
  .expect("truncated country metadata should be rejected");

  assert_eq!(
    error,
    Error::StaticDataLengthMismatch {
      field: "country_data.labels",
      expected: 1,
      actual: 0
    }
  );
}

#[test]
fn prepared_engine_rejects_truncated_country_iso_codes() {
  let error = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::Literal(String::from("Turkey"))],
    country_data: Some(CountryMatchData {
      labels: vec![String::from("country")],
      iso_codes: Vec::new(),
      variants: vec![CountryVariant::Name],
    }),
    ..empty_config(PreparedEngineSlices {
      countries: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    })
  })
  .err()
  .expect("truncated country ISO metadata should be rejected");

  assert_eq!(
    error,
    Error::StaticDataLengthMismatch {
      field: "country_data.isoCodes",
      expected: 1,
      actual: 0
    }
  );
}

#[test]
fn prepared_engine_rejects_truncated_country_variants() {
  let error = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::Literal(String::from("Turkey"))],
    country_data: Some(CountryMatchData {
      labels: vec![String::from("country")],
      iso_codes: vec![String::from("TR")],
      variants: Vec::new(),
    }),
    ..empty_config(PreparedEngineSlices {
      countries: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    })
  })
  .err()
  .expect("truncated country variant metadata should be rejected");

  assert_eq!(
    error,
    Error::StaticDataLengthMismatch {
      field: "country_data.variants",
      expected: 1,
      actual: 0
    }
  );
}

#[test]
fn prepared_engine_rejects_missing_regex_metadata() {
  let error = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bID\d+\b"))],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    ..empty_config(PreparedEngineSlices::default())
  })
  .err()
  .expect("regex slice should require parallel metadata");

  assert_eq!(
    error,
    Error::StaticDataLengthMismatch {
      field: "regex_meta",
      expected: 1,
      actual: 0
    }
  );
}

#[test]
fn prepared_engine_rejects_literal_slices_outside_patterns() {
  let error = PreparedEngine::new(empty_config(PreparedEngineSlices {
    gazetteer: PatternSlice { start: 0, end: 1 },
    ..PreparedEngineSlices::default()
  }))
  .err()
  .expect("slice outside the literal pattern table should be rejected");

  assert!(
    matches!(
      error,
      Error::InvalidStaticData {
        field: "slices.gazetteer",
        ..
      }
    ),
    "unexpected error: {error}"
  );
}

#[test]
fn prepared_engine_requires_address_seed_data_for_street_types() {
  let error = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::Literal(String::from("Street"))],
    ..empty_config(PreparedEngineSlices {
      street_types: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    })
  })
  .err()
  .expect("street types should require address seed data");

  assert_eq!(
    error,
    Error::MissingStaticData {
      field: "address_seed_data"
    }
  );
}

#[test]
fn prepared_engine_expands_address_seeds_from_street_type_slice() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Boston"),
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
      originals: vec![String::from("Boston")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Send notices to 100 Main Street, Boston, MA 02101-1234.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "100 Main Street, Boston, MA 02101-1234")
  );
}

#[test]
#[ignore = "release-mode scaling regression check"]
fn address_seed_collection_and_clustering_scale_with_input_size() {
  let prepared = address_seed_scaling_engine();
  let fixture = concat!(
    "Notice 12345: send process to 100 Main Street, Boston, MA 02101-1234. ",
    "Docket 67890 remains governed by Section 54321.\n\n",
  );
  let sizes: [usize; 5] =
    [48 * 1024, 100 * 1024, 250 * 1024, 500 * 1024, 1024 * 1024];
  let mut samples = Vec::new();

  for target_bytes in sizes {
    let repeats = target_bytes.div_ceil(fixture.len());
    let text = fixture.repeat(repeats);
    let mut best_postal_us = u64::MAX;
    let mut best_cluster_us = u64::MAX;
    let mut best_total = std::time::Duration::MAX;
    for _ in 0..3 {
      let start = Instant::now();
      let result = prepared
        .redact_static_entities_with_summary_diagnostics(
          &text,
          &OperatorConfig::default(),
        )
        .unwrap();
      best_total = best_total.min(start.elapsed());
      assert_eq!(result.result.redaction.entity_count, repeats);
      let postal_us = result
        .diagnostics
        .events
        .iter()
        .find(|event| {
          event.stage == DiagnosticStage::EntityAddressSeedCollectPostalCodes
        })
        .and_then(|event| event.elapsed_us)
        .unwrap();
      best_postal_us = best_postal_us.min(postal_us);
      let cluster_us = result
        .diagnostics
        .events
        .iter()
        .find(|event| event.stage == DiagnosticStage::EntityAddressSeedCluster)
        .and_then(|event| event.elapsed_us)
        .unwrap();
      best_cluster_us = best_cluster_us.min(cluster_us);
      if target_bytes == 100 * 1024 {
        // Refreshed when the cluster gap stopped bridging running prose.
        // The fixture's docket header carries a bare five-digit number, so
        // "Notice 12345" used to seed a postal code that clustered with the
        // street address 25 characters later and pulled the sentence opening
        // into the span. The span is now the address alone:
        // "100 Main Street, Boston, MA 02101-1234".
        assert_eq!(
          static_redaction_digest(&result.result),
          "4cd5071a3ef1e6cc7f296b4f4e172d6fd68a733b3e023e4950bf42a63cdc9878",
        );
      }
      std::hint::black_box(result);
    }
    samples.push((text.len(), best_postal_us, best_cluster_us, best_total));
  }

  let (smallest_bytes, smallest_postal_us, smallest_cluster_us, _) = samples[0];
  let (largest_bytes, largest_postal_us, largest_cluster_us, largest_total) =
    samples[4];
  assert!(
    u128::from(largest_postal_us)
      .saturating_mul(u128::try_from(smallest_bytes).unwrap())
      <= u128::from(smallest_postal_us)
        .saturating_mul(u128::try_from(largest_bytes).unwrap())
        .saturating_mul(3),
    "postal-code collection time per byte regressed: {samples:?}",
  );
  assert!(
    largest_postal_us <= 500_000,
    "postal-code collection exceeded 500 ms at 1 MiB: {samples:?}",
  );
  assert!(
    u128::from(largest_cluster_us)
      .saturating_mul(u128::try_from(smallest_bytes).unwrap())
      <= u128::from(smallest_cluster_us)
        .saturating_mul(u128::try_from(largest_bytes).unwrap())
        .saturating_mul(3),
    "address-seed clustering time per byte regressed: {samples:?}",
  );
  assert!(
    largest_cluster_us <= 100_000,
    "address-seed clustering exceeded 100 ms at 1 MiB: {samples:?}",
  );
  assert!(
    largest_total <= std::time::Duration::from_secs(10),
    "candidate-heavy legal workload exceeded 10 s at 1 MiB: {samples:?}",
  );
}

fn address_seed_scaling_engine() -> PreparedEngine {
  PreparedEngine::new(prepared_config! {
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Boston"),
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
      originals: vec![String::from("Boston")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap()
}

#[test]
fn prepared_engine_expands_address_seeds_from_city_and_postal_code() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Brno"),
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
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Brno")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Sídlo společnosti je Kamínky 302/16, Brno 634 00.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "Kamínky 302/16, Brno 634 00")
  );
}

#[test]
fn prepared_engine_expands_compound_german_street_addresses() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Wiesbaden"),
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
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Düsseldorf")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "wohnhaft Schadowstraße 11, 40212 Düsseldorf.",
      &OperatorConfig::default(),
    )
    .unwrap();
  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "Schadowstraße 11, 40212 Düsseldorf")
  );
}

#[test]
fn prepared_engine_expands_plain_postal_city_addresses() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("geboren am"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Düsseldorf"),
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
      triggers: PatternSlice { start: 0, end: 1 },
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("geboren am"),
        label: String::from("date of birth"),
        strategy: TriggerStrategy::NWords { count: 3 },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
      phone_extension_labels: Vec::new(),
      number_markers: Vec::new(),
      number_labels: Vec::new(),
      person_field_labels: Vec::new(),
    }),
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Wiesbaden")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "(2) Frau Karoline M. Brentano,\n    geboren am 09. Juli 1982,\n    wohnhaft Bismarckring 18, 65183 Wiesbaden,\n    Steuer-ID: 78 123 456 789",
      &OperatorConfig::default(),
    )
    .unwrap();
  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "Bismarckring 18, 65183 Wiesbaden")
  );
}

#[test]
fn prepared_engine_stops_address_before_notice_copy_instruction() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Wilmington"),
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
      originals: vec![String::from("Wilmington")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData {
      boundary_words: vec![String::from("with a copy")],
      br_cep_cue_words: Vec::new(),
      unit_abbreviations: Vec::new(),
      ..AddressSeedData::default()
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "1209 Orange Street, Wilmington, DE 19801; with a copy to general counsel.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "1209 Orange Street, Wilmington, DE 19801")
  );
  assert!(
    result
      .resolved_entities
      .iter()
      .all(|entity| !entity.text.contains("with a copy"))
  );
}

#[test]
fn prepared_engine_splits_address_seed_clusters_at_paragraph_breaks() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Brno"),
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
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Brno")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Kamínky 5, Brno 634 00\n\nIČ: 48511229\n\nKamínky 302/16, Brno 634 00.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "Kamínky 302/16, Brno 634 00")
  );
}

#[test]
fn prepared_engine_stops_address_seed_expansion_at_legal_prose() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Liberec"),
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
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Liberec")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData {
      boundary_words: vec![String::from("pokud")],
      br_cep_cue_words: Vec::new(),
      unit_abbreviations: Vec::new(),
      ..AddressSeedData::default()
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Fakturu zašlete na Náspu 5, 460 01 Liberec, pokud nebude dohodnuto jinak. Přílohou bude seznam.",
      &OperatorConfig::default(),
    )
    .unwrap();

  let addresses = result
    .resolved_entities
    .iter()
    .filter(|entity| entity.label == "address")
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();
  assert!(addresses.contains(&"Náspu 5, 460 01 Liberec"));
  assert!(!addresses.iter().any(|text| text.contains("pokud")));
  assert!(!addresses.iter().any(|text| text.contains("Přílohou")));
}

#[test]
fn prepared_engine_does_not_cluster_address_seed_inside_register_span() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"Handelsregister des Amtsgerichts Düsseldorf unter HRB \d+",
    ))],
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
        ..RegexSearchOptions::default()
      },
      ..SearchOptions::default()
    },
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Düsseldorf"),
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
      regex: PatternSlice { start: 0, end: 1 },
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Düsseldorf")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData {
      boundary_words: vec![String::from("eingetragen")],
      br_cep_cue_words: Vec::new(),
      unit_abbreviations: Vec::new(),
      ..AddressSeedData::default()
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Sitz: Königsallee 27, 40212 Düsseldorf,\n    eingetragen im Handelsregister des Amtsgerichts Düsseldorf unter HRB 78219.",
      &OperatorConfig::default(),
    )
    .unwrap();

  let addresses = result
    .resolved_entities
    .iter()
    .filter(|entity| entity.label == "address")
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();
  assert!(addresses.contains(&"Königsallee 27, 40212 Düsseldorf"));
  assert!(!addresses.iter().any(|text| text.contains("Sitz:")));
  assert!(
    !addresses
      .iter()
      .any(|text| text.contains("Handelsregister"))
  );
}

#[test]
fn prepared_engine_redacts_curated_deny_list_entities() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Prague"),
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
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Prague")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    ..empty_config(PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    })
  })
  .unwrap();

  let result = prepared
    .redact_static_entities("Prague filed.", &OperatorConfig::default())
    .unwrap();

  assert_eq!(result.redaction.redacted_text, "[ADDRESS_1] filed.");
}

#[test]
fn prepared_engine_rejects_curated_deny_list_without_filters() {
  let error = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::Literal(String::from("Prague"))],
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Prague")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("city")]].into(),
      filters: None,
    }),
    ..empty_config(PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    })
  })
  .err()
  .expect("curated deny-list source should be rejected");

  assert_eq!(
    error,
    Error::MissingStaticData {
      field: "deny_list.filters"
    }
  );
}

#[test]
fn prepared_engine_rejects_truncated_deny_list_data() {
  let error = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::Literal(String::from("Secret Code"))],
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("matter")]].into(),
      custom_labels: vec![].into(),
      originals: vec![String::from("Secret Code")],
      pattern_meta: stella_anonymize_core::DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("custom-deny-list")]].into(),
      filters: None,
    }),
    ..empty_config(PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    })
  })
  .err()
  .expect("truncated deny-list data should be rejected");

  assert_eq!(
    error,
    Error::StaticDataLengthMismatch {
      field: "deny_list.custom_labels",
      expected: 1,
      actual: 0
    }
  );
}

#[test]
fn prepared_engine_detects_non_english_legal_form_entities() {
  let prepared = legal_form_prepared_engine(vec!["a.s.", "a. s."]);

  let result = prepared
    .detect_static_entities("Smlouvu podepsaly Pražské služby, a.s. dnes.")
    .unwrap();

  assert_eq!(result.entities.legal_form().len(), 1);
  assert_eq!(result.entities.legal_form()[0].text, "Pražské služby, a.s.");
  assert_eq!(
    result.entities.legal_form()[0].source,
    DetectionSource::LegalForm
  );
}

#[test]
fn prepared_engine_keeps_indented_line_wrapped_legal_form_suffix() {
  let prepared = legal_form_prepared_engine(vec!["Co.", "LLC"]);

  let result = prepared
    .detect_static_entities(
      "The underwriter is Goldman Sachs & Co.\n  LLC, joint book-runner.",
    )
    .unwrap();

  assert_eq!(result.entities.legal_form().len(), 1);
  assert_eq!(
    result.entities.legal_form()[0].text,
    "Goldman Sachs & Co.\n  LLC"
  );
}

#[test]
fn prepared_engine_splits_embedded_legal_form_lists() {
  let prepared = legal_form_prepared_engine(vec!["LLC", "Inc."]);

  let result = prepared
    .detect_static_entities(
      "The parties include Acme LLC, Beta Inc. and others.",
    )
    .unwrap();
  let texts = result
    .entities
    .legal_form()
    .iter()
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();

  assert_eq!(texts, vec!["Acme LLC", "Beta Inc."]);
}

/// Shared core boundaries reject oversized text before any public primitive or
/// prepared-engine redaction pass can process it.
#[test]
fn redaction_entry_points_share_the_engine_text_bound() {
  let prepared = PreparedEngine::new(prepared_config! {
    threshold: 0.5,
    allowed_labels: vec![String::from("person")],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let operators = OperatorConfig::default();
  let at_limit = "a".repeat(REDACTION_TEXT_MAX_BYTES);
  let mut oversized = at_limit.clone();
  oversized.push('a');
  let mut session =
    RedactionSession::new(SessionId::new("bounded-session").unwrap());

  assert!(
    prepared
      .redact_static_entities(&at_limit, &operators)
      .is_ok()
  );
  for result in [
    redact_text(&oversized, &[], &operators).map(|_| ()),
    redact_text_with_session(
      stella_anonymize_core::RedactTextWithSessionParams {
        full_text: &oversized,
        entities: &[],
        config: &operators,
        session: &mut session,
        observed_at: None,
      },
    )
    .map(|_| ()),
    prepared
      .redact_static_entities(&oversized, &operators)
      .map(|_| ()),
    prepared
      .redact_static_entities_with_diagnostics(&oversized, &operators)
      .map(|_| ()),
    prepared
      .redact_static_entities_with_summary_diagnostics(&oversized, &operators)
      .map(|_| ()),
    prepared
      .redact_static_entities_with_session(
        &oversized,
        PreparedSessionRedactionOptions {
          operators: &operators,
          session: &mut session,
          observed_at: None,
        },
      )
      .map(|_| ()),
  ] {
    assert!(matches!(
      result,
      Err(Error::TextLimitExceeded {
        max_bytes: REDACTION_TEXT_MAX_BYTES,
        ..
      })
    ));
  }
}

#[test]
fn prepared_engine_rejects_dotted_citation_legal_form_substrings() {
  let prepared = legal_form_prepared_engine(vec!["S.C."]);

  let result = prepared
    .detect_static_entities("See 18 U.S.C. Section 1833(b) for civil immunity.")
    .unwrap();

  assert!(result.entities.legal_form().is_empty());
}
