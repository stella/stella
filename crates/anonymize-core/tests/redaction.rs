#![allow(
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::panic,
  clippy::unwrap_used
)]

#[path = "support/snapshots.rs"]
mod snapshots;

use snapshots::redaction_snapshot;
use stella_anonymize_core::{
  Entity, Error, MaskConfig, MaskDirection, Operator, OperatorConfig,
  OperatorType, deanonymise, redact_text,
};

fn entity(text: &str, label: &str, value: &str) -> Entity {
  entity_with_display_text(text, label, value, value)
}

fn entity_with_display_text(
  text: &str,
  label: &str,
  value: &str,
  display_text: &str,
) -> Entity {
  let byte_start = text
    .find(value)
    .unwrap_or_else(|| panic!("missing fixture value: {value}"));
  let prefix = text
    .get(..byte_start)
    .unwrap_or_else(|| panic!("invalid fixture boundary: {byte_start}"));
  let start = byte_len(prefix);
  let end = start.saturating_add(byte_len(value));
  Entity::detected(start, end, label, display_text)
}

fn byte_len(text: &str) -> u32 {
  u32::try_from(text.len()).unwrap_or(u32::MAX)
}

#[test]
fn repeated_values_share_first_non_colliding_placeholder() {
  let value = "Alice Smith";
  let text = format!("Existing [PERSON_1]. {value} called. {value} signed.");
  let first = text.find(value).unwrap_or(0);
  let second = text
    .get(first.saturating_add(1)..)
    .and_then(|tail| tail.find(value))
    .map_or(first, |relative| {
      first.saturating_add(1).saturating_add(relative)
    });
  let entities = vec![
    Entity::detected(
      u32::try_from(first).unwrap_or(u32::MAX),
      u32::try_from(first.saturating_add(value.len())).unwrap_or(u32::MAX),
      "person",
      value,
    ),
    Entity::detected(
      u32::try_from(second).unwrap_or(u32::MAX),
      u32::try_from(second.saturating_add(value.len())).unwrap_or(u32::MAX),
      "person",
      value,
    ),
  ];

  let result =
    redact_text(&text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(
    result.redacted_text,
    "Existing [PERSON_1]. [PERSON_2] called. [PERSON_2] signed."
  );
  assert_eq!(result.redaction_map[0].placeholder, "[PERSON_2]");
  assert_eq!(
    deanonymise(&result.redacted_text, &result.redaction_map),
    text
  );
  insta::assert_yaml_snapshot!(
    "placeholder_collision_redaction",
    redaction_snapshot(&result)
  );
}

#[test]
fn literal_placeholders_inside_extra_brackets_are_reserved() {
  let text = "Keep [[PERSON_1]]; Alice Smith signs.";
  let entities = vec![entity(text, "person", "Alice Smith")];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redacted_text, "Keep [[PERSON_1]]; [PERSON_2] signs.");
  assert_eq!(result.redaction_map[0].placeholder, "[PERSON_2]");
}

#[test]
fn normalized_identifier_values_share_placeholder() {
  let text = "Mail Alice@Example.com and alice@example.com.";
  let entities = vec![
    entity(text, "email address", "Alice@Example.com"),
    entity(text, "email address", "alice@example.com"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(result.redaction_map[0].placeholder, "[EMAIL_ADDRESS_1]");
}

#[test]
fn international_phone_access_prefixes_share_placeholder() {
  let text = "Call +44 20 7946 0958 or 0044 (20) 7946-0958.";
  let entities = vec![
    entity(text, "phone number", "+44 20 7946 0958"),
    entity(text, "phone number", "0044 (20) 7946-0958"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(result.redaction_map[0].placeholder, "[PHONE_NUMBER_1]");
}

#[test]
fn generic_identifier_cues_keep_distinct_placeholder_keys() {
  let text = concat!(
    "CNI: 12AB34567 was present. ",
    "CNI nº 12AB34567 was repeated. ",
    "CNI 12AB34567 was listed. ",
    "12AB34567 was bare."
  );
  let bare_start = byte_len(
    text
      .get(..text.rfind("12AB34567").unwrap_or(0))
      .unwrap_or(""),
  );
  let entities = vec![
    entity(text, "national identification number", "CNI: 12AB34567"),
    entity(text, "national identification number", "CNI nº 12AB34567"),
    entity(text, "national identification number", "CNI 12AB34567"),
    Entity::detected(
      bare_start,
      bare_start.saturating_add(byte_len("12AB34567")),
      "national identification number",
      "12AB34567",
    ),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 4);
  assert_eq!(result.redacted_text.matches('[').count(), 4);
}

#[test]
fn generic_identifier_normalization_keeps_trailing_prose_in_key() {
  let text = "Reg AB12345 expires. Reg AB12345 repeats.";
  let second_start = text
    .rfind("AB12345")
    .expect("fixture should contain repeated identifier");
  let second_start = byte_len(
    text
      .get(..second_start)
      .expect("fixture boundary should be valid"),
  );
  let entities = vec![
    entity_with_display_text(
      text,
      "registration number",
      "AB12345 expires",
      "AB12345 expires",
    ),
    Entity::detected(
      second_start,
      second_start.saturating_add(byte_len("AB12345")),
      "registration number",
      "AB12345",
    ),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 2);
}

#[test]
fn spaced_identifier_values_still_share_placeholder() {
  let text =
    "Card 4242 4242 4242 4242 was present. Card 4242424242424242 repeated.";
  let entities = vec![
    entity(text, "credit card number", "4242 4242 4242 4242"),
    entity(text, "credit card number", "4242424242424242"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(
    result.redaction_map[0].placeholder,
    "[CREDIT_CARD_NUMBER_1]"
  );
}

#[test]
fn coreference_alias_uses_source_placeholder_and_value() {
  let text = "Acme signed. Acme Corporation countersigned.";
  let alias_start = text.find("Acme").unwrap_or(0);
  let source_start = text.find("Acme Corporation").unwrap_or(0);
  let entities = vec![
    Entity::coreference(
      u32::try_from(alias_start).unwrap_or(u32::MAX),
      u32::try_from(alias_start.saturating_add("Acme".len()))
        .unwrap_or(u32::MAX),
      "organization",
      "Acme",
      "Acme Corporation",
    ),
    Entity::detected(
      u32::try_from(source_start).unwrap_or(u32::MAX),
      u32::try_from(source_start.saturating_add("Acme Corporation".len()))
        .unwrap_or(u32::MAX),
      "organization",
      "Acme Corporation",
    ),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(
    result.redacted_text,
    "[ORGANIZATION_1] signed. [ORGANIZATION_1] countersigned."
  );
  assert_eq!(result.redaction_map[0].original, "Acme Corporation");
  insta::assert_yaml_snapshot!(
    "coreference_alias_redaction",
    redaction_snapshot(&result)
  );
}

#[test]
fn same_alias_text_can_point_to_different_source_placeholders() {
  let text = "Smith met Smith.";
  let first = text.find("Smith").unwrap_or(0);
  let second = text.rfind("Smith").unwrap_or(first);
  let entities = vec![
    Entity::coreference(
      u32::try_from(first).unwrap_or(u32::MAX),
      u32::try_from(first.saturating_add("Smith".len())).unwrap_or(u32::MAX),
      "person",
      "Smith",
      "Alice Smith",
    ),
    Entity::coreference(
      u32::try_from(second).unwrap_or(u32::MAX),
      u32::try_from(second.saturating_add("Smith".len())).unwrap_or(u32::MAX),
      "person",
      "Smith",
      "Bob Smith",
    ),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redacted_text, "[PERSON_1] met [PERSON_2].");
  assert_eq!(result.redaction_map[0].original, "Alice Smith");
  assert_eq!(result.redaction_map[1].original, "Bob Smith");
}

#[test]
fn redact_operator_is_not_reversible() {
  let text = "Contact Alice Smith at alice@example.com.";
  let mut config = OperatorConfig::default();
  config
    .operators
    .insert(String::from("person"), Operator::Redact);
  config.redact_string = String::from("[GONE]");
  let entities = vec![
    entity(text, "person", "Alice Smith"),
    entity(text, "email address", "alice@example.com"),
  ];

  let result = redact_text(text, &entities, &config).unwrap();

  assert!(result.redacted_text.contains("[GONE]"));
  assert!(
    result
      .replacements
      .iter()
      .any(|replacement| replacement.replacement == "[GONE]")
  );
  assert!(
    result
      .redaction_map
      .iter()
      .all(|entry| entry.placeholder != "[PERSON_1]")
  );
  assert!(
    result
      .redaction_map
      .iter()
      .any(|entry| entry.placeholder == "[EMAIL_ADDRESS_1]")
  );
}

#[test]
fn keep_operator_preserves_text_without_reversible_mapping() {
  let text = "Contact Alice Smith at alice@example.com.";
  let mut config = OperatorConfig::default();
  config
    .operators
    .insert(String::from("person"), Operator::Keep);
  let entities = vec![
    entity(text, "person", "Alice Smith"),
    entity(text, "email address", "alice@example.com"),
  ];

  let result = redact_text(text, &entities, &config).unwrap();

  assert_eq!(
    result.redacted_text,
    "Contact Alice Smith at [EMAIL_ADDRESS_1]."
  );
  assert_eq!(result.entity_count, 2);
  assert_eq!(result.replacements.len(), 1);
  assert_eq!(result.replacements[0].replacement, "[EMAIL_ADDRESS_1]");
  assert!(
    result
      .redaction_map
      .iter()
      .all(|entry| entry.placeholder != "[PERSON_1]")
  );
  assert!(result.operator_map.iter().any(|entry| {
    entry.placeholder == "[PERSON_1]" && entry.operator == OperatorType::Keep
  }));
}

#[test]
fn keep_operator_does_not_suppress_nested_redactions() {
  let text = "Org A alice@example.com";
  let mut config = OperatorConfig::default();
  config
    .operators
    .insert(String::from("organization"), Operator::Keep);
  let entities = vec![
    Entity::detected(
      0,
      byte_len(text),
      "organization",
      "Org A alice@example.com",
    ),
    entity(text, "email address", "alice@example.com"),
  ];

  let result = redact_text(text, &entities, &config).unwrap();

  assert_eq!(result.redacted_text, "Org A [EMAIL_ADDRESS_1]");
  assert_eq!(result.entity_count, 2);
  assert_eq!(result.redaction_map.len(), 1);
  assert!(result.operator_map.iter().any(|entry| {
    entry.placeholder == "[ORGANIZATION_1]"
      && entry.operator == OperatorType::Keep
  }));
  assert!(result.operator_map.iter().any(|entry| {
    entry.placeholder == "[EMAIL_ADDRESS_1]"
      && entry.operator == OperatorType::Replace
  }));
}

#[test]
fn mask_operator_masks_whole_graphemes_from_the_configured_direction() {
  let text = "A👨‍👩‍👧‍👦e\u{301}Z";
  for (direction, count, expected) in [
    (MaskDirection::End, 2, "A👨‍👩‍👧‍👦●●"),
    (MaskDirection::Start, 2, "●●e\u{301}Z"),
    (MaskDirection::Start, 99, "●●●●"),
  ] {
    let mut config = OperatorConfig::default();
    config.operators.insert(
      String::from("person"),
      Operator::Mask(MaskConfig::new("●", count, direction).unwrap()),
    );
    let entities = vec![Entity::detected(0, byte_len(text), "person", text)];

    let result = redact_text(text, &entities, &config).unwrap();

    assert_eq!(result.redacted_text, expected);
    assert_eq!(
      result.replacements.len(),
      usize::try_from(count.min(4)).unwrap_or(usize::MAX)
    );
    assert!(
      result
        .replacements
        .iter()
        .all(|replacement| replacement.replacement == "●")
    );
    assert!(result.redaction_map.is_empty());
    assert_eq!(result.operator_map[0].operator, OperatorType::Mask);
  }
}

#[test]
fn mask_operator_does_not_suppress_nested_redactions() {
  let text = "Alice@example.com";
  let mut config = OperatorConfig::default();
  config.operators.insert(
    String::from("email address"),
    Operator::Mask(MaskConfig::new("●", 4, MaskDirection::End).unwrap()),
  );
  let entities = vec![
    Entity::detected(0, byte_len(text), "email address", text),
    Entity::detected(0, 5, "person", "Alice"),
  ];

  let result = redact_text(text, &entities, &config).unwrap();

  assert_eq!(result.redacted_text, "[PERSON_1]@example●●●●");
  assert_eq!(result.entity_count, 2);
  assert_eq!(result.redaction_map.len(), 1);
  assert!(result.operator_map.iter().any(|entry| {
    entry.placeholder == "[EMAIL_ADDRESS_1]"
      && entry.operator == OperatorType::Mask
  }));
}

#[test]
fn byte_offsets_apply_non_ascii_spans() {
  let text = "A 🦀 Bob";
  let start = byte_len("A 🦀 ");
  let end = start.saturating_add(byte_len("Bob"));
  let entities = vec![Entity::detected(start, end, "person", "Bob")];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redacted_text, "A 🦀 [PERSON_1]");
}

#[test]
fn detected_original_uses_redacted_source_span() {
  let text = "Alice signed.";
  let entities = vec![Entity::detected(0, 5, "person", "Bob")];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map[0].original, "Alice");
  assert_eq!(
    deanonymise(&result.redacted_text, &result.redaction_map),
    text
  );
}

#[test]
fn detected_placeholder_identity_uses_sanitized_text() {
  let text = "Dates: 21.\nMärz 1968 and 21. März 1968.";
  let normalized = "21. März 1968";
  let entities = vec![
    entity_with_display_text(text, "date", "21.\nMärz 1968", normalized),
    entity(text, "date", normalized),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redacted_text, "Dates: [DATE_1] and [DATE_1].");
  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(result.redaction_map[0].original, "21.\nMärz 1968");
}

#[test]
fn merged_placeholder_restores_every_occurrence_to_its_first_original() {
  // Two spans whose display texts share a placeholder identity are merged onto
  // one placeholder, and the redaction map keeps a single original for it, so
  // `deanonymise` restores both occurrences to the first span's source slice.
  // The soft-wrap merge above relies on this; the round-trip cost is the
  // reason `generated_entity_spans_fail_or_round_trip` only asserts exact
  // restoration while no placeholder stands for two different slices.
  let text = "Dates: 21.\nMärz 1968 and 21. März 1968.";
  let normalized = "21. März 1968";
  let entities = vec![
    entity_with_display_text(text, "date", "21.\nMärz 1968", normalized),
    entity(text, "date", normalized),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(
    deanonymise(&result.redacted_text, &result.redaction_map),
    "Dates: 21.\nMärz 1968 and 21.\nMärz 1968."
  );
}

#[test]
fn invalid_byte_boundary_is_rejected() {
  let text = "A 🦀 Bob";
  let entities = vec![Entity::detected(3, 5, "person", " Bob")];

  let error = redact_text(text, &entities, &OperatorConfig::default())
    .expect_err("offset inside a surrogate pair must fail");

  assert_eq!(error, Error::ByteOffsetInsideCodepoint { offset: 3 });
}

#[test]
fn empty_spans_are_rejected() {
  let text = "Alice";
  let entities = vec![Entity::detected(0, 0, "person", "")];

  let error = redact_text(text, &entities, &OperatorConfig::default())
    .expect_err("empty entity spans must fail");

  assert_eq!(error, Error::InvalidSpan { start: 0, end: 0 });
}

#[test]
fn overlapping_spans_keep_first_entity() {
  let text = "Alice Smith";
  let entities = vec![
    Entity::detected(0, 11, "person", "Alice Smith"),
    Entity::detected(6, 11, "person", "Smith"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redacted_text, "[PERSON_1]");
  assert_eq!(result.entity_count, 1);
}

#[test]
fn equivalent_crypto_spellings_share_placeholders() {
  let text = concat!(
    "ETH wallet 0x742d35Cc6634C0532925a3b844Bc454e4438f44e.\n",
    "ETH wallet 0x742d35cc6634c0532925a3b844bc454e4438f44e."
  );
  let first = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
  let second = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
  let entities = vec![
    entity(text, "crypto", first),
    entity(text, "crypto", second),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(result.redaction_map[0].placeholder, "[CRYPTO_1]");
}

#[test]
fn equivalent_nhs_cues_share_placeholders() {
  let text = concat!(
    "NHS number 401 023 2137 was present.\n",
    "National Health Service No. 401 023 2137 was repeated."
  );
  let first = "NHS number 401 023 2137";
  let second = "National Health Service No. 401 023 2137";
  let entities = vec![
    entity(text, "national identification number", first),
    entity(text, "national identification number", second),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(
    result.redaction_map[0].placeholder,
    "[NATIONAL_IDENTIFICATION_NUMBER_1]"
  );
}

#[test]
fn equivalent_passport_cues_share_placeholders() {
  let text = concat!(
    "US passport number X12345678 was inspected.\n",
    "Passport No. X12345678 was listed."
  );
  let entities = vec![
    entity(text, "passport number", "US passport number X12345678"),
    entity(text, "passport number", "Passport No. X12345678"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(result.redaction_map[0].placeholder, "[PASSPORT_NUMBER_1]");
}

#[test]
fn passport_prefixes_split_by_separators_stay_distinct() {
  let text =
    "Passport X-12345678 was inspected. Passport Y 12345678 was listed.";
  let entities = vec![
    entity(text, "passport number", "X-12345678"),
    entity(text, "passport number", "Y 12345678"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 2);
  assert_eq!(result.redaction_map[0].placeholder, "[PASSPORT_NUMBER_1]");
  assert_eq!(result.redaction_map[1].placeholder, "[PASSPORT_NUMBER_2]");
}
