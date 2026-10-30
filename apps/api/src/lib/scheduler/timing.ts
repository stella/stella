/**
 * The scheduler's own timing constants, with no imports so the migrate step
 * can derive its drain bounds from them (`db/migration-scheduler-drain.ts`).
 */

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_LEASE_MS = 30 * 60_000;
export const MIN_LEASE_MS = 3 * DEFAULT_POLL_INTERVAL_MS;

// Hard upper bound on how long a single task may run. The lease heartbeat
// renews `lockedUntil` indefinitely, so without this ceiling a task that never
// resolves would block the sequential runner AND keep the lease fresh forever,
// defeating the self-heal the lease exists for. Set to one lease period: a job
// that has not finished within a full lease is treated as hung. A JS promise
// cannot be force-cancelled, so on expiry the ceiling aborts the task's signal
// (cooperative tasks unwind), stops the heartbeat, and releases the job.
export const DEFAULT_MAX_RUNTIME_MS = DEFAULT_LEASE_MS;

/** How often a running job checks for a pause; a lease releases only when it settles. */
export const defaultHeartbeatIntervalMs = (leaseMs: number): number =>
  Math.max(DEFAULT_POLL_INTERVAL_MS, Math.floor(leaseMs / 3));
