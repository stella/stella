import { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const database = new PGlite();
afterAll(async () => await database.close());

test("backfills each thread in its previous order and preserves unique positive positions on replay", async () => {
  await database.exec(`
    CREATE TABLE legal_reader_answer_messages (
      id integer PRIMARY KEY, answer_id integer NOT NULL, created_at timestamptz NOT NULL
    );
    CREATE INDEX legal_reader_answer_messages_answer_idx
      ON legal_reader_answer_messages (answer_id, created_at, id);
    INSERT INTO legal_reader_answer_messages VALUES
      (4, 1, '2026-10-10 12:00:00+00'),
      (3, 2, '2026-10-10 12:00:00+00'),
      (2, 1, '2026-10-10 12:01:00+00'),
      (1, 2, '2026-10-10 12:00:00+00');
  `);
  const migration = readFileSync(
    nodePath.resolve(
      import.meta.dir,
      "../../drizzle/20261010212300_reader_answer_message_sequence/migration.sql",
    ),
    "utf-8",
  );
  const migrate = async () => {
    await database.exec("BEGIN");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) {
        await database.exec(statement);
      }
    }
    await database.exec("COMMIT");
  };
  await migrate();
  await migrate();
  const ordered = await database.query<{
    id: number;
    answer_id: number;
    sequence: number;
  }>(
    `SELECT id, answer_id, sequence FROM legal_reader_answer_messages ORDER BY answer_id, sequence`,
  );
  expect(ordered.rows).toEqual([
    { id: 4, answer_id: 1, sequence: 1 },
    { id: 2, answer_id: 1, sequence: 2 },
    { id: 1, answer_id: 2, sequence: 1 },
    { id: 3, answer_id: 2, sequence: 2 },
  ]);
  const column = await database.query<{
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT is_nullable, column_default FROM information_schema.columns
     WHERE table_name = 'legal_reader_answer_messages' AND column_name = 'sequence'`,
  );
  expect(column.rows).toEqual([{ is_nullable: "NO", column_default: null }]);
  for (const sequence of [0, -1, 1]) {
    const rejected = await Result.tryPromise(
      async () =>
        await database.query(
          `INSERT INTO legal_reader_answer_messages (id, answer_id, created_at, sequence)
       VALUES (10, 1, now(), $1)`,
          [sequence],
        ),
    );
    expect(rejected.isErr()).toBe(true);
  }
  const omitted = await Result.tryPromise(
    async () =>
      await database.exec(
        `INSERT INTO legal_reader_answer_messages (id, answer_id, created_at) VALUES (10, 1, now())`,
      ),
  );
  expect(omitted.isErr()).toBe(true);
  await database.exec(`
    INSERT INTO legal_reader_answer_messages (id, answer_id, created_at, sequence)
    VALUES (10, 1, '2020-01-01 00:00:00+00', 3), (11, 2, '2020-01-01 00:00:00+00', 3);
  `);
  await migrate();
  const added = await database.query<{ answer_id: number; sequence: number }>(
    `SELECT answer_id, sequence FROM legal_reader_answer_messages WHERE id IN (10, 11) ORDER BY answer_id`,
  );
  expect(added.rows).toEqual([
    { answer_id: 1, sequence: 3 },
    { answer_id: 2, sequence: 3 },
  ]);
});
