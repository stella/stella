<p align="center">
  <img src=".github/assets/banner.png" alt="stella anonymize" width="100%" />
</p>

<p align="center">
  <strong>Local PII detection and anonymization for text and legal documents.</strong>
</p>

<p align="center">
  <a href="https://stll.app">Website</a> &middot;
  <a href="https://github.com/stella/anonymize/issues">Issues</a> &middot;
  <a href="https://www.npmjs.com/package/@stll/anonymize">npm</a> &middot;
  <a href="https://pypi.org/project/stella-anonymize-core/">PyPI</a> &middot;
  <a href="https://discord.gg/8dZjmVFjTK">Discord</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@stll/anonymize"><img src="https://img.shields.io/npm/v/@stll/anonymize?label=%40stll%2Fanonymize" alt="npm" /></a>
  <a href="https://pypi.org/project/stella-anonymize-core/"><img src="https://img.shields.io/pypi/v/stella-anonymize-core?label=stella-anonymize-core&logo=pypi&logoColor=white" alt="PyPI" /></a>
  <a href="https://github.com/stella/anonymize/actions/workflows/ci.yml"><img src="https://github.com/stella/anonymize/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0" /></a>
  <a href="https://discord.gg/8dZjmVFjTK"><img src="https://img.shields.io/badge/discord-join%20chat-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

stella anonymize is an open-source PII redaction toolkit for applications that
need to process sensitive text locally. It is designed with contracts, court
filings, correspondence, and other legal documents in mind, while remaining a
general-purpose library.

Detection and replacement live in one Rust core. Node.js, Python, and browser
bindings call that same implementation; the repository tests their public
surfaces and normalized behavior for parity. The default pipeline is
deterministic and does not call a model or remote service.

No detector catches everything. Review coverage reports and output when a miss
would matter, especially with OCR or partially supported document formats.

## Quickstart

### Node.js

```bash
npm install @stll/anonymize
```

```ts
import { deanonymise, getDefaultNativePipeline } from "@stll/anonymize";

const pipeline = getDefaultNativePipeline({ language: "en" });
const { redaction } = pipeline.redactText(
  "Contact Alice Smith at alice@example.com.",
);

console.log(redaction.redactedText);
// Contact [PERSON_1] at [EMAIL_ADDRESS_1].

const original = deanonymise(redaction.redactedText, redaction.redactionMap);
console.log(original);
// Contact Alice Smith at alice@example.com.
```

Create the pipeline once and reuse it. Language-scoped packages are bundled for
English, Czech, and German; an all-language package is bundled as well. Built-in
data covers `cs`, `de`, `en`, `es`, `fr`, `hu`, `it`, `pl`, `pt-br`, `ro`,
`sk`, and `sv`. The [Node package guide](packages/anonymize/README.md) covers
sessions, custom detections, operators, diagnostics, and prepared packages; the
[capability manifest](packages/anonymize/src/capabilities.ts) is the exact list
of public runtime surfaces and entity types.

### Browser

```bash
npm install @stll/anonymize-wasm
```

```ts
import { loadDefaultPipeline } from "@stll/anonymize-wasm";

const pipeline = await loadDefaultPipeline("en");
const { redaction } = pipeline.redactText("A contract signed by Alice Smith.");
```

The browser build is single-threaded and works without cross-origin isolation,
`SharedArrayBuffer`, or a worker. Vite applications can use the package helper
to emit the WebAssembly module and prepared data. See the
[browser guide](packages/anonymize/wasm/README.md).

### Python

```bash
uv add stella-anonymize-core
# or: pip install stella-anonymize-core
```

```py
import stella_anonymize as anonymize

pipeline = anonymize.preload_default_native_pipeline(language="en")
result = pipeline.redact_text(
    "Contact Alice Smith at alice@example.com."
)

print(result.redaction.redacted_text)
```

Prebuilt Python 3.11+ wheels target manylinux glibc x64/aarch64, macOS
x64/arm64, and Windows x64. The [Python guide](crates/anonymize-py/README.md)
covers sessions, encrypted archives, caller detections, DOCX, and PDF APIs.

### CLI

```bash
echo "Contact Alice Smith at alice@example.com" | npx @stll/anonymize-cli
# Contact [PERSON_1] at [EMAIL_ADDRESS_1]
```

The `anonymize` command reads stdin, files, or directory trees. It also supports
reversible keys and DOCX/PDF workflows:

```bash
npx @stll/anonymize-cli -k contract.key.json -o contract.anon.txt contract.txt
npx @stll/anonymize-cli -d contract.key.json contract.anon.txt
```

See the [CLI reference](packages/cli/README.md) for batch processing, selective
restoration, document commands, JSON output, and exit codes.

### Local MCP server

`@stll/anonymize-mcp` exposes path-only tools over stdio. Tool arguments contain
filesystem paths rather than document text, and results contain aggregate
status rather than document contents or plaintext mappings.

```json
{
  "mcpServers": {
    "stella-anonymize": {
      "command": "npx",
      "args": [
        "-y",
        "@stll/anonymize-mcp",
        "--root",
        "/absolute/path/to/workspace"
      ]
    }
  }
}
```

The server requires Node.js 20+. It supports text, DOCX, PDF, and
provider-neutral external-detection sidecars for text. Encrypted durable
sessions are optional and currently limited to macOS and Linux. PDF tools need
local Poppler and Tesseract installations; their executable paths can be set at
server startup. Read the [MCP guide](packages/mcp/README.md) before enabling
durable sessions or document tools; it defines path, permission, key, archive,
and failure boundaries.

## Document support

### DOCX

DOCX extraction, anonymization, and restoration are available in Node.js and
Python, and through the CLI and local MCP server. The adapters preserve the
supported Word structures and return a coverage inventory for known content
outside the rewrite surface. The default `require-full` policy fails closed on
coverage gaps; partial rewrites require explicit opt-in.

The DOCX never stores the plaintext redaction mapping. Reversible workflows use
an application-owned session and, when persisted, an encrypted session archive.
Signed documents, tracked revisions, external relationship targets, and other
package features have explicit restrictions. See
[`@stll/anonymize-docx`](packages/document-docx/README.md) for the complete
coverage contract.

### PDF

PDF inspection is available in Node.js, Python, and WASM. Node.js and Python
both expose the destructive raster contract, which requires complete rendered
page pixels, OCR text, and glyph geometry. The Node.js package can produce
those observations with separately installed Poppler and Tesseract; the CLI
and MCP server use that adapter. Python callers must supply observations and
pixels from their own renderer/OCR boundary.

The output is a new image-only PDF. Source PDF objects are not copied and black
rectangles are not layered over recoverable content. This removes
searchability, accessibility, links, forms, signatures, metadata, attachments,
and other interactive features. Verification proves the fresh output structure
and requested pixel rewrite; it cannot prove perfect OCR or PII detection
recall. The certificate therefore never claims that the output is PII-free.
See [`@stll/anonymize-pdf`](packages/document-pdf/README.md) for the inspection,
rendering, OCR, resource-limit, and verification contracts.

The full runtime and format matrix, including known gaps, lives in
[PII redaction surfaces](docs/pii-redaction-surfaces.md).

## Runtime and privacy model

- Rust crates own text detection, replacement, and DOCX/PDF planning. Node.js,
  Python, and WASM bindings are checked by capability-profile parity tests.
- Prepared language data is bundled into versioned `.stlanonpkg` artifacts; the
  default SDKs and CLI do not send document text to a remote service.
- Reversible redaction maps contain original PII. Encrypted session archives
  protect persisted mappings, but applications still own key generation,
  storage, rotation, and authorization.
- Diagnostic events omit matched text, but redaction results and reversible maps
  can contain original PII. Do not send those values to ordinary logs or
  telemetry.
- Optional model or service detections enter through a validated, digest-bound
  sidecar. stella does not bundle a model runner.

The machine-readable public contract is exported as `CAPABILITY_MANIFEST` from
`@stll/anonymize/capabilities` and printed by `anonymize --capabilities`. The
[architecture guide](packages/anonymize/ARCHITECTURE.md) describes the native
package graph and parity boundaries.

## Packages

| Package                                                              | Purpose                                             |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| [`@stll/anonymize`](packages/anonymize/README.md)                    | Node.js SDK and native runtime                      |
| [`stella-anonymize-core`](crates/anonymize-py/README.md)             | Python bindings                                     |
| [`@stll/anonymize-wasm`](packages/anonymize/wasm/README.md)          | Browser/WASM runtime                                |
| [`@stll/anonymize-cli`](packages/cli/README.md)                      | Command-line text, DOCX, and PDF workflows          |
| [`@stll/anonymize-mcp`](packages/mcp/README.md)                      | Path-only local MCP server                          |
| [`@stll/anonymize-docx`](packages/document-docx/README.md)           | Structure-aware DOCX adapter                        |
| [`@stll/anonymize-pdf`](packages/document-pdf/README.md)             | PDF inspection and destructive raster anonymization |
| [`@stll/anonymize-data`](packages/data/README.md)                    | Published dictionaries and detector configuration   |
| [`crates/anonymize-core`](crates/anonymize-core/README.md)           | Shared Rust core                                    |
| [`crates/document-rules-core`](crates/document-rules-core/README.md) | Structured document rule engine                     |

Platform-specific Node.js binary packages are installed automatically as
optional dependencies of `@stll/anonymize`.

## Benchmarks

The sealed suite compares stella with Presidio, base scrubadub, DataFog's
model-free regex engine, and redact-pii on TAB-ECHR, RedactionBench, MEDDOCAN,
and German Legal Entity Recognition. Each corpus keeps its own task and metrics;
German LER is reported as legal-entity coverage, not PII recall. Holdout reports
contain aggregate values only. PII-Shield is included when its external CLI and
model are installed, and the German runner can also report an optional pinned
Nym ONNX model as an assisted stella lane.

Quality-suite timings are one-shot corpus passes, so they are directional
rather than speed rankings. The separate cross-provider harness runs stella's
full pipeline, stella's built-in regex detectors, base scrubadub, and DataFog's
regex engine in fresh processes with discarded warmups and repeated samples.
It reports startup, initialization, calls, process CPU, and end-to-end wall
time; read speed alongside output counts because detector scope differs.

Read the [benchmark methodology](packages/benchmark/README.md), browse the
[committed aggregate results](packages/benchmark/results/), or follow the
[reproduction guide](packages/benchmark/REPRODUCING.md). Results describe
particular datasets and versions; they are not a guarantee of performance on
your documents.

## Development

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
```

Contributions are welcome. Please keep language-dependent data in its
per-language vocabulary, make generated data reproducible, and do not commit
raw personal data or non-public fixtures. A CLA check runs on pull requests.

## License

Apache-2.0. See [`LICENSE`](LICENSE). Third-party runtime attributions, including
the browser build, are listed in [`ATTRIBUTION.md`](ATTRIBUTION.md).
