import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const MIGRATION_PATH = resolve(
  import.meta.dir,
  "../../../drizzle/20260603120000_case_law_public_slugs/migration.sql",
);

let testDb: TestDatabase;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const createMigrationTable = async (tableName: string): Promise<void> => {
  await testDb.execute(
    sql.raw(`
    CREATE TABLE "${tableName}" (
      "id" uuid PRIMARY KEY,
      -- Use text here so the regression can exercise normalized
      -- preferred slugs that cross the 256-character fitter limit.
      "case_number" text NOT NULL,
      "slug" text,
      "created_at" timestamp with time zone NOT NULL
    )
  `),
  );
};

const createUnaccentShim = async (): Promise<void> => {
  await testDb.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION unaccent(value text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    AS $$ SELECT value $$
  `),
  );
};

type RunMigrationOptions = {
  tableName: string;
  indexName: string;
};

const runSlugMigration = async ({
  tableName,
  indexName,
}: RunMigrationOptions): Promise<void> => {
  const migrationSql = readFileSync(MIGRATION_PATH, "utf-8")
    .replaceAll('"case_law_decisions"', `"${tableName}"`)
    .replaceAll('"case_law_decisions_slug_uidx"', `"${indexName}"`);

  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    if (!statement.trim()) {
      continue;
    }
    await testDb.execute(sql.raw(statement));
  }
};

describe("case-law slug migration", () => {
  test("allocates duplicate suffixes against all preferred slugs", async () => {
    const suffix = Bun.randomUUIDv7().replaceAll("-", "_");
    const tableName = `case_law_decisions_slug_migration_${suffix}`;
    const indexName = `case_law_decisions_slug_uidx_${suffix}`;

    await createMigrationTable(tableName);
    await createUnaccentShim();

    try {
      await testDb.execute(
        sql.raw(`
        INSERT INTO "${tableName}" ("id", "case_number", "slug", "created_at")
        VALUES
          ('019e898b-29e7-7000-b9eb-2e7899d0f101', 'Foo', NULL, '2026-01-01T00:00:00Z'),
          ('019e898b-29e7-7000-b9eb-2e7899d0f102', 'Foo', NULL, '2026-01-02T00:00:00Z'),
          ('019e898b-29e7-7000-b9eb-2e7899d0f103', 'Other', 'foo-2', '2026-01-03T00:00:00Z')
      `),
      );

      await runSlugMigration({ tableName, indexName });

      const result = await testDb.execute<{ id: string; slug: string }>(
        sql.raw(`
        SELECT "id", "slug"
        FROM "${tableName}"
        ORDER BY "id"
      `),
      );

      expect(result.rows).toEqual([
        {
          id: "019e898b-29e7-7000-b9eb-2e7899d0f101",
          slug: "foo",
        },
        {
          id: "019e898b-29e7-7000-b9eb-2e7899d0f102",
          slug: "foo-3",
        },
        {
          id: "019e898b-29e7-7000-b9eb-2e7899d0f103",
          slug: "foo-2",
        },
      ]);
    } finally {
      await testDb.execute(sql.raw(`DROP TABLE IF EXISTS "${tableName}"`));
    }
  });

  test("trims preferred slugs after truncating to the column limit", async () => {
    const suffix = Bun.randomUUIDv7().replaceAll("-", "_");
    const tableName = `case_law_decisions_slug_migration_${suffix}`;
    const indexName = `case_law_decisions_slug_uidx_${suffix}`;
    const longCaseNumber = `${"a".repeat(255)} / tail`;

    await createMigrationTable(tableName);
    await createUnaccentShim();

    try {
      await testDb.execute(
        sql.raw(`
        INSERT INTO "${tableName}" ("id", "case_number", "slug", "created_at")
        VALUES
          ('019e898b-29e7-7000-b9eb-2e7899d0f201', '${longCaseNumber}', NULL, '2026-01-01T00:00:00Z')
      `),
      );

      await runSlugMigration({ tableName, indexName });

      const result = await testDb.execute<{ slug: string }>(
        sql.raw(`
        SELECT "slug"
        FROM "${tableName}"
      `),
      );

      expect(result.rows).toEqual([{ slug: "a".repeat(255) }]);
    } finally {
      await testDb.execute(sql.raw(`DROP TABLE IF EXISTS "${tableName}"`));
    }
  });
});
