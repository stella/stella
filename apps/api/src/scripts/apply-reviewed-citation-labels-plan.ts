/**
 * The input, the plan and the writes `apply-reviewed-citation-labels.ts`
 * runs, kept importable so a database test can execute them.
 */

import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import {
  AI_CITATION_REVIEW_ORIGINS,
  CITATION_REVIEW_ORIGIN,
  CITATION_REVIEW_ORIGIN_PRECEDENCE,
  CITATION_REVIEW_ORIGINS,
  REVIEWABLE_POLARITIES,
  citationReviewMayReplace,
} from "@/api/handlers/case-law/polarity/consts";
import type {
  AiCitationReviewOrigin,
  CitationReviewOrigin,
  ReviewablePolarity,
} from "@/api/handlers/case-law/polarity/consts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ConstantMap } from "@/api/lib/constant-map";
import { executedRows } from "@/api/lib/db/executed-rows";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

/** Labels one run may carry; bounds the statement's parameter count. */
const MAX_LABELS = 5000;

const uuidSchema = v.pipe(v.string(), v.uuid());
const polaritySchema = v.picklist(REVIEWABLE_POLARITIES);
const reviewRefSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const provenanceTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(200),
);
const sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

const byCitationKeyEntries = {
  citingDecisionId: uuidSchema,
  citationKey: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
};

const byCitationIdEntries = { citationId: uuidSchema };

const labelEntries = { polarity: polaritySchema, reviewRef: reviewRefSchema };

const humanReviewEntries = {
  origin: v.literal(CITATION_REVIEW_ORIGIN.HUMAN_REVIEW),
};

const aiReviewEntries = {
  origin: v.picklist(AI_CITATION_REVIEW_ORIGINS),
  model: provenanceTextSchema,
  promptVersion: provenanceTextSchema,
  promptSha256: sha256Schema,
  /** Digest of the passage the label was read from. */
  evidenceSha256: sha256Schema,
  runId: provenanceTextSchema,
  producedAt: v.pipe(v.string(), v.isoTimestamp()),
};

/** One entry: a citation named either way, and who produced its label. */
export const reviewedCitationLabelEntrySchema = v.union([
  v.strictObject({
    ...byCitationKeyEntries,
    ...labelEntries,
    ...humanReviewEntries,
  }),
  v.strictObject({
    ...byCitationKeyEntries,
    ...labelEntries,
    ...aiReviewEntries,
  }),
  v.strictObject({
    ...byCitationIdEntries,
    ...labelEntries,
    ...humanReviewEntries,
  }),
  v.strictObject({
    ...byCitationIdEntries,
    ...labelEntries,
    ...aiReviewEntries,
  }),
]);

/**
 * The file. Entries are validated one by one, so a malformed entry is
 * reported as invalid rather than refusing the entries beside it.
 */
export const reviewedCitationLabelsFileSchema = v.pipe(
  v.array(v.unknown()),
  v.minLength(1),
  v.maxLength(MAX_LABELS),
);

export type ReviewedCitationLabelEntry = v.InferOutput<
  typeof reviewedCitationLabelEntrySchema
>;

/** Who produced a label, and from what when a model did. */
type CitationReviewProvenance =
  | { origin: typeof CITATION_REVIEW_ORIGIN.HUMAN_REVIEW }
  | {
      origin: AiCitationReviewOrigin;
      model: string;
      promptVersion: string;
      promptSha256: string;
      evidenceSha256: string;
      runId: string;
      producedAt: string;
    };

const provenanceOf = (
  entry: ReviewedCitationLabelEntry,
): CitationReviewProvenance => {
  switch (entry.origin) {
    case CITATION_REVIEW_ORIGIN.HUMAN_REVIEW:
      return { origin: entry.origin };
    case CITATION_REVIEW_ORIGIN.AI_ADJUDICATED:
    case CITATION_REVIEW_ORIGIN.AI_ANNOTATION:
      return {
        origin: entry.origin,
        model: entry.model,
        promptVersion: entry.promptVersion,
        promptSha256: entry.promptSha256,
        evidenceSha256: entry.evidenceSha256,
        runId: entry.runId,
        producedAt: entry.producedAt,
      };
    default:
      entry satisfies never;
      return panic(`Unhandled review origin: ${String(entry)}`);
  }
};

type ProvenanceColumns = {
  origin: CitationReviewOrigin;
  model: string | null;
  promptVersion: string | null;
  promptSha256: string | null;
  evidenceSha256: string | null;
  runId: string | null;
  producedAt: string | null;
};

/** The stored columns: provenance set exactly when a model produced it. */
const provenanceColumns = (
  provenance: CitationReviewProvenance,
): ProvenanceColumns => {
  switch (provenance.origin) {
    case CITATION_REVIEW_ORIGIN.HUMAN_REVIEW:
      return {
        origin: provenance.origin,
        model: null,
        promptVersion: null,
        promptSha256: null,
        evidenceSha256: null,
        runId: null,
        producedAt: null,
      };
    case CITATION_REVIEW_ORIGIN.AI_ADJUDICATED:
    case CITATION_REVIEW_ORIGIN.AI_ANNOTATION:
      return {
        origin: provenance.origin,
        model: provenance.model,
        promptVersion: provenance.promptVersion,
        promptSha256: provenance.promptSha256,
        evidenceSha256: provenance.evidenceSha256,
        runId: provenance.runId,
        producedAt: provenance.producedAt,
      };
    default:
      provenance satisfies never;
      return panic(`Unhandled review origin: ${String(provenance)}`);
  }
};

const REVIEWED_LABEL_OUTCOMES = [
  "applied",
  "unchanged",
  "unmatched",
  "refused-precedence",
  "invalid",
] as const;

type ReviewedLabelOutcome = (typeof REVIEWED_LABEL_OUTCOMES)[number];

export const REVIEWED_LABEL_OUTCOME = {
  APPLIED: "applied",
  UNCHANGED: "unchanged",
  UNMATCHED: "unmatched",
  REFUSED_PRECEDENCE: "refused-precedence",
  INVALID: "invalid",
} as const satisfies ConstantMap<ReviewedLabelOutcome>;

const REVIEWED_LABEL_INVALID_REASONS = [
  "schema",
  "no-such-decision",
  "no-such-citation",
  "keyless-citation",
  "duplicate",
] as const;

type ReviewedLabelInvalidReason =
  (typeof REVIEWED_LABEL_INVALID_REASONS)[number];

export const REVIEWED_LABEL_INVALID_REASON = {
  SCHEMA: "schema",
  NO_SUCH_DECISION: "no-such-decision",
  NO_SUCH_CITATION: "no-such-citation",
  KEYLESS_CITATION: "keyless-citation",
  DUPLICATE: "duplicate",
} as const satisfies ConstantMap<ReviewedLabelInvalidReason>;

/** Identifiers only: a result line carries no label, reference or evidence. */
type ReviewedLabelRowIds = {
  citationId?: string;
  citingDecisionId?: string;
  citationKey?: string;
};

/** What became of one input entry, in input order. */
export type ReviewedLabelRowResult = ReviewedLabelRowIds & {
  index: number;
} & (
    | {
        outcome: typeof REVIEWED_LABEL_OUTCOME.INVALID;
        reason: ReviewedLabelInvalidReason;
      }
    | {
        outcome: Exclude<
          ReviewedLabelOutcome,
          typeof REVIEWED_LABEL_OUTCOME.INVALID
        >;
      }
  );

const invalidRow = (
  index: number,
  reason: ReviewedLabelInvalidReason,
  ids: ReviewedLabelRowIds,
): ReviewedLabelRowResult => ({
  ...ids,
  index,
  outcome: REVIEWED_LABEL_OUTCOME.INVALID,
  reason,
});

/** One review as it is stored: keyed on what survives a refresh. */
type ReviewedCitationLabel = {
  index: number;
  ids: ReviewedLabelRowIds;
  citingDecisionId: SafeId<"caseLawDecision">;
  citationKey: string;
  polarity: ReviewablePolarity;
  reviewRef: string;
  provenance: CitationReviewProvenance;
};

type ParsedEntry = { index: number; entry: ReviewedCitationLabelEntry };

type ParsedEntries = {
  entries: ParsedEntry[];
  invalid: ReviewedLabelRowResult[];
};

const parseEntries = (rows: readonly unknown[]): ParsedEntries => {
  const entries: ParsedEntry[] = [];
  const invalid: ReviewedLabelRowResult[] = [];
  for (const [index, row] of rows.entries()) {
    const parsed = v.safeParse(reviewedCitationLabelEntrySchema, row);
    if (parsed.success) {
      entries.push({ index, entry: parsed.output });
    } else {
      invalid.push(invalidRow(index, REVIEWED_LABEL_INVALID_REASON.SCHEMA, {}));
    }
  }
  return { entries, invalid };
};

/** The citation ids the entries name, for one resolution statement. */
const citationIdsOf = (entries: readonly ParsedEntry[]): string[] => [
  ...new Set(
    entries.flatMap(({ entry }) =>
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
const decisionIdsOf = (entries: readonly ParsedEntry[]): string[] => [
  ...new Set(
    entries.flatMap(({ entry }) =>
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

type ResolvedReviewedLabels = {
  labels: ReviewedCitationLabel[];
  invalid: ReviewedLabelRowResult[];
};

/** Each entry as a `(citing decision, citation key)` review, or why it is not one. */
const resolveReviewedCitationLabels = (
  entries: readonly ParsedEntry[],
  identities: ReadonlyMap<string, CitationIdentity>,
  decisionIds: ReadonlySet<string>,
): ResolvedReviewedLabels => {
  const labels: ReviewedCitationLabel[] = [];
  const invalid: ReviewedLabelRowResult[] = [];
  for (const { index, entry } of entries) {
    // A key with no current citation row is fine; a decision that does not
    // exist is a typo the review could never apply to.
    if ("citingDecisionId" in entry) {
      const ids = {
        citingDecisionId: entry.citingDecisionId,
        citationKey: entry.citationKey,
      };
      if (!decisionIds.has(entry.citingDecisionId)) {
        invalid.push(
          invalidRow(
            index,
            REVIEWED_LABEL_INVALID_REASON.NO_SUCH_DECISION,
            ids,
          ),
        );
        continue;
      }
      labels.push({
        index,
        ids,
        citingDecisionId: brandPersistedCaseLawDecisionId(
          entry.citingDecisionId,
        ),
        citationKey: entry.citationKey,
        polarity: entry.polarity,
        reviewRef: entry.reviewRef,
        provenance: provenanceOf(entry),
      });
      continue;
    }
    const identity = identities.get(entry.citationId);
    if (identity === undefined) {
      invalid.push(
        invalidRow(index, REVIEWED_LABEL_INVALID_REASON.NO_SUCH_CITATION, {
          citationId: entry.citationId,
        }),
      );
      continue;
    }
    const { citingDecisionId, citationKey } = identity;
    if (citationKey === null) {
      invalid.push(
        invalidRow(index, REVIEWED_LABEL_INVALID_REASON.KEYLESS_CITATION, {
          citationId: entry.citationId,
          citingDecisionId,
        }),
      );
      continue;
    }
    labels.push({
      index,
      ids: { citationId: entry.citationId, citingDecisionId, citationKey },
      citingDecisionId: brandPersistedCaseLawDecisionId(citingDecisionId),
      citationKey,
      polarity: entry.polarity,
      reviewRef: entry.reviewRef,
      provenance: provenanceOf(entry),
    });
  }
  return { labels, invalid };
};

type SettledLabels = {
  labels: ReviewedCitationLabel[];
  settled: ReviewedLabelRowResult[];
};

const precedenceOf = (label: ReviewedCitationLabel): number =>
  CITATION_REVIEW_ORIGIN_PRECEDENCE[label.provenance.origin];

/**
 * One label per citation. Several entries for one citation resolve by origin
 * precedence; two at the winning origin contradict each other, so neither
 * stands and the citation is left as it is.
 */
const settleDuplicateLabels = (
  labels: readonly ReviewedCitationLabel[],
): SettledLabels => {
  const groups = new Map<string, ReviewedCitationLabel[]>();
  for (const label of labels) {
    const pair = `${label.citingDecisionId}\u0000${label.citationKey}`;
    const group = groups.get(pair);
    if (group === undefined) {
      groups.set(pair, [label]);
    } else {
      group.push(label);
    }
  }
  const winners: ReviewedCitationLabel[] = [];
  const settled: ReviewedLabelRowResult[] = [];
  for (const group of groups.values()) {
    const best = Math.min(...group.map(precedenceOf));
    const contested =
      group.filter((label) => precedenceOf(label) === best).length > 1;
    for (const label of group) {
      if (contested && precedenceOf(label) === best) {
        settled.push(
          invalidRow(
            label.index,
            REVIEWED_LABEL_INVALID_REASON.DUPLICATE,
            label.ids,
          ),
        );
      } else if (precedenceOf(label) > best) {
        settled.push({
          ...label.ids,
          index: label.index,
          outcome: REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE,
        });
      } else {
        winners.push(label);
      }
    }
  }
  return { labels: winners, settled };
};

const labelValues = (labels: readonly ReviewedCitationLabel[]): SQL => sql`(
  VALUES ${sql.join(
    labels.map((label, ord) => {
      const columns = provenanceColumns(label.provenance);
      return sql`(${ord}::int, ${label.citingDecisionId}::uuid, ${label.citationKey}::varchar, ${label.polarity}::varchar, ${label.reviewRef}::varchar, ${columns.origin}::text, ${columns.model}::text, ${columns.promptVersion}::text, ${columns.promptSha256}::text, ${columns.evidenceSha256}::text, ${columns.runId}::text, ${columns.producedAt}::timestamptz)`;
    }),
    sql`, `,
  )}
) AS v(ord, citing_decision_id, citation_key, polarity, review_ref, origin, model, prompt_version, prompt_sha256, evidence_sha256, run_id, produced_at)`;

/** Every stored field of a review, for comparing a stored one with another. */
const reviewTuple = (alias: string): SQL =>
  sql.raw(
    `(${alias}.polarity, ${alias}.review_ref, ${alias}.origin, ${alias}.model, ${alias}.prompt_version, ${alias}.prompt_sha256::text, ${alias}.evidence_sha256::text, ${alias}.run_id, ${alias}.produced_at)`,
  );

/** Rows a label changes: any other polarity, or a rule attribution. */
const citationDiffersSql = sql`c.citing_decision_id = v.citing_decision_id
   AND c.citation_key = v.citation_key
   AND (c.polarity IS DISTINCT FROM v.polarity OR c.polarity_rule_id IS NOT NULL)`;

/** Per label, in input order: the stored review and the citation rows it covers. */
const reviewedLabelStateStatement = (
  labels: readonly ReviewedCitationLabel[],
): SQL => sql`
  SELECT v.ord,
         r.origin AS stored_origin,
         (r.id IS NOT NULL
           AND ${reviewTuple("r")} IS NOT DISTINCT FROM ${reviewTuple("v")}) AS same_review,
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
  stored_origin: v.nullable(v.picklist(CITATION_REVIEW_ORIGINS)),
  same_review: v.boolean(),
  citation_rows: v.number(),
  changed_rows: v.number(),
});

type LabelState = v.InferOutput<typeof labelStateRowSchema>;

const outcomeOf = (
  label: ReviewedCitationLabel,
  state: LabelState,
): Exclude<ReviewedLabelOutcome, typeof REVIEWED_LABEL_OUTCOME.INVALID> => {
  if (
    state.stored_origin !== null &&
    !citationReviewMayReplace({
      stored: state.stored_origin,
      incoming: label.provenance.origin,
    })
  ) {
    return REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE;
  }
  if (!state.same_review) {
    // Stored either way; a review no current row carries applies on a refresh.
    return state.citation_rows === 0
      ? REVIEWED_LABEL_OUTCOME.UNMATCHED
      : REVIEWED_LABEL_OUTCOME.APPLIED;
  }
  return state.changed_rows > 0
    ? REVIEWED_LABEL_OUTCOME.APPLIED
    : REVIEWED_LABEL_OUTCOME.UNCHANGED;
};

type PlannedLabels = {
  /** Labels the run stores and applies. */
  accepted: ReviewedCitationLabel[];
  rows: ReviewedLabelRowResult[];
  /** Current citation rows whose label the run changes. */
  citationRows: number;
};

const planReviewedLabels = (
  labels: readonly ReviewedCitationLabel[],
  stateRows: readonly unknown[],
): PlannedLabels => {
  const accepted: ReviewedCitationLabel[] = [];
  const rows: ReviewedLabelRowResult[] = [];
  let citationRows = 0;
  for (const row of stateRows) {
    const state = v.parse(labelStateRowSchema, row);
    const label = labels.at(state.ord);
    if (label === undefined) {
      return panic(`label state for an unknown ordinal ${state.ord}`);
    }
    const outcome = outcomeOf(label, state);
    rows.push({ ...label.ids, index: label.index, outcome });
    if (outcome !== REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE) {
      accepted.push(label);
      citationRows += state.changed_rows;
    }
  }
  return { accepted, rows, citationRows };
};

/**
 * Store each accepted review; a stored one that already says the same is
 * left alone. Precedence was settled by the plan in this transaction, and an
 * applying run holds the maintenance lane, so no other writer of reviews can
 * interleave.
 */
const upsertReviewsStatement = (
  labels: readonly ReviewedCitationLabel[],
): SQL => sql`
  INSERT INTO case_law_citation_reviews AS r
    (id, citing_decision_id, citation_key, polarity, review_ref, origin,
     model, prompt_version, prompt_sha256, evidence_sha256, run_id, produced_at)
  VALUES ${sql.join(
    labels.map((label) => {
      const columns = provenanceColumns(label.provenance);
      return sql`(${createSafeId<"caseLawCitationReview">()}::uuid, ${label.citingDecisionId}::uuid, ${label.citationKey}, ${label.polarity}, ${label.reviewRef}, ${columns.origin}, ${columns.model}::text, ${columns.promptVersion}::text, ${columns.promptSha256}::text, ${columns.evidenceSha256}::text, ${columns.runId}::text, ${columns.producedAt}::timestamptz)`;
    }),
    sql`, `,
  )}
  ON CONFLICT (citing_decision_id, citation_key) DO UPDATE
     SET polarity = excluded.polarity,
         review_ref = excluded.review_ref,
         origin = excluded.origin,
         model = excluded.model,
         prompt_version = excluded.prompt_version,
         prompt_sha256 = excluded.prompt_sha256,
         evidence_sha256 = excluded.evidence_sha256,
         run_id = excluded.run_id,
         produced_at = excluded.produced_at,
         reviewed_at = now(),
         updated_at = now()
   WHERE ${reviewTuple("r")} IS DISTINCT FROM ${reviewTuple("excluded")}
`;

/** Give the current citation rows of the accepted labels their stored review. */
const relabelCitationsStatement = (
  labels: readonly ReviewedCitationLabel[],
): SQL => sql`
  UPDATE case_law_citations AS c
     SET polarity = r.polarity,
         polarity_rule_id = NULL
    FROM ${labelValues(labels)}
    JOIN case_law_citation_reviews r
      ON r.citing_decision_id = v.citing_decision_id
     AND r.citation_key = v.citation_key
   WHERE c.citing_decision_id = r.citing_decision_id
     AND c.citation_key = r.citation_key
     AND (c.polarity IS DISTINCT FROM r.polarity OR c.polarity_rule_id IS NOT NULL)
  RETURNING c.id
`;

const REVIEWED_LABEL_RUN_MODES = ["plan", "apply"] as const;

type ReviewedLabelRunMode = (typeof REVIEWED_LABEL_RUN_MODES)[number];

/** The `--results` file: one JSON line per entry, in input order. */
export const reviewedLabelResultLines = (
  rows: readonly ReviewedLabelRowResult[],
  mode: ReviewedLabelRunMode,
): string =>
  rows.map((row) => `${JSON.stringify({ ...row, mode })}\n`).join("");

type ReviewedLabelSummary = Record<ReviewedLabelOutcome, number> & {
  /** Current citation rows whose label the run changes. */
  citationRows: number;
};

type ReviewedLabelRunOutcome =
  | {
      type: "planned";
      rows: ReviewedLabelRowResult[];
      summary: ReviewedLabelSummary;
    }
  | {
      type: "applied";
      rows: ReviewedLabelRowResult[];
      summary: ReviewedLabelSummary;
      relabelled: number;
    };

const summarize = (
  rows: readonly ReviewedLabelRowResult[],
  citationRows: number,
): ReviewedLabelSummary => {
  const summary: ReviewedLabelSummary = {
    applied: 0,
    unchanged: 0,
    unmatched: 0,
    "refused-precedence": 0,
    invalid: 0,
    citationRows,
  };
  for (const row of rows) {
    summary[row.outcome] += 1;
  }
  return summary;
};

type ExecutingTransaction = {
  execute: (query: SQL) => Promise<unknown>;
};

/**
 * One run, inside the caller's transaction: validate and resolve each entry,
 * decide what becomes of it, and under `apply` store the accepted reviews and
 * relabel their rows.
 */
const runReviewedCitationLabelsTx = async (
  tx: ExecutingTransaction,
  input: readonly unknown[],
  mode: ReviewedLabelRunMode,
): Promise<ReviewedLabelRunOutcome> => {
  const parsed = parseEntries(input);
  const citationIds = citationIdsOf(parsed.entries);
  const identities = parseCitationIdentities(
    citationIds.length === 0
      ? []
      : executedRows(
          await tx.execute(citationIdentitiesStatement(citationIds)),
        ),
  );
  const decisionIds = decisionIdsOf(parsed.entries);
  const existingDecisions = parseDecisionIds(
    decisionIds.length === 0
      ? []
      : executedRows(await tx.execute(existingDecisionsStatement(decisionIds))),
  );
  const resolved = resolveReviewedCitationLabels(
    parsed.entries,
    identities,
    existingDecisions,
  );
  const settled = settleDuplicateLabels(resolved.labels);
  const planned =
    settled.labels.length === 0
      ? { accepted: [], rows: [], citationRows: 0 }
      : planReviewedLabels(
          settled.labels,
          executedRows(
            await tx.execute(reviewedLabelStateStatement(settled.labels)),
          ),
        );
  const rows = [
    ...parsed.invalid,
    ...resolved.invalid,
    ...settled.settled,
    ...planned.rows,
  ].toSorted((left, right) => left.index - right.index);
  const summary = summarize(rows, planned.citationRows);
  if (mode === "plan") {
    return { type: "planned", rows, summary };
  }
  if (planned.accepted.length === 0) {
    return { type: "applied", rows, summary, relabelled: 0 };
  }
  // audit: skip — operator pass over global case-law labels
  await tx.execute(upsertReviewsStatement(planned.accepted));
  // audit: skip — operator pass over global case-law labels
  const relabelled = executedRows(
    await tx.execute(relabelCitationsStatement(planned.accepted)),
  ).length;
  return { type: "applied", rows, summary, relabelled };
};

export const runReviewedCitationLabels = async (
  transact: <T>(run: (tx: ExecutingTransaction) => Promise<T>) => Promise<T>,
  input: readonly unknown[],
  mode: ReviewedLabelRunMode,
): Promise<ReviewedLabelRunOutcome> =>
  mode === "apply"
    ? await runCitationGraphTransaction(
        transact,
        async (tx) => await runReviewedCitationLabelsTx(tx, input, mode),
      )
    : await transact(
        async (tx) => await runReviewedCitationLabelsTx(tx, input, mode),
      );
