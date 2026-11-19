import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";

import * as schema from "@/api/db/schema";

import { HIGH_VOLUME_TABLES } from "./high-volume-tables";
import { PLAN_GUARD_TABLES } from "./plan-guard-tables";
import { schemaTables } from "./schema-tables";

test("plan guard tables cover the high-volume registry and declared schema", () => {
  const declared = new Set(
    schemaTables(schema).map((table) => getTableName(table)),
  );
  expect(new Set(PLAN_GUARD_TABLES).size).toBe(PLAN_GUARD_TABLES.length);
  for (const table of HIGH_VOLUME_TABLES) {
    expect(PLAN_GUARD_TABLES).toContain(table);
  }
  for (const table of PLAN_GUARD_TABLES) {
    expect(declared.has(table)).toBe(true);
  }
});
