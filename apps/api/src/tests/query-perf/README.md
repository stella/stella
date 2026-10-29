Run `bun run test:perf` from `apps/api` with `DATABASE_URL` pointing to a
fresh, migrated PostgreSQL 18 database. The suite measures every read budget
in `apps/api/src/lib/db/read-budgets.ts` with `EXPLAIN (ANALYZE, BUFFERS)` and
fails when a measurement exceeds its budget. Budgets are absolute: nothing is
recorded, and nothing is compared with an earlier run, so a statement that has
been expensive for weeks fails as surely as a new one. The primary metric is
the root shared hit-plus-read block count; child counters already contribute
to the root and are not added again. Execution time is only a hang guard
(10 seconds). It does not use the in-process database.

Tenant and corpus profiles run in fresh databases cloned from the migrated
template; each fixture database is dropped after its clients close. The
coverage profile uses an isolated schema with a single connection and drops
it before closing the connection.

- Tenant profiles (`small`, `growth`, `seed.ts`): document search as `stella`
  under row security, with 3,000 and 100,000 documents and 200 matches in
  each. One percent of growth rows belong to the selected matter. The
  growth profile also rejects sequential scans on `search_documents`; both
  reject per-row policy subplans. A restrictive policy fixture adds a
  correlated relation probe, which must show as a per-row subplan at both
  sizes and exceed the budget on the growth profile, independently of the
  shape check.
- The corpus profile (`corpus-seed.ts`): public corpus tables in production's
  shape at a fraction of its size, measured as the owner role scheduled jobs
  run as. Statements run against it with fixed inputs. A scheduled job is
  measured per run: its registered task runs once through a client that
  records every statement, and each recorded read is analyzed. Each case-law
  scenario (a converged generation, and a generation whose whole queue is
  waiting) exists at one size and at twice that size; the run must stay in
  its budget at both and read the same pages at both (10% plus 64 pages for
  a deeper index), so a read that grows with the corpus fails however small
  the fixture is. A third scenario serves three generations at once (two
  jurisdictions flipped to their own), each with a queue past the freshness
  report's scan cap, so a cap applied per generation instead of per run goes
  over the budget.

The corpus fixture uses 60,000-row generations and a 120,000-row twin (a 2x
scale factor); equal reads at both sizes establish the bound independently of
the total corpus size. The 10-second per-statement execution guard is below
the API pool's `DATABASE_STATEMENT_TIMEOUT_MS` source in
`apps/api/src/env-base-schema.ts`; the query-perf sessions install the same
30-second upper bound explicitly. Shared buffers, rather than timing, remain
the acceptance metric.

The corpus profile also checks the gate itself on every run: the freshness
report's former unbounded reads (`unbounded-freshness-fixture.ts`) must exceed
its budget, and the census-readiness revision checks must fail the scale rule.

The coverage profile (`coverage.test.ts`) clones the production source, decision
and facet tables into an isolated schema. It runs the actual coverage source
reader at 60,000 and 120,000 decisions per large source, including a source
whose every date precedes its docket filing year. Court facets cover the large
sources; a fourth source has twenty decisions and no cached facets, exercising
the exact fallback at both sizes. Every statement the reader issues is captured
and measured with `EXPLAIN (ANALYZE, BUFFERS)` under the refresh's 30-second
statement timeout. Combined reads must fit 256 pages and remain constant at
both sizes. Court rows must sum to the published totals, valid sources retain
their date endpoints, and rejected dates produce null bounds. The production
online coverage indexes are installed from their owning DDL exports.

A budget marked `overBudget` documents a statement that is over its budget
while a change is in progress; the suite then requires it to stay over, so the
marker is removed by the change that brings the statement under.

Each statement runs once to warm the cache, then five times; the maximum
block count is the measurement. Row counts must match exactly. Fixture
sessions use a 3-second lock timeout and a 30-second statement timeout. Each
profile shares one deadline across database creation, seed and measurements
(150 seconds for a tenant profile, 300 for the corpus profile); teardown has
its own 35-second deadline. Phase logs identify pending work; failures dump
bounded activity and lock diagnostics through a separate connection.

Declarations are checked without a database by
`apps/api/src/lib/db/read-budgets.test.ts`: every scheduled job states its reads,
every MCP tool has a budget or an entry in the shrink-only ledger
`apps/api/src/lib/db/read-budgets-unmeasured.json`, and a job outside the shared
load governor stays under the per-run page ceiling.
