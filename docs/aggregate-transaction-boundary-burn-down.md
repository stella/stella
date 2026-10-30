# Aggregate transaction boundary burn-down

The database aggregate owner (`apps/api/src/lib/db/aggregate-lock.ts`) owns this migration. Each feature slice migrates its callers as one transaction family, preserving isolation, lock order, and the caller's measured runtime envelope.

The starting source census for this change is 257 raw API transaction occurrences: 254 `.transaction` calls and three native `.begin` calls (two pool-reservation adapters and one database-census command). Counting baseline reason prefixes reported 238 because reviewed rekeys replace some reasons with explanatory prose. Source occurrences, not reason text, are the debt measure.

The ratchet applies these UTC checkpoints in addition to the per-file shrink-only rule:

| Effective date (UTC) | Maximum raw boundaries |
| -------------------- | ---------------------: |
| 2026-11-13           |                    200 |
| 2026-11-27           |                    100 |
| 2026-12-11           |                      0 |

The first checkpoint removes at least 57 occurrences from the starting census. Main pushes and scheduled checks fail above the active ceiling. Pull requests and merge groups fail above it when they increase the raw-site count or touch a file with raw sites in either the measured base or head; this includes deleting or migrating a raw-site file. Unrelated changes receive a warning annotation with the current count, active ceiling, and next deadline instead. Local checks default to this change scope against the same measured comparison base. The per-file growth guard remains blocking in every mode, and allowances cannot fund deadline failures.

The permanent `raw-transaction-deadlines` rollout records the canonical check; its mode policy has no expiry. Native driver adapters that necessarily open physical transactions must delegate to the canonical budget owner; registering an adapter requires a distinct owner contract and tests, not a generic exception.

At this checkpoint, scoped/public request transactions use 30,000 ms and the largest ordinary transaction budget is 119,000 ms, strictly below the 120,000 ms migration ladder. The registry is authoritative. Lease-coordinated scheduler owners and background helpers awaiting measured runtimes remain explicitly classified; a shorter deadline is not inferred from a request caller.

1. Migrate request transaction families first, using the authorized request budget and retaining tenant-local role and identity setup.
2. Migrate worker and scheduler families using their recorded batch cardinalities and measured transaction durations; do not inherit an interactive budget for background work.
3. Migrate maintenance and native-driver adapters last. Corpus scheduler owners retain their explicit lease-coordinated classification and census; long work needs its registered drain contract or independently committed checkpoints.

`raw-api-transaction-boundaries` in `scripts/ratchet.ts` measures both trees with the same scanner. The total and every file can only shrink; deleting calls in one file cannot fund new calls elsewhere. `check:aggregate-locks` retains the exact-site inventory and reasons. Its generator reads merge-base source with the current detector, so newly detected old syntax can enter the census while a newly added boundary cannot enroll itself.

After each family migration, run `bun scripts/check-aggregate-locks.ts --generate`, `bun scripts/check-aggregate-locks.ts`, and `bun scripts/ratchet.ts --check`; remove the migrated exact-site rows through the generator. Never raise a baseline or add an allowance to meet a checkpoint.
