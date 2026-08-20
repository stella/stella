import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  legislationDocuments,
  legislationSearchDocuments,
  legislationSources,
} from "@/api/db/schema";
import {
  backfillLegislationSearchIndex,
  indexLegislationDocument,
  removeLegislationFromIndex,
} from "@/api/handlers/legislation/search-index";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import { packKey } from "@/api/lib/legal-search/corpus-pack";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"legislationSource">();
const fulltextId = createSafeId<"legislationDocument">();
const sectionsId = createSafeId<"legislationDocument">();
const corpusId = createSafeId<"legislationDocument">();
const unavailableCorpusId = createSafeId<"legislationDocument">();
const laterCorpusId = createSafeId<"legislationDocument">();
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
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
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

  const [match] = await db
    .select({
      matches: sql<boolean>`${legislationSearchDocuments.tsv} @@ plainto_tsquery('simple', 'canonical corpus sentinel')`,
    })
    .from(legislationSearchDocuments)
    .where(eq(legislationSearchDocuments.documentId, corpusId));
  expect(match?.matches).toBe(true);
});

test("an unreadable corpus row does not block the bounded missing scan", async () => {
  const unavailableKey = "legal-corpus/documents/unavailable/text.zst";
  const laterKey = "legal-corpus/documents/later/text.zst";
  const readKeys: string[] = [];
  const dependencies: Parameters<typeof backfillLegislationSearchIndex>[2] = {
    readText: async (storedKey) => {
      readKeys.push(storedKey);
      if (storedKey === unavailableKey) {
        throw new Error("unavailable corpus fixture");
      }
      return "later corpus sentinel";
    },
    resolveConfig: async () => ({ regconfig: "simple", useUnaccent: false }),
  };

  expect(
    await backfillLegislationSearchIndex(scopedDb, 1, dependencies),
  ).toEqual({ found: 1, indexed: 0 });
  expect(
    await backfillLegislationSearchIndex(scopedDb, 1, dependencies),
  ).toEqual({ found: 1, indexed: 1 });
  expect(readKeys).toEqual([unavailableKey, laterKey]);

  const projected = await db
    .select({
      documentId: legislationSearchDocuments.documentId,
      searchableText: legislationSearchDocuments.searchableText,
    })
    .from(legislationSearchDocuments)
    .where(eq(legislationSearchDocuments.documentId, unavailableCorpusId));
  expect(projected.at(0)?.searchableText).not.toContain(
    "later corpus sentinel",
  );

  await removeLegislationFromIndex(unavailableCorpusId, scopedDb);
  await backfillLegislationSearchIndex(scopedDb, 1, {
    readText: async () => "repaired corpus sentinel",
    resolveConfig: dependencies.resolveConfig,
  });

  const [repaired] = await db
    .select({ searchableText: legislationSearchDocuments.searchableText })
    .from(legislationSearchDocuments)
    .where(eq(legislationSearchDocuments.documentId, unavailableCorpusId));
  expect(repaired?.searchableText).toContain("repaired corpus sentinel");
});
