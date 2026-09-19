import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { SEARCH_TOTAL_NOT_COUNTED } from "@stll/api-contract/search";

import type { Transaction } from "@/api/db/root";
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
import {
  packKeyForMembers,
  corpusMemberDigest,
} from "@/api/lib/legal-search/corpus-pack";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { logger } from "@/api/lib/observability/logger";
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
const memberDigest = corpusMemberDigest(
  new TextEncoder().encode("canonical corpus sentinel"),
);
const corpusKey = formatCorpusLocation({
  type: "packed",
  packKey: packKeyForMembers({
    jurisdiction: "CZE",
    members: [
      {
        documentId: "legislation-corpus-sentinel",
        kind: "text",
        sha256: memberDigest,
        length: 512,
      },
    ],
  }),
  offset: 4096,
  length: 512,
  sha256: memberDigest,
});

const scopedDb: Parameters<typeof indexLegislationDocument>[1] = async (
  callback,
) =>
  // SAFETY: pglite stands in for the transaction used by this projection;
  // the test exercises only the statements issued by the callback.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test transaction shim
  await callback(db as unknown as Transaction);

const searchReadDb: LegislationReadDb = async (callback) => {
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
  return await callback(tx as unknown as LegislationReadTransaction);
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
      searchReadDb,
      searchDependencies,
    ),
  ).toMatchObject({ items: [], total: SEARCH_TOTAL_NOT_COUNTED });

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
      searchReadDb,
      searchDependencies,
    ),
  ).toMatchObject({
    items: [{ documentId: unavailableCorpusId }],
    total: SEARCH_TOTAL_NOT_COUNTED,
  });
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

test("a failed projection names the error class in its log fields", async () => {
  const unprojectableId = createSafeId<"legislationDocument">();
  await db.insert(legislationDocuments).values(
    seedDocument({
      id: unprojectableId,
      fulltext: "unprojectable fixture",
      sections: null,
      textS3Key: corpusKey,
    }),
  );

  const errorSpy = spyOn(logger, "error");
  try {
    expect(
      await backfillLegislationSearchIndex(scopedDb, 1, {
        readText: async () => "unused corpus sentinel",
        resolveConfig: async () => {
          throw new TypeError("fts configuration unavailable");
        },
      }),
    ).toEqual({ found: 1, indexed: 0 });

    const failure = errorSpy.mock.calls.find(
      ([signature]) => signature === "legislation.search_index.backfill_failed",
    );
    expect(failure?.[1]).toMatchObject({
      documentId: unprojectableId,
      "error.type": "TypeError",
    });
  } finally {
    errorSpy.mockRestore();
  }
});

test("a document whose text outgrows the tsvector ceiling is still indexed", async () => {
  const oversizedId = brandPersistedLegislationDocumentId(
    "0198cb55-8e8b-7b95-83bf-c9e219c70005",
  );
  // Postgres stores a lexeme once, so ordinary prose projects into a fraction
  // of its own size however long the statute is. Tokens that are all distinct
  // are what reaches the 1 MiB ceiling: an identifier table, a schedule of
  // references, a numbered list of provisions.
  const distinctTokens: string[] = [];
  for (let index = 0; index < 90_000; index += 1) {
    distinctTokens.push(`ustanoveni${index.toString(36)}`);
  }
  const fulltext = distinctTokens.join(" ");

  await db.insert(legislationDocuments).values(
    seedDocument({
      id: oversizedId,
      fulltext,
      sections: null,
      textS3Key: "legal-corpus/documents/oversized/text.zst",
      // Sorts ahead of every other fixture in the backfill's missing scan.
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    }),
  );

  expect(
    await backfillLegislationSearchIndex(scopedDb, 1, {
      readText: async () => "unused corpus sentinel",
      resolveConfig: async () => ({ regconfig: "simple", useUnaccent: false }),
    }),
  ).toEqual({ found: 1, indexed: 1 });

  const projection = (
    await db
      .select({
        searchableText: legislationSearchDocuments.searchableText,
        retryAfter: legislationSearchDocuments.retryAfter,
        matches: sql<boolean>`${legislationSearchDocuments.tsv} @@ plainto_tsquery('simple', 'ustanoveni0')`,
      })
      .from(legislationSearchDocuments)
      .where(eq(legislationSearchDocuments.documentId, oversizedId))
  ).at(0);

  // The row is what takes the document out of the missing scan, so writing a
  // bounded projection is what stops the scan reselecting it on every pass.
  expect(projection?.matches).toBe(true);
  expect(projection?.retryAfter).toBeNull();
  expect(projection?.searchableText.length).toBeLessThan(fulltext.length);
}, 30_000);
