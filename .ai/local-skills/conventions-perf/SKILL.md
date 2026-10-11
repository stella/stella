---
name: conventions-perf
description: "Apply when a performance-guard check (network baseline, bundle baseline, DB query count, loader-prefetch lint, RC bailouts) fails or when touching a hot route/endpoint."
---

# Performance Guard Conventions

Apply when a performance-guard check fails in CI, or when touching a route or
endpoint flagged by the live `bun scripts/perf-hotspots.ts` report.

## Overview

Stella guards performance with recorded budgets, diffed on every run. A regression either fails CI outright or shows
up as a reviewable diff in the PR. Six guards exist today:

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
- **`require-loader-prefetch`** oxlint rule
  (`.oxlint-plugins/require-loader-prefetch.ts`): static, not baseline-based;
  flags the waterfall pattern the network baseline would otherwise only catch
  after the fact.
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

`waterfallDepth` (`apps/web/e2e/helpers/network.ts`) counts the most
consecutive **busy blocks** in any one observation sequence: a busy block is a
maximal run of requests whose intervals overlap, and a launch gap over
`REQUEST_SEQUENCE_GAP_MS` (500) starts a new sequence so an idle prefetch is
not read as another route-load round. Two requests in flight at the same
instant are never two levels, so the number is a lower bound on true causal
depth: a dependent request hiding behind an unrelated slow one is invisible
to it.

Reading launch times rather than the gap since the previous response _ended_ is
what buys monotonicity, and it costs sensitivity: a dependent request whose
parent ran longer than 500ms opens a new sequence instead of counting a level.
The three properties are not simultaneously satisfiable, because separating a
dependent request from an idle prefetch requires the parent's duration, and any
rule reading response ends lets a response growing under load close a gap it
used to exceed. Under-counting is the safer error for a guard compared only
upward.

The metric is **load-monotone**: neither a slower response nor a uniformly
stretched timeline can raise it. Sequence boundaries read launch times only,
so a longer response cannot move one; coverage is a running max that is never
rewound at a boundary, so a split can only lower the count.

One residual remains, and it is what the +1 `DEPTH_JITTER_ALLOWANCE` in
`assertNetworkBaseline` covers: two requests issued from different ticks may
overlap on one run and not the next, shifting a route by exactly one block. No
launch-time metric can tell that apart from a real added round. The allowance
is capped at one level and must stay there, because the metric can no longer
carry a count across an observation boundary: a route reporting **two** extra
levels has genuinely grown one, so investigate the request graph rather than
re-running. Only `write`/`rewrite` when the route's behavior actually changed.

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
