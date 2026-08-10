/** ISO 4217 code for an entry whose financial value has not been configured. */
export const UNPRICED_TIME_ENTRY_CURRENCY = "XXX";

/** Effective visibility of list_time_entries for the calling member. */
export const TIME_ENTRY_VISIBILITY = {
  ALL_ENTRIES: "all_entries",
  OWN_ENTRIES: "own_entries",
} as const;
