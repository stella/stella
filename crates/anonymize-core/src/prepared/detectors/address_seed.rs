use web_time::Instant;

use crate::address_seeds::AddressSeedDetectionProfile;
use crate::diagnostics::DiagnosticStage;

use super::prelude::*;
use super::elapsed_us;

const ADDRESS_SEED_DEPENDENCIES: &[DetectorId] = &[
  DetectorId::Regex,
  DetectorId::CustomRegex,
  DetectorId::Anchored,
  DetectorId::Trigger,
  DetectorId::Signature,
  DetectorId::LegalForm,
  DetectorId::DenyList,
  DetectorId::Gazetteer,
  DetectorId::NameCorpus,
];

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  ADDRESS_SEED_RULE {
    id: DetectorId::AddressSeed;
    stage: DiagnosticStage::EntityAddressSeed;
    inputs: &[
      DetectorInput::LiteralMatches,
      DetectorInput::ContextEntities,
      DetectorInput::FullText,
      DetectorInput::FalsePositiveFilters,
    ];
    scales: &[
      DetectorInput::LiteralMatches,
      DetectorInput::ContextEntities,
      DetectorInput::FullText,
    ];
    after: ADDRESS_SEED_DEPENDENCIES;
    uses: &[SupportResource::AddressSeed];
    active: address_seed_is_active;
    detect: detect_address_seed;
  }
}

fn address_seed_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.address_seed_is_active()
}

fn detect_address_seed(
  context: &StaticDetectorContext<'_>,
  dependencies: DetectorDependencies<'_>,
  diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let start = Instant::now();
  let context_start = Instant::now();
  let (detection, context_count) = context.detect_address_seed(dependencies)?;
  let context_elapsed_us = elapsed_us(context_start);
  record_address_seed_profile(
    diagnostics,
    &detection.profile,
    context_count,
    context_elapsed_us,
    context.input_bytes(),
  );
  TimedEntities::new(detection.entities, elapsed_us(start))
}

fn record_address_seed_profile(
  diagnostics: StaticDetectorDiagnostics<'_>,
  profile: &AddressSeedDetectionProfile,
  context_count: usize,
  context_elapsed_us: u64,
  input_bytes: usize,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_stage(
    DiagnosticStage::EntityAddressSeedContext,
    Some(context_count),
    Some(context_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityAddressSeedCollect,
    Some(profile.seed_count),
    Some(profile.collect_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityAddressSeedCollectStreetTypes,
    Some(profile.street_type_seed_count),
    Some(profile.street_type_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityAddressSeedCollectExisting,
    Some(profile.existing_seed_count),
    Some(profile.existing_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityAddressSeedCollectStreetNumbers,
    Some(profile.street_number_seed_count),
    Some(profile.street_number_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityAddressSeedCollectPostalCodes,
    Some(profile.postal_code_seed_count),
    Some(profile.postal_code_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityAddressSeedCollectItalianCap,
    Some(profile.italian_cap_seed_count),
    Some(profile.italian_cap_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityAddressSeedCluster,
    Some(profile.cluster_count),
    Some(profile.cluster_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityAddressSeedBoundary,
    Some(profile.boundary_count),
    Some(profile.boundary_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityAddressSeedExpand,
    Some(profile.expanded_count),
    Some(profile.expand_elapsed_us),
    Some(input_bytes),
  );
}
