/**
 * The vocabulary of a route's readiness proof: the census pass that walks one
 * physical index of a generation, and why a proof stops counting.
 */

/**
 * A pass walks the applied revisions the index must hold (`present`), then the
 * settled and withdrawn ones it must not (`absent`).
 */
export const CORPUS_INDEX_ROUTE_CENSUS_EXPECTATIONS = [
  "present",
  "absent",
] as const;
export type CorpusIndexRouteCensusExpectation =
  (typeof CORPUS_INDEX_ROUTE_CENSUS_EXPECTATIONS)[number];

/** The drift a repair found on the route, which revokes its proof. */
export const CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS = [
  "present_drift",
  "absent_drift",
] as const;
export type CorpusIndexRouteProofRevokeReason =
  (typeof CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS)[number];

/** A clean pass proves its route for this long after it completed. */
export const CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS = 24;
