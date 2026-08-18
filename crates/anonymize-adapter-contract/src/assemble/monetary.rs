//! `monetary_data`: ports `getMonetaryData` / `loadMonetaryData`
//! (`detectors/regex.ts`).
//!
//! Copy-through of `currencies.json` and the `amount-words.json` entries whose
//! `lang` matches the configured content-language scope (every entry when no
//! scope is set), with the camelCase-to-snake_case key rename the TypeScript
//! loader performed. Emitted when `enableTriggerPhrases` is on or the
//! "monetary amount" regex is active.

use std::collections::HashSet;

use serde::Deserialize;
use stella_anonymize_core::assemble::{AssembleError, parse_data_file};

use super::js::utf16_cmp;
use super::{AssembleContext, language};
use crate::{
  BindingAmountWordsData, BindingCurrencyData, BindingMagnitudeSuffixData,
  BindingMonetaryData, BindingNumberWordData, BindingShareQuantityTermData,
  BindingWrittenAmountPatternData,
};

#[derive(Deserialize)]
struct CurrenciesData {
  #[serde(default)]
  codes: Vec<String>,
  #[serde(default)]
  symbols: Vec<String>,
  #[serde(rename = "localNames", default)]
  local_names: Vec<String>,
}

#[derive(Deserialize)]
struct AmountWordsData {
  #[serde(default)]
  patterns: Vec<WrittenAmountPattern>,
  #[serde(rename = "numberWords", default)]
  number_words: Vec<NumberWords>,
  #[serde(rename = "magnitudeSuffixes", default)]
  magnitude_suffixes: Vec<MagnitudeSuffix>,
  #[serde(rename = "shareQuantityTerms", default)]
  share_quantity_terms: Vec<ShareQuantityTerm>,
}

#[derive(Deserialize)]
struct WrittenAmountPattern {
  lang: String,
  #[serde(default)]
  keywords: Vec<String>,
}

#[derive(Deserialize)]
struct NumberWords {
  lang: String,
  #[serde(default)]
  words: Vec<String>,
  #[serde(default)]
  joiners: Vec<String>,
}

#[derive(Deserialize)]
struct MagnitudeSuffix {
  lang: String,
  #[serde(default)]
  words: Vec<String>,
  #[serde(rename = "abbreviationsCaseInsensitive", default)]
  abbreviations_case_insensitive: Vec<String>,
  #[serde(rename = "abbreviationsCaseSensitive", default)]
  abbreviations_case_sensitive: Vec<String>,
  #[serde(rename = "abbreviationsAttached", default)]
  abbreviations_attached: Vec<String>,
}

#[derive(Deserialize)]
struct ShareQuantityTerm {
  lang: String,
  #[serde(default)]
  modifiers: Vec<String>,
  #[serde(default)]
  nouns: Vec<String>,
}

/// Mirrors `sentenceTerminalCurrencyTerms` (`build-unified-search.ts:1851`):
/// the union of currency codes, symbols, and local names (nonempty), deduped in
/// first-occurrence order, then `toSorted()` (UTF-16 code-unit order).
///
/// Returns `[]` when the monetary data is not built (the TypeScript helper
/// short-circuits on a null `monetaryData`), matching the same gate as
/// [`build_monetary_data`].
///
/// # Errors
///
/// Returns [`AssembleError`] when `currencies.json` fails to parse.
pub(super) fn sentence_terminal_currency_terms(
  ctx: &AssembleContext<'_>,
) -> Result<Vec<String>, AssembleError> {
  if !(ctx.enable_trigger_phrases() || ctx.regex_monetary_enabled()) {
    return Ok(Vec::new());
  }
  let currencies: CurrenciesData = parse_data_file("currencies.json")?;
  let mut seen = HashSet::new();
  let mut terms = Vec::new();
  for term in currencies
    .codes
    .into_iter()
    .chain(currencies.symbols)
    .chain(currencies.local_names)
  {
    if term.is_empty() {
      continue;
    }
    if seen.insert(term.clone()) {
      terms.push(term);
    }
  }
  terms.sort_by(|left, right| utf16_cmp(left, right));
  Ok(terms)
}

/// # Errors
///
/// Returns [`AssembleError`] when `currencies.json` or `amount-words.json`
/// fails to parse.
pub(super) fn build_monetary_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingMonetaryData>, AssembleError> {
  if !(ctx.enable_trigger_phrases() || ctx.regex_monetary_enabled()) {
    return Ok(None);
  }
  let currencies: CurrenciesData = parse_data_file("currencies.json")?;
  let amount_words: AmountWordsData = parse_data_file("amount-words.json")?;
  let languages = ctx.content_languages.as_deref();
  let selected =
    |lang: &str| language::language_config_matches(lang, languages);

  Ok(Some(BindingMonetaryData {
    currencies: BindingCurrencyData {
      codes: currencies.codes,
      symbols: currencies.symbols,
      local_names: currencies.local_names,
    },
    amount_words: BindingAmountWordsData {
      written_amount_patterns: amount_words
        .patterns
        .into_iter()
        .filter(|entry| selected(&entry.lang))
        .map(|entry| BindingWrittenAmountPatternData {
          keywords: entry.keywords,
        })
        .collect(),
      number_words: amount_words
        .number_words
        .into_iter()
        .filter(|entry| selected(&entry.lang))
        .map(|entry| BindingNumberWordData {
          words: entry.words,
          joiners: entry.joiners,
        })
        .collect(),
      magnitude_suffixes: amount_words
        .magnitude_suffixes
        .into_iter()
        .filter(|entry| selected(&entry.lang))
        .map(|entry| BindingMagnitudeSuffixData {
          words: entry.words,
          abbreviations_case_insensitive: entry.abbreviations_case_insensitive,
          abbreviations_case_sensitive: entry.abbreviations_case_sensitive,
          abbreviations_attached: entry.abbreviations_attached,
        })
        .collect(),
      share_quantity_terms: amount_words
        .share_quantity_terms
        .into_iter()
        .filter(|entry| selected(&entry.lang))
        .map(|entry| BindingShareQuantityTermData {
          modifiers: entry.modifiers,
          nouns: entry.nouns,
        })
        .collect(),
    },
  }))
}
