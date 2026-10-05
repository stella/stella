# API test memory measurements

The API test memory workflow measures each test file in its own process, with one lane per shard. It runs in four shards on Sundays at 02:23 UTC and supports manual dispatch. Each shard also measures an empty test with the same preload. Its versioned JSON receipt records that baseline, operating system, architecture, Bun version, runner image, run ID, job, measurement time, shard, the number of files the shard owns, and failed measurements.

When every shard of a run on `main` succeeds, the workflow's refresh job runs the command below on that run's receipts against current `main` and opens a pull request titled `chore(ci): refresh API test memory profile` from `chore/refresh-api-test-memory`. The job fails if anything other than `apps/api/scripts/test-peak-rss.json` changed. A later run replaces the open pull request instead of opening another. Review the change report in the pull request body and the job summary before merging.

The table records when its run finished measuring (`measuredAt`). Once that is more than 14 days old, the API test runner (first shard only) emits a non-blocking `API test memory profile is stale` warning: merge the open refresh pull request or rerun the workflow.

To refresh by hand, download all four artifacts from the same successful run into `rss-artifacts`, then run from the repository root:

```sh
bun apps/api/scripts/refresh-test-peak-rss.ts rss-artifacts apps/api/scripts/test-peak-rss.json
```

The command recursively reads JSON receipts and writes a sorted, formatted table only when they cover every shard of one run and every file each shard owns. It refuses mixed environments or runs, missing or duplicate shards, partial shards, invalid baselines or peaks, malformed provenance, failed tests, unsafe paths, and duplicates. The tree usually moved on since the run: tests deleted since are dropped, and tests added since stay unmeasured until the next run. It reports new, unmeasured and removed files and the largest relative peak change against the current table. Review the report and table diff before committing.

Batch composition uses the largest shard baseline plus each file's positive increase above its own shard baseline: `max(baselines) + sum(max(0, peak - fileBaseline))`. Peaks below their baseline are valid process noise. A shared batch's estimate stays within 70% of its class cap; an unmeasured file reserves 40% of that share. Measurements guide composition; runtime memory limits remain authoritative.

The runner warns when a shared batch's measured peak passes 80% of its cap: its plan came from a stale or missing measurement, so refresh the table before the batch nears the cap (warned at 90%, failed above 100%).
