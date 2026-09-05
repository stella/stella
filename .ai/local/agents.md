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
user-facing strings, ingestion, performance guard failures and hot paths,
architecture and scale, auth and data access, files and external APIs, tests,
`apps/web` React effects, and user-facing UI. The skills own the detailed rules.

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

## Commands

`bun run dev` | `dev:web` (3000) | `dev:api` (3001) |
`build` | `lint` | `format` | `typecheck` | `test`

Database deployments use committed migrations via
`bun --filter @stll/api db:migrate`; `db:push` is local schema sync only.

`bun run verify` runs the local package checks from `ci-checks` in
`.github/workflows/ci.yml`; use it before pushing instead of hand-picking
individual checks. Passing does not certify `ci-result`: release-image
builds and smokes, service-backed checks, and separate build/e2e jobs run
in CI. Confirm `ci-result` succeeds on the current PR head before merging.
`--all` checks every package instead of only those affected vs `origin/main`.

## Merging

Merges go through `bun scripts/merge-bar.ts <pr>`: it re-reads PR state,
mergeability, the required checks on the exact head SHA, unresolved review
threads, and migration ordering against the live base in one invocation, then
arms "merge when ready" pinned to that head. Main has a merge queue: GitHub
builds main plus the pull request, runs CI on that commit, and merges only if
it passes, so nothing needs a rebase to land and nothing lands past a red
check. Run the bar as soon as the PR is ready; it is idempotent. Raw
`gh pr merge` asserts nothing and reads an empty check list as green.

## Documentation Access

The `stella-docs` MCP server provides on-demand access to library documentation via
`llms.txt`. When implementing features, fetch the relevant docs first using
`list_doc_sources` and `fetch_docs` tools.

**Not covered (no `llms.txt`):** Tailwind CSS, oxfmt. For these, use `WebFetch` or
`WebSearch` directly.

**Setup:** run `bun run setup:mcp` once after cloning.

## Convention & Type-Cost Guards

Convention and suppression ratchets may only tighten. Every lint suppression names
a rule and reason; security-tier suppressions also need a waiver. Type-cost baseline
increases require PR justification and are never a mechanical way to pass CI.
