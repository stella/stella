import { afterAll, beforeAll, describe, expect, test } from "bun:test";
/**
 * A reviewed citation label against every writer of citation polarity: the
 * ingestion refresh, the recheck walk, the classifier's write, rule
 * retirement, and the script that stores the review.
 *
 * Each citing sentence here is one the shipped Czech rules read as negative,
 * so every fixture is asserted to carry a rule's verdict before a review or a
 * pass is applied to it.
 */
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitationReviews,
  caseLawCitations,
  caseLawPolarityRules,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { persistPolarity } from "@/api/handlers/case-law/polarity/classifier";
import {
  CITATION_REVIEW_ORIGIN,
  CITATION_REVIEW_ORIGINS,
  POLARITY,
  RULE_SOURCE,
} from "@/api/handlers/case-law/polarity/consts";
import type { CitationReviewOrigin } from "@/api/handlers/case-law/polarity/consts";
import {
  persistTightened,
  recheckCitationPolarity,
} from "@/api/handlers/case-law/polarity/recheck";
import { loadRules } from "@/api/handlers/case-law/polarity/rule-engine";
import { resetRetiredRuleVerdicts } from "@/api/handlers/case-law/polarity/rule-retirement";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  REVIEWED_LABEL_INVALID_REASON,
  REVIEWED_LABEL_OUTCOME,
  reviewedCitationLabelEntrySchema,
  reviewedLabelResultLines,
  runReviewedCitationLabels,
} from "@/api/scripts/apply-reviewed-citation-labels-plan";
import type { ReviewedCitationLabelEntry } from "@/api/scripts/apply-reviewed-citation-labels-plan";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const connect = (pglite: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({
    client: pglite,
    relations: { ...relations, ...authRelationsPart },
  });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;
let sourceId: SafeId<"caseLawSource">;
let observationOrder = 0n;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the pipeline expects.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

const transactionRunner = {
  transaction: async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    await scopedDb(fn),
};

const corpus: CaseLawCorpusDependencies = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => {
      throw new TypeError(
        "a postgres-only plan must not transfer corpus packs",
      );
    },
  },
};

/** A sentence the shipped Czech rules read as a departure from `cited`. */
const departureFrom = (cited: string): string =>
  `Od závěrů rozsudku ${cited} se velký senát odchyluje.`;

type IngestOptions = {
  caseNumber: string;
  cited: string;
  rawHash: string;
  /** A section before the citing one, which moves the citation's section. */
  leading?: string;
};

const ingest = async ({
  caseNumber,
  cited,
  rawHash,
  leading,
}: IngestOptions) => {
  observationOrder += 1n;
  const citing = departureFrom(cited);
  const paragraphs = leading === undefined ? [citing] : [leading, citing];
  const text = paragraphs.join("\n\n");
  const input: IngestionResult = plainTextIngestionResult({
    caseNumber,
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionType: "rozsudek",
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash,
    fulltext: text,
    sections: paragraphs.map((paragraph, index) => ({
      index,
      type: "argumentation",
      title: null,
      text: paragraph,
    })),
    documentAst: EMPTY_AST,
  });
  const result = await processDecision({
    input,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-23T08:00:00.000Z"),
    observationOrder,
    refresh: DECISION_REFRESH.ALWAYS,
    corpus,
  });
  expect(result.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
};

const readCitation = async (citationText: string) => {
  const [row] = await db
    .select({
      id: caseLawCitations.id,
      citingDecisionId: caseLawCitations.citingDecisionId,
      citationKey: caseLawCitations.citationKey,
      polarity: caseLawCitations.polarity,
      polarityRuleId: caseLawCitations.polarityRuleId,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.citationText, citationText))
    .orderBy(desc(caseLawCitations.createdAt))
    .limit(1);
  if (row === undefined) {
    throw new TypeError(`expected a citation of ${citationText}`);
  }
  return row;
};

/** Ingest a decision and assert its one citation carries a rule's verdict. */
const ingestRuleLabelled = async (options: IngestOptions) => {
  await ingest(options);
  const row = await readCitation(options.cited);
  expect(row.polarity).toBe(POLARITY.NEGATIVE);
  expect(row.polarityRuleId).not.toBeNull();
  expect(row.citationKey).not.toBeNull();
  return row;
};

type LabelledRow = Awaited<ReturnType<typeof readCitation>>;

/** `xmin`/`xmax` of one row: unchanged, nobody wrote or locked it. */
const tupleHeader = async (id: SafeId<"caseLawCitation">): Promise<unknown> =>
  (
    await db.execute(sql`
      SELECT xmin::text AS xmin, xmax::text AS xmax
        FROM ${caseLawCitations}
       WHERE id = ${id}::uuid
    `)
  ).rows;

const labelFor = (
  row: LabelledRow,
  polarity: ReviewedCitationLabelEntry["polarity"],
): ReviewedCitationLabelEntry => ({
  citingDecisionId: row.citingDecisionId,
  citationKey: row.citationKey ?? "",
  polarity,
  reviewRef: `review-${row.citingDecisionId}`,
  origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
});

const DIGEST = "b".repeat(64);

/** The origin fields of an entry: a model origin carries its provenance. */
const provenanceFor = (origin: CitationReviewOrigin, runId: string) =>
  origin === CITATION_REVIEW_ORIGIN.HUMAN_REVIEW
    ? { origin }
    : {
        origin,
        model: "annotator-1",
        promptVersion: "polarity-v1",
        promptSha256: DIGEST,
        evidenceSha256: DIGEST,
        runId,
        producedAt: "2026-10-07T08:00:00.000Z",
      };

const EMPTY_SUMMARY = {
  applied: 0,
  unchanged: 0,
  unmatched: 0,
  "refused-precedence": 0,
  invalid: 0,
  citationRows: 0,
};

const keyOf = (row: LabelledRow): string => {
  if (row.citationKey === null) {
    throw new TypeError("the fixture row carries a citation key");
  }
  return row.citationKey;
};

const readRule = async (ruleId: SafeId<"caseLawPolarityRule">) => {
  const [rule] = await db
    .select({ matchCount: caseLawPolarityRules.matchCount })
    .from(caseLawPolarityRules)
    .where(eq(caseLawPolarityRules.id, ruleId));
  return rule;
};

const readReviews = async () =>
  await db
    .select({
      citingDecisionId: caseLawCitationReviews.citingDecisionId,
      polarity: caseLawCitationReviews.polarity,
      updatedAt: caseLawCitationReviews.updatedAt,
    })
    .from(caseLawCitationReviews);

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
  sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `reviewed-labels-${sourceId}`,
    name: "reviewed citation labels fixture",
  });
  await db.insert(caseLawPolarityRules).values(
    SEED_RULES.filter((seed) => seed.language === "cs").map((seed) => ({
      pattern: seed.pattern,
      polarity: seed.polarity,
      language: seed.language,
      source: RULE_SOURCE.MANUAL,
    })),
  );
}, 120_000);

afterAll(async () => {
  await client.close();
});

const reviewedTransact: Parameters<
  typeof runReviewedCitationLabels
>[0] = async (run) => await run(db);

describe("reviewed citation labels", () => {
  test("a review moves a label off negative, is idempotent, and survives a refresh", async () => {
    const cited = "sp. zn. 23 Cdo 5068/2014";
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1001/2026",
      cited,
      rawHash: "first-sight",
    });
    const entries = [labelFor(labelled, POLARITY.POSITIVE)];

    const planned = await runReviewedCitationLabels(
      reviewedTransact,
      entries,
      "plan",
    );
    const ids = {
      citingDecisionId: labelled.citingDecisionId,
      citationKey: keyOf(labelled),
    };
    expect(planned).toEqual({
      type: "planned",
      rows: [{ ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.APPLIED }],
      summary: { ...EMPTY_SUMMARY, applied: 1, citationRows: 1 },
    });
    expect(await readReviews()).toEqual([]);
    expect(await readCitation(cited)).toEqual(labelled);

    const applied = await runReviewedCitationLabels(
      reviewedTransact,
      entries,
      "apply",
    );
    expect(applied).toMatchObject({ type: "applied", relabelled: 1 });
    expect(await readCitation(cited)).toMatchObject({
      id: labelled.id,
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
    });
    const stored = await readReviews();
    expect(stored).toHaveLength(1);

    const reapplied = await runReviewedCitationLabels(
      reviewedTransact,
      entries,
      "apply",
    );
    expect(reapplied).toEqual({
      type: "applied",
      rows: [{ ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.UNCHANGED }],
      summary: { ...EMPTY_SUMMARY, unchanged: 1 },
      relabelled: 0,
    });
    expect(await readReviews()).toEqual(stored);

    const ruleId = labelled.polarityRuleId;
    if (ruleId === null) {
      throw new TypeError("the fixture row carries a rule's verdict");
    }
    const before = await readRule(ruleId);
    const header = await tupleHeader(labelled.id);
    await ingest({
      caseNumber: "30 Cdo 1001/2026",
      cited,
      rawHash: "after-the-publisher-touched-it",
    });
    // The same document on a moved page: the reviewed row is the one the
    // document and its review describe, so the refresh leaves it untouched.
    expect(await readCitation(cited)).toEqual({
      ...labelled,
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
    });
    expect(await tupleHeader(labelled.id)).toEqual(header);
    // The rule reads the mention and neither labels the row nor counts it.
    expect(await readRule(ruleId)).toEqual(before);
  });

  test("a changed document rewrites a reviewed row with its review", async () => {
    const cited = "sp. zn. 23 Cdo 5069/2014";
    const caseNumber = "30 Cdo 1005/2026";
    const labelled = await ingestRuleLabelled({
      caseNumber,
      cited,
      rawHash: "first-sight",
    });
    await runReviewedCitationLabels(
      reviewedTransact,
      [labelFor(labelled, POLARITY.POSITIVE)],
      "apply",
    );
    const ruleId = labelled.polarityRuleId;
    if (ruleId === null) {
      throw new TypeError("the fixture row carries a rule's verdict");
    }
    const before = await readRule(ruleId);
    await ingest({
      caseNumber,
      cited,
      rawHash: "a-new-section",
      leading: "Dovolání je přípustné.",
    });
    const rewritten = await readCitation(cited);
    // The fault boundary: the sentence changed, so the row is a new one.
    expect(rewritten.id).not.toBe(labelled.id);
    expect(rewritten).toMatchObject({
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
    });
    expect(await readRule(ruleId)).toEqual(before);
  });

  test("the recheck walk and the classifier's write leave a reviewed row alone", async () => {
    const unreviewed = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1002/2026",
      cited: "sp. zn. 29 Cdo 2002/2015",
      rawHash: "unreviewed",
    });
    const reviewed = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1003/2026",
      cited: "sp. zn. 29 Cdo 3003/2015",
      rawHash: "reviewed",
    });
    const ruleId = reviewed.polarityRuleId;
    if (ruleId === null) {
      throw new TypeError("the fixture row carries a rule's verdict");
    }
    // Labels written before the negative rule existed: the recheck's input.
    for (const { id } of [unreviewed, reviewed]) {
      await db
        .update(caseLawCitations)
        .set({ polarity: POLARITY.POSITIVE, polarityRuleId: null })
        .where(eq(caseLawCitations.id, id));
    }
    const applied = await runReviewedCitationLabels(
      reviewedTransact,
      [
        {
          citationId: reviewed.id,
          polarity: POLARITY.POSITIVE,
          reviewRef: "review-by-citation-id",
          origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
        },
      ],
      "apply",
    );
    expect(applied).toMatchObject({
      type: "applied",
      summary: { applied: 1 },
      relabelled: 0,
    });

    const recheck = await recheckCitationPolarity({
      scopedDb,
      language: "cs",
      rules: await loadRules("cs", scopedDb, new Map()),
      after: null,
      limit: 1000,
      dryRun: false,
    });
    // Only the unreviewed row: the reviewed ones here and in the test above
    // carry the same departure and are not read at all.
    expect(recheck.totals.tightened).toBe(1);
    expect(await readCitation("sp. zn. 29 Cdo 2002/2015")).toMatchObject({
      polarity: POLARITY.NEGATIVE,
    });
    expect(await readCitation("sp. zn. 29 Cdo 3003/2015")).toMatchObject({
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
    });

    // A verdict read before the review landed is not written over it.
    await persistTightened(scopedDb, [
      { id: reviewed.id, polarity: POLARITY.NEGATIVE, ruleId },
    ]);
    await persistPolarity(
      reviewed.id,
      {
        polarity: POLARITY.NEGATIVE,
        ruleId,
        source: "regex",
        confidence: 1,
      },
      scopedDb,
    );
    expect(await readCitation("sp. zn. 29 Cdo 3003/2015")).toMatchObject({
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
    });
    // The same write reaches a row no review covers.
    await persistPolarity(
      unreviewed.id,
      {
        polarity: POLARITY.NEUTRAL,
        ruleId: null,
        source: "llm",
        confidence: 1,
      },
      scopedDb,
    );
    expect(await readCitation("sp. zn. 29 Cdo 2002/2015")).toMatchObject({
      polarity: POLARITY.NEUTRAL,
    });
  });

  test("an entry that does not validate or resolve is invalid, and the rest still apply", async () => {
    const cited = "sp. zn. 29 Cdo 4004/2015";
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1004/2026",
      cited,
      rawHash: "refused",
    });
    const valid = labelFor(labelled, POLARITY.NEUTRAL);
    const annotated = {
      ...valid,
      ...provenanceFor(CITATION_REVIEW_ORIGIN.AI_ANNOTATION, "run-invalid"),
    };
    // The fault boundary: the annotated entry is a valid one.
    expect(
      v.safeParse(reviewedCitationLabelEntrySchema, annotated).success,
    ).toBe(true);
    const missingCitation = createSafeId<"caseLawCitation">();
    const missingDecision = createSafeId<"caseLawDecision">();
    const input: unknown[] = [
      valid,
      { ...valid, polarity: POLARITY.UNKNOWN },
      { ...valid, polarity: "overruled" },
      { ...valid, extra: 1 },
      { ...valid, origin: CITATION_REVIEW_ORIGIN.AI_ANNOTATION },
      { ...valid, model: "annotator-1" },
      { ...annotated, promptSha256: "not-a-digest" },
      { ...annotated, producedAt: "yesterday" },
      {
        citationId: missingCitation,
        polarity: POLARITY.NEUTRAL,
        reviewRef: "review-of-nothing",
        origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
      },
      {
        citingDecisionId: missingDecision,
        citationKey: "no-such-decision",
        polarity: POLARITY.NEUTRAL,
        reviewRef: "review-of-nothing",
        origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
      },
    ];
    const outcome = await runReviewedCitationLabels(
      reviewedTransact,
      input,
      "apply",
    );
    const schemaInvalid = (index: number) => ({
      index,
      outcome: REVIEWED_LABEL_OUTCOME.INVALID,
      reason: REVIEWED_LABEL_INVALID_REASON.SCHEMA,
    });
    expect(outcome.rows).toEqual([
      {
        index: 0,
        citingDecisionId: labelled.citingDecisionId,
        citationKey: keyOf(labelled),
        outcome: REVIEWED_LABEL_OUTCOME.APPLIED,
      },
      ...[1, 2, 3, 4, 5, 6, 7].map(schemaInvalid),
      {
        index: 8,
        citationId: missingCitation,
        outcome: REVIEWED_LABEL_OUTCOME.INVALID,
        reason: REVIEWED_LABEL_INVALID_REASON.NO_SUCH_CITATION,
      },
      {
        index: 9,
        citingDecisionId: missingDecision,
        citationKey: "no-such-decision",
        outcome: REVIEWED_LABEL_OUTCOME.INVALID,
        reason: REVIEWED_LABEL_INVALID_REASON.NO_SUCH_DECISION,
      },
    ]);
    expect(await readCitation(cited)).toMatchObject({
      polarity: POLARITY.NEUTRAL,
      polarityRuleId: null,
    });

    // One line per entry, in order, with identifiers and the outcome only.
    const lines = reviewedLabelResultLines(outcome.rows, "apply")
      .trimEnd()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(lines).toEqual(
      outcome.rows.map((row) => ({ ...row, mode: "apply" })),
    );
    expect(lines).toHaveLength(input.length);
    const resultKeys = new Set(
      lines.flatMap((line) => Object.keys(Object(line))),
    );
    expect(
      [...resultKeys].filter(
        (key) =>
          ![
            "index",
            "outcome",
            "reason",
            "citationId",
            "citingDecisionId",
            "citationKey",
            "mode",
          ].includes(key),
      ),
    ).toEqual([]);
  });

  test("entries for one citation resolve by origin precedence, and a tie stands for neither", async () => {
    const cited = "sp. zn. 29 Cdo 7007/2015";
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1007/2026",
      cited,
      rawHash: "precedence-within-a-file",
    });
    const ids = {
      citingDecisionId: labelled.citingDecisionId,
      citationKey: keyOf(labelled),
    };
    const outranked = await runReviewedCitationLabels(
      reviewedTransact,
      [
        {
          ...labelFor(labelled, POLARITY.NEUTRAL),
          ...provenanceFor(CITATION_REVIEW_ORIGIN.AI_ANNOTATION, "run-a"),
        },
        labelFor(labelled, POLARITY.POSITIVE),
      ],
      "apply",
    );
    expect(outranked.rows).toEqual([
      { ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE },
      { ...ids, index: 1, outcome: REVIEWED_LABEL_OUTCOME.APPLIED },
    ]);
    expect(await readCitation(cited)).toMatchObject({
      polarity: POLARITY.POSITIVE,
    });

    const tied = await runReviewedCitationLabels(
      reviewedTransact,
      [
        labelFor(labelled, POLARITY.NEUTRAL),
        labelFor(labelled, POLARITY.NEGATIVE),
      ],
      "apply",
    );
    expect(tied.rows).toEqual(
      [0, 1].map((index) => ({
        ...ids,
        index,
        outcome: REVIEWED_LABEL_OUTCOME.INVALID,
        reason: REVIEWED_LABEL_INVALID_REASON.DUPLICATE,
      })),
    );
    expect(await readCitation(cited)).toMatchObject({
      polarity: POLARITY.POSITIVE,
    });
  });

  test("a stored review is replaced only by one of equal or higher origin precedence", async () => {
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1008/2026",
      cited: "sp. zn. 29 Cdo 8008/2015",
      rawHash: "precedence-across-runs",
    });
    const pairs = CITATION_REVIEW_ORIGINS.flatMap((stored) =>
      CITATION_REVIEW_ORIGINS.map((incoming) => ({ stored, incoming })),
    );
    expect(pairs).toHaveLength(CITATION_REVIEW_ORIGINS.length ** 2);
    for (const { stored, incoming } of pairs) {
      // A key no citation row carries yet: stored, applied on a refresh.
      const citationKey = `precedence-${stored}-${incoming}`;
      const entry = (
        polarity: typeof POLARITY.POSITIVE | typeof POLARITY.NEGATIVE,
        origin: CitationReviewOrigin,
        runId: string,
      ) => ({
        citingDecisionId: labelled.citingDecisionId,
        citationKey,
        polarity,
        reviewRef: runId,
        ...provenanceFor(origin, runId),
      });
      const first = await runReviewedCitationLabels(
        reviewedTransact,
        [entry(POLARITY.POSITIVE, stored, "first")],
        "apply",
      );
      expect(first.rows.map((row) => row.outcome)).toEqual([
        REVIEWED_LABEL_OUTCOME.UNMATCHED,
      ]);
      // The declared order is the precedence: human, adjudicated, annotation.
      const replaces =
        CITATION_REVIEW_ORIGINS.indexOf(incoming) <=
        CITATION_REVIEW_ORIGINS.indexOf(stored);
      const second = await runReviewedCitationLabels(
        reviewedTransact,
        [entry(POLARITY.NEGATIVE, incoming, "second")],
        "apply",
      );
      expect(second.rows.map((row) => row.outcome)).toEqual([
        replaces
          ? REVIEWED_LABEL_OUTCOME.UNMATCHED
          : REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE,
      ]);
      const winner = replaces
        ? { origin: incoming, polarity: POLARITY.NEGATIVE, runId: "second" }
        : { origin: stored, polarity: POLARITY.POSITIVE, runId: "first" };
      const human = winner.origin === CITATION_REVIEW_ORIGIN.HUMAN_REVIEW;
      expect(
        (
          await db.execute(sql`
            SELECT origin, polarity, review_ref, model, prompt_version,
                   prompt_sha256, evidence_sha256, run_id,
                   produced_at IS NOT NULL AS produced
              FROM ${caseLawCitationReviews}
             WHERE citing_decision_id = ${labelled.citingDecisionId}::uuid
               AND citation_key = ${citationKey}
          `)
        ).rows,
      ).toEqual([
        {
          origin: winner.origin,
          polarity: winner.polarity,
          review_ref: winner.runId,
          model: human ? null : "annotator-1",
          prompt_version: human ? null : "polarity-v1",
          prompt_sha256: human ? null : DIGEST,
          evidence_sha256: human ? null : DIGEST,
          run_id: human ? null : winner.runId,
          produced: !human,
        },
      ]);
    }
  });

  // Last: it retires a shipped rule for the rest of the file.
  test("retiring a rule leaves a reviewed row's label", async () => {
    const unreviewed = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1005/2026",
      cited: "sp. zn. 29 Cdo 5005/2015",
      rawHash: "retired-unreviewed",
    });
    const reviewed = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1006/2026",
      cited: "sp. zn. 29 Cdo 6006/2015",
      rawHash: "retired-reviewed",
    });
    const ruleId = reviewed.polarityRuleId;
    if (ruleId === null) {
      throw new TypeError("the fixture row carries a rule's verdict");
    }
    expect(unreviewed.polarityRuleId).toBe(ruleId);
    await runReviewedCitationLabels(
      reviewedTransact,
      [labelFor(reviewed, POLARITY.NEUTRAL)],
      "apply",
    );

    await db
      .update(caseLawPolarityRules)
      .set({ source: RULE_SOURCE.RETIRED })
      .where(eq(caseLawPolarityRules.id, ruleId));
    const reset = await resetRetiredRuleVerdicts(transactionRunner, [ruleId]);

    expect(reset).toContain(unreviewed.id);
    expect(reset).not.toContain(reviewed.id);
    expect(await readCitation("sp. zn. 29 Cdo 6006/2015")).toMatchObject({
      polarity: POLARITY.NEUTRAL,
      polarityRuleId: null,
    });
  });
});
