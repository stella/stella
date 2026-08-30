//! Stage-1 native-config assembler.
//!
//! Ports `buildNativeStaticSearchBundle` /
//! `buildNativeStaticConfig` from
//! `packages/anonymize/src/build-unified-search.ts` into Rust. The assembler is
//! now complete: every field of [`BindingPreparedSearchConfig`] is produced from
//! the pipeline config, dictionaries, and gazetteer entries. The golden parity
//! harness compares the full config against the TypeScript source, and a
//! separate digest gate hashes the end-to-end package bytes. [`FIELDS_PENDING`]
//! is empty; [`FIELDS_IMPLEMENTED`] lists every field for reference.
//!
//! The assembler lives in this crate rather than `stella-anonymize-core`
//! because the output type [`BindingPreparedSearchConfig`] is defined here, and
//! the core crate cannot depend on this crate without a cycle. The input
//! structs and embedded data tree it operates on live in
//! `stella_anonymize_core::assemble`.

mod address;
mod coreference;
mod country;
mod dates;
mod deny_list;
mod gazetteer;
mod hotwords;
mod js;
mod language;
mod legal_forms;
mod monetary;
mod names;
mod regex;
mod search_pattern;
mod signature;
mod trigger;
mod zones;

use stella_anonymize_core::assemble::{
  AssembleError, CustomRegexPattern, Dictionaries, GazetteerEntry,
  PipelineConfig, PreparedArtifactPolicy,
};

use crate::{
  BindingNameCorpusMode, BindingPatternSlice, BindingPreparedArtifactPolicy,
  BindingPreparedSearchConfig, BindingPreparedSearchSlices,
  BindingRegexArtifactPolicy, BindingRegexMatchMeta, BindingSearchOptions,
  BindingSearchPattern, BindingTriggerRule,
};

/// `DEFAULT_CUSTOM_REGEX_SCORE`: the score a caller-supplied regex without an
/// explicit score gets in `customRegexMeta`.
const DEFAULT_CUSTOM_REGEX_SCORE: f64 = 0.9;

/// Every field of [`BindingPreparedSearchConfig`] the assembler fills.
///
/// All are compared by the golden parity harness (including `name_corpus_mode`,
/// gated on name-corpus-data presence exactly as the TypeScript source emits
/// it).
pub const FIELDS_IMPLEMENTED: &[&str] = &[
  "allowed_labels",
  "threshold",
  "confidence_boost",
  "custom_regex_patterns",
  "regex_options",
  "custom_regex_options",
  "name_corpus_mode",
  "signature_data",
  "monetary_data",
  "date_data",
  "zone_data",
  "address_context_data",
  "address_seed_data",
  "country_data",
  "hotword_data",
  "custom_regex_meta",
  "regex_meta",
  "legal_form_data",
  "gazetteer_data",
  "coreference_data",
  "trigger_data",
  "regex_patterns",
  "literal_patterns",
  "literal_options",
  "literal_patterns_from_deny_list_data",
  "slices",
  "deny_list_data",
  "false_positive_filters",
  "name_corpus_data",
];

/// Fields still left at their `Default` value, to be filled by later slices.
pub const FIELDS_PENDING: &[&str] = &[];

/// Gating context shared by every field builder.
///
/// Mirrors the locals computed at the top of `buildUnifiedSearchSources`:
/// content-language scope, the hotword-expanded search labels, and the derived
/// allowed-label set.
struct AssembleContext<'a> {
  config: &'a PipelineConfig,
  /// Effective dictionaries: the separately supplied bundle wins over
  /// `config.dictionaries` (JSON callers pass large bundles out of band).
  dictionaries: Option<&'a Dictionaries>,
  /// `configuredContentLanguages(config)`: `None` means "all languages".
  content_languages: Option<Vec<String>>,
  /// `createAllowedLabelSet(searchLabels)`: `None` means "no filter".
  allowed_labels: Option<Vec<String>>,
}

impl AssembleContext<'_> {
  /// Mirrors `labelIsAllowed`: an absent set means every label is allowed.
  fn label_allowed(&self, label: &str) -> bool {
    self
      .allowed_labels
      .as_ref()
      .is_none_or(|labels| labels.iter().any(|allowed| allowed == label))
  }

  const fn enable_regex(&self) -> bool {
    self.config.enable_regex
  }

  const fn enable_trigger_phrases(&self) -> bool {
    self.config.enable_trigger_phrases
  }

  /// `regexMonetaryEnabled`: regex on and the monetary label allowed.
  fn regex_monetary_enabled(&self) -> bool {
    self.enable_regex() && self.label_allowed("monetary amount")
  }
}

/// Assembles a prepared static-search config from a pipeline config,
/// dictionaries, and gazetteer entries.
///
/// # Errors
///
/// Returns [`AssembleError`] when an embedded data file needed by a ported
/// field fails to parse.
pub fn assemble_static_search_config(
  config: &PipelineConfig,
  dictionaries: Option<&Dictionaries>,
  gazetteer: &[GazetteerEntry],
) -> Result<BindingPreparedSearchConfig, AssembleError> {
  // `enableHotwordRules === true` loads the rule set; it feeds both the
  // hotword_data field and the label expansion that gates every other field.
  let hotword_rules = if config.enable_hotword_rules == Some(true) {
    hotwords::load_hotword_rules()?
  } else {
    Vec::new()
  };
  let search_labels = if config.enable_hotword_rules == Some(true) {
    hotwords::expand_labels_for_hotword_rule_set(&config.labels, &hotword_rules)
  } else {
    config.labels.clone()
  };
  let ctx = AssembleContext {
    config,
    dictionaries: dictionaries.or(config.dictionaries.as_ref()),
    content_languages: language::configured_content_languages(config),
    allowed_labels: allowed_label_set(&search_labels),
  };

  let regex = regex::build_regex(&ctx)?;

  // `sources.triggers.rules` feeds both the `regex_patterns` trigger tail and
  // `trigger_data`; build it once, like the TypeScript source.
  let trigger_rules = if ctx.enable_trigger_phrases() {
    trigger::build_trigger_rules(ctx.content_languages.as_deref())?
  } else {
    Vec::new()
  };

  // Slice-offset bookkeeping for the regex-side pattern array.
  let regex_prefix_len = regex.patterns.len();
  let legal_forms_len = if config.enable_legal_forms == Some(false) {
    0
  } else {
    legal_forms::organization_detection_suffixes(
      ctx.content_languages.as_deref(),
    )?
    .len()
  };
  let trigger_len = trigger_rules.len();

  let regex_patterns =
    assemble_regex_patterns(&ctx, regex.patterns, &trigger_rules)?;
  let custom_regex_patterns = assemble_custom_regex_patterns(&ctx);
  let custom_regex_len = custom_regex_patterns.len();

  let address_shared = address::build_address_shared_data(&ctx)?;
  let unit = build_deny_list_unit(&ctx, &address_shared)?;

  // ── Literal-side patterns, options, and slices ──
  let address_seed_data =
    address::build_address_seed_data(&ctx, &address_shared)?;
  let gazetteer_data = gazetteer::build_gazetteer_data(&ctx, gazetteer);
  let country = country::build_country_unit(&ctx)?;
  let literals = build_literals(&LiteralInputs {
    ctx: &ctx,
    gazetteer,
    deny_list_data: unit.deny_list_data.as_ref(),
    address_seed_present: ctx.label_allowed("address"),
    gazetteer_data: gazetteer_data.as_ref(),
    country_surface_forms: &country.surface_forms,
  })?;

  let slices = build_slices(&SliceInputs {
    regex_prefix_len,
    custom_regex_len,
    legal_forms_len,
    trigger_len,
    literals: &literals,
  });

  Ok(BindingPreparedSearchConfig {
    custom_regex_patterns,
    custom_regex_meta: assemble_custom_regex_meta(&ctx),
    regex_patterns,
    regex_meta: regex.meta,
    legal_form_data: legal_forms::build_legal_form_data(&ctx)?,
    allowed_labels: config.labels.clone(),
    threshold: config.threshold,
    confidence_boost: config.enable_confidence_boost,
    regex_options: Some(regex_options_template()),
    custom_regex_options: Some(custom_regex_options_template()),
    literal_patterns: literals.literal_patterns,
    literal_options: Some(literals.literal_options),
    literal_patterns_from_deny_list_data: literals.from_deny_list_data,
    slices,
    name_corpus_mode: resolved_name_corpus_mode(
      config,
      unit.name_corpus_data.is_some(),
    ),
    signature_data: Some(signature::build_signature_data(
      ctx.content_languages.as_deref(),
      ctx.dictionaries,
    )?),
    monetary_data: monetary::build_monetary_data(&ctx)?,
    date_data: dates::build_date_data(&ctx)?,
    zone_data: zones::build_zone_data(&ctx)?,
    address_context_data: address::build_address_context_data(&ctx)?,
    address_seed_data,
    country_data: country.match_data,
    hotword_data: hotwords::build_hotword_data(&hotword_rules),
    gazetteer_data,
    coreference_data: coreference::build_coreference_data(&ctx)?,
    trigger_data: trigger::build_trigger_data(&ctx, trigger_rules)?,
    deny_list_data: unit.deny_list_data,
    false_positive_filters: Some(unit.filters),
    name_corpus_data: unit.name_corpus_data,
  })
}

/// The entangled deny-list unit: the shared false-positive filters, the encoded
/// deny-list match data, and the name-corpus data. Built in the TypeScript load
/// order (`initNameCorpus` before the stopword-dependent filters).
struct DenyListUnit {
  deny_list_data: Option<crate::BindingDenyListMatchData>,
  filters: crate::BindingDenyListFilterData,
  name_corpus_data: Option<crate::BindingNameCorpusData>,
}

/// Ports the `buildDenyList` / `buildDenyListFilterData` /
/// `buildNativeNameCorpusData` cluster. `applyPipelineLanguageScope` derives the
/// effective name-corpus languages and deny-list countries; the name corpus is
/// built first (the filters and deny data consume the first-name list), then the
/// filters (always emitted), the deny-list data (only when the deny list is on),
/// and finally the name-corpus data (only when name corpus is on).
fn build_deny_list_unit(
  ctx: &AssembleContext<'_>,
  address_shared: &address::AddressSharedData,
) -> Result<DenyListUnit, AssembleError> {
  let config = ctx.config;
  let scoped = language::apply_pipeline_language_scope(config)?;
  let corpus = names::build_name_corpus(
    ctx.dictionaries,
    scoped.name_corpus_languages.as_deref(),
  )?;
  let mut filters = deny_list::build_deny_list_filter_data(
    &corpus,
    ctx.content_languages.as_deref(),
  )?;
  filters
    .us_state_abbreviations
    .clone_from(&address_shared.us_state_abbreviations);

  let deny_intermediate = if config.enable_deny_list {
    deny_list::build_deny_list(&deny_list::DenyBuildContextArgs {
      config,
      dictionaries: ctx.dictionaries,
      name_corpus_languages: scoped.name_corpus_languages.as_deref(),
      deny_list_countries: scoped.deny_list_countries.as_deref(),
      corpus: &corpus,
    })?
  } else {
    None
  };
  let deny_list_data = deny_intermediate
    .map(|data| deny_list::to_native_deny_list_data(data, filters.clone()));

  let name_corpus_data = names::build_native_name_corpus_data(
    &corpus,
    config.enable_name_corpus,
    scoped.name_corpus_languages.as_deref(),
  )?;

  Ok(DenyListUnit {
    deny_list_data,
    filters,
    name_corpus_data,
  })
}

/// Inputs to [`build_slices`].
struct SliceInputs<'a> {
  regex_prefix_len: usize,
  custom_regex_len: usize,
  legal_forms_len: usize,
  trigger_len: usize,
  literals: &'a Literals,
}

/// Assembles the nine pattern slices (`build-unified-search.ts:1464-1483`). The
/// four literal-side slices are precomputed in [`build_literals`].
fn build_slices(inputs: &SliceInputs<'_>) -> BindingPreparedSearchSlices {
  let legal_start = inputs.regex_prefix_len;
  let legal_end = legal_start.saturating_add(inputs.legal_forms_len);
  let trigger_end = legal_end.saturating_add(inputs.trigger_len);
  BindingPreparedSearchSlices {
    regex: Some(slice_range(0, inputs.regex_prefix_len)),
    custom_regex: Some(slice_range(0, inputs.custom_regex_len)),
    legal_forms: Some(slice_range(legal_start, legal_end)),
    triggers: Some(slice_range(legal_end, trigger_end)),
    deny_list: Some(inputs.literals.deny_list_slice),
    street_types: Some(inputs.literals.street_types_slice),
    gazetteer: Some(inputs.literals.gazetteer_slice),
    countries: Some(inputs.literals.countries_slice),
    hotwords: Some(inputs.literals.hotwords_slice),
  }
}

/// JS number → `u32` for pattern counts, saturating on the (unreachable) 4 G
/// overflow rather than truncating like an `as` cast.
fn to_u32(value: usize) -> u32 {
  u32::try_from(value).unwrap_or(u32::MAX)
}

fn slice_range(start: usize, end: usize) -> BindingPatternSlice {
  BindingPatternSlice {
    start: to_u32(start),
    end: to_u32(end),
  }
}

/// A slice starting at `start` spanning `len` entries, returning the slice and
/// the offset just past it.
fn slice_from(start: usize, len: usize) -> (BindingPatternSlice, usize) {
  let end = start.saturating_add(len);
  (slice_range(start, end), end)
}

/// Result of literal-pattern synthesis: the combined pattern array, its options,
/// the `literal_patterns_from_deny_list_data` flag, and the four literal slices.
struct Literals {
  literal_patterns: Vec<BindingSearchPattern>,
  literal_options: BindingSearchOptions,
  from_deny_list_data: bool,
  deny_list_slice: BindingPatternSlice,
  street_types_slice: BindingPatternSlice,
  gazetteer_slice: BindingPatternSlice,
  countries_slice: BindingPatternSlice,
  hotwords_slice: BindingPatternSlice,
}

struct LiteralInputs<'a> {
  ctx: &'a AssembleContext<'a>,
  gazetteer: &'a [GazetteerEntry],
  deny_list_data: Option<&'a crate::BindingDenyListMatchData>,
  address_seed_present: bool,
  gazetteer_data: Option<&'a crate::BindingGazetteerMatchData>,
  country_surface_forms: &'a [String],
}

/// Ports the literal-pattern half of `buildNativeStaticConfig`
/// (`build-unified-search.ts:1369-1483`): the deny-list / street-type /
/// gazetteer / country pattern synthesis, the `literal_options`, and the four
/// literal-side pattern slices.
fn build_literals(
  inputs: &LiteralInputs<'_>,
) -> Result<Literals, AssembleError> {
  let (deny_originals, deny_sources) = inputs
    .deny_list_data
    .map(deny_list::deny_originals_and_sources)
    .unwrap_or_default();

  // `hasCustomLiteralBoundaryOverride`: a custom-deny entry with non-alphanumeric
  // edges (word-boundary literals would not match it).
  let has_custom_boundary_override =
    deny_originals.iter().enumerate().any(|(index, pattern)| {
      deny_sources
        .get(index)
        .is_some_and(|sources| sources.iter().any(|s| s == "custom-deny-list"))
        && !deny_list::custom_deny_list_needs_whole_words(pattern)
    });
  let gaz_present = gazetteer::has_gazetteer(inputs.ctx, inputs.gazetteer);
  let can_use_global = !has_custom_boundary_override && !gaz_present;
  let from_deny_list_data = can_use_global && inputs.deny_list_data.is_some();

  // Deny-list patterns (empty when synthesized from data at load time).
  let mut deny_patterns = Vec::new();
  if !from_deny_list_data {
    for (index, pattern) in deny_originals.iter().enumerate() {
      let is_custom = deny_sources
        .get(index)
        .is_some_and(|sources| sources.iter().any(|s| s == "custom-deny-list"));
      let whole_words = if is_custom {
        deny_list::custom_deny_list_needs_whole_words(pattern)
      } else {
        true
      };
      deny_patterns
        .push(deny_list_native_pattern(pattern.clone(), whole_words));
    }
  }

  // Street-type patterns (only when address-seed data is present).
  let street_types = address::street_type_patterns()?;
  let street_type_patterns: Vec<BindingSearchPattern> =
    if inputs.address_seed_present {
      street_types
        .iter()
        .map(|pattern| {
          if can_use_global {
            search_pattern::literal(pattern.clone())
          } else {
            deny_list_native_pattern(pattern.clone(), true)
          }
        })
        .collect()
    } else {
      Vec::new()
    };

  let gazetteer_patterns =
    gazetteer::gazetteer_literal_patterns(inputs.ctx, inputs.gazetteer);

  let country_patterns: Vec<BindingSearchPattern> = inputs
    .country_surface_forms
    .iter()
    .cloned()
    .map(|pattern| {
      if can_use_global {
        search_pattern::literal(pattern)
      } else {
        search_pattern::literal_with_options(pattern, None, Some(true))
      }
    })
    .collect();

  // Literal-side slice offsets.
  let deny_list_count = if from_deny_list_data {
    deny_originals.len()
  } else {
    deny_patterns.len()
  };
  let (deny_list_slice, offset) = slice_from(0, deny_list_count);
  let (street_types_slice, offset) =
    slice_from(offset, street_type_patterns.len());
  let (gazetteer_slice, offset) = slice_from(offset, gazetteer_patterns.len());
  let (countries_slice, offset) = slice_from(offset, country_patterns.len());
  let hotwords_slice = slice_range(offset, offset);

  let mut literal_patterns = deny_patterns;
  literal_patterns.extend(street_type_patterns);
  literal_patterns.extend(gazetteer_patterns);
  literal_patterns.extend(country_patterns);

  let has_gazetteer_fuzzy = inputs
    .gazetteer_data
    .is_some_and(|data| data.is_fuzzy.iter().any(|&fuzzy| fuzzy));
  let literal_options = BindingSearchOptions {
    literal_case_insensitive: Some(true),
    literal_whole_words: Some(can_use_global),
    fuzzy_case_insensitive: Some(true),
    fuzzy_whole_words: Some(!has_gazetteer_fuzzy),
    fuzzy_normalize_diacritics: Some(true),
    ..BindingSearchOptions::default()
  };

  Ok(Literals {
    literal_patterns,
    literal_options,
    from_deny_list_data,
    deny_list_slice,
    street_types_slice,
    gazetteer_slice,
    countries_slice,
    hotwords_slice,
  })
}

/// `toNativeDenyListPattern`: a case-insensitive whole-word literal-with-options.
fn deny_list_native_pattern(
  pattern: String,
  whole_words: bool,
) -> BindingSearchPattern {
  search_pattern::literal_with_options(pattern, Some(true), Some(whole_words))
}

/// Mirrors the `name_corpus_mode` emission gate: only set when name-corpus data
/// is present; `full` iff the deny list is off, else `supplemental` (the
/// default). Absent data leaves the field at its `supplemental` default.
const fn resolved_name_corpus_mode(
  config: &PipelineConfig,
  has_name_corpus_data: bool,
) -> BindingNameCorpusMode {
  if has_name_corpus_data && !config.enable_deny_list {
    BindingNameCorpusMode::Full
  } else {
    BindingNameCorpusMode::Supplemental
  }
}

/// Assembles the full `regex_patterns` array: the static + signing prefix, then
/// the legal-form literal tail, then the trigger literal tail (mirrors the
/// `nativeConfig.regex_patterns.push(...legalFormNativePatterns,
/// ...triggerNativePatterns)` at `build-unified-search.ts:1488`).
///
/// The legal-form tail is `nativeLegalFormPatterns.map(toNativeLegalFormPattern)`
/// where `nativeLegalFormPatterns` is `getKnownLegalSuffixes()` gated on
/// `isLegalFormsEnabled` alone (`enableLegalForms !== false`), NOT the wider
/// condition that emits `legal_form_data`. The trigger tail is each rule's
/// trigger lowercased.
fn assemble_regex_patterns(
  ctx: &AssembleContext<'_>,
  prefix: Vec<BindingSearchPattern>,
  trigger_rules: &[BindingTriggerRule],
) -> Result<Vec<BindingSearchPattern>, AssembleError> {
  let mut patterns = prefix;
  if ctx.config.enable_legal_forms != Some(false) {
    for suffix in legal_forms::organization_detection_suffixes(
      ctx.content_languages.as_deref(),
    )? {
      patterns.push(literal_pattern(suffix));
    }
  }
  for rule in trigger_rules {
    patterns.push(trigger_literal_pattern(rule.trigger.to_lowercase()));
  }
  Ok(patterns)
}

/// `toNativeLegalFormPattern`: a bare case-sensitive literal.
fn literal_pattern(pattern: String) -> BindingSearchPattern {
  BindingSearchPattern {
    kind: "literal".to_string(),
    pattern,
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

/// `toNativeTriggerPattern`: a case-insensitive literal-with-options.
fn trigger_literal_pattern(pattern: String) -> BindingSearchPattern {
  BindingSearchPattern {
    kind: "literal-with-options".to_string(),
    pattern,
    distance: None,
    case_insensitive: Some(true),
    whole_words: None,
    lazy: None,
    prefilter_any: None,
    prefilter_case_insensitive: None,
    prefilter_regex: None,
    prefilter_window_bytes: None,
    prepared_artifact_policy: None,
  }
}

fn regex_options_template() -> BindingSearchOptions {
  BindingSearchOptions {
    literal_case_insensitive: Some(true),
    literal_whole_words: Some(false),
    regex_whole_words: Some(false),
    regex_artifact_policy: Some(BindingRegexArtifactPolicy::Omit),
    ..BindingSearchOptions::default()
  }
}

fn custom_regex_options_template() -> BindingSearchOptions {
  BindingSearchOptions {
    regex_whole_words: Some(false),
    regex_overlap_all: Some(true),
    regex_artifact_policy: Some(BindingRegexArtifactPolicy::Omit),
    ..BindingSearchOptions::default()
  }
}

fn assemble_custom_regex_patterns(
  ctx: &AssembleContext<'_>,
) -> Vec<BindingSearchPattern> {
  if !ctx.config.enable_regex {
    return Vec::new();
  }
  let Some(customs) = ctx.config.custom_regexes.as_ref() else {
    return Vec::new();
  };
  customs
    .iter()
    .filter(|entry| ctx.label_allowed(entry.label.as_str()))
    .map(custom_regex_pattern)
    .collect()
}

/// Mirrors `customRegexMeta.map(toNativeRegexMeta)`. Caller-supplied regexes
/// never carry a validator, so this reduces to the label, the score (defaulting
/// to [`DEFAULT_CUSTOM_REGEX_SCORE`]), and the `custom-regex` source detail.
fn assemble_custom_regex_meta(
  ctx: &AssembleContext<'_>,
) -> Vec<BindingRegexMatchMeta> {
  if !ctx.config.enable_regex {
    return Vec::new();
  }
  let Some(customs) = ctx.config.custom_regexes.as_ref() else {
    return Vec::new();
  };
  customs
    .iter()
    .filter(|entry| ctx.label_allowed(entry.label.as_str()))
    .map(|entry| BindingRegexMatchMeta {
      label: entry.label.clone(),
      score: entry.score.unwrap_or(DEFAULT_CUSTOM_REGEX_SCORE),
      source_detail: Some("custom-regex".to_string()),
      ..BindingRegexMatchMeta::default()
    })
    .collect()
}

/// Mirrors `createAllowedLabelSet`: an empty label list means "no filter".
///
/// The labels passed in are the hotword-expanded `searchLabels`, so
/// custom-regex gating stays consistent with the TypeScript source even when
/// `enableHotwordRules` reclassifies labels.
fn allowed_label_set(labels: &[String]) -> Option<Vec<String>> {
  if labels.is_empty() {
    return None;
  }
  Some(labels.to_vec())
}

fn custom_regex_pattern(entry: &CustomRegexPattern) -> BindingSearchPattern {
  BindingSearchPattern {
    kind: "regex".to_string(),
    pattern: entry.pattern.clone(),
    distance: None,
    case_insensitive: None,
    whole_words: None,
    lazy: None,
    prefilter_any: None,
    prefilter_case_insensitive: None,
    prefilter_regex: None,
    prefilter_window_bytes: None,
    prepared_artifact_policy: entry
      .prepared_artifact_policy
      .map(map_prepared_artifact_policy),
  }
}

const fn map_prepared_artifact_policy(
  policy: PreparedArtifactPolicy,
) -> BindingPreparedArtifactPolicy {
  match policy {
    PreparedArtifactPolicy::Include => BindingPreparedArtifactPolicy::Include,
    PreparedArtifactPolicy::Omit => BindingPreparedArtifactPolicy::Omit,
  }
}
