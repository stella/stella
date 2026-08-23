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

## Refreshing after an intentional data change

1. Edit the canonical data under `packages/data/config/` (or the assembler)
   and mirror the change by hand into `baseline-all-on.expected.json`; the JSON
   data change is the independent source that justifies the new oracle.
2. Refresh the derived delta snapshots. The updater first requires exact
   parity with the hand-reviewed baseline and refuses to rewrite that baseline.
   It rebuilds every derived delta directly from that baseline and the newly
   assembled config, so an obsolete delta cannot block a baseline shape change.
   Existing `remove` operations remain the independent oracle for intentional
   omissions, because Rust DTO serialization otherwise writes their defaults
   as `null`, `[]`, or `{}`:

   ```bash
   ANONYMIZE_UPDATE_ASSEMBLE_SNAPSHOTS=1 cargo nextest run -p stella-anonymize-core --test assemble_parity
   ```

   Review every changed `*.expected.delta.json`; the updater deliberately does
   not make an assembler behavior change correct merely by recording it.

3. Run `cargo nextest run -p stella-anonymize-core --test assemble_parity`
   without the update flag to verify the frozen snapshots.
4. Rewrite the `packageDigest` values in `manifest.json` from the frozen
   oracles, then run `bun run format` and commit the fixture, manifest, and
   data change together:

   ```bash
   ANONYMIZE_UPDATE_ASSEMBLE_MANIFEST=1 cargo nextest run -p stella-anonymize-core --test assemble_digest
   ```
