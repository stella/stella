import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import {
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
 * The browse walk is newest decision first, one row per multilingual
 * decision, with a keyset cursor that neither repeats nor skips a row across
 * pages. The second line of a row is derived from what the publisher stored.
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

/** Ten dated decisions, one undated, and a CJEU judgment in three languages. */
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
  {
    caseNumber: "undated",
    court: "Nejvyšší soud",
    createdAt: day(20),
    decisionDate: null,
    language: "cs",
    languageGroupKey: null,
  },
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

test(
  "browse pages walk newest first, undated last, one row per multilingual decision, without repeats or gaps",
  async () => {
    const all = await walk(3);
    const dates = all.map((item) => item.decisionDate);

    // Twelve rows: ten dated, the CJEU judgment once, the undated one last.
    expect(all).toHaveLength(12);
    expect(new Set(all.map((item) => item.id)).size).toBe(12);
    expect(dates.at(-1)).toBeNull();
    const dated = dates.slice(0, -1).map((date) => date ?? "");
    expect(dated).toEqual([...dated].toSorted().toReversed());
    const judgment = all.filter((item) => item.caseNumber === "C-131/12");
    expect(judgment).toHaveLength(1);
    expect(judgment[0]?.languageAlternates.map((a) => a.language)).toEqual([
      "cs",
      "en",
      "fr",
    ]);
    // The same walk in one page agrees with the paged walk.
    expect((await walk(50)).map((item) => item.id)).toEqual(
      all.map((item) => item.id),
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test("oldest first walks the dated decisions in exactly the reverse of newest first, ties included, across pages", async () => {
  const newest = await walk(50, "newest");
  const oldest = await walk(1, "oldest");
  const dates = oldest.map((item) => item.decisionDate ?? "");

  // The fixture holds a tie the walk must cross a page boundary inside: the
  // Czech decision and the CJEU judgment share 2024-03-05.
  expect(dates.filter((date) => date === "2024-03-05")).toHaveLength(2);
  expect(dates).toEqual(dates.toSorted());
  expect(new Set(oldest.map((item) => item.id)).size).toBe(oldest.length);
  // A decision the source never dated is not the oldest: the undated band
  // newest first ends with is left out, and nothing else is.
  expect(oldest.some((item) => item.decisionDate === null)).toBe(false);
  expect(oldest.map((item) => item.id)).toEqual(
    newest
      .filter((item) => item.decisionDate !== null)
      .map((item) => item.id)
      .toReversed(),
  );
  // Paged by number, the walk is the same rows in the same order.
  const byOffset = [];
  for (let offset = 0; offset < oldest.length; offset += 4) {
    const result = await listDecisionsHandler(
      { country: "CZE", limit: 4, offset, sort: "oldest" },
      caseLawDb,
      async () => courtWeightMapFromSeed(),
    );
    if (!("items" in result)) {
      throw new Error("list failed");
    }
    byOffset.push(...result.items);
  }
  expect(byOffset.map((item) => item.id)).toEqual(
    oldest.map((item) => item.id),
  );
});

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

test("oldest first lists a dated version whose undated sibling it excludes", async () => {
  const result = await listDecisionsHandler(
    {
      country: "SVK",
      court: "Okresný súd Košice I",
      limit: 10,
      sort: "oldest",
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
  ).toEqual([["5 C 1/2024", "2024-05-02", "en"]]);
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
