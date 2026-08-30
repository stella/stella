use crate::diagnostics::DiagnosticStage;
use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  SIGNATURE_RULE {
    id: DetectorId::Signature;
    stage: DiagnosticStage::EntitySignature;
    inputs: &[
      DetectorInput::FullText,
      DetectorInput::FirstNames,
    ];
    scales: &[DetectorInput::FullText];
    uses: &[
      SupportResource::Signature,
      SupportResource::NameCorpus,
    ];
    active: signature_is_active;
    detect: detect_signature;
  }
}

fn signature_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.signature_is_active()
}

fn detect_signature(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| context.detect_signature())
}
