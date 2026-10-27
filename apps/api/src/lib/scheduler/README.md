# Scheduler operator pauses

Job definitions are refreshed at API boot. `enabled` follows the deployment's
configuration feature gates on every boot. Operator control uses only
`paused_by`, `paused_since`, `paused_until`, and `pause_reason`, which survive that refresh.
New jobs are enabled by default unless their configuration gate disables them.

## Stopping a runaway job

Run the guarded operator command from `apps/api`. Start without `--apply` to
review the current row and resulting deadline, then repeat the same command
with `--apply` using an authorized operator database connection:

```sh
bun run scheduler:job-pause -- pause --job documentProcessing.dispatchOcr.configuredInterval --for 24h --reason "Runaway queue growth" --actor operator-id
bun run scheduler:job-pause -- pause --job documentProcessing.dispatchOcr.configuredInterval --for 24h --reason "Runaway queue growth" --actor operator-id --apply
bun run scheduler:job-pause -- status --job documentProcessing.dispatchOcr.configuredInterval
bun run scheduler:job-pause -- resume --job documentProcessing.dispatchOcr.configuredInterval --reason "Queue is stable" --actor operator-id --apply
```

The pause auto-resumes at its deadline. The hourly audit flags an active pause
older than 24 hours. If the script is unavailable, use the SQL below as the
fallback.

A job can run when `enabled` is true and `paused_until` is either `NULL` or in
the past. `NULL` means unpaused. A pause may be at most 72 hours from the time
it is written. An elapsed pause resumes automatically. The runner clears expired
`paused_until` values while retaining attribution and reason. Renew a pause by
updating `paused_until`; renewal keeps the original `paused_since` value.

Use an authorized database operator connection; the application role cannot
access scheduler tables. Record an operator identifier and a reason in the
same update as each pause or resume. Keep reasons free of sensitive data:
pause transitions are emitted in database logs. Every non-null pause deadline
requires a nonblank operator identifier and a reason of at least eight
characters after trimming spaces; the database enforces this requirement.

```sql
-- Pause for a bounded interval.
UPDATE scheduler_jobs
SET paused_by = 'operator-id',
    pause_reason = 'Temporary maintenance',
    paused_until = now() + interval '30 minutes',
    updated_at = now()
WHERE id = 'job-id'
RETURNING id, enabled, paused_by, paused_until, pause_reason;

-- Resume. The deployment's configuration gate still controls eligibility.
UPDATE scheduler_jobs
SET paused_by = 'operator-id',
    pause_reason = 'Maintenance complete',
    paused_until = NULL,
    updated_at = now()
WHERE id = 'job-id'
RETURNING id, enabled, paused_by, paused_until, pause_reason;
```

Check the returned row to confirm the target and resulting state. The database
emits JSON `scheduler.job.paused` and `scheduler.job.resumed` events when
`paused_until` changes, including the job, attribution, reason, and previous
deadline. Updating a future pause emits a pause event; setting a past deadline
or clearing an expired deadline emits a resume event. Repeating the same
deadline produces no duplicate transition event. A runner that meets an active
pause before a leased run starts, or at a heartbeat while it runs, skips or
stops the run and emits `scheduler.job.pause_honored` at info level with its
`phase` (`before_start` or `while_running`): the pause worked, so it is
operator-owned state, not an error. Only a run that completes after its pause
committed emits `scheduler.job.paused_job_ran` at error level, because that
work ran under the pause.

The hourly pause audit emits `scheduler.job.pause_overdue` at error level for
each active pause that began more than 24 hours ago, including active legacy
pauses without `paused_since`. An alarm can match this event.

Pauses prevent subsequent executions. Existing executions stop cooperatively
at cancellation checkpoints; pausing cannot undo side effects already performed.

The recurring provision-state and expression-id backfills use the shared load
runtime: yield below 65%, throttle below 80%, and resume a load-caused hold only
at 75% or higher. Operator pause eligibility is checked by the runner before a
task initializes its runtime. Automatic holds belong to
`database_backfill_states`, never to `scheduler_jobs.paused_until`.

Provision-state keeps one dedicated reserved session, its five-minute run
budget, and the separate 25-minute CHECK validation budget. Its existing repair
cursors and runtime status commit with each unit. Expression ids keep a
1,000-row ceiling and at least one second between continuation runs; the initial
runtime cursor adopts a previously persisted scheduler payload cursor only
when its checkpoint does not yet exist. Later runs use the runtime checkpoint.

EBS readers share a process cache for 120 seconds and coalesce concurrent
requests. A failed refresh retains the last real datapoint with its original
timestamp; the signal becomes unknown once that datapoint is older than 15 minutes.

`backfill.heartbeat.minutely` emits one root EMF gauge per known backfill from
its durable status and operator pause. Checkpoint age is not metric age: load
freshness belongs to the signal reader, and a completed or long-running unit
must not become yielded merely because its checkpoint is old. Batch transitions
are ordinary structured logs, so they cannot inflate the minutely gauge.
Completed provision-state work rechecks completion under the checkpoint lock
before clearing status; an obsolete admission leaves current status alone.

## Online work steps

Online work has its own durable per-step pause; pausing the scheduler admission
job alone cannot stop a unit already detached from its tick. Use the same
attributed dry-run/apply convention, with a registered step name:

```sh
bun run online:step-pause -- status --step contacts_invoice_language_check
bun run online:step-pause -- pause --step contacts_invoice_language_check --for 24h --reason "Maintenance window" --actor operator-id
bun run online:step-pause -- pause --step contacts_invoice_language_check --for 24h --reason "Maintenance window" --actor operator-id --apply
bun run online:step-pause -- resume --step contacts_invoice_language_check --reason "Maintenance complete" --actor operator-id --apply
```

The database bounds deadlines to 72 hours and records the actor, reason, start,
and deadline in `online_work_state`. A step checks its pause at admission,
before statements, at backfill boundaries, and at index watchdog heartbeats;
expiry permits automatic admission again. Completed steps cannot reopen.
Pressure holds remain automatic governor decisions, separate from operator
pause deadlines. A deferred unit returns to pending unless an operator pause
has committed; completion and failure cannot overwrite that pause.

The rollout adapter accepts the foundation runner's `building`/`finalized`
writes and stores `running`/`done`. Its trigger refuses a legacy claim under an
active operator pause and preserves a pause against a legacy finish. Remove
that adapter once every foundation-release task has been replaced.

A foundation task already detached before this rollout has no pause checkpoints.
Its execution must finish or the old process must be replaced before per-step
pauses can stop that execution. New claims from old tasks are fenced in the
database; remove the legacy adapter after the last foundation process is gone.

The shared pressure verdict also reads active sessions and replication lag from
aggregate PostgreSQL statistics. A caught-up primary with no replicas reports
zero lag; unavailable statistics, unknown replica positions, and standby reads
hold maintenance. Rising CPU, read/write IOPS and read/write throughput use the
same configurable throttle/pause thresholds, set with
`DB_LOAD_GATE_PRESSURE_THRESHOLDS` as a complete JSON object. Index admission
requires normal pressure. Backfills shrink and sleep when pressure is degraded;
stop or unknown pressure holds batches with bounded exponential backoff.
Two consecutive unsafe or unknown verdicts cancel an index build; a later
healthy verdict allows a retry. Operator pauses cancel at the next heartbeat.

RDS host readings first use Performance Insights when read-only instance
discovery reports enabled, seven-day retention and no advanced mode. Discovery
is refreshed at each ten-minute host refresh; nothing enables monitoring or
changes retention. Otherwise five standard RDS metrics use one CloudWatch
`GetMetricData` request. A database refresh claim and snapshot share the result
across processes, with at most one provider attempt per instance per ten minutes
(including failed attempts). Every reading keeps its provider timestamp;
unavailable refreshes retain the last real snapshot until freshness expires.
This adds at most 144 CloudWatch requests (720 metrics) per day per configured
instance, or USD 0.216 for 30 days at USD 0.01 per 1,000 metrics. The existing
EBS reader and its 120-second process cache remain separately accounted for.
Only `rds:DescribeDBInstances`, `pi:GetResourceMetrics` and
`cloudwatch:GetMetricData` read permissions are required by these adapters.
