import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api-postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import * as schema from "@/api/db/schema";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { caseLawCorpusIndexAdapter } from "@/api/handlers/case-law/corpus-index";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createSchemaPglite,
  installPgliteSchemaPrerequisites,
} from "@/api/tests/pglite-schema";

// The batched mark rewrites hundreds of per-row compare-and-set updates
// into one VALUES join. The batching must not weaken the per-row CAS:
// a row whose expected pre-state no longer matches (concurrent refresh)
// stays unmarked while its batch-mates commit — and NULL expected hashes
// (a first-time index) must compare via IS NOT DISTINCT FROM, which is
// exactly the shape a serializer-level test cannot prove.

const allSchema = { ...schema, ...authSchema, ...rlsExports };
const NOW = new Date("2026-07-28T12:00:00.000Z");

let client: Awaited<ReturnType<typeof createSchemaPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const freshId = createSafeId<"caseLawDecision">();
const movedId = createSafeId<"caseLawDecision">();

beforeAll(
  async () => {
    client = await createSchemaPglite();
    db = drizzle({ client });
    await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
    await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
    await installPgliteSchemaPrerequisites(db);
    const { sqlStatements } = await pushSchema(allSchema, db);
    for (const statement of sqlStatements) {
      // oxlint-disable-next-line no-await-in-loop -- DDL statements must apply in emitted order (deterministic test schema setup)
      await db.execute(sql.raw(statement));
    }

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
    ]);
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
      country: caseLawDecisions.country,
      textS3Key: caseLawDecisions.textS3Key,
      astS3Key: caseLawDecisions.astS3Key,
      contentHash: caseLawDecisions.contentHash,
      indexedHash: caseLawDecisions.indexedHash,
      indexedGeneration: caseLawDecisions.indexedGeneration,
      updatedAt: caseLawDecisions.updatedAt,
    })
    .from(caseLawDecisions)
    .where(sql`${caseLawDecisions.id} = ${id}`);
  if (!row) {
    throw new Error("row missing");
  }
  return row;
};

test(
  "marks matching rows and refuses moved ones in one statement",
  async () => {
    const fresh = await loadRow(freshId);
    const moved = await loadRow(movedId);
    // Simulate a concurrent refresh landing after `moved` was selected:
    // its expected pre-state (indexedHash "hash-old") no longer matches.
    await db
      .update(caseLawDecisions)
      .set({ indexedHash: null })
      .where(sql`${caseLawDecisions.id} = ${movedId}`);

    const marked = await caseLawCorpusIndexAdapter.markIndexedBatch(
      // SAFETY: the adapter only calls `execute` on the transaction, and
      // pglite's drizzle instance provides that surface structurally —
      // the same reasoning the citation-authority pglite test relies on.
      db as unknown as Transaction,
      {
        rows: [fresh, moved],
        indexId: "case_law_v2_cze",
        now: NOW,
      },
    );

    expect(marked.has(freshId)).toBe(true);
    expect(marked.has(movedId)).toBe(false);

    const freshAfter = await loadRow(freshId);
    expect(freshAfter.indexedGeneration).toBe("case_law_v2_cze");
    expect(freshAfter.indexedHash).toBe("hash-fresh");
    const movedAfter = await loadRow(movedId);
    expect(movedAfter.indexedGeneration).toBeNull();
  },
  { timeout: 30_000 },
);
