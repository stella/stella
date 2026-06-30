import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { panic } from "better-result";
import { sql, type SQL } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

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
};

const arabicNormalizeFunctionSql = (): string => {
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
        .filter((part) =>
          part.includes("CREATE OR REPLACE FUNCTION arabic_normalize"),
        );
    });

  const statement = statements.at(-1);

  if (!statement) {
    panic("arabic_normalize function migration statement not found");
  }

  return statement;
};
