use crate::processors::{
  CountryMatchData, GazetteerMatchData, PatternSlice, RegexMatchMeta,
};
use crate::resolution::SourceDetail;
use crate::types::{Error, Result};
use crate::validators::validate_id;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PreparedRegexMatchData {
  slice: PatternSlice,
  rows: Vec<PreparedRegexMatchRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PreparedRegexMatchRow {
  label: String,
  score: f64,
  source_detail: Option<SourceDetail>,
  validation: RegexValidation,
  min_byte_length: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RegexValidation {
  None,
  Validator {
    id: String,
    input: Option<ValidatorInput>,
  },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ValidatorInput {
  DigitsOnly,
  CryptoWalletCandidate,
}

impl ValidatorInput {
  fn parse(value: &str, field: &'static str) -> Result<Self> {
    match value {
      "digits-only" => Ok(Self::DigitsOnly),
      "crypto-wallet-candidate" => Ok(Self::CryptoWalletCandidate),
      _ => Err(Error::InvalidStaticData {
        field,
        reason: format!("unsupported validator_input '{value}'"),
      }),
    }
  }

  const fn as_str(self) -> &'static str {
    match self {
      Self::DigitsOnly => "digits-only",
      Self::CryptoWalletCandidate => "crypto-wallet-candidate",
    }
  }
}

impl RegexValidation {
  fn prepare(
    requires_validation: bool,
    validator_id: Option<String>,
    validator_input: Option<&str>,
    pattern: u32,
    field: &'static str,
  ) -> Result<Self> {
    let Some(id) = validator_id else {
      if requires_validation || validator_input.is_some() {
        return Err(Error::UnsupportedRegexValidation { pattern });
      }
      return Ok(Self::None);
    };
    if !is_supported_validator(&id) {
      return Err(Error::InvalidStaticData {
        field,
        reason: format!("unsupported validator_id '{id}'"),
      });
    }
    let input = validator_input
      .map(|input| ValidatorInput::parse(input, field))
      .transpose()?;
    Ok(Self::Validator { id, input })
  }

  fn accepts(&self, value: &str) -> bool {
    match self {
      Self::None => true,
      Self::Validator { id, input } => {
        validate_id(id, value, input.map(ValidatorInput::as_str))
      }
    }
  }
}

impl PreparedRegexMatchData {
  pub(crate) fn new(
    data: Vec<RegexMatchMeta>,
    slice: PatternSlice,
    field: &'static str,
  ) -> Result<Self> {
    validate_length(field, slice, data.len())?;
    let rows = data
      .into_iter()
      .enumerate()
      .map(|(index, row)| {
        let pattern = pattern_at(slice, index, field)?;
        Ok(PreparedRegexMatchRow {
          label: row.label,
          score: row.score,
          source_detail: row.source_detail,
          validation: RegexValidation::prepare(
            row.requires_validation,
            row.validator_id,
            row.validator_input.as_deref(),
            pattern,
            field,
          )?,
          min_byte_length: row.min_byte_length,
        })
      })
      .collect::<Result<Vec<_>>>()?;
    Ok(Self { slice, rows })
  }

  pub(crate) const fn is_empty(&self) -> bool {
    self.rows.is_empty()
  }

  pub(crate) fn get(&self, pattern: u32) -> Option<&PreparedRegexMatchRow> {
    self
      .slice
      .local_index(pattern)
      .and_then(|index| self.rows.get(index))
  }
}

impl PreparedRegexMatchRow {
  pub(crate) fn label(&self) -> &str {
    &self.label
  }

  pub(crate) const fn score(&self) -> f64 {
    self.score
  }

  pub(crate) const fn source_detail(&self) -> Option<SourceDetail> {
    self.source_detail
  }

  pub(crate) fn accepts(&self, value: &str) -> bool {
    self.validation.accepts(value)
  }

  pub(crate) fn accepts_byte_length(&self, length: u32) -> bool {
    self.min_byte_length.is_none_or(|minimum| length >= minimum)
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedGazetteerMatchData {
  slice: PatternSlice,
  rows: Vec<PreparedGazetteerMatchRow>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedGazetteerMatchRow {
  label: String,
  is_fuzzy: bool,
}

impl PreparedGazetteerMatchData {
  pub(crate) fn new(
    data: GazetteerMatchData,
    slice: PatternSlice,
  ) -> Result<Self> {
    validate_length("gazetteer_data.labels", slice, data.labels.len())?;
    validate_length("gazetteer_data.is_fuzzy", slice, data.is_fuzzy.len())?;
    let rows = data
      .labels
      .into_iter()
      .zip(data.is_fuzzy)
      .map(|(label, is_fuzzy)| PreparedGazetteerMatchRow { label, is_fuzzy })
      .collect();
    Ok(Self { slice, rows })
  }

  pub(crate) fn get(&self, pattern: u32) -> Option<&PreparedGazetteerMatchRow> {
    self
      .slice
      .local_index(pattern)
      .and_then(|index| self.rows.get(index))
  }
}

impl PreparedGazetteerMatchRow {
  pub(crate) fn label(&self) -> &str {
    &self.label
  }

  pub(crate) const fn is_fuzzy(&self) -> bool {
    self.is_fuzzy
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedCountryMatchData {
  slice: PatternSlice,
  rows: Vec<PreparedCountryMatchRow>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PreparedCountryMatchRow {
  label: String,
}

impl PreparedCountryMatchData {
  pub(crate) fn new(
    data: CountryMatchData,
    slice: PatternSlice,
  ) -> Result<Self> {
    validate_length("country_data.labels", slice, data.labels.len())?;
    validate_length("country_data.isoCodes", slice, data.iso_codes.len())?;
    validate_length("country_data.variants", slice, data.variants.len())?;
    let rows = data
      .labels
      .into_iter()
      .zip(data.iso_codes)
      .zip(data.variants)
      .map(|((label, _iso_code), _variant)| PreparedCountryMatchRow { label })
      .collect();
    Ok(Self { slice, rows })
  }

  pub(crate) fn label(&self, pattern: u32) -> Option<&str> {
    self
      .slice
      .local_index(pattern)
      .and_then(|index| self.rows.get(index))
      .map(|row| row.label.as_str())
  }
}

fn pattern_at(
  slice: PatternSlice,
  index: usize,
  field: &'static str,
) -> Result<u32> {
  let index = u32::try_from(index).map_err(|_| Error::InvalidStaticData {
    field,
    reason: "metadata index exceeds u32 range".to_owned(),
  })?;
  slice
    .start
    .checked_add(index)
    .ok_or_else(|| Error::InvalidStaticData {
      field,
      reason: "pattern index exceeds u32 range".to_owned(),
    })
}

fn validate_length(
  field: &'static str,
  slice: PatternSlice,
  actual: usize,
) -> Result<()> {
  let expected = usize::try_from(slice.len()).map_err(|_| {
    Error::StaticDataLengthMismatch {
      field,
      expected: usize::MAX,
      actual,
    }
  })?;
  if actual == expected {
    return Ok(());
  }
  Err(Error::StaticDataLengthMismatch {
    field,
    expected,
    actual,
  })
}

fn is_supported_validator(id: &str) -> bool {
  crate::validators::supports_id(id)
}

#[cfg(test)]
mod tests {
  use proptest::prelude::*;

  use super::*;
  use crate::processors::{
    CountryVariant, process_prepared_country_matches,
    process_prepared_gazetteer_matches, process_prepared_regex_matches,
  };
  use crate::types::SearchMatch;

  proptest! {
    #[test]
    fn regex_preparation_accepts_only_complete_validator_states(
      requires_validation in any::<bool>(),
      has_validator in any::<bool>(),
      has_input in any::<bool>(),
    ) {
      let data = RegexMatchMeta {
        label: "identifier".to_owned(),
        score: 0.9,
        source_detail: None,
        requires_validation,
        validator_id: has_validator.then(|| "phone.nanp".to_owned()),
        validator_input: has_input.then(|| "digits-only".to_owned()),
        min_byte_length: None,
      };
      let result = PreparedRegexMatchData::new(
        vec![data],
        PatternSlice { start: 9, end: 10 },
        "regex_meta",
      );
      prop_assert_eq!(
        result.is_ok(),
        has_validator || (!requires_validation && !has_input),
      );
    }

    #[test]
    fn gazetteer_preparation_accepts_only_aligned_rows(
      labels in prop::collection::vec("[a-z]{1,8}", 0..12),
      flags in prop::collection::vec(any::<bool>(), 0..12),
    ) {
      let expected = labels.len();
      let data = GazetteerMatchData { labels, is_fuzzy: flags.clone() };
      let slice = PatternSlice {
        start: 4,
        end: 4_u32.saturating_add(u32::try_from(expected).unwrap_or(u32::MAX)),
      };
      let result = PreparedGazetteerMatchData::new(data, slice);
      prop_assert_eq!(result.is_ok(), flags.len() == expected);
    }

    #[test]
    fn country_preparation_accepts_only_aligned_rows(
      labels in prop::collection::vec("[a-z]{1,8}", 0..12),
      iso_codes in prop::collection::vec("[A-Z]{2}", 0..12),
      variants in prop::collection::vec(
        prop_oneof![
          Just(CountryVariant::Name),
          Just(CountryVariant::Alias),
          Just(CountryVariant::Alpha3),
          Just(CountryVariant::Alpha2),
        ],
        0..12,
      ),
    ) {
      let expected = labels.len();
      let data = CountryMatchData { labels, iso_codes: iso_codes.clone(), variants: variants.clone() };
      let slice = PatternSlice {
        start: 2,
        end: 2_u32.saturating_add(u32::try_from(expected).unwrap_or(u32::MAX)),
      };
      let result = PreparedCountryMatchData::new(data, slice);
      prop_assert_eq!(result.is_ok(), iso_codes.len() == expected && variants.len() == expected);
    }

    #[test]
    fn regex_prepared_processing_matches_row_reference(
      slice_start in 1_u32..100,
      rows in prop::collection::vec(("[a-z]{1,8}", 0_u8..5, any::<bool>()), 0..12),
    ) {
      let slice = PatternSlice {
        start: slice_start,
        end: slice_start.saturating_add(u32::try_from(rows.len()).unwrap_or(u32::MAX)),
      };
      let mut full_text = String::new();
      let mut matches = Vec::with_capacity(rows.len());
      let mut metadata = Vec::with_capacity(rows.len());
      let mut expected = Vec::new();

      for (index, (label, case, custom_source)) in rows.into_iter().enumerate() {
        if !full_text.is_empty() {
          full_text.push('|');
        }
        let value = match case {
          2 => "(212) 555-0142",
          3 => "012-555-0142",
          4 => "401 023 2137",
          _ => "plain",
        };
        let start = u32::try_from(full_text.len()).unwrap_or(u32::MAX);
        full_text.push_str(value);
        let end = u32::try_from(full_text.len()).unwrap_or(u32::MAX);
        let pattern = slice_start
          .saturating_add(u32::try_from(index).unwrap_or(u32::MAX));
        matches.push(SearchMatch::Regex { pattern, start, end });

        let score = f64::from(u32::try_from(index).unwrap_or(u32::MAX)) / 100.0;
        let source_detail = custom_source.then_some(SourceDetail::CustomRegex);
        let (requires_validation, validator_id, validator_input, min_byte_length, accepted) =
          match case {
            1 => (false, None, None, Some(end.saturating_sub(start).saturating_add(1)), false),
            2 => (true, Some("phone.nanp".to_owned()), None, None, true),
            3 => (true, Some("phone.nanp".to_owned()), None, None, false),
            4 => (
              true,
              Some("gb.nhs".to_owned()),
              Some("digits-only".to_owned()),
              None,
              true,
            ),
            _ => (false, None, None, None, true),
          };
        metadata.push(RegexMatchMeta {
          label: label.clone(),
          score,
          source_detail,
          requires_validation,
          validator_id,
          validator_input,
          min_byte_length,
        });
        if accepted {
          expected.push((label, value.to_owned(), score, source_detail));
        }
      }

      let prepared = PreparedRegexMatchData::new(metadata, slice, "regex_meta");
      prop_assert!(prepared.is_ok());
      let actual = prepared
        .as_ref()
        .map_err(|error| TestCaseError::fail(error.to_string()))
        .and_then(|prepared| {
          process_prepared_regex_matches(&matches, &full_text, prepared)
            .map_err(|error| TestCaseError::fail(error.to_string()))
        })?;
      let actual = actual
        .into_iter()
        .map(|entity| (entity.label, entity.text, entity.score, entity.source_detail))
        .collect::<Vec<_>>();
      prop_assert_eq!(actual, expected);
    }

    #[test]
    fn gazetteer_prepared_processing_matches_two_pass_reference(
      slice_start in 1_u32..100,
      rows in prop::collection::vec(("[a-z]{1,8}", any::<bool>(), 0_u32..3), 0..12),
    ) {
      let slice = PatternSlice {
        start: slice_start,
        end: slice_start.saturating_add(u32::try_from(rows.len()).unwrap_or(u32::MAX)),
      };
      let has_exact = rows.iter().any(|(_, is_fuzzy, _)| !is_fuzzy);
      let mut matches = Vec::with_capacity(rows.len());
      let mut labels = Vec::with_capacity(rows.len());
      let mut is_fuzzy = Vec::with_capacity(rows.len());
      let mut expected = rows
        .iter()
        .filter(|(_, fuzzy, _)| !fuzzy)
        .map(|(label, _, _)| label.clone())
        .collect::<Vec<_>>();

      for (index, (label, fuzzy, distance)) in rows.into_iter().enumerate() {
        let pattern = slice_start
          .saturating_add(u32::try_from(index).unwrap_or(u32::MAX));
        matches.push(if fuzzy {
          SearchMatch::Fuzzy {
            pattern,
            start: 0,
            end: 4,
            distance,
          }
        } else {
          SearchMatch::Literal {
            pattern,
            start: 0,
            end: 4,
          }
        });
        if fuzzy && distance > 0 && !has_exact {
          expected.push(label.clone());
        }
        labels.push(label);
        is_fuzzy.push(fuzzy);
      }

      let prepared = PreparedGazetteerMatchData::new(
        GazetteerMatchData { labels, is_fuzzy },
        slice,
      );
      prop_assert!(prepared.is_ok());
      let actual = prepared
        .as_ref()
        .map_err(|error| TestCaseError::fail(error.to_string()))
        .and_then(|prepared| {
          process_prepared_gazetteer_matches(&matches, "Acme", prepared)
            .map_err(|error| TestCaseError::fail(error.to_string()))
        })?
        .into_iter()
        .map(|entity| entity.label)
        .collect::<Vec<_>>();
      prop_assert_eq!(actual, expected);
    }

    #[test]
    fn country_prepared_processing_preserves_label_rows(
      slice_start in 1_u32..100,
      labels in prop::collection::vec("[a-z]{1,8}", 0..12),
    ) {
      let slice = PatternSlice {
        start: slice_start,
        end: slice_start.saturating_add(u32::try_from(labels.len()).unwrap_or(u32::MAX)),
      };
      let matches = labels
        .iter()
        .enumerate()
        .map(|(index, _)| SearchMatch::Literal {
          pattern: slice_start
            .saturating_add(u32::try_from(index).unwrap_or(u32::MAX)),
          start: 0,
          end: 5,
        })
        .collect::<Vec<_>>();
      let data = CountryMatchData {
        iso_codes: labels.iter().map(|_| "ZZ".to_owned()).collect(),
        variants: labels.iter().map(|_| CountryVariant::Name).collect(),
        labels: labels.clone(),
      };
      let prepared = PreparedCountryMatchData::new(data, slice);
      prop_assert!(prepared.is_ok());
      let actual = prepared
        .as_ref()
        .map_err(|error| TestCaseError::fail(error.to_string()))
        .and_then(|prepared| {
          process_prepared_country_matches(&matches, "Alpha", prepared)
            .map_err(|error| TestCaseError::fail(error.to_string()))
        })?
        .into_iter()
        .map(|entity| entity.label)
        .collect::<Vec<_>>();
      prop_assert_eq!(actual, labels);
    }
  }

  #[test]
  fn regex_validation_state_is_resolved_during_preparation() {
    let invalid = RegexMatchMeta {
      label: "identifier".to_owned(),
      score: 0.9,
      source_detail: None,
      requires_validation: true,
      validator_id: None,
      validator_input: None,
      min_byte_length: None,
    };
    assert!(matches!(
      PreparedRegexMatchData::new(
        vec![invalid],
        PatternSlice { start: 7, end: 8 },
        "regex_meta",
      ),
      Err(Error::UnsupportedRegexValidation { pattern: 7 })
    ));
  }
}
