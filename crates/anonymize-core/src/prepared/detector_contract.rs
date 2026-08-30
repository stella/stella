use std::collections::BTreeSet;

use crate::address_seeds::{
  AddressSeedDetection, AddressSeedProcessArgs, PreparedAddressSeedData,
};
use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::labels::{
  ADDRESS_LABEL, CREDIT_CARD_NUMBER_LABEL, IDENTITY_CARD_NUMBER_LABEL,
  PASSPORT_NUMBER_LABEL,
};
use crate::legal_forms::PreparedLegalFormData;
use crate::legal_forms::process_legal_form_matches;
use crate::name_corpus::{NameCorpusDetection, PreparedNameCorpusData};
use crate::prepared_metadata::{
  PreparedCountryMatchData, PreparedGazetteerMatchData, PreparedRegexMatchData,
};
use crate::processors::{
  DenyListFilterData, DenyListMatchData, PatternSlice,
  process_deny_list_matches_with_field_labels, process_prepared_country_matches,
  process_prepared_gazetteer_matches, process_prepared_regex_matches,
};
use crate::resolution::{PipelineEntity, ResolutionDocument};
use crate::signatures::{
  DetectSignaturesArgs, PreparedSignatureData, detect_signatures,
};
use crate::triggers::{
  PreparedTriggerData, ProcessTriggerMatchesArgs, process_trigger_matches,
};
use crate::types::{Error, Result, SearchMatch};

use super::PreparedEngine;
use super::prepared_document::PreparedDocument;
use super::results::PreparedEngineMatches;
use super::rule_contract::{RulePack, RuleSpec};
use super::support_resources::SupportResourceId;
use super::timing::{StaticEntityPasses, TimedEntities};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StaticDetectorId {
  Regex,
  CustomRegex,
  DenyList,
  Gazetteer,
  Country,
  Anchored,
  Trigger,
  Signature,
  LegalForm,
  NameCorpus,
  AddressSeed,
  StructuredDocumentData,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StaticDetectorInput {
  FullText,
  RegexMatches,
  CustomRegexMatches,
  LiteralMatches,
  RegexMeta,
  CustomRegexMeta,
  DenyListData,
  GazetteerData,
  CountryData,
  DateData,
  MonetaryData,
  TriggerData,
  FirstNames,
  TitleTokens,
  FalsePositiveFilters,
  SignatureData,
  LegalFormData,
  NameCorpusData,
  AddressSeedData,
  ContextEntities,
  DenyListEntities,
}

impl StaticDetectorInput {
  const fn is_growing(self) -> bool {
    matches!(
      self,
      Self::FullText
        | Self::RegexMatches
        | Self::CustomRegexMatches
        | Self::LiteralMatches
        | Self::ContextEntities
        | Self::DenyListEntities
    )
  }
}

pub(super) type StaticDetectorSpec = RuleSpec<
  StaticDetectorId,
  StaticDetectorInput,
  SupportResourceId,
  DiagnosticStage,
>;

impl StaticDetectorSpec {
  pub(super) const fn diagnostic_stage(self) -> DiagnosticStage {
    self.stage()
  }

  pub(super) fn complexity_covers_growing_inputs(self) -> bool {
    let growing_inputs = self
      .declared_inputs()
      .iter()
      .copied()
      .filter(|input| input.is_growing());
    let domains = self.additive_scaling_domains();
    growing_inputs.clone().all(|input| {
      domains.iter().filter(|domain| **domain == input).count() == 1
    }) && domains.iter().all(|domain| {
      domain.is_growing()
        && self.declared_inputs().contains(domain)
        && domains
          .iter()
          .filter(|candidate| *candidate == domain)
          .count()
          == 1
    })
  }

  pub(super) fn validate_complexity(self) -> Result<()> {
    if self.complexity_covers_growing_inputs() {
      return Ok(());
    }
    Err(Error::InvalidStaticData {
      field: "detector complexity contract",
      reason: format!(
        "detector {:?} must declare each growing input exactly once as an additive scaling domain",
        self.id(),
      ),
    })
  }

  pub(super) fn has_declared_inputs(self) -> bool {
    !self.declared_inputs().is_empty()
      || self
        .support_resources()
        .iter()
        .any(|resource| resource.spec().detector_input().is_some())
  }

  pub(super) fn declares_input(self, input: StaticDetectorInput) -> bool {
    self.declared_inputs().contains(&input)
      || self
        .support_resources()
        .iter()
        .any(|resource| resource.spec().detector_input() == Some(input))
  }

  pub(super) fn require_input(self, input: StaticDetectorInput) -> Result<()> {
    if self.declares_input(input) {
      return Ok(());
    }
    Err(Error::InvalidStaticData {
      field: "detector rule inputs",
      reason: format!(
        "detector {:?} accessed undeclared input {input:?}",
        self.id(),
      ),
    })
  }

  #[cfg(test)]
  fn require_dependency(self, detector: StaticDetectorId) -> Result<()> {
    if self.dependencies().contains(&detector) {
      return Ok(());
    }
    Err(Error::InvalidStaticData {
      field: "detector rule dependencies",
      reason: format!(
        "detector {:?} accessed undeclared dependency {detector:?}",
        self.id(),
      ),
    })
  }
}

pub(super) struct StaticDetectorContext<'a> {
  spec: StaticDetectorSpec,
  engine: &'a PreparedEngine,
  matches: &'a PreparedEngineMatches,
  document: &'a PreparedDocument<'a>,
}

impl<'a> StaticDetectorContext<'a> {
  pub(super) const fn new(
    spec: &StaticDetectorSpec,
    engine: &'a PreparedEngine,
    matches: &'a PreparedEngineMatches,
    document: &'a PreparedDocument<'a>,
  ) -> Self {
    Self {
      spec: *spec,
      engine,
      matches,
      document,
    }
  }

  pub(super) fn regex_is_active(&self) -> Result<bool> {
    Ok(!self.regex_matches()?.is_empty() && !self.regex_meta()?.is_empty())
  }

  pub(super) fn detect_regex(&self) -> Result<Vec<PipelineEntity>> {
    process_prepared_regex_matches(
      self.regex_matches()?,
      self.full_text()?,
      self.regex_meta()?,
    )
  }

  pub(super) fn custom_regex_is_active(&self) -> Result<bool> {
    Ok(
      !self.custom_regex_matches()?.is_empty()
        && !self.custom_regex_meta()?.is_empty(),
    )
  }

  pub(super) fn detect_custom_regex(&self) -> Result<Vec<PipelineEntity>> {
    process_prepared_regex_matches(
      self.custom_regex_matches()?,
      self.full_text()?,
      self.custom_regex_meta()?,
    )
  }

  pub(super) fn deny_list_is_active(&self) -> Result<bool> {
    Ok(!self.literal_matches()?.is_empty() && self.deny_list_data()?.is_some())
  }

  pub(super) fn detect_deny_list(&self) -> Result<Vec<PipelineEntity>> {
    let Some(data) = self.deny_list_data()? else {
      return Ok(Vec::new());
    };
    process_deny_list_matches_with_field_labels(
      self.literal_matches()?,
      self.deny_list_slice()?,
      self.resolution_document()?,
      data,
      self
        .signature_data()?
        .map_or(&[], PreparedSignatureData::form_field_labels),
    )
  }

  pub(super) fn gazetteer_is_active(&self) -> Result<bool> {
    Ok(!self.literal_matches()?.is_empty() && self.gazetteer_data()?.is_some())
  }

  pub(super) fn detect_gazetteer(&self) -> Result<Vec<PipelineEntity>> {
    let Some(data) = self.gazetteer_data()? else {
      return Ok(Vec::new());
    };
    process_prepared_gazetteer_matches(
      self.literal_matches()?,
      self.full_text()?,
      data,
    )
  }

  pub(super) fn country_is_active(&self) -> Result<bool> {
    Ok(!self.literal_matches()?.is_empty() && self.country_data()?.is_some())
  }

  pub(super) fn detect_country(&self) -> Result<Vec<PipelineEntity>> {
    let Some(data) = self.country_data()? else {
      return Ok(Vec::new());
    };
    process_prepared_country_matches(
      self.literal_matches()?,
      self.full_text()?,
      data,
    )
  }

  pub(super) fn anchored_is_active(&self) -> Result<bool> {
    Ok(self.anchored_data()?.is_active())
  }

  pub(super) fn detect_anchored(&self) -> Result<Vec<PipelineEntity>> {
    self.anchored_data()?.detect(self.full_text()?)
  }

  pub(super) fn trigger_is_active(&self) -> Result<bool> {
    Ok(!self.regex_matches()?.is_empty() && self.trigger_data()?.is_some())
  }

  pub(super) fn detect_trigger(
    &self,
    diagnostics: StaticDetectorDiagnostics<'_>,
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = self.trigger_data()? else {
      return Ok(Vec::new());
    };
    let empty_title_tokens = BTreeSet::new();
    let person_value_labels = self
      .signature_data()?
      .map(PreparedSignatureData::person_value_labels)
      .unwrap_or_default();
    process_trigger_matches(ProcessTriggerMatchesArgs {
      matches: self.regex_matches()?,
      slice: self.triggers_slice()?,
      full_text: self.full_text()?,
      data,
      person_value_labels,
      title_tokens: self.title_tokens()?.unwrap_or(&empty_title_tokens),
      diagnostics,
    })
  }

  pub(super) fn signature_is_active(&self) -> Result<bool> {
    Ok(self.signature_data()?.is_some())
  }

  pub(super) fn detect_signature(&self) -> Result<Vec<PipelineEntity>> {
    let full_text = self.full_text()?;
    let first_names = self.first_names()?;
    let name_corpus = self.name_corpus_data()?;
    Ok(self.signature_data()?.map_or_else(Vec::new, |data| {
      detect_signatures(&DetectSignaturesArgs {
        full_text,
        data,
        first_names,
        name_corpus,
      })
    }))
  }

  pub(super) fn legal_form_is_active(&self) -> Result<bool> {
    Ok(!self.regex_matches()?.is_empty() && self.legal_form_data()?.is_some())
  }

  pub(super) fn detect_legal_form(&self) -> Result<Vec<PipelineEntity>> {
    let Some(data) = self.legal_form_data()? else {
      return Ok(Vec::new());
    };
    process_legal_form_matches(
      self.regex_matches()?,
      self.legal_forms_slice()?,
      self.full_text()?,
      data,
    )
  }

  pub(super) fn name_corpus_is_active(&self) -> Result<bool> {
    Ok(self.name_corpus_data()?.is_some())
  }

  pub(super) fn detect_name_corpus(
    &self,
    dependencies: DetectorDependencies<'_>,
  ) -> Result<NameCorpusDetection> {
    let Some(data) = self.name_corpus_data()? else {
      return Ok(NameCorpusDetection::default());
    };
    data.detect_configured_profiled(
      self.full_text()?,
      dependencies.deny_list_entities()?,
    )
  }

  pub(super) fn address_seed_is_active(&self) -> Result<bool> {
    Ok(
      self.address_seed_data()?.is_some()
        && (self.engine.policy.allowed_labels.is_empty()
          || self
            .engine
            .policy
            .allowed_labels
            .iter()
            .any(|label| label == ADDRESS_LABEL)),
    )
  }

  pub(super) fn structured_document_data_is_active(&self) -> Result<bool> {
    self.spec.require_input(StaticDetectorInput::FullText)?;
    Ok(
      self.engine.policy.allowed_labels.is_empty()
        || self.engine.policy.allowed_labels.iter().any(|label| {
          matches!(
            label.as_str(),
            CREDIT_CARD_NUMBER_LABEL
              | IDENTITY_CARD_NUMBER_LABEL
              | PASSPORT_NUMBER_LABEL
          )
        }),
    )
  }

  pub(super) fn structured_document_data_input(
    &self,
  ) -> Result<(&'a str, &'a [String])> {
    Ok((self.full_text()?, &self.engine.policy.allowed_labels))
  }

  pub(super) fn detect_address_seed(
    &self,
    dependencies: DetectorDependencies<'_>,
  ) -> Result<(AddressSeedDetection, usize)> {
    let Some(data) = self.address_seed_data()? else {
      return Ok((AddressSeedDetection::default(), 0));
    };
    let entities = dependencies.collect_context_entities()?;
    let count = entities.len();
    let detection = data.process_profiled(AddressSeedProcessArgs {
      matches: self.literal_matches()?,
      street_type_slice: self.street_types_slice()?,
      full_text: self.full_text()?,
      existing_entities: &entities,
      false_positive_filters: self.false_positive_filters()?,
    })?;
    Ok((detection, count))
  }

  pub(super) const fn input_bytes(&self) -> usize {
    self.document.len()
  }

  fn full_text(&self) -> Result<&'a str> {
    self.document.text(&self.spec)
  }

  fn resolution_document(&self) -> Result<&ResolutionDocument<'a>> {
    self.spec.require_input(StaticDetectorInput::FullText)?;
    Ok(self.document.resolution())
  }

  fn regex_matches(&self) -> Result<&'a [SearchMatch]> {
    self.require(StaticDetectorInput::RegexMatches)?;
    Ok(&self.matches.regex)
  }

  fn custom_regex_matches(&self) -> Result<&'a [SearchMatch]> {
    self.require(StaticDetectorInput::CustomRegexMatches)?;
    Ok(&self.matches.custom_regex)
  }

  fn literal_matches(&self) -> Result<&'a [SearchMatch]> {
    self.require(StaticDetectorInput::LiteralMatches)?;
    Ok(&self.matches.literal)
  }

  fn regex_meta(&self) -> Result<&'a PreparedRegexMatchData> {
    self.require(StaticDetectorInput::RegexMeta)?;
    Ok(&self.engine.policy.regex_meta)
  }

  fn custom_regex_meta(&self) -> Result<&'a PreparedRegexMatchData> {
    self.require(StaticDetectorInput::CustomRegexMeta)?;
    Ok(&self.engine.policy.custom_regex_meta)
  }

  fn deny_list_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::DenyListData)?;
    Ok(self.engine.policy.slices.deny_list)
  }

  fn triggers_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::TriggerData)?;
    Ok(self.engine.policy.slices.triggers)
  }

  fn legal_forms_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::LegalFormData)?;
    Ok(self.engine.policy.slices.legal_forms)
  }

  fn street_types_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::AddressSeedData)?;
    Ok(self.engine.policy.slices.street_types)
  }

  fn deny_list_data(&self) -> Result<Option<&'a DenyListMatchData>> {
    self.require(StaticDetectorInput::DenyListData)?;
    Ok(self.engine.data.deny_list.as_ref())
  }

  fn gazetteer_data(&self) -> Result<Option<&'a PreparedGazetteerMatchData>> {
    self.require(StaticDetectorInput::GazetteerData)?;
    Ok(self.engine.data.gazetteer.as_ref())
  }

  fn country_data(&self) -> Result<Option<&'a PreparedCountryMatchData>> {
    self.require(StaticDetectorInput::CountryData)?;
    Ok(self.engine.data.countries.as_ref())
  }

  fn anchored_data(
    &self,
  ) -> Result<&'a super::engine_state::PreparedAnchoredData> {
    self.require(StaticDetectorInput::DateData)?;
    self.require(StaticDetectorInput::MonetaryData)?;
    Ok(&self.engine.data.anchored)
  }

  fn trigger_data(&self) -> Result<Option<&'a PreparedTriggerData>> {
    self.require(StaticDetectorInput::TriggerData)?;
    Ok(self.engine.data.triggers.as_ref())
  }

  fn title_tokens(&self) -> Result<Option<&'a BTreeSet<String>>> {
    self.require(StaticDetectorInput::TitleTokens)?;
    Ok(
      self
        .engine
        .data
        .effective_false_positive_filters()
        .map(|filters| &filters.title_tokens),
    )
  }

  fn first_names(&self) -> Result<Option<&'a BTreeSet<String>>> {
    self.require(StaticDetectorInput::FirstNames)?;
    Ok(
      self
        .engine
        .data
        .effective_false_positive_filters()
        .map(|filters| &filters.first_names),
    )
  }

  fn false_positive_filters(
    &self,
  ) -> Result<Option<&'a DenyListFilterData>> {
    self.require(StaticDetectorInput::FalsePositiveFilters)?;
    Ok(self.engine.data.effective_false_positive_filters())
  }

  fn signature_data(&self) -> Result<Option<&'a PreparedSignatureData>> {
    self.require(StaticDetectorInput::SignatureData)?;
    Ok(self.engine.data.signatures.as_ref())
  }

  fn legal_form_data(&self) -> Result<Option<&'a PreparedLegalFormData>> {
    self.require(StaticDetectorInput::LegalFormData)?;
    Ok(self.engine.data.legal_forms.as_ref())
  }

  fn name_corpus_data(&self) -> Result<Option<&'a PreparedNameCorpusData>> {
    self.require(StaticDetectorInput::NameCorpusData)?;
    Ok(self.engine.data.name_corpus.as_ref())
  }

  fn address_seed_data(&self) -> Result<Option<&'a PreparedAddressSeedData>> {
    self.require(StaticDetectorInput::AddressSeedData)?;
    Ok(self.engine.data.address_seed.as_ref())
  }

  fn require(&self, input: StaticDetectorInput) -> Result<()> {
    self.spec.require_input(input)
  }
}

#[derive(Clone, Copy)]
pub(super) struct DetectorDependencies<'a> {
  detector: StaticDetectorId,
  declared_dependencies: &'static [StaticDetectorId],
  declared_inputs: &'static [StaticDetectorInput],
  passes: &'a StaticEntityPasses,
}

impl<'a> DetectorDependencies<'a> {
  const fn new(
    spec: &StaticDetectorSpec,
    passes: &'a StaticEntityPasses,
  ) -> Self {
    Self {
      detector: spec.id(),
      declared_dependencies: spec.dependencies(),
      declared_inputs: spec.declared_inputs(),
      passes,
    }
  }

  fn entities(
    self,
    detector: StaticDetectorId,
    input: StaticDetectorInput,
  ) -> Result<&'a [PipelineEntity]> {
    self.require_input(input)?;
    if !self.declared_dependencies.contains(&detector) {
      return Err(Error::InvalidStaticData {
        field: "detector rule dependencies",
        reason: format!(
          "detector {:?} accessed undeclared dependency {detector:?}",
          self.detector,
        ),
      });
    }
    Ok(self.passes.entities(detector))
  }

  fn deny_list_entities(self) -> Result<&'a [PipelineEntity]> {
    self.entities(
      StaticDetectorId::DenyList,
      StaticDetectorInput::DenyListEntities,
    )
  }

  fn collect_context_entities(self) -> Result<Vec<PipelineEntity>> {
    self.require_input(StaticDetectorInput::ContextEntities)?;
    let dependencies = self.declared_dependencies;
    let capacity = dependencies
      .iter()
      .map(|detector| self.passes.entities(*detector).len())
      .fold(0usize, usize::saturating_add);
    let mut entities = Vec::with_capacity(capacity);
    for detector in dependencies {
      entities.extend(self.passes.entities(*detector).iter().cloned());
    }
    Ok(entities)
  }

  fn require_input(self, input: StaticDetectorInput) -> Result<()> {
    if self.declared_inputs.contains(&input) {
      return Ok(());
    }
    Err(Error::InvalidStaticData {
      field: "detector rule inputs",
      reason: format!(
        "detector {:?} accessed undeclared input {input:?}",
        self.detector,
      ),
    })
  }
}

pub(super) type StaticDetectorDiagnostics<'d> =
  Option<&'d mut StaticRedactionDiagnostics>;

pub(super) type StaticDetectorActiveFn =
  for<'a> fn(&StaticDetectorContext<'a>) -> Result<bool>;

pub(super) type StaticDetectFn = for<'a, 'p, 'd> fn(
  &StaticDetectorContext<'a>,
  DetectorDependencies<'p>,
  StaticDetectorDiagnostics<'d>,
) -> Result<TimedEntities>;

#[derive(Clone, Copy)]
pub(super) struct StaticDetectorRule {
  spec: StaticDetectorSpec,
  is_active: StaticDetectorActiveFn,
  detect: StaticDetectFn,
}

pub(super) type StaticDetectorModule = RulePack<StaticDetectorRule>;

impl StaticDetectorRule {
  pub(super) const fn declare(
    spec: &StaticDetectorSpec,
    is_active: StaticDetectorActiveFn,
    detect: StaticDetectFn,
  ) -> Self {
    Self {
      spec: *spec,
      is_active,
      detect,
    }
  }

  pub(super) const fn spec(self) -> StaticDetectorSpec {
    self.spec
  }

  pub(super) fn is_active(
    self,
    context: &StaticDetectorContext<'_>,
  ) -> Result<bool> {
    (self.is_active)(context)
  }

  pub(super) fn detect(
    self,
    context: &StaticDetectorContext<'_>,
    passes: &StaticEntityPasses,
    diagnostics: StaticDetectorDiagnostics<'_>,
  ) -> Result<TimedEntities> {
    (self.detect)(
      context,
      DetectorDependencies::new(&self.spec, passes),
      diagnostics,
    )
  }

  #[cfg(test)]
  pub(super) const fn active_hook(self) -> StaticDetectorActiveFn {
    self.is_active
  }

  #[cfg(test)]
  pub(super) const fn detect_hook(self) -> StaticDetectFn {
    self.detect
  }
}

macro_rules! static_detector_rules {
  (
    $visibility:vis const $rules_name:ident;
    $(
      $rule_name:ident {
        id: $id:expr;
        stage: $stage:expr;
        inputs: $inputs:expr;
        scales: $scales:expr;
        $(after: $dependencies:expr;)?
        $(uses: $resources:expr;)?
        active: $is_active:path;
        detect: $detect:path $(;)?
      }
    )+
  ) => {
    $(
      $visibility const $rule_name:
        $crate::prepared::detector_contract::StaticDetectorRule =
        $crate::prepared::detector_contract::StaticDetectorRule::declare(
          &$crate::prepared::detector_contract::StaticDetectorSpec::define(
            $id,
            $stage,
          )
            .requires($inputs)
            .scales_additively_in($scales)
            $(.after($dependencies))?
            $(.uses($resources))?,
          $is_active,
          $detect,
        );
    )+

    $visibility const $rules_name:
      &[$crate::prepared::detector_contract::StaticDetectorRule] =
      &[$($rule_name),+];
  };
}

macro_rules! static_detector_modules {
  (
    $visibility:vis const $modules_name:ident;
    $(
      mod $module:ident;
    )+
  ) => {
    $(mod $module;)+

    $visibility const $modules_name:
      &[$crate::prepared::detector_contract::StaticDetectorModule] =
      &[
        $(
          $crate::prepared::detector_contract::StaticDetectorModule::declare(
            stringify!($module),
            $module::RULES,
          ),
        )+
      ];
  };
}

pub(super) use static_detector_modules;
pub(super) use static_detector_rules;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn undeclared_input_access_is_rejected() {
    let result = StaticDetectorSpec::define(
      StaticDetectorId::Regex,
      DiagnosticStage::EntityRegex,
    )
    .requires(&[StaticDetectorInput::RegexMatches])
    .require_input(StaticDetectorInput::FullText);
    assert!(result.is_err(), "undeclared input must fail closed");
    let Some(error) = result.err() else {
      return;
    };
    assert!(error.to_string().contains("undeclared input FullText"));
  }

  #[test]
  fn undeclared_dependency_access_is_rejected() {
    let result = StaticDetectorSpec::define(
      StaticDetectorId::NameCorpus,
      DiagnosticStage::EntityNameCorpus,
    )
    .require_dependency(StaticDetectorId::DenyList);
    assert!(result.is_err(), "undeclared dependency must fail closed");
    let Some(error) = result.err() else {
      return;
    };
    assert!(error.to_string().contains("undeclared dependency DenyList"));
  }

  #[test]
  fn dependency_access_requires_the_matching_entity_input() {
    let passes = StaticEntityPasses::new();
    let missing_input = StaticDetectorSpec::define(
      StaticDetectorId::NameCorpus,
      DiagnosticStage::EntityNameCorpus,
    )
    .after(&[StaticDetectorId::DenyList]);
    let result =
      DetectorDependencies::new(&missing_input, &passes).deny_list_entities();
    assert!(result.is_err(), "dependency input must fail closed");

    let declared =
      missing_input.requires(&[StaticDetectorInput::DenyListEntities]);
    assert!(
      DetectorDependencies::new(&declared, &passes)
        .deny_list_entities()
        .is_ok(),
      "declaring both the dependency and entity input must permit access",
    );
  }

  #[test]
  fn dependency_collection_requires_context_entity_input() {
    let passes = StaticEntityPasses::new();
    let missing_input = StaticDetectorSpec::define(
      StaticDetectorId::AddressSeed,
      DiagnosticStage::EntityAddressSeed,
    )
    .after(&[StaticDetectorId::Regex]);
    let result = DetectorDependencies::new(&missing_input, &passes)
      .collect_context_entities();
    assert!(result.is_err(), "context input must fail closed");
  }

  #[test]
  fn missing_growing_complexity_domain_is_rejected() {
    let result = StaticDetectorSpec::define(
      StaticDetectorId::Regex,
      DiagnosticStage::EntityRegex,
    )
    .requires(&[
      StaticDetectorInput::RegexMatches,
      StaticDetectorInput::FullText,
    ])
    .scales_additively_in(&[StaticDetectorInput::RegexMatches])
    .validate_complexity();
    assert!(result.is_err(), "missing scaling domain must fail closed");
  }

  #[test]
  fn duplicate_complexity_domain_is_rejected() {
    let result = StaticDetectorSpec::define(
      StaticDetectorId::Signature,
      DiagnosticStage::EntitySignature,
    )
    .requires(&[StaticDetectorInput::FullText])
    .scales_additively_in(&[
      StaticDetectorInput::FullText,
      StaticDetectorInput::FullText,
    ])
    .validate_complexity();
    assert!(result.is_err(), "duplicate scaling domain must fail closed");
  }
}
