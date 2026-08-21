import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  legislationDocuments,
  legislationSearchDocuments,
  legislationSources,
} from "@/api/db/schema";
import {
  backfillLegislationSearchIndex,
  indexLegislationDocument,
} from "@/api/handlers/legislation/search-index";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import { packKey } from "@/api/lib/legal-search/corpus-pack";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import { createTestPglite } from "@/api/tests/pglite-test-db";

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";

const { searchLegislationHandler } =
  await import("@/api/handlers/legislation/search");

const searchDependencies = {
  loadSearchConfigs: async () => [
    {
      regconfig: "simple",
      useUnaccent: false,
      includeDefault: true,
      languages: [],
    },
  ],
} satisfies NonNullable<Parameters<typeof searchLegislationHandler>[2]>;

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"legislationSource">();
const fulltextId = createSafeId<"legislationDocument">();
const sectionsId = createSafeId<"legislationDocument">();
const corpusId = createSafeId<"legislationDocument">();
const unavailableCorpusId = brandPersistedLegislationDocumentId(
  "0198cb55-8e8b-7b95-83bf-c9e219c70001",
);
const laterCorpusId = brandPersistedLegislationDocumentId(
  "0198cb55-8e8b-7b95-83bf-c9e219c70002",
);
const firstStaleCorpusId = brandPersistedLegislationDocumentId(
  "0198cb55-8e8b-7b95-83bf-c9e219c70003",
);
const laterStaleCorpusId = brandPersistedLegislationDocumentId(
  "0198cb55-8e8b-7b95-83bf-c9e219c70004",
);
const corpusKey = formatCorpusLocation({
  type: "packed",
  packKey: packKey({
    jurisdiction: "CZE",
    packId: "0198cb55-8e8b-7b95-83bf-c9e219c70db2",
  }),
  offset: 4096,
  length: 512,
});

const scopedDb: Parameters<typeof indexLegislationDocument>[1] = async (
  callback,
) =>
  // SAFETY: pglite stands in for the transaction used by this projection;
  // the test exercises only the statements issued by the callback.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test transaction shim
  await callback(db as unknown as Transaction);

const searchScopedDb: ScopedDb = async (callback) => {
  const tx = new Proxy(db, {
    get: (target, property, receiver) => {
      if (property !== "execute") {
        return Reflect.get(target, property, receiver);
      }
      return async (...args: Parameters<typeof db.execute>) =>
        (await db.execute(...args)).rows;
    },
  });
  // SAFETY: the proxy preserves the PGlite DB and adapts only execute's result
  // shape to match the production driver used by this search boundary.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test transaction shim
  return await callback(tx as unknown as Transaction);
};

const seedDocument = ({
  id,
  fulltext,
  sections,
  textS3Key,
  createdAt,
  updatedAt,
}: {
  id: SafeId<"legislationDocument">;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  textS3Key: string;
  createdAt?: Date;
  updatedAt?: Date;
}) => ({
  id,
  sourceId,
  eli: `CZ/2026/${id}`,
  title: "Corpus reader search fixture",
  country: "CZE",
  language: "cs",
  fulltext,
  sections,
  textS3Key,
  createdAt,
  updatedAt,
});

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.execute(
      sql`CREATE FUNCTION public.unaccent(input text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS 'SELECT input'`,
    );
    await db.execute(
      sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
    );

    await db.insert(legislationSources).values({
      id: sourceId,
      adapterKey: "fts-canonical-corpus",
      name: "FTS canonical corpus fixture",
    });
    await db.insert(legislationDocuments).values([
      seedDocument({
        id: fulltextId,
        fulltext: "inline fulltext sentinel",
        sections: null,
        textS3Key: "legal-corpus/documents/fulltext/text.zst",
      }),
      seedDocument({
        id: sectionsId,
        fulltext: null,
        sections: [
          {
            index: 0,
            type: "unknown",
            title: null,
            text: "inline sections sentinel",
          },
        ],
        textS3Key: "legal-corpus/documents/sections/text.zst",
      }),
      seedDocument({
        id: corpusId,
        fulltext: null,
        sections: null,
        textS3Key: corpusKey,
      }),
      seedDocument({
        id: laterCorpusId,
        fulltext: null,
        sections: null,
        textS3Key: "legal-corpus/documents/later/text.zst",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      seedDocument({
        id: unavailableCorpusId,
        fulltext: null,
        sections: null,
        textS3Key: "legal-corpus/documents/unavailable/text.zst",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ]);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  if (client !== undefined) {
    await client.close();
  }
});

test("the FTS rebuild reads canonical text only when inline payloads are absent", async () => {
  const readKeys: string[] = [];
  const dependencies: Parameters<typeof indexLegislationDocument>[2] = {
    readText: async (storedKey) => {
      readKeys.push(storedKey);
      return "canonical corpus sentinel";
    },
    resolveConfig: async () => ({ regconfig: "simple", useUnaccent: false }),
  };

  await indexLegislationDocument(fulltextId, scopedDb, dependencies);
  await indexLegislationDocument(sectionsId, scopedDb, dependencies);
  await indexLegislationDocument(corpusId, scopedDb, dependencies);

  expect(readKeys).toEqual([corpusKey]);

  const rows = await db
    .select({
      documentId: legislationSearchDocuments.documentId,
      searchableText: legislationSearchDocuments.searchableText,
    })
    .from(legislationSearchDocuments);
  const searchableTextById = new Map(
    rows.map((row) => [row.documentId, row.searchableText]),
  );
  expect(searchableTextById.get(fulltextId)).toContain(
    "inline fulltext sentinel",
  );
  expect(searchableTextById.get(sectionsId)).toContain(
    "inline sections sentinel",
  );
  expect(searchableTextById.get(corpusId)).toContain(
    "canonical corpus sentinel",
  );

  const match = (
    await db
      .select({
        matches: sql<boolean>`${legislationSearchDocuments.tsv} @@ plainto_tsquery('simple', 'canonical corpus sentinel')`,
      })
      .from(legislationSearchDocuments)
      .where(eq(legislationSearchDocuments.documentId, corpusId))
  ).at(0);
  expect(match?.matches).toBe(true);
});

test("an unreadable corpus row does not block the bounded missing scan", async () => {
  const unavailableKey = "legal-corpus/documents/unavailable/text.zst";
  const laterKey = "legal-corpus/documents/later/text.zst";
  const readKeys: string[] = [];
  let unavailableAttempts = 0;
  const dependencies: Parameters<typeof backfillLegislationSearchIndex>[2] = {
    readText: async (storedKey) => {
      readKeys.push(storedKey);
      if (storedKey === unavailableKey) {
        unavailableAttempts += 1;
        if (unavailableAttempts === 1) {
          throw new Error("unavailable corpus fixture");
        }
        return "repaired corpus sentinel";
      }
      return "later corpus sentinel";
    },
    resolveConfig: async () => ({ regconfig: "simple", useUnaccent: false }),
  };
  await indexLegislationDocument(fulltextId, scopedDb, dependencies);
  await indexLegislationDocument(sectionsId, scopedDb, dependencies);
  await indexLegislationDocument(corpusId, scopedDb, dependencies);
  readKeys.length = 0;

  expect(
    await backfillLegislationSearchIndex(scopedDb, 1, dependencies),
  ).toEqual({ found: 1, indexed: 0 });
  expect(
    await backfillLegislationSearchIndex(scopedDb, 1, dependencies),
  ).toEqual({ found: 1, indexed: 1 });
  expect(readKeys).toEqual([unavailableKey, laterKey]);
  expect(unavailableCorpusId < laterCorpusId).toBe(true);

  const failedProjection = (
    await db
      .select({
        searchableText: legislationSearchDocuments.searchableText,
        retryAfter: legislationSearchDocuments.retryAfter,
      })
      .from(legislationSearchDocuments)
      .where(eq(legislationSearchDocuments.documentId, unavailableCorpusId))
  ).at(0);
  expect(failedProjection?.searchableText).not.toContain("corpus sentinel");
  expect(failedProjection?.retryAfter).not.toBeNull();
  await db
    .update(legislationSearchDocuments)
    .set({
      searchableText: "retry pending sentinel",
      tsv: sql`to_tsvector('simple', 'retry pending sentinel')`,
    })
    .where(eq(legislationSearchDocuments.documentId, unavailableCorpusId));
  expect(
    await searchLegislationHandler(
      { query: "retry pending sentinel" },
      searchScopedDb,
      searchDependencies,
    ),
  ).toMatchObject({ hits: [] });

  await db
    .update(legislationSearchDocuments)
    .set({ retryAfter: new Date("2025-01-01T00:00:00.000Z") })
    .where(eq(legislationSearchDocuments.documentId, unavailableCorpusId));
  expect(
    await backfillLegislationSearchIndex(scopedDb, 1, dependencies),
  ).toEqual({ found: 1, indexed: 1 });
  expect(readKeys).toEqual([unavailableKey, laterKey, unavailableKey]);

  const repaired = (
    await db
      .select({
        searchableText: legislationSearchDocuments.searchableText,
        retryAfter: legislationSearchDocuments.retryAfter,
      })
      .from(legislationSearchDocuments)
      .where(eq(legislationSearchDocuments.documentId, unavailableCorpusId))
  ).at(0);
  expect(repaired?.searchableText).toContain("repaired corpus sentinel");
  expect(repaired?.retryAfter).toBeNull();
  expect(
    await searchLegislationHandler(
      { query: "repaired corpus sentinel" },
      searchScopedDb,
      searchDependencies,
    ),
  ).toMatchObject({ hits: [{ documentId: unavailableCorpusId }] });
});

test("the stale scan breaks equal update timestamps by document id", async () => {
  const firstKey = "legal-corpus/documents/stale-first/text.zst";
  const laterKey = "legal-corpus/documents/stale-later/text.zst";
  await db.insert(legislationDocuments).values([
    seedDocument({
      id: laterStaleCorpusId,
      fulltext: null,
      sections: null,
      textS3Key: laterKey,
    }),
    seedDocument({
      id: firstStaleCorpusId,
      fulltext: null,
      sections: null,
      textS3Key: firstKey,
    }),
  ]);

  const readKeys: string[] = [];
  const dependencies: Parameters<typeof backfillLegislationSearchIndex>[2] = {
    readText: async (storedKey) => {
      readKeys.push(storedKey);
      return "stale corpus sentinel";
    },
    resolveConfig: async () => ({ regconfig: "simple", useUnaccent: false }),
  };
  await indexLegislationDocument(fulltextId, scopedDb, dependencies);
  await indexLegislationDocument(sectionsId, scopedDb, dependencies);
  await indexLegislationDocument(corpusId, scopedDb, dependencies);
  await indexLegislationDocument(unavailableCorpusId, scopedDb, dependencies);
  await indexLegislationDocument(laterCorpusId, scopedDb, dependencies);
  await indexLegislationDocument(laterStaleCorpusId, scopedDb, dependencies);
  await indexLegislationDocument(firstStaleCorpusId, scopedDb, dependencies);
  readKeys.length = 0;

  const staleAt = new Date("2027-01-01T00:00:00.000Z");
  await db
    .update(legislationDocuments)
    .set({ updatedAt: staleAt })
    .where(
      sql`${legislationDocuments.id} IN (${firstStaleCorpusId}, ${laterStaleCorpusId})`,
    );

  expect(
    await backfillLegislationSearchIndex(scopedDb, 1, dependencies),
  ).toEqual({ found: 1, indexed: 1 });
  expect(firstStaleCorpusId < laterStaleCorpusId).toBe(true);
  expect(readKeys).toEqual([firstKey]);
});
