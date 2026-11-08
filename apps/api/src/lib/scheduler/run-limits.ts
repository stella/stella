/** How long a claimed job's lease lasts before the heartbeat must renew it. */
export const SCHEDULER_LEASE_MS = 30 * 60_000;

/**
 * The longest one task run may take before the runner aborts its signal: one
 * lease period. A task that does several independent pieces of work gives
 * each piece a share of it, so one slow piece cannot starve the rest.
 */
export const SCHEDULER_MAX_RUNTIME_MS = SCHEDULER_LEASE_MS;
