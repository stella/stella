use crate::diagnostics::DiagnosticStage;
use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  LEGAL_FORM_RULE {
    id: DetectorId::LegalForm;
    stage: DiagnosticStage::EntityLegalForm;
    inputs: &[DetectorInput::RegexMatches, DetectorInput::FullText];
    scales: &[DetectorInput::RegexMatches, DetectorInput::FullText];
    uses: &[SupportResource::LegalForms];
    active: legal_form_is_active;
    detect: detect_legal_form;
  }
}

fn legal_form_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.legal_form_is_active()
}

fn detect_legal_form(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| context.detect_legal_form())
}
