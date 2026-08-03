use crate::diagnostics::StaticRedactionDiagnostics;
use crate::resolution::PipelineEntity;
use crate::types::{RedactionResult, SearchMatch};

use super::PreparedEngine;
use super::detector_contract::StaticDetectorId;
use super::timing::StaticEntityPasses;

macro_rules! static_entity_layer_accessors {
  ($($method:ident => $detector:ident),+ $(,)?) => {
    $(
      #[must_use]
      pub fn $method(&self) -> &[PipelineEntity] {
        self.entities_for(StaticDetectorId::$detector)
      }
    )+
  };
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedEngineMatches {
  pub regex: Vec<SearchMatch>,
  pub custom_regex: Vec<SearchMatch>,
  pub literal: Vec<SearchMatch>,
}

#[derive(Clone, Debug, PartialEq)]
struct StaticEntityLayer {
  detector: StaticDetectorId,
  entities: Vec<PipelineEntity>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StaticEntityLayers {
  layers: Vec<StaticEntityLayer>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticDetectionResult {
  pub matches: PreparedEngineMatches,
  pub entities: StaticEntityLayers,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticRedactionResult {
  pub detections: StaticDetectionResult,
  pub resolved_entities: Vec<PipelineEntity>,
  pub redaction: RedactionResult,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticRedactionDiagnosticResult {
  pub result: StaticRedactionResult,
  pub diagnostics: StaticRedactionDiagnostics,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StaticRedactionStreamEvent<'a> {
  DetectedEntities(&'a StaticDetectionResult),
  ResolvedEntities(&'a [PipelineEntity]),
  Redacted(&'a RedactionResult),
}

impl StaticEntityLayers {
  #[must_use]
  pub fn entity_count(&self) -> usize {
    self
      .layers
      .iter()
      .map(|layer| layer.entities.len())
      .fold(0usize, usize::saturating_add)
  }

  #[must_use]
  pub fn all_entities(&self) -> Vec<PipelineEntity> {
    let mut entities = Vec::with_capacity(self.entity_count());
    for layer in &self.layers {
      entities.extend(layer.entities.iter().cloned());
    }
    entities
  }

  static_entity_layer_accessors! {
    regex => Regex,
    custom_regex => CustomRegex,
    deny_list => DenyList,
    gazetteer => Gazetteer,
    country => Country,
    anchored => Anchored,
    trigger => Trigger,
    signature => Signature,
    legal_form => LegalForm,
    name_corpus => NameCorpus,
    address_seed => AddressSeed,
    structured_document_data => StructuredDocumentData,
  }

  fn entities_for(&self, detector: StaticDetectorId) -> &[PipelineEntity] {
    self
      .layers
      .iter()
      .find(|layer| layer.detector == detector)
      .map_or(&[], |layer| layer.entities.as_slice())
  }

  pub(super) fn from_passes(passes: StaticEntityPasses) -> Self {
    Self {
      layers: passes
        .into_layers()
        .into_iter()
        .map(|layer| StaticEntityLayer {
          detector: layer.detector,
          entities: layer.timed.entities,
        })
        .collect(),
    }
  }
}

pub struct PreparedEngineBuildResult {
  pub prepared: PreparedEngine,
  pub diagnostics: StaticRedactionDiagnostics,
}

impl StaticDetectionResult {
  #[must_use]
  pub fn entity_count(&self) -> usize {
    self.entities.entity_count()
  }

  #[must_use]
  pub fn all_entities(&self) -> Vec<PipelineEntity> {
    self.entities.all_entities()
  }
}
