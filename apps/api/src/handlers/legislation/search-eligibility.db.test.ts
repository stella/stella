import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  legislationDocuments,
  legislationSearchDocuments,
  legislationSources,
} from "@/api/db/schema";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * A withdrawn version is a tombstone: its publisher no longer lists it, so no
 * search may find it, yet a reader holding its id can still open it, labelled.
 * The Postgres search must drop it before it pages, or a withdrawn row would
 * take a slot on the page or announce a page that holds nothing.
 */

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

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
let legislationDb: LegislationReadDb;

const sourceId = createSafeId<"legislationSource">();

type Seed = {
  term: string;
  /** How often the term occurs: more occurrences rank higher. */
  occurrences: number;
  citationAuthority: number;
  withdrawn?: boolean;
};

/** Stores one searchable version and its search projection. */
const seedVersion = async ({
  term,
  occurrences,
  citationAuthority,
  withdrawn = false,
}: Seed): Promise<SafeId<"legislationDocument">> => {
  const id = createSafeId<"legislationDocument">();
  const text = Array.from({ length: occurrences }, () => term).join(" ");
  await db.insert(legislationDocuments).values({
    id,
    sourceId,
    eli: `CZ/2040/${id}`,
    title: `Search eligibility ${term}`,
    country: "CZE",
    language: "cs",
    documentType: "act",
    status: "current",
    fulltext: text,
    citationAuthority,
    windowDisposition: withdrawn ? "withdrawn" : "effective",
    windowDispositionBasis: withdrawn ? "publisher-unlisted" : null,
  });
  await db.insert(legislationSearchDocuments).values({
    documentId: id,
    searchableText: text,
    language: "cs",
    regconfig: "simple",
    tsv: sql`to_tsvector('simple', ${text})`,
  });
  return id;
};

/** Lists the version again, as a publisher restoring it would. */
const restore = async (id: SafeId<"legislationDocument">) => {
  await db
    .update(legislationDocuments)
    .set({ windowDisposition: "effective", windowDispositionBasis: null })
    .where(eq(legislationDocuments.id, id));
};

const search = async (query: string, limit: number, cursor?: string) => {
  const response = await searchLegislationHandler(
    { query, limit, ...(cursor === undefined ? {} : { cursor }) },
    legislationDb,
    "unobserved",
    searchDependencies,
  );
  if (!("items" in response)) {
    throw new Error(`search refused: ${JSON.stringify(response)}`);
  }
  return {
    ids: response.items.map((item) => item.documentId),
    nextCursor: response.nextCursor,
  };
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.execute(
      sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
    );
    await db.insert(legislationSources).values({
      id: sourceId,
      adapterKey: "search-eligibility",
      name: "Search eligibility fixture",
    });

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
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  if (client !== undefined) {
    await client.close();
  }
});

describe("a withdrawn version is found by no search", () => {
  test("ranked first, it takes no page slot", async () => {
    const term = "odvolatelnost";
    const withdrawn = await seedVersion({
      term,
      occurrences: 12,
      citationAuthority: 1000,
      withdrawn: true,
    });
    const first = await seedVersion({
      term,
      occurrences: 4,
      citationAuthority: 10,
    });
    const second = await seedVersion({
      term,
      occurrences: 1,
      citationAuthority: 0,
    });

    const pageOne = await search(term, 1);
    expect(pageOne.ids).toEqual([first]);
    expect(pageOne.nextCursor).not.toBeNull();

    const pageTwo = await search(term, 1, pageOne.nextCursor ?? undefined);
    expect(pageTwo.ids).toEqual([second]);
    expect(pageTwo.nextCursor).toBeNull();

    // The fixture reaches the fault: listed again, the same version outranks
    // both and takes the first slot.
    await restore(withdrawn);
    expect((await search(term, 1)).ids).toEqual([withdrawn]);
  });

  test("ranked last, it announces no further page", async () => {
    const term = "zrusitelnost";
    const first = await seedVersion({
      term,
      occurrences: 12,
      citationAuthority: 1000,
    });
    const second = await seedVersion({
      term,
      occurrences: 4,
      citationAuthority: 10,
    });
    const withdrawn = await seedVersion({
      term,
      occurrences: 1,
      citationAuthority: 0,
      withdrawn: true,
    });

    expect(await search(term, 2)).toEqual({
      ids: [first, second],
      nextCursor: null,
    });

    // Listed again, it is the row that makes a next page exist.
    await restore(withdrawn);
    const pageOne = await search(term, 2);
    expect(pageOne.ids).toEqual([first, second]);
    expect(pageOne.nextCursor).not.toBeNull();
    expect(
      (await search(term, 2, pageOne.nextCursor ?? undefined)).ids,
    ).toEqual([withdrawn]);
  });
});

test("a withdrawn version stays openable by its id, labelled withdrawn", async () => {
  const term = "vyrazenost";
  const withdrawn = await seedVersion({
    term,
    occurrences: 3,
    citationAuthority: 0,
    withdrawn: true,
  });

  expect(await search(term, 10)).toEqual({ ids: [], nextCursor: null });
  expect(
    await readPublicLegislationHandler(withdrawn, legislationDb),
  ).toMatchObject({
    id: withdrawn,
    windowDisposition: "withdrawn",
    windowDispositionBasis: "publisher-unlisted",
  });
});
