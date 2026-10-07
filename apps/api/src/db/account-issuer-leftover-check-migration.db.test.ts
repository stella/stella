import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * Dropping a leftover `account_issuer_not_null_check`, applied to a database
 * that still carries it after `account.issuer` was relaxed.
 *
 * The shared test database runs every migration in order, so it never holds
 * the leftover. This suite builds `account` in that drifted shape and runs the
 * migration file itself, which is the only way to prove the repair.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261005120900_drop_leftover_account_issuer_check/migration.sql",
);

const LEFTOVER_CHECK = "account_issuer_not_null_check";

const RELAXED_SCHEMA = `
CREATE TABLE account (
  id text PRIMARY KEY,
  issuer text,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL
);
`;

const DRIFTED_SCHEMA = `${RELAXED_SCHEMA}
ALTER TABLE account
  ADD CONSTRAINT "${LEFTOVER_CHECK}" CHECK (issuer IS NOT NULL);
`;

const migrationSql = readFileSync(MIGRATION_PATH, "utf-8").replaceAll(
  "--> statement-breakpoint",
  "",
);

// A credential row as the current library writes it: no issuer.
const INSERT_WITHOUT_ISSUER = `
INSERT INTO account (id, account_id, provider_id, user_id)
  VALUES ('acc_cred', 'usr_1', 'credential', 'usr_1')`;

const hasLeftoverCheck = async (database: PGlite): Promise<boolean> => {
  const result = await database.query<{ count: number | string }>(
    `SELECT count(*) AS count FROM pg_constraint
      WHERE conrelid = 'account'::regclass AND conname = $1`,
    [LEFTOVER_CHECK],
  );
  return Number(result.rows.at(0)?.count) === 1;
};

const rejectionFrom = async (run: Promise<unknown>): Promise<unknown> =>
  await run.then(
    () => null,
    (error: unknown) => error,
  );

test("the leftover check rejects an account without an issuer", async () => {
  await using database = new PGlite();
  await database.exec(DRIFTED_SCHEMA);

  expect(
    await rejectionFrom(database.exec(INSERT_WITHOUT_ISSUER)),
  ).toMatchObject({ message: expect.stringContaining(LEFTOVER_CHECK) });
});

test("the migration drops the leftover check so accounts without an issuer insert", async () => {
  await using database = new PGlite();
  await database.exec(DRIFTED_SCHEMA);

  await database.exec(migrationSql);

  expect(await hasLeftoverCheck(database)).toBe(false);
  await database.exec(INSERT_WITHOUT_ISSUER);
  const rows = await database.query<{ id: string; issuer: string | null }>(
    "SELECT id, issuer FROM account",
  );
  expect(rows.rows).toEqual([{ id: "acc_cred", issuer: null }]);
});

test("the migration is a no-op where the check is already gone and on a rerun", async () => {
  await using database = new PGlite();
  await database.exec(RELAXED_SCHEMA);

  await database.exec(migrationSql);
  await database.exec(migrationSql);

  expect(await hasLeftoverCheck(database)).toBe(false);
  await database.exec(INSERT_WITHOUT_ISSUER);
});
