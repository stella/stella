use crate::diagnostics::DiagnosticStage;

use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  TRIGGER_RULE {
    id: DetectorId::Trigger;
    stage: DiagnosticStage::EntityTrigger;
    inputs: &[
      DetectorInput::RegexMatches,
      DetectorInput::FullText,
      DetectorInput::SignatureData,
      DetectorInput::TitleTokens,
    ];
    scales: &[DetectorInput::RegexMatches, DetectorInput::FullText];
    uses: &[SupportResource::Triggers];
    active: trigger_is_active;
    detect: detect_trigger;
  }
}

fn trigger_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.trigger_is_active()
}

fn detect_trigger(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| context.detect_trigger(diagnostics))
}
