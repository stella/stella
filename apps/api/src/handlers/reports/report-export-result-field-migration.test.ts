import { expect, test } from "bun:test";

const migrationSource = new URL(
  "../../../drizzle/20260801110000_report_export_result_field/migration.sql",
  import.meta.url,
);

test("indexes and constrains report result fields without an unbounded repair", async () => {
  const source = await Bun.file(migrationSource).text();
  const indexBuild = source.indexOf(
    'CREATE INDEX CONCURRENTLY "report_exports_result_field_idx"',
  );
  const concurrentLockTimeout = source.indexOf("SET lock_timeout = '0'");
  const restoredLockTimeout = source.indexOf(
    "SET lock_timeout = '1s'",
    concurrentLockTimeout,
  );
  const foreignKey = source.indexOf(
    'FOREIGN KEY ("result_field_id") REFERENCES "fields"("id") ON DELETE SET NULL NOT VALID',
  );

  expect(concurrentLockTimeout).toBeGreaterThanOrEqual(0);
  expect(indexBuild).toBeGreaterThan(concurrentLockTimeout);
  expect(restoredLockTimeout).toBeGreaterThan(indexBuild);
  expect(foreignKey).toBeGreaterThan(indexBuild);
  expect(source).not.toContain('UPDATE "report_exports"');
});
