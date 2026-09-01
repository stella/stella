import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { panic } from "better-result";
import { sql, type SQL } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { ASCII_FOLD_TABLE } from "@stll/text-normalize";

import { WORKSPACE_ACCESS_VIEW_NAME } from "@/api/db/rls";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const WORKSPACE_AUTHORIZATION_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260710173000_scalable_workspace_authorization",
  "migration.sql",
);
const CHAT_THREAD_TURN_WORKSPACE_CASCADE_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260803120000_chat_thread_turn_workspace_cascade",
  "migration.sql",
);
const DOCX_SUGGESTION_SOURCE_MATTERS_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260827120000_docx_suggestion_source_matters",
  "migration.sql",
);
const AGENT_SKILL_REVISIONS_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260827080000_agent_skill_revisions",
  "migration.sql",
);
const CORPUS_PROJECTION_REVISION_MIGRATION_PATHS = [
  nodePath.join(
    DRIZZLE_DIR,
    "20260826004100_corpus_projection_revision_fence",
    "migration.sql",
  ),
  nodePath.join(
    DRIZZLE_DIR,
    "20260901060000_concurrent_corpus_projection_revision_fence",
    "migration.sql",
  ),
] as const;

type PgliteSchemaDb = {
  execute: (query: SQL) => Promise<unknown>;
};

export const createSchemaPglite = async () =>
  await PGlite.create({ extensions: { pg_trgm } });

const readMigrationStatements = (migrationPath: string): string[] =>
  readFileSync(migrationPath, "utf-8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const executableSql = (statement: string): string =>
  statement.replace(/^[ \t]*--[^\n]*/gmu, "").trim();

/**
 * PGlite ships no `unaccent`, so the production `legislation_title_fold`
 * (migration 20260901130000) cannot be installed verbatim. This double is
 * generated from the fold table the unaccent parity test pins against the
 * real extension: NFD plus combining-mark removal for everything Unicode can
 * decompose, then the table's rules for the letters it cannot (`ł`, `ß`, `ø`).
 */
const legislationTitleFoldPgliteSql = (): string => {
  const entries = Object.entries(ASCII_FOLD_TABLE);
  const singles = entries.filter(([, folded]) => folded.length === 1);
  const multis = entries.filter(([, folded]) => folded.length !== 1);
  const quote = (value: string): string => `$fold$${value}$fold$`;
  let expression =
    "regexp_replace(normalize($1, NFD), '[\\u0300-\\u036f]', '', 'g')";
  expression = `translate(${expression}, ${quote(singles.map(([from]) => from).join(""))}, ${quote(singles.map(([, to]) => to).join(""))})`;
  for (const [from, to] of multis) {
    expression = `replace(${expression}, ${quote(from)}, ${quote(to)})`;
  }
  return `CREATE OR REPLACE FUNCTION legislation_title_fold(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $body$
  SELECT lower(${expression})
$body$`;
};

export const installPgliteSchemaPrerequisites = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  await db.execute(sql.raw(arabicNormalizeFunctionSql()));
  await db.execute(sql.raw(legislationTitleFoldPgliteSql()));
  // Drizzle emits policies that reference this view before its backing tables
  // exist. Install a harmless shape-compatible stub for schema creation; the
  // security test database replaces it after pushSchema finishes.
  await db.execute(
    sql.raw(`
      CREATE OR REPLACE VIEW public.${WORKSPACE_ACCESS_VIEW_NAME}
      AS SELECT
        NULL::uuid AS authorized_workspace_id,
        NULL::text AS workspace_status
      WHERE false
    `),
  );
};

const latestMigrationStatementContaining = (fragment: string): string => {
  const statements = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((dirName) => {
      const migrationPath = nodePath.join(
        DRIZZLE_DIR,
        dirName,
        "migration.sql",
      );
      return readMigrationStatements(migrationPath).filter((part) =>
        part.includes(fragment),
      );
    });

  const statement = statements.at(-1);

  if (!statement) {
    panic(`Migration statement not found: ${fragment}`);
  }

  return statement;
};

const arabicNormalizeFunctionSql = (): string =>
  latestMigrationStatementContaining(
    "CREATE OR REPLACE FUNCTION arabic_normalize",
  );

// Split by leading keyword so each pattern stays below the lint's regex
// complexity budget; together they cover PostgreSQL's transaction-control
// statements (single-keyword forms subsume their PREPARED/SAVEPOINT/TO
// variants).
const isTransactionControlStatement = (executable: string): boolean =>
  /^(?:ABORT|BEGIN|COMMIT|END|RELEASE|ROLLBACK|SAVEPOINT)\b/iu.test(
    executable,
  ) ||
  /^(?:PREPARE|START)\s+TRANSACTION\b/iu.test(executable) ||
  /^SET\s+(?:TRANSACTION|SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION)\b/iu.test(
    executable,
  );

export const installPgliteWorkspaceAccessObjects = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const migrationPaths = [
    WORKSPACE_AUTHORIZATION_MIGRATION_PATH,
    CHAT_THREAD_TURN_WORKSPACE_CASCADE_MIGRATION_PATH,
  ];
  for (const migrationPath of migrationPaths) {
    // oxlint-disable-next-line no-await-in-loop -- migration batches must stay ordered
    await installPgliteMigration({ db, migrationPath });
  }
  // The replay above rewrites every `workspace_*` policy to the plain matter
  // check, so a table whose policies carry a further predicate in the schema
  // needs its own ALTER POLICY statements replayed afterwards. The column
  // itself already exists from the push, so only the policy statements run.
  const policyStatements = readMigrationStatements(
    DOCX_SUGGESTION_SOURCE_MATTERS_MIGRATION_PATH,
  ).filter((statement) => executableSql(statement).startsWith("ALTER POLICY"));
  for (const statement of policyStatements) {
    // oxlint-disable-next-line no-await-in-loop -- policy DDL must execute in source order
    await db.execute(sql.raw(statement));
  }
};

// Drizzle's schema (and therefore pushSchema) has no construct for trigger
// functions, so 20260827080000_agent_skill_revisions's CREATE FUNCTION /
// CREATE TRIGGER statements never reach the test database through the push
// path that creates its tables, indexes, and RLS policies. Installing the
// full migration file after pushSchema would re-run its CREATE TABLE
// statements against tables pushSchema already created, so this pulls out
// only the trigger-function statements — mirroring how
// arabicNormalizeFunctionSql above extracts one function statement rather
// than replaying its migration.
const AGENT_SKILL_REVISION_TRIGGER_STATEMENT_PREFIXES = [
  "CREATE FUNCTION",
  "REVOKE ALL ON FUNCTION",
  "CREATE TRIGGER",
] as const;

export const installPgliteAgentSkillRevisionTrigger = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    AGENT_SKILL_REVISIONS_MIGRATION_PATH,
  ).filter((statement) =>
    AGENT_SKILL_REVISION_TRIGGER_STATEMENT_PREFIXES.some((prefix) =>
      executableSql(statement).startsWith(prefix),
    ),
  );
  for (const statement of statements) {
    // oxlint-disable-next-line no-await-in-loop -- function/trigger DDL must execute in source order
    await db.execute(sql.raw(statement));
  }
};

const CORPUS_PROJECTION_REVISION_STATEMENT_PREFIXES = [
  "CREATE FUNCTION",
  "CREATE OR REPLACE FUNCTION",
  "REVOKE ALL ON FUNCTION",
  "GRANT EXECUTE ON FUNCTION",
  "CREATE TRIGGER",
] as const;

/** Install the projection mutation fence omitted by declarative schema push. */
export const installPgliteCorpusProjectionRevisionFence = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  for (const migrationPath of CORPUS_PROJECTION_REVISION_MIGRATION_PATHS) {
    const statements = readMigrationStatements(migrationPath).filter(
      (statement) =>
        CORPUS_PROJECTION_REVISION_STATEMENT_PREFIXES.some((prefix) =>
          executableSql(statement).startsWith(prefix),
        ),
    );
    for (const statement of statements) {
      // oxlint-disable-next-line no-await-in-loop -- function/trigger DDL must execute in source order
      await db.execute(sql.raw(statement));
    }
  }
};

export const installPgliteMigration = async ({
  db,
  migrationPath,
}: {
  db: PgliteSchemaDb;
  migrationPath: string;
}): Promise<void> => {
  const statements = readMigrationStatements(migrationPath);
  for (const statement of statements) {
    const executable = executableSql(statement);
    if (executable.length === 0) {
      continue;
    }
    if (isTransactionControlStatement(executable)) {
      panic(
        "A test-installed migration cannot control Drizzle's outer transaction",
      );
    }
    if (/\bCONCURRENTLY\b/iu.test(executable)) {
      panic(
        "A test-installed migration cannot run concurrent DDL inside Drizzle's transaction",
      );
    }
    if (/^SET LOCAL\b/iu.test(executable)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- migration DDL must execute in source order
    await db.execute(sql.raw(statement));
  }
};
