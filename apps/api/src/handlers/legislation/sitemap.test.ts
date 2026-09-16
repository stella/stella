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
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

// The sitemap addresses Works, not rows: a Work's consolidations share one
// slug and one URL, and only the published ones (a slug the backfill minted,
// a source cleared for redistribution) may appear at all.

let client: Awaited<ReturnType<typeof createTestPglite>>;
let legislationDb: LegislationReadDb;

const openSourceId = createSafeId<"legislationSource">();
const closedSourceId = createSafeId<"legislationSource">();

const CIVIL_CODE_SLUG = "89-2012-sb-obcansky-zakonik";
const REPAIRED_TITLE_OLD_SLUG = "500-2004-sb-spravni-rad-oprava";
const REPAIRED_TITLE_SLUG = "500-2004-sb-spravni-rad";
const LABOUR_CODE_SLUG = "262-2006-sb-zakonik-prace";
const SLOVAK_CIVIL_CODE_SLUG = "40-1964-zz-obciansky-zakonnik";
const WITHHELD_SLUG = "111-1999-sb-withheld-act";

const BUCKET_COUNT = 64;
const allBuckets = Array.from({ length: BUCKET_COUNT }, (_, bucket) =>
  String(bucket).padStart(2, "0"),
);

const listStatutes = async (country: string, bucket?: string) => {
  const page = await listStatuteSitemapStatutesHandler(
    bucket === undefined ? { country } : { country, bucket },
    legislationDb,
  );
  if (!("items" in page)) {
    return panic("Expected a statute sitemap shard page.");
  }

  return page.items;
};

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    await db.execute(sql.raw("SET TIME ZONE 'UTC'"));

    await db.insert(legislationSources).values([
      { id: openSourceId, adapterKey: "statutes-open", name: "Open source" },
      {
        id: closedSourceId,
        adapterKey: "statutes-closed",
        name: "Withheld source",
        descriptor: {
          license: "restricted",
          attribution: null,
          allowsRedistribution: false,
          allowsDerivedAi: false,
        },
      },
    ]);

    await db.insert(legislationDocuments).values([
      // One Work, three consolidations: one URL, and the newest row's
      // timestamp is the one the sitemap reports.
      {
        id: createSafeId<"legislationDocument">(),
        sourceId: openSourceId,
        eli: "/eli/cz/sb/2012/89",
        title: "89/2012 Sb., občanský zákoník",
        slug: CIVIL_CODE_SLUG,
        country: "CZE",
        language: "cs",
        versionValidFrom: "2014-01-01",
        versionValidTo: "2020-12-31",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: createSafeId<"legislationDocument">(),
        sourceId: openSourceId,
        eli: "/eli/cz/sb/2012/89",
        title: "89/2012 Sb., občanský zákoník",
        slug: CIVIL_CODE_SLUG,
        country: "CZE",
        language: "cs",
        versionValidFrom: "2021-01-01",
        versionValidTo: null,
        updatedAt: new Date("2026-03-04T12:00:00.000Z"),
      },
      {
        id: createSafeId<"legislationDocument">(),
        sourceId: openSourceId,
        eli: "/eli/cz/sb/2006/262",
        title: "262/2006 Sb., zákoník práce",
        slug: LABOUR_CODE_SLUG,
        country: "CZE",
        language: "cs",
        versionValidFrom: "2024-01-01",
        versionValidTo: null,
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      },
      // A title repair between consolidations: ingestion derived a new slug
      // for the newer one, so this Work answers to both segments.
      {
        id: createSafeId<"legislationDocument">(),
        sourceId: openSourceId,
        eli: "/eli/cz/sb/2004/500",
        title: "500/2004 Sb., správní řád (oprava)",
        slug: REPAIRED_TITLE_OLD_SLUG,
        country: "CZE",
        language: "cs",
        versionValidFrom: "2006-01-01",
        versionValidTo: "2023-12-31",
        updatedAt: new Date("2026-01-20T00:00:00.000Z"),
      },
      {
        id: createSafeId<"legislationDocument">(),
        sourceId: openSourceId,
        eli: "/eli/cz/sb/2004/500",
        title: "500/2004 Sb., správní řád",
        slug: REPAIRED_TITLE_SLUG,
        country: "CZE",
        language: "cs",
        versionValidFrom: "2024-01-01",
        versionValidTo: null,
        updatedAt: new Date("2026-02-20T00:00:00.000Z"),
      },
      // No citation tail in the ELI, so no slug: reachable by id, never
      // indexed.
      {
        id: createSafeId<"legislationDocument">(),
        sourceId: openSourceId,
        eli: "/eli/cz/nalezy/pl-us-1",
        title: "Unslugged act",
        slug: null,
        country: "CZE",
        language: "cs",
        versionValidFrom: "2019-01-01",
        versionValidTo: null,
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: createSafeId<"legislationDocument">(),
        sourceId: openSourceId,
        eli: "/eli/sk/zz/1964/40",
        title: "Občiansky zákonník",
        slug: SLOVAK_CIVIL_CODE_SLUG,
        country: "SVK",
        language: "sk",
        versionValidFrom: "2023-01-01",
        versionValidTo: null,
        updatedAt: new Date("2026-01-15T00:00:00.000Z"),
      },
      // A source that is not cleared for redistribution.
      {
        id: createSafeId<"legislationDocument">(),
        sourceId: closedSourceId,
        eli: "/eli/cz/sb/1999/111",
        title: "Withheld Act",
        slug: WITHHELD_SLUG,
        country: "CZE",
        language: "cs",
        versionValidFrom: "2000-01-01",
        versionValidTo: null,
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);

    const readDb = async <T>(
      fn: (tx: LegislationReadTransaction) => Promise<T>,
    ): Promise<T> =>
      await withPublicLawReaderRole(
        db,
        async (tx) =>
          // SAFETY: this PGlite transaction executes under the production
          // public-law role and exposes the same read surface to the callback.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded role transaction stands in for LegislationReadTransaction
          await fn(tx as unknown as LegislationReadTransaction),
      );
    legislationDb = readDb;
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("a shard emits one URL per Work, stamped with its newest consolidation", async () => {
  const items = await listStatutes("cze");

  expect(items).toEqual([
    { country: "CZE", slug: LABOUR_CODE_SLUG, lastmod: "2026-02-02" },
    { country: "CZE", slug: REPAIRED_TITLE_SLUG, lastmod: "2026-02-20" },
    { country: "CZE", slug: CIVIL_CODE_SLUG, lastmod: "2026-03-04" },
  ]);
});

test("a repaired title lists only the slug its latest consolidation minted", async () => {
  const slugs = (await listStatutes("cze")).map((item) => item.slug);

  // The older segment still resolves, and the page it reaches is canonical
  // at the newer one, so only the newer one belongs in the index.
  expect(slugs).not.toContain(REPAIRED_TITLE_OLD_SLUG);
});

test("a shard omits statutes with no slug and sources that withhold redistribution", async () => {
  const slugs = (await listStatutes("cze")).map((item) => item.slug);

  expect(slugs).not.toContain(WITHHELD_SLUG);
  expect(slugs).toHaveLength(3);
});

// The bucket is hashed on the ELI, which every consolidation of a Work
// shares, so a Work cannot straddle two shards even when its slug changed.
test("the buckets partition a jurisdiction's Works exactly once", async () => {
  const bucketed = await Promise.all(
    allBuckets.map(async (bucket) => await listStatutes("cze", bucket)),
  );
  const bucketedSlugs = bucketed.flat().map((item) => item.slug);
  const allSlugs = (await listStatutes("cze")).map((item) => item.slug);

  expect(bucketedSlugs.toSorted()).toEqual(allSlugs.toSorted());
  expect(new Set(bucketedSlugs).size).toBe(bucketedSlugs.length);
});

test("the shard index lists one all-bucket shard per jurisdiction", async () => {
  const shards = await listStatuteSitemapShardsHandler(legislationDb);
  if (!("items" in shards)) {
    panic("Expected a statute sitemap shard index.");
  }

  expect(shards.items).toEqual([
    { bucket: "all", country: "cze", lastmod: "2026-03-04" },
  ]);
});

test("a stored statute in an unpublished jurisdiction has no sitemap entry", async () => {
  expect(await listStatutes("svk")).toEqual([]);
});
