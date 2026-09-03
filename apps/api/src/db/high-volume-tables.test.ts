import { expect, test } from "bun:test";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import * as schema from "@/api/db/schema";

import { HIGH_VOLUME_TABLES } from "./high-volume-tables";

/**
 * The registry is read by `scripts/check-migration-safety.ts` as bare names;
 * a name the schema does not declare would guard nothing.
 */
test("every registered high-volume table is one the schema declares", () => {
  const declared = new Set(
    Object.values(schema).flatMap((value: unknown) =>
      is(value, PgTable) ? [getTableName(value)] : [],
    ),
  );
  for (const table of HIGH_VOLUME_TABLES) {
    expect([table, declared.has(table)]).toEqual([table, true]);
  }
  expect(new Set(HIGH_VOLUME_TABLES).size).toBe(HIGH_VOLUME_TABLES.length);
});
