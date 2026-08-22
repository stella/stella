import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { legislationDocuments } from "@/api/db/schema";

const MIGRATION = new URL(
  "../../../drizzle/20260822181000_legislation_title_text/migration.sql",
  import.meta.url,
);
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const LONG_LEGISLATION_TITLE = `85/1994 Sb., ${"kterým se mění a doplňují související právní předpisy; ".repeat(24)}`;

test("legislation titles retain the publisher's unbounded official title", async () => {
  expect(LONG_LEGISLATION_TITLE.length).toBeGreaterThan(1024);
  expect(legislationDocuments.title.getSQLType()).toBe("text");

  const client = await PGlite.create();

  try {
    await client.exec(
      'CREATE TABLE "legislation_documents" ("title" varchar(1024) NOT NULL)',
    );

    const migration = await Bun.file(MIGRATION).text();
    await client.exec(migration.replaceAll(STATEMENT_BREAKPOINT, ""));

    await client.query(
      'INSERT INTO "legislation_documents" ("title") VALUES ($1)',
      [LONG_LEGISLATION_TITLE],
    );
    const result = await client.query<{ title: string }>(
      'SELECT "title" FROM "legislation_documents"',
    );

    expect(result.rows.at(0)?.title).toBe(LONG_LEGISLATION_TITLE);
  } finally {
    await client.close();
  }
}, 15_000);
