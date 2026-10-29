Run `bun run test:perf` from `apps/api` with `DATABASE_URL` pointing to a
fresh, migrated PostgreSQL 18 database. The suite measures every read budget
in `apps/api/src/lib/db/read-budgets.ts` with `EXPLAIN (ANALYZE, BUFFERS)` and
fails when a measurement exceeds its budget. Budgets are absolute: nothing is
recorded, and nothing is compared with an earlier run, so a statement that has
been expensive for weeks fails as surely as a new one. The primary metric is
the root shared hit-plus-read block count; child counters already contribute
to the root and are not added again. Execution time is only a hang guard
(10 seconds). It does not use the in-process database.

Each profile runs in its own fresh database cloned from the migrated
template; the fixture database is dropped after its clients close.

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

- Global Case Law search (`case-law-search-fixture.ts`): 3,000 and 30,000
  decisions with 200 fixed full-text matches and an 11-row page. Wide section
  bodies exercise TOAST reads. The production statement must fit its buffer
  budget at both sizes and preserve the same rows, fields and ordering as a
  control that moves the page bound after enrichment. That control must exceed
  the budget. Logs report both measurements and plans; the read cost must stay
  stable as unrelated decisions grow.

The corpus profile also checks the gate itself on every run: the freshness
report's former unbounded reads (`unbounded-freshness-fixture.ts`) must exceed
its budget, and the census-readiness revision checks must fail the scale rule.

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
