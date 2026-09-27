import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { chatTurns } from "@/api/db/schema";
import { CHAT_TURN_INTERRUPTION_REASONS } from "@/api/handlers/chat/chat-turn-state";

/**
 * The run identity and the `owner-lost` reason, applied to `chat_turns` as
 * deployments hold it. The shared test database boots the current schema, so
 * only this file runs the migration itself against rows that predate it. Only
 * what the migration touches is declared.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260927120000_chat_turn_run_ownership/migration.sql",
);

const PRE_MIGRATION = `
CREATE TABLE chat_turns (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  interruption_reason text,
  CONSTRAINT "chat_turns_interruption_reason_values_check"
    CHECK ("interruption_reason" IS NULL OR "interruption_reason" IN ('client-disconnected', 'timeout'))
);
INSERT INTO chat_turns VALUES
  ('018f0000-0000-7000-8000-000000000001', 'org-a', 'timeout'),
  ('018f0000-0000-7000-8000-000000000002', 'org-a', NULL);
`;

/**
 * The migrator's statements, one at a time inside its transaction: the file
 * commits it to build the index concurrently, then opens a new one.
 */
const migrationStatements = readFileSync(MIGRATION_PATH, "utf-8")
  .split("--> statement-breakpoint")
  .filter((statement) => statement.trim().length > 0);

const migrate = async (database: PGlite) => {
  await database.exec("BEGIN");
  for (const statement of migrationStatements) {
    await database.exec(statement);
  }
  await database.exec("COMMIT");
};

const setRun = async (database: PGlite, id: string, runId: string) =>
  await database.query("UPDATE chat_turns SET run_id = $2 WHERE id = $1", [
    id,
    runId,
  ]);

const rejectionOf = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(
    () => null,
    (error: unknown) => error,
  );

test("binds each run id to one turn per organization, accepts owner-lost, and replays", async () => {
  const database = new PGlite();
  await database.exec(PRE_MIGRATION);

  await migrate(database);
  // A retried deployment runs the file again.
  await migrate(database);

  // Every reason the schema declares is one the constraint accepts.
  for (const reason of CHAT_TURN_INTERRUPTION_REASONS) {
    await database.query(
      "UPDATE chat_turns SET interruption_reason = $1 WHERE id = '018f0000-0000-7000-8000-000000000001'",
      [reason],
    );
  }
  const invalidReason = await rejectionOf(
    database.query(
      "UPDATE chat_turns SET interruption_reason = 'gone' WHERE id = '018f0000-0000-7000-8000-000000000001'",
    ),
  );
  expect(String(invalidReason)).toMatch(
    /chat_turns_interruption_reason_values_check/u,
  );

  await setRun(database, "018f0000-0000-7000-8000-000000000001", "run-1");
  const duplicateRun = await rejectionOf(
    setRun(database, "018f0000-0000-7000-8000-000000000002", "run-1"),
  );
  expect(String(duplicateRun)).toMatch(/chat_turns_org_run_id_uidx/u);
  // Another organization may hold the same client-minted id.
  await database.query(
    "UPDATE chat_turns SET organization_id = 'org-b', run_id = 'run-1' WHERE id = '018f0000-0000-7000-8000-000000000002'",
  );

  // The schema reads the column the migration adds.
  const { runId } = getColumns(chatTurns);
  expect({
    name: runId.name,
    notNull: runId.notNull,
    type: runId.getSQLType(),
  }).toEqual({ name: "run_id", notNull: false, type: "text" });
});
