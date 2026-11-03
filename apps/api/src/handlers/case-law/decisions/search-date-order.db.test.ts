import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawDecisions,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { searchPostgresDecisions } from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The Postgres search's `newest` order follows the rule every date order
 * does: undated decisions are listed, after every dated one, and its cursor
 * crosses from the dated to the undated decisions without a repeat or a gap.
 */

// timeout: Boot the shared PGlite engine and complete schema before assertions.
setDefaultTimeout(120_000);

const WORD = "zqxdateorder";
const sourceId = createSafeId<"caseLawSource">();

/** Five dated decisions, two sharing a day, and three undated ones. */
const DATES = [
  "2021-05-01",
  "2023-01-15",
  "2023-01-15",
  "1994-02-01",
  "2024-12-31",
  null,
  null,
  null,
] as const;

const decisions = DATES.map((decisionDate, i) => ({
  id: createSafeId<"caseLawDecision">(),
  sourceId,
  caseNumber: `${String(i + 1)} Cdo ${String(i + 1)}/2024`,
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  decisionDate,
}));

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  await client.exec(
    "CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)",
  );
  const readDb = async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      const adaptedTx = {
        select: roleTx.select.bind(roleTx),
        query: roleTx.query,
        execute: async (statement: Parameters<typeof roleTx.execute>[0]) => {
          const result = await roleTx.execute(statement);
          // Public SQL readers accept postgres-js arrays and PGlite's rows envelope.
          return Object.assign(result.rows, { rows: result.rows });
        },
      };
      // SAFETY: the role transaction supplies the select surface the reads use.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = adaptedTx as unknown as CaseLawPublicReadTransaction;
      return await fn(tx);
    });
  // SAFETY: brand-only wrapper; the reads never inspect the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  caseLawDb = readDb as unknown as CaseLawPublicReadDb;

  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
  await db.insert(caseLawDecisions).values(decisions);
  await db.insert(caseLawSearchDocuments).values(
    decisions.map(({ id }) => ({
      decisionId: id,
      language: "cs",
      regconfig: "simple",
      searchableText: WORD,
      tsv: sql`to_tsvector('simple', ${WORD})`,
    })),
  );
  resetPublicCaseLawConfigForTesting(caseLawDb);
});

afterAll(async () => {
  resetPublicCaseLawConfigForTesting();
  await client.close();
});

const walkNewest = async (limit: number) => {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await searchPostgresDecisions(
      {
        country: "CZE",
        query: WORD,
        sort: "newest",
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      },
      caseLawDb,
    );
    if (!("hits" in result)) {
      throw new Error("search failed");
    }
    ids.push(...result.hits.map(({ decisionId }) => decisionId));
    if (result.nextCursor === null) {
      return ids;
    }
    cursor = result.nextCursor;
  }
  throw new Error("the walk did not end");
};

/** Code-unit order: dates and ids are compared as keys, not as words. */
const compareKeys = (a: string, b: string) => Number(a > b) - Number(a < b);

/** Dated by date descending, then undated, each tie by id descending. */
const expected = decisions
  .toSorted((a, b) => {
    if ((a.decisionDate === null) !== (b.decisionDate === null)) {
      return a.decisionDate === null ? 1 : -1;
    }
    return (
      compareKeys(b.decisionDate ?? "", a.decisionDate ?? "") ||
      compareKeys(b.id, a.id)
    );
  })
  .map(({ id }) => String(id));

test("newest lists every matching decision, the undated ones last, at every page size", async () => {
  // The fixture holds the tie the order must break by id: two decisions of
  // one day, and three with no day at all.
  expect(new Set(DATES).size).toBeLessThan(DATES.length);
  expect(DATES.filter((date) => date === null)).toHaveLength(3);
  for (let limit = 1; limit <= decisions.length; limit += 1) {
    expect(await walkNewest(limit)).toEqual(expected);
  }
});

test("the total counts the undated decisions the pages list", async () => {
  const result = await searchPostgresDecisions(
    { country: "CZE", query: WORD, sort: "newest", limit: 2 },
    caseLawDb,
  );
  if (!("hits" in result)) {
    throw new Error("search failed");
  }
  expect(result.total).toEqual({ type: "exact", count: decisions.length });
});
