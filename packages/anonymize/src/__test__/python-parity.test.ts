/**
 * Python-binding parity.
 *
 * Drives the Rust `crates/anonymize-py` extension in a subprocess and asserts
 * its default-package redaction output is byte-for-byte identical to the
 * in-process native binding output on the committed contract fixtures. Both
 * sides load the same prepared default packages and call into the same Rust
 * core, so any divergence is a binding-layer bug (offset math, JSON shape,
 * version drift), not a detector difference.
 *
 * The comparison target is the NATIVE binding, not the legacy TypeScript
 * pipeline: the native SDK is the 2.0 reference implementation.
 *
 * Building the Python extension (a debug `cargo build`) is expensive, so the
 * suite is gated behind ANONYMIZE_TEST_SLOW_NATIVE_FIXTURE_PARITY=1 and skips
 * cleanly otherwise (matching the slow-fixture-parity gating in
 * native-adapter-parity.test.ts).
 */
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  CALLER_DETECTION_CONTRACT_VERSION,
  EXTERNAL_DETECTION_BATCH_MAX_BYTES,
  EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
  EXTERNAL_DETECTION_MAX_DETECTIONS,
  EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
  EXTERNAL_DETECTION_MAX_METADATA_BYTES,
  EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES,
  convert_external_detection_batch,
  getDefaultNativePipeline,
  loadNativeAnonymizeBinding,
  redact_default_text_json,
  SUPPORTED_LANGUAGES,
} from "../native-node";
import {
  CAPABILITY_PARITY_PROFILES,
  CAPABILITY_SURFACES,
  type CapabilitySurfaceId,
} from "../capabilities";

setDefaultTimeout(600_000);

const RUN_PYTHON_PARITY =
  process.env["ANONYMIZE_TEST_SLOW_NATIVE_FIXTURE_PARITY"] === "1";
const pythonParityTest = RUN_PYTHON_PARITY ? test : test.skip;

const ROOT_DIR = join(import.meta.dir, "..", "..", "..", "..");
const TARGET_DIR = join(ROOT_DIR, "target", "debug");
const PACKAGE_DIR = join(ROOT_DIR, "packages", "anonymize");
const PYTHON_SOURCE_DIR = join(ROOT_DIR, "crates", "anonymize-py", "python");
const CONTRACT_FIXTURES_DIR = join(
  PACKAGE_DIR,
  "src",
  "__test__",
  "fixtures",
  "contracts",
);
const DOCX_RUNTIME_PARITY_FIXTURE = JSON.parse(
  readFileSync(join(ROOT_DIR, "fixtures", "docx-runtime-parity.json"), "utf8"),
) as {
  successCases: readonly {
    id: string;
    expectedText: string;
    [key: string]: unknown;
  }[];
  errorCases: readonly {
    id: string;
    expectedCode: string;
    [key: string]: unknown;
  }[];
}; // SAFETY: This committed test fixture is owned and reviewed with the parity test schema.
const EXTERNAL_DETECTION_FIXTURE = JSON.parse(
  readFileSync(
    join(
      ROOT_DIR,
      "crates",
      "anonymize-adapter-contract",
      "tests",
      "fixtures",
      "external-detection-batch-v1.json",
    ),
    "utf8",
  ),
) as import("../native").ExternalDetectionBatch; // SAFETY: Rust validates this committed public contract fixture before use.
const CONTRACT_FIXTURE_LANGUAGES = ["cs", "de", "en"] as const;

type FixtureLanguage = (typeof CONTRACT_FIXTURE_LANGUAGES)[number];

type ParityCase = {
  language: FixtureLanguage;
  name: string;
  text: string;
};

type PythonParityOutput = {
  surface_ids: CapabilitySurfaceId[];
  factory_fast_path_avoids_fallback: boolean;
  results: unknown[];
  available_languages: string[];
  supported_languages: string[];
  version: string;
  module_version: string;
  pdf_constants: {
    loaded_payload_max_bytes: number;
    max_observed_text_utf8_bytes: number;
    observations_json_max_bytes: number;
    page_dimension_tolerance_points: number;
    stream_decompressed_max_bytes: number;
  };
  pdf_inspection: unknown;
  pdf_risky_inspection: unknown;
  pdf_observed_inspection: unknown;
  pdf_raster: { document_base64: string; certificate: unknown };
  pdf_raster_detected: { document_base64: string; certificate: unknown };
  pdf_raster_astral: { document_base64: string; certificate: unknown };
  pdf_detection_error: { code: string; message: string };
  pdf_observation_limit_errors: readonly { code: string; calls: number }[];
  pdf_invalid_error: { code: string; message: string };
  caller_result: {
    redacted_text: string;
    start: number;
    end: number;
    source: string;
    diagnostic_start: number;
    diagnostic_end: number;
    kept_text: string;
    keep_map_count: number;
    keep_operator: string;
    masked_text: string;
    mask_map_count: number;
    mask_operator: string;
  };
  unicode_json_serialization: {
    bounded_caller_request_rejected_before_later: boolean;
    bounded_session_inputs_rejected_before_later: boolean;
    canonical_score_requests: string[];
    caller_request_json: string;
    session_inputs_json: string;
  };
  external_detection_results: {
    start: number;
    end: number;
    label: string;
    score: number;
    provider_id: string;
    detection_id: string;
  }[][];
  external_detection_error_messages: string[];
  external_detection_limits: {
    batch_max_bytes: number;
    document_max_bytes: number;
    max_detections: number;
    max_label_mappings: number;
    max_metadata_bytes: number;
    provider_id_max_bytes: number;
  };
  session_result: {
    session_id: string;
    mapping_count: number;
    restored_mapping_count: number;
    first_placeholder: string;
    second_placeholder: string;
    restored_placeholder: string;
    restored_text: string;
    deanonymised_text: string;
    deanonymised_mapping_text: string;
    deanonymise_string_map_rejected: boolean;
    deanonymise_invalid_entry_rejected: boolean;
    object_start: number;
    object_end: number;
    json_start: number;
    json_end: number;
  };
  session_plan_result: {
    second_commit_error: string;
  };
  lifecycle_result: {
    active_status: string;
    expired_status: string;
    schema_version: number;
    restored_expiry: number | null;
    deleted_mapping_count: number;
    deleted_status: string;
  };
  archive_result: {
    archive_base64: string;
    restored_mapping_count: number;
    restored_placeholder: string;
    wrong_key_rejected: boolean;
    wrong_session_id_rejected: boolean;
    invalid_key_rejected: boolean;
    oversized_archive_rejected: boolean;
    lifecycle_restored_status: string;
    missing_observed_at_rejected: boolean;
    expired_restore_rejected: boolean;
  };
  docx_result: {
    extracted_text: string;
    rewritten_text: string;
    anonymized_text: string;
    restored_text: string;
    rewritten_block_count: number;
    restored_placeholder_count: number;
    caller_anonymized_text: string;
    retained_caller_detection_count: number;
    external_relationship_is_unsupported: boolean;
    hyperlink_requires_partial_opt_in: boolean;
    revision_requires_partial_opt_in: boolean;
    invalid_rewrite_error: string | null;
    invalid_plan_error: string | null;
    unserializable_plan_error: string | null;
    oversized_plan_error: string | null;
    ignored_extra_field: boolean;
  };
  docx_vector_results: {
    success: readonly { id: string; text: string }[];
    errors: readonly { id: string; code: string }[];
  };
};

const PYTHON_PARITY_SCRIPT = `
import base64
import io
import json
import os
import pathlib
import sys
import zipfile

module_root = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"]).parent.parent
payload = json.loads(pathlib.Path(os.environ["STELLA_ANONYMIZE_PAYLOAD"]).read_text())
sys.path.insert(0, str(module_root))

import stella_anonymize as anonymize

default_pipeline_input = anonymize._default_pipeline_input


def reject_fallback_dictionaries():
    raise AssertionError("bundled language factory loaded fallback dictionaries")


anonymize._default_pipeline_input = reject_fallback_dictionaries
try:
    anonymize.create_pipeline(language="en", warmup="none")
    factory_fast_path_avoids_fallback = True
finally:
    anonymize._default_pipeline_input = default_pipeline_input

pdf_inspection = anonymize.inspect_pdf(base64.b64decode(payload["pdf_base64"]))
pdf_risky_inspection = anonymize.inspect_pdf(
    base64.b64decode(payload["pdf_risky_base64"])
)
pdf_observation = [{
    "pageIndex": 0,
    "widthPoints": 612.0,
    "heightPoints": 792.0,
    "text": "Public fixture",
    "glyphs": [{
        "start": 0, "end": 14,
        "bounds": {"left": 72.0, "bottom": 700.0, "right": 108.0, "top": 712.0},
        "source": "embedded-text",
    }],
    "rendered": True,
    "textLayer": "complete",
    "ocr": "complete",
    "imageCount": 0,
}]
pdf_observed_inspection = anonymize.inspect_pdf(
    base64.b64decode(payload["pdf_base64"]), pdf_observation
)
pdf_source = base64.b64decode(payload["pdf_base64"])
pdf_pixels = bytes([255]) * (17 * 22 * 3)
pdf_raster_request = {
    "contractVersion": 1,
    "sourceSha256": __import__("hashlib").sha256(pdf_source).hexdigest(),
    "provider": {
        "providerId": "synthetic-parity-provider",
        "rendererName": "synthetic-renderer",
        "rendererVersion": "1.0.0",
        "ocrName": "synthetic-ocr",
        "ocrVersion": "1.0.0",
        "ocrLanguage": "eng",
    },
    "fillRgb": [0, 0, 0],
    "pages": [{
        "observation": pdf_observation[0],
        "widthPixels": 17,
        "heightPixels": 22,
        "pixelSha256": __import__("hashlib").sha256(pdf_pixels).hexdigest(),
        "detections": [{"start": 0, "end": 14}],
    }],
}
pdf_raster_document, pdf_raster_certificate = anonymize.rewrite_pdf_raster_from_detections(
    pdf_source, pdf_raster_request, [pdf_pixels]
)
pdf_raster = {
    "document_base64": base64.b64encode(pdf_raster_document).decode("ascii"),
    "certificate": pdf_raster_certificate,
}
try:
    anonymize.inspect_pdf(b"\\x00")
    raise AssertionError("invalid PDF bytes were accepted")
except anonymize.PdfInspectionError as error:
    pdf_invalid_error = {"code": error.code, "message": str(error)}

prepared_anonymizer = getattr(anonymize, "PreparedAnonymizer", None)
prepared_session = getattr(anonymize, "PreparedRedactionSession", None)
surface_probes = {
    "package.prepare": hasattr(anonymize, "prepare_search_package"),
    "package.load": hasattr(anonymize, "load_prepared_package"),
    "package.load-file": hasattr(anonymize, "load_prepared_package_file"),
    "text.normalize": hasattr(anonymize, "normalize_for_search"),
    "text.redact": hasattr(anonymize, "redact_text"),
    "text.redact-stream": hasattr(anonymize, "redact_text_stream_json"),
    "text.diagnostics": hasattr(anonymize, "diagnostics_json"),
    "text.summary-diagnostics": hasattr(anonymize, "summary_diagnostics_json"),
    "text.caller-detections": hasattr(
        prepared_anonymizer, "redact_text_with_caller_detections"
    ),
    "text.external-detection-batch": hasattr(
        anonymize, "convert_external_detection_batch"
    ),
    "text.operators": hasattr(prepared_anonymizer, "redact_text"),
    "package.default": hasattr(anonymize, "create_pipeline"),
    "session.cross-document": hasattr(
        prepared_anonymizer, "create_redaction_session"
    ),
    "session.lifecycle": hasattr(
        prepared_anonymizer, "create_redaction_session_with_lifecycle"
    ),
    "session.plaintext-transfer": hasattr(
        prepared_session, "to_plaintext_json"
    ),
    "session.encrypted-archive": hasattr(
        prepared_session, "to_encrypted_archive"
    ),
    "document.docx.extract": hasattr(anonymize, "extract_docx_text"),
    "document.docx.rewrite": hasattr(anonymize, "rewrite_docx_text"),
    "document.docx.anonymize": hasattr(anonymize, "anonymize_docx"),
    "document.docx.restore": hasattr(anonymize, "restore_docx_text"),
    "document.pdf.inspect": hasattr(anonymize, "inspect_pdf"),
    "document.pdf.anonymize-raster": hasattr(anonymize, "anonymize_pdf_raster"),
    "document.pdf.rewrite-raster": hasattr(
        anonymize, "rewrite_pdf_raster_from_detections"
    ),
}

caller_result = json.loads(
    anonymize.create_pipeline(language="en").redact_text_with_caller_detections_json(
        "😀Alice signed.",
        [{"start": 1, "end": 6, "label": "person", "score": 0.9,
          "provider_id": "parity-provider", "detection_id": "person-1"}],
    )
)
unicode_full_text = "😀Žluťoučký"
unicode_detection = {
    "start": 0,
    "end": 1,
    "label": "osoba-😀",
    "score": 0.9,
    "provider_id": "poskytovatel-Ž",
    "detection_id": "detekce-č",
}
unicode_caller_request_json = anonymize._caller_detection_request_json(
    [unicode_detection], unicode_full_text
)
canonical_score_requests = [
    anonymize._caller_detection_request_json(
        [{**unicode_detection, "score": score}], unicode_full_text
    )
    for score in [1.0, 1e-6, 1e-7, -0.0]
]

class UnreadCallerDetection(dict):
    def __getitem__(self, _key):
        raise AssertionError("later caller detection was read")

try:
    anonymize._caller_detection_request_json(
        [
            {**unicode_detection, "label": "x" * anonymize.CALLER_DETECTION_REQUEST_JSON_MAX_BYTES},
            UnreadCallerDetection(),
        ],
        "x",
    )
    raise AssertionError("oversized caller request was accepted")
except ValueError:
    bounded_caller_request_rejected_before_later = True

class CapturingSession:
    def plan_docx_text_batch(
        self, inputs_json, _operators_json, _observed_at_epoch_seconds
    ):
        self.inputs_json = inputs_json
        return None

unicode_session_capture = CapturingSession()
anonymize.PreparedRedactionSession(unicode_session_capture)._plan_docx_text_batch(
    [{"full_text": unicode_full_text, "detections": [unicode_detection]}],
    None,
    None,
)

class UnreadSessionInput(dict):
    def __getitem__(self, _key):
        raise AssertionError("later session input was read")

original_session_json_maximum = anonymize.SESSION_CALLER_INPUTS_JSON_MAX_BYTES
anonymize.SESSION_CALLER_INPUTS_JSON_MAX_BYTES = 256
try:
    anonymize.PreparedRedactionSession(CapturingSession())._plan_docx_text_batch(
        [
            {
                "full_text": "x",
                "detections": [{**unicode_detection, "label": "x" * 256}],
            },
            UnreadSessionInput(),
        ],
        None,
        None,
    )
    raise AssertionError("oversized session inputs were accepted")
except ValueError:
    bounded_session_inputs_rejected_before_later = True
finally:
    anonymize.SESSION_CALLER_INPUTS_JSON_MAX_BYTES = original_session_json_maximum
external_detection_results = []
for offset_unit, start, end in [
    ("utf8-byte", 4, 9),
    ("utf16-code-unit", 2, 7),
    ("unicode-code-point", 1, 6),
]:
    batch = json.loads(json.dumps(payload["external_detection_batch"]))
    batch["offsetUnit"] = offset_unit
    batch["detections"][0]["start"] = start
    batch["detections"][0]["end"] = end
    external_detection_results.append(
        anonymize.convert_external_detection_batch(
            "😀Alice signed.".encode("utf-8"), batch
        )
    )

stale_external_batch = json.loads(json.dumps(payload["external_detection_batch"]))
stale_external_batch["document"]["sha256"] = "0" * 64
unknown_external_batch = json.loads(json.dumps(payload["external_detection_batch"]))
unknown_external_batch["legacyOffsetGuessing"] = True
external_detection_error_messages = []
for invalid_batch in [stale_external_batch, unknown_external_batch]:
    try:
        anonymize.convert_external_detection_batch(
            "😀Alice signed.".encode("utf-8"), invalid_batch
        )
    except ValueError as error:
        external_detection_error_messages.append(str(error))
external_detection_limits = {
    "batch_max_bytes": anonymize.EXTERNAL_DETECTION_BATCH_MAX_BYTES,
    "document_max_bytes": anonymize.EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
    "max_detections": anonymize.EXTERNAL_DETECTION_MAX_DETECTIONS,
    "max_label_mappings": anonymize.EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
    "max_metadata_bytes": anonymize.EXTERNAL_DETECTION_MAX_METADATA_BYTES,
    "provider_id_max_bytes": anonymize.EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES,
}
caller_diagnostics = json.loads(
    anonymize.create_pipeline(language="en").redact_text_with_caller_detections_diagnostics_json(
        "😀Alice signed.",
        [{"start": 1, "end": 6, "label": "person", "score": 0.9,
          "provider_id": "parity-provider", "detection_id": "person-1"}],
    )
)
caller_diagnostic_entity = next(
    event for event in caller_diagnostics["diagnostics"]["events"]
    if event.get("stage") == "entity.caller.input" and event.get("kind") == "entity"
)
caller_keep_result = json.loads(
    anonymize.create_pipeline(language="en").redact_text_with_caller_detections_json(
        "😀Alice signed.",
        [{"start": 1, "end": 6, "label": "person", "score": 0.9,
          "provider_id": "parity-provider", "detection_id": "person-1"}],
        {"person": "keep"},
    )
)
caller_mask_result = json.loads(
    anonymize.create_pipeline(language="en").redact_text_with_caller_detections_json(
        "A👨‍👩‍👧‍👦éZ signed.",
        [{"start": 0, "end": 11, "label": "person", "score": 0.9,
          "provider_id": "parity-provider", "detection_id": "person-mask-1"}],
        {"person": {"type": "mask", "masking_character": "●",
                    "characters_to_mask": 2, "direction": "end"}},
    )
)
prepared = anonymize.create_pipeline(language="en")
pdf_external_batch = {
    "version": 1,
    "document": {"sha256": __import__("hashlib").sha256(b"Public fixture").hexdigest()},
    "offsetUnit": "unicode-code-point",
    "provider": {"id": "parity-provider", "name": "Parity Provider", "version": "1.0.0"},
    "labelMap": [{"providerLabel": "person", "entityLabel": "person"}],
    "detections": [{"id": "pdf-person-1", "start": 0, "end": 14, "label": "person", "score": 1.0}],
}
pdf_detected_document, pdf_detected_certificate = anonymize.anonymize_pdf_raster(
    pdf_source,
    prepared,
    pdf_raster_request["provider"],
    [{
        "observation": pdf_observation[0],
        "widthPixels": 17,
        "heightPixels": 22,
        "pixels": pdf_pixels,
        "externalDetectionBatch": pdf_external_batch,
    }],
)
pdf_raster_detected = {
    "document_base64": base64.b64encode(pdf_detected_document).decode("ascii"),
    "certificate": pdf_detected_certificate,
}
class AstralPdfDetector:
    def redact_text(self, _text):
        entity = type("Entity", (), {"start": 1, "end": 6})()
        return type("Result", (), {"resolved_entities": [entity]})()

pdf_astral_observation = {
    "pageIndex": 0,
    "widthPoints": 612.0,
    "heightPoints": 792.0,
    "text": "😀Alice",
    "glyphs": [
        {
            "start": 0, "end": 2,
            "bounds": {"left": 20.0, "bottom": 700.0, "right": 40.0, "top": 712.0},
            "source": "embedded-text",
        },
        {
            "start": 2, "end": 7,
            "bounds": {"left": 72.0, "bottom": 700.0, "right": 108.0, "top": 712.0},
            "source": "embedded-text",
        },
    ],
    "rendered": True,
    "textLayer": "complete",
    "ocr": "complete",
    "imageCount": 0,
}
pdf_astral_document, pdf_astral_certificate = anonymize.anonymize_pdf_raster(
    pdf_source,
    AstralPdfDetector(),
    pdf_raster_request["provider"],
    [{
        "observation": pdf_astral_observation,
        "widthPixels": 17,
        "heightPixels": 22,
        "pixels": pdf_pixels,
    }],
)
pdf_raster_astral = {
    "document_base64": base64.b64encode(pdf_astral_document).decode("ascii"),
    "certificate": pdf_astral_certificate,
}
class FailingPdfDetector:
    def redact_text(self, _text):
        raise RuntimeError("sensitive provider detail")

try:
    anonymize.anonymize_pdf_raster(
        pdf_source,
        FailingPdfDetector(),
        pdf_raster_request["provider"],
        [{
            "observation": pdf_observation[0],
            "widthPixels": 17,
            "heightPixels": 22,
            "pixels": pdf_pixels,
        }],
    )
    raise AssertionError("failing PDF detector was accepted")
except anonymize.PdfRasterError as error:
    pdf_detection_error = {"code": error.code, "message": str(error)}
class CountingPdfDetector:
    def __init__(self):
        self.calls = 0

    def redact_text(self, _text):
        self.calls += 1
        raise AssertionError("oversized observed text reached detection")

pdf_observation_limit_errors = []
oversized_page_text = "a" * (anonymize.PDF_MAX_PAGE_TEXT_UTF8_BYTES + 1)
aggregate_page_text = "a" * anonymize.PDF_MAX_PAGE_TEXT_UTF8_BYTES
aggregate_page_count = (
    anonymize.PDF_MAX_OBSERVED_TEXT_UTF8_BYTES
    // anonymize.PDF_MAX_PAGE_TEXT_UTF8_BYTES
)
for texts in [
    [oversized_page_text],
    [aggregate_page_text] * aggregate_page_count + ["a"],
]:
    counting_pdf_detector = CountingPdfDetector()
    observed_pages = []
    for page_index, text in enumerate(texts):
        limited_observation = dict(pdf_observation[0])
        limited_observation["pageIndex"] = page_index
        limited_observation["text"] = text
        observed_pages.append({
            "observation": limited_observation,
            "widthPixels": 17,
            "heightPixels": 22,
            "pixels": pdf_pixels,
        })
    try:
        anonymize.anonymize_pdf_raster(
            pdf_source,
            counting_pdf_detector,
            pdf_raster_request["provider"],
            observed_pages,
        )
        raise AssertionError("oversized PDF observation was accepted")
    except anonymize.PdfRasterError as error:
        pdf_observation_limit_errors.append({
            "code": error.code,
            "calls": counting_pdf_detector.calls,
        })
session = prepared.create_redaction_session("parity_session_1")
session_first = session.redact_text("Jan Novak signed.")
session_second = session.redact_text("Jan Novak signed again.")
session_object_offsets = session.redact_text("😀Jan Novak signed.")
session_json_offsets = json.loads(session.redact_text_json("😀Jan Novak signed."))
restored_session = prepared.restore_redaction_session(session.to_plaintext_json())
session_restored = restored_session.redact_text("Jan Novak signed once more.")
session_restored_text = restored_session.restore_text(
    session_first.redaction.redaction_map[0].placeholder + " signed."
)

def caller_session_plan(session, full_text, detection_id):
    return session._plan_docx_text_batch(
        [{
            "full_text": full_text,
            "detections": [{
                "start": 0, "end": len(full_text), "label": "person", "score": 0.99,
                "provider_id": "parity-provider", "detection_id": detection_id,
            }],
        }],
        None,
        None,
    )

session_plan_session = prepared.create_redaction_session("parity_session_plan_1")
committed_session_plan = caller_session_plan(
    session_plan_session, "Alice", "session-plan-person-1"
)
committed_session_plan.commit()
later_session_plan = caller_session_plan(
    session_plan_session, "Bob", "session-plan-person-2"
)
later_session_plan.commit()
try:
    committed_session_plan.commit()
    raise AssertionError("committed session plan was accepted twice")
except ValueError as error:
    session_plan_second_commit_error = str(error)

def make_docx(text, external_target=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '</Types>',
        )
        archive.writestr(
            "_rels/.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>',
        )
        archive.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'
            + text
            + '</w:t></w:r></w:p></w:body></w:document>',
        )
        if external_target is not None:
            archive.writestr(
                "word/_rels/document.xml.rels",
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="'
                + external_target
                + '"/></Relationships>',
            )
    return output.getvalue()

docx_source = make_docx("Jan Novak signed.")
docx_extraction = anonymize.extract_docx_text(docx_source)
docx_block = docx_extraction["blocks"][0]
docx_rewritten = anonymize.rewrite_docx_text(
    docx_source,
    [{
        "location": docx_block["location"],
        "expected_text": docx_block["text"],
        "replacements": [{"start": 10, "end": 16, "replacement": "approved"}],
    }],
)
docx_session = prepared.create_redaction_session("parity_docx_1")
docx_anonymized = anonymize.anonymize_docx(
    docx_source,
    docx_session,
    "parity_docx_1",
    {"coverage": {"mode": "require-full"}},
)
docx_restored = anonymize.restore_docx_text(
    docx_anonymized["document"], docx_session, "parity_docx_1"
)
docx_caller_source = make_docx("External Name")
docx_caller_block = anonymize.extract_docx_text(docx_caller_source)["blocks"][0]
docx_caller_session = prepared.create_redaction_session("parity_docx_caller_1")
docx_caller_anonymized = anonymize.anonymize_docx(
    docx_caller_source,
    docx_caller_session,
    "parity_docx_caller_1",
    {"coverage": {"mode": "require-full"}},
    caller_detections=[{
        "location": docx_caller_block["location"],
        "expectedText": docx_caller_block["text"],
        "detections": [{
            "start": 0, "end": 13, "label": "person", "score": 0.99,
            "provider_id": "parity-provider", "detection_id": "docx-person-1",
        }],
    }],
)
docx_external = anonymize.extract_docx_text(
    make_docx("Contact us", "mailto:alice@example.test")
)
def rejects_full_coverage(document, session_id):
    session = prepared.create_redaction_session(session_id)
    try:
        anonymize.anonymize_docx(
            document, session, session_id,
            {"coverage": {"mode": "require-full"}},
        )
    except anonymize.DocxAnonymizationError as error:
        return error.code == "incomplete-coverage"
    return False

docx_hyperlink_requires_partial = rejects_full_coverage(
    make_docx('</w:t></w:r><w:hyperlink><w:r><w:t>Alice</w:t></w:r></w:hyperlink><w:r><w:t>'),
    "parity_docx_hyperlink_1",
)
docx_revision_requires_partial = rejects_full_coverage(
    make_docx('</w:t></w:r><w:ins><w:r><w:t>Alice</w:t></w:r></w:ins><w:r><w:t>'),
    "parity_docx_revision_1",
)
try:
    anonymize.rewrite_docx_text(b"not a DOCX archive", [])
except anonymize.DocxExtractionError as error:
    docx_invalid_rewrite_error = error.code
else:
    docx_invalid_rewrite_error = None
try:
    anonymize.rewrite_docx_text(docx_source, [{
        "location": docx_block["location"],
        "expected_text": docx_block["text"],
        "replacements": [{"start": -1, "end": 2, "replacement": "x"}],
    }])
except anonymize.DocxRewriteError as error:
    docx_invalid_plan_error = error.code
else:
    docx_invalid_plan_error = None
try:
    anonymize.rewrite_docx_text(docx_source, [{
        "location": docx_block["location"],
        "expected_text": docx_block["text"],
        "replacements": [{"start": 0, "end": 2, "replacement": b"x"}],
    }])
except anonymize.DocxRewriteError as error:
    docx_unserializable_plan_error = error.code
else:
    docx_unserializable_plan_error = None
try:
    anonymize.rewrite_docx_text(docx_source, [{
        "location": docx_block["location"],
        "expected_text": docx_block["text"],
        "replacements": range(1_000_001),
    }])
except anonymize.DocxRewriteError as error:
    docx_oversized_plan_error = error.code
else:
    docx_oversized_plan_error = None
docx_extra_plan = {
    "location": docx_block["location"],
    "expected_text": docx_block["text"],
    "replacements": [{"start": 0, "end": 3, "replacement": "Ana"}],
}
docx_extra_plan["unexpected"] = docx_extra_plan
docx_extra_result = anonymize.rewrite_docx_text(docx_source, [docx_extra_plan])
docx_ignored_extra_field = (
    anonymize.extract_docx_text(docx_extra_result["document"])["blocks"][0]["text"]
    == "Ana Novak signed."
)
docx_vector_success = []
for vector in payload["docx_vectors"]["successCases"]:
    source = make_docx(vector["text"])
    block = anonymize.extract_docx_text(source)["blocks"][0]
    rewritten = anonymize.rewrite_docx_text(source, [{
        "location": block["location"],
        "expectedText": block["text"],
        "replacements": [{
            "start": vector["start"], "end": vector["end"],
            "replacement": vector["replacement"],
        }],
    }])
    docx_vector_success.append({
        "id": vector["id"],
        "text": anonymize.extract_docx_text(rewritten["document"])["blocks"][0]["text"],
    })
docx_vector_errors = []
for vector in payload["docx_vectors"]["errorCases"]:
    source = make_docx(vector["text"])
    block = anonymize.extract_docx_text(source)["blocks"][0]
    try:
        anonymize.rewrite_docx_text(source, [{
            "location": block["location"],
            "expectedText": vector["expectedText"],
            "replacements": [{
                "start": vector["start"], "end": vector["end"],
                "replacement": vector["replacement"],
            }],
        }])
        code = "did-not-fail"
    except anonymize.DocxRewriteError as error:
        code = error.code
    docx_vector_errors.append({"id": vector["id"], "code": code})
deanonymised_text = anonymize.deanonymise(
    session_first.redaction.redacted_text,
    session_first.redaction.redaction_map,
)
deanonymised_mapping_text = anonymize.deanonymise(
    session_first.redaction.redacted_text,
    {entry.placeholder: entry.original
     for entry in session_first.redaction.redaction_map},
)

def rejects_type_error(callback):
    try:
        callback()
    except TypeError:
        return True
    return False

deanonymise_string_map_rejected = rejects_type_error(
    lambda: anonymize.deanonymise("text", "[PERSON_1]")
)
deanonymise_invalid_entry_rejected = rejects_type_error(
    lambda: anonymize.deanonymise("text", ["ab"])
)
archive_key = bytes([0x42]) * 32
session_archive = session.to_encrypted_archive(archive_key)
encrypted_restored_session = prepared.restore_encrypted_redaction_session(
    session_archive, archive_key, "parity_session_1"
)
encrypted_session_restored = encrypted_restored_session.redact_text(
    "Jan Novak signed from an archive."
)

def rejects_value_error(callback):
    try:
        callback()
    except ValueError:
        return True
    return False

wrong_key_rejected = rejects_value_error(
    lambda: prepared.restore_encrypted_redaction_session(
        session_archive, bytes([0x43]) * 32, "parity_session_1"
    )
)
wrong_session_id_rejected = rejects_value_error(
    lambda: prepared.restore_encrypted_redaction_session(
        session_archive, archive_key, "different_session_1"
    )
)
invalid_key_rejected = rejects_value_error(
    lambda: session.to_encrypted_archive(bytes([0x42]) * 31)
)
oversized_archive_rejected = rejects_value_error(
    lambda: prepared.restore_encrypted_redaction_session(
        bytes(0x01000000 + 58), archive_key, "parity_session_1"
    )
)
lifecycle_session = prepared.create_redaction_session_with_lifecycle(
    "parity_lifecycle_1",
    created_at_epoch_seconds=100,
    expires_at_epoch_seconds=200,
)
lifecycle_session.redact_text_at(
    "Jan Novak signed.", observed_at_epoch_seconds=150
)
lifecycle_active = lifecycle_session.inspect(150)
lifecycle_archive = lifecycle_session.to_encrypted_archive_at(archive_key, 150)
lifecycle_archive_restored = prepared.restore_encrypted_redaction_session(
    lifecycle_archive,
    archive_key,
    "parity_lifecycle_1",
    observed_at_epoch_seconds=150,
)
missing_observed_at_rejected = rejects_value_error(
    lambda: prepared.restore_encrypted_redaction_session(
        lifecycle_archive, archive_key, "parity_lifecycle_1"
    )
)
expired_restore_rejected = rejects_value_error(
    lambda: prepared.restore_encrypted_redaction_session(
        lifecycle_archive,
        archive_key,
        "parity_lifecycle_1",
        observed_at_epoch_seconds=200,
    )
)
lifecycle_state = json.loads(lifecycle_session.to_plaintext_json_at(150))
lifecycle_restored = prepared.restore_redaction_session(
    json.dumps(lifecycle_state, separators=(",", ":"))
)
lifecycle_expired = lifecycle_restored.inspect(200)
lifecycle_deleted = lifecycle_session.delete()
lifecycle_deleted_metadata = lifecycle_session.inspect()

print(
    json.dumps(
        {
            "surface_ids": [
                surface_id
                for surface_id, implemented in surface_probes.items()
                if implemented
            ],
            "factory_fast_path_avoids_fallback": factory_fast_path_avoids_fallback,
            "results": [
                json.loads(
                    anonymize.redact_default_text_json(
                        case["text"], None, language=case["language"]
                    )
                )
                for case in payload["cases"]
            ],
            "available_languages": list(
                anonymize.available_default_native_pipeline_languages()
            ),
            "supported_languages": sorted(
                anonymize._supported_pipeline_languages()
            ),
            "version": anonymize.native_package_version(),
            "module_version": anonymize.__version__,
            "pdf_constants": {
                "loaded_payload_max_bytes": anonymize.PDF_LOADED_PAYLOAD_MAX_BYTES,
                "max_observed_text_utf8_bytes": anonymize.PDF_MAX_OBSERVED_TEXT_UTF8_BYTES,
                "observations_json_max_bytes": anonymize.PDF_OBSERVATIONS_JSON_MAX_BYTES,
                "page_dimension_tolerance_points": anonymize.PDF_PAGE_DIMENSION_TOLERANCE_POINTS,
                "stream_decompressed_max_bytes": anonymize.PDF_STREAM_DECOMPRESSED_MAX_BYTES,
            },
            "pdf_inspection": pdf_inspection,
            "pdf_risky_inspection": pdf_risky_inspection,
            "pdf_observed_inspection": pdf_observed_inspection,
            "pdf_raster": pdf_raster,
            "pdf_raster_detected": pdf_raster_detected,
            "pdf_raster_astral": pdf_raster_astral,
            "pdf_detection_error": pdf_detection_error,
            "pdf_observation_limit_errors": pdf_observation_limit_errors,
            "pdf_invalid_error": pdf_invalid_error,
            "caller_result": {
                "redacted_text": caller_result["redaction"]["redacted_text"],
                "start": caller_result["resolved_entities"][0]["start"],
                "end": caller_result["resolved_entities"][0]["end"],
                "source": caller_result["resolved_entities"][0]["source"],
                "diagnostic_start": caller_diagnostic_entity["start"],
                "diagnostic_end": caller_diagnostic_entity["end"],
                "kept_text": caller_keep_result["redaction"]["redacted_text"],
                "keep_map_count": len(caller_keep_result["redaction"]["redaction_map"]),
                "keep_operator": caller_keep_result["redaction"]["operator_map"][0]["operator"],
                "masked_text": caller_mask_result["redaction"]["redacted_text"],
                "mask_map_count": len(caller_mask_result["redaction"]["redaction_map"]),
                "mask_operator": caller_mask_result["redaction"]["operator_map"][0]["operator"],
            },
            "unicode_json_serialization": {
                "bounded_caller_request_rejected_before_later": bounded_caller_request_rejected_before_later,
                "bounded_session_inputs_rejected_before_later": bounded_session_inputs_rejected_before_later,
                "canonical_score_requests": canonical_score_requests,
                "caller_request_json": unicode_caller_request_json,
                "session_inputs_json": unicode_session_capture.inputs_json,
            },
            "external_detection_results": external_detection_results,
            "external_detection_error_messages": external_detection_error_messages,
            "external_detection_limits": external_detection_limits,
            "session_result": {
                "session_id": restored_session.session_id(),
                "mapping_count": session.mapping_count(),
                "restored_mapping_count": restored_session.mapping_count(),
                "first_placeholder": session_first.redaction.redaction_map[0].placeholder,
                "second_placeholder": session_second.redaction.redaction_map[0].placeholder,
                "restored_placeholder": session_restored.redaction.redaction_map[0].placeholder,
                "restored_text": session_restored_text,
                "deanonymised_text": deanonymised_text,
                "deanonymised_mapping_text": deanonymised_mapping_text,
                "deanonymise_string_map_rejected": deanonymise_string_map_rejected,
                "deanonymise_invalid_entry_rejected": deanonymise_invalid_entry_rejected,
                "object_start": session_object_offsets.resolved_entities[0].start,
                "object_end": session_object_offsets.resolved_entities[0].end,
                "json_start": session_json_offsets["resolved_entities"][0]["start"],
                "json_end": session_json_offsets["resolved_entities"][0]["end"],
            },
            "session_plan_result": {
                "second_commit_error": session_plan_second_commit_error,
            },
            "lifecycle_result": {
                "active_status": lifecycle_active["status"],
                "expired_status": lifecycle_expired["status"],
                "schema_version": lifecycle_state["schema_version"],
                "restored_expiry": lifecycle_expired["expires_at_epoch_seconds"],
                "deleted_mapping_count": lifecycle_deleted["deleted_mapping_count"],
                "deleted_status": lifecycle_deleted_metadata["status"],
            },
            "archive_result": {
                "archive_base64": base64.b64encode(session_archive).decode("ascii"),
                "restored_mapping_count": encrypted_restored_session.mapping_count(),
                "restored_placeholder": encrypted_session_restored.redaction.redaction_map[0].placeholder,
                "wrong_key_rejected": wrong_key_rejected,
                "wrong_session_id_rejected": wrong_session_id_rejected,
                "invalid_key_rejected": invalid_key_rejected,
                "oversized_archive_rejected": oversized_archive_rejected,
                "lifecycle_restored_status": lifecycle_archive_restored.inspect(150)["status"],
                "missing_observed_at_rejected": missing_observed_at_rejected,
                "expired_restore_rejected": expired_restore_rejected,
            },
            "docx_result": {
                "extracted_text": docx_block["text"],
                "rewritten_text": anonymize.extract_docx_text(docx_rewritten["document"])["blocks"][0]["text"],
                "anonymized_text": anonymize.extract_docx_text(docx_anonymized["document"])["blocks"][0]["text"],
                "restored_text": anonymize.extract_docx_text(docx_restored["document"])["blocks"][0]["text"],
                "rewritten_block_count": docx_rewritten["rewrittenBlockCount"],
                "restored_placeholder_count": docx_restored["restoredPlaceholderCount"],
                "caller_anonymized_text": anonymize.extract_docx_text(docx_caller_anonymized["document"])["blocks"][0]["text"],
                "retained_caller_detection_count": docx_caller_anonymized["summary"]["retainedCallerDetectionCount"],
                "external_relationship_is_unsupported": any(
                    item["status"] == "unsupported" and item["path"] == "word/_rels/document.xml.rels"
                    for item in docx_external["coverage"]["parts"]
                ),
                "hyperlink_requires_partial_opt_in": docx_hyperlink_requires_partial,
                "revision_requires_partial_opt_in": docx_revision_requires_partial,
                "invalid_rewrite_error": docx_invalid_rewrite_error,
                "invalid_plan_error": docx_invalid_plan_error,
                "unserializable_plan_error": docx_unserializable_plan_error,
                "oversized_plan_error": docx_oversized_plan_error,
                "ignored_extra_field": docx_ignored_extra_field,
            },
            "docx_vector_results": {
                "success": docx_vector_success,
                "errors": docx_vector_errors,
            },
        }
    )
)
`;

const runCommand = (
  command: string,
  args: string[],
  env: Record<string, string> = {},
): string => {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status === 0) {
    return result.stdout;
  }
  throw new Error(
    [
      `${command} ${args.join(" ")} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  );
};

const nativeLibraryPath = (name: string): string => {
  if (process.platform === "darwin") {
    return join(TARGET_DIR, `lib${name}.dylib`);
  }
  if (process.platform === "linux") {
    return join(TARGET_DIR, `lib${name}.so`);
  }
  return join(TARGET_DIR, `${name}.dll`);
};

const ensureDefaultPackages = (): void => {
  const required = [
    "native-pipeline.stlanonpkg",
    ...CONTRACT_FIXTURE_LANGUAGES.map(
      (language) => `native-pipeline.${language}.stlanonpkg`,
    ),
  ];
  if (required.every((file) => existsSync(join(PACKAGE_DIR, file)))) {
    return;
  }
  runCommand("bun", ["run", "--cwd", PACKAGE_DIR, "build"], {
    STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES:
      CONTRACT_FIXTURE_LANGUAGES.join(","),
  });
};

let pythonModulePath: string | null = null;
let pythonModuleTempDir: string | null = null;

afterAll(() => {
  if (pythonModuleTempDir !== null) {
    try {
      rmSync(pythonModuleTempDir, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup: a leftover temp dir must not fail the suite.
    }
    pythonModuleTempDir = null;
  }
});

const getPythonModule = (): string => {
  if (pythonModulePath !== null) {
    return pythonModulePath;
  }
  ensureDefaultPackages();
  runCommand("cargo", ["build", "-p", "stella-anonymize-py", "--locked"]);

  const tempDir = mkdtempSync(join(tmpdir(), "stella-anonymize-py-parity-"));
  pythonModuleTempDir = tempDir;
  const packageDir = join(tempDir, "stella_anonymize");
  cpSync(join(PYTHON_SOURCE_DIR, "stella_anonymize"), packageDir, {
    recursive: true,
  });
  const modulePath = join(packageDir, "_native.so");
  copyFileSync(nativeLibraryPath("stella_anonymize_core_py"), modulePath);
  pythonModulePath = modulePath;
  return pythonModulePath;
};

const loadContractFixtureCases = (): ParityCase[] =>
  CONTRACT_FIXTURE_LANGUAGES.flatMap((language) =>
    readdirSync(join(CONTRACT_FIXTURES_DIR, language))
      .filter((name) => name.endsWith(".txt"))
      .toSorted()
      .map((name) => ({
        language,
        name,
        text: readFileSync(join(CONTRACT_FIXTURES_DIR, language, name), "utf8"),
      })),
  );

const runPythonParity = (cases: ParityCase[]): PythonParityOutput => {
  const modulePath = getPythonModule();
  const payloadDir = mkdtempSync(
    join(tmpdir(), "stella-anonymize-py-payload-"),
  );
  const payloadPath = join(payloadDir, "payload.json");
  writeFileSync(
    payloadPath,
    JSON.stringify({
      cases: cases.map(({ text, language }) => ({ text, language })),
      docx_vectors: DOCX_RUNTIME_PARITY_FIXTURE,
      external_detection_batch: EXTERNAL_DETECTION_FIXTURE,
      pdf_base64: Buffer.from(
        readFileSync(
          join(
            ROOT_DIR,
            "crates",
            "anonymize-pdf-core",
            "tests",
            "fixtures",
            "minimal-text.pdf",
          ),
        ),
      ).toString("base64"),
      pdf_risky_base64: Buffer.from(
        readFileSync(
          join(
            ROOT_DIR,
            "crates",
            "anonymize-pdf-core",
            "tests",
            "fixtures",
            "risky-structures.pdf",
          ),
        ),
      ).toString("base64"),
    }),
  );
  try {
    return JSON.parse(
      runCommand("python3", ["-c", PYTHON_PARITY_SCRIPT], {
        STELLA_ANONYMIZE_PAYLOAD: payloadPath,
        STELLA_ANONYMIZE_PY_MODULE: modulePath,
      }),
    ) as PythonParityOutput;
  } finally {
    rmSync(payloadDir, { force: true, recursive: true });
  }
};

const nativeDefaultRedaction = (
  binding: ReturnType<typeof loadNativeAnonymizeBinding>,
  { text, language }: ParityCase,
): unknown =>
  JSON.parse(redact_default_text_json(text, undefined, { binding, language }));

const packageJsonVersion = (): string => {
  const { version } = JSON.parse(
    readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof version !== "string") {
    throw new TypeError("package.json version is missing");
  }
  return version;
};

describe("python binding parity", () => {
  pythonParityTest(
    "python exposes every surface in its parity profiles",
    () => {
      const python = runPythonParity([]);
      const expected = CAPABILITY_SURFACES.filter(({ profile }) =>
        CAPABILITY_PARITY_PROFILES[profile].some(
          (runtime) => runtime === "python",
        ),
      ).map(({ id }) => id);

      expect(python.surface_ids).toEqual(expected);
      expect(python.factory_fast_path_avoids_fallback).toBe(true);
      expect(python.supported_languages).toEqual([...SUPPORTED_LANGUAGES]);
    },
  );

  pythonParityTest("PDF inspection behavior and limits match Node", () => {
    const python = runPythonParity([]);
    const fixture = readFileSync(
      join(
        ROOT_DIR,
        "crates",
        "anonymize-pdf-core",
        "tests",
        "fixtures",
        "minimal-text.pdf",
      ),
    );
    const node = JSON.parse(
      loadNativeAnonymizeBinding().inspectPdfJson(fixture),
    ) as unknown;
    expect(python.pdf_inspection).toEqual(node);
    const riskyFixture = readFileSync(
      join(
        ROOT_DIR,
        "crates",
        "anonymize-pdf-core",
        "tests",
        "fixtures",
        "risky-structures.pdf",
      ),
    );
    const riskyNode = JSON.parse(
      loadNativeAnonymizeBinding().inspectPdfJson(riskyFixture),
    ) as { risks?: { formXObjectCount?: unknown } };
    expect(riskyNode.risks?.formXObjectCount).toBeGreaterThanOrEqual(1);
    expect(python.pdf_risky_inspection).toEqual(riskyNode);
    const observations = [
      {
        pageIndex: 0,
        widthPoints: 612,
        heightPoints: 792,
        text: "Public fixture",
        glyphs: [
          {
            start: 0,
            end: 14,
            bounds: { left: 72, bottom: 700, right: 108, top: 712 },
            source: "embedded-text",
          },
        ],
        rendered: true,
        textLayer: "complete",
        ocr: "complete",
        imageCount: 0,
      },
    ];
    const binding = loadNativeAnonymizeBinding();
    expect(python.pdf_observed_inspection).toEqual(
      JSON.parse(binding.inspectPdfJson(fixture, JSON.stringify(observations))),
    );
    let nodeMessage = "";
    try {
      binding.inspectPdfJson(new Uint8Array([0]));
    } catch (error) {
      nodeMessage = error instanceof Error ? error.message : String(error);
    }
    expect(python.pdf_invalid_error).toEqual({
      code: nodeMessage.split(":", 1)[0],
      message: nodeMessage,
    });
    expect(python.pdf_constants).toEqual({
      loaded_payload_max_bytes: 128 * 1024 * 1024,
      max_observed_text_utf8_bytes: 64 * 1024 * 1024,
      observations_json_max_bytes: 64 * 1024 * 1024,
      page_dimension_tolerance_points: 0.25,
      stream_decompressed_max_bytes: 32 * 1024 * 1024,
    });
  });

  pythonParityTest(
    "PDF raster output is byte-exact across Node and Python",
    () => {
      const python = runPythonParity([]);
      const source = readFileSync(
        join(
          ROOT_DIR,
          "crates",
          "anonymize-pdf-core",
          "tests",
          "fixtures",
          "minimal-text.pdf",
        ),
      );
      const pixels = Buffer.alloc(17 * 22 * 3, 255);
      const sha256 = (value: Uint8Array): string =>
        createHash("sha256").update(value).digest("hex");
      const request = {
        contractVersion: 1,
        sourceSha256: sha256(source),
        provider: {
          providerId: "synthetic-parity-provider",
          rendererName: "synthetic-renderer",
          rendererVersion: "1.0.0",
          ocrName: "synthetic-ocr",
          ocrVersion: "1.0.0",
          ocrLanguage: "eng",
        },
        fillRgb: [0, 0, 0],
        pages: [
          {
            observation: {
              pageIndex: 0,
              widthPoints: 612,
              heightPoints: 792,
              text: "Public fixture",
              glyphs: [
                {
                  start: 0,
                  end: 14,
                  bounds: { left: 72, bottom: 700, right: 108, top: 712 },
                  source: "embedded-text",
                },
              ],
              rendered: true,
              textLayer: "complete",
              ocr: "complete",
              imageCount: 0,
            },
            widthPixels: 17,
            heightPixels: 22,
            pixelSha256: sha256(pixels),
            detections: [{ start: 0, end: 14 }],
          },
        ],
      };
      const rewrite =
        loadNativeAnonymizeBinding().rewritePdfRasterFromDetectionsJson;
      const node = rewrite(source, JSON.stringify(request), [pixels]);
      expect(python.pdf_raster).toEqual({
        document_base64: Buffer.from(node.document).toString("base64"),
        certificate: JSON.parse(node.certificateJson),
      });
      expect(python.pdf_raster_detected).toEqual(python.pdf_raster);
      const astralObservation = {
        pageIndex: 0,
        widthPoints: 612,
        heightPoints: 792,
        text: "😀Alice",
        glyphs: [
          {
            start: 0,
            end: 2,
            bounds: { left: 20, bottom: 700, right: 40, top: 712 },
            source: "embedded-text",
          },
          {
            start: 2,
            end: 7,
            bounds: { left: 72, bottom: 700, right: 108, top: 712 },
            source: "embedded-text",
          },
        ],
        rendered: true,
        textLayer: "complete",
        ocr: "complete",
        imageCount: 0,
      };
      const astralNode = rewrite(
        source,
        JSON.stringify({
          ...request,
          pages: [
            {
              observation: astralObservation,
              widthPixels: 17,
              heightPixels: 22,
              pixelSha256: sha256(pixels),
              detections: [{ start: 2, end: 7 }],
            },
          ],
        }),
        [pixels],
      );
      expect(python.pdf_raster_astral).toEqual({
        document_base64: Buffer.from(astralNode.document).toString("base64"),
        certificate: JSON.parse(astralNode.certificateJson),
      });
      expect(python.pdf_detection_error).toEqual({
        code: "detection-failed",
        message: "detection-failed: PDF raster detection failed",
      });
      expect(python.pdf_observation_limit_errors).toEqual([
        { code: "limit-exceeded", calls: 0 },
        { code: "limit-exceeded", calls: 0 },
      ]);
    },
  );

  pythonParityTest("python executes the full DOCX workflow", () => {
    const python = runPythonParity([]);
    expect(python.docx_result).toEqual({
      extracted_text: "Jan Novak signed.",
      rewritten_text: "Jan Novak approved.",
      anonymized_text: "[PERSON_parity%5Fdocx%5F1_1] signed.",
      restored_text: "Jan Novak signed.",
      rewritten_block_count: 1,
      restored_placeholder_count: 1,
      caller_anonymized_text: "[PERSON_parity%5Fdocx%5Fcaller%5F1_1]",
      retained_caller_detection_count: 1,
      external_relationship_is_unsupported: true,
      hyperlink_requires_partial_opt_in: true,
      revision_requires_partial_opt_in: true,
      invalid_rewrite_error: "invalid-archive",
      invalid_plan_error: "invalid-replacement",
      unserializable_plan_error: "invalid-replacement",
      oversized_plan_error: "rewrite-limit-exceeded",
      ignored_extra_field: true,
    });
    expect(python.docx_vector_results).toEqual({
      success: DOCX_RUNTIME_PARITY_FIXTURE.successCases.map(
        ({ expectedText, id }) => ({ id, text: expectedText }),
      ),
      errors: DOCX_RUNTIME_PARITY_FIXTURE.errorCases.map(
        ({ expectedCode, id }) => ({ id, code: expectedCode }),
      ),
    });
  });

  pythonParityTest(
    "default-package redaction matches the native binding across contract fixtures",
    () => {
      const cases = loadContractFixtureCases();
      expect(cases.length).toBeGreaterThan(0);

      const binding = loadNativeAnonymizeBinding();
      const nativeResults = cases.map((item) =>
        nativeDefaultRedaction(binding, item),
      );

      const python = runPythonParity(cases);

      expect(python.results).toEqual(nativeResults);
      for (const language of CONTRACT_FIXTURE_LANGUAGES) {
        expect(python.available_languages).toContain(language);
      }
    },
  );

  pythonParityTest(
    "python binding reports the package manifest version",
    () => {
      const python = runPythonParity([]);
      expect(python.version).toBe(packageJsonVersion());
      expect(python.module_version).toBe(packageJsonVersion());
    },
  );

  pythonParityTest("caller detections use Python character offsets", () => {
    const python = runPythonParity([]);
    expect(python.caller_result).toEqual({
      redacted_text: "😀[PERSON_1] signed.",
      start: 1,
      end: 6,
      source: "caller",
      diagnostic_start: 1,
      diagnostic_end: 6,
      kept_text: "😀Alice signed.",
      keep_map_count: 0,
      keep_operator: "keep",
      masked_text: "A👨‍👩‍👧‍👦●● signed.",
      mask_map_count: 0,
      mask_operator: "mask",
    });
  });

  pythonParityTest(
    "caller and session request JSON matches JavaScript UTF-8 serialization",
    () => {
      const python = runPythonParity([]);
      const fullText = "😀Žluťoučký";
      const requestJson = JSON.stringify({
        version: CALLER_DETECTION_CONTRACT_VERSION,
        detections: [
          {
            start: 0,
            end: 1,
            label: "osoba-😀",
            score: 0.9,
            provider_id: "poskytovatel-Ž",
            detection_id: "detekce-č",
          },
        ],
      });

      expect(python.unicode_json_serialization).toEqual({
        bounded_caller_request_rejected_before_later: true,
        bounded_session_inputs_rejected_before_later: true,
        canonical_score_requests: [1, 1e-6, 1e-7, -0].map((score) =>
          JSON.stringify({
            version: CALLER_DETECTION_CONTRACT_VERSION,
            detections: [
              {
                start: 0,
                end: 1,
                label: "osoba-😀",
                score,
                provider_id: "poskytovatel-Ž",
                detection_id: "detekce-č",
              },
            ],
          }),
        ),
        caller_request_json: requestJson,
        session_inputs_json: JSON.stringify([
          { full_text: fullText, request_json: requestJson },
        ]),
      });
    },
  );

  pythonParityTest(
    "external detection batches share validation and host offset semantics",
    () => {
      const binding = loadNativeAnonymizeBinding();
      const document = new TextEncoder().encode("😀Alice signed.");
      const sourceSpans = [
        ["utf8-byte", 4, 9],
        ["utf16-code-unit", 2, 7],
        ["unicode-code-point", 1, 6],
      ] as const;
      const node = sourceSpans.map(([offsetUnit, start, end]) => {
        const batch = {
          ...structuredClone(EXTERNAL_DETECTION_FIXTURE),
          offsetUnit,
          detections: EXTERNAL_DETECTION_FIXTURE.detections.map(
            (detection, index) =>
              index === 0 ? { ...detection, start, end } : detection,
          ),
        };
        return convert_external_detection_batch(document, batch, { binding });
      });
      const python = runPythonParity([]);

      expect(node).toEqual(
        Array.from({ length: 3 }, () => [
          {
            start: 2,
            end: 7,
            label: "person",
            score: 0.99,
            providerId: "example.local",
            detectionId: "person-1",
          },
        ]),
      );
      expect(python.external_detection_results).toEqual(
        Array.from({ length: 3 }, () => [
          {
            start: 1,
            end: 6,
            label: "person",
            score: 0.99,
            provider_id: "example.local",
            detection_id: "person-1",
          },
        ]),
      );
      const stale = structuredClone(EXTERNAL_DETECTION_FIXTURE);
      stale.document.sha256 = "0".repeat(64);
      const unknown = JSON.stringify({
        ...EXTERNAL_DETECTION_FIXTURE,
        legacyOffsetGuessing: true,
      });
      const nodeErrorMessages = [stale, unknown].map((batch): string => {
        try {
          convert_external_detection_batch(document, batch, { binding });
        } catch (error) {
          if (error instanceof Error) {
            return error.message;
          }
          throw new TypeError("expected an Error from the Node binding");
        }
        throw new Error("invalid external detection batch was accepted");
      });
      expect(python.external_detection_error_messages).toEqual(
        nodeErrorMessages,
      );

      expect(python.external_detection_limits).toEqual({
        batch_max_bytes: EXTERNAL_DETECTION_BATCH_MAX_BYTES,
        document_max_bytes: EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
        max_detections: EXTERNAL_DETECTION_MAX_DETECTIONS,
        max_label_mappings: EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
        max_metadata_bytes: EXTERNAL_DETECTION_MAX_METADATA_BYTES,
        provider_id_max_bytes: EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES,
      });
    },
  );

  pythonParityTest("python sessions preserve mappings across transfer", () => {
    const python = runPythonParity([]);
    expect(python.session_result).toEqual({
      session_id: "parity_session_1",
      mapping_count: 1,
      restored_mapping_count: 1,
      first_placeholder: "[PERSON_parity%5Fsession%5F1_1]",
      second_placeholder: "[PERSON_parity%5Fsession%5F1_1]",
      restored_placeholder: "[PERSON_parity%5Fsession%5F1_1]",
      restored_text: "Jan Novak signed.",
      deanonymised_text: "Jan Novak signed.",
      deanonymised_mapping_text: "Jan Novak signed.",
      deanonymise_string_map_rejected: true,
      deanonymise_invalid_entry_rejected: true,
      object_start: 1,
      object_end: 10,
      json_start: 2,
      json_end: 11,
    });
    expect(python.lifecycle_result).toEqual({
      active_status: "active",
      expired_status: "expired",
      schema_version: 2,
      restored_expiry: 200,
      deleted_mapping_count: 1,
      deleted_status: "deleted",
    });
    expect(python.archive_result).toMatchObject({
      restored_mapping_count: 1,
      restored_placeholder: "[PERSON_parity%5Fsession%5F1_1]",
      wrong_key_rejected: true,
      wrong_session_id_rejected: true,
      invalid_key_rejected: true,
      oversized_archive_rejected: true,
      lifecycle_restored_status: "active",
      missing_observed_at_rejected: true,
      expired_restore_rejected: true,
    });

    const binding = loadNativeAnonymizeBinding();
    const native = getDefaultNativePipeline({ binding, language: "en" });
    const restored = native.restoreEncryptedRedactionSession({
      archive: new Uint8Array(
        Buffer.from(python.archive_result.archive_base64, "base64"),
      ),
      key: new Uint8Array(32).fill(0x42),
      expectedSessionId: "parity_session_1",
    });
    expect(
      restored
        .redactText("Jan Novak signed in Node.")
        .redaction.redactionMap.has("[PERSON_parity%5Fsession%5F1_1]"),
    ).toBe(true);

    const nodeSession = native.createRedactionSession(
      "parity_session_plan_node_1",
    );
    const nodePlan = (fullText: string, detectionId: string) =>
      nodeSession.planTextBatchWithCallerDetections({
        inputs: [
          {
            fullText,
            detections: [
              {
                start: 0,
                end: fullText.length,
                label: "person",
                score: 0.99,
                providerId: "parity-provider",
                detectionId,
              },
            ],
          },
        ],
      });
    const committedNodePlan = nodePlan("Alice", "session-plan-person-1");
    committedNodePlan.commit();
    nodePlan("Bob", "session-plan-person-2").commit();

    let nodeSecondCommitError: string | undefined;
    try {
      committedNodePlan.commit();
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      nodeSecondCommitError = error.message;
    }
    if (nodeSecondCommitError === undefined) {
      throw new Error("committed Node session plan was accepted twice");
    }
    expect(nodeSecondCommitError).toContain("already been committed");
    expect(python.session_plan_result.second_commit_error).toBe(
      nodeSecondCommitError,
    );
  });
});
