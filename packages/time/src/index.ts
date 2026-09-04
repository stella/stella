// Time the apps agree on: named duration constants for elapsed-time math
// (TTLs, staleness thresholds, rolling windows, polling intervals), and the
// calendar-date helpers in `./dates`.
//
// The two are not interchangeable. `DAY_IN_MS` is a DURATION: a calendar day
// is not always 24 hours (a DST transition day is 23 or 25), so computing
// another calendar date goes through `addDays`, never through adding
// `DAY_IN_MS`.
//
// The `no-raw-date-parsing` lint rule flags raw day-length literals
// (`24 * 60 * 60 * 1000`, `86_400_000`) and date-only `new Date("...")`
// parsing, and points here; this package is the one home for both.

/** 24 hours in milliseconds. A duration, not a calendar day. */
export const DAY_IN_MS = 24 * 60 * 60 * 1000;

export {
  addDays,
  isIsoDateString,
  isoDateParts,
  type IsoDateParts,
  parseIsoDateLocal,
} from "./dates";
