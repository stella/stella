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

Solo peaks do not always add up in a shared process: a finished file's PGlite memory may still be resident when the next file allocates, and whether the collector has run by then varies between runs. On identical hosted runners one two-file batch peaked anywhere from 1300 MB to 2571 MB against a 1788 MB estimate, while its heavier file alone peaked at 1250 MB, as measured. The planner therefore also learns from CI. In CI the runner appends each batch's estimate, observed peak and per-file weights to `*.rss.jsonl` beside the timing files, once its tests pass. Which files share a process depends on each run's scope, so the `API test memory feedback` workflow reads these observations from every same-repository run of CI Checks and the main suites. A run with a batch that peaked above both its composition budget (70% of its cap) and its estimate runs `apps/api/scripts/refresh-test-rss-feedback.ts`, which charges the excess to the batch's heaviest file. The surcharges live in the `api-test-rss-feedback-` Actions cache, saved from main's context. API test shards restore it into `API_TEST_RSS_FEEDBACK_FILE`. A surcharged file is planned with the surcharge, so it runs alone or beside lighter files. A surcharge only grows, lasts while its file exists, and never makes a plan impossible; without the cache, plans come from the table alone.

The runner warns when a shared batch's measured peak passes 80% of its cap (warned at 90%, failed above 100%). The run teaches the planner either way, so later runs of any branch move the batch apart.

## Hung-process diagnostics

The API runner prints each child's timestamp, lane, PID and file list as soon as it starts, even when completed batch output is grouped. CI streams Turbo output and uploads an `api-test-diagnostics-<shard>` artifact on success, failure or cancellation. It includes the dry execution plan, task output, per-child JUnit XML, rolling raw logs, `active.json`, and `failure.json` when a watchdog or signal stops the run. Artifacts expire after seven days.

`API_TEST_ARTIFACT_DIR` selects the diagnostics directory (CI uses the runner temporary directory); local runs use a fresh temporary directory. Each child's two raw log segments total at most 4 MiB, preserving recent stdout/stderr. Timeout diagnostics print the last 16 KiB for every active child. `failure.json` preserves the active identities at the first stop; `active.json` reflects current processes. JUnit is written at child completion, so raw logs and the failure registry are the evidence for a child terminated before XML is produced.

Buffered console output retains at most four million characters per child and marks truncation. This bounds the runner's memory when a stuck child emits output continuously; ordinary batch output stays unchanged.

Each test child, snapshot builder and archive validator has a ten-minute wall-clock budget. A measured CI solo chat batch ran 254 tests in 250.9 seconds; ten minutes provides more than twice that observed duration, including import and cleanup headroom. This process budget supplements the existing 30-second Bun test timeout. The supervisor stops all work once, without retries, sends SIGTERM, then SIGKILL after ten seconds if necessary. A twenty-minute runner deadline reserves time before the CI job's twenty-five-minute limit for termination and artifact upload. Review the process budget against measured batch durations when suite size changes; do not raise it merely to hide a hang.

The dedicated memory workflow runs a serial per-file sweep with a two-hour job limit, so its runner deadline is 110 minutes. Child budgets and diagnostic behavior remain the same. On POSIX, each supervised child owns a separate process group; termination also reaches descendants that hold its output pipes.
