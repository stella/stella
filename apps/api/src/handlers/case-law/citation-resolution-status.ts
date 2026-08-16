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

import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

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

export type UnsettledCitationColumns = {
  resolutionStatus: SQLWrapper;
  citedDecisionId: SQLWrapper;
  citationKey: SQLWrapper;
};

/**
 * A citation the resolver still owes an answer for.
 *
 * `pending` is the obvious half. The other half is a row that says `resolved`
 * and carries no target: `cited_decision_id` is `ON DELETE SET NULL`, so
 * deleting or redacting a cited decision leaves exactly that state behind. A
 * status-only predicate would step over those rows forever — they are not
 * pending, and no arriving decision can revive them because the reopen path
 * joins through the target that is no longer there. Treating the pair as
 * unsettled makes the walk self-healing instead of needing a trigger to notice.
 *
 * Exported so the burn-down index and the statement that reads it are written
 * once. A partial index whose predicate drifts from its query is not a slower
 * index, it is an unused one, and nothing about the query would look wrong.
 */
export const unsettledCitationSql = ({
  resolutionStatus,
  citedDecisionId,
  citationKey,
}: UnsettledCitationColumns): SQL =>
  sql`(
    ${resolutionStatus} = '${sql.raw(CITATION_RESOLUTION_STATUS.PENDING)}'
    OR (
      ${resolutionStatus} = '${sql.raw(CITATION_RESOLUTION_STATUS.RESOLVED)}'
      AND ${citedDecisionId} IS NULL
    )
  ) AND ${citationKey} IS NOT NULL`;

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
