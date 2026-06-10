## Project Overview

**Monorepo:** `apps/api` (Elysia backend, Bun), `apps/web` (React + Vite frontend),
shared packages in `packages/`. Use Glob/Grep to explore.

## Workspace Layout

- `apps/*` contains runnable applications only.
- `packages/*` contains shared or publishable packages only.
- Every direct child of `apps/` and `packages/` must be a workspace package named
  `@stll/<directory>`.
- Use scoped workspace filters in commands, for example
  `bun --filter @stll/web dev`.

## Commands

`bun run dev` | `dev:web` (3000) | `dev:api` (3001) |
`build` | `lint` | `format` | `typecheck` | `test` |
`db:push`

`bun run verify` runs the same checks as the required CI job
(`ci-checks` in `.github/workflows/ci.yml`); use it to self-verify a
branch instead of hand-picking individual checks. Green here means
green on the `ci-result` status. `--all` checks every package instead
of only those affected vs `origin/main`.

## Documentation Access

The `stella-docs` MCP server provides on-demand access to library documentation via
`llms.txt`. When implementing features, fetch the relevant docs first using
`list_doc_sources` and `fetch_docs` tools.

**Not covered (no `llms.txt`):** Tailwind CSS, oxfmt. For these, use `WebFetch` or
`WebSearch` directly.

**Setup:** run `bun run setup:mcp` once after cloning.
