import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import {
  listStatuteSitemapShardsHandler,
  listStatuteSitemapStatutesHandler,
} from "@/api/handlers/legislation/sitemap";
import { createSafeId } from "@/api/lib/branded-types";
import {
  refreshStatuteSitemapShards,
  STATUTE_SITEMAP_SHARD_SPLIT_THRESHOLD,
} from "@/api/lib/legal-search/statute-sitemap-shard-refresh";
import { statuteWorksQuery } from "@/api/lib/legal-search/statute-sitemap-shard-sql";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { isRecord } from "@/api/lib/type-guards";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const DB_TEST_TIMEOUT_MS = 120_000;
const WORK_COUNT = STATUTE_SITEMAP_SHARD_SPLIT_THRESHOLD + 100;
const sourceId = createSafeId<"legislationSource">();

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let refreshDb: Parameters<typeof refreshStatuteSitemapShards>[0];
let legislationDb: LegislationReadDb;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  // SAFETY: the PGlite handle implements the root select and transaction
  // surface the refresh uses.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded test database stands in for the root pool
  refreshDb = db as unknown as typeof refreshDb;
  legislationDb = async (read) =>
    await withPublicLawReaderRole(
      db,
      async (tx) =>
        // SAFETY: the role transaction exposes the production read surface.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded role transaction stands in for the public reader
        await read(tx as unknown as LegislationReadTransaction),
    );

  await db.insert(legislationSources).values({
    id: sourceId,
    adapterKey: "sitemap-refresh-test",
    name: "Sitemap refresh test",
  });
  await db.insert(legislationDocuments).values(
    Array.from({ length: WORK_COUNT }, (_, index) => ({
      id: createSafeId<"legislationDocument">(),
      sourceId,
      eli: `/eli/cz/sb/2026/${index + 1}`,
      title: `Act ${index + 1}`,
      slug: `act-${index + 1}`,
      country: "CZE",
      language: "cs",
      updatedAt: new Date("2026-09-28T00:00:00.000Z"),
    })),
  );
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

test(
  "the Work grouping can read the covering refresh index alone",
  async () => {
    // Vacuum sets visibility bits so an index-only plan is available.
    await client.query("VACUUM ANALYZE legislation_documents");
    const query = await refreshDb.transaction(async (tx) =>
      statuteWorksQuery(tx, []).toSQL(),
    );
    const plan = await client.transaction(async (tx) => {
      // The seeded table is small; force its ordered, covering path to prove
      // that the refresh can group Works without reading document rows.
      await tx.query("SET LOCAL enable_seqscan = off");
      await tx.query("SET LOCAL enable_bitmapscan = off");
      await tx.query("SET LOCAL enable_sort = off");
      await tx.query("SET LOCAL enable_incremental_sort = off");
      await tx.query("SET LOCAL join_collapse_limit = 1");
      await tx.query("SET LOCAL seq_page_cost = 1000");
      await tx.query("SET LOCAL random_page_cost = 1000");
      const explained = await tx.query(`EXPLAIN (COSTS OFF) ${query.sql}`, [
        ...query.params,
      ]);
      return explained.rows.map((row) => {
        const text = isRecord(row) ? row["QUERY PLAN"] : undefined;
        return typeof text === "string"
          ? text
          : panic("EXPLAIN row has no plan text");
      });
    });
    expect(plan.join("\n")).toMatch(
      /Index Only Scan using legislation_documents_sitemap_refresh_idx on legislation_documents/u,
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the split snapshot matches served buckets and a refresh removes stale rows",
  async () => {
    expect(await refreshStatuteSitemapShards(refreshDb)).toMatchObject({
      shards: 64,
    });
    const listed = await listStatuteSitemapShardsHandler(legislationDb);
    if (!("items" in listed)) {
      panic("Expected statute sitemap bucket shards.");
    }
    expect(listed.items).toHaveLength(64);
    expect(listed.items.every((shard) => shard.bucket !== "all")).toBe(true);

    const served = new Set<string>();
    for (const shard of listed.items) {
      // db-await-in-loop: each published bucket is independently read as a crawler would read it
      const page = await listStatuteSitemapStatutesHandler(
        shard,
        legislationDb,
      );
      if (!("items" in page)) {
        panic("Expected a listed statute bucket to be readable.");
      }
      for (const item of page.items) {
        expect(served.has(item.slug)).toBe(false);
        served.add(item.slug);
      }
    }
    expect(served.size).toBe(WORK_COUNT);

    await db
      .delete(legislationDocuments)
      .where(sql`${legislationDocuments.sourceId} = ${sourceId}`);
    expect(await refreshStatuteSitemapShards(refreshDb)).toMatchObject({
      shards: 0,
    });
    expect(await listStatuteSitemapShardsHandler(legislationDb)).toMatchObject({
      items: [],
    });
  },
  DB_TEST_TIMEOUT_MS,
);
