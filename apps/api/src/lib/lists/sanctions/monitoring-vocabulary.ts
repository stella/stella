import { SANCTIONS_SCREENING_STATUSES as SANCTIONS_LIST_SCREENING_STATUSES } from "@/api/lib/lists/sanctions/screening-vocabulary";

export const SANCTIONS_MONITORING_MODES = ["enabled", "disabled"] as const;
export const SANCTIONS_CONTACT_MODES = ["included", "excluded"] as const;
export const SANCTIONS_REVIEW_DISPOSITIONS = [
  "needs-review",
  "dismissed",
  "confirmed",
] as const;
export const SANCTIONS_MATCH_STATES = ["active", "lapsed"] as const;
export const SANCTIONS_MONITORING_EVENT_TYPES = [
  "new",
  "changed",
  "lapsed",
  "reopened",
  "dismissed",
  "review-restored",
  "confirmed",
] as const;

export const SANCTIONS_SCREENING_STATUSES = [
  ...SANCTIONS_LIST_SCREENING_STATUSES,
  "excluded",
] as const;

/** Changed evidence stays in history; only new and reopened hits notify. */
export const SANCTIONS_NOTIFICATION_EVENT_TYPES = [
  "new",
  "reopened",
] as const satisfies readonly (typeof SANCTIONS_MONITORING_EVENT_TYPES)[number][];
