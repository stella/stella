//! Serde input structs mirroring the TypeScript pipeline config.
//!
//! Shapes track `packages/anonymize/src/types.ts` (`PipelineConfig` and its
//! helper types). `rename_all = "camelCase"` lets these deserialize the exact
//! JSON the TypeScript SDK emits.

use serde::{Deserialize, Serialize};

use super::dictionaries::Dictionaries;

/// Closed set of deny-list dictionary categories.
///
/// Mirrors `DenyListCategory` in `types.ts`; variant names match the JSON
/// spellings exactly, so no rename is needed.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum DenyListCategory {
  Names,
  Places,
  Addresses,
  Courts,
  Financial,
  Government,
  Healthcare,
  Education,
  Political,
  Organizations,
  International,
}

/// Prepared-artifact policy for a caller-supplied pattern.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparedArtifactPolicy {
  Include,
  Omit,
}

/// Street-address detection without a known-city anchor.
///
/// Mirrors `StandaloneStreetDetection` in `types.ts`. Off by default: a
/// street-type word plus a nearby number is a much weaker signal than a
/// city-anchored address and fires on contract prose ("in place 30 days",
/// "District Court 2019"), so callers opt in per workspace.
#[derive(
  Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize,
)]
#[serde(rename_all = "camelCase")]
pub enum StandaloneStreetDetection {
  #[default]
  Off,
  /// Detect a street-type word only when a house number sits directly beside
  /// it, in either order ("14 Rue de la Paix", "Hauptstraße 5").
  HouseNumberAnchored,
}

/// Metadata for a single deny-list dictionary entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DictionaryMeta {
  pub label: String,
  pub category: DenyListCategory,
  /// ISO country code, or `null` for country-agnostic dictionaries.
  pub country: Option<String>,
}

/// Caller-supplied exact term for deny-list matching.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CustomDenyListEntry {
  pub value: String,
  pub label: String,
  pub variants: Option<Vec<String>>,
}

/// Caller-supplied regex detector.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRegexPattern {
  pub pattern: String,
  pub label: String,
  pub score: Option<f64>,
  pub prepared_artifact_policy: Option<PreparedArtifactPolicy>,
}

/// Configuration for the detection pipeline.
///
/// Mirrors `PipelineConfig` in `types.ts`. This struct intentionally carries
/// the same wide set of `enable*` toggles as the TypeScript type; it is a
/// boundary DTO, not internal domain state.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct PipelineConfig {
  pub threshold: f64,
  pub enable_trigger_phrases: bool,
  pub enable_regex: bool,
  pub languages: Option<Vec<String>>,
  pub language: Option<String>,
  /// Legacy callers omit this field; TS `isLegalFormsEnabled` treats it as
  /// `!== false`, so absence means enabled (see `legal_forms_enabled`).
  #[serde(default)]
  pub enable_legal_forms: Option<bool>,
  pub enable_name_corpus: bool,
  pub name_corpus_languages: Option<Vec<String>>,
  pub enable_deny_list: bool,
  pub deny_list_countries: Option<Vec<String>>,
  pub deny_list_regions: Option<Vec<String>>,
  pub deny_list_exclude_categories: Option<Vec<String>>,
  pub custom_deny_list: Option<Vec<CustomDenyListEntry>>,
  pub custom_regexes: Option<Vec<CustomRegexPattern>>,
  pub enable_gazetteer: bool,
  pub enable_countries: Option<bool>,
  pub enable_confidence_boost: bool,
  pub enable_coreference: bool,
  pub enable_zone_classification: Option<bool>,
  pub enable_hotword_rules: Option<bool>,
  /// Legacy callers omit this field; absence means [`
  /// StandaloneStreetDetection::Off`].
  #[serde(default)]
  pub standalone_street_detection: StandaloneStreetDetection,
  pub labels: Vec<String>,
  pub workspace_id: String,
  pub dictionaries: Option<Dictionaries>,
}

#[cfg(test)]
mod tests {
  use super::PipelineConfig;

  #[test]
  fn omitted_enable_legal_forms_deserializes_as_none()
  -> Result<(), serde_json::Error> {
    // `enableNer` stays in this fixture on purpose: configs serialized before
    // the field was retired must keep deserializing (serde ignores unknown
    // fields here).
    let json = r#"{
      "threshold": 0.5,
      "enableTriggerPhrases": false,
      "enableRegex": false,
      "enableNameCorpus": false,
      "enableDenyList": false,
      "enableGazetteer": false,
      "enableCountries": false,
      "enableNer": false,
      "enableConfidenceBoost": false,
      "enableCoreference": false,
      "enableZoneClassification": false,
      "labels": ["person"],
      "workspaceId": "test"
    }"#;
    let config: PipelineConfig = serde_json::from_str(json)?;
    assert_eq!(
      config.enable_legal_forms, None,
      "omitted enableLegalForms must be None (treated as enabled)"
    );
    Ok(())
  }
}
