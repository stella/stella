import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

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
  ('${SOURCE_ID}', '${PARSED_ID}', 2, 3, 'unchanged', NULL, 'second', '2026-02-02T00:00:00Z');
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

test("the batch-slot migration preserves every row while recording parsed raw generations", async () => {
  const database = await buildLegacyDatabase();
  const decisionsBefore = await database.query(decisionProjection);
  const blockedBefore = await database.query(blockedProjection);

  await database.exec(migrationSql);

  expect((await database.query(decisionProjection)).rows).toEqual(
    decisionsBefore.rows,
  );
  expect((await database.query(blockedProjection)).rows).toEqual(
    blockedBefore.rows,
  );

  const generations = await database.query<{
    id: string;
    parsed_source_hash: string | null;
  }>("SELECT id, parsed_source_hash FROM case_law_decisions ORDER BY id");
  expect(generations.rows).toEqual([
    { id: PARSED_ID, parsed_source_hash: PARSED_HASH },
    { id: UNPARSED_ID, parsed_source_hash: null },
    { id: RAW_LESS_ID, parsed_source_hash: null },
  ]);

  const blocked = await database.query<{
    parser_version_to: number;
    source_hash: string;
  }>(
    "SELECT parser_version_to, source_hash FROM case_law_replay_blocked ORDER BY parser_version_to",
  );
  expect(blocked.rows).toEqual([
    { parser_version_to: 2, source_hash: PARSED_HASH },
    { parser_version_to: 3, source_hash: PARSED_HASH },
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
  expect(
    (
      await database.query(
        "SELECT count(*) AS count FROM case_law_replay_blocked",
      )
    ).rows,
  ).toEqual([{ count: 2 }]);

  await database.close();
});
