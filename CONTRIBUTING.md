# Contributing

Thank you for contributing to stella anonymize. This repository handles
sensitive-text tooling, so contributions must preserve deterministic behavior,
clear data boundaries, and reproducible language data.

## Before you start

Install these prerequisites:

- Bun 1.4, pinned in `package.json`
- Node.js 22.18 or newer for the TypeScript-aware build configuration
- rustup; the repository installs Rust 1.96.0 and the
  `wasm32-unknown-unknown` target through `rust-toolchain.toml`
- `wasm-bindgen-cli` 0.2.126 for full builds and browser tests

Install the pinned WebAssembly tool with:

```bash
cargo install wasm-bindgen-cli --version 0.2.126 --locked
```

Python checks additionally require `uv`. The complete Rust suite uses
`cargo-nextest`; see `.github/actions/setup-rust-ci/action.yml` for the CI
tooling versions and profiles.

## Set up the repository

```bash
bun install --frozen-lockfile
bun run build
```

Build before running the complete test or Python surfaces. The first Rust build
can take several minutes.

Run the checks closest to the code you changed while iterating. Before opening
a pull request, run the applicable full gates:

```bash
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run check:version
```

For Rust changes, also run:

```bash
bun run rust:fmt
bun run rust:lint
bun run rust:test
```

The full `bun run rust:check` additionally runs the repository's Dylint rules
and requires the pinned nightly and Dylint tooling used by CI.

## Choose the right change location

Read `packages/anonymize/ARCHITECTURE.md` before changing the runtime graph,
prepared-package flow, or binding boundaries.

New detector behavior belongs in the Rust core, not in a binding:

1. Put language-dependent data under the matching language in `packages/data`.
2. Add detector behavior under `crates/anonymize-core/src` using the
   module-owned rule shape documented in `docs/rule-architecture.md`.
3. Add focused Rust coverage and runtime-parity coverage when public behavior
   changes.
4. Run the native readiness and scaling checks when package shape or runtime
   cost changes.

Trigger phrases live in
`packages/data/config/triggers.{language}.json`. Never resolve a collision in
one language by adding another language's vocabulary.

## Tests and fixtures

Test behavior that the type system, framework, or linter cannot prove. Prefer
invariants for offsets, replacement safety, deterministic output, and
cross-runtime parity.

Use minimal synthetic fixtures. Do not commit or paste personal data, customer
documents, repository secrets, or evaluation-only holdout examples. When
reporting a bug, reduce it to invented text that still reproduces the behavior.
Provenance for the existing Czech public-corpus fixtures is documented
[next to the fixtures](packages/anonymize/src/__test__/fixtures/contracts/cs/README.md).

Report suspected vulnerabilities privately according to `SECURITY.md`; do not
open a public issue for them.

## Preserve type information across boundaries

Validate each untrusted value once, at the boundary that receives it. The
validator or decoder must return a canonical domain type; internal callers must
not parse, cast, or reconstruct that value again.

- Parse JSON to `unknown`, then validate it. Repo-local Oxlint rules reject
  unchecked `JSON.parse` typing and double assertions in production code.
- Keep transport, persistence, domain, and public projection types distinct.
  Serialize only in the adapter that owns the wire format.
- Model mutually exclusive states with discriminated unions. Make companion
  maps total with `satisfies Record<Union, ...>`.
- When a runtime codec mirrors a public object type, use a total field map such
  as `RequiredFields<T>` and reject unknown fields. A new contract field must
  fail typecheck until its codec is updated.
- Convert validated parallel arrays and related optional fields into private
  row types or enums before hot-path execution.

When fixing a boundary bug, add the strongest applicable regression guard: a
compile-time negative fixture for invalid state construction, a property test
for a large input space, or a codec/parity invariant for wire data. Add an
Oxlint rule when the forbidden syntax is mechanically recognizable; include a
rule unit test and enable it in `oxlint.config.ts`. Keep any temporary migration
exception file-specific, documented, and removed with that file's migration.

## Pull requests

- Keep one coherent change per pull request.
- Add tests for behavior changes.
- Add a changeset with `bun run changeset` when a published runtime changes.
  Use `bun run changeset --empty` when the change intentionally needs no
  release; CI checks this decision.
- Follow Conventional Commits: `feat:`, `fix:`, `docs:`, or `chore:`.
- Complete the CLA check on the pull request.

Describe only public engineering context visible in the repository and diff.
