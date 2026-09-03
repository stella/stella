import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { HIGH_VOLUME_TABLES } from "../db/high-volume-tables";
import {
  REHEARSAL_ROWS_PER_DECISION,
  REHEARSAL_SEED_ORDER,
  rehearsalSeedSteps,
} from "./seed-migration-rehearsal-plan";

/**
 * The seeders run against a real PostgreSQL with the current schema: a
 * statement that violates a CHECK, a unique index or a foreign key fails
 * here rather than in the release rehearsal, and every registered table ends
 * up with the row count the plan promises.
 */

const DECISIONS = 40;

const countRows = async (
  db: ReturnType<typeof drizzle>,
  table: string,
): Promise<number> => {
  const result: unknown = await db.execute(
    sql.raw(`SELECT count(*)::int AS "count" FROM ${table}`),
  );
  let rows: unknown[] = [];
  if (Array.isArray(result)) {
    rows = result;
  } else if (isRecord(result) && Array.isArray(result["rows"])) {
    rows = result["rows"];
  }
  const row = rows.at(0);
  if (!isRecord(row) || typeof row["count"] !== "number") {
    throw new TypeError(`count(*) over ${table} returned no number`);
  }
  return row["count"];
};

test("the seed order names every registered high-volume table exactly once", () => {
  expect(REHEARSAL_SEED_ORDER.length).toBe(HIGH_VOLUME_TABLES.length);
  expect(new Set(REHEARSAL_SEED_ORDER)).toEqual(new Set(HIGH_VOLUME_TABLES));
});

test("every seeder satisfies the schema and writes its promised rows", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });

  for (const { statement } of rehearsalSeedSteps(DECISIONS)) {
    // oxlint-disable-next-line no-await-in-loop -- statements apply in order
    await db.execute(sql.raw(statement));
  }

  const counts = await Promise.all(
    HIGH_VOLUME_TABLES.map(async (table) => [
      table,
      await countRows(db, table),
    ]),
  );
  expect(Object.fromEntries(counts)).toEqual(
    Object.fromEntries(
      HIGH_VOLUME_TABLES.map((table) => [
        table,
        DECISIONS * REHEARSAL_ROWS_PER_DECISION[table],
      ]),
    ),
  );

  // Rerunnable on a database that already holds the fixtures.
  for (const { statement } of rehearsalSeedSteps(DECISIONS).slice(0, 2)) {
    // oxlint-disable-next-line no-await-in-loop -- statements apply in order
    await db.execute(sql.raw(statement));
  }
  await client.close();
}, 120_000);

test("refuses a decision count that is not a positive integer", () => {
  expect(() => rehearsalSeedSteps(0)).toThrow(/positive integer/u);
  expect(() => rehearsalSeedSteps(1.5)).toThrow(/positive integer/u);
});
