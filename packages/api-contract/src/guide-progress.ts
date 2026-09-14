// Guide progress is a per-user JSON map the API patches one tour at a time.
// The tour ids and statuses are the wire vocabulary: the web registry derives
// its tour ids from this list (guide-types.ts binds both directions at
// compile time), and the API validates against it, so neither side can drift.
export const GUIDE_PROGRESS_TOUR_IDS = [
  "chat",
  "chat-power",
  "documents",
  "playbooks",
  "workflows",
  "tabular-review",
] as const;

export type GuideProgressTourId = (typeof GUIDE_PROGRESS_TOUR_IDS)[number];

export const GUIDE_PROGRESS_STATUSES = [
  "not-started",
  "completed",
  "skipped",
] as const;

export type GuideProgressStatus = (typeof GUIDE_PROGRESS_STATUSES)[number];
