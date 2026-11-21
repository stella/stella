import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "@/api/db/schema";
import { PUBLIC_CORPUS_BOOKKEEPING_TABLES } from "@/api/lib/db/public-corpus-audit/membership";

test("declared corpus tables exist and are documented", () => {
  const exports = new Map(Object.entries(schema));
  const names = new Set<string>();
  for (const entry of PUBLIC_CORPUS_BOOKKEEPING_TABLES) {
    expect(names.has(entry.sqlName)).toBe(false);
    names.add(entry.sqlName);
    expect(entry.reason.trim().length).toBeGreaterThan(0);
    const table = exports.get(entry.schemaExport);
    expect(is(table, PgTable)).toBe(true);
    if (!is(table, PgTable)) {
      continue;
    }
    expect(getTableConfig(table).name).toBe(entry.sqlName);
    for (const column of getTableConfig(table).columns) {
      expect(entry.columns[column.name]?.reason.trim().length).toBeGreaterThan(
        0,
      );
    }
  }
});
