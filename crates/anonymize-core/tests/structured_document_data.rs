#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

use stella_anonymize_core::{
  OperatorConfig, PreparedEngine, PreparedEngineConfig,
};

const TD3: &str = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10";
const TRACK2: &str = ";4111111111111111=25121010000000000000?";

const TRACK1: &str = "%B4111111111111111^DOE/JOHN Q^25121010000000000000?";

#[test]
fn prepared_engine_redacts_structured_records_and_respects_label_filtering() {
  let text = format!("{TD3}\n{TRACK2}");
  let prepared = PreparedEngine::new(PreparedEngineConfig::default()).unwrap();
  let detected = prepared.detect_static_entities(&text).unwrap();
  assert_eq!(detected.entities.structured_document_data().len(), 2);
  assert!(
    detected
      .entities
      .all_entities()
      .iter()
      .any(|entity| entity.label == "passport number" && entity.text == TD3)
  );
  let result = prepared
    .redact_static_entities(&text, &OperatorConfig::default())
    .unwrap();
  assert!(
    result
      .redaction
      .redacted_text
      .contains("[PASSPORT_NUMBER_1]")
  );
  assert!(
    result
      .redaction
      .redacted_text
      .contains("[CREDIT_CARD_NUMBER_1]")
  );

  let mut config = PreparedEngineConfig::default();
  config.policy.allowed_labels = vec![String::from("credit card number")];
  let filtered = PreparedEngine::new(config)
    .unwrap()
    .detect_static_entities(&text)
    .unwrap();
  let entities = filtered.entities.all_entities();
  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].label, "credit card number");
}

#[test]
fn equivalent_payment_tracks_share_the_pan_placeholder_identity() {
  let text = format!("{TRACK1}\n{TRACK2}");
  let result = PreparedEngine::new(PreparedEngineConfig::default())
    .unwrap()
    .redact_static_entities(&text, &OperatorConfig::default())
    .unwrap()
    .redaction;

  assert_eq!(
    result.redacted_text,
    "[CREDIT_CARD_NUMBER_1]\n[CREDIT_CARD_NUMBER_1]"
  );
  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(
    result.redaction_map[0].placeholder,
    "[CREDIT_CARD_NUMBER_1]"
  );
}
