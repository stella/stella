import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";

import * as schema from "@/api/db/schema";

import { CODE_OWNED_TABLES } from "./code-owned-tables";
import { schemaTables } from "./schema-tables";

/**
 * The registry is read by `scripts/check-migration-safety.ts` as bare names;
 * a name the schema does not declare would guard nothing.
 */
test("every registered code-owned table is one the schema declares", () => {
  const declared = new Set(
    schemaTables(schema).map((table) => getTableName(table)),
  );
  for (const table of CODE_OWNED_TABLES) {
    expect([table, declared.has(table)]).toEqual([table, true]);
  }
  expect(new Set(CODE_OWNED_TABLES).size).toBe(CODE_OWNED_TABLES.length);
});
