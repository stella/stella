import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";

import * as schema from "@/api/db/schema";

import { HIGH_VOLUME_TABLES } from "./high-volume-tables";
import { schemaTables } from "./schema-tables";

/**
 * The registry is read by `scripts/check-migration-safety.ts` as bare names;
 * a name the schema does not declare would guard nothing.
 */
test("every registered high-volume table is one the schema declares", () => {
  const declared = new Set(
    schemaTables(schema).map((table) => getTableName(table)),
  );
  for (const table of HIGH_VOLUME_TABLES) {
    expect([table, declared.has(table)]).toEqual([table, true]);
  }
  expect(new Set(HIGH_VOLUME_TABLES).size).toBe(HIGH_VOLUME_TABLES.length);
});
