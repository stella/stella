# Scheduler operator pauses

Job definitions are refreshed at API boot. Existing `enabled`, `paused_by`,
`paused_until`, and `pause_reason` values belong to the operator and survive
that refresh. New jobs are enabled by default.

A job can run when `enabled` is true and `paused_until` is either `NULL` or in
the past. `NULL` means unpaused; `'infinity'::timestamptz` pauses indefinitely.
An elapsed finite pause resumes automatically. The runner clears expired
`paused_until` values while retaining attribution and reason.

Use an authorized database operator connection; the application role cannot
access scheduler tables. Record an operator identifier and a reason in the
same update as each pause or resume. Keep reasons free of sensitive data:
pause transitions are emitted in database logs.

```sql
-- Pause indefinitely. Replace the identifier, reason, and job ID.
UPDATE scheduler_jobs
SET paused_by = 'operator-id',
    pause_reason = 'Scheduled maintenance',
    paused_until = 'infinity'::timestamptz,
    updated_at = now()
WHERE id = 'job-id'
RETURNING id, enabled, paused_by, paused_until, pause_reason;

-- Pause for a bounded interval.
UPDATE scheduler_jobs
SET paused_by = 'operator-id',
    pause_reason = 'Temporary maintenance',
    paused_until = now() + interval '30 minutes',
    updated_at = now()
WHERE id = 'job-id'
RETURNING id, enabled, paused_by, paused_until, pause_reason;

-- Resume. This preserves a separately disabled job's enabled state.
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
deadline produces no duplicate transition event. A runner that encounters an
active pause during execution emits `scheduler.job.paused_job_ran` at error
level and prevents execution.

Pauses prevent subsequent executions. Existing executions stop cooperatively
at cancellation checkpoints; pausing cannot undo side effects already performed.
