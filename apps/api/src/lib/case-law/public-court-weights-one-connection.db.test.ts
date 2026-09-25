import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { stellaPublicLawReader } from "@/api/db/rls";
import {
  caseLawCitations,
  caseLawCourtWeights,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { readCitationGraphFacts } from "@/api/handlers/case-law/analysis/significance";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * A public decision read and the significance graph read hold a reader
 * transaction while they ask for the court registry. On a cold cache that
 * read must run on the transaction they hold: the reader's pool is small,
 * and asking it for a second connection while holding the first waits on
 * itself. PGlite is one connection, so a read that opened its own
 * transaction here would stall until the registry bound gave up, and the
 * decision would lose its court tier.
 *
 * Both reads run through their production entry points with no registry
 * injected; the public configuration is bound to the one-connection reader.
 */

const COURT = "One connection census court";
const COURT_PATTERN = "one connection census court";
const SUPREME_TIER = 3;

let testDb: TestDatabase;
const sourceId = createSafeId<"caseLawSource">();
const subjectId = createSafeId<"caseLawDecision">();
const citingId = createSafeId<"caseLawDecision">();

/** The public-law reader over the test database's single connection. */
const oneConnectionReader = async <T>(
  fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
): Promise<T> => {
  const results: { value: T }[] = [];
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE "${stellaPublicLawReader.name}"`));
    results.push({
      value: await fn(asTestRaw<CaseLawPublicReadTransaction>(tx)),
    });
  });
  const result = results.at(0);
  return result === undefined
    ? panic("the reader transaction did not complete")
    : result.value;
};

const readerDb = asTestRaw<CaseLawPublicReadDb>(oneConnectionReader);

beforeAll(
  async () => {
    testDb = await getTestDb();
    await testDb.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "one-connection-census",
      name: "One connection census",
    });
    await testDb.insert(caseLawDecisions).values([
      {
        id: subjectId,
        sourceId,
        caseNumber: "one-connection-subject",
        court: COURT,
        country: "CZE",
        language: "cs",
        decisionDate: "2020-01-01",
      },
      {
        id: citingId,
        sourceId,
        caseNumber: "one-connection-citing",
        court: COURT,
        country: "CZE",
        language: "cs",
        decisionDate: "2024-01-01",
      },
    ]);
    await testDb.insert(caseLawCitations).values({
      citingDecisionId: citingId,
      citedDecisionId: subjectId,
      citationText: "one-connection-subject",
      kind: CITATION_KIND.PRECEDENT,
    });
    await testDb.insert(caseLawCourtWeights).values({
      country: "CZE",
      courtPattern: COURT_PATTERN,
      tier: SUPREME_TIER,
      tierLabel: "supreme",
      weight: 8,
    });
  },
  { timeout: 30_000 },
);

beforeEach(() => {
  // Cold, and bound to the one-connection reader.
  resetPublicCaseLawConfigForTesting(readerDb);
});

afterAll(async () => {
  resetPublicCaseLawConfigForTesting();
  await testDb
    .delete(caseLawCourtWeights)
    .where(eq(caseLawCourtWeights.courtPattern, COURT_PATTERN));
  await testDb
    .delete(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [subjectId, citingId]));
  await testDb.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
  await releaseTestDb();
});

describe("a cold court registry inside a one-connection public read", () => {
  test("a decision read draws its court tier", async () => {
    const decision = await withRedistributableSubject(
      readerDb,
      { kind: "id", id: subjectId },
      async (subject) => await readDecisionHandler({ subject }),
    );

    expect(decision).toMatchObject({ courtTier: "supreme" });
  });

  test("the significance graph read weighs its citing court", async () => {
    const facts = await readerDb(
      async (tx) => await readCitationGraphFacts({ decisionId: subjectId, tx }),
    );

    expect(facts?.countsByCourtTier).toEqual([
      { tier: SUPREME_TIER, count: 1 },
    ]);
  });
});
