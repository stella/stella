import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { chatTurns } from "@/api/db/schema";
import {
  CHAT_TURN_STATUSES,
  CHAT_TURN_TIMING_DISPOSITION,
} from "@/api/lib/chat/turn-status";

const TIMING_CHECK = "chat_turns_active_timing_check";

const migrationSql = async (name: string) =>
  await Bun.file(
    new URL(`../../drizzle/${name}/migration.sql`, import.meta.url),
  ).text();

test("timing expansion admits status-only terminal writes", async () => {
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
  await db.exec(await migrationSql("20261016100200_chat_turn_active_timing"));
  await db.exec(
    await migrationSql("20261016100300_chat_turn_active_timing_validate"),
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

  expect(
    getTableConfig(chatTurns).checks.map(({ name }) => name),
  ).not.toContain(TIMING_CHECK);
  expect(
    (
      await db.query("SELECT conname FROM pg_constraint WHERE conname = $1", [
        TIMING_CHECK,
      ])
    ).rows,
  ).toEqual([]);
});
