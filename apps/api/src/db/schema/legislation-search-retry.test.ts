import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { legislationSearchDocuments } from "@/api/db/schema";

const INDEX_NAME = "legislation_search_docs_retry_idx";
const MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260820130000_legislation_search_retry/migration.sql",
);

test("the legislation search retry trail matches its migration", () => {
  const config = getTableConfig(legislationSearchDocuments);
  expect(config.columns.some((column) => column.name === "retry_after")).toBe(
    true,
  );
  const index = config.indexes.find(
    (candidate) => candidate.config.name === INDEX_NAME,
  );
  expect(
    index?.config.columns.map((column) =>
      "name" in column ? column.name : undefined,
    ),
  ).toEqual(["retry_after", "document_id"]);

  const migration = readFileSync(MIGRATION, "utf-8").replaceAll(/\s+/gu, " ");
  expect(migration).toContain(
    'ADD COLUMN IF NOT EXISTS "retry_after" timestamptz;',
  );
  expect(migration).toContain(
    `CREATE INDEX CONCURRENTLY "${INDEX_NAME}" ON "legislation_search_documents" ("retry_after", "document_id") WHERE "retry_after" IS NOT NULL;`,
  );
});
