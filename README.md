<p align="center">
  <img src=".github/assets/banner.png" alt="stella anonymize" width="100%" />
</p>

<p align="center">
  <strong>Local PII detection and anonymization for text.</strong>
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

stella anonymize is an open-source, local-first PII redaction toolkit for legal
and regulated workflows. Detection and replacement are implemented in a shared
Rust core, with bindings for Node.js, Python, and browsers. The default pipeline
is deterministic and makes no model or remote-service calls. Coverage varies by
language, entity type, and document structure.

No detector catches everything. Reversible placeholder replacement is
pseudonymization, and its maps contain original PII; do not log or treat them as
anonymous output. The default pipeline targets personal identifiers, not
passwords, authentication tokens, API keys, or private cryptographic material.
IP addresses, MAC addresses, and URLs require explicit opt-in capabilities.

Contributing to the project is welcome.

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

Raw `--key` export is Linux-only and fails closed on other platforms because
the CLI cannot verify owner-only filesystem ACLs.

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
optional dependencies of `@stll/anonymize`. Node.js and Bun use the same native
binding; Bun 1.4 or newer is required. A clean macOS arm64 npm install from the
packed artifacts uses about 63 MiB on disk; CI caps the packed SDK plus every
native sidecar at 70 MiB. Install `@stll/anonymize-wasm` separately only when
you need the browser runtime.

## Benchmarks

The deterministic pipeline is evaluated against publicly available tools on
TAB-ECHR, RedactionBench, MEDDOCAN, MultiGraSCCo, and German Legal Entity
Recognition. Tracks use different task semantics, and synthetic scores are not
necessarily representative or directly comparable. Read the
[methodology](packages/benchmark/README.md), browse the [aggregate
results](packages/benchmark/results/), or follow the [reproduction
guide](packages/benchmark/REPRODUCING.md).

## Development

```bash
bun install --frozen-lockfile
bun run build
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run check:version
```

Read the [contributor guide](CONTRIBUTING.md) for prerequisites, focused checks,
architecture pointers, changesets, and the sensitive-fixture policy. A CLA
check runs on pull requests.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
