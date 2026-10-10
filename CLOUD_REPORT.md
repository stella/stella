# Bun typecheck adoption

Bun 1.4.3 and @stll/oxlint-config 0.12.0 provide the repository checker and
shared diagnostic parity safeguard. Workspace and repository tooling commands
use `bun check --no-pretty --all --project=<config>`.

The root tsconfig has `files: []` and no references; checking it alone would
check no code. `bun run check:typecheck-parity` discovers all 76 explicit projects
from the actual typecheck scripts and invokes `stll-typecheck-parity` for each.
The checks job runs parity immediately after restoring generated inputs, before
other installed-dependency checks. It compares repository diagnostics and seeded
classes under each project's compiler flags. Astro retains its own checker;
TypeScript compiler APIs, declaration emitters, source-membership queries, and
native compiler performance measurements retain their existing drivers.

The shared base keeps `skipLibCheck: true`; project input scopes select repository
sources rather than dependency directories. Imported declaration files still
participate in type resolution. No diagnostic suppression is added.

## Evidence

- `bun run sync-ai` and `bun run sync-ai:check`: exit 0.
- Targeted template, workspace hygiene, affected-check planning tests: exit 0,
  156 tests and 398 assertions. Coverage guard self-test: exit 0.
- Compiler-option parser tests: exit 0, 4 tests and 7 assertions. This exercises
  the retained TypeScript compiler API and rejects misspelled compiler options.
- `bun --no-env-file dedupe --check`: exit 0, no duplicate dependency versions.
- `bun run check:typecheck-parity`: CI proof pending. The checks job publishes
  this report with its full output table as `typecheck-parity-report`.
- `bun run typecheck --filter=@stll/sha256 --only --force`: CI seeds a TS2322
  assignment error, requires a failing command and a matching diagnostic, removes
  the probe, and requires the clean command to succeed.
- Normal repository CI covers the complete workspace checks and retained compiler
  consumers. Wall time and maximum RSS for TypeScript and Bun will be copied from
  the parity log into the pull request after CI completes.

## Open questions

Diagnostic parity on the complete repository remains to be proven in CI. A
reported mismatch must retain the existing checker for the affected coverage
before this adoption can merge.
