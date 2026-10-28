import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { statuteEliParts } from "@stll/api-contract/statute-act-number";
import {
  STATUTE_LIST_SORT_NEEDS_YEAR_CODE,
  STATUTE_LIST_SORT_ORDERS,
  STATUTE_LIST_SORTS,
} from "@stll/api-contract/statute-list-sort";
import type { StatuteListSort } from "@stll/api-contract/statute-list-sort";

import {
  caseLawSources,
  caseLawStatuteCitationCounts,
  caseLawStatuteCitationCountState,
  legislationDocuments,
  legislationSources,
  STATUTE_CITATION_COUNT_STATE_KEY,
  STATUTE_CITATION_COUNT_STATUS,
  STATUTE_CITATION_TARGET_TYPE,
} from "@/api/db/schema";
import {
  buildListStatutesQuery,
  listStatutesHandler,
} from "@/api/handlers/legislation/list";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";

/**
 * Ordering the statute list by a column: every order agrees with the values
 * the rows display, Works without a value come last either way, a walk of
 * pages reads the order whole, and the order is served only over one year's
 * acts, whose size alone bounds what it computes.
 */

const YEAR = 2012;
const sourceId = createSafeId<"legislationSource">();
const caseLawSourceId = createSafeId<"caseLawSource">();

type WorkSeed = {
  number: number;
  /** Each version's opening; the last is open-ended. */
  openings: readonly string[];
  /** Decisions citing the Work; none when absent. */
  citedBy?: number;
};

/**
 * The year's acts. Ties are deliberate (two cited five times, two never
 * amended), so the id tiebreak is exercised, and two Works were never
 * amended, so the last-amended order has values to put last.
 */
const YEAR_WORKS: readonly WorkSeed[] = [
  {
    number: 89,
    openings: ["2014-01-01", "2016-01-01", "2020-01-01"],
    citedBy: 5,
  },
  { number: 7, openings: ["2012-06-01"] },
  { number: 120, openings: ["2013-01-01", "2015-07-01"], citedBy: 5 },
  { number: 45, openings: ["2012-03-01"], citedBy: 12 },
  {
    number: 300,
    openings: ["2012-09-01", "2013-09-01", "2018-01-01", "2021-01-01"],
    citedBy: 1,
  },
];

const eliFor = (year: number, number: number) =>
  `https://example.test/eli/cz/sb/${String(year)}/${String(number)}`;

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let legislationDb: LegislationReadDb;

/** Works of other years: what a year-bounded order must never compute. */
const seedOtherYears = async (works: number, firstNumber: number) => {
  // Years 1990–1999 and numbers that never spell the order's year, so no
  // other Work can match the year filter.
  await db.execute(sql`
    INSERT INTO ${legislationDocuments}
      (id, source_id, eli, title, country, language, version_valid_from, version_valid_to)
    SELECT gen_random_uuid(), ${sourceId}::uuid,
      'https://example.test/eli/cz/sb/' || (1990 + n % 10)::text || '/' || n::text,
      'Other act ' || n::text, 'CZE', 'cs',
      DATE '2000-01-01' + v, CASE WHEN v = 0 THEN DATE '2000-01-02' END
    FROM generate_series(${firstNumber}::integer, ${firstNumber + works - 1}::integer) AS n
    CROSS JOIN generate_series(0, 1) AS v
  `);
  await db.execute(sql`ANALYZE ${legislationDocuments}`);
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.execute(sql.raw("SET TIME ZONE 'UTC'"));
  await db
    .insert(legislationSources)
    .values({ id: sourceId, adapterKey: "statutes-open", name: "Open" });
  await db.insert(legislationDocuments).values(
    YEAR_WORKS.flatMap((work) =>
      work.openings.map((opening, index) => ({
        id: createSafeId<"legislationDocument">(),
        sourceId,
        eli: eliFor(YEAR, work.number),
        title: `Act ${String(work.number)}/${String(YEAR)}`,
        country: "CZE",
        language: "cs",
        documentType: "zákon",
        versionValidFrom: opening,
        versionValidTo: work.openings[index + 1] ?? null,
      })),
    ),
  );
  await db
    .insert(caseLawSources)
    .values({ id: caseLawSourceId, adapterKey: "courts-open", name: "Courts" });
  await db.insert(caseLawStatuteCitationCounts).values(
    YEAR_WORKS.flatMap((work) =>
      work.citedBy === undefined
        ? []
        : [
            {
              sourceId: caseLawSourceId,
              jurisdiction: "CZE",
              workEli: eliFor(YEAR, work.number),
              targetType: STATUTE_CITATION_TARGET_TYPE.WORK,
              anchor: "",
              decisionCount: work.citedBy,
            },
          ],
    ),
  );
  await db.insert(caseLawStatuteCitationCountState).values({
    key: STATUTE_CITATION_COUNT_STATE_KEY,
    status: STATUTE_CITATION_COUNT_STATUS.READY,
  });
  await seedOtherYears(20, 1);

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

type ListedStatute = {
  id: string;
  eli: string;
  amendmentCount: number;
  citationCaseCount: number | null;
  firstVersionValidFrom: string | null;
  lastAmendedOn: string | null;
};

const readPage = async (query: Parameters<typeof listStatutesHandler>[0]) => {
  const page = await listStatutesHandler(query, legislationDb);
  if (!("items" in page)) {
    return panic(
      `The statute list refused the request: ${JSON.stringify(page)}`,
    );
  }
  return page;
};

/** Every page of an order, walked by its cursors. */
const walk = async (sort: StatuteListSort): Promise<ListedStatute[]> => {
  const listed: ListedStatute[] = [];
  let cursor: string | undefined;
  // At most one page per Work: a walk that runs longer never ends.
  for (const _bound of YEAR_WORKS) {
    // db-await-in-loop: a keyset walk needs each page's cursor for the next.
    const page = await readPage({
      country: "CZE",
      year: YEAR,
      sort,
      limit: 2,
      ...(cursor === undefined ? {} : { cursor }),
    });
    listed.push(...page.items);
    if (page.nextCursor === null) {
      return listed;
    }
    cursor = page.nextCursor;
  }
  return panic(`The ${sort} walk did not end`);
};

/** What a row displays for the order's column, as the order compares it. */
const displayedKey = (
  sort: StatuteListSort,
  row: ListedStatute,
): number | string | null => {
  switch (STATUTE_LIST_SORT_ORDERS[sort].key) {
    case "actNumber": {
      const { number } = statuteEliParts(row.eli);
      return number === null ? null : Number(number);
    }
    case "firstVersion":
      return row.firstVersionValidFrom;
    case "amendments":
      return row.amendmentCount;
    case "lastAmended":
      return row.lastAmendedOn;
    case "citedBy":
      return row.citationCaseCount;
    default:
      return panic("Unhandled statute list sort key");
  }
};

const compareKeys = (left: number | string, right: number | string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** The order the rows' own values give: nulls last, then the id. */
const expectedOrder = (
  sort: StatuteListSort,
  rows: readonly ListedStatute[],
): string[] => {
  const sign = STATUTE_LIST_SORT_ORDERS[sort].direction === "desc" ? -1 : 1;
  return rows
    .toSorted((left, right) => {
      const a = displayedKey(sort, left);
      const b = displayedKey(sort, right);
      if (a === null || b === null) {
        if (a === b) {
          return sign * compareKeys(left.id, right.id);
        }
        return a === null ? 1 : -1;
      }
      return sign * compareKeys(a, b) || sign * compareKeys(left.id, right.id);
    })
    .map((row) => row.id);
};

describe("ordering the statute list by a column", () => {
  test("the fixture holds ties and Works without a value", async () => {
    const page = await readPage({ country: "CZE", year: YEAR });
    expect(page.items).toHaveLength(YEAR_WORKS.length);
    const cited = page.items.map((row) => row.citationCaseCount);
    expect(cited.filter((count) => count === 5)).toHaveLength(2);
    expect(page.items.filter((row) => row.lastAmendedOn === null)).toHaveLength(
      2,
    );
  });

  test.each(STATUTE_LIST_SORTS.map((sort) => [sort]))(
    "%s walks the year's acts in the order their values give",
    async (sort) => {
      const unordered = (await readPage({ country: "CZE", year: YEAR })).items;
      const walked = await walk(sort);
      expect(walked.map((row) => row.id)).toEqual(
        expectedOrder(sort, unordered),
      );
    },
  );

  test("Works never amended come last in both directions", async () => {
    for (const sort of ["lastAmended-asc", "lastAmended-desc"] as const) {
      // db-await-in-loop: two orders, each one walk.
      const walked = await walk(sort);
      expect(walked.slice(-2).map((row) => row.lastAmendedOn)).toEqual([
        null,
        null,
      ]);
    }
  });

  test("an order without a year is refused with its code", async () => {
    const answer = await listStatutesHandler(
      { country: "CZE", sort: "amendments-desc" },
      legislationDb,
    );
    expect(answer).toMatchObject({
      code: 400,
      response: { code: STATUTE_LIST_SORT_NEEDS_YEAR_CODE },
    });
  });

  test("a cursor continues only the order it was cut for", async () => {
    const first = await readPage({
      country: "CZE",
      year: YEAR,
      sort: "amendments-desc",
      limit: 2,
    });
    const cursor = first.nextCursor ?? panic("The first page has no cursor");
    for (const query of [
      { sort: "amendments-asc" as const },
      { sort: undefined },
    ]) {
      // db-await-in-loop: two refusals, each one read.
      const answer = await listStatutesHandler(
        { country: "CZE", year: YEAR, cursor, ...query },
        legislationDb,
      );
      expect(answer).toMatchObject({ code: 400 });
    }
  });
});

const planNodes = (
  root: Record<string, unknown>,
): Record<string, unknown>[] => {
  const children = root["Plans"];
  if (children === undefined) {
    return [root];
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("The list plan has malformed children");
  }
  return [root, ...children.flatMap(planNodes)];
};

/**
 * How many times the amendment count ran: once per Work entering the order
 * (its sort key), and once more per row of the page (its column).
 */
const amendmentCountRuns = async () => {
  const explained = await legislationDb(async (tx) => {
    const statement = buildListStatutesQuery(tx, {
      country: "CZE",
      query: { year: YEAR, sort: "amendments-desc" },
      limit: 2,
      cursor: null,
      asOf: sql`CURRENT_DATE`,
    });
    return await tx.execute(
      sql`EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${statement.getSQL()}`,
    );
  });
  return planNodes(explainRoot(explained))
    .filter((node) => {
      const output = node["Output"];
      return (
        node["Node Type"] === "Aggregate" &&
        isUnknownArray(output) &&
        output.some(
          (value) => typeof value === "string" && value.includes("count(*)"),
        )
      );
    })
    .map((node) => node["Actual Loops"]);
};

describe("a year-bounded order", () => {
  test("computes each of the year's Works once, however many other Works there are", async () => {
    const before = await amendmentCountRuns();
    // The year's five Works each get a sort key; the page's three rows (two
    // and the one that proves a next page) each get their column.
    expect(before.toSorted()).toEqual([3, YEAR_WORKS.length]);

    await seedOtherYears(200, 1000);
    expect(await amendmentCountRuns()).toEqual(before);
  });
});
