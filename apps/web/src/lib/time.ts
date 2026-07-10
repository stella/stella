// Named duration constants for plain elapsed-time math (TTLs, staleness
// thresholds, rolling windows, polling intervals). These are DURATIONS,
// not calendar units: a calendar day is not always 24 hours (a DST
// transition day is 23 or 25), so computing another calendar date must go
// through `addDays` in `./dates.ts` instead of adding `DAY_IN_MS`.
//
// The `no-raw-date-parsing` lint rule flags raw day-length literals
// (`24 * 60 * 60 * 1000`, `86_400_000`) and points here; this module is
// the one allowlisted place the literal may appear. Mirrored in
// `apps/api/src/lib/time.ts`.

/** 24 hours in milliseconds. A duration, not a calendar day. */
export const DAY_IN_MS = 24 * 60 * 60 * 1000;
