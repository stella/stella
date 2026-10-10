import { expect, test } from "bun:test";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import * as schema from "@/api/db/schema";

import { CODE_OWNED_TABLES } from "./code-owned-tables";

/**
 * The registry is read by `scripts/check-migration-safety.ts` as bare names;
 * a name the schema does not declare would guard nothing.
 */
test("every registered code-owned table is one the schema declares", () => {
  const declared = new Set(
    Object.values(schema).flatMap((value: unknown) =>
      is(value, PgTable) ? [getTableName(value)] : [],
    ),
  );
  for (const table of CODE_OWNED_TABLES) {
    expect([table, declared.has(table)]).toEqual([table, true]);
  }
  expect(new Set(CODE_OWNED_TABLES).size).toBe(CODE_OWNED_TABLES.length);
});
