import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * The test database is built from the schema, which carries no functions or
 * triggers, so a test that exercises the case-law projection trigger installs
 * it from the migrations: the index id function the trigger calls, the
 * trigger function, then the trigger, each from the last migration defining
 * it. Which migration is derived, not named: migrations apply in directory
 * order, so the last one that redefines an object is the definition a
 * database ends up with, and a later migration replacing it moves this with
 * it.
 */

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");

export const INDEX_ID_FUNCTION =
  "CREATE OR REPLACE FUNCTION case_law_corpus_index_id(generation text, country text)";
const PROJECTION_TRIGGER_FUNCTION =
  "CREATE OR REPLACE FUNCTION enqueue_case_law_corpus_index_projection()";
const PROJECTION_TRIGGER =
  "CREATE TRIGGER case_law_decisions_enqueue_corpus_index_projection";
const PROJECTION_TRIGGER_STATEMENT =
  /\b(?:CREATE|DROP) TRIGGER (?:IF EXISTS )?case_law_decisions_enqueue_corpus_index_projection\b/u;
const ACCOUNTING_FUNCTION =
  "CREATE OR REPLACE FUNCTION derive_case_law_corpus_index_accounting()";
const ACCOUNTING_OBJECT =
  /(?:INSERT INTO "case_law_corpus_index_count_backfills"|derive_case_law_corpus_index_accounting|add_inserted_case_law_corpus_index_counts|apply_updated_case_law_corpus_index_counts|subtract_deleted_case_law_corpus_index_counts|seed_case_law_corpus_index_count_backfill|case_law_corpus_index_projection_(?:derive_accounting|count_(?:insert|update|delete))|case_law_corpus_index_backfill_seed_count)/u;

/** Statements of a migration file, in order, comments included. */
export const migrationStatements = (path: string): string[] =>
  readFileSync(path, "utf-8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

/** Path of the last migration whose text contains `marker`. */
export const latestMigrationContaining = (marker: string): string => {
  const path = [...new Bun.Glob("*/migration.sql").scanSync(DRIZZLE_DIR)]
    .sort()
    .map((file) => nodePath.join(DRIZZLE_DIR, file))
    .findLast((file) => readFileSync(file, "utf-8").includes(marker));
  return path ?? panic(`no migration contains ${marker}`);
};

/** Statements matching `statementMarker` from the last migration containing `marker`. */
const latestStatements = (
  marker: string,
  statementMarker: RegExp,
): string[] => {
  const statements = migrationStatements(
    latestMigrationContaining(marker),
  ).filter((statement) => statementMarker.test(statement));
  if (statements.length === 0) {
    panic(`no statement matches ${statementMarker} for ${marker}`);
  }
  return statements;
};

/** The DDL that installs the projection trigger as the migrations define it. */
export const caseLawProjectionTriggerStatements = (): string[] => [
  ...latestStatements(
    INDEX_ID_FUNCTION,
    /FUNCTION case_law_corpus_index_id\(/u,
  ),
  ...latestStatements(
    PROJECTION_TRIGGER_FUNCTION,
    /enqueue_case_law_corpus_index_projection\(\)\s+RETURNS trigger/u,
  ),
  // The replacement drop (`DROP TRIGGER IF EXISTS ...`) and the creation.
  ...latestStatements(PROJECTION_TRIGGER, PROJECTION_TRIGGER_STATEMENT),
];

type Executor = {
  execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
};

/** Install the projection trigger and the functions it calls. */
export const installCaseLawProjectionTrigger = async (
  db: Executor,
): Promise<void> => {
  for (const statement of caseLawProjectionTriggerStatements()) {
    await db.execute(sql.raw(statement));
  }
};

/** The seed statement and triggers that maintain exact projection counts. */
export const caseLawProjectionAccountingStatements = (): string[] =>
  latestStatements(ACCOUNTING_FUNCTION, ACCOUNTING_OBJECT);

/** Install exact projection accounting in a schema-built test database. */
export const installCaseLawProjectionAccounting = async (
  db: Executor,
): Promise<void> => {
  for (const statement of caseLawProjectionAccountingStatements()) {
    await db.execute(sql.raw(statement));
  }
};
