import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { CHAT_RUN_TEXT_BOUNDARIES } from "./chat-run-text-boundaries";
import type { OnlineMigrationConnection } from "./online-migration-connection";

test("retained text boundaries converge across batches and new inserts keep them current", async () => {
  const database = new PGlite();
  await database.exec(`CREATE TABLE chat_run_log_entries (
    organization_id text, run_id text, seq bigint, chunk jsonb,
    PRIMARY KEY (organization_id, run_id, seq));
    INSERT INTO chat_run_log_entries
    SELECT 'org', 'run', n, jsonb_build_object('type', CASE WHEN n % 2 = 1 THEN 'TEXT_MESSAGE_START' ELSE 'TEXT_MESSAGE_END' END,
      'messageId', ((n-1)/2)::text, 'role', 'assistant') FROM generate_series(1, 1002) n;
    INSERT INTO chat_run_log_entries VALUES ('org', 'run', 1003, '{"type":"TEXT_MESSAGE_START","messageId":"user","role":"user"}');
    INSERT INTO chat_run_log_entries VALUES
      ('org','run',1004,'{"type":"TEXT_MESSAGE_CHUNK","role":"assistant","delta":"text"}'),
      ('org','run',1005,'{"type":"TEXT_MESSAGE_START","messageId":"other","role":"user"}');`);
  await database.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20261028182200_chat_run_text_boundaries/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  const connection = {
    release: () => undefined,
    execute: async (query, params = []) => {
      await database.query(query, [...params]);
    },
    query: async (query, params = []) =>
      (await database.query(query, [...params])).rows,
  } satisfies OnlineMigrationConnection;
  expect((await CHAT_RUN_TEXT_BOUNDARIES.readCompletion(connection)).type).toBe(
    "incomplete",
  );
  await CHAT_RUN_TEXT_BOUNDARIES.repair(connection);
  expect((await CHAT_RUN_TEXT_BOUNDARIES.readCompletion(connection)).type).toBe(
    "complete",
  );
  expect(
    (
      await database.query(
        `SELECT count(*)::integer AS count FROM chat_run_log_entries WHERE seq % 2 = 1 AND seq < 1003 AND text_message_end_seq = seq + 1`,
      )
    ).rows,
  ).toEqual([{ count: 501 }]);
  expect(
    (
      await database.query(
        "SELECT text_message_end_seq::text AS ending FROM chat_run_log_entries WHERE seq = 1004",
      )
    ).rows,
  ).toEqual([{ ending: "1005" }]);
  const before = (
    await database.query("SELECT * FROM chat_run_log_entries ORDER BY seq")
  ).rows;
  await CHAT_RUN_TEXT_BOUNDARIES.repair(connection);
  expect(
    (await database.query("SELECT * FROM chat_run_log_entries ORDER BY seq"))
      .rows,
  ).toEqual(before);
  await database.exec(`INSERT INTO chat_run_log_entries VALUES
    ('org','run',1006,'{"type":"TEXT_MESSAGE_START","messageId":"assistant","role":"assistant"}', DEFAULT),
    ('org','run',1007,'{"type":"TEXT_MESSAGE_END","messageId":"user"}', DEFAULT);`);
  expect(
    (
      await database.query(
        "SELECT seq::text, text_message_end_seq::text AS ending FROM chat_run_log_entries WHERE seq IN (1003,1006) ORDER BY seq",
      )
    ).rows,
  ).toEqual([
    { seq: "1003", ending: "1007" },
    { seq: "1006", ending: null },
  ]);
  await database.close();
});
