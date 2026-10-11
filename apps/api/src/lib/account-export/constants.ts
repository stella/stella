export const ACCOUNT_EXPORT_STATUSES = [
  "requested",
  "processing",
  "ready",
  "failed",
  "expired",
] as const;

export const ACCOUNT_EXPORT_LIMITS = {
  ttlMs: 60 * 60 * 1000,
  leaseMs: 15 * 60 * 1000,
  publicationCancellationMarginMs: 30 * 1000,
  attempts: 5,
  recoveryPageSize: 100,
  requestsPerWindow: 3,
  requestWindowMs: 60 * 60 * 1000,
} as const;

export const ACCOUNT_EXPORT_ACTIVE_STATUSES = [
  "requested",
  "processing",
  "ready",
] as const satisfies readonly (typeof ACCOUNT_EXPORT_STATUSES)[number][];
export const ACCOUNT_EXPORT_IDLE_STATUSES = [
  "requested",
  "failed",
  "expired",
] as const satisfies readonly (typeof ACCOUNT_EXPORT_STATUSES)[number][];
