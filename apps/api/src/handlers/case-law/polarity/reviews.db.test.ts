/**
 * A reviewed citation label against every writer of citation polarity: the
 * ingestion refresh, the recheck walk, the classifier's write, rule
 * retirement, and the script that stores the review.
 *
 * Each citing sentence here is one the shipped Czech rules read as negative,
 * so every fixture is asserted to carry a rule's verdict before a review or a
 * pass is applied to it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
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
import {
  DECISION_REFRESH,
  PROCESS_DECISION_STATUS,
  processDecision,
} from "@/api/handlers/case-law/ingestion/pipeline";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline";
import { persistPolarity } from "@/api/handlers/case-law/polarity/classifier";
import { POLARITY, RULE_SOURCE } from "@/api/handlers/case-law/polarity/consts";
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
import {
  reviewedCitationLabelsFileSchema,
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
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
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
};

const ingest = async ({ caseNumber, cited, rawHash }: IngestOptions) => {
  observationOrder += 1n;
  const text = departureFrom(cited);
  const input: IngestionResult = {
    caseNumber,
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionType: "rozsudek",
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash,
    fulltext: text,
    sections: [{ index: 0, type: "argumentation", title: null, text }],
    documentAst: EMPTY_AST,
  };
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

const labelFor = (
  row: LabelledRow,
  polarity: ReviewedCitationLabelEntry["polarity"],
): ReviewedCitationLabelEntry => ({
  citingDecisionId: row.citingDecisionId,
  citationKey: row.citationKey ?? "",
  polarity,
  reviewRef: `review-${row.citingDecisionId}`,
});

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

describe("reviewed citation labels", () => {
  test("a review moves a label off negative, is idempotent, and survives a refresh", async () => {
    const cited = "sp. zn. 23 Cdo 5068/2014";
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1001/2026",
      cited,
      rawHash: "first-sight",
    });
    const entries = [labelFor(labelled, POLARITY.POSITIVE)];

    const planned = await runReviewedCitationLabels(db, entries, "plan");
    expect(planned).toEqual({
      type: "planned",
      summary: {
        insert: 1,
        update: 0,
        unchanged: 0,
        citationRows: 1,
        unmatched: 0,
      },
    });
    expect(await readReviews()).toEqual([]);
    expect(await readCitation(cited)).toEqual(labelled);

    const applied = await runReviewedCitationLabels(db, entries, "apply");
    expect(applied).toMatchObject({ type: "applied", relabelled: 1 });
    expect(await readCitation(cited)).toMatchObject({
      id: labelled.id,
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
    });
    const stored = await readReviews();
    expect(stored).toHaveLength(1);

    const reapplied = await runReviewedCitationLabels(db, entries, "apply");
    expect(reapplied).toEqual({
      type: "applied",
      summary: {
        insert: 0,
        update: 0,
        unchanged: 1,
        citationRows: 0,
        unmatched: 0,
      },
      relabelled: 0,
    });
    expect(await readReviews()).toEqual(stored);

    const ruleId = labelled.polarityRuleId;
    if (ruleId === null) {
      throw new TypeError("the fixture row carries a rule's verdict");
    }
    const before = await readRule(ruleId);
    await ingest({
      caseNumber: "30 Cdo 1001/2026",
      cited,
      rawHash: "after-the-publisher-touched-it",
    });
    const refreshed = await readCitation(cited);
    // A new row: the refresh deleted and re-inserted the decision's citations.
    expect(refreshed.id).not.toBe(labelled.id);
    expect(refreshed).toMatchObject({
      polarity: POLARITY.POSITIVE,
      polarityRuleId: null,
    });
    // The rule matched the re-inserted row and did not label it.
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
      db,
      [
        {
          citationId: reviewed.id,
          polarity: POLARITY.POSITIVE,
          reviewRef: "review-by-citation-id",
        },
      ],
      "apply",
    );
    expect(applied).toMatchObject({
      type: "applied",
      summary: { insert: 1 },
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

  test("a file with an invalid entry is refused whole", async () => {
    const cited = "sp. zn. 29 Cdo 4004/2015";
    const labelled = await ingestRuleLabelled({
      caseNumber: "30 Cdo 1004/2026",
      cited,
      rawHash: "refused",
    });
    const valid = labelFor(labelled, POLARITY.NEUTRAL);

    for (const polarity of [POLARITY.UNKNOWN, "overruled"]) {
      expect(
        v.safeParse(reviewedCitationLabelsFileSchema, [{ ...valid, polarity }])
          .success,
      ).toBe(false);
    }
    expect(
      v.safeParse(reviewedCitationLabelsFileSchema, [{ ...valid, extra: 1 }])
        .success,
    ).toBe(false);

    for (const entries of [
      [valid, valid],
      [
        valid,
        {
          citationId: createSafeId<"caseLawCitation">(),
          polarity: POLARITY.NEUTRAL,
          reviewRef: "review-of-nothing",
        },
      ],
      [
        valid,
        {
          citingDecisionId: createSafeId<"caseLawDecision">(),
          citationKey: "no-such-decision",
          polarity: POLARITY.NEUTRAL,
          reviewRef: "review-of-nothing",
        },
      ],
    ]) {
      const outcome = await runReviewedCitationLabels(db, entries, "apply");
      expect(outcome.type).toBe("rejected");
    }
    expect(await readCitation(cited)).toEqual(labelled);
    expect(
      (await readReviews()).filter(
        (review) => review.citingDecisionId === labelled.citingDecisionId,
      ),
    ).toEqual([]);
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
      db,
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
