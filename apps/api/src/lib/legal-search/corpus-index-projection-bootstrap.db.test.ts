import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { bootstrapCorpusProjectionDesiredStateBatchTx } from "@/api/lib/legal-search/corpus-index-projection-bootstrap";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const CASE_LAW_SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000101",
);
const CASE_LAW_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000102",
);
const SECOND_CASE_LAW_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000105",
);
const LEGISLATION_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000103",
);
const LEGISLATION_DOCUMENT_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000000104",
);
const SECOND_LEGISLATION_DOCUMENT_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000000106",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

beforeEach(async () => {
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(legislationDocuments).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(legislationSources).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);

  await db.insert(caseLawSources).values({
    id: CASE_LAW_SOURCE_ID,
    adapterKey: "projection-desired-state",
    name: "Projection desired state",
  });
  await db.insert(caseLawDecisions).values([
    {
      id: CASE_LAW_DECISION_ID,
      sourceId: CASE_LAW_SOURCE_ID,
      caseNumber: "4 As 3/2008",
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: "a".repeat(64),
    },
    {
      id: SECOND_CASE_LAW_DECISION_ID,
      sourceId: CASE_LAW_SOURCE_ID,
      caseNumber: "5 As 4/2009",
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: "c".repeat(64),
    },
  ]);
  await db.insert(legislationSources).values({
    id: LEGISLATION_SOURCE_ID,
    adapterKey: "projection-desired-state",
    name: "Projection desired state",
  });
  await db.insert(legislationDocuments).values([
    {
      id: LEGISLATION_DOCUMENT_ID,
      sourceId: LEGISLATION_SOURCE_ID,
      eli: "eli/cz/sb/2012/89",
      title: "Občanský zákoník",
      country: "CZE",
      language: "cs",
      contentHash: "b".repeat(64),
    },
    {
      id: SECOND_LEGISLATION_DOCUMENT_ID,
      sourceId: LEGISLATION_SOURCE_ID,
      eli: "eli/cz/sb/2013/90",
      title: "Zákon o státní službě",
      country: "CZE",
      language: "cs",
      contentHash: "d".repeat(64),
    },
  ]);
  await db.insert(corpusIndexGenerations).values([
    {
      family: "case_law",
      generation: "case_law_v5",
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.case_law_v5,
      ),
      status: "building",
    },
    {
      family: "legislation",
      generation: "legislation_v2",
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.legislation_v2,
      ),
      status: "building",
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

test("bulk bootstrap advances a keyset cursor and reaches a fixed point", async () => {
  const first = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "case_law", generation: "case_law_v5", limit: 1 },
      ),
  );
  expect(first).toMatchObject({
    status: "advanced",
    family: "case_law",
    generation: "case_law_v5",
    claimedCount: 1,
    seededCount: 1,
    nextAfterEntityId: CASE_LAW_DECISION_ID,
  });
  expect(first.entityIds).toEqual([CASE_LAW_DECISION_ID]);

  const second = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          limit: 1,
          afterEntityId: CASE_LAW_DECISION_ID,
        },
      ),
  );
  expect(second).toMatchObject({
    status: "advanced",
    family: "case_law",
    generation: "case_law_v5",
    claimedCount: 1,
    seededCount: 1,
    entityIds: [SECOND_CASE_LAW_DECISION_ID],
    nextAfterEntityId: SECOND_CASE_LAW_DECISION_ID,
  });

  const rangeComplete = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          limit: 1,
          afterEntityId: SECOND_CASE_LAW_DECISION_ID,
        },
      ),
  );
  expect(rangeComplete).toEqual({
    status: "range_complete",
    family: "case_law",
    generation: "case_law_v5",
    claimedCount: 0,
    seededCount: 0,
    entityIds: [],
  });

  const complete = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "case_law", generation: "case_law_v5", limit: 1 },
      ),
  );
  expect(complete).toEqual({
    status: "complete",
    family: "case_law",
    generation: "case_law_v5",
    claimedCount: 0,
    seededCount: 0,
    entityIds: [],
  });

  expect(
    await db
      .select({ entityId: corpusIndexProjectionStates.entityId })
      .from(corpusIndexProjectionStates),
  ).toHaveLength(2);
  expect(
    await db
      .select({ epoch: caseLawDecisions.projectionEpoch })
      .from(caseLawDecisions)
      .orderBy(caseLawDecisions.id),
  ).toEqual([{ epoch: 1n }, { epoch: 1n }]);
});

test("bulk bootstrap uses the same contract for legislation", async () => {
  const result = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "legislation", generation: "legislation_v2", limit: 2 },
      ),
  );

  expect(result).toMatchObject({
    status: "advanced",
    family: "legislation",
    generation: "legislation_v2",
    claimedCount: 2,
    seededCount: 2,
  });
  expect(result.entityIds).toHaveLength(2);
});

test("bootstrap locks source policy before canonical rows for every family", async () => {
  const statements: string[] = [];
  const loggedDb = drizzle({
    client,
    logger: {
      logQuery(query) {
        statements.push(query);
      },
    },
  });
  await loggedDb.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "case_law", generation: "case_law_v5", limit: 1 },
      ),
  );
  await loggedDb.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "legislation", generation: "legislation_v2", limit: 1 },
      ),
  );

  const assertSourceBeforeDocument = (
    sourceTable: string,
    documentTable: string,
  ): void => {
    const sourceLock = statements.findIndex((query) =>
      query.includes(`for share of "${sourceTable}"`),
    );
    const documentLock = statements.findIndex((query) =>
      query.includes(`for update of "${documentTable}"`),
    );
    expect(sourceLock).toBeGreaterThanOrEqual(0);
    expect(documentLock).toBeGreaterThan(sourceLock);
  };
  assertSourceBeforeDocument("case_law_sources", "case_law_decisions");
  assertSourceBeforeDocument("legislation_sources", "legislation_documents");
});
