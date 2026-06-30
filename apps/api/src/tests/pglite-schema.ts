import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { panic } from "better-result";
import { sql, type SQL } from "drizzle-orm";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const ARABIC_NORMALIZE_MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260629123000_arabic_normalize_function/migration.sql",
);

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
};

const arabicNormalizeFunctionSql = (): string => {
  const migrationSql = readFileSync(ARABIC_NORMALIZE_MIGRATION_PATH, "utf-8");
  const statement = migrationSql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .find((part) =>
      part.includes("CREATE OR REPLACE FUNCTION arabic_normalize"),
    );

  if (!statement) {
    panic("arabic_normalize function migration statement not found");
  }

  return statement;
};
