import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
/**
 * A reviewed citation label against every writer of citation polarity: the
 * ingestion refresh, the recheck walk, the classifier's write, rule
 * retirement, and the script that stores the review.
 *
 * Each citing sentence here is one the shipped Czech rules read as negative,
 * so every fixture is asserted to carry a rule's verdict before a review or a
 * pass is applied to it.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitationReviews,
  caseLawCitations,
  caseLawDecisions,
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
  AI_CITATION_REVIEW_ORIGINS,
  CITATION_REVIEW_ORIGIN,
  CITATION_REVIEW_ORIGINS,
  POLARITY,
  RULE_SOURCE,
  citationReviewMayReplace,
} from "@/api/handlers/case-law/polarity/consts";
import type {
  CitationReviewOrigin,
  CitationReviewStanding,
} from "@/api/handlers/case-law/polarity/consts";
import {
  persistTightened,
  recheckCitationPolarity,
} from "@/api/handlers/case-law/polarity/recheck";
import { loadRules } from "@/api/handlers/case-law/polarity/rule-engine";
import { resetRetiredRuleVerdicts } from "@/api/handlers/case-law/polarity/rule-retirement";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";
import { citationTextRevisionFingerprintSql } from "@/api/handlers/case-law/polarity/text-revision";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { CITATION_STORAGE_WIDTHS } from "@/api/lib/case-law/citation-storage-bounds";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  REVIEWED_LABEL_APPLY_FAILURE,
  REVIEWED_LABEL_INVALID_REASON,
  REVIEWED_LABEL_OUTCOME,
  applyReviewedCitationLabels,
  planReviewedCitationLabels,
  reviewMayReplaceSql,
  reviewedCitationLabelEntrySchema,
  reviewedLabelResultLines,
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
let resultsDir: string;

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
  /** A section after the citing one, preserving its position while revising text. */
  trailing?: string;
};

const ingest = async ({
  caseNumber,
  cited,
  rawHash,
  leading,
  trailing,
}: IngestOptions) => {
  observationOrder += 1n;
  const citing = departureFrom(cited);
  const paragraphs = [
    ...(leading === undefined ? [] : [leading]),
    citing,
    ...(trailing === undefined ? [] : [trailing]),
  ];
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

const REVIEW_POLARITY_SOURCE = "review";

const readCitation = async (citationText: string) => {
  const [row] = await db
    .select({
      id: caseLawCitations.id,
      citingDecisionId: caseLawCitations.citingDecisionId,
      citationKey: caseLawCitations.citationKey,
      polarity: caseLawCitations.polarity,
      polarityRuleId: caseLawCitations.polarityRuleId,
      polaritySource: caseLawCitations.polaritySource,
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

const textRevisionFor = async (id: SafeId<"caseLawDecision">) => {
  const row = (
    await db
      .select({
        contentHash: caseLawDecisions.contentHash,
        sections: caseLawDecisions.sections,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, id))
  ).at(0);
  if (row === undefined) {
    throw new TypeError("Expected a decision text revision");
  }
  return row;
};

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

const textRevisionSha256For = async (id: SafeId<"caseLawDecision">) => {
  const row = (
    await db.execute(
      sql`SELECT ${citationTextRevisionFingerprintSql({ contentHash: caseLawDecisions.contentHash, sections: caseLawDecisions.sections })} AS digest FROM ${caseLawDecisions} WHERE id = ${id}::uuid`,
    )
  ).rows.at(0);
  if (typeof row?.["digest"] !== "string") {
    throw new TypeError("Expected a decision text fingerprint");
  }
  return row["digest"];
};

const DIGEST = "b".repeat(64);
const PRODUCED_AT = "2026-10-07T08:00:00.000Z";
const LATER = "2026-10-07T09:00:00.000Z";

/** The origin fields of an entry: a model origin carries its provenance. */
const provenanceFor = (
  origin: CitationReviewOrigin,
  runId: string,
  textRevisionSha256: string,
  producedAt = PRODUCED_AT,
) =>
  origin === CITATION_REVIEW_ORIGIN.HUMAN_REVIEW
    ? { origin }
    : {
        origin,
        model: "annotator-1",
        promptVersion: "polarity-v1",
        promptSha256: DIGEST,
        evidenceSha256: DIGEST,
        textRevisionSha256,
        runId,
        producedAt,
      };

const EMPTY_SUMMARY = {
  applied: 0,
  unchanged: 0,
  unmatched: 0,
  "refused-precedence": 0,
  invalid: 0,
  citationRows: 0,
  stale: 0,
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
  resultsDir = await mkdtemp(path.join(tmpdir(), "reviewed-labels-"));
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
      kind: seed.kind,
      polarity: seed.polarity,
      language: seed.language,
      source: RULE_SOURCE.MANUAL,
    })),
  );
}, 120_000);

afterAll(async () => {
  await client.close();
  await rm(resultsDir, { recursive: true, force: true });
});

const reviewedTransact: Parameters<
  typeof planReviewedCitationLabels
>[0] = async (run) => await db.transaction(async (tx) => await run(tx));

const resultsPath = (): string => path.join(resultsDir, "results.jsonl");

const planLabels = async (input: readonly unknown[]) =>
  await planReviewedCitationLabels(reviewedTransact, input);

const applyLabels = async (input: readonly unknown[]) => {
  const applied = await applyReviewedCitationLabels({
    transact: reviewedTransact,
    input,
    resultsPath: resultsPath(),
  });
  if (applied.isErr()) {
    throw applied.error;
  }
  return applied.value;
};

describe("reviewed citation labels", () => {
  test("plan and apply agree on model labels for listing-only decisions", async () => {
    const cited = "sp. zn. 29 Cdo 4099/2015";
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1099/2026",
      cited,
      rawHash: "listing-review-eligibility",
    });
    const entry = {
      ...labelFor(labelled, POLARITY.POSITIVE),
      ...provenanceFor(
        CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
        "listing-review",
        await textRevisionSha256For(labelled.citingDecisionId),
      ),
    };
    expect(v.safeParse(reviewedCitationLabelEntrySchema, entry).success).toBe(
      true,
    );
    await db
      .update(caseLawDecisions)
      .set({ metadata: metadataMarkedListingOnly(caseLawDecisions.metadata) })
      .where(eq(caseLawDecisions.id, labelled.citingDecisionId));
    const planned = await planLabels([entry]);
    const applied = await applyLabels([entry]);
    expect(planned.rows).toEqual([
      {
        index: 0,
        citingDecisionId: labelled.citingDecisionId,
        citationKey: keyOf(labelled),
        outcome: REVIEWED_LABEL_OUTCOME.STALE,
      },
    ]);
    expect(applied.rows).toEqual(planned.rows);
    expect(applied.summary).toEqual(planned.summary);
    expect(await readCitation(cited)).toEqual(labelled);
    const stored = await db
      .select({ id: caseLawCitationReviews.id })
      .from(caseLawCitationReviews)
      .where(
        eq(caseLawCitationReviews.citingDecisionId, labelled.citingDecisionId),
      );
    expect(stored).toEqual([]);
  });

  test.each(CITATION_REVIEW_ORIGINS)(
    "review origin %s stores a PostgreSQL-width key with its provenance",
    async (origin) => {
      const number = 9010 + CITATION_REVIEW_ORIGINS.indexOf(origin);
      const cited = `sp. zn. 29 Cdo ${number}/2015`;
      const labelled = await ingestRuleLabelled({
        caseNumber: `30 Cdo ${number}/2026`,
        cited,
        rawHash: `unicode-key-${origin}`,
      });
      const citationKey = "😀".repeat(CITATION_STORAGE_WIDTHS.key);
      expect(Array.from(citationKey)).toHaveLength(CITATION_STORAGE_WIDTHS.key);
      expect(citationKey.length).toBeGreaterThan(CITATION_STORAGE_WIDTHS.key);
      await db
        .update(caseLawCitations)
        .set({ citationKey })
        .where(eq(caseLawCitations.id, labelled.id));
      const entry = {
        ...labelFor({ ...labelled, citationKey }, POLARITY.POSITIVE),
        ...provenanceFor(
          origin,
          `unicode-${origin}`,
          await textRevisionSha256For(labelled.citingDecisionId),
        ),
      };
      expect(v.safeParse(reviewedCitationLabelEntrySchema, entry).success).toBe(
        true,
      );
      const outcome = await applyLabels([entry]);
      expect(outcome.rows).toMatchObject([
        { outcome: REVIEWED_LABEL_OUTCOME.APPLIED },
      ]);
      const [review] = await db
        .select()
        .from(caseLawCitationReviews)
        .where(
          eq(
            caseLawCitationReviews.citingDecisionId,
            labelled.citingDecisionId,
          ),
        );
      expect(review).toMatchObject({
        citationKey,
        polarity: POLARITY.POSITIVE,
        origin,
      });
      switch (origin) {
        case CITATION_REVIEW_ORIGIN.HUMAN_REVIEW:
          expect(review).toMatchObject({
            model: null,
            promptVersion: null,
            promptSha256: null,
            evidenceSha256: null,
            runId: null,
            producedAt: null,
          });
          break;
        case CITATION_REVIEW_ORIGIN.AI_ADJUDICATED:
        case CITATION_REVIEW_ORIGIN.AI_ANNOTATION:
          expect(review).toMatchObject({
            model: "annotator-1",
            promptVersion: "polarity-v1",
            promptSha256: DIGEST,
            evidenceSha256: DIGEST,
            runId: `unicode-${origin}`,
          });
          expect(review?.producedAt?.toISOString()).toBe(PRODUCED_AT);
          break;
        default:
          origin satisfies never;
      }
      for (const invalidKey of [`${citationKey}😀`, "", "key\u0000with-nul"]) {
        const invalid = await planLabels([
          { ...entry, citationKey: invalidKey },
        ]);
        expect(invalid.rows).toMatchObject([
          {
            outcome: REVIEWED_LABEL_OUTCOME.INVALID,
            reason: REVIEWED_LABEL_INVALID_REASON.SCHEMA,
          },
        ]);
      }
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, labelled.citingDecisionId));
    },
  );

  test("a review moves a label off negative, is idempotent, and survives a refresh", async () => {
    const cited = "sp. zn. 23 Cdo 5068/2014";
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1001/2026",
      cited,
      rawHash: "first-sight",
    });
    const entries = [labelFor(labelled, POLARITY.POSITIVE)];

    const planned = await planLabels(entries);
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

    const applied = await applyLabels(entries);
    expect(applied).toMatchObject({ type: "applied", relabelled: 1 });
    expect(await readCitation(cited)).toMatchObject({
      id: labelled.id,
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
    });
    const stored = await readReviews();
    expect(stored).toHaveLength(1);

    const reapplied = await applyLabels(entries);
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
      id: labelled.id,
      citingDecisionId: labelled.citingDecisionId,
      citationKey: labelled.citationKey,
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
      polaritySource: REVIEW_POLARITY_SOURCE,
    } satisfies LabelledRow);
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
    await applyLabels([labelFor(labelled, POLARITY.POSITIVE)]);
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

  test("a recheck skips a citation when its decision text changes before writing", async () => {
    const citationText = "sp. zn. 29 Cdo 8808/2015";
    const citation = await ingestRuleLabelled({
      caseNumber: "30 Cdo 8808/2026",
      cited: citationText,
      rawHash: "recheck-text-revision",
    });
    await db
      .update(caseLawCitations)
      .set({ polarity: POLARITY.POSITIVE, polarityRuleId: null })
      .where(eq(caseLawCitations.id, citation.id));
    const before = await readCitation(citationText);
    const headerBefore = await tupleHeader(citation.id);
    let calls = 0;
    const changingDb: ScopedDb = async (run) => {
      calls++;
      if (calls === 2) {
        await db
          .update(caseLawDecisions)
          .set({
            sections: [
              {
                index: 0,
                type: "argumentation",
                title: null,
                text: "Updated decision text.",
              },
            ],
          })
          .where(eq(caseLawDecisions.id, citation.citingDecisionId));
      }
      return await scopedDb(run);
    };
    const result = await recheckCitationPolarity({
      scopedDb: changingDb,
      language: "cs",
      rules: await loadRules("cs", scopedDb, new Map()),
      after: null,
      limit: 1000,
      dryRun: false,
    });
    expect(result.totals.skipped).toBe(1);
    expect(await readCitation(citationText)).toEqual(before);
    expect(await tupleHeader(citation.id)).toEqual(headerBefore);
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
    const applied = await applyLabels([
      {
        citationId: reviewed.id,
        polarity: POLARITY.POSITIVE,
        reviewRef: "review-by-citation-id",
        origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
      },
    ]);
    expect(applied).toMatchObject({
      type: "applied",
      summary: { applied: 1 },
      relabelled: 1,
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
      {
        id: reviewed.id,
        citingDecisionId: reviewed.citingDecisionId,
        textRevision: await textRevisionFor(reviewed.citingDecisionId),
        polarity: POLARITY.NEGATIVE,
        previousPolarity: POLARITY.NEUTRAL,
        ruleId,
        windowStart: 0,
        windowEnd: 10,
        confidence: 1,
        citedPart: "not-stated",
      },
    ]);
    await persistPolarity({
      citationId: reviewed.id,
      textRevision: await textRevisionFor(reviewed.citingDecisionId),
      result: {
        polarity: POLARITY.NEGATIVE,
        ruleId,
        source: "regex",
        classifierVersion: "citation-polarity-v2",
        windowStart: 0,
        windowEnd: 10,
        citedPart: "not-stated",
        confidence: 1,
      },
      scopedDb,
    });
    expect(await readCitation("sp. zn. 29 Cdo 3003/2015")).toMatchObject({
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
    });
    // The same write reaches a row no review covers.
    await persistPolarity({
      citationId: unreviewed.id,
      textRevision: await textRevisionFor(unreviewed.citingDecisionId),
      result: {
        polarity: POLARITY.NEUTRAL,
        ruleId: null,
        source: "llm",
        classifierVersion: "citation-polarity-v2",
        windowStart: 0,
        windowEnd: 10,
        citedPart: "not-stated",
        confidence: 1,
      },
      scopedDb,
    });
    expect(await readCitation("sp. zn. 29 Cdo 2002/2015")).toMatchObject({
      polarity: POLARITY.NEUTRAL,
    });
    const evidence = await db
      .select({
        id: caseLawCitations.id,
        source: caseLawCitations.polaritySource,
        classifierVersion: caseLawCitations.polarityClassifierVersion,
        windowStart: caseLawCitations.polarityWindowStart,
        windowEnd: caseLawCitations.polarityWindowEnd,
        confidence: caseLawCitations.polarityConfidence,
        citedPart: caseLawCitations.citedPart,
      })
      .from(caseLawCitations)
      .where(inArray(caseLawCitations.id, [reviewed.id, unreviewed.id]));
    expect(evidence.find(({ id }) => id === reviewed.id)).toMatchObject({
      source: "review",
      classifierVersion: null,
      windowStart: null,
      windowEnd: null,
      confidence: null,
    });
    expect(evidence.find(({ id }) => id === unreviewed.id)).toMatchObject({
      source: "llm",
      classifierVersion: "citation-polarity-v2",
      windowStart: 0,
      windowEnd: 10,
      confidence: 1,
      citedPart: "not-stated",
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
      ...provenanceFor(
        CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
        "run-invalid",
        await textRevisionSha256For(labelled.citingDecisionId),
      ),
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
      // ISO-shaped, but the calendar has no 30 February.
      { ...annotated, producedAt: "2026-02-30T08:00:00Z" },
      // Real instants the database cannot store or no label can carry.
      { ...annotated, producedAt: "0000-01-01T00:00:00Z" },
      { ...annotated, producedAt: "9999-12-31T00:00:00Z" },
      // Postgres refuses NUL in a text parameter.
      { ...annotated, model: "\u0000" },
      { ...valid, reviewRef: "review\u0000ref" },
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
    const outcome = await applyLabels(input);
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
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(schemaInvalid),
      {
        index: 13,
        citationId: missingCitation,
        outcome: REVIEWED_LABEL_OUTCOME.INVALID,
        reason: REVIEWED_LABEL_INVALID_REASON.NO_SUCH_CITATION,
      },
      {
        index: 14,
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
    const written = await Bun.file(resultsPath()).text();
    expect(written).toBe(reviewedLabelResultLines(outcome.rows, "apply"));
    const lines = written
      .trimEnd()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(lines).toEqual(
      outcome.rows.map((row) => ({ ...row, mode: "apply" })),
    );
    expect(lines).toHaveLength(input.length);
    const resultKeys = new Set(
      lines.flatMap((line) => Object.keys(new Object(line))),
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
    const outranked = await applyLabels([
      {
        ...labelFor(labelled, POLARITY.NEUTRAL),
        ...provenanceFor(
          CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
          "run-a",
          await textRevisionSha256For(labelled.citingDecisionId),
        ),
      },
      labelFor(labelled, POLARITY.POSITIVE),
    ]);
    expect(outranked.rows).toEqual([
      { ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE },
      { ...ids, index: 1, outcome: REVIEWED_LABEL_OUTCOME.APPLIED },
    ]);
    expect(await readCitation(cited)).toMatchObject({
      polarity: POLARITY.POSITIVE,
    });

    const tied = await applyLabels([
      labelFor(labelled, POLARITY.NEUTRAL),
      labelFor(labelled, POLARITY.NEGATIVE),
    ]);
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

  test("a stored review is replaced by a better origin, or a later label of its own", async () => {
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1008/2026",
      cited: "sp. zn. 29 Cdo 8008/2015",
      rawHash: "precedence-across-runs",
    });
    const textRevisionSha256 = await textRevisionSha256For(
      labelled.citingDecisionId,
    );
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
        producedAt: string,
      ) => ({
        citingDecisionId: labelled.citingDecisionId,
        citationKey,
        polarity,
        reviewRef: runId,
        ...provenanceFor(origin, runId, textRevisionSha256, producedAt),
      });
      const first = await applyLabels([
        entry(POLARITY.POSITIVE, stored, "first", PRODUCED_AT),
      ]);
      expect(first.rows.map((row) => row.outcome)).toEqual([
        REVIEWED_LABEL_OUTCOME.UNMATCHED,
      ]);
      // The declared order is the precedence: human, adjudicated, annotation.
      // The second run is the later one, so an equal origin replaces.
      const replaces =
        CITATION_REVIEW_ORIGINS.indexOf(incoming) <=
        CITATION_REVIEW_ORIGINS.indexOf(stored);
      const second = await applyLabels([
        entry(POLARITY.NEGATIVE, incoming, "second", LATER),
      ]);
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

  test("an older run of one model origin applied after a newer one is refused", async () => {
    const cited = "sp. zn. 29 Cdo 9009/2015";
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1009/2026",
      cited,
      rawHash: "same-origin-older-run",
    });
    const ids = {
      citingDecisionId: labelled.citingDecisionId,
      citationKey: keyOf(labelled),
    };
    const textRevisionSha256 = await textRevisionSha256For(
      labelled.citingDecisionId,
    );
    const run = (
      polarity: typeof POLARITY.POSITIVE | typeof POLARITY.NEUTRAL,
      runId: string,
      producedAt: string,
    ) => ({
      ...labelFor(labelled, polarity),
      ...provenanceFor(
        CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
        runId,
        textRevisionSha256,
        producedAt,
      ),
    });
    const newer = run(POLARITY.POSITIVE, "run-b", LATER);
    expect((await applyLabels([newer])).rows).toEqual([
      { ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.APPLIED },
    ]);
    const storedReview = async () =>
      (
        await db.execute(sql`
          SELECT polarity, run_id FROM ${caseLawCitationReviews}
           WHERE citing_decision_id = ${labelled.citingDecisionId}::uuid
             AND citation_key = ${ids.citationKey}
        `)
      ).rows;

    const older = await applyLabels([
      run(POLARITY.NEUTRAL, "run-a", PRODUCED_AT),
    ]);
    expect(older.rows).toEqual([
      { ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE },
    ]);
    expect(older.relabelled).toBe(0);
    // Another run at the identical instant cannot flip the label either.
    const sameInstant = await applyLabels([
      run(POLARITY.NEUTRAL, "run-c", LATER),
    ]);
    expect(sameInstant.rows).toEqual([
      { ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE },
    ]);
    // Replaying the stored run is a no-op, not a refusal.
    expect((await applyLabels([newer])).rows).toEqual([
      { ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.UNCHANGED },
    ]);
    expect(await storedReview()).toEqual([
      { polarity: POLARITY.POSITIVE, run_id: "run-b" },
    ]);
    expect(await readCitation(cited)).toMatchObject({
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
    });

    // Within one file the same order holds: the later label stands.
    const key = `${ids.citationKey}-in-one-file`;
    const keyed = (entry: ReturnType<typeof run>) => ({
      ...entry,
      citationKey: key,
    });
    const inFile = await applyLabels([
      keyed(run(POLARITY.NEUTRAL, "run-a", PRODUCED_AT)),
      keyed(run(POLARITY.POSITIVE, "run-b", LATER)),
    ]);
    expect(inFile.rows.map(({ outcome }) => outcome)).toEqual([
      REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE,
      REVIEWED_LABEL_OUTCOME.UNMATCHED,
    ]);
    const tiedInFile = await applyLabels([
      keyed(run(POLARITY.NEUTRAL, "run-c", "2026-10-07T10:00:00.000Z")),
      keyed(run(POLARITY.POSITIVE, "run-d", "2026-10-07T10:00:00.000Z")),
    ]);
    expect(tiedInFile.rows).toEqual(
      [0, 1].map((index) => ({
        citingDecisionId: ids.citingDecisionId,
        citationKey: key,
        index,
        outcome: REVIEWED_LABEL_OUTCOME.INVALID,
        reason: REVIEWED_LABEL_INVALID_REASON.DUPLICATE,
      })),
    );
  });

  test.each(["stale-first", "current-first"] as const)(
    "a stale adjudication does not block current annotation in one batch (%s)",
    async (order) => {
      const suffix = order === "stale-first" ? "1031" : "1032";
      const cited = `sp. zn. 29 Cdo ${suffix}/2015`;
      const caseNumber = `30 Cdo ${suffix}/2026`;
      const labelled = await ingestRuleLabelled({
        caseNumber,
        cited,
        rawHash: `stale-review-${order}`,
      });
      const ids = {
        citingDecisionId: labelled.citingDecisionId,
        citationKey: keyOf(labelled),
      };
      const oldRevision = await textRevisionSha256For(
        labelled.citingDecisionId,
      );
      const adjudicated = {
        ...labelFor(labelled, POLARITY.POSITIVE),
        ...provenanceFor(
          CITATION_REVIEW_ORIGIN.AI_ADJUDICATED,
          `adjudicated-${order}`,
          oldRevision,
        ),
      };
      expect((await applyLabels([adjudicated])).rows).toEqual([
        { ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.APPLIED },
      ]);

      await ingest({
        caseNumber,
        cited,
        rawHash: `revised-text-${order}`,
        trailing: "The panel separately considers costs.",
      });
      const currentRevision = await textRevisionSha256For(
        labelled.citingDecisionId,
      );
      expect(currentRevision).not.toBe(oldRevision);
      const revisedCitation = await readCitation(cited);
      expect(revisedCitation.citationKey).toBe(ids.citationKey);
      const annotation = {
        ...labelFor(revisedCitation, POLARITY.NEUTRAL),
        ...provenanceFor(
          CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
          `annotation-${order}`,
          currentRevision,
          LATER,
        ),
      };
      const entries =
        order === "stale-first"
          ? [adjudicated, annotation]
          : [annotation, adjudicated];
      const staleIndex = order === "stale-first" ? 0 : 1;
      const currentIndex = 1 - staleIndex;
      const expectedRows = [
        {
          ...ids,
          index: staleIndex,
          outcome: REVIEWED_LABEL_OUTCOME.STALE,
        },
        {
          ...ids,
          index: currentIndex,
          outcome: REVIEWED_LABEL_OUTCOME.APPLIED,
        },
      ].toSorted((left, right) => left.index - right.index);

      const planned = await planLabels(entries);
      expect(planned.type).toBe("planned");
      expect(planned.rows).toEqual(expectedRows);
      expect(
        (
          await db.execute(sql`
            SELECT origin, polarity, text_revision_sha256
              FROM ${caseLawCitationReviews}
             WHERE citing_decision_id = ${labelled.citingDecisionId}::uuid
               AND citation_key = ${ids.citationKey}
          `)
        ).rows,
      ).toEqual([
        {
          origin: CITATION_REVIEW_ORIGIN.AI_ADJUDICATED,
          polarity: POLARITY.POSITIVE,
          text_revision_sha256: oldRevision,
        },
      ]);

      expect((await applyLabels(entries)).rows).toEqual(expectedRows);
      expect(
        (
          await db.execute(sql`
            SELECT origin, polarity, run_id, text_revision_sha256
              FROM ${caseLawCitationReviews}
             WHERE citing_decision_id = ${labelled.citingDecisionId}::uuid
               AND citation_key = ${ids.citationKey}
          `)
        ).rows,
      ).toEqual([
        {
          origin: CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
          polarity: POLARITY.NEUTRAL,
          run_id: `annotation-${order}`,
          text_revision_sha256: currentRevision,
        },
      ]);
      expect(await readCitation(cited)).toMatchObject({
        polarity: POLARITY.NEUTRAL,
        polarityRuleId: null,
        polaritySource: REVIEW_POLARITY_SOURCE,
      });
    },
  );

  test("a current lower-priority annotation cannot replace adjudication for the same revision", async () => {
    const cited = "sp. zn. 29 Cdo 1034/2015";
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1034/2026",
      cited,
      rawHash: "current-review-precedence",
    });
    const ids = {
      citingDecisionId: labelled.citingDecisionId,
      citationKey: keyOf(labelled),
    };
    const revision = await textRevisionSha256For(labelled.citingDecisionId);
    const adjudicated = {
      ...labelFor(labelled, POLARITY.POSITIVE),
      ...provenanceFor(
        CITATION_REVIEW_ORIGIN.AI_ADJUDICATED,
        "same-revision-adjudication",
        revision,
      ),
    };
    expect((await applyLabels([adjudicated])).rows).toEqual([
      { ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.APPLIED },
    ]);

    const annotation = {
      ...labelFor(labelled, POLARITY.NEUTRAL),
      ...provenanceFor(
        CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
        "same-revision-annotation",
        revision,
        LATER,
      ),
    };
    const planned = await planLabels([annotation]);
    expect(planned.rows).toEqual([
      {
        ...ids,
        index: 0,
        outcome: REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE,
      },
    ]);
    expect((await applyLabels([annotation])).rows).toEqual(planned.rows);
    expect(
      (
        await db.execute(sql`
          SELECT origin, polarity, text_revision_sha256
            FROM ${caseLawCitationReviews}
           WHERE citing_decision_id = ${labelled.citingDecisionId}::uuid
             AND citation_key = ${ids.citationKey}
        `)
      ).rows,
    ).toEqual([
      {
        origin: CITATION_REVIEW_ORIGIN.AI_ADJUDICATED,
        polarity: POLARITY.POSITIVE,
        text_revision_sha256: revision,
      },
    ]);
    expect(await readCitation(cited)).toMatchObject({
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
      polaritySource: REVIEW_POLARITY_SOURCE,
    });
  });

  test("the upsert's compare-and-set agrees with citationReviewMayReplace on every pair", async () => {
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1033/2026",
      cited: "sp. zn. 29 Cdo 1033/2015",
      rawHash: "eligible-review-matrix",
    });
    const textRevisionSha256 = await textRevisionSha256For(
      labelled.citingDecisionId,
    );
    const instants = [PRODUCED_AT, LATER];
    const standings = [
      { origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW, producedAt: null },
      ...AI_CITATION_REVIEW_ORIGINS.flatMap((origin) =>
        instants.map((producedAt) => ({ origin, producedAt })),
      ),
    ];
    const pairs = standings.flatMap((stored) =>
      standings.map((incoming) => ({ stored, incoming })),
    );
    const toStanding = ({
      origin,
      producedAt,
    }: (typeof standings)[number]): CitationReviewStanding =>
      origin === CITATION_REVIEW_ORIGIN.HUMAN_REVIEW
        ? { origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW }
        : { origin, producedAt: Temporal.Instant.from(producedAt) };
    const rows = (
      await db.execute(sql`
        SELECT ${reviewMayReplaceSql({ stored: "s", incoming: "i" })} AS may_replace
          FROM (VALUES ${sql.join(
            pairs.map(
              ({ stored, incoming }, ord) =>
                sql`(${ord}::int, ${stored.origin}::text, ${stored.producedAt}::timestamptz, ${incoming.origin}::text, ${incoming.producedAt}::timestamptz)`,
            ),
            sql`, `,
          )}) AS pair(ord, stored_origin, stored_at, incoming_origin, incoming_at)
         CROSS JOIN LATERAL (SELECT pair.stored_origin AS origin, pair.stored_at AS produced_at,
                                    ${labelled.citingDecisionId}::uuid AS citing_decision_id,
                                    ${textRevisionSha256}::text AS text_revision_sha256) s
         CROSS JOIN LATERAL (SELECT pair.incoming_origin AS origin, pair.incoming_at AS produced_at,
                                    ${labelled.citingDecisionId}::uuid AS citing_decision_id,
                                    ${textRevisionSha256}::text AS text_revision_sha256) i
         ORDER BY pair.ord
      `)
    ).rows;
    expect(rows).toEqual(
      pairs.map(({ stored, incoming }) => ({
        may_replace: citationReviewMayReplace({
          stored: toStanding(stored),
          incoming: toStanding(incoming),
        }),
      })),
    );
  });

  test("a run whose results cannot be written applies nothing", async () => {
    const cited = "sp. zn. 29 Cdo 1010/2015";
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1010/2026",
      cited,
      rawHash: "results-unwritable",
    });
    const reviewsBefore = await readReviews();
    const applied = await applyReviewedCitationLabels({
      transact: reviewedTransact,
      input: [labelFor(labelled, POLARITY.POSITIVE)],
      resultsPath: path.join(resultsDir, "missing", "results.jsonl"),
    });
    if (applied.isOk()) {
      throw new TypeError("a run whose results cannot be written must fail");
    }
    expect(applied.error.code).toBe(REVIEWED_LABEL_APPLY_FAILURE.NOT_APPLIED);
    expect(await readReviews()).toEqual(reviewsBefore);
    expect(await readCitation(cited)).toEqual(labelled);
    expect(
      (await readdir(resultsDir)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  // Last: it retires a shipped rule for the rest of the file.
  test("instants within one microsecond tie in one file and across runs alike", async () => {
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1017/2026",
      cited: "sp. zn. 29 Cdo 4017/2015",
      rawHash: "sub-microsecond",
    });
    const ids = {
      citingDecisionId: labelled.citingDecisionId,
      citationKey: keyOf(labelled),
    };
    // timestamptz keeps microseconds: these two are one stored instant.
    const textRevisionSha256 = await textRevisionSha256For(
      labelled.citingDecisionId,
    );
    const run = (
      polarity: typeof POLARITY.POSITIVE | typeof POLARITY.NEUTRAL,
      runId: string,
      producedAt: string,
    ) => ({
      ...labelFor(labelled, polarity),
      ...provenanceFor(
        CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
        runId,
        textRevisionSha256,
        producedAt,
      ),
    });
    const first = run(
      POLARITY.NEUTRAL,
      "run-a",
      "2026-10-07T10:00:00.000000100Z",
    );
    const second = run(
      POLARITY.POSITIVE,
      "run-b",
      "2026-10-07T10:00:00.000000200Z",
    );

    expect((await applyLabels([first, second])).rows).toEqual(
      [0, 1].map((index) => ({
        ...ids,
        index,
        outcome: REVIEWED_LABEL_OUTCOME.INVALID,
        reason: REVIEWED_LABEL_INVALID_REASON.DUPLICATE,
      })),
    );
    expect((await applyLabels([first])).rows).toEqual([
      { ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.APPLIED },
    ]);
    expect((await applyLabels([second])).rows).toEqual([
      { ...ids, index: 0, outcome: REVIEWED_LABEL_OUTCOME.REFUSED_PRECEDENCE },
    ]);
  });

  test("a production instant with any offset is stored as the same UTC instant", async () => {
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1016/2026",
      cited: "sp. zn. 29 Cdo 4016/2015",
      rawHash: "offset",
    });
    // +16:00 is a real offset the database's timestamptz input refuses.
    const producedAt = "2026-10-07T08:00:00+16:00";
    const entry = {
      ...labelFor(labelled, POLARITY.NEUTRAL),
      ...provenanceFor(
        CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
        "run-offset",
        await textRevisionSha256For(labelled.citingDecisionId),
        producedAt,
      ),
    };
    expect((await applyLabels([entry])).rows).toEqual([
      {
        index: 0,
        citingDecisionId: labelled.citingDecisionId,
        citationKey: keyOf(labelled),
        outcome: REVIEWED_LABEL_OUTCOME.APPLIED,
      },
    ]);
    const stored = await db.execute(sql`
      SELECT extract(epoch FROM produced_at)::bigint::text AS epoch
        FROM ${caseLawCitationReviews}
       WHERE citing_decision_id = ${labelled.citingDecisionId}::uuid
    `);
    expect(stored.rows).toEqual([
      {
        epoch: String(
          Temporal.Instant.from(producedAt).epochMilliseconds / 1000,
        ),
      },
    ]);
  });

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
    await applyLabels([labelFor(reviewed, POLARITY.NEUTRAL)]);

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
