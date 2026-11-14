import type { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSearchDocuments,
  legislationSources,
} from "@/api/db/schema";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import { listStatutesHandler } from "@/api/handlers/legislation/list";
import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { listStatuteVersionsHandler } from "@/api/handlers/legislation/versions";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * A version's `current` / `historical` status is read from its window on
 * today's date, never from the value stamped when it was ingested: a
 * consolidation stored before it took effect is `current` once it does, and
 * its predecessor `historical`. Publisher statements (`repealed`, `draft`)
 * and a version with no window keep their stored value.
 */

const GENERATION = "legislation_v2";
const INDEX_ID = corpusIndexId(GENERATION, "CZE");
const FINGERPRINT = "a".repeat(64);
const TERM = "stavovyfixture";

/** A calendar date `days` from today (UTC), as the date columns store it. */
const daysFromToday = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const today = daysFromToday(0);

type Seed = {
  id: SafeId<"legislationDocument">;
  eli: string;
  stored: string;
  validFrom: string | null;
  validTo: string | null;
  /** The status every read must show today. */
  expected: string;
};

const seed = (
  eli: string,
  stored: string,
  [validFrom, validTo]: [string | null, string | null],
  expected: string,
): Seed => ({
  id: createSafeId<"legislationDocument">(),
  eli,
  stored,
  validFrom,
  validTo,
  expected,
});

const WORK = "https://example.test/eli/cz/sb/1961/135";
/** Stamped `current` at ingest; its successor opens today and closes it. */
const predecessor = seed(WORK, "current", ["2015-01-01", today], "historical");
/** Stamped `historical` at ingest, before its window opened today. */
const successor = seed(
  WORK,
  "historical",
  [today, daysFromToday(30)],
  "current",
);
/** Stamped `current`, but its window has not opened yet. */
const upcoming = seed(WORK, "current", [daysFromToday(30), null], "historical");
const repealed = seed(
  "https://example.test/eli/cz/sb/1990/1",
  "repealed",
  ["2000-01-01", null],
  "repealed",
);
const draft = seed(
  "https://example.test/eli/cz/sb/1990/2",
  "draft",
  ["2000-01-01", "2001-01-01"],
  "draft",
);
/** No window to read: kept as stored. */
const unversioned = seed(
  "https://example.test/eli/cz/sb/1990/3",
  "historical",
  [null, null],
  "historical",
);
const SEEDS = [predecessor, successor, upcoming, repealed, draft, unversioned];

const sourceId = createSafeId<"legislationSource">();
let client: PGlite;
let legislationDb: LegislationReadDb;

const searchHits = async (
  body: { status?: string },
  provider: "pg-fts" | "corpus-index",
) => {
  const response = await searchLegislationHandler(
    { query: TERM, jurisdiction: "CZE", limit: 20, ...body },
    legislationDb,
    "unobserved",
    {
      provider,
      loadSearchConfigs: async () => [
        {
          regconfig: "simple",
          useUnaccent: false,
          includeDefault: true,
          languages: [],
        },
      ],
      readServingGeneration: async () =>
        Result.ok({
          family: "legislation",
          generation: GENERATION,
          cluster: "q09",
        }),
    },
  );
  if (!("items" in response)) {
    return panic("status fixture search was refused");
  }
  return response.items.map(({ documentId, status }) => ({
    documentId,
    status,
  }));
};

beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  await db.execute(sql.raw("SET TIME ZONE 'UTC'"));
  await db.execute(
    sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
  );
  await db
    .insert(legislationSources)
    .values({ id: sourceId, adapterKey: "statutes-open", name: "Open" });
  await db.insert(legislationDocuments).values(
    SEEDS.map((version, index) => ({
      id: version.id,
      sourceId,
      eli: version.eli,
      title: `Status fixture ${String(index)}`,
      country: "CZE",
      language: "cs",
      documentType: "act",
      status: version.stored,
      versionValidFrom: version.validFrom,
      versionValidTo: version.validTo,
      contentHash: `status-${String(index)}`,
    })),
  );
  await db.insert(legislationSearchDocuments).values(
    SEEDS.map((version) => ({
      documentId: version.id,
      searchableText: TERM,
      language: "cs",
      regconfig: "simple",
      tsv: sql`to_tsvector('simple', ${TERM})`,
    })),
  );

  // The serving generation holds every version, so any may be a corpus hit.
  await db.insert(corpusIndexGenerations).values({
    family: "legislation",
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS[GENERATION],
    ),
    status: "building",
  });
  const intents = SEEDS.map((version) => ({
    id: createSafeId<"corpusIndexProjectionIntent">(),
    entityId: version.id,
  }));
  await db.insert(corpusIndexProjectionIntents).values(
    intents.map(({ id, entityId }) => ({
      id,
      family: "legislation" as const,
      generation: GENERATION,
      entityId,
      epoch: 1n,
      fingerprint: FINGERPRINT,
      indexId: INDEX_ID,
      status: "applied" as const,
      appendStartedAt: new Date(),
      appendCommittedAt: new Date(),
      expectedDocumentCount: 1,
      appliedAt: new Date(),
    })),
  );
  await db.insert(corpusIndexProjectionStates).values(
    intents.map(({ id, entityId }) => ({
      family: "legislation" as const,
      generation: GENERATION,
      entityId,
      desiredAction: "upsert" as const,
      desiredEpoch: 1n,
      desiredFingerprint: FINGERPRINT,
      desiredIndexId: INDEX_ID,
      appliedAction: "upsert" as const,
      appliedEpoch: 1n,
      appliedRevision: id,
      appliedFingerprint: FINGERPRINT,
      appliedIndexId: INDEX_ID,
      appliedAt: new Date(),
    })),
  );

  // The fixture reaches the fault: every window-bound version is stored
  // with the opposite of what today's date makes it.
  const stored = await db
    .select({
      id: legislationDocuments.id,
      status: legislationDocuments.status,
    })
    .from(legislationDocuments)
    .where(
      inArray(legislationDocuments.id, [
        predecessor.id,
        successor.id,
        upcoming.id,
      ]),
    );
  expect(new Map(stored.map((row) => [row.id, row.status]))).toEqual(
    new Map([
      [predecessor.id, "current"],
      [successor.id, "historical"],
      [upcoming.id, "current"],
    ]),
  );

  legislationDb = async (read) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      // The production driver answers `execute` with the rows themselves;
      // PGlite wraps them in a result object.
      const tx = new Proxy(roleTx, {
        get: (target, property, receiver) => {
          if (property !== "execute") {
            return Reflect.get(target, property, receiver);
          }
          return async (...args: Parameters<typeof roleTx.execute>) =>
            (await roleTx.execute(...args)).rows;
        },
      });
      // SAFETY: this PGlite transaction executes under the production
      // public-law role; the proxy adapts only execute's result shape.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded role transaction stands in for LegislationReadTransaction
      return await read(tx as unknown as LegislationReadTransaction);
    });
});

afterAll(async () => {
  await client.close();
});

describe("a version's status is read from its window on today's date", () => {
  test.each(SEEDS.map((version) => [version.expected, version] as const))(
    "the reader shows %s",
    async (expected, version) => {
      const read = await readPublicLegislationHandler(
        version.id,
        legislationDb,
        "pages",
      );
      expect(read).toHaveProperty("status", expected);
    },
  );

  test("the version list labels each window by today", async () => {
    const page = await listStatuteVersionsHandler({
      documentId: successor.id,
      query: {},
      legislationDb,
      surface: "pages",
    });
    if (!("items" in page)) {
      panic("version list was refused");
    }
    expect(page.items.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: upcoming.id, status: upcoming.expected },
      { id: successor.id, status: successor.expected },
      { id: predecessor.id, status: predecessor.expected },
    ]);
  });

  test("the statute list shows the wording in force as current", async () => {
    const page = await listStatutesHandler({ country: "CZE" }, legislationDb);
    if (!("items" in page)) {
      panic("statute list was refused");
    }
    const statuses = new Map(
      page.items.map(({ id, status }) => [String(id), status]),
    );
    expect(statuses.get(successor.id)).toBe("current");
    expect(statuses.get(repealed.id)).toBe("repealed");
  });

  describe.each(["pg-fts", "corpus-index"] as const)(
    "search over %s",
    (provider) => {
      /** Every version the corpus engine is asked about, as it would match. */
      const withEngine = async <T>(
        run: (queries: string[]) => Promise<T>,
      ): Promise<T> => {
        if (provider === "pg-fts") {
          return await run([]);
        }
        const corpusClient = getCorpusIndexClient("q09");
        const queries: string[] = [];
        const scan = spyOn(corpusClient, "scoredSearch").mockImplementation(
          async (options) => {
            queries.push(options.query);
            return Result.ok({
              numHits: SEEDS.length,
              hits: SEEDS.map((version, index) => ({
                fields: { document_id: String(version.id) },
                score: SEEDS.length - index,
              })),
            });
          },
        );
        const snippets = spyOn(corpusClient, "search").mockImplementation(
          async () => Result.ok({ numHits: 0, hits: [], snippets: [] }),
        );
        try {
          const result = await run(queries);
          // Each test's assertions on the engine query are not vacuous.
          expect(queries.length).toBeGreaterThan(0);
          return result;
        } finally {
          scan.mockRestore();
          snippets.mockRestore();
        }
      };

      test("status=current finds the version in force, not the one stamped current", async () => {
        await withEngine(async (queries) => {
          const hits = await searchHits({ status: "current" }, provider);
          expect(hits).toEqual([
            { documentId: successor.id, status: "current" },
          ]);
          // The engine's stored status is the ingest day's; it is not asked.
          for (const query of queries) {
            expect(query).not.toContain("status:");
          }
        });
      });

      test("status=historical leaves out the version in force", async () => {
        await withEngine(async () => {
          const hits = await searchHits({ status: "historical" }, provider);
          const ids = hits.map((hit) => hit.documentId);
          expect(ids).not.toContain(successor.id);
          expect(hits.length).toBeGreaterThan(0);
          expect(hits.every((hit) => hit.status === "historical")).toBe(true);
        });
      });

      test("a publisher statement is filtered as stored", async () => {
        await withEngine(async (queries) => {
          const hits = await searchHits({ status: "repealed" }, provider);
          expect(hits).toEqual([
            { documentId: repealed.id, status: "repealed" },
          ]);
          for (const query of queries) {
            expect(query).toContain('status:"repealed"');
          }
        });
      });

      test("an unfiltered hit shows today's status", async () => {
        await withEngine(async () => {
          const hits = await searchHits({}, provider);
          const byId = new Map(hits.map((hit) => [hit.documentId, hit.status]));
          expect(byId.get(successor.id)).toBe("current");
          expect(byId.get(repealed.id)).toBe("repealed");
        });
      });
    },
  );
});
