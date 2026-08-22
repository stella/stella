import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import {
  LEGISLATION_TITLE_SORT_KEY_CHARS,
  legislationDocuments,
} from "@/api/db/schema";

const MIGRATION = new URL(
  "../../../drizzle/20260822181000_legislation_title_cursor_compat/migration.sql",
  import.meta.url,
);
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const MAXIMUM_LEGACY_TITLE = "𐀀".repeat(1024);

test("legislation titles are removed from the full-value B-tree before widening", async () => {
  expect(Array.from(MAXIMUM_LEGACY_TITLE)).toHaveLength(1024);
  expect(legislationDocuments.title.getSQLType()).toBe("varchar(1024)");

  const client = await PGlite.create();

  try {
    await client.exec(
      'CREATE TABLE "legislation_documents" ("id" uuid PRIMARY KEY, "country" varchar(3) NOT NULL, "title" varchar(1024) NOT NULL)',
    );
    await client.exec(
      'CREATE INDEX "legislation_documents_country_title_id_idx" ON "legislation_documents" ("country", "title", "id")',
    );

    const migration = await Bun.file(MIGRATION).text();
    const pgliteMigration = migration
      .replaceAll(STATEMENT_BREAKPOINT, "")
      .replaceAll(" CONCURRENTLY", "")
      .replace(/^COMMIT;$/gmu, "")
      .replace(/^BEGIN;$/gmu, "");
    await client.exec(pgliteMigration);

    await client.query(
      'INSERT INTO "legislation_documents" ("id", "country", "title") VALUES ($1, $2, $3)',
      ["00000000-0000-4000-8000-000000000001", "CZE", MAXIMUM_LEGACY_TITLE],
    );
    const result = await client.query<{
      title: string;
      title_sort_key: string;
    }>(
      `SELECT "title", left("title", ${String(LEGISLATION_TITLE_SORT_KEY_CHARS)}) AS "title_sort_key" FROM "legislation_documents"`,
    );

    expect(result.rows.at(0)?.title).toBe(MAXIMUM_LEGACY_TITLE);
    expect(result.rows.at(0)?.title_sort_key).toBe(
      Array.from(MAXIMUM_LEGACY_TITLE)
        .slice(0, LEGISLATION_TITLE_SORT_KEY_CHARS)
        .join(""),
    );
    const indexes = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'legislation_documents' ORDER BY indexname",
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "legislation_documents_country_title_sort_id_idx",
      "legislation_documents_pkey",
    ]);
    const replacementIndex = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'legislation_documents_country_title_sort_id_idx'",
    );
    expect(replacementIndex.rows.at(0)?.indexdef).toMatch(
      new RegExp(
        `"?left"?\\(\\(?title\\)?(?:::text)?, ${String(LEGISLATION_TITLE_SORT_KEY_CHARS)}\\)`,
        "u",
      ),
    );
  } finally {
    await client.close();
  }
}, 15_000);
