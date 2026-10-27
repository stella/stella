import { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { READER_ANSWER_ERROR_CODES } from "@stll/api-contract/reader-answers";

const database = new PGlite();
afterAll(async () => await database.close());

test("adds validated diagnostics and replays without changing failed messages", async () => {
  await database.exec(`
    CREATE TABLE legal_reader_answer_messages (id integer PRIMARY KEY, status text NOT NULL);
    INSERT INTO legal_reader_answer_messages VALUES (1, 'failed'), (2, 'complete');
  `);
  const migration = readFileSync(
    nodePath.resolve(
      import.meta.dir,
      "../../drizzle/20261010212200_reader_answer_message_diagnostics/migration.sql",
    ),
    "utf-8",
  );
  const featureRefusalMigration = readFileSync(
    nodePath.resolve(
      import.meta.dir,
      "../../drizzle/20261024090100_reader_answer_feature_refusal/migration.sql",
    ),
    "utf-8",
  );
  const runMigration = async (sql: string) => {
    await database.exec("BEGIN");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) {
        await database.exec(statement);
      }
    }
    await database.exec("COMMIT");
  };
  await runMigration(migration);
  await runMigration(migration);
  const migrate = async () => await runMigration(featureRefusalMigration);
  await migrate();
  const existing = await database.query<{
    id: number;
    error_code: string | null;
    invalid_citation_count: number;
  }>(
    `SELECT id, error_code, invalid_citation_count FROM legal_reader_answer_messages ORDER BY id`,
  );
  expect(existing.rows).toEqual([
    { id: 1, error_code: null, invalid_citation_count: 0 },
    { id: 2, error_code: null, invalid_citation_count: 0 },
  ]);
  await database.query(
    `INSERT INTO legal_reader_answer_messages (id, status, error_code, invalid_citation_count)
     SELECT 2 + ordinal::integer, 'failed', code, 1 FROM unnest($1::text[]) WITH ORDINALITY AS codes(code, ordinal)`,
    [READER_ANSWER_ERROR_CODES],
  );
  await migrate();
  const codes = await database.query<{ error_code: string }>(
    `SELECT error_code FROM legal_reader_answer_messages WHERE error_code IS NOT NULL`,
  );
  expect(new Set(codes.rows.map((row) => row.error_code))).toEqual(
    new Set(READER_ANSWER_ERROR_CODES),
  );
  const counts = await database.query<{ invalid_citation_count: number }>(
    `SELECT invalid_citation_count FROM legal_reader_answer_messages WHERE error_code IS NOT NULL`,
  );
  expect(counts.rows).toHaveLength(READER_ANSWER_ERROR_CODES.length);
  expect(counts.rows.every((row) => row.invalid_citation_count === 1)).toBe(
    true,
  );
  const checks = await database.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conrelid = 'legal_reader_answer_messages'::regclass AND contype = 'c'`,
  );
  expect(checks.rows).toHaveLength(2);
  expect(checks.rows.every((row) => row.convalidated)).toBe(true);
  const invalidCode = await Result.tryPromise(
    async () =>
      await database.exec(
        `INSERT INTO legal_reader_answer_messages (id, status, error_code) VALUES (100, 'failed', 'unknown')`,
      ),
  );
  expect(invalidCode.isErr()).toBe(true);
  const invalidCount = await Result.tryPromise(
    async () =>
      await database.exec(
        `INSERT INTO legal_reader_answer_messages (id, status, invalid_citation_count) VALUES (101, 'complete', -1)`,
      ),
  );
  expect(invalidCount.isErr()).toBe(true);
});
