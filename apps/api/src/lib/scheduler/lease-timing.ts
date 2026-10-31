/** Shared by scheduler ownership and migration table-lease deadlines. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_LEASE_MS = 30 * 60_000;

export const defaultHeartbeatIntervalMs = (leaseMs: number): number =>
  Math.max(DEFAULT_POLL_INTERVAL_MS, Math.floor(leaseMs / 3));
