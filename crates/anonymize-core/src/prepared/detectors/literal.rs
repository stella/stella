use crate::diagnostics::DiagnosticStage;
use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  DENY_LIST_RULE {
    id: DetectorId::DenyList;
    stage: DiagnosticStage::EntityDenyList;
    inputs: &[
      DetectorInput::LiteralMatches,
      DetectorInput::DenyListData,
      DetectorInput::SignatureData,
      DetectorInput::FullText,
    ];
    scales: &[DetectorInput::LiteralMatches, DetectorInput::FullText];
    active: deny_list_is_active;
    detect: detect_deny_list;
  }
  GAZETTEER_RULE {
    id: DetectorId::Gazetteer;
    stage: DiagnosticStage::EntityGazetteer;
    inputs: &[
      DetectorInput::LiteralMatches,
      DetectorInput::GazetteerData,
      DetectorInput::FullText,
    ];
    scales: &[DetectorInput::LiteralMatches, DetectorInput::FullText];
    active: gazetteer_is_active;
    detect: detect_gazetteer;
  }
  COUNTRY_RULE {
    id: DetectorId::Country;
    stage: DiagnosticStage::EntityCountry;
    inputs: &[
      DetectorInput::LiteralMatches,
      DetectorInput::CountryData,
      DetectorInput::FullText,
    ];
    scales: &[DetectorInput::LiteralMatches, DetectorInput::FullText];
    active: country_is_active;
    detect: detect_country;
  }
}

fn deny_list_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.deny_list_is_active()
}

fn gazetteer_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.gazetteer_is_active()
}

fn country_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.country_is_active()
}

fn detect_deny_list(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| context.detect_deny_list())
}

fn detect_gazetteer(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| context.detect_gazetteer())
}

fn detect_country(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| context.detect_country())
}
