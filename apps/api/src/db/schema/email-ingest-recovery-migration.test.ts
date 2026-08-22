import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260821190000_email_ingest_recovery/migration.sql",
);

test("creates the email-ingest recovery index outside the migration transaction", () => {
  const source = readFileSync(MIGRATION, "utf-8");
  const primaryKey = source.indexOf('PRIMARY KEY ("id", "object_key")');
  const split = source.indexOf("COMMIT;", primaryKey);
  const unboundedStatement = source.indexOf(
    "SET statement_timeout = 0;",
    split,
  );
  const unboundedLock = source.indexOf("SET lock_timeout = 0;", split);
  const drop = source.indexOf(
    'DROP INDEX CONCURRENTLY IF EXISTS "pending_uploads_email_ingest_recovery_idx";',
    unboundedLock,
  );
  const create = source.indexOf(
    'CREATE INDEX CONCURRENTLY "pending_uploads_email_ingest_recovery_idx"',
    drop,
  );
  const restoredStatement = source.indexOf(
    "SET statement_timeout = '5s';",
    create,
  );
  const restoredLock = source.indexOf("SET lock_timeout = '1s';", create);
  const reopen = source.indexOf("BEGIN;", restoredLock);

  expect(primaryKey).toBeGreaterThanOrEqual(0);
  expect(split).toBeGreaterThan(primaryKey);
  expect(unboundedStatement).toBeGreaterThan(split);
  expect(unboundedLock).toBeGreaterThan(unboundedStatement);
  expect(drop).toBeGreaterThan(unboundedLock);
  expect(create).toBeGreaterThan(drop);
  expect(restoredStatement).toBeGreaterThan(create);
  expect(restoredLock).toBeGreaterThan(restoredStatement);
  expect(reopen).toBeGreaterThan(restoredLock);
  expect(source).not.toContain(
    'CREATE INDEX "pending_uploads_email_ingest_recovery_idx"',
  );
});
