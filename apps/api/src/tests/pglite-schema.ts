import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { panic } from "better-result";
import { sql, type SQL } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { WORKSPACE_ACCESS_VIEW_NAME } from "@/api/db/rls";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const WORKSPACE_AUTHORIZATION_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260710173000_scalable_workspace_authorization",
  "migration.sql",
);

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
  statement.replace(/^\s*--.*$/gmu, "").trim();

export const installPgliteSchemaPrerequisites = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  await db.execute(sql.raw(arabicNormalizeFunctionSql()));
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

export const installPgliteWorkspaceAccessObjects = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    WORKSPACE_AUTHORIZATION_MIGRATION_PATH,
  );
  for (const statement of statements) {
    const executable = executableSql(statement);
    if (executable.length === 0) {
      continue;
    }
    if (
      /^(?:ABORT|BEGIN|COMMIT(?:\s+PREPARED)?|END|PREPARE\s+TRANSACTION|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK(?:\s+(?:PREPARED|TO(?:\s+SAVEPOINT)?))?|SAVEPOINT|SET\s+(?:TRANSACTION|SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION)|START\s+TRANSACTION)\b/iu.test(
        executable,
      )
    ) {
      panic(
        "Workspace authorization migration cannot control Drizzle's outer transaction",
      );
    }
    if (/\bCONCURRENTLY\b/iu.test(executable)) {
      panic(
        "Workspace authorization migration cannot run concurrent DDL inside Drizzle's transaction",
      );
    }
    if (/^SET LOCAL\b/iu.test(executable)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- migration DDL must execute in source order
    await db.execute(sql.raw(statement));
  }
};
