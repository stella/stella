use crate::processors::{
  DenyListMatchData, PatternSlice, ensure_supported_deny_list_sources,
};
use crate::signatures::decode_party_role_name_evidence;
use crate::types::{Error, Result};

use super::{
  PreparedEngineArtifactsView, PreparedEngineConfig, PreparedEngineSlices,
};

pub(super) fn validate_supported_config(
  config: &PreparedEngineConfig,
  allow_literal_artifacts: bool,
) -> Result<()> {
  validate_search_config(config, allow_literal_artifacts)?;
  validate_legal_form_config(config)?;
  validate_trigger_config(config)?;
  validate_deny_list_config(config)?;
  validate_gazetteer_config(config)?;
  validate_country_config(config)?;
  validate_hotword_config(config)?;
  validate_address_seed_config(config)?;
  validate_signature_config(config)
}

fn validate_signature_config(config: &PreparedEngineConfig) -> Result<()> {
  let Some(data) = config.detectors.signature_data.as_ref() else {
    return Ok(());
  };
  decode_party_role_name_evidence(&data.party_role_name_evidence).map_err(
    |reason| Error::InvalidStaticData {
      field: "signature_data.party_role_name_evidence",
      reason,
    },
  )?;
  Ok(())
}

pub(super) fn validate_supported_config_for_artifacts(
  config: &PreparedEngineConfig,
  artifacts: Option<&PreparedEngineArtifactsView<'_>>,
) -> Result<()> {
  let allow_literal_artifacts =
    artifacts.is_some_and(|artifacts| !artifacts.literals.slots.is_empty());
  validate_supported_config(config, allow_literal_artifacts)
}

fn validate_search_config(
  config: &PreparedEngineConfig,
  allow_literal_artifacts: bool,
) -> Result<()> {
  validate_slice_bounds(
    "slices.regex",
    config.search.slices.regex,
    config.search.regex_patterns.len(),
  )?;
  validate_slice_bounds(
    "slices.legal_forms",
    config.search.slices.legal_forms,
    config.search.regex_patterns.len(),
  )?;
  validate_slice_bounds(
    "slices.triggers",
    config.search.slices.triggers,
    config.search.regex_patterns.len(),
  )?;
  validate_slice_bounds(
    "slices.custom_regex",
    config.search.slices.custom_regex,
    config.search.custom_regex_patterns.len(),
  )?;
  validate_literal_slices(
    &config.search.slices,
    config.search.literal_patterns.len(),
    allow_literal_artifacts,
  )?;
  validate_static_data_length(
    "regex_meta",
    config.search.slices.regex,
    config.search.regex_meta.len(),
  )?;
  validate_static_data_length(
    "custom_regex_meta",
    config.search.slices.custom_regex,
    config.search.custom_regex_meta.len(),
  )
}

fn validate_literal_slices(
  slices: &PreparedEngineSlices,
  literal_count: usize,
  allow_literal_artifacts: bool,
) -> Result<()> {
  if allow_literal_artifacts && literal_count == 0 {
    return Ok(());
  }
  validate_slice_bounds("slices.deny_list", slices.deny_list, literal_count)?;
  validate_slice_bounds(
    "slices.street_types",
    slices.street_types,
    literal_count,
  )?;
  validate_slice_bounds("slices.gazetteer", slices.gazetteer, literal_count)?;
  validate_slice_bounds("slices.countries", slices.countries, literal_count)?;
  validate_slice_bounds("slices.hotwords", slices.hotwords, literal_count)
}

fn validate_slice_bounds(
  field: &'static str,
  slice: PatternSlice,
  pattern_count: usize,
) -> Result<()> {
  if slice.start > slice.end {
    return Err(Error::InvalidStaticData {
      field,
      reason: "slice start exceeds slice end".to_owned(),
    });
  }
  let Some(end) = usize::try_from(slice.end).ok() else {
    return Err(Error::InvalidStaticData {
      field,
      reason: "slice end exceeds usize range".to_owned(),
    });
  };
  if end <= pattern_count {
    return Ok(());
  }
  Err(Error::InvalidStaticData {
    field,
    reason: format!("slice end {end} exceeds pattern count {pattern_count}"),
  })
}

fn validate_legal_form_config(config: &PreparedEngineConfig) -> Result<()> {
  if config.search.slices.legal_forms.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.detectors.legal_form_data else {
    return Err(Error::MissingStaticData {
      field: "legal_form_data",
    });
  };

  validate_static_data_length(
    "legal_form_data.suffixes",
    config.search.slices.legal_forms,
    data.suffixes.len(),
  )
}

fn validate_deny_list_config(config: &PreparedEngineConfig) -> Result<()> {
  if config.search.slices.deny_list.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.detectors.deny_list_data else {
    return Err(Error::UnsupportedStaticSlice { slice: "deny_list" });
  };

  data.labels.validate("deny_list.labels")?;
  data.custom_labels.validate("deny_list.custom_labels")?;
  data.sources.validate("deny_list.sources")?;
  validate_static_data_length(
    "deny_list.labels",
    config.search.slices.deny_list,
    data.labels.len(),
  )?;
  validate_static_data_length(
    "deny_list.custom_labels",
    config.search.slices.deny_list,
    data.custom_labels.len(),
  )?;
  validate_deny_list_pattern_metadata(config.search.slices.deny_list, data)?;
  validate_static_data_length(
    "deny_list.sources",
    config.search.slices.deny_list,
    data.sources.len(),
  )?;
  ensure_supported_deny_list_sources(data)
}

fn validate_deny_list_pattern_metadata(
  slice: PatternSlice,
  data: &DenyListMatchData,
) -> Result<()> {
  if !data.originals.is_empty() {
    return validate_static_data_length(
      "deny_list.originals",
      slice,
      data.originals.len(),
    );
  }
  validate_static_data_length(
    "deny_list.pattern_meta",
    slice,
    data.pattern_meta.len(),
  )
}

fn validate_gazetteer_config(config: &PreparedEngineConfig) -> Result<()> {
  if config.search.slices.gazetteer.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.detectors.gazetteer_data else {
    return Err(Error::MissingStaticData {
      field: "gazetteer_data",
    });
  };

  validate_static_data_length(
    "gazetteer_data.labels",
    config.search.slices.gazetteer,
    data.labels.len(),
  )?;
  validate_static_data_length(
    "gazetteer_data.is_fuzzy",
    config.search.slices.gazetteer,
    data.is_fuzzy.len(),
  )
}

fn validate_country_config(config: &PreparedEngineConfig) -> Result<()> {
  if config.search.slices.countries.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.detectors.country_data else {
    return Err(Error::MissingStaticData {
      field: "country_data",
    });
  };

  validate_static_data_length(
    "country_data.labels",
    config.search.slices.countries,
    data.labels.len(),
  )?;
  validate_static_data_length(
    "country_data.isoCodes",
    config.search.slices.countries,
    data.iso_codes.len(),
  )?;
  validate_static_data_length(
    "country_data.variants",
    config.search.slices.countries,
    data.variants.len(),
  )
}

fn validate_hotword_config(config: &PreparedEngineConfig) -> Result<()> {
  if !config.search.slices.hotwords.is_empty() {
    return Err(Error::UnsupportedStaticSlice { slice: "hotwords" });
  }

  let Some(data) = &config.detectors.hotword_data else {
    return Ok(());
  };

  for rule in &data.rules {
    if rule.hotwords.is_empty() {
      return Err(Error::InvalidStaticData {
        field: "hotword_data.rules.hotwords",
        reason: String::from("native hotword rules require hotword strings"),
      });
    }
    for hotword in &rule.hotwords {
      if hotword.is_empty() {
        return Err(Error::InvalidStaticData {
          field: "hotword_data.rules.hotwords",
          reason: String::from("hotword must not be empty"),
        });
      }
    }
  }

  Ok(())
}

const fn validate_address_seed_config(
  config: &PreparedEngineConfig,
) -> Result<()> {
  if config.search.slices.street_types.is_empty() {
    return Ok(());
  }

  if config.detectors.address_seed_data.is_some() {
    return Ok(());
  }

  Err(Error::MissingStaticData {
    field: "address_seed_data",
  })
}

fn validate_trigger_config(config: &PreparedEngineConfig) -> Result<()> {
  if config.search.slices.triggers.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.detectors.trigger_data else {
    return Err(Error::MissingStaticData {
      field: "trigger_data",
    });
  };

  validate_static_data_length(
    "trigger_data.rules",
    config.search.slices.triggers,
    data.rules.len(),
  )
}

fn validate_static_data_length(
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
