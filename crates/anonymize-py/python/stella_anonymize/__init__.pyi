from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from os import PathLike
from typing import Any, Literal, NotRequired, TypeAlias, TypedDict

from ._native import (
    PreparedRedactionSession as NativePreparedRedactionSession,
    PreparedSearch as NativePreparedSearch,
    OperatorEntry as OperatorEntry,
    PipelineEntity as PipelineEntity,
    RedactionEntry as RedactionEntry,
    RedactionResult as RedactionResult,
    StaticRedactionResult as StaticRedactionResult,
    native_package_version as native_package_version,
    normalize_for_search as normalize_for_search,
    assemble_static_search_compressed_package_bytes as assemble_static_search_compressed_package_bytes,
    assemble_static_search_config_json as assemble_static_search_config_json,
    assemble_static_search_package_bytes as assemble_static_search_package_bytes,
    convert_external_detection_batch as _native_convert_external_detection_batch,
    prepare_static_search_artifacts_bytes as prepare_static_search_artifacts_bytes,
    prepare_static_search_compressed_package_bytes as prepare_static_search_compressed_package_bytes,
    prepare_static_search_package_bytes as prepare_static_search_package_bytes,
    redact_static_entities_diagnostics_json as redact_static_entities_diagnostics_json,
    redact_static_entities_json as redact_static_entities_json,
    redact_static_entities_result_stream_json as redact_static_entities_result_stream_json,
    redact_static_entities_summary_diagnostics_json as redact_static_entities_summary_diagnostics_json,
)

BytesLike: TypeAlias = bytes | bytearray | memoryview
PathLikeString: TypeAlias = str | PathLike[str]
SupportedLanguage: TypeAlias = Literal[
    "cs",
    "de",
    "en",
    "es",
    "fr",
    "hu",
    "it",
    "lv",
    "pl",
    "pt-br",
    "ro",
    "sk",
    "sv",
]
PipelineLanguageSelection: TypeAlias = (
    SupportedLanguage | Sequence[SupportedLanguage] | Literal["all"]
)

class MaskOperatorConfig(TypedDict):
    type: Literal["mask"]
    masking_character: str
    characters_to_mask: int
    direction: Literal["start", "end"]

OperatorSelection: TypeAlias = Literal["replace", "redact", "keep"] | MaskOperatorConfig
OperatorConfig: TypeAlias = Mapping[str, OperatorSelection] | str | None
CALLER_DETECTION_CONTRACT_VERSION: int
CALLER_DETECTION_MAX_COUNT: Literal[1000000]
CALLER_DETECTION_REQUEST_JSON_MAX_BYTES: Literal[16777216]
CALLER_DETECTION_TEXT_MAX_BYTES: Literal[67108864]
SESSION_CALLER_INPUTS_JSON_MAX_BYTES: Literal[67108864]
SESSION_CALLER_MAX_INPUTS: Literal[100000]
EXTERNAL_DETECTION_BATCH_VERSION: Literal[1]
EXTERNAL_DETECTION_BATCH_MAX_BYTES: Literal[16777216]
EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES: Literal[67108864]
EXTERNAL_DETECTION_MAX_DETECTIONS: Literal[100000]
EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS: Literal[4096]
EXTERNAL_DETECTION_MAX_METADATA_BYTES: Literal[256]
EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES: Literal[128]

SessionStatus: TypeAlias = Literal["active", "not_yet_active", "expired", "deleted"]

class SessionMetadata(TypedDict):
    session_id: str
    created_at_epoch_seconds: int | None
    expires_at_epoch_seconds: int | None
    mapping_count: int
    status: SessionStatus

class SessionDeletionSummary(TypedDict):
    session_id: str
    deleted_mapping_count: int

class CallerDetection(TypedDict):
    start: int
    end: int
    label: str
    score: float
    provider_id: str
    detection_id: str

ExternalDetectionOffsetUnit: TypeAlias = Literal[
    "utf8-byte", "utf16-code-unit", "unicode-code-point"
]

class ExternalDetectionProvider(TypedDict):
    id: str
    name: str
    version: str

class ExternalDetectionDocument(TypedDict):
    sha256: str

class ExternalDetectionLabelMapping(TypedDict):
    providerLabel: str
    entityLabel: str

class ExternalDetection(TypedDict):
    id: str
    start: int
    end: int
    label: str
    score: float

class ExternalDetectionBatch(TypedDict):
    version: Literal[1]
    document: ExternalDetectionDocument
    offsetUnit: ExternalDetectionOffsetUnit
    provider: ExternalDetectionProvider
    labelMap: Sequence[ExternalDetectionLabelMapping]
    detections: Sequence[ExternalDetection]

def convert_external_detection_batch(
    document: BytesLike,
    batch: ExternalDetectionBatch | str,
) -> list[CallerDetection]: ...

DiagnosticsBatchCallback: TypeAlias = Callable[[str], object]
ResultEventCallback: TypeAlias = Callable[[str], object]
NativeSearchPackageInput: TypeAlias = str | BytesLike | Mapping[str, object]
RedactionMapInput: TypeAlias = (
    Mapping[str, str] | Sequence[RedactionEntry] | Sequence[tuple[str, str]]
)
DefaultNativePipelineWarmup: TypeAlias = Literal["lazy-regex", "none"]
DEFAULT_NATIVE_PIPELINE_WARMUPS: tuple[
    DefaultNativePipelineWarmup,
    DefaultNativePipelineWarmup,
]
__version__: str

DOCX_EXTRACTION_CONTRACT_VERSION: int
DOCX_ARCHIVE_MAX_BYTES: int
DOCX_ENTRY_MAX_BYTES: int
DOCX_UNCOMPRESSED_MAX_BYTES: int
DOCX_XML_MAX_DEPTH: int

class DocxExtractionError(ValueError):
    code: str

class DocxRewriteError(ValueError):
    code: str

class DocxAnonymizationError(ValueError):
    code: str

class DocxRestorationError(ValueError):
    code: str

def extract_docx_text(document: BytesLike) -> dict[str, Any]: ...

PdfInspectionErrorCode: TypeAlias = Literal[
    "document-limit-exceeded",
    "invalid-document",
    "invalid-observation",
    "observation-limit-exceeded",
    "provider-failed",
]

class PdfInspectionError(ValueError):
    code: PdfInspectionErrorCode

PdfRasterErrorCode: TypeAlias = Literal[
    "detection-failed",
    "invalid-contract",
    "limit-exceeded",
    "source-rejected",
    "verification-failed",
]

class PdfRasterError(ValueError):
    code: PdfRasterErrorCode

PdfGlyphSource: TypeAlias = Literal["embedded-text", "ocr"]
PdfTextLayerCoverage: TypeAlias = Literal["absent", "partial", "complete"]
PdfOcrCoverage: TypeAlias = Literal["not-run", "partial", "complete"]
PdfInspectionGap: TypeAlias = Literal[
    "encrypted-document",
    "page-content-not-observed",
    "page-not-rendered",
    "partial-text-layer",
    "retained-document-bytes",
    "unobserved-visual-content",
]

class PdfRect(TypedDict):
    left: float
    bottom: float
    right: float
    top: float

class PdfGlyphObservation(TypedDict):
    start: int
    end: int
    bounds: PdfRect
    source: PdfGlyphSource

class PdfPageObservation(TypedDict):
    pageIndex: int
    widthPoints: float
    heightPoints: float
    text: str
    glyphs: Sequence[PdfGlyphObservation]
    rendered: bool
    textLayer: PdfTextLayerCoverage
    ocr: PdfOcrCoverage
    imageCount: int

class PdfRiskInventory(TypedDict):
    acroFormFieldCount: int
    annotationCount: int
    documentInfoEntryCount: int
    embeddedFileCount: int
    externalActionCount: int
    formXObjectCount: int
    imageObjectCount: int
    incrementalRevisionCount: int
    javascriptActionCount: int
    metadataStreamCount: int
    optionalContentGroupCount: int
    signatureCount: int
    trailingNonWhitespaceByteCount: int
    unsupportedActionCount: int
    xfaEntryCount: int

class PdfInspectionCoverage(TypedDict):
    status: Literal["full", "partial"]
    gaps: list[PdfInspectionGap]

class PdfPageInspection(TypedDict):
    pageIndex: int
    widthPoints: float
    heightPoints: float
    annotationCount: int
    observation: PdfPageObservation | None

class PdfInspection(TypedDict):
    contractVersion: Literal[1]
    pdfVersion: str
    byteLength: int
    objectCount: int
    pageCount: int
    encrypted: bool
    pages: list[PdfPageInspection]
    risks: PdfRiskInventory
    coverage: PdfInspectionCoverage

PDF_INSPECTION_CONTRACT_VERSION: int
PDF_DOCUMENT_MAX_BYTES: int
PDF_MAX_OBJECTS: int
PDF_LOADED_PAYLOAD_MAX_BYTES: int
PDF_STREAM_DECOMPRESSED_MAX_BYTES: int
PDF_MAX_OBJECT_NODES: int
PDF_MAX_OBJECT_DEPTH: int
PDF_MAX_PAGES: int
PDF_MAX_GLYPHS: int
PDF_MAX_PAGE_TEXT_UTF8_BYTES: int
PDF_MAX_OBSERVED_TEXT_UTF8_BYTES: int
PDF_OBSERVATIONS_JSON_MAX_BYTES: int
PDF_PAGE_DIMENSION_TOLERANCE_POINTS: float
PDF_RASTER_CONTRACT_VERSION: int
PDF_RASTER_MAX_PAGE_BYTES: int
PDF_RASTER_MAX_TOTAL_BYTES: int
PDF_RASTER_MAX_OUTPUT_BYTES: int
PDF_RASTER_REQUEST_JSON_MAX_BYTES: int

class PdfRasterProvider(TypedDict):
    providerId: str
    rendererName: str
    rendererVersion: str
    ocrName: str
    ocrVersion: str
    ocrLanguage: str

class PdfRasterObservedPage(TypedDict):
    observation: PdfPageObservation
    widthPixels: int
    heightPixels: int
    pixels: BytesLike
    externalDetectionBatch: NotRequired[ExternalDetectionBatch | str]

def inspect_pdf(
    document: BytesLike,
    page_observations: Sequence[PdfPageObservation] | None = None,
) -> PdfInspection: ...
def anonymize_pdf_raster(
    document: BytesLike,
    anonymizer: PreparedAnonymizer,
    provider: PdfRasterProvider,
    pages: Sequence[PdfRasterObservedPage],
    *,
    fill_rgb: Sequence[int] = ...,
) -> tuple[bytes, dict[str, Any]]: ...
def rewrite_pdf_raster_from_detections(
    document: BytesLike,
    request: Mapping[str, Any],
    page_pixels: Sequence[BytesLike],
) -> tuple[bytes, dict[str, Any]]: ...
def rewrite_docx_text(
    document: BytesLike,
    rewrites: Sequence[Mapping[str, Any]],
) -> dict[str, Any]: ...
def anonymize_docx(
    document: BytesLike,
    session: PreparedRedactionSession,
    expected_session_id: str,
    policy: Mapping[str, Any],
    *,
    caller_detections: Sequence[Mapping[str, Any]] = ...,
    observed_at_epoch_seconds: int | None = ...,
) -> dict[str, Any]: ...
def restore_docx_text(
    document: BytesLike,
    session: PreparedRedactionSession,
    expected_session_id: str,
    *,
    observed_at_epoch_seconds: int | None = ...,
) -> dict[str, Any]: ...

class PreparedRedactionSession:
    def __init__(self, session: NativePreparedRedactionSession) -> None: ...
    def session_id(self) -> str: ...
    def mapping_count(self) -> int: ...
    def restore_text(
        self,
        full_text: str,
        observed_at_epoch_seconds: int | None = None,
    ) -> str: ...
    def to_plaintext_json(self) -> str: ...
    def to_plaintext_json_at(self, observed_at_epoch_seconds: int) -> str: ...
    def to_encrypted_archive(self, key: BytesLike) -> bytes: ...
    def to_encrypted_archive_at(
        self,
        key: BytesLike,
        observed_at_epoch_seconds: int,
    ) -> bytes: ...
    def inspect(
        self,
        observed_at_epoch_seconds: int | None = None,
    ) -> SessionMetadata: ...
    def delete(self) -> SessionDeletionSummary: ...
    def redact_text(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_text_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_text_at(
        self,
        full_text: str,
        *,
        observed_at_epoch_seconds: int,
        operators: OperatorConfig = None,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_text_json_at(
        self,
        full_text: str,
        *,
        observed_at_epoch_seconds: int,
        operators: OperatorConfig = None,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_static_entities(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_static_entities_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_static_entities_at(
        self,
        full_text: str,
        *,
        observed_at_epoch_seconds: int,
        operators: OperatorConfig = None,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_static_entities_json_at(
        self,
        full_text: str,
        *,
        observed_at_epoch_seconds: int,
        operators: OperatorConfig = None,
        redact_string: str | None = None,
    ) -> str: ...

class PreparedAnonymizer:
    def __init__(self, prepared: NativePreparedSearch) -> None: ...
    @classmethod
    def from_config_json(
        cls,
        config_json: NativeSearchPackageInput,
    ) -> PreparedAnonymizer: ...
    @classmethod
    def from_config_json_and_artifact_bytes(
        cls,
        config_json: NativeSearchPackageInput,
        artifact_bytes: BytesLike,
    ) -> PreparedAnonymizer: ...
    @classmethod
    def from_prepared_package_bytes(
        cls,
        package_bytes: BytesLike,
    ) -> PreparedAnonymizer: ...
    def prepare_diagnostics_json(self) -> str: ...
    def warm_lazy_regex(self) -> None: ...
    def warm_lazy_regex_diagnostics_json(self) -> str: ...
    def create_redaction_session(
        self,
        session_id: str,
    ) -> PreparedRedactionSession: ...
    def create_redaction_session_with_lifecycle(
        self,
        session_id: str,
        *,
        created_at_epoch_seconds: int,
        expires_at_epoch_seconds: int | None = None,
    ) -> PreparedRedactionSession: ...
    def restore_redaction_session(
        self,
        plaintext_json: str,
    ) -> PreparedRedactionSession: ...
    def restore_encrypted_redaction_session(
        self,
        archive: BytesLike,
        key: BytesLike,
        expected_session_id: str,
        *,
        observed_at_epoch_seconds: int | None = None,
    ) -> PreparedRedactionSession: ...
    def redact_text(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_text_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_text_with_caller_detections(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_text_with_caller_detections_json(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_text_with_caller_detections_diagnostics_json(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_static_entities_with_caller_detections(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_text_stream_json(
        self,
        full_text: str,
        on_event: ResultEventCallback,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def diagnostics_stream_json(
        self,
        full_text: str,
        on_batch: DiagnosticsBatchCallback,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def summary_diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_static_entities(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_static_entities_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_static_entities_result_stream_json(
        self,
        full_text: str,
        on_event: ResultEventCallback,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_static_entities_diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_static_entities_summary_diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...

PreparedSearch: TypeAlias = PreparedAnonymizer

def prepare_search_package(
    config_json: NativeSearchPackageInput, *, compressed: bool = False
) -> bytes: ...
def load_prepared_package(package_bytes: BytesLike) -> PreparedAnonymizer: ...
def load_prepared_package_file(
    package_path: PathLikeString,
) -> PreparedAnonymizer: ...
def read_default_native_pipeline_package_file(
    *,
    language: str | None = None,
) -> bytes: ...
def available_default_native_pipeline_languages() -> tuple[str, ...]: ...
def create_native_pipeline_from_default_package(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
) -> PreparedAnonymizer: ...
def get_default_native_pipeline(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
) -> PreparedAnonymizer: ...
def create_pipeline(
    *,
    language: PipelineLanguageSelection = "all",
    warmup: DefaultNativePipelineWarmup | None = None,
) -> PreparedAnonymizer: ...
def preload_default_native_pipeline(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
) -> PreparedAnonymizer: ...
def redact_default_text(
    full_text: str,
    operators: OperatorConfig = None,
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
    redact_string: str | None = None,
) -> StaticRedactionResult: ...
def redact_default_text_json(
    full_text: str,
    operators: OperatorConfig = None,
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
    redact_string: str | None = None,
) -> str: ...
def redact_text(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> StaticRedactionResult: ...
def redact_text_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...
def redact_text_stream_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    on_event: ResultEventCallback,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...
def diagnostics_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...
def diagnostics_stream_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    on_batch: DiagnosticsBatchCallback,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...
def summary_diagnostics_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...
def deanonymise(
    redacted_text: str,
    redaction_map: RedactionMapInput,
) -> str: ...

__all__: list[str]
