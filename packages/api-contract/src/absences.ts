export const ABSENCE_KINDS = ["vacation", "sick", "other"] as const;
export const ABSENCE_COVERAGES = ["full", "half"] as const;
export const ABSENCE_HALF_DAY_SEGMENTS = ["morning", "afternoon"] as const;
export const ABSENCE_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "cancelled",
] as const;
