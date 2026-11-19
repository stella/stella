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

/**
 * Why a route's proof stopped counting, each written in the transaction of
 * the change that voids it:
 *
 * - `present_drift`, `absent_drift`: a census found the engine other than
 *   PostgreSQL records it, and the repair ran;
 * - `index_replaced`: the engine reports another incarnation of the index id
 *   than the pass started on (deleted and created again, or restored);
 * - `group_withdrawn`, `group_attested`: the route's group lost its
 *   attestation, or was attested anew, so what the pass walked may not be the
 *   index the attestation now vouches for.
 */
export const CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS = [
  "present_drift",
  "absent_drift",
  "index_replaced",
  "group_withdrawn",
  "group_attested",
] as const;
export type CorpusIndexRouteProofRevokeReason =
  (typeof CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS)[number];

/**
 * A clean pass proves its route for this long after it STARTED: its oldest
 * observation is that old, whatever the pass's length. A reader may ask for a
 * shorter bound, never a longer one.
 */
export const CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS = 24;

/** The engine's identity of one incarnation of an index id, as stored. */
export const CORPUS_INDEX_INCARNATION_MAX_LENGTH = 160;
