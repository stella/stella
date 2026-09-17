import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * Relaxing `account.issuer`, applied to a database in its pre-migration shape.
 *
 * The shared test database boots the CURRENT schema, where the column is
 * already nullable, so it cannot hold a row written under the Better Auth 1.7
 * cutover's NOT NULL rule. This suite therefore builds `account` as that
 * cutover left it, seeds the three issuer shapes the backfill produced, and
 * runs the migration file itself, which is the only way to prove what the
 * deployment does to existing rows.
 *
 * Only what the migration touches is declared. The user foreign key and the
 * token columns are irrelevant to the constraint change and would couple this
 * test to unrelated schema churn.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260916140000_account_issuer_nullable/migration.sql",
);
const ROLLBACK_PATH = nodePath.resolve(
  import.meta.dir,
  "../scripts/rollback-account-issuer-nullable.sql",
);

const LEGACY_INDEX = "account_issuer_account_id_uidx";
const IDENTITY_INDEX = "account_provider_account_id_uidx";

const PRE_MIGRATION_SCHEMA = `
CREATE TABLE account (
  id text PRIMARY KEY,
  issuer text NOT NULL,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL
);
CREATE UNIQUE INDEX "${LEGACY_INDEX}" ON account (issuer, account_id);
CREATE INDEX "account_userId_idx" ON account (user_id);
`;

// The three shapes apps/api/src/scripts/better-auth-17-backfill.ts derived:
// a credential row whose account_id is its user_id, a Google row, and a
// Microsoft row carrying its tenant-specific issuer.
const PRE_MIGRATION_ROWS = `
INSERT INTO account VALUES
  ('acc_cred', 'local:credential', 'usr_1', 'credential', 'usr_1'),
  ('acc_google', 'https://accounts.google.com', 'goog_sub_1', 'google', 'usr_1'),
  ('acc_ms', 'https://login.microsoftonline.com/tenant-1/v2.0', 'ms_oid_1', 'microsoft', 'usr_2');
`;

/**
 * PGlite runs a script inside one transaction and cannot do concurrent DDL
 * there, so the concurrency keyword is stripped and the migration's
 * COMMIT/BEGIN split is flattened. What the statements do to the schema is
 * identical; only the locking differs, and locking is what
 * `migration-concurrent-index.test.ts` asserts on the file text.
 */
const forPglite = (sql: string): string =>
  sql
    .replaceAll("--> statement-breakpoint", "")
    .replaceAll(" CONCURRENTLY", "")
    .replace(/^COMMIT;$/gmu, "")
    .replace(/^BEGIN;$/gmu, "");

const migrationSql = forPglite(readFileSync(MIGRATION_PATH, "utf-8"));
const rollbackSql = forPglite(readFileSync(ROLLBACK_PATH, "utf-8"));

// The statement ONLINE_INDEX_REPLACEMENTS issues after it has proven the
// replacement ready. The migration deliberately does not drop the legacy
// index; the online phase owns that, so the end state needs both.
const RETIRE_LEGACY_INDEX_SQL = `DROP INDEX IF EXISTS public."${LEGACY_INDEX}"`;

const createMigratedDatabase = async (): Promise<PGlite> => {
  const database = new PGlite();
  await database.exec(PRE_MIGRATION_SCHEMA);
  await database.exec(PRE_MIGRATION_ROWS);
  await database.exec(migrationSql);
  return database;
};

const isNullable = async (database: PGlite): Promise<boolean> => {
  const result = await database.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'account' AND column_name = 'issuer'`,
  );
  return result.rows.at(0)?.is_nullable === "YES";
};

const indexExists = async (
  database: PGlite,
  name: string,
): Promise<boolean> => {
  const result = await database.query<{ count: number | string }>(
    `SELECT count(*) AS count FROM pg_indexes
      WHERE tablename = 'account' AND indexname = $1`,
    [name],
  );
  return Number(result.rows.at(0)?.count) === 1;
};

const rejectionFrom = async (run: Promise<unknown>): Promise<unknown> =>
  await run.then(
    () => null,
    (error: unknown) => error,
  );

test("the migration relaxes the column and adds the identity key without touching rows", async () => {
  const database = await createMigratedDatabase();

  expect(await isNullable(database)).toBe(true);
  expect(await indexExists(database, IDENTITY_INDEX)).toBe(true);

  const rows = await database.query<{
    account_id: string;
    id: string;
    issuer: string | null;
  }>("SELECT id, issuer, account_id FROM account ORDER BY id");
  expect(rows.rows).toEqual([
    { account_id: "usr_1", id: "acc_cred", issuer: "local:credential" },
    {
      account_id: "goog_sub_1",
      id: "acc_google",
      issuer: "https://accounts.google.com",
    },
    {
      account_id: "ms_oid_1",
      id: "acc_ms",
      issuer: "https://login.microsoftonline.com/tenant-1/v2.0",
    },
  ]);

  await database.close();
});

test("the online phase retires the legacy index once the identity key exists", async () => {
  const database = await createMigratedDatabase();

  // The migration on its own leaves it: uniqueness is never uncovered.
  expect(await indexExists(database, LEGACY_INDEX)).toBe(true);

  await database.exec(RETIRE_LEGACY_INDEX_SQL);

  expect(await indexExists(database, LEGACY_INDEX)).toBe(false);
  expect(await indexExists(database, IDENTITY_INDEX)).toBe(true);

  await database.close();
});

test("an account without an issuer is accepted after the migration", async () => {
  const database = await createMigratedDatabase();

  await database.exec(
    `INSERT INTO account VALUES ('acc_new', NULL, 'goog_sub_2', 'google', 'usr_3')`,
  );

  const result = await database.query<{ count: number | string }>(
    "SELECT count(*) AS count FROM account WHERE issuer IS NULL",
  );
  expect(Number(result.rows.at(0)?.count)).toBe(1);

  await database.close();
});

test("a duplicate provider and account id is refused after the migration", async () => {
  const database = await createMigratedDatabase();

  const rejection = await rejectionFrom(
    database.exec(
      `INSERT INTO account VALUES ('acc_dupe', NULL, 'goog_sub_1', 'google', 'usr_4')`,
    ),
  );

  expect(rejection).toMatchObject({
    message: expect.stringContaining(IDENTITY_INDEX),
  });

  await database.close();
});

test("the committed rollback restores the pre-migration shape", async () => {
  const database = await createMigratedDatabase();
  await database.exec(RETIRE_LEGACY_INDEX_SQL);

  await database.exec(rollbackSql);

  expect(await isNullable(database)).toBe(false);
  expect(await indexExists(database, LEGACY_INDEX)).toBe(true);
  expect(await indexExists(database, IDENTITY_INDEX)).toBe(false);

  await database.close();
});

test("the rollback refuses once a row has no issuer", async () => {
  const database = await createMigratedDatabase();
  await database.exec(
    `INSERT INTO account VALUES ('acc_new', NULL, 'goog_sub_2', 'google', 'usr_3')`,
  );

  const rejection = await rejectionFrom(database.exec(rollbackSql));

  expect(rejection).toMatchObject({
    message: expect.stringContaining("account_issuer_rollback"),
  });
  // Refusing leaves the migrated shape intact rather than half-reverted.
  expect(await isNullable(database)).toBe(true);

  await database.close();
});
