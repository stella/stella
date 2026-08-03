//! Stable string names for core enums exposed through the binding
//! contract (detection sources, diagnostic stages, operators).

use stella_anonymize_core::{
  DetectionSource, DiagnosticEventKind, DiagnosticPhase, DiagnosticScope,
  DiagnosticStage, OperatorType, SearchEngine, SourceDetail,
};

pub(crate) fn detection_source_name(source: DetectionSource) -> String {
  match source {
    DetectionSource::Caller => "caller",
    DetectionSource::Trigger => "trigger",
    DetectionSource::Regex => "regex",
    DetectionSource::DenyList => "deny-list",
    DetectionSource::LegalForm => "legal-form",
    DetectionSource::Gazetteer => "gazetteer",
    DetectionSource::Country => "country",
    DetectionSource::Ner => "ner",
    DetectionSource::Coreference => "coreference",
  }
  .to_owned()
}

pub(crate) fn source_detail_name(detail: SourceDetail) -> String {
  match detail {
    SourceDetail::CustomDenyList => "custom-deny-list",
    SourceDetail::CustomRegex => "custom-regex",
    SourceDetail::GazetteerExtension => "gazetteer-extension",
    SourceDetail::AddressContext => "address-context",
  }
  .to_owned()
}

pub(crate) fn search_engine_name(engine: SearchEngine) -> String {
  match engine {
    SearchEngine::Literal => "literal",
    SearchEngine::Regex => "regex",
    SearchEngine::Fuzzy => "fuzzy",
    SearchEngine::Text => "text-search",
  }
  .to_owned()
}

pub(crate) fn diagnostic_phase_name(phase: DiagnosticPhase) -> String {
  match phase {
    DiagnosticPhase::Prepare => "prepare",
    DiagnosticPhase::Warm => "warm",
    DiagnosticPhase::Search => "search",
    DiagnosticPhase::Detect => "detect",
    DiagnosticPhase::Resolve => "resolve",
    DiagnosticPhase::Redact => "redact",
  }
  .to_owned()
}

pub(crate) fn diagnostic_scope_name(scope: DiagnosticScope) -> String {
  match scope {
    DiagnosticScope::Total => "total",
    DiagnosticScope::Step => "step",
    DiagnosticScope::Slot => "slot",
    DiagnosticScope::Detail => "detail",
  }
  .to_owned()
}

pub(crate) fn diagnostic_stage_name(stage: DiagnosticStage) -> String {
  match stage {
    DiagnosticStage::PrepareCacheKey
    | DiagnosticStage::PrepareCacheBypass
    | DiagnosticStage::PrepareCacheHit
    | DiagnosticStage::PrepareCacheMiss
    | DiagnosticStage::PrepareBindingParse
    | DiagnosticStage::PreparePackageDecode
    | DiagnosticStage::PreparePackageVerify
    | DiagnosticStage::PreparePackageDecompress
    | DiagnosticStage::PreparePackageConfigDecode
    | DiagnosticStage::PrepareBindingConvert
    | DiagnosticStage::PrepareArtifactsDecode
    | DiagnosticStage::PrepareTotal
    | DiagnosticStage::PrepareRegex
    | DiagnosticStage::PrepareCustomRegex
    | DiagnosticStage::PrepareAnchored
    | DiagnosticStage::PrepareLegalFormSearch
    | DiagnosticStage::PrepareTriggerSearch
    | DiagnosticStage::PrepareLiteral
    | DiagnosticStage::PrepareHotwordData
    | DiagnosticStage::PrepareTriggerData
    | DiagnosticStage::PrepareLegalFormData
    | DiagnosticStage::PrepareAddressSeedData
    | DiagnosticStage::PrepareZoneData
    | DiagnosticStage::PrepareAddressContextData
    | DiagnosticStage::PrepareCoreferenceData
    | DiagnosticStage::PrepareNameCorpusData
    | DiagnosticStage::PrepareSignatureData => {
      diagnostic_prepare_stage_name(stage)
    }
    DiagnosticStage::WarmRegex
    | DiagnosticStage::WarmCustomRegex
    | DiagnosticStage::WarmLegalFormSearch
    | DiagnosticStage::WarmTriggerSearch
    | DiagnosticStage::WarmLiteral
    | DiagnosticStage::WarmTotal => diagnostic_warm_stage_name(stage),
    DiagnosticStage::Normalize
    | DiagnosticStage::FindMatches
    | DiagnosticStage::FindRegex
    | DiagnosticStage::FindCustomRegex
    | DiagnosticStage::FindLegalForm
    | DiagnosticStage::FindTrigger
    | DiagnosticStage::FindLiteral
    | DiagnosticStage::SearchRegex
    | DiagnosticStage::SearchCustomRegex
    | DiagnosticStage::SearchLegalForm
    | DiagnosticStage::SearchTrigger
    | DiagnosticStage::SearchLiteral => diagnostic_search_stage_name(stage),
    DiagnosticStage::DetectTotal
    | DiagnosticStage::EntityCallerInput
    | DiagnosticStage::EntityRegex
    | DiagnosticStage::EntityCustomRegex
    | DiagnosticStage::EntityAnchored
    | DiagnosticStage::EntityDenyList
    | DiagnosticStage::EntityGazetteer
    | DiagnosticStage::EntityCountry
    | DiagnosticStage::EntityTrigger
    | DiagnosticStage::EntitySignature
    | DiagnosticStage::EntityLegalForm
    | DiagnosticStage::EntityAddressSeed
    | DiagnosticStage::EntityAddressSeedContext
    | DiagnosticStage::EntityAddressSeedCollect
    | DiagnosticStage::EntityAddressSeedCollectStreetTypes
    | DiagnosticStage::EntityAddressSeedCollectExisting
    | DiagnosticStage::EntityAddressSeedCollectStreetNumbers
    | DiagnosticStage::EntityAddressSeedCollectPostalCodes
    | DiagnosticStage::EntityAddressSeedCollectItalianCap
    | DiagnosticStage::EntityAddressSeedCluster
    | DiagnosticStage::EntityAddressSeedBoundary
    | DiagnosticStage::EntityAddressSeedExpand
    | DiagnosticStage::EntityStructuredDocumentData
    | DiagnosticStage::EntityNameCorpus
    | DiagnosticStage::EntityNameCorpusCjk
    | DiagnosticStage::EntityNameCorpusSegment
    | DiagnosticStage::EntityNameCorpusSeed
    | DiagnosticStage::EntityNameCorpusClassify
    | DiagnosticStage::EntityNameCorpusChains
    | DiagnosticStage::EntityNameCorpusDedupe
    | DiagnosticStage::EntityNameCorpusFilter => {
      diagnostic_detect_stage_name(stage)
    }
    DiagnosticStage::EntityZoneAdjustment
    | DiagnosticStage::EntityCallerRetained
    | DiagnosticStage::EntityHotword
    | DiagnosticStage::EntityAddressContext
    | DiagnosticStage::EntityCoreference
    | DiagnosticStage::Merge
    | DiagnosticStage::Boundary
    | DiagnosticStage::Sanitize
    | DiagnosticStage::RedactTotal
    | DiagnosticStage::Redaction => diagnostic_finish_stage_name(stage),
  }
  .to_owned()
}

const fn diagnostic_prepare_stage_name(stage: DiagnosticStage) -> &'static str {
  match stage {
    DiagnosticStage::PrepareCacheKey => "prepare.cache-key",
    DiagnosticStage::PrepareCacheBypass => "prepare.cache.bypass",
    DiagnosticStage::PrepareCacheHit => "prepare.cache.hit",
    DiagnosticStage::PrepareCacheMiss => "prepare.cache.miss",
    DiagnosticStage::PrepareBindingParse => "prepare.binding.parse",
    DiagnosticStage::PreparePackageDecode => "prepare.package.decode",
    DiagnosticStage::PreparePackageVerify => "prepare.package.verify",
    DiagnosticStage::PreparePackageDecompress => "prepare.package.decompress",
    DiagnosticStage::PreparePackageConfigDecode => {
      "prepare.package.config-decode"
    }
    DiagnosticStage::PrepareBindingConvert => "prepare.binding.convert",
    DiagnosticStage::PrepareArtifactsDecode => "prepare.artifacts.decode",
    DiagnosticStage::PrepareTotal => "prepare.total",
    DiagnosticStage::PrepareRegex => "prepare.regex",
    DiagnosticStage::PrepareCustomRegex => "prepare.custom-regex",
    DiagnosticStage::PrepareAnchored => "prepare.anchored",
    DiagnosticStage::PrepareLegalFormSearch => "prepare.legal-form-search",
    DiagnosticStage::PrepareTriggerSearch => "prepare.trigger-search",
    DiagnosticStage::PrepareLiteral => "prepare.literal",
    DiagnosticStage::PrepareHotwordData => "prepare.hotword-data",
    DiagnosticStage::PrepareTriggerData => "prepare.trigger-data",
    DiagnosticStage::PrepareLegalFormData => "prepare.legal-form-data",
    DiagnosticStage::PrepareAddressSeedData => "prepare.address-seed-data",
    DiagnosticStage::PrepareZoneData => "prepare.zone-data",
    DiagnosticStage::PrepareAddressContextData => {
      "prepare.address-context-data"
    }
    DiagnosticStage::PrepareCoreferenceData => "prepare.coreference-data",
    DiagnosticStage::PrepareNameCorpusData => "prepare.name-corpus-data",
    DiagnosticStage::PrepareSignatureData => "prepare.signature-data",
    _ => "prepare.unknown",
  }
}

const fn diagnostic_warm_stage_name(stage: DiagnosticStage) -> &'static str {
  match stage {
    DiagnosticStage::WarmRegex => "warm.regex",
    DiagnosticStage::WarmCustomRegex => "warm.custom-regex",
    DiagnosticStage::WarmLegalFormSearch => "warm.legal-form-search",
    DiagnosticStage::WarmTriggerSearch => "warm.trigger-search",
    DiagnosticStage::WarmLiteral => "warm.literal",
    DiagnosticStage::WarmTotal => "warm.total",
    _ => "warm.unknown",
  }
}

const fn diagnostic_search_stage_name(stage: DiagnosticStage) -> &'static str {
  match stage {
    DiagnosticStage::Normalize => "normalize",
    DiagnosticStage::FindMatches => "find-matches",
    DiagnosticStage::FindRegex => "find.regex",
    DiagnosticStage::FindCustomRegex => "find.custom-regex",
    DiagnosticStage::FindLegalForm => "find.legal-form",
    DiagnosticStage::FindTrigger => "find.trigger",
    DiagnosticStage::FindLiteral => "find.literal",
    DiagnosticStage::SearchRegex => "search.regex",
    DiagnosticStage::SearchCustomRegex => "search.custom-regex",
    DiagnosticStage::SearchLegalForm => "search.legal-form",
    DiagnosticStage::SearchTrigger => "search.trigger",
    DiagnosticStage::SearchLiteral => "search.literal",
    _ => "search.unknown",
  }
}

const fn diagnostic_detect_stage_name(stage: DiagnosticStage) -> &'static str {
  match stage {
    DiagnosticStage::DetectTotal => "detect.total",
    DiagnosticStage::EntityCallerInput => "entity.caller.input",
    DiagnosticStage::EntityRegex => "entity.regex",
    DiagnosticStage::EntityCustomRegex => "entity.custom-regex",
    DiagnosticStage::EntityAnchored => "entity.anchored",
    DiagnosticStage::EntityDenyList => "entity.deny-list",
    DiagnosticStage::EntityGazetteer => "entity.gazetteer",
    DiagnosticStage::EntityCountry => "entity.country",
    DiagnosticStage::EntityTrigger => "entity.trigger",
    DiagnosticStage::EntitySignature => "entity.signature",
    DiagnosticStage::EntityLegalForm => "entity.legal-form",
    DiagnosticStage::EntityAddressSeed => "entity.address-seed",
    DiagnosticStage::EntityAddressSeedContext => "entity.address-seed.context",
    DiagnosticStage::EntityAddressSeedCollect => "entity.address-seed.collect",
    DiagnosticStage::EntityAddressSeedCollectStreetTypes => {
      "entity.address-seed.collect.street-types"
    }
    DiagnosticStage::EntityAddressSeedCollectExisting => {
      "entity.address-seed.collect.existing"
    }
    DiagnosticStage::EntityAddressSeedCollectStreetNumbers => {
      "entity.address-seed.collect.street-numbers"
    }
    DiagnosticStage::EntityAddressSeedCollectPostalCodes => {
      "entity.address-seed.collect.postal-codes"
    }
    DiagnosticStage::EntityAddressSeedCollectItalianCap => {
      "entity.address-seed.collect.italian-cap"
    }
    DiagnosticStage::EntityAddressSeedCluster => "entity.address-seed.cluster",
    DiagnosticStage::EntityAddressSeedBoundary => {
      "entity.address-seed.boundary"
    }
    DiagnosticStage::EntityAddressSeedExpand => "entity.address-seed.expand",
    DiagnosticStage::EntityStructuredDocumentData => {
      "entity.structured-document-data"
    }
    DiagnosticStage::EntityNameCorpus => "entity.name-corpus",
    DiagnosticStage::EntityNameCorpusCjk => "entity.name-corpus.cjk",
    DiagnosticStage::EntityNameCorpusSegment => "entity.name-corpus.segment",
    DiagnosticStage::EntityNameCorpusSeed => "entity.name-corpus.seed",
    DiagnosticStage::EntityNameCorpusClassify => "entity.name-corpus.classify",
    DiagnosticStage::EntityNameCorpusChains => "entity.name-corpus.chains",
    DiagnosticStage::EntityNameCorpusDedupe => "entity.name-corpus.dedupe",
    DiagnosticStage::EntityNameCorpusFilter => "entity.name-corpus.filter",
    _ => "detect.unknown",
  }
}

const fn diagnostic_finish_stage_name(stage: DiagnosticStage) -> &'static str {
  match stage {
    DiagnosticStage::EntityZoneAdjustment => "entity.zone-adjustment",
    DiagnosticStage::EntityCallerRetained => "entity.caller.retained",
    DiagnosticStage::EntityHotword => "entity.hotword",
    DiagnosticStage::EntityAddressContext => "entity.address-context",
    DiagnosticStage::EntityCoreference => "entity.coreference",
    DiagnosticStage::Merge => "resolution.merge",
    DiagnosticStage::Boundary => "resolution.boundary",
    DiagnosticStage::Sanitize => "resolution.sanitize",
    DiagnosticStage::RedactTotal => "redact.total",
    DiagnosticStage::Redaction => "redaction",
    _ => "finish.unknown",
  }
}

pub(crate) fn diagnostic_event_kind_name(kind: DiagnosticEventKind) -> String {
  match kind {
    DiagnosticEventKind::StageSummary => "stage-summary",
    DiagnosticEventKind::SearchMatch => "search-match",
    DiagnosticEventKind::Entity => "entity",
    DiagnosticEventKind::Rejection => "rejection",
  }
  .to_owned()
}

pub(crate) fn operator_name(operator: OperatorType) -> String {
  match operator {
    OperatorType::Replace => "replace",
    OperatorType::Redact => "redact",
    OperatorType::Keep => "keep",
    OperatorType::Mask => "mask",
  }
  .to_owned()
}
