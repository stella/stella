# Plan: Migrate from RivetKit to SSE + REST

Date: 2026-04-13

## Goal

Replace all RivetKit actors with SSE for real-time push and REST
endpoints for mutations. RivetKit adds complexity (actor lifecycle,
SQLite state, websocket pooling bugs) without providing value beyond
what SSE + Postgres delivers. The migration eliminates the #1 source
of dev-time bugs (stale actors, infinite loading, connection deadlocks).

## Design Decisions

- **SSE over WebSockets:** SSE is unidirectional (server→client),
  auto-reconnects natively, works through all proxies, needs zero
  client libraries. All mutations are already request-response; we
  only need server→client push for cache invalidation.

- **Per-workspace SSE connection:** One EventSource per workspace the
  user is viewing. Workspace isolation by default, no filtering.
  Mounted in the workspace route layout; torn down on navigation.

- **Invalidation-based, not state-push:** Push React Query key
  invalidations over SSE instead of raw data. React Query refetches
  from REST. Simpler, cache-consistent, API already exists.

- **In-memory connection map:** `Map<workspaceId, Set<Response>>` in
  the API process. No persistence needed — SSE reconnects on restart.

- **BullMQ + pg-boss for workflow queue:** BullMQ (Redis/Valkey) for
  managed deployments where Redis is available. pg-boss for
  self-hosters who only have Postgres. Abstract behind a `JobQueue`
  interface selected via env config (`JOB_QUEUE_PROVIDER=bullmq|pgboss`).

- **Incremental migration:** One actor at a time. Each phase is
  independently shippable. RivetKit removed in a final cleanup PR.

## Scope

**In scope:**

- Phase 1: SSE infrastructure + sync actor replacement
- Phase 2: Views actor → REST endpoints
- Phase 3: Workflow actor → job queue + REST
- Phase 4: Remove RivetKit dependency

**Out of scope:**

- Conflict resolution / OT for concurrent edits (last-write-wins,
  same as current)
- Multi-region deployment
- Migrating the bbox actor (already replaced with HTTP in #812)

## Implementation

### Phase 1: SSE infrastructure + replace sync actor

The sync actor is stateless (`{}` state) — it's a pure broadcast
relay. Simplest actor to replace, proves the SSE pattern.

- `apps/api/src/lib/sse.ts` — broadcast manager:
  `subscribe(workspaceId, res)`, `broadcast(workspaceId, event)`,
  cleanup on disconnect
- `apps/api/src/handlers/workspaces/routes.ts` — add
  `GET /:workspaceId/events` SSE endpoint inside workspace guard
- `apps/web/src/lib/sse.ts` — `useWorkspaceSSE(workspaceId)` hook:
  EventSource + React Query invalidation on message
- `apps/web/src/routes/_protected.workspaces/$workspaceId/route.tsx` —
  mount the hook in the workspace layout
- Replace all `invalidateQueryAction` (sync actor calls) with
  `broadcast(workspaceId, { queryKey })`

### Phase 2: Views actor → REST

The views actor stores view configs but reads from Postgres on wake.
The "actor state" is just a cache of DB rows.

- `apps/api/src/handlers/views/` — new handler group: CRUD endpoints
  (`GET /`, `POST /`, `PUT /:viewId`, `DELETE /:viewId`)
- Move logic from `actors/views/actor.ts` actions into `createHandler`
  handlers
- After each mutation: write to DB + SSE broadcast
- Frontend: replace `viewsOptions` (Rivet actor call) with Eden
  treaty query; remove `ViewsActorProvider` and `useActor`

### Phase 3: Workflow actor → job queue + REST

- `apps/api/src/lib/job-queue.ts` — `JobQueue` interface:
  `enqueue(job)`, `onComplete(handler)`. Two implementations:
  - `BullMQQueue` — uses Redis/Valkey (managed deployments)
  - `PgBossQueue` — uses Postgres (self-hosted)
  - Selected via `JOB_QUEUE_PROVIDER` env var
- `POST /v1/workspaces/:workspaceId/workflow/start` — enqueues the
  extraction job
- `GET /v1/workspaces/:workspaceId/workflow/status` — reads from
  `workflow_runs` table
- Batch orchestration (execution plan, parallel processing) moves
  into the job worker
- After each batch: write fields to DB + SSE broadcast
  `invalidate:entities`

### Phase 4: Cleanup

- Delete `packages/rivet/` entirely
- Delete `apps/api/src/handlers/registry/` (actors, utils, runtime)
- Remove `rivetkit`, `@rivetkit/react` from dependencies
- Remove RivetKit manager (port 6420) from API startup
- Remove `VITE_RIVET_ENDPOINT` env var
- Remove `rivet:clean` dev script

## Phase Dependencies

```
Phase 1 (SSE + sync) ──┬── Phase 2 (views)
                        ├── Phase 3 (workflow)
                        └── Phase 4 (cleanup, after 2+3)
```

Phases 2 and 3 can run in parallel after Phase 1.

## Test Cases

- SSE reconnects after API restart (browser auto-reconnect)
- Two tabs, same workspace: user A creates view → user B sees it
- Workflow: start via REST → status updates via SSE → fields appear
- SSE connection cleaned up on workspace navigation (no leaks)
- Auth: SSE endpoint rejects unauthenticated requests
- Workspace isolation: events don't leak across workspaces
- Self-hosted: workflow runs with pg-boss (no Redis)
- Job queue: workflow survives API restart (job re-picked from queue)

## Open Questions

- **Valkey vs Redis for BullMQ?** Docker compose already has Valkey.
  BullMQ is Redis-compatible. Confirm Valkey works with BullMQ in CI.
- **SSE keep-alive interval?** Need periodic `:keep-alive\n\n`
  comments to prevent proxy timeouts. 15-30 seconds is standard.
