import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  legislationDocuments,
  legislationSources,
  statuteSitemapShards,
} from "@/api/db/schema";
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
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";
import {
  scaleTableToProfile,
  SYNTHETIC_SCALE_PROFILE,
} from "@/api/tests/query-plans/scale-profile";

const DB_TEST_TIMEOUT_MS = 120_000;
const WORK_COUNT = STATUTE_SITEMAP_SHARD_SPLIT_THRESHOLD + 100;
const LISTED_INDEX = "legislation_documents_sitemap_refresh_v2_idx";
const sourceId = createSafeId<"legislationSource">();

/**
 * A Work whose newest version was withdrawn under a new slug: the older,
 * still listed version keeps the Work in the sitemap under its own slug.
 */
const PARTLY_WITHDRAWN = {
  eli: "/eli/cz/sb/2026/partly-withdrawn",
  listedSlug: "partly-withdrawn-act",
  withdrawnSlug: "partly-withdrawn-act-renamed",
};
/** A Work the publisher no longer lists at all. */
const WITHDRAWN = {
  eli: "/eli/cz/sb/2026/withdrawn",
  slug: "withdrawn-act",
};

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let refreshDb: Parameters<typeof refreshStatuteSitemapShards>[0];
let legislationDb: LegislationReadDb;

const withdrawnVersion = {
  windowDisposition: "withdrawn",
  windowDispositionBasis: "publisher-unlisted",
} as const;

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
  const version = (
    eli: string,
    slug: string,
    versionValidFrom: string | null,
  ) => ({
    id: createSafeId<"legislationDocument">(),
    sourceId,
    eli,
    title: slug,
    slug,
    country: "CZE",
    language: "cs",
    versionValidFrom,
    updatedAt: new Date("2026-09-28T00:00:00.000Z"),
  });
  await db.insert(legislationDocuments).values([
    ...Array.from({ length: WORK_COUNT }, (_, index) =>
      version(`/eli/cz/sb/2026/${index + 1}`, `act-${index + 1}`, null),
    ),
    version(PARTLY_WITHDRAWN.eli, PARTLY_WITHDRAWN.listedSlug, "2020-01-01"),
    {
      ...version(
        PARTLY_WITHDRAWN.eli,
        PARTLY_WITHDRAWN.withdrawnSlug,
        "2024-01-01",
      ),
      ...withdrawnVersion,
    },
    {
      ...version(WITHDRAWN.eli, WITHDRAWN.slug, "2020-01-01"),
      ...withdrawnVersion,
    },
    {
      ...version(WITHDRAWN.eli, WITHDRAWN.slug, "2024-01-01"),
      ...withdrawnVersion,
    },
  ]);
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

const planLines = (explained: { rows: unknown[] }) =>
  explained.rows.map((row) => {
    const text = isRecord(row) ? row["QUERY PLAN"] : undefined;
    return typeof text === "string"
      ? text
      : panic("EXPLAIN row has no plan text");
  });

/**
 * The Work grouping's plan with its ordered, covering path forced: the seeded
 * table is small, so this proves the path exists rather than that it is
 * cheapest. A path that needs the heap for the withdrawn filter would show as
 * a plain index scan, and one with no usable index as a sequential scan.
 */
const explainWorkGrouping = async () => {
  const query = await refreshDb.transaction(async (tx) =>
    statuteWorksQuery(tx, []).toSQL(),
  );
  return await client.transaction(async (tx) => {
    await tx.query("SET LOCAL enable_seqscan = off");
    await tx.query("SET LOCAL enable_bitmapscan = off");
    await tx.query("SET LOCAL enable_sort = off");
    await tx.query("SET LOCAL enable_incremental_sort = off");
    await tx.query("SET LOCAL join_collapse_limit = 1");
    await tx.query("SET LOCAL seq_page_cost = 1000");
    await tx.query("SET LOCAL random_page_cost = 1000");
    const lines = planLines(
      await tx.query(`EXPLAIN (COSTS OFF) ${query.sql}`, [...query.params]),
    );
    const scans = scanOccurrences(
      explainRoot(
        await tx.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, [...query.params]),
      ),
    ).filter(({ relation }) => relation === "legislation_documents");
    return { lines, scans };
  });
};

const expectListedCoveringPath = async () => {
  const { lines, scans } = await explainWorkGrouping();
  const plan = lines.join("\n");
  expect(plan).toMatch(
    new RegExp(
      `Index Only Scan using ${LISTED_INDEX} on legislation_documents`,
      "u",
    ),
  );
  expect(scans.map(({ nodeType, index }) => ({ nodeType, index }))).toEqual([
    { nodeType: "Index Only Scan", index: LISTED_INDEX },
  ]);
  // The index predicate implies the withdrawn filter, so no row is rechecked.
  expect(scans[0]?.filter ?? "").not.toContain("window_disposition");
  expect(plan).not.toMatch(/Seq Scan on legislation_documents/u);
  expect(plan).not.toMatch(/hashed/iu);
};

test(
  "the listed-versions Work grouping reads its covering index alone",
  async () => {
    // Vacuum sets visibility bits so an index-only plan is available.
    await client.query("VACUUM ANALYZE legislation_documents");
    await expectListedCoveringPath();
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the Work grouping keeps its covering path at the synthetic table size",
  async () => {
    await scaleTableToProfile(
      db,
      "legislation_documents",
      SYNTHETIC_SCALE_PROFILE,
    );
    await expectListedCoveringPath();
  },
  DB_TEST_TIMEOUT_MS,
);

const servedSlugs = async () => {
  const listed = await listStatuteSitemapShardsHandler(legislationDb);
  if (!("items" in listed)) {
    return panic("Expected statute sitemap bucket shards.");
  }
  const served: string[] = [];
  for (const shard of listed.items) {
    // db-await-in-loop: each published bucket is independently read as a crawler would read it
    const page = await listStatuteSitemapStatutesHandler(shard, legislationDb);
    if (!("items" in page)) {
      return panic("Expected a listed statute bucket to be readable.");
    }
    served.push(...page.items.map(({ slug }) => slug));
  }
  const [counted] = await db
    .select({ total: sql<number>`sum(${statuteSitemapShards.total})::int` })
    .from(statuteSitemapShards);
  return { shards: listed.items, served, total: counted?.total };
};

test(
  "only versions the publisher still lists put a Work in the sitemap",
  async () => {
    await refreshStatuteSitemapShards(refreshDb);
    const { served, total } = await servedSlugs();

    // The fixture reaches the fault: the withdrawn slugs are stored rows.
    const stored = await db
      .select({ slug: legislationDocuments.slug })
      .from(legislationDocuments)
      .where(
        sql`${legislationDocuments.slug} IN (${WITHDRAWN.slug}, ${PARTLY_WITHDRAWN.withdrawnSlug})`,
      );
    expect(stored).toHaveLength(3);

    expect(served).toContain(PARTLY_WITHDRAWN.listedSlug);
    expect(served).not.toContain(PARTLY_WITHDRAWN.withdrawnSlug);
    expect(served).not.toContain(WITHDRAWN.slug);
    expect(served).toHaveLength(WORK_COUNT + 1);
    // The refresh counts the same Works the shards serve.
    expect(total).toBe(WORK_COUNT + 1);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the split snapshot matches served buckets and a refresh removes stale rows",
  async () => {
    expect(await refreshStatuteSitemapShards(refreshDb)).toMatchObject({
      shards: 64,
    });
    const { shards, served } = await servedSlugs();
    expect(shards).toHaveLength(64);
    expect(shards.every((shard) => shard.bucket !== "all")).toBe(true);
    expect(new Set(served).size).toBe(served.length);
    expect(served).toHaveLength(WORK_COUNT + 1);

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
