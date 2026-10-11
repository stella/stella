import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import { chatTurns } from "@/api/db/schema";
import {
  CHAT_TURN_STATUSES,
  CHAT_TURN_TIMING_DISPOSITION,
} from "@/api/handlers/chat/chat-turn-state";

const TIMING_CHECK = "chat_turns_active_timing_check";

const migrationSql = async (name: string) =>
  await Bun.file(
    new URL(`../../drizzle/${name}/migration.sql`, import.meta.url),
  ).text();

test("timing expansion and contraction preserve the timing invariant", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE TABLE chat_messages (
      id uuid NOT NULL,
      thread_id uuid NOT NULL,
      UNIQUE (id, thread_id)
    );
    CREATE TABLE chat_turns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL,
      status text NOT NULL
    );
  `);
  await db.exec(await migrationSql("20261008160100_chat_turn_active_timing"));
  await db.exec(
    await migrationSql("20261008160200_chat_turn_active_timing_validate"),
  );
  await db.exec("COMMIT");

  // A status-only terminal write can leave the additive timing columns intact.
  for (const status of CHAT_TURN_STATUSES.filter(
    (candidate) => CHAT_TURN_TIMING_DISPOSITION[candidate] === "finished",
  )) {
    const inserted = await db.query<{ id: string }>(`
      INSERT INTO chat_turns (thread_id, status, active_duration_ms, active_started_at)
      VALUES (gen_random_uuid(), 'running', 1000, now())
      RETURNING id
    `);
    const id = inserted.rows.at(0)?.id;
    expect(id).toBeDefined();
    await db.query("UPDATE chat_turns SET status = $1 WHERE id = $2", [
      status,
      id,
    ]);
    expect(
      (
        await db.query<{ status: string; timing_retained: boolean }>(
          `SELECT status, active_started_at IS NOT NULL AS timing_retained
           FROM chat_turns WHERE id = $1`,
          [id],
        )
      ).rows,
    ).toEqual([{ status, timing_retained: true }]);
  }

  // Repair inactive spans before adding and validating the invariant.
  await db.exec("UPDATE chat_turns SET active_started_at = NULL");
  await db.exec(
    await migrationSql("20261011100000_chat_turn_active_timing_contract"),
  );
  await db.exec("COMMIT");
  for (const status of CHAT_TURN_STATUSES) {
    const isActive = CHAT_TURN_TIMING_DISPOSITION[status] !== "finished";
    await db.query(
      `INSERT INTO chat_turns (thread_id, status, active_duration_ms, active_started_at)
       VALUES (gen_random_uuid(), $1, 0, $2)`,
      [status, isActive ? "2026-10-11T00:00:00Z" : null],
    );
    expect(
      await rejectionOf(
        db.query(
          `INSERT INTO chat_turns (thread_id, status, active_duration_ms, active_started_at)
         VALUES (gen_random_uuid(), $1, 0, $2)`,
          [status, isActive ? null : "2026-10-11T00:00:00Z"],
        ),
      ),
    ).toMatchObject({ code: "23514", constraint: TIMING_CHECK });
  }

  const definition = async () =>
    (
      await db.query<{ definition: string; validated: boolean }>(
        `SELECT pg_get_constraintdef(oid) AS definition, convalidated AS validated
         FROM pg_constraint WHERE conname = $1`,
        [TIMING_CHECK],
      )
    ).rows;
  const fromMigration = await definition();
  expect(fromMigration).toHaveLength(1);
  expect(fromMigration.at(0)?.validated).toBe(true);
  const schemaCheck = getTableConfig(chatTurns).checks.find(
    ({ name }) => name === TIMING_CHECK,
  );
  if (schemaCheck === undefined) {
    panic("Schema is missing the active timing constraint");
  }
  const schemaSql = new PgDialect().sqlToQuery(
    schemaCheck.value.inlineParams(),
  );
  expect(schemaSql.params).toEqual([]);
  await db.exec(`ALTER TABLE chat_turns DROP CONSTRAINT "${TIMING_CHECK}"`);
  await db.exec(
    `ALTER TABLE chat_turns ADD CONSTRAINT "${TIMING_CHECK}" CHECK (${schemaSql.sql})`,
  );
  expect(await definition()).toEqual(fromMigration);
});
