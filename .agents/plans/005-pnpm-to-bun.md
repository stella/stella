# Plan: Migrate from pnpm to Bun package manager

Date: 2026-02-20

## Goal

Replace pnpm with Bun as the monorepo package manager. Migrate
workspaces, catalogs, CI workflows, the Dockerfile, scripts, and
all documentation references. Replace all `pnpm` and `npx` usage
with `bun` and `bunx`. Keep Turbo for build orchestration.

## Design Decisions

- **Keep Turbo.** Turbo provides task caching, dependency-aware
  orchestration, and `turbo prune` for Docker builds. Bun's
  built-in workspace runner doesn't replace these. The
  `turbo prune` + `bun.lock` frozen lockfile issue was fixed in
  Turborepo PR #11048 (Nov 2025); we need Turbo >=2.3 to be safe.

- **Stay on hoisted linker.** Bun's isolated linker has
  [critical bugs with catalogs in monorepos](https://github.com/oven-sh/bun/issues/23615)
  (unfixed as of Bun 1.3). Since the project already uses
  `nodeLinker: hoisted` with pnpm, hoisted is the natural default
  and avoids these bugs. Revisit isolated mode when Bun fixes
  catalog deduplication.

- **Dockerfile: `oven/bun` base image.** Turbo runs on Bun
  (`bun install -g turbo`), so no Node dependency needed. Switch
  from `node:26-slim` to `oven/bun` and use `bun install` instead
  of `pnpm install`.

- **SBOM: use `bunx @cyclonedx/cdxgen`.** cdxgen supports
  `bun.lock` for JavaScript projects. Run via `bunx` instead of
  `npx`.

- **Keep `.bun-version` at 1.3.6.** Per user preference. The
  `setup-bun` action reads this file automatically.

- **Replace all `npx` with `bunx`.** Three occurrences: sbom.yml,
  CLAUDE.md (Playwright MCP), `.claude/settings.local.json`.

## Scope

**In scope:**

- Root `package.json`: `packageManager` field, `workspaces` key,
  catalogs, scripts
- Delete `pnpm-workspace.yaml` and `pnpm-lock.yaml`
- Generate `bun.lock`
- GitHub Actions: `ci.yml`, `sbom.yml` (replace pnpm/npx with
  bun/bunx)
- Dockerfile: switch to `oven/bun` base image
- `scripts/dev.sh`: pnpm → bun
- `apps/api/package.json`: `pnpm docker:dev` → `bun run docker:dev`
- Documentation: CLAUDE.md, CONTRIBUTING.md, apps/api/README.md,
  apps/web/README.md, `.claude/commands/*.md`
- `.claude/settings.local.json`: update allowed commands
  (pnpm → bun, npx → bunx)
- Codespell skip list in CI: `pnpm-lock.yaml` → `bun.lock`
- `.prettierignore`: `pnpm-lock.yaml` → `bun.lock`
- `.gitignore`: add `bun.lockb` (binary lockfile, exclude)

**Out of scope:**

- Dropping Turbo (kept as-is)
- Switching to isolated linker (blocked by Bun bugs)
- Upgrading Bun version beyond 1.3.6
- `.claude/mcp/` isolated install (use `bun install --cwd
.claude/mcp` as the equivalent)

## Implementation

### 1. Root `package.json`

- Change `"packageManager": "pnpm@10.18.0"` →
  `"packageManager": "bun@1.3.6"`
- Add `"workspaces"` array: `["apps/*", "packages/*"]`
- Add `"catalog"` object (move from pnpm-workspace.yaml)
- Add `"catalogs"` object (move named catalogs: react19, rivet,
  ultracite)
- Update scripts:
  - `"lint:ws"`: `pnpm dlx sherif` → `bunx sherif`
  - `"setup:mcp"`: `pnpm install --dir` → `bun install --cwd`
  - `"postinstall"`: `pnpm lint:ws` → `bun run lint:ws`
  - `"clean"`: keep as-is (uses git + turbo)

### 2. Delete pnpm files

- Delete `pnpm-workspace.yaml`
- Delete `pnpm-lock.yaml`

### 3. Generate lockfile

- Run `bun install` to generate `bun.lock`

### 4. `apps/api/package.json`

- `"dev"` script: `pnpm docker:dev` → `bun run docker:dev`

### 5. Dockerfile (`apps/api/Dockerfile`)

```dockerfile
FROM oven/bun:1.3.6-slim AS base
WORKDIR /app

FROM base AS pruner
RUN bun install -g turbo@^2
COPY . .
RUN turbo prune @stella/api --docker

FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN bun install --frozen-lockfile

FROM deps AS runner
COPY --from=pruner /app/out/full/ .
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["bun", "--port", "3001", "src/index.ts"]
```

### 6. GitHub Actions — `ci.yml`

- Remove `pnpm/action-setup` step
- Remove `actions/setup-node` step (Bun doesn't need Node)
- Keep `oven-sh/setup-bun` step (already present)
- `pnpm install` → `bun install`
- `pnpm i18n:check` → `bun run i18n:check`
- `pnpm lint` → `bun run lint`
- `pnpm format` → `bun run format`
- `pnpm typecheck` → `bun run typecheck`
- `pnpm test` → `bun run test`
- Codespell skip: `pnpm-lock.yaml` → `bun.lock`

### 7. GitHub Actions — `sbom.yml`

- Trigger paths: `pnpm-lock.yaml` → `bun.lock`, remove
  `pnpm-workspace.yaml`, keep `**/package.json`
- Remove `pnpm/action-setup` step
- Replace `actions/setup-node` with `oven-sh/setup-bun`
- `pnpm install --frozen-lockfile` → `bun install --frozen-lockfile`
- `npx @cyclonedx/cdxgen` → `bunx @cyclonedx/cdxgen`

### 8. `scripts/dev.sh`

- `pnpm install --frozen-lockfile || pnpm install` →
  `bun install --frozen-lockfile || bun install`
- `pnpm db:push` → `bun run db:push`
- `pnpm dev` → `bun run dev`

### 9. `.claude/settings.local.json`

- Update all `Bash(pnpm ...)` patterns to `Bash(bun ...)`
- Update `Bash(npx prettier:*)` to `Bash(bunx prettier:*)`

### 10. Config files

- `.prettierignore`: `pnpm-lock.yaml` → `bun.lock`
- `.gitignore`: add `bun.lockb`
- Codespell skip in `ci.yml`: `pnpm-lock.yaml` → `bun.lock`

### 11. Documentation updates

- `CLAUDE.md`: all pnpm references → bun equivalents, all
  npx references → bunx (including Playwright MCP command)
- `CONTRIBUTING.md`: `pnpm install` → `bun install`, etc.
- `apps/api/README.md`: pnpm → bun
- `apps/web/README.md`: pnpm → bun
- `.claude/commands/*.md`: update pnpm references

## Test Cases

- `bun install` succeeds from clean state (no node_modules)
- `bun run build` succeeds (via Turbo)
- `bun run dev` starts all dev servers
- `bun run typecheck` passes
- `bun run lint` passes
- `bun run format` passes
- `bun run test` passes
- `bun install --frozen-lockfile` works (CI simulation)
- `workspace:*` and `catalog:` references resolve correctly
- Docker build succeeds with new Dockerfile
- `bunx sherif` runs successfully (postinstall)
- `bun install --cwd .claude/mcp` works

## Open Questions

- **Isolated linker.** Revisit when
  [bun#23615](https://github.com/oven-sh/bun/issues/23615) is
  fixed. The hoisted linker works but doesn't catch phantom deps.
