"""Bounded DOCX extraction, rewriting, anonymization, and restoration.

The public shapes mirror ``@stll/anonymize-docx`` while using Python naming.
All offsets are UTF-16 code-unit offsets, matching the cross-runtime contract.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any, TypedDict

from ._caller_limits import CALLER_DETECTION_MAX_COUNT
from ._native import extract_docx_text_json as _extract_docx_text_json
from ._native import plan_docx_restoration_json as _plan_docx_restoration_json
from ._native import rewrite_docx_text_native as _rewrite_docx_text_native

DOCX_EXTRACTION_CONTRACT_VERSION = 1
DOCX_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024
DOCX_ENTRY_MAX_BYTES = 16 * 1024 * 1024
DOCX_UNCOMPRESSED_MAX_BYTES = 128 * 1024 * 1024
DOCX_XML_MAX_DEPTH = 256
DOCX_MAX_TEXT_BLOCKS = 100_000
DOCX_MAX_REPLACEMENTS = 1_000_000


class DocxError(ValueError):
    """Base class for stable, coded DOCX errors."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class DocxExtractionError(DocxError):
    pass


class DocxRewriteError(DocxError):
    pass


class DocxAnonymizationError(DocxError):
    pass


class DocxRestorationError(DocxError):
    pass


class DocxTextReplacement(TypedDict):
    start: int
    end: int
    replacement: str


class DocxBlockRewrite(TypedDict):
    location: Mapping[str, Any]
    expected_text: str
    replacements: Sequence[DocxTextReplacement]


def extract_docx_text(document: bytes | bytearray | memoryview) -> dict[str, Any]:
    """Extract redactable DOCX text blocks and fail-closed coverage metadata."""

    try:
        return json.loads(_extract_docx_text_json(bytes(document)))
    except ValueError as error:
        message = str(error)
        if "unsafe entry path" in message:
            code = "unsafe-entry-path"
        elif "valid bounded DOCX ZIP archive" in message:
            code = "invalid-archive"
        elif "valid XML" in message or "valid UTF-8" in message:
            code = "invalid-xml"
        elif f"must not exceed {DOCX_ARCHIVE_MAX_BYTES} bytes" in message:
            code = "archive-limit-exceeded"
        elif (
            "must not exceed" in message
            or "must not contain more than" in message
            or "at most" in message
        ):
            code = "uncompressed-limit-exceeded"
        else:
            code = "invalid-package"
        raise DocxExtractionError(code, message) from error


def _location_key(location: Mapping[str, Any]) -> str:
    part = location.get("part")
    part_path = part.get("path") if isinstance(part, Mapping) else None
    xml_path = location.get("xmlPath")
    return f"{part_path}:{location.get('type')}:{'.'.join(str(item) for item in xml_path or [])}"


def _preflight_rewrite_plan(
    rewrites: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    if len(rewrites) > DOCX_MAX_TEXT_BLOCKS:
        raise DocxRewriteError(
            "rewrite-limit-exceeded",
            f"DOCX rewrites must not contain more than {DOCX_MAX_TEXT_BLOCKS} blocks",
        )
    replacement_count = 0
    estimated_bytes = len(rewrites) * 256
    serializable_rewrites: list[dict[str, Any]] = []
    for rewrite in rewrites:
        replacements = rewrite.get("replacements")
        if not isinstance(replacements, Sequence) or isinstance(
            replacements, (str, bytes, bytearray)
        ):
            raise DocxRewriteError(
                "invalid-replacement",
                "DOCX block rewrite replacements must be a sequence",
            )
        replacement_count += len(replacements)
        if replacement_count > DOCX_MAX_REPLACEMENTS:
            raise DocxRewriteError(
                "rewrite-limit-exceeded",
                f"DOCX rewrites must not contain more than {DOCX_MAX_REPLACEMENTS} replacements",
            )
        expected_text = rewrite.get("expectedText")
        estimated_bytes += (
            len(expected_text) * 6 if isinstance(expected_text, str) else 0
        ) + len(replacements) * 96
        serializable_replacements: list[Any] = []
        for replacement in replacements:
            if isinstance(replacement, Mapping):
                value = replacement.get("replacement")
                if isinstance(value, str):
                    estimated_bytes += len(value) * 6
                serializable_replacements.append(
                    {
                        "start": replacement.get("start"),
                        "end": replacement.get("end"),
                        "replacement": value,
                    }
                )
            else:
                serializable_replacements.append(None)
        location = rewrite.get("location")
        serializable_location: Any = None
        if isinstance(location, Mapping):
            serializable_location = {
                "type": location.get("type"),
                "blockIndex": location.get("blockIndex"),
            }
            part = location.get("part")
            if isinstance(part, Mapping):
                serializable_location["part"] = {
                    "type": part.get("type"),
                    "path": part.get("path"),
                }
                for value in (part.get("type"), part.get("path")):
                    if isinstance(value, str):
                        estimated_bytes += len(value) * 6
            location_type = location.get("type")
            if isinstance(location_type, str):
                estimated_bytes += len(location_type) * 6
            for key in (
                "xmlPath",
                "tablePath",
                "rowPath",
                "cellPath",
                "textBoxPath",
            ):
                path = location.get(key)
                if isinstance(path, Sequence) and not isinstance(
                    path, (str, bytes, bytearray)
                ):
                    if len(path) > DOCX_XML_MAX_DEPTH:
                        raise DocxRewriteError(
                            "invalid-replacement",
                            f"DOCX rewrite location paths must not exceed {DOCX_XML_MAX_DEPTH} entries",
                        )
                    estimated_bytes += len(path) * 24
                    serializable_location[key] = list(path)
        serializable_rewrites.append(
            {
                "location": serializable_location,
                "expectedText": expected_text,
                "replacements": serializable_replacements,
            }
        )
        if estimated_bytes > DOCX_UNCOMPRESSED_MAX_BYTES:
            raise DocxRewriteError(
                "rewrite-limit-exceeded",
                f"DOCX rewrite plans must not exceed {DOCX_UNCOMPRESSED_MAX_BYTES} estimated serialized bytes",
            )
    return serializable_rewrites


def rewrite_docx_text(
    document: bytes | bytearray | memoryview,
    rewrites: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Apply the shared Rust DOCX rewrite contract."""

    try:
        normalized_rewrites = []
        for rewrite in rewrites:
            normalized = dict(rewrite)
            if "expectedText" not in normalized and "expected_text" in normalized:
                normalized["expectedText"] = normalized.pop("expected_text")
            normalized_rewrites.append(normalized)
        serializable_rewrites = _preflight_rewrite_plan(normalized_rewrites)
        rewrites_json = json.dumps(
            serializable_rewrites, separators=(",", ":"), ensure_ascii=False
        )
    except DocxRewriteError:
        raise
    except (TypeError, ValueError) as error:
        raise DocxRewriteError(
            "invalid-replacement",
            f"DOCX rewrite plan is not serializable: {error}",
        ) from error
    try:
        rewritten, block_count, replacement_count = _rewrite_docx_text_native(
            bytes(document), rewrites_json
        )
    except ValueError as error:
        message = str(error)
        code, separator, detail = message.partition(": ")
        if separator and code in {
            "archive-limit-exceeded",
            "invalid-archive",
            "invalid-package",
            "invalid-xml",
            "unsafe-entry-path",
            "uncompressed-limit-exceeded",
        }:
            raise DocxExtractionError(code, detail) from error
        if separator and code in {
            "invalid-replacement",
            "rewrite-limit-exceeded",
            "stale-extraction",
            "unsupported-replacement",
        }:
            raise DocxRewriteError(code, detail) from error
        raise
    return {
        "document": bytes(rewritten),
        "rewrittenBlockCount": block_count,
        "appliedReplacementCount": replacement_count,
    }


def _coverage_summary(coverage: Mapping[str, Any]) -> dict[str, int]:
    parts = coverage["parts"]
    return {
        "extractedPartCount": sum(item["status"] == "extracted" for item in parts),
        "unsupportedPartCount": sum(item["status"] == "unsupported" for item in parts),
        **{
            key: int(coverage[key])
            for key in (
                "hyperlinkTextSegmentCount",
                "revisionTextSegmentCount",
                "unsupportedAlternateContentCount",
                "unsupportedSymbolCount",
                "unsupportedFieldInstructionCount",
            )
        },
    }


def _workflow_coverage(coverage: Mapping[str, Any]) -> dict[str, Any]:
    counts = _coverage_summary(coverage)
    partial = counts["unsupportedPartCount"] > 0 or any(
        counts[key] > 0
        for key in (
            "hyperlinkTextSegmentCount",
            "revisionTextSegmentCount",
            "unsupportedAlternateContentCount",
            "unsupportedSymbolCount",
            "unsupportedFieldInstructionCount",
        )
    )
    return {"status": "partial" if partial else "full", "counts": counts}


def anonymize_docx(
    document: bytes | bytearray | memoryview,
    session: Any,
    expected_session_id: str,
    policy: Mapping[str, Any],
    *,
    caller_detections: Sequence[Mapping[str, Any]] = (),
    observed_at_epoch_seconds: int | None = None,
) -> dict[str, Any]:
    """Anonymize all extracted blocks with a prepared redaction session."""

    session_id = session.session_id()
    if session_id != expected_session_id:
        raise DocxAnonymizationError(
            "session-mismatch",
            "DOCX anonymization session does not match the expected session",
        )
    extraction = extract_docx_text(document)
    coverage = _workflow_coverage(extraction["coverage"])
    coverage_policy = policy.get("coverage", policy)
    if (
        coverage["status"] == "partial"
        and coverage_policy.get("mode") == "require-full"
    ):
        raise DocxAnonymizationError(
            "incomplete-coverage",
            "DOCX contains content outside the fully supported anonymization coverage",
        )
    blocks_by_location = {
        _location_key(block["location"]): block for block in extraction["blocks"]
    }
    detections_by_location: dict[str, Mapping[str, Any]] = {}
    caller_count = 0
    for item in caller_detections:
        key = _location_key(item["location"])
        if key in detections_by_location:
            raise DocxAnonymizationError(
                "invalid-caller-detections",
                "Each DOCX block may have only one caller-detection input",
            )
        block = blocks_by_location.get(key)
        if (
            block is None
            or block["location"] != dict(item["location"])
            or item.get("expectedText", item.get("expected_text")) != block["text"]
        ):
            raise DocxAnonymizationError(
                "invalid-caller-detections",
                "DOCX caller-detection location or expected text no longer matches",
            )
        caller_count += len(item.get("detections", ()))
        if caller_count > CALLER_DETECTION_MAX_COUNT:
            raise DocxAnonymizationError(
                "invalid-caller-detections",
                "DOCX workflows must not contain more than "
                f"{CALLER_DETECTION_MAX_COUNT} caller detections",
            )
        detections_by_location[key] = item
    rewrites: list[dict[str, Any]] = []
    operators = policy.get("operators")
    plan_inputs: list[dict[str, Any]] = []
    for block in extraction["blocks"]:
        detection_input = detections_by_location.get(_location_key(block["location"]))
        if (
            detection_input is not None
            and detection_input.get(
                "expectedText", detection_input.get("expected_text")
            )
            != block["text"]
        ):
            raise DocxAnonymizationError(
                "invalid-caller-detections",
                "DOCX caller-detection location or expected text no longer matches",
            )
        plan_inputs.append(
            {
                "full_text": block["text"],
                "detections": (
                    ()
                    if detection_input is None
                    else detection_input.get("detections", ())
                ),
            }
        )
    try:
        native_plan = session._plan_docx_text_batch(
            plan_inputs, operators, observed_at_epoch_seconds
        )
        block_plans = json.loads(native_plan.result_json())
    except (AttributeError, TypeError, ValueError) as error:
        raise DocxAnonymizationError(
            "invalid-caller-detections",
            "DOCX session could not produce a transactional block plan",
        ) from error
    if len(block_plans) != len(extraction["blocks"]):
        raise DocxAnonymizationError(
            "invalid-caller-detections",
            "DOCX session redaction plan does not match the extracted block count",
        )
    entity_count = 0
    retained_caller_count = 0
    for block, block_plan in zip(extraction["blocks"], block_plans):
        entity_count += block_plan["entity_count"]
        retained_caller_count += block_plan["caller_entity_count"]
        replacements = block_plan["replacements"]
        if replacements:
            rewrites.append(
                {
                    "location": block["location"],
                    "expectedText": block["text"],
                    "replacements": replacements,
                }
            )
    rewritten = rewrite_docx_text(document, rewrites)
    native_plan.commit()
    return {
        "document": rewritten["document"],
        "summary": {
            "contractVersion": 1,
            "sessionId": session_id,
            "blockCount": len(extraction["blocks"]),
            "rewrittenBlockCount": rewritten["rewrittenBlockCount"],
            "appliedReplacementCount": rewritten["appliedReplacementCount"],
            "entityCount": entity_count,
            "callerDetectionCount": caller_count,
            "retainedCallerDetectionCount": retained_caller_count,
            "coverage": coverage,
        },
    }


def restore_docx_text(
    document: bytes | bytearray | memoryview,
    session: Any,
    expected_session_id: str,
    *,
    observed_at_epoch_seconds: int | None = None,
) -> dict[str, Any]:
    """Restore placeholders owned by the expected session inside a DOCX."""

    session_id = session.session_id()
    if session_id != expected_session_id:
        raise DocxRestorationError(
            "session-mismatch",
            "DOCX restoration session does not match the expected session id",
        )
    if session.restore_text("", observed_at_epoch_seconds) != "":
        raise DocxRestorationError(
            "invalid-session",
            "DOCX restoration session must preserve text without placeholders",
        )
    try:
        plan = json.loads(_plan_docx_restoration_json(bytes(document), session_id))
    except ValueError as error:
        message = str(error)
        code, separator, detail = message.partition(": ")
        if separator and code in {
            "invalid-placeholder",
            "restoration-limit-exceeded",
            "unsupported-document",
        }:
            raise DocxRestorationError(code, detail) from error
        raise
    rewrites: list[dict[str, Any]] = []
    restored_count = 0

    for block in plan["blocks"]:
        replacements: list[dict[str, Any]] = []
        for candidate_plan in block["candidates"]:
            candidate = candidate_plan["candidate"]
            restored = session.restore_text(candidate, observed_at_epoch_seconds)
            if restored == candidate:
                raise DocxRestorationError(
                    "invalid-placeholder",
                    "DOCX text contains an unknown placeholder for the expected session",
                )
            replacements.append(
                {
                    "start": candidate_plan["start"],
                    "end": candidate_plan["end"],
                    "replacement": restored,
                }
            )
        if replacements:
            restored_count += len(replacements)
            rewrites.append(
                {
                    "location": block["location"],
                    "expectedText": block["expectedText"],
                    "replacements": replacements,
                }
            )
    if session.restore_text("", observed_at_epoch_seconds) != "":
        raise DocxRestorationError(
            "invalid-session",
            "DOCX restoration session must preserve text without placeholders",
        )
    restored = rewrite_docx_text(document, rewrites)
    return {
        "document": restored["document"],
        "sessionId": session_id,
        "restoredBlockCount": restored["rewrittenBlockCount"],
        "restoredPlaceholderCount": restored_count,
        "coverage": _workflow_coverage(plan["extraction"]["coverage"]),
    }
