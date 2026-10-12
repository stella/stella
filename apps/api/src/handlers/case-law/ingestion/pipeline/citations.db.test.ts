import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { compareCodeUnit } from "@stll/collation";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
  caseLawSources,
  systemAuditRuns,
} from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import {
  citationContent,
  planDecisionCitations,
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
import { parseCitationEvidenceWindows } from "@/api/lib/case-law/citation-evidence";
import { CITED_PART } from "@/api/lib/case-law/citation-vocabulary";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let fixtureScopedDb: ScopedDb;
const decisionId = createSafeId<"caseLawDecision">();
const ruleId = createSafeId<"caseLawPolarityRule">();
const confidence = 0.923456789;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  fixtureScopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
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
          polarityWindows: null,
        },
        verdict: { polarity: POLARITY.POSITIVE, ruleId, confidence },
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

test("citation comparison keys are stable across evidence-window write-read round trips", async () => {
  await assertProperty(
    "citation comparison keys are stable across evidence-window write-read round trips",
    fc.asyncProperty(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      fc.integer({ min: 0, max: 1000 }),
      fc.array(
        fc.record({
          start: fc.integer({ min: 0, max: 1_000_000 }),
          width: fc.integer({ min: 1, max: 1000 }),
        }),
        { minLength: 1, maxLength: 4 },
      ),
      async (polarityConfidence, sectionIndex, evidenceWindows) => {
        const incoming = {
          id: createSafeId<"caseLawCitation">(),
          citingDecisionId: decisionId,
          citationText: "Synthetic numeric authority",
          sectionIndex,
          polarityEvidenceWindows: parseCitationEvidenceWindows(
            evidenceWindows.map(({ start, width }) => ({
              start,
              end: start + width,
            })),
          ),
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

test("empty polarity evidence windows violate the persisted window constraint", async () => {
  expect(
    await rejectionOf(
      client.query(
        `INSERT INTO case_law_citations
          (id, citing_decision_id, citation_text, polarity_evidence_windows)
         VALUES ($1, $2, $3, '[]'::jsonb)`,
        [createSafeId<"caseLawCitation">(), decisionId, "Empty evidence"],
      ),
    ),
  ).toMatchObject({
    code: "23514",
    constraint: "citations_polarity_window_bounds",
  });
});

test("mixed cross-section treatment stores both exact classifier windows", async () => {
  const citingDecisionId = createSafeId<"caseLawDecision">();
  const sourceId = createSafeId<"caseLawSource">();
  const positiveRuleId = createSafeId<"caseLawPolarityRule">();
  const negativeRuleId = createSafeId<"caseLawPolarityRule">();
  const citationText = "23 Cdo 555/2024";
  const gapMarker = "INTERVENING TEXT OMITTED FROM EACH WINDOW";
  const padding = "unrelated reasons. ".repeat(30);
  const gap = `${padding}${gapMarker}${padding}`;
  expect(padding.length).toBeGreaterThan(400);
  expect(gap.length).toBeGreaterThan(400);
  const sections = [
    {
      index: 0,
      text: `The court relies on windowdbsupports authority ${citationText}.`,
    },
    {
      index: 1,
      text: `${gap}The court rejects with windowdbrejects ${citationText}.`,
    },
  ];
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `evidence-windows-${citingDecisionId}`,
    name: "Evidence window fixture",
  });
  await db.insert(caseLawDecisions).values({
    id: citingDecisionId,
    sourceId,
    caseNumber: `evidence-${citingDecisionId}`,
    country: "CZE",
    court: "Synthetic court",
    language: "en",
  });
  await db.insert(caseLawPolarityRules).values([
    {
      id: positiveRuleId,
      pattern: "windowdbsupports",
      language: "en",
      kind: POLARITY_RULE_KIND.STANCE,
      polarity: POLARITY.POSITIVE,
      source: RULE_SOURCE.MANUAL,
      confidence: 0.9,
    },
    {
      id: negativeRuleId,
      pattern: "windowdbrejects",
      language: "en",
      kind: POLARITY_RULE_KIND.STANCE,
      polarity: POLARITY.NEGATIVE,
      source: RULE_SOURCE.MANUAL,
      confidence: 0.9,
    },
  ]);

  const planned = await planDecisionCitations({
    citations: [
      {
        citationText,
        sectionIndex: null,
        citedDecisionTypeHint: null,
        identifierType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        identifierValue: citationText,
        citedCourtHint: null,
        citedSheetNumber: null,
        citedDecisionDate: null,
      },
    ],
    citingDecisionId,
    language: "en",
    polarityRules: undefined,
    proceduralKeys: new Set(),
    scopedDb: fixtureScopedDb,
    sections,
  });
  const citationPlan = planned.unwrap();
  if (citationPlan.disposition !== "legacy-graph") {
    panic("Expected a citation reference");
  }
  const [reference] = citationPlan.references;
  if (reference === undefined) {
    panic("Expected one citation reference");
  }

  await runCitationGraphTransaction(
    db.transaction.bind(db),
    async (tx) =>
      await writeDecisionCitations(asTestRaw(tx), {
        decisionId: citingDecisionId,
        citations: citationPlan,
        observedAt: new Date("2026-10-01T00:00:00Z"),
        stored: false,
      }),
  );
  const row = await db
    .select({
      polarity: caseLawCitations.polarity,
      windows: caseLawCitations.polarityEvidenceWindows,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.citingDecisionId, citingDecisionId))
    .then((rows) => rows.at(0));
  if (row === undefined) {
    panic("Expected the written citation");
  }
  const joined = sections.map(({ text }) => text).join("\n");
  const excerpts = (row.windows ?? []).map(({ start, end }) =>
    joined.slice(start, end),
  );

  expect(row.polarity).toBe(POLARITY.MIXED);
  expect(excerpts).toHaveLength(2);
  expect(excerpts[0]).toContain("windowdbsupports");
  expect(excerpts[1]).toContain("windowdbrejects");
  expect(excerpts.every((excerpt) => !excerpt.includes(gapMarker))).toBe(true);
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
      contentHash: null,
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
          polarityWindows: planned.windows,
        },
        verdict: {
          polarity: POLARITY.NEUTRAL,
          ruleId: formRuleId,
          confidence: planned.confidence,
        },
        citedPart: CITED_PART.NOT_STATED,
      },
    ],
  } as const satisfies CitationPlan;
  await runCitationGraphTransaction(db.transaction.bind(db), async (tx) => {
    await writeDecisionCitations(asTestRaw(tx), {
      decisionId: repairedDecisionId,
      citations,
      stored: false,
      observedAt: new Date("2026-10-01T00:00:00Z"),
    });
  });
  await db
    .update(caseLawCitations)
    .set({ polarity: POLARITY.SUPPORTIVE })
    .where(eq(caseLawCitations.citingDecisionId, repairedDecisionId));
  const queries: string[] = [];
  const repairDb = drizzle({
    client,
    logger: {
      logQuery: (query) => {
        queries.push(query);
      },
    },
  });
  const transaction = asTestRaw<CaseLawRootHandle["transaction"]>(
    repairDb.transaction.bind(repairDb),
  );
  const scopedDb: ScopedDb = async (run) =>
    await repairDb.transaction(async (tx) => await run(asTestRaw(tx)));
  const staleDecisionId = createSafeId<"caseLawDecision">();
  const staleCitationId = createSafeId<"caseLawCitation">();
  await db.insert(caseLawDecisions).values({
    id: staleDecisionId,
    sourceId,
    caseNumber: "synthetic stale repair",
    country: "CZE",
    court: "Synthetic court",
    language: "en",
    sections,
  });
  await db.insert(caseLawCitations).values({
    id: staleCitationId,
    citingDecisionId: staleDecisionId,
    citationText,
    sectionIndex: 0,
    polarity: POLARITY.SUPPORTIVE,
    polarityRuleId: formRuleId,
  });
  const writeTargets = () =>
    queries.flatMap((query) => {
      // Fail closed for SQL outside the statements this operation issues.
      expect(query).toMatch(
        /^\s*(?:begin|commit|select|with|insert\s+into|update|delete\s+from)\b/iu,
      );
      return Array.from(
        query.matchAll(
          /\b(?:insert\s+into|update|delete\s+from)\s+(?:"?\w+"?\.)?"?(\w+)"?/giu,
        ),
        (match) => match[1] ?? panic("Citation repair write has no table name"),
      );
    });
  const audits = async () =>
    await db
      .select({ actor: systemAuditRuns.actor, counts: systemAuditRuns.counts })
      .from(systemAuditRuns)
      .where(eq(systemAuditRuns.actor, "system:case-law-citation-form-repair"))
      .orderBy(systemAuditRuns.id);
  const auditBefore = await audits();
  queries.length = 0;
  const plan = await previewFormRepairs({
    scopedDb,
    language: "en",
    rules,
    after: null,
    limit: 100,
  });
  expect(plan.rows).toHaveLength(2);
  expect(writeTargets()).toEqual([]);
  expect(await audits()).toEqual(auditBefore);
  await db
    .update(caseLawCitations)
    .set({ polarity: POLARITY.NEGATIVE })
    .where(eq(caseLawCitations.id, staleCitationId));
  queries.length = 0;
  expect(await applyFormRepairs({ transaction, plan, rules })).toEqual({
    applied: 1,
    skipped: 1,
  });
  expect(writeTargets().toSorted(compareCodeUnit)).toEqual([
    "case_law_citations",
    "system_audit_runs",
  ]);
  expect(await audits()).toEqual([
    ...auditBefore,
    {
      actor: "system:case-law-citation-form-repair",
      counts: { attempted: 2, applied: 1, skipped: 1 },
    },
  ]);
  queries.length = 0;
  expect(await applyFormRepairs({ transaction, plan, rules })).toEqual({
    applied: 0,
    skipped: 2,
  });
  expect(writeTargets()).toEqual(["system_audit_runs"]);
  const auditAfterReplay = await audits();
  expect(auditAfterReplay).toHaveLength(auditBefore.length + 2);
  expect(auditAfterReplay.at(-1)).toEqual({
    actor: "system:case-law-citation-form-repair",
    counts: { attempted: 2, applied: 0, skipped: 2 },
  });
  queries.length = 0;
  expect(
    await applyFormRepairs({ transaction, plan: { ...plan, rows: [] }, rules }),
  ).toEqual({ applied: 0, skipped: 0 });
  expect(writeTargets()).toEqual([]);
  expect(await audits()).toEqual(auditAfterReplay);
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
  await runCitationGraphTransaction(db.transaction.bind(db), async (tx) => {
    await writeDecisionCitations(asTestRaw(tx), {
      decisionId: repairedDecisionId,
      citations,
      stored: true,
      observedAt: new Date("2026-10-01T00:00:00Z"),
    });
  });
  expect(await read()).toEqual(repaired);
  expect(await rowHeaders()).toEqual(repairedHeaders);
});

test("a form repair skips a citation when its decision text changes before writing", async () => {
  const citingDecisionId = createSafeId<"caseLawDecision">();
  const sourceId = createSafeId<"caseLawSource">();
  const formRuleId = createSafeId<"caseLawPolarityRule">();
  const citationId = createSafeId<"caseLawCitation">();
  const sections = [
    {
      index: 0,
      type: "argumentation",
      title: null,
      text: "consider A 88/2020",
    },
  ] satisfies DecisionSection[];
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "form-repair-text-revision",
    name: "Synthetic source",
  });
  await db.insert(caseLawDecisions).values({
    id: citingDecisionId,
    sourceId,
    caseNumber: "synthetic text revision",
    country: "CZE",
    court: "Synthetic court",
    language: "en",
    sections,
  });
  await db.insert(caseLawPolarityRules).values({
    id: formRuleId,
    pattern: "consider",
    language: "en",
    kind: POLARITY_RULE_KIND.FORM,
    polarity: POLARITY.NEUTRAL,
    source: RULE_SOURCE.MANUAL,
    confidence,
  });
  await db.insert(caseLawCitations).values({
    id: citationId,
    citingDecisionId,
    citationText: "A 88/2020",
    sectionIndex: 0,
    polarity: POLARITY.SUPPORTIVE,
    polarityRuleId: formRuleId,
  });
  const rules = compileRules([
    {
      id: formRuleId,
      pattern: "consider",
      kind: POLARITY_RULE_KIND.FORM,
      polarity: POLARITY.NEUTRAL,
      confidence,
    },
  ]);
  const scopedDb: ScopedDb = async (run) =>
    await db.transaction(async (tx) => await run(asTestRaw(tx)));
  const preview = await previewFormRepairs({
    scopedDb,
    language: "en",
    rules,
    after: null,
    limit: 1000,
  });
  const plan = {
    ...preview,
    rows: preview.rows.filter(({ id }) => id === citationId),
  };
  expect(plan.rows.some(({ id }) => id === citationId)).toBe(true);
  const read = async () =>
    (
      await db.execute(
        sql`SELECT *, xmin::text AS xmin, xmax::text AS xmax FROM ${caseLawCitations} WHERE id = ${citationId}::uuid`,
      )
    ).rows;
  const before = await read();
  let changed = false;
  const transaction: CaseLawRootHandle["transaction"] = async (run) =>
    await db.transaction(async (tx) => {
      const changingTx = new Proxy(tx, {
        get: (target, property, receiver) => {
          if (property !== "execute") {
            return Reflect.get(target, property, receiver);
          }
          return async (...args: Parameters<typeof tx.execute>) => {
            if (!changed) {
              changed = true;
              await tx
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
                .where(eq(caseLawDecisions.id, citingDecisionId));
            }
            return await tx.execute(...args);
          };
        },
      });
      return await run(asTestRaw(changingTx));
    });
  expect(await applyFormRepairs({ transaction, plan, rules })).toEqual({
    applied: 0,
    skipped: plan.rows.length,
  });
  expect(changed).toBe(true);
  expect(await read()).toEqual(before);
});

test("a form repair skips a citation when the selected rule confidence changes after preview", async () => {
  const citingDecisionId = createSafeId<"caseLawDecision">();
  const sourceId = createSafeId<"caseLawSource">();
  const formRuleId = createSafeId<"caseLawPolarityRule">();
  const citationId = createSafeId<"caseLawCitation">();
  const pattern = "formconfidencecue";
  const sections = [
    {
      index: 0,
      type: "argumentation",
      title: null,
      text: `${pattern} A 88/2020`,
    },
  ] satisfies DecisionSection[];
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "form-repair-confidence-revision",
    name: "Synthetic source",
  });
  await db.insert(caseLawDecisions).values({
    id: citingDecisionId,
    sourceId,
    caseNumber: "synthetic confidence revision",
    country: "CZE",
    court: "Synthetic court",
    language: "en",
    sections,
  });
  await db.insert(caseLawPolarityRules).values({
    id: formRuleId,
    pattern,
    language: "en",
    kind: POLARITY_RULE_KIND.FORM,
    polarity: POLARITY.NEUTRAL,
    source: RULE_SOURCE.MANUAL,
    confidence,
  });
  await db.insert(caseLawCitations).values({
    id: citationId,
    citingDecisionId,
    citationText: "A 88/2020",
    sectionIndex: 0,
    polarity: POLARITY.SUPPORTIVE,
    polarityRuleId: formRuleId,
  });
  const rules = compileRules([
    {
      id: formRuleId,
      pattern,
      kind: POLARITY_RULE_KIND.FORM,
      polarity: POLARITY.NEUTRAL,
      confidence,
    },
  ]);
  const scopedDb: ScopedDb = async (run) =>
    await db.transaction(async (tx) => await run(asTestRaw(tx)));
  const preview = await previewFormRepairs({
    scopedDb,
    language: "en",
    rules,
    after: null,
    limit: 1000,
  });
  const plan = {
    ...preview,
    rows: preview.rows.filter(({ id }) => id === citationId),
  };
  expect(plan.rows).toHaveLength(1);
  const read = async () =>
    (
      await db.execute(
        sql`SELECT *, xmin::text AS xmin, xmax::text AS xmax FROM ${caseLawCitations} WHERE id = ${citationId}::uuid`,
      )
    ).rows;
  const before = await read();
  const changedConfidence = 0.812345678;
  await db
    .update(caseLawPolarityRules)
    .set({ confidence: changedConfidence })
    .where(eq(caseLawPolarityRules.id, formRuleId));

  const transaction: CaseLawRootHandle["transaction"] = async (run) =>
    await db.transaction(async (tx) => await run(asTestRaw(tx)));
  expect(await applyFormRepairs({ transaction, plan, rules })).toEqual({
    applied: 0,
    skipped: 1,
  });
  expect(await read()).toEqual(before);
  const [storedRule] = await db
    .select({ confidence: caseLawPolarityRules.confidence })
    .from(caseLawPolarityRules)
    .where(eq(caseLawPolarityRules.id, formRuleId));
  expect(storedRule?.confidence).toBe(changedConfidence);
});
