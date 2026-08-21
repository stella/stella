# Contributing

Start with the repository-wide [contributor guide](../../CONTRIBUTING.md). It
covers prerequisites, setup, quality gates, changesets, and the policy for
sensitive fixtures.

## Adding a new detector

New detector behavior belongs in the Rust core. Do not add product detector
logic to `src/detectors/*.ts` or wire new behavior through `src/pipeline.ts`.

1. Add or update language/concept data under `packages/data` when the rule is
   data-driven.
2. Add the Rust detector or support logic under `crates/anonymize-core/src`.
3. Register detector modules through the module-owned `static_detector_rules!`
   shape described in `../../docs/rule-architecture.md`.
4. Add focused Rust tests and, when SDK behavior changes, TS/Python native
   parity coverage.
5. Run the native readiness/perf checks when package shape or runtime cost
   changes.

## Adding trigger phrases

Edit `config/triggers.{lang}.json` in the
@stll/anonymize-data package.
