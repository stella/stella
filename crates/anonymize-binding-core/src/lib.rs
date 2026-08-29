//! Runtime-neutral operations shared by native and WebAssembly bindings.
//!
//! Host adapters own transport concerns such as JavaScript objects, buffers,
//! callbacks, and synchronization. This crate owns the preparation, redaction,
//! UTF-16 conversion, and session workflows so every binding executes the same
//! logic.

use serde::Serialize;
pub use stella_anonymize_adapter_contract::CALLER_DETECTION_MAX_COUNT;
use stella_anonymize_adapter_contract::{
  BindingCallerDetectionRequest, BindingOperatorConfig,
  BindingPreparedSearchConfig, BindingStaticRedactionPlanResult,
  BindingStaticRedactionResult, ContractError, assemble_static_search_config,
  caller_detections_from_utf16_binding, diagnostic_events_to_utf16_binding,
  operator_config_from_binding, prepared_search_config_from_binding,
  prepared_search_core_package_to_bytes,
  prepared_search_core_package_to_compressed_bytes,
  prepared_search_core_package_view_from_bytes_with_timings,
  prepared_search_core_package_view_trusted_from_bytes_with_timings,
  prepared_search_package_from_bytes, prepared_search_package_has_core_payload,
  static_redaction_diagnostic_result_to_utf16_binding,
  static_redaction_diagnostics_to_binding,
  static_redaction_plan_result_to_utf16_binding,
  static_redaction_result_to_utf16_binding,
  static_redaction_stream_event_to_utf16_binding,
};
use stella_anonymize_core::{
  CallerDetection, CallerRedactionOptions, DiagnosticDetail,
  Error as CoreError, OpenSessionArchiveOptions, OperatorConfig,
  PreparedEngine, PreparedEngineArtifactsView,
  PreparedSessionCallerRedactionOptions, PreparedSessionRedactionOptions,
  REDACTION_SESSION_ARCHIVE_KEY_BYTES, REDACTION_SESSION_ARCHIVE_MAX_BYTES,
  RedactionSession, SessionArchiveKey, SessionId, SessionLifecycle,
  SessionStatus, SessionTimestamp, StaticRedactionDiagnostics,
  assemble::{AssembleError, Dictionaries, GazetteerEntry, PipelineConfig},
};

/// Failure produced by runtime-neutral binding operations.
#[derive(Debug, thiserror::Error)]
pub enum BindingFacadeError {
  #[error(transparent)]
  Assemble(#[from] AssembleError),
  #[error(transparent)]
  Contract(#[from] ContractError),
  #[error(transparent)]
  Core(#[from] CoreError),
  #[error(
    "Redaction session archive key must contain exactly {expected_bytes} bytes"
  )]
  InvalidSessionArchiveKeyLength {
    actual_bytes: usize,
    expected_bytes: usize,
  },
  #[error("Redaction session archive exceeds byte limit")]
  SessionArchiveLimitExceeded {
    actual_bytes: usize,
    max_bytes: usize,
  },
  #[error("Redaction session changed after the plan was created")]
  SessionPlanConflict,
  #[error("Redaction session plan has already been committed")]
  SessionPlanAlreadyCommitted,
  #[error("{field} contains {actual} items; the maximum is {maximum}")]
  ItemLimitExceeded {
    field: &'static str,
    actual: usize,
    maximum: usize,
  },
  #[error("{field} contains {actual_bytes} bytes; the maximum is {max_bytes}")]
  ByteLimitExceeded {
    field: &'static str,
    actual_bytes: usize,
    max_bytes: usize,
  },
  #[error(transparent)]
  Serialization(#[from] serde_json::Error),
}

/// Caller-assisted operations and plans share the engine's redaction text
/// bound. Redaction itself is bounded by the engine, not restated here, so
/// oversized input yields one error on every runtime.
pub const CALLER_DETECTION_TEXT_MAX_BYTES: usize =
  stella_anonymize_core::REDACTION_TEXT_MAX_BYTES;
/// Maximum encoded bytes accepted by one caller-detection JSON request.
pub const CALLER_DETECTION_REQUEST_JSON_MAX_BYTES: usize = 16 * 1024 * 1024;
/// Maximum number of caller-assisted inputs accepted by one atomic session plan.
pub const SESSION_CALLER_MAX_INPUTS: usize = 100_000;
/// Maximum canonical encoded bytes accepted by one session-plan input batch.
pub const SESSION_CALLER_INPUTS_JSON_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Digest verification policy for a prepared package.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageVerification {
  Trusted,
  Verified,
}

/// Encoding used for newly prepared package bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageEncoding {
  Compressed,
  Plain,
}

/// Fully prepared search state before a host-specific shared pointer is added.
pub struct PreparedBinding {
  engine: PreparedEngine,
  diagnostics: StaticRedactionDiagnostics,
}

impl PreparedBinding {
  /// Prepares an engine from the portable JSON binding contract.
  pub fn from_config_json_bytes(bytes: &[u8]) -> Result<Self> {
    let binding = serde_json::from_slice::<BindingPreparedSearchConfig>(bytes)?;
    let config = prepared_search_config_from_binding(binding)?;
    let prepared = PreparedEngine::new_with_diagnostics(config)?;
    Ok(Self {
      engine: prepared.prepared,
      diagnostics: prepared.diagnostics,
    })
  }

  /// Loads either current core-package bytes or the unversioned binding form.
  pub fn from_package_bytes(
    bytes: &[u8],
    verification: PackageVerification,
  ) -> Result<Self> {
    if prepared_search_package_has_core_payload(bytes) {
      return Self::from_core_package_bytes(bytes, verification);
    }
    Self::from_binding_package_bytes(bytes)
  }

  fn from_core_package_bytes(
    bytes: &[u8],
    verification: PackageVerification,
  ) -> Result<Self> {
    let (package, _) = match verification {
      PackageVerification::Trusted => {
        prepared_search_core_package_view_trusted_from_bytes_with_timings(bytes)
      }
      PackageVerification::Verified => {
        prepared_search_core_package_view_from_bytes_with_timings(bytes)
      }
    }?;
    let artifacts =
      PreparedEngineArtifactsView::from_bytes(package.artifacts.as_bytes())?;
    let prepared = PreparedEngine::new_with_artifact_view_diagnostics(
      package.config,
      &artifacts,
    )?;
    Ok(Self {
      engine: prepared.prepared,
      diagnostics: prepared.diagnostics,
    })
  }

  fn from_binding_package_bytes(bytes: &[u8]) -> Result<Self> {
    let package = prepared_search_package_from_bytes(bytes)?;
    let config = prepared_search_config_from_binding(package.config)?;
    let artifacts =
      PreparedEngineArtifactsView::from_bytes(&package.artifacts)?;
    let prepared =
      PreparedEngine::new_with_artifact_view_diagnostics(config, &artifacts)?;
    Ok(Self {
      engine: prepared.prepared,
      diagnostics: prepared.diagnostics,
    })
  }

  /// Borrows the prepared engine.
  #[must_use]
  pub const fn engine(&self) -> &PreparedEngine {
    &self.engine
  }

  /// Borrows diagnostics produced while preparing the engine.
  #[must_use]
  pub const fn diagnostics(&self) -> &StaticRedactionDiagnostics {
    &self.diagnostics
  }

  /// Splits the facade into values suitable for a host-specific shared pointer.
  #[must_use]
  pub fn into_parts(self) -> (PreparedEngine, StaticRedactionDiagnostics) {
    (self.engine, self.diagnostics)
  }
}

/// Creates prepared package bytes from the portable JSON binding contract.
pub fn prepare_package(
  config_json: &[u8],
  encoding: PackageEncoding,
) -> Result<Vec<u8>> {
  let binding =
    serde_json::from_slice::<BindingPreparedSearchConfig>(config_json)?;
  package_from_binding_config(binding, encoding)
}

/// Assembles static inputs and creates prepared package bytes.
pub fn assemble_package(
  pipeline_config_json: &[u8],
  dictionaries_json: Option<&[u8]>,
  gazetteer_json: Option<&[u8]>,
  encoding: PackageEncoding,
) -> Result<Vec<u8>> {
  let binding =
    assemble_config(pipeline_config_json, dictionaries_json, gazetteer_json)?;
  package_from_binding_config(binding, encoding)
}

/// Assembles static inputs into the typed portable binding config.
pub fn assemble_config(
  pipeline_config_json: &[u8],
  dictionaries_json: Option<&[u8]>,
  gazetteer_json: Option<&[u8]>,
) -> Result<BindingPreparedSearchConfig> {
  let config = serde_json::from_slice::<PipelineConfig>(pipeline_config_json)?;
  let dictionaries = dictionaries_json
    .map(serde_json::from_slice::<Dictionaries>)
    .transpose()?;
  let gazetteer = gazetteer_json
    .map(serde_json::from_slice::<Vec<GazetteerEntry>>)
    .transpose()?
    .unwrap_or_default();
  Ok(assemble_static_search_config(
    &config,
    dictionaries.as_ref(),
    &gazetteer,
  )?)
}

/// Creates prepared package bytes from an already decoded binding config.
pub fn package_from_binding_config(
  binding: BindingPreparedSearchConfig,
  encoding: PackageEncoding,
) -> Result<Vec<u8>> {
  let config = prepared_search_config_from_binding(binding)?;
  let artifacts =
    PreparedEngine::prepare_artifacts(config.clone())?.to_bytes()?;
  match encoding {
    PackageEncoding::Compressed => Ok(
      prepared_search_core_package_to_compressed_bytes(&config, &artifacts)?,
    ),
    PackageEncoding::Plain => {
      Ok(prepared_search_core_package_to_bytes(&config, &artifacts)?)
    }
  }
}

/// Parses optional operators from their portable JSON contract.
pub fn operators_from_json(value: Option<&str>) -> Result<OperatorConfig> {
  let binding = value
    .map(serde_json::from_str::<BindingOperatorConfig>)
    .transpose()?;
  Ok(operator_config_from_binding(binding)?)
}

/// Serializes preparation diagnostics through the portable binding contract.
pub fn prepare_diagnostics_json(
  diagnostics: &StaticRedactionDiagnostics,
) -> Result<String> {
  Ok(serde_json::to_string(
    &static_redaction_diagnostics_to_binding(diagnostics.clone()),
  )?)
}

/// Runs static redaction and returns the portable UTF-16 JSON result.
pub fn redact_json(
  engine: &PreparedEngine,
  full_text: &str,
  operators: &OperatorConfig,
) -> Result<String> {
  let result = engine.redact_static_entities(full_text, operators)?;
  serialize_redaction_result(result, full_text)
}

/// Runs static redaction with caller detections from the portable contract.
pub fn redact_with_caller_detections_json(
  engine: &PreparedEngine,
  full_text: &str,
  request_json: &str,
  operators: &OperatorConfig,
) -> Result<String> {
  let detections = BorrowedValidatedCallerDetections::from_utf16_binding_json(
    request_json,
    full_text,
  )?;
  Ok(serde_json::to_string(&redact_with_validated_parts(
    engine,
    detections.full_text(),
    detections.as_slice(),
    operators,
  )?)?)
}

/// Runs static redaction with caller detections validated at a host boundary.
pub fn redact_with_caller_detections(
  engine: &PreparedEngine,
  detections: &ValidatedCallerDetections,
  operators: &OperatorConfig,
) -> Result<BindingStaticRedactionResult> {
  redact_with_validated_parts(
    engine,
    detections.full_text(),
    detections.as_slice(),
    operators,
  )
}

fn redact_with_validated_parts(
  engine: &PreparedEngine,
  full_text: &str,
  detections: &[CallerDetection],
  operators: &OperatorConfig,
) -> Result<BindingStaticRedactionResult> {
  let result = engine.redact_static_entities_with_caller_detections(
    full_text,
    CallerRedactionOptions {
      operators,
      detections,
    },
  )?;
  Ok(static_redaction_result_to_utf16_binding(result, full_text)?)
}

/// Runs caller-assisted redaction and includes preparation diagnostics.
pub fn redact_with_caller_detections_diagnostics_json(
  engine: &PreparedEngine,
  prepare_diagnostics: &StaticRedactionDiagnostics,
  full_text: &str,
  request_json: &str,
  operators: &OperatorConfig,
) -> Result<String> {
  let detections = BorrowedValidatedCallerDetections::from_utf16_binding_json(
    request_json,
    full_text,
  )?;
  redact_with_validated_parts_diagnostics_json(
    engine,
    prepare_diagnostics,
    detections.full_text(),
    detections.as_slice(),
    operators,
  )
}

/// Runs caller-assisted redaction after host-boundary validation.
pub fn redact_with_validated_caller_detections_diagnostics_json(
  engine: &PreparedEngine,
  prepare_diagnostics: &StaticRedactionDiagnostics,
  detections: &ValidatedCallerDetections,
  operators: &OperatorConfig,
) -> Result<String> {
  redact_with_validated_parts_diagnostics_json(
    engine,
    prepare_diagnostics,
    detections.full_text(),
    detections.as_slice(),
    operators,
  )
}

fn redact_with_validated_parts_diagnostics_json(
  engine: &PreparedEngine,
  prepare_diagnostics: &StaticRedactionDiagnostics,
  full_text: &str,
  detections: &[CallerDetection],
  operators: &OperatorConfig,
) -> Result<String> {
  let mut result = engine
    .redact_static_entities_with_caller_detections_and_diagnostics(
      full_text,
      CallerRedactionOptions {
        operators,
        detections,
      },
    )?;
  prepend_prepare_diagnostics(&mut result.diagnostics, prepare_diagnostics);
  serialize_diagnostic_result(result, full_text)
}

/// Runs static redaction with the selected diagnostic detail.
pub fn redact_diagnostics_json(
  engine: &PreparedEngine,
  prepare_diagnostics: &StaticRedactionDiagnostics,
  full_text: &str,
  operators: &OperatorConfig,
  detail: DiagnosticDetail,
) -> Result<String> {
  let mut result = match detail {
    DiagnosticDetail::Detailed => {
      engine.redact_static_entities_with_diagnostics(full_text, operators)
    }
    DiagnosticDetail::Summary => engine
      .redact_static_entities_with_summary_diagnostics(full_text, operators),
  }?;
  prepend_prepare_diagnostics(&mut result.diagnostics, prepare_diagnostics);
  serialize_diagnostic_result(result, full_text)
}

/// Runs redaction and forwards portable UTF-16 result events synchronously.
pub fn redact_result_stream_json(
  engine: &PreparedEngine,
  full_text: &str,
  operators: &OperatorConfig,
  mut on_event: impl FnMut(String) -> std::result::Result<(), String>,
) -> Result<String> {
  let result = engine.redact_static_entities_with_result_observer(
    full_text,
    operators,
    |event| {
      let event =
        static_redaction_stream_event_to_utf16_binding(event, full_text)
          .map_err(|error| result_observer_error(&error))?;
      let json = serde_json::to_string(&event)
        .map_err(|error| result_observer_error(&error))?;
      on_event(json).map_err(|error| result_observer_error(&error))
    },
  )?;
  serialize_redaction_result(result, full_text)
}

/// Runs redaction and forwards portable UTF-16 diagnostic batches.
pub fn redact_diagnostics_stream_json(
  engine: &PreparedEngine,
  prepare_diagnostics: &StaticRedactionDiagnostics,
  full_text: &str,
  operators: &OperatorConfig,
  mut on_batch: impl FnMut(String) -> std::result::Result<(), String>,
) -> Result<String> {
  stella_anonymize_core::validate_redaction_text(full_text)?;
  if !prepare_diagnostics.events.is_empty() {
    on_batch(prepare_diagnostics_json(prepare_diagnostics)?).map_err(
      |error| BindingFacadeError::Core(diagnostics_observer_error(&error)),
    )?;
  }
  let mut result = engine.redact_static_entities_with_diagnostics_observer(
    full_text,
    operators,
    |events| {
      let events = diagnostic_events_to_utf16_binding(events, full_text)
        .map_err(|error| diagnostics_observer_error(&error))?;
      let json = serde_json::to_string(&events)
        .map_err(|error| diagnostics_observer_error(&error))?;
      on_batch(json).map_err(|error| diagnostics_observer_error(&error))
    },
  )?;
  prepend_prepare_diagnostics(&mut result.diagnostics, prepare_diagnostics);
  serialize_diagnostic_result(result, full_text)
}

/// Caller detections whose contract and offsets were validated at a host boundary.
#[derive(Clone, PartialEq)]
pub struct ValidatedCallerDetections {
  full_text: String,
  detections: Vec<CallerDetection>,
}

struct BorrowedValidatedCallerDetections<'text> {
  full_text: &'text str,
  detections: Vec<CallerDetection>,
}

impl<'text> BorrowedValidatedCallerDetections<'text> {
  fn from_utf16_binding_json(
    request_json: &str,
    full_text: &'text str,
  ) -> Result<Self> {
    let request = caller_detection_request_from_json(request_json)?;
    validate_caller_detection_text(full_text)?;
    let detections = caller_detections_from_utf16_binding(request, full_text)?;
    Ok(Self {
      full_text,
      detections,
    })
  }

  const fn full_text(&self) -> &'text str {
    self.full_text
  }

  fn as_slice(&self) -> &[CallerDetection] {
    &self.detections
  }
}

impl ValidatedCallerDetections {
  /// Validates a portable UTF-16 request and establishes the internal type.
  pub fn from_utf16_binding(
    request: BindingCallerDetectionRequest,
    full_text: String,
  ) -> Result<Self> {
    validate_caller_detection_request(&request)?;
    validate_caller_detection_text(&full_text)?;
    let detections = caller_detections_from_utf16_binding(request, &full_text)?;
    Ok(Self {
      full_text,
      detections,
    })
  }

  fn full_text(&self) -> &str {
    &self.full_text
  }

  fn as_slice(&self) -> &[CallerDetection] {
    &self.detections
  }
}

/// Decodes and bounds an untrusted caller-detection JSON request.
pub fn caller_detection_request_from_json(
  request_json: &str,
) -> Result<BindingCallerDetectionRequest> {
  validate_byte_limit(
    "Caller detection request JSON",
    request_json.len(),
    CALLER_DETECTION_REQUEST_JSON_MAX_BYTES,
  )?;
  let request = serde_json::from_str(request_json)?;
  validate_caller_detection_request(&request)?;
  Ok(request)
}

/// Bounds caller-assisted text before offset conversion or detector execution.
pub const fn validate_caller_detection_text(full_text: &str) -> Result<()> {
  validate_byte_limit(
    "Caller detection text",
    full_text.len(),
    CALLER_DETECTION_TEXT_MAX_BYTES,
  )
}

/// Bounds raw session input JSON before deserialization.
pub const fn validate_session_caller_inputs_json(
  inputs_json: &str,
) -> Result<()> {
  validate_byte_limit(
    "Session caller inputs JSON",
    inputs_json.len(),
    SESSION_CALLER_INPUTS_JSON_MAX_BYTES,
  )
}

#[derive(Clone, PartialEq)]
struct SessionCallerInput {
  detections: ValidatedCallerDetections,
}

/// An aggregate-bounded collection of validated session inputs.
pub struct SessionCallerInputs {
  inputs: Vec<SessionCallerInput>,
  detection_count: usize,
  text_bytes: usize,
  encoded_json_bytes: usize,
}

impl SessionCallerInputs {
  /// Creates a bounded collection with capacity for the decoded input count.
  pub fn with_capacity(capacity: usize) -> Result<Self> {
    validate_item_limit(
      "Session caller inputs",
      capacity,
      SESSION_CALLER_MAX_INPUTS,
    )?;
    Ok(Self {
      inputs: Vec::with_capacity(capacity),
      detection_count: 0,
      text_bytes: 0,
      encoded_json_bytes: 2,
    })
  }

  /// Checks canonical and aggregate limits before decoding and retaining one input.
  pub fn push_utf16_binding_json(
    &mut self,
    request_json: &str,
    full_text: String,
  ) -> Result<()> {
    validate_byte_limit(
      "Caller detection request JSON",
      request_json.len(),
      CALLER_DETECTION_REQUEST_JSON_MAX_BYTES,
    )?;
    validate_caller_detection_text(&full_text)?;
    validate_item_limit(
      "Session caller inputs",
      self.inputs.len().saturating_add(1),
      SESSION_CALLER_MAX_INPUTS,
    )?;
    let encoded_json_bytes = self
      .encoded_json_bytes
      .saturating_add(usize::from(!self.inputs.is_empty()))
      .saturating_add(canonical_session_input_json_bytes(
        &full_text,
        request_json,
      )?);
    validate_byte_limit(
      "Session caller inputs JSON",
      encoded_json_bytes,
      SESSION_CALLER_INPUTS_JSON_MAX_BYTES,
    )?;

    let request = caller_detection_request_from_json(request_json)?;
    let detection_count = self
      .detection_count
      .saturating_add(request.detections.len());
    validate_item_limit(
      "Session caller detections",
      detection_count,
      CALLER_DETECTION_MAX_COUNT,
    )?;
    let text_bytes = self.text_bytes.saturating_add(full_text.len());
    validate_byte_limit(
      "Session caller text",
      text_bytes,
      CALLER_DETECTION_TEXT_MAX_BYTES,
    )?;

    let detections =
      ValidatedCallerDetections::from_utf16_binding(request, full_text)?;
    self.inputs.push(SessionCallerInput { detections });
    self.detection_count = detection_count;
    self.text_bytes = text_bytes;
    self.encoded_json_bytes = encoded_json_bytes;
    Ok(())
  }
}

#[derive(Serialize)]
struct CanonicalSessionCallerInput<'input> {
  full_text: &'input str,
  request_json: &'input str,
}

#[derive(Default)]
struct JsonByteCounter {
  bytes: usize,
}

impl std::io::Write for JsonByteCounter {
  fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
    self.bytes = self.bytes.saturating_add(buffer.len());
    Ok(buffer.len())
  }

  fn flush(&mut self) -> std::io::Result<()> {
    Ok(())
  }
}

fn canonical_session_input_json_bytes(
  full_text: &str,
  request_json: &str,
) -> Result<usize> {
  let mut counter = JsonByteCounter::default();
  serde_json::to_writer(
    &mut counter,
    &CanonicalSessionCallerInput {
      full_text,
      request_json,
    },
  )?;
  Ok(counter.bytes)
}

/// Session inspection data independent of the host runtime.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SessionInspection {
  pub session_id: String,
  pub created_at_epoch_seconds: Option<u32>,
  pub expires_at_epoch_seconds: Option<u32>,
  pub mapping_count: usize,
  pub status: &'static str,
}

/// Result of deleting a session.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SessionDeletion {
  pub session_id: String,
  pub deleted_mapping_count: usize,
}

/// Uncommitted atomic session redaction work.
pub struct PreparedSessionPlan {
  base: RedactionSession,
  planned: Option<RedactionSession>,
  results: Vec<BindingStaticRedactionPlanResult>,
}

impl PreparedSessionPlan {
  /// Returns typed portable results without committing the session state.
  #[must_use]
  pub fn results(&self) -> &[BindingStaticRedactionPlanResult] {
    &self.results
  }

  /// Returns the session snapshot used to detect concurrent changes.
  #[must_use]
  pub const fn base(&self) -> &RedactionSession {
    &self.base
  }

  /// Applies the plan if the target still matches its base snapshot.
  pub fn commit(&mut self, target: &mut RedactionSession) -> Result<()> {
    if self.planned.is_none() {
      return Err(BindingFacadeError::SessionPlanAlreadyCommitted);
    }
    if *target != self.base {
      return Err(BindingFacadeError::SessionPlanConflict);
    }
    let planned = self
      .planned
      .take()
      .ok_or(BindingFacadeError::SessionPlanAlreadyCommitted)?;
    *target = planned;
    Ok(())
  }
}

/// Creates a new session.
pub fn create_session(session_id: String) -> Result<RedactionSession> {
  Ok(RedactionSession::new(SessionId::new(session_id)?))
}

/// Creates a new session with an explicit lifecycle.
pub fn create_session_with_lifecycle(
  session_id: String,
  created_at_epoch_seconds: u32,
  expires_at_epoch_seconds: Option<u32>,
) -> Result<RedactionSession> {
  let lifecycle = SessionLifecycle::new(
    SessionTimestamp::from_epoch_seconds(created_at_epoch_seconds),
    expires_at_epoch_seconds.map(SessionTimestamp::from_epoch_seconds),
  )?;
  Ok(RedactionSession::new_with_lifecycle(
    SessionId::new(session_id)?,
    lifecycle,
  )?)
}

/// Restores a session from plaintext JSON.
pub fn restore_session(plaintext_json: &str) -> Result<RedactionSession> {
  Ok(RedactionSession::from_plaintext_json(plaintext_json)?)
}

/// Restores a session from a bounded encrypted archive.
pub fn restore_encrypted_session(
  archive: &[u8],
  key: &[u8],
  expected_session_id: String,
  observed_at_epoch_seconds: Option<u32>,
) -> Result<RedactionSession> {
  if archive.len() > REDACTION_SESSION_ARCHIVE_MAX_BYTES {
    return Err(BindingFacadeError::SessionArchiveLimitExceeded {
      actual_bytes: archive.len(),
      max_bytes: REDACTION_SESSION_ARCHIVE_MAX_BYTES,
    });
  }
  let key = session_archive_key(key)?;
  let expected_session_id = SessionId::new(expected_session_id)?;
  Ok(RedactionSession::from_encrypted_archive(
    OpenSessionArchiveOptions {
      archive,
      key: &key,
      expected_session_id: &expected_session_id,
      observed_at: observed_at_epoch_seconds
        .map(SessionTimestamp::from_epoch_seconds),
    },
  )?)
}

/// Returns runtime-neutral session inspection data.
pub fn inspect_session(
  session: &RedactionSession,
  observed_at_epoch_seconds: Option<u32>,
) -> Result<SessionInspection> {
  let metadata = session.inspect(
    observed_at_epoch_seconds.map(SessionTimestamp::from_epoch_seconds),
  )?;
  let lifecycle = metadata.lifecycle();
  Ok(SessionInspection {
    session_id: metadata.session_id().as_str().to_owned(),
    created_at_epoch_seconds: lifecycle
      .map(|value| value.created_at().epoch_seconds()),
    expires_at_epoch_seconds: lifecycle
      .and_then(|value| value.expires_at())
      .map(SessionTimestamp::epoch_seconds),
    mapping_count: metadata.mapping_count(),
    status: session_status(metadata.status()),
  })
}

/// Deletes a session and returns portable deletion data.
pub fn delete_session(
  session: &mut RedactionSession,
) -> Result<SessionDeletion> {
  let deletion = session.delete()?;
  Ok(SessionDeletion {
    session_id: deletion.session_id().as_str().to_owned(),
    deleted_mapping_count: deletion.deleted_mapping_count(),
  })
}

/// Restores placeholders in text through a session mapping.
pub fn restore_session_text(
  session: &RedactionSession,
  full_text: &str,
  observed_at_epoch_seconds: Option<u32>,
) -> Result<String> {
  Ok(session.restore_text(
    full_text,
    observed_at_epoch_seconds.map(SessionTimestamp::from_epoch_seconds),
  )?)
}

/// Serializes a session to plaintext JSON.
pub fn plaintext_session_json(
  session: &RedactionSession,
  observed_at_epoch_seconds: Option<u32>,
) -> Result<String> {
  match observed_at_epoch_seconds {
    Some(value) => Ok(
      session
        .to_plaintext_json_at(SessionTimestamp::from_epoch_seconds(value))?,
    ),
    None => Ok(session.to_plaintext_json()?),
  }
}

/// Converts an archive key and encrypts a session.
pub fn encrypted_session_archive(
  session: &RedactionSession,
  key: &[u8],
  observed_at_epoch_seconds: Option<u32>,
) -> Result<Vec<u8>> {
  let key = session_archive_key(key)?;
  match observed_at_epoch_seconds {
    Some(value) => Ok(session.to_encrypted_archive_at(
      &key,
      SessionTimestamp::from_epoch_seconds(value),
    )?),
    None => Ok(session.to_encrypted_archive(&key)?),
  }
}

/// Redacts text while updating a session.
pub fn redact_with_session_json(
  engine: &PreparedEngine,
  session: &mut RedactionSession,
  full_text: &str,
  operators: &OperatorConfig,
  observed_at_epoch_seconds: Option<u32>,
) -> Result<String> {
  let result = engine.redact_static_entities_with_session(
    full_text,
    PreparedSessionRedactionOptions {
      operators,
      session,
      observed_at: observed_at_epoch_seconds
        .map(SessionTimestamp::from_epoch_seconds),
    },
  )?;
  serialize_redaction_result(result, full_text)
}

/// Plans a caller-assisted batch without mutating the target session.
pub fn plan_session_redactions(
  engine: &PreparedEngine,
  session: &RedactionSession,
  inputs: SessionCallerInputs,
  operators: &OperatorConfig,
  observed_at_epoch_seconds: Option<u32>,
) -> Result<PreparedSessionPlan> {
  let base = session.clone();
  let mut planned = base.clone();
  let observed_at =
    observed_at_epoch_seconds.map(SessionTimestamp::from_epoch_seconds);
  let mut results = Vec::with_capacity(inputs.inputs.len());
  for input in inputs.inputs {
    let full_text = input.detections.full_text();
    let result = engine
      .redact_static_entities_with_caller_detections_and_session(
        full_text,
        PreparedSessionCallerRedactionOptions {
          operators,
          detections: input.detections.as_slice(),
          session: &mut planned,
          observed_at,
        },
      )?;
    results.push(static_redaction_plan_result_to_utf16_binding(
      &result, full_text,
    )?);
  }
  Ok(PreparedSessionPlan {
    base,
    planned: Some(planned),
    results,
  })
}

const fn validate_caller_detection_request(
  request: &BindingCallerDetectionRequest,
) -> Result<()> {
  validate_item_limit(
    "Caller detections",
    request.detections.len(),
    CALLER_DETECTION_MAX_COUNT,
  )
}

const fn validate_item_limit(
  field: &'static str,
  actual: usize,
  maximum: usize,
) -> Result<()> {
  if actual > maximum {
    return Err(BindingFacadeError::ItemLimitExceeded {
      field,
      actual,
      maximum,
    });
  }
  Ok(())
}

const fn validate_byte_limit(
  field: &'static str,
  actual_bytes: usize,
  max_bytes: usize,
) -> Result<()> {
  if actual_bytes > max_bytes {
    return Err(BindingFacadeError::ByteLimitExceeded {
      field,
      actual_bytes,
      max_bytes,
    });
  }
  Ok(())
}

fn serialize_redaction_result(
  result: stella_anonymize_core::StaticRedactionResult,
  full_text: &str,
) -> Result<String> {
  Ok(serde_json::to_string(
    &static_redaction_result_to_utf16_binding(result, full_text)?,
  )?)
}

fn serialize_diagnostic_result(
  result: stella_anonymize_core::StaticRedactionDiagnosticResult,
  full_text: &str,
) -> Result<String> {
  Ok(serde_json::to_string(
    &static_redaction_diagnostic_result_to_utf16_binding(result, full_text)?,
  )?)
}

fn prepend_prepare_diagnostics(
  diagnostics: &mut StaticRedactionDiagnostics,
  prepare_diagnostics: &StaticRedactionDiagnostics,
) {
  let mut combined = prepare_diagnostics.clone();
  combined.extend(std::mem::take(diagnostics));
  *diagnostics = combined;
}

fn session_archive_key(bytes: &[u8]) -> Result<SessionArchiveKey> {
  let key = <[u8; REDACTION_SESSION_ARCHIVE_KEY_BYTES]>::try_from(bytes)
    .map_err(|_| BindingFacadeError::InvalidSessionArchiveKeyLength {
      actual_bytes: bytes.len(),
      expected_bytes: REDACTION_SESSION_ARCHIVE_KEY_BYTES,
    })?;
  Ok(SessionArchiveKey::from_bytes(key))
}

const fn session_status(status: SessionStatus) -> &'static str {
  match status {
    SessionStatus::Active => "active",
    SessionStatus::NotYetActive => "not_yet_active",
    SessionStatus::Expired => "expired",
    SessionStatus::Deleted => "deleted",
  }
}

fn result_observer_error(reason: &impl ToString) -> CoreError {
  CoreError::InvalidStaticData {
    field: "binding.result_observer",
    reason: reason.to_string(),
  }
}

fn diagnostics_observer_error(reason: &impl ToString) -> CoreError {
  CoreError::InvalidStaticData {
    field: "binding.diagnostics_observer",
    reason: reason.to_string(),
  }
}

/// Result alias for facade operations.
pub type Result<T> = std::result::Result<T, BindingFacadeError>;

#[cfg(test)]
mod tests {
  use super::*;

  /// One condition, one normalized error. The engine owns the text bound and
  /// the facade forwards it unchanged, so a runtime calling the engine
  /// directly and a runtime going through the facade report the same thing.
  #[test]
  fn oversized_text_surfaces_the_engine_error_unchanged() {
    let max_bytes = stella_anonymize_core::REDACTION_TEXT_MAX_BYTES;
    let oversized = "a".repeat(max_bytes.saturating_add(1));
    let describe = |result: std::result::Result<(), BindingFacadeError>| {
      result
        .err()
        .map(|error| error.to_string())
        .unwrap_or_default()
    };

    let engine_message = describe(
      stella_anonymize_core::validate_redaction_text(&oversized)
        .map_err(BindingFacadeError::from),
    );

    assert_eq!(
      engine_message,
      format!(
        "Text contains {} bytes; the maximum is {max_bytes}",
        oversized.len()
      )
    );
    assert!(
      stella_anonymize_core::validate_redaction_text(
        oversized.get(..max_bytes).unwrap_or_default()
      )
      .is_ok()
    );
  }

  #[test]
  fn oversized_text_is_rejected_before_streaming_prepare_diagnostics()
  -> Result<()> {
    let prepared = PreparedEngine::new_with_diagnostics(
      stella_anonymize_core::PreparedEngineConfig::default(),
    )?;
    assert!(!prepared.diagnostics.events.is_empty());
    let oversized =
      "a".repeat(stella_anonymize_core::REDACTION_TEXT_MAX_BYTES + 1);
    let mut batch_count = 0usize;

    let result = redact_diagnostics_stream_json(
      &prepared.prepared,
      &prepared.diagnostics,
      &oversized,
      &OperatorConfig::default(),
      |_| {
        batch_count = batch_count.saturating_add(1);
        Ok(())
      },
    );

    assert!(matches!(
      result,
      Err(BindingFacadeError::Core(
        CoreError::TextLimitExceeded { .. }
      ))
    ));
    assert_eq!(batch_count, 0);
    Ok(())
  }

  #[test]
  fn archive_key_validation_is_runtime_neutral() {
    let result = session_archive_key(&[0_u8; 31]);
    let message = match &result {
      Ok(_) => String::new(),
      Err(error) => error.to_string(),
    };
    assert_eq!(
      message,
      "Redaction session archive key must contain exactly 32 bytes"
    );
    assert!(matches!(
      result,
      Err(BindingFacadeError::InvalidSessionArchiveKeyLength {
        actual_bytes: 31,
        expected_bytes: REDACTION_SESSION_ARCHIVE_KEY_BYTES,
      })
    ));
  }

  #[test]
  fn failed_plan_commit_can_be_retried() -> Result<()> {
    let base = create_session("base-session".to_owned())?;
    let mut target = create_session("changed-session".to_owned())?;
    let planned = create_session("planned-session".to_owned())?;
    let mut plan = PreparedSessionPlan {
      base: base.clone(),
      planned: Some(planned),
      results: Vec::new(),
    };

    assert!(matches!(
      plan.commit(&mut target),
      Err(BindingFacadeError::SessionPlanConflict)
    ));
    target = base;
    assert!(plan.commit(&mut target).is_ok());
    assert!(matches!(
      plan.commit(&mut target),
      Err(BindingFacadeError::SessionPlanAlreadyCommitted)
    ));
    Ok(())
  }

  #[test]
  fn validated_caller_detections_establish_utf8_offsets_once() -> Result<()> {
    let detections = ValidatedCallerDetections::from_utf16_binding(
      BindingCallerDetectionRequest {
        version:
          stella_anonymize_adapter_contract::CALLER_DETECTION_CONTRACT_VERSION,
        detections: vec![
          stella_anonymize_adapter_contract::BindingCallerDetection {
            start: 2,
            end: 7,
            label: "PERSON".to_owned(),
            score: 1.0,
            provider_id: "test".to_owned(),
            detection_id: "detection-1".to_owned(),
          },
        ],
      },
      "😀Alice".to_owned(),
    )?;

    assert_eq!(detections.as_slice().len(), 1);
    assert_eq!(
      detections
        .as_slice()
        .first()
        .map(|detection| detection.provenance().detection_id()),
      Some("detection-1")
    );
    Ok(())
  }

  #[test]
  fn validated_caller_detections_reject_split_surrogate_offsets() {
    let result = ValidatedCallerDetections::from_utf16_binding(
      BindingCallerDetectionRequest {
        version:
          stella_anonymize_adapter_contract::CALLER_DETECTION_CONTRACT_VERSION,
        detections: vec![
          stella_anonymize_adapter_contract::BindingCallerDetection {
            start: 1,
            end: 2,
            label: "PERSON".to_owned(),
            score: 1.0,
            provider_id: "test".to_owned(),
            detection_id: "detection-1".to_owned(),
          },
        ],
      },
      "😀".to_owned(),
    );

    assert!(matches!(result, Err(BindingFacadeError::Contract(_))));
  }

  #[test]
  fn session_input_builder_rejects_aggregate_limits_before_conversion()
  -> Result<()> {
    let invalid_request = BindingCallerDetectionRequest {
      version:
        stella_anonymize_adapter_contract::CALLER_DETECTION_CONTRACT_VERSION,
      detections: vec![
        stella_anonymize_adapter_contract::BindingCallerDetection {
          start: 1,
          end: 0,
          label: "PERSON".to_owned(),
          score: 1.0,
          provider_id: "test".to_owned(),
          detection_id: "detection-1".to_owned(),
        },
      ],
    };
    let request_json = serde_json::to_string(&invalid_request)?;
    let mut detection_limited = SessionCallerInputs::with_capacity(1)?;
    detection_limited.detection_count = CALLER_DETECTION_MAX_COUNT;
    let detection_result =
      detection_limited.push_utf16_binding_json(&request_json, "x".to_owned());
    assert!(matches!(
      detection_result,
      Err(BindingFacadeError::ItemLimitExceeded {
        field: "Session caller detections",
        actual,
        maximum: CALLER_DETECTION_MAX_COUNT,
      }) if actual == CALLER_DETECTION_MAX_COUNT + 1
    ));

    let mut text_limited = SessionCallerInputs::with_capacity(1)?;
    text_limited.text_bytes = CALLER_DETECTION_TEXT_MAX_BYTES;
    let text_result =
      text_limited.push_utf16_binding_json(&request_json, "x".to_owned());
    assert!(matches!(
      text_result,
      Err(BindingFacadeError::ByteLimitExceeded {
        field: "Session caller text",
        actual_bytes,
        max_bytes: CALLER_DETECTION_TEXT_MAX_BYTES,
      }) if actual_bytes == CALLER_DETECTION_TEXT_MAX_BYTES + 1
    ));

    let mut encoded_limited = SessionCallerInputs::with_capacity(1)?;
    encoded_limited.encoded_json_bytes = SESSION_CALLER_INPUTS_JSON_MAX_BYTES;
    let encoded_result =
      encoded_limited.push_utf16_binding_json("{", "x".to_owned());
    assert!(matches!(
      encoded_result,
      Err(BindingFacadeError::ByteLimitExceeded {
        field: "Session caller inputs JSON",
        actual_bytes,
        max_bytes: SESSION_CALLER_INPUTS_JSON_MAX_BYTES,
      }) if actual_bytes > SESSION_CALLER_INPUTS_JSON_MAX_BYTES
    ));
    Ok(())
  }

  #[test]
  fn session_input_builder_matches_canonical_transport_budget() -> Result<()> {
    let request_json = format!(
      "\n{}\t",
      serde_json::to_string(&BindingCallerDetectionRequest {
        version:
          stella_anonymize_adapter_contract::CALLER_DETECTION_CONTRACT_VERSION,
        detections: Vec::new(),
      })?
    );
    let full_texts = ["quote: \"", "line\n😀"];
    let canonical = full_texts
      .iter()
      .map(|full_text| CanonicalSessionCallerInput {
        full_text,
        request_json: &request_json,
      })
      .collect::<Vec<_>>();
    let expected = serde_json::to_vec(&canonical)?.len();

    let mut inputs = SessionCallerInputs::with_capacity(full_texts.len())?;
    for full_text in full_texts {
      inputs.push_utf16_binding_json(&request_json, full_text.to_owned())?;
    }

    assert_eq!(inputs.encoded_json_bytes, expected);
    Ok(())
  }

  #[test]
  fn borrowed_caller_detections_own_json_validation() {
    let result =
      BorrowedValidatedCallerDetections::from_utf16_binding_json("{", "text");
    assert!(matches!(result, Err(BindingFacadeError::Serialization(_))));
  }
}
