from __future__ import annotations

from collections.abc import Mapping

import stella_anonymize as anonymize


def redact_with_prepared_package(config_json: str, text: str) -> str:
    package_bytes = anonymize.prepare_search_package(config_json)
    prepared = anonymize.load_prepared_package(package_bytes)
    result = prepared.redact_text(text)
    return result.redaction.redacted_text


def redact_with_config_input(
    config: anonymize.NativeSearchPackageInput,
    text: str,
) -> str:
    return anonymize.redact_text_json(config, text, redact_string="***")


def prepare_package_from_object(config: Mapping[str, object]) -> bytes:
    return anonymize.prepare_search_package(config, compressed=False)


def prepare_package_from_bytes(config_json: bytes) -> bytes:
    return anonymize.prepare_search_package(config_json)


def redact_with_package_file(package_path: str, text: str) -> int:
    prepared = anonymize.load_prepared_package_file(package_path)
    result = prepared.redact_text(text, {"country": "redact"})
    return result.redaction.entity_count


def redact_with_default_package(text: str) -> int:
    prepared = anonymize.get_default_native_pipeline(language="en")
    deferred = anonymize.get_default_native_pipeline(
        language="en",
        warmup="none",
    )
    warmed = anonymize.preload_default_native_pipeline(language="en")
    assert prepared is deferred
    assert prepared is warmed
    result = prepared.redact_text(text, {"country": "redact"})
    return result.redaction.entity_count


def create_semantic_pipeline(text: str) -> tuple[int, int, int]:
    spanish = anonymize.create_pipeline(language="es")
    multilingual = anonymize.create_pipeline(language=["cs", "en"])
    all_languages = anonymize.create_pipeline(language="all")
    return (
        spanish.redact_text(text).redaction.entity_count,
        multilingual.redact_text(text).redaction.entity_count,
        all_languages.redact_text(text).redaction.entity_count,
    )


def redact_default_helper(text: str) -> str:
    return anonymize.redact_default_text_json(
        text,
        {"country": "redact"},
        language="en",
        redact_string="***",
    )


def redact_default_object(text: str) -> int:
    result = anonymize.redact_default_text(
        text,
        {"country": "redact"},
        language="en",
    )
    return result.redaction.entity_count


def default_package_size() -> int:
    return len(anonymize.read_default_native_pipeline_package_file(language="en"))


def default_package_languages() -> tuple[str, ...]:
    return anonymize.available_default_native_pipeline_languages()


def runtime_version() -> str:
    return anonymize.native_package_version()


def redact_with_session(text: str) -> str:
    prepared = anonymize.get_default_native_pipeline(language="en")
    session = prepared.create_redaction_session("typecheck_session_1")
    result = session.redact_text(text)
    session.restore_text(result.redaction.redacted_text)
    restored = prepared.restore_redaction_session(session.to_plaintext_json())
    assert restored.session_id() == session.session_id()
    assert restored.mapping_count() == session.mapping_count()
    archive_key = bytes([0x42]) * 32
    archive: bytes = session.to_encrypted_archive(archive_key)
    restored_archive = prepared.restore_encrypted_redaction_session(
        archive,
        archive_key,
        session.session_id(),
    )
    assert restored_archive.mapping_count() == session.mapping_count()
    return result.redaction.redacted_text


def redact_with_lifecycle_session(text: str) -> str:
    prepared = anonymize.get_default_native_pipeline(language="en")
    session = prepared.create_redaction_session_with_lifecycle(
        "typecheck_lifecycle_1",
        created_at_epoch_seconds=100,
        expires_at_epoch_seconds=200,
    )
    result = session.redact_text_at(text, observed_at_epoch_seconds=150)
    metadata: anonymize.SessionMetadata = session.inspect(150)
    assert metadata["status"] == "active"
    session.to_plaintext_json_at(150)
    archive_key = bytes([0x42]) * 32
    archive = session.to_encrypted_archive_at(archive_key, 150)
    prepared.restore_encrypted_redaction_session(
        archive,
        archive_key,
        session.session_id(),
        observed_at_epoch_seconds=150,
    )
    deletion: anonymize.SessionDeletionSummary = session.delete()
    assert deletion["deleted_mapping_count"] == session.mapping_count()
    return result.redaction.redacted_text


def redact_caller_detection(text: str) -> str:
    prepared = anonymize.get_default_native_pipeline(language="en")
    detections: list[anonymize.CallerDetection] = [
        {
            "start": 0,
            "end": len(text),
            "label": "person",
            "score": 0.9,
            "provider_id": "typecheck-provider",
            "detection_id": "person-1",
        }
    ]
    return prepared.redact_text_with_caller_detections(
        text,
        detections,
    ).redaction.redacted_text


def convert_external_detection(document: bytes) -> list[anonymize.CallerDetection]:
    limits: tuple[int, ...] = (
        anonymize.EXTERNAL_DETECTION_BATCH_MAX_BYTES,
        anonymize.EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
        anonymize.EXTERNAL_DETECTION_MAX_DETECTIONS,
        anonymize.EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
        anonymize.EXTERNAL_DETECTION_MAX_METADATA_BYTES,
        anonymize.EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES,
        anonymize.CALLER_DETECTION_MAX_COUNT,
        anonymize.CALLER_DETECTION_REQUEST_JSON_MAX_BYTES,
        anonymize.CALLER_DETECTION_TEXT_MAX_BYTES,
        anonymize.SESSION_CALLER_INPUTS_JSON_MAX_BYTES,
        anonymize.SESSION_CALLER_MAX_INPUTS,
    )
    assert all(limit > 0 for limit in limits)
    batch: anonymize.ExternalDetectionBatch = {
        "version": 1,
        "document": {"sha256": "0" * 64},
        "offsetUnit": "unicode-code-point",
        "provider": {
            "id": "fake-provider",
            "name": "Deterministic fake provider",
            "version": "1.0.0",
        },
        "labelMap": [{"providerLabel": "PER", "entityLabel": "person"}],
        "detections": [],
    }
    return anonymize.convert_external_detection_batch(document, batch)


def package_version() -> str:
    return anonymize.__version__


def redact_json(config_json: str, text: str) -> str:
    return anonymize.redact_text_json(
        config_json,
        text,
        {"country": "redact"},
        redact_string="***",
    )


def redact_object(config_json: str, text: str) -> int:
    result = anonymize.redact_text(
        config_json,
        text,
        {"country": "redact"},
        redact_string="***",
    )
    return result.redaction.entity_count


def deanonymise_entries(text: str) -> str:
    prepared = anonymize.get_default_native_pipeline(language="en")
    result = prepared.redact_text(text)
    return anonymize.deanonymise(
        result.redaction.redacted_text,
        result.redaction.redaction_map,
    )


def deanonymise_mapping(redacted_text: str, redaction_map: Mapping[str, str]) -> str:
    return anonymize.deanonymise(redacted_text, redaction_map)


def deanonymise_pairs(redacted_text: str, pairs: list[tuple[str, str]]) -> str:
    return anonymize.deanonymise(redacted_text, pairs)
