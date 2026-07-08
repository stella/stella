# Performance Guard Conventions

Apply when a performance-guard check fails in CI, or when touching a route or
endpoint flagged in the hotspot table below.

## Overview

Stella guards performance the same way it guards schema safety: committed
baselines, diffed on every run. A regression either fails CI outright or shows
up as a reviewable diff in the PR. Five guards exist today:

- **Network baseline** (`apps/web/e2e/network-baseline.json`, checked by
  `apps/web/e2e/helpers/network.ts` from `apps/web/e2e/specs/route-smoke.spec.ts`):
  per-route request manifest, waterfall depth, per-request repeat budget, and
  per-request DB query budget.
- **Bundle baseline** (`scripts/bundle-baseline.ts` +
  `scripts/bundle-baseline.json`): gzipped size per vendor/entry/route chunk
  group, wired into the web-build CI job via `--check`.
- **React Compiler bailout guard** (`scripts/rc-bailouts.ts` +
  `scripts/react-compiler-bailouts.json`): tracks every component the compiler
  cannot memoize, so a bailout losing its manual `useMemo`/`useCallback` fails
  CI instead of silently reintroducing an infinite-update-loop risk.
- **DB query counter** (`apps/api/src/lib/db-query-counter.ts`): the runtime
  half of the network baseline's DB-query budget. Dev/test only.
- **`require-loader-prefetch`** oxlint rule
  (`.oxlint-plugins/require-loader-prefetch.ts`): static, not baseline-based;
  flags the waterfall pattern the network baseline would otherwise only catch
  after the fact.

## The Core Norm

**Fix the regression first.** A red guard means the change made something
slower, heavier, or chattier than before. Reseeding the baseline to make CI
green is not a mechanical step; it is a product decision that the regression
is acceptable, and it must be justified in the PR description (why the extra
request, the deeper wait, or the bigger chunk is worth it).

The network baseline has two write modes for exactly this distinction:

- `E2E_NETWORK_BASELINE=write` merges into the existing baseline: requests
  accumulate as a union, depth and DB-query budgets take the max. Safe to run
  repeatedly (e.g. to re-accumulate timing-conditional requests); used for
  legitimate additions such as a new endpoint a route now legitimately calls.
- `E2E_NETWORK_BASELINE=rewrite` snapshots from scratch, discarding anything
  not observed on this run. Use it after a perf fix, to tighten a depth or
  budget back down. Follow a `rewrite` with a few `write` runs to
  re-accumulate any timing-conditional requests the single rewrite run missed.

The bundle baseline mirrors this with `--write-baseline` (regenerate) and a
`RATCHET_DOWN` prompt (not a failure) when a chunk shrinks by more than 3%,
so a real win gets locked in rather than silently drifting back up. The RC
bailout guard and the query counter follow the same "commit the smaller
number, don't just silence the check" norm.

## Failure Playbook

### New request on route

`network.ts` reports `New API request(s) on <route>`. The route now
calls an endpoint it did not before. If intentional, `write` the baseline. If
not, find what changed (a new hook mount, a widened `select`, an added
`useQuery`) and remove the call.

### Request waterfall got deeper

`Request waterfall got deeper on <route>: N -> M`. Each extra level is one
more sequential network round the user waits through. The fix is almost
always to start the query in the route loader instead of the component:
prefetch it with `ensureRouteQueryData` (blocking, critical data) or
`prefetchRouteQuery` (non-blocking warmup) from `apps/web/src/lib/react-query.ts`,
so the fetch starts during navigation in parallel with code-split chunk
loading, and the component's `useSuspenseQuery` consumes an already-warm
cache instead of opening a new round. `require-loader-prefetch` catches the
same pattern statically before it ever reaches the baseline: it flags
`useSuspenseQuery(factory(...))` when the route has no `loader`, or has one
that never references `factory`.

### Request repeated more than budgeted

`API request repeated on <route>: <key> ran N -> M times`. Baseline budgets
per-request-key repeat counts (default 1 unless the committed
`requestCounts` says otherwise). Duplicate firing usually comes from
duplicate component mounts, normalized UUID fan-out (multiple ids hitting the
same `:id`-normalized key), or a refetch policy that lets the same endpoint
fire twice. Reuse the in-flight query instead of issuing a second one.

### DB query count grew

`DB queries per request grew on <route>: <key> ran N -> M queries`. The
classic cause is an N+1: a per-row query inside a loop, or a lazy relation
loaded once per item instead of preloaded. Batch it (joins, `IN` lists,
Drizzle relation preloading); see `/conventions-db` for indexing and batching
patterns. The allowance (`dbQueryAllowance`, budget + max(2, 15%)) already
absorbs normal noise (auth session-refresh piggybacks, cache variance); a
failure here is a real regression, not jitter.

If instead the check reports `DB query count missing on <route>`, the
response stopped exposing the dev/test `x-db-queries` header — restore the
query counter wiring before trusting the route's N+1 budget again.

### Bundle group over budget

The bundle baseline fails when a named group (`entry`, a `vendor-*` chunk, or
`routes`/`largest-route`) exceeds its committed gzip size by more than 3% (or
1 KiB, whichever is larger, per `HEADROOM`/`HEADROOM_FLOOR_BYTES`). Two
specific failure shapes:

- **A dependency escaped its `manualChunks` bucket** and landed in `entry`
  (paid on every cold visit) instead of a lazy route chunk or `vendor-*`
  group. Dynamic-`import()` it, or fix the `manualChunks` rule in
  `apps/web/vite.config.ts`.
- **`vendor-anonymize-data` or `wasm-vendor` show up nonzero.** These are
  tracked at 0 because they should only ever load inside a web worker, never
  the main client bundle. A nonzero value means a worker-only dependency
  leaked into the client graph; keep it worker-only instead of widening the
  baseline.

### `require-loader-prefetch` lint failure

Same underlying problem as "waterfall got deeper," caught statically instead
of at e2e time: a route component calls `useSuspenseQuery(factory(...))` but
the route's `loader` either doesn't exist or never references `factory`.
Prefetch `factory(...)` in the `loader` via `ensureRouteQueryData` or
`prefetchRouteQuery`.

## Depth-Jitter Caveat

The chain-gap heuristic (`CHAIN_GAP_MS = 500` in `network.ts`) treats a
request as "chained" onto the previous one only if it starts within 500ms of
that request's end. Under load (a busy CI runner, a cold cache), independent
requests that would normally fire in parallel can serialize past that gap by
coincidence, and the computed depth flaps by 1 with **no change to the
request manifest**. The checker carries a +1 depth allowance in
`assertNetworkBaseline` for exactly this reason.

If CI reports a deeper waterfall but the request list (`requests`,
`requestCounts`) is unchanged from the baseline, treat it as scheduling
jitter: rerun before touching the baseline. Do not bump an individual route's
`depth` to paper over a flake; only `write`/`rewrite` when the request
manifest itself actually changed.

## Hotspot Burn-Down (snapshot: 2026-07)

These are the current worst budgets in `apps/web/e2e/network-baseline.json`,
not acceptable targets. If you touch one of these endpoints or routes, batch
its queries or fix its waterfall and tighten the baseline with `rewrite`
rather than leaving the number where it is. Get the current ranking live with
`bun scripts/perf-hotspots.ts` instead of trusting this table once it goes
stale.

Worst DB-query budgets per endpoint:

| Endpoint                                   | Route (first seen)                          | DB query budget |
| ------------------------------------------- | -------------------------------------------- | ---------------- |
| `GET /v1/contacts/:id`                      | `/contacts/$contactId`                       | 16                |
| `GET /v1/entities/:id/entity/:id/versions`  | `/workspaces/$workspaceId/$viewId/document`  | 16                |
| `POST /v1/chat/workspaces/:id/file-thread`  | `/workspaces/$workspaceId/entities/$entityId` | 14                |
| `GET /v1/catalogue`                         | `/knowledge/mcp target`                      | 13                |
| `GET /v1/workspaces`                        | `/todos`                                     | 12                |

(The previous top offenders were fixed in 2026-07: the validateAuth
resolve used to run 2-3 times per request, a 14-21 query floor on every
authenticated endpoint, now ~6; chat thread messages went 27 to 9-12 and
workspace overview 25 to 9 after batching. The remaining budgets above
mostly sit near the floor plus a handful of handler reads; the next
meaningful lever is the per-`safeDb`-call `set_config` round trip.)

Deepest waterfalls: `/workspaces/$workspaceId/entities/$entityId` at depth 11
remains the clear outlier; `/workspaces/$workspaceId/$viewId/document` is next
at 9, then `/workspaces/$workspaceId/expenses` at 7.

## Cross-Links

- `/conventions-scale` — pagination and tenant-scoped queries; a query that
  ignores these will also blow the DB-query budget.
- `/conventions-db` — indexes, batching, relation preloading; the concrete
  fix for most N+1 failures above.
- `/conventions-ux` — GPU-friendly animation and skeleton conventions; a
  waterfall fix that adds a loading state should use a real structural
  skeleton, not a spinner.
