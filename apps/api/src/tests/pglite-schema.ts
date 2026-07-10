import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { panic } from "better-result";
import { sql, type SQL } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  WORKSPACE_ACCESS_FUNCTION_NAME,
  WORKSPACE_ARRAY_ACCESS_FUNCTION_NAME,
  WORKSPACE_ACCESS_VIEW_NAME,
} from "@/api/db/rls";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");

type PgliteSchemaDb = {
  execute: (query: SQL) => Promise<unknown>;
};

export const createSchemaPglite = async () =>
  await PGlite.create({ extensions: { pg_trgm } });

export const installPgliteSchemaPrerequisites = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  await db.execute(sql.raw(arabicNormalizeFunctionSql()));
  // Drizzle emits policies that reference these routines before their backing
  // tables exist. Install harmless stubs for schema creation; the security
  // test database replaces them after pushSchema finishes.
  await db.execute(
    sql.raw(`
      CREATE OR REPLACE VIEW public.${WORKSPACE_ACCESS_VIEW_NAME}
      AS SELECT NULL::uuid AS workspace_id WHERE false
    `),
  );
  await db.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION public.${WORKSPACE_ACCESS_FUNCTION_NAME}(uuid)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      AS 'SELECT false'
    `),
  );
  await db.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION public.${WORKSPACE_ARRAY_ACCESS_FUNCTION_NAME}(uuid[])
      RETURNS boolean
      LANGUAGE sql
      STABLE
      AS 'SELECT false'
    `),
  );
};

const latestMigrationStatementContaining = (fragment: string): string => {
  const statements = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((dirName) => {
      const migrationSql = readFileSync(
        nodePath.join(DRIZZLE_DIR, dirName, "migration.sql"),
        "utf-8",
      );
      return migrationSql
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter((part) => part.includes(fragment));
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
  await db.execute(
    sql.raw(
      latestMigrationStatementContaining(
        `CREATE OR REPLACE VIEW public.${WORKSPACE_ACCESS_VIEW_NAME}`,
      ),
    ),
  );
  await db.execute(
    sql.raw(
      latestMigrationStatementContaining(
        `CREATE OR REPLACE FUNCTION public.${WORKSPACE_ACCESS_FUNCTION_NAME}`,
      ),
    ),
  );
  await db.execute(
    sql.raw(
      `REVOKE ALL ON TABLE public.${WORKSPACE_ACCESS_VIEW_NAME} FROM PUBLIC`,
    ),
  );
  await db.execute(
    sql.raw(
      `GRANT SELECT ON TABLE public.${WORKSPACE_ACCESS_VIEW_NAME} TO stella`,
    ),
  );
  await db.execute(
    sql.raw(
      latestMigrationStatementContaining(
        `CREATE OR REPLACE FUNCTION public.${WORKSPACE_ARRAY_ACCESS_FUNCTION_NAME}`,
      ),
    ),
  );
  await db.execute(
    sql.raw(
      `REVOKE ALL ON FUNCTION public.${WORKSPACE_ACCESS_FUNCTION_NAME}(uuid) FROM PUBLIC`,
    ),
  );
  await db.execute(
    sql.raw(
      `GRANT EXECUTE ON FUNCTION public.${WORKSPACE_ACCESS_FUNCTION_NAME}(uuid) TO stella`,
    ),
  );
  await db.execute(
    sql.raw(
      `REVOKE ALL ON FUNCTION public.${WORKSPACE_ARRAY_ACCESS_FUNCTION_NAME}(uuid[]) FROM PUBLIC`,
    ),
  );
  await db.execute(
    sql.raw(
      `GRANT EXECUTE ON FUNCTION public.${WORKSPACE_ARRAY_ACCESS_FUNCTION_NAME}(uuid[]) TO stella`,
    ),
  );
};
