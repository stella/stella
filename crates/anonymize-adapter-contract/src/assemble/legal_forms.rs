//! `legal_form_data`: ports the legal-form getters wired at
//! `build-unified-search.ts:818-849` from `detectors/legal-forms.ts` and
//! `config/legal-forms.ts`.
//!
//! Emitted whenever `nativeLegalFormSuffixes.length > 0`, i.e. when
//! `enableLegalForms` (default true), `enableTriggerPhrases`, or
//! `enableCoreference` is on. In the TypeScript source that same condition also
//! triggers `warmLegalRoleHeads()`, so every `getXSync()` accessor returns its
//! fully loaded cache (never the seed fallback) by the time the field is built;
//! this port reproduces the loaded values directly.
//!
//! Legal role heads and institutional organization vocabulary follow the
//! configured content-language scope. Language-neutral legal-form suffixes and
//! structural rule words remain shared.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, OrderedMap, data_file, parse_data_file,
  parse_ordered_data_file,
};

use super::{AssembleContext, language};
use crate::{
  BindingLegalFormData, BindingLowercaseBridge, BindingLowercaseBridgePolicy,
};

/// `RAW_LEGAL_SUFFIXES` from `config/legal-forms.ts`. Sorted longest-first
/// (stable) at use to form `LEGAL_SUFFIXES`.
const RAW_LEGAL_SUFFIXES: &[&str] = &[
  // Czech
  "spol. s r.o.",
  "s.r.o.",
  "s. r. o.",
  "a.s.",
  "a. s.",
  "v.o.s.",
  "v. o. s.",
  "k.s.",
  "k. s.",
  "z.s.",
  "z. s.",
  "z.ú.",
  "z. ú.",
  "o.p.s.",
  "o. p. s.",
  "s.p.",
  "s. p.",
  // German / Austrian / Swiss
  "GmbH",
  "AG",
  "SE",
  "KG",
  "OHG",
  // English (UK/US/AU/IE)
  "Ltd.",
  "Ltd",
  "LTD.",
  "LTD",
  "LLC",
  "LLP",
  "Inc.",
  "INC.",
  "Inc",
  "INC",
  "Corp.",
  "CORP.",
  "Corp",
  "CORP",
  "Corporation",
  "CORPORATION",
  "Co.",
  "CO.",
  "LP",
  "L.P.",
  "PLC",
  "plc",
  "N.A.",
  "N.V.",
  "B.V.",
  "Pty Ltd.",
  "Pty Ltd",
  "PTY LTD.",
  "PTY LTD",
  // French / Iberian / Italian
  "S.A.",
  "SA",
  "SAS",
  "SARL",
  "S.p.A.",
  // Polish
  "Sp. z o.o.",
  "Sp. k.",
  "Sp. j.",
  // Brazilian / Portuguese
  "Ltda.",
  "LTDA.",
  "Ltda",
  "LTDA",
  "S/A",
  "EIRELI",
  "EPP",
  "ME",
  "MEI",
];

/// Clause-noun seed set (`CLAUSE_NOUN_HEADS_SEED`).
const CLAUSE_NOUN_HEADS_SEED: &[&str] = &["agreement", "contract"];

/// Selected language files that carry `legalRoleHeads`, in `manifest.json`
/// declaration order. An absent selection keeps the all-language default.
fn legal_role_head_languages(
  selected: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct Manifest {
    languages: OrderedMap<ManifestLanguage>,
  }
  #[derive(Deserialize)]
  struct ManifestLanguage {
    #[serde(default, rename = "legalRoleHeads")]
    legal_role_heads: Option<bool>,
  }
  let manifest: Manifest = parse_data_file("manifest.json")?;
  Ok(
    manifest
      .languages
      .iter()
      .filter(|(code, lang)| {
        lang.legal_role_heads == Some(true)
          && language::language_config_matches(code, selected)
      })
      .map(|(code, _)| code.clone())
      .collect(),
  )
}

/// Every `manifest.json` language code, in declaration order.
fn manifest_language_codes() -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct Manifest {
    languages: OrderedMap<Value>,
  }
  let manifest: Manifest = parse_data_file("manifest.json")?;
  Ok(
    manifest
      .languages
      .iter()
      .map(|(code, _)| code.clone())
      .collect(),
  )
}

const LOWERCASE_BRIDGE_FILE: &str = "legal-form-lowercase-bridge.json";

#[derive(Deserialize)]
#[serde(tag = "policy", rename_all = "kebab-case", deny_unknown_fields)]
enum LowercaseBridgeEntry {
  Open,
  Closed { words: Vec<String> },
}

/// Lowercase-bridge policy for the selected content languages: open when any
/// selected language is open (or nothing is selected), otherwise the union of
/// the selected closed word lists. Every manifest language must have an
/// entry so a new language cannot silently inherit English behavior.
fn lowercase_bridge(
  languages: Option<&[String]>,
) -> Result<BindingLowercaseBridge, AssembleError> {
  let configured: OrderedMap<Value> =
    parse_ordered_data_file(LOWERCASE_BRIDGE_FILE)?;
  for code in manifest_language_codes()? {
    if configured.get(&code).is_none() {
      return Err(AssembleError::DataParse {
        name: String::from(LOWERCASE_BRIDGE_FILE),
        message: format!("manifest language {code} has no entry"),
      });
    }
  }
  let mut selected_any = false;
  let mut seen = HashSet::new();
  let mut words = Vec::new();
  for (language_key, value) in &configured {
    if language_key.starts_with('_')
      || !language::language_config_matches(language_key, languages)
    {
      continue;
    }
    let entry = LowercaseBridgeEntry::deserialize(value).map_err(|error| {
      AssembleError::DataParse {
        name: String::from(LOWERCASE_BRIDGE_FILE),
        message: format!("language {language_key}: {error}"),
      }
    })?;
    selected_any = true;
    match entry {
      LowercaseBridgeEntry::Open => {
        return Ok(BindingLowercaseBridge {
          policy: BindingLowercaseBridgePolicy::Open,
          words: Vec::new(),
        });
      }
      LowercaseBridgeEntry::Closed { words: entry_words } => {
        for word in entry_words {
          if word.is_empty() {
            return Err(AssembleError::DataParse {
              name: String::from(LOWERCASE_BRIDGE_FILE),
              message: format!(
                "language {language_key}: words must be non-empty strings"
              ),
            });
          }
          push_unique(word, &mut seen, &mut words);
        }
      }
    }
  }
  if !selected_any {
    return Ok(BindingLowercaseBridge {
      policy: BindingLowercaseBridgePolicy::Open,
      words: Vec::new(),
    });
  }
  Ok(BindingLowercaseBridge {
    policy: BindingLowercaseBridgePolicy::Closed,
    words,
  })
}

/// JS `\s` (with the `u` flag) whitespace set, used by `normalizeLegalSuffixToken`
/// (`/[.,\s]/g`) and the in-name filter (`/\s/u`). Rust's `char::is_whitespace`
/// differs (it includes U+0085 and excludes U+FEFF), so the set is explicit.
const fn is_js_whitespace(ch: char) -> bool {
  matches!(
    ch,
    '\t'
      | '\n'
      | '\u{000B}'
      | '\u{000C}'
      | '\r'
      | ' '
      | '\u{00A0}'
      | '\u{1680}'
      | '\u{2000}'
      ..='\u{200A}'
        | '\u{2028}'
        | '\u{2029}'
        | '\u{202F}'
        | '\u{205F}'
        | '\u{3000}'
        | '\u{FEFF}'
  )
}

/// Mirrors `normalizeLegalSuffixToken`: strip `.`, `,`, and JS whitespace.
fn normalize_legal_suffix_token(suffix: &str) -> String {
  suffix
    .chars()
    .filter(|&ch| ch != '.' && ch != ',' && !is_js_whitespace(ch))
    .collect()
}

/// JS `.length`: UTF-16 code-unit count, so the longest-first sort ties break
/// identically to `Array.prototype.sort`.
fn utf16_len(value: &str) -> usize {
  value.encode_utf16().count()
}

/// `[...list].sort((a, b) => b.length - a.length)`, stable, longest-first.
fn sort_longest_first(values: &mut [String]) {
  values.sort_by_key(|value| std::cmp::Reverse(utf16_len(value)));
}

/// Pushes `value` only if unseen (mirrors JS `Set` insertion-order semantics).
fn push_unique(
  value: String,
  seen: &mut HashSet<String>,
  out: &mut Vec<String>,
) {
  if seen.insert(value.clone()) {
    out.push(value);
  }
}

/// Mirrors `LEGAL_SUFFIXES`: `RAW_LEGAL_SUFFIXES` sorted longest-first (stable).
///
/// Reused by `coreference_data` as `nativeOrganizationSuffixes`
/// (`build-unified-search.ts:816`).
pub(super) fn legal_suffixes() -> Vec<String> {
  let mut out: Vec<String> = RAW_LEGAL_SUFFIXES
    .iter()
    .map(|s| (*s).to_string())
    .collect();
  sort_longest_first(&mut out);
  out
}

/// Mirrors `getAllLegalSuffixesSync` (post-warm): flatten `legal-forms.json`
/// values (first-occurrence dedup), append `LEGAL_SUFFIXES` not already seen,
/// sort longest-first (stable).
///
/// Reused by `coreference_data` as `nativeLegalFormSuffixes` /
/// `getKnownLegalSuffixes` (`build-unified-search.ts:813`).
pub(super) fn all_legal_suffixes() -> Result<Vec<String>, AssembleError> {
  let data: OrderedMap<Value> = parse_ordered_data_file("legal-forms.json")?;
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for (_country, forms) in &data {
    let Some(forms) = forms.as_array() else {
      continue;
    };
    for form in forms {
      let Some(form) = form.as_str() else {
        continue;
      };
      if form.is_empty() {
        continue;
      }
      push_unique(form.to_string(), &mut seen, &mut out);
    }
  }
  for form in legal_suffixes() {
    push_unique(form, &mut seen, &mut out);
  }
  sort_longest_first(&mut out);
  Ok(out)
}

/// Legal-form suffixes plus language-scoped institutional heads used only by
/// organization detection. Coreference deliberately keeps
/// [`all_legal_suffixes`] so a generic head such as "Court" is never stripped
/// into an unsafe alias such as "High".
pub(super) fn organization_detection_suffixes(
  languages: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  let mut out = all_legal_suffixes()?;
  let mut seen = out.iter().cloned().collect::<HashSet<_>>();
  for value in institutional_organization_data(languages)?.heads {
    push_unique(value, &mut seen, &mut out);
  }
  sort_longest_first(&mut out);
  Ok(out)
}

#[derive(Default, Deserialize)]
struct InstitutionalOrganizationData {
  heads: Vec<String>,
  #[serde(rename = "complementHeads")]
  complement_heads: Vec<String>,
}

fn institutional_organization_data(
  languages: Option<&[String]>,
) -> Result<InstitutionalOrganizationData, AssembleError> {
  let configured: OrderedMap<Value> =
    parse_ordered_data_file("institutional-organization-heads.json")?;
  let mut result = InstitutionalOrganizationData::default();
  let mut seen_heads = HashSet::new();
  let mut seen_complements = HashSet::new();
  for (language_key, value) in &configured {
    if language_key.starts_with('_')
      || !language::language_config_matches(language_key, languages)
    {
      continue;
    }
    let data =
      InstitutionalOrganizationData::deserialize(value).map_err(|error| {
        AssembleError::DataParse {
          name: String::from("institutional-organization-heads.json"),
          message: format!("language {language_key}: {error}"),
        }
      })?;
    validate_institutional_terms(language_key, &data)?;
    for head in data.heads {
      push_unique(head, &mut seen_heads, &mut result.heads);
    }
    for head in data.complement_heads {
      push_unique(head, &mut seen_complements, &mut result.complement_heads);
    }
  }
  Ok(result)
}

fn validate_institutional_terms(
  language_key: &str,
  data: &InstitutionalOrganizationData,
) -> Result<(), AssembleError> {
  for (field, terms) in [
    ("heads", &data.heads),
    ("complementHeads", &data.complement_heads),
  ] {
    if terms.iter().any(|term| term.trim().is_empty()) {
      return Err(AssembleError::DataParse {
        name: String::from("institutional-organization-heads.json"),
        message: format!(
          "language {language_key}: {field} must contain non-empty strings"
        ),
      });
    }
  }
  Ok(())
}

fn institutional_language_words(
  file_name: &str,
  languages: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  let configured: OrderedMap<Value> = parse_ordered_data_file(file_name)?;
  let mut result = Vec::new();
  let mut seen = HashSet::new();
  for (language_key, value) in &configured {
    if language_key.starts_with('_')
      || !language::language_config_matches(language_key, languages)
    {
      continue;
    }
    let Some(words) = value.as_array() else {
      return Err(AssembleError::DataParse {
        name: String::from(file_name),
        message: format!("language {language_key}: expected an array"),
      });
    };
    for word in words {
      let Some(word) = word.as_str() else {
        return Err(AssembleError::DataParse {
          name: String::from(file_name),
          message: format!(
            "language {language_key}: expected non-empty strings"
          ),
        });
      };
      if word.trim().is_empty() {
        return Err(AssembleError::DataParse {
          name: String::from(file_name),
          message: format!(
            "language {language_key}: expected non-empty strings"
          ),
        });
      }
      push_unique(word.to_string(), &mut seen, &mut result);
    }
  }
  Ok(result)
}

/// Mirrors `isBoundaryLegalSuffixForm`.
fn is_boundary_legal_suffix_form(
  form: &str,
  raw_suffix_set: &HashSet<&'static str>,
) -> bool {
  let normalized = normalize_legal_suffix_token(form);
  if normalized.is_empty() {
    return false;
  }
  if raw_suffix_set.contains(form) {
    return true;
  }
  form.contains('.') || normalized == normalized.to_uppercase()
}

/// Loads a per-language `{ "lang": [...] }`-shaped file that maps arbitrary
/// keys (skipping `_`-prefixed metadata) to string arrays, unioning every
/// value into an insertion-ordered dedup set seeded with `seed`. Mirrors the
/// `loadClauseNounHeads` / `loadStructuralSingleCapPrefixes` shape.
fn load_lowercase_union(
  file: &str,
  seed: &[&str],
) -> Result<Vec<String>, AssembleError> {
  let mut dedup = HashSet::new();
  let mut out = Vec::new();
  for word in seed {
    push_unique((*word).to_string(), &mut dedup, &mut out);
  }
  let data: OrderedMap<Value> = parse_ordered_data_file(file)?;
  for (key, value) in &data {
    if key.starts_with('_') {
      continue;
    }
    let Some(words) = value.as_array() else {
      continue;
    };
    for word in words {
      let Some(word) = word.as_str() else {
        continue;
      };
      if word.is_empty() {
        continue;
      }
      push_unique(word.to_lowercase(), &mut dedup, &mut out);
    }
  }
  Ok(out)
}

fn scoped_sentence_verb_indicators(
  selected: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  let configured: OrderedMap<Value> =
    parse_ordered_data_file("sentence-verb-indicators.json")?;
  Ok(language::language_keyed_terms(&configured, selected)
    .into_iter()
    .map(|word| word.to_lowercase())
    .collect())
}

/// Mirrors `getLegalRoleHeadsSync` (post-warm).
///
/// Reused by `trigger_data` as `partyPositionTerms`
/// (`build-unified-search.ts:851`).
pub(super) fn role_heads(
  selected: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct RoleHeads {
    #[serde(default)]
    words: Vec<String>,
  }
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for code in legal_role_head_languages(selected)? {
    let file = format!("legal-role-heads.{code}.json");
    // Manifest may list a language the static registry cannot load; skip it
    // like `loadLanguageConfigs` skips a missing loader.
    if data_file(&file).is_none() {
      continue;
    }
    let parsed: RoleHeads = parse_data_file(&file)?;
    for word in parsed.words {
      if word.is_empty() {
        continue;
      }
      push_unique(word.to_lowercase(), &mut seen, &mut out);
    }
  }
  Ok(out)
}

/// Mirrors `getClauseNounHeadsSync` (post-warm): the `clause-noun-heads.json`
/// union seeded with `CLAUSE_NOUN_HEADS_SEED`, lowercased with insertion-order
/// dedup. Reused by `false_positive_filters` for `trailingAddressWordExclusions`.
pub(super) fn clause_noun_heads() -> Result<Vec<String>, AssembleError> {
  load_lowercase_union("clause-noun-heads.json", CLAUSE_NOUN_HEADS_SEED)
}

fn scoped_clause_noun_heads(
  selected: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  let configured: OrderedMap<Value> =
    parse_ordered_data_file("clause-noun-heads.json")?;
  let mut seen = HashSet::new();
  let mut result = Vec::new();
  if language::language_config_matches("en", selected) {
    for word in CLAUSE_NOUN_HEADS_SEED {
      push_unique((*word).to_string(), &mut seen, &mut result);
    }
  }
  for word in language::language_keyed_terms(&configured, selected) {
    push_unique(word.to_lowercase(), &mut seen, &mut result);
  }
  Ok(result)
}

/// Mirrors `getConnectorProseHeadsSync` (post-warm): `generic-roles.json`
/// `roles`, lowercased, insertion-order dedup, filtered through explicit
/// language ownership from `connector-prose-heads.json`.
fn connector_prose_heads(
  selected: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct GenericRoles {
    #[serde(default)]
    roles: Vec<String>,
  }
  let parsed: GenericRoles = parse_data_file("generic-roles.json")?;
  let ownership: OrderedMap<Value> =
    parse_ordered_data_file("connector-prose-heads.json")?;
  let selected_roles: HashSet<String> =
    language::language_keyed_terms(&ownership, selected)
      .into_iter()
      .map(|role| role.to_lowercase())
      .collect();
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for role in parsed.roles {
    if role.is_empty() {
      continue;
    }
    let role = role.to_lowercase();
    if !selected_roles.contains(&role) {
      continue;
    }
    push_unique(role, &mut seen, &mut out);
  }
  Ok(out)
}

/// Mirrors `getLeadingClauseTrimsSync` (post-warm).
struct LeadingClauseTrims {
  phrases: Vec<String>,
  direct_prefixes: Vec<String>,
}

fn leading_clause_trims(
  selected: Option<&[String]>,
) -> Result<LeadingClauseTrims, AssembleError> {
  let data: OrderedMap<Value> =
    parse_ordered_data_file("legal-form-leading-clauses.json")?;
  let mut phrase_seen = HashSet::new();
  let mut phrases = Vec::new();
  let mut prefix_seen = HashSet::new();
  let mut direct_prefixes = Vec::new();
  for (key, value) in &data {
    if key.starts_with('_') || !value.is_object() {
      continue;
    }
    if !language::language_config_matches(key, selected) {
      continue;
    }
    if let Some(entries) = value.get("phrases").and_then(Value::as_array) {
      for phrase in entries {
        if let Some(phrase) = phrase.as_str()
          && !phrase.is_empty()
        {
          push_unique(phrase.to_string(), &mut phrase_seen, &mut phrases);
        }
      }
    }
    if let Some(entries) = value.get("directPrefixes").and_then(Value::as_array)
    {
      for prefix in entries {
        if let Some(prefix) = prefix.as_str()
          && !prefix.is_empty()
        {
          push_unique(
            prefix.to_string(),
            &mut prefix_seen,
            &mut direct_prefixes,
          );
        }
      }
    }
  }
  Ok(LeadingClauseTrims {
    phrases,
    direct_prefixes,
  })
}

/// Shared and language-owned arrays from `legal-form-rule-words.json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegalFormRuleWords {
  #[serde(default)]
  connector_words: Vec<String>,
  #[serde(default)]
  connector_word_languages: OrderedMap<Value>,
  #[serde(default)]
  party_connector_words: OrderedMap<Value>,
  #[serde(default)]
  in_name_prepositions: Vec<String>,
  #[serde(default)]
  company_suffix_words: Vec<String>,
  #[serde(default)]
  comma_gated_direct_prefixes: Vec<String>,
}

fn scoped_connector_words(
  rule_words: &LegalFormRuleWords,
  selected: Option<&[String]>,
) -> Vec<String> {
  let owned: HashSet<String> = language::language_keyed_terms(
    &rule_words.connector_word_languages,
    selected,
  )
  .into_iter()
  .map(|word| word.to_lowercase())
  .collect();
  rule_words
    .connector_words
    .iter()
    .map(|word| word.to_lowercase())
    .filter(|word| owned.contains(word))
    .collect()
}

type ScopedLegalFormRuleWords = (LegalFormRuleWords, Vec<String>, Vec<String>);

fn scoped_legal_form_rule_words(
  selected: Option<&[String]>,
) -> Result<ScopedLegalFormRuleWords, AssembleError> {
  let rule_words: LegalFormRuleWords =
    parse_data_file("legal-form-rule-words.json")?;
  let connector_words = scoped_connector_words(&rule_words, selected);
  let party_connector_words =
    language::language_keyed_terms(&rule_words.party_connector_words, selected);
  Ok((rule_words, connector_words, party_connector_words))
}

#[derive(Deserialize)]
struct LegalFormLanguageScope {
  #[serde(default, rename = "denyListCountries")]
  countries: Vec<String>,
}

#[derive(Deserialize)]
struct LegalFormLanguageScopes {
  #[serde(default)]
  languages: std::collections::BTreeMap<String, LegalFormLanguageScope>,
}

fn is_short_bare_ascii_suffix(value: &str) -> bool {
  !value.contains('.')
    && !value.is_empty()
    && value.len() <= 2
    && value.chars().all(|ch| ch.is_ascii_uppercase())
}

fn non_ascii_name_short_suffixes(
  languages: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  let scopes: LegalFormLanguageScopes =
    parse_data_file("language-scopes.json")?;
  let selected_countries =
    language::selected_language_keys(languages).map(|_| {
      let selected = languages.unwrap_or_default();
      scopes
        .languages
        .iter()
        .filter(|(language_key, _)| {
          language::language_config_matches(language_key, Some(selected))
        })
        .flat_map(|(_, scope)| scope.countries.iter().cloned())
        .collect::<HashSet<_>>()
    });
  let legal_forms: OrderedMap<Value> =
    parse_ordered_data_file("legal-forms.json")?;
  let mut seen = HashSet::new();
  let mut result = Vec::new();
  for (country, values) in &legal_forms {
    if selected_countries
      .as_ref()
      .is_some_and(|countries| !countries.contains(country))
    {
      continue;
    }
    let Some(values) = values.as_array() else {
      continue;
    };
    for value in values {
      let Some(value) = value.as_str() else {
        continue;
      };
      if is_short_bare_ascii_suffix(value) {
        push_unique(value.to_string(), &mut seen, &mut result);
      }
    }
  }
  Ok(result)
}

fn is_emitted(ctx: &AssembleContext<'_>) -> bool {
  let config = ctx.config;
  // `isLegalFormsEnabled`: `enableLegalForms !== false` (omitted = enabled).
  config.enable_legal_forms != Some(false)
    || config.enable_trigger_phrases
    || config.enable_coreference
}

/// # Errors
///
/// Returns [`AssembleError`] when any embedded legal-form data file fails to
/// parse.
pub(super) fn build_legal_form_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingLegalFormData>, AssembleError> {
  if !is_emitted(ctx) {
    return Ok(None);
  }

  let ordinary_suffixes = all_legal_suffixes()?;
  let ordinary_suffix_set = ordinary_suffixes
    .iter()
    .map(String::as_str)
    .collect::<HashSet<_>>();
  let suffixes =
    organization_detection_suffixes(ctx.content_languages.as_deref())?;
  let detection_only_suffixes = suffixes
    .iter()
    .filter(|suffix| !ordinary_suffix_set.contains(suffix.as_str()))
    .cloned()
    .collect();
  let raw_suffix_set: HashSet<&'static str> =
    RAW_LEGAL_SUFFIXES.iter().copied().collect();

  // normalized_boundary_suffixes: boundary forms, normalized, nonempty, deduped.
  let mut boundary_seen = HashSet::new();
  let mut normalized_boundary_suffixes = Vec::new();
  // normalized_in_name_words: non-boundary, whitespace-free forms.
  let mut in_name_seen = HashSet::new();
  let mut normalized_in_name_words = Vec::new();
  for form in &suffixes {
    let boundary = is_boundary_legal_suffix_form(form, &raw_suffix_set);
    let normalized = normalize_legal_suffix_token(form);
    if normalized.is_empty() {
      continue;
    }
    if boundary {
      push_unique(
        normalized,
        &mut boundary_seen,
        &mut normalized_boundary_suffixes,
      );
    } else if !form.chars().any(is_js_whitespace) {
      push_unique(normalized, &mut in_name_seen, &mut normalized_in_name_words);
    }
  }

  // normalized_suffix_words: map+filter over the suffixes, WITHOUT dedup.
  let normalized_suffix_words: Vec<String> = suffixes
    .iter()
    .map(|suffix| normalize_legal_suffix_token(suffix).to_lowercase())
    .filter(|suffix| !suffix.is_empty())
    .collect();

  let trims = leading_clause_trims(ctx.content_languages.as_deref())?;
  let (rule_words, connector_words, party_connector_words) =
    scoped_legal_form_rule_words(ctx.content_languages.as_deref())?;
  let institutional =
    institutional_organization_data(ctx.content_languages.as_deref())?;

  Ok(Some(BindingLegalFormData {
    suffixes,
    non_ascii_name_short_suffixes: non_ascii_name_short_suffixes(
      ctx.content_languages.as_deref(),
    )?,
    detection_only_suffixes,
    institutional_heads: institutional.heads,
    normalized_boundary_suffixes,
    normalized_in_name_words,
    normalized_suffix_words,
    role_heads: role_heads(ctx.content_languages.as_deref())?,
    sentence_verb_indicators: scoped_sentence_verb_indicators(
      ctx.content_languages.as_deref(),
    )?,
    clause_noun_heads: scoped_clause_noun_heads(
      ctx.content_languages.as_deref(),
    )?,
    connector_prose_heads: connector_prose_heads(
      ctx.content_languages.as_deref(),
    )?,
    structural_single_cap_prefixes: load_lowercase_union(
      "structural-single-cap-prefixes.json",
      &[],
    )?,
    leading_clause_phrases: trims.phrases,
    leading_clause_direct_prefixes: trims.direct_prefixes,
    connector_words,
    and_connector_words: party_connector_words,
    in_name_prepositions: rule_words.in_name_prepositions,
    company_suffix_words: rule_words.company_suffix_words,
    comma_gated_direct_prefixes: rule_words.comma_gated_direct_prefixes,
    institutional_complement_heads: institutional.complement_heads,
    institutional_complement_starters: institutional_language_words(
      "institutional-organization-complement-starters.json",
      ctx.content_languages.as_deref(),
    )?,
    institutional_complement_connectors: institutional_language_words(
      "institutional-organization-complement-connectors.json",
      ctx.content_languages.as_deref(),
    )?,
    institutional_generic_words: institutional_language_words(
      "institutional-organization-generic-name-words.json",
      ctx.content_languages.as_deref(),
    )?,
    institutional_prefix_generic_words: institutional_language_words(
      "institutional-organization-prefix-generic-name-words.json",
      ctx.content_languages.as_deref(),
    )?,
    lowercase_bridge: lowercase_bridge(ctx.content_languages.as_deref())?,
  }))
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use std::collections::HashSet;

  use serde_json::Value;
  use stella_anonymize_core::assemble::{OrderedMap, parse_ordered_data_file};

  use super::{
    InstitutionalOrganizationData, LegalFormRuleWords, all_legal_suffixes,
    connector_prose_heads, institutional_language_words, language,
    leading_clause_trims, non_ascii_name_short_suffixes,
    organization_detection_suffixes, parse_data_file, role_heads,
    scoped_clause_noun_heads, scoped_connector_words,
    scoped_sentence_verb_indicators,
    validate_institutional_terms,
  };

  #[test]
  fn institutional_heads_follow_content_language_scope() {
    let english =
      organization_detection_suffixes(Some(&[String::from("en")])).unwrap();
    let german =
      organization_detection_suffixes(Some(&[String::from("de")])).unwrap();
    let all = organization_detection_suffixes(None).unwrap();

    assert!(english.iter().any(|suffix| suffix == "Court"));
    let ordinary = all_legal_suffixes().unwrap();
    for detection_only in ["Court", "Office", "Chambers"] {
      assert!(!ordinary.iter().any(|suffix| suffix == detection_only));
    }
    assert!(!german.iter().any(|suffix| suffix == "Court"));
    assert!(all.iter().any(|suffix| suffix == "Court"));
  }

  #[test]
  fn legal_role_heads_follow_content_language_scope() {
    let czech = role_heads(Some(&[String::from("cs")])).unwrap();
    let english = role_heads(Some(&[String::from("en")])).unwrap();

    assert!(czech.iter().any(|word| word == "poskytovatele"));
    assert!(!english.iter().any(|word| word == "poskytovatele"));
  }

  #[test]
  fn sentence_verbs_follow_content_language_scope() {
    let english =
      scoped_sentence_verb_indicators(Some(&[String::from("en")])).unwrap();
    let german =
      scoped_sentence_verb_indicators(Some(&[String::from("de")])).unwrap();

    assert!(english.iter().any(|word| word == "is"));
    assert!(!english.iter().any(|word| word == "ist"));
    assert!(german.iter().any(|word| word == "ist"));
    assert!(!german.iter().any(|word| word == "is"));
  }

  #[test]
  fn clause_noun_heads_follow_content_language_scope() {
    let czech = scoped_clause_noun_heads(Some(&[String::from("cs")])).unwrap();
    let english =
      scoped_clause_noun_heads(Some(&[String::from("en")])).unwrap();

    assert!(czech.iter().any(|word| word == "dohoda"));
    assert!(!english.iter().any(|word| word == "dohoda"));
    assert!(english.iter().any(|word| word == "agreement"));
    assert!(!czech.iter().any(|word| word == "agreement"));
  }

  #[test]
  fn leading_clause_prefixes_follow_content_language_scope() {
    let german = leading_clause_trims(Some(&[String::from("de")])).unwrap();
    assert!(german.direct_prefixes.contains(&String::from("mit")));
    assert!(german.phrases.contains(&String::from("ist mit")));
    assert!(!german.direct_prefixes.contains(&String::from("with")));
    assert!(!german.phrases.contains(&String::from("is with")));

    let czech = leading_clause_trims(Some(&[String::from("cs")])).unwrap();
    assert!(czech.direct_prefixes.contains(&String::from("s")));
    assert!(czech.phrases.contains(&String::from("je s")));
    assert!(!czech.direct_prefixes.contains(&String::from("mit")));
    assert!(!czech.phrases.contains(&String::from("ist mit")));
  }

  #[test]
  fn connector_prose_heads_follow_content_language_scope() {
    let czech = connector_prose_heads(Some(&[String::from("cs")])).unwrap();
    let english = connector_prose_heads(Some(&[String::from("en")])).unwrap();

    assert!(czech.contains(&String::from("nájemce")));
    assert!(!czech.contains(&String::from("customer")));
    assert!(english.contains(&String::from("customer")));
    assert!(english.contains(&String::from("supplier")));
    assert!(!english.contains(&String::from("nájemce")));
  }

  #[test]
  fn connector_prose_ownership_exactly_covers_generic_roles() {
    let generic: Value = parse_data_file("generic-roles.json").unwrap();
    let expected: HashSet<String> = generic
      .get("roles")
      .and_then(Value::as_array)
      .unwrap()
      .iter()
      .filter_map(Value::as_str)
      .map(str::to_string)
      .collect();
    let ownership: OrderedMap<Value> =
      parse_ordered_data_file("connector-prose-heads.json").unwrap();
    let owned: HashSet<String> =
      language::language_keyed_terms(&ownership, None)
        .into_iter()
        .collect();

    assert_eq!(owned, expected);
    for shared_role in ["cedente", "cliente", "parte"] {
      let owner_count = ownership
        .values()
        .filter_map(Value::as_array)
        .filter(|roles| {
          roles.iter().any(|role| role.as_str() == Some(shared_role))
        })
        .count();
      assert!(owner_count >= 2, "{shared_role} must retain every owner");
    }
  }

  #[test]
  fn alphabetic_connectors_follow_content_language_scope() {
    let rule_words: LegalFormRuleWords =
      parse_data_file("legal-form-rule-words.json").unwrap();
    let english =
      scoped_connector_words(&rule_words, Some(&[String::from("en")]));
    let italian =
      scoped_connector_words(&rule_words, Some(&[String::from("it")]));
    let english_party = language::language_keyed_terms(
      &rule_words.party_connector_words,
      Some(&[String::from("en")]),
    );
    let italian_party = language::language_keyed_terms(
      &rule_words.party_connector_words,
      Some(&[String::from("it")]),
    );

    assert_eq!(english, ["and", "&"]);
    assert_eq!(italian, ["e", "&"]);
    assert_eq!(english_party, ["and"]);
    assert_eq!(italian_party, ["e"]);
  }

  #[test]
  fn unicode_name_short_suffixes_follow_content_language_scope() {
    let czech =
      non_ascii_name_short_suffixes(Some(&[String::from("cs")])).unwrap();
    let german =
      non_ascii_name_short_suffixes(Some(&[String::from("de")])).unwrap();
    let latvian =
      non_ascii_name_short_suffixes(Some(&[String::from("lv")])).unwrap();

    assert!(czech.iter().any(|suffix| suffix == "SE"));
    assert!(!czech.iter().any(|suffix| suffix == "PS"));
    assert!(!czech.iter().any(|suffix| suffix == "AG"));
    assert!(german.iter().any(|suffix| suffix == "AG"));
    assert!(!german.iter().any(|suffix| suffix == "PS"));
    assert!(latvian.iter().any(|suffix| suffix == "PS"));
    assert!(!latvian.iter().any(|suffix| suffix == "AG"));
  }

  #[test]
  fn institutional_heads_reject_empty_terms() {
    for data in [
      InstitutionalOrganizationData {
        heads: vec![String::new()],
        complement_heads: Vec::new(),
      },
      InstitutionalOrganizationData {
        heads: Vec::new(),
        complement_heads: vec![String::from("  ")],
      },
    ] {
      let error = validate_institutional_terms("en", &data).unwrap_err();
      assert!(error.to_string().contains("must contain non-empty strings"));
    }
  }

  #[test]
  fn institutional_vocabulary_follows_content_language_scope() {
    for (file_name, expected_english_word) in [
      ("institutional-organization-complement-starters.json", "of"),
      (
        "institutional-organization-complement-connectors.json",
        "the",
      ),
      (
        "institutional-organization-generic-name-words.json",
        "legal",
      ),
      (
        "institutional-organization-prefix-generic-name-words.json",
        "finance",
      ),
    ] {
      let english =
        institutional_language_words(file_name, Some(&[String::from("en")]))
          .unwrap();
      let german =
        institutional_language_words(file_name, Some(&[String::from("de")]))
          .unwrap();

      assert!(english.iter().any(|word| word == expected_english_word));
      assert!(german.is_empty());
    }
  }
}
