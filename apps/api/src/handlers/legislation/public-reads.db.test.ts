import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";
import { foldToAscii } from "@stll/text-normalize";

import {
  LEGISLATION_TITLE_SORT_KEY_CHARS,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { readStatuteByEliHandler } from "@/api/handlers/legislation/by-eli";
import {
  readLegislationHandler,
  readPublicLegislationHandler,
} from "@/api/handlers/legislation/get";
import {
  LEGISLATION_LIST_CURSOR_KIND,
  listStatutesHandler,
} from "@/api/handlers/legislation/list";
import { readProvisionHistoryHandler } from "@/api/handlers/legislation/provision-history";
import {
  readLegislationShelf,
  readLegislationShelfHandler,
} from "@/api/handlers/legislation/shelf";
import { listStatuteVersionsHandler } from "@/api/handlers/legislation/versions";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { PAGINATION_CURSOR_MAX_CHARS } from "@/api/lib/custom-schema";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

// Public statute reads over a fixture whose current version is neither the
// newest row nor the newest window: one superseded version, one in force and
// one that only opens in the future.

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let legislationDb: LegislationReadDb;
let workspaceDb: LegislationReadDb;

const openSourceId = createSafeId<"legislationSource">();
const closedSourceId = createSafeId<"legislationSource">();

const civilCodeSuperseded = createSafeId<"legislationDocument">();
const civilCodeOpenOlder = createSafeId<"legislationDocument">();
const civilCodeCurrent = createSafeId<"legislationDocument">();
const civilCodeFuture = createSafeId<"legislationDocument">();
const civilCodeEnglish = createSafeId<"legislationDocument">();
const labourCode = createSafeId<"legislationDocument">();
const longTitleAct = createSafeId<"legislationDocument">();
const registerAct = createSafeId<"legislationDocument">();
const sunsetAct = createSafeId<"legislationDocument">();
const withheldAct = createSafeId<"legislationDocument">();
const czechCivilCode = createSafeId<"legislationDocument">();
const czechCivilCodeAmendment = createSafeId<"legislationDocument">();
const corporationsAct = createSafeId<"legislationDocument">();
const shelfFreshSuperseded = createSafeId<"legislationDocument">();
const shelfFresh = createSafeId<"legislationDocument">();
const shelfEdgeRecent = createSafeId<"legislationDocument">();
const shelfStale = createSafeId<"legislationDocument">();
const shelfUpcomingCurrent = createSafeId<"legislationDocument">();
const shelfUpcomingNext = createSafeId<"legislationDocument">();
const shelfUpcomingLater = createSafeId<"legislationDocument">();
const shelfEdgeFuture = createSafeId<"legislationDocument">();
const shelfFarFuture = createSafeId<"legislationDocument">();
const shelfWithheldFuture = createSafeId<"legislationDocument">();

const LEGISLATION_SHELF_WINDOW_DAYS = LIMITS.legislationShelfWindowDays;

/** A calendar date `days` from today (UTC), as the date columns store it. */
const daysFromToday = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * The default listing, newest consolidation first, ties broken by id
 * descending. The two civil code languages open on the same day, so their
 * mutual order is whatever the generated ids say.
 */
const recencyOrder = [
  corporationsAct,
  ...[civilCodeCurrent, civilCodeEnglish].toSorted((a, b) => (a < b ? 1 : -1)),
  czechCivilCodeAmendment,
  czechCivilCode,
  labourCode,
  longTitleAct,
  registerAct,
];
const enumeratedAmendments = Array.from(
  { length: 1000 },
  (_, index) => `act-${index.toString(36).padStart(4, "0")}`,
).join(", ");
const longOfficialTitle = `Long legislation title amending ${enumeratedAmendments}`;

/** The window boundary the half-open validity interval turns on. */
const today = new Date().toISOString().slice(0, 10);

type DocumentSeed = {
  id: SafeId<"legislationDocument">;
  sourceId: SafeId<"legislationSource">;
  eli: string;
  title: string;
  country?: string;
  language?: string;
  metadata?: Record<string, unknown>;
  documentAst?: DocumentAst;
  fulltext?: string;
  versionValidFrom: string | null;
  versionValidTo: string | null;
};

const seedDocument = ({
  id,
  sourceId,
  eli,
  title,
  country = "CZE",
  language = "cs",
  metadata,
  documentAst,
  fulltext,
  versionValidFrom,
  versionValidTo,
}: DocumentSeed) => ({
  id,
  sourceId,
  eli,
  title,
  country,
  language,
  documentType: "act",
  status: "current",
  versionValidFrom,
  versionValidTo,
  ...(metadata === undefined ? {} : { metadata }),
  ...(documentAst === undefined ? {} : { documentAst }),
  ...(fulltext === undefined ? {} : { fulltext }),
});

const DELIVERY_ANCHOR = "sec-2079";
const UNKNOWN_ANCHOR = "sec-9999";
const SECTION_SIGN = "\u00a7";

/**
 * One consolidation's structure: the provision under test, a paragraph that
 * belongs to it, and a sibling section that has to stay out of the extracted
 * text. Passing null repeals the provision, leaving the anchor absent.
 */
const statuteAst = (deliveryText: string | null): DocumentAst => {
  const provision: Block[] =
    deliveryText === null
      ? []
      : [
          {
            id: "b-1",
            anchorId: DELIVERY_ANCHOR,
            type: "heading",
            level: 2,
            inlines: [{ type: "text", text: `${SECTION_SIGN} 2079` }],
            plainText: `${SECTION_SIGN} 2079`,
          },
          {
            id: "b-2",
            anchorId: "p-2079-1",
            type: "paragraph",
            inlines: [{ type: "text", text: deliveryText }],
            plainText: deliveryText,
          },
        ];

  return {
    version: 1,
    source: { system: "test", documentId: "", webUrl: "", printUrl: "" },
    metadata: {
      caseNumber: null,
      ecli: null,
      court: null,
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      ...provision,
      {
        id: "b-3",
        anchorId: "sec-2080",
        type: "heading",
        level: 2,
        inlines: [{ type: "text", text: `${SECTION_SIGN} 2080` }],
        plainText: `${SECTION_SIGN} 2080`,
      },
      {
        id: "b-4",
        anchorId: "p-2080-1",
        type: "paragraph",
        inlines: [{ type: "text", text: "Unrelated neighbouring rule." }],
        plainText: "Unrelated neighbouring rule.",
      },
    ],
  };
};

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
        documentAst: statuteAst("The seller shall deliver within thirty days."),
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
        // Same provision text as its predecessor: a reader has to be able to
        // tell "another consolidation" from "another wording".
        documentAst: statuteAst("The seller shall deliver within thirty days."),
        versionValidFrom: "2016-01-01",
        versionValidTo: null,
      }),
      seedDocument({
        id: civilCodeCurrent,
        sourceId: openSourceId,
        eli: "CZ/2012/89",
        title: "Civil Code",
        metadata: { publisherNote: "not for public display" },
        fulltext: "The duplicate plain-text consolidation.",
        documentAst: statuteAst(
          "The seller shall deliver within fourteen days.",
        ),
        versionValidFrom: "2020-01-01",
        versionValidTo: null,
      }),
      // Same work key except the language, so the list has a second language
      // to narrow to.
      seedDocument({
        id: civilCodeEnglish,
        sourceId: openSourceId,
        eli: "CZ/2012/89",
        title: "Civil Code (English)",
        language: "en",
        fulltext: "The English plain-text consolidation.",
        versionValidFrom: "2020-01-01",
        versionValidTo: null,
      }),
      seedDocument({
        id: civilCodeFuture,
        sourceId: openSourceId,
        eli: "CZ/2012/89",
        title: "Civil Code",
        // The provision is repealed in this consolidation, so its anchor is
        // simply not there.
        documentAst: statuteAst(null),
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
        id: longTitleAct,
        sourceId: openSourceId,
        eli: "CZ/1994/85",
        title: longOfficialTitle,
        versionValidFrom: "1994-06-01",
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
      // The window closes today and no successor opens: half-open validity
      // makes it historical from today, not tomorrow.
      seedDocument({
        id: sunsetAct,
        sourceId: openSourceId,
        eli: "CZ/1998/222",
        title: "Sunset Act",
        versionValidFrom: "2000-01-01",
        versionValidTo: today,
      }),
      seedDocument({
        id: withheldAct,
        sourceId: closedSourceId,
        eli: "CZ/1999/111",
        title: "Withheld Act",
        versionValidFrom: "2000-01-01",
        versionValidTo: null,
      }),
      // A code and the act amending it, titled the way the publisher titles
      // them: the amendment's title contains the code's name, the code's own
      // name starts with it. Its number shares a suffix with 89/2012.
      seedDocument({
        id: czechCivilCode,
        sourceId: openSourceId,
        eli: "CZ/2012/1089",
        title: "1089/2012 Sb., občanský zákoník",
        versionValidFrom: "2014-01-01",
        versionValidTo: null,
      }),
      seedDocument({
        id: czechCivilCodeAmendment,
        sourceId: openSourceId,
        eli: "CZ/2016/460",
        title:
          "460/2016 Sb., kterým se mění zákon č. 1089/2012 Sb., občanský zákoník",
        versionValidFrom: "2017-02-28",
        versionValidTo: null,
      }),
      // A publisher-shaped ELI, so the collection segment is there to match.
      seedDocument({
        id: corporationsAct,
        sourceId: openSourceId,
        eli: "https://www.e-sbirka.cz/eli/cz/sb/2012/90",
        title:
          "90/2012 Sb., o obchodních společnostech a družstvech (zákon o obchodních korporacích)",
        versionValidFrom: "2021-01-01",
        versionValidTo: null,
      }),
      // The shelf fixture lives in its own jurisdiction so the listing tests
      // above keep their order. Dates are relative to today: the shelf is a
      // window around the current date.
      seedDocument({
        id: shelfFreshSuperseded,
        sourceId: openSourceId,
        eli: "SK/2026/300",
        title: "Fresh Act",
        country: "SVK",
        language: "sk",
        versionValidFrom: "2020-01-01",
        versionValidTo: daysFromToday(-5),
      }),
      seedDocument({
        id: shelfFresh,
        sourceId: openSourceId,
        eli: "SK/2026/300",
        title: "Fresh Act",
        country: "SVK",
        language: "sk",
        versionValidFrom: daysFromToday(-5),
        versionValidTo: null,
      }),
      seedDocument({
        id: shelfEdgeRecent,
        sourceId: openSourceId,
        eli: "SK/2026/302",
        title: "Edge Recent Act",
        country: "SVK",
        language: "sk",
        versionValidFrom: daysFromToday(-LEGISLATION_SHELF_WINDOW_DAYS),
        versionValidTo: null,
      }),
      seedDocument({
        id: shelfStale,
        sourceId: openSourceId,
        eli: "SK/2026/303",
        title: "Stale Act",
        country: "SVK",
        language: "sk",
        versionValidFrom: daysFromToday(-LEGISLATION_SHELF_WINDOW_DAYS - 1),
        versionValidTo: null,
      }),
      seedDocument({
        id: shelfUpcomingCurrent,
        sourceId: openSourceId,
        eli: "SK/2026/301",
        title: "Upcoming Act",
        country: "SVK",
        language: "sk",
        versionValidFrom: "2020-01-01",
        versionValidTo: daysFromToday(10),
      }),
      seedDocument({
        id: shelfUpcomingNext,
        sourceId: openSourceId,
        eli: "SK/2026/301",
        title: "Upcoming Act",
        country: "SVK",
        language: "sk",
        versionValidFrom: daysFromToday(10),
        versionValidTo: daysFromToday(20),
      }),
      // A later window of the same work: not the next one, so not shown.
      seedDocument({
        id: shelfUpcomingLater,
        sourceId: openSourceId,
        eli: "SK/2026/301",
        title: "Upcoming Act",
        country: "SVK",
        language: "sk",
        versionValidFrom: daysFromToday(20),
        versionValidTo: null,
      }),
      seedDocument({
        id: shelfEdgeFuture,
        sourceId: openSourceId,
        eli: "SK/2026/304",
        title: "Edge Future Act",
        country: "SVK",
        language: "sk",
        versionValidFrom: daysFromToday(LEGISLATION_SHELF_WINDOW_DAYS),
        versionValidTo: null,
      }),
      seedDocument({
        id: shelfFarFuture,
        sourceId: openSourceId,
        eli: "SK/2026/305",
        title: "Far Future Act",
        country: "SVK",
        language: "sk",
        versionValidFrom: daysFromToday(LEGISLATION_SHELF_WINDOW_DAYS + 1),
        versionValidTo: null,
      }),
      seedDocument({
        id: shelfWithheldFuture,
        sourceId: closedSourceId,
        eli: "SK/2026/306",
        title: "Withheld Future Act",
        country: "SVK",
        language: "sk",
        versionValidFrom: daysFromToday(3),
        versionValidTo: null,
      }),
    ]);

    workspaceDb = async (read) =>
      await db.transaction(
        async (tx) =>
          // SAFETY: the PGlite transaction has the statement surface under
          // test; only its driver-specific execute result differs nominally.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded owner transaction stands in for LegislationReadTransaction
          await read(tx as unknown as LegislationReadTransaction),
      );

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
  { timeout: propertyTestTimeout(30_000) },
);

afterAll(async () => {
  if (client !== undefined) {
    await client.close();
  }
});

describe("legislation shelf", () => {
  test("recently in force lists current consolidations opened within the window, newest first", async () => {
    const shelf = await readLegislationShelf({
      legislationDb,
      country: "SVK",
    });
    // The superseded window of the fresh act and the stale act are out; the
    // window's own edge is in.
    expect(shelf.recentlyInForce.map((item) => item.id)).toEqual([
      shelfFresh,
      shelfEdgeRecent,
    ]);
  });

  test("entering into force lists each work's next window only, soonest first, within the window", async () => {
    const shelf = await readLegislationShelf({
      legislationDb,
      country: "SVK",
    });
    expect(shelf.enteringIntoForce.map((item) => item.id)).toEqual([
      shelfUpcomingNext,
      shelfEdgeFuture,
    ]);
    const ids = new Set(shelf.enteringIntoForce.map((item) => item.id));
    expect(ids.has(shelfUpcomingLater)).toBe(false);
    expect(ids.has(shelfFarFuture)).toBe(false);
    expect(ids.has(shelfWithheldFuture)).toBe(false);
    expect(ids.has(shelfUpcomingCurrent)).toBe(false);
  });

  test("the shelf is bounded and column-restricted for the public reader", async () => {
    const shelf = await readLegislationShelf({
      legislationDb,
      country: "SVK",
    });
    expect(shelf.recentlyInForce.length).toBeLessThanOrEqual(
      LIMITS.legislationShelfPerList,
    );
    expect(Object.keys(shelf.recentlyInForce[0] ?? {}).toSorted()).toEqual([
      "country",
      "documentType",
      "eli",
      "id",
      "language",
      "status",
      "title",
      "versionValidFrom",
    ]);
  });

  test("the handler rejects a malformed jurisdiction before reading anything", async () => {
    const rejected = await readLegislationShelfHandler(
      { country: "s-k" },
      legislationDb,
    );
    expect("recentlyInForce" in rejected).toBe(false);
  });

  test("the shelf reads the jurisdiction in its corpus form", async () => {
    const shelf = await readLegislationShelf({
      legislationDb,
      country: "SVK",
    });
    expect(shelf.country).toBe("SVK");
    expect(shelf.recentlyInForce.every((item) => item.country === "SVK")).toBe(
      true,
    );
  });

  test("a jurisdiction without legislation has an empty shelf, not an error", async () => {
    const shelf = await readLegislationShelf({
      legislationDb,
      country: "POL",
    });
    expect(shelf).toEqual({
      country: "POL",
      recentlyInForce: [],
      enteringIntoForce: [],
    });
  });
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

type ProvisionHistoryPage = {
  items: {
    documentId: string;
    versionValidFrom: string | null;
    versionValidTo: string | null;
    text: string;
  }[];
  nextCursor: string | null;
};

const expectHistoryPage = (result: unknown): ProvisionHistoryPage => {
  if (typeof result !== "object" || result === null || !("items" in result)) {
    throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  }

  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by the guard above
  return result as ProvisionHistoryPage;
};

const expectDocumentId = (result: unknown): string => {
  if (typeof result !== "object" || result === null || !("id" in result)) {
    throw new Error(`expected a document, got ${JSON.stringify(result)}`);
  }

  return String(result.id);
};

const readEliAsOf = async (
  eli: string,
  asOf: string | undefined,
  language?: string,
) =>
  await readStatuteByEliHandler(
    {
      eli,
      ...(asOf === undefined ? {} : { asOf }),
      ...(language === undefined ? {} : { language }),
    },
    legislationDb,
  );

const readAsOf = async (asOf: string | undefined, language?: string) =>
  await readEliAsOf("CZ/2012/89", asOf, language);

const DAY_MS = 24 * 60 * 60 * 1000;
const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);

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

  test("returns one row per work, newest consolidation first", async () => {
    const page = expectPage(
      await listStatutesHandler({ country: "CZE" }, legislationDb),
    );

    expect(longOfficialTitle.length).toBeGreaterThan(1024);
    expect(page.items.map((item) => item.id)).toEqual(recencyOrder);
    expect(
      page.items.every(
        (item) =>
          !Object.hasOwn(item, "titleSortKey") &&
          !Object.hasOwn(item, "validFromKey") &&
          !Object.hasOwn(item, "rank"),
      ),
    ).toBe(true);
  });

  test("drops a version whose validity window closes today", async () => {
    const page = expectPage(
      await listStatutesHandler({ country: "CZE" }, legislationDb),
    );

    expect(page.items.map((item) => item.id)).not.toContain(sunsetAct);
  });

  test("narrows the page to one language", async () => {
    const inEnglish = expectPage(
      await listStatutesHandler(
        { country: "CZE", language: "en" },
        legislationDb,
      ),
    );
    const inCzech = expectPage(
      await listStatutesHandler(
        { country: "CZE", language: "cs" },
        legislationDb,
      ),
    );

    expect(inEnglish.items.map((item) => item.id)).toEqual([civilCodeEnglish]);
    expect(inCzech.items.map((item) => item.id)).not.toContain(
      civilCodeEnglish,
    );
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

  test("matches a title typed without diacritics or case", async () => {
    // The fixture differs from the query before folding, so the match below
    // is the fold's doing and not a coincidence of the seed.
    expect("občanský zákoník".normalize("NFC")).not.toBe("OBCANSKY zakonik");
    const page = expectPage(
      await listStatutesHandler(
        { country: "CZE", query: "OBCANSKY zakonik" },
        legislationDb,
      ),
    );

    expect(page.items.map((item) => item.id)).toEqual([
      czechCivilCode,
      czechCivilCodeAmendment,
    ]);
  });

  test("ranks the act named by the text above the acts amending it", async () => {
    const page = expectPage(
      await listStatutesHandler(
        { country: "CZE", query: "občanský zákoník" },
        legislationDb,
      ),
    );

    // Both titles contain the term; only the code's own name starts with it.
    expect(page.items.map((item) => item.id)).toEqual([
      czechCivilCode,
      czechCivilCodeAmendment,
    ]);
  });

  test("resolves an act by its number across the work's languages", async () => {
    const page = expectPage(
      await listStatutesHandler(
        { country: "CZE", number: "89/2012" },
        legislationDb,
      ),
    );

    // The tail is anchored: 1089/2012 shares a suffix and must stay out.
    expect(new Set(page.items.map((item) => item.id))).toEqual(
      new Set([civilCodeCurrent, civilCodeEnglish]),
    );
  });

  test("resolves an act by number within a named collection only", async () => {
    const inCollection = expectPage(
      await listStatutesHandler(
        { country: "CZE", collection: "sb", number: "90/2012" },
        legislationDb,
      ),
    );
    const elsewhere = expectPage(
      await listStatutesHandler(
        { country: "CZE", collection: "ul1", number: "90/2012" },
        legislationDb,
      ),
    );

    expect(inCollection.items.map((item) => item.id)).toEqual([
      corporationsAct,
    ]);
    expect(elsewhere.items).toEqual([]);
  });

  test("walks every work exactly once across recency cursor pages", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let request = 0; request < 10; request += 1) {
      // Cursor pagination is sequential by construction: each request needs
      // the cursor the previous one returned.
      const page: StatutePage = expectPage(
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
      expect(cursor.length).toBeLessThanOrEqual(PAGINATION_CURSOR_MAX_CHARS);
      const cursorParts = decodePaginationCursor(cursor);
      expect(cursorParts).toHaveLength(3);
      expect(cursorParts?.at(0)).toBe(LEGISLATION_LIST_CURSOR_KIND.recent);
      expect(cursorParts?.at(1)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }

    expect(cursor).toBeNull();
    expect(seen).toEqual(recencyOrder);
  });

  test("walks every search hit exactly once across search cursor pages", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let request = 0; request < 10; request += 1) {
      const page: StatutePage = expectPage(
        await listStatutesHandler(
          {
            country: "CZE",
            limit: 1,
            query: "code",
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
      const cursorParts = decodePaginationCursor(cursor);
      expect(cursorParts).toHaveLength(4);
      expect(cursorParts?.at(0)).toBe(LEGISLATION_LIST_CURSOR_KIND.search);
      const sortKey = cursorParts?.at(2);
      expect(typeof sortKey).toBe("string");
      if (typeof sortKey !== "string") {
        throw new TypeError("Expected a title sort key in the tagged cursor");
      }
      expect(sortKey.length).toBeLessThanOrEqual(
        LEGISLATION_TITLE_SORT_KEY_CHARS,
      );
    }

    expect(cursor).toBeNull();
    // Nothing is named "code", so every hit ranks alike and title order rules.
    expect(seen).toEqual([civilCodeCurrent, civilCodeEnglish, labourCode]);
  });

  test("rejects the retired title cursor protocol", async () => {
    const legacyCursor = encodePaginationCursor([
      "title-prefix-v1",
      "Labour Code",
      labourCode,
    ]);
    const result = await listStatutesHandler(
      { country: "CZE", cursor: legacyCursor, limit: 1 },
      legislationDb,
    );

    expect(result).not.toHaveProperty("items");
    expect(result).toMatchObject({
      code: 400,
      response: { message: "Invalid cursor" },
    });
  });

  test("rejects a cursor from the other ordering", async () => {
    const searchCursor = encodePaginationCursor([
      LEGISLATION_LIST_CURSOR_KIND.search,
      "1",
      "Labour Code",
      labourCode,
    ]);
    const result = await listStatutesHandler(
      { country: "CZE", cursor: searchCursor, limit: 1 },
      legislationDb,
    );

    expect(result).not.toHaveProperty("items");
    expect(result).toMatchObject({
      code: 400,
      response: { message: "Invalid cursor" },
    });
  });

  test("rejects a cursor outside either protocol", async () => {
    // A date that is well-formed but not a calendar day would otherwise
    // reach the `::date` cast and surface as a server error.
    const forgedDate = encodePaginationCursor([
      LEGISLATION_LIST_CURSOR_KIND.recent,
      "2026-99-99",
      labourCode,
    ]);
    for (const cursor of ["not-a-cursor", forgedDate]) {
      const result = await listStatutesHandler(
        { country: "CZE", cursor },
        legislationDb,
      );

      expect(result).not.toHaveProperty("items");
      expect(result).toMatchObject({
        code: 400,
        response: { message: "Invalid cursor" },
      });
    }
  });

  test("the title fold agrees with the client-side fold", async () => {
    const latinText = fc.string({
      unit: fc.constantFrom(
        ..."aábcčdďeéěfghiíjklľĺmnňoóôöőpqrřsštťuúůüűvwxyýzžAÁČĎÉĚÍŇÓŘŠŤÚŮÝŽłŁßøØæÆ 0123456789/.,()-".split(
          "",
        ),
      ),
      maxLength: 40,
    });
    await fc.assert(
      fc.asyncProperty(latinText, async (text) => {
        const folded = await legislationDb(async (tx) => {
          const [row] = await tx
            .select({ folded: sql<string>`legislation_title_fold(${text})` })
            .from(legislationSources)
            .limit(1);
          return row?.folded;
        });

        expect(folded).toBe(foldToAscii(text).toLowerCase());
      }),
      propertyConfig({ numRuns: 40 }),
    );
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
    expect(result).toMatchObject({
      code: 404,
      response: { message: "Legislation document not found" },
    });
  });
});

describe("public statute read", () => {
  test("keeps the stored publisher metadata off the public response", async () => {
    const workspaceRead = await readLegislationHandler(
      civilCodeCurrent,
      workspaceDb,
    );
    const publicRead = await readPublicLegislationHandler(
      civilCodeCurrent,
      legislationDb,
    );

    // The fixture must actually carry metadata, or the omission proves nothing.
    expect(workspaceRead).toHaveProperty("metadata", {
      publisherNote: "not for public display",
    });
    expect(publicRead).not.toHaveProperty("metadata");
    expect(publicRead).toHaveProperty("title", "Civil Code");
  });

  test("returns full text only as the AST fallback", async () => {
    const workspaceRead = await readLegislationHandler(
      civilCodeCurrent,
      workspaceDb,
    );
    const structuredPublicRead = await readPublicLegislationHandler(
      civilCodeCurrent,
      legislationDb,
    );
    const plainPublicRead = await readPublicLegislationHandler(
      civilCodeEnglish,
      legislationDb,
    );

    expect(workspaceRead).toHaveProperty(
      "fulltext",
      "The duplicate plain-text consolidation.",
    );
    expect(structuredPublicRead).toHaveProperty("fulltext", null);
    expect(plainPublicRead).toHaveProperty(
      "fulltext",
      "The English plain-text consolidation.",
    );
  });

  test("reads as not found for a source not cleared for redistribution", async () => {
    const result = await readPublicLegislationHandler(
      withheldAct,
      legislationDb,
    );

    expect(result).toMatchObject({
      code: 404,
      response: { message: "Legislation document not found" },
    });
  });
});

describe("point-in-time statute read", () => {
  test("returns the version whose window covers the date", async () => {
    expect(expectDocumentId(await readAsOf("2015-06-01"))).toBe(
      civilCodeSuperseded,
    );
  });

  test("counts the opening boundary as covered", async () => {
    expect(expectDocumentId(await readAsOf("2014-01-01"))).toBe(
      civilCodeSuperseded,
    );
  });

  test("counts the closing boundary as already elapsed", async () => {
    // Half-open validity: the closing date is the first day the version no
    // longer applies. The Sunset Act has no successor, so nothing else can
    // answer for it and the boundary alone decides.
    expect(expectDocumentId(await readEliAsOf("CZ/1998/222", yesterday))).toBe(
      sunsetAct,
    );
    expect(await readEliAsOf("CZ/1998/222", today)).toMatchObject({
      code: 404,
      response: {
        message:
          "No version of this legislation was in force on the given date",
      },
    });
  });

  test("prefers the latest opening when several windows cover the date", async () => {
    // Both the 2016 and the 2020 consolidation are open-ended.
    expect(expectDocumentId(await readAsOf("2021-01-01"))).toBe(
      civilCodeCurrent,
    );
  });

  test("reads the text in force today without a date", async () => {
    expect(expectDocumentId(await readAsOf(undefined))).toBe(civilCodeCurrent);
  });

  test("reads as not found before the corpus covers the work", async () => {
    expect(await readAsOf("2013-01-01")).toMatchObject({
      code: 404,
      response: {
        message:
          "No version of this legislation was in force on the given date",
      },
    });
  });

  test("narrows to one language", async () => {
    expect(expectDocumentId(await readAsOf("2021-01-01", "en"))).toBe(
      civilCodeEnglish,
    );
  });

  test("reads as not found for an unknown identifier", async () => {
    const result = await readStatuteByEliHandler(
      { eli: "CZ/1900/1" },
      legislationDb,
    );

    expect(result).toMatchObject({
      code: 404,
      response: { message: "Legislation document not found" },
    });
  });

  test("reads as not found for a source not cleared for redistribution", async () => {
    const result = await readStatuteByEliHandler(
      { eli: "CZ/1999/111" },
      legislationDb,
    );

    expect(result).toMatchObject({
      code: 404,
      response: { message: "Legislation document not found" },
    });
  });

  test("keeps the stored publisher metadata off the response", async () => {
    const result = await readAsOf("2021-01-01");

    expect(expectDocumentId(result)).toBe(civilCodeCurrent);
    expect(result).not.toHaveProperty("metadata");
  });
});

describe("provision history", () => {
  test("returns the provision's own text per version, newest window first", async () => {
    const page = expectHistoryPage(
      await readProvisionHistoryHandler({
        documentId: civilCodeCurrent,
        anchor: DELIVERY_ANCHOR,
        query: {},
        legislationDb,
      }),
    );

    expect(page.items.map((item) => item.documentId)).toEqual([
      civilCodeCurrent,
      civilCodeOpenOlder,
      civilCodeSuperseded,
    ]);
    // The neighbouring section is a sibling heading, so it ends the provision.
    expect(page.items.map((item) => item.text)).toEqual([
      `${SECTION_SIGN} 2079\nThe seller shall deliver within fourteen days.`,
      `${SECTION_SIGN} 2079\nThe seller shall deliver within thirty days.`,
      `${SECTION_SIGN} 2079\nThe seller shall deliver within thirty days.`,
    ]);
  });

  test("drops the version in which the provision is repealed", async () => {
    const page = expectHistoryPage(
      await readProvisionHistoryHandler({
        documentId: civilCodeCurrent,
        anchor: DELIVERY_ANCHOR,
        query: {},
        legislationDb,
      }),
    );

    // The future consolidation is in the walked version range and still has
    // to be absent from the answer.
    expect(page.items.map((item) => item.documentId)).not.toContain(
      civilCodeFuture,
    );
  });

  test("reads as not found for an anchor no version carries", async () => {
    const result = await readProvisionHistoryHandler({
      documentId: civilCodeCurrent,
      anchor: UNKNOWN_ANCHOR,
      query: {},
      legislationDb,
    });

    expect(result).toMatchObject({
      code: 404,
      response: { message: "Provision not found" },
    });
  });

  test("reads as not found for a source not cleared for redistribution", async () => {
    const result = await readProvisionHistoryHandler({
      documentId: withheldAct,
      anchor: DELIVERY_ANCHOR,
      query: {},
      legislationDb,
    });

    expect(result).toMatchObject({
      code: 404,
      response: { message: "Legislation document not found" },
    });
  });

  test("walks every carrying version exactly once across cursor pages", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let request = 0; request < 6; request += 1) {
      const page: ProvisionHistoryPage = expectHistoryPage(
        await readProvisionHistoryHandler({
          documentId: civilCodeCurrent,
          anchor: DELIVERY_ANCHOR,
          query: { limit: 1, ...(cursor === null ? {} : { cursor }) },
          legislationDb,
        }),
      );

      seen.push(...page.items.map((item) => item.documentId));
      cursor = page.nextCursor;

      if (cursor === null) {
        break;
      }
    }

    expect(cursor).toBeNull();
    expect(seen).toEqual([
      civilCodeCurrent,
      civilCodeOpenOlder,
      civilCodeSuperseded,
    ]);
  });
});
