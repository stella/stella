# stella-anonymize-core

Python bindings for the stella anonymization Rust core.

## Install

Prebuilt wheels on PyPI ship the bundled native pipeline packages, so no
monorepo checkout is needed:

```bash
uv add stella-anonymize-core
# or: pip install stella-anonymize-core
```

Wheels target Python 3.11+ (abi3) on manylinux x64/aarch64, macOS x64/arm64,
and Windows x64. Only wheels are published; there is no source distribution.
The `build.rs` step needs the monorepo's generated `.stlanonpkg` native
pipeline packages, so a source build cannot be self-contained. To build from a
checkout instead, run `bun run build` first so those packages exist, then:

```bash
uv add ./crates/anonymize-py
```

## Usage

Prepare or load the anonymizer once, then reuse it for documents.

```py
import stella_anonymize as anonymize

prepared = anonymize.create_pipeline(language="en", warmup="lazy-regex")
text = "Contact Alice Smith at alice@example.com."
result = prepared.redact_text(text, redact_string="***")

print(result.redaction.redacted_text)
```

`create_pipeline()` accepts one supported language, an exact non-empty
sequence such as `["cs", "en"]`, or `"all"`. It uses a matching prepared
artifact when one is bundled and otherwise prepares and caches the exact
requested scope.

Reverse replacement placeholders with the returned redaction map (a mapping of
`placeholder -> original`, a sequence of `RedactionEntry`, or
`(placeholder, original)` pairs; entries apply in order):

```py
restored = anonymize.deanonymise(
    result.redaction.redacted_text,
    result.redaction.redaction_map,
)
```

For related documents, create an explicit in-memory session from the prepared
anonymizer. Repeated normalized entities reuse their placeholders within that
session:

```py
session = prepared.create_redaction_session("opaque_case_1")
first = session.redact_text(first_document)
second = session.redact_text(second_document)
restored_text = session.restore_text(first.redaction.redacted_text)
```

`restore_text()` restores complete known placeholders in one non-cascading
pass. Other session namespaces remain unchanged; unknown placeholders owned by
the session fail closed. Lifecycle sessions also require the caller-supplied
`observed_at_epoch_seconds` argument.

`session.to_plaintext_json()` supports deterministic in-memory transfer between
runtime instances. Its output contains original personal data in plaintext: do
not log it or persist it without an application-owned protection layer. Restore
validated transfer state with `prepared.restore_redaction_session(json_state)`.

For persistence, use the authenticated binary archive API with a caller-owned
32-byte key. Restoring requires the expected session identity so an archive
cannot be substituted across records:

```py
archive = session.to_encrypted_archive(application_key)
restored = prepared.restore_encrypted_redaction_session(
    archive,
    application_key,
    session.session_id(),
)
```

Generate, store, rotate, and authorize access to the key outside the SDK. The
archive contains personal data as ciphertext; do not log the archive or key.
Lifecycle sessions use `to_encrypted_archive_at()` and require
`observed_at_epoch_seconds` when restored.

Sessions can carry explicit lifecycle bounds. The engine never reads the system
clock; supply the UTC epoch-second observation time for each lifecycle-aware
operation:

```py
session = prepared.create_redaction_session_with_lifecycle(
    "opaque_case_2",
    created_at_epoch_seconds=1_800_000_000,
    expires_at_epoch_seconds=1_800_086_400,
)
result = session.redact_text_at(
    document,
    observed_at_epoch_seconds=1_800_000_100,
)
metadata = session.inspect(1_800_000_100)  # contains no entity values
deletion = session.delete()
```

Expiry is fail-closed at its exact boundary. `delete()` performs logical
deletion: it clears the session mappings and prevents future use, but does not
revoke earlier exported copies or claim physical erasure of process memory.

DOCX uses the same session mappings and fail-closed coverage policy as the
TypeScript document binding. Extraction and rewrite offsets are UTF-16 code
units because locations and plans are portable across runtimes:

```py
extraction = anonymize.extract_docx_text(document_bytes)
result = anonymize.anonymize_docx(
    document_bytes,
    session,
    session.session_id(),
    {"coverage": {"mode": "require-full"}},
)
restored = anonymize.restore_docx_text(
    result["document"],
    session,
    session.session_id(),
)
```

`require-full` rejects packages containing unhandled metadata, custom XML,
external relationship targets, or unsupported WordprocessingML constructs.
Use `{"mode": "allow-partial"}` only when the caller has explicitly accepted
the returned coverage inventory. Rewriting refuses signed packages rather than
silently invalidating their signature.

Caller-produced detections use Python character indexes and enter the same
resolution and redaction pipeline as built-in detections:

```py
result = prepared.redact_text_with_caller_detections(
    "😀Alice signed.",
    [{"start": 1, "end": 6, "label": "person", "score": 0.95,
      "provider_id": "example-ner", "detection_id": "person-1"}],
)
```

Pass `{"organization": "keep"}` as the operators argument to preserve
detected organizations while processing other labels normally. Kept entities
remain in the result and operator map, but create no reversible mapping entry.

Use a tagged mask configuration to replace a number of visible Unicode
grapheme clusters from the start or end:

```py
operators = {
    "email address": {
        "type": "mask",
        "masking_character": "*",
        "characters_to_mask": 6,
        "direction": "start",
    }
}
```

`provider_id` and `detection_id` are required 1–128 byte ASCII identifiers:
they start with an alphanumeric character and otherwise contain only
alphanumerics, `.`, `_`, `:`, or `-`. Do not encode personal data in them.
Retained entities preserve both IDs;
`redact_text_with_caller_detections_diagnostics_json()` reports audit-safe
external input and retained counts without matched text.

Portable model or service output can be validated with
`convert_external_detection_batch(document_bytes, batch)`. The v1 batch uses
the same provider-neutral, SHA-256-bound contract as Node, with an explicit
`utf8-byte`, `utf16-code-unit`, or `unicode-code-point` offset unit and explicit
provider-label mappings. It has no model dependency and does not require
GLiNER. `provider.id` is the immutable, versionable audit identity retained on
detections. `provider.name` and `provider.version` are validated descriptive
batch metadata but are not copied into caller detections; retain the original
batch if an audit record needs them. The returned value feeds the existing
caller-detection API after the shared Rust contract validates and converts its
spans.

## PDF inspection

`inspect_pdf()` inventories PDF structures that can retain sensitive content
and returns fail-closed page coverage. It does not redact PDFs. Without explicit
renderer/OCR page observations, every page is reported as
`page-content-not-observed`; opaque rectangle overlays are never treated as
anonymization.

```py
from pathlib import Path
import stella_anonymize as anonymize

inspection = anonymize.inspect_pdf(Path("contract.pdf").read_bytes())
print(inspection["risks"])
print(inspection["coverage"])
```

Regional codes use the exact package when present and otherwise fall back to
the base language package, so `en-US` can use the shipped `en` artifact.

`anonymize_pdf_raster()` is the destructive output API. The caller supplies a
complete observation and RGB8 pixel buffer for every page; the function runs
the prepared anonymizer, maps selected spans to glyph geometry, fills those
pixels, and returns a new image-only PDF plus its verification certificate.
Python does not bundle a renderer or OCR engine.

`rewrite_pdf_raster_from_detections()` is the lower-level seam for callers that
already own validated UTF-16 detection ranges. Both APIs reject incomplete page
coverage, unmapped detections, mismatched pixels, source-object reuse, and
limit violations. A successful certificate proves the destructive rewrite and
fresh output structure, not perfect OCR or PII recall; `piiCleanGuaranteed` is
always false.

For caller-owned configs, prepare package bytes before serving documents and
load them at runtime:

```py
import stella_anonymize as anonymize

package_bytes = anonymize.prepare_search_package(config_json)
prepared = anonymize.load_prepared_package(package_bytes)
prepared.warm_lazy_regex()
result = prepared.redact_text(text, redact_string="***")
```

`get_default_native_pipeline()` defers lazy regex warmup by default so the first
call only pays for regexes the document actually touches. Use
`preload_default_native_pipeline()` or pass `warmup="lazy-regex"` when startup can
absorb that cost before serving documents. Top-level `redact_text()` and
`redact_text_json()` are available for one-off calls, but they prepare from config
on each invocation. Use `load_prepared_package()` or `load_prepared_package_file()`
for repeated document processing.

## API

- `prepare_search_package(config_json | config_bytes | config_mapping, compressed=True) -> bytes`
- `load_prepared_package(package_bytes) -> PreparedAnonymizer`
- `load_prepared_package_file(package_path) -> PreparedAnonymizer`
- `available_default_native_pipeline_languages() -> tuple[str, ...]`
- `read_default_native_pipeline_package_file(language=None) -> bytes`
- `get_default_native_pipeline(language=None, package_path=None, warmup="none") -> PreparedAnonymizer`
- `preload_default_native_pipeline(language=None, package_path=None) -> PreparedAnonymizer`
- `PreparedAnonymizer.warm_lazy_regex()`
- `PreparedAnonymizer.warm_lazy_regex_diagnostics_json()`
- `PreparedAnonymizer.create_redaction_session(session_id) -> PreparedRedactionSession`
- `PreparedAnonymizer.create_redaction_session_with_lifecycle(...) -> PreparedRedactionSession`
- `PreparedAnonymizer.restore_redaction_session(plaintext_json) -> PreparedRedactionSession`
- `PreparedRedactionSession.restore_text(full_text, observed_at_epoch_seconds=None) -> str`
- `deanonymise(redacted_text, redaction_map) -> str`
- `inspect_pdf(document, page_observations=None) -> dict`
- `anonymize_pdf_raster(document, anonymizer, provider, pages, fill_rgb=(0, 0, 0)) -> (bytes, dict)`
- `rewrite_pdf_raster_from_detections(document, request, page_pixels) -> (bytes, dict)`
- `PreparedAnonymizer.redact_text(text, operators=None, redact_string=None)`
- `PreparedAnonymizer.redact_text_json(text, operators=None, redact_string=None)`
- `PreparedAnonymizer.diagnostics_json(text, operators=None, redact_string=None)`

`PreparedSearch` is an alias for `PreparedAnonymizer`.
