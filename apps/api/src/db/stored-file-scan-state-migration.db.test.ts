import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * The stored-file scan state, applied to the three tables as deployments hold
 * them. The shared test database boots the current schema, so only this file
 * runs the migration itself against rows that predate it. Only what the
 * migration touches is declared.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261003120500_stored_file_scan_state/migration.sql",
);

const TABLES = ["templates", "template_versions", "style_sets"] as const;

const PRE_MIGRATION = TABLES.map(
  (table) => `
CREATE TABLE ${table} (id uuid PRIMARY KEY);
INSERT INTO ${table} VALUES ('018f0000-0000-7000-8000-000000000001');
`,
).join("");

/** PGlite runs the file as one script; the breakpoints are the migrator's. */
const migrationSql = readFileSync(MIGRATION_PATH, "utf-8").replaceAll(
  "--> statement-breakpoint",
  "",
);

test("marks existing stored files unscanned, rejects unknown states, and replays", async () => {
  const database = new PGlite();
  await database.exec(PRE_MIGRATION);

  await database.exec(migrationSql);
  // A retried deployment runs the file again.
  await database.exec(migrationSql);

  for (const table of TABLES) {
    expect(
      (
        await database.query<{ scan_state: string }>(
          `SELECT scan_state FROM ${table}`,
        )
      ).rows,
    ).toEqual([{ scan_state: "unscanned" }]);
    expect(
      (
        await database.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_catalog.pg_constraint
            WHERE conname = '${table}_scan_state_check'`,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    await expect(
      database.query(`UPDATE ${table} SET scan_state = 'trusted'`),
    ).rejects.toThrow(/scan_state_check/u);
  }
});
