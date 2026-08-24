import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { caseLawCorpusIndexAdapter } from "@/api/handlers/case-law/corpus-index";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// The batched mark rewrites hundreds of per-row compare-and-set updates
// into one VALUES join. The batching must not weaken the per-row CAS:
// a row whose expected pre-state no longer matches (concurrent refresh)
// stays unmarked while its batch-mates commit, NULL expected hashes
// (a first-time index) must compare via IS NOT DISTINCT FROM, and the
// mark must neither bump updated_at nor let a stale overlapping build
// re-mark a hash-current row whose generation already advanced — all
// shapes a serializer-level test cannot prove.

const NOW = new Date("2026-07-28T12:00:00.000Z");
const OLD_GENERATION = "case_law_v1_cze";
const NEW_GENERATION = "case_law_v2_cze";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const freshId = createSafeId<"caseLawDecision">();
const movedId = createSafeId<"caseLawDecision">();
const regenId = createSafeId<"caseLawDecision">();

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    // The columns are naive timestamps while the statement's expected values
    // arrive as text; a non-UTC session proves the comparison does not detour
    // through timestamptz and the session time zone (which would make every
    // CAS miss on a non-UTC connection).
    await db.execute(sql.raw("SET TIME ZONE 'Europe/Prague'"));

    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "cz-ns",
      name: "test source",
    });
    const base = {
      sourceId,
      court: "Okresní soud v Praze",
      country: "CZE",
      language: "cs",
      fulltext: "text",
      decisionDate: "2020-01-01",
    };
    await db.insert(caseLawDecisions).values([
      {
        ...base,
        id: freshId,
        caseNumber: "1 T 1/2020",
        slug: "fresh",
        languageGroupKey: "fresh",
        contentHash: "hash-fresh",
        indexedHash: null,
      },
      {
        ...base,
        id: movedId,
        caseNumber: "2 T 2/2020",
        slug: "moved",
        languageGroupKey: "moved",
        contentHash: "hash-moved",
        indexedHash: "hash-old",
      },
      {
        ...base,
        id: regenId,
        caseNumber: "3 T 3/2020",
        slug: "regen",
        languageGroupKey: "regen",
        contentHash: "hash-regen",
        indexedHash: "hash-regen",
        indexedGeneration: OLD_GENERATION,
      },
    ]);
    // SQL now() carries microseconds, which a JS Date round-trip silently
    // truncates: the CAS must match against the exact stored value, which
    // is the whole point of the text token. Every row in this fixture gets
    // a microsecond timestamp so a Date regression fails the test.
    await db.execute(
      sql`UPDATE ${caseLawDecisions} SET updated_at = now() + interval '123 microseconds'`,
    );
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await client.close();
});

const loadRow = async (id: SafeId<"caseLawDecision">) => {
  const [row] = await db
    .select({
      id: caseLawDecisions.id,
      sourceId: caseLawDecisions.sourceId,
      caseNumber: caseLawDecisions.caseNumber,
      ecli: caseLawDecisions.ecli,
      identifiers: sql<string[]>`'{}'::text[]`,
      court: caseLawDecisions.court,
      country: caseLawDecisions.country,
      language: caseLawDecisions.language,
      decisionDate: caseLawDecisions.decisionDate,
      decisionType: caseLawDecisions.decisionType,
      citationAuthority: caseLawDecisions.citationAuthority,
      citationCount: caseLawDecisions.citationCount,
      textS3Key: caseLawDecisions.textS3Key,
      astS3Key: caseLawDecisions.astS3Key,
      contentHash: caseLawDecisions.contentHash,
      indexedHash: caseLawDecisions.indexedHash,
      indexedGeneration: caseLawDecisions.indexedGeneration,
      generationIndexId: sql<string | null>`null`,
      generationPendingAction: sql<"delete" | "index" | null>`null`,
      generationPendingIndexIds: sql<string[]>`'{}'::varchar(64)[]`,
      generationPendingRevision: sql<number>`0`,
      updatedAtToken: timestampCasToken(caseLawDecisions.updatedAt),
    })
    .from(caseLawDecisions)
    .where(sql`${caseLawDecisions.id} = ${id}`);
  if (!row) {
    throw new Error("row missing");
  }
  return row;
};

// SAFETY: the adapter only calls `execute` on the transaction, and pglite's
// drizzle instance provides that surface structurally — the same reasoning
// the ingestion pipeline tests rely on for their fakes.
// eslint-disable-next-line typescript/no-unsafe-type-assertion
const tx = () => db as unknown as Transaction;

test(
  "marks matching rows and refuses moved ones in one statement",
  async () => {
    const fresh = await loadRow(freshId);
    const moved = await loadRow(movedId);
    const regen = await loadRow(regenId);
    // Simulate a concurrent refresh landing after `moved` was selected:
    // its expected pre-state (indexedHash "hash-old") no longer matches.
    await db
      .update(caseLawDecisions)
      .set({ indexedHash: null })
      .where(sql`${caseLawDecisions.id} = ${movedId}`);

    const marked = await caseLawCorpusIndexAdapter.markIndexedBatch(tx(), {
      rows: [fresh, moved, regen],
      indexId: NEW_GENERATION,
      mode: { type: "incremental" },
      now: NOW,
    });

    expect(marked.has(freshId)).toBe(true);
    expect(marked.has(movedId)).toBe(false);
    expect(marked.has(regenId)).toBe(true);

    const freshAfter = await loadRow(freshId);
    expect(freshAfter.indexedGeneration).toBe(NEW_GENERATION);
    expect(freshAfter.indexedHash).toBe("hash-fresh");
    // Bookkeeping must not read as a content change: the trim scan and the
    // ingest refresh both compare-and-set on updated_at.
    expect(freshAfter.updatedAtToken).toBe(fresh.updatedAtToken);
    const movedAfter = await loadRow(movedId);
    expect(movedAfter.indexedGeneration).toBeNull();

    // Overlapping-build fixed point: a second worker that read `regen`
    // before the first mark (hash already current, generation still old)
    // must refuse rather than record another success, and the expected
    // generation is the only pre-state field that can catch it.
    const stale = await caseLawCorpusIndexAdapter.markIndexedBatch(tx(), {
      rows: [regen],
      indexId: NEW_GENERATION,
      mode: { type: "incremental" },
      now: NOW,
    });
    expect(stale.size).toBe(0);
    const regenAfter = await loadRow(regenId);
    expect(regenAfter.indexedGeneration).toBe(NEW_GENERATION);
  },
  { timeout: 30_000 },
);
