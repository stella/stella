import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  CASE_LAW_PARSED_SOURCE_HASH_REPAIR_BATCH_SIZE,
  repairCaseLawParsedSourceHashBatch,
} from "./case-law-parsed-source-hash-repair";
import {
  CASE_LAW_REPLAY_RECEIPT_REPAIR_BATCH_SIZE,
  finishCaseLawReplayReceiptRepair,
  repairCaseLawReplayReceiptBatch,
} from "./case-law-replay-receipt-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import { CASE_LAW_RAW_GENERATION_UNKNOWN } from "./schema/case-law-replay";

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261022120000_case_law_batch_slots/migration.sql",
);

const forPglite = (sql: string): string =>
  sql
    .replaceAll("--> statement-breakpoint", "")
    .replaceAll("CREATE INDEX CONCURRENTLY", "CREATE INDEX")
    .replace(/^COMMIT;$/gmu, "")
    .replace(/^BEGIN;$/gmu, "");

const migrationSql = forPglite(readFileSync(MIGRATION_PATH, "utf-8"));

const PRE_MIGRATION_SCHEMA = `
CREATE TABLE case_law_sources (id uuid PRIMARY KEY);
CREATE TABLE case_law_decisions (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES case_law_sources(id),
  case_number varchar(256) NOT NULL,
  parser_version smallint DEFAULT 0,
  source_raw text,
  source_raw_s3_key varchar(512),
  source_hash varchar(64),
  fulltext text,
  sections jsonb,
  document_ast jsonb,
  text_s3_key varchar(512),
  normalized_s3_key varchar(512),
  ast_s3_key varchar(512),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE case_law_replay_blocked (
  source_id uuid NOT NULL REFERENCES case_law_sources(id),
  decision_id uuid NOT NULL,
  parser_version_from integer,
  parser_version_to integer NOT NULL,
  outcome text NOT NULL,
  reason text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_law_replay_blocked_pkey PRIMARY KEY (decision_id, parser_version_to)
);
`;

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const PARSED_ID = "00000000-0000-4000-8000-000000000011";
const UNPARSED_ID = "00000000-0000-4000-8000-000000000012";
const RAW_LESS_ID = "00000000-0000-4000-8000-000000000013";
const PARSED_HASH = "a".repeat(64);
const UNPARSED_HASH = "b".repeat(64);

const PRE_MIGRATION_ROWS = `
INSERT INTO case_law_sources VALUES ('${SOURCE_ID}');
INSERT INTO case_law_decisions
  (id, source_id, case_number, parser_version, source_raw, source_hash, fulltext, sections, document_ast, metadata, created_at)
VALUES
  ('${PARSED_ID}', '${SOURCE_ID}', 'parsed', 4, '<html>parsed</html>', '${PARSED_HASH}', 'judgment', '[{"type":"body"}]', '{"type":"root"}', '{"kept":true}', '2026-01-01T00:00:00Z'),
  ('${UNPARSED_ID}', '${SOURCE_ID}', 'unparsed', NULL, '<html>raw</html>', '${UNPARSED_HASH}', NULL, NULL, NULL, '{"kept":"raw"}', '2026-01-02T00:00:00Z'),
  ('${RAW_LESS_ID}', '${SOURCE_ID}', 'raw-less', 2, NULL, NULL, 'legacy text', NULL, NULL, '{"kept":"raw-less"}', '2026-01-03T00:00:00Z');
INSERT INTO case_law_replay_blocked
  (source_id, decision_id, parser_version_from, parser_version_to, outcome, reason, detail, created_at)
VALUES
  ('${SOURCE_ID}', '${PARSED_ID}', 1, 2, 'rejected', 'missing-payload', 'first', '2026-02-01T00:00:00Z'),
  ('${SOURCE_ID}', '${PARSED_ID}', 2, 3, 'unchanged', NULL, 'second', '2026-02-02T00:00:00Z'),
  ('${SOURCE_ID}', '${RAW_LESS_ID}', 1, 2, 'rejected', 'missing-payload', 'raw-less', '2026-02-03T00:00:00Z');
`;

const decisionProjection = `
  SELECT id, source_id, case_number, parser_version, source_raw, source_raw_s3_key,
    source_hash, fulltext, sections, document_ast, text_s3_key, normalized_s3_key,
    ast_s3_key, metadata, created_at
  FROM case_law_decisions ORDER BY id`;
const blockedProjection = `
  SELECT source_id, decision_id, parser_version_from, parser_version_to,
    outcome, reason, detail, created_at
  FROM case_law_replay_blocked ORDER BY decision_id, parser_version_to`;

const buildLegacyDatabase = async () => {
  const database = new PGlite();
  await database.exec(PRE_MIGRATION_SCHEMA);
  await database.exec(PRE_MIGRATION_ROWS);
  return database;
};

const asRepairConnection = (database: PGlite) => ({
  execute: async (query: string, params: readonly unknown[] = []) => {
    const compatible = query.replaceAll(
      "CREATE UNIQUE INDEX CONCURRENTLY",
      "CREATE UNIQUE INDEX",
    );
    if (params.length === 0 && compatible.includes(";")) {
      await database.exec(compatible);
      return;
    }
    await database.query(compatible, [...params]);
  },
  query: async (query: string, params: readonly unknown[] = []) =>
    (await database.query(query, [...params])).rows,
  release: () => {},
});

test("the batch-slot migration and resumable repair preserve every row", async () => {
  const database = await buildLegacyDatabase();
  const extraCount = CASE_LAW_PARSED_SOURCE_HASH_REPAIR_BATCH_SIZE;
  const extraValues = Array.from({ length: extraCount }, (_, index) => {
    const suffix = (100 + index).toString(16).padStart(12, "0");
    return `('00000000-0000-4000-8000-${suffix}', '${SOURCE_ID}', 'extra-${String(index)}', '${"c".repeat(64)}', 'parsed')`;
  }).join(",");
  await database.exec(
    `INSERT INTO case_law_decisions (id, source_id, case_number, source_hash, fulltext) VALUES ${extraValues}`,
  );
  const extraReceipts = Array.from({ length: extraCount }, (_, index) => {
    const suffix = (100 + index).toString(16).padStart(12, "0");
    return `('${SOURCE_ID}', '00000000-0000-4000-8000-${suffix}', 1, 2, 'unchanged')`;
  }).join(",");
  await database.exec(
    `INSERT INTO case_law_replay_blocked (source_id, decision_id, parser_version_from, parser_version_to, outcome) VALUES ${extraReceipts}`,
  );
  const decisionsBefore = await database.query(decisionProjection);
  const blockedBefore = await database.query(blockedProjection);

  await database.exec(migrationSql);

  expect((await database.query(decisionProjection)).rows).toEqual(
    decisionsBefore.rows,
  );
  expect((await database.query(blockedProjection)).rows).toEqual(
    blockedBefore.rows,
  );

  const repairConnection = asRepairConnection(database);
  const first = await repairCaseLawParsedSourceHashBatch(
    repairConnection,
    null,
    CASE_LAW_PARSED_SOURCE_HASH_REPAIR_BATCH_SIZE,
  );
  expect(first.done).toBe(false);
  const afterFirst = await database.query<{ count: number | string }>(
    "SELECT count(*) AS count FROM case_law_decisions WHERE parsed_source_hash IS NOT NULL",
  );
  expect(Number(afterFirst.rows.at(0)?.count)).toBe(
    CASE_LAW_PARSED_SOURCE_HASH_REPAIR_BATCH_SIZE - 2,
  );

  // A new process resumes from the committed cursor rather than starting over.
  const resumed = await repairCaseLawParsedSourceHashBatch(
    repairConnection,
    first.cursor,
    CASE_LAW_PARSED_SOURCE_HASH_REPAIR_BATCH_SIZE,
  );
  expect(resumed.done).toBe(true);

  const firstReceiptBatch = await repairCaseLawReplayReceiptBatch(
    repairConnection,
    null,
    CASE_LAW_REPLAY_RECEIPT_REPAIR_BATCH_SIZE,
  );
  expect(firstReceiptBatch.done).toBe(false);
  const repairedReceiptCount = await database.query<{ count: number | string }>(
    "SELECT count(*) AS count FROM case_law_replay_blocked WHERE source_hash IS NOT NULL",
  );
  expect(Number(repairedReceiptCount.rows.at(0)?.count)).toBe(
    CASE_LAW_REPLAY_RECEIPT_REPAIR_BATCH_SIZE,
  );
  const resumedReceiptBatch = await repairCaseLawReplayReceiptBatch(
    repairConnection,
    firstReceiptBatch.cursor,
    CASE_LAW_REPLAY_RECEIPT_REPAIR_BATCH_SIZE,
  );
  expect(resumedReceiptBatch.done).toBe(true);
  expect(
    await finishCaseLawReplayReceiptRepair(
      repairConnection,
      createUngatedTableGateForTests(repairConnection),
    ),
  ).toEqual({ type: "complete" });

  const generations = await database.query<{
    id: string;
    parsed_source_hash: string | null;
  }>("SELECT id, parsed_source_hash FROM case_law_decisions ORDER BY id");
  expect(generations.rows).toEqual([
    { id: PARSED_ID, parsed_source_hash: PARSED_HASH },
    { id: UNPARSED_ID, parsed_source_hash: null },
    { id: RAW_LESS_ID, parsed_source_hash: null },
    ...Array.from({ length: extraCount }, (_, index) => ({
      id: `00000000-0000-4000-8000-${(100 + index).toString(16).padStart(12, "0")}`,
      parsed_source_hash: "c".repeat(64),
    })),
  ]);

  const blocked = await database.query<{
    parser_version_to: number;
    source_hash: string;
  }>(
    `SELECT parser_version_to, source_hash FROM case_law_replay_blocked
     WHERE decision_id IN ('${PARSED_ID}', '${RAW_LESS_ID}')
     ORDER BY parser_version_to, source_hash`,
  );
  expect(blocked.rows).toEqual([
    { parser_version_to: 2, source_hash: PARSED_HASH },
    {
      parser_version_to: 2,
      source_hash: CASE_LAW_RAW_GENERATION_UNKNOWN,
    },
    { parser_version_to: 3, source_hash: PARSED_HASH },
  ]);

  const primaryKey = await database.query<{ columns: string[] }>(`
    SELECT array_agg(a.attname ORDER BY k.ordinality) AS columns
    FROM pg_constraint c
    JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.conrelid = 'case_law_replay_blocked'::regclass AND c.contype = 'p'
    GROUP BY c.oid`);
  expect(primaryKey.rows).toEqual([
    { columns: ["decision_id", "source_hash", "parser_version_to"] },
  ]);

  const tableCount = await database.query<{ count: number | string }>(`
    SELECT count(*) AS count FROM information_schema.tables
    WHERE table_name IN ('case_law_batch_slot_runs', 'case_law_batch_slot_sources', 'case_law_fetch_item_receipts')`);
  expect(Number(tableCount.rows.at(0)?.count)).toBe(3);

  // A deploy retry is a no-op for data and leaves every object usable.
  await database.exec(migrationSql);
  expect((await database.query(decisionProjection)).rows).toEqual(
    decisionsBefore.rows,
  );
  expect((await database.query(blockedProjection)).rows).toEqual(
    blockedBefore.rows,
  );
  const repairedBeforeRetry = await database.query(
    "SELECT id, parsed_source_hash FROM case_law_decisions ORDER BY id",
  );
  await repairCaseLawParsedSourceHashBatch(
    repairConnection,
    null,
    CASE_LAW_PARSED_SOURCE_HASH_REPAIR_BATCH_SIZE,
  );
  expect(
    (
      await database.query(
        "SELECT id, parsed_source_hash FROM case_law_decisions ORDER BY id",
      )
    ).rows,
  ).toEqual(repairedBeforeRetry.rows);
  const receiptsBeforeRetry = await database.query(
    "SELECT * FROM case_law_replay_blocked ORDER BY decision_id, parser_version_to",
  );
  const retryFirst = await repairCaseLawReplayReceiptBatch(
    repairConnection,
    null,
    CASE_LAW_REPLAY_RECEIPT_REPAIR_BATCH_SIZE,
  );
  expect(retryFirst.done).toBe(false);
  expect(
    (
      await repairCaseLawReplayReceiptBatch(
        repairConnection,
        retryFirst.cursor,
        CASE_LAW_REPLAY_RECEIPT_REPAIR_BATCH_SIZE,
      )
    ).done,
  ).toBe(true);
  expect(
    (
      await database.query(
        "SELECT * FROM case_law_replay_blocked ORDER BY decision_id, parser_version_to",
      )
    ).rows,
  ).toEqual(receiptsBeforeRetry.rows);
  expect(
    (
      await database.query(
        "SELECT count(*) AS count FROM case_law_replay_blocked",
      )
    ).rows,
  ).toEqual([{ count: extraCount + 3 }]);

  await database.close();
});
