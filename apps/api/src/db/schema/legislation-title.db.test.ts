import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import {
  LEGISLATION_TITLE_SORT_KEY_CHARS,
  legislationDocuments,
} from "@/api/db/schema";
import { PAGINATION_CURSOR_MAX_CHARS } from "@/api/lib/custom-schema";
import { encodePaginationCursor } from "@/api/lib/pagination";

const MIGRATION = new URL(
  "../../../drizzle/20260822181000_legislation_title_text/migration.sql",
  import.meta.url,
);
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const ENUMERATED_AMENDMENTS = Array.from(
  { length: 1000 },
  (_, index) => `act-${index.toString(36).padStart(4, "0")}`,
).join(", ");
const LONG_LEGISLATION_TITLE = `85/1994 Sb., kterým se mění ${ENUMERATED_AMENDMENTS}`;

test("legislation titles retain the publisher's unbounded official title", async () => {
  expect(LONG_LEGISLATION_TITLE.length).toBeGreaterThan(1024);
  expect(legislationDocuments.title.getSQLType()).toBe("text");
  expect(legislationDocuments.titleSortKey.getSQLType()).toBe(
    `varchar(${LEGISLATION_TITLE_SORT_KEY_CHARS})`,
  );
  const maximumWidthCursor = encodePaginationCursor([
    "😀".repeat(LEGISLATION_TITLE_SORT_KEY_CHARS),
    "00000000-0000-4000-8000-000000000001",
  ]);
  expect(maximumWidthCursor.length).toBeLessThanOrEqual(
    PAGINATION_CURSOR_MAX_CHARS,
  );

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
      ["00000000-0000-4000-8000-000000000001", "CZE", LONG_LEGISLATION_TITLE],
    );
    const result = await client.query<{
      title: string;
      title_sort_key: string;
    }>('SELECT "title", "title_sort_key" FROM "legislation_documents"');

    expect(result.rows.at(0)?.title).toBe(LONG_LEGISLATION_TITLE);
    expect(result.rows.at(0)?.title_sort_key).toBe(
      [...LONG_LEGISLATION_TITLE]
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
  } finally {
    await client.close();
  }
}, 15_000);
