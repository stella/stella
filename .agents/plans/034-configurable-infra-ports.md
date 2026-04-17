# Plan: Configurable Shared Infrastructure Ports

Date: 2026-04-17

## Goal

Allow the dev-runner to shift shared Docker infrastructure ports
(Postgres, Valkey, MinIO, Gotenberg) so Stella can coexist with other
projects that claim the same defaults (5432, 6379, 9000, 3003).

## Design Decisions

- **Single `STELLA_INFRA_OFFSET` env var (default 0).** Same pattern
  as the existing app port offset. One number shifts all four services.
  Simpler than four individual vars; if someone needs per-service
  control they can override the .env directly.

- **Docker Compose env var substitution for host ports.** The
  docker-compose.yml gains `${STELLA_PG_HOST_PORT:-5432}:5432` etc.
  The dev-runner computes these from the offset and passes them to
  `docker compose up` via the subprocess environment. This is the
  standard Docker mechanism; no templating or code generation needed.

- **Dev-runner threads infra URLs into the API env.** It already does
  this for app ports (`BETTER_AUTH_URL`, `VITE_API_URL`). Same
  approach: override `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`,
  `GOTENBERG_URL` when the offset is non-zero so the API connects to
  the right ports.

- **Shared project name includes the offset.** When the offset is
  non-zero, the Docker project becomes `stella-dev-{offset}` so
  multiple Stella stacks can coexist with separate volumes.

## Scope

**In scope:**

- `docker-compose.yml` — env var substitution for all host port
  mappings
- `packages/scripts/src/dev-runner.ts` — read offset, compute infra
  ports, pass to Docker and API, update health checks
- `packages/scripts/src/dev-runner.test.ts` — unit tests for the new
  infra port logic
- `apps/api/.env.example` — document that ports may be overridden

**Out of scope:**

- Per-service port overrides (can be added later if needed)
- CI/staging Docker configs (not affected; they use their own ports)
- MinIO console port (9001) — nice to shift but non-critical

## Implementation

### `docker-compose.yml`

Replace hardcoded host ports with env var defaults:

```yaml
# postgres
ports:
  - "${STELLA_PG_HOST_PORT:-5432}:5432"

# minio
ports:
  - "${STELLA_MINIO_HOST_PORT:-9000}:9000"
  - "${STELLA_MINIO_CONSOLE_PORT:-9001}:9001"

# valkey
ports:
  - "${STELLA_VALKEY_HOST_PORT:-6379}:6379"

# gotenberg
ports:
  - "${STELLA_GOTENBERG_HOST_PORT:-3003}:3000"
```

### `packages/scripts/src/dev-runner.ts`

1. Add infra port defaults and types alongside `DEFAULT_PORTS`:

   ```typescript
   const DEFAULT_INFRA_PORTS = {
     gotenberg: 3003,
     minio: 9000,
     minioConsole: 9001,
     postgres: 5432,
     valkey: 6379,
   } as const;
   ```

2. Add `infraPortsForOffset(offset)` helper (mirrors `portsForOffset`).

3. Read `STELLA_INFRA_OFFSET` from env or `--infra-offset` CLI arg
   in `parseArgs`. Default 0.

4. Update `areSharedDockerServicesHealthy` to accept the computed
   infra ports instead of hardcoded constants.

5. Update `SHARED_INFRA_PORTS` usage in `areSharedDockerPortsFree`
   to use computed ports.

6. In `ensureDockerServices`, pass `STELLA_PG_HOST_PORT`,
   `STELLA_VALKEY_HOST_PORT`, `STELLA_MINIO_HOST_PORT`,
   `STELLA_MINIO_CONSOLE_PORT`, `STELLA_GOTENBERG_HOST_PORT` as env
   vars to the `docker compose up` subprocess.

7. When offset > 0, use project name `stella-dev-{offset}`.

8. In `createApiEnv`, inject `DATABASE_URL`, `REDIS_URL`,
   `S3_ENDPOINT`, `GOTENBERG_URL` with the computed ports.

### `packages/scripts/src/dev-runner.test.ts`

- Test `infraPortsForOffset` returns correctly shifted ports.
- Test that `parseArgs` handles `--infra-offset`.
- Test that `createApiEnv` includes infra URLs when offset > 0.

### `apps/api/.env.example`

Add a comment noting that in dev, these ports may be overridden by the
dev-runner when `STELLA_INFRA_OFFSET` is set.

## Test Cases

- `bun run dev --dry-run` with no offset shows default ports.
- `bun run dev --dry-run --infra-offset 10` shows shifted infra ports
  (5442, 6389, 9010, 3013).
- `STELLA_INFRA_OFFSET=10 bun run dev --dry-run` same result via env.
- Unit tests for `infraPortsForOffset`, `parseArgs`, `createApiEnv`.
- Manual: start with `--infra-offset 10` when another project holds
  the default ports; verify API connects to the shifted Postgres.

## Open Questions

- Should the dev-runner auto-detect infra port collisions and
  auto-offset (like it does for app ports)? Deferred: manual offset
  is simpler and more predictable for shared infra.
