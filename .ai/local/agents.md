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

## Workspace Layout

- `apps/*` contains runnable applications only.
- `packages/*` contains shared or publishable packages only.
- Every direct child of `apps/` and `packages/` must be a workspace package named
  `@stll/<directory>`.
- Use scoped workspace filters in commands, for example
  `bun --filter @stll/web dev`.

## Commands

`bun run dev` | `dev:web` (3000) | `dev:api` (3001) |
`build` | `lint` | `format` | `typecheck` | `test`

Database deployments use committed migrations via
`bun --filter @stll/api db:migrate`; `db:push` is local schema sync only.

`bun run verify` runs the same checks as the required CI job
(`ci-checks` in `.github/workflows/ci.yml`); use it to self-verify a
branch instead of hand-picking individual checks. Green here means
green on the `ci-result` status. `--all` checks every package instead
of only those affected vs `origin/main`.

## Merging

Merges go through `bun scripts/merge-bar.ts <pr>`: it re-reads PR state, the
`ci-result` check run on the exact head SHA, and unresolved review threads in one
invocation, then merges. Raw `gh pr merge` asserts nothing and reads an empty check
list as green.

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
  Valkey 6379, RustFS 9000/9001, Gotenberg 3003), copies `apps/{api,web}/.env` from
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
- **`sync-ai:check` needs the `.ai/shared` submodule.** Local `bun run verify` warns
  and skips only that step when it is absent. Run
  `git submodule update --init .ai/shared` for CI-equivalent verification.
- Optional demo data: `bun --filter @stll/api db:seed-test-user` and `db:seed-dev`.

## Convention & Type-Cost Guards

Convention and suppression ratchets may only tighten. Every lint suppression names
a rule and reason; security-tier suppressions also need a waiver. Type-cost baseline
increases require PR justification and are never a mechanical way to pass CI.
