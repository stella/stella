use crate::address_context::PreparedAddressContextData;
use crate::address_seeds::PreparedAddressSeedData;
use crate::anchored::PreparedAnchoredSearch;
use crate::coreference::PreparedCoreferenceData;
use crate::dates::PreparedDateData;
use crate::hotwords::PreparedHotwordData;
use crate::legal_forms::PreparedLegalFormData;
use crate::money::PreparedMonetaryData;
use crate::name_corpus::PreparedNameCorpusData as PreparedNames;
use crate::prepared_metadata::{
  PreparedCountryMatchData, PreparedGazetteerMatchData, PreparedRegexMatchData,
};
use crate::processors::{DenyListFilterData, DenyListMatchData};
use crate::search::SearchIndex;
use crate::signatures::PreparedSignatureData;
use crate::triggers::PreparedTriggerData;
use crate::zones::PreparedZoneData;
use crate::{PipelineEntity, Result};

use super::PreparedEngineSlices;

pub(super) struct SearchIndexes {
  pub(super) regex: SearchIndex,
  pub(super) custom_regex: SearchIndex,
  pub(super) legal_forms: SearchIndex,
  pub(super) triggers: SearchIndex,
  pub(super) literals: SearchIndex,
}

pub(super) struct PipelinePolicy {
  pub(super) allowed_labels: Vec<String>,
  pub(super) threshold: f64,
  pub(super) confidence_boost: bool,
  pub(super) slices: PreparedEngineSlices,
  pub(super) regex_meta: PreparedRegexMatchData,
  pub(super) custom_regex_meta: PreparedRegexMatchData,
}

pub(super) struct PreparedStaticData {
  pub(super) deny_list: Option<DenyListMatchData>,
  pub(super) false_positive_filters: Option<DenyListFilterData>,
  pub(super) gazetteer: Option<PreparedGazetteerMatchData>,
  pub(super) countries: Option<PreparedCountryMatchData>,
  pub(super) hotwords: Option<PreparedHotwordData>,
  pub(super) triggers: Option<PreparedTriggerData>,
  pub(super) legal_forms: Option<PreparedLegalFormData>,
  pub(super) address_seed: Option<PreparedAddressSeedData>,
  pub(super) zones: Option<PreparedZoneData>,
  pub(super) address_context: Option<PreparedAddressContextData>,
  pub(super) coreference: Option<PreparedCoreferenceData>,
  pub(super) name_corpus: Option<PreparedNames>,
  pub(super) signatures: Option<PreparedSignatureData>,
  pub(super) anchored: PreparedAnchoredData,
}

impl PreparedStaticData {
  pub(super) fn effective_false_positive_filters(
    &self,
  ) -> Option<&DenyListFilterData> {
    self.false_positive_filters.as_ref().or_else(|| {
      self
        .deny_list
        .as_ref()
        .and_then(|data| data.filters.as_ref())
    })
  }
}

pub(super) struct PreparedAnchoredData {
  search: Option<PreparedAnchoredSearch>,
  dates: Option<PreparedDateData>,
  monetary: Option<PreparedMonetaryData>,
}

impl PreparedAnchoredData {
  pub(super) fn new(
    dates: Option<PreparedDateData>,
    monetary: Option<PreparedMonetaryData>,
    monetary_extraction: bool,
  ) -> Result<Self> {
    let date_terms = dates
      .as_ref()
      .map_or_else(Vec::new, PreparedDateData::anchor_terms);
    let monetary_terms = if monetary_extraction {
      monetary
        .as_ref()
        .map_or_else(Vec::new, PreparedMonetaryData::anchor_terms)
    } else {
      Vec::new()
    };
    Ok(Self {
      search: PreparedAnchoredSearch::new(date_terms, monetary_terms)?,
      dates,
      monetary,
    })
  }

  pub(super) const fn is_active(&self) -> bool {
    self.search.is_some()
  }

  pub(super) fn detect(&self, full_text: &str) -> Result<Vec<PipelineEntity>> {
    let Some(search) = &self.search else {
      return Ok(Vec::new());
    };
    let document = search.scan(full_text)?;
    let mut entities = Vec::new();
    if let Some(dates) = &self.dates {
      entities.extend(dates.process(full_text, document.date_anchors())?);
    }
    if let Some(monetary) = &self.monetary
      && !document.monetary_anchors().is_empty()
    {
      entities
        .extend(monetary.process(full_text, document.monetary_anchors())?);
    }
    Ok(entities)
  }

  pub(super) fn extend_monetary_entities(
    &self,
    full_text: &str,
    entities: Vec<PipelineEntity>,
  ) -> Vec<PipelineEntity> {
    match &self.monetary {
      Some(monetary) => monetary.extend_entities(full_text, entities),
      None => entities,
    }
  }
}
