use std::time::Instant;

use crate::diagnostics::DiagnosticStage;
use crate::name_corpus::NameCorpusDetectionProfile;

use super::prelude::*;
use super::elapsed_us;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  NAME_CORPUS_RULE {
    id: DetectorId::NameCorpus;
    stage: DiagnosticStage::EntityNameCorpus;
    inputs: &[
      DetectorInput::FullText,
      DetectorInput::DenyListEntities,
    ];
    scales: &[
      DetectorInput::FullText,
      DetectorInput::DenyListEntities,
    ];
    after: &[DetectorId::DenyList];
    uses: &[SupportResource::NameCorpus];
    active: name_corpus_is_active;
    detect: detect_name_corpus;
  }
}

fn name_corpus_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.name_corpus_is_active()
}

fn detect_name_corpus(
  context: &StaticDetectorContext<'_>,
  dependencies: DetectorDependencies<'_>,
  diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let start = Instant::now();
  let detection = context.detect_name_corpus(dependencies)?;
  record_name_corpus_profile(
    diagnostics,
    &detection.profile,
    context.input_bytes(),
  );
  TimedEntities::new(detection.entities, elapsed_us(start))
}

fn record_name_corpus_profile(
  diagnostics: StaticDetectorDiagnostics<'_>,
  profile: &NameCorpusDetectionProfile,
  input_bytes: usize,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusCjk,
    Some(profile.cjk_count),
    Some(profile.cjk_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusSegment,
    Some(profile.word_count),
    Some(profile.segment_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusSeed,
    Some(profile.supplemental_seed_count),
    Some(profile.supplemental_seed_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusClassify,
    Some(profile.token_count),
    Some(profile.classify_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusChains,
    Some(profile.token_entity_count),
    Some(profile.chain_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusDedupe,
    Some(profile.dedupe_count),
    Some(profile.dedupe_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusFilter,
    Some(profile.filter_count),
    Some(profile.filter_elapsed_us),
    Some(input_bytes),
  );
}
