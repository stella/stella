import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  legislationDocuments,
  legislationSources,
  legislationWorkNames,
} from "@/api/db/schema";
import { processLegislationDocument } from "@/api/handlers/legislation/ingestion";
import type { LegislationCorpusDependencies } from "@/api/handlers/legislation/ingestion";
import { backfillLegislationWorkNamesPage } from "@/api/handlers/legislation/work-name-backfill";
import type { LegislationWorkNameBackfillPage } from "@/api/handlers/legislation/work-name-backfill";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { planCorpusDocumentWrite } from "@/api/lib/legal-search/corpus-storage";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The names a stored title states are written with the version at
 * ingestion, and by a bounded backfill for versions stored before. The
 * official title and derived names never share a column.
 */

const DB_TEST_TIMEOUT_MS = 120_000;
const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000b01",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const corpus = {
  mode: "off",
  write: async (input) => {
    const plan = planCorpusDocumentWrite(input);
    return await Promise.resolve(
      plan.type === "put"
        ? { type: "written" as const, written: plan.written }
        : plan,
    );
  },
} satisfies LegislationCorpusDependencies;

const input = (
  act: string,
  title: string,
  validFrom: string,
): LegislationDocumentInput => ({
  sourceId: SOURCE_ID,
  eli: `eli/cz/sb/${act}`,
  title,
  country: "CZE",
  language: "cs",
  version: { type: "consolidation", validFrom, end: { type: "open" } },
  fulltext: `§ 1 ${title}`,
  rawHash: `raw-${act}-${validFrom}-${title}`,
});

const namesOf = async (documentIds: readonly SafeId<"legislationDocument">[]) =>
  await db
    .select({
      documentId: legislationWorkNames.documentId,
      officialTitle: legislationWorkNames.officialTitle,
      derivedName: legislationWorkNames.derivedName,
      derivation: legislationWorkNames.derivation,
      citedKey: legislationWorkNames.citedKey,
      matchKey: legislationWorkNames.matchKey,
    })
    .from(legislationWorkNames)
    .where(inArray(legislationWorkNames.documentId, [...documentIds]))
    .orderBy(
      asc(legislationWorkNames.derivation),
      asc(legislationWorkNames.matchKey),
    );

/** The database's reason for refusing a write. */
const rejection = async (write: Promise<unknown>): Promise<string> =>
  await write.then(
    () => panic("expected the database to refuse the write"),
    (error: unknown) => {
      const cause: unknown =
        error instanceof Error && error.cause !== undefined
          ? error.cause
          : error;
      return cause instanceof Error ? cause.message : String(cause);
    },
  );

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    scopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx)));
    await db
      .insert(legislationSources)
      .values({ id: SOURCE_ID, adapterKey: "statutes-open", name: "Open" });
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

describe("ingestion", () => {
  test("writes the names a version's title states, and rewrites them when it changes", async () => {
    const stored = await processLegislationDocument(
      input(
        "2012/90",
        "90/2012 Sb., o obchodních společnostech a družstvech (zákon o obchodních korporacích)",
        "2014-01-01",
      ),
      scopedDb,
      { corpus },
    );
    if (stored.type !== "stored") {
      return panic(`expected a stored version, got ${stored.type}`);
    }

    expect(await namesOf([stored.id])).toEqual([
      {
        documentId: stored.id,
        officialTitle: null,
        derivedName: "zákon o obchodních korporacích",
        derivation: "derived_parenthetical",
        citedKey: null,
        matchKey: "zákon o obchodních korporacích",
      },
      {
        documentId: stored.id,
        officialTitle: null,
        derivedName: "90/2012 Sb.",
        derivation: "derived_title_citation",
        citedKey: null,
        matchKey: "90 2012 sb",
      },
      {
        documentId: stored.id,
        officialTitle: null,
        derivedName:
          "o obchodních společnostech a družstvech (zákon o obchodních korporacích)",
        derivation: "derived_title_segment",
        citedKey: null,
        matchKey:
          "o obchodních společnostech a družstvech zákon o obchodních korporacích",
      },
      {
        documentId: stored.id,
        officialTitle:
          "90/2012 Sb., o obchodních společnostech a družstvech (zákon o obchodních korporacích)",
        derivedName: null,
        derivation: null,
        citedKey: null,
        matchKey:
          "90 2012 sb o obchodních společnostech a družstvech zákon o obchodních korporacích",
      },
    ]);

    const retitled = await processLegislationDocument(
      input("2012/90", "90/2012 Sb., o obchodních korporacích", "2014-01-01"),
      scopedDb,
      { corpus },
    );
    expect(retitled).toMatchObject({ type: "stored", id: stored.id });
    expect(
      (await namesOf([stored.id])).map(
        (row) => row.officialTitle ?? row.derivedName,
      ),
    ).toEqual([
      "90/2012 Sb.",
      "o obchodních korporacích",
      "90/2012 Sb., o obchodních korporacích",
    ]);
  });
});

describe("the official column", () => {
  test("refuses a derived name, and a derived row without its derivation", async () => {
    const [document] = await db
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .limit(1);
    const documentId =
      document?.id ?? panic("the ingestion test stores a version first");
    const insert = async (
      values: Omit<typeof legislationWorkNames.$inferInsert, "documentId">,
    ) => {
      await db.insert(legislationWorkNames).values({ documentId, ...values });
    };

    // The same name as a derived row is accepted; only the mixes are refused.
    await insert({
      country: "CZE",
      derivedName: "a name",
      derivation: "derived_title_segment",
      matchKey: "a name",
    });
    expect(
      await rejection(
        insert({
          country: "CZE",
          officialTitle: "a name",
          derivedName: "a name",
          derivation: "derived_parenthetical",
          matchKey: "a name",
        }),
      ),
    ).toContain("legislation_work_names_official_or_derived");
    expect(
      await rejection(
        insert({ country: "CZE", derivedName: "a name", matchKey: "a name" }),
      ),
    ).toContain("legislation_work_names_official_or_derived");
    await db
      .delete(legislationWorkNames)
      .where(eq(legislationWorkNames.matchKey, "a name"));
  });
});

describe("backfill", () => {
  const ids = [
    createSafeId<"legislationDocument">(),
    createSafeId<"legislationDocument">(),
    createSafeId<"legislationDocument">(),
  ].toSorted();

  const pass = async (apply: boolean) => {
    const pages: LegislationWorkNameBackfillPage[] = [];
    let after: SafeId<"legislationDocument"> | null = null;
    for (;;) {
      // db-await-in-loop: one keyset page per iteration, as the script walks
      const page = await backfillLegislationWorkNamesPage({
        db: scopedDb,
        after,
        pageSize: 2,
        apply,
      });
      if (page.cursor === null) {
        return pages;
      }
      pages.push(page);
      after = page.cursor;
    }
  };

  test("reports without writing, then writes, then has nothing left to write", async () => {
    // Versions stored directly, as rows written before names existed.
    await db.insert(legislationDocuments).values(
      ids.map((id, index) => ({
        id,
        sourceId: SOURCE_ID,
        eli: `eli/cz/sb/1990/${String(index + 1)}`,
        title: `${String(index + 1)}/1990 Sb., o věci ${String(index + 1)}`,
        country: "CZE",
        language: "cs",
        versionValidFrom: "1990-01-01",
      })),
    );

    const report = await pass(false);
    const reported = report.reduce((sum, page) => sum + page.insertedRows, 0);
    expect(reported).toBe(ids.length * 3);
    expect(await namesOf(ids)).toEqual([]);

    const applied = await pass(true);
    expect(applied.reduce((sum, page) => sum + page.insertedRows, 0)).toBe(
      reported,
    );
    expect(await namesOf(ids)).toHaveLength(ids.length * 3);

    const again = await pass(true);
    expect(
      again.reduce(
        (sum, page) => sum + page.insertedRows + page.deletedRows,
        0,
      ),
    ).toBe(0);
    // The walk only reads versions.
    const titles = await db
      .select({ title: legislationDocuments.title })
      .from(legislationDocuments)
      .where(inArray(legislationDocuments.id, ids))
      .orderBy(asc(legislationDocuments.title));
    expect(titles.map((row) => row.title)).toEqual([
      "1/1990 Sb., o věci 1",
      "2/1990 Sb., o věci 2",
      "3/1990 Sb., o věci 3",
    ]);
  });
});
