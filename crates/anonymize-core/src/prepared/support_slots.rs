use web_time::Instant;

use crate::address_context::{AddressContextData, PreparedAddressContextData};
use crate::address_seeds::{AddressSeedData, PreparedAddressSeedData};
use crate::coreference::{CoreferenceData, PreparedCoreferenceData};
use crate::hotwords::{HotwordRuleData, PreparedHotwordData};
use crate::legal_forms::{LegalFormData, PreparedLegalFormData};
use crate::name_corpus::{
  NameCorpusData, PreparedNameCorpusData as PreparedNames,
};
use crate::signatures::{PreparedSignatureData, SignatureData};
use crate::triggers::{PreparedTriggerData, TriggerData};
use crate::types::{Error, Result};
use crate::zones::{PreparedZoneData, ZoneData};

use super::timing::elapsed_us;

pub(super) struct TimedSupportData<T> {
  pub(super) data: T,
  pub(super) len: usize,
  pub(super) elapsed_us: u64,
}

pub(super) fn prepare_timed_hotword_data(
  data: Option<HotwordRuleData>,
) -> Result<TimedSupportData<Option<PreparedHotwordData>>> {
  let len = hotword_data_len(data.as_ref());
  let start = Instant::now();
  let data = prepare_hotword_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

pub(super) fn prepare_timed_trigger_data(
  data: Option<TriggerData>,
) -> Result<TimedSupportData<Option<PreparedTriggerData>>> {
  let len = trigger_data_len(data.as_ref());
  let start = Instant::now();
  let data = prepare_trigger_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

pub(super) fn prepare_timed_legal_form_data(
  data: Option<LegalFormData>,
  soft_wrap_boundary_labels: Vec<String>,
) -> TimedSupportData<Option<PreparedLegalFormData>> {
  let len = legal_form_data_len(data.as_ref());
  let start = Instant::now();
  let data = data.map(|data| {
    PreparedLegalFormData::new_with_soft_wrap_boundary_labels(
      data,
      soft_wrap_boundary_labels,
    )
  });
  TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  }
}

pub(super) fn prepare_timed_address_seed_data(
  data: Option<AddressSeedData>,
  state_abbreviations: Vec<String>,
) -> Result<TimedSupportData<Option<PreparedAddressSeedData>>> {
  let len = address_seed_data_len(data.as_ref());
  let start = Instant::now();
  let data = prepare_address_seed_data(data, state_abbreviations)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

pub(super) fn prepare_timed_zone_data(
  data: Option<&ZoneData>,
) -> Result<TimedSupportData<Option<PreparedZoneData>>> {
  let len = zone_data_len(data);
  let start = Instant::now();
  let data = prepare_zone_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

pub(super) fn prepare_timed_address_context_data(
  data: Option<AddressContextData>,
) -> Result<TimedSupportData<Option<PreparedAddressContextData>>> {
  let len = address_context_data_len(data.as_ref());
  let start = Instant::now();
  let data = prepare_address_context_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

pub(super) fn prepare_timed_coreference_data(
  data: Option<CoreferenceData>,
) -> Result<TimedSupportData<Option<PreparedCoreferenceData>>> {
  let len = coreference_data_len(data.as_ref());
  let start = Instant::now();
  let data = prepare_coreference_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

pub(super) fn prepare_timed_name_corpus_data(
  data: Option<NameCorpusData>,
) -> TimedSupportData<Option<PreparedNames>> {
  let len = name_corpus_data_len(data.as_ref());
  let start = Instant::now();
  let data = data.map(PreparedNames::new);
  TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  }
}

pub(super) fn prepare_timed_signature_data(
  data: Option<SignatureData>,
  party_role_labels: Vec<String>,
) -> Result<TimedSupportData<Option<PreparedSignatureData>>> {
  let len = signature_data_len(data.as_ref());
  let start = Instant::now();
  let data = data
    .map(|data| PreparedSignatureData::new(data, party_role_labels))
    .transpose()?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

pub(super) fn join_support_data<T>(
  handle: crate::exec::JoinHandle<'_, Result<TimedSupportData<T>>>,
  field: &'static str,
) -> Result<TimedSupportData<T>> {
  handle.join().map_err(|_| Error::InvalidStaticData {
    field,
    reason: "support data builder panicked".to_owned(),
  })?
}

fn hotword_data_len(data: Option<&HotwordRuleData>) -> usize {
  data.map_or(0, |data| data.rules.len())
}

fn trigger_data_len(data: Option<&TriggerData>) -> usize {
  data.map_or(0, |data| data.rules.len())
}

fn legal_form_data_len(data: Option<&LegalFormData>) -> usize {
  data.map_or(0, |data| {
    [
      data.suffixes.len(),
      data.normalized_boundary_suffixes.len(),
      data.normalized_in_name_words.len(),
      data.normalized_suffix_words.len(),
      data.role_heads.len(),
      data.sentence_verb_indicators.len(),
      data.clause_noun_heads.len(),
      data.connector_prose_heads.len(),
      data.structural_single_cap_prefixes.len(),
      data.leading_clause_phrases.len(),
      data.leading_clause_direct_prefixes.len(),
      data.connector_words.len(),
      data.and_connector_words.len(),
      data.in_name_prepositions.len(),
      data.company_suffix_words.len(),
      data.comma_gated_direct_prefixes.len(),
      data.institutional_heads.len(),
      data.institutional_complement_heads.len(),
      data.institutional_complement_starters.len(),
      data.institutional_complement_connectors.len(),
      data.institutional_generic_words.len(),
      data.institutional_prefix_generic_words.len(),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add)
  })
}

fn address_seed_data_len(data: Option<&AddressSeedData>) -> usize {
  data.map_or(0, |data| {
    data
      .boundary_words
      .len()
      .saturating_add(data.br_cep_cue_words.len())
      .saturating_add(data.unit_abbreviations.len())
      .saturating_add(data.directional_abbreviations.len())
  })
}

fn zone_data_len(data: Option<&ZoneData>) -> usize {
  data.map_or(0, |data| {
    data
      .section_heading_patterns
      .len()
      .saturating_add(data.signing_clauses.len())
  })
}

fn address_context_data_len(data: Option<&AddressContextData>) -> usize {
  data.map_or(0, |data| {
    data
      .address_prepositions
      .len()
      .saturating_add(data.temporal_prepositions.len())
      .saturating_add(data.street_abbreviations.len())
      .saturating_add(data.bare_house_stopwords.len())
  })
}

fn coreference_data_len(data: Option<&CoreferenceData>) -> usize {
  data.map_or(0, |data| {
    data
      .definition_patterns
      .len()
      .saturating_add(data.role_stop_terms.len())
      .saturating_add(data.legal_form_aliases.len())
      .saturating_add(data.organization_suffixes.len())
      .saturating_add(data.organization_determiners.len())
  })
}

fn name_corpus_data_len(data: Option<&NameCorpusData>) -> usize {
  data.map_or(0, |data| {
    [
      data.first_names.len(),
      data.surnames.len(),
      data.title_tokens.len(),
      data.title_abbreviations.len(),
      data.excluded_words.len(),
      data.common_words.len(),
      data.non_western_names.len(),
      data.excluded_all_caps.len(),
      data.ja_suffixes.len(),
      data.arabic_connectors.len(),
      data.relation_connectors.len(),
      data.hyphenated_prefixes.len(),
      data.cjk_non_person_terms.len(),
      data.cjk_surname_starters.len(),
      data.organization_terms.len(),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add)
  })
}

fn signature_data_len(data: Option<&SignatureData>) -> usize {
  data.map_or(0, |data| {
    [
      data.labels.len(),
      data.person_value_labels.len(),
      data.person_list_labels.len(),
      data.party_role_name_evidence.len(),
      data.witness_phrases.len(),
      data.name_particles.len(),
      data.post_nominal_suffixes.len(),
      data.organization_suffixes.len(),
      data.form_field_labels.len(),
      data.contact_field_labels.len(),
      data.signature_stamp_phrases.len(),
      data.image_stub_prefixes.len(),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add)
  })
}

fn prepare_address_seed_data(
  data: Option<AddressSeedData>,
  state_abbreviations: Vec<String>,
) -> Result<Option<PreparedAddressSeedData>> {
  data
    .map(|data| {
      PreparedAddressSeedData::new_with_state_abbreviations(
        data,
        state_abbreviations,
      )
    })
    .transpose()
}

fn prepare_hotword_data(
  data: Option<HotwordRuleData>,
) -> Result<Option<PreparedHotwordData>> {
  data.map(PreparedHotwordData::new).transpose()
}

fn prepare_trigger_data(
  data: Option<TriggerData>,
) -> Result<Option<PreparedTriggerData>> {
  data.map(PreparedTriggerData::new).transpose()
}

fn prepare_address_context_data(
  data: Option<AddressContextData>,
) -> Result<Option<PreparedAddressContextData>> {
  data.map(PreparedAddressContextData::new).transpose()
}

fn prepare_zone_data(
  data: Option<&ZoneData>,
) -> Result<Option<PreparedZoneData>> {
  data.map(PreparedZoneData::new).transpose()
}

fn prepare_coreference_data(
  data: Option<CoreferenceData>,
) -> Result<Option<PreparedCoreferenceData>> {
  data.map(PreparedCoreferenceData::new).transpose()
}
