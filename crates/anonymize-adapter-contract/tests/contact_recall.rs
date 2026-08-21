#![allow(clippy::expect_used)]

use stella_anonymize_adapter_contract::{
  assemble_static_search_config, prepared_search_config_from_binding,
};
use stella_anonymize_core::PreparedEngine;
use stella_anonymize_core::assemble::PipelineConfig;

fn prepared(language: &str) -> PreparedEngine {
  let json = format!(
    r#"{{
      "threshold": 0.3,
      "enableTriggerPhrases": false,
      "enableRegex": true,
      "language": "{language}",
      "enableLegalForms": false,
      "enableNameCorpus": false,
      "enableDenyList": false,
      "enableGazetteer": false,
      "enableCountries": false,
      "enableConfidenceBoost": false,
      "enableCoreference": false,
      "enableZoneClassification": false,
      "labels": ["email address", "phone number"],
      "workspaceId": "contact-recall-rust-test"
    }}"#
  );
  let config: PipelineConfig =
    serde_json::from_str(&json).expect("synthetic config should deserialize");
  let binding = assemble_static_search_config(&config, None, &[])
    .expect("synthetic config should assemble");
  let core = prepared_search_config_from_binding(binding)
    .expect("assembled config should convert");
  PreparedEngine::new(core).expect("contact pipeline should prepare")
}

fn texts(engine: &PreparedEngine, text: &str, label: &str) -> Vec<String> {
  engine
    .detect_static_entities(text)
    .expect("synthetic contact detection should succeed")
    .entities
    .all_entities()
    .into_iter()
    .filter(|entity| entity.label == label)
    .map(|entity| entity.text)
    .collect()
}

#[test]
fn detects_rfcish_idn_and_written_emails() {
  let engine = prepared("en");
  for email in [
    "legal!notices@example.test",
    "claims/emea=urgent@xn--bcher-kva.example",
    "counsel@büro.example",
    "counsel@bu\u{0308}ro.example",
    "bu\u{0308}ro@example.test",
    "x\u{0308}-legal@example.test",
    "legal.notices at example dot test",
    "Legal.Notices AT Example DOT Test",
    "legal at bu\u{0308}ro dot example",
  ] {
    let text = format!("Send notice to {email}.");
    assert_eq!(texts(&engine, &text, "email address"), [email]);
  }
}

#[test]
fn detects_written_email_at_input_end_and_before_punctuation() {
  let engine = prepared("en");
  for (text, expected) in [
    (
      "legal.notices at example dot test",
      "legal.notices at example dot test",
    ),
    (
      "legal.notices at example dot test.",
      "legal.notices at example dot test",
    ),
  ] {
    assert_eq!(texts(&engine, text, "email address"), [expected]);
  }
}

#[test]
fn written_email_vocabulary_is_language_scoped() {
  let engine = prepared("cs");
  assert!(
    texts(
      &engine,
      "Reference legal.notices at example dot test remains prose.",
      "email address"
    )
    .is_empty()
  );
}

#[test]
fn ordinary_at_prose_does_not_activate_written_email_detection() {
  let engine = prepared("en");
  assert!(
    texts(
      &engine,
      "The tenant may resume at reasonable times after written notice.",
      "email address"
    )
    .is_empty()
  );
}

#[test]
fn detects_00_international_and_valid_nanp_phones() {
  let engine = prepared("en");
  for phone in [
    "0044 20 7946 0958",
    "+44 (20) 7946 0958",
    "+1 415 555 0132",
    "+420 212 345 678",
    "+49 30 12345678",
    "(212) 555-0142",
    "1-415-555-0132",
  ] {
    let text = format!("Call {phone}.");
    assert_eq!(texts(&engine, &text, "phone number"), [phone]);
  }
}

#[test]
fn rejects_invalid_contact_shapes() {
  let engine = prepared("en");
  for text in [
    "Reference legal..notices@example.test only.",
    "Reference legal@example-.test only.",
    "Reference a@example.test_suffix only.",
    "Reference a@büro.example_suffix only.",
    "Reference a@example.test\u{0308}_suffix only.",
    "Reference \u{0301}alice@example.test only.",
    "Reference alice.\u{0301}bob@example.test only.",
    "Reference a@example.test@evil.example only.",
    "Call 012-555-0142.",
    "Call 212-111-0142.",
    "Call +44 (20 7946 0958.",
    "Call +44 20) 7946 0958.",
    "Adjustment +2024-01-01 applies.",
    "Date key +20240721 applies.",
    "Date key +2024-0721 applies.",
    "Case No. +44-2024-01-01.",
    "Law No. +420 2024 01 01.",
    "Case No. +4420240101.",
    "Law No. +42020240721.",
    "Variance +1.234.567 was recorded.",
    "Increment +123-45-67 applies.",
    "Reference +12-345-6789.",
    "Clause +12.34.56.78 applies.",
    "Reference +1234567.",
    "Account 4537891022 remains an account number.",
  ] {
    assert!(
      texts(&engine, text, "email address").is_empty(),
      "unexpected email in {text}"
    );
    assert!(
      texts(&engine, text, "phone number").is_empty(),
      "unexpected phone in {text}"
    );
  }
}
