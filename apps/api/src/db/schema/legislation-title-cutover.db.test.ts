import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { expect, test } from "bun:test";

import {
  LEGISLATION_TITLE_SORT_KEY_CHARS,
  legislationDocuments,
} from "@/api/db/schema";

const MIGRATION = new URL(
  "../../../drizzle/20260823010000_legislation_title_text_cutover/migration.sql",
  import.meta.url,
);
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const ENUMERATED_AMENDMENTS = Array.from(
  { length: 1000 },
  (_, index) => `act-${index.toString(36).padStart(4, "0")}`,
).join(", ");
const LONG_LEGISLATION_TITLE = `85/1994 Sb., kterým se mění ${ENUMERATED_AMENDMENTS}`;

const relationFileNode = async (client: PGlite, relation: string) => {
  const result = await client.query<{ relfilenode: number }>(
    "SELECT relfilenode FROM pg_class WHERE relname = $1",
    [relation],
  );
  return result.rows.at(0)?.relfilenode;
};

test("the staged cutover widens titles without rewriting the table or retaining a full-title B-tree", async () => {
  expect(LONG_LEGISLATION_TITLE.length).toBeGreaterThan(1024);
  expect(legislationDocuments.title.getSQLType()).toBe("text");

  const client = await PGlite.create({ extensions: { pg_trgm } });

  try {
    await client.exec("CREATE EXTENSION pg_trgm");
    await client.exec(
      'CREATE TABLE "legislation_documents" ("id" uuid PRIMARY KEY, "country" varchar(3) NOT NULL, "title" varchar(1024) NOT NULL)',
    );
    await client.exec(
      'CREATE INDEX "legislation_documents_country_title_id_idx" ON "legislation_documents" ("country", "title", "id")',
    );
    await client.exec(
      'CREATE INDEX "legislation_documents_title_trgm_idx" ON "legislation_documents" USING gin ("title" gin_trgm_ops)',
    );
    await client.query(
      'INSERT INTO "legislation_documents" ("id", "country", "title") VALUES ($1, $2, $3)',
      ["00000000-0000-4000-8000-000000000000", "CZE", "Short title"],
    );
    const tableFileNodeBefore = await relationFileNode(
      client,
      "legislation_documents",
    );

    const migration = await Bun.file(MIGRATION).text();
    const offsetOf = (statement: string) => {
      const offset = migration.indexOf(statement);
      expect(offset).toBeGreaterThanOrEqual(0);
      return offset;
    };
    const alterAt = offsetOf('ALTER COLUMN "title" SET DATA TYPE text');
    expect(
      offsetOf(
        'DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_country_title_id_idx"',
      ),
    ).toBeLessThan(alterAt);
    expect(
      offsetOf(
        'DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_title_trgm_idx"',
      ),
    ).toBeLessThan(alterAt);
    expect(
      offsetOf(
        'CREATE INDEX CONCURRENTLY "legislation_documents_country_title_sort_id_idx"',
      ),
    ).toBeGreaterThan(alterAt);
    expect(
      offsetOf(
        'CREATE INDEX CONCURRENTLY "legislation_documents_title_trgm_idx"',
      ),
    ).toBeGreaterThan(alterAt);
    const pgliteMigration = migration
      .replaceAll(STATEMENT_BREAKPOINT, "")
      .replaceAll(" CONCURRENTLY", "")
      .replace(/^COMMIT;$/gmu, "")
      .replace(/^BEGIN;$/gmu, "");
    await client.exec(pgliteMigration);

    expect(await relationFileNode(client, "legislation_documents")).toBe(
      tableFileNodeBefore,
    );
    await client.query(
      'INSERT INTO "legislation_documents" ("id", "country", "title") VALUES ($1, $2, $3)',
      ["00000000-0000-4000-8000-000000000001", "CZE", LONG_LEGISLATION_TITLE],
    );
    const result = await client.query<{ title: string }>(
      'SELECT "title" FROM "legislation_documents" WHERE "id" = $1',
      ["00000000-0000-4000-8000-000000000001"],
    );
    expect(result.rows.at(0)?.title).toBe(LONG_LEGISLATION_TITLE);

    const indexes = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'legislation_documents' ORDER BY indexname",
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "legislation_documents_country_title_sort_id_idx",
      "legislation_documents_pkey",
      "legislation_documents_title_trgm_idx",
    ]);
    const replacementIndex = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'legislation_documents_country_title_sort_id_idx'",
    );
    expect(replacementIndex.rows.at(0)?.indexdef).toMatch(
      new RegExp(
        `"?left"?\\(title, ${String(LEGISLATION_TITLE_SORT_KEY_CHARS)}\\)`,
        "u",
      ),
    );
  } finally {
    await client.close();
  }
}, 15_000);
