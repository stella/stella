import { panic } from "better-result";
import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { ONLINE_MIGRATION_INDEXES } from "./online-migrations";
import { sanctionsContactMarks } from "./schema/sanctions-monitoring";

const table = getTableConfig(sanctionsContactMarks);
const retryColumns = [
  sanctionsContactMarks.nextAttemptAt.name,
  sanctionsContactMarks.scheduledAt.name,
];
const retryIndexes = table.indexes
  .map(({ config }) => ({
    ...config,
    columns: config.columns.map((column) => {
      if (!("name" in column)) {
        return panic("Monitoring retry indexes use columns");
      }
      return column.name;
    }),
  }))
  .filter(({ columns }) =>
    retryColumns.every((column) => columns.includes(column)),
  );

test("the tenant retry page has an organization-leading ordered access path", () => {
  expect(
    retryIndexes.some(
      ({ columns }) =>
        JSON.stringify(columns) ===
        JSON.stringify([
          sanctionsContactMarks.organizationId.name,
          ...retryColumns,
          sanctionsContactMarks.contactId.name,
        ]),
    ),
  ).toBe(true);
});

test.each(retryIndexes)(
  "retry index $name is created concurrently with the live schema's columns",
  ({ name, columns, unique }) => {
    if (name === undefined) {
      panic("Monitoring retry indexes declare their names");
    }
    const online = ONLINE_MIGRATION_INDEXES.find(
      (index) => index.name === name,
    );
    expect(online?.tableName).toBe(table.name);
    expect(online?.isUnique).toBe(unique);
    expect(online?.definitionBody).toBe(
      `ON public.${table.name} USING btree (${columns.join(", ")})`,
    );
    expect(online?.createSql).toBe(
      `CREATE INDEX CONCURRENTLY "${name}" ON public."${table.name}" USING btree (${columns.map((column) => `"${column}"`).join(", ")})`,
    );
  },
);
