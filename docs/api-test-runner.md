# API test runner

`bun run test` in `apps/api` runs `apps/api/scripts/run-tests.ts`, which hands the suite to Bun:

- Files come from the runner roots (`src`, `evals`, `scripts`). A test file outside them fails the run, so it cannot sit unrun.
- `bun test --parallel` runs the files in worker processes, one core fewer than the machine has. Each file gets a fresh global, module registry and `process.env`, so module mocks, module state and a variable set at module scope never reach another file. `src/tests/parallel-env-isolation.test.ts` holds Bun to the environment part.
- A DB-backed file boots PGlite from a snapshot the runner builds once (cached locally, private on CI). A run of logic files only skips the build.

## Shards and durations

CI runs the API suite in shards. `API_TEST_SHARD=i/n` selects one; every shard partitions the same file list by the same planned durations, longest file first, so each shard gets work and none overlaps another. `API_TEST_FILES` restricts the list for a pull request's affected tests.

The planned durations come from main: each shard runs `bun test --update-timings`, and `apps/api/scripts/refresh-test-durations.ts` keeps the median of the recent measurements per file. A file without a measurement takes the median of the others. The runner also passes the planned durations to `--timings`, so each worker starts with its slowest file.

## Diagnostics

`API_TEST_ARTIFACT_DIR` makes the runner write a JUnit report there; CI uploads it with the task output as `api-test-diagnostics-<shard>`. A test that exceeds the 30-second Bun timeout fails on its own; the CI job's time limit bounds the run.
