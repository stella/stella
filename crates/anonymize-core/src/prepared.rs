use crate::diagnostics::{DiagnosticEvent, StaticRedactionDiagnostics};
use crate::resolution::CallerDetection;
use crate::session::{RedactionSession, SessionTimestamp};
use crate::types::{OperatorConfig, Result};

mod artifacts;
mod config;
mod config_validation;
mod detection_phase;
mod detector_contract;
mod detectors;
mod diagnostic_stream;
mod engine_state;
mod entity_filter;
mod finding;
mod index_builder;
mod index_patterns;
mod index_prepare;
mod phase;
mod prepare_phase;
mod prepared_document;
mod redaction_phase;
mod resolution_phase;
mod result_stream;
mod results;
mod rule_contract;
mod search_matcher;
mod search_phase;
mod support_prepare;
mod support_resources;
mod support_slots;
mod timing;

pub use artifacts::{PreparedEngineArtifacts, PreparedEngineArtifactsView};
pub use config::{
  PreparedEngineConfig, PreparedEngineDetectorConfig,
  PreparedEnginePolicyConfig, PreparedEngineSearchConfig, PreparedEngineSlices,
};
use diagnostic_stream::DiagnosticEventStream;
use engine_state::{PipelinePolicy, PreparedStaticData, SearchIndexes};
use result_stream::StaticRedactionResultStream;
pub use results::{
  PreparedEngineBuildResult, PreparedEngineMatches, StaticDetectionResult,
  StaticEntityLayers, StaticRedactionDiagnosticResult, StaticRedactionResult,
  StaticRedactionStreamEvent,
};

pub struct PreparedEngine {
  indexes: SearchIndexes,
  policy: PipelinePolicy,
  data: PreparedStaticData,
}

#[derive(Clone, Copy, Debug)]
pub struct CallerRedactionOptions<'a> {
  pub operators: &'a OperatorConfig,
  pub detections: &'a [CallerDetection],
}

pub struct PreparedSessionRedactionOptions<'a> {
  pub operators: &'a OperatorConfig,
  pub session: &'a mut RedactionSession,
  pub observed_at: Option<SessionTimestamp>,
}

pub struct PreparedSessionCallerRedactionOptions<'a> {
  pub operators: &'a OperatorConfig,
  pub detections: &'a [CallerDetection],
  pub session: &'a mut RedactionSession,
  pub observed_at: Option<SessionTimestamp>,
}

impl PreparedEngine {
  /// Redacts built-in and caller-supplied detections in one resolution pass.
  ///
  /// Caller detections appear in `resolved_entities` when retained. The
  /// `detections` field continues to describe only built-in detector output.
  pub fn redact_static_entities_with_caller_detections(
    &self,
    full_text: &str,
    options: CallerRedactionOptions<'_>,
  ) -> Result<StaticRedactionResult> {
    let mut event_stream = DiagnosticEventStream::none();
    let mut result_stream = StaticRedactionResultStream::none();
    self.redact_static_entities_inner(
      full_text,
      options.operators,
      options.detections,
      None,
      &mut event_stream,
      &mut result_stream,
    )
  }

  /// Redacts caller-supplied detections and returns audit-safe diagnostics.
  pub fn redact_static_entities_with_caller_detections_and_diagnostics(
    &self,
    full_text: &str,
    options: CallerRedactionOptions<'_>,
  ) -> Result<StaticRedactionDiagnosticResult> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let mut event_stream = DiagnosticEventStream::none();
    let mut result_stream = StaticRedactionResultStream::none();
    let result = self.redact_static_entities_inner(
      full_text,
      options.operators,
      options.detections,
      Some(&mut diagnostics),
      &mut event_stream,
      &mut result_stream,
    )?;
    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }

  pub fn redact_static_entities(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionResult> {
    let mut event_stream = DiagnosticEventStream::none();
    let mut result_stream = StaticRedactionResultStream::none();
    self.redact_static_entities_inner(
      full_text,
      operators,
      &[],
      None,
      &mut event_stream,
      &mut result_stream,
    )
  }

  /// Redacts prepared detections with stable cross-document placeholders.
  ///
  /// Session state is updated only when detection, resolution, and redaction all
  /// succeed.
  pub fn redact_static_entities_with_session(
    &self,
    full_text: &str,
    options: PreparedSessionRedactionOptions<'_>,
  ) -> Result<StaticRedactionResult> {
    let PreparedSessionRedactionOptions {
      operators,
      session,
      observed_at,
    } = options;
    session.ensure_active(observed_at)?;
    let mut event_stream = DiagnosticEventStream::none();
    let mut result_stream = StaticRedactionResultStream::none();
    self.redact_static_entities_with_session_inner(
      full_text,
      operators,
      &[],
      redaction_phase::StaticRedactionContext {
        session: Some(session),
        observed_at,
        diagnostics: None,
      },
      &mut event_stream,
      &mut result_stream,
    )
  }

  /// Redacts built-in and caller-supplied detections with stable session
  /// placeholders in one resolution pass.
  ///
  /// Session state is updated only when detection, resolution, and redaction all
  /// succeed.
  pub fn redact_static_entities_with_caller_detections_and_session(
    &self,
    full_text: &str,
    options: PreparedSessionCallerRedactionOptions<'_>,
  ) -> Result<StaticRedactionResult> {
    let PreparedSessionCallerRedactionOptions {
      operators,
      detections,
      session,
      observed_at,
    } = options;
    session.ensure_active(observed_at)?;
    let mut event_stream = DiagnosticEventStream::none();
    let mut result_stream = StaticRedactionResultStream::none();
    self.redact_static_entities_with_session_inner(
      full_text,
      operators,
      detections,
      redaction_phase::StaticRedactionContext {
        session: Some(session),
        observed_at,
        diagnostics: None,
      },
      &mut event_stream,
      &mut result_stream,
    )
  }

  pub fn redact_static_entities_with_diagnostics(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionDiagnosticResult> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let mut event_stream = DiagnosticEventStream::none();
    let mut result_stream = StaticRedactionResultStream::none();
    let result = self.redact_static_entities_inner(
      full_text,
      operators,
      &[],
      Some(&mut diagnostics),
      &mut event_stream,
      &mut result_stream,
    )?;

    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }

  pub fn redact_static_entities_with_summary_diagnostics(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionDiagnosticResult> {
    let mut diagnostics = StaticRedactionDiagnostics::summary();
    let mut event_stream = DiagnosticEventStream::none();
    let mut result_stream = StaticRedactionResultStream::none();
    let result = self.redact_static_entities_inner(
      full_text,
      operators,
      &[],
      Some(&mut diagnostics),
      &mut event_stream,
      &mut result_stream,
    )?;

    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }

  pub fn redact_static_entities_with_diagnostics_observer<F>(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
    mut observer: F,
  ) -> Result<StaticRedactionDiagnosticResult>
  where
    F: FnMut(&[DiagnosticEvent]) -> Result<()>,
  {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let mut event_stream = DiagnosticEventStream::observed(&mut observer);
    let mut result_stream = StaticRedactionResultStream::none();
    let result = self.redact_static_entities_inner(
      full_text,
      operators,
      &[],
      Some(&mut diagnostics),
      &mut event_stream,
      &mut result_stream,
    )?;

    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }

  pub fn redact_static_entities_with_result_observer<F>(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
    mut observer: F,
  ) -> Result<StaticRedactionResult>
  where
    F: FnMut(StaticRedactionStreamEvent<'_>) -> Result<()>,
  {
    let mut event_stream = DiagnosticEventStream::none();
    let mut result_stream =
      StaticRedactionResultStream::observed(&mut observer);
    self.redact_static_entities_inner(
      full_text,
      operators,
      &[],
      None,
      &mut event_stream,
      &mut result_stream,
    )
  }
}
