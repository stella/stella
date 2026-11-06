import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_RESOLUTION_STATUS } from "@/api/handlers/case-law/citation-resolution-status";
import { citationKeyOf } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { runDecisionIdentifierBackfill } from "@/api/handlers/case-law/ingestion/decision-identifier-backfill";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const citingId = createSafeId<"caseLawDecision">();

// A structural adapter across Drizzle drivers, as the backfill's own test uses.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const rootDb = () => db as unknown as CaseLawRootHandle;

const decision = (id: SafeId<"caseLawDecision">, caseNumber: string) => ({
  id,
  sourceId,
  caseNumber,
  citationKey: citationKeyOf(caseNumber),
  court: "Ústavní soud",
  country: "CZE",
  language: "cs",
  decisionDate: "2011-06-16",
  slug: `reopen-${id}`,
  languageGroupKey: `reopen-${id}`,
  metadata: {},
});

const respelledHolder = createSafeId<"caseLawDecision">();
const unidentifiedHolder = createSafeId<"caseLawDecision">();
const aliasHolder = createSafeId<"caseLawDecision">();
const respelledCitation = createSafeId<"caseLawCitation">();
const unidentifiedCitation = createSafeId<"caseLawCitation">();
const aliasCitation = createSafeId<"caseLawCitation">();

const attemptedAt = new Date("2026-11-01T10:00:00.000Z");

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `identifier-reopen-${Bun.randomUUIDv7().slice(0, 16)}`,
    name: "Identifier reopen test",
  });
  await db.insert(caseLawDecisions).values([
    {
      ...decision(citingId, "III.ÚS 2780/25"),
      decisionDate: "2026-10-22",
    },
    decision(respelledHolder, "I.ÚS 3622/10"),
    decision(unidentifiedHolder, "IV.ÚS 137/05"),
    {
      ...decision(aliasHolder, "II.ÚS 2929/18"),
      metadata: { additionalCaseNumbers: ["II.ÚS 7/18"] },
    },
  ]);
  // The docket stored in another spelling of one identity.
  await db.insert(caseLawDecisionIdentifiers).values({
    decisionId: respelledHolder,
    type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    value: "I. ÚS 3622/10",
    normalizedValue: citationKeyOf("I.ÚS 3622/10") ?? "",
  });
  await db.insert(caseLawCitations).values([
    {
      id: respelledCitation,
      citingDecisionId: citingId,
      citationText: "I. ÚS 3622/10",
      citationKey: citationKeyOf("I. ÚS 3622/10"),
      citedDecisionId: respelledHolder,
      resolutionStatus: CITATION_RESOLUTION_STATUS.RESOLVED,
      resolutionAttemptedAt: attemptedAt,
    },
    {
      id: unidentifiedCitation,
      citingDecisionId: citingId,
      citationText: "IV. ÚS 137/05",
      citationKey: citationKeyOf("IV. ÚS 137/05"),
      citedDecisionId: unidentifiedHolder,
      resolutionStatus: CITATION_RESOLUTION_STATUS.RESOLVED,
      resolutionAttemptedAt: attemptedAt,
    },
    {
      id: aliasCitation,
      citingDecisionId: citingId,
      citationText: "II. ÚS 7/18",
      citationKey: citationKeyOf("II. ÚS 7/18"),
      resolutionStatus: CITATION_RESOLUTION_STATUS.UNMATCHED,
      resolutionAttemptedAt: attemptedAt,
    },
  ]);
  await runDecisionIdentifierBackfill(rootDb(), { batchSize: 10 });
});

afterAll(async () => {
  await client.close();
});

const rowOf = async (id: SafeId<"caseLawCitation">) =>
  (
    await db
      .select({
        cited: caseLawCitations.citedDecisionId,
        status: caseLawCitations.resolutionStatus,
      })
      .from(caseLawCitations)
      .where(eq(caseLawCitations.id, id))
      .limit(1)
  ).at(0);

test("respelling a stored identifier keeps the links to its decision", async () => {
  expect(await rowOf(respelledCitation)).toEqual({
    cited: respelledHolder,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
  expect(
    await db
      .select({ value: caseLawDecisionIdentifiers.value })
      .from(caseLawDecisionIdentifiers)
      .where(eq(caseLawDecisionIdentifiers.decisionId, respelledHolder)),
  ).toEqual([{ value: "I.ÚS 3622/10" }]);
});

test("recording the docket a decision already answers under keeps its links", async () => {
  expect(await rowOf(unidentifiedCitation)).toEqual({
    cited: unidentifiedHolder,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
});

test("an identifier a decision did not answer under still reopens its citations", async () => {
  expect(await rowOf(aliasCitation)).toEqual({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });
});
