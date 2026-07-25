## Repository Specifics

This is a Bun-first TypeScript monorepo for text anonymization. The library handles sensitive text, so privacy, deterministic behavior, and clear data boundaries matter.

### Commands

- `bun install`
- `bun run lint`
- `bun run format:check`
- `bun run typecheck`
- `bun run test`
- `bun run build`
- `bun run check:version`

### Working Rules

- Do not log raw input text, extracted entities, or full anonymization fixtures unless the fixture is intentionally public and minimal.
- Keep dictionary and data changes reproducible and easy to diff.
- Keep every language-dependent vocabulary and ambiguity rule in per-language
  data. Never solve a collision in one language by hard-coding or unioning
  words from other languages; tests must prove that enabling one language does
  not change another language's behavior.
- Cross-language domain concepts must ship with a supported-language coverage
  matrix or an explicit scope rationale; never add vocabulary only for the
  language exposed by a benchmark.
- Favor invariant tests around redaction stability, offsets, and replacement safety over snapshot-only examples.
- Start architecture reviews from `packages/anonymize/ARCHITECTURE.md`; it
  explains the native package graph, prepared-package flow, and TypeScript
  parity-oracle boundary.
- Keep prepared-package schema versions about payload schema only. Encode
  orthogonal wire choices such as compression with explicit tagged fields;
  never consume schema versions to distinguish codecs or digest strategy.
- Prefer a clean fail-closed format break over compatibility branches for
  unreleased prepared-package formats. Persisted packages are build artifacts
  and must be rebuilt after a wire-format break.

### Runtime Surface Parity

- Prepared-config parity means exact structural equality with the canonical
  TypeScript fixture. Never compare a hand-picked field subset or deserialize
  the oracle through a lossy DTO; all reachable DTO objects must reject unknown
  members while explicitly open language-keyed maps remain open.
- Treat runtime parity as a public contract, not only as fixture-output
  equivalence. Every public capability must belong to a named parity profile,
  and CI must execute it through every runtime in that profile.
- A capability added to only one binding must fail the full surface-parity gate
  until its peer bindings land. Do not add permanent expected-missing allowlists.
- Put inherently platform-specific capabilities in an explicit narrower profile
  with a documented boundary; do not hide runtime gaps in individual tests.
- Keep API availability, normalized behavior and errors, and cross-runtime
  artifacts such as encrypted sessions under parity tests where they apply.

### Blind Evaluation Data

- Treat third-party holdout splits in
  `packages/benchmark/src/suite/registry.ts` as evaluation-only data. Never use
  their text, annotations, categories, per-document scores, or failure examples
  to add rules, tune thresholds, select models, or otherwise change detector
  behavior. Only entries explicitly marked `development` may guide iteration.
- Preserve each registered task's native semantics (span, contextual, or
  subject inference). Do not combine incompatible metrics into a synthetic
  suite-wide score, and report unsupported tasks as unsupported rather than
  zero.
- Holdout reports may contain aggregate metrics only. Keep document-level
  predictions and failure analysis local and uncommitted.
- Detector improvements must be justified and tested with the repository's
  synthetic development fixtures or an independently designated training split
  before the holdout is run. A holdout regression may reject a release; it must
  not become a tuning loop.

### Native Detector Shape

Rust static detectors should follow the module-owned rule shape. A detector
module declares its metadata and hooks in one `static_detector_rules!` block,
then keeps the activation predicate and detection implementation next to it:

```rust
static_detector_rules! {
  pub(in crate::prepared) const RULES;
  EXAMPLE_RULE {
    id: DetectorId::Example;
    stage: DiagnosticStage::EntityExample;
    inputs: &[DetectorInput::FullText];
    scales: &[DetectorInput::FullText];
    uses: &[SupportResource::Example];
    active: example_is_active;
    detect: detect_example;
  }
}
```

The central detector registry should only list detector modules and preserve
cross-module execution order. Avoid adding detector-specific branching,
diagnostic-stage mapping, or activation logic outside the detector module.
Brand-new detector concepts may still require adding a detector id, input, or
support resource, but the rule metadata and behavior stay module-local.

### Runtime Complexity

- Treat asymptotic work as part of the runtime contract. Detector and resolver
  code must not scan every entity, match, rule, or hit for each candidate;
  build a typed index once and expose only the bounded query needed by callers.
- Reuse the request's lazy document analysis for offsets, tokens, lines,
  boundaries, and normalized views. Do not build an independent full-text map
  or rescan the document in each detector when a shared analysis resource can
  own that work.
- Keep index storage private. Hot-path callers receive query APIs, not backing
  slices or maps that make an accidental fallback to full iteration possible.
- Transfer ownership of the entity buffer between resolution stages. A stage
  must consume and return the buffer; do not accept a growing entity slice and
  clone it, concatenate entity vectors, or retain a borrowed backing slice in
  an index. Build compact owned indexes before consuming the buffer.
- Prove indexed implementations equivalent to a simple reference model with
  generated fixtures. Add deterministic operation-count or structural scaling
  tests for dense inputs; wall-clock benchmarks are evidence, not the CI
  correctness gate.
- A performance optimization must preserve exact resolved output and report
  cold preparation, warm execution, and the affected diagnostic stages
  separately. Disabling detectors or narrowing the full-pipeline profile is not
  an optimization.
- Detector code must use `StaticDetectorContext` capability operations.
  Declare every input and dependency in the rule block so undeclared ambient
  access fails closed in every build.
- Detector modules receive capability operations, never iterable match or
  dependency collections. Keep raw growing-domain storage private to the
  detector contract. The mandatory `scales` declaration must list every
  growing input exactly once; it describes additive work, never permission to
  multiply those domains with a nested scan.
- Mark release-mode scaling contracts ignored in the ordinary test suite. CI
  discovers and runs the complete ignored core set automatically; never add a
  manually maintained workflow allowlist.

## Cursor Cloud specific instructions

The VM snapshot already provides Bun 1.3.14, Node 22 (via nvm, set as the
default alias), and the pinned Rust 1.96.0 toolchain with the
`wasm32-unknown-unknown` target. The startup update script only runs
`bun install`; standard commands are in [Repository Specifics](#repository-specifics) above and in
`package.json` scripts. Non-obvious caveats:

- **Node version matters for the build.** `bun run build` invokes `tsdown`,
  whose config loader needs a Node with native TypeScript support
  (`process.features.typescript`), i.e. Node >= 22.18. The default nvm Node 22
  satisfies this; on an older Node 22.x the data/CLI build fails with
  `Failed to import module "unrun"`. If a fresh shell resolves an older node,
  run `nvm use default`.
- **WASM binding smoke tests cover Node, Bun, and browsers.** The generated
  wasm-bindgen module uses ordinary single-thread memory. Run
  `smoke:wasm-runtimes` after loader changes; run
  `smoke:wasm-browser` to prove the ordinary non-isolated browser path. The
  generator requires exactly wasm-bindgen CLI 0.2.126. Keep the shared runtime
  artifact policy enforced during both dist assembly and tarball validation;
  do not bypass its size ceilings or closed `dist/native/` file set.
- **Build before test / Python.** `bun run build` generates the `.stlanonpkg`
  prepared packages the SDKs, CLI, and Python crate consume. Turbo wires
  `^build` for `test`/`typecheck`, but the Python surface needs a completed
  `bun run build` first. The first Rust core build takes a few minutes.
- **Rust test tooling is not preinstalled.** `cargo ci-fmt` and `cargo ci-clippy`
  run on the pinned stable toolchain, but `cargo ci-test` (and so
  `bun run rust:test`) runs the suite through `cargo-nextest`; install it with
  `cargo install cargo-nextest --locked` or the prebuilt binary from
  `get.nexte.st` (CI installs the pinned prebuilt). Doctests run separately via
  `cargo ci-test-doc` on stock cargo. `bun run rust:check` also runs
  `cargo ci-dylint`, which needs `nightly-2026-04-16` plus
  `cargo-dylint`/`dylint-link` 6.0.1 (see `.github/workflows/ci.yml`). Install
  the dylint tooling only when changing Rust lints.
- **Python surface is optional** and needs `uv` (not preinstalled);
  `python:typecheck`/`python:wheel` and the Python parity tests are skipped
  without it.
