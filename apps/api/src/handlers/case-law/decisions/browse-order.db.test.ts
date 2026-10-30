import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import {
  DECISION_LIST_SORTS,
  type DecisionListSort,
  DEFAULT_DECISION_LIST_SORT,
} from "@stll/api-contract/search";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  courtWeightMapFromSeed,
  seededCourtWeightEntries,
} from "@/api/handlers/case-law/court-weight-seed";
import { readLatestDecisionsByCourt } from "@/api/handlers/case-law/decisions/latest";
import { listDecisionsHandler } from "@/api/handlers/case-law/decisions/list";
import { readShelfCourts } from "@/api/handlers/case-law/decisions/shelf-courts";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The browse walk orders by decision date either way, one row per
 * multilingual decision, with undated decisions listed last in both
 * directions and a keyset cursor that neither repeats nor skips a row across
 * pages, the boundary between dated and undated decisions included. The
 * second line of a row is derived from what the publisher stored.
 */

const DB_TEST_TIMEOUT_MS = 120_000;

const sourceId = createSafeId<"caseLawSource">();

type Seed = {
  caseNumber: string;
  court: string;
  country?: string;
  createdAt: Date;
  decisionDate: string | null;
  language: string;
  languageGroupKey: string | null;
  metadata?: Record<string, unknown>;
};

const day = (offset: number) => new Date(2026, 0, 1, 12, 0, offset);

/**
 * Ten dated decisions, three undated, a CJEU judgment in three languages, and
 * a judgment whose first version is undated and whose later one is dated.
 */
const seeds: Seed[] = [
  ...Array.from({ length: 10 }, (_, i) => ({
    caseNumber: `${i + 1} Cdo ${i + 1}/2024`,
    court: "Nejvyšší soud",
    createdAt: day(i),
    decisionDate: `2024-03-${String(i + 1).padStart(2, "0")}`,
    language: "cs",
    languageGroupKey: null,
    metadata:
      i === 0
        ? {
            keywords: ["nájem", "výpověď"],
            legalSentence: "  Právní   věta.  ",
          }
        : { keywords: ["smlouva"] },
  })),
  ...["undated", "undated 2", "undated 3"].map((caseNumber, i) => ({
    caseNumber,
    court: "Nejvyšší soud",
    createdAt: day(20 + i),
    decisionDate: null,
    language: "cs",
    languageGroupKey: null,
  })),
  // The undated version is the judgment's first, so it is the one listed, in
  // the undated band, and the dated version it represents is not listed apart.
  ...[
    { language: "cs", decisionDate: null },
    { language: "en", decisionDate: "2024-03-07" },
  ].map(({ language, decisionDate }, i) => ({
    caseNumber: "T-7/20",
    court: "General Court",
    createdAt: day(60 + i),
    decisionDate,
    language,
    languageGroupKey: "ECLI:EU:T:2021:7",
  })),
  ...["cs", "en", "fr"].map((language, i) => ({
    caseNumber: "C-131/12",
    court: "Court of Justice",
    createdAt: day(30 + i),
    decisionDate: "2024-03-05",
    language,
    languageGroupKey: "ECLI:EU:C:2014:317",
  })),
  // A second jurisdiction whose busiest court is a district court: six newer
  // district judgments against one supreme judgment.
  ...Array.from({ length: 6 }, (_, i) => ({
    caseNumber: `${i + 1} C ${i + 1}/2025`,
    court: "Okresný súd Bratislava I",
    country: "SVK",
    createdAt: day(40 + i),
    decisionDate: `2025-02-${String(i + 1).padStart(2, "0")}`,
    language: "sk",
    languageGroupKey: null,
  })),
  {
    caseNumber: "1 Cdo 9/2024",
    court: "Najvyšší súd Slovenskej republiky",
    country: "SVK",
    createdAt: day(50),
    decisionDate: "2024-12-01",
    language: "sk",
    languageGroupKey: null,
  },
  // One judgment in two languages: the version stored first carries no date,
  // the later translation does.
  {
    caseNumber: "5 C 1/2024",
    court: "Okresný súd Košice I",
    country: "SVK",
    createdAt: day(60),
    decisionDate: null,
    language: "sk",
    languageGroupKey: "SVK:OSKE1:5C1/2024",
  },
  {
    caseNumber: "5 C 1/2024",
    court: "Okresný súd Košice I",
    country: "SVK",
    createdAt: day(61),
    decisionDate: "2024-05-02",
    language: "en",
    languageGroupKey: "SVK:OSKE1:5C1/2024",
  },
];

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  const readDb = async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the reads only use the role transaction's select surface.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      return await fn(tx);
    });
  // SAFETY: brand-only wrapper; the reads never inspect the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  caseLawDb = readDb as unknown as CaseLawPublicReadDb;

  await db
    .insert(caseLawSources)
    .values([
      caseLawSourceRow({ adapterKey: "browse", id: sourceId, name: "browse" }),
    ]);
  await db.insert(caseLawDecisions).values(
    seeds.map((seed) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: seed.caseNumber,
      court: seed.court,
      country: seed.country ?? "CZE",
      language: seed.language,
      languageGroupKey: seed.languageGroupKey,
      decisionDate: seed.decisionDate,
      createdAt: seed.createdAt,
      metadata: seed.metadata ?? {},
    })),
  );
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

const walk = async (
  limit: number,
  sort: DecisionListSort = DEFAULT_DECISION_LIST_SORT,
) => {
  const items = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await listDecisionsHandler(
      {
        country: "CZE",
        limit,
        sort,
        ...(cursor === undefined ? {} : { cursor }),
      },
      caseLawDb,
      // The registry as the seed migration writes it: this harness holds the
      // public reader alone, and the loader reads the root pool.
      async () => courtWeightMapFromSeed(),
    );
    if (!("items" in result)) {
      throw new Error("list failed");
    }
    items.push(...result.items);
    if (result.nextCursor === null) {
      break;
    }
    cursor = result.nextCursor;
  }
  return items;
};

/** The walk paged by number instead of by cursor. */
const walkByOffset = async (limit: number, sort: DecisionListSort) => {
  const items = [];
  for (let offset = 0; offset < 40; offset += limit) {
    const result = await listDecisionsHandler(
      { country: "CZE", limit, offset, sort },
      caseLawDb,
      async () => courtWeightMapFromSeed(),
    );
    if (!("items" in result)) {
      throw new Error("list failed");
    }
    items.push(...result.items);
    if (result.items.length < limit) {
      break;
    }
  }
  return items;
};

type ListedItem = Awaited<ReturnType<typeof walk>>[number];

/**
 * The date order, stated without SQL: dated decisions by date in the order's
 * direction, then undated ones, each tie broken by id in the same direction.
 */
const inDateOrder = (items: readonly ListedItem[], sort: DecisionListSort) => {
  const sign = sort === "newest" ? -1 : 1;
  const compare = (a: string, b: string) => Number(a > b) - Number(a < b);
  return items.toSorted((a, b) => {
    if ((a.decisionDate === null) !== (b.decisionDate === null)) {
      return a.decisionDate === null ? 1 : -1;
    }
    return (
      sign * compare(a.decisionDate ?? "", b.decisionDate ?? "") ||
      sign * compare(a.id, b.id)
    );
  });
};

/** Fifteen judgments, four of them listed undated. */
const LISTED = 15;
const UNDATED = 4;

// timeout: each read runs through the embedded Postgres under the reader role.
test.each(DECISION_LIST_SORTS)(
  "%s first lists every judgment once, dated in order and undated last, without repeats or gaps",
  async (sort) => {
    const all = await walk(50, sort);

    expect(all).toHaveLength(LISTED);
    expect(new Set(all.map((item) => item.id)).size).toBe(LISTED);
    expect(all.map((item) => item.id)).toEqual(
      inDateOrder(all, sort).map((item) => item.id),
    );
    expect(
      all.slice(-UNDATED).every((item) => item.decisionDate === null),
    ).toBe(true);
    // The fixture holds a tie the order must break by id: the Czech decision
    // and the CJEU judgment share 2024-03-05.
    expect(
      all.filter((item) => item.decisionDate === "2024-03-05"),
    ).toHaveLength(2);
    const judgment = all.filter((item) => item.caseNumber === "C-131/12");
    expect(judgment).toHaveLength(1);
    expect(judgment[0]?.languageAlternates.map((a) => a.language)).toEqual([
      "cs",
      "en",
      "fr",
    ]);
    // A judgment first published undated is listed once, as that version, in
    // the undated band of either order: never hidden behind its dated version.
    const firstUndated = all.filter((item) => item.caseNumber === "T-7/20");
    expect(firstUndated.map((item) => item.decisionDate)).toEqual([null]);
  },
  DB_TEST_TIMEOUT_MS,
);

test("oldest first is newest first with each band reversed, the undated band staying last", async () => {
  const newest = await walk(50, "newest");
  const oldest = await walk(50, "oldest");
  const reversedBands = [
    ...newest.filter((item) => item.decisionDate !== null).toReversed(),
    ...newest.filter((item) => item.decisionDate === null).toReversed(),
  ];

  expect(oldest.map((item) => item.id)).toEqual(
    reversedBands.map((item) => item.id),
  );
});

// Every page size puts the page boundary at a different place, so together
// they cross the dated/undated boundary at every offset: as the last row of a
// page, the first, and inside one, by cursor and by page number alike.
// timeout: about a hundred page reads per order on the embedded Postgres.
test.each(DECISION_LIST_SORTS)(
  "%s first pages to the same walk at every page size, across the dated/undated boundary",
  async (sort) => {
    const expected = (await walk(50, sort)).map((item) => item.id);
    for (let limit = 1; limit <= LISTED; limit += 1) {
      expect((await walk(limit, sort)).map((item) => item.id)).toEqual(
        expected,
      );
      expect((await walkByOffset(limit, sort)).map((item) => item.id)).toEqual(
        expected,
      );
    }
  },
  DB_TEST_TIMEOUT_MS,
);

// timeout: each read runs through the embedded Postgres under the reader role.
test.each(DECISION_LIST_SORTS)(
  "a %s-first page that ends on the last dated decision continues with the first undated one",
  async (sort) => {
    const all = await walk(50, sort);
    const datedCount = LISTED - UNDATED;
    const first = await listDecisionsHandler(
      { country: "CZE", limit: datedCount, sort },
      caseLawDb,
      async () => courtWeightMapFromSeed(),
    );
    if (!("items" in first) || first.nextCursor === null) {
      throw new Error("list failed");
    }
    expect(first.items.at(-1)?.decisionDate).not.toBeNull();
    const next = await listDecisionsHandler(
      { country: "CZE", limit: 1, sort, cursor: first.nextCursor },
      caseLawDb,
      async () => courtWeightMapFromSeed(),
    );
    if (!("items" in next)) {
      throw new Error("list failed");
    }
    const firstUndated = all.at(datedCount);
    if (firstUndated === undefined) {
      throw new Error("the walk listed no undated decision");
    }
    expect(next.items.map((item) => item.id)).toEqual([firstUndated.id]);
    expect(next.items[0]?.decisionDate).toBeNull();
  },
  DB_TEST_TIMEOUT_MS,
);

test("a cursor resumes only the order that issued it", async () => {
  const page = async (sort: DecisionListSort, cursor?: string) =>
    await listDecisionsHandler(
      {
        country: "CZE",
        limit: 2,
        sort,
        ...(cursor === undefined ? {} : { cursor }),
      },
      caseLawDb,
      async () => courtWeightMapFromSeed(),
    );
  for (const [issuer, reader] of [
    ["newest", "oldest"],
    ["oldest", "newest"],
  ] as const) {
    const first = await page(issuer);
    if (!("items" in first) || first.nextCursor === null) {
      throw new Error("list failed");
    }
    expect("items" in (await page(issuer, first.nextCursor))).toBe(true);
    expect("items" in (await page(reader, first.nextCursor))).toBe(false);
  }
});

test(
  "the headnote is the legal sentence first, else the terms it was filed under",
  async () => {
    const all = await walk(50);
    const first = all.find((item) => item.caseNumber === "1 Cdo 1/2024");
    const second = all.find((item) => item.caseNumber === "2 Cdo 2/2024");
    const undated = all.find((item) => item.caseNumber === "undated");

    expect(first?.headnote).toEqual({
      type: "present",
      text: "Právní věta.",
      truncated: false,
    });
    // A classification stays a list of terms all the way to the row, so the
    // cell can draw tags rather than a sentence the court never wrote.
    expect(second?.headnote).toEqual({
      type: "keywords",
      items: ["smlouva"],
      omitted: 0,
    });
    expect(undated?.headnote).toEqual({
      type: "absent",
      reason: "not_published",
    });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "date bounds are inclusive and an upper bound alone leaves undated decisions out",
  async () => {
    const caseNumbers = async (bounds: {
      dateFrom?: string;
      dateTo?: string;
    }) => {
      const result = await listDecisionsHandler(
        { country: "CZE", limit: 50, ...bounds },
        caseLawDb,
        async () => courtWeightMapFromSeed(),
      );
      if (!("items" in result)) {
        throw new Error("list failed");
      }
      return result.items.map((item) => item.caseNumber);
    };

    expect(await caseNumbers({ dateTo: "2024-03-02" })).toEqual([
      "2 Cdo 2/2024",
      "1 Cdo 1/2024",
    ]);
    expect(await caseNumbers({ dateFrom: "2024-03-09" })).toEqual([
      "10 Cdo 10/2024",
      "9 Cdo 9/2024",
    ]);
    // One day: the Czech decision, and the CJEU judgment once.
    expect(
      (
        await caseNumbers({ dateFrom: "2024-03-05", dateTo: "2024-03-05" })
      ).toSorted(),
    ).toEqual(["5 Cdo 5/2024", "C-131/12"]);
    expect(await caseNumbers({ dateFrom: "2024-04-01" })).toEqual([]);
  },
  DB_TEST_TIMEOUT_MS,
);

// The group's first-stored version represents it in both orders, so an
// undated first version lists the group once, with the undated, rather than
// hiding it from the order that ends with them.
test("a language group whose first version is undated lists once in either order", async () => {
  for (const sort of ["newest", "oldest"] as const) {
    const result = await listDecisionsHandler(
      {
        country: "SVK",
        court: "Okresný súd Košice I",
        limit: 10,
        sort,
      },
      caseLawDb,
      async () => courtWeightMapFromSeed(),
    );
    if (!("items" in result)) {
      throw new Error("list failed");
    }
    expect(
      result.items.map(({ caseNumber, decisionDate, language }) => [
        caseNumber,
        decisionDate,
        language,
      ]),
    ).toEqual([["5 C 1/2024", null, "sk"]]);
  }
});

test(
  "a tampered cursor is rejected, not silently restarted",
  async () => {
    const result = await listDecisionsHandler(
      { country: "CZE", cursor: "not-a-cursor" },
      caseLawDb,
      async () => courtWeightMapFromSeed(),
    );
    expect("items" in result).toBe(false);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the shelf lists each court's newest decisions once per judgment",
  async () => {
    const shelf = await readLatestDecisionsByCourt({
      caseLawDb,
      country: "CZE",
      courts: [
        { court: "Nejvyšší soud", tierLabel: "supreme" },
        { court: "Court of Justice", tierLabel: "constitutional" },
        { court: "No such court", tierLabel: "supreme" },
      ],
    });
    // A court without decisions is left off the shelf, not shown empty.
    expect(shelf.map((group) => [group.court, group.tierLabel])).toEqual([
      ["Nejvyšší soud", "supreme"],
      ["Court of Justice", "constitutional"],
    ]);
    const byCourt = new Map(
      shelf.map((group) => [group.court, group.decisions]),
    );
    const supreme = byCourt.get("Nejvyšší soud");
    const cjeu = byCourt.get("Court of Justice");

    expect(supreme?.map((d) => d.decisionDate)).toEqual([
      "2024-03-10",
      "2024-03-09",
      "2024-03-08",
      "2024-03-07",
      "2024-03-06",
    ]);
    expect(cjeu).toHaveLength(1);
    expect(cjeu?.[0]?.languageAlternates).toHaveLength(3);
  },
  DB_TEST_TIMEOUT_MS,
);

/** The facets a jurisdiction has none of; the shelf orders by name instead. */
const noFacets = async (): Promise<LegalBrowseFacets> => ({
  country: [],
  court: [],
  year: [],
});

test(
  "the shelf's courts are the jurisdiction's apex courts, not its busiest",
  async () => {
    const courts = await readShelfCourts({
      caseLawDb,
      country: "SVK",
      entries: seededCourtWeightEntries("SVK"),
      readFacets: noFacets,
    });
    // Six district judgments outnumber the one supreme judgment; rank wins.
    expect(courts).toEqual([
      { court: "Najvyšší súd Slovenskej republiky", tierLabel: "supreme" },
    ]);
    const shelf = await readLatestDecisionsByCourt({
      caseLawDb,
      country: "SVK",
      courts,
    });
    expect(
      shelf.map((group) => group.decisions.map((d) => d.caseNumber)),
    ).toEqual([["1 Cdo 9/2024"]]);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a court the facets do not list still reaches the shelf",
  async () => {
    const courts = await readShelfCourts({
      caseLawDb,
      country: "SVK",
      entries: seededCourtWeightEntries("SVK"),
      // The facet cap holds the jurisdiction's largest courts, which an apex
      // court need not be among: the buckets order the shelf, never fill it.
      readFacets: async () => ({
        country: [],
        court: [{ value: "Okresný súd Bratislava I", count: 6 }],
        year: [],
      }),
    });
    expect(courts).toEqual([
      { court: "Najvyšší súd Slovenskej republiky", tierLabel: "supreme" },
    ]);
  },
  DB_TEST_TIMEOUT_MS,
);
