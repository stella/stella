import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  CASE_LAW_INDEX_GROUP_OF,
  caseLawIndexIdSql,
} from "@/api/lib/legal-search/case-law-index-groups";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The physical index id is derived in two runtimes: `corpusIndexId` in
 * TypeScript and `caseLawIndexIdSql` in the queries that decide whether a
 * generation holds a decision. They are proved equal here against a real
 * PostgreSQL, over every declared jurisdiction in both letter cases,
 * countries outside the declaration, and generations on both sides of the
 * grouping threshold, at and past the integer bound, plus one from another
 * family.
 */

const DECLARED: readonly string[] = Object.keys(CASE_LAW_INDEX_GROUP_OF);
const COUNTRIES: readonly string[] = [
  ...DECLARED,
  ...DECLARED.map((country) => country.toLowerCase()),
  // A code that spells a language tag derives an index of its own.
  "PL",
  "HUN",
  "ROU",
  "xyz",
];
const GENERATIONS: readonly string[] = [
  "case_law_v1",
  "case_law_v2",
  "case_law_v3",
  "case_law_v12",
  // The last order the integer cast holds, and the first past it: the former
  // is grouped, the latter stays per country rather than failing the cast.
  "case_law_v2147483647",
  "case_law_v2147483648",
  "legislation_v1",
];

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

/** Rows from `execute` under either driver shape (bare array or `{ rows }`). */
const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const readString = (row: unknown, key: string): string => {
  const value = isRecord(row) ? row[key] : undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${key} did not render as text`);
  }
  return value;
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("the query fragment and corpusIndexId derive the same id", async () => {
  const countryValues = sql.join(
    COUNTRIES.map((country) => sql`(${country}::varchar(3))`),
    sql`, `,
  );
  for (const generation of GENERATIONS) {
    // The generation is a bound parameter and the country a column, the
    // shapes the query layer feeds the fragment.
    const result = await db.execute(sql`
      SELECT c.country AS "country",
             (${caseLawIndexIdSql(sql`${generation}`, sql.raw("c.country"))}) AS "fragment"
        FROM (VALUES ${countryValues}) AS c(country)
    `);
    const rows = executedRows(result);
    expect(rows.length).toBe(COUNTRIES.length);
    for (const row of rows) {
      const country = readString(row, "country");
      expect([generation, country, readString(row, "fragment")]).toEqual([
        generation,
        country,
        corpusIndexId(generation, country),
      ]);
    }
  }
  // Non-vacuity: the grouped form differs from the per-country one where a
  // group holds several countries, and the ungrouped generations keep it.
  expect(corpusIndexId("case_law_v3", "CZE")).toBe("case_law_v3_cs_sk");
  expect(corpusIndexId("case_law_v3", "CZE")).not.toBe("case_law_v3_cze");
  expect(corpusIndexId("case_law_v2", "CZE")).toBe("case_law_v2_cze");
  expect(corpusIndexId("legislation_v1", "CZE")).toBe("legislation_v1_cze");
  expect(corpusIndexId("case_law_v2147483647", "CZE")).toBe(
    "case_law_v2147483647_cs_sk",
  );
  expect(corpusIndexId("case_law_v2147483648", "CZE")).toBe(
    "case_law_v2147483648_cze",
  );
  expect(corpusIndexId("case_law_v3", "PL")).not.toBe(
    corpusIndexId("case_law_v3", "POL"),
  );
});
