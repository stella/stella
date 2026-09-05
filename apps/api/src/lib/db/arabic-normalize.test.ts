import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { arabicNormalize } from "@stll/text-normalize";

import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const INITIAL_ARABIC_NORMALIZE_MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260629123000_arabic_normalize_function/migration.sql",
);
const ARABIC_NORMALIZE_MIGRATION_PATHS = [
  INITIAL_ARABIC_NORMALIZE_MIGRATION_PATH,
  nodePath.resolve(
    import.meta.dir,
    "../../../drizzle/20260630100000_arabic_normalize_combining_marks/migration.sql",
  ),
];

// The shared search-key contract: the SQL arabic_normalize() must produce
// the same match key as the TS arabicNormalize for every input. The
// presentation-form inputs also empirically confirm that Postgres
// normalize(NFKC) folds them the same way String.normalize("NFKC") does.
const VECTORS: readonly string[] = [
  "أحمد",
  "احمد",
  "إسلام",
  "آمنة",
  "خدمة",
  "يكفى",
  "مُحَمَّد",
  "مـحـمـد",
  "مؤمن",
  "مسئول",
  "ء",
  "السلام عليكم",
  "٢٠٢٤",
  "۲۰۲۴",
  "HELLO Wörld",
  "IBRAHIM İBRAHIM",
  "  a   b  ",
  "a\tb\nc",
  "a\u00a0b",
  "a\u2007b\u3000c",
  "ﷲ", // U+FDF2 ligature -> الله via NFKC
  "ﺍﺣﻤﺪ", // presentation forms -> احمد via NFKC
  "أحمد", // decomposed alef + hamza above -> احمد
  "حٔمد", // uncomposed hamza mark is removed
];

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
  for (const migrationPath of ARABIC_NORMALIZE_MIGRATION_PATHS) {
    const migrationSql = readFileSync(migrationPath, "utf-8");
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length === 0 || !isPortableFunctionStatement(trimmed)) {
        continue;
      }
      await testDb.execute(sql.raw(trimmed));
    }
  }
});

afterAll(async () => {
  await releaseTestDb();
});

describe("arabic_normalize SQL function", () => {
  test("matches arabicNormalize for every vector", async () => {
    for (const input of VECTORS) {
      const result = await testDb.execute<{ out: string | null }>(
        sql`SELECT arabic_normalize(${input}) AS out`,
      );
      expect(result.rows.at(0)?.out).toBe(arabicNormalize(input));
    }
  });
});

const isPortableFunctionStatement = (statement: string): boolean => {
  if (statement.includes("CREATE OR REPLACE FUNCTION arabic_normalize")) {
    return true;
  }
  return statement.startsWith("SET ");
};
