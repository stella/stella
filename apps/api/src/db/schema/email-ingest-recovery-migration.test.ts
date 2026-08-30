import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260830120000_email_ingest_recovery/migration.sql",
);

test("creates the email-ingest recovery index outside the migration transaction", () => {
  const source = readFileSync(MIGRATION, "utf-8");
  const primaryKey = source.indexOf('PRIMARY KEY ("id", "object_key")');
  const split = source.indexOf("COMMIT;", primaryKey);
  const concurrentStatement = source.indexOf(
    "SET statement_timeout = '30min';",
    split,
  );
  const concurrentLock = source.indexOf("SET lock_timeout = '1s';", split);
  const drop = source.indexOf(
    'DROP INDEX CONCURRENTLY IF EXISTS "pending_uploads_email_ingest_recovery_idx";',
    concurrentLock,
  );
  const create = source.indexOf(
    'CREATE INDEX CONCURRENTLY "pending_uploads_email_ingest_recovery_idx"',
    drop,
  );
  const sourceDrop = source.indexOf(
    'DROP INDEX CONCURRENTLY IF EXISTS "pending_uploads_email_source_uidx";',
    create,
  );
  const sourceCreate = source.indexOf(
    'CREATE UNIQUE INDEX CONCURRENTLY "pending_uploads_email_source_uidx"',
    sourceDrop,
  );
  const restoredStatement = source.indexOf(
    "SET statement_timeout = '5s';",
    sourceCreate,
  );
  const restoredLock = source.indexOf("SET lock_timeout = '1s';", create);
  const reopen = source.indexOf("BEGIN;", restoredLock);

  expect(primaryKey).toBeGreaterThanOrEqual(0);
  expect(split).toBeGreaterThan(primaryKey);
  expect(concurrentStatement).toBeGreaterThan(split);
  expect(concurrentLock).toBeGreaterThan(concurrentStatement);
  expect(drop).toBeGreaterThan(concurrentLock);
  expect(create).toBeGreaterThan(drop);
  expect(sourceDrop).toBeGreaterThan(create);
  expect(sourceCreate).toBeGreaterThan(sourceDrop);
  expect(restoredStatement).toBeGreaterThan(sourceCreate);
  expect(restoredLock).toBeGreaterThan(restoredStatement);
  expect(reopen).toBeGreaterThan(restoredLock);
  expect(source).not.toContain(
    'CREATE INDEX "pending_uploads_email_ingest_recovery_idx"',
  );
});
