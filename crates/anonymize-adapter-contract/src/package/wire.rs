//! Payload wire codec: the binary structs serialized into prepared
//! search packages and the postcard encode/decode paths for binding
//! and core payloads.

use std::borrow::Cow;

use serde::{Deserialize, Serialize};
use stella_anonymize_core::{
  PreparedEngineArtifacts, PreparedEngineConfig, SearchPattern,
};

use crate::error::Result;
use crate::error::invalid_prepared_search_package;
use crate::types::{
  BindingAddressContextData, BindingAddressSeedData, BindingCoreferenceData,
  BindingCountryMatchData, BindingDateData, BindingDenyListFilterData,
  BindingDenyListMatchData, BindingGazetteerMatchData, BindingHotwordRuleData,
  BindingLegalFormData, BindingMonetaryData, BindingNameCorpusData,
  BindingNameCorpusMode, BindingPreparedSearchConfig,
  BindingPreparedSearchSlices, BindingRegexMatchMeta, BindingSearchOptions,
  BindingSearchPattern, BindingSignatureData, BindingTriggerData,
  BindingTriggerRule, BindingTriggerStrategy, BindingTriggerValidation,
  BindingZoneData,
};

use super::timing::{PreparedSearchPackageDecodeTimings, elapsed_us};
use super::{
  BindingPreparedSearchPackage, CorePreparedSearchPackageArtifacts,
  CorePreparedSearchPackageView,
};

#[derive(Deserialize)]
struct BinaryPreparedSearchPackageOwned {
  config: BinaryPreparedSearchConfig,
  artifacts: Vec<u8>,
}

#[derive(Serialize)]
struct BinaryPreparedSearchPackageRef<'a> {
  config: BinaryPreparedSearchConfig,
  artifacts: &'a [u8],
}
#[derive(Deserialize, Serialize)]
struct BinaryPreparedSearchConfig {
  regex_patterns: Vec<BindingSearchPattern>,
  custom_regex_patterns: Vec<BindingSearchPattern>,
  literal_patterns: Vec<BindingSearchPattern>,
  regex_options: Option<BindingSearchOptions>,
  custom_regex_options: Option<BindingSearchOptions>,
  literal_options: Option<BindingSearchOptions>,
  literal_patterns_from_deny_list_data: bool,
  allowed_labels: Vec<String>,
  threshold: f64,
  confidence_boost: bool,
  slices: BindingPreparedSearchSlices,
  regex_meta: Vec<BindingRegexMatchMeta>,
  custom_regex_meta: Vec<BindingRegexMatchMeta>,
  deny_list_data: Option<BindingDenyListMatchData>,
  false_positive_filters: Option<BindingDenyListFilterData>,
  gazetteer_data: Option<BindingGazetteerMatchData>,
  country_data: Option<BindingCountryMatchData>,
  hotword_data: Option<BindingHotwordRuleData>,
  trigger_data: Option<BinaryTriggerData>,
  legal_form_data: Option<BindingLegalFormData>,
  address_seed_data: Option<BindingAddressSeedData>,
  zone_data: Option<BindingZoneData>,
  address_context_data: Option<BindingAddressContextData>,
  coreference_data: Option<BindingCoreferenceData>,
  name_corpus_data: Option<BindingNameCorpusData>,
  signature_data: Option<BindingSignatureData>,
  name_corpus_mode: BindingNameCorpusMode,
  date_data: Option<BindingDateData>,
  monetary_data: Option<BindingMonetaryData>,
}

#[derive(Deserialize, Serialize)]
struct BinaryTriggerData {
  rules: Vec<BinaryTriggerRule>,
  address_stop_keywords: Vec<String>,
  party_position_terms: Vec<String>,
  #[serde(default)]
  post_nominals: Vec<String>,
  sentence_terminal_currency_terms: Vec<String>,
  #[serde(default)]
  phone_extension_labels: Vec<String>,
  #[serde(default)]
  number_markers: Vec<String>,
  #[serde(default)]
  number_labels: Vec<String>,
  #[serde(default)]
  person_field_labels: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct BinaryTriggerRule {
  trigger: String,
  label: String,
  strategy: BinaryTriggerStrategy,
  validations: Vec<BinaryTriggerValidation>,
  include_trigger: bool,
}

#[derive(Deserialize, Serialize)]
enum BinaryTriggerStrategy {
  ToNextComma {
    stop_words: Vec<String>,
    max_length: Option<u32>,
  },
  ToEndOfLine,
  NWords {
    count: u32,
  },
  CompanyIdValue,
  Address {
    max_chars: Option<u32>,
  },
  MatchPattern {
    pattern: String,
    flags: Option<String>,
  },
}

#[derive(Deserialize, Serialize)]
enum BinaryTriggerValidation {
  StartsUppercase,
  MinLength {
    min: u32,
  },
  MaxLength {
    max: u32,
  },
  NoDigits,
  HasDigits,
  MatchesPattern {
    pattern: String,
    flags: Option<String>,
  },
  ValidId {
    validator: String,
  },
}
impl From<BindingPreparedSearchConfig> for BinaryPreparedSearchConfig {
  fn from(config: BindingPreparedSearchConfig) -> Self {
    Self {
      regex_patterns: config.regex_patterns,
      custom_regex_patterns: config.custom_regex_patterns,
      literal_patterns: config.literal_patterns,
      regex_options: config.regex_options,
      custom_regex_options: config.custom_regex_options,
      literal_options: config.literal_options,
      literal_patterns_from_deny_list_data: config
        .literal_patterns_from_deny_list_data,
      allowed_labels: config.allowed_labels,
      threshold: config.threshold,
      confidence_boost: config.confidence_boost,
      slices: config.slices,
      regex_meta: config.regex_meta,
      custom_regex_meta: config.custom_regex_meta,
      deny_list_data: config.deny_list_data,
      false_positive_filters: config.false_positive_filters,
      gazetteer_data: config.gazetteer_data,
      country_data: config.country_data,
      hotword_data: config.hotword_data,
      trigger_data: config.trigger_data.map(BinaryTriggerData::from),
      legal_form_data: config.legal_form_data,
      address_seed_data: config.address_seed_data,
      zone_data: config.zone_data,
      address_context_data: config.address_context_data,
      coreference_data: config.coreference_data,
      name_corpus_data: config.name_corpus_data,
      signature_data: config.signature_data,
      name_corpus_mode: config.name_corpus_mode,
      date_data: config.date_data,
      monetary_data: config.monetary_data,
    }
  }
}

impl From<BinaryPreparedSearchConfig> for BindingPreparedSearchConfig {
  fn from(config: BinaryPreparedSearchConfig) -> Self {
    Self {
      regex_patterns: config.regex_patterns,
      custom_regex_patterns: config.custom_regex_patterns,
      literal_patterns: config.literal_patterns,
      regex_options: config.regex_options,
      custom_regex_options: config.custom_regex_options,
      literal_options: config.literal_options,
      literal_patterns_from_deny_list_data: config
        .literal_patterns_from_deny_list_data,
      allowed_labels: config.allowed_labels,
      threshold: config.threshold,
      confidence_boost: config.confidence_boost,
      slices: config.slices,
      regex_meta: config.regex_meta,
      custom_regex_meta: config.custom_regex_meta,
      deny_list_data: config.deny_list_data,
      false_positive_filters: config.false_positive_filters,
      gazetteer_data: config.gazetteer_data,
      country_data: config.country_data,
      hotword_data: config.hotword_data,
      trigger_data: config.trigger_data.map(BindingTriggerData::from),
      legal_form_data: config.legal_form_data,
      address_seed_data: config.address_seed_data,
      zone_data: config.zone_data,
      address_context_data: config.address_context_data,
      coreference_data: config.coreference_data,
      name_corpus_data: config.name_corpus_data,
      signature_data: config.signature_data,
      name_corpus_mode: config.name_corpus_mode,
      date_data: config.date_data,
      monetary_data: config.monetary_data,
    }
  }
}

impl From<BindingTriggerData> for BinaryTriggerData {
  fn from(data: BindingTriggerData) -> Self {
    Self {
      rules: data
        .rules
        .into_iter()
        .map(BinaryTriggerRule::from)
        .collect(),
      address_stop_keywords: data.address_stop_keywords,
      party_position_terms: data.party_position_terms,
      post_nominals: data.post_nominals,
      sentence_terminal_currency_terms: data.sentence_terminal_currency_terms,
      phone_extension_labels: data.phone_extension_labels,
      number_markers: data.number_markers,
      number_labels: data.number_labels,
      person_field_labels: data.person_field_labels,
    }
  }
}

impl From<BinaryTriggerData> for BindingTriggerData {
  fn from(data: BinaryTriggerData) -> Self {
    Self {
      rules: data
        .rules
        .into_iter()
        .map(BindingTriggerRule::from)
        .collect(),
      address_stop_keywords: data.address_stop_keywords,
      party_position_terms: data.party_position_terms,
      post_nominals: data.post_nominals,
      sentence_terminal_currency_terms: data.sentence_terminal_currency_terms,
      phone_extension_labels: data.phone_extension_labels,
      number_markers: data.number_markers,
      number_labels: data.number_labels,
      person_field_labels: data.person_field_labels,
    }
  }
}

impl From<BindingTriggerRule> for BinaryTriggerRule {
  fn from(rule: BindingTriggerRule) -> Self {
    Self {
      trigger: rule.trigger,
      label: rule.label,
      strategy: BinaryTriggerStrategy::from(rule.strategy),
      validations: rule
        .validations
        .into_iter()
        .map(BinaryTriggerValidation::from)
        .collect(),
      include_trigger: rule.include_trigger,
    }
  }
}

impl From<BinaryTriggerRule> for BindingTriggerRule {
  fn from(rule: BinaryTriggerRule) -> Self {
    Self {
      trigger: rule.trigger,
      label: rule.label,
      strategy: BindingTriggerStrategy::from(rule.strategy),
      validations: rule
        .validations
        .into_iter()
        .map(BindingTriggerValidation::from)
        .collect(),
      include_trigger: rule.include_trigger,
    }
  }
}

impl From<BindingTriggerStrategy> for BinaryTriggerStrategy {
  fn from(strategy: BindingTriggerStrategy) -> Self {
    match strategy {
      BindingTriggerStrategy::ToNextComma {
        stop_words,
        max_length,
      } => Self::ToNextComma {
        stop_words,
        max_length,
      },
      BindingTriggerStrategy::ToEndOfLine {} => Self::ToEndOfLine,
      BindingTriggerStrategy::NWords { count } => Self::NWords { count },
      BindingTriggerStrategy::CompanyIdValue {} => Self::CompanyIdValue,
      BindingTriggerStrategy::Address { max_chars } => {
        Self::Address { max_chars }
      }
      BindingTriggerStrategy::MatchPattern { pattern, flags } => {
        Self::MatchPattern { pattern, flags }
      }
    }
  }
}

impl From<BinaryTriggerStrategy> for BindingTriggerStrategy {
  fn from(strategy: BinaryTriggerStrategy) -> Self {
    match strategy {
      BinaryTriggerStrategy::ToNextComma {
        stop_words,
        max_length,
      } => Self::ToNextComma {
        stop_words,
        max_length,
      },
      BinaryTriggerStrategy::ToEndOfLine => Self::ToEndOfLine {},
      BinaryTriggerStrategy::NWords { count } => Self::NWords { count },
      BinaryTriggerStrategy::CompanyIdValue => Self::CompanyIdValue {},
      BinaryTriggerStrategy::Address { max_chars } => {
        Self::Address { max_chars }
      }
      BinaryTriggerStrategy::MatchPattern { pattern, flags } => {
        Self::MatchPattern { pattern, flags }
      }
    }
  }
}

impl From<BindingTriggerValidation> for BinaryTriggerValidation {
  fn from(validation: BindingTriggerValidation) -> Self {
    match validation {
      BindingTriggerValidation::StartsUppercase {} => Self::StartsUppercase,
      BindingTriggerValidation::MinLength { min } => Self::MinLength { min },
      BindingTriggerValidation::MaxLength { max } => Self::MaxLength { max },
      BindingTriggerValidation::NoDigits {} => Self::NoDigits,
      BindingTriggerValidation::HasDigits {} => Self::HasDigits,
      BindingTriggerValidation::MatchesPattern { pattern, flags } => {
        Self::MatchesPattern { pattern, flags }
      }
      BindingTriggerValidation::ValidId { validator } => {
        Self::ValidId { validator }
      }
    }
  }
}

impl From<BinaryTriggerValidation> for BindingTriggerValidation {
  fn from(validation: BinaryTriggerValidation) -> Self {
    match validation {
      BinaryTriggerValidation::StartsUppercase => Self::StartsUppercase {},
      BinaryTriggerValidation::MinLength { min } => Self::MinLength { min },
      BinaryTriggerValidation::MaxLength { max } => Self::MaxLength { max },
      BinaryTriggerValidation::NoDigits => Self::NoDigits {},
      BinaryTriggerValidation::HasDigits => Self::HasDigits {},
      BinaryTriggerValidation::MatchesPattern { pattern, flags } => {
        Self::MatchesPattern { pattern, flags }
      }
      BinaryTriggerValidation::ValidId { validator } => {
        Self::ValidId { validator }
      }
    }
  }
}

pub(crate) fn prepared_search_package_payload_to_bytes(
  config: &BindingPreparedSearchConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  postcard::to_allocvec(&BinaryPreparedSearchPackageRef {
    config: BinaryPreparedSearchConfig::from(config.clone()),
    artifacts,
  })
  .map_err(|error| invalid_prepared_search_package(error.to_string()))
}

pub(crate) fn decode_binding_package(
  payload: &[u8],
) -> Result<BindingPreparedSearchPackage> {
  let (package, rest) =
    postcard::take_from_bytes::<BinaryPreparedSearchPackageOwned>(payload)
      .map_err(|error| invalid_prepared_search_package(error.to_string()))?;
  if !rest.is_empty() {
    return Err(invalid_prepared_search_package("trailing payload data"));
  }
  Ok(BindingPreparedSearchPackage {
    config: BindingPreparedSearchConfig::from(package.config),
    artifacts: package.artifacts,
  })
}

pub(crate) fn prepared_search_core_package_payload_to_bytes(
  config: &PreparedEngineConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let mut config = config.clone();
  compact_core_package_config(&mut config);
  let config_bytes = postcard::to_allocvec(&config)
    .map_err(|error| invalid_prepared_search_package(error.to_string()))?;
  let config_len = u64::try_from(config_bytes.len()).map_err(|_| {
    invalid_prepared_search_package("core config length overflow")
  })?;
  let mut bytes = Vec::with_capacity(
    std::mem::size_of::<u64>()
      .saturating_add(config_bytes.len())
      .saturating_add(artifacts.len()),
  );
  bytes.extend_from_slice(&config_len.to_le_bytes());
  bytes.extend_from_slice(&config_bytes);
  bytes.extend_from_slice(artifacts);
  Ok(bytes)
}

pub(crate) fn compact_core_package_config(config: &mut PreparedEngineConfig) {
  if core_literal_patterns_are_identity_mapped(config) {
    config.search.literal_patterns.clear();
  }
  if let Some(data) = &mut config.detectors.deny_list_data {
    data.compact_runtime_patterns();
  }
}

pub(crate) fn core_package_view_from_payload<'a>(
  payload: Cow<'a, [u8]>,
  timings: &mut PreparedSearchPackageDecodeTimings,
) -> Result<CorePreparedSearchPackageView<'a>> {
  let (config, config_decode, artifacts_start) = {
    let payload_slices = core_package_payload_slices(payload.as_ref())?;
    timings.config_bytes = Some(payload_slices.config.len());
    let (config, config_decode) =
      decode_core_package_config(payload_slices.config)?;
    (config, config_decode, payload_slices.artifacts_start)
  };
  timings.config_decode = Some(config_decode);

  let artifacts = match payload {
    Cow::Borrowed(bytes) => CorePreparedSearchPackageArtifacts::borrowed(
      bytes
        .get(artifacts_start..)
        .ok_or_else(|| invalid_prepared_search_package("missing artifacts"))?,
    ),
    Cow::Owned(bytes) => {
      CorePreparedSearchPackageArtifacts::owned_payload(bytes, artifacts_start)?
    }
  };

  Ok(CorePreparedSearchPackageView { config, artifacts })
}

pub(crate) struct CorePackagePayloadSlices<'a> {
  pub(crate) config: &'a [u8],
  pub(crate) artifacts: &'a [u8],
  pub(crate) artifacts_start: usize,
}

pub(crate) fn core_package_payload_slices(
  payload: &[u8],
) -> Result<CorePackagePayloadSlices<'_>> {
  let len_end = std::mem::size_of::<u64>();
  let len_bytes = payload.get(..len_end).ok_or_else(|| {
    invalid_prepared_search_package("truncated config length")
  })?;
  let len_array = <[u8; 8]>::try_from(len_bytes)
    .map_err(|_| invalid_prepared_search_package("malformed config length"))?;
  let config_len = usize::try_from(u64::from_le_bytes(len_array))
    .map_err(|_| invalid_prepared_search_package("config length overflow"))?;
  let config_end = len_end
    .checked_add(config_len)
    .ok_or_else(|| invalid_prepared_search_package("config length overflow"))?;
  let config = payload
    .get(len_end..config_end)
    .ok_or_else(|| invalid_prepared_search_package("truncated config"))?;
  let artifacts = payload
    .get(config_end..)
    .ok_or_else(|| invalid_prepared_search_package("missing artifacts"))?;
  Ok(CorePackagePayloadSlices {
    config,
    artifacts,
    artifacts_start: config_end,
  })
}

pub(crate) fn decode_core_package_parts(
  config_bytes: &[u8],
  artifacts_bytes: &[u8],
) -> Result<(PreparedEngineConfig, u64, PreparedEngineArtifacts, u64)> {
  stella_anonymize_core::exec::scope(|scope| {
    let config_handle =
      scope.spawn(|| decode_core_package_config(config_bytes));
    let artifacts_handle =
      scope.spawn(|| decode_core_package_artifacts(artifacts_bytes));
    let (config, config_decode) = join_core_package_decode(config_handle)?;
    let (artifacts, artifacts_decode) =
      join_core_package_decode(artifacts_handle)?;
    Ok((config, config_decode, artifacts, artifacts_decode))
  })
}

fn decode_core_package_config(
  config_bytes: &[u8],
) -> Result<(PreparedEngineConfig, u64)> {
  let config_decode_start = web_time::Instant::now();
  let (config, rest) =
    postcard::take_from_bytes::<PreparedEngineConfig>(config_bytes)
      .map_err(|error| invalid_prepared_search_package(error.to_string()))?;
  let elapsed = elapsed_us(config_decode_start);
  if !rest.is_empty() {
    return Err(invalid_prepared_search_package("trailing config data"));
  }
  Ok((config, elapsed))
}

fn decode_core_package_artifacts(
  artifacts_bytes: &[u8],
) -> Result<(PreparedEngineArtifacts, u64)> {
  let artifacts_decode_start = web_time::Instant::now();
  let artifacts = PreparedEngineArtifacts::from_bytes(artifacts_bytes)
    .map_err(|error| invalid_prepared_search_package(error.to_string()))?;
  Ok((artifacts, elapsed_us(artifacts_decode_start)))
}

fn join_core_package_decode<T>(
  handle: stella_anonymize_core::exec::JoinHandle<'_, Result<T>>,
) -> Result<T> {
  handle.join().map_err(|_| {
    invalid_prepared_search_package("core package decode panicked")
  })?
}

fn core_literal_patterns_are_identity_mapped(
  config: &PreparedEngineConfig,
) -> bool {
  !config.search.literal_patterns.is_empty()
    && config
      .search
      .literal_patterns
      .iter()
      .all(|pattern| matches!(pattern, SearchPattern::Literal(_)))
}
