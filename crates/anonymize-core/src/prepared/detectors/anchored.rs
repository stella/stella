use crate::diagnostics::DiagnosticStage;

use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  ANCHORED_RULE {
    id: DetectorId::Anchored;
    stage: DiagnosticStage::EntityAnchored;
    inputs: &[
      DetectorInput::FullText,
      DetectorInput::DateData,
      DetectorInput::MonetaryData,
    ];
    scales: &[DetectorInput::FullText];
    active: anchored_is_active;
    detect: detect_anchored;
  }
}

fn anchored_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.anchored_is_active()
}

fn detect_anchored(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| context.detect_anchored())
}
