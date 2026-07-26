# Assemble parity fixtures (frozen oracles)

These fixtures are the permanent specification for the Rust static-search config
assembler (`crates/anonymize-adapter-contract/src/assemble`). Each case has:

- `<name>.input.json` — the `{ config, gazetteer }` inputs.
- `baseline-all-on.expected.json` — the one complete assembled
  `BindingPreparedSearchConfig` oracle.
- `<name>.expected.delta.json` — the structural delta from the baseline for
  every other fixture. Object changes set or remove individual fields; array
  changes copy unchanged baseline ranges and carry only new values. Tests
  reconstruct and compare the complete config.
- `manifest.json` — a per-fixture `packageDigest` (sha256 of the prepared
  package bytes), checked by `tests/assemble_digest.rs`.

The expected files were originally captured from the retired TypeScript
config-assembly layer. They remain **frozen oracles** during ordinary
development and CI; never regenerate them to hide an unexplained parity
failure.

An intentional oracle change requires an independent source and explicit
manual review. Never generate expected output or package digests from the Rust
assembler under test: doing so would let an implementation regression bless
itself. Do not restore a parallel TypeScript assembly implementation.
