export const SANCTIONS_MONITORING_MODES = ["enabled", "disabled"] as const;
export const SANCTIONS_CONTACT_MODES = ["included", "excluded"] as const;
export const SANCTIONS_REVIEW_DISPOSITIONS = [
  "needs-review",
  "dismissed",
] as const;
export const SANCTIONS_MATCH_STATES = ["active", "lapsed"] as const;
export const SANCTIONS_MONITORING_EVENT_TYPES = [
  "new",
  "changed",
  "lapsed",
  "reopened",
] as const;
