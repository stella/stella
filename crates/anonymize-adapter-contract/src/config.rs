//! Conversion from binding DTOs into the core prepared-engine
//! configuration, including operator and search-pattern parsing.

use std::collections::{BTreeMap, BTreeSet};

use stella_anonymize_core::{
  AddressContextData, AddressSeedData, AmountWordsData, CoreferenceData,
  CoreferencePatternData, CountryMatchData, CountryVariant, CurrencyData,
  DateData, DenyListFilterData, DenyListMatchData, DenyListPatternMetaSet,
  FuzzySearchOptions, GazetteerMatchData, HotwordRule, HotwordRuleData,
  LegalFormData, LiteralSearchOptions, LowercaseBridge, MagnitudeSuffixData,
  MaskConfig, MaskDirection, MonetaryData, NameCorpusData, NameCorpusMode,
  NumberWordData, Operator, OperatorConfig,
  PERSON_OR_ORGANIZATION_TRIGGER_LABEL, PatternSlice, PreparedArtifactPolicy,
  PreparedEngineConfig, PreparedEngineDetectorConfig,
  PreparedEnginePolicyConfig, PreparedEngineSearchConfig, PreparedEngineSlices,
  RegexArtifactPolicy, RegexMatchMeta, RegexSearchOptions, SearchOptions,
  SearchPattern, ShareQuantityTermData, SignatureData, SigningPlaceGuardData,
  SourceDetail, StandaloneStreetData, StringGroups, TriggerData, TriggerRule,
  TriggerStrategy, TriggerValidation, WrittenAmountPatternData, ZoneData,
  ZonePatternData, ZoneSigningClauseData,
};

use crate::error::{ContractError, Result};
use crate::types::{
  BindingAddressSeedData, BindingCoreferenceData, BindingCountryMatchData,
  BindingCountryVariant, BindingDenyListFilterData, BindingDenyListMatchData,
  BindingHotwordRuleData, BindingLegalFormData, BindingLowercaseBridgePolicy,
  BindingMonetaryData, BindingNameCorpusData, BindingNameCorpusMode,
  BindingOperator, BindingOperatorConfig, BindingPatternSlice,
  BindingPreparedArtifactPolicy, BindingPreparedSearchConfig,
  BindingPreparedSearchSlices, BindingRegexArtifactPolicy,
  BindingRegexMatchMeta, BindingSearchOptions, BindingSearchPattern,
  BindingSignatureData, BindingTaggedOperator, BindingTriggerData,
  BindingTriggerRule, BindingTriggerStrategy, BindingTriggerValidation,
  BindingZoneData,
};

pub fn prepared_search_config_from_binding(
  mut config: BindingPreparedSearchConfig,
) -> Result<PreparedEngineConfig> {
  let trigger_vocabulary = trigger_vocabulary(&config);
  let (regex_patterns, slices, institutional_aliases) =
    prepared_regex_from_binding(&mut config)?;
  let deny_list_data = config.deny_list_data;
  let literal_patterns = literal_patterns_from_binding(
    config.literal_patterns,
    config.literal_patterns_from_deny_list_data,
    deny_list_data.as_ref(),
  )?;
  let legal_form_suffixes =
    config
      .legal_form_data
      .as_ref()
      .map_or_else(Vec::new, |data| {
        let detection_only = data
          .detection_only_suffixes
          .iter()
          .map(String::as_str)
          .collect::<BTreeSet<_>>();
        data
          .suffixes
          .iter()
          .filter(|suffix| !detection_only.contains(suffix.as_str()))
          .cloned()
          .collect()
      });
  let mut legal_form_data =
    config.legal_form_data.map(legal_form_data_from_binding);
  if let Some(data) = legal_form_data.as_mut() {
    data.suffixes.extend(institutional_aliases);
  }
  Ok(PreparedEngineConfig {
    search: PreparedEngineSearchConfig {
      regex_patterns,
      custom_regex_patterns: search_patterns_from_binding(
        config.custom_regex_patterns,
      )?,
      literal_patterns,
      regex_options: search_options_from_binding(config.regex_options),
      custom_regex_options: search_options_from_binding(
        config.custom_regex_options,
      ),
      literal_options: search_options_from_binding(config.literal_options),
      slices,
      regex_meta: regex_meta_from_binding(config.regex_meta)?,
      custom_regex_meta: regex_meta_from_binding(config.custom_regex_meta)?,
    },
    policy: PreparedEnginePolicyConfig {
      allowed_labels: config.allowed_labels,
      threshold: config.threshold,
      confidence_boost: config.confidence_boost,
    },
    detectors: PreparedEngineDetectorConfig {
      deny_list_data: deny_list_data
        .map(deny_list_data_from_binding)
        .transpose()?,
      false_positive_filters: config
        .false_positive_filters
        .map(deny_list_filters_from_binding),
      gazetteer_data: config.gazetteer_data.map(|data| GazetteerMatchData {
        labels: data.labels,
        is_fuzzy: data.is_fuzzy,
      }),
      country_data: config.country_data.map(country_data_from_binding),
      hotword_data: config.hotword_data.map(hotword_data_from_binding),
      trigger_data: config.trigger_data.map(|data| {
        trigger_data_from_binding(TriggerDataFromBindingOptions {
          data,
          legal_form_suffixes,
          vocabulary: trigger_vocabulary,
        })
      }),
      legal_form_data,
      address_seed_data: config
        .address_seed_data
        .map(address_seed_data_from_binding),
      zone_data: config.zone_data.map(zone_data_from_binding),
      address_context_data: config.address_context_data.map(|data| {
        AddressContextData {
          address_prepositions: data.address_prepositions,
          temporal_prepositions: data.temporal_prepositions,
          street_abbreviations: data.street_abbreviations,
          bare_house_stopwords: data.bare_house_stopwords,
        }
      }),
      coreference_data: config
        .coreference_data
        .map(coreference_data_from_binding),
      name_corpus_data: config.name_corpus_data.map(|data| {
        name_corpus_data_from_binding(data, config.name_corpus_mode)
      }),
      signature_data: config.signature_data.map(signature_data_from_binding),
      date_data: config.date_data.map(date_data_from_binding),
      monetary_data: config.monetary_data.map(monetary_data_from_binding),
    },
  })
}

fn address_seed_data_from_binding(
  data: BindingAddressSeedData,
) -> AddressSeedData {
  AddressSeedData {
    boundary_words: data.boundary_words,
    br_cep_cue_words: data.br_cep_cue_words,
    unit_abbreviations: data.unit_abbreviations,
    directional_abbreviations: data.directional_abbreviations,
    standalone_street: data.standalone_street.map(|data| {
      StandaloneStreetData {
        street_type_words: data.street_type_words,
      }
    }),
  }
}

fn country_data_from_binding(
  data: BindingCountryMatchData,
) -> CountryMatchData {
  CountryMatchData {
    labels: data.labels,
    iso_codes: data.iso_codes,
    variants: data
      .variants
      .into_iter()
      .map(|variant| match variant {
        BindingCountryVariant::Name => CountryVariant::Name,
        BindingCountryVariant::Alias => CountryVariant::Alias,
        BindingCountryVariant::Alpha3 => CountryVariant::Alpha3,
        BindingCountryVariant::Alpha2 => CountryVariant::Alpha2,
      })
      .collect(),
  }
}

fn date_data_from_binding(data: crate::BindingDateData) -> DateData {
  DateData {
    month_names_by_language: data.month_names_by_language,
    lowercase_month_ambiguities: data.lowercase_month_ambiguities,
    year_words_by_language: data.year_words_by_language,
  }
}

fn legal_form_data_from_binding(data: BindingLegalFormData) -> LegalFormData {
  LegalFormData {
    suffixes: data.suffixes,
    non_ascii_name_short_suffixes: data.non_ascii_name_short_suffixes,
    normalized_boundary_suffixes: data.normalized_boundary_suffixes,
    normalized_in_name_words: data.normalized_in_name_words,
    normalized_suffix_words: data.normalized_suffix_words,
    role_heads: data.role_heads,
    sentence_verb_indicators: data.sentence_verb_indicators,
    clause_noun_heads: data.clause_noun_heads,
    connector_prose_heads: data.connector_prose_heads,
    structural_single_cap_prefixes: data.structural_single_cap_prefixes,
    leading_clause_phrases: data.leading_clause_phrases,
    leading_clause_direct_prefixes: data.leading_clause_direct_prefixes,
    connector_words: data.connector_words,
    and_connector_words: data.and_connector_words,
    in_name_prepositions: data.in_name_prepositions,
    company_suffix_words: data.company_suffix_words,
    comma_gated_direct_prefixes: data.comma_gated_direct_prefixes,
    institutional_heads: data.institutional_heads,
    institutional_complement_heads: data.institutional_complement_heads,
    institutional_complement_starters: data.institutional_complement_starters,
    institutional_complement_connectors: data
      .institutional_complement_connectors,
    institutional_generic_words: data.institutional_generic_words,
    institutional_prefix_generic_words: data.institutional_prefix_generic_words,
    lowercase_bridge: match data.lowercase_bridge.policy {
      BindingLowercaseBridgePolicy::Open => LowercaseBridge::Open,
      BindingLowercaseBridgePolicy::Closed => LowercaseBridge::Closed {
        words: data.lowercase_bridge.words,
      },
    },
  }
}

struct TriggerVocabulary {
  party_roles: BTreeSet<String>,
}

fn trigger_vocabulary(
  config: &BindingPreparedSearchConfig,
) -> TriggerVocabulary {
  let Some(filters) = config.false_positive_filters.as_ref() else {
    return TriggerVocabulary {
      party_roles: BTreeSet::new(),
    };
  };
  TriggerVocabulary {
    party_roles: lower_set(filters.generic_roles.clone()),
  }
}

fn deny_list_data_from_binding(
  data: BindingDenyListMatchData,
) -> Result<DenyListMatchData> {
  let pattern_count = data.originals.len();
  Ok(DenyListMatchData {
    labels: string_groups_from_binding(
      data.labels,
      data.label_indices,
      data.label_table.clone(),
      pattern_count,
      "deny_list.label_indices",
    )?,
    custom_labels: string_groups_from_binding(
      data.custom_labels,
      data.custom_label_indices,
      data.label_table,
      pattern_count,
      "deny_list.custom_label_indices",
    )?,
    originals: data.originals,
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: string_groups_from_binding(
      data.sources,
      data.source_indices,
      data.source_table,
      pattern_count,
      "deny_list.source_indices",
    )?,
    filters: data.filters.map(deny_list_filters_from_binding),
  })
}

fn string_groups_from_binding(
  groups: Vec<Vec<String>>,
  indices: Vec<Vec<u32>>,
  table: Vec<String>,
  pattern_count: usize,
  field: &'static str,
) -> Result<StringGroups> {
  if !indices.is_empty() {
    validate_compact_string_indices(&indices, &table, field)?;
    return StringGroups::from_table_indices(table, indices, field).map_err(
      |error| ContractError::InvalidCompactStringGroups {
        field,
        reason: error.to_string(),
      },
    );
  }

  if !groups.is_empty() {
    return Ok(StringGroups::from_groups(groups));
  }

  Ok(StringGroups::empty_groups(pattern_count))
}

fn validate_compact_string_indices(
  groups: &[Vec<u32>],
  table: &[String],
  field: &'static str,
) -> Result<()> {
  for group in groups {
    for &index in group {
      let Ok(index_usize) = usize::try_from(index) else {
        return Err(ContractError::CompactStringIndexOutOfRange {
          field,
          index,
        });
      };
      if index_usize >= table.len() {
        return Err(ContractError::CompactStringIndexOutOfRange {
          field,
          index,
        });
      }
    }
  }

  Ok(())
}

fn monetary_data_from_binding(data: BindingMonetaryData) -> MonetaryData {
  MonetaryData {
    currencies: CurrencyData {
      codes: data.currencies.codes,
      symbols: data.currencies.symbols,
      local_names: data.currencies.local_names,
    },
    amount_words: AmountWordsData {
      written_amount_patterns: data
        .amount_words
        .written_amount_patterns
        .into_iter()
        .map(|entry| WrittenAmountPatternData {
          keywords: entry.keywords,
        })
        .collect(),
      number_words: data
        .amount_words
        .number_words
        .into_iter()
        .map(|entry| NumberWordData {
          words: entry.words,
          joiners: entry.joiners,
        })
        .collect(),
      magnitude_suffixes: data
        .amount_words
        .magnitude_suffixes
        .into_iter()
        .map(|entry| MagnitudeSuffixData {
          words: entry.words,
          abbreviations_case_insensitive: entry.abbreviations_case_insensitive,
          abbreviations_case_sensitive: entry.abbreviations_case_sensitive,
          abbreviations_attached: entry.abbreviations_attached,
        })
        .collect(),
      share_quantity_terms: data
        .amount_words
        .share_quantity_terms
        .into_iter()
        .map(|entry| ShareQuantityTermData {
          modifiers: entry.modifiers,
          nouns: entry.nouns,
        })
        .collect(),
    },
  }
}

fn hotword_data_from_binding(data: BindingHotwordRuleData) -> HotwordRuleData {
  HotwordRuleData {
    rules: data
      .rules
      .into_iter()
      .map(|rule| HotwordRule {
        hotwords: rule.hotwords,
        target_labels: rule.target_labels,
        score_adjustment: rule.score_adjustment,
        reclassify_to: rule.reclassify_to,
        proximity_before: rule.proximity_before,
        proximity_after: rule.proximity_after,
      })
      .collect(),
    pattern_rule_indices: data.pattern_rule_indices,
  }
}

fn coreference_data_from_binding(
  data: BindingCoreferenceData,
) -> CoreferenceData {
  CoreferenceData {
    definition_patterns: data
      .definition_patterns
      .into_iter()
      .map(|pattern| CoreferencePatternData {
        pattern: pattern.pattern,
        flags: pattern.flags,
      })
      .collect(),
    role_stop_terms: data.role_stop_terms,
    legal_form_aliases: data.legal_form_aliases,
    organization_suffixes: data.organization_suffixes,
    organization_determiners: data.organization_determiners,
  }
}

fn name_corpus_data_from_binding(
  data: BindingNameCorpusData,
  mode: BindingNameCorpusMode,
) -> NameCorpusData {
  NameCorpusData {
    mode: name_corpus_mode_from_binding(mode),
    first_names: data.first_names,
    surnames: data.surnames,
    title_tokens: data.title_tokens,
    title_abbreviations: data.title_abbreviations,
    excluded_words: data.excluded_words,
    common_words: data.common_words,
    non_western_names: data.non_western_names,
    excluded_all_caps: data.excluded_all_caps,
    ja_suffixes: data.ja_suffixes,
    arabic_connectors: data.arabic_connectors,
    relation_connectors: data.relation_connectors,
    hyphenated_prefixes: data.hyphenated_prefixes,
    cjk_non_person_terms: data.cjk_non_person_terms,
    cjk_surname_starters: data.cjk_surname_starters,
    organization_terms: data.organization_terms,
  }
}

fn signature_data_from_binding(data: BindingSignatureData) -> SignatureData {
  SignatureData {
    labels: data.labels,
    person_value_labels: data.person_value_labels,
    person_list_labels: data.person_list_labels,
    party_role_name_evidence: data.party_role_name_evidence,
    witness_phrases: data.witness_phrases,
    name_particles: data.name_particles,
    post_nominal_suffixes: data.post_nominal_suffixes,
    organization_suffixes: data.organization_suffixes,
    form_field_labels: data.form_field_labels,
    contact_field_labels: data.contact_field_labels,
    signature_stamp_phrases: data.signature_stamp_phrases,
    image_stub_prefixes: data.image_stub_prefixes,
  }
}

const fn name_corpus_mode_from_binding(
  mode: BindingNameCorpusMode,
) -> NameCorpusMode {
  match mode {
    BindingNameCorpusMode::Full => NameCorpusMode::Full,
    BindingNameCorpusMode::Supplemental => NameCorpusMode::Supplemental,
  }
}

fn zone_data_from_binding(data: BindingZoneData) -> ZoneData {
  ZoneData {
    section_heading_patterns: data
      .section_heading_patterns
      .into_iter()
      .map(|pattern| ZonePatternData {
        pattern: pattern.pattern,
        flags: pattern.flags,
      })
      .collect(),
    signing_clauses: data
      .signing_clauses
      .into_iter()
      .map(|clause| ZoneSigningClauseData {
        prefix: clause.prefix,
        suffix: clause.suffix,
        prepositions: clause.prepositions,
      })
      .collect(),
  }
}

pub fn operator_config_from_binding(
  config: Option<BindingOperatorConfig>,
) -> Result<OperatorConfig> {
  let Some(config) = config else {
    return Ok(OperatorConfig::default());
  };

  let mut operators = BTreeMap::new();
  for (label, value) in config.operators.unwrap_or_default() {
    operators.insert(label.clone(), operator_from_binding(&label, value)?);
  }

  Ok(OperatorConfig {
    operators,
    redact_string: config
      .redact_string
      .unwrap_or_else(|| String::from("[REDACTED]")),
  })
}
fn deny_list_filters_from_binding(
  filters: BindingDenyListFilterData,
) -> DenyListFilterData {
  DenyListFilterData {
    stopwords: lower_set(filters.stopwords),
    allow_list: lower_set(filters.allow_list),
    person_stopwords: lower_set(filters.person_stopwords),
    person_trailing_nouns: lower_set(filters.person_trailing_nouns),
    address_trailing_nouns: lower_set(filters.address_trailing_nouns),
    address_stopwords: lower_set(filters.address_stopwords),
    address_jurisdiction_prefixes: lower_set(
      filters.address_jurisdiction_prefixes,
    ),
    street_types: lower_set(filters.street_types),
    address_component_terms: lower_set(filters.address_component_terms),
    ambiguous_street_type_terms: lower_set(filters.ambiguous_street_type_terms),
    first_names: lower_set(filters.first_names),
    generic_roles: lower_set(filters.generic_roles),
    page_footer_markers: lower_set(filters.page_footer_markers),
    number_abbrev_prefixes: lower_set(filters.number_abbrev_prefixes),
    sentence_starters: lower_set(filters.sentence_starters),
    trailing_address_word_exclusions: lower_set(
      filters.trailing_address_word_exclusions,
    ),
    document_heading_words: lower_set(filters.document_heading_words),
    document_heading_ordinal_markers: lower_set(
      filters.document_heading_ordinal_markers,
    ),
    defined_term_cues: lower_set(filters.defined_term_cues),
    signing_place_guards: filters
      .signing_place_guards
      .into_iter()
      .map(|guard| SigningPlaceGuardData {
        prefix_phrases: lower_set(guard.prefix_phrases),
        suffix_phrases: lower_set(guard.suffix_phrases),
      })
      .collect(),
    title_tokens: lower_set(filters.title_tokens),
    unit_designators: lower_set(filters.unit_designators),
    in_name_connectors: lower_set(filters.in_name_connectors),
    us_state_abbreviations: filters
      .us_state_abbreviations
      .into_iter()
      .collect(),
  }
}

struct TriggerDataFromBindingOptions {
  data: BindingTriggerData,
  legal_form_suffixes: Vec<String>,
  vocabulary: TriggerVocabulary,
}

fn trigger_data_from_binding(
  options: TriggerDataFromBindingOptions,
) -> TriggerData {
  let TriggerDataFromBindingOptions {
    data,
    legal_form_suffixes,
    vocabulary,
  } = options;
  TriggerData {
    rules: data
      .rules
      .into_iter()
      .map(|rule| trigger_rule_from_binding(rule, &vocabulary.party_roles))
      .collect(),
    address_stop_keywords: data.address_stop_keywords,
    party_position_terms: data.party_position_terms,
    legal_form_suffixes,
    post_nominals: data.post_nominals,
    sentence_terminal_currency_terms: data.sentence_terminal_currency_terms,
    phone_extension_labels: data.phone_extension_labels,
    number_markers: data.number_markers,
    number_labels: data.number_labels,
    person_field_labels: data.person_field_labels,
  }
}

fn trigger_rule_from_binding(
  rule: BindingTriggerRule,
  party_roles: &BTreeSet<String>,
) -> TriggerRule {
  let normalized_trigger = rule
    .trigger
    .trim()
    .trim_end_matches(':')
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();
  let label = if rule.label == "organization"
    && party_roles.contains(&normalized_trigger)
  {
    String::from(PERSON_OR_ORGANIZATION_TRIGGER_LABEL)
  } else {
    rule.label
  };
  TriggerRule {
    trigger: rule.trigger,
    label,
    strategy: trigger_strategy_from_binding(rule.strategy),
    validations: rule
      .validations
      .into_iter()
      .map(trigger_validation_from_binding)
      .collect(),
    include_trigger: rule.include_trigger,
  }
}

fn trigger_strategy_from_binding(
  strategy: BindingTriggerStrategy,
) -> TriggerStrategy {
  match strategy {
    BindingTriggerStrategy::ToNextComma {
      stop_words,
      max_length,
    } => TriggerStrategy::ToNextComma {
      stop_words,
      max_length,
    },
    BindingTriggerStrategy::ToEndOfLine {} => TriggerStrategy::ToEndOfLine,
    BindingTriggerStrategy::NWords { count } => {
      TriggerStrategy::NWords { count }
    }
    BindingTriggerStrategy::CompanyIdValue {} => {
      TriggerStrategy::CompanyIdValue
    }
    BindingTriggerStrategy::Address { max_chars } => {
      TriggerStrategy::Address { max_chars }
    }
    BindingTriggerStrategy::MatchPattern { pattern, flags } => {
      TriggerStrategy::MatchPattern { pattern, flags }
    }
  }
}

fn trigger_validation_from_binding(
  validation: BindingTriggerValidation,
) -> TriggerValidation {
  match validation {
    BindingTriggerValidation::StartsUppercase {} => {
      TriggerValidation::StartsUppercase
    }
    BindingTriggerValidation::MinLength { min } => {
      TriggerValidation::MinLength(min)
    }
    BindingTriggerValidation::MaxLength { max } => {
      TriggerValidation::MaxLength(max)
    }
    BindingTriggerValidation::NoDigits {} => TriggerValidation::NoDigits,
    BindingTriggerValidation::HasDigits {} => TriggerValidation::HasDigits,
    BindingTriggerValidation::MatchesPattern { pattern, flags } => {
      TriggerValidation::MatchesPattern { pattern, flags }
    }
    BindingTriggerValidation::ValidId { validator } => {
      TriggerValidation::ValidId { validator }
    }
  }
}

fn lower_set(values: Vec<String>) -> BTreeSet<String> {
  values
    .into_iter()
    .map(|value| value.to_lowercase())
    .collect()
}

fn search_patterns_from_binding(
  patterns: Vec<BindingSearchPattern>,
) -> Result<Vec<SearchPattern>> {
  patterns
    .into_iter()
    .map(search_pattern_from_binding)
    .collect()
}

fn prepared_regex_from_binding(
  config: &mut BindingPreparedSearchConfig,
) -> Result<(Vec<SearchPattern>, PreparedEngineSlices, Vec<String>)> {
  let mut patterns =
    search_patterns_from_binding(std::mem::take(&mut config.regex_patterns))?;
  let mut slices = slices_from_binding(&config.slices);
  let institutional_heads = config
    .legal_form_data
    .as_ref()
    .map_or(&[][..], |data| data.institutional_heads.as_slice());
  let aliases = insert_uppercase_institutional_patterns(
    &mut patterns,
    &mut slices,
    institutional_heads,
  );
  Ok((patterns, slices, aliases))
}

/// Adds all-caps aliases for contextual institutional heads without changing
/// the binding DTO or its frozen parity fixtures. The aliases remain inside
/// the legal-form slice and are inserted before trigger patterns.
fn insert_uppercase_institutional_patterns(
  patterns: &mut Vec<SearchPattern>,
  slices: &mut PreparedEngineSlices,
  institutional_heads: &[String],
) -> Vec<String> {
  let Ok(legal_start) = usize::try_from(slices.legal_forms.start) else {
    return Vec::new();
  };
  let Ok(legal_end) = usize::try_from(slices.legal_forms.end) else {
    return Vec::new();
  };
  if legal_start >= legal_end {
    return Vec::new();
  }
  let Some(legal_patterns) = patterns.get(legal_start..legal_end) else {
    return Vec::new();
  };

  let mut seen = legal_patterns
    .iter()
    .filter_map(|pattern| match pattern {
      SearchPattern::Literal(value)
      | SearchPattern::LiteralWithOptions { pattern: value, .. } => {
        Some(value.clone())
      }
      _ => None,
    })
    .collect::<BTreeSet<_>>();
  let mut aliases = Vec::new();
  for head in institutional_heads {
    let uppercase = head.to_uppercase();
    if uppercase != *head && seen.insert(uppercase.clone()) {
      aliases.push(uppercase);
    }
  }
  let Ok(added) = u32::try_from(aliases.len()) else {
    return Vec::new();
  };
  if added == 0 {
    return Vec::new();
  }

  let insertion_point = slices.legal_forms.end;
  let Some(prepared_legal_end) = insertion_point.checked_add(added) else {
    return Vec::new();
  };
  let shifted_triggers = if slices.triggers.start >= insertion_point {
    let Some(trigger_start) = slices.triggers.start.checked_add(added) else {
      return Vec::new();
    };
    let Some(trigger_end) = slices.triggers.end.checked_add(added) else {
      return Vec::new();
    };
    Some((trigger_start, trigger_end))
  } else {
    None
  };

  patterns.splice(
    legal_end..legal_end,
    aliases.iter().cloned().map(SearchPattern::Literal),
  );
  slices.legal_forms.end = prepared_legal_end;
  if let Some((trigger_start, trigger_end)) = shifted_triggers {
    slices.triggers.start = trigger_start;
    slices.triggers.end = trigger_end;
  }
  aliases
}

fn literal_patterns_from_binding(
  patterns: Vec<BindingSearchPattern>,
  from_deny_list_data: bool,
  deny_list_data: Option<&BindingDenyListMatchData>,
) -> Result<Vec<SearchPattern>> {
  let mut literal_patterns = search_patterns_from_binding(patterns)?;
  if !from_deny_list_data {
    return Ok(literal_patterns);
  }

  let Some(data) = deny_list_data else {
    return Err(ContractError::MissingDenyListDataForLiteralPatterns);
  };
  let mut from_data = Vec::with_capacity(
    data.originals.len().saturating_add(literal_patterns.len()),
  );
  from_data.extend(data.originals.iter().cloned().map(SearchPattern::Literal));
  from_data.append(&mut literal_patterns);
  Ok(from_data)
}

fn search_pattern_from_binding(
  pattern: BindingSearchPattern,
) -> Result<SearchPattern> {
  match pattern.kind.as_str() {
    "literal" => Ok(SearchPattern::Literal(pattern.pattern)),
    "literal-with-options" => Ok(SearchPattern::LiteralWithOptions {
      pattern: pattern.pattern,
      case_insensitive: pattern.case_insensitive,
      whole_words: pattern.whole_words,
    }),
    "regex" => {
      if pattern.lazy.is_some()
        || pattern.prefilter_any.is_some()
        || pattern.prefilter_case_insensitive.is_some()
        || pattern.prefilter_regex.is_some()
        || pattern.prefilter_window_bytes.is_some()
        || pattern.prepared_artifact_policy.is_some()
      {
        return Ok(SearchPattern::RegexWithOptions {
          pattern: pattern.pattern,
          lazy: pattern.lazy.unwrap_or(false),
          prefilter_any: pattern.prefilter_any.unwrap_or_default(),
          prefilter_case_insensitive: pattern.prefilter_case_insensitive,
          prefilter_regex: pattern.prefilter_regex,
          prefilter_window_bytes: pattern
            .prefilter_window_bytes
            .and_then(|value| usize::try_from(value).ok()),
          prepared_artifact_policy: pattern
            .prepared_artifact_policy
            .map(prepared_artifact_policy_from_binding),
        });
      }
      Ok(SearchPattern::Regex(pattern.pattern))
    }
    "fuzzy" => Ok(SearchPattern::Fuzzy {
      pattern: pattern.pattern,
      distance: pattern
        .distance
        .map(|distance| {
          u8::try_from(distance)
            .map_err(|_| ContractError::FuzzyDistanceOutOfRange { distance })
        })
        .transpose()?,
    }),
    _ => {
      Err(ContractError::UnsupportedSearchPatternKind { kind: pattern.kind })
    }
  }
}

const fn prepared_artifact_policy_from_binding(
  policy: BindingPreparedArtifactPolicy,
) -> PreparedArtifactPolicy {
  match policy {
    BindingPreparedArtifactPolicy::Include => PreparedArtifactPolicy::Include,
    BindingPreparedArtifactPolicy::Omit => PreparedArtifactPolicy::Omit,
  }
}

fn search_options_from_binding(
  options: Option<BindingSearchOptions>,
) -> SearchOptions {
  let Some(options) = options else {
    return SearchOptions::default();
  };

  SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: options.literal_case_insensitive.unwrap_or(false),
      whole_words: options.literal_whole_words.unwrap_or(false),
    },
    regex: RegexSearchOptions {
      whole_words: options.regex_whole_words.unwrap_or(false),
      overlap_all: options.regex_overlap_all.unwrap_or(false),
      artifact_policy: match options.regex_artifact_policy {
        Some(BindingRegexArtifactPolicy::Include) | None => {
          RegexArtifactPolicy::Include
        }
        Some(BindingRegexArtifactPolicy::Omit) => RegexArtifactPolicy::Omit,
      },
    },
    fuzzy: FuzzySearchOptions {
      case_insensitive: options.fuzzy_case_insensitive.unwrap_or(false),
      whole_words: options.fuzzy_whole_words.unwrap_or(true),
      normalize_diacritics: options.fuzzy_normalize_diacritics.unwrap_or(false),
    },
  }
}

fn slices_from_binding(
  slices: &BindingPreparedSearchSlices,
) -> PreparedEngineSlices {
  PreparedEngineSlices {
    regex: slice_from_binding(slices.regex),
    custom_regex: slice_from_binding(slices.custom_regex),
    legal_forms: slice_from_binding(slices.legal_forms),
    triggers: slice_from_binding(slices.triggers),
    deny_list: slice_from_binding(slices.deny_list),
    street_types: slice_from_binding(slices.street_types),
    gazetteer: slice_from_binding(slices.gazetteer),
    countries: slice_from_binding(slices.countries),
    hotwords: slice_from_binding(slices.hotwords),
  }
}

fn slice_from_binding(slice: Option<BindingPatternSlice>) -> PatternSlice {
  slice.map_or_else(PatternSlice::default, |slice| PatternSlice {
    start: slice.start,
    end: slice.end,
  })
}

fn regex_meta_from_binding(
  meta: Vec<BindingRegexMatchMeta>,
) -> Result<Vec<RegexMatchMeta>> {
  meta
    .into_iter()
    .map(|entry| {
      Ok(RegexMatchMeta {
        label: entry.label,
        score: entry.score,
        source_detail: entry
          .source_detail
          .map(|value| source_detail_from_binding(&value))
          .transpose()?,
        requires_validation: entry.requires_validation.unwrap_or(false),
        validator_id: entry.validator_id,
        validator_input: entry.validator_input,
        min_byte_length: entry.min_byte_length,
      })
    })
    .collect()
}

fn source_detail_from_binding(value: &str) -> Result<SourceDetail> {
  match value {
    "custom-deny-list" => Ok(SourceDetail::CustomDenyList),
    "custom-regex" => Ok(SourceDetail::CustomRegex),
    "gazetteer-extension" => Ok(SourceDetail::GazetteerExtension),
    "address-context" => Ok(SourceDetail::AddressContext),
    _ => Err(ContractError::UnsupportedSourceDetail {
      value: value.to_owned(),
    }),
  }
}

fn operator_from_binding(
  label: &str,
  value: BindingOperator,
) -> Result<Operator> {
  match value {
    BindingOperator::Name(value) => operator_name_from_binding(&value),
    BindingOperator::Tagged(config) => {
      mask_operator_from_binding(label, config)
    }
  }
}

fn operator_name_from_binding(value: &str) -> Result<Operator> {
  match value {
    "replace" => Ok(Operator::Replace),
    "redact" => Ok(Operator::Redact),
    "keep" => Ok(Operator::Keep),
    _ => Err(ContractError::UnsupportedOperator {
      value: value.to_owned(),
    }),
  }
}

fn mask_operator_from_binding(
  label: &str,
  config: BindingTaggedOperator,
) -> Result<Operator> {
  if config.operator_type != "mask" {
    return Err(ContractError::UnsupportedOperator {
      value: config.operator_type,
    });
  }
  let direction = match config.direction.as_str() {
    "start" => MaskDirection::Start,
    "end" => MaskDirection::End,
    _ => {
      return Err(ContractError::InvalidOperatorConfig {
        label: label.to_owned(),
        reason: String::from("direction must be 'start' or 'end'"),
      });
    }
  };
  MaskConfig::new(
    config.masking_character,
    config.characters_to_mask,
    direction,
  )
  .map(Operator::Mask)
  .map_err(|error| ContractError::InvalidOperatorConfig {
    label: label.to_owned(),
    reason: error.to_string(),
  })
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use std::collections::BTreeSet;

  use stella_anonymize_core::{
    MaskDirection, Operator, PERSON_OR_ORGANIZATION_TRIGGER_LABEL,
    PreparedArtifactPolicy, PreparedEngine, RegexArtifactPolicy, SearchPattern,
  };

  use super::{
    operator_config_from_binding, prepared_search_config_from_binding,
    trigger_rule_from_binding,
  };
  use crate::error::ContractError;
  use crate::types::{
    BindingDateData, BindingLegalFormData, BindingOperatorConfig,
    BindingPatternSlice, BindingPreparedArtifactPolicy,
    BindingPreparedSearchConfig, BindingPreparedSearchSlices,
    BindingRegexArtifactPolicy, BindingSearchOptions, BindingSearchPattern,
    BindingTriggerData, BindingTriggerRule, BindingTriggerStrategy,
  };

  fn binding_literal(pattern: &str) -> BindingSearchPattern {
    BindingSearchPattern {
      kind: String::from("literal"),
      pattern: pattern.to_string(),
      distance: None,
      case_insensitive: None,
      whole_words: None,
      lazy: None,
      prefilter_any: None,
      prefilter_case_insensitive: None,
      prefilter_regex: None,
      prefilter_window_bytes: None,
      prepared_artifact_policy: None,
    }
  }

  #[test]
  fn binding_date_data_rejects_incomplete_schema() {
    let missing_ambiguities = r#"{
      "month_names_by_language": {},
      "year_words_by_language": {}
    }"#;

    assert!(
      serde_json::from_str::<BindingDateData>(missing_ambiguities).is_err()
    );
  }

  #[test]
  fn binding_legal_form_data_rejects_missing_detection_only_schema() {
    assert!(
      serde_json::from_str::<BindingLegalFormData>(r#"{"suffixes":[]}"#)
        .is_err()
    );
  }

  #[test]
  fn detection_only_suffixes_never_reach_trigger_data() {
    let config = BindingPreparedSearchConfig {
      legal_form_data: Some(BindingLegalFormData {
        suffixes: vec![String::from("LLC"), String::from("Court")],
        detection_only_suffixes: vec![String::from("Court")],
        institutional_heads: vec![
          String::from("Court"),
          String::from("Society"),
        ],
        ..BindingLegalFormData::default()
      }),
      trigger_data: Some(BindingTriggerData::default()),
      ..BindingPreparedSearchConfig::default()
    };

    let core = prepared_search_config_from_binding(config).unwrap();
    assert_eq!(
      core.detectors.trigger_data.unwrap().legal_form_suffixes,
      ["LLC"]
    );
    assert_eq!(
      core.detectors.legal_form_data.unwrap().institutional_heads,
      ["Court", "Society"]
    );
  }

  #[test]
  fn binding_conversion_inserts_all_caps_institutional_aliases_before_triggers()
  {
    let config = BindingPreparedSearchConfig {
      regex_patterns: vec![
        binding_literal("prefix"),
        binding_literal("Court"),
        binding_literal("Seller: "),
      ],
      slices: BindingPreparedSearchSlices {
        regex: Some(BindingPatternSlice { start: 0, end: 1 }),
        legal_forms: Some(BindingPatternSlice { start: 1, end: 2 }),
        triggers: Some(BindingPatternSlice { start: 2, end: 3 }),
        ..BindingPreparedSearchSlices::default()
      },
      legal_form_data: Some(BindingLegalFormData {
        suffixes: vec![String::from("Court")],
        institutional_heads: vec![String::from("Court")],
        ..BindingLegalFormData::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };

    let core = prepared_search_config_from_binding(config).unwrap();
    assert_eq!(
      core.search.regex_patterns,
      [
        SearchPattern::Literal(String::from("prefix")),
        SearchPattern::Literal(String::from("Court")),
        SearchPattern::Literal(String::from("COURT")),
        SearchPattern::Literal(String::from("Seller: ")),
      ]
    );
    assert_eq!(
      core.search.slices.legal_forms,
      stella_anonymize_core::PatternSlice { start: 1, end: 3 }
    );
    assert_eq!(
      core.search.slices.triggers,
      stella_anonymize_core::PatternSlice { start: 3, end: 4 }
    );
    assert_eq!(
      core.detectors.legal_form_data.unwrap().suffixes,
      ["Court", "COURT"]
    );
  }

  #[test]
  fn binding_conversion_deduplicates_existing_all_caps_institutional_aliases() {
    let config = BindingPreparedSearchConfig {
      regex_patterns: vec![
        binding_literal("Court"),
        binding_literal("COURT"),
        binding_literal("Seller: "),
      ],
      slices: BindingPreparedSearchSlices {
        legal_forms: Some(BindingPatternSlice { start: 0, end: 2 }),
        triggers: Some(BindingPatternSlice { start: 2, end: 3 }),
        ..BindingPreparedSearchSlices::default()
      },
      legal_form_data: Some(BindingLegalFormData {
        suffixes: vec![String::from("Court"), String::from("COURT")],
        institutional_heads: vec![String::from("Court")],
        ..BindingLegalFormData::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };

    let core = prepared_search_config_from_binding(config).unwrap();
    assert_eq!(core.search.regex_patterns.len(), 3);
    assert_eq!(
      core.search.slices.legal_forms,
      stella_anonymize_core::PatternSlice { start: 0, end: 2 }
    );
    assert_eq!(
      core.search.slices.triggers,
      stella_anonymize_core::PatternSlice { start: 2, end: 3 }
    );
  }

  #[test]
  fn binding_conversion_leaves_invalid_legal_slice_for_core_validation() {
    let config = BindingPreparedSearchConfig {
      regex_patterns: vec![binding_literal("Court")],
      slices: BindingPreparedSearchSlices {
        legal_forms: Some(BindingPatternSlice { start: 0, end: 2 }),
        ..BindingPreparedSearchSlices::default()
      },
      legal_form_data: Some(BindingLegalFormData {
        suffixes: vec![String::from("Court")],
        institutional_heads: vec![String::from("Court")],
        ..BindingLegalFormData::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };

    let core = prepared_search_config_from_binding(config).unwrap();
    assert_eq!(core.search.regex_patterns.len(), 1);
    assert_eq!(
      core.search.slices.legal_forms,
      stella_anonymize_core::PatternSlice { start: 0, end: 2 }
    );
    assert!(PreparedEngine::prepare_artifacts(core).is_err());
  }

  #[test]
  fn binding_operator_config_accepts_camel_case_redact_string() {
    let config = serde_json::from_str::<BindingOperatorConfig>(
      r#"{"operators":{"country":"redact","organization":"keep"},"redactString":"***"}"#,
    )
    .unwrap();
    let operators = operator_config_from_binding(Some(config)).unwrap();

    assert_eq!(operators.redact_string, "***");
    assert_eq!(
      operators.operators.get("organization"),
      Some(&Operator::Keep)
    );
  }

  #[test]
  fn binding_operator_config_accepts_tagged_mask() {
    let config = serde_json::from_str::<BindingOperatorConfig>(
      r#"{"operators":{"person":{"type":"mask","maskingCharacter":"●","charactersToMask":2,"direction":"end"}}}"#,
    )
    .unwrap();
    let operators = operator_config_from_binding(Some(config)).unwrap();

    let mask = operators.operators.get("person");
    assert!(matches!(mask, Some(Operator::Mask(_))));
    if let Some(Operator::Mask(mask)) = mask {
      assert_eq!(mask.masking_character(), "●");
      assert_eq!(mask.characters_to_mask(), 2);
      assert_eq!(mask.direction(), MaskDirection::End);
    }
  }

  #[test]
  fn binding_operator_config_rejects_invalid_mask_parameters() {
    for json in [
      r#"{"operators":{"person":{"type":"mask","maskingCharacter":"ab","charactersToMask":2,"direction":"end"}}}"#,
      r#"{"operators":{"person":{"type":"mask","maskingCharacter":"*","charactersToMask":2,"direction":"middle"}}}"#,
      r#"{"operators":{"person":{"type":"mask","maskingCharacter":"*","charactersToMask":0,"direction":"start"}}}"#,
    ] {
      let config = serde_json::from_str::<BindingOperatorConfig>(json).unwrap();
      let error = operator_config_from_binding(Some(config)).unwrap_err();
      assert!(matches!(error, ContractError::InvalidOperatorConfig { .. }));
    }

    let oversized_masking_character = format!("a{}", "\u{301}".repeat(32));
    let json = serde_json::json!({
      "operators": {
        "person": {
          "type": "mask",
          "maskingCharacter": oversized_masking_character,
          "charactersToMask": 2,
          "direction": "end"
        }
      }
    });
    let config = serde_json::from_value::<BindingOperatorConfig>(json).unwrap();
    let error = operator_config_from_binding(Some(config)).unwrap_err();
    assert!(matches!(error, ContractError::InvalidOperatorConfig { .. }));
  }

  #[test]
  fn binding_search_options_accept_regex_overlap_all() {
    let config = BindingPreparedSearchConfig {
      custom_regex_options: Some(BindingSearchOptions {
        regex_overlap_all: Some(true),
        ..BindingSearchOptions::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };
    let core = prepared_search_config_from_binding(config).unwrap();

    assert!(core.search.custom_regex_options.regex.overlap_all);
  }

  #[test]
  fn binding_search_options_accept_regex_artifact_policy() {
    let config = BindingPreparedSearchConfig {
      regex_options: Some(BindingSearchOptions {
        regex_artifact_policy: Some(BindingRegexArtifactPolicy::Omit),
        ..BindingSearchOptions::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };
    let core = prepared_search_config_from_binding(config).unwrap();

    assert_eq!(
      core.search.regex_options.regex.artifact_policy,
      RegexArtifactPolicy::Omit
    );
  }

  #[test]
  fn binding_regex_patterns_accept_prepared_artifact_policy() {
    let config = BindingPreparedSearchConfig {
      regex_patterns: vec![BindingSearchPattern {
        kind: "regex".to_string(),
        pattern: "SSN\\s+\\d+".to_string(),
        distance: None,
        case_insensitive: None,
        whole_words: None,
        lazy: Some(true),
        prefilter_any: Some(vec!["SSN".to_string()]),
        prefilter_case_insensitive: Some(false),
        prefilter_regex: None,
        prefilter_window_bytes: Some(80),
        prepared_artifact_policy: Some(BindingPreparedArtifactPolicy::Omit),
      }],
      ..BindingPreparedSearchConfig::default()
    };
    let core = prepared_search_config_from_binding(config).unwrap();

    assert!(matches!(
      core.search.regex_patterns.first(),
      Some(SearchPattern::RegexWithOptions {
        prepared_artifact_policy: Some(PreparedArtifactPolicy::Omit),
        ..
      })
    ));
  }

  #[test]
  fn party_role_vocabulary_selects_person_or_organization_classification() {
    let party_roles = BTreeSet::from([String::from("seller")]);
    let rule = BindingTriggerRule {
      trigger: String::from("Seller: "),
      label: String::from("organization"),
      strategy: BindingTriggerStrategy::ToEndOfLine {},
      validations: Vec::new(),
      include_trigger: false,
    };

    assert_eq!(
      trigger_rule_from_binding(rule, &party_roles).label,
      PERSON_OR_ORGANIZATION_TRIGGER_LABEL
    );

    let non_role_rule = BindingTriggerRule {
      trigger: String::from("Municipality: "),
      label: String::from("organization"),
      strategy: BindingTriggerStrategy::ToEndOfLine {},
      validations: Vec::new(),
      include_trigger: false,
    };
    assert_eq!(
      trigger_rule_from_binding(non_role_rule, &party_roles).label,
      "organization"
    );
  }
}
