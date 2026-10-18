# Flaky-test quarantine

`scripts/flaky-test-quarantine.json` lists Bun tests whose failures must not
fail pull requests or merge groups while their owner fixes them. A quarantined
test still runs and reports; only its verdict changes.

## Entries

```json
{
  "id": "apps/web/src/widget.test.ts::widget > renders",
  "owner": "octocat",
  "reason": "Times out under parallel load.",
  "created": "2026-10-17",
  "expires": "2026-10-31"
}
```

- `id`: the repository path of a `*.test.*` file, `::`, then the full test name
  as Bun prints it, with `describe` segments joined by a spaced `>`.
- `owner`: a GitHub login, without `@`.
- `created` and `expires`: UTC calendar dates. The entry covers the whole expiry
  day and at most 30 days in total.

Entries stay sorted by `id`. `scripts/flaky-test-quarantine.test.ts` validates
the schema, the canonical serialization, and that each file exists and still
contains the test's title.

## In CI

The `ci-tests` steps load `scripts/flaky-test-quarantine-preload.ts` through
`BUN_OPTIONS`. It wraps the body of each quarantined `test`/`it` (including
`only`, `concurrent` and `serial`): a throw, rejection or timeout is recorded
and printed as `(quarantined fail)`, and the process keeps its verdict for the
other tests. Hooks, `expect.assertions` counts and table forms such as
`test.each` are not covered; an entry that matches no test in a file that ran
is annotated as stale.

The step after the tests annotates each quarantined failure, writes the test's
outcome and its recent history to the job summary, and uploads the outcomes as
`flaky-test-quarantine-<shard>`. Turbo hashes `FLAKY_TEST_QUARANTINE_DIGEST`,
so a cached pass never replays under a different registry.

## Expiry

Expiry is time-based, so it never fails an unrelated change: on pull requests
and merge groups the dated-waiver check (`scripts/dated-waivers.ts`) only
annotates an elapsed entry. The daily `flaky-test-quarantine.yml` run on main
fails on an elapsed entry with one error annotation naming its test, owner and
expiry. The dated-waiver healing workflow probes entries in the five days
before expiry, running the test 20 times without its entry, and proposes the
removal when every run passes.

## Proposals

The same workflow scans the last seven days of CI evidence: the result gate's
failure digests (`ci-failures`, failed tests per attempt), the changed-test
flake gate's per-test repeat counts, and the quarantine outcomes. A test that
failed and then passed on the same commit, on three commits, is proposed in a
pull request on `chore/flaky-test-quarantine`, owned by the last matching rule
in `.github/CODEOWNERS`, and expiring after 14 days. Files without a matching
owner are listed in the proposal but are not added. Proposals are never queued
automatically. The scan also publishes the `flaky-test-history` artifact that
CI job summaries read. It reports non-aggregate, non-cancellation CI check
steps that failed before a successful run or re-run of the same commit in the
history JSON and the proposal's **Flaky checks** table. Check flakes are never
added to the test quarantine registry.
