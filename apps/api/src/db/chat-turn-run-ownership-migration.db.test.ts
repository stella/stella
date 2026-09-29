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
  "../../drizzle/20261003120300_chat_turn_run_ownership/migration.sql",
);

const PRE_MIGRATION = `
CREATE ROLE stella NOLOGIN;
CREATE TABLE chat_turns (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  status text NOT NULL,
  execution_id uuid,
  interruption_reason text,
  CONSTRAINT "chat_turns_interruption_reason_values_check"
    CHECK ("interruption_reason" IS NULL OR "interruption_reason" IN ('client-disconnected', 'timeout'))
);
INSERT INTO chat_turns (id, organization_id, user_id, status, execution_id, interruption_reason) VALUES
  ('018f0000-0000-7000-8000-000000000001', 'org-a', 'user-a', 'running', '018f0000-0000-7000-8000-000000000011', 'timeout'),
  ('018f0000-0000-7000-8000-000000000002', 'org-a', 'user-b', 'running', '018f0000-0000-7000-8000-000000000012', NULL);
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
  expect(
    migrationStatements.some((statement) =>
      statement.includes(
        'REINDEX INDEX CONCURRENTLY "chat_turns_org_run_id_uidx"',
      ),
    ),
  ).toBe(false);
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
  await database.exec(
    "SET ROLE stella; SET app.organization_id = 'org-a'; SET app.user_id = 'user-b'",
  );
  const checkRunId = async (executionId: string) =>
    await database.query(
      "SELECT public.chat_turn_run_id_taken('018f0000-0000-7000-8000-000000000002', $1::uuid, 'run-1') AS taken",
      [executionId],
    );
  expect(
    (await checkRunId("018f0000-0000-7000-8000-000000000012")).rows.at(0)
      ?.taken,
  ).toBe(true);
  expect(
    (await checkRunId("018f0000-0000-7000-8000-000000000099")).rows.at(0)
      ?.taken,
  ).toBe(false);
  await database.exec("RESET ROLE");
  // Another organization may hold the same client-minted id.
  await database.query(
    "UPDATE chat_turns SET organization_id = 'org-b', run_id = 'run-1' WHERE id = '018f0000-0000-7000-8000-000000000002'",
  );
  await database.exec(
    "SET ROLE stella; SET app.organization_id = 'org-b'; SET app.user_id = 'user-b'",
  );
  expect(
    (await checkRunId("018f0000-0000-7000-8000-000000000012")).rows.at(0)
      ?.taken,
  ).toBe(false);
  await database.exec("RESET ROLE");

  // The schema reads the column the migration adds.
  const { runId } = getColumns(chatTurns);
  expect({
    name: runId.name,
    notNull: runId.notNull,
    type: runId.getSQLType(),
  }).toEqual({ name: "run_id", notNull: false, type: "text" });
});
