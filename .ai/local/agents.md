## Product Vocabulary

- "matter" is the user- and agent-facing name of the client-engagement
  container: CLI flags, MCP tool inputs, capability ids, help text, and product
  copy. "workspace" is the internal identifier for the same thing (DB schema,
  TypeScript, HTTP routes) and the product-category word ("an open-source legal
  workspace"). Where the two meet, rename at the boundary, once.

## Project Overview

**Monorepo:** runnable services and clients live in `apps/` (`api`, `web`, desktop,
mobile, landing, collaboration, playground, and focused runners); shared or
publishable code lives in `packages/`. Use Glob/Grep to explore.

## Convention Routing

Before changing a convention-governed domain, read and apply the matching
`.agents/skills/conventions-*/SKILL.md`. This includes AI, databases, i18n and
user-facing strings, ingestion, MCP tools and CLI capabilities (agent-facing
schemas, errors, and reference resources), performance guard failures and hot
paths, architecture and scale, auth and data access, files and external APIs,
tests, `apps/web` React effects, and user-facing UI. The skills own the detailed
rules.

## Implementation Quality

- Comments explain a non-obvious invariant, trade-off, safety constraint, or why
  the code exists. Do not narrate the next statement, add empty documentation
  blocks, or label closing braces.
- Search before you write. Before adding a helper, module, schema, or validation
  step, check `docs/module-ownership.md` and `packages/*` for the capability.
  Extend the owner; if a second implementation is right, say why in the PR.
- Make abstractions earn their keep. Avoid pass-through wrappers, single-use
  helpers, and interfaces with one implementation unless they establish a real
  ownership boundary, contract, or test seam.
- Prefer deleting concepts, branches, and layers over moving complexity around.
  Keep feature-specific behavior at its canonical owner; do not scatter flags and
  special cases through shared flows.
- Defensive code belongs at real trust and failure boundaries. Do not add null
  checks, silent fallbacks, or catch-and-log blocks for states already excluded by
  types, validation, or framework guarantees.
- No forward-compatibility placeholders: never ship a flag, option, field, or
  export that is accepted but has no effect "for later" (a `--keychain` that
  always falls back, a `setDefault` helper nothing calls). Add it in the PR that
  wires it end to end. Dead-export checks (knip) enforce this where a package is
  enrolled; enroll new packages.

## Workspace Layout

- `apps/*` contains runnable applications only.
- `packages/*` contains shared or publishable packages only.
- Every direct child of `apps/` and `packages/` must be a workspace package named
  `@stll/<directory>`.
- Use scoped workspace filters in commands, for example
  `bun --filter @stll/web dev`.
- Create a package with `bun run new-package <name> --description "…"`; copying a
  helper between apps is not an option when a package can own it.

## Finding Things

- Stored data: `rg <word> apps/api/src/db/schema-index`, generated from the
  schema with one line per column (`file:line` and comment included).
- Owners: `bun scripts/ownership.ts --print` lists the module that owns each
  capability; extend it rather than adding a second one.
- Custom lint rules: the catalogue in `.oxlint-plugins/README.md`, one line per
  rule. Read the rules for the area before writing code in it.

## Commands

`bun run dev` | `dev:web` (3000) | `dev:api` (3001) |
`build` | `lint` | `format` | `typecheck` | `test`

To see a change working, `bun run agent:up` starts this checkout's own
seeded, signed-in stack; `agent:cli` and `agent:drive` exercise it and
write evidence, and `agent:attach` is this repository's attach command for
pull request screenshots. See the `dev` skill.

Database deployments use committed migrations via
`bun --filter @stll/api db:migrate`; `db:push` is local schema sync only.

CI autofix formats changed files outside `.github/workflows/`, applies safe
lint fixes, and regenerates selected outputs on same-repository pull requests.
There, local formatting and generator runs are optional, except that workflow
files must be formatted locally. Fork pull requests get no autofix: run
`bun run autofix` (the same generators, lint fixes and formatting, against the
canonical repository's main) before pushing.

`bun run verify` runs the local package checks from `ci-checks` in
`.github/workflows/ci.yml`; use it before pushing code changes instead of
hand-picking individual checks. For changes confined to documentation or skill
instructions, run the owning generators and validators plus formatting checks
instead. Passing does not certify `ci-result`: a pull request runs the core
checks, the web and landing builds, and the path-scoped image smokes (the API
image on arm64 only), while browser and e2e suites, service-backed suites, the
other release architectures, and the mobile, Windows, and desktop Rust checks
run only in the merge queue. Enable automatic merging with the pull request head
SHA pinned; the required `ci-result` check enforces the complete plan.
`--all` checks every package instead of only those affected vs `origin/main`.

The scoped test run is filtered by `scripts/test-scope.ts`, not `--affected`: a
suite that reads files outside its own package declares them as
`$TURBO_ROOT$` inputs of its `<name>#test` task in `turbo.json`, and those
declarations both select the package and enter its cache key.
`bun run check:test-input-coverage` fails on an undeclared cross-package read
and on a declared input no test reads any more.

## Merging

Main has a merge queue: GitHub builds main plus the pull request, runs CI on
that commit, and merges only if it passes. Enable automatic squash merging
with the pull request head SHA pinned:

```bash
head_sha="$(gh pr view <pr> --json headRefOid --jq .headRefOid)"
gh pr merge <pr> --auto --squash --match-head-commit "$head_sha"
```

`STELLA_MERGE_HOLD` pauses ordinary queued pull requests through the required
`ci-result` check. Release pull requests remain eligible while the hold is set.

## Documentation Access

The `stella-docs` MCP server provides on-demand access to library documentation via
`llms.txt`. When implementing features, call `search_docs` for the relevant topic,
then pass a selected URL to `fetch_doc_chunks`. Use `list_doc_sources` to select or
narrow libraries; reserve `fetch_docs` for a small, known Markdown or plain-text
index or page.

**Not covered (no `llms.txt`):** Tailwind CSS, oxfmt. For these, use `WebFetch` or
`WebSearch` directly.

**Setup:** run `bun run setup:mcp` once after cloning.

## Convention & Type-Cost Guards

Convention and suppression ratchets tighten by default. Every lint suppression names
a rule and reason; security-tier suppressions also need a waiver. Type-cost baseline
increases require PR justification and are never a mechanical way to pass CI.

`bun scripts/ratchet.ts --check` measures the merge-base tree and the current
tree using the same metric registry. An increase requires a justified JSON file
in `scripts/ratchet-allowances/` added in the same PR, whose delta matches the
metric (or per-file) increase exactly. Allowances already in the base are inert
and may be pruned. New metrics measure both trees; report-only metrics take no
allowances.

## Property Failure Discipline

A failing property seed is a real bug: fix it, then pin it with a neutral note
in `packages/property-testing/property-seeds.json` after the fix merges.
Extend the generator or oracle to cover the input class. Never rerun until green.
Use `assertProperty` with an explicit stable id for new properties. Keep PR and
merge-queue seeds deterministic; run exploratory fuzzing in the private nightly
tier. A documented contract wins over a suggested oracle; adapt the oracle.
