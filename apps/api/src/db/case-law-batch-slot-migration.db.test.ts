import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { rejectionOf } from "@stll/property-testing/rejection";

import { PG_ERROR } from "@/api/lib/pg-error";

import { caseLawDecisions } from "./schema/case-law";

const migrationSql = readFileSync(
  nodePath.resolve(
    import.meta.dir,
    "../../drizzle/20261022120000_case_law_batch_slots/migration.sql",
  ),
  "utf-8",
).replaceAll("--> statement-breakpoint", "");
const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000002";
const DECISION_ID = "00000000-0000-4000-8000-000000000011";
const HASH = "a".repeat(64);
const RAW_KEY = "raw/immutable-input";

type ParsedGenerationColumnDisposition =
  "parse-input-or-output" | "proof" | "bookkeeping";

// Every schema addition must decide whether a stored parse depends on it.
// IDs, scheduling/observation clocks, mirror state and citation/index projections
// do not alter parser output; analysis is independently generated from it.
const PARSED_GENERATION_COLUMNS = {
  id: "bookkeeping",
  sourceId: "parse-input-or-output",
  caseNumber: "parse-input-or-output",
  caseNumberType: "parse-input-or-output",
  citationKey: "parse-input-or-output",
  docketFamilyKey: "parse-input-or-output",
  slug: "parse-input-or-output",
  ecli: "parse-input-or-output",
  court: "parse-input-or-output",
  courtId: "parse-input-or-output",
  country: "parse-input-or-output",
  language: "parse-input-or-output",
  languageGroupKey: "parse-input-or-output",
  decisionDate: "parse-input-or-output",
  decisionType: "parse-input-or-output",
  fulltext: "parse-input-or-output",
  textlessDetailRecheckedAt: "bookkeeping",
  sections: "parse-input-or-output",
  documentAst: "parse-input-or-output",
  analysis: "bookkeeping",
  parserVersion: "parse-input-or-output",
  reviewExtractionVersion: "bookkeeping",
  sourceRaw: "parse-input-or-output",
  sourceRawS3Key: "parse-input-or-output",
  sourceRawContentType: "parse-input-or-output",
  sourceUrl: "parse-input-or-output",
  documentUrl: "parse-input-or-output",
  sourceDocumentId: "parse-input-or-output",
  sheetNumber: "parse-input-or-output",
  documentFetchRequestedAt: "bookkeeping",
  documentFetchAttemptedAt: "bookkeeping",
  documentFetchAttempts: "bookkeeping",
  metadata: "parse-input-or-output",
  sourceHash: "parse-input-or-output",
  sourceHashVersion: "parse-input-or-output",
  parsedSourceHash: "proof",
  parsedSourceHashVersion: "proof",
  parsedSourceRawS3Key: "proof",
  sourceObservedAt: "bookkeeping",
  sourceObservationOrder: "bookkeeping",
  sourceObservationHash: "bookkeeping",
  redactedAt: "parse-input-or-output",
  corpusMirrorStatus: "bookkeeping",
  citationAuthority: "bookkeeping",
  citationCount: "bookkeeping",
  citationAuthorityComputedAt: "bookkeeping",
  textS3Key: "parse-input-or-output",
  normalizedS3Key: "parse-input-or-output",
  astS3Key: "parse-input-or-output",
  contentHash: "parse-input-or-output",
  indexedHash: "bookkeeping",
  indexedGeneration: "bookkeeping",
  indexedAt: "bookkeeping",
  projectionEpoch: "bookkeeping",
  createdAt: "bookkeeping",
  updatedAt: "bookkeeping",
} as const satisfies Record<
  keyof typeof caseLawDecisions.$inferSelect,
  ParsedGenerationColumnDisposition
>;
const columnEntries = Object.entries(getColumns(caseLawDecisions));
const columns = columnEntries.map(([, column]) => column);
const expectedTriggerFields = Object.entries(PARSED_GENERATION_COLUMNS)
  .filter(([, disposition]) => disposition === "parse-input-or-output")
  .map(([property]) => {
    const entry = columnEntries.find(([key]) => key === property);
    if (entry === undefined) {
      return panic("Classified parse column is missing from the schema");
    }
    const [, column] = entry;
    return column.name;
  });
const comparedRows =
  /IF ROW\((?<before>[\s\S]*?)\) IS DISTINCT FROM ROW\((?<after>[\s\S]*?)\) THEN/u.exec(
    migrationSql,
  )?.groups;
const oldComparedRow =
  comparedRows?.["before"] ?? panic("Trigger OLD comparison row is missing");
const newComparedRow =
  comparedRows?.["after"] ?? panic("Trigger NEW comparison row is missing");
const triggerFields = [
  ...oldComparedRow.matchAll(/OLD\."(?<field>[^"\n]+)"/gu),
].map(
  (match) =>
    match.groups?.["field"] ?? panic("Trigger field capture is missing"),
);
const newTriggerFields = [
  ...newComparedRow.matchAll(/NEW\."(?<field>[^"\n]+)"/gu),
].map(
  (match) =>
    match.groups?.["field"] ?? panic("Trigger field capture is missing"),
);
type TriggerColumn = (typeof columns)[number];
const triggerMutationValue = (column: TriggerColumn) => {
  if (column.name === "source_id") {
    return OTHER_SOURCE_ID;
  }
  const sqlType = column.getSQLType();
  if (sqlType === "uuid") {
    return "00000000-0000-4000-8000-000000000099";
  }
  if (sqlType.includes("int")) {
    return 3;
  }
  if (sqlType.includes("timestamp") || sqlType === "date") {
    return "2026-10-01";
  }
  if (sqlType === "jsonb") {
    return JSON.stringify({ changed: true });
  }
  if (sqlType === "text" || sqlType.startsWith("varchar")) {
    return "CHG";
  }
  throw new TypeError(`Unsupported mutation fixture type: ${sqlType}`);
};
const createLegacyDatabase = async () => {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE case_law_sources (id uuid PRIMARY KEY);
    INSERT INTO case_law_sources VALUES ('${SOURCE_ID}'), ('${OTHER_SOURCE_ID}');
    CREATE TABLE case_law_decisions (
      id uuid PRIMARY KEY,
      ${columns
        .filter((column) => expectedTriggerFields.includes(column.name))
        .map((column) => `"${column.name}" ${column.getSQLType()}`)
        .join(",")},
      source_observation_order bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE case_law_replay_batches (id text PRIMARY KEY);
    CREATE TABLE case_law_replay_blocked (
      source_id uuid NOT NULL REFERENCES case_law_sources(id),
      decision_id uuid NOT NULL,
      parser_version_from integer,
      parser_version_to integer NOT NULL,
      outcome text NOT NULL,
      reason text,
      detail text,
      PRIMARY KEY (decision_id, parser_version_to)
    );
    INSERT INTO case_law_decisions
      (id, source_id, case_number, parser_version, source_raw_s3_key,
       source_hash, source_hash_version, fulltext)
      VALUES ('${DECISION_ID}', '${SOURCE_ID}', 'legacy', 2, '${RAW_KEY}', '${HASH}', 1, 'stored judgment'),
        ('00000000-0000-4000-8000-000000000012', '${SOURCE_ID}', 'unparsed', NULL, 'raw/unparsed', '${HASH}', 1, NULL),
        ('00000000-0000-4000-8000-000000000013', '${SOURCE_ID}', 'raw-less', 2, NULL, NULL, 0, 'legacy text');
    INSERT INTO case_law_replay_blocked
      (source_id, decision_id, parser_version_from, parser_version_to, outcome)
      VALUES ('${SOURCE_ID}', '${DECISION_ID}', 1, 2, 'unchanged');
  `);
  return database;
};

const stamp = async (database: PGlite) => {
  await database.query(
    `UPDATE case_law_decisions SET
    parsed_source_hash = source_hash,
    parsed_source_hash_version = source_hash_version,
    parsed_source_raw_s3_key = source_raw_s3_key WHERE id = $1`,
    [DECISION_ID],
  );
};
const readProof = async (database: PGlite) =>
  (
    await database.query(
      `SELECT parsed_source_hash, parsed_source_hash_version,
    parsed_source_raw_s3_key FROM case_law_decisions WHERE id = $1`,
      [DECISION_ID],
    )
  ).rows;
const unknownStamp = {
  parsed_source_hash: null,
  parsed_source_hash_version: null,
  parsed_source_raw_s3_key: null,
};
const unknownProof = [unknownStamp];
const knownProof = [
  {
    parsed_source_hash: HASH,
    parsed_source_hash_version: 1,
    parsed_source_raw_s3_key: RAW_KEY,
  },
];

test("the expansion preserves legacy payloads, unknown provenance and deployed writer identity", async () => {
  const database = await createLegacyDatabase();
  try {
    const before = (
      await database.query<Record<string, unknown>>(
        "SELECT * FROM case_law_decisions",
      )
    ).rows;
    const receiptsBefore = (
      await database.query<Record<string, unknown>>(
        "SELECT * FROM case_law_replay_blocked",
      )
    ).rows;
    await database.exec(migrationSql);
    const after = (await database.query("SELECT * FROM case_law_decisions"))
      .rows;
    expect(after).toEqual(before.map((row) => ({ ...row, ...unknownStamp })));
    expect(
      (await database.query("SELECT * FROM case_law_replay_blocked")).rows,
    ).toEqual(
      receiptsBefore.map((row) => ({ ...row, source_raw_s3_key: null })),
    );
    expect(
      (
        await database.query(`SELECT array_agg(a.attname ORDER BY k.ordinality) AS columns
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = 'case_law_replay_blocked'::regclass AND c.contype = 'p'
      GROUP BY c.oid`)
      ).rows,
    ).toEqual([{ columns: ["decision_id", "parser_version_to"] }]);
    // This is the actual deployed ON CONFLICT pair, without a generation column.
    await database.query(
      `INSERT INTO case_law_replay_blocked
      (source_id, decision_id, parser_version_from, parser_version_to, outcome)
      VALUES ($1, $2, 1, 2, 'changed') ON CONFLICT (decision_id, parser_version_to) DO NOTHING`,
      [SOURCE_ID, DECISION_ID],
    );
    expect(
      (
        await database.query(
          "SELECT outcome, source_raw_s3_key FROM case_law_replay_blocked",
        )
      ).rows,
    ).toEqual([{ outcome: "unchanged", source_raw_s3_key: null }]);
    expect(
      (
        await database.query(`SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('case_law_batch_slot_runs', 'case_law_batch_slot_sources', 'case_law_fetch_item_receipts')`)
      ).rows,
    ).toEqual([]);
    await database.exec(
      "ALTER TABLE case_law_decisions VALIDATE CONSTRAINT case_law_decisions_parsed_source_complete",
    );
    await database.exec(
      "ALTER TABLE case_law_decisions VALIDATE CONSTRAINT case_law_decisions_parsed_source_complete",
    );
    expect(await readProof(database)).toEqual(unknownProof);
  } finally {
    await database.close();
  }
});

test("all actual input and derived mutations invalidate provenance even at the same observation order", async () => {
  const database = await createLegacyDatabase();
  try {
    await database.exec(migrationSql);
    expect(triggerFields.toSorted(compareCodeUnit)).toEqual(
      expectedTriggerFields.toSorted(compareCodeUnit),
    );
    expect(newTriggerFields.toSorted(compareCodeUnit)).toEqual(
      expectedTriggerFields.toSorted(compareCodeUnit),
    );
    for (const field of expectedTriggerFields) {
      const column = columns.find((candidate) => candidate.name === field);
      if (column === undefined) {
        throw new TypeError(
          "Trigger fixture column is missing from the canonical schema",
        );
      }
      const value = triggerMutationValue(column);
      await database.exec("BEGIN");
      await stamp(database);
      expect(await readProof(database)).toEqual(knownProof);
      await database.query(
        `UPDATE case_law_decisions SET "${field}" = $1 WHERE id = $2`,
        [value, DECISION_ID],
      );
      expect(await readProof(database)).toEqual(unknownProof);
      expect(
        (
          await database.query(
            `SELECT source_observation_order::int AS source_observation_order FROM case_law_decisions WHERE id = '${DECISION_ID}'`,
          )
        ).rows,
      ).toEqual([{ source_observation_order: 1 }]);
      await database.exec("ROLLBACK");
    }
    await stamp(database);
    await database.exec(
      "UPDATE case_law_decisions SET updated_at = updated_at + interval '1 second', source_observation_order = 2",
    );
    expect(await readProof(database)).toEqual(knownProof);
    await database.exec(
      "UPDATE case_law_decisions SET fulltext = 'parsed again'",
    );
    expect(await readProof(database)).toEqual(unknownProof);
    await stamp(database);
    expect(await readProof(database)).toEqual(knownProof);
  } finally {
    await database.close();
  }
});

test("the complete parsed-input group rejects partial stamps", async () => {
  const database = await createLegacyDatabase();
  try {
    await database.exec(migrationSql);
    expect(
      await rejectionOf(
        database.query(
          "UPDATE case_law_decisions SET parsed_source_hash = $1",
          [HASH],
        ),
      ),
    ).toMatchObject({
      code: PG_ERROR.CHECK_VIOLATION,
      constraint: "case_law_decisions_parsed_source_complete",
    });
    expect(await readProof(database)).toEqual(unknownProof);
  } finally {
    await database.close();
  }
});
