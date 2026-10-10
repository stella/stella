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
- `bun run check:typecheck-parity`: exit 1 at `68a1fd6`; 71 repository projects
  passed and five reported the same Bun-only TS2502. Every active seeded class
  passed. The checks job published the complete table as `typecheck-parity-report`.
- `bun run typecheck --filter=@stll/sha256 --only --force`: CI verified that the
  seeded TS2322 fails and that the clean command succeeds after probe cleanup.
- Normal repository CI covers the complete workspace checks and retained compiler
  consumers. The timing comparison below was read from the same CI log.

## Diagnostic mismatch caught by parity

Bun 1.4.3 (`c6da4a4d3`) reports TS2502 at
`apps/api/src/handlers/case-law/ingestion/us-citation-annotations.ts:440` while
TypeScript accepts the same tree (exit 0). The original source was unchanged from
the main commit merged into this branch. This is a Bun false positive, rather
than a lost TypeScript diagnostic. The parity safeguard caught it before adoption
could merge, in five projects importing the annotation code.

The annotation in the narrowed table branch was:

```ts
const rows: typeof block.rows = [];
for (const [row, cells] of block.rows.entries()) {
  const annotatedCells: (typeof block.rows)[number] = [];
  // Cells are annotated, collected into annotatedCells, and pushed into rows.
}
```

Both arrays now name the existing `TableCell` type explicitly: `TableCell[][]`
and `TableCell[]`. This states the intended type directly, with unchanged runtime
behavior and no `any` or diagnostic suppression. All 76 projects remain on Bun.
CI must confirm restored parity on the final head; if Bun still differs, the five
importing projects must retain TypeScript coverage before merge.

## CI wall time and maximum RSS

Measurements from CI run [38067793749](https://github.com/stella/stella/actions/runs/38067793749)
on `68a1fd6`. Wall times below sum sequential repository comparisons; maximum RSS
is the highest single checker process, rather than a sum. Fixture timings remain
in the full output table.

| Projects                       | TypeScript wall | TypeScript max RSS |  Bun wall | Bun max RSS | Result                   |
| ------------------------------ | --------------: | -----------------: | --------: | ----------: | ------------------------ |
| All 76                         |       178.212 s |       11507860 KiB | 164.067 s | 2345492 KiB | Five Bun false positives |
| 71 initially matching projects |        33.960 s |        4768708 KiB |  20.101 s | 1097220 KiB | Parity passed            |

## Open questions

CI must verify the explicit table-cell annotations restore parity in all 76
projects and that the remaining CI fixes pass on the final head before merge.

## Full parity output

<details>
<summary>All repository comparisons and seeded diagnostic tables</summary>

```text
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  | apps/api/src/handlers/case-law/ingestion/us-citation-annotations.ts:440:2502 | FAIL
repository tsc: wall=20.794s maxRSS=5314808KiB exit=0
repository bun: wall=18.570s maxRSS=1899696KiB exit=1
Config group 1: apps/api/tsconfig.contracts.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.471s maxRSS=74416KiB
fixtures bun: wall=2.029s maxRSS=55156KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  | apps/api/src/handlers/case-law/ingestion/us-citation-annotations.ts:440:2502 | FAIL
repository tsc: wall=51.203s maxRSS=11507860KiB exit=0
repository bun: wall=73.161s maxRSS=2345492KiB exit=1
Config group 1: apps/api/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.458s maxRSS=73812KiB
fixtures bun: wall=2.039s maxRSS=55660KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=1.177s maxRSS=650752KiB exit=0
repository bun: wall=0.438s maxRSS=248092KiB exit=0
Config group 1: apps/api/tsconfig.mcp-apps.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.864s maxRSS=92868KiB
fixtures bun: wall=2.773s maxRSS=75888KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  | apps/api/src/handlers/case-law/ingestion/us-citation-annotations.ts:440:2502 | FAIL
repository tsc: wall=29.654s maxRSS=7263076KiB exit=0
repository bun: wall=23.973s maxRSS=1903940KiB exit=1
Config group 1: apps/api/tsconfig.scripts.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.494s maxRSS=73932KiB
fixtures bun: wall=2.055s maxRSS=55244KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.468s maxRSS=311448KiB exit=0
repository bun: wall=0.263s maxRSS=185352KiB exit=0
Config group 1: apps/api/tsconfig.visual-sandbox.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.924s maxRSS=93292KiB
fixtures bun: wall=2.761s maxRSS=75252KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=1.416s maxRSS=811728KiB exit=0
repository bun: wall=0.317s maxRSS=248284KiB exit=0
Config group 1: apps/collab/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.472s maxRSS=74472KiB
fixtures bun: wall=2.031s maxRSS=55376KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.812s maxRSS=521276KiB exit=0
repository bun: wall=0.397s maxRSS=225280KiB exit=0
Config group 1: apps/desktop/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.050s maxRSS=52944KiB
fixtures bun: wall=1.572s maxRSS=50976KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.567s maxRSS=398472KiB exit=0
repository bun: wall=0.255s maxRSS=190740KiB exit=0
Config group 1: apps/desktop/tsconfig.test.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.913s maxRSS=93032KiB
fixtures bun: wall=2.767s maxRSS=75884KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.362s maxRSS=260824KiB exit=0
repository bun: wall=0.202s maxRSS=154836KiB exit=0
Config group 1: apps/extension/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=3.046s maxRSS=101352KiB
fixtures bun: wall=3.073s maxRSS=78976KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  | apps/api/src/handlers/case-law/ingestion/us-citation-annotations.ts:440:2502 | FAIL
repository tsc: wall=20.030s maxRSS=5566084KiB exit=0
repository bun: wall=15.535s maxRSS=2004308KiB exit=1
Config group 1: apps/legal-atlas-runner/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.467s maxRSS=74108KiB
fixtures bun: wall=2.019s maxRSS=55416KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.144s maxRSS=112732KiB exit=0
repository bun: wall=0.087s maxRSS=98440KiB exit=0
Config group 1: apps/mobile/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript (inactive under this config: input.js requires allowJs) | | | INACTIVE
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=1.974s maxRSS=52772KiB
fixtures bun: wall=1.432s maxRSS=49608KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.098s maxRSS=83000KiB exit=0
repository bun: wall=0.049s maxRSS=65420KiB exit=0
Config group 1: apps/mobile/tsconfig.scripts.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.424s maxRSS=74440KiB
fixtures bun: wall=2.028s maxRSS=55376KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.368s maxRSS=337976KiB exit=0
repository bun: wall=0.228s maxRSS=194624KiB exit=0
Config group 1: apps/playground/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.075s maxRSS=53016KiB
fixtures bun: wall=1.602s maxRSS=50984KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.263s maxRSS=218712KiB exit=0
repository bun: wall=0.133s maxRSS=135712KiB exit=0
Config group 1: apps/visual-preview/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.889s maxRSS=93104KiB
fixtures bun: wall=2.772s maxRSS=76020KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.702s maxRSS=457452KiB exit=0
repository bun: wall=0.330s maxRSS=211876KiB exit=0
Config group 1: apps/web/e2e/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.244s maxRSS=64172KiB
fixtures bun: wall=1.884s maxRSS=51884KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.280s maxRSS=238140KiB exit=0
repository bun: wall=0.167s maxRSS=156804KiB exit=0
Config group 1: apps/web/e2e/unit/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.467s maxRSS=74496KiB
fixtures bun: wall=2.059s maxRSS=55936KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=11.861s maxRSS=4768708KiB exit=0
repository bun: wall=8.717s maxRSS=1097220KiB exit=0
Config group 1: apps/web/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import (inactive under this config) |  |  | INACTIVE
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.897s maxRSS=93248KiB
fixtures bun: wall=2.941s maxRSS=77984KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.177s maxRSS=131688KiB exit=0
repository bun: wall=0.108s maxRSS=91800KiB exit=0
Config group 1: packages/agent-engine/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.470s maxRSS=74056KiB
fixtures bun: wall=2.019s maxRSS=54908KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.262s maxRSS=192200KiB exit=0
repository bun: wall=0.158s maxRSS=126240KiB exit=0
Config group 1: packages/agent-input/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.462s maxRSS=74196KiB
fixtures bun: wall=2.024s maxRSS=55156KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.485s maxRSS=413996KiB exit=0
repository bun: wall=0.400s maxRSS=244028KiB exit=0
Config group 1: packages/ai-catalog/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.492s maxRSS=74772KiB
fixtures bun: wall=2.027s maxRSS=54900KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.096s maxRSS=78864KiB exit=0
repository bun: wall=0.044s maxRSS=62992KiB exit=0
Config group 1: packages/analytics-config/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.465s maxRSS=73940KiB
fixtures bun: wall=2.029s maxRSS=54984KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.156s maxRSS=139412KiB exit=0
repository bun: wall=0.099s maxRSS=102560KiB exit=0
Config group 1: packages/anonymize-chat/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.483s maxRSS=74324KiB
fixtures bun: wall=2.043s maxRSS=54900KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.148s maxRSS=125116KiB exit=0
repository bun: wall=0.081s maxRSS=100768KiB exit=0
Config group 1: packages/api-client/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.904s maxRSS=93308KiB
fixtures bun: wall=2.787s maxRSS=75136KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.487s maxRSS=296568KiB exit=0
repository bun: wall=0.205s maxRSS=126840KiB exit=0
Config group 1: packages/api-contract/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.493s maxRSS=74408KiB
fixtures bun: wall=2.030s maxRSS=54900KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.227s maxRSS=192388KiB exit=0
repository bun: wall=0.132s maxRSS=124276KiB exit=0
Config group 1: packages/auth-model/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.487s maxRSS=74080KiB
fixtures bun: wall=2.028s maxRSS=55156KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.142s maxRSS=114960KiB exit=0
repository bun: wall=0.077s maxRSS=97008KiB exit=0
Config group 1: packages/boe/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript (inactive under this config: input.js requires allowJs) | | | INACTIVE
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.786s maxRSS=93252KiB
fixtures bun: wall=2.665s maxRSS=75828KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.349s maxRSS=240972KiB exit=0
repository bun: wall=0.156s maxRSS=119832KiB exit=0
Config group 1: packages/business-registries/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript (inactive under this config: input.js requires allowJs) | | | INACTIVE
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.837s maxRSS=93224KiB
fixtures bun: wall=2.673s maxRSS=76784KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.149s maxRSS=122648KiB exit=0
repository bun: wall=0.082s maxRSS=93208KiB exit=0
Config group 1: packages/calculations/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.466s maxRSS=74296KiB
fixtures bun: wall=2.028s maxRSS=55036KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.228s maxRSS=156588KiB exit=0
repository bun: wall=0.116s maxRSS=101360KiB exit=0
Config group 1: packages/catalogue/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.483s maxRSS=74792KiB
fixtures bun: wall=2.024s maxRSS=55248KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.084s maxRSS=78296KiB exit=0
repository bun: wall=0.043s maxRSS=61428KiB exit=0
Config group 1: packages/chat-limits/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.466s maxRSS=74296KiB
fixtures bun: wall=2.010s maxRSS=54772KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.304s maxRSS=247772KiB exit=0
repository bun: wall=0.163s maxRSS=160616KiB exit=0
Config group 1: packages/chat/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.905s maxRSS=93020KiB
fixtures bun: wall=2.764s maxRSS=75856KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.563s maxRSS=368432KiB exit=0
repository bun: wall=0.264s maxRSS=150624KiB exit=0
Config group 1: packages/cli/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript (inactive under this config: input.js requires allowJs) | | | INACTIVE
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.368s maxRSS=74412KiB
fixtures bun: wall=1.965s maxRSS=55120KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.111s maxRSS=105784KiB exit=0
repository bun: wall=0.064s maxRSS=86896KiB exit=0
Config group 1: packages/clipboard/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.917s maxRSS=93336KiB
fixtures bun: wall=2.783s maxRSS=75724KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.091s maxRSS=78532KiB exit=0
repository bun: wall=0.044s maxRSS=63712KiB exit=0
Config group 1: packages/collation/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.438s maxRSS=74088KiB
fixtures bun: wall=2.016s maxRSS=55028KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.125s maxRSS=102216KiB exit=0
repository bun: wall=0.066s maxRSS=77720KiB exit=0
Config group 1: packages/concurrency/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.449s maxRSS=74352KiB
fixtures bun: wall=2.026s maxRSS=55244KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.179s maxRSS=154524KiB exit=0
repository bun: wall=0.099s maxRSS=105188KiB exit=0
Config group 1: packages/conditions/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.436s maxRSS=74272KiB
fixtures bun: wall=2.016s maxRSS=54900KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.107s maxRSS=94064KiB exit=0
repository bun: wall=0.050s maxRSS=67184KiB exit=0
Config group 1: packages/country-codes/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript (inactive under this config: input.js requires allowJs) | | | INACTIVE
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.405s maxRSS=74404KiB
fixtures bun: wall=1.949s maxRSS=54900KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.142s maxRSS=114448KiB exit=0
repository bun: wall=0.076s maxRSS=81648KiB exit=0
Config group 1: packages/db-load-gate/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.459s maxRSS=74248KiB
fixtures bun: wall=2.028s maxRSS=55040KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.564s maxRSS=408880KiB exit=0
repository bun: wall=0.250s maxRSS=199568KiB exit=0
Config group 1: packages/decision-reader/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.905s maxRSS=93436KiB
fixtures bun: wall=2.741s maxRSS=76240KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.156s maxRSS=139692KiB exit=0
repository bun: wall=0.102s maxRSS=99652KiB exit=0
Config group 1: packages/docx-utils/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.460s maxRSS=74256KiB
fixtures bun: wall=2.019s maxRSS=55284KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.098s maxRSS=85156KiB exit=0
repository bun: wall=0.048s maxRSS=65636KiB exit=0
Config group 1: packages/errors/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.467s maxRSS=74424KiB
fixtures bun: wall=2.050s maxRSS=55412KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.132s maxRSS=118548KiB exit=0
repository bun: wall=0.076s maxRSS=97288KiB exit=0
Config group 1: packages/fetch/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.908s maxRSS=92900KiB
fixtures bun: wall=2.768s maxRSS=76112KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.163s maxRSS=133824KiB exit=0
repository bun: wall=0.091s maxRSS=102804KiB exit=0
Config group 1: packages/infosoud/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript (inactive under this config: input.js requires allowJs) | | | INACTIVE
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.787s maxRSS=93116KiB
fixtures bun: wall=2.655s maxRSS=75628KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.116s maxRSS=101884KiB exit=0
repository bun: wall=0.071s maxRSS=78740KiB exit=0
Config group 1: packages/invoicing/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.467s maxRSS=74252KiB
fixtures bun: wall=2.020s maxRSS=55032KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.211s maxRSS=150036KiB exit=0
repository bun: wall=0.129s maxRSS=104248KiB exit=0
Config group 1: packages/legal-ast/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.481s maxRSS=74264KiB
fixtures bun: wall=2.028s maxRSS=55116KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.243s maxRSS=177564KiB exit=0
repository bun: wall=0.139s maxRSS=110544KiB exit=0
Config group 1: packages/legal-atlas/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.443s maxRSS=74460KiB
fixtures bun: wall=2.019s maxRSS=54864KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.101s maxRSS=87768KiB exit=0
repository bun: wall=0.051s maxRSS=69896KiB exit=0
Config group 1: packages/locales/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript (inactive under this config: input.js requires allowJs) | | | INACTIVE
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.388s maxRSS=74176KiB
fixtures bun: wall=1.970s maxRSS=55284KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.237s maxRSS=181600KiB exit=0
repository bun: wall=0.149s maxRSS=122796KiB exit=0
Config group 1: packages/mcp-kit/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.494s maxRSS=74432KiB
fixtures bun: wall=2.022s maxRSS=55120KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.161s maxRSS=116716KiB exit=0
repository bun: wall=0.085s maxRSS=84488KiB exit=0
Config group 1: packages/mojibake/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.435s maxRSS=74412KiB
fixtures bun: wall=2.018s maxRSS=55156KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.125s maxRSS=110688KiB exit=0
repository bun: wall=0.069s maxRSS=86728KiB exit=0
Config group 1: packages/money/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.449s maxRSS=74492KiB
fixtures bun: wall=2.025s maxRSS=55120KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.222s maxRSS=167316KiB exit=0
repository bun: wall=0.120s maxRSS=108184KiB exit=0
Config group 1: packages/permissions/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.445s maxRSS=74352KiB
fixtures bun: wall=2.013s maxRSS=55028KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.138s maxRSS=118760KiB exit=0
repository bun: wall=0.086s maxRSS=89496KiB exit=0
Config group 1: packages/property-testing/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.434s maxRSS=74288KiB
fixtures bun: wall=2.022s maxRSS=55024KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.121s maxRSS=104140KiB exit=0
repository bun: wall=0.074s maxRSS=82416KiB exit=0
Config group 1: packages/redis-config/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.454s maxRSS=74080KiB
fixtures bun: wall=2.013s maxRSS=54732KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.112s maxRSS=89608KiB exit=0
repository bun: wall=0.052s maxRSS=68360KiB exit=0
Config group 1: packages/runtime-mode/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.452s maxRSS=74316KiB
fixtures bun: wall=2.024s maxRSS=55120KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.224s maxRSS=156632KiB exit=0
repository bun: wall=0.145s maxRSS=109640KiB exit=0
Config group 1: packages/sanctions/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.437s maxRSS=74096KiB
fixtures bun: wall=2.024s maxRSS=55156KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.621s maxRSS=389076KiB exit=0
repository bun: wall=0.288s maxRSS=164876KiB exit=0
Config group 1: packages/scripts/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.454s maxRSS=74456KiB
fixtures bun: wall=2.024s maxRSS=55276KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.113s maxRSS=103588KiB exit=0
repository bun: wall=0.064s maxRSS=85360KiB exit=0
Config group 1: packages/sha256/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.919s maxRSS=93136KiB
fixtures bun: wall=2.792s maxRSS=76420KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.147s maxRSS=100228KiB exit=0
repository bun: wall=0.067s maxRSS=79616KiB exit=0
Config group 1: packages/skills/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.444s maxRSS=74108KiB
fixtures bun: wall=2.025s maxRSS=55416KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.144s maxRSS=126900KiB exit=0
repository bun: wall=0.075s maxRSS=103616KiB exit=0
Config group 1: packages/ssr-kit/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.961s maxRSS=93156KiB
fixtures bun: wall=2.798s maxRSS=75508KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.120s maxRSS=106236KiB exit=0
repository bun: wall=0.065s maxRSS=84756KiB exit=0
Config group 1: packages/ssr-testkit/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.494s maxRSS=74632KiB
fixtures bun: wall=2.039s maxRSS=55112KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.135s maxRSS=92236KiB exit=0
repository bun: wall=0.068s maxRSS=76900KiB exit=0
Config group 1: packages/stable-stringify/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript (inactive under this config: input.js requires allowJs) | | | INACTIVE
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.362s maxRSS=74428KiB
fixtures bun: wall=1.956s maxRSS=55044KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.158s maxRSS=137404KiB exit=0
repository bun: wall=0.087s maxRSS=109628KiB exit=0
Config group 1: packages/start-runtime/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.861s maxRSS=94628KiB
fixtures bun: wall=2.767s maxRSS=75380KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.211s maxRSS=173336KiB exit=0
repository bun: wall=0.129s maxRSS=117804KiB exit=0
Config group 1: packages/template-conditions/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.464s maxRSS=74608KiB
fixtures bun: wall=2.028s maxRSS=55028KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.134s maxRSS=118348KiB exit=0
repository bun: wall=0.086s maxRSS=93732KiB exit=0
Config group 1: packages/template-packs/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.464s maxRSS=74504KiB
fixtures bun: wall=2.013s maxRSS=54736KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.272s maxRSS=96604KiB exit=0
repository bun: wall=0.061s maxRSS=71568KiB exit=0
Config group 1: packages/text-normalize/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript (inactive under this config: input.js requires allowJs) | | | INACTIVE
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.392s maxRSS=74392KiB
fixtures bun: wall=1.971s maxRSS=55028KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.166s maxRSS=98224KiB exit=0
repository bun: wall=0.068s maxRSS=79072KiB exit=0
Config group 1: packages/time/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript (inactive under this config: input.js requires allowJs) | | | INACTIVE
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.384s maxRSS=74640KiB
fixtures bun: wall=1.962s maxRSS=55284KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.221s maxRSS=185228KiB exit=0
repository bun: wall=0.109s maxRSS=120944KiB exit=0
Config group 1: packages/transactional/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.946s maxRSS=93120KiB
fixtures bun: wall=2.757s maxRSS=76872KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.093s maxRSS=78860KiB exit=0
repository bun: wall=0.043s maxRSS=62664KiB exit=0
Config group 1: packages/typescript-config/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.461s maxRSS=74400KiB
fixtures bun: wall=2.022s maxRSS=54908KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=1.209s maxRSS=668516KiB exit=0
repository bun: wall=0.479s maxRSS=262976KiB exit=0
Config group 1: packages/ui/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.902s maxRSS=93048KiB
fixtures bun: wall=2.767s maxRSS=75636KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.092s maxRSS=78732KiB exit=0
repository bun: wall=0.044s maxRSS=63256KiB exit=0
Config group 1: packages/user-agent/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.469s maxRSS=74384KiB
fixtures bun: wall=2.023s maxRSS=55408KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.120s maxRSS=102128KiB exit=0
repository bun: wall=0.064s maxRSS=81328KiB exit=0
Config group 1: packages/uuid-codec/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.463s maxRSS=74392KiB
fixtures bun: wall=2.036s maxRSS=55168KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.176s maxRSS=143936KiB exit=0
repository bun: wall=0.092s maxRSS=104644KiB exit=0
Config group 1: packages/workspace-model/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.454s maxRSS=74592KiB
fixtures bun: wall=2.018s maxRSS=55284KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.754s maxRSS=487916KiB exit=0
repository bun: wall=0.331s maxRSS=236076KiB exit=0
Config group 1: packages/workspace-ui/tsconfig.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.902s maxRSS=93156KiB
fixtures bun: wall=2.726s maxRSS=75600KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=2.262s maxRSS=730916KiB exit=0
repository bun: wall=1.763s maxRSS=221736KiB exit=0
Config group 1: tsconfig.oxlint-plugins.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any (inactive under this config) |  |  | INACTIVE
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property (inactive under this config) |  |  | INACTIVE
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.425s maxRSS=74504KiB
fixtures bun: wall=2.019s maxRSS=55168KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  | apps/api/src/handlers/case-law/ingestion/us-citation-annotations.ts:440:2502 | FAIL
repository tsc: wall=22.571s maxRSS=6584404KiB exit=0
repository bun: wall=12.727s maxRSS=989012KiB exit=1
Config group 1: tsconfig.scripts.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.484s maxRSS=74040KiB
fixtures bun: wall=2.035s maxRSS=55284KiB
Class | TypeScript diagnostics | Bun diagnostics | Result
repository |  |  | PASS
repository tsc: wall=0.558s maxRSS=328832KiB exit=0
repository bun: wall=0.271s maxRSS=180092KiB exit=0
Config group 1: tsconfig.tooling.json (1 projects)
module-detection | 6133 | 6133 | PASS
skip-declaration-check (inactive under this config) |  |  | INACTIVE
json-import (inactive under this config) |  |  | INACTIVE
interop-import (inactive under this config) |  |  | INACTIVE
valid-control (inactive under this config) |  |  | INACTIVE
type-mismatch | 2322 | 2322 | PASS
missing-property | 2741 | 2741 | PASS
strict-null | 2322 | 2322 | PASS
unchecked-index | 2322 | 2322 | PASS
unused-local | 6133 | 6133 | PASS
unused-parameter | 6133 | 6133 | PASS
implicit-any | 7006 | 7006 | PASS
missing-import | 2307 | 2307 | PASS
side-effect-import | 2882 | 2882 | PASS
generic-constraint | 2344 | 2344 | PASS
exact-optional | 2375 | 2375 | PASS
fallthrough | 7029 | 7029 | PASS
implicit-override | 4114 | 4114 | PASS
implicit-return | 7030 | 7030 | PASS
unknown-catch | 18046 | 18046 | PASS
index-property | 4111 | 4111 | PASS
erasable-syntax | 1294 | 1294 | PASS
type-only-import | 1484 | 1484 | PASS
checked-javascript | 2322 | 2322 | PASS
strict-function | 2322 | 2322 | PASS
strict-initialization | 2564 | 2564 | PASS
strict-bind | 2345 | 2345 | PASS
implicit-this | 2683 | 2683 | PASS
strict-iterator | 2322 | 2322 | PASS
always-strict | 1215 | 1215 | PASS
file-casing | 1149 | 1149 | PASS
fixtures tsc: wall=2.449s maxRSS=74136KiB
fixtures bun: wall=2.026s maxRSS=55404KiB
```

</details>
