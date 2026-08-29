//! `signature_data`: ports `buildNativeSignatureData`
//! (`build-unified-search.ts`).
//!
//! Person-introducing and generic form labels are scoped to configured content
//! languages so an unrelated language's label cannot start or truncate a name.
//! PDF signing software stamps are language-neutral because tools commonly emit
//! English text inside otherwise non-English documents.

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{AssembleError, OrderedMap};

use super::language::language_keyed_terms;
use crate::BindingSignatureData;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureDetection {
  #[serde(default)]
  labels: OrderedMap<Value>,
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
) -> Result<BindingSignatureData, AssembleError> {
  let data: SignatureDetection =
    stella_anonymize_core::assemble::parse_data_file(
      "signature-detection.json",
    )?;
  Ok(BindingSignatureData {
    labels: language_keyed_terms(&data.labels, selected),
    person_list_labels: language_keyed_terms(
      &data.person_list_labels,
      selected,
    ),
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

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use serde::Deserialize;
  use serde_json::Value;
  use stella_anonymize_core::{OperatorConfig, PreparedEngine};

  use super::{build_signature_data, form_field_labels};
  use crate::{
    BindingPreparedSearchConfig, prepared_search_config_from_binding,
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

  fn notice_fixtures() -> NoticeFixtures {
    serde_json::from_str(include_str!(
      "../../tests/fixtures/signature-notices.json"
    ))
    .unwrap()
  }

  fn detected_people(text: &str, language: &str) -> Vec<String> {
    let signature_data =
      build_signature_data(Some(&[language.to_owned()])).unwrap();
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

  #[test]
  fn scoped_packages_keep_cross_locale_signing_software_stamps() {
    let data = build_signature_data(Some(&[String::from("cs")])).unwrap();

    assert!(
      data
        .signature_stamp_phrases
        .iter()
        .any(|phrase| phrase == "digitally signed by")
    );
    assert!(data.form_field_labels.iter().any(|label| label == "jméno"));
    assert!(!data.form_field_labels.iter().any(|label| label == "name"));
    assert!(!data.labels.iter().any(|label| label == "name"));
    assert!(
      build_signature_data(Some(&[String::from("en")]))
        .unwrap()
        .labels
        .iter()
        .any(|label| label == "name")
    );
  }

  #[test]
  fn german_registry_labels_share_the_scoped_field_source() {
    let german_signature =
      build_signature_data(Some(&[String::from("de")])).unwrap();
    let english_signature =
      build_signature_data(Some(&[String::from("en")])).unwrap();
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
