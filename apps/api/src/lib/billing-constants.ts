export { UNPRICED_TIME_ENTRY_CURRENCY } from "@stll/api-contract";

/** Effective visibility of list_time_entries for the calling member. */
export const TIME_ENTRY_VISIBILITY = {
  ALL_ENTRIES: "all_entries",
  OWN_ENTRIES: "own_entries",
} as const;
