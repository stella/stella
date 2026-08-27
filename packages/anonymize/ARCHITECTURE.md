# @stll/anonymize Architecture

`@stll/anonymize` is Rust-native. The TypeScript and Python SDKs translate
types, load prepared packages, and call the same Rust core.

## Package Graph

- `crates/anonymize-core`: anonymization logic, detectors, resolution, redaction,
  diagnostics, and prepared artifact loading.
- `crates/anonymize-adapter-contract`: shared JSON/package contract used by
  host-language bindings.
- `crates/anonymize-binding-core`: runtime-neutral preparation, redaction,
  session, and serialization operations shared by host bindings.
- `crates/anonymize-napi`: Node.js binding.
- `crates/anonymize-py`: Python binding.
- `crates/anonymize-wasm`: single-thread browser WebAssembly binding.
- `crates/document-rules-core`: reusable structured-document model, rule
  kernels, direct batch engine, and optional incremental session cache.
- `packages/anonymize/src/native.ts`: binding-agnostic TypeScript SDK wrappers.
- `packages/anonymize/src/native-node.ts`: Node.js binding loader and default
  prepared-package loader.
- `packages/anonymize/src/native-pipeline.ts`: build-time/package-time adapter
  from TypeScript config/data files into the Rust prepared package contract.
- `packages/anonymize/src/create-pipeline.ts`: semantic language selection and
  exact-scope preparation shared by the Node and browser SDKs.

## Native Distribution

`@stll/anonymize` is the platform-neutral runtime package. Native Node binaries
ship through exact-version optional sidecars such as
`@stll/anonymize-darwin-arm64` and `@stll/anonymize-linux-x64-gnu`. The root
package must not publish a `.node` file; release publishes sidecars before the
root package so npm can resolve the optional dependency at install time.

Keep sidecar package names, package metadata, exact optional dependency pins,
and release matrix entries aligned through
`.github/tools/check-native-sidecars.mjs`.

## Runtime Flow

1. Build or load a `.stlanonpkg` prepared package.
2. Create a `PreparedNativePipeline` from package bytes.
3. Optionally call `warmLazyRegex()` during service startup.
4. Call `redactText()`, `redactTextJson()`, diagnostics, or stream helpers.

The default product path is `createPipeline({ language })` in TypeScript and
`create_pipeline(language=...)` in Python. The selector accepts one supported
language, an exact non-empty language list, or `"all"`. A matching bundled
prepared package is the fast path; otherwise the SDK assembles and caches the
exact requested scope from the shared dictionaries. Artifact availability is
not part of the semantic API and a narrower request never falls back to
all-language behavior. Lower-level prepared-package loaders remain available
for caller-owned artifacts and deployment control.

The browser distribution uses `wasm32-unknown-unknown` and wasm-bindgen. It has
ordinary unshared WebAssembly memory and does not depend on WASI, workers,
`SharedArrayBuffer`, or cross-origin isolation. Build and tarball checks enforce
a closed generated-asset set and explicit size ceilings. Node, Bun, and an
ordinary non-isolated browser execute the same binding parity manifest and
behavioral smokes.

## Runtime Surface Parity

`CAPABILITY_MANIFEST` is the public, versioned source of truth for runtime
parity. Each public capability belongs to a named profile whose runtime list is
an invariant:

- `core`: Node.js, Python, and browser/WASM byte-oriented SDK behavior.
- `local`: Node.js and Python filesystem behavior.
- `document`: Node.js and Python structure-aware document adapters.

Namespace-aware WordprocessingML scanning is owned by the versioned
`stella-docx-kernel` crate. `crates/anonymize-docx-core` owns the bounded OPC
inventory, anonymization coverage policy, stable rewrite locations, and
surgical package rewrite built on that scan. This boundary lets lean consumers
inflate selected XML parts without inheriting full-package or media ownership,
while rewrite consumers retain the complete inventory they need. Both the NAPI
and PyO3 adapters serialize the same Rust contract, including structural
locations, UTF-16 segment offsets, resource bounds, and fail-closed coverage.
The TypeScript extractor is retained only as a parity oracle while surgical
rewrite moves into the same core; it is not the production Node extraction
path.

The full surface-parity gate checks API availability for every runtime in the
profile. Behavioral suites then execute shared fixtures, normalized errors, and
cross-runtime artifacts such as encrypted sessions. Do not narrow a profile to
make a one-binding feature pass; either land the peer adapters together or keep
the pull request blocked until the profile is complete.

## Rust Core Flow

The Rust prepared engine is split by phase:

- `prepare_phase.rs`: validate config, load artifacts, build indexes/support data.
- `search_phase.rs`: run byte-safe search branches.
- `detection_phase.rs`: run the static detector registry.
- `resolution_phase.rs`: apply context, hotwords, merge, boundary, sanitize.
- `redaction_phase.rs`: build replacements and maps.
- `session_archive.rs`: seal and restore bounded authenticated session archives;
  callers own key custody and opaque-byte persistence.

Detector modules live under `crates/anonymize-core/src/prepared/detectors`.
Adding a detector should mean adding module-local rule metadata and detection
logic through `static_detector_rules!`; the registry only preserves module order.
The registry constructs a capability-scoped `StaticDetectorContext` for each
rule. Detectors cannot reach the whole engine, arbitrary search branches, or
undeclared prior layers: context and dependency accessors correspond to the
inputs declared in the rule metadata. This keeps cross-domain joins visible and
prevents a new detector from quietly coupling itself to every match or entity.
Detector modules receive domain operations such as `detect_regex`, not the
iterable match/entity storage behind those operations. Every rule also declares
the growing domains in which its work scales additively; construction fails
closed if that declaration omits, duplicates, or invents a growing input.
Prepared support resources are declared once in `support_resources.rs`; prepare
timing, detector input checks, and snapshots derive from that declaration where
the resource-specific data type still allows it.
The detector registry and support-resource contracts are snapshot-tested, so
changes to ids, stages, inputs, dependencies, and required prepared data produce
reviewable diffs.

### Execution Complexity

Resolution phases share lazy per-document analysis, and candidate-dense paths
use typed indexes. Any document-wide analysis needed by more than one phase
belongs on the request document and is built at most once, only when an enabled
phase needs it. Growing match and dependency collections remain private behind
the detector contract; detector modules receive domain operations instead of
iterable storage. Resolver indexes likewise keep their backing collections
private and expose bounded queries.

This is enforced with three complementary gates:

1. detector metadata declares every analysis resource it consumes;
2. indexed implementations are checked against straightforward reference
   models for exact behavioral equivalence;
3. dense synthetic scaling tests count structural work rather than asserting
   noisy wall-clock thresholds.

The cross-provider performance runner remains the release measurement. Its
`stella-full` profile must keep every default detector enabled; a faster narrow
profile does not satisfy the full-pipeline performance contract.

Candidate-dense paths have release-mode scaling contracts. CI runs every
ignored core test as one automatically discovered serial suite, so adding a
contract does not require editing a workflow allowlist. Wall time remains only
a secondary ceiling where retained.

## Structured Document Rules

`crates/document-rules-core` separates reusable rule execution from any file
format or host binding. Documents contain stable block identifiers, text, and
bounded neutral metadata. Findings use block-local spans and may refer to
related spans without flattening a document into one synthetic string.

Rules are Rust implementations collected in a `RuleSet`. Their `RuleSpec`
declares the execution scope; rule code receives only the corresponding block,
neighborhood, or document-facts context. Shared block analysis is computed once
and passed to every applicable rule. Rules do not rescan through binding-owned
callbacks or access process-global state.

There are two execution paths over the same kernels:

- `RuleEngine::analyze` is the direct batch path. It does not construct a Salsa
  database, and batch-only builds can disable the `incremental` feature to omit
  Salsa entirely.
- `IncrementalDocumentSession` stores stable per-block inputs in Salsa. Text
  edits invalidate that block, its bounded neighborhood, and derived document
  facts; structural edits update explicit order/link inputs. Revisioned patches
  validate completely before mutation.

Exact batch/incremental result parity and deterministic execution counters are
CI contracts. The counters prove bounded invalidation without relying on noisy
wall-clock thresholds. The crate also checks on `wasm32-unknown-unknown`, so a
consumer can compile a static rule set into an ordinary single-thread browser
module without changing its core rule implementations.

## Extension Rules

- Add vocabulary and language data in data files, organized by language and
  concept.
- Add detector behavior in Rust, with focused Rust tests.
- Keep TypeScript and Python wrappers thin; do not duplicate business logic in
  bindings.

## Review Checklist

- Does the change affect prepared package bytes, runtime execution, or both?
- Does the package remain loadable by Node and Python SDKs?
- Are TS/Python/Rust fixture outputs still aligned through native SDK tests?
- Are cold start, warm run, package load, prepare, and execution measured
  separately when performance changes?
- Does candidate processing use bounded indexed queries, with deterministic
  scaling coverage for dense inputs?
- Is raw input text kept out of logs and snapshots?
