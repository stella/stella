/**
 * Polarity is written when the citation row is published, and a refresh
 * re-derives it.
 *
 * A refresh deletes every citation row of the decision and re-inserts it from
 * the document, so a label written after the insert — by the background
 * classifier, whenever it next comes round — lives only until the next
 * refresh. Classifying in the pipeline makes the delete/re-insert a
 * recomputation rather than a blanking, which is what the second half of the
 * test below asserts: the rows are new rows, carrying the same reading.
 *
 * The rules come from `SEED_RULES`, not from patterns invented here: the
 * assertion is about what the shipped rule set says about a Czech sentence.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
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
import {
  DECISION_REFRESH,
  PROCESS_DECISION_STATUS,
  processDecision,
} from "@/api/handlers/case-law/ingestion/pipeline";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline";
import { RULE_SOURCE } from "@/api/handlers/case-law/polarity/consts";
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
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

/** Postgres holds the payload; no object store takes part in this test. */
const corpus: CaseLawCorpusDependencies = {
  mode: "off",
  write: () => {
    throw new TypeError("a postgres-only plan must not write corpus objects");
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
  // dedup-skipping, and it deletes and re-inserts every row above.
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

  const reinserted = await readCitations();
  // New rows, or the assertion below would hold for a pipeline that never
  // reclassifies because it never rewrote anything.
  expect(reinserted.map(({ id }) => id)).not.toEqual(
    published.map(({ id }) => id),
  );
  expect(
    reinserted.map(({ citationText, kind, polarity, polarityRuleId }) => ({
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
});
