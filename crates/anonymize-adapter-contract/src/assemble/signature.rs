//! `signature_data`: ports `buildNativeSignatureData`
//! (`build-unified-search.ts`).
//!
//! Existing detection fields include all languages for TypeScript parity. The
//! generic form labels are scoped to configured content languages so an
//! unrelated language's label cannot truncate a surname. PDF signing software
//! stamps are language-neutral because tools commonly emit English text inside
//! otherwise non-English documents.

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, Dictionaries, OrderedMap,
};
use stella_anonymize_core::encode_party_role_name_evidence;

use super::language::language_keyed_terms;
use crate::BindingSignatureData;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureDetection {
  #[serde(default)]
  labels: OrderedMap<Value>,
  #[serde(default)]
  person_value_labels: OrderedMap<Value>,
  #[serde(default)]
  person_list_labels: OrderedMap<Value>,
  #[serde(default)]
  witness_phrases: OrderedMap<Value>,
  #[serde(default)]
  name_particles: OrderedMap<Value>,
  #[serde(default)]
  post_nominal_suffixes: OrderedMap<Value>,
  #[serde(default)]
  organization_suffixes: OrderedMap<Value>,
  #[serde(default)]
  form_field_labels: OrderedMap<Value>,
  #[serde(default)]
  contact_field_labels: OrderedMap<Value>,
  #[serde(default)]
  signature_stamp_phrases: OrderedMap<Value>,
  #[serde(default)]
  image_stub_prefixes: OrderedMap<Value>,
}

pub(super) fn form_field_labels(
  selected: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  let data: SignatureDetection =
    stella_anonymize_core::assemble::parse_data_file(
      "signature-detection.json",
    )?;
  Ok(language_keyed_terms(&data.form_field_labels, selected))
}

/// # Errors
///
/// Returns [`AssembleError`] when `signature-detection.json` fails to parse.
pub(super) fn build_signature_data(
  selected: Option<&[String]>,
  dictionaries: Option<&Dictionaries>,
) -> Result<BindingSignatureData, AssembleError> {
  let data: SignatureDetection =
    stella_anonymize_core::assemble::parse_data_file(
      "signature-detection.json",
    )?;
  Ok(BindingSignatureData {
    labels: language_keyed_terms(&data.labels, None),
    person_value_labels: language_keyed_terms(
      &data.person_value_labels,
      selected,
    ),
    person_list_labels: language_keyed_terms(
      &data.person_list_labels,
      selected,
    ),
    party_role_name_evidence: cross_locale_party_role_first_names(
      dictionaries,
    )?,
    witness_phrases: language_keyed_terms(&data.witness_phrases, None),
    name_particles: language_keyed_terms(&data.name_particles, None),
    post_nominal_suffixes: language_keyed_terms(
      &data.post_nominal_suffixes,
      None,
    ),
    organization_suffixes: language_keyed_terms(
      &data.organization_suffixes,
      None,
    ),
    form_field_labels: language_keyed_terms(&data.form_field_labels, selected),
    contact_field_labels: language_keyed_terms(
      &data.contact_field_labels,
      selected,
    ),
    signature_stamp_phrases: language_keyed_terms(
      &data.signature_stamp_phrases,
      None,
    ),
    image_stub_prefixes: language_keyed_terms(&data.image_stub_prefixes, None),
  })
}

/// Legal-party fields may contain a name from outside the document language.
/// Keep that evidence separate from the language-scoped detector corpus so it
/// can verify a structured field without enabling cross-locale name matches in
/// ordinary prose.
fn cross_locale_party_role_first_names(
  dictionaries: Option<&Dictionaries>,
) -> Result<String, AssembleError> {
  encode_party_role_name_evidence(
    dictionaries
      .and_then(|dictionaries| dictionaries.first_names.as_ref())
      .into_iter()
      .flat_map(OrderedMap::values)
      .flatten()
      .cloned(),
  )
  .map_err(|error| AssembleError::InvalidDictionaryData {
    field: "firstNames",
    message: error.to_string(),
  })
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use serde::Deserialize;
  use serde_json::Value;
  use stella_anonymize_core::assemble::{
    Dictionaries, OrderedMap, PipelineConfig,
  };
  use stella_anonymize_core::{OperatorConfig, PreparedEngine};

  use super::{build_signature_data, form_field_labels};
  use crate::{
    BindingPreparedSearchConfig, BindingSignatureData,
    prepared_search_config_from_binding,
  };

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase", deny_unknown_fields)]
  struct NoticeFixture {
    language: String,
    text: String,
    expected_names: Vec<String>,
  }

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase", deny_unknown_fields)]
  struct NegativeNoticeFixture {
    language: String,
    text: String,
  }

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase", deny_unknown_fields)]
  struct NoticeFixtures {
    cases: Vec<NoticeFixture>,
    negative_cases: Vec<NegativeNoticeFixture>,
  }

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct NoticeCoverage {
    person_value_labels: stella_anonymize_core::assemble::OrderedMap<Value>,
    person_value_label_omissions:
      stella_anonymize_core::assemble::OrderedMap<Value>,
    person_list_labels: stella_anonymize_core::assemble::OrderedMap<Value>,
    person_list_label_omissions:
      stella_anonymize_core::assemble::OrderedMap<Value>,
    contact_field_labels: stella_anonymize_core::assemble::OrderedMap<Value>,
  }

  #[derive(Deserialize)]
  #[serde(deny_unknown_fields)]
  struct Manifest {
    #[serde(default, rename = "_comment")]
    _comment: Option<String>,
    languages: stella_anonymize_core::assemble::OrderedMap<Value>,
  }

  fn language_or_base_value<'a>(
    terms: &'a stella_anonymize_core::assemble::OrderedMap<Value>,
    language: &str,
  ) -> Option<&'a Value> {
    terms.get(language).or_else(|| {
      language
        .split_once('-')
        .and_then(|(base, _)| terms.get(base))
    })
  }

  fn notice_fixtures() -> NoticeFixtures {
    serde_json::from_str(include_str!(
      "../../tests/fixtures/signature-notices.json"
    ))
    .unwrap()
  }

  fn detected_people(text: &str, language: &str) -> Vec<String> {
    detected_people_with_signature_data(
      text,
      build_signature_data(Some(&[language.to_owned()]), None).unwrap(),
    )
  }

  fn detected_people_with_signature_data(
    text: &str,
    signature_data: BindingSignatureData,
  ) -> Vec<String> {
    let config =
      prepared_search_config_from_binding(BindingPreparedSearchConfig {
        allowed_labels: vec![String::from("person")],
        threshold: 0.5,
        signature_data: Some(signature_data),
        ..BindingPreparedSearchConfig::default()
      })
      .unwrap();
    PreparedEngine::new(config)
      .unwrap()
      .redact_static_entities(text, &OperatorConfig::default())
      .unwrap()
      .resolved_entities
      .into_iter()
      .map(|entity| entity.text)
      .collect()
  }

  fn detected_trigger_people(text: &str, language: &str) -> Vec<String> {
    let config: PipelineConfig = serde_json::from_value(serde_json::json!({
      "threshold": 0.3,
      "enableTriggerPhrases": true,
      "enableRegex": true,
      "language": language,
      "enableLegalForms": true,
      "enableNameCorpus": false,
      "enableDenyList": false,
      "enableGazetteer": false,
      "enableCountries": false,
      "enableConfidenceBoost": false,
      "enableCoreference": false,
      "enableZoneClassification": false,
      "labels": ["person"],
      "workspaceId": "person-value-label-test"
    }))
    .unwrap();
    let binding =
      crate::assemble_static_search_config(&config, None, &[]).unwrap();
    let prepared = PreparedEngine::new(
      prepared_search_config_from_binding(binding).unwrap(),
    )
    .unwrap();
    prepared
      .detect_static_entities(text)
      .unwrap()
      .entities
      .trigger()
      .iter()
      .filter(|entity| entity.label == "person")
      .map(|entity| entity.text.clone())
      .collect()
  }

  fn detected_party_people_without_name_corpus(
    text: &str,
    language: &str,
  ) -> Vec<String> {
    let config: PipelineConfig = serde_json::from_value(serde_json::json!({
      "threshold": 0.3,
      "enableTriggerPhrases": true,
      "enableRegex": true,
      "language": language,
      "enableLegalForms": true,
      "enableNameCorpus": false,
      "enableDenyList": false,
      "enableGazetteer": false,
      "enableCountries": false,
      "enableConfidenceBoost": false,
      "enableCoreference": false,
      "enableZoneClassification": false,
      "labels": ["person"],
      "workspaceId": "party-role-without-name-corpus-test"
    }))
    .unwrap();
    let dictionaries = Dictionaries {
      first_names: Some(OrderedMap(vec![(
        String::from("en"),
        vec![String::from("Imani"), String::from("Jean")],
      )])),
      ..Dictionaries::default()
    };
    let binding =
      crate::assemble_static_search_config(&config, Some(&dictionaries), &[])
        .unwrap();
    let prepared = PreparedEngine::new(
      prepared_search_config_from_binding(binding).unwrap(),
    )
    .unwrap();
    prepared
      .redact_static_entities(text, &OperatorConfig::default())
      .unwrap()
      .resolved_entities
      .into_iter()
      .filter(|entity| entity.label == "person")
      .map(|entity| entity.text)
      .collect()
  }

  fn detected_scoped_party_people(text: &str) -> Vec<String> {
    let config: PipelineConfig = serde_json::from_value(serde_json::json!({
      "threshold": 0.3,
      "enableTriggerPhrases": true,
      "enableRegex": true,
      "language": "en",
      "nameCorpusLanguages": ["en"],
      "enableLegalForms": true,
      "enableNameCorpus": true,
      "enableDenyList": true,
      "enableGazetteer": false,
      "enableCountries": false,
      "enableConfidenceBoost": true,
      "enableCoreference": true,
      "enableZoneClassification": true,
      "labels": ["person"],
      "workspaceId": "scoped-global-party-role-test"
    }))
    .unwrap();
    let dictionaries = Dictionaries {
      first_names: Some(OrderedMap(vec![
        (String::from("en"), vec![String::from("Ayo")]),
        (String::from("sk"), vec![String::from("Imani")]),
        (String::from("pl"), vec![String::from("Zofia")]),
      ])),
      surnames: Some(OrderedMap(vec![(
        String::from("en"),
        vec![
          String::from("Mercer"),
          String::from("Balogun"),
          String::from("Okafor"),
        ],
      )])),
      ..Dictionaries::default()
    };
    let binding =
      crate::assemble_static_search_config(&config, Some(&dictionaries), &[])
        .unwrap();
    let prepared = PreparedEngine::new(
      prepared_search_config_from_binding(binding).unwrap(),
    )
    .unwrap();
    prepared
      .redact_static_entities(text, &OperatorConfig::default())
      .unwrap()
      .resolved_entities
      .into_iter()
      .filter(|entity| entity.label == "person")
      .map(|entity| entity.text)
      .collect()
  }

  #[test]
  fn scoped_packages_keep_cross_locale_signing_software_stamps() {
    let data = build_signature_data(Some(&[String::from("cs")]), None).unwrap();

    assert!(
      data
        .signature_stamp_phrases
        .iter()
        .any(|phrase| phrase == "digitally signed by")
    );
    assert!(data.form_field_labels.iter().any(|label| label == "jméno"));
    assert!(!data.form_field_labels.iter().any(|label| label == "name"));
    assert!(data.labels.iter().any(|label| label == "name"));
    assert!(!data.labels.iter().any(|label| label == "jméno"));
    assert!(
      data
        .person_value_labels
        .iter()
        .any(|label| label == "jméno")
    );
    assert!(!data.person_value_labels.iter().any(|label| label == "name"));
    assert!(
      !data
        .person_value_labels
        .iter()
        .any(|label| label == "nombre")
    );
  }

  #[test]
  fn scoped_person_value_labels_drive_production_trigger_detection() {
    assert_eq!(
      detected_people("By: Q. Z. Mercer", "en"),
      vec![String::from("Q. Z. Mercer")]
    );
    assert_eq!(
      detected_people("zastoupen Jméno: Jan Novák", "cs"),
      vec![String::from("Jan Novák")]
    );
    assert_eq!(
      detected_people_with_signature_data(
        "zastoupen Jméno: Jan Novák",
        build_signature_data(None, None).unwrap(),
      ),
      vec![String::from("Jan Novák")]
    );

    assert!(detected_people("zastoupen name: Main Street", "cs").is_empty());
    assert!(
      detected_trigger_people("zastoupen name: Main Street", "cs").is_empty()
    );
    assert_eq!(
      detected_trigger_people("zastoupen Jméno: Jan Novák", "cs"),
      vec![String::from("Jan Novák")]
    );
    assert!(
      detected_trigger_people("represented by seller: Acme Trading", "en",)
        .is_empty()
    );
    assert_eq!(
      detected_party_people_without_name_corpus("Seller: Imani Nwosu", "en"),
      vec![String::from("Imani Nwosu")]
    );
    assert_eq!(
      detected_party_people_without_name_corpus(
        "Seller: Jean-Paul Smith",
        "en"
      ),
      vec![String::from("Jean-Paul Smith")]
    );
    assert_eq!(
      detected_people("Jméno: Jan Příjmení: Novák", "cs"),
      vec![String::from("Jan"), String::from("Novák")]
    );
    assert!(
      detected_party_people_without_name_corpus("Seller: Acme Trading", "en")
        .is_empty()
    );
    assert!(
      detected_party_people_without_name_corpus("Seller: General Lender", "en")
        .is_empty()
    );
    assert!(
      detected_party_people_without_name_corpus("Customer: Harbor Legal", "en")
        .is_empty()
    );

    let mut signature =
      build_signature_data(Some(&[String::from("en")]), None).unwrap();
    signature.labels.push(String::from("seller"));
    assert!(
      detected_people_with_signature_data(
        "represented by seller: Acme Trading",
        signature,
      )
      .is_empty()
    );
  }

  #[test]
  fn scoped_corpus_uses_cross_locale_first_names_only_for_party_roles() {
    assert_eq!(
      detected_scoped_party_people(
        "Buyer: Q. Z. Mercer\nSeller: Imani Nwosu\nLender: Ayo Balogun\nGuarantor: B. T. Okafor"
      ),
      ["Q. Z. Mercer", "Imani Nwosu", "Ayo Balogun", "B. T. Okafor"]
    );
    assert_eq!(
      detected_scoped_party_people("Borrower:\nZofia Wrona"),
      ["Zofia Wrona"]
    );
    assert!(detected_scoped_party_people("Seller: Acme Trading").is_empty());
    assert!(detected_scoped_party_people("Seller: General Lender").is_empty());
    assert!(detected_scoped_party_people("Imani Nwosu").is_empty());
  }

  #[test]
  fn german_registry_labels_share_the_scoped_field_source() {
    let german_signature =
      build_signature_data(Some(&[String::from("de")]), None).unwrap();
    let english_signature =
      build_signature_data(Some(&[String::from("en")]), None).unwrap();
    let german = form_field_labels(Some(&[String::from("de")])).unwrap();
    let english = form_field_labels(Some(&[String::from("en")])).unwrap();

    assert!(german.iter().any(|label| label == "hrb"));
    assert!(german.iter().any(|label| label == "ust-idnr."));
    assert!(!english.iter().any(|label| label == "hrb"));
    assert!(english.iter().any(|label| label == "vat"));
    assert!(
      english_signature
        .person_list_labels
        .iter()
        .any(|label| label == "attention")
    );
    assert!(
      english_signature
        .contact_field_labels
        .iter()
        .any(|label| label == "email")
    );
    assert!(
      german_signature
        .person_list_labels
        .iter()
        .any(|label| label == "zu händen von")
    );
    assert!(
      german_signature
        .contact_field_labels
        .iter()
        .any(|label| label == "telefon")
    );
    assert!(
      german_signature
        .person_list_labels
        .iter()
        .all(|label| label != "attention")
    );
  }

  #[test]
  fn manifest_languages_have_reviewed_notice_coverage() {
    let data: NoticeCoverage =
      stella_anonymize_core::assemble::parse_data_file(
        "signature-detection.json",
      )
      .unwrap();
    let manifest: Manifest =
      stella_anonymize_core::assemble::parse_data_file("manifest.json")
        .unwrap();

    for (language, _) in &manifest.languages {
      let has_person_value_label =
        language_or_base_value(&data.person_value_labels, language)
          .and_then(Value::as_array)
          .is_some_and(|labels| !labels.is_empty());
      let has_person_value_omission =
        language_or_base_value(&data.person_value_label_omissions, language)
          .and_then(Value::as_str)
          .is_some_and(|rationale| !rationale.trim().is_empty());
      assert_ne!(
        has_person_value_label, has_person_value_omission,
        "{language} must have either reviewed person-value labels or one omission rationale"
      );
      let has_person_label = data
        .person_list_labels
        .get(language)
        .and_then(Value::as_array)
        .is_some_and(|labels| !labels.is_empty());
      let has_documented_omission = data
        .person_list_label_omissions
        .get(language)
        .and_then(Value::as_str)
        .is_some_and(|rationale| !rationale.trim().is_empty());
      assert_ne!(
        has_person_label, has_documented_omission,
        "{language} must have either reviewed person-list labels or one omission rationale"
      );
      assert!(
        data
          .contact_field_labels
          .get(language)
          .and_then(Value::as_array)
          .is_some_and(|labels| !labels.is_empty()),
        "{language} must have reviewed contact-field terminators"
      );
    }
  }

  #[test]
  fn native_notice_fixtures_detect_people_without_language_leakage() {
    let fixtures = notice_fixtures();
    for fixture in fixtures.cases {
      assert_eq!(
        detected_people(&fixture.text, &fixture.language),
        fixture.expected_names,
        "native notice fixture for {}",
        fixture.language
      );
      assert!(
        detected_people(&fixture.text, "sv").is_empty(),
        "{} notice vocabulary leaked into Swedish",
        fixture.language
      );
    }
    for fixture in fixtures.negative_cases {
      assert!(
        detected_people(&fixture.text, &fixture.language).is_empty(),
        "negative notice fixture for {}",
        fixture.language
      );
    }
  }
}
