/**
 * Polarity is written when the citation row is published, and a refresh
 * re-derives it.
 *
 * A refresh rewrites every citation row that no longer reads what the
 * document and the rules say, so a label written after the insert — by the
 * background classifier, whenever it next comes round — lives only until the
 * next refresh that disagrees with it. Classifying in the pipeline makes that
 * rewrite a recomputation rather than a blanking, which is what the second
 * half of the test below asserts; a refresh that agrees rewrites nothing.
 *
 * The rules come from `SEED_RULES`, not from patterns invented here: the
 * assertion is about what the shipped rule set says about a Czech sentence.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawPolarityRules,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { RULE_SOURCE } from "@/api/handlers/case-law/polarity/consts";
import { loadRules } from "@/api/handlers/case-law/polarity/rule-engine";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * "srov." — compare — exists only to point at precedent, which is why the
 * seed set labels it. The expected polarity is read off the rule rather than
 * written out, so re-labelling the rule moves the assertion with it.
 */
const SROV_PATTERN = "srov\\.";

/** Invoked authority: the cue and the citation share a sentence. */
const PRECEDENT_SECTION =
  "K výkladu § 1765 občanského zákoníku srov. rozsudek Nejvyššího soudu " +
  "ze dne 3. 2. 2020, sp. zn. 21 Cdo 1234/2020, z něhož soud vycházel.";

/**
 * The case's own history. The sentence carries a phrase the seed set labels
 * `neutral`, so a row that came back labelled would be one whose kind gate
 * did not hold.
 */
const PROCEDURAL_SECTION =
  "Žalovaný podal dovolání proti rozsudku odvolacího soudu, sp. zn. " +
  "5 As 999/2021, jímž bylo rozhodnuto o odvolání.";

const CITED_PRECEDENT = "sp. zn. 21 Cdo 1234/2020";
const CITED_LOWER_COURT = "sp. zn. 5 As 999/2021";

const connect = (pglite: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({
    client: pglite,
    relations: { ...relations, ...authRelationsPart },
  });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;
let srovRule: { id: SafeId<"caseLawPolarityRule">; polarity: string };
let sourceId: SafeId<"caseLawSource">;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the pipeline expects.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

/** Postgres holds the payload; no object store takes part in this test. */
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

const decision = (rawHash: string): IngestionResult => ({
  caseNumber: "30 Cdo 4444/2026",
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  decisionType: "rozsudek",
  metadata: {},
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  rawHash,
  fulltext: `${PRECEDENT_SECTION}\n\n${PROCEDURAL_SECTION}`,
  sections: [
    { index: 0, type: "argumentation", title: null, text: PRECEDENT_SECTION },
    { index: 1, type: "argumentation", title: null, text: PROCEDURAL_SECTION },
  ],
  documentAst: EMPTY_AST,
});

const readCitations = async () =>
  await db
    .select({
      id: caseLawCitations.id,
      citationText: caseLawCitations.citationText,
      kind: caseLawCitations.kind,
      polarity: caseLawCitations.polarity,
      polarityRuleId: caseLawCitations.polarityRuleId,
    })
    .from(caseLawCitations)
    .orderBy(asc(caseLawCitations.citationText));

/**
 * Every citation tuple's header. `xmax` is where an update, a delete or a row
 * lock lands, so an unchanged pair is a row nobody touched.
 */
const citationTupleHeaders = async (): Promise<unknown> =>
  await db.execute(sql`
    SELECT id::text AS id, xmin::text AS xmin, xmax::text AS xmax
      FROM case_law_citations
     ORDER BY id
  `);

/** The seeded `srov.` rule as it stands now: its source and its counter. */
const readRule = async () =>
  (
    await db
      .select({
        source: caseLawPolarityRules.source,
        matchCount: caseLawPolarityRules.matchCount,
      })
      .from(caseLawPolarityRules)
      .where(eq(caseLawPolarityRules.pattern, SROV_PATTERN))
  ).at(0);

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
  sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `polarity-at-publish-${sourceId}`,
    name: "polarity at publish fixture",
  });
  await db.insert(caseLawPolarityRules).values(
    SEED_RULES.filter((seed) => seed.language === "cs").map((seed) => ({
      pattern: seed.pattern,
      polarity: seed.polarity,
      language: seed.language,
      source: RULE_SOURCE.MANUAL,
    })),
  );
  const stored = await db
    .select({
      id: caseLawPolarityRules.id,
      polarity: caseLawPolarityRules.polarity,
    })
    .from(caseLawPolarityRules)
    .where(eq(caseLawPolarityRules.pattern, SROV_PATTERN));
  const rule = stored.at(0);
  if (!rule) {
    throw new TypeError("expected the seeded Czech `srov.` rule to be stored");
  }
  srovRule = rule;
}, 120_000);

afterAll(async () => {
  await client.close();
});

test("a refreshed decision's citations keep the polarity the rules give", async () => {
  const ingested = await processDecision({
    input: decision("hash-first-sight"),
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-15T08:00:00.000Z"),
    observationOrder: 1n,
    corpus,
  });
  expect(ingested.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);

  const published = await readCitations();
  // The fault boundary: one citation invokes an authority and one names the
  // case's own history, so the kind gate is actually exercised.
  expect(
    published.map(({ citationText, kind }) => ({ citationText, kind })),
  ).toEqual([
    { citationText: CITED_PRECEDENT, kind: CITATION_KIND.PRECEDENT },
    { citationText: CITED_LOWER_COURT, kind: CITATION_KIND.PROCEDURAL },
  ]);
  expect(
    published.map(({ polarity, polarityRuleId }) => ({
      polarity,
      polarityRuleId,
    })),
  ).toEqual([
    { polarity: srovRule.polarity, polarityRuleId: srovRule.id },
    // The procedural sentence carries a neutral cue, and the row is still
    // unlabelled: null, not a word meaning "examined, matched nothing",
    // because null is what the background queue selects on.
    { polarity: null, polarityRuleId: null },
  ]);

  // Same document, new source hash: the refresh applies rather than
  // dedup-skipping. Its citations are the rows already stored, so not one of
  // them is rewritten, deleted or even locked: every tuple header survives.
  const headersBefore = await citationTupleHeaders();
  const refreshed = await processDecision({
    input: decision("hash-after-the-publisher-touched-it"),
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-15T09:00:00.000Z"),
    observationOrder: 2n,
    refresh: DECISION_REFRESH.ALWAYS,
    corpus,
  });
  expect(refreshed.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  expect(await citationTupleHeaders()).toEqual(headersBefore);
  expect(await readCitations()).toEqual(published);
  // Nothing was published again, so no rule fired again.
  expect(await readRule()).toMatchObject({ matchCount: 1 });

  // A stored row that no longer reads what the rules say is rewritten: the
  // verdict is taken off it here, as a rule retirement would, and the next
  // refresh publishes the rules' reading again on a new row.
  const precedent = published.find(
    ({ kind }) => kind === CITATION_KIND.PRECEDENT,
  );
  if (!precedent) {
    throw new TypeError("expected the precedent citation to be stored");
  }
  await db
    .update(caseLawCitations)
    .set({ polarity: null, polarityRuleId: null })
    .where(eq(caseLawCitations.id, precedent.id));
  const reclassified = await processDecision({
    input: decision("hash-after-a-rule-was-retired"),
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-15T10:00:00.000Z"),
    observationOrder: 3n,
    refresh: DECISION_REFRESH.ALWAYS,
    corpus,
  });
  expect(reclassified.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  const republished = await readCitations();
  expect(
    republished.map(({ citationText, kind, polarity, polarityRuleId }) => ({
      citationText,
      kind,
      polarity,
      polarityRuleId,
    })),
  ).toEqual(
    published.map(({ citationText, kind, polarity, polarityRuleId }) => ({
      citationText,
      kind,
      polarity,
      polarityRuleId,
    })),
  );
  // Only the row that differed is new; the other kept its identity.
  expect(republished.map(({ id }) => id === precedent.id)).toEqual([
    false,
    false,
  ]);
  expect(
    republished.filter(({ id }) => published.some((row) => row.id === id)),
  ).toHaveLength(1);
  // A row published with a verdict never reaches `classify-citations.ts`, so
  // the publish is the only place left that can say a rule fired: once for
  // the first row, once for the row that replaced it.
  expect(await readRule()).toMatchObject({ matchCount: 2 });
});

/**
 * The shape of an overruling: the case is recited with "srov." as part of
 * the line it belongs to, and rejected a page later. One row is published
 * for it, and it carries both readings: the rule tier reads every mention,
 * and mentions that disagree are stored as `mixed`. Reading the first
 * mention alone is what filed 23 Cdo 5068/2014 as supported by the velký
 * senát judgment that departed from it; reading only the severest of the two
 * lost the reliance the same judgment expressed.
 *
 * The row is attributed to the rule that read the departure, which is the
 * one whose retirement would change the answer.
 */
test("a case recited and then overruled in one section is published as mixed", async () => {
  const recital =
    "Rozhodovací praxe se ustálila v názoru, že ke skutečnostem, které " +
    "nastaly po sjednání smluvní pokuty, nelze přihlížet (srov. rozsudek " +
    "ze dne 24. 1. 2017, sp. zn. 23 Cdo 5068/2014).";
  const rejection =
    "Od závěrů rozsudku sp. zn. 23 Cdo 5068/2014 se velký senát odchyluje.";
  const section = `${recital}${" Další odůvodnění.".repeat(40)}${rejection}`;
  const ingested = await processDecision({
    input: {
      caseNumber: "31 Cdo 5555/2026",
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      decisionType: "rozsudek",
      metadata: {},
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      rawHash: "hash-overruling",
      fulltext: section,
      sections: [
        { index: 0, type: "argumentation", title: null, text: section },
      ],
      documentAst: EMPTY_AST,
    },
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-21T08:00:00.000Z"),
    observationOrder: 3n,
    corpus,
  });
  expect(ingested.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);

  const [row] = await db
    .select({
      polarity: caseLawCitations.polarity,
      rulePolarity: caseLawPolarityRules.polarity,
    })
    .from(caseLawCitations)
    .innerJoin(
      caseLawPolarityRules,
      eq(caseLawPolarityRules.id, caseLawCitations.polarityRuleId),
    )
    .where(eq(caseLawCitations.citationText, "sp. zn. 23 Cdo 5068/2014"));
  expect(row).toEqual({ polarity: "mixed", rulePolarity: "negative" });
});

test("a verdict from a rule retired mid-cycle is not published", async () => {
  // The rules a crawl compiled at the start of its cycle, held for the rest
  // of it. This is the cache `runIngestionPipeline` owns.
  const polarityRules: RuleCache = new Map();
  await loadRules("cs", scopedDb, polarityRules);
  expect(polarityRules.get("cs")?.length ?? 0).toBeGreaterThan(0);

  // What `seed-polarity-rules.ts` does when a rule is withdrawn: retire it,
  // then return the citations it labelled to the unclassified pool. The
  // maintenance lane it holds does not serialize against a crawl in flight,
  // so the cache above is now stale.
  await db
    .update(caseLawPolarityRules)
    .set({ source: RULE_SOURCE.RETIRED })
    .where(eq(caseLawPolarityRules.pattern, SROV_PATTERN));
  const retired = await readRule();

  await processDecision({
    input: {
      ...decision("hash-ingested-during-the-reseed"),
      caseNumber: "30 Cdo 5555/2026",
    },
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-15T11:00:00.000Z"),
    observationOrder: 4n,
    polarityRules,
    corpus,
  });

  // The stale cache still matched, and the publish refused the verdict: the
  // sweep that erased this rule's verdicts has already run, and nothing
  // revisits a row that carries one.
  const [precedent] = await db
    .select({
      polarity: caseLawCitations.polarity,
      polarityRuleId: caseLawCitations.polarityRuleId,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.citationText, CITED_PRECEDENT))
    .orderBy(desc(caseLawCitations.createdAt))
    .limit(1);
  expect(precedent).toEqual({ polarity: null, polarityRuleId: null });
  // And a retired rule's counter did not move for a match it may not assert.
  expect(await readRule()).toMatchObject({ matchCount: retired?.matchCount });
});
