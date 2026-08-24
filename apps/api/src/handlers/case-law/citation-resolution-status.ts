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

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

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
 * Which rule drew a resolved row's edge. Null while a row is not resolved.
 *
 * Declared so each rule's output can be audited as a population rather than
 * trusted as code: a rule is a hypothesis about how a court's citations
 * behave, and a measured error rate per rule is what lets a wrong one be
 * switched off and its rows reopened.
 */
export const CITATION_RESOLUTION_RULES = [
  "unique-key",
  "type-hint",
  "one-file-merits",
] as const;

export type CitationResolutionRule = (typeof CITATION_RESOLUTION_RULES)[number];

export const CITATION_RESOLUTION_RULE = {
  /** The key matched exactly one decision that passed every rule. */
  UNIQUE_KEY: "unique-key",
  /** Several holders; the text named the type, and one holder had it. */
  TYPE_HINT: "type-hint",
  /** Several holders in one file; the single merits decision took the link. */
  ONE_FILE_MERITS: "one-file-merits",
} as const satisfies ConstantMap<CitationResolutionRule>;

// Listed by name rather than looped so the return type proves every rule has
// a counter; a rule added to the list without a line here fails typecheck.
export const countsByRule = (
  read: (rule: CitationResolutionRule) => number,
): Record<CitationResolutionRule, number> => ({
  [CITATION_RESOLUTION_RULE.UNIQUE_KEY]: read(
    CITATION_RESOLUTION_RULE.UNIQUE_KEY,
  ),
  [CITATION_RESOLUTION_RULE.TYPE_HINT]: read(
    CITATION_RESOLUTION_RULE.TYPE_HINT,
  ),
  [CITATION_RESOLUTION_RULE.ONE_FILE_MERITS]: read(
    CITATION_RESOLUTION_RULE.ONE_FILE_MERITS,
  ),
});

/**
 * The decision types the one-file rule tells apart, as the adapters store
 * them: lowercase, in the court's own language. Only courts whose types fall
 * into these two sets can satisfy the rule; a court that files under
 * `rozsudek`, `judgment` or leaves the type empty never matches, which is the
 * jurisdiction safety of the rule rather than a list of court names.
 *
 * `nález` is the merits decision of both constitutional courts the corpus
 * holds (CZE Ústavní soud, SVK Ústavný súd SR); their procedural orders are
 * `usnesení` and `uznesenie`.
 */
export const MERITS_DECISION_TYPES = ["nález"] as const;
export const PROCEDURAL_DECISION_TYPES = ["usnesení", "uznesenie"] as const;

/**
 * How many candidates the resolver reads per key before declaring the key too
 * crowded to adjudicate. Uniqueness needs two; the one-file rule needs every
 * candidate, and a constitutional file rarely carries more than a few orders.
 * A key that reaches the cap is ambiguous without looking further, so the
 * lookup cost per citation is this constant, whatever the corpus holds.
 */
export const CITATION_CANDIDATE_SCAN_CAP = 8;

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
 * A settled citation whose answer a key can change.
 *
 * Both negative outcomes qualify, and the second is the one that is easy to
 * miss. `unmatched` becomes resolvable when a key finds its first holder.
 * `ambiguous` becomes resolvable when a key stops having two: a candidate that
 * changes its case number, jurisdiction or date leaves the remaining one
 * unique, and an ambiguous row carries no `cited_decision_id` by design, so
 * nothing that searches by target can reach it. The key is the only handle
 * those rows have.
 *
 * Exported for the same reason as `unsettledCitationSql`: the reverse index
 * and every reopen path are built from it, and a partial index whose predicate
 * is narrower than its query is an unused index that nothing complains about.
 */
export const citationReopenableByKeySql = (resolutionStatus: SQLWrapper): SQL =>
  sql`${resolutionStatus} IN ('${sql.raw(
    CITATION_RESOLUTION_STATUS.UNMATCHED,
  )}', '${sql.raw(CITATION_RESOLUTION_STATUS.AMBIGUOUS)}')`;

export const effectiveCitationIdentifierTypeSql = (
  identifierType: SQLWrapper,
): SQL =>
  sql`coalesce(${identifierType}, '${sql.raw(
    DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  )}')`;

export const effectiveCitationIdentifierValueSql = (
  normalizedIdentifierValue: SQLWrapper,
  citationKey: SQLWrapper,
): SQL => sql`coalesce(${normalizedIdentifierValue}, ${citationKey})`;

export const settledCitationSql = (resolutionStatus: SQLWrapper): SQL =>
  sql`${resolutionStatus} <> '${sql.raw(CITATION_RESOLUTION_STATUS.PENDING)}'`;

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
