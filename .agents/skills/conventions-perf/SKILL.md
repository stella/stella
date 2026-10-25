---
name: conventions-perf
description: "Apply when adding or changing a route, screen, endpoint, MCP tool, mutation, live event, background job or polling loop, or when a performance guard fails."
---

# Performance Guard Conventions

Apply when adding or changing a route, screen, endpoint, MCP tool, mutation,
live event, background job or polling loop, and when a performance guard fails.

## Overview

Stella guards performance with recorded budgets, diffed on every run. A regression either fails CI outright or shows
up as a reviewable diff in the PR. The guards include:

- **Network baseline** (`apps/web/e2e/network-baseline.json`, checked by
  `apps/web/e2e/helpers/network.ts` from `apps/web/e2e/specs/route-smoke.spec.ts`):
  per-route request manifest, waterfall depth, per-request repeat budget, and
  per-request DB query budget.
- **Bundle baseline** (`scripts/bundle-baseline.ts` +
  `scripts/bundle-baseline.json`): gzipped size per vendor/entry/route chunk
  group, reported by the web-build CI job via `--check` and listed nightly by
  `bundle-size-nightly.yml`. Growth past the headroom is a warning annotation
  plus a job-summary table, never a failing check; it fails only when it cannot
  measure (missing build or baseline).
- **React Compiler bailout guard** (`scripts/rc-bailouts.ts` +
  `scripts/react-compiler-bailouts.json`): tracks every component the compiler
  cannot memoize, so a bailout losing its manual `useMemo`/`useCallback` fails
  CI instead of silently reintroducing an infinite-update-loop risk.
- **DB query counter** (`apps/api/src/lib/db-query-counter.ts`): the runtime
  half of the network baseline's DB-query budget. Dev/test only.
- **Chat path budgets**
  (`apps/api/src/handlers/chat/chat-path-budgets.integration.test.ts`,
  `apps/web/src/features/chat/chat-runtime-send-budget.test.ts`): SQL
  statements and bytes per chat path (thread open, older page, send, streamed
  delta, settlement, rejoin, Stop) through the real handlers, on a short and
  a long thread. The counts must be equal on both, so an N+1 fails at any
  size; bytes are bounded per page and per delta, and a send carries only the
  message it posts. Each budget is the measurement on main plus a stated
  headroom; a real improvement lowers the measurement.
- **`require-loader-prefetch`** oxlint rule
  (`.oxlint-plugins/require-loader-prefetch.ts`): static, not baseline-based;
  flags the waterfall pattern the network baseline would otherwise only catch
  after the fact.
- **Read budgets** (`apps/api/src/lib/db/read-budgets.ts`, measured by
  `apps/api/src/tests/query-perf`): absolute shared-buffer budgets per call
  of a hot statement and per run of a scheduled job, checked with
  `EXPLAIN (ANALYZE, BUFFERS)` on a corpus fixture in production's shape.
  A scheduled job is measured by running its registered task, at one corpus
  size and at twice that size, and must read the same pages at both. Every
  declared job states its `reads` (a budget, `"load-governed"` for batches
  under the backfill runtime, or a shrink-only ledger entry), and every MCP
  tool has a budget or a ledger entry. A job that needs more than the
  ungoverned ceiling per run batches through the load governor instead.
  Nothing is compared with an earlier recording; raise a budget only with a
  reason that derives the new number.
- **Per-iteration I/O checks**: `scripts/db-await-in-loop.ts` (type-aware,
  CI) flags a database call awaited once per loop iteration (the N+1),
  recognizing handles by type rather than name and suppressed with
  `// db-await-in-loop: <reason>`. A single DB hit in a constant-sized
  batch round (canonical `chunked` or an array slice-step loop, size >= 2),
  a fixed set of at most 16 elements, or a nonnegative constant-start counter
  (constant bound <= 16) is accepted when no enclosing loop or fan-out exists.
  Multiple hits, nested per-row work, variable sizes, mutated counters and
  keyset walks still require batching or an explicit reason.
  `no-network-await-in-loop` flags
  an HTTP request, AWS SDK command dispatch, or API-client method awaited the
  same way (`iterations x RTT`). Both are static and both name the owner, so
  the fix is concrete: batch the calls, or record in the suppression reason
  why the sequence is required. There is no generic await-in-loop rule; a
  sequential await with no I/O behind it costs nothing to guard.

## Measured by construction

Every new or changed surface ships with a measurement at N and 10N using
representative seeded data and a fixed response page size. Measure deterministic
counts: statements, transactions, bytes, requests, refetches and reads. Never use
wall time as the scaling assertion. Cost must not grow with data the response
does not return; batch related work and bound result sizes at the owning boundary.
The API read harness uses N=10 and N=200, a larger comparison than 10N: statement
and transaction counts stay equal, and response bytes per returned row stay within
1.2x at a fixed page size.

Censuses walk the real mounted route or curated tool registry, or the owning file
inventory for file-based surfaces. A new surface without a measurement fails the
census. Do not infer API coverage from source regexes or MCP coverage from name
prefixes. Every exemption carries a concrete reason in a shrink-only ledger;
entries can be removed as coverage lands, never added to silence a new failure.
`pendingWriteHarness` records the current mutating surfaces until their harness
lands and obeys the same shrink-only rule.

Mutation-check each guard: introduce the excess work or remove a coverage case,
confirm that the relevant assertion fails, then restore the implementation. Record
the deterministic before/after values and the rejected mutation in the PR.

The performance coverage inventories are:

| Census                                              | Test or check                                                                                         | Ledger or coverage inventory                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Mounted API v1 routes                               | `apps/api/src/tests/read-scaling/census.test.ts`                                                      | `apps/api/src/tests/read-scaling/api-scaling-ledger.json`                           |
| Curated MCP tools                                   | `apps/api/src/tests/read-scaling/census.test.ts`                                                      | `apps/api/src/tests/read-scaling/mcp-scaling-ledger.json`                           |
| Repeated SQL fingerprints per request and call site | `apps/api/src/lib/db-query-counter.test.ts`; `scripts/check-repeated-sql-fingerprints-ledger.test.ts` | `apps/api/src/lib/observability/repeated-sql-fingerprints.json`                     |
| Web route smoke list                                | `apps/web/e2e/specs/route-smoke.spec.ts` (`assertSmokeRouteCoverage`)                                 | `apps/web/e2e/helpers/smoke-route-defs.ts` (`INTENTIONALLY_NOT_SMOKED`)             |
| Read budgets (scheduled jobs, MCP tools)            | `apps/api/src/lib/db/read-budgets.test.ts`; `apps/api/src/tests/query-perf/query-perf.test.ts`           | `apps/api/src/lib/db/read-budgets.ts`; `apps/api/src/lib/db/read-budgets-unmeasured.json` |
| Create-form single-flight coverage                  | `apps/web/src/hooks/single-flight-census.test.ts`                                                     | Same file (`UNGUARDED_CREATE_FORMS`)                                                |

The existing web route inventory retains its recorded-budget policy below; it
does not replace the two-size scaling measurement. Read budgets are absolute
and are never recorded. The query
plan gate measures shared blocks; its execution-time limit remains a hang guard.

## The Core Norm

**Fix the regression first.** A red guard means the change made something
slower, heavier, or chattier than before. Reseeding the baseline to make CI
green is not a mechanical step; it is a product decision that the regression
is acceptable, and it must be justified in the PR description (why the extra
request, the deeper wait, or the bigger chunk is worth it).

Main owns network recordings. The main-only recorder runs after route/runtime
merges and nightly; the delivery workflow validates and publishes a baseline
artifact keyed by the recorded commit. PR and merge-queue checks load the
newest published recording at or before their merge base (or the committed
file at that same base when recording is unavailable). They never edit the shared JSON or request a
`baseline:record` delivery.

New and removed routes are scoped from changed route sources and reported in
the job summary. Existing routes retain every allowance, including routes
whose source changed. An intentional increase requires a reviewed JSON file
in `apps/web/e2e/network-budgets/<change>.json` with `route`, a nonempty
`reason`, and a complete `budget` entry (`depth`, `requests`, and applicable
`requestCounts`, `dbQueries`, `responseSizes`). Only declarations added or
modified since the merge base apply; inherited declarations cannot repeatedly
widen future checks. Use one file per change, so unrelated changes do not
share a generated baseline conflict.

`E2E_NETWORK_BASELINE=write` and `rewrite` remain local measurement modes;
main recording defaults to `write`; dispatch with `mode=rewrite` after a
performance fix to tighten it. Do not commit measurement output on a PR.

The bundle baseline mirrors this with `--write-baseline` (regenerate) and a
`RATCHET_DOWN` prompt (not a failure) when a chunk shrinks by more than 3%,
so a real win gets locked in rather than silently drifting back up. The RC
bailout guard and the query counter follow the same "commit the smaller
number, don't just silence the check" norm.

## Failure Playbook

### New request on route

`network.ts` reports `New API request(s) on <route>`. The route now
calls an endpoint it did not before. If intentional, declare the reviewed budget. If
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

The bundle report warns (it does not block) when a named group (`entry`, a
`vendor-*` chunk, or `routes`/`largest-route`) exceeds its committed gzip size
by more than 3% (or 1 KiB, whichever is larger, per
`HEADROOM`/`HEADROOM_FLOOR_BYTES`). Treat the warning as work: find what grew
and trim it, or re-measure with `--write-baseline` and a rationale. Two specific
shapes to look for:

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

## How Depth Is Measured

The measurement navigation uses `round-barrier-v1`: `page.route` holds every
API request selected by the network collector. The round controller releases
all currently held requests together and assigns each the same round level.
It releases the next round only after every released request has finished or
failed and the page has been quiet for `NETWORK_ROUND_SETTLE_MS` (150 ms)
after the last response, with no new tracked request during that window. The
navigation also uses the route smoke spec's existing page-settle check.
Requests arriving while a round is in flight wait for the next round.
Long-lived event streams complete at response headers so an open channel
cannot block the barrier.

Depth is the number of nonempty released rounds; `depthChain` lists the
request keys in each round. Response completion order cannot put independent
branches at different levels: children of slow and fast parents released in
the same round wait at the same barrier. A request arriving after the route's
existing settled point is idle prefetch and cannot open a new round. Depth
comes from scheduled release levels, never inferred launch gaps or response
timing. Measurement adds approximately one settle window plus the slowest
server response per round; report measured shard wall time when changing it.

The recorder writes `depthMethod: "round-barrier-v1"` in the baseline. When
the selected recording has a missing or different method, compare requests,
request counts, DB queries, and response sizes normally, but report depth
only as a notice. Enforce depth again once main publishes a recording with
the same method. Do not widen depth budgets to bridge measurement methods.

Keep the round controller testable as a pure state machine over held
requests, in-flight requests, events, and a clock. Tests cover independent
branches with unequal response durations, genuine dependencies across
rounds, and randomized request graphs and completion orders whose depth
matches the graph's longest path. Replacing the barrier with timing-derived
levels must fail those tests.

## Live Hotspot Burn-Down

Do not embed a dated hotspot snapshot in instructions; it becomes false while
remaining authoritative-looking. Before touching a hot route or endpoint, run:

```bash
bun scripts/perf-hotspots.ts
```

Treat the reported budgets as recorded debt, not acceptable targets. Capture
the relevant before value, fix or avoid worsening the access path, then run the
same command and affected guard again. When a real improvement lowers a
baseline, commit the tighter value. When an intentional product capability
raises one, document the measured tradeoff in the PR rather than hiding it in a
generic baseline refresh.

For database changes, pair the route/query counter with the actual query plan
and cardinality. A lower request count can still conceal a slower scan, and a
fast development database does not validate a production-size access path.

## Cross-Links

- `/conventions-scale` — pagination and tenant-scoped queries; a query that
  ignores these will also blow the DB-query budget.
- `/conventions-db` — indexes, batching, relation preloading; the concrete
  fix for most N+1 failures above.
- `/conventions-ux` — GPU-friendly animation and skeleton conventions; a
  waterfall fix that adds a loading state should use a real structural
  skeleton, not a spinner.
