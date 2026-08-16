/**
 * Where a citation stands in resolution: the outcome of the last attempt to
 * link it to the decision it names.
 *
 * `cited_decision_id IS NULL` used to carry two unrelated meanings at once —
 * "never examined" and "examined, no honest link exists" — so the resolver
 * could not tell its remaining work from its settled negatives. It re-examined
 * every unresolvable row on every pass, and the burn-down index never shrank
 * below that permanent residue. Splitting the outcome off the foreign key
 * gives the scan a predicate that empties, and gives the ambiguity tier a
 * queue to read.
 *
 * The four values are outcomes, not flags: `unmatched` and `ambiguous` are
 * different findings with different repairs — a decision published later fixes
 * the first, a deterministic context cue the second — and a pair of booleans
 * could represent combinations that mean nothing.
 */

import type { ConstantMap } from "@/api/lib/constant-map";

/** The declaration the column's `enum` and the CHECK both derive from. */
export const CITATION_RESOLUTION_STATUSES = [
  "pending",
  "resolved",
  "unmatched",
  "ambiguous",
] as const;

export type CitationResolutionStatus =
  (typeof CITATION_RESOLUTION_STATUSES)[number];

export const CITATION_RESOLUTION_STATUS = {
  /** Not yet examined, or put back for another attempt. */
  PENDING: "pending",
  /** Exactly one candidate survived every rule; `cited_decision_id` is set. */
  RESOLVED: "resolved",
  /** No candidate survived. A decision published later can revive it. */
  UNMATCHED: "unmatched",
  /**
   * More than one candidate survived. Left unlinked on purpose: an arbitrary
   * pick puts a wrong edge in the citation graph, which is worse than none.
   */
  AMBIGUOUS: "ambiguous",
} as const satisfies ConstantMap<CitationResolutionStatus>;

/**
 * Lanes the resolution walk keeps a cursor for. One today; the type exists so
 * a per-country or per-source lane can land as a new member rather than as a
 * second table.
 */
export const CITATION_RESOLUTION_SCOPES = ["global"] as const;

export type CitationResolutionScope =
  (typeof CITATION_RESOLUTION_SCOPES)[number];

export const CITATION_RESOLUTION_SCOPE = {
  GLOBAL: "global",
} as const satisfies ConstantMap<CitationResolutionScope>;
