"""Fail-closed PDF inspection and destructive raster anonymization."""

from __future__ import annotations

import json
from hashlib import sha256
from collections.abc import Mapping, Sequence
from typing import Any

from ._native import convert_external_detection_batch as _convert_external_batch
from ._native import inspect_pdf_json as _inspect_pdf_json
from ._native import (
    rewrite_pdf_raster_from_detections_json as _rewrite_pdf_raster_from_detections_json,
)

PDF_INSPECTION_CONTRACT_VERSION = 1
PDF_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024
PDF_STREAM_DECOMPRESSED_MAX_BYTES = 32 * 1024 * 1024
PDF_LOADED_PAYLOAD_MAX_BYTES = 128 * 1024 * 1024
PDF_MAX_OBJECTS = 200_000
PDF_MAX_OBJECT_NODES = 1_000_000
PDF_MAX_OBJECT_DEPTH = 128
PDF_MAX_PAGES = 10_000
PDF_MAX_GLYPHS = 5_000_000
PDF_MAX_PAGE_TEXT_UTF8_BYTES = 16 * 1024 * 1024
PDF_MAX_OBSERVED_TEXT_UTF8_BYTES = 64 * 1024 * 1024
PDF_OBSERVATIONS_JSON_MAX_BYTES = 64 * 1024 * 1024
PDF_PAGE_DIMENSION_TOLERANCE_POINTS = 0.25
PDF_RASTER_CONTRACT_VERSION = 1
PDF_RASTER_MAX_PAGE_BYTES = 128 * 1024 * 1024
PDF_RASTER_MAX_TOTAL_BYTES = 512 * 1024 * 1024
PDF_RASTER_MAX_OUTPUT_BYTES = 512 * 1024 * 1024
PDF_RASTER_REQUEST_JSON_MAX_BYTES = 64 * 1024 * 1024


class PdfInspectionError(ValueError):
    """Stable, coded PDF inspection failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class PdfRasterError(ValueError):
    """Stable, coded destructive PDF rasterization failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def inspect_pdf(
    document: bytes | bytearray | memoryview,
    page_observations: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Inventory PDF risks and renderer coverage without claiming redaction."""

    observations_json = (
        None
        if page_observations is None
        else json.dumps(
            list(page_observations), separators=(",", ":"), ensure_ascii=False
        )
    )
    try:
        return json.loads(_inspect_pdf_json(bytes(document), observations_json))
    except ValueError as error:
        message = str(error)
        prefix, separator, _ = message.partition(":")
        code = prefix if separator else "invalid-document"
        raise PdfInspectionError(code, message) from error


def _raster_error(error: ValueError, fallback: str) -> PdfRasterError:
    message = str(error)
    prefix, separator, _ = message.partition(":")
    return PdfRasterError(prefix if separator else fallback, message)


def _utf16_offsets(text: str) -> list[int]:
    offsets = [0]
    offset = 0
    for character in text:
        offset += 2 if ord(character) > 0xFFFF else 1
        offsets.append(offset)
    return offsets


def _entity_utf16_range(entity: Any, offsets: Sequence[int]) -> dict[str, int]:
    start = entity.start
    end = entity.end
    if (
        not isinstance(start, int)
        or isinstance(start, bool)
        or not isinstance(end, int)
        or isinstance(end, bool)
        or start < 0
        or end < start
        or end >= len(offsets)
    ):
        raise ValueError("detector returned an invalid character range")
    return {"start": offsets[start], "end": offsets[end]}


def rewrite_pdf_raster_from_detections(
    document: bytes | bytearray | memoryview,
    request: Mapping[str, Any],
    page_pixels: Sequence[bytes | bytearray | memoryview],
) -> tuple[bytes, dict[str, Any]]:
    """Rewrite trusted selected detections; this function does not detect PII."""

    try:
        if len(document) > PDF_DOCUMENT_MAX_BYTES:
            raise PdfRasterError(
                "limit-exceeded",
                "limit-exceeded: PDF source exceeds its byte limit",
            )
        request_json = json.dumps(
            dict(request), separators=(",", ":"), ensure_ascii=False
        )
        if len(request_json.encode("utf-8")) > PDF_RASTER_REQUEST_JSON_MAX_BYTES:
            raise PdfRasterError(
                "limit-exceeded",
                "limit-exceeded: PDF raster request JSON exceeds its byte limit",
            )
        request_pages = request.get("pages")
        if not isinstance(request_pages, Sequence) or len(request_pages) != len(
            page_pixels
        ):
            raise PdfRasterError(
                "invalid-contract",
                "invalid-contract: PDF raster pages and pixel buffers must match",
            )
        total_bytes = 0
        for page, pixels in zip(request_pages, page_pixels, strict=True):
            if not isinstance(page, Mapping):
                raise PdfRasterError(
                    "invalid-contract",
                    "invalid-contract: PDF raster page contract is invalid",
                )
            width = page.get("widthPixels")
            height = page.get("heightPixels")
            if (
                not isinstance(width, int)
                or isinstance(width, bool)
                or not isinstance(height, int)
                or isinstance(height, bool)
                or width <= 0
                or height <= 0
            ):
                raise PdfRasterError(
                    "invalid-contract",
                    "invalid-contract: PDF raster pixel dimensions are invalid",
                )
            expected = width * height * 3
            if expected > PDF_RASTER_MAX_PAGE_BYTES or len(pixels) != expected:
                raise PdfRasterError(
                    "limit-exceeded",
                    "limit-exceeded: PDF raster page pixels exceed limits or have an invalid RGB8 length",
                )
            total_bytes += expected
        if total_bytes > PDF_RASTER_MAX_TOTAL_BYTES:
            raise PdfRasterError(
                "limit-exceeded",
                "limit-exceeded: PDF raster pixels exceed their aggregate limit",
            )
        output, certificate_json = _rewrite_pdf_raster_from_detections_json(
            bytes(document), request_json, [bytes(page) for page in page_pixels]
        )
        return output, json.loads(certificate_json)
    except PdfRasterError:
        raise
    except ValueError as error:
        raise _raster_error(error, "verification-failed") from error


def anonymize_pdf_raster(
    document: bytes | bytearray | memoryview,
    anonymizer: Any,
    provider: Mapping[str, str],
    pages: Sequence[Mapping[str, Any]],
    *,
    fill_rgb: Sequence[int] = (0, 0, 0),
) -> tuple[bytes, dict[str, Any]]:
    """Run stella detection, merge optional external detections, and rewrite pixels."""

    if len(document) > PDF_DOCUMENT_MAX_BYTES:
        raise PdfRasterError(
            "limit-exceeded",
            "limit-exceeded: PDF source exceeds its byte limit",
        )
    source = bytes(document)
    request_pages: list[dict[str, Any]] = []
    page_pixels: list[bytes] = []
    validated_pages: list[
        tuple[
            Mapping[str, Any],
            Mapping[str, Any],
            str,
            bytes | bytearray | memoryview,
            int,
            int,
        ]
    ] = []
    total_pixel_bytes = 0
    total_observed_text_bytes = 0
    if len(pages) > PDF_MAX_PAGES:
        raise PdfRasterError(
            "limit-exceeded",
            "limit-exceeded: PDF raster page count exceeds its limit",
        )
    for page in pages:
        observation = page.get("observation")
        pixels = page.get("pixels")
        if not isinstance(observation, Mapping) or not isinstance(
            pixels, (bytes, bytearray, memoryview)
        ):
            raise PdfRasterError(
                "invalid-contract",
                "invalid-contract: PDF raster observed page is invalid",
            )
        text = observation.get("text")
        if not isinstance(text, str):
            raise PdfRasterError(
                "invalid-contract",
                "invalid-contract: PDF raster observed text is invalid",
            )
        observed_text_bytes = len(text.encode("utf-8"))
        if observed_text_bytes > PDF_MAX_PAGE_TEXT_UTF8_BYTES:
            raise PdfRasterError(
                "limit-exceeded",
                "limit-exceeded: PDF raster page text exceeds its byte limit",
            )
        total_observed_text_bytes += observed_text_bytes
        if total_observed_text_bytes > PDF_MAX_OBSERVED_TEXT_UTF8_BYTES:
            raise PdfRasterError(
                "limit-exceeded",
                "limit-exceeded: PDF raster observed text exceeds its aggregate byte limit",
            )
        width = page.get("widthPixels")
        height = page.get("heightPixels")
        if (
            not isinstance(width, int)
            or isinstance(width, bool)
            or not isinstance(height, int)
            or isinstance(height, bool)
            or width <= 0
            or height <= 0
        ):
            raise PdfRasterError(
                "invalid-contract",
                "invalid-contract: PDF raster pixel dimensions are invalid",
            )
        expected = width * height * 3
        if expected > PDF_RASTER_MAX_PAGE_BYTES or len(pixels) != expected:
            raise PdfRasterError(
                "limit-exceeded",
                "limit-exceeded: PDF raster page pixels exceed limits or have an invalid RGB8 length",
            )
        total_pixel_bytes += expected
        if total_pixel_bytes > PDF_RASTER_MAX_TOTAL_BYTES:
            raise PdfRasterError(
                "limit-exceeded",
                "limit-exceeded: PDF raster pixels exceed their aggregate limit",
            )
        validated_pages.append((page, observation, text, pixels, width, height))
    for page, observation, text, pixels, width, height in validated_pages:
        try:
            external_batch = page.get("externalDetectionBatch")
            if external_batch is None:
                result = anonymizer.redact_text(text)
            else:
                batch_json = (
                    external_batch
                    if isinstance(external_batch, str)
                    else json.dumps(
                        external_batch, separators=(",", ":"), ensure_ascii=False
                    )
                )
                converted = json.loads(
                    _convert_external_batch(text.encode("utf-8"), batch_json)
                )
                result = anonymizer.redact_text_with_caller_detections(
                    text, converted["detections"]
                )
            utf16_offsets = _utf16_offsets(text)
            detections = [
                _entity_utf16_range(entity, utf16_offsets)
                for entity in result.resolved_entities
            ]
        except Exception as error:
            raise PdfRasterError(
                "detection-failed",
                "detection-failed: PDF raster detection failed",
            ) from error
        opaque_pixels = bytes(pixels)
        request_pages.append(
            {
                "observation": dict(observation),
                "widthPixels": width,
                "heightPixels": height,
                "pixelSha256": sha256(opaque_pixels).hexdigest(),
                "detections": detections,
            }
        )
        page_pixels.append(opaque_pixels)
    request = {
        "contractVersion": PDF_RASTER_CONTRACT_VERSION,
        "sourceSha256": sha256(source).hexdigest(),
        "provider": dict(provider),
        "fillRgb": list(fill_rgb),
        "pages": request_pages,
    }
    return rewrite_pdf_raster_from_detections(source, request, page_pixels)
