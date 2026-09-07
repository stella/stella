import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS,
  CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS,
  caseLawCorpusIndexBackfills,
  caseLawCorpusIndexCountBackfills,
  caseLawCorpusIndexCounts,
  caseLawCorpusIndexProjections,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { advanceCaseLawCorpusIndexCountBackfill } from "@/api/lib/corpus-index/census";
import {
  installCaseLawProjectionAccounting,
  installCaseLawProjectionTrigger,
} from "@/api/tests/helpers/case-law-projection-trigger";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const GENERATION = "case_law_v2";
const FUTURE_GENERATION = "case_law_v3";
const INDEX_CZE = `${GENERATION}_cze`;
const INDEX_SVK = `${GENERATION}_svk`;
const sourceId = toSafeId<"caseLawSource">(
  "00000000-0000-4000-8000-0000000000a1",
);
const currentDecisionId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-0000000000b1",
);
const pendingDecisionId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-0000000000b2",
);
const racedDecisionId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-0000000000b3",
);
const insertedDecisionId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-0000000000b4",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

// The statement triggers touch one bucket per (generation, index_id) a
// statement changes. Without a fixed lock order, concurrent writers can take
// those row locks in opposite orders and deadlock, so every one of them must
// lock its buckets in primary-key order before the update reaches them. The
// set is discovered from the catalog rather than listed here, so a trigger
// added or renamed later is held to the same invariant.
const ORDERED_BUCKET_LOCK =
  /FROM case_law_corpus_index_counts AS counts\s+WHERE[\s\S]*?ORDER BY counts\.generation, counts\.index_id\s+FOR UPDATE/u;
const BUCKET_UPDATE = "UPDATE case_law_corpus_index_counts AS counts";

const countRows = async () =>
  await db
    .select({
      indexId: caseLawCorpusIndexCounts.indexId,
      markedIndexed: caseLawCorpusIndexCounts.markedIndexed,
    })
    .from(caseLawCorpusIndexCounts)
    .where(eq(caseLawCorpusIndexCounts.generation, GENERATION))
    .orderBy(asc(caseLawCorpusIndexCounts.indexId));

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  const handle = async (callback: (tx: Transaction) => Promise<unknown>) =>
    await db.transaction(
      // SAFETY: the embedded Drizzle transaction implements the transaction
      // surface used by the count backfill.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite is the scoped database in this integration test
      async (tx) => await callback(tx as unknown as Transaction),
    );
  // SAFETY: this brand adds no runtime behavior.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only scoped handle
  scopedDb = handle as unknown as ScopedDb;

  await db.insert(caseLawSources).values({
    adapterKey: "public",
    id: sourceId,
    name: "Public",
  });
  await db.insert(caseLawCorpusIndexBackfills).values({
    generation: GENERATION,
    status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
  });
  await db.insert(caseLawDecisions).values([
    {
      caseNumber: "current",
      contentHash: "hash-current",
      country: "CZE",
      court: "Test court",
      id: currentDecisionId,
      language: "cs",
      sourceId,
    },
    {
      caseNumber: "pending",
      contentHash: "hash-pending",
      country: "SVK",
      court: "Test court",
      id: pendingDecisionId,
      language: "sk",
      sourceId,
    },
    {
      caseNumber: "raced",
      contentHash: "hash-raced",
      country: "CZE",
      court: "Test court",
      id: racedDecisionId,
      language: "cs",
      sourceId,
    },
  ]);
  await db.insert(caseLawCorpusIndexProjections).values([
    {
      decisionId: currentDecisionId,
      generation: GENERATION,
      indexId: INDEX_CZE,
      indexedHash: "hash-current",
    },
    {
      decisionId: pendingDecisionId,
      generation: GENERATION,
      pendingAction: "index",
      pendingHash: "hash-pending",
      pendingIndexIds: [INDEX_SVK],
      pendingRevision: 1,
    },
    {
      decisionId: racedDecisionId,
      generation: GENERATION,
      indexId: INDEX_CZE,
      indexedHash: "hash-raced",
    },
  ]);

  await installCaseLawProjectionTrigger(db);
  await installCaseLawProjectionAccounting(db);
});

afterAll(async () => {
  await client.close();
});

test("count triggers lock their buckets in primary-key order before updating", async () => {
  // Every trigger function on the projection table that writes a count
  // bucket, whatever it is called.
  const installed = await db.execute(sql`
    SELECT proc.proname AS "name", pg_get_functiondef(proc.oid) AS "definition"
    FROM pg_catalog.pg_trigger AS projection_trigger
    JOIN pg_catalog.pg_class AS projection_table
      ON projection_table.oid = projection_trigger.tgrelid
    JOIN pg_catalog.pg_proc AS proc
      ON proc.oid = projection_trigger.tgfoid
    WHERE projection_table.relname = 'case_law_corpus_index_projections'
      AND NOT projection_trigger.tgisinternal
      AND pg_get_functiondef(proc.oid)
        ~ '(UPDATE|INSERT INTO)\\s+case_law_corpus_index_counts'
    ORDER BY proc.proname
  `);

  // The catalog columns arrive untyped; naming each function in the result
  // makes a failure report which definition regressed.
  const lockOrder = installed.rows.map((row) => {
    const definition = String(row["definition"]);
    const lockIndex = ORDERED_BUCKET_LOCK.exec(definition)?.index ?? -1;
    return {
      locksBeforeUpdating: definition.indexOf(BUCKET_UPDATE) > lockIndex,
      locksBucketsInOrder: lockIndex >= 0,
      name: String(row["name"]),
    };
  });
  // Naming the writers keeps a discovery that returned nothing from
  // satisfying the invariant vacuously, and makes adding one a decision. The
  // invariant below is checked against whatever the catalog returned.
  expect(lockOrder.map(({ name }) => name)).toEqual([
    "add_inserted_case_law_corpus_index_counts",
    "apply_updated_case_law_corpus_index_counts",
    "subtract_deleted_case_law_corpus_index_counts",
  ]);
  expect(
    lockOrder.filter(
      ({ locksBeforeUpdating, locksBucketsInOrder }) =>
        !locksBucketsInOrder || !locksBeforeUpdating,
    ),
  ).toEqual([]);
});

test("exact accounting converges across replay, races, and valid projection transitions", async () => {
  const seeded = await db
    .select()
    .from(caseLawCorpusIndexCountBackfills)
    .where(eq(caseLawCorpusIndexCountBackfills.generation, GENERATION));
  expect(seeded.at(0)?.status).toBe(
    CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.RUNNING,
  );
  expect(await countRows()).toEqual([]);

  // A post-migration update accounts this old row before the backfill reaches
  // it. Touching the row again during the seed must have a net delta of zero.
  await db
    .update(caseLawCorpusIndexProjections)
    .set({ indexId: INDEX_CZE })
    .where(eq(caseLawCorpusIndexProjections.decisionId, racedDecisionId));

  await db.insert(caseLawDecisions).values({
    caseNumber: "inserted",
    contentHash: "hash-inserted",
    country: "SVK",
    court: "Test court",
    id: insertedDecisionId,
    language: "sk",
    sourceId,
  });
  await db
    .update(caseLawCorpusIndexProjections)
    .set({
      indexId: INDEX_SVK,
      indexedHash: "hash-inserted",
      pendingAction: null,
      pendingHash: null,
      pendingIndexIds: [],
    })
    .where(eq(caseLawCorpusIndexProjections.decisionId, insertedDecisionId));
  expect(await countRows()).toEqual([
    { indexId: INDEX_CZE, markedIndexed: 1 },
    { indexId: INDEX_SVK, markedIndexed: 1 },
  ]);

  const page = await advanceCaseLawCorpusIndexCountBackfill(
    scopedDb,
    GENERATION,
  );
  expect(page).toEqual({
    generation: GENERATION,
    processed: 4,
    status: "running",
  });
  expect(await countRows()).toEqual([
    { indexId: INDEX_CZE, markedIndexed: 2 },
    { indexId: INDEX_SVK, markedIndexed: 1 },
  ]);

  // A settled projection with a stale hash is not accepted by serving and
  // must leave the count until the current hash is committed again.
  await db
    .update(caseLawCorpusIndexProjections)
    .set({ indexedHash: "stale-hash" })
    .where(eq(caseLawCorpusIndexProjections.decisionId, racedDecisionId));
  expect(await countRows()).toEqual([
    { indexId: INDEX_CZE, markedIndexed: 1 },
    { indexId: INDEX_SVK, markedIndexed: 1 },
  ]);
  await db
    .update(caseLawCorpusIndexProjections)
    .set({ indexedHash: "hash-raced" })
    .where(eq(caseLawCorpusIndexProjections.decisionId, racedDecisionId));
  expect(await countRows()).toEqual([
    { indexId: INDEX_CZE, markedIndexed: 2 },
    { indexId: INDEX_SVK, markedIndexed: 1 },
  ]);

  const complete = await advanceCaseLawCorpusIndexCountBackfill(
    scopedDb,
    GENERATION,
  );
  expect(complete).toEqual({
    generation: GENERATION,
    processed: 0,
    status: "complete",
  });
  expect(
    await advanceCaseLawCorpusIndexCountBackfill(scopedDb, GENERATION),
  ).toEqual(complete);
  expect(await countRows()).toEqual([
    { indexId: INDEX_CZE, markedIndexed: 2 },
    { indexId: INDEX_SVK, markedIndexed: 1 },
  ]);

  // The production decision trigger queues a jurisdiction move. The count
  // leaves the old physical index in the same transaction.
  await db
    .update(caseLawDecisions)
    .set({ country: "SVK" })
    .where(eq(caseLawDecisions.id, currentDecisionId));
  expect(await countRows()).toEqual([
    { indexId: INDEX_CZE, markedIndexed: 1 },
    { indexId: INDEX_SVK, markedIndexed: 1 },
  ]);

  // Clearing the queue is insufficient when the committed index does not
  // match the decision's current jurisdiction.
  await db
    .update(caseLawCorpusIndexProjections)
    .set({
      indexId: INDEX_CZE,
      pendingAction: null,
      pendingHash: null,
      pendingIndexIds: [],
    })
    .where(eq(caseLawCorpusIndexProjections.decisionId, currentDecisionId));
  expect(await countRows()).toEqual([
    { indexId: INDEX_CZE, markedIndexed: 1 },
    { indexId: INDEX_SVK, markedIndexed: 1 },
  ]);

  await db
    .update(caseLawCorpusIndexProjections)
    .set({
      indexId: INDEX_SVK,
      pendingAction: null,
      pendingHash: null,
      pendingIndexIds: [],
    })
    .where(eq(caseLawCorpusIndexProjections.decisionId, currentDecisionId));
  expect(await countRows()).toEqual([
    { indexId: INDEX_CZE, markedIndexed: 1 },
    { indexId: INDEX_SVK, markedIndexed: 2 },
  ]);

  await db
    .delete(caseLawCorpusIndexProjections)
    .where(eq(caseLawCorpusIndexProjections.decisionId, currentDecisionId));
  expect(await countRows()).toEqual([
    { indexId: INDEX_CZE, markedIndexed: 1 },
    { indexId: INDEX_SVK, markedIndexed: 1 },
  ]);

  await db
    .insert(caseLawCorpusIndexBackfills)
    .values({ generation: FUTURE_GENERATION });
  const checkpoint = await db
    .select({ status: caseLawCorpusIndexCountBackfills.status })
    .from(caseLawCorpusIndexCountBackfills)
    .where(eq(caseLawCorpusIndexCountBackfills.generation, FUTURE_GENERATION));
  expect(checkpoint.at(0)?.status).toBe(
    CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.RUNNING,
  );
  expect(
    await advanceCaseLawCorpusIndexCountBackfill(scopedDb, FUTURE_GENERATION),
  ).toEqual({
    generation: FUTURE_GENERATION,
    processed: 0,
    status: CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.RUNNING,
  });

  await db
    .update(caseLawCorpusIndexBackfills)
    .set({ status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE })
    .where(eq(caseLawCorpusIndexBackfills.generation, FUTURE_GENERATION));
  expect(
    await advanceCaseLawCorpusIndexCountBackfill(scopedDb, FUTURE_GENERATION),
  ).toEqual({
    generation: FUTURE_GENERATION,
    processed: 0,
    status: CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.COMPLETE,
  });
});
