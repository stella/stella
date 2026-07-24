## Project Overview

**Monorepo:** `apps/api` (Elysia backend, Bun), `apps/web` (React + Vite frontend),
shared packages in `packages/`. Use Glob/Grep to explore.

## Database Domain Values

- For closed persisted domain values, use one named `as const` value list with
  Drizzle `text({ enum: VALUES })`; do not use TypeScript enums or native PostgreSQL
  enums for evolving state.
- Drizzle enum inference and `.$type<T>()` do not validate stored values. Add a
  database `CHECK` when an invalid value could compromise lifecycle, billing,
  authorization, audit, or workflow invariants. Reserve `.$type<T>()` for branded
  or structured types.

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

## Cursor Cloud specific instructions

The base VM already has Bun (`~/.bun/bin`, on `PATH` via `~/.bashrc`) and Docker
installed; the startup update script runs `bun install`. Standard commands live in
`README.md`, `CONTRIBUTING.md`, and root `package.json` scripts; the notes below are
only the non-obvious caveats for this environment.

- **Start the Docker daemon first.** There is no systemd auto-start here, so `docker`
  commands fail until the daemon runs. Start it once per session in the background
  (e.g. `sudo dockerd` in a tmux session) and confirm with `docker ps`. The daemon is
  configured with the `fuse-overlayfs` storage driver and iptables-legacy for
  docker-in-docker.
- **Run everything with `bun run dev --no-browser`.** The dev-runner
  (`packages/scripts/src/dev-runner.ts`) brings up the Docker infra (Postgres 5432,
  Valkey 6379, MinIO 9000/9001, Gotenberg 3003), copies `apps/{api,web}/.env` from
  `.env.example`, applies DB migrations, and starts the API (3001) and web (3000). It
  exits if any child dies, so a single background process covers the whole stack. Use
  `bun run dev:api` or `bun run dev:web` for a focused loop.
- **Auth is passwordless email OTP; no SMTP catcher runs.** `EMAIL_PROVIDER=smtp`
  points at `localhost:1025`, which is not running, so verification emails are not
  delivered. In dev the OTP is printed to the API log as
  `[DEV] OTP for <email>: <code>` and is also fetchable via
  `GET http://localhost:3001/dev-public/last-otp?email=<email>` (dev-only, 404 in
  prod). Use the log line to complete sign-in/sign-up when testing.
- **Mock AI is on by default** (`USE_MOCK_AI="true"` in `apps/api/.env.example`), so no
  AI provider key is needed for local runs.
- **`bun run verify` / `sync-ai:check` need the `.ai/shared` submodule.** It is not part
  of the base checkout; run `git submodule update --init .ai/shared` first, otherwise
  the "AI skill sync" step errors out.
- Optional demo data: `bun --filter @stll/api db:seed-test-user` and `db:seed-dev`.

## Convention & Type-Cost Guards

- Whole-repo convention metrics that may only decrease live in
  `scripts/ratchet.ts` (`RATCHET_METRICS`); this includes cross-slice imports
  (API handler domains, route-private `-` paths, web features), which
  structurally enforce the vertical-slice principle.
- Typecheck cost is guarded by `scripts/typecheck-baseline.ts`: per-project
  tsc `--extendedDiagnostics` Types/Instantiations counters with headroom,
  checked in the CI typecheck job. Reseeding either baseline
  (`--write` / `--write-baseline`) must be justified in the PR description;
  it is not a mechanical way to make CI green.
