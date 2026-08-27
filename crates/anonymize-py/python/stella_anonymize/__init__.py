from __future__ import annotations

import json
import gzip
import math
import re
from collections.abc import Callable, Mapping, Sequence
from functools import lru_cache
from importlib.resources import files
from os import PathLike
from typing import Literal, TypedDict, cast
from weakref import WeakSet

from ._caller_limits import (
    CALLER_DETECTION_MAX_COUNT,
    CALLER_DETECTION_REQUEST_JSON_MAX_BYTES,
    CALLER_DETECTION_TEXT_MAX_BYTES,
    SESSION_CALLER_INPUTS_JSON_MAX_BYTES,
    SESSION_CALLER_MAX_INPUTS,
)

from ._native import (
    OperatorEntry,
    PipelineEntity,
    PreparedRedactionSession as NativePreparedRedactionSession,
    PreparedSearch as NativePreparedSearch,
    RedactionEntry,
    RedactionResult,
    StaticRedactionResult,
    assemble_static_search_compressed_package_bytes,
    assemble_static_search_config_json,
    assemble_static_search_package_bytes,
    convert_external_detection_batch as _native_convert_external_detection_batch,
    external_detection_limits_json as _native_external_detection_limits_json,
    deanonymise as _native_deanonymise,
    native_package_version,
    normalize_for_search,
    prepare_static_search_artifacts_bytes,
    prepare_static_search_compressed_package_bytes,
    prepare_static_search_package_bytes,
    redact_static_entities_diagnostics_json,
    redact_static_entities_json,
    redact_static_entities_result_stream_json,
    redact_static_entities_summary_diagnostics_json,
)
from .docx import (
    DOCX_ARCHIVE_MAX_BYTES,
    DOCX_ENTRY_MAX_BYTES,
    DOCX_EXTRACTION_CONTRACT_VERSION,
    DOCX_UNCOMPRESSED_MAX_BYTES,
    DOCX_XML_MAX_DEPTH,
    DocxAnonymizationError,
    DocxExtractionError,
    DocxRestorationError,
    DocxRewriteError,
    anonymize_docx,
    extract_docx_text,
    restore_docx_text,
    rewrite_docx_text,
)
from .pdf import (
    PDF_RASTER_CONTRACT_VERSION,
    PDF_RASTER_MAX_OUTPUT_BYTES,
    PDF_RASTER_MAX_PAGE_BYTES,
    PDF_RASTER_REQUEST_JSON_MAX_BYTES,
    PDF_RASTER_MAX_TOTAL_BYTES,
    PDF_DOCUMENT_MAX_BYTES,
    PDF_INSPECTION_CONTRACT_VERSION,
    PDF_LOADED_PAYLOAD_MAX_BYTES,
    PDF_MAX_GLYPHS,
    PDF_MAX_OBJECT_DEPTH,
    PDF_MAX_OBJECT_NODES,
    PDF_MAX_OBJECTS,
    PDF_MAX_PAGES,
    PDF_MAX_PAGE_TEXT_UTF8_BYTES,
    PDF_MAX_OBSERVED_TEXT_UTF8_BYTES,
    PDF_OBSERVATIONS_JSON_MAX_BYTES,
    PDF_PAGE_DIMENSION_TOLERANCE_POINTS,
    PDF_STREAM_DECOMPRESSED_MAX_BYTES,
    PdfInspectionError,
    PdfRasterError,
    anonymize_pdf_raster,
    inspect_pdf,
    rewrite_pdf_raster_from_detections,
)

__all__ = [
    "__version__",
    "OperatorEntry",
    "OperatorConfig",
    "OperatorSelection",
    "MaskOperatorConfig",
    "CallerDetection",
    "CALLER_DETECTION_CONTRACT_VERSION",
    "CALLER_DETECTION_MAX_COUNT",
    "CALLER_DETECTION_REQUEST_JSON_MAX_BYTES",
    "CALLER_DETECTION_TEXT_MAX_BYTES",
    "SESSION_CALLER_INPUTS_JSON_MAX_BYTES",
    "SESSION_CALLER_MAX_INPUTS",
    "ExternalDetectionBatch",
    "ExternalDetection",
    "ExternalDetectionDocument",
    "ExternalDetectionLabelMapping",
    "ExternalDetectionOffsetUnit",
    "ExternalDetectionProvider",
    "EXTERNAL_DETECTION_BATCH_VERSION",
    "EXTERNAL_DETECTION_BATCH_MAX_BYTES",
    "EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES",
    "EXTERNAL_DETECTION_MAX_DETECTIONS",
    "EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS",
    "EXTERNAL_DETECTION_MAX_METADATA_BYTES",
    "EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES",
    "convert_external_detection_batch",
    "DiagnosticsBatchCallback",
    "ResultEventCallback",
    "DefaultNativePipelineWarmup",
    "PipelineLanguageSelection",
    "SupportedLanguage",
    "DEFAULT_NATIVE_PIPELINE_WARMUPS",
    "NativeSearchPackageInput",
    "PreparedAnonymizer",
    "PreparedRedactionSession",
    "SessionDeletionSummary",
    "SessionMetadata",
    "SessionStatus",
    "NativePreparedRedactionSession",
    "NativePreparedSearch",
    "PipelineEntity",
    "PreparedSearch",
    "RedactionEntry",
    "RedactionMapInput",
    "RedactionResult",
    "StaticRedactionResult",
    "assemble_static_search_compressed_package_bytes",
    "assemble_static_search_config_json",
    "assemble_static_search_package_bytes",
    "available_default_native_pipeline_languages",
    "create_native_pipeline_from_default_package",
    "create_pipeline",
    "deanonymise",
    "diagnostics_json",
    "diagnostics_stream_json",
    "get_default_native_pipeline",
    "load_prepared_package",
    "load_prepared_package_file",
    "native_package_version",
    "normalize_for_search",
    "preload_default_native_pipeline",
    "prepare_search_package",
    "prepare_static_search_artifacts_bytes",
    "prepare_static_search_compressed_package_bytes",
    "prepare_static_search_package_bytes",
    "redact_default_text",
    "redact_default_text_json",
    "read_default_native_pipeline_package_file",
    "redact_text",
    "redact_text_json",
    "redact_text_stream_json",
    "redact_static_entities_diagnostics_json",
    "redact_static_entities_json",
    "redact_static_entities_result_stream_json",
    "redact_static_entities_summary_diagnostics_json",
    "summary_diagnostics_json",
    "DOCX_ARCHIVE_MAX_BYTES",
    "DOCX_ENTRY_MAX_BYTES",
    "DOCX_EXTRACTION_CONTRACT_VERSION",
    "DOCX_UNCOMPRESSED_MAX_BYTES",
    "DOCX_XML_MAX_DEPTH",
    "DocxAnonymizationError",
    "DocxExtractionError",
    "DocxRestorationError",
    "DocxRewriteError",
    "anonymize_docx",
    "extract_docx_text",
    "restore_docx_text",
    "rewrite_docx_text",
    "PDF_DOCUMENT_MAX_BYTES",
    "PDF_INSPECTION_CONTRACT_VERSION",
    "PDF_LOADED_PAYLOAD_MAX_BYTES",
    "PDF_MAX_GLYPHS",
    "PDF_MAX_OBJECT_DEPTH",
    "PDF_MAX_OBJECT_NODES",
    "PDF_MAX_OBJECTS",
    "PDF_MAX_PAGES",
    "PDF_MAX_PAGE_TEXT_UTF8_BYTES",
    "PDF_MAX_OBSERVED_TEXT_UTF8_BYTES",
    "PDF_OBSERVATIONS_JSON_MAX_BYTES",
    "PDF_PAGE_DIMENSION_TOLERANCE_POINTS",
    "PDF_STREAM_DECOMPRESSED_MAX_BYTES",
    "PdfInspectionError",
    "PdfRasterError",
    "inspect_pdf",
    "anonymize_pdf_raster",
    "rewrite_pdf_raster_from_detections",
    "PDF_RASTER_CONTRACT_VERSION",
    "PDF_RASTER_MAX_OUTPUT_BYTES",
    "PDF_RASTER_MAX_PAGE_BYTES",
    "PDF_RASTER_REQUEST_JSON_MAX_BYTES",
    "PDF_RASTER_MAX_TOTAL_BYTES",
]

BytesLike = bytes | bytearray | memoryview
PathLikeString = str | PathLike[str]


class MaskOperatorConfig(TypedDict):
    type: Literal["mask"]
    masking_character: str
    characters_to_mask: int
    direction: Literal["start", "end"]


OperatorSelection = Literal["replace", "redact", "keep"] | MaskOperatorConfig
OperatorConfig = Mapping[str, OperatorSelection] | str | None
CALLER_DETECTION_CONTRACT_VERSION = 2
EXTERNAL_DETECTION_BATCH_VERSION = 1
_EXTERNAL_DETECTION_LIMITS = cast(
    dict[str, int], json.loads(_native_external_detection_limits_json())
)
EXTERNAL_DETECTION_BATCH_MAX_BYTES = _EXTERNAL_DETECTION_LIMITS["batchMaxBytes"]
EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES = _EXTERNAL_DETECTION_LIMITS["documentMaxBytes"]
EXTERNAL_DETECTION_MAX_DETECTIONS = _EXTERNAL_DETECTION_LIMITS["maxDetections"]
EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS = _EXTERNAL_DETECTION_LIMITS["maxLabelMappings"]
EXTERNAL_DETECTION_MAX_METADATA_BYTES = _EXTERNAL_DETECTION_LIMITS["maxMetadataBytes"]
EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES = _EXTERNAL_DETECTION_LIMITS[
    "providerIdMaxBytes"
]


class CallerDetection(TypedDict):
    start: int
    end: int
    label: str
    score: float
    provider_id: str
    detection_id: str


ExternalDetectionOffsetUnit = Literal[
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
) -> list[CallerDetection]:
    batch_json = (
        batch
        if isinstance(batch, str)
        else json.dumps(batch, separators=(",", ":"), ensure_ascii=False)
    )
    converted = json.loads(
        _native_convert_external_detection_batch(bytes(document), batch_json)
    )
    return cast(list[CallerDetection], converted["detections"])


DiagnosticsBatchCallback = Callable[[str], object]
ResultEventCallback = Callable[[str], object]
NativeSearchPackageInput = str | BytesLike | Mapping[str, object]
RedactionMapInput = (
    Mapping[str, str] | Sequence[RedactionEntry] | Sequence[tuple[str, str]]
)
DefaultNativePipelineWarmup = Literal["lazy-regex", "none"]
DEFAULT_NATIVE_PIPELINE_WARMUPS: tuple[
    DefaultNativePipelineWarmup,
    DefaultNativePipelineWarmup,
] = ("lazy-regex", "none")
DEFAULT_NATIVE_PIPELINE_PACKAGE = "native-pipeline.stlanonpkg"
_DEFAULT_NATIVE_PIPELINE_LANGUAGE_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_DEFAULT_NATIVE_PIPELINE_LANGUAGE_PACKAGE_PATTERN = re.compile(
    r"^native-pipeline\.([a-z0-9]+(?:-[a-z0-9]+)*)\.stlanonpkg$"
)

SessionStatus = Literal["active", "not_yet_active", "expired", "deleted"]


class SessionMetadata(TypedDict):
    session_id: str
    created_at_epoch_seconds: int | None
    expires_at_epoch_seconds: int | None
    mapping_count: int
    status: SessionStatus


class SessionDeletionSummary(TypedDict):
    session_id: str
    deleted_mapping_count: int


__version__ = native_package_version()


class PreparedRedactionSession:
    def __init__(self, session: NativePreparedRedactionSession) -> None:
        self._session = session

    def session_id(self) -> str:
        return self._session.session_id()

    def mapping_count(self) -> int:
        return self._session.mapping_count()

    def restore_text(
        self,
        full_text: str,
        observed_at_epoch_seconds: int | None = None,
    ) -> str:
        return self._session.restore_text(full_text, observed_at_epoch_seconds)

    def _plan_docx_text_batch(
        self,
        inputs: Sequence[Mapping[str, object]],
        operators: OperatorConfig,
        observed_at_epoch_seconds: int | None,
    ) -> object:
        if len(inputs) > SESSION_CALLER_MAX_INPUTS:
            raise ValueError(
                "Session caller inputs contains "
                f"{len(inputs)} items; the maximum is {SESSION_CALLER_MAX_INPUTS}"
            )
        detection_count = 0
        text_bytes = 0
        writer = _BoundedJsonWriter(
            SESSION_CALLER_INPUTS_JSON_MAX_BYTES,
            "Session caller inputs JSON",
            suffix="]",
        )
        writer.append_ascii("[")
        for index, item in enumerate(inputs):
            full_text = str(item["full_text"])
            detections = cast(Sequence[CallerDetection], item.get("detections", ()))
            detection_count += len(detections)
            if detection_count > CALLER_DETECTION_MAX_COUNT:
                raise ValueError(
                    "Session caller detections contains "
                    f"{detection_count} items; the maximum is "
                    f"{CALLER_DETECTION_MAX_COUNT}"
                )
            text_bytes += len(full_text.encode("utf-8"))
            if text_bytes > CALLER_DETECTION_TEXT_MAX_BYTES:
                raise ValueError(
                    "Session caller text contains "
                    f"{text_bytes} bytes; the maximum is "
                    f"{CALLER_DETECTION_TEXT_MAX_BYTES}"
                )
            request_json = _caller_detection_request_json(detections, full_text)
            if index > 0:
                writer.append_ascii(",")
            writer.append_ascii('{"full_text":')
            writer.append_string(full_text, "Session caller full_text")
            writer.append_ascii(',"request_json":')
            writer.append_string(request_json, "Session caller request_json")
            writer.append_ascii("}")
        inputs_json = writer.finish()
        return self._session.plan_docx_text_batch(
            inputs_json,
            _operator_config_json(operators, redact_string=None),
            observed_at_epoch_seconds,
        )

    def to_plaintext_json(self) -> str:
        return self._session.to_plaintext_json()

    def to_plaintext_json_at(self, observed_at_epoch_seconds: int) -> str:
        return self._session.to_plaintext_json_at(observed_at_epoch_seconds)

    def to_encrypted_archive(self, key: BytesLike) -> bytes:
        return self._session.to_encrypted_archive(bytes(key))

    def to_encrypted_archive_at(
        self,
        key: BytesLike,
        observed_at_epoch_seconds: int,
    ) -> bytes:
        return self._session.to_encrypted_archive_at(
            bytes(key),
            observed_at_epoch_seconds,
        )

    def inspect(
        self,
        observed_at_epoch_seconds: int | None = None,
    ) -> SessionMetadata:
        return json.loads(self._session.inspect_json(observed_at_epoch_seconds))

    def delete(self) -> SessionDeletionSummary:
        return json.loads(self._session.delete_json())

    def redact_text(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult:
        return self._session.redact_static_entities(
            full_text,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_text_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self._session.redact_static_entities_json(
            full_text,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_text_at(
        self,
        full_text: str,
        *,
        observed_at_epoch_seconds: int,
        operators: OperatorConfig = None,
        redact_string: str | None = None,
    ) -> StaticRedactionResult:
        return self._session.redact_static_entities_at(
            full_text,
            observed_at_epoch_seconds,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_text_json_at(
        self,
        full_text: str,
        *,
        observed_at_epoch_seconds: int,
        operators: OperatorConfig = None,
        redact_string: str | None = None,
    ) -> str:
        return self._session.redact_static_entities_json_at(
            full_text,
            observed_at_epoch_seconds,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_static_entities(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult:
        return self.redact_text(
            full_text,
            operators,
            redact_string=redact_string,
        )

    def redact_static_entities_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self.redact_text_json(
            full_text,
            operators,
            redact_string=redact_string,
        )

    def redact_static_entities_at(
        self,
        full_text: str,
        *,
        observed_at_epoch_seconds: int,
        operators: OperatorConfig = None,
        redact_string: str | None = None,
    ) -> StaticRedactionResult:
        return self.redact_text_at(
            full_text,
            observed_at_epoch_seconds=observed_at_epoch_seconds,
            operators=operators,
            redact_string=redact_string,
        )

    def redact_static_entities_json_at(
        self,
        full_text: str,
        *,
        observed_at_epoch_seconds: int,
        operators: OperatorConfig = None,
        redact_string: str | None = None,
    ) -> str:
        return self.redact_text_json_at(
            full_text,
            observed_at_epoch_seconds=observed_at_epoch_seconds,
            operators=operators,
            redact_string=redact_string,
        )


class PreparedAnonymizer:
    def __init__(self, prepared: NativePreparedSearch) -> None:
        self._prepared = prepared

    @classmethod
    def from_config_json(
        cls,
        config_json: NativeSearchPackageInput,
    ) -> PreparedAnonymizer:
        return cls(NativePreparedSearch(_native_search_config_json(config_json)))

    @classmethod
    def from_config_json_and_artifact_bytes(
        cls,
        config_json: NativeSearchPackageInput,
        artifact_bytes: BytesLike,
    ) -> PreparedAnonymizer:
        return cls(
            NativePreparedSearch.from_config_json_and_artifact_bytes(
                _native_search_config_json(config_json),
                bytes(artifact_bytes),
            )
        )

    @classmethod
    def from_prepared_package_bytes(
        cls,
        package_bytes: BytesLike,
    ) -> PreparedAnonymizer:
        return cls(
            NativePreparedSearch.from_prepared_package_bytes(bytes(package_bytes))
        )

    def prepare_diagnostics_json(self) -> str:
        return self._prepared.prepare_diagnostics_json()

    def warm_lazy_regex(self) -> None:
        self._prepared.warm_lazy_regex()

    def warm_lazy_regex_diagnostics_json(self) -> str:
        return self._prepared.warm_lazy_regex_diagnostics_json()

    def create_redaction_session(
        self,
        session_id: str,
    ) -> PreparedRedactionSession:
        return PreparedRedactionSession(
            self._prepared.create_redaction_session(session_id)
        )

    def create_redaction_session_with_lifecycle(
        self,
        session_id: str,
        *,
        created_at_epoch_seconds: int,
        expires_at_epoch_seconds: int | None = None,
    ) -> PreparedRedactionSession:
        return PreparedRedactionSession(
            self._prepared.create_redaction_session_with_lifecycle(
                session_id,
                created_at_epoch_seconds,
                expires_at_epoch_seconds,
            )
        )

    def restore_redaction_session(
        self,
        plaintext_json: str,
    ) -> PreparedRedactionSession:
        return PreparedRedactionSession(
            self._prepared.restore_redaction_session(plaintext_json)
        )

    def restore_encrypted_redaction_session(
        self,
        archive: BytesLike,
        key: BytesLike,
        expected_session_id: str,
        *,
        observed_at_epoch_seconds: int | None = None,
    ) -> PreparedRedactionSession:
        return PreparedRedactionSession(
            self._prepared.restore_encrypted_redaction_session(
                bytes(archive),
                bytes(key),
                expected_session_id,
                observed_at_epoch_seconds,
            )
        )

    def redact_text(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult:
        return self._prepared.redact_static_entities(
            full_text,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_text_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self._prepared.redact_static_entities_json(
            full_text,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_text_with_caller_detections(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult:
        return self._prepared.redact_static_entities_with_caller_detections(
            full_text,
            _caller_detection_request_json(detections, full_text),
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_text_with_caller_detections_json(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self._prepared.redact_static_entities_with_caller_detections_json(
            full_text,
            _caller_detection_request_json(detections, full_text),
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_text_with_caller_detections_diagnostics_json(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self._prepared.redact_static_entities_with_caller_detections_diagnostics_json(
            full_text,
            _caller_detection_request_json(detections, full_text),
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_static_entities_with_caller_detections(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult:
        return self.redact_text_with_caller_detections(
            full_text,
            detections,
            operators,
            redact_string=redact_string,
        )

    def redact_text_stream_json(
        self,
        full_text: str,
        on_event: ResultEventCallback,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self._prepared.redact_static_entities_result_stream_json(
            full_text,
            on_event,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self._prepared.redact_static_entities_diagnostics_json(
            full_text,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def diagnostics_stream_json(
        self,
        full_text: str,
        on_batch: DiagnosticsBatchCallback,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self._prepared.redact_static_entities_diagnostics_stream_json(
            full_text,
            on_batch,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def summary_diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self._prepared.redact_static_entities_summary_diagnostics_json(
            full_text,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_static_entities(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult:
        return self.redact_text(
            full_text,
            operators,
            redact_string=redact_string,
        )

    def redact_static_entities_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self.redact_text_json(
            full_text,
            operators,
            redact_string=redact_string,
        )

    def redact_static_entities_result_stream_json(
        self,
        full_text: str,
        on_event: ResultEventCallback,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self.redact_text_stream_json(
            full_text,
            on_event,
            operators,
            redact_string=redact_string,
        )

    def redact_static_entities_diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self.diagnostics_json(
            full_text,
            operators,
            redact_string=redact_string,
        )

    def redact_static_entities_summary_diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self.summary_diagnostics_json(
            full_text,
            operators,
            redact_string=redact_string,
        )


PreparedSearch = PreparedAnonymizer
_warmed_default_native_pipelines: WeakSet[PreparedAnonymizer] = WeakSet()
SupportedLanguage = str
PipelineLanguageSelection = SupportedLanguage | Sequence[SupportedLanguage]
_DEFAULT_PIPELINE_INPUT = "default-pipeline-input.json.gz"
_PIPELINE_LANGUAGE_SCOPES = "pipeline-language-scopes.json"


def prepare_search_package(
    config_json: NativeSearchPackageInput,
    *,
    compressed: bool = False,
) -> bytes:
    normalized_config_json = _native_search_config_json(config_json)
    if compressed:
        return prepare_static_search_compressed_package_bytes(normalized_config_json)
    return prepare_static_search_package_bytes(normalized_config_json)


def load_prepared_package(package_bytes: BytesLike) -> PreparedAnonymizer:
    return _load_prepared_package(bytes(package_bytes))


def load_prepared_package_file(package_path: PathLikeString) -> PreparedAnonymizer:
    with open(package_path, "rb") as handle:
        return load_prepared_package(handle.read())


def read_default_native_pipeline_package_file(
    *,
    language: str | None = None,
) -> bytes:
    package_name = _default_native_pipeline_package_name(language)
    try:
        resource = files(__name__).joinpath("native_packages", package_name)
        return resource.read_bytes()
    except (FileNotFoundError, ModuleNotFoundError, OSError) as error:
        raise FileNotFoundError(
            f"{_default_native_pipeline_package_description(language)} is unavailable: {error}"
        ) from error


def available_default_native_pipeline_languages() -> tuple[str, ...]:
    languages: set[str] = set()
    try:
        package_dir = files(__name__).joinpath("native_packages")
        for resource in package_dir.iterdir():
            match = _DEFAULT_NATIVE_PIPELINE_LANGUAGE_PACKAGE_PATTERN.fullmatch(
                resource.name
            )
            if match is not None:
                languages.add(match.group(1))
    except (FileNotFoundError, ModuleNotFoundError, OSError) as error:
        raise FileNotFoundError(
            f"Default native pipeline package directory is unavailable: {error}"
        ) from error
    return tuple(sorted(languages))


def create_native_pipeline_from_default_package(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
) -> PreparedAnonymizer:
    return _apply_default_native_pipeline_warmup(
        _prepared_anonymizer_from_default_package(
            language=language,
            package_path=package_path,
        ),
        _normalize_default_native_pipeline_warmup(warmup),
    )


def _prepared_anonymizer_from_default_package(
    *,
    language: str | None,
    package_path: PathLikeString | None,
) -> PreparedAnonymizer:
    if language is not None and package_path is not None:
        raise ValueError("Use either language or package_path, not both")
    return _prepared_anonymizer_from_trusted_package_bytes(
        _read_default_native_pipeline_package(
            language=language,
            package_path=package_path,
        )
    )


def _prepared_anonymizer_from_trusted_package_bytes(
    package_bytes: BytesLike,
) -> PreparedAnonymizer:
    return PreparedAnonymizer(
        NativePreparedSearch.from_trusted_prepared_package_bytes_without_cache(
            bytes(package_bytes)
        )
    )


def get_default_native_pipeline(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
) -> PreparedAnonymizer:
    return _apply_default_native_pipeline_warmup(
        _get_default_native_pipeline(
            _default_native_pipeline_cache_key(
                language=language,
                package_path=package_path,
            )
        ),
        _normalize_default_native_pipeline_warmup(warmup),
    )


def create_pipeline(
    *,
    language: PipelineLanguageSelection = "all",
    warmup: DefaultNativePipelineWarmup | None = None,
) -> PreparedAnonymizer:
    selection = _normalize_pipeline_language_selection(language)
    resolved_warmup = _normalize_default_native_pipeline_warmup(warmup)
    if selection is None:
        return get_default_native_pipeline(warmup=resolved_warmup)
    _validate_supported_pipeline_languages(selection)
    if len(selection) == 1 and _default_native_pipeline_language_package_exists(
        selection[0]
    ):
        return get_default_native_pipeline(
            language=selection[0], warmup=resolved_warmup
        )
    return _apply_default_native_pipeline_warmup(
        _get_scoped_pipeline(selection),
        resolved_warmup,
    )


def preload_default_native_pipeline(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
) -> PreparedAnonymizer:
    return _apply_default_native_pipeline_warmup(
        get_default_native_pipeline(
            language=language,
            package_path=package_path,
            warmup="none",
        ),
        "lazy-regex",
    )


def redact_default_text(
    full_text: str,
    operators: OperatorConfig = None,
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
    redact_string: str | None = None,
) -> StaticRedactionResult:
    return get_default_native_pipeline(
        language=language,
        package_path=package_path,
        warmup=warmup,
    ).redact_text(
        full_text,
        operators,
        redact_string=redact_string,
    )


def redact_default_text_json(
    full_text: str,
    operators: OperatorConfig = None,
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
    redact_string: str | None = None,
) -> str:
    return get_default_native_pipeline(
        language=language,
        package_path=package_path,
        warmup=warmup,
    ).redact_text_json(
        full_text,
        operators,
        redact_string=redact_string,
    )


def _apply_default_native_pipeline_warmup(
    pipeline: PreparedAnonymizer,
    warmup: DefaultNativePipelineWarmup,
) -> PreparedAnonymizer:
    if warmup != "lazy-regex":
        return pipeline
    if pipeline not in _warmed_default_native_pipelines:
        pipeline.warm_lazy_regex()
        _warmed_default_native_pipelines.add(pipeline)
    return pipeline


def _normalize_default_native_pipeline_warmup(
    warmup: DefaultNativePipelineWarmup | None,
) -> DefaultNativePipelineWarmup:
    if warmup is None:
        return "none"
    if warmup in DEFAULT_NATIVE_PIPELINE_WARMUPS:
        return warmup
    raise ValueError('Default native pipeline warmup must be "lazy-regex" or "none"')


@lru_cache(maxsize=8)
def _load_prepared_package(package_bytes: bytes) -> PreparedAnonymizer:
    return PreparedAnonymizer.from_prepared_package_bytes(package_bytes)


@lru_cache(maxsize=8)
def _get_default_native_pipeline(
    cache_key: tuple[str | None, str | None],
) -> PreparedAnonymizer:
    language, package_path = cache_key
    return create_native_pipeline_from_default_package(
        language=language,
        package_path=package_path,
        warmup="none",
    )


@lru_cache(maxsize=1)
def _default_pipeline_input() -> tuple[
    dict[str, object], dict[str, object], frozenset[str]
]:
    try:
        resource = files(__name__).joinpath("native_packages", _DEFAULT_PIPELINE_INPUT)
        payload = json.loads(gzip.decompress(resource.read_bytes()))
    except (FileNotFoundError, ModuleNotFoundError, OSError) as error:
        raise FileNotFoundError(
            "Semantic language selection data is unavailable; reinstall "
            "stella-anonymize-core from a complete wheel"
        ) from error
    if not isinstance(payload, dict):
        raise TypeError("Default pipeline input must be an object")
    config = payload.get("config")
    dictionaries = payload.get("dictionaries")
    supported_languages = payload.get("supportedLanguages")
    if not isinstance(config, dict) or not isinstance(dictionaries, dict):
        raise TypeError("Default pipeline input is missing config or dictionaries")
    if not isinstance(supported_languages, list) or not all(
        isinstance(language, str) for language in supported_languages
    ):
        raise TypeError("Default pipeline input has invalid supported languages")
    supported = frozenset(supported_languages)
    if supported != _supported_pipeline_languages():
        raise TypeError("Default pipeline input language metadata does not match")
    return config, dictionaries, supported


@lru_cache(maxsize=1)
def _supported_pipeline_languages() -> frozenset[str]:
    try:
        resource = files(__name__).joinpath(
            "native_packages", _PIPELINE_LANGUAGE_SCOPES
        )
        payload = json.loads(resource.read_bytes())
    except (FileNotFoundError, ModuleNotFoundError, OSError) as error:
        raise FileNotFoundError(
            "Pipeline language metadata is unavailable; reinstall "
            "stella-anonymize-core from a complete wheel"
        ) from error
    if not isinstance(payload, dict):
        raise TypeError("Pipeline language metadata must be an object")
    languages = payload.get("languages")
    if not isinstance(languages, dict) or not languages:
        raise TypeError("Pipeline language metadata has invalid languages")
    if not all(
        isinstance(language, str) and language and isinstance(scope, dict)
        for language, scope in languages.items()
    ):
        raise TypeError("Pipeline language metadata has invalid language scopes")
    return frozenset(languages)


def _normalize_pipeline_language_selection(
    selection: PipelineLanguageSelection,
) -> tuple[str, ...] | None:
    if isinstance(selection, str):
        normalized = selection.strip().lower()
        if normalized == "all":
            return None
        requested = (normalized,)
    elif isinstance(selection, Sequence) and not isinstance(
        selection, (bytes, bytearray, memoryview)
    ):
        requested = tuple(
            language.strip().lower()
            if isinstance(language, str)
            else _raise_pipeline_language_type_error()
            for language in selection
        )
    else:
        raise TypeError("Pipeline language must be a string or a sequence of strings")
    if not requested:
        raise ValueError("Pipeline language selection must not be empty")
    return tuple(sorted(set(requested)))


def _validate_supported_pipeline_languages(languages: tuple[str, ...]) -> None:
    supported_languages = _supported_pipeline_languages()
    unsupported = sorted(set(languages).difference(supported_languages))
    if unsupported:
        raise ValueError(
            "Unsupported pipeline language(s): "
            f"{', '.join(unsupported)}; expected one of: "
            f"{', '.join(sorted(supported_languages))}"
        )


def _raise_pipeline_language_type_error() -> str:
    raise TypeError("Pipeline language codes must be strings")


@lru_cache(maxsize=8)
def _get_scoped_pipeline(languages: tuple[str, ...]) -> PreparedAnonymizer:
    default_config, dictionaries, _ = _default_pipeline_input()
    config = dict(default_config)
    if len(languages) == 1:
        config["language"] = languages[0]
        config.pop("languages", None)
    else:
        config["languages"] = list(languages)
        config.pop("language", None)
    package_bytes = assemble_static_search_package_bytes(
        json.dumps(config, separators=(",", ":")),
        json.dumps(dictionaries, separators=(",", ":")),
        None,
    )
    return _prepared_anonymizer_from_trusted_package_bytes(package_bytes)


@lru_cache(maxsize=8)
def _prepare_from_config_json(config_json: str) -> PreparedAnonymizer:
    return PreparedAnonymizer.from_config_json(config_json)


def redact_text(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> StaticRedactionResult:
    prepared = _prepare_from_config_json(_native_search_config_json(config_json))
    return prepared.redact_text(
        full_text,
        operators,
        redact_string=redact_string,
    )


def redact_text_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str:
    prepared = _prepare_from_config_json(_native_search_config_json(config_json))
    return prepared.redact_text_json(
        full_text,
        operators,
        redact_string=redact_string,
    )


def redact_text_stream_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    on_event: ResultEventCallback,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str:
    prepared = _prepare_from_config_json(_native_search_config_json(config_json))
    return prepared.redact_text_stream_json(
        full_text,
        on_event,
        operators,
        redact_string=redact_string,
    )


def diagnostics_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str:
    prepared = _prepare_from_config_json(_native_search_config_json(config_json))
    return prepared.diagnostics_json(
        full_text,
        operators,
        redact_string=redact_string,
    )


def diagnostics_stream_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    on_batch: DiagnosticsBatchCallback,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str:
    prepared = _prepare_from_config_json(_native_search_config_json(config_json))
    return prepared.diagnostics_stream_json(
        full_text,
        on_batch,
        operators,
        redact_string=redact_string,
    )


def summary_diagnostics_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str:
    prepared = _prepare_from_config_json(_native_search_config_json(config_json))
    return prepared.summary_diagnostics_json(
        full_text,
        operators,
        redact_string=redact_string,
    )


def deanonymise(redacted_text: str, redaction_map: RedactionMapInput) -> str:
    return _native_deanonymise(redacted_text, _redaction_map_pairs(redaction_map))


def _redaction_map_pairs(
    redaction_map: RedactionMapInput,
) -> list[tuple[str, str]]:
    if isinstance(redaction_map, Mapping):
        return list(redaction_map.items())
    if isinstance(redaction_map, (str, bytes, bytearray, memoryview)):
        raise TypeError(
            "redaction_map must be a mapping or a sequence of redaction entries"
        )
    pairs: list[tuple[str, str]] = []
    for entry in redaction_map:
        if isinstance(entry, RedactionEntry):
            pairs.append((entry.placeholder, entry.original))
            continue
        if not isinstance(entry, (tuple, list)) or len(entry) != 2:
            raise TypeError(
                "Each redaction_map entry must be a RedactionEntry "
                "or a (placeholder, original) pair"
            )
        placeholder, original = entry
        pairs.append((placeholder, original))
    return pairs


def _read_default_native_pipeline_package(
    *,
    language: str | None,
    package_path: PathLikeString | None,
) -> bytes:
    if language is not None and package_path is not None:
        raise ValueError("Use either language or package_path, not both")
    if package_path is not None:
        with open(package_path, "rb") as handle:
            return handle.read()
    return read_default_native_pipeline_package_file(language=language)


def _default_native_pipeline_cache_key(
    *,
    language: str | None,
    package_path: PathLikeString | None,
) -> tuple[str | None, str | None]:
    if language is not None and package_path is not None:
        raise ValueError("Use either language or package_path, not both")
    return (
        _resolve_default_native_pipeline_language(language)
        if language is not None
        else None,
        str(package_path) if package_path is not None else None,
    )


def _default_native_pipeline_package_name(language: str | None) -> str:
    if language is None:
        return DEFAULT_NATIVE_PIPELINE_PACKAGE
    resolved = _resolve_default_native_pipeline_language(language)
    return f"native-pipeline.{resolved}.stlanonpkg"


def _default_native_pipeline_package_description(language: str | None) -> str:
    if language is None:
        return "Default native pipeline package"
    resolved = _resolve_default_native_pipeline_language(language)
    return f'Default native pipeline package for language "{resolved}"'


def _resolve_default_native_pipeline_language(language: str) -> str:
    normalized = _normalize_default_native_pipeline_language(language)
    if _default_native_pipeline_language_package_exists(normalized):
        return normalized
    base_language = normalized.split("-", maxsplit=1)[0]
    if base_language != normalized and _default_native_pipeline_language_package_exists(
        base_language
    ):
        return base_language
    return normalized


def _default_native_pipeline_language_package_exists(language: str) -> bool:
    package_name = f"native-pipeline.{language}.stlanonpkg"
    try:
        return files(__name__).joinpath("native_packages", package_name).is_file()
    except (FileNotFoundError, ModuleNotFoundError, OSError):
        return False


def _normalize_default_native_pipeline_language(language: str) -> str:
    normalized = language.strip().lower()
    if not _DEFAULT_NATIVE_PIPELINE_LANGUAGE_PATTERN.fullmatch(normalized):
        raise ValueError(
            "Default native pipeline language must match "
            f"{_DEFAULT_NATIVE_PIPELINE_LANGUAGE_PATTERN.pattern}"
        )
    return normalized


def _native_search_config_json(config_json: NativeSearchPackageInput) -> str:
    if isinstance(config_json, str):
        return config_json
    if isinstance(config_json, (bytes, bytearray, memoryview)):
        return bytes(config_json).decode("utf-8")
    return json.dumps(config_json, separators=(",", ":"), ensure_ascii=False)


def _caller_detection_request_json(
    detections: Sequence[CallerDetection],
    full_text: str,
) -> str:
    if len(detections) > CALLER_DETECTION_MAX_COUNT:
        raise ValueError(
            f"Caller detections contains {len(detections)} items; the maximum is "
            f"{CALLER_DETECTION_MAX_COUNT}"
        )
    text_bytes = len(full_text.encode("utf-8"))
    if text_bytes > CALLER_DETECTION_TEXT_MAX_BYTES:
        raise ValueError(
            f"Caller detection text contains {text_bytes} bytes; the maximum is "
            f"{CALLER_DETECTION_TEXT_MAX_BYTES}"
        )
    writer = _BoundedJsonWriter(
        CALLER_DETECTION_REQUEST_JSON_MAX_BYTES,
        "Caller detection request JSON",
        suffix="]}",
    )
    writer.append_ascii(
        f'{{"version":{CALLER_DETECTION_CONTRACT_VERSION},"detections":['
    )
    for index, detection in enumerate(detections):
        if index > 0:
            writer.append_ascii(",")
        writer.append_ascii('{"start":')
        writer.append_offset(detection["start"], "Caller detection start")
        writer.append_ascii(',"end":')
        writer.append_offset(detection["end"], "Caller detection end")
        writer.append_ascii(',"label":')
        writer.append_string(detection["label"], "Caller detection label")
        writer.append_ascii(',"score":')
        writer.append_score(detection["score"], "Caller detection score")
        writer.append_ascii(',"provider_id":')
        writer.append_string(detection["provider_id"], "Caller detection provider_id")
        writer.append_ascii(',"detection_id":')
        writer.append_string(detection["detection_id"], "Caller detection detection_id")
        writer.append_ascii("}")
    return writer.finish()


_CALLER_JSON_STRING_CHUNK_CHARACTERS = 64 * 1024


class _BoundedJsonWriter:
    def __init__(self, maximum_bytes: int, label: str, *, suffix: str) -> None:
        self._chunks: list[str] = []
        self._suffix = suffix
        self._maximum_bytes = maximum_bytes - len(suffix.encode("utf-8"))
        self._reported_maximum_bytes = maximum_bytes
        self._label = label
        self._bytes = 0

    def append_ascii(self, value: str) -> None:
        self._reserve(len(value))
        self._chunks.append(value)

    def append_offset(self, value: object, field: str) -> None:
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            or value > 0xFFFFFFFF
        ):
            raise ValueError(f"{field} must be an unsigned 32-bit integer")
        self.append_ascii(str(value))

    def append_score(self, value: object, field: str) -> None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError(f"{field} must be a number")
        if not 0 <= value <= 1 or not math.isfinite(value):
            raise ValueError(f"{field} must be finite and between 0 and 1")
        self.append_ascii(_ecmascript_score_json(value))

    def append_string(self, value: object, field: str) -> None:
        if not isinstance(value, str):
            raise TypeError(f"{field} must be a string")
        self.append_ascii('"')
        for offset in range(0, len(value), _CALLER_JSON_STRING_CHUNK_CHARACTERS):
            chunk = value[offset : offset + _CALLER_JSON_STRING_CHUNK_CHARACTERS]
            encoded_chunk = json.dumps(
                chunk, separators=(",", ":"), ensure_ascii=False
            )[1:-1]
            self._reserve(len(encoded_chunk.encode("utf-8")))
            self._chunks.append(encoded_chunk)
        self.append_ascii('"')

    def finish(self) -> str:
        return "".join(self._chunks) + self._suffix

    def _reserve(self, byte_count: int) -> None:
        if byte_count > self._maximum_bytes - self._bytes:
            raise ValueError(
                f"{self._label} exceeds the {self._reported_maximum_bytes}-byte maximum"
            )
        self._bytes += byte_count


def _ecmascript_score_json(value: int | float) -> str:
    number = float(value)
    if number == 0:
        return "0"
    if number == 1:
        return "1"

    rendered = repr(number).lower()
    if "e" not in rendered:
        return rendered

    mantissa, exponent_text = rendered.split("e")
    exponent = int(exponent_text)
    if number < 1e-6:
        return f"{mantissa}e{exponent}"

    integer, _, fraction = mantissa.partition(".")
    digits = integer + fraction
    decimal_position = len(integer) + exponent
    if decimal_position <= 0:
        return f"0.{('0' * -decimal_position)}{digits}"
    if decimal_position >= len(digits):
        return digits + ("0" * (decimal_position - len(digits)))
    return f"{digits[:decimal_position]}.{digits[decimal_position:]}"


def _operator_config_json(
    operators: OperatorConfig,
    *,
    redact_string: str | None,
) -> str | None:
    if operators is None and redact_string is None:
        return None
    if isinstance(operators, str):
        if redact_string is not None:
            raise ValueError("redact_string cannot be combined with raw JSON")
        return operators
    payload: dict[str, object] = {}
    if operators is not None:
        payload["operators"] = dict(operators)
    if redact_string is not None:
        payload["redactString"] = redact_string
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
