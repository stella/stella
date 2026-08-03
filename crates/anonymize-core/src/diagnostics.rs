use crate::byte_offsets::ByteOffsets;
use crate::resolution::{DetectionSource, PipelineEntity, SourceDetail};
use crate::search::{SearchIndexBuildStats, SearchIndexFindStats};
use crate::types::{RedactionResult, SearchEngine, SearchMatch};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticPhase {
  Prepare,
  Warm,
  Search,
  Detect,
  Resolve,
  Redact,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticScope {
  Total,
  Step,
  Slot,
  Detail,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticStage {
  PrepareCacheKey,
  PrepareCacheBypass,
  PrepareCacheHit,
  PrepareCacheMiss,
  PrepareBindingParse,
  PreparePackageDecode,
  PreparePackageVerify,
  PreparePackageDecompress,
  PreparePackageConfigDecode,
  PrepareBindingConvert,
  PrepareArtifactsDecode,
  PrepareTotal,
  PrepareRegex,
  PrepareCustomRegex,
  PrepareAnchored,
  PrepareLegalFormSearch,
  PrepareTriggerSearch,
  PrepareLiteral,
  PrepareHotwordData,
  PrepareTriggerData,
  PrepareLegalFormData,
  PrepareAddressSeedData,
  PrepareZoneData,
  PrepareAddressContextData,
  PrepareCoreferenceData,
  PrepareNameCorpusData,
  PrepareSignatureData,
  WarmRegex,
  WarmCustomRegex,
  WarmLegalFormSearch,
  WarmTriggerSearch,
  WarmLiteral,
  WarmTotal,
  DetectTotal,
  RedactTotal,
  EntityCallerInput,
  EntityCallerRetained,
  Normalize,
  FindMatches,
  FindRegex,
  FindCustomRegex,
  FindLegalForm,
  FindTrigger,
  FindLiteral,
  SearchRegex,
  SearchCustomRegex,
  SearchLegalForm,
  SearchTrigger,
  SearchLiteral,
  EntityRegex,
  EntityCustomRegex,
  EntityAnchored,
  EntityDenyList,
  EntityGazetteer,
  EntityCountry,
  EntityTrigger,
  EntitySignature,
  EntityLegalForm,
  EntityAddressSeed,
  EntityAddressSeedContext,
  EntityAddressSeedCollect,
  EntityAddressSeedCollectStreetTypes,
  EntityAddressSeedCollectExisting,
  EntityAddressSeedCollectStreetNumbers,
  EntityAddressSeedCollectPostalCodes,
  EntityAddressSeedCollectItalianCap,
  EntityAddressSeedCluster,
  EntityAddressSeedBoundary,
  EntityAddressSeedExpand,
  EntityStructuredDocumentData,
  EntityNameCorpus,
  EntityNameCorpusCjk,
  EntityNameCorpusSegment,
  EntityNameCorpusSeed,
  EntityNameCorpusClassify,
  EntityNameCorpusChains,
  EntityNameCorpusDedupe,
  EntityNameCorpusFilter,
  EntityZoneAdjustment,
  EntityHotword,
  EntityAddressContext,
  EntityCoreference,
  Merge,
  Boundary,
  Sanitize,
  Redaction,
}

impl DiagnosticStage {
  #[must_use]
  pub const fn phase(self) -> DiagnosticPhase {
    match self {
      Self::PrepareCacheKey
      | Self::PrepareCacheBypass
      | Self::PrepareCacheHit
      | Self::PrepareCacheMiss
      | Self::PrepareBindingParse
      | Self::PreparePackageDecode
      | Self::PreparePackageVerify
      | Self::PreparePackageDecompress
      | Self::PreparePackageConfigDecode
      | Self::PrepareBindingConvert
      | Self::PrepareArtifactsDecode
      | Self::PrepareTotal
      | Self::PrepareRegex
      | Self::PrepareCustomRegex
      | Self::PrepareAnchored
      | Self::PrepareLegalFormSearch
      | Self::PrepareTriggerSearch
      | Self::PrepareLiteral
      | Self::PrepareHotwordData
      | Self::PrepareTriggerData
      | Self::PrepareLegalFormData
      | Self::PrepareAddressSeedData
      | Self::PrepareZoneData
      | Self::PrepareAddressContextData
      | Self::PrepareCoreferenceData
      | Self::PrepareNameCorpusData
      | Self::PrepareSignatureData => DiagnosticPhase::Prepare,
      Self::WarmRegex
      | Self::WarmCustomRegex
      | Self::WarmLegalFormSearch
      | Self::WarmTriggerSearch
      | Self::WarmLiteral
      | Self::WarmTotal => DiagnosticPhase::Warm,
      Self::Normalize
      | Self::FindMatches
      | Self::FindRegex
      | Self::FindCustomRegex
      | Self::FindLegalForm
      | Self::FindTrigger
      | Self::FindLiteral
      | Self::SearchRegex
      | Self::SearchCustomRegex
      | Self::SearchLegalForm
      | Self::SearchTrigger
      | Self::SearchLiteral => DiagnosticPhase::Search,
      Self::DetectTotal
      | Self::EntityRegex
      | Self::EntityCustomRegex
      | Self::EntityAnchored
      | Self::EntityDenyList
      | Self::EntityGazetteer
      | Self::EntityCountry
      | Self::EntityTrigger
      | Self::EntitySignature
      | Self::EntityLegalForm
      | Self::EntityAddressSeed
      | Self::EntityAddressSeedContext
      | Self::EntityAddressSeedCollect
      | Self::EntityAddressSeedCollectStreetTypes
      | Self::EntityAddressSeedCollectExisting
      | Self::EntityAddressSeedCollectStreetNumbers
      | Self::EntityAddressSeedCollectPostalCodes
      | Self::EntityAddressSeedCollectItalianCap
      | Self::EntityAddressSeedCluster
      | Self::EntityAddressSeedBoundary
      | Self::EntityAddressSeedExpand
      | Self::EntityStructuredDocumentData
      | Self::EntityNameCorpus
      | Self::EntityNameCorpusCjk
      | Self::EntityNameCorpusSegment
      | Self::EntityNameCorpusSeed
      | Self::EntityNameCorpusClassify
      | Self::EntityNameCorpusChains
      | Self::EntityNameCorpusDedupe
      | Self::EntityNameCorpusFilter
      | Self::EntityCallerInput => DiagnosticPhase::Detect,
      Self::EntityZoneAdjustment
      | Self::EntityHotword
      | Self::EntityAddressContext
      | Self::EntityCoreference
      | Self::Merge
      | Self::Boundary
      | Self::Sanitize
      | Self::EntityCallerRetained => DiagnosticPhase::Resolve,
      Self::RedactTotal | Self::Redaction => DiagnosticPhase::Redact,
    }
  }

  #[must_use]
  pub const fn is_total(self) -> bool {
    matches!(
      self,
      Self::PrepareTotal
        | Self::WarmTotal
        | Self::FindMatches
        | Self::DetectTotal
        | Self::RedactTotal
    )
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticEventKind {
  StageSummary,
  SearchMatch,
  Entity,
  Rejection,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DiagnosticDetail {
  Summary,
  #[default]
  Detailed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DiagnosticEvent {
  pub stage: DiagnosticStage,
  pub kind: DiagnosticEventKind,
  pub count: Option<usize>,
  pub slot: Option<usize>,
  pub subslot: Option<usize>,
  pub pattern_count: Option<usize>,
  pub engine: Option<SearchEngine>,
  pub pattern: Option<u32>,
  pub source: Option<DetectionSource>,
  pub source_detail: Option<SourceDetail>,
  pub provider_id: Option<String>,
  pub detection_id: Option<String>,
  pub label: Option<String>,
  pub start: Option<u32>,
  pub end: Option<u32>,
  pub text: Option<String>,
  pub score: Option<f64>,
  pub span_valid: Option<bool>,
  pub elapsed_us: Option<u64>,
  pub input_bytes: Option<usize>,
  pub artifact_count: Option<usize>,
  pub artifact_bytes: Option<usize>,
  pub reason: Option<String>,
}

impl DiagnosticEvent {
  #[must_use]
  pub const fn scope(&self) -> DiagnosticScope {
    match self.kind {
      DiagnosticEventKind::SearchMatch
      | DiagnosticEventKind::Entity
      | DiagnosticEventKind::Rejection => DiagnosticScope::Detail,
      DiagnosticEventKind::StageSummary if self.slot.is_some() => {
        DiagnosticScope::Slot
      }
      DiagnosticEventKind::StageSummary if self.stage.is_total() => {
        DiagnosticScope::Total
      }
      DiagnosticEventKind::StageSummary => DiagnosticScope::Step,
    }
  }
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticRedactionDiagnostics {
  pub events: Vec<DiagnosticEvent>,
  pub detail: DiagnosticDetail,
}

impl Default for StaticRedactionDiagnostics {
  fn default() -> Self {
    Self {
      events: Vec::new(),
      detail: DiagnosticDetail::Detailed,
    }
  }
}

impl StaticRedactionDiagnostics {
  #[must_use]
  pub const fn summary() -> Self {
    Self {
      events: Vec::new(),
      detail: DiagnosticDetail::Summary,
    }
  }

  pub(crate) fn record_search_matches(
    &mut self,
    stage: DiagnosticStage,
    matches: &[SearchMatch],
    full_text: &str,
    elapsed_us: Option<u64>,
  ) {
    self.record_stage(
      stage,
      Some(matches.len()),
      elapsed_us,
      Some(full_text.len()),
    );

    if self.detail == DiagnosticDetail::Summary {
      return;
    }

    let offsets = ByteOffsets::new(full_text);
    for found in matches {
      let span_valid = span_slices(&offsets, found.start(), found.end());
      self.events.push(DiagnosticEvent {
        stage,
        kind: DiagnosticEventKind::SearchMatch,
        count: None,
        slot: None,
        subslot: None,
        pattern_count: None,
        engine: Some(found.engine()),
        pattern: Some(found.pattern()),
        source: None,
        source_detail: None,
        provider_id: None,
        detection_id: None,
        label: None,
        start: Some(found.start()),
        end: Some(found.end()),
        text: None,
        score: None,
        span_valid: Some(span_valid),
        elapsed_us: None,
        input_bytes: None,
        artifact_count: None,
        artifact_bytes: None,
        reason: None,
      });
    }
  }

  pub(crate) fn record_search_slot_summaries(
    &mut self,
    stage: DiagnosticStage,
    stats: &[SearchIndexFindStats],
    input_bytes: usize,
  ) {
    for stat in stats {
      self.events.push(DiagnosticEvent {
        stage,
        kind: DiagnosticEventKind::StageSummary,
        count: Some(stat.match_count),
        slot: Some(stat.slot),
        subslot: stat.subslot,
        pattern_count: Some(stat.pattern_count),
        engine: Some(stat.engine),
        pattern: stat.pattern,
        source: None,
        source_detail: None,
        provider_id: None,
        detection_id: None,
        label: None,
        start: None,
        end: None,
        text: None,
        score: None,
        span_valid: None,
        elapsed_us: Some(stat.elapsed_us),
        input_bytes: Some(input_bytes),
        artifact_count: None,
        artifact_bytes: None,
        reason: None,
      });
    }
  }

  pub(crate) fn record_search_build_slot_summaries(
    &mut self,
    stage: DiagnosticStage,
    stats: &[SearchIndexBuildStats],
  ) {
    for stat in stats {
      self.events.push(DiagnosticEvent {
        stage,
        kind: DiagnosticEventKind::StageSummary,
        count: None,
        slot: Some(stat.slot),
        subslot: stat.subslot,
        pattern_count: Some(stat.pattern_count),
        engine: Some(stat.engine),
        pattern: stat.pattern,
        source: None,
        source_detail: None,
        provider_id: None,
        detection_id: None,
        label: None,
        start: None,
        end: None,
        text: None,
        score: None,
        span_valid: None,
        elapsed_us: Some(stat.elapsed_us),
        input_bytes: None,
        artifact_count: Some(stat.artifact_count),
        artifact_bytes: Some(stat.artifact_bytes),
        reason: None,
      });
    }
  }

  pub(crate) fn record_entities(
    &mut self,
    stage: DiagnosticStage,
    entities: &[PipelineEntity],
    full_text: &str,
    elapsed_us: Option<u64>,
  ) {
    self.record_stage(
      stage,
      Some(entities.len()),
      elapsed_us,
      Some(full_text.len()),
    );

    if self.detail == DiagnosticDetail::Summary {
      return;
    }

    let offsets = ByteOffsets::new(full_text);
    for entity in entities {
      self.events.push(DiagnosticEvent {
        stage,
        kind: DiagnosticEventKind::Entity,
        count: None,
        slot: None,
        subslot: None,
        pattern_count: None,
        engine: None,
        pattern: None,
        source: Some(entity.source),
        source_detail: entity.source_detail,
        provider_id: entity
          .caller_provenance
          .as_ref()
          .map(|provenance| provenance.provider_id().to_owned()),
        detection_id: entity
          .caller_provenance
          .as_ref()
          .map(|provenance| provenance.detection_id().to_owned()),
        label: Some(entity.label.clone()),
        start: Some(entity.start),
        end: Some(entity.end),
        text: None,
        score: Some(entity.score),
        span_valid: Some(span_slices(&offsets, entity.start, entity.end)),
        elapsed_us: None,
        input_bytes: None,
        artifact_count: None,
        artifact_bytes: None,
        reason: None,
      });
    }
  }

  pub(crate) fn record_redaction(
    &mut self,
    result: &RedactionResult,
    elapsed_us: Option<u64>,
    input_bytes: usize,
  ) {
    self.events.push(DiagnosticEvent {
      stage: DiagnosticStage::Redaction,
      kind: DiagnosticEventKind::StageSummary,
      count: Some(result.entity_count),
      slot: None,
      subslot: None,
      pattern_count: None,
      engine: None,
      pattern: None,
      source: None,
      source_detail: None,
      provider_id: None,
      detection_id: None,
      label: None,
      start: None,
      end: None,
      text: None,
      score: None,
      span_valid: None,
      elapsed_us,
      input_bytes: Some(input_bytes),
      artifact_count: None,
      artifact_bytes: None,
      reason: None,
    });
  }

  pub(crate) fn record_rejection(
    &mut self,
    stage: DiagnosticStage,
    pattern: Option<u32>,
    label: Option<&str>,
    start: Option<u32>,
    end: Option<u32>,
    reason: &'static str,
  ) {
    if self.detail == DiagnosticDetail::Summary {
      return;
    }

    self.events.push(DiagnosticEvent {
      stage,
      kind: DiagnosticEventKind::Rejection,
      count: None,
      slot: None,
      subslot: None,
      pattern_count: None,
      engine: None,
      pattern,
      source: None,
      source_detail: None,
      provider_id: None,
      detection_id: None,
      label: label.map(str::to_owned),
      start,
      end,
      text: None,
      score: None,
      span_valid: None,
      elapsed_us: None,
      input_bytes: None,
      artifact_count: None,
      artifact_bytes: None,
      reason: Some(String::from(reason)),
    });
  }

  pub(crate) fn record_stage(
    &mut self,
    stage: DiagnosticStage,
    count: Option<usize>,
    elapsed_us: Option<u64>,
    input_bytes: Option<usize>,
  ) {
    self.events.push(DiagnosticEvent {
      stage,
      kind: DiagnosticEventKind::StageSummary,
      count,
      slot: None,
      subslot: None,
      pattern_count: None,
      engine: None,
      pattern: None,
      source: None,
      source_detail: None,
      provider_id: None,
      detection_id: None,
      label: None,
      start: None,
      end: None,
      text: None,
      score: None,
      span_valid: None,
      elapsed_us,
      input_bytes,
      artifact_count: None,
      artifact_bytes: None,
      reason: None,
    });
  }

  pub fn extend(&mut self, other: Self) {
    self.events.extend(other.events);
  }
}

fn span_slices(offsets: &ByteOffsets<'_>, start: u32, end: u32) -> bool {
  start <= end
    && offsets.validate_offset(start).is_ok()
    && offsets.validate_offset(end).is_ok()
}
