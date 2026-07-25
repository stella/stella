//! Browser-native, single-thread WebAssembly adapter.
//!
//! The exported surface deliberately accepts bytes and JSON strings. Host
//! naming and object-shape adaptation stays in TypeScript; detection,
//! validation, offset conversion, and redaction stay in the shared Rust core.

#![allow(clippy::needless_pass_by_value)] // wasm-bindgen owns optional JS values.

use std::{cell::RefCell, rc::Rc};

use js_sys::{Function, Uint8Array};
use stella_anonymize_adapter_contract::{
  external_detection_batch_to_utf16_caller_request,
  external_detection_limits_json as contract_external_detection_limits_json,
};
use stella_anonymize_binding_core::{
  PackageEncoding, PackageVerification, PreparedBinding, PreparedSessionPlan,
  SessionCallerInput, assemble_config,
  assemble_package as binding_assemble_package, create_session,
  create_session_with_lifecycle, delete_session, encrypted_session_archive,
  inspect_session, operators_from_json, plaintext_session_json,
  plan_session_redactions,
  prepare_diagnostics_json as binding_prepare_diagnostics_json,
  prepare_package as binding_prepare_package,
  redact_diagnostics_json as binding_redact_diagnostics_json,
  redact_diagnostics_stream_json as binding_redact_diagnostics_stream_json,
  redact_json as binding_redact_json,
  redact_result_stream_json as binding_redact_result_stream_json,
  redact_with_caller_detections_diagnostics_json,
  redact_with_caller_detections_json, redact_with_session_json,
  restore_encrypted_session, restore_session, restore_session_text,
};
use stella_anonymize_core::{
  DiagnosticDetail, PreparedEngine, RedactionSession,
  StaticRedactionDiagnostics,
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
use wasm_bindgen::prelude::*;

type WasmResult<T> = Result<T, JsError>;

#[wasm_bindgen(js_name = normalizeForSearch)]
#[must_use]
pub fn normalize_for_search(text: &str) -> String {
  stella_anonymize_core::normalize_for_search(text)
}

#[wasm_bindgen(js_name = nativePackageVersion)]
#[must_use]
pub fn native_package_version() -> String {
  String::from(env!("CARGO_PKG_VERSION"))
}

#[wasm_bindgen(js_name = externalDetectionLimitsJson)]
pub fn external_detection_limits_json() -> WasmResult<String> {
  contract_external_detection_limits_json().map_err(js_error)
}

#[wasm_bindgen(js_name = convertExternalDetectionBatchJson)]
pub fn convert_external_detection_batch_json(
  document: &[u8],
  batch_json: &str,
) -> WasmResult<String> {
  let request =
    external_detection_batch_to_utf16_caller_request(document, batch_json)
      .map_err(js_error)?;
  serde_json::to_string(&request.detections).map_err(js_error)
}

#[wasm_bindgen(js_name = extractDocxTextJson)]
pub fn extract_docx_text_json(document: &[u8]) -> WasmResult<String> {
  let extraction = extract_docx_text_core(document).map_err(js_error)?;
  serde_json::to_string(&extraction).map_err(js_error)
}

#[wasm_bindgen(js_name = rewriteDocxTextNative)]
pub fn rewrite_docx_text_native(
  document: &[u8],
  rewrites_json: &str,
) -> WasmResult<WasmDocumentRewriteResult> {
  let rewrites = serde_json::from_str::<Vec<DocxBlockRewrite>>(rewrites_json)
    .map_err(|error| {
    js_error(format!(
      "invalid-replacement: DOCX rewrite plan is invalid: {error}"
    ))
  })?;
  let result =
    rewrite_docx_text_core(document, &rewrites).map_err(|error| {
      js_error(format!("{}: {error}", docx_rewrite_code(error.code())))
    })?;
  Ok(WasmDocumentRewriteResult {
    document: result.document,
    rewritten_block_count: u32::try_from(result.rewritten_block_count)
      .map_err(js_error)?,
    applied_replacement_count: u32::try_from(result.applied_replacement_count)
      .map_err(js_error)?,
  })
}

#[wasm_bindgen(js_name = planDocxRestorationJson)]
pub fn plan_docx_restoration_json(
  document: &[u8],
  session_id: &str,
) -> WasmResult<String> {
  let plan =
    plan_docx_restoration_core(document, session_id).map_err(|error| {
      js_error(format!("{}: {error}", docx_restoration_code(error.code())))
    })?;
  serde_json::to_string(&plan).map_err(js_error)
}

#[wasm_bindgen(js_name = inspectPdfJson)]
pub fn inspect_pdf_json(
  document: &[u8],
  observations_json: Option<String>,
) -> WasmResult<String> {
  let inspection = if let Some(observations_json) = observations_json {
    validate_pdf_observations_json_byte_length(observations_json.len())
      .map_err(js_error)?;
    let observations =
      serde_json::from_str::<Vec<PdfPageObservation>>(&observations_json)
        .map_err(js_error)?;
    inspect_pdf_with_observations_core(document, observations)
  } else {
    inspect_pdf_core(document)
  }
  .map_err(|error| {
    js_error(format!("{}: {error}", pdf_inspection_code(error.code())))
  })?;
  serde_json::to_string(&inspection).map_err(js_error)
}

#[wasm_bindgen(js_name = rewritePdfRasterFromDetectionsJson)]
pub fn rewrite_pdf_raster_from_detections_json(
  document: &[u8],
  request_json: &str,
  page_pixels: Vec<Uint8Array>,
) -> WasmResult<WasmPdfRasterResult> {
  if request_json.len() > PDF_RASTER_REQUEST_JSON_MAX_BYTES {
    return Err(JsError::new(
      "limit-exceeded: PDF raster request JSON exceeds its byte limit",
    ));
  }
  let request = serde_json::from_str::<PdfRasterRewrite>(request_json)
    .map_err(|error| {
      js_error(format!(
        "invalid-contract: PDF raster contract is invalid: {error}"
      ))
    })?;
  let pixels = page_pixels
    .into_iter()
    .map(|bytes| bytes.to_vec())
    .collect::<Vec<_>>();
  let (document, certificate) =
    rewrite_pdf_raster_from_detections_core(document, &request, &pixels)
      .map_err(|error| {
        js_error(format!("{}: {error}", pdf_raster_code(error.code())))
      })?;
  Ok(WasmPdfRasterResult {
    document,
    certificate_json: serde_json::to_string(&certificate).map_err(js_error)?,
  })
}

#[wasm_bindgen]
pub struct WasmDocumentRewriteResult {
  document: Vec<u8>,
  rewritten_block_count: u32,
  applied_replacement_count: u32,
}

#[wasm_bindgen]
impl WasmDocumentRewriteResult {
  #[wasm_bindgen(getter)]
  #[must_use]
  pub fn document(&self) -> Uint8Array {
    Uint8Array::from(&self.document[..])
  }

  #[wasm_bindgen(getter, js_name = rewrittenBlockCount)]
  #[must_use]
  #[allow(clippy::missing_const_for_fn)] // wasm-bindgen rejects const exports.
  pub fn rewritten_block_count(&self) -> u32 {
    self.rewritten_block_count
  }

  #[wasm_bindgen(getter, js_name = appliedReplacementCount)]
  #[must_use]
  #[allow(clippy::missing_const_for_fn)] // wasm-bindgen rejects const exports.
  pub fn applied_replacement_count(&self) -> u32 {
    self.applied_replacement_count
  }
}

#[wasm_bindgen]
pub struct WasmPdfRasterResult {
  document: Vec<u8>,
  certificate_json: String,
}

#[wasm_bindgen]
impl WasmPdfRasterResult {
  #[wasm_bindgen(getter)]
  #[must_use]
  pub fn document(&self) -> Uint8Array {
    Uint8Array::from(&self.document[..])
  }

  #[wasm_bindgen(getter, js_name = certificateJson)]
  #[must_use]
  pub fn certificate_json(&self) -> String {
    self.certificate_json.clone()
  }
}

#[wasm_bindgen(js_name = prepareStaticSearchPackageBytes)]
pub fn prepare_static_search_package_bytes(
  config_json: &[u8],
) -> WasmResult<Uint8Array> {
  binding_prepare_package(config_json, PackageEncoding::Plain)
    .map(|bytes| Uint8Array::from(&bytes[..]))
    .map_err(js_error)
}

#[wasm_bindgen(js_name = prepareStaticSearchCompressedPackageBytes)]
pub fn prepare_static_search_compressed_package_bytes(
  config_json: &[u8],
) -> WasmResult<Uint8Array> {
  binding_prepare_package(config_json, PackageEncoding::Compressed)
    .map(|bytes| Uint8Array::from(&bytes[..]))
    .map_err(js_error)
}

#[wasm_bindgen(js_name = assembleStaticSearchConfigJson)]
pub fn assemble_static_search_config_json(
  pipeline_config_json: &[u8],
  dictionaries_json: Option<Vec<u8>>,
  gazetteer_json: Option<Vec<u8>>,
) -> WasmResult<Uint8Array> {
  let config = assemble_config(
    pipeline_config_json,
    dictionaries_json.as_deref(),
    gazetteer_json.as_deref(),
  )
  .map_err(js_error)?;
  let bytes = serde_json::to_vec(&config).map_err(js_error)?;
  Ok(Uint8Array::from(&bytes[..]))
}

#[wasm_bindgen(js_name = assembleStaticSearchPackageBytes)]
pub fn assemble_static_search_package_bytes(
  pipeline_config_json: &[u8],
  dictionaries_json: Option<Vec<u8>>,
  gazetteer_json: Option<Vec<u8>>,
) -> WasmResult<Uint8Array> {
  binding_assemble_package(
    pipeline_config_json,
    dictionaries_json.as_deref(),
    gazetteer_json.as_deref(),
    PackageEncoding::Plain,
  )
  .map(|bytes| Uint8Array::from(&bytes[..]))
  .map_err(js_error)
}

#[wasm_bindgen(js_name = assembleStaticSearchCompressedPackageBytes)]
pub fn assemble_static_search_compressed_package_bytes(
  pipeline_config_json: &[u8],
  dictionaries_json: Option<Vec<u8>>,
  gazetteer_json: Option<Vec<u8>>,
) -> WasmResult<Uint8Array> {
  binding_assemble_package(
    pipeline_config_json,
    dictionaries_json.as_deref(),
    gazetteer_json.as_deref(),
    PackageEncoding::Compressed,
  )
  .map(|bytes| Uint8Array::from(&bytes[..]))
  .map_err(js_error)
}

#[wasm_bindgen]
pub struct WasmPreparedSearch {
  inner: Rc<PreparedEngine>,
  prepare_diagnostics: StaticRedactionDiagnostics,
}

#[wasm_bindgen]
impl WasmPreparedSearch {
  #[wasm_bindgen(js_name = fromConfigJsonBytes)]
  pub fn from_config_json_bytes(config_json: &[u8]) -> WasmResult<Self> {
    let prepared =
      PreparedBinding::from_config_json_bytes(config_json).map_err(js_error)?;
    let (inner, prepare_diagnostics) = prepared.into_parts();
    Ok(Self {
      inner: Rc::new(inner),
      prepare_diagnostics,
    })
  }

  #[wasm_bindgen(js_name = fromPreparedPackageBytes)]
  pub fn from_prepared_package_bytes(package_bytes: &[u8]) -> WasmResult<Self> {
    Self::from_package(package_bytes, PackageVerification::Verified)
  }

  #[wasm_bindgen(js_name = fromTrustedPreparedPackageBytes)]
  pub fn from_trusted_prepared_package_bytes(
    package_bytes: &[u8],
  ) -> WasmResult<Self> {
    Self::from_package(package_bytes, PackageVerification::Trusted)
  }

  #[wasm_bindgen(js_name = prepareDiagnosticsJson)]
  pub fn prepare_diagnostics_json(&self) -> WasmResult<String> {
    binding_prepare_diagnostics_json(&self.prepare_diagnostics)
      .map_err(js_error)
  }

  #[wasm_bindgen(js_name = warmLazyRegex)]
  pub fn warm_lazy_regex(&self) -> WasmResult<()> {
    self.inner.warm_lazy_regex().map_err(js_error)
  }

  #[wasm_bindgen(js_name = warmLazyRegexDiagnosticsJson)]
  pub fn warm_lazy_regex_diagnostics_json(&self) -> WasmResult<String> {
    let diagnostics =
      self.inner.warm_lazy_regex_diagnostics().map_err(js_error)?;
    binding_prepare_diagnostics_json(&diagnostics).map_err(js_error)
  }

  #[wasm_bindgen(js_name = createRedactionSession)]
  pub fn create_redaction_session(
    &self,
    session_id: String,
  ) -> WasmResult<WasmPreparedRedactionSession> {
    Ok(WasmPreparedRedactionSession::new(
      Rc::clone(&self.inner),
      create_session(session_id).map_err(js_error)?,
    ))
  }

  #[wasm_bindgen(js_name = createRedactionSessionWithLifecycle)]
  pub fn create_redaction_session_with_lifecycle(
    &self,
    session_id: String,
    created_at_epoch_seconds: u32,
    expires_at_epoch_seconds: Option<u32>,
  ) -> WasmResult<WasmPreparedRedactionSession> {
    Ok(WasmPreparedRedactionSession::new(
      Rc::clone(&self.inner),
      create_session_with_lifecycle(
        session_id,
        created_at_epoch_seconds,
        expires_at_epoch_seconds,
      )
      .map_err(js_error)?,
    ))
  }

  #[wasm_bindgen(js_name = restoreRedactionSession)]
  pub fn restore_redaction_session(
    &self,
    plaintext_json: &str,
  ) -> WasmResult<WasmPreparedRedactionSession> {
    Ok(WasmPreparedRedactionSession::new(
      Rc::clone(&self.inner),
      restore_session(plaintext_json).map_err(js_error)?,
    ))
  }

  #[wasm_bindgen(js_name = restoreEncryptedRedactionSession)]
  pub fn restore_encrypted_redaction_session(
    &self,
    archive: &[u8],
    key: &[u8],
    expected_session_id: String,
    observed_at_epoch_seconds: Option<u32>,
  ) -> WasmResult<WasmPreparedRedactionSession> {
    Ok(WasmPreparedRedactionSession::new(
      Rc::clone(&self.inner),
      restore_encrypted_session(
        archive,
        key,
        expected_session_id,
        observed_at_epoch_seconds,
      )
      .map_err(js_error)?,
    ))
  }

  #[wasm_bindgen(js_name = redactStaticEntitiesJson)]
  pub fn redact_static_entities_json(
    &self,
    full_text: &str,
    operators_json: Option<String>,
  ) -> WasmResult<String> {
    let operators =
      operators_from_json(operators_json.as_deref()).map_err(js_error)?;
    binding_redact_json(&self.inner, full_text, &operators).map_err(js_error)
  }

  #[wasm_bindgen(js_name = redactStaticEntitiesWithCallerDetectionsJson)]
  pub fn redact_static_entities_with_caller_detections_json(
    &self,
    full_text: &str,
    request_json: &str,
    operators_json: Option<String>,
  ) -> WasmResult<String> {
    let operators =
      operators_from_json(operators_json.as_deref()).map_err(js_error)?;
    redact_with_caller_detections_json(
      &self.inner,
      full_text,
      request_json,
      &operators,
    )
    .map_err(js_error)
  }

  #[wasm_bindgen(
    js_name = redactStaticEntitiesWithCallerDetectionsDiagnosticsJson
  )]
  pub fn redact_static_entities_with_caller_detections_diagnostics_json(
    &self,
    full_text: &str,
    request_json: &str,
    operators_json: Option<String>,
  ) -> WasmResult<String> {
    let operators =
      operators_from_json(operators_json.as_deref()).map_err(js_error)?;
    redact_with_caller_detections_diagnostics_json(
      &self.inner,
      &self.prepare_diagnostics,
      full_text,
      request_json,
      &operators,
    )
    .map_err(js_error)
  }

  #[wasm_bindgen(js_name = redactStaticEntitiesDiagnosticsJson)]
  pub fn redact_static_entities_diagnostics_json(
    &self,
    full_text: &str,
    operators_json: Option<String>,
  ) -> WasmResult<String> {
    let operators =
      operators_from_json(operators_json.as_deref()).map_err(js_error)?;
    binding_redact_diagnostics_json(
      &self.inner,
      &self.prepare_diagnostics,
      full_text,
      &operators,
      DiagnosticDetail::Detailed,
    )
    .map_err(js_error)
  }

  #[wasm_bindgen(js_name = redactStaticEntitiesSummaryDiagnosticsJson)]
  pub fn redact_static_entities_summary_diagnostics_json(
    &self,
    full_text: &str,
    operators_json: Option<String>,
  ) -> WasmResult<String> {
    let operators =
      operators_from_json(operators_json.as_deref()).map_err(js_error)?;
    binding_redact_diagnostics_json(
      &self.inner,
      &self.prepare_diagnostics,
      full_text,
      &operators,
      DiagnosticDetail::Summary,
    )
    .map_err(js_error)
  }

  #[wasm_bindgen(js_name = redactStaticEntitiesResultStreamJson)]
  pub fn redact_static_entities_result_stream_json(
    &self,
    full_text: &str,
    operators_json: Option<String>,
    on_event: &Function,
  ) -> WasmResult<String> {
    let operators =
      operators_from_json(operators_json.as_deref()).map_err(js_error)?;
    binding_redact_result_stream_json(
      &self.inner,
      full_text,
      &operators,
      |event_json| {
        on_event
          .call1(&JsValue::UNDEFINED, &JsValue::from_str(&event_json))
          .map(|_| ())
          .map_err(|error| format!("{error:?}"))
      },
    )
    .map_err(js_error)
  }

  #[wasm_bindgen(js_name = redactStaticEntitiesDiagnosticsStreamJson)]
  pub fn redact_static_entities_diagnostics_stream_json(
    &self,
    full_text: &str,
    operators_json: Option<String>,
    on_batch: &Function,
  ) -> WasmResult<String> {
    let operators =
      operators_from_json(operators_json.as_deref()).map_err(js_error)?;
    binding_redact_diagnostics_stream_json(
      &self.inner,
      &self.prepare_diagnostics,
      full_text,
      &operators,
      |batch_json| {
        on_batch
          .call1(&JsValue::UNDEFINED, &JsValue::from_str(&batch_json))
          .map(|_| ())
          .map_err(|error| format!("{error:?}"))
      },
    )
    .map_err(js_error)
  }
}

#[wasm_bindgen]
pub struct WasmPreparedRedactionSession {
  inner: Rc<PreparedEngine>,
  session: Rc<RefCell<RedactionSession>>,
}

#[wasm_bindgen]
impl WasmPreparedRedactionSession {
  #[wasm_bindgen(js_name = sessionId)]
  #[must_use]
  pub fn session_id(&self) -> String {
    self.session.borrow().id().as_str().to_owned()
  }

  #[wasm_bindgen(js_name = mappingCount)]
  pub fn mapping_count(&self) -> WasmResult<u32> {
    u32::try_from(self.session.borrow().mapping_count())
      .map_err(|error| js_error(error.to_string()))
  }

  #[wasm_bindgen(js_name = restoreText)]
  pub fn restore_text(&self, full_text: &str) -> WasmResult<String> {
    restore_session_text(&self.session.borrow(), full_text, None)
      .map_err(js_error)
  }

  #[wasm_bindgen(js_name = restoreTextAt)]
  pub fn restore_text_at(
    &self,
    full_text: &str,
    observed_at_epoch_seconds: u32,
  ) -> WasmResult<String> {
    restore_session_text(
      &self.session.borrow(),
      full_text,
      Some(observed_at_epoch_seconds),
    )
    .map_err(js_error)
  }

  #[wasm_bindgen(js_name = toPlaintextJson)]
  pub fn to_plaintext_json(&self) -> WasmResult<String> {
    plaintext_session_json(&self.session.borrow(), None).map_err(js_error)
  }

  #[wasm_bindgen(js_name = toPlaintextJsonAt)]
  pub fn to_plaintext_json_at(
    &self,
    observed_at_epoch_seconds: u32,
  ) -> WasmResult<String> {
    plaintext_session_json(
      &self.session.borrow(),
      Some(observed_at_epoch_seconds),
    )
    .map_err(js_error)
  }

  #[wasm_bindgen(js_name = toEncryptedArchive)]
  pub fn to_encrypted_archive(&self, key: &[u8]) -> WasmResult<Uint8Array> {
    let archive = encrypted_session_archive(&self.session.borrow(), key, None)
      .map_err(js_error)?;
    Ok(Uint8Array::from(&archive[..]))
  }

  #[wasm_bindgen(js_name = toEncryptedArchiveAt)]
  pub fn to_encrypted_archive_at(
    &self,
    key: &[u8],
    observed_at_epoch_seconds: u32,
  ) -> WasmResult<Uint8Array> {
    let archive = encrypted_session_archive(
      &self.session.borrow(),
      key,
      Some(observed_at_epoch_seconds),
    )
    .map_err(js_error)?;
    Ok(Uint8Array::from(&archive[..]))
  }

  #[wasm_bindgen(js_name = inspectJson)]
  pub fn inspect_json(
    &self,
    observed_at_epoch_seconds: Option<u32>,
  ) -> WasmResult<String> {
    let inspection =
      inspect_session(&self.session.borrow(), observed_at_epoch_seconds)
        .map_err(js_error)?;
    serde_json::to_string(&inspection).map_err(js_error)
  }

  #[wasm_bindgen(js_name = deleteJson)]
  pub fn delete_json(&self) -> WasmResult<String> {
    let deletion =
      delete_session(&mut self.session.borrow_mut()).map_err(js_error)?;
    serde_json::to_string(&deletion).map_err(js_error)
  }

  #[wasm_bindgen(js_name = redactStaticEntitiesJson)]
  pub fn redact_static_entities_json(
    &self,
    full_text: &str,
    operators_json: Option<String>,
  ) -> WasmResult<String> {
    self.redact(full_text, operators_json.as_deref(), None)
  }

  #[wasm_bindgen(js_name = redactStaticEntitiesJsonAt)]
  pub fn redact_static_entities_json_at(
    &self,
    full_text: &str,
    observed_at_epoch_seconds: u32,
    operators_json: Option<String>,
  ) -> WasmResult<String> {
    self.redact(
      full_text,
      operators_json.as_deref(),
      Some(observed_at_epoch_seconds),
    )
  }

  #[wasm_bindgen(js_name = planStaticEntitiesWithCallerDetections)]
  pub fn plan_static_entities_with_caller_detections(
    &self,
    inputs_json: &str,
    operators_json: Option<String>,
    observed_at_epoch_seconds: Option<u32>,
  ) -> WasmResult<WasmPreparedSessionRedactionPlan> {
    let inputs = serde_json::from_str::<Vec<SessionCallerInput>>(inputs_json)
      .map_err(js_error)?;
    let operators =
      operators_from_json(operators_json.as_deref()).map_err(js_error)?;
    let plan = plan_session_redactions(
      &self.inner,
      &self.session.borrow(),
      inputs,
      &operators,
      observed_at_epoch_seconds,
    )
    .map_err(js_error)?;
    let result_json = plan.result_json().to_owned();
    Ok(WasmPreparedSessionRedactionPlan {
      target: Rc::clone(&self.session),
      plan: RefCell::new(plan),
      result_json,
    })
  }
}

impl WasmPreparedRedactionSession {
  fn new(inner: Rc<PreparedEngine>, session: RedactionSession) -> Self {
    Self {
      inner,
      session: Rc::new(RefCell::new(session)),
    }
  }

  fn redact(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
    observed_at_epoch_seconds: Option<u32>,
  ) -> WasmResult<String> {
    let operators = operators_from_json(operators_json).map_err(js_error)?;
    redact_with_session_json(
      &self.inner,
      &mut self.session.borrow_mut(),
      full_text,
      &operators,
      observed_at_epoch_seconds,
    )
    .map_err(js_error)
  }
}

#[wasm_bindgen]
pub struct WasmPreparedSessionRedactionPlan {
  target: Rc<RefCell<RedactionSession>>,
  plan: RefCell<PreparedSessionPlan>,
  result_json: String,
}

#[wasm_bindgen]
impl WasmPreparedSessionRedactionPlan {
  #[wasm_bindgen(js_name = resultJson)]
  #[must_use]
  pub fn result_json(&self) -> String {
    self.result_json.clone()
  }

  pub fn commit(&self) -> WasmResult<()> {
    self
      .plan
      .borrow_mut()
      .commit(&mut self.target.borrow_mut())
      .map_err(js_error)
  }
}

impl WasmPreparedSearch {
  fn from_package(
    package_bytes: &[u8],
    verification: PackageVerification,
  ) -> WasmResult<Self> {
    let prepared =
      PreparedBinding::from_package_bytes(package_bytes, verification)
        .map_err(js_error)?;
    let (inner, prepare_diagnostics) = prepared.into_parts();
    Ok(Self {
      inner: Rc::new(inner),
      prepare_diagnostics,
    })
  }
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

fn js_error(error: impl ToString) -> JsError {
  JsError::new(&error.to_string())
}
