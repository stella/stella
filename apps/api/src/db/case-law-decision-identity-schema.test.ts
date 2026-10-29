import { panic } from "better-result";
import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { caseLawDecisions } from "@/api/db/schema";

const DOCKET_SCOPE_COLUMNS = new Set(["source_id", "language", "case_number"]);

test("every unique decision key distinguishes more than the source language and docket", () => {
  const config = getTableConfig(caseLawDecisions);
  const keys = [
    ...config.indexes
      .filter(({ config: index }) => index.unique)
      .map(({ config: index }) => ({
        name: index.name,
        columns: index.columns.map((column) => {
          if ("name" in column && typeof column.name === "string") {
            return column.name;
          }
          return panic(
            `Unique decision expression needs column-scope classification: ${index.name}`,
          );
        }),
      })),
    ...config.uniqueConstraints.map((constraint) => ({
      name: constraint.getName(),
      columns: constraint.columns.map(({ name }) => name),
    })),
    ...config.primaryKeys.map((constraint) => ({
      name: constraint.getName(),
      columns: constraint.columns.map(({ name }) => name),
    })),
    ...config.columns
      .filter((column) => column.isUnique || column.primary)
      .map((column) => ({ name: column.name, columns: [column.name] })),
  ];
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    expect(key.columns.length, key.name).toBeGreaterThan(0);
    expect(
      key.columns.every((column) => DOCKET_SCOPE_COLUMNS.has(column)),
      key.name,
    ).toBe(false);
  }
});
