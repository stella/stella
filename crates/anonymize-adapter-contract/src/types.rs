//! Binding-facing DTOs for the prepared-search configuration and
//! operator contracts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingSearchPattern {
  pub kind: String,
  pub pattern: String,
  pub distance: Option<u32>,
  pub case_insensitive: Option<bool>,
  pub whole_words: Option<bool>,
  pub lazy: Option<bool>,
  pub prefilter_any: Option<Vec<String>>,
  pub prefilter_case_insensitive: Option<bool>,
  pub prefilter_regex: Option<String>,
  pub prefilter_window_bytes: Option<u32>,
  pub prepared_artifact_policy: Option<BindingPreparedArtifactPolicy>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingSearchOptions {
  pub literal_case_insensitive: Option<bool>,
  pub literal_whole_words: Option<bool>,
  pub regex_whole_words: Option<bool>,
  pub regex_overlap_all: Option<bool>,
  pub regex_artifact_policy: Option<BindingRegexArtifactPolicy>,
  pub fuzzy_case_insensitive: Option<bool>,
  pub fuzzy_whole_words: Option<bool>,
  pub fuzzy_normalize_diacritics: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingRegexArtifactPolicy {
  Include,
  Omit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingPreparedArtifactPolicy {
  Include,
  Omit,
}

#[derive(
  Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct BindingPatternSlice {
  pub start: u32,
  pub end: u32,
}

#[derive(
  Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct BindingPreparedSearchSlices {
  pub regex: Option<BindingPatternSlice>,
  pub custom_regex: Option<BindingPatternSlice>,
  pub legal_forms: Option<BindingPatternSlice>,
  pub triggers: Option<BindingPatternSlice>,
  pub deny_list: Option<BindingPatternSlice>,
  pub street_types: Option<BindingPatternSlice>,
  pub gazetteer: Option<BindingPatternSlice>,
  pub countries: Option<BindingPatternSlice>,
  pub hotwords: Option<BindingPatternSlice>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingRegexMatchMeta {
  pub label: String,
  pub score: f64,
  pub source_detail: Option<String>,
  pub requires_validation: Option<bool>,
  pub validator_id: Option<String>,
  pub validator_input: Option<String>,
  pub min_byte_length: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingGazetteerMatchData {
  pub labels: Vec<String>,
  pub is_fuzzy: Vec<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingCountryMatchData {
  pub labels: Vec<String>,
  #[serde(rename = "isoCodes")]
  pub iso_codes: Vec<String>,
  pub variants: Vec<BindingCountryVariant>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BindingCountryVariant {
  Name,
  Alias,
  Alpha3,
  Alpha2,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingHotwordRuleData {
  #[serde(default)]
  pub rules: Vec<BindingHotwordRule>,
  #[serde(default)]
  pub pattern_rule_indices: Vec<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingHotwordRule {
  #[serde(default)]
  pub hotwords: Vec<String>,
  #[serde(default)]
  pub target_labels: Vec<String>,
  pub score_adjustment: f64,
  pub reclassify_to: Option<String>,
  pub proximity_before: u32,
  pub proximity_after: u32,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingTriggerData {
  pub rules: Vec<BindingTriggerRule>,
  #[serde(default)]
  pub address_stop_keywords: Vec<String>,
  #[serde(default)]
  pub party_position_terms: Vec<String>,
  #[serde(default)]
  pub post_nominals: Vec<String>,
  #[serde(default)]
  pub sentence_terminal_currency_terms: Vec<String>,
  #[serde(default)]
  pub phone_extension_labels: Vec<String>,
  #[serde(default)]
  pub number_markers: Vec<String>,
  #[serde(default)]
  pub number_labels: Vec<String>,
  #[serde(default)]
  pub person_field_labels: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingSignatureData {
  #[serde(default)]
  pub labels: Vec<String>,
  pub person_value_labels: Vec<String>,
  #[serde(default)]
  pub person_list_labels: Vec<String>,
  pub party_role_name_evidence: String,
  #[serde(default)]
  pub witness_phrases: Vec<String>,
  #[serde(default)]
  pub name_particles: Vec<String>,
  #[serde(default)]
  pub post_nominal_suffixes: Vec<String>,
  #[serde(default)]
  pub organization_suffixes: Vec<String>,
  pub form_field_labels: Vec<String>,
  #[serde(default)]
  pub contact_field_labels: Vec<String>,
  pub signature_stamp_phrases: Vec<String>,
  pub image_stub_prefixes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingTriggerRule {
  pub trigger: String,
  pub label: String,
  pub strategy: BindingTriggerStrategy,
  pub validations: Vec<BindingTriggerValidation>,
  pub include_trigger: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
// Empty struct variants make serde reject extra members on payload-free cases.
#[allow(clippy::empty_enum_variants_with_brackets)]
pub enum BindingTriggerStrategy {
  ToNextComma {
    #[serde(default)]
    stop_words: Vec<String>,
    max_length: Option<u32>,
  },
  ToEndOfLine {},
  NWords {
    count: u32,
  },
  CompanyIdValue {},
  Address {
    max_chars: Option<u32>,
  },
  MatchPattern {
    pattern: String,
    flags: Option<String>,
  },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
// Empty struct variants make serde reject extra members on payload-free cases.
#[allow(clippy::empty_enum_variants_with_brackets)]
pub enum BindingTriggerValidation {
  StartsUppercase {},
  MinLength {
    min: u32,
  },
  MaxLength {
    max: u32,
  },
  NoDigits {},
  HasDigits {},
  MatchesPattern {
    pattern: String,
    flags: Option<String>,
  },
  ValidId {
    validator: String,
  },
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingLegalFormData {
  #[serde(default)]
  pub suffixes: Vec<String>,
  #[serde(default)]
  pub non_ascii_name_short_suffixes: Vec<String>,
  pub detection_only_suffixes: Vec<String>,
  pub institutional_heads: Vec<String>,
  #[serde(default)]
  pub normalized_boundary_suffixes: Vec<String>,
  #[serde(default)]
  pub normalized_in_name_words: Vec<String>,
  #[serde(default)]
  pub normalized_suffix_words: Vec<String>,
  #[serde(default)]
  pub role_heads: Vec<String>,
  #[serde(default)]
  pub sentence_verb_indicators: Vec<String>,
  #[serde(default)]
  pub clause_noun_heads: Vec<String>,
  #[serde(default)]
  pub connector_prose_heads: Vec<String>,
  #[serde(default)]
  pub structural_single_cap_prefixes: Vec<String>,
  #[serde(default)]
  pub leading_clause_phrases: Vec<String>,
  #[serde(default)]
  pub leading_clause_direct_prefixes: Vec<String>,
  #[serde(default)]
  pub connector_words: Vec<String>,
  #[serde(default)]
  pub and_connector_words: Vec<String>,
  #[serde(default)]
  pub in_name_prepositions: Vec<String>,
  #[serde(default)]
  pub company_suffix_words: Vec<String>,
  #[serde(default)]
  pub comma_gated_direct_prefixes: Vec<String>,
  pub institutional_complement_heads: Vec<String>,
  pub institutional_complement_starters: Vec<String>,
  pub institutional_complement_connectors: Vec<String>,
  pub institutional_generic_words: Vec<String>,
  pub institutional_prefix_generic_words: Vec<String>,
  #[serde(default)]
  pub lowercase_bridge: BindingLowercaseBridge,
}

/// Lowercase-bridge policy of the legal-form name walk. A struct with a unit
/// discriminator rather than a tagged enum so the binding payload stays
/// postcard-encodable without a wire mirror.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingLowercaseBridge {
  pub policy: BindingLowercaseBridgePolicy,
  /// Connector words admitted between capitalized name words; only read for
  /// `closed`.
  #[serde(default)]
  pub words: Vec<String>,
}

#[derive(
  Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum BindingLowercaseBridgePolicy {
  #[default]
  Open,
  Closed,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingDateData {
  pub month_names_by_language: BTreeMap<String, Vec<String>>,
  pub lowercase_month_ambiguities: BTreeMap<String, Vec<String>>,
  pub year_words_by_language: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingMonetaryData {
  #[serde(default)]
  pub currencies: BindingCurrencyData,
  #[serde(default)]
  pub amount_words: BindingAmountWordsData,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingCurrencyData {
  #[serde(default)]
  pub codes: Vec<String>,
  #[serde(default)]
  pub symbols: Vec<String>,
  #[serde(default)]
  pub local_names: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingAmountWordsData {
  #[serde(default)]
  pub written_amount_patterns: Vec<BindingWrittenAmountPatternData>,
  #[serde(default)]
  pub number_words: Vec<BindingNumberWordData>,
  #[serde(default)]
  pub magnitude_suffixes: Vec<BindingMagnitudeSuffixData>,
  #[serde(default)]
  pub share_quantity_terms: Vec<BindingShareQuantityTermData>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingWrittenAmountPatternData {
  #[serde(default)]
  pub keywords: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingNumberWordData {
  #[serde(default)]
  pub words: Vec<String>,
  #[serde(default)]
  pub joiners: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingMagnitudeSuffixData {
  #[serde(default)]
  pub words: Vec<String>,
  #[serde(default)]
  pub abbreviations_case_insensitive: Vec<String>,
  #[serde(default)]
  pub abbreviations_case_sensitive: Vec<String>,
  #[serde(default)]
  pub abbreviations_attached: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingShareQuantityTermData {
  #[serde(default)]
  pub modifiers: Vec<String>,
  #[serde(default)]
  pub nouns: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingStandaloneStreetData {
  #[serde(default)]
  pub street_type_words: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingAddressSeedData {
  #[serde(default)]
  pub boundary_words: Vec<String>,
  #[serde(default)]
  pub br_cep_cue_words: Vec<String>,
  #[serde(default)]
  pub unit_abbreviations: Vec<String>,
  /// Present only when the caller opts into standalone street detection.
  #[serde(default)]
  pub standalone_street: Option<BindingStandaloneStreetData>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingAddressContextData {
  #[serde(default)]
  pub address_prepositions: Vec<String>,
  #[serde(default)]
  pub temporal_prepositions: Vec<String>,
  #[serde(default)]
  pub street_abbreviations: Vec<String>,
  #[serde(default)]
  pub bare_house_stopwords: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingZoneData {
  #[serde(default)]
  pub section_heading_patterns: Vec<BindingZonePatternData>,
  #[serde(default)]
  pub signing_clauses: Vec<BindingZoneSigningClauseData>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingZonePatternData {
  pub pattern: String,
  #[serde(default)]
  pub flags: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingZoneSigningClauseData {
  #[serde(default)]
  pub prefix: String,
  #[serde(default)]
  pub suffix: String,
  #[serde(default)]
  pub prepositions: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingCoreferenceData {
  #[serde(default)]
  pub definition_patterns: Vec<BindingCoreferencePatternData>,
  #[serde(default)]
  pub role_stop_terms: Vec<String>,
  #[serde(default)]
  pub legal_form_aliases: Vec<String>,
  #[serde(default)]
  pub organization_suffixes: Vec<String>,
  #[serde(default)]
  pub organization_determiners: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingCoreferencePatternData {
  pub pattern: String,
  #[serde(default)]
  pub flags: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingNameCorpusData {
  #[serde(default)]
  pub first_names: Vec<String>,
  #[serde(default)]
  pub surnames: Vec<String>,
  #[serde(default)]
  pub title_tokens: Vec<String>,
  #[serde(default)]
  pub title_abbreviations: Vec<String>,
  #[serde(default)]
  pub excluded_words: Vec<String>,
  #[serde(default)]
  pub common_words: Vec<String>,
  #[serde(default)]
  pub non_western_names: Vec<String>,
  #[serde(default)]
  pub excluded_all_caps: Vec<String>,
  #[serde(default)]
  pub ja_suffixes: Vec<String>,
  #[serde(default)]
  pub arabic_connectors: Vec<String>,
  #[serde(default)]
  pub relation_connectors: Vec<String>,
  #[serde(default)]
  pub hyphenated_prefixes: Vec<String>,
  #[serde(default)]
  pub cjk_non_person_terms: Vec<String>,
  #[serde(default)]
  pub cjk_surname_starters: Vec<String>,
  #[serde(default)]
  pub organization_terms: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingDenyListMatchData {
  #[serde(default)]
  pub labels: Vec<Vec<String>>,
  #[serde(default)]
  pub label_table: Vec<String>,
  #[serde(default)]
  pub label_indices: Vec<Vec<u32>>,
  #[serde(default)]
  pub custom_labels: Vec<Vec<String>>,
  #[serde(default)]
  pub custom_label_indices: Vec<Vec<u32>>,
  pub originals: Vec<String>,
  #[serde(default)]
  pub sources: Vec<Vec<String>>,
  #[serde(default)]
  pub source_table: Vec<String>,
  #[serde(default)]
  pub source_indices: Vec<Vec<u32>>,
  pub filters: Option<BindingDenyListFilterData>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingDenyListFilterData {
  pub stopwords: Vec<String>,
  pub allow_list: Vec<String>,
  pub person_stopwords: Vec<String>,
  #[serde(default)]
  pub person_trailing_nouns: Vec<String>,
  #[serde(default)]
  pub address_trailing_nouns: Vec<String>,
  pub address_stopwords: Vec<String>,
  #[serde(default)]
  pub address_jurisdiction_prefixes: Vec<String>,
  pub street_types: Vec<String>,
  #[serde(default)]
  pub address_component_terms: Vec<String>,
  #[serde(default)]
  pub ambiguous_street_type_terms: Vec<String>,
  pub first_names: Vec<String>,
  pub generic_roles: Vec<String>,
  #[serde(default)]
  pub page_footer_markers: Vec<String>,
  #[serde(default)]
  pub number_abbrev_prefixes: Vec<String>,
  pub sentence_starters: Vec<String>,
  pub trailing_address_word_exclusions: Vec<String>,
  #[serde(default)]
  pub document_heading_words: Vec<String>,
  #[serde(default)]
  pub document_heading_ordinal_markers: Vec<String>,
  pub defined_term_cues: Vec<String>,
  #[serde(default)]
  pub unit_designators: Vec<String>,
  #[serde(default)]
  pub in_name_connectors: Vec<String>,
  #[serde(default)]
  pub us_state_abbreviations: Vec<String>,
  #[serde(default)]
  pub signing_place_guards: Vec<BindingSigningPlaceGuardData>,
  #[serde(default)]
  pub title_tokens: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingSigningPlaceGuardData {
  #[serde(default)]
  pub prefix_phrases: Vec<String>,
  #[serde(default)]
  pub suffix_phrases: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingPreparedSearchConfig {
  #[serde(default)]
  pub regex_patterns: Vec<BindingSearchPattern>,
  #[serde(default)]
  pub custom_regex_patterns: Vec<BindingSearchPattern>,
  #[serde(default)]
  pub literal_patterns: Vec<BindingSearchPattern>,
  #[serde(default)]
  pub regex_options: Option<BindingSearchOptions>,
  #[serde(default)]
  pub custom_regex_options: Option<BindingSearchOptions>,
  #[serde(default)]
  pub literal_options: Option<BindingSearchOptions>,
  #[serde(default)]
  pub literal_patterns_from_deny_list_data: bool,
  #[serde(default)]
  pub allowed_labels: Vec<String>,
  #[serde(default)]
  pub threshold: f64,
  #[serde(default)]
  pub confidence_boost: bool,
  #[serde(default)]
  pub slices: BindingPreparedSearchSlices,
  #[serde(default)]
  pub regex_meta: Vec<BindingRegexMatchMeta>,
  #[serde(default)]
  pub custom_regex_meta: Vec<BindingRegexMatchMeta>,
  #[serde(default)]
  pub deny_list_data: Option<BindingDenyListMatchData>,
  #[serde(default)]
  pub false_positive_filters: Option<BindingDenyListFilterData>,
  #[serde(default)]
  pub gazetteer_data: Option<BindingGazetteerMatchData>,
  #[serde(default)]
  pub country_data: Option<BindingCountryMatchData>,
  #[serde(default)]
  pub hotword_data: Option<BindingHotwordRuleData>,
  #[serde(default)]
  pub trigger_data: Option<BindingTriggerData>,
  #[serde(default)]
  pub legal_form_data: Option<BindingLegalFormData>,
  #[serde(default)]
  pub address_seed_data: Option<BindingAddressSeedData>,
  #[serde(default)]
  pub zone_data: Option<BindingZoneData>,
  #[serde(default)]
  pub address_context_data: Option<BindingAddressContextData>,
  #[serde(default)]
  pub coreference_data: Option<BindingCoreferenceData>,
  #[serde(default)]
  pub name_corpus_data: Option<BindingNameCorpusData>,
  #[serde(default)]
  pub signature_data: Option<BindingSignatureData>,
  #[serde(default)]
  pub name_corpus_mode: BindingNameCorpusMode,
  #[serde(default)]
  pub date_data: Option<BindingDateData>,
  #[serde(default)]
  pub monetary_data: Option<BindingMonetaryData>,
}

#[derive(
  Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum BindingNameCorpusMode {
  Full,
  #[default]
  Supplemental,
}
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingOperatorConfig {
  pub operators: Option<BTreeMap<String, BindingOperator>>,
  #[serde(default, alias = "redactString")]
  pub redact_string: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum BindingOperator {
  Name(String),
  Tagged(BindingTaggedOperator),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingTaggedOperator {
  #[serde(rename = "type")]
  pub operator_type: String,
  #[serde(alias = "maskingCharacter")]
  pub masking_character: String,
  #[serde(alias = "charactersToMask")]
  pub characters_to_mask: u32,
  pub direction: String,
}

#[cfg(test)]
mod tests {
  use serde_json::json;

  use super::BindingPreparedSearchConfig;

  #[test]
  fn direct_prepared_config_requires_signature_proof_fields() {
    let missing_person_labels = json!({
      "signature_data": {
        "form_field_labels": [],
        "image_stub_prefixes": [],
        "party_role_name_evidence": "",
        "signature_stamp_phrases": []
      }
    });
    assert!(
      serde_json::from_value::<BindingPreparedSearchConfig>(
        missing_person_labels
      )
      .is_err()
    );

    let missing_party_tokens = json!({
      "signature_data": {
        "form_field_labels": [],
        "image_stub_prefixes": [],
        "person_value_labels": [],
        "signature_stamp_phrases": []
      }
    });
    assert!(
      serde_json::from_value::<BindingPreparedSearchConfig>(
        missing_party_tokens
      )
      .is_err()
    );

    let explicitly_empty = json!({
      "signature_data": {
        "form_field_labels": [],
        "image_stub_prefixes": [],
        "party_role_name_evidence": "",
        "person_value_labels": [],
        "signature_stamp_phrases": []
      }
    });
    assert!(
      serde_json::from_value::<BindingPreparedSearchConfig>(explicitly_empty)
        .is_ok()
    );
  }
}
