//! Decode-timing capture and the diagnostic events derived from it.

use stella_anonymize_core::{
  DiagnosticEvent, DiagnosticEventKind, DiagnosticStage,
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PreparedSearchPackageDecodeTimings {
  pub verify: Option<u64>,
  pub decompress: Option<u64>,
  pub config_decode: Option<u64>,
  pub config_bytes: Option<usize>,
}
#[must_use]
pub const fn diagnostic_stage_event(
  stage: DiagnosticStage,
  count: Option<usize>,
  elapsed_us: Option<u64>,
  input_bytes: Option<usize>,
) -> DiagnosticEvent {
  DiagnosticEvent {
    stage,
    kind: DiagnosticEventKind::StageSummary,
    count,
    slot: None,
    subslot: None,
    pattern_count: None,
    engine: None,
    pattern: None,
    source: None,
    source_detail: None,
    provider_id: None,
    detection_id: None,
    label: None,
    start: None,
    end: None,
    text: None,
    score: None,
    span_valid: None,
    elapsed_us,
    input_bytes,
    artifact_count: None,
    artifact_bytes: None,
    reason: None,
  }
}

#[must_use]
pub fn prepared_search_package_decode_events(
  package_decode_elapsed: u64,
  timings: PreparedSearchPackageDecodeTimings,
  input_bytes_len: usize,
) -> Vec<DiagnosticEvent> {
  let mut events = vec![diagnostic_stage_event(
    DiagnosticStage::PreparePackageDecode,
    None,
    Some(package_decode_elapsed),
    Some(input_bytes_len),
  )];
  events.extend(prepared_search_package_decode_timing_events(
    timings,
    input_bytes_len,
  ));
  events
}

#[must_use]
pub fn prepared_search_package_decode_timing_events(
  timings: PreparedSearchPackageDecodeTimings,
  input_bytes_len: usize,
) -> Vec<DiagnosticEvent> {
  let mut events = Vec::new();
  if let Some(elapsed) = timings.verify {
    events.push(diagnostic_stage_event(
      DiagnosticStage::PreparePackageVerify,
      None,
      Some(elapsed),
      Some(input_bytes_len),
    ));
  }
  if let Some(elapsed) = timings.decompress {
    events.push(diagnostic_stage_event(
      DiagnosticStage::PreparePackageDecompress,
      None,
      Some(elapsed),
      Some(input_bytes_len),
    ));
  }
  if let Some(elapsed) = timings.config_decode {
    let input_bytes = timings.config_bytes.unwrap_or(input_bytes_len);
    events.push(diagnostic_stage_event(
      DiagnosticStage::PreparePackageConfigDecode,
      None,
      Some(elapsed),
      Some(input_bytes),
    ));
  }
  events
}
pub(crate) fn elapsed_us(start: web_time::Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}
