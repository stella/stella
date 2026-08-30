/**
 * Structural type for the prepared static-search config the native binding
 * consumes and the Rust assembler emits (`assembleStaticSearchConfigJson`).
 *
 * This config used to be built in TypeScript by `build-unified-search.ts`; that
 * layer was retired in favor of the Rust assembler
 * (`crates/anonymize-adapter-contract` `assemble_static_search_config`). The
 * type now lives here as a pure, dependency-free description of the JSON the
 * binding accepts on its `fromConfigJsonBytes` / prepare paths, so callers that
 * hold a pre-assembled config keep a precise type without pulling in the
 * deleted detector modules.
 */

export type PatternSlice = {
  start: number;
  end: number;
};

type NativeSearchPatternKind =
  | "literal"
  | "literal-with-options"
  | "regex"
  | "fuzzy";

export type NativeSearchPattern = {
  kind: NativeSearchPatternKind;
  pattern: string;
  distance?: number;
  case_insensitive?: boolean;
  whole_words?: boolean;
  lazy?: boolean;
  prefilter_any?: string[];
  prefilter_case_insensitive?: boolean;
  prefilter_regex?: string;
  prefilter_window_bytes?: number;
  prepared_artifact_policy?: "include" | "omit";
};

export type NativeSearchOptions = {
  literal_case_insensitive?: boolean;
  literal_whole_words?: boolean;
  regex_whole_words?: boolean;
  regex_overlap_all?: boolean;
  regex_artifact_policy?: "include" | "omit";
  fuzzy_case_insensitive?: boolean;
  fuzzy_whole_words?: boolean;
  fuzzy_normalize_diacritics?: boolean;
};

export type NativeRegexMatchMeta = {
  label: string;
  score: number;
  source_detail?: string;
  requires_validation?: boolean;
  validator_id?: string;
  validator_input?: string;
  min_byte_length?: number;
};

export type NativeSigningPlaceGuardData = {
  prefix_phrases: string[];
  suffix_phrases: string[];
};

export type NativeDenyListFilterData = {
  stopwords: string[];
  allow_list: string[];
  person_stopwords: string[];
  person_trailing_nouns: string[];
  address_trailing_nouns: string[];
  address_stopwords: string[];
  address_jurisdiction_prefixes: string[];
  street_types: string[];
  address_component_terms: string[];
  ambiguous_street_type_terms: string[];
  first_names: string[];
  generic_roles: string[];
  page_footer_markers?: string[];
  number_abbrev_prefixes: string[];
  sentence_starters: string[];
  trailing_address_word_exclusions: string[];
  document_heading_words: string[];
  document_heading_ordinal_markers: string[];
  defined_term_cues: string[];
  signing_place_guards: NativeSigningPlaceGuardData[];
  title_tokens: string[];
};

export type NativeDenyListMatchData = {
  labels?: string[][];
  label_table?: string[];
  label_indices?: number[][];
  custom_labels?: string[][];
  custom_label_indices?: number[][];
  originals: string[];
  sources?: string[][];
  source_table?: string[];
  source_indices?: number[][];
  filters?: NativeDenyListFilterData;
};

export type NativeTriggerStrategy =
  | { type: "to-next-comma"; stop_words?: string[]; max_length?: number }
  | { type: "to-end-of-line" }
  | { type: "n-words"; count: number }
  | { type: "company-id-value" }
  | { type: "address"; max_chars?: number }
  | { type: "match-pattern"; pattern: string; flags?: string };

export type NativeTriggerValidation =
  | { type: "starts-uppercase" }
  | { type: "min-length"; min: number }
  | { type: "max-length"; max: number }
  | { type: "no-digits" }
  | { type: "has-digits" }
  | { type: "matches-pattern"; pattern: string; flags?: string }
  | { type: "valid-id"; validator: string };

export type NativeTriggerRule = {
  trigger: string;
  label: string;
  strategy: NativeTriggerStrategy;
  validations: NativeTriggerValidation[];
  include_trigger: boolean;
};

export type NativeTriggerData = {
  rules: NativeTriggerRule[];
  address_stop_keywords: string[];
  party_position_terms: string[];
  post_nominals: string[];
  sentence_terminal_currency_terms: string[];
  phone_extension_labels: string[];
  number_markers: string[];
  number_labels: string[];
  person_field_labels: string[];
};

export type NativeLegalFormData = {
  suffixes: string[];
  non_ascii_name_short_suffixes: string[];
  detection_only_suffixes: string[];
  institutional_heads: string[];
  normalized_boundary_suffixes: string[];
  normalized_in_name_words: string[];
  normalized_suffix_words: string[];
  role_heads: string[];
  sentence_verb_indicators: string[];
  clause_noun_heads: string[];
  connector_prose_heads: string[];
  structural_single_cap_prefixes: string[];
  leading_clause_phrases: string[];
  leading_clause_direct_prefixes: string[];
  connector_words: string[];
  and_connector_words: string[];
  in_name_prepositions: string[];
  company_suffix_words: string[];
  comma_gated_direct_prefixes: string[];
  institutional_complement_heads: string[];
  institutional_complement_starters: string[];
  institutional_complement_connectors: string[];
  institutional_generic_words: string[];
  institutional_prefix_generic_words: string[];
  lowercase_bridge: NativeLowercaseBridge;
};

/**
 * Whether the legal-form name walk may cross arbitrary lowercase words once a
 * capitalized word is in the span (`open`), or only a closed connector set
 * (`closed`).
 */
export type NativeLowercaseBridge = {
  policy: "open" | "closed";
  /** Connector words admitted between capitalized name words (`closed`). */
  words: string[];
};

export type NativeDateMonthData = Record<string, string[]>;
export type NativeYearWordData = Record<string, string[]>;

export type NativeDateData = {
  month_names_by_language: NativeDateMonthData;
  lowercase_month_ambiguities: NativeDateMonthData;
  year_words_by_language: NativeYearWordData;
};

export type NativeMonetaryData = {
  currencies: {
    codes: string[];
    symbols: string[];
    local_names: string[];
  };
  amount_words: {
    written_amount_patterns: Array<{
      keywords: string[];
    }>;
    number_words: Array<{
      words: string[];
      joiners: string[];
    }>;
    magnitude_suffixes: Array<{
      words: string[];
      abbreviations_case_insensitive: string[];
      abbreviations_case_sensitive: string[];
      abbreviations_attached: string[];
    }>;
    share_quantity_terms: Array<{
      modifiers: string[];
      nouns: string[];
    }>;
  };
};

export type NativeStandaloneStreetData = {
  street_type_words: string[];
};

export type NativeAddressSeedData = {
  boundary_words: string[];
  br_cep_cue_words: string[];
  unit_abbreviations: string[];
  directional_abbreviations: string[];
  /** Present only when `standaloneStreetDetection` is enabled. */
  standalone_street?: NativeStandaloneStreetData;
};

export type NativeAddressContextData = {
  address_prepositions: string[];
  temporal_prepositions: string[];
  street_abbreviations: string[];
  bare_house_stopwords: string[];
};

export type NativeCoreferencePatternData = {
  pattern: string;
  flags: string;
};

export type NativeCoreferenceData = {
  definition_patterns: NativeCoreferencePatternData[];
  role_stop_terms: string[];
  legal_form_aliases: string[];
  organization_suffixes: string[];
  organization_determiners: string[];
};

export type NativeNameCorpusData = {
  first_names: string[];
  surnames: string[];
  title_tokens: string[];
  title_abbreviations: string[];
  excluded_words: string[];
  common_words: string[];
  non_western_names: string[];
  excluded_all_caps: string[];
  ja_suffixes: string[];
  arabic_connectors: string[];
  relation_connectors: string[];
  hyphenated_prefixes: string[];
  cjk_non_person_terms: string[];
  cjk_surname_starters: string[];
  organization_terms: string[];
};

export type NativeNameCorpusMode = "full" | "supplemental";

export type NativeZonePatternData = {
  pattern: string;
  flags: string;
};

export type NativeZoneSigningClauseData = {
  prefix: string;
  suffix: string;
  prepositions: string[];
};

export type NativeZoneData = {
  section_heading_patterns: NativeZonePatternData[];
  signing_clauses: NativeZoneSigningClauseData[];
};

export type NativeCountryData = {
  labels: string[];
  isoCodes: string[];
  variants: Array<"name" | "alias" | "alpha3" | "alpha2">;
};

export type NativeGazetteerData = {
  labels: string[];
  is_fuzzy: boolean[];
};

export type NativeHotwordRule = {
  hotwords: string[];
  target_labels: string[];
  score_adjustment: number;
  reclassify_to?: string;
  proximity_before: number;
  proximity_after: number;
};

export type NativeHotwordRuleData = {
  rules: NativeHotwordRule[];
  pattern_rule_indices: number[];
};

export type NativeSignatureData = {
  labels: string[];
  person_value_labels: string[];
  person_list_labels: string[];
  party_role_name_evidence: string;
  witness_phrases: string[];
  name_particles: string[];
  post_nominal_suffixes: string[];
  organization_suffixes: string[];
  form_field_labels: string[];
  contact_field_labels: string[];
  signature_stamp_phrases: string[];
  image_stub_prefixes: string[];
};

export type NativePreparedSearchConfig = {
  regex_patterns: NativeSearchPattern[];
  custom_regex_patterns: NativeSearchPattern[];
  literal_patterns: NativeSearchPattern[];
  regex_options: NativeSearchOptions;
  custom_regex_options: NativeSearchOptions;
  literal_options: NativeSearchOptions;
  literal_patterns_from_deny_list_data?: boolean;
  allowed_labels: string[];
  threshold: number;
  confidence_boost: boolean;
  slices: {
    regex: PatternSlice;
    custom_regex: PatternSlice;
    legal_forms?: PatternSlice;
    triggers?: PatternSlice;
    deny_list: PatternSlice;
    street_types?: PatternSlice;
    gazetteer: PatternSlice;
    countries: PatternSlice;
    hotwords?: PatternSlice;
  };
  regex_meta: NativeRegexMatchMeta[];
  custom_regex_meta: NativeRegexMatchMeta[];
  deny_list_data?: NativeDenyListMatchData;
  false_positive_filters?: NativeDenyListFilterData;
  gazetteer_data?: NativeGazetteerData;
  country_data?: NativeCountryData;
  hotword_data?: NativeHotwordRuleData;
  trigger_data?: NativeTriggerData;
  legal_form_data?: NativeLegalFormData;
  address_seed_data?: NativeAddressSeedData;
  zone_data?: NativeZoneData;
  address_context_data?: NativeAddressContextData;
  coreference_data?: NativeCoreferenceData;
  name_corpus_data?: NativeNameCorpusData;
  signature_data?: NativeSignatureData;
  name_corpus_mode?: NativeNameCorpusMode;
  date_data?: NativeDateData;
  monetary_data?: NativeMonetaryData;
};
