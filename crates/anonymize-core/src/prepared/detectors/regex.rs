use crate::diagnostics::DiagnosticStage;
use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  REGEX_RULE {
    id: DetectorId::Regex;
    stage: DiagnosticStage::EntityRegex;
    inputs: &[
      DetectorInput::RegexMatches,
      DetectorInput::FullText,
      DetectorInput::RegexMeta,
    ];
    scales: &[DetectorInput::RegexMatches, DetectorInput::FullText];
    active: regex_is_active;
    detect: detect_regex;
  }
  CUSTOM_REGEX_RULE {
    id: DetectorId::CustomRegex;
    stage: DiagnosticStage::EntityCustomRegex;
    inputs: &[
      DetectorInput::CustomRegexMatches,
      DetectorInput::FullText,
      DetectorInput::CustomRegexMeta,
    ];
    scales: &[
      DetectorInput::CustomRegexMatches,
      DetectorInput::FullText,
    ];
    active: custom_regex_is_active;
    detect: detect_custom_regex;
  }
}

fn regex_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.regex_is_active()
}

fn custom_regex_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  context.custom_regex_is_active()
}

fn detect_regex(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| context.detect_regex())
}

fn detect_custom_regex(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| context.detect_custom_regex())
}
