import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { HIGH_VOLUME_TABLES } from "../db/high-volume-tables";
import type { RehearsalSeedStep } from "./seed-migration-rehearsal-plan";
import {
  REHEARSAL_ROWS_PER_DECISION,
  REHEARSAL_SEED_ORDER,
  rehearsalPresentTablesStatement,
  rehearsalSeedSteps,
  rehearsalVacuumStatement,
} from "./seed-migration-rehearsal-plan";

/**
 * The seeders run against a real PostgreSQL with the current schema: a
 * statement that violates a CHECK, a unique index or a foreign key fails
 * here rather than in the release rehearsal, and every registered table ends
 * up with the row count the plan promises.
 */

const DECISIONS = 40;

/** Rows from either driver shape: an array, or a `{ rows }` result. */
const resultRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const countRows = async (
  db: ReturnType<typeof drizzle>,
  table: string,
): Promise<number> => {
  const row = resultRows(
    await db.execute(sql.raw(`SELECT count(*)::int AS "count" FROM ${table}`)),
  ).at(0);
  if (!isRecord(row) || typeof row["count"] !== "number") {
    throw new TypeError(`count(*) over ${table} returned no number`);
  }
  return row["count"];
};

const applySteps = async (
  db: ReturnType<typeof drizzle>,
  steps: readonly RehearsalSeedStep[],
) => {
  for (const step of steps) {
    if (step.type === "sql") {
      await db.execute(sql.raw(step.statement));
      continue;
    }
    // The current schema holds every registered table.
    const present = resultRows(
      await db.execute(sql.raw(rehearsalPresentTablesStatement(step.tables))),
    ).map((row) => (isRecord(row) ? row["name"] : undefined));
    expect(new Set(present)).toEqual(new Set(step.tables));
    await db.execute(sql.raw(rehearsalVacuumStatement(step.tables)));
  }
};

test("the seed order names every registered high-volume table exactly once", () => {
  expect(REHEARSAL_SEED_ORDER.length).toBe(HIGH_VOLUME_TABLES.length);
  expect(new Set(REHEARSAL_SEED_ORDER)).toEqual(new Set(HIGH_VOLUME_TABLES));
});

test("the run ends with one vacuum of exactly the tables it seeds", () => {
  const steps = rehearsalSeedSteps(DECISIONS);
  const seeded = steps.flatMap((step) =>
    step.type === "sql" && step.table !== null ? [step.table] : [],
  );
  const vacuums = steps.flatMap((step) =>
    step.type === "vacuum" ? [step] : [],
  );
  expect(vacuums).toHaveLength(1);
  expect(steps.at(-1)).toBe(vacuums.at(0));
  expect(new Set(vacuums.at(0)?.tables)).toEqual(new Set(seeded));
});

test("every seeder satisfies the schema and writes its promised rows", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });

  await applySteps(db, rehearsalSeedSteps(DECISIONS));

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

  // Synthetic projection buckets exercise migration volume without claiming a recount.
  const exactStates = resultRows(
    await db.execute(sql`SELECT count(*)::integer AS count
      FROM case_law_decision_citation_stats_state WHERE status = 'exact'`),
  ).at(0);
  expect(exactStates).toEqual({ count: 0 });

  // Rerunnable on a database that already holds the fixtures.
  await applySteps(db, rehearsalSeedSteps(DECISIONS).slice(0, 2));
  await client.close();
}, 120_000);

test("refuses a decision count that is not a positive integer", () => {
  expect(() => rehearsalSeedSteps(0)).toThrow(/positive integer/u);
  expect(() => rehearsalSeedSteps(1.5)).toThrow(/positive integer/u);
});
