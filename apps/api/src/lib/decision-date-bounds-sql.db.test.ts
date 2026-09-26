import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  addUtcDays,
  canonicalDecisionDate,
  toUtcDateString,
} from "@/api/lib/dates";
import {
  CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT,
  decisionDateOutOfBoundsSql,
  decisionDateWithinBoundsSql,
} from "@/api/lib/decision-date-bounds-sql";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The bounds live in three runtimes: the write-path guard in TypeScript, the
 * repair predicate in SQL, and the table's CHECK in DDL. Each pair is proved
 * equal here against a real PostgreSQL rather than by reading the numbers.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260926120300_case_law_decision_date_floor_by_jurisdiction/migration.sql",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const currentYear = new Date().getUTCFullYear();
const day = (offset: number) => toUtcDateString(addUtcDays(new Date(), offset));

/** Both sides of every bound, plus dates far outside them. */
const BOUNDARY_DATES: readonly string[] = [
  "0001-01-01",
  "1168-10-28",
  "1599-12-31",
  "1600-01-01",
  "1700-06-15",
  "1799-12-31",
  "1800-01-01",
  "1800-01-02",
  "2000-06-15",
  day(-1),
  day(0),
  day(1),
  day(2),
  day(30),
  `${String(currentYear + 1)}-12-31`,
  "2944-04-30",
  "9999-12-31",
];

/**
 * One country per floor, and one no jurisdiction declares: the default floor
 * must hold for it on every side.
 */
const COUNTRIES: readonly string[] = ["CZE", "EU", "USA", "ROU"];

const acceptedByGuard = (date: string, country: string): boolean =>
  canonicalDecisionDate(date, country) !== null;

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

/**
 * Every message down the `cause` chain of a rejection, or `""` when the
 * promise settled. The driver wraps a constraint violation in a query error
 * whose own message names the statement, not the constraint.
 */
const rejectionOf = async (run: Promise<void>): Promise<string> => {
  const messages: string[] = [];
  try {
    await run;
  } catch (error: unknown) {
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
  }
  return messages.join("\n");
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db
      .insert(caseLawSources)
      .values([{ id: sourceId, adapterKey: "cz-regional", name: "cz source" }]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("the SQL fragments are each other's negation and agree with the guard", async () => {
  const cases = COUNTRIES.flatMap((country) =>
    BOUNDARY_DATES.map((date) => ({ country, date })),
  );
  const rows = executedRows(
    await db.execute(sql`
      SELECT v.date::text AS "date",
             v.country AS "country",
             ${decisionDateWithinBoundsSql(sql.raw("v.date"), sql.raw("v.country"))} AS "within",
             ${decisionDateOutOfBoundsSql(sql.raw("v.date"), sql.raw("v.country"))} AS "out"
        FROM (VALUES ${sql.join(
          cases.map(
            ({ country, date }) => sql`(${date}::date, ${country}::varchar(3))`,
          ),
          sql`, `,
        )}) AS v(date, country)
    `),
  );
  expect(rows.length).toBe(cases.length);

  const verdicts = new Map<string, boolean>();
  for (const row of rows) {
    if (!isRecord(row)) {
      throw new Error("non-row from VALUES");
    }
    const { country, date, within, out } = row;
    if (typeof date !== "string" || typeof country !== "string") {
      throw new TypeError("date or country did not render as text");
    }
    expect(typeof within).toBe("boolean");
    expect(within).toBe(!out);
    verdicts.set(`${country} ${date}`, within === true);
  }
  for (const { country, date } of cases) {
    expect([country, date, verdicts.get(`${country} ${date}`)]).toEqual([
      country,
      date,
      acceptedByGuard(date, country),
    ]);
  }
  // Guards the loop above against a fixture set that made it vacuous, and
  // pins the floors themselves: 1600 for USA, 1800 for everyone else.
  expect(BOUNDARY_DATES.some((date) => acceptedByGuard(date, "CZE"))).toBe(
    true,
  );
  expect(
    ["1599-12-31", "1600-01-01", "1799-12-31", "1800-01-01"].map((date) =>
      COUNTRIES.map((country) => verdicts.get(`${country} ${date}`)),
    ),
  ).toEqual([
    [false, false, false, false],
    [false, false, true, false],
    [false, false, true, false],
    [true, true, true, true],
  ]);
});

test("a NULL date is neither within nor out of bounds", async () => {
  const rows = executedRows(
    await db.execute(sql`
      SELECT ${decisionDateWithinBoundsSql(sql.raw("NULL::date"), sql.raw("'USA'"))} AS "within",
             ${decisionDateOutOfBoundsSql(sql.raw("NULL::date"), sql.raw("'USA'"))} AS "out"
       UNION ALL
      SELECT ${decisionDateWithinBoundsSql(sql.raw("NULL::date"), sql.raw("'CZE'"))},
             ${decisionDateOutOfBoundsSql(sql.raw("NULL::date"), sql.raw("'CZE'"))}
    `),
  );
  expect(rows).toEqual([
    { within: null, out: null },
    { within: null, out: null },
  ]);
});

test("the table refuses exactly the dates the guard refuses, and takes NULL", async () => {
  let inserted = 0;
  const insertWithDate = async (
    decisionDate: string | null,
    country: string,
  ): Promise<void> => {
    inserted += 1;
    await db.insert(caseLawDecisions).values({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: `${String(inserted)} C ${String(inserted)}/2020`,
      court: "Krajský soud",
      courtId: country === "USA" ? "scotus" : null,
      country,
      language: "cs",
      decisionDate,
    });
  };

  const outcomes: { country: string; date: string; stored: boolean }[] = [];
  for (const country of COUNTRIES) {
    await insertWithDate(null, country);
    for (const date of BOUNDARY_DATES) {
      if (acceptedByGuard(date, country)) {
        await insertWithDate(date, country);
        outcomes.push({ country, date, stored: true });
        continue;
      }
      const rejection = await rejectionOf(insertWithDate(date, country));
      // Refused by this constraint, not by some other check on the row.
      expect(rejection).toContain(CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT);
      outcomes.push({ country, date, stored: false });
    }
  }
  expect(outcomes).toEqual(
    COUNTRIES.flatMap((country) =>
      BOUNDARY_DATES.map((date) => ({
        country,
        date,
        stored: acceptedByGuard(date, country),
      })),
    ),
  );

  const stored = await db
    .select({
      country: caseLawDecisions.country,
      decisionDate: caseLawDecisions.decisionDate,
    })
    .from(caseLawDecisions);
  // ISO dates and "null" order correctly bytewise; no locale is involved.
  const byDate = (left: string | null, right: string | null) => {
    const l = String(left);
    const r = String(right);
    if (l === r) {
      return 0;
    }
    return l < r ? -1 : 1;
  };
  for (const country of COUNTRIES) {
    expect([
      country,
      stored
        .filter((row) => row.country === country)
        .map(({ decisionDate }) => decisionDate)
        .toSorted(byDate),
    ]).toEqual([
      country,
      [
        null,
        ...BOUNDARY_DATES.filter((date) => acceptedByGuard(date, country)),
      ].toSorted(byDate),
    ]);
  }
});

test("the migration adds the expression the schema declares", () => {
  const check = getTableConfig(caseLawDecisions).checks.find(
    ({ name }) => name === CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT,
  );
  if (check === undefined) {
    throw new Error("schema declares no decision-date bounds CHECK");
  }
  const { sql: declared, params } = new PgDialect().sqlToQuery(check.value);
  // DDL takes no bind parameters, so the fragment must carry none.
  expect(params).toEqual([]);

  const migration = readFileSync(MIGRATION_PATH, "utf-8");
  const added =
    /ADD CONSTRAINT "case_law_decisions_decision_date_bounds"\s+CHECK \((?<body>[\s\S]*?)\) NOT VALID;/u.exec(
      migration,
    )?.groups?.["body"];
  if (added === undefined) {
    throw new Error("migration does not add the constraint NOT VALID");
  }

  // The dialect qualifies the column with its table; DDL inside ALTER TABLE
  // does not. Whitespace is layout, not meaning, on both sides.
  const normalize = (text: string) =>
    text.replaceAll('"case_law_decisions".', "").replaceAll(/\s+/gu, "");
  expect(normalize(added)).toBe(normalize(declared));
});

test("the migration applies over stored rows and validates", async () => {
  // The rows the tests above stored, of every country, stay valid under the
  // swapped constraint: the floor only widens.
  const statements = readFileSync(MIGRATION_PATH, "utf-8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
  await db.execute(
    sql.raw(
      `ALTER TABLE "case_law_decisions" VALIDATE CONSTRAINT "${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT}"`,
    ),
  );
  const insert = async (country: string, decisionDate: string) => {
    await db.insert(caseLawDecisions).values({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: `${country} ${decisionDate}`,
      court: "Krajský soud",
      courtId: country === "USA" ? "scotus" : null,
      country,
      language: "cs",
      decisionDate,
    });
  };
  await insert("USA", "1700-06-15");
  expect(await rejectionOf(insert("CZE", "1700-06-15"))).toContain(
    CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT,
  );
  expect(await rejectionOf(insert("USA", "1599-12-31"))).toContain(
    CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT,
  );
});
