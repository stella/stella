import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const RECOVERY_MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260830120200_email_ingest_recovery/migration.sql",
);
const SOURCE_IDENTITY_MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260830121000_email_ingest_source_identity/migration.sql",
);

test("creates the email-ingest recovery index outside the migration transaction", () => {
  const source = readFileSync(RECOVERY_MIGRATION, "utf-8");
  const primaryKey = source.indexOf('PRIMARY KEY ("id", "object_key")');
  const split = source.indexOf("COMMIT;", primaryKey);
  const concurrentStatement = source.indexOf(
    "SET statement_timeout = 0;",
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
  const restoredStatement = source.indexOf(
    "SET statement_timeout = '5s';",
    create,
  );
  const restoredLock = source.indexOf("SET lock_timeout = '1s';", create);
  const reopen = source.indexOf("BEGIN;", restoredLock);

  expect(primaryKey).toBeGreaterThanOrEqual(0);
  expect(split).toBeGreaterThan(primaryKey);
  expect(concurrentStatement).toBeGreaterThan(split);
  expect(concurrentLock).toBeGreaterThan(concurrentStatement);
  expect(drop).toBeGreaterThan(concurrentLock);
  expect(create).toBeGreaterThan(drop);
  expect(restoredStatement).toBeGreaterThan(create);
  expect(restoredLock).toBeGreaterThan(restoredStatement);
  expect(reopen).toBeGreaterThan(restoredLock);
  expect(source).not.toContain(
    'CREATE INDEX "pending_uploads_email_ingest_recovery_idx"',
  );
});

test("creates and repairs the email source identity index online", () => {
  const source = readFileSync(SOURCE_IDENTITY_MIGRATION, "utf-8");
  const split = source.indexOf("COMMIT;");
  const unboundedStatement = source.indexOf(
    "SET statement_timeout = 0;",
    split,
  );
  const boundedLock = source.indexOf("SET lock_timeout = '1s';", split);
  const create = source.indexOf(
    'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "pending_uploads_email_source_uidx"',
    boundedLock,
  );
  const repair = source.indexOf(
    'REINDEX INDEX CONCURRENTLY "pending_uploads_email_source_uidx";',
    create,
  );
  const restoredStatement = source.indexOf(
    "SET statement_timeout = '5s';",
    repair,
  );
  const restoredLock = source.indexOf(
    "SET lock_timeout = '1s';",
    restoredStatement,
  );
  const reopen = source.indexOf("BEGIN;", restoredLock);

  expect(split).toBeGreaterThanOrEqual(0);
  expect(unboundedStatement).toBeGreaterThan(split);
  expect(boundedLock).toBeGreaterThan(unboundedStatement);
  expect(create).toBeGreaterThan(boundedLock);
  expect(repair).toBeGreaterThan(create);
  expect(restoredStatement).toBeGreaterThan(repair);
  expect(restoredLock).toBeGreaterThan(restoredStatement);
  expect(reopen).toBeGreaterThan(restoredLock);
});
