<p align="center">
  <img src="../../.github/assets/banner.png" alt="stella anonymize" width="100%" />
</p>

# @stll/anonymize

Runtime package for multi-layer PII detection and anonymization.

It combines regex detectors, trigger phrases, deny-list matching, and coreference handling in a single deterministic pipeline that works in native Node.js and in browser builds through the WASM entrypoint.

The default pipeline detects personal identifiers; it is not a general-purpose
secret scanner. Passwords, authentication tokens, API keys, and private
cryptographic material are outside its claimed scope. IP addresses, MAC
addresses, and URLs are explicit opt-in capabilities. Query
`CAPABILITY_MANIFEST` or `anonymize --capabilities` instead of assuming a label
is enabled.

## Install

```bash
bun add @stll/anonymize
```

The Node.js and Bun package is Rust-native and requires Node.js 20 or newer or
Bun 1.4 or newer. Prebuilt binaries ship for macOS (`arm64`, `x64`),
glibc-based Linux (`arm64`, `x64`), and Windows (`x64`). Alpine Linux and other
musl-based systems are not supported. Browser/WASM support is maintained
through `@stll/anonymize-wasm`, which wraps the same native core.

## Usage: Node.js native SDK

```ts
import { createPipeline } from "@stll/anonymize/native-node";

const anonymizer = await createPipeline({ language: "en" });
const text = "Contact Alice Smith at alice@example.com.";
const result = anonymizer.redactText(text);

console.log(result.redaction.redactedText);
```

Call `createPipeline()` once during service startup and reuse the returned
anonymizer. Pass `warmup: "lazy-regex"` when the first document should not pay
lazy regex warm-up.

The semantic language selector accepts one supported code, an exact non-empty
combination, or `"all"`:

```ts
await createPipeline({ language: "es" });
await createPipeline({ language: ["cs", "en"] });
await createPipeline({ language: "all" });
```

Supported codes are `cs`, `de`, `en`, `es`, `fr`, `hu`, `it`, `lv`, `pl`,
`pt-br`, `ro`, `sk`, and `sv`. Unsupported and empty selections fail before a
pipeline is loaded. The factory uses a matching prepared artifact when one is
bundled; otherwise it prepares and caches the exact requested scope. It never
substitutes the all-language behavior for a narrower request.

`getDefaultNativePipeline()` and related loaders remain the lower-level
prepared-artifact API. The distributed package bundles the all-language
artifact plus smaller `cs`, `de`, and `en` artifacts.

Source builds emit the same three scoped artifacts by default.
`STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES` can replace that list or be set to
an empty value to build only the all-language package:

```bash
STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES=en,cs,fr bun run build
```

For the lower-level artifact loader, regional codes use the exact package when
present and otherwise fall back to the base language package, so `en-US` can
use the shipped `en` artifact. The semantic factory accepts only the supported
codes listed above.

For build-time generated packages or caller-owned data, prepare the package before runtime and load the bytes in the process that handles documents.

```bash
bunx stella-anonymize-build-native-package \
  --config ./anonymize-native-config.mjs \
  --out ./dist/anonymize.stlanonpkg
```

```ts
import { load_prepared_package_file } from "@stll/anonymize/native-node";

const anonymizer = load_prepared_package_file("./dist/anonymize.stlanonpkg");
anonymizer.warmLazyRegex();
const warmDiagnosticsJson = anonymizer.warmLazyRegexDiagnosticsJson();
const result = anonymizer.redact_text(text, { redactString: "***" });
```

For related documents, create an explicit in-memory session from the prepared
anonymizer. The session reuses placeholders for the same normalized entity while
keeping its mutable mapping state isolated from other sessions:

```ts
const session = anonymizer.createRedactionSession("opaque_case_1");
const first = session.redact_text(firstDocument);
const second = session.redact_text(secondDocument);
const restoredText = session.restoreText(first.redaction.redactedText);
```

`restoreText()` replaces only complete placeholders owned by that active
session. It performs one non-cascading pass, leaves other session namespaces
unchanged, and rejects unknown placeholders in its own namespace. Pass the
caller-supplied observation time as the second argument for lifecycle sessions.

`session.toPlaintextJson()` supports deterministic in-memory transfer between
runtime instances. Its output contains original personal data in plaintext: do
not log it or persist it without an application-owned protection layer. Restore
validated transfer state with `anonymizer.restoreRedactionSession(json)`.

For persistence or transfer, prefer an authenticated encrypted archive. Supply
a caller-owned 32-byte key; key generation, storage, rotation, and access
control remain application responsibilities. Restoring also requires the
expected session ID so an archive cannot be substituted across records:

```ts
const key = crypto.getRandomValues(new Uint8Array(32));
const archive = session.toEncryptedArchive(key);
const restored = anonymizer.restoreEncryptedRedactionSession({
  archive,
  key,
  expectedSessionId: "opaque_case_1",
});
```

The archive contains personal data as ciphertext. Do not log the key or derive
it directly from a password; use a key-management boundary appropriate to the
deployment.

Sessions can carry explicit lifecycle bounds. The engine never reads the system
clock; supply the UTC epoch-second observation time for each lifecycle-aware
operation:

```ts
const key = crypto.getRandomValues(new Uint8Array(32));
const session = anonymizer.createRedactionSessionWithLifecycle({
  sessionId: "opaque_case_2",
  createdAtEpochSeconds: 1_800_000_000,
  expiresAtEpochSeconds: 1_800_086_400,
});
const result = session.redactTextAt({
  fullText: document,
  observedAtEpochSeconds: 1_800_000_100,
});
const metadata = session.inspect(1_800_000_100); // contains no entity values
const archive = session.toEncryptedArchiveAt(key, 1_800_000_100);
const restored = anonymizer.restoreEncryptedRedactionSession({
  archive,
  key,
  expectedSessionId: "opaque_case_2",
  observedAtEpochSeconds: 1_800_000_100,
});
const deletion = session.delete();
```

Expiry is fail-closed at its exact boundary. `delete()` performs logical
deletion: it clears the session mappings and prevents future use, but does not
revoke earlier exported copies or claim physical erasure of process memory.

Per-label operators support `replace`, `redact`, `keep`, and tagged `mask`
configuration. `keep` records
that an entity was processed while leaving its source text unchanged; it
creates no reversible redaction-key entry:

```ts
const result = anonymizer.redactText(text, {
  operators: { organization: "keep" },
});
```

`mask` replaces a configured number of visible Unicode grapheme clusters from
the start or end. A masking character must itself be exactly one grapheme:

```ts
const result = anonymizer.redactText(text, {
  operators: {
    "email address": {
      type: "mask",
      maskingCharacter: "*",
      charactersToMask: 6,
      direction: "start",
    },
  },
});
```

Caller-produced spans enter the same resolution and redaction pipeline. Node
and browser offsets use JavaScript UTF-16 string indexes; matched text is
derived from the input:

```ts
const result = anonymizer.redactTextWithCallerDetections("😀Alice signed.", {
  detections: [
    {
      start: 2,
      end: 7,
      label: "person",
      score: 0.95,
      providerId: "example-ner",
      detectionId: "person-1",
    },
  ],
});
```

`providerId` and `detectionId` are required provenance identifiers. They must
be 1–128 ASCII characters, start with an alphanumeric character, and otherwise
contain only alphanumerics, `.`, `_`, `:`, or `-`; do not encode personal data
in them. Retained result entities preserve both IDs. Use
`redactTextWithCallerDetectionsDiagnosticsJson()` for audit-safe input and
retained counts. Diagnostic events include provenance, labels, offsets, and
scores, but never matched text.

For model and service integrations, use the portable
`ExternalDetectionBatch` v1 exchange contract. It is provider-neutral and does
not install or require GLiNER (or any other model runtime). The batch is bound
to the exact UTF-8 document bytes by SHA-256, declares one closed offset unit,
maps provider labels explicitly, and is converted by the Rust contract before
entering the existing caller-detection pipeline:

```ts
import { createHash } from "node:crypto";
import {
  EXTERNAL_DETECTION_BATCH_VERSION,
  convert_external_detection_batch,
} from "@stll/anonymize";

const document = new TextEncoder().encode("😀Alice signed.");
const providerOutput = {
  version: EXTERNAL_DETECTION_BATCH_VERSION,
  document: { sha256: createHash("sha256").update(document).digest("hex") },
  offsetUnit: "unicode-code-point",
  provider: { id: "example.local", name: "Example detector", version: "1" },
  labelMap: [{ providerLabel: "PER", entityLabel: "person" }],
  detections: [{ id: "person-1", start: 1, end: 6, label: "PER", score: 0.99 }],
} as const;
const detections = convert_external_detection_batch(document, providerOutput);
```

The same converter is available from `@stll/anonymize-wasm`; it returns a
promise because the WebAssembly binding loads lazily. Node, Python, and browser
WebAssembly execute the same Rust validation and offset conversion contract.

The example provider output is deliberately synthetic. Real providers may run
in-process, as a local sidecar, or behind an application-owned service.
`provider.id` is the immutable audit identity copied into every retained
detection; version it when a materially different detector must remain
distinguishable (for example, `example.local:1`). `provider.name` and
`provider.version` are validated descriptive batch metadata, but are not copied
into caller detections. Retain the original batch if those fields are needed in
an audit record. The converter rejects unknown fields and versions, digest
mismatch, invalid Unicode boundaries, unmapped labels, duplicate provenance,
and bounded-size violations; it never guesses an offset unit or label mapping.
Keep IDs free of personal data. Pass the returned detections to
`redactTextWithCallerDetections()` using the UTF-8-decoded document text.

TypeScript (including the WASM entry) and Python export the same exact v1 limit
constants:

| v1 limit                   | Public constant                            |               Exact value |
| -------------------------- | ------------------------------------------ | ------------------------: |
| Serialized batch           | `EXTERNAL_DETECTION_BATCH_MAX_BYTES`       | 16,777,216 bytes (16 MiB) |
| UTF-8 document             | `EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES`    | 67,108,864 bytes (64 MiB) |
| Detections                 | `EXTERNAL_DETECTION_MAX_DETECTIONS`        |                   100,000 |
| Label mappings             | `EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS`    |                     4,096 |
| Descriptive metadata field | `EXTERNAL_DETECTION_MAX_METADATA_BYTES`    |                 256 bytes |
| Provider ID                | `EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES` |                 128 bytes |

The config module may export a `PipelineConfig` directly or `{ config, gazetteerEntries }`. Include `@stll/anonymize-data` dictionaries there if your runtime config uses the deny-list or name-corpus layers; keep the corresponding layers enabled for caller-owned `customDenyList`, `customRegexes`, and gazetteers. Those inputs are part of the prepared package and should be regenerated when they change.

## Python SDK

```py
import stella_anonymize as anonymize

languages = anonymize.available_default_native_pipeline_languages()
prepared = anonymize.preload_default_native_pipeline(
    language="en" if "en" in languages else None
)
text = "Contact Alice Smith at alice@example.com."
result = prepared.redact_text(text, redact_string="***")

session = prepared.create_redaction_session("opaque_case_1")
redacted = session.redact_text(text)
restored_text = session.restore_text(redacted.redaction.redacted_text)
archive = session.to_encrypted_archive(application_owned_32_byte_key)
restored = prepared.restore_encrypted_redaction_session(
    archive,
    application_owned_32_byte_key,
    "opaque_case_1",
)

print(result.redaction.redacted_text)
```

Python caller detections use Python character indexes:

```py
result = prepared.redact_text_with_caller_detections(
    "😀Alice signed.",
    [{"start": 1, "end": 6, "label": "person", "score": 0.95,
      "provider_id": "example-ner", "detection_id": "person-1"}],
)
```

Python preserves `provider_id` and `detection_id` on retained entities. Use
`redact_text_with_caller_detections_diagnostics_json()` for the same audit-safe
diagnostics contract.

The Python SDK uses the same Rust core, encrypted session archive format, and
prepared-package contract as the Node SDK. The application owns archive-key
generation, storage, rotation, and authorization. Prefer
`get_default_native_pipeline()`, `preload_default_native_pipeline()`,
`load_prepared_package()`, or `load_prepared_package_file()` for repeated calls;
top-level `redact_text()` and `redact_text_json()` prepare from config on each
call.

## Caller-Owned Deny Lists and Regexes

Use `customDenyList` for exact terms and variants that you control. Use
`customRegexes` for deterministic patterns that are not built into the package.
Caller-owned data is part of the prepared package, so build or load a package
from that config before serving documents.

```ts
import {
  createNativePipelineFromConfig,
  loadNativeAnonymizeBinding,
} from "@stll/anonymize/native-node";

const binding = loadNativeAnonymizeBinding();
const pipeline = await createNativePipelineFromConfig({
  binding,
  config: {
    ...baseConfig,
    enableDenyList: true,
    enableRegex: true,
    customDenyList: [
      {
        value: "Project Nebula",
        variants: ["Nebula Programme"],
        label: "organization",
      },
    ],
    customRegexes: [
      {
        pattern: "\\bSTLL-[0-9]{4}\\b",
        label: "matter reference",
        score: 1,
      },
    ],
  },
  gazetteerEntries: [],
});

const result = pipeline.redactText(text);
```

## Browser setup

If you use Vite with the WASM build, exclude the bundle from dependency pre-bundling:

```ts
import stllWasm from "@stll/anonymize-wasm/vite";

export default {
  plugins: [stllWasm()],
};
```

## Notes

- Native architecture and extension guidance:
  [`ARCHITECTURE.md`](ARCHITECTURE.md).
- `labels: []` disables deterministic label filtering.
- Model-produced (NER) spans are not part of `PipelineConfig`; supply
  deterministic custom rules today and use the caller-detection API for
  model-produced spans.
- `enableNameCorpus` also controls whether first names, surnames, and titles are injected into deny-list matching when `enableDenyList` is enabled.
- `standaloneStreetDetection` defaults to `"off"`: an address span normally needs
  two kinds of evidence (a street, a postal code, a city, a state, or an address
  trigger). Set it to `"houseNumberAnchored"` to also accept a street-type word
  with a house number directly beside it in either order (`14 Rue de la Paix`,
  `Hauptstraße 5`, `123 Main Street`). A bare street name with no number never
  fires, and only the street types of the languages in `languages` / `language`
  are recognized, so an English-scoped pipeline does not detect `Hauptstraße 5`.
  The mode trades precision for recall: a street-type word next to a number also
  occurs in contract prose (`District Court 2019`), so enable it per workspace
  rather than globally. It changes the prepared package, so rebuild the package
  after changing it.
- The optional `@stll/anonymize-data` package carries the published dictionary and trigger data used when building prepared packages.
- `customDenyList` and `customRegexes` are part of the prepared package input and should be regenerated when they change.

## Built on

- `@stll/anonymize-data`
