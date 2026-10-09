Run `bun run test:perf` from `apps/api` with `DATABASE_URL` pointing to a
fresh, migrated PostgreSQL 18 database. The suite uses the shared stella-role
EXPLAIN helper, enables RLS, applies each committed planner setting inside
each transaction, and asserts its effective `SHOW` value before accepting a
measurement. It does not use the in-process database.

`seed.ts` owns the replaceable seed contract. It loads each committed synthetic
profile and delegates fresh data to `seedProdShaped`; restored data is read by
`readSeededProfile`, the same owner of identities and caller-visible counts.
Each small/growth profile has a fresh migrated database. Exact snapshot keys
hash migrations, synthetic inputs, the seed import closure and planner settings.
Caches have no fallback keys. A valid miss is saved only after that profile's
measurement callback passes, before the database is dropped.

Restore reports cache download, archive restore, and full fixture preparation
durations, including validation and identity reads. The total adds download to
full preparation time. Fresh generation reports seed duration and archive bytes. Archive
clients use the same pinned PostgreSQL image as the service; snapshot operations
finish before query repetitions begin.

Each registry query runs once to warm the cache, then five times sequentially.
The primary metric is the maximum root shared hit-plus-read block count;
child counters already contribute to the root and are not added again.
Execution time is the median of the five samples. A run fails above 1.25 times
the buffer baseline, or above twice the time baseline and 10 ms. Measurements
at or above 95% of the buffer budget are flagged in the report.
The growth profile also rejects sequential scans on `search_documents`;
both profiles reject per-row policy subplans.

The baseline records each profile and entry separately and binds the seed and planner
settings. To record a reviewed new baseline locally, run
`QUERY_PERF_RECORD_BASELINE=true bun run test:perf`. Recording does not perform
the planted-policy check; run normal `test:perf` afterward.
For a hosted re-recording, dispatch `query-perf.yml` on `main`;
this schedules only `query-perf`.
Download the `query-perf-baseline-record-<sha>`
artifact, commit its JSON, then run the comparison suite against that commit.
PR and merge-group runs always compare against the committed baseline.
An entry without a committed baseline is measured and included in a validated
recording artifact; the job fails with instructions to commit that artifact.
Existing entries retain their committed budgets in the recording. After the
baseline is committed, comparison also verifies the planted policy fixture.
Baseline increases require the PR-scoped declarations described in
`scripts/query-perf-allowances/README.md`.

The restrictive policy fixture adds a correlated relation probe. The test
requires it to exceed the committed buffer budget independently of the
plan-walker shape check, then removes the fixture in `finally`.
