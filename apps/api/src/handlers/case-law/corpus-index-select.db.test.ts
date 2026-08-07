import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawCorpusIndexBackfills,
  caseLawCorpusIndexProjections,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { caseLawCorpusIndexAdapter } from "@/api/handlers/case-law/corpus-index";
import { createSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// Two structures record "what of this row is in the engine":
// `case_law_decisions.indexed_hash` (the serving marker) and the generation
// projection's own `indexed_hash`. A generation rebuild commits only the
// projection. Selecting on the serving marker alone therefore re-offers every
// row the rebuild already placed — work that is a no-op against the engine and
// costs a corpus read, a delete task and an ingest apiece.
//
// The pick order is deliberately unspecified, so these assert set membership
// rather than position.

const GENERATION = "case_law_v2";
const INDEX_ID = `${GENERATION}_cze`;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const neverIndexedId = createSafeId<"caseLawDecision">();
const rebuiltId = createSafeId<"caseLawDecision">();
const rebuiltThenChangedId = createSafeId<"caseLawDecision">();
const rebuiltThenRefreshedId = createSafeId<"caseLawDecision">();

// Annotated rather than asserted, so the callback parameter is typed from the
// adapter's own signature instead of being widened by a cast.
const scopedDb: Parameters<
  typeof caseLawCorpusIndexAdapter.selectMissing
>[0] = async (callback) =>
  // SAFETY: pglite stands in for the transaction the adapter expects; the
  // adapter only issues reads here.
  // eslint-disable-next-line node/callback-return, typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "cz-ns",
      name: "test source",
    });
    await db
      .insert(caseLawCorpusIndexBackfills)
      .values({ generation: GENERATION, status: "complete" });

    const base = {
      sourceId,
      court: "Okresní soud v Praze",
      country: "CZE",
      language: "cs",
      fulltext: "text",
      decisionDate: "2020-01-01",
      // The serving marker is null on all four: that is exactly the state a
      // generation rebuild leaves behind, and the state this scan keys on.
      indexedHash: null,
    };
    await db.insert(caseLawDecisions).values([
      {
        ...base,
        id: neverIndexedId,
        caseNumber: "1 T 1/2020",
        slug: "never",
        languageGroupKey: "never",
        contentHash: "hash-never",
      },
      {
        ...base,
        id: rebuiltId,
        caseNumber: "2 T 2/2020",
        slug: "rebuilt",
        languageGroupKey: "rebuilt",
        contentHash: "hash-rebuilt",
      },
      {
        ...base,
        id: rebuiltThenChangedId,
        caseNumber: "3 T 3/2020",
        slug: "changed",
        languageGroupKey: "changed",
        contentHash: "hash-new",
      },
      {
        ...base,
        id: rebuiltThenRefreshedId,
        caseNumber: "4 T 4/2020",
        slug: "refreshed",
        languageGroupKey: "refreshed",
        contentHash: "hash-refreshed",
      },
    ]);

    // Only the last three were placed by the rebuild. The third's content
    // moved on afterwards; the fourth had a metadata-only refresh, so its
    // durable replacement remains queued despite an unchanged content hash.
    await db.insert(caseLawCorpusIndexProjections).values([
      {
        generation: GENERATION,
        decisionId: rebuiltId,
        indexId: INDEX_ID,
        indexedHash: "hash-rebuilt",
      },
      {
        generation: GENERATION,
        decisionId: rebuiltThenChangedId,
        indexId: INDEX_ID,
        indexedHash: "hash-old",
      },
      {
        generation: GENERATION,
        decisionId: rebuiltThenRefreshedId,
        indexId: INDEX_ID,
        indexedHash: "hash-refreshed",
        pendingAction: "index",
        pendingHash: "hash-refreshed",
        pendingIndexIds: [INDEX_ID],
        pendingRevision: 1,
      },
    ]);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await client.close();
});

test("a row the rebuild already committed is not offered again", async () => {
  const rows = await caseLawCorpusIndexAdapter.selectMissing(scopedDb, {
    generation: GENERATION,
    limit: 50,
  });
  const ids = new Set(rows.map((row) => row.id));

  // Never touched: still needs indexing.
  expect(ids.has(neverIndexedId)).toBe(true);
  // Content moved past what the projection committed: still needs indexing.
  expect(ids.has(rebuiltThenChangedId)).toBe(true);
  // Metadata moved while content stayed the same: the queued replacement must
  // still run so fields outside the content hash reach the engine.
  expect(ids.has(rebuiltThenRefreshedId)).toBe(true);
  // Already in the engine at this exact content. Re-offering it is the defect.
  expect(ids.has(rebuiltId)).toBe(false);
});

test("the scan still empties once every row is committed", async () => {
  await db.execute(
    sql`UPDATE ${caseLawCorpusIndexProjections} SET indexed_hash = 'hash-new'
        WHERE decision_id = ${rebuiltThenChangedId}`,
  );
  await db.insert(caseLawCorpusIndexProjections).values({
    generation: GENERATION,
    decisionId: neverIndexedId,
    indexId: INDEX_ID,
    indexedHash: "hash-never",
  });
  await db.execute(
    sql`UPDATE ${caseLawCorpusIndexProjections}
        SET pending_action = null, pending_hash = null, pending_index_ids = '{}'
        WHERE decision_id = ${rebuiltThenRefreshedId}`,
  );

  const rows = await caseLawCorpusIndexAdapter.selectMissing(scopedDb, {
    generation: GENERATION,
    limit: 50,
  });

  // Fixed point: a fully committed generation offers no work at all.
  expect(rows).toEqual([]);
});
