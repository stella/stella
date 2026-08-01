import { expect, test } from "bun:test";

const migrationSource = new URL(
  "../../../drizzle/20260801110000_report_export_result_field/migration.sql",
  import.meta.url,
);

test("indexes and constrains report result fields before backfill", async () => {
  const source = await Bun.file(migrationSource).text();
  const indexBuild = source.indexOf(
    'CREATE INDEX CONCURRENTLY "report_exports_result_field_idx"',
  );
  const foreignKey = source.indexOf(
    'FOREIGN KEY ("result_field_id") REFERENCES "fields"("id") ON DELETE SET NULL NOT VALID',
  );
  const backfill = source.indexOf('UPDATE "report_exports" AS "report_export"');

  expect(indexBuild).toBeGreaterThanOrEqual(0);
  expect(foreignKey).toBeGreaterThan(indexBuild);
  expect(backfill).toBeGreaterThan(foreignKey);
});
