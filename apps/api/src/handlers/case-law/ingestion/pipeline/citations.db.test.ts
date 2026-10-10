import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
  caseLawSources,
} from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import {
  citationContent,
  writeDecisionCitations,
} from "@/api/handlers/case-law/ingestion/pipeline/citations";
import type { CitationPlan } from "@/api/handlers/case-law/ingestion/pipeline/citations";
import {
  POLARITY,
  POLARITY_RULE_KIND,
  RULE_SOURCE,
} from "@/api/handlers/case-law/polarity/consts";
import {
  applyFormRepairs,
  planFormRepair,
  previewFormRepairs,
} from "@/api/handlers/case-law/polarity/form-repair";
import { compileRules } from "@/api/handlers/case-law/polarity/rule-engine";
import { createSafeId } from "@/api/lib/branded-types";
import { CITED_PART } from "@/api/lib/case-law/citation-vocabulary";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const decisionId = createSafeId<"caseLawDecision">();
const ruleId = createSafeId<"caseLawPolarityRule">();
const confidence = 0.923456789;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "confidence-fixture",
    name: "Synthetic source",
  });
  await db.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId,
    caseNumber: "synthetic",
    country: "CZE",
    court: "Synthetic court",
    language: "en",
  });
  await db.insert(caseLawPolarityRules).values({
    id: ruleId,
    pattern: "synthetic",
    language: "en",
    kind: POLARITY_RULE_KIND.STANCE,
    polarity: POLARITY.POSITIVE,
    source: RULE_SOURCE.MANUAL,
    confidence,
  });
}, 120_000);

afterAll(async () => {
  await client.close();
});

const headers = async () =>
  (
    await db.execute(sql`
  SELECT id::text AS id, xmin::text AS xmin, xmax::text AS xmax
    FROM ${caseLawCitations}
   WHERE citing_decision_id = ${decisionId}::uuid
   ORDER BY id
`)
  ).rows;

test("refreshing the same confidence keeps the citation row without a write", async () => {
  expect(Math.fround(confidence)).not.toBe(confidence);
  const citations = {
    disposition: "legacy-graph",
    citingDecisionId: decisionId,
    references: [
      {
        reference: {
          index: 0,
          printed: "Synthetic authority",
          citationKey: null,
          identifiers: [
            {
              type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
              normalizedValue: "synthetic authority",
            },
          ],
          kind: CITATION_KIND.PRECEDENT,
          hints: {
            court: null,
            decisionType: null,
            sheetNumber: null,
            decisionDate: null,
          },
          sectionIndex: 0,
          polarityMentions: null,
        },
        verdict: { polarity: POLARITY.POSITIVE, ruleId, confidence },
        windows: null,
        citedPart: CITED_PART.NOT_STATED,
      },
    ],
  } as const satisfies CitationPlan;
  const write = async (stored: boolean) =>
    await runCitationGraphTransaction(
      db.transaction.bind(db),
      async (tx) =>
        await writeDecisionCitations(asTestRaw(tx), {
          decisionId,
          citations,
          stored,
          observedAt: new Date("2026-10-01T00:00:00Z"),
        }),
    );
  await write(false);
  const first = await headers();
  expect(first).toHaveLength(1);
  const stored = await db
    .select({ confidence: caseLawCitations.polarityConfidence })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.citingDecisionId, decisionId));
  expect(stored.at(0)?.confidence).toBe(confidence);
  await write(true);
  expect(await headers()).toEqual(first);
  await write(true);
  expect(await headers()).toEqual(first);
});

test("citation comparison keys are stable across numeric write-read round trips", async () => {
  await assertProperty(
    "citation comparison keys are stable across numeric write-read round trips",
    fc.asyncProperty(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 1, max: 1000 }),
      async (polarityConfidence, sectionIndex, start, width) => {
        const incoming = {
          id: createSafeId<"caseLawCitation">(),
          citingDecisionId: decisionId,
          citationText: "Synthetic numeric authority",
          sectionIndex,
          polarityWindowStart: start,
          polarityWindowEnd: start + width,
          polarityConfidence,
        };
        const [stored] = await db
          .insert(caseLawCitations)
          .values(incoming)
          .returning();
        if (stored === undefined) {
          throw new TypeError("Expected the persisted citation");
        }
        expect(stored.polarityConfidence).toBe(
          polarityConfidence === 0 ? 0 : polarityConfidence,
        );
        expect(citationContent(stored)).toBe(citationContent(incoming));
      },
    ),
  );
});

test("empty polarity windows violate the persisted window constraint", async () => {
  expect(
    await rejectionOf(
      client.query(
        `INSERT INTO case_law_citations
          (id, citing_decision_id, citation_text, polarity_window_start, polarity_window_end)
         VALUES ($1, $2, $3, $4, $4)`,
        [createSafeId<"caseLawCitation">(), decisionId, "Empty evidence", 10],
      ),
    ),
  ).toMatchObject({
    code: "23514",
    constraint: "citations_polarity_window_bounds",
  });
});

test("refreshing a repaired citation preserves its confidence and row identity", async () => {
  expect(Math.fround(confidence)).not.toBe(confidence);
  const repairedDecisionId = createSafeId<"caseLawDecision">();
  const formRuleId = createSafeId<"caseLawPolarityRule">();
  const sourceId = createSafeId<"caseLawSource">();
  const citationText = "A 12/2020";
  const sections = [
    {
      index: 0,
      type: "argumentation",
      title: null,
      text: `compare ${citationText}`,
    },
  ] satisfies DecisionSection[];
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "repair-confidence-fixture",
    name: "Synthetic repair source",
  });
  await db.insert(caseLawDecisions).values({
    id: repairedDecisionId,
    sourceId,
    caseNumber: "synthetic repair",
    country: "CZE",
    court: "Synthetic court",
    language: "en",
    sections,
  });
  await db.insert(caseLawPolarityRules).values({
    id: formRuleId,
    pattern: "compare",
    language: "en",
    kind: POLARITY_RULE_KIND.FORM,
    polarity: POLARITY.NEUTRAL,
    source: RULE_SOURCE.MANUAL,
    confidence,
  });
  const rules = compileRules([
    {
      id: formRuleId,
      pattern: "compare",
      kind: POLARITY_RULE_KIND.FORM,
      polarity: POLARITY.NEUTRAL,
      confidence,
    },
  ]);
  const citationId = createSafeId<"caseLawCitation">();
  const planned = planFormRepair(
    {
      id: citationId,
      citingDecisionId: repairedDecisionId,
      jurisdiction: "CZE",
      polarity: POLARITY.SUPPORTIVE,
      ruleId: formRuleId,
      citationText,
      sectionIndex: 0,
      sections,
    },
    rules,
  );
  expect(planned.status).toBe("repair");
  if (planned.status !== "repair") {
    throw new TypeError("Expected a repairable form-derived citation");
  }
  const citations = {
    disposition: "legacy-graph",
    citingDecisionId: repairedDecisionId,
    references: [
      {
        reference: {
          index: 0,
          printed: citationText,
          citationKey: null,
          identifiers: [
            {
              type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
              normalizedValue: "a 12/2020",
            },
          ],
          kind: CITATION_KIND.PRECEDENT,
          hints: {
            court: null,
            decisionType: null,
            sheetNumber: null,
            decisionDate: null,
          },
          sectionIndex: 0,
          polarityMentions: null,
        },
        verdict: {
          polarity: POLARITY.NEUTRAL,
          ruleId: formRuleId,
          confidence: planned.confidence,
        },
        windows: planned.windows,
        citedPart: CITED_PART.NOT_STATED,
      },
    ],
  } as const satisfies CitationPlan;
  await runCitationGraphTransaction(
    db.transaction.bind(db),
    async (tx) =>
      await writeDecisionCitations(asTestRaw(tx), {
        decisionId: repairedDecisionId,
        citations,
        stored: false,
        observedAt: new Date("2026-10-01T00:00:00Z"),
      }),
  );
  await db
    .update(caseLawCitations)
    .set({ polarity: POLARITY.SUPPORTIVE })
    .where(eq(caseLawCitations.citingDecisionId, repairedDecisionId));
  const scopedDb: ScopedDb = async (run) =>
    await db.transaction(async (tx) => await run(asTestRaw(tx)));
  const plan = await previewFormRepairs({
    scopedDb,
    language: "en",
    rules,
    after: null,
    limit: 100,
  });
  expect(plan.rows).toHaveLength(1);
  expect(await applyFormRepairs({ scopedDb, plan, rules })).toEqual({
    applied: 1,
    skipped: 0,
  });
  const read = async () =>
    await db
      .select({
        id: caseLawCitations.id,
        confidence: caseLawCitations.polarityConfidence,
        polarity: caseLawCitations.polarity,
      })
      .from(caseLawCitations)
      .where(eq(caseLawCitations.citingDecisionId, repairedDecisionId));
  const rowHeaders = async () =>
    (
      await db.execute(sql`
        SELECT id::text AS id, xmin::text AS xmin, xmax::text AS xmax
          FROM ${caseLawCitations}
         WHERE citing_decision_id = ${repairedDecisionId}::uuid
      `)
    ).rows;
  const repaired = await read();
  const repairedHeaders = await rowHeaders();
  expect(repaired).toHaveLength(1);
  expect(repaired.at(0)?.confidence).toBe(confidence);
  expect(repaired.at(0)?.polarity).toBe(POLARITY.NEUTRAL);
  await runCitationGraphTransaction(
    db.transaction.bind(db),
    async (tx) =>
      await writeDecisionCitations(asTestRaw(tx), {
        decisionId: repairedDecisionId,
        citations,
        stored: true,
        observedAt: new Date("2026-10-01T00:00:00Z"),
      }),
  );
  expect(await read()).toEqual(repaired);
  expect(await rowHeaders()).toEqual(repairedHeaders);
});
