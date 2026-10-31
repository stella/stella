import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "@/api/db/schema";
import { CASE_LAW_REMOVAL_STORES } from "@/api/handlers/case-law/removal-stores";

const corpusTables = Object.values(schema).filter((value) =>
  is(value, PgTable),
);
const dependentTables = corpusTables.filter((table) => {
  const config = getTableConfig(table);
  // Tenant-held copies use their own cleanup boundary.
  if (
    config.columns.some(
      ({ name }) => name === "organization_id" || name === "workspace_id",
    )
  ) {
    return false;
  }
  return config.foreignKeys.some(
    (key) =>
      getTableConfig(key.reference().foreignTable).name ===
      "case_law_decisions",
  );
});

test("every corpus decision foreign key has a removal disposition", () => {
  const declared = new Set(Object.keys(CASE_LAW_REMOVAL_STORES));
  expect(dependentTables.length).toBeGreaterThan(0);
  expect(
    dependentTables
      .map((table) => getTableConfig(table).name)
      .filter((name) => !declared.has(name)),
  ).toEqual([]);
});

test("the corpus census detects an unenrolled dependent", () => {
  const names = new Set(
    dependentTables.map((table) => getTableConfig(table).name),
  );
  expect(names.has("case_law_citations")).toBe(true);
  const declared = new Set(
    Object.keys(CASE_LAW_REMOVAL_STORES).filter(
      (name) => name !== "case_law_citations",
    ),
  );
  expect([...names].filter((name) => !declared.has(name))).toEqual([
    "case_law_citations",
  ]);
});
