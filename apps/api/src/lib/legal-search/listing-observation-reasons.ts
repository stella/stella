// parser-output-unchanged: observation reasons move unchanged into a schema-safe owner.
export const LISTING_OBSERVATION_REASONS = [
  "no-usable-id",
  "unserved-listing-record",
] as const;
export const LISTING_OBSERVATION_REASON = {
  NO_USABLE_ID: LISTING_OBSERVATION_REASONS[0],
  UNSERVED_RECORD: LISTING_OBSERVATION_REASONS[1],
} as const;
export type ListingObservationReason =
  (typeof LISTING_OBSERVATION_REASONS)[number];
