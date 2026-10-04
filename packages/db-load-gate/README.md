# @stll/db-load-gate

Transport-free health decisions and adaptive throttling for database maintenance.

Import explicit entry points: `/health`, `/indicators`, and `/slot`.

`combine` uses worst-wins severity: stop, unknown, degraded, normal. An explicitly
disabled indicator reports `not_configured`, which remains in the logged signals
and contributes no blocking severity. Index starts
require normal health; backfill batches may run degraded with smaller batches.
Unknown health blocks starts and holds batches, but never cancels running work.
`decideWhileRunning` cancels after two consecutive real EBS readings below the
configured hard floor. Optional build progress appears only in the logged record.
All decisions carry the signal values, thresholds and effective configuration.

`nextBatch` bounds each size step to 0.5–1.2, smooths duration, grows after stable
batches and adjusts sleep. Holds preserve size and carry `heldSince` and
`holdUntil`; consumers persist them. Optional `resumeFloor` keeps a held batch
held by the load band until a fresh EBS reading reaches that floor; other holds
resume when their cause clears, and disabled EBS does not apply hysteresis. Omitting it preserves degraded
resumes. It must lie between `hardFloor` and `startFloor`. Deferrable backfills use
65/75/80 for hard/resume/start floors. `isHeldTooLong` uses the first hold in a streak.
`backfillHeartbeat` returns an EMF record for callers to emit every minute,
including while held: `Stella/Backfill`, `BackfillYielded` (0/1), dimension
`Backfill`. It includes the verdict, transition event and held-duration flag;
callers supply the previous held timestamp to identify resumes.
Readers, clocks and timeout scheduling are injectable; failures become unknown.
The indicator timeout is logical: it returns unknown without cancelling an
injected reader. SQL readers must cancel or bound their database work and await
cleanup before reusing the session. The API adapter runs catalog reads in
serialized transactions with a local statement timeout and drains cancellation
and rollback before returning its verdict. CloudWatch requests use the effective
staleness window and an abort signal.

The priority slot is database-wide: index repair, index build, operator job, backfill batch.
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
EBS configuration has three explicit states:

- `DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER` set: read CloudWatch using the AWS SDK
  region and credential provider chain. The identifier takes precedence if an
  opt-out is also present; read failures and missing/stale metrics remain unknown.
- `DB_LOAD_GATE_EBS_SIGNAL=disabled` with no identifier: for non-RDS, self-hosted
  and local databases, report the nonblocking `not_configured` signal in every
  decision. Transaction, autovacuum, busy-window and priority gates still apply.
- Neither supplied: the migrator fails with `EbsConfigurationMissingError`
  before it connects, since a held index build would block the deploy. Background
  maintenance reports unknown, holds and emits one
  `database_load_gate_ebs_configuration_missing` error event per reader lifetime
  naming both configuration keys. There is no implicit opt-out.

Targeted unit tests run through `bun run test src/health.test.ts` or
`src/indicators.test.ts` in this package. API fault and catalog tests are gated by
`STELLA_RUN_POSTGRES_TESTS=true` and use the repository's Postgres 18 CI runner.

Apache-2.0. Mechanisms are independently reimplemented; batch sizing credits
GitLab's MIT optimizer.

Intent keys remain stable across rolling deployments. Operator jobs use a new
key and also register an index-build intent for older backfill processes. New
priority probes distinguish that compatibility intent from an index build;
each dedicated session owns one logical handle. Remove the compatibility
intent once every process using the pre-operator priority protocol has drained.
`holdCause` is persisted with the batch. Older checkpoints without that field
have no recorded load cause and resume as other holds. Heartbeat yield/resume
events occur only on transitions; `signalEvent` retains unknown-signal reporting
on a transition tick.
