export const LISTING_OBSERVATION_REASONS = [
  "no-usable-id",
  "unserved-listing-record",
  "quarantine-collision",
] as const;
export const LISTING_OBSERVATION_REASON = {
  NO_USABLE_ID: LISTING_OBSERVATION_REASONS[0],
  UNSERVED_RECORD: LISTING_OBSERVATION_REASONS[1],
  QUARANTINE_COLLISION: LISTING_OBSERVATION_REASONS[2],
} as const;
export type ListingObservationReason =
  (typeof LISTING_OBSERVATION_REASONS)[number];
