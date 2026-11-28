// parser-output-unchanged: Pure observation detail types, ranks, and marker field constants extracted without behavior change.
/**
 * Pure quality-marker constants, types, and helpers for partial source
 * observations. Kept free of database imports so ingestion core modules can
 * depend on it without pulling in Drizzle or SQL builders.
 */

/** Pipeline-owned quality marker persisted with partial source observations. */
export const PARTIAL_OBSERVATION_KEY = "_stellaPartialObservation";

export const OBSERVATION_DETAIL = {
  COMPLETE: "complete",
  LISTING_ONLY: "listing-only",
  SECONDARY_REFUSED: "secondary-refused",
} as const;

export type ObservationDetail =
  (typeof OBSERVATION_DETAIL)[keyof typeof OBSERVATION_DETAIL];

/** More recovered detail must survive a later, poorer observation. */
export const OBSERVATION_DETAIL_RANK = {
  [OBSERVATION_DETAIL.COMPLETE]: 2,
  [OBSERVATION_DETAIL.SECONDARY_REFUSED]: 1,
  [OBSERVATION_DETAIL.LISTING_ONLY]: 0,
} as const satisfies Record<ObservationDetail, number>;

export type PartialObservation = {
  caseNumberIsPlaceholder: boolean;
  detail: ObservationDetail;
};

/** Existing adapters declare missing documents with the original flag. */
export const observationDetailOf = (observation: {
  observationDetail?: ObservationDetail | undefined;
  isListingOnly?: boolean | undefined;
}): ObservationDetail =>
  observation.isListingOnly === true
    ? OBSERVATION_DETAIL.LISTING_ONLY
    : (observation.observationDetail ?? OBSERVATION_DETAIL.COMPLETE);

/**
 * The marker's own field names, spelled once. Every reader and the SQL
 * predicates address the same stored path, and a literal repeated in each
 * would be free to drift: a query looking under a key the pipeline stopped
 * writing answers `false` for every row and says nothing about it.
 */
export const PARTIAL_OBSERVATION_FIELD = {
  CASE_NUMBER_IS_PLACEHOLDER: "caseNumberIsPlaceholder",
  DETAIL: "detail",
  IS_LISTING_ONLY: "isListingOnly",
} as const satisfies Record<string, keyof PartialObservation | "isListingOnly">;
