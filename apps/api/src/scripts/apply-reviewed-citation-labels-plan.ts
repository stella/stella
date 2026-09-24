/**
 * The input, the plan and the writes `apply-reviewed-citation-labels.ts`
 * runs, kept importable so a database test can execute them.
 */

import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { lockCitationGraph } from "@/api/handlers/case-law/citation-resolution";
import { REVIEWABLE_POLARITIES } from "@/api/handlers/case-law/polarity/consts";
import type { ReviewablePolarity } from "@/api/handlers/case-law/polarity/consts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

/** Labels one run may carry; bounds the statement's parameter count. */
const MAX_LABELS = 5000;

const uuidSchema = v.pipe(v.string(), v.uuid());
const polaritySchema = v.picklist(REVIEWABLE_POLARITIES);
const reviewRefSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200));

const byCitationKeySchema = v.strictObject({
  citingDecisionId: uuidSchema,
  citationKey: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  polarity: polaritySchema,
  reviewRef: reviewRefSchema,
});

const byCitationIdSchema = v.strictObject({
  citationId: uuidSchema,
  polarity: polaritySchema,
  reviewRef: reviewRefSchema,
});

export const reviewedCitationLabelsFileSchema = v.pipe(
  v.array(v.union([byCitationKeySchema, byCitationIdSchema])),
  v.minLength(1),
  v.maxLength(MAX_LABELS),
);

export type ReviewedCitationLabelEntry = v.InferOutput<
  typeof reviewedCitationLabelsFileSchema
>[number];

/** One review as it is stored: keyed on what survives a refresh. */
type ReviewedCitationLabel = {
  citingDecisionId: SafeId<"caseLawDecision">;
  citationKey: string;
  polarity: ReviewablePolarity;
  reviewRef: string;
};

/** The citation ids the entries name, for one resolution statement. */
const citationIdsOf = (
  entries: readonly ReviewedCitationLabelEntry[],
): string[] => [
  ...new Set(
    entries.flatMap((entry) =>
      "citationId" in entry ? [entry.citationId] : [],
    ),
  ),
];

const citationIdentitiesStatement = (ids: readonly string[]): SQL => sql`
  SELECT id::text AS id,
         citing_decision_id::text AS citing_decision_id,
         citation_key
    FROM case_law_citations
   WHERE id IN (${sql.join(
     ids.map((id) => sql`${id}::uuid`),
     sql`, `,
   )})
`;

/** The citing decision ids the entries name directly. */
const decisionIdsOf = (
  entries: readonly ReviewedCitationLabelEntry[],
): string[] => [
  ...new Set(
    entries.flatMap((entry) =>
      "citingDecisionId" in entry ? [entry.citingDecisionId] : [],
    ),
  ),
];

const existingDecisionsStatement = (ids: readonly string[]): SQL => sql`
  SELECT id::text AS id
    FROM case_law_decisions
   WHERE id IN (${sql.join(
     ids.map((id) => sql`${id}::uuid`),
     sql`, `,
   )})
`;

const decisionIdRowSchema = v.object({ id: v.string() });

const parseDecisionIds = (rows: readonly unknown[]): Set<string> =>
  new Set(rows.map((row) => v.parse(decisionIdRowSchema, row).id));

const citationIdentityRowSchema = v.object({
  id: v.string(),
  citing_decision_id: v.string(),
  citation_key: v.nullable(v.string()),
});

type CitationIdentity = {
  citingDecisionId: string;
  citationKey: string | null;
};

const parseCitationIdentities = (
  rows: readonly unknown[],
): Map<string, CitationIdentity> =>
  new Map(
    rows.map((row) => {
      const parsed = v.parse(citationIdentityRowSchema, row);
      return [
        parsed.id,
        {
          citingDecisionId: parsed.citing_decision_id,
          citationKey: parsed.citation_key,
        },
      ];
    }),
  );

type ResolvedReviewedLabels =
  | { type: "resolved"; labels: ReviewedCitationLabel[] }
  | { type: "rejected"; problems: string[] };

/**
 * Every entry as a `(citing decision, citation key)` review, or every reason
 * the file cannot be applied. Nothing is applied from a file with a problem.
 */
const resolveReviewedCitationLabels = (
  entries: readonly ReviewedCitationLabelEntry[],
  identities: ReadonlyMap<string, CitationIdentity>,
  decisionIds: ReadonlySet<string>,
): ResolvedReviewedLabels => {
  const problems: string[] = [];
  const labels: ReviewedCitationLabel[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    // A key with no current citation row is fine; a decision that does not
    // exist is a typo the review could never apply to.
    if (
      "citingDecisionId" in entry &&
      !decisionIds.has(entry.citingDecisionId)
    ) {
      problems.push(`#${index}: no such citing decision`);
      continue;
    }
    const identity =
      "citationId" in entry ? identities.get(entry.citationId) : entry;
    if (identity === undefined) {
      problems.push(`#${index}: no such citation`);
      continue;
    }
    const { citingDecisionId, citationKey } = identity;
    if (citationKey === null) {
      problems.push(
        `#${index}: the citation has no key and cannot be reviewed`,
      );
      continue;
    }
    const pair = `${citingDecisionId}\u0000${citationKey}`;
    if (seen.has(pair)) {
      problems.push(
        `#${index}: ${citingDecisionId} ${citationKey} is listed more than once`,
      );
      continue;
    }
    seen.add(pair);
    labels.push({
      citingDecisionId: brandPersistedCaseLawDecisionId(citingDecisionId),
      citationKey,
      polarity: entry.polarity,
      reviewRef: entry.reviewRef,
    });
  }
  return problems.length > 0
    ? { type: "rejected", problems }
    : { type: "resolved", labels };
};

const labelValues = (labels: readonly ReviewedCitationLabel[]): SQL => sql`(
  VALUES ${sql.join(
    labels.map(
      (label, index) =>
        sql`(${index}::int, ${label.citingDecisionId}::uuid, ${label.citationKey}::varchar, ${label.polarity}::varchar, ${label.reviewRef}::varchar)`,
    ),
    sql`, `,
  )}
) AS v(ord, citing_decision_id, citation_key, polarity, review_ref)`;

/** Rows a label changes: any other polarity, or a rule attribution. */
const citationDiffersSql = sql`c.citing_decision_id = v.citing_decision_id
   AND c.citation_key = v.citation_key
   AND (c.polarity IS DISTINCT FROM v.polarity OR c.polarity_rule_id IS NOT NULL)`;

/** Per label, in input order: the stored review and the citation rows it covers. */
const reviewedLabelStateStatement = (
  labels: readonly ReviewedCitationLabel[],
): SQL => sql`
  SELECT v.ord,
         r.polarity AS review_polarity,
         r.review_ref AS review_ref,
         (SELECT count(*) FROM case_law_citations c
           WHERE c.citing_decision_id = v.citing_decision_id
             AND c.citation_key = v.citation_key)::int AS citation_rows,
         (SELECT count(*) FROM case_law_citations c
           WHERE ${citationDiffersSql})::int AS changed_rows
    FROM ${labelValues(labels)}
    LEFT JOIN case_law_citation_reviews r
      ON r.citing_decision_id = v.citing_decision_id
     AND r.citation_key = v.citation_key
   ORDER BY v.ord
`;

const labelStateRowSchema = v.object({
  ord: v.number(),
  review_polarity: v.nullable(v.string()),
  review_ref: v.nullable(v.string()),
  citation_rows: v.number(),
  changed_rows: v.number(),
});

type ReviewedLabelSummary = {
  /** Reviews not stored yet. */
  insert: number;
  /** Stored reviews whose polarity or reference differs. */
  update: number;
  /** Stored reviews that already say this. */
  unchanged: number;
  /** Current citation rows whose label the run changes. */
  citationRows: number;
  /** Labels no current citation row carries; stored, applied on a refresh. */
  unmatched: number;
};

const summarizeReviewedLabels = (
  labels: readonly ReviewedCitationLabel[],
  rows: readonly unknown[],
): ReviewedLabelSummary => {
  const summary: ReviewedLabelSummary = {
    insert: 0,
    update: 0,
    unchanged: 0,
    citationRows: 0,
    unmatched: 0,
  };
  for (const row of rows) {
    const state = v.parse(labelStateRowSchema, row);
    const label = labels.at(state.ord);
    if (label === undefined) {
      panic(`label state for an unknown ordinal ${state.ord}`);
    }
    if (state.review_polarity === null) {
      summary.insert += 1;
    } else if (
      state.review_polarity !== label.polarity ||
      state.review_ref !== label.reviewRef
    ) {
      summary.update += 1;
    } else {
      summary.unchanged += 1;
    }
    summary.citationRows += state.changed_rows;
    if (state.citation_rows === 0) {
      summary.unmatched += 1;
    }
  }
  return summary;
};

/** Store each review; a stored one that already says the same is left alone. */
const upsertReviewsStatement = (
  labels: readonly ReviewedCitationLabel[],
): SQL => sql`
  INSERT INTO case_law_citation_reviews AS r
    (id, citing_decision_id, citation_key, polarity, review_ref)
  VALUES ${sql.join(
    labels.map(
      (label) =>
        sql`(${createSafeId<"caseLawCitationReview">()}::uuid, ${label.citingDecisionId}::uuid, ${label.citationKey}, ${label.polarity}, ${label.reviewRef})`,
    ),
    sql`, `,
  )}
  ON CONFLICT (citing_decision_id, citation_key) DO UPDATE
     SET polarity = excluded.polarity,
         review_ref = excluded.review_ref,
         updated_at = now()
   WHERE (r.polarity, r.review_ref)
         IS DISTINCT FROM (excluded.polarity, excluded.review_ref)
`;

/** Give the current citation rows their reviewed label. */
const relabelCitationsStatement = (
  labels: readonly ReviewedCitationLabel[],
): SQL => sql`
  UPDATE case_law_citations AS c
     SET polarity = v.polarity,
         polarity_rule_id = NULL
    FROM ${labelValues(labels)}
   WHERE ${citationDiffersSql}
  RETURNING c.id
`;

const REVIEWED_LABEL_RUN_MODES = ["plan", "apply"] as const;

type ReviewedLabelRunMode = (typeof REVIEWED_LABEL_RUN_MODES)[number];

type ReviewedLabelRunOutcome =
  | { type: "rejected"; problems: string[] }
  | { type: "planned"; summary: ReviewedLabelSummary }
  | { type: "applied"; summary: ReviewedLabelSummary; relabelled: number };

type ExecutingTransaction = {
  execute: (query: SQL) => Promise<unknown>;
};

/**
 * One run, inside the caller's transaction: resolve the entries, report what
 * they change, and under `apply` store the reviews and relabel the rows.
 */
export const runReviewedCitationLabels = async (
  tx: ExecutingTransaction,
  entries: readonly ReviewedCitationLabelEntry[],
  mode: ReviewedLabelRunMode,
): Promise<ReviewedLabelRunOutcome> => {
  if (mode === "apply") {
    // Ingestion re-inserts a decision's citations and reads its reviews under
    // this lock, so a review lands either before that read or after the
    // re-insert, never between them.
    await lockCitationGraph(tx);
  }
  const citationIds = citationIdsOf(entries);
  const identities = parseCitationIdentities(
    citationIds.length === 0
      ? []
      : executedRows(
          await tx.execute(citationIdentitiesStatement(citationIds)),
        ),
  );
  const decisionIds = decisionIdsOf(entries);
  const existingDecisions = parseDecisionIds(
    decisionIds.length === 0
      ? []
      : executedRows(await tx.execute(existingDecisionsStatement(decisionIds))),
  );
  const resolved = resolveReviewedCitationLabels(
    entries,
    identities,
    existingDecisions,
  );
  if (resolved.type === "rejected") {
    return resolved;
  }
  const { labels } = resolved;
  const summary = summarizeReviewedLabels(
    labels,
    executedRows(await tx.execute(reviewedLabelStateStatement(labels))),
  );
  if (mode === "plan") {
    return { type: "planned", summary };
  }
  // audit: skip — operator pass over global case-law labels
  await tx.execute(upsertReviewsStatement(labels));
  // audit: skip — operator pass over global case-law labels
  const relabelled = executedRows(
    await tx.execute(relabelCitationsStatement(labels)),
  ).length;
  return { type: "applied", summary, relabelled };
};
