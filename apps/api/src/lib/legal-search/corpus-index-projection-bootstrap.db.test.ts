import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
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

  // Replaying the sweep from the head of the corpus claims nothing and still
  // advances: a page sees only its own id range, so concluding that the
  // generation is seeded belongs to the caller driving the sweep.
  const replay = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "case_law", generation: "case_law_v5", limit: 1 },
      ),
  );
  expect(replay).toEqual({
    status: "advanced",
    family: "case_law",
    generation: "case_law_v5",
    claimedCount: 0,
    seededCount: 0,
    entityIds: [],
    nextAfterEntityId: CASE_LAW_DECISION_ID,
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

test("a cursor page is an id-range seek, never an anti-join over the corpus", async () => {
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
        {
          family: "case_law",
          generation: "case_law_v5",
          limit: 1,
          afterEntityId: CASE_LAW_DECISION_ID,
        },
      ),
  );
  await loggedDb.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        {
          family: "legislation",
          generation: "legislation_v2",
          limit: 1,
          afterEntityId: LEGISLATION_DOCUMENT_ID,
        },
      ),
  );

  const assertPagedByIdRange = (
    canonicalTable: string,
    sourceTable: string,
  ): void => {
    const cursorPages = statements.filter((query) =>
      query.includes(`for share of "${sourceTable}"`),
    );
    expect(cursorPages).toHaveLength(1);
    const cursorPage = cursorPages.at(0);
    expect(cursorPage).toContain(`"${canonicalTable}"."id" > $`);
    // The page must not pay for rows outside its id range, so the desired
    // state anti-join belongs to the rows it seeds, not to its paging.
    expect(cursorPage).not.toContain(
      'left join "corpus_index_projection_states"',
    );

    const seedingReads = statements.filter((query) =>
      query.includes(`for update of "${canonicalTable}"`),
    );
    expect(seedingReads).toHaveLength(1);
    const seedingRead = seedingReads.at(0);
    expect(seedingRead).toContain('left join "corpus_index_projection_states"');
    expect(seedingRead).toContain(`"${canonicalTable}"."id" in (`);
  };
  assertPagedByIdRange("case_law_decisions", "case_law_sources");
  assertPagedByIdRange("legislation_documents", "legislation_sources");
});

test("a page's work is bounded by its limit, not by how many rows are already seeded", async () => {
  const THIRD_DECISION_ID = toSafeId<"caseLawDecision">(
    "0198e331-e578-7000-8000-000000000107",
  );
  const FOURTH_DECISION_ID = toSafeId<"caseLawDecision">(
    "0198e331-e578-7000-8000-000000000108",
  );
  const FIFTH_DECISION_ID = toSafeId<"caseLawDecision">(
    "0198e331-e578-7000-8000-000000000109",
  );
  await db.insert(caseLawDecisions).values(
    [THIRD_DECISION_ID, FOURTH_DECISION_ID, FIFTH_DECISION_ID].map(
      (id, index) => ({
        id,
        sourceId: CASE_LAW_SOURCE_ID,
        caseNumber: `6 As ${index + 5}/2010`,
        court: "Nejvyšší správní soud",
        country: "CZE",
        language: "cs",
        contentHash: String(index).repeat(64),
      }),
    ),
  );

  const seedAll = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "case_law", generation: "case_law_v5", limit: 5 },
      ),
  );
  expect(seedAll).toMatchObject({ status: "advanced", seededCount: 5 });
  await db
    .delete(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, "case_law"),
        eq(corpusIndexProjectionStates.generation, "case_law_v5"),
        inArray(corpusIndexProjectionStates.entityId, [
          SECOND_CASE_LAW_DECISION_ID,
          THIRD_DECISION_ID,
        ]),
      ),
    );

  const firstPage = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "case_law", generation: "case_law_v5", limit: 2 },
      ),
  );
  // The page covers the first two ids and seeds only the gap among them; it
  // does not skip ahead to the next unseeded row.
  expect(firstPage).toMatchObject({
    status: "advanced",
    claimedCount: 1,
    seededCount: 1,
    entityIds: [SECOND_CASE_LAW_DECISION_ID],
    nextAfterEntityId: SECOND_CASE_LAW_DECISION_ID,
  });

  const secondPage = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          limit: 2,
          afterEntityId: SECOND_CASE_LAW_DECISION_ID,
        },
      ),
  );
  expect(secondPage).toMatchObject({
    status: "advanced",
    claimedCount: 1,
    seededCount: 1,
    entityIds: [THIRD_DECISION_ID],
    nextAfterEntityId: FOURTH_DECISION_ID,
  });

  const seededPage = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          limit: 2,
          afterEntityId: FOURTH_DECISION_ID,
        },
      ),
  );
  expect(seededPage).toMatchObject({
    status: "advanced",
    claimedCount: 0,
    seededCount: 0,
    entityIds: [],
    nextAfterEntityId: FIFTH_DECISION_ID,
  });

  const rangeComplete = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          limit: 2,
          afterEntityId: FIFTH_DECISION_ID,
        },
      ),
  );
  // The sweep ends at the end of the id range; the pages above cost two ids
  // each, whichever of those ids already carried a desired state.
  expect(rangeComplete).toMatchObject({ status: "range_complete" });

  expect(
    await db
      .select({ entityId: corpusIndexProjectionStates.entityId })
      .from(corpusIndexProjectionStates),
  ).toHaveLength(5);
});

test("a null-cursor page reports complete only when the corpus holds no rows", async () => {
  await db.delete(caseLawDecisions).where(sql`true`);

  const result = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "case_law", generation: "case_law_v5", limit: 2 },
      ),
  );
  expect(result).toEqual({
    status: "complete",
    family: "case_law",
    generation: "case_law_v5",
    claimedCount: 0,
    seededCount: 0,
    entityIds: [],
  });
});

test("a legislation page with nothing to seed advances instead of stalling", async () => {
  const seedFirst = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "legislation", generation: "legislation_v2", limit: 1 },
      ),
  );
  expect(seedFirst).toMatchObject({
    status: "advanced",
    seededCount: 1,
    nextAfterEntityId: LEGISLATION_DOCUMENT_ID,
  });

  const seededPage = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        { family: "legislation", generation: "legislation_v2", limit: 1 },
      ),
  );
  expect(seededPage).toMatchObject({
    status: "advanced",
    claimedCount: 0,
    seededCount: 0,
    entityIds: [],
    nextAfterEntityId: LEGISLATION_DOCUMENT_ID,
  });

  const gapPage = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        {
          family: "legislation",
          generation: "legislation_v2",
          limit: 1,
          afterEntityId: LEGISLATION_DOCUMENT_ID,
        },
      ),
  );
  expect(gapPage).toMatchObject({
    status: "advanced",
    claimedCount: 1,
    seededCount: 1,
    entityIds: [SECOND_LEGISLATION_DOCUMENT_ID],
    nextAfterEntityId: SECOND_LEGISLATION_DOCUMENT_ID,
  });

  const rangeComplete = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        {
          family: "legislation",
          generation: "legislation_v2",
          limit: 1,
          afterEntityId: SECOND_LEGISLATION_DOCUMENT_ID,
        },
      ),
  );
  expect(rangeComplete).toMatchObject({ status: "range_complete" });
});

test("a seed limit bounds what a page writes, and the cursor stops with it", async () => {
  const THIRD_DECISION_ID = toSafeId<"caseLawDecision">(
    "0198e331-e578-7000-8000-000000000107",
  );
  const FOURTH_DECISION_ID = toSafeId<"caseLawDecision">(
    "0198e331-e578-7000-8000-000000000108",
  );
  await db.insert(caseLawDecisions).values(
    [THIRD_DECISION_ID, FOURTH_DECISION_ID].map((id, index) => ({
      id,
      sourceId: CASE_LAW_SOURCE_ID,
      caseNumber: `6 As ${index + 5}/2010`,
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: String(index).repeat(64),
    })),
  );

  // Four ids in the range and a budget for two: the page reads all four and
  // seeds the first two gaps among them.
  const firstPage = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          limit: 4,
          seedLimit: 2,
        },
      ),
  );
  // The cursor stops at the last id the page accounted for rather than at the
  // end of the range it read, because the ids past it are still gaps.
  expect(firstPage).toMatchObject({
    status: "advanced",
    claimedCount: 2,
    seededCount: 2,
    entityIds: [CASE_LAW_DECISION_ID, SECOND_CASE_LAW_DECISION_ID],
    nextAfterEntityId: SECOND_CASE_LAW_DECISION_ID,
  });

  const secondPage = await db.transaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          limit: 4,
          seedLimit: 2,
          afterEntityId: SECOND_CASE_LAW_DECISION_ID,
        },
      ),
  );
  expect(secondPage).toMatchObject({
    status: "advanced",
    claimedCount: 2,
    seededCount: 2,
    entityIds: [THIRD_DECISION_ID, FOURTH_DECISION_ID],
    nextAfterEntityId: FOURTH_DECISION_ID,
  });

  expect(
    await db
      .select({ entityId: corpusIndexProjectionStates.entityId })
      .from(corpusIndexProjectionStates)
      .orderBy(corpusIndexProjectionStates.entityId),
  ).toEqual([
    { entityId: CASE_LAW_DECISION_ID },
    { entityId: SECOND_CASE_LAW_DECISION_ID },
    { entityId: THIRD_DECISION_ID },
    { entityId: FOURTH_DECISION_ID },
  ]);
});

test("a seed limit wider than the page is rejected before any row is read", async () => {
  // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
  // type-aware lint; capture the rejection explicitly instead.
  const rejection = await db
    .transaction(
      async (tx) =>
        await bootstrapCorpusProjectionDesiredStateBatchTx(
          asTestRaw<Transaction>(tx),
          {
            family: "case_law",
            generation: "case_law_v5",
            limit: 2,
            seedLimit: 3,
          },
        ),
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection instanceof Error ? rejection.message : "").toContain(
    "seed limit must be an integer from 1 to the page limit 2",
  );
});
