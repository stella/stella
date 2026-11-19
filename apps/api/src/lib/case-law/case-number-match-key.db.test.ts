import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { propertySeed } from "@stll/property-testing";

import {
  caseNumberMatchKey,
  caseNumberMatchKeySql,
} from "@/api/lib/case-law/case-number-match-key";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The match key is derived in two runtimes: `caseNumberMatchKey` in
 * TypeScript and `caseNumberMatchKeySql` in the expression indexes on the
 * key columns and the comparisons that will read them. They are proved equal here
 * against a real PostgreSQL, over the shapes that sit on the boundary of the
 * year tail and a sample of keys drawn around it.
 * `case-number-match-key-indexes.db.test.ts` holds the indexes built on it to
 * the schema.
 */

const BOUNDARY_KEYS: readonly string[] = [
  "c-679/2018",
  "c-679/18",
  "c-679/2018-1",
  "c-679/18-1",
  "ivús452/2011",
  "ivús452/11",
  "24csp/61/2026",
  "p.20056/2005/52",
  "88-1048",
  "c-158/21",
  // The century bounds of the tail.
  "4as/1899",
  "4as/1900",
  "4as/1999",
  "4as/2000",
  "4as/2099",
  "4as/2100",
  // Three and five digits, no slash, a dash before the year.
  "4as/201",
  "4as/20181",
  "4as2018",
  "4as-2018",
  // An empty or spaced sheet is no sheet.
  "c-679/2018-",
  "c-679/2018 - 1",
  "c-679/2018-0012",
  // Non-ASCII digits, which PostgreSQL's \d would read as digits.
  "4as/٢٠١٨",
  "4as/２０１８",
  "/2018",
  "",
  "ŽaLOBA/2018",
  "nss/2018\n",
];

const keyArbitrary = fc.oneof(
  fc
    .tuple(
      fc.stringMatching(/^[a-zà-ž0-9. /-]{0,20}$/u),
      fc.integer({ min: 1890, max: 2110 }),
      fc.constantFrom("", "-", "-1", "-33", "a", " ", "/4"),
    )
    .map(([head, year, tail]) => `${head}/${String(year)}${tail}`),
  fc.string({ maxLength: 24 }),
  // Any text a column can hold: PostgreSQL text admits no NUL.
  fc
    .string({ unit: "grapheme", maxLength: 24 })
    .filter((key) => !key.includes("\u0000")),
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const readString = (row: unknown, key: string): string => {
  const value = isRecord(row) ? row[key] : undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${key} did not render as text`);
  }
  return value;
};

// timeout: booting the full PGlite schema can exceed the default hook budget.
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

const foldInSql = async (keys: readonly string[]) => {
  const result = await db.execute(sql`
    SELECT k.key AS "key", ${caseNumberMatchKeySql(sql.raw("k.key"))} AS "folded"
      FROM unnest(ARRAY[${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[]) WITH ORDINALITY AS k(key, position)
     ORDER BY k.position
  `);
  return executedRows(result).map((row) => ({
    key: readString(row, "key"),
    folded: readString(row, "folded"),
  }));
};

test("the SQL rendering and caseNumberMatchKey fold every boundary key alike", async () => {
  const rows = await foldInSql(BOUNDARY_KEYS);
  expect(rows.map(({ key }) => key)).toEqual([...BOUNDARY_KEYS]);
  for (const { key, folded } of rows) {
    expect([key, folded]).toEqual([key, caseNumberMatchKey(key)]);
  }
  // Non-vacuity: the sample holds keys the fold changes and keys it keeps.
  expect(rows.filter(({ key, folded }) => key !== folded).length).toBe(11);
});

test("the SQL rendering and caseNumberMatchKey agree on sampled keys", async () => {
  const keys = fc.sample(keyArbitrary, { numRuns: 500, seed: propertySeed() });
  const rows = await foldInSql(keys);
  expect(rows).toHaveLength(keys.length);
  for (const { key, folded } of rows) {
    expect([key, folded]).toEqual([key, caseNumberMatchKey(key)]);
  }
});
