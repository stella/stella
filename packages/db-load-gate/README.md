# @stll/db-load-gate

Transport-free health decisions and adaptive throttling for database maintenance.

Import explicit entry points: `/health`, `/indicators`, and `/slot`.

`combine` uses worst-wins severity: stop, unknown, degraded, normal. Index starts
require normal health; backfill batches may run degraded with smaller batches.
Unknown health blocks starts and holds batches, but never cancels running work.
`decideWhileRunning` cancels after two consecutive real EBS readings below the
configured hard floor. Optional build progress appears only in the logged record.
All decisions carry the signal values, thresholds and effective configuration.

`nextBatch` bounds each size step to 0.5–1.2, smooths duration, grows after stable
batches and adjusts sleep. Holds preserve size and carry `heldSince` and
`holdUntil`; consumers persist them. `isHeldTooLong` uses the first hold in a streak.
Readers, clocks and timeout scheduling are injectable; failures become unknown.

The priority slot is database-wide: index repair, index build, backfill batch.
Index sessions retain shared intent locks across unsuccessful attempts and close
them when finished. Session death releases both intent and work ownership.
Backfills can use transaction locks, so ownership ends with their batch's commit,
rollback or backend death. A higher-priority intent blocks the next batch.
Consumers retain a dedicated physical session for session locks and call one
handle sequentially. The slot never polls or waits for the work lock.

API wiring lives in `apps/api/src/db/backfill-runtime.ts`. It commits writes and
checkpoints together, persists holds, reduces timed-out batches without advancing
the cursor, enforces configured local statement/lock budgets, and returns control on a hold. Completed passes reset their cursor so
subsequent rule changes can rescan; every write must remain idempotent.
The one CloudWatch adapter is `apps/api/src/lib/db/ebs-balance-reader.ts`.
The runtime requires `DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER`; an absent identifier
produces unknown health. Region and credentials use the AWS SDK provider chain.

Targeted unit tests run through `bun run test src/health.test.ts` or
`src/indicators.test.ts` in this package. API fault and catalog tests are gated by
`STELLA_RUN_POSTGRES_TESTS=true` and use the repository's Postgres 18 CI runner.

Apache-2.0. Mechanisms are independently reimplemented; batch sizing credits
GitLab's MIT optimizer.
