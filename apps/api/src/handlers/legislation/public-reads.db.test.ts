import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { listStatutesHandler } from "@/api/handlers/legislation/list";
import { listStatuteVersionsHandler } from "@/api/handlers/legislation/versions";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// Public statute reads over a fixture whose current version is neither the
// newest row nor the newest window: one superseded version, one in force and
// one that only opens in the future.

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let legislationDb: LegislationReadDb;

const openSourceId = createSafeId<"legislationSource">();
const closedSourceId = createSafeId<"legislationSource">();

const civilCodeSuperseded = createSafeId<"legislationDocument">();
const civilCodeOpenOlder = createSafeId<"legislationDocument">();
const civilCodeCurrent = createSafeId<"legislationDocument">();
const civilCodeFuture = createSafeId<"legislationDocument">();
const labourCode = createSafeId<"legislationDocument">();
const registerAct = createSafeId<"legislationDocument">();
const withheldAct = createSafeId<"legislationDocument">();

type DocumentSeed = {
  id: SafeId<"legislationDocument">;
  sourceId: SafeId<"legislationSource">;
  eli: string;
  title: string;
  versionValidFrom: string | null;
  versionValidTo: string | null;
};

const seedDocument = ({
  id,
  sourceId,
  eli,
  title,
  versionValidFrom,
  versionValidTo,
}: DocumentSeed) => ({
  id,
  sourceId,
  eli,
  title,
  country: "CZE",
  language: "cs",
  documentType: "act",
  status: "current",
  versionValidFrom,
  versionValidTo,
});

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });

    await db.insert(legislationSources).values([
      {
        id: openSourceId,
        adapterKey: "statutes-open",
        name: "Open statutes source",
      },
      {
        id: closedSourceId,
        adapterKey: "statutes-closed",
        name: "Withheld statutes source",
        descriptor: {
          license: "restricted",
          attribution: null,
          allowsRedistribution: false,
          allowsDerivedAi: false,
        },
      },
    ]);

    await db.insert(legislationDocuments).values([
      seedDocument({
        id: civilCodeSuperseded,
        sourceId: openSourceId,
        eli: "CZ/2012/89",
        title: "Civil Code",
        versionValidFrom: "2014-01-01",
        versionValidTo: "2019-12-31",
      }),
      // Also in force today: its window opened earlier and never closed, so
      // only the later `version_valid_from` separates it from the current one.
      seedDocument({
        id: civilCodeOpenOlder,
        sourceId: openSourceId,
        eli: "CZ/2012/89",
        title: "Civil Code",
        versionValidFrom: "2016-01-01",
        versionValidTo: null,
      }),
      seedDocument({
        id: civilCodeCurrent,
        sourceId: openSourceId,
        eli: "CZ/2012/89",
        title: "Civil Code",
        versionValidFrom: "2020-01-01",
        versionValidTo: null,
      }),
      seedDocument({
        id: civilCodeFuture,
        sourceId: openSourceId,
        eli: "CZ/2012/89",
        title: "Civil Code",
        versionValidFrom: "2999-01-01",
        versionValidTo: null,
      }),
      seedDocument({
        id: labourCode,
        sourceId: openSourceId,
        eli: "CZ/2006/262",
        title: "Labour Code",
        versionValidFrom: "2007-01-01",
        versionValidTo: null,
      }),
      seedDocument({
        id: registerAct,
        sourceId: openSourceId,
        eli: "CZ/2013/304",
        title: "Public Registers Act",
        versionValidFrom: null,
        versionValidTo: null,
      }),
      seedDocument({
        id: withheldAct,
        sourceId: closedSourceId,
        eli: "CZ/1999/111",
        title: "Withheld Act",
        versionValidFrom: "2000-01-01",
        versionValidTo: null,
      }),
    ]);

    // Test shim: run each read callback directly against the pglite handle.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test-only LegislationReadDb shim
    legislationDb = ((fn: (tx: unknown) => unknown) =>
      fn(db)) as unknown as LegislationReadDb;
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  if (client !== undefined) {
    await client.close();
  }
});

type StatutePage = {
  items: { id: string; title: string; versionValidFrom: string | null }[];
  nextCursor: string | null;
};

const expectPage = (result: unknown): StatutePage => {
  if (typeof result !== "object" || result === null || !("items" in result)) {
    throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  }

  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by the guard above
  return result as StatutePage;
};

describe("public statute list", () => {
  test("returns the version in force, not the superseded or future one", async () => {
    const page = expectPage(
      await listStatutesHandler({ country: "CZE" }, legislationDb),
    );
    const ids = page.items.map((item) => item.id);

    expect(ids).toContain(civilCodeCurrent);
    expect(ids).not.toContain(civilCodeOpenOlder);
    expect(ids).not.toContain(civilCodeSuperseded);
    expect(ids).not.toContain(civilCodeFuture);
  });

  test("returns one row per work, ordered by title", async () => {
    const page = expectPage(
      await listStatutesHandler({ country: "CZE" }, legislationDb),
    );

    expect(page.items.map((item) => item.title)).toEqual([
      "Civil Code",
      "Labour Code",
      "Public Registers Act",
    ]);
  });

  test("omits sources not cleared for redistribution", async () => {
    const page = expectPage(
      await listStatutesHandler({ country: "CZE" }, legislationDb),
    );

    expect(page.items.map((item) => item.id)).not.toContain(withheldAct);
  });

  test("filters on title and ELI", async () => {
    const byTitle = expectPage(
      await listStatutesHandler(
        { country: "CZE", query: "labour" },
        legislationDb,
      ),
    );
    const byEli = expectPage(
      await listStatutesHandler(
        { country: "CZE", query: "CZ/2013" },
        legislationDb,
      ),
    );

    expect(byTitle.items.map((item) => item.id)).toEqual([labourCode]);
    expect(byEli.items.map((item) => item.id)).toEqual([registerAct]);
  });

  test("walks every work exactly once across cursor pages", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let request = 0; request < 5; request += 1) {
      // Cursor pagination is sequential by construction: each request needs
      // the cursor the previous one returned.
      const page: StatutePage = expectPage(
        // eslint-disable-next-line eslint/no-await-in-loop -- keyset walk
        await listStatutesHandler(
          {
            country: "CZE",
            limit: 1,
            ...(cursor === null ? {} : { cursor }),
          },
          legislationDb,
        ),
      );

      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;

      if (cursor === null) {
        break;
      }
    }

    expect(cursor).toBeNull();
    expect(seen).toEqual([civilCodeCurrent, labourCode, registerAct]);
  });

  test("rejects a cursor that is not a title/id pair", async () => {
    const result = await listStatutesHandler(
      { country: "CZE", cursor: "not-a-cursor" },
      legislationDb,
    );

    expect(result).not.toHaveProperty("items");
  });
});

describe("public statute versions", () => {
  test("lists every version of the work, newest window first", async () => {
    const page = expectPage(
      await listStatuteVersionsHandler({
        documentId: civilCodeCurrent,
        query: {},
        legislationDb,
      }),
    );

    expect(page.items.map((item) => item.id)).toEqual([
      civilCodeFuture,
      civilCodeCurrent,
      civilCodeOpenOlder,
      civilCodeSuperseded,
    ]);
  });

  test("walks every version exactly once across cursor pages", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let request = 0; request < 6; request += 1) {
      const page: StatutePage = expectPage(
        // eslint-disable-next-line eslint/no-await-in-loop -- keyset walk
        await listStatuteVersionsHandler({
          documentId: civilCodeSuperseded,
          query: { limit: 1, ...(cursor === null ? {} : { cursor }) },
          legislationDb,
        }),
      );

      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;

      if (cursor === null) {
        break;
      }
    }

    expect(cursor).toBeNull();
    expect(seen).toEqual([
      civilCodeFuture,
      civilCodeCurrent,
      civilCodeOpenOlder,
      civilCodeSuperseded,
    ]);
  });

  test("reads as not found for a source not cleared for redistribution", async () => {
    const result = await listStatuteVersionsHandler({
      documentId: withheldAct,
      query: {},
      legislationDb,
    });

    expect(result).not.toHaveProperty("items");
  });
});
