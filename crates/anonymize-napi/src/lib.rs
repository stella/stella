use std::{
  collections::{BTreeMap, VecDeque},
  sync::{Arc, LazyLock, Mutex, MutexGuard},
  time::Instant,
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use stella_anonymize_adapter_contract::{
  BindingCallerDetectionRequest, BindingOperatorConfig, BindingOperatorEntry,
  BindingPreparedSearchConfig, BindingRedactionResult,
  BindingStaticRedactionResult, ContractError,
  PreparedSearchPackageDecodeTimings, assemble_static_search_config,
  caller_detections_from_utf16_binding, diagnostic_stage_event,
  external_detection_batch_to_utf16_caller_request,
  external_detection_limits_json as contract_external_detection_limits_json,
  operator_config_from_binding, prepared_search_config_from_binding,
  prepared_search_core_package_to_bytes,
  prepared_search_core_package_to_compressed_bytes,
  prepared_search_core_package_view_from_bytes_with_timings,
  prepared_search_core_package_view_trusted_from_bytes_with_timings,
  prepared_search_package_decode_timing_events, prepared_search_package_digest,
  prepared_search_package_from_bytes, prepared_search_package_has_core_payload,
  prepared_search_package_verify_digest_with_timings,
  static_redaction_plan_result_to_utf16_binding,
  static_redaction_result_to_utf16_binding,
};
use stella_anonymize_binding_core::{
  PackageEncoding, PreparedBinding,
  operators_from_json as binding_operators_from_json,
  package_from_binding_config as binding_package_from_config,
  prepare_diagnostics_json as binding_prepare_diagnostics_json,
  redact_diagnostics_json as binding_redact_diagnostics_json,
  redact_diagnostics_stream_json as binding_redact_diagnostics_stream_json,
  redact_json as binding_redact_json,
  redact_result_stream_json as binding_redact_result_stream_json,
  redact_with_caller_detections_diagnostics_json,
  redact_with_caller_detections_json,
};
use stella_anonymize_core::{
  DiagnosticDetail, DiagnosticEvent, DiagnosticStage,
  OpenSessionArchiveOptions, OperatorConfig, PreparedEngine,
  PreparedEngineArtifactsView, PreparedEngineConfig,
  PreparedSessionCallerRedactionOptions, PreparedSessionRedactionOptions,
  REDACTION_SESSION_ARCHIVE_KEY_BYTES, REDACTION_SESSION_ARCHIVE_MAX_BYTES,
  RedactionSession, SessionArchiveKey, SessionId, SessionLifecycle,
  SessionMetadata, SessionStatus, SessionTimestamp, StaticRedactionDiagnostics,
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

const PREPARED_SEARCH_CACHE_LIMIT: usize = 8;

#[napi(object)]
pub struct JsExternalCallerDetection {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub score: f64,
  pub provider_id: String,
  pub detection_id: String,
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

#[napi(object)]
pub struct JsPdfRasterResult {
  pub document: Buffer,
  pub certificate_json: String,
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn rewrite_pdf_raster_from_detections_json(
  document: BufferSlice<'_>,
  request_json: String,
  page_pixels: Vec<Uint8Array>,
) -> Result<JsPdfRasterResult> {
  if request_json.len() > PDF_RASTER_REQUEST_JSON_MAX_BYTES {
    return Err(Error::from_reason(
      "limit-exceeded: PDF raster request JSON exceeds its byte limit",
    ));
  }
  let request = serde_json::from_str::<PdfRasterRewrite>(&request_json)
    .map_err(|parse_error| {
      Error::from_reason(format!(
        "invalid-contract: PDF raster contract is invalid: {parse_error}"
      ))
    })?;
  let (output, certificate) =
    rewrite_pdf_raster_from_detections_core(&document, &request, &page_pixels)
      .map_err(|raster_error| {
        Error::from_reason(format!(
          "{}: {raster_error}",
          pdf_raster_code(raster_error.code())
        ))
      })?;
  let certificate_json =
    serde_json::to_string(&certificate).map_err(|serialize_error| {
      Error::from_reason(serialize_error.to_string())
    })?;
  Ok(JsPdfRasterResult {
    document: Buffer::from(output),
    certificate_json,
  })
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn convert_external_detection_batch(
  document: BufferSlice<'_>,
  batch_json: String,
) -> Result<Vec<JsExternalCallerDetection>> {
  let request =
    external_detection_batch_to_utf16_caller_request(&document, &batch_json)
      .map_err(|error| Error::from_reason(error.to_string()))?;
  Ok(
    request
      .detections
      .into_iter()
      .map(|detection| JsExternalCallerDetection {
        start: detection.start,
        end: detection.end,
        label: detection.label,
        score: detection.score,
        provider_id: detection.provider_id,
        detection_id: detection.detection_id,
      })
      .collect(),
  )
}

#[napi]
pub fn external_detection_limits_json() -> Result<String> {
  contract_external_detection_limits_json()
    .map_err(|error| Error::from_reason(error.to_string()))
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn inspect_pdf_json(
  document: BufferSlice<'_>,
  observations_json: Option<String>,
) -> Result<String> {
  let inspection = if let Some(observations_json) = observations_json {
    validate_pdf_observations_json_byte_length(observations_json.len())
      .map_err(|inspection_error| {
        Error::from_reason(format!(
          "{}: {inspection_error}",
          pdf_inspection_code(inspection_error.code())
        ))
      })?;
    let observations =
      serde_json::from_str::<Vec<PdfPageObservation>>(&observations_json)
        .map_err(|parse_error| {
          Error::from_reason(format!(
            "invalid-observation: PDF observations are invalid: {parse_error}"
          ))
        })?;
    inspect_pdf_with_observations_core(&document, observations)
  } else {
    inspect_pdf_core(&document)
  }
  .map_err(|inspection_error| {
    Error::from_reason(format!(
      "{}: {inspection_error}",
      pdf_inspection_code(inspection_error.code())
    ))
  })?;
  serde_json::to_string(&inspection)
    .map_err(|serialize_error| to_napi_serde_error(&serialize_error))
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn extract_docx_text_json(document: BufferSlice<'_>) -> Result<String> {
  let extraction = extract_docx_text_core(&document)
    .map_err(|error| Error::from_reason(error.to_string()))?;
  serde_json::to_string(&extraction)
    .map_err(|error| to_napi_serde_error(&error))
}

#[napi(object)]
pub struct JsDocxRewriteResult {
  pub document: Buffer,
  pub rewritten_block_count: u32,
  pub applied_replacement_count: u32,
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

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn rewrite_docx_text_native(
  document: BufferSlice<'_>,
  rewrites_json: String,
) -> Result<JsDocxRewriteResult> {
  let rewrites = serde_json::from_str::<Vec<DocxBlockRewrite>>(&rewrites_json)
    .map_err(|error| {
      Error::from_reason(format!(
        "invalid-replacement: DOCX rewrite plan is invalid: {error}"
      ))
    })?;
  let result =
    rewrite_docx_text_core(&document, &rewrites).map_err(|error| {
      Error::from_reason(format!(
        "{}: {error}",
        docx_rewrite_code(error.code())
      ))
    })?;
  Ok(JsDocxRewriteResult {
    document: result.document.into(),
    rewritten_block_count: u32::try_from(result.rewritten_block_count)
      .map_err(|_| {
        Error::from_reason("DOCX rewritten block count overflowed")
      })?,
    applied_replacement_count: u32::try_from(result.applied_replacement_count)
      .map_err(|_| Error::from_reason("DOCX replacement count overflowed"))?,
  })
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn plan_docx_restoration_json(
  document: BufferSlice<'_>,
  session_id: String,
) -> Result<String> {
  let plan =
    plan_docx_restoration_core(&document, &session_id).map_err(|error| {
      Error::from_reason(format!(
        "{}: {error}",
        docx_restoration_code(error.code())
      ))
    })?;
  serde_json::to_string(&plan).map_err(|error| to_napi_serde_error(&error))
}

static PREPARED_SEARCH_CACHE: LazyLock<Mutex<PreparedSearchCache>> =
  LazyLock::new(|| Mutex::new(PreparedSearchCache::new()));

struct PreparedSearchCache {
  entries: BTreeMap<[u8; 32], Arc<PreparedEngine>>,
  order: VecDeque<[u8; 32]>,
}

impl PreparedSearchCache {
  const fn new() -> Self {
    Self {
      entries: BTreeMap::new(),
      order: VecDeque::new(),
    }
  }

  fn get(&mut self, key: &[u8; 32]) -> Option<Arc<PreparedEngine>> {
    let entry = self.entries.get(key).cloned()?;
    self.retain_order_without(key);
    self.order.push_back(*key);
    Some(entry)
  }

  fn insert(&mut self, key: [u8; 32], value: Arc<PreparedEngine>) {
    self.entries.insert(key, value);
    self.retain_order_without(&key);
    self.order.push_back(key);

    while self.order.len() > PREPARED_SEARCH_CACHE_LIMIT {
      if let Some(evicted) = self.order.pop_front() {
        self.entries.remove(&evicted);
      }
    }
  }

  fn retain_order_without(&mut self, key: &[u8; 32]) {
    self.order.retain(|entry| entry != key);
  }
}

#[napi(object)]
pub struct JsSearchPattern {
  pub kind: String,
  pub pattern: String,
  pub distance: Option<u32>,
  pub case_insensitive: Option<bool>,
  pub whole_words: Option<bool>,
  pub lazy: Option<bool>,
  pub prefilter_any: Option<Vec<String>>,
  pub prefilter_case_insensitive: Option<bool>,
  pub prefilter_regex: Option<String>,
  pub prefilter_window_bytes: Option<u32>,
  pub prepared_artifact_policy: Option<String>,
}

#[napi(object)]
pub struct JsSearchOptions {
  pub literal_case_insensitive: Option<bool>,
  pub literal_whole_words: Option<bool>,
  pub regex_whole_words: Option<bool>,
  pub regex_overlap_all: Option<bool>,
  pub regex_artifact_policy: Option<String>,
  pub fuzzy_case_insensitive: Option<bool>,
  pub fuzzy_whole_words: Option<bool>,
  pub fuzzy_normalize_diacritics: Option<bool>,
}

#[napi(object)]
pub struct JsPatternSlice {
  pub start: u32,
  pub end: u32,
}

#[napi(object)]
pub struct JsPreparedSearchSlices {
  pub regex: Option<JsPatternSlice>,
  pub custom_regex: Option<JsPatternSlice>,
  pub legal_forms: Option<JsPatternSlice>,
  pub triggers: Option<JsPatternSlice>,
  pub deny_list: Option<JsPatternSlice>,
  pub street_types: Option<JsPatternSlice>,
  pub gazetteer: Option<JsPatternSlice>,
  pub countries: Option<JsPatternSlice>,
}

#[napi(object)]
pub struct JsRegexMatchMeta {
  pub label: String,
  pub score: f64,
  pub source_detail: Option<String>,
  pub requires_validation: Option<bool>,
  pub validator_id: Option<String>,
  pub validator_input: Option<String>,
  pub min_byte_length: Option<u32>,
}

#[napi(object)]
pub struct JsGazetteerMatchData {
  pub labels: Vec<String>,
  pub is_fuzzy: Vec<bool>,
}

#[napi(object)]
pub struct JsCountryMatchData {
  pub labels: Vec<String>,
  #[napi(js_name = "isoCodes")]
  pub iso_codes: Vec<String>,
  pub variants: Vec<String>,
}

#[napi(object)]
pub struct JsDenyListMatchData {
  pub labels: Vec<Vec<String>>,
  pub custom_labels: Vec<Vec<String>>,
  pub originals: Vec<String>,
  pub sources: Vec<Vec<String>>,
  pub filters: Option<JsDenyListFilterData>,
}

#[napi(object)]
pub struct JsDenyListFilterData {
  pub stopwords: Vec<String>,
  pub allow_list: Vec<String>,
  pub person_stopwords: Vec<String>,
  pub person_trailing_nouns: Vec<String>,
  pub address_trailing_nouns: Vec<String>,
  pub address_stopwords: Vec<String>,
  pub address_jurisdiction_prefixes: Vec<String>,
  pub street_types: Vec<String>,
  pub first_names: Vec<String>,
  pub generic_roles: Vec<String>,
  pub page_footer_markers: Vec<String>,
  pub sentence_starters: Vec<String>,
  pub trailing_address_word_exclusions: Vec<String>,
  pub defined_term_cues: Vec<String>,
  pub signing_place_guards: Vec<JsSigningPlaceGuardData>,
}

#[napi(object)]
pub struct JsSigningPlaceGuardData {
  pub prefix_phrases: Vec<String>,
  pub suffix_phrases: Vec<String>,
}

#[napi(object)]
pub struct JsPreparedSearchConfig {
  pub regex_patterns: Vec<JsSearchPattern>,
  pub custom_regex_patterns: Vec<JsSearchPattern>,
  pub literal_patterns: Vec<JsSearchPattern>,
  pub regex_options: Option<JsSearchOptions>,
  pub custom_regex_options: Option<JsSearchOptions>,
  pub literal_options: Option<JsSearchOptions>,
  pub slices: JsPreparedSearchSlices,
  pub regex_meta: Vec<JsRegexMatchMeta>,
  pub custom_regex_meta: Vec<JsRegexMatchMeta>,
  pub deny_list_data: Option<JsDenyListMatchData>,
  pub gazetteer_data: Option<JsGazetteerMatchData>,
  pub country_data: Option<JsCountryMatchData>,
}

#[napi(object)]
pub struct JsOperatorConfig {
  pub operators: Option<serde_json::Value>,
  pub redact_string: Option<String>,
}

#[napi(object)]
pub struct JsCallerRedactionOptions {
  pub request_json: String,
  pub operators: Option<JsOperatorConfig>,
}

#[napi(object)]
pub struct JsRedactionEntry {
  pub placeholder: String,
  pub original: String,
}

#[napi(object)]
pub struct JsOperatorEntry {
  pub placeholder: String,
  pub operator: String,
}

#[napi(object)]
pub struct JsRedactionResult {
  pub redacted_text: String,
  pub redaction_map: Vec<JsRedactionEntry>,
  pub operator_map: Vec<JsOperatorEntry>,
  pub entity_count: u32,
}

#[napi(object)]
pub struct JsPipelineEntity {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub text: String,
  pub score: f64,
  pub source: String,
  pub source_detail: Option<String>,
  pub provider_id: Option<String>,
  pub detection_id: Option<String>,
}

#[napi(object)]
pub struct JsStaticRedactionResult {
  pub resolved_entities: Vec<JsPipelineEntity>,
  pub redaction: JsRedactionResult,
}

#[napi]
#[must_use]
#[allow(clippy::needless_pass_by_value)]
pub fn normalize_for_search(text: String) -> String {
  stella_anonymize_core::normalize_for_search(&text)
}

#[napi]
#[must_use]
pub fn native_package_version() -> String {
  String::from(env!("CARGO_PKG_VERSION"))
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn redact_static_entities_json(
  config_json: String,
  full_text: String,
  operators_json: Option<String>,
) -> Result<String> {
  let prepared =
    PreparedBinding::from_config_json_bytes(config_json.as_bytes())
      .map_err(to_napi_facade_error)?;
  let operators = binding_operators_from_json(operators_json.as_deref())
    .map_err(to_napi_facade_error)?;
  binding_redact_json(prepared.engine(), &full_text, &operators)
    .map_err(to_napi_facade_error)
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn redact_static_entities_diagnostics_json(
  config_json: String,
  full_text: String,
  operators_json: Option<String>,
) -> Result<String> {
  redact_static_entities_diagnostics_json_with_detail(
    &config_json,
    &full_text,
    operators_json.as_deref(),
    DiagnosticDetail::Detailed,
  )
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn redact_static_entities_summary_diagnostics_json(
  config_json: String,
  full_text: String,
  operators_json: Option<String>,
) -> Result<String> {
  redact_static_entities_diagnostics_json_with_detail(
    &config_json,
    &full_text,
    operators_json.as_deref(),
    DiagnosticDetail::Summary,
  )
}

fn redact_static_entities_diagnostics_json_with_detail(
  config_json: &str,
  full_text: &str,
  operators_json: Option<&str>,
  detail: DiagnosticDetail,
) -> Result<String> {
  let prepared =
    PreparedBinding::from_config_json_bytes(config_json.as_bytes())
      .map_err(to_napi_facade_error)?;
  let operators = binding_operators_from_json(operators_json)
    .map_err(to_napi_facade_error)?;
  binding_redact_diagnostics_json(
    prepared.engine(),
    prepared.diagnostics(),
    full_text,
    &operators,
    detail,
  )
  .map_err(to_napi_facade_error)
}

#[napi(js_name = "prepareStaticSearchArtifactsBytes")]
#[allow(clippy::needless_pass_by_value)]
pub fn prepare_static_search_artifacts_bytes(
  config_json: BufferSlice<'_>,
) -> Result<Buffer> {
  let config =
    serde_json::from_slice::<BindingPreparedSearchConfig>(config_json.as_ref())
      .map_err(|error| to_napi_serde_error(&error))?;
  let config = prepared_search_config_from_binding(config)
    .map_err(|error| to_napi_contract_error(&error))?;
  PreparedEngine::prepare_artifacts(config)
    .and_then(|artifacts| artifacts.to_bytes())
    .map(Buffer::from)
    .map_err(|error| to_napi_core_error(&error))
}

#[napi(js_name = "prepareStaticSearchPackageBytes")]
#[allow(clippy::needless_pass_by_value)]
pub fn prepare_static_search_package_bytes(
  config_json: BufferSlice<'_>,
) -> Result<Buffer> {
  prepare_static_search_package_bytes_with(config_json.as_ref(), false)
}

#[napi(js_name = "prepareStaticSearchCompressedPackageBytes")]
#[allow(clippy::needless_pass_by_value)]
pub fn prepare_static_search_compressed_package_bytes(
  config_json: BufferSlice<'_>,
) -> Result<Buffer> {
  prepare_static_search_package_bytes_with(config_json.as_ref(), true)
}

fn prepare_static_search_package_bytes_with(
  config_json: &[u8],
  compressed: bool,
) -> Result<Buffer> {
  let binding_config =
    serde_json::from_slice::<BindingPreparedSearchConfig>(config_json)
      .map_err(|error| to_napi_serde_error(&error))?;
  let core_config = prepared_search_config_from_binding(binding_config)
    .map_err(|error| to_napi_contract_error(&error))?;
  let artifacts = PreparedEngine::prepare_artifacts(core_config.clone())
    .map_err(|error| to_napi_core_error(&error))?;
  let artifact_bytes = artifacts
    .to_bytes()
    .map_err(|error| to_napi_core_error(&error))?;
  let package = if compressed {
    prepared_search_core_package_to_compressed_bytes(
      &core_config,
      &artifact_bytes,
    )
  } else {
    prepared_search_core_package_to_bytes(&core_config, &artifact_bytes)
  };
  let package = package.map_err(|error| to_napi_contract_error(&error))?;
  let prepared = PreparedEngine::new_with_artifacts(core_config, &artifacts)
    .map_err(|error| to_napi_core_error(&error))?;
  let cache_key = prepared_search_package_digest(&package)
    .map_err(|error| to_napi_contract_error(&error))?;
  prepared_search_cache_insert(cache_key, Arc::new(prepared));
  Ok(Buffer::from(package))
}

/// Assembles a prepared static-search config (slice A: trivial fields) and
/// returns it as JSON bytes, ready to feed the prepare/package path.
#[napi(js_name = "assembleStaticSearchConfigJson")]
#[allow(clippy::needless_pass_by_value)]
pub fn assemble_static_search_config_json(
  pipeline_config_json: BufferSlice<'_>,
  dictionaries_json: Option<BufferSlice<'_>>,
  gazetteer_json: Option<BufferSlice<'_>>,
) -> Result<Buffer> {
  let config = assemble_binding_config(
    pipeline_config_json.as_ref(),
    dictionaries_json.as_ref().map(AsRef::as_ref),
    gazetteer_json.as_ref().map(AsRef::as_ref),
  )?;
  serde_json::to_vec(&config)
    .map(Buffer::from)
    .map_err(|error| to_napi_serde_error(&error))
}

/// Assembles the config and chains it through the existing prepare/package
/// path, returning ready-to-load core package bytes.
#[napi(js_name = "assembleStaticSearchPackageBytes")]
#[allow(clippy::needless_pass_by_value)]
pub fn assemble_static_search_package_bytes(
  pipeline_config_json: BufferSlice<'_>,
  dictionaries_json: Option<BufferSlice<'_>>,
  gazetteer_json: Option<BufferSlice<'_>>,
) -> Result<Buffer> {
  let binding_config = assemble_binding_config(
    pipeline_config_json.as_ref(),
    dictionaries_json.as_ref().map(AsRef::as_ref),
    gazetteer_json.as_ref().map(AsRef::as_ref),
  )?;
  binding_package_from_config(binding_config, PackageEncoding::Plain)
    .map(Buffer::from)
    .map_err(to_napi_facade_error)
}

/// Assembles the config and chains it through the compressed prepare/package
/// path, returning ready-to-load LZ4-compressed core package bytes.
#[napi(js_name = "assembleStaticSearchCompressedPackageBytes")]
#[allow(clippy::needless_pass_by_value)]
pub fn assemble_static_search_compressed_package_bytes(
  pipeline_config_json: BufferSlice<'_>,
  dictionaries_json: Option<BufferSlice<'_>>,
  gazetteer_json: Option<BufferSlice<'_>>,
) -> Result<Buffer> {
  let binding_config = assemble_binding_config(
    pipeline_config_json.as_ref(),
    dictionaries_json.as_ref().map(AsRef::as_ref),
    gazetteer_json.as_ref().map(AsRef::as_ref),
  )?;
  binding_package_from_config(binding_config, PackageEncoding::Compressed)
    .map(Buffer::from)
    .map_err(to_napi_facade_error)
}

fn assemble_binding_config(
  pipeline_config_json: &[u8],
  dictionaries_json: Option<&[u8]>,
  gazetteer_json: Option<&[u8]>,
) -> Result<BindingPreparedSearchConfig> {
  let config = serde_json::from_slice::<PipelineConfig>(pipeline_config_json)
    .map_err(|error| to_napi_serde_error(&error))?;
  let dictionaries = match dictionaries_json {
    Some(bytes) => Some(
      serde_json::from_slice::<Dictionaries>(bytes)
        .map_err(|error| to_napi_serde_error(&error))?,
    ),
    None => None,
  };
  let gazetteer = match gazetteer_json {
    Some(bytes) => serde_json::from_slice::<Vec<GazetteerEntry>>(bytes)
      .map_err(|error| to_napi_serde_error(&error))?,
    None => Vec::new(),
  };
  assemble_static_search_config(&config, dictionaries.as_ref(), &gazetteer)
    .map_err(|error| to_napi_assemble_error(&error))
}

#[napi]
pub struct NativePreparedSearch {
  inner: Arc<PreparedEngine>,
  prepare_diagnostics: StaticRedactionDiagnostics,
}

#[napi]
pub struct NativePreparedRedactionSession {
  inner: Arc<PreparedEngine>,
  session: Arc<Mutex<RedactionSession>>,
}

#[napi]
pub struct NativePreparedSessionRedactionPlan {
  target: Arc<Mutex<RedactionSession>>,
  base: RedactionSession,
  planned: Mutex<Option<RedactionSession>>,
  result_json: String,
}

#[napi(object)]
pub struct JsSessionCallerRedactionInput {
  pub full_text: String,
  pub request_json: String,
}

#[napi(object)]
pub struct JsSessionCallerRedactionPlanOptions {
  pub inputs: Vec<JsSessionCallerRedactionInput>,
  pub operators: Option<JsOperatorConfig>,
  pub observed_at_epoch_seconds: Option<u32>,
}

#[napi(object)]
pub struct JsOpenSessionArchiveOptions {
  pub archive: Uint8Array,
  pub key: Uint8Array,
  pub expected_session_id: String,
  pub observed_at_epoch_seconds: Option<u32>,
}

#[napi]
impl NativePreparedRedactionSession {
  #[napi]
  pub fn session_id(&self) -> Result<String> {
    Ok(self.lock_session()?.id().as_str().to_owned())
  }

  #[napi]
  pub fn mapping_count(&self) -> Result<u32> {
    let count = self.lock_session()?.mapping_count();
    u32::try_from(count).map_err(|_| {
      Error::from_reason("Redaction session mapping count exceeds u32 range")
    })
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn restore_text(&self, full_text: String) -> Result<String> {
    self
      .lock_session()?
      .restore_text(&full_text, None)
      .map_err(|error| to_napi_core_error(&error))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn restore_text_at(
    &self,
    full_text: String,
    observed_at_epoch_seconds: u32,
  ) -> Result<String> {
    self
      .lock_session()?
      .restore_text(
        &full_text,
        Some(SessionTimestamp::from_epoch_seconds(
          observed_at_epoch_seconds,
        )),
      )
      .map_err(|error| to_napi_core_error(&error))
  }

  #[napi]
  pub fn to_plaintext_json(&self) -> Result<String> {
    self
      .lock_session()?
      .to_plaintext_json()
      .map_err(|error| to_napi_core_error(&error))
  }

  #[napi]
  pub fn to_plaintext_json_at(
    &self,
    observed_at_epoch_seconds: u32,
  ) -> Result<String> {
    self
      .lock_session()?
      .to_plaintext_json_at(SessionTimestamp::from_epoch_seconds(
        observed_at_epoch_seconds,
      ))
      .map_err(|error| to_napi_core_error(&error))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn to_encrypted_archive(&self, key: Uint8Array) -> Result<Uint8Array> {
    let key = session_archive_key(&key)?;
    self
      .lock_session()?
      .to_encrypted_archive(&key)
      .map(Uint8Array::new)
      .map_err(|error| to_napi_core_error(&error))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn to_encrypted_archive_at(
    &self,
    key: Uint8Array,
    observed_at_epoch_seconds: u32,
  ) -> Result<Uint8Array> {
    let key = session_archive_key(&key)?;
    self
      .lock_session()?
      .to_encrypted_archive_at(
        &key,
        SessionTimestamp::from_epoch_seconds(observed_at_epoch_seconds),
      )
      .map(Uint8Array::new)
      .map_err(|error| to_napi_core_error(&error))
  }

  #[napi]
  pub fn inspect_json(
    &self,
    observed_at_epoch_seconds: Option<u32>,
  ) -> Result<String> {
    let metadata = {
      let session = self.lock_session()?;
      session
        .inspect(
          observed_at_epoch_seconds.map(SessionTimestamp::from_epoch_seconds),
        )
        .map_err(|error| to_napi_core_error(&error))?
    };
    Ok(serialize_session_metadata(&metadata))
  }

  #[napi]
  pub fn delete_json(&self) -> Result<String> {
    let deletion = {
      let mut session = self.lock_session()?;
      session
        .delete()
        .map_err(|error| to_napi_core_error(&error))?
    };
    Ok(
      serde_json::json!({
        "session_id": deletion.session_id().as_str(),
        "deleted_mapping_count": deletion.deleted_mapping_count(),
      })
      .to_string(),
    )
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<String> {
    self.redact_static_entities_json_inner(&full_text, operators, None)
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_json_at(
    &self,
    full_text: String,
    observed_at_epoch_seconds: u32,
    operators: Option<JsOperatorConfig>,
  ) -> Result<String> {
    self.redact_static_entities_json_inner(
      &full_text,
      operators,
      Some(SessionTimestamp::from_epoch_seconds(
        observed_at_epoch_seconds,
      )),
    )
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn plan_static_entities_with_caller_detections(
    &self,
    options: JsSessionCallerRedactionPlanOptions,
  ) -> Result<NativePreparedSessionRedactionPlan> {
    let operators = operator_config_from_js(options.operators)?;
    let observed_at = options
      .observed_at_epoch_seconds
      .map(SessionTimestamp::from_epoch_seconds);
    let base = self.lock_session()?.clone();
    let mut planned = base.clone();
    let mut results = Vec::with_capacity(options.inputs.len());
    for input in options.inputs {
      let request = serde_json::from_str::<BindingCallerDetectionRequest>(
        &input.request_json,
      )
      .map_err(|error| to_napi_serde_error(&error))?;
      let detections =
        caller_detections_from_utf16_binding(request, &input.full_text)
          .map_err(|error| to_napi_contract_error(&error))?;
      let result = self
        .inner
        .redact_static_entities_with_caller_detections_and_session(
          &input.full_text,
          PreparedSessionCallerRedactionOptions {
            operators: &operators,
            detections: &detections,
            session: &mut planned,
            observed_at,
          },
        )
        .map_err(|error| to_napi_core_error(&error))?;
      results.push(
        static_redaction_plan_result_to_utf16_binding(
          &result,
          &input.full_text,
        )
        .map_err(|error| to_napi_contract_error(&error))?,
      );
    }
    let result_json = serde_json::to_string(&results)
      .map_err(|error| to_napi_serde_error(&error))?;
    Ok(NativePreparedSessionRedactionPlan {
      target: Arc::clone(&self.session),
      base,
      planned: Mutex::new(Some(planned)),
      result_json,
    })
  }
}

#[napi]
impl NativePreparedSessionRedactionPlan {
  #[napi]
  pub fn result_json(&self) -> String {
    self.result_json.clone()
  }

  #[napi]
  pub fn commit(&self) -> Result<()> {
    let mut planned = self.planned.lock().map_err(|_| {
      Error::from_reason("Redaction session plan lock is unavailable")
    })?;
    if planned.is_none() {
      return Err(Error::from_reason(
        "Redaction session plan has already been committed",
      ));
    }
    let mut target = self.target.lock().map_err(|_| {
      Error::from_reason("Redaction session state lock is unavailable")
    })?;
    if *target != self.base {
      return Err(Error::from_reason(
        "Redaction session changed after the plan was created",
      ));
    }
    let next = planned.take().ok_or_else(|| {
      Error::from_reason("Redaction session plan has already been committed")
    })?;
    *target = next;
    drop(target);
    drop(planned);
    Ok(())
  }
}

impl NativePreparedRedactionSession {
  fn redact_static_entities_json_inner(
    &self,
    full_text: &str,
    operators: Option<JsOperatorConfig>,
    observed_at: Option<SessionTimestamp>,
  ) -> Result<String> {
    let operators = operator_config_from_js(operators)?;
    let result = {
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
        .map_err(|error| to_napi_core_error(&error))?
    };
    let result = static_redaction_result_to_utf16_binding(result, full_text)
      .map_err(|error| to_napi_contract_error(&error))?;
    serde_json::to_string(&result).map_err(|error| to_napi_serde_error(&error))
  }

  fn new(inner: Arc<PreparedEngine>, session: RedactionSession) -> Self {
    Self {
      inner,
      session: Arc::new(Mutex::new(session)),
    }
  }

  fn lock_session(&self) -> Result<MutexGuard<'_, RedactionSession>> {
    self.session.lock().map_err(|_| {
      Error::from_reason("Redaction session state lock is unavailable")
    })
  }
}

fn serialize_session_metadata(metadata: &SessionMetadata) -> String {
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

#[derive(Clone, Copy)]
struct PrepareContext {
  input_bytes_len: usize,
  cache: PrepareCache,
  parse_elapsed: u64,
  parse_stage: DiagnosticStage,
  package_decode_timings: Option<PreparedSearchPackageDecodeTimings>,
}

#[derive(Clone, Copy)]
enum PrepareCache {
  Reuse {
    key: [u8; 32],
    key_elapsed: u64,
    lookup_elapsed: u64,
  },
  Bypass,
}

#[derive(Clone, Copy)]
enum PackageCacheMode {
  Reuse,
  Bypass,
}

#[derive(Clone, Copy)]
enum PackageDecodeMode {
  Verified,
  Trusted,
}

#[derive(Clone, Copy)]
struct CacheLookup {
  key: [u8; 32],
  key_elapsed: u64,
  lookup_elapsed: u64,
}

#[napi]
impl NativePreparedSearch {
  #[napi(constructor)]
  pub fn new(config_json: String) -> Result<Self> {
    let config_bytes = config_json.into_bytes();
    Self::from_config_bytes(&config_bytes, None)
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_config_json_bytes(config_json: BufferSlice<'_>) -> Result<Self> {
    Self::from_config_bytes(config_json.as_ref(), None)
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_config_json_and_artifact_bytes(
    config_json: BufferSlice<'_>,
    artifact_bytes: BufferSlice<'_>,
  ) -> Result<Self> {
    Self::from_config_bytes(config_json.as_ref(), Some(artifact_bytes.as_ref()))
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_prepared_package_bytes(
    package_bytes: BufferSlice<'_>,
  ) -> Result<Self> {
    Self::from_package_bytes(
      package_bytes.as_ref(),
      PackageCacheMode::Reuse,
      PackageDecodeMode::Verified,
    )
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_prepared_package_bytes_without_cache(
    package_bytes: BufferSlice<'_>,
  ) -> Result<Self> {
    Self::from_package_bytes(
      package_bytes.as_ref(),
      PackageCacheMode::Bypass,
      PackageDecodeMode::Verified,
    )
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_trusted_prepared_package_bytes(
    package_bytes: BufferSlice<'_>,
  ) -> Result<Self> {
    Self::from_package_bytes(
      package_bytes.as_ref(),
      PackageCacheMode::Reuse,
      PackageDecodeMode::Trusted,
    )
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_trusted_prepared_package_bytes_without_cache(
    package_bytes: BufferSlice<'_>,
  ) -> Result<Self> {
    Self::from_package_bytes(
      package_bytes.as_ref(),
      PackageCacheMode::Bypass,
      PackageDecodeMode::Trusted,
    )
  }

  fn from_config_bytes(
    config_bytes: &[u8],
    artifact_bytes: Option<&[u8]>,
  ) -> Result<Self> {
    let input_bytes_len = config_bytes
      .len()
      .saturating_add(artifact_bytes.map_or(0, <[u8]>::len));
    let cache_key_start = Instant::now();
    let cache_key = prepared_search_cache_key(config_bytes, artifact_bytes);
    let cache_key_elapsed = elapsed_us(cache_key_start);
    let cache_start = Instant::now();
    if let Some(inner) = prepared_search_cache_get(&cache_key) {
      let cache = CacheLookup {
        key: cache_key,
        key_elapsed: cache_key_elapsed,
        lookup_elapsed: elapsed_us(cache_start),
      };
      return Ok(Self {
        inner,
        prepare_diagnostics: StaticRedactionDiagnostics {
          events: cache_hit_events(&cache, input_bytes_len),
          ..StaticRedactionDiagnostics::default()
        },
      });
    }
    let cache = CacheLookup {
      key: cache_key,
      key_elapsed: cache_key_elapsed,
      lookup_elapsed: elapsed_us(cache_start),
    };

    let parse_start = Instant::now();
    let config =
      serde_json::from_slice::<BindingPreparedSearchConfig>(config_bytes)
        .map_err(|error| to_napi_serde_error(&error))?;
    let parse_elapsed = elapsed_us(parse_start);
    let context = PrepareContext {
      input_bytes_len,
      cache: PrepareCache::Reuse {
        key: cache.key,
        key_elapsed: cache.key_elapsed,
        lookup_elapsed: cache.lookup_elapsed,
      },
      parse_elapsed,
      parse_stage: DiagnosticStage::PrepareBindingParse,
      package_decode_timings: None,
    };
    Self::from_binding_config(config, artifact_bytes, &context)
  }

  fn from_package_bytes(
    package_bytes: &[u8],
    cache_mode: PackageCacheMode,
    decode_mode: PackageDecodeMode,
  ) -> Result<Self> {
    let input_bytes_len = package_bytes.len();
    let cache = match cache_mode {
      PackageCacheMode::Reuse => {
        let cache_key_start = Instant::now();
        let cache_key = prepared_search_package_digest(package_bytes)
          .map_err(|error| to_napi_contract_error(&error))?;
        let cache_key_elapsed = elapsed_us(cache_key_start);
        let cache_start = Instant::now();
        if let Some(inner) = prepared_search_cache_get(&cache_key) {
          let cache = CacheLookup {
            key: cache_key,
            key_elapsed: cache_key_elapsed,
            lookup_elapsed: elapsed_us(cache_start),
          };
          let mut events = cache_hit_events(&cache, input_bytes_len);
          if matches!(decode_mode, PackageDecodeMode::Verified) {
            let verify_timings =
              prepared_search_package_verify_digest_with_timings(package_bytes)
                .map_err(|error| to_napi_contract_error(&error))?;
            append_package_decode_timing_events_for_input(
              &mut events,
              verify_timings,
              input_bytes_len,
            );
          }
          return Ok(Self {
            inner,
            prepare_diagnostics: StaticRedactionDiagnostics {
              events,
              ..StaticRedactionDiagnostics::default()
            },
          });
        }
        let cache = CacheLookup {
          key: cache_key,
          key_elapsed: cache_key_elapsed,
          lookup_elapsed: elapsed_us(cache_start),
        };
        PrepareCache::Reuse {
          key: cache.key,
          key_elapsed: cache.key_elapsed,
          lookup_elapsed: cache.lookup_elapsed,
        }
      }
      PackageCacheMode::Bypass => PrepareCache::Bypass,
    };
    let parse_start = Instant::now();
    if prepared_search_package_has_core_payload(package_bytes) {
      let (package, package_decode_timings) = match decode_mode {
        PackageDecodeMode::Verified => {
          prepared_search_core_package_view_from_bytes_with_timings(
            package_bytes,
          )
        }
        PackageDecodeMode::Trusted => {
          prepared_search_core_package_view_trusted_from_bytes_with_timings(
            package_bytes,
          )
        }
      }
      .map_err(|error| to_napi_contract_error(&error))?;
      let parse_elapsed = elapsed_us(parse_start);
      let config = package.config;
      let context = PrepareContext {
        input_bytes_len,
        cache,
        parse_elapsed,
        parse_stage: DiagnosticStage::PreparePackageDecode,
        package_decode_timings: Some(package_decode_timings),
      };
      return Self::from_core_config(
        config,
        Some(package.artifacts.as_bytes()),
        &context,
        None,
      );
    }

    let package = prepared_search_package_from_bytes(package_bytes)
      .map_err(|error| to_napi_contract_error(&error))?;
    let parse_elapsed = elapsed_us(parse_start);
    let config = package.config;
    let artifacts = package.artifacts;
    let context = PrepareContext {
      input_bytes_len,
      cache,
      parse_elapsed,
      parse_stage: DiagnosticStage::PreparePackageDecode,
      package_decode_timings: None,
    };
    Self::from_binding_config(config, Some(&artifacts), &context)
  }

  fn from_binding_config(
    config: BindingPreparedSearchConfig,
    artifact_bytes: Option<&[u8]>,
    context: &PrepareContext,
  ) -> Result<Self> {
    let convert_start = Instant::now();
    let config = prepared_search_config_from_binding(config)
      .map_err(|error| to_napi_contract_error(&error))?;
    let pattern_count = prepared_search_pattern_count(&config);
    let convert_elapsed = elapsed_us(convert_start);
    Self::from_core_config(
      config,
      artifact_bytes,
      context,
      Some((pattern_count, convert_elapsed)),
    )
  }

  fn from_core_config(
    config: PreparedEngineConfig,
    artifact_bytes: Option<&[u8]>,
    context: &PrepareContext,
    binding_convert: Option<(usize, u64)>,
  ) -> Result<Self> {
    let artifact_decode_start = Instant::now();
    let artifacts = artifact_bytes
      .map(PreparedEngineArtifactsView::from_bytes)
      .transpose()
      .map_err(|error| to_napi_core_error(&error))?;
    let artifact_decode_elapsed =
      artifact_bytes.map(|_| elapsed_us(artifact_decode_start));
    let artifact_decode = match (artifact_decode_elapsed, artifact_bytes) {
      (Some(elapsed), Some(bytes)) => Some((elapsed, bytes.len())),
      _ => None,
    };
    Self::from_core_config_with_artifacts(
      config,
      artifacts.as_ref(),
      artifact_decode,
      context,
      binding_convert,
    )
  }

  fn from_core_config_with_artifacts(
    config: PreparedEngineConfig,
    artifacts: Option<&PreparedEngineArtifactsView<'_>>,
    artifact_decode: Option<(u64, usize)>,
    context: &PrepareContext,
    binding_convert: Option<(usize, u64)>,
  ) -> Result<Self> {
    let result = if let Some(artifacts) = artifacts {
      PreparedEngine::new_with_artifact_view_diagnostics(config, artifacts)
    } else {
      PreparedEngine::new_with_diagnostics(config)
    }
    .map_err(|error| to_napi_core_error(&error))?;
    let inner = Arc::new(result.prepared);
    let mut events = cache_miss_events(context);
    events.push(diagnostic_stage_event(
      context.parse_stage,
      None,
      Some(context.parse_elapsed),
      Some(context.input_bytes_len),
    ));
    append_package_decode_timing_events(&mut events, context);
    let mut diagnostics = StaticRedactionDiagnostics {
      events,
      ..StaticRedactionDiagnostics::default()
    };
    if let Some((pattern_count, convert_elapsed)) = binding_convert {
      diagnostics.events.push(diagnostic_stage_event(
        DiagnosticStage::PrepareBindingConvert,
        Some(pattern_count),
        Some(convert_elapsed),
        None,
      ));
    }
    if let Some((elapsed, bytes)) = artifact_decode {
      diagnostics.events.push(diagnostic_stage_event(
        DiagnosticStage::PrepareArtifactsDecode,
        None,
        Some(elapsed),
        Some(bytes),
      ));
    }
    diagnostics.extend(result.diagnostics);
    if let PrepareCache::Reuse { key, .. } = context.cache {
      prepared_search_cache_insert(key, Arc::clone(&inner));
    }
    Ok(Self {
      inner,
      prepare_diagnostics: diagnostics,
    })
  }

  #[napi]
  pub fn prepare_diagnostics_json(&self) -> Result<String> {
    binding_prepare_diagnostics_json(&self.prepare_diagnostics)
      .map_err(to_napi_facade_error)
  }

  #[napi]
  pub fn warm_lazy_regex(&self) -> Result<()> {
    self
      .inner
      .warm_lazy_regex()
      .map_err(|error| to_napi_core_error(&error))
  }

  #[napi]
  pub fn warm_lazy_regex_diagnostics_json(&self) -> Result<String> {
    let diagnostics = self
      .inner
      .warm_lazy_regex_diagnostics()
      .map_err(|error| to_napi_core_error(&error))?;
    binding_prepare_diagnostics_json(&diagnostics).map_err(to_napi_facade_error)
  }

  #[napi]
  pub fn create_redaction_session(
    &self,
    session_id: String,
  ) -> Result<NativePreparedRedactionSession> {
    let session_id =
      SessionId::new(session_id).map_err(|error| to_napi_core_error(&error))?;
    Ok(NativePreparedRedactionSession::new(
      Arc::clone(&self.inner),
      RedactionSession::new(session_id),
    ))
  }

  #[napi]
  pub fn create_redaction_session_with_lifecycle(
    &self,
    session_id: String,
    created_at_epoch_seconds: u32,
    expires_at_epoch_seconds: Option<u32>,
  ) -> Result<NativePreparedRedactionSession> {
    let session_id =
      SessionId::new(session_id).map_err(|error| to_napi_core_error(&error))?;
    let lifecycle = SessionLifecycle::new(
      SessionTimestamp::from_epoch_seconds(created_at_epoch_seconds),
      expires_at_epoch_seconds.map(SessionTimestamp::from_epoch_seconds),
    )
    .map_err(|error| to_napi_core_error(&error))?;
    let session = RedactionSession::new_with_lifecycle(session_id, lifecycle)
      .map_err(|error| to_napi_core_error(&error))?;
    Ok(NativePreparedRedactionSession::new(
      Arc::clone(&self.inner),
      session,
    ))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn restore_redaction_session(
    &self,
    plaintext_json: String,
  ) -> Result<NativePreparedRedactionSession> {
    let session = RedactionSession::from_plaintext_json(&plaintext_json)
      .map_err(|error| to_napi_core_error(&error))?;
    Ok(NativePreparedRedactionSession::new(
      Arc::clone(&self.inner),
      session,
    ))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn restore_encrypted_redaction_session(
    &self,
    options: JsOpenSessionArchiveOptions,
  ) -> Result<NativePreparedRedactionSession> {
    let key = session_archive_key(&options.key)?;
    let expected_session_id = SessionId::new(options.expected_session_id)
      .map_err(|error| to_napi_core_error(&error))?;
    let archive = session_archive_bytes(&options.archive)?;
    let session =
      RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
        archive: &archive,
        key: &key,
        expected_session_id: &expected_session_id,
        observed_at: options
          .observed_at_epoch_seconds
          .map(SessionTimestamp::from_epoch_seconds),
      })
      .map_err(|error| to_napi_core_error(&error))?;
    Ok(NativePreparedRedactionSession::new(
      Arc::clone(&self.inner),
      session,
    ))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<JsStaticRedactionResult> {
    let operators = operator_config_from_js(operators)?;
    let result = self
      .inner
      .redact_static_entities(&full_text, &operators)
      .map_err(|error| to_napi_core_error(&error))?;
    static_redaction_result_to_utf16_binding(result, &full_text)
      .map_err(|error| to_napi_contract_error(&error))
      .and_then(to_js_static_redaction_result)
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<String> {
    let operators = operator_config_from_js(operators)?;
    binding_redact_json(&self.inner, &full_text, &operators)
      .map_err(to_napi_facade_error)
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_with_caller_detections_json(
    &self,
    full_text: String,
    options: JsCallerRedactionOptions,
  ) -> Result<String> {
    let operators = operator_config_from_js(options.operators)?;
    redact_with_caller_detections_json(
      &self.inner,
      &full_text,
      &options.request_json,
      &operators,
    )
    .map_err(to_napi_facade_error)
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_with_caller_detections_diagnostics_json(
    &self,
    full_text: String,
    options: JsCallerRedactionOptions,
  ) -> Result<String> {
    let operators = operator_config_from_js(options.operators)?;
    redact_with_caller_detections_diagnostics_json(
      &self.inner,
      &self.prepare_diagnostics,
      &full_text,
      &options.request_json,
      &operators,
    )
    .map_err(to_napi_facade_error)
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_result_stream_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
    on_event: Function<'_, (String,), ()>,
  ) -> Result<String> {
    let operators = operator_config_from_js(operators)?;
    binding_redact_result_stream_json(
      &self.inner,
      &full_text,
      &operators,
      |event_json| {
        on_event
          .call((event_json,))
          .map_err(|error| error.to_string())
      },
    )
    .map_err(to_napi_facade_error)
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_diagnostics_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<String> {
    let operators = operator_config_from_js(operators)?;
    self.redact_static_entities_diagnostics_json_inner(
      &full_text,
      &operators,
      DiagnosticDetail::Detailed,
    )
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_summary_diagnostics_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<String> {
    let operators = operator_config_from_js(operators)?;
    self.redact_static_entities_diagnostics_json_inner(
      &full_text,
      &operators,
      DiagnosticDetail::Summary,
    )
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_diagnostics_stream_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
    on_batch: Function<'_, (String,), ()>,
  ) -> Result<String> {
    let operators = operator_config_from_js(operators)?;
    binding_redact_diagnostics_stream_json(
      &self.inner,
      &self.prepare_diagnostics,
      &full_text,
      &operators,
      |batch_json| {
        on_batch
          .call((batch_json,))
          .map_err(|error| error.to_string())
      },
    )
    .map_err(to_napi_facade_error)
  }

  fn redact_static_entities_diagnostics_json_inner(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
    detail: DiagnosticDetail,
  ) -> Result<String> {
    binding_redact_diagnostics_json(
      &self.inner,
      &self.prepare_diagnostics,
      full_text,
      operators,
      detail,
    )
    .map_err(to_napi_facade_error)
  }
}

const fn prepared_search_pattern_count(config: &PreparedEngineConfig) -> usize {
  config
    .search
    .regex_patterns
    .len()
    .saturating_add(config.search.custom_regex_patterns.len())
    .saturating_add(config.search.literal_patterns.len())
}

fn prepared_search_cache_get(key: &[u8; 32]) -> Option<Arc<PreparedEngine>> {
  with_prepared_search_cache(|cache| cache.get(key))
}

fn prepared_search_cache_insert(key: [u8; 32], value: Arc<PreparedEngine>) {
  with_prepared_search_cache(|cache| cache.insert(key, value));
}

fn cache_hit_events(
  cache: &CacheLookup,
  input_bytes_len: usize,
) -> Vec<DiagnosticEvent> {
  vec![
    diagnostic_stage_event(
      DiagnosticStage::PrepareCacheKey,
      None,
      Some(cache.key_elapsed),
      Some(input_bytes_len),
    ),
    diagnostic_stage_event(
      DiagnosticStage::PrepareCacheHit,
      Some(1),
      Some(cache.lookup_elapsed),
      Some(input_bytes_len),
    ),
  ]
}

fn cache_miss_events(context: &PrepareContext) -> Vec<DiagnosticEvent> {
  match context.cache {
    PrepareCache::Reuse {
      key_elapsed,
      lookup_elapsed,
      ..
    } => vec![
      diagnostic_stage_event(
        DiagnosticStage::PrepareCacheKey,
        None,
        Some(key_elapsed),
        Some(context.input_bytes_len),
      ),
      diagnostic_stage_event(
        DiagnosticStage::PrepareCacheMiss,
        Some(0),
        Some(lookup_elapsed),
        Some(context.input_bytes_len),
      ),
    ],
    PrepareCache::Bypass => vec![diagnostic_stage_event(
      DiagnosticStage::PrepareCacheBypass,
      Some(0),
      Some(0),
      Some(context.input_bytes_len),
    )],
  }
}

fn append_package_decode_timing_events(
  events: &mut Vec<DiagnosticEvent>,
  context: &PrepareContext,
) {
  let Some(timings) = context.package_decode_timings else {
    return;
  };
  append_package_decode_timing_events_for_input(
    events,
    timings,
    context.input_bytes_len,
  );
}

fn append_package_decode_timing_events_for_input(
  events: &mut Vec<DiagnosticEvent>,
  timings: PreparedSearchPackageDecodeTimings,
  input_bytes_len: usize,
) {
  events.extend(prepared_search_package_decode_timing_events(
    timings,
    input_bytes_len,
  ));
}

fn prepared_search_cache_key(
  config_bytes: &[u8],
  artifact_bytes: Option<&[u8]>,
) -> [u8; 32] {
  let mut hasher = blake3::Hasher::new();
  hasher.update(b"config");
  hasher.update(config_bytes);
  match artifact_bytes {
    Some(bytes) => {
      hasher.update(b"artifacts");
      hasher.update(bytes);
    }
    None => {
      hasher.update(b"no-artifacts");
    }
  }
  *hasher.finalize().as_bytes()
}

fn with_prepared_search_cache<T>(
  action: impl FnOnce(&mut PreparedSearchCache) -> T,
) -> T {
  let mut cache = match PREPARED_SEARCH_CACHE.lock() {
    Ok(cache) => cache,
    Err(poisoned) => poisoned.into_inner(),
  };
  action(&mut cache)
}

fn to_binding_operator_config(
  config: JsOperatorConfig,
) -> Result<BindingOperatorConfig> {
  let operators = config
    .operators
    .map(serde_json::from_value)
    .transpose()
    .map_err(|error| Error::from_reason(error.to_string()))?;
  Ok(BindingOperatorConfig {
    operators,
    redact_string: config.redact_string,
  })
}

fn operator_config_from_js(
  config: Option<JsOperatorConfig>,
) -> Result<OperatorConfig> {
  let config = config.map(to_binding_operator_config).transpose()?;
  operator_config_from_binding(config)
    .map_err(|error| to_napi_contract_error(&error))
}

fn to_js_static_redaction_result(
  result: BindingStaticRedactionResult,
) -> Result<JsStaticRedactionResult> {
  Ok(JsStaticRedactionResult {
    resolved_entities: result
      .resolved_entities
      .into_iter()
      .map(|entity| JsPipelineEntity {
        start: entity.start,
        end: entity.end,
        label: entity.label,
        text: entity.text,
        score: entity.score,
        source: entity.source,
        source_detail: entity.source_detail,
        provider_id: entity.provider_id,
        detection_id: entity.detection_id,
      })
      .collect(),
    redaction: to_js_redaction_result(result.redaction)?,
  })
}

fn to_js_redaction_result(
  result: BindingRedactionResult,
) -> Result<JsRedactionResult> {
  Ok(JsRedactionResult {
    redacted_text: result.redacted_text,
    redaction_map: result
      .redaction_map
      .into_iter()
      .map(|entry| JsRedactionEntry {
        placeholder: entry.placeholder,
        original: entry.original,
      })
      .collect(),
    operator_map: to_js_operator_entries(result.operator_map),
    entity_count: u32::try_from(result.entity_count).map_err(|_| {
      Error::from_reason(format!(
        "Entity count exceeds u32 range: {}",
        result.entity_count
      ))
    })?,
  })
}

fn to_js_operator_entries(
  entries: Vec<BindingOperatorEntry>,
) -> Vec<JsOperatorEntry> {
  entries
    .into_iter()
    .map(|entry| JsOperatorEntry {
      placeholder: entry.placeholder,
      operator: entry.operator,
    })
    .collect()
}

fn session_archive_key(bytes: &[u8]) -> Result<SessionArchiveKey> {
  let key_bytes = bytes.try_into().map_err(|_| {
    Error::from_reason(format!(
      "Encrypted session archive keys must be exactly {REDACTION_SESSION_ARCHIVE_KEY_BYTES} bytes"
    ))
  })?;
  Ok(SessionArchiveKey::from_bytes(key_bytes))
}

fn session_archive_bytes(bytes: &[u8]) -> Result<Vec<u8>> {
  if bytes.len() > REDACTION_SESSION_ARCHIVE_MAX_BYTES {
    return Err(Error::from_reason(format!(
      "Encrypted session archives must not exceed {REDACTION_SESSION_ARCHIVE_MAX_BYTES} bytes"
    )));
  }
  Ok(bytes.to_vec())
}

fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}

fn to_napi_core_error(error: &stella_anonymize_core::Error) -> Error {
  Error::from_reason(error.to_string())
}

#[allow(clippy::needless_pass_by_value)] // `Result::map_err` transfers ownership.
fn to_napi_facade_error(
  error: stella_anonymize_binding_core::BindingFacadeError,
) -> Error {
  Error::from_reason(error.to_string())
}

fn to_napi_contract_error(error: &ContractError) -> Error {
  Error::from_reason(error.to_string())
}

fn to_napi_serde_error(error: &serde_json::Error) -> Error {
  Error::from_reason(error.to_string())
}

fn to_napi_assemble_error(error: &AssembleError) -> Error {
  Error::from_reason(error.to_string())
}
