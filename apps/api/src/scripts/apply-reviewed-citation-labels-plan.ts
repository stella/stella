/**
 * The input, the plan and the writes `apply-reviewed-citation-labels.ts`
 * runs, kept importable so a database test can execute them.
 */

import { panic, Result, TaggedError } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { open, rename, rm } from "node:fs/promises";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import {
  AI_CITATION_REVIEW_ORIGINS,
  CITATION_REVIEW_ORIGIN,
  CITATION_REVIEW_ORIGIN_PRECEDENCE,
  CITATION_REVIEW_ORIGINS,
  REVIEWABLE_POLARITIES,
  citationReviewOutranks,
} from "@/api/handlers/case-law/polarity/consts";
import type {
  AiCitationReviewOrigin,
  CitationReviewOrigin,
  CitationReviewStanding,
  ReviewablePolarity,
} from "@/api/handlers/case-law/polarity/consts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  assertCitationStorageField,
  fitsCitationStorageField,
} from "@/api/lib/case-law/citation-storage-bounds";
import type { ConstantMap } from "@/api/lib/constant-map";
import { executedRows } from "@/api/lib/db/executed-rows";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

/** Labels one run may carry; bounds the statement's parameter count. */
const MAX_LABELS = 5000;

const uuidSchema = v.pipe(v.string(), v.uuid());
const polaritySchema = v.picklist(REVIEWABLE_POLARITIES);
/**
 * Free text bound as a Postgres text parameter. Postgres refuses NUL in text,
 * and that refusal would abort the whole batch, so it is invalid here.
 */
const storedTextSchema = (maxLength: number) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(maxLength),
    v.check((value) => !value.includes("\u0000"), "text must not contain NUL"),
  );
const reviewRefSchema = storedTextSchema(200);
const provenanceTextSchema = storedTextSchema(200);
const sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

const byCitationKeyEntries = {
  citingDecisionId: uuidSchema,
  citationKey: v.pipe(
    v.string(),
    v.minLength(1),
    v.check((value) => !value.includes("\u0000"), "text must not contain NUL"),
    v.check((value) => fitsCitationStorageField("key", value)),
  ),
};

const byCitationIdEntries = { citationId: uuidSchema };

const labelEntries = { polarity: polaritySchema, reviewRef: reviewRefSchema };

const humanReviewEntries = {
  origin: v.literal(CITATION_REVIEW_ORIGIN.HUMAN_REVIEW),
};

/**
 * No label predates this; it also keeps every accepted value inside the
 * range a timestamptz cast accepts.
 */
const EARLIEST_PRODUCED_AT = Temporal.Instant.from("2020-01-01T00:00:00Z");
/** Tolerates clock skew between the producer and this run. */
const PRODUCED_AT_FUTURE_TOLERANCE = Temporal.Duration.from({ hours: 24 });

/**
 * `isoTimestamp` checks the shape only. A day the calendar lacks
 * (2026-02-30) or a year the database cannot store (0000) would fail the
 * timestamptz cast and abort the whole batch, so both are invalid here.
 */
const isPlausibleProductionInstant = (value: string): boolean => {
  const instant = Result.try(() => Temporal.Instant.from(value));
  if (Result.isError(instant)) {
    return false;
  }
  const latest = Temporal.Now.instant().add(PRODUCED_AT_FUTURE_TOLERANCE);
  return (
    Temporal.Instant.compare(instant.value, EARLIEST_PRODUCED_AT) >= 0 &&
    Temporal.Instant.compare(instant.value, latest) <= 0
  );
};

const aiReviewEntries = {
  origin: v.picklist(AI_CITATION_REVIEW_ORIGINS),
  model: provenanceTextSchema,
  promptVersion: provenanceTextSchema,
  promptSha256: sha256Schema,
  /** Digest of the passage the label was read from. */
  evidenceSha256: sha256Schema,
  runId: provenanceTextSchema,
  producedAt: v.pipe(
    v.string(),
    v.isoTimestamp(),
    v.check(isPlausibleProductionInstant, "producedAt must be a real instant"),
    // Bound as UTC: an offset the database cannot parse (+16:00) never
    // reaches the timestamptz cast. Truncated to the microseconds timestamptz
    // stores, so a file orders its labels as the database later compares them.
    v.transform((value) =>
      Temporal.Instant.from(value)
        .round({ smallestUnit: "microsecond", roundingMode: "trunc" })
        .toString(),
    ),
  ),
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

const standingOf = (
  provenance: CitationReviewProvenance,
): CitationReviewStanding => {
  switch (provenance.origin) {
    case CITATION_REVIEW_ORIGIN.HUMAN_REVIEW:
      return { origin: provenance.origin };
    case CITATION_REVIEW_ORIGIN.AI_ADJUDICATED:
    case CITATION_REVIEW_ORIGIN.AI_ANNOTATION:
      return {
        origin: provenance.origin,
        producedAt: Temporal.Instant.from(provenance.producedAt),
      };
    default:
      provenance satisfies never;
      return panic(`Unhandled review origin: ${String(provenance)}`);
  }
};

const citationPairOf = (citingDecisionId: string, citationKey: string) =>
  `${citingDecisionId}\u0000${citationKey}`;

/** Labels grouped by the citation they review, in input order. */
const groupByCitation = (
  labels: readonly ReviewedCitationLabel[],
): ReviewedCitationLabel[][] => {
  const groups = new Map<string, ReviewedCitationLabel[]>();
  for (const label of labels) {
    const pair = citationPairOf(label.citingDecisionId, label.citationKey);
    const group = groups.get(pair);
    if (group === undefined) {
      groups.set(pair, [label]);
    } else {
      group.push(label);
    }
  }
  return [...groups.values()];
};

/**
 * One label per citation, by the order that settles a stored review against
 * an incoming one: origin precedence, then for model labels the later
 * `producedAt`. Labels nothing orders (two human reviews, or two model labels
 * produced at the same instant) contradict each other at the top, so none of
 * them stands and the citation is left as it is.
 */
const settleDuplicateLabels = (
  labels: readonly ReviewedCitationLabel[],
): SettledLabels => {
  const winners: ReviewedCitationLabel[] = [];
  const settled: ReviewedLabelRowResult[] = [];
  for (const group of groupByCitation(labels)) {
    const ranked = group.map((label) => ({
      label,
      standing: standingOf(label.provenance),
    }));
    const first = ranked.at(0);
    if (first === undefined) {
      return panic("a citation group without labels");
    }
    let best = first;
    for (const candidate of ranked) {
      if (
        citationReviewOutranks({
          upper: candidate.standing,
          lower: best.standing,
        })
      ) {
        best = candidate;
      }
    }
    const top = ranked.filter(
      ({ standing }) =>
        !citationReviewOutranks({ upper: best.standing, lower: standing }),
    );
    for (const { label, standing } of ranked) {
      if (citationReviewOutranks({ upper: best.standing, lower: standing })) {
        settled.push({
          ...label.ids,
          index: label.index,
          outcome: REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE,
        });
      } else if (top.length > 1) {
        settled.push(
          invalidRow(
            label.index,
            REVIEWED_LABEL_INVALID_REASON.DUPLICATE,
            label.ids,
          ),
        );
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

/**
 * `CITATION_REVIEW_ORIGIN_PRECEDENCE` of a row's origin; an origin outside it
 * ranks NULL, which no comparison accepts.
 */
const originRankSql = (alias: string): SQL =>
  sql`(${sqlCaseFragment({
    operand: sql.raw(`${alias}.origin`),
    branches: CITATION_REVIEW_ORIGINS.map(
      (origin) =>
        sql`WHEN ${origin}::text THEN ${CITATION_REVIEW_ORIGIN_PRECEDENCE[origin]}::int`,
    ),
    fallback: sql`NULL::int`,
  })})`;

type ReviewRowAliases = { stored: string; incoming: string };

/**
 * `citationReviewMayReplace` over two review rows. The upsert's conflict
 * clause carries it, so a stored review a concurrent run wrote in the
 * meantime is judged as it is when the row is locked, not as the plan saw it.
 */
export const reviewMayReplaceSql = ({
  stored,
  incoming,
}: ReviewRowAliases): SQL => {
  const storedRank = originRankSql(stored);
  const incomingRank = originRankSql(incoming);
  const storedOrigin = sql.raw(`${stored}.origin`);
  const incomingOrigin = sql.raw(`${incoming}.origin`);
  const human = sql`${CITATION_REVIEW_ORIGIN.HUMAN_REVIEW}::text`;
  return sql`COALESCE(
    ${incomingRank} < ${storedRank}
    OR (${incomingRank} = ${storedRank}
        AND ((${incomingOrigin} = ${human} AND ${storedOrigin} = ${human})
          OR (${incomingOrigin} <> ${human} AND ${storedOrigin} <> ${human}
              AND ${sql.raw(`${incoming}.produced_at`)} > ${sql.raw(`${stored}.produced_at`)}))),
    false)`;
};

/** Rows a label changes: any other polarity, or a rule attribution. */
const citationDiffersSql = sql`c.citing_decision_id = v.citing_decision_id
   AND c.citation_key = v.citation_key
   AND (c.polarity IS DISTINCT FROM v.polarity OR c.polarity_rule_id IS NOT NULL)`;

/** Per label, in input order: the stored review and the citation rows it covers. */
const reviewedLabelStateStatement = (
  labels: readonly ReviewedCitationLabel[],
): SQL => sql`
  SELECT v.ord,
         (r.id IS NOT NULL
           AND ${reviewTuple("r")} IS NOT DISTINCT FROM ${reviewTuple("v")}) AS same_review,
         (r.id IS NULL OR ${reviewMayReplaceSql({ stored: "r", incoming: "v" })}) AS may_replace,
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
  same_review: v.boolean(),
  may_replace: v.boolean(),
  citation_rows: v.number(),
  changed_rows: v.number(),
});

type LabelState = v.InferOutput<typeof labelStateRowSchema>;

type AcceptedOutcome = Exclude<
  ReviewedLabelOutcome,
  | typeof REVIEWED_LABEL_OUTCOME.INVALID
  | typeof REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE
>;

/**
 * The same review replayed is never a replacement, so it is settled before
 * precedence: replaying a model run is `unchanged`, not refused.
 */
const outcomeOf = (
  state: LabelState,
): AcceptedOutcome | typeof REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE => {
  if (state.same_review) {
    return state.changed_rows > 0
      ? REVIEWED_LABEL_OUTCOME.APPLIED
      : REVIEWED_LABEL_OUTCOME.UNCHANGED;
  }
  if (!state.may_replace) {
    return REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE;
  }
  // Stored either way; a review no current row carries applies on a refresh.
  return state.citation_rows === 0
    ? REVIEWED_LABEL_OUTCOME.UNMATCHED
    : REVIEWED_LABEL_OUTCOME.APPLIED;
};

/** A label the run stores and applies. */
type AcceptedLabel = {
  label: ReviewedCitationLabel;
  outcome: AcceptedOutcome;
  /** Current citation rows whose label it changes. */
  changedRows: number;
  /** The stored review differs, so the upsert must write this one. */
  storesReview: boolean;
};

type PlannedLabels = {
  accepted: AcceptedLabel[];
  refused: ReviewedLabelRowResult[];
};

const refusedRow = (label: ReviewedCitationLabel): ReviewedLabelRowResult => ({
  ...label.ids,
  index: label.index,
  outcome: REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE,
});

const planReviewedLabels = (
  labels: readonly ReviewedCitationLabel[],
  stateRows: readonly unknown[],
): PlannedLabels => {
  const accepted: AcceptedLabel[] = [];
  const refused: ReviewedLabelRowResult[] = [];
  for (const row of stateRows) {
    const state = v.parse(labelStateRowSchema, row);
    const label = labels.at(state.ord);
    if (label === undefined) {
      return panic(`label state for an unknown ordinal ${state.ord}`);
    }
    const outcome = outcomeOf(state);
    if (outcome === REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE) {
      refused.push(refusedRow(label));
      continue;
    }
    accepted.push({
      label,
      outcome,
      changedRows: state.changed_rows,
      storesReview: !state.same_review,
    });
  }
  return { accepted, refused };
};

/**
 * Store each review, as a compare-and-set: the conflict clause replaces a
 * stored review only when the incoming one may replace it, and leaves one that
 * already says the same alone. Returns the citations whose review it wrote.
 */
const upsertReviewsStatement = (
  labels: readonly ReviewedCitationLabel[],
): SQL => sql`
  INSERT INTO case_law_citation_reviews AS r
    (id, citing_decision_id, citation_key, polarity, review_ref, origin,
     model, prompt_version, prompt_sha256, evidence_sha256, run_id, produced_at)
  VALUES ${sql.join(
    labels.map((label) => {
      const checked = assertCitationStorageField("key", label.citationKey);
      if (checked.isErr()) {
        throw checked.error;
      }
      const columns = provenanceColumns(label.provenance);
      return sql`(${createSafeId<"caseLawCitationReview">()}::uuid, ${label.citingDecisionId}::uuid, ${checked.value}, ${label.polarity}, ${label.reviewRef}, ${columns.origin}, ${columns.model}::text, ${columns.promptVersion}::text, ${columns.promptSha256}::text, ${columns.evidenceSha256}::text, ${columns.runId}::text, ${columns.producedAt}::timestamptz)`;
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
     AND ${reviewMayReplaceSql({ stored: "r", incoming: "excluded" })}
  RETURNING r.citing_decision_id::text AS citing_decision_id, r.citation_key
`;

const writtenReviewRowSchema = v.object({
  citing_decision_id: v.string(),
  citation_key: v.string(),
});

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

type ReviewedLabelPlan = {
  type: "planned";
  rows: ReviewedLabelRowResult[];
  summary: ReviewedLabelSummary;
};

type ReviewedLabelApplication = {
  type: "applied";
  rows: ReviewedLabelRowResult[];
  summary: ReviewedLabelSummary;
  relabelled: number;
};

const summarize = (
  rows: readonly ReviewedLabelRowResult[],
  citationRows: number,
): ReviewedLabelSummary => {
  const count = (outcome: ReviewedLabelOutcome): number =>
    rows.filter((row) => row.outcome === outcome).length;
  return {
    applied: count(REVIEWED_LABEL_OUTCOME.APPLIED),
    unchanged: count(REVIEWED_LABEL_OUTCOME.UNCHANGED),
    unmatched: count(REVIEWED_LABEL_OUTCOME.UNMATCHED),
    "refused-precedence": count(REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE),
    invalid: count(REVIEWED_LABEL_OUTCOME.INVALID),
    citationRows,
  };
};

type ExecutingTransaction = {
  execute: (query: SQL) => Promise<unknown>;
};

type Transact = <T>(
  run: (tx: ExecutingTransaction) => Promise<T>,
) => Promise<T>;

type DecidedLabels = {
  /** Entries settled without reaching the database's review state. */
  settled: ReviewedLabelRowResult[];
  planned: PlannedLabels;
};

/** Validate and resolve each entry, and decide what becomes of it. */
const decideReviewedLabels = async (
  tx: ExecutingTransaction,
  input: readonly unknown[],
): Promise<DecidedLabels> => {
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
      ? { accepted: [], refused: [] }
      : planReviewedLabels(
          settled.labels,
          executedRows(
            await tx.execute(reviewedLabelStateStatement(settled.labels)),
          ),
        );
  return {
    settled: [...parsed.invalid, ...resolved.invalid, ...settled.settled],
    planned,
  };
};

const acceptedRow = ({
  label,
  outcome,
}: AcceptedLabel): ReviewedLabelRowResult => ({
  ...label.ids,
  index: label.index,
  outcome,
});

const inInputOrder = (
  rows: readonly ReviewedLabelRowResult[],
): ReviewedLabelRowResult[] =>
  rows.toSorted((left, right) => left.index - right.index);

const sumChangedRows = (accepted: readonly AcceptedLabel[]): number =>
  accepted.reduce((total, { changedRows }) => total + changedRows, 0);

/** What a run would do, writing nothing. */
export const planReviewedCitationLabels = async (
  transact: Transact,
  input: readonly unknown[],
): Promise<ReviewedLabelPlan> =>
  await transact(async (tx) => {
    const { settled, planned } = await decideReviewedLabels(tx, input);
    const rows = inInputOrder([
      ...settled,
      ...planned.refused,
      ...planned.accepted.map(acceptedRow),
    ]);
    return {
      type: "planned",
      rows,
      summary: summarize(rows, sumChangedRows(planned.accepted)),
    };
  });

/**
 * Store the accepted reviews and relabel their rows. A label the plan
 * accepted but the compare-and-set did not write lost to a review stored in
 * the meantime, so it is refused rather than reported as applied.
 */
const applyReviewedLabelsTx = async (
  tx: ExecutingTransaction,
  input: readonly unknown[],
): Promise<ReviewedLabelApplication> => {
  const { settled, planned } = await decideReviewedLabels(tx, input);
  const toStore = planned.accepted
    .filter(({ storesReview }) => storesReview)
    .map(({ label }) => label);
  const written = new Set(
    toStore.length === 0
      ? []
      : executedRows(
          // audit: skip — operator pass over global case-law labels
          await tx.execute(upsertReviewsStatement(toStore)),
        ).map((row) => {
          const parsed = v.parse(writtenReviewRowSchema, row);
          return citationPairOf(parsed.citing_decision_id, parsed.citation_key);
        }),
  );
  const accepted: AcceptedLabel[] = [];
  const refused = [...planned.refused];
  for (const candidate of planned.accepted) {
    const { label } = candidate;
    if (
      candidate.storesReview &&
      !written.has(citationPairOf(label.citingDecisionId, label.citationKey))
    ) {
      refused.push(refusedRow(label));
    } else {
      accepted.push(candidate);
    }
  }
  const rows = inInputOrder([
    ...settled,
    ...refused,
    ...accepted.map(acceptedRow),
  ]);
  const summary = summarize(rows, sumChangedRows(accepted));
  if (accepted.length === 0) {
    return { type: "applied", rows, summary, relabelled: 0 };
  }
  const relabelled = executedRows(
    // audit: skip — operator pass over global case-law labels
    await tx.execute(
      relabelCitationsStatement(accepted.map(({ label }) => label)),
    ),
  ).length;
  return { type: "applied", rows, summary, relabelled };
};

const REVIEWED_LABEL_APPLY_FAILURES = [
  "not-applied",
  "results-not-placed",
] as const;

type ReviewedLabelApplyFailure = (typeof REVIEWED_LABEL_APPLY_FAILURES)[number];

export const REVIEWED_LABEL_APPLY_FAILURE = {
  NOT_APPLIED: "not-applied",
  RESULTS_NOT_PLACED: "results-not-placed",
} as const satisfies ConstantMap<ReviewedLabelApplyFailure>;

class ReviewedLabelApplyError extends TaggedError("ReviewedLabelApplyError")<{
  code: ReviewedLabelApplyFailure;
  message: string;
  cause: unknown;
}> {}

/** Write and flush a file, so it is on disk before the caller commits. */
const writeDurably = async (path: string, content: string): Promise<void> => {
  const file = await open(path, "w");
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
};

type ApplyReviewedCitationLabelsOptions = {
  transact: Transact;
  input: readonly unknown[];
  /** Where the per-entry results land once the run commits. */
  resultsPath: string;
};

/**
 * Apply a run and record its per-entry results with it. The results are
 * written next to `resultsPath` inside the transaction, so a failed write
 * rolls the labels back; only a committed run moves them into place. A run
 * that does not commit leaves no results file behind.
 */
export const applyReviewedCitationLabels = async ({
  transact,
  input,
  resultsPath,
}: ApplyReviewedCitationLabelsOptions): Promise<
  Result<ReviewedLabelApplication, ReviewedLabelApplyError>
> => {
  const temporaryPath = `${resultsPath}.${process.pid}.tmp`;
  const applied = await Result.tryPromise(
    async () =>
      await runCitationGraphTransaction(transact, async (tx) => {
        const application = await applyReviewedLabelsTx(tx, input);
        await writeDurably(
          temporaryPath,
          reviewedLabelResultLines(application.rows, "apply"),
        );
        return application;
      }),
  );
  if (applied.isErr()) {
    const removed = await Result.tryPromise(
      async () => await rm(temporaryPath, { force: true }),
    );
    const leftover = removed.isErr()
      ? `; could not remove ${temporaryPath}: ${removed.error.message}`
      : "";
    return Result.err(
      new ReviewedLabelApplyError({
        code: REVIEWED_LABEL_APPLY_FAILURE.NOT_APPLIED,
        message: `Nothing was applied: ${applied.error.message}${leftover}`,
        cause: applied.error,
      }),
    );
  }
  const placed = await Result.tryPromise(
    async () => await rename(temporaryPath, resultsPath),
  );
  if (placed.isErr()) {
    return Result.err(
      new ReviewedLabelApplyError({
        code: REVIEWED_LABEL_APPLY_FAILURE.RESULTS_NOT_PLACED,
        message: `The labels were applied and their results are in ${temporaryPath}, but moving them to ${resultsPath} failed: ${placed.error.message}`,
        cause: placed.error,
      }),
    );
  }
  return Result.ok(applied.value);
};
