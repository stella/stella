import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { chatTurns } from "@/api/db/schema";

/**
 * The stop-request column, applied to `chat_turns` as deployments hold it.
 * The shared test database boots the current schema, so only this file runs
 * the migration itself against rows that predate it. Only what the migration
 * touches is declared.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260926190000_chat_turn_cancel_requested_at/migration.sql",
);

const PRE_MIGRATION = `
CREATE TABLE chat_turns (
  id uuid PRIMARY KEY,
  status text NOT NULL
);
INSERT INTO chat_turns VALUES
  ('018f0000-0000-7000-8000-000000000001', 'running'),
  ('018f0000-0000-7000-8000-000000000002', 'completed');
`;

/** PGlite runs the file as one script; the breakpoints are the migrator's. */
const migrationSql = readFileSync(MIGRATION_PATH, "utf-8").replaceAll(
  "--> statement-breakpoint",
  "",
);

const column = async (database: PGlite) =>
  (
    await database.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'chat_turns' AND column_name = 'cancel_requested_at'`,
    )
  ).rows;

test("adds a nullable stop-request time that existing turns lack, and replays", async () => {
  const database = new PGlite();
  await database.exec(PRE_MIGRATION);

  await database.exec(migrationSql);
  // A retried deployment runs the file again.
  await database.exec(migrationSql);

  expect(await column(database)).toEqual([
    { data_type: "timestamp with time zone", is_nullable: "YES" },
  ]);
  expect(
    (
      await database.query<{ requested: string | null }>(
        "SELECT cancel_requested_at AS requested FROM chat_turns ORDER BY id",
      )
    ).rows,
  ).toEqual([{ requested: null }, { requested: null }]);
  // The schema reads the column the migration adds.
  const { cancelRequestedAt } = getTableColumns(chatTurns);
  expect({
    name: cancelRequestedAt.name,
    notNull: cancelRequestedAt.notNull,
    type: cancelRequestedAt.getSQLType(),
  }).toEqual({
    name: "cancel_requested_at",
    notNull: false,
    type: "timestamp with time zone",
  });
});
