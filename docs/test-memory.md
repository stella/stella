# API test memory measurements

The API test memory workflow measures each test file in its own process, with one lane per shard. It runs in four shards on Sundays at 02:23 UTC and supports manual dispatch. Each shard also measures an empty test with the same preload. Its versioned JSON receipt records that baseline, operating system, architecture, Bun version, runner image, run ID, job, and failed measurements. The workflow never writes commits.

Download all four artifacts from the same successful run into `rss-artifacts`, then refresh from the repository root:

```sh
bun apps/api/scripts/refresh-test-peak-rss.ts rss-artifacts apps/api/scripts/test-peak-rss.json
```

The command recursively reads JSON receipts and writes a sorted, formatted table only after their union covers every current API test exactly once. It refuses mixed environments, invalid baselines or peaks, malformed provenance, failed tests, unsafe paths, duplicates, deleted tests, and missing tests. It reports new files and the largest relative peak change against the current table. Review the report and table diff before committing.

Batch composition uses the largest shard baseline plus each file's positive increase above its own shard baseline: `max(baselines) + sum(max(0, peak - fileBaseline))`. Peaks below their baseline are valid process noise. The initial uncalibrated table has no baseline provenance and uses a conservative raw sum until refreshed. Measurements guide composition; runtime memory limits remain authoritative.
