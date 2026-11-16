import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgRole, pgTable, pgView, text } from "drizzle-orm/pg-core";

import { schemaTables } from "./schema-tables";

test("schema reflection preserves table identity, export order and aliases", () => {
  const first = pgTable("reflection_first", { id: text().primaryKey() });
  const second = pgTable("reflection_second", { name: text().notNull() });
  const schema = {
    description: "schema metadata",
    first,
    view: pgView("reflection_view", { id: text() }).existing(),
    second,
    role: pgRole("reflection_role"),
    columnFactory: text,
    missing: undefined,
    empty: null,
    expression: sql`true`,
    firstAlias: first,
    nested: { table: second },
  };
  const tables = schemaTables(schema);
  expect(tables).toHaveLength(3);
  expect(tables[0]).toBe(first);
  expect(tables[1]).toBe(second);
  expect(tables[2]).toBe(first);
  expect(schemaTables({})).toEqual([]);
});
