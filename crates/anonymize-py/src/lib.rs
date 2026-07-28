use std::{
  sync::{Arc, Mutex, MutexGuard},
  time::Instant,
};

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyBytes};
use stella_anonymize_adapter_contract::{
  BindingCallerDetectionRequest, BindingOperatorConfig, BindingOperatorEntry,
  BindingPipelineEntity, BindingPreparedSearchConfig, BindingRedactionEntry,
  BindingRedactionResult, BindingStaticRedactionResult, ContractError,
  PreparedSearchPackageDecodeTimings, assemble_static_search_config,
  caller_detections_from_character_binding, diagnostic_events_to_utf16_binding,
  diagnostic_stage_event,
  external_detection_batch_to_character_caller_request_json,
  external_detection_limits_json as contract_external_detection_limits_json,
  operator_config_from_binding, prepared_search_config_from_binding,
  prepared_search_core_package_to_bytes,
  prepared_search_core_package_to_compressed_bytes,
  prepared_search_core_package_view_from_bytes_with_timings,
  prepared_search_core_package_view_trusted_from_bytes_with_timings,
  prepared_search_package_decode_events, prepared_search_package_from_bytes,
  prepared_search_package_has_core_payload,
  static_redaction_diagnostic_result_to_character_binding,
  static_redaction_diagnostic_result_to_utf16_binding,
  static_redaction_diagnostics_to_binding, static_redaction_result_to_binding,
  static_redaction_result_to_utf16_binding,
  static_redaction_stream_event_to_utf16_binding,
};
use stella_anonymize_binding_core::{
  PreparedSessionPlan, SessionCallerInput,
  plan_session_redactions as binding_plan_session_redactions,
};
use stella_anonymize_core::{
  CallerRedactionOptions, DiagnosticDetail, DiagnosticEvent, DiagnosticStage,
  Error as CoreError, OpenSessionArchiveOptions, OperatorConfig,
  PreparedEngine as CorePreparedEngine, PreparedEngineArtifactsView,
  PreparedSessionRedactionOptions, REDACTION_SESSION_ARCHIVE_KEY_BYTES,
  REDACTION_SESSION_ARCHIVE_MAX_BYTES, RedactionSession, SessionArchiveKey,
  SessionId, SessionLifecycle, SessionMetadata, SessionStatus,
  SessionTimestamp, StaticRedactionDiagnostics, StaticRedactionResult,
  assemble::{AssembleError, Dictionaries, GazetteerEntry, PipelineConfig},
};
use stella_anonymize_docx_core::{
  DocxBlockRewrite, DocxRestorationErrorCode, DocxRewriteErrorCode,
  extract_docx_text as extract_docx_text_core,
  plan_docx_restoration as plan_docx_restoration_core,
  rewrite_docx_text as rewrite_docx_text_core,
};
use stella_anonymize_pdf_core::{
  PDF_RASTER_REQUEST_JSON_MAX_BYTES, PdfInspectionErrorCode,
  PdfPageObservation, PdfRasterErrorCode, PdfRasterRewrite,
  inspect_pdf as inspect_pdf_core,
  inspect_pdf_with_observations as inspect_pdf_with_observations_core,
  rewrite_pdf_raster_from_detections as rewrite_pdf_raster_from_detections_core,
  validate_pdf_observations_json_byte_length,
};

#[pyfunction]
fn convert_external_detection_batch(
  document: &[u8],
  batch_json: &str,
) -> PyResult<String> {
  external_detection_batch_to_character_caller_request_json(
    document, batch_json,
  )
  .map_err(|error| PyValueError::new_err(error.to_string()))
}

#[pyfunction]
fn external_detection_limits_json() -> PyResult<String> {
  contract_external_detection_limits_json()
    .map_err(|error| PyValueError::new_err(error.to_string()))
}

#[pyclass(name = "RedactionEntry", get_all, skip_from_py_object)]
#[derive(Clone)]
pub struct PyRedactionEntry {
  placeholder: String,
  original: String,
}

#[pyclass(name = "OperatorEntry", get_all, skip_from_py_object)]
#[derive(Clone)]
pub struct PyOperatorEntry {
  placeholder: String,
  operator: String,
}

#[pyclass(name = "RedactionResult", get_all, skip_from_py_object)]
#[derive(Clone)]
pub struct PyRedactionResult {
  redacted_text: String,
  redaction_map: Vec<PyRedactionEntry>,
  operator_map: Vec<PyOperatorEntry>,
  entity_count: usize,
}

#[pyclass(name = "PipelineEntity", get_all, skip_from_py_object)]
#[derive(Clone)]
pub struct PyPipelineEntity {
  start: u32,
  end: u32,
  label: String,
  text: String,
  score: f64,
  source: String,
  source_detail: Option<String>,
  provider_id: Option<String>,
  detection_id: Option<String>,
}

#[pyclass(name = "StaticRedactionResult", get_all, skip_from_py_object)]
#[derive(Clone)]
pub struct PyStaticRedactionResult {
  resolved_entities: Vec<PyPipelineEntity>,
  redaction: PyRedactionResult,
}

#[pyclass(name = "PreparedSearch")]
pub struct PyPreparedSearch {
  inner: Arc<CorePreparedEngine>,
  prepare_diagnostics: StaticRedactionDiagnostics,
}

#[pyclass(name = "PreparedRedactionSession")]
pub struct PyPreparedRedactionSession {
  inner: Arc<CorePreparedEngine>,
  session: Arc<Mutex<RedactionSession>>,
}

#[pyclass(name = "PreparedSessionRedactionPlan")]
pub struct PyPreparedSessionRedactionPlan {
  target: Arc<Mutex<RedactionSession>>,
  plan: Mutex<PreparedSessionPlan>,
  result_json: String,
}

#[pymethods]
impl PyPreparedSessionRedactionPlan {
  fn result_json(&self) -> String {
    self.result_json.clone()
  }

  fn commit(&self) -> PyResult<()> {
    let mut plan = self.plan.lock().map_err(|_| {
      PyValueError::new_err("Redaction session plan lock is unavailable")
    })?;
    let mut target = self.target.lock().map_err(|_| {
      PyValueError::new_err("Redaction session state lock is unavailable")
    })?;
    plan.commit(&mut target).map_err(to_py_facade_error)?;
    drop(target);
    drop(plan);
    Ok(())
  }
}

#[pymethods]
impl PyPreparedRedactionSession {
  fn session_id(&self) -> PyResult<String> {
    Ok(self.lock_session()?.id().as_str().to_owned())
  }

  fn mapping_count(&self) -> PyResult<usize> {
    Ok(self.lock_session()?.mapping_count())
  }

  #[pyo3(signature = (full_text, observed_at_epoch_seconds=None))]
  fn restore_text(
    &self,
    full_text: &str,
    observed_at_epoch_seconds: Option<u32>,
  ) -> PyResult<String> {
    self
      .lock_session()?
      .restore_text(
        full_text,
        observed_at_epoch_seconds.map(SessionTimestamp::from_epoch_seconds),
      )
      .map_err(|error| to_py_core_error(&error))
  }

  fn to_plaintext_json(&self) -> PyResult<String> {
    self
      .lock_session()?
      .to_plaintext_json()
      .map_err(|error| to_py_core_error(&error))
  }

  fn to_plaintext_json_at(
    &self,
    observed_at_epoch_seconds: u32,
  ) -> PyResult<String> {
    self
      .lock_session()?
      .to_plaintext_json_at(SessionTimestamp::from_epoch_seconds(
        observed_at_epoch_seconds,
      ))
      .map_err(|error| to_py_core_error(&error))
  }

  fn to_encrypted_archive<'py>(
    &self,
    py: Python<'py>,
    key: &[u8],
  ) -> PyResult<Bound<'py, PyBytes>> {
    let key = session_archive_key(key)?;
    let archive = self
      .lock_session()?
      .to_encrypted_archive(&key)
      .map_err(|error| to_py_core_error(&error))?;
    Ok(PyBytes::new(py, &archive))
  }

  fn to_encrypted_archive_at<'py>(
    &self,
    py: Python<'py>,
    key: &[u8],
    observed_at_epoch_seconds: u32,
  ) -> PyResult<Bound<'py, PyBytes>> {
    let key = session_archive_key(key)?;
    let archive = self
      .lock_session()?
      .to_encrypted_archive_at(
        &key,
        SessionTimestamp::from_epoch_seconds(observed_at_epoch_seconds),
      )
      .map_err(|error| to_py_core_error(&error))?;
    Ok(PyBytes::new(py, &archive))
  }

  #[pyo3(signature = (observed_at_epoch_seconds=None))]
  fn inspect_json(
    &self,
    observed_at_epoch_seconds: Option<u32>,
  ) -> PyResult<String> {
    let metadata = {
      let session = self.lock_session()?;
      session
        .inspect(
          observed_at_epoch_seconds.map(SessionTimestamp::from_epoch_seconds),
        )
        .map_err(|error| to_py_core_error(&error))?
    };
    Ok(serialize_py_session_metadata(&metadata))
  }

  fn delete_json(&self) -> PyResult<String> {
    let deletion = {
      let mut session = self.lock_session()?;
      session.delete().map_err(|error| to_py_core_error(&error))?
    };
    Ok(
      serde_json::json!({
        "session_id": deletion.session_id().as_str(),
        "deleted_mapping_count": deletion.deleted_mapping_count(),
      })
      .to_string(),
    )
  }

  #[pyo3(signature = (inputs_json, operators_json=None, observed_at_epoch_seconds=None))]
  fn plan_docx_text_batch(
    &self,
    inputs_json: &str,
    operators_json: Option<&str>,
    observed_at_epoch_seconds: Option<u32>,
  ) -> PyResult<PyPreparedSessionRedactionPlan> {
    let inputs = serde_json::from_str::<Vec<SessionCallerInput>>(inputs_json)
      .map_err(|error| to_py_serde_error(&error))?;
    let operators =
      operator_config_from_binding(parse_operator_config(operators_json)?)
        .map_err(|error| to_py_contract_error(&error))?;
    let session = self.lock_session()?;
    let plan = binding_plan_session_redactions(
      &self.inner,
      &session,
      inputs,
      &operators,
      observed_at_epoch_seconds,
    )
    .map_err(to_py_facade_error)?;
    drop(session);
    let result_json = plan.result_json().to_owned();
    Ok(PyPreparedSessionRedactionPlan {
      target: Arc::clone(&self.session),
      plan: Mutex::new(plan),
      result_json,
    })
  }

  fn redact_static_entities(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<PyStaticRedactionResult> {
    let result =
      self.redact_static_entities_core(full_text, operators_json, None)?;
    static_redaction_result_to_python_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))
      .map(to_py_static_redaction_result)
  }

  fn redact_static_entities_json(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let result =
      self.redact_static_entities_core(full_text, operators_json, None)?;
    let result = static_redaction_result_to_utf16_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))?;
    serde_json::to_string(&result).map_err(|error| to_py_serde_error(&error))
  }

  fn redact_static_entities_at(
    &self,
    full_text: &str,
    observed_at_epoch_seconds: u32,
    operators_json: Option<&str>,
  ) -> PyResult<PyStaticRedactionResult> {
    let result = self.redact_static_entities_core(
      full_text,
      operators_json,
      Some(SessionTimestamp::from_epoch_seconds(
        observed_at_epoch_seconds,
      )),
    )?;
    static_redaction_result_to_python_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))
      .map(to_py_static_redaction_result)
  }

  fn redact_static_entities_json_at(
    &self,
    full_text: &str,
    observed_at_epoch_seconds: u32,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let result = self.redact_static_entities_core(
      full_text,
      operators_json,
      Some(SessionTimestamp::from_epoch_seconds(
        observed_at_epoch_seconds,
      )),
    )?;
    let result = static_redaction_result_to_utf16_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))?;
    serde_json::to_string(&result).map_err(|error| to_py_serde_error(&error))
  }
}

impl PyPreparedRedactionSession {
  fn new(inner: Arc<CorePreparedEngine>, session: RedactionSession) -> Self {
    Self {
      inner,
      session: Arc::new(Mutex::new(session)),
    }
  }

  fn lock_session(&self) -> PyResult<MutexGuard<'_, RedactionSession>> {
    self.session.lock().map_err(|_| {
      PyValueError::new_err("Redaction session state lock is unavailable")
    })
  }

  fn redact_static_entities_core(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
    observed_at: Option<SessionTimestamp>,
  ) -> PyResult<StaticRedactionResult> {
    let operators =
      operator_config_from_binding(parse_operator_config(operators_json)?)
        .map_err(|error| to_py_contract_error(&error))?;
    let mut session = self.lock_session()?;
    self
      .inner
      .redact_static_entities_with_session(
        full_text,
        PreparedSessionRedactionOptions {
          operators: &operators,
          session: &mut session,
          observed_at,
        },
      )
      .map_err(|error| to_py_core_error(&error))
  }
}

fn serialize_py_session_metadata(metadata: &SessionMetadata) -> String {
  let lifecycle = metadata.lifecycle();
  serde_json::json!({
    "session_id": metadata.session_id().as_str(),
    "created_at_epoch_seconds": lifecycle
      .map(|value| value.created_at().epoch_seconds()),
    "expires_at_epoch_seconds": lifecycle
      .and_then(|value| value.expires_at())
      .map(SessionTimestamp::epoch_seconds),
    "mapping_count": metadata.mapping_count(),
    "status": match metadata.status() {
      SessionStatus::Active => "active",
      SessionStatus::NotYetActive => "not_yet_active",
      SessionStatus::Expired => "expired",
      SessionStatus::Deleted => "deleted",
    },
  })
  .to_string()
}

#[pymethods]
impl PyPreparedSearch {
  #[new]
  fn new(config_json: &str) -> PyResult<Self> {
    let config = parse_core_prepared_search_config(config_json)?;
    let result = CorePreparedEngine::new_with_diagnostics(config)
      .map_err(|error| to_py_core_error(&error))?;
    Ok(Self {
      inner: Arc::new(result.prepared),
      prepare_diagnostics: result.diagnostics,
    })
  }

  #[staticmethod]
  fn from_config_json_and_artifact_bytes(
    config_json: &str,
    artifact_bytes: &[u8],
  ) -> PyResult<Self> {
    let config = parse_core_prepared_search_config(config_json)?;
    let artifact_decode_start = Instant::now();
    let artifacts = PreparedEngineArtifactsView::from_bytes(artifact_bytes)
      .map_err(|error| to_py_core_error(&error))?;
    let artifact_decode_elapsed = elapsed_us(artifact_decode_start);
    let result = CorePreparedEngine::new_with_artifact_view_diagnostics(
      config, &artifacts,
    )
    .map_err(|error| to_py_core_error(&error))?;
    let mut diagnostics = StaticRedactionDiagnostics::default();
    diagnostics.events.push(diagnostic_stage_event(
      DiagnosticStage::PrepareArtifactsDecode,
      None,
      Some(artifact_decode_elapsed),
      Some(artifact_bytes.len()),
    ));
    diagnostics.extend(result.diagnostics);
    Ok(Self {
      inner: Arc::new(result.prepared),
      prepare_diagnostics: diagnostics,
    })
  }

  #[staticmethod]
  fn from_prepared_package_bytes(package_bytes: &[u8]) -> PyResult<Self> {
    if prepared_search_package_has_core_payload(package_bytes) {
      let package_decode_start = Instant::now();
      let (package, package_decode_timings) =
        prepared_search_core_package_view_from_bytes_with_timings(
          package_bytes,
        )
        .map_err(|error| to_py_contract_error(&error))?;
      let package_decode_elapsed = elapsed_us(package_decode_start);
      return Self::from_core_package(
        package.config,
        package.artifacts.as_bytes(),
        package_decode_timings,
        package_decode_elapsed,
        package_bytes.len(),
      );
    }

    let package_decode_start = Instant::now();
    let package = prepared_search_package_from_bytes(package_bytes)
      .map_err(|error| to_py_contract_error(&error))?;
    let package_decode_elapsed = elapsed_us(package_decode_start);
    let config = prepared_search_config_from_binding(package.config)
      .map_err(|error| to_py_contract_error(&error))?;
    let artifact_decode_start = Instant::now();
    let artifacts = PreparedEngineArtifactsView::from_bytes(&package.artifacts)
      .map_err(|error| to_py_core_error(&error))?;
    let artifact_decode_elapsed = elapsed_us(artifact_decode_start);
    let result = CorePreparedEngine::new_with_artifact_view_diagnostics(
      config, &artifacts,
    )
    .map_err(|error| to_py_core_error(&error))?;
    let mut diagnostics = package_prepare_diagnostics(
      package_decode_elapsed,
      PreparedSearchPackageDecodeTimings::default(),
      package_bytes.len(),
    );
    diagnostics.events.push(diagnostic_stage_event(
      DiagnosticStage::PrepareArtifactsDecode,
      None,
      Some(artifact_decode_elapsed),
      Some(package.artifacts.len()),
    ));
    diagnostics.extend(result.diagnostics);
    Ok(Self {
      inner: Arc::new(result.prepared),
      prepare_diagnostics: diagnostics,
    })
  }

  #[staticmethod]
  fn from_trusted_prepared_package_bytes(
    package_bytes: &[u8],
  ) -> PyResult<Self> {
    if prepared_search_package_has_core_payload(package_bytes) {
      let package_decode_start = Instant::now();
      let (package, package_decode_timings) =
        prepared_search_core_package_view_trusted_from_bytes_with_timings(
          package_bytes,
        )
        .map_err(|error| to_py_contract_error(&error))?;
      let package_decode_elapsed = elapsed_us(package_decode_start);
      return Self::from_core_package(
        package.config,
        package.artifacts.as_bytes(),
        package_decode_timings,
        package_decode_elapsed,
        package_bytes.len(),
      );
    }

    Self::from_prepared_package_bytes(package_bytes)
  }

  #[staticmethod]
  fn from_trusted_prepared_package_bytes_without_cache(
    package_bytes: &[u8],
  ) -> PyResult<Self> {
    Self::from_trusted_prepared_package_bytes(package_bytes)
  }

  fn prepare_diagnostics_json(&self) -> PyResult<String> {
    let diagnostics =
      static_redaction_diagnostics_to_binding(self.prepare_diagnostics.clone());

    serde_json::to_string(&diagnostics)
      .map_err(|error| to_py_serde_error(&error))
  }

  fn warm_lazy_regex(&self) -> PyResult<()> {
    self
      .inner
      .warm_lazy_regex()
      .map_err(|error| to_py_core_error(&error))
  }

  fn warm_lazy_regex_diagnostics_json(&self) -> PyResult<String> {
    let diagnostics = self
      .inner
      .warm_lazy_regex_diagnostics()
      .map_err(|error| to_py_core_error(&error))?;
    let diagnostics = static_redaction_diagnostics_to_binding(diagnostics);

    serde_json::to_string(&diagnostics)
      .map_err(|error| to_py_serde_error(&error))
  }

  fn create_redaction_session(
    &self,
    session_id: &str,
  ) -> PyResult<PyPreparedRedactionSession> {
    let session_id = SessionId::new(session_id.to_owned())
      .map_err(|error| to_py_core_error(&error))?;
    Ok(PyPreparedRedactionSession::new(
      Arc::clone(&self.inner),
      RedactionSession::new(session_id),
    ))
  }

  #[pyo3(signature = (session_id, created_at_epoch_seconds, expires_at_epoch_seconds=None))]
  fn create_redaction_session_with_lifecycle(
    &self,
    session_id: &str,
    created_at_epoch_seconds: u32,
    expires_at_epoch_seconds: Option<u32>,
  ) -> PyResult<PyPreparedRedactionSession> {
    let session_id = SessionId::new(session_id.to_owned())
      .map_err(|error| to_py_core_error(&error))?;
    let lifecycle = SessionLifecycle::new(
      SessionTimestamp::from_epoch_seconds(created_at_epoch_seconds),
      expires_at_epoch_seconds.map(SessionTimestamp::from_epoch_seconds),
    )
    .map_err(|error| to_py_core_error(&error))?;
    let session = RedactionSession::new_with_lifecycle(session_id, lifecycle)
      .map_err(|error| to_py_core_error(&error))?;
    Ok(PyPreparedRedactionSession::new(
      Arc::clone(&self.inner),
      session,
    ))
  }

  fn restore_redaction_session(
    &self,
    plaintext_json: &str,
  ) -> PyResult<PyPreparedRedactionSession> {
    let session = RedactionSession::from_plaintext_json(plaintext_json)
      .map_err(|error| to_py_core_error(&error))?;
    Ok(PyPreparedRedactionSession::new(
      Arc::clone(&self.inner),
      session,
    ))
  }

  #[pyo3(signature = (archive, key, expected_session_id, observed_at_epoch_seconds=None))]
  fn restore_encrypted_redaction_session(
    &self,
    archive: &[u8],
    key: &[u8],
    expected_session_id: &str,
    observed_at_epoch_seconds: Option<u32>,
  ) -> PyResult<PyPreparedRedactionSession> {
    let key = session_archive_key(key)?;
    let expected_session_id = SessionId::new(expected_session_id.to_owned())
      .map_err(|error| to_py_core_error(&error))?;
    let archive = session_archive_bytes(archive)?;
    let session =
      RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
        archive: &archive,
        key: &key,
        expected_session_id: &expected_session_id,
        observed_at: observed_at_epoch_seconds
          .map(SessionTimestamp::from_epoch_seconds),
      })
      .map_err(|error| to_py_core_error(&error))?;
    Ok(PyPreparedRedactionSession::new(
      Arc::clone(&self.inner),
      session,
    ))
  }

  fn redact_static_entities(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<PyStaticRedactionResult> {
    let result = self.redact_static_entities_core(full_text, operators_json)?;
    static_redaction_result_to_python_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))
      .map(to_py_static_redaction_result)
  }

  fn redact_static_entities_json(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let result = self.redact_static_entities_core(full_text, operators_json)?;
    let result = static_redaction_result_to_utf16_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))?;
    serde_json::to_string(&result).map_err(|error| to_py_serde_error(&error))
  }

  #[pyo3(signature = (full_text, request_json, operators_json=None))]
  fn redact_static_entities_with_caller_detections(
    &self,
    full_text: &str,
    request_json: &str,
    operators_json: Option<&str>,
  ) -> PyResult<PyStaticRedactionResult> {
    let result = self.redact_static_entities_with_caller_detections_core(
      full_text,
      request_json,
      operators_json,
    )?;
    static_redaction_result_to_python_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))
      .map(to_py_static_redaction_result)
  }

  #[pyo3(signature = (full_text, request_json, operators_json=None))]
  fn redact_static_entities_with_caller_detections_json(
    &self,
    full_text: &str,
    request_json: &str,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let result = self.redact_static_entities_with_caller_detections_core(
      full_text,
      request_json,
      operators_json,
    )?;
    let result = static_redaction_result_to_python_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))?;
    serde_json::to_string(&result).map_err(|error| to_py_serde_error(&error))
  }

  #[pyo3(signature = (full_text, request_json, operators_json=None))]
  fn redact_static_entities_with_caller_detections_diagnostics_json(
    &self,
    full_text: &str,
    request_json: &str,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let request =
      serde_json::from_str::<BindingCallerDetectionRequest>(request_json)
        .map_err(|error| to_py_serde_error(&error))?;
    let detections =
      caller_detections_from_character_binding(request, full_text)
        .map_err(|error| to_py_contract_error(&error))?;
    let operators =
      operator_config_from_binding(parse_operator_config(operators_json)?)
        .map_err(|error| to_py_contract_error(&error))?;
    let mut result = self
      .inner
      .redact_static_entities_with_caller_detections_and_diagnostics(
        full_text,
        CallerRedactionOptions {
          operators: &operators,
          detections: &detections,
        },
      )
      .map_err(|error| to_py_core_error(&error))?;
    let mut diagnostics = self.prepare_diagnostics.clone();
    diagnostics.extend(result.diagnostics);
    result.diagnostics = diagnostics;
    let result = static_redaction_diagnostic_result_to_character_binding(
      result, full_text,
    )
    .map_err(|error| to_py_contract_error(&error))?;
    serde_json::to_string(&result).map_err(|error| to_py_serde_error(&error))
  }

  fn redact_static_entities_result_stream_json(
    &self,
    full_text: &str,
    on_event: &Bound<'_, PyAny>,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let operators = parse_operator_config(operators_json)?;
    let operators = operator_config_from_binding(operators)
      .map_err(|error| to_py_contract_error(&error))?;
    let result = self
      .inner
      .redact_static_entities_with_result_observer(
        full_text,
        &operators,
        |event| {
          let event_json = result_stream_event_json(event, full_text)?;
          on_event
            .call1((event_json,))
            .map_err(|error| core_result_observer_error(error.to_string()))?;
          Ok(())
        },
      )
      .map_err(|error| to_py_core_error(&error))?;
    let result = static_redaction_result_to_utf16_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))?;

    serde_json::to_string(&result).map_err(|error| to_py_serde_error(&error))
  }

  fn redact_static_entities_diagnostics_json(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let operators = parse_operator_config(operators_json)?;
    self.redact_static_entities_diagnostics_json_inner(
      full_text,
      &operator_config_from_binding(operators)
        .map_err(|error| to_py_contract_error(&error))?,
      DiagnosticDetail::Detailed,
    )
  }

  fn redact_static_entities_summary_diagnostics_json(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let operators = parse_operator_config(operators_json)?;
    self.redact_static_entities_diagnostics_json_inner(
      full_text,
      &operator_config_from_binding(operators)
        .map_err(|error| to_py_contract_error(&error))?,
      DiagnosticDetail::Summary,
    )
  }

  fn redact_static_entities_diagnostics_stream_json(
    &self,
    full_text: &str,
    on_batch: &Bound<'_, PyAny>,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let operators = parse_operator_config(operators_json)?;
    let operators = operator_config_from_binding(operators)
      .map_err(|error| to_py_contract_error(&error))?;
    emit_prepare_diagnostics_batch(&self.prepare_diagnostics, on_batch)?;
    let mut result = self
      .inner
      .redact_static_entities_with_diagnostics_observer(
        full_text,
        &operators,
        |events| {
          let batch_json = diagnostic_event_batch_json(events, full_text)?;
          on_batch
            .call1((batch_json,))
            .map_err(|error| core_observer_error(error.to_string()))?;
          Ok(())
        },
      )
      .map_err(|error| to_py_core_error(&error))?;
    let mut diagnostics = self.prepare_diagnostics.clone();
    diagnostics.extend(result.diagnostics);
    result.diagnostics = diagnostics;
    let result =
      static_redaction_diagnostic_result_to_utf16_binding(result, full_text)
        .map_err(|error| to_py_contract_error(&error))?;

    serde_json::to_string(&result).map_err(|error| to_py_serde_error(&error))
  }
}

impl PyPreparedSearch {
  fn redact_static_entities_with_caller_detections_core(
    &self,
    full_text: &str,
    request_json: &str,
    operators_json: Option<&str>,
  ) -> PyResult<StaticRedactionResult> {
    let request =
      serde_json::from_str::<BindingCallerDetectionRequest>(request_json)
        .map_err(|error| to_py_serde_error(&error))?;
    let detections =
      caller_detections_from_character_binding(request, full_text)
        .map_err(|error| to_py_contract_error(&error))?;
    let operators =
      operator_config_from_binding(parse_operator_config(operators_json)?)
        .map_err(|error| to_py_contract_error(&error))?;
    self
      .inner
      .redact_static_entities_with_caller_detections(
        full_text,
        CallerRedactionOptions {
          operators: &operators,
          detections: &detections,
        },
      )
      .map_err(|error| to_py_core_error(&error))
  }

  fn from_core_package(
    config: stella_anonymize_core::PreparedEngineConfig,
    artifact_bytes: &[u8],
    package_decode_timings: PreparedSearchPackageDecodeTimings,
    package_decode_elapsed: u64,
    input_bytes_len: usize,
  ) -> PyResult<Self> {
    let artifact_decode_start = Instant::now();
    let artifacts = PreparedEngineArtifactsView::from_bytes(artifact_bytes)
      .map_err(|error| to_py_core_error(&error))?;
    let artifact_decode = elapsed_us(artifact_decode_start);
    let result = CorePreparedEngine::new_with_artifact_view_diagnostics(
      config, &artifacts,
    )
    .map_err(|error| to_py_core_error(&error))?;
    let mut diagnostics = package_prepare_diagnostics(
      package_decode_elapsed,
      package_decode_timings,
      input_bytes_len,
    );
    diagnostics.events.push(diagnostic_stage_event(
      DiagnosticStage::PrepareArtifactsDecode,
      None,
      Some(artifact_decode),
      Some(artifact_bytes.len()),
    ));
    diagnostics.extend(result.diagnostics);
    Ok(Self {
      inner: Arc::new(result.prepared),
      prepare_diagnostics: diagnostics,
    })
  }

  fn redact_static_entities_diagnostics_json_inner(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
    detail: DiagnosticDetail,
  ) -> PyResult<String> {
    let mut result = match detail {
      DiagnosticDetail::Detailed => self
        .inner
        .redact_static_entities_with_diagnostics(full_text, operators),
      DiagnosticDetail::Summary => self
        .inner
        .redact_static_entities_with_summary_diagnostics(full_text, operators),
    }
    .map_err(|error| to_py_core_error(&error))?;
    let mut diagnostics = self.prepare_diagnostics.clone();
    diagnostics.extend(result.diagnostics);
    result.diagnostics = diagnostics;
    let result =
      static_redaction_diagnostic_result_to_utf16_binding(result, full_text)
        .map_err(|error| to_py_contract_error(&error))?;

    serde_json::to_string(&result).map_err(|error| to_py_serde_error(&error))
  }

  fn redact_static_entities_core(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<StaticRedactionResult> {
    let operators = parse_operator_config(operators_json)?;
    self
      .inner
      .redact_static_entities(
        full_text,
        &operator_config_from_binding(operators)
          .map_err(|error| to_py_contract_error(&error))?,
      )
      .map_err(|error| to_py_core_error(&error))
  }
}

fn package_prepare_diagnostics(
  package_decode_elapsed: u64,
  package_decode_timings: PreparedSearchPackageDecodeTimings,
  input_bytes_len: usize,
) -> StaticRedactionDiagnostics {
  StaticRedactionDiagnostics {
    events: prepared_search_package_decode_events(
      package_decode_elapsed,
      package_decode_timings,
      input_bytes_len,
    ),
    ..StaticRedactionDiagnostics::default()
  }
}

fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}

fn emit_prepare_diagnostics_batch(
  diagnostics: &StaticRedactionDiagnostics,
  on_batch: &Bound<'_, PyAny>,
) -> PyResult<()> {
  if diagnostics.events.is_empty() {
    return Ok(());
  }
  let diagnostics =
    static_redaction_diagnostics_to_binding(diagnostics.clone());
  let batch_json = serde_json::to_string(&diagnostics)
    .map_err(|error| to_py_serde_error(&error))?;
  on_batch.call1((batch_json,))?;
  Ok(())
}

fn diagnostic_event_batch_json(
  events: &[DiagnosticEvent],
  full_text: &str,
) -> stella_anonymize_core::Result<String> {
  let diagnostics = diagnostic_events_to_utf16_binding(events, full_text)
    .map_err(|error| {
      core_observer_error(format!(
        "diagnostic batch conversion failed: {error}"
      ))
    })?;
  serde_json::to_string(&diagnostics).map_err(|error| {
    core_observer_error(format!(
      "diagnostic batch serialization failed: {error}"
    ))
  })
}

fn result_stream_event_json(
  event: stella_anonymize_core::StaticRedactionStreamEvent<'_>,
  full_text: &str,
) -> stella_anonymize_core::Result<String> {
  let event = static_redaction_stream_event_to_utf16_binding(event, full_text)
    .map_err(|error| {
      core_result_observer_error(format!(
        "result event conversion failed: {error}"
      ))
    })?;
  serde_json::to_string(&event).map_err(|error| {
    core_result_observer_error(format!(
      "result event serialization failed: {error}"
    ))
  })
}

const fn core_result_observer_error(reason: String) -> CoreError {
  CoreError::InvalidStaticData {
    field: "result.observer",
    reason,
  }
}

const fn core_observer_error(reason: String) -> CoreError {
  CoreError::InvalidStaticData {
    field: "diagnostics.observer",
    reason,
  }
}

#[pyfunction]
fn redact_static_entities_json(
  config_json: &str,
  full_text: &str,
  operators_json: Option<&str>,
) -> PyResult<String> {
  let prepared = PyPreparedSearch::new(config_json)?;
  prepared.redact_static_entities_json(full_text, operators_json)
}

#[pyfunction]
fn redact_static_entities_result_stream_json(
  config_json: &str,
  full_text: &str,
  on_event: &Bound<'_, PyAny>,
  operators_json: Option<&str>,
) -> PyResult<String> {
  let prepared = PyPreparedSearch::new(config_json)?;
  prepared.redact_static_entities_result_stream_json(
    full_text,
    on_event,
    operators_json,
  )
}

#[pyfunction]
fn prepare_static_search_artifacts_bytes<'py>(
  py: Python<'py>,
  config_json: &str,
) -> PyResult<Bound<'py, PyBytes>> {
  let config = parse_core_prepared_search_config(config_json)?;
  let bytes = CorePreparedEngine::prepare_artifacts(config)
    .and_then(|artifacts| artifacts.to_bytes())
    .map_err(|error| to_py_core_error(&error))?;
  Ok(PyBytes::new(py, &bytes))
}

#[pyfunction]
fn prepare_static_search_package_bytes<'py>(
  py: Python<'py>,
  config_json: &str,
) -> PyResult<Bound<'py, PyBytes>> {
  prepare_static_search_package_bytes_with(py, config_json, false)
}

#[pyfunction]
fn prepare_static_search_compressed_package_bytes<'py>(
  py: Python<'py>,
  config_json: &str,
) -> PyResult<Bound<'py, PyBytes>> {
  prepare_static_search_package_bytes_with(py, config_json, true)
}

fn prepare_static_search_package_bytes_with<'py>(
  py: Python<'py>,
  config_json: &str,
  compressed: bool,
) -> PyResult<Bound<'py, PyBytes>> {
  let binding_config = parse_prepared_search_config(config_json)?;
  let core_config = prepared_search_config_from_binding(binding_config)
    .map_err(|error| to_py_contract_error(&error))?;
  let artifact_bytes =
    CorePreparedEngine::prepare_artifacts(core_config.clone())
      .and_then(|artifacts| artifacts.to_bytes())
      .map_err(|error| to_py_core_error(&error))?;
  let package = if compressed {
    prepared_search_core_package_to_compressed_bytes(
      &core_config,
      &artifact_bytes,
    )
  } else {
    prepared_search_core_package_to_bytes(&core_config, &artifact_bytes)
  };
  let bytes = package.map_err(|error| to_py_contract_error(&error))?;
  Ok(PyBytes::new(py, &bytes))
}

/// Assembles a prepared static-search config from a pipeline config plus
/// out-of-band dictionaries / gazetteer JSON, returning the assembled config as
/// JSON. Mirrors the napi `assembleStaticSearchConfigJson`.
#[pyfunction]
fn assemble_static_search_config_json(
  pipeline_config_json: &str,
  dictionaries_json: Option<&str>,
  gazetteer_json: Option<&str>,
) -> PyResult<String> {
  let config = assemble_binding_config(
    pipeline_config_json,
    dictionaries_json,
    gazetteer_json,
  )?;
  serde_json::to_string(&config).map_err(|error| to_py_serde_error(&error))
}

/// Assembles the config and chains it through the prepare/package path,
/// returning ready-to-load core package bytes. Mirrors the napi
/// `assembleStaticSearchPackageBytes`.
#[pyfunction]
fn assemble_static_search_package_bytes<'py>(
  py: Python<'py>,
  pipeline_config_json: &str,
  dictionaries_json: Option<&str>,
  gazetteer_json: Option<&str>,
) -> PyResult<Bound<'py, PyBytes>> {
  assemble_static_search_package_bytes_with(
    py,
    pipeline_config_json,
    dictionaries_json,
    gazetteer_json,
    false,
  )
}

/// Compressed counterpart of [`assemble_static_search_package_bytes`]. Mirrors
/// the napi `assembleStaticSearchCompressedPackageBytes`.
#[pyfunction]
fn assemble_static_search_compressed_package_bytes<'py>(
  py: Python<'py>,
  pipeline_config_json: &str,
  dictionaries_json: Option<&str>,
  gazetteer_json: Option<&str>,
) -> PyResult<Bound<'py, PyBytes>> {
  assemble_static_search_package_bytes_with(
    py,
    pipeline_config_json,
    dictionaries_json,
    gazetteer_json,
    true,
  )
}

fn assemble_static_search_package_bytes_with<'py>(
  py: Python<'py>,
  pipeline_config_json: &str,
  dictionaries_json: Option<&str>,
  gazetteer_json: Option<&str>,
  compressed: bool,
) -> PyResult<Bound<'py, PyBytes>> {
  let binding_config = assemble_binding_config(
    pipeline_config_json,
    dictionaries_json,
    gazetteer_json,
  )?;
  let core_config = prepared_search_config_from_binding(binding_config)
    .map_err(|error| to_py_contract_error(&error))?;
  let artifact_bytes =
    CorePreparedEngine::prepare_artifacts(core_config.clone())
      .and_then(|artifacts| artifacts.to_bytes())
      .map_err(|error| to_py_core_error(&error))?;
  let package = if compressed {
    prepared_search_core_package_to_compressed_bytes(
      &core_config,
      &artifact_bytes,
    )
  } else {
    prepared_search_core_package_to_bytes(&core_config, &artifact_bytes)
  };
  let bytes = package.map_err(|error| to_py_contract_error(&error))?;
  Ok(PyBytes::new(py, &bytes))
}

fn assemble_binding_config(
  pipeline_config_json: &str,
  dictionaries_json: Option<&str>,
  gazetteer_json: Option<&str>,
) -> PyResult<BindingPreparedSearchConfig> {
  let config = serde_json::from_str::<PipelineConfig>(pipeline_config_json)
    .map_err(|error| to_py_serde_error(&error))?;
  let dictionaries = dictionaries_json
    .map(serde_json::from_str::<Dictionaries>)
    .transpose()
    .map_err(|error| to_py_serde_error(&error))?;
  let gazetteer = gazetteer_json
    .map(serde_json::from_str::<Vec<GazetteerEntry>>)
    .transpose()
    .map_err(|error| to_py_serde_error(&error))?
    .unwrap_or_default();
  assemble_static_search_config(&config, dictionaries.as_ref(), &gazetteer)
    .map_err(|error| to_py_assemble_error(&error))
}

#[pyfunction]
fn redact_static_entities_diagnostics_json(
  config_json: &str,
  full_text: &str,
  operators_json: Option<&str>,
) -> PyResult<String> {
  let prepared = PyPreparedSearch::new(config_json)?;
  prepared.redact_static_entities_diagnostics_json(full_text, operators_json)
}

#[pyfunction]
fn redact_static_entities_summary_diagnostics_json(
  config_json: &str,
  full_text: &str,
  operators_json: Option<&str>,
) -> PyResult<String> {
  let prepared = PyPreparedSearch::new(config_json)?;
  prepared
    .redact_static_entities_summary_diagnostics_json(full_text, operators_json)
}

#[pyfunction]
fn normalize_for_search(text: &str) -> String {
  stella_anonymize_core::normalize_for_search(text)
}

/// Restores original values by replacing placeholders in redacted text.
/// Mirrors the TypeScript SDK `deanonymise`; entries apply in order.
#[pyfunction]
fn deanonymise(
  redacted_text: &str,
  redaction_map: Vec<(String, String)>,
) -> String {
  let entries = redaction_map
    .into_iter()
    .map(
      |(placeholder, original)| stella_anonymize_core::RedactionEntry {
        placeholder,
        original,
      },
    )
    .collect::<Vec<_>>();
  stella_anonymize_core::deanonymise(redacted_text, &entries)
}

#[pyfunction]
#[allow(clippy::missing_const_for_fn)]
fn native_package_version() -> &'static str {
  env!("CARGO_PKG_VERSION")
}

fn parse_prepared_search_config(
  config_json: &str,
) -> PyResult<BindingPreparedSearchConfig> {
  serde_json::from_str(config_json).map_err(|error| to_py_serde_error(&error))
}

fn parse_core_prepared_search_config(
  config_json: &str,
) -> PyResult<stella_anonymize_core::PreparedEngineConfig> {
  prepared_search_config_from_binding(parse_prepared_search_config(
    config_json,
  )?)
  .map_err(|error| to_py_contract_error(&error))
}

fn parse_operator_config(
  operators_json: Option<&str>,
) -> PyResult<Option<BindingOperatorConfig>> {
  operators_json
    .map(serde_json::from_str::<BindingOperatorConfig>)
    .transpose()
    .map_err(|error| to_py_serde_error(&error))
}

fn static_redaction_result_to_python_binding(
  result: StaticRedactionResult,
  full_text: &str,
) -> std::result::Result<BindingStaticRedactionResult, ContractError> {
  let offsets = PythonOffsetMap::new(full_text)?;
  let mut result = static_redaction_result_to_binding(result);
  convert_pipeline_entity_offsets_to_python(
    &mut result.resolved_entities,
    &offsets,
  )?;
  Ok(result)
}

fn convert_pipeline_entity_offsets_to_python(
  entities: &mut [BindingPipelineEntity],
  offsets: &PythonOffsetMap,
) -> std::result::Result<(), ContractError> {
  for entity in entities {
    entity.start = offsets.convert(entity.start)?;
    entity.end = offsets.convert(entity.end)?;
  }
  Ok(())
}

struct PythonOffsetMap {
  boundaries: Vec<(u32, u32)>,
}

impl PythonOffsetMap {
  fn new(text: &str) -> std::result::Result<Self, ContractError> {
    let mut boundaries = Vec::new();
    let mut code_point_offset = 0_u32;
    boundaries.push((0, 0));

    for (byte_start, ch) in text.char_indices() {
      code_point_offset =
        code_point_offset.checked_add(1).ok_or_else(|| {
          ContractError::InvalidPreparedSearchPackage {
            reason: String::from("Python offset exceeds u32 range"),
          }
        })?;
      let byte_end = byte_start.saturating_add(ch.len_utf8());
      boundaries.push((u32_from_usize(byte_end)?, code_point_offset));
    }

    Ok(Self { boundaries })
  }

  fn convert(&self, offset: u32) -> std::result::Result<u32, ContractError> {
    self
      .try_convert(offset)
      .ok_or(ContractError::InvalidBindingOffset { offset })
  }

  fn try_convert(&self, offset: u32) -> Option<u32> {
    let index = self
      .boundaries
      .binary_search_by_key(&offset, |(byte_offset, _)| *byte_offset)
      .ok()?;
    self
      .boundaries
      .get(index)
      .map(|(_, code_point_offset)| *code_point_offset)
  }
}

fn u32_from_usize(value: usize) -> std::result::Result<u32, ContractError> {
  u32::try_from(value).map_err(|_| {
    ContractError::InvalidPreparedSearchPackage {
      reason: format!("Offset exceeds u32 range: {value}"),
    }
  })
}

fn to_py_static_redaction_result(
  result: BindingStaticRedactionResult,
) -> PyStaticRedactionResult {
  PyStaticRedactionResult {
    resolved_entities: result
      .resolved_entities
      .into_iter()
      .map(to_py_pipeline_entity)
      .collect(),
    redaction: to_py_redaction_result(result.redaction),
  }
}

fn to_py_pipeline_entity(entity: BindingPipelineEntity) -> PyPipelineEntity {
  PyPipelineEntity {
    start: entity.start,
    end: entity.end,
    label: entity.label,
    text: entity.text,
    score: entity.score,
    source: entity.source,
    source_detail: entity.source_detail,
    provider_id: entity.provider_id,
    detection_id: entity.detection_id,
  }
}

fn to_py_redaction_result(result: BindingRedactionResult) -> PyRedactionResult {
  PyRedactionResult {
    redacted_text: result.redacted_text,
    redaction_map: result
      .redaction_map
      .into_iter()
      .map(to_py_redaction_entry)
      .collect(),
    operator_map: result
      .operator_map
      .into_iter()
      .map(to_py_operator_entry)
      .collect(),
    entity_count: result.entity_count,
  }
}

fn to_py_redaction_entry(entry: BindingRedactionEntry) -> PyRedactionEntry {
  PyRedactionEntry {
    placeholder: entry.placeholder,
    original: entry.original,
  }
}

fn to_py_operator_entry(entry: BindingOperatorEntry) -> PyOperatorEntry {
  PyOperatorEntry {
    placeholder: entry.placeholder,
    operator: entry.operator,
  }
}

fn session_archive_key(bytes: &[u8]) -> PyResult<SessionArchiveKey> {
  let key_bytes = bytes.try_into().map_err(|_| {
    PyValueError::new_err(format!(
      "Encrypted session archive keys must be exactly {REDACTION_SESSION_ARCHIVE_KEY_BYTES} bytes"
    ))
  })?;
  Ok(SessionArchiveKey::from_bytes(key_bytes))
}

fn session_archive_bytes(bytes: &[u8]) -> PyResult<Vec<u8>> {
  if bytes.len() > REDACTION_SESSION_ARCHIVE_MAX_BYTES {
    return Err(PyValueError::new_err(format!(
      "Encrypted session archives must not exceed {REDACTION_SESSION_ARCHIVE_MAX_BYTES} bytes"
    )));
  }
  Ok(bytes.to_vec())
}

fn to_py_core_error(error: &stella_anonymize_core::Error) -> PyErr {
  PyValueError::new_err(error.to_string())
}

#[allow(clippy::needless_pass_by_value)] // `Result::map_err` transfers ownership.
fn to_py_facade_error(
  error: stella_anonymize_binding_core::BindingFacadeError,
) -> PyErr {
  PyValueError::new_err(error.to_string())
}

fn to_py_contract_error(error: &ContractError) -> PyErr {
  PyValueError::new_err(error.to_string())
}

fn to_py_serde_error(error: &serde_json::Error) -> PyErr {
  PyValueError::new_err(error.to_string())
}

fn to_py_assemble_error(error: &AssembleError) -> PyErr {
  PyValueError::new_err(error.to_string())
}

#[pyfunction]
fn extract_docx_text_json(document: &[u8]) -> PyResult<String> {
  let extraction = extract_docx_text_core(document)
    .map_err(|error| PyValueError::new_err(error.to_string()))?;
  serde_json::to_string(&extraction).map_err(|error| to_py_serde_error(&error))
}

const fn pdf_inspection_code(code: PdfInspectionErrorCode) -> &'static str {
  match code {
    PdfInspectionErrorCode::DocumentLimitExceeded => "document-limit-exceeded",
    PdfInspectionErrorCode::InvalidDocument => "invalid-document",
    PdfInspectionErrorCode::InvalidObservation => "invalid-observation",
    PdfInspectionErrorCode::ObservationLimitExceeded => {
      "observation-limit-exceeded"
    }
    PdfInspectionErrorCode::ProviderFailed => "provider-failed",
  }
}

const fn pdf_raster_code(code: PdfRasterErrorCode) -> &'static str {
  match code {
    PdfRasterErrorCode::InvalidContract => "invalid-contract",
    PdfRasterErrorCode::LimitExceeded => "limit-exceeded",
    PdfRasterErrorCode::SourceRejected => "source-rejected",
    PdfRasterErrorCode::VerificationFailed => "verification-failed",
  }
}

#[pyfunction]
#[allow(clippy::needless_pass_by_value)]
fn rewrite_pdf_raster_from_detections_json<'py>(
  py: Python<'py>,
  document: &[u8],
  request_json: &str,
  page_pixels: Vec<Bound<'py, PyBytes>>,
) -> PyResult<(Bound<'py, PyBytes>, String)> {
  if request_json.len() > PDF_RASTER_REQUEST_JSON_MAX_BYTES {
    return Err(PyValueError::new_err(
      "limit-exceeded: PDF raster request JSON exceeds its byte limit",
    ));
  }
  let request = serde_json::from_str::<PdfRasterRewrite>(request_json)
    .map_err(|parse_error| {
      PyValueError::new_err(format!(
        "invalid-contract: PDF raster contract is invalid: {parse_error}"
      ))
    })?;
  let page_pixels = page_pixels
    .iter()
    .map(pyo3::types::PyBytesMethods::as_bytes)
    .collect::<Vec<_>>();
  let (output, certificate) =
    rewrite_pdf_raster_from_detections_core(document, &request, &page_pixels)
      .map_err(|raster_error| {
      PyValueError::new_err(format!(
        "{}: {raster_error}",
        pdf_raster_code(raster_error.code())
      ))
    })?;
  let certificate_json = serde_json::to_string(&certificate)
    .map_err(|error| to_py_serde_error(&error))?;
  Ok((PyBytes::new(py, &output), certificate_json))
}

#[pyfunction]
#[pyo3(signature = (document, observations_json=None))]
fn inspect_pdf_json(
  document: &[u8],
  observations_json: Option<&str>,
) -> PyResult<String> {
  let inspection = if let Some(observations_json) = observations_json {
    validate_pdf_observations_json_byte_length(observations_json.len())
      .map_err(|inspection_error| {
        PyValueError::new_err(format!(
          "{}: {inspection_error}",
          pdf_inspection_code(inspection_error.code())
        ))
      })?;
    let observations =
      serde_json::from_str::<Vec<PdfPageObservation>>(observations_json)
        .map_err(|parse_error| {
          PyValueError::new_err(format!(
            "invalid-observation: PDF observations are invalid: {parse_error}"
          ))
        })?;
    inspect_pdf_with_observations_core(document, observations)
  } else {
    inspect_pdf_core(document)
  }
  .map_err(|inspection_error| {
    PyValueError::new_err(format!(
      "{}: {inspection_error}",
      pdf_inspection_code(inspection_error.code())
    ))
  })?;
  serde_json::to_string(&inspection).map_err(|error| to_py_serde_error(&error))
}

const fn docx_rewrite_code(code: DocxRewriteErrorCode) -> &'static str {
  match code {
    DocxRewriteErrorCode::ArchiveLimitExceeded => "archive-limit-exceeded",
    DocxRewriteErrorCode::InvalidArchive => "invalid-archive",
    DocxRewriteErrorCode::InvalidPackage => "invalid-package",
    DocxRewriteErrorCode::InvalidReplacement => "invalid-replacement",
    DocxRewriteErrorCode::InvalidXml => "invalid-xml",
    DocxRewriteErrorCode::RewriteLimitExceeded => "rewrite-limit-exceeded",
    DocxRewriteErrorCode::StaleExtraction => "stale-extraction",
    DocxRewriteErrorCode::UncompressedLimitExceeded => {
      "uncompressed-limit-exceeded"
    }
    DocxRewriteErrorCode::UnsafeEntryPath => "unsafe-entry-path",
    DocxRewriteErrorCode::UnsupportedReplacement => "unsupported-replacement",
  }
}

const fn docx_restoration_code(code: DocxRestorationErrorCode) -> &'static str {
  match code {
    DocxRestorationErrorCode::InvalidPlaceholder => "invalid-placeholder",
    DocxRestorationErrorCode::RestorationLimitExceeded => {
      "restoration-limit-exceeded"
    }
    DocxRestorationErrorCode::UnsupportedDocument => "unsupported-document",
  }
}

#[pyfunction]
fn rewrite_docx_text_native(
  document: &[u8],
  rewrites_json: &str,
) -> PyResult<(Vec<u8>, usize, usize)> {
  let rewrites = serde_json::from_str::<Vec<DocxBlockRewrite>>(rewrites_json)
    .map_err(|error| {
    PyValueError::new_err(format!(
      "invalid-replacement: DOCX rewrite plan is invalid: {error}"
    ))
  })?;
  let result =
    rewrite_docx_text_core(document, &rewrites).map_err(|error| {
      PyValueError::new_err(format!(
        "{}: {error}",
        docx_rewrite_code(error.code())
      ))
    })?;
  Ok((
    result.document,
    result.rewritten_block_count,
    result.applied_replacement_count,
  ))
}

#[pyfunction]
fn plan_docx_restoration_json(
  document: &[u8],
  session_id: &str,
) -> PyResult<String> {
  let plan =
    plan_docx_restoration_core(document, session_id).map_err(|error| {
      PyValueError::new_err(format!(
        "{}: {error}",
        docx_restoration_code(error.code())
      ))
    })?;
  serde_json::to_string(&plan).map_err(|error| to_py_serde_error(&error))
}

#[pymodule(gil_used = false)]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
  module.add_class::<PyPreparedSearch>()?;
  module.add_class::<PyPreparedRedactionSession>()?;
  module.add_class::<PyPreparedSessionRedactionPlan>()?;
  module.add_class::<PyStaticRedactionResult>()?;
  module.add_class::<PyRedactionResult>()?;
  module.add_class::<PyRedactionEntry>()?;
  module.add_class::<PyOperatorEntry>()?;
  module.add_class::<PyPipelineEntity>()?;
  module.add_function(wrap_pyfunction!(
    convert_external_detection_batch,
    module
  )?)?;
  module
    .add_function(wrap_pyfunction!(external_detection_limits_json, module)?)?;
  module
    .add_function(wrap_pyfunction!(redact_static_entities_json, module)?)?;
  module.add_function(wrap_pyfunction!(
    redact_static_entities_result_stream_json,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    prepare_static_search_artifacts_bytes,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    prepare_static_search_package_bytes,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    prepare_static_search_compressed_package_bytes,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    assemble_static_search_config_json,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    assemble_static_search_package_bytes,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    assemble_static_search_compressed_package_bytes,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    redact_static_entities_diagnostics_json,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    redact_static_entities_summary_diagnostics_json,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(normalize_for_search, module)?)?;
  module.add_function(wrap_pyfunction!(deanonymise, module)?)?;
  module.add_function(wrap_pyfunction!(native_package_version, module)?)?;
  module.add_function(wrap_pyfunction!(extract_docx_text_json, module)?)?;
  module.add_function(wrap_pyfunction!(inspect_pdf_json, module)?)?;
  module.add_function(wrap_pyfunction!(
    rewrite_pdf_raster_from_detections_json,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(rewrite_docx_text_native, module)?)?;
  module.add_function(wrap_pyfunction!(plan_docx_restoration_json, module)?)?;
  Ok(())
}
